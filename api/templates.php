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

$method = $_SERVER['REQUEST_METHOD'];

if ($method === 'GET') {
    require_staff();
    $companyId = require_company_id();
    $channel = isset($_GET['channel']) ? strtoupper(trim((string)$_GET['channel'])) : null;
    if ($channel === '') $channel = null;
    if ($channel !== null && !in_array($channel, ['EMAIL', 'SMS'], true)) {
        $channel = null;
    }

    $sql = 'SELECT id, name, channel, subject, body, is_default, created_at, updated_at
            FROM notification_templates
            WHERE company_id = ?';
    $params = [$companyId];
    if ($channel !== null) {
        $sql .= ' AND channel = ?';
        $params[] = $channel;
    }
    $sql .= ' ORDER BY updated_at DESC, id DESC';

    $stmt = $pdo->prepare($sql);
    $stmt->execute($params);
    $rows = $stmt->fetchAll();
    $stmt->closeCursor();

    $templates = array_map(function ($row) {
        return [
            'id' => (int)$row['id'],
            'name' => $row['name'],
            'channel' => $row['channel'],
            'subject' => $row['subject'],
            'body' => $row['body'],
            'isDefault' => (bool)$row['is_default'],
            'createdAt' => datetime_to_ms($row['created_at']) ?? 0,
            'updatedAt' => datetime_to_ms($row['updated_at']) ?? 0,
        ];
    }, $rows);

    json_response(['templates' => $templates]);
}

if ($method === 'POST') {
    $payload = json_input();
    require_role(['ADMIN'], $payload);
    $companyId = require_company_id($payload);
    if (isset($payload['action']) && strtoupper((string)$payload['action']) === 'DELETE') {
        $id = isset($payload['id']) ? (int)$payload['id'] : 0;
        if ($id <= 0) {
            json_response(['error' => 'Template id required.'], 400);
        }
        $stmt = $pdo->prepare('DELETE FROM notification_templates WHERE company_id = ? AND id = ?');
        $stmt->execute([$companyId, $id]);
        $stmt->closeCursor();

        audit_log($pdo, [
            'companyId' => $companyId,
            'actorRole' => 'ADMIN',
            'actorId' => $payload['actor'] ?? null,
            'action' => 'TEMPLATE_DELETE',
            'targetType' => 'template',
            'targetId' => (string)$id,
            'message' => 'Template deleted'
        ]);

        json_response(['ok' => true]);
    }

    $template = $payload['template'] ?? $payload;
    if (!is_array($template)) {
        json_response(['error' => 'Invalid template payload.'], 400);
    }

    $id = isset($template['id']) ? (int)$template['id'] : 0;
    $name = trim((string)($template['name'] ?? ''));
    $channel = strtoupper(trim((string)($template['channel'] ?? 'EMAIL')));
    $subject = isset($template['subject']) ? trim((string)$template['subject']) : null;
    $body = trim((string)($template['body'] ?? ''));
    $isDefault = !empty($template['isDefault']) ? 1 : 0;

    if ($name === '' || $body === '') {
        json_response(['error' => 'Template name and body are required.'], 400);
    }
    if (!in_array($channel, ['EMAIL', 'SMS'], true)) {
        $channel = 'EMAIL';
    }
    if ($channel === 'SMS') {
        $subject = null;
    }

    if ($isDefault === 1) {
        $reset = $pdo->prepare('UPDATE notification_templates SET is_default = 0 WHERE company_id = ? AND channel = ?');
        $reset->execute([$companyId, $channel]);
        $reset->closeCursor();
    }

    if ($id > 0) {
        $save = $pdo->prepare('UPDATE notification_templates
                               SET name = ?, channel = ?, subject = ?, body = ?, is_default = ?
                               WHERE company_id = ? AND id = ?');
        $save->execute([$name, $channel, $subject, $body, $isDefault, $companyId, $id]);
        $save->closeCursor();
    } else {
        $save = $pdo->prepare('INSERT INTO notification_templates (company_id, name, channel, subject, body, is_default)
                               VALUES (?, ?, ?, ?, ?, ?)');
        $save->execute([$companyId, $name, $channel, $subject, $body, $isDefault]);
        $id = (int)$pdo->lastInsertId();
        $save->closeCursor();
    }

    audit_log($pdo, [
        'companyId' => $companyId,
        'actorRole' => 'ADMIN',
        'actorId' => $template['actor'] ?? null,
        'action' => 'TEMPLATE_SAVE',
        'targetType' => 'template',
        'targetId' => $id > 0 ? (string)$id : null,
        'message' => "Template saved: {$name}",
        'metadata' => ['channel' => $channel, 'isDefault' => (bool)$isDefault]
    ]);

    json_response(['ok' => true]);
}

if ($method === 'DELETE') {
    $payload = json_input();
    require_role(['ADMIN'], $payload);
    $companyId = require_company_id($payload);
    $id = isset($payload['id']) ? (int)$payload['id'] : 0;
    if ($id <= 0) {
        json_response(['error' => 'Template id required.'], 400);
    }
    $stmt = $pdo->prepare('DELETE FROM notification_templates WHERE company_id = ? AND id = ?');
    $stmt->execute([$companyId, $id]);
    $stmt->closeCursor();

    audit_log($pdo, [
        'companyId' => $companyId,
        'actorRole' => 'ADMIN',
        'actorId' => $payload['actor'] ?? null,
        'action' => 'TEMPLATE_DELETE',
        'targetType' => 'template',
        'targetId' => (string)$id,
        'message' => 'Template deleted'
    ]);

    json_response(['ok' => true]);
}

json_response(['error' => 'Method not allowed.'], 405);
