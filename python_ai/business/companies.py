"""Python port of api/companies.php — SUPER_ADMIN company directory (tenant management)."""

from __future__ import annotations

import re

from fastapi import APIRouter, Request

from .core import (
    ApiError, audit_log, column_exists, db, dt_ms, execute, get_actor_id, json_input,
    last_insert_id, now_ms, php_int, q, require_role, scalar_int, table_exists,
)

router = APIRouter()


def normalize_company_payload(payload: dict) -> dict:
    code = str(payload.get("code") or "").strip().lower()
    code = re.sub(r"[^a-z0-9]+", "-", code).strip("-")
    if code == "":
        name_seed = str(payload.get("name") or "company").strip()
        code = re.sub(r"[^A-Za-z0-9]+", "-", name_seed).strip("-").lower()
    return {
        "name": str(payload.get("name") or "").strip(),
        "code": code,
        "contactName": str(payload.get("contactName") or "").strip(),
        "contactEmail": str(payload.get("contactEmail") or "").strip(),
        "status": str(payload.get("status") or "ACTIVE").strip().upper(),
        "notes": str(payload.get("notes") or "").strip(),
    }


def company_table_count(conn, table: str, company_id: int, extra_where: str = "", extra_params: list | None = None) -> int:
    if not table_exists(conn, table):
        return 0
    clauses: list[str] = []
    params: list = []
    if column_exists(conn, table, "company_id"):
        clauses.append("company_id = %s")
        params.append(company_id)
    elif company_id != 1:
        return 0
    if extra_where != "":
        clauses.append(extra_where)
        params.extend(extra_params or [])
    sql = f"SELECT COUNT(*) FROM {table}"
    if clauses:
        sql += " WHERE " + " AND ".join(clauses)
    return scalar_int(conn, sql, params)


def default_company_record(conn) -> dict:
    company_id = 1
    now = now_ms()
    has_pu = table_exists(conn, "platform_users")
    return {
        "id": company_id,
        "code": "default",
        "name": "Default Company",
        "contactName": None,
        "contactEmail": None,
        "status": "ACTIVE",
        "notes": "Legacy single-tenant fallback",
        "createdAt": now,
        "updatedAt": now,
        "adminCount": company_table_count(conn, "platform_users", company_id, "role = 'ADMIN'") if has_pu else 0,
        "proctorCount": company_table_count(conn, "platform_users", company_id, "role = 'PROCTOR'") if has_pu else 0,
        "userStudentCount": company_table_count(conn, "platform_users", company_id, "role = 'STUDENT'") if has_pu else 0,
        "studentCount": company_table_count(conn, "students", company_id),
        "examCount": company_table_count(conn, "exams", company_id),
        "liveSessionCount": company_table_count(conn, "exam_sessions", company_id, "status = 'IN_PROGRESS'"),
        "violationCount": company_table_count(conn, "violation_logs", company_id),
        "pendingRequestCount": company_table_count(conn, "exam_access_requests", company_id, "status = 'PENDING'"),
    }


def list_companies(conn) -> list[dict]:
    if not table_exists(conn, "companies"):
        return [default_company_record(conn)]

    has_ar = table_exists(conn, "exam_access_requests")
    has_pu = table_exists(conn, "platform_users")
    has_students = table_exists(conn, "students")
    has_exams = table_exists(conn, "exams")
    has_sessions = table_exists(conn, "exam_sessions")
    has_violations = table_exists(conn, "violation_logs")

    def sub(cond: str, expr: str) -> str:
        return expr if cond else "0"

    sql = f"""SELECT
                c.id, c.code, c.name, c.contact_name, c.contact_email, c.status, c.notes,
                c.created_at, c.updated_at,
                {sub(has_pu, "(SELECT COUNT(*) FROM platform_users u WHERE u.company_id = c.id AND u.role = 'ADMIN')")} AS admin_count,
                {sub(has_pu, "(SELECT COUNT(*) FROM platform_users u WHERE u.company_id = c.id AND u.role = 'PROCTOR')")} AS proctor_count,
                {sub(has_pu, "(SELECT COUNT(*) FROM platform_users u WHERE u.company_id = c.id AND u.role = 'STUDENT')")} AS user_student_count,
                {sub(has_students, "(SELECT COUNT(*) FROM students s WHERE s.company_id = c.id)")} AS student_count,
                {sub(has_exams, "(SELECT COUNT(*) FROM exams e WHERE e.company_id = c.id)")} AS exam_count,
                {sub(has_sessions, "(SELECT COUNT(*) FROM exam_sessions es WHERE es.company_id = c.id AND es.status = 'IN_PROGRESS')")} AS live_session_count,
                {sub(has_violations, "(SELECT COUNT(*) FROM violation_logs vl WHERE vl.company_id = c.id)")} AS violation_count,
                {sub(has_ar, "(SELECT COUNT(*) FROM exam_access_requests ar WHERE ar.company_id = c.id AND ar.status = 'PENDING')")} AS pending_request_count
            FROM companies c
            ORDER BY c.name ASC"""
    rows = q(conn, sql)
    if not rows:
        return [default_company_record(conn)]

    return [{
        "id": int(row["id"]),
        "code": str(row["code"]),
        "name": str(row["name"]),
        "contactName": str(row["contact_name"]) if row.get("contact_name") is not None else None,
        "contactEmail": str(row["contact_email"]) if row.get("contact_email") is not None else None,
        "status": str(row["status"]),
        "notes": str(row["notes"]) if row.get("notes") is not None else None,
        "createdAt": (dt_ms(row.get("created_at")) or 0),
        "updatedAt": (dt_ms(row.get("updated_at")) or 0),
        "adminCount": int(row["admin_count"]),
        "proctorCount": int(row["proctor_count"]),
        "userStudentCount": int(row["user_student_count"]),
        "studentCount": int(row["student_count"]),
        "examCount": int(row["exam_count"]),
        "liveSessionCount": int(row["live_session_count"]),
        "violationCount": int(row["violation_count"]),
        "pendingRequestCount": int(row["pending_request_count"]),
    } for row in rows]


@router.get("/companies.php")
def get_companies(request: Request):
    with db() as conn:
        require_role(request, ["SUPER_ADMIN"])
        return {"companies": list_companies(conn)}


@router.post("/companies.php")
async def post_companies(request: Request):
    from fastapi.responses import JSONResponse
    payload = await json_input(request)
    with db() as conn:
        require_role(request, ["SUPER_ADMIN"], payload)
        if not table_exists(conn, "companies"):
            raise ApiError({"error": "Company directory storage is unavailable on this database. Apply the latest schema and try again."}, 503)

        action = str(payload.get("action") or "CREATE").strip().upper()
        actor_id = get_actor_id(request, payload)

        if action == "CREATE":
            company = normalize_company_payload(payload)
            if company["name"] == "" or company["code"] == "":
                raise ApiError({"error": "Company name and code are required."}, 400)
            if company["status"] not in ("ACTIVE", "INACTIVE"):
                company["status"] = "ACTIVE"

            execute(conn, """INSERT INTO companies (code, name, contact_name, contact_email, status, notes)
                             VALUES (%s, %s, %s, %s, %s, %s)""",
                    (company["code"], company["name"],
                     company["contactName"] or None, company["contactEmail"] or None,
                     company["status"], company["notes"] or None))
            new_id = last_insert_id(conn)

            audit_log(conn, request, {
                "companyId": 1, "actorRole": "SUPER_ADMIN", "actorId": actor_id,
                "action": "COMPANY_CREATE", "targetType": "company", "targetId": str(new_id),
                "message": f"Created company {company['name']}", "metadata": {"code": company["code"]},
            })

            created = next((c for c in list_companies(conn) if c["id"] == new_id), None)
            return JSONResponse({"ok": True, "company": created}, status_code=201)

        if action == "UPDATE":
            company_id = php_int(payload.get("companyId"))
            if company_id <= 0:
                raise ApiError({"error": "companyId is required."}, 400)
            company = normalize_company_payload(payload)
            if company["name"] == "" or company["code"] == "":
                raise ApiError({"error": "Company name and code are required."}, 400)
            if company["status"] not in ("ACTIVE", "INACTIVE"):
                company["status"] = "ACTIVE"

            execute(conn, """UPDATE companies
                             SET code = %s, name = %s, contact_name = %s, contact_email = %s, status = %s, notes = %s
                             WHERE id = %s LIMIT 1""",
                    (company["code"], company["name"],
                     company["contactName"] or None, company["contactEmail"] or None,
                     company["status"], company["notes"] or None, company_id))

            audit_log(conn, request, {
                "companyId": 1, "actorRole": "SUPER_ADMIN", "actorId": actor_id,
                "action": "COMPANY_UPDATE", "targetType": "company", "targetId": str(company_id),
                "message": f"Updated company {company['name']}",
                "metadata": {"code": company["code"], "status": company["status"]},
            })
            return {"ok": True, "companies": list_companies(conn)}

        raise ApiError({"error": "Invalid action."}, 400)
