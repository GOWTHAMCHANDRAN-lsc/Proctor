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
// Message text managed from Settings (versions, placeholders, which template is in use).
require_once __DIR__ . '/whatsapp_templates.php';

const WHATSAPP_KINDS = ['INVITE', 'REMINDER', 'REQUEST_UPDATE'];
const WHATSAPP_EXAM_KINDS = ['INVITE', 'REMINDER'];
const WHATSAPP_MAX_STUDENTS = 2000;
const WHATSAPP_HTTP_TIMEOUT = 10;
const WHATSAPP_CONNECT_TIMEOUT = 5;
// After this many consecutive "provider unreachable" results (connection error, timeout, 5xx/429)
// in one PHP process, further sends in that process fail fast instead of each waiting out the
// timeout — so a provider outage can't stall a 2000-student batch (or an invitation run) for hours.
const WHATSAPP_BREAKER_LIMIT = 5;
// How long a template definition read from Meta is reused before it is read again (seconds).
const WHATSAPP_TEMPLATE_CACHE_TTL = 300;

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
        // Optional: the WhatsApp Business Account id. With it, every send follows the template as it
        // currently is in WhatsApp Manager (see whatsapp_meta_template()).
        $wabaId = $get('WHATSAPP_META_WABA_ID');
        if ($wabaId !== '' && !ctype_digit($wabaId)) {
            $issues[] = 'WHATSAPP_META_WABA_ID must be the numeric WhatsApp Business Account ID.';
            $wabaId = '';
        }
        $transport['meta'] = ['phoneNumberId' => $phoneNumberId, 'accessToken' => $accessToken, 'version' => $version, 'baseUrl' => $baseUrl, 'wabaId' => $wabaId];
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

    // Optional "Visit website" button carrying the candidate's exam link. A button whose URL is fixed
    // needs nothing here. A DYNAMIC one (URL ending in {{1}} in the Meta template) must be sent a
    // value, or Meta rejects every message — so its URL is copied here exactly as in the template,
    // e.g. WHATSAPP_TEMPLATE_INVITE_BUTTON_URL=https://proctor.lsc-crm.in?{{1}}, and each message
    // fills {{1}} with the candidate's short-link code (see whatsapp_button_value()).
    $buttons = [];
    foreach (WHATSAPP_EXAM_KINDS as $kind) {
        $url = $get('WHATSAPP_TEMPLATE_' . $kind . '_BUTTON_URL');
        if ($url === '') {
            continue;
        }
        if (preg_match('/^(https?:\/\/[^\s{}]+)\{\{\s*1\s*\}\}$/i', $url, $m) !== 1) {
            $issues[] = "WHATSAPP_TEMPLATE_{$kind}_BUTTON_URL must be the button URL exactly as in the Meta template, ending in {{1}} (e.g. https://proctor.lsc-crm.in?{{1}}).";
            continue;
        }
        $index = $get('WHATSAPP_TEMPLATE_' . $kind . '_BUTTON_INDEX');
        if ($index !== '' && !ctype_digit($index)) {
            $issues[] = "WHATSAPP_TEMPLATE_{$kind}_BUTTON_INDEX must be the button's position (0 = first button).";
            continue;
        }
        $buttons[$kind] = ['prefix' => $m[1], 'index' => $index === '' ? 0 : min(9, (int)$index)];
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
        'buttons' => $buttons,
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

/**
 * Meta WhatsApp Cloud API: send one approved template message. $button = ['index' => int, 'text' =>
 * the value for the dynamic URL button's {{1}}], or null when the template has no dynamic button.
 */
function whatsapp_send_meta(array $cfg, string $to, string $template, array $params, ?array $button = null, ?string $language = null): array {
    $t = $cfg['_transport']['meta'];
    $url = rtrim((string)$t['baseUrl'], '/') . '/' . rawurlencode((string)$t['version']) . '/' . rawurlencode((string)$t['phoneNumberId']) . '/messages';
    $components = [[
        'type' => 'body',
        'parameters' => array_map(static fn(string $p) => ['type' => 'text', 'text' => $p], $params),
    ]];
    if ($button !== null) {
        $components[] = [
            'type' => 'button',
            'sub_type' => 'url',
            'index' => (string)(int)$button['index'],
            'parameters' => [['type' => 'text', 'text' => (string)$button['text']]],
        ];
    }
    $body = [
        'messaging_product' => 'whatsapp',
        'to' => $to,
        'type' => 'template',
        'template' => [
            'name' => $template,
            'language' => ['code' => $language ?? $cfg['language']],
            'components' => $components,
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

/**
 * The value for a dynamic link button's {{1}}: what follows the template button's fixed URL part
 * ($prefix) in the candidate's link. A short link can be written as "<origin>?<code>",
 * "<origin>/?<code>", "<origin>/<code>" or "<origin>/x/<code>" (the student page opens all four), so
 * whichever of those the template uses, the button gets just the code. '' when the link can't fit.
 */
function whatsapp_button_value(string $prefix, string $link): string {
    $link = trim($link);
    $forms = [$link];
    if (preg_match('#^(https?://[^/?\#]+)(?:/x/|/?\?)([A-Za-z0-9]{6,16})$#i', $link, $m) === 1) {
        $forms = [$m[1] . '?' . $m[2], $m[1] . '/?' . $m[2], $m[1] . '/' . $m[2], $m[1] . '/x/' . $m[2], $link];
    }
    $fallback = '';
    foreach ($forms as $form) {
        if (strlen($form) > strlen($prefix) && strncasecmp($form, $prefix, strlen($prefix)) === 0) {
            $rest = substr($form, strlen($prefix));
            if (isset($m[2]) && $rest === $m[2]) {
                return $rest;
            }
            if ($fallback === '') {
                $fallback = $rest;
            }
        }
    }
    return $fallback;
}

/**
 * The template as it is in WhatsApp Manager right now: {name, status, category, language, bodyVars,
 * namedParams, headerParams, button: null | {index, prefix}, extraButtonParams}. Read from Meta
 * (needs WHATSAPP_META_WABA_ID) and cached for WHATSAPP_TEMPLATE_CACHE_TTL seconds, so an edit made in
 * WhatsApp Manager — new wording, a different button URL, button order, language — is picked up
 * within minutes with no change here. Null when it can't be read (no WABA id, Meta unreachable and
 * nothing cached, template not found): the caller then falls back to the .env settings.
 */
function whatsapp_meta_template(array $cfg, string $name, bool $fresh = false): ?array {
    static $memo = [];
    $t = $cfg['_transport']['meta'] ?? null;
    $wabaId = (string)($t['wabaId'] ?? '');
    if ($cfg['provider'] !== 'meta' || $wabaId === '' || $name === '') {
        return null;
    }
    if (!$fresh && array_key_exists($name, $memo)) {
        return $memo[$name];
    }
    $dir = __DIR__ . '/../storage/cache';
    $file = $dir . '/wa_template_' . $wabaId . '_' . preg_replace('/[^A-Za-z0-9_.\-]/', '_', $name) . '.json';
    $cached = null;
    if (is_readable($file)) {
        $decoded = json_decode((string)@file_get_contents($file), true);
        // v2 = entries that carry the body text and button label (older cache files are ignored).
        if (is_array($decoded) && isset($decoded['fetchedAt'], $decoded['info']) && ($decoded['v'] ?? 1) === 2) {
            $cached = $decoded;
        }
    }
    if (!$fresh && $cached !== null && (time() - (int)$cached['fetchedAt']) < WHATSAPP_TEMPLATE_CACHE_TTL) {
        return $memo[$name] = $cached['info'];
    }

    $url = rtrim((string)$t['baseUrl'], '/') . '/' . rawurlencode((string)$t['version']) . '/' . rawurlencode($wabaId)
        . '/message_templates?fields=name,status,category,language,parameter_format,rejected_reason,components&limit=50&name=' . rawurlencode($name);
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT => 6,
        CURLOPT_CONNECTTIMEOUT => 4,
        CURLOPT_FOLLOWLOCATION => false,
        CURLOPT_PROTOCOLS => CURLPROTO_HTTP | CURLPROTO_HTTPS,
        CURLOPT_HTTPHEADER => ['Authorization: Bearer ' . $t['accessToken']],
    ]);
    $raw = curl_exec($ch);
    $status = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
    $body = is_string($raw) ? json_decode($raw, true) : null;
    if ($status < 200 || $status >= 300 || !is_array($body) || !is_array($body['data'] ?? null)) {
        // Meta unreachable: keep using what we last saw rather than guessing.
        return $memo[$name] = ($cached['info'] ?? null);
    }
    $info = null;
    foreach ($body['data'] as $row) {
        // `name=` is a substring filter; take the exact name in the configured language when there is one.
        if (!is_array($row) || (string)($row['name'] ?? '') !== $name) {
            continue;
        }
        $parsed = whatsapp_parse_meta_template($row);
        if ($info === null || strcasecmp($parsed['language'], (string)$cfg['language']) === 0) {
            $info = $parsed;
        }
    }
    if ($info === null) {
        $info = ['name' => $name, 'status' => 'NOT_FOUND', 'category' => null, 'language' => (string)$cfg['language'],
                 'bodyVars' => 0, 'namedParams' => false, 'headerParams' => false, 'button' => null, 'extraButtonParams' => false,
                 'bodyText' => '', 'buttonText' => null, 'rejectedReason' => null];
    }
    if (!is_dir($dir)) {
        @mkdir($dir, 02775, true);
    }
    $tmp = $file . '.' . getmypid() . '.tmp';
    if (@file_put_contents($tmp, json_encode(['v' => 2, 'fetchedAt' => time(), 'info' => $info])) !== false) {
        @chmod($tmp, 0664);
        @rename($tmp, $file);
    }
    return $memo[$name] = $info;
}

/** Reduce one Graph API message_templates row to what a send needs. */
function whatsapp_parse_meta_template(array $row): array {
    $info = [
        'name' => (string)($row['name'] ?? ''),
        'status' => strtoupper((string)($row['status'] ?? '')),
        'category' => isset($row['category']) ? strtoupper((string)$row['category']) : null,
        'language' => (string)($row['language'] ?? 'en'),
        'bodyVars' => 0,
        'namedParams' => strtoupper((string)($row['parameter_format'] ?? 'POSITIONAL')) === 'NAMED',
        'headerParams' => false,
        'button' => null,
        'extraButtonParams' => false,
        'bodyText' => '',
        'buttonText' => null,
        'rejectedReason' => isset($row['rejected_reason']) && strtoupper((string)$row['rejected_reason']) !== 'NONE' ? (string)$row['rejected_reason'] : null,
    ];
    foreach ((array)($row['components'] ?? []) as $component) {
        $type = strtoupper((string)($component['type'] ?? ''));
        if ($type === 'BODY') {
            $info['bodyText'] = (string)($component['text'] ?? '');
            preg_match_all('/\{\{\s*(\d+)\s*\}\}/', (string)($component['text'] ?? ''), $m);
            $info['bodyVars'] = count(array_unique($m[1]));
            if (preg_match('/\{\{\s*[A-Za-z_]\w*\s*\}\}/', (string)($component['text'] ?? '')) === 1) {
                $info['namedParams'] = true;
            }
        } elseif ($type === 'HEADER') {
            $format = strtoupper((string)($component['format'] ?? 'TEXT'));
            if ($format !== 'TEXT' || strpos((string)($component['text'] ?? ''), '{{') !== false) {
                $info['headerParams'] = true; // media or variable header: needs a parameter we don't send
            }
        } elseif ($type === 'BUTTONS') {
            foreach (array_values((array)($component['buttons'] ?? [])) as $index => $button) {
                $buttonType = strtoupper((string)($button['type'] ?? ''));
                $buttonUrl = (string)($button['url'] ?? '');
                if ($buttonType === 'URL' && preg_match('/^(.*)\{\{\s*1\s*\}\}$/', $buttonUrl, $bm) === 1) {
                    if ($info['button'] === null) {
                        $info['button'] = ['index' => $index, 'prefix' => $bm[1]];
                        $info['buttonText'] = (string)($button['text'] ?? '');
                    } else {
                        $info['extraButtonParams'] = true;
                    }
                } elseif (in_array($buttonType, ['COPY_CODE', 'OTP', 'FLOW', 'CATALOG', 'MPM'], true)) {
                    $info['extraButtonParams'] = true;
                }
            }
        }
    }
    return $info;
}

/**
 * Why this template can't be sent as it stands (empty = fine). These are the edits made in WhatsApp
 * Manager that ProctorGuard cannot follow automatically; wording, formatting, the link button's
 * address / position and the language all are followed.
 */
function whatsapp_template_problems(array $info, string $kind, ?int $expected = null): array {
    $name = (string)$info['name'];
    $problems = [];
    if ($info['status'] === 'NOT_FOUND') {
        return ["Template \"{$name}\" was not found in WhatsApp Manager."];
    }
    if ($info['status'] !== 'APPROVED') {
        $problems[] = "Template \"{$name}\" is {$info['status']} in WhatsApp Manager (only APPROVED templates can be sent).";
    }
    $expected = $expected ?? count(WHATSAPP_LEGACY_FIELDS[$kind] ?? []);
    if ($info['namedParams']) {
        $problems[] = "Template \"{$name}\" uses named variables; ProctorGuard fills numbered ones ({{1}}, {{2}}, …).";
    } elseif ($expected !== null && $info['bodyVars'] !== $expected) {
        $problems[] = "Template \"{$name}\" has {$info['bodyVars']} variable(s) in its text but ProctorGuard fills {$expected} for this message. It was changed in WhatsApp Manager — edit the message from Settings → WhatsApp instead, or restore its {$expected} variable(s).";
    }
    if ($info['headerParams']) {
        $problems[] = "Template \"{$name}\" has a header that needs a value (image, document or variable), which ProctorGuard does not send.";
    }
    if ($info['extraButtonParams']) {
        $problems[] = "Template \"{$name}\" has more than one button that needs a value; only one link button is supported.";
    }
    if ($info['button'] !== null && !in_array($kind, WHATSAPP_EXAM_KINDS, true)) {
        $problems[] = "Template \"{$name}\" has a link button, but this message has no exam link to put on it.";
    }
    return $problems;
}

/** A short human-readable rendering of the message for the delivery log. */
function whatsapp_preview(string $kind, array $params, array $fields = []): string {
    $parts = [];
    foreach (array_values($params) as $i => $value) {
        $label = $fields[$i] ?? ('{{' . ($i + 1) . '}}');
        $parts[] = "{$label}: {$value}";
    }
    return '[' . $kind . '] ' . implode(' | ', $parts);
}

/**
 * Send one approved template message. Returns {ok, status: SENT|FAILED|SKIPPED, error?, messageId?}.
 * SENT and FAILED write a delivery_logs row; SKIPPED (WhatsApp off / not ready / no template for this
 * kind) returns immediately WITHOUT logging, so the log doesn't fill up while the feature is disabled.
 * $values are named (WHATSAPP_TEMPLATE_FIELDS keys, e.g. StudentName, ExamWindow, Link): the template
 * in use decides which of them it shows and in what order (whatsapp_active_template()).
 * $buttonLink is the full URL the template's link button should open, when it has one.
 */
function whatsapp_send_template(PDO $pdo, array $env, int $companyId, string $kind, string $mobile, array $values, array $meta = [], ?string $buttonLink = null): array {
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

    $active = whatsapp_active_template($pdo, $cfg, $kind);
    $template = (string)$active['name'];
    $fields = $active['fields'];
    $clean = array_map(static fn(string $field) => whatsapp_clean_param((string)($values[$field] ?? '')), $fields);
    $preview = whatsapp_preview($kind, $clean, $fields);
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

    // Follow the template as it is in WhatsApp Manager right now (when it can be read); otherwise the
    // .env settings. Dynamic link button: {{1}} = whatever follows the template's fixed URL part.
    $button = null;
    $language = null;
    $live = $cfg['provider'] === 'meta' ? whatsapp_meta_template($cfg, $template) : null;
    if ($live !== null) {
        $problems = whatsapp_template_problems($live, $kind, count($fields));
        if ($problems) {
            $error = implode(' ', $problems);
            whatsapp_log_delivery($pdo, $companyId, '+' . $to, $template, $preview, 'FAILED', $error, $logMeta);
            return ['ok' => false, 'status' => 'FAILED', 'error' => $error];
        }
        $language = (string)$live['language'];
        $logMeta['language'] = $language;
        $buttonCfg = $live['button'];
    } else {
        $buttonCfg = $cfg['provider'] === 'meta' ? ($cfg['buttons'][$kind] ?? null) : null;
    }
    if ($buttonCfg !== null) {
        $prefix = (string)$buttonCfg['prefix'];
        $link = trim((string)$buttonLink);
        $suffix = $link !== '' ? whatsapp_button_value($prefix, $link) : '';
        if ($suffix === '') {
            $error = $link === ''
                ? 'This message has no link for the template\'s link button.'
                : "The exam link doesn't fit the template's link button ({$prefix}{{1}}).";
            whatsapp_log_delivery($pdo, $companyId, '+' . $to, $template, $preview, 'FAILED', $error, $logMeta);
            return ['ok' => false, 'status' => 'FAILED', 'error' => $error];
        }
        $button = ['index' => (int)$buttonCfg['index'], 'text' => $suffix];
        $logMeta['button'] = $suffix;
    }

    if ($consecutiveTransportFailures >= WHATSAPP_BREAKER_LIMIT) {
        $error = 'Not sent: the WhatsApp provider failed to respond ' . WHATSAPP_BREAKER_LIMIT . ' times in a row during this run. Try again later.';
        whatsapp_log_delivery($pdo, $companyId, '+' . $to, $template, $preview, 'FAILED', $error, $logMeta);
        return ['ok' => false, 'status' => 'FAILED', 'error' => $error];
    }

    try {
        $res = $cfg['provider'] === 'meta'
            ? whatsapp_send_meta($cfg, $to, $template, $clean, $button, $language)
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
 * "<origin>?<code>" link for (exam, student, student's company) from exam_access_link() (get-or-
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

    // Everything a template may show; the one in use picks what it needs.
    $values = [
        'StudentName' => $name !== '' ? $name : 'Candidate',
        'ExamTitle' => $title,
        'ExamWindow' => whatsapp_format_window($exam['start_time'], $exam['end_time'], $exam['timezone'] ?? null),
        'StartTime' => whatsapp_format_instant($exam['start_time'], $exam['timezone'] ?? null),
        'EndTime' => whatsapp_format_instant($exam['end_time'], $exam['timezone'] ?? null),
        'Duration' => whatsapp_format_duration((int)($exam['duration_minutes'] ?? 0)),
        'QuestionCount' => (string)exam_candidate_question_count($pdo, (string)$exam['id']),
        'Link' => $link,
    ];

    return whatsapp_send_template($pdo, $env, $companyId, $kind, $mobile, $values, [
        'examId' => (string)$exam['id'],
        'studentId' => $studentId,
    ], $link);
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
            'EmployeeName' => trim($employeeName) !== '' ? trim($employeeName) : 'there',
            'RequestRef' => '#' . $requestId,
            'ExamTitle' => trim($examTitle) !== '' ? trim($examTitle) : '(untitled exam)',
            'Status' => $statusMessage,
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
function whatsapp_public_status(array $cfg, ?PDO $pdo = null): array {
    $kinds = [];
    foreach (WHATSAPP_KINDS as $kind) {
        $kinds[$kind] = in_array($kind, $cfg['configuredKinds'], true);
    }
    // What each configured template looks like in WhatsApp Manager right now, and anything about it
    // that would stop a send (shown in Settings → WhatsApp).
    $templates = [];
    $issues = array_values($cfg['issues']);
    if (!empty($cfg['ready']) && $cfg['provider'] === 'meta') {
        foreach ($cfg['configuredKinds'] as $kind) {
            $active = $pdo !== null ? whatsapp_active_template($pdo, $cfg, $kind)
                : ['name' => (string)$cfg['templates'][$kind], 'fields' => WHATSAPP_LEGACY_FIELDS[$kind] ?? []];
            $live = whatsapp_meta_template($cfg, (string)$active['name']);
            if ($live === null) {
                continue;
            }
            $problems = whatsapp_template_problems($live, $kind, count($active['fields']));
            $templates[] = [
                'kind' => $kind,
                'name' => $live['name'],
                'status' => $live['status'],
                'category' => $live['category'],
                'language' => $live['language'],
                'variables' => $live['bodyVars'],
                'linkButton' => $live['button'] !== null ? $live['button']['prefix'] . '{{1}}' : null,
                'problems' => $problems,
            ];
            foreach ($problems as $problem) {
                $issues[] = $problem;
            }
            if ($live['category'] === 'MARKETING') {
                $issues[] = "Template \"{$live['name']}\" is in the Marketing category: WhatsApp limits marketing messages per person, so some may not be delivered. Utility templates are not limited.";
            }
        }
    }
    return [
        'enabled' => (bool)$cfg['enabled'],
        'provider' => $cfg['provider'],
        'ready' => (bool)$cfg['ready'],
        'kinds' => $kinds,
        'issues' => $issues,
        'templates' => $templates,
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
    $staffRole = require_staff();
    $getCfg = whatsapp_config($env);
    if (isset($_GET['templates'])) {
        // Settings → WhatsApp → Message text. Templates belong to the whole WhatsApp account (every
        // company's messages use them), so only a super admin can change them.
        if (!empty($getCfg['ready']) && $getCfg['provider'] === 'meta') {
            whatsapp_templates_refresh($pdo, $getCfg, null, isset($_GET['refresh']));
        }
        $kinds = [];
        foreach (WHATSAPP_KINDS as $kind) {
            $kinds[] = whatsapp_template_editor_state($pdo, $getCfg, $kind);
        }
        json_response([
            'editable' => $staffRole === 'SUPER_ADMIN' && !empty($getCfg['ready']) && $getCfg['provider'] === 'meta'
                && (string)($getCfg['_transport']['meta']['wabaId'] ?? '') !== '',
            'limits' => ['body' => WHATSAPP_TEMPLATE_BODY_MAX, 'button' => WHATSAPP_TEMPLATE_BUTTON_MAX],
            'kinds' => $kinds,
        ]);
    }
    json_response(whatsapp_public_status($getCfg, $pdo));
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

    // sentIds: who actually got the message, so a WhatsApp-only invitation can be recorded as sent.
    $result = ['sent' => 0, 'failed' => 0, 'skippedNoMobile' => 0, 'skippedDisabled' => 0, 'failures' => [], 'sentIds' => []];
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
            $result['sentIds'][] = $sid;
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
    $sampleStart = $start->format('Y-m-d H:i:s');
    $sampleEnd = $end->format('Y-m-d H:i:s');
    $values = $kind === 'REQUEST_UPDATE'
        ? ['EmployeeName' => 'Test Employee', 'RequestRef' => '#0', 'ExamTitle' => $sampleTitle, 'Status' => 'test message from ProctorGuard Settings']
        : [
            'StudentName' => 'Test Candidate',
            'ExamTitle' => $sampleTitle,
            'ExamWindow' => whatsapp_format_window($sampleStart, $sampleEnd, 'Asia/Kolkata'),
            'StartTime' => whatsapp_format_instant($sampleStart, 'Asia/Kolkata'),
            'EndTime' => whatsapp_format_instant($sampleEnd, 'Asia/Kolkata'),
            'Duration' => '30 minutes',
            'QuestionCount' => '25',
            'Link' => $origin . '?TESTLINK00',
        ];

    // The test has no real exam: its link (text and button) carries a placeholder code, so it opens
    // the "invalid link" notice.
    $testButtonLink = in_array($kind, WHATSAPP_EXAM_KINDS, true) ? $origin . '?TESTLINK00' : null;
    $res = whatsapp_send_template($pdo, $env, $companyId, $kind, $to, $values, ['test' => true], $testButtonLink);
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

// ---- Message text (Settings → WhatsApp): super admin only, account-wide ----------------------
if (in_array($action, ['TEMPLATE_SAVE', 'TEMPLATE_ACTIVATE', 'TEMPLATE_DELETE'], true)) {
    $superRole = require_role(['SUPER_ADMIN'], $payload);
    $actorId = (string)(get_actor_id($payload) ?? 'super-admin');
    ensure_whatsapp_template_schema($pdo);

    if ($action === 'TEMPLATE_SAVE') {
        $kind = strtoupper(trim((string)($payload['kind'] ?? '')));
        if (!in_array($kind, WHATSAPP_KINDS, true)) {
            json_response(['error' => 'kind must be INVITE, REMINDER or REQUEST_UPDATE.'], 400);
        }
        $buttonText = array_key_exists('buttonText', $payload) && is_string($payload['buttonText']) ? $payload['buttonText'] : null;
        $result = whatsapp_template_create($pdo, $cfg, $kind, (string)($payload['body'] ?? ''), $buttonText, $actorId);
        if (!$result['ok']) {
            json_response(['error' => implode(' ', $result['errors']), 'errors' => $result['errors']], 400);
        }
        audit_log($pdo, [
            'companyId' => $companyId, 'actorRole' => $superRole, 'actorId' => $actorId,
            'action' => 'WHATSAPP_TEMPLATE_SUBMIT', 'targetType' => 'whatsapp', 'targetId' => $kind,
            'message' => 'WhatsApp ' . strtolower($kind) . ' text submitted for review as ' . $result['row']['name'],
        ]);
        json_response(['ok' => true, 'version' => $result['row'], 'state' => whatsapp_template_editor_state($pdo, $cfg, $kind)]);
    }

    $id = (int)($payload['id'] ?? 0);
    $stmt = $pdo->prepare('SELECT * FROM whatsapp_templates WHERE id = ? LIMIT 1');
    $stmt->execute([$id]);
    $row = $stmt->fetch();
    $stmt->closeCursor();
    if (!$row) {
        json_response(['error' => 'Version not found.'], 404);
    }
    $kind = (string)$row['kind'];

    if ($action === 'TEMPLATE_ACTIVATE') {
        // Use a version that is approved but not in use: one held because WhatsApp put it in
        // Marketing, or an earlier version being restored.
        if (!in_array((string)$row['status'], ['HELD', 'RETIRED'], true)) {
            json_response(['error' => 'Only an approved version that is not in use can be switched to.'], 409);
        }
        $live = whatsapp_meta_template($cfg, (string)$row['name'], true);
        if ($live === null || $live['status'] !== 'APPROVED') {
            json_response(['error' => 'WhatsApp no longer lists this version as approved, so it cannot be used.'], 409);
        }
        whatsapp_template_activate($pdo, $id);
        audit_log($pdo, [
            'companyId' => $companyId, 'actorRole' => $superRole, 'actorId' => $actorId,
            'action' => 'WHATSAPP_TEMPLATE_ACTIVATE', 'targetType' => 'whatsapp', 'targetId' => $kind,
            'message' => 'WhatsApp ' . strtolower($kind) . ' messages now use ' . $row['name'],
        ]);
        json_response(['ok' => true, 'state' => whatsapp_template_editor_state($pdo, $cfg, $kind)]);
    }

    // TEMPLATE_DELETE: remove a version that is not in use — from WhatsApp Manager too, so the
    // account doesn't fill up with superseded versions.
    if ((string)$row['status'] === 'ACTIVE') {
        json_response(['error' => 'This version is in use. Switch to another version first.'], 409);
    }
    $t = $cfg['_transport']['meta'] ?? null;
    if ($cfg['provider'] === 'meta' && $t !== null && (string)($t['wabaId'] ?? '') !== '') {
        $url = rtrim((string)$t['baseUrl'], '/') . '/' . rawurlencode((string)$t['version']) . '/' . rawurlencode((string)$t['wabaId'])
            . '/message_templates?name=' . rawurlencode((string)$row['name']);
        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 10, CURLOPT_CONNECTTIMEOUT => 5, CURLOPT_CUSTOMREQUEST => 'DELETE',
            CURLOPT_PROTOCOLS => CURLPROTO_HTTP | CURLPROTO_HTTPS, CURLOPT_HTTPHEADER => ['Authorization: Bearer ' . $t['accessToken']],
        ]);
        curl_exec($ch);
        curl_close($ch);
    }
    $del = $pdo->prepare('DELETE FROM whatsapp_templates WHERE id = ?');
    $del->execute([$id]);
    $del->closeCursor();
    audit_log($pdo, [
        'companyId' => $companyId, 'actorRole' => $superRole, 'actorId' => $actorId,
        'action' => 'WHATSAPP_TEMPLATE_DELETE', 'targetType' => 'whatsapp', 'targetId' => $kind,
        'message' => 'WhatsApp template version removed: ' . $row['name'],
    ]);
    json_response(['ok' => true, 'state' => whatsapp_template_editor_state($pdo, $cfg, $kind)]);
}

json_response(['error' => 'Unknown action.'], 400);
