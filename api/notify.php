<?php
declare(strict_types=1);

require __DIR__ . '/_bootstrap.php';

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

function build_mime_data(string $from, string $to, string $subject, string $htmlBody, string $plainBody): string {
    $from = sanitize_header_value($from);
    $to = sanitize_header_value($to);
    $encodedSubject = encode_subject($subject);
    $boundary = '=_lsc_' . bin2hex(random_bytes(12));
    $messageIdDomain = strpos($from, '@') !== false ? substr((string)strrchr($from, '@'), 1) : 'localhost';
    if ($messageIdDomain === '') {
        $messageIdDomain = 'localhost';
    }
    $messageId = sprintf('<%s@%s>', bin2hex(random_bytes(10)), preg_replace('/[^A-Za-z0-9.\-]/', '', $messageIdDomain));

    $plainBody = trim($plainBody) !== '' ? $plainBody : 'Please view this message in an HTML-compatible email client.';
    $headers = [
        "Date: " . gmdate('D, d M Y H:i:s O'),
        "Message-ID: {$messageId}",
        "From: {$from}",
        "To: {$to}",
        "Subject: {$encodedSubject}",
        'MIME-Version: 1.0',
        "Content-Type: multipart/alternative; boundary=\"{$boundary}\"",
    ];

    $parts = [];
    $parts[] = "--{$boundary}";
    $parts[] = 'Content-Type: text/plain; charset=UTF-8';
    $parts[] = 'Content-Transfer-Encoding: quoted-printable';
    $parts[] = '';
    $parts[] = quoted_printable_encode($plainBody);
    $parts[] = '';
    $parts[] = "--{$boundary}";
    $parts[] = 'Content-Type: text/html; charset=UTF-8';
    $parts[] = 'Content-Transfer-Encoding: quoted-printable';
    $parts[] = '';
    $parts[] = quoted_printable_encode($htmlBody);
    $parts[] = '';
    $parts[] = "--{$boundary}--";
    $parts[] = '';

    $data = implode("\r\n", $headers) . "\r\n\r\n" . implode("\r\n", $parts);
    return preg_replace("/\r\n\./", "\r\n..", $data) ?? $data;
}

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

        $to = trim((string)($message['to'] ?? ''));
        $subject = (string)($message['subject'] ?? '');
        $htmlBody = (string)($message['body'] ?? '');
        $plainBody = (string)($message['plain'] ?? strip_tags($htmlBody));
        $mimeData = build_mime_data($from, $to, $subject, $htmlBody, $plainBody);

        smtp_command($fp, "MAIL FROM:<{$from}>", [250], 'MAIL FROM');
        smtp_command($fp, "RCPT TO:<{$to}>", [250, 251], 'RCPT TO');
        smtp_command($fp, 'DATA', [354], 'DATA');

        $written = fwrite($fp, $mimeData . "\r\n.\r\n");
        if ($written === false) {
            throw new RuntimeException('Email body write failed.');
        }
        smtp_expect($fp, [250], 'Message body');
        smtp_command($fp, 'QUIT', [221], 'QUIT');
        fclose($fp);
        return ['ok' => true];
    } catch (Throwable $e) {
        fclose($fp);
        return ['ok' => false, 'error' => $e->getMessage()];
    }
}

$isIncluded = ( basename($_SERVER['SCRIPT_FILENAME'] ?? '') !== 'notify.php' );

if (!$isIncluded && $_SERVER['REQUEST_METHOD'] !== 'POST') {
    json_response(['error' => 'Method not allowed.'], 405);
}

if (!$isIncluded) {
    $payload = json_input();
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
    foreach ($messages as $msg) {
        $to = trim((string)($msg['to'] ?? ''));
        $subject = trim((string)($msg['subject'] ?? ''));
        $body = (string)($msg['body'] ?? '');
        $channel = strtoupper(trim((string)($msg['channel'] ?? 'EMAIL')));
        $templateId = isset($msg['templateId']) ? (int)$msg['templateId'] : null;

        if ($channel !== 'EMAIL' && $channel !== 'SMS') {
            $channel = 'EMAIL';
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
        $lowerBody = strtolower($body);
        if (strpos($lowerBody, '<html') === false && strpos($lowerBody, '<body') === false) {
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

        $result = smtp_send($host, $port, $user, $pass, $from, [
            'to' => $to,
            'subject' => $subject,
            'body' => $normalizedBody,
            'plain' => trim(preg_replace("/\r\n|\r|\n/", "\n", strip_tags($body)) ?? ''),
        ], $secureMode, $smtpTimeout, $allowSelfSigned);

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

    json_response(['sent' => $sent, 'failed' => $failed]);
}
