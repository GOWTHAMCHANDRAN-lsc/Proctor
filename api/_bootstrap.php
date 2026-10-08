<?php
declare(strict_types=1);

header('Content-Type: application/json');

/**
 * CORS: only reflect an Origin that is on the allow-list, instead of the previous wildcard `*`
 * which let any website script the API. The list comes from CORS_ALLOWED_ORIGINS in .env
 * (comma-separated); if unset it falls back to the app's own production origin. Read directly from
 * the .env file here because the full env loader runs later in this bootstrap. Same-origin calls
 * (the app itself) are unaffected — browsers don't apply CORS to them.
 */
(function () {
    $allowed = [];
    $envFile = __DIR__ . '/../.env';
    if (is_readable($envFile)) {
        foreach (file($envFile, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) as $line) {
            if (strncmp($line, 'CORS_ALLOWED_ORIGINS=', 21) === 0) {
                $raw = trim(substr($line, 21), " \t\"'");
                $allowed = array_values(array_filter(array_map('trim', explode(',', $raw))));
                break;
            }
        }
    }
    if (empty($allowed)) {
        $allowed = ['https://proctor.lsc-crm.in'];
    }
    $origin = $_SERVER['HTTP_ORIGIN'] ?? '';
    header('Vary: Origin');
    if ($origin !== '' && in_array($origin, $allowed, true)) {
        header('Access-Control-Allow-Origin: ' . $origin);
    } else {
        // Non-allowed / no Origin: pin to the primary allowed origin so cross-site scripts get blocked.
        header('Access-Control-Allow-Origin: ' . $allowed[0]);
    }
})();
header('Access-Control-Allow-Headers: Content-Type, X-Company-Id, X-User-Role, X-Actor-Id, X-Auth-Token, X-Exam-Token, Authorization');
header('Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS');
header('Access-Control-Max-Age: 600');

// Baseline hardening headers.
header('X-Content-Type-Options: nosniff');
header('X-Frame-Options: DENY');
header('Referrer-Policy: strict-origin-when-cross-origin');

ini_set('display_errors', '0');
ini_set('display_startup_errors', '0');
error_reporting(E_ALL);

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(204);
    exit;
}

const ENV_PATHS = [
    __DIR__ . '/../.env',
];

// Backwards compatibility: some scripts referenced a single ENV_PATH constant.
// Point it at the primary entry in ENV_PATHS so those scripts keep working.
if (!defined('ENV_PATH')) {
    define('ENV_PATH', ENV_PATHS[0] ?? (__DIR__ . '/../.env'));
}

function load_env_file(string $path): array {
    if (!is_readable($path)) {
        return [];
    }
    $lines = file($path, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);
    $env = [];
    foreach ($lines as $line) {
        $line = trim($line);
        if ($line === '' || ($line[0] ?? '') === '#') {
            continue;
        }
        $parts = explode('=', $line, 2);
        if (count($parts) !== 2) {
            continue;
        }
        $key = trim($parts[0]);
        $value = trim($parts[1]);
        if ($value !== '' && $value[0] === '"' && substr($value, -1) === '"') {
            $value = substr($value, 1, -1);
        }
        $env[$key] = $value;
    }
    return $env;
}

function load_env_files(array $paths): array {
    $env = [];
    foreach ($paths as $path) {
        if (!is_readable($path)) {
            continue;
        }
        $env = array_merge($env, load_env_file($path));
    }
    return $env;
}

function json_input(): array {
    $raw = file_get_contents('php://input');
    if ($raw === false || trim($raw) === '') {
        return [];
    }
    $data = json_decode($raw, true);
    if (json_last_error() !== JSON_ERROR_NONE) {
        json_response(['error' => 'Invalid JSON payload.'], 400);
    }
    return is_array($data) ? $data : [];
}

function json_response(array $data, int $status = 200): void {
    http_response_code($status);
    $json = json_encode($data, JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
    if ($json === false) {
        $json = json_encode(['error' => 'Response encoding failed.'], JSON_UNESCAPED_UNICODE);
    }
    echo $json;
    exit;
}

/**
 * Send the JSON response now and, unlike json_response(), let the caller keep running afterward —
 * for slow best-effort work (an external API call, an email send) that must not make the client wait
 * on it. Under PHP-FPM, fastcgi_finish_request() flushes the response and closes the client
 * connection immediately while this worker process keeps executing; on SAPIs without it (e.g. the
 * CLI built-in server) this just flushes output buffers, so behavior only ever improves, never
 * regresses to something worse than a plain synchronous response.
 */
function respond_then_continue(array $data, int $status = 200): void {
    http_response_code($status);
    $json = json_encode($data, JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
    echo $json !== false ? $json : json_encode(['error' => 'Response encoding failed.'], JSON_UNESCAPED_UNICODE);
    if (function_exists('fastcgi_finish_request')) {
        fastcgi_finish_request();
        return;
    }
    if (function_exists('ob_get_level')) {
        while (ob_get_level() > 0) {
            ob_end_flush();
        }
    }
    flush();
}

/** Read a value from the loaded .env (populated at the end of this bootstrap). */
function pg_env(string $key, $default = null) {
    return $GLOBALS['__pg_env'][$key] ?? $default;
}

function base64url_encode(string $bin): string {
    return rtrim(strtr(base64_encode($bin), '+/', '-_'), '=');
}
function base64url_decode(string $s): string {
    return (string)base64_decode(strtr($s, '-_', '+/'));
}

/**
 * Mint a signed session token: base64url(json claims) . base64url(HMAC-SHA256). The server issues
 * this ONLY after verifying credentials (local password or the external auth service), so a caller
 * cannot forge a role/company the way the old X-User-Role / X-Company-Id headers allowed.
 */
function mint_session_token(array $claims, int $ttlSeconds = 43200): string {
    $secret = (string)pg_env('SESSION_SECRET', '');
    $claims['iat'] = time();
    $claims['exp'] = time() + $ttlSeconds;
    $payload = base64url_encode((string)json_encode($claims));
    $sig = base64url_encode(hash_hmac('sha256', $payload, $secret, true));
    return $payload . '.' . $sig;
}

/** Verify a session token; returns the claims array or null (bad signature / expired / malformed). */
function verify_session_token(string $token): ?array {
    $secret = (string)pg_env('SESSION_SECRET', '');
    if ($secret === '' || strpos($token, '.') === false) {
        return null;
    }
    [$payload, $sig] = explode('.', $token, 2);
    if ($payload === '' || $sig === '') {
        return null;
    }
    $expected = base64url_encode(hash_hmac('sha256', $payload, $secret, true));
    if (!hash_equals($expected, $sig)) {
        return null;
    }
    $claims = json_decode(base64url_decode($payload), true);
    if (!is_array($claims) || (int)($claims['exp'] ?? 0) < time()) {
        return null;
    }
    return $claims;
}

/** Verified claims for the current request (from X-Auth-Token), parsed once and cached. */
function current_session_claims(): ?array {
    static $cached = false;
    static $claims = null;
    if ($cached) {
        return $claims;
    }
    $cached = true;
    $token = trim((string)($_SERVER['HTTP_X_AUTH_TOKEN'] ?? ''));
    if ($token === '' && !empty($_SERVER['HTTP_AUTHORIZATION'])) {
        if (preg_match('/^Bearer\s+(.+)$/i', (string)$_SERVER['HTTP_AUTHORIZATION'], $m)) {
            $token = trim($m[1]);
        }
    }
    $claims = $token !== '' ? verify_session_token($token) : null;

    // Revocation: a token is self-contained and lives 12h, so without this check disabling,
    // deleting, re-roling or moving a staff user to another company did NOT take effect until the
    // token expired — a disabled proctor kept full access to live walls / recordings for hours.
    // Re-check the directory row (one PK lookup, staff requests only). Fails OPEN on a DB error so
    // a transient glitch can't log every admin out.
    if ($claims !== null && isset($claims['uid']) && (int)$claims['uid'] > 0) {
        $pdo = $GLOBALS['pdo'] ?? null;
        if ($pdo instanceof PDO) {
            try {
                $st = $pdo->prepare('SELECT role, status, company_id FROM platform_users WHERE id = ? LIMIT 1');
                $st->execute([(int)$claims['uid']]);
                $row = $st->fetch();
                $st->closeCursor();
                $tokenRole = strtoupper(trim((string)($claims['role'] ?? '')));
                if (!$row
                    || strtoupper((string)$row['status']) === 'DISABLED'
                    || strtoupper((string)$row['role']) !== $tokenRole
                    || ($tokenRole !== 'SUPER_ADMIN' && (int)($row['company_id'] ?? 0) !== (int)($claims['cid'] ?? 0))
                ) {
                    $claims = null;
                }
            } catch (Throwable $e) {
                // Fail open — keep the verified claims.
            }
        }
    }
    return $claims;
}

/** True once token enforcement is switched on (forged headers no longer grant privilege). */
function auth_enforced(): bool {
    return (string)pg_env('AUTH_ENFORCE_TOKEN', '0') === '1';
}

/**
 * Exam-access tokens (the ?token=... links emailed to candidates) carry {eid, sid, cid}. They used
 * to be UNSIGNED base64(json), so a candidate could decode their own link, change `sid` to another
 * student (impersonation) or `eid` to an exam they weren't assigned, re-encode, and start it — the
 * server trusted whatever studentId/examId arrived. These helpers add an HMAC signature over the
 * canonical (eid|sid|cid) so a tampered token no longer verifies.
 *
 * The token stays a single base64url(json) blob (the `sig` lives INSIDE the json) so the URL format
 * and the browser-side decoder are unchanged; only start-of-exam now demands a valid signature.
 */
function exam_token_signature(string $eid, string $sid, int $cid): string {
    $secret = (string)pg_env('SESSION_SECRET', '');
    if ($secret === '') return '';
    return base64url_encode(hash_hmac('sha256', $eid . '|' . $sid . '|' . $cid, $secret, true));
}

/** Mint a signed exam-access token: base64url(json{eid,sid,cid,sig}). Deterministic per (eid,sid,cid). */
function mint_exam_access_token(string $eid, string $sid, int $cid): string {
    $claims = ['eid' => $eid, 'sid' => $sid, 'cid' => $cid, 'sig' => exam_token_signature($eid, $sid, $cid)];
    return base64url_encode((string)json_encode($claims));
}

/**
 * Verify that a decoded exam-token payload's signature matches its (eid,sid,cid). Returns true only
 * for a correctly signed token. An unsigned/legacy token (no `sig`) returns false — callers decide
 * whether to reject (enforced) or allow (grace period) based on exam_token_enforced().
 */
function exam_token_valid(array $payload): bool {
    $eid = (string)($payload['eid'] ?? '');
    $sid = (string)($payload['sid'] ?? '');
    $cid = (int)($payload['cid'] ?? 0);
    $sig = (string)($payload['sig'] ?? '');
    if ($eid === '' || $sid === '' || $cid <= 0 || $sig === '') return false;
    $expected = exam_token_signature($eid, $sid, $cid);
    return $expected !== '' && hash_equals($expected, $sig);
}

/**
 * When on, exam start REQUIRES a validly signed access token — unsigned/tampered links are rejected.
 * Defaults OFF so links already emailed keep working; flip EXAM_ENFORCE_TOKEN=1 in .env once fresh
 * signed links have been re-sent (mirrors the AUTH_ENFORCE_TOKEN rollout).
 */
function exam_token_enforced(): bool {
    return (string)pg_env('EXAM_ENFORCE_TOKEN', '0') === '1';
}

/**
 * Signs a staff-only-generated media URL (recording playback file / live proctor frame) so it can be
 * fetched via a plain <video>/<img> src — the browser sends no custom headers on those requests, so
 * require_staff() can't gate them directly. Instead, the URL is only ever minted by an already
 * staff-authenticated list/wall request, with this signature baked in; the raw file/frame endpoint
 * verifies it instead of trusting a bare companyId + guessable sequential id.
 */
function media_url_signature(string $scope, int $companyId, int $id, string $extra = ''): string {
    $secret = (string)pg_env('SESSION_SECRET', '');
    if ($secret === '') return '';
    return base64url_encode(hash_hmac('sha256', "{$scope}|{$companyId}|{$id}|{$extra}", $secret, true));
}

function media_url_signature_valid(string $scope, int $companyId, int $id, string $extra, string $sig): bool {
    if ($sig === '') return false;
    $expected = media_url_signature($scope, $companyId, $id, $extra);
    return $expected !== '' && hash_equals($expected, $sig);
}

/**
 * Read an exam-access token from the X-Exam-Token header (sent by the student frontend when it
 * has no staff session token). Returns the decoded claims array {eid, sid, cid, sig} if the token
 * is present AND passes HMAC verification, otherwise null.
 */
function current_exam_token_claims(): ?array {
    static $cached = false;
    static $claims = null;
    if ($cached) {
        return $claims;
    }
    $cached = true;
    $raw = trim((string)($_SERVER['HTTP_X_EXAM_TOKEN'] ?? ''));
    if ($raw === '') {
        return null;
    }
    $decoded = json_decode(base64url_decode($raw), true);
    if (!is_array($decoded)) {
        return null;
    }
    if (!exam_token_valid($decoded)) {
        return null;
    }
    $claims = $decoded;
    return $claims;
}

function get_company_id(?array $payload = null): ?int {
    $header = $_SERVER['HTTP_X_COMPANY_ID'] ?? '';
    $headerId  = (is_string($header) && trim($header) !== '') ? (int)$header : null;
    $getId     = isset($_GET['companyId']) ? (int)$_GET['companyId'] : null;
    $payloadId = (is_array($payload) && isset($payload['companyId'])) ? (int)$payload['companyId'] : null;

    // With a verified token, a regular staff user is pinned to the company in the token — query /
    // payload / header can never widen their scope. A SUPER_ADMIN may still pick any company per
    // request (the dropdown), so we honour the explicit choice for them.
    $claims = current_session_claims();
    if ($claims !== null) {
        $role = strtoupper((string)($claims['role'] ?? 'STUDENT'));
        if ($role === 'SUPER_ADMIN') {
            return $getId ?? $payloadId ?? $headerId ?? (isset($claims['cid']) ? (int)$claims['cid'] : null);
        }
        return isset($claims['cid']) && (int)$claims['cid'] > 0 ? (int)$claims['cid'] : null;
    }

    // No token: legacy behaviour (students, and staff during the pre-enforcement rollout window).
    if (get_actor_role($payload) === 'SUPER_ADMIN') {
        return $getId ?? $payloadId ?? $headerId;
    }
    return $headerId ?? $getId ?? $payloadId;
}

function require_company_id(?array $payload = null): int {
    $companyId = get_company_id($payload);
    if ($companyId === null || $companyId <= 0) {
        json_response(['error' => 'companyId is required.'], 400);
    }
    return $companyId;
}

function get_actor_role(?array $payload = null): string {
    $allowed = ['ADMIN', 'SUPER_ADMIN', 'PROCTOR', 'VIEWER', 'STUDENT', 'SYSTEM'];

    // A verified session token is the authoritative source of the caller's role.
    $claims = current_session_claims();
    if ($claims !== null) {
        $role = strtoupper(trim((string)($claims['role'] ?? 'STUDENT')));
        return in_array($role, $allowed, true) ? $role : 'STUDENT';
    }

    // No valid token. Once enforcement is on, a forged X-User-Role header grants nothing — the caller
    // is treated as an unprivileged STUDENT. During the rollout window we still honour the header so
    // the already-deployed frontend keeps working until it starts sending tokens.
    if (auth_enforced()) {
        return 'STUDENT';
    }
    $role = $_SERVER['HTTP_X_USER_ROLE'] ?? ($payload['actorRole'] ?? 'STUDENT');
    $role = strtoupper(trim((string)$role));
    return in_array($role, $allowed, true) ? $role : 'STUDENT';
}

function role_matches_required(string $actualRole, string $requiredRole): bool {
    if ($actualRole === $requiredRole) {
        return true;
    }
    if ($actualRole === 'SUPER_ADMIN' && $requiredRole === 'ADMIN') {
        return true;
    }
    return false;
}

function get_actor_id(?array $payload = null): ?string {
    // Prefer the identity baked into the verified token so it can't be spoofed.
    $claims = current_session_claims();
    if ($claims !== null) {
        $tokEmail = trim((string)($claims['email'] ?? $claims['sub'] ?? ''));
        if ($tokEmail !== '') {
            return $tokEmail;
        }
    }
    $header = $_SERVER['HTTP_X_ACTOR_ID'] ?? null;
    if (is_string($header) && trim($header) !== '') {
        return trim($header);
    }
    if (is_array($payload) && isset($payload['actorId']) && trim((string)$payload['actorId']) !== '') {
        return trim((string)$payload['actorId']);
    }
    return null;
}

function require_role(array $roles, ?array $payload = null): string {
    $role = get_actor_role($payload);
    $normalized = array_map(static fn($r) => strtoupper((string)$r), $roles);
    foreach ($normalized as $requiredRole) {
        if (role_matches_required($role, $requiredRole)) {
            return $role;
        }
    }
    // Distinguish "not signed in" (no valid token while enforcement is on) from "signed in but wrong
    // role". The 401 tells the frontend to drop the stale session and send the user back to login.
    if (auth_enforced() && current_session_claims() === null) {
        json_response(['error' => 'Authentication required.'], 401);
    }
    json_response(['error' => 'Forbidden for this role.'], 403);
}

/**
 * Gate an endpoint to any authenticated staff member (not students). Under token enforcement this
 * requires a valid session token; a tokenless / forged-header request is treated as STUDENT and
 * rejected with 401. Use on admin-only read endpoints that previously only checked a company id.
 */
function require_staff(?array $payload = null): string {
    return require_role(['SUPER_ADMIN', 'ADMIN', 'PROCTOR', 'VIEWER'], $payload);
}

function db_column_exists(PDO $pdo, string $table, string $column): bool {
    try {
        static $columnCache = [];
        $cacheKey = "{$table}.{$column}";
        if (array_key_exists($cacheKey, $columnCache)) {
            return $columnCache[$cacheKey];
        }
        $stmt = $pdo->prepare("SHOW COLUMNS FROM {$table} LIKE ?");
        $stmt->execute([$column]);
        $exists = (bool)$stmt->fetch();
        $stmt->closeCursor();
        $columnCache[$cacheKey] = $exists;
        return $exists;
    } catch (Throwable $e) {
        return false;
    }
}

function db_table_exists(PDO $pdo, string $table): bool {
    try {
        $stmt = $pdo->prepare('SHOW TABLES LIKE ?');
        $stmt->execute([$table]);
        $exists = (bool)$stmt->fetch();
        $stmt->closeCursor();
        return $exists;
    } catch (Throwable $e) {
        return false;
    }
}

/**
 * Finalize any recording rows for a candidate that are still stuck in INIT/RECORDING.
 *
 * The client sends a COMPLETE call when the exam ends, but a tab close, browser crash, network
 * drop, or navigation can prevent that — leaving the recording in 'RECORDING' forever even though
 * the exam is over. This is the authoritative server-side close-out: whenever a session ends
 * (submit / terminate) we sweep the candidate's open recordings to COMPLETED. Matches on
 * exam_id + student_id (always populated) rather than session_id, which can be NULL if recording
 * started before the session id was known. Best-effort: never throws into the caller.
 */
/**
 * Number of real INCIDENTS per session, keyed by session id.
 *
 * The detectors re-report a problem for as long as it lasts: NO_FACE fires every ~10s and the
 * behavioural patterns re-fire on their own cooldowns. A raw COUNT(*) of violation_logs therefore
 * reports one 19-minute webcam failure as "112 violations", which is what admins saw against a
 * candidate's name. This counts CONTINUOUS RUNS instead: consecutive events of the same type AND
 * behavioural pattern, within EPISODE_GAP_SEC of each other, are one incident.
 *
 * Mirrors groupViolationEpisodes() in services/violationEpisodes.ts — keep the two in step.
 */
const EPISODE_GAP_SEC = 60;

/**
 * Trim a descriptive answer to at most `$limit` words.
 *
 * A "word" is a run of non-whitespace characters — the same definition as countWords() in
 * services/wordCount.ts. The two MUST agree: if the browser counts 100 words and the server counts
 * 98, a candidate gets silently docked words they can see on screen. Multibyte-safe so answers in
 * non-Latin scripts are not mangled.
 */
function truncate_to_words(string $text, int $limit): string {
    if ($limit <= 0) return $text;

    $matches = [];
    // PREG_OFFSET_CAPTURE gives byte offsets, so cutting with substr() keeps the candidate's own
    // spacing and line breaks intact up to the cut.
    if (preg_match_all('/\S+/u', $text, $matches, PREG_OFFSET_CAPTURE) === false) {
        return $text;
    }
    $words = $matches[0];
    if (count($words) <= $limit) {
        return $text;
    }

    $last = $words[$limit - 1];
    $end = $last[1] + strlen($last[0]);
    return substr($text, 0, $end);
}

/**
 * A drop-in replacement for the `violation_logs` table that yields ONE ROW PER INCIDENT (the first
 * event of each continuous run) instead of one row per detector event. Same column names, so any
 * `FROM violation_logs vl` / `JOIN violation_logs vl` becomes `FROM <this> vl` and every COUNT(*)
 * over it starts reporting incidents rather than pings.
 */
function violation_episodes_subquery(PDO $pdo): string {
    $hasMetadata = db_column_exists($pdo, 'violation_logs', 'metadata_json');
    $patternExpr = $hasMetadata
        ? "COALESCE(JSON_UNQUOTE(JSON_EXTRACT(v.metadata_json, '$.pattern')), '')"
        : "''";

    return "(
        SELECT id, company_id, session_id, type, occurred_at, description
          FROM (
            SELECT v.id, v.company_id, v.session_id, v.type, v.occurred_at, v.description,
                   LAG(v.occurred_at) OVER (
                     PARTITION BY v.company_id, v.session_id, v.type, {$patternExpr}
                     ORDER BY v.occurred_at
                   ) AS prev_ts
              FROM violation_logs v
          ) runs
         WHERE prev_ts IS NULL
            OR TIMESTAMPDIFF(SECOND, prev_ts, occurred_at) > " . EPISODE_GAP_SEC . "
    )";
}

function violation_episode_counts(PDO $pdo, int $companyId): array {
    try {
        $hasMetadata = db_column_exists($pdo, 'violation_logs', 'metadata_json');
        // A behavioural pattern ("extended_absence" vs "talking_alone") makes two events distinct
        // incidents even though both are SUSPICIOUS_BEHAVIOR.
        $patternExpr = $hasMetadata
            ? "COALESCE(JSON_UNQUOTE(JSON_EXTRACT(vl.metadata_json, '$.pattern')), '')"
            : "''";

        $sql = "
            SELECT session_id, SUM(is_new) AS episodes
              FROM (
                SELECT session_id,
                       CASE
                         WHEN prev_ts IS NOT NULL
                          AND TIMESTAMPDIFF(SECOND, prev_ts, occurred_at) <= " . EPISODE_GAP_SEC . "
                         THEN 0 ELSE 1
                       END AS is_new
                  FROM (
                    SELECT vl.session_id,
                           vl.occurred_at,
                           LAG(vl.occurred_at) OVER (
                             PARTITION BY vl.session_id, vl.type, {$patternExpr}
                             ORDER BY vl.occurred_at
                           ) AS prev_ts
                      FROM violation_logs vl
                     WHERE vl.company_id = ?
                       AND vl.session_id IS NOT NULL
                  ) w
              ) e
             GROUP BY session_id";

        $stmt = $pdo->prepare($sql);
        $stmt->execute([$companyId]);
        $counts = [];
        foreach ($stmt->fetchAll() as $row) {
            $counts[(int)$row['session_id']] = (int)$row['episodes'];
        }
        $stmt->closeCursor();
        return $counts;
    } catch (Throwable $e) {
        // Window functions need MySQL 8. If anything goes wrong, the caller falls back to the raw
        // count rather than showing nothing.
        return [];
    }
}

function finalize_stuck_recordings(PDO $pdo, int $companyId, string $examId, string $studentId, string $status = 'COMPLETED'): void {
    if (!in_array($status, ['COMPLETED', 'FAILED'], true)) {
        $status = 'COMPLETED';
    }
    try {
        if (!db_table_exists($pdo, 'recording_sessions')) return;
        $stmt = $pdo->prepare(
            "UPDATE recording_sessions
                SET status = ?,
                    ended_at = NOW(3),
                    duration_sec = CASE
                        WHEN duration_sec IS NULL OR duration_sec = 0
                        THEN GREATEST(0, TIMESTAMPDIFF(SECOND, started_at, NOW(3)))
                        ELSE duration_sec
                    END
              WHERE company_id = ? AND exam_id = ? AND student_id = ?
                AND status IN ('INIT', 'RECORDING')"
        );
        $stmt->execute([$status, $companyId, $examId, $studentId]);
        $stmt->closeCursor();
    } catch (Throwable $e) {
        // Recording close-out is best-effort; never block session completion on it.
    }
}

function db_add_column_if_missing(PDO $pdo, string $table, string $column, string $definition): void {
    try {
        if (!db_column_exists($pdo, $table, $column)) {
            $pdo->exec("ALTER TABLE {$table} ADD COLUMN {$column} {$definition}");
        }
    } catch (Throwable $e) {
        // Runtime migrations are best-effort; normal query errors will still surface.
    }
}

function db_scalar_int(PDO $pdo, string $sql, array $params = []): int {
    $stmt = $pdo->prepare($sql);
    $stmt->execute($params);
    $value = (int)($stmt->fetchColumn() ?: 0);
    $stmt->closeCursor();
    return $value;
}

function db_now_ms(): int {
    return (int)(microtime(true) * 1000);
}

/**
 * Many-to-many student <-> batch enrollment. A student can belong to any number of
 * batches (e.g. cohort + retake batch). Replaces the legacy students.batch_id single
 * FK, which is left in place on disk (unused) rather than dropped, so no historical
 * data is lost. Idempotent — safe to call from every entry point that touches batch
 * membership; the backfill is a no-op after the first run because of the PK.
 */
function ensure_student_batches_schema(PDO $pdo): void {
    $pdo->exec("CREATE TABLE IF NOT EXISTS student_batches (
      student_id  VARCHAR(64) NOT NULL,
      batch_id    BIGINT UNSIGNED NOT NULL,
      created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (student_id, batch_id),
      INDEX idx_student_batches_batch (batch_id),
      CONSTRAINT fk_student_batches_student FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE,
      CONSTRAINT fk_student_batches_batch FOREIGN KEY (batch_id) REFERENCES batches(id) ON DELETE CASCADE
    ) ENGINE=InnoDB");

    if (db_column_exists($pdo, 'students', 'batch_id')) {
        $pdo->exec("INSERT IGNORE INTO student_batches (student_id, batch_id)
                    SELECT id, batch_id FROM students WHERE batch_id IS NOT NULL");
    }
}

/**
 * students.email / students.registration_id used to be UNIQUE globally, while every dedupe
 * lookup in the app (students.php, users.php, integrations.php) is scoped by company_id — the
 * same mismatch batches already avoid via uq_batches_company_name (company_id, name). That gap
 * meant a student could be added fine within one company, but adding the same person into a
 * batch that resolves to a DIFFERENT company fell through the company-scoped SELECT, hit
 * INSERT, and collided with the global unique index ("Duplicate student record for ..."), even
 * though the two rows should be allowed to coexist as separate per-company students. Replaces
 * the legacy single-column UNIQUE indexes with composite (company_id, column) ones. Safe/lossless:
 * a composite unique key is strictly looser than the single-column one it replaces, so any data
 * that satisfied the old constraint already satisfies the new one. Idempotent — cheap to run on
 * every request.
 */
function ensure_student_company_scoped_uniqueness(PDO $pdo): void {
    try {
        $stmt = $pdo->query('SHOW INDEX FROM students');
        $rows = $stmt ? $stmt->fetchAll() : [];
        if ($stmt) $stmt->closeCursor();
    } catch (Throwable $e) {
        return;
    }

    $columnsByKey = [];
    foreach ($rows as $row) {
        $keyName = (string)($row['Key_name'] ?? '');
        if ($keyName === '' || $keyName === 'PRIMARY') {
            continue;
        }
        $columnsByKey[$keyName][(int)($row['Seq_in_index'] ?? 0)] = (string)($row['Column_name'] ?? '');
    }

    $hasCompanyEmail = false;
    $hasCompanyRegId = false;
    foreach ($columnsByKey as $keyName => $columns) {
        ksort($columns);
        $columns = array_values($columns);
        if ($columns === ['company_id', 'email']) {
            $hasCompanyEmail = true;
        } elseif ($columns === ['company_id', 'registration_id']) {
            $hasCompanyRegId = true;
        } elseif ($columns === ['email'] || $columns === ['registration_id']) {
            // Legacy global-unique single-column index — drop it so per-company scoping can take over.
            try {
                $pdo->exec("ALTER TABLE students DROP INDEX `{$keyName}`");
            } catch (Throwable $e) {
                // Best effort; leave it in place rather than fail the request.
            }
        }
    }

    if (!$hasCompanyEmail) {
        try {
            $pdo->exec('ALTER TABLE students ADD UNIQUE KEY uq_students_company_email (company_id, email)');
        } catch (Throwable $e) {
            // Best effort; normal query errors still surface elsewhere.
        }
    }
    if (!$hasCompanyRegId) {
        try {
            $pdo->exec('ALTER TABLE students ADD UNIQUE KEY uq_students_company_regid (company_id, registration_id)');
        } catch (Throwable $e) {
            // Best effort; normal query errors still surface elsewhere.
        }
    }
}

function get_student_batches(PDO $pdo, string $studentId): array {
    $stmt = $pdo->prepare("SELECT b.id, b.name
                           FROM student_batches sb
                           JOIN batches b ON b.id = sb.batch_id
                           WHERE sb.student_id = ?
                           ORDER BY b.name ASC");
    $stmt->execute([$studentId]);
    $rows = $stmt->fetchAll();
    $stmt->closeCursor();
    return array_map(static fn($row) => ['id' => (int)$row['id'], 'name' => (string)$row['name']], $rows);
}

// One query for a whole company's roster: studentId => [{id, name}, ...].
function fetch_student_batches_map(PDO $pdo, int $companyId): array {
    $stmt = $pdo->prepare("SELECT sb.student_id, b.id AS batch_id, b.name AS batch_name
                           FROM student_batches sb
                           JOIN batches b ON b.id = sb.batch_id
                           JOIN students s ON s.id = sb.student_id
                           WHERE s.company_id = ?
                           ORDER BY b.name ASC");
    $stmt->execute([$companyId]);
    $rows = $stmt->fetchAll();
    $stmt->closeCursor();

    $map = [];
    foreach ($rows as $row) {
        $studentId = (string)$row['student_id'];
        if (!isset($map[$studentId])) {
            $map[$studentId] = [];
        }
        $map[$studentId][] = ['id' => (int)$row['batch_id'], 'name' => (string)$row['batch_name']];
    }
    return $map;
}

function add_student_batch(PDO $pdo, string $studentId, int $batchId): void {
    $stmt = $pdo->prepare('INSERT IGNORE INTO student_batches (student_id, batch_id) VALUES (?, ?)');
    $stmt->execute([$studentId, $batchId]);
    $stmt->closeCursor();
}

function remove_student_batch(PDO $pdo, string $studentId, int $batchId): void {
    $stmt = $pdo->prepare('DELETE FROM student_batches WHERE student_id = ? AND batch_id = ?');
    $stmt->execute([$studentId, $batchId]);
    $stmt->closeCursor();
}

// Replaces the old `SELECT id FROM students WHERE batch_id IN (...)` expansion.
function expand_batch_ids_to_student_ids(PDO $pdo, array $batchIds): array {
    $batchIds = array_values(array_unique(array_map('intval', $batchIds)));
    if (count($batchIds) === 0) {
        return [];
    }
    $placeholders = implode(',', array_fill(0, count($batchIds), '?'));
    $stmt = $pdo->prepare("SELECT DISTINCT student_id FROM student_batches WHERE batch_id IN ($placeholders)");
    $stmt->execute($batchIds);
    $rows = $stmt->fetchAll();
    $stmt->closeCursor();
    return array_map(static fn($row) => (string)$row['student_id'], $rows);
}

function ensure_audit_role_enum(PDO $pdo): void {
    try {
        $stmt = $pdo->query("SHOW COLUMNS FROM audit_logs LIKE 'actor_role'");
        $column = $stmt ? $stmt->fetch() : null;
        if ($stmt) $stmt->closeCursor();
        $type = is_array($column) ? (string)($column['Type'] ?? '') : '';
        if (stripos($type, 'SUPER_ADMIN') !== false) {
            return;
        }
        $pdo->exec("ALTER TABLE audit_logs MODIFY actor_role ENUM('ADMIN','SUPER_ADMIN','PROCTOR','STUDENT','SYSTEM') NOT NULL DEFAULT 'SYSTEM'");
    } catch (Throwable $e) {
        // Best effort only; audit_log is also non-blocking.
    }
}

/**
 * Generalise the questions/session_answers schema so the full question-type bank
 * (MULTI_SELECT, TRUE_FALSE, YES_NO, SHORT_TEXT, LONG_TEXT, FILL_BLANK, NUMERIC, DATE,
 * TIME, MATCHING, ORDERING, DRAG_DROP) can be stored alongside the legacy MCQ/TEXT.
 *  - questions.type: ENUM('MCQ','TEXT') -> VARCHAR(32) (app validates the value).
 *  - questions.answer_key_json: structured correct-answer spec (see AnswerKey in types.ts).
 *  - questions.match_options_json: left/right/items/buckets for MATCHING/ORDERING/DRAG_DROP.
 *  - session_answers.answer_json: structured student response (arrays / maps).
 * Every endpoint includes this bootstrap, so the columns exist regardless of entry point.
 */
function ensure_question_type_schema(PDO $pdo): void {
    try {
        $stmt = $pdo->query("SHOW COLUMNS FROM questions LIKE 'type'");
        $column = $stmt ? $stmt->fetch() : null;
        if ($stmt) $stmt->closeCursor();
        $type = is_array($column) ? (string)($column['Type'] ?? '') : '';
        if ($type !== '' && stripos($type, 'varchar') === false) {
            $pdo->exec("ALTER TABLE questions MODIFY type VARCHAR(32) NOT NULL");
        }
    } catch (Throwable $e) {
        // Best effort; the ADD COLUMN calls below are independently guarded.
    }
    db_add_column_if_missing($pdo, 'questions', 'word_limit', 'INT NULL AFTER marks');
    // Per-question penalty for a wrong auto-graded answer. Defaults to 0, so every existing
    // question keeps its current all-or-nothing (never negative) grading until an admin opts in.
    // DECIMAL (not INT) so fractional penalties (0.25, 0.5) are storable — see
    // ensure_marks_decimal_schema() for the migration that widens a pre-existing INT column.
    db_add_column_if_missing($pdo, 'questions', 'negative_marks', 'DECIMAL(8,2) NOT NULL DEFAULT 0 AFTER marks');
    db_add_column_if_missing($pdo, 'questions', 'answer_key_json', 'JSON NULL AFTER correct_option_index');
    db_add_column_if_missing($pdo, 'questions', 'match_options_json', 'JSON NULL AFTER answer_key_json');
    db_add_column_if_missing($pdo, 'session_answers', 'answer_json', 'JSON NULL AFTER answer_option_index');
}

/**
 * Widen an existing INT column to DECIMAL(8,2) in place, if it isn't already decimal. Idempotent —
 * the type check makes repeat calls a no-op, so it's cheap to run from every request.
 */
function db_widen_to_decimal_if_needed(PDO $pdo, string $table, string $column, string $definition): void {
    try {
        $stmt = $pdo->prepare("SHOW COLUMNS FROM {$table} LIKE ?");
        $stmt->execute([$column]);
        $col = $stmt->fetch();
        $stmt->closeCursor();
        $type = is_array($col) ? (string)($col['Type'] ?? '') : '';
        if ($type !== '' && stripos($type, 'decimal') === false) {
            $pdo->exec("ALTER TABLE {$table} MODIFY {$column} {$definition}");
        }
    } catch (Throwable $e) {
        // Best effort; normal query errors still surface elsewhere.
    }
}

/**
 * questions.negative_marks was originally INT, so a penalty could only ever be a whole number —
 * an admin wanting to deduct half or a quarter mark for a wrong answer couldn't. Widens it (and
 * every column that carries a value derived from it: session_answers.awarded_marks,
 * exam_sessions.total_score/max_score, result_audit_logs' before/after snapshot) to DECIMAL(8,2)
 * on an existing database. No data loss — every value already stored is a whole number, which a
 * DECIMAL column represents exactly.
 */
function ensure_marks_decimal_schema(PDO $pdo): void {
    db_widen_to_decimal_if_needed($pdo, 'questions', 'negative_marks', 'DECIMAL(8,2) NOT NULL DEFAULT 0');
    db_widen_to_decimal_if_needed($pdo, 'session_answers', 'awarded_marks', 'DECIMAL(8,2) NULL');
    db_widen_to_decimal_if_needed($pdo, 'exam_sessions', 'total_score', 'DECIMAL(8,2) NULL');
    db_widen_to_decimal_if_needed($pdo, 'exam_sessions', 'max_score', 'DECIMAL(8,2) NULL');
    if (db_table_exists($pdo, 'result_audit_logs')) {
        db_widen_to_decimal_if_needed($pdo, 'result_audit_logs', 'previous_awarded_marks', 'DECIMAL(8,2) NULL');
        db_widen_to_decimal_if_needed($pdo, 'result_audit_logs', 'new_awarded_marks', 'DECIMAL(8,2) NULL');
    }
}

/**
 * Free-text types that are graded by a human, never auto-scored. An unanswered/ungraded
 * one leaves the whole attempt "pending manual grading" (mirrors legacy TEXT behaviour).
 */
function is_manual_question_type(string $type): bool {
    $t = strtoupper($type);
    return $t === 'SHORT_TEXT' || $t === 'LONG_TEXT' || $t === 'TEXT';
}

/**
 * Normalise a free-text token for case/'whitespace-insensitive comparison
 * (FILL_BLANK accepted answers, etc.).
 */
function grade_norm_text(string $value): string {
    return function_exists('mb_strtolower')
        ? mb_strtolower(trim($value))
        : strtolower(trim($value));
}

/**
 * Authoritative auto-grader — the single source of truth used by both the session
 * autosave (api/sessions.php) and the results scorer/regrader (api/results.php).
 *
 * $q must contain: type, marks, negative_marks, correct_option_index, answer_key_json (raw JSON or null).
 * The student's answer is supplied in whichever form the type uses:
 *   - $answerOptionIndex: MCQ / TRUE_FALSE / YES_NO
 *   - $answerJson (array): MULTI_SELECT, FILL_BLANK, ORDERING (list); MATCHING, DRAG_DROP (map)
 *   - $answerText: NUMERIC, DATE, TIME (and the manual free-text types)
 *
 * Grading is all-or-nothing: full marks when the whole answer is correct, and (if the question
 * has negative_marks set) minus that many marks when it was ANSWERED but wrong — never for a
 * skipped question, which always returns null/null below and is never penalized.
 * Returns ['isCorrect' => 0|1|null, 'awarded' => int|float|null]. Manual (free-text) types
 * and unanswered questions return null/null so a human can grade them later.
 */
function grade_question(array $q, $answerText, $answerOptionIndex, $answerJson): array {
    $type = strtoupper((string)($q['type'] ?? ''));
    $marks = (int)($q['marks'] ?? 0);
    $negativeMarks = max(0.0, (float)($q['negative_marks'] ?? 0));
    $none = ['isCorrect' => null, 'awarded' => null];

    // Manual free-text types are never auto-scored.
    if ($type === 'SHORT_TEXT' || $type === 'LONG_TEXT' || $type === 'TEXT') {
        return $none;
    }

    $key = null;
    if (isset($q['answer_key_json']) && $q['answer_key_json'] !== null && $q['answer_key_json'] !== '') {
        $decoded = is_array($q['answer_key_json']) ? $q['answer_key_json'] : json_decode((string)$q['answer_key_json'], true);
        if (is_array($decoded)) $key = $decoded;
    }

    $correct = false;

    switch ($type) {
        case 'MCQ':
        case 'TRUE_FALSE':
        case 'YES_NO':
            if ($answerOptionIndex === null || $q['correct_option_index'] === null) return $none;
            $correct = ((int)$answerOptionIndex === (int)$q['correct_option_index']);
            break;

        case 'MULTI_SELECT': {
            if (!is_array($answerJson) || !is_array($key['correctIndices'] ?? null)) return $none;
            $picked = array_values(array_unique(array_map('intval', $answerJson)));
            $expected = array_values(array_unique(array_map('intval', $key['correctIndices'])));
            sort($picked); sort($expected);
            $correct = ($picked === $expected);
            break;
        }

        case 'FILL_BLANK': {
            $blanks = $key['blanks'] ?? null;
            if (!is_array($answerJson) || !is_array($blanks) || count($blanks) === 0) return $none;
            $correct = true;
            foreach ($blanks as $i => $blank) {
                $accepted = array_map('grade_norm_text', array_map('strval', $blank['accepted'] ?? []));
                $student = grade_norm_text((string)($answerJson[$i] ?? ''));
                if ($student === '' || !in_array($student, $accepted, true)) { $correct = false; break; }
            }
            break;
        }

        case 'NUMERIC': {
            if ($answerText === null || trim((string)$answerText) === '' || !isset($key['value'])) return $none;
            if (!is_numeric($answerText) || !is_numeric($key['value'])) { $correct = false; break; }
            $tol = isset($key['tolerance']) && is_numeric($key['tolerance']) ? abs((float)$key['tolerance']) : 0.0;
            $correct = (abs((float)$answerText - (float)$key['value']) <= $tol + 1e-9);
            break;
        }

        case 'DATE':
        case 'TIME': {
            if ($answerText === null || trim((string)$answerText) === '' || !isset($key['value'])) return $none;
            $correct = (trim((string)$answerText) === trim((string)$key['value']));
            break;
        }

        case 'MATCHING': {
            $pairs = $key['pairs'] ?? null;
            if (!is_array($answerJson) || !is_array($pairs)) return $none;
            $correct = true;
            foreach ($pairs as $leftIdx => $rightIdx) {
                if (!array_key_exists($leftIdx, $answerJson) || (int)$answerJson[$leftIdx] !== (int)$rightIdx) { $correct = false; break; }
            }
            // No extra/foreign pairs allowed.
            if ($correct && count($answerJson) !== count($pairs)) $correct = false;
            break;
        }

        case 'ORDERING': {
            $order = $key['order'] ?? null;
            if (!is_array($answerJson) || !is_array($order)) return $none;
            $correct = (array_map('intval', array_values($answerJson)) === array_map('intval', array_values($order)));
            break;
        }

        case 'DRAG_DROP': {
            $placements = $key['placements'] ?? null;
            if (!is_array($answerJson) || !is_array($placements)) return $none;
            $correct = true;
            foreach ($placements as $itemIdx => $bucketIdx) {
                if (!array_key_exists($itemIdx, $answerJson) || (int)$answerJson[$itemIdx] !== (int)$bucketIdx) { $correct = false; break; }
            }
            if ($correct && count($answerJson) !== count($placements)) $correct = false;
            break;
        }

        default:
            return $none;
    }

    return ['isCorrect' => $correct ? 1 : 0, 'awarded' => $correct ? $marks : -$negativeMarks];
}

function humanize_identifier(string $value): string {
    $normalized = trim(preg_replace('/[^A-Za-z0-9]+/', ' ', $value) ?? '');
    if ($normalized === '') {
        return 'User';
    }
    return ucwords(strtolower($normalized));
}

/**
 * Question banks: reusable, company-owned collections of questions. Bank questions are ordinary rows
 * in the shared `questions` table (global ids) and are linked into any number of exams through
 * exam_questions, so one upload serves many exams. Exams never copy a bank question; editing it in the
 * bank changes it everywhere it is used. Idempotent — call from every endpoint that touches banks.
 */
function ensure_question_bank_schema(PDO $pdo): void {
    $pdo->exec("CREATE TABLE IF NOT EXISTS question_banks (
      id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      company_id  INT UNSIGNED NOT NULL,
      name        VARCHAR(255) NOT NULL,
      description TEXT NULL,
      created_by  VARCHAR(255) NULL,
      created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_question_banks_company_name (company_id, name),
      INDEX idx_question_banks_company (company_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
    $pdo->exec("CREATE TABLE IF NOT EXISTS question_bank_items (
      bank_id       BIGINT UNSIGNED NOT NULL,
      question_id   VARCHAR(64) COLLATE utf8mb4_unicode_ci NOT NULL,
      display_order INT NOT NULL DEFAULT 0,
      added_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (bank_id, question_id),
      INDEX idx_question_bank_items_question (question_id),
      CONSTRAINT fk_question_bank_items_bank FOREIGN KEY (bank_id) REFERENCES question_banks(id) ON DELETE CASCADE,
      CONSTRAINT fk_question_bank_items_question FOREIGN KEY (question_id) REFERENCES questions(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
}

/** Ids (subset of $questionIds) that belong to any question bank — the exam editor must not rewrite these. */
function question_bank_owned_ids(PDO $pdo, array $questionIds): array {
    $questionIds = array_values(array_unique(array_filter(array_map('strval', $questionIds), static fn($id) => $id !== '')));
    if (count($questionIds) === 0 || !db_table_exists($pdo, 'question_bank_items')) {
        return [];
    }
    $ph = implode(',', array_fill(0, count($questionIds), '?'));
    $stmt = $pdo->prepare("SELECT DISTINCT question_id FROM question_bank_items WHERE question_id IN ($ph)");
    $stmt->execute($questionIds);
    $ids = array_map(static fn($r) => (string)$r['question_id'], $stmt->fetchAll());
    $stmt->closeCursor();
    return $ids;
}

/**
 * Per-exam proctoring switches (Exam.proctoringConfig.mode / showAlerts / autoTerminate). The
 * defaults reproduce the behaviour every existing exam already has: proctored, alerts shown to the
 * candidate, and the attempt ended when a violation limit is reached.
 */
function ensure_exam_proctoring_mode_columns(PDO $pdo): void {
    db_add_column_if_missing($pdo, 'exams', 'proctoring_mode', "VARCHAR(16) NOT NULL DEFAULT 'PROCTORED'");
    db_add_column_if_missing($pdo, 'exams', 'show_violation_alerts', 'TINYINT(1) NOT NULL DEFAULT 1');
    db_add_column_if_missing($pdo, 'exams', 'auto_terminate', 'TINYINT(1) NOT NULL DEFAULT 1');
}

/**
 * Email-driven exam requests. An authorised employee (exam_requesters: one per email address, each
 * with its own security code, stored only as a password_hash) emails a filled-in template to the
 * platform mailbox; scripts/mail_intake.py hands each message to scripts/exam_request_intake.php,
 * which records it here as PENDING (or INVALID with reasons). A SUPER_ADMIN reviews, edits and
 * approves it in the Exam Requests tab, which creates the exam. Idempotent.
 */
function ensure_exam_request_schema(PDO $pdo): void {
    $pdo->exec("CREATE TABLE IF NOT EXISTS exam_requesters (
      id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      company_id      INT UNSIGNED NOT NULL,
      name            VARCHAR(255) NOT NULL,
      email           VARCHAR(255) NOT NULL,
      code_hash       VARCHAR(255) NOT NULL,
      code_hint       VARCHAR(16) NULL,
      status          ENUM('ACTIVE','DISABLED') NOT NULL DEFAULT 'ACTIVE',
      created_by      VARCHAR(255) NULL,
      created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      last_request_at TIMESTAMP NULL,
      PRIMARY KEY (id),
      UNIQUE KEY uq_exam_requesters_email (email),
      INDEX idx_exam_requesters_company (company_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
    $pdo->exec("CREATE TABLE IF NOT EXISTS exam_requests (
      id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      company_id      INT UNSIGNED NULL,
      requester_id    BIGINT UNSIGNED NULL,
      sender_email    VARCHAR(255) NOT NULL,
      sender_name     VARCHAR(255) NULL,
      subject         VARCHAR(512) NULL,
      message_hash    CHAR(64) NOT NULL,
      status          ENUM('PENDING','APPROVED','REJECTED','INVALID') NOT NULL DEFAULT 'PENDING',
      details_json    JSON NULL,
      students_json   JSON NULL,
      errors_json     JSON NULL,
      body_redacted   MEDIUMTEXT NULL,
      received_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      reviewed_by     VARCHAR(255) NULL,
      reviewed_at     TIMESTAMP NULL,
      review_note     TEXT NULL,
      created_exam_id VARCHAR(64) NULL,
      PRIMARY KEY (id),
      UNIQUE KEY uq_exam_requests_message (message_hash),
      INDEX idx_exam_requests_status (status, received_at),
      INDEX idx_exam_requests_company (company_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
}

/**
 * Short exam links: "<origin>/x/<code>" instead of the ~170-character "<origin>/?token=<signed token>"
 * (the long link is unwieldy in WhatsApp/SMS and gets mangled by mail clients). The code is an opaque,
 * random, case-sensitive 10-char base62 handle on (exam, student, company); api/link.php swaps it for
 * the SAME signed token the long link carries (mint_exam_access_token() is deterministic), so the
 * student page then runs the unchanged ?token= flow and every server-side check still applies.
 * One code per (exam, student, company) — get-or-create, so every resend reuses the same link.
 */
function ensure_exam_short_link_schema(PDO $pdo): void {
    $pdo->exec("CREATE TABLE IF NOT EXISTS exam_short_links (
      code         VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      exam_id      VARCHAR(64) NOT NULL,
      student_id   VARCHAR(64) NOT NULL,
      company_id   INT UNSIGNED NOT NULL,
      created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_used_at TIMESTAMP NULL,
      use_count    INT NOT NULL DEFAULT 0,
      PRIMARY KEY (code),
      UNIQUE KEY uq_exam_short_links_target (exam_id, student_id, company_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
}

function exam_short_link_schema_once(PDO $pdo): void {
    static $done = false;
    if (!$done) {
        ensure_exam_short_link_schema($pdo);
        $done = true;
    }
}

function exam_short_random_code(int $length = 10): string {
    $alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
    $code = '';
    for ($i = 0; $i < $length; $i++) {
        $code .= $alphabet[random_int(0, 61)];
    }
    return $code;
}

/**
 * Get-or-create the short code for one (exam, student, company). Race-safe: two concurrent callers
 * may both try to insert, the unique key lets exactly one win, and the loser re-reads the winner's
 * code. A (vanishingly rare) random collision on the code itself just retries with a new one.
 */
function exam_short_code(PDO $pdo, string $eid, string $sid, int $cid): string {
    exam_short_link_schema_once($pdo);
    $select = $pdo->prepare('SELECT code FROM exam_short_links WHERE exam_id = ? AND student_id = ? AND company_id = ? LIMIT 1');
    $find = static function () use ($select, $eid, $sid, $cid): ?string {
        $select->execute([$eid, $sid, $cid]);
        $code = $select->fetchColumn();
        $select->closeCursor();
        return $code !== false && $code !== null ? (string)$code : null;
    };
    $existing = $find();
    if ($existing !== null) {
        return $existing;
    }
    $insert = $pdo->prepare('INSERT INTO exam_short_links (code, exam_id, student_id, company_id) VALUES (?, ?, ?, ?)');
    for ($attempt = 0; $attempt < 6; $attempt++) {
        $code = exam_short_random_code();
        try {
            $insert->execute([$code, $eid, $sid, $cid]);
            $insert->closeCursor();
            return $code;
        } catch (PDOException $e) {
            $insert->closeCursor();
            if ((int)($e->errorInfo[1] ?? 0) !== 1062) {
                throw $e;
            }
            $existing = $find(); // someone else created this target's code first
            if ($existing !== null) {
                return $existing;
            }
            // otherwise the random code itself collided — try another
        }
    }
    throw new RuntimeException('Could not allocate a short exam link.');
}

/**
 * Bulk get-or-create for one exam: [studentId => companyId] in, [studentId => code] out. Two queries
 * per 500 students instead of two per student, for invitation batches and the Links CSV. Students
 * that still have no code after the retries are simply missing from the result (callers fall back to
 * the long ?token= link).
 */
function exam_short_codes(PDO $pdo, string $eid, array $studentCompanies): array {
    exam_short_link_schema_once($pdo);
    $codes = [];
    foreach (array_chunk($studentCompanies, 500, true) as $chunk) {
        for ($attempt = 0; $attempt < 4 && count($chunk) > 0; $attempt++) {
            $sids = array_map('strval', array_keys($chunk));
            $ph = implode(',', array_fill(0, count($sids), '?'));
            $stmt = $pdo->prepare("SELECT code, student_id, company_id FROM exam_short_links WHERE exam_id = ? AND student_id IN ($ph)");
            $stmt->execute(array_merge([$eid], $sids));
            foreach ($stmt->fetchAll() as $row) {
                $sid = (string)$row['student_id'];
                if (isset($chunk[$sid]) && (int)$chunk[$sid] === (int)$row['company_id']) {
                    $codes[$sid] = (string)$row['code'];
                    unset($chunk[$sid]);
                }
            }
            $stmt->closeCursor();
            if (count($chunk) === 0) {
                break;
            }
            // INSERT IGNORE: a row that loses a race (target already coded) or hits a code collision
            // is skipped silently, and the re-read on the next pass picks up whatever won.
            $values = [];
            $params = [];
            foreach ($chunk as $sid => $cid) {
                $values[] = '(?, ?, ?, ?)';
                array_push($params, exam_short_random_code(), $eid, (string)$sid, (int)$cid);
            }
            $ins = $pdo->prepare('INSERT IGNORE INTO exam_short_links (code, exam_id, student_id, company_id) VALUES ' . implode(',', $values));
            $ins->execute($params);
            $ins->closeCursor();
        }
    }
    return $codes;
}

/** The long, always-valid fallback link: "<origin>/?token=<signed token>". */
function exam_token_link(string $origin, string $eid, string $sid, int $cid): string {
    return rtrim($origin, '/') . '/?token=' . mint_exam_access_token($eid, $sid, $cid);
}

/**
 * The candidate's exam link: "<origin>/x/<code>", or — if the short code can't be created for any
 * reason — the long "<origin>/?token=..." link, so a link is always produced.
 */
function exam_access_link(PDO $pdo, string $origin, string $eid, string $sid, int $cid): string {
    try {
        return rtrim($origin, '/') . '/x/' . exam_short_code($pdo, $eid, $sid, $cid);
    } catch (Throwable $e) {
        error_log('[short-link] falling back to token link: ' . $e->getMessage());
        return exam_token_link($origin, $eid, $sid, $cid);
    }
}

/**
 * Normalise a phone number for WhatsApp to bare international digits (e.g. "919876543210"), or null
 * when it can't be a valid number. Accepts the usual ways people type numbers: "+91 98765 43210",
 * "0091-98765-43210", "098765 43210" (national trunk 0) and a bare 10-digit number, which gets
 * $defaultCc prefixed. A number written with an explicit "+" or "00" is already international and is
 * never given the default country code. Letters (e.g. Excel's "9.18E+11") make it invalid.
 */
function normalize_mobile(?string $raw, string $defaultCc = '91'): ?string {
    if ($raw === null) {
        return null;
    }
    $value = trim($raw);
    if ($value === '' || preg_match('/^\+?[0-9\s\-().\/]+$/', $value) !== 1) {
        return null;
    }
    $international = $value[0] === '+';
    $digits = (string)preg_replace('/\D+/', '', $value);
    if (!$international && strncmp($digits, '00', 2) === 0) {
        $international = true;
        $digits = substr($digits, 2);
    } elseif (!$international && strncmp($digits, '0', 1) === 0) {
        $digits = substr($digits, 1); // a single national trunk prefix
    }
    $cc = (string)preg_replace('/\D+/', '', $defaultCc);
    if (!$international && strlen($digits) === 10 && $cc !== '') {
        $digits = $cc . $digits;
    }
    $len = strlen($digits);
    if ($len < 8 || $len > 15 || $digits[0] === '0') {
        return null;
    }
    return $digits;
}

/**
 * WhatsApp notifications (api/whatsapp.php). Adds the optional mobile columns and lets delivery_logs
 * record channel WHATSAPP. Returns which pieces are available, checked fresh (db_column_exists()
 * caches, so it can't be used to confirm a column added in this same request). Idempotent and cheap:
 * the enum is only altered when 'WHATSAPP' is missing, and appending an enum member is a
 * metadata-only change. sp_add_delivery_log still only takes EMAIL/SMS and is deliberately left
 * alone — WhatsApp rows are written with a direct INSERT (see whatsapp_log_delivery()).
 */
function ensure_whatsapp_schema(PDO $pdo): array {
    $hasColumn = static function (string $table, string $column) use ($pdo): bool {
        try {
            $stmt = $pdo->prepare("SHOW COLUMNS FROM {$table} LIKE ?");
            $stmt->execute([$column]);
            $exists = (bool)$stmt->fetch();
            $stmt->closeCursor();
            return $exists;
        } catch (Throwable $e) {
            return false;
        }
    };
    $state = ['studentsMobile' => false, 'requestersMobile' => false, 'deliveryChannel' => false];

    $state['studentsMobile'] = $hasColumn('students', 'mobile');
    if (!$state['studentsMobile']) {
        try {
            $pdo->exec('ALTER TABLE students ADD COLUMN mobile VARCHAR(20) NULL');
        } catch (Throwable $e) {
            // Best effort; re-checked below (a concurrent request may have added it first).
        }
        $state['studentsMobile'] = $hasColumn('students', 'mobile');
    }

    if (db_table_exists($pdo, 'exam_requesters')) {
        $state['requestersMobile'] = $hasColumn('exam_requesters', 'mobile');
        if (!$state['requestersMobile']) {
            try {
                $pdo->exec('ALTER TABLE exam_requesters ADD COLUMN mobile VARCHAR(20) NULL');
            } catch (Throwable $e) {
                // Best effort.
            }
            $state['requestersMobile'] = $hasColumn('exam_requesters', 'mobile');
        }
    }

    try {
        $stmt = $pdo->query("SHOW FULL COLUMNS FROM delivery_logs LIKE 'channel'");
        $col = $stmt ? $stmt->fetch() : null;
        if ($stmt) $stmt->closeCursor();
        $type = is_array($col) ? (string)($col['Type'] ?? '') : '';
        if (stripos($type, "'WHATSAPP'") !== false) {
            $state['deliveryChannel'] = true;
        } elseif (preg_match('/^enum\((.*)\)$/i', $type, $m) === 1) {
            // Keep every existing member (in order) and append WHATSAPP, with the same collation and
            // nullability, so the change stays metadata-only.
            preg_match_all("/'((?:[^']|'')*)'/", $m[1], $members);
            $list = array_map(static fn($v) => "'" . str_replace("'", "''", str_replace("''", "'", $v)) . "'", $members[1]);
            $list[] = "'WHATSAPP'";
            $collation = (string)($col['Collation'] ?? '');
            $collateSql = preg_match('/^[A-Za-z0-9_]+$/', $collation) === 1
                ? ' CHARACTER SET ' . explode('_', $collation)[0] . ' COLLATE ' . $collation
                : '';
            $nullSql = strtoupper((string)($col['Null'] ?? 'NO')) === 'YES' ? ' NULL' : ' NOT NULL';
            $sql = 'ALTER TABLE delivery_logs MODIFY channel ENUM(' . implode(',', $list) . ')' . $collateSql . $nullSql;
            try {
                $pdo->exec($sql . ', ALGORITHM=INSTANT');
            } catch (Throwable $e) {
                $pdo->exec($sql);
            }
            $state['deliveryChannel'] = true;
        }
    } catch (Throwable $e) {
        // Best effort: whatsapp_log_delivery() swallows its own failure if the enum is still missing.
    }
    return $state;
}

function ensure_company_directory_schema(PDO $pdo): void {
    try {
        $pdo->exec("CREATE TABLE IF NOT EXISTS companies (
            id            INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
            code          VARCHAR(64) NOT NULL,
            name          VARCHAR(255) NOT NULL,
            contact_name  VARCHAR(255) NULL,
            contact_email VARCHAR(255) NULL,
            status        ENUM('ACTIVE','INACTIVE') NOT NULL DEFAULT 'ACTIVE',
            notes         TEXT NULL,
            created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            UNIQUE KEY uq_companies_code (code)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");

        $stmt = $pdo->query("SELECT COUNT(*) AS cnt FROM companies WHERE id = 1");
        $exists = $stmt ? (int)($stmt->fetch()['cnt'] ?? 0) : 0;
        if ($stmt) {
            $stmt->closeCursor();
        }
        if ($exists === 0) {
            $insert = $pdo->prepare("INSERT INTO companies (id, code, name, contact_name, contact_email, status)
                                     VALUES (1, 'default', 'Default Company', 'Platform Admin', NULL, 'ACTIVE')");
            $insert->execute();
            $insert->closeCursor();
        }
    } catch (Throwable $e) {
        // Best effort schema bootstrap.
    }
}

function list_seed_super_admin_emails(array $env): array {
    $raw = trim((string)($env['SUPER_ADMIN_EMAILS'] ?? $env['VITE_SUPER_ADMIN_EMAILS'] ?? ''));
    if ($raw === '') {
        return [];
    }
    $emails = array_filter(array_map(static fn($item) => strtolower(trim((string)$item)), explode(',', $raw)));
    return array_values(array_unique(array_filter($emails, static fn($item) => strpos($item, '@') !== false)));
}

function ensure_platform_user_schema(PDO $pdo, array $env): void {
    try {
        $pdo->exec("CREATE TABLE IF NOT EXISTS platform_users (
            id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
            company_id       INT UNSIGNED NULL,
            role             ENUM('SUPER_ADMIN','ADMIN','VIEWER','PROCTOR','STUDENT') NOT NULL,
            full_name        VARCHAR(255) NOT NULL,
            email            VARCHAR(255) NOT NULL,
            status           ENUM('ACTIVE','INVITED','DISABLED') NOT NULL DEFAULT 'ACTIVE',
            registration_id  VARCHAR(128) NULL,
            external_auth_id VARCHAR(128) NULL,
            password_hash    VARCHAR(255) NULL,
            password_updated_at TIMESTAMP NULL,
            notes            TEXT NULL,
            created_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            UNIQUE KEY uq_platform_users_email (email),
            KEY idx_platform_users_company_role (company_id, role),
            KEY idx_platform_users_status (status)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");

        db_add_column_if_missing($pdo, 'platform_users', 'registration_id', "VARCHAR(128) NULL AFTER status");
        db_add_column_if_missing($pdo, 'platform_users', 'external_auth_id', "VARCHAR(128) NULL AFTER registration_id");
        // Local credential store: non-super-admin staff authenticate against OUR database
        // (super admins continue to authenticate via the external LSC auth service).
        db_add_column_if_missing($pdo, 'platform_users', 'password_hash', "VARCHAR(255) NULL AFTER external_auth_id");
        db_add_column_if_missing($pdo, 'platform_users', 'password_updated_at', "TIMESTAMP NULL AFTER password_hash");
        db_add_column_if_missing($pdo, 'platform_users', 'notes', "TEXT NULL AFTER password_updated_at");

        // Ensure the role enum includes the read-only VIEWER role on already-provisioned databases.
        // Only ALTER when VIEWER is actually missing: this runs on EVERY API request, and an
        // unconditional ALTER TABLE (even a no-op one) takes an exclusive metadata lock on
        // platform_users, forces an implicit commit and is written to the binlog each time.
        $roleStmt = $pdo->query("SHOW COLUMNS FROM platform_users LIKE 'role'");
        $roleCol = $roleStmt ? $roleStmt->fetch() : null;
        if ($roleStmt) $roleStmt->closeCursor();
        $roleType = is_array($roleCol) ? (string)($roleCol['Type'] ?? '') : '';
        if ($roleType !== '' && stripos($roleType, 'VIEWER') === false) {
            $pdo->exec("ALTER TABLE platform_users MODIFY role ENUM('SUPER_ADMIN','ADMIN','VIEWER','PROCTOR','STUDENT') NOT NULL");
        }

        foreach (list_seed_super_admin_emails($env) as $email) {
            $seed = $pdo->prepare("INSERT INTO platform_users (company_id, role, full_name, email, status)
                                   SELECT NULL, 'SUPER_ADMIN', ?, ?, 'ACTIVE'
                                   FROM DUAL
                                   WHERE NOT EXISTS (SELECT 1 FROM platform_users WHERE email = ? LIMIT 1)");
            $seed->execute([
                humanize_identifier(strtok($email, '@') ?: 'Super Admin'),
                $email,
                $email,
            ]);
            $seed->closeCursor();
        }
    } catch (Throwable $e) {
        // Best effort schema bootstrap.
    }
}

set_error_handler(function (int $severity, string $message, string $file, int $line): void {
    if (!(error_reporting() & $severity)) {
        return;
    }
    throw new ErrorException($message, 0, $severity, $file, $line);
});

set_exception_handler(function (Throwable $e): void {
    // The raw message is logged server-side only. Echoing it leaked SQL/schema details and data
    // values (e.g. "SQLSTATE[23000] ... Duplicate entry 'x@y.com' for key ...") to the browser,
    // where several admin screens render the error body verbatim. The `ref` ties the generic
    // response to the log line.
    $ref = bin2hex(random_bytes(4));
    error_log(sprintf('[proctor-api %s] %s: %s in %s:%d', $ref, get_class($e), $e->getMessage(), $e->getFile(), $e->getLine()));
    if ($e instanceof PDOException && (string)$e->getCode() === '23000') {
        $driverCode = (int)($e->errorInfo[1] ?? 0);
        if ($driverCode === 1062) {
            json_response(['error' => 'A record with the same unique value already exists.', 'ref' => $ref], 409);
        }
        if ($driverCode === 1451 || $driverCode === 1452) {
            json_response(['error' => 'This change conflicts with related records.', 'ref' => $ref], 409);
        }
    }
    json_response([
        'error' => 'Server error.',
        'ref' => $ref,
    ], 500);
});

function audit_log(PDO $pdo, array $entry): void {
    try {
        $companyId = $entry['companyId'] ?? get_company_id($entry['payload'] ?? null);
        if ($companyId === null || $companyId <= 0) {
            return;
        }
        $actorRole = strtoupper((string)($entry['actorRole'] ?? 'SYSTEM'));
        if ($actorRole === 'SUPER_ADMIN') {
            // Keep audit writes compatible with older stored procedures that only accept ADMIN.
            $actorRole = 'ADMIN';
        }
        $actorId = $entry['actorId'] ?? null;
        $action = $entry['action'] ?? 'UNKNOWN';
        $targetType = $entry['targetType'] ?? null;
        $targetId = $entry['targetId'] ?? null;
        $message = $entry['message'] ?? null;
        $metadata = $entry['metadata'] ?? null;
        $ipAddress = $_SERVER['REMOTE_ADDR'] ?? null;
        $userAgent = $_SERVER['HTTP_USER_AGENT'] ?? null;

        $metadataJson = null;
        if (is_array($metadata) || is_object($metadata)) {
            $metadataJson = json_encode($metadata);
        } elseif (is_string($metadata)) {
            $metadataJson = $metadata;
        }

        // The routine's VARCHAR params are strict: an over-long value (e.g. a >512-char in-app
        // browser user agent, or a long email as actor id) made the whole CALL fail and the audit row
        // was silently dropped. Clip to the column widths instead.
        $clip = static function ($value, int $max) {
            if ($value === null) return null;
            $value = (string)$value;
            return function_exists('mb_substr') ? mb_substr($value, 0, $max) : substr($value, 0, $max);
        };
        $actorId = $clip($actorId, 64);
        $action = $clip($action, 64);
        $targetType = $clip($targetType, 64);
        $targetId = $clip($targetId, 64);
        $ipAddress = $clip($ipAddress, 64);
        $userAgent = $clip($userAgent, 512);

        // The live sp_add_audit's p_actor_role is ENUM('ADMIN','STUDENT','SYSTEM') (created under
        // STRICT_TRANS_TABLES), so every PROCTOR-attributed write (violation review, access-request
        // review, ...) errored inside the CALL and was swallowed below — audit_logs holds zero
        // PROCTOR rows. audit_logs.actor_role itself does accept PROCTOR, so roles the routine can't
        // take are written with the same INSERT the routine performs.
        if (!in_array($actorRole, ['ADMIN', 'STUDENT', 'SYSTEM'], true)) {
            $stmt = $pdo->prepare('INSERT INTO audit_logs (company_id, actor_role, actor_id, action, target_type, target_id, message, metadata, ip_address, user_agent)
                                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
            $stmt->execute([
                $companyId,
                $actorRole,
                $actorId,
                $action,
                $targetType,
                $targetId,
                $message,
                $metadataJson,
                $ipAddress,
                $userAgent
            ]);
            $stmt->closeCursor();
            return;
        }

        $stmt = $pdo->prepare('CALL sp_add_audit(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
        $stmt->execute([
            $companyId,
            $actorRole,
            $actorId,
            $action,
            $targetType,
            $targetId,
            $message,
            $metadataJson,
            $ipAddress,
            $userAgent
        ]);
        while ($stmt->nextRowset()) {}
        $stmt->closeCursor();
    } catch (Throwable $e) {
        // Best-effort audit logging; ignore failures.
    }
}

$env = load_env_files(ENV_PATHS);
// Expose the loaded env to helper functions (pg_env / token signing) that run without $env in scope.
$GLOBALS['__pg_env'] = $env;
// Force a single, deterministic timezone for ALL server-side time handling.
// PHP and MySQL must agree: exam start/end windows are written by PHP (ms_to_datetime)
// while session start/end and audit timestamps are written by MySQL NOW()/NOW(3).
// If the two clocks disagree (e.g. PHP in UTC but MySQL SYSTEM tz = Asia/Kolkata),
// timestamps drift by the tz offset and exam windows appear to open/close at the wrong
// time. We standardise on UTC everywhere; the frontend localises for display.
date_default_timezone_set('UTC');
$dbHost = $env['MYSQL_HOST'] ?? '127.0.0.1';
$dbPort = $env['MYSQL_PORT'] ?? '3306';
$dbName = $env['MYSQL_DATABASE'] ?? 'proctorguard';
$dbUser = $env['MYSQL_USER'] ?? 'root';
$dbPass = $env['MYSQL_PASSWORD'] ?? '';

try {
    $dsn = "mysql:host={$dbHost};port={$dbPort};dbname={$dbName};charset=utf8mb4";
    $pdo = new PDO($dsn, $dbUser, $dbPass, [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
    ]);
    $pdo->exec("SET NAMES utf8mb4 COLLATE utf8mb4_general_ci");
    // Pin the connection timezone to UTC so NOW()/NOW(3) (used for exam_sessions
    // start_time/end_time and audit logs) line up with the UTC wall-clock that PHP
    // writes for exam start_time/end_time. Without this, MySQL would fall back to its
    // SYSTEM timezone and diverge from PHP.
    $pdo->exec("SET time_zone = '+00:00'");
} catch (Throwable $e) {
    json_response(['error' => 'Database connection failed.'], 500);
}

ensure_audit_role_enum($pdo);
ensure_question_type_schema($pdo);
ensure_marks_decimal_schema($pdo);
ensure_company_directory_schema($pdo);
ensure_platform_user_schema($pdo, $env);
ensure_student_company_scoped_uniqueness($pdo);
