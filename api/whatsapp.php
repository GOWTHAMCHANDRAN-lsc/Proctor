<?php
declare(strict_types=1);

/**
 * WhatsApp notifications: exam invitations (with the candidate's personal exam link), "not
 * attempted" reminders, and exam-request status updates to the employee who asked for the exam.
 *
 * Ships DISABLED. Nothing is sent, and nothing is logged, until .env sets WHATSAPP_ENABLED=1, a
 * provider with its credentials, and at least one approved template name — then it switches on with
 * no code change. See docs/WHATSAPP_SETUP.md. Two providers sit behind one interface:
 *   - meta: the WhatsApp Cloud API (POST {base}/{version}/{phone_number_id}/messages).
 *   - lsc:  an LSC gateway endpoint that sends an approved template with variables (the contract is
 *           specified in docs/WHATSAPP_SETUP.md; the existing verification-code endpoint can't carry
 *           an exam link, so it is NOT usable here).
 *
 * Used two ways:
 *   - require_once from other PHP files for the library functions (integrations.php does, for the
 *     server-side invitation path). The HTTP handler at the bottom only runs when this file is the
 *     requested script — the same guard notify.php uses.
 *   - as the staff endpoint api/whatsapp.php (status, bulk exam notices, test message).
 *
 * Secrets: provider tokens never leave the server — not in responses, not in delivery_logs, and any
 * provider error text is masked before it is stored or returned.
 */

require_once __DIR__ . '/_bootstrap.php';

const WHATSAPP_KINDS = ['INVITE', 'REMINDER', 'REQUEST_UPDATE'];
const WHATSAPP_EXAM_KINDS = ['INVITE', 'REMINDER'];
const WHATSAPP_MAX_STUDENTS = 2000;
const WHATSAPP_HTTP_TIMEOUT = 10;
const WHATSAPP_CONNECT_TIMEOUT = 5;
// After this many consecutive "provider unreachable" results (connection error, timeout, 5xx/429)
// in one PHP process, further sends in that process fail fast instead of each waiting out the
// timeout — so a provider outage can't stall a 2000-student batch (or an invitation run) for hours.
const WHATSAPP_BREAKER_LIMIT = 5;

function whatsapp_env_flag($value): bool {
    return in_array(strtolower(trim((string)$value)), ['1', 'true', 'yes', 'on'], true);
}

/**
 * Parsed WhatsApp configuration. Public part: {enabled, provider, configuredKinds, ready, issues}.
 * `issues` names the .env keys that still need setting (never their values). Everything under
 * `_transport` is secret and must never be put in a response.
 */
function whatsapp_config(array $env): array {
    $get = static fn(string $key): string => trim((string)($env[$key] ?? ''));

    $enabled = whatsapp_env_flag($env['WHATSAPP_ENABLED'] ?? '0');
    $providerRaw = strtolower($get('WHATSAPP_PROVIDER'));
    $provider = in_array($providerRaw, ['meta', 'lsc'], true) ? $providerRaw : null;

    $countryCode = substr((string)preg_replace('/\D+/', '', $get('WHATSAPP_COUNTRY_CODE')), 0, 4);
    if ($countryCode === '') {
        $countryCode = '91';
    }
    $language = $get('WHATSAPP_TEMPLATE_LANGUAGE');
    if (preg_match('/^[A-Za-z]{2,3}(_[A-Za-z]{2,4})?$/', $language) !== 1) {
        $language = 'en';
    }

    $issues = [];
    $templates = [];
    $configuredKinds = [];
    foreach (WHATSAPP_KINDS as $kind) {
        $name = $get('WHATSAPP_TEMPLATE_' . $kind);
        if ($name !== '' && preg_match('/^[A-Za-z0-9_.\-]{1,512}$/', $name) !== 1) {
            $issues[] = "WHATSAPP_TEMPLATE_{$kind} is not a valid template name (letters, digits and _ only).";
            $name = '';
        }
        $templates[$kind] = $name;
        if ($name !== '') {
            $configuredKinds[] = $kind;
        }
    }

    if (!$enabled) {
        $issues[] = 'WHATSAPP_ENABLED is not set to 1.';
    }
    if ($provider === null) {
        $issues[] = $providerRaw === ''
            ? 'WHATSAPP_PROVIDER is not set (meta or lsc).'
            : 'WHATSAPP_PROVIDER must be meta or lsc.';
    }

    $isHttpUrl = static fn(string $url): bool => $url !== ''
        && filter_var($url, FILTER_VALIDATE_URL) !== false
        && in_array(strtolower((string)parse_url($url, PHP_URL_SCHEME)), ['http', 'https'], true);

    $transport = ['meta' => null, 'lsc' => null];
    $credentialsOk = false;
    if ($provider === 'meta') {
        $phoneNumberId = $get('WHATSAPP_META_PHONE_NUMBER_ID');
        $accessToken = $get('WHATSAPP_META_ACCESS_TOKEN');
        $version = $get('WHATSAPP_META_API_VERSION') !== '' ? $get('WHATSAPP_META_API_VERSION') : 'v21.0';
        $baseUrl = $get('WHATSAPP_META_BASE_URL') !== '' ? $get('WHATSAPP_META_BASE_URL') : 'https://graph.facebook.com';
        if ($phoneNumberId === '' || !ctype_digit($phoneNumberId)) {
            $issues[] = 'WHATSAPP_META_PHONE_NUMBER_ID is not set (the numeric phone number ID from Meta).';
        }
        if ($accessToken === '') {
            $issues[] = 'WHATSAPP_META_ACCESS_TOKEN is not set.';
        }
        if (preg_match('/^v\d{1,3}(\.\d{1,3})?$/', $version) !== 1) {
            $issues[] = 'WHATSAPP_META_API_VERSION must look like v21.0.';
        }
        if (!$isHttpUrl($baseUrl)) {
            $issues[] = 'WHATSAPP_META_BASE_URL is not a valid http(s) URL.';
        }
        $credentialsOk = $phoneNumberId !== '' && ctype_digit($phoneNumberId) && $accessToken !== ''
            && preg_match('/^v\d{1,3}(\.\d{1,3})?$/', $version) === 1 && $isHttpUrl($baseUrl);
        $transport['meta'] = ['phoneNumberId' => $phoneNumberId, 'accessToken' => $accessToken, 'version' => $version, 'baseUrl' => $baseUrl];
    } elseif ($provider === 'lsc') {
        $url = $get('WHATSAPP_LSC_URL');
        $token = $get('WHATSAPP_LSC_TOKEN');
        if (!$isHttpUrl($url)) {
            $issues[] = $url === '' ? 'WHATSAPP_LSC_URL is not set.' : 'WHATSAPP_LSC_URL is not a valid http(s) URL.';
        }
        if ($token === '') {
            $issues[] = 'WHATSAPP_LSC_TOKEN is not set.';
        }
        $credentialsOk = $isHttpUrl($url) && $token !== '';
        $transport['lsc'] = ['url' => $url, 'token' => $token];
    }

    if (count($configuredKinds) === 0) {
        $issues[] = 'No message templates are set (WHATSAPP_TEMPLATE_INVITE / _REMINDER / _REQUEST_UPDATE).';
    }

    return [
        'enabled' => $enabled,
        'provider' => $provider,
        'configuredKinds' => $configuredKinds,
        'ready' => $enabled && $provider !== null && $credentialsOk && count($configuredKinds) > 0,
        'issues' => $issues,
        'countryCode' => $countryCode,
        'language' => $language,
        'templates' => $templates,
        '_transport' => $transport,
    ];
}

/** True when WhatsApp is ready AND this message kind has a template. */
function whatsapp_kind_ready(array $cfg, string $kind): bool {
    return !empty($cfg['ready']) && in_array(strtoupper($kind), $cfg['configuredKinds'] ?? [], true);
}

/** Run ensure_whatsapp_schema() at most once per PHP process. */
function whatsapp_schema_once(PDO $pdo): array {
    static $state = null;
    if ($state === null) {
        $state = ensure_whatsapp_schema($pdo);
    }
    return $state;
}

/**
 * Template parameters can't contain new lines, tabs or runs of spaces (Meta rejects them), can't be
 * empty, and are capped so one long exam title can't push the whole message over the limit.
 */
function whatsapp_clean_param(string $text): string {
    $text = (string)preg_replace('/[\x00-\x1F\x7F]+/u', ' ', $text);
    $text = (string)preg_replace('/\s{2,}/u', ' ', $text);
    $text = trim($text);
    if ($text === '') {
        return '-';
    }
    return mb_substr($text, 0, 1000, 'UTF-8');
}

/** Replace any configured secret (and anything that looks like a bearer/access token) with ***. */
function whatsapp_mask(string $text, array $cfg): string {
    $secrets = [];
    foreach (['meta' => 'accessToken', 'lsc' => 'token'] as $provider => $key) {
        $value = (string)($cfg['_transport'][$provider][$key] ?? '');
        if (strlen($value) >= 4) {
            $secrets[] = $value;
        }
    }
    foreach ($secrets as $secret) {
        $text = str_replace($secret, '***', $text);
    }
    $text = (string)preg_replace('/(Bearer\s+)[A-Za-z0-9._\-]+/i', '$1***', $text);
    $text = (string)preg_replace('/((?:access_token|stoken|token)["\']?\s*[:=]\s*["\']?)[^"\'&\s,})\]]+/i', '$1***', $text);
    return $text;
}

/**
 * POST a JSON body with curl (10s total, 5s connect, no redirects, http/https only).
 * Returns ['status' => int (0 = no response), 'body' => ?array, 'error' => ?string].
 */
function whatsapp_http_post_json(string $url, array $headers, array $body): array {
    if (!function_exists('curl_init')) {
        return ['status' => 0, 'body' => null, 'error' => 'The PHP curl extension is not installed.'];
    }
    $json = json_encode($body, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE);
    $ch = curl_init($url);
    $options = [
        CURLOPT_POST => true,
        CURLOPT_POSTFIELDS => $json === false ? '{}' : $json,
        CURLOPT_HTTPHEADER => array_merge(['Content-Type: application/json', 'Accept: application/json'], $headers),
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT => WHATSAPP_HTTP_TIMEOUT,
        CURLOPT_CONNECTTIMEOUT => WHATSAPP_CONNECT_TIMEOUT,
        CURLOPT_FOLLOWLOCATION => false,
        CURLOPT_USERAGENT => 'ProctorGuard-WhatsApp/1.0',
    ];
    if (defined('CURLOPT_PROTOCOLS_STR')) {
        $options[CURLOPT_PROTOCOLS_STR] = 'http,https';
    } elseif (defined('CURLOPT_PROTOCOLS')) {
        $options[CURLOPT_PROTOCOLS] = CURLPROTO_HTTP | CURLPROTO_HTTPS;
    }
    curl_setopt_array($ch, $options);
    $raw = curl_exec($ch);
    $error = $raw === false ? (curl_error($ch) ?: 'Request failed.') : null;
    $status = (int)curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    curl_close($ch);
    if ($raw === false) {
        return ['status' => 0, 'body' => null, 'error' => $error];
    }
    $decoded = json_decode((string)$raw, true);
    return ['status' => $status, 'body' => is_array($decoded) ? $decoded : null, 'error' => null];
}

/** Meta WhatsApp Cloud API: send one approved template message. */
function whatsapp_send_meta(array $cfg, string $to, string $template, array $params): array {
    $t = $cfg['_transport']['meta'];
    $url = rtrim((string)$t['baseUrl'], '/') . '/' . rawurlencode((string)$t['version']) . '/' . rawurlencode((string)$t['phoneNumberId']) . '/messages';
    $body = [
        'messaging_product' => 'whatsapp',
        'to' => $to,
        'type' => 'template',
        'template' => [
            'name' => $template,
            'language' => ['code' => $cfg['language']],
            'components' => [[
                'type' => 'body',
                'parameters' => array_map(static fn(string $p) => ['type' => 'text', 'text' => $p], $params),
            ]],
        ],
    ];
    $res = whatsapp_http_post_json($url, ['Authorization: Bearer ' . $t['accessToken']], $body);
    $status = (int)$res['status'];
    $messageId = (string)($res['body']['messages'][0]['id'] ?? '');
    if ($res['error'] === null && $status >= 200 && $status < 300 && $messageId !== '') {
        return ['ok' => true, 'messageId' => $messageId, 'httpStatus' => $status, 'transportFailure' => false, 'error' => null];
    }
    if ($res['error'] !== null) {
        $error = 'Could not reach the WhatsApp API: ' . $res['error'];
    } elseif (is_array($res['body']['error'] ?? null)) {
        $e = $res['body']['error'];
        $error = trim((string)($e['message'] ?? 'WhatsApp API error'));
        $detail = trim((string)($e['error_data']['details'] ?? ''));
        if ($detail !== '' && stripos($error, $detail) === false) {
            $error .= ' — ' . $detail;
        }
        if (isset($e['code'])) {
            $error .= ' (code ' . (int)$e['code'] . ')';
        }
    } elseif ($status >= 200 && $status < 300) {
        $error = 'The WhatsApp API did not return a message id.';
    } else {
        $error = "The WhatsApp API returned HTTP {$status}.";
    }
    return [
        'ok' => false,
        'messageId' => null,
        'httpStatus' => $status,
        'transportFailure' => $res['error'] !== null || $status >= 500 || $status === 429,
        'error' => $error,
    ];
}

/** LSC gateway: POST {stoken, mobile_number, template, language, params}; success = status "success" or success true. */
function whatsapp_send_lsc(array $cfg, string $to, string $template, array $params): array {
    $t = $cfg['_transport']['lsc'];
    $body = [
        'stoken' => $t['token'],
        'mobile_number' => $to,
        'template' => $template,
        'language' => $cfg['language'],
        'params' => array_values($params),
    ];
    $res = whatsapp_http_post_json((string)$t['url'], [], $body);
    $status = (int)$res['status'];
    $b = $res['body'];
    $confirmed = is_array($b) && (
        (isset($b['status']) && is_string($b['status']) && strtolower($b['status']) === 'success')
        || (($b['success'] ?? null) === true)
    );
    if ($res['error'] === null && $status >= 200 && $status < 300 && $confirmed) {
        $id = $b['message_id'] ?? $b['messageId'] ?? $b['id'] ?? null;
        return ['ok' => true, 'messageId' => is_scalar($id) ? (string)$id : null, 'httpStatus' => $status, 'transportFailure' => false, 'error' => null];
    }
    if ($res['error'] !== null) {
        $error = 'Could not reach the LSC WhatsApp gateway: ' . $res['error'];
    } else {
        $reason = '';
        foreach (['message', 'error', 'msg', 'reason'] as $key) {
            if (isset($b[$key]) && is_scalar($b[$key]) && trim((string)$b[$key]) !== '') {
                $reason = trim((string)$b[$key]);
                break;
            }
        }
        $error = $reason !== ''
            ? 'LSC gateway: ' . $reason
            : ($status >= 200 && $status < 300 ? 'The LSC gateway did not confirm the send.' : "The LSC gateway returned HTTP {$status}.");
    }
    return [
        'ok' => false,
        'messageId' => null,
        'httpStatus' => $status,
        'transportFailure' => $res['error'] !== null || $status >= 500 || $status === 429,
        'error' => $error,
    ];
}

/**
 * One delivery_logs row (channel WHATSAPP). sp_add_delivery_log only accepts EMAIL/SMS, so this is a
 * direct INSERT. Best effort: a logging failure never affects the send it records.
 */
function whatsapp_log_delivery(PDO $pdo, int $companyId, string $recipient, ?string $subject, ?string $body, string $status, ?string $error, array $metadata): void {
    if ($companyId <= 0) {
        return;
    }
    try {
        $clip = static fn(?string $v, int $max): ?string => $v === null ? null : mb_substr($v, 0, $max, 'UTF-8');
        $metaJson = json_encode($metadata, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE);
        $stmt = $pdo->prepare("INSERT INTO delivery_logs (company_id, channel, recipient, subject, body, status, error, template_id, metadata, created_at)
                               VALUES (?, 'WHATSAPP', ?, ?, ?, ?, ?, NULL, ?, NOW())");
        $stmt->execute([
            $companyId,
            $clip($recipient, 255),
            $clip($subject, 255),
            $clip($body, 4000),
            $status,
            $clip($error, 2000),
            $metaJson === false ? null : $metaJson,
        ]);
        $stmt->closeCursor();
    } catch (Throwable $e) {
        error_log('[whatsapp] delivery log write failed: ' . $e->getMessage());
    }
}

/** A short human-readable rendering of the message for the delivery log. */
function whatsapp_preview(string $kind, array $params): string {
    $labels = [
        'INVITE' => ['Name', 'Exam', 'Window', 'Duration', 'Link'],
        'REMINDER' => ['Name', 'Exam', 'Closes', 'Link'],
        'REQUEST_UPDATE' => ['Name', 'Request', 'Exam', 'Status'],
    ][$kind] ?? [];
    $parts = [];
    foreach (array_values($params) as $i => $value) {
        $label = $labels[$i] ?? ('{{' . ($i + 1) . '}}');
        $parts[] = "{$label}: {$value}";
    }
    return '[' . $kind . '] ' . implode(' | ', $parts);
}

/**
 * Send one approved template message. Returns {ok, status: SENT|FAILED|SKIPPED, error?, messageId?}.
 * SENT and FAILED write a delivery_logs row; SKIPPED (WhatsApp off / not ready / no template for this
 * kind) returns immediately WITHOUT logging, so the log doesn't fill up while the feature is disabled.
 */
function whatsapp_send_template(PDO $pdo, array $env, int $companyId, string $kind, string $mobile, array $params, array $meta = []): array {
    static $consecutiveTransportFailures = 0;

    $kind = strtoupper(trim($kind));
    if (!in_array($kind, WHATSAPP_KINDS, true)) {
        return ['ok' => false, 'status' => 'SKIPPED', 'reason' => 'UNKNOWN_KIND', 'error' => 'Unknown WhatsApp message kind.'];
    }
    $cfg = whatsapp_config($env);
    if (!whatsapp_kind_ready($cfg, $kind)) {
        return [
            'ok' => false,
            'status' => 'SKIPPED',
            'reason' => 'DISABLED',
            'error' => $cfg['ready'] ? "No WhatsApp template is configured for {$kind} messages." : 'WhatsApp notifications are not configured.',
        ];
    }
    whatsapp_schema_once($pdo);

    $template = (string)$cfg['templates'][$kind];
    $clean = array_map(static fn($p) => whatsapp_clean_param((string)$p), array_values($params));
    $preview = whatsapp_preview($kind, $clean);
    $logMeta = array_merge($meta, [
        'kind' => $kind,
        'provider' => $cfg['provider'],
        'template' => $template,
        'language' => $cfg['language'],
    ]);

    $to = normalize_mobile($mobile, (string)$cfg['countryCode']);
    if ($to === null) {
        $error = 'Invalid mobile number.';
        whatsapp_log_delivery($pdo, $companyId, mb_substr(trim($mobile), 0, 40, 'UTF-8'), $template, $preview, 'FAILED', $error, $logMeta);
        return ['ok' => false, 'status' => 'FAILED', 'error' => $error];
    }

    if ($consecutiveTransportFailures >= WHATSAPP_BREAKER_LIMIT) {
        $error = 'Not sent: the WhatsApp provider failed to respond ' . WHATSAPP_BREAKER_LIMIT . ' times in a row during this run. Try again later.';
        whatsapp_log_delivery($pdo, $companyId, '+' . $to, $template, $preview, 'FAILED', $error, $logMeta);
        return ['ok' => false, 'status' => 'FAILED', 'error' => $error];
    }

    try {
        $res = $cfg['provider'] === 'meta'
            ? whatsapp_send_meta($cfg, $to, $template, $clean)
            : whatsapp_send_lsc($cfg, $to, $template, $clean);
    } catch (Throwable $e) {
        $res = ['ok' => false, 'messageId' => null, 'httpStatus' => 0, 'transportFailure' => true, 'error' => 'WhatsApp send failed: ' . $e->getMessage()];
    }
    $consecutiveTransportFailures = $res['ok'] ? 0 : (!empty($res['transportFailure']) ? $consecutiveTransportFailures + 1 : 0);

    $error = $res['ok'] ? null : whatsapp_mask((string)($res['error'] ?? 'Send failed.'), $cfg);
    $logMeta['httpStatus'] = (int)($res['httpStatus'] ?? 0);
    if (!empty($res['messageId'])) {
        $logMeta['messageId'] = (string)$res['messageId'];
    }
    whatsapp_log_delivery($pdo, $companyId, '+' . $to, $template, $preview, $res['ok'] ? 'SENT' : 'FAILED', $error, $logMeta);

    $out = ['ok' => (bool)$res['ok'], 'status' => $res['ok'] ? 'SENT' : 'FAILED'];
    if ($error !== null) {
        $out['error'] = $error;
    }
    if (!empty($res['messageId'])) {
        $out['messageId'] = (string)$res['messageId'];
    }
    return $out;
}

/**
 * The candidate's personal exam link — exactly what the email invitations carry: the short
 * "<origin>/x/<code>" link for (exam, student, student's company) from exam_access_link() (get-or-
 * create, so the WhatsApp message and the email share one code), falling back to the long signed
 * "?token=" link if a short code can't be made.
 */
function whatsapp_exam_link(PDO $pdo, string $examId, string $studentId, int $companyId): string {
    $origin = rtrim((string)pg_env('APP_ORIGIN', 'https://proctor.lsc-crm.in'), '/');
    return exam_access_link($pdo, $origin, $examId, $studentId, $companyId);
}

function whatsapp_exam_timezone(?string $tz): DateTimeZone {
    $tz = trim((string)$tz);
    if ($tz !== '') {
        try {
            return new DateTimeZone($tz);
        } catch (Throwable $e) {
            // fall through to the app default
        }
    }
    return new DateTimeZone('Asia/Kolkata'); // services/timezone.ts DEFAULT_EXAM_TIMEZONE
}

/** A stored exam instant (UTC 'Y-m-d H:i:s.v' from the DB, or epoch ms) as a DateTimeImmutable. */
function whatsapp_parse_instant($value): ?DateTimeImmutable {
    if ($value === null || $value === '') {
        return null;
    }
    try {
        if (is_int($value) || is_float($value) || (is_string($value) && ctype_digit($value))) {
            return (new DateTimeImmutable('@' . intdiv((int)$value, 1000)))->setTimezone(new DateTimeZone('UTC'));
        }
        return new DateTimeImmutable((string)$value, new DateTimeZone('UTC'));
    } catch (Throwable $e) {
        return null;
    }
}

/** "IST" where the zone has a real abbreviation, else "GMT+4" / "GMT+5:30". */
function whatsapp_zone_label(DateTimeImmutable $dt): string {
    $abbr = $dt->format('T');
    if (preg_match('/^[A-Za-z]{2,6}$/', $abbr) === 1) {
        return $abbr;
    }
    $offset = $dt->getOffset();
    if ($offset === 0) {
        return 'GMT';
    }
    $sign = $offset < 0 ? '-' : '+';
    $offset = abs($offset);
    $hours = intdiv($offset, 3600);
    $minutes = intdiv($offset % 3600, 60);
    return 'GMT' . $sign . $hours . ($minutes > 0 ? ':' . str_pad((string)$minutes, 2, '0', STR_PAD_LEFT) : '');
}

/** "15 Oct 2026, 10:00 – 18:00 IST" (or "15 Oct 2026, 10:00 – 16 Oct 2026, 18:00 IST" across days). */
function whatsapp_format_window($start, $end, ?string $tz): string {
    $zone = whatsapp_exam_timezone($tz);
    $s = whatsapp_parse_instant($start);
    $e = whatsapp_parse_instant($end);
    if ($s === null || $e === null) {
        return 'see your invitation email';
    }
    $s = $s->setTimezone($zone);
    $e = $e->setTimezone($zone);
    $sameDay = $s->format('Y-m-d') === $e->format('Y-m-d');
    return $s->format('j M Y, H:i') . ' – ' . ($sameDay ? $e->format('H:i') : $e->format('j M Y, H:i')) . ' ' . whatsapp_zone_label($e);
}

/** "15 Oct 2026, 18:00 IST". */
function whatsapp_format_instant($value, ?string $tz): string {
    $dt = whatsapp_parse_instant($value);
    if ($dt === null) {
        return 'see your invitation email';
    }
    $dt = $dt->setTimezone(whatsapp_exam_timezone($tz));
    return $dt->format('j M Y, H:i') . ' ' . whatsapp_zone_label($dt);
}

/** "30 minutes", "1 hour", "1 hour 30 minutes". */
function whatsapp_format_duration(int $minutes): string {
    $minutes = max(0, $minutes);
    $plural = static fn(int $n, string $unit): string => $n . ' ' . $unit . ($n === 1 ? '' : 's');
    if ($minutes < 60) {
        return $plural($minutes, 'minute');
    }
    $hours = intdiv($minutes, 60);
    $rest = $minutes % 60;
    return $plural($hours, 'hour') . ($rest > 0 ? ' ' . $plural($rest, 'minute') : '');
}

/** Fill in any schedule fields the caller's exam row lacks (integrations passes only id + title). */
function whatsapp_complete_exam_row(PDO $pdo, int $companyId, array $exam): ?array {
    $id = (string)($exam['id'] ?? '');
    if ($id === '') {
        return null;
    }
    $row = [
        'id' => $id,
        'title' => $exam['title'] ?? null,
        'start_time' => $exam['start_time'] ?? $exam['startTime'] ?? null,
        'end_time' => $exam['end_time'] ?? $exam['endTime'] ?? null,
        'timezone' => $exam['timezone'] ?? null,
        'duration_minutes' => $exam['duration_minutes'] ?? $exam['durationMinutes'] ?? null,
    ];
    if ($row['title'] === null || $row['start_time'] === null || $row['end_time'] === null || $row['duration_minutes'] === null) {
        $stmt = $pdo->prepare('SELECT id, title, start_time, end_time, timezone, duration_minutes FROM exams WHERE id = ? AND company_id = ? LIMIT 1');
        $stmt->execute([$id, $companyId]);
        $db = $stmt->fetch();
        $stmt->closeCursor();
        if (!$db) {
            return null;
        }
        $row = $db;
    }
    return $row;
}

/**
 * Send one exam notice (INVITE | REMINDER) to one student. $student is a students row (id, full_name,
 * mobile, company_id); a row without `mobile` is looked up. Returns whatsapp_send_template()'s result,
 * or SKIPPED with reason NO_MOBILE / DISABLED (never logged).
 */
function whatsapp_send_exam_notice(PDO $pdo, array $env, int $companyId, array $examRow, array $student, string $kind): array {
    $kind = strtoupper(trim($kind));
    if (!in_array($kind, WHATSAPP_EXAM_KINDS, true)) {
        return ['ok' => false, 'status' => 'SKIPPED', 'reason' => 'UNKNOWN_KIND', 'error' => 'kind must be INVITE or REMINDER.'];
    }
    $cfg = whatsapp_config($env);
    if (!whatsapp_kind_ready($cfg, $kind)) {
        return ['ok' => false, 'status' => 'SKIPPED', 'reason' => 'DISABLED', 'error' => 'WhatsApp is not configured for ' . strtolower($kind) . ' messages.'];
    }

    $studentId = (string)($student['id'] ?? '');
    if ($studentId === '') {
        return ['ok' => false, 'status' => 'SKIPPED', 'reason' => 'NOT_FOUND', 'error' => 'Student not found.'];
    }
    if (!array_key_exists('mobile', $student)) {
        $state = whatsapp_schema_once($pdo);
        if (empty($state['studentsMobile'])) {
            return ['ok' => false, 'status' => 'SKIPPED', 'reason' => 'NO_MOBILE', 'error' => 'No mobile number on file.'];
        }
        $stmt = $pdo->prepare('SELECT id, full_name, mobile, company_id FROM students WHERE id = ? AND company_id = ? LIMIT 1');
        $stmt->execute([$studentId, $companyId]);
        $found = $stmt->fetch();
        $stmt->closeCursor();
        if (!$found) {
            return ['ok' => false, 'status' => 'SKIPPED', 'reason' => 'NOT_FOUND', 'error' => 'Student not found in this company.'];
        }
        $student = array_merge($found, $student, ['mobile' => $found['mobile']]);
    }
    $mobile = trim((string)($student['mobile'] ?? ''));
    if ($mobile === '') {
        return ['ok' => false, 'status' => 'SKIPPED', 'reason' => 'NO_MOBILE', 'error' => 'No mobile number on file.'];
    }

    $exam = whatsapp_complete_exam_row($pdo, $companyId, $examRow);
    if ($exam === null) {
        return ['ok' => false, 'status' => 'SKIPPED', 'reason' => 'NOT_FOUND', 'error' => 'Exam not found.'];
    }
    $studentCompany = (int)($student['company_id'] ?? $student['companyId'] ?? $companyId);
    if ($studentCompany <= 0) {
        $studentCompany = $companyId;
    }
    $name = trim((string)($student['full_name'] ?? $student['fullName'] ?? ''));
    $title = trim((string)($exam['title'] ?? ''));
    $link = whatsapp_exam_link($pdo, (string)$exam['id'], $studentId, $studentCompany);

    $params = $kind === 'INVITE'
        ? [
            $name !== '' ? $name : 'Candidate',
            $title,
            whatsapp_format_window($exam['start_time'], $exam['end_time'], $exam['timezone'] ?? null),
            whatsapp_format_duration((int)($exam['duration_minutes'] ?? 0)),
            $link,
        ]
        : [
            $name !== '' ? $name : 'Candidate',
            $title,
            whatsapp_format_instant($exam['end_time'], $exam['timezone'] ?? null),
            $link,
        ];

    return whatsapp_send_template($pdo, $env, $companyId, $kind, $mobile, $params, [
        'examId' => (string)$exam['id'],
        'studentId' => $studentId,
    ]);
}

/**
 * Convenience for server-side invitation paths (integrations.php, exam-request approval): send the
 * WhatsApp INVITE to one student by id. Returns SKIPPED straight away (no DB work) while WhatsApp
 * invitations aren't configured. Never throws.
 */
function whatsapp_send_invite_for_student(PDO $pdo, array $env, int $companyId, string $examId, string $studentId): array {
    try {
        if (!whatsapp_kind_ready(whatsapp_config($env), 'INVITE')) {
            return ['ok' => false, 'status' => 'SKIPPED', 'reason' => 'DISABLED'];
        }
        $state = whatsapp_schema_once($pdo);
        if (empty($state['studentsMobile'])) {
            return ['ok' => false, 'status' => 'SKIPPED', 'reason' => 'NO_MOBILE'];
        }
        $stmt = $pdo->prepare('SELECT id, full_name, mobile, company_id FROM students WHERE id = ? AND company_id = ? LIMIT 1');
        $stmt->execute([$studentId, $companyId]);
        $student = $stmt->fetch();
        $stmt->closeCursor();
        if (!$student) {
            return ['ok' => false, 'status' => 'SKIPPED', 'reason' => 'NOT_FOUND', 'error' => 'Student not found in this company.'];
        }
        return whatsapp_send_exam_notice($pdo, $env, $companyId, ['id' => $examId], $student, 'INVITE');
    } catch (Throwable $e) {
        error_log('[whatsapp] invite for student failed: ' . $e->getMessage());
        return ['ok' => false, 'status' => 'FAILED', 'error' => 'WhatsApp send failed.'];
    }
}

/**
 * Exam-request status update to the employee who sent the request (template REQUEST_UPDATE).
 * $statusMessage e.g. "received, pending approval", "approved — 25 candidates invited",
 * "rejected: <note>". SKIPPED (not logged) when there's no mobile or WhatsApp isn't ready.
 */
function whatsapp_notify_request_update(PDO $pdo, array $env, int $companyId, ?string $mobile, string $employeeName, int $requestId, string $examTitle, string $statusMessage): array {
    try {
        if (trim((string)$mobile) === '') {
            return ['ok' => false, 'status' => 'SKIPPED', 'reason' => 'NO_MOBILE', 'error' => 'No mobile number on file.'];
        }
        return whatsapp_send_template($pdo, $env, $companyId, 'REQUEST_UPDATE', (string)$mobile, [
            trim($employeeName) !== '' ? trim($employeeName) : 'there',
            '#' . $requestId,
            trim($examTitle) !== '' ? trim($examTitle) : '(untitled exam)',
            $statusMessage,
        ], ['requestId' => $requestId]);
    } catch (Throwable $e) {
        error_log('[whatsapp] request update failed: ' . $e->getMessage());
        return ['ok' => false, 'status' => 'FAILED', 'error' => 'WhatsApp send failed.'];
    }
}

/**
 * Same as whatsapp_notify_request_update(), looking the employee (name, mobile, company) up by
 * exam_requesters.id. The one-line hook for the exam-request code. Never throws.
 */
function whatsapp_notify_requester(PDO $pdo, array $env, int $requesterId, int $requestId, string $examTitle, string $statusMessage): array {
    try {
        if (!whatsapp_kind_ready(whatsapp_config($env), 'REQUEST_UPDATE')) {
            return ['ok' => false, 'status' => 'SKIPPED', 'reason' => 'DISABLED'];
        }
        $state = whatsapp_schema_once($pdo);
        if ($requesterId <= 0 || empty($state['requestersMobile'])) {
            return ['ok' => false, 'status' => 'SKIPPED', 'reason' => 'NO_MOBILE'];
        }
        $stmt = $pdo->prepare('SELECT name, mobile, company_id FROM exam_requesters WHERE id = ? LIMIT 1');
        $stmt->execute([$requesterId]);
        $row = $stmt->fetch();
        $stmt->closeCursor();
        if (!$row) {
            return ['ok' => false, 'status' => 'SKIPPED', 'reason' => 'NOT_FOUND'];
        }
        return whatsapp_notify_request_update($pdo, $env, (int)$row['company_id'], $row['mobile'] !== null ? (string)$row['mobile'] : null,
            (string)$row['name'], $requestId, $examTitle, $statusMessage);
    } catch (Throwable $e) {
        error_log('[whatsapp] requester update failed: ' . $e->getMessage());
        return ['ok' => false, 'status' => 'FAILED', 'error' => 'WhatsApp send failed.'];
    }
}

/** Public status for the admin UI — no secrets, only which pieces are configured. */
function whatsapp_public_status(array $cfg): array {
    $kinds = [];
    foreach (WHATSAPP_KINDS as $kind) {
        $kinds[$kind] = in_array($kind, $cfg['configuredKinds'], true);
    }
    return [
        'enabled' => (bool)$cfg['enabled'],
        'provider' => $cfg['provider'],
        'ready' => (bool)$cfg['ready'],
        'kinds' => $kinds,
        'issues' => array_values($cfg['issues']),
    ];
}

/** Validate a client-supplied list of student ids (strings, unique, non-empty). */
function whatsapp_student_ids($raw): array {
    if (!is_array($raw)) {
        return [];
    }
    $ids = [];
    foreach ($raw as $value) {
        if (!is_string($value) && !is_int($value)) {
            continue;
        }
        $id = trim((string)$value);
        if ($id !== '' && strlen($id) <= 64) {
            $ids[$id] = true;
        }
    }
    return array_keys($ids);
}

// ---------------------------------------------------------------------------------------------
// HTTP endpoint. Only runs when this file is the requested script — when require_once'd for the
// functions above (e.g. from integrations.php) nothing below executes.
// ---------------------------------------------------------------------------------------------
$whatsappIsIncluded = (basename($_SERVER['SCRIPT_FILENAME'] ?? '') !== 'whatsapp.php');
if ($whatsappIsIncluded) {
    return;
}

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';

if ($method === 'GET') {
    // Any staff role: the exam screens and Settings use this to decide what to show.
    require_staff();
    json_response(whatsapp_public_status(whatsapp_config($env)));
}

if ($method !== 'POST') {
    json_response(['error' => 'Method not allowed.'], 405);
}

$payload = json_input();
$actorRole = require_role(['ADMIN', 'SUPER_ADMIN'], $payload);
$companyId = require_company_id($payload);
$action = strtoupper(trim((string)($payload['action'] ?? '')));
$cfg = whatsapp_config($env);
$schema = whatsapp_schema_once($pdo);

if ($action === 'COVERAGE') {
    // Which of these students (in this company) have a mobile number — drives the
    // "N of M recipients have a mobile number" hint next to the WhatsApp checkbox.
    $ids = whatsapp_student_ids($payload['studentIds'] ?? null);
    if (count($ids) > 5000) {
        json_response(['error' => 'At most 5000 students per request.'], 400);
    }
    $withMobile = [];
    if (count($ids) > 0 && !empty($schema['studentsMobile'])) {
        foreach (array_chunk($ids, 1000) as $chunk) {
            $ph = implode(',', array_fill(0, count($chunk), '?'));
            $stmt = $pdo->prepare("SELECT id FROM students WHERE company_id = ? AND id IN ($ph) AND mobile IS NOT NULL AND mobile <> ''");
            $stmt->execute(array_merge([$companyId], $chunk));
            foreach ($stmt->fetchAll() as $row) {
                $withMobile[] = (string)$row['id'];
            }
            $stmt->closeCursor();
        }
    }
    json_response(['total' => count($ids), 'withMobile' => $withMobile]);
}

if ($action === 'SEND_EXAM_NOTICE') {
    $examId = trim((string)($payload['examId'] ?? ''));
    $kind = strtoupper(trim((string)($payload['kind'] ?? '')));
    $ids = whatsapp_student_ids($payload['studentIds'] ?? null);
    if ($examId === '' || !in_array($kind, WHATSAPP_EXAM_KINDS, true) || count($ids) === 0) {
        json_response(['error' => 'examId, studentIds and kind (INVITE or REMINDER) are required.'], 400);
    }
    if (count($ids) > WHATSAPP_MAX_STUDENTS) {
        json_response(['error' => 'At most ' . WHATSAPP_MAX_STUDENTS . ' students per request.'], 400);
    }

    $examStmt = $pdo->prepare('SELECT id, title, start_time, end_time, timezone, duration_minutes FROM exams WHERE id = ? AND company_id = ? LIMIT 1');
    $examStmt->execute([$examId, $companyId]);
    $exam = $examStmt->fetch();
    $examStmt->closeCursor();
    if (!$exam) {
        json_response(['error' => 'Exam not found.'], 404);
    }

    $students = [];
    $mobileExpr = !empty($schema['studentsMobile']) ? 'mobile' : 'NULL';
    foreach (array_chunk($ids, 1000) as $chunk) {
        $ph = implode(',', array_fill(0, count($chunk), '?'));
        $stmt = $pdo->prepare("SELECT id, full_name, {$mobileExpr} AS mobile, company_id FROM students WHERE company_id = ? AND id IN ($ph)");
        $stmt->execute(array_merge([$companyId], $chunk));
        foreach ($stmt->fetchAll() as $row) {
            $students[(string)$row['id']] = $row;
        }
        $stmt->closeCursor();
    }

    $result = ['sent' => 0, 'failed' => 0, 'skippedNoMobile' => 0, 'skippedDisabled' => 0, 'failures' => []];
    $ready = whatsapp_kind_ready($cfg, $kind);
    if ($ready) {
        ignore_user_abort(true);
        @set_time_limit(max(120, count($ids) * 2));
    }
    foreach ($ids as $sid) {
        $student = $students[$sid] ?? null;
        if ($student === null) {
            $result['failed']++;
            $result['failures'][] = ['studentId' => $sid, 'error' => 'Student not found in this company.'];
            continue;
        }
        if (trim((string)($student['mobile'] ?? '')) === '') {
            $result['skippedNoMobile']++;
            continue;
        }
        if (!$ready) {
            $result['skippedDisabled']++;
            continue;
        }
        $res = whatsapp_send_exam_notice($pdo, $env, $companyId, $exam, $student, $kind);
        if ($res['status'] === 'SENT') {
            $result['sent']++;
        } elseif ($res['status'] === 'FAILED') {
            $result['failed']++;
            $result['failures'][] = ['studentId' => $sid, 'error' => (string)($res['error'] ?? 'Send failed.')];
        } elseif (($res['reason'] ?? '') === 'NO_MOBILE') {
            $result['skippedNoMobile']++;
        } else {
            $result['skippedDisabled']++;
        }
    }

    if ($result['sent'] > 0 || $result['failed'] > 0) {
        audit_log($pdo, [
            'companyId' => $companyId,
            'actorRole' => $actorRole,
            'actorId' => get_actor_id($payload),
            'action' => 'WHATSAPP_EXAM_NOTICE',
            'targetType' => 'exam',
            'targetId' => $examId,
            'message' => "WhatsApp " . strtolower($kind) . " for \"{$exam['title']}\": {$result['sent']} sent, {$result['failed']} failed, {$result['skippedNoMobile']} without a mobile number",
            'metadata' => ['kind' => $kind, 'sent' => $result['sent'], 'failed' => $result['failed'], 'skippedNoMobile' => $result['skippedNoMobile']],
        ]);
    }
    if (count($result['failures']) > 200) {
        $result['failures'] = array_slice($result['failures'], 0, 200);
    }
    json_response($result);
}

if ($action === 'TEST') {
    $kind = strtoupper(trim((string)($payload['kind'] ?? '')));
    $rawMobile = trim((string)($payload['mobile'] ?? ''));
    if (!in_array($kind, WHATSAPP_KINDS, true)) {
        json_response(['error' => 'kind must be INVITE, REMINDER or REQUEST_UPDATE.'], 400);
    }
    $to = normalize_mobile($rawMobile, (string)$cfg['countryCode']);
    if ($to === null) {
        json_response(['error' => 'Enter a valid mobile number, e.g. 98765 43210 or +91 98765 43210.'], 400);
    }
    if (!whatsapp_kind_ready($cfg, $kind)) {
        json_response(['error' => $cfg['ready']
            ? 'No WhatsApp template is configured for this message kind.'
            : 'WhatsApp notifications are not configured yet.'], 409);
    }

    $origin = rtrim((string)pg_env('APP_ORIGIN', 'https://proctor.lsc-crm.in'), '/');
    $zone = new DateTimeZone('Asia/Kolkata');
    $start = (new DateTimeImmutable('tomorrow 10:00', $zone))->setTimezone(new DateTimeZone('UTC'));
    $end = $start->modify('+8 hours');
    $sampleTitle = 'Sample Exam (test message)';
    $params = [
        'INVITE' => ['Test Candidate', $sampleTitle, whatsapp_format_window($start->format('Y-m-d H:i:s'), $end->format('Y-m-d H:i:s'), 'Asia/Kolkata'), '30 minutes', $origin . '/'],
        'REMINDER' => ['Test Candidate', $sampleTitle, whatsapp_format_instant($end->format('Y-m-d H:i:s'), 'Asia/Kolkata'), $origin . '/'],
        'REQUEST_UPDATE' => ['Test Employee', '#0', $sampleTitle, 'test message from ProctorGuard Settings'],
    ][$kind];

    $res = whatsapp_send_template($pdo, $env, $companyId, $kind, $to, $params, ['test' => true]);
    audit_log($pdo, [
        'companyId' => $companyId,
        'actorRole' => $actorRole,
        'actorId' => get_actor_id($payload),
        'action' => 'WHATSAPP_TEST',
        'targetType' => 'whatsapp',
        'targetId' => $kind,
        'message' => 'WhatsApp test message (' . strtolower($kind) . ') to +' . substr($to, 0, -4) . '****: ' . $res['status'],
    ]);
    json_response([
        'ok' => (bool)$res['ok'],
        'status' => $res['status'],
        'error' => $res['error'] ?? null,
        'to' => '+' . $to,
    ]);
}

json_response(['error' => 'Unknown action.'], 400);
