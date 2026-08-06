import './style.css';
import './auth.ts';
import 'leaflet/dist/leaflet.css';
import * as L from 'leaflet';
import proj4 from 'proj4';
import * as htmlToImage from 'html-to-image';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';


// Register EPSG:28992 (RD New)
const RD_DEF = '+proj=sterea +lat_0=52.15616055555555 +lon_0=5.38763888888889 +k=0.9999079 +x_0=155000 +y_0=463000 +ellps=bessel +towgs84=565.417,50.33,465.552,-0.398957,0.343988,-1.8774,4.0725 +units=m +no_defs';
proj4.defs('EPSG:28992', RD_DEF);

// Load configuration from environment variables
const API_URL = (import.meta.env.VITE_API_URL as string) || 'http://127.0.0.1:8000';
const API_KEY = (import.meta.env.VITE_API_KEY as string);

// Interfaces for CPT Interpretation Data
interface SoilLayer {
  top: number;
  bottom: number;
  soil_code: string;
}

interface SoilProfile {
  soil_layers: SoilLayer[];
  c: any;
  x: number;
  y: number;
  location: string;
}

interface CptData {
  cpt_name: string;
  is_borehole?: boolean;
  soil_profile: SoilProfile;
}

// Store of uploaded CPTs in memory
const uploadedCpts: CptData[] = [];
const uploadedFilenames = new Set<string>();

// Store of uploaded CPT markers for styling updates
const cptMarkerList: { cpt: CptData; marker: L.Marker }[] = [];

// Default fallback colors for different soil types
const defaultSoilColors: Record<string, string> = {
  "preexcavated": "#6f6664",
  "organic_clay": "#32e052",
  "clay": "#034b10",
  "silty_clay": "#608233",
  "silty_sand": "#d6e119",
  "sand": "#fef341",
  "dense_sand": "#fff000",
  "peat": "#7b530b"
};

let soilColors = { ...defaultSoilColors };

let soilSynonyms: Record<string, string> = {};

// Soil volumes (m3) per soil name, returned alongside the last generated 3D voxel model
let currentVoxelVolumes: Record<string, number> = {};

// Whether the currently displayed voxel model was generated with the risk (distance_filter) payload
let isRiskModelActive = false;

// Options collected from the "Generate Voxel Model" popup
interface GenerateOptions {
  riskModel: boolean;
  deterministic: boolean;
  removePreexcavated: boolean;
  kRange: number;
  sill: number;
  nugget: number;
  knn: number;
  useDistances: boolean;
  distanceLeft: number;
  distanceRight: number;
}

const GENERATE_OPTIONS_STORAGE_KEY = 'webvoxel-generate-options';

const DEFAULT_GENERATE_OPTIONS: GenerateOptions = {
  riskModel: false,
  deterministic: false,
  removePreexcavated: true,
  kRange: 200,
  sill: 1.0,
  nugget: 0.1,
  knn: 10,
  useDistances: false,
  distanceLeft: 20,
  distanceRight: 30
};

function loadGenerateOptions(): GenerateOptions {
  try {
    const stored = localStorage.getItem(GENERATE_OPTIONS_STORAGE_KEY);
    if (stored) {
      return { ...DEFAULT_GENERATE_OPTIONS, ...JSON.parse(stored) };
    }
  } catch (e) {
    console.error('Failed to load generate options from storage:', e);
  }
  return { ...DEFAULT_GENERATE_OPTIONS };
}

function saveGenerateOptions(options: GenerateOptions) {
  try {
    localStorage.setItem(GENERATE_OPTIONS_STORAGE_KEY, JSON.stringify(options));
  } catch (e) {
    console.error('Failed to save generate options to storage:', e);
  }
}

function resolveSoilCode(code: string): string {
  let current = code;
  const visited = new Set<string>();
  while (soilSynonyms[current] && !visited.has(current)) {
    visited.add(current);
    current = soilSynonyms[current];
  }
  return current;
}

function getSoilDisplayNameForNode(code: string): string {
  const resolved = resolveSoilCode(code);
  if (resolved !== code) {
    return `${resolved.replace(/_/g, ' ')} (${code.replace(/_/g, ' ')})`;
  } else {
    const synonyms: string[] = [];
    Object.entries(soilSynonyms).forEach(([syn, _]) => {
      if (resolveSoilCode(syn) === code) {
        synonyms.push(syn.replace(/_/g, ' '));
      }
    });
    const displayName = code.replace(/_/g, ' ');
    if (synonyms.length > 0) {
      return `${displayName} (${synonyms.join(', ')})`;
    }
    return displayName;
  }
}

// Drawing State & Variables
type DrawingMode = 'view' | 'draw-rect' | 'draw-line';
let currentMode: DrawingMode = 'view';

// References to map drawing layers
let activeDrawingLayer: L.Rectangle | L.Polyline | null = null;
let polylinePoints: L.LatLng[] = [];
let polylineMarkers: L.CircleMarker[] = [];

// Rectangle dragging state
let isDrawingRectangle = false;
let rectStartLatLng: L.LatLng | null = null;

// 2D Profile Zoom/Pan State
let profileZoomScale = 1;
let profileTranslateX = 0;
let isProfileDragging = false;
let profileStartX = 0;

// Initialize the map and set its view to the Netherlands
const map = L.map('map', {
  zoomControl: false // Disable default zoom control so we can position it or keep it clean
}).setView([52.1326, 5.2913], 8);

// Add custom styled zoom control at top-right
L.control.zoom({
  position: 'topright'
}).addTo(map);

// Add OpenStreetMap tile layer
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
}).addTo(map);

// Grab the menu overlay and upload elements
const menuOverlay = document.getElementById('menu-overlay') as HTMLDivElement;
const optionUploadCpts = document.getElementById('option-upload-cpts') as HTMLLIElement;
const fileInputCpts = document.getElementById('file-input-cpts') as HTMLInputElement;
const uploadCptsBadge = document.getElementById('upload-cpts-badge') as HTMLSpanElement;
const optionUploadJsonCpts = document.getElementById('option-upload-json-cpts') as HTMLLIElement;
const fileInputJsonCpts = document.getElementById('file-input-json-cpts') as HTMLInputElement;
const uploadJsonCptsBadge = document.getElementById('upload-json-cpts-badge') as HTMLSpanElement;
const optionUploadBoreholes = document.getElementById('option-upload-boreholes') as HTMLLIElement;
const fileInputBoreholes = document.getElementById('file-input-boreholes') as HTMLInputElement;
const uploadBoreholesBadge = document.getElementById('upload-boreholes-badge') as HTMLSpanElement;
const optionSoilMaintenance = document.getElementById('option-soil-maintenance') as HTMLLIElement;
const soilMaintenanceOverlay = document.getElementById('soil-maintenance-overlay') as HTMLDivElement;
const btnCloseSoilMaintenance = document.getElementById('btn-close-soil-maintenance') as HTMLButtonElement;
const inputNewSoilName = document.getElementById('input-new-soil-name') as HTMLInputElement;
const inputNewSoilColor = document.getElementById('input-new-soil-color') as HTMLInputElement;
const btnAddSoilType = document.getElementById('btn-add-soil-type') as HTMLButtonElement;
const soilsList = document.getElementById('soils-list') as HTMLDivElement;
const optionUploadShp = document.getElementById('option-upload-shp') as HTMLLIElement;

// Grab Soil Categories elements
const optionSoilCategories = document.getElementById('option-soil-categories') as HTMLLIElement;
const soilCategoriesOverlay = document.getElementById('soil-categories-overlay') as HTMLDivElement;
const btnCloseSoilCategories = document.getElementById('btn-close-soil-categories') as HTMLButtonElement;
const categoriesSourceList = document.getElementById('categories-source-list') as HTMLDivElement;
const categoriesTargetsList = document.getElementById('categories-targets-list') as HTMLDivElement;
const fileInputShp = document.getElementById('file-input-shp') as HTMLInputElement;
const uploadShpBadge = document.getElementById('upload-shp-badge') as HTMLSpanElement;
const optionUploadCsvPolyline = document.getElementById('option-upload-csv-polyline') as HTMLLIElement;
const fileInputCsvPolyline = document.getElementById('file-input-csv-polyline') as HTMLInputElement;
const uploadCsvPolylineBadge = document.getElementById('upload-csv-polyline-badge') as HTMLSpanElement;

// Grab drawing elements
const btnDrawRect = document.getElementById('btn-draw-rect') as HTMLButtonElement;
const btnDrawLine = document.getElementById('btn-draw-line') as HTMLButtonElement;
const btnClearDraw = document.getElementById('btn-clear-draw') as HTMLButtonElement;
const drawingInstructions = document.getElementById('drawing-instructions') as HTMLDivElement;
const crosssectionToolbarDivider = document.getElementById('crosssection-toolbar-divider') as HTMLDivElement;
const btnDrawCrosssectionMap = document.getElementById('btn-draw-crosssection-map') as HTMLButtonElement;
const mapCrosssectionInstructions = document.getElementById('map-crosssection-instructions') as HTMLDivElement;
const generateContainer = document.getElementById('generate-container') as HTMLDivElement;
const btnGenerateVoxel = document.getElementById('btn-generate-voxel') as HTMLButtonElement;
const btnGenerate2d = document.getElementById('btn-generate-2d') as HTMLButtonElement;
const btnDownloadBro = document.getElementById('btn-download-bro') as HTMLButtonElement;
const btnSaveProject = document.getElementById('btn-save-project') as HTMLButtonElement;
const btnSettings = document.getElementById('btn-settings') as HTMLButtonElement;
const btnLoadProject = document.getElementById('btn-load-project') as HTMLButtonElement;
const btnNewProject = document.getElementById('btn-new-project') as HTMLButtonElement;
const fileInputProject = document.getElementById('file-input-project') as HTMLInputElement;

// Grab split viewer and loading elements
const appContainer = document.getElementById('app-container') as HTMLDivElement;
const mapContainer = document.getElementById('map-container') as HTMLDivElement;
const viewerContainer = document.getElementById('viewer-container') as HTMLDivElement;
const splitDivider = document.getElementById('split-divider') as HTMLDivElement;
const voxel3dPanel = document.getElementById('voxel-3d-panel') as HTMLDivElement;
const voxelModelViewer = document.getElementById('voxel-model-viewer') as HTMLDivElement;
const voxelViewerTooltip = document.getElementById('voxel-viewer-tooltip') as HTMLDivElement;
// const btnCloseViewer = document.getElementById('btn-close-viewer') as HTMLButtonElement;
const btnDownloadGlb = document.getElementById('btn-download-glb') as HTMLButtonElement;
const btnResetView = document.getElementById('btn-reset-view') as HTMLButtonElement;
const btnDrawCrosssection = document.getElementById('btn-draw-crosssection') as HTMLButtonElement;
const crosssectionInstructions = document.getElementById('crosssection-instructions') as HTMLDivElement;
const crosssectionViewerEl = document.getElementById('crosssection-viewer') as HTMLDivElement;
const btnCloseCrosssection = document.getElementById('btn-close-crosssection') as HTMLButtonElement;
const btnDownloadStix = document.getElementById('btn-download-stix') as HTMLButtonElement;
const viewerLayersPanel = document.getElementById('viewer-layers-panel') as HTMLDivElement;
const viewerLayersList = document.getElementById('viewer-layers-list') as HTMLDivElement;
const riskLegendKey = document.getElementById('risk-legend-key') as HTMLDivElement;
const mapOpacityControl = document.getElementById('map-opacity-control') as HTMLDivElement;
const mapOpacitySlider = document.getElementById('map-opacity-slider') as HTMLInputElement;
const mapOpacityValue = document.getElementById('map-opacity-value') as HTMLSpanElement;
const loadingOverlay = document.getElementById('loading-overlay') as HTMLDivElement;
const loaderText = document.getElementById('loader-text') as HTMLDivElement;

// 2D Profile elements
const profile2dView = document.getElementById('profile-2d-view') as HTMLDivElement;
const profileAxisY = document.getElementById('profile-axis-y') as HTMLDivElement;
const profilePlotArea = document.getElementById('profile-plot-area') as HTMLDivElement;
const profileLegend = document.getElementById('profile-legend') as HTMLDivElement;
const settingMaxDistance = document.getElementById('setting-max-distance') as HTMLInputElement;
const settingMinLayerheight = document.getElementById('setting-min-layerheight') as HTMLInputElement;
const settingDownloadBoreholes = document.getElementById('setting-download-boreholes') as HTMLInputElement;
const btnDownloadProfile = document.getElementById('btn-download-profile') as HTMLButtonElement;
const profileAxisXTicks = document.getElementById('profile-axis-x-ticks') as HTMLDivElement;

// Generate Voxel Model options modal elements
const generateOptionsOverlay = document.getElementById('generate-options-overlay') as HTMLDivElement;
const btnCloseGenerateOptions = document.getElementById('btn-close-generate-options') as HTMLButtonElement;
const btnCancelGenerateOptions = document.getElementById('btn-cancel-generate-options') as HTMLButtonElement;
const btnConfirmGenerateOptions = document.getElementById('btn-confirm-generate-options') as HTMLButtonElement;
const generateOptionRisk = document.getElementById('generate-option-risk') as HTMLInputElement;
const generateOptionDeterministic = document.getElementById('generate-option-deterministic') as HTMLInputElement;
const generateOptionRemovePreexcavated = document.getElementById('generate-option-remove-preexcavated') as HTMLInputElement;
const generateKrigingOptions = document.getElementById('generate-kriging-options') as HTMLDivElement;
const generateOptionKRange = document.getElementById('generate-option-k-range') as HTMLInputElement;
const generateOptionSill = document.getElementById('generate-option-sill') as HTMLInputElement;
const generateOptionNugget = document.getElementById('generate-option-nugget') as HTMLInputElement;
const generateOptionKnn = document.getElementById('generate-option-knn') as HTMLInputElement;
const generatePolylineOptions = document.getElementById('generate-polyline-options') as HTMLDivElement;
const generateOptionUseDistances = document.getElementById('generate-option-use-distances') as HTMLInputElement;
const generateDistanceFields = document.getElementById('generate-distance-fields') as HTMLDivElement;
const generateOptionDistanceLeft = document.getElementById('generate-option-distance-left') as HTMLInputElement;
const generateOptionDistanceRight = document.getElementById('generate-option-distance-right') as HTMLInputElement;

function updateKrigingOptionsVisibility() {
  generateKrigingOptions.style.display = generateOptionDeterministic.checked ? 'none' : '';
}

function updateDistanceOptionsVisibility() {
  generateDistanceFields.style.display = generateOptionUseDistances.checked ? '' : 'none';
}

// ==========================================
// 3D Voxel Model Viewer (Three.js)
// ==========================================

// Real-world (RD/EPSG:28992) footprint + depth bounds of the currently loaded model.
//
// The backend exports GLB vertices in one of two ways:
// - "centered" (center_and_y_up=true, the 3D/rectangle endpoint's default): vertices are
//   centered at the model's middle and swapped to Y-up: gltfX = RD_X - cx, gltfY = NAP_Z - cz,
//   gltfZ = -(RD_Y - cy).
// - "raw" (center_and_y_up=false, the 2D/polyline endpoint's default): vertices are the
//   absolute RD/NAP values with no offset or swap: gltfX = RD_X, gltfY = RD_Y, gltfZ = NAP_Z.
interface VoxelGeoBounds {
  xMin: number; xMax: number;
  yMin: number; yMax: number;
  zMin: number; zMax: number;
  raw: boolean;
}

let voxelScene: THREE.Scene;
let voxelCamera: THREE.PerspectiveCamera;
let voxelRenderer: THREE.WebGLRenderer;
let voxelControls: OrbitControls;
const voxelRaycaster = new THREE.Raycaster();

// The h5 voxel data for the currently loaded 3D (rectangle) model, needed as the input to the
// cross-section API. Only set for 3D/rectangle models - the 2D/polyline endpoint doesn't return one.
let currentVoxel3dH5Blob: Blob | null = null;

// Cross-Section line drawing state (picking 2 points on the 3D model in the viewer)
let crossSectionDrawMode = false;
let crossSectionPickedPoints: THREE.Vector3[] = [];
let crossSectionMarkerGroup: THREE.Group | null = null;
let crossSectionMapLine: L.Polyline | null = null;
let crossSectionMapMarkers: L.CircleMarker[] = [];

// Cross-Section line drawing state (picking 2 points on the map instead of the 3D viewer)
let mapCrossSectionDrawMode = false;
let mapCrossSectionPickedPoints: { x: number; y: number }[] = [];
let mapCrossSectionTempMarker: L.CircleMarker | null = null;
let previousModeBeforeMapCrossSection: DrawingMode = 'view';
let wasDrawingInstructionsActive = false;

// Secondary Three.js viewer for the generated 2D cross-section result
let csViewerInitialized = false;
let csScene: THREE.Scene;
let csCamera: THREE.PerspectiveCamera;
let csRenderer: THREE.WebGLRenderer;
let csControls: OrbitControls;
let csModelRoot: THREE.Object3D | null = null;
let csModelBox: THREE.Box3 | null = null;
let csHeightGridGroup: THREE.Group | null = null;
let currentCrossSectionModelUrl: string | null = null;

// The h5 voxel data for the currently generated cross-section, plus the RD line used to
// generate it, kept so the "download STIX" button can resend them without re-picking points.
let currentCrossSection2dH5Blob: Blob | null = null;
let currentCrossSectionLineField: string | null = null;

let voxelModelRoot: THREE.Object3D | null = null;
let voxelModelBox: THREE.Box3 | null = null;
let voxelGroundPlane: THREE.Mesh | null = null;
let voxelGeoBounds: VoxelGeoBounds | null = null;
let currentVoxelModelUrl: string | null = null;
let voxelGridHelper: THREE.GridHelper | null = null;
let voxelNorthSouthLine: THREE.Line | null = null;

function initVoxelViewer() {
  voxelScene = new THREE.Scene();
  voxelScene.background = new THREE.Color(0x0b0f19);
  voxelScene.fog = new THREE.Fog(0x0b0f19, 200, 5000);

  voxelCamera = new THREE.PerspectiveCamera(50, 1, 0.1, 50000);
  voxelCamera.position.set(50, 40, 50);

  voxelRenderer = new THREE.WebGLRenderer({ antialias: true });
  voxelRenderer.setPixelRatio(window.devicePixelRatio);
  voxelModelViewer.appendChild(voxelRenderer.domElement);

  voxelControls = new OrbitControls(voxelCamera, voxelRenderer.domElement);
  voxelControls.enableDamping = true;
  voxelControls.dampingFactor = 0.08;
  voxelControls.minDistance = 0.5;
  voxelControls.maxDistance = 20000;

  const ambient = new THREE.AmbientLight(0xffffff, 0.7);
  voxelScene.add(ambient);
  const dirLight = new THREE.DirectionalLight(0xffffff, 0.9);
  dirLight.position.set(100, 200, 100);
  voxelScene.add(dirLight);
  const fillLight = new THREE.DirectionalLight(0x8899ff, 0.3);
  fillLight.position.set(-100, 50, -100);
  voxelScene.add(fillLight);

  voxelGridHelper = new THREE.GridHelper(1000, 100, 0x6366f1, 0x2a2a4a);
  voxelScene.add(voxelGridHelper);

  const resizeObserver = new ResizeObserver(() => resizeVoxelViewer());
  resizeObserver.observe(voxelModelViewer);

  voxelRenderer.domElement.addEventListener('mousemove', onVoxelMouseMove);
  voxelRenderer.domElement.addEventListener('mouseleave', () => {
    voxelViewerTooltip.style.display = 'none';
  });
  voxelRenderer.domElement.addEventListener('click', onVoxelViewerClick);

  mapOpacitySlider.addEventListener('input', () => {
    const value = parseFloat(mapOpacitySlider.value) || 0;
    mapOpacityValue.textContent = Math.round(value * 100) + '%';
    if (voxelGroundPlane) {
      (voxelGroundPlane.material as THREE.MeshBasicMaterial).opacity = value;
    }
  });

  resizeVoxelViewer();
  animateVoxelViewer();
}

function resizeVoxelViewer() {
  const width = voxelModelViewer.clientWidth || 1;
  const height = voxelModelViewer.clientHeight || 1;
  voxelCamera.aspect = width / height;
  voxelCamera.updateProjectionMatrix();
  voxelRenderer.setSize(width, height);
}

function animateVoxelViewer() {
  requestAnimationFrame(animateVoxelViewer);
  voxelControls.update();
  voxelRenderer.render(voxelScene, voxelCamera);
}

function disposeVoxelModel() {
  exitCrossSectionDrawMode();
  exitMapCrossSectionDrawMode();
  if (voxelModelRoot) {
    voxelScene.remove(voxelModelRoot);
    voxelModelRoot.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if ((mesh as any).isMesh) {
        mesh.geometry.dispose();
        const material = mesh.material;
        if (Array.isArray(material)) material.forEach((m) => m.dispose());
        else material?.dispose();
      }
    });
    voxelModelRoot = null;
  }
  voxelModelBox = null;
  removeVoxelGroundPlane();
}

function removeVoxelGroundPlane() {
  if (voxelGroundPlane) {
    voxelScene.remove(voxelGroundPlane);
    voxelGroundPlane.geometry.dispose();
    (voxelGroundPlane.material as THREE.Material).dispose();
    voxelGroundPlane = null;
  }
}

// Load a freshly generated GLB into the viewer, replacing whatever was there before.
//
// rawOrientation is true for the 2D/polyline endpoint, which (unlike the 3D/rectangle endpoint)
// never asks the backend to center_and_y_up - so its vertices come out as absolute
// (RD_X, RD_Y, NAP_Z), with elevation on the mesh's Z axis instead of Y. Left as-is, that model
// orbits/tilts "sideways" compared to the 3D viewer, since OrbitControls treats world Y as up.
// Rotating the loaded root -90 deg about X maps (x, y, z) -> (x, z, -y), putting elevation on Y
// and flipping north/south the same way the backend's own center_and_y_up swap does, so both
// model types end up oriented (and mouse-controlled) the same way.
function loadVoxelModel(blobUrl: string, geoBounds: VoxelGeoBounds | null, rawOrientation: boolean) {
  disposeVoxelModel();
  voxelGeoBounds = geoBounds;

  const loader = new GLTFLoader();
  loader.load(blobUrl, (gltf) => {
    voxelModelRoot = gltf.scene;
    if (rawOrientation) {
      voxelModelRoot.rotation.x = -Math.PI / 2;
    }
    voxelScene.add(voxelModelRoot);
    voxelModelRoot.updateMatrixWorld(true);
    voxelModelBox = new THREE.Box3().setFromObject(voxelModelRoot);

    frameVoxelModel();
    updateVoxelGroundHelpers();
    populateVoxelLegend(voxelModelRoot);

    if (voxelGeoBounds) {
      mapOpacityControl.style.display = 'block';
      loadVoxelGroundMapTexture();
    } else {
      mapOpacityControl.style.display = 'none';
    }
  }, undefined, (error) => {
    console.error('Failed to load GLB into 3D viewer:', error);
  });
}

// Frame the camera/orbit target around the currently loaded model. Also used by the Reset button.
function frameVoxelModel() {
  if (!voxelModelRoot || !voxelModelBox) return;
  const size = voxelModelBox.getSize(new THREE.Vector3());
  const center = voxelModelBox.getCenter(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z) || 1;
  const dist = maxDim * 1.5;

  voxelCamera.near = Math.max(maxDim / 1000, 0.01);
  voxelCamera.far = Math.max(maxDim * 50, 5000);
  voxelCamera.updateProjectionMatrix();

  voxelControls.target.copy(center);
  voxelCamera.position.set(center.x + dist, center.y + dist * 0.7, center.z + dist);
  voxelControls.update();
}

// Resize/reposition the reference grid and the orange north-south line to fit the model that
// was just loaded: centered under its footprint, sitting just above its top surface. The line
// runs along local Z, which (after the axis handling in loadVoxelModel/the backend's own
// center_and_y_up swap) always points south with increasing Z - so the north end is -halfLen
// and the south end is +halfLen.
function updateVoxelGroundHelpers() {
  if (!voxelModelBox) return;
  const size = voxelModelBox.getSize(new THREE.Vector3());
  const center = voxelModelBox.getCenter(new THREE.Vector3());
  const footprint = Math.max(size.x, size.z, 10);
  const gridSize = footprint * 3;
  const divisions = Math.max(10, Math.round(gridSize / Math.max(footprint / 10, 1)));
  const liftY = footprint * 0.001 + 0.01;
  const groundY = voxelModelBox.max.y + liftY;

  if (voxelGridHelper) {
    voxelScene.remove(voxelGridHelper);
    voxelGridHelper.geometry.dispose();
    (voxelGridHelper.material as THREE.Material).dispose();
  }
  voxelGridHelper = new THREE.GridHelper(gridSize, divisions, 0x6366f1, 0x2a2a4a);
  voxelGridHelper.position.set(center.x, groundY, center.z);
  voxelScene.add(voxelGridHelper);

  if (voxelNorthSouthLine) {
    voxelScene.remove(voxelNorthSouthLine);
    voxelNorthSouthLine.geometry.dispose();
    (voxelNorthSouthLine.material as THREE.Material).dispose();
  }
  const halfLen = gridSize / 2;
  const lineGeo = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(center.x, groundY, center.z - halfLen), // north
    new THREE.Vector3(center.x, groundY, center.z + halfLen)  // south
  ]);
  voxelNorthSouthLine = new THREE.Line(lineGeo, new THREE.LineBasicMaterial({ color: 0xffaa00 }));
  voxelScene.add(voxelNorthSouthLine);
}

function resetVoxelView() {
  frameVoxelModel();
}

// The backend's "centered" GLB export (center_and_y_up=true - the 3D/rectangle endpoint's
// default) centers the model at its own middle and swaps axes: gltfX = RD_X - cx,
// gltfY = NAP_Z - cz, gltfZ = -(RD_Y - cy). cx/cy/cz are the model's real-world center, which we
// can reconstruct from the x/y/z bounds already known client-side (the backend derives its
// center the same way, from the same origin/extent).
//
// The "raw" export (center_and_y_up=false - the 2D/polyline endpoint's default) skips both the
// centering and the swap, so loadVoxelModel() applies an equivalent -90deg rotation about X when
// loading it. That rotation maps (x, y, z) -> (x, z, -y), which is exactly the centered
// transform's axis swap with cx = cy = cz = 0 (the raw export never subtracts a center). So once
// rotated, both model types share the same world-space convention and this same center (0 for
// raw) is all that's needed to invert it.
function voxelGeoCenter(bounds: VoxelGeoBounds) {
  if (bounds.raw) {
    return { cx: 0, cy: 0, cz: 0 };
  }
  return {
    cx: (bounds.xMin + bounds.xMax) / 2,
    cy: (bounds.yMin + bounds.yMax) / 2,
    cz: (bounds.zMin + bounds.zMax) / 2
  };
}

// Given a real-world RD (x, y) point, return its local mesh (x, z) position at the model's top
// surface, i.e. the plane the aerial photo drapes onto.
function rdHorizontalToLocalGround(rdX: number, rdY: number, bounds: VoxelGeoBounds) {
  const { cx, cy } = voxelGeoCenter(bounds);
  return { x: rdX - cx, z: cy - rdY };
}

// Drape the PDOK aerial photo on the model's footprint, using the real-world RD bounds that
// were already known client-side (from the drawn rectangle/polyline) before the GLB was
// even generated.
function loadVoxelGroundMapTexture() {
  if (!voxelModelRoot || !voxelModelBox || !voxelGeoBounds) return;
  const bounds = voxelGeoBounds;

  const { xMin, xMax, yMin, yMax } = bounds;
  const padW = Math.max(xMax - xMin, 10) * 0.1;
  const padH = Math.max(yMax - yMin, 10) * 0.1;
  const bx0 = xMin - padW, bx1 = xMax + padW;
  const by0 = yMin - padH, by1 = yMax + padH;
  const bw = bx1 - bx0, bh = by1 - by0;

  const maxDim = 1024;
  let imgW: number, imgH: number;
  if (bw >= bh) { imgW = maxDim; imgH = Math.max(1, Math.round(maxDim * bh / bw)); }
  else { imgH = maxDim; imgW = Math.max(1, Math.round(maxDim * bw / bh)); }

  const url = 'https://service.pdok.nl/hwh/luchtfotorgb/wms/v1_0?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap' +
    '&LAYERS=Actueel_orthoHR&STYLES=&CRS=EPSG:28992&FORMAT=image/jpeg' +
    '&BBOX=' + [bx0, by0, bx1, by1].join(',') +
    '&WIDTH=' + imgW + '&HEIGHT=' + imgH;

  const box = voxelModelBox;
  const loader = new THREE.TextureLoader();
  loader.setCrossOrigin('anonymous');
  loader.load(url, (texture) => {
    // Guard against a stale/slow response landing after a newer model was loaded.
    if (!voxelModelRoot || voxelModelBox !== box) return;

    removeVoxelGroundPlane();

    // West/east map straight to local X; south/north map to local Z inverted (gltfZ = cy - RD_Y).
    const sw = rdHorizontalToLocalGround(bx0, by0, bounds);
    const se = rdHorizontalToLocalGround(bx1, by0, bounds);
    const nw = rdHorizontalToLocalGround(bx0, by1, bounds);
    const ne = rdHorizontalToLocalGround(bx1, by1, bounds);
    const g = box.max.y;

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
      sw.x, g, sw.z, // SW
      se.x, g, se.z, // SE
      nw.x, g, nw.z, // NW
      ne.x, g, ne.z  // NE
    ]), 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), 2));
    geo.setIndex([0, 1, 2, 2, 1, 3]);
    geo.computeVertexNormals();

    const mat = new THREE.MeshBasicMaterial({
      map: texture,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: parseFloat(mapOpacitySlider.value) || 0.7
    });
    voxelGroundPlane = new THREE.Mesh(geo, mat);
    voxelGroundPlane.renderOrder = -1;
    voxelScene.add(voxelGroundPlane);
  }, undefined, (error) => {
    console.error('Failed to load aerial imagery for ground drape:', error);
  });
}

// Build the soil-type legend (checkbox + color swatch + volume) from the loaded glTF scene graph.
function populateVoxelLegend(root: THREE.Object3D) {
  viewerLayersList.innerHTML = '';

  const layers: { name: string; node: THREE.Object3D }[] = [];
  root.children.forEach((child) => {
    if (child.name && !layers.some(l => l.name === child.name)) {
      layers.push({ name: child.name, node: child });
    }
  });

  if (layers.length === 0) {
    root.traverse((child) => {
      if (child.name && (child.name in defaultSoilColors || child.name.startsWith('Soil_'))) {
        if (!layers.some(l => l.name === child.name)) {
          layers.push({ name: child.name, node: child });
        }
      }
    });
  }

  layers.sort((a, b) => a.name.localeCompare(b.name));

  riskLegendKey.style.display = isRiskModelActive ? 'flex' : 'none';

  if (layers.length === 0) {
    viewerLayersPanel.classList.remove('active');
    return;
  }

  viewerLayersPanel.classList.add('active');

  layers.forEach(({ name, node }) => {
    const resolvedCode = resolveSoilCode(name);
    const color = soilColors[resolvedCode] || '#808080';
    const displayName = getSoilDisplayNameForNode(name);

    const itemEl = document.createElement('label');
    itemEl.className = 'layer-item';
    itemEl.setAttribute('data-layer-name', name);

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = node.visible !== false;
    checkbox.addEventListener('change', () => {
      node.visible = checkbox.checked;
    });

    const colorIndicator = document.createElement('div');
    colorIndicator.className = 'layer-color-indicator';
    colorIndicator.style.display = isRiskModelActive ? 'none' : '';
    colorIndicator.style.backgroundColor = color;

    const labelText = document.createElement('span');
    labelText.className = 'layer-label';
    labelText.textContent = displayName;
    labelText.title = displayName;

    const volume = currentVoxelVolumes[name] ?? currentVoxelVolumes[resolvedCode] ?? currentVoxelVolumes[displayName];
    const volumeText = document.createElement('span');
    volumeText.className = 'layer-volume';
    if (volume !== undefined) {
      volumeText.textContent = `${volume.toFixed(0)} m³`;
      volumeText.title = `${volume.toFixed(0)} m³`;
    }

    itemEl.appendChild(checkbox);
    itemEl.appendChild(colorIndicator);
    itemEl.appendChild(labelText);
    itemEl.appendChild(volumeText);

    viewerLayersList.appendChild(itemEl);
  });
}

// Hover picking: shows the real-world RD coordinate under the cursor.
function onVoxelMouseMove(event: MouseEvent) {
  if (!voxelModelRoot || !voxelModelBox) {
    voxelViewerTooltip.style.display = 'none';
    return;
  }

  const rect = voxelRenderer.domElement.getBoundingClientRect();
  const mouse = new THREE.Vector2(
    ((event.clientX - rect.left) / rect.width) * 2 - 1,
    -((event.clientY - rect.top) / rect.height) * 2 + 1
  );
  voxelRaycaster.setFromCamera(mouse, voxelCamera);
  const intersects = voxelRaycaster.intersectObject(voxelModelRoot, true);

  if (intersects.length === 0) {
    voxelRenderer.domElement.style.cursor = 'default';
    voxelViewerTooltip.style.display = 'none';
    return;
  }

  voxelRenderer.domElement.style.cursor = 'crosshair';

  if (!voxelGeoBounds) {
    voxelViewerTooltip.style.display = 'none';
    return;
  }

  const point = intersects[0].point;
  const { cx, cy, cz } = voxelGeoCenter(voxelGeoBounds);

  // Invert the (now-shared) world-space transform: gltfX = RD_X - cx, gltfY = NAP_Z - cz,
  // gltfZ = -(RD_Y - cy). cx/cy/cz are 0 for raw exports (see voxelGeoCenter).
  const rdX = point.x + cx;
  const rdY = cy - point.z;
  const rdZ = point.y + cz;

  voxelViewerTooltip.style.display = 'block';
  voxelViewerTooltip.style.left = (event.clientX + 15) + 'px';
  voxelViewerTooltip.style.top = (event.clientY + 15) + 'px';
  voxelViewerTooltip.innerHTML = `
    <strong>RD Coordinate</strong><br>
    X: ${rdX.toFixed(1)} m<br>
    Y: ${rdY.toFixed(1)} m<br>
    Z: ${rdZ.toFixed(1)} m NAP
  `;
}

// ==========================================
// Cross-Section drawing (pick 2 points on the 3D model) + result viewer
// ==========================================

function enterCrossSectionDrawMode() {
  if (!currentVoxel3dH5Blob || !voxelModelRoot) return;
  exitMapCrossSectionDrawMode();
  crossSectionDrawMode = true;
  crossSectionPickedPoints = [];
  clearCrossSectionMarkers();
  clearCrossSectionMapLine();
  voxelControls.enabled = false;
  btnDrawCrosssection.classList.add('active');
  crosssectionInstructions.classList.add('active');
  voxelRenderer.domElement.style.cursor = 'crosshair';
}

function exitCrossSectionDrawMode() {
  crossSectionDrawMode = false;
  crossSectionPickedPoints = [];
  clearCrossSectionMarkers();
  clearCrossSectionMapLine();
  voxelControls.enabled = true;
  btnDrawCrosssection.classList.remove('active');
  crosssectionInstructions.classList.remove('active');
  voxelRenderer.domElement.style.cursor = 'default';
}

function clearCrossSectionMarkers() {
  if (!crossSectionMarkerGroup) return;
  voxelScene.remove(crossSectionMarkerGroup);
  crossSectionMarkerGroup.traverse((child) => {
    const obj = child as THREE.Mesh | THREE.Line;
    const geometry = (obj as any).geometry as THREE.BufferGeometry | undefined;
    geometry?.dispose();
    const material = (obj as any).material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(material)) material.forEach((m) => m.dispose());
    else material?.dispose();
  });
  crossSectionMarkerGroup = null;
}

// Mirror the drawn cross-section line on the Leaflet map (converted to WGS84), so its real-world
// position is visible alongside the 3D pick.
function showCrossSectionLineOnMap(rd1: { x: number; y: number }, rd2: { x: number; y: number }) {
  clearCrossSectionMapLine();

  const wgs1 = rdToWgs84(rd1.x, rd1.y);
  const wgs2 = rdToWgs84(rd2.x, rd2.y);
  const latlngs: L.LatLngExpression[] = [[wgs1.lat, wgs1.lng], [wgs2.lat, wgs2.lng]];

  crossSectionMapLine = L.polyline(latlngs, {
    color: '#ec4899',
    weight: 3,
    dashArray: '6 4'
  }).addTo(map);

  crossSectionMapMarkers = latlngs.map((latlng) =>
    L.circleMarker(latlng, {
      radius: 5,
      color: '#ec4899',
      fillColor: '#fff',
      fillOpacity: 1,
      weight: 2
    }).addTo(map)
  );
}

function clearCrossSectionMapLine() {
  if (crossSectionMapLine) {
    map.removeLayer(crossSectionMapLine);
    crossSectionMapLine = null;
  }
  crossSectionMapMarkers.forEach(m => map.removeLayer(m));
  crossSectionMapMarkers = [];
}

function addCrossSectionMarker(point: THREE.Vector3) {
  if (!crossSectionMarkerGroup) {
    crossSectionMarkerGroup = new THREE.Group();
    voxelScene.add(crossSectionMarkerGroup);
  }
  const scale = voxelModelBox ? voxelModelBox.getSize(new THREE.Vector3()).length() : 100;
  const markerRadius = Math.max(scale * 0.006, 0.15);
  const geo = new THREE.SphereGeometry(markerRadius, 16, 16);
  const mat = new THREE.MeshBasicMaterial({ color: 0xec4899, depthTest: false });
  const marker = new THREE.Mesh(geo, mat);
  marker.position.copy(point);
  marker.renderOrder = 999;
  crossSectionMarkerGroup.add(marker);
}

function drawCrossSectionLine(p1: THREE.Vector3, p2: THREE.Vector3) {
  if (!crossSectionMarkerGroup) {
    crossSectionMarkerGroup = new THREE.Group();
    voxelScene.add(crossSectionMarkerGroup);
  }
  const geo = new THREE.BufferGeometry().setFromPoints([p1, p2]);
  const mat = new THREE.LineBasicMaterial({ color: 0xec4899, depthTest: false });
  const line = new THREE.Line(geo, mat);
  line.renderOrder = 999;
  crossSectionMarkerGroup.add(line);
}

// Picking handler for the cross-section draw mode: registers up to 2 clicked points on the
// model's surface, then converts them to real-world RD (x, y) and kicks off generation.
// Standard Liang-Barsky segment/axis-aligned-rectangle clip test, used to check whether a
// drawn line actually crosses the model's footprint (endpoints are allowed to lie outside it).
function segmentIntersectsRect(
  x0: number, z0: number, x1: number, z1: number,
  xMin: number, xMax: number, zMin: number, zMax: number
): boolean {
  let t0 = 0, t1 = 1;
  const dx = x1 - x0, dz = z1 - z0;
  const checks: [number, number][] = [
    [-dx, x0 - xMin],
    [dx, xMax - x0],
    [-dz, z0 - zMin],
    [dz, zMax - z0]
  ];
  for (const [p, q] of checks) {
    if (p === 0) {
      if (q < 0) return false;
    } else {
      const r = q / p;
      if (p < 0) {
        if (r > t1) return false;
        if (r > t0) t0 = r;
      } else {
        if (r < t0) return false;
        if (r < t1) t1 = r;
      }
    }
  }
  return t0 <= t1;
}

// Shared finish step for a cross-section line, wherever its 2 endpoints were picked (in the 3D
// viewer or on the map): validate it actually crosses the model's real-world footprint, draw it
// in both the 3D viewer and the map, and request the cross-section generation. Returns whether
// the line was valid.
function finalizeCrossSectionLine(rd1: { x: number; y: number }, rd2: { x: number; y: number }): boolean {
  if (!voxelGeoBounds) return false;

  const intersectsModel = segmentIntersectsRect(
    rd1.x, rd1.y, rd2.x, rd2.y,
    voxelGeoBounds.xMin, voxelGeoBounds.xMax, voxelGeoBounds.yMin, voxelGeoBounds.yMax
  );

  if (!intersectsModel) {
    alert('The drawn line does not cross the 3D model. Please draw a line that intersects the model.');
    return false;
  }

  clearCrossSectionMarkers();
  if (voxelModelBox) {
    const elevation = voxelModelBox.max.y;
    const l1 = rdHorizontalToLocalGround(rd1.x, rd1.y, voxelGeoBounds);
    const l2 = rdHorizontalToLocalGround(rd2.x, rd2.y, voxelGeoBounds);
    const p1 = new THREE.Vector3(l1.x, elevation, l1.z);
    const p2 = new THREE.Vector3(l2.x, elevation, l2.z);
    addCrossSectionMarker(p1);
    addCrossSectionMarker(p2);
    drawCrossSectionLine(p1, p2);
  }

  showCrossSectionLineOnMap(rd1, rd2);
  generateCrossSection(rd1, rd2);
  return true;
}

function onVoxelViewerClick(event: MouseEvent) {
  if (!crossSectionDrawMode || !voxelModelRoot || !voxelModelBox || !voxelGeoBounds) return;

  const rect = voxelRenderer.domElement.getBoundingClientRect();
  const mouse = new THREE.Vector2(
    ((event.clientX - rect.left) / rect.width) * 2 - 1,
    -((event.clientY - rect.top) / rect.height) * 2 + 1
  );
  voxelRaycaster.setFromCamera(mouse, voxelCamera);

  // Intersect an infinite horizontal plane at the model's top surface rather than the model
  // mesh itself, so the user can click beyond the model's footprint to start/end the line
  // outside its limits. Whether the resulting line actually crosses the model is checked below.
  const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -voxelModelBox.max.y);
  const point = new THREE.Vector3();
  if (!voxelRaycaster.ray.intersectPlane(groundPlane, point)) return;

  crossSectionPickedPoints.push(point.clone());
  addCrossSectionMarker(point);

  if (crossSectionPickedPoints.length === 2) {
    const [p1, p2] = crossSectionPickedPoints;

    // Invert the shared world-space transform (see voxelGeoCenter/onVoxelMouseMove) to recover
    // the real-world RD (x, y) of each picked point.
    const { cx, cy } = voxelGeoCenter(voxelGeoBounds);
    const rd1 = { x: p1.x + cx, y: cy - p1.z };
    const rd2 = { x: p2.x + cx, y: cy - p2.z };

    if (!finalizeCrossSectionLine(rd1, rd2)) {
      crossSectionPickedPoints = [];
      clearCrossSectionMarkers();
      return; // stay in draw mode so the user can immediately retry
    }

    crossSectionDrawMode = false;
    voxelControls.enabled = true;
    btnDrawCrosssection.classList.remove('active');
    crosssectionInstructions.classList.remove('active');
    voxelRenderer.domElement.style.cursor = 'default';
  }
}

btnDrawCrosssection.addEventListener('click', () => {
  if (crossSectionDrawMode) {
    exitCrossSectionDrawMode();
  } else {
    enterCrossSectionDrawMode();
  }
});

// Draw a cross-section line by picking 2 points directly on the map instead of the 3D viewer.
function enterMapCrossSectionDrawMode() {
  if (!currentVoxel3dH5Blob || !voxelGeoBounds) return;
  exitCrossSectionDrawMode();
  mapCrossSectionDrawMode = true;
  mapCrossSectionPickedPoints = [];
  clearMapCrossSectionTempMarker();
  clearCrossSectionMapLine();
  clearCrossSectionMarkers();

  // Suspend the rectangle/polyline map tools while picking - otherwise a plain click here would
  // also be interpreted as a mousedown/click for whichever draw mode was previously active,
  // clearing the drawing that was used to generate this very model.
  previousModeBeforeMapCrossSection = currentMode;
  currentMode = 'view';
  wasDrawingInstructionsActive = drawingInstructions.classList.contains('active');
  drawingInstructions.classList.remove('active');

  btnDrawCrosssectionMap.classList.add('active');
  mapCrosssectionInstructions.classList.add('active');
  map.getContainer().style.cursor = 'crosshair';
}

function exitMapCrossSectionDrawMode() {
  if (!mapCrossSectionDrawMode) return;
  mapCrossSectionDrawMode = false;
  mapCrossSectionPickedPoints = [];
  clearMapCrossSectionTempMarker();

  currentMode = previousModeBeforeMapCrossSection;
  if (wasDrawingInstructionsActive) drawingInstructions.classList.add('active');

  btnDrawCrosssectionMap.classList.remove('active');
  mapCrosssectionInstructions.classList.remove('active');
  map.getContainer().style.cursor = '';
}

function clearMapCrossSectionTempMarker() {
  if (mapCrossSectionTempMarker) {
    map.removeLayer(mapCrossSectionTempMarker);
    mapCrossSectionTempMarker = null;
  }
}

btnDrawCrosssectionMap.addEventListener('click', () => {
  if (mapCrossSectionDrawMode) {
    exitMapCrossSectionDrawMode();
  } else {
    enterMapCrossSectionDrawMode();
  }
});

// Map Event Handler: click (Cross-Section point picking)
map.on('click', (e: L.LeafletMouseEvent) => {
  if (!mapCrossSectionDrawMode) return;

  const rd = wgs84ToRd(e.latlng.lat, e.latlng.lng);
  mapCrossSectionPickedPoints.push(rd);

  if (mapCrossSectionPickedPoints.length === 1) {
    clearMapCrossSectionTempMarker();
    mapCrossSectionTempMarker = L.circleMarker(e.latlng, {
      radius: 5,
      color: '#ec4899',
      fillColor: '#fff',
      fillOpacity: 1,
      weight: 2
    }).addTo(map);
    return;
  }

  const [rd1, rd2] = mapCrossSectionPickedPoints;
  exitMapCrossSectionDrawMode();
  finalizeCrossSectionLine(rd1, rd2);
});

window.addEventListener('keydown', (e: KeyboardEvent) => {
  if (e.key !== 'Escape') return;
  if (crossSectionDrawMode) exitCrossSectionDrawMode();
  if (mapCrossSectionDrawMode) exitMapCrossSectionDrawMode();
});

// Request a cross-section GLB from the h5 data of the currently loaded 3D model, using the
// real-world RD line the user drew, then display it in the split cross-section panel.
async function generateCrossSection(p1: { x: number; y: number }, p2: { x: number; y: number }) {
  if (!currentVoxel3dH5Blob) {
    alert('No 3D voxel model available to generate a cross-section from.');
    return;
  }

  loaderText.textContent = 'Generating Cross-Section...';
  loadingOverlay.classList.add('active');

  try {
    const round2 = (n: number) => Math.round(n * 100) / 100;
    // The API deserializes "line" as a list of [x, y] float pairs: [[x1,y1],[x2,y2]].
    const lineField = JSON.stringify([[round2(p1.x), round2(p1.y)], [round2(p2.x), round2(p2.y)]]);

    const form = new FormData();
    form.append('h5file', currentVoxel3dH5Blob, 'voxel_model_3d.h5');
    form.append('line', lineField);

    const response = await fetch(`${API_URL}/api/voxels/crosssection/3d`, {
      method: 'POST',
      headers: {
        'accept': 'application/json',
        'X-API-Key': API_KEY
      },
      body: form
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Server returned status ${response.status}. ${errText}`);
    }

    const responseForm = await response.formData();
    const filePart = responseForm.get('file');
    if (!filePart || !(filePart instanceof Blob)) {
      throw new Error('Cross-section response did not contain a "file" part.');
    }

    if (currentCrossSectionModelUrl) {
      URL.revokeObjectURL(currentCrossSectionModelUrl);
    }
    const modelUrl = URL.createObjectURL(filePart);
    currentCrossSectionModelUrl = modelUrl;

    // The endpoint also returns the raw h5 voxel data for this cross-section (voxel_model_2d.h5),
    // kept alongside the line used to generate it so it can be resent to the STIX endpoint later.
    const h5Part = responseForm.get('h5file');
    currentCrossSection2dH5Blob = h5Part instanceof Blob ? h5Part : null;
    currentCrossSectionLineField = lineField;
    btnDownloadStix.style.display = currentCrossSection2dH5Blob ? 'flex' : 'none';

    openCrossSectionPanel();
    loadCrossSectionModel(modelUrl, p1, p2);
  } catch (error: any) {
    console.error('Error generating cross-section:', error);
    alert(`Failed to generate cross-section: ${error.message}`);
  } finally {
    loadingOverlay.classList.remove('active');
    loaderText.textContent = 'Generating 3D Voxel Model...';
  }
}

function openCrossSectionPanel() {
  viewerContainer.classList.add('crosssection-active');
  if (!csViewerInitialized) {
    initCrossSectionViewer();
  }
  requestAnimationFrame(() => {
    resizeVoxelViewer();
    resizeCrossSectionViewer();
  });
}

function closeCrossSectionPanel() {
  viewerContainer.classList.remove('crosssection-active');
  disposeCrossSectionModel();
  if (currentCrossSectionModelUrl) {
    URL.revokeObjectURL(currentCrossSectionModelUrl);
    currentCrossSectionModelUrl = null;
  }
  currentCrossSection2dH5Blob = null;
  currentCrossSectionLineField = null;
  btnDownloadStix.style.display = 'none';
  clearCrossSectionMarkers();
  clearCrossSectionMapLine();
  requestAnimationFrame(() => resizeVoxelViewer());
}

btnCloseCrosssection.addEventListener('click', closeCrossSectionPanel);

// Send the cross-section's h5 voxel data + line back to the API to generate a D-Stability
// stix file, then download the returned zip.
btnDownloadStix.addEventListener('click', async () => {
  if (!currentCrossSection2dH5Blob || !currentCrossSectionLineField) return;

  loaderText.textContent = 'Generating STIX File...';
  loadingOverlay.classList.add('active');

  try {
    const form = new FormData();
    form.append('h5file', currentCrossSection2dH5Blob, 'voxel_model_2d.h5');
    form.append('line', currentCrossSectionLineField);

    const response = await fetch(`${API_URL}/api/voxels/crosssection/stix`, {
      method: 'POST',
      headers: {
        'accept': 'application/json',
        'X-API-Key': API_KEY
      },
      body: form
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Server returned status ${response.status}. ${errText}`);
    }

    const disposition = response.headers.get('Content-Disposition') || '';
    const filenameMatch = disposition.match(/filename="?([^"]+)"?/);
    const filename = filenameMatch ? filenameMatch[1] : 'crosssection.stix';

    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  } catch (error: any) {
    console.error('Error generating STIX file:', error);
    alert(`Failed to generate STIX file: ${error.message}`);
  } finally {
    loadingOverlay.classList.remove('active');
    loaderText.textContent = 'Generating 3D Voxel Model...';
  }
});

function initCrossSectionViewer() {
  csViewerInitialized = true;

  csScene = new THREE.Scene();
  csScene.background = new THREE.Color(0x0b0f19);
  csScene.fog = new THREE.Fog(0x0b0f19, 200, 5000);

  csCamera = new THREE.PerspectiveCamera(50, 1, 0.1, 50000);
  csCamera.position.set(50, 40, 50);

  csRenderer = new THREE.WebGLRenderer({ antialias: true });
  csRenderer.setPixelRatio(window.devicePixelRatio);
  crosssectionViewerEl.appendChild(csRenderer.domElement);

  // Pan + zoom only - no rotate, so the view stays locked face-on to the cross-section plane.
  csControls = new OrbitControls(csCamera, csRenderer.domElement);
  csControls.enableDamping = true;
  csControls.dampingFactor = 0.08;
  csControls.minDistance = 0.1;
  csControls.maxDistance = 20000;
  csControls.enableRotate = false;
  csControls.screenSpacePanning = true;
  csControls.mouseButtons = {
    LEFT: THREE.MOUSE.PAN,
    MIDDLE: THREE.MOUSE.DOLLY,
    RIGHT: THREE.MOUSE.PAN
  };
  csControls.touches = {
    ONE: THREE.TOUCH.PAN,
    TWO: THREE.TOUCH.DOLLY_PAN
  };

  const ambient = new THREE.AmbientLight(0xffffff, 0.8);
  csScene.add(ambient);
  const dirLight = new THREE.DirectionalLight(0xffffff, 0.9);
  dirLight.position.set(100, 200, 100);
  csScene.add(dirLight);
  const fillLight = new THREE.DirectionalLight(0x8899ff, 0.3);
  fillLight.position.set(-100, 50, -100);
  csScene.add(fillLight);

  const resizeObserver = new ResizeObserver(() => resizeCrossSectionViewer());
  resizeObserver.observe(crosssectionViewerEl);

  resizeCrossSectionViewer();
  animateCrossSectionViewer();
}

function resizeCrossSectionViewer() {
  if (!csRenderer) return;
  const width = crosssectionViewerEl.clientWidth || 1;
  const height = crosssectionViewerEl.clientHeight || 1;
  csCamera.aspect = width / height;
  csCamera.updateProjectionMatrix();
  csRenderer.setSize(width, height);
}

function animateCrossSectionViewer() {
  requestAnimationFrame(animateCrossSectionViewer);
  csControls.update();
  csRenderer.render(csScene, csCamera);
}

function disposeCrossSectionModel() {
  if (csModelRoot) {
    csScene.remove(csModelRoot);
    csModelRoot.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if ((mesh as any).isMesh) {
        mesh.geometry.dispose();
        const material = mesh.material;
        if (Array.isArray(material)) material.forEach((m) => m.dispose());
        else material?.dispose();
      }
    });
    csModelRoot = null;
  }
  csModelBox = null;
  disposeCrossSectionHeightGrid();
}

function disposeCrossSectionHeightGrid() {
  if (!csHeightGridGroup) return;
  csScene.remove(csHeightGridGroup);
  csHeightGridGroup.traverse((child) => {
    const line = child as THREE.Line;
    if ((line as any).isLine) {
      line.geometry.dispose();
      (line.material as THREE.Material).dispose();
    }
    const sprite = child as THREE.Sprite;
    if ((sprite as any).isSprite) {
      (sprite.material as THREE.SpriteMaterial).map?.dispose();
      sprite.material.dispose();
    }
  });
  csHeightGridGroup = null;
}

// Small canvas-texture label ("NAP -5m" etc.) sized in world units so it stays legible
// regardless of the cross-section model's real-world scale.
function createHeightLabelSprite(text: string, worldHeight: number): THREE.Sprite {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;
  const fontSize = 48;
  ctx.font = `${fontSize}px sans-serif`;
  const textWidth = ctx.measureText(text).width;
  canvas.width = Math.ceil(textWidth) + 16;
  canvas.height = fontSize + 16;

  ctx.font = `${fontSize}px sans-serif`;
  ctx.fillStyle = '#a5b4fc';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 8, canvas.height / 2);

  const texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.LinearFilter;
  const material = new THREE.SpriteMaterial({ map: texture, depthTest: false, depthWrite: false, transparent: true });
  const sprite = new THREE.Sprite(material);
  const aspect = canvas.width / canvas.height;
  sprite.scale.set(worldHeight * aspect, worldHeight, 1);
  return sprite;
}

// Draw horizontal reference lines every 5m of NAP elevation across the cross-section, labeled
// with the height. Built directly in world space (not parented to csModelRoot) since after the
// -90deg X rotation applied in loadCrossSectionModel, world Y already equals absolute NAP height
// (see the comment in frameCrossSectionModel), so the grid needs no further transform.
const HEIGHT_GRID_INTERVAL = 5;

function buildCrossSectionHeightGrid(rd1: { x: number; y: number }, rd2: { x: number; y: number }) {
  disposeCrossSectionHeightGrid();
  if (!csModelBox) return;

  const box = csModelBox;
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z) || 1;

  // Tangent direction along the drawn line, in the same post-rotation world space used in
  // frameCrossSectionModel (worldX = RD_X, worldZ = -RD_Y).
  const dx = rd2.x - rd1.x;
  const dy = rd2.y - rd1.y;
  let tx = dx;
  let tz = -dy;
  const tLen = Math.hypot(tx, tz) || 1;
  tx /= tLen;
  tz /= tLen;

  const halfLength = (Math.hypot(size.x, size.z) / 2) * 1.1 || maxDim;
  const labelHeight = maxDim * 0.035;

  const yMin = Math.floor(box.min.y / HEIGHT_GRID_INTERVAL) * HEIGHT_GRID_INTERVAL;
  const yMax = Math.ceil(box.max.y / HEIGHT_GRID_INTERVAL) * HEIGHT_GRID_INTERVAL;

  const group = new THREE.Group();
  const lineMaterial = new THREE.LineBasicMaterial({
    color: 0x4b5563,
    transparent: true,
    opacity: 0.6,
    depthTest: false,
    depthWrite: false
  });

  for (let y = yMin; y <= yMax + 1e-6; y += HEIGHT_GRID_INTERVAL) {
    const p1 = new THREE.Vector3(center.x - tx * halfLength, y, center.z - tz * halfLength);
    const p2 = new THREE.Vector3(center.x + tx * halfLength, y, center.z + tz * halfLength);
    const geometry = new THREE.BufferGeometry().setFromPoints([p1, p2]);
    const line = new THREE.Line(geometry, lineMaterial);
    line.renderOrder = 999;
    group.add(line);

    const roundedY = Math.round(y) === 0 ? 0 : Math.round(y);
    const sign = roundedY >= 0 ? '+' : '-';
    const label = createHeightLabelSprite(`NAP ${sign}${Math.abs(roundedY)}m`, labelHeight);
    label.renderOrder = 1000;
    label.position.set(
      p1.x - tx * labelHeight * 2,
      y,
      p1.z - tz * labelHeight * 2
    );
    group.add(label);
  }

  csScene.add(group);
  csHeightGridGroup = group;
}

// Load the generated cross-section GLB (built the same "raw" way as the 2D/polyline endpoint's
// output, so the same -90deg X rotation applies to put elevation on Y), then frame the camera
// to look straight at the cross-section plane (perpendicular to the drawn line).
function loadCrossSectionModel(blobUrl: string, rd1: { x: number; y: number }, rd2: { x: number; y: number }) {
  disposeCrossSectionModel();

  const loader = new GLTFLoader();
  loader.load(blobUrl, (gltf) => {
    csModelRoot = gltf.scene;
    csModelRoot.rotation.x = -Math.PI / 2;
    csScene.add(csModelRoot);
    csModelRoot.updateMatrixWorld(true);
    csModelBox = new THREE.Box3().setFromObject(csModelRoot);

    buildCrossSectionHeightGrid(rd1, rd2);
    frameCrossSectionModel(rd1, rd2);
  }, undefined, (error) => {
    console.error('Failed to load GLB into cross-section viewer:', error);
  });
}

function frameCrossSectionModel(rd1: { x: number; y: number }, rd2: { x: number; y: number }) {
  if (!csModelRoot || !csModelBox) return;
  const size = csModelBox.getSize(new THREE.Vector3());
  const center = csModelBox.getCenter(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z) || 1;
  const dist = maxDim * 1.8;

  csCamera.near = Math.max(maxDim / 1000, 0.01);
  csCamera.far = Math.max(maxDim * 50, 5000);
  csCamera.updateProjectionMatrix();

  // World-space (post -90deg X rotation) direction perpendicular to the reference line: after
  // rotation worldX = RD_X and worldZ = -RD_Y, so a line direction (dx, -dy) has horizontal
  // normal (dy, dx). Position the camera along that normal, looking straight at the model, so
  // that with rotate disabled the user only ever sees this face-on cross-section view.
  const dx = rd2.x - rd1.x;
  const dy = rd2.y - rd1.y;
  let nx = dy;
  let nz = dx;
  const nLen = Math.hypot(nx, nz) || 1;
  nx /= nLen;
  nz /= nLen;

  csControls.target.copy(center);
  csCamera.up.set(0, 1, 0);
  csCamera.position.set(center.x + nx * dist, center.y, center.z + nz * dist);
  csControls.update();
}

initVoxelViewer();

// Toggle menu overlay visibility on pressing F2
window.addEventListener('keydown', (e: KeyboardEvent) => {
  if (e.key === 'F2') {
    e.preventDefault();
    menuOverlay.classList.toggle('active');
  }
});

btnSettings.addEventListener('click', () => {
  menuOverlay.classList.toggle('active');
});

// Close menu overlay when clicking outside the menu card
menuOverlay.addEventListener('click', (e: MouseEvent) => {
  if (e.target === menuOverlay) {
    menuOverlay.classList.remove('active');
  }
});

// Convert RD coordinates (EPSG:28992) to WGS84 (lat, lng)
function rdToWgs84(x: number, y: number): { lat: number; lng: number } {
  const [lng, lat] = proj4('EPSG:28992', 'EPSG:4326', [x, y]);
  return { lat, lng };
}

// Convert WGS84 coordinates (lat, lng) to RD (x, y)
function wgs84ToRd(lat: number, lng: number): { x: number; y: number } {
  const [x, y] = proj4('EPSG:4326', 'EPSG:28992', [lng, lat]);
  return { x, y };
}

// Project a point onto a polyline to find its chainage (distance along the line)
function projectPointToPolyline(
  c: { x: number; y: number },
  polyline: { x: number; y: number }[]
): { chainage: number; distance: number } {
  let minDistance = Infinity;
  let bestChainage = 0;
  let currentLineChainage = 0;

  for (let i = 0; i < polyline.length - 1; i++) {
    const p1 = polyline[i];
    const p2 = polyline[i + 1];

    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    const segLength = Math.sqrt(dx * dx + dy * dy);

    if (segLength === 0) continue;

    // Project c onto p1 -> p2
    const t = Math.max(0, Math.min(1, ((c.x - p1.x) * dx + (c.y - p1.y) * dy) / (segLength * segLength)));
    const projX = p1.x + t * dx;
    const projY = p1.y + t * dy;

    const dist = Math.sqrt((c.x - projX) ** 2 + (c.y - projY) ** 2);
    if (dist < minDistance) {
      minDistance = dist;
      bestChainage = currentLineChainage + t * segLength;
    }

    currentLineChainage += segLength;
  }

  return { chainage: bestChainage, distance: minDistance };
}

// Fetch dynamic soil colors from backend
async function fetchSoilColors() {
  try {
    const response = await fetch(`${API_URL}/api/slim/soilcolors`, {
      method: 'POST',
      headers: {
        'accept': 'application/json',
        'X-API-Key': API_KEY
      }
    });
    if (response.ok) {
      const data = await response.json();
      soilColors = { ...defaultSoilColors, ...data };
    }
  } catch (err) {
    console.warn('Failed to fetch soil colors from API, using defaults.', err);
  }
}

// Fetch soil colors on initialization
fetchSoilColors();

// Helper to automatically register unrecognized soil codes from uploaded profiles as grey
function registerUnrecognizedSoilCodes(cpt: CptData) {
  if (cpt.soil_profile && Array.isArray(cpt.soil_profile.soil_layers)) {
    cpt.soil_profile.soil_layers.forEach(layer => {
      const code = layer.soil_code;
      if (code && !soilColors[code]) {
        soilColors[code] = '#808080';
      }
    });
  }
}

// Click listener to trigger file input
optionUploadCpts.addEventListener('click', () => {
  fileInputCpts.click();
});

// File Selection Handler
fileInputCpts.addEventListener('change', async () => {
  const files = fileInputCpts.files;
  if (!files || files.length === 0) return;

  const filesArray = Array.from(files);
  // Reset the input value so the change event triggers again for same files
  fileInputCpts.value = '';

  const originalBadgeText = uploadCptsBadge.textContent || 'Upload';
  uploadCptsBadge.textContent = 'Uploading...';
  uploadCptsBadge.classList.add('uploading-badge-active');

  for (const file of filesArray) {
    const fileName = file.name;
    const lowerName = fileName.toLowerCase();

    // Avoid duplicate uploads by checking filename
    if (uploadedFilenames.has(fileName)) {
      console.log(`Skipping duplicate upload for file: ${fileName}`);
      continue;
    }

    let minLH = 0.2;
    if (settingMinLayerheight) {
      const val = parseFloat(settingMinLayerheight.value);
      if (!isNaN(val)) {
        minLH = val;
      }
    }

    let endpointSuffix = '';
    if (lowerName.endsWith('.gef')) {
      endpointSuffix = `/api/slim/cpt_interpretation/from_gef?method=2&minimum_layerheight=${minLH}&peat_friction_ratio=6`;
    } else if (lowerName.endsWith('.xml')) {
      endpointSuffix = `/api/slim/cpt_interpretation/from_xml?method=2&minimum_layerheight=${minLH}&peat_friction_ratio=6`;
    } else {
      alert(`Unsupported file format: ${fileName}. Please upload .gef or .xml files.`);
      continue;
    }

    const formData = new FormData();
    formData.append('file', file);

    try {
      const response = await fetch(`${API_URL}${endpointSuffix}`, {
        method: 'POST',
        headers: {
          'accept': 'application/json',
          'X-API-Key': API_KEY
          // Note: Browser will automatically set Content-Type with multipart boundaries
        },
        body: formData
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Server error: ${response.status}. ${errorText}`);
      }

      const data: CptData = await response.json();
      (data as any).filename = fileName;
      registerUnrecognizedSoilCodes(data);
      uploadedCpts.push(data);
      uploadedFilenames.add(fileName);
      addCptMarker(data);
    } catch (error: any) {
      console.error(`Error uploading ${fileName}:`, error);
      alert(`Failed to upload ${fileName}: ${error.message}`);
    }
  }

  // Restore badge status
  uploadCptsBadge.textContent = originalBadgeText;
  uploadCptsBadge.classList.remove('uploading-badge-active');
});

// Click listener to trigger JSON file input
optionUploadJsonCpts.addEventListener('click', () => {
  fileInputJsonCpts.click();
});

// JSON File Selection Handler
fileInputJsonCpts.addEventListener('change', async () => {
  const files = fileInputJsonCpts.files;
  if (!files || files.length === 0) return;

  const filesArray = Array.from(files);
  fileInputJsonCpts.value = '';

  const originalBadgeText = uploadJsonCptsBadge.textContent || 'Upload';
  uploadJsonCptsBadge.textContent = 'Uploading...';
  uploadJsonCptsBadge.classList.add('uploading-badge-active');

  for (const file of filesArray) {
    const fileName = file.name;

    // Avoid duplicate uploads by checking filename
    if (uploadedFilenames.has(fileName)) {
      console.log(`Skipping duplicate upload for file: ${fileName}`);
      continue;
    }

    try {
      const text = await file.text();
      const parsedData = JSON.parse(text);

      if (!parsedData || typeof parsedData !== 'object') {
        throw new Error('Invalid JSON format: root is not an object');
      }

      const soilProfile = parsedData.soil_profile;
      if (!soilProfile || typeof soilProfile !== 'object') {
        throw new Error('Invalid JSON format: missing soil_profile object');
      }

      if (typeof soilProfile.x !== 'number' || typeof soilProfile.y !== 'number') {
        throw new Error('Invalid JSON format: soil_profile x and y coordinates must be numbers');
      }

      if (!Array.isArray(soilProfile.soil_layers)) {
        throw new Error('Invalid JSON format: soil_layers must be an array');
      }

      // Use the name in the JSON if available, falling back to the filename without extension
      const baseName = fileName.substring(0, fileName.lastIndexOf('.')) || fileName;
      const cptName = parsedData.cpt_name || baseName;

      const cptData: CptData = {
        cpt_name: cptName,
        soil_profile: {
          soil_layers: soilProfile.soil_layers.map((layer: any) => ({
            top: Number(layer.top),
            bottom: Number(layer.bottom),
            soil_code: String(layer.soil_code)
          })),
          c: soilProfile.c,
          x: Number(soilProfile.x),
          y: Number(soilProfile.y),
          location: String(soilProfile.location || '')
        }
      };

      (cptData as any).filename = fileName;
      registerUnrecognizedSoilCodes(cptData);
      uploadedCpts.push(cptData);
      uploadedFilenames.add(fileName);
      addCptMarker(cptData);
    } catch (error: any) {
      console.error(`Error uploading ${fileName}:`, error);
      alert(`Failed to parse and upload ${fileName}: ${error.message}`);
    }
  }

  // Restore badge status
  uploadJsonCptsBadge.textContent = originalBadgeText;
  uploadJsonCptsBadge.classList.remove('uploading-badge-active');
});

// Click listener to trigger borehole file input
optionUploadBoreholes.addEventListener('click', () => {
  fileInputBoreholes.click();
});

// Borehole File Selection Handler
fileInputBoreholes.addEventListener('change', async () => {
  const files = fileInputBoreholes.files;
  if (!files || files.length === 0) return;

  const filesArray = Array.from(files);
  fileInputBoreholes.value = '';

  const originalBadgeText = uploadBoreholesBadge.textContent || 'Upload';
  uploadBoreholesBadge.textContent = 'Uploading...';
  uploadBoreholesBadge.classList.add('uploading-badge-active');

  for (const file of filesArray) {
    const fileName = file.name;
    const lowerName = fileName.toLowerCase();

    // Avoid duplicate uploads by checking filename
    if (uploadedFilenames.has(fileName)) {
      console.log(`Skipping duplicate upload for file: ${fileName}`);
      continue;
    }

    if (!lowerName.endsWith('.gef')) {
      alert(`Unsupported file format: ${fileName}. Please upload .gef files.`);
      continue;
    }

    const formData = new FormData();
    formData.append('file', file);

    try {
      const response = await fetch(`${API_URL}/api/slim/borehole/from_gef`, {
        method: 'POST',
        headers: {
          'accept': 'application/json',
          'X-API-Key': API_KEY
          // Note: Browser will automatically set Content-Type with multipart boundaries
        },
        body: formData
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Server error: ${response.status}. ${errorText}`);
      }

      const boreholeData = await response.json();
      if (!boreholeData || !boreholeData.soil_profile) {
        throw new Error('Invalid borehole data: missing soil profile');
      }

      // Map Borehole structure to CptData structure
      const cptData: CptData = {
        cpt_name: boreholeData.name || fileName.substring(0, fileName.lastIndexOf('.')) || fileName,
        is_borehole: true,
        soil_profile: {
          soil_layers: (boreholeData.soil_profile.soil_layers || []).map((layer: any) => ({
            top: Number(layer.top),
            bottom: Number(layer.bottom),
            soil_code: String(layer.soil_code)
          })),
          c: boreholeData.soil_profile.c,
          x: Number(boreholeData.x !== undefined ? boreholeData.x : (boreholeData.soil_profile.x ?? 0)),
          y: Number(boreholeData.y !== undefined ? boreholeData.y : (boreholeData.soil_profile.y ?? 0)),
          location: String(boreholeData.soil_profile.location || '')
        }
      };

      (cptData as any).filename = fileName;
      registerUnrecognizedSoilCodes(cptData);
      uploadedCpts.push(cptData);
      uploadedFilenames.add(fileName);
      addCptMarker(cptData);
    } catch (error: any) {
      console.error(`Error uploading borehole ${fileName}:`, error);
      alert(`Failed to upload borehole ${fileName}: ${error.message}`);
    }
  }

  // Restore badge status
  uploadBoreholesBadge.textContent = originalBadgeText;
  uploadBoreholesBadge.classList.remove('uploading-badge-active');
});

// Click listener to trigger shapefile input
optionUploadShp.addEventListener('click', () => {
  fileInputShp.click();
});

// Click listener to trigger CSV polyline input
optionUploadCsvPolyline.addEventListener('click', () => {
  fileInputCsvPolyline.click();
});

// Helper function to parse binary ESRI Shapefile coordinates
function parseShpPolyline(arrayBuffer: ArrayBuffer): { lat: number; lng: number; alt?: number }[] {
  const view = new DataView(arrayBuffer);
  if (arrayBuffer.byteLength < 100) {
    throw new Error("Invalid shapefile (too short)");
  }

  const fileCode = view.getInt32(0, false);
  if (fileCode !== 9994) {
    throw new Error("Invalid shapefile (incorrect file code)");
  }

  // Header shape type (bytes 32-35)
  const headerShapeType = view.getInt32(32, true);
  // Supported shape types:
  // 3: PolyLine, 13: PolyLineZ, 5: Polygon, 15: PolygonZ
  if (headerShapeType !== 3 && headerShapeType !== 13 && headerShapeType !== 5 && headerShapeType !== 15) {
    throw new Error(`Unsupported shapefile type (${headerShapeType}). Only Polyline shapefiles are supported.`);
  }

  let offset = 100;
  const points: { lat: number; lng: number; alt?: number }[] = [];

  while (offset < arrayBuffer.byteLength) {
    if (offset + 8 > arrayBuffer.byteLength) break;
    const recordNumber = view.getInt32(offset, false);
    const contentLengthWords = view.getInt32(offset + 4, false);
    const contentLengthBytes = contentLengthWords * 2;
    const recordEnd = offset + 8 + contentLengthBytes;

    if (recordEnd > arrayBuffer.byteLength) {
      console.warn(`Record ${recordNumber} length exceeds file size.`);
      break;
    }

    const shapeType = view.getInt32(offset + 8, true);
    if (shapeType === 3 || shapeType === 13 || shapeType === 5 || shapeType === 15) {
      if (offset + 8 + 44 > recordEnd) {
        offset = recordEnd;
        continue;
      }
      const numParts = view.getInt32(offset + 8 + 36, true);
      const numPoints = view.getInt32(offset + 8 + 40, true);

      const partsOffset = offset + 8 + 44;
      const pointsOffset = partsOffset + numParts * 4;

      if (pointsOffset + numPoints * 16 > recordEnd) {
        console.warn(`Record ${recordNumber} points array exceeds record boundaries.`);
        offset = recordEnd;
        continue;
      }

      // PolyLineZ (13) / PolygonZ (15) store a Zmin/Zmax pair followed by a
      // Z value per point right after the X/Y points array.
      let zArrayOffset = -1;
      if (shapeType === 13 || shapeType === 15) {
        const zValuesOffset = pointsOffset + numPoints * 16 + 16;
        if (zValuesOffset + numPoints * 8 <= recordEnd) {
          zArrayOffset = zValuesOffset;
        } else {
          console.warn(`Record ${recordNumber} Z array exceeds record boundaries; ignoring Z values.`);
        }
      }

      for (let i = 0; i < numPoints; i++) {
        const ptOffset = pointsOffset + i * 16;
        const x = view.getFloat64(ptOffset, true);
        const y = view.getFloat64(ptOffset + 8, true);
        const alt = zArrayOffset >= 0 ? view.getFloat64(zArrayOffset + i * 8, true) : undefined;

        let lat: number, lng: number;
        if (x > 1000 && y > 1000) {
          const wgs = rdToWgs84(x, y);
          lat = wgs.lat;
          lng = wgs.lng;
        } else {
          lat = y;
          lng = x;
        }

        // Avoid adding consecutive duplicate points
        if (points.length === 0) {
          points.push({ lat, lng, alt });
        } else {
          const prev = points[points.length - 1];
          const distSq = Math.pow(lat - prev.lat, 2) + Math.pow(lng - prev.lng, 2);
          if (distSq > 1e-12) {
            points.push({ lat, lng, alt });
          }
        }
      }
    }

    offset = recordEnd;
  }

  // Polygon/PolygonZ rings repeat the first vertex as the last one to close
  // the ring. Drop that duplicate so the map doesn't render a closing segment
  // back to the start of what should just be a reference line.
  if ((headerShapeType === 5 || headerShapeType === 15) && points.length > 2) {
    const first = points[0];
    const last = points[points.length - 1];
    const distSq = Math.pow(last.lat - first.lat, 2) + Math.pow(last.lng - first.lng, 2);
    if (distSq <= 1e-12) {
      points.pop();
    }
  }

  return points;
}

// Shapefile Selection Handler
fileInputShp.addEventListener('change', async () => {
  const files = fileInputShp.files;
  if (!files || files.length === 0) return;

  const filesArray = Array.from(files);
  fileInputShp.value = '';

  let shpFile: File | null = null;
  let dbfFile: File | null = null;
  let shxFile: File | null = null;

  for (const file of filesArray) {
    const name = file.name.toLowerCase();
    if (name.endsWith('.shp')) shpFile = file;
    else if (name.endsWith('.dbf')) dbfFile = file;
    else if (name.endsWith('.shx')) shxFile = file;
  }

  if (!shpFile || !dbfFile || !shxFile) {
    alert("Please select and upload all three required shapefile components: .shp, .dbf, and .shx");
    return;
  }

  const getBaseName = (filename: string) => {
    const idx = filename.lastIndexOf('.');
    return idx === -1 ? filename : filename.substring(0, idx);
  };

  const shpBase = getBaseName(shpFile.name);
  const dbfBase = getBaseName(dbfFile.name);
  const shxBase = getBaseName(shxFile.name);

  if (shpBase !== dbfBase || shpBase !== shxBase) {
    alert(`The base names of the files must match (found: ${shpFile.name}, ${dbfFile.name}, ${shxFile.name})`);
    return;
  }

  const originalBadgeText = uploadShpBadge.textContent || 'Upload';
  uploadShpBadge.textContent = 'Uploading...';
  uploadShpBadge.classList.add('uploading-badge-active');

  const reader = new FileReader();

  reader.onload = (e) => {
    try {
      const buffer = e.target?.result as ArrayBuffer;
      const points = parseShpPolyline(buffer);

      if (points.length < 2) {
        alert("The uploaded shapefile does not contain enough polyline coordinates (at least 2 distinct points are required).");
        return;
      }

      clearDrawing();

      polylinePoints = points.map(p => L.latLng(p.lat, p.lng, p.alt));

      const line = L.polyline(polylinePoints, {
        color: '#a855f7',
        weight: 3
      }).addTo(map);
      activeDrawingLayer = line;

      polylineMarkers = polylinePoints.map(latlng => {
        return L.circleMarker(latlng, {
          radius: 5,
          color: '#a855f7',
          fillColor: '#fff',
          fillOpacity: 1,
          weight: 2
        }).addTo(map);
      });

      btnClearDraw.disabled = false;
      generateContainer.classList.add('active');
      btnGenerate2d.style.display = 'flex';
      btnDownloadBro.style.display = 'flex';

      const bounds = L.latLngBounds(polylinePoints);
      map.fitBounds(bounds);
    } catch (err: any) {
      console.error("Error parsing shapefile:", err);
      alert(`Failed to parse shapefile: ${err.message}`);
    } finally {
      uploadShpBadge.textContent = originalBadgeText;
      uploadShpBadge.classList.remove('uploading-badge-active');
    }
  };

  reader.onerror = () => {
    alert("Failed to read the shapefile (.shp) file.");
    uploadShpBadge.textContent = originalBadgeText;
    uploadShpBadge.classList.remove('uploading-badge-active');
  };

  reader.readAsArrayBuffer(shpFile);
});

// Helper function to parse a CSV polyline file with an x,y,z (EPSG:28992) header
function parseCsvPolyline(text: string): { lat: number; lng: number; alt?: number }[] {
  const lines = text.split(/\r\n|\r|\n/).map(l => l.trim()).filter(l => l.length > 0);
  if (lines.length < 2) {
    throw new Error("The CSV file must contain a header row and at least one data row.");
  }

  const header = lines[0].split(',').map(h => h.trim().toLowerCase());
  const xIdx = header.indexOf('x');
  const yIdx = header.indexOf('y');
  const zIdx = header.indexOf('z');

  if (xIdx === -1 || yIdx === -1) {
    throw new Error("The CSV header must contain 'x' and 'y' columns (optionally 'z').");
  }

  const points: { lat: number; lng: number; alt?: number }[] = [];

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',').map(c => c.trim());
    const x = parseFloat(cols[xIdx]);
    const y = parseFloat(cols[yIdx]);
    if (isNaN(x) || isNaN(y)) {
      continue;
    }
    const z = zIdx !== -1 ? parseFloat(cols[zIdx]) : NaN;
    const alt = isNaN(z) ? undefined : z;

    const wgs = rdToWgs84(x, y);
    const lat = wgs.lat;
    const lng = wgs.lng;

    // Avoid adding consecutive duplicate points
    if (points.length === 0) {
      points.push({ lat, lng, alt });
    } else {
      const prev = points[points.length - 1];
      const distSq = Math.pow(lat - prev.lat, 2) + Math.pow(lng - prev.lng, 2);
      if (distSq > 1e-12) {
        points.push({ lat, lng, alt });
      }
    }
  }

  // Some CSV exports (e.g. closed survey traverses) repeat the first point at
  // the end. That duplicate is what makes the rendered polyline appear to
  // close into a loop, so drop it - this file represents an open reference line.
  if (points.length > 2) {
    const first = points[0];
    const last = points[points.length - 1];
    const distSq = Math.pow(last.lat - first.lat, 2) + Math.pow(last.lng - first.lng, 2);
    if (distSq <= 1e-12) {
      points.pop();
    }
  }

  return points;
}

// CSV Polyline Selection Handler
fileInputCsvPolyline.addEventListener('change', () => {
  const files = fileInputCsvPolyline.files;
  if (!files || files.length === 0) return;

  const csvFile = files[0];
  fileInputCsvPolyline.value = '';

  const originalBadgeText = uploadCsvPolylineBadge.textContent || 'Upload';
  uploadCsvPolylineBadge.textContent = 'Uploading...';
  uploadCsvPolylineBadge.classList.add('uploading-badge-active');

  const reader = new FileReader();

  reader.onload = (e) => {
    try {
      const text = e.target?.result as string;
      const points = parseCsvPolyline(text);

      if (points.length < 2) {
        alert("The uploaded CSV file does not contain enough polyline coordinates (at least 2 distinct points are required).");
        return;
      }

      clearDrawing();

      polylinePoints = points.map(p => L.latLng(p.lat, p.lng, p.alt));

      const line = L.polyline(polylinePoints, {
        color: '#a855f7',
        weight: 3
      }).addTo(map);
      activeDrawingLayer = line;

      polylineMarkers = polylinePoints.map(latlng => {
        return L.circleMarker(latlng, {
          radius: 5,
          color: '#a855f7',
          fillColor: '#fff',
          fillOpacity: 1,
          weight: 2
        }).addTo(map);
      });

      btnClearDraw.disabled = false;
      generateContainer.classList.add('active');
      btnGenerate2d.style.display = 'flex';
      btnDownloadBro.style.display = 'flex';

      const bounds = L.latLngBounds(polylinePoints);
      map.fitBounds(bounds);
    } catch (err: any) {
      console.error("Error parsing CSV polyline:", err);
      alert(`Failed to parse CSV file: ${err.message}`);
    } finally {
      uploadCsvPolylineBadge.textContent = originalBadgeText;
      uploadCsvPolylineBadge.classList.remove('uploading-badge-active');
    }
  };

  reader.onerror = () => {
    alert("Failed to read the CSV file.");
    uploadCsvPolylineBadge.textContent = originalBadgeText;
    uploadCsvPolylineBadge.classList.remove('uploading-badge-active');
  };

  reader.readAsText(csvFile);
});

// Bind or rebuild the default view popup on a CPT/Borehole marker
function bindDefaultCptPopup(cpt: CptData, marker: L.Marker) {
  const profile = cpt.soil_profile;
  const { x, y } = profile;
  const wgs = rdToWgs84(x, y);
  const layers = profile.soil_layers || [];
  const totalThickness = layers.reduce((acc, layer) => acc + (layer.top - layer.bottom), 0);

  let segmentsHtml = '';
  const legendItemsMap: Record<string, string> = {};

  layers.forEach((layer) => {
    const thickness = layer.top - layer.bottom;
    const heightPercent = totalThickness > 0 ? (thickness / totalThickness) * 100 : 0;
    const resolvedCode = resolveSoilCode(layer.soil_code);
    const color = soilColors[resolvedCode] || '#808080';

    legendItemsMap[resolvedCode] = color;
    const displayName = resolvedCode === layer.soil_code
      ? layer.soil_code.replace(/_/g, ' ')
      : `${resolvedCode.replace(/_/g, ' ')} (${layer.soil_code.replace(/_/g, ' ')})`;

    segmentsHtml += `
      <div 
        class="soil-layer-segment" 
        style="height: ${heightPercent}%; background-color: ${color};" 
        title="${displayName}: ${layer.top.toFixed(2)}m to ${layer.bottom.toFixed(2)}m (${thickness.toFixed(2)}m)"
      ></div>
    `;
  });

  let legendHtml = '';
  Object.entries(legendItemsMap).forEach(([code, color]) => {
    const displayName = code.replace(/_/g, ' ');
    legendHtml += `
      <div class="legend-item">
        <div class="legend-color-box" style="background-color: ${color};"></div>
        <div class="legend-text" title="${displayName}">${displayName}</div>
      </div>
    `;
  });

  const isBorehole = cpt.is_borehole || cpt.cpt_name.toLowerCase().startsWith('bhr');
  const typeLabel = isBorehole ? 'Borehole' : 'CPT';

  const popupHtml = `
    <div class="cpt-popup">
      <div class="cpt-popup-header">
        <h4>${typeLabel}: ${cpt.cpt_name}</h4>
        <div style="display: flex; gap: 4px; align-items: center;">
          <button class="cpt-edit-btn" title="Edit soil profile">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width: 16px; height: 16px;">
              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
              <path d="M18.5 2.5a2.121 2.121 0 1 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
            </svg>
          </button>
          <button class="cpt-delete-btn" title="Remove CPT from project">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="3 6 5 6 21 6"></polyline>
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
            </svg>
          </button>
        </div>
      </div>
      <div class="cpt-coords">
        <div><strong>RD:</strong> X: ${x.toFixed(1)}, Y: ${y.toFixed(1)}</div>
        <div><strong>WGS84:</strong> Lat: ${wgs.lat.toFixed(5)}, Lng: ${wgs.lng.toFixed(5)}</div>
      </div>
      <div class="soil-profile-viz">
        <div class="soil-bar-container">
          ${segmentsHtml}
        </div>
        <div class="soil-legend">
          ${legendHtml}
        </div>
      </div>
    </div>
  `;

  marker.bindPopup(popupHtml, {
    maxWidth: 320
  });

  // If the popup is open, we need to bind the button event listeners immediately
  const setupButtons = (popupEl: HTMLElement) => {
    const deleteBtn = popupEl.querySelector('.cpt-delete-btn');
    if (deleteBtn) {
      deleteBtn.addEventListener('click', () => {
        if (confirm(`Are you sure you want to remove ${isBorehole ? 'Borehole' : 'CPT'} ${cpt.cpt_name} from the project?`)) {
          removeCpt(cpt, marker);
        }
      });
    }
    const editBtn = popupEl.querySelector('.cpt-edit-btn');
    if (editBtn) {
      editBtn.addEventListener('click', () => {
        openCptEditor(cpt, marker);
      });
    }
  };

  if (marker.isPopupOpen()) {
    const popupEl = marker.getPopup()?.getElement();
    if (popupEl) {
      setupButtons(popupEl);
    }
  }
}

// Render the CPT marker and custom soil profile popup
function addCptMarker(cpt: CptData) {
  const profile = cpt.soil_profile;
  const { x, y } = profile;

  if (typeof x !== 'number' || typeof y !== 'number') {
    console.error(`Invalid coordinates in soil profile for ${cpt.cpt_name}`, profile);
    return;
  }

  // Convert EPSG:28992 coordinates to WGS84
  const wgs = rdToWgs84(x, y);

  // Custom pulsing divIcon
  const customIcon = L.divIcon({
    className: 'cpt-marker-icon',
    html: `<div class="cpt-marker-pulse"></div><div class="cpt-marker-dot"></div>`,
    iconSize: [24, 24],
    iconAnchor: [12, 12]
  });

  // Place marker and bind popup
  const marker = L.marker([wgs.lat, wgs.lng], { icon: customIcon }).addTo(map);
  bindDefaultCptPopup(cpt, marker);

  // Attach event listener to delete and edit buttons when popup is opened
  marker.on('popupopen', () => {
    const popupEl = marker.getPopup()?.getElement();
    if (popupEl) {
      const isBorehole = cpt.is_borehole || cpt.cpt_name.toLowerCase().startsWith('bhr');
      const deleteBtn = popupEl.querySelector('.cpt-delete-btn');
      if (deleteBtn) {
        deleteBtn.addEventListener('click', () => {
          if (confirm(`Are you sure you want to remove ${isBorehole ? 'Borehole' : 'CPT'} ${cpt.cpt_name} from the project?`)) {
            removeCpt(cpt, marker);
          }
        });
      }
      const editBtn = popupEl.querySelector('.cpt-edit-btn');
      if (editBtn) {
        editBtn.addEventListener('click', () => {
          openCptEditor(cpt, marker);
        });
      }
    }
  });

  // Track the marker for future styling updates
  cptMarkerList.push({ cpt, marker });

  // Pan to the uploaded CPT marker
  map.setView([wgs.lat, wgs.lng], 14);
}

// Function to remove a CPT from the project
function removeCpt(cpt: CptData, marker: L.Marker) {
  // Close the popup first
  marker.closePopup();

  // Remove marker from leaflet map
  map.removeLayer(marker);

  // Remove from uploadedCpts
  const index = uploadedCpts.indexOf(cpt);
  if (index > -1) {
    uploadedCpts.splice(index, 1);
  }

  // Remove from uploadedFilenames
  const filename = (cpt as any).filename;
  if (filename) {
    uploadedFilenames.delete(filename);
  }

  // Remove from cptMarkerList
  const markerIndex = cptMarkerList.findIndex(item => item.marker === marker);
  if (markerIndex > -1) {
    cptMarkerList.splice(markerIndex, 1);
  }

  // Re-evaluate styles and generate button visibility if we have a selection rect
  updateCptMarkerStyles();
  if (activeDrawingLayer && activeDrawingLayer instanceof L.Rectangle) {
    const bounds = activeDrawingLayer.getBounds();
    const selectedCptsCount = cptMarkerList.filter(({ marker }) => bounds.contains(marker.getLatLng())).length;
    if (selectedCptsCount > 0) {
      generateContainer.classList.add('active');
    } else {
      generateContainer.classList.remove('active');
    }
  }

  // Refresh 2D Profile view if open
  if (profile2dView.style.display === 'flex') {
    render2dProfile();
  }
}

// Function to open the interactive soil profile editor in a Leaflet popup
function openCptEditor(cpt: CptData, marker: L.Marker) {
  const layersCopy = JSON.parse(JSON.stringify(cpt.soil_profile.soil_layers || []));
  layersCopy.sort((a: any, b: any) => b.top - a.top);

  const originalLayers = JSON.parse(JSON.stringify(layersCopy));
  let draftLayers = JSON.parse(JSON.stringify(layersCopy));

  if (draftLayers.length === 0) {
    alert('This CPT has no soil layers to edit.');
    return;
  }

  const absoluteTop = draftLayers[0].top;
  const absoluteBottom = draftLayers[draftLayers.length - 1].bottom;
  const totalHeight = absoluteTop - absoluteBottom;

  if (totalHeight <= 0) {
    alert('Invalid soil profile depth.');
    return;
  }

  marker.closePopup();

  const buildEditorHtml = () => {
    let segmentsHtml = '';
    let handlesHtml = '';
    let listRowsHtml = '';

    draftLayers.forEach((layer: any, idx: number) => {
      const topPct = ((absoluteTop - layer.top) / totalHeight) * 100;
      const heightPct = ((layer.top - layer.bottom) / totalHeight) * 100;
      const resolvedCode = resolveSoilCode(layer.soil_code);
      const color = soilColors[resolvedCode] || '#808080';

      segmentsHtml += `
        <div 
          class="cpt-edit-layer-segment" 
          data-layer-index="${idx}" 
          style="top: ${topPct}%; height: ${heightPct}%; background-color: ${color};"
        ></div>
      `;

      let selectOptions = '';
      Object.keys(soilColors).forEach((code) => {
        const resolved = resolveSoilCode(code);
        const displayName = resolved === code
          ? code.replace(/_/g, ' ')
          : `${resolved.replace(/_/g, ' ')} (${code.replace(/_/g, ' ')})`;
        selectOptions += `<option value="${code}" ${code === layer.soil_code ? 'selected' : ''}>${displayName}</option>`;
      });

      listRowsHtml += `
        <div class="layer-edit-row" data-row-index="${idx}">
          <div class="layer-edit-info">
            <span class="layer-edit-label">Layer ${idx + 1}</span>
            <span class="layer-edit-depths" data-depth-index="${idx}">
              ${layer.top.toFixed(2)}m to ${layer.bottom.toFixed(2)}m
            </span>
          </div>
          <select class="layer-edit-select" data-select-index="${idx}">
            ${selectOptions}
          </select>
        </div>
      `;
    });

    for (let i = 0; i < draftLayers.length - 1; i++) {
      const zBoundary = draftLayers[i].bottom;
      const yPct = ((absoluteTop - zBoundary) / totalHeight) * 100;

      handlesHtml += `
        <div 
          class="cpt-edit-handle" 
          data-handle-index="${i}" 
          style="top: ${yPct}%;"
        >
          <div class="cpt-edit-handle-line"></div>
          <div class="cpt-edit-knob"></div>
        </div>
      `;
    }

    return `
      <div class="cpt-edit-popup">
        <div class="cpt-popup-header">
          <h4>Edit Profile: ${cpt.cpt_name}</h4>
        </div>
        <div class="cpt-edit-editor-area">
          <div class="cpt-edit-viz-container">
            <div class="cpt-edit-bar-container">
              ${segmentsHtml}
            </div>
            ${handlesHtml}
          </div>
          <div class="cpt-edit-layers-list">
            ${listRowsHtml}
          </div>
        </div>
        <div class="edit-actions-row">
          <button class="btn-edit-cancel" id="btn-edit-cancel">Cancel</button>
          <button class="btn-edit-reset" id="btn-edit-reset">Reset</button>
          <button class="btn-edit-save" id="btn-edit-save">Save</button>
        </div>
      </div>
    `;
  };

  const bindEditorEvents = (popupEl: HTMLElement) => {
    const vizContainer = popupEl.querySelector('.cpt-edit-viz-container') as HTMLElement;
    const listContainer = popupEl.querySelector('.cpt-edit-layers-list') as HTMLElement;

    const handles = popupEl.querySelectorAll('.cpt-edit-handle');
    handles.forEach((handleEl) => {
      handleEl.addEventListener('mousedown', (e: Event) => {
        const mouseEvent = e as MouseEvent;
        mouseEvent.preventDefault();
        map.dragging.disable();

        const handleIdx = parseInt(handleEl.getAttribute('data-handle-index') || '0');

        const onMouseMove = (moveEvent: MouseEvent) => {
          const rect = vizContainer.getBoundingClientRect();
          const relativeY = moveEvent.clientY - rect.top;
          let newZ = absoluteTop - (relativeY / rect.height) * totalHeight;

          const minThickness = 0.05;
          const upperLimit = draftLayers[handleIdx].top - minThickness;
          const lowerLimit = draftLayers[handleIdx + 1].bottom + minThickness;

          if (newZ > upperLimit) newZ = upperLimit;
          if (newZ < lowerLimit) newZ = lowerLimit;

          draftLayers[handleIdx].bottom = newZ;
          draftLayers[handleIdx + 1].top = newZ;

          updateEditorDOM(draftLayers, vizContainer, listContainer, absoluteTop, totalHeight);
        };

        const onMouseUp = () => {
          window.removeEventListener('mousemove', onMouseMove);
          window.removeEventListener('mouseup', onMouseUp);
          map.dragging.enable();
        };

        window.addEventListener('mousemove', onMouseMove);
        window.addEventListener('mouseup', onMouseUp);
      });
    });

    const selects = popupEl.querySelectorAll('.layer-edit-select');
    selects.forEach((selectEl) => {
      selectEl.addEventListener('change', (e) => {
        const target = e.target as HTMLSelectElement;
        const idx = parseInt(target.getAttribute('data-select-index') || '0');
        const newCode = target.value;

        draftLayers[idx].soil_code = newCode;

        const segment = vizContainer.querySelector(`.cpt-edit-layer-segment[data-layer-index="${idx}"]`) as HTMLElement;
        if (segment) {
          const resolvedNew = resolveSoilCode(newCode);
          segment.style.backgroundColor = soilColors[resolvedNew] || '#808080';
        }
      });
    });

    const btnCancel = popupEl.querySelector('#btn-edit-cancel') as HTMLButtonElement;
    btnCancel.addEventListener('click', () => {
      marker.closePopup();
      rebuildCptMarkerPopups();
      marker.openPopup();
    });

    const btnReset = popupEl.querySelector('#btn-edit-reset') as HTMLButtonElement;
    btnReset.addEventListener('click', () => {
      draftLayers = JSON.parse(JSON.stringify(originalLayers));
      updateEditorDOM(draftLayers, vizContainer, listContainer, absoluteTop, totalHeight);

      const selectsToReset = popupEl.querySelectorAll('.layer-edit-select');
      selectsToReset.forEach((selectEl) => {
        const idx = parseInt(selectEl.getAttribute('data-select-index') || '0');
        const select = selectEl as HTMLSelectElement;
        select.value = draftLayers[idx].soil_code;

        const segment = vizContainer.querySelector(`.cpt-edit-layer-segment[data-layer-index="${idx}"]`) as HTMLElement;
        if (segment) {
          const resolvedReset = resolveSoilCode(draftLayers[idx].soil_code);
          segment.style.backgroundColor = soilColors[resolvedReset] || '#808080';
        }
      });
    });

    const btnSave = popupEl.querySelector('#btn-edit-save') as HTMLButtonElement;
    btnSave.addEventListener('click', () => {
      cpt.soil_profile.soil_layers = JSON.parse(JSON.stringify(draftLayers));
      rebuildCptMarkerPopups();

      if (profile2dView.style.display === 'flex') {
        render2dProfile();
      }

      marker.closePopup();
      marker.openPopup();
    });
  };

  const editorPopupHtml = buildEditorHtml();
  marker.bindPopup(editorPopupHtml, {
    maxWidth: 450,
    closeOnClick: false
  }).openPopup();

  const popupEl = marker.getPopup()?.getElement();
  if (popupEl) {
    bindEditorEvents(popupEl);
  }

  // Restore the default view popup when the editor popup closes
  const restoreDefaultPopup = () => {
    bindDefaultCptPopup(cpt, marker);
  };
  marker.once('popupclose', restoreDefaultPopup);
}

// Function to dynamically update the Soil Profile Editor visual positions and labels
function updateEditorDOM(
  draftLayers: any[],
  vizContainer: HTMLElement,
  listContainer: HTMLElement,
  absoluteTop: number,
  totalHeight: number
) {
  draftLayers.forEach((layer, idx) => {
    const topPct = ((absoluteTop - layer.top) / totalHeight) * 100;
    const heightPct = ((layer.top - layer.bottom) / totalHeight) * 100;

    const segment = vizContainer.querySelector(`.cpt-edit-layer-segment[data-layer-index="${idx}"]`) as HTMLElement;
    if (segment) {
      segment.style.top = `${topPct}%`;
      segment.style.height = `${heightPct}%`;
    }

    const textLabel = listContainer.querySelector(`.layer-edit-depths[data-depth-index="${idx}"]`) as HTMLElement;
    if (textLabel) {
      textLabel.textContent = `${layer.top.toFixed(2)}m to ${layer.bottom.toFixed(2)}m`;
    }
  });

  for (let i = 0; i < draftLayers.length - 1; i++) {
    const zBoundary = draftLayers[i].bottom;
    const yPct = ((absoluteTop - zBoundary) / totalHeight) * 100;

    const handle = vizContainer.querySelector(`.cpt-edit-handle[data-handle-index="${i}"]`) as HTMLElement;
    if (handle) {
      handle.style.top = `${yPct}%`;
    }
  }
}

// Function to update color indicators in the 3D Voxel layers legend list in real time
function updateVoxelLegendColors() {
  if (!viewerLayersList) return;
  const items = viewerLayersList.querySelectorAll('label.layer-item');
  items.forEach((item) => {
    const name = item.getAttribute('data-layer-name');
    if (name) {
      const colorIndicator = item.querySelector('.layer-color-indicator') as HTMLDivElement;
      if (colorIndicator) {
        const resolvedCode = resolveSoilCode(name);
        colorIndicator.style.backgroundColor = soilColors[resolvedCode] || '#808080';
      }
      const labelText = item.querySelector('.layer-label') as HTMLSpanElement;
      if (labelText) {
        const displayName = getSoilDisplayNameForNode(name);
        labelText.textContent = displayName;
        labelText.title = displayName;
      }
    }
  });
}

// ==========================================
// Drawing Functionality
// ==========================================

// Function to clear active map drawings
// Function to update CPT marker selection styles based on current drawing bounds
function updateCptMarkerStyles() {
  if (!activeDrawingLayer || !(activeDrawingLayer instanceof L.Rectangle)) {
    // Revert all markers to default styling (neutral/active)
    cptMarkerList.forEach(({ marker }) => {
      const el = marker.getElement();
      if (el) {
        el.classList.remove('selected', 'unselected');
      }
    });
    return;
  }

  const bounds = (activeDrawingLayer as L.Rectangle).getBounds();

  cptMarkerList.forEach(({ marker }) => {
    const latlng = marker.getLatLng();
    const isInside = bounds.contains(latlng);
    const el = marker.getElement();
    if (el) {
      if (isInside) {
        el.classList.add('selected');
        el.classList.remove('unselected');
      } else {
        el.classList.add('unselected');
        el.classList.remove('selected');
      }
    }
  });
}

// Function to clear active map drawings
function clearDrawing() {
  if (activeDrawingLayer) {
    map.removeLayer(activeDrawingLayer);
    activeDrawingLayer = null;
  }

  // Clear polyline points and markers
  polylinePoints = [];
  polylineMarkers.forEach(m => map.removeLayer(m));
  polylineMarkers = [];

  // Reset rectangle drag state
  isDrawingRectangle = false;
  rectStartLatLng = null;

  // Update clear button and generate container
  btnClearDraw.disabled = true;
  generateContainer.classList.remove('active');
  btnGenerate2d.style.display = 'none';
  btnDownloadBro.style.display = 'none';

  // Reset all marker styles
  updateCptMarkerStyles();
}

// Function to transition drawing modes
function setDrawingMode(mode: DrawingMode) {
  currentMode = mode;

  // Toggle button active states
  btnDrawRect.classList.toggle('active', mode === 'draw-rect');
  btnDrawLine.classList.toggle('active', mode === 'draw-line');

  // There can only be one object at a time: clear on transition
  clearDrawing();

  // Show appropriate instructions
  if (mode === 'draw-rect') {
    drawingInstructions.textContent = 'Rectangle Mode: Click and drag on the map to draw a rectangle.';
    drawingInstructions.classList.add('active');
    map.doubleClickZoom.disable();
  } else if (mode === 'draw-line') {
    drawingInstructions.textContent = 'Polyline Mode: Left-click to add points. Right-click to remove the last point.';
    drawingInstructions.classList.add('active');
    map.doubleClickZoom.disable();
  } else {
    drawingInstructions.classList.remove('active');
    map.doubleClickZoom.enable();
  }
}

// Tool button click handlers
btnDrawRect.addEventListener('click', () => {
  if (currentMode === 'draw-rect') {
    setDrawingMode('view');
  } else {
    setDrawingMode('draw-rect');
  }
});

btnDrawLine.addEventListener('click', () => {
  if (currentMode === 'draw-line') {
    setDrawingMode('view');
  } else {
    setDrawingMode('draw-line');
  }
});

btnClearDraw.addEventListener('click', () => {
  clearDrawing();
  setDrawingMode('view');
});

async function generateVoxelModel(options: GenerateOptions) {
  const riskMode = options.riskModel;
  if (uploadedCpts.length === 0) {
    alert('Please upload some CPT files first.');
    return;
  }

  const isRectangle = activeDrawingLayer instanceof L.Rectangle;
  const isPolyline = activeDrawingLayer instanceof L.Polyline && !isRectangle;

  if (!activeDrawingLayer || (!isRectangle && !isPolyline)) {
    alert('Please draw a rectangle or a line on the map to define the generation area.');
    return;
  }

  // Switch display back to 3D model viewer mode
  profile2dView.style.display = 'none';
  voxel3dPanel.style.display = 'block';
  voxelModelViewer.style.display = 'block';
  btnResetView.style.display = 'block';
  btnDownloadGlb.style.display = 'block';
  btnDrawCrosssection.style.display = 'none';
  btnDrawCrosssectionMap.style.display = 'none';
  crosssectionToolbarDivider.style.display = 'none';
  exitCrossSectionDrawMode();
  exitMapCrossSectionDrawMode();
  closeCrossSectionPanel();

  // Show the loader overlay
  loadingOverlay.classList.add('active');

  // Real-world footprint/depth bounds for the generated model, set below once the rectangle
  // or polyline geometry is known.
  let lastGeoBounds: VoxelGeoBounds | null = null;

  try {
    let response: Response;

    if (isRectangle) {
      // 1. Get the boundaries of the selected rectangle
      const rectangle = activeDrawingLayer as L.Rectangle;
      const bounds = rectangle.getBounds();
      const southWest = bounds.getSouthWest();
      const northEast = bounds.getNorthEast();

      // Convert geographic coordinates to RD (EPSG:28992)
      const rdSW = wgs84ToRd(southWest.lat, southWest.lng);
      const rdNE = wgs84ToRd(northEast.lat, northEast.lng);

      let xMin = Math.min(rdSW.x, rdNE.x);
      let xMax = Math.max(rdSW.x, rdNE.x);
      let yMin = Math.min(rdSW.y, rdNE.y);
      let yMax = Math.max(rdSW.y, rdNE.y);

      // 2. Check if the original selection contains at least one CPT (using geographic bounds for maximum robustness)
      const cptsInsideOriginal = uploadedCpts.filter((cpt) => {
        const wgs = rdToWgs84(cpt.soil_profile.x, cpt.soil_profile.y);
        return bounds.contains([wgs.lat, wgs.lng]);
      });

      if (cptsInsideOriginal.length === 0) {
        throw new Error('The selected area does not contain any uploaded CPTs. Please draw a rectangle enclosing at least one CPT marker.');
      }

      // 3. If model is smaller than 5x5, use 5x5 (since we know it contains at least one CPT)
      const width = xMax - xMin;
      if (width < 5) {
        const xCenter = (xMin + xMax) / 2;
        xMin = xCenter - 2.5;
        xMax = xCenter + 2.5;
      }

      const length = yMax - yMin;
      if (length < 5) {
        const yCenter = (yMin + yMax) / 2;
        yMin = yCenter - 2.5;
        yMax = yCenter + 2.5;
      }

      // Recalculate enclosed CPTs within the expanded bounds to include all relevant profiles
      let cptsInside = uploadedCpts.filter((cpt) => {
        const px = cpt.soil_profile.x;
        const py = cpt.soil_profile.y;
        return px >= xMin && px <= xMax && py >= yMin && py <= yMax;
      });

      // Fallback to originally selected CPTs if any edge case/precision issue occurs
      if (cptsInside.length === 0) {
        cptsInside = cptsInsideOriginal;
      }

      // 4. Calculate Z boundaries from CPTs inside the rectangle
      let zMin = Infinity;
      let zMax = -Infinity;
      cptsInside.forEach((cpt) => {
        (cpt.soil_profile.soil_layers || []).forEach((layer) => {
          if (layer.bottom < zMin) zMin = layer.bottom;
          if (layer.top > zMax) zMax = layer.top;
        });
      });

      if (zMin === Infinity || zMax === -Infinity) {
        throw new Error('Could not compute Z boundaries from CPTs in the area.');
      }

      lastGeoBounds = { xMin, xMax, yMin, yMax, zMin, zMax, raw: false };

      // // 5. Centering coordinates around 0,0,0
      // const xCenter = (xMin + xMax) / 2;
      // const yCenter = (yMin + yMax) / 2;
      // const zCenter = (minZ + maxZ) / 2;

      // // Apply translations and rounding (no offsets added)
      // const x_min = Math.round(xMin - xCenter);
      // const x_max = Math.round(xMax - xCenter);
      // const y_min = Math.round(yMin - yCenter);
      // const y_max = Math.round(yMax - yCenter);
      // const z_min = Math.round(minZ - zCenter);
      // const z_max = Math.round(maxZ - zCenter);

      // Center each CPT's coordinates and its soil layers:
      const soilProfilesPayload = cptsInside.map((cpt) => {
        const prof = cpt.soil_profile;
        return {
          x: prof.x,
          y: prof.y,
          soil_layers: (prof.soil_layers || []).map((layer) => ({
            top: layer.top,
            bottom: layer.bottom,
            soil_code: resolveSoilCode(layer.soil_code)
          }))
        };
      });

      const filteredSoilColors: Record<string, string> = {};
      Object.entries(soilColors).forEach(([key, color]) => {
        if (!soilSynonyms[key]) {
          filteredSoilColors[key] = color;
        }
      });

      // 6. Construct the API payload
      const payload = {
        soil_profiles: soilProfilesPayload,
        x_min: xMin,
        x_max: xMax,
        dx: 5,
        y_min: yMin,
        y_max: yMax,
        dy: 5,
        z_min: zMin,
        z_max: zMax,
        dz: 1.0,
        soil_colors: filteredSoilColors,
        deterministic: options.deterministic,
        remove_preexcavated: options.removePreexcavated,
        ...(options.deterministic ? {} : {
          k_range: options.kRange,
          sill: options.sill,
          nugget: options.nugget,
          knn_num_neighbors: options.knn
        }),
        ...(riskMode ? { distance_filter: [20, 50] } : {})
      };

      console.log('Sending 3D GLB export request payload:', payload);

      // 7. API Request
      response = await fetch(`${API_URL}/api/voxels/export/glb/3d`, {
        method: 'POST',
        headers: {
          'accept': 'application/json',
          'X-API-Key': API_KEY,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });
    } else {
      // Polyline (2D) generation
      // Convert points to RD coordinates, carrying over the Z value (if any)
      const rdPoints = polylinePoints.map(pt => ({ ...wgs84ToRd(pt.lat, pt.lng), alt: pt.alt }));

      // Find Z boundaries from all uploaded CPTs
      let minZ = Infinity;
      let maxZ = -Infinity;
      uploadedCpts.forEach((cpt) => {
        (cpt.soil_profile.soil_layers || []).forEach((layer) => {
          if (layer.bottom < minZ) minZ = layer.bottom;
          if (layer.top > maxZ) maxZ = layer.top;
        });
      });

      if (minZ === Infinity || maxZ === -Infinity) {
        throw new Error('Could not compute Z boundaries from CPTs.');
      }

      // The profile follows the actual polyline through RD space, so it has a real footprint.
      // When distance-filtering is on, the /3d endpoint is used instead (see below), which -
      // like the rectangle case - centers and Y-up-swaps its vertices, so the bounds must be
      // flagged non-raw and padded to approximate the buffered footprint the backend generates.
      const lineXs = rdPoints.map(p => p.x);
      const lineYs = rdPoints.map(p => p.y);
      const boundsPad = options.useDistances ? Math.max(options.distanceLeft, options.distanceRight) : 0;
      lastGeoBounds = {
        xMin: Math.min(...lineXs) - boundsPad, xMax: Math.max(...lineXs) + boundsPad,
        yMin: Math.min(...lineYs) - boundsPad, yMax: Math.max(...lineYs) + boundsPad,
        zMin: minZ, zMax: maxZ,
        raw: !options.useDistances
      };

      // Project each CPT onto the reference line (original, to match coordinates)
      const soilProfilesPayload = uploadedCpts.map((cpt) => {
        const prof = cpt.soil_profile;
        return {
          x: prof.x,
          y: prof.y,
          soil_layers: (prof.soil_layers || []).map((layer) => ({
            top: layer.top,
            bottom: layer.bottom,
            soil_code: resolveSoilCode(layer.soil_code)
          }))
        };
      });

      const filteredSoilColors: Record<string, string> = {};
      Object.entries(soilColors).forEach(([key, color]) => {
        if (!soilSynonyms[key]) {
          filteredSoilColors[key] = color;
        }
      });

      //console.log('Reference line:', rdPoints);

      if (options.useDistances) {
        // Construct a 3D-style payload (like the rectangle/3D case) but without an
        // x/y bounding box - the reference line + left/right distance define the footprint.
        const payload = {
          soil_profiles: soilProfilesPayload,
          dx: 5,
          dy: 5,
          z_min: minZ,
          z_max: maxZ,
          dz: 1.0,
          referenceline: rdPoints.map(p => p.alt !== undefined ? [p.x, p.y, p.alt] : [p.x, p.y]),
          soil_colors: filteredSoilColors,
          deterministic: options.deterministic,
          remove_preexcavated: options.removePreexcavated,
          max_referenceline_distance: [options.distanceLeft, options.distanceRight],
          ...(options.deterministic ? {} : {
            k_range: options.kRange,
            sill: options.sill,
            nugget: options.nugget,
            knn_num_neighbors: options.knn
          }),
          ...(riskMode ? { distance_filter: [20, 50] } : {})
        };

        console.log('Sending 2D (distance-filtered 3D) GLB export request payload:', payload);

        // API Request
        response = await fetch(`${API_URL}/api/voxels/export/glb/3d`, {
          method: 'POST',
          headers: {
            'accept': 'application/json',
            'X-API-Key': API_KEY,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(payload)
        });
      } else {
        // Construct the 2D API payload
        const payload = {
          soil_profiles: soilProfilesPayload,
          dx: 1.0,
          dz: 0.25,
          referenceline: rdPoints.map(p => p.alt !== undefined ? [p.x, p.y, p.alt] : [p.x, p.y]),
          soil_colors: filteredSoilColors,
          deterministic: options.deterministic,
          remove_preexcavated: options.removePreexcavated,
          ...(options.deterministic ? {} : {
            k_range: options.kRange,
            sill: options.sill,
            nugget: options.nugget,
            knn_num_neighbors: options.knn
          }),
          ...(riskMode ? { distance_filter: [20, 50] } : {})
        };

        console.log('Sending 2D GLB export request payload:', payload);

        // // write to debug file
        // const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
        // const url = URL.createObjectURL(blob);
        // const a = document.createElement('a');
        // a.href = url;
        // a.download = 'debug_2d.json';
        // a.click();

        // API Request
        response = await fetch(`${API_URL}/api/voxels/export/glb/2d`, {
          method: 'POST',
          headers: {
            'accept': 'application/json',
            'X-API-Key': API_KEY,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(payload)
        });
      }
    }

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Server returned status ${response.status}. ${errText}`);
    }

    // Response is multipart/form-data with a "file" part (the GLB) and a
    // "volumes" part (JSON mapping soil name to volume in m3).
    const responseForm = await response.formData();

    const filePart = responseForm.get('file');
    if (!filePart || !(filePart instanceof Blob)) {
      throw new Error('Response did not contain a "file" part.');
    }

    const volumesPart = responseForm.get('volumes');
    let volumesData: Record<string, number> = {};
    if (volumesPart) {
      const volumesText = volumesPart instanceof Blob ? await volumesPart.text() : volumesPart;
      try {
        volumesData = JSON.parse(volumesText);
      } catch (e) {
        console.error('Failed to parse volumes JSON from response:', e);
      }
    }
    currentVoxelVolumes = volumesData;
    isRiskModelActive = riskMode;

    // The /3d endpoint also returns an "h5file" part - the raw voxel data needed as input to the
    // cross-section endpoint. That's hit both by the rectangle case and by the distance-filtered
    // polyline case (which reuses the /3d endpoint); the plain /2d polyline endpoint returns none.
    const usedGlb3dEndpoint = isRectangle || (isPolyline && options.useDistances);
    const h5Part = responseForm.get('h5file');
    currentVoxel3dH5Blob = (usedGlb3dEndpoint && h5Part instanceof Blob) ? h5Part : null;
    btnDrawCrosssection.style.display = currentVoxel3dH5Blob ? 'block' : 'none';
    btnDrawCrosssectionMap.style.display = currentVoxel3dH5Blob ? 'block' : 'none';
    crosssectionToolbarDivider.style.display = currentVoxel3dH5Blob ? 'block' : 'none';

    // Revoke previous URL if any to prevent memory leak
    if (currentVoxelModelUrl) {
      URL.revokeObjectURL(currentVoxelModelUrl);
    }

    const modelUrl = URL.createObjectURL(filePart);
    currentVoxelModelUrl = modelUrl;

    // Load into the 3D viewer (drapes the aerial photo automatically for rectangle/3D models).
    // Orientation follows the bounds' own raw flag, since that's exactly what tracks whether the
    // backend centered/Y-up-swapped the GLB (rectangle, and now distance-filtered polyline calls)
    // or returned raw absolute coordinates (plain polyline calls).
    loadVoxelModel(modelUrl, lastGeoBounds, lastGeoBounds ? lastGeoBounds.raw : !isRectangle);

    // Open split view
    appContainer.classList.add('split-active');

    // Reset map layout bounds
    setTimeout(() => {
      map.invalidateSize();
    }, 500);

  } catch (error: any) {
    console.error('Error generating voxel model:', error);
    alert(`Failed to generate 3D voxel model: ${error.message}`);
  } finally {
    // Hide loading overlay
    loadingOverlay.classList.remove('active');
  }
}

// Open the Generate Voxel Model options popup, pre-filled with the last remembered choices
btnGenerateVoxel.addEventListener('click', () => {
  if (uploadedCpts.length === 0) {
    alert('Please upload some CPT files first.');
    return;
  }

  const isRectangle = activeDrawingLayer instanceof L.Rectangle;
  const isPolyline = activeDrawingLayer instanceof L.Polyline && !isRectangle;

  if (!activeDrawingLayer || (!isRectangle && !isPolyline)) {
    alert('Please draw a rectangle or a line on the map to define the generation area.');
    return;
  }

  const options = loadGenerateOptions();
  generateOptionRisk.checked = options.riskModel;
  generateOptionDeterministic.checked = options.deterministic;
  generateOptionRemovePreexcavated.checked = options.removePreexcavated;
  generateOptionKRange.value = String(options.kRange);
  generateOptionSill.value = String(options.sill);
  generateOptionNugget.value = String(options.nugget);
  generateOptionKnn.value = String(options.knn);
  generateOptionUseDistances.checked = options.useDistances;
  generateOptionDistanceLeft.value = String(options.distanceLeft);
  generateOptionDistanceRight.value = String(options.distanceRight);
  updateKrigingOptionsVisibility();
  updateDistanceOptionsVisibility();
  generatePolylineOptions.style.display = isPolyline ? '' : 'none';

  generateOptionsOverlay.classList.add('active');
});

generateOptionDeterministic.addEventListener('change', updateKrigingOptionsVisibility);
generateOptionUseDistances.addEventListener('change', updateDistanceOptionsVisibility);

btnConfirmGenerateOptions.addEventListener('click', () => {
  const options: GenerateOptions = {
    riskModel: generateOptionRisk.checked,
    deterministic: generateOptionDeterministic.checked,
    removePreexcavated: generateOptionRemovePreexcavated.checked,
    kRange: parseFloat(generateOptionKRange.value) || DEFAULT_GENERATE_OPTIONS.kRange,
    sill: parseFloat(generateOptionSill.value) || DEFAULT_GENERATE_OPTIONS.sill,
    nugget: parseFloat(generateOptionNugget.value) || DEFAULT_GENERATE_OPTIONS.nugget,
    knn: parseFloat(generateOptionKnn.value) || DEFAULT_GENERATE_OPTIONS.knn,
    useDistances: generateOptionUseDistances.checked,
    distanceLeft: parseFloat(generateOptionDistanceLeft.value) || DEFAULT_GENERATE_OPTIONS.distanceLeft,
    distanceRight: parseFloat(generateOptionDistanceRight.value) || DEFAULT_GENERATE_OPTIONS.distanceRight
  };
  saveGenerateOptions(options);
  generateOptionsOverlay.classList.remove('active');
  generateVoxelModel(options);
});

btnCancelGenerateOptions.addEventListener('click', () => {
  generateOptionsOverlay.classList.remove('active');
});

btnCloseGenerateOptions.addEventListener('click', () => {
  generateOptionsOverlay.classList.remove('active');
});

generateOptionsOverlay.addEventListener('click', (e: MouseEvent) => {
  if (e.target === generateOptionsOverlay) {
    generateOptionsOverlay.classList.remove('active');
  }
});

// Generate 2D View along Polyline click handler
btnGenerate2d.addEventListener('click', () => {
  if (uploadedCpts.length === 0) {
    alert('Please upload some CPT files first.');
    return;
  }

  const isRectangle = activeDrawingLayer instanceof L.Rectangle;
  const isPolyline = activeDrawingLayer instanceof L.Polyline && !isRectangle;

  if (!activeDrawingLayer || !isPolyline || polylinePoints.length < 2) {
    alert('Please draw a line with at least 2 points on the map first.');
    return;
  }

  // Switch visual displays
  voxel3dPanel.style.display = 'none';
  voxelModelViewer.style.display = 'none';
  btnResetView.style.display = 'none';
  btnDownloadGlb.style.display = 'none';
  btnDrawCrosssection.style.display = 'none';
  btnDrawCrosssectionMap.style.display = 'none';
  crosssectionToolbarDivider.style.display = 'none';
  exitCrossSectionDrawMode();
  exitMapCrossSectionDrawMode();
  closeCrossSectionPanel();
  viewerLayersPanel.classList.remove('active');
  profile2dView.style.display = 'flex';

  // Toggle split screen active
  appContainer.classList.add('split-active');
  setTimeout(() => {
    map.invalidateSize();
  }, 500);

  render2dProfile();
});

// Render 2D CPT profile along active polyline
function render2dProfile() {
  if (uploadedCpts.length === 0) {
    profile2dView.style.display = 'none';
    appContainer.classList.remove('split-active');
    resetSplitHeights();
    setTimeout(() => { map.invalidateSize(); }, 500);
    return;
  }

  const isRectangle = activeDrawingLayer instanceof L.Rectangle;
  const isPolyline = activeDrawingLayer instanceof L.Polyline && !isRectangle;

  if (!activeDrawingLayer || !isPolyline || polylinePoints.length < 2) {
    profile2dView.style.display = 'none';
    appContainer.classList.remove('split-active');
    resetSplitHeights();
    setTimeout(() => { map.invalidateSize(); }, 500);
    return;
  }

  // Reset zoom and pan states on fresh render
  profileZoomScale = 1;
  profileTranslateX = 0;
  profilePlotArea.style.width = '100%';
  profilePlotArea.style.transform = 'translateX(0px)';
  profileAxisXTicks.style.width = '100%';
  profileAxisXTicks.style.transform = 'translateX(0px)';

  // Clear previous contents of Y axis, plot, and legend
  profileAxisY.innerHTML = '';
  profilePlotArea.innerHTML = '';
  profileLegend.innerHTML = '';
  profileAxisXTicks.innerHTML = '';

  // Convert polyline to RD to calculate chainage
  const rdPoints = polylinePoints.map(pt => wgs84ToRd(pt.lat, pt.lng));

  // Compute segments, total polyline length, and (if every vertex carries a
  // Z value, e.g. from a CSV/shapefile import) the chainage/Z pairs for the
  // ground-level line.
  const hasLineZ = polylinePoints.length >= 2 && polylinePoints.every(pt => pt.alt !== undefined);
  const lineZPoints: { chainage: number; z: number }[] = hasLineZ
    ? [{ chainage: 0, z: polylinePoints[0].alt as number }]
    : [];

  let totalChainage = 0;
  for (let i = 1; i < rdPoints.length; i++) {
    const dx = rdPoints[i].x - rdPoints[i - 1].x;
    const dy = rdPoints[i].y - rdPoints[i - 1].y;
    totalChainage += Math.sqrt(dx * dx + dy * dy);
    if (hasLineZ) {
      lineZPoints.push({ chainage: totalChainage, z: polylinePoints[i].alt as number });
    }
  }

  if (totalChainage === 0) {
    return;
  }

  // Read max distance from settings input
  let maxDistance = 20;
  if (settingMaxDistance) {
    const val = parseInt(settingMaxDistance.value, 10);
    if (!isNaN(val)) {
      maxDistance = Math.min(250, Math.max(5, val));
    }
  }

  // Project CPTs to the line, filter by max distance of maxDistance, and sort by chainage
  const projectedCpts = uploadedCpts
    .map(cpt => {
      const proj = projectPointToPolyline({ x: cpt.soil_profile.x, y: cpt.soil_profile.y }, rdPoints);
      return {
        cpt,
        chainage: proj.chainage,
        distance: proj.distance
      };
    })
    .filter(item => item.distance <= maxDistance);

  projectedCpts.sort((a, b) => a.chainage - b.chainage);

  if (projectedCpts.length === 0) {
    const emptyMsg = document.createElement('div');
    emptyMsg.style.position = 'absolute';
    emptyMsg.style.top = '50%';
    emptyMsg.style.left = '50%';
    emptyMsg.style.transform = 'translate(-50%, -50%)';
    emptyMsg.style.color = 'var(--text-secondary)';
    emptyMsg.style.fontSize = '0.95rem';
    emptyMsg.style.fontFamily = 'var(--font-family)';
    emptyMsg.textContent = `No CPTs found within ${maxDistance} meters of the active line.`;
    profilePlotArea.appendChild(emptyMsg);
    return;
  }

  // Get dynamic elevations range across ONLY the filtered CPTs
  let minZ = Infinity;
  let maxZ = -Infinity;
  projectedCpts.forEach(({ cpt }) => {
    const layers = cpt.soil_profile?.soil_layers || [];
    layers.forEach(layer => {
      if (layer.bottom < minZ) minZ = layer.bottom;
      if (layer.top > maxZ) maxZ = layer.top;
    });
  });

  if (minZ === Infinity || maxZ === -Infinity) {
    return;
  }

  // Extend the range so the ground-level line (if any) isn't clipped
  if (hasLineZ) {
    lineZPoints.forEach(({ z }) => {
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    });
  }

  // Round maxZ up to nearest 5m, minZ down to nearest 5m
  const roundedMaxZ = Math.ceil(maxZ / 5) * 5;
  const roundedMinZ = Math.floor(minZ / 5) * 5;
  const zRange = roundedMaxZ - roundedMinZ;

  // Render Y-Axis labels and horizontal grid lines
  for (let z = roundedMaxZ; z >= roundedMinZ; z -= 5) {
    const yPercent = ((roundedMaxZ - z) / zRange) * 100;

    // Y Axis label
    const label = document.createElement('div');
    label.className = 'profile-axis-label-y';
    label.style.top = `${yPercent}%`;
    label.textContent = `${z}m`;
    profileAxisY.appendChild(label);

    // Horizontal grid line across the plot area
    const gridLine = document.createElement('div');
    gridLine.className = 'profile-grid-line-z';
    gridLine.style.top = `${yPercent}%`;
    profilePlotArea.appendChild(gridLine);
  }

  // Render each CPT
  projectedCpts.forEach(({ cpt, chainage, distance }) => {
    const layers = cpt.soil_profile?.soil_layers || [];
    if (layers.length === 0) return;

    const leftPercent = 5 + (chainage / totalChainage) * 90;

    // Outer column wrapper
    const colEl = document.createElement('div');
    colEl.className = 'profile-cpt-column';
    colEl.style.left = `calc(${leftPercent}% - 12px)`; // Center the column on the point

    // The soil column bar element
    const barEl = document.createElement('div');
    barEl.className = 'profile-cpt-bar';

    const topZ = layers[0].top;
    const bottomZ = layers[layers.length - 1].bottom;
    const heightZ = topZ - bottomZ;

    const barTopPercent = ((roundedMaxZ - topZ) / zRange) * 100;
    const barHeightPercent = (heightZ / zRange) * 100;

    barEl.style.top = `${barTopPercent}%`;
    barEl.style.height = `${barHeightPercent}%`;
    barEl.title = `CPT: ${cpt.cpt_name}\nChainage: ${chainage.toFixed(1)}m\nDistance to line: ${distance.toFixed(1)}m`;

    // Render individual soil layer segments inside the bar
    layers.forEach(layer => {
      const segmentTopPercent = ((topZ - layer.top) / heightZ) * 100;
      const segmentHeightPercent = ((layer.top - layer.bottom) / heightZ) * 100;
      const resolvedCode = resolveSoilCode(layer.soil_code);
      const color = soilColors[resolvedCode] || '#808080';
      const displayName = resolvedCode === layer.soil_code
        ? layer.soil_code.replace(/_/g, ' ')
        : `${resolvedCode.replace(/_/g, ' ')} (${layer.soil_code.replace(/_/g, ' ')})`;

      const segEl = document.createElement('div');
      segEl.style.position = 'absolute';
      segEl.style.left = '0';
      segEl.style.right = '0';
      segEl.style.top = `${segmentTopPercent}%`;
      segEl.style.height = `${segmentHeightPercent}%`;
      segEl.style.backgroundColor = color;
      segEl.title = `${displayName}: ${layer.top.toFixed(2)}m to ${layer.bottom.toFixed(2)}m (${(layer.top - layer.bottom).toFixed(2)}m)`;

      barEl.appendChild(segEl);
    });

    // Highlight matching map marker on hover
    colEl.addEventListener('mouseenter', () => {
      const match = cptMarkerList.find(item => item.cpt === cpt);
      if (match) {
        const el = match.marker.getElement();
        if (el) {
          el.classList.add('highlighted');
        }
      }
    });

    colEl.addEventListener('mouseleave', () => {
      const match = cptMarkerList.find(item => item.cpt === cpt);
      if (match) {
        const el = match.marker.getElement();
        if (el) {
          el.classList.remove('highlighted');
        }
      }
    });

    // The name label placed under the bar
    const labelEl = document.createElement('div');
    labelEl.className = 'profile-cpt-label';
    labelEl.textContent = cpt.cpt_name;

    colEl.appendChild(barEl);
    colEl.appendChild(labelEl);
    profilePlotArea.appendChild(colEl);
  });

  // Render the ground-level line (Z values carried by the active polyline)
  if (hasLineZ && lineZPoints.length >= 2) {
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('viewBox', '0 0 100 100');
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.style.position = 'absolute';
    svg.style.inset = '0';
    svg.style.width = '100%';
    svg.style.height = '100%';
    svg.style.pointerEvents = 'none';
    svg.style.overflow = 'visible';

    const pointsAttr = lineZPoints
      .map(({ chainage, z }) => {
        const x = 5 + (chainage / totalChainage) * 90;
        const y = ((roundedMaxZ - z) / zRange) * 100;
        return `${x},${y}`;
      })
      .join(' ');

    const groundLineEl = document.createElementNS(svgNS, 'polyline');
    groundLineEl.setAttribute('points', pointsAttr);
    groundLineEl.setAttribute('fill', 'none');
    groundLineEl.setAttribute('stroke', '#22c55e');
    groundLineEl.setAttribute('stroke-width', '2');
    groundLineEl.setAttribute('vector-effect', 'non-scaling-stroke');

    const titleEl = document.createElementNS(svgNS, 'title');
    titleEl.textContent = 'Ground level (Z)';
    groundLineEl.appendChild(titleEl);

    svg.appendChild(groundLineEl);
    profilePlotArea.appendChild(svg);
  }

  // Render X-axis ticks
  profileAxisXTicks.innerHTML = '';
  let step = 10;
  if (totalChainage < 20) step = 2;
  else if (totalChainage < 50) step = 5;
  else if (totalChainage < 150) step = 10;
  else if (totalChainage < 300) step = 20;
  else if (totalChainage < 800) step = 50;
  else step = 100;

  for (let d = 0; d <= totalChainage; d += step) {
    const pct = 5 + (d / totalChainage) * 90;

    const tickEl = document.createElement('div');
    tickEl.className = 'profile-axis-label-x';
    tickEl.style.left = `${pct}%`;

    const lineEl = document.createElement('div');
    lineEl.className = 'axis-x-tick';

    const textEl = document.createElement('span');
    textEl.className = 'axis-x-text';
    textEl.textContent = `${d}m`;

    tickEl.appendChild(lineEl);
    tickEl.appendChild(textEl);
    profileAxisXTicks.appendChild(tickEl);
  }

  // Draw final tick representing exact total chainage
  const remaining = totalChainage % step;
  if (remaining > 0.15 * step) {
    const pct = 95;
    const tickEl = document.createElement('div');
    tickEl.className = 'profile-axis-label-x';
    tickEl.style.left = `${pct}%`;

    const lineEl = document.createElement('div');
    lineEl.className = 'axis-x-tick';

    const textEl = document.createElement('span');
    textEl.className = 'axis-x-text';
    textEl.textContent = `${totalChainage.toFixed(1)}m`;

    tickEl.appendChild(lineEl);
    tickEl.appendChild(textEl);
    profileAxisXTicks.appendChild(tickEl);
  }

  // Render unified single legend for all soil codes present in this profile
  const presentSoilCodes = new Set<string>();
  projectedCpts.forEach(({ cpt }) => {
    const layers = cpt.soil_profile?.soil_layers || [];
    layers.forEach(layer => {
      presentSoilCodes.add(resolveSoilCode(layer.soil_code));
    });
  });

  presentSoilCodes.forEach(code => {
    const color = soilColors[code] || '#808080';
    const displayName = code.replace(/_/g, ' ');

    const itemEl = document.createElement('div');
    itemEl.className = 'legend-item';

    const colorBox = document.createElement('div');
    colorBox.className = 'legend-color-box';
    colorBox.style.backgroundColor = color;

    const textEl = document.createElement('div');
    textEl.className = 'legend-text';
    textEl.textContent = displayName;
    textEl.title = displayName;

    itemEl.appendChild(colorBox);
    itemEl.appendChild(textEl);
    profileLegend.appendChild(itemEl);
  });

  if (hasLineZ) {
    const lineItemEl = document.createElement('div');
    lineItemEl.className = 'legend-item';

    const lineColorBox = document.createElement('div');
    lineColorBox.className = 'legend-color-box';
    lineColorBox.style.backgroundColor = '#22c55e';

    const lineTextEl = document.createElement('div');
    lineTextEl.className = 'legend-text';
    lineTextEl.textContent = 'Ground level (Z)';
    lineTextEl.title = 'Ground level (Z)';

    lineItemEl.appendChild(lineColorBox);
    lineItemEl.appendChild(lineTextEl);
    profileLegend.appendChild(lineItemEl);
  }
}

// Helper to reset custom split heights
function resetSplitHeights() {
  mapContainer.style.height = '';
  viewerContainer.style.height = '';
}

// // Close viewer and clean up resources
// btnCloseViewer.addEventListener('click', () => {
//   appContainer.classList.remove('split-active');
//   resetSplitHeights();
//   viewerLayersPanel.classList.remove('active');
//   viewerLayersList.innerHTML = '';

//   if (voxelModelViewer.src) {
//     URL.revokeObjectURL(voxelModelViewer.src);
//     voxelModelViewer.removeAttribute('src');
//   }

//   // Close and reset 2D view state
//   profile2dView.style.display = 'none';
//   voxelModelViewer.style.display = 'block';
//   btnResetView.style.display = 'block';
//   btnDownloadGlb.style.display = 'block';

//   setTimeout(() => {
//     map.invalidateSize();
//   }, 500);
// });

// Download 2D CPT Profile as PNG
btnDownloadProfile.addEventListener('click', () => {
  if (profile2dView.style.display !== 'flex') return;

  // Temporarily hide the download button so it isn't captured in the image
  btnDownloadProfile.style.visibility = 'hidden';

  htmlToImage.toPng(profile2dView, {
    backgroundColor: '#0b0f19',
    style: {
      borderRadius: '0px'
    }
  })
    .then((dataUrl) => {
      btnDownloadProfile.style.visibility = 'visible';
      const link = document.createElement('a');
      link.download = 'cpt-profile.png';
      link.href = dataUrl;
      link.click();
    })
    .catch((error) => {
      btnDownloadProfile.style.visibility = 'visible';
      console.error('Failed to export CPT profile:', error);
      alert('Failed to export CPT profile image.');
    });
});

// Download BRO CPT and Borehole data along polyline
btnDownloadBro.addEventListener('click', async () => {
  if (polylinePoints.length < 2) {
    alert('Please draw a line with at least 2 points on the map first.');
    return;
  }

  // Show loading indicator
  if (loaderText) {
    loaderText.textContent = 'Downloading BRO data...';
  }
  loadingOverlay.classList.add('active');

  try {
    // 1. Convert polyline coordinates to EPSG:28992 (RD)
    const rdPoints = polylinePoints.map(pt => {
      const rd = wgs84ToRd(pt.lat, pt.lng);
      return [rd.x, rd.y];
    });

    // Read the max distance from settings to use as offset (fallback to 10)
    let maxDistance = 10;
    if (settingMaxDistance) {
      const val = parseInt(settingMaxDistance.value, 10);
      if (!isNaN(val)) {
        maxDistance = val;
      }
    }

    console.log('RD points:', rdPoints);

    // 2. Fetch CPT and Borehole metadata along the polyline from BRO
    let characteristics = [];
    try {
      const metadataResponse = await fetch(`${API_URL}/api/slim/bro/cpt_metadata/by_polyline`, {
        method: 'POST',
        headers: {
          'accept': 'application/json',
          'X-API-Key': API_KEY,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          points: rdPoints,
          offset: maxDistance
        })
      });
      if (metadataResponse.ok) {
        const metadataData = await metadataResponse.json();
        characteristics = metadataData.cpt_characteristics || [];
      } else {
        const errText = await metadataResponse.text();
        console.warn(`Failed to fetch BRO CPT metadata: ${metadataResponse.status}. ${errText}`);
      }
    } catch (e: any) {
      console.warn('Error fetching BRO CPT metadata:', e);
    }

    let boreholeCharacteristics = [];
    const shouldDownloadBoreholes = settingDownloadBoreholes ? settingDownloadBoreholes.checked : false;

    if (shouldDownloadBoreholes) {
      try {
        const bhMetadataResponse = await fetch(`${API_URL}/api/slim/bro/borehole_metadata/by_polyline`, {
          method: 'POST',
          headers: {
            'accept': 'application/json',
            'X-API-Key': API_KEY,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            points: rdPoints,
            offset: maxDistance
          })
        });
        if (bhMetadataResponse.ok) {
          const bhMetadataData = await bhMetadataResponse.json();
          boreholeCharacteristics = bhMetadataData.borehole_characteristics || [];
        } else {
          const errText = await bhMetadataResponse.text();
          console.warn(`Failed to fetch BRO Borehole metadata: ${bhMetadataResponse.status}. ${errText}`);
        }
      } catch (e: any) {
        console.warn('Error fetching BRO Borehole metadata:', e);
      }
    }

    if (characteristics.length === 0 && boreholeCharacteristics.length === 0) {
      if (shouldDownloadBoreholes) {
        alert('No BRO CPTs or Boreholes found near the active polyline.');
      } else {
        alert('No BRO CPTs found near the active polyline.');
      }
      return;
    }

    if (shouldDownloadBoreholes) {
      console.log(`Found ${characteristics.length} CPTs and ${boreholeCharacteristics.length} Boreholes from BRO.`);
    } else {
      console.log(`Found ${characteristics.length} CPTs from BRO.`);
    }

    // 3. Retrieve CPT interpretations
    let successCptCount = 0;
    let skipCptCount = 0;

    for (const item of characteristics) {
      const broId = item.bro_id;
      const fileName = `${broId}.xml`;

      // Avoid duplicates or already uploaded files using the BRO ID
      const isAlreadyUploaded = uploadedCpts.some(cpt => {
        const nameMatch = cpt.cpt_name.toLowerCase() === broId.toLowerCase();
        const fn = ((cpt as any).filename || '').toLowerCase();
        const fileMatch = fn.includes(broId.toLowerCase());
        return nameMatch || fileMatch;
      });

      if (isAlreadyUploaded) {
        console.log(`Skipping CPT ${broId} because it is already uploaded.`);
        skipCptCount++;
        continue;
      }

      let minLH = 0.2;
      if (settingMinLayerheight) {
        const val = parseFloat(settingMinLayerheight.value);
        if (!isNaN(val)) {
          minLH = val;
        }
      }

      try {
        const interpResponse = await fetch(`${API_URL}/api/slim/bro/cpt_interpretation`, {
          method: 'POST',
          headers: {
            'accept': 'application/json',
            'X-API-Key': API_KEY,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            bro_id: broId,
            method: 2,
            minimum_layerheight: minLH,
            peat_friction_ratio: 6
          })
        });

        if (!interpResponse.ok) {
          console.warn(`Failed to fetch interpretation for ${broId}: ${interpResponse.status}`);
          continue;
        }

        const data: CptData = await interpResponse.json();
        (data as any).filename = fileName;
        registerUnrecognizedSoilCodes(data);
        uploadedCpts.push(data);
        uploadedFilenames.add(fileName);
        addCptMarker(data);
        successCptCount++;
      } catch (err) {
        console.warn(`Error importing CPT ${broId}:`, err);
      }
    }

    // 4. Retrieve Boreholes
    let successBoreholeCount = 0;
    let skipBoreholeCount = 0;

    for (const item of boreholeCharacteristics) {
      const broId = item.bro_id;
      const fileName = `${broId}.gef`; // Or XML depending on how it's saved/stored

      // Avoid duplicates using the BRO ID
      const isAlreadyUploaded = uploadedCpts.some(cpt => {
        const nameMatch = cpt.cpt_name.toLowerCase() === broId.toLowerCase();
        const fn = ((cpt as any).filename || '').toLowerCase();
        const fileMatch = fn.includes(broId.toLowerCase());
        return nameMatch || fileMatch;
      });

      if (isAlreadyUploaded) {
        console.log(`Skipping Borehole ${broId} because it is already uploaded.`);
        skipBoreholeCount++;
        continue;
      }

      try {
        const bhResponse = await fetch(`${API_URL}/api/slim/borehole/from_bro_id/${broId}`, {
          method: 'GET',
          headers: {
            'accept': 'application/json',
            'X-API-Key': API_KEY
          }
        });

        if (!bhResponse.ok) {
          console.warn(`Failed to fetch Borehole details for ${broId}: ${bhResponse.status}`);
          continue;
        }

        const boreholeData = await bhResponse.json();
        if (!boreholeData || !boreholeData.soil_profile) {
          console.warn(`Invalid borehole data structure for ${broId}`);
          continue;
        }

        // Map Borehole structure to CptData structure
        const cptData: CptData = {
          cpt_name: boreholeData.name || broId,
          is_borehole: true,
          soil_profile: {
            soil_layers: (boreholeData.soil_profile.soil_layers || []).map((layer: any) => ({
              top: Number(layer.top),
              bottom: Number(layer.bottom),
              soil_code: String(layer.soil_code)
            })),
            c: boreholeData.soil_profile.c,
            x: Number(boreholeData.x !== undefined ? boreholeData.x : (boreholeData.soil_profile.x ?? 0)),
            y: Number(boreholeData.y !== undefined ? boreholeData.y : (boreholeData.soil_profile.y ?? 0)),
            location: String(boreholeData.soil_profile.location || '')
          }
        };

        (cptData as any).filename = fileName;
        registerUnrecognizedSoilCodes(cptData);
        uploadedCpts.push(cptData);
        uploadedFilenames.add(fileName);
        addCptMarker(cptData);
        successBoreholeCount++;
      } catch (err) {
        console.warn(`Error importing Borehole ${broId}:`, err);
      }
    }

    const cptMsg = `Imported ${successCptCount} BRO CPTs${skipCptCount > 0 ? ` (Skipped ${skipCptCount} duplicates)` : ''}`;
    const bhMsg = `Imported ${successBoreholeCount} BRO Boreholes${skipBoreholeCount > 0 ? ` (Skipped ${skipBoreholeCount} duplicates)` : ''}`;
    alert(`Successfully completed BRO import:\n- ${cptMsg}\n- ${bhMsg}`);

  } catch (error: any) {
    console.error('Error downloading BRO data:', error);
    alert(`Failed to download BRO data: ${error.message}`);
  } finally {
    loadingOverlay.classList.remove('active');
    if (loaderText) {
      loaderText.textContent = 'Generating 3D Voxel Model...';
    }
  }
});

// Download GLB model
btnDownloadGlb.addEventListener('click', () => {
  if (!currentVoxelModelUrl) return;

  const a = document.createElement('a');
  a.href = currentVoxelModelUrl;
  a.download = 'voxel_model.glb';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
});

// Reset viewpoint and zoom of the 3D model viewer
btnResetView.addEventListener('click', () => {
  if (!voxelModelRoot) return;
  resetVoxelView();
});

// Map Event Handler: mousedown (Rectangle Start)
map.on('mousedown', (e: L.LeafletMouseEvent) => {
  if (currentMode !== 'draw-rect') return;
  // Ensure left-click
  if (e.originalEvent.button !== 0) return;

  clearDrawing();

  isDrawingRectangle = true;
  rectStartLatLng = e.latlng;
  map.dragging.disable();

  const bounds = L.latLngBounds(rectStartLatLng, rectStartLatLng);
  const rect = L.rectangle(bounds, {
    color: '#6366f1',
    weight: 2,
    fillOpacity: 0.15
  }).addTo(map);

  activeDrawingLayer = rect;
  btnClearDraw.disabled = false;

  // Initialize marker styles
  updateCptMarkerStyles();
});

// Map Event Handler: mousemove (Rectangle Resize)
map.on('mousemove', (e: L.LeafletMouseEvent) => {
  if (currentMode !== 'draw-rect' || !isDrawingRectangle || !rectStartLatLng || !activeDrawingLayer) return;

  const currentLatLng = e.latlng;
  const bounds = L.latLngBounds(rectStartLatLng, currentLatLng);
  (activeDrawingLayer as L.Rectangle).setBounds(bounds);

  // Update marker styles dynamically as bounds resize
  updateCptMarkerStyles();
});

// Helper to finish drawing a rectangle
function finishRectangleDrawing() {
  if (!isDrawingRectangle) return;
  isDrawingRectangle = false;
  map.dragging.enable();

  if (activeDrawingLayer) {
    const bounds = (activeDrawingLayer as L.Rectangle).getBounds();
    const northWest = bounds.getNorthWest();
    const southEast = bounds.getSouthEast();

    // If mouse was released immediately at starting point, clear the drawing
    if (northWest.equals(southEast)) {
      map.removeLayer(activeDrawingLayer);
      activeDrawingLayer = null;
      btnClearDraw.disabled = true;
      generateContainer.classList.remove('active');
      btnGenerate2d.style.display = 'none';
      btnDownloadBro.style.display = 'none';
      updateCptMarkerStyles();
    } else {
      updateCptMarkerStyles();
      // Only show the generate button if at least one CPT is selected
      const selectedCptsCount = cptMarkerList.filter(({ marker }) => bounds.contains(marker.getLatLng())).length;
      if (selectedCptsCount > 0) {
        generateContainer.classList.add('active');
        btnGenerate2d.style.display = 'none';
        btnDownloadBro.style.display = 'none';
      } else {
        generateContainer.classList.remove('active');
        btnGenerate2d.style.display = 'none';
        btnDownloadBro.style.display = 'none';
      }
    }
  }
}

// Map Event Handler: mouseup (Rectangle End)
map.on('mouseup', () => {
  if (currentMode === 'draw-rect') {
    finishRectangleDrawing();
  }
});

// Window Event Handler: mouseup (handles release outside map container)
window.addEventListener('mouseup', () => {
  if (currentMode === 'draw-rect' && isDrawingRectangle) {
    finishRectangleDrawing();
  }
});

// Map Event Handler: click (Polyline Point Addition)
map.on('click', (e: L.LeafletMouseEvent) => {
  if (currentMode !== 'draw-line') return;

  const latlng = e.latlng;
  polylinePoints.push(latlng);
  btnClearDraw.disabled = false;

  // Create or update polyline layer
  if (!activeDrawingLayer) {
    const line = L.polyline(polylinePoints, {
      color: '#a855f7',
      weight: 3
    }).addTo(map);
    activeDrawingLayer = line;
  } else {
    (activeDrawingLayer as L.Polyline).setLatLngs(polylinePoints);
  }

  // Add circle marker for vertex
  const marker = L.circleMarker(latlng, {
    radius: 5,
    color: '#a855f7',
    fillColor: '#fff',
    fillOpacity: 1,
    weight: 2
  }).addTo(map);
  polylineMarkers.push(marker);

  // Toggle Generate Voxel button (needs >= 2 points)
  if (polylinePoints.length >= 2) {
    generateContainer.classList.add('active');
    btnGenerate2d.style.display = 'flex';
    btnDownloadBro.style.display = 'flex';
  } else {
    generateContainer.classList.remove('active');
    btnGenerate2d.style.display = 'none';
    btnDownloadBro.style.display = 'none';
  }

  // Refresh 2D Profile view if open
  if (profile2dView.style.display === 'flex') {
    render2dProfile();
  }
});

// Map Event Handler: contextmenu (Polyline Point Deletion)
map.on('contextmenu', (e: L.LeafletMouseEvent) => {
  if (currentMode !== 'draw-line') return;

  // Prevent system context menu
  e.originalEvent.preventDefault();

  if (polylinePoints.length > 0) {
    polylinePoints.pop();

    const marker = polylineMarkers.pop();
    if (marker) {
      map.removeLayer(marker);
    }

    if (activeDrawingLayer) {
      if (polylinePoints.length === 0) {
        map.removeLayer(activeDrawingLayer);
        activeDrawingLayer = null;
        btnClearDraw.disabled = true;
        generateContainer.classList.remove('active');
      } else {
        (activeDrawingLayer as L.Polyline).setLatLngs(polylinePoints);
      }
    }

    if (polylinePoints.length >= 2) {
      generateContainer.classList.add('active');
      btnGenerate2d.style.display = 'flex';
      btnDownloadBro.style.display = 'flex';
    } else {
      generateContainer.classList.remove('active');
      btnGenerate2d.style.display = 'none';
      btnDownloadBro.style.display = 'none';
    }

    // Refresh 2D Profile view if open
    if (profile2dView.style.display === 'flex') {
      render2dProfile();
    }
  }
});

// Zoom and Pan for 2D Profile View
const plotContainer = document.querySelector('.profile-plot-area-container') as HTMLDivElement;

plotContainer.addEventListener('wheel', (e: WheelEvent) => {
  if (profile2dView.style.display !== 'flex') return;
  e.preventDefault();

  const rect = plotContainer.getBoundingClientRect();
  const mouseX = e.clientX - rect.left;

  // Calculate normalized coordinate of the mouse pointer on the plot area
  const plotX = mouseX - profileTranslateX;
  const normX = plotX / (rect.width * profileZoomScale);

  // Calculate new zoom scale
  const zoomFactor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
  let newScale = profileZoomScale * zoomFactor;
  newScale = Math.max(1, Math.min(25, newScale));

  // Calculate new translation to keep the mouse pointer over the same coordinate
  profileTranslateX = mouseX - normX * (rect.width * newScale);
  profileZoomScale = newScale;

  // Constrain translation bounds
  if (profileZoomScale === 1) {
    profileTranslateX = 0;
  } else {
    const minTranslate = rect.width * (1 - profileZoomScale);
    profileTranslateX = Math.max(minTranslate, Math.min(0, profileTranslateX));
  }

  profilePlotArea.style.width = `${profileZoomScale * 100}%`;
  profilePlotArea.style.transform = `translateX(${profileTranslateX}px)`;

  profileAxisXTicks.style.width = `${profileZoomScale * 100}%`;
  profileAxisXTicks.style.transform = `translateX(${profileTranslateX}px)`;
});

plotContainer.addEventListener('mousedown', (e: MouseEvent) => {
  if (profile2dView.style.display !== 'flex') return;
  if (e.button !== 0) return; // only left click
  isProfileDragging = true;
  profileStartX = e.clientX - profileTranslateX;
});

window.addEventListener('mousemove', (e: MouseEvent) => {
  if (!isProfileDragging || profile2dView.style.display !== 'flex') return;

  const rect = plotContainer.getBoundingClientRect();
  let transX = e.clientX - profileStartX;

  // Constrain translation bounds
  if (profileZoomScale === 1) {
    transX = 0;
  } else {
    const minTranslate = rect.width * (1 - profileZoomScale);
    transX = Math.max(minTranslate, Math.min(0, transX));
  }

  profileTranslateX = transX;
  profilePlotArea.style.transform = `translateX(${profileTranslateX}px)`;

  profileAxisXTicks.style.transform = `translateX(${profileTranslateX}px)`;
});

window.addEventListener('mouseup', () => {
  isProfileDragging = false;
});

// Settings: max distance input event listeners
if (settingMaxDistance) {
  settingMaxDistance.addEventListener('input', () => {
    if (profile2dView.style.display === 'flex') {
      render2dProfile();
    }
  });

  settingMaxDistance.addEventListener('blur', () => {
    let val = parseInt(settingMaxDistance.value, 10);
    if (isNaN(val)) {
      val = 20;
    }
    const clamped = Math.min(250, Math.max(5, val));
    settingMaxDistance.value = clamped.toString();
    if (profile2dView.style.display === 'flex') {
      render2dProfile();
    }
  });
}

if (settingMinLayerheight) {
  settingMinLayerheight.addEventListener('blur', () => {
    let val = parseFloat(settingMinLayerheight.value);
    if (isNaN(val)) {
      val = 0.2;
    }
    const clamped = Math.min(2.0, Math.max(0.2, val));
    settingMinLayerheight.value = clamped.toFixed(1);
  });
}

// Resizable splitter dragging event listeners
let isResizing = false;

splitDivider.addEventListener('mousedown', (e: MouseEvent) => {
  if (appContainer.classList.contains('split-active')) {
    isResizing = true;
    appContainer.classList.add('resizing');
    e.preventDefault();
  }
});

window.addEventListener('mousemove', (e: MouseEvent) => {
  if (!isResizing) return;

  const totalHeight = appContainer.clientHeight;
  const clientY = e.clientY;

  // Enforce 200px minimum limits for both parts
  const minPixels = 200;
  const maxPixels = totalHeight - 200;
  const clampedY = Math.max(minPixels, Math.min(maxPixels, clientY));

  // Convert to percentage for responsive scaling
  const percent = (clampedY / totalHeight) * 100;

  // Update heights matching custom split ratio
  mapContainer.style.height = `calc(${percent}% - 3px)`;
  viewerContainer.style.height = `calc(${100 - percent}% - 3px)`;

  // Keep Leaflet viewport updated during drag
  map.invalidateSize();
});

window.addEventListener('mouseup', () => {
  if (isResizing) {
    isResizing = false;
    appContainer.classList.remove('resizing');
    map.invalidateSize();
  }
});

// Save Project
btnSaveProject.addEventListener('click', () => {
  try {
    let drawing: any = undefined;
    if (activeDrawingLayer) {
      if (activeDrawingLayer instanceof L.Rectangle) {
        const bounds = activeDrawingLayer.getBounds();
        drawing = {
          type: 'rectangle',
          bounds: {
            southWest: { lat: bounds.getSouthWest().lat, lng: bounds.getSouthWest().lng },
            northEast: { lat: bounds.getNorthEast().lat, lng: bounds.getNorthEast().lng }
          }
        };
      } else if (activeDrawingLayer instanceof L.Polyline) {
        drawing = {
          type: 'polyline',
          points: polylinePoints.map(pt => ({ lat: pt.lat, lng: pt.lng, alt: pt.alt }))
        };
      }
    }

    let maxDistance = 20;
    if (settingMaxDistance) {
      const val = parseInt(settingMaxDistance.value, 10);
      if (!isNaN(val)) {
        maxDistance = val;
      }
    }

    let minLayerheight = 0.2;
    if (settingMinLayerheight) {
      const val = parseFloat(settingMinLayerheight.value);
      if (!isNaN(val)) {
        minLayerheight = val;
      }
    }

    const projectData = {
      version: '1.0.0',
      uploadedCpts,
      uploadedFilenames: Array.from(uploadedFilenames),
      settings: {
        maxDistance,
        minLayerheight
      },
      drawing,
      soilColors,
      soilSynonyms
    };

    const jsonStr = JSON.stringify(projectData, null, 2);
    const blob = new Blob([jsonStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = `webvoxel-project-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();

    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  } catch (error: any) {
    console.error('Error saving project:', error);
    alert(`Failed to save project: ${error.message}`);
  }
});

// Load Project
btnLoadProject.addEventListener('click', () => {
  fileInputProject.value = '';
  fileInputProject.click();
});

fileInputProject.addEventListener('change', async (e: Event) => {
  const target = e.target as HTMLInputElement;
  if (!target.files || target.files.length === 0) return;

  const file = target.files[0];
  loadingOverlay.classList.add('active');
  if (loaderText) {
    loaderText.textContent = 'Loading project...';
  }

  try {
    const text = await file.text();
    const projectData = JSON.parse(text);

    if (!projectData || !Array.isArray(projectData.uploadedCpts)) {
      throw new Error('Invalid project file format. Missing uploadedCpts list.');
    }

    // 1. Reset state
    clearDrawing();

    cptMarkerList.forEach(({ marker }) => {
      map.removeLayer(marker);
    });
    cptMarkerList.length = 0;

    uploadedCpts.length = 0;
    uploadedFilenames.clear();

    // 2. Re-populate files and settings
    if (projectData.soilColors) {
      soilColors = { ...projectData.soilColors };
      // Refresh soils maintenance modal list if it's currently open
      if (soilMaintenanceOverlay && soilMaintenanceOverlay.classList.contains('active')) {
        renderSoilsList();
      }
    }
    if (projectData.soilSynonyms) {
      soilSynonyms = { ...projectData.soilSynonyms };
    } else {
      soilSynonyms = {};
    }
    updateVoxelLegendColors();
    if (projectData.settings) {
      if (typeof projectData.settings.maxDistance === 'number' && settingMaxDistance) {
        settingMaxDistance.value = String(projectData.settings.maxDistance);
      }
      if (typeof projectData.settings.minLayerheight === 'number' && settingMinLayerheight) {
        settingMinLayerheight.value = String(projectData.settings.minLayerheight);
      }
    }

    if (Array.isArray(projectData.uploadedFilenames)) {
      projectData.uploadedFilenames.forEach((fn: string) => {
        uploadedFilenames.add(fn);
      });
    }

    // 3. Re-populate CPTs
    projectData.uploadedCpts.forEach((cpt: CptData) => {
      registerUnrecognizedSoilCodes(cpt);
      uploadedCpts.push(cpt);
      addCptMarker(cpt);
    });

    // 4. Reconstruct drawings
    if (projectData.drawing) {
      const dw = projectData.drawing;
      if (dw.type === 'polyline' && Array.isArray(dw.points)) {
        polylinePoints = dw.points.map((p: { lat: number; lng: number; alt?: number }) => L.latLng(p.lat, p.lng, p.alt));

        const line = L.polyline(polylinePoints, {
          color: '#a855f7',
          weight: 3
        }).addTo(map);
        activeDrawingLayer = line;

        polylinePoints.forEach(latlng => {
          const marker = L.circleMarker(latlng, {
            radius: 5,
            color: '#a855f7',
            fillColor: '#fff',
            fillOpacity: 1,
            weight: 2
          }).addTo(map);
          polylineMarkers.push(marker);
        });

        btnClearDraw.disabled = false;
        generateContainer.classList.add('active');
        btnGenerate2d.style.display = 'flex';
        btnDownloadBro.style.display = 'flex';

        const bounds = L.latLngBounds(polylinePoints);
        map.fitBounds(bounds);

        if (profile2dView.style.display === 'flex') {
          render2dProfile();
        }
      } else if (dw.type === 'rectangle' && dw.bounds) {
        const sw = L.latLng(dw.bounds.southWest.lat, dw.bounds.southWest.lng);
        const ne = L.latLng(dw.bounds.northEast.lat, dw.bounds.northEast.lng);
        const bounds = L.latLngBounds(sw, ne);

        const rect = L.rectangle(bounds, {
          color: '#3b82f6',
          weight: 2,
          fillColor: '#3b82f6',
          fillOpacity: 0.15
        }).addTo(map);
        activeDrawingLayer = rect;

        btnClearDraw.disabled = false;

        const selectedCptsCount = cptMarkerList.filter(({ marker }) => bounds.contains(marker.getLatLng())).length;
        if (selectedCptsCount > 0) {
          generateContainer.classList.add('active');
        }
        btnGenerate2d.style.display = 'none';
        btnDownloadBro.style.display = 'none';

        updateCptMarkerStyles();
        map.fitBounds(bounds);
      }
    } else {
      if (cptMarkerList.length > 0) {
        const group = L.featureGroup(cptMarkerList.map(({ marker }) => marker));
        map.fitBounds(group.getBounds());
      }
    }

    alert('Project loaded successfully!');
  } catch (error: any) {
    console.error('Error loading project:', error);
    alert(`Failed to load project: ${error.message}`);
  } finally {
    loadingOverlay.classList.remove('active');
    if (loaderText) {
      loaderText.textContent = 'Generating 3D Voxel Model...';
    }
  }
});

// New Project
btnNewProject.addEventListener('click', () => {
  if (confirm('Are you sure you want to start a new project? This will clear all current CPTs and drawings.')) {
    // 1. Reset state & clear drawings
    clearDrawing();

    // 2. Remove CPT markers from map
    cptMarkerList.forEach(({ marker }) => {
      map.removeLayer(marker);
    });
    cptMarkerList.length = 0;

    // 3. Clear storage arrays/sets
    uploadedCpts.length = 0;
    uploadedFilenames.clear();

    // 4. Reset max distance settings input
    if (settingMaxDistance) {
      settingMaxDistance.value = '20';
    }

    // 5. Reset upload badges
    if (uploadCptsBadge) {
      uploadCptsBadge.textContent = 'Upload';
      uploadCptsBadge.classList.remove('uploading-badge-active');
    }
    if (uploadJsonCptsBadge) {
      uploadJsonCptsBadge.textContent = 'Upload';
      uploadJsonCptsBadge.classList.remove('uploading-badge-active');
    }
    if (uploadShpBadge) {
      uploadShpBadge.textContent = 'Upload';
      uploadShpBadge.classList.remove('uploading-badge-active');
    }
    if (uploadCsvPolylineBadge) {
      uploadCsvPolylineBadge.textContent = 'Upload';
      uploadCsvPolylineBadge.classList.remove('uploading-badge-active');
    }

    // 6. Reset Split View and close panels
    appContainer.classList.remove('split-active');
    resetSplitHeights();
    viewerLayersPanel.classList.remove('active');
    viewerLayersList.innerHTML = '';

    if (currentVoxelModelUrl) {
      URL.revokeObjectURL(currentVoxelModelUrl);
      currentVoxelModelUrl = null;
    }
    disposeVoxelModel();
    mapOpacityControl.style.display = 'none';

    profile2dView.style.display = 'none';
    voxel3dPanel.style.display = 'block';
    voxelModelViewer.style.display = 'block';
    btnResetView.style.display = 'block';
    btnDownloadGlb.style.display = 'block';
    btnDrawCrosssection.style.display = 'none';
    btnDrawCrosssectionMap.style.display = 'none';
    crosssectionToolbarDivider.style.display = 'none';
    currentVoxel3dH5Blob = null;
    exitCrossSectionDrawMode();
    exitMapCrossSectionDrawMode();
    closeCrossSectionPanel();

    // 7. Reset map view to the default view (Netherlands)
    map.setView([52.1326, 5.2913], 8);

    setTimeout(() => {
      map.invalidateSize();
    }, 500);
  }
});

// ==========================================
// Soil Maintenance Functionality
// ==========================================

// Get all soil names currently in use by any uploaded CPT
function getUsedSoilNames(): Set<string> {
  const used = new Set<string>();
  uploadedCpts.forEach(cpt => {
    if (cpt.soil_profile && Array.isArray(cpt.soil_profile.soil_layers)) {
      cpt.soil_profile.soil_layers.forEach(layer => {
        if (layer.soil_code) {
          used.add(layer.soil_code);
        }
      });
    }
  });
  return used;
}

// Rebuild CPT marker popup HTML when colors change
function rebuildCptMarkerPopups() {
  cptMarkerList.forEach(({ cpt, marker }) => {
    // Only rebuild/rebind if the edit popup is not currently open on this marker
    const popupEl = marker.getPopup()?.getElement();
    const isEditing = popupEl && popupEl.querySelector('.cpt-edit-popup');
    if (!isEditing) {
      bindDefaultCptPopup(cpt, marker);
    }
  });
}

// Render dynamic soils list in modal
function renderSoilsList() {
  if (!soilsList) return;
  soilsList.innerHTML = '';

  const usedSoils = getUsedSoilNames();

  Object.entries(soilColors).forEach(([key, color]) => {
    const isUsed = usedSoils.has(key);
    const displayName = key.replace(/_/g, ' ');

    const item = document.createElement('div');
    item.className = 'soil-item';

    item.innerHTML = `
      <div class="soil-item-info">
        <input type="color" class="color-picker-input soil-color-picker" data-key="${key}" value="${color}" title="Change color for ${displayName}" />
        <div class="soil-item-text">
          <span class="soil-item-title">${displayName}</span>
          <span class="soil-item-key">${key}</span>
        </div>
      </div>
      <div class="soil-item-actions">
        <button class="cpt-delete-btn btn-delete-soil" data-key="${key}" ${isUsed ? 'disabled title="Cannot delete: this soil is currently in use"' : 'title="Delete soil type"'}>
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width: 14px; height: 14px;">
            <polyline points="3 6 5 6 21 6"></polyline>
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
          </svg>
        </button>
      </div>
    `;

    // Color picker update listener
    const colorPicker = item.querySelector('.soil-color-picker') as HTMLInputElement;
    colorPicker.addEventListener('input', (e) => {
      const target = e.target as HTMLInputElement;
      const keyVal = target.getAttribute('data-key') || '';
      soilColors[keyVal] = target.value;

      rebuildCptMarkerPopups();
      updateVoxelLegendColors();

      if (profile2dView.style.display === 'flex') {
        render2dProfile();
      }
    });

    // Delete button listener
    const deleteBtn = item.querySelector('.btn-delete-soil') as HTMLButtonElement;
    if (!isUsed) {
      deleteBtn.addEventListener('click', () => {
        if (confirm(`Are you sure you want to delete the soil type "${displayName}"?`)) {
          delete soilColors[key];
          delete soilSynonyms[key];
          Object.entries(soilSynonyms).forEach(([syn, mast]) => {
            if (mast === key) {
              delete soilSynonyms[syn];
            }
          });
          renderSoilsList();
          rebuildCptMarkerPopups();
          updateVoxelLegendColors();
          if (profile2dView.style.display === 'flex') {
            render2dProfile();
          }
        }
      });
    }

    soilsList.appendChild(item);
  });
}

// Add new soil type event
btnAddSoilType.addEventListener('click', () => {
  const rawName = inputNewSoilName.value.trim();
  if (!rawName) {
    alert('Please enter a soil name.');
    return;
  }

  // Format to lowercase, replace special chars and spaces with underscore
  const key = rawName.toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

  if (!key) {
    alert('Invalid soil name. Please use alphanumeric characters and spaces.');
    return;
  }

  if (soilColors[key]) {
    alert(`A soil type with code "${key}" already exists.`);
    return;
  }

  const color = inputNewSoilColor.value;
  soilColors[key] = color;

  inputNewSoilName.value = '';
  inputNewSoilColor.value = '#3b82f6';

  renderSoilsList();
  rebuildCptMarkerPopups();
  updateVoxelLegendColors();
  if (profile2dView.style.display === 'flex') {
    render2dProfile();
  }
});

// Modal Open/Close listeners
optionSoilMaintenance.addEventListener('click', () => {
  renderSoilsList();
  soilMaintenanceOverlay.classList.add('active');
  menuOverlay.classList.remove('active');
});

btnCloseSoilMaintenance.addEventListener('click', () => {
  soilMaintenanceOverlay.classList.remove('active');
});

soilMaintenanceOverlay.addEventListener('click', (e: MouseEvent) => {
  if (e.target === soilMaintenanceOverlay) {
    soilMaintenanceOverlay.classList.remove('active');
  }
});

// Categories Modal Open/Close listeners
optionSoilCategories.addEventListener('click', () => {
  renderCategoriesModal();
  soilCategoriesOverlay.classList.add('active');
  menuOverlay.classList.remove('active');
});

btnCloseSoilCategories.addEventListener('click', () => {
  soilCategoriesOverlay.classList.remove('active');
});

soilCategoriesOverlay.addEventListener('click', (e: MouseEvent) => {
  if (e.target === soilCategoriesOverlay) {
    soilCategoriesOverlay.classList.remove('active');
  }
});

// Render dynamic Soil Categories in modal
function renderCategoriesModal() {
  if (!categoriesSourceList || !categoriesTargetsList) return;

  // Clear lists
  categoriesSourceList.innerHTML = '';
  categoriesTargetsList.innerHTML = '';

  // 1. Render all possible soiltypes on the left as draggable items (excluding categorized synonym soil types)
  Object.entries(soilColors).forEach(([key, color]) => {
    if (soilSynonyms[key]) return;

    const displayName = key.replace(/_/g, ' ');

    const dragItem = document.createElement('div');
    dragItem.className = 'category-drag-item';
    dragItem.draggable = true;
    dragItem.innerHTML = `
      <span class="color-dot" style="background-color: ${color}"></span>
      <span>${displayName}</span>
    `;

    dragItem.addEventListener('dragstart', (e) => {
      e.dataTransfer?.setData('text/plain', key);
    });

    categoriesSourceList.appendChild(dragItem);
  });

  // 2. Render target blocks on the right for each master soil type (i.e. not mapped to another synonym)
  Object.entries(soilColors).forEach(([key, color]) => {
    if (soilSynonyms[key]) return;

    const displayName = key.replace(/_/g, ' ');

    // Find synonyms currently mapped to this master soil type
    const synonyms = Object.entries(soilSynonyms)
      .filter(([_, master]) => master === key)
      .map(([synonymCode, _]) => synonymCode);

    let synonymsHtml = '';
    synonyms.forEach((synonymCode) => {
      const synDisplayName = synonymCode.replace(/_/g, ' ');
      synonymsHtml += `
        <div class="synonym-tag" data-synonym="${synonymCode}">
          <span>${synDisplayName}</span>
          <button class="btn-remove-synonym" title="Remove synonym">&times;</button>
        </div>
      `;
    });

    const targetBlock = document.createElement('div');
    targetBlock.className = 'category-target-block';
    targetBlock.innerHTML = `
      <div class="target-block-header">
        <span class="color-dot" style="background-color: ${color}"></span>
        <span>${displayName}</span>
      </div>
      <div class="target-dropzone" data-key="${key}">
        ${synonyms.length === 0 ? '<span style="color: rgba(255,255,255,0.2); font-size: 0.8rem; pointer-events: none;">Drag soils here...</span>' : synonymsHtml}
      </div>
    `;

    // Dropzone event listeners
    const dropzone = targetBlock.querySelector('.target-dropzone') as HTMLDivElement;
    dropzone.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropzone.classList.add('drag-over');
    });

    dropzone.addEventListener('dragleave', () => {
      dropzone.classList.remove('drag-over');
    });

    dropzone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropzone.classList.remove('drag-over');
      const draggedKey = e.dataTransfer?.getData('text/plain');
      const targetKey = dropzone.getAttribute('data-key');

      if (draggedKey && targetKey && draggedKey !== targetKey) {
        // Map draggedKey's master to targetKey
        soilSynonyms[draggedKey] = targetKey;

        // Remove draggedKey from being a master to other synonyms to keep hierarchy flat
        Object.entries(soilSynonyms).forEach(([syn, mast]) => {
          if (mast === draggedKey) {
            soilSynonyms[syn] = targetKey;
          }
        });

        // Re-render and update UI views
        renderCategoriesModal();
        updateAllAfterSynonymsChange();
      }
    });

    // Remove synonym button listeners
    const removeBtns = targetBlock.querySelectorAll('.btn-remove-synonym');
    removeBtns.forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const tag = (e.target as HTMLElement).closest('.synonym-tag');
        if (tag) {
          const synonymCode = tag.getAttribute('data-synonym');
          if (synonymCode) {
            delete soilSynonyms[synonymCode];
            renderCategoriesModal();
            updateAllAfterSynonymsChange();
          }
        }
      });
    });

    categoriesTargetsList.appendChild(targetBlock);
  });
}

function updateAllAfterSynonymsChange() {
  rebuildCptMarkerPopups();
  updateVoxelLegendColors();
  if (profile2dView.style.display === 'flex') {
    render2dProfile();
  }
}


