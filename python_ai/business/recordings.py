"""Python port of api/recordings.php — recording session/stream storage + range-served playback.

fileUrl paths are emitted as "/api/recordings.php?..." to match the PHP SCRIPT_NAME dirname
on this deployment (nginx serves the app under /api/). Override via X-Forwarded-Prefix if set.
"""

from __future__ import annotations

import fcntl
import os
import re

from fastapi import APIRouter, Request
from fastapi.responses import PlainTextResponse, StreamingResponse

from .core import (
    ApiError, audit_log, db, dt_ms, execute, json_input, last_insert_id, php_int, q, q1,
    require_company_id, table_exists,
)

router = APIRouter()

STORAGE_ROOT = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
                            "storage", "recordings")


def _is_numeric(value) -> bool:
    if isinstance(value, bool) or value is None:
        return False
    if isinstance(value, (int, float)):
        return True
    if isinstance(value, str):
        return bool(re.match(r"^\s*[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?\s*$", value))
    return False


def ensure_recording_schema(conn) -> bool:
    sessions_exists = table_exists(conn, "recording_sessions")
    streams_exists = table_exists(conn, "recording_streams")
    if sessions_exists and streams_exists:
        return True
    try:
        if not sessions_exists:
            execute(conn, """CREATE TABLE IF NOT EXISTS recording_sessions (
      id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      company_id   INT NOT NULL DEFAULT 1,
      exam_id      VARCHAR(64) NOT NULL,
      student_id   VARCHAR(64) NOT NULL,
      session_id   BIGINT UNSIGNED NULL,
      status       ENUM('INIT','RECORDING','COMPLETED','FAILED') NOT NULL DEFAULT 'INIT',
      started_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      ended_at     TIMESTAMP NULL DEFAULT NULL,
      duration_sec INT NULL,
      created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_recording_session_lookup (company_id, exam_id, student_id, started_at),
      INDEX idx_recording_session_status (status)
    ) ENGINE=InnoDB""")
        if not streams_exists:
            execute(conn, """CREATE TABLE IF NOT EXISTS recording_streams (
      id                   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      recording_session_id BIGINT UNSIGNED NOT NULL,
      stream_type          ENUM('camera','screen','combined') NOT NULL,
      mime_type            VARCHAR(128) NULL,
      file_path            VARCHAR(1024) NOT NULL,
      size_bytes           BIGINT UNSIGNED NOT NULL DEFAULT 0,
      chunk_count          INT NOT NULL DEFAULT 0,
      created_at           TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at           TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uk_recording_stream_unique (recording_session_id, stream_type),
      INDEX idx_recording_stream_type (stream_type),
      CONSTRAINT fk_recording_stream_session
        FOREIGN KEY (recording_session_id) REFERENCES recording_sessions(id)
        ON DELETE CASCADE
    ) ENGINE=InnoDB""")
    except Exception:
        pass
    return table_exists(conn, "recording_sessions") and table_exists(conn, "recording_streams")


def file_ext_from_mime(mime) -> str:
    m = str(mime or "").strip().lower()
    if "mp4" in m:
        return "mp4"
    return "webm"


def _script_dir(request: Request) -> str:
    prefix = request.headers.get("x-forwarded-prefix", "")
    if prefix:
        return prefix.rstrip("/") or "/api"
    return "/api"


def stream_file_with_range(request: Request, path: str, mime: str):
    if not os.path.isfile(path):
        return PlainTextResponse("Not found", status_code=404)
    size = os.path.getsize(path)
    start = 0
    end = size - 1 if size > 0 else 0
    status = 200

    rng = request.headers.get("range", "")
    m = re.search(r"bytes=(\d*)-(\d*)", rng) if rng else None
    if m:
        range_start = int(m.group(1)) if m.group(1) != "" else 0
        range_end = int(m.group(2)) if m.group(2) != "" else end
        if range_start <= range_end and range_start < size:
            start = max(0, range_start)
            end = min(end, range_end)
            status = 206

    length = (end - start + 1) if size > 0 else 0
    headers = {
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
        "Pragma": "no-cache",
        "Expires": "0",
        "Content-Length": str(length),
    }
    if status == 206:
        headers["Content-Range"] = f"bytes {start}-{end}/{size}"

    def iterator():
        remaining = length
        with open(path, "rb") as fp:
            if start > 0:
                fp.seek(start)
            chunk = 1024 * 1024
            while remaining > 0:
                buf = fp.read(min(chunk, remaining))
                if not buf:
                    break
                remaining -= len(buf)
                yield buf

    return StreamingResponse(iterator(), status_code=status, media_type=mime, headers=headers)


@router.get("/recordings.php")
def get_recordings(request: Request):
    with db() as conn:
        schema_ready = ensure_recording_schema(conn)
        company_id = require_company_id(request)
        script_dir = _script_dir(request)
        mode = (request.query_params.get("mode") or "list").strip().lower()

        if mode == "summary":
            summary = {"cameraCount": 0, "screenCount": 0, "combinedCount": 0, "totalCount": 0}
            if not schema_ready:
                return {"summary": summary}
            rows = q(conn, """SELECT rs.stream_type, COUNT(*) AS cnt
                              FROM recording_streams rs
                              JOIN recording_sessions r ON r.id = rs.recording_session_id
                              WHERE r.company_id = %s AND rs.size_bytes > 0
                              GROUP BY rs.stream_type""", (company_id,))
            for row in rows:
                cnt = int(row["cnt"])
                if row["stream_type"] == "camera":
                    summary["cameraCount"] = cnt
                elif row["stream_type"] == "screen":
                    summary["screenCount"] = cnt
                elif row["stream_type"] == "combined":
                    summary["combinedCount"] = cnt
                summary["totalCount"] += cnt
            return {"summary": summary}

        if mode == "file":
            if not schema_ready:
                return PlainTextResponse("Not found", status_code=404)
            recording_id = php_int(request.query_params.get("recordingId"))
            stream_type = (request.query_params.get("streamType") or "").strip().lower()
            if recording_id <= 0 or stream_type not in ("camera", "screen", "combined"):
                raise ApiError({"error": "recordingId and valid streamType are required."}, 400)
            row = q1(conn, """SELECT rs.file_path, rs.mime_type
                              FROM recording_streams rs
                              JOIN recording_sessions r ON r.id = rs.recording_session_id
                              WHERE r.company_id = %s AND r.id = %s AND rs.stream_type = %s LIMIT 1""",
                     (company_id, recording_id, stream_type))
            if not row:
                return PlainTextResponse("Not found", status_code=404)
            path = str(row["file_path"])
            mime = str(row.get("mime_type") or "video/webm")
            resp = stream_file_with_range(request, path, mime)
            if request.query_params.get("dl"):
                ext = file_ext_from_mime(mime)
                resp.headers["Content-Disposition"] = f'attachment; filename="recording_{recording_id}_{stream_type}.{ext}"'
            return resp

        limit = php_int(request.query_params.get("limit"), 120)
        if limit <= 0:
            limit = 120
        if limit > 500:
            limit = 500
        exam_id = (request.query_params.get("examId") or "").strip()
        student_id = (request.query_params.get("studentId") or "").strip()

        if not schema_ready:
            return {"recordings": []}

        sql = """SELECT id, exam_id, student_id, session_id, status, started_at, ended_at, duration_sec
                 FROM recording_sessions WHERE company_id = %s"""
        params: list = [company_id]
        if exam_id != "":
            sql += " AND exam_id = %s"
            params.append(exam_id)
        if student_id != "":
            sql += " AND student_id = %s"
            params.append(student_id)
        sql += " ORDER BY started_at DESC LIMIT %s"
        params.append(limit)
        sessions = q(conn, sql, params)

        records = []
        for s in sessions:
            rid = int(s["id"])
            streams_raw = q(conn, """SELECT stream_type, mime_type, size_bytes, created_at
                                     FROM recording_streams WHERE recording_session_id = %s""", (rid,))
            streams = []
            for row in streams_raw:
                stype = str(row["stream_type"])
                size = int(row["size_bytes"])
                streams.append({
                    "streamType": stype,
                    "mimeType": row.get("mime_type"),
                    "sizeBytes": size,
                    "hasFile": size > 0,
                    "fileUrl": (f"{script_dir}/recordings.php?mode=file&recordingId={rid}&streamType={stype}&companyId={company_id}"
                                if size > 0 else None),
                    "createdAt": dt_ms(row.get("created_at")),
                })
            records.append({
                "id": rid,
                "examId": s["exam_id"],
                "studentId": s["student_id"],
                "sessionId": int(s["session_id"]) if s.get("session_id") is not None else None,
                "status": s["status"],
                "startedAt": dt_ms(s["started_at"]) or 0,
                "endedAt": dt_ms(s.get("ended_at")),
                "durationSec": int(s["duration_sec"]) if s.get("duration_sec") is not None else None,
                "streams": streams,
            })

        return {"recordings": records}


@router.post("/recordings.php")
async def post_recordings(request: Request):
    content_type = request.headers.get("content-type", "")
    is_multipart = "multipart/form-data" in content_type.lower()
    form = None
    payload: dict = {}
    if is_multipart:
        form = await request.form()
        company_id = require_company_id(request)
        action = str(form.get("action") or "").strip().upper()
    else:
        payload = await json_input(request)
        company_id = require_company_id(request, payload)
        action = str(payload.get("action") or "").strip().upper()

    def field(name, default=None):
        if form is not None and name in form:
            return form.get(name)
        return payload.get(name, default)

    with db() as conn:
        schema_ready = ensure_recording_schema(conn)
        unavailable = {"error": "RECORDING_SCHEMA_UNAVAILABLE",
                       "message": "Recording tables are unavailable. Please run schema migration."}

        if action == "INIT":
            if not schema_ready:
                raise ApiError(unavailable, 503)
            exam_id = str(field("examId", "") or "").strip()
            student_id = str(field("studentId", "") or "").strip()
            session_raw = field("sessionId")
            session_id = php_int(session_raw) if _is_numeric(session_raw) else None
            if exam_id == "" or student_id == "":
                raise ApiError({"error": "examId and studentId are required."}, 400)
            execute(conn, """INSERT INTO recording_sessions (company_id, exam_id, student_id, session_id, status, started_at)
                             VALUES (%s, %s, %s, %s, 'RECORDING', NOW(3))""",
                    (company_id, exam_id, student_id, session_id))
            recording_id = last_insert_id(conn)
            audit_log(conn, request, {
                "companyId": company_id, "actorRole": "SYSTEM", "actorId": student_id,
                "action": "RECORDING_INIT", "targetType": "exam", "targetId": exam_id,
                "message": f"Recording started (#{recording_id})",
                "metadata": {"recordingId": recording_id, "sessionId": session_id},
            })
            return {"ok": True, "recordingId": recording_id}

        if action == "CHUNK":
            if not schema_ready:
                raise ApiError(unavailable, 503)
            recording_id = php_int(field("recordingId", 0))
            stream_type = str(field("streamType", "") or "").strip().lower()
            mime_type = str(field("mimeType", "video/webm") or "video/webm").strip()
            if recording_id <= 0 or stream_type not in ("camera", "screen", "combined"):
                raise ApiError({"error": "recordingId and valid streamType are required."}, 400)
            chunk = form.get("chunk") if form is not None else None
            if chunk is None or not hasattr(chunk, "read"):
                raise ApiError({"error": "chunk file is required."}, 400)

            session = q1(conn, "SELECT id, exam_id, student_id FROM recording_sessions WHERE id = %s AND company_id = %s LIMIT 1",
                         (recording_id, company_id))
            if not session:
                raise ApiError({"error": "RECORDING_NOT_FOUND"}, 404)

            ext = file_ext_from_mime(mime_type)
            directory = os.path.join(STORAGE_ROOT, str(company_id), str(session["exam_id"]),
                                     str(session["student_id"]), str(recording_id))
            try:
                os.makedirs(directory, mode=0o775, exist_ok=True)
            except OSError:
                raise ApiError({"error": "Failed to store chunk."}, 500)
            path = os.path.join(directory, f"{stream_type}.{ext}")

            data = await chunk.read()
            try:
                with open(path, "ab") as fp:
                    fcntl.flock(fp.fileno(), fcntl.LOCK_EX)
                    try:
                        written = fp.write(data)
                    finally:
                        fcntl.flock(fp.fileno(), fcntl.LOCK_UN)
            except OSError:
                raise ApiError({"error": "Failed to store chunk."}, 500)

            execute(conn, """INSERT INTO recording_streams
                (recording_session_id, stream_type, mime_type, file_path, size_bytes, chunk_count)
                VALUES (%s, %s, %s, %s, %s, 1)
                ON DUPLICATE KEY UPDATE
                    mime_type = VALUES(mime_type),
                    file_path = VALUES(file_path),
                    size_bytes = size_bytes + VALUES(size_bytes),
                    chunk_count = chunk_count + 1""",
                    (recording_id, stream_type, mime_type, path, int(written)))
            execute(conn, "UPDATE recording_sessions SET status = 'RECORDING' WHERE id = %s AND company_id = %s",
                    (recording_id, company_id))
            return {"ok": True, "written": int(written)}

        if action == "COMPLETE":
            if not schema_ready:
                raise ApiError(unavailable, 503)
            recording_id = php_int(field("recordingId", 0))
            duration_raw = field("durationSec")
            duration_sec = max(0, php_int(duration_raw)) if _is_numeric(duration_raw) else None
            status = str(field("status", "COMPLETED") or "COMPLETED").strip().upper()
            if status not in ("COMPLETED", "FAILED"):
                status = "COMPLETED"
            if recording_id <= 0:
                raise ApiError({"error": "recordingId is required."}, 400)
            execute(conn, """UPDATE recording_sessions SET status = %s, ended_at = NOW(3), duration_sec = %s
                             WHERE id = %s AND company_id = %s""",
                    (status, duration_sec, recording_id, company_id))
            return {"ok": True}

        raise ApiError({"error": "Invalid action."}, 400)
