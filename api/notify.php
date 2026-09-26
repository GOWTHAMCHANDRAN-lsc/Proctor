<?php
declare(strict_types=1);

require_once __DIR__ . '/_bootstrap.php';

function smtp_read_response($fp): array {
    $lines = [];
    while (!feof($fp)) {
        $line = fgets($fp, 4096);
        if ($line === false) {
            break;
        }
        $lines[] = rtrim($line, "\r\n");
        if (strlen($line) < 4 || $line[3] === ' ') {
            break;
        }
    }

    $message = implode("\n", $lines);
    $code = isset($lines[0]) ? (int)substr($lines[0], 0, 3) : 0;
    return ['code' => $code, 'message' => $message, 'lines' => $lines];
}

function smtp_expect($fp, array $codes, string $context): array {
    $resp = smtp_read_response($fp);
    if (!in_array($resp['code'], $codes, true)) {
        $code = $resp['code'] > 0 ? (string)$resp['code'] : 'no-response';
        throw new RuntimeException("{$context} failed [{$code}]: {$resp['message']}");
    }
    return $resp;
}

function smtp_command($fp, string $command, array $codes, string $context): array {
    $written = fwrite($fp, $command . "\r\n");
    if ($written === false) {
        throw new RuntimeException("{$context} failed: socket write error.");
    }
    return smtp_expect($fp, $codes, $context);
}

function smtp_detect_auth_methods(array $ehloLines): array {
    foreach ($ehloLines as $line) {
        $clean = trim((string)$line);
        if (stripos($clean, '250-AUTH ') === 0 || stripos($clean, '250 AUTH ') === 0) {
            $methods = preg_split('/\s+/', preg_replace('/^250-?AUTH\s+/i', '', $clean) ?? '');
            $methods = array_filter(array_map('strtoupper', $methods ?: []), static function ($v) {
                return $v !== '';
            });
            return array_values(array_unique($methods));
        }
    }
    return [];
}

function smtp_supports_starttls(array $ehloLines): bool {
    foreach ($ehloLines as $line) {
        if (stripos((string)$line, '250-STARTTLS') === 0 || stripos((string)$line, '250 STARTTLS') === 0) {
            return true;
        }
    }
    return false;
}

function smtp_tls_method(): int {
    $methods = 0;
    if (defined('STREAM_CRYPTO_METHOD_TLSv1_3_CLIENT')) {
        $methods |= STREAM_CRYPTO_METHOD_TLSv1_3_CLIENT;
    }
    if (defined('STREAM_CRYPTO_METHOD_TLSv1_2_CLIENT')) {
        $methods |= STREAM_CRYPTO_METHOD_TLSv1_2_CLIENT;
    }
    if ($methods === 0 && defined('STREAM_CRYPTO_METHOD_TLS_CLIENT')) {
        $methods = STREAM_CRYPTO_METHOD_TLS_CLIENT;
    }
    return $methods;
}

function sanitize_header_value(string $value): string {
    return trim(str_replace(["\r", "\n"], '', $value));
}

function encode_subject(string $subject): string {
    $subject = sanitize_header_value($subject);
    if ($subject === '') {
        return '(no subject)';
    }
    if (preg_match('/[^\x20-\x7E]/', $subject) === 1 && function_exists('mb_encode_mimeheader')) {
        return mb_encode_mimeheader($subject, 'UTF-8', 'B', "\r\n");
    }
    return $subject;
}

// Produce a clean text/plain alternative from an HTML body. Critically, this DROPS the contents of
// <head>/<style>/<script> so raw CSS/JS never leaks into the plain part (which is what made older
// invitations look like a dump of code in text-only / preview mail clients).
function html_to_plain(string $html): string {
    $s = preg_replace('#<(head|style|script)\b[^>]*>.*?</\1>#is', '', $html) ?? $html;
    $s = preg_replace('#<br\s*/?>#i', "\n", $s) ?? $s;
    $s = preg_replace('#</(p|div|tr|h[1-6]|table|li|td)>#i', "\n", $s) ?? $s;
    $text = html_entity_decode(strip_tags($s), ENT_QUOTES | ENT_HTML5, 'UTF-8');
    $text = preg_replace("/[ \t]+/", ' ', $text) ?? $text;
    $lines = array_map('trim', preg_split("/\r\n|\r|\n/", $text) ?: []);
    $text = implode("\n", $lines);
    $text = preg_replace("/\n{3,}/", "\n\n", $text) ?? $text;
    return trim($text);
}

// Build a full RFC-compliant MIME message. With no attachments this is a multipart/alternative
// (plain + html); with attachments it becomes multipart/mixed wrapping that alternative plus each
// base64-encoded file. All line endings are CRLF and the body is SMTP dot-stuffed.
function build_mime_data(string $from, string $to, string $subject, string $htmlBody, string $plainBody, string $fromName = '', array $attachments = []): string {
    $from = sanitize_header_value($from);
    $to = sanitize_header_value($to);
    $encodedSubject = encode_subject($subject);

    // Extract bare email for Message-ID domain
    $bareFrom = $from;
    if (preg_match('/<([^>]+)>/', $from, $m)) {
        $bareFrom = $m[1];
    }
    $messageIdDomain = strpos($bareFrom, '@') !== false ? substr((string)strrchr($bareFrom, '@'), 1) : 'localhost';
    if ($messageIdDomain === '') {
        $messageIdDomain = 'localhost';
    }
    $messageId = sprintf('<%s@%s>', bin2hex(random_bytes(10)), preg_replace('/[^A-Za-z0-9.\-]/', '', $messageIdDomain));

    // Add display name to From header if not already present
    $fromHeader = $from;
    if ($fromName !== '' && strpos($from, '<') === false && filter_var($from, FILTER_VALIDATE_EMAIL) !== false) {
        $encodedName = mb_encode_mimeheader($fromName, 'UTF-8', 'B', "\r\n");
        $fromHeader = "{$encodedName} <{$from}>";
    }

    $plainBody = trim($plainBody) !== '' ? $plainBody : 'Please view this message in an HTML-compatible email client.';

    // The alternative (plain + html) block, with its own boundary.
    $altBoundary = '=_alt_' . bin2hex(random_bytes(12));
    $alt = [];
    $alt[] = "--{$altBoundary}";
    $alt[] = 'Content-Type: text/plain; charset=UTF-8';
    $alt[] = 'Content-Transfer-Encoding: quoted-printable';
    $alt[] = '';
    $alt[] = quoted_printable_encode($plainBody);
    $alt[] = '';
    $alt[] = "--{$altBoundary}";
    $alt[] = 'Content-Type: text/html; charset=UTF-8';
    $alt[] = 'Content-Transfer-Encoding: quoted-printable';
    $alt[] = '';
    $alt[] = quoted_printable_encode($htmlBody);
    $alt[] = '';
    $alt[] = "--{$altBoundary}--";

    $headers = [
        "Date: " . gmdate('D, d M Y H:i:s O'),
        "Message-ID: {$messageId}",
        "From: {$fromHeader}",
        "To: {$to}",
        "Subject: {$encodedSubject}",
        'MIME-Version: 1.0',
    ];

    $attachments = array_values(array_filter($attachments, static fn($a) => is_array($a) && (($a['data'] ?? '') !== '' || ($a['b64'] ?? '') !== '')));

    if (count($attachments) === 0) {
        $headers[] = "Content-Type: multipart/alternative; boundary=\"{$altBoundary}\"";
        $body = implode("\r\n", $alt);
    } else {
        $mixedBoundary = '=_mix_' . bin2hex(random_bytes(12));
        $headers[] = "Content-Type: multipart/mixed; boundary=\"{$mixedBoundary}\"";
        $parts = [];
        $parts[] = "--{$mixedBoundary}";
        $parts[] = "Content-Type: multipart/alternative; boundary=\"{$altBoundary}\"";
        $parts[] = '';
        $parts[] = implode("\r\n", $alt);
        foreach ($attachments as $att) {
            $fname = sanitize_header_value((string)($att['filename'] ?? 'attachment'));
            $fname = str_replace('"', '', $fname);
            $ctype = sanitize_header_value((string)($att['mimetype'] ?? 'application/octet-stream'));
            // Accept a pre-encoded base64 body so a batch can encode a shared attachment once
            // instead of re-encoding the same file for every recipient.
            $encoded = isset($att['b64']) && $att['b64'] !== ''
                ? (string)$att['b64']
                : rtrim(chunk_split(base64_encode((string)($att['data'] ?? '')), 76, "\r\n"), "\r\n");
            $parts[] = "--{$mixedBoundary}";
            $parts[] = "Content-Type: {$ctype}; name=\"{$fname}\"";
            $parts[] = 'Content-Transfer-Encoding: base64';
            $parts[] = "Content-Disposition: attachment; filename=\"{$fname}\"";
            $parts[] = '';
            $parts[] = $encoded;
        }
        $parts[] = "--{$mixedBoundary}--";
        $body = implode("\r\n", $parts);
    }

    $data = implode("\r\n", $headers) . "\r\n\r\n" . $body . "\r\n";
    return preg_replace("/\r\n\./", "\r\n..", $data) ?? $data;
}

// Open an authenticated SMTP session (connect + STARTTLS/SSL + AUTH) and return the live socket.
// Splitting this out from message delivery lets a batch reuse one connection for every recipient
// instead of paying a full TLS handshake + Gmail auth per email — which is what pushed large
// invitation batches past nginx's fastcgi_read_timeout and produced 504s.
function smtp_open(
    string $host,
    int $port,
    string $user,
    string $pass,
    string $secureMode = '',
    int $timeoutSeconds = 15,
    bool $allowSelfSigned = false
): array {
    $secure = strtolower(trim($secureMode));
    if (!in_array($secure, ['ssl', 'tls', 'none'], true)) {
        if ($port === 465) {
            $secure = 'ssl';
        } elseif ($port === 587) {
            $secure = 'tls';
        } else {
            $secure = 'none';
        }
    }

    $transport = $secure === 'ssl' ? 'ssl://' : 'tcp://';
    $context = stream_context_create([
        'ssl' => [
            'verify_peer' => !$allowSelfSigned,
            'verify_peer_name' => !$allowSelfSigned,
            'allow_self_signed' => $allowSelfSigned,
            'SNI_enabled' => true,
            'peer_name' => $host,
        ],
    ]);

    $errno = 0;
    $errstr = '';
    $fp = @stream_socket_client(
        "{$transport}{$host}:{$port}",
        $errno,
        $errstr,
        $timeoutSeconds,
        STREAM_CLIENT_CONNECT,
        $context
    );
    if (!$fp) {
        return ['ok' => false, 'error' => "SMTP connect failed: {$errstr} ({$errno})"];
    }

    stream_set_timeout($fp, $timeoutSeconds);
    $heloHost = parse_url('http://' . $host, PHP_URL_HOST) ?: 'localhost';

    try {
        smtp_expect($fp, [220], 'SMTP greeting');
        $ehlo = smtp_command($fp, "EHLO {$heloHost}", [250], 'EHLO');

        if ($secure === 'tls') {
            if (!smtp_supports_starttls($ehlo['lines'])) {
                throw new RuntimeException('Server does not advertise STARTTLS.');
            }
            smtp_command($fp, 'STARTTLS', [220], 'STARTTLS');
            $cryptoEnabled = @stream_socket_enable_crypto($fp, true, smtp_tls_method());
            if ($cryptoEnabled !== true) {
                throw new RuntimeException('Failed to enable TLS encryption.');
            }
            $ehlo = smtp_command($fp, "EHLO {$heloHost}", [250], 'EHLO after STARTTLS');
        }

        if ($user !== '') {
            $methods = smtp_detect_auth_methods($ehlo['lines']);
            $methodsUpper = array_map('strtoupper', $methods);

            if (in_array('PLAIN', $methodsUpper, true)) {
                $token = base64_encode("\0{$user}\0{$pass}");
                smtp_command($fp, "AUTH PLAIN {$token}", [235], 'AUTH PLAIN');
            } else {
                smtp_command($fp, 'AUTH LOGIN', [334], 'AUTH LOGIN');
                smtp_command($fp, base64_encode($user), [334], 'AUTH username');
                smtp_command($fp, base64_encode($pass), [235], 'AUTH password');
            }
        }

        return ['ok' => true, 'fp' => $fp];
    } catch (Throwable $e) {
        @fclose($fp);
        return ['ok' => false, 'error' => $e->getMessage()];
    }
}

// Deliver a single message over an already-open, authenticated SMTP socket. On success the caller
// should issue RSET before the next recipient; on failure the connection state is unknown, so the
// caller should drop it and reconnect. Never closes the socket itself.
function smtp_deliver($fp, string $from, array $message): array {
    try {
        $to = trim((string)($message['to'] ?? ''));
        $subject = (string)($message['subject'] ?? '');
        $htmlBody = (string)($message['body'] ?? '');
        $plainBody = (string)($message['plain'] ?? '');
        if (trim($plainBody) === '') {
            $plainBody = html_to_plain($htmlBody);
        }
        $fromName = (string)($message['fromName'] ?? 'ProctorGuard Notifications');
        $attachments = is_array($message['attachments'] ?? null) ? $message['attachments'] : [];
        $mimeData = build_mime_data($from, $to, $subject, $htmlBody, $plainBody, $fromName, $attachments);

        smtp_command($fp, "MAIL FROM:<{$from}>", [250], 'MAIL FROM');
        smtp_command($fp, "RCPT TO:<{$to}>", [250, 251], 'RCPT TO');
        smtp_command($fp, 'DATA', [354], 'DATA');

        $written = fwrite($fp, $mimeData . "\r\n.\r\n");
        if ($written === false) {
            throw new RuntimeException('Email body write failed.');
        }
        smtp_expect($fp, [250], 'Message body');
        return ['ok' => true];
    } catch (Throwable $e) {
        return ['ok' => false, 'error' => $e->getMessage()];
    }
}

// Politely end an SMTP session (best-effort QUIT) and close the socket.
function smtp_close($fp): void {
    if (!is_resource($fp)) {
        return;
    }
    @fwrite($fp, "QUIT\r\n");
    @fclose($fp);
}

// Single-message convenience wrapper: open a session, deliver one email, tear it down. Kept for
// callers that send exactly one message (e.g. users.php provisioning mail). Batch senders should
// use smtp_open + smtp_deliver directly to reuse the connection.
function smtp_send(
    string $host,
    int $port,
    string $user,
    string $pass,
    string $from,
    array $message,
    string $secureMode = '',
    int $timeoutSeconds = 15,
    bool $allowSelfSigned = false
): array {
    $conn = smtp_open($host, $port, $user, $pass, $secureMode, $timeoutSeconds, $allowSelfSigned);
    if (!$conn['ok']) {
        return ['ok' => false, 'error' => $conn['error']];
    }
    $fp = $conn['fp'];
    $result = smtp_deliver($fp, $from, $message);
    smtp_close($fp);
    return $result;
}

$isIncluded = ( basename($_SERVER['SCRIPT_FILENAME'] ?? '') !== 'notify.php' );

if (!$isIncluded && $_SERVER['REQUEST_METHOD'] !== 'POST') {
    json_response(['error' => 'Method not allowed.'], 405);
}

if (!$isIncluded) {
    $payload = json_input();
    require_staff($payload);
    $companyId = require_company_id($payload);
    $messages = $payload['messages'] ?? [];
    if (!is_array($messages) || count($messages) === 0) {
        json_response(['error' => 'No messages provided.'], 400);
    }

    $host = $env['SMTP_HOST'] ?? '';
    $port = (int)($env['SMTP_PORT'] ?? 0);
    $user = $env['SMTP_USER'] ?? '';
    $pass = $env['SMTP_PASS'] ?? '';
    $from = $env['SMTP_FROM'] ?? '';
    $secureMode = $env['SMTP_SECURE'] ?? '';
    $allowSelfSigned = (($env['SMTP_ALLOW_SELF_SIGNED'] ?? '0') === '1');
    $smtpTimeout = (int)($env['SMTP_TIMEOUT'] ?? 15);
    if ($smtpTimeout < 5) {
        $smtpTimeout = 5;
    }
    if ($smtpTimeout > 60) {
        $smtpTimeout = 60;
    }

    if ($host === '' || $port === 0 || $from === '') {
        json_response(['error' => 'SMTP is not configured in .env.'], 400);
    }

    $sent = 0;
    $failed = [];

    // One authenticated SMTP session is reused for the whole batch. It is opened lazily on the first
    // real EMAIL message, an RSET resets transaction state between recipients, and it is dropped +
    // reopened if a delivery fails (the connection may be unusable after an error). Reconnecting per
    // recipient was the cause of 504s on large invitation batches.
    // The exam-instructions PDF (~700 KB) is identical for every recipient, so read it from disk and
    // base64-encode it ONCE per batch instead of per message. On a 100-recipient invitation run this
    // removes 100 disk reads and 100 base64 encodes of the same file; the (unavoidable) per-recipient
    // SMTP transmission is all that remains. Loaded lazily so batches with no attachment pay nothing.
    $instructionsAttachment = false; // false = not yet attempted; null = tried and unavailable
    $loadInstructions = function () use (&$instructionsAttachment) {
        if ($instructionsAttachment !== false) {
            return $instructionsAttachment;
        }
        $instructionsAttachment = null;
        $pdfPath = __DIR__ . '/../public/ProctorGuard_Exam_Instructions_updated.pdf';
        if (is_readable($pdfPath)) {
            $pdfData = file_get_contents($pdfPath);
            if ($pdfData !== false) {
                $instructionsAttachment = [
                    'filename' => 'ProctorGuard_Exam_Instructions.pdf',
                    'mimetype' => 'application/pdf',
                    'b64'      => rtrim(chunk_split(base64_encode($pdfData), 76, "\r\n"), "\r\n"),
                ];
            }
        }
        return $instructionsAttachment;
    };

    $smtpFp = null;
    $smtpOpenError = null;
    $ensureSmtp = function () use (&$smtpFp, &$smtpOpenError, $host, $port, $user, $pass, $secureMode, $smtpTimeout, $allowSelfSigned) {
        if (is_resource($smtpFp)) {
            return $smtpFp;
        }
        $conn = smtp_open($host, $port, $user, $pass, $secureMode, $smtpTimeout, $allowSelfSigned);
        if (!$conn['ok']) {
            $smtpFp = null;
            $smtpOpenError = $conn['error'];
            return null;
        }
        $smtpFp = $conn['fp'];
        $smtpOpenError = null;
        return $smtpFp;
    };

    foreach ($messages as $msg) {
        $to = trim((string)($msg['to'] ?? ''));
        $subject = trim((string)($msg['subject'] ?? ''));
        $body = (string)($msg['body'] ?? '');
        $channel = strtoupper(trim((string)($msg['channel'] ?? 'EMAIL')));
        $templateId = isset($msg['templateId']) ? (int)$msg['templateId'] : null;

        if ($channel !== 'EMAIL' && $channel !== 'SMS') {
            $channel = 'EMAIL';
        }

        // Normalise email recipients to lowercase — addresses entered in ALL CAPS or
        // Mixed Case are delivered to the same mailbox, so store/send them consistently.
        if ($channel === 'EMAIL') {
            $to = strtolower($to);
        }

        if ($to === '' || ($channel === 'EMAIL' && $subject === '') || $body === '') {
            $failed[] = ['to' => $to, 'error' => 'Invalid message payload.'];
            $log = $pdo->prepare('CALL sp_add_delivery_log(?, ?, ?, ?, ?, ?, ?, ?, ?)');
            $log->execute([
                $companyId,
                $channel,
                $to,
                $subject,
                $body,
                'FAILED',
                'Invalid message payload.',
                $templateId,
                null
            ]);
            while ($log->nextRowset()) {}
            $log->closeCursor();
            continue;
        }

        if ($channel === 'EMAIL' && filter_var($to, FILTER_VALIDATE_EMAIL) === false) {
            $error = 'Invalid recipient email address.';
            $failed[] = ['to' => $to, 'error' => $error];
            $log = $pdo->prepare('CALL sp_add_delivery_log(?, ?, ?, ?, ?, ?, ?, ?, ?)');
            $log->execute([
                $companyId,
                $channel,
                $to,
                $subject,
                $body,
                'FAILED',
                $error,
                $templateId,
                null
            ]);
            while ($log->nextRowset()) {}
            $log->closeCursor();
            continue;
        }

        if ($channel === 'SMS') {
            $failed[] = ['to' => $to, 'error' => 'SMS provider not configured.'];
            $log = $pdo->prepare('CALL sp_add_delivery_log(?, ?, ?, ?, ?, ?, ?, ?, ?)');
            $log->execute([
                $companyId,
                $channel,
                $to,
                null,
                $body,
                'SKIPPED',
                'SMS provider not configured.',
                $templateId,
                null
            ]);
            while ($log->nextRowset()) {}
            $log->closeCursor();
            continue;
        }

        $normalizedBody = $body;
        $lowerBody = strtolower(substr($body, 0, 300)); // only inspect the opening bytes
        if (strpos($lowerBody, '<html') === false && strpos($lowerBody, '<body') === false && strpos($lowerBody, '<!doctype') === false) {
            $safe = nl2br(htmlspecialchars($body, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8'));
            $normalizedBody = '<!doctype html><html><head><meta charset="utf-8"><title>'
                . htmlspecialchars($subject, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8')
                . '</title></head><body style="margin:0;padding:24px;font-family:system-ui,-apple-system,BlinkMacSystemFont,\'Segoe UI\',sans-serif;font-size:14px;line-height:1.6;color:#0f172a;background-color:#f8fafc;">'
                . '<div style="max-width:640px;margin:0 auto;background:#ffffff;border-radius:12px;border:1px solid #e2e8f0;padding:24px;">'
                . $safe
                . '</div>'
                . '<div style="max-width:640px;margin:16px auto 0;text-align:center;font-size:11px;color:#94a3b8;">'
                . 'This is an automated exam notification from LSC Proctor.'
                . '</div>'
                . '</body></html>';
        }

        // Optionally attach the exam-instructions PDF. Read + encoded once per batch (see above).
        $attachments = [];
        if (!empty($msg['attachInstructions'])) {
            $instructions = $loadInstructions();
            if ($instructions !== null) {
                $attachments[] = $instructions;
            }
        }

        $fp = $ensureSmtp();
        if ($fp === null) {
            $result = ['ok' => false, 'error' => $smtpOpenError ?? 'SMTP connection failed.'];
        } else {
            $result = smtp_deliver($fp, $from, [
                'to' => $to,
                'subject' => $subject,
                'body' => $normalizedBody,
                'plain' => html_to_plain($normalizedBody),
                'attachments' => $attachments,
            ]);

            if ($result['ok']) {
                // Reset transaction state for the next recipient. If RSET doesn't come back clean,
                // treat the connection as suspect and reopen it on the next message.
                $rset = @fwrite($fp, "RSET\r\n");
                $rsetResp = $rset === false ? ['code' => 0] : smtp_read_response($fp);
                if ($rset === false || $rsetResp['code'] !== 250) {
                    smtp_close($fp);
                    $smtpFp = null;
                }
            } else {
                // Connection state is unknown after a delivery failure — drop it so the next
                // recipient gets a fresh, known-good session.
                smtp_close($fp);
                $smtpFp = null;
            }
        }

        if ($result['ok']) {
            $sent++;
            $status = 'SENT';
            $error = null;
        } else {
            $status = 'FAILED';
            $error = $result['error'] ?? 'Send failed.';
            $failed[] = ['to' => $to, 'error' => $error];
        }

        $log = $pdo->prepare('CALL sp_add_delivery_log(?, ?, ?, ?, ?, ?, ?, ?, ?)');
        $log->execute([
            $companyId,
            $channel,
            $to,
            $subject,
            $body,
            $status,
            $error,
            $templateId,
            null
        ]);
        while ($log->nextRowset()) {}
        $log->closeCursor();
    }

    // Cleanly close the shared SMTP session once the whole batch is done.
    if (is_resource($smtpFp)) {
        smtp_close($smtpFp);
        $smtpFp = null;
    }

    json_response(['sent' => $sent, 'failed' => $failed]);
}
