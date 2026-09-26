/**
 * Face-recognition service for biometric identity verification.
 *
 * Uses @vladmandic/face-api (TensorFlow.js). Everything is lazy-loaded so the heavy model
 * code and weights are only fetched when an exam that needs identity verification starts.
 *
 * Model weights:
 *   By default they load from the versioned package CDN (jsDelivr), which works out of the box.
 *   For production it is strongly recommended to SELF-HOST the weights and set
 *   VITE_FACE_MODELS_URL=/models (copy node_modules/@vladmandic/face-api/model/* into public/models).
 */

const MODELS_URL =
  (import.meta.env.VITE_FACE_MODELS_URL && String(import.meta.env.VITE_FACE_MODELS_URL).trim()) ||
  'https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.15/model';

// Distance below which two descriptors are considered the same person.
// face-api's documented same-person threshold is ~0.6; 0.5 is a stricter exam default.
export const FACE_MATCH_THRESHOLD = 0.5;

let faceapiModule: any = null;
let loadPromise: Promise<any> | null = null;

let detectionLoadPromise: Promise<any> | null = null;   // tinyFaceDetector + landmark only
let fullLoadPromise: Promise<any> | null = null;         // + recognitionNet (enrollment)

const ensureTfjsBackend = async (faceapi: any) => {
  const tf: any = faceapi.tf;
  try {
    await tf.ready();
    if (tf.getBackend() !== 'webgl') { await tf.setBackend('webgl').catch(() => {}); await tf.ready(); }
    if (tf.getBackend() !== 'webgl') { await tf.setBackend('cpu').catch(() => {}); await tf.ready(); }
  } catch { /* fall back to whatever tfjs chose */ }
};

/** Load only the models needed for detection (fast — ~550 KB total). */
const loadFaceApiForDetection = async (): Promise<any> => {
  if (faceapiModule) return faceapiModule;
  if (!detectionLoadPromise) {
    detectionLoadPromise = (async () => {
      const faceapi = await import('@vladmandic/face-api');
      await ensureTfjsBackend(faceapi);
      await Promise.all([
        faceapi.nets.tinyFaceDetector.loadFromUri(MODELS_URL),
        faceapi.nets.faceLandmark68Net.loadFromUri(MODELS_URL),
      ]);
      return faceapi;
    })();
  }
  return detectionLoadPromise;
};

/** Load all models including the 6.4 MB recognition net (enrollment / descriptor matching). */
const loadFaceApi = async (): Promise<any> => {
  if (faceapiModule) return faceapiModule;
  if (!loadPromise) {
    loadPromise = (async () => {
      // Reuse the detection models already loaded (or start loading them).
      const faceapi = await loadFaceApiForDetection();
      // Then add the recognition net on top.
      await faceapi.nets.faceRecognitionNet.loadFromUri(MODELS_URL);
      faceapiModule = faceapi;
      // Let detection promise share the same module.
      detectionLoadPromise = loadPromise;
      return faceapi;
    })();
  }
  return loadPromise;
};

export const isFaceRecognitionSupported = (): boolean =>
  typeof window !== 'undefined' && typeof document !== 'undefined';

/** Preload detection-only models (tinyFaceDetector + landmark68). Fast — ~550 KB. */
export const initFaceDetection = async (): Promise<boolean> => {
  try {
    await loadFaceApiForDetection();
    return true;
  } catch (e) {
    console.warn('Face detection models failed to load:', e);
    return false;
  }
};

/** Preload all models including the recognition net (needed for enrollment). */
export const initFaceRecognition = async (): Promise<boolean> => {
  try {
    await loadFaceApi();
    return true;
  } catch (e) {
    console.warn('Face recognition models failed to load:', e);
    return false;
  }
};

/**
 * Compute a 128-d face descriptor from a video/image element.
 * Returns null when no single clear face is found.
 */
export const computeFaceDescriptor = async (
  input: HTMLVideoElement | HTMLImageElement | HTMLCanvasElement
): Promise<number[] | null> => {
  try {
    const faceapi = await loadFaceApi();
    const detection = await faceapi
      .detectSingleFace(input, new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.5 }))
      .withFaceLandmarks()
      .withFaceDescriptor();
    if (!detection || !detection.descriptor) return null;
    return Array.from(detection.descriptor as Float32Array);
  } catch (e) {
    console.warn('computeFaceDescriptor failed:', e);
    return null;
  }
};

/** Euclidean distance between two descriptors (lower = more similar). */
export const descriptorDistance = (a: number[], b: number[]): number => {
  const n = Math.min(a.length, b.length);
  if (n === 0) return Number.POSITIVE_INFINITY;
  let sum = 0;
  for (let i = 0; i < n; i += 1) sum += (a[i] - b[i]) ** 2;
  return Math.sqrt(sum);
};

export const isSamePerson = (a: number[], b: number[], threshold = FACE_MATCH_THRESHOLD): boolean =>
  descriptorDistance(a, b) <= threshold;

export interface FacePoseResult {
  faceCount: number;
  /** Head yaw: -1 = fully left, 0 = straight, +1 = fully right. Magnitude > 0.30 = looking away. */
  headYaw: number;
  /** Head pitch: negative = looking down, positive = up. Not used for violations but logged. */
  headPitch: number;
  gazeAway: boolean;
}

/**
 * Detect all faces and compute head pose from 68 facial landmarks.
 * Much more accurate than Haar cascade eye detection.
 * Yaw is estimated from the nose-tip offset relative to the inter-ocular midpoint.
 */
export const detectFacePose = async (
  input: HTMLVideoElement,
): Promise<FacePoseResult | null> => {
  try {
    const faceapi = await loadFaceApiForDetection();
    const detections = await faceapi
      .detectAllFaces(input, new faceapi.TinyFaceDetectorOptions({ inputSize: 224, scoreThreshold: 0.5 }))
      .withFaceLandmarks();

    const faceCount = detections.length;
    if (faceCount !== 1) {
      return { faceCount, headYaw: 0, headPitch: 0, gazeAway: false };
    }

    // 68-point FAN landmark convention:
    //   36-41 → left eye contour, 42-47 → right eye contour
    //   27-30 → nose bridge, 30 → nose tip
    //   0,16  → jaw extremes
    const pts = detections[0].landmarks.positions;

    const eyeCenter = (idxs: number[]) => {
      const xs = idxs.map(i => pts[i].x);
      const ys = idxs.map(i => pts[i].y);
      return { x: xs.reduce((a, b) => a + b, 0) / xs.length, y: ys.reduce((a, b) => a + b, 0) / ys.length };
    };

    const leftEye  = eyeCenter([36, 37, 38, 39, 40, 41]);
    const rightEye = eyeCenter([42, 43, 44, 45, 46, 47]);
    const noseTip  = { x: pts[30].x, y: pts[30].y };
    const leftJaw  = { x: pts[0].x,  y: pts[0].y  };
    const rightJaw = { x: pts[16].x, y: pts[16].y };

    const interocular  = Math.hypot(rightEye.x - leftEye.x, rightEye.y - leftEye.y);
    const eyeMidpointX = (leftEye.x + rightEye.x) / 2;
    const eyeMidpointY = (leftEye.y + rightEye.y) / 2;
    const faceHeight   = Math.max(1, (leftJaw.y + rightJaw.y) / 2 - eyeMidpointY);

    // Yaw: how much the nose tip deviates from the eye midpoint, normalised by IOD.
    const headYaw   = (noseTip.x - eyeMidpointX) / Math.max(interocular, 1);
    // Pitch: nose position relative to face height (negative = looking down).
    const headPitch = (noseTip.y - eyeMidpointY) / Math.max(faceHeight, 1) - 0.5;

    // Threshold: |yaw| > 0.42 means the head is clearly turned off-axis (~33°+) — looking away
    // from the screen rather than just scanning the question. Normal reading and brief thinking
    // glances stay under this; combined with the 5s grace window this catches sustained looking-away.
    const gazeAway = Math.abs(headYaw) > 0.42;

    return {
      faceCount,
      headYaw:   Math.round(headYaw   * 1000) / 1000,
      headPitch: Math.round(headPitch * 1000) / 1000,
      gazeAway,
    };
  } catch (e) {
    console.warn('detectFacePose failed:', e);
    return null;
  }
};
