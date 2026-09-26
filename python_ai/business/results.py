"""Python port of api/results.php — completed-exam results, regrade audit, manual regrading."""

from __future__ import annotations

import re

from fastapi import APIRouter, Request

from .core import (
    ApiError, audit_log, db, dt_ms, execute, json_input, json_or_none, php_int, q, q1,
    require_company_id, require_role, table_exists,
)

router = APIRouter()


def _is_numeric(value) -> bool:
    if isinstance(value, bool) or value is None:
        return False
    if isinstance(value, (int, float)):
        return True
    if isinstance(value, str):
        return bool(re.match(r"^\s*[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?\s*$", value))
    return False


@router.get("/results.php")
def get_results(request: Request):
    with db() as conn:
        company_id = require_company_id(request)
        qp = request.query_params
        audit = qp.get("audit") == "1"
        session_id_param = php_int(qp["sessionId"]) if "sessionId" in qp else None
        has_audit_table = table_exists(conn, "result_audit_logs")

        if audit and session_id_param:
            if not has_audit_table:
                return {"audits": []}
            if not q1(conn, "SELECT id FROM exam_sessions WHERE id = %s AND company_id = %s LIMIT 1",
                      (session_id_param, company_id)):
                return {"audits": []}
            rows = q(conn, """SELECT id, session_id, question_id, previous_awarded_marks, new_awarded_marks,
                                     previous_is_correct, new_is_correct, actor, note, created_at
                              FROM result_audit_logs WHERE session_id = %s
                              ORDER BY created_at DESC, id DESC""", (session_id_param,))
            audits = [{
                "id": int(r["id"]),
                "sessionId": int(r["session_id"]),
                "questionId": r["question_id"],
                "previousAwardedMarks": int(r["previous_awarded_marks"]) if r.get("previous_awarded_marks") is not None else None,
                "newAwardedMarks": int(r["new_awarded_marks"]) if r.get("new_awarded_marks") is not None else None,
                "previousIsCorrect": bool(r["previous_is_correct"]) if r.get("previous_is_correct") is not None else None,
                "newIsCorrect": bool(r["new_is_correct"]) if r.get("new_is_correct") is not None else None,
                "actor": r["actor"],
                "note": r["note"],
                "createdAt": dt_ms(r.get("created_at")) or 0,
            } for r in rows]
            return {"audits": audits}

        exam_id = (qp.get("examId") or "").strip() or None
        student_id = (qp.get("studentId") or "").strip() or None

        where: list[str] = []
        params: list = [company_id]
        if exam_id:
            where.append("es.exam_id = %s")
            params.append(exam_id)
        if student_id:
            where.append("es.student_id = %s")
            params.append(student_id)
        if session_id_param:
            where.append("es.id = %s")
            params.append(session_id_param)

        sql = """SELECT es.id, es.exam_id, es.student_id, es.start_time, es.end_time, es.status,
                        es.total_score, es.max_score, es.passed, e.pass_percent
                 FROM exam_sessions es
                 JOIN exams e ON e.id = es.exam_id AND e.company_id = es.company_id
                 WHERE es.company_id = %s"""
        if where:
            sql += " AND " + " AND ".join(where)
        sql += " AND es.status = 'COMPLETED' ORDER BY es.start_time DESC"
        sessions = q(conn, sql, params)

        # Group by exam|student to compute per-attempt indices (chronological).
        groups: dict[str, list] = {}
        for s in sessions:
            groups.setdefault(f"{s['exam_id']}|{s['student_id']}", []).append(s)

        group_meta: dict[str, dict] = {}
        for key, group in groups.items():
            ordered = sorted(group, key=lambda g: dt_ms(g["start_time"]) or 0)
            attempt_index = {int(g["id"]): idx + 1 for idx, g in enumerate(ordered)}
            group_meta[key] = {"attemptCount": len(group), "attemptIndex": attempt_index}

        has_qtimes = table_exists(conn, "session_question_times")
        time_select = "sqt.seconds_spent" if has_qtimes else "NULL AS seconds_spent"
        time_join = ("LEFT JOIN session_question_times sqt ON sqt.session_id = sa.session_id AND sqt.question_id = sa.question_id"
                     if has_qtimes else "")
        answers_sql = f"""SELECT sa.question_id, sa.answer_text, sa.answer_option_index, sa.is_correct, sa.awarded_marks,
                                 q.text, q.type, q.options_json, q.correct_option_index, q.marks, eq.display_order, {time_select}
                          FROM session_answers sa
                          JOIN questions q ON q.id = sa.question_id
                          LEFT JOIN exam_questions eq ON eq.exam_id = %s AND eq.question_id = sa.question_id
                          {time_join}
                          WHERE sa.session_id = %s
                          ORDER BY (eq.display_order IS NULL), eq.display_order ASC, sa.question_id ASC"""

        results = []
        for s in sessions:
            key = f"{s['exam_id']}|{s['student_id']}"
            meta = group_meta.get(key)
            answer_rows = q(conn, answers_sql, (s["exam_id"], s["id"]))
            answers = []
            for row in answer_rows:
                options = json_or_none(row.get("options_json")) if row.get("options_json") else None
                if not isinstance(options, list):
                    options = None
                answers.append({
                    "questionId": row["question_id"],
                    "questionText": row["text"],
                    "questionType": row["type"],
                    "options": options,
                    "correctOptionIndex": int(row["correct_option_index"]) if row.get("correct_option_index") is not None else None,
                    "marks": int(row["marks"]),
                    "answerText": row["answer_text"],
                    "answerOptionIndex": int(row["answer_option_index"]) if row.get("answer_option_index") is not None else None,
                    "isCorrect": bool(row["is_correct"]) if row.get("is_correct") is not None else None,
                    "awardedMarks": int(row["awarded_marks"]) if row.get("awarded_marks") is not None else None,
                    "timeSpentSec": int(row["seconds_spent"]) if row.get("seconds_spent") is not None else None,
                })

            score = int(s["total_score"]) if s.get("total_score") is not None else None
            max_score = int(s["max_score"]) if s.get("max_score") is not None else None
            pass_percent = int(s["pass_percent"]) if s.get("pass_percent") is not None else 60
            pass_percent = max(0, min(100, pass_percent))
            final_percent = None
            if score is not None and max_score is not None and max_score > 0:
                final_percent = int(round((score / max_score) * 100))

            passed = bool(s["passed"]) if s.get("passed") is not None else None
            results.append({
                "sessionId": int(s["id"]),
                "examId": s["exam_id"],
                "studentId": s["student_id"],
                "startTime": dt_ms(s["start_time"]) or 0,
                "endTime": dt_ms(s["end_time"]),
                "status": s["status"],
                "totalScore": score,
                "maxScore": max_score,
                "passed": passed,
                "attemptPolicy": "LAST",
                "attemptIndex": (meta["attemptIndex"].get(int(s["id"])) if meta else None),
                "attemptCount": meta["attemptCount"] if meta else None,
                "finalScore": score,
                "finalMaxScore": max_score,
                "finalPercent": final_percent,
                "finalPassed": passed if passed is not None else (
                    (final_percent >= pass_percent) if final_percent is not None else None),
                "answers": answers,
            })

        return {"results": results}


@router.post("/results.php")
async def post_results(request: Request):
    payload = await json_input(request)
    with db() as conn:
        require_role(request, ["ADMIN"], payload)
        company_id = require_company_id(request, payload)
        session_id = php_int(payload.get("sessionId"))
        changes = payload.get("changes") if isinstance(payload.get("changes"), list) else []
        actor = str(payload["actor"]).strip() if payload.get("actor") is not None else None
        note = str(payload["note"]).strip() if payload.get("note") is not None else None

        if session_id <= 0 or len(changes) == 0:
            raise ApiError({"error": "sessionId and changes are required."}, 400)

        session = q1(conn, "SELECT id, exam_id, student_id FROM exam_sessions WHERE id = %s AND company_id = %s LIMIT 1",
                     (session_id, company_id))
        if not session:
            raise ApiError({"error": "Session not found."}, 404)

        seen: list[str] = []
        for c in changes:
            if isinstance(c, dict) and "questionId" in c:
                qid = str(c["questionId"])
                if qid != "" and qid not in seen:
                    seen.append(qid)
        question_ids = seen
        if len(question_ids) == 0:
            raise ApiError({"error": "No valid questionIds."}, 400)

        placeholders = ",".join(["%s"] * len(question_ids))
        current_rows = q(conn, f"""SELECT sa.question_id, sa.awarded_marks, sa.is_correct, q.type, q.marks
                                   FROM session_answers sa JOIN questions q ON q.id = sa.question_id
                                   WHERE sa.session_id = %s AND sa.question_id IN ({placeholders})""",
                         [session_id] + question_ids)
        current_map = {r["question_id"]: r for r in current_rows}

        has_audit_table = table_exists(conn, "result_audit_logs")
        updated = 0
        for change in changes:
            if not isinstance(change, dict) or "questionId" not in change:
                continue
            qid = str(change["questionId"])
            row = current_map.get(qid)
            if row is None:
                continue

            prev_awarded = int(row["awarded_marks"]) if row.get("awarded_marks") is not None else None
            prev_correct = bool(row["is_correct"]) if row.get("is_correct") is not None else None
            q_type = row["type"]
            q_marks = int(row["marks"])

            new_awarded = change["awardedMarks"] if "awardedMarks" in change else prev_awarded
            if new_awarded == "" or new_awarded is None:
                new_awarded = None
            elif _is_numeric(new_awarded):
                new_awarded = int(float(new_awarded))
            else:
                new_awarded = prev_awarded

            if "isCorrect" in change and change["isCorrect"] is not None:
                new_correct = bool(change["isCorrect"])
            else:
                if q_type == "MCQ" and new_awarded is not None:
                    if new_awarded >= q_marks:
                        new_correct = True
                    elif new_awarded == 0:
                        new_correct = False
                    else:
                        new_correct = None
                else:
                    new_correct = None

            if prev_awarded == new_awarded and prev_correct == new_correct:
                continue

            execute(conn, "UPDATE session_answers SET awarded_marks = %s, is_correct = %s WHERE session_id = %s AND question_id = %s",
                    (new_awarded, new_correct, session_id, qid))
            if has_audit_table:
                execute(conn, """INSERT INTO result_audit_logs
                    (session_id, question_id, previous_awarded_marks, new_awarded_marks, previous_is_correct, new_is_correct, actor, note)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s)""",
                        (session_id, qid, prev_awarded, new_awarded,
                         None if prev_correct is None else (1 if prev_correct else 0),
                         None if new_correct is None else (1 if new_correct else 0), actor, note))
            updated += 1

        score_rows = q(conn, """SELECT q.type, q.marks, sa.awarded_marks
                                FROM session_answers sa JOIN questions q ON q.id = sa.question_id
                                WHERE sa.session_id = %s""", (session_id,))
        total_score = 0
        max_score = 0
        pending = False
        for r in score_rows:
            marks = int(r["marks"])
            max_score += marks
            if r["type"] == "TEXT" and r["awarded_marks"] is None:
                pending = True
            total_score += int(r["awarded_marks"]) if r["awarded_marks"] is not None else 0

        passed = None
        if not pending and max_score > 0:
            pass_row = q1(conn, """SELECT e.pass_percent FROM exam_sessions es
                                   JOIN exams e ON e.id = es.exam_id
                                   WHERE es.id = %s AND es.company_id = %s LIMIT 1""", (session_id, company_id))
            pass_percent = int(pass_row["pass_percent"]) if pass_row and pass_row.get("pass_percent") is not None else 60
            pass_percent = max(0, min(100, pass_percent))
            passed = 1 if (total_score / max_score) >= (pass_percent / 100) else 0

        execute(conn, "UPDATE exam_sessions SET total_score = %s, max_score = %s, passed = %s WHERE id = %s AND company_id = %s",
                (total_score, max_score, passed, session_id, company_id))

        with conn.cursor() as cur:
            cur.execute("CALL sp_log_access(%s, %s, %s, %s, %s, %s)",
                        (company_id, session["exam_id"], session["student_id"], "RE-GRADE", "OK", f"Updated {updated} answers"))
            while cur.nextset():
                pass

        audit_log(conn, request, {
            "companyId": company_id, "actorRole": "ADMIN", "actorId": actor,
            "action": "RESULT_REGRADE", "targetType": "session", "targetId": str(session_id),
            "message": f"Regraded {updated} answers", "metadata": {"note": note},
        })

        return {"ok": True, "updated": updated}
