import React, { useMemo, useState } from 'react';
import { ExamSession, Student, Exam } from '../../types';
import { Globe, Users, ShieldAlert, Monitor, Wifi, MapPin, Search, AlertTriangle, Network, RotateCcw } from 'lucide-react';
import { apiPost } from '../../services/api';

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
  const telemetry = useMemo(() => {
    const activeSessions = sessions.filter(s => s.status === 'IN_PROGRESS');
    
    // Group by IP to find clusters
    const ipMap = new Map<string, string[]>(); // IP -> [StudentIds]
    activeSessions.forEach(s => {
        if (s.ipAddress) {
            const current = ipMap.get(s.ipAddress) || [];
            current.push(s.studentId);
            ipMap.set(s.ipAddress, current);
        }
    });

    const clusters = Array.from(ipMap.entries())
        .filter(([_, ids]) => ids.length > 1)
        .map(([ip, ids]) => ({ ip, studentIds: ids }));

    return {
        activeCount: activeSessions.length,
        clusterCount: clusters.length,
        clusters,
        activeSessions
    };
  }, [sessions]);

  // Combine data for display
  const displayData = sessions.map(session => {
    const student = students.find(s => s.id === session.studentId);
    const exam = exams.find(e => e.id === session.examId);
    const isClustered = telemetry.clusters.some(c => c.ip === session.ipAddress);
    
    return {
        ...session,
        studentName: student?.fullName || 'Unknown Student',
        studentReg: student?.registrationId || '---',
        examTitle: exam?.title || 'Unknown Exam',
        isClustered,
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
    
    const isSuspicious = item.isClustered || item.isIpChanged || item.isDeviceChanged || item.isLocationChanged;
    if (filterType === 'SUSPICIOUS') return matchesSearch && isSuspicious && item.isActive;
    return matchesSearch;
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
        <div>
           <h2 className="lsc-title flex items-center gap-2">
             <Network className="text-[#3558ff]" /> Network Monitoring
           </h2>
           <p className="lsc-subtitle mt-1">Real-time IP analysis, device changes, and anomaly detection.</p>
        </div>
        
        <div className="flex flex-wrap gap-3">
            <div className="lsc-panel px-4 py-3 flex items-center gap-3">
                <div className="p-2 bg-teal-100 text-teal-600 rounded-full">
                    <Wifi size={18} />
                </div>
                <div>
                    <div className="text-2xl font-bold text-slate-900 leading-none">{telemetry.activeCount}</div>
                    <div className="text-[10px] text-slate-500 font-semibold uppercase tracking-widest">Active Connections</div>
                </div>
            </div>
            <div className={`lsc-panel px-4 py-3 flex items-center gap-3 transition-colors ${telemetry.clusterCount > 0 ? 'bg-rose-50 border-rose-200' : ''}`}>
                <div className={`p-2 rounded-full ${telemetry.clusterCount > 0 ? 'bg-rose-100 text-rose-600' : 'bg-slate-100 text-slate-400'}`}>
                    <ShieldAlert size={18} />
                </div>
                <div>
                    <div className={`text-2xl font-bold leading-none ${telemetry.clusterCount > 0 ? 'text-rose-700' : 'text-slate-900'}`}>{telemetry.clusterCount}</div>
                    <div className="text-[10px] text-slate-500 font-semibold uppercase tracking-widest">IP Clusters</div>
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
                className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${filterType === 'SUSPICIOUS' ? 'bg-[#d94f34] text-white shadow-sm' : 'text-slate-600 hover:bg-orange-50 hover:text-orange-600'}`}
            >
                <AlertTriangle size={16} /> Suspicious Only
            </button>
         </div>
         <div className="relative">
             <Search className="absolute left-3 top-2.5 text-gray-400" size={16} />
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
                     <th className="px-6 py-4 font-semibold text-gray-500 uppercase tracking-wider text-xs">Student</th>
                     <th className="px-6 py-4 font-semibold text-gray-500 uppercase tracking-wider text-xs">Active Exam</th>
                     <th className="px-6 py-4 font-semibold text-gray-500 uppercase tracking-wider text-xs">Network Identity (IP)</th>
                     <th className="px-6 py-4 font-semibold text-gray-500 uppercase tracking-wider text-xs">Device / MAC</th>
                     <th className="px-6 py-4 font-semibold text-gray-500 uppercase tracking-wider text-xs text-right">Actions</th>
                 </tr>
             </thead>
             <tbody className="divide-y divide-gray-100">
                 {displayData.map((session, idx) => (
                     <tr key={idx} className={`hover:bg-gray-50/80 transition-colors ${session.isClustered ? 'bg-red-50/30' : ''}`}>
                         <td className="px-6 py-4">
                             <div className="font-bold text-gray-900">{session.studentName}</div>
                             <div className="text-xs text-gray-500 font-mono">{session.studentReg}</div>
                         </td>
                         <td className="px-6 py-4">
                             <div className="text-gray-700 font-medium truncate max-w-[200px]" title={session.examTitle}>{session.examTitle}</div>
                             <div className="text-xs text-gray-500 flex items-center gap-1 mt-0.5">
                                 <ClockIcon /> {Math.floor((Date.now() - session.startTime) / 60000)}m elapsed
                             </div>
                         </td>
                         <td className="px-6 py-4 font-mono">
                             <div className="flex items-center gap-2">
                                 <span className="bg-gray-100 px-2 py-1 rounded text-gray-700 font-medium border border-gray-200">
                                     {session.ipAddress || 'Unknown'}
                                 </span>
                                 {session.isClustered && (
                                     <span className="flex items-center gap-1 text-[10px] font-bold bg-red-100 text-red-700 px-2 py-0.5 rounded-full border border-red-200 animate-pulse">
                                         <AlertTriangle size={10} /> CLUSTER
                                     </span>
                                 )}
                                 {session.isIpChanged && (
                                     <span className="flex items-center gap-1 text-[10px] font-bold bg-amber-100 text-amber-700 px-2 py-0.5 rounded-full border border-amber-200">
                                         <AlertTriangle size={10} /> IP CHANGE
                                     </span>
                                 )}
                             </div>
                         </td>
                         <td className="px-6 py-4">
                             <div className="flex items-center gap-1.5 text-gray-700">
                                 <MapPin size={14} className="text-gray-400" />
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
                             <div className="text-xs text-gray-400 mt-1 truncate max-w-[150px]" title={session.userAgent}>
                                 {session.userAgent?.split(')')[0] + ')' || 'Unknown Device'}
                             </div>
                             <div className="mt-1 flex items-center gap-2 text-[11px] text-gray-500">
                                 <span className="font-mono bg-gray-100 px-2 py-0.5 rounded border border-gray-200">
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
                                 <div className={`flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold border ${session.isClustered || session.isIpChanged || session.isDeviceChanged || session.isLocationChanged ? 'bg-red-100 text-red-700 border-red-200' : 'bg-teal-100 text-teal-700 border-teal-200'}`}>
                                     {session.isClustered || session.isIpChanged || session.isDeviceChanged || session.isLocationChanged ? (
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
                                 {session.status !== 'COMPLETED' && (
                                   <div className="flex items-center gap-2">
                                     <button
                                       onClick={async () => {
                                         const key = `${session.examId}:${session.studentId}`;
                                         setResettingKey(key);
                                         try {
                                           await apiPost('sessions.php', {
                                             action: 'reset',
                                             examId: session.examId,
                                             studentId: session.studentId
                                           });
                                           alert('Link renewed. Student can start again.');
                                           await onRefreshSessions();
                                         } catch (e) {
                                           console.error(e);
                                           alert('Failed to renew link.');
                                         } finally {
                                           setResettingKey(null);
                                         }
                                       }}
                                       className="flex items-center gap-1 px-3 py-1 rounded-full text-xs font-bold border border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-100"
                                       title="Renew link if not completed"
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
                                 )}
                             </div>
                         </td>
                     </tr>
                 ))}
                 {displayData.length === 0 && (
                     <tr>
                         <td colSpan={5} className="py-12 text-center text-gray-400">
                             No active sessions match your criteria.
                         </td>
                     </tr>
                 )}
             </tbody>
         </table>
         </div>
      </div>
      
      {/* Cluster Analysis Detail */}
      {telemetry.clusters.length > 0 && (
          <div className="bg-red-50 border border-red-200 rounded-xl p-6">
              <h3 className="text-red-900 font-bold flex items-center gap-2 mb-4">
                  <ShieldAlert className="text-red-600" /> Detected IP Anomalies
              </h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {telemetry.clusters.map((cluster, i) => (
                      <div key={i} className="bg-white p-4 rounded-lg border border-red-100 shadow-sm">
                          <div className="flex justify-between items-center mb-2">
                              <span className="font-mono text-sm font-bold text-gray-700 bg-gray-100 px-2 py-1 rounded">
                                  IP: {cluster.ip}
                              </span>
                              <span className="text-xs font-bold text-red-600 bg-red-100 px-2 py-1 rounded-full">
                                  {cluster.studentIds.length} Students
                              </span>
                          </div>
                          <p className="text-xs text-gray-500 mb-2">Multiple students are accessing exams from the exact same network address simultaneously.</p>
                          <div className="flex flex-wrap gap-2">
                              {cluster.studentIds.map(sid => {
                                  const s = students.find(st => st.id === sid);
                                  return (
                                      <span key={sid} className="text-xs bg-red-50 text-red-800 border border-red-100 px-2 py-1 rounded">
                                          {s?.fullName}
                                      </span>
                                  )
                              })}
                          </div>
                      </div>
                  ))}
              </div>
          </div>
      )}
    </div>
  );
};

const ClockIcon = () => (
    <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
);
