"""Python port of api/templates.php — notification template CRUD."""

from __future__ import annotations

from fastapi import APIRouter, Request

from .core import (
    ApiError, audit_log, db, dt_ms, execute, json_input, last_insert_id,
    php_int, q, require_company_id, require_role,
)

router = APIRouter()


def _delete_template(conn, request: Request, company_id: int, payload: dict) -> dict:
    tid = php_int(payload.get("id"))
    if tid <= 0:
        raise ApiError({"error": "Template id required."}, 400)
    execute(conn, "DELETE FROM notification_templates WHERE company_id = %s AND id = %s", (company_id, tid))
    audit_log(conn, request, {
        "companyId": company_id,
        "actorRole": "ADMIN",
        "actorId": payload.get("actor"),
        "action": "TEMPLATE_DELETE",
        "targetType": "template",
        "targetId": str(tid),
        "message": "Template deleted",
    })
    return {"ok": True}


@router.get("/templates.php")
def list_templates(request: Request):
    with db() as conn:
        company_id = require_company_id(request)
        channel = (request.query_params.get("channel") or "").strip().upper() or None
        if channel is not None and channel not in ("EMAIL", "SMS"):
            channel = None

        sql = """SELECT id, name, channel, subject, body, is_default, created_at, updated_at
                 FROM notification_templates
                 WHERE company_id = %s"""
        params: list = [company_id]
        if channel is not None:
            sql += " AND channel = %s"
            params.append(channel)
        sql += " ORDER BY updated_at DESC, id DESC"

        rows = q(conn, sql, params)
        templates = [{
            "id": int(row["id"]),
            "name": row["name"],
            "channel": row["channel"],
            "subject": row["subject"],
            "body": row["body"],
            "isDefault": bool(row["is_default"]),
            "createdAt": dt_ms(row.get("created_at")) or 0,
            "updatedAt": dt_ms(row.get("updated_at")) or 0,
        } for row in rows]
        return {"templates": templates}


@router.post("/templates.php")
async def save_template(request: Request):
    payload = await json_input(request)
    with db() as conn:
        require_role(request, ["ADMIN"], payload)
        company_id = require_company_id(request, payload)

        if str(payload.get("action") or "").upper() == "DELETE":
            return _delete_template(conn, request, company_id, payload)

        template = payload.get("template") if isinstance(payload.get("template"), dict) else payload
        if not isinstance(template, dict):
            raise ApiError({"error": "Invalid template payload."}, 400)

        tid = php_int(template.get("id"))
        name = str(template.get("name") or "").strip()
        channel = str(template.get("channel") or "EMAIL").strip().upper()
        subject = str(template["subject"]).strip() if template.get("subject") is not None else None
        body = str(template.get("body") or "").strip()
        is_default = 1 if template.get("isDefault") else 0

        if name == "" or body == "":
            raise ApiError({"error": "Template name and body are required."}, 400)
        if channel not in ("EMAIL", "SMS"):
            channel = "EMAIL"
        if channel == "SMS":
            subject = None

        if is_default == 1:
            execute(conn, "UPDATE notification_templates SET is_default = 0 WHERE company_id = %s AND channel = %s",
                    (company_id, channel))

        if tid > 0:
            execute(conn, """UPDATE notification_templates
                             SET name = %s, channel = %s, subject = %s, body = %s, is_default = %s
                             WHERE company_id = %s AND id = %s""",
                    (name, channel, subject, body, is_default, company_id, tid))
        else:
            execute(conn, """INSERT INTO notification_templates (company_id, name, channel, subject, body, is_default)
                             VALUES (%s, %s, %s, %s, %s, %s)""",
                    (company_id, name, channel, subject, body, is_default))
            tid = last_insert_id(conn)

        audit_log(conn, request, {
            "companyId": company_id,
            "actorRole": "ADMIN",
            "actorId": template.get("actor"),
            "action": "TEMPLATE_SAVE",
            "targetType": "template",
            "targetId": str(tid) if tid > 0 else None,
            "message": f"Template saved: {name}",
            "metadata": {"channel": channel, "isDefault": bool(is_default)},
        })
        return {"ok": True}


@router.delete("/templates.php")
async def delete_template(request: Request):
    payload = await json_input(request)
    with db() as conn:
        require_role(request, ["ADMIN"], payload)
        company_id = require_company_id(request, payload)
        return _delete_template(conn, request, company_id, payload)
