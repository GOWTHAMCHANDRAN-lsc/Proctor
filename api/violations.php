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

function ensure_violation_enum(PDO $pdo): void {
    try {
        $stmt = $pdo->query("SHOW COLUMNS FROM violation_logs LIKE 'type'");
        $column = $stmt ? $stmt->fetch() : null;
        if ($stmt) $stmt->closeCursor();
        $type = is_array($column) ? (string)($column['Type'] ?? '') : '';
        if (stripos($type, 'GAZE_AWAY') !== false && stripos($type, 'LOCATION_CHANGE') !== false && stripos($type, 'IDENTITY_CHANGE') !== false && stripos($type, 'SUSPICIOUS_BEHAVIOR') !== false) {
            return;
        }
        $pdo->exec("ALTER TABLE violation_logs MODIFY type ENUM('TAB_SWITCH','NO_FACE','MULTIPLE_FACES','GAZE_AWAY','AUDIO_DETECTED','FULLSCREEN_EXIT','COPY_PASTE','PHONE_DETECTED','ANOMALY_OBJECT','LOCATION_CHANGE','IDENTITY_CHANGE','SUSPICIOUS_BEHAVIOR') NOT NULL");
    } catch (Throwable $e) {
        // Existing deployments may not allow online enum migration; insert errors will surface normally.
    }
}

function ensure_violation_metadata_schema(PDO $pdo): void {
    db_add_column_if_missing($pdo, 'violation_logs', 'category', "VARCHAR(32) NULL AFTER type");
    db_add_column_if_missing($pdo, 'violation_logs', 'confidence', "DECIMAL(5,4) NULL AFTER category");
    db_add_column_if_missing($pdo, 'violation_logs', 'metadata_json', "JSON NULL AFTER snapshot_base64");
}

function violation_category_for_type(string $type): string {
    return match ($type) {
        'AUDIO_DETECTED' => 'microphone',
        'TAB_SWITCH', 'COPY_PASTE' => 'browser',
        'FULLSCREEN_EXIT' => 'screen',
        'LOCATION_CHANGE' => 'location',
        'SUSPICIOUS_BEHAVIOR' => 'behavior',
        default => 'camera',
    };
}

$method = $_SERVER['REQUEST_METHOD'];
ensure_violation_enum($pdo);
ensure_violation_metadata_schema($pdo);

if ($method === 'GET') {
    require_staff(); // admin-only read: blocks tokenless/forged-header access
    $companyId = require_company_id();
    $limit = isset($_GET['limit']) ? (int)$_GET['limit'] : 20;
    if ($limit <= 0) $limit = 20;
    if ($limit > 2000) $limit = 2000;
    $sessionId = isset($_GET['sessionId']) ? (int)$_GET['sessionId'] : null;
    $studentFilter = isset($_GET['studentId']) ? trim((string)$_GET['studentId']) : '';
    $examFilter = isset($_GET['examId']) ? trim((string)$_GET['examId']) : '';
    // ?noSnapshots=1 skips the base64 evidence images (often tens of KB each). Count-only callers like
    // the Dashboard tile poll 200 rows every 15 s and never display them.
    $snapshotColumn = (($_GET['noSnapshots'] ?? '') === '1') ? 'NULL AS snapshot_base64' : 'vl.snapshot_base64';
    if (!db_table_exists($pdo, 'violation_logs') || !db_table_exists($pdo, 'exam_sessions')) {
        json_response(['violations' => []]);
    }

    $hasCategory = db_column_exists($pdo, 'violation_logs', 'category');
    $hasConfidence = db_column_exists($pdo, 'violation_logs', 'confidence');
    $hasMetadataJson = db_column_exists($pdo, 'violation_logs', 'metadata_json');
    $hasReviews = db_table_exists($pdo, 'violation_reviews');

    if ($sessionId) {
        $stmt = $pdo->prepare('SELECT
                vl.id,
                vl.session_id,
                es.exam_id,
                es.student_id,
                vl.occurred_at,
                vl.type,
                ' . ($hasCategory ? 'vl.category' : 'NULL AS category') . ',
                ' . ($hasConfidence ? 'vl.confidence' : 'NULL AS confidence') . ',
                vl.description,
                ' . $snapshotColumn . ',
                ' . ($hasMetadataJson ? 'vl.metadata_json' : 'NULL AS metadata_json') . ',
                ' . ($hasReviews ? 'vr.decision' : 'NULL') . ' AS review_decision,
                ' . ($hasReviews ? 'vr.note' : 'NULL') . ' AS review_note,
                ' . ($hasReviews ? 'vr.reviewer' : 'NULL') . ' AS review_reviewer,
                ' . ($hasReviews ? 'vr.reviewed_at' : 'NULL') . ' AS review_time
            FROM violation_logs vl
            JOIN exam_sessions es ON es.id = vl.session_id
            ' . ($hasReviews ? 'LEFT JOIN violation_reviews vr ON vr.violation_id = vl.id' : '') . '
            WHERE vl.session_id = ? AND es.company_id = ?
            ORDER BY vl.occurred_at DESC
            LIMIT ?');
        $stmt->bindValue(1, $sessionId, PDO::PARAM_INT);
        $stmt->bindValue(2, $companyId, PDO::PARAM_INT);
        $stmt->bindValue(3, $limit, PDO::PARAM_INT);
        $stmt->execute();
        $rows = $stmt->fetchAll();
        $stmt->closeCursor();
    } else {
        $stmt = $pdo->prepare('SELECT
                vl.id,
                vl.session_id,
                es.exam_id,
                es.student_id,
                vl.occurred_at,
                vl.type,
                ' . ($hasCategory ? 'vl.category' : 'NULL AS category') . ',
                ' . ($hasConfidence ? 'vl.confidence' : 'NULL AS confidence') . ',
                vl.description,
                ' . $snapshotColumn . ',
                ' . ($hasMetadataJson ? 'vl.metadata_json' : 'NULL AS metadata_json') . ',
                ' . ($hasReviews ? 'vr.decision' : 'NULL') . ' AS review_decision,
                ' . ($hasReviews ? 'vr.note' : 'NULL') . ' AS review_note,
                ' . ($hasReviews ? 'vr.reviewer' : 'NULL') . ' AS review_reviewer,
                ' . ($hasReviews ? 'vr.reviewed_at' : 'NULL') . ' AS review_time
            FROM violation_logs vl
            JOIN exam_sessions es ON es.id = vl.session_id
            ' . ($hasReviews ? 'LEFT JOIN violation_reviews vr ON vr.violation_id = vl.id' : '') . '
            WHERE vl.company_id = ?
            ' . ($studentFilter !== '' ? 'AND es.student_id = ?' : '') . '
            ' . ($examFilter !== '' ? 'AND es.exam_id = ?' : '') . '
            ORDER BY vl.occurred_at DESC
            LIMIT ?');
        $bindIndex = 1;
        $stmt->bindValue($bindIndex++, $companyId, PDO::PARAM_INT);
        if ($studentFilter !== '') {
            $stmt->bindValue($bindIndex++, $studentFilter, PDO::PARAM_STR);
        }
        if ($examFilter !== '') {
            $stmt->bindValue($bindIndex++, $examFilter, PDO::PARAM_STR);
        }
        $stmt->bindValue($bindIndex++, $limit, PDO::PARAM_INT);
        $stmt->execute();
        $rows = $stmt->fetchAll();
        $stmt->closeCursor();
    }

    $violations = array_map(function ($row) {
        $metadata = null;
        if (isset($row['metadata_json']) && is_string($row['metadata_json']) && $row['metadata_json'] !== '') {
            $decoded = json_decode($row['metadata_json'], true);
            $metadata = is_array($decoded) ? $decoded : null;
        }
        return [
            'id' => $row['id'],
            'sessionId' => isset($row['session_id']) ? (int)$row['session_id'] : null,
            'examId' => $row['exam_id'],
            'studentId' => $row['student_id'],
            'timestamp' => datetime_to_ms($row['occurred_at']) ?? 0,
            'type' => $row['type'],
            'category' => $row['category'] ?? violation_category_for_type((string)$row['type']),
            'confidence' => isset($row['confidence']) && $row['confidence'] !== null ? (float)$row['confidence'] : null,
            'description' => $row['description'],
            'snapshot' => $row['snapshot_base64'] ?? null,
            'metadata' => $metadata,
            'review' => [
                'decision' => $row['review_decision'] ?? null,
                'note' => $row['review_note'] ?? null,
                'reviewer' => $row['review_reviewer'] ?? null,
                'reviewedAt' => isset($row['review_time']) ? (datetime_to_ms($row['review_time']) ?? null) : null,
            ],
        ];
    }, $rows);

    json_response(['violations' => $violations]);
}

if ($method === 'POST') {
    $payload = json_input();
    $companyId = require_company_id($payload);
    $action = $payload['action'] ?? null;
    if ($action === 'review') {
        $actorRole = require_role(['ADMIN', 'PROCTOR'], $payload);
        if (!db_table_exists($pdo, 'violation_logs') || !db_table_exists($pdo, 'violation_reviews')) {
            json_response(['error' => 'Violation review storage is unavailable on this database.'], 503);
        }
        $violationId = isset($payload['violationId']) ? (int)$payload['violationId'] : 0;
        $decision = isset($payload['decision']) ? strtoupper(trim((string)$payload['decision'])) : '';
        // violation_reviews.decision is ENUM('CLEARED','CONFIRMED','ESCALATED'): anything else used
        // to reach the INSERT and fail as a 500 instead of a clear 400.
        if ($decision !== '' && !in_array($decision, ['CLEARED', 'CONFIRMED', 'ESCALATED'], true)) {
            json_response(['error' => 'decision must be one of CLEARED, CONFIRMED, ESCALATED.'], 400);
        }
        $reviewer = isset($payload['reviewer']) ? (string)$payload['reviewer'] : (get_actor_id($payload) ?? null);
        $note = isset($payload['note']) ? (string)$payload['note'] : null;

        if ($violationId <= 0 || $decision === '') {
            json_response(['error' => 'violationId and decision are required.'], 400);
        }

        $check = $pdo->prepare('SELECT id FROM violation_logs WHERE id = ? AND company_id = ?');
        $check->execute([$violationId, $companyId]);
        if (!$check->fetch()) {
            json_response(['error' => 'Violation not found.'], 404);
        }

        $stmt = $pdo->prepare('INSERT INTO violation_reviews (violation_id, decision, reviewer, note, reviewed_at)
                               VALUES (?, ?, ?, ?, NOW(3))
                               ON DUPLICATE KEY UPDATE decision = VALUES(decision),
                                                       reviewer = VALUES(reviewer),
                                                       note = VALUES(note),
                                                       reviewed_at = VALUES(reviewed_at)');
        $stmt->execute([$violationId, $decision, $reviewer, $note]);
        audit_log($pdo, [
            'companyId' => $companyId,
            'actorRole' => $actorRole,
            'actorId' => $reviewer,
            'action' => 'VIOLATION_REVIEW',
            'targetType' => 'violation',
            'targetId' => (string)$violationId,
            'message' => "Violation reviewed: {$decision}",
            'metadata' => ['note' => $note]
        ]);
        json_response(['ok' => true]);
    }

    $examId = $payload['examId'] ?? null;
    $studentId = $payload['studentId'] ?? null;
    $violations = [];

    if (isset($payload['violations']) && is_array($payload['violations'])) {
        $violations = $payload['violations'];
    } elseif (isset($payload['violation']) && is_array($payload['violation'])) {
        $violations = [$payload['violation']];
    }

    if (!$examId || !$studentId || count($violations) === 0) {
        json_response(['error' => 'examId, studentId, and violations are required.'], 400);
    }
    if (!db_table_exists($pdo, 'violation_logs') || !db_table_exists($pdo, 'exam_sessions')) {
        json_response(['error' => 'Violation storage is unavailable on this database.'], 503);
    }

    // Resolve the session once for the whole batch. Prefer the exact session the client is
    // running under; fall back to the latest attempt only when it isn't supplied (or is stale
    // after an admin reset). Guessing per-violation attached evidence to the wrong attempt.
    $requestedSessionId = isset($payload['sessionId']) && is_numeric($payload['sessionId'])
        ? (int)$payload['sessionId']
        : null;
    $sessionRowId = null;
    if ($requestedSessionId) {
        $stmt = $pdo->prepare('SELECT id FROM exam_sessions
                               WHERE id = ? AND company_id = ? AND exam_id = ? AND student_id = ?');
        $stmt->execute([$requestedSessionId, $companyId, $examId, $studentId]);
        $row = $stmt->fetch();
        $stmt->closeCursor();
        if ($row) $sessionRowId = (int)$row['id'];
    }
    if ($sessionRowId === null) {
        $stmt = $pdo->prepare('SELECT id FROM exam_sessions
                               WHERE company_id = ? AND exam_id = ? AND student_id = ?
                               ORDER BY start_time DESC
                               LIMIT 1');
        $stmt->execute([$companyId, $examId, $studentId]);
        $row = $stmt->fetch();
        $stmt->closeCursor();
        if ($row) $sessionRowId = (int)$row['id'];
    }
    if ($sessionRowId === null) {
        // saved: 0 tells the client to keep the evidence queued and retry later.
        json_response(['saved' => 0, 'errors' => ['Session not found for this exam attempt.']]);
    }

    $errors = [];
    $count = 0;
    $allowedTypes = ['TAB_SWITCH','NO_FACE','MULTIPLE_FACES','GAZE_AWAY','AUDIO_DETECTED','FULLSCREEN_EXIT','COPY_PASTE','PHONE_DETECTED','ANOMALY_OBJECT','LOCATION_CHANGE','IDENTITY_CHANGE','SUSPICIOUS_BEHAVIOR'];
    foreach ($violations as $v) {
        $type = strtoupper(trim((string)($v['type'] ?? '')));
        $description = $v['description'] ?? '';
        $snapshot = $v['snapshot'] ?? null;
        $category = trim((string)($v['category'] ?? violation_category_for_type($type)));
        $confidence = isset($v['confidence']) && is_numeric($v['confidence'])
            ? max(0, min(1, (float)$v['confidence']))
            : null;
        $metadata = isset($v['metadata']) && (is_array($v['metadata']) || is_object($v['metadata']))
            ? json_encode($v['metadata'])
            : null;
        $timestamp = isset($v['timestamp']) && is_numeric($v['timestamp']) ? ((float)$v['timestamp'] / 1000) : microtime(true);
        // The event time comes from the candidate's clock (kept so queued evidence retains when it
        // happened). A clock running fast, or a junk value, must not date an incident in the future
        // — it would pin itself to the top of every newest-first feed and skew incident grouping —
        // and an out-of-range value makes FROM_UNIXTIME() NULL, failing the insert outright.
        $nowTs = microtime(true);
        if (!is_finite($timestamp) || $timestamp <= 0 || $timestamp > $nowTs) {
            $timestamp = $nowTs;
        }

        if (!in_array($type, $allowedTypes, true)) {
            $errors[] = "Invalid violation type: {$type}";
            continue;
        }

        try {
            $stmt = $pdo->prepare('INSERT INTO violation_logs
                (company_id, session_id, occurred_at, type, category, confidence, description, snapshot_base64, metadata_json)
                VALUES (?, ?, FROM_UNIXTIME(?), ?, ?, ?, ?, ?, ?)');
            $stmt->execute([
                $companyId,
                $sessionRowId,
                $timestamp,
                $type,
                $category !== '' ? $category : violation_category_for_type($type),
                $confidence,
                $description,
                $snapshot,
                $metadata
            ]);
            $count++;
            audit_log($pdo, [
                'companyId' => $companyId,
                'actorRole' => 'STUDENT',
                'actorId' => $studentId,
                'action' => 'VIOLATION_ADD',
                'targetType' => 'exam',
                'targetId' => $examId,
                'message' => $type,
                'metadata' => ['description' => $description, 'category' => $category, 'confidence' => $confidence]
            ]);
        } catch (Throwable $e) {
            $errors[] = $e->getMessage();
        }
    }

    json_response(['saved' => $count, 'errors' => $errors]);
}

json_response(['error' => 'Method not allowed.'], 405);
