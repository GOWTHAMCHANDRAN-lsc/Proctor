import React, { useState } from 'react';
import { Camera, Mic, Monitor, ShieldCheck, ChevronRight, ChevronLeft, Maximize, CheckCircle2, EyeOff, Users, BookX } from 'lucide-react';

export interface ExamIntroWalkthroughProps {
  examTitle: string;
  scheduleLabel?: string;
  needsCamera: boolean;
  needsMicrophone: boolean;
  needsScreen: boolean;
  needsFullscreen: boolean;
  isMobile: boolean;
  onContinue: () => void;
}

// ── Animated illustration: the browser's camera/mic popup, with a cursor looping onto Allow ──
// Draws only the devices this exam asks for (a mic-only exam has no "Use your camera" row).
const AllowAnimation: React.FC<{ camera: boolean; microphone: boolean }> = ({ camera, microphone }) => (
  <svg viewBox="0 0 320 176" width="100%" height="100%" role="img" aria-label={`Animated demo: clicking Allow on the ${camera && microphone ? 'camera and microphone' : camera ? 'camera' : 'microphone'} prompt`} style={{ maxWidth: 320 }}>
    <defs>
      <filter id="introShadow" x="-20%" y="-20%" width="140%" height="140%">
        <feDropShadow dx="0" dy="4" stdDeviation="6" floodColor="#0f172a" floodOpacity="0.18" />
      </filter>
    </defs>
    <rect x="8" y="10" width="304" height="30" rx="15" fill="#f1f5f9" stroke="#e2e8f0" />
    <circle cx="28" cy="25" r="7" fill="#fff" stroke="#cbd5e1" />
    <rect x="26.5" y="21.5" width="3" height="5" rx="1.2" fill="#2563eb" />
    <circle cx="28" cy="27.5" r="1.4" fill="#2563eb" />
    <rect x="44" y="19" width="150" height="12" rx="6" fill="#e2e8f0" />
    <g filter="url(#introShadow)">
      <rect x="14" y="46" width="230" height="118" rx="12" fill="#ffffff" stroke="#e2e8f0" />
      <text x="30" y="72" fontFamily="system-ui, sans-serif" fontSize="12" fontWeight="700" fill="#0f172a">This site wants to</text>
      {camera && (
        <>
          <circle cx="36" cy="92" r="9" fill="#eff6ff" />
          <rect x="31" y="88" width="10" height="8" rx="2" fill="#2563eb" />
          <path d="M41 90 l4 -2 v8 l-4 -2 z" fill="#2563eb" />
          <text x="52" y="96" fontFamily="system-ui, sans-serif" fontSize="11" fill="#334155">Use your camera</text>
        </>
      )}
      {microphone && (
        <g transform={camera ? undefined : 'translate(0 -24)'}>
          <circle cx="36" cy="116" r="9" fill="#eff6ff" />
          <rect x="32.5" y="110" width="7" height="11" rx="3.5" fill="#2563eb" />
          <rect x="34.5" y="121" width="3" height="4" fill="#2563eb" />
          <text x="52" y="120" fontFamily="system-ui, sans-serif" fontSize="11" fill="#334155">Use your microphone</text>
        </g>
      )}
      <rect x="120" y="136" width="52" height="20" rx="10" fill="#f1f5f9" stroke="#e2e8f0" />
      <text x="146" y="149" textAnchor="middle" fontFamily="system-ui, sans-serif" fontSize="10" fill="#64748b">Block</text>
      <rect x="180" y="136" width="52" height="20" rx="10" fill="#2563eb" />
      <text x="206" y="149" textAnchor="middle" fontFamily="system-ui, sans-serif" fontSize="10" fontWeight="700" fill="#ffffff">Allow</text>
    </g>
    {/* looping cursor: slides in, taps Allow, fades out, repeats */}
    <g className="lsc-anim-cursor-allow" style={{ transformOrigin: '206px 146px' }}>
      <g transform="translate(206 146)">
        <path d="M-9 -10 L6 -1 L-1 3 L4 12 L-2 15 L-7 6 L-11 12 Z" fill="#0f172a" stroke="#fff" strokeWidth="1.5" strokeLinejoin="round" />
      </g>
    </g>
  </svg>
);

// ── Animated illustration: the screen-share picker, Entire Screen pulsing, cursor taps it then Share ──
const ShareAnimation: React.FC = () => (
  <svg viewBox="0 0 320 150" width="100%" height="100%" role="img" aria-label="Animated demo: choosing Entire Screen and clicking Share" style={{ maxWidth: 320 }}>
    <rect x="14" y="10" width="292" height="122" rx="12" fill="#ffffff" stroke="#e2e8f0" />
    <text x="30" y="30" fontFamily="system-ui, sans-serif" fontSize="12" fontWeight="700" fill="#0f172a">Share your screen</text>

    <g transform="translate(0 0)">
      <circle cx="69" cy="51" r="26" fill="#16a34a" opacity="0.25" className="lsc-anim-ring" />
      <rect x="26" y="40" width="86" height="22" rx="6" fill="#dcfce7" stroke="#16a34a" strokeWidth="2" />
      <text x="69" y="55" textAnchor="middle" fontFamily="system-ui, sans-serif" fontSize="9.5" fontWeight="700" fill="#15803d">Entire Screen</text>
    </g>
    <rect x="118" y="40" width="70" height="22" rx="6" fill="#f8fafc" stroke="#e2e8f0" />
    <text x="153" y="55" textAnchor="middle" fontFamily="system-ui, sans-serif" fontSize="9.5" fill="#94a3b8">Window</text>
    <rect x="194" y="40" width="70" height="22" rx="6" fill="#f8fafc" stroke="#e2e8f0" />
    <text x="229" y="55" textAnchor="middle" fontFamily="system-ui, sans-serif" fontSize="9.5" fill="#94a3b8">Chrome Tab</text>

    <rect x="30" y="74" width="90" height="52" rx="6" fill="#eff6ff" stroke="#2563eb" strokeWidth="2" />
    <rect x="38" y="82" width="74" height="36" rx="3" fill="#dbeafe" />
    <rect x="180" y="100" width="60" height="20" rx="10" fill="#2563eb" />
    <text x="210" y="114" textAnchor="middle" fontFamily="system-ui, sans-serif" fontSize="10" fontWeight="700" fill="#ffffff">Share</text>

    {/* looping cursor: taps Entire Screen tab, slides right, taps Share, fades, repeats */}
    <g className="lsc-anim-cursor-share" style={{ transformOrigin: '210px 110px' }}>
      <g transform="translate(210 110)">
        <path d="M-9 -10 L6 -1 L-1 3 L4 12 L-2 15 L-7 6 L-11 12 Z" fill="#0f172a" stroke="#fff" strokeWidth="1.5" strokeLinejoin="round" />
      </g>
    </g>
  </svg>
);

type Step = {
  key: string;
  eyebrow: string;
  title: string;
  body: React.ReactNode;
  illustration?: React.ReactNode;
};

export const ExamIntroWalkthrough: React.FC<ExamIntroWalkthroughProps> = ({
  examTitle, scheduleLabel, needsCamera, needsMicrophone, needsScreen, needsFullscreen, isMobile, onContinue,
}) => {
  const needsCamOrMic = needsCamera || needsMicrophone;
  // Proctored, but nothing for the browser to grant (e.g. only tab-switch / fullscreen rules).
  const needsAnyPermission = needsCamOrMic || needsScreen;
  const camMicLabel = needsCamera && needsMicrophone ? 'camera and microphone' : needsCamera ? 'camera' : 'microphone';

  const steps: Step[] = [
    {
      key: 'welcome',
      eyebrow: 'Before you begin',
      title: 'A few quick things first',
      body: (
        <div className="space-y-3">
          <p className="text-slate-600 text-sm leading-relaxed">
            {needsAnyPermission ? (
              <>
                This exam is monitored to keep it fair for everyone. In the next few steps we'll ask your browser
                for a few permissions — this short walkthrough shows you exactly what to expect and how to allow
                each one, before any popup appears.
              </>
            ) : (
              <>
                This exam is monitored to keep it fair for everyone. No camera, microphone or screen sharing is
                needed — this short walkthrough explains the rules before you begin.
              </>
            )}
          </p>
          <div className="grid grid-cols-2 gap-2 pt-1">
            {needsCamera && (
              <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-blue-50 text-[var(--lsc-primary,#1d4ed8)] text-xs font-semibold">
                <Camera size={16} /> Camera
              </div>
            )}
            {needsMicrophone && (
              <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-blue-50 text-[var(--lsc-primary,#1d4ed8)] text-xs font-semibold">
                <Mic size={16} /> Microphone
              </div>
            )}
            {needsScreen && (
              <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-blue-50 text-[var(--lsc-primary,#1d4ed8)] text-xs font-semibold">
                <Monitor size={16} /> Entire screen
              </div>
            )}
            {needsFullscreen && (
              <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-blue-50 text-[var(--lsc-primary,#1d4ed8)] text-xs font-semibold">
                <Maximize size={16} /> Fullscreen
              </div>
            )}
          </div>
          <div className="flex items-start gap-2 text-xs text-slate-500 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 mt-2">
            <Users size={14} className="mt-0.5 shrink-0 text-slate-400" />
            Sit somewhere quiet and private, alone, with your desk clear of phones, notes, and books.
          </div>
        </div>
      ),
    },
  ];

  if (needsCamOrMic && !isMobile) {
    steps.push({
      key: 'cammic',
      eyebrow: `Step ${steps.length + 1}`,
      title: `Allow your ${camMicLabel}`,
      body: (
        <p className="text-slate-600 text-sm leading-relaxed">
          Your browser will show a popup like the one below. When it appears, click <strong>Allow</strong>.
          This lets the system confirm you're present — your feed is only used for monitoring this exam.
        </p>
      ),
      illustration: <AllowAnimation camera={needsCamera} microphone={needsMicrophone} />,
    });
  } else if (needsCamOrMic && isMobile) {
    steps.push({
      key: 'cammic-mobile',
      eyebrow: `Step ${steps.length + 1}`,
      title: `Allow your ${camMicLabel}`,
      body: (
        <p className="text-slate-600 text-sm leading-relaxed">
          When your browser asks for {camMicLabel} access, tap <strong>Allow</strong>. Keep this tab open and
          your phone unlocked for the rest of the exam.
        </p>
      ),
    });
  }

  if (needsScreen) {
    steps.push({
      key: 'screen',
      eyebrow: `Step ${steps.length + 1}`,
      title: 'Share your ENTIRE screen',
      body: (
        <div className="space-y-2">
          <p className="text-slate-600 text-sm leading-relaxed">
            When the share dialog opens, you must choose the <strong>"Entire Screen"</strong> tab — not a
            Window and not a browser Tab — then pick your monitor and click <strong>Share</strong>.
          </p>
          <div className="flex items-start gap-2 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
            <EyeOff size={14} className="mt-0.5 shrink-0 text-amber-600" />
            If you share a Window or a Tab, the system will reject it and ask you to redo it — so pick
            "Entire Screen" the first time to avoid the extra step.
          </div>
        </div>
      ),
      illustration: <ShareAnimation />,
    });
  }

  if (needsFullscreen) {
    steps.push({
      key: 'fullscreen',
      eyebrow: `Step ${steps.length + 1}`,
      title: 'The exam runs in fullscreen',
      body: (
        <div className="space-y-3">
          <p className="text-slate-600 text-sm leading-relaxed">
            Once the exam starts, your browser will switch to fullscreen automatically. Stay in fullscreen for
            the entire exam — exiting it (even briefly) is logged.
          </p>
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 flex items-center justify-center">
            <Maximize size={40} className="text-[var(--lsc-primary,#1d4ed8)]" />
          </div>
        </div>
      ),
    });
  }

  steps.push({
    key: 'ready',
    eyebrow: `Step ${steps.length + 1}`,
    title: "You're ready to begin",
    body: (
      <div className="space-y-2.5">
        {/* Only relevant when the camera is actually used — no-camera exams were told to stay in frame. */}
        {needsCamera && (
          <div className="flex items-start gap-2 text-sm text-slate-600">
            <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-emerald-500" />
            Keep your face visible and stay in frame for the whole exam.
          </div>
        )}
        <div className="flex items-start gap-2 text-sm text-slate-600">
          <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-emerald-500" />
          Don't switch tabs, minimise, or leave the exam window.
        </div>
        <div className="flex items-start gap-2 text-sm text-slate-600">
          <BookX size={16} className="mt-0.5 shrink-0 text-emerald-500" />
          No phones, notes, books, or a second screen in view.
        </div>
        <div className="flex items-start gap-2 text-sm text-slate-600">
          <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-emerald-500" />
          Attending from the same network/IP as other candidates is fine — that's not a problem.
        </div>
      </div>
    ),
  });

  const [stepIdx, setStepIdx] = useState(0);
  // Clamp so a change in the step list (e.g. a requirement prop flipping) can never index past the
  // end and crash on `step.eyebrow`.
  const safeIdx = Math.min(stepIdx, steps.length - 1);
  const step = steps[safeIdx];
  const isLast = safeIdx === steps.length - 1;

  return (
    <div className="fixed inset-0 z-[220] bg-slate-900/55 backdrop-blur-sm flex items-center justify-center p-4 overflow-y-auto">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="intro-step-title"
        className="bg-white rounded-2xl shadow-2xl w-full max-w-lg my-8 border border-slate-200 overflow-hidden"
      >
        <div className="bg-gradient-to-br from-[var(--lsc-primary,#1d4ed8)] to-blue-600 px-6 py-5 text-white">
          <div className="flex items-center gap-2 mb-2">
            <div className="inline-flex items-center justify-center w-9 h-9 rounded-full bg-white/15 shrink-0">
              <ShieldCheck size={20} />
            </div>
            <div className="min-w-0">
              <p className="text-blue-100 text-[11px] font-semibold uppercase tracking-wider">{step.eyebrow}</p>
              <p className="text-white text-sm font-semibold truncate">{examTitle}</p>
            </div>
          </div>
          {scheduleLabel && (
            <p className="text-blue-100 text-xs whitespace-normal">{scheduleLabel}</p>
          )}
          {/* progress dots */}
          <div className="flex items-center gap-1.5 mt-3" aria-hidden="true">
            {steps.map((s, i) => (
              <div
                key={s.key}
                className={`h-1.5 rounded-full transition-all ${i === safeIdx ? 'w-6 bg-white' : i < safeIdx ? 'w-1.5 bg-white/70' : 'w-1.5 bg-white/30'}`}
              />
            ))}
          </div>
          <span className="sr-only">Step {safeIdx + 1} of {steps.length}</span>
        </div>

        <div className="px-6 py-5">
          <h2 id="intro-step-title" className="text-lg font-bold text-slate-900">{step.title}</h2>
          <div className="mt-3">{step.body}</div>

          {step.illustration && (
            <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-3 flex items-center justify-center min-h-[150px] overflow-hidden">
              {step.illustration}
            </div>
          )}

          <div className="mt-6 flex items-center gap-3">
            {safeIdx > 0 && (
              <button
                type="button"
                onClick={() => setStepIdx(Math.max(0, safeIdx - 1))}
                className="flex items-center gap-1.5 px-4 py-3 rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50 font-semibold text-sm"
              >
                <ChevronLeft size={16} /> Back
              </button>
            )}
            <button
              type="button"
              onClick={() => (isLast ? onContinue() : setStepIdx(Math.min(steps.length - 1, safeIdx + 1)))}
              className="flex-1 py-3 bg-[var(--lsc-primary,#1d4ed8)] text-white rounded-lg hover:brightness-110 font-semibold flex items-center justify-center gap-2 transition"
            >
              {isLast ? <>I'm Ready — Continue <ShieldCheck size={18} /></> : <>Next <ChevronRight size={18} /></>}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
