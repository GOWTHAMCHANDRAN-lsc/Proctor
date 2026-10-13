<?php
declare(strict_types=1);

/**
 * Background sending of exam invitations and reminders (email and/or WhatsApp).
 *
 * The exam screens used to push every email through ONE long browser request and report the
 * result in a JavaScript alert. That cannot work for hundreds of recipients: the request times out,
 * a shared-hosting mail account only accepts so many messages an hour, and closing the tab lost the
 * rest. Here a send is a JOB: the screen creates it and shows its progress; scripts/notify_worker.php
 * (started straight away and by cron every minute) does the sending at a steady pace, pauses by
 * itself when the mail server's hourly limit is reached and resumes when it frees up, retries
 * temporary failures, and records each recipient's outcome. Closing the browser changes nothing.
 *
 * Emails are rendered on the server with api/exam_mail_render.php (the same HTML the console
 * previews) and carry the exam's attachment when it has one (api/exam_attachments.php); WhatsApp
 * goes through whatsapp_send_exam_notice(), i.e. the template in use.
 *
 * Required by scripts/notify_worker.php for the functions; the HTTP handler at the bottom only runs
 * when this file is the requested script (the notify.php / whatsapp.php pattern).
 */

require_once __DIR__ . '/_bootstrap.php';
require_once __DIR__ . '/notify.php';           // smtp_open / smtp_deliver / add_delivery_log / html_to_plain
require_once __DIR__ . '/whatsapp.php';
require_once __DIR__ . '/exam_mail_render.php';
require_once __DIR__ . '/exam_attachments.php';

const NOTIFY_JOB_KINDS = ['INVITE', 'REMINDER'];
const NOTIFY_JOB_MAX_RECIPIENTS = 5000;
const NOTIFY_EMAIL_MAX_ATTEMPTS = 3;
// Used when .env doesn't say: a conservative hourly ceiling for a shared-hosting mailbox
// (MAIL_MAX_PER_HOUR) and the pause between two emails in milliseconds (MAIL_SEND_GAP_MS).
const NOTIFY_DEFAULT_MAX_PER_HOUR = 300;
const NOTIFY_DEFAULT_GAP_MS = 1200;

function ensure_notify_job_schema(PDO $pdo): void {
    static $done = false;
    if ($done) {
        return;
    }
    $done = true;
    $pdo->exec("CREATE TABLE IF NOT EXISTS notification_jobs (
      id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      company_id       INT NOT NULL,
      exam_id          VARCHAR(64) NOT NULL,
      kind             VARCHAR(16) NOT NULL,
      use_email        TINYINT(1) NOT NULL DEFAULT 1,
      use_whatsapp     TINYINT(1) NOT NULL DEFAULT 0,
      subject_override TEXT NULL,
      message_override MEDIUMTEXT NULL,
      status           VARCHAR(16) NOT NULL DEFAULT 'QUEUED',
      total            INT NOT NULL DEFAULT 0,
      paused_until     DATETIME NULL,
      note             VARCHAR(255) NULL,
      created_by       VARCHAR(255) NULL,
      created_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      started_at       DATETIME NULL,
      finished_at      DATETIME NULL,
      heartbeat_at     DATETIME NULL,
      INDEX idx_notification_jobs_status (status),
      INDEX idx_notification_jobs_exam (company_id, exam_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
    $pdo->exec("CREATE TABLE IF NOT EXISTS notification_job_items (
      id                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      job_id             BIGINT UNSIGNED NOT NULL,
      student_id         VARCHAR(64) NOT NULL,
      student_company_id INT NOT NULL,
      full_name          VARCHAR(255) NULL,
      email              VARCHAR(255) NULL,
      email_status       VARCHAR(12) NOT NULL DEFAULT 'PENDING',
      email_error        VARCHAR(500) NULL,
      email_attempts     TINYINT UNSIGNED NOT NULL DEFAULT 0,
      wa_status          VARCHAR(12) NOT NULL DEFAULT 'PENDING',
      wa_error           VARCHAR(500) NULL,
      updated_at         TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_notification_job_item (job_id, student_id),
      INDEX idx_notification_job_items_email (job_id, email_status),
      INDEX idx_notification_job_items_wa (job_id, wa_status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
    // Same table exams.php keeps: who has been sent their link.
    $pdo->exec("CREATE TABLE IF NOT EXISTS exam_invitations (
      exam_id    VARCHAR(64) NOT NULL,
      student_id VARCHAR(64) NOT NULL,
      sent_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (exam_id, student_id),
      INDEX idx_exam_invitations_student (student_id)
    ) ENGINE=InnoDB");
}

function notify_email_limit_per_hour(): int {
    $value = (int)pg_env('MAIL_MAX_PER_HOUR', (string)NOTIFY_DEFAULT_MAX_PER_HOUR);
    return $value > 0 ? min($value, 100000) : NOTIFY_DEFAULT_MAX_PER_HOUR;
}

function notify_email_gap_ms(): int {
    $value = (int)pg_env('MAIL_SEND_GAP_MS', (string)NOTIFY_DEFAULT_GAP_MS);
    return max(0, min($value, 60000));
}

/** Emails this platform sent in the last 60 minutes (every company: they share one mail account). */
function notify_emails_last_hour(PDO $pdo): int {
    return db_scalar_int($pdo, "SELECT COUNT(*) FROM delivery_logs WHERE channel = 'EMAIL' AND status = 'SENT' AND created_at > NOW() - INTERVAL 1 HOUR");
}

/**
 * Queue a send. $studentIds is the audience the admin chose; only students of this company or
 * assigned to the exam are accepted. Returns ['ok' => true, 'jobId' => n] or ['ok' => false, 'error' => ...].
 */
function notify_job_create(PDO $pdo, array $env, int $companyId, string $examId, string $kind, array $studentIds, array $channels, ?string $subject, ?string $message, string $actor): array {
    ensure_notify_job_schema($pdo);
    $kind = strtoupper(trim($kind));
    if (!in_array($kind, NOTIFY_JOB_KINDS, true)) {
        return ['ok' => false, 'error' => 'kind must be INVITE or REMINDER.'];
    }
    $useEmail = !empty($channels['email']);
    $useWhatsApp = !empty($channels['whatsapp']);
    if (!$useEmail && !$useWhatsApp) {
        return ['ok' => false, 'error' => 'Choose email, WhatsApp or both.'];
    }
    $examStmt = $pdo->prepare('SELECT id, title FROM exams WHERE id = ? AND company_id = ? LIMIT 1');
    $examStmt->execute([$examId, $companyId]);
    $exam = $examStmt->fetch();
    $examStmt->closeCursor();
    if (!$exam) {
        return ['ok' => false, 'error' => 'Exam not found.'];
    }
    if ($useEmail && (trim((string)($env['SMTP_HOST'] ?? '')) === '' || trim((string)($env['SMTP_FROM'] ?? '')) === '')) {
        return ['ok' => false, 'error' => 'Email is not configured on the server (SMTP).'];
    }
    $waNote = null;
    if ($useWhatsApp && !whatsapp_kind_ready(whatsapp_config($env), $kind)) {
        if (!$useEmail) {
            return ['ok' => false, 'error' => 'WhatsApp is not set up for this message.'];
        }
        $useWhatsApp = false;
        $waNote = 'WhatsApp is not set up for this message, so only email is sent.';
    }
    $ids = array_values(array_unique(array_filter(array_map(static fn($v) => is_scalar($v) ? trim((string)$v) : '', $studentIds), static fn($v) => $v !== '')));
    if (count($ids) === 0) {
        return ['ok' => false, 'error' => 'No recipients were selected.'];
    }
    if (count($ids) > NOTIFY_JOB_MAX_RECIPIENTS) {
        return ['ok' => false, 'error' => 'At most ' . NOTIFY_JOB_MAX_RECIPIENTS . ' recipients per send.'];
    }
    $active = db_scalar_int($pdo, "SELECT COUNT(*) FROM notification_jobs WHERE company_id = ? AND exam_id = ? AND kind = ? AND status IN ('QUEUED','RUNNING','PAUSED')", [$companyId, $examId, $kind]);
    if ($active > 0) {
        return ['ok' => false, 'error' => 'This exam is already sending ' . ($kind === 'INVITE' ? 'invitations' : 'reminders') . '. Wait for it to finish or stop it first.', 'code' => 'ALREADY_SENDING'];
    }

    $subject = $subject !== null && trim($subject) !== '' ? mb_substr($subject, 0, 255, 'UTF-8') : null;
    $message = $message !== null && trim($message) !== '' ? mb_substr($message, 0, 20000, 'UTF-8') : null;

    // Students without a mobile number / an email address are marked up front, so each channel's
    // total is right from the start. SKIPPED = that channel is not used for this send.
    $hasMobile = $useWhatsApp && !empty(whatsapp_schema_once($pdo)['studentsMobile']);
    $waStatusSql = !$useWhatsApp ? "'SKIPPED'" : ($hasMobile ? "IF(s.mobile IS NULL OR TRIM(s.mobile) = '', 'NO_MOBILE', 'PENDING')" : "'NO_MOBILE'");
    $emailStatusSql = !$useEmail ? "'SKIPPED'" : "IF(s.email IS NULL OR TRIM(s.email) = '', 'NO_EMAIL', 'PENDING')";

    $pdo->beginTransaction();
    try {
        $insertJob = $pdo->prepare("INSERT INTO notification_jobs (company_id, exam_id, kind, use_email, use_whatsapp, subject_override, message_override, status, total, note, created_by)
                                    VALUES (?, ?, ?, ?, ?, ?, ?, 'QUEUED', 0, ?, ?)");
        $insertJob->execute([$companyId, $examId, $kind, $useEmail ? 1 : 0, $useWhatsApp ? 1 : 0, $subject, $message, $waNote, mb_substr($actor, 0, 255, 'UTF-8')]);
        $insertJob->closeCursor();
        $jobId = (int)$pdo->lastInsertId();
        $total = 0;
        foreach (array_chunk($ids, 500) as $chunk) {
            $ph = implode(',', array_fill(0, count($chunk), '?'));
            // Students of this company, or of any company when they are on this exam's own list.
            $stmt = $pdo->prepare("INSERT IGNORE INTO notification_job_items (job_id, student_id, student_company_id, full_name, email, email_status, wa_status)
                                   SELECT ?, s.id, s.company_id, s.full_name, LOWER(TRIM(s.email)), {$emailStatusSql}, {$waStatusSql}
                                     FROM students s
                                    WHERE s.id IN ($ph)
                                      AND (s.company_id = ? OR EXISTS (SELECT 1 FROM exam_assignments ea WHERE ea.exam_id = ? AND ea.student_id = s.id))");
            $stmt->execute(array_merge([$jobId], $chunk, [$companyId, $examId]));
            $total += $stmt->rowCount();
            $stmt->closeCursor();
        }
        if ($total === 0) {
            $pdo->rollBack();
            return ['ok' => false, 'error' => 'None of the selected students belong to this exam or company.'];
        }
        $upd = $pdo->prepare('UPDATE notification_jobs SET total = ? WHERE id = ?');
        $upd->execute([$total, $jobId]);
        $upd->closeCursor();
        $pdo->commit();
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) {
            $pdo->rollBack();
        }
        throw $e;
    }
    return ['ok' => true, 'jobId' => $jobId, 'total' => $total];
}

/** Start the worker now instead of waiting for cron's next minute. Best effort. */
function notify_worker_kick(): void {
    $script = realpath(__DIR__ . '/../scripts/notify_worker.php');
    if ($script === false || !function_exists('exec')) {
        return;
    }
    $php = is_executable('/usr/bin/php') ? '/usr/bin/php' : 'php';
    @exec('nohup ' . escapeshellarg($php) . ' ' . escapeshellarg($script) . ' > /dev/null 2>&1 &');
}

/** What the progress screen shows for a job. */
function notify_job_public(PDO $pdo, array $job): array {
    $jobId = (int)$job['id'];
    $countStmt = $pdo->prepare("SELECT
            SUM(email_status = 'SENT') AS email_sent, SUM(email_status = 'FAILED') AS email_failed, SUM(email_status = 'PENDING') AS email_pending,
            SUM(wa_status = 'SENT') AS wa_sent, SUM(wa_status = 'FAILED') AS wa_failed, SUM(wa_status = 'PENDING') AS wa_pending,
            SUM(wa_status = 'NO_MOBILE') AS wa_no_mobile, SUM(email_status = 'NO_EMAIL') AS email_no_email,
            SUM(email_status IN ('NO_EMAIL','SKIPPED') AND wa_status IN ('NO_MOBILE','SKIPPED')) AS unreachable,
            SUM(email_status = 'SENT' OR wa_status = 'SENT') AS reached
        FROM notification_job_items WHERE job_id = ?");
    $countStmt->execute([$jobId]);
    $c = $countStmt->fetch() ?: [];
    $countStmt->closeCursor();
    $failStmt = $pdo->prepare("SELECT full_name, email, email_status, email_error, wa_status, wa_error
                                 FROM notification_job_items
                                WHERE job_id = ? AND (email_status = 'FAILED' OR wa_status = 'FAILED')
                                ORDER BY id ASC LIMIT 100");
    $failStmt->execute([$jobId]);
    $failures = [];
    foreach ($failStmt->fetchAll() as $row) {
        if ($row['email_status'] === 'FAILED') {
            $failures[] = ['name' => (string)$row['full_name'], 'email' => (string)$row['email'], 'channel' => 'EMAIL', 'error' => (string)($row['email_error'] ?? 'Not sent')];
        }
        if ($row['wa_status'] === 'FAILED') {
            $failures[] = ['name' => (string)$row['full_name'], 'email' => (string)($row['email'] ?? ''), 'channel' => 'WHATSAPP', 'error' => (string)($row['wa_error'] ?? 'Not sent')];
        }
    }
    $failStmt->closeCursor();
    $toMs = static fn($v) => ($v === null || $v === '') ? null : strtotime((string)$v . ' UTC') * 1000;
    $emailPending = (int)($c['email_pending'] ?? 0);
    $limit = notify_email_limit_per_hour();
    return [
        'id' => $jobId,
        'examId' => (string)$job['exam_id'],
        'kind' => (string)$job['kind'],
        'status' => (string)$job['status'],
        'total' => (int)$job['total'],
        'useEmail' => (bool)$job['use_email'],
        'useWhatsApp' => (bool)$job['use_whatsapp'],
        'email' => ['sent' => (int)($c['email_sent'] ?? 0), 'failed' => (int)($c['email_failed'] ?? 0), 'pending' => $emailPending, 'noEmail' => (int)($c['email_no_email'] ?? 0)],
        'whatsapp' => ['sent' => (int)($c['wa_sent'] ?? 0), 'failed' => (int)($c['wa_failed'] ?? 0), 'pending' => (int)($c['wa_pending'] ?? 0), 'noMobile' => (int)($c['wa_no_mobile'] ?? 0)],
        'reached' => (int)($c['reached'] ?? 0),
        // Students with no contact detail for any channel this send uses (nothing could go to them).
        'unreachable' => (int)($c['unreachable'] ?? 0),
        'failures' => $failures,
        'note' => $job['note'] ?? null,
        'pausedUntil' => $toMs($job['paused_until'] ?? null),
        'createdAt' => $toMs($job['created_at'] ?? null),
        'finishedAt' => $toMs($job['finished_at'] ?? null),
        'emailLimitPerHour' => $limit,
        // A rough finish time for the emails: paced, and at most the hourly limit each hour.
        'emailEtaSeconds' => $emailPending === 0 ? 0 : (int)max(
            ceil($emailPending * (notify_email_gap_ms() + 800) / 1000),
            $emailPending > $limit ? floor(($emailPending - 1) / $limit) * 3600 : 0
        ),
    ];
}

function notify_job_fetch(PDO $pdo, int $jobId): ?array {
    $stmt = $pdo->prepare('SELECT * FROM notification_jobs WHERE id = ? LIMIT 1');
    $stmt->execute([$jobId]);
    $row = $stmt->fetch();
    $stmt->closeCursor();
    return $row ?: null;
}

// ---------------------------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------------------------

/** True when an SMTP error text means "you are sending too fast / too much", not "bad recipient". */
function notify_is_rate_limit_error(string $error): bool {
    return preg_match('/exceed|too many|rate.?limit|quota|limit reached|max(imum)? (number of )?(emails|messages|defers)|try again later|throttl|\[4[25]\d\]/i', $error) === 1;
}

/** True when the mail server refused this recipient for good (retrying cannot help). */
function notify_is_permanent_recipient_error(string $error): bool {
    return preg_match('/RCPT TO[^\[]*\[5\d\d\]|Invalid recipient|user unknown|no such user|mailbox unavailable|does not exist/i', $error) === 1
        && !notify_is_rate_limit_error($error);
}

function notify_job_pause(PDO $pdo, int $jobId, int $seconds, string $note): void {
    $stmt = $pdo->prepare("UPDATE notification_jobs SET status = 'PAUSED', paused_until = DATE_ADD(NOW(), INTERVAL ? SECOND), note = ? WHERE id = ? AND status IN ('QUEUED','RUNNING','PAUSED')");
    $stmt->execute([max(30, $seconds), mb_substr($note, 0, 255, 'UTF-8'), $jobId]);
    $stmt->closeCursor();
}

/**
 * Do up to $budget seconds of sending. One worker at a time (MySQL named lock), so cron and a
 * just-kicked worker never send the same message twice. Returns a short summary for the log.
 */
function notify_worker_run(PDO $pdo, array $env, float $budget = 55.0): string {
    ensure_notify_job_schema($pdo);
    $lock = $pdo->query("SELECT GET_LOCK('pg_notify_worker', 0)");
    $got = (int)$lock->fetchColumn();
    $lock->closeCursor();
    if ($got !== 1) {
        return 'another worker is running';
    }
    $started = microtime(true);
    $sentEmails = 0;
    $sentWhatsApp = 0;
    $smtpFp = null;
    $closeSmtp = static function () use (&$smtpFp): void {
        if (is_resource($smtpFp)) {
            smtp_close($smtpFp);
        }
        $smtpFp = null;
    };
    try {
        $limit = notify_email_limit_per_hour();
        $gapUs = notify_email_gap_ms() * 1000;
        $origin = rtrim((string)pg_env('APP_ORIGIN', 'https://proctor.lsc-crm.in'), '/');
        $from = (string)($env['SMTP_FROM'] ?? '');

        while (microtime(true) - $started < $budget) {
            $jobStmt = $pdo->query("SELECT * FROM notification_jobs
                                     WHERE status IN ('QUEUED','RUNNING') OR (status = 'PAUSED' AND (paused_until IS NULL OR paused_until <= NOW()))
                                     ORDER BY id ASC LIMIT 1");
            $job = $jobStmt->fetch();
            $jobStmt->closeCursor();
            if (!$job) {
                break;
            }
            $jobId = (int)$job['id'];
            $kind = (string)$job['kind'];
            $examId = (string)$job['exam_id'];
            $jobCompany = (int)$job['company_id'];
            // note first: MySQL applies SET left to right, so it must read the status before it changes.
            $run = $pdo->prepare("UPDATE notification_jobs SET note = IF(status = 'PAUSED', NULL, note), status = 'RUNNING', paused_until = NULL,
                                         started_at = COALESCE(started_at, NOW()), heartbeat_at = NOW() WHERE id = ?");
            $run->execute([$jobId]);
            $run->closeCursor();

            // The email as the console previews it, with the composer's unsaved subject/message if any.
            $mailExam = (bool)$job['use_email'] ? exam_mail_exam_by_id($pdo, $examId) : null;
            if ($mailExam !== null && ($job['subject_override'] !== null || $job['message_override'] !== null)) {
                $existing = is_array($mailExam['mailTemplates'][$kind] ?? null) ? $mailExam['mailTemplates'][$kind] : [];
                $resolved = exam_mail_resolve_template($mailExam, $kind === 'REMINDER');
                $mailExam['mailTemplates'][$kind] = [
                    'subject' => $job['subject_override'] !== null ? (string)$job['subject_override'] : $resolved['subject'],
                    'message' => $job['message_override'] !== null ? (string)$job['message_override'] : $resolved['message'],
                    'options' => $existing['options'] ?? null,
                ];
            }
            // The exam's attachment, read and encoded once for the whole run. If it exists but cannot
            // be read, the emails fail with that reason rather than go out without the document.
            $mailAttachment = $mailExam !== null ? exam_attachment_for_mail($pdo, $examId) : ['attachments' => [], 'error' => null];
            $markInvited = $pdo->prepare('INSERT IGNORE INTO exam_invitations (exam_id, student_id) VALUES (?, ?)');
            $setEmail = $pdo->prepare('UPDATE notification_job_items SET email_status = ?, email_error = ?, email_attempts = ? WHERE id = ?');
            $setWa = $pdo->prepare('UPDATE notification_job_items SET wa_status = ?, wa_error = ? WHERE id = ?');
            $emailsThisHour = notify_emails_last_hour($pdo);
            $jobHalted = false;
            // Set once email cannot continue for now ([seconds to wait, why]). WhatsApp carries on for
            // the rest of the list; the job then pauses until email can resume.
            $emailBlock = null;

            while (!$jobHalted && microtime(true) - $started < $budget) {
                $itemStmt = $pdo->prepare("SELECT * FROM notification_job_items WHERE job_id = ? AND "
                    . ($emailBlock !== null ? "wa_status = 'PENDING'" : "(email_status = 'PENDING' OR wa_status = 'PENDING')")
                    . " ORDER BY email_attempts ASC, id ASC LIMIT 25");
                $itemStmt->execute([$jobId]);
                $items = $itemStmt->fetchAll();
                $itemStmt->closeCursor();
                if (count($items) === 0) {
                    if ($emailBlock !== null) {
                        notify_job_pause($pdo, $jobId, (int)$emailBlock[0], (string)$emailBlock[1]);
                    } else {
                        $done = $pdo->prepare("UPDATE notification_jobs SET status = 'DONE', finished_at = NOW(), paused_until = NULL WHERE id = ? AND status = 'RUNNING'");
                        $done->execute([$jobId]);
                        $done->closeCursor();
                    }
                    break;
                }
                foreach ($items as $item) {
                    if (microtime(true) - $started >= $budget) {
                        break;
                    }
                    // Stop pressed? (also keeps the heartbeat fresh for the progress screen)
                    $live = $pdo->prepare('SELECT status FROM notification_jobs WHERE id = ?');
                    $live->execute([$jobId]);
                    $liveStatus = (string)$live->fetchColumn();
                    $live->closeCursor();
                    if ($liveStatus !== 'RUNNING') {
                        $jobHalted = true;
                        break;
                    }
                    $itemId = (int)$item['id'];
                    $studentId = (string)$item['student_id'];
                    $studentCompany = (int)$item['student_company_id'];
                    $email = strtolower(trim((string)($item['email'] ?? '')));
                    $fullName = trim((string)$item['full_name']) !== '' ? trim((string)$item['full_name']) : $email;
                    $reached = false;

                    if ($item['email_status'] === 'PENDING' && $emailBlock === null) {
                        if ($mailExam === null) {
                            $setEmail->execute(['FAILED', 'Exam not found.', (int)$item['email_attempts'], $itemId]);
                        } elseif (filter_var($email, FILTER_VALIDATE_EMAIL) === false) {
                            $setEmail->execute(['FAILED', 'Invalid email address.', (int)$item['email_attempts'], $itemId]);
                        } elseif ($mailAttachment['error'] !== null) {
                            $setEmail->execute(['FAILED', mb_substr((string)$mailAttachment['error'], 0, 480, 'UTF-8'), (int)$item['email_attempts'], $itemId]);
                        } elseif ($emailsThisHour >= $limit) {
                            // Hourly ceiling reached: wait for the oldest of this hour's emails to age out.
                            $waitStmt = $pdo->prepare("SELECT TIMESTAMPDIFF(SECOND, NOW(), DATE_ADD(created_at, INTERVAL 1 HOUR)) FROM delivery_logs
                                                        WHERE channel = 'EMAIL' AND status = 'SENT' AND created_at > NOW() - INTERVAL 1 HOUR
                                                        ORDER BY created_at ASC LIMIT 1 OFFSET " . max(0, $emailsThisHour - $limit));
                            $waitStmt->execute();
                            $wait = (int)$waitStmt->fetchColumn();
                            $waitStmt->closeCursor();
                            $emailBlock = [$wait + 30, "Sending at most {$limit} emails an hour. It continues automatically."];
                        } else {
                            if (!is_resource($smtpFp)) {
                                $conn = smtp_open((string)($env['SMTP_HOST'] ?? ''), (int)($env['SMTP_PORT'] ?? 0), (string)($env['SMTP_USER'] ?? ''), (string)($env['SMTP_PASS'] ?? ''),
                                    (string)($env['SMTP_SECURE'] ?? ''), max(5, min(60, (int)($env['SMTP_TIMEOUT'] ?? 15))), (($env['SMTP_ALLOW_SELF_SIGNED'] ?? '0') === '1'));
                                if (!$conn['ok']) {
                                    $emailBlock = [120, 'The mail server could not be reached. Trying again in 2 minutes.'];
                                } else {
                                    $smtpFp = $conn['fp'];
                                }
                            }
                        }
                        if ($emailBlock === null && is_resource($smtpFp) && $mailExam !== null && $mailAttachment['error'] === null && filter_var($email, FILTER_VALIDATE_EMAIL) !== false) {
                            $link = $kind === 'INVITE' ? exam_access_link($pdo, $origin, $examId, $studentId, $studentCompany) : '';
                            $rendered = exam_mail_render($mailExam, $fullName, $link, $kind);
                            $send = smtp_deliver($smtpFp, $from, [
                                'to' => $email,
                                'subject' => $rendered['subject'],
                                'body' => $rendered['html'],
                                'plain' => html_to_plain($rendered['html']),
                                'attachments' => $mailAttachment['attachments'],
                            ]);
                            $attempts = (int)$item['email_attempts'] + 1;
                            if ($send['ok']) {
                                $rset = @fwrite($smtpFp, "RSET\r\n");
                                $resp = $rset === false ? ['code' => 0] : smtp_read_response($smtpFp);
                                if ($rset === false || $resp['code'] !== 250) {
                                    $closeSmtp();
                                }
                                add_delivery_log($pdo, $studentCompany, 'EMAIL', $email, $rendered['subject'], $rendered['html'], 'SENT', null);
                                $setEmail->execute(['SENT', null, $attempts, $itemId]);
                                $reached = true;
                                $sentEmails++;
                                $emailsThisHour++;
                                if ($sentEmails % 40 === 0) {
                                    $emailsThisHour = notify_emails_last_hour($pdo);
                                }
                                if ($gapUs > 0) {
                                    usleep($gapUs);
                                }
                            } else {
                                $closeSmtp();
                                $error = mb_substr((string)($send['error'] ?? 'Send failed'), 0, 480, 'UTF-8');
                                if (notify_is_rate_limit_error($error)) {
                                    // The mail server says we are over its limit: nothing was lost, wait for the
                                    // next hour to begin and carry on with this same recipient.
                                    $toNextHour = 3600 - ((int)gmdate('i') * 60 + (int)gmdate('s')) + 90;
                                    $emailBlock = [$toNextHour, 'The mail server\'s hourly sending limit was reached. It continues automatically.'];
                                } elseif (notify_is_permanent_recipient_error($error) || $attempts >= NOTIFY_EMAIL_MAX_ATTEMPTS) {
                                    add_delivery_log($pdo, $studentCompany, 'EMAIL', $email, $rendered['subject'], $rendered['html'], 'FAILED', $error);
                                    $setEmail->execute(['FAILED', $error, $attempts, $itemId]);
                                } else {
                                    // Temporary problem: leave it queued; it is retried after the others.
                                    $setEmail->execute(['PENDING', $error, $attempts, $itemId]);
                                    usleep(500000);
                                }
                            }
                        }
                    } elseif ($item['email_status'] === 'SENT') {
                        $reached = true;
                    }

                    if ($item['wa_status'] === 'PENDING') {
                        try {
                            // The mobile is read here (by student id alone) so a student from another company
                            // on this exam's list is found too.
                            $mobileStmt = $pdo->prepare('SELECT mobile FROM students WHERE id = ? LIMIT 1');
                            $mobileStmt->execute([$studentId]);
                            $mobile = $mobileStmt->fetchColumn();
                            $mobileStmt->closeCursor();
                            $wa = whatsapp_send_exam_notice($pdo, $env, $jobCompany, ['id' => $examId],
                                ['id' => $studentId, 'full_name' => $item['full_name'], 'company_id' => $studentCompany, 'mobile' => $mobile === false ? '' : (string)$mobile], $kind);
                        } catch (Throwable $e) {
                            $wa = ['status' => 'FAILED', 'error' => 'WhatsApp send failed.'];
                            error_log('[notify_worker] whatsapp: ' . $e->getMessage());
                        }
                        if (($wa['status'] ?? '') === 'SENT') {
                            $setWa->execute(['SENT', null, $itemId]);
                            $reached = true;
                            $sentWhatsApp++;
                        } elseif (($wa['reason'] ?? '') === 'NO_MOBILE') {
                            $setWa->execute(['NO_MOBILE', null, $itemId]);
                        } elseif (($wa['status'] ?? '') === 'FAILED') {
                            $setWa->execute(['FAILED', mb_substr((string)($wa['error'] ?? 'Not sent'), 0, 480, 'UTF-8'), $itemId]);
                        } else {
                            $setWa->execute(['FAILED', mb_substr((string)($wa['error'] ?? 'WhatsApp is not available for this message.'), 0, 480, 'UTF-8'), $itemId]);
                        }
                    }

                    // Invitations: the student has their link once either channel reached them.
                    if ($kind === 'INVITE' && $reached) {
                        $markInvited->execute([$examId, $studentId]);
                    }
                    $beat = $pdo->prepare('UPDATE notification_jobs SET heartbeat_at = NOW() WHERE id = ?');
                    $beat->execute([$jobId]);
                    $beat->closeCursor();
                }
            }
            if (microtime(true) - $started >= $budget) {
                break;
            }
        }
    } finally {
        $closeSmtp();
        $release = $pdo->query("SELECT RELEASE_LOCK('pg_notify_worker')");
        $release->closeCursor();
    }
    return "emails {$sentEmails}, whatsapp {$sentWhatsApp}";
}

// =============================================================================================
// HTTP handler — skipped when this file is included for its functions.
// =============================================================================================
if (basename($_SERVER['SCRIPT_FILENAME'] ?? '') !== 'notify_jobs.php') {
    return;
}

ensure_notify_job_schema($pdo);
$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';

if ($method === 'GET') {
    require_role(['SUPER_ADMIN', 'ADMIN']);
    $companyId = require_company_id();
    if (isset($_GET['id'])) {
        $job = notify_job_fetch($pdo, (int)$_GET['id']);
        if (!$job || (int)$job['company_id'] !== $companyId) {
            json_response(['error' => 'Send not found.'], 404);
        }
        json_response(['job' => notify_job_public($pdo, $job)]);
    }
    // Sends still in progress for this company (the exam cards show them).
    $stmt = $pdo->prepare("SELECT * FROM notification_jobs WHERE company_id = ? AND status IN ('QUEUED','RUNNING','PAUSED') ORDER BY id DESC LIMIT 50");
    $stmt->execute([$companyId]);
    $jobs = array_map(static fn($row) => notify_job_public($pdo, $row), $stmt->fetchAll());
    $stmt->closeCursor();
    json_response(['jobs' => $jobs]);
}

if ($method !== 'POST') {
    json_response(['error' => 'Method not allowed.'], 405);
}

$payload = json_input();
$actorRole = require_role(['SUPER_ADMIN', 'ADMIN'], $payload);
$companyId = require_company_id($payload);
$actorId = (string)(get_actor_id($payload) ?? 'admin');
$action = strtoupper(trim((string)($payload['action'] ?? '')));

if ($action === 'CREATE') {
    $channels = is_array($payload['channels'] ?? null) ? $payload['channels'] : ['email' => true, 'whatsapp' => false];
    $result = notify_job_create(
        $pdo, $env, $companyId, trim((string)($payload['examId'] ?? '')), (string)($payload['kind'] ?? ''),
        is_array($payload['studentIds'] ?? null) ? $payload['studentIds'] : [], $channels,
        isset($payload['subject']) && is_string($payload['subject']) ? $payload['subject'] : null,
        isset($payload['message']) && is_string($payload['message']) ? $payload['message'] : null,
        $actorId
    );
    if (!$result['ok']) {
        json_response(['error' => $result['error'], 'code' => $result['code'] ?? null], ($result['code'] ?? '') === 'ALREADY_SENDING' ? 409 : 400);
    }
    $job = notify_job_fetch($pdo, (int)$result['jobId']);
    audit_log($pdo, [
        'companyId' => $companyId, 'actorRole' => $actorRole, 'actorId' => $actorId,
        'action' => 'NOTIFY_JOB_CREATE', 'targetType' => 'exam', 'targetId' => (string)$job['exam_id'],
        'message' => ucfirst(strtolower((string)$job['kind'])) . ' send queued for ' . (int)$result['total'] . ' student(s)'
            . ' (' . implode(' + ', array_filter([(bool)$job['use_email'] ? 'email' : null, (bool)$job['use_whatsapp'] ? 'WhatsApp' : null])) . ')',
        'metadata' => ['jobId' => (int)$job['id']],
    ]);
    notify_worker_kick();
    json_response(['ok' => true, 'job' => notify_job_public($pdo, $job)]);
}

$job = notify_job_fetch($pdo, (int)($payload['id'] ?? 0));
if (!$job || (int)$job['company_id'] !== $companyId) {
    json_response(['error' => 'Send not found.'], 404);
}
$jobId = (int)$job['id'];

if ($action === 'CANCEL') {
    // Stop what has not gone out yet; whatever was already sent stays sent.
    $stmt = $pdo->prepare("UPDATE notification_jobs SET status = 'CANCELLED', finished_at = NOW(), paused_until = NULL, note = 'Stopped by an administrator.' WHERE id = ? AND status IN ('QUEUED','RUNNING','PAUSED')");
    $stmt->execute([$jobId]);
    $stmt->closeCursor();
    // STOPPED (not SKIPPED, which means "channel not used") so the counts stay truthful.
    $skip = $pdo->prepare("UPDATE notification_job_items SET email_status = IF(email_status = 'PENDING', 'STOPPED', email_status), wa_status = IF(wa_status = 'PENDING', 'STOPPED', wa_status) WHERE job_id = ?");
    $skip->execute([$jobId]);
    $skip->closeCursor();
    json_response(['ok' => true, 'job' => notify_job_public($pdo, notify_job_fetch($pdo, $jobId))]);
}

if ($action === 'RETRY_FAILED') {
    if (in_array((string)$job['status'], ['QUEUED', 'RUNNING', 'PAUSED'], true)) {
        json_response(['error' => 'This send is still in progress.'], 409);
    }
    $retry = $pdo->prepare("UPDATE notification_job_items
                               SET email_attempts = IF(email_status = 'FAILED', 0, email_attempts),
                                   email_status = IF(email_status = 'FAILED', 'PENDING', email_status),
                                   wa_status = IF(wa_status = 'FAILED', 'PENDING', wa_status)
                             WHERE job_id = ? AND (email_status = 'FAILED' OR wa_status = 'FAILED')");
    $retry->execute([$jobId]);
    $requeued = $retry->rowCount();
    $retry->closeCursor();
    if ($requeued > 0) {
        $stmt = $pdo->prepare("UPDATE notification_jobs SET status = 'QUEUED', finished_at = NULL, note = NULL WHERE id = ?");
        $stmt->execute([$jobId]);
        $stmt->closeCursor();
        notify_worker_kick();
    }
    json_response(['ok' => true, 'requeued' => $requeued, 'job' => notify_job_public($pdo, notify_job_fetch($pdo, $jobId))]);
}

json_response(['error' => 'Unknown action.'], 400);
