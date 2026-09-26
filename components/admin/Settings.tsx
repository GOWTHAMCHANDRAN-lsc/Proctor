import React, { useRef, useState } from 'react';
import { Palette, SlidersHorizontal, LayoutGrid, RotateCcw, Upload, Check, Building2, Image as ImageIcon, Trash2, KeyRound, Loader2 } from 'lucide-react';
import { useSettings, isValidHex, DEFAULT_SETTINGS } from '../../services/appSettings';
import { apiPost } from '../../services/api';
import { UserRole } from '../../types';

const ACCENT_PRESETS = [
  { name: 'Google Blue', hex: '#1a73e8' },
  { name: 'Indigo', hex: '#4f46e5' },
  { name: 'Teal', hex: '#0f9d8c' },
  { name: 'Emerald', hex: '#0f9d58' },
  { name: 'Violet', hex: '#7c3aed' },
  { name: 'Rose', hex: '#e11d48' },
  { name: 'Amber', hex: '#d97706' },
  { name: 'Slate', hex: '#475569' },
];

const Section: React.FC<{ icon: React.ReactNode; title: string; subtitle: string; children: React.ReactNode }> = ({ icon, title, subtitle, children }) => (
  <div className="lsc-panel p-5 sm:p-6">
    <div className="flex items-start gap-3 mb-5">
      <div className="lsc-icon-tile-primary p-2.5 shrink-0">{icon}</div>
      <div className="min-w-0">
        <h3 className="text-base font-semibold text-slate-900">{title}</h3>
        <p className="text-sm text-slate-500">{subtitle}</p>
      </div>
    </div>
    {children}
  </div>
);

const Field: React.FC<{ label: string; hint?: string; children: React.ReactNode }> = ({ label, hint, children }) => (
  <div>
    <label className="block text-[13px] font-medium text-slate-700 mb-1.5">{label}</label>
    {children}
    {hint && <p className="text-xs text-slate-400 mt-1">{hint}</p>}
  </div>
);

const Toggle: React.FC<{ label: string; checked: boolean; onChange: (v: boolean) => void }> = ({ label, checked, onChange }) => (
  <button
    type="button"
    onClick={() => onChange(!checked)}
    className="flex items-center justify-between w-full gap-3 rounded-lg border border-slate-200 px-3.5 py-2.5 text-left hover:border-slate-300 transition-colors"
  >
    <span className="text-sm text-slate-700">{label}</span>
    <span className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${checked ? 'bg-[var(--lsc-primary)]' : 'bg-slate-300'}`}>
      <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all ${checked ? 'left-[18px]' : 'left-0.5'}`} />
    </span>
  </button>
);

const inputCls = 'w-full px-3.5 py-2.5 border border-slate-300 rounded-lg outline-none text-slate-800 bg-white';

export const Settings: React.FC<{ role?: UserRole }> = ({ role }) => {
  const { settings, updateBranding, updateExamDefaults, updateUi, reset } = useSettings();
  const { branding, examDefaults, ui } = settings;
  const [hexDraft, setHexDraft] = useState(branding.accent);
  const [savedFlash, setSavedFlash] = useState(false);
  const logoInputRef = useRef<HTMLInputElement>(null);

  // Self-service password reset. Super admins authenticate against the central LSC auth service,
  // so their password is not managed here — the whole section is hidden for them.
  const isSuperAdmin = role === UserRole.SUPER_ADMIN;
  const [pwStatus, setPwStatus] = useState<'idle' | 'busy' | 'done' | 'error'>('idle');
  const [pwMessage, setPwMessage] = useState('');

  const handleResetOwnPassword = async () => {
    if (pwStatus === 'busy') return;
    if (!confirm('Reset your password? A temporary password will be emailed to your registered address, and your current password will stop working.')) return;
    setPwStatus('busy');
    setPwMessage('');
    try {
      const res = await apiPost<{ ok?: boolean; message?: string; emailWarning?: string; error?: string }>('users.php', {
        action: 'RESET_OWN_PASSWORD',
        dashboardUrl: `${window.location.origin}/admin`,
      });
      if (res?.ok) {
        setPwStatus(res.emailWarning ? 'error' : 'done');
        setPwMessage(res.emailWarning || res.message || 'A temporary password has been emailed to you.');
      } else {
        setPwStatus('error');
        setPwMessage(res?.error || 'Could not reset your password.');
      }
    } catch (e: any) {
      setPwStatus('error');
      setPwMessage(e?.message || 'Could not reset your password. Please try again.');
    }
  };

  const flash = () => {
    setSavedFlash(true);
    window.setTimeout(() => setSavedFlash(false), 1400);
  };

  const applyHex = (value: string) => {
    setHexDraft(value);
    if (isValidHex(value)) {
      updateBranding({ accent: value.startsWith('#') ? value : `#${value}` });
    }
  };

  const onLogoFile = (file: File) => {
    if (file.size > 512 * 1024) {
      alert('Logo must be under 512 KB. Use a small PNG/SVG.');
      return;
    }
    const reader = new FileReader();
    reader.onload = e => updateBranding({ logoDataUrl: String(e.target?.result || '') });
    reader.readAsDataURL(file);
  };

  const num = (v: string, fallback: number) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  };

  // ADMIN / SUPER_ADMIN configure the workspace; PROCTOR / VIEWER only get the Security section.
  const isFullAdmin = role === UserRole.ADMIN || role === UserRole.SUPER_ADMIN;

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h2 className="lsc-title">Settings</h2>
          <p className="lsc-subtitle mt-1">
            {isFullAdmin
              ? 'Customize branding, exam defaults, and your workspace. Changes apply instantly and are saved on this device.'
              : 'Manage your account security.'}
          </p>
        </div>
        {isFullAdmin && (
          <div className="flex items-center gap-2">
            {savedFlash && (
              <span className="inline-flex items-center gap-1.5 text-sm text-[var(--lsc-success,#1e8e3e)] font-medium">
                <Check size={16} /> Saved
              </span>
            )}
            <button
              onClick={() => { if (confirm('Reset all settings to defaults?')) { reset(); setHexDraft(DEFAULT_SETTINGS.branding.accent); } }}
              className="px-4 py-2 lsc-button-ghost text-sm inline-flex items-center gap-2"
            >
              <RotateCcw size={15} /> Reset
            </button>
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        {isFullAdmin && (<>
        {/* Branding */}
        <Section icon={<Palette size={18} />} title="Branding" subtitle="Your name, logo and accent colour across the whole panel.">
          <div className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <Field label="Application name">
                <input className={inputCls} value={branding.appName} onChange={e => { updateBranding({ appName: e.target.value }); flash(); }} placeholder="LSC Exam Proctor" />
              </Field>
              <Field label="Short name / initials" hint="Shown in the logo badge.">
                <input className={inputCls} maxLength={4} value={branding.shortName} onChange={e => { updateBranding({ shortName: e.target.value.toUpperCase() }); flash(); }} placeholder="LSC" />
              </Field>
            </div>

            <Field label="Accent colour" hint="Used for buttons, links, active navigation and highlights.">
              <div className="flex flex-wrap items-center gap-2">
                {ACCENT_PRESETS.map(p => (
                  <button
                    key={p.hex}
                    type="button"
                    title={p.name}
                    onClick={() => { applyHex(p.hex); flash(); }}
                    className={`h-8 w-8 rounded-full border-2 transition-transform hover:scale-110 ${branding.accent.toLowerCase() === p.hex.toLowerCase() ? 'border-slate-900' : 'border-white shadow'}`}
                    style={{ backgroundColor: p.hex }}
                  />
                ))}
                <div className="flex items-center gap-2 ml-1">
                  <input
                    type="color"
                    value={isValidHex(branding.accent) ? branding.accent : '#1a73e8'}
                    onChange={e => { applyHex(e.target.value); flash(); }}
                    className="h-8 w-10 rounded border border-slate-200 bg-white cursor-pointer p-0.5"
                  />
                  <input
                    className="w-28 px-2.5 py-1.5 border border-slate-300 rounded-lg outline-none text-sm font-mono"
                    value={hexDraft}
                    onChange={e => applyHex(e.target.value)}
                    placeholder="#1a73e8"
                  />
                </div>
              </div>
            </Field>

            <Field label="Logo" hint="Optional. Replaces the initials badge. PNG or SVG, under 512 KB.">
              <div className="flex items-center gap-3">
                <div className="h-12 w-12 rounded-xl overflow-hidden flex items-center justify-center shrink-0 lsc-brand-mark text-sm">
                  {branding.logoDataUrl
                    ? <img src={branding.logoDataUrl} alt="Logo" className="h-full w-full object-contain bg-white" />
                    : (branding.shortName || 'LSC')}
                </div>
                <input ref={logoInputRef} type="file" accept="image/png,image/svg+xml,image/jpeg" className="hidden" onChange={e => e.target.files?.[0] && onLogoFile(e.target.files[0])} />
                <button onClick={() => logoInputRef.current?.click()} className="px-3.5 py-2 lsc-button-ghost text-sm inline-flex items-center gap-2">
                  <Upload size={15} /> Upload
                </button>
                {branding.logoDataUrl && (
                  <button onClick={() => updateBranding({ logoDataUrl: null })} className="px-3 py-2 text-sm text-slate-500 hover:text-red-600 inline-flex items-center gap-1.5">
                    <Trash2 size={15} /> Remove
                  </button>
                )}
              </div>
            </Field>
          </div>
        </Section>

        {/* Preferences */}
        <Section icon={<LayoutGrid size={18} />} title="Workspace preferences" subtitle="How dense the interface feels and how many rows tables show.">
          <div className="space-y-4">
            <Field label="Density">
              <div className="grid grid-cols-2 gap-2">
                {(['comfortable', 'compact'] as const).map(d => (
                  <button
                    key={d}
                    onClick={() => { updateUi({ density: d }); flash(); }}
                    className={`rounded-lg border px-4 py-3 text-sm font-medium capitalize transition-colors ${ui.density === d ? 'border-[var(--lsc-primary)] bg-[var(--lsc-primary-50)] text-[var(--lsc-primary)]' : 'border-slate-200 text-slate-600 hover:border-slate-300'}`}
                  >
                    {d}
                  </button>
                ))}
              </div>
            </Field>
            <Field label="Rows per page" hint="Default page size for long tables.">
              <select className={inputCls} value={ui.pageSize} onChange={e => { updateUi({ pageSize: num(e.target.value, 25) }); flash(); }}>
                {[10, 25, 50, 100].map(n => <option key={n} value={n}>{n} rows</option>)}
              </select>
            </Field>
            <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 flex items-start gap-2.5">
              <Building2 size={16} className="text-slate-400 mt-0.5 shrink-0" />
              <p className="text-xs text-slate-500">Preferences are stored in this browser. Branding and exam defaults take effect immediately everywhere in the panel.</p>
            </div>
          </div>
        </Section>

        {/* Exam defaults */}
        <Section icon={<SlidersHorizontal size={18} />} title="Exam defaults" subtitle="Pre-filled values when creating a new exam.">
          <div className="space-y-4">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              <Field label="Duration (min)">
                <input type="number" min={1} className={inputCls} value={examDefaults.durationMinutes} onChange={e => { updateExamDefaults({ durationMinutes: num(e.target.value, 60) }); flash(); }} />
              </Field>
              <Field label="Pass %">
                <input type="number" min={0} max={100} className={inputCls} value={examDefaults.passPercent} onChange={e => { updateExamDefaults({ passPercent: num(e.target.value, 40) }); flash(); }} />
              </Field>
              <Field label="Tab switch limit">
                <input type="number" min={0} className={inputCls} value={examDefaults.tabSwitchLimit} onChange={e => { updateExamDefaults({ tabSwitchLimit: num(e.target.value, 3) }); flash(); }} />
              </Field>
              <Field label="Reconnect limit">
                <input type="number" min={0} className={inputCls} value={examDefaults.reconnectLimit} onChange={e => { updateExamDefaults({ reconnectLimit: num(e.target.value, 3) }); flash(); }} />
              </Field>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
              <Toggle label="Camera required" checked={examDefaults.cameraRequired} onChange={v => { updateExamDefaults({ cameraRequired: v }); flash(); }} />
              <Toggle label="Microphone required" checked={examDefaults.microphoneRequired} onChange={v => { updateExamDefaults({ microphoneRequired: v }); flash(); }} />
              <Toggle label="Fullscreen enforced" checked={examDefaults.fullScreenEnforced} onChange={v => { updateExamDefaults({ fullScreenEnforced: v }); flash(); }} />
              <Toggle label="Show results to student" checked={examDefaults.showResults} onChange={v => { updateExamDefaults({ showResults: v }); flash(); }} />
            </div>
            <Field label="Violation limits" hint="Allowed events before action is taken.">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                {(['camera', 'microphone', 'fullscreen', 'copyPaste'] as const).map(k => (
                  <div key={k}>
                    <span className="block text-[11px] uppercase tracking-wide text-slate-400 mb-1">{k === 'copyPaste' ? 'Copy/Paste' : k}</span>
                    <input
                      type="number" min={0}
                      className={inputCls}
                      value={examDefaults.violationLimits[k]}
                      onChange={e => { updateExamDefaults({ violationLimits: { ...examDefaults.violationLimits, [k]: num(e.target.value, 0) } }); flash(); }}
                    />
                  </div>
                ))}
              </div>
            </Field>
            <Field label="Proctoring sensitivity" hint="How many seconds of sustained gaze-away / talking are tolerated before it's logged as a violation. Lower = stricter, higher = more forgiving.">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <span className="block text-[11px] uppercase tracking-wide text-slate-400 mb-1">Gaze away (sec)</span>
                  <input
                    type="number" min={1} max={60}
                    className={inputCls}
                    value={examDefaults.gazeAwaySeconds}
                    onChange={e => { updateExamDefaults({ gazeAwaySeconds: num(e.target.value, 9) }); flash(); }}
                  />
                </div>
                <div>
                  <span className="block text-[11px] uppercase tracking-wide text-slate-400 mb-1">Talking / audio (sec)</span>
                  <input
                    type="number" min={1} max={60}
                    className={inputCls}
                    value={examDefaults.audioSeconds}
                    onChange={e => { updateExamDefaults({ audioSeconds: num(e.target.value, 2) }); flash(); }}
                  />
                </div>
              </div>
            </Field>
          </div>
        </Section>

        {/* Live preview */}
        <Section icon={<ImageIcon size={18} />} title="Preview" subtitle="A quick look at how your branding reads.">
          <div className="rounded-xl border border-slate-200 overflow-hidden">
            <div className="flex items-center gap-3 px-4 py-3 border-b border-slate-200 bg-white">
              <div className="h-9 w-9 rounded-lg overflow-hidden flex items-center justify-center lsc-brand-mark text-[13px]">
                {branding.logoDataUrl ? <img src={branding.logoDataUrl} alt="" className="h-full w-full object-contain bg-white" /> : (branding.shortName || 'LSC')}
              </div>
              <div className="font-semibold text-slate-900 truncate">{branding.appName || 'LSC Exam Proctor'}</div>
            </div>
            <div className="p-4 bg-slate-50 space-y-3">
              <div className="flex flex-wrap gap-2">
                <button className="px-4 py-2 lsc-button-primary text-sm">Primary action</button>
                <button className="px-4 py-2 lsc-button-ghost text-sm">Secondary</button>
                <span className="lsc-chip-primary">Active</span>
              </div>
              <div className="flex items-center gap-2 text-sm">
                <span className="text-[var(--lsc-primary)] font-medium">Accent link</span>
                <span className="text-slate-400">·</span>
                <span className="text-slate-500">Body text sample</span>
              </div>
            </div>
          </div>
        </Section>
        </>)}

        {/* Security — self-service password reset (hidden for super admins) */}
        {!isSuperAdmin && (
          <Section icon={<KeyRound size={18} />} title="Security" subtitle="Reset your account password. A temporary one is emailed to you.">
            <div className="space-y-3">
              <p className="text-sm text-slate-600">
                This sends a fresh temporary password to your registered email and immediately invalidates your current password. Sign in with the temporary password and change it afterwards.
              </p>
              <button
                type="button"
                onClick={handleResetOwnPassword}
                disabled={pwStatus === 'busy'}
                className="px-4 py-2 lsc-button-primary text-sm inline-flex items-center gap-2 disabled:opacity-60"
              >
                {pwStatus === 'busy' ? <Loader2 size={15} className="animate-spin" /> : <KeyRound size={15} />}
                {pwStatus === 'busy' ? 'Resetting…' : 'Reset my password'}
              </button>
              {pwMessage && (
                <p className={`text-sm ${pwStatus === 'error' ? 'text-rose-600' : 'text-teal-600'}`}>{pwMessage}</p>
              )}
            </div>
          </Section>
        )}
      </div>
    </div>
  );
};
