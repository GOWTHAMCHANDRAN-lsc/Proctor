<?php
declare(strict_types=1);

/**
 * Server-side renderer for the per-exam invitation / reminder email.
 *
 * A faithful PHP port of services/examEmail.ts buildExamEmailContent (and services/timezone.ts's
 * date formatting): for the same exam, template, recipient and link it produces the same subject and
 * the same HTML, byte for byte, as the admin's browser previews and sends. Change both files together.
 *
 * Pure and include-able: no HTTP handling, no output, no side effects at include time. It does not
 * require _bootstrap.php (it uses pg_env('APP_ORIGIN') only when that helper is already loaded).
 * Include with require_once.
 *
 *   exam_mail_load_template(PDO $pdo, string $examId, string $kind): ?array
 *       → ['subject' => string, 'message' => string, 'options' => array] or null (no override saved)
 *   exam_mail_render(array $exam, string $recipientName, string $link, string $kind, ?array $template = null, ?string $origin = null): array
 *       → ['subject' => string, 'html' => string]
 *
 * $exam is the shape exams.php build_exam_response() returns (camelCase). Fields used:
 *   title (string), durationMinutes (int), startTime / endTime (int ms since epoch),
 *   timezone (?string IANA id; null/invalid → Asia/Kolkata),
 *   allowedDeviceTypes (?string[] of desktop|tablet|mobile; empty = all),
 *   proctoringConfig (?array: mode PROCTORED|UNPROCTORED, cameraRequired, microphoneRequired),
 *   notificationConfig (?array: customSubject, customMessage — legacy invitation copy),
 *   mailTemplates (?array keyed INVITE|REMINDER — used when $template is null).
 * $template (subject/message/options, e.g. from exam_mail_load_template) replaces mailTemplates[$kind].
 * $origin is where the instructions PDF is served from (default: APP_ORIGIN, else the production URL).
 * Reminders carry no link: pass '' (any $link is still escaped, as in the browser).
 */

const EXAM_MAIL_DEFAULT_TIMEZONE = 'Asia/Kolkata';
const EXAM_MAIL_DEFAULT_ORIGIN = 'https://proctor.lsc-crm.in';
const EXAM_MAIL_DEFAULT_INVITE_SUBJECT = 'Your Exam Invitation — {ExamTitle}';
const EXAM_MAIL_DEFAULT_REMINDER_SUBJECT = 'Reminder — {ExamTitle}';
const EXAM_MAIL_DEFAULT_INVITE_MESSAGE = "Dear {StudentName},\n\n"
    . 'You have been invited to appear for a proctored online examination. Please review the details '
    . 'below and click the button to begin when you are ready.';
const EXAM_MAIL_DEFAULT_REMINDER_MESSAGE = "Dear {StudentName},\n\n"
    . 'This is a friendly reminder about your proctored online examination "{ExamTitle}". Our records '
    . 'show that you have not completed it yet. Please review the details below and make sure you are '
    . "prepared before the assessment window closes.\n\n"
    . 'Your secure exam link was shared in your invitation email. Kindly ignore this message if you '
    . 'have already taken the assessment.';

/** Length caps — the same as EXAM_MAIL_LIMITS in services/examEmail.ts. */
const EXAM_MAIL_LIMITS = [
    'subject' => 255,
    'message' => 20000,
    'headerTitle' => 120,
    'buttonText' => 60,
    'closingNote' => 1000,
];
const EXAM_MAIL_OPTION_TEXT_KEYS = ['headerTitle', 'buttonText', 'closingNote'];
const EXAM_MAIL_OPTION_BOOL_KEYS = [
    'showSchedule', 'showDuration', 'showCandidate', 'showRequirements', 'showInstructionsPdf', 'showProctoringNotice',
];

/** services/timezone.ts EXAM_TIMEZONES value → name. */
const EXAM_MAIL_TIMEZONE_NAMES = [
    'Pacific/Honolulu' => 'Hawaii Time',
    'America/Anchorage' => 'Alaska Time',
    'America/Los_Angeles' => 'US Pacific Time',
    'America/Denver' => 'US Mountain Time',
    'America/Chicago' => 'US Central Time',
    'America/New_York' => 'US Eastern Time',
    'America/Sao_Paulo' => 'Brasília Time',
    'Etc/UTC' => 'GMT',
    'Europe/London' => 'UK Time',
    'Europe/Paris' => 'Central Europe Time',
    'Europe/Athens' => 'Eastern Europe Time',
    'Asia/Riyadh' => 'Riyadh Time',
    'Asia/Dubai' => 'Gulf Time',
    'Asia/Karachi' => 'Pakistan Time',
    'Asia/Kolkata' => 'India Time',
    'Asia/Dhaka' => 'Bangladesh Time',
    'Asia/Bangkok' => 'Indochina Time',
    'Asia/Singapore' => 'Singapore Time',
    'Asia/Tokyo' => 'Japan Time',
    'Australia/Sydney' => 'Sydney Time',
    'Pacific/Auckland' => 'New Zealand Time',
];

/** JavaScript's whitespace set (String.prototype.trim and the regex \s), as a PCRE class. */
const EXAM_MAIL_JS_WS = '[\x{0009}\x{000A}\x{000B}\x{000C}\x{000D}\x{0020}\x{00A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}]';

// ---------------------------------------------------------------------------------------------
// JavaScript semantics helpers
// ---------------------------------------------------------------------------------------------

/** String.prototype.trim(): strips Unicode whitespace, not just ASCII like PHP's trim(). */
function exam_mail_js_trim(string $s): string {
    $out = preg_replace('/^' . EXAM_MAIL_JS_WS . '+|' . EXAM_MAIL_JS_WS . '+$/uD', '', $s);
    return $out === null ? trim($s) : $out;
}

/** Math.round(): halves round up (toward +Infinity). */
function exam_mail_js_round(float $x): float {
    $floor = floor($x);
    return ($x - $floor) >= 0.5 ? $floor + 1 : $floor;
}

/** The email's escape for plain text in HTML (& < > " '), identical to escapeEmailHtml(). */
function exam_mail_escape(string $value): string {
    return strtr($value, ['&' => '&amp;', '<' => '&lt;', '>' => '&gt;', '"' => '&quot;', "'" => '&#39;']);
}

/** "1 hr 30 min" — formatDuration(). */
function exam_mail_format_duration($mins): string {
    if (is_bool($mins)) {
        $n = $mins ? 1.0 : 0.0;
    } elseif (is_int($mins) || is_float($mins) || (is_string($mins) && is_numeric(trim($mins)))) {
        $n = (float)$mins;
    } else {
        $n = 0.0; // Number(null) / NaN || 0
    }
    if (is_nan($n) || is_infinite($n)) $n = 0.0;
    $total = (int)max(0, exam_mail_js_round($n));
    if ($total === 0) return 'Not specified';
    $h = intdiv($total, 60);
    $m = $total % 60;
    if ($h === 0) return "{$m} min";
    if ($m === 0) return "{$h} hr";
    return "{$h} hr {$m} min";
}

// ---------------------------------------------------------------------------------------------
// Timezones (services/timezone.ts). Uses ICU through ext-intl when loaded — the same engine and
// zone ids (incl. aliases like Asia/Calcutta) the browser's Intl uses; plain DateTime otherwise.
// ---------------------------------------------------------------------------------------------

/** Canonical-case zone id for a (case-insensitive) zone name, or null when unknown — Intl's rule. */
function exam_mail_zone_id(string $tz): ?string {
    static $map = null;
    if ($map === null) {
        $map = [];
        $ids = extension_loaded('intl')
            ? iterator_to_array(IntlTimeZone::createEnumeration(), false)
            : DateTimeZone::listIdentifiers(DateTimeZone::ALL_WITH_BC);
        foreach ($ids as $id) {
            $map[strtolower((string)$id)] = (string)$id;
        }
    }
    return $map[strtolower($tz)] ?? null;
}

/** resolveExamTimezone(): the stored zone when valid (kept as given), else the default. */
function exam_mail_resolve_timezone($tz): string {
    if (is_string($tz) && $tz !== '' && exam_mail_zone_id($tz) !== null) return $tz;
    return EXAM_MAIL_DEFAULT_TIMEZONE;
}

/**
 * `new Date(ms)` → seconds since epoch, or null for an Invalid Date. JSON null behaves like
 * `new Date(null)` (the epoch); numeric strings are accepted for PHP callers' convenience.
 */
function exam_mail_epoch_seconds($ms): ?float {
    if ($ms === null) return 0.0;
    if (is_int($ms) || is_float($ms) || (is_string($ms) && is_numeric(trim($ms)))) {
        $f = (float)$ms;
        if (is_nan($f) || is_infinite($f) || abs($f) > 8.64e15) return null;
        return floor($f / 1000);
    }
    return null;
}

/** Format an instant in a zone with an ICU pattern (intl) or a date() format (fallback). */
function exam_mail_format_in_zone($ms, string $tz, string $locale, string $icuPattern, string $phpFormat): string {
    $sec = exam_mail_epoch_seconds($ms);
    if ($sec === null) return 'Invalid Date';
    $zoneId = exam_mail_zone_id($tz) ?? EXAM_MAIL_DEFAULT_TIMEZONE;
    if (extension_loaded('intl')) {
        $fmt = new IntlDateFormatter($locale, IntlDateFormatter::NONE, IntlDateFormatter::NONE,
            IntlTimeZone::createTimeZone($zoneId), IntlDateFormatter::GREGORIAN, $icuPattern);
        $out = $fmt->format($sec);
        if (is_string($out)) return $out;
    }
    try {
        $dt = (new DateTimeImmutable('@' . (int)$sec))->setTimezone(new DateTimeZone($zoneId));
    } catch (Throwable $e) {
        $dt = (new DateTimeImmutable('@' . (int)$sec))->setTimezone(new DateTimeZone(EXAM_MAIL_DEFAULT_TIMEZONE));
    }
    return $dt->format($phpFormat);
}

/** "13 July 2026" — formatDateInZone(). */
function exam_mail_format_date($ms, string $tz): string {
    return exam_mail_format_in_zone($ms, $tz, 'en_GB', 'd MMMM y', 'j F Y');
}

/** "3:30 AM" — formatTimeInZone(). */
function exam_mail_format_time($ms, string $tz): string {
    return exam_mail_format_in_zone($ms, $tz, 'en_US', 'h:mm a', 'g:i A');
}

/** "Monday" — formatWeekdayInZone(). */
function exam_mail_format_weekday($ms, string $tz): string {
    return exam_mail_format_in_zone($ms, $tz, 'en_US', 'EEEE', 'l');
}

/** "GMT+5:30" — Intl's shortOffset for a zone right now (gmtAbbrev(Date.now(), tz)). */
function exam_mail_gmt_abbrev(string $tz): string {
    $zoneId = exam_mail_zone_id($tz);
    if ($zoneId === null) return $tz;
    if (extension_loaded('intl')) {
        $fmt = new IntlDateFormatter('en_US', IntlDateFormatter::NONE, IntlDateFormatter::NONE,
            IntlTimeZone::createTimeZone($zoneId), IntlDateFormatter::GREGORIAN, 'O');
        $out = $fmt->format(time());
        if (is_string($out)) return $out;
    }
    try {
        $offset = (new DateTimeImmutable('now', new DateTimeZone($zoneId)))->getOffset();
    } catch (Throwable $e) {
        return $tz;
    }
    if ($offset === 0) return 'GMT';
    $abs = abs($offset);
    $h = intdiv($abs, 3600);
    $m = intdiv($abs % 3600, 60);
    return 'GMT' . ($offset < 0 ? '-' : '+') . $h . ($m ? ':' . str_pad((string)$m, 2, '0', STR_PAD_LEFT) : '');
}

/** "Riyadh Time" for curated zones, else the live GMT offset — timezoneName(). */
function exam_mail_timezone_name(string $tz): string {
    return EXAM_MAIL_TIMEZONE_NAMES[$tz] ?? exam_mail_gmt_abbrev($tz);
}

/** "13 July 2026, 3:30 AM (Riyadh Time) (Monday)" — formatScheduleLabel(). */
function exam_mail_schedule_label($ms, string $tz): string {
    return exam_mail_format_date($ms, $tz) . ', ' . exam_mail_format_time($ms, $tz)
        . ' (' . exam_mail_timezone_name($tz) . ') (' . exam_mail_format_weekday($ms, $tz) . ')';
}

// ---------------------------------------------------------------------------------------------
// Templates and options
// ---------------------------------------------------------------------------------------------

/** Objects (stdClass from json_decode / API code) as arrays; anything else as-is. */
function exam_mail_as_array($value) {
    return is_object($value) ? (array)$value : $value;
}

/**
 * Validate + normalise posted template options (the API's rule, mirrored by normalizeMailOptions()
 * on the client): strings trimmed and length-capped (empty → dropped), accentColor must be a 6-digit
 * hex (stored lower-case), booleans coerced (true/false, 1/0, "true"/"false"…), unknown keys dropped.
 * null → []. On invalid input returns null and sets $error.
 */
function exam_mail_normalize_options($raw, ?string &$error = null): ?array {
    $error = null;
    $raw = exam_mail_as_array($raw);
    if ($raw === null) return [];
    if (!is_array($raw) || ($raw !== [] && array_is_list($raw))) {
        $error = 'options must be an object.';
        return null;
    }
    $out = [];
    foreach (EXAM_MAIL_OPTION_TEXT_KEYS as $key) {
        if (!array_key_exists($key, $raw) || $raw[$key] === null) continue;
        if (!is_string($raw[$key])) {
            $error = "options.{$key} must be text.";
            return null;
        }
        $value = exam_mail_js_trim($raw[$key]);
        if ($value === '') continue;
        $out[$key] = mb_substr($value, 0, EXAM_MAIL_LIMITS[$key]);
    }
    if (array_key_exists('accentColor', $raw) && $raw['accentColor'] !== null && $raw['accentColor'] !== '') {
        $accent = is_string($raw['accentColor']) ? trim($raw['accentColor']) : '';
        if (!preg_match('/^#[0-9a-fA-F]{6}$/D', $accent)) {
            $error = 'options.accentColor must be a hex colour like #1a73e8.';
            return null;
        }
        $out['accentColor'] = strtolower($accent);
    }
    foreach (EXAM_MAIL_OPTION_BOOL_KEYS as $key) {
        if (!array_key_exists($key, $raw) || $raw[$key] === null) continue;
        $value = $raw[$key];
        $parsed = is_bool($value) ? $value : filter_var($value, FILTER_VALIDATE_BOOLEAN, FILTER_NULL_ON_FAILURE);
        if ($parsed === null || is_array($value)) {
            $error = "options.{$key} must be true or false.";
            return null;
        }
        $out[$key] = $parsed;
    }
    return $out;
}

/** The saved override for one exam + kind, or null when the built-in email applies. */
function exam_mail_load_template(PDO $pdo, string $examId, string $kind): ?array {
    $kind = strtoupper($kind);
    if (!in_array($kind, ['INVITE', 'REMINDER'], true)) return null;
    try {
        $stmt = $pdo->prepare('SELECT subject, message, options_json FROM exam_mail_templates WHERE exam_id = ? AND kind = ? LIMIT 1');
        $stmt->execute([$examId, $kind]);
    } catch (Throwable $e) {
        // Table or the options column not created yet (exams.php adds them on first use).
        try {
            $stmt = $pdo->prepare('SELECT subject, message FROM exam_mail_templates WHERE exam_id = ? AND kind = ? LIMIT 1');
            $stmt->execute([$examId, $kind]);
        } catch (Throwable $e2) {
            return null;
        }
    }
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    $stmt->closeCursor();
    if (!$row) return null;
    $options = [];
    if (isset($row['options_json']) && $row['options_json'] !== null && $row['options_json'] !== '') {
        $decoded = json_decode((string)$row['options_json'], true);
        $options = exam_mail_normalize_options(is_array($decoded) ? $decoded : null) ?? [];
    }
    return [
        'subject' => (string)($row['subject'] ?? ''),
        'message' => (string)($row['message'] ?? ''),
        'options' => $options,
    ];
}

/** Non-empty string after a JS trim, else ''. Mirrors `value?.trim() || fallback` without PHP's "0" quirk. */
function exam_mail_trimmed_text($value): string {
    return is_string($value) ? exam_mail_js_trim($value) : '';
}

/** resolveExamMailTemplate(): saved override → legacy notificationConfig (invitations) → default. */
function exam_mail_resolve_template(array $exam, bool $reminder): array {
    $templates = exam_mail_as_array($exam['mailTemplates'] ?? null);
    $saved = is_array($templates) ? exam_mail_as_array($templates[$reminder ? 'REMINDER' : 'INVITE'] ?? null) : null;
    $saved = is_array($saved) ? $saved : [];
    $proctoring = exam_mail_as_array($exam['proctoringConfig'] ?? null);
    $unproctored = is_array($proctoring) && ($proctoring['mode'] ?? null) === 'UNPROCTORED';
    $copy = static fn(string $text): string => $unproctored
        ? str_replace('proctored online examination', 'online examination', $text)
        : $text;
    $options = exam_mail_as_array($saved['options'] ?? null);
    $options = is_array($options) ? $options : null;
    $savedSubject = exam_mail_trimmed_text($saved['subject'] ?? null);
    $savedMessage = exam_mail_trimmed_text($saved['message'] ?? null);
    if ($reminder) {
        return [
            'subject' => $savedSubject !== '' ? $savedSubject : EXAM_MAIL_DEFAULT_REMINDER_SUBJECT,
            'message' => $savedMessage !== '' ? $savedMessage : $copy(EXAM_MAIL_DEFAULT_REMINDER_MESSAGE),
            'options' => $options,
        ];
    }
    $notification = exam_mail_as_array($exam['notificationConfig'] ?? null);
    $notification = is_array($notification) ? $notification : [];
    $legacySubject = exam_mail_trimmed_text($notification['customSubject'] ?? null);
    $legacyMessage = exam_mail_trimmed_text($notification['customMessage'] ?? null);
    return [
        'subject' => $savedSubject !== '' ? $savedSubject : ($legacySubject !== '' ? $legacySubject : EXAM_MAIL_DEFAULT_INVITE_SUBJECT),
        'message' => $savedMessage !== '' ? $savedMessage : ($legacyMessage !== '' ? $legacyMessage : $copy(EXAM_MAIL_DEFAULT_INVITE_MESSAGE)),
        'options' => $options,
    ];
}

/** resolveMailOptions(): each option with its default applied. */
function exam_mail_resolve_options($options, bool $unproctored): array {
    $o = exam_mail_as_array($options);
    $o = is_array($o) ? $o : [];
    $text = static fn($v): string => is_string($v) ? exam_mail_js_trim($v) : '';
    $flag = static fn($v, bool $fallback): bool => is_bool($v) ? $v : $fallback;
    $accent = $o['accentColor'] ?? null;
    return [
        'headerTitle' => $text($o['headerTitle'] ?? null),
        'buttonText' => $text($o['buttonText'] ?? null),
        'accentColor' => is_string($accent) && preg_match('/^#[0-9a-fA-F]{6}$/D', $accent) ? strtolower($accent) : null,
        'closingNote' => $text($o['closingNote'] ?? null),
        'showSchedule' => $flag($o['showSchedule'] ?? null, true),
        'showDuration' => $flag($o['showDuration'] ?? null, true),
        'showCandidate' => $flag($o['showCandidate'] ?? null, true),
        'showRequirements' => $flag($o['showRequirements'] ?? null, true),
        'showInstructionsPdf' => $flag($o['showInstructionsPdf'] ?? null, !$unproctored),
        'showProctoringNotice' => $flag($o['showProctoringNotice'] ?? null, true),
    ];
}

// ---------------------------------------------------------------------------------------------
// Accent palette (buildMailPalette)
// ---------------------------------------------------------------------------------------------

function exam_mail_mix(array $c, int $target, float $t): array {
    return [
        (int)exam_mail_js_round($c[0] + ($target - $c[0]) * $t),
        (int)exam_mail_js_round($c[1] + ($target - $c[1]) * $t),
        (int)exam_mail_js_round($c[2] + ($target - $c[2]) * $t),
    ];
}

function exam_mail_hex(array $c): string {
    return sprintf('#%02x%02x%02x', $c[0], $c[1], $c[2]);
}

function exam_mail_contrast_with_white(array $c): float {
    $lum = static function (int $v): float {
        $s = $v / 255;
        return $s <= 0.04045 ? $s / 12.92 : pow(($s + 0.055) / 1.055, 2.4);
    };
    $l = 0.2126 * $lum($c[0]) + 0.7152 * $lum($c[1]) + 0.0722 * $lum($c[2]);
    return 1.05 / ($l + 0.05);
}

function exam_mail_darken_for_contrast(array $c, float $min): array {
    for ($i = 0; $i <= 9; $i++) {
        $candidate = $i === 0 ? $c : exam_mail_mix($c, 0, $i / 10);
        if (exam_mail_contrast_with_white($candidate) >= $min) return $candidate;
    }
    return exam_mail_mix($c, 0, 0.9);
}

function exam_mail_palette(?string $accent): array {
    if ($accent === null) {
        return [
            'headerBg' => 'linear-gradient(135deg,#1e3a8a 0%,#2563eb 60%,#3b82f6 100%)',
            'headerEyebrow' => '#bfdbfe',
            'headerSub' => '#93c5fd',
            'ctaBg' => 'linear-gradient(135deg,#1d4ed8,#2563eb)',
            'ctaText' => '#ffffff',
            'ctaShadow' => 'rgba(37,99,235,0.4)',
            'link' => '#2563eb',
            'bandBg' => '#eff6ff',
            'bandBorder' => '#dbeafe',
            'bandHeading' => '#1d4ed8',
            'pdfBg' => '#eff6ff',
            'pdfText' => '#1d4ed8',
            'pdfBorder' => '#bfdbfe',
        ];
    }
    $base = [hexdec(substr($accent, 1, 2)), hexdec(substr($accent, 3, 2)), hexdec(substr($accent, 5, 2))];
    $base = array_map('intval', $base);
    $mid = exam_mail_darken_for_contrast($base, 3);
    $link = exam_mail_darken_for_contrast($base, 4.5);
    $strong = exam_mail_darken_for_contrast(exam_mail_mix($base, 0, 0.12), 4.5);
    return [
        'headerBg' => 'linear-gradient(135deg,' . exam_mail_hex(exam_mail_mix($mid, 0, 0.4)) . ' 0%,' . exam_mail_hex($mid)
            . ' 60%,' . exam_mail_hex(exam_mail_mix($mid, 255, 0.2)) . ' 100%)',
        'headerEyebrow' => exam_mail_hex(exam_mail_mix($mid, 255, 0.75)),
        'headerSub' => exam_mail_hex(exam_mail_mix($mid, 255, 0.55)),
        'ctaBg' => 'linear-gradient(135deg,' . exam_mail_hex(exam_mail_mix($base, 0, 0.12)) . ',' . exam_mail_hex($base) . ')',
        'ctaText' => exam_mail_contrast_with_white($base) >= 3 ? '#ffffff' : '#0f172a',
        'ctaShadow' => "rgba({$base[0]},{$base[1]},{$base[2]},0.4)",
        'link' => exam_mail_hex($link),
        'bandBg' => exam_mail_hex(exam_mail_mix($base, 255, 0.93)),
        'bandBorder' => exam_mail_hex(exam_mail_mix($base, 255, 0.82)),
        'bandHeading' => exam_mail_hex($strong),
        'pdfBg' => exam_mail_hex(exam_mail_mix($base, 255, 0.93)),
        'pdfText' => exam_mail_hex($strong),
        'pdfBorder' => exam_mail_hex(exam_mail_mix($base, 255, 0.7)),
    ];
}

// ---------------------------------------------------------------------------------------------
// The email
// ---------------------------------------------------------------------------------------------

/**
 * Render one invitation (INVITE) or reminder (REMINDER) for one recipient. See the file header for
 * the $exam fields used. Returns ['subject' => plain text, 'html' => the full HTML document].
 */
/**
 * Load an exam by id in the camelCase shape exam_mail_render() expects (plus its saved per-exam
 * templates under mailTemplates). The server-side senders — LMS integration invites and approved
 * exam-request invites — only hold raw `exams` rows; this keeps their emails identical to what the
 * admin console previews and sends for the same exam. Returns null when the exam doesn't exist.
 */
function exam_mail_exam_by_id(PDO $pdo, string $examId): ?array {
    $stmt = $pdo->prepare('SELECT * FROM exams WHERE id = ? LIMIT 1');
    $stmt->execute([$examId]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    $stmt->closeCursor();
    if (!$row) {
        return null;
    }
    $toMs = static function ($value): ?int {
        if ($value === null || $value === '') return null;
        try {
            return (int)(new DateTimeImmutable((string)$value, new DateTimeZone('UTC')))->format('Uv');
        } catch (Throwable $e) {
            return null;
        }
    };
    $devices = json_decode((string)($row['allowed_device_types_json'] ?? ''), true);
    $templates = [];
    foreach (['INVITE', 'REMINDER'] as $kind) {
        $tpl = exam_mail_load_template($pdo, $examId, $kind);
        if ($tpl !== null) {
            $templates[$kind] = $tpl;
        }
    }
    return [
        'id' => (string)$row['id'],
        'title' => (string)$row['title'],
        'durationMinutes' => (int)($row['duration_minutes'] ?? 0),
        'startTime' => $toMs($row['start_time'] ?? null),
        'endTime' => $toMs($row['end_time'] ?? null),
        'timezone' => isset($row['timezone']) && $row['timezone'] !== '' ? (string)$row['timezone'] : null,
        'allowedDeviceTypes' => is_array($devices) ? array_values(array_filter($devices, 'is_string')) : [],
        'proctoringConfig' => [
            'mode' => strtoupper((string)($row['proctoring_mode'] ?? 'PROCTORED')) === 'UNPROCTORED' ? 'UNPROCTORED' : 'PROCTORED',
            'cameraRequired' => !empty($row['camera_required']),
            'microphoneRequired' => !empty($row['microphone_required']),
        ],
        'notificationConfig' => [
            'customSubject' => (string)($row['notification_subject'] ?? ''),
            'customMessage' => (string)($row['notification_message'] ?? ''),
        ],
        'mailTemplates' => $templates,
    ];
}

function exam_mail_render(array $exam, string $recipientName, string $link, string $kind, ?array $template = null, ?string $origin = null): array {
    $kind = strtoupper(trim($kind));
    $reminder = $kind === 'REMINDER';
    if ($template !== null) {
        $templates = exam_mail_as_array($exam['mailTemplates'] ?? null);
        $templates = is_array($templates) ? $templates : [];
        $templates[$reminder ? 'REMINDER' : 'INVITE'] = $template;
        $exam['mailTemplates'] = $templates;
    }
    if ($origin === null) {
        $origin = function_exists('pg_env') ? (string)pg_env('APP_ORIGIN', EXAM_MAIL_DEFAULT_ORIGIN) : EXAM_MAIL_DEFAULT_ORIGIN;
    }
    $instructionsUrl = rtrim($origin, '/') . '/ProctorGuard_Exam_Instructions_updated.pdf';

    $title = (string)($exam['title'] ?? '');
    $startMs = $exam['startTime'] ?? null;
    $endMs = $exam['endTime'] ?? null;
    $examTz = exam_mail_resolve_timezone($exam['timezone'] ?? null);
    $durationLabel = exam_mail_format_duration($exam['durationMinutes'] ?? null);
    $dateStr = exam_mail_format_date($startMs, $examTz);
    $timeStr = exam_mail_format_time($startMs, $examTz);
    $winOpenLabel = exam_mail_schedule_label($startMs, $examTz);
    $winCloseLabel = exam_mail_schedule_label($endMs, $examTz);

    $startLabel = "{$dateStr} at {$timeStr}";
    $endLabel = exam_mail_format_date($endMs, $examTz) . ' at ' . exam_mail_format_time($endMs, $examTz);
    $safeName = exam_mail_escape($recipientName);
    $safeTitle = exam_mail_escape($title);
    $safeLink = exam_mail_escape($link);
    $fill = static function (string $tpl, bool $html = false) use ($safeName, $recipientName, $safeTitle, $title, $startLabel, $endLabel, $durationLabel, $safeLink, $link): string {
        $out = preg_replace_callback('/\{(StudentName|ExamTitle|StartTime|EndTime|Duration|Link)\}/', static function (array $m) use ($html, $safeName, $recipientName, $safeTitle, $title, $startLabel, $endLabel, $durationLabel, $safeLink, $link): string {
            switch ($m[1]) {
                case 'StudentName': return $html ? $safeName : $recipientName;
                case 'ExamTitle': return $html ? $safeTitle : $title;
                case 'StartTime': return $startLabel;
                case 'EndTime': return $endLabel;
                case 'Duration': return $durationLabel;
                default: return $html ? $safeLink : $link;
            }
        }, $tpl);
        return $out ?? $tpl;
    };
    $fillText = static fn(string $text): string => $fill(exam_mail_escape($text), true);

    $resolved = exam_mail_resolve_template($exam, $reminder);
    $subject = $fill($resolved['subject']);
    $message = exam_mail_js_trim($recipientName) === ''
        ? $fill($resolved['message'], true)
        : str_replace($safeName, "<strong>{$safeName}</strong>", $fill($resolved['message'], true));

    $proctoring = exam_mail_as_array($exam['proctoringConfig'] ?? null);
    $hasProctoring = is_array($proctoring);
    $unproctored = $hasProctoring && ($proctoring['mode'] ?? null) === 'UNPROCTORED';
    $opts = exam_mail_resolve_options($resolved['options'], $unproctored);
    $pal = exam_mail_palette($opts['accentColor']);

    // Paragraphs: split on blank lines (JS /\n\s*\n/), trim, drop empties.
    $paras = preg_split('/\n' . EXAM_MAIL_JS_WS . '*\n/u', $message);
    if ($paras === false) $paras = preg_split('/\n\s*\n/', $message) ?: [$message];
    $messageParas = array_values(array_filter(array_map('exam_mail_js_trim', $paras), static fn($p) => $p !== ''));
    $greetingParts = [];
    foreach ($messageParas as $i => $para) {
        $para = str_replace("\n", '<br/>', $para);
        $greetingParts[] = $i === 0
            ? '<p style="margin:0;font-size:16px;color:#1e293b;line-height:1.6;">' . $para . '</p>'
            : '<p style="margin:12px 0 0;font-size:14px;color:#475569;line-height:1.7;">' . $para . '</p>';
    }
    $greetingBlock = implode("\n  ", $greetingParts);

    // Details card.
    $metaCells = [];
    if ($opts['showDuration']) $metaCells[] = ['Duration', $durationLabel];
    if ($opts['showCandidate']) $metaCells[] = ['Candidate', $safeName];
    $rowBorder = static fn(bool $last): string => $last ? '' : 'border-bottom:1px solid #e2e8f0;';
    $scheduleRow = static function (string $label, string $value, bool $last) use ($rowBorder): string {
        $border = $rowBorder($last);
        return <<<HTML

    <tr>
      <td class="lsc-pad" style="padding:16px 24px;{$border}">
        <p style="margin:0 0 3px;font-size:10px;font-weight:700;letter-spacing:2px;color:#94a3b8;text-transform:uppercase;">{$label}</p>
        <p style="margin:0;font-size:14px;font-weight:600;color:#0f172a;">{$value}</p>
      </td>
    </tr>
HTML;
    };
    $metaCount = count($metaCells);
    $metaRow = '';
    if ($metaCount > 0) {
        $cells = '';
        foreach ($metaCells as $i => [$label, $value]) {
            $style = $metaCount === 1
                ? 'padding:16px 24px;width:100%;'
                : ($i === 0 ? 'padding:16px 24px;border-right:1px solid #e2e8f0;width:50%;' : 'padding:16px 24px;width:50%;');
            $cells .= <<<HTML

            <td class="lsc-stack" style="{$style}">
              <p style="margin:0 0 3px;font-size:10px;font-weight:700;letter-spacing:2px;color:#94a3b8;text-transform:uppercase;">{$label}</p>
              <p style="margin:0;font-size:14px;font-weight:600;color:#0f172a;">{$value}</p>
            </td>
HTML;
        }
        $metaRow = <<<HTML

    <tr>
      <td style="padding:0;">
        <table width="100%" cellpadding="0" cellspacing="0">
          <tr>{$cells}
          </tr>
        </table>
      </td>
    </tr>
HTML;
    }
    $detailsGrid = ($opts['showSchedule']
        ? $scheduleRow('Date From', $winOpenLabel, false) . $scheduleRow('To', $winCloseLabel, $metaRow === '')
        : '') . $metaRow;
    $examRowBorder = $rowBorder($detailsGrid === '');

    // Call to action (invitations only).
    $ctaLabel = $opts['buttonText'] !== '' ? $fillText($opts['buttonText']) : 'Open Exam Portal &rarr;';
    $ctaBlock = $reminder ? '' : <<<HTML

<!-- CTA Button -->
<tr>
<td class="lsc-pad" style="background:#ffffff;padding:8px 40px 32px;text-align:center;">
  <a href="{$safeLink}" target="_blank" class="lsc-cta" style="display:inline-block;background:{$pal['ctaBg']};color:{$pal['ctaText']};font-size:16px;font-weight:700;text-decoration:none;padding:16px 48px;border-radius:8px;letter-spacing:0.3px;box-shadow:0 4px 14px {$pal['ctaShadow']};">
    {$ctaLabel}
  </a>
  <p style="margin:16px 0 0;font-size:12px;color:#94a3b8;">Button not working? Copy and paste this link into your browser:</p>
  <p style="margin:6px 0 0;"><a href="{$safeLink}" style="font-size:12px;color:{$pal['link']};word-break:break-all;">{$safeLink}</a></p>
</td>
</tr>
HTML;

    // Device / system requirements.
    $allowedRaw = exam_mail_as_array($exam['allowedDeviceTypes'] ?? null);
    $allowedDevices = is_array($allowedRaw) && count($allowedRaw) > 0 ? array_values($allowedRaw) : ['desktop', 'tablet', 'mobile'];
    $devicePhrase = ['desktop' => 'a laptop or desktop computer', 'tablet' => 'a tablet', 'mobile' => 'a smartphone'];
    $deviceParts = array_map(static fn($d) => is_string($d) && isset($devicePhrase[$d]) ? $devicePhrase[$d] : 'undefined', $allowedDevices);
    $n = count($deviceParts);
    $deviceListText = $n === 1
        ? $deviceParts[0]
        : ($n === 2 ? "{$deviceParts[0]} or {$deviceParts[1]}" : implode(', ', array_slice($deviceParts, 0, -1)) . ', or ' . $deviceParts[$n - 1]);
    $allowsMobileOrTablet = in_array('mobile', $allowedDevices, true) || in_array('tablet', $allowedDevices, true);
    $isRestricted = is_array($allowedRaw) && count($allowedRaw) > 0 && count($allowedRaw) < 3;

    $browserLine = $allowsMobileOrTablet
        ? 'An up-to-date browser: <strong>Chrome</strong>, <strong>Edge</strong>, <strong>Firefox</strong>, or <strong>Safari</strong> (including iPhone &amp; iPad)'
        : 'An up-to-date browser: <strong>Chrome</strong>, <strong>Edge</strong>, or <strong>Firefox</strong> on your computer';
    $deviceRestrictionRow = $isRestricted ? <<<HTML

    <tr>
      <td style="padding:3px 0;font-size:13px;color:#334155;">&#10003; &nbsp;This exam can <strong>only</strong> be taken on {$deviceListText} — other devices will be blocked before you can start.</td>
    </tr>
HTML : '';

    $needsCamera = !$unproctored && ($hasProctoring ? !empty($proctoring['cameraRequired']) : true);
    $needsMic = !$unproctored && ($hasProctoring ? !empty($proctoring['microphoneRequired']) : true);
    $hardwareHtml = $needsCamera && $needsMic
        ? ' with a working <strong>camera</strong> and <strong>microphone</strong>'
        : ($needsCamera ? ' with a working <strong>camera</strong>'
        : ($needsMic ? ' with a working <strong>microphone</strong>' : ''));
    $permissionText = $needsCamera && $needsMic ? 'camera and microphone' : ($needsCamera ? 'camera' : ($needsMic ? 'microphone' : ''));
    $requirementRow = static fn(string $html): string => <<<HTML

            <tr>
              <td style="padding:3px 0;font-size:13px;color:#334155;">&#10003; &nbsp;{$html}</td>
            </tr>
HTML;
    $requirementRows = implode('', [
        $requirementRow(ucfirst($deviceListText) . $hardwareHtml) . $deviceRestrictionRow,
        $requirementRow($browserLine),
        $permissionText !== '' ? $requirementRow("Allow {$permissionText} access when your browser prompts you") : '',
        $unproctored
            ? $requirementRow('A <strong>stable internet connection</strong> and a quiet place where you can focus')
            : $requirementRow('A ' . ($needsCamera ? '<strong>well-lit, quiet room</strong>' : '<strong>quiet room</strong>') . ' and a <strong>stable internet connection</strong>'),
        $unproctored ? '' : $requirementRow('Stay on the exam screen — do <strong>not</strong> switch tabs, apps, or leave the window'),
    ]);
    $requirementsBlock = !$opts['showRequirements'] ? '' : <<<HTML

      <!-- Requirements -->
      <tr>
        <td class="lsc-pad" style="background:{$pal['bandBg']};padding:20px 40px;border-top:1px solid {$pal['bandBorder']};">
          <p style="margin:0 0 10px;font-size:12px;font-weight:700;color:{$pal['bandHeading']};text-transform:uppercase;letter-spacing:1px;">Before You Begin — What You Need</p>
          <table width="100%" cellpadding="0" cellspacing="0">{$requirementRows}
          </table>
        </td>
      </tr>

HTML;

    $monitoredParts = array_values(array_filter([$needsCamera ? 'webcam' : '', $needsMic ? 'microphone' : '', 'screen activity'], static fn($p) => $p !== ''));
    $mc = count($monitoredParts);
    $monitoredText = $mc === 1
        ? $monitoredParts[0]
        : implode(', ', array_slice($monitoredParts, 0, -1)) . ($mc > 2 ? ',' : '') . ' and ' . $monitoredParts[$mc - 1];
    if (!$opts['showProctoringNotice']) {
        $noticeBlock = '';
    } elseif ($unproctored) {
        $noticeBlock = <<<HTML

      <!-- Notice -->
      <tr>
        <td class="lsc-pad" style="background:#f8fafc;border-top:1px solid #e2e8f0;padding:16px 40px;">
          <p style="margin:0;font-size:12px;color:#334155;line-height:1.6;">
            <strong>&#9432; Please note:</strong> This exam is <strong>not proctored</strong> — there is no camera, microphone or screen monitoring. Answer the questions on your own and submit before the exam window closes.
          </p>
        </td>
      </tr>
HTML;
    } else {
        $noticeBlock = <<<HTML

      <!-- Warning Banner -->
      <tr>
        <td class="lsc-pad" style="background:#fef2f2;border-top:1px solid #fecaca;padding:16px 40px;">
          <p style="margin:0;font-size:12px;color:#b91c1c;line-height:1.6;">
            <strong>&#9888; Important:</strong> This exam is proctored by AI. Your {$monitoredText} will be monitored continuously. Any suspicious behaviour will be flagged as a violation and reported to the exam administrator.
          </p>
        </td>
      </tr>
HTML;
    }
    $examKind = $unproctored ? 'exam' : 'proctored exam';

    $preheaderDuration = $opts['showDuration'] ? " Duration {$durationLabel}." : '';
    $preheader = $reminder
        ? "Reminder: your {$examKind} \"{$safeTitle}\"" . ($opts['showSchedule'] ? " is open from {$winOpenLabel} to {$winCloseLabel}." : ' is still open.') . $preheaderDuration
        : "Your {$examKind} \"{$safeTitle}\"" . ($opts['showSchedule'] ? " is scheduled for {$dateStr} at {$timeStr}." : ' is ready for you.') . $preheaderDuration . ' Open the secure portal to begin.';

    $instructionsBlock = !$opts['showInstructionsPdf'] ? '' : <<<HTML

<tr>
<td class="lsc-pad" style="background:#ffffff;padding:4px 40px 24px;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;">
    <tr>
      <td style="padding:16px 20px;">
        <p style="margin:0 0 6px;font-size:12px;font-weight:700;color:#334155;">&#128196; Exam Instructions</p>
        <p style="margin:0 0 12px;font-size:13px;color:#475569;line-height:1.6;">Please read the full instructions before your exam. Download the guide below.</p>
        <a href="{$instructionsUrl}" target="_blank" style="display:inline-block;background:{$pal['pdfBg']};color:{$pal['pdfText']};font-size:13px;font-weight:600;text-decoration:none;padding:10px 20px;border-radius:6px;border:1px solid {$pal['pdfBorder']};">Download Exam Instructions (PDF) &rarr;</a>
      </td>
    </tr>
  </table>
</td>
</tr>
HTML;

    $closingHtml = $opts['closingNote'] !== '' ? str_replace("\n", '<br/>', $fillText($opts['closingNote'])) : '';
    $closingBlock = $opts['closingNote'] === '' ? '' : <<<HTML

      <!-- Closing Note -->
      <tr>
        <td class="lsc-pad" style="background:#ffffff;padding:24px 40px;border-top:1px solid #e2e8f0;">
          <p style="margin:0;font-size:14px;color:#475569;line-height:1.7;">{$closingHtml}</p>
        </td>
      </tr>
HTML;

    $headerTitle = $opts['headerTitle'] !== '' ? $fillText($opts['headerTitle']) : $safeTitle;
    $headerEyebrowText = $unproctored ? 'Online Examination' : 'Proctored Online Examination';
    $headerSubText = $unproctored ? 'Secure · Online' : 'Secure · Proctored · Online';
    $titleTag = exam_mail_escape($subject);

    $html = <<<HTML
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta name="x-apple-disable-message-reformatting" />
<meta name="color-scheme" content="light only" />
<title>{$titleTag}</title>
<style>
  body { margin:0; padding:0; -webkit-text-size-adjust:100%; }
  img { border:0; line-height:100%; outline:none; text-decoration:none; }
  a { color:{$pal['link']}; }
  @media only screen and (max-width:620px) {
    .lsc-container { width:100% !important; border-radius:0 !important; }
    .lsc-pad { padding-left:22px !important; padding-right:22px !important; }
    .lsc-stack { display:block !important; width:100% !important; border-right:none !important; }
    .lsc-h1 { font-size:22px !important; }
    .lsc-cta { display:block !important; width:auto !important; }
  }
</style>
</head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:'Segoe UI',Arial,sans-serif;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:#f1f5f9;font-size:1px;line-height:1px;">
  {$preheader}
</div>
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:32px 0;">
  <tr><td align="center">
    <table width="600" cellpadding="0" cellspacing="0" class="lsc-container" style="max-width:600px;width:100%;border-radius:12px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.10);">

      <!-- Header -->
      <tr>
        <td class="lsc-pad" style="background:{$pal['headerBg']};padding:36px 40px 28px;">
          <p style="margin:0 0 6px;font-size:11px;font-weight:700;letter-spacing:3px;color:{$pal['headerEyebrow']};text-transform:uppercase;">{$headerEyebrowText}</p>
          <h1 class="lsc-h1" style="margin:0;font-size:26px;font-weight:700;color:#ffffff;line-height:1.3;">{$headerTitle}</h1>
          <p style="margin:8px 0 0;font-size:13px;color:{$pal['headerSub']};">{$headerSubText}</p>
        </td>
      </tr>

      <!-- Greeting -->
      <tr>
        <td class="lsc-pad" style="background:#ffffff;padding:32px 40px 0;">
          {$greetingBlock}
        </td>
      </tr>

      <!-- Exam Details Card -->
      <tr>
        <td class="lsc-pad" style="background:#ffffff;padding:24px 40px;">
          <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;overflow:hidden;">
            <tr>
              <td style="padding:20px 24px;{$examRowBorder}">
                <p style="margin:0 0 3px;font-size:10px;font-weight:700;letter-spacing:2px;color:#94a3b8;text-transform:uppercase;">Exam</p>
                <p style="margin:0;font-size:15px;font-weight:600;color:#0f172a;">{$safeTitle}</p>
              </td>
            </tr>
            {$detailsGrid}
          </table>
        </td>
      </tr>

      {$ctaBlock}
{$requirementsBlock}      {$instructionsBlock}
{$noticeBlock}{$closingBlock}

      <!-- Footer -->
      <tr>
        <td class="lsc-pad" style="background:#1e293b;padding:24px 40px;text-align:center;">
          <p style="margin:0 0 4px;font-size:13px;font-weight:600;color:#f1f5f9;">ProctorGuard &mdash; Secure Online Examinations</p>
          <p style="margin:0;font-size:11px;color:#64748b;">This is an automated message. Please do not reply to this email.</p>
          <p style="margin:8px 0 0;font-size:11px;color:#475569;">If you have any issues, contact your examination coordinator.</p>
        </td>
      </tr>

    </table>
  </td></tr>
</table>
</body>
</html>
HTML;

    return ['subject' => $subject, 'html' => $html];
}
