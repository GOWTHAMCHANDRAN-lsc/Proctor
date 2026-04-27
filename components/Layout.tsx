import React, { useState } from 'react';
import { UserRole } from '../types';
import { ShieldCheck, LogOut, LayoutDashboard, FileText, Users, AlertTriangle, Radio, ClipboardList, Activity, Menu, X, Film } from 'lucide-react';

interface LayoutProps {
  children: React.ReactNode;
  role: UserRole;
  currentView: string;
  onNavigate: (view: string) => void;
  onLogout: () => void;
}

export const Layout: React.FC<LayoutProps> = ({ children, role, currentView, onNavigate, onLogout }) => {
  if (role === UserRole.STUDENT) {
    // Simplified layout for students to reduce distraction
    return (
      <div className="min-h-screen bg-slate-50 flex flex-col">
        <header className="bg-white/85 backdrop-blur border-b border-slate-200 px-4 sm:px-6 py-4 flex justify-between items-center">
          <div className="flex items-center gap-3">
            <div className="lsc-brand-mark h-10 w-10 text-sm">LSC</div>
            <div>
              <h1 className="text-lg sm:text-xl font-semibold text-slate-900">LSC Exam Proctor</h1>
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
  const [mobileOpen, setMobileOpen] = useState(false);
  const isProctor = role === UserRole.PROCTOR;
  const isSuperAdmin = role === UserRole.SUPER_ADMIN;
  const consoleLabel = role === UserRole.SUPER_ADMIN ? 'Super Admin Console' : (isProctor ? 'Proctor Console' : 'Admin Console');
  const handleNavigate = (view: string) => {
    onNavigate(view);
    setMobileOpen(false);
  };

  return (
    <div className="min-h-screen lsc-gradient-bg flex">
      {/* Mobile Header */}
      <header className="lg:hidden fixed top-0 left-0 right-0 z-20 bg-white/88 backdrop-blur-xl border-b border-slate-200 px-4 py-3 flex items-center justify-between shadow-[0_16px_40px_-34px_rgba(16,24,40,0.42)]">
        <button
          onClick={() => setMobileOpen(true)}
          className="p-2 rounded-lg border border-slate-200 text-slate-600 hover:text-slate-900 hover:bg-slate-50"
        >
          <Menu size={18} />
        </button>
        <div className="flex items-center gap-2 min-w-0">
          <div className="lsc-brand-mark h-9 w-9 text-[11px]">LSC</div>
          <div className="text-sm font-semibold text-slate-900 truncate">LSC Exam Proctor</div>
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
          className="fixed inset-0 bg-slate-900/45 backdrop-blur-[2px] z-20 lg:hidden"
          onClick={() => setMobileOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside className={`fixed inset-y-0 left-0 w-80 max-w-[86vw] bg-white/88 backdrop-blur-xl border-r border-slate-200/70 flex flex-col z-30 shadow-[0_24px_60px_-42px_rgba(16,24,40,0.62)] transform transition-transform duration-300 ${
        mobileOpen ? 'translate-x-0' : '-translate-x-full'
      } lg:translate-x-0 lg:static lg:shadow-[0_24px_60px_-42px_rgba(16,24,40,0.62)]`}>
        <div className="p-6 border-b border-slate-200/70 flex items-center justify-between gap-3 bg-[linear-gradient(180deg,rgba(248,250,255,0.92),rgba(241,245,252,0.78))]">
          <div className="flex items-center gap-3">
            <div className="lsc-brand-mark h-10 w-10 text-sm">LSC</div>
            <div>
              <div className="text-lg font-semibold text-slate-900 leading-tight">LSC Exam Proctor</div>
              <div className="text-xs uppercase tracking-[0.24em] text-slate-500">{consoleLabel}</div>
            </div>
          </div>
          <button
            onClick={() => setMobileOpen(false)}
            className="lg:hidden p-2 rounded-lg border border-slate-200 text-slate-500 hover:text-slate-900 hover:bg-slate-50"
          >
            <X size={16} />
          </button>
        </div>
        
        <nav className="flex-1 p-4 space-y-2">
          {isSuperAdmin && (
            <NavItem
              icon={<ShieldCheck size={20} />}
              label="Control Center"
              active={currentView === 'platform'}
              onClick={() => handleNavigate('platform')}
            />
          )}
          <NavItem 
            icon={<LayoutDashboard size={20} />} 
            label="Dashboard" 
            active={currentView === 'dashboard'} 
            onClick={() => handleNavigate('dashboard')} 
          />
          {!isProctor && (
            <NavItem
              icon={<ShieldCheck size={20} />}
              label="Users"
              active={currentView === 'users'}
              onClick={() => handleNavigate('users')}
            />
          )}
          {!isProctor && (
            <NavItem
              icon={<FileText size={20} />}
              label="Exams"
              active={currentView === 'exams'}
              onClick={() => handleNavigate('exams')}
            />
          )}
          {!isProctor && (
            <NavItem
              icon={<Users size={20} />}
              label="Students"
              active={currentView === 'students'}
              onClick={() => handleNavigate('students')}
            />
          )}
          <NavItem 
            icon={<AlertTriangle size={20} />} 
            label="Monitoring" 
            active={currentView === 'monitoring'} 
            onClick={() => handleNavigate('monitoring')} 
          />
          {!isProctor && (
            <NavItem
              icon={<ClipboardList size={20} />}
              label="Results"
              active={currentView === 'results'}
              onClick={() => handleNavigate('results')}
            />
          )}
          <NavItem 
            icon={<Radio size={20} />} 
            label="Security Feed" 
            active={currentView === 'security'} 
            onClick={() => handleNavigate('security')} 
          />
          <NavItem
            icon={<Film size={20} />}
            label="Recordings"
            active={currentView === 'recordings'}
            onClick={() => handleNavigate('recordings')}
          />
          <NavItem 
            icon={<Activity size={20} />} 
            label="Activity Logs" 
            active={currentView === 'audit'} 
            onClick={() => handleNavigate('audit')} 
          />
        </nav>

        <div className="p-4 border-t border-slate-200/70">
          <button
            onClick={onLogout}
            className="flex items-center gap-3 text-slate-500 hover:text-slate-900 transition-colors w-full px-4 py-2 rounded-xl hover:bg-slate-100"
          >
            <LogOut size={20} />
            <span>Logout</span>
          </button>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 min-w-0 p-4 sm:p-6 lg:p-8 pt-20 lg:pt-8 overflow-y-auto">
        <div className="mx-auto w-full min-w-0 lsc-page">
          {children}
        </div>
      </main>
    </div>
  );
};

const NavItem = ({ icon, label, active, onClick }: { icon: React.ReactNode, label: string, active: boolean, onClick: () => void }) => (
  <button 
    onClick={onClick}
    className={`flex items-center gap-3 w-full px-4 py-3 rounded-xl transition-all ${
      active 
        ? 'bg-[linear-gradient(135deg,#3558ff,#ff6b4a)] text-white shadow-[0_20px_38px_-24px_rgba(53,88,255,0.72)]'
        : 'text-slate-600 hover:bg-white hover:text-slate-900 hover:shadow-[0_18px_34px_-30px_rgba(16,24,40,0.3)]'
    }`}
  >
    {icon}
    <span className="font-medium">{label}</span>
  </button>
);
