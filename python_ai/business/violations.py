"""Python port of api/violations.php — violation evidence storage, listing and review."""

from __future__ import annotations

import json
import time

from fastapi import APIRouter, Request

from .core import (
    ApiError, add_column_if_missing, audit_log, as_float_or_none, column_exists, db,
    dt_ms, execute, get_actor_id, json_input, json_or_none, php_int, q, q1,
    require_company_id, require_role, table_exists,
)

router = APIRouter()

ALLOWED_TYPES = [
    "TAB_SWITCH", "NO_FACE", "MULTIPLE_FACES", "GAZE_AWAY", "AUDIO_DETECTED",
    "FULLSCREEN_EXIT", "COPY_PASTE", "PHONE_DETECTED", "ANOMALY_OBJECT",
    "LOCATION_CHANGE", "IDENTITY_CHANGE", "SUSPICIOUS_BEHAVIOR",
]


def category_for_type(vtype: str) -> str:
    if vtype == "AUDIO_DETECTED":
        return "microphone"
    if vtype in ("TAB_SWITCH", "COPY_PASTE"):
        return "browser"
    if vtype == "FULLSCREEN_EXIT":
        return "screen"
    if vtype == "LOCATION_CHANGE":
        return "location"
    if vtype == "SUSPICIOUS_BEHAVIOR":
        return "behavior"
    return "camera"


def ensure_schema(conn) -> None:
    try:
        row = q1(conn, "SHOW COLUMNS FROM violation_logs LIKE 'type'")
        col_type = str((row or {}).get("Type", "")).upper()
        if not ("GAZE_AWAY" in col_type and "LOCATION_CHANGE" in col_type
                and "IDENTITY_CHANGE" in col_type and "SUSPICIOUS_BEHAVIOR" in col_type):
            execute(conn, "ALTER TABLE violation_logs MODIFY type ENUM('TAB_SWITCH','NO_FACE','MULTIPLE_FACES','GAZE_AWAY','AUDIO_DETECTED','FULLSCREEN_EXIT','COPY_PASTE','PHONE_DETECTED','ANOMALY_OBJECT','LOCATION_CHANGE','IDENTITY_CHANGE','SUSPICIOUS_BEHAVIOR') NOT NULL")
    except Exception:
        pass
    add_column_if_missing(conn, "violation_logs", "category", "VARCHAR(32) NULL AFTER type")
    add_column_if_missing(conn, "violation_logs", "confidence", "DECIMAL(5,4) NULL AFTER category")
    add_column_if_missing(conn, "violation_logs", "metadata_json", "JSON NULL AFTER snapshot_base64")


def _row_to_violation(row: dict, has_category: bool) -> dict:
    metadata = json_or_none(row.get("metadata_json"))
    if not isinstance(metadata, (dict, list)):
        metadata = None
    return {
        "id": row["id"],
        "sessionId": php_int(row["session_id"]) if row.get("session_id") is not None else None,
        "examId": row["exam_id"],
        "studentId": row["student_id"],
        "timestamp": dt_ms(row.get("occurred_at")) or 0,
        "type": row["type"],
        "category": row.get("category") or category_for_type(str(row["type"])),
        "confidence": as_float_or_none(row.get("confidence")),
        "description": row["description"],
        "snapshot": row.get("snapshot_base64"),
        "metadata": metadata,
        "review": {
            "decision": row.get("review_decision"),
            "note": row.get("review_note"),
            "reviewer": row.get("review_reviewer"),
            "reviewedAt": dt_ms(row.get("review_time")) if row.get("review_time") is not None else None,
        },
    }


@router.get("/violations.php")
def list_violations(request: Request):
    with db() as conn:
        ensure_schema(conn)
        company_id = require_company_id(request)
        limit = php_int(request.query_params.get("limit"), 20)
        if limit <= 0:
            limit = 20
        if limit > 2000:
            limit = 2000
        session_id = php_int(request.query_params["sessionId"]) if "sessionId" in request.query_params else None
        student_filter = (request.query_params.get("studentId") or "").strip()
        exam_filter = (request.query_params.get("examId") or "").strip()

        if not table_exists(conn, "violation_logs") or not table_exists(conn, "exam_sessions"):
            return {"violations": []}

        has_category = column_exists(conn, "violation_logs", "category")
        has_confidence = column_exists(conn, "violation_logs", "confidence")
        has_metadata = column_exists(conn, "violation_logs", "metadata_json")
        has_reviews = table_exists(conn, "violation_reviews")

        select = f"""SELECT
                vl.id,
                vl.session_id,
                es.exam_id,
                es.student_id,
                vl.occurred_at,
                vl.type,
                {'vl.category' if has_category else 'NULL AS category'},
                {'vl.confidence' if has_confidence else 'NULL AS confidence'},
                vl.description,
                vl.snapshot_base64,
                {'vl.metadata_json' if has_metadata else 'NULL AS metadata_json'},
                {'vr.decision' if has_reviews else 'NULL'} AS review_decision,
                {'vr.note' if has_reviews else 'NULL'} AS review_note,
                {'vr.reviewer' if has_reviews else 'NULL'} AS review_reviewer,
                {'vr.reviewed_at' if has_reviews else 'NULL'} AS review_time
            FROM violation_logs vl
            JOIN exam_sessions es ON es.id = vl.session_id
            {'LEFT JOIN violation_reviews vr ON vr.violation_id = vl.id' if has_reviews else ''}"""

        if session_id:
            rows = q(conn, select + """
                WHERE vl.session_id = %s AND es.company_id = %s
                ORDER BY vl.occurred_at DESC
                LIMIT %s""", (session_id, company_id, limit))
        else:
            where = "WHERE vl.company_id = %s"
            params: list = [company_id]
            if student_filter:
                where += " AND es.student_id = %s"
                params.append(student_filter)
            if exam_filter:
                where += " AND es.exam_id = %s"
                params.append(exam_filter)
            params.append(limit)
            rows = q(conn, select + f"""
                {where}
                ORDER BY vl.occurred_at DESC
                LIMIT %s""", params)

        return {"violations": [_row_to_violation(r, has_category) for r in rows]}


@router.post("/violations.php")
async def post_violations(request: Request):
    payload = await json_input(request)
    with db() as conn:
        ensure_schema(conn)
        company_id = require_company_id(request, payload)
        action = payload.get("action")

        if action == "review":
            actor_role = require_role(request, ["ADMIN", "PROCTOR"], payload)
            if not table_exists(conn, "violation_logs") or not table_exists(conn, "violation_reviews"):
                raise ApiError({"error": "Violation review storage is unavailable on this database."}, 503)
            violation_id = php_int(payload.get("violationId"))
            decision = str(payload.get("decision") or "")
            reviewer = str(payload["reviewer"]) if "reviewer" in payload else get_actor_id(request, payload)
            note = str(payload["note"]) if payload.get("note") is not None and "note" in payload else None

            if violation_id <= 0 or decision == "":
                raise ApiError({"error": "violationId and decision are required."}, 400)

            if not q1(conn, "SELECT id FROM violation_logs WHERE id = %s AND company_id = %s", (violation_id, company_id)):
                raise ApiError({"error": "Violation not found."}, 404)

            execute(conn, """INSERT INTO violation_reviews (violation_id, decision, reviewer, note, reviewed_at)
                             VALUES (%s, %s, %s, %s, NOW(3))
                             ON DUPLICATE KEY UPDATE decision = VALUES(decision),
                                                     reviewer = VALUES(reviewer),
                                                     note = VALUES(note),
                                                     reviewed_at = VALUES(reviewed_at)""",
                    (violation_id, decision, reviewer, note))
            audit_log(conn, request, {
                "companyId": company_id,
                "actorRole": actor_role,
                "actorId": reviewer,
                "action": "VIOLATION_REVIEW",
                "targetType": "violation",
                "targetId": str(violation_id),
                "message": f"Violation reviewed: {decision}",
                "metadata": {"note": note},
            })
            return {"ok": True}

        exam_id = payload.get("examId")
        student_id = payload.get("studentId")
        violations = []
        if isinstance(payload.get("violations"), list):
            violations = payload["violations"]
        elif isinstance(payload.get("violation"), dict):
            violations = [payload["violation"]]

        if not exam_id or not student_id or len(violations) == 0:
            raise ApiError({"error": "examId, studentId, and violations are required."}, 400)
        if not table_exists(conn, "violation_logs") or not table_exists(conn, "exam_sessions"):
            raise ApiError({"error": "Violation storage is unavailable on this database."}, 503)

        # Resolve the session once for the whole batch — prefer the exact session the client is
        # running under; fall back to the latest attempt only when it isn't supplied.
        requested_session_id = None
        raw_session = payload.get("sessionId")
        if isinstance(raw_session, (int, float)) or (isinstance(raw_session, str) and raw_session.strip().replace(".", "", 1).replace("-", "", 1).isdigit()):
            requested_session_id = php_int(raw_session)
        session_row_id = None
        if requested_session_id:
            row = q1(conn, """SELECT id FROM exam_sessions
                              WHERE id = %s AND company_id = %s AND exam_id = %s AND student_id = %s""",
                     (requested_session_id, company_id, exam_id, student_id))
            if row:
                session_row_id = php_int(row["id"])
        if session_row_id is None:
            row = q1(conn, """SELECT id FROM exam_sessions
                              WHERE company_id = %s AND exam_id = %s AND student_id = %s
                              ORDER BY start_time DESC
                              LIMIT 1""", (company_id, exam_id, student_id))
            if row:
                session_row_id = php_int(row["id"])
        if session_row_id is None:
            # saved: 0 tells the client to keep the evidence queued and retry later.
            return {"saved": 0, "errors": ["Session not found for this exam attempt."]}

        errors: list[str] = []
        count = 0
        for v in violations:
            if not isinstance(v, dict):
                continue
            vtype = str(v.get("type") or "").strip().upper()
            description = v.get("description", "")
            snapshot = v.get("snapshot")
            category = str(v.get("category") or category_for_type(vtype)).strip()
            confidence = None
            if isinstance(v.get("confidence"), (int, float)):
                confidence = max(0.0, min(1.0, float(v["confidence"])))
            metadata = v.get("metadata")
            metadata_json = json.dumps(metadata) if isinstance(metadata, (dict, list)) else None
            timestamp = (float(v["timestamp"]) / 1000.0
                         if isinstance(v.get("timestamp"), (int, float)) else time.time())

            if vtype not in ALLOWED_TYPES:
                errors.append(f"Invalid violation type: {vtype}")
                continue

            try:
                execute(conn, """INSERT INTO violation_logs
                    (company_id, session_id, occurred_at, type, category, confidence, description, snapshot_base64, metadata_json)
                    VALUES (%s, %s, FROM_UNIXTIME(%s), %s, %s, %s, %s, %s, %s)""",
                        (company_id, session_row_id, timestamp, vtype,
                         category if category else category_for_type(vtype),
                         confidence, description, snapshot, metadata_json))
                count += 1
                audit_log(conn, request, {
                    "companyId": company_id,
                    "actorRole": "STUDENT",
                    "actorId": student_id,
                    "action": "VIOLATION_ADD",
                    "targetType": "exam",
                    "targetId": exam_id,
                    "message": vtype,
                    "metadata": {"description": description, "category": category, "confidence": confidence},
                })
            except Exception as e:
                errors.append(str(e))

        return {"saved": count, "errors": errors}
