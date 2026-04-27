const API_BASE_RAW = import.meta.env.VITE_API_BASE || '/api';

const resolveApiBase = () => {
  if (API_BASE_RAW.startsWith('http://') || API_BASE_RAW.startsWith('https://')) {
    return API_BASE_RAW;
  }
  if (typeof window === 'undefined') {
    return API_BASE_RAW;
  }
  if (!API_BASE_RAW.startsWith('/')) {
    return API_BASE_RAW;
  }
  const segments = window.location.pathname.split('/').filter(Boolean);
  if (segments.length === 0) {
    return API_BASE_RAW;
  }
  if (segments[0] === 'admin') {
    return API_BASE_RAW;
  }
  const prefix = `/${segments[0]}`;
  if (API_BASE_RAW === prefix || API_BASE_RAW.startsWith(`${prefix}/`)) {
    return API_BASE_RAW;
  }
  return `${prefix}${API_BASE_RAW}`;
};

const API_BASE = resolveApiBase();

const buildUrl = (path: string) => {
  if (path.startsWith('http://') || path.startsWith('https://')) return path;
  const base = API_BASE.replace(/\/+$/, '');
  const suffix = path.startsWith('/') ? path : `/${path}`;
  return `${base}${suffix}`;
};

const getCompanyIdHeader = (): string | null => {
  if (typeof window === 'undefined') return null;
  const isAdminRoute = window.location.pathname.startsWith('/admin');

  if (isAdminRoute) {
    try {
      const raw = localStorage.getItem('pg_admin_auth');
      if (raw) {
        const parsed = JSON.parse(raw);
        const companyId = Number(parsed?.companyId);
        if (Number.isFinite(companyId) && companyId > 0) {
          return String(companyId);
        }
      }
    } catch {
      // ignore
    }
    return null;
  }

  try {
    const rawStudent = localStorage.getItem('pg_student_company');
    if (rawStudent) {
      const companyId = Number(rawStudent);
      if (Number.isFinite(companyId) && companyId > 0) {
        return String(companyId);
      }
    }
  } catch {
    // ignore
  }
  return null;
};

const getAdminAuthValue = (key: string): string | null => {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem('pg_admin_auth');
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const value = parsed?.[key];
    if (value === null || value === undefined || value === '') return null;
    return String(value);
  } catch {
    return null;
  }
};

const buildHeaders = (base?: HeadersInit) => {
  const headers = new Headers(base || {});
  const companyId = getCompanyIdHeader();
  if (companyId) {
    headers.set('X-Company-Id', companyId);
  }
  const isAdminRoute = typeof window !== 'undefined' && window.location.pathname.startsWith('/admin');
  const role = getAdminAuthValue('role') || (isAdminRoute ? 'ADMIN' : null);
  if (role) {
    headers.set('X-User-Role', role);
  }
  const actorId = getAdminAuthValue('email') || getAdminAuthValue('name') || getAdminAuthValue('userId');
  if (actorId) {
    headers.set('X-Actor-Id', actorId);
  }
  return headers;
};

export const apiGet = async <T,>(path: string): Promise<T> => {
  const res = await fetch(buildUrl(path), { method: 'GET', headers: buildHeaders() });
  const text = await res.text();
  const body = text.trim();
  if (!res.ok) {
    throw new Error(body || `API GET failed: ${res.status}`);
  }
  try {
    return JSON.parse(body) as T;
  } catch {
    throw new Error(body || 'API GET failed: Invalid JSON response.');
  }
};

export const apiPost = async <T,>(path: string, body: unknown): Promise<T> => {
  const res = await fetch(buildUrl(path), {
    method: 'POST',
    headers: buildHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `API POST failed: ${res.status}`);
  }
  return res.json() as Promise<T>;
};

export const apiPostForm = async <T,>(path: string, formData: FormData): Promise<T> => {
  const res = await fetch(buildUrl(path), {
    method: 'POST',
    headers: buildHeaders(),
    body: formData,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `API POST form failed: ${res.status}`);
  }
  return res.json() as Promise<T>;
};
