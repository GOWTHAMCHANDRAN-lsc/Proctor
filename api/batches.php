<?php
declare(strict_types=1);

require __DIR__ . '/_bootstrap.php';

function has_column(PDO $pdo, string $table, string $column): bool {
    $stmt = $pdo->prepare("SELECT COUNT(*) AS cnt
                           FROM information_schema.COLUMNS
                           WHERE TABLE_SCHEMA = DATABASE()
                             AND TABLE_NAME = ?
                             AND COLUMN_NAME = ?");
    $stmt->execute([$table, $column]);
    $row = $stmt->fetch();
    $stmt->closeCursor();
    return ((int)($row['cnt'] ?? 0)) > 0;
}

function ensure_batch_schema(PDO $pdo): void {
    $pdo->exec("CREATE TABLE IF NOT EXISTS batches (
      id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      company_id  INT NOT NULL DEFAULT 1,
      name        VARCHAR(255) NOT NULL,
      description TEXT NULL,
      created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_batches_company_name (company_id, name)
    ) ENGINE=InnoDB");

    if (!has_column($pdo, 'students', 'batch_id')) {
        $pdo->exec("ALTER TABLE students ADD COLUMN batch_id BIGINT UNSIGNED NULL");
    }
}

function datetime_to_ms(?string $dt): ?int {
    if ($dt === null) {
        return null;
    }
    $ts = strtotime($dt);
    if ($ts === false) {
        return null;
    }
    $ms = (int)($ts * 1000);
    if (strpos($dt, '.') !== false) {
        $parts = explode('.', $dt, 2);
        $ms += (int)substr(str_pad($parts[1], 3, '0'), 0, 3);
    }
    return $ms;
}

function normalize_batch_row(array $row): array {
    return [
        'id' => (int)$row['id'],
        'companyId' => (int)$row['company_id'],
        'name' => (string)$row['name'],
        'description' => $row['description'] ?? null,
        'studentCount' => isset($row['student_count']) ? (int)$row['student_count'] : 0,
        'createdAt' => datetime_to_ms($row['created_at'] ?? null) ?? 0,
    ];
}

function list_batches(PDO $pdo, int $companyId): array {
    $stmt = $pdo->prepare("SELECT
                             b.id,
                             b.company_id,
                             b.name,
                             b.description,
                             b.created_at,
                             COUNT(s.id) AS student_count
                           FROM batches b
                           LEFT JOIN students s
                             ON s.batch_id = b.id
                            AND s.company_id = b.company_id
                           WHERE b.company_id = ?
                           GROUP BY b.id, b.company_id, b.name, b.description, b.created_at
                           ORDER BY b.created_at DESC, b.name ASC");
    $stmt->execute([$companyId]);
    $rows = $stmt->fetchAll();
    $stmt->closeCursor();
    return array_map('normalize_batch_row', $rows);
}

$method = $_SERVER['REQUEST_METHOD'];
ensure_batch_schema($pdo);

if ($method === 'GET') {
    $companyId = require_company_id();
    json_response(['batches' => list_batches($pdo, $companyId)]);
}

if ($method === 'POST') {
    $payload = json_input();
    require_role(['ADMIN'], $payload);
    $companyId = require_company_id($payload);
    $name = trim((string)($payload['name'] ?? ''));
    $description = trim((string)($payload['description'] ?? ''));

    if ($name === '') {
        json_response(['error' => 'Batch name is required.'], 400);
    }

    $check = $pdo->prepare("SELECT id, company_id, name, description, created_at
                            FROM batches
                            WHERE company_id = ? AND name = ?
                            LIMIT 1");
    $check->execute([$companyId, $name]);
    $existing = $check->fetch();
    $check->closeCursor();

    if ($existing) {
        json_response([
            'batch' => normalize_batch_row(array_merge($existing, ['student_count' => 0])),
            'created' => false,
        ]);
    }

    $insert = $pdo->prepare("INSERT INTO batches (company_id, name, description)
                             VALUES (?, ?, ?)");
    $insert->execute([$companyId, $name, $description !== '' ? $description : null]);
    $insert->closeCursor();

    $id = (int)$pdo->lastInsertId();
    $stmt = $pdo->prepare("SELECT id, company_id, name, description, created_at
                           FROM batches
                           WHERE id = ? AND company_id = ?
                           LIMIT 1");
    $stmt->execute([$id, $companyId]);
    $row = $stmt->fetch();
    $stmt->closeCursor();

    audit_log($pdo, [
        'companyId' => $companyId,
        'actorRole' => 'ADMIN',
        'actorId' => $payload['actor'] ?? null,
        'action' => 'BATCH_CREATE',
        'targetType' => 'batch',
        'targetId' => (string)$id,
        'message' => "Batch created: {$name}",
        'metadata' => ['description' => $description !== '' ? $description : null],
    ]);

    json_response([
        'batch' => normalize_batch_row(array_merge($row ?: [
            'id' => $id,
            'company_id' => $companyId,
            'name' => $name,
            'description' => $description !== '' ? $description : null,
            'created_at' => date('Y-m-d H:i:s'),
        ], ['student_count' => 0])),
        'created' => true,
    ]);
}

json_response(['error' => 'Method not allowed.'], 405);
