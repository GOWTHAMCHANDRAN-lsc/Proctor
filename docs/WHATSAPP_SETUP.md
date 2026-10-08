# WhatsApp notifications — setup guide

ProctorGuard can send three kinds of WhatsApp message next to the emails it already sends:

| Kind | Sent when | To |
|---|---|---|
| **INVITE** | an exam invitation goes out (admin "Notify", Mail Composer → Invitation, course-completion integration, approved email exam request) | the candidate |
| **REMINDER** | an admin sends a reminder from the Mail Composer (e.g. audience "Not attempted") | the candidate |
| **REQUEST_UPDATE** | an emailed exam request is received, approved or rejected | the employee who sent the request |

The feature **ships switched off** and is built so it can be turned on later by editing `.env` only —
no code change, no rebuild, no restart (PHP reads `.env` on every request).

---

## 1. What happens while it is off

* `WHATSAPP_ENABLED` is not `1`, or no provider/credentials, or no template name for a kind
  → that kind is **not configured**.
* Nothing is sent and **nothing is written to the delivery log** (so the log doesn't fill with "skipped" rows).
* The exam screens show no WhatsApp option. Settings → **WhatsApp notifications** shows
  *Not configured* and lists which `.env` keys are missing (names only, never values).
* Email behaviour is exactly as before.

You can still collect mobile numbers while it is off (see §2), so they are ready when you switch on.

## 2. Phone numbers

* **Candidates:** Students → *Add student* has an optional **Mobile** field; the phone icon on each row
  edits it; the student CSV accepts an optional 4th column **Mobile** (header `Mobile`, `Phone` or
  `WhatsApp`). 3-column files keep working, and a blank Mobile cell never erases a stored number.
* **Employees (exam requesters):** Exam Requests → *Employees & codes* → *Add employee* / *Edit*.
* Accepted formats: `98765 43210`, `098765 43210`, `+91 98765 43210`, `0091-98765-43210`,
  `+971 50 123 4567`. A 10-digit number gets `WHATSAPP_COUNTRY_CODE` (default `91`); a number written
  with `+` or `00` is already international. Stored as bare digits (`919876543210`), 8–15 digits.
  Anything else (letters, Excel's `9.18E+11`) is rejected with a per-row error.

## 3. Message templates (needed for both providers)

WhatsApp only allows business-initiated messages through **pre-approved templates**. Create these
three templates (category **Utility**, language e.g. **English**), then put their *names* in `.env`.
The **variable order is fixed** — ProctorGuard fills `{{1}}…{{n}}` in exactly this order. You may
reword the surrounding text, but keep every variable and its meaning.

### INVITE — suggested name `exam_invite_v1`

| Var | Value | Example |
|---|---|---|
| `{{1}}` | candidate name | Asha Rao |
| `{{2}}` | exam title | Sales Assessment Q4 |
| `{{3}}` | availability window, in the exam's timezone | 15 Oct 2026, 10:00 – 18:00 IST |
| `{{4}}` | duration | 30 minutes |
| `{{5}}` | the candidate's personal exam link (same link as the email) | https://proctor.lsc-crm.in?Ab3dE5gH9k |

```
Hello {{1}},

You are invited to take the online exam "{{2}}".

Available: {{3}}
Duration: {{4}}

Open your personal exam link to begin: {{5}}

This link is personal to you. Please do not share it.
```

### REMINDER — suggested name `exam_reminder_v1`

| Var | Value | Example |
|---|---|---|
| `{{1}}` | candidate name | Asha Rao |
| `{{2}}` | exam title | Sales Assessment Q4 |
| `{{3}}` | when the exam window closes, in the exam's timezone | 15 Oct 2026, 18:00 IST |
| `{{4}}` | the candidate's personal exam link | https://proctor.lsc-crm.in?Ab3dE5gH9k |

```
Hello {{1}},

This is a reminder that you have not yet completed the exam "{{2}}". The exam window closes on {{3}}.

Your personal exam link: {{4}}

Please finish the exam before the window closes.
```

### REQUEST_UPDATE — suggested name `exam_request_update_v1`

| Var | Value | Example |
|---|---|---|
| `{{1}}` | employee name | Priya Sharma |
| `{{2}}` | request reference | #42 |
| `{{3}}` | exam title | Sales Assessment Q4 |
| `{{4}}` | status message | `received, pending approval` · `received, needs attention (2 problems to fix) — pending approval` · `approved — 25 candidates invited` · `approved — 20 of 25 candidates invited so far` · `rejected: <approver's note, up to 300 chars>` |

```
Hello {{1}},

Update on your exam request {{2}} for "{{3}}":
{{4}}

You will also receive the full details by email.
```

Notes for approval: use the example values above as the "sample content" Meta asks for. Variables
are plain text (ProctorGuard removes line breaks/tabs and caps each at 1000 characters). A kind whose
template isn't approved yet can simply be left blank in `.env` — the other kinds still work.

### Optional: a "Start exam" link button (INVITE / REMINDER, Meta only)

A template may also carry a **Visit website** button that opens the candidate's link. Keep `{{5}}`
(INVITE) / `{{4}}` (REMINDER) in the body as well — ProctorGuard always sends the body variables.

* **Static URL** (the same for everyone, e.g. `https://proctor.lsc-crm.in`): nothing to configure.
* **Dynamic URL** (personal link per candidate): in Meta set the button URL to
  `https://proctor.lsc-crm.in?{{1}}` (sample value e.g. `Ab3dE5gH9k`) and copy that URL into `.env`
  exactly as written in the template:

  ```
  WHATSAPP_TEMPLATE_INVITE_BUTTON_URL=https://proctor.lsc-crm.in?{{1}}
  WHATSAPP_TEMPLATE_REMINDER_BUTTON_URL=https://proctor.lsc-crm.in?{{1}}
  # only if the link button is not the template's first button (0 = first, 1 = second, ...)
  WHATSAPP_TEMPLATE_INVITE_BUTTON_INDEX=0
  ```

  Each message fills the button's `{{1}}` with the candidate's 10-character short-link code (a
  template written as `https://proctor.lsc-crm.in/?{{1}}` or `https://proctor.lsc-crm.in/x/{{1}}`
  gets the same code). Without this line Meta rejects every message of a template with a dynamic
  button ("number of parameters does not match"). The Settings → WhatsApp test send
  fills the button with the placeholder code `TESTLINK00` (opens the "invalid link" notice).

## 4. Option A — Meta WhatsApp Cloud API (`WHATSAPP_PROVIDER=meta`)

1. In Meta Business Suite / developers.facebook.com create (or reuse) a **WhatsApp Business Account**
   and register the sending phone number. Note its **Phone number ID** (numeric, not the phone number).
2. Create a **System User** with the `whatsapp_business_messaging` permission on that WABA and
   generate a **permanent access token**.
3. In WhatsApp Manager → *Message templates*, create the three templates in §3 and wait for *Active*.
4. Set in the server's `.env`:

```
WHATSAPP_ENABLED=1
WHATSAPP_PROVIDER=meta
WHATSAPP_COUNTRY_CODE=91
WHATSAPP_TEMPLATE_LANGUAGE=en          # the language code the templates were approved in (en, en_US, …)
WHATSAPP_TEMPLATE_INVITE=exam_invite_v1
WHATSAPP_TEMPLATE_REMINDER=exam_reminder_v1
WHATSAPP_TEMPLATE_REQUEST_UPDATE=exam_request_update_v1
WHATSAPP_META_PHONE_NUMBER_ID=123456789012345
WHATSAPP_META_ACCESS_TOKEN=EAAG…        # secret — never commit
WHATSAPP_META_API_VERSION=v21.0         # optional
# WHATSAPP_META_BASE_URL is for tests only — leave it unset in production.
```

What ProctorGuard sends (one request per message, 10 s timeout):

```
POST https://graph.facebook.com/v21.0/{PHONE_NUMBER_ID}/messages
Authorization: Bearer {ACCESS_TOKEN}
Content-Type: application/json

{"messaging_product":"whatsapp","to":"919876543210","type":"template",
 "template":{"name":"exam_invite_v1","language":{"code":"en"},
   "components":[{"type":"body","parameters":[
     {"type":"text","text":"Asha Rao"},{"type":"text","text":"Sales Assessment Q4"}, … ]}]}}
```

Success = HTTP 2xx with `messages[0].id` (stored in the delivery log as `messageId`).

## 5. Option B — LSC gateway (`WHATSAPP_PROVIDER=lsc`)

> The existing `https://mylsc.in/wa/whatsapp_api_verification_code.php` endpoint **cannot** be used:
> it sends a fixed WhatsApp *authentication* (OTP) template that accepts only a short numeric code and
> rejects text with a link. ProctorGuard never routes invitations through it.

LSC IT needs to provide a **template-sending endpoint** with the contract below. Once it exists:

```
WHATSAPP_ENABLED=1
WHATSAPP_PROVIDER=lsc
WHATSAPP_LSC_URL=https://mylsc.in/wa/<new_template_endpoint>.php
WHATSAPP_LSC_TOKEN=<stoken>              # secret — never commit
WHATSAPP_COUNTRY_CODE=91
WHATSAPP_TEMPLATE_LANGUAGE=en
WHATSAPP_TEMPLATE_INVITE=exam_invite_v1
WHATSAPP_TEMPLATE_REMINDER=exam_reminder_v1
WHATSAPP_TEMPLATE_REQUEST_UPDATE=exam_request_update_v1
```

### Endpoint contract (for LSC IT)

**Request** — `POST {WHATSAPP_LSC_URL}`, `Content-Type: application/json`, one message per call:

```json
{
  "stoken": "<shared secret, same idea as the verification-code endpoint>",
  "mobile_number": "919876543210",
  "template": "exam_invite_v1",
  "language": "en",
  "params": ["Asha Rao", "Sales Assessment Q4", "15 Oct 2026, 10:00 – 18:00 IST", "30 minutes", "https://proctor.lsc-crm.in?Ab3dE5gH9k"]
}
```

* `mobile_number`: digits only, country code included, no `+` (same as today's endpoint).
* `template`: the approved template name; `language`: its language code.
* `params`: the template's **body variables in order** — `params[0]` → `{{1}}`, `params[1]` → `{{2}}`, …
  Plain text, no new lines/tabs, each ≤ 1000 characters, never empty (an empty value is sent as `-`).
  The count matches the template (5 / 4 / 4 for INVITE / REMINDER / REQUEST_UPDATE).

**Response** — HTTP 2xx and JSON:

* success: `{"status":"success"}` or `{"success":true}` (optionally with `"message_id": "…"`, which is logged);
* failure: anything else; put a human-readable reason in `"message"` (it is shown to admins in the
  delivery log). Do **not** echo the `stoken` back (ProctorGuard masks it anyway).
* Answer within **10 seconds** (ProctorGuard's timeout; connect timeout 5 s). HTTP 5xx/429 or no answer
  counts as "provider unreachable"; after 5 of those in a row, the rest of that batch fails fast instead
  of waiting on each timeout.

## 6. Testing after switching on

1. Settings → **WhatsApp notifications** should show **Ready via Meta** / **Ready via LSC gateway** and
   a tick next to each kind with a template.
2. **Send test message** (admins): enter your own mobile, pick a kind → a message with sample values
   (no real candidate data). Errors from the provider are shown as-is (secrets masked).
3. Give one test student your mobile, assign them to a test exam, send the invitation with
   **Also send on WhatsApp** ticked, and open the link from the phone.
4. Communications → **Delivery Logs**: every WhatsApp message (SENT / FAILED, with the provider's
   error) appears with a green **WHATSAPP** badge. Template name = subject; a short text preview = body.

Developers can test without contacting Meta/LSC: point `WHATSAPP_META_BASE_URL` (or
`WHATSAPP_LSC_URL`) at a local fake HTTP server that answers in the shapes above.

## 7. How sending works in the app

* **Admin invitations / reminders** (Exams → Notify, Mail Composer): when WhatsApp is ready for that
  kind, the send dialog shows **Also send on WhatsApp (N of M recipients have a mobile number)**,
  ticked by default. After the email batch, the WhatsApp copy goes only to students whose email was
  accepted; the summary shows sent / failed / without a mobile number. WhatsApp problems never undo
  or block the emails.
* **Server-side invitations** (course-completion integration, approved exam requests): the WhatsApp
  copy is sent right after the email is accepted and the invitation is recorded, so retries never
  send a second copy. A WhatsApp failure is logged and otherwise ignored.
* **Exam requests**: the employee gets a WhatsApp copy of the *received*, *approved* and *rejected*
  emails. Nothing is sent for unknown senders, wrong security codes or rate-limited mail.
* API (staff session required): `GET api/whatsapp.php` → `{enabled, provider, ready, kinds, issues}`;
  `POST {action:"SEND_EXAM_NOTICE", examId, studentIds[≤2000], kind:"INVITE"|"REMINDER"}` (admins,
  company-scoped); `POST {action:"TEST", mobile, kind}` (admins); `POST {action:"COVERAGE", studentIds}`.

## 8. Short exam links

Invitation emails, WhatsApp messages and the exported Links CSV use short links
`https://proctor.lsc-crm.in?<10-character code>` instead of the long `/?token=…` link (which
WhatsApp and some mail clients break). Each (exam, candidate) has one permanent code; the page swaps
it for the same signed token through `api/link.php`, so all exam-start checks are unchanged. Links
sent earlier as `https://proctor.lsc-crm.in/x/<code>` and old `/?token=` links keep working. Unknown codes are rate-limited per network (60 misses / 10 minutes).
`APP_ORIGIN` in `.env` sets the origin used in server-built links.

## 9. Troubleshooting

| Symptom (delivery log error) | Likely cause |
|---|---|
| `(#132001) Template name does not exist in the translation` | wrong template name, or wrong `WHATSAPP_TEMPLATE_LANGUAGE` |
| `(#132000) Number of parameters does not match` | the approved template has a different number of variables than §3 |
| `(#131026) Message undeliverable` | the number isn't on WhatsApp |
| `(#190) …access token…` | the Meta token expired or was revoked — issue a permanent System User token |
| `Not sent: the WhatsApp provider failed to respond 5 times in a row…` | the provider was down during that batch; resend later |
| Nothing appears at all | WhatsApp isn't ready for that kind — check Settings → WhatsApp notifications |
