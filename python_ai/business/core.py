"""
Shared infrastructure for the ProctorGuard business API (Python port of api/_bootstrap.php).

Every endpoint keeps the exact request/response contract of its PHP predecessor:
same paths (/users.php, ...), same headers (X-Company-Id, X-User-Role, X-Actor-Id),
same JSON shapes and status codes — so the built frontend needs no changes.
"""

from __future__ import annotations

import contextlib
import datetime as _dt
import json
import math
import re
import threading
import time
from pathlib import Path
from typing import Any, Iterator, Optional

import pymysql
import pymysql.cursors
from fastapi import Request
from fastapi.responses import JSONResponse

ENV_PATH = Path(__file__).resolve().parent.parent.parent / ".env"

_ALLOWED_ROLES = ("ADMIN", "SUPER_ADMIN", "PROCTOR", "STUDENT", "SYSTEM")


def load_env() -> dict[str, str]:
    env: dict[str, str] = {}
    try:
        for line in ENV_PATH.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            value = value.strip()
            if len(value) >= 2 and value[0] == '"' and value[-1] == '"':
                value = value[1:-1]
            env[key.strip()] = value
    except OSError:
        pass
    return env


ENV = load_env()


class ApiError(Exception):
    """Mirror of PHP json_response(error, status) early-exit."""

    def __init__(self, payload: dict, status: int = 400):
        self.payload = payload
        self.status = status
        super().__init__(str(payload))


def api_error_response(exc: ApiError) -> JSONResponse:
    return JSONResponse(exc.payload, status_code=exc.status)


# ── Database ──────────────────────────────────────────────────────────────────

def _decimal_to_float(value: Any) -> float:
    return float(value)


@contextlib.contextmanager
def db() -> Iterator[pymysql.connections.Connection]:
    conn = pymysql.connect(
        host=ENV.get("MYSQL_HOST", "127.0.0.1"),
        port=int(ENV.get("MYSQL_PORT", "3306")),
        user=ENV.get("MYSQL_USER", "root"),
        password=ENV.get("MYSQL_PASSWORD", ""),
        database=ENV.get("MYSQL_DATABASE", "proctorguard"),
        charset="utf8mb4",
        autocommit=True,
        cursorclass=pymysql.cursors.DictCursor,
    )
    try:
        with conn.cursor() as cur:
            cur.execute("SET NAMES utf8mb4 COLLATE utf8mb4_general_ci")
        yield conn
    finally:
        conn.close()


def q(conn, sql: str, params: tuple | list = ()) -> list[dict]:
    with conn.cursor() as cur:
        cur.execute(sql, params or None)
        return list(cur.fetchall())


def q1(conn, sql: str, params: tuple | list = ()) -> Optional[dict]:
    rows = q(conn, sql, params)
    return rows[0] if rows else None


def execute(conn, sql: str, params: tuple | list = ()) -> int:
    with conn.cursor() as cur:
        cur.execute(sql, params or None)
        return cur.rowcount


def last_insert_id(conn) -> int:
    row = q1(conn, "SELECT LAST_INSERT_ID() AS id")
    return int(row["id"]) if row else 0


def scalar_int(conn, sql: str, params: tuple | list = ()) -> int:
    with conn.cursor(pymysql.cursors.Cursor) as cur:
        cur.execute(sql, params or None)
        row = cur.fetchone()
        return int(row[0]) if row and row[0] is not None else 0


# ── Schema helpers (ported from _bootstrap.php) ──────────────────────────────

_column_cache: dict[str, bool] = {}
_column_cache_lock = threading.Lock()


def column_exists(conn, table: str, column: str) -> bool:
    key = f"{table}.{column}"
    with _column_cache_lock:
        if key in _column_cache:
            return _column_cache[key]
    try:
        exists = bool(q(conn, f"SHOW COLUMNS FROM {table} LIKE %s", (column,)))
    except Exception:
        return False
    with _column_cache_lock:
        _column_cache[key] = exists
    return exists


def table_exists(conn, table: str) -> bool:
    try:
        return bool(q(conn, "SHOW TABLES LIKE %s", (table,)))
    except Exception:
        return False


def add_column_if_missing(conn, table: str, column: str, definition: str) -> None:
    try:
        if not column_exists(conn, table, column):
            execute(conn, f"ALTER TABLE {table} ADD COLUMN {column} {definition}")
            with _column_cache_lock:
                _column_cache[f"{table}.{column}"] = True
    except Exception:
        pass  # best-effort runtime migration, same as PHP


# ── Request helpers ───────────────────────────────────────────────────────────

async def json_input(request: Request) -> dict:
    raw = await request.body()
    if not raw or not raw.strip():
        return {}
    try:
        data = json.loads(raw)
    except ValueError:
        raise ApiError({"error": "Invalid JSON payload."}, 400)
    return data if isinstance(data, dict) else {}


def php_int(value, default: int = 0) -> int:
    """PHP-style (int) cast: leading integer of a string, 0 otherwise."""
    if value is None:
        return default
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, (int, float)):
        return int(value)
    m = re.match(r"\s*(-?\d+)", str(value))
    return int(m.group(1)) if m else default


def get_company_id(request: Request, payload: Optional[dict] = None) -> Optional[int]:
    header = request.headers.get("x-company-id", "")
    if header.strip():
        return php_int(header)
    if "companyId" in request.query_params:
        return php_int(request.query_params["companyId"])
    if payload and "companyId" in payload:
        return php_int(payload["companyId"])
    return None


def require_company_id(request: Request, payload: Optional[dict] = None) -> int:
    company_id = get_company_id(request, payload)
    if company_id is None or company_id <= 0:
        raise ApiError({"error": "companyId is required."}, 400)
    return company_id


def get_actor_role(request: Request, payload: Optional[dict] = None) -> str:
    role = request.headers.get("x-user-role") or (payload or {}).get("actorRole") or "STUDENT"
    role = str(role).strip().upper()
    return role if role in _ALLOWED_ROLES else "STUDENT"


def _role_matches(actual: str, required: str) -> bool:
    return actual == required or (actual == "SUPER_ADMIN" and required == "ADMIN")


def require_role(request: Request, roles: list[str], payload: Optional[dict] = None) -> str:
    role = get_actor_role(request, payload)
    for required in roles:
        if _role_matches(role, str(required).upper()):
            return role
    raise ApiError({"error": "Forbidden for this role."}, 403)


def get_actor_id(request: Request, payload: Optional[dict] = None) -> Optional[str]:
    header = request.headers.get("x-actor-id")
    if header and header.strip():
        return header.strip()
    if payload and str(payload.get("actorId") or "").strip():
        return str(payload["actorId"]).strip()
    return None


def humanize_identifier(value: str) -> str:
    normalized = re.sub(r"[^A-Za-z0-9]+", " ", value).strip()
    if not normalized:
        return "User"
    return " ".join(w.capitalize() for w in normalized.lower().split(" "))


# ── Value conversion (PHP parity) ────────────────────────────────────────────

def dt_ms(value) -> Optional[int]:
    """PHP datetime_to_ms(): DB datetime (assumed UTC) → epoch millis."""
    if value is None:
        return None
    if isinstance(value, _dt.datetime):
        dt = value.replace(tzinfo=_dt.timezone.utc)
        return int(dt.timestamp() * 1000)
    s = str(value)
    try:
        base, frac = (s.split(".", 1) + [""])[:2]
        dt = _dt.datetime.strptime(base, "%Y-%m-%d %H:%M:%S").replace(tzinfo=_dt.timezone.utc)
        ms = int(dt.timestamp() * 1000)
        if frac:
            ms += int((frac + "000")[:3])
        return ms
    except ValueError:
        return None


def now_ms() -> int:
    return int(time.time() * 1000)


def as_int(value, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        try:
            return int(float(value))
        except (TypeError, ValueError):
            return default


def as_float_or_none(value) -> Optional[float]:
    try:
        f = float(value)
        return f if math.isfinite(f) else None
    except (TypeError, ValueError):
        return None


def php_json_normalize(value: Any) -> Any:
    """Mimic PHP json_decode($s, true) + json_encode round-trip: an empty JSON
    object {} becomes an empty array [] (PHP has no distinct empty-object type).
    Non-empty objects keep object shape; applied recursively."""
    if isinstance(value, dict):
        if len(value) == 0:
            return []
        return {k: php_json_normalize(v) for k, v in value.items()}
    if isinstance(value, list):
        return [php_json_normalize(v) for v in value]
    return value


def json_or_none(raw) -> Optional[Any]:
    if raw is None or raw == "":
        return None
    if isinstance(raw, (dict, list)):
        return php_json_normalize(raw)
    try:
        return php_json_normalize(json.loads(raw))
    except (ValueError, TypeError):
        return None


# ── Audit log (best-effort, mirrors PHP audit_log) ───────────────────────────

def audit_log(conn, request: Optional[Request], entry: dict) -> None:
    try:
        company_id = entry.get("companyId")
        if company_id is None and request is not None:
            company_id = get_company_id(request, entry.get("payload"))
        if not company_id or int(company_id) <= 0:
            return
        actor_role = str(entry.get("actorRole") or "SYSTEM").upper()
        if actor_role == "SUPER_ADMIN":
            actor_role = "ADMIN"  # keep compatible with older stored procedures
        metadata = entry.get("metadata")
        metadata_json = None
        if isinstance(metadata, (dict, list)):
            metadata_json = json.dumps(metadata)
        elif isinstance(metadata, str):
            metadata_json = metadata
        ip_address = None
        user_agent = None
        if request is not None:
            ip_address = request.headers.get("x-real-ip") or (request.client.host if request.client else None)
            user_agent = request.headers.get("user-agent")
        with conn.cursor() as cur:
            cur.execute(
                "CALL sp_add_audit(%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)",
                (
                    int(company_id),
                    actor_role,
                    entry.get("actorId"),
                    entry.get("action", "UNKNOWN"),
                    entry.get("targetType"),
                    entry.get("targetId"),
                    entry.get("message"),
                    metadata_json,
                    ip_address,
                    user_agent,
                ),
            )
            while cur.nextset():
                pass
    except Exception:
        pass  # best-effort audit logging; never block the request


# ── Startup schema bootstrap (ported from _bootstrap.php, run once) ──────────

def _seed_super_admin_emails() -> list[str]:
    raw = (ENV.get("SUPER_ADMIN_EMAILS") or ENV.get("VITE_SUPER_ADMIN_EMAILS") or "").strip()
    if not raw:
        return []
    emails = [e.strip().lower() for e in raw.split(",")]
    seen: list[str] = []
    for e in emails:
        if e and "@" in e and e not in seen:
            seen.append(e)
    return seen


def bootstrap_schema() -> None:
    """Idempotent schema/seed bootstrap. Errors are non-fatal, same as PHP."""
    try:
        with db() as conn:
            # audit_logs.actor_role enum upgrade
            try:
                row = q1(conn, "SHOW COLUMNS FROM audit_logs LIKE 'actor_role'")
                col_type = str((row or {}).get("Type", ""))
                if "SUPER_ADMIN" not in col_type.upper():
                    execute(conn, "ALTER TABLE audit_logs MODIFY actor_role ENUM('ADMIN','SUPER_ADMIN','PROCTOR','STUDENT','SYSTEM') NOT NULL DEFAULT 'SYSTEM'")
            except Exception:
                pass
            # companies directory
            try:
                execute(conn, """CREATE TABLE IF NOT EXISTS companies (
                    id            INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
                    code          VARCHAR(64) NOT NULL,
                    name          VARCHAR(255) NOT NULL,
                    contact_name  VARCHAR(255) NULL,
                    contact_email VARCHAR(255) NULL,
                    status        ENUM('ACTIVE','INACTIVE') NOT NULL DEFAULT 'ACTIVE',
                    notes         TEXT NULL,
                    created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    updated_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                    UNIQUE KEY uq_companies_code (code)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci""")
                if scalar_int(conn, "SELECT COUNT(*) FROM companies WHERE id = 1") == 0:
                    execute(conn, """INSERT INTO companies (id, code, name, contact_name, contact_email, status)
                                     VALUES (1, 'default', 'Default Company', 'Platform Admin', NULL, 'ACTIVE')""")
            except Exception:
                pass
            # platform_users
            try:
                execute(conn, """CREATE TABLE IF NOT EXISTS platform_users (
                    id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
                    company_id       INT UNSIGNED NULL,
                    role             ENUM('SUPER_ADMIN','ADMIN','PROCTOR','STUDENT') NOT NULL,
                    full_name        VARCHAR(255) NOT NULL,
                    email            VARCHAR(255) NOT NULL,
                    status           ENUM('ACTIVE','INVITED','DISABLED') NOT NULL DEFAULT 'ACTIVE',
                    registration_id  VARCHAR(128) NULL,
                    external_auth_id VARCHAR(128) NULL,
                    notes            TEXT NULL,
                    created_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    updated_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                    UNIQUE KEY uq_platform_users_email (email),
                    KEY idx_platform_users_company_role (company_id, role),
                    KEY idx_platform_users_status (status)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci""")
                add_column_if_missing(conn, "platform_users", "registration_id", "VARCHAR(128) NULL AFTER status")
                add_column_if_missing(conn, "platform_users", "external_auth_id", "VARCHAR(128) NULL AFTER registration_id")
                add_column_if_missing(conn, "platform_users", "notes", "TEXT NULL AFTER external_auth_id")
                for email in _seed_super_admin_emails():
                    execute(conn, """INSERT INTO platform_users (company_id, role, full_name, email, status)
                                     SELECT NULL, 'SUPER_ADMIN', %s, %s, 'ACTIVE' FROM DUAL
                                     WHERE NOT EXISTS (SELECT 1 FROM platform_users WHERE email = %s LIMIT 1)""",
                            (humanize_identifier(email.split("@", 1)[0] or "Super Admin"), email, email))
            except Exception:
                pass
    except Exception:
        pass
