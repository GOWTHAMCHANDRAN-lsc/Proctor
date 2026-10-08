#!/usr/bin/env python3
"""
ProctorGuard exam-request mailbox worker (Python 3 stdlib only).

Reads the platform mailbox over IMAP, picks UNSEEN messages whose subject starts with
"EXAM REQUEST", converts each one to JSON and pipes it into scripts/exam_request_intake.php
(which authenticates the sender + security code and records the request). Processed messages are
moved to the "Exam Requests" folder; a message the intake could not process is marked \\Seen and
left in the inbox (and logged).

Config comes from ../.env (relative to this script):
  MAIL_INTAKE_ENABLED     must be "1", otherwise the worker prints "disabled" and exits 0
  IMAP_HOST               default SMTP_HOST
  IMAP_PORT               default 993 (implicit TLS, default SSL context)
  IMAP_USER / IMAP_PASS   default SMTP_USER / SMTP_PASS
  IMAP_FOLDER             default INBOX
  IMAP_PROCESSED_FOLDER   default "Exam Requests" (placed under the server's personal namespace,
                          e.g. "INBOX.Exam Requests" on a server whose folders all live under INBOX.)
  IMAP_CAFILE             optional extra CA bundle (still full certificate verification)
  MAIL_INTAKE_PHP         optional php binary (default: php on PATH, else /usr/bin/php)

Usage:
  mail_intake.py                     process the mailbox (cron)
  mail_intake.py --check             connect, log in, list folders, count matching UNSEEN mail; no changes
  mail_intake.py --dry-run           like a run, but only print a JSON summary per message; no intake, no changes
  mail_intake.py --eml A.eml [B.eml] run intake on local .eml files (no IMAP); add --dry-run to only summarise

Cron (one line per run is appended to the log):
  */2 * * * * /usr/bin/python3 /srv/apps/proctor/scripts/mail_intake.py >> /srv/apps/proctor/storage/logs/mail_intake.log 2>&1

Never prints credentials or message bodies.
"""

import argparse
import base64
import email
import fcntl
import imaplib
import json
import os
import re
import shutil
import socket
import ssl
import subprocess
import sys
import time
from email import policy
from email.utils import parseaddr

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
APP_DIR = os.path.dirname(SCRIPT_DIR)
ENV_PATH = os.path.join(APP_DIR, ".env")
STORAGE_DIR = os.path.join(APP_DIR, "storage")
LOCK_PATH = os.path.join(STORAGE_DIR, "mail_intake.lock")
INTAKE_PHP = os.path.join(SCRIPT_DIR, "exam_request_intake.php")

SUBJECT_PREFIX = "EXAM REQUEST"
MAX_MESSAGES_PER_RUN = 20
MAX_ATTACHMENT_BYTES = 2 * 1024 * 1024
MAX_MESSAGE_BYTES = 30 * 1024 * 1024
IMAP_TIMEOUT = 30
INTAKE_TIMEOUT = 60


# --------------------------------------------------------------------------------------------
# Small helpers
# --------------------------------------------------------------------------------------------

def log(message):
    print(time.strftime("%Y-%m-%dT%H:%M:%S%z") + " mail_intake " + message, flush=True)


def load_env(path):
    """Simple KEY=VALUE parser: ignores blanks/comments, tolerates `export ` and surrounding quotes."""
    env = {}
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            for line in fh:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, value = line.split("=", 1)
                key = key.strip()
                if key.startswith("export "):
                    key = key[len("export "):].strip()
                value = value.strip()
                if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
                    value = value[1:-1]
                env[key] = value
    except OSError:
        pass
    return env


def build_config(env):
    def pick(key, fallback_key=None, default=""):
        value = env.get(key, "")
        if value == "" and fallback_key:
            value = env.get(fallback_key, "")
        return value if value != "" else default

    try:
        port = int(pick("IMAP_PORT", default="993"))
    except ValueError:
        port = 993
    return {
        "enabled": env.get("MAIL_INTAKE_ENABLED", "").strip() == "1",
        "host": pick("IMAP_HOST", "SMTP_HOST"),
        "port": port,
        "user": pick("IMAP_USER", "SMTP_USER"),
        "password": pick("IMAP_PASS", "SMTP_PASS"),
        "folder": pick("IMAP_FOLDER", default="INBOX"),
        "processed": pick("IMAP_PROCESSED_FOLDER", default="Exam Requests"),
        "cafile": pick("IMAP_CAFILE"),
        "php": pick("MAIL_INTAKE_PHP", default=shutil.which("php") or "/usr/bin/php"),
    }


def subject_matches(subject):
    return subject.strip().upper().startswith(SUBJECT_PREFIX)


# --------------------------------------------------------------------------------------------
# Message -> intake JSON
# --------------------------------------------------------------------------------------------

def _part_text(part):
    try:
        return part.get_content()
    except Exception:  # unknown charset / broken encoding
        payload = part.get_payload(decode=True) or b""
        return payload.decode("utf-8", errors="replace")


def message_to_payload(raw_bytes):
    """Parse an RFC 822 message into the JSON shape exam_request_intake.php expects."""
    msg = email.message_from_bytes(raw_bytes, policy=policy.default)

    subject = str(msg.get("Subject", "") or "").strip()
    from_name, from_addr = "", ""
    header = msg.get("From")
    try:
        addresses = header.addresses if header is not None else ()
        if addresses:
            from_name, from_addr = addresses[0].display_name or "", addresses[0].addr_spec or ""
    except Exception:
        pass
    if not from_addr:
        from_name, from_addr = parseaddr(str(header or ""))

    text_body, html_body = "", ""
    attachments = []
    for part in msg.walk():
        if part.is_multipart():
            continue
        ctype = part.get_content_type()
        disposition = part.get_content_disposition()
        filename = part.get_filename()
        if filename or disposition == "attachment":
            payload = part.get_payload(decode=True) or b""
            item = {"filename": filename or "", "contentType": ctype, "size": len(payload)}
            if len(payload) > MAX_ATTACHMENT_BYTES:
                item["tooLarge"] = True
            else:
                item["base64"] = base64.b64encode(payload).decode("ascii")
            attachments.append(item)
        elif ctype == "text/plain" and not text_body:
            text_body = _part_text(part)
        elif ctype == "text/html" and not html_body:
            html_body = _part_text(part)

    return {
        "messageId": str(msg.get("Message-ID", "") or "").strip(),
        "from": (from_addr or "").strip().lower(),
        "fromName": (from_name or "").strip(),
        "subject": subject,
        "date": str(msg.get("Date", "") or "").strip(),
        "textBody": text_body,
        "htmlBody": html_body,
        "attachments": attachments,
    }


def summarize(payload):
    """What --dry-run prints: everything except bodies and attachment contents."""
    return {
        "messageId": payload["messageId"],
        "from": payload["from"],
        "fromName": payload["fromName"],
        "subject": payload["subject"],
        "date": payload["date"],
        "subjectMatches": subject_matches(payload["subject"]),
        "textChars": len(payload["textBody"]),
        "htmlChars": len(payload["htmlBody"]),
        "attachments": [
            {k: a[k] for k in ("filename", "contentType", "size", "tooLarge") if k in a}
            for a in payload["attachments"]
        ],
    }


def run_intake(cfg, payload):
    """Pipe one message into the PHP intake. Returns (ok, result_dict_or_error_string)."""
    data = json.dumps(payload).encode("utf-8")
    try:
        proc = subprocess.run(
            [cfg["php"], INTAKE_PHP],
            input=data,
            capture_output=True,
            timeout=INTAKE_TIMEOUT,
            cwd=APP_DIR,
        )
    except subprocess.TimeoutExpired:
        return False, "intake timed out after %ds" % INTAKE_TIMEOUT
    except OSError as exc:
        return False, "could not run php: %s" % exc
    lines = [l for l in proc.stdout.decode("utf-8", errors="replace").splitlines() if l.strip()]
    result = None
    if lines:
        try:
            result = json.loads(lines[-1])
        except ValueError:
            result = None
    if isinstance(result, dict) and result.get("ok") is True:
        return True, result
    if isinstance(result, dict):
        return False, str(result.get("error") or result)[:300]
    return False, "intake exited %d without a JSON result" % proc.returncode


def describe_result(result):
    if result.get("duplicate"):
        return "duplicate of request #%s" % result.get("requestId")
    text = "request #%s %s" % (result.get("requestId"), result.get("status"))
    if result.get("errors"):
        text += " (%s problem(s))" % result.get("errors")
    return text


# --------------------------------------------------------------------------------------------
# IMAP helpers
# --------------------------------------------------------------------------------------------

def imap_utf7_encode(name):
    """RFC 3501 modified UTF-7 for mailbox names (ASCII passes through unchanged)."""
    out, buf = [], []

    def flush():
        if buf:
            raw = "".join(buf).encode("utf-16-be")
            out.append("&" + base64.b64encode(raw).decode("ascii").rstrip("=").replace("/", ",") + "-")
            buf.clear()

    for ch in name:
        if 0x20 <= ord(ch) <= 0x7E:
            flush()
            out.append("&-" if ch == "&" else ch)
        else:
            buf.append(ch)
    flush()
    return "".join(out)


def imap_utf7_decode(name):
    def repl(match):
        chunk = match.group(1)
        if chunk == "":
            return "&"
        chunk = chunk.replace(",", "/")
        chunk += "=" * (-len(chunk) % 4)
        try:
            return base64.b64decode(chunk).decode("utf-16-be")
        except Exception:
            return match.group(0)
    return re.sub(r"&([A-Za-z0-9+,]*)-", repl, name)


def quote_mailbox(name):
    encoded = imap_utf7_encode(name)
    return '"' + encoded.replace("\\", "\\\\").replace('"', '\\"') + '"'


_LIST_RE = re.compile(rb'^\((?P<flags>[^)]*)\)\s+(?P<delim>"(?:[^"\\]|\\.)*"|NIL)\s+(?P<name>.*)$')


def _unquote(value):
    value = value.strip()
    if len(value) >= 2 and value[0] == '"' and value[-1] == '"':
        value = value[1:-1].replace('\\"', '"').replace("\\\\", "\\")
    return value


def parse_list_response(data):
    """imaplib LIST data -> [(flags, delimiter, name)]; handles quoted, atom and literal names."""
    entries = []
    for item in data or []:
        if item is None:
            continue
        if isinstance(item, tuple):
            head, literal = item[0], item[1]
            m = _LIST_RE.match(head.strip())
            if not m:
                continue
            name = literal.decode("utf-8", errors="replace")
        else:
            m = _LIST_RE.match(item.strip())
            if not m:
                continue
            name = _unquote(m.group("name").decode("utf-8", errors="replace"))
        delim = m.group("delim").decode()
        delim = None if delim == "NIL" else _unquote(delim)
        entries.append((m.group("flags").decode(), delim, imap_utf7_decode(name)))
    return entries


def personal_namespace(imap):
    """(prefix, delimiter) of the personal namespace — from NAMESPACE, else derived from LIST."""
    prefix, delim = None, None
    if "NAMESPACE" in imap.capabilities:
        try:
            typ, data = imap.namespace()
            if typ == "OK" and data and data[0]:
                raw = data[0] if isinstance(data[0], bytes) else str(data[0]).encode()
                m = re.match(rb'\s*\(\("((?:[^"\\]|\\.)*)"\s+(?:"((?:[^"\\]|\\.)*)"|NIL)\)', raw)
                if m:
                    prefix = _unquote('"' + m.group(1).decode() + '"')
                    delim = m.group(2).decode() if m.group(2) is not None else ""
        except imaplib.IMAP4.error:
            pass
    if delim is None:
        typ, data = imap.list('""', '""')
        entries = parse_list_response(data) if typ == "OK" else []
        delim = entries[0][1] if entries and entries[0][1] else "/"
    if prefix is None:
        typ, data = imap.list()
        names = [e[2] for e in parse_list_response(data)] if typ == "OK" else []
        others = [n for n in names if n.upper() != "INBOX"]
        if others and all(n.upper().startswith("INBOX" + delim) for n in others):
            prefix = "INBOX" + delim
        else:
            prefix = ""
    return prefix, delim


def processed_mailbox_name(cfg, prefix, delim):
    name = cfg["processed"].strip() or "Exam Requests"
    if prefix and not name.upper().startswith(prefix.upper()) and name.upper() != "INBOX":
        name = prefix + name
    return name


def mailbox_exists(imap, name):
    typ, data = imap.list('""', quote_mailbox(name))
    return typ == "OK" and len(parse_list_response(data)) > 0


def connect(cfg):
    if not cfg["host"] or not cfg["user"] or not cfg["password"]:
        raise RuntimeError("IMAP host/user/password are not configured")
    context = ssl.create_default_context()
    if cfg["cafile"]:
        context.load_verify_locations(cafile=cfg["cafile"])
    imap = imaplib.IMAP4_SSL(cfg["host"], cfg["port"], ssl_context=context, timeout=IMAP_TIMEOUT)
    imap.login(cfg["user"], cfg["password"])
    # Some servers only reveal extensions (MOVE, UIDPLUS, ...) after authentication.
    try:
        typ, data = imap.capability()
        if typ == "OK" and data and data[0]:
            imap.capabilities = tuple(data[0].decode().upper().split())
    except imaplib.IMAP4.error:
        pass
    return imap


def find_candidates(imap):
    """UIDs (ascending) of UNSEEN, undeleted messages whose decoded subject starts with EXAM REQUEST."""
    typ, data = imap.uid("SEARCH", None, "UNSEEN", "UNDELETED", "SUBJECT", '"%s"' % SUBJECT_PREFIX)
    if typ != "OK" or not data or not data[0]:
        return []
    uids = sorted({int(u) for u in data[0].split()})
    matches = []
    # Cheap header-only check: SEARCH SUBJECT is a substring match, the rule is "starts with".
    for chunk_start in range(0, len(uids), 100):
        chunk = uids[chunk_start:chunk_start + 100]
        typ, data = imap.uid("FETCH", ",".join(str(u) for u in chunk), "(UID RFC822.SIZE BODY.PEEK[HEADER.FIELDS (SUBJECT)])")
        if typ != "OK":
            continue
        data = list(data or [])
        for idx, item in enumerate(data):
            if not isinstance(item, tuple):
                continue
            meta = item[0].decode(errors="replace")
            # Some servers send UID / RFC822.SIZE after the header literal (in the next element).
            if idx + 1 < len(data) and isinstance(data[idx + 1], bytes):
                meta += " " + data[idx + 1].decode(errors="replace")
            m_uid = re.search(r"UID (\d+)", meta)
            m_size = re.search(r"RFC822\.SIZE (\d+)", meta)
            if not m_uid:
                continue
            headers = email.message_from_bytes(item[1], policy=policy.default)
            subject = str(headers.get("Subject", "") or "")
            if subject_matches(subject):
                matches.append((int(m_uid.group(1)), int(m_size.group(1)) if m_size else 0))
    return sorted(matches)


def fetch_message(imap, uid):
    typ, data = imap.uid("FETCH", str(uid), "(BODY.PEEK[])")
    if typ != "OK":
        return None
    for item in data or []:
        if isinstance(item, tuple) and len(item) >= 2 and isinstance(item[1], (bytes, bytearray)):
            return bytes(item[1])
    return None


def mark_seen(imap, uid):
    imap.uid("STORE", str(uid), "+FLAGS.SILENT", "(\\Seen)")


def move_message(imap, uid, dest_quoted, has_move):
    """Returns 'moved' | 'flagged' (copied + \\Deleted, needs EXPUNGE) | None on failure."""
    # \Seen first: the copy in the processed folder then reads as handled, and if the EXPUNGE below
    # is skipped the original is never picked up again (the search is UNSEEN UNDELETED).
    mark_seen(imap, uid)
    if has_move:
        typ, _ = imap.uid("MOVE", str(uid), dest_quoted)
        if typ == "OK":
            return "moved"
    typ, _ = imap.uid("COPY", str(uid), dest_quoted)
    if typ != "OK":
        return None
    imap.uid("STORE", str(uid), "+FLAGS.SILENT", "(\\Deleted)")
    return "flagged"


def expunge_ours(imap, our_uids, has_uidplus):
    """Expunge only the messages we flagged. Without UIDPLUS a plain EXPUNGE would also purge
    anything another client had flagged \\Deleted, so it is skipped in that case."""
    if not our_uids:
        return
    uidset = ",".join(str(u) for u in sorted(our_uids))
    if has_uidplus:
        imap.uid("EXPUNGE", uidset)
        return
    typ, data = imap.uid("SEARCH", None, "DELETED")
    flagged = {int(u) for u in data[0].split()} if typ == "OK" and data and data[0] else set()
    foreign = flagged - set(our_uids)
    if foreign:
        log("skipped EXPUNGE: %d other message(s) in the folder are already flagged \\Deleted by another client; "
            "the processed originals stay hidden (\\Seen \\Deleted) until the mailbox is next expunged" % len(foreign))
        return
    imap.expunge()


# --------------------------------------------------------------------------------------------
# Modes
# --------------------------------------------------------------------------------------------

def mode_eml(cfg, paths, dry_run):
    status = 0
    for path in paths:
        try:
            with open(path, "rb") as fh:
                raw = fh.read()
        except OSError as exc:
            log("file=%s error=%s" % (os.path.basename(path), exc))
            status = 1
            continue
        payload = message_to_payload(raw)
        if dry_run:
            print(json.dumps(dict(summarize(payload), file=os.path.basename(path)), ensure_ascii=False), flush=True)
            continue
        if not subject_matches(payload["subject"]):
            log("file=%s skipped: subject does not start with %s" % (os.path.basename(path), SUBJECT_PREFIX))
            continue
        ok, result = run_intake(cfg, payload)
        if ok:
            log("file=%s from=%s %s" % (os.path.basename(path), payload["from"] or "?", describe_result(result)))
        else:
            log("file=%s from=%s intake FAILED: %s" % (os.path.basename(path), payload["from"] or "?", result))
            status = 1
    return status


def mode_check(cfg):
    """Read-only connectivity report — no flags changed, nothing moved or created."""
    print("host: %s:%s (implicit TLS, certificate verified)" % (cfg["host"], cfg["port"]))
    try:
        imap = connect(cfg)
    except Exception as exc:  # noqa: BLE001 — report any failure plainly
        # Server/SSL error text only (never contains our credentials).
        print("login: FAILED (%s: %s)" % (exc.__class__.__name__, str(exc)[:200]))
        return 1
    try:
        print("login: OK")
        caps = set(imap.capabilities)
        print("capabilities: MOVE=%s UIDPLUS=%s NAMESPACE=%s IDLE=%s" % tuple(
            "yes" if c in caps else "no" for c in ("MOVE", "UIDPLUS", "NAMESPACE", "IDLE")))
        prefix, delim = personal_namespace(imap)
        print('namespace: prefix="%s" delimiter="%s"' % (prefix, delim))
        typ, data = imap.list()
        folders = [e[2] for e in parse_list_response(data)] if typ == "OK" else []
        print("folders (%d): %s" % (len(folders), ", ".join('"%s"' % f for f in folders)))
        dest = processed_mailbox_name(cfg, prefix, delim)
        print('processed folder: "%s" (%s)' % (dest, "exists" if mailbox_exists(imap, dest) else "will be created on first run"))
        typ, _ = imap.select(quote_mailbox(cfg["folder"]), readonly=True)
        if typ != "OK":
            print('inbox: cannot open "%s"' % cfg["folder"])
            return 1
        candidates = find_candidates(imap)
        print('unseen "%s..." messages in "%s": %d' % (SUBJECT_PREFIX, cfg["folder"], len(candidates)))
        print("move strategy: %s" % ("UID MOVE" if "MOVE" in caps else
                                     "COPY + \\Deleted + " + ("UID EXPUNGE" if "UIDPLUS" in caps else "EXPUNGE (skipped if other \\Deleted mail exists)")))
        print("worker: %s" % ("ENABLED" if cfg["enabled"] else "disabled (set MAIL_INTAKE_ENABLED=1 to process mail)"))
        return 0
    finally:
        try:
            imap.logout()
        except Exception:
            pass


def mode_mailbox(cfg, dry_run):
    try:
        imap = connect(cfg)
    except Exception as exc:  # noqa: BLE001
        log("connect/login failed: %s: %s" % (exc.__class__.__name__, str(exc)[:200]))
        return 1
    status = 0
    try:
        typ, _ = imap.select(quote_mailbox(cfg["folder"]), readonly=dry_run)
        if typ != "OK":
            log('cannot open folder "%s"' % cfg["folder"])
            return 1
        candidates = find_candidates(imap)
        if not candidates:
            return 0
        batch = candidates[:MAX_MESSAGES_PER_RUN]
        if len(candidates) > len(batch):
            log("%d matching messages; processing the oldest %d this run" % (len(candidates), len(batch)))

        dest_quoted = None
        if not dry_run:
            prefix, delim = personal_namespace(imap)
            dest = processed_mailbox_name(cfg, prefix, delim)
            dest_quoted = quote_mailbox(dest)
            if not mailbox_exists(imap, dest):
                typ, _ = imap.create(dest_quoted)
                if typ == "OK":
                    try:
                        imap.subscribe(dest_quoted)
                    except imaplib.IMAP4.error:
                        pass
                    log('created folder "%s"' % dest)
                else:
                    log('could not create folder "%s"; processed mail will only be marked \\Seen' % dest)
                    dest_quoted = None

        has_move = "MOVE" in imap.capabilities
        has_uidplus = "UIDPLUS" in imap.capabilities
        flagged = []
        for uid, size in batch:
            if size > MAX_MESSAGE_BYTES:
                log("uid=%d skipped: message is %d bytes (limit %d); marked \\Seen" % (uid, size, MAX_MESSAGE_BYTES))
                if not dry_run:
                    mark_seen(imap, uid)
                continue
            raw = fetch_message(imap, uid)
            if raw is None:
                log("uid=%d fetch failed" % uid)
                status = 1
                continue
            payload = message_to_payload(raw)
            if not subject_matches(payload["subject"]):
                continue
            if dry_run:
                print(json.dumps(dict(summarize(payload), uid=uid), ensure_ascii=False), flush=True)
                continue
            ok, result = run_intake(cfg, payload)
            if not ok:
                mark_seen(imap, uid)
                log("uid=%d from=%s intake FAILED (left in %s, marked \\Seen): %s" % (uid, payload["from"] or "?", cfg["folder"], result))
                status = 1
                continue
            outcome = move_message(imap, uid, dest_quoted, has_move) if dest_quoted else None
            if outcome is None:
                mark_seen(imap, uid)
            elif outcome == "flagged":
                flagged.append(uid)
            log("uid=%d from=%s %s; %s" % (uid, payload["from"] or "?", describe_result(result),
                                           "moved" if outcome else "marked \\Seen (not moved)"))
        if flagged:
            expunge_ours(imap, flagged, has_uidplus)
        return status
    finally:
        try:
            imap.logout()
        except Exception:
            pass


def main():
    parser = argparse.ArgumentParser(description="Exam-request mailbox worker")
    parser.add_argument("--check", action="store_true", help="connect, list folders, count matching mail; no changes")
    parser.add_argument("--dry-run", action="store_true", help="print a JSON summary per message instead of running intake")
    parser.add_argument("--eml", nargs="+", metavar="FILE", help="run on local .eml files instead of IMAP")
    args = parser.parse_args()

    cfg = build_config(load_env(ENV_PATH))
    socket.setdefaulttimeout(IMAP_TIMEOUT)

    if args.eml:
        return mode_eml(cfg, args.eml, args.dry_run)
    if args.check:
        return mode_check(cfg)
    if not args.dry_run and not cfg["enabled"]:
        print("disabled")
        return 0

    # One worker at a time: a slow run must not overlap the next cron tick.
    os.makedirs(STORAGE_DIR, exist_ok=True)
    lock_fh = open(LOCK_PATH, "a")
    try:
        fcntl.flock(lock_fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        return 0
    try:
        return mode_mailbox(cfg, args.dry_run)
    finally:
        fcntl.flock(lock_fh, fcntl.LOCK_UN)
        lock_fh.close()


if __name__ == "__main__":
    sys.exit(main())
