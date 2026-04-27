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

function has_index(PDO $pdo, string $table, string $indexName): bool {
    $stmt = $pdo->prepare("SELECT COUNT(*) AS cnt
                           FROM information_schema.STATISTICS
                           WHERE TABLE_SCHEMA = DATABASE()
                             AND TABLE_NAME = ?
                             AND INDEX_NAME = ?");
    $stmt->execute([$table, $indexName]);
    $row = $stmt->fetch();
    $stmt->closeCursor();
    return ((int)($row['cnt'] ?? 0)) > 0;
}

function ensure_student_batch_schema(PDO $pdo): void {
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

    if (!has_index($pdo, 'students', 'idx_students_company_batch')) {
        $pdo->exec("ALTER TABLE students ADD INDEX idx_students_company_batch (company_id, batch_id)");
    }
}

function normalize_company_label(int $companyId): string {
    return 'Company ' . $companyId;
}

function normalize_batch_name($value): ?string {
    $name = trim((string)$value);
    return $name !== '' ? $name : null;
}

function normalize_student_row(array $row): array {
    $companyId = (int)($row['company_id'] ?? $row['companyId'] ?? 0);
    $batchIdRaw = $row['batch_id'] ?? $row['batchId'] ?? null;
    $batchId = $batchIdRaw !== null ? (int)$batchIdRaw : null;
    $batch = $row['batch_name'] ?? $row['batch'] ?? null;
    $batch = $batch !== null ? trim((string)$batch) : null;
    if ($batch === '') {
        $batch = null;
    }

    return [
        'id' => (string)$row['id'],
        'fullName' => (string)($row['full_name'] ?? $row['fullName'] ?? ''),
        'email' => (string)$row['email'],
        'registrationId' => (string)($row['registration_id'] ?? $row['registrationId'] ?? ''),
        'companyId' => $companyId,
        'company' => normalize_company_label($companyId),
        'batchId' => $batchId,
        'batch' => $batch,
    ];
}

function fetch_students(PDO $pdo, int $companyId, bool $withBatchData): array {
    if ($withBatchData) {
        $stmt = $pdo->prepare("SELECT
                                 s.id,
                                 s.full_name,
                                 s.email,
                                 s.registration_id,
                                 s.company_id,
                                 s.batch_id,
                                 b.name AS batch_name
                               FROM students s
                               LEFT JOIN batches b
                                 ON b.id = s.batch_id
                                AND b.company_id = s.company_id
                               WHERE s.company_id = ?
                               ORDER BY COALESCE(b.name, ''), s.created_at DESC");
    } else {
        $stmt = $pdo->prepare("SELECT
                                 id,
                                 full_name,
                                 email,
                                 registration_id,
                                 company_id,
                                 NULL AS batch_id,
                                 NULL AS batch_name
                               FROM students
                               WHERE company_id = ?
                               ORDER BY created_at DESC");
    }

    $stmt->execute([$companyId]);
    $rows = $stmt->fetchAll();
    $stmt->closeCursor();
    return array_map('normalize_student_row', $rows);
}

function fetch_student_by_id(PDO $pdo, int $companyId, string $studentId, bool $withBatchData): ?array {
    if ($withBatchData) {
        $stmt = $pdo->prepare("SELECT
                                 s.id,
                                 s.full_name,
                                 s.email,
                                 s.registration_id,
                                 s.company_id,
                                 s.batch_id,
                                 b.name AS batch_name
                               FROM students s
                               LEFT JOIN batches b
                                 ON b.id = s.batch_id
                                AND b.company_id = s.company_id
                               WHERE s.company_id = ? AND s.id = ?
                               LIMIT 1");
    } else {
        $stmt = $pdo->prepare("SELECT
                                 id,
                                 full_name,
                                 email,
                                 registration_id,
                                 company_id,
                                 NULL AS batch_id,
                                 NULL AS batch_name
                               FROM students
                               WHERE company_id = ? AND id = ?
                               LIMIT 1");
    }

    $stmt->execute([$companyId, $studentId]);
    $row = $stmt->fetch();
    $stmt->closeCursor();
    return $row ? normalize_student_row($row) : null;
}

function find_batch_by_id(PDO $pdo, int $companyId, int $batchId): ?array {
    $stmt = $pdo->prepare("SELECT id, name
                           FROM batches
                           WHERE company_id = ? AND id = ?
                           LIMIT 1");
    $stmt->execute([$companyId, $batchId]);
    $row = $stmt->fetch();
    $stmt->closeCursor();
    return $row ?: null;
}

function find_or_create_batch(PDO $pdo, int $companyId, string $batchName): array {
    $stmt = $pdo->prepare("SELECT id, name
                           FROM batches
                           WHERE company_id = ? AND name = ?
                           LIMIT 1");
    $stmt->execute([$companyId, $batchName]);
    $row = $stmt->fetch();
    $stmt->closeCursor();
    if ($row) {
        return $row;
    }

    $insert = $pdo->prepare("INSERT INTO batches (company_id, name, description)
                             VALUES (?, ?, NULL)");
    $insert->execute([$companyId, $batchName]);
    $insert->closeCursor();

    $id = (int)$pdo->lastInsertId();
    $created = find_batch_by_id($pdo, $companyId, $id);
    if (!$created) {
        throw new RuntimeException('Failed to create batch.');
    }
    return $created;
}

function humanize_student_error(Throwable $e, string $registrationId, string $email): string {
    $message = trim($e->getMessage());
    if ($message === '') {
        return "Failed to save student {$registrationId}.";
    }
    if (stripos($message, 'Duplicate entry') !== false) {
        return "Duplicate student record for {$registrationId} / {$email}.";
    }
    return $message;
}

$method = $_SERVER['REQUEST_METHOD'];
$schemaReady = true;
try {
    ensure_student_batch_schema($pdo);
} catch (Throwable $e) {
    $schemaReady = false;
}

if ($method === 'GET') {
    $companyId = require_company_id();
    $students = fetch_students($pdo, $companyId, $schemaReady);
    json_response(['students' => $students]);
}

if ($method === 'POST') {
    $payload = json_input();
    require_role(['ADMIN'], $payload);
    $companyId = require_company_id($payload);
    $items = [];

    if (isset($payload['students']) && is_array($payload['students'])) {
        $items = $payload['students'];
    } elseif (!empty($payload)) {
        $isList = array_values($payload) === $payload;
        $items = $isList ? $payload : [$payload];
    }

    if (count($items) === 0) {
        json_response(['students' => [], 'errors' => ['No student data provided.']], 400);
    }

    $saved = [];
    $errors = [];

    foreach ($items as $item) {
        $fullName = trim((string)($item['fullName'] ?? ''));
        $email = trim((string)($item['email'] ?? ''));
        $registrationId = trim((string)($item['registrationId'] ?? ''));
        $batchName = normalize_batch_name($item['batch'] ?? ($item['batches'] ?? ''));
        $batchId = isset($item['batchId']) && $item['batchId'] !== null ? (int)$item['batchId'] : null;
        $itemCompanyId = isset($item['companyId']) ? (int)$item['companyId'] : null;

        if ($itemCompanyId !== null && $itemCompanyId > 0 && $itemCompanyId !== $companyId) {
            $errors[] = "Company mismatch for {$registrationId}. Company admins can upload only into their own company.";
            continue;
        }

        if ($fullName === '' || $email === '' || $registrationId === '') {
            $errors[] = 'Missing fields for student (fullName/email/registrationId required).';
            continue;
        }
        if (strpos($email, '@') === false) {
            $errors[] = "Invalid email format: {$email}";
            continue;
        }

        try {
            $resolvedBatchId = null;
            $resolvedBatchName = null;

            if ($schemaReady) {
                if ($batchId !== null && $batchId > 0) {
                    $existingBatch = find_batch_by_id($pdo, $companyId, $batchId);
                    if (!$existingBatch) {
                        throw new RuntimeException("Batch {$batchId} does not belong to this company.");
                    }
                    $resolvedBatchId = (int)$existingBatch['id'];
                    $resolvedBatchName = (string)$existingBatch['name'];
                } elseif ($batchName !== null) {
                    $existingBatch = find_or_create_batch($pdo, $companyId, $batchName);
                    $resolvedBatchId = (int)$existingBatch['id'];
                    $resolvedBatchName = (string)$existingBatch['name'];
                }
            }

            $existingStmt = $pdo->prepare("SELECT id
                                           FROM students
                                           WHERE company_id = ?
                                             AND (registration_id = ? OR email = ?)
                                           ORDER BY CASE WHEN registration_id = ? THEN 0 ELSE 1 END
                                           LIMIT 1");
            $existingStmt->execute([$companyId, $registrationId, $email, $registrationId]);
            $existing = $existingStmt->fetch();
            $existingStmt->closeCursor();

            if ($existing) {
                $studentId = (string)$existing['id'];
                if ($schemaReady) {
                    $update = $pdo->prepare("UPDATE students
                                             SET full_name = ?, email = ?, registration_id = ?, batch_id = ?
                                             WHERE id = ? AND company_id = ?");
                    $update->execute([$fullName, $email, $registrationId, $resolvedBatchId, $studentId, $companyId]);
                } else {
                    $update = $pdo->prepare("UPDATE students
                                             SET full_name = ?, email = ?, registration_id = ?
                                             WHERE id = ? AND company_id = ?");
                    $update->execute([$fullName, $email, $registrationId, $studentId, $companyId]);
                }
                $update->closeCursor();

                $row = fetch_student_by_id($pdo, $companyId, $studentId, $schemaReady);
                if ($row) {
                    if ($resolvedBatchName !== null) {
                        $row['batch'] = $resolvedBatchName;
                    }
                    $saved[] = $row;
                }

                audit_log($pdo, [
                    'companyId' => $companyId,
                    'actorRole' => 'ADMIN',
                    'actorId' => $payload['actor'] ?? null,
                    'action' => 'STUDENT_UPDATE',
                    'targetType' => 'student',
                    'targetId' => $studentId,
                    'message' => "Student updated: {$fullName}",
                    'metadata' => [
                        'email' => $email,
                        'registrationId' => $registrationId,
                        'batch' => $resolvedBatchName,
                    ],
                ]);
                continue;
            }

            $studentId = (string)($item['id'] ?? bin2hex(random_bytes(8)));
            if ($schemaReady) {
                $insert = $pdo->prepare("INSERT INTO students (id, company_id, full_name, email, registration_id, batch_id)
                                         VALUES (?, ?, ?, ?, ?, ?)");
                $insert->execute([$studentId, $companyId, $fullName, $email, $registrationId, $resolvedBatchId]);
            } else {
                $insert = $pdo->prepare("INSERT INTO students (id, company_id, full_name, email, registration_id)
                                         VALUES (?, ?, ?, ?, ?)");
                $insert->execute([$studentId, $companyId, $fullName, $email, $registrationId]);
            }
            $insert->closeCursor();

            $row = fetch_student_by_id($pdo, $companyId, $studentId, $schemaReady);
            if ($row) {
                if ($resolvedBatchName !== null) {
                    $row['batch'] = $resolvedBatchName;
                }
                $saved[] = $row;
            }

            audit_log($pdo, [
                'companyId' => $companyId,
                'actorRole' => 'ADMIN',
                'actorId' => $payload['actor'] ?? null,
                'action' => 'STUDENT_CREATE',
                'targetType' => 'student',
                'targetId' => $studentId,
                'message' => "Student created: {$fullName}",
                'metadata' => [
                    'email' => $email,
                    'registrationId' => $registrationId,
                    'batch' => $resolvedBatchName,
                ],
            ]);
        } catch (Throwable $e) {
            $errors[] = humanize_student_error($e, $registrationId, $email);
        }
    }

    json_response(['students' => $saved, 'errors' => $errors]);
}

json_response(['error' => 'Method not allowed.'], 405);
