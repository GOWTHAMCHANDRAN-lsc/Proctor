"""Python port of api/students.php — student roster CRUD with batch assignment."""

from __future__ import annotations

import json
import secrets

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from .core import (
    ApiError, audit_log, column_exists, db, execute, get_actor_id, last_insert_id,
    php_int, q, q1, require_company_id, require_role,
)

router = APIRouter()


def _has_index(conn, table: str, index_name: str) -> bool:
    row = q1(conn, """SELECT COUNT(*) AS cnt FROM information_schema.STATISTICS
                      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = %s AND INDEX_NAME = %s""",
             (table, index_name))
    return int((row or {}).get("cnt", 0)) > 0


def ensure_student_batch_schema(conn) -> None:
    execute(conn, """CREATE TABLE IF NOT EXISTS batches (
      id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      company_id  INT NOT NULL DEFAULT 1,
      name        VARCHAR(255) NOT NULL,
      description TEXT NULL,
      created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_batches_company_name (company_id, name)
    ) ENGINE=InnoDB""")
    if not column_exists(conn, "students", "batch_id"):
        execute(conn, "ALTER TABLE students ADD COLUMN batch_id BIGINT UNSIGNED NULL")
    if not _has_index(conn, "students", "idx_students_company_batch"):
        execute(conn, "ALTER TABLE students ADD INDEX idx_students_company_batch (company_id, batch_id)")


def ensure_student_enrollment_schema(conn) -> None:
    if not column_exists(conn, "students", "face_descriptor"):
        execute(conn, "ALTER TABLE students ADD COLUMN face_descriptor TEXT NULL")
    if not column_exists(conn, "students", "face_photo"):
        execute(conn, "ALTER TABLE students ADD COLUMN face_photo MEDIUMTEXT NULL")
    if not column_exists(conn, "students", "enrolled_at"):
        execute(conn, "ALTER TABLE students ADD COLUMN enrolled_at TIMESTAMP NULL DEFAULT NULL")


def normalize_company_label(company_id: int) -> str:
    return f"Company {company_id}"


def normalize_batch_name(value) -> str | None:
    name = str(value if value is not None else "").strip()
    return name if name != "" else None


def normalize_student_row(row: dict) -> dict:
    company_id = int(row.get("company_id") or row.get("companyId") or 0)
    batch_raw = row.get("batch_id", row.get("batchId"))
    batch_id = int(batch_raw) if batch_raw is not None else None
    batch = row.get("batch_name", row.get("batch"))
    batch = str(batch).strip() if batch is not None else None
    if batch == "":
        batch = None
    enrolled_at = row.get("enrolled_at")
    return {
        "id": str(row["id"]),
        "fullName": str(row.get("full_name") or row.get("fullName") or ""),
        "email": str(row["email"]),
        "registrationId": str(row.get("registration_id") or row.get("registrationId") or ""),
        "companyId": company_id,
        "company": normalize_company_label(company_id),
        "batchId": batch_id,
        "batch": batch,
        "enrolled": bool(enrolled_at),
        "enrolledAt": str(enrolled_at) if enrolled_at is not None else None,
    }


def fetch_students(conn, company_id: int, with_batch: bool, enroll_ready: bool = False) -> list[dict]:
    if with_batch:
        enrolled_expr = "s.enrolled_at" if enroll_ready else "NULL"
        rows = q(conn, f"""SELECT s.id, s.full_name, s.email, s.registration_id, s.company_id, s.batch_id,
                                  {enrolled_expr} AS enrolled_at, b.name AS batch_name
                           FROM students s
                           LEFT JOIN batches b ON b.id = s.batch_id AND b.company_id = s.company_id
                           WHERE s.company_id = %s
                           ORDER BY COALESCE(b.name, ''), s.created_at DESC""", (company_id,))
    else:
        enrolled_expr = "enrolled_at" if enroll_ready else "NULL"
        rows = q(conn, f"""SELECT id, full_name, email, registration_id, company_id,
                                  NULL AS batch_id, {enrolled_expr} AS enrolled_at, NULL AS batch_name
                           FROM students WHERE company_id = %s ORDER BY created_at DESC""", (company_id,))
    return [normalize_student_row(r) for r in rows]


def fetch_student_by_id(conn, company_id: int, student_id: str, with_batch: bool):
    if with_batch:
        row = q1(conn, """SELECT s.id, s.full_name, s.email, s.registration_id, s.company_id, s.batch_id,
                                 b.name AS batch_name
                          FROM students s
                          LEFT JOIN batches b ON b.id = s.batch_id AND b.company_id = s.company_id
                          WHERE s.company_id = %s AND s.id = %s LIMIT 1""", (company_id, student_id))
    else:
        row = q1(conn, """SELECT id, full_name, email, registration_id, company_id,
                                 NULL AS batch_id, NULL AS batch_name
                          FROM students WHERE company_id = %s AND id = %s LIMIT 1""", (company_id, student_id))
    return normalize_student_row(row) if row else None


def find_batch_by_id(conn, company_id: int, batch_id: int):
    return q1(conn, "SELECT id, name FROM batches WHERE company_id = %s AND id = %s LIMIT 1", (company_id, batch_id))


def find_or_create_batch(conn, company_id: int, batch_name: str) -> dict:
    row = q1(conn, "SELECT id, name FROM batches WHERE company_id = %s AND name = %s LIMIT 1", (company_id, batch_name))
    if row:
        return row
    execute(conn, "INSERT INTO batches (company_id, name, description) VALUES (%s, %s, NULL)", (company_id, batch_name))
    created = find_batch_by_id(conn, company_id, last_insert_id(conn))
    if not created:
        raise RuntimeError("Failed to create batch.")
    return created


def humanize_student_error(exc: Exception, registration_id: str, email: str) -> str:
    message = str(exc).strip()
    if message == "":
        return f"Failed to save student {registration_id}."
    if "duplicate entry" in message.lower():
        return f"Duplicate student record for {registration_id} / {email}."
    return message


@router.get("/students.php")
def get_students(request: Request):
    with db() as conn:
        schema_ready = True
        try:
            ensure_student_batch_schema(conn)
        except Exception:
            schema_ready = False
        enroll_ready = False
        try:
            ensure_student_enrollment_schema(conn)
            enroll_ready = column_exists(conn, "students", "enrolled_at")
        except Exception:
            enroll_ready = False

        company_id = require_company_id(request)
        return {"students": fetch_students(conn, company_id, schema_ready, enroll_ready)}


@router.post("/students.php")
async def post_students(request: Request):
    raw = await request.body()
    try:
        payload = json.loads(raw) if raw and raw.strip() else {}
    except ValueError:
        raise ApiError({"error": "Invalid JSON payload."}, 400)
    payload_dict = payload if isinstance(payload, dict) else {}

    with db() as conn:
        schema_ready = True
        try:
            ensure_student_batch_schema(conn)
        except Exception:
            schema_ready = False
        try:
            ensure_student_enrollment_schema(conn)
        except Exception:
            pass

        require_role(request, ["ADMIN"], payload_dict)
        company_id = require_company_id(request, payload_dict)

        action = str(payload_dict.get("action") or "").strip().lower()
        if action == "delete":
            student_id = str(payload_dict.get("id") or payload_dict.get("studentId") or "").strip()
            if student_id == "":
                raise ApiError({"error": "Student id is required."}, 400)
            existing = q1(conn, "SELECT id, full_name FROM students WHERE id = %s AND company_id = %s LIMIT 1",
                          (student_id, company_id))
            if not existing:
                raise ApiError({"error": "Student not found for this company."}, 404)
            execute(conn, "DELETE FROM students WHERE id = %s AND company_id = %s", (student_id, company_id))
            audit_log(conn, request, {
                "companyId": company_id, "actorRole": "ADMIN", "actorId": get_actor_id(request, payload_dict),
                "action": "STUDENT_DELETE", "targetType": "student", "targetId": student_id,
                "message": "Student deleted: " + str(existing.get("full_name") or student_id),
            })
            return {"ok": True, "id": student_id}

        # Resolve the list of student records to upsert.
        if isinstance(payload_dict.get("students"), list):
            items = payload_dict["students"]
        elif isinstance(payload, list):
            items = payload
        elif payload_dict:
            items = [payload_dict]
        else:
            items = []

        if len(items) == 0:
            return JSONResponse({"students": [], "errors": ["No student data provided."]}, status_code=400)

        saved: list[dict] = []
        errors: list[str] = []

        for item in items:
            if not isinstance(item, dict):
                continue
            full_name = str(item.get("fullName") or "").strip()
            email = str(item.get("email") or "").strip()
            registration_id = str(item.get("registrationId") or "").strip()
            batch_name = normalize_batch_name(item.get("batch", item.get("batches", "")))
            batch_id = php_int(item["batchId"]) if item.get("batchId") is not None else None
            item_company_id = php_int(item["companyId"]) if item.get("companyId") is not None else None

            if item_company_id is not None and item_company_id > 0 and item_company_id != company_id:
                errors.append(f"Company mismatch for {registration_id}. Company admins can upload only into their own company.")
                continue
            if full_name == "" or email == "" or registration_id == "":
                errors.append("Missing fields for student (fullName/email/registrationId required).")
                continue
            if "@" not in email:
                errors.append(f"Invalid email format: {email}")
                continue

            try:
                resolved_batch_id = None
                resolved_batch_name = None
                if schema_ready:
                    if batch_id is not None and batch_id > 0:
                        existing_batch = find_batch_by_id(conn, company_id, batch_id)
                        if not existing_batch:
                            raise RuntimeError(f"Batch {batch_id} does not belong to this company.")
                        resolved_batch_id = int(existing_batch["id"])
                        resolved_batch_name = str(existing_batch["name"])
                    elif batch_name is not None:
                        existing_batch = find_or_create_batch(conn, company_id, batch_name)
                        resolved_batch_id = int(existing_batch["id"])
                        resolved_batch_name = str(existing_batch["name"])

                existing = q1(conn, """SELECT id FROM students
                                       WHERE company_id = %s AND (registration_id = %s OR email = %s)
                                       ORDER BY CASE WHEN registration_id = %s THEN 0 ELSE 1 END
                                       LIMIT 1""",
                              (company_id, registration_id, email, registration_id))

                if existing:
                    student_id = str(existing["id"])
                    if schema_ready:
                        execute(conn, """UPDATE students SET full_name = %s, email = %s, registration_id = %s, batch_id = %s
                                         WHERE id = %s AND company_id = %s""",
                                (full_name, email, registration_id, resolved_batch_id, student_id, company_id))
                    else:
                        execute(conn, """UPDATE students SET full_name = %s, email = %s, registration_id = %s
                                         WHERE id = %s AND company_id = %s""",
                                (full_name, email, registration_id, student_id, company_id))
                    row = fetch_student_by_id(conn, company_id, student_id, schema_ready)
                    if row:
                        if resolved_batch_name is not None:
                            row["batch"] = resolved_batch_name
                        saved.append(row)
                    audit_log(conn, request, {
                        "companyId": company_id, "actorRole": "ADMIN", "actorId": payload_dict.get("actor"),
                        "action": "STUDENT_UPDATE", "targetType": "student", "targetId": student_id,
                        "message": f"Student updated: {full_name}",
                        "metadata": {"email": email, "registrationId": registration_id, "batch": resolved_batch_name},
                    })
                    continue

                student_id = str(item["id"]) if item.get("id") is not None else secrets.token_hex(8)
                if schema_ready:
                    execute(conn, """INSERT INTO students (id, company_id, full_name, email, registration_id, batch_id)
                                     VALUES (%s, %s, %s, %s, %s, %s)""",
                            (student_id, company_id, full_name, email, registration_id, resolved_batch_id))
                else:
                    execute(conn, """INSERT INTO students (id, company_id, full_name, email, registration_id)
                                     VALUES (%s, %s, %s, %s, %s)""",
                            (student_id, company_id, full_name, email, registration_id))
                row = fetch_student_by_id(conn, company_id, student_id, schema_ready)
                if row:
                    if resolved_batch_name is not None:
                        row["batch"] = resolved_batch_name
                    saved.append(row)
                audit_log(conn, request, {
                    "companyId": company_id, "actorRole": "ADMIN", "actorId": payload_dict.get("actor"),
                    "action": "STUDENT_CREATE", "targetType": "student", "targetId": student_id,
                    "message": f"Student created: {full_name}",
                    "metadata": {"email": email, "registrationId": registration_id, "batch": resolved_batch_name},
                })
            except Exception as e:
                errors.append(humanize_student_error(e, registration_id, email))

        return {"students": saved, "errors": errors}
