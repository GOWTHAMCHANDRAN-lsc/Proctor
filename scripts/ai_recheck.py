#!/usr/bin/env python3
"""
Re-runs a stored camera recording through the live proctoring detection engine
(python_ai/main.py's /analyze) frame-by-frame, and collapses the raw per-frame hits
through the same per-type cooldown windows the live exam UI uses
(components/student/ExamTake.tsx's triggerProctorFeedback), so the result reads like
what a working live detector would actually have logged - not one row per sampled frame.

Usage: ai_recheck.py <video_path> <enroll_descriptor_json_or_empty> [sample_every_ms]

Prints a single JSON object to stdout: {"violations": [{"type", "offset_ms", "confidence",
"severity", "metadata", "snapshot"}, ...]} or {"error": "..."} on failure.
"""
import base64
import json
import os
import sys
import time
import urllib.request

import cv2

AI_ANALYZE_URL = "http://127.0.0.1:8765/analyze"

# Mirrors the cooldown map in components/student/ExamTake.tsx's triggerProctorFeedback so a
# recheck's collapsed timeline matches what live detection would have produced.
COOLDOWNS_MS = {
    "NO_FACE": 10000,
    "MULTIPLE_FACES": 8000,
    "GAZE_AWAY": 8000,
    "PHONE_DETECTED": 10000,
    "ANOMALY_OBJECT": 15000,
    "SUSPICIOUS_BEHAVIOR": 20000,
}
DEFAULT_COOLDOWN_MS = 5000  # IDENTITY_CHANGE and anything else not listed above


def main() -> None:
    if len(sys.argv) < 2:
        print(json.dumps({"error": "usage: ai_recheck.py <video_path> [descriptor_json] [sample_every_ms]"}))
        return

    video_path = sys.argv[1]
    descriptor_arg = sys.argv[2] if len(sys.argv) > 2 else ""
    sample_every_ms = int(sys.argv[3]) if len(sys.argv) > 3 else 1000

    try:
        descriptor = json.loads(descriptor_arg) if descriptor_arg.strip() else []
    except Exception:
        descriptor = []

    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        print(json.dumps({"error": f"failed to open video: {video_path}"}))
        return

    session_key = f"recheck-{int(time.time() * 1000)}-{os.getpid()}"
    last_fire_ms: dict = {}
    collapsed: list = []

    next_sample_ms = 0.0
    last_pos_ms = 0.0
    # Counters so a run that analyzed nothing is reported as a failure rather than as a clean
    # "0 violations found" (recheck_recording.php would otherwise mark it DONE).
    frames_read = 0
    sampled = 0
    analyzed = 0
    last_error = ""

    while True:
        ok, frame = cap.read()
        if not ok:
            break
        frames_read += 1
        pos_ms = cap.get(cv2.CAP_PROP_POS_MSEC)
        if pos_ms <= 0:
            pos_ms = last_pos_ms + (1000.0 / 25.0)
        last_pos_ms = pos_ms

        if pos_ms < next_sample_ms:
            continue
        next_sample_ms += sample_every_ms

        ok2, buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 80])
        if not ok2:
            continue
        b64 = base64.b64encode(buf.tobytes()).decode("ascii")
        payload = {"image": f"data:image/jpeg;base64,{b64}", "sessionKey": session_key}
        if descriptor:
            payload["enrollDescriptor"] = descriptor

        sampled += 1
        try:
            req = urllib.request.Request(
                AI_ANALYZE_URL,
                data=json.dumps(payload).encode("utf-8"),
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=15) as resp:
                data = json.loads(resp.read().decode("utf-8"))
        except Exception as exc:
            last_error = str(exc)
            continue
        analyzed += 1

        for v in data.get("violations", []) or []:
            vtype = v.get("type")
            if not vtype:
                continue
            cooldown = COOLDOWNS_MS.get(vtype, DEFAULT_COOLDOWN_MS)
            last = last_fire_ms.get(vtype, -1e18)
            if pos_ms - last < cooldown:
                continue
            last_fire_ms[vtype] = pos_ms
            collapsed.append({
                "type": vtype,
                "offset_ms": int(pos_ms),
                "confidence": v.get("confidence"),
                "severity": (v.get("metadata") or {}).get("severity"),
                "metadata": v.get("metadata") or {},
            })

    cap.release()

    if frames_read == 0:
        print(json.dumps({"error": "no decodable frames in the camera recording"}))
        return
    if sampled > 0 and analyzed == 0:
        detail = f": {last_error}" if last_error else ""
        print(json.dumps({"error": f"AI analysis service failed for every sampled frame ({sampled}){detail}"}))
        return

    # Second pass: re-seek to each retained violation's exact offset for a clean evidence frame
    # (the sampling pass' frames aren't kept, to avoid holding hundreds of JPEGs in memory).
    cap2 = cv2.VideoCapture(video_path)
    for item in collapsed:
        cap2.set(cv2.CAP_PROP_POS_MSEC, float(item["offset_ms"]))
        ok, frame = cap2.read()
        if not ok:
            item["snapshot"] = None
            continue
        h, w = frame.shape[:2]
        scale = 480.0 / w
        resized = cv2.resize(frame, (480, max(1, int(h * scale))))
        ok2, buf = cv2.imencode(".jpg", resized, [cv2.IMWRITE_JPEG_QUALITY, 62])
        item["snapshot"] = f"data:image/jpeg;base64,{base64.b64encode(buf.tobytes()).decode('ascii')}" if ok2 else None
    cap2.release()

    print(json.dumps({"violations": collapsed}))


if __name__ == "__main__":
    main()
