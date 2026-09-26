"""Python port of api/batches.php — student batch (cohort) CRUD."""

from __future__ import annotations

from fastapi import APIRouter, Request

from .core import (
    ApiError, add_column_if_missing, audit_log, column_exists, db, dt_ms, execute,
    get_actor_id, json_input, last_insert_id, php_int, q, q1, require_company_id,
    require_role, table_exists,
)

router = APIRouter()


def ensure_batch_schema(conn) -> None:
    execute(conn, """CREATE TABLE IF NOT EXISTS batches (
      id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      company_id  INT NOT NULL DEFAULT 1,
      name        VARCHAR(255) NOT NULL,
      description TEXT NULL,
      created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_batches_company_name (company_id, name)
    ) ENGINE=InnoDB""")
    if not column_exists(conn, "students", "batch_id"):
        add_column_if_missing(conn, "students", "batch_id", "BIGINT UNSIGNED NULL")


def normalize_batch_row(row: dict) -> dict:
    return {
        "id": int(row["id"]),
        "companyId": int(row["company_id"]),
        "name": str(row["name"]),
        "description": row.get("description"),
        "studentCount": int(row["student_count"]) if row.get("student_count") is not None else 0,
        "createdAt": dt_ms(row.get("created_at")) or 0,
    }


def list_batches(conn, company_id: int) -> list[dict]:
    rows = q(conn, """SELECT b.id, b.company_id, b.name, b.description, b.created_at,
                             COUNT(s.id) AS student_count
                      FROM batches b
                      LEFT JOIN students s ON s.batch_id = b.id AND s.company_id = b.company_id
                      WHERE b.company_id = %s
                      GROUP BY b.id, b.company_id, b.name, b.description, b.created_at
                      ORDER BY b.created_at DESC, b.name ASC""", (company_id,))
    return [normalize_batch_row(r) for r in rows]


@router.get("/batches.php")
def get_batches(request: Request):
    with db() as conn:
        ensure_batch_schema(conn)
        company_id = require_company_id(request)
        return {"batches": list_batches(conn, company_id)}


@router.post("/batches.php")
async def post_batches(request: Request):
    payload = await json_input(request)
    with db() as conn:
        ensure_batch_schema(conn)
        require_role(request, ["ADMIN"], payload)
        company_id = require_company_id(request, payload)

        action = str(payload.get("action") or "").strip().lower()
        if action == "delete":
            batch_id = php_int(payload.get("id") if payload.get("id") is not None else payload.get("batchId"))
            if batch_id <= 0:
                raise ApiError({"error": "Batch id is required."}, 400)

            existing = q1(conn, "SELECT id, name FROM batches WHERE id = %s AND company_id = %s LIMIT 1",
                          (batch_id, company_id))
            if not existing:
                raise ApiError({"error": "Batch not found for this company."}, 404)

            unassigned = execute(conn, "UPDATE students SET batch_id = NULL WHERE batch_id = %s AND company_id = %s",
                                 (batch_id, company_id))

            if table_exists(conn, "exam_batch_assignments"):
                execute(conn, "DELETE FROM exam_batch_assignments WHERE batch_id = %s", (batch_id,))

            execute(conn, "DELETE FROM batches WHERE id = %s AND company_id = %s", (batch_id, company_id))

            audit_log(conn, request, {
                "companyId": company_id,
                "actorRole": "ADMIN",
                "actorId": get_actor_id(request, payload),
                "action": "BATCH_DELETE",
                "targetType": "batch",
                "targetId": str(batch_id),
                "message": "Batch deleted: " + str(existing.get("name") or batch_id),
                "metadata": {"unassignedStudents": unassigned},
            })
            return {"ok": True, "id": batch_id, "unassignedStudents": unassigned}

        name = str(payload.get("name") or "").strip()
        description = str(payload.get("description") or "").strip()
        if name == "":
            raise ApiError({"error": "Batch name is required."}, 400)

        existing = q1(conn, """SELECT id, company_id, name, description, created_at
                               FROM batches WHERE company_id = %s AND name = %s LIMIT 1""",
                      (company_id, name))
        if existing:
            return {"batch": normalize_batch_row({**existing, "student_count": 0}), "created": False}

        execute(conn, "INSERT INTO batches (company_id, name, description) VALUES (%s, %s, %s)",
                (company_id, name, description if description != "" else None))
        new_id = last_insert_id(conn)
        row = q1(conn, """SELECT id, company_id, name, description, created_at
                          FROM batches WHERE id = %s AND company_id = %s LIMIT 1""",
                 (new_id, company_id))

        audit_log(conn, request, {
            "companyId": company_id,
            "actorRole": "ADMIN",
            "actorId": payload.get("actor"),
            "action": "BATCH_CREATE",
            "targetType": "batch",
            "targetId": str(new_id),
            "message": f"Batch created: {name}",
            "metadata": {"description": description if description != "" else None},
        })

        base = row or {"id": new_id, "company_id": company_id, "name": name,
                       "description": description if description != "" else None,
                       "created_at": None}
        return {"batch": normalize_batch_row({**base, "student_count": 0}), "created": True}
