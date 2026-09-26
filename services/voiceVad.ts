// Human voice detection backed by Silero VAD (v5) — a small pretrained neural voice-activity
// model — instead of hand-tuned spectral thresholds. Self-hosted from /vad (model + onnxruntime
// wasm) so it works offline and needs no external network, matching the self-hosted face models.
//
// The caller keeps the spectral detector as a fallback: if this model fails to load (unsupported
// browser, blocked wasm, etc.) startVoiceVad throws and the caller stays on the heuristic path.
import { MicVAD } from '@ricky0123/vad-web';

export interface VoiceVadHandle {
  destroy: () => Promise<void>;
}

export interface VoiceVadHandlers {
  // Fires when the model confirms SUSTAINED human speech (not a blip, cough, or background noise).
  onSpeechConfirmed: () => void;
  // Fires when a speech segment ends (optional; useful for telemetry).
  onSpeechEnd?: () => void;
}

/**
 * Start real-time voice detection on an EXISTING microphone MediaStream. Reuses the exam's mic
 * (never opens a second capture or permission prompt) and never stops it on pause/teardown of the
 * VAD — the same stream feeds recording and other detectors.
 */
export async function startVoiceVad(
  stream: MediaStream,
  handlers: VoiceVadHandlers,
  audioContext?: AudioContext,
): Promise<VoiceVadHandle> {
  const vad = await MicVAD.new({
    model: 'v5',
    baseAssetPath: '/vad/',
    onnxWASMBasePath: '/vad/',
    // Reuse the exam's already-resumed AudioContext so the model never gets stuck on a suspended
    // context (desktop auto-start). Falls back to MicVAD's own context if none is passed.
    ...(audioContext ? { audioContext } : {}),
    // Reuse the shared exam mic stream; never open a new getUserMedia or stop the shared tracks.
    getStream: async () => stream,
    pauseStream: async () => { /* no-op: never stop the shared exam mic on VAD pause */ },
    resumeStream: async () => stream,
    // Conservative bias so only clear speech counts. Silero outputs a 0–1 speech probability per
    // 32 ms frame; require it to cross 0.6 and persist for ~0.3 s before it's "real speech", so a
    // cough / chair scrape / keyboard tap never trips it.
    positiveSpeechThreshold: 0.6,
    negativeSpeechThreshold: 0.4,
    minSpeechMs: 290,     // ~0.29 s of sustained speech before confirming (rejects cough/tap)
    redemptionMs: 380,    // ~0.38 s of silence ends a segment
    ortConfig: (ort: any) => {
      ort.env.logLevel = 'error';
      // Single-threaded so we don't require cross-origin isolation (SharedArrayBuffer). Point the
      // wasm loader at our self-hosted binaries regardless of which build ORT selects.
      ort.env.wasm.numThreads = 1;
      // CPU-only wasm build (see the onnxruntime-web alias in vite.config.ts) — only the plain
      // 13 MB binary is served.
      ort.env.wasm.wasmPaths = { 'ort-wasm-simd-threaded.wasm': '/vad/ort-wasm-simd-threaded.wasm' };
    },
    onSpeechRealStart: () => handlers.onSpeechConfirmed(),
    onSpeechEnd: () => handlers.onSpeechEnd?.(),
  });
  vad.start();
  return {
    destroy: async () => {
      try {
        await vad.destroy();
      } catch {
        // best-effort teardown
      }
    },
  };
}
