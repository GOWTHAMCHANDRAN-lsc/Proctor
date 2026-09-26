<?php
declare(strict_types=1);

/**
 * Retry sweep for the V1 integration pipeline (api/integrations.php). There is no message broker in
 * this app, so reliability comes from this small CLI script instead: it re-processes any
 * integration_events left in FAILED (attempts < 5) after a transient error (e.g. the mapped exam was
 * temporarily missing, SMTP hiccuped, a DB deadlock). Run it on a schedule, e.g.:
 *
 *   (every 2 minutes) php /srv/apps/proctor/scripts/integrations_worker.php >> /srv/apps/proctor/storage/logs/integrations_worker.log 2>&1
 *
 * Wired into this deploy's crontab (see `crontab -l`) at that same 2-minute cadence.
 */

// _bootstrap.php assumes it's reached via a web request (sends HTTP headers, reads $_SERVER
// REQUEST_METHOD, etc.) — stub the minimum this CLI context needs before requiring it.
if (!isset($_SERVER['REQUEST_METHOD'])) {
    $_SERVER['REQUEST_METHOD'] = 'CLI';
}

require __DIR__ . '/../api/_bootstrap.php';
require_once __DIR__ . '/../api/integrations.php';

$stmt = $pdo->prepare("SELECT id FROM integration_events WHERE status = 'FAILED' AND attempts < 5 ORDER BY received_at ASC LIMIT 200");
$stmt->execute();
$ids = array_map(static fn($row) => (int)$row['id'], $stmt->fetchAll());
$stmt->closeCursor();

$count = 0;
foreach ($ids as $id) {
    $event = fetch_event_by_id($pdo, $id);
    if (!$event) {
        continue;
    }
    process_integration_event($pdo, $env, $event);
    $count++;
}

fwrite(STDOUT, sprintf("[%s] integrations_worker: retried %d event(s)\n", date('c'), $count));
