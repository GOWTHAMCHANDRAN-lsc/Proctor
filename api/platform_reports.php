<?php
declare(strict_types=1);

require_once __DIR__ . '/_bootstrap.php';

require_role(['SUPER_ADMIN']);

$companyFilter = isset($_GET['companyId']) ? (int)$_GET['companyId'] : 0;

function scalar_query(PDO $pdo, string $sql, array $params = []): int {
    return db_scalar_int($pdo, $sql, $params);
}

function scoped_table_count(PDO $pdo, string $table, int $companyFilter, string $extraWhere = '', array $extraParams = []): int {
    if (!db_table_exists($pdo, $table)) {
        return 0;
    }

    $clauses = [];
    $params = [];
    if ($companyFilter > 0 && db_column_exists($pdo, $table, 'company_id')) {
        $clauses[] = 'company_id = ?';
        $params[] = $companyFilter;
    } elseif ($companyFilter > 1 && !db_column_exists($pdo, $table, 'company_id')) {
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

    return scalar_query($pdo, $sql, $params);
}

function build_synthetic_company_row(PDO $pdo): array {
    return [
        'companyId' => 1,
        'companyName' => 'Default Company',
        'companyCode' => 'default',
        'status' => 'ACTIVE',
        'adminCount' => db_table_exists($pdo, 'platform_users')
            ? scoped_table_count($pdo, 'platform_users', 1, "role = 'ADMIN'")
            : 0,
        'proctorCount' => db_table_exists($pdo, 'platform_users')
            ? scoped_table_count($pdo, 'platform_users', 1, "role = 'PROCTOR'")
            : 0,
        'userStudentCount' => db_table_exists($pdo, 'platform_users')
            ? scoped_table_count($pdo, 'platform_users', 1, "role = 'STUDENT'")
            : 0,
        'studentCount' => scoped_table_count($pdo, 'students', 1),
        'examCount' => scoped_table_count($pdo, 'exams', 1),
        'liveSessionCount' => scoped_table_count($pdo, 'exam_sessions', 1, "status = 'IN_PROGRESS'"),
        'violationCount' => scoped_table_count($pdo, 'violation_logs', 1),
    ];
}

function fetch_company_rows(PDO $pdo, int $companyFilter): array {
    if (!db_table_exists($pdo, 'companies')) {
        if ($companyFilter > 1) {
            return [];
        }
        return [build_synthetic_company_row($pdo)];
    }

    $hasPlatformUsers = db_table_exists($pdo, 'platform_users');
    $hasStudents = db_table_exists($pdo, 'students');
    $hasExams = db_table_exists($pdo, 'exams');
    $hasSessions = db_table_exists($pdo, 'exam_sessions');
    $hasViolations = db_table_exists($pdo, 'violation_logs');

    $sql = "SELECT
        c.id,
        c.name,
        c.code,
        c.status,
        " . ($hasPlatformUsers ? "(SELECT COUNT(*) FROM platform_users u WHERE u.company_id = c.id AND u.role = 'ADMIN')" : "0") . " AS admin_count,
        " . ($hasPlatformUsers ? "(SELECT COUNT(*) FROM platform_users u WHERE u.company_id = c.id AND u.role = 'PROCTOR')" : "0") . " AS proctor_count,
        " . ($hasPlatformUsers ? "(SELECT COUNT(*) FROM platform_users u WHERE u.company_id = c.id AND u.role = 'STUDENT')" : "0") . " AS user_student_count,
        " . ($hasStudents ? "(SELECT COUNT(*) FROM students s WHERE s.company_id = c.id)" : "0") . " AS student_count,
        " . ($hasExams ? "(SELECT COUNT(*) FROM exams e WHERE e.company_id = c.id)" : "0") . " AS exam_count,
        " . ($hasSessions ? "(SELECT COUNT(*) FROM exam_sessions es WHERE es.company_id = c.id AND es.status = 'IN_PROGRESS')" : "0") . " AS live_session_count,
        " . ($hasViolations ? "(SELECT COUNT(*) FROM violation_logs vl WHERE vl.company_id = c.id)" : "0") . " AS violation_count
    FROM companies c
    " . ($companyFilter > 0 ? "WHERE c.id = ?" : "") . "
    ORDER BY c.name ASC";

    $params = $companyFilter > 0 ? [$companyFilter] : [];
    $stmt = $pdo->prepare($sql);
    $stmt->execute($params);
    $rows = array_map(static function (array $row): array {
        return [
            'companyId' => (int)$row['id'],
            'companyName' => (string)$row['name'],
            'companyCode' => (string)$row['code'],
            'status' => (string)$row['status'],
            'adminCount' => (int)$row['admin_count'],
            'proctorCount' => (int)$row['proctor_count'],
            'userStudentCount' => (int)$row['user_student_count'],
            'studentCount' => (int)$row['student_count'],
            'examCount' => (int)$row['exam_count'],
            'liveSessionCount' => (int)$row['live_session_count'],
            'violationCount' => (int)$row['violation_count'],
        ];
    }, $stmt->fetchAll());
    $stmt->closeCursor();

    if ($rows === [] && $companyFilter <= 1) {
        return [build_synthetic_company_row($pdo)];
    }

    return $rows;
}

function fetch_exam_rows(PDO $pdo, int $companyFilter): array {
    if (!db_table_exists($pdo, 'exams')) {
        return [];
    }

    $hasCompanies = db_table_exists($pdo, 'companies');
    $hasSessions = db_table_exists($pdo, 'exam_sessions');
    $hasViolations = db_table_exists($pdo, 'violation_logs');
    $params = $companyFilter > 0 ? [$companyFilter] : [];

    $sql = "SELECT
        e.company_id,
        " . ($hasCompanies ? "c.name AS company_name" : "NULL AS company_name") . ",
        e.id AS exam_id,
        e.title,
        e.status,
        " . ($hasSessions ? "(SELECT COUNT(*) FROM exam_sessions es WHERE es.company_id = e.company_id AND es.exam_id = e.id)" : "0") . " AS session_count,
        " . ($hasSessions ? "(SELECT COUNT(*) FROM exam_sessions es WHERE es.company_id = e.company_id AND es.exam_id = e.id AND es.status = 'COMPLETED')" : "0") . " AS completed_count,
        " . ($hasSessions ? "(SELECT COUNT(*) FROM exam_sessions es WHERE es.company_id = e.company_id AND es.exam_id = e.id AND es.status = 'TERMINATED')" : "0") . " AS terminated_count,
        " . ($hasSessions ? "(SELECT COALESCE(ROUND(AVG(es.total_score), 2), 0) FROM exam_sessions es WHERE es.company_id = e.company_id AND es.exam_id = e.id)" : "0") . " AS average_score,
        " . ($hasSessions && $hasViolations
            ? "(SELECT COUNT(*) FROM violation_logs vl JOIN exam_sessions es ON es.id = vl.session_id AND es.company_id = vl.company_id WHERE es.company_id = e.company_id AND es.exam_id = e.id)"
            : "0") . " AS violation_count
    FROM exams e
    " . ($hasCompanies ? "LEFT JOIN companies c ON c.id = e.company_id" : "") . "
    " . ($companyFilter > 0 ? "WHERE e.company_id = ?" : "") . "
    ORDER BY e.start_time DESC
    LIMIT 100";

    $stmt = $pdo->prepare($sql);
    $stmt->execute($params);
    $rows = array_map(static function (array $row): array {
        return [
            'companyId' => (int)$row['company_id'],
            'companyName' => $row['company_name'] !== null ? (string)$row['company_name'] : null,
            'examId' => (string)$row['exam_id'],
            'examTitle' => (string)$row['title'],
            'status' => (string)$row['status'],
            'sessionCount' => (int)$row['session_count'],
            'completedCount' => (int)$row['completed_count'],
            'terminatedCount' => (int)$row['terminated_count'],
            'averageScore' => (float)$row['average_score'],
            'violationCount' => (int)$row['violation_count'],
        ];
    }, $stmt->fetchAll());
    $stmt->closeCursor();

    return $rows;
}

function fetch_batch_rows(PDO $pdo, int $companyFilter): array {
    if (!db_table_exists($pdo, 'batches')) {
        return [];
    }

    $hasCompanies = db_table_exists($pdo, 'companies');
    $hasStudents = db_table_exists($pdo, 'students');
    $hasSessions = db_table_exists($pdo, 'exam_sessions');
    $hasViolations = db_table_exists($pdo, 'violation_logs');
    $params = $companyFilter > 0 ? [$companyFilter] : [];

    $sql = "SELECT
        b.company_id,
        " . ($hasCompanies ? "c.name AS company_name" : "NULL AS company_name") . ",
        b.id AS batch_id,
        b.name AS batch_name,
        COUNT(DISTINCT " . ($hasStudents ? "s.id" : "NULL") . ") AS student_count,
        COUNT(DISTINCT " . ($hasSessions && $hasStudents ? "es.id" : "NULL") . ") AS session_count,
        COUNT(" . ($hasViolations && $hasSessions && $hasStudents ? "vl.id" : "NULL") . ") AS violation_count
    FROM batches b
    " . ($hasCompanies ? "LEFT JOIN companies c ON c.id = b.company_id" : "") . "
    " . ($hasStudents ? "LEFT JOIN students s ON s.batch_id = b.id AND s.company_id = b.company_id" : "") . "
    " . ($hasSessions && $hasStudents ? "LEFT JOIN exam_sessions es ON es.student_id = s.id AND es.company_id = s.company_id" : "") . "
    " . ($hasViolations && $hasSessions && $hasStudents ? "LEFT JOIN violation_logs vl ON vl.session_id = es.id AND vl.company_id = es.company_id" : "") . "
    " . ($companyFilter > 0 ? "WHERE b.company_id = ?" : "") . "
    GROUP BY b.company_id, company_name, b.id, b.name
    ORDER BY b.created_at DESC
    LIMIT 100";

    $stmt = $pdo->prepare($sql);
    $stmt->execute($params);
    $rows = array_map(static function (array $row): array {
        return [
            'companyId' => (int)$row['company_id'],
            'companyName' => $row['company_name'] !== null ? (string)$row['company_name'] : null,
            'batchId' => (int)$row['batch_id'],
            'batchName' => (string)$row['batch_name'],
            'studentCount' => (int)$row['student_count'],
            'sessionCount' => (int)$row['session_count'],
            'violationCount' => (int)$row['violation_count'],
        ];
    }, $stmt->fetchAll());
    $stmt->closeCursor();

    return $rows;
}

function fetch_student_rows(PDO $pdo, int $companyFilter): array {
    if (!db_table_exists($pdo, 'students')) {
        return [];
    }

    $hasCompanies = db_table_exists($pdo, 'companies');
    $hasSessions = db_table_exists($pdo, 'exam_sessions');
    $hasViolations = db_table_exists($pdo, 'violation_logs');
    $params = $companyFilter > 0 ? [$companyFilter] : [];

    $sql = "SELECT
        s.company_id,
        " . ($hasCompanies ? "c.name AS company_name" : "NULL AS company_name") . ",
        s.id AS student_id,
        s.full_name,
        s.email,
        s.registration_id,
        COUNT(DISTINCT " . ($hasSessions ? "es.id" : "NULL") . ") AS session_count,
        COUNT(DISTINCT CASE WHEN " . ($hasSessions ? "es.status = 'COMPLETED'" : "FALSE") . " THEN es.id END) AS completed_count,
        COUNT(" . ($hasViolations && $hasSessions ? "vl.id" : "NULL") . ") AS violation_count
    FROM students s
    " . ($hasCompanies ? "LEFT JOIN companies c ON c.id = s.company_id" : "") . "
    " . ($hasSessions ? "LEFT JOIN exam_sessions es ON es.student_id = s.id AND es.company_id = s.company_id" : "") . "
    " . ($hasViolations && $hasSessions ? "LEFT JOIN violation_logs vl ON vl.session_id = es.id AND vl.company_id = es.company_id" : "") . "
    " . ($companyFilter > 0 ? "WHERE s.company_id = ?" : "") . "
    GROUP BY s.company_id, company_name, s.id, s.full_name, s.email, s.registration_id
    ORDER BY s.created_at DESC
    LIMIT 100";

    $stmt = $pdo->prepare($sql);
    $stmt->execute($params);
    $rows = array_map(static function (array $row): array {
        return [
            'companyId' => (int)$row['company_id'],
            'companyName' => $row['company_name'] !== null ? (string)$row['company_name'] : null,
            'studentId' => (string)$row['student_id'],
            'fullName' => (string)$row['full_name'],
            'email' => (string)$row['email'],
            'registrationId' => (string)$row['registration_id'],
            'sessionCount' => (int)$row['session_count'],
            'completedCount' => (int)$row['completed_count'],
            'violationCount' => (int)$row['violation_count'],
        ];
    }, $stmt->fetchAll());
    $stmt->closeCursor();

    return $rows;
}

$hasAccessRequests = db_table_exists($pdo, 'exam_access_requests');
$hasRecordings = db_table_exists($pdo, 'recording_sessions');
$companyRows = fetch_company_rows($pdo, $companyFilter);

$overview = [
    'companyCount' => count($companyRows),
    'activeCompanyCount' => count(array_filter($companyRows, static fn(array $row): bool => ($row['status'] ?? '') === 'ACTIVE')),
    'platformUserCount' => scoped_table_count($pdo, 'platform_users', $companyFilter),
    'examCount' => scoped_table_count($pdo, 'exams', $companyFilter),
    'studentCount' => scoped_table_count($pdo, 'students', $companyFilter),
    'liveSessionCount' => scoped_table_count($pdo, 'exam_sessions', $companyFilter, "status = 'IN_PROGRESS'"),
    'completedSessionCount' => scoped_table_count($pdo, 'exam_sessions', $companyFilter, "status = 'COMPLETED'"),
    'violationCount' => scoped_table_count($pdo, 'violation_logs', $companyFilter),
    'pendingRequestCount' => $hasAccessRequests
        ? scoped_table_count($pdo, 'exam_access_requests', $companyFilter, "status = 'PENDING'")
        : 0,
    'recordingCount' => $hasRecordings
        ? scoped_table_count($pdo, 'recording_sessions', $companyFilter)
        : 0,
];

json_response([
    'overview' => $overview,
    'companyRows' => $companyRows,
    'examRows' => fetch_exam_rows($pdo, $companyFilter),
    'batchRows' => fetch_batch_rows($pdo, $companyFilter),
    'studentRows' => fetch_student_rows($pdo, $companyFilter),
]);
