import React, { useEffect, useMemo, useState } from 'react';
import { Film, Camera, Monitor, Layers, Search } from 'lucide-react';
import { apiGet } from '../../services/api';
import { Exam, RecordingSessionRecord, RecordingSummary, RecordingStreamType, Student } from '../../types';

interface RecordingsProps {
  exams: Exam[];
  students: Student[];
}

const resolveVideoUrl = (raw?: string | null) => {
  if (!raw) return null;
  if (raw.startsWith('http://') || raw.startsWith('https://') || raw.startsWith('/')) return raw;
  return `/api/${raw}`;
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
  const [activeStream, setActiveStream] = useState<{ label: string; url: string; live: boolean } | null>(null);
  const [streamRefreshNonce, setStreamRefreshNonce] = useState(0);

  const load = async () => {
    try {
      const [sumRes, listRes] = await Promise.all([
        apiGet<{ summary: RecordingSummary }>('recordings.php?mode=summary'),
        apiGet<{ recordings: RecordingSessionRecord[] }>('recordings.php?mode=list&limit=250'),
      ]);
      if (sumRes?.summary) setSummary(sumRes.summary);
      if (listRes?.recordings) setSessions(listRes.recordings);
    } catch (e) {
      console.error('Failed to load recordings:', e);
    }
  };

  useEffect(() => {
    void load();
    const id = window.setInterval(() => {
      void load();
    }, 15000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    if (!activeStream?.live) return;
    const id = window.setInterval(() => {
      setStreamRefreshNonce(prev => prev + 1);
    }, 5000);
    return () => window.clearInterval(id);
  }, [activeStream?.live]);

  const examOptions = useMemo(() => {
    const ids = Array.from(new Set(sessions.map(s => s.examId)));
    return ids
      .map(id => ({
        id,
        label: exams.find(e => e.id === id)?.title || id,
      }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [sessions, exams]);

  const studentOptions = useMemo(() => {
    const ids = Array.from(new Set(sessions.map(s => s.studentId)));
    return ids
      .map(id => {
        const student = students.find(s => s.id === id);
        return {
          id,
          label: student ? `${student.fullName} (${student.registrationId})` : id,
        };
      })
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [sessions, students]);

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
      return sessions;
    }

    return sessions.filter(item => {
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
  }, [sessions, search, exams, students, selectedExamId, selectedStudentId, selectedStatus, selectedStreamType]);

  const openStream = (session: RecordingSessionRecord, streamType: 'camera' | 'screen' | 'combined') => {
    const stream = session.streams.find(s => s.streamType === streamType && s.hasFile && !!s.fileUrl);
    const url = resolveVideoUrl(stream?.fileUrl || null);
    if (!url) return;
    const exam = exams.find(e => e.id === session.examId)?.title || session.examId;
    const student = students.find(s => s.id === session.studentId)?.fullName || session.studentId;
    setStreamRefreshNonce(0);
    setActiveStream({
      label: `${streamType.toUpperCase()} - ${student} - ${exam}`,
      url,
      live: session.status === 'RECORDING' || session.status === 'INIT',
    });
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h2 className="lsc-title flex items-center gap-2">
            <Film size={20} className="text-[#3558ff]" /> Recordings
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
              className="pl-9 pr-4 py-2 border border-slate-200 rounded-lg outline-none w-full text-sm bg-white"
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </div>
          <select
            className="px-3 py-2 border border-slate-200 rounded-lg text-sm bg-white outline-none"
            value={selectedExamId}
            onChange={e => setSelectedExamId(e.target.value)}
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
          >
            <option value="ALL">All Streams</option>
            <option value="camera">Camera</option>
            <option value="screen">Screen</option>
            <option value="combined">Combined</option>
          </select>
        </div>
        <div className="mt-3 flex items-center justify-between">
          <div className="text-xs text-slate-500">
            Showing {filtered.length} of {sessions.length} sessions
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
        <Stat title="Combined Recordings" value={summary.combinedCount} icon={<Layers size={16} className="text-[#3558ff]" />} />
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
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filtered.map(session => {
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
                    <td className="px-4 py-3">{session.durationSec ?? '-'}s</td>
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
                          label={`Camera (${Math.round((cam?.sizeBytes || 0) / 1024 / 1024)}MB)`}
                          disabled={!cam?.hasFile}
                          onClick={() => openStream(session, 'camera')}
                        />
                        <StreamButton
                          label={`Screen (${Math.round((scr?.sizeBytes || 0) / 1024 / 1024)}MB)`}
                          disabled={!scr?.hasFile}
                          onClick={() => openStream(session, 'screen')}
                        />
                        <StreamButton
                          label={`Combined (${Math.round((cmb?.sizeBytes || 0) / 1024 / 1024)}MB)`}
                          disabled={!cmb?.hasFile}
                          onClick={() => openStream(session, 'combined')}
                        />
                      </div>
                    </td>
                  </tr>
                );
              })}
              {filtered.length === 0 && (
                <tr>
                  <td className="px-4 py-8 text-center text-slate-400" colSpan={6}>
                    No recordings found.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {activeStream && (
        <div className="fixed inset-0 z-[220] bg-slate-900/60 flex items-center justify-center p-4">
          <div className="bg-white w-full max-w-5xl rounded-xl overflow-hidden shadow-2xl">
            <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between">
              <h4 className="font-semibold text-slate-900">{activeStream.label}</h4>
              <button
                onClick={() => setActiveStream(null)}
                className="text-sm text-slate-500 hover:text-slate-800"
              >
                Close
              </button>
            </div>
            <div className="bg-black">
              <video
                src={`${activeStream.url}${activeStream.url.includes('?') ? '&' : '?'}_t=${streamRefreshNonce}`}
                controls
                autoPlay
                className="w-full h-auto max-h-[75vh]"
              />
            </div>
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
