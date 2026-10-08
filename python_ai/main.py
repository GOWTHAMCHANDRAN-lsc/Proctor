"""
ProctorGuard AI Proctoring Service — v7.0 (production)

Server-side, headless, CPU-only INTELLIGENT, DYNAMIC proctoring.

Models:
  • MediaPipe FaceLandmarker (478 landmarks + transformation matrix)
        → face count, head-pose / gaze (yaw & pitch)
  • MediaPipe ObjectDetector (EfficientDet-Lite, COCO 80)
        → phone / book / laptop / second-screen detection
  • OpenCV YuNet (face_detection_yunet)      → robust face box + 5 landmarks for alignment
  • OpenCV SFace (face_recognition_sface)    → REAL 128-d deep face embedding for identity
        (cosine similarity; same-person threshold 0.363 per OpenCV zoo)

What makes it "dynamic / intelligent" (v5.0):
  • PER-SESSION ADAPTIVE GAZE CALIBRATION — instead of one fixed yaw threshold for everyone,
    each session learns the candidate's neutral head pose (EMA baseline that only updates while
    the head is near-centre) and flags gaze as a DEVIATION from THAT baseline. Handles off-centre
    cameras / natural resting posture without false alarms.
  • TEMPORAL CONFIDENCE SMOOTHING — gaze, phone and identity decisions are made over a rolling
    window of recent frames, not a single noisy frame, and confidence scales with how sustained
    the signal is.
  • PITCH-AWARE LOOK-DOWN — uses head pitch (relative to the learned baseline) to catch a
    candidate repeatedly looking down at a lap / notes / phone.
  • REAL BIOMETRIC IDENTITY — SFace deep embedding with cosine matching replaces the old
    lighting-sensitive HOG-lite descriptor. Multi-sample enrollment averaging for a robust template.
  • VIRTUAL PROCTOR (v7) — a behavioural reasoning layer on top of the raw detectors that
    thinks like a human proctor watching over minutes, not frames: groups gaze deviations
    into discrete GLANCE EPISODES and flags repeated-glance patterns (reading notes / hidden
    device), correlates a phone appearing right after a look-down, notices repeated talking
    while alone in frame, escalates extended absences, keeps a decaying LIVE RISK SCORE
    (0-100) per session, and writes human-readable proctor observations for the live wall.
    Pattern findings are emitted as SUSPICIOUS_BEHAVIOR violations with evidence metadata.

MediaPipe Tasks needs the GL runtime (libGLESv2/libEGL/libGLdispatch) which is not installed
system-wide on this headless box. We ship those .so files in ./syslibs and preload them with
ctypes(RTLD_GLOBAL) BEFORE importing mediapipe, so the service is fully self-contained and PM2
needs no special environment.
"""

from __future__ import annotations

# ── Preload GL runtime so MediaPipe Tasks loads headless ──────────────────────
import ctypes
import os

_LIBDIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "syslibs")
for _lib in ("libGLdispatch.so.0", "libGLESv2.so.2", "libEGL.so.1", "libgbm.so.1"):
    try:
        ctypes.CDLL(os.path.join(_LIBDIR, _lib), mode=ctypes.RTLD_GLOBAL)
    except OSError:
        pass  # best-effort; if the system already has them this is a no-op

import base64
import hashlib
import io
import logging
import threading
import time
from collections import deque
from dataclasses import dataclass, field
from pathlib import Path

import cv2
import numpy as np
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from PIL import Image
from pydantic import BaseModel

import mediapipe as mp
from mediapipe.tasks import python as mp_python
from mediapipe.tasks.python import vision

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("proctor-ai")

MODELS_DIR = Path(__file__).parent / "models"

# ── Load models at startup, as a POOL for concurrency ─────────────────────────
# A single model instance guarded by one global lock serialised ALL inference, capping the
# service at ~1/(inference time) requests/sec no matter how many candidates were online — so
# under exam-day load (many students at once) frames queued up and camera violations were flagged
# late or missed. Instead we hold a small POOL of independent model instances: MediaPipe/OpenCV
# release the GIL during native inference, so N frames genuinely run in parallel across N CPU
# cores. Per-session state still lives in this ONE process, so gaze baselines / sustained windows
# / risk stay consistent (no multi-process routing needed). Pool size tracks cores, capped so we
# don't oversubscribe the shared box.
import queue as _queue
from contextlib import contextmanager, nullcontext

POOL_SIZE = max(1, min(int(os.getenv("PROCTOR_POOL", "0") or 0) or (os.cpu_count() or 4) // 2, 6))
cv2.setNumThreads(2)  # keep each OpenCV (YuNet/SFace) call from grabbing every core under a pool

def _make_face_landmarker():
    return vision.FaceLandmarker.create_from_options(
        vision.FaceLandmarkerOptions(
            base_options=mp_python.BaseOptions(model_asset_path=str(MODELS_DIR / "face_landmarker.task")),
            output_facial_transformation_matrixes=True,
            output_face_blendshapes=True,
            num_faces=3,  # enough to flag "multiple people"
            min_face_detection_confidence=0.5,
            min_face_presence_confidence=0.5,
        )
    )

def _make_object_detector():
    return vision.ObjectDetector.create_from_options(
        vision.ObjectDetectorOptions(
            base_options=mp_python.BaseOptions(model_asset_path=str(MODELS_DIR / "efficientdet_lite2.tflite")),
            score_threshold=0.30,
            max_results=15,
        )
    )

# MediaPipe pool: each slot bundles a FaceLandmarker + ObjectDetector used together in _detect().
_mp_pool: "_queue.Queue" = _queue.Queue()
# OpenCV face-recognition pool (YuNet detect + SFace embed) used together in _sface_embed().
_cv_pool: "_queue.Queue" = _queue.Queue()
for _ in range(POOL_SIZE):
    _mp_pool.put((_make_face_landmarker(), _make_object_detector()))
    _cv_pool.put((
        cv2.FaceDetectorYN.create(str(MODELS_DIR / "face_detection_yunet.onnx"), "", (320, 320), 0.6, 0.3, 5000),
        cv2.FaceRecognizerSF.create(str(MODELS_DIR / "face_recognition_sface.onnx"), ""),
    ))

@contextmanager
def _borrow(pool: "_queue.Queue"):
    """Check out a model bundle for the duration of one inference, then return it to the pool.
    Blocks if all instances are busy — this naturally bounds concurrency to POOL_SIZE."""
    item = pool.get()
    try:
        yield item
    finally:
        pool.put(item)

log.info("Models loaded: MediaPipe FaceLandmarker + ObjectDetector, OpenCV YuNet + SFace "
         "(headless, CPU) — pool size %d.", POOL_SIZE)

# ── Object classes we care about ──────────────────────────────────────────────
PHONE_LABELS = {"cell phone", "mobile phone"}
ANOMALY_LABELS = {
    "book": "a book or printed notes",
    "laptop": "a second laptop",
    "tv": "a second screen / monitor",
}

# ── Phone false-positive guards: headphones & wristwatches ────────────────────
# COCO (and therefore EfficientDet-Lite) has NO class for headphones or a watch, so the
# detector maps both onto the nearest class it does know — "cell phone" — and candidates
# wearing a headset or a watch were flagged for phone use. Geometry separates them cleanly:
#   • a phone is ELONGATED (~2:1 in either orientation). An earcup, a headband seen head-on
#     and a watch face are all roughly SQUARE.
#   • a headset is WORN, so its box sits on/over the head. A phone held to the ear still
#     juts well clear of the head, so a modest pad + high containment bar keeps it flagged.
#   • a wristwatch is TINY relative to the frame.
PHONE_MIN_SCORE = 0.40         # per-frame score below which a "cell phone" box is ignored outright
PHONE_FIRE_SCORE = 0.55        # single high-confidence frame fires immediately (post-geometry)
PHONE_MIN_ELONGATION = 1.60    # max(w,h)/min(w,h). Phones sit ~2:1; earcups, a watch face and a
                               # headset slung round the neck all come in under this.
PHONE_MIN_AREA_FRAC = 0.012    # box must cover ≥1.2% of the frame. A phone in hand is ~3%+; a
                               # watch (even with its strap, wrist raised) stays under 1%.
PHONE_HEAD_CONTAIN_MAX = 0.75  # ≥75% of the box inside the head region ⇒ worn on the head
HEAD_PAD_FRAC = 0.20           # head region = face box grown by this fraction of its size
# The cost of these gates is a phone held at a steep diagonal (its box reads near-square) may not
# be flagged from the object detector alone. That is the deliberate trade: sustained look-down and
# repeated-glance patterns still catch phone USE, whereas a headset on a candidate's head was
# firing a high-severity violation every single frame of the exam.

# ── Tunables ──────────────────────────────────────────────────────────────────
BUFFER_LEN = 5            # rolling window length for temporal smoothing
GAZE_YAW_MARGIN = 0.60    # head-yaw deviation from the learned neutral pose that counts as "turned away".
                          # yaw runs 0 (facing camera) → 1.0 (full side profile), so 0.60 ≈ head turned
                          # ~60% toward a profile. Only a decisive head turn raises a looking-away violation.
GAZE_WARMUP_FRAMES = 6    # average this many early frames into the neutral baseline before judging
# STEEP look-down only (lap / phone / notes on the desk). Shallow look-downs are the
# keyboard — every candidate must type answers, so flagging them was the #1 false positive.
GAZE_PITCH_MARGIN = 0.28
BASELINE_NEAR = 0.10      # |yaw - baseline| below this is treated as "near centre" → recalibrate
BASELINE_EMA = 0.10       # how fast the neutral baseline adapts while near centre
SFACE_COSINE_MATCH = 0.363  # OpenCV-recommended SFace same-person cosine threshold
SESSION_TTL_SEC = 3 * 3600  # drop idle session state after 3h
SESSION_MAX = 10000         # hard cap on tracked sessions (oldest-idle evicted beyond this)
SESSION_GC_EVERY_SEC = 60.0 # run the idle-session sweep at most this often
SESSION_KEY_MAX_LEN = 256   # longer keys are hashed so a huge key can't pin memory

# ── Input guards ──────────────────────────────────────────────────────────────
# The client downscales frames to ≤640px before upload; these only stop abusive payloads from
# exhausting memory (a single 9000×9000 JPEG peaked at ~1.6 GB RSS) without affecting real frames.
MAX_IMAGE_PIXELS = 4096 * 4096  # reject anything larger outright (decompression-bomb guard)
MAX_IMAGE_SIDE = 1920           # larger frames are downscaled to this longest side before analysis
ENROLL_MAX_IMAGES = 10          # client sends 4; extra samples are ignored

# ── Blendshape (eye-tracking) tunables ────────────────────────────────────────
# Blendshape scores are 0..1. Neutral forward gaze sits low (~0.1-0.25); a decisive
# eye movement to the side / down pushes the relevant pair well past these margins.
EYE_GAZE_SIDE_MARGIN = 0.62  # horizontal eye deviation — set above normal on-screen reading so
                             # moving your eyes across the text isn't mistaken for looking away
EYE_GAZE_DOWN_MARGIN = 0.75  # both eyes rolled HARD down (lap-level; keyboard glances pass)
EYE_CLOSED_MARGIN = 0.55     # both eyes closed (per-frame; sustained ⇒ eyesClosed signal)
MOUTH_OPEN_MARGIN = 0.45     # jaw open (talking / speaking to someone off-camera)

# ── Virtual-proctor (v7 behavioural reasoning) tunables ──────────────────────
# A human proctor doesn't judge single frames — they notice PATTERNS over minutes:
# repeated short glances at notes, talking with nobody visible, a phone appearing right
# after a look-down, a long absence. These rules encode that judgment.
GLANCE_MIN_SEC = 0.7          # an away-episode must last this long to count as a "glance"
GLANCE_WINDOW_SEC = 60.0      # repeated-glance pattern window
GLANCE_REPEAT_N = 5           # this many glances inside the window ⇒ suspicious pattern
TALK_MIN_SEC = 2.0            # a talking episode must last this long to count
TALK_WINDOW_SEC = 90.0        # talking-alone pattern window
TALK_REPEAT_N = 3             # this many talk episodes inside the window ⇒ suspicious
ABSENCE_ALERT_SEC = 20.0      # continuous absence longer than this ⇒ high-severity pattern
PHONE_LOOKDOWN_CORR_SEC = 12.0  # phone seen this soon after a look-down ⇒ correlated evidence
PATTERN_COOLDOWN_SEC = 45.0   # per-pattern re-fire cooldown so reports aren't spammed
RISK_HALF_LIFE_SEC = 240.0    # live risk decays with this half-life (calm behaviour recovers)
RISK_ADD_COOLDOWN_SEC = 8.0   # a violation type contributes risk at most this often
# How much each event moves the live risk needle (pre-decay).
RISK_WEIGHTS = {
    "PHONE_DETECTED": 30.0,
    "MULTIPLE_FACES": 25.0,
    "IDENTITY_CHANGE": 25.0,
    "ANOMALY_OBJECT": 15.0,
    "NO_FACE": 10.0,
    "GAZE_AWAY": 5.0,
}
RISK_WEIGHT_PATTERN_HIGH = 22.0
RISK_WEIGHT_PATTERN_MEDIUM = 14.0

app = FastAPI(title="ProctorGuard AI", version="7.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in os.getenv("PG_AI_CORS_ORIGINS", "https://proctor.lsc-crm.in").split(",") if o.strip()],
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
)

# Only the inference endpoints are served. The ported business API below trusts X-User-Role /
# X-Company-Id headers with no session-token check, so it must never be reachable - it stays
# unmounted unless explicitly enabled, and this guard rejects every other path regardless.
_PUBLIC_AI_PATHS = {"/health", "/analyze", "/enroll", "/verify"}


@app.middleware("http")
async def _only_inference_paths(request: Request, call_next):  # noqa: ANN001
    if request.url.path not in _PUBLIC_AI_PATHS:
        return JSONResponse({"error": "Not found."}, status_code=404)
    return await call_next(request)

# ── Business API (Python port of api/*.php) ──────────────────────────────────
# Ported endpoints keep the exact request/response contract of their PHP originals
# (same /<name>.php paths, headers, JSON shapes, status codes). nginx routes each
# verified /api/<name>.php to this service once cut over; the rest stay on PHP-FPM.
from business.core import ApiError, api_error_response, bootstrap_schema
from business import (
    access_requests as _biz_access_requests,
    audit as _biz_audit,
    batches as _biz_batches,
    companies as _biz_companies,
    deliveries as _biz_deliveries,
    enrollment as _biz_enrollment,
    exams as _biz_exams,
    feedback as _biz_feedback,
    live as _biz_live,
    notify as _biz_notify,
    recordings as _biz_recordings,
    reports as _biz_reports,
    results as _biz_results,
    sessions as _biz_sessions,
    settings as _biz_settings,
    students as _biz_students,
    templates as _biz_templates,
    users as _biz_users,
    violations as _biz_violations,
)

for _mod in (() if os.getenv("PG_ENABLE_BUSINESS_API") != "1" else (_biz_violations, _biz_settings, _biz_enrollment, _biz_deliveries,
             _biz_audit, _biz_templates, _biz_feedback, _biz_batches, _biz_companies,
             _biz_students, _biz_notify, _biz_users, _biz_results, _biz_recordings,
             _biz_reports, _biz_live, _biz_access_requests, _biz_exams, _biz_sessions)):
    app.include_router(_mod.router)


@app.exception_handler(ApiError)
async def _api_error_handler(request: Request, exc: ApiError):  # noqa: ANN001
    return api_error_response(exc)


@app.on_event("startup")
def _bootstrap_business_schema() -> None:
    # Schema/seed bootstrap only serves the business API. While that API is disabled the AI
    # service must not connect to MySQL or run DDL / seed INSERTs on every restart.
    if os.getenv("PG_ENABLE_BUSINESS_API") == "1":
        bootstrap_schema()


# ── Per-session adaptive state ────────────────────────────────────────────────
@dataclass
class SessionState:
    face_counts: deque = field(default_factory=lambda: deque(maxlen=BUFFER_LEN))
    gaze_flags: deque = field(default_factory=lambda: deque(maxlen=BUFFER_LEN))
    phone_flags: deque = field(default_factory=lambda: deque(maxlen=BUFFER_LEN))
    identity_flags: deque = field(default_factory=lambda: deque(maxlen=BUFFER_LEN))
    eyes_closed_flags: deque = field(default_factory=lambda: deque(maxlen=BUFFER_LEN))
    mouth_open_flags: deque = field(default_factory=lambda: deque(maxlen=BUFFER_LEN))
    anomaly_flags: deque = field(default_factory=lambda: deque(maxlen=BUFFER_LEN))
    yaw_baseline: float | None = None    # learned neutral head yaw for THIS candidate
    pitch_baseline: float | None = None  # learned neutral head pitch
    yaw_warmup: list = field(default_factory=list)    # early yaw samples, averaged into the baseline
    pitch_warmup: list = field(default_factory=list)  # early pitch samples
    # All session timing uses time.monotonic() so an NTP/VM clock step can't fake durations,
    # freeze cooldowns or inflate the decaying risk score. (Observation timestamps sent to the
    # client stay epoch-ms — see _observe.)
    last_seen: float = field(default_factory=time.monotonic)
    # Serialises frames of the SAME session. When the client aborts a slow /analyze (5 s) and
    # sends the next frame, both requests can run at once; unsynchronised they mutate these deques
    # mid-iteration ("RuntimeError: deque mutated during iteration" → 500) and race the episode
    # state (away_since/talk_since set to None between a check and its use).
    lock: threading.Lock = field(default_factory=threading.Lock, repr=False, compare=False)
    # ── Virtual-proctor memory (episodes + patterns + risk) ──────────────────
    away_since: float | None = None      # start of the current gaze-away episode
    away_frames: int = 0                 # frames inside the current away episode
    away_down: bool = False              # current away episode included a look-down
    glance_events: deque = field(default_factory=lambda: deque(maxlen=40))  # (end_ts, dur, was_down)
    last_lookdown_ts: float = 0.0        # end of the most recent look-down glance
    absent_since: float | None = None    # start of the current no-face stretch
    talk_since: float | None = None      # start of the current talking episode
    talk_events: deque = field(default_factory=lambda: deque(maxlen=20))    # end_ts of talk episodes
    risk_events: deque = field(default_factory=lambda: deque(maxlen=200))   # (ts, weight)
    risk_last_add: dict = field(default_factory=dict)   # violation type -> last risk-add ts
    pattern_last: dict = field(default_factory=dict)    # pattern name -> last fired ts
    observations: deque = field(default_factory=lambda: deque(maxlen=8))    # (ts, text)


_sessions: dict[str, SessionState] = {}
_sessions_lock = threading.Lock()
_sessions_gc_at = 0.0


def _gc_sessions(now: float) -> None:
    """Drop idle sessions; if still at the hard cap, evict the least-recently-seen. Caller holds
    _sessions_lock. /analyze is publicly reachable, so arbitrary sessionKeys must not be able to
    grow this dict (and the per-request sweep over it) without bound."""
    for k in [k for k, s in _sessions.items() if now - s.last_seen > SESSION_TTL_SEC]:
        _sessions.pop(k, None)
    if len(_sessions) >= SESSION_MAX:
        by_age = sorted(_sessions.items(), key=lambda kv: kv[1].last_seen)
        for k, _ in by_age[: len(_sessions) - int(SESSION_MAX * 0.9)]:
            _sessions.pop(k, None)


def _get_session(key: str | None) -> SessionState | None:
    global _sessions_gc_at
    if not key:
        return None
    if len(key) > SESSION_KEY_MAX_LEN:
        key = hashlib.sha256(key.encode("utf-8", "replace")).hexdigest()
    now = time.monotonic()
    with _sessions_lock:
        st = _sessions.get(key)
        if st is None:
            # Sweep only when a NEW session is created, at most once a minute (or at the cap),
            # instead of scanning every session on every frame.
            if now - _sessions_gc_at >= SESSION_GC_EVERY_SEC or len(_sessions) >= SESSION_MAX:
                _sessions_gc_at = now
                _gc_sessions(now)
            st = SessionState()
            _sessions[key] = st
        st.last_seen = now
        return st


# ── Schemas ───────────────────────────────────────────────────────────────────
class AnalyzeRequest(BaseModel):
    image: str
    enrollDescriptor: list[float] | None = None
    sessionKey: str | None = None


class EnrollRequest(BaseModel):
    image: str | None = None
    images: list[str] | None = None  # optional multi-sample enrollment for a robust template


class VerifyRequest(BaseModel):
    image: str
    referenceDescriptor: list[float]


# ── Image helpers ─────────────────────────────────────────────────────────────
def _decode_rgb(b64: str) -> np.ndarray:
    try:
        data = base64.b64decode(b64.split(",")[-1])
        img = Image.open(io.BytesIO(data))
        w, h = img.size  # header only — nothing decoded yet
    except Exception as exc:
        raise HTTPException(400, f"Invalid image: {exc}") from exc
    if w * h > MAX_IMAGE_PIXELS:
        raise HTTPException(413, f"Image too large ({w}x{h}).")
    try:
        if max(w, h) > MAX_IMAGE_SIDE:
            img.draft("RGB", (MAX_IMAGE_SIDE, MAX_IMAGE_SIDE))  # JPEG: decode at reduced scale
            img = img.convert("RGB")
            img.thumbnail((MAX_IMAGE_SIDE, MAX_IMAGE_SIDE))
        else:
            img = img.convert("RGB")
        return np.array(img, dtype=np.uint8)
    except Exception as exc:
        raise HTTPException(400, f"Invalid image: {exc}") from exc


def _mp_image(rgb: np.ndarray) -> mp.Image:
    return mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)


# ── Head pose from face landmarks ─────────────────────────────────────────────
# MediaPipe FaceMesh indices: 1 = nose tip, 234 = right cheek edge, 454 = left cheek edge,
# 10 = forehead top, 152 = chin bottom.
def _face_area(landmarks: list) -> float:
    """Normalised bounding-box area (fraction of frame) for a set of face landmarks."""
    xs = [p.x for p in landmarks]
    ys = [p.y for p in landmarks]
    return max(0.0, (max(xs) - min(xs)) * (max(ys) - min(ys)))


def _count_people(all_landmarks: list) -> tuple[int, int]:
    """
    Return (people_count, primary_index).

    The candidate is the largest face. Additional faces only count as extra PEOPLE when
    they are substantial — at least 1% of the frame AND at least 20% the size of the
    candidate's face. This rejects the classic MULTIPLE_FACES false positives: a face on a
    wall poster, a photo on a desk, or a faint reflection, all of which are small/distant.
    """
    if not all_landmarks:
        return 0, 0
    areas = [_face_area(lm) for lm in all_landmarks]
    primary_idx = max(range(len(areas)), key=lambda i: areas[i])
    primary_area = areas[primary_idx]
    extra = sum(
        1
        for i in range(len(areas))
        if i != primary_idx and areas[i] >= max(0.010, primary_area * 0.20)
    )
    return 1 + extra, primary_idx


def _head_pose(landmarks: list) -> tuple[float, float]:
    """
    Returns (yaw_ratio, pitch_ratio).
      yaw_ratio:  0 = facing camera, sign indicates turn direction. Scale & distance invariant.
      pitch_ratio: nose vertical position between forehead and chin (~0.5 neutral; higher = down).
    """
    nose = landmarks[1]
    right_cheek = landmarks[234]
    left_cheek = landmarks[454]
    forehead = landmarks[10]
    chin = landmarks[152]

    dl = abs(nose.x - right_cheek.x)
    dr = abs(left_cheek.x - nose.x)
    denom = (dl + dr) or 1e-6
    yaw_ratio = (dr - dl) / denom

    face_h = abs(chin.y - forehead.y) or 1e-6
    pitch_ratio = (nose.y - forehead.y) / face_h
    return yaw_ratio, pitch_ratio


# ── Eye-tracking / behaviour from face blendshapes ────────────────────────────
def _blendshape_signals(blendshapes) -> dict:
    """
    Turn the 52 ARKit-style blendshapes into proctoring signals.

    Returns a dict with:
      eyeAway   : bool  — eyes pointing clearly away from the screen (side or down)
      eyeMag    : float — strength of the strongest away direction (0..1)
      eyeDir    : str   — 'left' | 'right' | 'down' | 'up' | 'center'
      eyesClosed: bool  — both eyes closed this frame
      mouthOpen : bool  — jaw open (talking) this frame
      jawOpen   : float — raw jawOpen score
    """
    s = {c.category_name: float(c.score) for c in blendshapes}

    # Both eyes rotate the same real-world direction, so combine the matching pair.
    look_left = (s.get("eyeLookOutRight", 0.0) + s.get("eyeLookInLeft", 0.0)) / 2.0
    look_right = (s.get("eyeLookOutLeft", 0.0) + s.get("eyeLookInRight", 0.0)) / 2.0
    look_down = (s.get("eyeLookDownLeft", 0.0) + s.get("eyeLookDownRight", 0.0)) / 2.0
    look_up = (s.get("eyeLookUpLeft", 0.0) + s.get("eyeLookUpRight", 0.0)) / 2.0

    dirs = {"left": look_left, "right": look_right, "down": look_down, "up": look_up}
    eye_dir = max(dirs, key=dirs.get)
    eye_mag = dirs[eye_dir]

    eye_away = (
        look_left > EYE_GAZE_SIDE_MARGIN
        or look_right > EYE_GAZE_SIDE_MARGIN
        or look_down > EYE_GAZE_DOWN_MARGIN
    )

    blink = (s.get("eyeBlinkLeft", 0.0) + s.get("eyeBlinkRight", 0.0)) / 2.0
    jaw = s.get("jawOpen", 0.0)

    return {
        "eyeAway": bool(eye_away),
        "eyeMag": round(eye_mag, 3),
        "eyeDir": eye_dir if eye_mag > 0.25 else "center",
        "eyesClosed": bool(blink > EYE_CLOSED_MARGIN),
        "mouthOpen": bool(jaw > MOUTH_OPEN_MARGIN),
        "jawOpen": round(jaw, 3),
    }


# ── Real face embedding (YuNet detect + SFace embed) ──────────────────────────
def _sface_embed(bgr: np.ndarray) -> list[float] | None:
    """Largest-face 128-d SFace embedding, L2-normalised. None if no usable face."""
    h, w = bgr.shape[:2]
    if min(h, w) < 32:
        # Too small to hold a recognisable face; YuNet on degenerate inputs (e.g. 1x1) has been
        # seen to return a spurious box, which would become a junk enrollment template.
        return None
    with _borrow(_cv_pool) as (yunet, sface):
        yunet.setInputSize((w, h))
        _, faces = yunet.detect(bgr)
        if faces is None or len(faces) == 0:
            return None
        face = max(faces, key=lambda f: float(f[2]) * float(f[3]))  # largest by box area
        aligned = sface.alignCrop(bgr, face)
        feat = sface.feature(aligned)
    v = np.asarray(feat, dtype=np.float32).flatten()
    n = float(np.linalg.norm(v))
    if n > 0:
        v /= n
    return v.tolist()


def _cosine(a: list[float], b: list[float]) -> float:
    na = np.asarray(a, dtype=np.float32)
    nb = np.asarray(b, dtype=np.float32)
    if na.size == 0 or nb.size == 0 or na.size != nb.size:
        return -1.0
    # embeddings are already L2-normalised, but normalise defensively
    da = np.linalg.norm(na) or 1.0
    db = np.linalg.norm(nb) or 1.0
    cos = float(np.dot(na, nb) / (da * db))
    # A NaN/Infinity in a client descriptor would otherwise yield NaN, which the JSON encoder
    # rejects (allow_nan=False) → 500. Treat it as a non-match.
    return cos if np.isfinite(cos) else -1.0


def _detect(rgb: np.ndarray, with_objects: bool = True):
    """Run MediaPipe face + object models on a pooled instance (concurrent across requests).
    /enroll and /verify only need faces, so they skip the (costlier) object detector."""
    mpimg = _mp_image(rgb)
    with _borrow(_mp_pool) as (face_landmarker, object_detector):
        faces = face_landmarker.detect(mpimg)
        objects = object_detector.detect(mpimg) if with_objects else None
    return faces, objects


# ── Object-box geometry (used to tell a phone apart from a headset / watch) ───
def _head_box_px(landmarks: list, w: int, h: int, pad: float = HEAD_PAD_FRAC) -> tuple[float, float, float, float]:
    """Face landmark bounds in pixels, grown by `pad` — an approximate head region."""
    xs = [lm.x for lm in landmarks]
    ys = [lm.y for lm in landmarks]
    x1, x2 = min(xs) * w, max(xs) * w
    y1, y2 = min(ys) * h, max(ys) * h
    dx, dy = (x2 - x1) * pad, (y2 - y1) * pad
    return (x1 - dx, y1 - dy, x2 + dx, y2 + dy)


def _containment(box: tuple[float, float, float, float],
                 region: tuple[float, float, float, float]) -> float:
    """Fraction of `box`'s own area that falls inside `region` (0..1)."""
    bx1, by1, bx2, by2 = box
    rx1, ry1, rx2, ry2 = region
    area = max(0.0, bx2 - bx1) * max(0.0, by2 - by1)
    if area <= 0:
        return 0.0
    iw = max(0.0, min(bx2, rx2) - max(bx1, rx1))
    ih = max(0.0, min(by2, ry2) - max(by1, ry1))
    return (iw * ih) / area


def _phone_box_reason(det_box, frame_w: int, frame_h: int,
                      head_box: tuple[float, float, float, float] | None) -> str | None:
    """Why this "cell phone" box is NOT a phone — None means it survives as a real phone.

    The detector has no headphones/watch class and pushes both onto "cell phone", so shape,
    size and head-overlap do the discrimination the model can't.
    """
    bw, bh = float(det_box.width), float(det_box.height)
    if bw <= 0 or bh <= 0:
        return "degenerate"
    if max(bw, bh) / min(bw, bh) < PHONE_MIN_ELONGATION:
        return "not-elongated"  # earcup, headband head-on, watch face, mouse…
    if (bw * bh) < PHONE_MIN_AREA_FRAC * float(frame_w) * float(frame_h):
        return "too-small"      # wristwatch / distant clutter
    if head_box is not None:
        x1, y1 = float(det_box.origin_x), float(det_box.origin_y)
        if _containment((x1, y1, x1 + bw, y1 + bh), head_box) >= PHONE_HEAD_CONTAIN_MAX:
            return "worn-on-head"  # headset band / earcups; a phone at the ear juts clear of this
    return None


def _sustained(flags: deque, need_frac: float = 0.6) -> tuple[bool, float]:
    """True if a sufficient fraction of the recent window is set. Returns (fired, fraction)."""
    if not flags:
        return False, 0.0
    frac = sum(1 for f in flags if f) / len(flags)
    # require a minimally filled window so we don't fire on the very first frame
    fired = len(flags) >= 2 and frac >= need_frac
    return fired, frac


# ── Virtual proctor: behavioural pattern reasoning + live risk score ──────────
def _observe(st: SessionState, now: float, text: str) -> None:
    """Write a line in the proctor's notebook (deduped against the latest entry).
    `now` is the monotonic session clock; the stored timestamp is wall-clock because it is
    returned to the client as epoch milliseconds."""
    wall = time.time()
    if st.observations and st.observations[-1][1] == text:
        st.observations[-1] = (wall, text)
        return
    st.observations.append((wall, text))


def _pattern_ready(st: SessionState, now: float, name: str) -> bool:
    if now - st.pattern_last.get(name, float("-inf")) < PATTERN_COOLDOWN_SEC:
        return False
    st.pattern_last[name] = now
    return True


def _add_risk(st: SessionState, now: float, key: str, weight: float) -> None:
    """Accumulate risk for an event type, rate-limited so a sustained condition
    (which re-appears in `violations` every frame) doesn't explode the score."""
    if now - st.risk_last_add.get(key, float("-inf")) < RISK_ADD_COOLDOWN_SEC:
        return
    st.risk_last_add[key] = now
    st.risk_events.append((now, weight))


def _risk_score(st: SessionState, now: float) -> float:
    """Live risk 0..100: recent events count fully, old ones fade (half-life decay) —
    a candidate who behaves calms back down, exactly like a proctor's attention."""
    total = 0.0
    for ts, w in st.risk_events:
        total += w * (0.5 ** ((now - ts) / RISK_HALF_LIFE_SEC))
    return min(100.0, total)


def _virtual_proctor(
    st: SessionState,
    now: float,
    *,
    face_count: int,
    away_raw: bool,
    eye_dir: str,
    pitch_down: bool,
    mouth_open: bool,
    phone_detected: bool,
    violations: list[dict],
) -> dict:
    """
    The reasoning layer a human proctor provides: watch episodes unfold over minutes,
    connect the dots between signals, write it up when a PATTERN emerges, and keep a
    running sense of how risky this candidate looks right now.

    May append SUSPICIOUS_BEHAVIOR violations to `violations`. Returns the proctor
    summary dict for the response.
    """
    # 1) Gaze episode tracking — group away frames into discrete glances with duration.
    if face_count == 1 and away_raw:
        if st.away_since is None:
            st.away_since = now
            st.away_frames = 0
            st.away_down = False
        st.away_frames += 1
        if eye_dir == "down" or pitch_down:
            st.away_down = True
    elif st.away_since is not None:
        dur = now - st.away_since
        if st.away_frames >= 2 and dur >= GLANCE_MIN_SEC:
            st.glance_events.append((now, dur, st.away_down))
            if st.away_down:
                st.last_lookdown_ts = now
        st.away_since = None
        st.away_frames = 0
        st.away_down = False

    # 2) Repeated-glance pattern — many short glances (each too brief to trip the normal
    # sustained GAZE_AWAY logic) are the classic signature of reading notes / a hidden device.
    recent = [g for g in st.glance_events if now - g[0] <= GLANCE_WINDOW_SEC]
    if len(recent) >= GLANCE_REPEAT_N and _pattern_ready(st, now, "repeated_glances"):
        down_heavy = sum(1 for g in recent if g[2]) >= max(2, len(recent) // 2)
        severity = "high" if down_heavy else "medium"
        desc = (
            f"Candidate repeatedly glanced {'down' if down_heavy else 'away from the screen'} "
            f"{len(recent)} times in the last minute"
            + (" — consistent with reading notes or using a device below the camera." if down_heavy
               else " — possible reference to unauthorized material.")
        )
        violations.append({
            "type": "SUSPICIOUS_BEHAVIOR",
            "description": desc,
            "confidence": round(min(0.95, 0.6 + 0.05 * len(recent)), 3),
            "metadata": {"severity": severity, "pattern": "repeated_glances",
                         "count": len(recent), "windowSec": int(GLANCE_WINDOW_SEC)},
        })
        _add_risk(st, now, "pattern:repeated_glances",
                  RISK_WEIGHT_PATTERN_HIGH if severity == "high" else RISK_WEIGHT_PATTERN_MEDIUM)
        _observe(st, now, f"Glanced {'down' if down_heavy else 'away'} {len(recent)}× in the last minute")

    # 3) Extended absence — NO_FACE fires early; a proctor escalates when it DRAGS ON.
    if face_count == 0:
        if st.absent_since is None:
            st.absent_since = now
        absent_for = now - st.absent_since
        if absent_for >= ABSENCE_ALERT_SEC and _pattern_ready(st, now, "extended_absence"):
            violations.append({
                "type": "SUSPICIOUS_BEHAVIOR",
                "description": f"Candidate has been away from the camera for {int(absent_for)} seconds.",
                "confidence": 0.9,
                "metadata": {"severity": "high", "pattern": "extended_absence",
                             "absentSec": int(absent_for)},
            })
            _add_risk(st, now, "pattern:extended_absence", RISK_WEIGHT_PATTERN_HIGH)
            _observe(st, now, f"Away from camera for {int(absent_for)}s")
    else:
        st.absent_since = None

    # 4) Talking while alone — sustained lip movement with a single face and nobody else
    # visible suggests communication with someone off-camera (audio is checked browser-side;
    # this catches whispering / muted-mic coaching the mic can miss).
    if face_count == 1 and mouth_open:
        if st.talk_since is None:
            st.talk_since = now
    elif st.talk_since is not None:
        if now - st.talk_since >= TALK_MIN_SEC:
            st.talk_events.append(now)
        st.talk_since = None
    recent_talk = [t for t in st.talk_events if now - t <= TALK_WINDOW_SEC]
    if len(recent_talk) >= TALK_REPEAT_N and _pattern_ready(st, now, "talking_alone"):
        violations.append({
            "type": "SUSPICIOUS_BEHAVIOR",
            "description": "Candidate appears to be talking repeatedly while alone in frame — possible communication with someone off-camera.",
            "confidence": 0.8,
            "metadata": {"severity": "medium", "pattern": "talking_alone",
                         "episodes": len(recent_talk), "windowSec": int(TALK_WINDOW_SEC)},
        })
        _add_risk(st, now, "pattern:talking_alone", RISK_WEIGHT_PATTERN_MEDIUM)
        _observe(st, now, "Talking while alone in frame")

    # 5) Phone right after a look-down — two weak signals that together are strong evidence.
    if (phone_detected and st.last_lookdown_ts
            and now - st.last_lookdown_ts <= PHONE_LOOKDOWN_CORR_SEC
            and _pattern_ready(st, now, "phone_after_lookdown")):
        violations.append({
            "type": "SUSPICIOUS_BEHAVIOR",
            "description": "A phone appeared in frame moments after the candidate looked down — likely active phone use.",
            "confidence": 0.92,
            "metadata": {"severity": "high", "pattern": "phone_after_lookdown"},
        })
        _add_risk(st, now, "pattern:phone_after_lookdown", RISK_WEIGHT_PATTERN_HIGH)
        _observe(st, now, "Phone seen right after looking down")

    # 6) Risk accounting for the base detections + notebook lines for the big ones.
    for v in violations:
        vtype = v.get("type", "")
        if vtype in RISK_WEIGHTS:
            _add_risk(st, now, vtype, RISK_WEIGHTS[vtype])
            if vtype == "PHONE_DETECTED":
                _observe(st, now, "Phone visible in frame")
            elif vtype == "MULTIPLE_FACES":
                _observe(st, now, "Second person in frame")
            elif vtype == "IDENTITY_CHANGE":
                _observe(st, now, "Person may not match enrolled candidate")

    score = _risk_score(st, now)
    level = "high" if score >= 60 else ("medium" if score >= 30 else "low")
    obs = [{"ts": int(ts * 1000), "text": text} for ts, text in list(st.observations)[-4:]]
    return {
        "risk": int(round(score)),
        "level": level,
        "note": obs[-1]["text"] if obs else None,
        "observations": obs,
    }


# ── Endpoints ─────────────────────────────────────────────────────────────────
@app.get("/health")
def health() -> dict:
    return {"status": "ok", "service": "proctor-ai", "version": "7.0.0",
            "engine": "mediapipe+blendshapes+sface+virtualproctor", "ts": int(time.time() * 1000)}


@app.post("/analyze")
def analyze(req: AnalyzeRequest) -> dict:
    rgb = _decode_rgb(req.image)
    faces, objects = _detect(rgb)  # heavy inference runs outside any session lock
    st = _get_session(req.sessionKey)
    # Frames of one session are applied to its state one at a time (see SessionState.lock);
    # different sessions still run fully in parallel.
    with (st.lock if st is not None else nullcontext()):
        return _analyze_frame(req, rgb, faces, objects, st)


def _analyze_frame(req: AnalyzeRequest, rgb: np.ndarray, faces, objects,
                   st: SessionState | None) -> dict:
    bgr = cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)
    h, w = rgb.shape[:2]

    # Size-aware people count — filters out posters / photos / reflections so a lone candidate
    # isn't falsely flagged for MULTIPLE_FACES. primary_idx is the candidate (largest face).
    face_count, primary_idx = _count_people(faces.face_landmarks)

    if st is not None:
        st.face_counts.append(face_count)

    violations: list[dict] = []
    looking_away = False
    head_yaw = 0.0
    head_pitch = 0.0
    descriptor: list[float] = []
    identity_match: bool | None = None
    # Blendshape-derived behavioural signals (v6 eye-tracking upgrade).
    eyes_closed = False
    mouth_open = False
    eye_dir = "center"
    eye_mag = 0.0
    gaze_source = "none"  # what drove the away decision: head | eyes | both | none
    away_raw = False      # per-frame away signal, feeds the virtual-proctor glance tracker
    pitch_down = False    # per-frame look-down signal, ditto

    # ── Face presence / count ────────────────────────────────────────────────
    if face_count == 0:
        # Require a stable run of empty frames (when we have history) to avoid a single-frame blip.
        empty_run = st is not None and len(st.face_counts) >= 3 and all(c == 0 for c in st.face_counts)
        if st is None or empty_run:
            violations.append({
                "type": "NO_FACE",
                "description": "No face detected in the camera frame.",
                "confidence": 0.92,
                "metadata": {"severity": "medium"},
            })
        # reset gaze history while no face is present
        if st is not None:
            st.gaze_flags.clear()
    elif face_count >= 2:
        violations.append({
            "type": "MULTIPLE_FACES",
            "description": f"{face_count} people detected in frame. Only the candidate is allowed.",
            "confidence": 0.95,
            "metadata": {"severity": "high", "faceCount": face_count},
        })

    # ── Head pose / adaptive gaze + identity for the primary (largest) face ───
    if face_count >= 1:
        landmarks = faces.face_landmarks[primary_idx]
        head_yaw, head_pitch = _head_pose(landmarks)

        # Eye-tracking signals from blendshapes for the primary (candidate) face.
        eye_sig: dict = {}
        if getattr(faces, "face_blendshapes", None) and primary_idx < len(faces.face_blendshapes):
            eye_sig = _blendshape_signals(faces.face_blendshapes[primary_idx])
            eyes_closed_raw = eye_sig["eyesClosed"]
            mouth_open_raw = eye_sig["mouthOpen"]
            eye_dir = eye_sig["eyeDir"]
            eye_mag = eye_sig["eyeMag"]
        else:
            eyes_closed_raw = False
            mouth_open_raw = False

        # Eye aversion only counts when the eyes are OPEN (a blink drives lookDown high too).
        eye_away = bool(eye_sig.get("eyeAway")) and not eyes_closed_raw

        # DYNAMIC gaze: deviation from the candidate's learned neutral pose, not a fixed threshold.
        if st is not None:
            # WARM-UP: average the first few frames into the baseline instead of trusting a single
            # frame. Bootstrapping from one frame that happened to catch a glance permanently skewed
            # the neutral pose, so the candidate then read as "looking away" while facing the screen.
            # No gaze judgment is made until the baseline is established.
            if st.yaw_baseline is None:
                st.yaw_warmup.append(head_yaw)
                st.pitch_warmup.append(head_pitch)
                if len(st.yaw_warmup) >= GAZE_WARMUP_FRAMES:
                    st.yaw_baseline = sorted(st.yaw_warmup)[len(st.yaw_warmup) // 2]      # median
                    st.pitch_baseline = sorted(st.pitch_warmup)[len(st.pitch_warmup) // 2]
                yaw_dev = 0.0
                pitch_dev = 0.0
                head_away = False
                pitch_down = False
                away_raw = False
                st.gaze_flags.append(False)
                looking_away, gaze_frac = False, 0.0
            else:
                yaw_dev = abs(head_yaw - st.yaw_baseline)
                pitch_dev = head_pitch - (st.pitch_baseline or head_pitch)  # +ve = looking down
                # Recalibrate slowly only while the head is near centre (so a held turn never drifts baseline).
                if yaw_dev < BASELINE_NEAR:
                    st.yaw_baseline = (1 - BASELINE_EMA) * st.yaw_baseline + BASELINE_EMA * head_yaw
                    st.pitch_baseline = (1 - BASELINE_EMA) * (st.pitch_baseline or head_pitch) + BASELINE_EMA * head_pitch
                head_away = yaw_dev > GAZE_YAW_MARGIN or pitch_dev > GAZE_PITCH_MARGIN
                pitch_down = pitch_dev > GAZE_PITCH_MARGIN
                # Looking-away is driven by HEAD position only: a decisive head turn (≥ GAZE_YAW_MARGIN)
                # or a steep look-down. Eyes-only glances (head straight, eyes moved) no longer count.
                away_raw = head_away
                st.gaze_flags.append(away_raw)
                looking_away, gaze_frac = _sustained(st.gaze_flags, need_frac=0.6)

            # Smooth the eyes-closed / talking signals over the window so a single blink or
            # word doesn't flip them; these feed the live proctor wall, not DB violations.
            st.eyes_closed_flags.append(eyes_closed_raw)
            st.mouth_open_flags.append(mouth_open_raw)
            eyes_closed, _ = _sustained(st.eyes_closed_flags, need_frac=0.6)
            mouth_open, _ = _sustained(st.mouth_open_flags, need_frac=0.5)

            if looking_away:
                # Looking-away is head-driven only, so the source is always the head turn / look-down.
                gaze_source = "head"
                violations.append({
                    "type": "GAZE_AWAY",
                    "description": "Candidate appears to be looking away from the screen.",
                    "confidence": round(min(0.95, 0.6 + gaze_frac * 0.35), 3),
                    "metadata": {"severity": "low", "yawDev": round(yaw_dev, 3),
                                 "pitchDev": round(pitch_dev, 3),
                                 "eyeDir": eye_dir, "eyeMag": eye_mag, "source": gaze_source},
                })
        else:
            # No session key → stateless fallback: head clearly turned away (eyes-only ignored).
            looking_away = abs(head_yaw) > GAZE_YAW_MARGIN
            eyes_closed = eyes_closed_raw
            mouth_open = mouth_open_raw

        # ── REAL identity via SFace embedding ─────────────────────────────────
        # SFace is a full CNN embedding and the single most expensive step in /analyze. It is only
        # meaningful when there is exactly ONE face to verify AND the client sent an enrolled
        # template to compare against — so compute it ONLY then. On no-face / multi-face frames, or
        # before enrollment exists, the embedding was pure wasted CPU every frame. (The analyze
        # response's `descriptor` field is not consumed by the client — enrollment uses /enroll.)
        want_identity = (face_count == 1 and req.enrollDescriptor is not None
                         and len(req.enrollDescriptor) >= 128)
        if want_identity:
            descriptor = _sface_embed(bgr) or []
        if want_identity and len(descriptor) >= 128:
            cos = _cosine(descriptor, req.enrollDescriptor)
            frame_match = cos >= SFACE_COSINE_MATCH
            if st is not None:
                st.identity_flags.append(not frame_match)  # track MISmatches
                mism, mism_frac = _sustained(st.identity_flags, need_frac=0.6)
                identity_match = not mism
                if mism:
                    violations.append({
                        "type": "IDENTITY_CHANGE",
                        "description": "Person on camera may not match the enrolled candidate.",
                        "confidence": round(min(0.97, 0.6 + mism_frac * 0.37), 3),
                        "metadata": {"severity": "high", "cosine": round(cos, 3)},
                    })
            else:
                identity_match = frame_match
                if not frame_match:
                    violations.append({
                        "type": "IDENTITY_CHANGE",
                        "description": "Person on camera may not match the enrolled candidate.",
                        "confidence": round(min(0.97, 0.6 + (SFACE_COSINE_MATCH - cos)), 3),
                        "metadata": {"severity": "high", "cosine": round(cos, 3)},
                    })

    # ── Objects: phone + study material / second device, temporally smoothed ──
    # A "cell phone" box only counts once it looks like a phone: elongated, big enough, and not
    # sitting on the candidate's head. Without this, headsets and wristwatches — neither of which
    # COCO can name — were reported as phone use.
    head_box = _head_box_px(faces.face_landmarks[primary_idx], w, h) if face_count >= 1 else None
    phone_raw = False
    phone_best = 0.0
    phone_rejects: list[str] = []
    anomaly_objects: list[dict] = []
    for det in objects.detections:
        cat = det.categories[0]
        name = (cat.category_name or "").lower().strip()
        score = float(cat.score)
        if name in PHONE_LABELS and score >= PHONE_MIN_SCORE:
            reason = _phone_box_reason(det.bounding_box, w, h, head_box)
            if reason:
                phone_rejects.append(reason)
                continue
            phone_raw = True
            phone_best = max(phone_best, score)
        elif name in ANOMALY_LABELS and score >= 0.50:
            anomaly_objects.append({"label": name, "score": round(score, 3)})
    if phone_rejects and not phone_raw:
        log.debug("phone box(es) rejected as %s", ", ".join(sorted(set(phone_rejects))))

    # Phone is the #1 cheating tool — flag it FAST: a single confident frame fires immediately
    # (no waiting for it to persist). The temporal buffer only adds a second path so a weaker but
    # repeated detection still counts. Both paths run on geometry-filtered boxes only.
    phone_detected = False
    if st is not None:
        st.phone_flags.append(phone_raw)
        sustained_phone, _ = _sustained(st.phone_flags, need_frac=0.6)
        phone_detected = phone_best >= PHONE_FIRE_SCORE or sustained_phone
    else:
        phone_detected = phone_raw
    if phone_detected:
        violations.append({
            "type": "PHONE_DETECTED",
            "description": "A mobile phone was detected in the camera frame.",
            "confidence": round(max(phone_best, 0.6), 3),
            "metadata": {"severity": "high", "score": round(phone_best, 3)},
        })

    # A tv/laptop/book label on ONE frame is usually the detector misreading a monitor edge or
    # a dark rectangle — the #1 anomaly false positive. A real unauthorized item stays in frame,
    # so require the detection to persist across the smoothing window before flagging.
    anomaly_confirmed = bool(anomaly_objects)
    if st is not None:
        st.anomaly_flags.append(bool(anomaly_objects))
        sustained_anom, _ = _sustained(st.anomaly_flags, need_frac=0.6)
        anomaly_confirmed = bool(anomaly_objects) and sustained_anom
    if anomaly_confirmed:
        labels = ", ".join(sorted({ANOMALY_LABELS[o["label"]] for o in anomaly_objects}))
        violations.append({
            "type": "ANOMALY_OBJECT",
            "description": f"Unauthorized item detected in frame: {labels}.",
            "confidence": round(max(o["score"] for o in anomaly_objects), 3),
            "metadata": {"severity": "medium", "objects": anomaly_objects},
        })

    # ── Virtual proctor: pattern reasoning + live risk (may add SUSPICIOUS_BEHAVIOR) ──
    proctor = None
    if st is not None:
        proctor = _virtual_proctor(
            st, time.monotonic(),
            face_count=face_count,
            away_raw=away_raw,
            eye_dir=eye_dir,
            pitch_down=pitch_down,
            mouth_open=mouth_open,
            phone_detected=phone_detected,
            violations=violations,
        )

    return {
        "faceCount": face_count,
        "lookingAway": looking_away,
        "headYaw": round(head_yaw, 3),
        "headPitch": round(head_pitch, 3),
        "eyeGazeAway": bool(eye_mag and (eye_dir != "center") and looking_away and gaze_source in ("eyes", "both")),
        "eyeDir": eye_dir,
        "eyeMag": eye_mag,
        "eyesClosed": bool(eyes_closed),
        "mouthOpen": bool(mouth_open),
        "gazeSource": gaze_source,
        "phoneDetected": phone_detected,
        # Why a "cell phone" box was discarded this frame (headset / watch / clutter). Diagnostic
        # only — nothing triggers off it; it exists so the geometry gates can be tuned on real
        # frames instead of guesses.
        "phoneIgnored": sorted(set(phone_rejects)),
        # Only expose CONFIRMED anomalies — the client triggers violations off this list.
        "anomalyObjects": anomaly_objects if anomaly_confirmed else [],
        "identityMatch": identity_match,
        "descriptor": descriptor,
        "violations": violations,
        "proctor": proctor,
    }


@app.post("/enroll")
def enroll(req: EnrollRequest) -> dict:
    """Build a robust 128-d SFace template. Accepts one image or several (averaged)."""
    images = req.images if req.images else ([req.image] if req.image else [])
    if not images:
        raise HTTPException(400, "No image provided.")
    # Each sample costs a full face pipeline on a pooled model; cap so one request can't hold a
    # pool slot for minutes with thousands of tiny images.
    images = images[:ENROLL_MAX_IMAGES]

    embeddings: list[list[float]] = []
    multi_face = False
    for b64 in images:
        rgb = _decode_rgb(b64)
        bgr = cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)
        faces, _ = _detect(rgb, with_objects=False)
        # Same size-aware people count as /analyze: a poster / photo / reflection behind the
        # candidate is not a second person. Counting raw landmark sets here rejected every sample
        # for such candidates, so the client's auto-enrollment (gated on /analyze faceCount == 1)
        # retried forever and identity was never checked.
        if _count_people(faces.face_landmarks)[0] > 1:
            multi_face = True
            continue
        emb = _sface_embed(bgr)
        if emb:
            embeddings.append(emb)

    if not embeddings:
        if multi_face:
            raise HTTPException(422, "Multiple people visible. Only the candidate should be in frame.")
        raise HTTPException(422, "No face detected. Move closer and ensure good, even lighting.")

    # Average the samples and re-normalise → a stable template.
    arr = np.mean(np.asarray(embeddings, dtype=np.float32), axis=0)
    n = float(np.linalg.norm(arr))
    if n > 0:
        arr /= n
    template = arr.tolist()
    return {"ok": True, "descriptor": template, "length": len(template), "samples": len(embeddings)}


@app.post("/verify")
def verify(req: VerifyRequest) -> dict:
    rgb = _decode_rgb(req.image)
    bgr = cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)
    faces, _ = _detect(rgb, with_objects=False)

    if not faces.face_landmarks:
        return {"match": False, "distance": None, "reason": "no_face"}

    emb = _sface_embed(bgr)
    if not emb or len(req.referenceDescriptor) < 128:
        return {"match": False, "distance": None, "reason": "bad_descriptor"}

    cos = _cosine(emb, req.referenceDescriptor)
    return {"match": cos >= SFACE_COSINE_MATCH, "distance": round(1.0 - cos, 3),
            "cosine": round(cos, 3), "descriptor": emb}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8765, log_level="info")
