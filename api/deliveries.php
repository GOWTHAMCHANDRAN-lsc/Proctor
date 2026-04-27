<?php
declare(strict_types=1);

require __DIR__ . '/_bootstrap.php';

function datetime_to_ms(?string $dt): ?int {
    if ($dt === null) return null;
    $ts = strtotime($dt);
    if ($ts === false) return null;
    $ms = (int)($ts * 1000);
    if (strpos($dt, '.') !== false) {
        $parts = explode('.', $dt, 2);
        $ms += (int)substr(str_pad($parts[1], 3, '0'), 0, 3);
    }
    return $ms;
}

if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
    json_response(['error' => 'Method not allowed.'], 405);
}

$companyId = require_company_id();

$channel = isset($_GET['channel']) ? strtoupper(trim((string)$_GET['channel'])) : null;
$status = isset($_GET['status']) ? strtoupper(trim((string)$_GET['status'])) : null;
$limit = isset($_GET['limit']) ? (int)$_GET['limit'] : 100;
$offset = isset($_GET['offset']) ? (int)$_GET['offset'] : 0;

if ($channel === '') $channel = null;
if ($status === '') $status = null;
if (!in_array($channel, ['EMAIL', 'SMS'], true)) $channel = null;
if (!in_array($status, ['SENT', 'FAILED', 'SKIPPED'], true)) $status = null;
if ($limit <= 0) $limit = 100;
if ($limit > 500) $limit = 500;
if ($offset < 0) $offset = 0;

$sql = 'SELECT id, channel, recipient, subject, body, status, error, template_id, metadata, created_at
        FROM delivery_logs
        WHERE company_id = ?';
$params = [$companyId];
if ($channel !== null) {
    $sql .= ' AND channel = ?';
    $params[] = $channel;
}
if ($status !== null) {
    $sql .= ' AND status = ?';
    $params[] = $status;
}
$sql .= ' ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?';

$stmt = $pdo->prepare($sql);
foreach ($params as $index => $value) {
    $stmt->bindValue($index + 1, $value);
}
$stmt->bindValue(count($params) + 1, $limit, PDO::PARAM_INT);
$stmt->bindValue(count($params) + 2, $offset, PDO::PARAM_INT);
$stmt->execute();
$rows = $stmt->fetchAll();
$stmt->closeCursor();

$logs = array_map(function ($row) {
    $metadata = null;
    if (!empty($row['metadata'])) {
        $decoded = json_decode($row['metadata'], true);
        $metadata = json_last_error() === JSON_ERROR_NONE ? $decoded : null;
    }
    return [
        'id' => (int)$row['id'],
        'channel' => $row['channel'],
        'recipient' => $row['recipient'],
        'subject' => $row['subject'],
        'body' => $row['body'],
        'status' => $row['status'],
        'error' => $row['error'],
        'templateId' => $row['template_id'] !== null ? (int)$row['template_id'] : null,
        'metadata' => $metadata,
        'createdAt' => datetime_to_ms($row['created_at']) ?? 0,
    ];
}, $rows);

json_response(['logs' => $logs]);
