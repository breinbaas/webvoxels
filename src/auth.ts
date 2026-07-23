interface AuthUser {
  email: string;
  role: string;
}

const API_URL = (import.meta.env.VITE_API_URL as string) || 'http://127.0.0.1:8000';
const API_KEY = (import.meta.env.VITE_API_KEY as string) || 'key_frontend_987654321';

const STORAGE_KEY = 'webvoxel_auth_user';

const loginOverlay = document.getElementById('login-overlay') as HTMLDivElement;
const loginForm = document.getElementById('login-form') as HTMLFormElement;
const loginEmail = document.getElementById('login-email') as HTMLInputElement;
const loginPassword = document.getElementById('login-password') as HTMLInputElement;
const loginError = document.getElementById('login-error') as HTMLParagraphElement;
const loginSubmit = document.getElementById('login-submit') as HTMLButtonElement;
const btnSignout = document.getElementById('btn-signout') as HTMLButtonElement;

async function login(email: string, password: string): Promise<AuthUser> {
  const response = await fetch(`${API_URL}/api/auth/login`, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'Content-Type': 'application/json',
      'X-API-Key': API_KEY
    },
    body: JSON.stringify({ email, password })
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.detail || 'Invalid email or password');
  }
  return data as AuthUser;
}

export function getCurrentUser(): AuthUser | null {
  const raw = sessionStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as AuthUser;
  } catch {
    return null;
  }
}

function showApp(): void {
  loginOverlay.classList.remove('active');
}

function showLogin(): void {
  loginOverlay.classList.add('active');
  loginEmail.focus();
}

if (getCurrentUser()) {
  showApp();
}

btnSignout.addEventListener('click', () => {
  sessionStorage.removeItem(STORAGE_KEY);
  showLogin();
});

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = loginEmail.value.trim();
  const password = loginPassword.value;

  loginSubmit.disabled = true;
  loginSubmit.textContent = 'Logging in...';
  loginError.textContent = '';

  try {
    const user = await login(email, password);
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(user));
    loginForm.reset();
    showApp();
  } catch (err) {
    loginError.textContent = err instanceof Error ? err.message : 'Invalid email or password';
    loginPassword.value = '';
    loginPassword.focus();
  } finally {
    loginSubmit.disabled = false;
    loginSubmit.textContent = 'Log in';
  }
});
