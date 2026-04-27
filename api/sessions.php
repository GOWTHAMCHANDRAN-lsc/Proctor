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

function normalize_summary_for_log($summary): ?array {
    if (is_string($summary) && $summary !== '') {
        $decoded = json_decode($summary, true);
        if (is_array($decoded)) {
            $summary = $decoded;
        }
    }
    if (!is_array($summary)) {
        return null;
    }
    return $summary;
}

function ensure_session_security_schema(PDO $pdo): void {
    db_add_column_if_missing($pdo, 'exam_sessions', 'device_metadata_json', 'JSON NULL AFTER device_fingerprint');
    db_add_column_if_missing($pdo, 'exam_sessions', 'location_lat', 'DECIMAL(10,7) NULL AFTER location');
    db_add_column_if_missing($pdo, 'exam_sessions', 'location_lng', 'DECIMAL(10,7) NULL AFTER location_lat');
    db_add_column_if_missing($pdo, 'exam_sessions', 'location_accuracy_m', 'INT NULL AFTER location_lng');
    db_add_column_if_missing($pdo, 'exam_sessions', 'mac_address', 'VARCHAR(32) NULL AFTER device_metadata_json');
    db_add_column_if_missing($pdo, 'exam_sessions', 'mac_bound', 'TINYINT(1) NOT NULL DEFAULT 0 AFTER mac_address');
    $pdo->exec("CREATE TABLE IF NOT EXISTS exam_location_logs (
      id                     BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      company_id             INT NOT NULL DEFAULT 1,
      session_id             BIGINT UNSIGNED NOT NULL,
      exam_id                VARCHAR(64) NOT NULL,
      student_id             VARCHAR(64) NOT NULL,
      latitude               DECIMAL(10,7) NULL,
      longitude              DECIMAL(10,7) NULL,
      accuracy_m             INT NULL,
      location_label         VARCHAR(255) NULL,
      distance_from_start_m  INT NULL,
      flagged                TINYINT(1) NOT NULL DEFAULT 0,
      created_at             TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_location_session (session_id, created_at),
      INDEX idx_location_flagged (company_id, flagged, created_at)
    ) ENGINE=InnoDB");
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

function ensure_location_violation_support(PDO $pdo): void {
    try {
        $stmt = $pdo->query("SHOW COLUMNS FROM violation_logs LIKE 'type'");
        $column = $stmt ? $stmt->fetch() : null;
        if ($stmt) $stmt->closeCursor();
        $type = is_array($column) ? (string)($column['Type'] ?? '') : '';
        if (stripos($type, 'LOCATION_CHANGE') === false) {
            $pdo->exec("ALTER TABLE violation_logs MODIFY type ENUM('TAB_SWITCH','NO_FACE','MULTIPLE_FACES','GAZE_AWAY','AUDIO_DETECTED','FULLSCREEN_EXIT','COPY_PASTE','PHONE_DETECTED','ANOMALY_OBJECT','LOCATION_CHANGE') NOT NULL");
        }
    } catch (Throwable $e) {
        // Best effort only.
    }
    db_add_column_if_missing($pdo, 'violation_logs', 'category', "VARCHAR(32) NULL AFTER type");
    db_add_column_if_missing($pdo, 'violation_logs', 'confidence', "DECIMAL(5,4) NULL AFTER category");
    db_add_column_if_missing($pdo, 'violation_logs', 'metadata_json', "JSON NULL AFTER snapshot_base64");
}

function normalize_device_metadata($raw): ?array {
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

function normalize_geo($raw): array {
    if (!is_array($raw)) {
        return ['label' => null, 'lat' => null, 'lng' => null, 'accuracy' => null];
    }
    $lat = isset($raw['lat']) && is_numeric($raw['lat']) ? (float)$raw['lat'] : null;
    $lng = isset($raw['lng']) && is_numeric($raw['lng']) ? (float)$raw['lng'] : null;
    $accuracy = isset($raw['accuracy']) && is_numeric($raw['accuracy']) ? (int)round((float)$raw['accuracy']) : null;
    $label = isset($raw['label']) ? trim((string)$raw['label']) : null;
    if ($label !== null && strlen($label) > 255) $label = substr($label, 0, 255);
    return ['label' => $label, 'lat' => $lat, 'lng' => $lng, 'accuracy' => $accuracy];
}

function distance_m(?float $lat1, ?float $lng1, ?float $lat2, ?float $lng2): ?int {
    if ($lat1 === null || $lng1 === null || $lat2 === null || $lng2 === null) return null;
    $earth = 6371000;
    $dLat = deg2rad($lat2 - $lat1);
    $dLng = deg2rad($lng2 - $lng1);
    $a = sin($dLat / 2) ** 2 + cos(deg2rad($lat1)) * cos(deg2rad($lat2)) * sin($dLng / 2) ** 2;
    return (int)round($earth * 2 * atan2(sqrt($a), sqrt(1 - $a)));
}

$method = $_SERVER['REQUEST_METHOD'];
ensure_session_security_schema($pdo);

if ($method === 'GET') {
    $companyId = require_company_id();
    $stmt = $pdo->prepare("SELECT
        es.exam_id,
        es.student_id,
        es.start_time,
        es.end_time,
        es.status,
        es.ip_address,
        es.user_agent,
        es.device_fingerprint,
        es.device_metadata_json,
        es.mac_address,
        es.mac_bound,
        es.location,
        es.location_lat,
        es.location_lng,
        es.location_accuracy_m,
        EXISTS(
            SELECT 1 FROM exam_access_logs l
            WHERE l.company_id = es.company_id
              AND l.exam_id = es.exam_id
              AND l.student_id = es.student_id
              AND l.action = 'RECONNECT'
              AND l.status = 'WARN_IP'
              AND l.created_at >= es.start_time
        ) AS ip_change_detected,
        EXISTS(
            SELECT 1 FROM exam_access_logs l
            WHERE l.company_id = es.company_id
              AND l.exam_id = es.exam_id
              AND l.student_id = es.student_id
              AND l.action = 'RECONNECT'
              AND l.status IN ('WARN_DEVICE','DENY_DEVICE')
              AND l.created_at >= es.start_time
        ) AS device_change_detected,
        EXISTS(
            SELECT 1 FROM exam_location_logs ll
            WHERE ll.company_id = es.company_id
              AND ll.session_id = es.id
              AND ll.flagged = 1
        ) AS location_change_detected
      FROM exam_sessions es
      WHERE es.company_id = ?
      ORDER BY es.start_time DESC");
    $stmt->execute([$companyId]);
    $rows = $stmt->fetchAll();
    $stmt->closeCursor();

    $sessions = array_map(function ($row) {
        return [
            'examId' => $row['exam_id'],
            'studentId' => $row['student_id'],
            'startTime' => datetime_to_ms($row['start_time']) ?? 0,
            'status' => $row['status'],
            'ipAddress' => $row['ip_address'],
            'userAgent' => $row['user_agent'],
            'deviceFingerprint' => $row['device_fingerprint'] ?? null,
            'deviceMetadata' => isset($row['device_metadata_json']) && is_string($row['device_metadata_json']) ? json_decode($row['device_metadata_json'], true) : null,
            'macAddress' => $row['mac_address'] ?? null,
            'macBound' => !empty($row['mac_bound']),
            'location' => $row['location'],
            'locationLat' => isset($row['location_lat']) ? (float)$row['location_lat'] : null,
            'locationLng' => isset($row['location_lng']) ? (float)$row['location_lng'] : null,
            'locationAccuracy' => isset($row['location_accuracy_m']) ? (int)$row['location_accuracy_m'] : null,
            'ipChangeDetected' => !empty($row['ip_change_detected']),
            'deviceChangeDetected' => !empty($row['device_change_detected']),
            'locationChangeDetected' => !empty($row['location_change_detected']),
        ];
    }, $rows);

    json_response(['sessions' => $sessions]);
}

if ($method === 'POST') {
    $payload = json_input();
    $companyId = require_company_id($payload);
    $action = $payload['action'] ?? 'start';
    $examId = $payload['examId'] ?? null;
    $studentId = $payload['studentId'] ?? null;
    $deviceFingerprint = $payload['deviceFingerprint'] ?? null;
    if (!is_string($deviceFingerprint) || $deviceFingerprint === '') {
        $deviceFingerprint = null;
    }
    $deviceMetadata = normalize_device_metadata($payload['deviceMetadata'] ?? null);
    $deviceMetadataJson = $deviceMetadata ? json_encode($deviceMetadata) : null;
    $geo = normalize_geo($payload['geoLocation'] ?? null);
    $macAddress = $payload['macAddress'] ?? null;
    if (!is_string($macAddress) || $macAddress === '') {
        $macAddress = null;
    }
    // Validate MAC address format if provided
    if ($macAddress !== null && !preg_match('/^([0-9A-Fa-f]{2}[:-]){5}([0-9A-Fa-f]{2})$/', $macAddress)) {
        $macAddress = null; // Invalid format, ignore
    }

    if (!$examId || !$studentId) {
        json_response(['error' => 'examId and studentId are required.'], 400);
    }

    if ($action === 'reset_mac') {
        // Super admin can reset MAC binding for a student
        $adminId = require_admin_id($payload);
        
        $reset = $pdo->prepare('CALL sp_reset_mac_binding(?, ?, ?)');
        try {
            $reset->execute([$companyId, $examId, $studentId]);
            while ($reset->nextRowset()) {}
            $reset->closeCursor();
            
            audit_log($pdo, [
                'companyId' => $companyId,
                'actorRole' => 'ADMIN',
                'actorId' => $adminId,
                'action' => 'MAC_BINDING_RESET',
                'targetType' => 'exam',
                'targetId' => $examId,
                'message' => "MAC binding reset for student {$studentId}.",
                'metadata' => ['studentId' => $studentId]
            ]);
            
            json_response(['ok' => true, 'message' => 'MAC binding has been reset. Student can now take exam from a new device.']);
        } catch (Throwable $e) {
            json_response(['error' => 'RESET_FAILED', 'message' => 'Failed to reset MAC binding.'], 500);
        }
        exit;
    }

    if ($action === 'start') {
        $examCheck = $pdo->prepare('SELECT id FROM exams WHERE id = ? AND company_id = ? LIMIT 1');
        $examCheck->execute([$examId, $companyId]);
        if (!$examCheck->fetch()) {
            json_response(['error' => 'EXAM_NOT_FOUND'], 404);
        }
        $studentCheck = $pdo->prepare('SELECT id FROM students WHERE id = ? AND company_id = ? LIMIT 1');
        $studentCheck->execute([$studentId, $companyId]);
        if (!$studentCheck->fetch()) {
            json_response(['error' => 'STUDENT_NOT_FOUND'], 404);
        }

        $completedCheck = $pdo->prepare("SELECT id, end_time
                                         FROM exam_sessions
                                         WHERE company_id = ? AND exam_id = ? AND student_id = ? AND status = 'COMPLETED'
                                         ORDER BY COALESCE(end_time, start_time) DESC
                                         LIMIT 1");
        $completedCheck->execute([$companyId, $examId, $studentId]);
        $completedSession = $completedCheck->fetch();
        $completedCheck->closeCursor();

        if ($completedSession) {
            $completedAt = $completedSession['end_time'] ?? null;
            $message = 'Exam already completed. Access link is now expired.';
            if (is_string($completedAt) && $completedAt !== '') {
                $message .= " Completed at {$completedAt}.";
            }

            $log = $pdo->prepare('CALL sp_log_access(?, ?, ?, ?, ?, ?)');
            $log->execute([$companyId, $examId, $studentId, 'START', 'DENY', $message]);
            while ($log->nextRowset()) {}
            $log->closeCursor();

            json_response(['error' => 'SESSION_EXISTS', 'message' => $message], 409);
        }

        try {
            $blockStmt = $pdo->prepare("SELECT id, created_at, message
                                        FROM exam_access_logs
                                        WHERE company_id = ? AND exam_id = ? AND student_id = ? AND action = 'VIOLATION_BLOCK'
                                        ORDER BY created_at DESC
                                        LIMIT 1");
            $blockStmt->execute([$companyId, $examId, $studentId]);
            $latestBlock = $blockStmt->fetch();
            $blockStmt->closeCursor();

            if ($latestBlock) {
                $requestStmt = $pdo->prepare("SELECT id, status, requested_at, reviewed_at
                                              FROM exam_access_requests
                                              WHERE company_id = ? AND exam_id = ? AND student_id = ? AND requested_at >= ?
                                              ORDER BY requested_at DESC
                                              LIMIT 1");
                $requestStmt->execute([$companyId, $examId, $studentId, $latestBlock['created_at']]);
                $latestRequest = $requestStmt->fetch();
                $requestStmt->closeCursor();

                $status = $latestRequest['status'] ?? null;
                if ($status !== 'GRANTED') {
                    $errorCode = 'ACCESS_REQUEST_REQUIRED';
                    $message = 'Access blocked due to policy violation. Request admin approval to reattempt.';
                    if ($status === 'PENDING') {
                        $errorCode = 'ACCESS_REQUEST_PENDING';
                        $message = 'Your access request is pending admin review.';
                    } elseif ($status === 'REVOKED') {
                        $errorCode = 'ACCESS_REQUEST_REVOKED';
                        $message = 'Your access request was revoked by admin.';
                    }

                    $log = $pdo->prepare('CALL sp_log_access(?, ?, ?, ?, ?, ?)');
                    $log->execute([$companyId, $examId, $studentId, 'START', 'DENY', $message]);
                    while ($log->nextRowset()) {}
                    $log->closeCursor();

                    json_response([
                        'error' => $errorCode,
                        'message' => $message,
                        'requestStatus' => $status,
                        'blockLogId' => (int)$latestBlock['id'],
                        'blockDetail' => $latestBlock['message'] ?? null,
                    ], 409);
                }
            }
        } catch (Throwable $e) {
            // Backward compatibility for deployments that have not added request tables yet.
        }

        $check = $pdo->prepare("SELECT id, status, ip_address, device_fingerprint, start_time
                                FROM exam_sessions
                                WHERE company_id = ? AND exam_id = ? AND student_id = ? AND status = 'IN_PROGRESS'
                                ORDER BY start_time DESC
                                LIMIT 1");
        $check->execute([$companyId, $examId, $studentId]);
        $existing = $check->fetch();
        $check->closeCursor();

        if ($existing) {
            $existingIp = $existing['ip_address'] ?? null;
            $existingDevice = $existing['device_fingerprint'] ?? null;
            $existingId = $existing['id'] ?? null;

            $userAgent = $_SERVER['HTTP_USER_AGENT'] ?? '';
            $ipAddress = $_SERVER['REMOTE_ADDR'] ?? '';
            $location = $geo['label'] ?? ($payload['location'] ?? null);

            if (is_string($deviceFingerprint) && strlen($deviceFingerprint) > 128) {
                $deviceFingerprint = substr($deviceFingerprint, 0, 128);
            }

            if ($ipAddress && $existingIp && $ipAddress !== $existingIp) {
                $log = $pdo->prepare('CALL sp_log_access(?, ?, ?, ?, ?, ?)');
                $log->execute([$companyId, $examId, $studentId, 'RECONNECT', 'WARN_IP', "IP changed from {$existingIp} to {$ipAddress}."]);
                while ($log->nextRowset()) {}
                $log->closeCursor();
            }

            if ($deviceFingerprint && $existingDevice && $deviceFingerprint !== $existingDevice) {
                $requestStmt = $pdo->prepare("SELECT id, status
                                              FROM exam_access_requests
                                              WHERE company_id = ?
                                                AND exam_id = ?
                                                AND student_id = ?
                                                AND request_type = 'DEVICE_CHANGE'
                                                AND new_device_fingerprint = ?
                                                AND requested_at >= ?
                                              ORDER BY requested_at DESC
                                              LIMIT 1");
                $requestStmt->execute([$companyId, $examId, $studentId, $deviceFingerprint, $existing['start_time']]);
                $deviceRequest = $requestStmt->fetch();
                $requestStmt->closeCursor();

                if (!$deviceRequest || ($deviceRequest['status'] ?? '') !== 'GRANTED') {
                    $log = $pdo->prepare('CALL sp_log_access(?, ?, ?, ?, ?, ?)');
                    $log->execute([$companyId, $examId, $studentId, 'RECONNECT', 'DENY_DEVICE', 'Device fingerprint mismatch blocked.']);
                    while ($log->nextRowset()) {}
                    $log->closeCursor();

                    json_response([
                        'error' => ($deviceRequest && ($deviceRequest['status'] ?? '') === 'PENDING') ? 'DEVICE_CHANGE_PENDING' : 'DEVICE_CHANGE_REQUIRED',
                        'message' => ($deviceRequest && ($deviceRequest['status'] ?? '') === 'PENDING')
                            ? 'Your device change request is pending super admin approval.'
                            : 'This exam is already bound to another device. Request access with a reason to continue.',
                        'requestStatus' => $deviceRequest['status'] ?? null,
                        'previousDeviceFingerprint' => $existingDevice,
                        'newDeviceFingerprint' => $deviceFingerprint,
                        'sessionId' => $existingId ? (int)$existingId : null,
                    ], 409);
                }

                $updateDevice = $pdo->prepare('UPDATE exam_sessions
                                               SET device_fingerprint = ?, device_metadata_json = ?, location = COALESCE(?, location),
                                                   location_lat = COALESCE(?, location_lat),
                                                   location_lng = COALESCE(?, location_lng),
                                                   location_accuracy_m = COALESCE(?, location_accuracy_m)
                                               WHERE id = ? AND company_id = ?');
                $updateDevice->execute([
                    $deviceFingerprint,
                    $deviceMetadataJson,
                    $location,
                    $geo['lat'],
                    $geo['lng'],
                    $geo['accuracy'],
                    $existingId,
                    $companyId
                ]);
            }

            if ($existingId && !$existingDevice && $deviceFingerprint) {
                $update = $pdo->prepare('UPDATE exam_sessions SET device_fingerprint = ? WHERE id = ? AND company_id = ?');
                $update->execute([$deviceFingerprint, $existingId, $companyId]);
            }

            if ($existingId && !$existingIp && $ipAddress) {
                $update = $pdo->prepare('UPDATE exam_sessions SET ip_address = ? WHERE id = ? AND company_id = ?');
                $update->execute([$ipAddress, $existingId, $companyId]);
            }

            $limitStmt = $pdo->prepare('SELECT reconnect_limit FROM exams WHERE id = ? AND company_id = ?');
            $limitStmt->execute([$examId, $companyId]);
            $limitRow = $limitStmt->fetch();
            $reconnectLimit = $limitRow && isset($limitRow['reconnect_limit']) ? (int)$limitRow['reconnect_limit'] : 0;

            if ($reconnectLimit <= 0) {
                $log = $pdo->prepare('CALL sp_log_access(?, ?, ?, ?, ?, ?)');
                $log->execute([$companyId, $examId, $studentId, 'RECONNECT', 'DENY', 'Reconnect limit exceeded.']);
                while ($log->nextRowset()) {}
                $log->closeCursor();

                json_response(['error' => 'RECONNECT_LIMIT', 'message' => 'No more reconnection is possible. Please contact administrator.'], 409);
            }

            $countStmt = $pdo->prepare("SELECT COUNT(*) AS cnt FROM exam_access_logs WHERE company_id = ? AND exam_id = ? AND student_id = ? AND action = 'RECONNECT' AND status = 'OK'");
            $countStmt->execute([$companyId, $examId, $studentId]);
            $countRow = $countStmt->fetch();
            $count = $countRow ? (int)$countRow['cnt'] : 0;

            if ($count >= $reconnectLimit) {
                $log = $pdo->prepare('CALL sp_log_access(?, ?, ?, ?, ?, ?)');
                $log->execute([$companyId, $examId, $studentId, 'RECONNECT', 'DENY', 'Reconnect limit exceeded.']);
                while ($log->nextRowset()) {}
                $log->closeCursor();

                json_response(['error' => 'RECONNECT_LIMIT', 'message' => 'No more reconnection is possible. Please contact administrator.'], 409);
            }

            $log = $pdo->prepare('CALL sp_log_access(?, ?, ?, ?, ?, ?)');
            $log->execute([$companyId, $examId, $studentId, 'RECONNECT', 'OK', 'Session reconnected']);
            while ($log->nextRowset()) {}
            $log->closeCursor();

            $remaining = max(0, $reconnectLimit - ($count + 1));
            $attemptCountStmt = $pdo->prepare('SELECT COUNT(*) AS cnt FROM exam_sessions WHERE company_id = ? AND exam_id = ? AND student_id = ?');
            $attemptCountStmt->execute([$companyId, $examId, $studentId]);
            $attemptRow = $attemptCountStmt->fetch();
            $attemptNumber = ($attemptRow ? (int)$attemptRow['cnt'] : 1);

            audit_log($pdo, [
                'companyId' => $companyId,
                'actorRole' => 'STUDENT',
                'actorId' => $studentId,
                'action' => 'SESSION_RECONNECT',
                'targetType' => 'exam',
                'targetId' => $examId,
                'message' => "Session reconnected. Remaining {$remaining}.",
                'metadata' => [
                    'remaining' => $remaining,
                    'ipChanged' => ($ipAddress && $existingIp && $ipAddress !== $existingIp),
                    'deviceChanged' => ($deviceFingerprint && $existingDevice && $deviceFingerprint !== $existingDevice)
                ]
            ]);
            json_response([
                'ok' => true,
                'reconnect' => true,
                'remaining' => $remaining,
                'sessionId' => $existingId ? (int)$existingId : null,
                'attempt' => $attemptNumber,
            ]);
        }

        $userAgent = $_SERVER['HTTP_USER_AGENT'] ?? '';
        $ipAddress = $_SERVER['REMOTE_ADDR'] ?? '';
        $location = $geo['label'] ?? ($payload['location'] ?? null);

        if (is_string($deviceFingerprint) && strlen($deviceFingerprint) > 128) {
            $deviceFingerprint = substr($deviceFingerprint, 0, 128);
        }

        try {
            $start = $pdo->prepare('INSERT INTO exam_sessions
                (company_id, exam_id, student_id, start_time, status, ip_address, user_agent, location, location_lat, location_lng, location_accuracy_m, device_fingerprint, device_metadata_json, mac_address, mac_bound)
                VALUES (?, ?, ?, NOW(3), \'IN_PROGRESS\', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
            $start->execute([
                $companyId,
                $examId,
                $studentId,
                $ipAddress,
                $userAgent,
                $location,
                $geo['lat'],
                $geo['lng'],
                $geo['accuracy'],
                $deviceFingerprint,
                $deviceMetadataJson,
                $macAddress,
                $macAddress ? 1 : 0
            ]);
        } catch (Throwable $e) {
            $errorMsg = $e->getMessage();
            if (strpos($errorMsg, 'MAC_ADDRESS_MISMATCH') !== false) {
                $log = $pdo->prepare('CALL sp_log_access(?, ?, ?, ?, ?, ?)');
                $log->execute([$companyId, $examId, $studentId, 'START', 'DENY', 'MAC address mismatch - student attempting to take exam from different device.']);
                while ($log->nextRowset()) {}
                $log->closeCursor();
                
                json_response([
                    'error' => 'MAC_ADDRESS_MISMATCH',
                    'message' => 'This exam is bound to a different device. Please contact your administrator to reset the device binding.'
                ], 409);
            }
            throw $e;
        }

        $attemptCountStmt = $pdo->prepare('SELECT COUNT(*) AS cnt FROM exam_sessions WHERE company_id = ? AND exam_id = ? AND student_id = ?');
        $attemptCountStmt->execute([$companyId, $examId, $studentId]);
        $attemptRow = $attemptCountStmt->fetch();
        $attemptNumber = ($attemptRow ? (int)$attemptRow['cnt'] : 1);

        $sessionStmt = $pdo->prepare('SELECT id FROM exam_sessions WHERE company_id = ? AND exam_id = ? AND student_id = ? ORDER BY start_time DESC LIMIT 1');
        $sessionStmt->execute([$companyId, $examId, $studentId]);
        $session = $sessionStmt->fetch();
        $sessionId = $session ? (int)$session['id'] : null;

        if ($sessionId && ($geo['lat'] !== null || $geo['lng'] !== null || $location !== null)) {
            $loc = $pdo->prepare('INSERT INTO exam_location_logs
                (company_id, session_id, exam_id, student_id, latitude, longitude, accuracy_m, location_label, distance_from_start_m, flagged)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0)');
            $loc->execute([$companyId, $sessionId, $examId, $studentId, $geo['lat'], $geo['lng'], $geo['accuracy'], $location]);
        }

        $log = $pdo->prepare('CALL sp_log_access(?, ?, ?, ?, ?, ?)');
        $log->execute([$companyId, $examId, $studentId, 'START', 'OK', "Session started (attempt {$attemptNumber})"]);
        while ($log->nextRowset()) {}
        $log->closeCursor();

        audit_log($pdo, [
            'companyId' => $companyId,
            'actorRole' => 'STUDENT',
            'actorId' => $studentId,
            'action' => 'SESSION_START',
            'targetType' => 'exam',
            'targetId' => $examId,
            'message' => "Session started (attempt {$attemptNumber}).",
            'metadata' => ['attempt' => $attemptNumber]
        ]);

        json_response(['ok' => true, 'sessionId' => $sessionId, 'attempt' => $attemptNumber]);
    }

    if ($action === 'location') {
        ensure_location_violation_support($pdo);
        $sessionId = isset($payload['sessionId']) ? (int)$payload['sessionId'] : 0;
        $geo = normalize_geo($payload['geoLocation'] ?? $payload);
        if ($sessionId <= 0 || $geo['lat'] === null || $geo['lng'] === null) {
            json_response(['error' => 'sessionId and geoLocation are required.'], 400);
        }

        $sessionStmt = $pdo->prepare("SELECT id, location_lat, location_lng, status
                                      FROM exam_sessions
                                      WHERE id = ? AND company_id = ? AND exam_id = ? AND student_id = ?
                                      LIMIT 1");
        $sessionStmt->execute([$sessionId, $companyId, $examId, $studentId]);
        $session = $sessionStmt->fetch();
        $sessionStmt->closeCursor();
        if (!$session) {
            json_response(['error' => 'SESSION_NOT_FOUND'], 404);
        }

        $startLat = isset($session['location_lat']) ? (float)$session['location_lat'] : null;
        $startLng = isset($session['location_lng']) ? (float)$session['location_lng'] : null;
        if ($startLat === null || $startLng === null) {
            $updateStart = $pdo->prepare('UPDATE exam_sessions
                                          SET location = COALESCE(?, location),
                                              location_lat = ?,
                                              location_lng = ?,
                                              location_accuracy_m = ?
                                          WHERE id = ? AND company_id = ?');
            $updateStart->execute([$geo['label'], $geo['lat'], $geo['lng'], $geo['accuracy'], $sessionId, $companyId]);
            $startLat = $geo['lat'];
            $startLng = $geo['lng'];
        }

        $distance = distance_m($startLat, $startLng, $geo['lat'], $geo['lng']);
        $accuracy = $geo['accuracy'] ?? 9999;
        $flagged = $distance !== null && $distance >= 350 && $accuracy <= 250;

        $loc = $pdo->prepare('INSERT INTO exam_location_logs
            (company_id, session_id, exam_id, student_id, latitude, longitude, accuracy_m, location_label, distance_from_start_m, flagged)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
        $loc->execute([$companyId, $sessionId, $examId, $studentId, $geo['lat'], $geo['lng'], $accuracy, $geo['label'], $distance, $flagged ? 1 : 0]);

        if ($flagged) {
            $recentStmt = $pdo->prepare("SELECT id FROM violation_logs
                                         WHERE company_id = ? AND session_id = ? AND type = 'LOCATION_CHANGE'
                                           AND occurred_at >= DATE_SUB(NOW(3), INTERVAL 5 MINUTE)
                                         LIMIT 1");
            $recentStmt->execute([$companyId, $sessionId]);
            $recent = $recentStmt->fetch();
            $recentStmt->closeCursor();
            if (!$recent) {
                $metadata = json_encode([
                    'distanceFromStartM' => $distance,
                    'accuracyM' => $accuracy,
                    'latitude' => $geo['lat'],
                    'longitude' => $geo['lng']
                ]);
                $insertViolation = $pdo->prepare("INSERT INTO violation_logs
                    (company_id, session_id, occurred_at, type, category, confidence, description, snapshot_base64, metadata_json)
                    VALUES (?, ?, NOW(3), 'LOCATION_CHANGE', 'location', ?, ?, NULL, ?)");
                $confidence = min(0.98, max(0.7, ($distance ?? 0) / 1000));
                $insertViolation->execute([
                    $companyId,
                    $sessionId,
                    $confidence,
                    "Location changed by approximately {$distance}m from exam start.",
                    $metadata
                ]);
            }
        }

        json_response(['ok' => true, 'flagged' => $flagged, 'distanceFromStartM' => $distance]);
    }

    if ($action === 'terminate') {
        $reason = trim((string)($payload['reason'] ?? 'Violation limit reached. Access has been blocked.'));
        if ($reason === '') {
            $reason = 'Violation limit reached. Access has been blocked.';
        }
        $summary = normalize_summary_for_log($payload['violationSummary'] ?? null);

        $sessionStmt = $pdo->prepare("SELECT id, status
                                      FROM exam_sessions
                                      WHERE company_id = ? AND exam_id = ? AND student_id = ?
                                      ORDER BY start_time DESC
                                      LIMIT 1");
        $sessionStmt->execute([$companyId, $examId, $studentId]);
        $session = $sessionStmt->fetch();
        $sessionStmt->closeCursor();

        if (!$session) {
            json_response(['error' => 'SESSION_NOT_FOUND'], 404);
        }

        $sessionId = (int)$session['id'];
        if (($session['status'] ?? '') === 'IN_PROGRESS') {
            $update = $pdo->prepare("UPDATE exam_sessions
                                     SET status = 'TERMINATED', end_time = NOW(3)
                                     WHERE id = ? AND company_id = ?");
            $update->execute([$sessionId, $companyId]);
        }

        $logPayload = json_encode([
            'reason' => $reason,
            'sessionId' => $sessionId,
            'summary' => $summary
        ]);
        if (!is_string($logPayload) || $logPayload === '') {
            $logPayload = $reason;
        }

        $log = $pdo->prepare('CALL sp_log_access(?, ?, ?, ?, ?, ?)');
        $log->execute([$companyId, $examId, $studentId, 'VIOLATION_BLOCK', 'DENY', $logPayload]);
        while ($log->nextRowset()) {}
        $log->closeCursor();

        audit_log($pdo, [
            'companyId' => $companyId,
            'actorRole' => 'SYSTEM',
            'actorId' => $studentId,
            'action' => 'SESSION_TERMINATE',
            'targetType' => 'exam',
            'targetId' => $examId,
            'message' => $reason,
            'metadata' => [
                'sessionId' => $sessionId,
                'summary' => $summary
            ]
        ]);

        json_response(['ok' => true, 'sessionId' => $sessionId]);
    }

    if ($action === 'complete') {
        $answers = $payload['answers'] ?? null;
        $questionIds = $payload['questionIds'] ?? null;
        $questionTimes = $payload['questionTimes'] ?? null;
        if (!is_array($questionIds) && isset($payload['questions']) && is_array($payload['questions'])) {
            $questionIds = array_map(function ($q) {
                return is_array($q) ? ($q['id'] ?? null) : null;
            }, $payload['questions']);
        }

        $done = $pdo->prepare('CALL sp_complete_exam_session(?, ?, ?)');
        $done->execute([$companyId, $examId, $studentId]);
        while ($done->nextRowset()) {}
        $done->closeCursor();

        $sessionStmt = $pdo->prepare('SELECT id FROM exam_sessions WHERE company_id = ? AND exam_id = ? AND student_id = ? ORDER BY start_time DESC LIMIT 1');
        $sessionStmt->execute([$companyId, $examId, $studentId]);
        $session = $sessionStmt->fetch();

        if (!$session) {
            json_response(['error' => 'SESSION_NOT_FOUND'], 404);
        }

        $sessionId = (int)$session['id'];

        if (is_array($answers) && is_array($questionIds)) {
            $questionIds = array_values(array_filter(array_unique($questionIds), function ($id) {
                return is_string($id) && $id !== '';
            }));

            if (count($questionIds) > 0) {
                $placeholders = implode(',', array_fill(0, count($questionIds), '?'));
                $qStmt = $pdo->prepare("SELECT q.id, q.type, q.correct_option_index, q.marks
                                        FROM exam_questions eq
                                        JOIN questions q ON q.id = eq.question_id
                                        WHERE eq.exam_id = ? AND q.id IN ($placeholders)");
                $qStmt->execute(array_merge([$examId], $questionIds));
                $questions = $qStmt->fetchAll();

                $insert = $pdo->prepare('INSERT INTO session_answers (session_id, question_id, answer_text, answer_option_index, is_correct, awarded_marks)
                                         VALUES (?, ?, ?, ?, ?, ?)
                                         ON DUPLICATE KEY UPDATE answer_text = VALUES(answer_text),
                                                                 answer_option_index = VALUES(answer_option_index),
                                                                 is_correct = VALUES(is_correct),
                                                                 awarded_marks = VALUES(awarded_marks)');
                $insertTime = $pdo->prepare('INSERT INTO session_question_times (session_id, question_id, seconds_spent)
                                             VALUES (?, ?, ?)
                                             ON DUPLICATE KEY UPDATE seconds_spent = VALUES(seconds_spent)');

                $totalScore = 0;
                $maxScore = 0;

                foreach ($questions as $q) {
                    $qid = $q['id'];
                    $qType = $q['type'];
                    $marks = (int)$q['marks'];
                    $maxScore += $marks;

                    $answerValue = $answers[$qid] ?? null;
                    $answerText = null;
                    $answerOptionIndex = null;
                    $isCorrect = null;
                    $awarded = null;

                    if ($qType === 'MCQ') {
                        if ($answerValue !== null && $answerValue !== '') {
                            $answerOptionIndex = (int)$answerValue;
                        }
                        if ($answerOptionIndex !== null && $q['correct_option_index'] !== null) {
                            $isCorrect = ((int)$answerOptionIndex === (int)$q['correct_option_index']) ? 1 : 0;
                            $awarded = $isCorrect ? $marks : 0;
                            $totalScore += $awarded;
                        }
                    } else {
                        if ($answerValue !== null) {
                            $answerText = is_string($answerValue) ? $answerValue : json_encode($answerValue);
                        }
                    }

                    $insert->execute([
                        $sessionId,
                        $qid,
                        $answerText,
                        $answerOptionIndex,
                        $isCorrect,
                        $awarded
                    ]);

                    if (is_array($questionTimes) && array_key_exists($qid, $questionTimes)) {
                        $seconds = $questionTimes[$qid];
                        if (is_numeric($seconds)) {
                            $insertTime->execute([$sessionId, $qid, (int)$seconds]);
                        }
                    }
                }

                $passed = null;
                if ($maxScore > 0) {
                    $passStmt = $pdo->prepare('SELECT pass_percent FROM exams WHERE id = ? AND company_id = ? LIMIT 1');
                    $passStmt->execute([$examId, $companyId]);
                    $passRow = $passStmt->fetch();
                    $passPercent = $passRow && isset($passRow['pass_percent']) ? (int)$passRow['pass_percent'] : 60;
                    if ($passPercent < 0) $passPercent = 0;
                    if ($passPercent > 100) $passPercent = 100;
                    $passed = ($totalScore / $maxScore) >= ($passPercent / 100) ? 1 : 0;
                }

                $update = $pdo->prepare('UPDATE exam_sessions SET total_score = ?, max_score = ?, passed = ?, end_time = NOW(3), status = \'COMPLETED\' WHERE id = ? AND company_id = ?');
                $update->execute([$totalScore, $maxScore, $passed, $sessionId, $companyId]);
            }
        }

        $log = $pdo->prepare('CALL sp_log_access(?, ?, ?, ?, ?, ?)');
        $log->execute([$companyId, $examId, $studentId, 'COMPLETE', 'OK', 'Session completed']);
        while ($log->nextRowset()) {}
        $log->closeCursor();

        audit_log($pdo, [
            'companyId' => $companyId,
            'actorRole' => 'STUDENT',
            'actorId' => $studentId,
            'action' => 'SESSION_COMPLETE',
            'targetType' => 'exam',
            'targetId' => $examId,
            'message' => 'Session completed',
            'metadata' => ['score' => $totalScore ?? null, 'maxScore' => $maxScore ?? null]
        ]);

        json_response(['ok' => true]);
    }

    if ($action === 'reset') {
        $reset = $pdo->prepare('CALL sp_reset_exam_session(?, ?, ?)');
        $reset->execute([$companyId, $examId, $studentId]);
        while ($reset->nextRowset()) {}
        $reset->closeCursor();

        $log = $pdo->prepare('CALL sp_log_access(?, ?, ?, ?, ?, ?)');
        $log->execute([$companyId, $examId, $studentId, 'RESET', 'OK', 'Session reset by admin']);
        while ($log->nextRowset()) {}
        $log->closeCursor();

        audit_log($pdo, [
            'companyId' => $companyId,
            'actorRole' => 'ADMIN',
            'actorId' => $payload['actor'] ?? null,
            'action' => 'SESSION_RESET',
            'targetType' => 'exam',
            'targetId' => $examId,
            'message' => "Session reset for student {$studentId}"
        ]);

        json_response(['ok' => true]);
    }

    json_response(['error' => 'Invalid action.'], 400);
}

json_response(['error' => 'Method not allowed.'], 405);
