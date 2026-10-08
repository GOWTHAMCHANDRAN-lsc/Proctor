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

// Parses ?from=YYYY-MM-DD&to=YYYY-MM-DD, tolerating a single date, a swapped
// range, or junk (silently dropped rather than erroring the whole report).
function report_date_range(): array {
    $isValid = static fn(string $v): bool => (bool)preg_match('/^\d{4}-\d{2}-\d{2}$/', $v);
    $from = isset($_GET['from']) ? trim((string)$_GET['from']) : '';
    $to = isset($_GET['to']) ? trim((string)$_GET['to']) : '';
    if ($from !== '' && !$isValid($from)) $from = '';
    if ($to !== '' && !$isValid($to)) $to = '';
    if ($from !== '' && $to === '') $to = $from;
    if ($to !== '' && $from === '') $from = $to;
    if ($from !== '' && $to !== '' && $from > $to) { [$from, $to] = [$to, $from]; }
    return [$from ?: null, $to ?: null];
}

$method = $_SERVER['REQUEST_METHOD'];

if ($method === 'GET') {
    require_staff(); // admin-only read: blocks tokenless/forged-header access
    // VIEWER is the read-only "Dashboard + Results" role and Results.tsx loads this report for every
    // viewer of that tab; leaving VIEWER out 403'd it so their Reports panel was always empty.
    require_role(['ADMIN', 'PROCTOR', 'VIEWER']);
    $companyId = require_company_id();
    $hasBatches = report_table_exists($pdo, 'batches');
    if ($hasBatches) {
        try { ensure_student_batches_schema($pdo); } catch (Throwable $e) { /* best-effort */ }
    }

    [$reportFrom, $reportTo] = report_date_range();
    $hasDateFilter = $reportFrom !== null && $reportTo !== null;
    // "es"/"es2" clauses scope a joined exam_sessions alias; "plain" scopes an
    // unaliased exam_sessions table; "vl" scopes the violation-episodes alias.
    $dateClauseEs = $hasDateFilter ? " AND es.start_time >= ? AND es.start_time < DATE_ADD(?, INTERVAL 1 DAY)" : "";
    $dateClauseEs2 = $hasDateFilter ? " AND es2.start_time >= ? AND es2.start_time < DATE_ADD(?, INTERVAL 1 DAY)" : "";
    $dateClausePlain = $hasDateFilter ? " AND start_time >= ? AND start_time < DATE_ADD(?, INTERVAL 1 DAY)" : "";
    $dateClauseVl = $hasDateFilter ? " AND vl.occurred_at >= ? AND vl.occurred_at < DATE_ADD(?, INTERVAL 1 DAY)" : "";
    $dateParams = $hasDateFilter ? [$reportFrom, $reportTo] : [];
    // With a date filter active, an exam/batch/student with zero sessions in range should
    // disappear from its report table rather than show up with all-zero stats.
    $sessionJoinType = $hasDateFilter ? 'JOIN' : 'LEFT JOIN';
    // One row per student, batch names pre-aggregated so joining it in doesn't fan out
    // (and double-count) the exam_sessions rows below for students in more than one batch.
    $batchNamesJoin = $hasBatches
        ? "LEFT JOIN (
               SELECT sb.student_id, GROUP_CONCAT(b.name ORDER BY b.name SEPARATOR ', ') AS batch_name
               FROM student_batches sb
               JOIN batches b ON b.id = sb.batch_id
               GROUP BY sb.student_id
           ) bn ON bn.student_id = s.id"
        : '';

    // Every violation figure in this report counts INCIDENTS, not raw detector events: a webcam that
    // showed a placeholder image for 19 minutes is ONE incident, not the 112 NO_FACE rows it wrote.
    // This subquery is a drop-in stand-in for the violation_logs table that emits one row per run.
    $violationEpisodes = violation_episodes_subquery($pdo);

    $summaryStmt = $pdo->prepare("SELECT
            (SELECT COUNT(*) FROM exams WHERE company_id = ?) AS exams_count,
            (SELECT COUNT(*) FROM students WHERE company_id = ?) AS students_count,
            (SELECT COUNT(*) FROM exam_sessions WHERE company_id = ?{$dateClausePlain}) AS sessions_count,
            (SELECT COUNT(*) FROM exam_sessions WHERE company_id = ? AND status = 'COMPLETED'{$dateClausePlain}) AS completed_count,
            (SELECT COUNT(*) FROM exam_sessions WHERE company_id = ? AND status = 'TERMINATED'{$dateClausePlain}) AS terminated_count,
            (SELECT COUNT(*) FROM {$violationEpisodes} vl WHERE vl.company_id = ?{$dateClauseVl}) AS violation_count");
    $summaryStmt->execute(array_merge(
        [$companyId, $companyId],
        [$companyId], $dateParams,
        [$companyId], $dateParams,
        [$companyId], $dateParams,
        [$companyId], $dateParams
    ));
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
          AND max_score IS NOT NULL
          {$dateClausePlain}");
    $passStmt->execute(array_merge([$companyId], $dateParams));
    $passRow = $passStmt->fetch() ?: [];
    $passStmt->closeCursor();

    // Shared by exam/batch/student aggregates: the outer session join params,
    // then the violation subquery's company id + its own session join params.
    $sessionAggParams = array_merge($dateParams, [$companyId], $dateParams);

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
        {$sessionJoinType} exam_sessions es
          ON es.company_id = e.company_id
         AND es.exam_id = e.id
         {$dateClauseEs}
        LEFT JOIN (
            SELECT es2.exam_id, COUNT(vl.id) AS violation_count
            FROM exam_sessions es2
            JOIN {$violationEpisodes} vl ON vl.session_id = es2.id AND vl.company_id = es2.company_id
            WHERE es2.company_id = ?{$dateClauseEs2}
            GROUP BY es2.exam_id
        ) v ON v.exam_id = e.id
        WHERE e.company_id = ?
        GROUP BY e.id, e.title, e.status, v.violation_count
        ORDER BY e.updated_at DESC, e.title ASC");
    $examStmt->execute(array_merge($sessionAggParams, [$companyId]));
    $examRows = $examStmt->fetchAll();
    $examStmt->closeCursor();

    if ($hasBatches) {
        // Fans out one row per (batch, member) on purpose — a student in more than one
        // assigned batch correctly contributes to each batch's aggregate.
        $batchStmt = $pdo->prepare("SELECT
                b.id,
                b.name,
                COUNT(DISTINCT sb.student_id) AS students,
                COUNT(es.id) AS attempts,
                SUM(CASE WHEN es.status = 'COMPLETED' THEN 1 ELSE 0 END) AS completed_count,
                SUM(CASE WHEN es.status = 'TERMINATED' THEN 1 ELSE 0 END) AS terminated_count,
                SUM(CASE WHEN es.passed = 1 THEN 1 ELSE 0 END) AS passed_count,
                AVG(CASE WHEN es.max_score > 0 THEN (es.total_score / es.max_score) * 100 ELSE NULL END) AS avg_percent,
                COALESCE(v.violation_count, 0) AS violations
            FROM batches b
            LEFT JOIN student_batches sb
              ON sb.batch_id = b.id
            {$sessionJoinType} exam_sessions es
              ON es.company_id = b.company_id
             AND es.student_id = sb.student_id
             {$dateClauseEs}
            LEFT JOIN (
                SELECT sb2.batch_id, COUNT(vl.id) AS violation_count
                FROM student_batches sb2
                JOIN exam_sessions es2 ON es2.company_id = ? AND es2.student_id = sb2.student_id{$dateClauseEs2}
                JOIN {$violationEpisodes} vl ON vl.session_id = es2.id AND vl.company_id = es2.company_id
                GROUP BY sb2.batch_id
            ) v ON v.batch_id = b.id
            WHERE b.company_id = ?
            GROUP BY b.id, b.name, v.violation_count
            ORDER BY b.name ASC");
        $batchStmt->execute(array_merge($sessionAggParams, [$companyId]));
        $batchRows = $batchStmt->fetchAll();
        $batchStmt->closeCursor();
    } else {
        $batchRows = [];
    }

    $studentStmt = $pdo->prepare("SELECT
            s.id,
            s.full_name,
            s.registration_id,
            " . ($hasBatches ? "bn.batch_name" : "NULL") . " AS batch_name,
            COUNT(es.id) AS attempts,
            SUM(CASE WHEN es.status = 'COMPLETED' THEN 1 ELSE 0 END) AS completed_count,
            SUM(CASE WHEN es.status = 'TERMINATED' THEN 1 ELSE 0 END) AS terminated_count,
            SUM(CASE WHEN es.passed = 1 THEN 1 ELSE 0 END) AS passed_count,
            AVG(CASE WHEN es.max_score > 0 THEN (es.total_score / es.max_score) * 100 ELSE NULL END) AS avg_percent,
            COALESCE(v.violation_count, 0) AS violations
        FROM students s
        {$batchNamesJoin}
        {$sessionJoinType} exam_sessions es
          ON es.company_id = s.company_id
         AND es.student_id = s.id
         {$dateClauseEs}
        LEFT JOIN (
            SELECT es2.student_id, COUNT(vl.id) AS violation_count
            FROM exam_sessions es2
            JOIN {$violationEpisodes} vl ON vl.session_id = es2.id AND vl.company_id = es2.company_id
            WHERE es2.company_id = ?{$dateClauseEs2}
            GROUP BY es2.student_id
        ) v ON v.student_id = s.id
        WHERE s.company_id = ?
        GROUP BY s.id, s.full_name, s.registration_id, batch_name, v.violation_count
        ORDER BY violations DESC, avg_percent ASC, s.full_name ASC");
    $studentStmt->execute(array_merge($sessionAggParams, [$companyId]));
    $studentRows = $studentStmt->fetchAll();
    $studentStmt->closeCursor();

    $violationTypeStmt = $pdo->prepare("SELECT type, COUNT(*) AS count
                                        FROM {$violationEpisodes} vl
                                        WHERE company_id = ?{$dateClauseVl}
                                        GROUP BY type
                                        ORDER BY count DESC, type ASC");
    $violationTypeStmt->execute(array_merge([$companyId], $dateParams));
    $violationTypeRows = $violationTypeStmt->fetchAll();
    $violationTypeStmt->closeCursor();

    $timelineWhere = $hasDateFilter
        ? "AND occurred_at >= ? AND occurred_at < DATE_ADD(?, INTERVAL 1 DAY)"
        : "AND occurred_at >= DATE_SUB(NOW(), INTERVAL 14 DAY)";
    $timelineStmt = $pdo->prepare("SELECT DATE(occurred_at) AS day, COUNT(*) AS count
                                   FROM {$violationEpisodes} vl
                                   WHERE company_id = ?
                                     {$timelineWhere}
                                   GROUP BY DATE(occurred_at)
                                   ORDER BY day ASC");
    $timelineStmt->execute(array_merge([$companyId], $dateParams));
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
            " . ($hasBatches ? "bn.batch_name" : "NULL") . " AS batch_name
        FROM {$violationEpisodes} vl
        JOIN exam_sessions es ON es.id = vl.session_id AND es.company_id = vl.company_id
        LEFT JOIN exams e ON e.id = es.exam_id AND e.company_id = es.company_id
        LEFT JOIN students s ON s.id = es.student_id AND s.company_id = es.company_id
        {$batchNamesJoin}
        WHERE vl.company_id = ?{$dateClauseVl}
        ORDER BY vl.occurred_at DESC
        LIMIT 300");
    $recentStmt->execute(array_merge([$companyId], $dateParams));
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
        'dateFilter' => $hasDateFilter ? ['from' => $reportFrom, 'to' => $reportTo] : null,
        'summary' => [
            // With a date filter active these mirror what byExam/byStudent actually list
            // (only exams/students with an attempt in range), not the company's full roster.
            'exams' => $hasDateFilter ? count($examRows) : (int)($summaryRow['exams_count'] ?? 0),
            'students' => $hasDateFilter ? count($studentRows) : (int)($summaryRow['students_count'] ?? 0),
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
