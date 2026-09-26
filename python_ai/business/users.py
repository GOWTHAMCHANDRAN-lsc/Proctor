"""Python port of api/users.php — platform user directory (roles, invites, status)."""

from __future__ import annotations

import html
import re
import zlib

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from .core import (
    ApiError, ENV, audit_log, column_exists, db, dt_ms, execute, get_actor_id,
    json_input, last_insert_id, php_int, q, q1, require_company_id, require_role,
    table_exists,
)
from .notify import smtp_send, _valid_email

router = APIRouter()

DIRECTORY_ROLES = ("SUPER_ADMIN", "ADMIN", "PROCTOR", "STUDENT")


def request_company_filter(request: Request, payload: dict | None = None):
    if "companyId" in request.query_params:
        value = php_int(request.query_params["companyId"])
        return value if value > 0 else None
    if payload and "companyId" in payload:
        value = php_int(payload["companyId"])
        return value if value > 0 else None
    return None


def can_manage_directory_role(actor_role: str, target_role: str) -> bool:
    if actor_role == "SUPER_ADMIN":
        return target_role in ("SUPER_ADMIN", "ADMIN", "PROCTOR", "STUDENT")
    if actor_role == "ADMIN":
        return target_role in ("PROCTOR", "STUDENT")
    return False


def fetch_legacy_student_directory_users(conn, filter_company_id, search: str) -> list[dict]:
    if not table_exists(conn, "students"):
        return []
    has_companies = table_exists(conn, "companies")
    has_created = column_exists(conn, "students", "created_at")
    has_company_col = column_exists(conn, "students", "company_id")

    company_expr = "s.company_id" if has_company_col else "1 AS company_id"
    company_name_expr = "c.name AS company_name" if (has_companies and has_company_col) else "NULL AS company_name"
    created_expr = "s.created_at" if has_created else "NOW() AS created_at"
    updated_expr = "s.created_at" if has_created else "NOW() AS updated_at"
    join = "LEFT JOIN companies c ON c.id = s.company_id" if (has_companies and has_company_col) else ""

    sql = f"""SELECT s.id, {company_expr}, {company_name_expr}, s.full_name, s.email,
                     s.registration_id, {created_expr}, {updated_expr}
              FROM students s {join} WHERE 1 = 1"""
    params: list = []
    if filter_company_id is not None and has_company_col:
        sql += " AND s.company_id = %s"
        params.append(filter_company_id)
    if search != "":
        like = f"%{search}%"
        sql += " AND (s.full_name LIKE %s OR s.email LIKE %s OR COALESCE(s.registration_id, '') LIKE %s)"
        params.extend([like, like, like])
    sql += " ORDER BY s.full_name ASC"

    rows = q(conn, sql, params)
    return [{
        "id": zlib.crc32(str(row["id"]).encode("utf-8")),
        "companyId": int(row["company_id"]) if row.get("company_id") is not None else None,
        "companyName": str(row["company_name"]) if row.get("company_name") is not None else None,
        "role": "STUDENT",
        "fullName": str(row["full_name"]),
        "email": str(row["email"]),
        "status": "ACTIVE",
        "registrationId": str(row["registration_id"]) if row.get("registration_id") is not None else None,
        "externalAuthId": None,
        "notes": "Legacy student directory record",
        "createdAt": dt_ms(row.get("created_at")) or 0,
        "updatedAt": dt_ms(row.get("updated_at")) or 0,
    } for row in rows]


def ensure_student_directory_sync(conn, company_id: int, record: dict) -> None:
    import hashlib
    email = str(record.get("email") or "").strip()
    full_name = str(record.get("fullName") or "").strip()
    registration_id = str(record.get("registrationId") or "").strip()
    if email == "" or full_name == "" or registration_id == "":
        return
    existing = q1(conn, "SELECT id FROM students WHERE company_id = %s AND (email = %s OR registration_id = %s) LIMIT 1",
                  (company_id, email, registration_id))
    if existing:
        execute(conn, "UPDATE students SET full_name = %s, email = %s, registration_id = %s WHERE id = %s AND company_id = %s",
                (full_name, email, registration_id, str(existing["id"]), company_id))
        return
    student_id = hashlib.sha256(f"{company_id}|{email}|{registration_id}".encode("utf-8")).hexdigest()[:16]
    execute(conn, "INSERT INTO students (id, company_id, full_name, email, registration_id) VALUES (%s, %s, %s, %s, %s)",
            (student_id, company_id, full_name, email, registration_id))


def fetch_directory_users(conn, actor_role: str, actor_company_id, filter_company_id, filter_role, search: str) -> list[dict]:
    if not table_exists(conn, "platform_users"):
        if filter_role is not None and filter_role != "STUDENT":
            return []
        return fetch_legacy_student_directory_users(conn, filter_company_id, search)

    has_companies = table_exists(conn, "companies")
    has_reg = column_exists(conn, "platform_users", "registration_id")
    has_ext = column_exists(conn, "platform_users", "external_auth_id")
    has_notes = column_exists(conn, "platform_users", "notes")

    company_name_expr = "c.name AS company_name" if has_companies else "NULL AS company_name"
    reg_expr = "u.registration_id" if has_reg else "NULL AS registration_id"
    ext_expr = "u.external_auth_id" if has_ext else "NULL AS external_auth_id"
    notes_expr = "u.notes" if has_notes else "NULL AS notes"
    join = "LEFT JOIN companies c ON c.id = u.company_id" if has_companies else ""

    sql = f"""SELECT u.id, u.company_id, {company_name_expr}, u.role, u.full_name, u.email, u.status,
                     {reg_expr}, {ext_expr}, {notes_expr}, u.created_at, u.updated_at
              FROM platform_users u {join} WHERE 1 = 1"""
    params: list = []
    if actor_role != "SUPER_ADMIN":
        sql += " AND u.company_id = %s AND u.role IN ('PROCTOR','STUDENT')"
        params.append(actor_company_id)
    elif filter_company_id is not None:
        sql += " AND u.company_id = %s"
        params.append(filter_company_id)
    if filter_role is not None:
        sql += " AND u.role = %s"
        params.append(filter_role)
    if search != "":
        like = f"%{search}%"
        sql += " AND (u.full_name LIKE %s OR u.email LIKE %s OR COALESCE(u.registration_id, '') LIKE %s OR COALESCE(c.name, '') LIKE %s)"
        params.extend([like, like, like, like])
    sql += """ ORDER BY CASE u.role WHEN 'SUPER_ADMIN' THEN 1 WHEN 'ADMIN' THEN 2 WHEN 'PROCTOR' THEN 3 ELSE 4 END,
               u.full_name ASC"""

    rows = q(conn, sql, params)
    return [{
        "id": int(row["id"]),
        "companyId": int(row["company_id"]) if row.get("company_id") is not None else None,
        "companyName": str(row["company_name"]) if row.get("company_name") is not None else None,
        "role": str(row["role"]),
        "fullName": str(row["full_name"]),
        "email": str(row["email"]),
        "status": str(row["status"]),
        "registrationId": str(row["registration_id"]) if row.get("registration_id") is not None else None,
        "externalAuthId": str(row["external_auth_id"]) if row.get("external_auth_id") is not None else None,
        "notes": str(row["notes"]) if row.get("notes") is not None else None,
        "createdAt": dt_ms(row.get("created_at")) or 0,
        "updatedAt": dt_ms(row.get("updated_at")) or 0,
    } for row in rows]


@router.get("/users.php")
def get_users(request: Request):
    with db() as conn:
        actor_role = require_role(request, ["SUPER_ADMIN", "ADMIN"])
        actor_company_id = None if actor_role == "SUPER_ADMIN" else require_company_id(request)
        filter_company_id = request_company_filter(request) if actor_role == "SUPER_ADMIN" else actor_company_id
        filter_role = str(request.query_params.get("role") or "").strip().upper()
        if filter_role not in DIRECTORY_ROLES:
            filter_role = ""
        search = str(request.query_params.get("q") or "").strip()
        return {"users": fetch_directory_users(conn, actor_role, actor_company_id, filter_company_id,
                                               filter_role or None, search)}


@router.post("/users.php")
async def post_users(request: Request):
    payload = await json_input(request)
    with db() as conn:
        actor_role = require_role(request, ["SUPER_ADMIN", "ADMIN"], payload)
        actor_id = get_actor_id(request, payload)
        action = str(payload.get("action") or "CREATE").strip().upper()

        if not table_exists(conn, "platform_users"):
            raise ApiError({"error": "User directory storage is unavailable on this database. Apply the latest schema and try again."}, 503)

        if action in ("CREATE", "UPDATE"):
            target_role = str(payload.get("role") or "").strip().upper()
            if not can_manage_directory_role(actor_role, target_role):
                raise ApiError({"error": "You cannot manage this role."}, 403)

            company_id = request_company_filter(request, payload) if actor_role == "SUPER_ADMIN" else require_company_id(request, payload)
            if target_role != "SUPER_ADMIN" and (company_id is None or company_id <= 0):
                raise ApiError({"error": "companyId is required for this role."}, 400)
            if actor_role != "SUPER_ADMIN" and company_id != require_company_id(request, payload):
                raise ApiError({"error": "Company scope mismatch."}, 403)

            full_name = str(payload.get("fullName") or "").strip()
            email = str(payload.get("email") or "").strip().lower()
            status = str(payload.get("status") or "ACTIVE").strip().upper()
            notes = str(payload.get("notes") or "").strip()
            registration_id = str(payload.get("registrationId") or "").strip()
            if registration_id == "" and target_role == "STUDENT":
                seed = re.sub(r"[^A-Za-z0-9]+", "", (email.split("@", 1)[0] or "student")) or "STUDENT"
                registration_id = seed.upper()[:24]

            if full_name == "" or email == "":
                raise ApiError({"error": "fullName and email are required."}, 400)
            if not _valid_email(email):
                raise ApiError({"error": "Valid email is required."}, 400)
            if status not in ("ACTIVE", "INVITED", "DISABLED"):
                status = "ACTIVE"

            send_invite = action == "CREATE" and status in ("ACTIVE", "INVITED")

            if action == "CREATE":
                execute(conn, """INSERT INTO platform_users
                    (company_id, role, full_name, email, status, registration_id, notes)
                    VALUES (%s, %s, %s, %s, %s, %s, %s)""",
                        (None if target_role == "SUPER_ADMIN" else company_id, target_role, full_name, email,
                         status, registration_id or None, notes or None))
                user_id = last_insert_id(conn)
            else:
                send_invite = False
                user_id = php_int(payload.get("userId"))
                if user_id <= 0:
                    raise ApiError({"error": "userId is required."}, 400)
                existing = q1(conn, "SELECT company_id, role FROM platform_users WHERE id = %s LIMIT 1", (user_id,))
                if not existing:
                    raise ApiError({"error": "User not found."}, 404)
                if actor_role != "SUPER_ADMIN" and int(existing.get("company_id") or 0) != require_company_id(request, payload):
                    raise ApiError({"error": "Forbidden for this company."}, 403)
                execute(conn, """UPDATE platform_users
                                 SET company_id = %s, role = %s, full_name = %s, email = %s, status = %s, registration_id = %s, notes = %s
                                 WHERE id = %s LIMIT 1""",
                        (None if target_role == "SUPER_ADMIN" else company_id, target_role, full_name, email,
                         status, registration_id or None, notes or None, user_id))

            if target_role == "STUDENT" and company_id is not None and company_id > 0:
                ensure_student_directory_sync(conn, company_id, {
                    "fullName": full_name, "email": email, "registrationId": registration_id,
                })

            audit_log(conn, request, {
                "companyId": company_id if company_id is not None else 1,
                "actorRole": actor_role, "actorId": actor_id,
                "action": "USER_CREATE" if action == "CREATE" else "USER_UPDATE",
                "targetType": "platform_user", "targetId": str(user_id),
                "message": ("Created" if action == "CREATE" else "Updated") + f" {target_role} user {email}",
                "metadata": {"role": target_role, "companyId": company_id, "status": status},
            })

            email_warning = None
            if send_invite:
                email_warning = _send_invite_email(conn, company_id, target_role, full_name, email, registration_id)

            actor_company_id = None if actor_role == "SUPER_ADMIN" else require_company_id(request, payload)
            filter_company_id = request_company_filter(request, payload) if actor_role == "SUPER_ADMIN" else actor_company_id
            resp = {"ok": True, "users": fetch_directory_users(conn, actor_role, actor_company_id, filter_company_id, None, "")}
            if email_warning is not None:
                resp["emailWarning"] = email_warning
            return JSONResponse(resp, status_code=201 if action == "CREATE" else 200)

        if action == "STATUS":
            user_id = php_int(payload.get("userId"))
            status = str(payload.get("status") or "").strip().upper()
            if user_id <= 0 or status not in ("ACTIVE", "INVITED", "DISABLED"):
                raise ApiError({"error": "userId and valid status are required."}, 400)
            existing = q1(conn, "SELECT company_id, role, email FROM platform_users WHERE id = %s LIMIT 1", (user_id,))
            if not existing:
                raise ApiError({"error": "User not found."}, 404)
            if not can_manage_directory_role(actor_role, str(existing["role"])):
                raise ApiError({"error": "You cannot manage this role."}, 403)
            if actor_role != "SUPER_ADMIN" and int(existing.get("company_id") or 0) != require_company_id(request, payload):
                raise ApiError({"error": "Forbidden for this company."}, 403)

            execute(conn, "UPDATE platform_users SET status = %s WHERE id = %s LIMIT 1", (status, user_id))

            audit_log(conn, request, {
                "companyId": int(existing.get("company_id") or 1) or 1,
                "actorRole": actor_role, "actorId": actor_id,
                "action": "USER_STATUS_UPDATE", "targetType": "platform_user", "targetId": str(user_id),
                "message": f"Updated user status to {status}",
                "metadata": {"email": str(existing["email"]), "role": str(existing["role"])},
            })

            actor_company_id = None if actor_role == "SUPER_ADMIN" else require_company_id(request, payload)
            filter_company_id = request_company_filter(request, payload) if actor_role == "SUPER_ADMIN" else actor_company_id
            return {"ok": True, "users": fetch_directory_users(conn, actor_role, actor_company_id, filter_company_id, None, "")}

        raise ApiError({"error": "Invalid action."}, 400)


def _send_invite_email(conn, company_id, target_role: str, full_name: str, email: str, registration_id: str):
    company_name = "LSC Proctor"
    target_company_id = 1 if target_role == "SUPER_ADMIN" else company_id
    if target_company_id is not None and target_company_id > 0:
        row = q1(conn, "SELECT name FROM companies WHERE id = %s LIMIT 1", (target_company_id,))
        if row:
            company_name = str(row["name"])

    role_label = target_role.lower().replace("_", " ")
    reg_display = registration_id if registration_id != "" else "N/A"
    subject = f"Your {company_name} account has been created"
    safe_name = html.escape(full_name, quote=True)
    safe_role = html.escape(role_label.title(), quote=True)
    safe_company = html.escape(company_name, quote=True)
    safe_email = html.escape(email, quote=True)
    safe_reg = html.escape(reg_display, quote=True)
    body = (
        f"<!doctype html><html><head><meta charset=\"utf-8\"><title>{subject}</title></head>"
        "<body style=\"margin:0;padding:24px;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;font-size:14px;line-height:1.6;color:#0f172a;background-color:#f8fafc;\">"
        "<div style=\"max-width:600px;margin:0 auto;background:#ffffff;border-radius:12px;border:1px solid #e2e8f0;padding:32px;\">"
        f"<h2 style=\"margin:0 0 16px;font-size:20px;color:#1e293b;\">Welcome to {safe_company}</h2>"
        f"<p style=\"margin:0 0 12px;\">Hello <strong>{safe_name}</strong>,</p>"
        f"<p style=\"margin:0 0 16px;\">Your <strong>{safe_role}</strong> account on the <strong>{safe_company}</strong> platform has been created.</p>"
        "<table style=\"width:100%;border-collapse:collapse;margin:0 0 20px;font-size:13px;\">"
        f"<tr><td style=\"padding:8px 12px;background:#f1f5f9;border-radius:6px 6px 0 0;font-weight:600;color:#475569;\">Email</td><td style=\"padding:8px 12px;background:#f8fafc;border-radius:0 0 0 0;\">{safe_email}</td></tr>"
        f"<tr><td style=\"padding:8px 12px;background:#f1f5f9;font-weight:600;color:#475569;\">Role</td><td style=\"padding:8px 12px;background:#ffffff;\">{safe_role}</td></tr>"
        f"<tr><td style=\"padding:8px 12px;background:#f1f5f9;border-radius:0 0 6px 6px;font-weight:600;color:#475569;\">Registration ID</td><td style=\"padding:8px 12px;background:#f8fafc;border-radius:0 0 6px 0;\">{safe_reg}</td></tr>"
        "</table>"
        "<p style=\"margin:0 0 8px;\">Please log in to the platform using your email address.</p>"
        f"<p style=\"margin:0;color:#64748b;font-size:12px;\">This is an automated message from {safe_company} ProctorGuard.</p>"
        "</div></body></html>"
    )

    host = ENV.get("SMTP_HOST", "")
    port = php_int(ENV.get("SMTP_PORT", "0"))
    user = ENV.get("SMTP_USER", "")
    password = ENV.get("SMTP_PASS", "")
    sender = ENV.get("SMTP_FROM", "")
    secure_mode = ENV.get("SMTP_SECURE", "")
    timeout = php_int(ENV.get("SMTP_TIMEOUT", "15"))
    allow_self_signed = ENV.get("SMTP_ALLOW_SELF_SIGNED", "0") == "1"

    if host != "" and port > 0 and sender != "":
        result = smtp_send(host, port, user, password, sender,
                           {"to": email, "subject": subject, "body": body, "fromName": company_name + " ProctorGuard"},
                           secure_mode, timeout, allow_self_signed)
        execute(conn, "INSERT INTO delivery_logs (company_id, channel, recipient, subject, body, status, error) VALUES (%s, %s, %s, %s, %s, %s, %s)",
                (company_id if company_id is not None else 1, "EMAIL", email, subject, body,
                 "SENT" if result.get("ok") else "FAILED",
                 None if result.get("ok") else (result.get("error") or "Send failed")))
        if not result.get("ok"):
            return "User created but invite email could not be sent: " + (result.get("error") or "Unknown error")
    return None
