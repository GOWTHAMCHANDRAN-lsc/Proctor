"""Python port of api/access_requests.php — exam re-attempt / device-change access requests."""

from __future__ import annotations

import datetime as _dt
import json

from fastapi import APIRouter, Request

from .core import (
    ApiError, add_column_if_missing, audit_log, db, dt_ms, execute, get_actor_id,
    json_input, last_insert_id, php_int, php_json_normalize, q, q1, require_company_id,
    require_role,
)

router = APIRouter()


def parse_summary(raw):
    if isinstance(raw, (dict, list)):
        return php_json_normalize(raw)
    if not isinstance(raw, str) or raw == "":
        return None
    try:
        decoded = json.loads(raw)
    except (ValueError, TypeError):
        return None
    return php_json_normalize(decoded) if isinstance(decoded, (dict, list)) else None


def build_violation_summary(conn, company_id: int, exam_id: str, student_id: str) -> dict:
    session = q1(conn, """SELECT id FROM exam_sessions
                          WHERE company_id = %s AND exam_id = %s AND student_id = %s AND status = 'TERMINATED'
                          ORDER BY COALESCE(end_time, start_time) DESC LIMIT 1""",
                 (company_id, exam_id, student_id))
    if not session:
        return {"total": 0, "byType": {}, "byCategory": {}}

    session_id = int(session["id"])
    rows = q(conn, """SELECT vl.type, COUNT(*) AS cnt FROM violation_logs vl
                      WHERE vl.company_id = %s AND vl.session_id = %s GROUP BY vl.type""",
             (company_id, session_id))
    by_type: dict[str, int] = {}
    total = 0
    for row in rows:
        by_type[str(row["type"])] = int(row["cnt"])
        total += int(row["cnt"])

    camera = (by_type.get("NO_FACE", 0) + by_type.get("MULTIPLE_FACES", 0) + by_type.get("GAZE_AWAY", 0)
              + by_type.get("PHONE_DETECTED", 0) + by_type.get("ANOMALY_OBJECT", 0))
    by_category = {
        "camera": camera,
        "microphone": by_type.get("AUDIO_DETECTED", 0),
        "fullscreen": by_type.get("FULLSCREEN_EXIT", 0),
        "copyPaste": by_type.get("COPY_PASTE", 0),
        "tabSwitch": by_type.get("TAB_SWITCH", 0),
        "environment": by_type.get("LOCATION_CHANGE", 0),
    }
    return {"total": total, "byType": by_type, "byCategory": by_category}


def ensure_access_request_schema(conn) -> None:
    execute(conn, """CREATE TABLE IF NOT EXISTS exam_access_requests (
      id                     BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      company_id             INT NOT NULL DEFAULT 1,
      exam_id                VARCHAR(64) NOT NULL,
      student_id             VARCHAR(64) NOT NULL,
      session_id             BIGINT UNSIGNED NULL,
      status                 ENUM('PENDING','GRANTED','REVOKED') NOT NULL DEFAULT 'PENDING',
      reason                 TEXT NULL,
      violation_summary_json JSON NULL,
      review_note            TEXT NULL,
      reviewed_by            VARCHAR(64) NULL,
      requested_at           TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      reviewed_at            TIMESTAMP NULL DEFAULT NULL,
      INDEX idx_access_request_lookup (company_id, exam_id, student_id, status),
      INDEX idx_access_request_created (requested_at)
    ) ENGINE=InnoDB""")
    add_column_if_missing(conn, "exam_access_requests", "request_type", "VARCHAR(32) NOT NULL DEFAULT 'REATTEMPT' AFTER session_id")
    add_column_if_missing(conn, "exam_access_requests", "previous_device_fingerprint", "VARCHAR(128) NULL AFTER reason")
    add_column_if_missing(conn, "exam_access_requests", "new_device_fingerprint", "VARCHAR(128) NULL AFTER previous_device_fingerprint")
    add_column_if_missing(conn, "exam_access_requests", "previous_device_json", "JSON NULL AFTER new_device_fingerprint")
    add_column_if_missing(conn, "exam_access_requests", "new_device_json", "JSON NULL AFTER previous_device_json")


def normalize_device_payload(raw):
    if not isinstance(raw, dict):
        return None
    out = {}
    for key, value in raw.items():
        if not isinstance(key, str):
            continue
        if isinstance(value, (str, int, float, bool)) or value is None:
            out[key] = value[:300] if isinstance(value, str) else value
    return out


def _log_access(conn, company_id, exam_id, student_id, action, status, message):
    with conn.cursor() as cur:
        cur.execute("CALL sp_log_access(%s, %s, %s, %s, %s, %s)",
                    (company_id, exam_id, student_id, action, status, message))
        while cur.nextset():
            pass


@router.get("/access_requests.php")
def get_access_requests(request: Request):
    with db() as conn:
        schema_ready = True
        try:
            ensure_access_request_schema(conn)
        except Exception:
            schema_ready = False
        company_id = require_company_id(request)
        if not schema_ready:
            return {"requests": []}
        limit = php_int(request.query_params.get("limit"), 100)
        if limit <= 0:
            limit = 100
        if limit > 300:
            limit = 300
        status = (request.query_params.get("status") or "").strip().upper()
        if status != "" and status not in ("PENDING", "GRANTED", "REVOKED"):
            status = ""

        cols = """id, exam_id, student_id, session_id, request_type, status, reason,
                  previous_device_fingerprint, new_device_fingerprint, previous_device_json,
                  new_device_json, violation_summary_json, requested_at, reviewed_at, reviewed_by, review_note"""
        if status != "":
            rows = q(conn, f"""SELECT {cols} FROM exam_access_requests
                               WHERE company_id = %s AND status = %s
                               ORDER BY requested_at DESC LIMIT %s""", (company_id, status, limit))
        else:
            rows = q(conn, f"""SELECT {cols} FROM exam_access_requests
                               WHERE company_id = %s
                               ORDER BY requested_at DESC LIMIT %s""", (company_id, limit))

        requests = [{
            "id": int(row["id"]),
            "examId": row["exam_id"],
            "studentId": row["student_id"],
            "sessionId": int(row["session_id"]) if row.get("session_id") is not None else None,
            "requestType": row.get("request_type") or "REATTEMPT",
            "status": row["status"],
            "reason": row.get("reason"),
            "previousDeviceFingerprint": row.get("previous_device_fingerprint"),
            "newDeviceFingerprint": row.get("new_device_fingerprint"),
            "previousDevice": parse_summary(row.get("previous_device_json")),
            "newDevice": parse_summary(row.get("new_device_json")),
            "violationSummary": parse_summary(row.get("violation_summary_json")),
            "requestedAt": dt_ms(row.get("requested_at")) or 0,
            "reviewedAt": dt_ms(row.get("reviewed_at")),
            "reviewedBy": row.get("reviewed_by"),
            "reviewNote": row.get("review_note"),
        } for row in rows]
        return {"requests": requests}


@router.post("/access_requests.php")
async def post_access_requests(request: Request):
    payload = await json_input(request)
    with db() as conn:
        schema_ready = True
        try:
            ensure_access_request_schema(conn)
        except Exception:
            schema_ready = False
        company_id = require_company_id(request, payload)
        action = str(payload.get("action") or "").strip().upper()
        unavailable = {"error": "ACCESS_REQUEST_SCHEMA_UNAVAILABLE",
                       "message": "Access request table unavailable. Please run schema migration."}

        if action == "REQUEST":
            if not schema_ready:
                raise ApiError(unavailable, 503)
            exam_id = str(payload.get("examId") or "").strip()
            student_id = str(payload.get("studentId") or "").strip()
            reason = str(payload.get("reason") or "").strip()
            request_type = str(payload.get("requestType") or "REATTEMPT").strip().upper()
            if request_type not in ("REATTEMPT", "DEVICE_CHANGE"):
                request_type = "REATTEMPT"
            if exam_id == "" or student_id == "":
                raise ApiError({"error": "examId and studentId are required."}, 400)
            if request_type == "DEVICE_CHANGE" and reason == "":
                raise ApiError({"error": "COMMENT_REQUIRED",
                                "message": "Please explain why you need to continue from a different device."}, 400)

            block = None
            if request_type == "REATTEMPT":
                block = q1(conn, """SELECT id, created_at FROM exam_access_logs
                                    WHERE company_id = %s AND exam_id = %s AND student_id = %s AND action = 'VIOLATION_BLOCK'
                                    ORDER BY created_at DESC LIMIT 1""", (company_id, exam_id, student_id))
                if not block:
                    raise ApiError({"error": "NOT_BLOCKED", "message": "No blocked attempt found for this exam."}, 400)

            session = q1(conn, """SELECT id, start_time, device_fingerprint, device_metadata_json
                                  FROM exam_sessions
                                  WHERE company_id = %s AND exam_id = %s AND student_id = %s
                                  ORDER BY start_time DESC LIMIT 1""", (company_id, exam_id, student_id))
            session_id = int(session["id"]) if session else None
            previous_device_fingerprint = (session.get("device_fingerprint") if session else None) or payload.get("previousDeviceFingerprint")
            new_device_fingerprint = str(payload.get("newDeviceFingerprint") or "").strip() or None
            previous_device = (parse_summary(session.get("device_metadata_json")) if session else None)
            if previous_device is None:
                previous_device = normalize_device_payload(payload.get("previousDevice"))
            new_device = normalize_device_payload(payload.get("newDevice"))
            if request_type == "DEVICE_CHANGE" and (not session_id or not new_device_fingerprint):
                raise ApiError({"error": "DEVICE_CONTEXT_REQUIRED",
                                "message": "Device change request requires the active session and new device fingerprint."}, 400)

            if request_type == "REATTEMPT":
                since = block["created_at"]
            else:
                since = (session.get("start_time") if session else None) or _dt.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            existing = q1(conn, """SELECT id, status FROM exam_access_requests
                                   WHERE company_id = %s AND exam_id = %s AND student_id = %s AND request_type = %s AND requested_at >= %s
                                   ORDER BY requested_at DESC LIMIT 1""",
                          (company_id, exam_id, student_id, request_type, since))
            if existing and existing.get("status") == "PENDING":
                return {"ok": True, "requestId": int(existing["id"]), "status": "PENDING", "existing": True}
            if existing and existing.get("status") == "GRANTED":
                return {"ok": True, "requestId": int(existing["id"]), "status": "GRANTED", "existing": True}

            summary = parse_summary(payload.get("violationSummary"))
            if not summary:
                summary = build_violation_summary(conn, company_id, exam_id, student_id)

            if request_type == "REATTEMPT":
                terminated = q1(conn, """SELECT id FROM exam_sessions
                                         WHERE company_id = %s AND exam_id = %s AND student_id = %s AND status = 'TERMINATED'
                                         ORDER BY COALESCE(end_time, start_time) DESC LIMIT 1""",
                                (company_id, exam_id, student_id))
                session_id = int(terminated["id"]) if terminated else session_id

            execute(conn, """INSERT INTO exam_access_requests
                (company_id, exam_id, student_id, session_id, request_type, status, reason,
                 previous_device_fingerprint, new_device_fingerprint, previous_device_json, new_device_json, violation_summary_json)
                VALUES (%s, %s, %s, %s, %s, 'PENDING', %s, %s, %s, %s, %s, %s)""",
                    (company_id, exam_id, student_id, session_id, request_type,
                     reason if reason != "" else "Student requested reattempt access after violation lock.",
                     previous_device_fingerprint, new_device_fingerprint,
                     json.dumps(previous_device) if previous_device else None,
                     json.dumps(new_device) if new_device else None,
                     json.dumps(summary)))
            request_id = last_insert_id(conn)

            _log_access(conn, company_id, exam_id, student_id, "ACCESS_REQUEST", "PENDING",
                        f"Student requested {request_type} access")
            audit_log(conn, request, {
                "companyId": company_id, "actorRole": "STUDENT", "actorId": student_id,
                "action": "ACCESS_REQUEST_CREATE", "targetType": "exam", "targetId": exam_id,
                "message": f"Student requested {request_type} access",
                "metadata": {"requestId": request_id, "requestType": request_type},
            })
            return {"ok": True, "requestId": request_id, "status": "PENDING"}

        if action == "REVIEW":
            actor_role = require_role(request, ["SUPER_ADMIN", "ADMIN", "PROCTOR"], payload)
            if not schema_ready:
                raise ApiError(unavailable, 503)
            request_id = php_int(payload.get("requestId"))
            decision = str(payload.get("decision") or "").strip().upper()
            reviewer = str(payload.get("reviewer") or (get_actor_id(request, payload) or "")).strip()
            note = str(payload.get("note") or "").strip()

            if request_id <= 0 or decision not in ("GRANTED", "REVOKED"):
                raise ApiError({"error": "requestId and valid decision are required."}, 400)

            req = q1(conn, """SELECT id, exam_id, student_id, session_id, request_type, new_device_fingerprint, new_device_json
                              FROM exam_access_requests WHERE id = %s AND company_id = %s LIMIT 1""",
                     (request_id, company_id))
            if not req:
                raise ApiError({"error": "REQUEST_NOT_FOUND"}, 404)
            rtype = req.get("request_type") or ""
            if rtype == "DEVICE_CHANGE" and actor_role != "SUPER_ADMIN":
                raise ApiError({"error": "Only super admin can review device change requests."}, 403)
            if rtype != "DEVICE_CHANGE" and actor_role not in ("SUPER_ADMIN", "ADMIN"):
                raise ApiError({"error": "Only admin roles can review this request."}, 403)

            execute(conn, """UPDATE exam_access_requests
                             SET status = %s, reviewed_at = NOW(3), reviewed_by = %s, review_note = %s
                             WHERE id = %s AND company_id = %s""",
                    (decision, reviewer if reviewer != "" else None, note if note != "" else None, request_id, company_id))

            if decision == "GRANTED" and rtype == "DEVICE_CHANGE" and req.get("session_id") and req.get("new_device_fingerprint"):
                execute(conn, """UPDATE exam_sessions SET device_fingerprint = %s, device_metadata_json = %s
                                 WHERE id = %s AND company_id = %s""",
                        (req["new_device_fingerprint"], req.get("new_device_json"), int(req["session_id"]), company_id))

            _log_access(conn, company_id, req["exam_id"], req["student_id"], "ACCESS_REVIEW", decision,
                        note if note != "" else f"Access request {decision}")
            audit_log(conn, request, {
                "companyId": company_id, "actorRole": actor_role,
                "actorId": reviewer if reviewer != "" else None,
                "action": "ACCESS_REQUEST_REVIEW", "targetType": "exam", "targetId": req["exam_id"],
                "message": f"Access request {decision}",
                "metadata": {"requestId": request_id, "requestType": rtype or "REATTEMPT", "note": note},
            })
            return {"ok": True, "status": decision}

        raise ApiError({"error": "Invalid action."}, 400)
