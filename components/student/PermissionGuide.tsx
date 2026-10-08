import React, { useMemo } from 'react';
import { Camera, Mic, Monitor, ShieldCheck, RefreshCw, Lock } from 'lucide-react';

type BrowserId = 'chrome' | 'edge' | 'firefox' | 'safari' | 'samsung' | 'other';

export type MediaProblem = 'denied' | 'no-device' | 'device-busy' | 'insecure' | 'unknown' | 'wrong-surface' | null;

export interface PermissionGuideProps {
  status: 'pending' | 'denied';
  /** WHY it failed. A blocked permission and an unplugged webcam need different instructions. */
  problem?: MediaProblem;
  busy: boolean;
  device: { isMobile: boolean; isIOS: boolean; canScreenRecord: boolean };
  needsCamera: boolean;
  needsMicrophone: boolean;
  needsScreen: boolean;
  onGrant: () => void;
  examTitle?: string;
  scheduleLabel?: string; // "13 July 2026, 3:30 AM · Riyadh Time — 17 July 2026, 3:30 AM · Riyadh Time"
}

const detectBrowser = (): BrowserId => {
  if (typeof navigator === 'undefined') return 'other';
  const ua = navigator.userAgent;
  if (/SamsungBrowser/i.test(ua)) return 'samsung';
  if (/Edg\//i.test(ua)) return 'edge';
  if (/Firefox|FxiOS/i.test(ua)) return 'firefox';
  // Chrome must be checked before Safari; Chrome UA also contains "Safari".
  if (/Chrome|CriOS|Chromium/i.test(ua)) return 'chrome';
  if (/Safari/i.test(ua)) return 'safari';
  return 'other';
};

const browserLabel: Record<BrowserId, string> = {
  chrome: 'Chrome',
  edge: 'Edge',
  firefox: 'Firefox',
  safari: 'Safari',
  samsung: 'Samsung Internet',
  other: 'your browser',
};

// ── Illustration: the browser's own permission popup (what the student will see) ──
// Only the devices this exam actually asks for are drawn (a mic-only exam used to be shown a
// "Use your camera" row it would never see).
const AllowPopupIllustration: React.FC<{ mobile: boolean; camera: boolean; microphone: boolean }> = ({ mobile, camera, microphone }) => (
  <svg viewBox="0 0 320 176" width="100%" height="100%" role="img"
       aria-label="Browser permission dialog with the Allow button highlighted"
       style={{ maxWidth: 320 }}>
    <defs>
      <filter id="pgShadow" x="-20%" y="-20%" width="140%" height="140%">
        <feDropShadow dx="0" dy="4" stdDeviation="6" floodColor="#0f172a" floodOpacity="0.18" />
      </filter>
    </defs>
    {/* address bar */}
    <rect x="8" y="10" width="304" height="30" rx="15" fill="#f1f5f9" stroke="#e2e8f0" />
    <circle cx="28" cy="25" r="7" fill="#fff" stroke="#cbd5e1" />
    <rect x="26.5" y="21.5" width="3" height="5" rx="1.2" fill="#2563eb" />
    <circle cx="28" cy="27.5" r="1.4" fill="#2563eb" />
    <rect x="44" y="19" width="150" height="12" rx="6" fill="#e2e8f0" />
    {/* popup */}
    <g filter="url(#pgShadow)">
      <rect x="14" y="46" width="230" height="118" rx="12" fill="#ffffff" stroke="#e2e8f0" />
      <text x="30" y="72" fontFamily="system-ui, sans-serif" fontSize="12" fontWeight="700" fill="#0f172a">
        {mobile ? 'Allow access?' : 'This site wants to'}
      </text>
      {/* camera row */}
      {camera && (
        <>
          <circle cx="36" cy="92" r="9" fill="#eff6ff" />
          <rect x="31" y="88" width="10" height="8" rx="2" fill="#2563eb" />
          <path d="M41 90 l4 -2 v8 l-4 -2 z" fill="#2563eb" />
          <text x="52" y="96" fontFamily="system-ui, sans-serif" fontSize="11" fill="#334155">Use your camera</text>
        </>
      )}
      {/* mic row (moves up into the first row when there is no camera row) */}
      {microphone && (
        <g transform={camera ? undefined : 'translate(0 -24)'}>
          <circle cx="36" cy="116" r="9" fill="#eff6ff" />
          <rect x="32.5" y="110" width="7" height="11" rx="3.5" fill="#2563eb" />
          <rect x="34.5" y="121" width="3" height="4" fill="#2563eb" />
          <text x="52" y="120" fontFamily="system-ui, sans-serif" fontSize="11" fill="#334155">Use your microphone</text>
        </g>
      )}
      {/* buttons */}
      <rect x="120" y="136" width="52" height="20" rx="10" fill="#f1f5f9" stroke="#e2e8f0" />
      <text x="146" y="149" textAnchor="middle" fontFamily="system-ui, sans-serif" fontSize="10" fill="#64748b">Block</text>
      <rect x="180" y="136" width="52" height="20" rx="10" fill="#2563eb" />
      <text x="206" y="149" textAnchor="middle" fontFamily="system-ui, sans-serif" fontSize="10" fontWeight="700" fill="#ffffff">Allow</text>
    </g>
    {/* pointer to Allow */}
    <g>
      <path d="M256 150 q18 -2 -8 -8" fill="none" stroke="#f59e0b" strokeWidth="2.5" strokeLinecap="round"
            transform="translate(-6 -2)" />
      <path d="M238 138 l10 2 l-6 6 z" fill="#f59e0b" />
      <text x="258" y="130" fontFamily="system-ui, sans-serif" fontSize="11" fontWeight="700" fill="#b45309">Tap</text>
      <text x="258" y="144" fontFamily="system-ui, sans-serif" fontSize="11" fontWeight="700" fill="#b45309">Allow</text>
    </g>
  </svg>
);

// ── Illustration: recovering after a denial via the address-bar camera icon (desktop) ──
const AddressBarResetIllustration: React.FC = () => (
  <svg viewBox="0 0 320 120" width="100%" height="100%" role="img"
       aria-label="Address bar camera icon to re-enable permissions" style={{ maxWidth: 320 }}>
    <rect x="8" y="18" width="304" height="34" rx="17" fill="#f8fafc" stroke="#e2e8f0" />
    <rect x="30" y="30" width="150" height="10" rx="5" fill="#e2e8f0" />
    {/* blocked camera icon */}
    <g transform="translate(262 24)">
      <rect x="0" y="4" width="16" height="12" rx="2.5" fill="#dc2626" />
      <path d="M16 7 l6 -3 v12 l-6 -3 z" fill="#dc2626" />
      <line x1="-2" y1="2" x2="24" y2="20" stroke="#dc2626" strokeWidth="2.5" strokeLinecap="round" />
    </g>
    {/* callout */}
    <path d="M270 54 l0 20" stroke="#f59e0b" strokeWidth="2.5" strokeDasharray="2 3" />
    <path d="M266 72 l4 8 l4 -8 z" fill="#f59e0b" />
    <rect x="150" y="80" width="162" height="30" rx="8" fill="#fffbeb" stroke="#fde68a" />
    <text x="162" y="93" fontFamily="system-ui, sans-serif" fontSize="10" fontWeight="700" fill="#b45309">1. Click the camera icon</text>
    <text x="162" y="105" fontFamily="system-ui, sans-serif" fontSize="10" fill="#92400e">2. Choose “Always allow”, then reload</text>
  </svg>
);

// ── Illustration: camera missing / already in use (a hardware problem, not a blocked setting) ──
const CameraTroubleIllustration: React.FC<{ busy: boolean }> = ({ busy }) => (
  <svg viewBox="0 0 320 130" width="100%" height="100%" role="img"
       aria-label={busy ? 'Camera is in use by another application' : 'No camera detected'}
       style={{ maxWidth: 320 }}>
    <rect x="86" y="30" width="106" height="68" rx="10" fill="#f8fafc" stroke="#cbd5e1" strokeWidth="2" />
    <path d="M192 50 l34 -16 v60 l-34 -16 z" fill="#f8fafc" stroke="#cbd5e1" strokeWidth="2" strokeLinejoin="round" />
    <circle cx="139" cy="64" r="18" fill="#e2e8f0" />
    <circle cx="139" cy="64" r="8" fill="#94a3b8" />
    {busy ? (
      <>
        <circle cx="105" cy="46" r="6" fill="#f59e0b" />
        <text x="160" y="120" textAnchor="middle" fontFamily="system-ui, sans-serif" fontSize="11"
              fontWeight="700" fill="#b45309">In use by another app</text>
      </>
    ) : (
      <>
        <line x1="92" y1="26" x2="190" y2="102" stroke="#dc2626" strokeWidth="5" strokeLinecap="round" />
        <text x="160" y="120" textAnchor="middle" fontFamily="system-ui, sans-serif" fontSize="11"
              fontWeight="700" fill="#b91c1c">No camera found</text>
      </>
    )}
  </svg>
);

// ── Illustration: iOS Safari recovery path ──
const IOSResetIllustration: React.FC = () => (
  <svg viewBox="0 0 320 130" width="100%" height="100%" role="img"
       aria-label="iOS Settings path to allow camera and microphone" style={{ maxWidth: 320 }}>
    <g fontFamily="system-ui, sans-serif">
      {[
        { y: 8, icon: '#64748b', label: 'Open the Settings app' },
        { y: 40, icon: '#2563eb', label: 'Tap Safari' },
        { y: 72, icon: '#10b981', label: 'Tap Camera → Allow, then Microphone → Allow' },
      ].map((r, i) => (
        <g key={i} transform={`translate(0 ${r.y})`}>
          <rect x="8" y="0" width="304" height="26" rx="8" fill="#f8fafc" stroke="#e2e8f0" />
          <circle cx="24" cy="13" r="8" fill={r.icon} />
          <text x="16" y="17" fontSize="10" fontWeight="700" fill="#fff">{i + 1}</text>
          <text x="42" y="17" fontSize="11" fill="#334155">{r.label}</text>
        </g>
      ))}
      <text x="12" y="122" fontSize="10" fill="#94a3b8">Then return to this tab and tap “Try Again”.</text>
    </g>
  </svg>
);

// ── Illustration: the browser's screen-share picker with "Entire Screen" highlighted ──
const ScreenPickerIllustration: React.FC = () => (
  <svg viewBox="0 0 320 140" width="100%" height="100%" role="img"
       aria-label="Screen share picker with the Entire Screen tab highlighted" style={{ maxWidth: 320 }}>
    <rect x="14" y="10" width="292" height="118" rx="12" fill="#ffffff" stroke="#e2e8f0" />
    <text x="30" y="30" fontFamily="system-ui, sans-serif" fontSize="12" fontWeight="700" fill="#0f172a">Share your screen</text>
    {/* tabs: Entire Screen (correct) / Window / Chrome Tab (wrong) */}
    <rect x="26" y="40" width="86" height="22" rx="6" fill="#dcfce7" stroke="#16a34a" strokeWidth="2" />
    <text x="69" y="55" textAnchor="middle" fontFamily="system-ui, sans-serif" fontSize="9.5" fontWeight="700" fill="#15803d">Entire Screen</text>
    <rect x="118" y="40" width="70" height="22" rx="6" fill="#f8fafc" stroke="#e2e8f0" />
    <text x="153" y="55" textAnchor="middle" fontFamily="system-ui, sans-serif" fontSize="9.5" fill="#94a3b8">Window</text>
    <rect x="194" y="40" width="70" height="22" rx="6" fill="#f8fafc" stroke="#e2e8f0" />
    <text x="229" y="55" textAnchor="middle" fontFamily="system-ui, sans-serif" fontSize="9.5" fill="#94a3b8">Chrome Tab</text>
    {/* monitor thumbnail selected under the Entire Screen tab */}
    <rect x="30" y="72" width="90" height="52" rx="6" fill="#eff6ff" stroke="#2563eb" strokeWidth="2" />
    <rect x="38" y="80" width="74" height="36" rx="3" fill="#dbeafe" />
    <rect x="180" y="98" width="60" height="20" rx="10" fill="#2563eb" />
    <text x="210" y="112" textAnchor="middle" fontFamily="system-ui, sans-serif" fontSize="10" fontWeight="700" fill="#ffffff">Share</text>
    {/* pointer to Entire Screen tab */}
    <path d="M69 66 l0 -2" stroke="#16a34a" strokeWidth="2.5" strokeLinecap="round" />
    <path d="M62 30 l7 8 l7 -8 z" fill="#16a34a" />
  </svg>
);

export const PermissionGuide: React.FC<PermissionGuideProps> = ({
  status, problem, busy, device, needsCamera, needsMicrophone, needsScreen, onGrant, examTitle, scheduleLabel,
}) => {
  const browser = useMemo(detectBrowser, []);
  const denied = status === 'denied';
  // A hardware/site problem is NOT a blocked permission — sending these candidates to the
  // address-bar "unblock" steps had them hunting for a setting that was already correct.
  const hardwareIssue = denied && (problem === 'no-device' || problem === 'device-busy');
  const insecure = denied && problem === 'insecure';
  const wrongSurface = denied && problem === 'wrong-surface';
  // The missing/busy device can be the microphone: a mic-only exam used to be told "No Camera
  // Detected" and sent hunting for a webcam it doesn't even need.
  const deviceNoun = needsCamera && needsMicrophone ? 'camera or microphone' : needsCamera ? 'camera' : needsMicrophone ? 'microphone' : 'camera';
  const deviceTitle = needsCamera && needsMicrophone ? 'Camera or Microphone' : needsCamera ? 'Camera' : needsMicrophone ? 'Microphone' : 'Camera';

  const failureTitle = wrongSurface
    ? 'Wrong Screen Shared'
    : hardwareIssue
    ? (problem === 'device-busy' ? `Your ${deviceTitle} Is In Use` : `No ${deviceTitle} Detected`)
    : insecure ? 'Connection Not Secure'
    : 'Permissions Were Blocked';

  const failureSubtitle = wrongSurface
    ? 'You shared a window or browser tab. This exam requires your entire screen to be shared.'
    : problem === 'device-busy'
    ? `Another app is holding your ${deviceNoun} open. Close it, then try again.`
    : problem === 'no-device'
      ? `This device has no working ${deviceNoun}, or it is unplugged/disabled.`
      : insecure
        ? 'Your browser only allows camera access over a secure (https) connection.'
        : `Your ${browserLabel[browser]} blocked access. Follow the steps below to re-enable it.`;

  const items: { icon: React.ReactNode; label: string; show: boolean }[] = [
    { icon: <Camera size={18} />, label: 'Camera', show: needsCamera },
    { icon: <Mic size={18} />, label: 'Microphone', show: needsMicrophone },
    { icon: <Monitor size={18} />, label: 'Screen', show: needsScreen },
  ];

  return (
    <div className="fixed inset-0 z-[200] bg-slate-900/50 backdrop-blur-sm flex items-center justify-center p-4 overflow-y-auto">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="pg-permission-title"
        aria-describedby="pg-permission-desc"
        className="bg-white rounded-2xl shadow-2xl w-full max-w-lg my-8 border border-slate-200 overflow-hidden"
      >
        {/* Header */}
        <div className="bg-gradient-to-br from-[var(--lsc-primary,#1d4ed8)] to-blue-600 px-6 py-5 text-white text-center">
          <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-white/15 mb-2">
            <ShieldCheck size={26} />
          </div>
          <h2 id="pg-permission-title" className="text-xl font-bold">{denied ? failureTitle : 'Enable Your Devices'}</h2>
          <p id="pg-permission-desc" className="text-blue-100 text-sm mt-1">
            {denied
              ? failureSubtitle
              : 'This proctored exam needs access to the following. Your feed is used only for monitoring.'}
          </p>
          {scheduleLabel && (
            <div className="mt-3 inline-block bg-white/15 rounded-lg px-3 py-2 text-left max-w-full">
              {examTitle && <p className="text-white text-sm font-semibold truncate">{examTitle}</p>}
              <p className="text-blue-100 text-xs mt-0.5 whitespace-normal">{scheduleLabel}</p>
            </div>
          )}
        </div>

        <div className="px-6 py-5">
          {/* What we need */}
          <div className="flex items-center justify-center gap-3 flex-wrap mb-5">
            {items.filter(i => i.show).map(i => (
              <div key={i.label} className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-blue-50 text-[var(--lsc-primary,#1d4ed8)] text-sm font-semibold">
                {i.icon}{i.label}
              </div>
            ))}
          </div>

          {/* Illustration */}
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 flex items-center justify-center min-h-[150px]">
            {!denied && <AllowPopupIllustration mobile={device.isMobile} camera={needsCamera || !needsMicrophone} microphone={needsMicrophone} />}
            {denied && wrongSurface && <ScreenPickerIllustration />}
            {denied && !wrongSurface && hardwareIssue && <CameraTroubleIllustration busy={problem === 'device-busy'} />}
            {denied && !wrongSurface && !hardwareIssue && device.isIOS && <IOSResetIllustration />}
            {denied && !wrongSurface && !hardwareIssue && !device.isIOS && <AddressBarResetIllustration />}
          </div>

          {/* Steps */}
          <ol className="mt-4 space-y-2 text-sm text-slate-600">
            {!denied ? (
              <>
                <li className="flex gap-2"><span className="font-bold text-[var(--lsc-primary,#1d4ed8)]">1.</span> Tap <strong>“Allow &amp; Continue”</strong> below.</li>
                <li className="flex gap-2"><span className="font-bold text-[var(--lsc-primary,#1d4ed8)]">2.</span> When {browserLabel[browser]} shows a popup, choose <strong>Allow</strong>.</li>
                {needsScreen && (
                  <li className="flex gap-2"><span className="font-bold text-[var(--lsc-primary,#1d4ed8)]">3.</span> For screen sharing, pick <strong>Entire Screen</strong> and press <strong>Share</strong>.</li>
                )}
              </>
            ) : wrongSurface ? (
              <>
                <li className="flex gap-2"><span className="font-bold text-[var(--lsc-primary,#1d4ed8)]">1.</span> Press <strong>Try Again</strong> below to reopen the share picker.</li>
                <li className="flex gap-2"><span className="font-bold text-[var(--lsc-primary,#1d4ed8)]">2.</span> Choose the <strong>“Entire Screen”</strong> tab (not Window or Chrome Tab).</li>
                <li className="flex gap-2"><span className="font-bold text-[var(--lsc-primary,#1d4ed8)]">3.</span> Select your monitor's thumbnail, then press <strong>Share</strong>.</li>
              </>
            ) : hardwareIssue ? (
              problem === 'device-busy' ? (
                <>
                  <li className="flex gap-2"><span className="font-bold text-[var(--lsc-primary,#1d4ed8)]">1.</span> Close any app using the {deviceNoun} (<strong>Zoom, Teams, Meet, OBS</strong>) — including other browser tabs.</li>
                  <li className="flex gap-2"><span className="font-bold text-[var(--lsc-primary,#1d4ed8)]">2.</span> Press <strong>Try Again</strong>. If it still fails, reboot and reopen this link.</li>
                </>
              ) : (
                <>
                  <li className="flex gap-2"><span className="font-bold text-[var(--lsc-primary,#1d4ed8)]">1.</span> Check the {needsCamera ? 'webcam' : 'microphone'}{needsCamera && needsMicrophone ? ' and microphone are' : ' is'} <strong>plugged in</strong> and not covered, muted or disabled.</li>
                  <li className="flex gap-2"><span className="font-bold text-[var(--lsc-primary,#1d4ed8)]">2.</span> If it is built in, make sure no privacy shutter, mute key or hardware switch is off.</li>
                  <li className="flex gap-2"><span className="font-bold text-[var(--lsc-primary,#1d4ed8)]">3.</span> Press <strong>Try Again</strong>.</li>
                </>
              )
            ) : insecure ? (
              <li className="flex gap-2 items-start"><Lock size={15} className="mt-0.5 shrink-0 text-amber-500" /> Open this exam using the <strong>https://</strong> link from your invitation email, then retry.</li>
            ) : (
              device.isIOS ? (
                <li className="flex gap-2 items-start"><Lock size={15} className="mt-0.5 shrink-0 text-amber-500" /> iOS remembers your choice. Update it in <strong>Settings → Safari</strong> as shown above, then return and retry.</li>
              ) : device.isMobile ? (
                // Android browsers have no address-bar camera icon — the "right of the address bar"
                // desktop instruction sent phone users looking for something that isn't there.
                <li className="flex gap-2 items-start"><Lock size={15} className="mt-0.5 shrink-0 text-amber-500" /> Tap the <strong>lock / settings icon</strong> at the left of the address bar, open <strong>Permissions</strong>, allow the camera and microphone, reload the page, then retry.</li>
              ) : browser === 'firefox' ? (
                <li className="flex gap-2 items-start"><Lock size={15} className="mt-0.5 shrink-0 text-amber-500" /> Click the <strong>crossed-out camera / microphone icon</strong> at the left of the address bar, clear the block, reload the page, then retry.</li>
              ) : browser === 'safari' ? (
                <li className="flex gap-2 items-start"><Lock size={15} className="mt-0.5 shrink-0 text-amber-500" /> Open the <strong>Safari</strong> menu → <strong>Settings for This Website…</strong>, set Camera and Microphone to <strong>Allow</strong>, reload the page, then retry.</li>
              ) : (
                <li className="flex gap-2 items-start"><Lock size={15} className="mt-0.5 shrink-0 text-amber-500" /> Click the <strong>camera icon</strong> at the right of the address bar, choose <strong>Always allow</strong>, reload the page, then retry.</li>
              )
            )}
          </ol>

          {/* CTA */}
          <button
            type="button"
            onClick={onGrant}
            disabled={busy}
            className="mt-5 w-full py-3 bg-[var(--lsc-primary,#1d4ed8)] text-white rounded-lg hover:brightness-110 font-semibold flex items-center justify-center gap-2 disabled:opacity-60 disabled:cursor-not-allowed transition"
          >
            {busy ? <><RefreshCw size={18} className="animate-spin" /> Requesting…</>
                  : denied ? <><RefreshCw size={18} /> Try Again</>
                  : <><ShieldCheck size={18} /> Allow &amp; Continue</>}
          </button>

          {device.isMobile && (
            <p className="text-xs text-slate-400 text-center mt-3">
              Tip: keep this browser tab open and don’t lock your phone during the exam.
            </p>
          )}
        </div>
      </div>
    </div>
  );
};
