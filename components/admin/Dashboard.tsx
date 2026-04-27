import React, { useEffect, useMemo, useState } from 'react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { Users, FileCheck, AlertOctagon, TrendingUp } from 'lucide-react';
import { apiGet } from '../../services/api';
import { Exam, ExamSession, Student } from '../../types';

export const Dashboard: React.FC<{ exams: Exam[]; students: Student[]; sessions: ExamSession[] }> = ({ exams, students, sessions }) => {
  const [violations24h, setViolations24h] = useState(0);

  useEffect(() => {
    let mounted = true;
    const loadViolations = async () => {
      try {
        const data = await apiGet<{ violations: { timestamp: number }[] }>('violations.php?limit=200');
        if (mounted && data?.violations) {
          const count = data.violations.filter(v => Date.now() - v.timestamp < 24 * 60 * 60 * 1000).length;
          setViolations24h(count);
        }
      } catch (e) {
        console.error('Failed to load violations: ' , e);
      }
    };
    loadViolations();
    const id = window.setInterval(loadViolations, 15000);
    return () => {
      mounted = false;
      window.clearInterval(id);
    };
  }, []);

  const activeExams = exams.filter(e => e.status === 'PUBLISHED' && Date.now() >= e.startTime && Date.now() <= e.endTime).length;
  const totalStudents = students.length;

  const data = useMemo(() => {
    if (exams.length === 0) return [] as { name: string; passed: number; failed: number }[];
    return exams.map(exam => {
      const examSessions = sessions.filter(s => s.examId === exam.id);
      const completed = examSessions.filter(s => s.status === 'COMPLETED').length;
      const failed = examSessions.filter(s => s.status === 'TERMINATED').length;
      return {
        name: exam.title,
        passed: completed,
        failed,
      };
    });
  }, [exams, sessions]);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
         <div>
           <h2 className="lsc-title">Command Overview</h2>
           <p className="lsc-subtitle mt-1">Live status snapshot for LSC Exam Proctor operations.</p>
         </div>
         
      </div>
      
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        <StatCard title="Active Exams" value={String(activeExams)} icon={<FileCheck className="text-[#3558ff]" />} tone="primary" />
        <StatCard title="Total Students" value={String(totalStudents)} icon={<Users className="text-[#0f9f8c]" />} tone="success" />
        <StatCard title="Violations (24h)" value={String(violations24h)} icon={<AlertOctagon className="text-[#d94f34]" />} tone="danger" />
        <StatCard title="Avg. Pass Rate" value="0%" icon={<TrendingUp className="text-[#c98911]" />} tone="warm" />
      </div>

      <div className="lsc-panel p-6 min-w-0">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between mb-6">
          <div>
            <h3 className="text-lg font-semibold text-slate-900">Exam Performance</h3>
            <p className="text-xs text-slate-500">Completion vs. termination across published exams.</p>
          </div>
          <div className="lsc-badge">Last 30 days</div>
        </div>
        {data.length > 0 ? (
          <div className="h-80 w-full min-w-0">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
                <XAxis dataKey="name" axisLine={false} tickLine={false} tick={{fill: '#64748b', fontSize: 12}} />
                <YAxis axisLine={false} tickLine={false} tick={{fill: '#64748b', fontSize: 12}} />
                <Tooltip 
                  contentStyle={{ borderRadius: '8px', border: 'none', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)' }}
                  cursor={{ fill: '#f8fafc' }}
                />
                <Bar dataKey="passed" name="Completed" fill="#3558ff" radius={[4, 4, 0, 0]} barSize={36} />
                <Bar dataKey="failed" name="Terminated" fill="#ff6b4a" radius={[4, 4, 0, 0]} barSize={36} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <p className="text-xs text-gray-400 mt-2">No exam performance data yet.</p>
        )}
      </div>
    </div>
  );
};

const StatCard = ({ title, value, icon, tone }: { title: string, value: string, icon: React.ReactNode, tone: 'primary' | 'success' | 'danger' | 'warm' }) => {
  const toneClass = {
    primary: 'lsc-icon-tile-primary',
    success: 'lsc-icon-tile-success',
    danger: 'lsc-icon-tile-danger',
    warm: 'lsc-icon-tile-warm',
  }[tone];

  return (
    <div className="lsc-panel p-5 flex items-center justify-between">
      <div>
        <p className="text-xs font-semibold text-slate-500 uppercase tracking-widest mb-2">{title}</p>
        <h3 className="text-3xl font-semibold text-slate-900">{value}</h3>
      </div>
      <div className={`p-3 rounded-2xl border ${toneClass}`}>
        {icon}
      </div>
    </div>
  );
};
