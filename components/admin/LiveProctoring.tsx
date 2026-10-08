import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Radio, Users, ShieldAlert, Eye, EyeOff, Smartphone, UserX, UsersRound, Mic, Search, X, Wifi, WifiOff } from 'lucide-react';
import { apiGet, apiPost } from '../../services/api';
import { Pagination, usePagination } from './Pagination';
import { Exam, Student } from '../../types';

interface LiveProctoringProps {
  exams: Exam[];
  students: Student[];
}

interface LiveItem {
  sessionId: number;
  examId: string;
  studentId: string;
  faceCount: number | null;
  gazeAway: boolean;
  eyesClosed: boolean;
  mouthOpen: boolean;
  phone: boolean;
  multipleFaces: boolean;
  riskScore: number | null;
  riskLevel: 'low' | 'medium' | 'high' | null;
  aiNote: string | null;
  lastViolationType: string | null;
  lastViolationAt: number | null;
  updatedAt: number | null;
  startedAt: number | null;
  online: boolean;
  ageSec: number;
  frameUrl: string;
}

const POLL_MS = 2000;       // grid roster refresh — matches the student's idle ~2s snapshot push
const FOCUS_FRAME_MS = 400; // focused modal: pull the freshest frame ~2.5x/s for near-video playback
const WATCH_PING_MS = 2000; // re-tell the server we're watching (its watch flag has a few-second TTL)

const resolveUrl = (raw: string) =>
  raw.startsWith('http') || raw.startsWith('/') ? raw : `/api/${raw}`;

// Double-buffered frame: decode the next JPEG off-screen and only swap the visible pixels once it's
// ready, so a tile never blanks or flickers between frames. Without this, binding <img src> directly
// makes every refresh flash — the main reason the wall felt "stuck"/janky. The previous good frame
// stays on screen while the next loads, and a failed load keeps the last frame instead of blanking.
const LiveFrame: React.FC<{ src: string; alt: string; className?: string }> = ({ src, alt, className }) => {
  const [shown, setShown] = useState(src);
  const wantRef = useRef(src);
  useEffect(() => {
    wantRef.current = src;
    const img = new Image();
    img.decoding = 'async';
    const commit = () => { if (wantRef.current === src) setShown(src); };
    img.onload = commit;
    img.onerror = () => { /* keep the previous good frame */ };
    img.src = src;
    if (img.decode) img.decode().then(commit).catch(() => { /* onload still fires */ });
    return () => { img.onload = null; img.onerror = null; };
  }, [src]);
  return <img src={shown} alt={alt} decoding="async" className={className} />;
};

// Cache-bust each thumbnail by the frame's own updatedAt, so a tile only refetches when THAT
// candidate pushed a new frame — instead of reloading every image on every poll (which froze the
// wall). Unchanged/offline tiles keep a stable URL the browser can serve from cache.
const frameSrc = (i: LiveItem) => `${resolveUrl(i.frameUrl)}&_t=${i.updatedAt ?? 0}`;

const elapsed = (from: number | null) => {
  if (!from) return '—';
  const s = Math.max(0, Math.floor((Date.now() - from) / 1000));
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
};

// Rank a candidate's risk so the most suspicious tiles bubble to the top of the wall.
// The AI service computes a session-aware risk score (0-100, decaying) from behaviour
// patterns over minutes — prefer it. The instant-flag heuristic remains as a fallback
// for sessions whose pushes predate the v7 engine.
const riskScore = (i: LiveItem): number => {
  if (typeof i.riskScore === 'number') {
    // Blend in the instant flags so a phone visible RIGHT NOW still tops the wall even
    // before the decayed score catches up.
    let r = i.riskScore;
    if (i.multipleFaces || (i.faceCount ?? 1) >= 2) r = Math.max(r, 70);
    if (i.phone) r = Math.max(r, 65);
    if (i.faceCount === 0) r = Math.max(r, 45);
    return r;
  }
  let r = 0;
  if (i.multipleFaces || (i.faceCount ?? 1) >= 2) r += 100;
  if (i.phone) r += 90;
  if (i.faceCount === 0) r += 70;
  if (i.gazeAway) r += 30;
  if (i.mouthOpen) r += 15;
  if (i.eyesClosed) r += 10;
  if (!i.online) r += 5;
  return r;
};

const riskBadgeCls = (level: string | null, score: number): string => {
  const lvl = level ?? (score >= 60 ? 'high' : score >= 30 ? 'medium' : 'low');
  return lvl === 'high'
    ? 'bg-rose-600 text-white'
    : lvl === 'medium'
      ? 'bg-amber-500 text-white'
      : 'bg-teal-600/90 text-white';
};

export const LiveProctoring: React.FC<LiveProctoringProps> = ({ exams, students }) => {
  const [items, setItems] = useState<LiveItem[]>([]);
  const [search, setSearch] = useState('');
  const [selectedExamId, setSelectedExamId] = useState('ALL');
  const [flaggedOnly, setFlaggedOnly] = useState(false);
  const [focused, setFocused] = useState<LiveItem | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [focusTick, setFocusTick] = useState(0); // drives the focused modal's fast frame refresh
  const timerRef = useRef<number | null>(null);
  // One wall request at a time. On a busy exam day a roster call can take longer than POLL_MS; without
  // this guard the 2s ticks stacked up concurrent requests whose responses could land out of order
  // (an older roster overwriting a newer one), and kept arriving after the screen was closed.
  const inFlightRef = useRef(false);
  const mountedRef = useRef(true);

  const load = async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    try {
      const res = await apiGet<{ live: LiveItem[] }>('live.php?mode=wall');
      if (mountedRef.current) setItems(Array.isArray(res?.live) ? res.live : []);
    } catch (e) {
      console.error('Failed to load live wall:', e);
    } finally {
      inFlightRef.current = false;
      if (mountedRef.current) setLoaded(true);
    }
  };

  useEffect(() => {
    mountedRef.current = true;
    // Only poll while the tab is visible — a backgrounded wall shouldn't keep hammering the server.
    const tick = () => { if (!document.hidden) void load(); };
    void load();
    timerRef.current = window.setInterval(tick, POLL_MS);
    const onVisible = () => { if (!document.hidden) void load(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      mountedRef.current = false;
      if (timerRef.current) window.clearInterval(timerRef.current);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  // Escape closes the enlarged candidate view.
  useEffect(() => {
    if (!focused) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setFocused(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [focused]);

  // While a candidate is enlarged: (1) ping WATCH so the server tells that student to push at a high
  // frame rate, and (2) tick a fast cache-buster so the modal keeps pulling the freshest frame. Both
  // stop on close, and the server's watch flag lapses within a few seconds so the student eases back.
  useEffect(() => {
    if (!focused) return;
    const sid = focused.sessionId;
    const ping = () => { void apiPost('live.php', { action: 'WATCH', sessionId: sid }).catch(() => {}); };
    ping();
    const watchId = window.setInterval(() => { if (!document.hidden) ping(); }, WATCH_PING_MS);
    const frameId = window.setInterval(() => { if (!document.hidden) setFocusTick(t => t + 1); }, FOCUS_FRAME_MS);
    return () => { window.clearInterval(watchId); window.clearInterval(frameId); };
  }, [focused?.sessionId]);

  const studentName = (id: string) => students.find(s => s.id === id)?.fullName || id;
  const studentReg = (id: string) => students.find(s => s.id === id)?.registrationId || '';
  const examTitle = (id: string) => exams.find(e => e.id === id)?.title || id;

  const examOptions = useMemo(() => {
    const ids = new Set<string>(items.map(i => i.examId));
    // Keep the selected exam listed even after its last candidate drops off the wall. Otherwise the
    // <select> silently showed "All Exams" while the hidden filter still emptied the wall.
    if (selectedExamId !== 'ALL') ids.add(selectedExamId);
    return Array.from(ids).map(id => ({ id, label: examTitle(id) })).sort((a, b) => a.label.localeCompare(b.label));
  }, [items, exams, selectedExamId]);

  const visible = useMemo(() => {
    const term = search.trim().toLowerCase();
    return items
      .filter(i => {
        if (selectedExamId !== 'ALL' && i.examId !== selectedExamId) return false;
        if (flaggedOnly && riskScore(i) < 30) return false;
        if (term) {
          return (
            studentName(i.studentId).toLowerCase().includes(term) ||
            i.studentId.toLowerCase().includes(term) ||
            examTitle(i.examId).toLowerCase().includes(term)
          );
        }
        return true;
      })
      .sort((a, b) => riskScore(b) - riskScore(a) || (b.updatedAt || 0) - (a.updatedAt || 0));
  }, [items, search, selectedExamId, flaggedOnly, students, exams]);

  // A live wall of 1,000 candidates paints thousands of thumbnails per refresh — page the tiles so a
  // proctor sees a grid they can actually scan. Pinned to a grid-friendly size.
  const paging = usePagination(visible, `${search}|${selectedExamId}|${flaggedOnly}`, 12);

  const stats = useMemo(() => ({
    total: items.length,
    online: items.filter(i => i.online).length,
    flagged: items.filter(i => riskScore(i) >= 30).length,
  }), [items]);

  const focusedFresh = focused ? items.find(i => i.sessionId === focused.sessionId) || focused : null;

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
        <div>
          <h2 className="lsc-title flex items-center gap-2">
            <Radio className="text-[var(--lsc-primary)]" /> Live Proctoring
          </h2>
          <p className="lsc-subtitle mt-1">
            Real-time candidate monitoring wall — click any candidate to stream their camera live.
          </p>
        </div>
        <div className="flex flex-wrap gap-3">
          <Stat icon={<Users size={18} />} value={stats.total} label="Active" tone="slate" />
          <Stat icon={<Wifi size={18} />} value={stats.online} label="Online" tone="teal" />
          <Stat icon={<ShieldAlert size={18} />} value={stats.flagged} label="Flagged" tone={stats.flagged > 0 ? 'rose' : 'slate'} />
        </div>
      </div>

      <div className="lsc-panel p-4 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={() => setFlaggedOnly(false)}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${!flaggedOnly ? 'bg-slate-900 text-white shadow-sm' : 'text-slate-600 hover:bg-slate-100'}`}
          >
            All Candidates
          </button>
          <button
            onClick={() => setFlaggedOnly(true)}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${flaggedOnly ? 'bg-[#d93025] text-white shadow-sm' : 'text-slate-600 hover:bg-rose-50 hover:text-rose-600'}`}
          >
            <ShieldAlert size={16} /> Flagged Only
          </button>
          <select
            className="px-3 py-2 border border-slate-200 rounded-lg text-sm bg-white outline-none"
            value={selectedExamId}
            onChange={e => setSelectedExamId(e.target.value)}
            aria-label="Filter by exam"
          >
            <option value="ALL">All Exams</option>
            {examOptions.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
          </select>
        </div>
        <div className="relative">
          <Search className="absolute left-3 top-2.5 text-slate-400" size={16} />
          <input
            type="text"
            placeholder="Search student or exam..."
            aria-label="Search student or exam"
            className="pl-9 pr-4 py-2 border border-slate-200 rounded-lg outline-none w-full sm:w-64 text-sm bg-white"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
      </div>

      {visible.length === 0 ? (
        <div className="lsc-panel p-12 text-center text-slate-400">
          {!loaded
            ? 'Loading live wall…'
            : items.length > 0
              ? 'No candidates match the current filters.'
              : 'No active candidates are being proctored right now.'}
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {paging.pageItems.map(item => {
            const flags = statusFlags(item);
            const score = riskScore(item);
            const risky = score >= 30;
            return (
              <button
                key={item.sessionId}
                onClick={() => setFocused(item)}
                className={`text-left lsc-panel overflow-hidden group hover:shadow-lg transition-shadow ${risky ? 'ring-2 ring-rose-300' : ''}`}
              >
                <div className="relative bg-slate-900 aspect-video overflow-hidden">
                  <LiveFrame
                    src={frameSrc(item)}
                    alt={studentName(item.studentId)}
                    className="w-full h-full object-cover"
                  />
                  <div className="absolute top-2 left-2 flex items-center gap-1.5">
                    <span className={`flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full ${item.online ? 'bg-teal-500/90 text-white' : 'bg-slate-500/80 text-white'}`}>
                      {item.online ? <><span className="w-1.5 h-1.5 rounded-full bg-white animate-pulse" /> LIVE</> : <><WifiOff size={10} /> {item.ageSec}s</>}
                    </span>
                  </div>
                  {typeof item.riskScore === 'number' && (
                    <div className="absolute top-2 right-2">
                      <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${riskBadgeCls(item.riskLevel, score)}`}>
                        RISK {item.riskScore}
                      </span>
                    </div>
                  )}
                  <div className="absolute bottom-0 left-0 right-0 p-2 flex flex-wrap gap-1 bg-gradient-to-t from-black/70 to-transparent">
                    {flags.map(f => (
                      <span key={f.key} className={`flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded ${f.cls}`}>
                        {f.icon}{f.label}
                      </span>
                    ))}
                  </div>
                </div>
                <div className="p-3">
                  <div className="font-semibold text-slate-900 text-sm truncate">{studentName(item.studentId)}</div>
                  <div className="text-xs text-slate-400 truncate">{examTitle(item.examId)}</div>
                  {item.aiNote && (
                    <div className="text-[11px] text-amber-700 bg-amber-50 border border-amber-100 rounded px-1.5 py-0.5 mt-1.5 truncate" title={item.aiNote}>
                      AI: {item.aiNote}
                    </div>
                  )}
                  <div className="text-[11px] text-slate-400 mt-1">Elapsed {elapsed(item.startedAt)}</div>
                </div>
              </button>
            );
          })}
        </div>
      )}
      {visible.length > 0 && (
        <div className="lsc-panel overflow-hidden">
          <Pagination state={paging} label="candidates" hidePageSize />
        </div>
      )}

      {focusedFresh && (
        <div className="fixed inset-0 z-[220] bg-slate-900/70 flex items-center justify-center p-4" onClick={() => setFocused(null)}>
          <div
            className="bg-white w-full max-w-3xl rounded-xl overflow-hidden shadow-2xl max-h-[92vh] overflow-y-auto"
            onClick={e => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label={`Live view: ${studentName(focusedFresh.studentId)}`}
          >
            <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between gap-3">
              <div className="min-w-0">
                <h4 className="font-semibold text-slate-900 truncate">{studentName(focusedFresh.studentId)}</h4>
                <p className="text-xs text-slate-400 truncate">
                  {studentReg(focusedFresh.studentId)} · {examTitle(focusedFresh.examId)}
                </p>
              </div>
              <button onClick={() => setFocused(null)} className="text-slate-500 hover:text-slate-800 p-1" aria-label="Close live view" title="Close (Esc)"><X size={18} /></button>
            </div>
            <div className="relative bg-slate-900 aspect-video">
              <LiveFrame
                src={`${resolveUrl(focusedFresh.frameUrl)}&_t=${focusTick}`}
                alt={studentName(focusedFresh.studentId)}
                className="w-full h-full object-contain"
              />
              <div className="absolute top-3 left-3">
                <span className={`flex items-center gap-1 text-xs font-bold px-2.5 py-1 rounded-full ${focusedFresh.online ? 'bg-teal-500/90 text-white' : 'bg-slate-500/80 text-white'}`}>
                  {focusedFresh.online ? <><span className="w-2 h-2 rounded-full bg-white animate-pulse" /> LIVE</> : <><WifiOff size={12} /> {focusedFresh.ageSec}s ago</>}
                </span>
              </div>
            </div>
            <div className="p-4 space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                {typeof focusedFresh.riskScore === 'number' && (
                  <span className={`text-xs font-bold px-2.5 py-1 rounded-full ${riskBadgeCls(focusedFresh.riskLevel, focusedFresh.riskScore)}`}>
                    RISK {focusedFresh.riskScore}/100
                  </span>
                )}
                {statusFlags(focusedFresh).length === 0 ? (
                  <span className="text-sm text-teal-600 flex items-center gap-1"><Eye size={15} /> No anomalies detected right now.</span>
                ) : (
                  statusFlags(focusedFresh).map(f => (
                    <span key={f.key} className={`flex items-center gap-1 text-xs font-semibold px-2.5 py-1 rounded-full ${f.cls}`}>
                      {f.icon}{f.label}
                    </span>
                  ))
                )}
              </div>
              {focusedFresh.aiNote && (
                <div className="text-sm text-amber-800 bg-amber-50 border border-amber-100 rounded-lg px-3 py-2">
                  <span className="font-semibold">AI proctor note:</span> {focusedFresh.aiNote}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

interface Flag { key: string; label: string; cls: string; icon: React.ReactNode; }

const statusFlags = (i: LiveItem): Flag[] => {
  const flags: Flag[] = [];
  if (i.multipleFaces || (i.faceCount ?? 1) >= 2) {
    flags.push({ key: 'multi', label: 'Multiple faces', cls: 'bg-rose-500 text-white', icon: <UsersRound size={11} /> });
  }
  if (i.faceCount === 0) {
    flags.push({ key: 'noface', label: 'No face', cls: 'bg-rose-500 text-white', icon: <UserX size={11} /> });
  }
  if (i.phone) {
    flags.push({ key: 'phone', label: 'Phone', cls: 'bg-rose-500 text-white', icon: <Smartphone size={11} /> });
  }
  if (i.gazeAway) {
    flags.push({ key: 'gaze', label: 'Looking away', cls: 'bg-amber-500 text-white', icon: <EyeOff size={11} /> });
  }
  if (i.mouthOpen) {
    flags.push({ key: 'talk', label: 'Talking', cls: 'bg-amber-500 text-white', icon: <Mic size={11} /> });
  }
  if (i.eyesClosed) {
    flags.push({ key: 'eyes', label: 'Eyes closed', cls: 'bg-slate-600 text-white', icon: <EyeOff size={11} /> });
  }
  return flags;
};

const toneCls: Record<string, string> = {
  slate: 'bg-slate-100 text-slate-500',
  teal: 'bg-teal-100 text-teal-600',
  rose: 'bg-rose-100 text-rose-600',
};

const Stat = ({ icon, value, label, tone }: { icon: React.ReactNode; value: number; label: string; tone: 'slate' | 'teal' | 'rose' }) => (
  <div className={`lsc-panel px-4 py-3 flex items-center gap-3 ${tone === 'rose' ? 'bg-rose-50 border-rose-200' : ''}`}>
    <div className={`p-2 rounded-full ${toneCls[tone]}`}>{icon}</div>
    <div>
      <div className={`text-2xl font-bold leading-none ${tone === 'rose' ? 'text-rose-700' : 'text-slate-900'}`}>{value}</div>
      <div className="text-[10px] text-slate-500 font-semibold uppercase tracking-widest">{label}</div>
    </div>
  </div>
);
