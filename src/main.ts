import './style.css';
import 'leaflet/dist/leaflet.css';
import * as L from 'leaflet';
import proj4 from 'proj4';
import * as htmlToImage from 'html-to-image';


// Register EPSG:28992 (RD New)
const RD_DEF = '+proj=sterea +lat_0=52.15616055555555 +lon_0=5.38763888888889 +k=0.9999079 +x_0=155000 +y_0=463000 +ellps=bessel +towgs84=565.417,50.33,465.552,-0.398957,0.343988,-1.8774,4.0725 +units=m +no_defs';
proj4.defs('EPSG:28992', RD_DEF);

// Load configuration from environment variables
const API_URL = (import.meta.env.VITE_API_URL as string) || 'http://127.0.0.1:8000';
const API_KEY = (import.meta.env.VITE_API_KEY as string) || 'key_frontend_987654321';

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
const optionUploadShp = document.getElementById('option-upload-shp') as HTMLLIElement;
const fileInputShp = document.getElementById('file-input-shp') as HTMLInputElement;
const uploadShpBadge = document.getElementById('upload-shp-badge') as HTMLSpanElement;

// Grab drawing elements
const btnDrawRect = document.getElementById('btn-draw-rect') as HTMLButtonElement;
const btnDrawLine = document.getElementById('btn-draw-line') as HTMLButtonElement;
const btnClearDraw = document.getElementById('btn-clear-draw') as HTMLButtonElement;
const drawingInstructions = document.getElementById('drawing-instructions') as HTMLDivElement;
const generateContainer = document.getElementById('generate-container') as HTMLDivElement;
const btnGenerateVoxel = document.getElementById('btn-generate-voxel') as HTMLButtonElement;
const btnGenerate2d = document.getElementById('btn-generate-2d') as HTMLButtonElement;
const btnDownloadBro = document.getElementById('btn-download-bro') as HTMLButtonElement;
const btnSaveProject = document.getElementById('btn-save-project') as HTMLButtonElement;
const btnLoadProject = document.getElementById('btn-load-project') as HTMLButtonElement;
const fileInputProject = document.getElementById('file-input-project') as HTMLInputElement;

// Grab split viewer and loading elements
const appContainer = document.getElementById('app-container') as HTMLDivElement;
const mapContainer = document.getElementById('map-container') as HTMLDivElement;
const viewerContainer = document.getElementById('viewer-container') as HTMLDivElement;
const splitDivider = document.getElementById('split-divider') as HTMLDivElement;
const voxelModelViewer = document.getElementById('voxel-model-viewer') as any;
const btnCloseViewer = document.getElementById('btn-close-viewer') as HTMLButtonElement;
const btnDownloadGlb = document.getElementById('btn-download-glb') as HTMLButtonElement;
const btnResetView = document.getElementById('btn-reset-view') as HTMLButtonElement;
const viewerLayersPanel = document.getElementById('viewer-layers-panel') as HTMLDivElement;
const viewerLayersList = document.getElementById('viewer-layers-list') as HTMLDivElement;
const loadingOverlay = document.getElementById('loading-overlay') as HTMLDivElement;
const loaderText = document.getElementById('loader-text') as HTMLDivElement;

// 2D Profile elements
const profile2dView = document.getElementById('profile-2d-view') as HTMLDivElement;
const profileAxisY = document.getElementById('profile-axis-y') as HTMLDivElement;
const profilePlotArea = document.getElementById('profile-plot-area') as HTMLDivElement;
const profileLegend = document.getElementById('profile-legend') as HTMLDivElement;
const settingMaxDistance = document.getElementById('setting-max-distance') as HTMLInputElement;
const btnDownloadProfile = document.getElementById('btn-download-profile') as HTMLButtonElement;
const profileAxisXTicks = document.getElementById('profile-axis-x-ticks') as HTMLDivElement;

// Toggle menu overlay visibility on pressing F2
window.addEventListener('keydown', (e: KeyboardEvent) => {
  if (e.key === 'F2') {
    e.preventDefault();
    menuOverlay.classList.toggle('active');
  }
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

    let endpointSuffix = '';
    if (lowerName.endsWith('.gef')) {
      endpointSuffix = '/api/slim/cpt_interpretation/from_gef?method=2&minimum_layerheight=0.5&peat_friction_ratio=6';
    } else if (lowerName.endsWith('.xml')) {
      endpointSuffix = '/api/slim/cpt_interpretation/from_xml?method=2&minimum_layerheight=0.5&peat_friction_ratio=6';
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

// Click listener to trigger shapefile input
optionUploadShp.addEventListener('click', () => {
  fileInputShp.click();
});

// Helper function to parse binary ESRI Shapefile coordinates
function parseShpPolyline(arrayBuffer: ArrayBuffer): { lat: number; lng: number }[] {
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
  const points: { lat: number; lng: number }[] = [];

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

      for (let i = 0; i < numPoints; i++) {
        const ptOffset = pointsOffset + i * 16;
        const x = view.getFloat64(ptOffset, true);
        const y = view.getFloat64(ptOffset + 8, true);

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
          points.push({ lat, lng });
        } else {
          const prev = points[points.length - 1];
          const distSq = Math.pow(lat - prev.lat, 2) + Math.pow(lng - prev.lng, 2);
          if (distSq > 1e-12) {
            points.push({ lat, lng });
          }
        }
      }
    }

    offset = recordEnd;
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

      polylinePoints = points.map(p => L.latLng(p.lat, p.lng));
      
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

  const layers = profile.soil_layers || [];
  
  // Calculate total thickness for relative layer sizes
  const totalThickness = layers.reduce((acc, layer) => acc + (layer.top - layer.bottom), 0);

  // Generate visual segments and legend items
  let segmentsHtml = '';
  const legendItemsMap: Record<string, string> = {};

  layers.forEach((layer) => {
    const thickness = layer.top - layer.bottom;
    const heightPercent = totalThickness > 0 ? (thickness / totalThickness) * 100 : 0;
    const color = soilColors[layer.soil_code] || '#808080';
    
    legendItemsMap[layer.soil_code] = color;
    const displayName = layer.soil_code.replace(/_/g, ' ');

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

  const popupHtml = `
    <div class="cpt-popup">
      <div class="cpt-popup-header">
        <h4>CPT: ${cpt.cpt_name}</h4>
        <button class="cpt-delete-btn" title="Remove CPT from project">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="3 6 5 6 21 6"></polyline>
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
          </svg>
        </button>
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

  // Place marker and bind popup
  const marker = L.marker([wgs.lat, wgs.lng], { icon: customIcon }).addTo(map);
  marker.bindPopup(popupHtml, {
    maxWidth: 320
  });

  // Attach event listener to delete button when popup is opened
  marker.on('popupopen', () => {
    const popupEl = marker.getPopup()?.getElement();
    if (popupEl) {
      const deleteBtn = popupEl.querySelector('.cpt-delete-btn');
      if (deleteBtn) {
        deleteBtn.addEventListener('click', () => {
          if (confirm(`Are you sure you want to remove CPT ${cpt.cpt_name} from the project?`)) {
            removeCpt(cpt, marker);
          }
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

btnGenerateVoxel.addEventListener('click', async () => {
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
  voxelModelViewer.style.display = 'block';
  btnResetView.style.display = 'block';
  btnDownloadGlb.style.display = 'block';

  // Show the loader overlay
  loadingOverlay.classList.add('active');

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
      let minZ = Infinity;
      let maxZ = -Infinity;
      cptsInside.forEach((cpt) => {
        (cpt.soil_profile.soil_layers || []).forEach((layer) => {
          if (layer.bottom < minZ) minZ = layer.bottom;
          if (layer.top > maxZ) maxZ = layer.top;
        });
      });

      if (minZ === Infinity || maxZ === -Infinity) {
        throw new Error('Could not compute Z boundaries from CPTs in the area.');
      }

      // 5. Centering coordinates around 0,0,0
      const xCenter = (xMin + xMax) / 2;
      const yCenter = (yMin + yMax) / 2;
      const zCenter = (minZ + maxZ) / 2;

      // Apply translations and rounding (no offsets added)
      const x_min = Math.round(xMin - xCenter);
      const x_max = Math.round(xMax - xCenter);
      const y_min = Math.round(yMin - yCenter);
      const y_max = Math.round(yMax - yCenter);
      const z_min = Math.round(minZ - zCenter);
      const z_max = Math.round(maxZ - zCenter);

      // Center each CPT's coordinates and its soil layers:
      const soilProfilesPayload = cptsInside.map((cpt) => {
        const prof = cpt.soil_profile;
        return {
          x: prof.x - xCenter,
          y: prof.y - yCenter,
          soil_layers: (prof.soil_layers || []).map((layer) => ({
            top: layer.top - zCenter,
            bottom: layer.bottom - zCenter,
            soil_code: layer.soil_code
          }))
        };
      });

      // 6. Construct the API payload
      const payload = {
        soil_profiles: soilProfilesPayload,
        x_min,
        x_max,
        dx: 5,
        y_min,
        y_max,
        dy: 5,
        z_min,
        z_max,
        dz: 1.0,
        anisotropy_ratio: 50,
        step_size: 0.5,
        soil_colors: soilColors
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
      // Convert points to RD coordinates
      const rdPoints = polylinePoints.map(pt => wgs84ToRd(pt.lat, pt.lng));

      // Calculate total chainage
      let totalChainage = 0;
      for (let i = 1; i < rdPoints.length; i++) {
        const p1 = rdPoints[i - 1];
        const p2 = rdPoints[i];
        totalChainage += Math.sqrt((p2.x - p1.x) ** 2 + (p2.y - p1.y) ** 2);
      }

      // Find xCenter and yCenter of the reference line
      let minRDX = Infinity;
      let maxRDX = -Infinity;
      let minRDY = Infinity;
      let maxRDY = -Infinity;
      rdPoints.forEach(pt => {
        if (pt.x < minRDX) minRDX = pt.x;
        if (pt.x > maxRDX) maxRDX = pt.x;
        if (pt.y < minRDY) minRDY = pt.y;
        if (pt.y > maxRDY) maxRDY = pt.y;
      });
      const xCenter = (minRDX + maxRDX) / 2;
      const yCenter = (minRDY + maxRDY) / 2;

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

      const zCenter = (minZ + maxZ) / 2;

      // Center reference line points
      const centeredReferenceLine = rdPoints.map(pt => [pt.x - xCenter, pt.y - yCenter]);

      // Project each CPT onto the reference line (original, to match coordinates)
      const soilProfilesPayload = uploadedCpts.map((cpt) => {
        const prof = cpt.soil_profile;
        const proj = projectPointToPolyline({ x: prof.x, y: prof.y }, rdPoints);
        return {
          x: proj.chainage,
          y: 0.0,
          soil_layers: (prof.soil_layers || []).map((layer) => ({
            top: layer.top - zCenter,
            bottom: layer.bottom - zCenter,
            soil_code: layer.soil_code
          }))
        };
      });

      // Construct the 2D API payload
      const payload = {
        soil_profiles: soilProfilesPayload,
        x_min: 0,
        x_max: Math.round(totalChainage),
        dx: 5.0,
        z_min: Math.round(minZ - zCenter),
        z_max: Math.round(maxZ - zCenter),
        dz: 0.25,
        anisotropy_ratio: 50,
        step_size: 0.5,
        reference_line: {
          points: centeredReferenceLine
        },
        soil_colors: soilColors
      };

      console.log('Sending 2D GLB export request payload:', payload);

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

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Server returned status ${response.status}. ${errText}`);
    }

    const blob = await response.blob();
    
    // Revoke previous URL if any to prevent memory leak
    if (voxelModelViewer.src) {
      URL.revokeObjectURL(voxelModelViewer.src);
    }
    
    const modelUrl = URL.createObjectURL(blob);

    // Update model viewer source
    voxelModelViewer.src = modelUrl;

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
  voxelModelViewer.style.display = 'none';
  btnResetView.style.display = 'none';
  btnDownloadGlb.style.display = 'none';
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

  // Compute segments and total polyline length
  let totalChainage = 0;
  for (let i = 1; i < rdPoints.length; i++) {
    const dx = rdPoints[i].x - rdPoints[i - 1].x;
    const dy = rdPoints[i].y - rdPoints[i - 1].y;
    totalChainage += Math.sqrt(dx * dx + dy * dy);
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
      const color = soilColors[layer.soil_code] || '#808080';
      const displayName = layer.soil_code.replace(/_/g, ' ');

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
      presentSoilCodes.add(layer.soil_code);
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
}

// Helper to reset custom split heights
function resetSplitHeights() {
  mapContainer.style.height = '';
  viewerContainer.style.height = '';
}

// Close viewer and clean up resources
btnCloseViewer.addEventListener('click', () => {
  appContainer.classList.remove('split-active');
  resetSplitHeights();
  viewerLayersPanel.classList.remove('active');
  viewerLayersList.innerHTML = '';
  
  if (voxelModelViewer.src) {
    URL.revokeObjectURL(voxelModelViewer.src);
    voxelModelViewer.removeAttribute('src');
  }

  // Close and reset 2D view state
  profile2dView.style.display = 'none';
  voxelModelViewer.style.display = 'block';
  btnResetView.style.display = 'block';
  btnDownloadGlb.style.display = 'block';
  
  setTimeout(() => {
    map.invalidateSize();
  }, 500);
});

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

// Download BRO CPT data along polyline
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

    // 2. Fetch CPT metadata along the polyline from BRO
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

    if (!metadataResponse.ok) {
      const errText = await metadataResponse.text();
      throw new Error(`Failed to fetch BRO CPT metadata: ${metadataResponse.status}. ${errText}`);
    }

    const metadataData = await metadataResponse.json();
    const characteristics = metadataData.cpt_characteristics || [];

    if (characteristics.length === 0) {
      alert('No BRO CPTs found near the active polyline.');
      return;
    }

    console.log(`Found ${characteristics.length} CPTs from BRO:`, characteristics);

    // 3. For each BRO ID, retrieve CPT interpretation
    let successCount = 0;
    let skipCount = 0;

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
        skipCount++;
        continue;
      }

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
          minimum_layerheight: 0.5,
          peat_friction_ratio: 6
        })
      });

      if (!interpResponse.ok) {
        console.warn(`Failed to fetch interpretation for ${broId}: ${interpResponse.status}`);
        continue;
      }

      const data: CptData = await interpResponse.json();
      (data as any).filename = fileName;
      uploadedCpts.push(data);
      uploadedFilenames.add(fileName);
      addCptMarker(data);
      successCount++;
    }

    alert(`Successfully imported ${successCount} BRO CPTs.${skipCount > 0 ? ` (Skipped ${skipCount} duplicates)` : ''}`);
    
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
  const modelUrl = voxelModelViewer.src;
  if (!modelUrl) return;

  const a = document.createElement('a');
  a.href = modelUrl;
  a.download = 'voxel_model.glb';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
});

// Reset viewpoint and zoom of the 3D model viewer
btnResetView.addEventListener('click', () => {
  if (!voxelModelViewer.src) return;

  // Reset orbit, target and field of view to automatic defaults
  voxelModelViewer.cameraOrbit = 'auto auto auto';
  voxelModelViewer.cameraTarget = 'auto auto auto';
  voxelModelViewer.fieldOfView = 'auto';

  // Jump camera directly to goals
  if (typeof voxelModelViewer.jumpToGoal === 'function') {
    voxelModelViewer.jumpToGoal();
  }
});

// Dynamically build checkboxes to toggle soil layers on load
voxelModelViewer.addEventListener('load', () => {
  // Clear previous layers list
  viewerLayersList.innerHTML = '';

  // Access the internal Three.js scene Symbol
  const sceneSym = Object.getOwnPropertySymbols(voxelModelViewer).find(
    (x) => x.description === "scene"
  );
  if (!sceneSym) return;
  const scene = voxelModelViewer[sceneSym];
  if (!scene) return;

  // Find the glTF root scene group inside the Three.js scene children
  const gltfRoot = scene.children.find((child: any) => child.type === 'Group' || child.name === 'Scene');
  const layers: { name: string; node: any }[] = [];

  if (gltfRoot && gltfRoot.children) {
    gltfRoot.children.forEach((child: any) => {
      if (child.name && !layers.some(l => l.name === child.name)) {
        layers.push({ name: child.name, node: child });
      }
    });
  }

  // Fallback: recursively search the entire scene graph for layer nodes
  if (layers.length === 0) {
    scene.traverse((child: any) => {
      if (child.name && (child.name in defaultSoilColors || child.name.startsWith("Soil_"))) {
        if (!layers.some(l => l.name === child.name)) {
          layers.push({ name: child.name, node: child });
        }
      }
    });
  }

  // Sort layers alphabetically
  layers.sort((a, b) => a.name.localeCompare(b.name));

  console.log('GLB model loaded. Found layers:', layers.map(l => l.name));

  if (layers.length > 0) {
    // Show the panel
    viewerLayersPanel.classList.add('active');

    // Create a checkbox for each layer
    layers.forEach(({ name, node }) => {
      // Find the color from our color map (defaulting to defaultSoilColors)
      const color = defaultSoilColors[name] || '#808080';
      const displayName = name.replace(/_/g, ' ');

      const itemEl = document.createElement('label');
      itemEl.className = 'layer-item';

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = node.visible !== false;

      // Event listener to toggle visibility of the node in three.js
      checkbox.addEventListener('change', () => {
        node.visible = checkbox.checked;

        // 1. Force a WebGL redraw by slightly toggling shadow-intensity
        const currentShadow = voxelModelViewer.getAttribute('shadow-intensity') || '1';
        voxelModelViewer.setAttribute('shadow-intensity', currentShadow === '1' ? '0.999' : '1');

        // 2. Nudge camera orbit slightly to invalidate the render cache
        const orbit = voxelModelViewer.getCameraOrbit();
        if (orbit) {
          voxelModelViewer.cameraOrbit = `${orbit.theta + 0.000001}rad ${orbit.phi}rad ${orbit.radius}m`;
        }

        // 3. Find and call the internal needsRender symbol to force redrawing the scene
        const needsRenderSym = Object.getOwnPropertySymbols(voxelModelViewer).find(
          (x) => x.description && x.description.includes("needsRender")
        );
        if (needsRenderSym && typeof voxelModelViewer[needsRenderSym] === 'function') {
          voxelModelViewer[needsRenderSym]();
        }

        // 4. Request LitElement template update
        voxelModelViewer.requestUpdate();
      });

      const colorIndicator = document.createElement('div');
      colorIndicator.className = 'layer-color-indicator';
      colorIndicator.style.backgroundColor = color;

      const labelText = document.createElement('span');
      labelText.className = 'layer-label';
      labelText.textContent = displayName;
      labelText.title = displayName;

      itemEl.appendChild(checkbox);
      itemEl.appendChild(colorIndicator);
      itemEl.appendChild(labelText);

      viewerLayersList.appendChild(itemEl);
    });
  } else {
    viewerLayersPanel.classList.remove('active');
  }
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
          points: polylinePoints.map(pt => ({ lat: pt.lat, lng: pt.lng }))
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

    const projectData = {
      version: '1.0.0',
      uploadedCpts,
      uploadedFilenames: Array.from(uploadedFilenames),
      settings: {
        maxDistance
      },
      drawing
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
    if (projectData.settings && typeof projectData.settings.maxDistance === 'number') {
      if (settingMaxDistance) {
        settingMaxDistance.value = String(projectData.settings.maxDistance);
      }
    }

    if (Array.isArray(projectData.uploadedFilenames)) {
      projectData.uploadedFilenames.forEach((fn: string) => {
        uploadedFilenames.add(fn);
      });
    }

    // 3. Re-populate CPTs
    projectData.uploadedCpts.forEach((cpt: CptData) => {
      uploadedCpts.push(cpt);
      addCptMarker(cpt);
    });

    // 4. Reconstruct drawings
    if (projectData.drawing) {
      const dw = projectData.drawing;
      if (dw.type === 'polyline' && Array.isArray(dw.points)) {
        polylinePoints = dw.points.map((p: { lat: number; lng: number }) => L.latLng(p.lat, p.lng));
        
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


