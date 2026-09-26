import React, { useState } from 'react';
import { ExamSession, Student, Exam } from '../../types';
import { Monitor, Wifi, MapPin, Search, AlertTriangle, Network, RotateCcw } from 'lucide-react';
import { apiPost } from '../../services/api';
import { Pagination, usePagination } from './Pagination';

interface MonitoringProps {
  sessions: ExamSession[];
  students: Student[];
  exams: Exam[];
  onRefreshSessions: () => Promise<void>;
}

export const Monitoring: React.FC<MonitoringProps> = ({ sessions, students, exams, onRefreshSessions }) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [filterType, setFilterType] = useState<'ALL' | 'SUSPICIOUS'>('ALL');
  const [resettingKey, setResettingKey] = useState<string | null>(null);

  // --- Analysis Logic ---
  // NOTE: Students attending from the same public IP (shared campus/office network, common
  // household router, mobile carrier NAT, etc.) is expected and is NOT treated as suspicious —
  // only an IP *changing* mid-session, a device change, or a location change are flagged.
  const activeCount = sessions.filter(s => s.status === 'IN_PROGRESS').length;

  // Combine data for display
  const displayData = sessions.map(session => {
    const student = students.find(s => s.id === session.studentId);
    const exam = exams.find(e => e.id === session.examId);

    return {
        ...session,
        studentName: student?.fullName || 'Unknown Student',
        studentReg: student?.registrationId || '---',
        examTitle: exam?.title || 'Unknown Exam',
        isActive: session.status === 'IN_PROGRESS',
        isIpChanged: !!session.ipChangeDetected,
        isDeviceChanged: !!session.deviceChangeDetected,
        isLocationChanged: !!session.locationChangeDetected
    };
  }).filter(item => {
    const matchesSearch =
        item.studentName.toLowerCase().includes(searchTerm.toLowerCase()) ||
        item.ipAddress?.includes(searchTerm) ||
        item.examTitle.toLowerCase().includes(searchTerm.toLowerCase());

    const isSuspicious = item.isIpChanged || item.isDeviceChanged || item.isLocationChanged;
    if (filterType === 'SUSPICIOUS') return matchesSearch && isSuspicious && item.isActive;
    return matchesSearch;
  });

  const paging = usePagination(displayData, `${searchTerm}|${filterType}`);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
        <div>
           <h2 className="lsc-title flex items-center gap-2">
             <Network className="text-[var(--lsc-primary)]" /> Network Monitoring
           </h2>
           <p className="lsc-subtitle mt-1">Real-time IP analysis, device changes, and anomaly detection.</p>
        </div>
        
        <div className="flex flex-wrap gap-3">
            <div className="lsc-panel px-4 py-3 flex items-center gap-3">
                <div className="p-2 bg-teal-100 text-teal-600 rounded-full">
                    <Wifi size={18} />
                </div>
                <div>
                    <div className="text-2xl font-bold text-slate-900 leading-none">{activeCount}</div>
                    <div className="text-[10px] text-slate-500 font-semibold uppercase tracking-widest">Active Connections</div>
                </div>
            </div>
        </div>
      </div>

      {/* Control Bar */}
      <div className="lsc-panel p-4 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
         <div className="flex items-center gap-2">
            <button 
                onClick={() => setFilterType('ALL')}
                className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${filterType === 'ALL' ? 'bg-slate-900 text-white shadow-sm' : 'text-slate-600 hover:bg-slate-100'}`}
            >
                All Sessions
            </button>
            <button 
                onClick={() => setFilterType('SUSPICIOUS')}
                className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${filterType === 'SUSPICIOUS' ? 'bg-[#d93025] text-white shadow-sm' : 'text-slate-600 hover:bg-orange-50 hover:text-orange-600'}`}
            >
                <AlertTriangle size={16} /> Suspicious Only
            </button>
         </div>
         <div className="relative">
             <Search className="absolute left-3 top-2.5 text-slate-400" size={16} />
             <input 
                type="text" 
                placeholder="Search IP, Student, or Exam..."
                className="pl-9 pr-4 py-2 border border-slate-200 rounded-lg outline-none w-full sm:w-64 text-sm bg-white"
                value={searchTerm}
                onChange={e => setSearchTerm(e.target.value)}
             />
         </div>
      </div>

      {/* Data Grid */}
      <div className="lsc-panel overflow-hidden">
         <div className="lsc-table-wrap">
         <table className="w-full min-w-[960px] text-left text-sm">
             <thead className="bg-slate-50 border-b border-slate-200">
                 <tr>
                     <th className="px-6 py-4 font-semibold text-slate-500 uppercase tracking-wider text-xs">Student</th>
                     <th className="px-6 py-4 font-semibold text-slate-500 uppercase tracking-wider text-xs">Active Exam</th>
                     <th className="px-6 py-4 font-semibold text-slate-500 uppercase tracking-wider text-xs">Network Identity (IP)</th>
                     <th className="px-6 py-4 font-semibold text-slate-500 uppercase tracking-wider text-xs">Device / MAC</th>
                     <th className="px-6 py-4 font-semibold text-slate-500 uppercase tracking-wider text-xs text-right">Actions</th>
                 </tr>
             </thead>
             <tbody className="divide-y divide-slate-100">
                 {paging.pageItems.map((session, idx) => (
                     // Keyed by the session identity, not the row index — with paging the index is
                     // page-local and would make React reuse the wrong row across page changes.
                     <tr key={`${session.examId}:${session.studentId}:${idx}`} className="hover:bg-slate-50/80 transition-colors">
                         <td className="px-6 py-4">
                             <div className="font-bold text-slate-900">{session.studentName}</div>
                             <div className="text-xs text-slate-500 font-mono">{session.studentReg}</div>
                         </td>
                         <td className="px-6 py-4">
                             <div className="text-slate-700 font-medium truncate max-w-[200px]" title={session.examTitle}>{session.examTitle}</div>
                             <div className="text-xs text-slate-500 flex items-center gap-1 mt-0.5">
                                 <ClockIcon /> {Math.floor((Date.now() - session.startTime) / 60000)}m elapsed
                             </div>
                         </td>
                         <td className="px-6 py-4 font-mono">
                             <div className="flex items-center gap-2">
                                 <span className="bg-slate-100 px-2 py-1 rounded text-slate-700 font-medium border border-slate-200">
                                     {session.ipAddress || 'Unknown'}
                                 </span>
                                 {session.isIpChanged && (
                                     <span className="flex items-center gap-1 text-[10px] font-bold bg-amber-100 text-amber-700 px-2 py-0.5 rounded-full border border-amber-200">
                                         <AlertTriangle size={10} /> IP CHANGE
                                     </span>
                                 )}
                             </div>
                         </td>
                         <td className="px-6 py-4">
                             <div className="flex items-center gap-1.5 text-slate-700">
                                 <MapPin size={14} className="text-slate-400" />
                                 {session.location || 'Unknown Location'}
                             </div>
                             {session.locationLat !== null && session.locationLat !== undefined && session.locationLng !== null && session.locationLng !== undefined && (
                               <a
                                 href={`https://www.google.com/maps?q=${session.locationLat},${session.locationLng}`}
                                 target="_blank"
                                 rel="noreferrer"
                                 className="mt-1 inline-flex text-[11px] font-semibold text-blue-600 hover:underline"
                               >
                                 Open map ({session.locationAccuracy ? `${session.locationAccuracy}m` : 'accuracy N/A'})
                               </a>
                             )}
                             <div className="text-xs text-slate-400 mt-1 truncate max-w-[150px]" title={session.userAgent}>
                                 {session.userAgent ? session.userAgent.split(')')[0] + ')' : 'Unknown Device'}
                             </div>
                             <div className="mt-1 flex items-center gap-2 text-[11px] text-slate-500">
                                 <span className="font-mono bg-slate-100 px-2 py-0.5 rounded border border-slate-200">
                                     {session.deviceFingerprint ? session.deviceFingerprint.slice(0, 10) + '...' : 'Fingerprint N/A'}
                                 </span>
                                 {session.isDeviceChanged && (
                                     <span className="flex items-center gap-1 text-[10px] font-bold bg-amber-100 text-amber-700 px-2 py-0.5 rounded-full border border-amber-200">
                                         <AlertTriangle size={10} /> DEVICE CHANGE
                                     </span>
                                 )}
                                 {session.isLocationChanged && (
                                     <span className="flex items-center gap-1 text-[10px] font-bold bg-red-100 text-red-700 px-2 py-0.5 rounded-full border border-red-200">
                                         <AlertTriangle size={10} /> LOCATION
                                     </span>
                                 )}
                             </div>
                             {(session as any).macAddress && (
                                 <div className="mt-1 flex items-center gap-2 text-[11px] text-purple-600">
                                     <span className="font-mono bg-purple-50 px-2 py-0.5 rounded border border-purple-200">
                                         MAC: {(session as any).macAddress}
                                     </span>
                                     {(session as any).macBound && (
                                         <span className="flex items-center gap-1 text-[10px] font-bold bg-purple-100 text-purple-700 px-2 py-0.5 rounded-full border border-purple-200">
                                             BOUND
                                         </span>
                                     )}
                                 </div>
                             )}
                         </td>
                         <td className="px-6 py-4 text-right">
                             <div className="flex justify-end items-center gap-3">
                                 <div className={`flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold border ${session.isIpChanged || session.isDeviceChanged || session.isLocationChanged ? 'bg-red-100 text-red-700 border-red-200' : 'bg-teal-100 text-teal-700 border-teal-200'}`}>
                                     {session.isIpChanged || session.isDeviceChanged || session.isLocationChanged ? (
                                         <>
                                           <AlertTriangle size={12} /> FLAGGED
                                         </>
                                     ) : session.isActive ? (
                                         <>
                                            <Monitor size={12} /> SECURE
                                         </>
                                     ) : (
                                         <>
                                           <Monitor size={12} /> INACTIVE
                                         </>
                                     )}
                                 </div>
                                 <div className="flex items-center gap-2">
                                     <button
                                       onClick={async () => {
                                         if (!window.confirm(
                                           session.status === 'COMPLETED'
                                             ? "This student already completed the exam. Renewing keeps their previous attempt on record (marked as superseded) and lets them start a brand-new attempt on the same link. Continue?"
                                             : 'Renew this link? The current in-progress attempt will be preserved on record as superseded, and the student can start a fresh attempt.'
                                         )) {
                                           return;
                                         }
                                         const key = `${session.examId}:${session.studentId}`;
                                         setResettingKey(key);
                                         try {
                                           await apiPost('sessions.php', {
                                             action: 'reset',
                                             examId: session.examId,
                                             studentId: session.studentId
                                           });
                                           alert('Link renewed. The previous attempt was preserved (not deleted) and the student can start again.');
                                           await onRefreshSessions();
                                         } catch (e) {
                                           console.error(e);
                                           alert('Failed to renew link.');
                                         } finally {
                                           setResettingKey(null);
                                         }
                                       }}
                                       className="flex items-center gap-1 px-3 py-1 rounded-full text-xs font-bold border border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-100"
                                       title="Renew link — previous attempt is preserved, never deleted"
                                       disabled={resettingKey === `${session.examId}:${session.studentId}`}
                                     >
                                       <RotateCcw size={12} />
                                       {resettingKey === `${session.examId}:${session.studentId}` ? 'Renewing...' : 'Renew'}
                                     </button>
                                     <button
                                       onClick={async () => {
                                         const key = `mac:${session.examId}:${session.studentId}`;
                                         setResettingKey(key);
                                         try {
                                           await apiPost('sessions.php', {
                                             action: 'reset_mac',
                                             examId: session.examId,
                                             studentId: session.studentId
                                           });
                                           alert('MAC binding reset. Student can now take exam from a different device.');
                                           await onRefreshSessions();
                                         } catch (e) {
                                           console.error(e);
                                           alert('Failed to reset MAC binding.');
                                         } finally {
                                           setResettingKey(null);
                                         }
                                       }}
                                       className="flex items-center gap-1 px-3 py-1 rounded-full text-xs font-bold border border-purple-200 bg-purple-50 text-purple-700 hover:bg-purple-100"
                                       title="Reset MAC binding to allow student to take exam from different device"
                                       disabled={resettingKey === `mac:${session.examId}:${session.studentId}`}
                                     >
                                       <RotateCcw size={12} />
                                       {resettingKey === `mac:${session.examId}:${session.studentId}` ? 'Resetting...' : 'Reset MAC'}
                                     </button>
                                 </div>
                             </div>
                         </td>
                     </tr>
                 ))}
                 {displayData.length === 0 && (
                     <tr>
                         <td colSpan={5} className="py-12 text-center text-slate-400">
                             No active sessions match your criteria.
                         </td>
                     </tr>
                 )}
             </tbody>
         </table>
         </div>
         <Pagination state={paging} label="sessions" />
      </div>
    </div>
  );
};

const ClockIcon = () => (
    <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
);
