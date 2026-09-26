"""Python port of api/enrollment.php — biometric face-descriptor enrollment storage."""

from __future__ import annotations

import json
import math

from fastapi import APIRouter, Request

from .core import (
    ApiError, add_column_if_missing, column_exists, db, execute, json_input, q1,
    require_company_id, require_role,
)

router = APIRouter()


def ensure_enrollment_schema(conn) -> None:
    add_column_if_missing(conn, "students", "face_descriptor", "TEXT NULL AFTER registration_id")
    add_column_if_missing(conn, "students", "face_photo", "MEDIUMTEXT NULL AFTER face_descriptor")
    add_column_if_missing(conn, "students", "enrolled_at", "TIMESTAMP NULL DEFAULT NULL AFTER face_photo")


def _floatval(v) -> float:
    """PHP floatval(): leading float of a value, 0.0 otherwise."""
    try:
        return float(v)
    except (TypeError, ValueError):
        import re
        m = re.match(r"\s*[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?", str(v))
        return float(m.group(0)) if m else 0.0


@router.get("/enrollment.php")
def get_enrollment(request: Request):
    with db() as conn:
        ensure_enrollment_schema(conn)
        company_id = require_company_id(request)
        student_id = (request.query_params.get("studentId") or "").strip()
        if student_id == "":
            raise ApiError({"error": "studentId is required."}, 400)
        if not column_exists(conn, "students", "face_descriptor"):
            return {"enrolled": False, "descriptor": None}

        row = q1(conn, "SELECT face_descriptor, enrolled_at FROM students WHERE id = %s AND company_id = %s",
                 (student_id, company_id))
        if not row or not row.get("face_descriptor"):
            return {"enrolled": False, "descriptor": None}

        try:
            decoded = json.loads(row["face_descriptor"])
        except (ValueError, TypeError):
            decoded = None
        descriptor = [_floatval(x) for x in decoded] if isinstance(decoded, list) else None
        enrolled_at = row.get("enrolled_at")
        return {
            "enrolled": isinstance(descriptor, list) and len(descriptor) >= 64,
            "descriptor": descriptor,
            "enrolledAt": str(enrolled_at) if enrolled_at is not None else None,
        }


@router.post("/enrollment.php")
async def post_enrollment(request: Request):
    payload = await json_input(request)
    with db() as conn:
        ensure_enrollment_schema(conn)
        company_id = require_company_id(request, payload)
        action = str(payload.get("action") or "enroll").strip().lower()

        if action == "reset":
            require_role(request, ["ADMIN", "PROCTOR"], payload)
            student_id = str(payload.get("studentId") or "").strip()
            if student_id == "":
                raise ApiError({"error": "studentId is required."}, 400)
            execute(conn, "UPDATE students SET face_descriptor = NULL, face_photo = NULL, enrolled_at = NULL WHERE id = %s AND company_id = %s",
                    (student_id, company_id))
            return {"ok": True, "enrolled": False}

        student_id = str(payload.get("studentId") or "").strip()
        descriptor = payload.get("descriptor")
        photo = str(payload["photo"]) if payload.get("photo") is not None else None

        if student_id == "" or not isinstance(descriptor, list):
            raise ApiError({"error": "studentId and descriptor are required."}, 400)

        descriptor = [_floatval(x) for x in descriptor]
        length = len(descriptor)
        # face-api descriptors are 128-d; accept >=64 to tolerate model variants, reject noise.
        if length < 64 or length > 1024:
            raise ApiError({"error": "Invalid face descriptor."}, 400)
        for v in descriptor:
            if not math.isfinite(v):
                raise ApiError({"error": "Face descriptor contains invalid values."}, 400)

        # Keep the stored reference photo bounded so a huge data URL cannot bloat the row.
        if photo is not None and len(photo) > 600000:
            photo = None

        if not q1(conn, "SELECT id FROM students WHERE id = %s AND company_id = %s", (student_id, company_id)):
            raise ApiError({"error": "Student not found."}, 404)

        execute(conn, "UPDATE students SET face_descriptor = %s, face_photo = %s, enrolled_at = NOW() WHERE id = %s AND company_id = %s",
                (json.dumps(descriptor), photo, student_id, company_id))

        return {"ok": True, "enrolled": True, "length": length}
