import React, { useEffect, useMemo, useState } from 'react';
import { AuditLog, Student, UserRole } from '../../types';
import { apiGet } from '../../services/api';
import { Pagination, usePagination } from './Pagination';
import { Search, ShieldCheck, User, Server } from 'lucide-react';

export const ActivityLogs: React.FC<{ students?: Student[]; role?: UserRole }> = ({ students = [], role }) => {
  // Only super admins can see (and filter by) super-admin / platform activity; the API enforces
  // this too, so the option is hidden here to avoid an empty, misleading filter for company staff.
  const isSuperAdmin = role === UserRole.SUPER_ADMIN;
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState<'ALL' | 'ADMIN' | 'SUPER_ADMIN' | 'PROCTOR' | 'STUDENT' | 'SYSTEM'>('ALL');

  const studentMap = useMemo(() => {
    const map = new Map<string, Student>();
    students.forEach(s => map.set(s.id, s));
    return map;
  }, [students]);

  const formatStudent = (studentId?: string | null) => {
    if (!studentId) return 'N/A';
    const student = studentMap.get(studentId);
    if (!student) return studentId;
    return `${student.fullName} (${student.registrationId})`;
  };

  const loadLogs = async () => {
    setLoading(true);
    try {
      const data = await apiGet<{ logs: AuditLog[] }>('audit.php?limit=200');
      setLogs(data?.logs || []);
    } catch (e) {
      console.error('Failed to load audit logs:', e);
      setLogs([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadLogs();
  }, []);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return logs.filter(log => {
      if (roleFilter !== 'ALL' && log.actorRole !== roleFilter) return false;
      if (!term) return true;
      const haystack = [
        log.action,
        log.actorId,
        log.actorRole === 'STUDENT' ? formatStudent(log.actorId) : '',
        log.targetType,
        log.targetId,
        log.targetType === 'student' ? formatStudent(log.targetId) : '',
        log.message,
        log.ipAddress,
        log.userAgent
      ].filter(Boolean).join(' ').toLowerCase();
      return haystack.includes(term);
    });
  }, [logs, search, roleFilter]);

  const paging = usePagination(filtered, `${search}|${roleFilter}`);

  const renderRoleBadge = (role: AuditLog['actorRole']) => {
    if (role === 'ADMIN') return { label: 'ADMIN', tone: 'bg-blue-100 text-blue-700 border-blue-200', icon: <ShieldCheck size={12} /> };
    if (role === 'SUPER_ADMIN') return { label: 'SUPER ADMIN', tone: 'bg-violet-100 text-violet-700 border-violet-200', icon: <ShieldCheck size={12} /> };
    if (role === 'PROCTOR') return { label: 'PROCTOR', tone: 'bg-orange-100 text-orange-700 border-orange-200', icon: <ShieldCheck size={12} /> };
    if (role === 'STUDENT') return { label: 'STUDENT', tone: 'bg-teal-100 text-teal-700 border-teal-200', icon: <User size={12} /> };
    return { label: 'SYSTEM', tone: 'bg-slate-100 text-slate-600 border-slate-200', icon: <Server size={12} /> };
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h2 className="lsc-title flex items-center gap-2">
            Activity Audit Logs
          </h2>
          <p className="lsc-subtitle mt-1">Track administrative and student actions across the platform.</p>
        </div>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className="relative">
            <Search className="absolute left-3 top-2.5 text-slate-400" size={16} />
            <input
              type="text"
              placeholder="Search action, actor, target..."
              className="pl-9 pr-4 py-2 border border-slate-200 rounded-lg outline-none w-full sm:w-64 text-sm bg-white"
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </div>
          <select
            value={roleFilter}
            onChange={e => setRoleFilter(e.target.value as typeof roleFilter)}
            className="px-3 py-2 border border-slate-200 rounded-lg text-sm outline-none bg-white"
          >
            <option value="ALL">All Roles</option>
            <option value="ADMIN">Admin</option>
            {isSuperAdmin && <option value="SUPER_ADMIN">Super Admin</option>}
            <option value="PROCTOR">Proctor</option>
            <option value="STUDENT">Student</option>
            <option value="SYSTEM">System</option>
          </select>
        </div>
      </div>

      <div className="lsc-panel overflow-hidden">
        <div className="p-4 lsc-panel-header flex items-center justify-between">
          <div className="text-sm font-semibold text-slate-800">Recent Activity</div>
          <div className="text-xs text-slate-500">{filtered.length} events</div>
        </div>
        {loading && (
          <div className="p-6 text-sm text-slate-400">Loading audit logs...</div>
        )}
        {!loading && filtered.length === 0 && (
          <div className="p-6 text-sm text-slate-400">No audit logs found.</div>
        )}
        {!loading && filtered.length > 0 && (
          <div className="lsc-table-wrap">
            <table className="w-full text-left text-sm">
              <thead className="bg-white border-b border-slate-200 text-xs uppercase tracking-widest text-slate-400">
                <tr>
                  <th className="px-4 py-3">Time</th>
                  <th className="px-4 py-3">Actor</th>
                  <th className="px-4 py-3">Action</th>
                  <th className="px-4 py-3">Target</th>
                  <th className="px-4 py-3">Message</th>
                  <th className="px-4 py-3">IP</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {paging.pageItems.map(log => {
                  const badge = renderRoleBadge(log.actorRole);
                  const actorLabel = log.actorRole === 'STUDENT' ? formatStudent(log.actorId) : (log.actorId || 'N/A');
                  const targetLabel = log.targetType
                    ? `${log.targetType}:${log.targetType === 'student' ? formatStudent(log.targetId) : (log.targetId || '-')}`
                    : 'N/A';
                  return (
                    <tr key={log.id} className="text-slate-700 hover:bg-slate-50/70">
                      <td className="px-4 py-3 whitespace-nowrap text-xs text-slate-500">
                        {new Date(log.createdAt).toLocaleString()}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <span className={`inline-flex items-center gap-1 text-[10px] font-bold px-2 py-1 rounded-full border ${badge.tone}`}>
                            {badge.icon} {badge.label}
                          </span>
                          <span className="text-xs text-slate-600">
                            {actorLabel}
                          </span>
                        </div>
                      </td>
                      <td className="px-4 py-3 font-semibold text-slate-900">{log.action}</td>
                      <td className="px-4 py-3 text-xs text-slate-500">
                        {targetLabel}
                      </td>
                      <td className="px-4 py-3 text-xs text-slate-500 max-w-[260px] truncate" title={log.message || ''}>
                        {log.message || 'N/A'}
                      </td>
                      <td className="px-4 py-3 text-xs text-slate-500">
                        {log.ipAddress || 'N/A'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {!loading && filtered.length > 0 && <Pagination state={paging} label="events" />}
      </div>
    </div>
  );
};
