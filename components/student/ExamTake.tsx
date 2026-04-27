import React, { useState, useEffect, useRef } from 'react';
import { Exam, QuestionType, ViolationLog, Student, Question } from '../../types';
import { Clock, Wifi, BatteryCharging, AlertTriangle, ShieldAlert, ChevronLeft, ChevronRight, CheckCircle2, Monitor, Disc, X } from 'lucide-react';
import { apiPost, apiPostForm } from '../../services/api';

type ViolationCategory = 'camera' | 'microphone' | 'fullscreen' | 'copyPaste' | 'tabSwitch' | 'environment';

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
  const [answers, setAnswers] = useState<Record<string, string | number>>({});
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
  const lastViolationTime = useRef<number>(0);
  const audioContextRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [permissionStatus, setPermissionStatus] = useState<'pending' | 'granted' | 'denied'>('pending');
  const recordingEnabled = true;
  const cameraCaptureRequired = exam.proctoringConfig.cameraRequired || recordingEnabled;
  const microphoneCaptureRequired = exam.proctoringConfig.microphoneRequired;
  const permissionsRequired = cameraCaptureRequired || microphoneCaptureRequired;
  const faceDetectorRef = useRef<any>(null);
  const faceMlModelRef = useRef<any>(null);
  const [faceMlReady, setFaceMlReady] = useState(false);
  const objectDetectorRef = useRef<any>(null);
  const [objectModelReady, setObjectModelReady] = useState(false);
  const audioRafRef = useRef<number | null>(null);
  const audioProfileRef = useRef({
    ambientRms: 0.018,
    ambientSpeechRatio: 0.22,
    voiceStrikes: 0,
    conversationStrikes: 0,
    noiseStrikes: 0,
    lastSpeechAt: 0,
  });
  const [fullscreenBlocked, setFullscreenBlocked] = useState(false);
  const [multiDisplayDetected, setMultiDisplayDetected] = useState(false);
  const examBlocked = permissionStatus !== 'granted' || fullscreenBlocked || multiDisplayDetected;
  const proctoringArmedRef = useRef(false);
  const finishingRef = useRef(false);
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
  const recordingSessionIdRef = useRef<number | null>(null);
  const recordingStartTsRef = useRef<number>(0);
  const recordingStartedRef = useRef(false);
  const recordingCompleteSentRef = useRef(false);
  const screenStreamRef = useRef<MediaStream | null>(null);
  const combinedStreamRef = useRef<MediaStream | null>(null);
  const combinedCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const compositorRafRef = useRef<number | null>(null);
  const recorderRefs = useRef<Partial<Record<'camera' | 'screen' | 'combined', MediaRecorder>>>({});
  const uploadSeqRef = useRef<Record<'camera' | 'screen' | 'combined', number>>({
    camera: 0,
    screen: 0,
    combined: 0,
  });
  const compositeFrameRef = useRef({
    lastAt: 0,
    targetFrameMs: 1000 / 15,
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
    const noFaceGraceMs = 7000; // tolerate short detector misses while student is in frame
    const noFaceStrikeLimit = 4; // require sustained misses before violation
    const multiFaceStrikeLimit = 2; // 2 consecutive frames with >1 face

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
    const strikeLimit = 5;
    if (isAway) {
      state.gazeAwayStrikes += 1;
    } else {
      state.gazeAwayStrikes = Math.max(0, state.gazeAwayStrikes - 2);
    }
    if (state.gazeAwayStrikes >= strikeLimit) {
      state.gazeAwayStrikes = 0;
      return true;
    }
    return false;
  };

  const stopCompositor = () => {
    if (compositorRafRef.current) {
      window.cancelAnimationFrame(compositorRafRef.current);
      compositorRafRef.current = null;
    }
    if (combinedStreamRef.current) {
      combinedStreamRef.current.getTracks().forEach(track => track.stop());
      combinedStreamRef.current = null;
    }
    combinedCanvasRef.current = null;
  };

  const stopPrimaryProctoringStream = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
  };

  const uploadRecordingChunk = async (streamType: 'camera' | 'screen' | 'combined', blob: Blob) => {
    const recordingId = recordingSessionIdRef.current;
    if (!recordingId || blob.size <= 0) return;
    const form = new FormData();
    form.append('action', 'CHUNK');
    form.append('recordingId', String(recordingId));
    form.append('streamType', streamType);
    form.append('mimeType', blob.type || 'video/webm');
    form.append('sequence', String(uploadSeqRef.current[streamType]++));
    form.append('chunk', blob, `${streamType}_${Date.now()}.webm`);
    try {
      await apiPostForm('recordings.php', form);
    } catch (e) {
      console.error(`Failed to upload ${streamType} recording chunk:`, e);
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
        uploadRecordingChunk(streamType, e.data);
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

  const requestScreenCapture = async () => {
    if (!recordingEnabled) return null;
    if (!navigator.mediaDevices?.getDisplayMedia) {
      throw new Error('Screen capture is not supported in this browser.');
    }
    if (screenStreamRef.current) {
      screenStreamRef.current.getTracks().forEach(track => track.stop());
      screenStreamRef.current = null;
    }
    const screenStream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        frameRate: { ideal: 15, max: 20 },
        width: { ideal: 1920, max: 1920 },
        height: { ideal: 1080, max: 1080 },
      },
      audio: false,
    });
    const track = screenStream.getVideoTracks()[0];
    setTrackContentHint(track, 'detail');
    if (track) {
      track.onended = () => {
        if (!finishOnceRef.current) {
          setPermissionStatus('denied');
          showStudentNotice('Screen sharing stopped. Please grant permissions again.');
        }
      };
    }
    screenStreamRef.current = screenStream;
    return screenStream;
  };

  const requestAllPermissions = async () => {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: cameraCaptureRequired
        ? {
            width: { ideal: 960, max: 1280, min: 640 },
            height: { ideal: 540, max: 720, min: 360 },
            frameRate: { ideal: 24, max: 30 },
            facingMode: "user"
          }
        : false,
      audio: microphoneCaptureRequired
        ? {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          }
        : false
    });
    setTrackContentHint(stream.getVideoTracks()[0], 'motion');
    setTrackContentHint(stream.getAudioTracks()[0], 'speech');
    try {
      if (recordingEnabled) {
        await requestScreenCapture();
      }
    } catch (e) {
      stream.getTracks().forEach(track => track.stop());
      throw e;
    }
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

    let screenStream: MediaStream | null = screenStreamRef.current;
    if (!screenStream) {
      try {
        screenStream = await requestScreenCapture();
      } catch (e) {
        console.warn('Screen recording permission denied/unavailable:', e);
      }
    }
    if (!screenStream) {
      setPermissionStatus('denied');
      recordingStartedRef.current = false;
      return;
    }
    createRecorder('screen', screenStream, { videoBitsPerSecond: 900000 });

    const baseVideo = document.createElement('video');
    const camVideo = document.createElement('video');
    baseVideo.muted = true;
    camVideo.muted = true;
    baseVideo.playsInline = true;
    camVideo.playsInline = true;
    baseVideo.autoplay = true;
    camVideo.autoplay = true;
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
    const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true } as any);
    if (ctx) {
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      compositeFrameRef.current.lastAt = 0;
      const draw = () => {
        const now = performance.now();
        if ((now - compositeFrameRef.current.lastAt) < compositeFrameRef.current.targetFrameMs) {
          compositorRafRef.current = window.requestAnimationFrame(draw);
          return;
        }
        compositeFrameRef.current.lastAt = now;
        ctx.fillStyle = '#0f172a';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        try {
          ctx.drawImage(baseVideo, 0, 0, canvas.width, canvas.height);
        } catch {
          // ignore
        }
        const w = Math.round(canvas.width * 0.2);
        const h = Math.round(w * 0.7);
        const pad = Math.max(16, Math.round(canvas.width * 0.018));
        const x = canvas.width - w - pad;
        const y = canvas.height - h - pad;
        ctx.fillStyle = 'rgba(15,23,42,0.6)';
        ctx.fillRect(x - 4, y - 4, w + 8, h + 8);
        try {
          ctx.drawImage(camVideo, x, y, w, h);
        } catch {
          // ignore
        }
        compositorRafRef.current = window.requestAnimationFrame(draw);
      };
      compositorRafRef.current = window.requestAnimationFrame(draw);
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

    if (exam.proctoringConfig.microphoneRequired) {
      const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
      audioContextRef.current = audioContext;
      await audioContext.resume().catch(() => {});
      const analyser = audioContext.createAnalyser();
      const microphone = audioContext.createMediaStreamSource(stream);

      analyser.smoothingTimeConstant = 0.72;
      analyser.fftSize = 2048;

      microphone.connect(analyser);

      const dataArray = new Uint8Array(analyser.fftSize);
      const frequencyData = new Uint8Array(analyser.frequencyBinCount);
      const detectAudio = () => {
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
        const speechBandEnergy = getBandEnergy(frequencyData, audioContext.sampleRate, analyser.fftSize, 180, 2600);
        const lowBandEnergy = getBandEnergy(frequencyData, audioContext.sampleRate, analyser.fftSize, 20, 140);
        const highBandEnergy = getBandEnergy(frequencyData, audioContext.sampleRate, analyser.fftSize, 3200, 7000);
        const totalEnergy = getBandEnergy(frequencyData, audioContext.sampleRate, analyser.fftSize, 20, 7000);
        const zeroCrossingRate = getZeroCrossingRate(dataArray);

        const level = Math.min(100, Math.round((rms * 160) + (speechBandEnergy * 55)));
        setAudioLevel(level);

        const profile = audioProfileRef.current;
        profile.ambientRms = Math.max(0.008, (profile.ambientRms * 0.985) + (rms * 0.015));
        profile.ambientSpeechRatio = Math.max(
          0.08,
          (profile.ambientSpeechRatio * 0.985) + (((speechBandEnergy / Math.max(totalEnergy, 0.001))) * 0.015)
        );

        const speechRatio = speechBandEnergy / Math.max(totalEnergy, 0.001);
        const speechDominant = speechBandEnergy > lowBandEnergy * 1.1 && speechBandEnergy > highBandEnergy * 0.95;
        const likelySpeech =
          rms > Math.max(0.03, profile.ambientRms * 2.4) &&
          speechRatio > Math.max(0.32, profile.ambientSpeechRatio + 0.12) &&
          speechDominant &&
          zeroCrossingRate >= 0.015 &&
          zeroCrossingRate <= 0.18;

        const loudNoiseOnly =
          rms > Math.max(0.05, profile.ambientRms * 3.6) &&
          !speechDominant &&
          speechRatio < Math.max(0.24, profile.ambientSpeechRatio + 0.04);

        if (likelySpeech) {
          profile.voiceStrikes += 1;
          profile.conversationStrikes += rms > Math.max(0.04, profile.ambientRms * 2.8) ? 1 : 0;
          profile.noiseStrikes = 0;
        } else if (loudNoiseOnly) {
          profile.noiseStrikes += 1;
          profile.voiceStrikes = Math.max(0, profile.voiceStrikes - 2);
          profile.conversationStrikes = Math.max(0, profile.conversationStrikes - 2);
        } else {
          profile.voiceStrikes = Math.max(0, profile.voiceStrikes - 1);
          profile.conversationStrikes = Math.max(0, profile.conversationStrikes - 1);
          profile.noiseStrikes = Math.max(0, profile.noiseStrikes - 1);
        }

        if (profile.conversationStrikes >= 36 && (Date.now() - profile.lastSpeechAt) > 9000) {
          profile.lastSpeechAt = Date.now();
          profile.voiceStrikes = 0;
          profile.conversationStrikes = 0;
          triggerProctorFeedback('AUDIO_DETECTED', 'Sustained speech or background conversation detected.', {
            confidence: 0.88,
            metadata: {
              level,
              rms: Number(rms.toFixed(4)),
              speechRatio: Number(speechRatio.toFixed(3)),
              event: 'sustained_conversation'
            }
          });
        } else if (profile.voiceStrikes >= 18 && (Date.now() - profile.lastSpeechAt) > 9000) {
          profile.lastSpeechAt = Date.now();
          profile.voiceStrikes = 0;
          profile.conversationStrikes = Math.max(0, profile.conversationStrikes - 8);
          triggerProctorFeedback('AUDIO_DETECTED', 'Speech detected near the microphone. Please avoid speaking.', {
            confidence: 0.76,
            metadata: {
              level,
              rms: Number(rms.toFixed(4)),
              speechRatio: Number(speechRatio.toFixed(3)),
              event: 'voice_activity'
            }
          });
        } else if (profile.noiseStrikes >= 28) {
          profile.noiseStrikes = 0;
          showStudentNotice('Background noise detected, but it was below the speech threshold.');
        }

        audioRafRef.current = window.requestAnimationFrame(detectAudio);
      };

      audioAnalysisFrameRef.current = 0;
      audioRafRef.current = window.requestAnimationFrame(detectAudio);
    }

    if (exam.proctoringConfig.fullScreenEnforced) {
      await requestFullscreen();
    }
  };

  // 1. Proctoring Setup (Camera, Microphone, Screen)
  useEffect(() => {
    const startProctoring = async () => {
      try {
        if (!permissionsRequired) {
          setPermissionStatus('granted');
          return;
        }

        await requestAllPermissions();

      } catch (err) {
        console.error("Proctoring failed to start", err);
        setPermissionStatus('denied');
        triggerProctorFeedback('NO_FACE', 'Camera/Microphone/Screen access failed. Please check permissions.', { bypassActive: true });
      }
    };

    startProctoring();

    return () => {
        void shutdownExamCapture('FAILED');
    };
  }, [exam]);

  useEffect(() => {
    if (permissionStatus !== 'granted') return;
    void startRecordingPipeline();
  }, [permissionStatus]);

  useEffect(() => {
    if (permissionStatus === 'granted' && !fullscreenBlocked && !multiDisplayDetected) {
      proctoringArmedRef.current = true;
    }
  }, [permissionStatus, fullscreenBlocked, multiDisplayDetected]);

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
    };
  }, [permissionStatus]);

  // Fullscreen prompt when required
  useEffect(() => {
    if (!exam.proctoringConfig.fullScreenEnforced) {
      setFullscreenBlocked(false);
      return;
    }
    if (permissionStatus !== 'granted') return;
    if (!document.fullscreenElement) {
      setFullscreenBlocked(true);
    }
  }, [permissionStatus, exam.proctoringConfig.fullScreenEnforced]);

  // Fullscreen enforcement
  useEffect(() => {
    if (!exam.proctoringConfig.fullScreenEnforced) return;
    const onFsChange = () => {
      const inFs = !!document.fullscreenElement;
      if (!inFs) {
        setFullscreenBlocked(true);
        if (!finishingRef.current) {
          triggerProctorFeedback('FULLSCREEN_EXIT', 'Fullscreen exited. Please return to fullscreen.');
        }
      } else {
        setFullscreenBlocked(false);
        finishingRef.current = false;
      }
    };
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  }, [exam.proctoringConfig.fullScreenEnforced]);

  // External display detection (best effort)
  useEffect(() => {
    if (permissionStatus !== 'granted') return;
    let cancelled = false;

    const checkDisplays = async () => {
      if (cancelled) return;
      try {
        const navAny = navigator as any;
        if (typeof navAny.getScreens === 'function') {
          const screens = await navAny.getScreens();
          const count = Array.isArray(screens?.screens) ? screens.screens.length : 1;
          setMultiDisplayDetected(count > 1);
        } else if ((window.screen as any)?.isExtended === true) {
          setMultiDisplayDetected(true);
        } else {
          setMultiDisplayDetected(false);
        }
      } catch {
        setMultiDisplayDetected(false);
      }
    };

    checkDisplays();
    const id = window.setInterval(checkDisplays, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [permissionStatus]);

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

  // 1b. High-level ML face detection (BlazeFace) with stable multi-frame logic
  useEffect(() => {
    let cancelled = false;
    const loadFaceModel = async () => {
      if (permissionStatus !== 'granted' || !exam.proctoringConfig.cameraRequired) return;
      try {
        const tf = await import('@tensorflow/tfjs');
        await tf.ready();
        if (tf.getBackend() !== 'webgl') {
          await tf.setBackend('webgl').catch(() => {});
          await tf.ready();
        }
        const blazeface = await import('@tensorflow-models/blazeface');
        const model = await blazeface.load({
          maxFaces: 3,
          scoreThreshold: 0.7,
          iouThreshold: 0.25,
        });
        if (!cancelled) {
          faceMlModelRef.current = model;
          setFaceMlReady(true);
        }
      } catch (e) {
        console.warn('Face ML model failed to load. Falling back to native detector.', e);
      }
    };

    loadFaceModel();
    return () => {
      cancelled = true;
      faceMlModelRef.current = null;
      setFaceMlReady(false);
    };
  }, [permissionStatus, exam.proctoringConfig.cameraRequired]);

  useEffect(() => {
    if (permissionStatus !== 'granted' || !exam.proctoringConfig.cameraRequired) return;
    let cancelled = false;

    const detectFaces = async () => {
      if (cancelled || !videoRef.current) return;
      const videoEl = videoRef.current;
      if (videoEl.readyState < 2 || videoEl.videoWidth < 100 || videoEl.videoHeight < 100) return;

      let faceCount: number | null = null;
      let attentionAway = false;
      try {
        if (faceMlModelRef.current) {
          const predictions = await faceMlModelRef.current.estimateFaces(videoEl, false);
          if (Array.isArray(predictions)) {
            const accepted = predictions.filter((p: any) => {
              const score = getPredictionScore(p);
              const areaRatio = getBlazeFaceAreaRatio(p, videoEl);
              const scorePass = score === null || score >= 0.55;
              return scorePass && areaRatio >= 0.008;
            });
            faceCount = accepted.length;
            if (accepted.length === 1) {
              attentionAway = estimateAttentionAway(accepted[0], videoEl);
            }
          } else {
            faceCount = 0;
          }
        } else if ((window as any).FaceDetector) {
          if (!faceDetectorRef.current) {
            faceDetectorRef.current = new (window as any).FaceDetector({ fastMode: true, maxDetectedFaces: 3 });
          }
          const faces = await faceDetectorRef.current.detect(videoEl);
          faceCount = Array.isArray(faces) ? faces.length : 0;
        }
      } catch {
        // ignore detector frame errors
      }

      if (faceCount === null) return;
      const signal = updateFaceSignal(faceCount);
      if (signal === 'NO_FACE') {
        triggerProctorFeedback('NO_FACE', 'No face detected. Please stay in frame.', { confidence: 0.82 });
      } else if (signal === 'MULTIPLE_FACES') {
        triggerProctorFeedback('MULTIPLE_FACES', 'Multiple faces detected. Only one person allowed.', { confidence: 0.9, metadata: { faceCount } });
      } else if (faceCount === 1 && faceMlModelRef.current && updateGazeSignal(attentionAway)) {
        triggerProctorFeedback('GAZE_AWAY', 'Attention drift detected. Please keep your face centered on the exam screen.', { confidence: 0.72 });
      }
    };

    const loop = async () => {
      while (!cancelled) {
        await detectFaces();
        await new Promise(resolve => window.setTimeout(resolve, 900));
      }
    };

    void loop();
    return () => {
      cancelled = true;
    };
  }, [permissionStatus, exam.proctoringConfig.cameraRequired, faceMlReady]);

  // 1c. Object detection (cell phone) using coco-ssd if available
  useEffect(() => {
    let cancelled = false;
    const loadModel = async () => {
      if (permissionStatus !== 'granted') return;
      try {
        const tf = await import('@tensorflow/tfjs');
        await tf.ready();
        if (tf.getBackend() !== 'webgl') {
          await tf.setBackend('webgl').catch(() => {});
          await tf.ready();
        }
        const coco = await import('@tensorflow-models/coco-ssd');
        const model = await coco.load({ base: 'mobilenet_v2' });
        if (!cancelled) {
          objectDetectorRef.current = model;
          setObjectModelReady(true);
        }
      } catch (e) {
        console.warn('Object detection model failed to load:', e);
      }
    };
    loadModel();
    return () => {
      cancelled = true;
    };
  }, [permissionStatus]);

  useEffect(() => {
    if (permissionStatus !== 'granted') return;
    if (!objectModelReady || !objectDetectorRef.current) return;
    let cancelled = false;

    const detectObjects = async () => {
      if (!videoRef.current) return;
      try {
        const videoEl = videoRef.current;
        if (!videoEl || videoEl.readyState < 2 || videoEl.videoWidth < 100 || videoEl.videoHeight < 100) return;
        const predictions = await objectDetectorRef.current.detect(videoEl);

        const phoneCandidates = predictions.filter((p: any) => {
          const label = String(p.class || '').toLowerCase().trim();
          const score = Number(p.score || 0);
          const areaRatio = getObjectAreaRatio(p, videoEl);
          if (label === 'cell phone' || label === 'mobile phone' || label === 'phone') {
            return score >= 0.33 && areaRatio >= 0.003;
          }
          if (label === 'remote') {
            return score >= 0.62 && areaRatio >= 0.003;
          }
          return false;
        });

        const anomalyCandidates = predictions.filter((p: any) => {
          const label = String(p.class || '').toLowerCase().trim();
          const score = Number(p.score || 0);
          const areaRatio = getObjectAreaRatio(p, videoEl);
          return ['laptop', 'book', 'tv', 'keyboard', 'mouse'].includes(label) && score >= 0.5 && areaRatio >= 0.01;
        });

        if (phoneCandidates.length > 0) {
          objectSignalRef.current.phoneHits += 1;
        } else {
          objectSignalRef.current.phoneHits = Math.max(0, objectSignalRef.current.phoneHits - 1);
        }

        if (anomalyCandidates.length > 0) {
          objectSignalRef.current.anomalyHits += 1;
        } else {
          objectSignalRef.current.anomalyHits = Math.max(0, objectSignalRef.current.anomalyHits - 1);
        }

        const strongPhone = phoneCandidates.some((p: any) => Number(p.score || 0) >= 0.55);
        if (strongPhone || objectSignalRef.current.phoneHits >= 2) {
          const confidence = Math.max(...phoneCandidates.map((p: any) => Number(p.score || 0)), 0.65);
          objectSignalRef.current.phoneHits = 0;
          triggerProctorFeedback('PHONE_DETECTED', 'Cell phone detected in frame.', {
            confidence,
            metadata: {
              objects: phoneCandidates.slice(0, 3).map((p: any) => ({ label: p.class, score: Number(p.score || 0) }))
            }
          });
        }

        if (objectSignalRef.current.anomalyHits >= 3) {
          const confidence = Math.max(...anomalyCandidates.map((p: any) => Number(p.score || 0)), 0.6);
          objectSignalRef.current.anomalyHits = 0;
          triggerProctorFeedback('ANOMALY_OBJECT', 'Suspicious object detected in frame.', {
            confidence,
            metadata: {
              objects: anomalyCandidates.slice(0, 4).map((p: any) => ({ label: p.class, score: Number(p.score || 0) }))
            }
          });
        }
      } catch {
        // ignore
      }
    };

    const loop = async () => {
      while (!cancelled) {
        await detectObjects();
        await new Promise(resolve => window.setTimeout(resolve, 1400));
      }
    };

    void loop();
    return () => {
      cancelled = true;
    };
  }, [permissionStatus, objectModelReady]);

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

  // 3. Security Event Listeners
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.hidden) {
        triggerProctorFeedback('TAB_SWITCH', 'Exam window hidden. Incident logged.');
      }
    };
    
    const handleBlur = () => {
      triggerProctorFeedback('TAB_SWITCH', 'Focus lost. Return to exam immediately.');
    };

    const preventContext = (e: Event) => {
      e.preventDefault();
    };
    const preventClipboard = (e: Event) => {
      e.preventDefault();
      triggerProctorFeedback('COPY_PASTE', 'Copy/paste is blocked during the exam.');
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("blur", handleBlur);
    document.addEventListener("contextmenu", preventContext);
    document.addEventListener("copy", preventClipboard);
    document.addEventListener("paste", preventClipboard);
    document.addEventListener("cut", preventClipboard);

    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("blur", handleBlur);
      document.removeEventListener("contextmenu", preventContext);
      document.removeEventListener("copy", preventClipboard);
      document.removeEventListener("paste", preventClipboard);
      document.removeEventListener("cut", preventClipboard);
    };
  }, []);

  const captureSnapshot = (): string | undefined => {
    if (videoRef.current) {
      const canvas = document.createElement('canvas');
      canvas.width = 320;
      canvas.height = 240;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.drawImage(videoRef.current, 0, 0, canvas.width, canvas.height);
        return canvas.toDataURL('image/jpeg', 0.5);
      }
    }
    return undefined;
  };

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
  };

  const buildViolationSummary = (trigger?: { category?: ViolationCategory; type?: ViolationLog['type'] }) => ({
    total: Object.values(violationTypeCountsRef.current).reduce((sum, val) => sum + val, 0),
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
    const cooldown = type === 'COPY_PASTE' ? 1000 : 4000;
    if (now - lastViolationTime.current < cooldown) return;
    
    lastViolationTime.current = now;
    
    const evidenceImage = captureSnapshot();
    const newViolation: ViolationLog = { 
      timestamp: now, 
      type, 
      description,
      snapshot: evidenceImage,
      category: violationCategoriesByType[type]?.[0] === 'microphone'
        ? 'microphone'
        : violationCategoriesByType[type]?.[0] === 'environment'
          ? 'location'
          : violationCategoriesByType[type]?.[0] === 'fullscreen'
            ? 'screen'
            : violationCategoriesByType[type]?.[0] === 'copyPaste' || violationCategoriesByType[type]?.[0] === 'tabSwitch'
              ? 'browser'
              : 'camera',
      confidence: options?.confidence,
      metadata: options?.metadata,
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
    apiPost('violations.php', { examId: exam.id, studentId: student.id, violation: newViolation }).catch(() => {});
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
      const currentSection = activeSections[currentSectionIdx];
      const currentQuestion = currentSection?.questions[currentQuestionIdx];
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
        answers,
        violations,
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
        await shutdownExamCapture(opts?.terminated ? 'FAILED' : 'COMPLETED');
        try {
          localStorage.removeItem(storageKey);
        } catch {
          // ignore storage errors
        }
        onFinish(payload);
      })();
  };

  const handleAnswer = (val: string | number) => {
    const currentSection = activeSections[currentSectionIdx];
    const currentQuestion = currentSection?.questions[currentQuestionIdx];
    if (!currentQuestion) return;
    setAnswers(prev => ({ ...prev, [currentQuestion.id]: val }));
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

  if (totalQuestions === 0) {
      return (
        <div className="min-h-screen flex items-center justify-center bg-gray-50 text-gray-500 font-medium">
          <div className="flex flex-col items-center gap-4">
             <div className="w-8 h-8 border-4 border-[#3558ff] border-t-transparent rounded-full animate-spin"></div>
             Loading Exam Content...
          </div>
        </div>
      );
  }

  const currentSection = activeSections[currentSectionIdx];
  const currentQ = currentSection.questions[currentQuestionIdx];
  const isLastQuestionInSection = currentQuestionIdx === currentSection.questions.length - 1;
  const isLastSection = currentSectionIdx === activeSections.length - 1;
  const isLast = isLastSection && isLastQuestionInSection;
  const overallIndex = activeSections
    .slice(0, currentSectionIdx)
    .reduce((sum, section) => sum + section.questions.length, 0) + currentQuestionIdx + 1;

  // Render Audio Visualizer Bars
  const AudioBars = () => (
    <div className="flex items-end gap-[2px] h-4">
      {[0.38, 0.6, 0.82, 1, 0.84, 0.66, 0.48, 0.3].map((weight, i) => (
        <div 
          key={i} 
          className="w-1 bg-[#0f9f8c] rounded-sm transition-all duration-75"
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
            <h2 className="text-2xl font-bold text-gray-900">Resume your attempt?</h2>
            <p className="text-gray-600 mt-2">
              We found a saved attempt. Resuming in <span className="font-semibold text-slate-900">{resumeCountdown}s</span>.
            </p>
            <div className="mt-6 flex flex-col sm:flex-row gap-3">
              <button
                onClick={resumeNow}
                className="flex-1 py-3 bg-[#3558ff] text-white rounded-lg hover:bg-[#2643d6] font-semibold"
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
      {permissionStatus !== 'granted' && (
        <div className="fixed inset-0 z-[200] bg-slate-900/40 flex items-center justify-center p-4">
          <div className="bg-white/95 backdrop-blur rounded-2xl shadow-2xl p-8 max-w-md w-full text-center border border-slate-200">
            <h2 className="text-2xl font-bold text-gray-900">Permissions Required</h2>
            <p className="text-gray-600 mt-2">
              This exam cannot start until camera, microphone, and screen capture permissions are granted.
            </p>
            <div className="mt-6 space-y-3">
              <button
                onClick={async () => {
                  setPermissionStatus('pending');
                  try {
                    await requestAllPermissions();
                  } catch (err) {
                    setPermissionStatus('denied');
                  }
                }}
                className="w-full py-3 bg-[#3558ff] text-white rounded-lg hover:bg-[#2643d6] font-semibold"
              >
                Grant Permissions
              </button>
              <p className="text-xs text-gray-400">
                If you denied permissions, update them in your browser settings and retry.
              </p>
            </div>
          </div>
        </div>
      )}

      {permissionStatus === 'granted' && fullscreenBlocked && (
        <div className="fixed inset-0 z-[200] bg-slate-900/40 flex items-center justify-center p-4">
          <div className="bg-white/95 backdrop-blur rounded-2xl shadow-2xl p-8 max-w-md w-full text-center border border-slate-200">
            <h2 className="text-2xl font-bold text-gray-900">Fullscreen Required</h2>
            <p className="text-gray-600 mt-2">
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
                className="w-full py-3 bg-[#3558ff] text-white rounded-lg hover:bg-[#2643d6] font-semibold"
              >
                Enter Fullscreen
              </button>
            </div>
          </div>
        </div>
      )}

      {permissionStatus === 'granted' && multiDisplayDetected && (
        <div className="fixed inset-0 z-[200] bg-slate-900/40 flex items-center justify-center p-4">
          <div className="bg-white/95 backdrop-blur rounded-2xl shadow-2xl p-8 max-w-md w-full text-center border border-slate-200">
            <h2 className="text-2xl font-bold text-gray-900">Disconnect External Displays</h2>
            <p className="text-gray-600 mt-2">
              External or extended displays were detected. Please disconnect them to continue the exam.
            </p>
            <div className="mt-6 space-y-3">
              <button
                onClick={() => {
                  setMultiDisplayDetected(false);
                }}
                className="w-full py-3 bg-[#3558ff] text-white rounded-lg hover:bg-[#2643d6] font-semibold"
              >
                Recheck
              </button>
              <p className="text-xs text-gray-400">
                If you believe this is an error, unplug external displays and click Recheck.
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
             feedbackBanner.type === 'error' ? 'bg-[#d94f34]/90 border-[#d94f34] text-white' : 'bg-[#c98911]/90 border-[#d4a44a] text-white'
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
                 <h1 className="text-sm font-bold text-gray-900 leading-none truncate">{exam.title}</h1>
                 <span className="text-xs text-gray-500 font-mono mt-1 block">{student.registrationId}</span>
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
                    <span className="text-xs font-bold text-gray-400 uppercase tracking-widest block">
                        Question {overallIndex} of {totalQuestions}
                    </span>
                    {currentQ.sectionTitle && (
                      <span className="text-[10px] font-semibold text-orange-600 uppercase tracking-widest">
                        Section: {currentQ.sectionTitle}
                      </span>
                    )}
                  </div>
                  <span className="text-xs font-bold text-blue-700 bg-blue-100 px-2 py-1 rounded">
                      {currentQ.marks} Points
                  </span>
               </div>

               {/* The Question */}
               <div className="prose prose-lg max-w-none mb-8 sm:mb-10">
                  <h2 className="text-xl sm:text-2xl font-medium text-gray-900 leading-snug whitespace-pre-wrap break-words">
                    {currentQ.text}
                  </h2>
               </div>

               {/* Answer Area */}
               <div className="space-y-4 mb-12">
                  {currentQ.type === QuestionType.MCQ ? (
                     <div className="grid gap-3">
                        {currentQ.options?.map((opt, idx) => {
                           const isSelected = answers[currentQ.id] === idx;
                           return (
                              <div 
                                key={idx} 
                                onClick={() => handleAnswer(idx)}
                                className={`group flex items-center gap-4 p-4 rounded-xl border transition-all cursor-pointer ${
                                   isSelected 
                                   ? 'border-blue-500 bg-blue-50/70 shadow-sm ring-1 ring-blue-500'
                                   : 'border-gray-200 bg-white hover:border-blue-300 hover:shadow-sm'
                                }`}
                              >
                                 <div className={`w-5 h-5 rounded-full border flex items-center justify-center shrink-0 transition-all ${
                                    isSelected ? 'border-blue-500 bg-blue-500' : 'border-gray-300 group-hover:border-blue-400'
                                 }`}>
                                    {isSelected && <div className="w-2 h-2 rounded-full bg-white" />}
                                 </div>
                                 <span className={`text-base ${isSelected ? 'text-blue-900 font-medium' : 'text-gray-700'}`}>
                                    {opt}
                                 </span>
                              </div>
                           );
                        })}
                     </div>
                  ) : (
                     <div className="relative">
                        <textarea 
                            className="w-full h-52 sm:h-64 p-4 sm:p-5 text-base text-gray-800 bg-white border border-gray-300 rounded-xl outline-none resize-none transition-shadow shadow-sm"
                            placeholder="Type your answer here..."
                            value={answers[currentQ.id] as string || ''}
                            onChange={e => handleAnswer(e.target.value)}
                            onPaste={(e) => { e.preventDefault(); }}
                        />
                        <div className="absolute bottom-3 right-3 text-xs text-gray-400 bg-white px-2 py-1 rounded border">
                            {String(answers[currentQ.id] || '').length} chars
                        </div>
                     </div>
                  )}
               </div>

               {/* Navigation Buttons */}
               <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-between sm:items-center pt-6 border-t border-gray-200">
                  <button 
                     onClick={moveToPrevious}
                     disabled={currentQuestionIdx === 0 && currentSectionIdx <= minSectionIdx}
                     className="flex items-center justify-center gap-2 px-5 py-2.5 text-gray-600 hover:text-gray-900 font-medium rounded-lg hover:bg-gray-100 transition-colors disabled:opacity-30"
                  >
                     <ChevronLeft size={18} /> Previous
                  </button>

                  <button 
                     onClick={moveToNext}
                     className={`flex items-center justify-center gap-2 px-8 py-2.5 text-white font-medium rounded-lg shadow-lg shadow-blue-200/60 transition-all hover:scale-[1.02] active:scale-[0.98] ${
                        isLast ? 'bg-slate-900 hover:bg-slate-950' : 'bg-[#3558ff] hover:bg-[#2643d6]'
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
                {/* Audio Viz Overlay */}
                <div className="absolute bottom-2 right-2 rounded-md bg-slate-900/60 px-2 py-1">
                   <AudioBars />
                </div>
             </div>

             <div className="grid grid-cols-2 gap-2 text-[10px] font-mono text-slate-500">
                <div className="flex items-center gap-1.5 bg-white px-2 py-1 rounded border border-slate-200">
                   <Wifi size={10} className="text-teal-500" /> Signal: Good
                </div>
                <div className="flex items-center gap-1.5 bg-white px-2 py-1 rounded border border-slate-200">
                   <BatteryCharging size={10} className="text-teal-500" /> Power: OK
                </div>
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
                              ? 'bg-[#3558ff] text-white shadow-lg shadow-blue-200/70 scale-105 z-10'
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
         </div>
      </aside>
    </div>
  );
};
