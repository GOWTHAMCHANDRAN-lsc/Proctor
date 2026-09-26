"""Python port of api/sessions.php — exam session lifecycle (start/reconnect, location, terminate, complete, reset)."""

from __future__ import annotations

import json
import math
import re

from fastapi import APIRouter, Request

from .core import (
    ApiError, add_column_if_missing, audit_log, db, dt_ms, execute, get_actor_id,
    json_input, php_int, php_json_normalize, q, q1, require_company_id, require_role,
)

router = APIRouter()

MAC_RE = re.compile(r"^([0-9A-Fa-f]{2}[:-]){5}([0-9A-Fa-f]{2})$")


def _php_round(x: float) -> int:
    return int(math.floor(x + 0.5)) if x >= 0 else int(math.ceil(x - 0.5))


def _is_numeric(value) -> bool:
    if isinstance(value, bool) or value is None:
        return False
    if isinstance(value, (int, float)):
        return True
    if isinstance(value, str):
        return bool(re.match(r"^\s*[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?\s*$", value))
    return False


def normalize_summary_for_log(summary):
    if isinstance(summary, str) and summary != "":
        try:
            decoded = json.loads(summary)
            if isinstance(decoded, (dict, list)):
                summary = decoded
        except (ValueError, TypeError):
            pass
    if not isinstance(summary, (dict, list)):
        return None
    return summary


def ensure_session_security_schema(conn) -> None:
    add_column_if_missing(conn, "exam_sessions", "device_metadata_json", "JSON NULL AFTER device_fingerprint")
    add_column_if_missing(conn, "exam_sessions", "location_lat", "DECIMAL(10,7) NULL AFTER location")
    add_column_if_missing(conn, "exam_sessions", "location_lng", "DECIMAL(10,7) NULL AFTER location_lat")
    add_column_if_missing(conn, "exam_sessions", "location_accuracy_m", "INT NULL AFTER location_lng")
    add_column_if_missing(conn, "exam_sessions", "mac_address", "VARCHAR(32) NULL AFTER device_metadata_json")
    add_column_if_missing(conn, "exam_sessions", "mac_bound", "TINYINT(1) NOT NULL DEFAULT 0 AFTER mac_address")
    execute(conn, """CREATE TABLE IF NOT EXISTS exam_location_logs (
      id                     BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      company_id             INT NOT NULL DEFAULT 1,
      session_id             BIGINT UNSIGNED NOT NULL,
      exam_id                VARCHAR(64) NOT NULL,
      student_id             VARCHAR(64) NOT NULL,
      latitude               DECIMAL(10,7) NULL,
      longitude              DECIMAL(10,7) NULL,
      accuracy_m             INT NULL,
      location_label         VARCHAR(255) NULL,
      distance_from_start_m  INT NULL,
      flagged                TINYINT(1) NOT NULL DEFAULT 0,
      created_at             TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_location_session (session_id, created_at),
      INDEX idx_location_flagged (company_id, flagged, created_at)
    ) ENGINE=InnoDB""")
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


def ensure_location_violation_support(conn) -> None:
    try:
        row = q1(conn, "SHOW COLUMNS FROM violation_logs LIKE 'type'")
        col_type = str((row or {}).get("Type", ""))
        if "LOCATION_CHANGE" not in col_type.upper():
            execute(conn, "ALTER TABLE violation_logs MODIFY type ENUM('TAB_SWITCH','NO_FACE','MULTIPLE_FACES','GAZE_AWAY','AUDIO_DETECTED','FULLSCREEN_EXIT','COPY_PASTE','PHONE_DETECTED','ANOMALY_OBJECT','LOCATION_CHANGE') NOT NULL")
    except Exception:
        pass
    add_column_if_missing(conn, "violation_logs", "category", "VARCHAR(32) NULL AFTER type")
    add_column_if_missing(conn, "violation_logs", "confidence", "DECIMAL(5,4) NULL AFTER category")
    add_column_if_missing(conn, "violation_logs", "metadata_json", "JSON NULL AFTER snapshot_base64")


def normalize_device_metadata(raw):
    if not isinstance(raw, dict):
        return None
    out = {}
    for key, value in raw.items():
        if not isinstance(key, str):
            continue
        if isinstance(value, (str, int, float, bool)) or value is None:
            out[key] = value[:300] if isinstance(value, str) else value
    return out


def normalize_geo(raw) -> dict:
    if not isinstance(raw, dict):
        return {"label": None, "lat": None, "lng": None, "accuracy": None}
    lat = float(raw["lat"]) if _is_numeric(raw.get("lat")) else None
    lng = float(raw["lng"]) if _is_numeric(raw.get("lng")) else None
    accuracy = _php_round(float(raw["accuracy"])) if _is_numeric(raw.get("accuracy")) else None
    label = str(raw["label"]).strip() if raw.get("label") is not None else None
    if label is not None and len(label) > 255:
        label = label[:255]
    return {"label": label, "lat": lat, "lng": lng, "accuracy": accuracy}


def distance_m(lat1, lng1, lat2, lng2):
    if lat1 is None or lng1 is None or lat2 is None or lng2 is None:
        return None
    earth = 6371000
    d_lat = math.radians(lat2 - lat1)
    d_lng = math.radians(lng2 - lng1)
    a = math.sin(d_lat / 2) ** 2 + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(d_lng / 2) ** 2
    return _php_round(earth * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a)))


def _client_ip(request: Request) -> str:
    return request.headers.get("x-real-ip") or (request.client.host if request.client else "") or ""


def _call_proc(conn, sql: str, params) -> None:
    with conn.cursor() as cur:
        cur.execute(sql, params)
        while cur.nextset():
            pass


@router.get("/sessions.php")
def get_sessions(request: Request):
    with db() as conn:
        ensure_session_security_schema(conn)
        company_id = require_company_id(request)
        rows = q(conn, """SELECT
            es.exam_id, es.student_id, es.start_time, es.end_time, es.status, es.ip_address, es.user_agent,
            es.device_fingerprint, es.device_metadata_json, es.mac_address, es.mac_bound, es.location,
            es.location_lat, es.location_lng, es.location_accuracy_m,
            EXISTS(SELECT 1 FROM exam_access_logs l WHERE l.company_id = es.company_id AND l.exam_id = es.exam_id
                AND l.student_id = es.student_id AND l.action = 'RECONNECT' AND l.status = 'WARN_IP'
                AND l.created_at >= es.start_time) AS ip_change_detected,
            EXISTS(SELECT 1 FROM exam_access_logs l WHERE l.company_id = es.company_id AND l.exam_id = es.exam_id
                AND l.student_id = es.student_id AND l.action = 'RECONNECT' AND l.status IN ('WARN_DEVICE','DENY_DEVICE')
                AND l.created_at >= es.start_time) AS device_change_detected,
            EXISTS(SELECT 1 FROM exam_location_logs ll WHERE ll.company_id = es.company_id
                AND ll.session_id = es.id AND ll.flagged = 1) AS location_change_detected
          FROM exam_sessions es WHERE es.company_id = %s ORDER BY es.start_time DESC""", (company_id,))

        sessions = []
        for row in rows:
            device_meta = None
            if isinstance(row.get("device_metadata_json"), str):
                try:
                    device_meta = php_json_normalize(json.loads(row["device_metadata_json"]))
                except (ValueError, TypeError):
                    device_meta = None
            sessions.append({
                "examId": row["exam_id"],
                "studentId": row["student_id"],
                "startTime": dt_ms(row["start_time"]) or 0,
                "status": row["status"],
                "ipAddress": row["ip_address"],
                "userAgent": row["user_agent"],
                "deviceFingerprint": row.get("device_fingerprint"),
                "deviceMetadata": device_meta,
                "macAddress": row.get("mac_address"),
                "macBound": bool(row.get("mac_bound")),
                "location": row["location"],
                "locationLat": float(row["location_lat"]) if row.get("location_lat") is not None else None,
                "locationLng": float(row["location_lng"]) if row.get("location_lng") is not None else None,
                "locationAccuracy": int(row["location_accuracy_m"]) if row.get("location_accuracy_m") is not None else None,
                "ipChangeDetected": bool(row.get("ip_change_detected")),
                "deviceChangeDetected": bool(row.get("device_change_detected")),
                "locationChangeDetected": bool(row.get("location_change_detected")),
            })
        return {"sessions": sessions}


@router.post("/sessions.php")
async def post_sessions(request: Request):
    payload = await json_input(request)
    with db() as conn:
        ensure_session_security_schema(conn)
        company_id = require_company_id(request, payload)
        action = payload.get("action") or "start"
        exam_id = payload.get("examId")
        student_id = payload.get("studentId")
        device_fingerprint = payload.get("deviceFingerprint")
        if not isinstance(device_fingerprint, str) or device_fingerprint == "":
            device_fingerprint = None
        device_metadata = normalize_device_metadata(payload.get("deviceMetadata"))
        device_metadata_json = json.dumps(device_metadata) if device_metadata else None
        geo = normalize_geo(payload.get("geoLocation"))
        mac_address = payload.get("macAddress")
        if not isinstance(mac_address, str) or mac_address == "":
            mac_address = None
        if mac_address is not None and not MAC_RE.match(mac_address):
            mac_address = None

        if not exam_id or not student_id:
            raise ApiError({"error": "examId and studentId are required."}, 400)

        if action == "reset_mac":
            require_role(request, ["ADMIN", "SUPER_ADMIN"], payload)
            admin_id = get_actor_id(request, payload)
            try:
                _call_proc(conn, "CALL sp_reset_mac_binding(%s, %s, %s)", (company_id, exam_id, student_id))
            except Exception:
                raise ApiError({"error": "RESET_FAILED", "message": "Failed to reset MAC binding."}, 500)
            audit_log(conn, request, {
                "companyId": company_id, "actorRole": "ADMIN", "actorId": admin_id,
                "action": "MAC_BINDING_RESET", "targetType": "exam", "targetId": exam_id,
                "message": f"MAC binding reset for student {student_id}.", "metadata": {"studentId": student_id},
            })
            return {"ok": True, "message": "MAC binding has been reset. Student can now take exam from a new device."}

        if action == "start":
            return _handle_start(conn, request, payload, company_id, exam_id, student_id,
                                 device_fingerprint, device_metadata_json, geo, mac_address)

        if action == "location":
            ensure_location_violation_support(conn)
            session_id = php_int(payload.get("sessionId"))
            geo2 = normalize_geo(payload.get("geoLocation") if payload.get("geoLocation") is not None else payload)
            if session_id <= 0 or geo2["lat"] is None or geo2["lng"] is None:
                raise ApiError({"error": "sessionId and geoLocation are required."}, 400)
            session = q1(conn, """SELECT id, location_lat, location_lng, status FROM exam_sessions
                                  WHERE id = %s AND company_id = %s AND exam_id = %s AND student_id = %s LIMIT 1""",
                         (session_id, company_id, exam_id, student_id))
            if not session:
                raise ApiError({"error": "SESSION_NOT_FOUND"}, 404)
            start_lat = float(session["location_lat"]) if session.get("location_lat") is not None else None
            start_lng = float(session["location_lng"]) if session.get("location_lng") is not None else None
            if start_lat is None or start_lng is None:
                execute(conn, """UPDATE exam_sessions SET location = COALESCE(%s, location), location_lat = %s,
                                 location_lng = %s, location_accuracy_m = %s WHERE id = %s AND company_id = %s""",
                        (geo2["label"], geo2["lat"], geo2["lng"], geo2["accuracy"], session_id, company_id))
                start_lat = geo2["lat"]
                start_lng = geo2["lng"]

            distance = distance_m(start_lat, start_lng, geo2["lat"], geo2["lng"])
            accuracy = geo2["accuracy"] if geo2["accuracy"] is not None else 9999
            flagged = distance is not None and distance >= 350 and accuracy <= 250

            execute(conn, """INSERT INTO exam_location_logs
                (company_id, session_id, exam_id, student_id, latitude, longitude, accuracy_m, location_label, distance_from_start_m, flagged)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)""",
                    (company_id, session_id, exam_id, student_id, geo2["lat"], geo2["lng"], accuracy, geo2["label"],
                     distance, 1 if flagged else 0))

            if flagged:
                recent = q1(conn, """SELECT id FROM violation_logs
                                     WHERE company_id = %s AND session_id = %s AND type = 'LOCATION_CHANGE'
                                       AND occurred_at >= DATE_SUB(NOW(3), INTERVAL 5 MINUTE) LIMIT 1""",
                            (company_id, session_id))
                if not recent:
                    metadata = json.dumps({"distanceFromStartM": distance, "accuracyM": accuracy,
                                           "latitude": geo2["lat"], "longitude": geo2["lng"]})
                    confidence = min(0.98, max(0.7, (distance or 0) / 1000))
                    execute(conn, """INSERT INTO violation_logs
                        (company_id, session_id, occurred_at, type, category, confidence, description, snapshot_base64, metadata_json)
                        VALUES (%s, %s, NOW(3), 'LOCATION_CHANGE', 'location', %s, %s, NULL, %s)""",
                            (company_id, session_id, confidence,
                             f"Location changed by approximately {distance}m from exam start.", metadata))
            return {"ok": True, "flagged": flagged, "distanceFromStartM": distance}

        if action == "terminate":
            reason = str(payload.get("reason") or "Violation limit reached. Access has been blocked.").strip()
            if reason == "":
                reason = "Violation limit reached. Access has been blocked."
            summary = normalize_summary_for_log(payload.get("violationSummary"))
            session = q1(conn, """SELECT id, status FROM exam_sessions
                                  WHERE company_id = %s AND exam_id = %s AND student_id = %s
                                  ORDER BY start_time DESC LIMIT 1""", (company_id, exam_id, student_id))
            if not session:
                raise ApiError({"error": "SESSION_NOT_FOUND"}, 404)
            session_id = int(session["id"])
            if session.get("status") == "IN_PROGRESS":
                execute(conn, "UPDATE exam_sessions SET status = 'TERMINATED', end_time = NOW(3) WHERE id = %s AND company_id = %s",
                        (session_id, company_id))
            log_payload = json.dumps({"reason": reason, "sessionId": session_id, "summary": summary})
            if not log_payload:
                log_payload = reason
            _call_proc(conn, "CALL sp_log_access(%s, %s, %s, %s, %s, %s)",
                       (company_id, exam_id, student_id, "VIOLATION_BLOCK", "DENY", log_payload))
            audit_log(conn, request, {
                "companyId": company_id, "actorRole": "SYSTEM", "actorId": student_id,
                "action": "SESSION_TERMINATE", "targetType": "exam", "targetId": exam_id,
                "message": reason, "metadata": {"sessionId": session_id, "summary": summary},
            })
            return {"ok": True, "sessionId": session_id}

        if action == "complete":
            return _handle_complete(conn, request, payload, company_id, exam_id, student_id)

        if action == "reset":
            # NON-DESTRUCTIVE by design — mirrors api/sessions.php. This used to CALL
            # sp_reset_exam_session, which hard-DELETEs the session row (session_answers /
            # violation_logs cascade-delete with it), permanently losing every answer the
            # candidate had given, including ones already autosaved via 'save_progress'. A
            # "renew" must never be able to erase data — it can only relabel the existing session
            # as TERMINATED (which already doesn't block a fresh 'start', same as 'terminate')
            # so the candidate can begin a NEW attempt while the old one stays on record.
            session = q1(conn, """SELECT id, status FROM exam_sessions
                                  WHERE company_id = %s AND exam_id = %s AND student_id = %s
                                  ORDER BY start_time DESC LIMIT 1""", (company_id, exam_id, student_id))
            if session and session.get("status") != "TERMINATED":
                session_id = int(session["id"])
                score_rows = q(conn, """SELECT q.marks, sa.awarded_marks
                                        FROM session_answers sa
                                        JOIN questions q ON q.id = sa.question_id
                                        WHERE sa.session_id = %s""", (session_id,))
                total_score = sum(int(r["awarded_marks"]) for r in score_rows if r["awarded_marks"] is not None)
                max_score = sum(int(r["marks"]) for r in score_rows)
                execute(conn, """UPDATE exam_sessions
                                 SET status = 'TERMINATED',
                                     end_time = COALESCE(end_time, NOW(3)),
                                     total_score = %s, max_score = %s, passed = 0,
                                     termination_reason = 'Renewed by admin — candidate may reattempt.'
                                 WHERE id = %s AND company_id = %s""",
                        (total_score, max_score, session_id, company_id))
            # If no session exists, or it's already TERMINATED, there is nothing to do — a fresh
            # start already isn't blocked.
            _call_proc(conn, "CALL sp_log_access(%s, %s, %s, %s, %s, %s)",
                       (company_id, exam_id, student_id, "RESET", "OK",
                        "Session renewed by admin (previous attempt preserved as TERMINATED)."))
            audit_log(conn, request, {
                "companyId": company_id, "actorRole": "ADMIN", "actorId": payload.get("actor"),
                "action": "SESSION_RESET", "targetType": "exam", "targetId": exam_id,
                "message": f"Session renewed for student {student_id} (previous attempt preserved)",
            })
            return {"ok": True}

        raise ApiError({"error": "Invalid action."}, 400)


def _handle_start(conn, request, payload, company_id, exam_id, student_id,
                  device_fingerprint, device_metadata_json, geo, mac_address):
    if not q1(conn, "SELECT id FROM exams WHERE id = %s AND company_id = %s LIMIT 1", (exam_id, company_id)):
        raise ApiError({"error": "EXAM_NOT_FOUND"}, 404)
    if not q1(conn, "SELECT id FROM students WHERE id = %s AND company_id = %s LIMIT 1", (student_id, company_id)):
        raise ApiError({"error": "STUDENT_NOT_FOUND"}, 404)

    completed = q1(conn, """SELECT id, end_time FROM exam_sessions
                            WHERE company_id = %s AND exam_id = %s AND student_id = %s AND status = 'COMPLETED'
                            ORDER BY COALESCE(end_time, start_time) DESC LIMIT 1""", (company_id, exam_id, student_id))
    if completed:
        completed_at = completed.get("end_time")
        message = "Exam already completed. Access link is now expired."
        if completed_at is not None and str(completed_at) != "":
            message += f" Completed at {completed_at}."
        _call_proc(conn, "CALL sp_log_access(%s, %s, %s, %s, %s, %s)",
                   (company_id, exam_id, student_id, "START", "DENY", message))
        raise ApiError({"error": "SESSION_EXISTS", "message": message}, 409)

    try:
        latest_block = q1(conn, """SELECT id, created_at, message FROM exam_access_logs
                                   WHERE company_id = %s AND exam_id = %s AND student_id = %s AND action = 'VIOLATION_BLOCK'
                                   ORDER BY created_at DESC LIMIT 1""", (company_id, exam_id, student_id))
        if latest_block:
            latest_request = q1(conn, """SELECT id, status, requested_at, reviewed_at FROM exam_access_requests
                                         WHERE company_id = %s AND exam_id = %s AND student_id = %s AND requested_at >= %s
                                         ORDER BY requested_at DESC LIMIT 1""",
                                (company_id, exam_id, student_id, latest_block["created_at"]))
            status = latest_request.get("status") if latest_request else None
            if status != "GRANTED":
                error_code = "ACCESS_REQUEST_REQUIRED"
                message = "Access blocked due to policy violation. Request admin approval to reattempt."
                if status == "PENDING":
                    error_code = "ACCESS_REQUEST_PENDING"
                    message = "Your access request is pending admin review."
                elif status == "REVOKED":
                    error_code = "ACCESS_REQUEST_REVOKED"
                    message = "Your access request was revoked by admin."
                _call_proc(conn, "CALL sp_log_access(%s, %s, %s, %s, %s, %s)",
                           (company_id, exam_id, student_id, "START", "DENY", message))
                raise ApiError({
                    "error": error_code, "message": message, "requestStatus": status,
                    "blockLogId": int(latest_block["id"]), "blockDetail": latest_block.get("message"),
                }, 409)
    except ApiError:
        raise
    except Exception:
        pass  # backward compat for deployments without request tables

    user_agent = request.headers.get("user-agent", "")
    ip_address = _client_ip(request)
    location = geo["label"] if geo["label"] is not None else payload.get("location")
    if isinstance(device_fingerprint, str) and len(device_fingerprint) > 128:
        device_fingerprint = device_fingerprint[:128]

    existing = q1(conn, """SELECT id, status, ip_address, device_fingerprint, start_time FROM exam_sessions
                           WHERE company_id = %s AND exam_id = %s AND student_id = %s AND status = 'IN_PROGRESS'
                           ORDER BY start_time DESC LIMIT 1""", (company_id, exam_id, student_id))
    if existing:
        existing_ip = existing.get("ip_address")
        existing_device = existing.get("device_fingerprint")
        existing_id = existing.get("id")

        if ip_address and existing_ip and ip_address != existing_ip:
            _call_proc(conn, "CALL sp_log_access(%s, %s, %s, %s, %s, %s)",
                       (company_id, exam_id, student_id, "RECONNECT", "WARN_IP",
                        f"IP changed from {existing_ip} to {ip_address}."))

        if device_fingerprint and existing_device and device_fingerprint != existing_device:
            device_request = q1(conn, """SELECT id, status FROM exam_access_requests
                                         WHERE company_id = %s AND exam_id = %s AND student_id = %s
                                           AND request_type = 'DEVICE_CHANGE' AND new_device_fingerprint = %s
                                           AND requested_at >= %s
                                         ORDER BY requested_at DESC LIMIT 1""",
                                (company_id, exam_id, student_id, device_fingerprint, existing["start_time"]))
            if not device_request or device_request.get("status") != "GRANTED":
                _call_proc(conn, "CALL sp_log_access(%s, %s, %s, %s, %s, %s)",
                           (company_id, exam_id, student_id, "RECONNECT", "DENY_DEVICE", "Device fingerprint mismatch blocked."))
                pending = device_request and device_request.get("status") == "PENDING"
                raise ApiError({
                    "error": "DEVICE_CHANGE_PENDING" if pending else "DEVICE_CHANGE_REQUIRED",
                    "message": ("Your device change request is pending super admin approval." if pending
                                else "This exam is already bound to another device. Request access with a reason to continue."),
                    "requestStatus": device_request.get("status") if device_request else None,
                    "previousDeviceFingerprint": existing_device,
                    "newDeviceFingerprint": device_fingerprint,
                    "sessionId": int(existing_id) if existing_id else None,
                }, 409)
            execute(conn, """UPDATE exam_sessions
                             SET device_fingerprint = %s, device_metadata_json = %s, location = COALESCE(%s, location),
                                 location_lat = COALESCE(%s, location_lat), location_lng = COALESCE(%s, location_lng),
                                 location_accuracy_m = COALESCE(%s, location_accuracy_m)
                             WHERE id = %s AND company_id = %s""",
                    (device_fingerprint, device_metadata_json, location, geo["lat"], geo["lng"], geo["accuracy"],
                     existing_id, company_id))

        if existing_id and not existing_device and device_fingerprint:
            execute(conn, "UPDATE exam_sessions SET device_fingerprint = %s WHERE id = %s AND company_id = %s",
                    (device_fingerprint, existing_id, company_id))
        if existing_id and not existing_ip and ip_address:
            execute(conn, "UPDATE exam_sessions SET ip_address = %s WHERE id = %s AND company_id = %s",
                    (ip_address, existing_id, company_id))

        limit_row = q1(conn, "SELECT reconnect_limit FROM exams WHERE id = %s AND company_id = %s", (exam_id, company_id))
        reconnect_limit = int(limit_row["reconnect_limit"]) if limit_row and limit_row.get("reconnect_limit") is not None else 0

        if reconnect_limit <= 0:
            _call_proc(conn, "CALL sp_log_access(%s, %s, %s, %s, %s, %s)",
                       (company_id, exam_id, student_id, "RECONNECT", "DENY", "Reconnect limit exceeded."))
            raise ApiError({"error": "RECONNECT_LIMIT", "message": "No more reconnection is possible. Please contact administrator."}, 409)

        count_row = q1(conn, """SELECT COUNT(*) AS cnt FROM exam_access_logs
                                WHERE company_id = %s AND exam_id = %s AND student_id = %s AND action = 'RECONNECT' AND status = 'OK'""",
                       (company_id, exam_id, student_id))
        count = int(count_row["cnt"]) if count_row else 0
        if count >= reconnect_limit:
            _call_proc(conn, "CALL sp_log_access(%s, %s, %s, %s, %s, %s)",
                       (company_id, exam_id, student_id, "RECONNECT", "DENY", "Reconnect limit exceeded."))
            raise ApiError({"error": "RECONNECT_LIMIT", "message": "No more reconnection is possible. Please contact administrator."}, 409)

        _call_proc(conn, "CALL sp_log_access(%s, %s, %s, %s, %s, %s)",
                   (company_id, exam_id, student_id, "RECONNECT", "OK", "Session reconnected"))
        remaining = max(0, reconnect_limit - (count + 1))
        attempt_row = q1(conn, "SELECT COUNT(*) AS cnt FROM exam_sessions WHERE company_id = %s AND exam_id = %s AND student_id = %s",
                         (company_id, exam_id, student_id))
        attempt_number = int(attempt_row["cnt"]) if attempt_row else 1

        audit_log(conn, request, {
            "companyId": company_id, "actorRole": "STUDENT", "actorId": student_id,
            "action": "SESSION_RECONNECT", "targetType": "exam", "targetId": exam_id,
            "message": f"Session reconnected. Remaining {remaining}.",
            "metadata": {
                "remaining": remaining,
                "ipChanged": bool(ip_address and existing_ip and ip_address != existing_ip),
                "deviceChanged": bool(device_fingerprint and existing_device and device_fingerprint != existing_device),
            },
        })
        return {"ok": True, "reconnect": True, "remaining": remaining,
                "sessionId": int(existing_id) if existing_id else None, "attempt": attempt_number}

    # New session.
    try:
        execute(conn, """INSERT INTO exam_sessions
            (company_id, exam_id, student_id, start_time, status, ip_address, user_agent, location, location_lat, location_lng, location_accuracy_m, device_fingerprint, device_metadata_json, mac_address, mac_bound)
            VALUES (%s, %s, %s, NOW(3), 'IN_PROGRESS', %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)""",
                (company_id, exam_id, student_id, ip_address, user_agent, location, geo["lat"], geo["lng"],
                 geo["accuracy"], device_fingerprint, device_metadata_json, mac_address, 1 if mac_address else 0))
    except Exception as e:
        if "MAC_ADDRESS_MISMATCH" in str(e):
            _call_proc(conn, "CALL sp_log_access(%s, %s, %s, %s, %s, %s)",
                       (company_id, exam_id, student_id, "START", "DENY",
                        "MAC address mismatch - student attempting to take exam from different device."))
            raise ApiError({"error": "MAC_ADDRESS_MISMATCH",
                            "message": "This exam is bound to a different device. Please contact your administrator to reset the device binding."}, 409)
        raise

    attempt_row = q1(conn, "SELECT COUNT(*) AS cnt FROM exam_sessions WHERE company_id = %s AND exam_id = %s AND student_id = %s",
                     (company_id, exam_id, student_id))
    attempt_number = int(attempt_row["cnt"]) if attempt_row else 1
    session = q1(conn, "SELECT id FROM exam_sessions WHERE company_id = %s AND exam_id = %s AND student_id = %s ORDER BY start_time DESC LIMIT 1",
                 (company_id, exam_id, student_id))
    session_id = int(session["id"]) if session else None

    if session_id and (geo["lat"] is not None or geo["lng"] is not None or location is not None):
        execute(conn, """INSERT INTO exam_location_logs
            (company_id, session_id, exam_id, student_id, latitude, longitude, accuracy_m, location_label, distance_from_start_m, flagged)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, 0, 0)""",
                (company_id, session_id, exam_id, student_id, geo["lat"], geo["lng"], geo["accuracy"], location))

    _call_proc(conn, "CALL sp_log_access(%s, %s, %s, %s, %s, %s)",
               (company_id, exam_id, student_id, "START", "OK", f"Session started (attempt {attempt_number})"))
    audit_log(conn, request, {
        "companyId": company_id, "actorRole": "STUDENT", "actorId": student_id,
        "action": "SESSION_START", "targetType": "exam", "targetId": exam_id,
        "message": f"Session started (attempt {attempt_number}).", "metadata": {"attempt": attempt_number},
    })
    return {"ok": True, "sessionId": session_id, "attempt": attempt_number}


def _handle_complete(conn, request, payload, company_id, exam_id, student_id):
    answers = payload.get("answers")
    question_ids = payload.get("questionIds")
    question_times = payload.get("questionTimes")
    if not isinstance(question_ids, list) and isinstance(payload.get("questions"), list):
        question_ids = [(qq.get("id") if isinstance(qq, dict) else None) for qq in payload["questions"]]

    _call_proc(conn, "CALL sp_complete_exam_session(%s, %s, %s)", (company_id, exam_id, student_id))

    session = q1(conn, "SELECT id FROM exam_sessions WHERE company_id = %s AND exam_id = %s AND student_id = %s ORDER BY start_time DESC LIMIT 1",
                 (company_id, exam_id, student_id))
    if not session:
        raise ApiError({"error": "SESSION_NOT_FOUND"}, 404)
    session_id = int(session["id"])

    total_score = None
    max_score = None
    if isinstance(answers, dict) and isinstance(question_ids, list):
        seen = []
        for qid in question_ids:
            if isinstance(qid, str) and qid != "" and qid not in seen:
                seen.append(qid)
        question_ids = seen

        if len(question_ids) > 0:
            placeholders = ",".join(["%s"] * len(question_ids))
            questions = q(conn, f"""SELECT q.id, q.type, q.correct_option_index, q.marks
                                    FROM exam_questions eq JOIN questions q ON q.id = eq.question_id
                                    WHERE eq.exam_id = %s AND q.id IN ({placeholders})""", [exam_id] + question_ids)
            total_score = 0
            max_score = 0
            for qq in questions:
                qid = qq["id"]
                q_type = qq["type"]
                marks = int(qq["marks"])
                max_score += marks
                answer_value = answers.get(qid)
                answer_text = None
                answer_option_index = None
                is_correct = None
                awarded = None
                if q_type == "MCQ":
                    if answer_value is not None and answer_value != "":
                        answer_option_index = php_int(answer_value)
                    if answer_option_index is not None and qq["correct_option_index"] is not None:
                        is_correct = 1 if answer_option_index == int(qq["correct_option_index"]) else 0
                        awarded = marks if is_correct else 0
                        total_score += awarded
                else:
                    if answer_value is not None:
                        answer_text = answer_value if isinstance(answer_value, str) else json.dumps(answer_value)

                execute(conn, """INSERT INTO session_answers (session_id, question_id, answer_text, answer_option_index, is_correct, awarded_marks)
                                 VALUES (%s, %s, %s, %s, %s, %s)
                                 ON DUPLICATE KEY UPDATE answer_text = VALUES(answer_text),
                                     answer_option_index = VALUES(answer_option_index), is_correct = VALUES(is_correct),
                                     awarded_marks = VALUES(awarded_marks)""",
                        (session_id, qid, answer_text, answer_option_index, is_correct, awarded))

                if isinstance(question_times, dict) and qid in question_times:
                    seconds = question_times[qid]
                    if _is_numeric(seconds):
                        execute(conn, """INSERT INTO session_question_times (session_id, question_id, seconds_spent)
                                         VALUES (%s, %s, %s)
                                         ON DUPLICATE KEY UPDATE seconds_spent = VALUES(seconds_spent)""",
                                (session_id, qid, php_int(seconds)))

            passed = None
            if max_score > 0:
                pass_row = q1(conn, "SELECT pass_percent FROM exams WHERE id = %s AND company_id = %s LIMIT 1", (exam_id, company_id))
                pass_percent = int(pass_row["pass_percent"]) if pass_row and pass_row.get("pass_percent") is not None else 60
                pass_percent = max(0, min(100, pass_percent))
                passed = 1 if (total_score / max_score) >= (pass_percent / 100) else 0
            execute(conn, "UPDATE exam_sessions SET total_score = %s, max_score = %s, passed = %s, end_time = NOW(3), status = 'COMPLETED' WHERE id = %s AND company_id = %s",
                    (total_score, max_score, passed, session_id, company_id))

    _call_proc(conn, "CALL sp_log_access(%s, %s, %s, %s, %s, %s)",
               (company_id, exam_id, student_id, "COMPLETE", "OK", "Session completed"))
    audit_log(conn, request, {
        "companyId": company_id, "actorRole": "STUDENT", "actorId": student_id,
        "action": "SESSION_COMPLETE", "targetType": "exam", "targetId": exam_id,
        "message": "Session completed", "metadata": {"score": total_score, "maxScore": max_score},
    })
    return {"ok": True}
