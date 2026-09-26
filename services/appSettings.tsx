import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { apiGet, apiPost } from './api';

// ---------------------------------------------------------------------------
// App settings — the single source of truth for admin-configurable branding,
// exam defaults and UI preferences. Persisted per-browser in localStorage and
// applied live (CSS variables, document title, density class).
// ---------------------------------------------------------------------------

export interface BrandingSettings {
  appName: string;
  shortName: string;
  accent: string; // hex, e.g. #1a73e8
  logoDataUrl: string | null;
}

export interface ExamDefaults {
  durationMinutes: number;
  passPercent: number;
  cameraRequired: boolean;
  microphoneRequired: boolean;
  fullScreenEnforced: boolean;
  tabSwitchLimit: number;
  reconnectLimit: number;
  showResults: boolean;
  violationLimits: {
    camera: number;
    microphone: number;
    fullscreen: number;
    copyPaste: number;
  };
  // Seconds of sustained gaze-away / talking tolerated before a violation fires. Pre-fills new
  // exams (same as violationLimits); each exam can still override its own copy.
  gazeAwaySeconds: number;
  audioSeconds: number;
}

export interface UiPreferences {
  density: 'comfortable' | 'compact';
  pageSize: number;
}

export interface AppSettings {
  branding: BrandingSettings;
  examDefaults: ExamDefaults;
  ui: UiPreferences;
}

export const DEFAULT_SETTINGS: AppSettings = {
  branding: {
    appName: 'LSC Exam Proctor',
    shortName: 'LSC',
    accent: '#1a73e8',
    logoDataUrl: null,
  },
  examDefaults: {
    durationMinutes: 60,
    passPercent: 40,
    cameraRequired: true,
    microphoneRequired: false,
    fullScreenEnforced: true,
    tabSwitchLimit: 3,
    reconnectLimit: 3,
    showResults: false,
    violationLimits: { camera: 3, microphone: 3, fullscreen: 2, copyPaste: 2 },
    gazeAwaySeconds: 9,
    audioSeconds: 2,
  },
  ui: {
    density: 'comfortable',
    pageSize: 25,
  },
};

const STORAGE_KEY = 'pg_app_settings';

// --- colour helpers --------------------------------------------------------

const clamp = (n: number) => Math.max(0, Math.min(255, Math.round(n)));

const hexToRgb = (hex: string): [number, number, number] => {
  let h = hex.replace('#', '').trim();
  if (h.length === 3) h = h.split('').map(c => c + c).join('');
  const int = parseInt(h, 16);
  if (Number.isNaN(int) || h.length !== 6) return [26, 115, 232];
  return [(int >> 16) & 255, (int >> 8) & 255, int & 255];
};

const rgbToHex = (r: number, g: number, b: number) =>
  '#' + [r, g, b].map(v => clamp(v).toString(16).padStart(2, '0')).join('');

/** Mix a colour toward black (amount<0) or white (amount>0), -1..1. */
const shade = (hex: string, amount: number): string => {
  const [r, g, b] = hexToRgb(hex);
  const target = amount < 0 ? 0 : 255;
  const t = Math.abs(amount);
  return rgbToHex(r + (target - r) * t, g + (target - g) * t, b + (target - b) * t);
};

export const rgba = (hex: string, alpha: number): string => {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
};

export const isValidHex = (value: string): boolean => /^#?[0-9a-fA-F]{6}$/.test(value.trim());

// --- persistence + apply ---------------------------------------------------

const deepMerge = <T,>(base: T, override: any): T => {
  if (override == null || typeof override !== 'object') return base;
  const out: any = Array.isArray(base) ? [...(base as any)] : { ...base };
  for (const key of Object.keys(override)) {
    const b = (base as any)?.[key];
    const o = override[key];
    out[key] = b && typeof b === 'object' && !Array.isArray(b) && o && typeof o === 'object'
      ? deepMerge(b, o)
      : o;
  }
  return out as T;
};

export const loadSettings = (): AppSettings => {
  if (typeof window === 'undefined') return DEFAULT_SETTINGS;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    return deepMerge(DEFAULT_SETTINGS, JSON.parse(raw));
  } catch {
    return DEFAULT_SETTINGS;
  }
};

const persist = (settings: AppSettings) => {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // ignore storage quota / privacy errors
  }
};

/** True once an admin is signed in (company scope available for server sync). */
const hasCompanyScope = (): boolean => {
  if (typeof window === 'undefined') return false;
  try {
    const raw = localStorage.getItem('pg_admin_auth');
    if (!raw) return false;
    const cid = Number(JSON.parse(raw)?.companyId);
    return Number.isFinite(cid) && cid > 0;
  } catch {
    return false;
  }
};

/** Load the company-shared settings from the server, merged onto defaults. */
export const fetchServerSettings = async (): Promise<AppSettings | null> => {
  try {
    const data = await apiGet<{ settings: Partial<AppSettings> | null }>('settings.php');
    if (data && data.settings && typeof data.settings === 'object') {
      return deepMerge(DEFAULT_SETTINGS, data.settings);
    }
  } catch {
    // offline / not-configured — fall back to local cache
  }
  return null;
};

const saveServerSettings = async (settings: AppSettings): Promise<void> => {
  try {
    await apiPost('settings.php', { settings });
  } catch {
    // best-effort; localStorage already holds the latest
  }
};

/** Push branding + density into the live document so every screen reflects it. */
export const applyTheme = (settings: AppSettings) => {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  const accent = isValidHex(settings.branding.accent)
    ? (settings.branding.accent.startsWith('#') ? settings.branding.accent : `#${settings.branding.accent}`)
    : DEFAULT_SETTINGS.branding.accent;

  root.style.setProperty('--lsc-primary', accent);
  root.style.setProperty('--lsc-primary-700', shade(accent, -0.28));
  root.style.setProperty('--lsc-primary-50', shade(accent, 0.9));
  root.style.setProperty('--lsc-accent', accent);
  root.style.setProperty('--lsc-accent-700', shade(accent, -0.28));
  root.style.setProperty('--lsc-ring', rgba(accent, 0.16));
  root.style.setProperty('--lsc-ring-strong', rgba(accent, 0.5));

  root.classList.toggle('admin-compact', settings.ui.density === 'compact');

  if (settings.branding.appName) {
    document.title = settings.branding.appName;
  }
};

// --- context ---------------------------------------------------------------

interface SettingsContextValue {
  settings: AppSettings;
  setSettings: (next: AppSettings) => void;
  update: (patch: Partial<AppSettings>) => void;
  updateBranding: (patch: Partial<BrandingSettings>) => void;
  updateExamDefaults: (patch: Partial<ExamDefaults>) => void;
  updateUi: (patch: Partial<UiPreferences>) => void;
  reset: () => void;
  /** Pull the company-shared settings from the server (call after login). */
  syncFromServer: () => Promise<void>;
}

const SettingsContext = createContext<SettingsContextValue | null>(null);

export const SettingsProvider: React.FC<{ children: React.ReactNode; applyDensity?: boolean }> = ({ children, applyDensity = true }) => {
  const [settings, setSettingsState] = useState<AppSettings>(() => loadSettings());
  const saveTimer = useRef<number | null>(null);

  const applyLocal = useCallback((next: AppSettings) => {
    if (applyDensity) {
      applyTheme(next);
    } else {
      // Apply branding (colours/title) but leave density to the caller.
      const root = document.documentElement;
      const accent = isValidHex(next.branding.accent) ? next.branding.accent : DEFAULT_SETTINGS.branding.accent;
      root.style.setProperty('--lsc-primary', accent);
      root.style.setProperty('--lsc-primary-700', shade(accent, -0.28));
      root.style.setProperty('--lsc-primary-50', shade(accent, 0.9));
      if (next.branding.appName) document.title = next.branding.appName;
    }
  }, [applyDensity]);

  // commit: apply locally + cache immediately, then debounce-save to the server.
  const commit = useCallback((next: AppSettings, remote = true) => {
    setSettingsState(next);
    persist(next);
    applyLocal(next);
    if (remote && hasCompanyScope()) {
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(() => { void saveServerSettings(next); }, 600);
    }
  }, [applyLocal]);

  const syncFromServer = useCallback(async () => {
    const server = await fetchServerSettings();
    if (server) {
      setSettingsState(server);
      persist(server);
      applyLocal(server);
    }
  }, [applyLocal]);

  useEffect(() => {
    applyLocal(settings);
    // If a session is already active, pull the shared settings on first load.
    if (hasCompanyScope()) void syncFromServer();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const value = useMemo<SettingsContextValue>(() => ({
    settings,
    setSettings: commit,
    update: patch => commit({ ...settings, ...patch }),
    updateBranding: patch => commit({ ...settings, branding: { ...settings.branding, ...patch } }),
    updateExamDefaults: patch => commit({ ...settings, examDefaults: { ...settings.examDefaults, ...patch } }),
    updateUi: patch => commit({ ...settings, ui: { ...settings.ui, ...patch } }),
    reset: () => commit(DEFAULT_SETTINGS),
    syncFromServer,
  }), [settings, commit, syncFromServer]);

  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
};

export const useSettings = (): SettingsContextValue => {
  const ctx = useContext(SettingsContext);
  if (!ctx) {
    // Safe fallback so non-wrapped usages don't crash.
    return {
      settings: DEFAULT_SETTINGS,
      setSettings: () => {},
      update: () => {},
      updateBranding: () => {},
      updateExamDefaults: () => {},
      updateUi: () => {},
      reset: () => {},
      syncFromServer: async () => {},
    };
  }
  return ctx;
};
