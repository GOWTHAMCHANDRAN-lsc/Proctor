import React, { useState, useEffect, useRef, useMemo } from 'react';
import { Exam, QuestionType, ViolationLog, Student, Question, DeviceType } from '../../types';
import { Clock, Wifi, Mic, MicOff, AlertTriangle, ShieldAlert, ChevronLeft, ChevronRight, CheckCircle2, Monitor, Disc, X, Tablet, Smartphone } from 'lucide-react';
import { apiGet, apiPost, apiPostForm } from '../../services/api';
import { checkAiService, analyzeFrame, enrollFaceAI, enrollFaceFramesAI, verifyFaceAI, captureFrameBase64 } from '../../services/aiProctor';
import { startVoiceVad, type VoiceVadHandle } from '../../services/voiceVad';
import { PermissionGuide } from './PermissionGuide';
import { ExamIntroWalkthrough } from './ExamIntroWalkthrough';
import { countWords, truncateToWords } from '../../services/wordCount';
import { resolveExamTimezone, formatScheduleLabel } from '../../services/timezone';

type ViolationCategory = 'camera' | 'microphone' | 'fullscreen' | 'copyPaste' | 'tabSwitch' | 'environment';

// Deterministic shuffle so MATCHING right-columns / ORDERING items present in a fixed,
// non-authoring order to the candidate but never reshuffle across re-renders. Seeded by the
// question id, so the same question always yields the same display order for a given candidate.
const hashSeed = (s: string): number => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
};
const seededShuffle = <T,>(arr: T[], seedStr: string): T[] => {
  const out = [...arr];
  let seed = hashSeed(seedStr) || 1;
  for (let i = out.length - 1; i > 0; i--) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const j = seed % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
};
const rangeArr = (n: number): number[] => Array.from({ length: n }, (_, i) => i);

// --- Device capability detection -------------------------------------------------
// Mobiles/tablets (especially iOS Safari) cannot screen-record (getDisplayMedia is
// absent) and iPhone Safari has no Fullscreen API. We degrade gracefully on these
// devices: keep camera + microphone proctoring and camera recording, but skip
// screen capture, fullscreen enforcement and external-display checks that would
// otherwise hard-block a mobile candidate from ever starting the exam.
const detectIOS = (): boolean => {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  const isIphoneIpod = /iPad|iPhone|iPod/.test(ua);
  // iPadOS 13+ reports as "MacIntel" but exposes touch — treat as iOS.
  const isIpadOS = navigator.platform === 'MacIntel' && (navigator.maxTouchPoints || 0) > 1;
  return isIphoneIpod || isIpadOS;
};

const detectMobile = (): boolean => {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  const uaMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobile|Tablet/i.test(ua);
  const touchOnly = (navigator.maxTouchPoints || 0) > 0 && !window.matchMedia?.('(pointer:fine)').matches;
  return uaMobile || detectIOS() || touchOnly;
};

// Resolve the candidate's device class so an exam can allow/deny it. 'desktop' covers laptops and
// desktop computers (a browser cannot tell the two apart); tablets and phones are detected from the
// UA (Android tablets omit the "Mobile" token; iPads report as iPad or masquerade as a Mac with
// touch). Mirrors the labels shown to admins in the exam form.
const classifyDeviceType = (): DeviceType => {
  if (typeof navigator === 'undefined') return 'desktop';
  const ua = navigator.userAgent || '';
  const isIpadOS = navigator.platform === 'MacIntel' && (navigator.maxTouchPoints || 0) > 1;
  if (/iPad/.test(ua) || isIpadOS) return 'tablet';
  if (/Android/.test(ua) && !/Mobile/.test(ua)) return 'tablet';
  if (/iPhone|iPod|Windows Phone|BlackBerry|IEMobile|Opera Mini/i.test(ua)) return 'mobile';
  if (/Android/.test(ua) && /Mobile/.test(ua)) return 'mobile';
  // Generic touch-only device with a small screen — treat as a phone.
  const touchOnly = (navigator.maxTouchPoints || 0) > 0 && !window.matchMedia?.('(pointer:fine)').matches;
  const minEdge = Math.min(window.screen?.width || 0, window.screen?.height || 0);
  if (touchOnly && minEdge > 0 && minEdge < 820) return 'mobile';
  return 'desktop';
};

const deviceTypeLabel: Record<DeviceType, string> = {
  desktop: 'a desktop or laptop computer',
  tablet: 'a tablet',
  mobile: 'a mobile phone',
};

const hasDisplayMediaSupport = (): boolean =>
  typeof navigator !== 'undefined' && !!navigator.mediaDevices && typeof navigator.mediaDevices.getDisplayMedia === 'function';

const hasFullscreenSupport = (): boolean => {
  if (typeof document === 'undefined') return false;
  const el = document.documentElement as any;
  return !!(el.requestFullscreen || el.webkitRequestFullscreen || el.msRequestFullscreen);
};

// ── Media acquisition ─────────────────────────────────────────────────────────
// Resolution is expressed as ideal/max only. A hard `min` turns a webcam that merely can't reach
// our preferred size into an OverconstrainedError — i.e. a working camera that refuses to open.
const CAMERA_CONSTRAINTS: MediaTrackConstraints = {
  width: { ideal: 960, max: 1280 },
  height: { ideal: 540, max: 720 },
  frameRate: { ideal: 24, max: 30 },
  facingMode: 'user',
};
// Proctoring needs the RAW mic signal. Browser DSP (noise suppression / auto gain / echo
// cancellation) gates and normalises speech, which stops the strike counters in detectAudio()
// from ever accumulating — so no violation fires.
const MIC_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
};

// What actually went wrong. Each of these needs different recovery instructions, and they were
// previously all collapsed into "your browser blocked access".
export type MediaProblem = 'denied' | 'no-device' | 'device-busy' | 'insecure' | 'unknown' | 'wrong-surface' | null;

// Thrown when the candidate shared a window/tab instead of the full screen. Distinguished from a
// plain denial so the UI can tell them exactly what to pick instead of "permission blocked".
class WrongDisplaySurfaceError extends Error {
  constructor() {
    super('WRONG_DISPLAY_SURFACE');
    this.name = 'WrongDisplaySurfaceError';
  }
}

const classifyMediaError = (err: unknown): MediaProblem => {
  const name = String((err as any)?.name || '');
  if (name === 'WrongDisplaySurfaceError') return 'wrong-surface';
  // Chrome/Firefox/Safari all report an outright refusal (or a policy/permissions-policy block)
  // as NotAllowedError; SecurityError shows up on non-HTTPS origins.
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError') return 'denied';
  if (name === 'SecurityError') return 'insecure';
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError' || name === 'OverconstrainedError'
      || name === 'ConstraintNotSatisfiedError') return 'no-device';
  // The device exists but another app (Zoom / Teams / OBS) holds it open.
  if (name === 'NotReadableError' || name === 'TrackStartError' || name === 'AbortError') return 'device-busy';
  if (typeof navigator === 'undefined' || !navigator.mediaDevices) return 'insecure';
  return 'unknown';
};

// Prefer the GPU (WebGL) backend, but degrade to CPU when WebGL is unavailable or broken
// (headless GPUs, blocked drivers, locked-down kiosks) so detection still runs everywhere.
const ensureTfBackend = async (tf: any): Promise<string> => {
  await tf.ready();
  if (tf.getBackend() !== 'webgl') {
    const ok = await tf.setBackend('webgl').then(() => true).catch(() => false);
    if (ok) await tf.ready();
  }
  if (tf.getBackend() !== 'webgl') {
    await tf.setBackend('cpu').catch(() => {});
    await tf.ready();
  }
  return tf.getBackend();
};

// Small blank frame used to JIT-compile model kernels so the first real inference isn't laggy.
const warmupCanvas = (): HTMLCanvasElement => {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 128;
  return c;
};

const warmUpModel = async (run: () => Promise<unknown>): Promise<void> => {
  try {
    await run();
  } catch {
    // Warm-up is best-effort; a failure here must never block model readiness.
  }
};

interface ExamTakeProps {
  exam: Exam;
  student: Student;
  sessionId?: number;
  onFinish: (data: {
    answers: Record<string, string | number>;
    violations: ViolationLog[];
    questions: Question[];
    questionTimes?: Record<string, number>;
    terminated?: boolean;
    terminationReason?: string;
    violationSummary?: {
      total: number;
      byType: Record<string, number>;
      byCategory: Record<ViolationCategory, number>;
      triggerType?: ViolationLog['type'];
      triggerCategory?: ViolationCategory;
    };
  }) => void;
}

export const ExamTake: React.FC<ExamTakeProps> = ({ exam, student, sessionId, onFinish }) => {
  // --- LOGIC SECTION ---

  const seedFromString = (value: string) => {
    let hash = 2166136261;
    for (let i = 0; i < value.length; i += 1) {
      hash ^= value.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  };

  const mulberry32 = (seed: number) => {
    let t = seed + 0x6D2B79F5;
    return () => {
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };

  const shuffleInPlace = <T,>(items: T[]) => {
    for (let i = items.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [items[i], items[j]] = [items[j], items[i]];
    }
  };

  const shuffleWithSeed = <T,>(items: T[], seed: number | null) => {
    const copy = [...items];
    if (seed === null) {
      shuffleInPlace(copy);
      return copy;
    }
    const rng = mulberry32(seed);
    for (let i = copy.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rng() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
  };

  const makeSeed = (suffix: string) => {
    if (sessionId === null || sessionId === undefined) return null;
    return seedFromString(`${sessionId}|${suffix}`);
  };

  // Initialize Sections (Shuffle, Limits, and Pools)
  const [activeSections] = useState(() => {
    if (exam.sections && exam.sections.length > 0) {
      const orderedSections = [...exam.sections].sort((a, b) => (a.displayOrder ?? 0) - (b.displayOrder ?? 0));
      return orderedSections.map(section => {
        const base = [...section.questions];
        let working = base;
        if (section.shuffleQuestions ?? true) {
          working = shuffleWithSeed(base, makeSeed(section.id));
        }
        let selected = working;
        if (section.questionLimit && section.questionLimit > 0 && section.questionLimit < working.length) {
          selected = working.slice(0, section.questionLimit);
        }
        return {
          ...section,
          questions: selected.map(q => ({ ...q, sectionId: section.id, sectionTitle: section.title }))
        };
      });
    }

    let questionsToProcess = [...exam.questions];
    if (exam.shuffleQuestions ?? true) {
      questionsToProcess = shuffleWithSeed(questionsToProcess, makeSeed('GLOBAL'));
    }
    if (exam.questionCount && exam.questionCount > 0 && exam.questionCount < questionsToProcess.length) {
      questionsToProcess = questionsToProcess.slice(0, exam.questionCount);
    }
    return [{
      id: 'GLOBAL',
      title: 'Main Section',
      questionLimit: exam.questionCount ?? 0,
      shuffleQuestions: exam.shuffleQuestions ?? true,
      timeLimitMinutes: 0,
      lockOnComplete: false,
      displayOrder: 0,
      questions: questionsToProcess.map(q => ({ ...q, sectionId: 'GLOBAL', sectionTitle: 'Main Section' }))
    }];
  });

  const totalQuestions = activeSections.reduce((sum, section) => sum + section.questions.length, 0);
  const [currentSectionIdx, setCurrentSectionIdx] = useState(0);
  const [currentQuestionIdx, setCurrentQuestionIdx] = useState(0);
  const [minSectionIdx, setMinSectionIdx] = useState(0);
  const [sectionTimeLeft, setSectionTimeLeft] = useState<number | null>(null);
  // Values are per-type: number (option index), number[] (multi-select/ordering),
  // string (text/numeric/date/time), or a Record map (matching/drag-drop).
  const [answers, setAnswers] = useState<Record<string, any>>({});
  const [timeLeft, setTimeLeft] = useState(exam.durationMinutes * 60);
  const [violations, setViolations] = useState<ViolationLog[]>([]);
  const [questionTimes, setQuestionTimes] = useState<Record<string, number>>({});
  const questionTimerRef = useRef<number>(Date.now());
  const pausedRef = useRef<boolean>(false);
  const questionTimesRef = useRef<Record<string, number>>({});
  const [autosaveStatus, setAutosaveStatus] = useState<'saving' | 'saved'>('saved');
  const [resumePending, setResumePending] = useState(false);
  const [resumeCountdown, setResumeCountdown] = useState(5);
  const resumePayloadRef = useRef<any | null>(null);
  const resumeOverrideRef = useRef<number | null>(null);
  const resumeAppliedRef = useRef(false);
  const [tabSwitchCount, setTabSwitchCount] = useState(0);
  const tabSwitchLimit = Math.max(0, Number(exam.proctoringConfig?.tabSwitchLimit ?? 0));
  const tabSwitchLockedRef = useRef(false);
  const terminationQueuedRef = useRef(false);
  const finishOnceRef = useRef(false);
  const violationTypeCountsRef = useRef<Record<ViolationLog['type'], number>>({
    TAB_SWITCH: 0,
    NO_FACE: 0,
    MULTIPLE_FACES: 0,
    GAZE_AWAY: 0,
    AUDIO_DETECTED: 0,
    FULLSCREEN_EXIT: 0,
    COPY_PASTE: 0,
    PHONE_DETECTED: 0,
    ANOMALY_OBJECT: 0,
    LOCATION_CHANGE: 0,
    IDENTITY_CHANGE: 0,
    SUSPICIOUS_BEHAVIOR: 0,
  });
  const violationCategoryCountsRef = useRef<Record<ViolationCategory, number>>({
    camera: 0,
    microphone: 0,
    fullscreen: 0,
    copyPaste: 0,
    tabSwitch: 0,
    environment: 0,
  });
  const categoryLimits: Record<ViolationCategory, number> = {
    camera: Math.max(0, Number(exam.proctoringConfig?.violationLimits?.camera ?? 0)),
    microphone: Math.max(0, Number(exam.proctoringConfig?.violationLimits?.microphone ?? 0)),
    fullscreen: Math.max(0, Number(exam.proctoringConfig?.violationLimits?.fullscreen ?? 0)),
    copyPaste: Math.max(0, Number(exam.proctoringConfig?.violationLimits?.copyPaste ?? 0)),
    tabSwitch: tabSwitchLimit,
    environment: 0,
  };
  
  // Feedback UI State
  const [feedbackBanner, setFeedbackBanner] = useState<{show: boolean, msg: string, type: 'warning' | 'error'}>({ show: false, msg: '', type: 'warning' });
  const feedbackTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // Monitoring Refs
  const videoRef = useRef<HTMLVideoElement>(null);
  const [audioLevel, setAudioLevel] = useState(0);
  const audioLevelRef = useRef(0);
  // Live microphone status surfaced in the exam sidebar so a candidate (and a reviewer during a
  // test) can SEE that audio monitoring is actually capturing: 'off' = no mic, 'suspended' = the
  // browser hasn't resumed the AudioContext yet (tap/click to activate), 'listening' = capturing.
  const [micStatus, setMicStatus] = useState<'off' | 'suspended' | 'listening'>('off');
  const micStatusRef = useRef<'off' | 'suspended' | 'listening'>('off');
  const setMicStatusOnce = (next: 'off' | 'suspended' | 'listening') => {
    if (micStatusRef.current !== next) {
      micStatusRef.current = next;
      setMicStatus(next);
    }
  };
  // Live proctoring signals surfaced to the UI so the student (and reviewers during a test) can
  // see that detection is actually running: face count + whether the student is looking away.
  const [proctorLive, setProctorLive] = useState<{ faceCount: number | null; gazeAway: boolean }>({
    faceCount: null,
    gazeAway: false,
  });
  const proctorLiveRef = useRef<{ faceCount: number | null; gazeAway: boolean }>({ faceCount: null, gazeAway: false });
  // Latest AI status snapshot pushed to the proctor live wall (frame-push transport).
  const liveStatusRef = useRef<{
    faceCount: number | null;
    gazeAway: boolean;
    eyesClosed: boolean;
    mouthOpen: boolean;
    phone: boolean;
    multipleFaces: boolean;
    riskScore: number | null;
    riskLevel: 'low' | 'medium' | 'high' | null;
    aiNote: string | null;
  }>({ faceCount: null, gazeAway: false, eyesClosed: false, mouthOpen: false, phone: false, multipleFaces: false, riskScore: null, riskLevel: null, aiNote: null });
  const lastPushedViolationRef = useRef<ViolationLog['type'] | null>(null);
  const lastViolationTimeByType = useRef<Partial<Record<ViolationLog['type'], number>>>({});
  const audioContextRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [permissionStatus, setPermissionStatus] = useState<'pending' | 'granted' | 'denied'>('pending');
  const [permissionBusy, setPermissionBusy] = useState(false);
  // Walk the candidate through what's about to happen (camera/mic/entire-screen, why, how to
  // allow each) BEFORE any browser permission dialog appears — so the first thing they see isn't
  // an unexplained popup. Persisted per exam+student so a mid-exam refresh/resume doesn't force
  // sitting through it again; a fresh localStorage (new device/browser) shows it again, which is fine.
  const introStorageKey = `pg_intro_seen_${exam.id}_${student.id}`;
  const [introDone, setIntroDone] = useState(() => {
    try {
      return typeof window !== 'undefined' && window.localStorage.getItem(introStorageKey) === '1';
    } catch {
      return false;
    }
  });
  // WHY the devices failed. "Blocked by the browser" and "this PC has no camera" need completely
  // different recovery steps, and showing the address-bar-unblock guide to someone whose webcam is
  // simply unplugged (or held open by Zoom/Teams) sends them chasing a setting that is already fine.
  const [mediaProblem, setMediaProblem] = useState<MediaProblem>(null);
  // Mic absent/busy while the camera works: proctor without audio instead of failing the exam.
  const [micUnavailable, setMicUnavailable] = useState(false);
  // Screen share status — required on desktop, blocked exam if denied.
  const [screenShareStatus, setScreenShareStatus] = useState<'pending' | 'granted' | 'denied'>('pending');
  // Primary camera/mic tracks ended mid-exam (permission revoked, device pulled, driver crash).
  const [streamLost, setStreamLost] = useState(false);
  // Device capabilities are resolved once per mount. On mobile/iOS the screen-capture
  // and fullscreen APIs are unavailable, so we run a reduced (but still enforced)
  // proctoring profile rather than blocking the candidate outright.
  const device = useMemo(() => {
    const isMobile = detectMobile();
    const isIOS = detectIOS();
    return {
      isMobile,
      isIOS,
      deviceClass: classifyDeviceType(),
      canScreenRecord: hasDisplayMediaSupport() && !isMobile,
      canFullscreen: hasFullscreenSupport() && !isMobile,
    };
  }, []);
  // Device-restriction gate: an admin can limit an exam to specific device classes. An empty/absent
  // list means every device is allowed. If the candidate's class isn't permitted, the exam is hard-
  // blocked before any permission prompt or timer starts.
  const allowedDeviceTypes = useMemo<DeviceType[]>(() => {
    const list = exam.allowedDeviceTypes;
    return Array.isArray(list) && list.length > 0 ? list : ['desktop', 'tablet', 'mobile'];
  }, [exam.allowedDeviceTypes]);
  const deviceBlocked = !allowedDeviceTypes.includes(device.deviceClass);
  // Recording + AI detection are camera-scoped: they only run when the exam actually requires
  // the camera. If an admin unchecks camera (and microphone), the candidate is never prompted for
  // any device and no capture is attempted.
  const recordingEnabled = exam.proctoringConfig.cameraRequired;
  // Screen recording is desktop-only; camera recording still runs on mobile.
  const screenRecordingEnabled = recordingEnabled && device.canScreenRecord;
  // Fullscreen is only enforced where the browser actually supports it (iOS Safari
  // has no Fullscreen API — enforcing it there would permanently block the exam).
  const fullscreenEnforced = exam.proctoringConfig.fullScreenEnforced && device.canFullscreen;
  const cameraCaptureRequired = exam.proctoringConfig.cameraRequired;
  const microphoneCaptureRequired = exam.proctoringConfig.microphoneRequired;
  // Screen share is required on desktop where it's supported — the student must share their screen
  // for the full recording to be captured (camera + mic + screen).
  const screenCaptureRequired = screenRecordingEnabled;
  const permissionsRequired = cameraCaptureRequired || microphoneCaptureRequired || screenCaptureRequired;
  const faceDetectorRef = useRef<any>(null);
  const faceMlModelRef = useRef<any>(null);
  const [faceMlReady, setFaceMlReady] = useState(false);
  const objectDetectorRef = useRef<any>(null);
  const [objectModelReady, setObjectModelReady] = useState(false);
  const audioRafRef = useRef<number | null>(null);
  // Silero VAD (neural voice-activity model) handle + whether it's the active voice detector.
  // When the model is running it OWNS the AUDIO_DETECTED decision; the spectral loop below then
  // only drives the level meter. If the model fails to load we stay on the spectral fallback.
  const voiceVadRef = useRef<VoiceVadHandle | null>(null);
  const vadModelActiveRef = useRef(false);
  // True while the VAD model currently considers speech to be in progress (set by
  // onSpeechConfirmed/onSpeechEnd). Drives the SAME sustained-duration timer the spectral fallback
  // uses below, so both paths funnel through one configurable "how many seconds of talking" gate.
  const vadSpeechActiveRef = useRef(false);
  const voiceActiveStartRef = useRef<number | null>(null);   // when sustained voice activity began
  const voiceActiveLastSeenRef = useRef<number>(0);          // last tick voice was actually active (flicker tolerance)
  // Last time the AI face read saw the candidate's own mouth open. A microphone can't tell "the
  // candidate is talking" apart from "a TV/video call is playing nearby" — both are genuine human
  // speech acoustically. Requiring recent lip movement from OUR OWN camera feed is the one signal
  // that actually distinguishes them, so it gates AUDIO_DETECTED below whenever a face is tracked.
  const lastMouthOpenAtRef = useRef<number>(0);
  // Removes the document-level "resume the AudioContext on any interaction" listeners on teardown.
  const audioResumeCleanupRef = useRef<(() => void) | null>(null);
  const audioProfileRef = useRef({
    ambientRms: 0.025,         // realistic starting floor for a room with any background
    ambientSpeechRatio: 0.28,
    voiceStrikes: 0,
    conversationStrikes: 0,
    noiseStrikes: 0,
    lastSpeechAt: 0,
    calibrationEndAt: 0,       // no violations fired until 18 s of ambient sampling completes
    prevVoiceEnergy: 0,        // last frame's voice-band energy (for speech-envelope modulation)
    fluxEma: 0,                // smoothed |Δ voice energy|: high for speech, ~0 for steady hum
  });
  const [fullscreenBlocked, setFullscreenBlocked] = useState(false);
  // Biometric identity enrollment + verification.
  const faceVerificationEnabled = exam.proctoringConfig.cameraRequired;
  const [identityEnrollment, setIdentityEnrollment] =
    useState<'idle' | 'checking' | 'required' | 'enrolled' | 'unavailable'>('idle');
  const [enrollBusy, setEnrollBusy] = useState(false);
  const [enrollMessage, setEnrollMessage] = useState<string | null>(null);
  const enrolledDescriptorRef = useRef<number[] | null>(null);
  const faceRecognitionActiveRef = useRef(false);
  const identityMismatchRef = useRef({ strikes: 0, lastFlaggedAt: 0 });
  const enrollPreviewRef = useRef<HTMLVideoElement>(null);
  const enrollmentPending = faceVerificationEnabled && identityEnrollment === 'required';
  // Identity enrollment no longer blocks the exam — proctoring arms on permissions and the
  // identity template is auto-captured in the background (see the detection loop).
  const examBlocked = deviceBlocked || permissionStatus !== 'granted' || fullscreenBlocked
    || (screenCaptureRequired && screenShareStatus !== 'granted') || streamLost;
  const proctoringArmedRef = useRef(false);
  const finishingRef = useRef(false);
  const fullscreenExitConfirmTimeoutRef = useRef<number | null>(null);
  const aiServiceAvailableRef = useRef<boolean | null>(null);
  const aiEnrolledDescriptorRef = useRef<number[] | null>(null);
  // Background SFace auto-enrollment guard (so we attempt it once, then on a cooldown if it fails).
  // `samples` accumulates several good frames so the enrolled template is an AVERAGE — a single
  // frame makes a brittle template that later flags the same person as an identity change.
  const autoEnrollRef = useRef<{ done: boolean; lastTry: number; samples: string[] }>({ done: false, lastTry: 0, samples: [] });
  // After a template is enrolled, ignore identity-mismatch flags briefly: the server's rolling
  // identity buffer still holds pre-enrollment frames, and the fresh template needs a few frames
  // to settle. Prevents a spurious IDENTITY_CHANGE the moment enrollment completes.
  const identityWarmUntilRef = useRef(0);
  // Suppresses tab-switch and blur violations while a browser permission dialog is open.
  const permissionDialogOpenRef = useRef(false);
  // Timestamp (ms) until which tab-switch/blur violations are suppressed. Covers the noisy
  // moments the browser itself steals focus for legitimate reasons: the exam warming up right
  // after permissions are granted, and the screen-share indicator bar appearing / being toggled
  // (its "Hide" button blurs the tab briefly). Genuine app-switches outlast this window.
  const tabViolationGraceUntilRef = useRef(0);
  const suppressTabViolationsFor = (ms: number) => {
    tabViolationGraceUntilRef.current = Math.max(tabViolationGraceUntilRef.current, Date.now() + ms);
  };
  // Shared guard for every "did the browser chrome itself cause this, not the candidate"
  // check (tab-switch, blur, fullscreen-exit): true while a permission/screen-picker dialog is
  // open, or during the grace window right after one closes.
  const isChromeInducedEvent = () =>
    permissionDialogOpenRef.current || Date.now() < tabViolationGraceUntilRef.current;

  // Proctor-timer refs — track how long each condition has been continuously present.
  // Violations fire only after the condition is sustained for the grace period.
  const faceAbsenceStartRef  = useRef<number | null>(null); // when face first disappeared
  const gazeAwayStartRef     = useRef<number | null>(null); // when gaze first went away
  const gazeAwayLastSeenRef  = useRef<number>(0);           // last tick gaze was actually away (flicker tolerance)
  const multiFaceStartRef    = useRef<number | null>(null); // when multiple faces first appeared
  const faceApiReadyRef      = useRef(false);               // true once face-api.js models loaded

  // Grace periods — how long a condition must persist before a violation fires.
  // Grace periods balanced like real proctoring systems (Proctorio/Honorlock/Mettl): tolerate
  // momentary, normal human behaviour (a glance, a thinking pause, a stretch) but reliably catch
  // SUSTAINED suspicious behaviour within a few seconds. Tuned so an honest student is not spammed,
  // yet a student who looks away/leaves frame for several seconds IS recorded.
  // Matched to what EXAM_INSTRUCTIONS.md promises candidates (NO_FACE ~10s, GAZE_AWAY ~9s,
  // MULTIPLE_FACES ~2.5s) — these had drifted well below the published numbers (NO_FACE was 2s,
  // GAZE_AWAY was 1.5s), which meant completely normal behaviour (looking down while typing,
  // glancing at scratch paper, a longer blink) crossed the threshold and logged a real violation.
  const FACE_ABSENT_GRACE_MS = 10000;  // 10s with no face before flagging (matches published instructions)
  // Configurable per exam (Settings > Exam defaults, or per-exam override) — admins can loosen/
  // tighten how many seconds of look-away are tolerated before GAZE_AWAY fires.
  const GAZE_AWAY_GRACE_MS   = Math.max(1000, (exam.proctoringConfig.proctorTiming?.gazeAwaySeconds ?? 9) * 1000);
  // A single noisy frame (landmark jitter right at the yaw threshold) used to hard-reset the whole
  // accumulated timer, so a genuinely sustained look-away that flickered true/false near the boundary
  // could take far longer than GAZE_AWAY_GRACE_MS to fire — in practice this is why GAZE_AWAY had
  // almost stopped firing in production. Tolerate brief flicker back to "not away" the same way a
  // human proctor would (a fraction of a second doesn't mean the candidate looked back).
  const GAZE_AWAY_FLICKER_TOLERANCE_MS = 1500;
  const MULTI_FACE_GRACE_MS  = 2500;   // 2.5s with a confirmed 2nd person before flagging (matches published instructions)
  // Configurable per exam (Settings > Exam defaults, or per-exam override) — seconds of sustained
  // talking tolerated before AUDIO_DETECTED fires.
  const AUDIO_GRACE_MS = Math.max(1000, (exam.proctoringConfig.proctorTiming?.audioSeconds ?? 2) * 1000);
  const AUDIO_OFF_FLICKER_TOLERANCE_MS = 900; // tolerate a brief pause between words/syllables
  const storageKey = `pg_exam_state_${exam.id}_${student.id}_${sessionId ?? 'na'}`;
  const faceSignalRef = useRef({
    lastFaceSeenAt: Date.now(),
    noFaceStrikes: 0,
    multiFaceStrikes: 0,
    gazeAwayStrikes: 0,
  });
  const objectSignalRef = useRef({
    phoneHits: 0,
    anomalyHits: 0,
  });
  // Identity continuity: detect a likely person-change mid-exam using scale/position-invariant
  // face geometry. Not biometric 1:1 matching (no enrolled photo exists) — a robust "same person
  // stayed in frame" heuristic that flags when a differently-proportioned face takes over.
  const identitySignalRef = useRef<{
    baseline: number[] | null;
    samples: number[][];
    mismatchStrikes: number;
    lastFlaggedAt: number;
  }>({
    baseline: null,
    samples: [],
    mismatchStrikes: 0,
    lastFlaggedAt: 0,
  });
  // Violations are evidence — never silently drop them on a flaky network. Failed uploads are
  // queued and retried (capped, oldest-trimmed) on reconnect and on a periodic flush.
  const pendingViolationsRef = useRef<Array<{ payload: Record<string, unknown>; attempts: number }>>([]);
  const flushingViolationsRef = useRef(false);
  // Live mirrors of state consumed by handleFinish. Finish is triggered from long-lived closures
  // (the exam timer effect, the detection loop's termination path) that captured the state from
  // the render they mounted in — reading these refs instead guarantees the submitted answers and
  // violation log reflect the moment the exam actually ended.
  const answersRef = useRef(answers);
  useEffect(() => { answersRef.current = answers; }, [answers]);
  const violationsRef = useRef(violations);
  useEffect(() => { violationsRef.current = violations; }, [violations]);
  const positionRef = useRef({ sectionIdx: 0, questionIdx: 0 });
  useEffect(() => {
    positionRef.current = { sectionIdx: currentSectionIdx, questionIdx: currentQuestionIdx };
  }, [currentSectionIdx, currentQuestionIdx]);
  const recordingSessionIdRef = useRef<number | null>(null);
  const recordingStartTsRef = useRef<number>(0);
  const recordingStartedRef = useRef(false);
  const recordingCompleteSentRef = useRef(false);
  const screenStreamRef = useRef<MediaStream | null>(null);
  // Coalesces concurrent screen-capture requests onto a single in-flight prompt so the OS screen
  // picker can never open twice (e.g. a re-render firing the setup effect while one is pending).
  const screenCaptureInFlightRef = useRef<Promise<MediaStream> | null>(null);
  const combinedStreamRef = useRef<MediaStream | null>(null);
  const combinedCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const compositorIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const compositorVideosRef = useRef<{ base: HTMLVideoElement; cam: HTMLVideoElement } | null>(null);
  // Off-screen camera element that always keeps decoding (independent of the recording pipeline
  // and the possibly-hidden preview) — the reliable source for detection and live snapshots.
  const detectionVideoRef = useRef<HTMLVideoElement | null>(null);
  const recorderRefs = useRef<Partial<Record<'camera' | 'screen' | 'combined', MediaRecorder>>>({});
  const uploadSeqRef = useRef<Record<'camera' | 'screen' | 'combined', number>>({
    camera: 0,
    screen: 0,
    combined: 0,
  });
  // Per-stream upload chain. The server appends chunks to a single WebM file in ARRIVAL order, so two
  // chunk uploads racing (a slow one overtaken by the next 3s chunk) would interleave bytes and corrupt
  // the file — it then won't play back. Chaining each stream's uploads guarantees strictly-in-order
  // delivery regardless of network jitter. Uploads swallow their own errors, so the chain never breaks.
  const uploadChainRef = useRef<Record<'camera' | 'screen' | 'combined', Promise<void>>>({
    camera: Promise.resolve(),
    screen: Promise.resolve(),
    combined: Promise.resolve(),
  });
  const audioAnalysisFrameRef = useRef(0);

  const pickMimeType = () => {
    const candidates = [
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm',
    ];
    for (const c of candidates) {
      if ((window as any).MediaRecorder?.isTypeSupported?.(c)) return c;
    }
    return '';
  };

  const getPredictionScore = (prediction: any): number | null => {
    if (prediction && typeof prediction.score === 'number') {
      return prediction.score;
    }
    const probability = prediction?.probability;
    if (typeof probability === 'number') return probability;
    if (Array.isArray(probability) && probability.length > 0) {
      const value = Number(probability[0]);
      if (Number.isFinite(value)) return value;
    }
    return null;
  };

  const getBlazeFaceAreaRatio = (prediction: any, videoEl: HTMLVideoElement): number => {
    const topLeft = prediction?.topLeft;
    const bottomRight = prediction?.bottomRight;
    if (!topLeft || !bottomRight) return 0;
    const tx = Number(Array.isArray(topLeft) ? topLeft[0] : topLeft.x);
    const ty = Number(Array.isArray(topLeft) ? topLeft[1] : topLeft.y);
    const bx = Number(Array.isArray(bottomRight) ? bottomRight[0] : bottomRight.x);
    const by = Number(Array.isArray(bottomRight) ? bottomRight[1] : bottomRight.y);
    if (![tx, ty, bx, by].every(Number.isFinite)) return 0;
    const width = Math.max(0, bx - tx);
    const height = Math.max(0, by - ty);
    const area = width * height;
    const frameArea = Math.max(1, videoEl.videoWidth * videoEl.videoHeight);
    return area / frameArea;
  };

  const getBlazeFaceBox = (prediction: any, videoEl: HTMLVideoElement) => {
    const topLeft = prediction?.topLeft;
    const bottomRight = prediction?.bottomRight;
    if (!topLeft || !bottomRight) return null;
    const tx = Number(Array.isArray(topLeft) ? topLeft[0] : topLeft.x);
    const ty = Number(Array.isArray(topLeft) ? topLeft[1] : topLeft.y);
    const bx = Number(Array.isArray(bottomRight) ? bottomRight[0] : bottomRight.x);
    const by = Number(Array.isArray(bottomRight) ? bottomRight[1] : bottomRight.y);
    if (![tx, ty, bx, by].every(Number.isFinite)) return null;
    const frameWidth = Math.max(1, videoEl.videoWidth);
    const frameHeight = Math.max(1, videoEl.videoHeight);
    return {
      centerX: ((tx + bx) / 2) / frameWidth,
      centerY: ((ty + by) / 2) / frameHeight,
      width: Math.max(0, bx - tx) / frameWidth,
      height: Math.max(0, by - ty) / frameHeight,
    };
  };

  const getLandmarkPoint = (point: any): { x: number; y: number } | null => {
    if (!point) return null;
    const x = Number(Array.isArray(point) ? point[0] : point.x);
    const y = Number(Array.isArray(point) ? point[1] : point.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return { x, y };
  };

  const estimateAttentionAway = (prediction: any, videoEl: HTMLVideoElement) => {
    const box = getBlazeFaceBox(prediction, videoEl);
    if (!box) return false;

    const faceTooFarFromCenter =
      box.centerX < 0.2 ||
      box.centerX > 0.8 ||
      box.centerY < 0.16 ||
      box.centerY > 0.84 ||
      box.width < 0.11 ||
      box.height < 0.16;

    const landmarks = Array.isArray(prediction?.landmarks) ? prediction.landmarks : [];
    const leftEye = getLandmarkPoint(landmarks[0]);
    const rightEye = getLandmarkPoint(landmarks[1]);
    const nose = getLandmarkPoint(landmarks[2]);
    let headTurned = false;

    if (leftEye && rightEye && nose) {
      const eyeMinX = Math.min(leftEye.x, rightEye.x);
      const eyeMaxX = Math.max(leftEye.x, rightEye.x);
      const eyeDistance = Math.max(1, eyeMaxX - eyeMinX);
      const noseOffsetFromEyeCenter = Math.abs(nose.x - ((leftEye.x + rightEye.x) / 2)) / eyeDistance;
      headTurned = noseOffsetFromEyeCenter > 0.42;
    }

    return faceTooFarFromCenter || headTurned;
  };

  // Build a scale/position-invariant facial-geometry signature from blazeface landmarks.
  // Landmarks order: [rightEye, leftEye, nose, mouth, rightEar, leftEar].
  const buildFaceSignature = (prediction: any): number[] | null => {
    const landmarks = Array.isArray(prediction?.landmarks) ? prediction.landmarks : [];
    if (landmarks.length < 4) return null;
    const rightEye = getLandmarkPoint(landmarks[0]);
    const leftEye = getLandmarkPoint(landmarks[1]);
    const nose = getLandmarkPoint(landmarks[2]);
    const mouth = getLandmarkPoint(landmarks[3]);
    const rightEar = landmarks[4] ? getLandmarkPoint(landmarks[4]) : null;
    const leftEar = landmarks[5] ? getLandmarkPoint(landmarks[5]) : null;
    if (!rightEye || !leftEye || !nose || !mouth) return null;

    const dist = (a: { x: number; y: number }, b: { x: number; y: number }) =>
      Math.hypot(a.x - b.x, a.y - b.y);
    const interocular = dist(leftEye, rightEye);
    if (!Number.isFinite(interocular) || interocular < 1) return null;

    const eyeCenter = { x: (leftEye.x + rightEye.x) / 2, y: (leftEye.y + rightEye.y) / 2 };
    // All distances normalised by interocular distance -> invariant to how close the face is.
    const sig: number[] = [
      dist(eyeCenter, nose) / interocular,
      dist(nose, mouth) / interocular,
      dist(eyeCenter, mouth) / interocular,
    ];
    if (rightEar && leftEar) {
      sig.push(dist(leftEar, rightEar) / interocular);
      sig.push(dist(nose, leftEar) / dist(nose, rightEar || nose) || 1);
    }
    return sig.every(Number.isFinite) ? sig : null;
  };

  const faceSignatureDistance = (a: number[], b: number[]): number => {
    const n = Math.min(a.length, b.length);
    if (n === 0) return 0;
    let sum = 0;
    for (let i = 0; i < n; i += 1) sum += (a[i] - b[i]) ** 2;
    return Math.sqrt(sum / n);
  };

  // Returns true when the current face geometry differs from the established baseline enough,
  // for long enough, to indicate a different person has taken over the seat.
  const updateIdentitySignal = (prediction: any): boolean => {
    const state = identitySignalRef.current;
    const sig = buildFaceSignature(prediction);
    if (!sig) return false;

    // Establish a stable baseline from the first several clean single-face samples.
    if (!state.baseline) {
      state.samples.push(sig);
      if (state.samples.length >= 6) {
        const len = state.samples[0].length;
        const median: number[] = [];
        for (let i = 0; i < len; i += 1) {
          const col = state.samples.map(s => s[i]).sort((x, y) => x - y);
          median.push(col[Math.floor(col.length / 2)]);
        }
        state.baseline = median;
        state.samples = [];
      }
      return false;
    }

    const distance = faceSignatureDistance(sig, state.baseline);
    // Generous threshold: expression/lighting/angle shift baseline modestly; a different
    // person's proportions move it well past this. Requires sustained strikes to fire.
    if (distance > 0.34) {
      state.mismatchStrikes += 1;
    } else {
      state.mismatchStrikes = Math.max(0, state.mismatchStrikes - 1);
      // Slowly adapt baseline toward the consistent occupant to resist drift false-positives.
      for (let i = 0; i < state.baseline.length; i += 1) {
        state.baseline[i] = state.baseline[i] * 0.97 + sig[i] * 0.03;
      }
    }

    if (state.mismatchStrikes >= 5) {
      const now = Date.now();
      state.mismatchStrikes = 0;
      // Re-baseline to the new occupant so we don't spam after one flag.
      state.baseline = sig;
      if (now - state.lastFlaggedAt < 30000) return false; // rate-limit repeats
      state.lastFlaggedAt = now;
      return true;
    }
    return false;
  };

  const getObjectAreaRatio = (prediction: any, videoEl: HTMLVideoElement): number => {
    const bbox = Array.isArray(prediction?.bbox) ? prediction.bbox : [];
    if (bbox.length < 4) return 0;
    const width = Math.max(0, Number(bbox[2]) || 0);
    const height = Math.max(0, Number(bbox[3]) || 0);
    const area = width * height;
    const frameArea = Math.max(1, videoEl.videoWidth * videoEl.videoHeight);
    return area / frameArea;
  };

  const getBandEnergy = (data: Uint8Array, sampleRate: number, fftSize: number, minHz: number, maxHz: number) => {
    const binWidth = sampleRate / fftSize;
    const start = Math.max(0, Math.floor(minHz / binWidth));
    const end = Math.min(data.length - 1, Math.ceil(maxHz / binWidth));
    if (end < start) return 0;

    let sum = 0;
    let count = 0;
    for (let i = start; i <= end; i += 1) {
      sum += data[i] / 255;
      count += 1;
    }
    return count > 0 ? sum / count : 0;
  };

  // Sum of squared bin magnitudes over a frequency range — unlike getBandEnergy's per-bin MEAN
  // (which lets a narrow, concentrated band trivially read "louder" than a wide band full of quiet
  // bins, breaking any ratio built from it — a narrow band's ratio was coming out well above 1.0,
  // meaningless for a value meant to read as "share of total energy"), a SUM is a true subset of the
  // total range's sum, so band-sum / total-sum is mathematically guaranteed to land in [0, 1] — what
  // the voice/low/high ratio thresholds below were actually calibrated to expect. Bin 0 (0 Hz / DC)
  // is excluded from every band — it carries no oscillating signal and, smoothed by the analyser's
  // temporal averaging, was inflating the low-frequency band in particular.
  const getBandEnergySum = (data: Uint8Array, sampleRate: number, fftSize: number, minHz: number, maxHz: number) => {
    const binWidth = sampleRate / fftSize;
    const start = Math.max(1, Math.floor(minHz / binWidth));
    const end = Math.min(data.length - 1, Math.ceil(maxHz / binWidth));
    if (end < start) return 0;

    let sum = 0;
    for (let i = start; i <= end; i += 1) {
      const v = data[i] / 255;
      sum += v * v;
    }
    return sum;
  };

  const getZeroCrossingRate = (data: Uint8Array) => {
    let crossings = 0;
    for (let i = 1; i < data.length; i += 1) {
      const prev = data[i - 1] - 128;
      const next = data[i] - 128;
      if ((prev >= 0 && next < 0) || (prev < 0 && next >= 0)) {
        crossings += 1;
      }
    }
    return crossings / Math.max(1, data.length - 1);
  };

  const setTrackContentHint = (track: MediaStreamTrack | undefined, hint: string) => {
    if (!track) return;
    try {
      const anyTrack = track as MediaStreamTrack & { contentHint?: string };
      anyTrack.contentHint = hint;
    } catch {
      // ignore unsupported browsers
    }
  };

  const updateFaceSignal = (faceCount: number): 'NO_FACE' | 'MULTIPLE_FACES' | null => {
    const state = faceSignalRef.current;
    const now = Date.now();
    const noFaceGraceMs = 5000; // tolerate blinking, head turns, glancing at keyboard
    const noFaceStrikeLimit = 3; // 3 sustained consecutive misses after grace → violation
    const multiFaceStrikeLimit = 3; // 3 consecutive frames with >1 face (shadows/reflections can cause 1-2 frames)

    if (faceCount === 1) {
      state.lastFaceSeenAt = now;
      state.noFaceStrikes = 0;
      state.multiFaceStrikes = 0;
      return null;
    }

    if (faceCount <= 0) {
      if ((now - state.lastFaceSeenAt) < noFaceGraceMs) {
        state.noFaceStrikes = 0;
        return null;
      }
      state.noFaceStrikes += 1;
      state.multiFaceStrikes = 0;
      if (state.noFaceStrikes >= noFaceStrikeLimit) {
        state.noFaceStrikes = 0;
        return 'NO_FACE';
      }
      return null;
    }

    state.multiFaceStrikes += 1;
    state.noFaceStrikes = 0;
    if (state.multiFaceStrikes >= multiFaceStrikeLimit) {
      state.multiFaceStrikes = 0;
      return 'MULTIPLE_FACES';
    }
    return null;
  };

  const updateGazeSignal = (isAway: boolean): boolean => {
    const state = faceSignalRef.current;
    const strikeLimit = 5; // ~4 seconds of sustained gaze-away at 800 ms intervals
    if (isAway) {
      state.gazeAwayStrikes += 1;
    } else {
      state.gazeAwayStrikes = Math.max(0, state.gazeAwayStrikes - 2); // forgive quickly when eyes return
    }
    if (state.gazeAwayStrikes >= strikeLimit) {
      state.gazeAwayStrikes = 0;
      return true;
    }
    return false;
  };

  const stopCompositor = () => {
    if (compositorIntervalRef.current) {
      clearInterval(compositorIntervalRef.current);
      compositorIntervalRef.current = null;
    }
    if (compositorVideosRef.current) {
      const { base, cam } = compositorVideosRef.current;
      base.srcObject = null;
      cam.srcObject = null;
      base.parentNode?.removeChild(base);
      cam.parentNode?.removeChild(cam);
      compositorVideosRef.current = null;
    }
    if (combinedStreamRef.current) {
      combinedStreamRef.current.getTracks().forEach(track => track.stop());
      combinedStreamRef.current = null;
    }
    combinedCanvasRef.current = null;
  };

  const stopPrimaryProctoringStream = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => {
        try { track.stop(); } catch {}
      });
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    if (detectionVideoRef.current) {
      detectionVideoRef.current.srcObject = null;
      detectionVideoRef.current.parentNode?.removeChild(detectionVideoRef.current);
      detectionVideoRef.current = null;
    }
    // Also stop any lingering screen stream not yet handled by stopRecordingPipeline.
    if (screenStreamRef.current) {
      screenStreamRef.current.getTracks().forEach(track => {
        try { track.stop(); } catch {}
      });
      screenStreamRef.current = null;
    }
  };

  const uploadRecordingChunk = async (streamType: 'camera' | 'screen' | 'combined', blob: Blob) => {
    const recordingId = recordingSessionIdRef.current;
    if (!recordingId || blob.size <= 0) return;
    const sequence = uploadSeqRef.current[streamType]++;
    const mimeType = blob.type || 'video/webm';
    const filename = `${streamType}_${Date.now()}.webm`;
    // Retry transient failures. Chunks are appended to ONE growing WebM in arrival order, so a dropped
    // segment leaves a hole that makes the file unplayable past that point — losing the rest of the
    // recording. Uploads are serialized per stream (uploadChainRef), so each retry keeps capture order.
    const MAX_ATTEMPTS = 4;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const form = new FormData();
      form.append('action', 'CHUNK');
      form.append('recordingId', String(recordingId));
      form.append('streamType', streamType);
      form.append('mimeType', mimeType);
      form.append('sequence', String(sequence));
      form.append('chunk', blob, filename);
      try {
        await apiPostForm('recordings.php', form);
        return;
      } catch (e) {
        if (attempt === MAX_ATTEMPTS) {
          console.error(`Failed to upload ${streamType} recording chunk after ${MAX_ATTEMPTS} attempts:`, e);
          return;
        }
        // Linear backoff (0.8s, 1.6s, 2.4s) — long enough to ride out a brief drop, short enough
        // that the per-stream queue doesn't build up an unbounded backlog of pending blobs.
        await new Promise(resolve => window.setTimeout(resolve, attempt * 800));
      }
    }
  };

  const createRecorder = (
    streamType: 'camera' | 'screen' | 'combined',
    stream: MediaStream,
    config: { videoBitsPerSecond: number; audioBitsPerSecond?: number }
  ) => {
    if (stream.getTracks().length === 0) return null;
    const mimeType = pickMimeType();
    let recorder: MediaRecorder;
    try {
      const options: MediaRecorderOptions = {
        videoBitsPerSecond: config.videoBitsPerSecond,
        audioBitsPerSecond: config.audioBitsPerSecond,
      };
      if (mimeType) options.mimeType = mimeType;
      recorder = new MediaRecorder(stream, options);
    } catch {
      recorder = new MediaRecorder(stream);
    }
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) {
        const chunk = e.data;
        // Queue behind this stream's previous upload so chunks reach the server in capture order.
        uploadChainRef.current[streamType] = uploadChainRef.current[streamType]
          .then(() => uploadRecordingChunk(streamType, chunk));
      }
    };
    recorder.onerror = (e) => {
      console.error(`${streamType} recorder error`, e);
    };
    recorder.start(3000);
    recorderRefs.current[streamType] = recorder;
    return recorder;
  };

  const finalizeRecording = async (status: 'COMPLETED' | 'FAILED') => {
    if (recordingCompleteSentRef.current) return;
    const recordingId = recordingSessionIdRef.current;
    if (!recordingId) return;
    recordingCompleteSentRef.current = true;
    const durationSec = recordingStartTsRef.current > 0
      ? Math.max(0, Math.floor((Date.now() - recordingStartTsRef.current) / 1000))
      : 0;
    try {
      await apiPost('recordings.php', {
        action: 'COMPLETE',
        recordingId,
        status,
        durationSec,
      });
    } catch (e) {
      console.error('Failed to finalize recording:', e);
    }
  };

  const stopRecordingPipeline = async (status: 'COMPLETED' | 'FAILED') => {
    const recs = Object.values(recorderRefs.current).filter(Boolean) as MediaRecorder[];
    recs.forEach(rec => {
      if (rec.state !== 'inactive') {
        try {
          rec.stop();
        } catch {
          // ignore
        }
      }
    });
    recorderRefs.current = {};

    await new Promise(resolve => window.setTimeout(resolve, 500));

    if (screenStreamRef.current) {
      screenStreamRef.current.getTracks().forEach(track => track.stop());
      screenStreamRef.current = null;
    }
    stopCompositor();
    // Flush any queued chunk uploads (including the final one that stop() just emitted) so the file is
    // fully written before we mark the recording COMPLETE and stamp its size/duration.
    await Promise.allSettled(Object.values(uploadChainRef.current));
    await finalizeRecording(status);
    recordingStartedRef.current = false;
    recordingSessionIdRef.current = null;
  };

  const shutdownExamCapture = async (status: 'COMPLETED' | 'FAILED') => {
    proctoringArmedRef.current = false;

    if (audioRafRef.current) {
      window.cancelAnimationFrame(audioRafRef.current);
      audioRafRef.current = null;
    }
    if (voiceVadRef.current) {
      void voiceVadRef.current.destroy();
      voiceVadRef.current = null;
      vadModelActiveRef.current = false;
    }
    if (audioResumeCleanupRef.current) {
      audioResumeCleanupRef.current();
    }
    if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
      await audioContextRef.current.close().catch(() => {});
    }
    audioContextRef.current = null;

    await stopRecordingPipeline(status);
    stopPrimaryProctoringStream();

    if (document.fullscreenElement) {
      finishingRef.current = true;
      await document.exitFullscreen().catch(() => {});
    }
  };

  const requestScreenCapture = async (): Promise<MediaStream | null> => {
    if (!screenRecordingEnabled) return null;
    if (!navigator.mediaDevices?.getDisplayMedia) {
      throw new Error('Screen capture is not supported in this browser.');
    }
    // Idempotent: if we already hold a LIVE screen stream, reuse it rather than prompting again.
    // (Previously this stopped the existing stream and re-opened the picker — the source of the
    // "screen share asked twice" bug when any caller re-entered.)
    const existing = screenStreamRef.current;
    if (existing && existing.getVideoTracks().some(t => t.readyState === 'live')) {
      return existing;
    }
    // Coalesce concurrent callers onto one in-flight prompt so the picker opens exactly once.
    if (screenCaptureInFlightRef.current) return screenCaptureInFlightRef.current;

    // Suppress tab-switch/blur violations while the OS screen-picker dialog is open.
    permissionDialogOpenRef.current = true;
    const request = (async () => {
      let screenStream: MediaStream;
      try {
        screenStream = await navigator.mediaDevices.getDisplayMedia({
          video: {
            // 'monitor' as a preference nudges Chrome/Edge to default to the "Entire Screen" tab
            // in the picker. It's a hint, not a hard filter — the candidate can still switch tabs
            // in the picker, so we also verify what they actually picked below and reject it.
            displaySurface: 'monitor',
            frameRate: { ideal: 15, max: 20 },
            width: { ideal: 1920, max: 1920 },
            height: { ideal: 1080, max: 1080 },
          } as MediaTrackConstraints,
          audio: false,
        });
      } finally {
        // Always clear the flag — even if the user cancels the dialog. Then keep suppressing
        // tab-switch/blur for a few seconds: Chrome shows the "sharing your screen" bar right
        // after the picker closes, and interacting with it (including the "Hide" button) blurs
        // the exam tab through no fault of the candidate.
        window.setTimeout(() => { permissionDialogOpenRef.current = false; }, 500);
        suppressTabViolationsFor(6000);
      }
      const track = screenStream.getVideoTracks()[0];
      // Enforce "entire screen, not a window/tab": browsers that report displaySurface
      // (Chrome/Edge) tell us exactly what the candidate picked. If it's a window or a browser
      // tab, reject it immediately — sharing a tab would let them keep other material on-screen
      // just outside the shared area and would only record a sliver of the desktop.
      const settings = track?.getSettings ? (track.getSettings() as MediaTrackSettings & { displaySurface?: string }) : undefined;
      if (settings?.displaySurface && settings.displaySurface !== 'monitor') {
        screenStream.getTracks().forEach(t => { try { t.stop(); } catch {} });
        throw new WrongDisplaySurfaceError();
      }
      setTrackContentHint(track, 'detail');
      if (track) {
        track.onended = () => {
          // Screen sharing is compulsory — if it stops mid-exam, block the exam.
          if (!finishOnceRef.current) {
            screenStreamRef.current = null;
            setScreenShareStatus('denied');
            setStreamLost(true);
            triggerProctorFeedback('NO_FACE', 'Screen sharing was stopped. Please re-share your screen to continue.', { bypassActive: true });
          }
        };
      }
      screenStreamRef.current = screenStream;
      return screenStream;
    })();

    screenCaptureInFlightRef.current = request;
    try {
      return await request;
    } finally {
      screenCaptureInFlightRef.current = null;
    }
  };

  // Acquire the exam devices WITHOUT letting one device's failure take down the other.
  //
  // A single getUserMedia({video, audio}) is ATOMIC: on a machine with no microphone (ordinary on
  // desktops) it rejects with NotFoundError and the CAMERA is never acquired either — so a webcam
  // that was present, working and about to be allowed came out the other side looking "blocked".
  // Same story when the mic is held by another app. The camera is the primary evidence stream and
  // must survive a missing mic.
  const acquireExamStream = async (): Promise<MediaStream> => {
    // Happy path: ask for both together so the browser shows ONE prompt, not two.
    if (cameraCaptureRequired && microphoneCaptureRequired) {
      try {
        return await navigator.mediaDevices.getUserMedia({ video: CAMERA_CONSTRAINTS, audio: MIC_CONSTRAINTS });
      } catch (err) {
        if (classifyMediaError(err) === 'denied') throw err;
      }
    }

    const tracks: MediaStreamTrack[] = [];
    let cameraError: unknown = null;

    if (cameraCaptureRequired) {
      try {
        const cam = await navigator.mediaDevices.getUserMedia({ video: CAMERA_CONSTRAINTS });
        tracks.push(...cam.getTracks());
      } catch (err) {
        if (classifyMediaError(err) === 'denied') throw err;
        try {
          const cam = await navigator.mediaDevices.getUserMedia({ video: true });
          tracks.push(...cam.getTracks());
        } catch (retryErr) {
          cameraError = retryErr;
        }
      }
    }

    if (microphoneCaptureRequired) {
      try {
        const mic = await navigator.mediaDevices.getUserMedia({ audio: MIC_CONSTRAINTS });
        tracks.push(...mic.getTracks());
        setMicUnavailable(false);
      } catch (err) {
        // Microphone is compulsory — deny the exam if mic is missing, busy, or blocked. Stop any
        // camera track already acquired above first — it's local to `tracks` and never reaches
        // requestAllPermissions()'s stream, so nothing else will release it; left running, it
        // keeps the camera light on and can make the next retry see the camera as busy/self-locked.
        tracks.forEach(track => { try { track.stop(); } catch {} });
        throw err;
      }
    }

    if (cameraCaptureRequired && !tracks.some(t => t.kind === 'video')) {
      throw cameraError ?? new Error('NO_CAMERA');
    }
    return new MediaStream(tracks);
  };

  const requestAllPermissions = async () => {
    // Suppress violations while browser permission dialogs are open.
    permissionDialogOpenRef.current = true;
    let stream: MediaStream;
    try {
      stream = await acquireExamStream();
      setMediaProblem(null);
    } catch (err) {
      setMediaProblem(classifyMediaError(err));
      // Bailing out here — no screen-share prompt will follow to take ownership of the flag, so
      // this catch path must always clear it itself (unlike the success path below).
      window.setTimeout(() => { permissionDialogOpenRef.current = false; }, 300);
      suppressTabViolationsFor(6000);
      throw err;
    }
    // If a screen-share prompt is about to follow, leave permissionDialogOpenRef alone —
    // requestScreenCapture() below re-sets it true and owns clearing it itself. Clearing it
    // here on a fixed 300ms timer would otherwise race an OS screen-picker that's still open
    // (candidates can take longer than that to choose), clobbering the flag mid-dialog and
    // letting a real TAB_SWITCH/FULLSCREEN_EXIT fire while they're still picking a screen.
    if (!screenCaptureRequired) {
      window.setTimeout(() => { permissionDialogOpenRef.current = false; }, 300);
    }
    suppressTabViolationsFor(6000);
    setTrackContentHint(stream.getVideoTracks()[0], 'motion');
    setTrackContentHint(stream.getAudioTracks()[0], 'speech');

    // Screen share is compulsory on desktop. Request it here (before the exam starts) so the
    // student sees the picker and can grant/deny it up-front. The stream is stored in
    // screenStreamRef and reused by startRecordingPipeline() — the picker opens exactly once.
    if (screenCaptureRequired) {
      let screenStream: MediaStream | null = null;
      try {
        screenStream = await requestScreenCapture();
      } catch (err) {
        setScreenShareStatus('denied');
        setMediaProblem(classifyMediaError(err));
        // The camera/mic stream acquired above is otherwise never released on this path (it's
        // local to this call and was never stored in streamRef) — orphaned tracks would keep the
        // camera light on and, on retry, can make the next getUserMedia() see the device as busy.
        stream.getTracks().forEach(track => { try { track.stop(); } catch {} });
        throw err;
      }
      if (screenStream) {
        setScreenShareStatus('granted');
      } else {
        setScreenShareStatus('denied');
        stream.getTracks().forEach(track => { try { track.stop(); } catch {} });
        throw new Error('Screen share is required but was not granted.');
      }
    }

    // Attach track.onended handlers on primary camera/mic tracks to detect mid-exam revocation.
    const attachLostHandlers = (s: MediaStream) => {
      s.getTracks().forEach(track => {
        track.onended = () => {
          if (!finishOnceRef.current) {
            setStreamLost(true);
            triggerProctorFeedback('NO_FACE', `${track.kind === 'video' ? 'Camera' : 'Microphone'} was disconnected. Please reconnect and refresh.`, { bypassActive: true });
          }
        };
      });
    };
    attachLostHandlers(stream);

    await applyStream(stream);
  };

  const startRecordingPipeline = async () => {
    if (!recordingEnabled) return;
    if (recordingStartedRef.current) return;
    if (!streamRef.current) return;
    recordingStartedRef.current = true;
    recordingCompleteSentRef.current = false;
    recordingStartTsRef.current = Date.now();
    uploadSeqRef.current = { camera: 0, screen: 0, combined: 0 };
    uploadChainRef.current = { camera: Promise.resolve(), screen: Promise.resolve(), combined: Promise.resolve() };

    try {
      const init = await apiPost<{ ok: boolean; recordingId?: number }>('recordings.php', {
        action: 'INIT',
        examId: exam.id,
        studentId: student.id,
        sessionId: sessionId ?? null,
      });
      if (!init?.recordingId) {
        recordingStartedRef.current = false;
        return;
      }
      recordingSessionIdRef.current = init.recordingId;
    } catch (e) {
      console.error('Failed to initialize recording session:', e);
      recordingStartedRef.current = false;
      return;
    }

    const cameraSource = streamRef.current;
    createRecorder('camera', cameraSource, { videoBitsPerSecond: 650000, audioBitsPerSecond: 32000 });

    // Mobile / iOS: screen capture is unavailable. The camera recorder above already
    // captures the candidate's video + microphone, which is enough for proctoring, so we
    // stop here rather than blocking the exam on an impossible screen-share.
    if (!screenRecordingEnabled) {
      return;
    }

    // Screen share was already acquired during requestAllPermissions(). If it's missing here
    // (shouldn't happen), the exam must stop — screen recording is compulsory on desktop.
    const screenStream: MediaStream | null = screenStreamRef.current;
    if (!screenStream) {
      console.error('Screen share stream missing — compulsory screen recording cannot proceed.');
      setScreenShareStatus('denied');
      setStreamLost(true);
      return;
    }
    createRecorder('screen', screenStream, { videoBitsPerSecond: 900000 });

    // Attach compositor video elements to the DOM (display:none) so all browsers decode them.
    // Detached elements work in Chrome but may silently fail in Firefox/Safari.
    const baseVideo = document.createElement('video');
    const camVideo = document.createElement('video');
    baseVideo.muted = true;
    camVideo.muted = true;
    baseVideo.playsInline = true;
    camVideo.playsInline = true;
    baseVideo.setAttribute('playsinline', '');
    camVideo.setAttribute('playsinline', '');
    Object.assign(baseVideo.style, { position: 'fixed', top: '-9999px', left: '-9999px', width: '1px', height: '1px', opacity: '0', pointerEvents: 'none' });
    Object.assign(camVideo.style, { position: 'fixed', top: '-9999px', left: '-9999px', width: '1px', height: '1px', opacity: '0', pointerEvents: 'none' });
    document.body.appendChild(baseVideo);
    document.body.appendChild(camVideo);
    compositorVideosRef.current = { base: baseVideo, cam: camVideo };

    baseVideo.srcObject = screenStream || cameraSource;
    camVideo.srcObject = cameraSource;
    await baseVideo.play().catch(() => {});
    await camVideo.play().catch(() => {});

    const screenTrackSettings = screenStream.getVideoTracks()[0]?.getSettings?.();
    const sourceWidth = Number(screenTrackSettings?.width) || 1280;
    const sourceHeight = Number(screenTrackSettings?.height) || 720;
    const targetWidth = Math.min(1600, Math.max(960, sourceWidth));
    const targetHeight = Math.round(targetWidth * (sourceHeight / Math.max(1, sourceWidth)));

    const canvas = document.createElement('canvas');
    canvas.width = targetWidth;
    canvas.height = targetHeight;
    combinedCanvasRef.current = canvas;
    const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true } as any) as CanvasRenderingContext2D | null;
    if (ctx) {
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      const TARGET_FRAME_MS = 1000 / 15; // 15 fps
      const draw = () => {
        ctx.fillStyle = '#0f172a';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        try {
          if (baseVideo.readyState >= 2) ctx.drawImage(baseVideo, 0, 0, canvas.width, canvas.height);
        } catch { /* ignore decode errors */ }
        const w = Math.round(canvas.width * 0.2);
        const h = Math.round(w * 0.7);
        const pad = Math.max(16, Math.round(canvas.width * 0.018));
        const x = canvas.width - w - pad;
        const y = canvas.height - h - pad;
        ctx.fillStyle = 'rgba(15,23,42,0.6)';
        ctx.fillRect(x - 4, y - 4, w + 8, h + 8);
        try {
          if (camVideo.readyState >= 2) ctx.drawImage(camVideo, x, y, w, h);
        } catch { /* ignore decode errors */ }
      };
      // Use setInterval instead of requestAnimationFrame so the compositor keeps running
      // at full speed even when the exam tab is hidden (tab-switch violations etc).
      compositorIntervalRef.current = setInterval(draw, TARGET_FRAME_MS);
    }

    const combined = canvas.captureStream(15);
    const micTrack = cameraSource.getAudioTracks()[0];
    if (micTrack) {
      combined.addTrack(micTrack);
    }
    combinedStreamRef.current = combined;
    setTrackContentHint(combined.getVideoTracks()[0], 'detail');
    createRecorder('combined', combined, { videoBitsPerSecond: 1200000, audioBitsPerSecond: 32000 });
  };

  const requestFullscreen = async () => {
    const el = document.documentElement as any;
    const req = el.requestFullscreen || el.webkitRequestFullscreen || el.msRequestFullscreen;
    if (!req) {
      setFullscreenBlocked(true);
      return false;
    }
    try {
      await req.call(el);
      setFullscreenBlocked(false);
      return true;
    } catch {
      setFullscreenBlocked(true);
      return false;
    }
  };

  const applyStream = async (stream: MediaStream) => {
    streamRef.current = stream;
    setPermissionStatus('granted');

    if (videoRef.current) {
      videoRef.current.srcObject = stream;
    }

    // Dedicated always-mounted, always-decoding camera element for detection + live snapshots.
    // The visible preview can be display:none (mobile tools panel collapsed) or throttled, which
    // freezes canvas draws — so both AI detection and the proctor-wall thumbnail would stall on a
    // stale frame. This off-screen element is never hidden via display:none, so it keeps decoding.
    if (!detectionVideoRef.current) {
      const dv = document.createElement('video');
      dv.muted = true;
      dv.playsInline = true;
      dv.setAttribute('playsinline', '');
      dv.autoplay = true;
      Object.assign(dv.style, { position: 'fixed', top: '-9999px', left: '-9999px', width: '2px', height: '2px', opacity: '0', pointerEvents: 'none' });
      document.body.appendChild(dv);
      detectionVideoRef.current = dv;
    }
    detectionVideoRef.current.srcObject = stream;
    await detectionVideoRef.current.play().catch(() => {});

    // Only wire the audio graph when a mic track actually exists: createMediaStreamSource() THROWS
    // on a stream with no audio track, and that throw used to surface as a permission failure —
    // so a candidate with a working, allowed camera but no mic was shown "Permissions Blocked".
    if (exam.proctoringConfig.microphoneRequired && stream.getAudioTracks().length > 0) {
      const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
      audioContextRef.current = audioContext;
      await audioContext.resume().catch(() => {});
      // ROOT CAUSE of "audio never fires on any platform": an AudioContext created outside a user
      // gesture (desktop proctoring auto-starts on mount) — or one whose gesture was consumed by
      // the permission grant (iOS Safari) — starts 'suspended'. A suspended context feeds the
      // analyser pure silence (samples pinned at 128 → rms 0), so no threshold could ever trip.
      // Re-arm it on EVERY interaction (kept installed for the whole exam, since hiding/showing the
      // tab or a phone lock can re-suspend it). The detect loop also retries resume each frame.
      const resumeAudioContext = () => { audioContext.resume().catch(() => {}); };
      const resumeEvents = ['touchstart', 'touchend', 'pointerdown', 'click', 'keydown'];
      resumeEvents.forEach(evt => document.addEventListener(evt, resumeAudioContext, { passive: true }));
      audioResumeCleanupRef.current = () => {
        resumeEvents.forEach(evt => document.removeEventListener(evt, resumeAudioContext));
        audioResumeCleanupRef.current = null;
      };
      const analyser = audioContext.createAnalyser();
      const microphone = audioContext.createMediaStreamSource(stream);

      analyser.smoothingTimeConstant = 0.72;
      analyser.fftSize = 2048;

      microphone.connect(analyser);

      // ── Primary voice detector: Silero VAD (pretrained neural model) ──────────
      // Reuses this same mic stream. If it loads, it becomes the authority on "is a human talking
      // right now" and the spectral loop below only feeds the level meter; if it fails to load
      // (unsupported browser / blocked wasm) we fall back to the spectral signal for that same
      // decision. Either way, the ACTUAL violation only fires once voice has been active for
      // AUDIO_GRACE_MS continuously (see detectAudio below) — matching the same timer-based model
      // used for GAZE_AWAY, and configurable via Settings > Exam defaults (audioSeconds).
      const fireVoiceViolation = (source: 'model' | 'spectral') => {
        const lips = liveStatusRef.current.mouthOpen;
        triggerProctorFeedback(
          'AUDIO_DETECTED',
          'Talking or conversation detected near the microphone. Please maintain silence.',
          {
            confidence: lips ? 0.92 : (source === 'model' ? 0.88 : 0.82),
            metadata: {
              severity: 'medium',
              level: audioLevelRef.current,
              detector: source,
              event: lips ? 'speech_with_lip_movement' : 'voice_activity',
            },
          }
        );
      };
      void startVoiceVad(stream, {
        onSpeechConfirmed: () => { vadSpeechActiveRef.current = true; },
        onSpeechEnd: () => { vadSpeechActiveRef.current = false; },
      }, audioContext)
        .then(handle => {
          voiceVadRef.current = handle;
          vadModelActiveRef.current = true;
        })
        .catch(err => {
          vadModelActiveRef.current = false;
          console.warn('Voice VAD model unavailable — using spectral fallback.', err);
        });

      const dataArray = new Uint8Array(analyser.fftSize);
      const frequencyData = new Uint8Array(analyser.frequencyBinCount);
      const detectAudio = () => {
        // Safety net: until the context is actually running the analyser only returns silence, so
        // keep retrying resume and don't score this frame (prevents a suspended context from
        // silently disabling audio proctoring for the whole exam).
        if (audioContext.state !== 'running') {
          audioContext.resume().catch(() => {});
          setMicStatusOnce('suspended');
          audioRafRef.current = window.requestAnimationFrame(detectAudio);
          return;
        }
        setMicStatusOnce('listening');
        const now = performance.now();
        if ((now - audioAnalysisFrameRef.current) < 120) {
          audioRafRef.current = window.requestAnimationFrame(detectAudio);
          return;
        }
        audioAnalysisFrameRef.current = now;

        analyser.getByteTimeDomainData(dataArray);
        analyser.getByteFrequencyData(frequencyData);

        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) {
          const v = (dataArray[i] - 128) / 128;
          sum += v * v;
        }
        const rms = Math.sqrt(sum / dataArray.length);
        // Human-voice discrimination bands (Hz). Speech energy concentrates in the formant band
        // (~300–3400 Hz, the classic telephone band); fans / AC / traffic sit as low-frequency
        // rumble; keyboard clatter and hiss sit high. Comparing the bands lets us separate a human
        // voice from steady background noise instead of just reacting to "loudness".
        const voiceEnergy = getBandEnergy(frequencyData, audioContext.sampleRate, analyser.fftSize, 300, 3400);

        // Sum-based (see getBandEnergySum) so these ratios are properly bounded to [0, 1] — the
        // mean-based version above let a concentrated band's ratio read well over 1.0, which never
        // satisfied the <0.5 / <0.45 rejection bars no matter how voice-like the sound actually was.
        const voiceSum = getBandEnergySum(frequencyData, audioContext.sampleRate, analyser.fftSize, 300, 3400);
        const lowSum   = getBandEnergySum(frequencyData, audioContext.sampleRate, analyser.fftSize, 20, 250);
        const highSum  = getBandEnergySum(frequencyData, audioContext.sampleRate, analyser.fftSize, 3400, 8000);
        const totalSum = getBandEnergySum(frequencyData, audioContext.sampleRate, analyser.fftSize, 20, 8000);

        const voiceBandRatio = voiceSum / Math.max(totalSum, 0.0001); // formant concentration
        const lowRatio       = lowSum   / Math.max(totalSum, 0.0001); // hum / rumble dominance
        const highRatio      = highSum  / Math.max(totalSum, 0.0001); // hiss / click dominance

        const level = Math.min(100, Math.round((rms * 160) + (voiceEnergy * 55)));
        setAudioLevel(level);
        audioLevelRef.current = level;

        const profile = audioProfileRef.current;
        const nowMs = Date.now();

        // Initialise calibration window on first frame.
        if (profile.calibrationEndAt === 0) {
          profile.calibrationEndAt = nowMs + 2500; // brief ambient calibration so audio arms fast
        }

        // ── Adaptive noise floor ──────────────────────────────────────────────
        // A single fixed threshold can't work across a silent library and a humming café.
        // Instead we LEARN the room's baseline RMS and flag sound that rises clearly above it.
        // Critically, the floor is only updated on QUIET frames, so a person talking can never
        // inflate the baseline and mask themselves (the old EMA-every-frame bug that let sustained
        // talking "become the new normal").
        // Raw capture (DSP off, no auto-gain) means quiet laptop mics deliver speech at a much
        // lower absolute RMS than a processed stream — a 0.02 hard floor silently swallowed all
        // speech on such mics (audio violations never fired). Keep the floor just above sensor
        // noise and lean on the ADAPTIVE ambient multiple instead.
        // Raw (DSP-off) laptop mics deliver speech at a low absolute RMS, so an aggressive floor
        // silently swallowed all talking (AUDIO_DETECTED had literally never fired). Keep the floor
        // just above sensor noise and lean on the adaptive ambient multiple.
        const loudThreshold = Math.max(0.009, profile.ambientRms * 1.6);
        const isLoud = rms > loudThreshold;

        if (!isLoud) {
          // Track the room: quick to settle, but clamped so it can't drift unrealistically.
          profile.ambientRms = (profile.ambientRms * 0.95) + (rms * 0.05);
        }
        profile.ambientRms = Math.min(0.15, Math.max(0.006, profile.ambientRms));

        // Speech envelope modulates at the syllabic rate (~3–8 Hz); a fan / AC / hum is steady.
        // Track how much the voice-band energy fluctuates frame-to-frame: near zero for a tone,
        // clearly non-zero for real speech. This is what rejects a loud-but-steady mid-band noise.
        const flux = Math.abs(voiceEnergy - profile.prevVoiceEnergy);
        profile.prevVoiceEnergy = voiceEnergy;
        profile.fluxEma = profile.fluxEma * 0.9 + flux * 0.1;
        const modulated = profile.fluxEma > 0.004;

        // During the calibration window we only learn the room; never fire.
        const inCalibration = nowMs < profile.calibrationEndAt;

        // ── HARD human-voice gate ─────────────────────────────────────────────
        // Every condition must hold, so background noise (fan, AC, traffic rumble, keyboard
        // clatter, general room hiss) can NEVER raise a violation. Only sound that is:
        //   (a) clearly above the learned room floor,
        //   (b) carrying real energy in the human formant band,
        //   (c) concentrated there (voice-shaped, not rumble- or hiss-dominated), and
        //   (d) modulating like a speech envelope (not a steady tone)
        // is treated as a human voice.
        const isVoice =
          isLoud &&
          voiceEnergy > 0.03 &&
          voiceBandRatio > 0.42 &&
          lowRatio < 0.5 &&
          highRatio < 0.45 &&
          modulated;

        // Camera fusion: if the AI sees the candidate's lips moving AND the mic carries voice-band
        // sound, that's talking — accept a slightly softer acoustic bar since vision confirms it.
        const voicePresent = isLoud && voiceEnergy > 0.025 && voiceBandRatio > 0.35 && lowRatio < 0.6;
        const lipsMoving = !inCalibration && voicePresent && liveStatusRef.current.mouthOpen;

        // Voice-only scoring. A human-voice frame accrues (double when vision confirms lips moving);
        // anything else — including loud steady noise — decays the counter. This is a smoothing
        // signal only now (used below to decide "is voice active right now"), not the fire decision
        // itself — see the sustained-duration timer that follows.
        if (!inCalibration && (isVoice || lipsMoving)) {
          profile.voiceStrikes = Math.min(40, profile.voiceStrikes + (lipsMoving ? 2 : 1));
        } else {
          profile.voiceStrikes = Math.max(0, profile.voiceStrikes - 1);
        }


        // ── Sustained-duration gate (mirrors GAZE_AWAY) ───────────────────────
        // "Is a human voice active RIGHT NOW" — the VAD model's confirmed-speech signal OR the
        // spectral signal, whichever says yes. Deliberately NOT exclusive: if the VAD model loads
        // (vadModelActiveRef becomes true) but then silently fails to ever confirm real speech
        // (bad wasm load, threshold mismatch, a worklet error swallowed inside the library — this is
        // exactly what made AUDIO_DETECTED go completely silent in production once VAD was
        // introduced), the spectral signal keeps working as a safety net instead of being locked out.
        // The model only classifies voice vs. non-voice — it has no concept of loudness, so on its
        // own it will happily confirm a distant/background conversation bleeding into the mic. Gate
        // it on `isLoud` (current frame clearly above the learned ambient floor) too, so only voice
        // that is actually loud near THIS mic — not quiet background talk — counts. The spectral
        // strike counter already bakes `isLoud` into `isVoice`, so it needs no extra gate here.
        //
        // Neither signal above can tell "the candidate is talking" apart from "a TV/video call is
        // playing nearby" — both are acoustically real human speech. The one thing that CAN tell
        // them apart is our own camera: the candidate's mouth actually moving. So whenever a single
        // face is currently tracked, also require the AI face read to have seen the mouth open
        // recently (a window comfortably wider than the ~0.5–2s AI tick cadence, so normal talking
        // is never missed just because it fell between two frames). With no face tracked we can't
        // do any better, so audio-only stays the fallback.
        const faceTracked = liveStatusRef.current.faceCount === 1;
        const recentLipActivity = (nowMs - lastMouthOpenAtRef.current) < 4000;
        const lipsCorroborate = !faceTracked || recentLipActivity;
        const voiceNow = !inCalibration && lipsCorroborate && ((vadSpeechActiveRef.current && isLoud) || profile.voiceStrikes >= 3);

        if (voiceNow) {
          voiceActiveLastSeenRef.current = nowMs;
          if (!voiceActiveStartRef.current) voiceActiveStartRef.current = nowMs;
          if ((nowMs - voiceActiveStartRef.current) >= AUDIO_GRACE_MS) {
            fireVoiceViolation(vadSpeechActiveRef.current ? 'model' : 'spectral');
            voiceActiveStartRef.current = nowMs; // re-arm — keeps re-firing every AUDIO_GRACE_MS while talking continues
          }
        } else if (voiceActiveStartRef.current
                   && (nowMs - voiceActiveLastSeenRef.current) >= AUDIO_OFF_FLICKER_TOLERANCE_MS) {
          // Only reset once "quiet" has itself held for a moment — a brief pause between words/
          // syllables (which is normal mid-sentence) no longer wipes the accumulated timer.
          voiceActiveStartRef.current = null;
        }

        audioRafRef.current = window.requestAnimationFrame(detectAudio);
      };

      audioAnalysisFrameRef.current = 0;
      audioRafRef.current = window.requestAnimationFrame(detectAudio);
    }

    if (fullscreenEnforced) {
      await requestFullscreen();
    }
  };

  // 1. Proctoring Setup (Camera, Microphone, Screen)
  useEffect(() => {
    const startProctoring = async () => {
      try {
        // The candidate's device class isn't permitted for this exam — never request devices or
        // start proctoring; the block screen is shown instead.
        if (deviceBlocked) {
          return;
        }
        // Wait for the candidate to click through the pre-permission walkthrough — the browser's
        // own permission prompt must never be the first thing they see.
        if (!introDone) {
          return;
        }
        if (!permissionsRequired) {
          setPermissionStatus('granted');
          return;
        }

        // Mobile/iOS browsers (Safari especially) only grant getUserMedia from a user
        // gesture — an auto-request on mount silently fails and looks like a denial.
        // Leave the status 'pending' so the PermissionGuide's button drives the request.
        if (device.isMobile) {
          return;
        }

        await requestAllPermissions();

      } catch (err) {
        // Don't log a violation here — the exam hasn't started yet (permissionStatus never
        // reached 'granted'), so this is just a failed/cancelled permission prompt on first load
        // (wrong screen surface picked, camera briefly busy, an accidental Cancel). The
        // PermissionGuide screen already explains what went wrong and lets the candidate retry;
        // logging a strike here would penalize candidates for a browser dialog, not exam conduct.
        console.error("Proctoring failed to start", err);
        setMediaProblem(classifyMediaError(err));
        setPermissionStatus('denied');
      }
    };

    startProctoring();

    return () => {
        void shutdownExamCapture('FAILED');
    };
  }, [exam, introDone]);

  useEffect(() => {
    if (permissionStatus !== 'granted') return;
    void startRecordingPipeline();
  }, [permissionStatus]);

  useEffect(() => {
    // Arm proctoring as soon as capture permissions are granted and the screen is valid.
    // Identity enrollment is NOT a prerequisite — face-presence / gaze / multi-face / phone /
    // object / AUDIO violations must work for every candidate. Identity matching is layered on
    // once an SFace template exists (already on file, or auto-enrolled from the first clear frame).
    if (permissionStatus === 'granted' && !fullscreenBlocked) {
      proctoringArmedRef.current = true;
      // Reset proctor timers so stale pre-exam state doesn't fire immediately
      faceAbsenceStartRef.current = null;
      gazeAwayStartRef.current    = null;
      gazeAwayLastSeenRef.current = 0;
      multiFaceStartRef.current   = null;
      voiceActiveStartRef.current = null;
      voiceActiveLastSeenRef.current = 0;
      lastMouthOpenAtRef.current = 0;
    }
  }, [permissionStatus, fullscreenBlocked]);

  useEffect(() => {
    if (permissionStatus !== 'granted') return;
    faceSignalRef.current.lastFaceSeenAt = Date.now();
    faceSignalRef.current.noFaceStrikes = 0;
    faceSignalRef.current.multiFaceStrikes = 0;
    faceSignalRef.current.gazeAwayStrikes = 0;
    objectSignalRef.current.phoneHits = 0;
    objectSignalRef.current.anomalyHits = 0;
    audioProfileRef.current = {
      ambientRms: 0.018,
      ambientSpeechRatio: 0.22,
      voiceStrikes: 0,
      conversationStrikes: 0,
      noiseStrikes: 0,
      lastSpeechAt: 0,
      calibrationEndAt: 0,
      prevVoiceEnergy: 0,
      fluxEma: 0,
    };
  }, [permissionStatus]);

  // Fullscreen prompt when required
  useEffect(() => {
    if (!fullscreenEnforced) {
      setFullscreenBlocked(false);
      return;
    }
    if (permissionStatus !== 'granted') return;
    if (!document.fullscreenElement) {
      setFullscreenBlocked(true);
    }
  }, [permissionStatus, fullscreenEnforced]);

  // Fullscreen enforcement
  useEffect(() => {
    if (!fullscreenEnforced) return;
    const onFsChange = () => {
      const inFs = !!document.fullscreenElement;
      if (!inFs) {
        setFullscreenBlocked(true);
        // Never flag while a browser permission/screen-picker dialog is open, or during its
        // grace window — showing certain prompts (notably the getDisplayMedia screen picker,
        // e.g. on a re-share after a wrong-surface rejection) can auto-drop fullscreen in
        // Chrome/Edge with zero user intent. Re-confirm fullscreen is still out a moment later,
        // mirroring the tab-switch handlers below, so a one-tick blip isn't logged.
        if (fullscreenExitConfirmTimeoutRef.current !== null) {
          window.clearTimeout(fullscreenExitConfirmTimeoutRef.current);
        }
        if (!finishingRef.current && !isChromeInducedEvent()) {
          // Debounced: rapid exit/re-enter flicker (an external-monitor dialog, a driver hiccup)
          // would otherwise stack an independent confirm timer per flicker; only the latest one
          // scheduled above survives (the clearTimeout right above cancels any prior pending check).
          fullscreenExitConfirmTimeoutRef.current = window.setTimeout(() => {
            fullscreenExitConfirmTimeoutRef.current = null;
            if (finishingRef.current || isChromeInducedEvent()) return;
            if (document.fullscreenElement) return;
            triggerProctorFeedback('FULLSCREEN_EXIT', 'Fullscreen exited. Please return to fullscreen.');
          }, 600);
        }
      } else {
        if (fullscreenExitConfirmTimeoutRef.current !== null) {
          window.clearTimeout(fullscreenExitConfirmTimeoutRef.current);
          fullscreenExitConfirmTimeoutRef.current = null;
        }
        setFullscreenBlocked(false);
        finishingRef.current = false;
      }
    };
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  }, [fullscreenEnforced]);

  // External display detection (best effort)

  useEffect(() => {
    if (permissionStatus !== 'granted' || !sessionId || !navigator.geolocation) return;
    let lastSentAt = 0;
    let cancelled = false;

    const postLocation = (position: GeolocationPosition) => {
      const now = Date.now();
      if (now - lastSentAt < 45000 || cancelled) return;
      lastSentAt = now;
      const lat = Number(position.coords.latitude.toFixed(6));
      const lng = Number(position.coords.longitude.toFixed(6));
      const accuracy = Math.round(position.coords.accuracy || 0);
      apiPost<{ flagged?: boolean; distanceFromStartM?: number | null }>('sessions.php', {
        action: 'location',
        sessionId,
        examId: exam.id,
        studentId: student.id,
        geoLocation: {
          label: `${lat}, ${lng} (${accuracy}m accuracy)`,
          lat,
          lng,
          accuracy,
        },
      }).then(result => {
        if (result?.flagged) {
          triggerProctorFeedback(
            'LOCATION_CHANGE',
            `Suspicious location movement detected (${result.distanceFromStartM ?? 'unknown'}m from exam start).`,
            {
              confidence: 0.82,
              metadata: {
                distanceFromStartM: result.distanceFromStartM ?? null,
                accuracyM: accuracy,
                lat,
                lng,
              }
            }
          );
        }
      }).catch(() => {});
    };

    const watchId = navigator.geolocation.watchPosition(
      postLocation,
      () => {},
      { enableHighAccuracy: true, maximumAge: 30000, timeout: 10000 }
    );

    return () => {
      cancelled = true;
      navigator.geolocation.clearWatch(watchId);
    };
  }, [permissionStatus, sessionId, exam.id, student.id]);

  // 1b. Load face-api.js models + BlazeFace fallback, then start the detection loop.
  useEffect(() => {
    if (permissionStatus !== 'granted' || !exam.proctoringConfig.cameraRequired) return;
    let cancelled = false;

    // Python AI (MediaPipe) is the ONLY detection engine — no browser-side fallback models.
    // Arm the proctoring loop once the service health check resolves.
    const setup = async () => {
      const available = await checkAiService();
      if (cancelled) return;
      aiServiceAvailableRef.current = available;
      console.info(`Proctor AI service: ${available ? 'online' : 'offline'}`);
      if (!available) {
        console.warn('Proctor AI service offline — proctoring cannot arm. Detection is server-side only.');
      }
      setFaceMlReady(true); // arm the loop; the tick no-ops while the AI service is offline
      console.info('Proctoring detection ready (Python AI only).');
    };

    setup();

    // A one-time "offline" verdict must not silence detection for the rest of the exam — keep
    // probing until the service actually answers healthy, so a transient blip at exam start
    // (e.g. a mobile network hiccup right as camera permission is granted) self-heals instead of
    // leaving the whole session unmonitored.
    const retryTimer = window.setInterval(async () => {
      if (cancelled || aiServiceAvailableRef.current) return;
      const available = await checkAiService();
      if (cancelled || !available) return;
      aiServiceAvailableRef.current = true;
      console.info('Proctor AI service back online — proctoring resumed.');
    }, 20000);

    return () => { cancelled = true; window.clearInterval(retryTimer); };
  }, [permissionStatus, exam.proctoringConfig.cameraRequired]);

  // 1c. Main proctoring detection loop — runs like a human proctor watching the student.
  //
  // Detection engine: Python AI (MediaPipe Tasks) ONLY — no browser-side fallback.
  //   /analyze returns faceCount, lookingAway (head-pose gaze), headYaw, phoneDetected,
  //   anomalyObjects[] (book/laptop/tv), and identityMatch in a single server-side call.
  //
  // Violation logic: timer-based grace periods, not frame counters.
  //   A proctor watching a video doesn't flag a 0.5-second glance — they flag sustained behaviour.
  useEffect(() => {
    if (permissionStatus !== 'granted' || !exam.proctoringConfig.cameraRequired || !faceMlReady) return;
    let cancelled = false;
    let tickRunning = false; // guard against concurrent inferences

    const tick = async () => {
      if (tickRunning || cancelled) return;
      tickRunning = true;
      try {
        const videoEl = getProctorVideo();
        if (!videoEl || videoEl.readyState < 2 || videoEl.videoWidth < 60 || videoEl.videoHeight < 60) return;

        const now = Date.now();
        let faceCount: number | null = null;
        let gazeAway  = false;
        let headYaw   = 0;

        // ── Python AI (MediaPipe) — the sole detection engine. Server-side, reliable across
        // all browsers/devices. Drives face count, head-pose gaze, phone, study-material/
        // second-device, and identity in one call.
        if (aiServiceAvailableRef.current !== false) {
          const aiSessionKey = sessionId ? `${exam.id}-${student.id}-${sessionId}` : `${exam.id}-${student.id}`;
          try {
            const result = await analyzeFrame(videoEl, aiEnrolledDescriptorRef.current, aiSessionKey);
            if (result) {
              faceCount = result.faceCount;
              gazeAway  = !!result.lookingAway;        // accurate MediaPipe head-pose + eye-tracking
              headYaw   = Number(result.headYaw ?? 0);
              // Feed the live proctor wall with the richest current status (v6/v7 signals).
              liveStatusRef.current = {
                faceCount,
                gazeAway,
                eyesClosed: !!result.eyesClosed,
                mouthOpen: !!result.mouthOpen,
                phone: !!result.phoneDetected,
                multipleFaces: (faceCount ?? 0) >= 2,
                riskScore: typeof result.proctor?.risk === 'number' ? result.proctor.risk : null,
                riskLevel: result.proctor?.level ?? null,
                aiNote: result.proctor?.note ?? null,
              };
              if (result.mouthOpen) lastMouthOpenAtRef.current = now;
              if (result.phoneDetected)
                triggerProctorFeedback('PHONE_DETECTED', 'A mobile phone was detected in the camera frame. Please remove it.', { confidence: 0.9, metadata: { severity: 'high' } });
              if (Array.isArray(result.anomalyObjects) && result.anomalyObjects.length > 0) {
                const labels = Array.from(new Set(result.anomalyObjects.map(o => o.label))).join(', ');
                triggerProctorFeedback('ANOMALY_OBJECT', `Unauthorized item detected in frame: ${labels}. Please remove it.`, {
                  confidence: Math.max(...result.anomalyObjects.map(o => Number(o.score) || 0.6)),
                  metadata: { severity: 'medium', objects: result.anomalyObjects },
                });
              }
              if (result.identityMatch === false && !faceRecognitionActiveRef.current
                  && Date.now() >= identityWarmUntilRef.current)
                triggerProctorFeedback('IDENTITY_CHANGE', 'The person on camera may not match the enrolled student.', { confidence: 0.85, metadata: { severity: 'high' } });
              // v7 virtual-proctor pattern findings (repeated glances, talking alone, phone after
              // look-down, extended absence). The server reasons over minutes of behaviour and
              // already rate-limits per pattern — record each as evidence with its narrative.
              if (Array.isArray(result.violations)) {
                for (const v of result.violations) {
                  if (v?.type === 'SUSPICIOUS_BEHAVIOR' && v.description) {
                    triggerProctorFeedback('SUSPICIOUS_BEHAVIOR', v.description, {
                      confidence: Number(v.confidence) || 0.8,
                      metadata: (v.metadata as Record<string, any>) || { severity: 'medium' },
                    });
                  }
                }
              }
            }
          } catch {
            // Transient AI error this frame — skip; the next tick retries.
          }
        }

      // ── No reading from the AI this frame (offline or transient error) — skip ─
      if (faceCount === null) return;

      // Surface live signals to the UI (only when they change, to avoid needless re-renders).
      const prevLive = proctorLiveRef.current;
      if (prevLive.faceCount !== faceCount || prevLive.gazeAway !== gazeAway) {
        const next = { faceCount, gazeAway };
        proctorLiveRef.current = next;
        setProctorLive(next);
      }

      // ── Silent identity auto-enrollment ──────────────────────────────────────
      // Capture an SFace template from the first clear, centred, single-face frame so identity
      // matching works without a blocking enrollment step. Best-effort and non-blocking; retries
      // on a cooldown if a frame isn't usable.
      if (!aiEnrolledDescriptorRef.current && faceCount === 1 && !gazeAway
          && aiServiceAvailableRef.current !== false
          && !autoEnrollRef.current.done && (now - autoEnrollRef.current.lastTry) > 1200) {
        autoEnrollRef.current.lastTry = now;
        // Collect several clean, well-spaced frames (single centred face, looking at the screen)
        // before enrolling, so the template is an average rather than one lucky/unlucky frame.
        const frame = captureFrameBase64(videoEl, 0.85, 640);
        if (frame) autoEnrollRef.current.samples.push(frame);
        const NEEDED_SAMPLES = 4;
        if (autoEnrollRef.current.samples.length >= NEEDED_SAMPLES) {
          const samples = autoEnrollRef.current.samples.slice(0, NEEDED_SAMPLES);
          autoEnrollRef.current.samples = [];
          void enrollFaceFramesAI(samples).then(res => {
            const d = res?.ok && Array.isArray(res.descriptor) && res.descriptor.length >= 128
              ? res.descriptor.map(Number) : null;
            if (d) {
              autoEnrollRef.current.done = true;
              aiEnrolledDescriptorRef.current = d;
              identityWarmUntilRef.current = Date.now() + 8000;
              setIdentityEnrollment('enrolled');
              const photo = captureSnapshot();
              void apiPost('enrollment.php', { action: 'enroll', studentId: student.id, descriptor: d, photo }).catch(() => {});
            }
          }).catch(() => {});
        }
      }

      // ── Proctor-timer decisions ────────────────────────────────────────────
      // Think of this as a human proctor's internal monologue:
      //   "Face gone? Start a timer. Still gone after 10s? Write it up."
      //   "Looking away? Start a timer. Still away after 9s? Write it up."
      //   "Two people? Give it 2.5s to confirm it's not a shadow, then flag."

      if (faceCount === 0) {
        multiFaceStartRef.current = null;
        gazeAwayStartRef.current  = null;
        if (!faceAbsenceStartRef.current) faceAbsenceStartRef.current = now;
        if ((now - faceAbsenceStartRef.current) >= FACE_ABSENT_GRACE_MS) {
          triggerProctorFeedback('NO_FACE', 'No face detected. Please stay in front of the camera.', { confidence: 0.90 });
          faceAbsenceStartRef.current = now; // reset; cooldown prevents immediate re-fire
        }

      } else if (faceCount >= 2) {
        faceAbsenceStartRef.current = null;
        gazeAwayStartRef.current    = null;
        if (!multiFaceStartRef.current) multiFaceStartRef.current = now;
        if ((now - multiFaceStartRef.current) >= MULTI_FACE_GRACE_MS) {
          triggerProctorFeedback('MULTIPLE_FACES', 'Multiple people detected in the camera frame.', { confidence: 0.92, metadata: { faceCount } });
          multiFaceStartRef.current = now;
        }

      } else {
        // Single face — student present and accounted for
        faceAbsenceStartRef.current = null;
        multiFaceStartRef.current   = null;

        if (gazeAway) {
          gazeAwayLastSeenRef.current = now;
          if (!gazeAwayStartRef.current) gazeAwayStartRef.current = now;
          if ((now - gazeAwayStartRef.current) >= GAZE_AWAY_GRACE_MS) {
            triggerProctorFeedback('GAZE_AWAY', 'Student appears to be looking away from the screen.', {
              confidence: 0.84,
              metadata: { headYaw },
            });
            gazeAwayStartRef.current = now;
          }
        } else if (gazeAwayStartRef.current
                   && (now - gazeAwayLastSeenRef.current) >= GAZE_AWAY_FLICKER_TOLERANCE_MS) {
          // Only reset once "looking at screen" has itself been sustained for a moment — a single
          // noisy frame right at the yaw threshold no longer wipes out genuine sustained look-away.
          gazeAwayStartRef.current = null;
        }

        // Identity continuity is handled by the Python AI (every 4th frame, above).
        // Removed redundant BlazeFace second-call here — it was running detection twice per tick.
      }
    } finally {
      tickRunning = false;
    }
  };

    const loop = async () => {
      const MIN_CYCLE_MS = 500;   // ~2 detections/sec when the server is responsive
      const MAX_CYCLE_MS = 2000;  // ease off to ~0.5/sec when it's struggling
      let cycle = MIN_CYCLE_MS;
      while (!cancelled) {
        const started = Date.now();
        await tick();
        const took = Date.now() - started;
        // ADAPTIVE BACKPRESSURE: when the AI service is under heavy load each tick takes longer.
        // Instead of hammering an overloaded server (which just deepens the backlog and makes
        // EVERYONE's violations late), ease the cadence out; when it recovers, tighten back to 2/s.
        // This keeps detection flowing for all students instead of collapsing under contention.
        if (took > 1200) cycle = Math.min(MAX_CYCLE_MS, cycle + 300);
        else if (took < 500) cycle = Math.max(MIN_CYCLE_MS, cycle - 200);
        // Pace by the time the tick took, not a flat sleep, so cadence stays steady; the
        // single-flight `tickRunning` guard already prevents overlapping inferences.
        const rest = cycle - took;
        await new Promise(resolve => window.setTimeout(resolve, Math.max(120, rest)));
      }
    };

    // Reset timers when loop starts (avoid stale state from previous session)
    faceAbsenceStartRef.current = null;
    gazeAwayStartRef.current    = null;
    multiFaceStartRef.current   = null;

    void loop();
    return () => { cancelled = true; };
  }, [permissionStatus, exam.proctoringConfig.cameraRequired, faceMlReady]);

  // 1c. Object detection (phone, study material, second device) is handled server-side by the
  //     Python AI engine inside the main detection loop above (result.phoneDetected /
  //     result.anomalyObjects). No browser-side coco-ssd model runs anymore.

  // 1c-live. Live proctor wall push — send a small camera snapshot + current AI status every ~2s
  // so a proctor can watch active candidates in near-real-time (frame-push transport). Best-effort:
  // a failed push never affects the exam. A final STOP drops the student off the wall on exit.
  useEffect(() => {
    if (permissionStatus !== 'granted' || !sessionId || !exam.proctoringConfig.cameraRequired) return;
    let cancelled = false;

    // Idle cadence keeps every candidate on the wall cheaply; when a proctor opens this candidate the
    // server answers each push with watched=true and we ramp up to near-video, then ease back down.
    const LIVE_IDLE_MS = 2000;
    const LIVE_WATCHED_MS = 400; // ~2.5 fps while a proctor is actively watching
    let timer: number | undefined;

    // Returns whether the server says a proctor is actively watching this candidate right now.
    const push = async (hi: boolean): Promise<boolean> => {
      if (cancelled || !proctoringArmedRef.current) return false;
      // Gate on the SAME source captureSnapshot() draws from — the visible preview can be
      // hidden/paused on mobile while the off-screen detection element keeps decoding.
      const videoEl = getProctorVideo();
      if (!videoEl || videoEl.readyState < 2 || videoEl.videoWidth < 60) return false;
      const image = captureSnapshot(hi);
      if (!image) return false;
      const s = liveStatusRef.current;
      try {
        const res = await apiPost<{ ok?: boolean; watched?: boolean }>('live.php', {
          action: 'PUSH',
          sessionId,
          examId: exam.id,
          studentId: student.id,
          image,
          status: {
            faceCount: s.faceCount,
            gazeAway: s.gazeAway,
            eyesClosed: s.eyesClosed,
            mouthOpen: s.mouthOpen,
            phone: s.phone,
            multipleFaces: s.multipleFaces,
            riskScore: s.riskScore,
            riskLevel: s.riskLevel,
            aiNote: s.aiNote,
          },
          lastViolationType: lastPushedViolationRef.current,
        });
        lastPushedViolationRef.current = null; // report each violation to the wall once
        return !!res?.watched;
      } catch {
        // ignore — the wall is a live convenience, not evidence
        return false;
      }
    };

    // Self-scheduling loop (not a fixed setInterval) so the interval can adapt per push. Send the
    // first frame immediately so the candidate appears on the wall without waiting a full cycle.
    let watched = false;
    const tick = async () => {
      if (cancelled) return;
      watched = await push(watched);
      if (cancelled) return;
      timer = window.setTimeout(tick, watched ? LIVE_WATCHED_MS : LIVE_IDLE_MS);
    };
    void tick();

    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
      // Drop off the wall promptly when the exam view unmounts.
      void apiPost('live.php', { action: 'STOP', sessionId }).catch(() => {});
    };
  }, [permissionStatus, sessionId, exam.id, student.id, exam.proctoringConfig.cameraRequired]);

  // 1d. Biometric identity: check enrollment, then either require enrollment or arm verification.
  useEffect(() => {
    if (permissionStatus !== 'granted' || !faceVerificationEnabled) return;
    let cancelled = false;
    (async () => {
      setIdentityEnrollment('checking');
      let existing: number[] | null = null;
      try {
        const res = await apiGet<{ enrolled?: boolean; descriptor?: number[] | null }>(
          `enrollment.php?studentId=${encodeURIComponent(student.id)}`
        );
        if (res?.enrolled && Array.isArray(res.descriptor) && res.descriptor.length >= 64) {
          existing = res.descriptor.map(Number);
        }
      } catch {
        // Enrollment endpoint unavailable — fall back below.
      }
      if (cancelled) return;

      // Identity is verified server-side by the Python AI (SFace deep embedding). No browser
      // recognition model runs. faceRecognitionActiveRef stays false so the main analyze loop
      // owns IDENTITY_CHANGE.
      faceRecognitionActiveRef.current = false;

      // SFace templates we store are L2-normalised (‖v‖≈1). A legacy face-api descriptor is NOT
      // normalised, so its norm is well away from 1 — detecting that lets us auto-migrate old
      // enrollments by simply asking the student to re-enroll (instead of mis-matching them in a
      // different embedding space).
      const isSFaceTemplate = (d: number[]) => {
        if (d.length < 128) return false;
        const norm = Math.sqrt(d.reduce((s, x) => s + x * x, 0));
        return Math.abs(norm - 1) < 0.15;
      };

      if (existing && isSFaceTemplate(existing)) {
        aiEnrolledDescriptorRef.current = existing;
        setIdentityEnrollment('enrolled');
      } else {
        // No valid SFace template yet (new candidate, or a legacy face-api descriptor). Do NOT
        // block the exam — proctoring still arms, and the detection loop silently auto-enrolls an
        // SFace template from the first clear single-face frame, after which identity matching
        // becomes active. 'unavailable' just means "identity not yet established".
        aiEnrolledDescriptorRef.current = null;
        setIdentityEnrollment('unavailable');
      }
    })();
    return () => { cancelled = true; };
  }, [permissionStatus, faceVerificationEnabled, student.id]);

  // Keep the enrollment overlay preview bound to the live camera stream.
  useEffect(() => {
    if (identityEnrollment === 'required' && enrollPreviewRef.current && streamRef.current) {
      enrollPreviewRef.current.srcObject = streamRef.current;
    }
  }, [identityEnrollment]);

  const handleEnrollIdentity = async () => {
    if (enrollBusy) return;
    const source = videoRef.current;
    if (!source || source.readyState < 2) {
      setEnrollMessage('Camera is not ready yet. Please wait a moment and try again.');
      return;
    }
    setEnrollBusy(true);
    setEnrollMessage('Capturing your face…');
    try {
      if (aiServiceAvailableRef.current === false) {
        setEnrollMessage('Identity service is offline. Please wait a moment and try again, or contact your proctor.');
        return;
      }

      // Python AI (SFace) produces the single canonical 128-d face template — used both in-memory
      // for live server-side checks and saved to enrollment.php for cross-session verification.
      const aiResult = await enrollFaceAI(source).catch(() => null);
      const descriptor: number[] | null =
        aiResult?.ok && Array.isArray(aiResult.descriptor) && aiResult.descriptor.length >= 128
          ? aiResult.descriptor.map(Number)
          : null;

      if (!descriptor) {
        setEnrollMessage('No clear face detected. Face the camera directly in good lighting, remove masks/hats, and try again.');
        return;
      }

      aiEnrolledDescriptorRef.current = descriptor;
      identityWarmUntilRef.current = Date.now() + 8000; // let the fresh template settle before flagging
      const photo = captureSnapshot();
      await apiPost('enrollment.php', { action: 'enroll', studentId: student.id, descriptor, photo });
      faceRecognitionActiveRef.current = false; // identity verified server-side by the Python AI
      setEnrollMessage(null);
      setIdentityEnrollment('enrolled');
    } catch {
      setEnrollMessage('Enrollment could not be saved. Check your connection and try again.');
    } finally {
      setEnrollBusy(false);
    }
  };

  // Live identity verification is handled entirely server-side: the main analyze loop sends the
  // enrolled SFace template with every frame and the Python AI raises IDENTITY_CHANGE on a
  // sustained mismatch. No browser-side recognition loop runs anymore.

  // 2. Timer
  useEffect(() => {
    if (examBlocked || resumePending) return;
    const timer = setInterval(() => {
      setTimeLeft(prev => {
        if (prev <= 1) {
          clearInterval(timer);
          handleFinish();
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [examBlocked, resumePending]);

  // Section timer (if enabled)
  useEffect(() => {
    const currentSection = activeSections[currentSectionIdx];
    if (!currentSection) {
      setSectionTimeLeft(null);
      return;
    }
    if (resumeAppliedRef.current) {
      const override = resumeOverrideRef.current;
      resumeAppliedRef.current = false;
      if (override !== null && typeof override === 'number') {
        setSectionTimeLeft(override);
      } else if (currentSection.timeLimitMinutes && currentSection.timeLimitMinutes > 0) {
        setSectionTimeLeft(currentSection.timeLimitMinutes * 60);
      } else {
        setSectionTimeLeft(null);
      }
      questionTimerRef.current = Date.now();
      return;
    }
    if (currentSection.timeLimitMinutes && currentSection.timeLimitMinutes > 0) {
      setSectionTimeLeft(currentSection.timeLimitMinutes * 60);
    } else {
      setSectionTimeLeft(null);
    }
    questionTimerRef.current = Date.now();
  }, [activeSections, currentSectionIdx]);

  useEffect(() => {
    if (examBlocked || resumePending) return;
    if (sectionTimeLeft === null) return;
    const timer = window.setInterval(() => {
      setSectionTimeLeft(prev => {
        if (prev === null) return prev;
        if (prev <= 1) {
          window.clearInterval(timer);
          moveToNext();
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => window.clearInterval(timer);
  }, [examBlocked, resumePending, sectionTimeLeft, currentSectionIdx]);

  useEffect(() => {
    if (examBlocked) {
      pausedRef.current = true;
      return;
    }
    pausedRef.current = false;
    questionTimerRef.current = Date.now();
  }, [examBlocked]);

  // Resume state from localStorage
  useEffect(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (!parsed || parsed.examId !== exam.id || parsed.studentId !== student.id) return;
      resumePayloadRef.current = parsed;
      setResumePending(true);
      setResumeCountdown(5);
    } catch {
      // ignore parse errors
    }
  }, [storageKey, exam.id, student.id]);

  useEffect(() => {
    if (!resumePending) return;
    if (resumeCountdown <= 0) {
      const payload = resumePayloadRef.current;
      if (payload) {
        const elapsed = Math.max(0, Math.floor((Date.now() - (payload.savedAt || Date.now())) / 1000));
        const nextSectionIdx = payload.currentSectionIdx ?? 0;
        const shouldDeferOverride = nextSectionIdx !== currentSectionIdx;
        setAnswers(payload.answers || {});
        setQuestionTimes(payload.questionTimes || {});
        questionTimesRef.current = payload.questionTimes || {};
        setCurrentSectionIdx(nextSectionIdx);
        setCurrentQuestionIdx(payload.currentQuestionIdx ?? 0);
        setMinSectionIdx(payload.minSectionIdx ?? 0);
        if (typeof payload.timeLeft === 'number') {
          setTimeLeft(Math.max(0, payload.timeLeft - elapsed));
        }
        if (typeof payload.sectionTimeLeft === 'number') {
          const nextSectionTime = Math.max(0, payload.sectionTimeLeft - elapsed);
          resumeOverrideRef.current = shouldDeferOverride ? nextSectionTime : null;
          resumeAppliedRef.current = shouldDeferOverride;
          setSectionTimeLeft(nextSectionTime);
        } else {
          resumeOverrideRef.current = null;
          resumeAppliedRef.current = shouldDeferOverride;
        }
        questionTimerRef.current = Date.now();
        showStudentNotice('Session restored from autosave.');
      }
      setResumePending(false);
      return;
    }
    const timer = window.setTimeout(() => setResumeCountdown(prev => prev - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [resumePending, resumeCountdown]);

  // Autosave progress
  const stateRef = useRef({
    answers,
    questionTimes,
    currentSectionIdx,
    currentQuestionIdx,
    minSectionIdx,
    timeLeft,
    sectionTimeLeft
  });

  useEffect(() => {
    stateRef.current = {
      answers,
      questionTimes,
      currentSectionIdx,
      currentQuestionIdx,
      minSectionIdx,
      timeLeft,
      sectionTimeLeft
    };
  }, [answers, questionTimes, currentSectionIdx, currentQuestionIdx, minSectionIdx, timeLeft, sectionTimeLeft]);

  useEffect(() => {
    if (resumePending) return;
    const saveState = () => {
      try {
        setAutosaveStatus('saving');
        const payload = {
          examId: exam.id,
          studentId: student.id,
          savedAt: Date.now(),
          ...stateRef.current
        };
        localStorage.setItem(storageKey, JSON.stringify(payload));
        setAutosaveStatus('saved');
      } catch {
        // ignore storage errors
      }
    };
    saveState();
    const interval = window.setInterval(saveState, 5000);
    return () => window.clearInterval(interval);
  }, [resumePending, storageKey, exam.id, student.id]);

  // Server-side answer autosave. localStorage (above) only survives on the SAME device, so an
  // abandoned attempt (tab closed / crash before submit) leaves no answers on the server and can't
  // be scored. Mirroring answers to the backend every 20s means the attended questions are graded
  // even when the candidate never submits. Best-effort; starts once the server session exists.
  useEffect(() => {
    if (resumePending) return;
    if (permissionStatus !== 'granted' || !sessionId) return;
    const questionIds = activeSections.flatMap(section => section.questions.map(q => q.id));
    if (questionIds.length === 0) return;
    const saveToServer = () => {
      if (finishOnceRef.current) return; // finish handler owns the final grade
      void apiPost('sessions.php', {
        action: 'save_progress',
        examId: exam.id,
        studentId: student.id,
        answers: answersRef.current,
        questionIds,
        questionTimes: questionTimesRef.current,
      }).catch(() => {});
    };
    const interval = window.setInterval(saveToServer, 20000);
    return () => window.clearInterval(interval);
  }, [resumePending, permissionStatus, sessionId, exam.id, student.id]);

  // 3. Security Event Listeners
  useEffect(() => {
    const handleVisibilityChange = () => {
      // Never flag while a browser permission/screen-picker dialog is open, or during the
      // warm-up / screen-share-bar grace window.
      if (permissionDialogOpenRef.current) return;
      if (Date.now() < tabViolationGraceUntilRef.current) return;
      if (document.hidden) {
        // Re-confirm the tab is still hidden a moment later. The screen-share indicator bar
        // and its "Hide" toggle can flip visibility for a single tick; a real tab switch stays
        // hidden. Only genuinely-hidden tabs are written up.
        window.setTimeout(() => {
          if (permissionDialogOpenRef.current) return;
          if (Date.now() < tabViolationGraceUntilRef.current) return;
          if (!document.hidden) return;
          triggerProctorFeedback('TAB_SWITCH', 'Exam window hidden. Incident logged.');
        }, 600);
      }
    };

    const handleBlur = () => {
      // Never flag while a browser permission/screen-picker dialog is open, or during the
      // warm-up / screen-share-bar grace window.
      if (permissionDialogOpenRef.current) return;
      if (Date.now() < tabViolationGraceUntilRef.current) return;
      // A tab switch raises both `visibilitychange` (document.hidden) and `blur`; let the
      // visibility handler own that case so it is only logged once. A blur while the document
      // is still visible means focus moved to another application (alt-tab / second screen),
      // which `visibilitychange` cannot catch — log that distinctly.
      if (document.hidden) return;
      // Defer and require the window to STAY unfocused. Clicking the screen-share bar's "Hide"
      // button (or other transient browser-chrome surfaces) blurs the tab for a fraction of a
      // second and returns focus immediately — that must not count. A genuine switch to another
      // application keeps focus away well beyond this window.
      window.setTimeout(() => {
        if (permissionDialogOpenRef.current) return;
        if (Date.now() < tabViolationGraceUntilRef.current) return;
        if (document.hidden || document.hasFocus()) return;
        triggerProctorFeedback('TAB_SWITCH', 'Window focus left the exam (possible switch to another app).');
      }, 1200);
    };

    const preventContext = (e: Event) => {
      e.preventDefault();
    };
    const preventClipboard = (e: Event) => {
      e.preventDefault();
      triggerProctorFeedback('COPY_PASTE', 'Copy/paste is blocked during the exam.');
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      const key = (e.key || '').toLowerCase();
      const ctrlOrMeta = e.ctrlKey || e.metaKey;

      // Developer tools / view-source: tampering attempts. Block + warn (not counted as a
      // graded violation since browsers can still open dev tools via menus — it's a deterrent).
      const isDevTools =
        key === 'f12' ||
        (ctrlOrMeta && e.shiftKey && (key === 'i' || key === 'j' || key === 'c')) ||
        (ctrlOrMeta && key === 'u');
      if (isDevTools) {
        e.preventDefault();
        showStudentNotice('Developer tools are disabled during the exam.');
        return;
      }

      // Print / save / screenshot: exfiltration of exam content. Block + log as a violation.
      const isExfiltration =
        (ctrlOrMeta && (key === 'p' || key === 's')) ||
        key === 'printscreen';
      if (isExfiltration) {
        e.preventDefault();
        triggerProctorFeedback('COPY_PASTE', 'Printing, saving, or screenshotting exam content is blocked.');
        return;
      }
    };

    // Guard against accidental reload / closing / external navigation mid-exam.
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (finishingRef.current || finishOnceRef.current) return;
      e.preventDefault();
      e.returnValue = '';
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("blur", handleBlur);
    document.addEventListener("contextmenu", preventContext);
    document.addEventListener("copy", preventClipboard);
    document.addEventListener("paste", preventClipboard);
    document.addEventListener("cut", preventClipboard);
    window.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("beforeunload", handleBeforeUnload);

    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("blur", handleBlur);
      document.removeEventListener("contextmenu", preventContext);
      document.removeEventListener("copy", preventClipboard);
      document.removeEventListener("paste", preventClipboard);
      document.removeEventListener("cut", preventClipboard);
      window.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("beforeunload", handleBeforeUnload);
    };
  }, []);

  // Pick the camera <video> that is actually decoding frames right now.
  // On phones the sidebar preview lives inside a `display:none` container whenever the tools
  // panel is collapsed (the default on mobile), and drawing a display:none video to a canvas
  // yields stale/blank frames — so detection and evidence silently break. The compositor's
  // off-screen camera video is always mounted and decoding, so it's the reliable source.
  const getProctorVideo = (): HTMLVideoElement | null => {
    // Prefer the dedicated always-decoding element, then the recording compositor's cam, then the
    // visible preview — whichever is actually producing fresh frames right now.
    const dv = detectionVideoRef.current;
    if (dv && dv.readyState >= 2 && dv.videoWidth >= 60) return dv;
    const cam = compositorVideosRef.current?.cam;
    if (cam && cam.readyState >= 2 && cam.videoWidth >= 60) return cam;
    const el = videoRef.current;
    if (el && el.readyState >= 2 && el.videoWidth >= 60) return el;
    return dv || cam || el || null;
  };

  // hi = a proctor is actively watching this candidate, so send a larger, sharper frame (the focused
  // view is on screen). Otherwise keep the tiny 320x240 grid thumbnail to hold global bandwidth down.
  const captureSnapshot = (hi = false): string | undefined => {
    const source = getProctorVideo();
    if (source) {
      const canvas = document.createElement('canvas');
      canvas.width = hi ? 480 : 320;
      canvas.height = hi ? 360 : 240;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
        return canvas.toDataURL('image/jpeg', hi ? 0.62 : 0.5);
      }
    }
    return undefined;
  };

  const MAX_PENDING_VIOLATIONS = 120;
  const MAX_DELIVERY_ATTEMPTS = 40; // ~10 minutes on the 15s flush tick before giving up

  const enqueuePendingViolation = (payload: Record<string, unknown>, attempts = 0) => {
    if (attempts >= MAX_DELIVERY_ATTEMPTS) return;
    const queue = pendingViolationsRef.current;
    queue.push({ payload, attempts });
    if (queue.length > MAX_PENDING_VIOLATIONS) {
      queue.splice(0, queue.length - MAX_PENDING_VIOLATIONS);
    }
  };

  // The server replies 200 with a per-violation saved count; saved: 0 (e.g. the session row
  // wasn't visible yet) is a delivery failure just like a network error.
  const violationWasSaved = (res: unknown): boolean =>
    Number((res as { saved?: number } | null)?.saved ?? 0) >= 1;

  const flushPendingViolations = async () => {
    if (flushingViolationsRef.current) return;
    if (pendingViolationsRef.current.length === 0) return;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
    flushingViolationsRef.current = true;
    try {
      const queue = pendingViolationsRef.current;
      const rejected: typeof queue = [];
      while (queue.length > 0) {
        const next = queue[0];
        try {
          const res = await apiPost('violations.php', next.payload);
          queue.shift();
          if (!violationWasSaved(res) && next.attempts + 1 < MAX_DELIVERY_ATTEMPTS) {
            rejected.push({ payload: next.payload, attempts: next.attempts + 1 });
          }
        } catch {
          break; // still offline / server down — keep the queue for the next flush
        }
      }
      queue.push(...rejected); // retry server-rejected items on a later flush, not this one
    } finally {
      flushingViolationsRef.current = false;
    }
  };

  // Send a violation now; if the network drops it or the server can't store it yet, queue it so
  // evidence is never lost.
  const deliverViolation = (payload: Record<string, unknown>) => {
    apiPost('violations.php', payload)
      .then(res => { if (!violationWasSaved(res)) enqueuePendingViolation(payload, 1); })
      .catch(() => enqueuePendingViolation(payload));
  };

  // Retry queued violation uploads when connectivity returns and on a periodic tick.
  useEffect(() => {
    const onOnline = () => {
      showStudentNotice('Connection restored. Syncing exam activity.');
      void flushPendingViolations();
    };
    const onOffline = () => {
      showStudentNotice('Network lost. Your answers and activity are saved and will sync automatically.');
    };
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    const id = window.setInterval(() => { void flushPendingViolations(); }, 15000);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      window.clearInterval(id);
    };
  }, []);

  const violationCategoriesByType: Record<ViolationLog['type'], ViolationCategory[]> = {
    TAB_SWITCH: ['tabSwitch'],
    NO_FACE: ['camera'],
    MULTIPLE_FACES: ['camera'],
    GAZE_AWAY: ['camera'],
    AUDIO_DETECTED: ['microphone'],
    FULLSCREEN_EXIT: ['fullscreen'],
    COPY_PASTE: ['copyPaste'],
    PHONE_DETECTED: ['camera'],
    ANOMALY_OBJECT: ['camera'],
    LOCATION_CHANGE: ['environment'],
    IDENTITY_CHANGE: ['camera'],
    SUSPICIOUS_BEHAVIOR: ['camera'],
  };

  const buildViolationSummary = (trigger?: { category?: ViolationCategory; type?: ViolationLog['type'] }) => ({
    total: Object.values(violationTypeCountsRef.current).reduce<number>((sum, val) => sum + Number(val), 0),
    byType: { ...violationTypeCountsRef.current },
    byCategory: { ...violationCategoryCountsRef.current },
    triggerType: trigger?.type,
    triggerCategory: trigger?.category,
  });

  const queueViolationTermination = (category: ViolationCategory, type: ViolationLog['type'], limit: number) => {
    if (terminationQueuedRef.current) return;
    terminationQueuedRef.current = true;
    tabSwitchLockedRef.current = true;
    if (feedbackTimeoutRef.current) clearTimeout(feedbackTimeoutRef.current);
    const label = category === 'tabSwitch'
      ? 'Tab switch'
      : category === 'copyPaste'
        ? 'Copy/paste'
        : category === 'fullscreen'
          ? 'Fullscreen'
          : category === 'microphone'
            ? 'Microphone'
            : 'Camera';
    const reason = `${label} violation limit reached (${limit}). Exam terminated.`;
    setFeedbackBanner({ show: true, msg: reason, type: 'error' });
    window.setTimeout(() => {
      handleFinish({
        terminated: true,
        terminationReason: reason,
        triggerCategory: category,
        triggerType: type,
      });
    }, 800);
  };

  const triggerProctorFeedback = (
    type: ViolationLog['type'],
    description: string,
    options?: { bypassActive?: boolean; confidence?: number; metadata?: Record<string, any> }
  ) => {
    if (!options?.bypassActive && !proctoringArmedRef.current) return;
    const now = Date.now();
    // Per-type cooldowns. Low-signal "human" events (gaze, audio) re-fire slowly so an honest
    // student is never spammed; high-signal events (copy/paste, tab switch) re-fire promptly.
    const cooldown =
      type === 'COPY_PASTE'      ? 1000  :
      type === 'TAB_SWITCH'      ? 4000  :
      type === 'AUDIO_DETECTED'  ? 14000 :
      type === 'NO_FACE'         ? 10000 :
      type === 'MULTIPLE_FACES'  ? 8000  :
      type === 'GAZE_AWAY'       ? 8000  :  // re-fire on sustained look-away, still slow enough not to spam a brief glance
      type === 'ANOMALY_OBJECT'  ? 15000 :
      type === 'PHONE_DETECTED'  ? 10000 :
      type === 'SUSPICIOUS_BEHAVIOR' ? 20000 : // server patterns already have a 45s cooldown
      5000;
    const lastForType = lastViolationTimeByType.current[type] ?? 0;
    if (now - lastForType < cooldown) return;
    lastViolationTimeByType.current[type] = now;
    lastPushedViolationRef.current = type; // surfaced on the proctor live wall

    // Severity lets reviewers focus: HIGH = clear integrity breach, MEDIUM = needs a look,
    // LOW = normal human behaviour logged for completeness. Stored in metadata (no schema change).
    const severity: 'high' | 'medium' | 'low' =
      (options?.metadata?.severity as any) ||
      (type === 'MULTIPLE_FACES' || type === 'PHONE_DETECTED' || type === 'IDENTITY_CHANGE' || type === 'COPY_PASTE'
        ? 'high'
        : type === 'GAZE_AWAY'
          ? 'low'
          : 'medium');

    const evidenceImage = captureSnapshot();
    const newViolation: ViolationLog = {
      timestamp: now,
      type,
      description,
      snapshot: evidenceImage,
      category: type === 'SUSPICIOUS_BEHAVIOR'
        ? 'behavior'
        : violationCategoriesByType[type]?.[0] === 'microphone'
          ? 'microphone'
          : violationCategoriesByType[type]?.[0] === 'environment'
            ? 'location'
            : violationCategoriesByType[type]?.[0] === 'fullscreen'
              ? 'screen'
              : violationCategoriesByType[type]?.[0] === 'copyPaste' || violationCategoriesByType[type]?.[0] === 'tabSwitch'
                ? 'browser'
                : 'camera',
      confidence: options?.confidence,
      metadata: { ...(options?.metadata || {}), severity },
    };
    setViolations(prev => [...prev, newViolation]);
    violationTypeCountsRef.current[type] = (violationTypeCountsRef.current[type] || 0) + 1;
    const categories = violationCategoriesByType[type] || [];
    categories.forEach(category => {
      const nextCount = (violationCategoryCountsRef.current[category] || 0) + 1;
      violationCategoryCountsRef.current[category] = nextCount;
      if (category === 'tabSwitch') {
        setTabSwitchCount(nextCount);
      }
      const limit = categoryLimits[category];
      if (limit > 0 && nextCount >= limit) {
        queueViolationTermination(category, type, limit);
      }
    });
    deliverViolation({ examId: exam.id, studentId: student.id, sessionId: sessionId ?? null, violation: newViolation });
    if (terminationQueuedRef.current) return;

    if (feedbackTimeoutRef.current) clearTimeout(feedbackTimeoutRef.current);
    
    setFeedbackBanner({ show: true, msg: description, type: type === 'COPY_PASTE' ? 'error' : 'warning' });
    
    feedbackTimeoutRef.current = setTimeout(() => {
        setFeedbackBanner(prev => ({ ...prev, show: false }));
    }, 4000);

  };

  const showStudentNotice = (message: string) => {
    if (feedbackTimeoutRef.current) clearTimeout(feedbackTimeoutRef.current);
    setFeedbackBanner({ show: true, msg: message, type: 'warning' });
    feedbackTimeoutRef.current = setTimeout(() => {
      setFeedbackBanner(prev => ({ ...prev, show: false }));
    }, 3000);
  };

  const resumeNow = () => {
    setResumeCountdown(0);
  };

  const discardResume = () => {
    try {
      localStorage.removeItem(storageKey);
    } catch {
      // ignore storage errors
    }
    resumePayloadRef.current = null;
    resumeOverrideRef.current = null;
    resumeAppliedRef.current = false;
    setResumePending(false);
    setResumeCountdown(0);
    showStudentNotice('Starting a fresh attempt.');
  };

  const handleFinish = (opts?: {
    terminated?: boolean;
    terminationReason?: string;
    triggerCategory?: ViolationCategory;
    triggerType?: ViolationLog['type'];
  }) => {
      if (finishOnceRef.current) return;
      finishOnceRef.current = true;
      // Read exam state through refs, never the closure: finish fires from effects that mounted
      // at exam start (timer expiry, violation-limit termination), whose captured state is stale.
      const { sectionIdx, questionIdx } = positionRef.current;
      const currentSection = activeSections[sectionIdx];
      const currentQuestion = currentSection?.questions[questionIdx];
      let finalTimes = questionTimesRef.current;
      if (currentQuestion && !pausedRef.current) {
        const delta = Math.max(0, Math.floor((Date.now() - questionTimerRef.current) / 1000));
        if (delta > 0) {
          finalTimes = {
            ...questionTimesRef.current,
            [currentQuestion.id]: (questionTimesRef.current[currentQuestion.id] || 0) + delta
          };
          questionTimesRef.current = finalTimes;
        }
      }

      const payload = {
        answers: answersRef.current,
        violations: violationsRef.current,
        questions: activeSections.flatMap(section => section.questions),
        questionTimes: finalTimes,
        terminated: !!opts?.terminated,
        terminationReason: opts?.terminationReason,
        violationSummary: buildViolationSummary({
          category: opts?.triggerCategory,
          type: opts?.triggerType,
        }),
      };

      void (async () => {
        await flushPendingViolations(); // last chance to land queued evidence before teardown
        await shutdownExamCapture(opts?.terminated ? 'FAILED' : 'COMPLETED');
        try {
          localStorage.removeItem(storageKey);
        } catch {
          // ignore storage errors
        }
        onFinish(payload);
      })();
  };

  const handleAnswer = (val: any) => {
    const currentSection = activeSections[currentSectionIdx];
    const currentQuestion = currentSection?.questions[currentQuestionIdx];
    if (!currentQuestion) return;
    setAnswers(prev => ({ ...prev, [currentQuestion.id]: val }));
  };

  // Set the answer for an arbitrary question id (used by structured renderers that update
  // maps/arrays for the currently displayed question).
  const setAnswerFor = (questionId: string, val: any) => {
    setAnswers(prev => ({ ...prev, [questionId]: val }));
  };

  const applyTimeDelta = (questionId: string, delta: number) => {
    if (delta <= 0) return;
    setQuestionTimes(prev => {
      const next = { ...prev, [questionId]: (prev[questionId] || 0) + delta };
      questionTimesRef.current = next;
      return next;
    });
  };

  const recordQuestionTime = (nextSectionIdx: number, nextQuestionIdx: number) => {
    const currentSection = activeSections[currentSectionIdx];
    const currentQuestion = currentSection?.questions[currentQuestionIdx];
    if (currentQuestion && !pausedRef.current) {
      const delta = Math.max(0, Math.floor((Date.now() - questionTimerRef.current) / 1000));
      applyTimeDelta(currentQuestion.id, delta);
    }
    questionTimerRef.current = Date.now();
    setCurrentSectionIdx(nextSectionIdx);
    setCurrentQuestionIdx(nextQuestionIdx);
  };

  const moveToPrevious = () => {
    if (currentQuestionIdx > 0) {
      recordQuestionTime(currentSectionIdx, currentQuestionIdx - 1);
      return;
    }
    if (currentSectionIdx > minSectionIdx) {
      const prevSection = activeSections[currentSectionIdx - 1];
      const prevIdx = Math.max(0, prevSection.questions.length - 1);
      recordQuestionTime(currentSectionIdx - 1, prevIdx);
    } else {
      showStudentNotice('Previous section is locked.');
    }
  };

  const moveToNext = () => {
    const currentSection = activeSections[currentSectionIdx];
    if (!currentSection) return;
    if (currentQuestionIdx < currentSection.questions.length - 1) {
      recordQuestionTime(currentSectionIdx, currentQuestionIdx + 1);
      return;
    }
    if (currentSectionIdx < activeSections.length - 1) {
      const nextSectionIdx = currentSectionIdx + 1;
      if (currentSection.lockOnComplete ?? true) {
        setMinSectionIdx(prev => Math.max(prev, nextSectionIdx));
      }
      recordQuestionTime(nextSectionIdx, 0);
      return;
    }
    handleFinish();
  };

  const formatTime = (seconds: number) => {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  // Hard device gate — shown before anything else when the candidate's device class is not allowed.
  if (deviceBlocked) {
    const allowedLabels = allowedDeviceTypes.map(d => deviceTypeLabel[d]);
    const allowedText = allowedLabels.length === 1
      ? allowedLabels[0]
      : `${allowedLabels.slice(0, -1).join(', ')} or ${allowedLabels[allowedLabels.length - 1]}`;
    return (
      <div className="min-h-[100dvh] flex items-center justify-center lsc-gradient-bg px-4 py-12">
        <div className="max-w-md w-full lsc-panel overflow-hidden text-center">
          <div className="p-8 bg-[radial-gradient(700px_circle_at_50%_0%,rgba(244,63,94,0.16),transparent_70%),linear-gradient(180deg,#fff7f7,#fdeef0)] border-b border-rose-100">
            <div className="w-16 h-16 mx-auto rounded-2xl bg-rose-100 text-rose-600 flex items-center justify-center mb-4">
              <ShieldAlert size={30} />
            </div>
            <h1 className="text-2xl font-bold text-slate-900">Device not allowed</h1>
            <p className="text-slate-500 mt-2 text-sm">{exam.title}</p>
          </div>
          <div className="p-8 space-y-4">
            <p className="text-slate-700 text-sm leading-relaxed">
              You are trying to open this exam on <strong>{deviceTypeLabel[device.deviceClass]}</strong>.
              The examiner has restricted this exam to <strong>{allowedText}</strong>.
            </p>
            <div className="flex flex-wrap justify-center gap-2 pt-1">
              {allowedDeviceTypes.includes('desktop') && (
                <span className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-700 bg-slate-100 border border-slate-200 rounded-full px-3 py-1.5">
                  <Monitor size={14} /> Desktop / Laptop
                </span>
              )}
              {allowedDeviceTypes.includes('tablet') && (
                <span className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-700 bg-slate-100 border border-slate-200 rounded-full px-3 py-1.5">
                  <Tablet size={14} /> Tablet
                </span>
              )}
              {allowedDeviceTypes.includes('mobile') && (
                <span className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-700 bg-slate-100 border border-slate-200 rounded-full px-3 py-1.5">
                  <Smartphone size={14} /> Mobile Phone
                </span>
              )}
            </div>
            <p className="text-xs text-slate-400 pt-2">
              Please reopen the exam link on a permitted device and try again.
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (totalQuestions === 0) {
      return (
        <div className="min-h-screen flex items-center justify-center bg-slate-50 text-slate-500 font-medium">
          <div className="flex flex-col items-center gap-4">
             <div className="w-8 h-8 border-4 border-[var(--lsc-primary)] border-t-transparent rounded-full animate-spin"></div>
             Loading Exam Content...
          </div>
        </div>
      );
  }

  const currentSection = activeSections[currentSectionIdx];
  const currentQ = currentSection.questions[currentQuestionIdx];
  // Fixed candidate-facing display orders for the structured types (seeded by question id).
  const matchRightOrder = useMemo(
    () => seededShuffle(rangeArr(currentQ.matchOptions?.right?.length || 0), currentQ.id + ':r'),
    [currentQ.id]
  );
  const orderingInitial = useMemo(
    () => seededShuffle(rangeArr(currentQ.matchOptions?.items?.length || 0), currentQ.id + ':o'),
    [currentQ.id]
  );
  const isLastQuestionInSection = currentQuestionIdx === currentSection.questions.length - 1;
  const isLastSection = currentSectionIdx === activeSections.length - 1;
  const isLast = isLastSection && isLastQuestionInSection;
  const overallIndex = activeSections
    .slice(0, currentSectionIdx)
    .reduce((sum, section) => sum + section.questions.length, 0) + currentQuestionIdx + 1;

  // ---- Per-question-type answer input for the candidate ----
  const optCardCls = (selected: boolean) =>
    `group flex items-center gap-4 p-4 rounded-xl border transition-all cursor-pointer ${
      selected ? 'border-blue-500 bg-blue-50/70 shadow-sm ring-1 ring-blue-500' : 'border-slate-200 bg-white hover:border-blue-300 hover:shadow-sm'
    }`;

  const renderAnswerInput = () => {
    const q = currentQ;
    const val = answers[q.id];

    // Single-choice option list (MCQ / TRUE_FALSE / YES_NO).
    if (q.type === QuestionType.MCQ || q.type === QuestionType.TRUE_FALSE || q.type === QuestionType.YES_NO) {
      const opts = q.options && q.options.length ? q.options
        : q.type === QuestionType.TRUE_FALSE ? ['True', 'False'] : ['Yes', 'No'];
      return (
        <div className="grid gap-3">
          {opts.map((opt, idx) => {
            const selected = val === idx;
            return (
              <div key={idx} onClick={() => handleAnswer(idx)} className={optCardCls(selected)}>
                <div className={`w-5 h-5 rounded-full border flex items-center justify-center shrink-0 ${selected ? 'border-blue-500 bg-blue-500' : 'border-slate-300 group-hover:border-blue-400'}`}>
                  {selected && <div className="w-2 h-2 rounded-full bg-white" />}
                </div>
                <span className={`text-base ${selected ? 'text-blue-900 font-medium' : 'text-slate-700'}`}>{opt}</span>
              </div>
            );
          })}
        </div>
      );
    }

    // Multi-select (checkboxes).
    if (q.type === QuestionType.MULTI_SELECT) {
      const picked: number[] = Array.isArray(val) ? val : [];
      return (
        <div className="grid gap-3">
          {(q.options || []).map((opt, idx) => {
            const selected = picked.includes(idx);
            return (
              <div key={idx} onClick={() => handleAnswer(selected ? picked.filter(x => x !== idx) : [...picked, idx])} className={optCardCls(selected)}>
                <div className={`w-5 h-5 rounded border flex items-center justify-center shrink-0 ${selected ? 'border-blue-500 bg-blue-500' : 'border-slate-300 group-hover:border-blue-400'}`}>
                  {selected && <CheckCircle2 size={14} className="text-white" />}
                </div>
                <span className={`text-base ${selected ? 'text-blue-900 font-medium' : 'text-slate-700'}`}>{opt}</span>
              </div>
            );
          })}
        </div>
      );
    }

    // Fill in the blank(s).
    if (q.type === QuestionType.FILL_BLANK) {
      const blanks = q.answerKey?.blanks || [];
      const arr: string[] = Array.isArray(val) ? val : [];
      return (
        <div className="space-y-3">
          {blanks.map((_, i) => (
            <div key={i} className="flex items-center gap-3">
              <span className="text-sm text-slate-500 w-16 shrink-0">Blank {i + 1}</span>
              <input
                type="text"
                className="flex-1 p-3 text-base bg-white border border-slate-300 rounded-xl outline-none"
                value={arr[i] || ''}
                onPaste={(e) => e.preventDefault()}
                onChange={e => { const next = [...arr]; next[i] = e.target.value; handleAnswer(next); }}
              />
            </div>
          ))}
        </div>
      );
    }

    // Numeric.
    if (q.type === QuestionType.NUMERIC) {
      return (
        <input type="number" step="any" className="w-full p-4 text-base bg-white border border-slate-300 rounded-xl outline-none"
          placeholder="Enter a number" value={val ?? ''} onChange={e => handleAnswer(e.target.value)} />
      );
    }

    // Date / Time.
    if (q.type === QuestionType.DATE || q.type === QuestionType.TIME) {
      return (
        <input type={q.type === QuestionType.DATE ? 'date' : 'time'}
          className="p-4 text-base bg-white border border-slate-300 rounded-xl outline-none"
          value={val ?? ''} onChange={e => handleAnswer(e.target.value)} />
      );
    }

    // Matching: left items fixed, right options shuffled; pick a right for each left.
    if (q.type === QuestionType.MATCHING) {
      const left = q.matchOptions?.left || [];
      const right = q.matchOptions?.right || [];
      const map: Record<number, number> = (val && typeof val === 'object') ? val : {};
      return (
        <div className="space-y-3">
          {left.map((l, li) => (
            <div key={li} className="flex items-center gap-3">
              <span className="flex-1 p-3 bg-slate-50 border border-slate-200 rounded-xl text-slate-800">{l}</span>
              <span className="text-slate-400">↔</span>
              <select className="flex-1 p-3 bg-white border border-slate-300 rounded-xl outline-none"
                value={map[li] ?? ''} onChange={e => setAnswerFor(q.id, { ...map, [li]: Number(e.target.value) })}>
                <option value="" disabled>Select…</option>
                {matchRightOrder.map(ri => <option key={ri} value={ri}>{right[ri]}</option>)}
              </select>
            </div>
          ))}
        </div>
      );
    }

    // Ordering: move items up/down to arrange them.
    if (q.type === QuestionType.ORDERING) {
      const items = q.matchOptions?.items || [];
      const order: number[] = Array.isArray(val) && val.length === items.length ? val : orderingInitial;
      const move = (pos: number, dir: -1 | 1) => {
        const next = [...order];
        const swap = pos + dir;
        if (swap < 0 || swap >= next.length) return;
        [next[pos], next[swap]] = [next[swap], next[pos]];
        handleAnswer(next);
      };
      return (
        <div className="space-y-2">
          {order.map((itemIdx, pos) => (
            <div key={itemIdx} className="flex items-center gap-3 p-3 bg-white border border-slate-300 rounded-xl">
              <span className="w-6 h-6 rounded-full bg-slate-100 text-slate-600 text-sm flex items-center justify-center shrink-0">{pos + 1}</span>
              <span className="flex-1 text-slate-800">{items[itemIdx]}</span>
              <button type="button" onClick={() => move(pos, -1)} disabled={pos === 0} className="p-1 text-slate-500 hover:text-blue-600 disabled:opacity-30"><ChevronLeft className="rotate-90" size={18} /></button>
              <button type="button" onClick={() => move(pos, 1)} disabled={pos === order.length - 1} className="p-1 text-slate-500 hover:text-blue-600 disabled:opacity-30"><ChevronRight className="rotate-90" size={18} /></button>
            </div>
          ))}
        </div>
      );
    }

    // Drag & drop (assign each item to a bucket via a selector).
    if (q.type === QuestionType.DRAG_DROP) {
      const items = q.matchOptions?.items || [];
      const buckets = q.matchOptions?.buckets || [];
      const map: Record<number, number> = (val && typeof val === 'object') ? val : {};
      return (
        <div className="space-y-3">
          {items.map((it, ii) => (
            <div key={ii} className="flex items-center gap-3">
              <span className="flex-1 p-3 bg-slate-50 border border-slate-200 rounded-xl text-slate-800">{it}</span>
              <span className="text-slate-400">→</span>
              <select className="flex-1 p-3 bg-white border border-slate-300 rounded-xl outline-none"
                value={map[ii] ?? ''} onChange={e => setAnswerFor(q.id, { ...map, [ii]: Number(e.target.value) })}>
                <option value="" disabled>Choose…</option>
                {buckets.map((bk, bi) => <option key={bi} value={bi}>{bk}</option>)}
              </select>
            </div>
          ))}
        </div>
      );
    }

    // Free text (SHORT_TEXT / LONG_TEXT / legacy TEXT).
    const answerText = String(val ?? '');
    const limit = currentQ.wordLimit && currentQ.wordLimit > 0 ? currentQ.wordLimit : null;
    const words = countWords(answerText);
    const atLimit = limit !== null && words >= limit;
    const isShort = q.type === QuestionType.SHORT_TEXT;
    return (
      <div className="relative">
        {isShort ? (
          <input
            type="text"
            className={`w-full p-4 text-base text-slate-800 bg-white border rounded-xl outline-none ${atLimit ? 'border-rose-300' : 'border-slate-300'}`}
            placeholder="Type your answer…"
            value={answerText}
            onChange={e => handleAnswer(limit !== null ? truncateToWords(e.target.value, limit) : e.target.value)}
            onPaste={(e) => e.preventDefault()}
          />
        ) : (
          <textarea
            className={`w-full h-52 sm:h-64 p-4 sm:p-5 text-base text-slate-800 bg-white border rounded-xl outline-none resize-none transition-shadow shadow-sm ${atLimit ? 'border-rose-300' : 'border-slate-300'}`}
            placeholder="Type your answer here..."
            value={answerText}
            onChange={e => handleAnswer(limit !== null ? truncateToWords(e.target.value, limit) : e.target.value)}
            onPaste={(e) => { e.preventDefault(); }}
          />
        )}
        <div className={`absolute bottom-3 right-3 text-xs px-2 py-1 rounded border bg-white ${atLimit ? 'text-rose-600 border-rose-200 font-semibold' : 'text-slate-400'}`}>
          {limit !== null ? `${words} / ${limit} words` : `${words} ${words === 1 ? 'word' : 'words'} · ${answerText.length} chars`}
        </div>
        {atLimit && (
          <div className="absolute bottom-3 left-3 text-xs text-rose-600 bg-rose-50 border border-rose-200 px-2 py-1 rounded">Word limit reached</div>
        )}
      </div>
    );
  };

  // Render Audio Visualizer Bars
  const AudioBars = () => (
    <div className="flex items-end gap-[2px] h-4">
      {[0.38, 0.6, 0.82, 1, 0.84, 0.66, 0.48, 0.3].map((weight, i) => (
        <div 
          key={i} 
          className="w-1 bg-[#1e8e3e] rounded-sm transition-all duration-75"
          style={{
            height: `${Math.max(18, 18 + ((audioLevel / 100) * weight * 82))}%`,
            opacity: audioLevel > (i * 8) + 8 ? 1 : 0.28
          }}
        />
      ))}
    </div>
  );

  return (
    <div className="flex flex-col lg:flex-row h-[100dvh] bg-slate-50 select-none overflow-hidden" onContextMenu={e => e.preventDefault()}>
      {resumePending && (
        <div className="fixed inset-0 z-[190] bg-slate-900/40 flex items-center justify-center p-4">
          <div className="bg-white/95 backdrop-blur rounded-2xl shadow-2xl p-8 max-w-md w-full border border-slate-200 text-center">
            <h2 className="text-2xl font-bold text-slate-900">Resume your attempt?</h2>
            <p className="text-slate-600 mt-2">
              We found a saved attempt. Resuming in <span className="font-semibold text-slate-900">{resumeCountdown}s</span>.
            </p>
            <div className="mt-6 flex flex-col sm:flex-row gap-3">
              <button
                onClick={resumeNow}
                className="flex-1 py-3 bg-[var(--lsc-primary)] text-white rounded-lg hover:bg-[var(--lsc-primary-700)] font-semibold"
              >
                Resume Now
              </button>
              <button
                onClick={discardResume}
                className="flex-1 py-3 border border-slate-200 text-slate-700 rounded-lg hover:bg-slate-50 font-semibold"
              >
                Start Fresh
              </button>
            </div>
            <p className="text-xs text-slate-400 mt-4">
              Autosaved progress restores your answers, timers, and section state.
            </p>
          </div>
        </div>
      )}
      {!introDone && (
        <ExamIntroWalkthrough
          examTitle={exam.title}
          scheduleLabel={`${formatScheduleLabel(exam.startTime, resolveExamTimezone(exam.timezone))} — ${formatScheduleLabel(exam.endTime, resolveExamTimezone(exam.timezone))}`}
          needsCamera={cameraCaptureRequired}
          needsMicrophone={microphoneCaptureRequired}
          needsScreen={screenCaptureRequired}
          needsFullscreen={fullscreenEnforced}
          isMobile={device.isMobile}
          onContinue={() => {
            try { window.localStorage.setItem(introStorageKey, '1'); } catch {}
            setIntroDone(true);
          }}
        />
      )}
      {introDone && permissionStatus !== 'granted' && (
        <PermissionGuide
          status={permissionStatus === 'denied' ? 'denied' : 'pending'}
          problem={mediaProblem}
          busy={permissionBusy}
          device={device}
          needsCamera={cameraCaptureRequired}
          needsMicrophone={microphoneCaptureRequired}
          needsScreen={screenCaptureRequired}
          examTitle={exam.title}
          scheduleLabel={`${formatScheduleLabel(exam.startTime, resolveExamTimezone(exam.timezone))} — ${formatScheduleLabel(exam.endTime, resolveExamTimezone(exam.timezone))}`}
          onGrant={async () => {
            if (permissionBusy) return;
            setPermissionBusy(true);
            try {
              await requestAllPermissions();
            } catch (err) {
              setMediaProblem(classifyMediaError(err));
              setPermissionStatus('denied');
            } finally {
              setPermissionBusy(false);
            }
          }}
        />
      )}

      {permissionStatus === 'granted' && streamLost && (
        <div className="fixed inset-0 z-[200] bg-slate-900/40 flex items-center justify-center p-4">
          <div className="bg-white/95 backdrop-blur rounded-2xl shadow-2xl p-8 max-w-md w-full text-center border border-slate-200">
            <h2 className="text-2xl font-bold text-slate-900">Recording Interrupted</h2>
            <p className="text-slate-600 mt-2">
              Your camera, microphone, or screen share was disconnected. All recordings are compulsory — please reconnect all devices and refresh the page.
            </p>
            <div className="mt-6 space-y-3">
              <button
                onClick={() => window.location.reload()}
                className="w-full py-3 bg-[var(--lsc-primary)] text-white rounded-lg hover:bg-[var(--lsc-primary-700)] font-semibold"
              >
                Refresh Page
              </button>
            </div>
          </div>
        </div>
      )}

      {permissionStatus === 'granted' && fullscreenBlocked && (
        <div className="fixed inset-0 z-[200] bg-slate-900/40 flex items-center justify-center p-4">
          <div className="bg-white/95 backdrop-blur rounded-2xl shadow-2xl p-8 max-w-md w-full text-center border border-slate-200">
            <h2 className="text-2xl font-bold text-slate-900">Fullscreen Required</h2>
            <p className="text-slate-600 mt-2">
              This exam must remain in fullscreen mode. Please re-enter fullscreen to continue.
            </p>
            <div className="mt-6 space-y-3">
              <button
                onClick={() => {
                  requestFullscreen().then(ok => {
                    if (!ok) {
                      showStudentNotice('Fullscreen request blocked by the browser.');
                    }
                  });
                }}
                className="w-full py-3 bg-[var(--lsc-primary)] text-white rounded-lg hover:bg-[var(--lsc-primary-700)] font-semibold"
              >
                Enter Fullscreen
              </button>
            </div>
          </div>
        </div>
      )}


      {permissionStatus === 'granted' && enrollmentPending && (
        <div className="fixed inset-0 z-[210] bg-slate-900/60 flex items-center justify-center p-4">
          <div className="bg-white/95 backdrop-blur rounded-2xl shadow-2xl p-8 max-w-md w-full text-center border border-slate-200">
            <h2 className="text-2xl font-bold text-slate-900">Verify Your Identity</h2>
            <p className="text-slate-600 mt-2 text-sm">
              Before starting, we need to enroll your face for identity verification. Look straight at the
              camera in good lighting and keep your full face visible.
            </p>
            <div className="relative mt-5 mx-auto w-44 h-44 rounded-full overflow-hidden border-4 border-[var(--lsc-primary-50)] bg-slate-900">
              <video
                ref={enrollPreviewRef}
                autoPlay
                playsInline
                muted
                className="w-full h-full object-cover scale-x-[-1]"
              />
            </div>
            {enrollMessage && (
              <p className="mt-4 text-sm text-[#c0492c] font-medium">{enrollMessage}</p>
            )}
            <div className="mt-6 space-y-3">
              <button
                onClick={handleEnrollIdentity}
                disabled={enrollBusy}
                className="w-full py-3 bg-[var(--lsc-primary)] text-white rounded-lg hover:bg-[var(--lsc-primary-700)] font-semibold disabled:opacity-60 disabled:cursor-not-allowed"
              >
                {enrollBusy ? 'Capturing…' : 'Capture & Verify Identity'}
              </button>
              <p className="text-xs text-slate-400">
                Your face signature is stored securely and used only to confirm it is you during the exam.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* --- Floating Violation Toast --- */}
      <div className={`fixed top-4 sm:top-6 left-1/2 max-w-[calc(100vw-1.5rem)] sm:max-w-[calc(100vw-3rem)] transform -translate-x-1/2 z-[100] transition-all duration-300 ${
          feedbackBanner.show ? 'translate-y-0 opacity-100' : '-translate-y-10 opacity-0 pointer-events-none'
      }`}>
        <div className={`flex items-center gap-3 px-4 sm:px-6 py-3 rounded-2xl sm:rounded-full shadow-2xl border backdrop-blur-md ${
             feedbackBanner.type === 'error' ? 'bg-[#d93025]/90 border-[#d93025] text-white' : 'bg-[#e37400]/90 border-[#f0b94e] text-white'
        }`}>
           {feedbackBanner.type === 'error' ? <ShieldAlert size={18} /> : <AlertTriangle size={18} />}
           <span className="font-semibold text-sm tracking-wide break-words">{feedbackBanner.msg}</span>
        </div>
      </div>

      {sidebarOpen && (
        <div
          className="fixed inset-0 z-10 bg-slate-900/35 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* --- Main Exam Area --- */}
      <div className="flex-1 flex flex-col min-h-0 min-w-0 bg-white">
         
         {/* Header */}
         <header className="sticky top-0 min-h-[64px] border-b border-slate-200 flex flex-wrap items-center justify-between gap-3 px-4 sm:px-6 py-3 bg-white/92 backdrop-blur shrink-0 z-10">
            <div className="flex items-center gap-3 min-w-0">
               <div className="w-8 h-8 lsc-brand-mark text-[10px]">LSC</div>
               <div className="min-w-0">
                 <h1 className="text-sm font-bold text-slate-900 leading-none truncate">{exam.title}</h1>
                 <span className="text-xs text-slate-500 font-mono mt-1 block">{student.registrationId}</span>
               </div>
            </div>
            
            <div className="flex flex-wrap items-center gap-3">
                <div className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-[10px] sm:text-xs font-semibold border ${
                  autosaveStatus === 'saving'
                    ? 'bg-amber-50 text-amber-700 border-amber-200'
                    : 'bg-teal-50 text-teal-700 border-teal-200'
                }`}>
                  <span className={`w-2 h-2 rounded-full ${
                    autosaveStatus === 'saving' ? 'bg-amber-500 animate-pulse' : 'bg-teal-500'
                  }`}></span>
                  {autosaveStatus === 'saving' ? 'Saving...' : 'Saved'}
                </div>
                <div className={`flex items-center gap-2 px-4 py-1.5 rounded-full font-mono text-xs sm:text-sm font-semibold transition-colors ${timeLeft < 300 ? 'bg-amber-50 text-amber-700 animate-pulse' : 'bg-slate-100 text-slate-700'}`}>
                   <Clock size={14} />
                   <span>{formatTime(timeLeft)}</span>
                </div>
                {sectionTimeLeft !== null && (
                  <div className={`flex items-center gap-2 px-4 py-1.5 rounded-full font-mono text-xs sm:text-sm font-semibold transition-colors ${sectionTimeLeft < 60 ? 'bg-orange-50 text-orange-700 animate-pulse' : 'bg-blue-50 text-blue-700'}`}>
                    <Disc size={14} />
                    <span>Section {formatTime(sectionTimeLeft)}</span>
                  </div>
                )}
                <button
                  onClick={() => setSidebarOpen(prev => !prev)}
                  className="lg:hidden px-3 py-1.5 rounded-full border border-slate-200 text-xs font-semibold text-slate-600 hover:bg-slate-50"
                >
                  {sidebarOpen ? 'Hide Tools' : 'Show Tools'}
                </button>
            </div>
         </header>

         {/* Question Container */}
         <main className="flex-1 overflow-y-auto relative bg-slate-50">
            <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-6 sm:py-8 lg:py-12 relative z-10">
               {/* Question Meta */}
               <div className="flex flex-col gap-3 sm:flex-row sm:justify-between sm:items-center mb-6">
                  <div className="space-y-1">
                    <span className="text-xs font-bold text-slate-400 uppercase tracking-widest block">
                        Question {overallIndex} of {totalQuestions}
                    </span>
                    {currentQ.sectionTitle && (
                      <span className="text-[10px] font-semibold text-orange-600 uppercase tracking-widest">
                        Section: {currentQ.sectionTitle}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {(currentQ.type === QuestionType.SHORT_TEXT || currentQ.type === QuestionType.LONG_TEXT || currentQ.type === QuestionType.TEXT) && !!currentQ.wordLimit && currentQ.wordLimit > 0 && (
                      // Stated up front: nobody should discover the cap by being cut off mid-sentence.
                      <span className="text-xs font-semibold text-slate-600 bg-slate-100 border border-slate-200 px-2 py-1 rounded">
                        Max {currentQ.wordLimit} words
                      </span>
                    )}
                    <span className="text-xs font-bold text-blue-700 bg-blue-100 px-2 py-1 rounded">
                        {currentQ.marks} Points
                    </span>
                    {!!currentQ.negativeMarks && currentQ.negativeMarks > 0 && (
                      <span className="text-xs font-bold text-red-700 bg-red-100 px-2 py-1 rounded">
                          -{currentQ.negativeMarks} if wrong
                      </span>
                    )}
                  </div>
               </div>

               {/* The Question */}
               <div className="prose prose-lg max-w-none mb-8 sm:mb-10">
                  <h2 className="text-xl sm:text-2xl font-medium text-slate-900 leading-snug whitespace-pre-wrap break-words">
                    {currentQ.text}
                  </h2>
               </div>

               {/* Answer Area */}
               <div className="space-y-4 mb-12">
                  {renderAnswerInput()}
               </div>

               {/* Navigation Buttons */}
               <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-between sm:items-center pt-6 border-t border-slate-200">
                  <button 
                     onClick={moveToPrevious}
                     disabled={currentQuestionIdx === 0 && currentSectionIdx <= minSectionIdx}
                     className="flex items-center justify-center gap-2 px-5 py-2.5 text-slate-600 hover:text-slate-900 font-medium rounded-lg hover:bg-slate-100 transition-colors disabled:opacity-30"
                  >
                     <ChevronLeft size={18} /> Previous
                  </button>

                  <button 
                     onClick={moveToNext}
                     className={`flex items-center justify-center gap-2 px-8 py-2.5 text-white font-medium rounded-lg shadow-lg shadow-blue-200/60 transition-all hover:scale-[1.02] active:scale-[0.98] ${
                        isLast ? 'bg-slate-900 hover:bg-slate-950' : 'bg-[var(--lsc-primary)] hover:bg-[var(--lsc-primary-700)]'
                     }`}
                  >
                     {isLast ? 'Submit Exam' : isLastQuestionInSection ? 'Next Section' : 'Next Question'}
                     {!isLast && <ChevronRight size={18} />}
                  </button>
               </div>
            </div>
         </main>
      </div>

      {/* --- Sidebar (Proctoring & Tools) --- */}
      <aside className={`${sidebarOpen ? 'flex' : 'hidden'} lg:flex fixed inset-y-0 right-0 w-[88vw] max-w-sm lg:static lg:w-72 bg-white/95 backdrop-blur border-l border-slate-200 flex-col z-20 shrink-0 shadow-[0_10px_30px_-20px_rgba(15,23,42,0.4)]`}>
         
         {/* Camera Feed */}
         <div className="p-4 bg-slate-50 border-b border-slate-200">
             <div className="flex justify-between items-center mb-3">
                <span className="text-[10px] font-bold text-slate-500 uppercase tracking-widest flex items-center gap-2">
                   <Monitor size={12} /> Proctoring Active
                </span>
                <div className="flex items-center gap-2">
                  <div className="flex items-center gap-1.5 px-2 py-0.5 bg-red-500/10 border border-red-500/20 rounded text-[10px] font-bold text-red-500 animate-pulse">
                     <div className="w-1.5 h-1.5 rounded-full bg-red-500"></div> REC
                  </div>
                  <button
                    onClick={() => setSidebarOpen(false)}
                    className="lg:hidden p-1.5 rounded-lg border border-slate-200 text-slate-500 hover:bg-white"
                    aria-label="Close tools"
                  >
                    <X size={14} />
                  </button>
                </div>
             </div>

             <div className="relative aspect-[4/3] rounded-lg overflow-hidden border border-slate-200 bg-slate-900 shadow-inner mb-3">
                <video
                   ref={videoRef}
                   autoPlay
                   playsInline
                   muted
                   className="w-full h-full object-cover opacity-85"
                />
                {/* Live face-detection status badge — proves detection is running */}
                <div className="absolute top-2 left-2 flex items-center gap-1.5 rounded-md bg-slate-900/70 px-2 py-1 text-[10px] font-semibold">
                   {proctorLive.faceCount === null ? (
                     <span className="flex items-center gap-1 text-amber-300">
                       <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" /> Detecting…
                     </span>
                   ) : proctorLive.faceCount === 1 ? (
                     proctorLive.gazeAway ? (
                       <span className="flex items-center gap-1 text-amber-300">
                         <span className="w-1.5 h-1.5 rounded-full bg-amber-400" /> Looking away
                       </span>
                     ) : (
                       <span className="flex items-center gap-1 text-teal-300">
                         <span className="w-1.5 h-1.5 rounded-full bg-teal-400" /> Face OK
                       </span>
                     )
                   ) : proctorLive.faceCount === 0 ? (
                     <span className="flex items-center gap-1 text-rose-300">
                       <span className="w-1.5 h-1.5 rounded-full bg-rose-400" /> No face
                     </span>
                   ) : (
                     <span className="flex items-center gap-1 text-rose-300">
                       <span className="w-1.5 h-1.5 rounded-full bg-rose-400" /> {proctorLive.faceCount} faces
                     </span>
                   )}
                </div>
                {/* Audio Viz Overlay */}
                <div className="absolute bottom-2 right-2 rounded-md bg-slate-900/60 px-2 py-1">
                   <AudioBars />
                </div>
             </div>

             <div className="grid grid-cols-2 gap-2 text-[10px] font-mono text-slate-500">
                {microphoneCaptureRequired ? (
                  <div className={`col-span-2 flex items-center gap-2 px-2 py-1.5 rounded border ${
                    micStatus === 'listening'
                      ? 'bg-teal-50 border-teal-200 text-teal-700'
                      : micStatus === 'suspended'
                        ? 'bg-amber-50 border-amber-200 text-amber-700'
                        : 'bg-white border-slate-200 text-slate-500'
                  }`}>
                    {micStatus === 'off'
                      ? <MicOff size={11} />
                      : <Mic size={11} className={micStatus === 'listening' ? 'text-teal-600' : 'text-amber-600'} />}
                    <span className="font-semibold">
                      {micStatus === 'listening' ? 'Mic listening' : micStatus === 'suspended' ? 'Tap screen to enable mic' : 'Mic off'}
                    </span>
                    {/* Live level meter — proves audio is actually flowing when you speak. */}
                    <div className="ml-auto h-1.5 w-16 rounded-full bg-slate-200 overflow-hidden">
                      <div
                        className={`h-full transition-[width] duration-75 ${micStatus === 'listening' ? 'bg-teal-500' : 'bg-amber-400'}`}
                        style={{ width: `${Math.min(100, audioLevel)}%` }}
                      />
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center gap-1.5 bg-white px-2 py-1 rounded border border-slate-200">
                     <Wifi size={10} className="text-teal-500" /> Signal: Good
                  </div>
                )}
                {screenCaptureRequired && (
                  <div className={`flex items-center gap-2 px-2 py-1.5 rounded border ${
                    screenShareStatus === 'granted'
                      ? 'bg-teal-50 border-teal-200 text-teal-700'
                      : 'bg-rose-50 border-rose-200 text-rose-700'
                  }`}>
                    <Monitor size={11} className={screenShareStatus === 'granted' ? 'text-teal-600' : 'text-rose-600'} />
                    <span className="font-semibold">
                      {screenShareStatus === 'granted' ? 'Screen recording' : 'Screen share stopped'}
                    </span>
                  </div>
                )}
             </div>
         </div>

         {/* Question Map */}
         <div className="flex-1 overflow-y-auto p-4 scrollbar-thin scrollbar-thumb-slate-200 scrollbar-track-transparent">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">
                 Question Map
              </h3>
              {activeSections.length > 1 && (
                <span className="text-[10px] text-slate-400">
                  Section {currentSectionIdx + 1}/{activeSections.length}
                </span>
              )}
            </div>
            <div className="grid grid-cols-5 gap-2">
               {currentSection.questions.map((q, idx) => {
                  const isActive = currentQuestionIdx === idx;
                  const isAnswered = answers[q.id] !== undefined;
                  return (
                     <button 
                        key={q.id}
                        onClick={() => recordQuestionTime(currentSectionIdx, idx)}
                        className={`aspect-square rounded flex items-center justify-center text-xs font-medium transition-all relative ${
                           isActive 
                              ? 'bg-[var(--lsc-primary)] text-white shadow-lg shadow-blue-200/70 scale-105 z-10'
                              : isAnswered
                                 ? 'bg-teal-50 text-teal-700 border border-teal-200 hover:bg-teal-100'
                                 : 'bg-white text-slate-500 border border-slate-200 hover:bg-slate-50 hover:text-slate-700'
                        }`}
                     >
                        {idx + 1}
                        {isAnswered && !isActive && (
                           <div className="absolute bottom-1 w-1 h-1 rounded-full bg-teal-500"></div>
                        )}
                     </button>
                  );
               })}
            </div>
         </div>

         {/* Session Status */}
         <div className="p-4 border-t border-slate-200 bg-slate-50">
            <div className="flex items-center justify-between mb-3">
               <h3 className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">
                  Session Status
               </h3>
               <span className="text-[10px] font-bold text-teal-600 bg-teal-500/10 px-1.5 py-0.5 rounded">
                 Monitoring
               </span>
            </div>
            <div className="flex items-start gap-2 text-xs text-slate-600 p-2 rounded bg-white border border-slate-200">
              <CheckCircle2 size={14} className="text-teal-600 mt-0.5" />
              <span>
                Proctoring is active. Alerts are reviewed by administrators after submission.
              </span>
            </div>
            <div className="mt-2 flex items-center justify-between text-xs p-2 rounded bg-white border border-slate-200">
              <span className="text-slate-500">Alerts this session</span>
              <span className={`font-bold px-1.5 py-0.5 rounded ${violations.length > 0 ? 'text-rose-600 bg-rose-500/10' : 'text-teal-600 bg-teal-500/10'}`}>
                {violations.length}
              </span>
            </div>
         </div>
      </aside>
    </div>
  );
};
