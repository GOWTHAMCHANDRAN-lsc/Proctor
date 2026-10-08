<?php
declare(strict_types=1);

/**
 * Public short-link resolver: GET api/link.php?c=<code> → {"token": "<signed exam-access token>"}.
 *
 * The student page calls this for a "<origin>?<code>" (or older "/x/<code>") URL, then runs the normal ?token= flow with the
 * returned token, so every existing check (signature, exam window, assignment, attempts) still
 * applies at exam start. No auth — the code itself is the credential, exactly like the long ?token=
 * link it stands for — and the response carries nothing but that token. Codes are 10 random base62
 * characters (~8e17 possibilities), and unknown-code lookups are rate-limited per IP so the space
 * can't be walked.
 *
 * Rate limit: misses (unknown/malformed codes) count against a small per-IP budget; successful
 * lookups only against a large one. Many candidates in one exam centre share a public IP, and a
 * flat 60-per-10-minutes cap on every lookup would lock a whole hall out of its exam.
 */

require __DIR__ . '/_bootstrap.php';

const LINK_WINDOW_MINUTES = 10;
const LINK_MAX_MISSES = 60;      // unknown codes per IP per window
const LINK_MAX_LOOKUPS = 1200;   // all lookups per IP per window (DB-load backstop)

header('Cache-Control: no-store');
header('X-Robots-Tag: noindex');

if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'GET') {
    json_response(['error' => 'Method not allowed.'], 405);
}

function link_ensure_rate_table(PDO $pdo): void {
    // Same definition as database/schema.sql (the table already exists there; this covers a DB that
    // predates it).
    $pdo->exec("CREATE TABLE IF NOT EXISTS rate_limits (
      id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      action           VARCHAR(64) NOT NULL,
      identifier       VARCHAR(255) NOT NULL,
      attempts         INT NOT NULL DEFAULT 1,
      first_attempt_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_attempt_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_rate_limits_action_identifier (action, identifier),
      KEY idx_rate_limits_expire (action, last_attempt_at)
    ) ENGINE=InnoDB");
}

/** Current attempts for (action, ip) in the active fixed window (0 when the window has lapsed). */
function link_rate_count(PDO $pdo, string $action, string $ip): int {
    $stmt = $pdo->prepare('SELECT attempts FROM rate_limits
                            WHERE action = ? AND identifier = ?
                              AND first_attempt_at >= NOW() - INTERVAL ' . LINK_WINDOW_MINUTES . ' MINUTE
                            LIMIT 1');
    $stmt->execute([$action, $ip]);
    $value = $stmt->fetchColumn();
    $stmt->closeCursor();
    return $value === false ? 0 : (int)$value;
}

/** Count one attempt in a fixed window (atomic upsert; a lapsed window restarts at 1). */
function link_rate_hit(PDO $pdo, string $action, string $ip): void {
    // Assignments run left to right, so `attempts` is decided from the OLD first_attempt_at.
    $stmt = $pdo->prepare('INSERT INTO rate_limits (action, identifier, attempts, first_attempt_at, last_attempt_at)
                           VALUES (?, ?, 1, NOW(), NOW())
                           ON DUPLICATE KEY UPDATE
                             attempts = IF(first_attempt_at < NOW() - INTERVAL ' . LINK_WINDOW_MINUTES . ' MINUTE, 1, attempts + 1),
                             first_attempt_at = IF(first_attempt_at < NOW() - INTERVAL ' . LINK_WINDOW_MINUTES . ' MINUTE, NOW(), first_attempt_at),
                             last_attempt_at = NOW()');
    $stmt->execute([$action, $ip]);
    $stmt->closeCursor();
}

$ip = substr((string)($_SERVER['REMOTE_ADDR'] ?? 'unknown'), 0, 64);
$code = trim((string)($_GET['c'] ?? ''));

$rateLimited = false;
try {
    link_ensure_rate_table($pdo);
    $rateLimited = link_rate_count($pdo, 'exam_link_miss', $ip) >= LINK_MAX_MISSES
        || link_rate_count($pdo, 'exam_link_all', $ip) >= LINK_MAX_LOOKUPS;
    if (!$rateLimited) {
        link_rate_hit($pdo, 'exam_link_all', $ip);
    }
} catch (Throwable $e) {
    // Fail open on a rate-limit bookkeeping error; the lookup itself is still a cheap PK read.
    error_log('[link] rate limit check failed: ' . $e->getMessage());
}
if ($rateLimited) {
    header('Retry-After: ' . (LINK_WINDOW_MINUTES * 60));
    json_response(['error' => 'TOO_MANY_REQUESTS', 'message' => 'Too many link lookups from this network. Please wait a few minutes and try again.'], 429);
}

$notFound = static function () use ($pdo, $ip): void {
    try {
        link_rate_hit($pdo, 'exam_link_miss', $ip);
    } catch (Throwable $e) {
        // ignore
    }
    json_response(['error' => 'LINK_NOT_FOUND'], 404);
};

if (preg_match('/^[A-Za-z0-9]{6,16}$/', $code) !== 1) {
    $notFound();
}

ensure_exam_short_link_schema($pdo);
$stmt = $pdo->prepare('SELECT exam_id, student_id, company_id FROM exam_short_links WHERE code = ? LIMIT 1');
$stmt->execute([$code]);
$row = $stmt->fetch();
$stmt->closeCursor();
if (!$row) {
    $notFound();
}

try {
    $bump = $pdo->prepare('UPDATE exam_short_links SET use_count = use_count + 1, last_used_at = NOW() WHERE code = ?');
    $bump->execute([$code]);
    $bump->closeCursor();
} catch (Throwable $e) {
    // Usage stats are bookkeeping only.
}

json_response(['token' => mint_exam_access_token((string)$row['exam_id'], (string)$row['student_id'], (int)$row['company_id'])]);
