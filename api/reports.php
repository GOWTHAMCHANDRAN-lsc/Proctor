<?php
declare(strict_types=1);

require __DIR__ . '/_bootstrap.php';

function report_datetime_to_ms(?string $dt): ?int {
    if ($dt === null) return null;
    $ts = strtotime($dt);
    if ($ts === false) return null;
    return (int)($ts * 1000);
}

function report_table_exists(PDO $pdo, string $tableName): bool {
    try {
        $stmt = $pdo->prepare('SHOW TABLES LIKE ?');
        $stmt->execute([$tableName]);
        $exists = (bool)$stmt->fetchColumn();
        $stmt->closeCursor();
        return $exists;
    } catch (Throwable $e) {
        return false;
    }
}

function pct(int $num, int $den): int {
    return $den > 0 ? (int)round(($num / $den) * 100) : 0;
}

$method = $_SERVER['REQUEST_METHOD'];

if ($method === 'GET') {
    require_role(['ADMIN', 'PROCTOR']);
    $companyId = require_company_id();
    $hasBatches = report_table_exists($pdo, 'batches');

    $summaryStmt = $pdo->prepare("SELECT
            (SELECT COUNT(*) FROM exams WHERE company_id = ?) AS exams_count,
            (SELECT COUNT(*) FROM students WHERE company_id = ?) AS students_count,
            (SELECT COUNT(*) FROM exam_sessions WHERE company_id = ?) AS sessions_count,
            (SELECT COUNT(*) FROM exam_sessions WHERE company_id = ? AND status = 'COMPLETED') AS completed_count,
            (SELECT COUNT(*) FROM exam_sessions WHERE company_id = ? AND status = 'TERMINATED') AS terminated_count,
            (SELECT COUNT(*) FROM violation_logs WHERE company_id = ?) AS violation_count");
    $summaryStmt->execute([$companyId, $companyId, $companyId, $companyId, $companyId, $companyId]);
    $summaryRow = $summaryStmt->fetch() ?: [];
    $summaryStmt->closeCursor();

    $completed = (int)($summaryRow['completed_count'] ?? 0);
    $terminated = (int)($summaryRow['terminated_count'] ?? 0);

    $passStmt = $pdo->prepare("SELECT
            COUNT(*) AS graded_count,
            SUM(CASE WHEN passed = 1 THEN 1 ELSE 0 END) AS passed_count,
            AVG(CASE WHEN max_score > 0 THEN (total_score / max_score) * 100 ELSE NULL END) AS avg_percent
        FROM exam_sessions
        WHERE company_id = ?
          AND status = 'COMPLETED'
          AND total_score IS NOT NULL
          AND max_score IS NOT NULL");
    $passStmt->execute([$companyId]);
    $passRow = $passStmt->fetch() ?: [];
    $passStmt->closeCursor();

    $examStmt = $pdo->prepare("SELECT
            e.id,
            e.title,
            e.status,
            COUNT(es.id) AS attempts,
            SUM(CASE WHEN es.status = 'COMPLETED' THEN 1 ELSE 0 END) AS completed_count,
            SUM(CASE WHEN es.status = 'TERMINATED' THEN 1 ELSE 0 END) AS terminated_count,
            SUM(CASE WHEN es.passed = 1 THEN 1 ELSE 0 END) AS passed_count,
            AVG(CASE WHEN es.max_score > 0 THEN (es.total_score / es.max_score) * 100 ELSE NULL END) AS avg_percent,
            COALESCE(v.violation_count, 0) AS violations
        FROM exams e
        LEFT JOIN exam_sessions es
          ON es.company_id = e.company_id
         AND es.exam_id = e.id
        LEFT JOIN (
            SELECT es2.exam_id, COUNT(vl.id) AS violation_count
            FROM exam_sessions es2
            JOIN violation_logs vl ON vl.session_id = es2.id AND vl.company_id = es2.company_id
            WHERE es2.company_id = ?
            GROUP BY es2.exam_id
        ) v ON v.exam_id = e.id
        WHERE e.company_id = ?
        GROUP BY e.id, e.title, e.status, v.violation_count
        ORDER BY e.updated_at DESC, e.title ASC");
    $examStmt->execute([$companyId, $companyId]);
    $examRows = $examStmt->fetchAll();
    $examStmt->closeCursor();

    if ($hasBatches) {
        $batchStmt = $pdo->prepare("SELECT
                b.id,
                b.name,
                COUNT(DISTINCT s.id) AS students,
                COUNT(es.id) AS attempts,
                SUM(CASE WHEN es.status = 'COMPLETED' THEN 1 ELSE 0 END) AS completed_count,
                SUM(CASE WHEN es.status = 'TERMINATED' THEN 1 ELSE 0 END) AS terminated_count,
                SUM(CASE WHEN es.passed = 1 THEN 1 ELSE 0 END) AS passed_count,
                AVG(CASE WHEN es.max_score > 0 THEN (es.total_score / es.max_score) * 100 ELSE NULL END) AS avg_percent,
                COALESCE(v.violation_count, 0) AS violations
            FROM batches b
            LEFT JOIN students s
              ON s.company_id = b.company_id
             AND s.batch_id = b.id
            LEFT JOIN exam_sessions es
              ON es.company_id = b.company_id
             AND es.student_id = s.id
            LEFT JOIN (
                SELECT s2.batch_id, COUNT(vl.id) AS violation_count
                FROM students s2
                JOIN exam_sessions es2 ON es2.company_id = s2.company_id AND es2.student_id = s2.id
                JOIN violation_logs vl ON vl.session_id = es2.id AND vl.company_id = es2.company_id
                WHERE s2.company_id = ?
                  AND s2.batch_id IS NOT NULL
                GROUP BY s2.batch_id
            ) v ON v.batch_id = b.id
            WHERE b.company_id = ?
            GROUP BY b.id, b.name, v.violation_count
            ORDER BY b.name ASC");
        $batchStmt->execute([$companyId, $companyId]);
        $batchRows = $batchStmt->fetchAll();
        $batchStmt->closeCursor();
    } else {
        $batchRows = [];
    }

    $studentStmt = $pdo->prepare("SELECT
            s.id,
            s.full_name,
            s.registration_id,
            " . ($hasBatches ? "b.name" : "NULL") . " AS batch_name,
            COUNT(es.id) AS attempts,
            SUM(CASE WHEN es.status = 'COMPLETED' THEN 1 ELSE 0 END) AS completed_count,
            SUM(CASE WHEN es.status = 'TERMINATED' THEN 1 ELSE 0 END) AS terminated_count,
            SUM(CASE WHEN es.passed = 1 THEN 1 ELSE 0 END) AS passed_count,
            AVG(CASE WHEN es.max_score > 0 THEN (es.total_score / es.max_score) * 100 ELSE NULL END) AS avg_percent,
            COALESCE(v.violation_count, 0) AS violations
        FROM students s
        " . ($hasBatches ? "LEFT JOIN batches b ON b.id = s.batch_id AND b.company_id = s.company_id" : "") . "
        LEFT JOIN exam_sessions es
          ON es.company_id = s.company_id
         AND es.student_id = s.id
        LEFT JOIN (
            SELECT es2.student_id, COUNT(vl.id) AS violation_count
            FROM exam_sessions es2
            JOIN violation_logs vl ON vl.session_id = es2.id AND vl.company_id = es2.company_id
            WHERE es2.company_id = ?
            GROUP BY es2.student_id
        ) v ON v.student_id = s.id
        WHERE s.company_id = ?
        GROUP BY s.id, s.full_name, s.registration_id, batch_name, v.violation_count
        ORDER BY violations DESC, avg_percent ASC, s.full_name ASC
        LIMIT 250");
    $studentStmt->execute([$companyId, $companyId]);
    $studentRows = $studentStmt->fetchAll();
    $studentStmt->closeCursor();

    $violationTypeStmt = $pdo->prepare("SELECT type, COUNT(*) AS count
                                        FROM violation_logs
                                        WHERE company_id = ?
                                        GROUP BY type
                                        ORDER BY count DESC, type ASC");
    $violationTypeStmt->execute([$companyId]);
    $violationTypeRows = $violationTypeStmt->fetchAll();
    $violationTypeStmt->closeCursor();

    $timelineStmt = $pdo->prepare("SELECT DATE(occurred_at) AS day, COUNT(*) AS count
                                   FROM violation_logs
                                   WHERE company_id = ?
                                     AND occurred_at >= DATE_SUB(NOW(), INTERVAL 14 DAY)
                                   GROUP BY DATE(occurred_at)
                                   ORDER BY day ASC");
    $timelineStmt->execute([$companyId]);
    $timelineRows = $timelineStmt->fetchAll();
    $timelineStmt->closeCursor();

    $recentStmt = $pdo->prepare("SELECT
            vl.id,
            vl.session_id,
            vl.occurred_at,
            vl.type,
            vl.description,
            es.exam_id,
            e.title AS exam_title,
            es.student_id,
            s.full_name,
            s.registration_id,
            " . ($hasBatches ? "b.name" : "NULL") . " AS batch_name
        FROM violation_logs vl
        JOIN exam_sessions es ON es.id = vl.session_id AND es.company_id = vl.company_id
        LEFT JOIN exams e ON e.id = es.exam_id AND e.company_id = es.company_id
        LEFT JOIN students s ON s.id = es.student_id AND s.company_id = es.company_id
        " . ($hasBatches ? "LEFT JOIN batches b ON b.id = s.batch_id AND b.company_id = s.company_id" : "") . "
        WHERE vl.company_id = ?
        ORDER BY vl.occurred_at DESC
        LIMIT 80");
    $recentStmt->execute([$companyId]);
    $recentRows = $recentStmt->fetchAll();
    $recentStmt->closeCursor();

    $mapPerformanceRow = static function (array $row, ?string $idKey = null, ?string $nameKey = null): array {
        $attempts = (int)($row['attempts'] ?? 0);
        $completed = (int)($row['completed_count'] ?? 0);
        $passed = (int)($row['passed_count'] ?? 0);
        $out = [
            'attempts' => $attempts,
            'completed' => $completed,
            'terminated' => (int)($row['terminated_count'] ?? 0),
            'passed' => $passed,
            'passRate' => pct($passed, $completed),
            'avgPercent' => $row['avg_percent'] !== null ? (int)round((float)$row['avg_percent']) : 0,
            'violations' => (int)($row['violations'] ?? 0),
        ];
        if ($idKey !== null) $out['id'] = $row[$idKey];
        if ($nameKey !== null) $out['name'] = $row[$nameKey] ?? '';
        return $out;
    };

    json_response([
        'generatedAt' => (int)(microtime(true) * 1000),
        'summary' => [
            'exams' => (int)($summaryRow['exams_count'] ?? 0),
            'students' => (int)($summaryRow['students_count'] ?? 0),
            'sessions' => (int)($summaryRow['sessions_count'] ?? 0),
            'completed' => $completed,
            'terminated' => $terminated,
            'violations' => (int)($summaryRow['violation_count'] ?? 0),
            'completionRate' => pct($completed, $completed + $terminated),
            'passRate' => pct((int)($passRow['passed_count'] ?? 0), (int)($passRow['graded_count'] ?? 0)),
            'avgPercent' => $passRow['avg_percent'] !== null ? (int)round((float)$passRow['avg_percent']) : 0,
        ],
        'byExam' => array_map(function ($row) use ($mapPerformanceRow) {
            return array_merge(
                ['id' => $row['id'], 'title' => $row['title'], 'status' => $row['status']],
                $mapPerformanceRow($row)
            );
        }, $examRows),
        'byBatch' => array_map(function ($row) use ($mapPerformanceRow) {
            return array_merge(
                ['id' => (int)$row['id'], 'name' => $row['name'], 'students' => (int)($row['students'] ?? 0)],
                $mapPerformanceRow($row)
            );
        }, $batchRows),
        'byStudent' => array_map(function ($row) use ($mapPerformanceRow) {
            return array_merge(
                [
                    'id' => $row['id'],
                    'name' => $row['full_name'],
                    'registrationId' => $row['registration_id'],
                    'batch' => $row['batch_name'],
                ],
                $mapPerformanceRow($row)
            );
        }, $studentRows),
        'violationsByType' => array_map(static function ($row) {
            return ['type' => $row['type'], 'count' => (int)$row['count']];
        }, $violationTypeRows),
        'violationTimeline' => array_map(static function ($row) {
            return ['date' => $row['day'], 'count' => (int)$row['count']];
        }, $timelineRows),
        'recentViolations' => array_map(static function ($row) {
            return [
                'id' => (int)$row['id'],
                'sessionId' => (int)$row['session_id'],
                'examId' => $row['exam_id'],
                'examTitle' => $row['exam_title'] ?? $row['exam_id'],
                'studentId' => $row['student_id'],
                'studentName' => $row['full_name'] ?? $row['student_id'],
                'registrationId' => $row['registration_id'] ?? '',
                'batch' => $row['batch_name'] ?? null,
                'timestamp' => report_datetime_to_ms($row['occurred_at']) ?? 0,
                'type' => $row['type'],
                'description' => $row['description'],
            ];
        }, $recentRows),
    ]);
}

json_response(['error' => 'Method not allowed.'], 405);
