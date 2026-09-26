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

// Biometric enrollment columns (shared with enrollment.php). Idempotent.
function ensure_student_enrollment_schema(PDO $pdo): void {
    if (!has_column($pdo, 'students', 'face_descriptor')) {
        $pdo->exec("ALTER TABLE students ADD COLUMN face_descriptor TEXT NULL");
    }
    if (!has_column($pdo, 'students', 'face_photo')) {
        $pdo->exec("ALTER TABLE students ADD COLUMN face_photo MEDIUMTEXT NULL");
    }
    if (!has_column($pdo, 'students', 'enrolled_at')) {
        $pdo->exec("ALTER TABLE students ADD COLUMN enrolled_at TIMESTAMP NULL DEFAULT NULL");
    }
}

function normalize_company_label(int $companyId): string {
    return 'Company ' . $companyId;
}

function normalize_batch_name($value): ?string {
    $name = trim((string)$value);
    return $name !== '' ? $name : null;
}

function normalize_student_row(array $row, array $batches = []): array {
    $companyId = (int)($row['company_id'] ?? $row['companyId'] ?? 0);
    $enrolledAt = $row['enrolled_at'] ?? null;

    return [
        'id' => (string)$row['id'],
        'fullName' => (string)($row['full_name'] ?? $row['fullName'] ?? ''),
        'email' => (string)$row['email'],
        'registrationId' => (string)($row['registration_id'] ?? $row['registrationId'] ?? ''),
        'companyId' => $companyId,
        'company' => normalize_company_label($companyId),
        'batches' => $batches,
        'enrolled' => !empty($enrolledAt),
        'enrolledAt' => $enrolledAt !== null ? (string)$enrolledAt : null,
    ];
}

function fetch_students(PDO $pdo, int $companyId, bool $withBatchData, bool $enrollReady = false): array {
    $enrolledExpr = $enrollReady ? 'enrolled_at' : 'NULL';
    $stmt = $pdo->prepare("SELECT
                             id,
                             full_name,
                             email,
                             registration_id,
                             company_id,
                             {$enrolledExpr} AS enrolled_at
                           FROM students
                           WHERE company_id = ?
                           ORDER BY created_at DESC");
    $stmt->execute([$companyId]);
    $rows = $stmt->fetchAll();
    $stmt->closeCursor();

    $batchesMap = $withBatchData ? fetch_student_batches_map($pdo, $companyId) : [];
    $students = array_map(
        static fn($row) => normalize_student_row($row, $batchesMap[(string)$row['id']] ?? []),
        $rows
    );

    if ($withBatchData) {
        usort($students, static function (array $a, array $b): int {
            $aName = $a['batches'][0]['name'] ?? '';
            $bName = $b['batches'][0]['name'] ?? '';
            return strcmp($aName, $bName);
        });
    }

    return $students;
}

function fetch_student_by_id(PDO $pdo, int $companyId, string $studentId, bool $withBatchData): ?array {
    $stmt = $pdo->prepare("SELECT
                             id,
                             full_name,
                             email,
                             registration_id,
                             company_id
                           FROM students
                           WHERE company_id = ? AND id = ?
                           LIMIT 1");
    $stmt->execute([$companyId, $studentId]);
    $row = $stmt->fetch();
    $stmt->closeCursor();
    if (!$row) {
        return null;
    }

    $batches = $withBatchData ? get_student_batches($pdo, $studentId) : [];
    return normalize_student_row($row, $batches);
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
    ensure_student_batches_schema($pdo);
} catch (Throwable $e) {
    $schemaReady = false;
}

$enrollReady = false;
try {
    ensure_student_enrollment_schema($pdo);
    $enrollReady = has_column($pdo, 'students', 'enrolled_at');
} catch (Throwable $e) {
    $enrollReady = false;
}

if ($method === 'GET') {
    $examTokenClaims = current_exam_token_claims();

    if ($examTokenClaims !== null) {
        // Student access via signed exam link token — return ONLY the student this token grants access to.
        $tokenStudentId = (string)$examTokenClaims['sid'];
        $tokenCompanyId = (int)$examTokenClaims['cid'];
        $student = fetch_student_by_id($pdo, $tokenCompanyId, $tokenStudentId, $schemaReady);
        if (!$student) {
            json_response(['error' => 'Student not found.'], 404);
        }
        json_response(['students' => [$student]]);
    }

    require_staff(); // admin-only read: blocks tokenless/forged-header access
    $companyId = require_company_id();
    $students = fetch_students($pdo, $companyId, $schemaReady, $enrollReady);
    json_response(['students' => $students]);
}

if ($method === 'POST') {
    $payload = json_input();
    // SUPER_ADMIN may act on any company (companyId comes from the request payload);
    // a regular ADMIN is pinned to its own company. require_role() accepts SUPER_ADMIN
    // wherever ADMIN is allowed.
    $actorRole = require_role(['SUPER_ADMIN', 'ADMIN'], $payload);

    // Resolve the company being acted upon. A regular ADMIN is pinned to its own company (from the
    // X-Company-Id header). A SUPER_ADMIN may target ANY company — but "current company" can be set
    // in three places (the top switcher's header, this page's selector, and the batch), which is the
    // source of the "Batch N does not belong to this company" confusion. The batch a student is added
    // to is the most specific, explicit choice, so when a batchId is present we take the company
    // straight from that batch. Otherwise fall back to explicit companyId → per-student companyId →
    // header.
    if ($actorRole === 'SUPER_ADMIN') {
        $hintBatchId = isset($payload['batchId']) ? (int)$payload['batchId'] : 0;
        if ($hintBatchId <= 0 && isset($payload['students']) && is_array($payload['students'])) {
            foreach ($payload['students'] as $s) {
                if (is_array($s) && (int)($s['batchId'] ?? 0) > 0) { $hintBatchId = (int)$s['batchId']; break; }
            }
        }
        $companyId = 0;
        if ($schemaReady && $hintBatchId > 0) {
            $bStmt = $pdo->prepare("SELECT company_id FROM batches WHERE id = ? LIMIT 1");
            $bStmt->execute([$hintBatchId]);
            $bRow = $bStmt->fetch();
            $bStmt->closeCursor();
            if ($bRow) {
                $companyId = (int)$bRow['company_id'];
            }
        }
        if ($companyId <= 0 && isset($payload['companyId'])) {
            $companyId = (int)$payload['companyId'];
        }
        if ($companyId <= 0 && isset($payload['students']) && is_array($payload['students'])) {
            foreach ($payload['students'] as $s) {
                if (is_array($s) && isset($s['companyId']) && (int)$s['companyId'] > 0) {
                    $companyId = (int)$s['companyId'];
                    break;
                }
            }
        }
        if ($companyId <= 0) {
            $companyId = (int)(get_company_id($payload) ?? 0);
        }
        if ($companyId <= 0) {
            json_response(['error' => 'Select a company before managing students.'], 400);
        }
    } else {
        $companyId = require_company_id($payload);
    }

    // Delete a single student (company-scoped). Sessions, answers and exam
    // assignments cascade automatically via foreign keys.
    $action = strtolower(trim((string)($payload['action'] ?? '')));
    if ($action === 'delete') {
        $studentId = trim((string)($payload['id'] ?? $payload['studentId'] ?? ''));
        if ($studentId === '') {
            json_response(['error' => 'Student id is required.'], 400);
        }

        $check = $pdo->prepare('SELECT id, full_name FROM students WHERE id = ? AND company_id = ? LIMIT 1');
        $check->execute([$studentId, $companyId]);
        $existing = $check->fetch();
        $check->closeCursor();
        if (!$existing) {
            json_response(['error' => 'Student not found for this company.'], 404);
        }

        $delete = $pdo->prepare('DELETE FROM students WHERE id = ? AND company_id = ?');
        $delete->execute([$studentId, $companyId]);
        $delete->closeCursor();

        audit_log($pdo, [
            'companyId' => $companyId,
            'actorRole' => $actorRole,
            'actorId' => get_actor_id($payload),
            'action' => 'STUDENT_DELETE',
            'targetType' => 'student',
            'targetId' => $studentId,
            'message' => 'Student deleted: ' . (string)($existing['full_name'] ?? $studentId),
        ]);

        json_response(['ok' => true, 'id' => $studentId]);
    }

    // Remove a student from a single batch (non-destructive — the student and their
    // other batch enrollments are untouched). Distinct from 'delete' above.
    if ($action === 'unenroll') {
        $studentId = trim((string)($payload['studentId'] ?? $payload['id'] ?? ''));
        $batchId = (int)($payload['batchId'] ?? 0);
        if ($studentId === '' || $batchId <= 0) {
            json_response(['error' => 'studentId and batchId are required.'], 400);
        }

        $check = $pdo->prepare('SELECT id, full_name FROM students WHERE id = ? AND company_id = ? LIMIT 1');
        $check->execute([$studentId, $companyId]);
        $existing = $check->fetch();
        $check->closeCursor();
        if (!$existing) {
            json_response(['error' => 'Student not found for this company.'], 404);
        }

        $batch = find_batch_by_id($pdo, $companyId, $batchId);
        if (!$batch) {
            json_response(['error' => 'Batch not found for this company.'], 404);
        }

        remove_student_batch($pdo, $studentId, $batchId);

        audit_log($pdo, [
            'companyId' => $companyId,
            'actorRole' => $actorRole,
            'actorId' => get_actor_id($payload),
            'action' => 'STUDENT_UNENROLL',
            'targetType' => 'student',
            'targetId' => $studentId,
            'message' => 'Student removed from batch: ' . (string)($existing['full_name'] ?? $studentId) . ' / ' . (string)$batch['name'],
        ]);

        $row = fetch_student_by_id($pdo, $companyId, $studentId, $schemaReady);
        json_response(['ok' => true, 'id' => $studentId, 'student' => $row]);
    }

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
        // Store emails in canonical lowercase — addresses uploaded in ALL CAPS or Mixed
        // Case resolve to the same mailbox, so normalise on both create and update.
        $email = strtolower(trim((string)($item['email'] ?? '')));
        $registrationId = trim((string)($item['registrationId'] ?? ''));
        $batchName = normalize_batch_name($item['batch'] ?? '');
        $batchId = isset($item['batchId']) && $item['batchId'] !== null ? (int)$item['batchId'] : null;
        $itemCompanyId = isset($item['companyId']) ? (int)$item['companyId'] : null;

        // A regular ADMIN is pinned to their own company, so a per-student companyId that points
        // elsewhere is rejected. A SUPER_ADMIN's target company is already resolved above (from the
        // chosen batch), so a stale per-student companyId from the UI must not block them.
        if ($actorRole !== 'SUPER_ADMIN' && $itemCompanyId !== null && $itemCompanyId > 0 && $itemCompanyId !== $companyId) {
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

            // Matched separately (not "registration_id = ? OR email = ?" in one query) because that
            // single-query OR silently picked ONE row whenever the two fields resolved to TWO
            // DIFFERENT existing students (e.g. a placeholder/shared email reused across many real
            // students) and then overwrote it — clobbering an unrelated student's name/registration ID.
            $byRegStmt = $pdo->prepare("SELECT id, email, registration_id FROM students WHERE company_id = ? AND registration_id = ? LIMIT 1");
            $byRegStmt->execute([$companyId, $registrationId]);
            $byReg = $byRegStmt->fetch();
            $byRegStmt->closeCursor();

            $byEmailStmt = $pdo->prepare("SELECT id, email, registration_id FROM students WHERE company_id = ? AND email = ? LIMIT 1");
            $byEmailStmt->execute([$companyId, $email]);
            $byEmail = $byEmailStmt->fetch();
            $byEmailStmt->closeCursor();

            if ($byReg && $byEmail && $byReg['id'] !== $byEmail['id']) {
                $errors[] = "Row skipped for {$registrationId} / {$email}: registration ID belongs to one existing student and this email belongs to a different one. Fix the mismatch and re-upload this row.";
                continue;
            }

            $existing = $byReg ?: $byEmail;

            if ($existing) {
                $studentId = (string)$existing['id'];
                $update = $pdo->prepare("UPDATE students
                                         SET full_name = ?, email = ?, registration_id = ?
                                         WHERE id = ? AND company_id = ?");
                $update->execute([$fullName, $email, $registrationId, $studentId, $companyId]);
                $update->closeCursor();

                // Adds the enrollment rather than moving the student — this is what lets the
                // same person belong to more than one batch.
                if ($schemaReady && $resolvedBatchId !== null) {
                    add_student_batch($pdo, $studentId, $resolvedBatchId);
                }

                $row = fetch_student_by_id($pdo, $companyId, $studentId, $schemaReady);
                if ($row) {
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
            $insert = $pdo->prepare("INSERT INTO students (id, company_id, full_name, email, registration_id)
                                     VALUES (?, ?, ?, ?, ?)");
            $insert->execute([$studentId, $companyId, $fullName, $email, $registrationId]);
            $insert->closeCursor();

            if ($schemaReady && $resolvedBatchId !== null) {
                add_student_batch($pdo, $studentId, $resolvedBatchId);
            }

            $row = fetch_student_by_id($pdo, $companyId, $studentId, $schemaReady);
            if ($row) {
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
