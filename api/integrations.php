<?php
declare(strict_types=1);

// require_once (not require): this file is itself require()'d by scripts/integrations_worker.php,
// which loads _bootstrap.php first — a plain require here would re-execute it and fatal on redeclared
// functions.
require_once __DIR__ . '/_bootstrap.php';
// Reused for smtp_send()/smtp_open()/smtp_deliver(): the $isIncluded guard inside notify.php means
// requiring it from here only defines those functions — it does not run notify.php's own HTTP handler.
require_once __DIR__ . '/notify.php';

/**
 * V1 automation, Phase 1 (Ingest & Schedule): a generic, per-tenant signed webhook connector that
 * turns a course-COMPLETION event from an external course/LMS platform into an auto-provisioned
 * candidate + auto-assigned + auto-invited exam, with zero human intervention on the happy path.
 * See docs/ProctorGuard_V1_Requirements.md. Certificate issuance, the ops dashboard and the
 * n8n-style workflow engine are later phases and are out of scope here.
 */

function ensure_integrations_schema(PDO $pdo): void {
    $pdo->exec("CREATE TABLE IF NOT EXISTS integration_connectors (
        id             VARCHAR(64) PRIMARY KEY,
        company_id     INT NOT NULL,
        name           VARCHAR(255) NOT NULL,
        webhook_secret VARCHAR(128) NOT NULL,
        field_map_json TEXT NULL,
        status         ENUM('ACTIVE','DISABLED') NOT NULL DEFAULT 'ACTIVE',
        created_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_integration_connectors_company (company_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");

    $pdo->exec("CREATE TABLE IF NOT EXISTS integration_events (
        id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        company_id        INT NOT NULL,
        connector_id      VARCHAR(64) NOT NULL,
        external_event_id VARCHAR(255) NOT NULL,
        event_type        VARCHAR(64) NULL,
        payload_json      LONGTEXT NULL,
        status            ENUM('RECEIVED','PROCESSED','FAILED','DEAD','UNMAPPED','SKIPPED_GATE') NOT NULL DEFAULT 'RECEIVED',
        attempts          INT NOT NULL DEFAULT 0,
        error             TEXT NULL,
        received_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        processed_at      TIMESTAMP NULL DEFAULT NULL,
        UNIQUE KEY uq_integration_events_dedupe (connector_id, external_event_id),
        INDEX idx_integration_events_company (company_id),
        INDEX idx_integration_events_status (status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");

    $pdo->exec("CREATE TABLE IF NOT EXISTS course_exam_mappings (
        id                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        company_id         INT NOT NULL,
        connector_id       VARCHAR(64) NOT NULL,
        external_course_id VARCHAR(255) NOT NULL,
        exam_id            VARCHAR(64) NOT NULL,
        batch_id           BIGINT UNSIGNED NULL,
        active             TINYINT(1) NOT NULL DEFAULT 1,
        created_at         TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uq_course_exam_mappings (connector_id, external_course_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");

    $pdo->exec("CREATE TABLE IF NOT EXISTS candidate_external_links (
        student_id          VARCHAR(64) NOT NULL,
        connector_id        VARCHAR(64) NOT NULL,
        external_learner_id VARCHAR(255) NOT NULL,
        external_email      VARCHAR(255) NULL,
        linked_at           TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (connector_id, external_learner_id),
        INDEX idx_candidate_external_links_student (student_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
}

ensure_integrations_schema($pdo);
ensure_student_batches_schema($pdo);

// ---------------------------------------------------------------------------
// Field mapping: lets an admin point a generic connector at whatever JSON shape
// the source platform actually sends, via dot-path keys into the payload.
// ---------------------------------------------------------------------------

function default_field_map(): array {
    return [
        'externalEventId' => 'eventId',
        'eventType' => 'eventType',
        'courseId' => 'courseId',
        'learnerId' => 'learner.id',
        'email' => 'learner.email',
        'fullName' => 'learner.name',
    ];
}

function array_get_path(array $data, string $path) {
    $cur = $data;
    foreach (explode('.', $path) as $part) {
        if (!is_array($cur) || !array_key_exists($part, $cur)) {
            return null;
        }
        $cur = $cur[$part];
    }
    return $cur;
}

function connector_field_map(array $connector): array {
    $decoded = json_decode((string)($connector['field_map_json'] ?? ''), true);
    // Only string dot-paths are usable; a null/number/array value stored via the API would otherwise
    // be passed to array_get_path(string $path) and TypeError the webhook (strict_types).
    $custom = is_array($decoded) ? array_filter($decoded, 'is_string') : [];
    return array_merge(default_field_map(), $custom);
}

/** A mapped payload field as a trimmed string. An object/array at that path (malformed or unexpected
 *  sender payload) yields '' instead of an "Array to string conversion" error, which used to 500 the
 *  webhook and leave the event stuck outside the retry sweep. */
function payload_field_string(array $payload, string $path): string {
    $value = array_get_path($payload, $path);
    return is_scalar($value) ? trim((string)$value) : '';
}

// ---------------------------------------------------------------------------
// Pipeline: candidate upsert, exam assignment, invitation send.
// ---------------------------------------------------------------------------

function fetch_event_by_id(PDO $pdo, int $id): ?array {
    $stmt = $pdo->prepare('SELECT * FROM integration_events WHERE id = ? LIMIT 1');
    $stmt->execute([$id]);
    $row = $stmt->fetch();
    $stmt->closeCursor();
    return $row ?: null;
}

function fetch_active_mapping(PDO $pdo, int $companyId, string $connectorId, string $courseId): ?array {
    $stmt = $pdo->prepare('SELECT * FROM course_exam_mappings
                           WHERE company_id = ? AND connector_id = ? AND external_course_id = ? AND active = 1
                           LIMIT 1');
    $stmt->execute([$companyId, $connectorId, $courseId]);
    $row = $stmt->fetch();
    $stmt->closeCursor();
    return $row ?: null;
}

function mark_event(PDO $pdo, int $eventId, string $status, ?string $error): void {
    $stmt = $pdo->prepare('UPDATE integration_events SET status = ?, error = ?, processed_at = NOW() WHERE id = ?');
    $stmt->execute([$status, $error, $eventId]);
    $stmt->closeCursor();
}

function mark_event_failed(PDO $pdo, array $event, string $error): void {
    $attempts = (int)$event['attempts'] + 1;
    $status = $attempts >= 5 ? 'DEAD' : 'FAILED';
    $stmt = $pdo->prepare('UPDATE integration_events SET status = ?, error = ?, attempts = ?, processed_at = NOW() WHERE id = ?');
    $stmt->execute([$status, $error, $attempts, $event['id']]);
    $stmt->closeCursor();
}

/** Mirrors the match-by-registration_id-or-email upsert in students.php so this stays consistent
 *  with how the admin console creates/updates students. Registration id is never overwritten on an
 *  existing match — a webhook must not clobber an identity a human already set up. */
function upsert_integration_candidate(PDO $pdo, int $companyId, string $fullName, string $email, string $registrationId, ?int $batchId): string {
    $email = strtolower(trim($email));
    $fullName = trim($fullName);

    // Match on email only when the event actually carried one. A learnerId-only event has email ''
    // and "OR email = ''" matched the FIRST email-less learner's row, merging a different person
    // into that student record (and renaming it).
    if ($email !== '') {
        $existingStmt = $pdo->prepare("SELECT id FROM students
                                       WHERE company_id = ? AND (registration_id = ? OR email = ?)
                                       ORDER BY CASE WHEN registration_id = ? THEN 0 ELSE 1 END
                                       LIMIT 1");
        $existingStmt->execute([$companyId, $registrationId, $email, $registrationId]);
    } else {
        $existingStmt = $pdo->prepare('SELECT id FROM students WHERE company_id = ? AND registration_id = ? LIMIT 1');
        $existingStmt->execute([$companyId, $registrationId]);
    }
    $existing = $existingStmt->fetch();
    $existingStmt->closeCursor();

    if ($existing) {
        $studentId = (string)$existing['id'];
        // Only overwrite what the event actually supplied — an event without a name or email must
        // not blank the email or replace a human-entered name with the email address.
        $sets = [];
        $params = [];
        if ($fullName !== '') {
            $sets[] = 'full_name = ?';
            $params[] = $fullName;
        }
        if ($email !== '') {
            $sets[] = 'email = ?';
            $params[] = $email;
        }
        if ($sets !== []) {
            $params[] = $studentId;
            $params[] = $companyId;
            $update = $pdo->prepare('UPDATE students SET ' . implode(', ', $sets) . ' WHERE id = ? AND company_id = ?');
            $update->execute($params);
            $update->closeCursor();
        }
        if ($batchId !== null) {
            add_student_batch($pdo, $studentId, $batchId);
        }
        return $studentId;
    }

    $fullName = $fullName !== '' ? $fullName : $email;
    $studentId = 'ext_' . bin2hex(random_bytes(8));
    $insert = $pdo->prepare('INSERT INTO students (id, company_id, full_name, email, registration_id) VALUES (?, ?, ?, ?, ?)');
    $insert->execute([$studentId, $companyId, $fullName, $email, $registrationId]);
    $insert->closeCursor();
    if ($batchId !== null) {
        add_student_batch($pdo, $studentId, $batchId);
    }
    return $studentId;
}

function link_candidate_external(PDO $pdo, string $connectorId, string $externalLearnerId, ?string $externalEmail, string $studentId): void {
    if ($externalLearnerId === '') {
        return;
    }
    $stmt = $pdo->prepare('INSERT INTO candidate_external_links (student_id, connector_id, external_learner_id, external_email)
                           VALUES (?, ?, ?, ?)
                           ON DUPLICATE KEY UPDATE student_id = VALUES(student_id), external_email = VALUES(external_email)');
    $stmt->execute([$studentId, $connectorId, $externalLearnerId, $externalEmail]);
    $stmt->closeCursor();
}

function assign_exam_to_student(PDO $pdo, string $examId, string $studentId): void {
    $stmt = $pdo->prepare('INSERT IGNORE INTO exam_assignments (exam_id, student_id) VALUES (?, ?)');
    $stmt->execute([$examId, $studentId]);
    $stmt->closeCursor();
}

/** Best-effort: reuses the same mint_exam_access_token()/smtp_send() path the admin console's manual
 *  "send invitations" action uses, but server-side and inline instead of a client-driven round trip.
 *  Idempotent via exam_invitations — a duplicate/retried event never re-mails the candidate.
 *
 *  Locked (scoped to exam+student) because this is reachable concurrently from the original webhook
 *  request, the retry sweep, and an admin's manual RETRY_EVENT click — without the lock, two callers
 *  could both pass the "already sent?" check before either's INSERT IGNORE lands, sending the
 *  candidate two invitation emails for one event. */
function send_exam_invitation(PDO $pdo, array $env, int $companyId, array $exam, string $studentId, string $email, string $fullName): void {
    if ($email === '') {
        return;
    }

    $lockName = 'exam_invite_' . $exam['id'] . '_' . $studentId;
    $lockStmt = $pdo->prepare('SELECT GET_LOCK(?, 5)');
    $lockStmt->execute([$lockName]);
    $acquired = (bool)$lockStmt->fetchColumn();
    $lockStmt->closeCursor();
    if (!$acquired) {
        // Another process is already sending this exact invitation right now — let it finish rather
        // than risk a duplicate send.
        return;
    }

    try {
        send_exam_invitation_locked($pdo, $env, $companyId, $exam, $studentId, $email, $fullName);
    } finally {
        $releaseStmt = $pdo->prepare('SELECT RELEASE_LOCK(?)');
        $releaseStmt->execute([$lockName]);
        $releaseStmt->closeCursor();
    }
}

function send_exam_invitation_locked(PDO $pdo, array $env, int $companyId, array $exam, string $studentId, string $email, string $fullName): void {
    $already = $pdo->prepare('SELECT 1 FROM exam_invitations WHERE exam_id = ? AND student_id = ? LIMIT 1');
    $already->execute([$exam['id'], $studentId]);
    $sent = (bool)$already->fetchColumn();
    $already->closeCursor();
    if ($sent) {
        return;
    }

    $companyStmt = $pdo->prepare('SELECT name FROM companies WHERE id = ? LIMIT 1');
    $companyStmt->execute([$companyId]);
    $companyName = (string)($companyStmt->fetchColumn() ?: 'ProctorGuard');
    $companyStmt->closeCursor();

    $token = mint_exam_access_token((string)$exam['id'], $studentId, $companyId);
    $origin = rtrim((string)pg_env('APP_ORIGIN', 'https://proctor.lsc-crm.in'), '/');
    $link = $origin . '/?token=' . $token;

    $safeCompanyName = htmlspecialchars($companyName, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
    $safeExamTitle = htmlspecialchars((string)$exam['title'], ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
    $safeFullName = htmlspecialchars($fullName !== '' ? $fullName : $email, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
    $safeLink = htmlspecialchars($link, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');

    $subject = "Your exam is ready: {$exam['title']}";
    $body = <<<HTML
<!doctype html><html><head><meta charset="utf-8"><title>Your exam is ready: {$safeExamTitle}</title></head>
<body style="margin:0;padding:24px;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;font-size:14px;line-height:1.6;color:#0f172a;background-color:#f8fafc;">
<div style="max-width:600px;margin:0 auto;background:#ffffff;border-radius:12px;border:1px solid #e2e8f0;padding:32px;">
  <h2 style="margin:0 0 16px;font-size:20px;color:#1e293b;">Your exam is ready</h2>
  <p style="margin:0 0 12px;">Hello <strong>{$safeFullName}</strong>,</p>
  <p style="margin:0 0 16px;">You've completed the linked course, and your final exam <strong>{$safeExamTitle}</strong> has been scheduled automatically.</p>
  <p style="margin:0 0 20px;"><a href="{$safeLink}" style="display:inline-block;padding:11px 22px;background:#0f172a;color:#ffffff;text-decoration:none;border-radius:8px;font-weight:600;font-size:14px;">Start Exam</a></p>
  <p style="margin:0;color:#64748b;font-size:12px;">This is an automated message from {$safeCompanyName} ProctorGuard.</p>
</div>
</body></html>
HTML;

    $smtpHost = $env['SMTP_HOST'] ?? '';
    $smtpPort = (int)($env['SMTP_PORT'] ?? 0);
    $smtpFrom = $env['SMTP_FROM'] ?? '';

    if ($smtpHost === '' || $smtpPort <= 0 || $smtpFrom === '') {
        // Not configured on this environment: log SKIPPED (not FAILED — nothing to retry) and still
        // mark the invitation as sent so a later retry doesn't loop on an environment that will never
        // have SMTP configured.
        add_delivery_log($pdo, $companyId, 'EMAIL', $email, $subject, $body, 'SKIPPED', 'SMTP not configured');
    } else {
        $result = smtp_send(
            $smtpHost,
            $smtpPort,
            $env['SMTP_USER'] ?? '',
            $env['SMTP_PASS'] ?? '',
            $smtpFrom,
            ['to' => $email, 'subject' => $subject, 'body' => $body, 'fromName' => $companyName . ' ProctorGuard'],
            $env['SMTP_SECURE'] ?? '',
            (int)($env['SMTP_TIMEOUT'] ?? 15),
            (($env['SMTP_ALLOW_SELF_SIGNED'] ?? '0') === '1')
        );
        // sp_add_delivery_log is the shared logging path notify.php uses for every send — call the
        // same procedure here instead of a hand-rolled INSERT so delivery_logs stays consistent.
        add_delivery_log($pdo, $companyId, 'EMAIL', $email, $subject, $body, $result['ok'] ? 'SENT' : 'FAILED', $result['ok'] ? null : ($result['error'] ?? 'Send failed'));
        if (!$result['ok']) {
            // Do NOT record exam_invitations for a failed send: that row is the "already mailed"
            // idempotency marker, so writing it here meant every retry skipped the candidate and the
            // event was marked PROCESSED — the invitation was silently lost for good. Throwing lands
            // the event in FAILED (see process_integration_event) so the retry sweep re-sends it.
            throw new RuntimeException((string)($result['error'] ?? 'Send failed'));
        }
    }

    $inv = $pdo->prepare('INSERT IGNORE INTO exam_invitations (exam_id, student_id) VALUES (?, ?)');
    $inv->execute([$exam['id'], $studentId]);
    $inv->closeCursor();
}

/** The whole enroll->exam pipeline for one stored event. Never throws — failures are captured on the
 *  event row so the admin dashboard/retry sweep can act on them instead of a 500 reaching the sender. */
function process_integration_event(PDO $pdo, array $env, array $event): void {
    $companyId = (int)$event['company_id'];

    $connStmt = $pdo->prepare('SELECT * FROM integration_connectors WHERE id = ? LIMIT 1');
    $connStmt->execute([$event['connector_id']]);
    $connector = $connStmt->fetch();
    $connStmt->closeCursor();
    if (!$connector) {
        mark_event($pdo, (int)$event['id'], 'FAILED', 'Connector no longer exists.');
        return;
    }

    $map = connector_field_map($connector);
    $payload = json_decode((string)$event['payload_json'], true);
    $payload = is_array($payload) ? $payload : [];

    $eventType = strtolower(payload_field_string($payload, $map['eventType']));
    if ($eventType !== 'completed') {
        // Phase 1 gate is ON_COMPLETE only (per product decision) — enrollment-only events are a
        // deliberate no-op, not an error.
        mark_event($pdo, (int)$event['id'], 'SKIPPED_GATE', null);
        return;
    }

    $courseId = payload_field_string($payload, $map['courseId']);
    $learnerId = payload_field_string($payload, $map['learnerId']);
    $email = strtolower(payload_field_string($payload, $map['email']));
    $fullName = payload_field_string($payload, $map['fullName']);

    if ($courseId === '' || ($email === '' && $learnerId === '')) {
        mark_event($pdo, (int)$event['id'], 'FAILED', 'Payload is missing courseId or a learner identity (email/learnerId).');
        return;
    }

    $mapping = fetch_active_mapping($pdo, $companyId, (string)$event['connector_id'], $courseId);
    if (!$mapping) {
        // Never silently dropped: surfaced on the Integrations screen for an admin to map.
        mark_event($pdo, (int)$event['id'], 'UNMAPPED', "No active course_exam_mapping for course \"{$courseId}\".");
        return;
    }

    // Deterministic per (connector, learner) so re-processing the same learner always lands on the
    // same registration id instead of minting a new one each retry.
    $registrationId = 'EXT-' . strtoupper(substr(sha1($event['connector_id'] . '|' . ($learnerId !== '' ? $learnerId : $email)), 0, 12));
    $batchId = $mapping['batch_id'] !== null ? (int)$mapping['batch_id'] : null;

    try {
        $pdo->beginTransaction();
        $studentId = upsert_integration_candidate($pdo, $companyId, $fullName, $email, $registrationId, $batchId);
        link_candidate_external($pdo, (string)$event['connector_id'], $learnerId !== '' ? $learnerId : $email, $email !== '' ? $email : null, $studentId);

        $examStmt = $pdo->prepare('SELECT id, title FROM exams WHERE id = ? AND company_id = ? LIMIT 1');
        $examStmt->execute([$mapping['exam_id'], $companyId]);
        $exam = $examStmt->fetch();
        $examStmt->closeCursor();
        if (!$exam) {
            throw new RuntimeException("Mapped exam \"{$mapping['exam_id']}\" not found in this company.");
        }

        assign_exam_to_student($pdo, (string)$exam['id'], $studentId);
        $pdo->commit();
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) {
            $pdo->rollBack();
        }
        mark_event_failed($pdo, $event, $e->getMessage());
        return;
    }

    // Invitation delivery is best-effort and intentionally outside the DB transaction above — an SMTP
    // hiccup must not roll back a candidate/assignment that already succeeded. Guarded by its own
    // try/catch so a transient failure here lands the event in FAILED (visible to the retry sweep)
    // instead of throwing past this function and 500-ing the webhook sender, contradicting the
    // "never throws" contract above.
    try {
        send_exam_invitation($pdo, $env, $companyId, $exam, $studentId, $email, $fullName);

        mark_event($pdo, (int)$event['id'], 'PROCESSED', null);
        audit_log($pdo, [
            'companyId' => $companyId,
            'actorRole' => 'SYSTEM',
            'actorId' => 'connector:' . $event['connector_id'],
            'action' => 'INTEGRATION_EVENT_PROCESSED',
            'targetType' => 'student',
            'targetId' => $studentId,
            'message' => "Auto-scheduled exam \"{$exam['title']}\" for {$email} via connector {$connector['name']}",
            'metadata' => ['examId' => $exam['id'], 'courseId' => $courseId, 'eventId' => $event['id']],
        ]);
    } catch (Throwable $e) {
        mark_event_failed($pdo, $event, 'Candidate provisioned and exam assigned, but invitation delivery failed: ' . $e->getMessage());
    }
}

// ---------------------------------------------------------------------------
// Everything below this point is this file's own HTTP request handling (webhook receiver + admin
// CRUD dispatch). Guarded the same way notify.php guards its SMTP-sending block: when this file is
// require()'d for its functions (process_integration_event(), fetch_event_by_id(), ...) — e.g. from
// scripts/integrations_worker.php — $isIncluded is true and none of this runs.
// ---------------------------------------------------------------------------
$isIncluded = (basename($_SERVER['SCRIPT_FILENAME'] ?? '') !== 'integrations.php');

if ($isIncluded) {
    return;
}

// ---------------------------------------------------------------------------
// Inbound webhook receiver — no staff auth; a per-connector secret gates it instead.
// ---------------------------------------------------------------------------

function handle_inbound_webhook(PDO $pdo, array $env, string $connectorId): void {
    if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
        json_response(['error' => 'Method not allowed.'], 405);
    }

    $secret = trim((string)($_SERVER['HTTP_X_WEBHOOK_SECRET'] ?? ''));
    $connStmt = $pdo->prepare('SELECT * FROM integration_connectors WHERE id = ? LIMIT 1');
    $connStmt->execute([$connectorId]);
    $connector = $connStmt->fetch();
    $connStmt->closeCursor();

    // Same generic response whether the connector id is unknown, disabled, or the secret is wrong —
    // this must not help an outside caller enumerate valid connector ids.
    if (!$connector || $connector['status'] !== 'ACTIVE' || $secret === '' || !hash_equals((string)$connector['webhook_secret'], $secret)) {
        json_response(['error' => 'Unauthorized.'], 401);
    }

    $raw = (string)file_get_contents('php://input');
    $payload = json_decode($raw, true);
    if (!is_array($payload)) {
        json_response(['error' => 'Invalid JSON payload.'], 400);
    }

    $map = connector_field_map($connector);
    $externalEventId = payload_field_string($payload, $map['externalEventId']);
    if ($externalEventId === '') {
        // No idempotency key supplied: fall back to a content hash so at least an identical redelivery
        // still dedupes, per the Stripe/GitHub-webhook pattern the PRD calls out.
        $externalEventId = sha1($raw);
    } elseif (strlen($externalEventId) > 255) {
        // Column is VARCHAR(255): an over-long id failed the INSERT, fell into the duplicate branch
        // below, found no row and 500'd. Hash it so it still dedupes deterministically.
        $externalEventId = sha1($externalEventId);
    }
    // event_type is VARCHAR(64) and informational only.
    $eventType = mb_substr(payload_field_string($payload, $map['eventType']), 0, 64, 'UTF-8');
    $companyId = (int)$connector['company_id'];

    try {
        $insert = $pdo->prepare('INSERT INTO integration_events (company_id, connector_id, external_event_id, event_type, payload_json, status)
                                 VALUES (?, ?, ?, ?, ?, "RECEIVED")');
        $insert->execute([$companyId, $connectorId, $externalEventId, $eventType, json_encode($payload)]);
        $eventId = (int)$pdo->lastInsertId();
    } catch (Throwable $e) {
        // Unique-key collision = a redelivered/duplicate webhook (at-least-once delivery). Reuse the
        // existing event row rather than creating a second one.
        $existing = $pdo->prepare('SELECT id, status FROM integration_events WHERE connector_id = ? AND external_event_id = ? LIMIT 1');
        $existing->execute([$connectorId, $externalEventId]);
        $row = $existing->fetch();
        $existing->closeCursor();
        if (!$row) {
            json_response(['error' => 'Failed to record event.'], 500);
        }
        if (in_array($row['status'], ['PROCESSED', 'SKIPPED_GATE', 'DEAD'], true)) {
            json_response(['ok' => true, 'duplicate' => true]);
        }
        $eventId = (int)$row['id'];
    }

    $event = fetch_event_by_id($pdo, $eventId);
    if ($event) {
        process_integration_event($pdo, $env, $event);
    }

    // Always 200 fast-ack the sender regardless of processing outcome — failures live on the event
    // row for the dashboard/retry sweep, not as an HTTP error that makes the sender retry-storm us.
    json_response(['ok' => true]);
}

if (isset($_GET['connector']) && trim((string)$_GET['connector']) !== '') {
    handle_inbound_webhook($pdo, $env, trim((string)$_GET['connector']));
}

// ---------------------------------------------------------------------------
// Admin CRUD + listings (connectors, mappings, event log).
// ---------------------------------------------------------------------------

function connector_public(array $row): array {
    $secret = (string)$row['webhook_secret'];
    return [
        'id' => $row['id'],
        'name' => $row['name'],
        'status' => $row['status'],
        'secretMasked' => str_repeat('•', max(0, strlen($secret) - 4)) . substr($secret, -4),
        'fieldMap' => connector_field_map($row),
        'createdAt' => strtotime((string)$row['created_at']) * 1000,
    ];
}

$method = $_SERVER['REQUEST_METHOD'];

if ($method === 'GET') {
    require_staff();
    $companyId = require_company_id();
    $action = strtolower(trim((string)($_GET['action'] ?? 'connectors')));

    if ($action === 'events') {
        $status = strtoupper(trim((string)($_GET['status'] ?? '')));
        $connectorId = trim((string)($_GET['connectorId'] ?? ''));
        $sql = 'SELECT * FROM integration_events WHERE company_id = ?';
        $params = [$companyId];
        if ($status !== '') {
            $sql .= ' AND status = ?';
            $params[] = $status;
        }
        if ($connectorId !== '') {
            $sql .= ' AND connector_id = ?';
            $params[] = $connectorId;
        }
        $sql .= ' ORDER BY received_at DESC LIMIT 200';
        $stmt = $pdo->prepare($sql);
        $stmt->execute($params);
        $rows = $stmt->fetchAll();
        $stmt->closeCursor();

        $events = array_map(static function (array $row): array {
            return [
                'id' => (int)$row['id'],
                'connectorId' => $row['connector_id'],
                'eventType' => $row['event_type'],
                'status' => $row['status'],
                'attempts' => (int)$row['attempts'],
                'error' => $row['error'],
                'payload' => json_decode((string)$row['payload_json'], true),
                'receivedAt' => strtotime((string)$row['received_at']) * 1000,
                'processedAt' => $row['processed_at'] ? strtotime((string)$row['processed_at']) * 1000 : null,
            ];
        }, $rows);
        json_response(['events' => $events]);
    }

    if ($action === 'mappings') {
        $stmt = $pdo->prepare('SELECT m.*, e.title AS exam_title, b.name AS batch_name
                               FROM course_exam_mappings m
                               LEFT JOIN exams e ON e.id = m.exam_id
                               LEFT JOIN batches b ON b.id = m.batch_id
                               WHERE m.company_id = ?
                               ORDER BY m.created_at DESC');
        $stmt->execute([$companyId]);
        $rows = $stmt->fetchAll();
        $stmt->closeCursor();

        $mappings = array_map(static function (array $row): array {
            return [
                'id' => (int)$row['id'],
                'connectorId' => $row['connector_id'],
                'externalCourseId' => $row['external_course_id'],
                'examId' => $row['exam_id'],
                'examTitle' => $row['exam_title'],
                'batchId' => $row['batch_id'] !== null ? (int)$row['batch_id'] : null,
                'batchName' => $row['batch_name'],
                'active' => (bool)$row['active'],
            ];
        }, $rows);
        json_response(['mappings' => $mappings]);
    }

    // Default: connectors list.
    $stmt = $pdo->prepare('SELECT * FROM integration_connectors WHERE company_id = ? ORDER BY created_at DESC');
    $stmt->execute([$companyId]);
    $rows = $stmt->fetchAll();
    $stmt->closeCursor();
    json_response(['connectors' => array_map('connector_public', $rows)]);
}

if ($method === 'POST') {
    $payload = json_input();
    $action = strtoupper(trim((string)($payload['action'] ?? '')));
    $actorRole = require_role(['ADMIN', 'SUPER_ADMIN'], $payload);
    $companyId = require_company_id($payload);

    if ($action === 'CREATE_CONNECTOR') {
        $name = trim((string)($payload['name'] ?? ''));
        if ($name === '') {
            json_response(['error' => 'name is required.'], 400);
        }
        $id = 'conn_' . bin2hex(random_bytes(8));
        $secret = base64url_encode(random_bytes(24));
        $fieldMap = is_array($payload['fieldMap'] ?? null) ? $payload['fieldMap'] : [];

        $stmt = $pdo->prepare('INSERT INTO integration_connectors (id, company_id, name, webhook_secret, field_map_json, status) VALUES (?, ?, ?, ?, ?, "ACTIVE")');
        $stmt->execute([$id, $companyId, $name, $secret, json_encode($fieldMap)]);
        $stmt->closeCursor();

        audit_log($pdo, [
            'companyId' => $companyId, 'actorRole' => $actorRole, 'actorId' => get_actor_id($payload),
            'action' => 'INTEGRATION_CONNECTOR_CREATE', 'targetType' => 'connector', 'targetId' => $id,
            'message' => "Connector created: {$name}",
        ]);

        // The raw secret is returned ONLY on creation — every later GET returns it masked.
        json_response(['ok' => true, 'connector' => connector_public(['id' => $id, 'name' => $name, 'webhook_secret' => $secret, 'field_map_json' => json_encode($fieldMap), 'status' => 'ACTIVE', 'created_at' => date('Y-m-d H:i:s')]), 'webhookSecret' => $secret]);
    }

    if ($action === 'UPDATE_CONNECTOR') {
        $id = trim((string)($payload['id'] ?? ''));
        if ($id === '') {
            json_response(['error' => 'id is required.'], 400);
        }
        $name = trim((string)($payload['name'] ?? ''));
        $fieldMap = is_array($payload['fieldMap'] ?? null) ? $payload['fieldMap'] : null;

        // Status is only touched when the caller actually sends one. It used to default to ACTIVE,
        // so saving a field map (Integrations.tsx sends only {id, fieldMap}) silently re-enabled a
        // connector an admin had deliberately disabled.
        $sets = [];
        $params = [];
        if (array_key_exists('status', $payload) && $payload['status'] !== null) {
            $status = strtoupper(trim((string)$payload['status']));
            if (!in_array($status, ['ACTIVE', 'DISABLED'], true)) {
                json_response(['error' => 'status must be ACTIVE or DISABLED.'], 400);
            }
            $sets[] = 'status = ?';
            $params[] = $status;
        }
        if ($name !== '') {
            $sets[] = 'name = ?';
            $params[] = $name;
        }
        if ($fieldMap !== null) {
            $sets[] = 'field_map_json = ?';
            $params[] = json_encode($fieldMap);
        }
        if ($sets !== []) {
            $params[] = $id;
            $params[] = $companyId;
            $stmt = $pdo->prepare('UPDATE integration_connectors SET ' . implode(', ', $sets) . ' WHERE id = ? AND company_id = ?');
            $stmt->execute($params);
            $stmt->closeCursor();
        }

        audit_log($pdo, [
            'companyId' => $companyId, 'actorRole' => $actorRole, 'actorId' => get_actor_id($payload),
            'action' => 'INTEGRATION_CONNECTOR_UPDATE', 'targetType' => 'connector', 'targetId' => $id,
            'message' => "Connector updated: {$id}",
        ]);
        json_response(['ok' => true]);
    }

    if ($action === 'ROTATE_SECRET') {
        $id = trim((string)($payload['id'] ?? ''));
        if ($id === '') {
            json_response(['error' => 'id is required.'], 400);
        }
        $secret = base64url_encode(random_bytes(24));
        $stmt = $pdo->prepare('UPDATE integration_connectors SET webhook_secret = ? WHERE id = ? AND company_id = ?');
        $stmt->execute([$secret, $id, $companyId]);
        $stmt->closeCursor();

        audit_log($pdo, [
            'companyId' => $companyId, 'actorRole' => $actorRole, 'actorId' => get_actor_id($payload),
            'action' => 'INTEGRATION_CONNECTOR_ROTATE_SECRET', 'targetType' => 'connector', 'targetId' => $id,
            'message' => "Connector secret rotated: {$id}",
        ]);
        json_response(['ok' => true, 'webhookSecret' => $secret]);
    }

    if ($action === 'DELETE_CONNECTOR') {
        $id = trim((string)($payload['id'] ?? ''));
        if ($id === '') {
            json_response(['error' => 'id is required.'], 400);
        }
        $stmt = $pdo->prepare('DELETE FROM integration_connectors WHERE id = ? AND company_id = ?');
        $stmt->execute([$id, $companyId]);
        $stmt->closeCursor();

        audit_log($pdo, [
            'companyId' => $companyId, 'actorRole' => $actorRole, 'actorId' => get_actor_id($payload),
            'action' => 'INTEGRATION_CONNECTOR_DELETE', 'targetType' => 'connector', 'targetId' => $id,
            'message' => "Connector deleted: {$id}",
        ]);
        json_response(['ok' => true]);
    }

    if ($action === 'CREATE_MAPPING' || $action === 'UPDATE_MAPPING') {
        $connectorId = trim((string)($payload['connectorId'] ?? ''));
        $externalCourseId = trim((string)($payload['externalCourseId'] ?? ''));
        $examId = trim((string)($payload['examId'] ?? ''));
        $batchId = isset($payload['batchId']) && $payload['batchId'] !== null && $payload['batchId'] !== '' ? (int)$payload['batchId'] : null;
        $active = array_key_exists('active', $payload) ? (bool)$payload['active'] : true;

        if ($connectorId === '' || $externalCourseId === '' || $examId === '') {
            json_response(['error' => 'connectorId, externalCourseId and examId are required.'], 400);
        }

        $connCheck = $pdo->prepare('SELECT id FROM integration_connectors WHERE id = ? AND company_id = ?');
        $connCheck->execute([$connectorId, $companyId]);
        if (!$connCheck->fetchColumn()) {
            json_response(['error' => 'Connector not found.'], 404);
        }
        $connCheck->closeCursor();

        $examCheck = $pdo->prepare('SELECT id FROM exams WHERE id = ? AND company_id = ?');
        $examCheck->execute([$examId, $companyId]);
        if (!$examCheck->fetchColumn()) {
            json_response(['error' => 'Exam not found in this company.'], 404);
        }
        $examCheck->closeCursor();

        // batch ids are global, so without this an admin could map to ANOTHER company's batch and
        // the pipeline would enroll this company's candidates into it (add_student_batch).
        if ($batchId !== null) {
            $batchCheck = $pdo->prepare('SELECT id FROM batches WHERE id = ? AND company_id = ?');
            $batchCheck->execute([$batchId, $companyId]);
            if (!$batchCheck->fetchColumn()) {
                json_response(['error' => 'Batch not found in this company.'], 404);
            }
            $batchCheck->closeCursor();
        }

        $stmt = $pdo->prepare('INSERT INTO course_exam_mappings (company_id, connector_id, external_course_id, exam_id, batch_id, active)
                               VALUES (?, ?, ?, ?, ?, ?)
                               ON DUPLICATE KEY UPDATE exam_id = VALUES(exam_id), batch_id = VALUES(batch_id), active = VALUES(active)');
        $stmt->execute([$companyId, $connectorId, $externalCourseId, $examId, $batchId, $active ? 1 : 0]);
        $stmt->closeCursor();

        audit_log($pdo, [
            'companyId' => $companyId, 'actorRole' => $actorRole, 'actorId' => get_actor_id($payload),
            'action' => 'COURSE_EXAM_MAPPING_SAVE', 'targetType' => 'course_exam_mapping', 'targetId' => $connectorId . ':' . $externalCourseId,
            'message' => "Mapped course {$externalCourseId} -> exam {$examId}",
        ]);
        json_response(['ok' => true]);
    }

    if ($action === 'DELETE_MAPPING') {
        $id = (int)($payload['id'] ?? 0);
        if ($id <= 0) {
            json_response(['error' => 'id is required.'], 400);
        }
        $stmt = $pdo->prepare('DELETE FROM course_exam_mappings WHERE id = ? AND company_id = ?');
        $stmt->execute([$id, $companyId]);
        $stmt->closeCursor();
        json_response(['ok' => true]);
    }

    if ($action === 'RETRY_EVENT') {
        $eventId = (int)($payload['eventId'] ?? 0);
        if ($eventId <= 0) {
            json_response(['error' => 'eventId is required.'], 400);
        }
        $event = fetch_event_by_id($pdo, $eventId);
        if (!$event || (int)$event['company_id'] !== $companyId) {
            json_response(['error' => 'Event not found.'], 404);
        }
        process_integration_event($pdo, $env, $event);

        audit_log($pdo, [
            'companyId' => $companyId, 'actorRole' => $actorRole, 'actorId' => get_actor_id($payload),
            'action' => 'INTEGRATION_EVENT_RETRY', 'targetType' => 'integration_event', 'targetId' => (string)$eventId,
            'message' => "Manually retried integration event {$eventId}",
        ]);

        $updated = fetch_event_by_id($pdo, $eventId);
        json_response(['ok' => true, 'status' => $updated['status'] ?? null]);
    }

    json_response(['error' => 'Unknown action.'], 400);
}

json_response(['error' => 'Method not allowed.'], 405);
