<?php
declare(strict_types=1);

/**
 * Retry sweep for the V1 certificate pipeline (api/certificates.php). Mirrors
 * scripts/integrations_worker.php: re-processes certificate_issuances left in FAILED after a
 * transient error (SMTP hiccup, the certificate API being down, a DB deadlock) — and, once
 * CERTIFICATE_API_URL is wired up for real, this is what actually gets a certificate issued once the
 * vendor's API recovers, without an admin needing to click Retry by hand. Run it on a schedule, e.g.:
 *
 *   (every 2 minutes) php /srv/apps/proctor/scripts/certificates_worker.php >> /srv/apps/proctor/storage/logs/certificates_worker.log 2>&1
 *
 * Wired into this deploy's crontab (see `crontab -l`) at that same 2-minute cadence.
 */

if (!isset($_SERVER['REQUEST_METHOD'])) {
    $_SERVER['REQUEST_METHOD'] = 'CLI';
}

require __DIR__ . '/../api/_bootstrap.php';
require_once __DIR__ . '/../api/certificates.php';

$stmt = $pdo->prepare("SELECT id, company_id, session_id FROM certificate_issuances WHERE status = 'FAILED' AND attempts < ? ORDER BY created_at ASC LIMIT 200");
$stmt->execute([CERTIFICATE_MAX_ATTEMPTS]);
$rows = $stmt->fetchAll();
$stmt->closeCursor();

$count = 0;
foreach ($rows as $row) {
    // maybe_issue_certificate() never throws (see its own docblock), but this loop must survive even
    // an unexpected error so one bad row can't stop the rest of the sweep.
    try {
        maybe_issue_certificate($pdo, $env, (int)$row['company_id'], (int)$row['session_id']);
    } catch (Throwable $e) {
        fwrite(STDOUT, sprintf("[%s] certificates_worker: unexpected error on issuance %d: %s\n", date('c'), (int)$row['id'], $e->getMessage()));
    }
    $count++;
}

fwrite(STDOUT, sprintf("[%s] certificates_worker: retried %d issuance(s)\n", date('c'), $count));
