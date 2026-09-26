"""Python port of api/exams.php — exam definition CRUD (questions, sections, assignments)."""

from __future__ import annotations

import datetime as _dt
import json
import re
import secrets

from fastapi import APIRouter, Request

from .core import (
    ApiError, audit_log, column_exists, db, dt_ms, execute, json_input, php_int,
    php_json_normalize, q, require_company_id, require_role,
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


def ms_to_datetime(ms):
    if ms is None:
        return None
    sec = ms // 1000
    ms_part = ms % 1000
    dt = _dt.datetime.utcfromtimestamp(sec)  # PHP default TZ is UTC on this host
    return dt.strftime("%Y-%m-%d %H:%M:%S") + "." + str(ms_part).zfill(3)


def normalize_violation_limits(raw) -> dict:
    defaults = {"camera": 0, "microphone": 0, "fullscreen": 0, "copyPaste": 0}
    if isinstance(raw, str) and raw != "":
        try:
            decoded = json.loads(raw)
            if isinstance(decoded, dict):
                raw = decoded
        except (ValueError, TypeError):
            pass
    if not isinstance(raw, dict):
        return dict(defaults)
    for key, fallback in list(defaults.items()):
        val = raw.get(key, fallback)
        num = int(float(val)) if _is_numeric(val) else fallback
        defaults[key] = max(0, num)
    return defaults


def ensure_exam_batch_assignment_schema(conn) -> None:
    execute(conn, """CREATE TABLE IF NOT EXISTS exam_batch_assignments (
      exam_id     VARCHAR(64) NOT NULL,
      batch_id    BIGINT UNSIGNED NOT NULL,
      assigned_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (exam_id, batch_id),
      INDEX idx_exam_batch_assignments_batch (batch_id)
    ) ENGINE=InnoDB""")


def _map_question(qrow: dict) -> dict:
    options = None
    if qrow.get("options_json"):
        try:
            decoded = json.loads(qrow["options_json"])
            # PHP uses is_array() (accepts both JSON arrays and objects) then json_decode(true)
            # turns an empty {} into []. Mirror that so re-emitted options match byte-for-byte.
            options = php_json_normalize(decoded) if isinstance(decoded, (list, dict)) else None
        except (ValueError, TypeError):
            options = None
    return {
        "id": qrow["id"],
        "text": qrow["text"],
        "type": qrow["type"],
        "options": options,
        "correctOptionIndex": int(qrow["correct_option_index"]) if qrow.get("correct_option_index") is not None else None,
        "marks": int(qrow["marks"]),
    }


@router.get("/exams.php")
def get_exams(request: Request):
    with db() as conn:
        ensure_exam_batch_assignment_schema(conn)
        company_id = require_company_id(request)
        has_violation_limits = column_exists(conn, "exams", "violation_limits_json")
        rows = q(conn, "SELECT * FROM exams WHERE company_id = %s ORDER BY updated_at DESC", (company_id,))

        exams = []
        for row in rows:
            exam_id = row["id"]
            violation_limits_raw = row.get("violation_limits_json") if has_violation_limits else None
            questions = q(conn, """SELECT q.id, q.type, q.text, q.options_json, q.correct_option_index, q.marks, eq.display_order
                                   FROM exam_questions eq JOIN questions q ON q.id = eq.question_id
                                   WHERE eq.exam_id = %s ORDER BY eq.display_order ASC""", (exam_id,))
            mapped_questions = [_map_question(x) for x in questions]

            assignments = q(conn, "SELECT student_id FROM exam_assignments WHERE exam_id = %s ORDER BY student_id ASC", (exam_id,))
            assigned_ids = [a["student_id"] for a in assignments]
            batch_rows = q(conn, "SELECT batch_id FROM exam_batch_assignments WHERE exam_id = %s ORDER BY batch_id ASC", (exam_id,))
            assigned_batch_ids = [int(b["batch_id"]) for b in batch_rows]

            sec_rows = q(conn, """SELECT id, title, display_order, question_limit, shuffle_questions, time_limit_minutes, lock_on_complete
                                  FROM exam_sections WHERE exam_id = %s ORDER BY display_order ASC""", (exam_id,))
            sections = []
            for sec in sec_rows:
                sec_questions = q(conn, """SELECT q.id, q.type, q.text, q.options_json, q.correct_option_index, q.marks, esq.display_order
                                           FROM exam_section_questions esq JOIN questions q ON q.id = esq.question_id
                                           WHERE esq.section_id = %s ORDER BY esq.display_order ASC""", (sec["id"],))
                sections.append({
                    "id": sec["id"],
                    "title": sec["title"],
                    "displayOrder": int(sec["display_order"]),
                    "questionLimit": int(sec["question_limit"]),
                    "shuffleQuestions": bool(sec["shuffle_questions"]),
                    "timeLimitMinutes": int(sec["time_limit_minutes"]) if sec.get("time_limit_minutes") is not None else 0,
                    "lockOnComplete": bool(sec["lock_on_complete"]) if sec.get("lock_on_complete") is not None else True,
                    "questions": [_map_question(x) for x in sec_questions],
                })

            exams.append({
                "id": exam_id,
                "title": row["title"],
                "durationMinutes": int(row["duration_minutes"]),
                "startTime": dt_ms(row["start_time"]),
                "endTime": dt_ms(row["end_time"]),
                "questions": mapped_questions,
                "sections": sections,
                "questionCount": int(row["question_count"]) if row.get("question_count") is not None else None,
                "shuffleQuestions": bool(row["shuffle_questions"]),
                "showResults": bool(row["show_results"]),
                "attemptPolicy": row.get("attempt_policy") or "LAST",
                "passPercent": int(row["pass_percent"]) if row.get("pass_percent") is not None else 60,
                "reconnectLimit": int(row["reconnect_limit"]) if row.get("reconnect_limit") is not None else 0,
                "totalMarks": int(row["total_marks"]),
                "status": row["status"],
                "proctoringConfig": {
                    "cameraRequired": bool(row["camera_required"]),
                    "microphoneRequired": bool(row["microphone_required"]),
                    "fullScreenEnforced": bool(row["fullscreen_enforced"]),
                    "tabSwitchLimit": int(row["tab_switch_limit"]),
                    "violationLimits": normalize_violation_limits(violation_limits_raw),
                },
                "assignedStudentIds": assigned_ids,
                "assignedBatchIds": assigned_batch_ids,
                "notificationConfig": {
                    "enabled": bool(row["notification_enabled"]),
                    "reminders": {
                        "hours24": bool(row["reminder_hours24"]),
                        "hours1": bool(row["reminder_hours1"]),
                    },
                    "customSubject": row.get("notification_subject") or "",
                    "customMessage": row.get("notification_message") or "",
                },
            })

        return {"exams": exams}


@router.post("/exams.php")
async def post_exams(request: Request):
    payload = await json_input(request)
    with db() as conn:
        ensure_exam_batch_assignment_schema(conn)
        require_role(request, ["ADMIN"], payload)
        company_id = require_company_id(request, payload)

        if payload.get("action") is not None:
            action = str(payload["action"]).strip().upper()
            if action in ("DELETE", "ARCHIVE"):
                eid = str(payload.get("id") or "").strip()
                if eid == "":
                    raise ApiError({"error": "Exam id is required."}, 400)
                permanent = bool(payload.get("permanent"))
                if action == "ARCHIVE" or not permanent:
                    execute(conn, "UPDATE exams SET status = 'ARCHIVED' WHERE id = %s AND company_id = %s", (eid, company_id))
                    audit_log(conn, request, {
                        "companyId": company_id, "actorRole": "ADMIN", "actorId": payload.get("actor"),
                        "action": "EXAM_ARCHIVE", "targetType": "exam", "targetId": eid, "message": "Exam archived",
                    })
                    return {"ok": True, "archived": True}
                execute(conn, "DELETE FROM exams WHERE id = %s AND company_id = %s", (eid, company_id))
                audit_log(conn, request, {
                    "companyId": company_id, "actorRole": "ADMIN", "actorId": payload.get("actor"),
                    "action": "EXAM_DELETE", "targetType": "exam", "targetId": eid, "message": "Exam permanently deleted",
                })
                return {"ok": True, "deleted": True}
            raise ApiError({"error": "Invalid action."}, 400)

        exam = payload
        if isinstance(payload.get("exam"), dict):
            exam = payload["exam"]
        if not isinstance(exam, dict):
            raise ApiError({"error": "Invalid exam payload."}, 400)

        eid = exam.get("id") or secrets.token_hex(8)
        title = str(exam.get("title") or "").strip()
        duration = php_int(exam.get("durationMinutes"))
        start_ms = php_int(exam["startTime"]) if exam.get("startTime") is not None else None
        end_ms = php_int(exam["endTime"]) if exam.get("endTime") is not None else None
        question_count = php_int(exam["questionCount"]) if exam.get("questionCount") is not None else None
        shuffle = 1 if exam.get("shuffleQuestions") else 0
        reconnect_limit = php_int(exam.get("reconnectLimit")) if exam.get("reconnectLimit") is not None else 0
        total_marks = php_int(exam.get("totalMarks"))
        status = exam.get("status") or "DRAFT"
        pass_percent = php_int(exam["passPercent"]) if exam.get("passPercent") is not None else 60
        pass_percent = max(0, min(100, pass_percent))

        if title == "" or duration <= 0 or start_ms is None or end_ms is None:
            raise ApiError({"error": "Exam title, durationMinutes, startTime, and endTime are required."}, 400)
        if end_ms <= start_ms:
            raise ApiError({"error": "endTime must be later than startTime."}, 400)

        attempt_policy = "LAST"
        sections_input = exam.get("sections") or []
        proctor = exam.get("proctoringConfig") or {}
        if not isinstance(proctor, dict):
            proctor = {}
        violation_limits = normalize_violation_limits(proctor.get("violationLimits"))
        notif = exam.get("notificationConfig") or {}
        if not isinstance(notif, dict):
            notif = {}
        reminders = notif.get("reminders") or {}
        if not isinstance(reminders, dict):
            reminders = {}

        sections: list[dict] = []
        question_map: dict = {}

        if isinstance(sections_input, list) and len(sections_input) > 0:
            section_order = 0
            for section in sections_input:
                if not isinstance(section, dict):
                    continue
                section_id = section.get("id") or secrets.token_hex(8)
                section_title = str(section.get("title") or "Section").strip()
                section_limit = php_int(section.get("questionLimit")) if section.get("questionLimit") is not None else 0
                section_shuffle = 1 if section.get("shuffleQuestions") else 0
                section_questions = []
                if isinstance(section.get("questions"), list):
                    for qq in section["questions"]:
                        if not isinstance(qq, dict):
                            continue
                        qid = qq.get("id") or secrets.token_hex(8)
                        qq = {**qq, "id": qid}
                        question_map[qid] = qq
                        section_questions.append(qq)
                sections.append({
                    "id": section_id,
                    "title": section_title,
                    "displayOrder": section_order,
                    "questionLimit": section_limit,
                    "shuffleQuestions": bool(section_shuffle),
                    "timeLimitMinutes": php_int(section["timeLimitMinutes"]) if section.get("timeLimitMinutes") is not None else 0,
                    "lockOnComplete": bool(section.get("lockOnComplete")) if "lockOnComplete" in section else True,
                    "questions": section_questions,
                })
                section_order += 1
        else:
            questions = exam.get("questions") or []
            if isinstance(questions, list):
                for qq in questions:
                    if not isinstance(qq, dict):
                        continue
                    qid = qq.get("id") or secrets.token_hex(8)
                    qq = {**qq, "id": qid}
                    question_map[qid] = qq

        assigned_batch_ids = [i for i in (php_int(x) for x in (exam.get("assignedBatchIds") or [])) if i > 0]

        if len(assigned_batch_ids) > 0:
            placeholders = ",".join(["%s"] * len(assigned_batch_ids))
            assigned_student_rows = q(conn, f"""SELECT id FROM students
                                                WHERE company_id = %s AND batch_id IN ({placeholders})
                                                ORDER BY id ASC""", [company_id] + assigned_batch_ids)
            seen = []
            for r in assigned_student_rows:
                sid = str(r["id"])
                if sid not in seen:
                    seen.append(sid)
            assigned_ids = seen
        else:
            assigned_ids = exam.get("assignedStudentIds") or []

        start_time = ms_to_datetime(start_ms)
        end_time = ms_to_datetime(end_ms)

        conn.begin()
        try:
            execute(conn, """INSERT INTO exams
                (id, company_id, title, duration_minutes, start_time, end_time, question_count, shuffle_questions, show_results,
                 pass_percent, attempt_policy, reconnect_limit, total_marks, status, camera_required, microphone_required,
                 fullscreen_enforced, tab_switch_limit, notification_enabled, reminder_hours24, reminder_hours1,
                 notification_subject, notification_message)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                ON DUPLICATE KEY UPDATE
                    company_id = VALUES(company_id), title = VALUES(title), duration_minutes = VALUES(duration_minutes),
                    start_time = VALUES(start_time), end_time = VALUES(end_time), question_count = VALUES(question_count),
                    shuffle_questions = VALUES(shuffle_questions), show_results = VALUES(show_results),
                    pass_percent = VALUES(pass_percent), attempt_policy = VALUES(attempt_policy),
                    reconnect_limit = VALUES(reconnect_limit), total_marks = VALUES(total_marks), status = VALUES(status),
                    camera_required = VALUES(camera_required), microphone_required = VALUES(microphone_required),
                    fullscreen_enforced = VALUES(fullscreen_enforced), tab_switch_limit = VALUES(tab_switch_limit),
                    notification_enabled = VALUES(notification_enabled), reminder_hours24 = VALUES(reminder_hours24),
                    reminder_hours1 = VALUES(reminder_hours1), notification_subject = VALUES(notification_subject),
                    notification_message = VALUES(notification_message)""",
                    (eid, company_id, title, duration, start_time, end_time, question_count, shuffle,
                     1 if exam.get("showResults") else 0, pass_percent, attempt_policy, reconnect_limit, total_marks, status,
                     1 if proctor.get("cameraRequired") else 0, 1 if proctor.get("microphoneRequired") else 0,
                     1 if proctor.get("fullScreenEnforced") else 0,
                     php_int(proctor["tabSwitchLimit"]) if proctor.get("tabSwitchLimit") is not None else 3,
                     1 if notif.get("enabled") else 0, 1 if reminders.get("hours24") else 0, 1 if reminders.get("hours1") else 0,
                     notif.get("customSubject"), notif.get("customMessage")))

            if column_exists(conn, "exams", "violation_limits_json"):
                execute(conn, "UPDATE exams SET violation_limits_json = %s WHERE id = %s AND company_id = %s",
                        (json.dumps(violation_limits), eid, company_id))

            existing_section_ids = [str(r["id"]) for r in q(conn, "SELECT id FROM exam_sections WHERE exam_id = %s", (eid,))]
            if existing_section_ids:
                ph = ",".join(["%s"] * len(existing_section_ids))
                execute(conn, f"DELETE FROM exam_section_questions WHERE section_id IN ({ph})", existing_section_ids)
            execute(conn, "DELETE FROM exam_sections WHERE exam_id = %s", (eid,))
            execute(conn, "DELETE FROM exam_questions WHERE exam_id = %s", (eid,))
            execute(conn, "DELETE FROM exam_assignments WHERE exam_id = %s", (eid,))
            execute(conn, "DELETE FROM exam_batch_assignments WHERE exam_id = %s", (eid,))

            order = 0
            for qid, qq in question_map.items():
                options_json = json.dumps(qq["options"]) if isinstance(qq.get("options"), list) else None
                execute(conn, """INSERT INTO questions (id, type, text, options_json, correct_option_index, marks)
                                 VALUES (%s, %s, %s, %s, %s, %s)
                                 ON DUPLICATE KEY UPDATE type = VALUES(type), text = VALUES(text),
                                     options_json = VALUES(options_json), correct_option_index = VALUES(correct_option_index),
                                     marks = VALUES(marks)""",
                        (qid, qq.get("type") or "MCQ", qq.get("text") or "", options_json,
                         qq.get("correctOptionIndex"), php_int(qq["marks"]) if qq.get("marks") is not None else 1))
                execute(conn, "INSERT INTO exam_questions (exam_id, question_id, display_order) VALUES (%s, %s, %s)",
                        (eid, qid, order))
                order += 1

            if len(sections) > 0:
                for section_idx, section in enumerate(sections):
                    execute(conn, """INSERT INTO exam_sections
                        (id, exam_id, title, display_order, question_limit, shuffle_questions, time_limit_minutes, lock_on_complete)
                        VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                        ON DUPLICATE KEY UPDATE title = VALUES(title), display_order = VALUES(display_order),
                            question_limit = VALUES(question_limit), shuffle_questions = VALUES(shuffle_questions),
                            time_limit_minutes = VALUES(time_limit_minutes), lock_on_complete = VALUES(lock_on_complete)""",
                            (section["id"], eid, section["title"], section_idx, int(section["questionLimit"]),
                             1 if section["shuffleQuestions"] else 0,
                             int(section["timeLimitMinutes"]) if section.get("timeLimitMinutes") is not None else 0,
                             1 if section["lockOnComplete"] else 0))
                    q_order = 0
                    for qq in section["questions"]:
                        qid = qq.get("id")
                        if not qid:
                            continue
                        execute(conn, "INSERT INTO exam_section_questions (section_id, question_id, display_order) VALUES (%s, %s, %s)",
                                (section["id"], qid, q_order))
                        q_order += 1

            for batch_id in assigned_batch_ids:
                execute(conn, "INSERT IGNORE INTO exam_batch_assignments (exam_id, batch_id) VALUES (%s, %s)", (eid, batch_id))
            if isinstance(assigned_ids, list):
                for sid in assigned_ids:
                    execute(conn, "INSERT IGNORE INTO exam_assignments (exam_id, student_id) VALUES (%s, %s)", (eid, sid))

            conn.commit()
        except Exception:
            conn.rollback()
            raise

        audit_log(conn, request, {
            "companyId": company_id, "actorRole": "ADMIN", "actorId": exam.get("actor"),
            "action": "EXAM_SAVE", "targetType": "exam", "targetId": eid,
            "message": f"Exam saved: {title}" if title != "" else "Exam saved",
            "metadata": {
                "status": status,
                "questionCount": len(exam["questions"]) if isinstance(exam.get("questions"), list) else 0,
                "sectionCount": len(sections),
                "assignedCount": len(assigned_ids) if isinstance(assigned_ids, list) else 0,
                "assignedBatchCount": len(assigned_batch_ids),
            },
        })

        result = dict(exam)
        result["id"] = eid
        if isinstance(assigned_ids, list):
            deduped = []
            for sid in assigned_ids:
                if sid not in deduped:
                    deduped.append(sid)
            result["assignedStudentIds"] = deduped
        else:
            result["assignedStudentIds"] = []
        result["assignedBatchIds"] = assigned_batch_ids
        result["attemptPolicy"] = "LAST"
        result["passPercent"] = pass_percent
        merged_proctor = {"cameraRequired": False, "microphoneRequired": False, "fullScreenEnforced": False,
                          "tabSwitchLimit": 3, "violationLimits": normalize_violation_limits(None)}
        merged_proctor.update(proctor)
        merged_proctor["violationLimits"] = violation_limits
        result["proctoringConfig"] = merged_proctor
        if len(sections) > 0:
            result["sections"] = sections
        return {"exam": result}
