"""Python port of api/feedback.php — student session feedback capture + admin listing."""

from __future__ import annotations

import re

from fastapi import APIRouter, Request

from .core import (
    ApiError, audit_log, db, dt_ms, execute, json_input, php_int, q, q1,
    require_company_id, require_role,
)

router = APIRouter()


def ensure_feedback_schema(conn) -> None:
    execute(conn, """CREATE TABLE IF NOT EXISTS session_feedback (
      id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      company_id       INT NOT NULL DEFAULT 1,
      session_id       BIGINT UNSIGNED NULL,
      exam_id          VARCHAR(64) NOT NULL,
      student_id       VARCHAR(64) NOT NULL,
      batch_id         BIGINT UNSIGNED NULL,
      rating           TINYINT UNSIGNED NOT NULL,
      clarity_rating   TINYINT UNSIGNED NULL,
      platform_rating  TINYINT UNSIGNED NULL,
      comment          TEXT NULL,
      created_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uk_feedback_session (session_id),
      INDEX idx_feedback_exam (company_id, exam_id, created_at),
      INDEX idx_feedback_student (company_id, student_id, created_at),
      INDEX idx_feedback_batch (company_id, batch_id, created_at)
    ) ENGINE=InnoDB""")


def _is_numeric(value) -> bool:
    """PHP is_numeric(): ints/floats and numeric strings, but not bools/None."""
    if isinstance(value, bool) or value is None:
        return False
    if isinstance(value, (int, float)):
        return True
    if isinstance(value, str):
        return bool(re.match(r"^\s*[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?\s*$", value)) \
            or bool(re.match(r"^\s*[-+]?0[xX][0-9a-fA-F]+\s*$", value))
    return False


def clamp_rating(value, default: int = 5) -> int:
    if not _is_numeric(value):
        return default
    rating = int(float(value))
    if rating < 1:
        return 1
    if rating > 5:
        return 5
    return rating


@router.get("/feedback.php")
def list_feedback(request: Request):
    with db() as conn:
        ensure_feedback_schema(conn)
        require_role(request, ["ADMIN", "PROCTOR"])
        company_id = require_company_id(request)
        limit = php_int(request.query_params.get("limit"), 250)
        if limit <= 0:
            limit = 250
        if limit > 500:
            limit = 500

        rows = q(conn, """SELECT
                f.id, f.session_id, f.exam_id, f.student_id, f.batch_id,
                f.rating, f.clarity_rating, f.platform_rating, f.comment, f.created_at,
                e.title AS exam_title, s.full_name, s.registration_id, b.name AS batch_name
            FROM session_feedback f
            LEFT JOIN exams e ON e.id = f.exam_id AND e.company_id = f.company_id
            LEFT JOIN students s ON s.id = f.student_id AND s.company_id = f.company_id
            LEFT JOIN batches b ON b.id = f.batch_id AND b.company_id = f.company_id
            WHERE f.company_id = %s
            ORDER BY f.created_at DESC
            LIMIT %s""", (company_id, limit))

        feedback = [{
            "id": int(row["id"]),
            "sessionId": int(row["session_id"]) if row.get("session_id") is not None else None,
            "examId": row["exam_id"],
            "examTitle": row.get("exam_title") if row.get("exam_title") is not None else row["exam_id"],
            "studentId": row["student_id"],
            "studentName": row.get("full_name") if row.get("full_name") is not None else row["student_id"],
            "registrationId": row.get("registration_id") if row.get("registration_id") is not None else "",
            "batchId": int(row["batch_id"]) if row.get("batch_id") is not None else None,
            "batch": row.get("batch_name"),
            "rating": int(row["rating"]),
            "clarityRating": int(row["clarity_rating"]) if row.get("clarity_rating") is not None else None,
            "platformRating": int(row["platform_rating"]) if row.get("platform_rating") is not None else None,
            "comment": row.get("comment"),
            "createdAt": dt_ms(row.get("created_at")) or 0,
        } for row in rows]
        return {"feedback": feedback}


@router.post("/feedback.php")
async def submit_feedback(request: Request):
    payload = await json_input(request)
    with db() as conn:
        ensure_feedback_schema(conn)
        company_id = require_company_id(request, payload)
        exam_id = str(payload.get("examId") or "").strip()
        student_id = str(payload.get("studentId") or "").strip()
        session_id = php_int(payload["sessionId"]) if _is_numeric(payload.get("sessionId")) else None
        comment = str(payload.get("comment") or "").strip()

        if exam_id == "" or student_id == "":
            raise ApiError({"error": "examId and studentId are required."}, 400)

        if session_id is None:
            row = q1(conn, """SELECT id FROM exam_sessions
                              WHERE company_id = %s AND exam_id = %s AND student_id = %s
                              ORDER BY start_time DESC LIMIT 1""",
                     (company_id, exam_id, student_id))
            session_id = int(row["id"]) if row else None

        student = q1(conn, "SELECT batch_id FROM students WHERE company_id = %s AND id = %s LIMIT 1",
                     (company_id, student_id))
        batch_id = int(student["batch_id"]) if student and student.get("batch_id") is not None else None

        clarity = clamp_rating(payload.get("clarityRating"), 0) or None
        platform = clamp_rating(payload.get("platformRating"), 0) or None

        execute(conn, """INSERT INTO session_feedback
            (company_id, session_id, exam_id, student_id, batch_id, rating, clarity_rating, platform_rating, comment)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
            ON DUPLICATE KEY UPDATE rating = VALUES(rating),
                                    clarity_rating = VALUES(clarity_rating),
                                    platform_rating = VALUES(platform_rating),
                                    comment = VALUES(comment),
                                    created_at = CURRENT_TIMESTAMP""",
                (company_id, session_id, exam_id, student_id, batch_id,
                 clamp_rating(payload.get("rating", 5)), clarity, platform,
                 comment if comment != "" else None))

        audit_log(conn, request, {
            "companyId": company_id,
            "actorRole": "STUDENT",
            "actorId": student_id,
            "action": "FEEDBACK_SUBMIT",
            "targetType": "exam",
            "targetId": exam_id,
            "message": "Student submitted exam feedback",
            "metadata": {"sessionId": session_id},
        })
        return {"ok": True}
