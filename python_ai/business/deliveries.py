"""Python port of api/deliveries.php — notification delivery log listing."""

from __future__ import annotations

from fastapi import APIRouter, Request

from .core import db, dt_ms, json_or_none, php_int, q, require_company_id

router = APIRouter()


@router.get("/deliveries.php")
def list_deliveries(request: Request):
    with db() as conn:
        company_id = require_company_id(request)

        channel = (request.query_params.get("channel") or "").strip().upper() or None
        status = (request.query_params.get("status") or "").strip().upper() or None
        limit = php_int(request.query_params.get("limit"), 100)
        offset = php_int(request.query_params.get("offset"), 0)

        if channel not in ("EMAIL", "SMS"):
            channel = None
        if status not in ("SENT", "FAILED", "SKIPPED"):
            status = None
        if limit <= 0:
            limit = 100
        if limit > 500:
            limit = 500
        if offset < 0:
            offset = 0

        sql = """SELECT id, channel, recipient, subject, body, status, error, template_id, metadata, created_at
                 FROM delivery_logs
                 WHERE company_id = %s"""
        params: list = [company_id]
        if channel is not None:
            sql += " AND channel = %s"
            params.append(channel)
        if status is not None:
            sql += " AND status = %s"
            params.append(status)
        sql += " ORDER BY created_at DESC, id DESC LIMIT %s OFFSET %s"
        params.extend([limit, offset])

        rows = q(conn, sql, params)

        logs = []
        for row in rows:
            metadata = json_or_none(row.get("metadata")) if row.get("metadata") else None
            logs.append({
                "id": int(row["id"]),
                "channel": row["channel"],
                "recipient": row["recipient"],
                "subject": row["subject"],
                "body": row["body"],
                "status": row["status"],
                "error": row["error"],
                "templateId": int(row["template_id"]) if row.get("template_id") is not None else None,
                "metadata": metadata,
                "createdAt": dt_ms(row.get("created_at")) or 0,
            })

        return {"logs": logs}
