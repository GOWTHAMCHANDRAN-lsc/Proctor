import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Download, Film, Camera, Monitor, Layers, Search, ShieldAlert, ShieldCheck, RefreshCw, ScanSearch, Loader2 } from 'lucide-react';
import { apiGet, apiPost } from '../../services/api';
import { Pagination, usePagination } from './Pagination';
import { groupViolationEpisodes, isSustained, formatEpisodeDuration } from '../../services/violationEpisodes';
import { Exam, RecordingSessionRecord, RecordingSummary, RecordingStreamType, Student, ViolationLog } from '../../types';

interface RecordingsProps {
  exams: Exam[];
  students: Student[];
}

interface RecordingViolation extends ViolationLog {
  id?: number | string;
  sessionId?: number | null;
}

const VIOLATION_LABELS: Record<ViolationLog['type'], string> = {
  TAB_SWITCH: 'Tab switch',
  NO_FACE: 'No face',
  MULTIPLE_FACES: 'Multiple faces',
  GAZE_AWAY: 'Looking away',
  AUDIO_DETECTED: 'Audio / speech',
  FULLSCREEN_EXIT: 'Fullscreen exit',
  COPY_PASTE: 'Copy / paste',
  PHONE_DETECTED: 'Phone detected',
  ANOMALY_OBJECT: 'Unauthorized item',
  LOCATION_CHANGE: 'Location change',
  IDENTITY_CHANGE: 'Identity change',
  SUSPICIOUS_BEHAVIOR: 'Suspicious behavior',
};

const violationSeverity = (v: RecordingViolation): 'high' | 'medium' | 'low' => {
  const meta = (v.metadata?.severity as string | undefined)?.toLowerCase();
  if (meta === 'high' || meta === 'medium' || meta === 'low') return meta;
  if (['MULTIPLE_FACES', 'PHONE_DETECTED', 'IDENTITY_CHANGE', 'COPY_PASTE'].includes(v.type)) return 'high';
  if (v.type === 'GAZE_AWAY') return 'low';
  return 'medium';
};

const severityChip: Record<'high' | 'medium' | 'low', string> = {
  high: 'bg-rose-100 text-rose-700 border-rose-200',
  medium: 'bg-amber-100 text-amber-700 border-amber-200',
  low: 'bg-slate-100 text-slate-600 border-slate-200',
};

const formatOffset = (seconds: number): string => {
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r.toString().padStart(2, '0')}`;
};


const resolveVideoUrl = (raw?: string | null) => {
  if (!raw) return null;
  if (raw.startsWith('http://') || raw.startsWith('https://') || raw.startsWith('/')) return raw;
  return `/api/${raw}`;
};

// Stream size for the button label. Rounding to whole MB labelled every short (<0.5 MB) recording
// "0MB", which read as an empty/broken file even though it plays.
const formatStreamSize = (bytes?: number | null): string => {
  const b = bytes || 0;
  if (b <= 0) return '0MB';
  if (b < 1024 * 1024) return `${Math.max(1, Math.round(b / 1024))}KB`;
  return `${Math.round(b / 1024 / 1024)}MB`;
};

// Staff role from the stored auth payload. Recheck is ADMIN / SUPER_ADMIN only server-side
// (recordings.php RECHECK), but this screen is also open to proctors.
const getStoredAdminRole = (): string => {
  if (typeof window === 'undefined') return '';
  try {
    const raw = localStorage.getItem('pg_admin_auth');
    return raw ? String(JSON.parse(raw)?.role || '').toUpperCase() : '';
  } catch {
    return '';
  }
};

export const Recordings: React.FC<RecordingsProps> = ({ exams, students }) => {
  const [summary, setSummary] = useState<RecordingSummary>({
    cameraCount: 0,
    screenCount: 0,
    combinedCount: 0,
    totalCount: 0,
  });
  const [sessions, setSessions] = useState<RecordingSessionRecord[]>([]);
  const [search, setSearch] = useState('');
  const [selectedExamId, setSelectedExamId] = useState('ALL');
  const [selectedStudentId, setSelectedStudentId] = useState('ALL');
  const [selectedStatus, setSelectedStatus] = useState<'ALL' | RecordingSessionRecord['status']>('ALL');
  const [selectedStreamType, setSelectedStreamType] = useState<'ALL' | RecordingStreamType>('ALL');
  const [activeStream, setActiveStream] = useState<{ label: string; url: string; live: boolean; startedAt: number } | null>(null);
  const [streamRefreshNonce, setStreamRefreshNonce] = useState(0);
  const [videoError, setVideoError] = useState<string | null>(null);
  const [sessionViolations, setSessionViolations] = useState<RecordingViolation[]>([]);
  const [violationsLoading, setViolationsLoading] = useState(false);
  const [recheckStarting, setRecheckStarting] = useState<Record<number, boolean>>({});
  const videoRef = useRef<HTMLVideoElement>(null);
  const canRecheck = ['ADMIN', 'SUPER_ADMIN'].includes(getStoredAdminRole());
  // Guards for the 15s list refresh: never stack overlapping list requests, and drop responses that
  // land after the screen was closed.
  const loadInFlightRef = useRef(false);
  const mountedRef = useRef(true);
  // Identifies the stream whose proctoring timeline is currently wanted, so a slow violations response
  // for a previously opened (or already closed) recording can't overwrite the current one.
  const violationsReqRef = useRef(0);

  const load = async () => {
    loadInFlightRef.current = true;
    try {
      const [sumRes, listRes] = await Promise.all([
        apiGet<{ summary: RecordingSummary }>('recordings.php?mode=summary'),
        apiGet<{ recordings: RecordingSessionRecord[] }>('recordings.php?mode=list&limit=250'),
      ]);
      if (!mountedRef.current) return;
      if (sumRes?.summary) setSummary(sumRes.summary);
      if (listRes?.recordings) setSessions(listRes.recordings);
    } catch (e) {
      console.error('Failed to load recordings:', e);
    } finally {
      loadInFlightRef.current = false;
    }
  };

  useEffect(() => {
    mountedRef.current = true;
    void load();
    // Background refresh: paused while the tab is hidden (catches up as soon as it is visible again)
    // and skipped while a previous refresh is still running. Explicit loads (e.g. after Recheck)
    // always run.
    const tick = () => { if (!document.hidden && !loadInFlightRef.current) void load(); };
    const id = window.setInterval(tick, 15000);
    const onVisible = tick;
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      mountedRef.current = false;
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  // Starts an on-demand re-analysis of this recording's camera stream against the live AI
  // detector — the same manual workflow used to catch what live detection missed, now a button.
  // The job runs in the background server-side; the 15s auto-refresh above picks up its
  // PENDING -> RUNNING -> DONE/FAILED status as it progresses, no separate polling needed.
  const handleRecheck = async (recordingId: number) => {
    setRecheckStarting(prev => ({ ...prev, [recordingId]: true }));
    try {
      await apiPost('recordings.php', { action: 'RECHECK', recordingId });
      await load();
    } catch (e: any) {
      alert(e?.message || 'Could not start recheck.');
    } finally {
      setRecheckStarting(prev => ({ ...prev, [recordingId]: false }));
    }
  };

  // NOTE: a live recording is deliberately NOT auto-refreshed.
  //
  // This used to bump streamRefreshNonce every 5s, which fed both the <video> `key` and a
  // cache-busting query param — so the element was destroyed and rebuilt every 5 seconds, each time
  // restarting the download of the WHOLE file from byte 0. Once a recording passed a few MB (they
  // reach 70MB+ within the hour) it could never buffer enough to paint a frame before the next
  // teardown, and the admin just saw a permanently blank player while the live wall worked fine.
  //
  // The file on disk is an append-only WebM, so re-reading it from the start is the ONLY way to
  // pick up newly written data anyway. That is a deliberate, explicit action now (the Reload
  // button), not something that fires under the admin every 5 seconds.

  // Only sessions that actually captured something are worth showing. Every page reload / reconnect
  // re-INITs a new recording_session, so a student who refreshes a few times leaves several
  // same-name rows behind — most of them empty (INIT, then the tab closed before any chunk). We keep
  // a session if any stream has bytes on disk, or if it's still live (INIT/RECORDING) — the 2-minute
  // server sweep closes truly-dead empties to COMPLETED, at which point they drop out here.
  const dataSessions = useMemo(
    () => sessions.filter(s =>
      s.streams.some(st => st.hasFile) || s.status === 'INIT' || s.status === 'RECORDING'),
    [sessions]
  );

  const examOptions = useMemo(() => {
    const ids = Array.from(new Set(dataSessions.map(s => s.examId)));
    return ids
      .map(id => ({
        id,
        label: exams.find(e => e.id === id)?.title || id,
      }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [dataSessions, exams]);

  const studentOptions = useMemo(() => {
    const ids = Array.from(new Set<string>(dataSessions.map(s => s.studentId)));
    return ids
      .map(id => {
        const student = students.find(s => s.id === id);
        return {
          id,
          label: student ? `${student.fullName} (${student.registrationId})` : id,
        };
      })
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [dataSessions, students]);

  const hasActiveFilters = selectedExamId !== 'ALL'
    || selectedStudentId !== 'ALL'
    || selectedStatus !== 'ALL'
    || selectedStreamType !== 'ALL'
    || search.trim() !== '';

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    const isSearchActive = term !== '';

    if (
      !isSearchActive
      && selectedExamId === 'ALL'
      && selectedStudentId === 'ALL'
      && selectedStatus === 'ALL'
      && selectedStreamType === 'ALL'
    ) {
      return dataSessions;
    }

    return dataSessions.filter(item => {
      if (selectedExamId !== 'ALL' && item.examId !== selectedExamId) return false;
      if (selectedStudentId !== 'ALL' && item.studentId !== selectedStudentId) return false;
      if (selectedStatus !== 'ALL' && item.status !== selectedStatus) return false;
      if (selectedStreamType !== 'ALL') {
        const hasSelectedStream = item.streams.some(
          s => s.streamType === selectedStreamType && s.hasFile
        );
        if (!hasSelectedStream) return false;
      }

      if (!isSearchActive) return true;

      const exam = exams.find(e => e.id === item.examId);
      const student = students.find(s => s.id === item.studentId);
      return (
        item.examId.toLowerCase().includes(term) ||
        item.studentId.toLowerCase().includes(term) ||
        (exam?.title || '').toLowerCase().includes(term) ||
        (student?.fullName || '').toLowerCase().includes(term)
      );
    });
  }, [dataSessions, search, exams, students, selectedExamId, selectedStudentId, selectedStatus, selectedStreamType]);

  const paging = usePagination(filtered, `${search}|${selectedExamId}|${selectedStudentId}|${selectedStatus}|${selectedStreamType}`);

  // One continuous problem produces 100+ raw rows; the timeline shows real incidents instead.
  const timeline = useMemo(() => groupViolationEpisodes(sessionViolations), [sessionViolations]);

  const loadSessionViolations = async (session: RecordingSessionRecord) => {
    const reqId = ++violationsReqRef.current;
    setSessionViolations([]);
    if (!session.sessionId) {
      setViolationsLoading(false);
      return;
    }
    setViolationsLoading(true);
    try {
      const res = await apiGet<{ violations: RecordingViolation[] }>(
        `violations.php?sessionId=${session.sessionId}&limit=2000`
      );
      if (reqId !== violationsReqRef.current || !mountedRef.current) return;
      const list = Array.isArray(res?.violations) ? res.violations : [];
      // Oldest first so the timeline reads top-to-bottom with the video.
      list.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
      setSessionViolations(list);
    } catch (e) {
      if (reqId !== violationsReqRef.current || !mountedRef.current) return;
      console.error('Failed to load session violations:', e);
      setSessionViolations([]);
    } finally {
      if (reqId === violationsReqRef.current && mountedRef.current) setViolationsLoading(false);
    }
  };

  const openStream = (session: RecordingSessionRecord, streamType: 'camera' | 'screen' | 'combined') => {
    const stream = session.streams.find(s => s.streamType === streamType && s.hasFile && !!s.fileUrl);
    const url = resolveVideoUrl(stream?.fileUrl || null);
    if (!url) return;
    const exam = exams.find(e => e.id === session.examId)?.title || session.examId;
    const student = students.find(s => s.id === session.studentId)?.fullName || session.studentId;
    setStreamRefreshNonce(0);
    setVideoError(null);
    setActiveStream({
      label: `${streamType.toUpperCase()} - ${student} - ${exam}`,
      url,
      live: session.status === 'RECORDING' || session.status === 'INIT',
      startedAt: session.startedAt,
    });
    void loadSessionViolations(session);
  };

  const seekToViolation = (v: RecordingViolation) => {
    if (!activeStream || !videoRef.current) return;
    const offset = Math.max(0, (v.timestamp - activeStream.startedAt) / 1000);
    try {
      videoRef.current.currentTime = offset;
      void videoRef.current.play().catch(() => {});
    } catch {
      // ignore seek failures on non-seekable streams
    }
  };

  const closeStream = () => {
    violationsReqRef.current += 1; // discard any timeline request still in flight
    setActiveStream(null);
    setVideoError(null);
    setSessionViolations([]);
    setViolationsLoading(false);
  };

  // Escape closes the player.
  useEffect(() => {
    if (!activeStream) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeStream(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // closeStream only touches refs and state setters, so the latest render's copy is equivalent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeStream]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h2 className="lsc-title flex items-center gap-2">
            <Film size={20} className="text-[var(--lsc-primary)]" /> Recordings
          </h2>
          <p className="lsc-subtitle mt-1">Exam-wise and student-wise camera/screen/combined recordings.</p>
        </div>
      </div>

      <div className="lsc-panel p-4">
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-5 gap-3">
          <div className="relative xl:col-span-2">
            <Search className="absolute left-3 top-2.5 text-slate-400" size={16} />
            <input
              type="text"
              placeholder="Search exam, student, or IDs..."
              aria-label="Search recordings"
              className="pl-9 pr-4 py-2 border border-slate-200 rounded-lg outline-none w-full text-sm bg-white"
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </div>
          <select
            className="px-3 py-2 border border-slate-200 rounded-lg text-sm bg-white outline-none"
            value={selectedExamId}
            onChange={e => setSelectedExamId(e.target.value)}
            aria-label="Filter by exam"
          >
            <option value="ALL">All Exams</option>
            {examOptions.map(opt => (
              <option key={opt.id} value={opt.id}>{opt.label}</option>
            ))}
          </select>
          <select
            className="px-3 py-2 border border-slate-200 rounded-lg text-sm bg-white outline-none"
            value={selectedStudentId}
            onChange={e => setSelectedStudentId(e.target.value)}
            aria-label="Filter by student"
          >
            <option value="ALL">All Students</option>
            {studentOptions.map(opt => (
              <option key={opt.id} value={opt.id}>{opt.label}</option>
            ))}
          </select>
          <select
            className="px-3 py-2 border border-slate-200 rounded-lg text-sm bg-white outline-none"
            value={selectedStatus}
            onChange={e => setSelectedStatus(e.target.value as typeof selectedStatus)}
            aria-label="Filter by status"
          >
            <option value="ALL">All Status</option>
            <option value="INIT">INIT</option>
            <option value="RECORDING">RECORDING</option>
            <option value="COMPLETED">COMPLETED</option>
            <option value="FAILED">FAILED</option>
          </select>
          <select
            className="px-3 py-2 border border-slate-200 rounded-lg text-sm bg-white outline-none"
            value={selectedStreamType}
            onChange={e => setSelectedStreamType(e.target.value as typeof selectedStreamType)}
            aria-label="Filter by stream type"
          >
            <option value="ALL">All Streams</option>
            <option value="camera">Camera</option>
            <option value="screen">Screen</option>
            <option value="combined">Combined</option>
          </select>
        </div>
        <div className="mt-3 flex items-center justify-between">
          <div className="text-xs text-slate-500">
            Showing {filtered.length} of {dataSessions.length} sessions
          </div>
          <button
            type="button"
            onClick={() => {
              setSearch('');
              setSelectedExamId('ALL');
              setSelectedStudentId('ALL');
              setSelectedStatus('ALL');
              setSelectedStreamType('ALL');
            }}
            disabled={!hasActiveFilters}
            className="text-xs px-3 py-1.5 rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50 disabled:opacity-50"
          >
            Clear Filters
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Stat title="Camera Recordings" value={summary.cameraCount} icon={<Camera size={16} className="text-teal-600" />} />
        <Stat title="Screen Recordings" value={summary.screenCount} icon={<Monitor size={16} className="text-orange-600" />} />
        <Stat title="Combined Recordings" value={summary.combinedCount} icon={<Layers size={16} className="text-[var(--lsc-primary)]" />} />
        <Stat title="Total Streams" value={summary.totalCount} icon={<Film size={16} className="text-slate-700" />} />
      </div>

      <div className="lsc-panel overflow-hidden">
        <div className="p-4 lsc-panel-header">
          <h3 className="font-semibold text-slate-800">Recording Sessions</h3>
        </div>
        <div className="overflow-x-auto lsc-table-wrap">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-500">
              <tr>
                <th className="text-left px-4 py-3">Exam</th>
                <th className="text-left px-4 py-3">Student</th>
                <th className="text-left px-4 py-3">Started</th>
                <th className="text-left px-4 py-3">Duration</th>
                <th className="text-left px-4 py-3">Status</th>
                <th className="text-left px-4 py-3">Streams</th>
                <th className="text-left px-4 py-3">Recheck</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {paging.pageItems.map(session => {
                const exam = exams.find(e => e.id === session.examId);
                const student = students.find(s => s.id === session.studentId);
                const cam = session.streams.find(s => s.streamType === 'camera');
                const scr = session.streams.find(s => s.streamType === 'screen');
                const cmb = session.streams.find(s => s.streamType === 'combined');
                return (
                  <tr key={session.id} className="hover:bg-slate-50/60">
                    <td className="px-4 py-3">
                      <div className="font-medium text-slate-900">{exam?.title || session.examId}</div>
                      <div className="text-xs text-slate-400">{session.examId}</div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="font-medium text-slate-900">{student?.fullName || session.studentId}</div>
                      <div className="text-xs text-slate-400">{session.studentId}</div>
                    </td>
                    <td className="px-4 py-3">{new Date(session.startedAt).toLocaleString()}</td>
                    <td className="px-4 py-3">{session.durationSec != null ? formatOffset(session.durationSec) : '—'}</td>
                    <td className="px-4 py-3">
                      <span className={`text-xs px-2 py-1 rounded-full border ${
                        session.status === 'COMPLETED'
                          ? 'bg-teal-100 text-teal-700 border-teal-200'
                          : session.status === 'FAILED'
                            ? 'bg-rose-100 text-rose-700 border-rose-200'
                            : 'bg-amber-100 text-amber-700 border-amber-200'
                      }`}>
                        {session.status}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-2">
                        <StreamButton
                          label={`Camera (${formatStreamSize(cam?.sizeBytes)})`}
                          disabled={!cam?.hasFile}
                          onClick={() => openStream(session, 'camera')}
                        />
                        <StreamButton
                          label={`Screen (${formatStreamSize(scr?.sizeBytes)})`}
                          disabled={!scr?.hasFile}
                          onClick={() => openStream(session, 'screen')}
                        />
                        <StreamButton
                          label={`Combined (${formatStreamSize(cmb?.sizeBytes)})`}
                          disabled={!cmb?.hasFile}
                          onClick={() => openStream(session, 'combined')}
                        />
                      </div>
                      {/* Explain camera-only sessions so a missing screen recording doesn't read as
                          "broken": on phones/tablets screen capture isn't available, and on desktop the
                          candidate may have declined the screen-share prompt. */}
                      {cam?.hasFile && !scr?.hasFile && !cmb?.hasFile && (
                        <div className="text-[11px] text-slate-400 mt-1.5">
                          Camera only — screen not captured (mobile device or screen-share declined)
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {(() => {
                        const starting = !!recheckStarting[session.id];
                        const inFlight = starting || session.recheckStatus === 'PENDING' || session.recheckStatus === 'RUNNING';
                        if (inFlight) {
                          return (
                            <span className="inline-flex items-center gap-1.5 text-xs text-slate-500">
                              <Loader2 size={13} className="animate-spin" /> {session.recheckStatus === 'RUNNING' ? 'Rechecking…' : 'Starting…'}
                            </span>
                          );
                        }
                        return (
                          <div className="flex flex-col gap-1 items-start">
                            <button
                              onClick={() => handleRecheck(session.id)}
                              disabled={!canRecheck || !cam?.hasFile || !session.sessionId}
                              title={!canRecheck
                                ? 'Only admins can start a recheck'
                                : !session.sessionId
                                  ? 'No linked exam session'
                                  : 'Re-analyze this recording against the live AI detector and log any violations it finds'}
                              className="px-2.5 py-1.5 rounded-lg border border-slate-200 text-xs text-slate-600 hover:bg-slate-50 disabled:opacity-40 disabled:hover:bg-transparent inline-flex items-center gap-1.5"
                            >
                              <ScanSearch size={13} /> Recheck
                            </button>
                            {session.recheckStatus === 'DONE' && (
                              <span className="text-[11px] text-emerald-600">
                                {(session.recheckFoundCount ?? 0) > 0
                                  ? `Found ${session.recheckFoundCount} new`
                                  : 'No new violations'}
                              </span>
                            )}
                            {session.recheckStatus === 'FAILED' && (
                              <span className="text-[11px] text-rose-600 max-w-[160px] truncate" title={session.recheckError || ''}>
                                Failed: {session.recheckError || 'unknown error'}
                              </span>
                            )}
                          </div>
                        );
                      })()}
                    </td>
                  </tr>
                );
              })}
              {filtered.length === 0 && (
                <tr>
                  <td className="px-4 py-8 text-center text-slate-400" colSpan={7}>
                    No recordings found.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <Pagination state={paging} label="sessions" />
      </div>

      {activeStream && (
        <div className="fixed inset-0 z-[220] bg-slate-900/60 flex items-center justify-center p-4">
          <div
            className="bg-white w-full max-w-6xl rounded-xl overflow-hidden shadow-2xl flex flex-col max-h-[92vh]"
            role="dialog"
            aria-modal="true"
            aria-label={activeStream.label}
          >
            <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between gap-3 flex-wrap">
              <h4 className="font-semibold text-slate-900 flex-1 min-w-0 truncate">{activeStream.label}</h4>
              <div className="flex items-center gap-2 shrink-0">
                {activeStream.live && (
                  <>
                    <span className="flex items-center gap-1.5 text-xs font-semibold text-rose-600">
                      <span className="w-2 h-2 rounded-full bg-rose-500 animate-pulse" />
                      Still recording
                    </span>
                    <button
                      onClick={() => { setVideoError(null); setStreamRefreshNonce(n => n + 1); }}
                      title="Re-read the file from disk to pick up everything captured since you opened it"
                      className="flex items-center gap-1 text-xs px-3 py-1.5 rounded-lg border border-slate-200 text-slate-700 hover:bg-slate-50"
                    >
                      <RefreshCw size={13} /> Reload
                    </button>
                  </>
                )}
                <a
                  href={`${activeStream.url}${activeStream.url.includes('?') ? '&' : '?'}dl=1`}
                  download
                  className="flex items-center gap-1 text-xs px-3 py-1.5 rounded-lg border border-slate-200 text-slate-700 hover:bg-slate-50"
                >
                  <Download size={13} /> Download
                </a>
                <button
                  onClick={closeStream}
                  className="text-sm text-slate-500 hover:text-slate-800 px-2"
                  title="Close (Esc)"
                >
                  Close
                </button>
              </div>
            </div>
            <div className="flex flex-col lg:flex-row min-h-0 flex-1">
              <div className="lg:flex-1 bg-black relative flex items-center min-h-0">
                {videoError ? (
                  <div className="w-full flex flex-col items-center justify-center text-white py-16 gap-3">
                    <p className="text-sm text-slate-300">Video could not be played in browser.</p>
                    <a
                      href={`${activeStream.url}${activeStream.url.includes('?') ? '&' : '?'}dl=1`}
                      download
                      className="flex items-center gap-1 text-xs px-4 py-2 rounded-lg bg-white/10 hover:bg-white/20 text-white border border-white/20"
                    >
                      <Download size={13} /> Download to play in VLC
                    </a>
                  </div>
                ) : (
                  <video
                    key={`${activeStream.url}-${streamRefreshNonce}`}
                    ref={videoRef}
                    src={`${activeStream.url}${activeStream.url.includes('?') ? '&' : '?'}_t=${streamRefreshNonce}`}
                    controls
                    // "metadata", not "auto": an in-progress recording is a 70MB+ growing file and
                    // eagerly buffering all of it just delays the first frame.
                    preload="metadata"
                    className="w-full h-auto max-h-[75vh]"
                    onCanPlay={() => { videoRef.current?.play().catch(() => {}); }}
                    onError={() => setVideoError('playback-failed')}
                  />
                )}
              </div>
              <div className="lg:w-80 shrink-0 border-t lg:border-t-0 lg:border-l border-slate-200 flex flex-col min-h-0">
                <div className="px-4 py-3 border-b border-slate-200 flex items-center gap-2">
                  {timeline.length > 0
                    ? <ShieldAlert size={16} className="text-rose-500" />
                    : <ShieldCheck size={16} className="text-teal-600" />}
                  <span className="text-sm font-semibold text-slate-800">
                    Proctoring Timeline
                  </span>
                  {/* Count real INCIDENTS. The raw event count is shown alongside only when the two
                      differ, so a single sustained problem no longer reads as a hundred offences. */}
                  <span className="ml-auto text-xs px-2 py-0.5 rounded-full bg-slate-100 text-slate-600">
                    {timeline.length}
                    {sessionViolations.length > timeline.length && (
                      <span className="text-slate-400"> / {sessionViolations.length} events</span>
                    )}
                  </span>
                </div>
                <div className="overflow-y-auto flex-1 min-h-[160px] max-h-[70vh] divide-y divide-slate-100">
                  {violationsLoading ? (
                    <div className="p-4 text-xs text-slate-400">Loading proctoring events…</div>
                  ) : timeline.length === 0 ? (
                    <div className="p-4 text-xs text-slate-500">
                      No proctoring violations were recorded for this session.
                    </div>
                  ) : (
                    timeline.map(ep => {
                      const sev = violationSeverity(ep.first);
                      const offset = (ep.startTs - activeStream.startedAt) / 1000;
                      const spanMs = ep.durationMs;
                      // A run of repeats is ONE incident that lasted a while — say so, instead of
                      // listing it a hundred times.
                      const sustained = isSustained(ep);
                      return (
                        <button
                          key={ep.key}
                          onClick={() => seekToViolation(ep.first)}
                          className="w-full text-left px-4 py-3 hover:bg-slate-50 transition-colors flex gap-3"
                        >
                          {ep.snapshot ? (
                            <img
                              src={ep.snapshot}
                              alt=""
                              className="w-14 h-11 object-cover rounded border border-slate-200 shrink-0"
                            />
                          ) : (
                            <div className="w-14 h-11 rounded border border-slate-200 bg-slate-100 shrink-0" />
                          )}
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <span className={`text-[10px] px-1.5 py-0.5 rounded-full border ${severityChip[sev]}`}>
                                {sev.toUpperCase()}
                              </span>
                              <span className="text-xs font-medium text-slate-800 truncate">
                                {(VIOLATION_LABELS as Record<string, string>)[ep.type] || ep.type}
                              </span>
                              {sustained && (
                                <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-slate-100 text-slate-600 border border-slate-200 shrink-0">
                                  {formatEpisodeDuration(spanMs)}
                                </span>
                              )}
                              <span className="ml-auto text-[11px] font-mono text-[var(--lsc-primary)] shrink-0">
                                {formatOffset(offset)}
                              </span>
                            </div>
                            <p className="text-[11px] text-slate-500 mt-0.5 line-clamp-2">{ep.description}</p>
                            {sustained && (
                              <p className="text-[10px] text-slate-400 mt-0.5">
                                Continuous — detected {ep.count}× over {formatEpisodeDuration(spanMs)}
                              </p>
                            )}
                          </div>
                        </button>
                      );
                    })
                  )}
                </div>
              </div>
            </div>
            {activeStream.live && (
              <div className="px-4 py-2 bg-amber-50 border-t border-amber-100 text-xs text-amber-700">
                Live recording still in progress — press <strong>Reload</strong> to pull everything captured since you opened this.
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

const Stat = ({ title, value, icon }: { title: string; value: number; icon: React.ReactNode }) => (
  <div className="lsc-panel p-4">
    <div className="flex items-center justify-between">
      <div>
        <p className="text-xs uppercase tracking-widest text-slate-400">{title}</p>
        <div className="text-2xl font-semibold text-slate-900">{value}</div>
      </div>
      <div className="h-9 w-9 rounded-full bg-slate-100 flex items-center justify-center">{icon}</div>
    </div>
  </div>
);

const StreamButton = ({ label, disabled, onClick }: { label: string; disabled: boolean; onClick: () => void }) => (
  <button
    onClick={onClick}
    disabled={disabled}
    className="text-xs px-2.5 py-1.5 rounded-lg border border-slate-200 text-slate-700 hover:bg-slate-50 disabled:opacity-40"
  >
    {label}
  </button>
);
