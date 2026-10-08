<?php
declare(strict_types=1);

/**
 * Email-driven exam requests (SUPER_ADMIN only).
 *
 * An authorised employee (exam_requesters — one row per email address, each with its OWN security
 * code stored only as a password_hash) emails a filled-in template to the platform mailbox.
 * scripts/mail_intake.py fetches those messages over IMAP and pipes each one, as JSON, into
 * scripts/exam_request_intake.php, which authenticates the sender + code and records the request
 * here as PENDING (or INVALID). A super admin reviews / edits the particulars in the Exam Requests
 * tab and approves it, which creates an ordinary PUBLISHED exam linked to the question bank (no
 * question rows are copied), enrolls the students and optionally emails their signed exam links.
 *
 * This file is also require_once'd by scripts/exam_request_intake.php for its helper functions
 * (parsing + validation are shared so intake and the approval screen apply exactly the same rules).
 * The $erIsIncluded guard below keeps its HTTP handler from running in that case, the same pattern
 * notify.php / integrations.php use.
 */

require_once __DIR__ . '/_bootstrap.php';
// smtp_open/smtp_deliver/smtp_send/add_delivery_log/html_to_plain. notify.php's own $isIncluded
// guard means requiring it here only defines those functions.
require_once __DIR__ . '/notify.php';
// WhatsApp copies of the invitation and of the requester's status emails. Guarded like notify.php
// (requiring it only defines functions); every send is a no-op until WhatsApp is configured in .env.
require_once __DIR__ . '/whatsapp.php';
// Per-exam invitation email (the same HTML the admin console previews and sends).
require_once __DIR__ . '/exam_mail_render.php';

const ER_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'; // no 0/O/1/I/L
const ER_MAX_STUDENTS = 2000;
const ER_MAX_CSV_BYTES = 2097152; // 2 MB
const ER_RATE_LIMIT_PER_HOUR = 10;
const ER_DEFAULT_TIMEZONE = 'Asia/Kolkata';
const ER_MAX_DURATION = 600;
const ER_RATE_LIMIT_ERROR = 'Rate limited: more than 10 requests in the last hour.';
// One HTTP call sends invitations for at most this many seconds (nginx's fastcgi_read_timeout is 60s);
// the UI continues with SEND_INVITES until nothing remains.
const ER_INVITE_TIME_BUDGET = 25.0;
// New exams get the same defaults the exam editor uses (Settings > Exam defaults / exams.php).
const ER_DEFAULT_TAB_SWITCH_LIMIT = 3;
const ER_DEFAULT_RECONNECT_LIMIT = 3;

// ---------------------------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------------------------

function er_ensure_schema(PDO $pdo): void {
    ensure_exam_request_schema($pdo);
    // exam_requesters.mobile (optional WhatsApp number) + students.mobile + the WHATSAPP log channel.
    whatsapp_schema_once($pdo);
    ensure_question_bank_schema($pdo);
    ensure_exam_proctoring_mode_columns($pdo);
    ensure_student_batches_schema($pdo);
    // Same runtime columns exams.php adds, so an approval never depends on exams.php having run first.
    db_add_column_if_missing($pdo, 'exams', 'timezone', 'VARCHAR(64) NULL AFTER end_time');
    db_add_column_if_missing($pdo, 'exams', 'proctor_timing_json', 'JSON NULL AFTER violation_limits_json');
    db_add_column_if_missing($pdo, 'exams', 'certificate_enabled', 'TINYINT(1) NOT NULL DEFAULT 0');

    // Mirrors ensure_exam_batch_assignment_schema() / ensure_exam_invitation_schema() in exams.php
    // (which can't be included — it has no include guard). Identical DDL + first-run seeding.
    $pdo->exec("CREATE TABLE IF NOT EXISTS exam_batch_assignments (
      exam_id     VARCHAR(64) NOT NULL,
      batch_id    BIGINT UNSIGNED NOT NULL,
      assigned_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (exam_id, batch_id),
      INDEX idx_exam_batch_assignments_batch (batch_id)
    ) ENGINE=InnoDB");
    if (!db_table_exists($pdo, 'exam_invitations')) {
        $pdo->exec("CREATE TABLE IF NOT EXISTS exam_invitations (
          exam_id    VARCHAR(64) NOT NULL,
          student_id VARCHAR(64) NOT NULL,
          sent_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (exam_id, student_id),
          INDEX idx_exam_invitations_student (student_id)
        ) ENGINE=InnoDB");
        $pdo->exec('INSERT IGNORE INTO exam_invitations (exam_id, student_id)
                    SELECT exam_id, student_id FROM exam_assignments');
    }
}

// ---------------------------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------------------------

function er_clip(string $value, int $max): string {
    return mb_substr($value, 0, $max, 'UTF-8');
}

function er_h(string $value): string {
    return htmlspecialchars($value, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
}

function er_json(array $value): string {
    return (string)json_encode($value, JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
}

function er_ts_ms($value): ?int {
    if ($value === null || $value === '') return null;
    $ts = strtotime((string)$value);
    return $ts === false ? null : $ts * 1000;
}

function er_ms_to_datetime(int $ms): string {
    $dt = (new DateTimeImmutable('@' . intdiv($ms, 1000)))->setTimezone(new DateTimeZone('UTC'));
    return $dt->format('Y-m-d H:i:s') . '.' . str_pad((string)($ms % 1000), 3, '0', STR_PAD_LEFT);
}

/** Integer from a JSON/form value; $invalid for anything that is not a whole number. */
function er_int_or($value, int $invalid): int {
    if (is_int($value)) return $value;
    if (is_float($value) && floor($value) === $value && abs($value) < 1e9) return (int)$value;
    if (is_string($value) && preg_match('/^\s*-?\d{1,9}\s*$/', $value)) return (int)trim($value);
    return $invalid;
}

function er_bool($value, bool $default): bool {
    if (is_bool($value)) return $value;
    if (is_int($value)) return $value !== 0;
    if (is_string($value)) {
        $v = strtolower(trim($value));
        if (in_array($v, ['1', 'true', 'yes', 'on'], true)) return true;
        if (in_array($v, ['0', 'false', 'no', 'off'], true)) return false;
    }
    return $default;
}

/** Bare email address from "Name <addr>" / "addr"; '' when there is no valid one. */
function er_extract_address(string $value): string {
    $value = trim($value);
    if (preg_match('/<([^<>\s]+@[^<>\s]+)>/', $value, $m)) {
        $value = $m[1];
    }
    $value = strtolower(trim($value, " \t\"'"));
    return filter_var($value, FILTER_VALIDATE_EMAIL) !== false ? $value : '';
}

/** The address employees send requests to — IMAP_USER, else SMTP_FROM / SMTP_USER. Address only. */
function er_mailbox_address(array $env): string {
    foreach (['IMAP_USER', 'SMTP_FROM', 'SMTP_USER'] as $key) {
        $addr = er_extract_address((string)($env[$key] ?? ''));
        if ($addr !== '') return $addr;
    }
    return '';
}

/** Canonical IANA zone name, or null. Rejects abbreviations ("IST") and raw offsets ("+05:30"). */
function er_canonical_timezone(string $tz): ?string {
    $tz = trim($tz);
    if ($tz === '' || strlen($tz) > 64 || !preg_match('#^[A-Za-z_]+(/[A-Za-z0-9_+\-]+)*$#', $tz)) {
        return null;
    }
    if (strpos($tz, '/') === false && strtoupper($tz) !== 'UTC') {
        return null;
    }
    // Canonical spelling ("asia/dubai" → "Asia/Dubai"): DateTimeZone accepts any case but keeps it.
    static $byLower = null;
    if ($byLower === null) {
        $byLower = [];
        foreach (DateTimeZone::listIdentifiers(DateTimeZone::ALL_WITH_BC) as $id) {
            $byLower[strtolower($id)] = $id;
        }
    }
    if (isset($byLower[strtolower($tz)])) {
        return $byLower[strtolower($tz)];
    }
    try {
        $zone = new DateTimeZone($tz);
    } catch (Throwable $e) {
        return null;
    }
    $name = $zone->getName();
    return strpos($name, '/') !== false || $name === 'UTC' ? $name : null;
}

// ---------------------------------------------------------------------------------------------
// Security codes
// ---------------------------------------------------------------------------------------------

/** A fresh code: ['display' => 'XXXX-XXXX', 'normalized' => 'XXXXXXXX']. */
function er_generate_code(): array {
    $alphabet = ER_CODE_ALPHABET;
    $max = strlen($alphabet) - 1;
    $code = '';
    for ($i = 0; $i < 8; $i++) {
        $code .= $alphabet[random_int(0, $max)];
    }
    return ['display' => substr($code, 0, 4) . '-' . substr($code, 4), 'normalized' => $code];
}

/** Case, spaces and dashes don't matter when an employee types the code. */
function er_normalize_code(string $raw): string {
    return (string)preg_replace('/[^A-Z0-9]/', '', strtoupper($raw));
}

// ---------------------------------------------------------------------------------------------
// Serialisers (match ExamRequest / ExamRequester / ExamRequestDetails in types.ts)
// ---------------------------------------------------------------------------------------------

function er_default_details(): array {
    return [
        'title' => '',
        'questionBankId' => null,
        'questionBankName' => '',
        'questionCount' => 0,
        'durationMinutes' => 0,
        'passPercent' => 60,
        'startTime' => null,
        'endTime' => null,
        'timezone' => ER_DEFAULT_TIMEZONE,
        'proctoringMode' => 'PROCTORED',
        'cameraRequired' => true,
        'microphoneRequired' => true,
        'showAlerts' => true,
        'autoTerminate' => true,
        'batchName' => null,
        'notes' => '',
    ];
}

/**
 * Coerce any details-shaped array (UI payload or stored JSON) into exactly ExamRequestDetails.
 * Values that are present but not whole numbers become sentinels (-1 / 0) so validation keeps
 * flagging them instead of silently turning them into a default.
 */
function er_normalize_details(array $in): array {
    $d = er_default_details();
    $d['title'] = er_clip(trim((string)($in['title'] ?? '')), 255);
    $bankId = $in['questionBankId'] ?? null;
    $d['questionBankId'] = (is_int($bankId) || (is_string($bankId) && ctype_digit($bankId))) && (int)$bankId > 0 ? (int)$bankId : null;
    $d['questionBankName'] = er_clip(trim((string)($in['questionBankName'] ?? '')), 255);
    $d['questionCount'] = er_int_or($in['questionCount'] ?? 0, -1);
    $d['durationMinutes'] = er_int_or($in['durationMinutes'] ?? 0, 0);
    $d['passPercent'] = er_int_or($in['passPercent'] ?? 60, -1);
    foreach (['startTime', 'endTime'] as $key) {
        $v = $in[$key] ?? null;
        $d[$key] = (is_int($v) || (is_float($v) && is_finite($v)) || (is_string($v) && preg_match('/^\d{10,15}$/', $v))) ? (int)$v : null;
    }
    $tz = trim((string)($in['timezone'] ?? ''));
    $d['timezone'] = $tz !== '' ? er_clip($tz, 64) : ER_DEFAULT_TIMEZONE;
    $d['proctoringMode'] = strtoupper(trim((string)($in['proctoringMode'] ?? 'PROCTORED'))) === 'UNPROCTORED' ? 'UNPROCTORED' : 'PROCTORED';
    $d['cameraRequired'] = er_bool($in['cameraRequired'] ?? null, $d['proctoringMode'] === 'PROCTORED');
    $d['microphoneRequired'] = er_bool($in['microphoneRequired'] ?? null, $d['cameraRequired']);
    $d['showAlerts'] = er_bool($in['showAlerts'] ?? null, true);
    $d['autoTerminate'] = er_bool($in['autoTerminate'] ?? null, true);
    $batch = trim((string)($in['batchName'] ?? ''));
    $d['batchName'] = $batch !== '' ? er_clip($batch, 255) : null;
    $d['notes'] = er_clip(trim((string)($in['notes'] ?? '')), 5000);
    if ($d['proctoringMode'] === 'UNPROCTORED') {
        $d['cameraRequired'] = false;
        $d['microphoneRequired'] = false;
    }
    return $d;
}

/** Coerce a student list into ExamRequestStudent[] (trimmed, email lowercased). */
function er_normalize_students(array $in): array {
    $out = [];
    foreach ($in as $row) {
        if (!is_array($row)) continue;
        $s = [
            'fullName' => er_clip(trim((string)($row['fullName'] ?? '')), 300),
            'email' => er_clip(strtolower(trim((string)($row['email'] ?? ''))), 300),
            'registrationId' => er_clip(trim((string)($row['registrationId'] ?? '')), 200),
        ];
        if ($s['fullName'] === '' && $s['email'] === '' && $s['registrationId'] === '') continue;
        $out[] = $s;
    }
    return $out;
}

function er_decode_json_list($raw): array {
    if ($raw === null || $raw === '') return [];
    $decoded = json_decode((string)$raw, true);
    return is_array($decoded) ? array_values($decoded) : [];
}

function er_requester_public(array $row): array {
    return [
        'id' => (int)$row['id'],
        'companyId' => (int)$row['company_id'],
        'companyName' => $row['company_name'] ?? null,
        'name' => (string)$row['name'],
        'email' => (string)$row['email'],
        'mobile' => isset($row['mobile']) && trim((string)$row['mobile']) !== '' ? (string)$row['mobile'] : null,
        'status' => (string)$row['status'],
        'codeHint' => $row['code_hint'] !== null ? (string)$row['code_hint'] : null,
        'createdAt' => er_ts_ms($row['created_at']) ?? 0,
        'lastRequestAt' => er_ts_ms($row['last_request_at'] ?? null),
    ];
}

/**
 * Optional WhatsApp mobile from a requester payload: [provided, normalised digits|null, error|null].
 * Absent/null = not provided (leave as is); '' = clear; otherwise must be a valid number.
 */
function er_requester_mobile_input(array $payload, array $env): array {
    if (!array_key_exists('mobile', $payload) || $payload['mobile'] === null) {
        return [false, null, null];
    }
    $raw = is_scalar($payload['mobile']) ? trim((string)$payload['mobile']) : '[invalid]';
    if ($raw === '') {
        return [true, null, null];
    }
    $mobile = normalize_mobile($raw, (string)whatsapp_config($env)['countryCode']);
    if ($mobile === null) {
        return [true, null, 'Enter a valid mobile number (10 digits, or + and the country code), or leave it blank.'];
    }
    return [true, $mobile, null];
}

function er_request_public(array $row, bool $withStudents = true): array {
    $detailsRaw = $row['details_json'] ?? null;
    $decoded = $detailsRaw !== null && $detailsRaw !== '' ? json_decode((string)$detailsRaw, true) : null;
    $students = er_decode_json_list($row['students_json'] ?? null);
    return [
        'id' => (int)$row['id'],
        'companyId' => $row['company_id'] !== null ? (int)$row['company_id'] : null,
        'companyName' => $row['company_name'] ?? null,
        'requesterId' => $row['requester_id'] !== null ? (int)$row['requester_id'] : null,
        'requesterName' => $row['requester_name'] ?? null,
        'senderEmail' => (string)$row['sender_email'],
        'senderName' => $row['sender_name'] ?? null,
        'subject' => (string)($row['subject'] ?? ''),
        'status' => (string)$row['status'],
        'details' => is_array($decoded) ? er_normalize_details($decoded) : er_default_details(),
        'students' => $withStudents ? $students : [],
        'studentCount' => count($students),
        'errors' => array_values(array_map('strval', er_decode_json_list($row['errors_json'] ?? null))),
        'receivedAt' => er_ts_ms($row['received_at']) ?? 0,
        'reviewedBy' => $row['reviewed_by'] ?? null,
        'reviewedAt' => er_ts_ms($row['reviewed_at'] ?? null),
        'reviewNote' => $row['review_note'] ?? null,
        'createdExamId' => $row['created_exam_id'] ?? null,
        'createdExamTitle' => $row['created_exam_title'] ?? null,
        // Approved requests: students enrolled in the created exam / still waiting for their link.
        'assignedCount' => isset($row['assigned_count']) ? (int)$row['assigned_count'] : 0,
        'pendingInviteCount' => isset($row['pending_invite_count']) ? (int)$row['pending_invite_count'] : 0,
        'bodyRedacted' => $row['body_redacted'] ?? null,
    ];
}

const ER_REQUEST_SELECT = 'SELECT r.*, c.name AS company_name, q.name AS requester_name, e.title AS created_exam_title,
                                  (SELECT COUNT(*) FROM exam_assignments ea WHERE ea.exam_id = r.created_exam_id) AS assigned_count,
                                  (SELECT COUNT(*) FROM exam_assignments ea
                                     LEFT JOIN exam_invitations ei ON ei.exam_id = ea.exam_id AND ei.student_id = ea.student_id
                                    WHERE ea.exam_id = r.created_exam_id AND ei.student_id IS NULL) AS pending_invite_count
                             FROM exam_requests r
                             LEFT JOIN companies c ON c.id = r.company_id
                             LEFT JOIN exam_requesters q ON q.id = r.requester_id
                             LEFT JOIN exams e ON e.id = r.created_exam_id';

function er_fetch_request(PDO $pdo, int $id, bool $forUpdate = false): ?array {
    if ($forUpdate) {
        $stmt = $pdo->prepare('SELECT * FROM exam_requests WHERE id = ? FOR UPDATE');
    } else {
        $stmt = $pdo->prepare(ER_REQUEST_SELECT . ' WHERE r.id = ? LIMIT 1');
    }
    $stmt->execute([$id]);
    $row = $stmt->fetch();
    $stmt->closeCursor();
    return $row ?: null;
}

function er_fetch_requester(PDO $pdo, int $id): ?array {
    $stmt = $pdo->prepare('SELECT q.*, c.name AS company_name FROM exam_requesters q LEFT JOIN companies c ON c.id = q.company_id WHERE q.id = ? LIMIT 1');
    $stmt->execute([$id]);
    $row = $stmt->fetch();
    $stmt->closeCursor();
    return $row ?: null;
}

function er_company_name(PDO $pdo, ?int $companyId): string {
    if ($companyId === null || $companyId <= 0) return 'ProctorGuard';
    $stmt = $pdo->prepare('SELECT name FROM companies WHERE id = ? LIMIT 1');
    $stmt->execute([$companyId]);
    $name = (string)($stmt->fetchColumn() ?: '');
    $stmt->closeCursor();
    return $name !== '' ? $name : ('Company ' . $companyId);
}

// ---------------------------------------------------------------------------------------------
// Email template parsing (intake)
// ---------------------------------------------------------------------------------------------

/** Normalised "Key" → field. Keys are case-, space- and punctuation-insensitive. */
function er_field_aliases(): array {
    static $map = null;
    if ($map !== null) return $map;
    $groups = [
        'code' => ['securitycode', 'code', 'security', 'accesscode', 'passcode', 'employeecode', 'requestcode'],
        'title' => ['examtitle', 'title', 'examname', 'nameofexam', 'assessmenttitle', 'assessmentname'],
        'bank' => ['questionbank', 'bank', 'questionbankname', 'qbank', 'questionsbank'],
        'count' => ['numberofquestions', 'questions', 'questioncount', 'noofquestions', 'numquestions', 'totalquestions', 'numberofquestion', 'questionsperstudent'],
        'duration' => ['duration', 'durationminutes', 'minutes', 'durationmins', 'durationinminutes', 'timelimit', 'examduration', 'mins'],
        'pass' => ['passpercentage', 'passpercent', 'passmark', 'passmarks', 'passingpercentage', 'pass', 'passingscore', 'cutoff', 'passpct'],
        'start' => ['start', 'starttime', 'startdate', 'startdatetime', 'starts', 'examstart', 'opens', 'startat'],
        'end' => ['end', 'endtime', 'enddate', 'enddatetime', 'ends', 'examend', 'closes', 'endat'],
        'timezone' => ['timezone', 'tz', 'zone', 'timezoneiana'],
        'proctoring' => ['proctoring', 'proctoringmode', 'mode', 'proctored', 'examtype', 'proctor'],
        'camera' => ['camera', 'webcam', 'cameraon', 'camerarequired', 'video'],
        'mic' => ['microphone', 'mic', 'audio', 'microphonerequired', 'microphoneon'],
        'alerts' => ['showalerts', 'alerts', 'showviolationalerts', 'violationalerts', 'warnings', 'showwarnings'],
        'terminate' => ['throwoutonviolations', 'throwout', 'terminate', 'autoterminate', 'terminateonviolations', 'throwoutofexam', 'throwoutonviolation', 'removeonviolations', 'kickout'],
        'batch' => ['batch', 'batchname', 'studentbatch'],
        'notes' => ['notes', 'note', 'comments', 'comment', 'remarks'],
    ];
    $map = [];
    foreach ($groups as $field => $aliases) {
        foreach ($aliases as $alias) {
            $map[$alias] = $field;
        }
    }
    return $map;
}

/** Which template field a "Key" names, or null. "Duration (minutes)" and "Duration" both match. */
function er_match_field(string $key): ?string {
    if (mb_strlen($key, 'UTF-8') > 48) return null;
    $aliases = er_field_aliases();
    $lower = mb_strtolower($key, 'UTF-8');
    $withoutParens = (string)preg_replace('/\([^()]*\)/u', '', $lower);
    foreach ([$withoutParens, $lower] as $candidate) {
        $norm = (string)preg_replace('/[^a-z0-9]/', '', $candidate);
        if ($norm !== '' && isset($aliases[$norm])) return $aliases[$norm];
    }
    return null;
}

/** Drop trailing "(…)" template comments. Structured values (numbers/enums/dates) lose any. */
function er_strip_comment(string $value, bool $structured): string {
    $value = trim($value);
    if ($structured) {
        $prev = null;
        while ($prev !== $value) {
            $prev = $value;
            $value = trim((string)preg_replace('/\([^()]*\)\s*$/u', '', $value));
        }
        return $value;
    }
    // Free text keeps "Sales (Q4)"; only a comment set off by 2+ spaces (template style) or a value
    // that is nothing but a comment is removed.
    return trim((string)preg_replace('/(^|\s{2,})\([^()]*\)$/u', '', $value));
}

/**
 * "Key: value" lines → ['code' => raw, 'title' => raw, ...]. Quoted-reply lines (">") are ignored and
 * parsing stops at a signature delimiter ("-- ") or a quoted-reply header. Notes may continue onto
 * following lines until a blank line or the next recognised key. The first occurrence of a key wins.
 */
function er_parse_fields(string $text): array {
    $fields = [];
    $notesOpen = false;
    $lines = preg_split('/\r\n|\r|\n/', $text) ?: [];
    foreach ($lines as $line) {
        $line = str_replace(["\u{00A0}", "\t"], ' ', $line);
        $trim = trim($line);
        if ($trim !== '' && $trim[0] === '>') {
            $notesOpen = false;
            continue;
        }
        if (rtrim($line) === '--' || preg_match('/^On .{4,200} wrote:$/u', $trim) || preg_match('/^-{2,}\s*Original Message\s*-{2,}$/i', $trim)) {
            break;
        }
        $colon = strpos($trim, ':');
        if ($colon !== false && $colon > 0) {
            $key = trim(substr($trim, 0, $colon), " *_");
            $field = er_match_field($key);
            if ($field !== null) {
                $value = trim(substr($trim, $colon + 1), " *_");
                if (!array_key_exists($field, $fields)) {
                    $fields[$field] = $value;
                }
                $notesOpen = ($field === 'notes');
                continue;
            }
        }
        if ($notesOpen) {
            if ($trim === '') {
                $notesOpen = false;
                continue;
            }
            $fields['notes'] .= "\n" . $trim;
        }
    }
    return $fields;
}

/** Body as stored: the Security Code line removed and any other occurrence of the code masked. */
function er_redact_body(string $text, string $rawCode): string {
    $out = [];
    foreach (preg_split('/\r\n|\r|\n/', $text) ?: [] as $line) {
        $trim = trim(str_replace("\u{00A0}", ' ', $line));
        $colon = strpos($trim, ':');
        if ($colon !== false && $colon > 0) {
            $key = trim(ltrim(substr($trim, 0, $colon), "> "), " *_");
            if (er_match_field($key) === 'code') {
                continue;
            }
        }
        $out[] = $line;
    }
    $body = implode("\n", $out);
    $body = er_mask_code($body, $rawCode);
    return mb_substr($body, 0, 60000, 'UTF-8');
}

/** Mask the code wherever it appears (with or without its dash, any case). */
function er_mask_code(string $text, string $rawCode): string {
    $norm = er_normalize_code($rawCode);
    if (strlen($norm) < 4) return $text;
    // Allow optional spaces / dashes between characters.
    $pattern = '/' . implode('[\s\-]*', array_map(static fn($c) => preg_quote($c, '/'), str_split($norm))) . '/i';
    return (string)preg_replace($pattern, '[code removed]', $text);
}

/** Parse "YYYY-MM-DD HH:MM", "DD-MM-YYYY HH:MM" or "DD/MM/YYYY HH:MM" (optional AM/PM) in $tz → UTC ms. */
function er_parse_datetime(string $raw, DateTimeZone $tz): ?int {
    $v = strtoupper(trim((string)preg_replace('/\s+/u', ' ', $raw)));
    $v = str_replace(['A.M.', 'P.M.', 'A.M', 'P.M'], ['AM', 'PM', 'AM', 'PM'], $v);
    $time = '(\d{1,2})[:.](\d{2})(?::(\d{2}))?\s*(AM|PM)?';
    $sep = '(?:\s*T\s*|\s*,\s*|\s+(?:AT\s+)?)';
    if (preg_match('/^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})' . $sep . $time . '$/', $v, $m)) {
        [$y, $mo, $d] = [(int)$m[1], (int)$m[2], (int)$m[3]];
    } elseif (preg_match('/^(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{4})' . $sep . $time . '$/', $v, $m)) {
        [$d, $mo, $y] = [(int)$m[1], (int)$m[2], (int)$m[3]];
    } else {
        return null;
    }
    $h = (int)$m[4];
    $mi = (int)$m[5];
    $ampm = $m[7] ?? '';
    if ($mi > 59 || !checkdate($mo, $d, $y) || $y < 2000 || $y > 2100) return null;
    if ($ampm !== '') {
        if ($h < 1 || $h > 12) return null;
        $h = ($h % 12) + ($ampm === 'PM' ? 12 : 0);
    } elseif ($h > 23) {
        return null;
    }
    try {
        $dt = new DateTimeImmutable(sprintf('%04d-%02d-%02d %02d:%02d:00', $y, $mo, $d, $h, $mi), $tz);
    } catch (Throwable $e) {
        return null;
    }
    return $dt->getTimestamp() * 1000;
}

function er_parse_switch(string $raw): ?bool {
    $v = (string)preg_replace('/[^A-Z0-9]/', '', strtoupper($raw));
    if (in_array($v, ['ON', 'YES', 'Y', 'TRUE', '1', 'ENABLED', 'ENABLE', 'REQUIRED', 'SHOW'], true)) return true;
    if (in_array($v, ['OFF', 'NO', 'N', 'FALSE', '0', 'DISABLED', 'DISABLE', 'NOTREQUIRED', 'NONE', 'HIDE', 'DONTSHOW'], true)) return false;
    return null;
}

/**
 * students.csv (Full Name, Email, Registration ID; header optional; UTF-8 or Windows-1252).
 * Every row is kept — invalid ones too — so validation can point at them and the super admin can
 * fix or remove them on the approval screen. Exact email duplicates are dropped (first one wins).
 * Returns [students, errors].
 */
function er_parse_students_csv(string $bytes): array {
    $errors = [];
    if (strncmp($bytes, "\xEF\xBB\xBF", 3) === 0) {
        $bytes = substr($bytes, 3);
    }
    if (!mb_check_encoding($bytes, 'UTF-8')) {
        $bytes = (string)mb_convert_encoding($bytes, 'UTF-8', 'Windows-1252');
    }
    $firstLine = strtok($bytes, "\r\n") ?: '';
    $delimiter = ',';
    foreach ([';', "\t"] as $alt) {
        if (substr_count($firstLine, $alt) > substr_count($firstLine, $delimiter)) {
            $delimiter = $alt;
        }
    }
    $fh = fopen('php://temp', 'r+');
    fwrite($fh, $bytes);
    rewind($fh);
    $rows = [];
    while (($cells = fgetcsv($fh, 0, $delimiter, '"', '')) !== false) {
        $cells = array_map(static fn($c) => trim((string)$c), $cells);
        if (count(array_filter($cells, static fn($c) => $c !== '')) === 0) continue;
        $rows[] = $cells;
    }
    fclose($fh);
    if (count($rows) === 0) {
        return [[], ['The students CSV is empty.']];
    }

    $cols = ['name' => 0, 'email' => 1, 'reg' => 2];
    $first = $rows[0];
    $looksLikeHeader = false;
    foreach ($first as $cell) {
        if (strpos($cell, '@') !== false) { $looksLikeHeader = false; break; }
        if (preg_match('/e-?mail/i', $cell)) $looksLikeHeader = true;
    }
    if ($looksLikeHeader) {
        $found = [];
        foreach ($first as $idx => $cell) {
            $k = (string)preg_replace('/[^a-z]/', '', strtolower($cell));
            if (!isset($found['email']) && in_array($k, ['email', 'emailaddress', 'mail', 'emailid', 'studentemail'], true)) $found['email'] = $idx;
            elseif (!isset($found['name']) && in_array($k, ['fullname', 'name', 'studentname', 'candidatename', 'candidate', 'student'], true)) $found['name'] = $idx;
            elseif (!isset($found['reg']) && in_array($k, ['registrationid', 'registration', 'regid', 'regno', 'registrationno', 'registrationnumber', 'rollno', 'rollnumber', 'studentid', 'id', 'employeeid', 'empid'], true)) $found['reg'] = $idx;
        }
        if (isset($found['email'])) {
            $cols = array_merge($cols, $found);
        }
        array_shift($rows);
    }

    $students = [];
    $seen = [];
    foreach ($rows as $cells) {
        $s = [
            'fullName' => er_clip((string)($cells[$cols['name']] ?? ''), 300),
            'email' => er_clip(strtolower((string)($cells[$cols['email']] ?? '')), 300),
            'registrationId' => er_clip((string)($cells[$cols['reg']] ?? ''), 200),
        ];
        $key = $s['email'] !== '' ? 'e:' . $s['email'] : 'r:' . implode('|', $s);
        if (isset($seen[$key])) continue;
        $seen[$key] = true;
        $students[] = $s;
    }
    if (count($students) > ER_MAX_STUDENTS) {
        $errors[] = 'The students CSV has ' . count($students) . ' students; at most ' . ER_MAX_STUDENTS . ' are allowed per request, so only the first ' . ER_MAX_STUDENTS . ' were kept.';
        $students = array_slice($students, 0, ER_MAX_STUDENTS);
    }
    return [$students, $errors];
}

/**
 * Turn a parsed email (fields + attachments) into [details, students, parseErrors, hints].
 * parseErrors are values that could not be read and fell back to a default (switches, CSV problems).
 * Values that stay invalid (unreadable duration, dates, counts) are left as sentinels for
 * er_validate() to report; `hints` carries what the employee actually wrote so its message can
 * quote it.
 */
function er_details_from_email(array $fields, array $attachments): array {
    $errors = [];
    $hints = [];
    $d = er_default_details();
    $d['title'] = er_clip(er_strip_comment((string)($fields['title'] ?? ''), false), 255);
    $d['questionBankName'] = er_clip(er_strip_comment((string)($fields['bank'] ?? ''), false), 255);

    if (isset($fields['count'])) {
        $raw = er_strip_comment($fields['count'], true);
        $norm = (string)preg_replace('/[^A-Z0-9]/', '', strtoupper($raw));
        if ($norm === '' || in_array($norm, ['ALL', 'ALLQUESTIONS', 'WHOLEBANK', 'ENTIREBANK', '0'], true)) {
            $d['questionCount'] = 0;
        } elseif (preg_match('/^\d{1,6}$/', $raw)) {
            $d['questionCount'] = (int)$raw;
        } else {
            $d['questionCount'] = -1;
            $hints['count'] = er_clip($raw, 40);
        }
    }

    if (isset($fields['duration'])) {
        $raw = strtolower(er_strip_comment($fields['duration'], true));
        if (preg_match('/^(\d{1,5})\s*(m|min|mins|minute|minutes)?\.?$/', $raw, $m)) {
            $d['durationMinutes'] = (int)$m[1];
        } elseif (preg_match('/^(\d{1,3}(?:\.\d+)?)\s*(h|hr|hrs|hour|hours)\.?$/', $raw, $m)) {
            $d['durationMinutes'] = (int)round((float)$m[1] * 60);
        } else {
            $d['durationMinutes'] = 0;
            if ($raw !== '') $hints['duration'] = er_clip($raw, 40);
        }
    }

    if (isset($fields['pass']) && er_strip_comment($fields['pass'], true) !== '') {
        $raw = er_strip_comment($fields['pass'], true);
        if (preg_match('/^(\d{1,3})\s*%?$/', $raw, $m)) {
            $d['passPercent'] = (int)$m[1];
        } else {
            $d['passPercent'] = -1;
            $hints['pass'] = er_clip($raw, 40);
        }
    }

    $tzRaw = er_strip_comment((string)($fields['timezone'] ?? ''), true);
    $tzName = $tzRaw === '' ? ER_DEFAULT_TIMEZONE : er_canonical_timezone($tzRaw);
    $d['timezone'] = $tzName ?? er_clip($tzRaw, 64);
    $zone = new DateTimeZone($tzName ?? ER_DEFAULT_TIMEZONE);
    foreach (['start' => 'startTime', 'end' => 'endTime'] as $field => $key) {
        $raw = er_strip_comment((string)($fields[$field] ?? ''), true);
        if ($raw === '') continue;
        if ($tzName === null) {
            // Can't place the wall-clock time without a valid zone.
            $hints[$field . 'NeedsTimezone'] = true;
            continue;
        }
        $ms = er_parse_datetime($raw, $zone);
        if ($ms === null) {
            $hints[$field] = er_clip($raw, 40);
        }
        $d[$key] = $ms;
    }

    if (isset($fields['proctoring']) && er_strip_comment($fields['proctoring'], true) !== '') {
        $raw = er_strip_comment($fields['proctoring'], true);
        $norm = (string)preg_replace('/[^A-Z]/', '', strtoupper($raw));
        if (in_array($norm, ['UNPROCTORED', 'NONPROCTORED', 'NOTPROCTORED', 'NO', 'OFF', 'NONE', 'FALSE'], true)) {
            $d['proctoringMode'] = 'UNPROCTORED';
        } elseif (in_array($norm, ['PROCTORED', 'PROCTOR', 'YES', 'ON', 'TRUE'], true)) {
            $d['proctoringMode'] = 'PROCTORED';
        } else {
            $errors[] = 'Proctoring "' . er_clip($raw, 40) . '" was not understood (use PROCTORED or UNPROCTORED); defaulted to PROCTORED.';
        }
    }
    $proctored = $d['proctoringMode'] === 'PROCTORED';

    $switches = [
        'camera' => ['cameraRequired', 'Camera', $proctored, 'ON or OFF'],
        'alerts' => ['showAlerts', 'Show Alerts', true, 'YES or NO'],
        'terminate' => ['autoTerminate', 'Throw Out On Violations', true, 'YES or NO'],
    ];
    foreach ($switches as $field => [$key, $label, $default, $hint]) {
        $d[$key] = $default;
        $raw = er_strip_comment((string)($fields[$field] ?? ''), true);
        if ($raw === '') continue;
        $val = er_parse_switch($raw);
        if ($val === null) {
            $errors[] = "{$label} \"" . er_clip($raw, 40) . "\" was not understood (use {$hint}); defaulted to " . ($default ? 'YES/ON' : 'NO/OFF') . '.';
        } else {
            $d[$key] = $val;
        }
    }
    $d['microphoneRequired'] = $d['cameraRequired'];
    $micRaw = er_strip_comment((string)($fields['mic'] ?? ''), true);
    if ($micRaw !== '') {
        $val = er_parse_switch($micRaw);
        if ($val === null) {
            $errors[] = 'Microphone "' . er_clip($micRaw, 40) . '" was not understood (use ON or OFF); defaulted to the Camera setting.';
        } else {
            $d['microphoneRequired'] = $val;
        }
    }
    if (!$proctored) {
        $d['cameraRequired'] = false;
        $d['microphoneRequired'] = false;
    }

    $batch = er_strip_comment((string)($fields['batch'] ?? ''), false);
    $d['batchName'] = $batch !== '' ? er_clip($batch, 255) : null;
    $d['notes'] = er_clip(trim((string)($fields['notes'] ?? '')), 5000);

    // First .csv attachment.
    $students = [];
    foreach ($attachments as $att) {
        if (!is_array($att)) continue;
        $name = strtolower(trim((string)($att['filename'] ?? '')));
        $type = strtolower(trim((string)($att['contentType'] ?? '')));
        $isCsv = substr($name, -4) === '.csv' || in_array($type, ['text/csv', 'application/csv', 'text/comma-separated-values'], true);
        if (!$isCsv) continue;
        if (!empty($att['tooLarge']) || (int)($att['size'] ?? 0) > ER_MAX_CSV_BYTES) {
            $errors[] = 'The students CSV "' . er_clip((string)($att['filename'] ?? ''), 80) . '" is larger than 2 MB and was ignored.';
            break;
        }
        $bytes = base64_decode((string)($att['base64'] ?? ''), true);
        if ($bytes === false) {
            $errors[] = 'The students CSV attachment could not be read.';
            break;
        }
        if (strlen($bytes) > ER_MAX_CSV_BYTES) {
            $errors[] = 'The students CSV is larger than 2 MB and was ignored.';
            break;
        }
        [$students, $csvErrors] = er_parse_students_csv($bytes);
        $errors = array_merge($errors, $csvErrors);
        break;
    }

    return [$d, $students, $errors, $hints];
}

// ---------------------------------------------------------------------------------------------
// Validation (shared by intake, UPDATE and APPROVE)
// ---------------------------------------------------------------------------------------------

function er_find_bank(PDO $pdo, int $companyId, ?int $bankId, string $bankName): ?array {
    $sql = 'SELECT b.id, b.name, (SELECT COUNT(*) FROM question_bank_items i WHERE i.bank_id = b.id) AS question_count
              FROM question_banks b WHERE b.company_id = ? AND ';
    if ($bankId !== null) {
        $stmt = $pdo->prepare($sql . 'b.id = ? LIMIT 1');
        $stmt->execute([$companyId, $bankId]);
    } else {
        $stmt = $pdo->prepare($sql . 'LOWER(TRIM(b.name)) = LOWER(?) LIMIT 1');
        $stmt->execute([$companyId, trim($bankName)]);
    }
    $row = $stmt->fetch();
    $stmt->closeCursor();
    return $row ?: null;
}

function er_find_batch(PDO $pdo, int $companyId, string $name): ?array {
    $stmt = $pdo->prepare('SELECT b.id, b.name, (SELECT COUNT(*) FROM student_batches sb WHERE sb.batch_id = b.id) AS member_count
                             FROM batches b WHERE b.company_id = ? AND LOWER(TRIM(b.name)) = LOWER(?) LIMIT 1');
    $stmt->execute([$companyId, trim($name)]);
    $row = $stmt->fetch();
    $stmt->closeCursor();
    return $row ?: null;
}

/**
 * Existing students of the company keyed by lowercased email and registration id, for the students in
 * $students — the same per-company match students.php uses.
 */
function er_existing_student_maps(PDO $pdo, int $companyId, array $students): array {
    $byEmail = [];
    $byReg = [];
    $emails = array_values(array_unique(array_filter(array_map(static fn($s) => $s['email'], $students))));
    $regs = array_values(array_unique(array_filter(array_map(static fn($s) => $s['registrationId'], $students))));
    foreach ([['email', $emails], ['registration_id', $regs]] as [$col, $values]) {
        foreach (array_chunk($values, 500) as $chunk) {
            $ph = implode(',', array_fill(0, count($chunk), '?'));
            $stmt = $pdo->prepare("SELECT id, email, registration_id FROM students WHERE company_id = ? AND {$col} IN ($ph)");
            $stmt->execute(array_merge([$companyId], $chunk));
            foreach ($stmt->fetchAll() as $row) {
                $byEmail[mb_strtolower((string)$row['email'], 'UTF-8')] = (string)$row['id'];
                $byReg[mb_strtolower((string)$row['registration_id'], 'UTF-8')] = (string)$row['id'];
            }
            $stmt->closeCursor();
        }
    }
    return [$byEmail, $byReg];
}

/**
 * Validate (and canonicalise) a request for $companyId. Returns [details, errors, meta]; details has
 * the bank id/name, batch name and timezone resolved to their canonical forms. meta carries
 * bankId/bankSize/batchId/batchMembers for the approval step, and newBatch when the batch name is
 * not an existing batch (approval then creates it from the CSV students). $hints (intake only, see
 * er_details_from_email) lets a message quote what the employee wrote.
 */
function er_validate(PDO $pdo, ?int $companyId, array $details, array $students, array $hints = []): array {
    $d = er_normalize_details($details);
    $errors = [];
    $meta = ['bankId' => null, 'bankSize' => 0, 'batchId' => null, 'batchMembers' => 0, 'newBatch' => false];
    if ($companyId === null || $companyId <= 0) {
        return [$d, ['This request is not linked to a company.'], $meta];
    }
    $companyName = er_company_name($pdo, $companyId);

    if ($d['title'] === '') {
        $errors[] = 'Exam Title is required.';
    }

    if ($d['questionBankId'] === null && $d['questionBankName'] === '') {
        $errors[] = 'Question Bank is required.';
    } else {
        $bank = er_find_bank($pdo, $companyId, $d['questionBankId'], $d['questionBankName']);
        if (!$bank) {
            $label = $d['questionBankName'] !== '' ? $d['questionBankName'] : ('#' . $d['questionBankId']);
            $errors[] = "Question bank \"{$label}\" was not found in {$companyName}.";
            $d['questionBankId'] = null;
        } else {
            $d['questionBankId'] = (int)$bank['id'];
            $d['questionBankName'] = (string)$bank['name'];
            $meta['bankId'] = (int)$bank['id'];
            $meta['bankSize'] = (int)$bank['question_count'];
            if ($meta['bankSize'] === 0) {
                $errors[] = "Question bank \"{$bank['name']}\" has no questions yet.";
            }
        }
    }

    if ($d['questionCount'] < 0) {
        $errors[] = isset($hints['count'])
            ? "Number of Questions \"{$hints['count']}\" must be ALL or a whole number."
            : 'Number of Questions must be ALL or a whole number.';
    } elseif ($meta['bankId'] !== null && $meta['bankSize'] > 0 && $d['questionCount'] > $meta['bankSize']) {
        $errors[] = "Number of Questions ({$d['questionCount']}) is more than the {$meta['bankSize']} questions in bank \"{$d['questionBankName']}\".";
    }

    if ($d['durationMinutes'] < 1 || $d['durationMinutes'] > ER_MAX_DURATION) {
        $errors[] = isset($hints['duration'])
            ? "Duration \"{$hints['duration']}\" is not a number of minutes (1-" . ER_MAX_DURATION . ').'
            : 'Duration must be between 1 and ' . ER_MAX_DURATION . ' minutes.';
    }
    if ($d['passPercent'] < 0 || $d['passPercent'] > 100) {
        $errors[] = isset($hints['pass'])
            ? "Pass Percentage \"{$hints['pass']}\" must be a number from 0 to 100."
            : 'Pass Percentage must be between 0 and 100.';
    }

    $tz = er_canonical_timezone($d['timezone']);
    if ($tz === null) {
        $errors[] = "Timezone \"{$d['timezone']}\" is not a valid IANA timezone (e.g. Asia/Kolkata, Asia/Dubai, Europe/London).";
    } else {
        $d['timezone'] = $tz;
    }

    foreach (['start' => 'startTime', 'end' => 'endTime'] as $field => $key) {
        if ($d[$key] !== null) continue;
        $label = ucfirst($field);
        if (isset($hints[$field])) {
            $errors[] = "{$label} \"{$hints[$field]}\" is not a valid date/time — use YYYY-MM-DD HH:MM (e.g. 2026-10-15 10:00).";
        } elseif (!empty($hints[$field . 'NeedsTimezone'])) {
            $errors[] = "{$label} could not be read because the Timezone is not valid — fix the timezone and set {$field} again.";
        } else {
            $errors[] = "{$label} date/time is required (YYYY-MM-DD HH:MM).";
        }
    }
    if ($d['startTime'] !== null && $d['endTime'] !== null && $d['endTime'] <= $d['startTime']) {
        $errors[] = 'End must be later than Start.';
    }
    if ($d['startTime'] !== null && $d['startTime'] < db_now_ms() - 3600 * 1000) {
        $errors[] = 'Start is in the past — choose a new start time.';
    }

    if ($d['batchName'] !== null) {
        // Matched case-insensitively, so "batch 7" never creates a near-duplicate of "Batch 7".
        $batch = er_find_batch($pdo, $companyId, $d['batchName']);
        if ($batch) {
            $d['batchName'] = (string)$batch['name'];
            $meta['batchId'] = (int)$batch['id'];
            $meta['batchMembers'] = (int)$batch['member_count'];
        } elseif (count($students) > 0) {
            // A name that isn't a batch yet: approval creates it with this request's CSV students.
            $meta['newBatch'] = true;
        } else {
            $errors[] = "Batch \"{$d['batchName']}\" does not exist in {$companyName}. To create it, attach a students CSV (Full Name, Email, Registration ID) — those students become the new batch.";
        }
    }

    if (count($students) === 0 && $d['batchName'] === null) {
        $errors[] = 'Students are required: name a Batch or attach a students CSV (Full Name, Email, Registration ID).';
    } elseif (count($students) === 0 && $meta['batchId'] !== null && $meta['batchMembers'] === 0) {
        $errors[] = "Batch \"{$d['batchName']}\" has no students.";
    }
    if (count($students) > ER_MAX_STUDENTS) {
        $errors[] = 'At most ' . ER_MAX_STUDENTS . ' students can be listed on one request.';
    }

    // Per-student problems (capped so one bad file doesn't produce 2000 lines).
    $studentErrors = [];
    $seenEmail = [];
    $seenReg = [];
    $valid = [];
    foreach ($students as $i => $s) {
        $label = 'Student ' . ($i + 1) . ($s['email'] !== '' ? " ({$s['email']})" : ($s['fullName'] !== '' ? " ({$s['fullName']})" : ''));
        $problems = [];
        if ($s['fullName'] === '') $problems[] = 'full name is missing';
        if ($s['email'] === '') $problems[] = 'email is missing';
        elseif (filter_var($s['email'], FILTER_VALIDATE_EMAIL) === false) $problems[] = 'email is not valid';
        if ($s['registrationId'] === '') $problems[] = 'registration ID is missing';
        if (mb_strlen($s['fullName'], 'UTF-8') > 255 || mb_strlen($s['email'], 'UTF-8') > 255) $problems[] = 'name/email longer than 255 characters';
        if (mb_strlen($s['registrationId'], 'UTF-8') > 128) $problems[] = 'registration ID longer than 128 characters';
        $emailKey = mb_strtolower($s['email'], 'UTF-8');
        $regKey = mb_strtolower($s['registrationId'], 'UTF-8');
        if ($s['email'] !== '' && isset($seenEmail[$emailKey])) $problems[] = 'email appears more than once';
        if ($s['registrationId'] !== '' && isset($seenReg[$regKey]) && $seenReg[$regKey] !== $emailKey) $problems[] = 'registration ID is used for two different emails';
        $seenEmail[$emailKey] = true;
        if ($regKey !== '') $seenReg[$regKey] = $emailKey;
        if ($problems) {
            $studentErrors[] = $label . ': ' . implode(', ', $problems) . '.';
        } else {
            $valid[] = $s;
        }
    }
    if (count($valid) > 0) {
        [$byEmail, $byReg] = er_existing_student_maps($pdo, $companyId, $valid);
        foreach ($valid as $s) {
            $e = $byEmail[mb_strtolower($s['email'], 'UTF-8')] ?? null;
            $r = $byReg[mb_strtolower($s['registrationId'], 'UTF-8')] ?? null;
            if ($e !== null && $r !== null && $e !== $r) {
                $studentErrors[] = "Student {$s['email']}: registration ID {$s['registrationId']} belongs to a different existing student in {$companyName}.";
            }
        }
    }
    $cap = 15;
    if (count($studentErrors) > $cap) {
        $more = count($studentErrors) - $cap;
        $studentErrors = array_slice($studentErrors, 0, $cap);
        $studentErrors[] = "…and {$more} more student problem" . ($more === 1 ? '' : 's') . '.';
    }

    return [$d, array_values(array_unique(array_merge($errors, $studentErrors))), $meta];
}

// ---------------------------------------------------------------------------------------------
// Email (replies to the requester, invitations to students)
// ---------------------------------------------------------------------------------------------

function er_smtp_config(array $env): ?array {
    $host = (string)($env['SMTP_HOST'] ?? '');
    $port = (int)($env['SMTP_PORT'] ?? 0);
    $from = (string)($env['SMTP_FROM'] ?? '');
    if ($host === '' || $port <= 0 || $from === '') return null;
    return [
        'host' => $host,
        'port' => $port,
        'user' => (string)($env['SMTP_USER'] ?? ''),
        'pass' => (string)($env['SMTP_PASS'] ?? ''),
        'from' => $from,
        'secure' => (string)($env['SMTP_SECURE'] ?? ''),
        'timeout' => max(5, min(60, (int)($env['SMTP_TIMEOUT'] ?? 15))),
        'selfSigned' => (($env['SMTP_ALLOW_SELF_SIGNED'] ?? '0') === '1'),
    ];
}

/** Inline-hex HTML shell matching the other ProctorGuard emails. $inner is trusted HTML. */
function er_email_html(string $heading, string $inner, string $footer = 'This is an automated message from ProctorGuard exam requests.'): string {
    $h = er_h($heading);
    $f = er_h($footer);
    return <<<HTML
<!doctype html><html><head><meta charset="utf-8"><title>{$h}</title></head>
<body style="margin:0;padding:24px;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;font-size:14px;line-height:1.6;color:#0f172a;background-color:#f8fafc;">
<div style="max-width:600px;margin:0 auto;background:#ffffff;border-radius:12px;border:1px solid #e2e8f0;padding:28px;">
  <h2 style="margin:0 0 14px;font-size:19px;color:#1e293b;">{$h}</h2>
  {$inner}
  <p style="margin:20px 0 0;color:#64748b;font-size:12px;">{$f}</p>
</div>
</body></html>
HTML;
}

/** Key/value summary table for emails. $rows = [label => plain text]. */
function er_email_table(array $rows): string {
    $out = '<table role="presentation" style="border-collapse:collapse;width:100%;margin:6px 0 14px;font-size:13px;">';
    foreach ($rows as $label => $value) {
        $out .= '<tr><td style="padding:5px 10px 5px 0;color:#64748b;white-space:nowrap;vertical-align:top;">' . er_h((string)$label)
            . '</td><td style="padding:5px 0;color:#0f172a;">' . er_h((string)$value) . '</td></tr>';
    }
    return $out . '</table>';
}

function er_email_list(array $items): string {
    $out = '<ul style="margin:6px 0 14px;padding-left:20px;color:#b91c1c;">';
    foreach ($items as $item) {
        $out .= '<li style="margin:2px 0;">' . er_h((string)$item) . '</li>';
    }
    return $out . '</ul>';
}

/** Plain-text alternative: table rows become "Label: value" lines instead of one cell per line. */
function er_html_to_plain(string $html): string {
    $html = (string)preg_replace('#</td>\s*<td[^>]*>#i', ': ', $html);
    return html_to_plain($html);
}

/** One email, logged to delivery_logs. Best-effort: never throws. */
function er_send_mail(PDO $pdo, array $env, ?int $companyId, string $to, string $subject, string $html): bool {
    $to = strtolower(trim($to));
    $logCompany = $companyId !== null && $companyId > 0 ? $companyId : 1;
    if (filter_var($to, FILTER_VALIDATE_EMAIL) === false) {
        add_delivery_log($pdo, $logCompany, 'EMAIL', $to, $subject, $html, 'FAILED', 'Invalid recipient email address.');
        return false;
    }
    $cfg = er_smtp_config($env);
    if ($cfg === null) {
        add_delivery_log($pdo, $logCompany, 'EMAIL', $to, $subject, $html, 'SKIPPED', 'SMTP not configured');
        return false;
    }
    try {
        $result = smtp_send($cfg['host'], $cfg['port'], $cfg['user'], $cfg['pass'], $cfg['from'],
            ['to' => $to, 'subject' => $subject, 'body' => $html, 'plain' => er_html_to_plain($html), 'fromName' => 'ProctorGuard Exam Requests'],
            $cfg['secure'], $cfg['timeout'], $cfg['selfSigned']);
    } catch (Throwable $e) {
        $result = ['ok' => false, 'error' => $e->getMessage()];
    }
    add_delivery_log($pdo, $logCompany, 'EMAIL', $to, $subject, $html, $result['ok'] ? 'SENT' : 'FAILED', $result['ok'] ? null : (string)($result['error'] ?? 'Send failed'));
    return (bool)$result['ok'];
}

function er_format_when(?int $ms, string $tz): string {
    if ($ms === null) return '—';
    $zoneName = er_canonical_timezone($tz) ?? ER_DEFAULT_TIMEZONE;
    $dt = (new DateTimeImmutable('@' . intdiv($ms, 1000)))->setTimezone(new DateTimeZone($zoneName));
    return $dt->format('D, j M Y, g:i A') . ' (' . $zoneName . ')';
}

/** Plain-text summary rows of a request's particulars, for the requester emails. */
function er_details_rows(array $d, int $csvCount, bool $newBatch = false): array {
    $students = [];
    if ($d['batchName'] !== null && $newBatch) {
        $students[] = 'New batch ' . $d['batchName'] . ' (created on approval with the ' . $csvCount . ' student' . ($csvCount === 1 ? '' : 's') . ' from CSV)';
    } else {
        if ($d['batchName'] !== null) $students[] = 'Batch ' . $d['batchName'];
        if ($csvCount > 0) $students[] = $csvCount . ' from CSV';
    }
    return [
        'Exam title' => $d['title'] !== '' ? $d['title'] : '—',
        'Question bank' => $d['questionBankName'] !== '' ? $d['questionBankName'] : '—',
        'Questions' => $d['questionCount'] === 0 ? 'All in bank' : ($d['questionCount'] > 0 ? (string)$d['questionCount'] : '—'),
        'Duration' => $d['durationMinutes'] > 0 ? $d['durationMinutes'] . ' minutes' : '—',
        'Pass percentage' => $d['passPercent'] >= 0 ? $d['passPercent'] . '%' : '—',
        'Start' => er_format_when($d['startTime'], $d['timezone']),
        'End' => er_format_when($d['endTime'], $d['timezone']),
        'Proctoring' => $d['proctoringMode'] === 'PROCTORED'
            ? 'Proctored (camera ' . ($d['cameraRequired'] ? 'on' : 'off') . ', microphone ' . ($d['microphoneRequired'] ? 'on' : 'off') . ')'
            : 'Unproctored',
        'Show alerts' => $d['showAlerts'] ? 'Yes' : 'No',
        'Throw out on violations' => $d['autoTerminate'] ? 'Yes' : 'No',
        'Students' => $students ? implode(' + ', $students) : '—',
    ];
}

/** Where the requester's emails go: their registered address (never a spoofable header). */
function er_requester_address(PDO $pdo, array $request): string {
    if ($request['requester_id'] !== null) {
        $requester = er_fetch_requester($pdo, (int)$request['requester_id']);
        if ($requester) return (string)$requester['email'];
    }
    return (string)$request['sender_email'];
}

function er_invitation_email(array $exam, string $companyName, string $fullName, string $link): array {
    $tz = er_canonical_timezone((string)($exam['timezone'] ?? '')) ?? ER_DEFAULT_TIMEZONE;
    $startMs = er_ts_ms($exam['start_time']);
    $endMs = er_ts_ms($exam['end_time']);
    $proctored = strtoupper((string)($exam['proctoring_mode'] ?? 'PROCTORED')) !== 'UNPROCTORED';
    $origin = rtrim((string)pg_env('APP_ORIGIN', 'https://proctor.lsc-crm.in'), '/');
    $needs = array_keys(array_filter(['webcam' => !empty($exam['camera_required']), 'microphone' => !empty($exam['microphone_required'])]));
    $devices = $needs ? ' with a working ' . implode(' and ', $needs) : '';
    $subject = 'Your Exam Invitation — ' . $exam['title'];
    $inner = '<p style="margin:0 0 12px;">Dear <strong>' . er_h($fullName) . '</strong>,</p>'
        . '<p style="margin:0 0 12px;">You have been invited to appear for ' . ($proctored ? 'a proctored' : 'an') . ' online examination with '
        . er_h($companyName) . '. Please review the details below and click the button to begin when you are ready.</p>'
        . er_email_table([
            'Exam' => (string)$exam['title'],
            'Opens' => er_format_when($startMs, $tz),
            'Closes' => er_format_when($endMs, $tz),
            'Duration' => (int)$exam['duration_minutes'] . ' minutes',
        ])
        . '<p style="margin:0 0 18px;"><a href="' . er_h($link) . '" style="display:inline-block;padding:11px 22px;background:#0f172a;color:#ffffff;text-decoration:none;border-radius:8px;font-weight:600;font-size:14px;">Start Exam</a></p>'
        . ($proctored
            ? '<p style="margin:0 0 8px;color:#475569;font-size:13px;">This exam is proctored: use a laptop or desktop'
              . er_h($devices) . ', in a quiet, well-lit room. '
              . '<a href="' . er_h($origin . '/ProctorGuard_Exam_Instructions_updated.pdf') . '" style="color:#1a73e8;">Read the exam instructions</a>.</p>'
            : '')
        . '<p style="margin:0;color:#64748b;font-size:12px;">This link is personal to you — do not share it.</p>';
    return [$subject, er_email_html('Your exam invitation', $inner, 'This is an automated exam notification from ' . $companyName . ' ProctorGuard.')];
}

/**
 * Send invitations to the exam's assigned students who have not been invited yet, in student-id
 * order after $after, for at most $budget seconds. Same contract as integrations.php's
 * send_exam_invitation(): a signed mint_exam_access_token() link, the per (exam, student) GET_LOCK,
 * the exam_invitations "already mailed" marker written only after a successful send, and a
 * delivery_logs row per attempt. One SMTP session is reused for the whole run (notify.php style).
 * Returns ['invited' => n, 'failures' => [[email, error]], 'remaining' => n, 'cursor' => ?string, 'error' => ?string].
 */
function er_send_invitations(PDO $pdo, array $env, string $examId, string $after = '', float $budget = ER_INVITE_TIME_BUDGET): array {
    $examStmt = $pdo->prepare('SELECT * FROM exams WHERE id = ? LIMIT 1');
    $examStmt->execute([$examId]);
    $exam = $examStmt->fetch();
    $examStmt->closeCursor();
    $result = ['invited' => 0, 'failures' => [], 'remaining' => 0, 'cursor' => null, 'error' => null];
    if (!$exam) {
        $result['error'] = 'Exam not found.';
        return $result;
    }
    $mailExam = exam_mail_exam_by_id($pdo, $examId);
    $cfg = er_smtp_config($env);
    $countRemaining = static function (string $cursor) use ($pdo, $examId): int {
        return db_scalar_int($pdo, 'SELECT COUNT(*) FROM exam_assignments ea
                                    LEFT JOIN exam_invitations ei ON ei.exam_id = ea.exam_id AND ei.student_id = ea.student_id
                                    WHERE ea.exam_id = ? AND ei.student_id IS NULL AND ea.student_id > ?', [$examId, $cursor]);
    };
    if ($cfg === null) {
        $result['error'] = 'SMTP is not configured, so no invitations were sent.';
        $result['remaining'] = $countRemaining('');
        return $result;
    }

    $origin = rtrim((string)pg_env('APP_ORIGIN', 'https://proctor.lsc-crm.in'), '/');
    $companyNames = [];
    $started = microtime(true);
    $cursor = $after;
    $fp = null;
    $stopped = false; // out of time, or the SMTP server is unreachable
    $pageStmt = $pdo->prepare('SELECT s.id, s.full_name, s.email, s.company_id
                                 FROM exam_assignments ea
                                 JOIN students s ON s.id = ea.student_id
                                 LEFT JOIN exam_invitations ei ON ei.exam_id = ea.exam_id AND ei.student_id = ea.student_id
                                WHERE ea.exam_id = ? AND ei.student_id IS NULL AND ea.student_id > ?
                                ORDER BY ea.student_id ASC
                                LIMIT 100');
    while (!$stopped) {
        $pageStmt->execute([$examId, $cursor]);
        $rows = $pageStmt->fetchAll();
        $pageStmt->closeCursor();
        if (count($rows) === 0) break;
        foreach ($rows as $row) {
            if (microtime(true) - $started > $budget) {
                $stopped = true;
                break;
            }
            if (!is_resource($fp)) {
                $conn = smtp_open($cfg['host'], $cfg['port'], $cfg['user'], $cfg['pass'], $cfg['secure'], $cfg['timeout'], $cfg['selfSigned']);
                if (!$conn['ok']) {
                    // Retrying per student would just burn the time budget on the same failure.
                    $result['error'] = 'Could not connect to the mail server: ' . (string)($conn['error'] ?? 'unknown error');
                    $stopped = true;
                    break;
                }
                $fp = $conn['fp'];
            }
            $studentId = (string)$row['id'];
            $cursor = $studentId;
            $email = strtolower(trim((string)$row['email']));
            $fullName = trim((string)$row['full_name']) !== '' ? trim((string)$row['full_name']) : $email;
            $studentCompany = (int)$row['company_id'];
            if (!isset($companyNames[$studentCompany])) {
                $companyNames[$studentCompany] = er_company_name($pdo, $studentCompany);
            }
            // Short "<origin>?<code>" link (falls back to the long signed ?token= link if a code can't be made).
            $link = exam_access_link($pdo, $origin, $examId, $studentId, $studentCompany);
            if ($mailExam !== null) {
                // Same per-exam invitation (incl. any template the admin customised) as console sends.
                $rendered = exam_mail_render($mailExam, $fullName, $link, 'INVITE');
                [$subject, $html] = [$rendered['subject'], $rendered['html']];
            } else {
                [$subject, $html] = er_invitation_email($exam, $companyNames[$studentCompany], $fullName, $link);
            }

            if (filter_var($email, FILTER_VALIDATE_EMAIL) === false) {
                add_delivery_log($pdo, $studentCompany, 'EMAIL', $email, $subject, $html, 'FAILED', 'Invalid recipient email address.');
                $result['failures'][] = ['email' => $email, 'error' => 'Invalid recipient email address.'];
                continue;
            }

            $lockName = 'exam_invite_' . $examId . '_' . $studentId;
            $lockStmt = $pdo->prepare('SELECT GET_LOCK(?, 5)');
            $lockStmt->execute([$lockName]);
            $acquired = (bool)$lockStmt->fetchColumn();
            $lockStmt->closeCursor();
            if (!$acquired) {
                // Someone else is sending this exact invitation right now — let them finish.
                continue;
            }
            try {
                $already = $pdo->prepare('SELECT 1 FROM exam_invitations WHERE exam_id = ? AND student_id = ? LIMIT 1');
                $already->execute([$examId, $studentId]);
                $isSent = (bool)$already->fetchColumn();
                $already->closeCursor();
                if ($isSent) continue;

                $send = smtp_deliver($fp, $cfg['from'], [
                    'to' => $email,
                    'subject' => $subject,
                    'body' => $html,
                    'plain' => er_html_to_plain($html),
                    'fromName' => $companyNames[$studentCompany] . ' ProctorGuard',
                ]);
                if ($send['ok']) {
                    // Reset for the next recipient; a bad RSET means the session is suspect — reopen.
                    $rset = @fwrite($fp, "RSET\r\n");
                    $resp = $rset === false ? ['code' => 0] : smtp_read_response($fp);
                    if ($rset === false || $resp['code'] !== 250) {
                        smtp_close($fp);
                        $fp = null;
                    }
                } else {
                    // Connection state is unknown after a failed delivery.
                    smtp_close($fp);
                    $fp = null;
                }
                add_delivery_log($pdo, $studentCompany, 'EMAIL', $email, $subject, $html, $send['ok'] ? 'SENT' : 'FAILED', $send['ok'] ? null : (string)($send['error'] ?? 'Send failed'));
                if ($send['ok']) {
                    $mark = $pdo->prepare('INSERT IGNORE INTO exam_invitations (exam_id, student_id) VALUES (?, ?)');
                    $mark->execute([$examId, $studentId]);
                    $mark->closeCursor();
                    $result['invited']++;
                    // WhatsApp copy (same link) for students with a mobile number — only after the
                    // email went out and the "invited" marker is written, so a later run never
                    // repeats it. Best-effort: logged in delivery_logs, never fails this run. Returns
                    // at once (no logging) while WhatsApp invitations aren't configured.
                    try {
                        whatsapp_send_exam_notice($pdo, $env, $studentCompany, $exam, $row, 'INVITE');
                    } catch (Throwable $e) {
                        error_log('[exam_requests] WhatsApp invitation failed: ' . $e->getMessage());
                    }
                } else {
                    $result['failures'][] = ['email' => $email, 'error' => (string)($send['error'] ?? 'Send failed')];
                }
            } finally {
                $release = $pdo->prepare('SELECT RELEASE_LOCK(?)');
                $release->execute([$lockName]);
                $release->closeCursor();
            }
        }
    }
    if (is_resource($fp)) {
        smtp_close($fp);
    }
    $result['remaining'] = $stopped ? $countRemaining($cursor) : 0;
    $result['cursor'] = $result['remaining'] > 0 ? $cursor : null;
    if (count($result['failures']) > 100) {
        $result['failures'] = array_slice($result['failures'], 0, 100);
    }
    return $result;
}

/** "Approved, exam scheduled, N invitations sent" to the requester. */
function er_notify_approved(PDO $pdo, array $env, array $request, string $examId): void {
    $details = er_normalize_details(json_decode((string)$request['details_json'], true) ?: []);
    $assigned = db_scalar_int($pdo, 'SELECT COUNT(*) FROM exam_assignments WHERE exam_id = ?', [$examId]);
    $invited = db_scalar_int($pdo, 'SELECT COUNT(*) FROM exam_invitations WHERE exam_id = ?', [$examId]);
    $rows = er_details_rows($details, count(er_decode_json_list($request['students_json'] ?? null)), er_batch_created_by_request($pdo, $request, $details));
    $rows['Students assigned'] = (string)$assigned;
    $rows['Invitations sent'] = $invited . ' of ' . $assigned;
    $inner = '<p style="margin:0 0 12px;">Your exam request <strong>#' . (int)$request['id'] . '</strong> has been approved and the exam is scheduled. '
        . $invited . ' invitation' . ($invited === 1 ? '' : 's') . ' sent.</p>'
        . er_email_table($rows)
        . ($invited < $assigned
            ? '<p style="margin:0;color:#475569;">Students who have not received their link yet will be invited by the administrator.</p>'
            : '');
    er_send_mail($pdo, $env, $request['company_id'] !== null ? (int)$request['company_id'] : null, er_requester_address($pdo, $request),
        '[ProctorGuard] Exam request #' . (int)$request['id'] . ' approved — ' . $details['title'] . ' scheduled',
        er_email_html('Exam request approved', $inner));
    // WhatsApp copy for the employee (when they have a mobile and WhatsApp is configured; never throws).
    $candidates = static fn(int $n): string => $n . ' candidate' . ($n === 1 ? '' : 's');
    whatsapp_notify_requester($pdo, $env, (int)($request['requester_id'] ?? 0), (int)$request['id'], (string)$details['title'],
        $invited >= $assigned
            ? 'approved — ' . $candidates($invited) . ' invited'
            : 'approved — ' . $invited . ' of ' . $candidates($assigned) . ' invited so far');
}

// ---------------------------------------------------------------------------------------------
// Approval: create the exam from a validated request
// ---------------------------------------------------------------------------------------------

/** students.php upsert rules (match by registration id, then email, within the company). Returns [id, created]. */
function er_upsert_student(PDO $pdo, int $companyId, array $s): array {
    $byReg = $pdo->prepare('SELECT id FROM students WHERE company_id = ? AND registration_id = ? LIMIT 1');
    $byReg->execute([$companyId, $s['registrationId']]);
    $regId = $byReg->fetchColumn();
    $byReg->closeCursor();
    $byEmail = $pdo->prepare('SELECT id FROM students WHERE company_id = ? AND email = ? LIMIT 1');
    $byEmail->execute([$companyId, $s['email']]);
    $emailId = $byEmail->fetchColumn();
    $byEmail->closeCursor();
    if ($regId !== false && $emailId !== false && (string)$regId !== (string)$emailId) {
        throw new RuntimeException("Student {$s['email']}: registration ID {$s['registrationId']} belongs to a different existing student.");
    }
    $existing = $regId !== false ? (string)$regId : ($emailId !== false ? (string)$emailId : null);
    if ($existing !== null) {
        $update = $pdo->prepare('UPDATE students SET full_name = ?, email = ?, registration_id = ? WHERE id = ? AND company_id = ?');
        $update->execute([$s['fullName'], $s['email'], $s['registrationId'], $existing, $companyId]);
        $update->closeCursor();
        return [$existing, false];
    }
    $id = bin2hex(random_bytes(8));
    $insert = $pdo->prepare('INSERT INTO students (id, company_id, full_name, email, registration_id) VALUES (?, ?, ?, ?, ?)');
    $insert->execute([$id, $companyId, $s['fullName'], $s['email'], $s['registrationId']]);
    $insert->closeCursor();
    return [$id, true];
}

/** batches.description of a batch an approval created, so it can be traced back to its request. */
function er_new_batch_description(int $requestId): string {
    return 'Created by exam request #' . $requestId;
}

/** True when the request's batch is one its own approval created (the CSV students ARE the batch). */
function er_batch_created_by_request(PDO $pdo, array $request, array $d): bool {
    if ($d['batchName'] === null || $request['company_id'] === null) return false;
    $batch = er_find_batch($pdo, (int)$request['company_id'], $d['batchName']);
    if (!$batch) return false;
    $stmt = $pdo->prepare('SELECT description FROM batches WHERE id = ? LIMIT 1');
    $stmt->execute([(int)$batch['id']]);
    $description = $stmt->fetchColumn();
    $stmt->closeCursor();
    return $description === er_new_batch_description((int)$request['id']);
}

/**
 * Create the exam + links + enrolments for a validated request. Must run inside the caller's
 * transaction. Written with the same columns exams.php's save uses; question rows are NOT copied —
 * the bank's questions are linked through exam_questions in bank order. When the request names a
 * batch that doesn't exist yet ($meta['newBatch']), the batch is created here and the request's CSV
 * students become its members; an existing batch is only read (its members are enrolled), never
 * changed.
 */
function er_create_exam(PDO $pdo, int $companyId, array $d, array $meta, array $students, int $requestId): array {
    $examId = bin2hex(random_bytes(8));
    $proctored = $d['proctoringMode'] === 'PROCTORED';
    $totalMarks = db_scalar_int($pdo, 'SELECT COALESCE(SUM(q.marks), 0) FROM question_bank_items i JOIN questions q ON q.id = i.question_id WHERE i.bank_id = ?', [$meta['bankId']]);

    $columns = [
        'id' => $examId,
        'company_id' => $companyId,
        'title' => $d['title'],
        'duration_minutes' => $d['durationMinutes'],
        'start_time' => er_ms_to_datetime((int)$d['startTime']),
        'end_time' => er_ms_to_datetime((int)$d['endTime']),
        'question_count' => $d['questionCount'],
        'shuffle_questions' => 1,
        'show_results' => 0,
        'pass_percent' => $d['passPercent'],
        'attempt_policy' => 'LAST',
        'reconnect_limit' => ER_DEFAULT_RECONNECT_LIMIT,
        'total_marks' => $totalMarks,
        'status' => 'PUBLISHED',
        'camera_required' => $proctored && $d['cameraRequired'] ? 1 : 0,
        'microphone_required' => $proctored && $d['microphoneRequired'] ? 1 : 0,
        'fullscreen_enforced' => $proctored ? 1 : 0,
        // 0 = unlimited (ExamTake only enforces a positive limit), so an unproctored exam never
        // throws a candidate out for switching tabs even on a client that ignores proctoring_mode.
        'tab_switch_limit' => $proctored ? ER_DEFAULT_TAB_SWITCH_LIMIT : 0,
        'notification_enabled' => 0,
        'reminder_hours24' => 1,
        'reminder_hours1' => 1,
        'notification_subject' => null,
        'notification_message' => null,
    ];
    // Optional columns, written when present (as exams.php does after its main upsert).
    $optional = [
        'timezone' => $d['timezone'],
        // normalize_violation_limits(null) / normalize_proctor_timing(null) / normalize_allowed_devices(null)
        'violation_limits_json' => er_json(['camera' => 0, 'microphone' => 0, 'fullscreen' => 0, 'copyPaste' => 0]),
        'proctor_timing_json' => er_json(['gazeAwaySeconds' => 9, 'audioSeconds' => 2]),
        'allowed_device_types_json' => er_json(['desktop', 'tablet', 'mobile']),
        'certificate_enabled' => 0,
        'proctoring_mode' => $d['proctoringMode'],
        'show_violation_alerts' => $d['showAlerts'] ? 1 : 0,
        'auto_terminate' => $d['autoTerminate'] ? 1 : 0,
    ];
    foreach ($optional as $col => $value) {
        if (db_column_exists($pdo, 'exams', $col)) {
            $columns[$col] = $value;
        }
    }
    $names = array_keys($columns);
    $insert = $pdo->prepare('INSERT INTO exams (' . implode(', ', $names) . ') VALUES (' . implode(', ', array_fill(0, count($names), '?')) . ')');
    $insert->execute(array_values($columns));
    $insert->closeCursor();

    $link = $pdo->prepare('INSERT INTO exam_questions (exam_id, question_id, display_order)
                           SELECT ?, i.question_id, ROW_NUMBER() OVER (ORDER BY i.display_order, i.added_at, i.question_id) - 1
                             FROM question_bank_items i WHERE i.bank_id = ?');
    $link->execute([$examId, $meta['bankId']]);
    $linked = $link->rowCount();
    $link->closeCursor();

    $newBatchId = null;
    if (!empty($meta['newBatch']) && $d['batchName'] !== null) {
        // Validation ran a moment ago in this same transaction; if someone created the batch in
        // between, stop rather than silently adding these students to it.
        if (er_find_batch($pdo, $companyId, $d['batchName'])) {
            throw new RuntimeException("Batch \"{$d['batchName']}\" was created by someone else just now — review the request and approve it again.");
        }
        $batchInsert = $pdo->prepare('INSERT INTO batches (company_id, name, description) VALUES (?, ?, ?)');
        $batchInsert->execute([$companyId, $d['batchName'], er_new_batch_description($requestId)]);
        $batchInsert->closeCursor();
        $newBatchId = (int)$pdo->lastInsertId();
        $meta['batchId'] = $newBatchId;
    }

    $assign = $pdo->prepare('INSERT IGNORE INTO exam_assignments (exam_id, student_id) VALUES (?, ?)');
    $created = 0;
    $updated = 0;
    foreach ($students as $s) {
        [$studentId, $isNew] = er_upsert_student($pdo, $companyId, $s);
        $isNew ? $created++ : $updated++;
        $assign->execute([$examId, $studentId]);
        if ($newBatchId !== null) {
            add_student_batch($pdo, $studentId, $newBatchId);
        }
    }
    $assign->closeCursor();

    if ($meta['batchId'] !== null) {
        $batchAssign = $pdo->prepare('INSERT IGNORE INTO exam_batch_assignments (exam_id, batch_id) VALUES (?, ?)');
        $batchAssign->execute([$examId, $meta['batchId']]);
        $batchAssign->closeCursor();
        $members = $pdo->prepare('INSERT IGNORE INTO exam_assignments (exam_id, student_id)
                                  SELECT ?, sb.student_id FROM student_batches sb WHERE sb.batch_id = ?');
        $members->execute([$examId, $meta['batchId']]);
        $members->closeCursor();
    }
    $assigned = db_scalar_int($pdo, 'SELECT COUNT(*) FROM exam_assignments WHERE exam_id = ?', [$examId]);

    return ['examId' => $examId, 'linkedQuestions' => $linked, 'studentsCreated' => $created, 'studentsUpdated' => $updated, 'assigned' => $assigned,
            'batchCreated' => $newBatchId !== null, 'batchId' => $meta['batchId']];
}

// =============================================================================================
// HTTP handler — skipped when this file is included for its functions.
// =============================================================================================
$erIsIncluded = (basename($_SERVER['SCRIPT_FILENAME'] ?? '') !== 'exam_requests.php');
if ($erIsIncluded) {
    return;
}

er_ensure_schema($pdo);
$method = $_SERVER['REQUEST_METHOD'];

if ($method === 'GET') {
    require_role(['SUPER_ADMIN']);

    if (isset($_GET['banksFor'])) {
        $companyId = (int)$_GET['banksFor'];
        if ($companyId <= 0) {
            json_response(['error' => 'banksFor must be a company id.'], 400);
        }
        $stmt = $pdo->prepare('SELECT b.id, b.name, COUNT(i.question_id) AS question_count
                                 FROM question_banks b
                                 LEFT JOIN question_bank_items i ON i.bank_id = b.id
                                WHERE b.company_id = ?
                                GROUP BY b.id, b.name
                                ORDER BY b.name ASC');
        $stmt->execute([$companyId]);
        $banks = array_map(static fn($r) => ['id' => (int)$r['id'], 'name' => (string)$r['name'], 'questionCount' => (int)$r['question_count']], $stmt->fetchAll());
        $stmt->closeCursor();
        $stmt = $pdo->prepare('SELECT b.id, b.name, COUNT(sb.student_id) AS student_count
                                 FROM batches b
                                 LEFT JOIN student_batches sb ON sb.batch_id = b.id
                                WHERE b.company_id = ?
                                GROUP BY b.id, b.name
                                ORDER BY b.name ASC');
        $stmt->execute([$companyId]);
        $batches = array_map(static fn($r) => ['id' => (int)$r['id'], 'name' => (string)$r['name'], 'studentCount' => (int)$r['student_count']], $stmt->fetchAll());
        $stmt->closeCursor();
        json_response(['banks' => $banks, 'batches' => $batches]);
    }

    if (isset($_GET['id'])) {
        $row = er_fetch_request($pdo, (int)$_GET['id']);
        if (!$row) {
            json_response(['error' => 'Request not found.'], 404);
        }
        json_response(['request' => er_request_public($row)]);
    }

    $status = strtoupper(trim((string)($_GET['status'] ?? '')));
    $params = [];
    $sql = ER_REQUEST_SELECT;
    if ($status !== '') {
        if (!in_array($status, ['PENDING', 'APPROVED', 'REJECTED', 'INVALID'], true)) {
            json_response(['error' => 'status must be PENDING, APPROVED, REJECTED or INVALID.'], 400);
        }
        $sql .= ' WHERE r.status = ?';
        $params[] = $status;
    }
    $sql .= ' ORDER BY r.received_at DESC, r.id DESC LIMIT 500';
    $stmt = $pdo->prepare($sql);
    $stmt->execute($params);
    $rows = $stmt->fetchAll();
    $stmt->closeCursor();
    // Student lists are only needed while a request is being edited; a decided request's list is
    // fetched on demand (GET ?id=) so 500 rows of up to 2,000 students each never ship at once.
    $requests = array_map(static fn($r) => er_request_public($r, $r['status'] === 'PENDING'), $rows);

    $rq = $pdo->query('SELECT q.*, c.name AS company_name FROM exam_requesters q LEFT JOIN companies c ON c.id = q.company_id ORDER BY q.name ASC, q.id ASC');
    $requesters = array_map('er_requester_public', $rq->fetchAll());
    $rq->closeCursor();

    json_response(['requests' => $requests, 'requesters' => $requesters, 'mailbox' => er_mailbox_address($env)]);
}

if ($method !== 'POST') {
    json_response(['error' => 'Method not allowed.'], 405);
}

$payload = json_input();
$actorRole = require_role(['SUPER_ADMIN'], $payload);
$actorId = get_actor_id($payload) ?? 'super-admin';
$action = strtoupper(trim((string)($payload['action'] ?? '')));

// ---- Requesters -------------------------------------------------------------------------------

if ($action === 'CREATE_REQUESTER') {
    $companyId = (int)($payload['companyId'] ?? 0);
    $name = trim((string)($payload['name'] ?? ''));
    $email = strtolower(trim((string)($payload['email'] ?? '')));
    if ($companyId <= 0 || db_scalar_int($pdo, 'SELECT COUNT(*) FROM companies WHERE id = ?', [$companyId]) === 0) {
        json_response(['error' => 'Choose a valid company.'], 400);
    }
    if ($name === '' || mb_strlen($name, 'UTF-8') > 255) {
        json_response(['error' => 'Name is required (at most 255 characters).'], 400);
    }
    if ($email === '' || mb_strlen($email, 'UTF-8') > 255 || filter_var($email, FILTER_VALIDATE_EMAIL) === false) {
        json_response(['error' => 'A valid email address is required.'], 400);
    }
    if ($email === er_mailbox_address($env)) {
        json_response(['error' => 'That is the platform mailbox itself — register the employee\'s own address.'], 400);
    }
    if (db_scalar_int($pdo, 'SELECT COUNT(*) FROM exam_requesters WHERE email = ?', [$email]) > 0) {
        json_response(['error' => 'An employee with this email is already registered.'], 409);
    }
    [$mobileProvided, $mobile, $mobileError] = er_requester_mobile_input($payload, $env);
    if ($mobileError !== null) {
        json_response(['error' => $mobileError], 400);
    }
    $code = er_generate_code();
    try {
        $stmt = $pdo->prepare('INSERT INTO exam_requesters (company_id, name, email, code_hash, code_hint, status, created_by) VALUES (?, ?, ?, ?, ?, \'ACTIVE\', ?)');
        $stmt->execute([$companyId, $name, $email, password_hash($code['normalized'], PASSWORD_DEFAULT), substr($code['normalized'], -4), er_clip($actorId, 255)]);
        $stmt->closeCursor();
    } catch (PDOException $e) {
        if ((int)($e->errorInfo[1] ?? 0) === 1062) {
            json_response(['error' => 'An employee with this email is already registered.'], 409);
        }
        throw $e;
    }
    $id = (int)$pdo->lastInsertId();
    if ($mobileProvided && $mobile !== null && !empty(whatsapp_schema_once($pdo)['requestersMobile'])) {
        $stmt = $pdo->prepare('UPDATE exam_requesters SET mobile = ? WHERE id = ?');
        $stmt->execute([$mobile, $id]);
        $stmt->closeCursor();
    }
    audit_log($pdo, [
        'companyId' => $companyId, 'actorRole' => $actorRole, 'actorId' => $actorId,
        'action' => 'EXAM_REQUESTER_CREATE', 'targetType' => 'exam_requester', 'targetId' => (string)$id,
        'message' => "Exam requester registered: {$name} <{$email}>",
    ]);
    // The plaintext code is returned ONCE — only its hash is stored.
    json_response(['ok' => true, 'requester' => er_requester_public(er_fetch_requester($pdo, $id)), 'code' => $code['display']]);
}

if (in_array($action, ['REGENERATE_CODE', 'SET_REQUESTER_STATUS', 'DELETE_REQUESTER', 'UPDATE_REQUESTER'], true)) {
    $id = (int)($payload['id'] ?? 0);
    $requester = $id > 0 ? er_fetch_requester($pdo, $id) : null;
    if (!$requester) {
        json_response(['error' => 'Employee not found.'], 404);
    }
    $companyId = (int)$requester['company_id'];
    $label = "{$requester['name']} <{$requester['email']}>";

    if ($action === 'UPDATE_REQUESTER') {
        // Edits the display name and the optional WhatsApp mobile. The email address is the
        // employee's identity for the security-code check, so it is not editable here (delete and
        // re-register instead).
        $sets = [];
        $params = [];
        if (array_key_exists('name', $payload) && $payload['name'] !== null) {
            $name = trim((string)$payload['name']);
            if ($name === '' || mb_strlen($name, 'UTF-8') > 255) {
                json_response(['error' => 'Name is required (at most 255 characters).'], 400);
            }
            $sets[] = 'name = ?';
            $params[] = $name;
        }
        [$mobileProvided, $mobile, $mobileError] = er_requester_mobile_input($payload, $env);
        if ($mobileError !== null) {
            json_response(['error' => $mobileError], 400);
        }
        if ($mobileProvided) {
            if (empty(whatsapp_schema_once($pdo)['requestersMobile'])) {
                json_response(['error' => 'Mobile numbers are not available on this database yet.'], 409);
            }
            $sets[] = 'mobile = ?';
            $params[] = $mobile;
        }
        if ($sets !== []) {
            $params[] = $id;
            $stmt = $pdo->prepare('UPDATE exam_requesters SET ' . implode(', ', $sets) . ' WHERE id = ?');
            $stmt->execute($params);
            $stmt->closeCursor();
            audit_log($pdo, [
                'companyId' => $companyId, 'actorRole' => $actorRole, 'actorId' => $actorId,
                'action' => 'EXAM_REQUESTER_UPDATE', 'targetType' => 'exam_requester', 'targetId' => (string)$id,
                'message' => "Exam requester updated: {$label}",
                'metadata' => ['nameChanged' => in_array('name = ?', $sets, true), 'mobileChanged' => $mobileProvided],
            ]);
        }
        json_response(['ok' => true, 'requester' => er_requester_public(er_fetch_requester($pdo, $id))]);
    }

    if ($action === 'REGENERATE_CODE') {
        $code = er_generate_code();
        $stmt = $pdo->prepare('UPDATE exam_requesters SET code_hash = ?, code_hint = ? WHERE id = ?');
        $stmt->execute([password_hash($code['normalized'], PASSWORD_DEFAULT), substr($code['normalized'], -4), $id]);
        $stmt->closeCursor();
        audit_log($pdo, [
            'companyId' => $companyId, 'actorRole' => $actorRole, 'actorId' => $actorId,
            'action' => 'EXAM_REQUESTER_REGENERATE_CODE', 'targetType' => 'exam_requester', 'targetId' => (string)$id,
            'message' => "Security code regenerated for {$label}",
        ]);
        json_response(['ok' => true, 'requester' => er_requester_public(er_fetch_requester($pdo, $id)), 'code' => $code['display']]);
    }

    if ($action === 'SET_REQUESTER_STATUS') {
        $status = strtoupper(trim((string)($payload['status'] ?? '')));
        if (!in_array($status, ['ACTIVE', 'DISABLED'], true)) {
            json_response(['error' => 'status must be ACTIVE or DISABLED.'], 400);
        }
        $stmt = $pdo->prepare('UPDATE exam_requesters SET status = ? WHERE id = ?');
        $stmt->execute([$status, $id]);
        $stmt->closeCursor();
        audit_log($pdo, [
            'companyId' => $companyId, 'actorRole' => $actorRole, 'actorId' => $actorId,
            'action' => 'EXAM_REQUESTER_STATUS', 'targetType' => 'exam_requester', 'targetId' => (string)$id,
            'message' => "Exam requester {$label} set to {$status}",
        ]);
        json_response(['ok' => true, 'requester' => er_requester_public(er_fetch_requester($pdo, $id))]);
    }

    // DELETE_REQUESTER — their past requests stay (sender email is kept on each request).
    $stmt = $pdo->prepare('DELETE FROM exam_requesters WHERE id = ?');
    $stmt->execute([$id]);
    $stmt->closeCursor();
    audit_log($pdo, [
        'companyId' => $companyId, 'actorRole' => $actorRole, 'actorId' => $actorId,
        'action' => 'EXAM_REQUESTER_DELETE', 'targetType' => 'exam_requester', 'targetId' => (string)$id,
        'message' => "Exam requester deleted: {$label}",
    ]);
    json_response(['ok' => true, 'id' => $id]);
}

// ---- Requests ---------------------------------------------------------------------------------

$requestId = (int)($payload['id'] ?? 0);
$request = $requestId > 0 ? er_fetch_request($pdo, $requestId) : null;
if (in_array($action, ['UPDATE', 'APPROVE', 'REJECT', 'SEND_INVITES'], true) && !$request) {
    json_response(['error' => 'Request not found.'], 404);
}

/** Payload details/students → normalised [details, students]; null when the payload omits them. */
$readEdits = static function (array $payload, array $request): array {
    $details = null;
    $students = null;
    if (array_key_exists('details', $payload)) {
        if (!is_array($payload['details'])) {
            json_response(['error' => 'details must be an object.'], 400);
        }
        $details = er_normalize_details($payload['details']);
    }
    if (array_key_exists('students', $payload)) {
        if (!is_array($payload['students'])) {
            json_response(['error' => 'students must be a list.'], 400);
        }
        $students = er_normalize_students($payload['students']);
        if (count($students) > ER_MAX_STUDENTS) {
            json_response(['error' => 'At most ' . ER_MAX_STUDENTS . ' students can be listed on one request.'], 400);
        }
    }
    return [
        $details ?? er_normalize_details(json_decode((string)$request['details_json'], true) ?: []),
        $students ?? er_normalize_students(er_decode_json_list($request['students_json'] ?? null)),
    ];
};

$saveDraft = static function (PDO $pdo, int $id, array $details, array $students, array $errors): void {
    $stmt = $pdo->prepare("UPDATE exam_requests SET details_json = ?, students_json = ?, errors_json = ? WHERE id = ? AND status = 'PENDING'");
    $stmt->execute([er_json($details), er_json($students), er_json($errors), $id]);
    $stmt->closeCursor();
};

if ($action === 'UPDATE') {
    if ($request['status'] !== 'PENDING') {
        json_response(['error' => 'Only pending requests can be edited.'], 409);
    }
    [$details, $students] = $readEdits($payload, $request);
    [$details, $errors] = er_validate($pdo, $request['company_id'] !== null ? (int)$request['company_id'] : null, $details, $students);
    $saveDraft($pdo, $requestId, $details, $students, $errors);
    audit_log($pdo, [
        'companyId' => $request['company_id'] !== null ? (int)$request['company_id'] : null, 'actorRole' => $actorRole, 'actorId' => $actorId,
        'action' => 'EXAM_REQUEST_UPDATE', 'targetType' => 'exam_request', 'targetId' => (string)$requestId,
        'message' => "Exam request #{$requestId} edited" . ($errors ? ' (' . count($errors) . ' problem(s) remain)' : ''),
    ]);
    json_response(['ok' => true, 'request' => er_request_public(er_fetch_request($pdo, $requestId)), 'errors' => $errors]);
}

if ($action === 'APPROVE') {
    if ($request['status'] !== 'PENDING') {
        json_response(['error' => 'Only pending requests can be approved.'], 409);
    }
    $companyId = $request['company_id'] !== null ? (int)$request['company_id'] : 0;
    $sendInvites = !empty($payload['sendInvites']);
    // Problems recorded at intake (including ones about how a value was written, which a fresh
    // validation can't see) block approval until the request is edited — an APPROVE carrying
    // details/students is such an edit and is re-validated below.
    $storedErrors = er_decode_json_list($request['errors_json'] ?? null);
    if (!array_key_exists('details', $payload) && !array_key_exists('students', $payload) && count($storedErrors) > 0) {
        json_response(['error' => 'This request still needs attention — fix the problems listed and save it first.', 'errors' => $storedErrors], 400);
    }
    [$details, $students] = $readEdits($payload, $request);

    $created = null;
    $errors = [];
    try {
        $pdo->beginTransaction();
        $locked = er_fetch_request($pdo, $requestId, true);
        if (!$locked || $locked['status'] !== 'PENDING') {
            $pdo->rollBack();
            json_response(['error' => 'This request was already decided by someone else. Refresh the list.'], 409);
        }
        [$details, $errors, $meta] = er_validate($pdo, $companyId, $details, $students);
        if (count($errors) === 0) {
            $created = er_create_exam($pdo, $companyId, $details, $meta, $students, $requestId);
            $stmt = $pdo->prepare("UPDATE exam_requests
                                      SET status = 'APPROVED', created_exam_id = ?, reviewed_by = ?, reviewed_at = NOW(),
                                          details_json = ?, students_json = ?, errors_json = ?
                                    WHERE id = ? AND status = 'PENDING'");
            $stmt->execute([$created['examId'], er_clip($actorId, 255), er_json($details), er_json($students), er_json([]), $requestId]);
            $stmt->closeCursor();
            $pdo->commit();
        } else {
            $pdo->rollBack();
        }
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) {
            $pdo->rollBack();
        }
        if ($e instanceof RuntimeException && !($e instanceof PDOException)) {
            $errors = [$e->getMessage()];
        } else {
            throw $e;
        }
    }
    if ($created === null) {
        // Keep the super admin's edits and show what still blocks approval.
        $saveDraft($pdo, $requestId, $details, $students, $errors);
        json_response(['error' => 'This request cannot be approved yet: ' . implode(' ', array_slice($errors, 0, 3)), 'errors' => $errors], 400);
    }

    $examId = $created['examId'];
    audit_log($pdo, [
        'companyId' => $companyId, 'actorRole' => $actorRole, 'actorId' => $actorId,
        'action' => 'EXAM_REQUEST_APPROVE', 'targetType' => 'exam_request', 'targetId' => (string)$requestId,
        'message' => "Exam request #{$requestId} approved — exam \"{$details['title']}\" ({$examId}) created"
            . ($created['batchCreated'] ? " with new batch \"{$details['batchName']}\" (" . count($students) . ' students)' : ''),
        'metadata' => array_merge($created, ['bankId' => $details['questionBankId'], 'batch' => $details['batchName'], 'sendInvites' => $sendInvites]),
    ]);

    // Slow work after the commit: invitations (time-boxed; the UI continues with SEND_INVITES while
    // inviteRemaining > 0) and the requester's confirmation.
    ignore_user_abort(true);
    @set_time_limit(120);
    $invite = ['invited' => 0, 'failures' => [], 'remaining' => 0, 'cursor' => null, 'error' => null];
    if ($sendInvites) {
        $invite = er_send_invitations($pdo, $env, $examId);
    }
    $approved = er_fetch_request($pdo, $requestId);
    if (!$sendInvites || $invite['remaining'] === 0) {
        er_notify_approved($pdo, $env, $approved, $examId);
    }
    json_response([
        'ok' => true,
        'request' => er_request_public($approved),
        'examId' => $examId,
        'assigned' => $created['assigned'],
        'invited' => $invite['invited'],
        'inviteFailures' => $invite['failures'],
        'inviteRemaining' => $invite['remaining'],
        'inviteCursor' => $invite['cursor'],
        'inviteError' => $invite['error'],
        'pendingTotal' => (int)($approved['pending_invite_count'] ?? 0),
    ]);
}

if ($action === 'SEND_INVITES') {
    if ($request['status'] !== 'APPROVED' || empty($request['created_exam_id'])) {
        json_response(['error' => 'Invitations can only be sent for an approved request.'], 409);
    }
    ignore_user_abort(true);
    @set_time_limit(120);
    $examId = (string)$request['created_exam_id'];
    $invite = er_send_invitations($pdo, $env, $examId, trim((string)($payload['after'] ?? '')));
    // notifyRequester: the UI's continuation of an APPROVE sends the requester's confirmation once
    // the last chunk is out (APPROVE itself only mails it when everything fit in one call).
    // Only when THIS call delivered the final chunk: a repeated/retried call with nothing left to send
    // must not mail the requester another "approved" confirmation.
    if (!empty($payload['notifyRequester']) && $invite['remaining'] === 0 && $invite['invited'] > 0) {
        er_notify_approved($pdo, $env, $request, $examId);
    }
    if ($invite['invited'] > 0 || count($invite['failures']) > 0) {
        audit_log($pdo, [
            'companyId' => $request['company_id'] !== null ? (int)$request['company_id'] : null, 'actorRole' => $actorRole, 'actorId' => $actorId,
            'action' => 'EXAM_REQUEST_SEND_INVITES', 'targetType' => 'exam', 'targetId' => $examId,
            'message' => "Invitations for exam request #{$requestId}: {$invite['invited']} sent, " . count($invite['failures']) . ' failed',
        ]);
    }
    json_response([
        'ok' => true,
        'examId' => $examId,
        'invited' => $invite['invited'],
        'inviteFailures' => $invite['failures'],
        'inviteRemaining' => $invite['remaining'],
        'inviteCursor' => $invite['cursor'],
        'inviteError' => $invite['error'],
        'pendingTotal' => db_scalar_int($pdo, 'SELECT COUNT(*) FROM exam_assignments ea LEFT JOIN exam_invitations ei ON ei.exam_id = ea.exam_id AND ei.student_id = ea.student_id WHERE ea.exam_id = ? AND ei.student_id IS NULL', [$examId]),
    ]);
}

if ($action === 'REJECT') {
    if ($request['status'] !== 'PENDING') {
        json_response(['error' => 'Only pending requests can be rejected.'], 409);
    }
    $note = trim((string)($payload['note'] ?? ''));
    if ($note === '' || mb_strlen($note, 'UTF-8') > 2000) {
        json_response(['error' => 'A rejection note is required (at most 2000 characters).'], 400);
    }
    $stmt = $pdo->prepare("UPDATE exam_requests SET status = 'REJECTED', reviewed_by = ?, reviewed_at = NOW(), review_note = ? WHERE id = ? AND status = 'PENDING'");
    $stmt->execute([er_clip($actorId, 255), $note, $requestId]);
    $changed = $stmt->rowCount();
    $stmt->closeCursor();
    if ($changed === 0) {
        json_response(['error' => 'This request was already decided by someone else. Refresh the list.'], 409);
    }
    $details = er_normalize_details(json_decode((string)$request['details_json'], true) ?: []);
    $inner = '<p style="margin:0 0 12px;">Your exam request <strong>#' . $requestId . '</strong>'
        . ($details['title'] !== '' ? ' (' . er_h($details['title']) . ')' : '')
        . ' was not approved.</p>'
        . '<p style="margin:0 0 6px;color:#64748b;">Note from the approver:</p>'
        . '<div style="margin:0 0 14px;padding:12px 14px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;white-space:pre-wrap;">' . er_h($note) . '</div>'
        . '<p style="margin:0;color:#475569;">You can send a corrected request with the usual template and your security code.</p>';
    er_send_mail($pdo, $env, $request['company_id'] !== null ? (int)$request['company_id'] : null, er_requester_address($pdo, $request),
        '[ProctorGuard] Exam request #' . $requestId . ' was not approved', er_email_html('Exam request not approved', $inner));
    // WhatsApp copy with the approver's note (trimmed to fit a template variable; the email has it in full).
    $shortNote = mb_strlen($note, 'UTF-8') > 300 ? rtrim(mb_substr($note, 0, 297, 'UTF-8')) . '…' : $note;
    whatsapp_notify_requester($pdo, $env, (int)($request['requester_id'] ?? 0), $requestId, (string)$details['title'], 'rejected: ' . $shortNote);
    audit_log($pdo, [
        'companyId' => $request['company_id'] !== null ? (int)$request['company_id'] : null, 'actorRole' => $actorRole, 'actorId' => $actorId,
        'action' => 'EXAM_REQUEST_REJECT', 'targetType' => 'exam_request', 'targetId' => (string)$requestId,
        'message' => "Exam request #{$requestId} rejected",
        'metadata' => ['note' => er_clip($note, 500)],
    ]);
    json_response(['ok' => true, 'request' => er_request_public(er_fetch_request($pdo, $requestId))]);
}

json_response(['error' => 'Unknown action.'], 400);
