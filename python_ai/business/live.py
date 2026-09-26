"""Python port of api/live.php — live proctoring relay (frame-push wall + per-session frame)."""

from __future__ import annotations

import base64
import os
import re

from fastapi import APIRouter, Request
from fastapi.responses import PlainTextResponse, Response

from .core import (
    ApiError, add_column_if_missing, db, dt_ms, execute, json_input, now_ms, php_int,
    q, q1, require_company_id, require_role, table_exists,
)

router = APIRouter()

LIVE_ONLINE_WINDOW_SEC = 12
LIVE_WALL_WINDOW_SEC = 40

STORAGE_ROOT = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
                            "storage", "live")


def _is_numeric(value) -> bool:
    if isinstance(value, bool) or value is None:
        return False
    if isinstance(value, (int, float)):
        return True
    if isinstance(value, str):
        return bool(re.match(r"^\s*[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?\s*$", value))
    return False


def ensure_live_schema(conn) -> bool:
    if table_exists(conn, "live_proctor_frames"):
        return True
    try:
        execute(conn, """CREATE TABLE IF NOT EXISTS live_proctor_frames (
          session_id          BIGINT UNSIGNED NOT NULL PRIMARY KEY,
          company_id          INT NOT NULL DEFAULT 1,
          exam_id             VARCHAR(64) NOT NULL,
          student_id          VARCHAR(64) NOT NULL,
          face_count          INT NULL,
          gaze_away           TINYINT(1) NOT NULL DEFAULT 0,
          eyes_closed         TINYINT(1) NOT NULL DEFAULT 0,
          mouth_open          TINYINT(1) NOT NULL DEFAULT 0,
          phone               TINYINT(1) NOT NULL DEFAULT 0,
          multiple_faces      TINYINT(1) NOT NULL DEFAULT 0,
          risk_score          INT NULL,
          risk_level          VARCHAR(8) NULL,
          ai_note             VARCHAR(255) NULL,
          last_violation_type VARCHAR(32) NULL,
          last_violation_at   TIMESTAMP NULL DEFAULT NULL,
          frame_path          VARCHAR(1024) NOT NULL,
          size_bytes          INT NOT NULL DEFAULT 0,
          started_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          INDEX idx_live_company_updated (company_id, updated_at)
        ) ENGINE=InnoDB""")
    except Exception:
        pass
    return table_exists(conn, "live_proctor_frames")


def _script_dir(request: Request) -> str:
    prefix = request.headers.get("x-forwarded-prefix", "")
    if prefix:
        return prefix.rstrip("/") or "/api"
    return "/api"


def live_decode_jpeg(data_url):
    if not isinstance(data_url, str) or data_url == "":
        return None
    b64 = data_url
    comma = data_url.find(",")
    if data_url.startswith("data:") and comma != -1:
        b64 = data_url[comma + 1:]
    try:
        raw = base64.b64decode(b64, validate=True)
    except Exception:
        return None
    if len(raw) < 128 or len(raw) > 2 * 1024 * 1024:
        return None
    is_jpeg = raw[:2] == b"\xFF\xD8"
    is_png = raw[:8] == b"\x89PNG\r\n\x1a\n"
    if not is_jpeg and not is_png:
        return None
    return raw


@router.get("/live.php")
def get_live(request: Request):
    with db() as conn:
        schema_ready = ensure_live_schema(conn)
        if schema_ready:
            add_column_if_missing(conn, "live_proctor_frames", "risk_score", "INT NULL AFTER multiple_faces")
            add_column_if_missing(conn, "live_proctor_frames", "risk_level", "VARCHAR(8) NULL AFTER risk_score")
            add_column_if_missing(conn, "live_proctor_frames", "ai_note", "VARCHAR(255) NULL AFTER risk_level")

        company_id = require_company_id(request)
        mode = (request.query_params.get("mode") or "wall").strip().lower()

        if mode == "frame":
            session_id = php_int(request.query_params.get("sessionId"))
            if session_id <= 0 or not schema_ready:
                return PlainTextResponse("Not found", status_code=404)
            row = q1(conn, "SELECT frame_path FROM live_proctor_frames WHERE session_id = %s AND company_id = %s LIMIT 1",
                     (session_id, company_id))
            path = row.get("frame_path") if row else None
            if not path or not os.path.isfile(path):
                return PlainTextResponse("Not found", status_code=404)
            with open(path, "rb") as fp:
                data = fp.read()
            return Response(content=data, media_type="image/jpeg", headers={
                "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
                "Pragma": "no-cache",
                "Content-Length": str(len(data)),
            })

        # mode = wall
        require_role(request, ["ADMIN", "SUPER_ADMIN", "PROCTOR"])
        if not schema_ready:
            return {"live": [], "serverTime": now_ms()}
        script_dir = _script_dir(request)
        rows = q(conn, """SELECT lpf.*, TIMESTAMPDIFF(SECOND, lpf.updated_at, NOW()) AS age_sec
                          FROM live_proctor_frames lpf
                          WHERE lpf.company_id = %s AND lpf.updated_at >= DATE_SUB(NOW(), INTERVAL %s SECOND)
                          ORDER BY lpf.updated_at DESC""", (company_id, LIVE_WALL_WINDOW_SEC))
        live = []
        for r in rows:
            sid = int(r["session_id"])
            age = int(r["age_sec"]) if r.get("age_sec") is not None else 999
            live.append({
                "sessionId": sid,
                "examId": r["exam_id"],
                "studentId": r["student_id"],
                "faceCount": int(r["face_count"]) if r.get("face_count") is not None else None,
                "gazeAway": bool(r["gaze_away"]),
                "eyesClosed": bool(r["eyes_closed"]),
                "mouthOpen": bool(r["mouth_open"]),
                "phone": bool(r["phone"]),
                "multipleFaces": bool(r["multiple_faces"]),
                "riskScore": int(r["risk_score"]) if r.get("risk_score") is not None else None,
                "riskLevel": r.get("risk_level"),
                "aiNote": r.get("ai_note"),
                "lastViolationType": r.get("last_violation_type"),
                "lastViolationAt": dt_ms(r.get("last_violation_at")),
                "updatedAt": dt_ms(r.get("updated_at")),
                "startedAt": dt_ms(r.get("started_at")),
                "online": age <= LIVE_ONLINE_WINDOW_SEC,
                "ageSec": age,
                "frameUrl": f"{script_dir}/live.php?mode=frame&sessionId={sid}&companyId={company_id}",
            })
        return {"live": live, "serverTime": now_ms()}


@router.post("/live.php")
async def post_live(request: Request):
    payload = await json_input(request)
    with db() as conn:
        schema_ready = ensure_live_schema(conn)
        if schema_ready:
            add_column_if_missing(conn, "live_proctor_frames", "risk_score", "INT NULL AFTER multiple_faces")
            add_column_if_missing(conn, "live_proctor_frames", "risk_level", "VARCHAR(8) NULL AFTER risk_score")
            add_column_if_missing(conn, "live_proctor_frames", "ai_note", "VARCHAR(255) NULL AFTER risk_level")

        company_id = require_company_id(request, payload)
        action = str(payload.get("action") or "PUSH").strip().upper()

        if action == "PUSH":
            if not schema_ready:
                return {"ok": False, "error": "LIVE_SCHEMA_UNAVAILABLE"}
            session_id = php_int(payload["sessionId"]) if _is_numeric(payload.get("sessionId")) else 0
            exam_id = str(payload.get("examId") or "").strip()
            student_id = str(payload.get("studentId") or "").strip()
            if session_id <= 0 or exam_id == "" or student_id == "":
                raise ApiError({"ok": False, "error": "sessionId, examId and studentId are required."}, 400)

            if not q1(conn, "SELECT id FROM exam_sessions WHERE id = %s AND company_id = %s LIMIT 1", (session_id, company_id)):
                raise ApiError({"ok": False, "error": "SESSION_NOT_FOUND"}, 404)

            status = payload.get("status") if isinstance(payload.get("status"), dict) else {}
            face_count = php_int(status["faceCount"]) if _is_numeric(status.get("faceCount")) else None
            gaze_away = 1 if status.get("gazeAway") else 0
            eyes_closed = 1 if status.get("eyesClosed") else 0
            mouth_open = 1 if status.get("mouthOpen") else 0
            phone = 1 if status.get("phone") else 0
            multiple_faces = 1 if (status.get("multipleFaces") or (face_count is not None and face_count >= 2)) else 0
            risk_score = max(0, min(100, php_int(status["riskScore"]))) if _is_numeric(status.get("riskScore")) else None
            risk_level = str(status["riskLevel"]) if str(status.get("riskLevel") or "") in ("low", "medium", "high") else None
            ai_note = str(status["aiNote"])[:255] if isinstance(status.get("aiNote"), str) and status.get("aiNote") != "" else None
            last_violation_type = str(payload["lastViolationType"])[:32] if payload.get("lastViolationType") else None

            raw = live_decode_jpeg(payload.get("image"))
            directory = os.path.join(STORAGE_ROOT, str(company_id))
            try:
                os.makedirs(directory, mode=0o775, exist_ok=True)
            except OSError:
                raise RuntimeError("Failed to create live storage directory.")
            path = os.path.join(directory, f"{session_id}.jpg")
            size = 0
            if raw is not None:
                try:
                    with open(path, "wb") as fp:
                        fp.write(raw)
                    size = len(raw)
                except OSError:
                    size = 0

            insert_viol = "NOW()" if last_violation_type is not None else "NULL"
            update_viol = "NOW()" if last_violation_type is not None else "last_violation_at"
            sql = f"""INSERT INTO live_proctor_frames
                  (session_id, company_id, exam_id, student_id, face_count, gaze_away, eyes_closed,
                   mouth_open, phone, multiple_faces, risk_score, risk_level, ai_note,
                   last_violation_type, last_violation_at, frame_path, size_bytes)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, {insert_viol}, %s, %s)
                ON DUPLICATE KEY UPDATE
                  face_count = VALUES(face_count),
                  gaze_away = VALUES(gaze_away),
                  eyes_closed = VALUES(eyes_closed),
                  mouth_open = VALUES(mouth_open),
                  phone = VALUES(phone),
                  multiple_faces = VALUES(multiple_faces),
                  risk_score = COALESCE(VALUES(risk_score), risk_score),
                  risk_level = COALESCE(VALUES(risk_level), risk_level),
                  ai_note = COALESCE(VALUES(ai_note), ai_note),
                  last_violation_type = COALESCE(VALUES(last_violation_type), last_violation_type),
                  last_violation_at = {update_viol},
                  frame_path = VALUES(frame_path),
                  size_bytes = VALUES(size_bytes),
                  updated_at = NOW()"""
            execute(conn, sql, (session_id, company_id, exam_id, student_id, face_count, gaze_away, eyes_closed,
                                mouth_open, phone, multiple_faces, risk_score, risk_level, ai_note,
                                last_violation_type, path, size))
            return {"ok": True}

        if action == "STOP":
            if schema_ready:
                session_id = php_int(payload["sessionId"]) if _is_numeric(payload.get("sessionId")) else 0
                if session_id > 0:
                    execute(conn, "DELETE FROM live_proctor_frames WHERE session_id = %s AND company_id = %s",
                            (session_id, company_id))
            return {"ok": True}

        raise ApiError({"ok": False, "error": "Invalid action."}, 400)
