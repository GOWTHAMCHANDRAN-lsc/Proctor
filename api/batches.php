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

    ensure_student_batches_schema($pdo);
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
        'companyName' => isset($row['company_name']) ? (string)$row['company_name'] : null,
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
                             COUNT(DISTINCT sb.student_id) AS student_count
                           FROM batches b
                           LEFT JOIN student_batches sb
                             ON sb.batch_id = b.id
                           WHERE b.company_id = ?
                           GROUP BY b.id, b.company_id, b.name, b.description, b.created_at
                           ORDER BY b.created_at DESC, b.name ASC");
    $stmt->execute([$companyId]);
    $rows = $stmt->fetchAll();
    $stmt->closeCursor();
    return array_map('normalize_batch_row', $rows);
}

// SUPER_ADMIN scope: every company's batches in one list, tagged with the owning
// company's name so the UI can group them. Ordered by company then batch so the
// grouped rendering stays stable.
function list_all_batches(PDO $pdo): array {
    $companyNameJoin = db_table_exists($pdo, 'companies') ? 'LEFT JOIN companies c ON c.id = b.company_id' : '';
    $companyNameCol = $companyNameJoin !== '' ? 'c.name AS company_name' : 'NULL AS company_name';
    $stmt = $pdo->query("SELECT
                           b.id,
                           b.company_id,
                           b.name,
                           b.description,
                           b.created_at,
                           {$companyNameCol},
                           COUNT(DISTINCT sb.student_id) AS student_count
                         FROM batches b
                         {$companyNameJoin}
                         LEFT JOIN student_batches sb
                           ON sb.batch_id = b.id
                         GROUP BY b.id, b.company_id, b.name, b.description, b.created_at, company_name
                         ORDER BY company_name IS NULL, company_name ASC, b.company_id ASC, b.created_at DESC, b.name ASC");
    $rows = $stmt->fetchAll();
    $stmt->closeCursor();
    return array_map('normalize_batch_row', $rows);
}

$method = $_SERVER['REQUEST_METHOD'];
ensure_batch_schema($pdo);

if ($method === 'GET') {
    require_staff(); // admin-only read: blocks tokenless/forged-header access
    // A SUPER_ADMIN may request every company's batches at once (scope=all) — used by the
    // exam builder so batches from all companies can be assigned from a single list. Any other
    // caller (or a super admin without scope=all) stays pinned to a single company.
    $scopeAll = isset($_GET['scope']) && strtolower(trim((string)$_GET['scope'])) === 'all';
    if ($scopeAll && get_actor_role() === 'SUPER_ADMIN') {
        json_response(['batches' => list_all_batches($pdo)]);
    }
    $companyId = require_company_id();
    json_response(['batches' => list_batches($pdo, $companyId)]);
}

if ($method === 'POST') {
    $payload = json_input();
    $actorRole = require_role(['SUPER_ADMIN', 'ADMIN'], $payload);

    // Company resolution mirrors students.php. A regular ADMIN is pinned to its own company (the
    // X-Company-Id header). A SUPER_ADMIN may target any company — but "current company" lives in
    // several places (top switcher header, page selector), which caused batch scope confusion. For a
    // DELETE we take the company straight from the batch being deleted (unambiguous); for a CREATE we
    // use the explicit companyId sent by the page.
    $action = strtolower(trim((string)($payload['action'] ?? '')));

    // Delete a batch (company-scoped). Students keep their records but are
    // moved back to "Unassigned"; exam-to-batch links are cleared.
    if ($action === 'delete') {
        $batchId = (int)($payload['id'] ?? $payload['batchId'] ?? 0);
        if ($batchId <= 0) {
            json_response(['error' => 'Batch id is required.'], 400);
        }

        if ($actorRole === 'SUPER_ADMIN') {
            $bStmt = $pdo->prepare('SELECT company_id FROM batches WHERE id = ? LIMIT 1');
            $bStmt->execute([$batchId]);
            $bRow = $bStmt->fetch();
            $bStmt->closeCursor();
            $companyId = $bRow ? (int)$bRow['company_id'] : (int)($payload['companyId'] ?? (get_company_id($payload) ?? 0));
        } else {
            $companyId = require_company_id($payload);
        }

        $check = $pdo->prepare('SELECT id, name FROM batches WHERE id = ? AND company_id = ? LIMIT 1');
        $check->execute([$batchId, $companyId]);
        $existing = $check->fetch();
        $check->closeCursor();
        if (!$existing) {
            json_response(['error' => 'Batch not found for this company.'], 404);
        }

        $unassign = $pdo->prepare('DELETE sb FROM student_batches sb
                                   JOIN students s ON s.id = sb.student_id
                                   WHERE sb.batch_id = ? AND s.company_id = ?');
        $unassign->execute([$batchId, $companyId]);
        $unassigned = $unassign->rowCount();
        $unassign->closeCursor();

        if (db_table_exists($pdo, 'exam_batch_assignments')) {
            $clearLinks = $pdo->prepare('DELETE FROM exam_batch_assignments WHERE batch_id = ?');
            $clearLinks->execute([$batchId]);
            $clearLinks->closeCursor();
        }

        $delete = $pdo->prepare('DELETE FROM batches WHERE id = ? AND company_id = ?');
        $delete->execute([$batchId, $companyId]);
        $delete->closeCursor();

        audit_log($pdo, [
            'companyId' => $companyId,
            'actorRole' => $actorRole,
            'actorId' => get_actor_id($payload),
            'action' => 'BATCH_DELETE',
            'targetType' => 'batch',
            'targetId' => (string)$batchId,
            'message' => 'Batch deleted: ' . (string)($existing['name'] ?? $batchId),
            'metadata' => ['unassignedStudents' => $unassigned],
        ]);

        json_response(['ok' => true, 'id' => $batchId, 'unassignedStudents' => $unassigned]);
    }

    // Create/upsert a batch — a SUPER_ADMIN targets the explicitly selected company.
    if ($actorRole === 'SUPER_ADMIN') {
        $companyId = (int)($payload['companyId'] ?? 0);
        if ($companyId <= 0) {
            $companyId = (int)(get_company_id($payload) ?? 0);
        }
        if ($companyId <= 0) {
            json_response(['error' => 'Select a company before creating a batch.'], 400);
        }
    } else {
        $companyId = require_company_id($payload);
    }

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
        'actorRole' => $actorRole,
        'actorId' => get_actor_id($payload),
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
