"""Python port of api/audit.php — audit-log listing with filters + total count."""

from __future__ import annotations

from fastapi import APIRouter, Request

from .core import db, dt_ms, json_or_none, php_int, q, scalar_int, require_company_id

router = APIRouter()


@router.get("/audit.php")
def list_audit(request: Request):
    with db() as conn:
        company_id = require_company_id(request)
        qp = request.query_params
        actor_role = (qp.get("actorRole") or "").strip() or None
        actor_id = (qp.get("actorId") or "").strip() or None
        action = (qp.get("action") or "").strip() or None
        target_type = (qp.get("targetType") or "").strip() or None
        target_id = (qp.get("targetId") or "").strip() or None
        limit = php_int(qp.get("limit"), 100)
        offset = php_int(qp.get("offset"), 0)

        if limit <= 0:
            limit = 100
        if limit > 500:
            limit = 500
        if offset < 0:
            offset = 0

        filters: list[tuple[str, object]] = []
        if actor_role:
            filters.append(("actor_role = %s", actor_role))
        if actor_id:
            filters.append(("actor_id = %s", actor_id))
        if action:
            filters.append(("action = %s", action))
        if target_type:
            filters.append(("target_type = %s", target_type))
        if target_id:
            filters.append(("target_id = %s", target_id))

        where_sql = "".join(f" AND {clause}" for clause, _ in filters)
        filter_params = [val for _, val in filters]

        total = scalar_int(conn, "SELECT COUNT(*) AS total FROM audit_logs WHERE company_id = %s" + where_sql,
                           [company_id] + filter_params)

        sql = ("""SELECT id, actor_role, actor_id, action, target_type, target_id, message, metadata, ip_address, user_agent, created_at
                  FROM audit_logs
                  WHERE company_id = %s""" + where_sql +
               " ORDER BY created_at DESC, id DESC LIMIT %s OFFSET %s")
        rows = q(conn, sql, [company_id] + filter_params + [limit, offset])

        logs = []
        for row in rows:
            metadata = json_or_none(row.get("metadata")) if row.get("metadata") else None
            logs.append({
                "id": int(row["id"]),
                "actorRole": row["actor_role"],
                "actorId": row["actor_id"],
                "action": row["action"],
                "targetType": row["target_type"],
                "targetId": row["target_id"],
                "message": row["message"],
                "metadata": metadata,
                "ipAddress": row["ip_address"],
                "userAgent": row["user_agent"],
                "createdAt": dt_ms(row.get("created_at")) or 0,
            })

        return {"logs": logs, "total": total}
