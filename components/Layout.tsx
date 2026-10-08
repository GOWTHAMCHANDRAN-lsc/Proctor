import React, { useEffect, useState } from 'react';
import { CompanyDirectoryRecord, UserRole } from '../types';
import { ShieldCheck, ShieldAlert, UserCog, LogOut, LayoutDashboard, FileText, Users, AlertTriangle, Radio, ClipboardList, Activity, Menu, X, Film, Building2, Settings as SettingsIcon, Webhook, Award, Mail, Library, Inbox } from 'lucide-react';
import { apiGet, getApiErrorMessage } from '../services/api';
import { useSettings } from '../services/appSettings';

interface LayoutProps {
  children: React.ReactNode;
  role: UserRole;
  currentView: string;
  onNavigate: (view: string) => void;
  onLogout: () => void;
  activeCompanyId?: number | null;
  onCompanyChange?: (companyId: number) => void;
}

// Super-admin company switcher shown at the top of every page. Picking a company scopes the
// whole console (via the stored companyId that the API layer sends as X-Company-Id).
const CompanySwitcher: React.FC<{ value: number | null; onChange: (companyId: number) => void }> = ({ value, onChange }) => {
  const [companies, setCompanies] = useState<CompanyDirectoryRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [reloadNonce, setReloadNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError('');
    (async () => {
      try {
        const data = await apiGet<{ companies: CompanyDirectoryRecord[] }>('companies.php');
        if (!cancelled) setCompanies(data?.companies || []);
      } catch (e) {
        console.error('Failed to load companies for switcher:', e);
        // Without this the dropdown just stayed empty and the super admin had no way to scope
        // (and so load) any company data.
        if (!cancelled) setLoadError(getApiErrorMessage(e, 'Could not load companies.'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [reloadNonce]);

  return (
    <div className="mb-4 rounded-xl border border-slate-200 bg-white px-4 py-3 shadow-sm">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Building2 size={18} className="shrink-0 text-[var(--lsc-primary)]" />
        <label htmlFor="lsc-active-company" className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">Active Company</label>
        <select
          id="lsc-active-company"
          value={value ?? ''}
          disabled={loading && companies.length === 0}
          onChange={e => { if (e.target.value) onChange(Number(e.target.value)); }}
          className="w-full min-w-0 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 outline-none disabled:opacity-60 sm:ml-auto sm:w-auto sm:min-w-[200px]"
        >
          <option value="" disabled>{loading && companies.length === 0 ? 'Loading companies…' : 'Select a company…'}</option>
          {companies.map(company => (
            <option key={company.id} value={company.id}>{company.name}</option>
          ))}
        </select>
      </div>
      {loadError ? (
        <div role="alert" className="mt-2 flex flex-wrap items-center gap-2 text-xs text-red-700">
          <span>{loadError}</span>
          <button type="button" onClick={() => setReloadNonce(n => n + 1)} className="font-semibold underline hover:text-red-800">
            Retry
          </button>
        </div>
      ) : value === null && !loading ? (
        <p className="mt-2 text-xs text-slate-500">Select a company to load its exams, students and results on every screen.</p>
      ) : null}
    </div>
  );
};

export const Layout: React.FC<LayoutProps> = ({ children, role, currentView, onNavigate, onLogout, activeCompanyId = null, onCompanyChange }) => {
  const { settings } = useSettings();
  const branding = settings.branding;
  const appName = branding.appName || 'LSC Exam Proctor';
  // Hooks must run unconditionally — this used to be declared after the STUDENT early return,
  // which breaks the Rules of Hooks (React throws if `role` ever flips across that branch).
  const [mobileOpen, setMobileOpen] = useState(false);

  // Let keyboard users dismiss the mobile navigation drawer with Escape.
  useEffect(() => {
    if (!mobileOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMobileOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mobileOpen]);

  // Signed-in identity for the sidebar footer (falls back to the role label).
  const adminIdentity = (() => {
    if (typeof window === 'undefined') return null;
    try {
      const raw = localStorage.getItem('pg_admin_auth');
      if (!raw) return null;
      const p = JSON.parse(raw);
      const name = typeof p?.name === 'string' && p.name.trim() ? p.name.trim() : null;
      const email = typeof p?.email === 'string' && p.email.trim() ? p.email.trim() : null;
      return name || email ? { name, email } : null;
    } catch {
      return null;
    }
  })();
  const brandMark = (sizeClass: string, textClass: string) => (
    <div className={`lsc-brand-mark ${sizeClass} ${textClass} overflow-hidden`}>
      {branding.logoDataUrl
        ? <img src={branding.logoDataUrl} alt="" className="h-full w-full object-contain bg-white" />
        : (branding.shortName || 'LSC')}
    </div>
  );

  if (role === UserRole.STUDENT) {
    // Simplified layout for students to reduce distraction
    return (
      <div className="min-h-screen bg-slate-50 flex flex-col">
        <header className="bg-white/85 backdrop-blur border-b border-slate-200 px-4 sm:px-6 py-4 flex justify-between items-center">
          <div className="flex items-center gap-3">
            {brandMark('h-10 w-10', 'text-sm')}
            <div>
              <h1 className="text-lg sm:text-xl font-semibold text-slate-900">{appName}</h1>
              <p className="text-[10px] uppercase tracking-[0.28em] text-slate-400">Student Portal</p>
            </div>
          </div>
          <button onClick={onLogout} className="text-sm text-slate-500 hover:text-red-600 font-medium">Exit</button>
        </header>
        <main className="flex-1 p-4 sm:p-6 max-w-5xl mx-auto w-full">
          {children}
        </main>
      </div>
    );
  }

  // Admin Layout
  const isProctor = role === UserRole.PROCTOR;
  const isViewer = role === UserRole.VIEWER;
  const isSuperAdmin = role === UserRole.SUPER_ADMIN;
  // Only ADMIN / SUPER_ADMIN manage tenant data (users, exams, students, settings).
  const isFullAdmin = role === UserRole.ADMIN || role === UserRole.SUPER_ADMIN;
  const consoleLabel = isSuperAdmin
    ? 'Super Admin Console'
    : isProctor
      ? 'Proctor Console'
      : isViewer
        ? 'Viewer Console'
        : 'Admin Console';
  const handleNavigate = (view: string) => {
    onNavigate(view);
    setMobileOpen(false);
  };

  return (
    <div className="min-h-screen lsc-gradient-bg flex">
      {/* Mobile Header */}
      <header className="lg:hidden fixed top-0 left-0 right-0 z-20 bg-white border-b border-slate-200 px-4 py-3 flex items-center justify-between shadow-sm">
        <button
          type="button"
          onClick={() => setMobileOpen(true)}
          aria-label="Open navigation menu"
          aria-expanded={mobileOpen}
          aria-controls="lsc-admin-sidebar"
          className="p-2 rounded-lg border border-slate-200 text-slate-600 hover:text-slate-900 hover:bg-slate-50"
        >
          <Menu size={18} />
        </button>
        <div className="flex items-center gap-2 min-w-0">
          {brandMark('h-9 w-9', 'text-[11px]')}
          <div className="text-sm font-semibold text-slate-900 truncate">{appName}</div>
        </div>
        <button
          onClick={onLogout}
          className="text-xs font-semibold text-slate-500 hover:text-slate-900"
        >
          Logout
        </button>
      </header>

      {mobileOpen && (
        <div
          className="fixed inset-0 bg-slate-900/40 z-20 lg:hidden"
          onClick={() => setMobileOpen(false)}
        />
      )}

      {/* Sidebar — sticky full-height on desktop so the nav and the account/logout footer stay in view
          on long pages (it used to stretch to the content height and scroll away with it). */}
      <aside id="lsc-admin-sidebar" aria-label="Main navigation" className={`fixed inset-y-0 left-0 w-72 max-w-[84vw] bg-white border-r border-slate-200 flex flex-col z-30 shadow-xl lg:shadow-none transform transition-transform duration-300 ${
        mobileOpen ? 'translate-x-0' : '-translate-x-full'
      } lg:translate-x-0 lg:sticky lg:top-0 lg:bottom-auto lg:h-screen lg:shrink-0`}>
        <div className="px-5 h-16 shrink-0 border-b border-slate-200 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            {brandMark('h-9 w-9', 'text-[13px]')}
            <div className="min-w-0">
              <div className="text-[15px] font-semibold text-slate-900 leading-tight truncate">{appName}</div>
              <div className="text-[11px] font-medium text-slate-400 truncate">{consoleLabel}</div>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setMobileOpen(false)}
            aria-label="Close navigation menu"
            className="lg:hidden p-2 rounded-lg border border-slate-200 text-slate-500 hover:text-slate-900 hover:bg-slate-50"
          >
            <X size={16} />
          </button>
        </div>

        <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto">
          {isSuperAdmin && (
            <NavItem
              icon={<ShieldCheck size={18} />}
              label="Control Center"
              active={currentView === 'platform'}
              onClick={() => handleNavigate('platform')}
            />
          )}
          <NavItem 
            icon={<LayoutDashboard size={18} />} 
            label="Dashboard" 
            active={currentView === 'dashboard'} 
            onClick={() => handleNavigate('dashboard')} 
          />
          {isFullAdmin && (
            <NavItem
              icon={<UserCog size={18} />}
              label="Users"
              active={currentView === 'users'}
              onClick={() => handleNavigate('users')}
            />
          )}
          {isFullAdmin && (
            <NavItem
              icon={<FileText size={18} />}
              label="Exams"
              active={currentView === 'exams'}
              onClick={() => handleNavigate('exams')}
            />
          )}
          {isFullAdmin && (
            <NavItem
              icon={<Library size={18} />}
              label="Question Bank"
              active={currentView === 'question-bank'}
              onClick={() => handleNavigate('question-bank')}
            />
          )}
          {isSuperAdmin && (
            <NavItem
              icon={<Inbox size={18} />}
              label="Exam Requests"
              active={currentView === 'exam-requests'}
              onClick={() => handleNavigate('exam-requests')}
            />
          )}
          {isFullAdmin && (
            <NavItem
              icon={<Users size={18} />}
              label="Students"
              active={currentView === 'students'}
              onClick={() => handleNavigate('students')}
            />
          )}
          {isFullAdmin && (
            <NavItem
              icon={<Webhook size={18} />}
              label="Integrations"
              active={currentView === 'integrations'}
              onClick={() => handleNavigate('integrations')}
            />
          )}
          {isFullAdmin && (
            <NavItem
              icon={<Award size={18} />}
              label="Certificates"
              active={currentView === 'certificates'}
              onClick={() => handleNavigate('certificates')}
            />
          )}
          {isFullAdmin && (
            <NavItem
              icon={<Mail size={18} />}
              label="Communications"
              active={currentView === 'communications'}
              onClick={() => handleNavigate('communications')}
            />
          )}
          {!isViewer && (
            <NavItem
              icon={<Radio size={18} />}
              label="Live Proctoring"
              active={currentView === 'live'}
              onClick={() => handleNavigate('live')}
            />
          )}
          {!isViewer && (
            <NavItem
              icon={<AlertTriangle size={18} />}
              label="Monitoring"
              active={currentView === 'monitoring'}
              onClick={() => handleNavigate('monitoring')}
            />
          )}
          {!isProctor && (
            <NavItem
              icon={<ClipboardList size={18} />}
              label="Results"
              active={currentView === 'results'}
              onClick={() => handleNavigate('results')}
            />
          )}
          {!isViewer && (
            <NavItem
              icon={<ShieldAlert size={18} />}
              label="Security Feed"
              active={currentView === 'security'}
              onClick={() => handleNavigate('security')}
            />
          )}
          {!isViewer && (
            <NavItem
              icon={<Film size={18} />}
              label="Recordings"
              active={currentView === 'recordings'}
              onClick={() => handleNavigate('recordings')}
            />
          )}
          {!isViewer && (
            <NavItem
              icon={<Activity size={18} />}
              label="Activity Logs"
              active={currentView === 'audit'}
              onClick={() => handleNavigate('audit')}
            />
          )}
          {/* Every signed-in staff member (incl. proctor/viewer) gets Settings so they can change
              their own password; non-admins only see the Security section inside it. */}
          <NavItem
            icon={<SettingsIcon size={18} />}
            label="Settings"
            active={currentView === 'settings'}
            onClick={() => handleNavigate('settings')}
          />
        </nav>

        <div className="p-3 border-t border-slate-200">
          <div className="flex items-center gap-3 px-2 py-2 rounded-xl">
            <div className="h-9 w-9 shrink-0 rounded-full bg-[var(--lsc-primary-50)] text-[var(--lsc-primary)] flex items-center justify-center text-sm font-semibold uppercase">
              {(adminIdentity?.name || adminIdentity?.email || consoleLabel).charAt(0)}
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-semibold text-slate-800 truncate">{adminIdentity?.name || adminIdentity?.email || consoleLabel}</div>
              <div className="text-[11px] text-slate-400 truncate">{adminIdentity?.name && adminIdentity?.email ? adminIdentity.email : consoleLabel}</div>
            </div>
            <button
              type="button"
              onClick={onLogout}
              aria-label="Logout"
              title="Logout"
              className="p-2 rounded-lg text-slate-400 hover:text-red-600 hover:bg-red-50 transition-colors"
            >
              <LogOut size={18} />
            </button>
          </div>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 min-w-0 p-4 sm:p-6 lg:p-8 pt-20 lg:pt-8 overflow-y-auto">
        <div className="mx-auto w-full min-w-0 lsc-page">
          {isSuperAdmin && onCompanyChange && (
            <CompanySwitcher value={activeCompanyId} onChange={onCompanyChange} />
          )}
          {children}
        </div>
      </main>
    </div>
  );
};

const NavItem = ({ icon, label, active, onClick }: { icon: React.ReactNode, label: string, active: boolean, onClick: () => void }) => (
  <button
    type="button"
    onClick={onClick}
    aria-current={active ? 'page' : undefined}
    className={`group flex items-center gap-3 w-full pl-3.5 pr-3 py-2.5 rounded-lg text-[14px] transition-colors ${
      active
        ? 'bg-[var(--lsc-primary-50)] text-[var(--lsc-primary)] font-semibold'
        : 'text-slate-600 font-medium hover:bg-slate-100 hover:text-slate-900'
    }`}
  >
    <span className={active ? 'text-[var(--lsc-primary)]' : 'text-slate-400 group-hover:text-slate-600'}>{icon}</span>
    <span>{label}</span>
  </button>
);
