import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AlertOctagon, Radio, Search, Users, ShieldAlert, TrendingUp, User } from 'lucide-react';
import { apiGet, apiPost } from '../../services/api';
import { Pagination, usePagination } from './Pagination';
import { groupViolationEpisodes, formatEpisodeDuration } from '../../services/violationEpisodes';
import { AccessRequestRecord, Exam, Student } from '../../types';

type ViolationFeedItem = {
  id: number;
  sessionId?: number | null;
  examId: string;
  studentId: string;
  type: string;
  category?: string | null;
  confidence?: number | null;
  timestamp: number;
  snapshot?: string | null;
  description?: string;
  metadata?: Record<string, any> | null;
  review?: {
    decision?: string | null;
    note?: string | null;
    reviewer?: string | null;
    reviewedAt?: number | null;
  };
};

/** One real incident. `episodeCount` is how many raw detector events it produced. */
type IncidentItem = ViolationFeedItem & { episodeCount: number; episodeMs: number };

export const SecurityFeed: React.FC<{ exams: Exam[]; students: Student[] }> = ({ exams, students }) => {
  const [alerts, setAlerts] = useState<ViolationFeedItem[]>([]);
  const [accessRequests, setAccessRequests] = useState<AccessRequestRecord[]>([]);
  const [requestBusyId, setRequestBusyId] = useState<number | null>(null);
  const [snapshotView, setSnapshotView] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [selectedStudentId, setSelectedStudentId] = useState<string | null>(null);
  const [selectedExamId, setSelectedExamId] = useState<string | null>(null);
  // Drops responses that arrive after the screen was closed.
  const mountedRef = useRef(true);

  const loadAlerts = async () => {
    try {
      const data = await apiGet<{ violations: ViolationFeedItem[] }>('violations.php?limit=150');
      if (mountedRef.current && data?.violations) {
        setAlerts(data.violations);
      }
    } catch (e) {
      console.error('Failed to load violations:', e);
    }
  };

  const loadAccessRequests = async () => {
    try {
      const data = await apiGet<{ requests: AccessRequestRecord[] }>('access_requests.php?limit=150');
      if (mountedRef.current && data?.requests) {
        setAccessRequests(data.requests);
      }
    } catch (e) {
      console.error('Failed to load access requests:', e);
    }
  };

  useEffect(() => {
    mountedRef.current = true;
    let inFlight = false;
    const load = async () => {
      // Skip a tick while the previous refresh is still running (the violation feed carries base64
      // snapshots and can be slow), and while the tab is hidden.
      if (!mountedRef.current || inFlight || document.hidden) return;
      inFlight = true;
      try {
        await loadAlerts();
        await loadAccessRequests();
      } finally {
        inFlight = false;
      }
    };
    void load();
    const id = window.setInterval(load, 10000);
    document.addEventListener('visibilitychange', load);
    return () => {
      mountedRef.current = false;
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', load);
    };
  }, []);

  // Escape closes the snapshot viewer.
  useEffect(() => {
    if (!snapshotView) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setSnapshotView(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [snapshotView]);

  // The feed reports INCIDENTS, not raw detector pings. A candidate whose webcam feeds a placeholder
  // image for 19 minutes generates 100+ NO_FACE rows; listing each one buried the events that
  // actually matter (a phone, a second face) and made every count meaningless. Every stat and list
  // below is therefore built from grouped incidents, not raw alerts.
  const incidents = useMemo<IncidentItem[]>(
    () => groupViolationEpisodes(alerts).map(ep => ({
      ...ep.first,
      description: ep.description || ep.first.description,
      snapshot: ep.snapshot ?? ep.first.snapshot,
      episodeCount: ep.count,
      episodeMs: ep.durationMs,
    })),
    [alerts],
  );

  const alertsSorted = useMemo(() => {
    return [...incidents].sort((a, b) => b.timestamp - a.timestamp);
  }, [incidents]);

  const requestsSorted = useMemo(() => {
    return [...accessRequests].sort((a, b) => b.requestedAt - a.requestedAt);
  }, [accessRequests]);

  const studentStats = useMemo(() => {
    const now = Date.now();
    const severeTypes = new Set([
      'PHONE_DETECTED',
      'ANOMALY_OBJECT',
      'MULTIPLE_FACES',
      'NO_FACE',
      'TAB_SWITCH',
      'COPY_PASTE',
      'FULLSCREEN_EXIT',
      'IDENTITY_CHANGE',
      'SUSPICIOUS_BEHAVIOR',
    ]);

    const stats = new Map<string, {
      student: Student;
      total: number;
      lastSeen: number | null;
      recent24h: number;
      severeCount: number;
      types: Map<string, number>;
      exams: Set<string>;
      score: number;
    }>();

    students.forEach(s => {
      stats.set(s.id, {
        student: s,
        total: 0,
        lastSeen: null,
        recent24h: 0,
        severeCount: 0,
        types: new Map(),
        exams: new Set(),
        score: 0,
      });
    });

    incidents.forEach(a => {
      const entry = stats.get(a.studentId);
      if (!entry) return;
      entry.total += 1;
      entry.lastSeen = entry.lastSeen ? Math.max(entry.lastSeen, a.timestamp) : a.timestamp;
      if (now - a.timestamp < 24 * 60 * 60 * 1000) entry.recent24h += 1;
      if (severeTypes.has(a.type)) entry.severeCount += 1;
      entry.types.set(a.type, (entry.types.get(a.type) || 0) + 1);
      entry.exams.add(a.examId);
    });

    stats.forEach(entry => {
      entry.score = entry.total * 2 + entry.severeCount * 3 + entry.recent24h * 2;
    });

    return Array.from(stats.values()).sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const nameA = a.student.fullName.toLowerCase();
      const nameB = b.student.fullName.toLowerCase();
      return nameA.localeCompare(nameB);
    });
  }, [incidents, students]);

  const analysis = useMemo(() => {
    const now = Date.now();
    const totalAlerts = incidents.length;
    const recentAlerts = incidents.filter(a => now - a.timestamp < 24 * 60 * 60 * 1000).length;
    const flaggedStudents = new Set(incidents.map(a => a.studentId)).size;
    const typeCount = new Map<string, number>();
    incidents.forEach(a => typeCount.set(a.type, (typeCount.get(a.type) || 0) + 1));
    const topTypes = Array.from(typeCount.entries()).sort((a, b) => b[1] - a[1]).slice(0, 3);
    const topStudent = studentStats.find(s => s.total > 0) || null;
    return { totalAlerts, recentAlerts, flaggedStudents, topTypes, topStudent };
  }, [incidents, studentStats]);

  const examStats = useMemo(() => {
    const stats = new Map<string, { exam: Exam; total: number; lastSeen: number | null; types: Map<string, number> }>();
    exams.forEach(exam => {
      stats.set(exam.id, { exam, total: 0, lastSeen: null, types: new Map() });
    });

    incidents.forEach(alert => {
      const entry = stats.get(alert.examId);
      if (!entry) return;
      entry.total += 1;
      entry.lastSeen = entry.lastSeen ? Math.max(entry.lastSeen, alert.timestamp) : alert.timestamp;
      entry.types.set(alert.type, (entry.types.get(alert.type) || 0) + 1);
    });

    return Array.from(stats.values()).sort((a, b) => {
      if (b.total !== a.total) return b.total - a.total;
      return a.exam.title.localeCompare(b.exam.title);
    });
  }, [incidents, exams]);

  const filtered = useMemo(() => {
    let list = alertsSorted;
    if (selectedStudentId) {
      list = list.filter(a => a.studentId === selectedStudentId);
    }
    if (selectedExamId) {
      list = list.filter(a => a.examId === selectedExamId);
    }
    if (!search.trim()) return list;
    const term = search.toLowerCase();
    return list.filter(a => {
      const student = students.find(s => s.id === a.studentId);
      const exam = exams.find(e => e.id === a.examId);
      return (
        a.type.toLowerCase().includes(term) ||
        (student?.fullName || '').toLowerCase().includes(term) ||
        (exam?.title || '').toLowerCase().includes(term) ||
        a.examId.toLowerCase().includes(term) ||
        a.studentId.toLowerCase().includes(term)
      );
    });
  }, [alertsSorted, search, exams, students, selectedStudentId, selectedExamId]);

  // Every long list on this screen pages independently — the feed and the risk panels each grow
  // without bound on a busy exam day.
  const feedPaging = usePagination(filtered, `${search}|${selectedStudentId}|${selectedExamId}`);
  const studentPaging = usePagination(studentStats, search, 10);
  const examPaging = usePagination(examStats, search, 9);
  const requestPaging = usePagination(requestsSorted, '', 10);

  const getRiskLabel = (score: number) => {
    if (score >= 18) return { label: 'High', tone: 'bg-red-100 text-red-700 border-red-200' };
    if (score >= 8) return { label: 'Medium', tone: 'bg-amber-100 text-amber-700 border-amber-200' };
    if (score > 0) return { label: 'Low', tone: 'bg-teal-100 text-teal-700 border-teal-200' };
    return { label: 'Clear', tone: 'bg-slate-100 text-slate-600 border-slate-200' };
  };

  const getAdminReviewer = () => {
    if (typeof window === 'undefined') return 'ADMIN';
    try {
      const raw = localStorage.getItem('pg_admin_auth');
      if (!raw) return 'ADMIN';
      const parsed = JSON.parse(raw);
      return parsed?.email || parsed?.name || 'ADMIN';
    } catch {
      return 'ADMIN';
    }
  };

  const getAdminRole = () => {
    if (typeof window === 'undefined') return 'ADMIN';
    try {
      const raw = localStorage.getItem('pg_admin_auth');
      if (!raw) return 'ADMIN';
      const parsed = JSON.parse(raw);
      return String(parsed?.role || 'ADMIN').toUpperCase();
    } catch {
      return 'ADMIN';
    }
  };

  const handleAccessDecision = async (requestId: number, decision: 'GRANTED' | 'REVOKED') => {
    if (requestBusyId !== null) return;
    // A decision is final in this UI (both buttons lock once the request leaves PENDING), so make a
    // stray click on Revoke — which sits right next to Grant — recoverable.
    if (decision === 'REVOKED' && !window.confirm('Revoke this access request? The student will not be allowed to continue with this request.')) return;
    setRequestBusyId(requestId);
    try {
      await apiPost('access_requests.php', {
        action: 'review',
        requestId,
        decision,
        reviewer: getAdminReviewer(),
      });
      await loadAccessRequests();
    } catch (e) {
      console.error('Failed to review access request:', e);
      alert('Failed to update request status.');
    } finally {
      setRequestBusyId(null);
    }
  };

  const currentAdminRole = getAdminRole();

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h2 className="lsc-title flex items-center gap-2">
            <Radio size={20} className="text-rose-500" /> Security Feed
          </h2>
          <p className="lsc-subtitle mt-1">Student-based risk analysis with live violation evidence.</p>
        </div>
        <div className="relative">
          <Search className="absolute left-3 top-2.5 text-slate-400" size={16} />
          <input
            type="text"
            placeholder="Search student, exam, or type..."
            aria-label="Search student, exam, or type"
            className="pl-9 pr-4 py-2 border border-slate-200 rounded-lg outline-none w-full lg:w-72 text-sm bg-white"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
        <div>
          <select
            value={selectedExamId || 'ALL'}
            onChange={e => setSelectedExamId(e.target.value === 'ALL' ? null : e.target.value)}
            aria-label="Filter by exam"
            className="px-3 py-2 border border-slate-200 rounded-lg text-sm outline-none bg-white"
          >
            <option value="ALL">All Exams</option>
            {exams.map(exam => (
              <option key={exam.id} value={exam.id}>{exam.title}</option>
            ))}
          </select>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lsc-panel p-4 h-full">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs uppercase tracking-widest text-slate-400">Total Alerts</p>
              <div className="text-2xl font-semibold text-slate-900">{analysis.totalAlerts}</div>
            </div>
            <div className="h-10 w-10 rounded-full bg-rose-50 text-rose-600 flex items-center justify-center">
              <AlertOctagon size={18} />
            </div>
          </div>
          <div className="mt-3 text-xs text-slate-500">Last 24h: {analysis.recentAlerts}</div>
        </div>
        <div className="lsc-panel p-4 h-full">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs uppercase tracking-widest text-slate-400">Flagged Students</p>
              <div className="text-2xl font-semibold text-slate-900">{analysis.flaggedStudents}</div>
            </div>
            <div className="h-10 w-10 rounded-full bg-blue-50 text-blue-600 flex items-center justify-center">
              <Users size={18} />
            </div>
          </div>
          {analysis.topStudent && (
            <div className="mt-3 text-xs text-slate-500">
              Highest risk: {analysis.topStudent.student.fullName}
            </div>
          )}
        </div>
        <div className="lsc-panel p-4 h-full">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs uppercase tracking-widest text-slate-400">Top Violation Types</p>
              <div className="text-sm font-semibold text-slate-900">Patterns</div>
            </div>
            <div className="h-10 w-10 rounded-full bg-teal-50 text-teal-600 flex items-center justify-center">
              <TrendingUp size={18} />
            </div>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            {analysis.topTypes.length === 0 && (
              <span className="text-xs text-slate-400">No data yet</span>
            )}
            {analysis.topTypes.map(([type, count]) => (
              <span key={type} className="text-[11px] px-2 py-1 rounded-full bg-slate-100 text-slate-600 border border-slate-200">
                {type.replace('_', ' ')} - {count}
              </span>
            ))}
          </div>
        </div>
      </div>

      <div className="lsc-panel p-4">
        <div className="flex items-center justify-between mb-3">
          <div className="text-sm font-semibold text-slate-800">Exam Alerts</div>
          <button
            onClick={() => setSelectedExamId(null)}
            className="text-xs text-slate-500 hover:text-slate-800"
          >
            Clear
          </button>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {examStats.length === 0 && (
            <div className="text-xs text-slate-400">No exam alerts yet.</div>
          )}
          {examPaging.pageItems.map(entry => {
            const isActive = selectedExamId === entry.exam.id;
            return (
              <button
                key={entry.exam.id}
                onClick={() => setSelectedExamId(entry.exam.id)}
                className={`text-left p-3 rounded-lg border transition-all ${
                  isActive ? 'border-blue-300 bg-blue-50/60 shadow-sm' : 'border-slate-200 hover:bg-slate-50'
                }`}
              >
                <div className="text-sm font-semibold text-slate-900 truncate">{entry.exam.title}</div>
                <div className="text-[11px] text-slate-500 mt-1">
                  Alerts: <span className="font-semibold text-slate-800">{entry.total}</span>
                </div>
                <div className="text-[10px] text-slate-400 mt-1">
                  Last seen: {entry.lastSeen ? new Date(entry.lastSeen).toLocaleString() : '-'}
                </div>
              </button>
            );
          })}
        </div>
        <Pagination state={examPaging} label="exams" hidePageSize className="-mx-4 -mb-4 mt-3 rounded-b-xl" />
      </div>

      <div className="lsc-panel p-4">
        <div className="flex items-center justify-between mb-3">
          <div className="text-sm font-semibold text-slate-800">Access & Device Requests</div>
          <span className="text-xs text-slate-500">
            Pending: {requestsSorted.filter(r => r.status === 'PENDING').length}
          </span>
        </div>
        <div className="space-y-3 max-h-[380px] overflow-y-auto">
          {requestsSorted.length === 0 && (
            <p className="text-xs text-slate-400">No access requests yet.</p>
          )}
          {requestPaging.pageItems.map(request => {
            const student = students.find(s => s.id === request.studentId);
            const exam = exams.find(e => e.id === request.examId);
            const pending = request.status === 'PENDING';
            const typeEntries = Object.entries(request.violationSummary?.byType || {}).filter(([, count]) => Number(count) > 0);
            return (
              <div key={request.id} className="rounded-lg border border-slate-200 p-3 bg-white">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <div className="text-sm font-semibold text-slate-900">
                      {student?.fullName || request.studentId} - {exam?.title || request.examId}
                    </div>
                    <div className="text-[11px] text-slate-500">
                      {request.requestType === 'DEVICE_CHANGE' ? 'Device change' : 'Reattempt'} requested: {new Date(request.requestedAt).toLocaleString()}
                    </div>
                  </div>
                  <span className={`text-[10px] px-2 py-1 rounded-full border ${
                    request.status === 'PENDING'
                      ? 'bg-amber-100 text-amber-700 border-amber-200'
                      : request.status === 'GRANTED'
                        ? 'bg-teal-100 text-teal-700 border-teal-200'
                        : 'bg-rose-100 text-rose-700 border-rose-200'
                  }`}>
                    {request.status}
                  </span>
                </div>
                {request.reason && (
                  <p className="text-xs text-slate-600 mt-2">{request.reason}</p>
                )}
                {request.requestType === 'DEVICE_CHANGE' && (
                  <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-2 text-[11px]">
                    <div className="px-2 py-1 rounded border border-amber-200 bg-amber-50 text-amber-800">
                      Previous device: <span className="font-mono">{request.previousDeviceFingerprint?.slice(0, 16) || 'Unknown'}</span>
                    </div>
                    <div className="px-2 py-1 rounded border border-blue-200 bg-blue-50 text-blue-800">
                      New device: <span className="font-mono">{request.newDeviceFingerprint?.slice(0, 16) || 'Unknown'}</span>
                    </div>
                  </div>
                )}
                <div className="mt-2 grid grid-cols-2 sm:grid-cols-4 gap-2 text-[11px]">
                  <div className="px-2 py-1 rounded border border-slate-200 bg-slate-50">
                    Camera: <span className="font-semibold">{request.violationSummary?.byCategory?.camera ?? 0}</span>
                  </div>
                  <div className="px-2 py-1 rounded border border-slate-200 bg-slate-50">
                    Mic: <span className="font-semibold">{request.violationSummary?.byCategory?.microphone ?? 0}</span>
                  </div>
                  <div className="px-2 py-1 rounded border border-slate-200 bg-slate-50">
                    Fullscreen: <span className="font-semibold">{request.violationSummary?.byCategory?.fullscreen ?? 0}</span>
                  </div>
                  <div className="px-2 py-1 rounded border border-slate-200 bg-slate-50">
                    Copy/Paste: <span className="font-semibold">{request.violationSummary?.byCategory?.copyPaste ?? 0}</span>
                  </div>
                </div>
                {typeEntries.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {typeEntries.map(([type, count]) => (
                      <span key={type} className="text-[10px] px-2 py-1 rounded-full border border-slate-200 bg-slate-50 text-slate-600">
                        {type.replace(/_/g, ' ')}: {count}
                      </span>
                    ))}
                  </div>
                )}
                <div className="mt-3 flex gap-2">
                  <button
                    onClick={() => handleAccessDecision(request.id, 'GRANTED')}
                    disabled={!pending || requestBusyId === request.id || (request.requestType === 'DEVICE_CHANGE' && currentAdminRole !== 'SUPER_ADMIN')}
                    className="px-3 py-1.5 rounded border border-teal-200 text-teal-700 text-xs font-semibold hover:bg-teal-50 disabled:opacity-60"
                  >
                    Grant Access
                  </button>
                  <button
                    onClick={() => handleAccessDecision(request.id, 'REVOKED')}
                    disabled={!pending || requestBusyId === request.id || (request.requestType === 'DEVICE_CHANGE' && currentAdminRole !== 'SUPER_ADMIN')}
                    className="px-3 py-1.5 rounded border border-rose-200 text-rose-700 text-xs font-semibold hover:bg-rose-50 disabled:opacity-60"
                  >
                    Revoke Access
                  </button>
                </div>
                {request.requestType === 'DEVICE_CHANGE' && currentAdminRole !== 'SUPER_ADMIN' && (
                  <div className="mt-2 text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                    Device change requests require super admin approval.
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <Pagination state={requestPaging} label="requests" hidePageSize className="-mx-4 -mb-4 mt-3 rounded-b-xl" />
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-[360px_1fr] gap-6">
        <div className="lsc-panel overflow-hidden">
          <div className="p-4 lsc-panel-header flex items-center justify-between">
            <h3 className="font-semibold text-slate-800 flex items-center gap-2">
              <User size={16} className="text-[var(--lsc-primary)]" /> Student Risk Analysis
            </h3>
            <button
              onClick={() => setSelectedStudentId(null)}
              className="text-xs text-slate-500 hover:text-slate-800"
            >
              Clear
            </button>
          </div>
          <div className="p-4 space-y-3 max-h-[640px] overflow-y-auto">
            {studentPaging.pageItems.map(entry => {
              const risk = getRiskLabel(entry.score);
              const isActive = selectedStudentId === entry.student.id;
              return (
                <button
                  key={entry.student.id}
                  onClick={() => setSelectedStudentId(entry.student.id)}
                  className={`w-full text-left p-3 rounded-xl border transition-all ${
                    isActive ? 'border-blue-300 bg-blue-50/60 shadow-sm' : 'border-slate-200 hover:bg-slate-50'
                  }`}
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-sm font-semibold text-slate-900">{entry.student.fullName}</div>
                      <div className="text-[11px] text-slate-500">{entry.student.registrationId}</div>
                    </div>
                    <span className={`text-[10px] px-2 py-1 rounded-full border ${risk.tone}`}>
                      {risk.label}
                    </span>
                  </div>
                  <div className="mt-3 grid grid-cols-3 gap-2 text-[11px] text-slate-600">
                    <div className="bg-white border border-slate-200 rounded-lg px-2 py-1">
                      Total: <span className="font-semibold text-slate-800">{entry.total}</span>
                    </div>
                    <div className="bg-white border border-slate-200 rounded-lg px-2 py-1">
                      24h: <span className="font-semibold text-slate-800">{entry.recent24h}</span>
                    </div>
                    <div className="bg-white border border-slate-200 rounded-lg px-2 py-1">
                      Exams: <span className="font-semibold text-slate-800">{entry.exams.size}</span>
                    </div>
                  </div>
                  <div className="mt-2 text-[10px] text-slate-400">
                    Last seen: {entry.lastSeen ? new Date(entry.lastSeen).toLocaleString() : '-'}
                  </div>
                </button>
              );
            })}
          </div>
          <Pagination state={studentPaging} label="students" hidePageSize />
        </div>

        <div className="lsc-panel overflow-hidden">
          <div className="p-4 lsc-panel-header flex justify-between items-center">
            <h3 className="font-semibold text-slate-800 flex items-center gap-2">
              <ShieldAlert size={16} className="text-rose-600" /> Live Security Feed
            </h3>
            <span className="text-xs font-mono text-slate-500">REAL-TIME</span>
          </div>
          <div className="p-4 space-y-4 max-h-[640px] overflow-y-auto">
            {feedPaging.pageItems.map(alert => {
              const student = students.find(s => s.id === alert.studentId);
              const exam = exams.find(e => e.id === alert.examId);
              const status = alert.review?.decision || 'PENDING';
              return (
                <div key={alert.id} className="flex items-start gap-3 p-3 rounded-lg border border-rose-100 bg-rose-50/30">
                  <div className="mt-1">
                    <AlertOctagon size={16} className="text-rose-600" />
                  </div>
                  <div className="flex-1">
                    <div className="flex justify-between items-start gap-2">
                      <span className="text-sm font-bold text-slate-900">
                        {alert.type.replace('_', ' ')}
                        {alert.episodeCount > 1 && alert.episodeMs >= 1000 && (
                          <span className="ml-2 text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-slate-100 text-slate-600 border border-slate-200 align-middle">
                            continuous · {formatEpisodeDuration(alert.episodeMs)} · {alert.episodeCount}×
                          </span>
                        )}
                      </span>
                      <span className="text-xs text-slate-400 shrink-0">{new Date(alert.timestamp).toLocaleString()}</span>
                    </div>
                    <p className="text-xs text-slate-600 mt-1">
                      <span className="font-medium text-slate-800">{student?.fullName || alert.studentId}</span> in {exam?.title || alert.examId}
                    </p>
                    <div className="mt-1">
                      <span className={`text-[10px] px-2 py-0.5 rounded-full border ${
                        status === 'PENDING'
                          ? 'bg-amber-100 text-amber-700 border-amber-200'
                          : status === 'CLEARED'
                            ? 'bg-teal-100 text-teal-700 border-teal-200'
                            : status === 'ESCALATED'
                              ? 'bg-rose-100 text-rose-700 border-rose-200'
                              : 'bg-slate-100 text-slate-600 border-slate-200'
                      }`}>
                        {status}
                      </span>
                      {(alert.category || (alert.confidence !== null && alert.confidence !== undefined)) && (
                        <span className="ml-2 text-[10px] px-2 py-0.5 rounded-full border border-slate-200 bg-white text-slate-500">
                          {alert.category || 'event'}{alert.confidence !== null && alert.confidence !== undefined ? ` · ${Math.round(alert.confidence * 100)}%` : ''}
                        </span>
                      )}
                    </div>
                    {alert.description && (
                      <p className="text-[11px] text-slate-500 mt-1">{alert.description}</p>
                    )}
                    {alert.snapshot && (
                      <button
                        onClick={() => setSnapshotView(alert.snapshot || null)}
                        className="mt-2 text-[10px] font-semibold text-blue-600 hover:underline"
                      >
                        View Photo
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
            {filtered.length === 0 && (
              <p className="text-xs text-slate-400 text-center py-6">
                {alertsSorted.length > 0 && (search.trim() || selectedStudentId || selectedExamId)
                  ? 'No alerts match the current filters.'
                  : 'No security alerts yet.'}
              </p>
            )}
          </div>
          <Pagination state={feedPaging} label="alerts" />
        </div>
      </div>

      {snapshotView && (
        <div className="fixed inset-0 z-[200] bg-slate-900/50 flex items-center justify-center p-4" onClick={() => setSnapshotView(null)}>
          <div
            className="bg-white rounded-xl shadow-2xl max-w-3xl w-full overflow-hidden max-h-[92vh] overflow-y-auto"
            onClick={e => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label="Violation snapshot"
          >
            <div className="flex items-center justify-between p-4 border-b border-slate-200">
              <h4 className="font-semibold text-slate-800">Violation Snapshot</h4>
              <button
                onClick={() => setSnapshotView(null)}
                className="text-sm text-slate-500 hover:text-slate-800"
                title="Close (Esc)"
              >
                Close
              </button>
            </div>
            <div className="p-4 bg-slate-50">
              <img src={snapshotView} alt="Violation snapshot" className="w-full h-auto rounded-lg border border-slate-200" />
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
