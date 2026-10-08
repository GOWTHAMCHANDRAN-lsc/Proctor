import React, { useEffect, useMemo, useState } from 'react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { Users, FileCheck, AlertOctagon, TrendingUp } from 'lucide-react';
import { apiGet } from '../../services/api';
import { groupViolationEpisodes } from '../../services/violationEpisodes';
import { useSettings } from '../../services/appSettings';
import { Exam, ExamResultRecord, ExamSession, Student } from '../../types';

/** The fields of a violation row this screen needs in order to group events into incidents. */
type ViolationFeedRow = {
  timestamp: number;
  type: string;
  sessionId?: number | null;
  studentId?: string;
  examId?: string;
  metadata?: Record<string, any> | null;
};

// Time-of-day greeting, Google Workspace style ("Good morning, Priya").
const greetingForNow = (): string => {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
};

// First name of the signed-in admin, read from the stored auth payload (same key Layout uses).
const adminFirstName = (): string | null => {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem('pg_admin_auth');
    if (!raw) return null;
    const p = JSON.parse(raw);
    const name = typeof p?.name === 'string' ? p.name.trim() : '';
    if (name) return name.split(/\s+/)[0];
    const email = typeof p?.email === 'string' ? p.email.trim() : '';
    return email ? email.split('@')[0] : null;
  } catch {
    return null;
  }
};

export const Dashboard: React.FC<{ exams: Exam[]; students: Student[]; sessions: ExamSession[] }> = ({ exams, students, sessions }) => {
  const { settings } = useSettings();
  const accent = settings.branding.accent || '#1a73e8';
  const [violations24h, setViolations24h] = useState(0);
  const [passRate, setPassRate] = useState<number | null>(null);

  const firstName = useMemo(() => adminFirstName(), []);
  const greeting = useMemo(() => greetingForNow(), []);
  const today = useMemo(
    () => new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' }),
    []
  );

  useEffect(() => {
    let mounted = true;
    const loadViolations = async () => {
      try {
        const data = await apiGet<{ violations: ViolationFeedRow[] }>('violations.php?limit=200&noSnapshots=1');
        if (mounted && data?.violations) {
          // Count INCIDENTS, not raw detector events. A single candidate whose camera fed a
          // placeholder image for 19 minutes emits 100+ NO_FACE rows, which used to read on this
          // tile as "112 violations today" — a scary number describing one webcam glitch.
          const incidents = groupViolationEpisodes(data.violations);
          const count = incidents.filter(ep => Date.now() - ep.startTs < 24 * 60 * 60 * 1000).length;
          setViolations24h(count);
        }
      } catch (e) {
        console.error('Failed to load violations: ' , e);
      }
    };
    loadViolations();
    // Don't keep pulling the violation feed while the tab is in the background; catch up the moment
    // it becomes visible again instead.
    const id = window.setInterval(() => { if (!document.hidden) void loadViolations(); }, 15000);
    const onVisible = () => { if (!document.hidden) void loadViolations(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      mounted = false;
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  useEffect(() => {
    let mounted = true;
    const loadPassRate = async () => {
      try {
        const data = await apiGet<{ results: ExamResultRecord[] }>('results.php');
        if (!mounted || !data?.results) return;
        // Pass rate is computed over completed attempts only — same basis as the Results screen.
        const completed = data.results.filter(r => r.finalPercent !== null && r.finalPercent !== undefined);
        const passed = completed.filter(r => r.finalPassed).length;
        setPassRate(completed.length > 0 ? Math.round((passed / completed.length) * 100) : 0);
      } catch (e) {
        console.error('Failed to load results for pass rate: ', e);
      }
    };
    loadPassRate();
    return () => {
      mounted = false;
    };
  }, []);

  const activeExams = exams.filter(e => e.status === 'PUBLISHED' && Date.now() >= e.startTime && Date.now() <= e.endTime).length;
  const totalStudents = students.length;

  const data = useMemo(() => {
    if (exams.length === 0) return [] as { name: string; passed: number; failed: number }[];
    return exams
      .map(exam => {
        const examSessions = sessions.filter(s => s.examId === exam.id);
        const completed = examSessions.filter(s => s.status === 'COMPLETED').length;
        const failed = examSessions.filter(s => s.status === 'TERMINATED').length;
        return {
          name: exam.title,
          passed: completed,
          failed,
        };
      })
      // Only exams that actually have finished attempts belong on the chart. Draft / not-yet-taken
      // exams just rendered rows of zero-height bars (and crowded the axis labels), and they kept the
      // "No exam performance data yet" empty state from ever showing.
      .filter(row => row.passed + row.failed > 0);
  }, [exams, sessions]);

  return (
    <div className="space-y-6">
      {/* Personalized greeting header — sets a friendly, Google-console tone. */}
      <div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="text-[1.6rem] font-semibold tracking-[-0.02em] text-slate-900">
            {greeting}{firstName ? `, ${firstName}` : ''}
          </h2>
          <p className="lsc-subtitle mt-1">Here’s your live snapshot for LSC Exam Proctor operations.</p>
        </div>
        <div className="lsc-badge shrink-0">{today}</div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-5">
        <StatCard
          title="Active Exams"
          value={String(activeExams)}
          caption="Open for attempts right now"
          icon={<FileCheck size={20} />}
          tone="primary"
        />
        <StatCard
          title="Total Students"
          value={String(totalStudents)}
          caption="Enrolled across all batches"
          icon={<Users size={20} />}
          tone="success"
        />
        <StatCard
          title="Violations (24h)"
          value={String(violations24h)}
          caption="Flagged in the last 24 hours"
          icon={<AlertOctagon size={20} />}
          tone="danger"
        />
        <StatCard
          title="Avg. Pass Rate"
          value={passRate === null ? '—' : `${passRate}%`}
          caption="Across completed attempts"
          icon={<TrendingUp size={20} />}
          tone="warm"
        />
      </div>

      <div className="lsc-panel p-6 min-w-0">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between mb-6">
          <div>
            <h3 className="text-lg font-semibold text-slate-900">Exam Performance</h3>
            <p className="text-xs text-slate-500 mt-0.5">Completion vs. termination across published exams.</p>
          </div>
          <div className="flex items-center gap-4">
            <LegendDot color={accent} label="Completed" />
            <LegendDot color="#d93025" label="Terminated" />
          </div>
        </div>
        {data.length > 0 ? (
          <div className="h-80 w-full min-w-0">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data} barGap={6}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#eef1f6" />
                <XAxis dataKey="name" axisLine={false} tickLine={false} tick={{ fill: '#5f6368', fontSize: 12 }} dy={8} />
                <YAxis axisLine={false} tickLine={false} tick={{ fill: '#5f6368', fontSize: 12 }} allowDecimals={false} width={32} />
                <Tooltip
                  contentStyle={{ borderRadius: '12px', border: '1px solid #e4e7ec', boxShadow: '0 8px 24px -8px rgba(60,64,67,0.24)', fontSize: '12px', padding: '8px 12px' }}
                  labelStyle={{ color: '#202124', fontWeight: 600, marginBottom: 4 }}
                  cursor={{ fill: 'rgba(26,115,232,0.06)' }}
                />
                <Bar dataKey="passed" name="Completed" fill={accent} radius={[6, 6, 0, 0]} maxBarSize={40} />
                <Bar dataKey="failed" name="Terminated" fill="#d93025" radius={[6, 6, 0, 0]} maxBarSize={40} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <div className="flex h-56 flex-col items-center justify-center text-center">
            <div className="lsc-icon-tile-primary p-3 rounded-2xl border">
              <TrendingUp size={22} />
            </div>
            <p className="mt-3 text-sm font-medium text-slate-600">No exam performance data yet</p>
            <p className="text-xs text-slate-400">Published exams with attempts will appear here.</p>
          </div>
        )}
      </div>
    </div>
  );
};

const LegendDot = ({ color, label }: { color: string; label: string }) => (
  <span className="inline-flex items-center gap-2 text-xs font-medium text-slate-600">
    <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: color }} />
    {label}
  </span>
);

const StatCard = ({ title, value, caption, icon, tone }: { title: string, value: string, caption: string, icon: React.ReactNode, tone: 'primary' | 'success' | 'danger' | 'warm' }) => {
  const toneClass = {
    primary: 'lsc-icon-tile-primary',
    success: 'lsc-icon-tile-success',
    danger: 'lsc-icon-tile-danger',
    warm: 'lsc-icon-tile-warm',
  }[tone];

  return (
    <div className="lsc-panel lsc-panel-interactive p-5">
      <div className="flex items-start justify-between gap-3">
        <p className="text-[13px] font-medium text-slate-500">{title}</p>
        <div className={`h-11 w-11 shrink-0 border ${toneClass}`}>
          {icon}
        </div>
      </div>
      <h3 className="mt-3 text-[2rem] leading-none font-semibold text-slate-900 lsc-tabular">{value}</h3>
      <p className="mt-3 text-xs text-slate-400">{caption}</p>
    </div>
  );
};
