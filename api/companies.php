<?php
declare(strict_types=1);

require_once __DIR__ . '/_bootstrap.php';

$method = $_SERVER['REQUEST_METHOD'];

function normalize_company_payload(array $payload): array {
    $code = strtolower(trim((string)($payload['code'] ?? '')));
    $code = preg_replace('/[^a-z0-9]+/', '-', $code) ?? '';
    $code = trim($code, '-');
    if ($code === '') {
        $nameSeed = trim((string)($payload['name'] ?? 'company'));
        $code = strtolower(trim((string)(preg_replace('/[^A-Za-z0-9]+/', '-', $nameSeed) ?? 'company'), '-'));
    }

    return [
        'name' => trim((string)($payload['name'] ?? '')),
        'code' => $code,
        'contactName' => trim((string)($payload['contactName'] ?? '')),
        'contactEmail' => trim((string)($payload['contactEmail'] ?? '')),
        'status' => strtoupper(trim((string)($payload['status'] ?? 'ACTIVE'))),
        'notes' => trim((string)($payload['notes'] ?? '')),
    ];
}

function company_table_count(PDO $pdo, string $table, int $companyId, string $extraWhere = '', array $extraParams = []): int {
    if (!db_table_exists($pdo, $table)) {
        return 0;
    }

    $clauses = [];
    $params = [];
    if (db_column_exists($pdo, $table, 'company_id')) {
        $clauses[] = 'company_id = ?';
        $params[] = $companyId;
    } elseif ($companyId !== 1) {
        return 0;
    }

    if ($extraWhere !== '') {
        $clauses[] = $extraWhere;
        $params = array_merge($params, $extraParams);
    }

    $sql = "SELECT COUNT(*) FROM {$table}";
    if ($clauses !== []) {
        $sql .= ' WHERE ' . implode(' AND ', $clauses);
    }
    return db_scalar_int($pdo, $sql, $params);
}

function default_company_record(PDO $pdo): array {
    $companyId = 1;
    $now = db_now_ms();
    return [
        'id' => $companyId,
        'code' => 'default',
        'name' => 'Default Company',
        'contactName' => null,
        'contactEmail' => null,
        'status' => 'ACTIVE',
        'notes' => 'Legacy single-tenant fallback',
        'createdAt' => $now,
        'updatedAt' => $now,
        'adminCount' => db_table_exists($pdo, 'platform_users')
            ? company_table_count($pdo, 'platform_users', $companyId, "role = 'ADMIN'")
            : 0,
        'proctorCount' => db_table_exists($pdo, 'platform_users')
            ? company_table_count($pdo, 'platform_users', $companyId, "role = 'PROCTOR'")
            : 0,
        'userStudentCount' => db_table_exists($pdo, 'platform_users')
            ? company_table_count($pdo, 'platform_users', $companyId, "role = 'STUDENT'")
            : 0,
        'studentCount' => company_table_count($pdo, 'students', $companyId),
        'examCount' => company_table_count($pdo, 'exams', $companyId),
        'liveSessionCount' => company_table_count($pdo, 'exam_sessions', $companyId, "status = 'IN_PROGRESS'"),
        'violationCount' => company_table_count($pdo, 'violation_logs', $companyId),
        'pendingRequestCount' => company_table_count($pdo, 'exam_access_requests', $companyId, "status = 'PENDING'"),
    ];
}

function list_companies(PDO $pdo): array {
    if (!db_table_exists($pdo, 'companies')) {
        return [default_company_record($pdo)];
    }

    $hasAccessRequests = db_table_exists($pdo, 'exam_access_requests');
    $hasPlatformUsers = db_table_exists($pdo, 'platform_users');
    $hasStudents = db_table_exists($pdo, 'students');
    $hasExams = db_table_exists($pdo, 'exams');
    $hasSessions = db_table_exists($pdo, 'exam_sessions');
    $hasViolations = db_table_exists($pdo, 'violation_logs');

    $sql = "SELECT
                c.id,
                c.code,
                c.name,
                c.contact_name,
                c.contact_email,
                c.status,
                c.notes,
                c.created_at,
                c.updated_at,
                " . ($hasPlatformUsers ? "(SELECT COUNT(*) FROM platform_users u WHERE u.company_id = c.id AND u.role = 'ADMIN')" : "0") . " AS admin_count,
                " . ($hasPlatformUsers ? "(SELECT COUNT(*) FROM platform_users u WHERE u.company_id = c.id AND u.role = 'PROCTOR')" : "0") . " AS proctor_count,
                " . ($hasPlatformUsers ? "(SELECT COUNT(*) FROM platform_users u WHERE u.company_id = c.id AND u.role = 'STUDENT')" : "0") . " AS user_student_count,
                " . ($hasStudents ? "(SELECT COUNT(*) FROM students s WHERE s.company_id = c.id)" : "0") . " AS student_count,
                " . ($hasExams ? "(SELECT COUNT(*) FROM exams e WHERE e.company_id = c.id)" : "0") . " AS exam_count,
                " . ($hasSessions ? "(SELECT COUNT(*) FROM exam_sessions es WHERE es.company_id = c.id AND es.status = 'IN_PROGRESS')" : "0") . " AS live_session_count,
                " . ($hasViolations ? "(SELECT COUNT(*) FROM violation_logs vl WHERE vl.company_id = c.id)" : "0") . " AS violation_count,
                " . ($hasAccessRequests
                    ? "(SELECT COUNT(*) FROM exam_access_requests ar WHERE ar.company_id = c.id AND ar.status = 'PENDING')"
                    : "0") . " AS pending_request_count
            FROM companies c
            ORDER BY c.name ASC";
    $stmt = $pdo->query($sql);
    $rows = $stmt ? $stmt->fetchAll() : [];
    if ($stmt) {
        $stmt->closeCursor();
    }

    if ($rows === []) {
        return [default_company_record($pdo)];
    }

    return array_map(static function (array $row): array {
        return [
            'id' => (int)$row['id'],
            'code' => (string)$row['code'],
            'name' => (string)$row['name'],
            'contactName' => $row['contact_name'] !== null ? (string)$row['contact_name'] : null,
            'contactEmail' => $row['contact_email'] !== null ? (string)$row['contact_email'] : null,
            'status' => (string)$row['status'],
            'notes' => $row['notes'] !== null ? (string)$row['notes'] : null,
            'createdAt' => strtotime((string)$row['created_at']) * 1000,
            'updatedAt' => strtotime((string)$row['updated_at']) * 1000,
            'adminCount' => (int)$row['admin_count'],
            'proctorCount' => (int)$row['proctor_count'],
            'userStudentCount' => (int)$row['user_student_count'],
            'studentCount' => (int)$row['student_count'],
            'examCount' => (int)$row['exam_count'],
            'liveSessionCount' => (int)$row['live_session_count'],
            'violationCount' => (int)$row['violation_count'],
            'pendingRequestCount' => (int)$row['pending_request_count'],
        ];
    }, $rows);
}

if ($method === 'GET') {
    require_role(['SUPER_ADMIN']);
    json_response(['companies' => list_companies($pdo)]);
}

if ($method === 'POST') {
    $payload = json_input();
    require_role(['SUPER_ADMIN'], $payload);

    if (!db_table_exists($pdo, 'companies')) {
        json_response(['error' => 'Company directory storage is unavailable on this database. Apply the latest schema and try again.'], 503);
    }

    $action = strtoupper(trim((string)($payload['action'] ?? 'CREATE')));
    $actorId = get_actor_id($payload);

    if ($action === 'CREATE') {
        $company = normalize_company_payload($payload);
        if ($company['name'] === '' || $company['code'] === '') {
            json_response(['error' => 'Company name and code are required.'], 400);
        }
        if (!in_array($company['status'], ['ACTIVE', 'INACTIVE'], true)) {
            $company['status'] = 'ACTIVE';
        }

        $stmt = $pdo->prepare("INSERT INTO companies (code, name, contact_name, contact_email, status, notes)
                               VALUES (?, ?, ?, ?, ?, ?)");
        $stmt->execute([
            $company['code'],
            $company['name'],
            $company['contactName'] !== '' ? $company['contactName'] : null,
            $company['contactEmail'] !== '' ? $company['contactEmail'] : null,
            $company['status'],
            $company['notes'] !== '' ? $company['notes'] : null,
        ]);
        $stmt->closeCursor();

        $newId = (int)$pdo->lastInsertId();

        audit_log($pdo, [
            'companyId' => 1,
            'actorRole' => 'SUPER_ADMIN',
            'actorId' => $actorId,
            'action' => 'COMPANY_CREATE',
            'targetType' => 'company',
            'targetId' => (string)$newId,
            'message' => "Created company {$company['name']}",
            'metadata' => ['code' => $company['code']],
        ]);

        $createdCompany = null;
        foreach (list_companies($pdo) as $item) {
            if ($item['id'] === $newId) {
                $createdCompany = $item;
                break;
            }
        }

        json_response([
            'ok' => true,
            'company' => $createdCompany,
        ], 201);
    }

    if ($action === 'UPDATE') {
        $companyId = isset($payload['companyId']) ? (int)$payload['companyId'] : 0;
        if ($companyId <= 0) {
            json_response(['error' => 'companyId is required.'], 400);
        }
        $company = normalize_company_payload($payload);
        if ($company['name'] === '' || $company['code'] === '') {
            json_response(['error' => 'Company name and code are required.'], 400);
        }
        if (!in_array($company['status'], ['ACTIVE', 'INACTIVE'], true)) {
            $company['status'] = 'ACTIVE';
        }

        $stmt = $pdo->prepare("UPDATE companies
                               SET code = ?, name = ?, contact_name = ?, contact_email = ?, status = ?, notes = ?
                               WHERE id = ?
                               LIMIT 1");
        $stmt->execute([
            $company['code'],
            $company['name'],
            $company['contactName'] !== '' ? $company['contactName'] : null,
            $company['contactEmail'] !== '' ? $company['contactEmail'] : null,
            $company['status'],
            $company['notes'] !== '' ? $company['notes'] : null,
            $companyId,
        ]);
        $stmt->closeCursor();

        audit_log($pdo, [
            'companyId' => 1,
            'actorRole' => 'SUPER_ADMIN',
            'actorId' => $actorId,
            'action' => 'COMPANY_UPDATE',
            'targetType' => 'company',
            'targetId' => (string)$companyId,
            'message' => "Updated company {$company['name']}",
            'metadata' => ['code' => $company['code'], 'status' => $company['status']],
        ]);

        json_response(['ok' => true, 'companies' => list_companies($pdo)]);
    }

    json_response(['error' => 'Invalid action.'], 400);
}

json_response(['error' => 'Method not allowed.'], 405);
