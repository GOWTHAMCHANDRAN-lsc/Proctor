import React, { useState, useEffect, useCallback } from 'react';
import { Layout } from './components/Layout';
import { Dashboard } from './components/admin/Dashboard';
import { ExamManager } from './components/admin/ExamManager';
import { StudentManager } from './components/admin/StudentManager';
import { Monitoring } from './components/admin/Monitoring';
import { SecurityFeed } from './components/admin/SecurityFeed';
import { Recordings } from './components/admin/Recordings';
import { Results } from './components/admin/Results';
import { ActivityLogs } from './components/admin/ActivityLogs';
import { UserDirectory } from './components/admin/UserDirectory';
import { SuperAdminControl } from './components/admin/SuperAdminControl';
import { ExamTake } from './components/student/ExamTake';
import { ExamResult } from './components/student/ExamResult';
import { UserRole, Exam, Student, ViolationLog, Question, ExamSession } from './types';
import { MOCK_EXAMS, MOCK_STUDENTS, MOCK_SESSIONS } from './services/mockStore';
import { Lock, ArrowRight, KeyRound, AlertCircle } from 'lucide-react';
import { apiGet, apiPost } from './services/api';

const ADMIN_SESSION_KEY = 'pg_admin_session';
const ADMIN_SESSION_LEGACY_KEY = 'pg_admin_authed';
const ADMIN_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const ADMIN_AUTH_STORAGE_KEY = 'pg_admin_auth';
const STUDENT_COMPANY_STORAGE_KEY = 'pg_student_company';
const ADMIN_AUTH_URL = import.meta.env.VITE_ADMIN_AUTH_URL || 'https://auth.lsc-india.org/api/login';
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

const normalizeAdminRole = (value: unknown): UserRole.ADMIN | UserRole.SUPER_ADMIN | UserRole.PROCTOR => {
  const role = String(value || '').trim().toUpperCase();
  if (role === UserRole.SUPER_ADMIN) return UserRole.SUPER_ADMIN;
  if (role === 'PROCTOR') return UserRole.PROCTOR;
  return UserRole.ADMIN;
};

const getStoredAdminRole = (): UserRole.ADMIN | UserRole.SUPER_ADMIN | UserRole.PROCTOR => {
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
      pc.createOffer().then(offer => pc.setLocalDescription(offer));
      
      pc.onicecandidate = (event) => {
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
  const violationLimits = proctor.violationLimits || {};

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

  lines.push(`Exam window: ${new Date(exam.startTime).toLocaleString()} to ${new Date(exam.endTime).toLocaleString()}.`);
  return lines;
};

const AdminApp: React.FC = () => {
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
  const [adminSystemId, setAdminSystemId] = useState('3');
  const [adminRole, setAdminRole] = useState<UserRole.ADMIN | UserRole.SUPER_ADMIN | UserRole.PROCTOR>(initialRole);
  const [adminError, setAdminError] = useState('');
  const [adminLoading, setAdminLoading] = useState(false);
  const [currentView, setCurrentView] = useState(initialRole === UserRole.SUPER_ADMIN ? 'platform' : 'dashboard');
  const [students, setStudents] = useState<Student[]>(MOCK_STUDENTS);
  const [exams, setExams] = useState<Exam[]>(MOCK_EXAMS);
  const [sessions, setSessions] = useState<ExamSession[]>(MOCK_SESSIONS);

  useEffect(() => {
    if (!isAuthed) return;
    let cancelled = false;
    const loadStudents = async () => {
      try {
        const data = await apiGet<{ students: Student[] }>('students.php');
        if (!cancelled && data?.students) {
          setStudents(data.students);
        }
      } catch (e) {
        console.error('Failed to load students from API:', e);
      }
    };
    loadStudents();
    return () => {
      cancelled = true;
    };
  }, [isAuthed]);

  useEffect(() => {
    if (!isAuthed) return;
    let cancelled = false;
    const loadExams = async () => {
      try {
        const data = await apiGet<{ exams: Exam[] }>('exams.php');
        if (!cancelled && data?.exams) {
          setExams(data.exams);
        }
      } catch (e) {
        console.error('Failed to load exams from API:', e);
      }
    };
    loadExams();
    return () => {
      cancelled = true;
    };
  }, [isAuthed]);

  const refreshSessions = useCallback(async () => {
    if (!isAuthed) return;
    try {
      const data = await apiGet<{ sessions: ExamSession[] }>('sessions.php');
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
    }
  }, [isAuthed]);

  useEffect(() => {
    if (!isAuthed) return;
    refreshSessions();
  }, [isAuthed, refreshSessions]);

  const handleLogout = () => {
    setIsAuthed(false);
    setSessionStartedAt(null);
    clearAdminSession();
    setCurrentView('dashboard');
    setAdminRole(UserRole.ADMIN);
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

    try {
      const formData = new FormData();
      formData.append('email', adminEmail.trim());
      formData.append('password', adminPassword);
      formData.append('system_id', adminSystemId.trim() || '3');

      const res = await fetch(ADMIN_AUTH_URL, {
        method: 'POST',
        body: formData,
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || `Login failed: ${res.status}`);
      }
      const payload = await res.json();
      if (!payload?.success || !payload?.data?.token) {
        throw new Error(payload?.message || 'Invalid login response.');
      }
      const resolvedEmail = String(payload.data.email ?? adminEmail).trim();
      const rawCompanyId = payload.data.company_id ?? payload.data.companyId ?? payload.data.cid;
      const parsedCompanyId = Number(rawCompanyId);
      if (!Number.isFinite(parsedCompanyId) || parsedCompanyId <= 0) {
        throw new Error('Login response missing a valid company id.');
      }

      const startedAt = Date.now();
      const nextRole = isSuperAdminEmail(resolvedEmail)
        ? UserRole.SUPER_ADMIN
        : normalizeAdminRole(
            payload.data.role ?? payload.data.user_role ?? payload.data.account_role ?? payload.data.type
          );
      setIsAuthed(true);
      setSessionStartedAt(startedAt);
      storeAdminSession(startedAt);
      storeAdminAuth({
        token: payload.data.token,
        name: payload.data.name,
        email: resolvedEmail,
        userId: payload.data.user_id,
        companyId: parsedCompanyId,
        companyName: payload.data.company_name ?? payload.data.companyName ?? payload.data.company,
        systemId: payload.data.system_id,
        role: nextRole,
      });
      setAdminRole(nextRole);
      setCurrentView(nextRole === UserRole.SUPER_ADMIN ? 'platform' : 'dashboard');
      return;
    } catch (e: any) {
      setAdminError(e?.message || 'Login failed. Please try again.');
      return;
    } finally {
      setAdminLoading(false);
    }
  };

  useEffect(() => {
    if (!isAuthed || !sessionStartedAt) return;
    const elapsed = Date.now() - sessionStartedAt;
    if (elapsed >= ADMIN_SESSION_TTL_MS) {
      handleLogout();
      return;
    }
    const remaining = ADMIN_SESSION_TTL_MS - elapsed;
    const timeout = window.setTimeout(() => {
      handleLogout();
    }, remaining);
    return () => window.clearTimeout(timeout);
  }, [isAuthed, sessionStartedAt]);

  useEffect(() => {
    if (adminRole !== UserRole.PROCTOR) return;
    const allowed = new Set(['dashboard', 'monitoring', 'security', 'recordings', 'audit']);
    if (!allowed.has(currentView)) {
      setCurrentView('dashboard');
    }
  }, [adminRole, currentView]);

  if (!isAuthed) {
    const requestedConsoleLabel = isSuperAdminEmail(adminEmail) ? 'Super Admin Console' : 'Admin Console';
    return (
      <div className="min-h-screen relative overflow-hidden lsc-gradient-bg">
        <div className="absolute -top-24 -left-24 h-64 w-64 rounded-full bg-blue-200/40 blur-3xl"></div>
        <div className="absolute -bottom-32 -right-24 h-80 w-80 rounded-full bg-orange-200/30 blur-3xl"></div>
        <div className="relative z-10 min-h-screen flex items-center justify-center p-6">
          <div className="w-full max-w-lg space-y-6 lsc-card p-8">
            <div className="flex items-start justify-between gap-4">
              <div className="flex items-center gap-3">
                <div className="h-12 w-12 lsc-brand-mark text-sm">
                  LSC
                </div>
                <div>
                  <p className="text-[11px] uppercase tracking-[0.24em] text-slate-500">{requestedConsoleLabel}</p>
                  <h1 className="text-2xl font-semibold text-slate-900">LSC Exam Proctor Control</h1>
                </div>
              </div>
            </div>

            <div className="space-y-4">
              <form onSubmit={handleAdminLogin} className="space-y-3">
                <div className="space-y-2">
                  <label className="text-xs font-semibold text-slate-500 uppercase tracking-[0.2em]">Email</label>
                  <input
                    type="email"
                    value={adminEmail}
                    onChange={(e) => setAdminEmail(e.target.value)}
                    className="w-full px-4 py-3 border border-slate-200 rounded-xl outline-none text-slate-800 bg-white"
                    placeholder="admin@example.com"
                    autoComplete="username"
                    required
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-xs font-semibold text-slate-500 uppercase tracking-[0.2em]">Password</label>
                  <input
                    type="password"
                    value={adminPassword}
                    onChange={(e) => setAdminPassword(e.target.value)}
                    className="w-full px-4 py-3 border border-slate-200 rounded-xl outline-none text-slate-800 bg-white"
                    placeholder="••••••••"
                    autoComplete="current-password"
                    required
                  />
                </div>
                {adminError && (
                  <div className="text-sm text-red-600 bg-red-50 p-3 rounded-lg border border-red-100">
                    {adminError}
                  </div>
                )}
                <button
                  type="submit"
                  disabled={adminLoading || !adminEmail.trim() || !adminPassword.trim()}
                  className="w-full p-4 lsc-button-primary flex items-center justify-between disabled:opacity-60"
                >
                  <div className="flex items-center gap-4">
                    <div className="bg-white/20 p-3 rounded-xl text-white">
                      <Lock size={24} />
                    </div>
                    <div className="text-left">
                      <h3 className="font-semibold">{adminLoading ? 'Signing in...' : 'Login'}</h3>
                    </div>
                  </div>
                  <ArrowRight className="text-white/80" />
                </button>
              </form>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <Layout role={adminRole} currentView={currentView} onNavigate={setCurrentView} onLogout={handleLogout}>
      {adminRole === UserRole.SUPER_ADMIN && currentView === 'platform' && <SuperAdminControl />}
      {adminRole !== UserRole.PROCTOR && currentView === 'users' && <UserDirectory role={adminRole} />}
      {currentView === 'dashboard' && <Dashboard exams={exams} students={students} sessions={sessions} />}
      {adminRole !== UserRole.PROCTOR && currentView === 'exams' && (
        <ExamManager students={students} exams={exams} onUpdateExams={setExams} onUpdateStudents={setStudents} />
      )}
      {adminRole !== UserRole.PROCTOR && currentView === 'students' && <StudentManager students={students} onUpdateStudents={setStudents} />}
      {currentView === 'monitoring' && (
        <Monitoring sessions={sessions} students={students} exams={exams} onRefreshSessions={refreshSessions} />
      )}
      {adminRole !== UserRole.PROCTOR && currentView === 'results' && (
        <Results exams={exams} students={students} />
      )}
      {currentView === 'security' && (
        <SecurityFeed exams={exams} students={students} />
      )}
      {currentView === 'recordings' && (
        <Recordings exams={exams} students={students} />
      )}
      {currentView === 'audit' && (
        <ActivityLogs students={students} />
      )}
    </Layout>
  );
};

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
  
  const [tokenInput, setTokenInput] = useState('');
  const [tokenError, setTokenError] = useState('');
  const [pendingToken, setPendingToken] = useState<string | null>(null);
  const [studentsLoaded, setStudentsLoaded] = useState(false);
  const [examsLoaded, setExamsLoaded] = useState(false);
  const [startExamBusy, setStartExamBusy] = useState(false);
  const [preStartContext, setPreStartContext] = useState<{
    exam: Exam;
    student: Student;
  } | null>(null);
  const [isDirectLinkMode, setIsDirectLinkMode] = useState(false);

  const parseTokenPayload = (token: string) => {
    const jsonStr = atob(token);
    return JSON.parse(jsonStr);
  };

  const queueTokenLogin = (token: string, directLinkMode = false) => {
    try {
      const payload = parseTokenPayload(token);
      const rawCompanyId = payload?.cid ?? payload?.companyId ?? payload?.company_id ?? 1;
      const parsedCompanyId = Number(rawCompanyId);
      if (!Number.isFinite(parsedCompanyId) || parsedCompanyId <= 0) {
        throw new Error('Invalid company id in token.');
      }
      setIsDirectLinkMode(directLinkMode);
      setTokenError('');
      setAccessRequestContext(null);
      setPreStartContext(null);
      setStudentCompanyId(parsedCompanyId);
      storeStudentCompanyId(parsedCompanyId);
      setPendingToken(token);
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
    }
  }, []);

  useEffect(() => {
    setStudentsLoaded(false);
    setExamsLoaded(false);
    setStudents([]);
    setExams([]);
    setPreStartContext(null);
    setAccessRequestContext(null);
  }, [studentCompanyId]);

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
      } finally {
        if (!cancelled) setStudentsLoaded(true);
      }
    };
    loadStudents();
    return () => {
      cancelled = true;
    };
  }, [studentCompanyId]);

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
      } finally {
        if (!cancelled) setExamsLoaded(true);
      }
    };
    loadExams();
    return () => {
      cancelled = true;
    };
  }, [studentCompanyId]);

  useEffect(() => {
    if (!pendingToken) return;
    if (!studentsLoaded || !examsLoaded) return;
    handleTokenLogin(pendingToken);
    setPendingToken(null);
  }, [pendingToken, studentsLoaded, examsLoaded, exams, students]);

  const getNetworkIdentity = () => {
      const mockIPs = [
          "192.168.1.105", 
          "10.0.0.45", 
          "172.16.0.22", 
          "203.0.113.89"
      ];
      const randomIp = Math.random() > 0.7 ? "203.0.113.89" : mockIPs[Math.floor(Math.random() * mockIPs.length)];
      
      return {
          ip: randomIp,
          userAgent: navigator.userAgent,
          location: randomIp === "203.0.113.89" ? "Library Network (Suspicious Cluster)" : "Residential ISP"
      };
  };

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

      if (!exam) throw new Error("Exam not found or expired.");
      if (!student) throw new Error("Student record not found.");
      if (exam.status === 'ARCHIVED') throw new Error("This exam is archived.");

      const now = Date.now();
      if (now < exam.startTime) {
        throw new Error(`Exam has not started yet. Opens at: ${new Date(exam.startTime).toLocaleString()}`);
      }
      if (now > exam.endTime) {
        throw new Error(`Exam window has closed. Ended at: ${new Date(exam.endTime).toLocaleString()}`);
      }

      setPreStartContext({ exam, student });
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
      } else {
        setTokenError(parsed?.message || e?.message || 'Failed to start exam. Please try again.');
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
        try {
          await apiPost('sessions.php', {
            action: 'terminate',
            examId: activeExam.id,
            studentId: currentStudent.id,
            reason: data.terminationReason || 'Violation threshold reached.',
            violationSummary: data.violationSummary || null,
          });
        } catch (e) {
          console.error('Failed to terminate session:', e);
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

    if (activeExam && currentStudent) {
        try {
          await apiPost('sessions.php', {
            action: 'complete',
            examId: activeExam.id,
            studentId: currentStudent.id,
            answers: data.answers,
            questionIds: data.questions.map(q => q.id),
            questionTimes: data.questionTimes || {}
          });
        } catch (e) {
          console.error('Failed to complete session:', e);
        }
    }
  };

  const handleExitStudent = () => {
    setActiveExam(null);
    setCurrentStudent(null);
    setExamResults(null);
    setSessionId(null);
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
    if (examResults) {
      return (
        <ExamResult 
           exam={activeExam}
           student={currentStudent}
           answers={examResults.answers}
           violations={examResults.violations}
           questions={examResults.questions}
           sessionId={sessionId ?? undefined}
           onExit={handleExitStudent}
        />
      );
    }
    return (
      <ExamTake 
        exam={activeExam} 
        student={currentStudent} 
        sessionId={sessionId ?? undefined}
        onFinish={handleExamFinish} 
      />
    );
  }

  if (isDirectLinkMode) {
    const linkLoading = !preStartContext && !tokenError && (pendingToken !== null || !studentsLoaded || !examsLoaded);
    return (
      <div className="min-h-screen relative overflow-hidden lsc-gradient-bg">
        <div className="absolute -top-24 -left-16 h-72 w-72 rounded-full bg-blue-200/30 blur-3xl"></div>
        <div className="absolute -bottom-28 -right-12 h-80 w-80 rounded-full bg-orange-200/30 blur-3xl"></div>
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
              <div className="flex items-start gap-2 text-sm text-red-600 bg-red-50 p-3 rounded-lg border border-red-100">
                <AlertCircle size={16} className="mt-0.5 shrink-0" />
                <span>{tokenError}</span>
              </div>
            )}

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
    <div className="min-h-screen relative overflow-hidden lsc-gradient-bg">
      <div className="absolute -top-20 right-10 h-56 w-56 rounded-full bg-blue-200/30 blur-3xl"></div>
      <div className="absolute -bottom-32 left-8 h-72 w-72 rounded-full bg-orange-200/30 blur-3xl"></div>
      <div className="relative z-10 min-h-screen flex items-center justify-center p-6">
        <div className="w-full max-w-lg space-y-8 lsc-card p-8">
          <div className="text-center space-y-2">
            <div className="mx-auto h-14 w-14 lsc-brand-mark text-sm">
              LSC
            </div>
            <h1 className="text-3xl font-semibold text-slate-900">LSC Exam Proctor</h1>
            <p className="text-slate-500">Student Exam Access</p>
          </div>

          <div className="space-y-6">
            <div>
              <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-[0.2em] mb-3">Enter Exam</h3>
              <form onSubmit={handleManualTokenSubmit} className="space-y-3">
                <div className="relative">
                  <KeyRound className="absolute left-3 top-3.5 text-slate-400" size={20} />
                  <input 
                    type="text" 
                    placeholder="Paste your exam token" 
                    className="w-full pl-10 pr-4 py-3.5 border border-slate-200 rounded-xl outline-none text-slate-800 bg-white"
                    value={tokenInput}
                    onChange={e => setTokenInput(e.target.value)}
                  />
                </div>
                {tokenError && (
                  <div className="flex items-start gap-2 text-sm text-red-600 bg-red-50 p-3 rounded-lg border border-red-100">
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

  useEffect(() => {
    document.documentElement.classList.toggle('admin-compact', isAdminRoute);
    return () => {
      document.documentElement.classList.remove('admin-compact');
    };
  }, [isAdminRoute]);

  return isAdminRoute ? <AdminApp /> : <StudentApp />;
}
