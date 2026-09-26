"""Python port of api/notify.php — SMTP email delivery + delivery-log recording.

smtp_send() is also imported by users.py for invite emails (mirrors PHP's
`require_once notify.php` which only pulls in the helper when included).
"""

from __future__ import annotations

import html
import re
import smtplib
import ssl
from email.message import EmailMessage
from email.utils import formatdate, make_msgid

from fastapi import APIRouter, Request

from .core import ENV, ApiError, db, json_input, php_int, require_company_id

router = APIRouter()

EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def _valid_email(addr: str) -> bool:
    # Mirrors PHP filter_var(FILTER_VALIDATE_EMAIL) closely enough for routing.
    return bool(EMAIL_RE.match(addr))


def _strip_tags(text: str) -> str:
    return re.sub(r"<[^>]*>", "", text)


def smtp_send(host: str, port: int, user: str, password: str, sender: str, message: dict,
              secure_mode: str = "", timeout_seconds: int = 15, allow_self_signed: bool = False) -> dict:
    """Send one email. Returns {'ok': bool} or {'ok': False, 'error': str}."""
    secure = (secure_mode or "").strip().lower()
    if secure not in ("ssl", "tls", "none"):
        if port == 465:
            secure = "ssl"
        elif port == 587:
            secure = "tls"
        else:
            secure = "none"

    to = str(message.get("to") or "").strip()
    subject = str(message.get("subject") or "")
    html_body = str(message.get("body") or "")
    plain_body = str(message.get("plain") or _strip_tags(html_body))
    from_name = str(message.get("fromName") or "ProctorGuard Notifications")

    msg = EmailMessage()
    if from_name and "<" not in sender and _valid_email(sender):
        msg["From"] = f"{from_name} <{sender}>"
    else:
        msg["From"] = sender
    msg["To"] = to
    msg["Subject"] = subject if subject.strip() != "" else "(no subject)"
    msg["Date"] = formatdate(localtime=False)
    bare_from = sender
    m = re.search(r"<([^>]+)>", sender)
    if m:
        bare_from = m.group(1)
    domain = bare_from.split("@", 1)[1] if "@" in bare_from else "localhost"
    msg["Message-ID"] = make_msgid(domain=re.sub(r"[^A-Za-z0-9.\-]", "", domain) or "localhost")
    msg.set_content(plain_body if plain_body.strip() != ""
                    else "Please view this message in an HTML-compatible email client.")
    msg.add_alternative(html_body, subtype="html")

    ctx = ssl.create_default_context()
    if allow_self_signed:
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE

    try:
        if secure == "ssl":
            server = smtplib.SMTP_SSL(host, port, timeout=timeout_seconds, context=ctx)
        else:
            server = smtplib.SMTP(host, port, timeout=timeout_seconds)
        try:
            server.ehlo()
            if secure == "tls":
                if not server.has_extn("starttls"):
                    raise RuntimeError("Server does not advertise STARTTLS.")
                server.starttls(context=ctx)
                server.ehlo()
            if user != "":
                server.login(user, password)
            server.send_message(msg, from_addr=sender, to_addrs=[to])
            return {"ok": True}
        finally:
            try:
                server.quit()
            except Exception:
                pass
    except Exception as e:
        return {"ok": False, "error": str(e)}


def _delivery_log(conn, company_id, channel, recipient, subject, body, status, error, template_id):
    with conn.cursor() as cur:
        cur.execute("CALL sp_add_delivery_log(%s, %s, %s, %s, %s, %s, %s, %s, %s)",
                    (company_id, channel, recipient, subject, body, status, error, template_id, None))
        while cur.nextset():
            pass


def _wrap_plain_body(body: str, subject: str) -> str:
    lower = body[:300].lower()
    if "<html" in lower or "<body" in lower or "<!doctype" in lower:
        return body
    safe = html.escape(body, quote=True).replace("\n", "<br />\n")
    return ("<!doctype html><html><head><meta charset=\"utf-8\"><title>"
            + html.escape(subject, quote=True)
            + "</title></head><body style=\"margin:0;padding:24px;font-family:system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:14px;line-height:1.6;color:#0f172a;background-color:#f8fafc;\">"
            + "<div style=\"max-width:640px;margin:0 auto;background:#ffffff;border-radius:12px;border:1px solid #e2e8f0;padding:24px;\">"
            + safe
            + "</div>"
            + "<div style=\"max-width:640px;margin:16px auto 0;text-align:center;font-size:11px;color:#94a3b8;\">"
            + "This is an automated exam notification from LSC Proctor."
            + "</div></body></html>")


@router.post("/notify.php")
async def post_notify(request: Request):
    payload = await json_input(request)
    with db() as conn:
        company_id = require_company_id(request, payload)
        messages = payload.get("messages")
        if not isinstance(messages, list) or len(messages) == 0:
            raise ApiError({"error": "No messages provided."}, 400)

        host = ENV.get("SMTP_HOST", "")
        port = php_int(ENV.get("SMTP_PORT", "0"))
        user = ENV.get("SMTP_USER", "")
        password = ENV.get("SMTP_PASS", "")
        sender = ENV.get("SMTP_FROM", "")
        secure_mode = ENV.get("SMTP_SECURE", "")
        allow_self_signed = ENV.get("SMTP_ALLOW_SELF_SIGNED", "0") == "1"
        timeout = php_int(ENV.get("SMTP_TIMEOUT", "15"))
        timeout = max(5, min(60, timeout))

        if host == "" or port == 0 or sender == "":
            raise ApiError({"error": "SMTP is not configured in .env."}, 400)

        sent = 0
        failed: list[dict] = []
        for msg in messages:
            if not isinstance(msg, dict):
                msg = {}
            to = str(msg.get("to") or "").strip()
            subject = str(msg.get("subject") or "").strip()
            body = str(msg.get("body") or "")
            channel = str(msg.get("channel") or "EMAIL").strip().upper()
            template_id = php_int(msg["templateId"]) if msg.get("templateId") is not None else None
            if channel not in ("EMAIL", "SMS"):
                channel = "EMAIL"

            if to == "" or (channel == "EMAIL" and subject == "") or body == "":
                failed.append({"to": to, "error": "Invalid message payload."})
                _delivery_log(conn, company_id, channel, to, subject, body, "FAILED", "Invalid message payload.", template_id)
                continue

            if channel == "EMAIL" and not _valid_email(to):
                error = "Invalid recipient email address."
                failed.append({"to": to, "error": error})
                _delivery_log(conn, company_id, channel, to, subject, body, "FAILED", error, template_id)
                continue

            if channel == "SMS":
                failed.append({"to": to, "error": "SMS provider not configured."})
                _delivery_log(conn, company_id, channel, to, None, body, "SKIPPED", "SMS provider not configured.", template_id)
                continue

            normalized_body = _wrap_plain_body(body, subject)
            plain = re.sub(r"\r\n|\r|\n", "\n", _strip_tags(body)).strip()
            result = smtp_send(host, port, user, password, sender,
                               {"to": to, "subject": subject, "body": normalized_body, "plain": plain},
                               secure_mode, timeout, allow_self_signed)

            if result.get("ok"):
                sent += 1
                status, error = "SENT", None
            else:
                status = "FAILED"
                error = result.get("error") or "Send failed."
                failed.append({"to": to, "error": error})

            _delivery_log(conn, company_id, channel, to, subject, body, status, error, template_id)

        return {"sent": sent, "failed": failed}
