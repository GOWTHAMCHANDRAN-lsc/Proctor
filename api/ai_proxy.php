<?php
declare(strict_types=1);

/**
 * Proxy for the Python AI proctoring microservice.
 * Forwards requests to http://127.0.0.1:8765 and returns the response.
 *
 * Only a candidate taking an exam may use it: every call except /health must carry the candidate's
 * signed exam token (X-Exam-Token, verified here with the same HMAC as _bootstrap.php
 * exam_token_signature()). Without this anyone could tie up the AI workers live exams depend on, or
 * feed frames into another candidate's behaviour tracking (sessionKey) to raise false violations —
 * so the sessionKey is also pinned to the token's exam + student. This file deliberately doesn't load
 * _bootstrap.php: it runs for every analysed frame and needs no database.
 */

header('Content-Type: application/json');

// Restrict CORS to the configured origins (see _bootstrap.php) instead of a wildcard.
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
    header('Access-Control-Allow-Origin: ' . (($origin !== '' && in_array($origin, $allowed, true)) ? $origin : $allowed[0]));
})();
header('Access-Control-Allow-Headers: Content-Type, X-Exam-Token');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
header('X-Content-Type-Options: nosniff');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(204);
    exit;
}

// `?endpoint[]=x` makes this an array; trim(array) is a fatal TypeError (uncaught here — this file has
// no JSON error handler), so coerce non-strings to '' and let the validation below reject it.
$endpoint = is_string($_GET['endpoint'] ?? null) ? trim($_GET['endpoint']) : '';
if ($endpoint === '' || !preg_match('/^[a-z_\/]+$/', $endpoint)) {
    http_response_code(400);
    echo json_encode(['error' => 'Invalid endpoint.']);
    exit;
}

$allowed = ['health', 'analyze', 'enroll', 'verify'];
$base    = explode('/', $endpoint)[0];
if (!in_array($base, $allowed, true)) {
    http_response_code(400);
    echo json_encode(['error' => 'Endpoint not allowed.']);
    exit;
}

/** SESSION_SECRET from .env (same loader rules as _bootstrap.php: KEY=value, optional "quotes"). */
$sessionSecret = (static function (): string {
    $envFile = __DIR__ . '/../.env';
    if (!is_readable($envFile)) return '';
    foreach (file($envFile, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) as $line) {
        $line = trim($line);
        if (strncmp($line, 'SESSION_SECRET=', 15) === 0) {
            $value = trim(substr($line, 15));
            if ($value !== '' && $value[0] === '"' && substr($value, -1) === '"') $value = substr($value, 1, -1);
            return $value;
        }
    }
    return '';
})();

/** Claims of a validly signed exam token ({eid, sid, cid}), or null. */
$examClaims = (static function (string $secret): ?array {
    $raw = trim((string)($_SERVER['HTTP_X_EXAM_TOKEN'] ?? ''));
    if ($raw === '' || $secret === '' || strlen($raw) > 4096) return null;
    $decoded = json_decode((string)base64_decode(strtr($raw, '-_', '+/')), true);
    if (!is_array($decoded)) return null;
    $eid = (string)($decoded['eid'] ?? '');
    $sid = (string)($decoded['sid'] ?? '');
    $cid = (int)($decoded['cid'] ?? 0);
    $sig = (string)($decoded['sig'] ?? '');
    if ($eid === '' || $sid === '' || $cid <= 0 || $sig === '') return null;
    $expected = rtrim(strtr(base64_encode(hash_hmac('sha256', $eid . '|' . $sid . '|' . $cid, $secret, true)), '+/', '-_'), '=');
    return hash_equals($expected, $sig) ? ['eid' => $eid, 'sid' => $sid, 'cid' => $cid] : null;
})($sessionSecret);

if ($base !== 'health' && $examClaims === null) {
    http_response_code(401);
    echo json_encode(['error' => 'A valid exam link is required.']);
    exit;
}

$method  = $_SERVER['REQUEST_METHOD'];
$aiUrl   = 'http://127.0.0.1:8765/' . ltrim($endpoint, '/');
$body    = file_get_contents('php://input');

// Pin the behaviour-tracking key to this candidate: whatever key the page sends is namespaced by the
// token's exam + student, so nobody else's frames can land in their history.
if ($base === 'analyze' && $examClaims !== null && $body !== '' && $body !== false) {
    $json = json_decode($body, true);
    if (is_array($json)) {
        $clientKey = is_string($json['sessionKey'] ?? null) ? substr($json['sessionKey'], 0, 120) : '';
        $json['sessionKey'] = $examClaims['eid'] . '|' . $examClaims['sid'] . '|' . $clientKey;
        $body = (string)json_encode($json, JSON_UNESCAPED_SLASHES);
    }
}
// Slightly above the browser's own abort (services/aiProctor.ts: 5 s analyze, 8 s verify, 12 s batch
// enroll). PHP can't see that the browser gave up, so a longer timeout just kept an FPM worker
// blocked on a frame nobody was waiting for — under load that starves every other PHP API.
$timeout = $base === 'enroll' ? 14 : 10;

$ch = curl_init($aiUrl);
curl_setopt_array($ch, [
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_TIMEOUT        => $timeout,
    CURLOPT_CONNECTTIMEOUT => 5,
    CURLOPT_CUSTOMREQUEST  => $method,
    CURLOPT_HTTPHEADER     => ['Content-Type: application/json'],
    CURLOPT_POSTFIELDS     => ($method === 'POST' && $body !== '') ? $body : null,
]);

$result  = curl_exec($ch);
$status  = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
$err     = curl_error($ch);
curl_close($ch);

if ($result === false) {
    http_response_code(503);
    echo json_encode(['error' => 'AI service unavailable: ' . $err]);
    exit;
}

http_response_code($status > 0 ? $status : 200);
echo $result;
