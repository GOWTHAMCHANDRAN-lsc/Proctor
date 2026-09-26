<?php
declare(strict_types=1);

require __DIR__ . '/_bootstrap.php';

// ---------------------------------------------------------------------------
// Company-scoped application settings (branding, exam defaults, UI prefs).
// One JSON blob per company so the whole admin team shares the same workspace.
// ---------------------------------------------------------------------------

function ensure_settings_schema(PDO $pdo): void {
    $pdo->exec("CREATE TABLE IF NOT EXISTS app_settings (
        company_id    INT UNSIGNED NOT NULL PRIMARY KEY,
        settings_json LONGTEXT NOT NULL,
        updated_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
}

function read_settings(PDO $pdo, int $companyId): ?array {
    $stmt = $pdo->prepare('SELECT settings_json FROM app_settings WHERE company_id = ? LIMIT 1');
    $stmt->execute([$companyId]);
    $row = $stmt->fetch();
    $stmt->closeCursor();
    if (!$row || !isset($row['settings_json'])) {
        return null;
    }
    $decoded = json_decode((string)$row['settings_json'], true);
    return is_array($decoded) ? $decoded : null;
}

ensure_settings_schema($pdo);
$method = $_SERVER['REQUEST_METHOD'];

if ($method === 'GET') {
    require_staff();
    $companyId = require_company_id();
    json_response(['settings' => read_settings($pdo, $companyId)]);
}

if ($method === 'POST') {
    $payload = json_input();
    require_role(['ADMIN'], $payload);
    $companyId = require_company_id($payload);

    // Accept either { settings: {...} } or a bare settings object.
    $settings = $payload['settings'] ?? $payload;
    if (!is_array($settings) || count($settings) === 0) {
        json_response(['error' => 'No settings provided.'], 400);
    }
    unset($settings['actorId'], $settings['actorRole'], $settings['companyId'], $settings['action']);

    $json = json_encode($settings, JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
    if ($json === false) {
        json_response(['error' => 'Settings could not be encoded.'], 400);
    }
    // Guard against oversized payloads (e.g. very large embedded logo data URLs).
    if (strlen($json) > 2 * 1024 * 1024) {
        json_response(['error' => 'Settings payload is too large. Use a smaller logo.'], 413);
    }

    $stmt = $pdo->prepare('INSERT INTO app_settings (company_id, settings_json)
                           VALUES (?, ?)
                           ON DUPLICATE KEY UPDATE settings_json = VALUES(settings_json)');
    $stmt->execute([$companyId, $json]);
    $stmt->closeCursor();

    audit_log($pdo, [
        'companyId' => $companyId,
        'actorRole' => 'ADMIN',
        'actorId' => get_actor_id($payload),
        'action' => 'SETTINGS_UPDATE',
        'targetType' => 'settings',
        'targetId' => (string)$companyId,
        'message' => 'Workspace settings updated',
    ]);

    json_response(['ok' => true, 'settings' => read_settings($pdo, $companyId)]);
}

json_response(['error' => 'Method not allowed.'], 405);
