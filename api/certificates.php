<?php
declare(strict_types=1);

require_once __DIR__ . '/_bootstrap.php';
require_once __DIR__ . '/notify.php';

/**
 * V1 automation, Phase 2 (Certify): on a session's final pass, create a certificate-issuance record
 * and hand it to an external certificate-generation system's API, then email the learner on issue
 * (and on demand thereafter). See docs/ProctorGuard_V1_Requirements.md §7.6.
 *
 * The customer's certificate-system contract (endpoints/auth/payload shape) isn't known yet — see
 * the doc's own §14 open question #1. Everything up to that boundary is real and wired in; only
 * call_certificate_api() below is a stub, isolated so wiring in the real API later is a one-function
 * change instead of a redesign.
 */

function ensure_certificates_schema(PDO $pdo): void {
    $pdo->exec("CREATE TABLE IF NOT EXISTS certificate_issuances (
        id                      BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        company_id              INT NOT NULL,
        session_id              BIGINT UNSIGNED NOT NULL,
        student_id              VARCHAR(64) NOT NULL,
        exam_id                 VARCHAR(64) NOT NULL,
        verification_id         VARCHAR(64) NOT NULL,
        external_certificate_id VARCHAR(128) NULL,
        verification_url        VARCHAR(512) NULL,
        status                  ENUM('PENDING','ISSUED','FAILED','DEAD') NOT NULL DEFAULT 'PENDING',
        attempts                INT NOT NULL DEFAULT 0,
        error                   TEXT NULL,
        issued_at               TIMESTAMP NULL DEFAULT NULL,
        last_emailed_at         TIMESTAMP NULL DEFAULT NULL,
        email_count             INT NOT NULL DEFAULT 0,
        created_at              TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uq_certificate_issuances_session (session_id),
        UNIQUE KEY uq_certificate_issuances_verification (verification_id),
        INDEX idx_certificate_issuances_company (company_id),
        INDEX idx_certificate_issuances_status (status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");

    // Migrate deployments created before 'DEAD' was added to the status enum.
    try {
        $col = $pdo->query("SHOW COLUMNS FROM certificate_issuances LIKE 'status'")->fetch();
        $type = is_array($col) ? (string)($col['Type'] ?? '') : '';
        if ($type !== '' && stripos($type, 'DEAD') === false) {
            $pdo->exec("ALTER TABLE certificate_issuances MODIFY status ENUM('PENDING','ISSUED','FAILED','DEAD') NOT NULL DEFAULT 'PENDING'");
        }
    } catch (Throwable $e) {
        // Best-effort schema migration; normal query errors still surface elsewhere.
    }
}

ensure_certificates_schema($pdo);

// ---------------------------------------------------------------------------
// The external call. STUB — replace this function's body once the certificate system's real
// contract (endpoint, auth, payload/field names, resend semantics) is known. Every caller only ever
// sees {ok, externalCertificateId, verificationUrl, error} so nothing else needs to change.
// ---------------------------------------------------------------------------
function call_certificate_api(array $payload): array {
    $apiUrl = (string)pg_env('CERTIFICATE_API_URL', '');
    if ($apiUrl === '') {
        return [
            'ok' => false,
            'externalCertificateId' => null,
            'verificationUrl' => null,
            'error' => 'Certificate system not configured yet (CERTIFICATE_API_URL unset). '
                . 'Implement the real call in call_certificate_api() in api/certificates.php once the vendor contract is known.',
        ];
    }
    // Real implementation goes here once CERTIFICATE_API_URL/AUTH are known — e.g. a signed HTTP
    // POST of $payload to $apiUrl, mapping its response onto the shape below.
    return ['ok' => false, 'externalCertificateId' => null, 'verificationUrl' => null, 'error' => 'CERTIFICATE_API_URL is set but call_certificate_api() has no implementation yet.'];
}

function fetch_issuance_by_session(PDO $pdo, int $companyId, int $sessionId): ?array {
    $stmt = $pdo->prepare('SELECT * FROM certificate_issuances WHERE company_id = ? AND session_id = ? LIMIT 1');
    $stmt->execute([$companyId, $sessionId]);
    $row = $stmt->fetch();
    $stmt->closeCursor();
    return $row ?: null;
}

function fetch_issuance_by_id(PDO $pdo, int $id): ?array {
    $stmt = $pdo->prepare('SELECT * FROM certificate_issuances WHERE id = ? LIMIT 1');
    $stmt->execute([$id]);
    $row = $stmt->fetch();
    $stmt->closeCursor();
    return $row ?: null;
}

/** Mirrors the $pending computation in api/results.php's regrade handler exactly — a session's
 *  `passed` can be written as a provisional 1/0 by api/sessions.php's complete() action before manual
 *  (SHORT_TEXT/LONG_TEXT/TEXT) answers are graded. Re-checking here (independent of which caller
 *  invoked the trigger) means a certificate is never issued against a score that can still change. */
function session_has_pending_manual_grade(PDO $pdo, int $sessionId): bool {
    $stmt = $pdo->prepare('SELECT q.type, sa.awarded_marks
                           FROM session_answers sa
                           JOIN questions q ON q.id = sa.question_id
                           WHERE sa.session_id = ?');
    $stmt->execute([$sessionId]);
    $rows = $stmt->fetchAll();
    $stmt->closeCursor();
    foreach ($rows as $r) {
        if (is_manual_question_type((string)$r['type']) && $r['awarded_marks'] === null) {
            return true;
        }
    }
    return false;
}

function send_certificate_email(PDO $pdo, array $env, int $companyId, array $issuance, array $student, array $exam): void {
    $email = strtolower(trim((string)($student['email'] ?? '')));
    if ($email === '') {
        return;
    }

    $companyStmt = $pdo->prepare('SELECT name FROM companies WHERE id = ? LIMIT 1');
    $companyStmt->execute([$companyId]);
    $companyName = (string)($companyStmt->fetchColumn() ?: 'ProctorGuard');
    $companyStmt->closeCursor();

    $safeCompanyName = htmlspecialchars($companyName, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
    $safeExamTitle = htmlspecialchars((string)$exam['title'], ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
    $safeFullName = htmlspecialchars((string)($student['full_name'] ?? $email), ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
    $verificationUrl = (string)($issuance['verification_url'] ?? '');
    $safeVerificationUrl = htmlspecialchars($verificationUrl, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');

    $subject = "Your certificate is ready: {$exam['title']}";
    $linkBlock = $verificationUrl !== ''
        ? "<p style=\"margin:0 0 20px;\"><a href=\"{$safeVerificationUrl}\" style=\"display:inline-block;padding:11px 22px;background:#0f172a;color:#ffffff;text-decoration:none;border-radius:8px;font-weight:600;font-size:14px;\">View Certificate</a></p>"
        : '';
    $body = <<<HTML
<!doctype html><html><head><meta charset="utf-8"><title>Your certificate is ready: {$safeExamTitle}</title></head>
<body style="margin:0;padding:24px;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;font-size:14px;line-height:1.6;color:#0f172a;background-color:#f8fafc;">
<div style="max-width:600px;margin:0 auto;background:#ffffff;border-radius:12px;border:1px solid #e2e8f0;padding:32px;">
  <h2 style="margin:0 0 16px;font-size:20px;color:#1e293b;">Congratulations!</h2>
  <p style="margin:0 0 12px;">Hello <strong>{$safeFullName}</strong>,</p>
  <p style="margin:0 0 16px;">You passed <strong>{$safeExamTitle}</strong> and your certificate is ready.</p>
  {$linkBlock}
  <p style="margin:0;color:#64748b;font-size:12px;">This is an automated message from {$safeCompanyName} ProctorGuard.</p>
</div>
</body></html>
HTML;

    $smtpHost = $env['SMTP_HOST'] ?? '';
    $smtpPort = (int)($env['SMTP_PORT'] ?? 0);
    $smtpFrom = $env['SMTP_FROM'] ?? '';
    $status = 'SKIPPED';
    $error = 'SMTP not configured';

    if ($smtpHost !== '' && $smtpPort > 0 && $smtpFrom !== '') {
        $result = smtp_send(
            $smtpHost, $smtpPort, $env['SMTP_USER'] ?? '', $env['SMTP_PASS'] ?? '', $smtpFrom,
            ['to' => $email, 'subject' => $subject, 'body' => $body, 'fromName' => $companyName . ' ProctorGuard'],
            $env['SMTP_SECURE'] ?? '', (int)($env['SMTP_TIMEOUT'] ?? 15), (($env['SMTP_ALLOW_SELF_SIGNED'] ?? '0') === '1')
        );
        $status = $result['ok'] ? 'SENT' : 'FAILED';
        $error = $result['ok'] ? null : ($result['error'] ?? 'Send failed');
    }

    // sp_add_delivery_log is the shared logging path notify.php uses for every send — call the same
    // procedure here instead of a hand-rolled INSERT so delivery_logs stays consistent everywhere.
    // add_delivery_log() is best-effort: a log failure (e.g. a >255-char subject from a long exam
    // title) used to throw into maybe_issue_certificate()'s catch and flip an ISSUED row to FAILED.
    add_delivery_log($pdo, $companyId, 'EMAIL', $email, $subject, $body, $status, $error);

    $upd = $pdo->prepare('UPDATE certificate_issuances SET last_emailed_at = NOW(), email_count = email_count + 1 WHERE id = ?');
    $upd->execute([$issuance['id']]);
    $upd->closeCursor();
}

const CERTIFICATE_MAX_ATTEMPTS = 5;

/** The trigger. Call this after ANY write that could set exam_sessions.passed = 1. Safe to call
 *  repeatedly (idempotent) and safe to call speculatively (no-ops unless the session has actually,
 *  finally passed).
 *
 *  Serialization: this function is reachable concurrently from three independent callers on the same
 *  session — the original submit/regrade request, an admin's Issue Now/Retry click, and
 *  scripts/certificates_worker.php's retry sweep. A MySQL named lock (scoped to the session id)
 *  ensures only one of them is ever inside the check-then-issue-then-email section at a time, so two
 *  callers can never both pass the "not yet issued" check and both call the external API / send the
 *  certificate email.
 *
 *  Truly never throws: any exception is caught, the row (if one exists) is marked FAILED, and the
 *  outcome is returned rather than propagated — a failed external call must never turn an
 *  already-committed exam submission or regrade into a 500.
 *
 *  Returns one of: 'NOT_ELIGIBLE' (not passed / still pending manual grade), 'DISABLED' (the exam's
 *  certificateEnabled toggle is off), 'ALREADY_ISSUED', 'ISSUED', 'FAILED', 'DEAD' (exhausted
 *  retries), 'LOCK_BUSY' (another process is already handling this session right now; safe to try
 *  again shortly). */
function maybe_issue_certificate(PDO $pdo, array $env, int $companyId, int $sessionId): string {
    $sessionStmt = $pdo->prepare('SELECT id, exam_id, student_id, passed FROM exam_sessions WHERE id = ? AND company_id = ? LIMIT 1');
    $sessionStmt->execute([$sessionId, $companyId]);
    $session = $sessionStmt->fetch();
    $sessionStmt->closeCursor();
    if (!$session || (int)($session['passed'] ?? 0) !== 1) {
        return 'NOT_ELIGIBLE';
    }

    // Certification is on-demand only, and only reachable at all when the exam owner has
    // switched it on for this exam (set at exam creation). This gate applies to every caller —
    // the automatic post-submit/regrade hooks AND an admin's manual Issue Now/Retry click — so
    // disabling it for an exam fully blocks issuance, not just the automatic path.
    $examFlagStmt = $pdo->prepare('SELECT certificate_enabled FROM exams WHERE id = ? AND company_id = ? LIMIT 1');
    $examFlagStmt->execute([$session['exam_id'], $companyId]);
    $certificateEnabled = (bool)$examFlagStmt->fetchColumn();
    $examFlagStmt->closeCursor();
    if (!$certificateEnabled) {
        return 'DISABLED';
    }

    if (session_has_pending_manual_grade($pdo, $sessionId)) {
        // Provisional pass from sessions.php's complete() action — not final until the admin's
        // regrade in results.php recomputes with every manual answer graded. That regrade calls this
        // same function again once $pending is false.
        return 'NOT_ELIGIBLE';
    }

    $lockName = 'cert_issue_' . $sessionId;
    $lockStmt = $pdo->prepare('SELECT GET_LOCK(?, 5)');
    $lockStmt->execute([$lockName]);
    $acquired = (bool)$lockStmt->fetchColumn();
    $lockStmt->closeCursor();
    if (!$acquired) {
        return 'LOCK_BUSY';
    }

    $issuanceId = null;
    try {
        $existing = fetch_issuance_by_session($pdo, $companyId, $sessionId);
        if ($existing && $existing['status'] === 'ISSUED') {
            return 'ALREADY_ISSUED';
        }
        if ($existing && $existing['status'] === 'DEAD') {
            return 'DEAD';
        }

        $studentStmt = $pdo->prepare('SELECT id, full_name, email FROM students WHERE id = ? AND company_id = ? LIMIT 1');
        $studentStmt->execute([$session['student_id'], $companyId]);
        $student = $studentStmt->fetch();
        $studentStmt->closeCursor();

        $examStmt = $pdo->prepare('SELECT id, title FROM exams WHERE id = ? AND company_id = ? LIMIT 1');
        $examStmt->execute([$session['exam_id'], $companyId]);
        $exam = $examStmt->fetch();
        $examStmt->closeCursor();
        if (!$student || !$exam) {
            return 'NOT_ELIGIBLE';
        }

        if ($existing) {
            $issuanceId = (int)$existing['id'];
            $verificationId = (string)$existing['verification_id'];
            $attempts = (int)$existing['attempts'];
        } else {
            $verificationId = bin2hex(random_bytes(16));
            $insert = $pdo->prepare('INSERT INTO certificate_issuances (company_id, session_id, student_id, exam_id, verification_id, status)
                                     VALUES (?, ?, ?, ?, ?, "PENDING")');
            $insert->execute([$companyId, $sessionId, $student['id'], $exam['id'], $verificationId]);
            $issuanceId = (int)$pdo->lastInsertId();
            $attempts = 0;
        }

        $payload = [
            'verificationId' => $verificationId,
            'studentName' => $student['full_name'],
            'studentEmail' => $student['email'],
            'examTitle' => $exam['title'],
            'companyId' => $companyId,
        ];
        $result = call_certificate_api($payload);

        if ($result['ok']) {
            $upd = $pdo->prepare("UPDATE certificate_issuances
                                  SET status = 'ISSUED', external_certificate_id = ?, verification_url = ?, error = NULL, issued_at = NOW()
                                  WHERE id = ?");
            $upd->execute([$result['externalCertificateId'], $result['verificationUrl'], $issuanceId]);
            $upd->closeCursor();

            $issuance = fetch_issuance_by_id($pdo, $issuanceId);
            if ($issuance) {
                send_certificate_email($pdo, $env, $companyId, $issuance, $student, $exam);
            }
            $outcome = 'ISSUED';
        } else {
            $attempts++;
            $outcome = $attempts >= CERTIFICATE_MAX_ATTEMPTS ? 'DEAD' : 'FAILED';
            $upd = $pdo->prepare('UPDATE certificate_issuances SET status = ?, error = ?, attempts = ? WHERE id = ?');
            $upd->execute([$outcome, $result['error'], $attempts, $issuanceId]);
            $upd->closeCursor();
        }

        audit_log($pdo, [
            'companyId' => $companyId,
            'actorRole' => 'SYSTEM',
            'actorId' => 'certificates',
            'action' => $result['ok'] ? 'CERTIFICATE_ISSUED' : 'CERTIFICATE_ISSUE_FAILED',
            'targetType' => 'student',
            'targetId' => (string)$student['id'],
            'message' => $result['ok']
                ? "Certificate issued for \"{$exam['title']}\""
                : "Certificate issuance failed for \"{$exam['title']}\": {$result['error']}",
            'metadata' => ['sessionId' => $sessionId, 'examId' => $exam['id'], 'verificationId' => $verificationId, 'attempts' => $attempts],
        ]);

        return $outcome;
    } catch (Throwable $e) {
        if ($issuanceId !== null) {
            try {
                $upd = $pdo->prepare("UPDATE certificate_issuances SET status = 'FAILED', error = ?, attempts = attempts + 1 WHERE id = ?");
                $upd->execute([$e->getMessage(), $issuanceId]);
                $upd->closeCursor();
            } catch (Throwable $ignored) {
                // Best-effort only — the outer catch already prevents this from reaching the caller.
            }
        }
        return 'FAILED';
    } finally {
        $releaseStmt = $pdo->prepare('SELECT RELEASE_LOCK(?)');
        $releaseStmt->execute([$lockName]);
        $releaseStmt->closeCursor();
    }
}

// ---------------------------------------------------------------------------
// Everything below is this file's own HTTP handling. Guarded like notify.php/integrations.php: when
// this file is require()'d for its functions (from sessions.php, results.php, a retry-sweep script),
// $isIncluded is true and none of this runs.
// ---------------------------------------------------------------------------
$isIncluded = (basename($_SERVER['SCRIPT_FILENAME'] ?? '') !== 'certificates.php');
if ($isIncluded) {
    return;
}

$method = $_SERVER['REQUEST_METHOD'];

if ($method === 'GET') {
    require_staff();
    $companyId = require_company_id();
    $status = strtoupper(trim((string)($_GET['status'] ?? '')));

    $sql = "SELECT ci.*, s.full_name AS student_name, s.email AS student_email, e.title AS exam_title
            FROM certificate_issuances ci
            JOIN students s ON s.id = ci.student_id
            JOIN exams e ON e.id = ci.exam_id
            WHERE ci.company_id = ?";
    $params = [$companyId];
    if ($status !== '') {
        $sql .= ' AND ci.status = ?';
        $params[] = $status;
    }
    $sql .= ' ORDER BY ci.created_at DESC LIMIT 200';
    $stmt = $pdo->prepare($sql);
    $stmt->execute($params);
    $rows = $stmt->fetchAll();
    $stmt->closeCursor();

    $issuances = array_map(static function (array $row): array {
        return [
            'id' => (int)$row['id'],
            'sessionId' => (int)$row['session_id'],
            'studentId' => $row['student_id'],
            'studentName' => $row['student_name'],
            'studentEmail' => $row['student_email'],
            'examId' => $row['exam_id'],
            'examTitle' => $row['exam_title'],
            'verificationId' => $row['verification_id'],
            'externalCertificateId' => $row['external_certificate_id'],
            'verificationUrl' => $row['verification_url'],
            'status' => $row['status'],
            'attempts' => (int)$row['attempts'],
            'error' => $row['error'],
            'issuedAt' => $row['issued_at'] ? strtotime((string)$row['issued_at']) * 1000 : null,
            'lastEmailedAt' => $row['last_emailed_at'] ? strtotime((string)$row['last_emailed_at']) * 1000 : null,
            'emailCount' => (int)$row['email_count'],
            'createdAt' => strtotime((string)$row['created_at']) * 1000,
        ];
    }, $rows);
    json_response(['issuances' => $issuances]);
}

if ($method === 'POST') {
    $payload = json_input();
    $action = strtoupper(trim((string)($payload['action'] ?? '')));
    $actorRole = require_role(['ADMIN', 'SUPER_ADMIN'], $payload);
    $companyId = require_company_id($payload);

    if ($action === 'ISSUE_NOW') {
        $sessionId = (int)($payload['sessionId'] ?? 0);
        if ($sessionId <= 0) {
            json_response(['error' => 'sessionId is required.'], 400);
        }
        $outcome = maybe_issue_certificate($pdo, $env, $companyId, $sessionId);
        if ($outcome === 'NOT_ELIGIBLE') {
            json_response(['error' => 'Session has not passed, or is still pending manual grading.'], 409);
        }
        if ($outcome === 'DISABLED') {
            json_response(['error' => 'Certification is not enabled for this exam. Turn it on from the exam\'s Certification setting first.'], 409);
        }
        if ($outcome === 'LOCK_BUSY') {
            json_response(['error' => 'Another process is already handling this session — try again shortly.'], 409);
        }
        $issuance = fetch_issuance_by_session($pdo, $companyId, $sessionId);
        audit_log($pdo, [
            'companyId' => $companyId, 'actorRole' => $actorRole, 'actorId' => get_actor_id($payload),
            'action' => 'CERTIFICATE_ISSUE_NOW', 'targetType' => 'certificate_issuance', 'targetId' => (string)($issuance['id'] ?? ''),
            'message' => "Manually triggered certificate issuance for session {$sessionId}",
        ]);
        json_response(['ok' => true, 'status' => $outcome]);
    }

    if ($action === 'RETRY') {
        $id = (int)($payload['id'] ?? 0);
        $issuance = $id > 0 ? fetch_issuance_by_id($pdo, $id) : null;
        if (!$issuance || (int)$issuance['company_id'] !== $companyId) {
            json_response(['error' => 'Issuance not found.'], 404);
        }
        $outcome = maybe_issue_certificate($pdo, $env, $companyId, (int)$issuance['session_id']);

        audit_log($pdo, [
            'companyId' => $companyId, 'actorRole' => $actorRole, 'actorId' => get_actor_id($payload),
            'action' => 'CERTIFICATE_RETRY', 'targetType' => 'certificate_issuance', 'targetId' => (string)$id,
            'message' => "Manually retried certificate issuance {$id} -> {$outcome}",
        ]);
        json_response(['ok' => true, 'status' => $outcome]);
    }

    if ($action === 'RESEND') {
        $id = (int)($payload['id'] ?? 0);
        $issuance = $id > 0 ? fetch_issuance_by_id($pdo, $id) : null;
        if (!$issuance || (int)$issuance['company_id'] !== $companyId) {
            json_response(['error' => 'Issuance not found.'], 404);
        }
        if ($issuance['status'] !== 'ISSUED') {
            json_response(['error' => 'Certificate has not been issued yet.'], 409);
        }

        $studentStmt = $pdo->prepare('SELECT id, full_name, email FROM students WHERE id = ? AND company_id = ? LIMIT 1');
        $studentStmt->execute([$issuance['student_id'], $companyId]);
        $student = $studentStmt->fetch();
        $studentStmt->closeCursor();

        $examStmt = $pdo->prepare('SELECT id, title FROM exams WHERE id = ? AND company_id = ? LIMIT 1');
        $examStmt->execute([$issuance['exam_id'], $companyId]);
        $exam = $examStmt->fetch();
        $examStmt->closeCursor();

        if (!$student || !$exam) {
            json_response(['error' => 'Student or exam no longer exists.'], 404);
        }
        send_certificate_email($pdo, $env, $companyId, $issuance, $student, $exam);

        audit_log($pdo, [
            'companyId' => $companyId, 'actorRole' => $actorRole, 'actorId' => get_actor_id($payload),
            'action' => 'CERTIFICATE_RESEND', 'targetType' => 'certificate_issuance', 'targetId' => (string)$id,
            'message' => "Resent certificate email for issuance {$id}",
        ]);
        json_response(['ok' => true]);
    }

    json_response(['error' => 'Unknown action.'], 400);
}

json_response(['error' => 'Method not allowed.'], 405);
