<?php
declare(strict_types=1);

/**
 * Sends queued exam invitations / reminders (api/notify_jobs.php). CLI only.
 *
 * Run by cron every minute and started straight away when a send is queued. Each run works for up
 * to ~55 seconds and exits; a MySQL named lock keeps two runs from overlapping, so the next minute's
 * run simply carries on. Prints a line only when it actually sent something.
 *
 *   * * * * * /usr/bin/php /srv/apps/proctor/scripts/notify_worker.php >> /srv/apps/proctor/storage/logs/notify_worker.log 2>&1
 */

if (PHP_SAPI !== 'cli') {
    http_response_code(403);
    echo "CLI only.\n";
    exit(1);
}

$_SERVER['REQUEST_METHOD'] = 'CLI';
require_once __DIR__ . '/../api/_bootstrap.php';
require_once __DIR__ . '/../api/notify_jobs.php';

try {
    $summary = notify_worker_run($pdo, $env, 55.0);
    if ($summary !== 'another worker is running' && $summary !== 'emails 0, whatsapp 0') {
        echo gmdate('Y-m-d H:i:s') . " UTC  sent: {$summary}\n";
    }
} catch (Throwable $e) {
    fwrite(STDERR, gmdate('Y-m-d H:i:s') . ' UTC  notify_worker failed: ' . get_class($e) . ': ' . $e->getMessage() . ' in ' . $e->getFile() . ':' . $e->getLine() . "\n");
    exit(1);
}
