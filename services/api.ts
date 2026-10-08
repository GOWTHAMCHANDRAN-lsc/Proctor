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
        // A SUPER_ADMIN is not pinned to a single company — the global company switcher stores the
        // company they are currently acting on. That selection scopes every screen (dashboard,
        // exams, students, monitoring, results, recordings, security, audit) via this header.
        // Only honoured for SUPER_ADMIN so a regular admin can never widen its own scope.
        if (String(parsed?.role || '').toUpperCase() === 'SUPER_ADMIN') {
          const override = Number(localStorage.getItem('pg_admin_active_company'));
          if (Number.isFinite(override) && override > 0) {
            return String(override);
          }
        }
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
  // Signed session token minted by the server at login. This — not the X-User-Role/X-Company-Id
  // headers — is what authorizes privileged requests once token enforcement is on.
  const authToken = getAdminAuthValue('token');
  // Student exam-access token: the signed grant for the exam-taking page. On that page (not
  // /admin), this must ALWAYS win over any admin token — a staff member testing/proctoring from
  // the same browser they're logged into the admin panel with would otherwise silently send their
  // (possibly stale, wrong-company, or since-expired) admin session instead of the exam token, which
  // hits the staff-only code path and 401s a perfectly valid student link. The two tokens are scoped
  // to two completely separate UI contexts and must never bleed into each other.
  const examToken = typeof window !== 'undefined' ? localStorage.getItem('pg_student_exam_token') : null;
  if (!isAdminRoute && examToken) {
    headers.set('X-Exam-Token', examToken);
  } else if (authToken) {
    headers.set('X-Auth-Token', authToken);
  } else if (examToken) {
    headers.set('X-Exam-Token', examToken);
  }
  return headers;
};

// When the server rejects our session (missing/expired/invalid token) on an admin screen, drop the
// stale session and bounce back to the login screen so the user can re-authenticate.
//
// This must NOT hard-reload: a hard reload on every 401 creates a reload LOOP whenever a login
// stores a token the server won't accept (e.g. an empty token, or a session minted before this
// deploy) — the app boots "authed", fires data calls, gets 401, reloads, and repeats forever.
// Instead we clear the session and dispatch a one-shot event that App handles with a soft React
// logout (render the login screen, no navigation). The one-shot guard means concurrent 401s from a
// burst of parallel requests collapse into a single logout, and we never fire again until the user
// re-authenticates (which resets the guard on the next successful login-driven reload of state).
let authExpiryHandled = false;

const handleAuthExpiry = (status: number) => {
  if (status !== 401) return;
  if (typeof window === 'undefined') return;
  if (!window.location.pathname.startsWith('/admin')) return;
  if (authExpiryHandled) return;
  authExpiryHandled = true;
  try {
    localStorage.removeItem('pg_admin_auth');
    localStorage.removeItem('pg_admin_authed');
    localStorage.removeItem('pg_admin_session');
    localStorage.removeItem('pg_admin_active_company');
  } catch {
    // ignore
  }
  try {
    window.dispatchEvent(new CustomEvent('pg:auth-expired'));
  } catch {
    // ignore
  }
};

// Allow the app to re-arm the expiry handler after a fresh login so a later genuine expiry is
// caught again within the same page load.
export const resetAuthExpiryGuard = () => {
  authExpiryHandled = false;
};

// Error thrown by the api helpers. `message` deliberately stays the raw response body — callers
// JSON.parse it to read structured error codes (e.g. ACCESS_REQUEST_REQUIRED) — with the HTTP
// `status` attached (0 = the request never reached the server). Use getApiErrorMessage() to turn
// one into text that is safe to show a user.
export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

// fetch() only rejects when the request never got a response (offline, DNS, CORS, connection
// reset). Browsers report that as a bare "Failed to fetch" / "Load failed", which the UI used to
// show verbatim — replace it with something a user can act on.
const send = async (url: string, init: RequestInit): Promise<Response> => {
  try {
    return await fetch(url, init);
  } catch (e) {
    const err = new ApiError('Network error: could not reach the server. Check your internet connection and try again.', 0);
    (err as any).cause = e;
    throw err;
  }
};

// Proxy/gateway errors (nginx 502/504 while PHP-FPM restarts, 413 for an oversized upload) and
// PHP fatals come back as an HTML page, not JSON. Never surface a whole HTML document as an error
// message — summarise it instead. JSON / plain-text bodies pass through untouched.
const looksLikeHtml = (body: string) => /^<(!doctype|html|head|body|center|h1|br|b)\b/i.test(body);

const errorBodyText = (body: string, label: string, status: number): string => {
  if (!body) return `${label} failed: ${status}`;
  if (looksLikeHtml(body)) {
    if (status === 413) return 'The upload is too large for the server (HTTP 413).';
    return `Server error (HTTP ${status}). Please try again in a moment.`;
  }
  return body;
};

const parseJsonResponse = async <T,>(res: Response, label: string): Promise<T> => {
  const body = (await res.text()).trim();
  if (!res.ok) {
    handleAuthExpiry(res.status);
    throw new ApiError(errorBodyText(body, label, res.status), res.status);
  }
  try {
    return JSON.parse(body) as T;
  } catch {
    if (looksLikeHtml(body)) {
      throw new ApiError('Unexpected response from the server. Please try again.', res.status);
    }
    throw new ApiError(body || `${label} failed: Invalid JSON response.`, res.status);
  }
};

export const apiGet = async <T,>(path: string): Promise<T> => {
  const res = await send(buildUrl(path), { method: 'GET', headers: buildHeaders() });
  return parseJsonResponse<T>(res, 'API GET');
};

export const apiPost = async <T,>(path: string, body: unknown): Promise<T> => {
  const res = await send(buildUrl(path), {
    method: 'POST',
    headers: buildHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
  });
  return parseJsonResponse<T>(res, 'API POST');
};

export const apiPostForm = async <T,>(path: string, formData: FormData): Promise<T> => {
  const res = await send(buildUrl(path), {
    method: 'POST',
    headers: buildHeaders(),
    body: formData,
  });
  return parseJsonResponse<T>(res, 'API POST form');
};

// Human-readable text for an error thrown by the helpers above. Server errors arrive as JSON
// bodies such as {"error":"Email already exists"} or {"error":"CODE","message":"Readable text"};
// showing e.message directly puts raw JSON in front of the user.
export const getApiErrorMessage = (error: unknown, fallback = 'Something went wrong. Please try again.'): string => {
  const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  const text = String(raw || '').trim();
  if (!text) return fallback;
  if (text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text);
      const readable = [parsed?.message, parsed?.error].find(v => typeof v === 'string' && v.trim() !== '');
      return readable ? String(readable).trim() : fallback;
    } catch {
      // not JSON — show the text as-is
    }
  }
  return text;
};
