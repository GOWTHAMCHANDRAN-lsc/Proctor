/**
 * AI Proctoring service — proxies to the Python FastAPI microservice.
 * Falls back gracefully when the service is unavailable.
 */

const AI_BASE = '/api/ai_proxy.php';

interface AnalyzeResult {
  faceCount: number;
  lookingAway: boolean;
  headYaw?: number;
  headPitch?: number;
  // v6 eye-tracking (blendshape) signals.
  eyeGazeAway?: boolean;
  eyeDir?: 'left' | 'right' | 'up' | 'down' | 'center';
  eyeMag?: number;
  eyesClosed?: boolean;
  mouthOpen?: boolean;
  gazeSource?: 'head' | 'eyes' | 'both' | 'none';
  phoneDetected: boolean;
  // Diagnostic: "cell phone" boxes the server threw out this frame (a headset, a watch, clutter).
  phoneIgnored?: string[];
  anomalyObjects?: Array<{ label: string; score: number }>;
  identityMatch: boolean | null;
  descriptor: number[];
  violations: Array<{
    type: string;
    description: string;
    confidence: number;
    metadata?: Record<string, unknown>;
  }>;
  // v7 virtual-proctor summary: live risk + human-readable observations for the wall.
  proctor?: {
    risk: number;
    level: 'low' | 'medium' | 'high';
    note: string | null;
    observations: Array<{ ts: number; text: string }>;
  } | null;
}

interface EnrollResult {
  ok: boolean;
  descriptor: number[];
  length: number;
}

interface VerifyResult {
  match: boolean;
  distance: number | null;
  descriptor: number[];
  reason?: string;
}

async function _post<T>(endpoint: string, body: unknown, timeoutMs = 8000): Promise<T | null> {
  // Bound every call with an AbortController. Without this, a frame sent while the AI service is
  // under heavy load would hang until the PHP proxy's 25 s timeout, stalling the whole detection
  // loop (single-flight) — so proctoring effectively froze under load. Abort early and move on.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${AI_BASE}?endpoint=${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

let _serviceAvailable: boolean | null = null;
let _serviceCheckedAt = 0;
// A transient blip (e.g. right as a mobile browser grants camera access) must not permanently
// disable proctoring for the rest of the exam — an "offline" verdict expires and gets re-probed.
// A confirmed "online" verdict stays cached, since re-probing a healthy service is pointless.
const SERVICE_RECHECK_MS = 15000;

export const checkAiService = async (): Promise<boolean> => {
  if (_serviceAvailable === true) return true;
  if (_serviceAvailable === false && (Date.now() - _serviceCheckedAt) < SERVICE_RECHECK_MS) return false;
  try {
    const res = await fetch(`${AI_BASE}?endpoint=health`, { method: 'GET' });
    const json = await res.json();
    _serviceAvailable = json?.status === 'ok';
  } catch {
    _serviceAvailable = false;
  }
  _serviceCheckedAt = Date.now();
  return _serviceAvailable ?? false;
};

/**
 * Capture a camera frame as base64 JPEG from a video element.
 *
 * The frame is downscaled so its longest side is at most `maxDim` px before encoding. The
 * server-side models (MediaPipe FaceLandmarker + EfficientDet-Lite2) resize their inputs to
 * ~448px internally, so 512px is visually lossless for detection while cutting the uploaded
 * payload ~3-4x versus a raw 960x540 webcam frame. Smaller payloads mean each /analyze call
 * completes faster — so violations are flagged sooner, especially on mobile networks.
 */
export const captureFrameBase64 = (
  video: HTMLVideoElement,
  quality = 0.7,
  maxDim = 512,
): string | null => {
  try {
    const vw = video.videoWidth  || 320;
    const vh = video.videoHeight || 240;
    const scale = maxDim > 0 ? Math.min(1, maxDim / Math.max(vw, vh)) : 1;
    const canvas = document.createElement('canvas');
    canvas.width  = Math.max(1, Math.round(vw * scale));
    canvas.height = Math.max(1, Math.round(vh * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', quality);
  } catch {
    return null;
  }
};

/** Analyze a frame for violations using the Python AI service. */
export const analyzeFrame = async (
  video: HTMLVideoElement,
  enrollDescriptor?: number[] | null,
  sessionKey?: string | null,
): Promise<AnalyzeResult | null> => {
  const frame = captureFrameBase64(video);
  if (!frame) return null;
  // 5 s cap: a detection older than that is stale for live proctoring — abandon and let the loop
  // send a fresh frame rather than blocking behind an overloaded server.
  return _post<AnalyzeResult>('analyze', {
    image: frame,
    enrollDescriptor: enrollDescriptor ?? null,
    sessionKey: sessionKey ?? null,
  }, 5000);
};

/** Enroll student face using the Python AI service (single frame). */
export const enrollFaceAI = async (video: HTMLVideoElement): Promise<EnrollResult | null> => {
  const frame = captureFrameBase64(video, 0.85, 640); // enrollment keeps more detail for the SFace descriptor
  if (!frame) return null;
  return _post<EnrollResult>('enroll', { image: frame });
};

/**
 * Enroll from several frames at once. The server averages the per-frame SFace embeddings into a
 * single normalised template, which is far more stable than any one frame — so legitimate later
 * frames (different expression/lighting/angle) stay above the match threshold and DON'T trigger a
 * false "identity changed" violation. Prefer this over the single-frame enrollFaceAI.
 */
export const enrollFaceFramesAI = async (frames: string[]): Promise<EnrollResult | null> => {
  const images = frames.filter(Boolean);
  if (images.length === 0) return null;
  return _post<EnrollResult>('enroll', { images }, 12000);
};

/** Verify live face against a stored descriptor using the Python AI service. */
export const verifyFaceAI = async (
  video: HTMLVideoElement,
  referenceDescriptor: number[]
): Promise<VerifyResult | null> => {
  const frame = captureFrameBase64(video);
  if (!frame) return null;
  return _post<VerifyResult>('verify', { image: frame, referenceDescriptor });
};
