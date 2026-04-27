import React, { useEffect, useState } from 'react';
import { ShieldCheck, UserPlus, Search, Building2, UserRound, Ban, CheckCircle2 } from 'lucide-react';
import { CompanyDirectoryRecord, ManagedUserRecord, UserRole } from '../../types';
import { apiGet, apiPost } from '../../services/api';

interface UserDirectoryProps {
  role: UserRole;
}

const getStoredAdminCompanyId = () => {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem('pg_admin_auth');
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const companyId = Number(parsed?.companyId);
    return Number.isFinite(companyId) && companyId > 0 ? companyId : null;
  } catch {
    return null;
  }
};

export const UserDirectory: React.FC<UserDirectoryProps> = ({ role }) => {
  const isSuperAdmin = role === UserRole.SUPER_ADMIN;
  const adminCompanyId = getStoredAdminCompanyId();

  const [users, setUsers] = useState<ManagedUserRecord[]>([]);
  const [companies, setCompanies] = useState<CompanyDirectoryRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [statusBusyId, setStatusBusyId] = useState<number | null>(null);
  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState<'ALL' | UserRole>('ALL');
  const [companyFilter, setCompanyFilter] = useState<number | 'ALL'>(isSuperAdmin ? 'ALL' : (adminCompanyId ?? 'ALL'));
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [form, setForm] = useState({
    fullName: '',
    email: '',
    role: isSuperAdmin ? UserRole.ADMIN : UserRole.PROCTOR,
    companyId: isSuperAdmin ? '' : String(adminCompanyId ?? ''),
    registrationId: '',
    status: 'ACTIVE' as ManagedUserRecord['status'],
    notes: '',
  });

  const loadCompanies = async () => {
    if (!isSuperAdmin) return;
    try {
      const data = await apiGet<{ companies: CompanyDirectoryRecord[] }>('companies.php');
      setCompanies(data?.companies || []);
    } catch (e) {
      console.error('Failed to load companies:', e);
    }
  };

  const loadUsers = async () => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams();
      if (search.trim()) params.set('q', search.trim());
      if (roleFilter !== 'ALL') params.set('role', roleFilter);
      if (companyFilter !== 'ALL') params.set('companyId', String(companyFilter));
      const query = params.toString();
      const data = await apiGet<{ users: ManagedUserRecord[] }>(`users.php${query ? `?${query}` : ''}`);
      setUsers(data?.users || []);
    } catch (e: any) {
      console.error('Failed to load directory users:', e);
      setError(e?.message || 'Failed to load users.');
      setUsers([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadCompanies();
  }, [isSuperAdmin]);

  useEffect(() => {
    const id = window.setTimeout(() => {
      loadUsers();
    }, 120);
    return () => window.clearTimeout(id);
  }, [search, roleFilter, companyFilter, role]);

  const handleCreate = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setMessage('');
    setError('');
    try {
      const payload: Record<string, unknown> = {
        action: 'CREATE',
        fullName: form.fullName.trim(),
        email: form.email.trim(),
        role: form.role,
        status: form.status,
        notes: form.notes.trim(),
      };

      if (form.registrationId.trim()) {
        payload.registrationId = form.registrationId.trim();
      }

      if (form.role !== UserRole.SUPER_ADMIN) {
        const targetCompanyId = isSuperAdmin ? Number(form.companyId) : adminCompanyId;
        if (!targetCompanyId || !Number.isFinite(targetCompanyId)) {
          throw new Error('Please select a company.');
        }
        payload.companyId = targetCompanyId;
      }

      const result = await apiPost<{ users: ManagedUserRecord[] }>('users.php', payload);
      setUsers(result?.users || []);
      setMessage(`${form.role} user created successfully.`);
      setForm(current => ({
        ...current,
        fullName: '',
        email: '',
        registrationId: '',
        notes: '',
        role: isSuperAdmin ? current.role : UserRole.PROCTOR,
      }));
    } catch (e: any) {
      console.error('Failed to create user:', e);
      setError(e?.message || 'Failed to create user.');
    } finally {
      setSaving(false);
    }
  };

  const handleStatusChange = async (userId: number, status: ManagedUserRecord['status']) => {
    setStatusBusyId(userId);
    setMessage('');
    setError('');
    try {
      const payload: Record<string, unknown> = { action: 'STATUS', userId, status };
      if (!isSuperAdmin && adminCompanyId) {
        payload.companyId = adminCompanyId;
      }
      if (isSuperAdmin && companyFilter !== 'ALL') {
        payload.companyId = companyFilter;
      }
      const result = await apiPost<{ users: ManagedUserRecord[] }>('users.php', payload);
      setUsers(result?.users || []);
      setMessage(`User status changed to ${status}.`);
    } catch (e: any) {
      console.error('Failed to update user status:', e);
      setError(e?.message || 'Failed to update user status.');
    } finally {
      setStatusBusyId(null);
    }
  };

  const manageableRoles = isSuperAdmin
    ? [UserRole.SUPER_ADMIN, UserRole.ADMIN, UserRole.PROCTOR, UserRole.STUDENT]
    : [UserRole.PROCTOR, UserRole.STUDENT];

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <h2 className="lsc-title flex items-center gap-2">
            <ShieldCheck size={20} className="text-[#3558ff]" /> User Directory
          </h2>
          <p className="lsc-subtitle mt-1">
            {isSuperAdmin
              ? 'Manage platform identities across companies, with explicit role ownership and company mapping.'
              : 'Manage proctor and student identities inside your assigned company only.'}
          </p>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 w-full lg:w-auto">
          <div className="lsc-panel p-4 min-w-[170px]">
            <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Visible Users</p>
            <p className="text-2xl font-semibold text-slate-900 mt-2">{users.length}</p>
          </div>
          <div className="lsc-panel p-4 min-w-[170px]">
            <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Scope</p>
            <p className="text-sm font-semibold text-slate-900 mt-2">
              {isSuperAdmin ? 'All Companies' : `Company ${adminCompanyId ?? '-'}`}
            </p>
          </div>
          <div className="lsc-panel p-4 min-w-[170px]">
            <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Managed Roles</p>
            <p className="text-sm font-semibold text-slate-900 mt-2">
              {manageableRoles.join(', ')}
            </p>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-[1.1fr,1.9fr] gap-6">
        <div className="lsc-panel p-6">
          <div className="flex items-center gap-2 mb-4">
            <UserPlus size={18} className="text-[#3558ff]" />
            <h3 className="text-lg font-semibold text-slate-900">Create User</h3>
          </div>
          <form onSubmit={handleCreate} className="space-y-4">
            <div>
              <label className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Role</label>
              <select
                value={form.role}
                onChange={e => setForm(current => ({ ...current, role: e.target.value as UserRole }))}
                className="mt-2 w-full px-4 py-3 border border-slate-200 rounded-xl bg-white outline-none text-sm"
              >
                {manageableRoles.map(item => (
                  <option key={item} value={item}>{item}</option>
                ))}
              </select>
            </div>

            {isSuperAdmin && form.role !== UserRole.SUPER_ADMIN && (
              <div>
                <label className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Company</label>
                <select
                  value={form.companyId}
                  onChange={e => setForm(current => ({ ...current, companyId: e.target.value }))}
                  className="mt-2 w-full px-4 py-3 border border-slate-200 rounded-xl bg-white outline-none text-sm"
                >
                  <option value="">Select company</option>
                  {companies.map(company => (
                    <option key={company.id} value={company.id}>{company.name}</option>
                  ))}
                </select>
              </div>
            )}

            <div>
              <label className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Full Name</label>
              <input
                value={form.fullName}
                onChange={e => setForm(current => ({ ...current, fullName: e.target.value }))}
                className="mt-2 w-full px-4 py-3 border border-slate-200 rounded-xl bg-white outline-none text-sm"
                placeholder="Enter full name"
              />
            </div>

            <div>
              <label className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Email</label>
              <input
                type="email"
                value={form.email}
                onChange={e => setForm(current => ({ ...current, email: e.target.value }))}
                className="mt-2 w-full px-4 py-3 border border-slate-200 rounded-xl bg-white outline-none text-sm"
                placeholder="name@company.com"
              />
            </div>

            {form.role === UserRole.STUDENT && (
              <div>
                <label className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Registration Id</label>
                <input
                  value={form.registrationId}
                  onChange={e => setForm(current => ({ ...current, registrationId: e.target.value }))}
                  className="mt-2 w-full px-4 py-3 border border-slate-200 rounded-xl bg-white outline-none text-sm"
                  placeholder="Optional; auto-generated if blank"
                />
              </div>
            )}

            <div>
              <label className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Status</label>
              <select
                value={form.status}
                onChange={e => setForm(current => ({ ...current, status: e.target.value as ManagedUserRecord['status'] }))}
                className="mt-2 w-full px-4 py-3 border border-slate-200 rounded-xl bg-white outline-none text-sm"
              >
                <option value="ACTIVE">ACTIVE</option>
                <option value="INVITED">INVITED</option>
                <option value="DISABLED">DISABLED</option>
              </select>
            </div>

            <div>
              <label className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Notes</label>
              <textarea
                value={form.notes}
                onChange={e => setForm(current => ({ ...current, notes: e.target.value }))}
                className="mt-2 w-full min-h-[90px] px-4 py-3 border border-slate-200 rounded-xl bg-white outline-none text-sm resize-y"
                placeholder="Optional ownership or onboarding notes"
              />
            </div>

            <button
              type="submit"
              disabled={saving}
              className="w-full lsc-button-primary py-3 disabled:opacity-60"
            >
              {saving ? 'Saving User...' : 'Create User'}
            </button>
          </form>
        </div>

        <div className="lsc-panel overflow-hidden">
          <div className="p-5 lsc-panel-header border-b border-slate-200/70">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
              <div>
                <h3 className="text-lg font-semibold text-slate-900">Directory Roster</h3>
                <p className="text-xs text-slate-500 mt-1">Role-scoped identities with tenant ownership and activation state.</p>
              </div>
              <div className="flex flex-col sm:flex-row gap-3">
                <div className="relative">
                  <Search className="absolute left-3 top-2.5 text-slate-400" size={16} />
                  <input
                    value={search}
                    onChange={e => setSearch(e.target.value)}
                    placeholder="Search name, email, company..."
                    className="pl-9 pr-4 py-2 border border-slate-200 rounded-lg bg-white text-sm outline-none w-full sm:w-64"
                  />
                </div>
                <select
                  value={roleFilter}
                  onChange={e => setRoleFilter(e.target.value as 'ALL' | UserRole)}
                  className="px-3 py-2 border border-slate-200 rounded-lg bg-white text-sm outline-none"
                >
                  <option value="ALL">All Roles</option>
                  {manageableRoles.map(item => (
                    <option key={item} value={item}>{item}</option>
                  ))}
                </select>
                {isSuperAdmin && (
                  <select
                    value={companyFilter}
                    onChange={e => setCompanyFilter(e.target.value === 'ALL' ? 'ALL' : Number(e.target.value))}
                    className="px-3 py-2 border border-slate-200 rounded-lg bg-white text-sm outline-none"
                  >
                    <option value="ALL">All Companies</option>
                    {companies.map(company => (
                      <option key={company.id} value={company.id}>{company.name}</option>
                    ))}
                  </select>
                )}
              </div>
            </div>
            {message && <div className="mt-3 text-sm text-emerald-700 bg-emerald-50 border border-emerald-100 rounded-lg px-3 py-2">{message}</div>}
            {error && <div className="mt-3 text-sm text-rose-700 bg-rose-50 border border-rose-100 rounded-lg px-3 py-2">{error}</div>}
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-white border-b border-slate-200 text-xs uppercase tracking-[0.18em] text-slate-400">
                <tr>
                  <th className="px-4 py-3 text-left">User</th>
                  <th className="px-4 py-3 text-left">Scope</th>
                  <th className="px-4 py-3 text-left">Role</th>
                  <th className="px-4 py-3 text-left">Status</th>
                  <th className="px-4 py-3 text-left">Actions</th>
                </tr>
              </thead>
              <tbody>
                {loading && (
                  <tr>
                    <td colSpan={5} className="px-4 py-8 text-center text-slate-400">Loading directory...</td>
                  </tr>
                )}
                {!loading && users.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-4 py-8 text-center text-slate-400">No users found for the selected filters.</td>
                  </tr>
                )}
                {!loading && users.map(user => {
                  const statusTone = user.status === 'ACTIVE'
                    ? 'bg-emerald-100 text-emerald-700 border-emerald-200'
                    : user.status === 'INVITED'
                      ? 'bg-amber-100 text-amber-700 border-amber-200'
                      : 'bg-rose-100 text-rose-700 border-rose-200';

                  return (
                    <tr key={user.id} className="border-b border-slate-100 last:border-b-0">
                      <td className="px-4 py-4 align-top">
                        <div className="font-semibold text-slate-900 flex items-center gap-2">
                          <UserRound size={15} className="text-slate-400" />
                          {user.fullName}
                        </div>
                        <div className="text-xs text-slate-500 mt-1">{user.email}</div>
                        {user.registrationId && (
                          <div className="text-xs text-slate-400 mt-1">Reg ID: {user.registrationId}</div>
                        )}
                      </td>
                      <td className="px-4 py-4 align-top">
                        <div className="font-medium text-slate-800 flex items-center gap-2">
                          <Building2 size={15} className="text-slate-400" />
                          {user.companyName || 'Global'}
                        </div>
                        <div className="text-xs text-slate-500 mt-1">
                          {user.companyId ? `Company #${user.companyId}` : 'Cross-platform scope'}
                        </div>
                      </td>
                      <td className="px-4 py-4 align-top">
                        <span className="inline-flex items-center px-2.5 py-1 rounded-full border text-xs font-semibold bg-slate-100 text-slate-700 border-slate-200">
                          {user.role}
                        </span>
                      </td>
                      <td className="px-4 py-4 align-top">
                        <span className={`inline-flex items-center px-2.5 py-1 rounded-full border text-xs font-semibold ${statusTone}`}>
                          {user.status}
                        </span>
                      </td>
                      <td className="px-4 py-4 align-top">
                        <div className="flex flex-wrap gap-2">
                          {user.status !== 'ACTIVE' && (
                            <button
                              onClick={() => handleStatusChange(user.id, 'ACTIVE')}
                              disabled={statusBusyId === user.id}
                              className="px-3 py-1.5 text-xs rounded-lg border border-emerald-200 text-emerald-700 bg-emerald-50 disabled:opacity-60 flex items-center gap-1"
                            >
                              <CheckCircle2 size={13} /> Activate
                            </button>
                          )}
                          {user.status !== 'DISABLED' && (
                            <button
                              onClick={() => handleStatusChange(user.id, 'DISABLED')}
                              disabled={statusBusyId === user.id}
                              className="px-3 py-1.5 text-xs rounded-lg border border-rose-200 text-rose-700 bg-rose-50 disabled:opacity-60 flex items-center gap-1"
                            >
                              <Ban size={13} /> Disable
                            </button>
                          )}
                          {user.status !== 'INVITED' && (
                            <button
                              onClick={() => handleStatusChange(user.id, 'INVITED')}
                              disabled={statusBusyId === user.id}
                              className="px-3 py-1.5 text-xs rounded-lg border border-amber-200 text-amber-700 bg-amber-50 disabled:opacity-60"
                            >
                              Mark Invited
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
};
