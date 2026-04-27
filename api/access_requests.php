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

function parse_summary($raw): ?array {
    if (is_array($raw)) return $raw;
    if (!is_string($raw) || $raw === '') return null;
    $decoded = json_decode($raw, true);
    return is_array($decoded) ? $decoded : null;
}

function build_violation_summary(PDO $pdo, int $companyId, string $examId, string $studentId): array {
    $sessionStmt = $pdo->prepare("SELECT id
                                  FROM exam_sessions
                                  WHERE company_id = ? AND exam_id = ? AND student_id = ? AND status = 'TERMINATED'
                                  ORDER BY COALESCE(end_time, start_time) DESC
                                  LIMIT 1");
    $sessionStmt->execute([$companyId, $examId, $studentId]);
    $session = $sessionStmt->fetch();
    $sessionStmt->closeCursor();

    if (!$session) {
        return ['total' => 0, 'byType' => new stdClass(), 'byCategory' => new stdClass()];
    }

    $sessionId = (int)$session['id'];
    $vStmt = $pdo->prepare("SELECT vl.type, COUNT(*) AS cnt
                            FROM violation_logs vl
                            WHERE vl.company_id = ? AND vl.session_id = ?
                            GROUP BY vl.type");
    $vStmt->execute([$companyId, $sessionId]);
    $rows = $vStmt->fetchAll();
    $vStmt->closeCursor();

    $byType = [];
    $total = 0;
    foreach ($rows as $row) {
        $type = (string)$row['type'];
        $cnt = (int)$row['cnt'];
        $byType[$type] = $cnt;
        $total += $cnt;
    }

    $camera = ($byType['NO_FACE'] ?? 0)
        + ($byType['MULTIPLE_FACES'] ?? 0)
        + ($byType['GAZE_AWAY'] ?? 0)
        + ($byType['PHONE_DETECTED'] ?? 0)
        + ($byType['ANOMALY_OBJECT'] ?? 0);

    $byCategory = [
        'camera' => $camera,
        'microphone' => (int)($byType['AUDIO_DETECTED'] ?? 0),
        'fullscreen' => (int)($byType['FULLSCREEN_EXIT'] ?? 0),
        'copyPaste' => (int)($byType['COPY_PASTE'] ?? 0),
        'tabSwitch' => (int)($byType['TAB_SWITCH'] ?? 0),
        'environment' => (int)($byType['LOCATION_CHANGE'] ?? 0),
    ];

    return [
        'total' => $total,
        'byType' => $byType,
        'byCategory' => $byCategory,
    ];
}

function ensure_access_request_schema(PDO $pdo): void {
    $pdo->exec("CREATE TABLE IF NOT EXISTS exam_access_requests (
      id                     BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      company_id             INT NOT NULL DEFAULT 1,
      exam_id                VARCHAR(64) NOT NULL,
      student_id             VARCHAR(64) NOT NULL,
      session_id             BIGINT UNSIGNED NULL,
      status                 ENUM('PENDING','GRANTED','REVOKED') NOT NULL DEFAULT 'PENDING',
      reason                 TEXT NULL,
      violation_summary_json JSON NULL,
      review_note            TEXT NULL,
      reviewed_by            VARCHAR(64) NULL,
      requested_at           TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      reviewed_at            TIMESTAMP NULL DEFAULT NULL,
      INDEX idx_access_request_lookup (company_id, exam_id, student_id, status),
      INDEX idx_access_request_created (requested_at)
    ) ENGINE=InnoDB");
    db_add_column_if_missing($pdo, 'exam_access_requests', 'request_type', "VARCHAR(32) NOT NULL DEFAULT 'REATTEMPT' AFTER session_id");
    db_add_column_if_missing($pdo, 'exam_access_requests', 'previous_device_fingerprint', "VARCHAR(128) NULL AFTER reason");
    db_add_column_if_missing($pdo, 'exam_access_requests', 'new_device_fingerprint', "VARCHAR(128) NULL AFTER previous_device_fingerprint");
    db_add_column_if_missing($pdo, 'exam_access_requests', 'previous_device_json', "JSON NULL AFTER new_device_fingerprint");
    db_add_column_if_missing($pdo, 'exam_access_requests', 'new_device_json', "JSON NULL AFTER previous_device_json");
}

function normalize_device_payload($raw): ?array {
    if (!is_array($raw)) return null;
    $out = [];
    foreach ($raw as $key => $value) {
        if (!is_string($key)) continue;
        if (is_scalar($value) || $value === null) {
            $out[$key] = is_string($value) ? substr($value, 0, 300) : $value;
        }
    }
    return $out;
}

$method = $_SERVER['REQUEST_METHOD'];
$accessRequestSchemaReady = true;
try {
    ensure_access_request_schema($pdo);
} catch (Throwable $e) {
    $accessRequestSchemaReady = false;
}

if ($method === 'GET') {
    $companyId = require_company_id();
    if (!$accessRequestSchemaReady) {
        json_response(['requests' => []]);
    }
    $limit = isset($_GET['limit']) ? (int)$_GET['limit'] : 100;
    if ($limit <= 0) $limit = 100;
    if ($limit > 300) $limit = 300;
    $status = isset($_GET['status']) ? strtoupper(trim((string)$_GET['status'])) : '';
    if ($status !== '' && !in_array($status, ['PENDING', 'GRANTED', 'REVOKED'], true)) {
        $status = '';
    }

    if ($status !== '') {
        $stmt = $pdo->prepare("SELECT id, exam_id, student_id, session_id, request_type, status, reason, previous_device_fingerprint, new_device_fingerprint, previous_device_json, new_device_json, violation_summary_json, requested_at, reviewed_at, reviewed_by, review_note
                               FROM exam_access_requests
                               WHERE company_id = ? AND status = ?
                               ORDER BY requested_at DESC
                               LIMIT {$limit}");
        $stmt->execute([$companyId, $status]);
    } else {
        $stmt = $pdo->prepare("SELECT id, exam_id, student_id, session_id, request_type, status, reason, previous_device_fingerprint, new_device_fingerprint, previous_device_json, new_device_json, violation_summary_json, requested_at, reviewed_at, reviewed_by, review_note
                               FROM exam_access_requests
                               WHERE company_id = ?
                               ORDER BY requested_at DESC
                               LIMIT {$limit}");
        $stmt->execute([$companyId]);
    }
    $rows = $stmt->fetchAll();
    $stmt->closeCursor();

    $requests = array_map(function ($row) {
        return [
            'id' => (int)$row['id'],
            'examId' => $row['exam_id'],
            'studentId' => $row['student_id'],
            'sessionId' => $row['session_id'] !== null ? (int)$row['session_id'] : null,
            'requestType' => $row['request_type'] ?? 'REATTEMPT',
            'status' => $row['status'],
            'reason' => $row['reason'] ?? null,
            'previousDeviceFingerprint' => $row['previous_device_fingerprint'] ?? null,
            'newDeviceFingerprint' => $row['new_device_fingerprint'] ?? null,
            'previousDevice' => parse_summary($row['previous_device_json'] ?? null),
            'newDevice' => parse_summary($row['new_device_json'] ?? null),
            'violationSummary' => parse_summary($row['violation_summary_json'] ?? null),
            'requestedAt' => datetime_to_ms($row['requested_at']) ?? 0,
            'reviewedAt' => datetime_to_ms($row['reviewed_at'] ?? null),
            'reviewedBy' => $row['reviewed_by'] ?? null,
            'reviewNote' => $row['review_note'] ?? null,
        ];
    }, $rows);

    json_response(['requests' => $requests]);
}

if ($method === 'POST') {
    $payload = json_input();
    $companyId = require_company_id($payload);
    $action = strtoupper(trim((string)($payload['action'] ?? '')));

    if ($action === 'REQUEST') {
        if (!$accessRequestSchemaReady) {
            json_response(['error' => 'ACCESS_REQUEST_SCHEMA_UNAVAILABLE', 'message' => 'Access request table unavailable. Please run schema migration.'], 503);
        }
        $examId = trim((string)($payload['examId'] ?? ''));
        $studentId = trim((string)($payload['studentId'] ?? ''));
        $reason = trim((string)($payload['reason'] ?? ''));
        $requestType = strtoupper(trim((string)($payload['requestType'] ?? 'REATTEMPT')));
        if (!in_array($requestType, ['REATTEMPT', 'DEVICE_CHANGE'], true)) {
            $requestType = 'REATTEMPT';
        }
        if ($examId === '' || $studentId === '') {
            json_response(['error' => 'examId and studentId are required.'], 400);
        }
        if ($requestType === 'DEVICE_CHANGE' && $reason === '') {
            json_response(['error' => 'COMMENT_REQUIRED', 'message' => 'Please explain why you need to continue from a different device.'], 400);
        }

        $block = null;
        if ($requestType === 'REATTEMPT') {
            $blockStmt = $pdo->prepare("SELECT id, created_at
                                        FROM exam_access_logs
                                        WHERE company_id = ? AND exam_id = ? AND student_id = ? AND action = 'VIOLATION_BLOCK'
                                        ORDER BY created_at DESC
                                        LIMIT 1");
            $blockStmt->execute([$companyId, $examId, $studentId]);
            $block = $blockStmt->fetch();
            $blockStmt->closeCursor();

            if (!$block) {
                json_response(['error' => 'NOT_BLOCKED', 'message' => 'No blocked attempt found for this exam.'], 400);
            }
        }

        $sessionStmt = $pdo->prepare("SELECT id, start_time, device_fingerprint, device_metadata_json
                                      FROM exam_sessions
                                      WHERE company_id = ? AND exam_id = ? AND student_id = ?
                                      ORDER BY start_time DESC
                                      LIMIT 1");
        $sessionStmt->execute([$companyId, $examId, $studentId]);
        $session = $sessionStmt->fetch();
        $sessionStmt->closeCursor();
        $sessionId = $session ? (int)$session['id'] : null;
        $previousDeviceFingerprint = $session['device_fingerprint'] ?? ($payload['previousDeviceFingerprint'] ?? null);
        $newDeviceFingerprint = trim((string)($payload['newDeviceFingerprint'] ?? ''));
        if ($newDeviceFingerprint === '') {
            $newDeviceFingerprint = null;
        }
        $previousDevice = parse_summary($session['device_metadata_json'] ?? null) ?? normalize_device_payload($payload['previousDevice'] ?? null);
        $newDevice = normalize_device_payload($payload['newDevice'] ?? null);
        if ($requestType === 'DEVICE_CHANGE' && (!$sessionId || !$newDeviceFingerprint)) {
            json_response(['error' => 'DEVICE_CONTEXT_REQUIRED', 'message' => 'Device change request requires the active session and new device fingerprint.'], 400);
        }

        $existingStmt = $pdo->prepare("SELECT id, status
                                       FROM exam_access_requests
                                       WHERE company_id = ? AND exam_id = ? AND student_id = ? AND request_type = ? AND requested_at >= ?
                                       ORDER BY requested_at DESC
                                       LIMIT 1");
        $since = $requestType === 'REATTEMPT' ? $block['created_at'] : ($session['start_time'] ?? date('Y-m-d H:i:s'));
        $existingStmt->execute([$companyId, $examId, $studentId, $requestType, $since]);
        $existing = $existingStmt->fetch();
        $existingStmt->closeCursor();

        if ($existing && ($existing['status'] ?? '') === 'PENDING') {
            json_response([
                'ok' => true,
                'requestId' => (int)$existing['id'],
                'status' => 'PENDING',
                'existing' => true
            ]);
        }
        if ($existing && ($existing['status'] ?? '') === 'GRANTED') {
            json_response([
                'ok' => true,
                'requestId' => (int)$existing['id'],
                'status' => 'GRANTED',
                'existing' => true
            ]);
        }

        $summary = parse_summary($payload['violationSummary'] ?? null);
        if (!$summary) {
            $summary = build_violation_summary($pdo, $companyId, $examId, $studentId);
        }

        if ($requestType === 'REATTEMPT') {
            $terminatedStmt = $pdo->prepare("SELECT id
                                          FROM exam_sessions
                                          WHERE company_id = ? AND exam_id = ? AND student_id = ? AND status = 'TERMINATED'
                                          ORDER BY COALESCE(end_time, start_time) DESC
                                          LIMIT 1");
            $terminatedStmt->execute([$companyId, $examId, $studentId]);
            $terminatedSession = $terminatedStmt->fetch();
            $terminatedStmt->closeCursor();
            $sessionId = $terminatedSession ? (int)$terminatedSession['id'] : $sessionId;
        }

        $insert = $pdo->prepare("INSERT INTO exam_access_requests
            (company_id, exam_id, student_id, session_id, request_type, status, reason, previous_device_fingerprint, new_device_fingerprint, previous_device_json, new_device_json, violation_summary_json)
            VALUES (?, ?, ?, ?, ?, 'PENDING', ?, ?, ?, ?, ?, ?)");
        $insert->execute([
            $companyId,
            $examId,
            $studentId,
            $sessionId,
            $requestType,
            $reason !== '' ? $reason : 'Student requested reattempt access after violation lock.',
            $previousDeviceFingerprint,
            $newDeviceFingerprint,
            $previousDevice ? json_encode($previousDevice) : null,
            $newDevice ? json_encode($newDevice) : null,
            json_encode($summary)
        ]);

        $requestId = (int)$pdo->lastInsertId();

        $log = $pdo->prepare('CALL sp_log_access(?, ?, ?, ?, ?, ?)');
        $log->execute([$companyId, $examId, $studentId, 'ACCESS_REQUEST', 'PENDING', "Student requested {$requestType} access"]);
        while ($log->nextRowset()) {}
        $log->closeCursor();

        audit_log($pdo, [
            'companyId' => $companyId,
            'actorRole' => 'STUDENT',
            'actorId' => $studentId,
            'action' => 'ACCESS_REQUEST_CREATE',
            'targetType' => 'exam',
            'targetId' => $examId,
            'message' => "Student requested {$requestType} access",
            'metadata' => ['requestId' => $requestId, 'requestType' => $requestType]
        ]);

        json_response(['ok' => true, 'requestId' => $requestId, 'status' => 'PENDING']);
    }

    if ($action === 'REVIEW') {
        $actorRole = require_role(['SUPER_ADMIN', 'ADMIN', 'PROCTOR'], $payload);
        if (!$accessRequestSchemaReady) {
            json_response(['error' => 'ACCESS_REQUEST_SCHEMA_UNAVAILABLE', 'message' => 'Access request table unavailable. Please run schema migration.'], 503);
        }
        $requestId = isset($payload['requestId']) ? (int)$payload['requestId'] : 0;
        $decision = strtoupper(trim((string)($payload['decision'] ?? '')));
        $reviewer = trim((string)($payload['reviewer'] ?? (get_actor_id($payload) ?? '')));
        $note = trim((string)($payload['note'] ?? ''));

        if ($requestId <= 0 || !in_array($decision, ['GRANTED', 'REVOKED'], true)) {
            json_response(['error' => 'requestId and valid decision are required.'], 400);
        }

        $check = $pdo->prepare("SELECT id, exam_id, student_id, session_id, request_type, new_device_fingerprint, new_device_json
                                FROM exam_access_requests
                                WHERE id = ? AND company_id = ?
                                LIMIT 1");
        $check->execute([$requestId, $companyId]);
        $request = $check->fetch();
        $check->closeCursor();

        if (!$request) {
            json_response(['error' => 'REQUEST_NOT_FOUND'], 404);
        }
        if (($request['request_type'] ?? '') === 'DEVICE_CHANGE' && $actorRole !== 'SUPER_ADMIN') {
            json_response(['error' => 'Only super admin can review device change requests.'], 403);
        }
        if (($request['request_type'] ?? '') !== 'DEVICE_CHANGE' && !in_array($actorRole, ['SUPER_ADMIN', 'ADMIN'], true)) {
            json_response(['error' => 'Only admin roles can review this request.'], 403);
        }

        $update = $pdo->prepare("UPDATE exam_access_requests
                                 SET status = ?, reviewed_at = NOW(3), reviewed_by = ?, review_note = ?
                                 WHERE id = ? AND company_id = ?");
        $update->execute([
            $decision,
            $reviewer !== '' ? $reviewer : null,
            $note !== '' ? $note : null,
            $requestId,
            $companyId
        ]);

        if ($decision === 'GRANTED' && ($request['request_type'] ?? '') === 'DEVICE_CHANGE' && !empty($request['session_id']) && !empty($request['new_device_fingerprint'])) {
            $rebind = $pdo->prepare('UPDATE exam_sessions
                                     SET device_fingerprint = ?, device_metadata_json = ?
                                     WHERE id = ? AND company_id = ?');
            $rebind->execute([
                $request['new_device_fingerprint'],
                $request['new_device_json'] ?? null,
                (int)$request['session_id'],
                $companyId
            ]);
        }

        $log = $pdo->prepare('CALL sp_log_access(?, ?, ?, ?, ?, ?)');
        $log->execute([
            $companyId,
            $request['exam_id'],
            $request['student_id'],
            'ACCESS_REVIEW',
            $decision,
            $note !== '' ? $note : "Access request {$decision}"
        ]);
        while ($log->nextRowset()) {}
        $log->closeCursor();

        audit_log($pdo, [
            'companyId' => $companyId,
            'actorRole' => $actorRole,
            'actorId' => $reviewer !== '' ? $reviewer : null,
            'action' => 'ACCESS_REQUEST_REVIEW',
            'targetType' => 'exam',
            'targetId' => $request['exam_id'],
            'message' => "Access request {$decision}",
            'metadata' => ['requestId' => $requestId, 'requestType' => $request['request_type'] ?? 'REATTEMPT', 'note' => $note]
        ]);

        json_response(['ok' => true, 'status' => $decision]);
    }

    json_response(['error' => 'Invalid action.'], 400);
}

json_response(['error' => 'Method not allowed.'], 405);
