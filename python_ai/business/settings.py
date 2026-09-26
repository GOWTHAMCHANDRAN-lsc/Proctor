"""Python port of api/settings.php — company-scoped application settings (one JSON blob per company)."""

from __future__ import annotations

import json

from fastapi import APIRouter, Request

from .core import (
    ApiError, audit_log, db, execute, get_actor_id, json_input, q1,
    require_company_id, require_role,
)

router = APIRouter()


def ensure_settings_schema(conn) -> None:
    execute(conn, """CREATE TABLE IF NOT EXISTS app_settings (
        company_id    INT UNSIGNED NOT NULL PRIMARY KEY,
        settings_json LONGTEXT NOT NULL,
        updated_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci""")


def read_settings(conn, company_id: int):
    row = q1(conn, "SELECT settings_json FROM app_settings WHERE company_id = %s LIMIT 1", (company_id,))
    if not row or row.get("settings_json") is None:
        return None
    try:
        decoded = json.loads(row["settings_json"])
    except (ValueError, TypeError):
        return None
    return decoded if isinstance(decoded, dict) else None


@router.get("/settings.php")
def get_settings(request: Request):
    with db() as conn:
        ensure_settings_schema(conn)
        company_id = require_company_id(request)
        return {"settings": read_settings(conn, company_id)}


@router.post("/settings.php")
async def post_settings(request: Request):
    payload = await json_input(request)
    with db() as conn:
        ensure_settings_schema(conn)
        require_role(request, ["ADMIN"], payload)
        company_id = require_company_id(request, payload)

        # Accept either { settings: {...} } or a bare settings object.
        settings = payload.get("settings") if isinstance(payload.get("settings"), dict) else payload
        if not isinstance(settings, dict) or len(settings) == 0:
            raise ApiError({"error": "No settings provided."}, 400)
        settings = {k: v for k, v in settings.items()
                    if k not in ("actorId", "actorRole", "companyId", "action")}

        try:
            encoded = json.dumps(settings, ensure_ascii=False)
        except (ValueError, TypeError):
            raise ApiError({"error": "Settings could not be encoded."}, 400)
        # Guard against oversized payloads (e.g. very large embedded logo data URLs).
        if len(encoded.encode("utf-8")) > 2 * 1024 * 1024:
            raise ApiError({"error": "Settings payload is too large. Use a smaller logo."}, 413)

        execute(conn, """INSERT INTO app_settings (company_id, settings_json)
                         VALUES (%s, %s)
                         ON DUPLICATE KEY UPDATE settings_json = VALUES(settings_json)""",
                (company_id, encoded))

        audit_log(conn, request, {
            "companyId": company_id,
            "actorRole": "ADMIN",
            "actorId": get_actor_id(request, payload),
            "action": "SETTINGS_UPDATE",
            "targetType": "settings",
            "targetId": str(company_id),
            "message": "Workspace settings updated",
        })

        return {"ok": True, "settings": read_settings(conn, company_id)}
