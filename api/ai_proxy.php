<?php
declare(strict_types=1);

/**
 * Proxy for the Python AI proctoring microservice.
 * Forwards requests to http://127.0.0.1:8765 and returns the response.
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
header('Access-Control-Allow-Headers: Content-Type');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
header('X-Content-Type-Options: nosniff');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(204);
    exit;
}

$endpoint = trim($_GET['endpoint'] ?? '');
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

$method  = $_SERVER['REQUEST_METHOD'];
$aiUrl   = 'http://127.0.0.1:8765/' . ltrim($endpoint, '/');
$body    = file_get_contents('php://input');
$timeout = 25;

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
