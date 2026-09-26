"""Python port of api/reports.php — analytics dashboard aggregation (read-only)."""

from __future__ import annotations

import math

from fastapi import APIRouter, Request

from .core import db, dt_ms, now_ms, q, q1, require_company_id, require_role, table_exists

router = APIRouter()


def _php_round(x: float) -> int:
    # PHP round(): half away from zero (differs from Python's banker's rounding).
    return int(math.floor(x + 0.5)) if x >= 0 else int(math.ceil(x - 0.5))


def pct(num: int, den: int) -> int:
    return _php_round((num / den) * 100) if den > 0 else 0


def _map_performance(row: dict) -> dict:
    attempts = int(row.get("attempts") or 0)
    completed = int(row.get("completed_count") or 0)
    passed = int(row.get("passed_count") or 0)
    avg = row.get("avg_percent")
    return {
        "attempts": attempts,
        "completed": completed,
        "terminated": int(row.get("terminated_count") or 0),
        "passed": passed,
        "passRate": pct(passed, completed),
        "avgPercent": _php_round(float(avg)) if avg is not None else 0,
        "violations": int(row.get("violations") or 0),
    }


@router.get("/reports.php")
def get_reports(request: Request):
    with db() as conn:
        require_role(request, ["ADMIN", "PROCTOR"])
        company_id = require_company_id(request)
        cid = company_id
        has_batches = table_exists(conn, "batches")

        summary_row = q1(conn, """SELECT
                (SELECT COUNT(*) FROM exams WHERE company_id = %s) AS exams_count,
                (SELECT COUNT(*) FROM students WHERE company_id = %s) AS students_count,
                (SELECT COUNT(*) FROM exam_sessions WHERE company_id = %s) AS sessions_count,
                (SELECT COUNT(*) FROM exam_sessions WHERE company_id = %s AND status = 'COMPLETED') AS completed_count,
                (SELECT COUNT(*) FROM exam_sessions WHERE company_id = %s AND status = 'TERMINATED') AS terminated_count,
                (SELECT COUNT(*) FROM violation_logs WHERE company_id = %s) AS violation_count""",
                         (cid, cid, cid, cid, cid, cid)) or {}
        completed = int(summary_row.get("completed_count") or 0)
        terminated = int(summary_row.get("terminated_count") or 0)

        pass_row = q1(conn, """SELECT COUNT(*) AS graded_count,
                    SUM(CASE WHEN passed = 1 THEN 1 ELSE 0 END) AS passed_count,
                    AVG(CASE WHEN max_score > 0 THEN (total_score / max_score) * 100 ELSE NULL END) AS avg_percent
                FROM exam_sessions
                WHERE company_id = %s AND status = 'COMPLETED' AND total_score IS NOT NULL AND max_score IS NOT NULL""",
                      (cid,)) or {}

        exam_rows = q(conn, """SELECT e.id, e.title, e.status,
                    COUNT(es.id) AS attempts,
                    SUM(CASE WHEN es.status = 'COMPLETED' THEN 1 ELSE 0 END) AS completed_count,
                    SUM(CASE WHEN es.status = 'TERMINATED' THEN 1 ELSE 0 END) AS terminated_count,
                    SUM(CASE WHEN es.passed = 1 THEN 1 ELSE 0 END) AS passed_count,
                    AVG(CASE WHEN es.max_score > 0 THEN (es.total_score / es.max_score) * 100 ELSE NULL END) AS avg_percent,
                    COALESCE(v.violation_count, 0) AS violations
                FROM exams e
                LEFT JOIN exam_sessions es ON es.company_id = e.company_id AND es.exam_id = e.id
                LEFT JOIN (
                    SELECT es2.exam_id, COUNT(vl.id) AS violation_count
                    FROM exam_sessions es2
                    JOIN violation_logs vl ON vl.session_id = es2.id AND vl.company_id = es2.company_id
                    WHERE es2.company_id = %s GROUP BY es2.exam_id
                ) v ON v.exam_id = e.id
                WHERE e.company_id = %s
                GROUP BY e.id, e.title, e.status, v.violation_count
                ORDER BY e.updated_at DESC, e.title ASC""", (cid, cid))

        if has_batches:
            batch_rows = q(conn, """SELECT b.id, b.name,
                    COUNT(DISTINCT s.id) AS students,
                    COUNT(es.id) AS attempts,
                    SUM(CASE WHEN es.status = 'COMPLETED' THEN 1 ELSE 0 END) AS completed_count,
                    SUM(CASE WHEN es.status = 'TERMINATED' THEN 1 ELSE 0 END) AS terminated_count,
                    SUM(CASE WHEN es.passed = 1 THEN 1 ELSE 0 END) AS passed_count,
                    AVG(CASE WHEN es.max_score > 0 THEN (es.total_score / es.max_score) * 100 ELSE NULL END) AS avg_percent,
                    COALESCE(v.violation_count, 0) AS violations
                FROM batches b
                LEFT JOIN students s ON s.company_id = b.company_id AND s.batch_id = b.id
                LEFT JOIN exam_sessions es ON es.company_id = b.company_id AND es.student_id = s.id
                LEFT JOIN (
                    SELECT s2.batch_id, COUNT(vl.id) AS violation_count
                    FROM students s2
                    JOIN exam_sessions es2 ON es2.company_id = s2.company_id AND es2.student_id = s2.id
                    JOIN violation_logs vl ON vl.session_id = es2.id AND vl.company_id = es2.company_id
                    WHERE s2.company_id = %s AND s2.batch_id IS NOT NULL GROUP BY s2.batch_id
                ) v ON v.batch_id = b.id
                WHERE b.company_id = %s
                GROUP BY b.id, b.name, v.violation_count
                ORDER BY b.name ASC""", (cid, cid))
        else:
            batch_rows = []

        batch_name_expr = "b.name" if has_batches else "NULL"
        batch_join = "LEFT JOIN batches b ON b.id = s.batch_id AND b.company_id = s.company_id" if has_batches else ""
        student_rows = q(conn, f"""SELECT s.id, s.full_name, s.registration_id, {batch_name_expr} AS batch_name,
                    COUNT(es.id) AS attempts,
                    SUM(CASE WHEN es.status = 'COMPLETED' THEN 1 ELSE 0 END) AS completed_count,
                    SUM(CASE WHEN es.status = 'TERMINATED' THEN 1 ELSE 0 END) AS terminated_count,
                    SUM(CASE WHEN es.passed = 1 THEN 1 ELSE 0 END) AS passed_count,
                    AVG(CASE WHEN es.max_score > 0 THEN (es.total_score / es.max_score) * 100 ELSE NULL END) AS avg_percent,
                    COALESCE(v.violation_count, 0) AS violations
                FROM students s
                {batch_join}
                LEFT JOIN exam_sessions es ON es.company_id = s.company_id AND es.student_id = s.id
                LEFT JOIN (
                    SELECT es2.student_id, COUNT(vl.id) AS violation_count
                    FROM exam_sessions es2
                    JOIN violation_logs vl ON vl.session_id = es2.id AND vl.company_id = es2.company_id
                    WHERE es2.company_id = %s GROUP BY es2.student_id
                ) v ON v.student_id = s.id
                WHERE s.company_id = %s
                GROUP BY s.id, s.full_name, s.registration_id, batch_name, v.violation_count
                ORDER BY violations DESC, avg_percent ASC, s.full_name ASC
                LIMIT 250""", (cid, cid))

        violation_type_rows = q(conn, """SELECT type, COUNT(*) AS count FROM violation_logs
                                         WHERE company_id = %s GROUP BY type ORDER BY count DESC, type ASC""", (cid,))
        timeline_rows = q(conn, """SELECT DATE(occurred_at) AS day, COUNT(*) AS count FROM violation_logs
                                   WHERE company_id = %s AND occurred_at >= DATE_SUB(NOW(), INTERVAL 14 DAY)
                                   GROUP BY DATE(occurred_at) ORDER BY day ASC""", (cid,))

        recent_batch_expr = "b.name" if has_batches else "NULL"
        recent_batch_join = "LEFT JOIN batches b ON b.id = s.batch_id AND b.company_id = s.company_id" if has_batches else ""
        recent_rows = q(conn, f"""SELECT vl.id, vl.session_id, vl.occurred_at, vl.type, vl.description,
                    es.exam_id, e.title AS exam_title, es.student_id, s.full_name, s.registration_id,
                    {recent_batch_expr} AS batch_name
                FROM violation_logs vl
                JOIN exam_sessions es ON es.id = vl.session_id AND es.company_id = vl.company_id
                LEFT JOIN exams e ON e.id = es.exam_id AND e.company_id = es.company_id
                LEFT JOIN students s ON s.id = es.student_id AND s.company_id = es.company_id
                {recent_batch_join}
                WHERE vl.company_id = %s ORDER BY vl.occurred_at DESC LIMIT 80""", (cid,))

        return {
            "generatedAt": now_ms(),
            "summary": {
                "exams": int(summary_row.get("exams_count") or 0),
                "students": int(summary_row.get("students_count") or 0),
                "sessions": int(summary_row.get("sessions_count") or 0),
                "completed": completed,
                "terminated": terminated,
                "violations": int(summary_row.get("violation_count") or 0),
                "completionRate": pct(completed, completed + terminated),
                "passRate": pct(int(pass_row.get("passed_count") or 0), int(pass_row.get("graded_count") or 0)),
                "avgPercent": _php_round(float(pass_row["avg_percent"])) if pass_row.get("avg_percent") is not None else 0,
            },
            "byExam": [{"id": r["id"], "title": r["title"], "status": r["status"], **_map_performance(r)} for r in exam_rows],
            "byBatch": [{"id": int(r["id"]), "name": r["name"], "students": int(r.get("students") or 0), **_map_performance(r)} for r in batch_rows],
            "byStudent": [{"id": r["id"], "name": r["full_name"], "registrationId": r["registration_id"],
                           "batch": r["batch_name"], **_map_performance(r)} for r in student_rows],
            "violationsByType": [{"type": r["type"], "count": int(r["count"])} for r in violation_type_rows],
            "violationTimeline": [{"date": str(r["day"]), "count": int(r["count"])} for r in timeline_rows],
            "recentViolations": [{
                "id": int(r["id"]),
                "sessionId": int(r["session_id"]),
                "examId": r["exam_id"],
                "examTitle": r.get("exam_title") if r.get("exam_title") is not None else r["exam_id"],
                "studentId": r["student_id"],
                "studentName": r.get("full_name") if r.get("full_name") is not None else r["student_id"],
                "registrationId": r.get("registration_id") if r.get("registration_id") is not None else "",
                "batch": r.get("batch_name"),
                # reports.php uses strtotime()*1000 (whole seconds), unlike violations.php
                # which keeps NOW(3) fractional millis — floor to the second to match.
                "timestamp": ((dt_ms(r.get("occurred_at")) // 1000) * 1000) if r.get("occurred_at") is not None else 0,
                "type": r["type"],
                "description": r["description"],
            } for r in recent_rows],
        }
