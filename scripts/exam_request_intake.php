<?php
declare(strict_types=1);

/**
 * Exam-request intake (CLI only). Reads ONE email as JSON on stdin —
 *   {messageId, from, fromName, subject, date, textBody, htmlBody, attachments: [{filename, contentType, base64}]}
 * — authenticates it (registered ACTIVE sender + that employee's own security code), parses the
 * template and records it in exam_requests. Prints {ok, requestId, status} (or {ok, duplicate}) as
 * one JSON line on stdout; exit code 0 on success.
 *
 * Normally fed by scripts/mail_intake.py (IMAP worker). Can be run by hand for testing:
 *   php scripts/exam_request_intake.php < message.json
 *
 * Rules:
 *  - Unknown/disabled sender → INVALID, and NO reply (avoids backscatter to forged addresses).
 *  - Known sender, wrong/missing code → INVALID + reply (the code is never echoed).
 *  - More than 10 requests from one employee in an hour → INVALID "rate limited" (one reply per hour).
 *  - Authenticated → ALWAYS stored PENDING, even with field errors (errors[] = "needs attention").
 *  - The security code is never stored: body_redacted drops its line and masks any other copy.
 */

if (PHP_SAPI !== 'cli') {
    http_response_code(403);
    echo "CLI only.\n";
    exit(1);
}

$_SERVER['REQUEST_METHOD'] = 'CLI';
require_once __DIR__ . '/../api/_bootstrap.php';
require_once __DIR__ . '/../api/exam_requests.php';

function intake_out(array $result): void {
    fwrite(STDOUT, json_encode($result, JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE) . "\n");
    exit(!empty($result['ok']) ? 0 : 1);
}

function intake_str(array $msg, string $key, int $max): string {
    $value = $msg[$key] ?? '';
    return is_scalar($value) ? mb_substr(trim((string)$value), 0, $max, 'UTF-8') : '';
}

/** Insert the exam_requests row; null when a row with the same message hash already exists. */
function intake_store(PDO $pdo, array $row): ?int {
    try {
        $stmt = $pdo->prepare('INSERT INTO exam_requests
            (company_id, requester_id, sender_email, sender_name, subject, message_hash, status, details_json, students_json, errors_json, body_redacted)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
        $stmt->execute([
            $row['company_id'], $row['requester_id'], $row['sender_email'], $row['sender_name'], $row['subject'],
            $row['message_hash'], $row['status'], $row['details_json'], $row['students_json'], er_json($row['errors']), $row['body_redacted'],
        ]);
        $stmt->closeCursor();
        return (int)$pdo->lastInsertId();
    } catch (PDOException $e) {
        if ((int)($e->errorInfo[1] ?? 0) === 1062) {
            return null;
        }
        throw $e;
    }
}

function intake_duplicate(PDO $pdo, string $hash): array {
    $stmt = $pdo->prepare('SELECT id, status FROM exam_requests WHERE message_hash = ? LIMIT 1');
    $stmt->execute([$hash]);
    $row = $stmt->fetch();
    $stmt->closeCursor();
    return ['ok' => true, 'duplicate' => true, 'requestId' => $row ? (int)$row['id'] : null, 'status' => $row ? (string)$row['status'] : null];
}

function intake_reply_rejected(PDO $pdo, array $env, array $requester, string $subject, string $reason, string $advice): void {
    $inner = '<p style="margin:0 0 12px;">Hello ' . er_h((string)$requester['name']) . ',</p>'
        . '<p style="margin:0 0 12px;">Your request <strong>' . er_h($subject !== '' ? $subject : '(no subject)') . '</strong> could not be accepted: '
        . er_h($reason) . '.</p>'
        . '<p style="margin:0;color:#475569;">' . er_h($advice) . '</p>';
    er_send_mail($pdo, $env, (int)$requester['company_id'], (string)$requester['email'],
        '[ProctorGuard] Your exam request could not be accepted', er_email_html('Exam request not accepted', $inner));
}

// ---------------------------------------------------------------------------------------------

try {
    $raw = stream_get_contents(STDIN, 48 * 1024 * 1024 + 1);
    if ($raw === false || trim($raw) === '') {
        intake_out(['ok' => false, 'error' => 'No message on stdin.']);
    }
    if (strlen($raw) > 48 * 1024 * 1024) {
        intake_out(['ok' => false, 'error' => 'Message too large.']);
    }
    $msg = json_decode($raw, true);
    if (!is_array($msg)) {
        intake_out(['ok' => false, 'error' => 'stdin is not a JSON object.']);
    }

    er_ensure_schema($pdo);

    $messageId = intake_str($msg, 'messageId', 998);
    $from = er_extract_address(intake_str($msg, 'from', 320));
    $fromName = intake_str($msg, 'fromName', 255);
    $subject = intake_str($msg, 'subject', 512);
    $date = intake_str($msg, 'date', 200);
    $textBody = is_string($msg['textBody'] ?? null) ? (string)$msg['textBody'] : '';
    $htmlBody = is_string($msg['htmlBody'] ?? null) ? (string)$msg['htmlBody'] : '';
    $attachments = is_array($msg['attachments'] ?? null) ? $msg['attachments'] : [];
    if (!mb_check_encoding($textBody, 'UTF-8')) $textBody = (string)mb_convert_encoding($textBody, 'UTF-8', 'Windows-1252');
    if (!mb_check_encoding($htmlBody, 'UTF-8')) $htmlBody = (string)mb_convert_encoding($htmlBody, 'UTF-8', 'Windows-1252');
    $text = trim($textBody) !== '' ? $textBody : html_to_plain($htmlBody);

    $hash = hash('sha256', $messageId !== '' ? $messageId : ($from . '|' . $date . '|' . $subject . '|' . $text));
    $dupStmt = $pdo->prepare('SELECT 1 FROM exam_requests WHERE message_hash = ? LIMIT 1');
    $dupStmt->execute([$hash]);
    $isDuplicate = (bool)$dupStmt->fetchColumn();
    $dupStmt->closeCursor();
    if ($isDuplicate) {
        intake_out(intake_duplicate($pdo, $hash));
    }

    $fields = er_parse_fields($text);
    $rawCode = (string)($fields['code'] ?? '');
    $row = [
        'company_id' => null,
        'requester_id' => null,
        'sender_email' => mb_substr($from !== '' ? $from : intake_str($msg, 'from', 255), 0, 255, 'UTF-8'),
        'sender_name' => $fromName !== '' ? $fromName : null,
        'subject' => er_mask_code($subject, $rawCode),
        'message_hash' => $hash,
        'status' => 'INVALID',
        'details_json' => null,
        'students_json' => null,
        'errors' => [],
        'body_redacted' => er_redact_body($text, $rawCode),
    ];
    if ($row['sender_email'] === '') {
        $row['sender_email'] = '(unknown)';
    }

    // ---- Sender ----
    $requester = null;
    if ($from !== '' && $from !== er_mailbox_address($env)) {
        $stmt = $pdo->prepare('SELECT * FROM exam_requesters WHERE email = ? LIMIT 1');
        $stmt->execute([$from]);
        $requester = $stmt->fetch() ?: null;
        $stmt->closeCursor();
    }
    if (!$requester || $requester['status'] !== 'ACTIVE') {
        $row['errors'] = ['Unknown or disabled sender'];
        $id = intake_store($pdo, $row);
        if ($id === null) intake_out(intake_duplicate($pdo, $hash));
        intake_out(['ok' => true, 'requestId' => $id, 'status' => 'INVALID']);
    }
    $requesterId = (int)$requester['id'];
    $companyId = (int)$requester['company_id'];
    $row['requester_id'] = $requesterId;
    $row['company_id'] = $companyId;

    // ---- Rate limit (checked before the code so a flood of forged mail costs no bcrypt work) ----
    $recent = db_scalar_int($pdo, 'SELECT COUNT(*) FROM exam_requests WHERE requester_id = ? AND received_at >= NOW() - INTERVAL 1 HOUR', [$requesterId]);
    if ($recent >= ER_RATE_LIMIT_PER_HOUR) {
        $alreadyTold = db_scalar_int($pdo, "SELECT COUNT(*) FROM exam_requests WHERE requester_id = ? AND status = 'INVALID'
                                             AND received_at >= NOW() - INTERVAL 1 HOUR AND errors_json LIKE ?", [$requesterId, '%Rate limited%']);
        $row['errors'] = [ER_RATE_LIMIT_ERROR];
        $id = intake_store($pdo, $row);
        if ($id === null) intake_out(intake_duplicate($pdo, $hash));
        if ($alreadyTold === 0) {
            intake_reply_rejected($pdo, $env, $requester, $row['subject'],
                'rate limited — more than ' . ER_RATE_LIMIT_PER_HOUR . ' requests in the last hour',
                'Please wait an hour before sending more requests. Requests sent in the meantime are not accepted.');
        }
        intake_out(['ok' => true, 'requestId' => $id, 'status' => 'INVALID']);
    }

    // ---- Security code ----
    $code = er_normalize_code($rawCode);
    if ($code === '' || !password_verify($code, (string)$requester['code_hash'])) {
        $row['errors'] = [$code === '' ? 'Missing security code' : 'Invalid security code'];
        $id = intake_store($pdo, $row);
        if ($id === null) intake_out(intake_duplicate($pdo, $hash));
        intake_reply_rejected($pdo, $env, $requester, $row['subject'], 'invalid security code',
            'Check the Security Code line and send the request again. If you no longer have your code, ask your super admin to issue a new one.');
        intake_out(['ok' => true, 'requestId' => $id, 'status' => 'INVALID']);
    }

    // ---- Authenticated: parse + validate; always PENDING ----
    [$details, $students, $parseErrors, $hints] = er_details_from_email($fields, $attachments);
    [$details, $validationErrors] = er_validate($pdo, $companyId, $details, $students, $hints);
    $errors = array_values(array_unique(array_merge($parseErrors, $validationErrors)));
    $row['status'] = 'PENDING';
    $row['details_json'] = er_json($details);
    $row['students_json'] = er_json($students);
    $row['errors'] = $errors;
    $id = intake_store($pdo, $row);
    if ($id === null) intake_out(intake_duplicate($pdo, $hash));

    $touch = $pdo->prepare('UPDATE exam_requesters SET last_request_at = NOW() WHERE id = ?');
    $touch->execute([$requesterId]);
    $touch->closeCursor();

    audit_log($pdo, [
        'companyId' => $companyId, 'actorRole' => 'SYSTEM', 'actorId' => 'mail:' . $from,
        'action' => 'EXAM_REQUEST_RECEIVED', 'targetType' => 'exam_request', 'targetId' => (string)$id,
        'message' => "Exam request #{$id} received from {$requester['name']}" . ($errors ? ' (' . count($errors) . ' problem(s))' : ''),
    ]);

    $inner = '<p style="margin:0 0 12px;">Hello ' . er_h((string)$requester['name']) . ',</p>'
        . '<p style="margin:0 0 12px;">Your exam request <strong>#' . $id . '</strong> was received and is pending super-admin approval. '
        . 'You will get another email when it is approved or rejected.</p>'
        . er_email_table(er_details_rows($details, count($students)));
    if ($errors) {
        $inner .= '<p style="margin:0 0 4px;font-weight:600;color:#b91c1c;">Problems found — the approver will need to correct these before the exam can be scheduled:</p>'
            . er_email_list($errors)
            . '<p style="margin:0;color:#475569;">If the approver cannot fix them for you, send a corrected request.</p>';
    }
    er_send_mail($pdo, $env, $companyId, (string)$requester['email'],
        '[ProctorGuard] Exam request #' . $id . ' received — pending super-admin approval',
        er_email_html('Exam request #' . $id . ' received', $inner));
    // WhatsApp copy for the employee (only for an authenticated, stored request — never for unknown
    // senders or failed security codes). No-op until WhatsApp is configured; never throws.
    whatsapp_notify_requester($pdo, $env, $requesterId, (int)$id, (string)($details['title'] ?? ''),
        $errors
            ? 'received, needs attention (' . count($errors) . ' problem' . (count($errors) === 1 ? '' : 's') . ' to fix) — pending approval'
            : 'received, pending approval');

    intake_out(['ok' => true, 'requestId' => $id, 'status' => 'PENDING', 'errors' => count($errors)]);
} catch (Throwable $e) {
    error_log('[exam_request_intake] ' . get_class($e) . ': ' . $e->getMessage() . ' in ' . $e->getFile() . ':' . $e->getLine());
    intake_out(['ok' => false, 'error' => get_class($e) . ': ' . mb_substr($e->getMessage(), 0, 300, 'UTF-8')]);
}
