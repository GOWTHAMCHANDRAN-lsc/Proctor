import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Layout } from './components/Layout';
import { Dashboard } from './components/admin/Dashboard';
import { ExamManager } from './components/admin/ExamManager';
import { StudentManager } from './components/admin/StudentManager';
import { Monitoring } from './components/admin/Monitoring';
import { SecurityFeed } from './components/admin/SecurityFeed';
import { Recordings } from './components/admin/Recordings';
import { LiveProctoring } from './components/admin/LiveProctoring';
import { Integrations } from './components/admin/Integrations';
import { Certificates } from './components/admin/Certificates';
import { Communications } from './components/admin/Communications';
import { Results } from './components/admin/Results';
import { ActivityLogs } from './components/admin/ActivityLogs';
import { UserDirectory } from './components/admin/UserDirectory';
import { SuperAdminControl } from './components/admin/SuperAdminControl';
import { Settings } from './components/admin/Settings';
import { SettingsProvider, useSettings } from './services/appSettings';
import { ExamTake } from './components/student/ExamTake';
import { ExamResult } from './components/student/ExamResult';
import { ErrorBoundary } from './components/ErrorBoundary';
import { UserRole, Exam, Student, ViolationLog, Question, ExamSession } from './types';
import { MOCK_EXAMS, MOCK_STUDENTS, MOCK_SESSIONS } from './services/mockStore';
import { ArrowRight, KeyRound, AlertCircle } from 'lucide-react';
import { apiGet, apiPost, resetAuthExpiryGuard, getApiErrorMessage, ApiError } from './services/api';
import { resolveExamTimezone, formatScheduleShort } from './services/timezone';

const ADMIN_SESSION_KEY = 'pg_admin_session';
const ADMIN_SESSION_LEGACY_KEY = 'pg_admin_authed';
const ADMIN_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const ADMIN_AUTH_STORAGE_KEY = 'pg_admin_auth';
const STUDENT_COMPANY_STORAGE_KEY = 'pg_student_company';
const STUDENT_EXAM_TOKEN_KEY = 'pg_student_exam_token';
const ADMIN_ACTIVE_COMPANY_KEY = 'pg_admin_active_company';
const SUPER_ADMIN_EMAILS = new Set(
  String(import.meta.env.VITE_SUPER_ADMIN_EMAILS || '')
    .split(',')
    .map(email => email.trim().toLowerCase())
    .filter(Boolean)
);

const getStoredAdminSession = () => {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem(ADMIN_SESSION_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.startedAt === 'number') {
        return parsed.startedAt as number;
      }
    }
    if (localStorage.getItem(ADMIN_SESSION_LEGACY_KEY) === '1') {
      return Date.now();
    }
    return null;
  } catch {
    return null;
  }
};

const storeAdminSession = (startedAt: number) => {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(ADMIN_SESSION_KEY, JSON.stringify({ startedAt }));
    localStorage.setItem(ADMIN_SESSION_LEGACY_KEY, '1');
  } catch {
    // ignore storage errors
  }
};

const storeAdminAuth = (payload: {
  token: string;
  name?: string;
  email?: string;
  userId?: number;
  companyId?: number;
  companyName?: string;
  systemId?: string | number;
  role?: UserRole;
}) => {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(ADMIN_AUTH_STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // ignore storage errors
  }
};

const isSuperAdminEmail = (value: unknown) => {
  const email = String(value || '').trim().toLowerCase();
  return email !== '' && SUPER_ADMIN_EMAILS.has(email);
};

// Roles that can sign in to the staff console (everything except STUDENT).
type AdminConsoleRole = UserRole.ADMIN | UserRole.SUPER_ADMIN | UserRole.PROCTOR | UserRole.VIEWER;

const normalizeAdminRole = (value: unknown): AdminConsoleRole => {
  const role = String(value || '').trim().toUpperCase();
  if (role === UserRole.SUPER_ADMIN) return UserRole.SUPER_ADMIN;
  if (role === 'PROCTOR') return UserRole.PROCTOR;
  if (role === 'VIEWER') return UserRole.VIEWER;
  return UserRole.ADMIN;
};

const getStoredAdminRole = (): AdminConsoleRole => {
  if (typeof window === 'undefined') return UserRole.ADMIN;
  try {
    const raw = localStorage.getItem(ADMIN_AUTH_STORAGE_KEY);
    if (!raw) return UserRole.ADMIN;
    const parsed = JSON.parse(raw);
    return normalizeAdminRole(parsed?.role);
  } catch {
    return UserRole.ADMIN;
  }
};

const clearAdminSession = () => {
  if (typeof window === 'undefined') return;
  try {
    localStorage.removeItem(ADMIN_SESSION_KEY);
    localStorage.removeItem(ADMIN_SESSION_LEGACY_KEY);
    localStorage.removeItem(ADMIN_AUTH_STORAGE_KEY);
    localStorage.removeItem(ADMIN_ACTIVE_COMPANY_KEY);
  } catch {
    // ignore storage errors
  }
};

const getStoredActiveCompanyId = (): number | null => {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem(ADMIN_ACTIVE_COMPANY_KEY);
    if (!raw) return null;
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  } catch {
    return null;
  }
};

const storeActiveCompanyId = (companyId: number | null) => {
  if (typeof window === 'undefined') return;
  try {
    if (companyId && companyId > 0) {
      localStorage.setItem(ADMIN_ACTIVE_COMPANY_KEY, String(companyId));
    } else {
      localStorage.removeItem(ADMIN_ACTIVE_COMPANY_KEY);
    }
  } catch {
    // ignore storage errors
  }
};

const getStoredStudentCompanyId = () => {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem(STUDENT_COMPANY_STORAGE_KEY);
    if (!raw) return null;
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  } catch {
    return null;
  }
};

const storeStudentCompanyId = (companyId: number | null) => {
  if (typeof window === 'undefined') return;
  try {
    if (companyId && companyId > 0) {
      localStorage.setItem(STUDENT_COMPANY_STORAGE_KEY, String(companyId));
    } else {
      localStorage.removeItem(STUDENT_COMPANY_STORAGE_KEY);
    }
  } catch {
    // ignore storage errors
  }
};

const storeStudentExamToken = (token: string | null) => {
  if (typeof window === 'undefined') return;
  try {
    if (token) {
      localStorage.setItem(STUDENT_EXAM_TOKEN_KEY, token);
    } else {
      localStorage.removeItem(STUDENT_EXAM_TOKEN_KEY);
    }
  } catch {
    // ignore storage errors
  }
};

const buildFingerprintSource = () => {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
  const deviceMemory = (navigator as any).deviceMemory || '';
  return [
    navigator.userAgent,
    navigator.language,
    navigator.platform,
    navigator.hardwareConcurrency,
    deviceMemory,
    screen.width,
    screen.height,
    screen.colorDepth,
    timezone,
  ].join('|');
};

const buildDeviceMetadata = () => {
  const navAny = navigator as any;
  return {
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    language: navigator.language,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || '',
    screen: `${screen.width}x${screen.height}x${screen.colorDepth}`,
    hardwareConcurrency: navigator.hardwareConcurrency || null,
    deviceMemory: navAny.deviceMemory || null,
    touchPoints: navigator.maxTouchPoints || 0,
  };
};

const simpleHash = (input: string) => {
  let hash = 5381;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash * 33) ^ input.charCodeAt(i);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
};

const hashString = async (input: string) => {
  if (window.crypto?.subtle) {
    const data = new TextEncoder().encode(input);
    const digest = await window.crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(digest))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  }
  return simpleHash(input);
};

const getDeviceFingerprint = async () => {
  const source = buildFingerprintSource();
  return hashString(source);
};

const getGeoLocation = async (): Promise<{ label: string; lat: number | null; lng: number | null; accuracy: number | null }> => {
  if (!navigator.geolocation) {
    return { label: 'Location unavailable', lat: null, lng: null, accuracy: null };
  }

  return new Promise(resolve => {
    const timeout = window.setTimeout(() => {
      resolve({ label: 'Location permission timeout', lat: null, lng: null, accuracy: null });
    }, 6000);

    navigator.geolocation.getCurrentPosition(
      position => {
        window.clearTimeout(timeout);
        const lat = Number(position.coords.latitude.toFixed(6));
        const lng = Number(position.coords.longitude.toFixed(6));
        const accuracy = Math.round(position.coords.accuracy || 0);
        resolve({
          label: `${lat}, ${lng} (${accuracy}m accuracy)`,
          lat,
          lng,
          accuracy,
        });
      },
      () => {
        window.clearTimeout(timeout);
        resolve({ label: 'Location permission denied', lat: null, lng: null, accuracy: null });
      },
      { enableHighAccuracy: true, maximumAge: 30000, timeout: 5500 }
    );
  });
};

// Get local IP address via WebRTC for device binding
// This serves as a unique identifier for the device/network
const getMacAddress = async (): Promise<string | null> => {
  try {
    const pc = new RTCPeerConnection({ iceServers: [] });
    
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        pc.close();
        resolve(null);
      }, 3000);

      pc.createDataChannel('');
      // A rejected offer used to surface as an unhandled promise rejection; the 3s timeout still
      // resolves null in that case.
      pc.createOffer().then(offer => pc.setLocalDescription(offer)).catch(() => {});

      pc.onicecandidate = (event) => {
        if (!event.candidate) {
          // ICE gathering finished without a usable IPv4 candidate (modern browsers hide host IPs
          // behind mDNS names). Stop now instead of stalling "Start Test" for the full 3s timeout.
          clearTimeout(timeout);
          pc.close();
          resolve(null);
          return;
        }
        if (event.candidate) {
          const candidate = event.candidate.candidate;
          const match = candidate.match(/(\d+\.\d+\.\d+\.\d+)/);
          if (match) {
            clearTimeout(timeout);
            pc.close();
            // Return IP as MAC-like identifier for binding
            // Format: XX:XX:XX:XX:XX:XX derived from IP
            const ipParts = match[1].split('.');
            const macLike = ipParts.map(p => parseInt(p).toString(16).padStart(2, '0').toUpperCase()).join(':');
            resolve(macLike);
          }
        }
      };
    });
  } catch {
    return null;
  }
};

const parseApiErrorPayload = (message: string) => {
  if (!message) return null;
  try {
    const parsed = JSON.parse(message);
    return typeof parsed === 'object' && parsed ? parsed : null;
  } catch {
    return null;
  }
};

const buildPreStartInstructions = (exam: Exam): string[] => {
  const lines: string[] = [];
  const proctor = exam.proctoringConfig || {
    cameraRequired: false,
    microphoneRequired: false,
    fullScreenEnforced: false,
    tabSwitchLimit: 0,
  };
  const tabSwitchLimit = Math.max(0, Number(proctor.tabSwitchLimit ?? 0));
  const violationLimits: Record<string, number | undefined> = proctor.violationLimits || {};

  lines.push(`Read all questions carefully. You have ${exam.durationMinutes} minutes to complete this exam.`);
  if (proctor.cameraRequired) {
    lines.push('Keep your face visible in the camera throughout the exam.');
  }
  if (proctor.microphoneRequired) {
    lines.push('Keep your microphone enabled. Mild room noise is tolerated, but speaking or conversation can trigger a violation.');
  }
  if (proctor.fullScreenEnforced) {
    lines.push('Fullscreen mode is mandatory during the exam.');
  }
  if (tabSwitchLimit > 0) {
    lines.push(`Do not switch tabs repeatedly. Maximum allowed tab switches: ${tabSwitchLimit}.`);
  }
  if (Number(violationLimits.camera ?? 0) > 0) {
    lines.push(`Camera violations allowed: ${Number(violationLimits.camera)}.`);
  }
  if (Number(violationLimits.microphone ?? 0) > 0) {
    lines.push(`Microphone violations allowed: ${Number(violationLimits.microphone)}.`);
  }
  if (Number(violationLimits.fullscreen ?? 0) > 0) {
    lines.push(`Fullscreen violations allowed: ${Number(violationLimits.fullscreen)}.`);
  }
  if (Number(violationLimits.copyPaste ?? 0) > 0) {
    lines.push(`Copy/paste violations allowed: ${Number(violationLimits.copyPaste)}.`);
  }

  const examTz = resolveExamTimezone(exam.timezone);
  lines.push(`Exam window: ${formatScheduleShort(exam.startTime, examTz)} to ${formatScheduleShort(exam.endTime, examTz)}.`);
  return lines;
};

const AdminAppInner: React.FC = () => {
  const { settings, syncFromServer } = useSettings();
  const branding = settings.branding;
  const renderBrandMark = (sizeClass: string, textClass: string) => (
    <div className={`${sizeClass} lsc-brand-mark ${textClass} overflow-hidden`}>
      {branding.logoDataUrl
        ? <img src={branding.logoDataUrl} alt="" className="h-full w-full object-contain bg-white" />
        : (branding.shortName || 'LSC')}
    </div>
  );
  const initialSessionStart = getStoredAdminSession();
  const initialAuthed = initialSessionStart !== null && (Date.now() - initialSessionStart) < ADMIN_SESSION_TTL_MS;
  const initialRole = getStoredAdminRole();
  if (initialSessionStart !== null && !initialAuthed) {
    clearAdminSession();
  }
  const [sessionStartedAt, setSessionStartedAt] = useState<number | null>(initialAuthed ? initialSessionStart : null);
  const [isAuthed, setIsAuthed] = useState(initialAuthed);
  const [adminEmail, setAdminEmail] = useState('');
  const [adminPassword, setAdminPassword] = useState('');
  const [adminSystemId] = useState('3');
  const [adminRole, setAdminRole] = useState<AdminConsoleRole>(initialRole);
  const [adminError, setAdminError] = useState('');
  const [adminLoading, setAdminLoading] = useState(false);
  const [currentView, setCurrentView] = useState(initialRole === UserRole.SUPER_ADMIN ? 'platform' : 'dashboard');
  // Super-admin only: the company whose data every screen is currently scoped to. Persisted so it
  // survives reloads and read by the API layer (services/api.ts) as the X-Company-Id header.
  const [activeCompanyId, setActiveCompanyId] = useState<number | null>(
    initialRole === UserRole.SUPER_ADMIN ? getStoredActiveCompanyId() : null
  );
  const [students, setStudents] = useState<Student[]>(MOCK_STUDENTS);
  const [exams, setExams] = useState<Exam[]>(MOCK_EXAMS);
  const [sessions, setSessions] = useState<ExamSession[]>(MOCK_SESSIONS);
  // Set when one of the shared students/exams/sessions loads fails, so the console can say so
  // (instead of silently rendering empty lists / zero counts) and offer a retry.
  const [dataLoadError, setDataLoadError] = useState(false);
  const [dataReloadNonce, setDataReloadNonce] = useState(0);
  // Bumped whenever the data scope is reset (logout / company switch) so an in-flight sessions
  // refresh for the previous scope can't land on top of the new one.
  const scopeGenRef = useRef(0);

  // A SUPER_ADMIN must pick a company before company-scoped data can load (the API requires a
  // company). For a regular admin the company is pinned to their account, so this is always false.
  const scopeReady = adminRole !== UserRole.SUPER_ADMIN || activeCompanyId !== null;

  // Drop the previous account's / company's data. Without this, logging out and back in as a
  // different user (or switching company) kept showing the old company's students, exams and
  // sessions until the new fetch landed — and indefinitely if that fetch failed.
  const clearScopedData = () => {
    scopeGenRef.current += 1;
    setStudents(MOCK_STUDENTS);
    setExams(MOCK_EXAMS);
    setSessions(MOCK_SESSIONS);
    setDataLoadError(false);
  };

  // A 401 is not a "load failed" — the API layer turns it into a soft logout.
  const flagDataLoadError = (e: unknown) => {
    if (e instanceof ApiError && e.status === 401) return;
    setDataLoadError(true);
  };

  useEffect(() => {
    if (!isAuthed || !scopeReady) return;
    let cancelled = false;
    const loadStudents = async () => {
      try {
        const data = await apiGet<{ students: Student[] }>('students.php');
        if (!cancelled && data?.students) {
          setStudents(data.students);
        }
      } catch (e) {
        console.error('Failed to load students from API:', e);
        if (!cancelled) flagDataLoadError(e);
      }
    };
    loadStudents();
    return () => {
      cancelled = true;
    };
  }, [isAuthed, scopeReady, activeCompanyId, dataReloadNonce]);

  useEffect(() => {
    if (!isAuthed || !scopeReady) return;
    let cancelled = false;
    const loadExams = async () => {
      try {
        const data = await apiGet<{ exams: Exam[] }>('exams.php');
        if (!cancelled && data?.exams) {
          setExams(data.exams);
        }
      } catch (e) {
        console.error('Failed to load exams from API:', e);
        if (!cancelled) flagDataLoadError(e);
      }
    };
    loadExams();
    return () => {
      cancelled = true;
    };
  }, [isAuthed, scopeReady, activeCompanyId, dataReloadNonce]);

  const refreshSessions = useCallback(async () => {
    if (!isAuthed || !scopeReady) return;
    const gen = scopeGenRef.current;
    try {
      const data = await apiGet<{ sessions: ExamSession[] }>('sessions.php');
      if (gen !== scopeGenRef.current) return;
      if (data?.sessions) {
        const normalized = data.sessions.map(s => ({
          ...s,
          answers: {},
          violations: [],
        }));
        setSessions(normalized);
      }
    } catch (e) {
      console.error('Failed to load sessions from API:', e);
      if (gen === scopeGenRef.current) flagDataLoadError(e);
    }
  }, [isAuthed, scopeReady, activeCompanyId, dataReloadNonce]);

  useEffect(() => {
    if (!isAuthed) return;
    refreshSessions();
  }, [isAuthed, refreshSessions]);

  const retryDataLoad = () => {
    setDataLoadError(false);
    setDataReloadNonce(n => n + 1);
  };

  const handleLogout = () => {
    setIsAuthed(false);
    setSessionStartedAt(null);
    clearAdminSession();
    setCurrentView('dashboard');
    setAdminRole(UserRole.ADMIN);
    setActiveCompanyId(null);
    storeActiveCompanyId(null);
    clearScopedData();
    // Never leave the password sitting in the sign-in form after logout — on a shared machine the
    // next person could just press "Sign in" again.
    setAdminPassword('');
  };

  // Super-admin global company switch: persist the choice (so the API layer picks it up as the
  // X-Company-Id header) and let the data-loading effects refetch every screen for that company.
  const handleCompanyChange = (companyId: number) => {
    if (companyId === activeCompanyId) return;
    storeActiveCompanyId(companyId);
    clearScopedData();
    setActiveCompanyId(companyId);
  };

  // The API layer clears the stored session and fires this when the server rejects our token (401)
  // on an admin screen. Handle it as a soft logout — flip React state back to the login screen —
  // rather than reloading, which would loop if a login keeps producing a token the server rejects.
  useEffect(() => {
    const onAuthExpired = () => {
      // Reuse the full logout reset (view + role + company + session) so the two paths can't drift,
      // then surface why the user landed back on the login screen.
      handleLogout();
      setAdminError('Your session has expired. Please sign in again.');
    };
    window.addEventListener('pg:auth-expired', onAuthExpired);
    return () => window.removeEventListener('pg:auth-expired', onAuthExpired);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const finalizeAdminSession = (params: {
    token: string;
    name?: string;
    email: string;
    userId?: number;
    companyId?: number;
    companyName?: string;
    systemId?: string | number;
    role: AdminConsoleRole;
  }) => {
    // A fresh, server-verified token is in hand — re-arm the 401 handler so a later genuine expiry
    // is caught again, and don't persist a session with an empty token (that would 401-loop).
    resetAuthExpiryGuard();
    const startedAt = Date.now();
    setIsAuthed(true);
    setSessionStartedAt(startedAt);
    storeAdminSession(startedAt);
    storeAdminAuth(params);
    setAdminRole(params.role);
    setCurrentView(params.role === UserRole.SUPER_ADMIN ? 'platform' : 'dashboard');
    // The password must not outlive the sign-in: it would otherwise still be pre-filled in the
    // login form after the next logout / session expiry.
    setAdminPassword('');
    setDataLoadError(false);
  };

  // Super admins authenticate against the external LSC auth service; company/role are then
  // resolved from OUR database (platform_users), not from the auth response.
  const loginViaExternalAuth = async (email: string) => {
    // The server verifies the credentials against the external LSC auth service and mints OUR signed
    // session token (deriving role/company from our directory). The browser no longer talks to the
    // external service directly, and no privileged role is trusted from the client.
    const res = await apiPost<{
      ok?: boolean;
      error?: string;
      token?: string;
      userId?: number;
      role?: string;
      companyId?: number | null;
      companyName?: string | null;
      fullName?: string;
      email?: string;
    }>('users.php', {
      action: 'EXTERNAL_LOGIN',
      email,
      password: adminPassword,
      systemId: adminSystemId.trim() || '3',
    });

    if (!res?.ok || !res.token) {
      throw new Error(res?.error || 'Invalid email or password.');
    }

    const resolvedEmail = res.email ?? email;
    const role = res.role === 'SUPER_ADMIN' ? UserRole.SUPER_ADMIN : normalizeAdminRole(res.role);
    const companyId = typeof res.companyId === 'number' && res.companyId > 0 ? res.companyId : undefined;

    finalizeAdminSession({
      token: res.token,
      name: res.fullName,
      email: resolvedEmail,
      userId: res.userId,
      companyId,
      companyName: res.companyName ?? undefined,
      role,
    });
  };

  const handleAdminLogin = async (event: React.FormEvent) => {
    event.preventDefault();
    setAdminError('');
    setAdminLoading(true);
    if (!adminEmail.trim() || !adminPassword) {
      setAdminError('Email and password are required.');
      setAdminLoading(false);
      return;
    }

    const email = adminEmail.trim();
    try {
      // Known super admins go straight to the external LSC auth service.
      if (isSuperAdminEmail(email)) {
        await loginViaExternalAuth(email);
        return;
      }

      // Everyone else authenticates against our own database.
      const dbRes = await apiPost<{
        ok?: boolean;
        external?: boolean;
        error?: string;
        token?: string;
        userId?: number;
        companyId?: number | null;
        companyName?: string | null;
        role?: string;
        fullName?: string;
        email?: string;
      }>('users.php', { action: 'LOGIN', email, password: adminPassword });

      // The DB may report this email is actually a super admin — route it externally.
      if (dbRes?.external) {
        await loginViaExternalAuth(email);
        return;
      }

      if (dbRes?.ok) {
        const role = normalizeAdminRole(dbRes.role);
        const companyId = typeof dbRes.companyId === 'number' && dbRes.companyId > 0 ? dbRes.companyId : undefined;
        if (role !== UserRole.SUPER_ADMIN && !companyId) {
          throw new Error('This account is not mapped to a company. Please contact your administrator.');
        }
        // Same guard as the external path: persisting a session without a token would boot the
        // console "signed in" and immediately bounce back here with a misleading "expired" notice.
        if (!dbRes.token) {
          throw new Error('Sign-in failed: the server did not issue a session. Please try again.');
        }
        finalizeAdminSession({
          token: dbRes.token,
          name: dbRes.fullName,
          email: dbRes.email ?? email,
          userId: dbRes.userId,
          companyId,
          companyName: dbRes.companyName ?? undefined,
          role,
        });
        return;
      }

      throw new Error(dbRes?.error || 'Invalid email or password.');
    } catch (e: any) {
      // Server errors arrive as JSON bodies (e.g. the 429 rate-limit {"ok":false,"error":"Too many
      // attempts..."}) — show the readable text, not the raw JSON.
      setAdminError(getApiErrorMessage(e, 'Login failed. Please try again.'));
      return;
    } finally {
      setAdminLoading(false);
    }
  };

  useEffect(() => {
    if (!isAuthed || !sessionStartedAt) return;
    const elapsed = Date.now() - sessionStartedAt;
    // Tell the user why they were signed out instead of silently dropping them on the login form.
    const expire = () => {
      handleLogout();
      setAdminError('Your session has expired. Please sign in again.');
    };
    if (elapsed >= ADMIN_SESSION_TTL_MS) {
      expire();
      return;
    }
    const remaining = ADMIN_SESSION_TTL_MS - elapsed;
    const timeout = window.setTimeout(expire, remaining);
    return () => window.clearTimeout(timeout);
  }, [isAuthed, sessionStartedAt]);

  useEffect(() => {
    if (adminRole !== UserRole.PROCTOR) return;
    const allowed = new Set(['dashboard', 'live', 'monitoring', 'security', 'recordings', 'audit', 'settings']);
    if (!allowed.has(currentView)) {
      setCurrentView('dashboard');
    }
  }, [adminRole, currentView]);

  useEffect(() => {
    if (adminRole !== UserRole.VIEWER) return;
    // Read-only viewers may only reach the Dashboard and Results tabs (plus their own Settings).
    const allowed = new Set(['dashboard', 'results', 'settings']);
    if (!allowed.has(currentView)) {
      setCurrentView('dashboard');
    }
  }, [adminRole, currentView]);

  // Pull the company-shared workspace settings once authenticated.
  useEffect(() => {
    if (isAuthed) void syncFromServer();
  }, [isAuthed, syncFromServer]);

  if (!isAuthed) {
    const requestedConsoleLabel = isSuperAdminEmail(adminEmail) ? 'Super Admin Console' : 'Admin Console';
    return (
      <div className="min-h-screen relative lsc-auth-bg flex items-center justify-center p-5">
        <div className="w-full max-w-md">
          <div className="flex flex-col items-center text-center mb-6">
            <div className="mb-4">{renderBrandMark('h-12 w-12', 'text-[15px]')}</div>
            <h1 className="text-[22px] font-semibold text-slate-900">Sign in</h1>
            <p className="text-sm text-slate-500 mt-1">Continue to the {requestedConsoleLabel}</p>
          </div>

          <div className="lsc-card p-7 sm:p-8">
            <form onSubmit={handleAdminLogin} className="space-y-4">
              <div className="space-y-1.5">
                <label htmlFor="admin-login-email" className="text-[13px] font-medium text-slate-700">Email</label>
                <input
                  id="admin-login-email"
                  type="email"
                  value={adminEmail}
                  onChange={(e) => setAdminEmail(e.target.value)}
                  className="w-full px-3.5 py-2.5 border border-slate-300 rounded-lg outline-none text-slate-800 bg-white placeholder:text-slate-400"
                  placeholder="you@company.com"
                  autoComplete="username"
                  required
                />
              </div>
              <div className="space-y-1.5">
                <label htmlFor="admin-login-password" className="text-[13px] font-medium text-slate-700">Password</label>
                <input
                  id="admin-login-password"
                  type="password"
                  value={adminPassword}
                  onChange={(e) => setAdminPassword(e.target.value)}
                  className="w-full px-3.5 py-2.5 border border-slate-300 rounded-lg outline-none text-slate-800 bg-white placeholder:text-slate-400"
                  placeholder="Enter your password"
                  autoComplete="current-password"
                  required
                />
              </div>
              {adminError && (
                <div role="alert" className="flex items-start gap-2 text-sm text-red-700 bg-red-50 p-3 rounded-lg border border-red-100">
                  <AlertCircle size={16} className="mt-0.5 shrink-0" />
                  <span>{adminError}</span>
                </div>
              )}
              <button
                type="submit"
                disabled={adminLoading || !adminEmail.trim() || !adminPassword.trim()}
                className="w-full py-2.5 lsc-button-primary flex items-center justify-center gap-2 disabled:opacity-60"
              >
                {adminLoading ? 'Signing in…' : 'Sign in'}
                {!adminLoading && <ArrowRight size={18} />}
              </button>
            </form>
          </div>

          <p className="text-center text-xs text-slate-400 mt-6">
            Protected console · {branding.appName || 'LSC Exam Proctor'}
          </p>
        </div>
      </div>
    );
  }

  // Full admins (ADMIN / SUPER_ADMIN) manage tenant data; PROCTOR and read-only VIEWER cannot.
  const isFullAdmin = adminRole === UserRole.ADMIN || adminRole === UserRole.SUPER_ADMIN;

  return (
    <Layout
      role={adminRole}
      currentView={currentView}
      onNavigate={setCurrentView}
      onLogout={handleLogout}
      activeCompanyId={activeCompanyId}
      onCompanyChange={handleCompanyChange}
    >
      {dataLoadError && currentView !== 'platform' && currentView !== 'settings' && (
        <div role="alert" className="mb-4 flex flex-col gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-2">
            <AlertCircle size={16} className="mt-0.5 shrink-0 text-amber-600" />
            <span>Some data couldn't be loaded from the server, so lists and counts may be incomplete.</span>
          </div>
          <button
            type="button"
            onClick={retryDataLoad}
            className="shrink-0 self-start rounded-lg border border-amber-300 bg-white px-3 py-1.5 text-xs font-semibold text-amber-800 hover:bg-amber-100 sm:self-auto"
          >
            Retry
          </button>
        </div>
      )}
      {/* Keyed by company + view: a super-admin company switch remounts the screen so no view keeps
          (or late-receives) the previous company's data, and a screen that crashes is contained to
          itself instead of blanking the whole console. */}
      <ErrorBoundary key={`${activeCompanyId ?? 'none'}:${currentView}`}>
      {adminRole === UserRole.SUPER_ADMIN && currentView === 'platform' && <SuperAdminControl />}
      {currentView === 'settings' && <Settings role={adminRole} />}
      {isFullAdmin && currentView === 'users' && <UserDirectory role={adminRole} />}
      {currentView === 'dashboard' && <Dashboard exams={exams} students={students} sessions={sessions} />}
      {isFullAdmin && currentView === 'exams' && (
        <ExamManager students={students} exams={exams} onUpdateExams={setExams} onUpdateStudents={setStudents} role={adminRole} />
      )}
      {isFullAdmin && currentView === 'students' && <StudentManager students={students} onUpdateStudents={setStudents} role={adminRole} />}
      {isFullAdmin && currentView === 'integrations' && <Integrations role={adminRole} />}
      {isFullAdmin && currentView === 'certificates' && <Certificates role={adminRole} />}
      {isFullAdmin && currentView === 'communications' && <Communications />}
      {adminRole !== UserRole.VIEWER && currentView === 'live' && (
        <LiveProctoring exams={exams} students={students} />
      )}
      {adminRole !== UserRole.VIEWER && currentView === 'monitoring' && (
        <Monitoring sessions={sessions} students={students} exams={exams} onRefreshSessions={refreshSessions} />
      )}
      {adminRole !== UserRole.PROCTOR && currentView === 'results' && (
        <Results exams={exams} students={students} role={adminRole} />
      )}
      {adminRole !== UserRole.VIEWER && currentView === 'security' && (
        <SecurityFeed exams={exams} students={students} />
      )}
      {adminRole !== UserRole.VIEWER && currentView === 'recordings' && (
        <Recordings exams={exams} students={students} />
      )}
      {adminRole !== UserRole.VIEWER && currentView === 'audit' && (
        <ActivityLogs students={students} role={adminRole} />
      )}
      </ErrorBoundary>
    </Layout>
  );
};

const AdminApp: React.FC = () => (
  <SettingsProvider>
    <AdminAppInner />
  </SettingsProvider>
);

const StudentApp: React.FC = () => {
  const [accessRequestContext, setAccessRequestContext] = useState<{
    examId: string;
    studentId: string;
    requestType?: 'REATTEMPT' | 'DEVICE_CHANGE';
    status: 'REQUIRED' | 'PENDING' | 'REVOKED';
    message: string;
    sessionId?: number | null;
    previousDeviceFingerprint?: string | null;
    newDeviceFingerprint?: string | null;
    previousDevice?: Record<string, any> | null;
    newDevice?: Record<string, any> | null;
  } | null>(null);
  const [accessRequestComment, setAccessRequestComment] = useState('');
  const [requestAccessBusy, setRequestAccessBusy] = useState(false);
  const [activeExam, setActiveExam] = useState<Exam | null>(null);
  const [currentStudent, setCurrentStudent] = useState<Student | null>(null);
  const [sessionId, setSessionId] = useState<number | null>(null);
  const [students, setStudents] = useState<Student[]>([]); 
  const [exams, setExams] = useState<Exam[]>([]);
  const [studentCompanyId, setStudentCompanyId] = useState<number | null>(getStoredStudentCompanyId());

  const [examResults, setExamResults] = useState<{
    answers: Record<string, string | number>;
    violations: ViolationLog[];
    questions: Question[];
  } | null>(null);
  // Whether the final 'complete' call has been confirmed by the server. The results screen
  // renders from local state regardless (so the candidate isn't stuck on a spinner), but if this
  // stays false the session never actually flips to COMPLETED server-side — surface that instead
  // of silently losing the submission (see Nandhakumar S incident, 2026-07-28).
  const [submissionSynced, setSubmissionSynced] = useState(true);
  const [resubmittingSession, setResubmittingSession] = useState(false);
  const pendingCompletePayloadRef = useRef<Record<string, unknown> | null>(null);

  const [tokenInput, setTokenInput] = useState('');
  const [tokenError, setTokenError] = useState('');
  const [pendingToken, setPendingToken] = useState<string | null>(null);
  const [studentsLoaded, setStudentsLoaded] = useState(false);
  const [examsLoaded, setExamsLoaded] = useState(false);
  const [startExamBusy, setStartExamBusy] = useState(false);
  const [preStartContext, setPreStartContext] = useState<{
    exam: Exam;
    student: Student;
    // The raw signed access token from the link, forwarded to the server at exam start so it can
    // verify the (exam, student, company) binding wasn't tampered with.
    token: string;
  } | null>(null);
  const [isDirectLinkMode, setIsDirectLinkMode] = useState(false);

  // Canonicalise a possibly-mangled ?token= value to the same clean base64url the server minted.
  // Links get corrupted in transit, so normalise defensively:
  //  • URLSearchParams turns '+' into a space → restore it
  //  • standard-base64 links use '+'/'/'; base64url uses '-'/'_'
  //  • users sometimes glue extra query junk onto the value (e.g. "...fQ==/?audiodebug=1")
  //  • padding may be missing/mangled
  // Returns UNPADDED base64url so the raw string can be forwarded to the server (its base64url_decode
  // reproduces exactly these bytes) — the client and server must agree on what the token decodes to,
  // otherwise a link the client accepts could 403 at exam start under EXAM_ENFORCE_TOKEN.
  const normalizeAccessToken = (token: string): string => {
    let t = String(token).trim().replace(/\s/g, '+');
    t = t.replace(/-/g, '+').replace(/_/g, '/');   // fold base64url → standard so the run regex matches
    const match = t.match(/^[A-Za-z0-9+/]+=*/);    // keep only the leading base64 run (drops '?...' junk)
    if (match) t = match[0];
    t = t.replace(/=+$/, '');                       // strip padding
    if (t.length % 4 === 1) t = t.slice(0, -1);     // impossible base64 length → drop a stray char
    return t.replace(/\+/g, '-').replace(/\//g, '_'); // back to canonical, unpadded base64url
  };

  const parseTokenPayload = (token: string) => {
    let t = normalizeAccessToken(token).replace(/-/g, '+').replace(/_/g, '/');
    while (t.length % 4) t += '=';
    const bin = atob(t);
    // Extract the JSON object, tolerating any trailing bytes from an over-long/garbled base64 tail.
    const start = bin.indexOf('{');
    const end = bin.lastIndexOf('}');
    if (start === -1 || end < start) throw new Error('Malformed token payload.');
    return JSON.parse(bin.slice(start, end + 1));
  };

  // The token the loaded exam/student data belongs to. exams.php / students.php answer a student
  // token with ONLY that token's exam and student, so the data must be reloaded whenever the token
  // changes — not just when the company does. Previously a second token for the same company (e.g.
  // "Return to Home" after exam 1, then the link for exam 2) was checked against the first token's
  // data and failed with "Exam not found or expired.". Initialised from the URL / stored token so
  // the first load doesn't fire twice.
  const [examTokenKey, setExamTokenKey] = useState<string | null>(() => {
    try {
      const urlToken = new URLSearchParams(window.location.search).get('token');
      if (urlToken) return normalizeAccessToken(urlToken);
      const stored = localStorage.getItem(STUDENT_EXAM_TOKEN_KEY);
      return stored ? normalizeAccessToken(stored) : null;
    } catch {
      return null;
    }
  });
  // True when the last exams/students load failed because the server was unreachable (network
  // error / 5xx) rather than because the link is invalid — so the candidate isn't told their link
  // is bad when it's their connection.
  const studentDataUnreachableRef = useRef(false);

  const queueTokenLogin = (token: string, directLinkMode = false) => {
    try {
      const payload = parseTokenPayload(token);
      const rawCompanyId = payload?.cid ?? payload?.companyId ?? payload?.company_id ?? 1;
      const parsedCompanyId = Number(rawCompanyId);
      if (!Number.isFinite(parsedCompanyId) || parsedCompanyId <= 0) {
        throw new Error('Invalid company id in token.');
      }
      // Store the CANONICAL token, not the raw (possibly URL-mangled) value — this is what gets sent
      // as the X-Exam-Token header on every exams.php/students.php request. A mangled token fails
      // server-side HMAC verification silently, exams.php falls through past the student-token
      // check into require_staff(), and a perfectly valid student is 401'd with "Exam not found".
      const cleanToken = normalizeAccessToken(token);
      // When the data scope changes, mark the current data stale in the SAME render as the new
      // pending token. Otherwise the pending-token effect runs once against the previous scope's
      // already-"loaded" lists, reports "Exam not found or expired." and drops the token.
      if (parsedCompanyId !== studentCompanyId || cleanToken !== examTokenKey) {
        setStudentsLoaded(false);
        setExamsLoaded(false);
      }
      setIsDirectLinkMode(directLinkMode);
      setTokenError('');
      setAccessRequestContext(null);
      setPreStartContext(null);
      setStudentCompanyId(parsedCompanyId);
      storeStudentCompanyId(parsedCompanyId);
      storeStudentExamToken(cleanToken);
      setExamTokenKey(cleanToken);
      setPendingToken(cleanToken);
    } catch (e: any) {
      setIsDirectLinkMode(directLinkMode);
      setTokenError(e?.message || 'Invalid or expired token. Please check your link.');
    }
  };

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const urlToken = params.get('token');
    if (urlToken) {
      queueTokenLogin(urlToken, true);
      return;
    }
    // Restore from localStorage after a page reload (URL token was cleared by replaceState).
    try {
      const stored = localStorage.getItem(STUDENT_EXAM_TOKEN_KEY);
      const storedCompanyId = getStoredStudentCompanyId();
      if (stored && storedCompanyId) {
        queueTokenLogin(stored, true);
      }
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    setStudentsLoaded(false);
    setExamsLoaded(false);
    setStudents([]);
    setExams([]);
    setPreStartContext(null);
    setAccessRequestContext(null);
    studentDataUnreachableRef.current = false;
  }, [studentCompanyId, examTokenKey]);

  const isUnreachableError = (e: unknown) => e instanceof ApiError && (e.status === 0 || e.status >= 500);

  useEffect(() => {
    if (!studentCompanyId) return;
    let cancelled = false;
    const loadStudents = async () => {
      try {
        const data = await apiGet<{ students: Student[] }>('students.php');
        if (!cancelled && data?.students) {
          setStudents(data.students);
        }
      } catch (e) {
        console.error('Failed to load students from API:', e);
        if (!cancelled && isUnreachableError(e)) studentDataUnreachableRef.current = true;
      } finally {
        if (!cancelled) setStudentsLoaded(true);
      }
    };
    loadStudents();
    return () => {
      cancelled = true;
    };
  }, [studentCompanyId, examTokenKey]);

  useEffect(() => {
    if (!studentCompanyId) return;
    let cancelled = false;
    const loadExams = async () => {
      try {
        const data = await apiGet<{ exams: Exam[] }>('exams.php');
        if (!cancelled && data?.exams) {
          setExams(data.exams);
        }
      } catch (e) {
        console.error('Failed to load exams from API:', e);
        if (!cancelled && isUnreachableError(e)) studentDataUnreachableRef.current = true;
      } finally {
        if (!cancelled) setExamsLoaded(true);
      }
    };
    loadExams();
    return () => {
      cancelled = true;
    };
  }, [studentCompanyId, examTokenKey]);

  useEffect(() => {
    if (!pendingToken) return;
    if (!studentsLoaded || !examsLoaded) return;
    handleTokenLogin(pendingToken);
    setPendingToken(null);
  }, [pendingToken, studentsLoaded, examsLoaded, exams, students]);


  const handleTokenLogin = async (token: string) => {
    try {
      setTokenError('');
      setAccessRequestContext(null);
      const payload = parseTokenPayload(token);
      const rawCompanyId = payload?.cid ?? payload?.companyId ?? payload?.company_id ?? studentCompanyId ?? 1;
      const payloadCompanyId = Number(rawCompanyId);
      if (!Number.isFinite(payloadCompanyId) || payloadCompanyId <= 0) {
        throw new Error('Invalid company id in token.');
      }
      if (studentCompanyId && payloadCompanyId !== studentCompanyId) {
        throw new Error('Token company mismatch. Please request a new link.');
      }
      
      const exam = exams.find(e => e.id === payload.eid);
      const student = students.find(s => s.id === payload.sid);

      if ((!exam || !student) && studentDataUnreachableRef.current) {
        throw new Error("We couldn't reach the exam server to load your exam. Check your internet connection and reload this page.");
      }
      if (!exam) throw new Error("Exam not found or expired.");
      if (!student) throw new Error("Student record not found.");
      if (exam.status === 'ARCHIVED') throw new Error("This exam is archived.");

      const now = Date.now();
      const examTz = resolveExamTimezone(exam.timezone);
      if (now < exam.startTime) {
        throw new Error(`Exam has not started yet. Opens at: ${formatScheduleShort(exam.startTime, examTz)}`);
      }
      if (now > exam.endTime) {
        throw new Error(`Exam window has closed. Ended at: ${formatScheduleShort(exam.endTime, examTz)}`);
      }

      // Store the CANONICAL token (not the raw, possibly-mangled URL value) so the accessToken we
      // later forward to sessions.php decodes server-side to exactly what we validated here.
      setPreStartContext({ exam, student, token: normalizeAccessToken(token) });
      setSessionId(null);
      setExamResults(null);
      window.history.replaceState({}, document.title, window.location.pathname);

    } catch (e: any) {
      console.error(e);
      setTokenError(e.message || "Invalid or expired token. Please check your link.");
    }
  };

  const handleStartExam = async () => {
    if (!preStartContext || startExamBusy) return;
    setStartExamBusy(true);
    setTokenError('');
    setAccessRequestContext(null);
    try {
      const { exam, student } = preStartContext;
      const deviceFingerprint = await getDeviceFingerprint();
      const deviceMetadata = buildDeviceMetadata();
      const geoLocation = await getGeoLocation();
      const macAddress = await getMacAddress();
      const start = await apiPost<{ ok: boolean; sessionId?: number | null; attempt?: number; reconnect?: boolean; remaining?: number }>('sessions.php', {
        action: 'start',
        examId: exam.id,
        studentId: student.id,
        // Signed access token — the server verifies this binds to (examId, studentId, companyId) so a
        // tampered link can't start an exam as another student.
        accessToken: preStartContext.token,
        location: geoLocation.label,
        geoLocation,
        deviceFingerprint,
        deviceMetadata,
        macAddress
      });
      setSessionId(start?.sessionId ?? null);
      setActiveExam(exam);
      setCurrentStudent(student);
      setExamResults(null);
      setAccessRequestContext(null);
      setPreStartContext(null);
      window.history.replaceState({}, document.title, window.location.pathname);
    } catch (e: any) {
      const msg = String(e?.message || '');
      const parsed = parseApiErrorPayload(msg) as any;
      const errCode = parsed?.error || '';
      if (errCode === 'ACCESS_REQUEST_REQUIRED' || errCode === 'ACCESS_REQUEST_PENDING' || errCode === 'ACCESS_REQUEST_REVOKED') {
        const status = errCode === 'ACCESS_REQUEST_PENDING'
          ? 'PENDING'
          : errCode === 'ACCESS_REQUEST_REVOKED'
            ? 'REVOKED'
            : 'REQUIRED';
        setAccessRequestContext({
          examId: preStartContext.exam.id,
          studentId: preStartContext.student.id,
          requestType: 'REATTEMPT',
          status,
          message: parsed?.message || 'Access is blocked. Request admin approval to reattempt.',
        });
        setTokenError(parsed?.message || 'Access is blocked. Request admin approval to reattempt.');
      } else if (errCode === 'DEVICE_CHANGE_REQUIRED' || errCode === 'DEVICE_CHANGE_PENDING') {
        const nextFingerprint = await getDeviceFingerprint().catch(() => null);
        setAccessRequestContext({
          examId: preStartContext.exam.id,
          studentId: preStartContext.student.id,
          requestType: 'DEVICE_CHANGE',
          status: errCode === 'DEVICE_CHANGE_PENDING' ? 'PENDING' : 'REQUIRED',
          message: parsed?.message || 'This exam is bound to another device. Request access to continue.',
          sessionId: parsed?.sessionId ?? null,
          previousDeviceFingerprint: parsed?.previousDeviceFingerprint ?? null,
          newDeviceFingerprint: parsed?.newDeviceFingerprint ?? nextFingerprint,
          newDevice: buildDeviceMetadata(),
        });
        setAccessRequestComment('');
        setTokenError(parsed?.message || 'This exam is bound to another device. Request access to continue.');
      } else if (msg.includes('SESSION_EXISTS')) {
        setTokenError('This exam session is already started or completed. Please contact admin to renew your link.');
      } else if (msg.includes('RECONNECT_LIMIT')) {
        setTokenError('No more reconnection is possible. Please contact administrator.');
      } else if (errCode === 'MAC_ADDRESS_MISMATCH' || msg.includes('MAC_ADDRESS_MISMATCH')) {
        setTokenError('This exam is bound to a different device. Please contact your administrator to reset the device binding.');
      } else if (errCode === 'EXAM_NOT_FOUND') {
        setTokenError('This exam is no longer available. Please contact your administrator.');
      } else if (errCode === 'STUDENT_NOT_FOUND') {
        setTokenError('Your candidate record could not be found. Please contact your administrator.');
      } else {
        // Code-only bodies such as {"error":"..."} used to be shown to the candidate as raw JSON.
        setTokenError(getApiErrorMessage(e, 'Failed to start exam. Please try again.'));
      }
    } finally {
      setStartExamBusy(false);
    }
  };

  const handleManualTokenSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!tokenInput.trim()) return;
    queueTokenLogin(tokenInput.trim(), false);
  };

  const handleRequestAccess = async () => {
    if (!accessRequestContext || requestAccessBusy) return;
    const comment = accessRequestComment.trim();
    if (accessRequestContext.requestType === 'DEVICE_CHANGE' && comment.length < 8) {
      setTokenError('Please add a short reason before requesting access from a different device.');
      return;
    }
    setRequestAccessBusy(true);
    try {
      const result = await apiPost<{ ok: boolean; requestId?: number; status?: string }>('access_requests.php', {
        action: 'request',
        examId: accessRequestContext.examId,
        studentId: accessRequestContext.studentId,
        requestType: accessRequestContext.requestType || 'REATTEMPT',
        reason: comment || accessRequestContext.message,
        sessionId: accessRequestContext.sessionId ?? null,
        previousDeviceFingerprint: accessRequestContext.previousDeviceFingerprint ?? null,
        newDeviceFingerprint: accessRequestContext.newDeviceFingerprint ?? null,
        previousDevice: accessRequestContext.previousDevice ?? null,
        newDevice: accessRequestContext.newDevice ?? buildDeviceMetadata(),
      });
      if ((result?.status || '').toUpperCase() === 'GRANTED') {
        setAccessRequestContext(null);
        setTokenError('Access is already granted. Click Start Test.');
        return;
      }
      setAccessRequestContext(prev => prev ? {
        ...prev,
        status: 'PENDING',
        message: 'Access request submitted. Please wait for admin decision.'
      } : prev);
      setAccessRequestComment('');
      setTokenError('Access request submitted. Please wait for admin decision.');
    } catch (e: any) {
      const msg = String(e?.message || '');
      const parsed = parseApiErrorPayload(msg) as any;
      setTokenError(parsed?.message || 'Failed to submit access request. Please try again.');
    } finally {
      setRequestAccessBusy(false);
    }
  };

  const handleExamFinish = async (data: {
    answers: Record<string, string | number>;
    violations: ViolationLog[];
    questions: Question[];
    questionTimes?: Record<string, number>;
    terminated?: boolean;
    terminationReason?: string;
    violationSummary?: any;
  }) => {
    if (data.terminated) {
      if (activeExam && currentStudent) {
        const synced = await postSessionCompleteWithRetry({
          action: 'terminate',
          examId: activeExam.id,
          studentId: currentStudent.id,
          reason: data.terminationReason || 'Violation threshold reached.',
          violationSummary: data.violationSummary || null,
          // Send the answers gathered so far so the terminated attempt is scored on what the
          // candidate actually attended (still a fail, but with a real score — not a blank row).
          answers: data.answers,
          questionIds: data.questions.map(q => q.id),
          questionTimes: data.questionTimes || {},
        });
        if (!synced) {
          console.error('Failed to terminate session after retries — the abandoned-session sweep will reconcile it later.');
        }
        setAccessRequestContext({
          examId: activeExam.id,
          studentId: currentStudent.id,
          status: 'REQUIRED',
          message: data.terminationReason || 'Access was blocked due to violation threshold.'
        });
      }
      setTokenError(data.terminationReason || 'Access blocked due to violation threshold. Request admin approval to reattempt.');
      setActiveExam(null);
      setCurrentStudent(null);
      setExamResults(null);
      setSessionId(null);
      return;
    }

    setExamResults(data);
    setSubmissionSynced(true);

    if (activeExam && currentStudent) {
        const completePayload = {
          action: 'complete',
          examId: activeExam.id,
          studentId: currentStudent.id,
          answers: data.answers,
          questionIds: data.questions.map(q => q.id),
          questionTimes: data.questionTimes || {}
        };
        const synced = await postSessionCompleteWithRetry(completePayload);
        if (!synced) {
          // Keep the payload around so the student (or the "Retry" button on the results screen)
          // can resend it without re-answering — the server never got the completion, so the
          // session is still sitting IN_PROGRESS and won't show up in Results/Recordings.
          pendingCompletePayloadRef.current = completePayload;
          setSubmissionSynced(false);
        }
    }
  };

  // A dropped 'complete' call used to strand a session as IN_PROGRESS forever — fully graded
  // answers sitting in the DB, but invisible in Results and with its recording never finalized,
  // while the student saw a normal-looking results screen. Retry transient failures a few times
  // before giving up and telling the student their submission didn't register.
  const postSessionCompleteWithRetry = async (payload: Record<string, unknown>, attempts = 4): Promise<boolean> => {
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        await apiPost('sessions.php', payload);
        return true;
      } catch (e) {
        console.error(`Failed to complete session (attempt ${attempt}/${attempts}):`, e);
        // 409 = the server has a final answer for this attempt (e.g. SESSION_TERMINATED: it already
        // ended and can't be submitted). Retrying can't change that, so stop instead of re-sending.
        if (e instanceof ApiError && e.status === 409) return false;
        if (attempt < attempts) {
          await new Promise(resolve => setTimeout(resolve, 1500 * attempt));
        }
      }
    }
    return false;
  };

  const handleRetrySubmission = async () => {
    if (!pendingCompletePayloadRef.current || resubmittingSession) return;
    setResubmittingSession(true);
    try {
      const synced = await postSessionCompleteWithRetry(pendingCompletePayloadRef.current);
      if (synced) {
        pendingCompletePayloadRef.current = null;
        setSubmissionSynced(true);
      }
    } finally {
      setResubmittingSession(false);
    }
  };

  const handleExitStudent = () => {
    setActiveExam(null);
    setCurrentStudent(null);
    setExamResults(null);
    setSessionId(null);
    storeStudentExamToken(null);
    storeStudentCompanyId(null);
    // "Return to Home" lands on the token entry screen. Candidates who arrived via an emailed link
    // used to get an empty "Secure Link Access" card with no content and no way forward.
    setIsDirectLinkMode(false);
    setPreStartContext(null);
    setAccessRequestContext(null);
    setTokenError('');
    setTokenInput('');
  };

  const renderAccessRequestAction = () => {
    if (!accessRequestContext) return null;
    const isDeviceChange = accessRequestContext.requestType === 'DEVICE_CHANGE';
    return (
      <div className="space-y-3 rounded-xl border border-amber-200 bg-amber-50/60 p-3">
        <div className="text-xs font-semibold text-amber-900">
          {isDeviceChange ? 'Device change approval required' : 'Access approval required'}
        </div>
        <p className="text-xs text-amber-800">{accessRequestContext.message}</p>
        {isDeviceChange && (
          <div className="space-y-2">
            <textarea
              value={accessRequestComment}
              onChange={e => setAccessRequestComment(e.target.value)}
              disabled={accessRequestContext.status === 'PENDING'}
              aria-label="Reason for the device change"
              placeholder="Explain why your device changed. This comment is mandatory for approval."
              className="w-full min-h-24 rounded-lg border border-amber-200 bg-white px-3 py-2 text-sm text-slate-800 outline-none focus:border-amber-400 disabled:opacity-60"
            />
            <div className="grid grid-cols-1 gap-2 text-[11px] text-amber-800 sm:grid-cols-2">
              <div className="rounded-lg border border-amber-200 bg-white/70 p-2">
                Previous: <span className="font-mono">{accessRequestContext.previousDeviceFingerprint?.slice(0, 12) || 'Unknown'}</span>
              </div>
              <div className="rounded-lg border border-amber-200 bg-white/70 p-2">
                Current: <span className="font-mono">{accessRequestContext.newDeviceFingerprint?.slice(0, 12) || 'Unknown'}</span>
              </div>
            </div>
          </div>
        )}
        <button
          type="button"
          onClick={handleRequestAccess}
          disabled={requestAccessBusy || accessRequestContext.status === 'PENDING'}
          className="w-full py-3 border border-amber-300 bg-white rounded-xl text-sm font-semibold text-amber-800 hover:bg-amber-100 disabled:opacity-60"
        >
          {accessRequestContext.status === 'PENDING'
            ? 'Request Pending'
            : requestAccessBusy
              ? 'Submitting Request...'
              : isDeviceChange
                ? 'Request Device Access'
                : 'Request Access'}
        </button>
      </div>
    );
  };

  if (activeExam && currentStudent) {
    const examCrashMessage = 'Your answers are saved as you go. Reload this page to get back into your exam.';
    if (examResults) {
      return (
        <ErrorBoundary title="Something went wrong showing your result" message="Your submission is not affected. Reload the page to try again.">
        <ExamResult
           exam={activeExam}
           student={currentStudent}
           answers={examResults.answers}
           violations={examResults.violations}
           questions={examResults.questions}
           sessionId={sessionId ?? undefined}
           onExit={handleExitStudent}
           submissionSynced={submissionSynced}
           resubmitting={resubmittingSession}
           onRetrySubmission={handleRetrySubmission}
        />
        </ErrorBoundary>
      );
    }
    return (
      <ErrorBoundary title="Something went wrong during your exam" message={examCrashMessage}>
      <ExamTake
        exam={activeExam}
        student={currentStudent}
        sessionId={sessionId ?? undefined}
        onFinish={handleExamFinish}
      />
      </ErrorBoundary>
    );
  }

  if (isDirectLinkMode) {
    const linkLoading = !preStartContext && !tokenError && (pendingToken !== null || !studentsLoaded || !examsLoaded);
    return (
      <div className="min-h-screen relative lsc-auth-bg">
        <div className="relative z-10 min-h-screen flex items-center justify-center p-6">
          <div className="w-full max-w-4xl lsc-card p-8 space-y-6">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-center gap-3">
                <div className="h-12 w-12 lsc-brand-mark text-sm">LSC</div>
                <div>
                  <div className="text-[11px] uppercase tracking-[0.24em] text-slate-500">Secure Link Access</div>
                  <h1 className="text-2xl font-semibold text-slate-900">LSC Exam Proctor</h1>
                </div>
              </div>
              <button
                type="button"
                onClick={() => {
                  setIsDirectLinkMode(false);
                  setPreStartContext(null);
                  setTokenError('');
                  setAccessRequestContext(null);
                }}
                className="px-4 py-2 rounded-lg border border-slate-200 text-sm font-medium text-slate-600 hover:bg-slate-50"
              >
                Use Manual Token
              </button>
            </div>

            {linkLoading && (
              <div className="rounded-xl border border-slate-200 bg-white px-5 py-4 text-sm text-slate-600">
                Validating exam link and loading student details...
              </div>
            )}

            {tokenError && (
              <div role="alert" className="flex items-start gap-2 text-sm text-red-600 bg-red-50 p-3 rounded-lg border border-red-100">
                <AlertCircle size={16} className="mt-0.5 shrink-0" />
                <span>{tokenError}</span>
              </div>
            )}

            {/* After a termination (or any failure before the pre-start card exists) the request-access
                action used to render only inside the pre-start card below, so a candidate who came in
                through their emailed link saw the error with no way to ask for a reattempt. */}
            {!preStartContext && renderAccessRequestAction()}

            {preStartContext && (
              <div className="space-y-4 rounded-xl border border-slate-200 bg-white p-5">
                <h2 className="text-sm font-semibold uppercase tracking-[0.2em] text-slate-500">Before You Start</h2>
                <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                  <div className="rounded-lg border border-slate-200 bg-slate-50/80 p-3">
                    <div className="text-[11px] uppercase tracking-[0.16em] text-slate-500">Student Name</div>
                    <div className="mt-1 text-sm font-semibold text-slate-900">{preStartContext.student.fullName}</div>
                  </div>
                  <div className="rounded-lg border border-slate-200 bg-slate-50/80 p-3">
                    <div className="text-[11px] uppercase tracking-[0.16em] text-slate-500">Register Number</div>
                    <div className="mt-1 text-sm font-semibold text-slate-900">{preStartContext.student.registrationId}</div>
                  </div>
                  <div className="rounded-lg border border-slate-200 bg-slate-50/80 p-3">
                    <div className="text-[11px] uppercase tracking-[0.16em] text-slate-500">Exam Name</div>
                    <div className="mt-1 text-sm font-semibold text-slate-900">{preStartContext.exam.title}</div>
                  </div>
                </div>

                <div>
                  <div className="text-xs font-semibold text-slate-500 uppercase tracking-[0.16em] mb-2">Instructions</div>
                  <ul className="list-disc list-inside text-sm text-slate-700 space-y-1">
                    {buildPreStartInstructions(preStartContext.exam).map((line, idx) => (
                      <li key={`${preStartContext.exam.id}-instruction-link-${idx}`}>{line}</li>
                    ))}
                  </ul>
                </div>

                {renderAccessRequestAction()}

                <button
                  type="button"
                  onClick={handleStartExam}
                  disabled={startExamBusy}
                  className="w-full py-3.5 lsc-button-primary disabled:opacity-60"
                >
                  {startExamBusy ? 'Starting Test...' : 'Start Test'}
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen relative lsc-auth-bg">
      <div className="relative z-10 min-h-screen flex items-center justify-center p-6">
        <div className="w-full max-w-md space-y-7 lsc-card p-8">
          <div className="text-center space-y-2">
            <div className="mx-auto h-14 w-14 lsc-brand-mark text-base">
              LSC
            </div>
            <h1 className="text-2xl font-semibold text-slate-900">LSC Exam Proctor</h1>
            <p className="text-slate-500 text-sm">Enter your exam access token to begin</p>
          </div>

          <div className="space-y-6">
            <div>
              <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-[0.2em] mb-3">Enter Exam</h3>
              <form onSubmit={handleManualTokenSubmit} className="space-y-3">
                <div className="relative">
                  <KeyRound className="absolute left-3 top-3.5 text-slate-400" size={20} />
                  <input
                    type="text"
                    aria-label="Exam access token"
                    placeholder="Paste your exam token"
                    className="w-full pl-10 pr-4 py-3.5 border border-slate-200 rounded-xl outline-none text-slate-800 bg-white"
                    value={tokenInput}
                    onChange={e => setTokenInput(e.target.value)}
                  />
                </div>
                {tokenError && (
                  <div role="alert" className="flex items-start gap-2 text-sm text-red-600 bg-red-50 p-3 rounded-lg border border-red-100">
                    <AlertCircle size={16} className="mt-0.5 shrink-0" />
                    <span>{tokenError}</span>
                  </div>
                )}
                {renderAccessRequestAction()}
                <button 
                  type="submit"
                  disabled={!tokenInput}
                  className="w-full py-3.5 lsc-button-primary disabled:opacity-50"
                >
                  Validate Token
                </button>
              </form>
            </div>
            {preStartContext && (
              <div className="space-y-3 rounded-xl border border-slate-200 bg-white p-4">
                <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-[0.2em]">Before You Start</h3>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-3 text-sm text-slate-700">
                  <p><span className="font-semibold text-slate-900">Student Name:</span> {preStartContext.student.fullName}</p>
                  <p><span className="font-semibold text-slate-900">Register Number:</span> {preStartContext.student.registrationId}</p>
                  <p><span className="font-semibold text-slate-900">Exam Name:</span> {preStartContext.exam.title}</p>
                </div>
                <div>
                  <div className="text-xs font-semibold text-slate-500 uppercase tracking-[0.16em] mb-2">Instructions</div>
                  <ul className="list-disc list-inside text-sm text-slate-700 space-y-1">
                    {buildPreStartInstructions(preStartContext.exam).map((line, idx) => (
                      <li key={`${preStartContext.exam.id}-instruction-${idx}`}>{line}</li>
                    ))}
                  </ul>
                </div>
                <button
                  type="button"
                  onClick={handleStartExam}
                  disabled={startExamBusy}
                  className="w-full py-3.5 lsc-button-primary disabled:opacity-60"
                >
                  {startExamBusy ? 'Starting Test...' : 'Start Test'}
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default function App() {
  const [routePath, setRoutePath] = useState(window.location.pathname);

  useEffect(() => {
    const onPop = () => setRoutePath(window.location.pathname);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const isAdminRoute = routePath.startsWith('/admin');

  // On admin routes the SettingsProvider owns the `admin-compact` class (Settings → Density).
  // Forcing it on here used to override that preference: this parent effect runs after the
  // provider's, so every admin page loaded compact and then jumped to "comfortable" once server
  // settings synced (and the login screen / a failed sync stayed compact regardless of the choice).
  // Only make sure the student exam pages never inherit it.
  useEffect(() => {
    if (!isAdminRoute) {
      document.documentElement.classList.remove('admin-compact');
    }
  }, [isAdminRoute]);

  return isAdminRoute ? <AdminApp /> : <StudentApp />;
}
