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

function recording_table_exists(PDO $pdo, string $tableName): bool {
    $stmt = $pdo->prepare("SELECT 1
                           FROM information_schema.TABLES
                           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
                           LIMIT 1");
    $stmt->execute([$tableName]);
    $exists = (bool)$stmt->fetchColumn();
    $stmt->closeCursor();
    return $exists;
}

function ensure_recording_schema(PDO $pdo): bool {
    $sessionsExists = recording_table_exists($pdo, 'recording_sessions');
    $streamsExists = recording_table_exists($pdo, 'recording_streams');
    if ($sessionsExists && $streamsExists) {
        return true;
    }

    try {
        if (!$sessionsExists) {
            $pdo->exec("CREATE TABLE IF NOT EXISTS recording_sessions (
      id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      company_id   INT NOT NULL DEFAULT 1,
      exam_id      VARCHAR(64) NOT NULL,
      student_id   VARCHAR(64) NOT NULL,
      session_id   BIGINT UNSIGNED NULL,
      status       ENUM('INIT','RECORDING','COMPLETED','FAILED') NOT NULL DEFAULT 'INIT',
      started_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      ended_at     TIMESTAMP NULL DEFAULT NULL,
      duration_sec INT NULL,
      created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_recording_session_lookup (company_id, exam_id, student_id, started_at),
      INDEX idx_recording_session_status (status)
    ) ENGINE=InnoDB");
        }

        if (!$streamsExists) {
            $pdo->exec("CREATE TABLE IF NOT EXISTS recording_streams (
      id                   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      recording_session_id BIGINT UNSIGNED NOT NULL,
      stream_type          ENUM('camera','screen','combined') NOT NULL,
      mime_type            VARCHAR(128) NULL,
      file_path            VARCHAR(1024) NOT NULL,
      size_bytes           BIGINT UNSIGNED NOT NULL DEFAULT 0,
      chunk_count          INT NOT NULL DEFAULT 0,
      created_at           TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at           TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uk_recording_stream_unique (recording_session_id, stream_type),
      INDEX idx_recording_stream_type (stream_type),
      CONSTRAINT fk_recording_stream_session
        FOREIGN KEY (recording_session_id) REFERENCES recording_sessions(id)
        ON DELETE CASCADE
    ) ENGINE=InnoDB");
        }
    } catch (Throwable $e) {
        // Fall through to existence re-check. This avoids hard-failing when
        // DB user has no CREATE permission but tables are already provisioned.
    }

    $sessionsExists = recording_table_exists($pdo, 'recording_sessions');
    $streamsExists = recording_table_exists($pdo, 'recording_streams');
    return $sessionsExists && $streamsExists;
}

function storage_root(): string {
    return realpath(__DIR__ . '/..') . DIRECTORY_SEPARATOR . 'storage' . DIRECTORY_SEPARATOR . 'recordings';
}

/** Tracks the on-demand "recheck this recording against the live AI detector" jobs kicked off
 *  from the admin Recordings panel. One row per recording; a fresh recheck overwrites it in place
 *  (see the ON DUPLICATE KEY UPDATE on RECHECK below) rather than accumulating history. */
function ensure_recheck_schema(PDO $pdo): void {
    $pdo->exec("CREATE TABLE IF NOT EXISTS recording_rechecks (
        recording_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
        company_id   INT NOT NULL,
        session_id   BIGINT UNSIGNED NULL,
        status       ENUM('PENDING','RUNNING','DONE','FAILED') NOT NULL DEFAULT 'PENDING',
        found_count  INT NULL,
        error        TEXT NULL,
        started_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        finished_at  TIMESTAMP NULL DEFAULT NULL,
        INDEX idx_recording_rechecks_company (company_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
}

function ensure_dir(string $dir): void {
    if (is_dir($dir)) return;
    if (!@mkdir($dir, 0775, true) && !is_dir($dir)) {
        throw new RuntimeException('Failed to create storage directory.');
    }
}

/**
 * Sanitise a value used as a single path segment. exam_id is client-supplied at exam creation, so a
 * crafted id (e.g. "../../etc") must never escape the storage tree. Keep only safe characters.
 */
function safe_path_segment($value): string {
    $clean = preg_replace('/[^A-Za-z0-9_-]/', '', (string)$value);
    return $clean === '' ? 'unknown' : $clean;
}

function file_ext_from_mime(?string $mime): string {
    $m = strtolower(trim((string)$mime));
    if (strpos($m, 'mp4') !== false) return 'mp4';
    if (strpos($m, 'webm') !== false) return 'webm';
    return 'webm';
}

function stream_file_with_range(string $path, string $mime): void {
    if (!is_file($path)) {
        http_response_code(404);
        echo 'Not found';
        exit;
    }

    $size = filesize($path);
    $start = 0;
    $end = $size > 0 ? $size - 1 : 0;
    $status = 200;

    $range = $_SERVER['HTTP_RANGE'] ?? '';
    if (is_string($range) && preg_match('/bytes=(\d*)-(\d*)/', $range, $m) && ($m[1] !== '' || $m[2] !== '')) {
        if ($m[1] === '') {
            // Suffix range "bytes=-N" = the LAST N bytes (RFC 9110), not bytes 0..N. Media players
            // use it to read trailing metadata; serving the head instead hands them garbage.
            $rangeStart = max(0, $size - (int)$m[2]);
            $rangeEnd = $end;
        } else {
            $rangeStart = (int)$m[1];
            $rangeEnd = $m[2] !== '' ? (int)$m[2] : $end;
        }
        if ($rangeStart <= $rangeEnd && $rangeStart < $size) {
            $start = max(0, $rangeStart);
            $end = min($end, $rangeEnd);
            $status = 206;
        }
    }

    $length = $size > 0 ? ($end - $start + 1) : 0;
    http_response_code($status);
    header('Content-Type: ' . $mime);
    header('Accept-Ranges: bytes');
    header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');
    header('Pragma: no-cache');
    header('Expires: 0');
    if ($status === 206) {
        header("Content-Range: bytes {$start}-{$end}/{$size}");
    }
    header('Content-Length: ' . $length);

    $fp = fopen($path, 'rb');
    if ($fp === false) {
        http_response_code(500);
        echo 'Failed to open file';
        exit;
    }
    if ($start > 0) {
        fseek($fp, $start);
    }

    $remaining = $length;
    $chunk = 1024 * 1024;
    while ($remaining > 0 && !feof($fp)) {
        $readLen = min($chunk, $remaining);
        $buf = fread($fp, $readLen);
        if ($buf === false) break;
        echo $buf;
        $remaining -= strlen($buf);
        if (function_exists('fastcgi_finish_request')) {
            // noop, let normal output flush control handle it
        }
        flush();
    }
    fclose($fp);
    exit;
}

$method = $_SERVER['REQUEST_METHOD'];
$recordingSchemaReady = ensure_recording_schema($pdo);
if ($recordingSchemaReady) {
    ensure_recheck_schema($pdo);
}

if ($method === 'GET') {
    $companyId = require_company_id();
    $scriptDir = rtrim(str_replace('\\', '/', dirname((string)($_SERVER['SCRIPT_NAME'] ?? '/api'))), '/');
    if ($scriptDir === '') $scriptDir = '/api';
    $mode = isset($_GET['mode']) ? strtolower(trim((string)$_GET['mode'])) : 'list';

    // mode=file streams actual media to <video> elements — browsers cannot send custom auth headers
    // on media requests, so require_staff() would always 401. Instead it's protected by an HMAC
    // signature (see media_url_signature()) minted only by this staff-authenticated list endpoint;
    // a bare companyId + recordingId is no longer sufficient (that was a guessable-ID IDOR).
    if ($mode !== 'file') {
        require_staff();
    }

    if ($mode === 'summary') {
        if (!$recordingSchemaReady) {
            json_response([
                'summary' => [
                    'cameraCount' => 0,
                    'screenCount' => 0,
                    'combinedCount' => 0,
                    'totalCount' => 0,
                ]
            ]);
        }
        $stmt = $pdo->prepare("SELECT rs.stream_type, COUNT(*) AS cnt
                               FROM recording_streams rs
                               JOIN recording_sessions r ON r.id = rs.recording_session_id
                               WHERE r.company_id = ? AND rs.size_bytes > 0
                               GROUP BY rs.stream_type");
        $stmt->execute([$companyId]);
        $rows = $stmt->fetchAll();
        $stmt->closeCursor();

        $summary = [
            'cameraCount' => 0,
            'screenCount' => 0,
            'combinedCount' => 0,
            'totalCount' => 0,
        ];
        foreach ($rows as $row) {
            $type = (string)$row['stream_type'];
            $cnt = (int)$row['cnt'];
            if ($type === 'camera') $summary['cameraCount'] = $cnt;
            if ($type === 'screen') $summary['screenCount'] = $cnt;
            if ($type === 'combined') $summary['combinedCount'] = $cnt;
            $summary['totalCount'] += $cnt;
        }
        json_response(['summary' => $summary]);
    }

    if ($mode === 'file') {
        if (!$recordingSchemaReady) {
            http_response_code(404);
            echo 'Not found';
            exit;
        }
        $recordingId = isset($_GET['recordingId']) ? (int)$_GET['recordingId'] : 0;
        $streamType = isset($_GET['streamType']) ? strtolower(trim((string)$_GET['streamType'])) : '';
        if ($recordingId <= 0 || !in_array($streamType, ['camera', 'screen', 'combined'], true)) {
            json_response(['error' => 'recordingId and valid streamType are required.'], 400);
        }
        $sig = trim((string)($_GET['sig'] ?? ''));
        if (!media_url_signature_valid('recording', $companyId, $recordingId, $streamType, $sig)) {
            http_response_code(403);
            echo 'Forbidden';
            exit;
        }

        $stmt = $pdo->prepare("SELECT rs.file_path, rs.mime_type
                               FROM recording_streams rs
                               JOIN recording_sessions r ON r.id = rs.recording_session_id
                               WHERE r.company_id = ? AND r.id = ? AND rs.stream_type = ?
                               LIMIT 1");
        $stmt->execute([$companyId, $recordingId, $streamType]);
        $row = $stmt->fetch();
        $stmt->closeCursor();
        if (!$row) {
            http_response_code(404);
            echo 'Not found';
            exit;
        }

        $path = (string)$row['file_path'];
        $mime = (string)($row['mime_type'] ?? 'video/webm');
        if (!empty($_GET['dl'])) {
            $ext = file_ext_from_mime($mime);
            $filename = "recording_{$recordingId}_{$streamType}.{$ext}";
            header('Content-Disposition: attachment; filename="' . $filename . '"');
        }
        stream_file_with_range($path, $mime);
    }

    $limit = isset($_GET['limit']) ? (int)$_GET['limit'] : 120;
    if ($limit <= 0) $limit = 120;
    if ($limit > 500) $limit = 500;
    $examId = isset($_GET['examId']) ? trim((string)$_GET['examId']) : '';
    $studentId = isset($_GET['studentId']) ? trim((string)$_GET['studentId']) : '';

    if (!$recordingSchemaReady) {
        json_response(['recordings' => []]);
    }

    // Reconcile stranded recordings before listing. A recording still marked INIT/RECORDING for a
    // candidate who has NO IN_PROGRESS exam session is orphaned — the exam ended (submit/terminate)
    // or the client died before its COMPLETE call. Close them so the admin never sees a perpetual
    // "recording" row. The 2-minute grace avoids racing a recording that just started before its
    // exam_session row has flipped to IN_PROGRESS.
    try {
        if (db_table_exists($pdo, 'exam_sessions')) {
            $sweep = $pdo->prepare(
                "UPDATE recording_sessions r
                    SET r.status = 'COMPLETED',
                        r.ended_at = NOW(3),
                        r.duration_sec = CASE
                            WHEN r.duration_sec IS NULL OR r.duration_sec = 0
                            THEN GREATEST(0, TIMESTAMPDIFF(SECOND, r.started_at, NOW(3)))
                            ELSE r.duration_sec
                        END
                  WHERE r.company_id = ?
                    AND r.status IN ('INIT', 'RECORDING')
                    AND r.started_at < (NOW(3) - INTERVAL 2 MINUTE)
                    AND NOT EXISTS (
                        SELECT 1 FROM exam_sessions s
                         WHERE s.company_id = r.company_id
                           AND s.exam_id = r.exam_id
                           AND s.student_id = r.student_id
                           AND s.status = 'IN_PROGRESS'
                    )"
            );
            $sweep->execute([$companyId]);
            $sweep->closeCursor();
        }
    } catch (Throwable $e) {
        // Best-effort reconciliation — never block the listing on it.
    }

    $sql = "SELECT id, exam_id, student_id, session_id, status, started_at, ended_at, duration_sec
            FROM recording_sessions
            WHERE company_id = ?";
    $params = [$companyId];
    if ($examId !== '') {
        $sql .= " AND exam_id = ?";
        $params[] = $examId;
    }
    if ($studentId !== '') {
        $sql .= " AND student_id = ?";
        $params[] = $studentId;
    }
    $sql .= " ORDER BY started_at DESC LIMIT {$limit}";

    $stmt = $pdo->prepare($sql);
    $stmt->execute($params);
    $sessions = $stmt->fetchAll();
    $stmt->closeCursor();

    $rechecks = [];
    $recheckStmt = $pdo->prepare('SELECT recording_id, status, found_count, error, started_at, finished_at FROM recording_rechecks WHERE company_id = ?');
    $recheckStmt->execute([$companyId]);
    foreach ($recheckStmt->fetchAll() as $row) {
        $rechecks[(int)$row['recording_id']] = $row;
    }
    $recheckStmt->closeCursor();

    $records = [];
    foreach ($sessions as $s) {
        $rid = (int)$s['id'];
        $streamStmt = $pdo->prepare("SELECT stream_type, mime_type, size_bytes, created_at
                                     FROM recording_streams
                                     WHERE recording_session_id = ?");
        $streamStmt->execute([$rid]);
        $streamsRaw = $streamStmt->fetchAll();
        $streamStmt->closeCursor();

        $streams = array_map(function ($row) use ($rid, $companyId, $scriptDir) {
            $type = (string)$row['stream_type'];
            $size = (int)$row['size_bytes'];
            $sig = media_url_signature('recording', $companyId, $rid, $type);
            return [
                'streamType' => $type,
                'mimeType' => $row['mime_type'] ?? null,
                'sizeBytes' => $size,
                'hasFile' => $size > 0,
                'fileUrl' => $size > 0
                    ? ("{$scriptDir}/recordings.php?mode=file&recordingId={$rid}&streamType={$type}&companyId={$companyId}&sig=" . urlencode($sig))
                    : null,
                'createdAt' => datetime_to_ms($row['created_at'] ?? null),
            ];
        }, $streamsRaw);

        $recheck = $rechecks[$rid] ?? null;

        $records[] = [
            'id' => $rid,
            'examId' => $s['exam_id'],
            'studentId' => $s['student_id'],
            'sessionId' => $s['session_id'] !== null ? (int)$s['session_id'] : null,
            'status' => $s['status'],
            'startedAt' => datetime_to_ms($s['started_at']) ?? 0,
            'endedAt' => datetime_to_ms($s['ended_at'] ?? null),
            'durationSec' => $s['duration_sec'] !== null ? (int)$s['duration_sec'] : null,
            'streams' => $streams,
            'recheckStatus' => $recheck ? $recheck['status'] : null,
            'recheckFoundCount' => $recheck && $recheck['found_count'] !== null ? (int)$recheck['found_count'] : null,
            'recheckError' => $recheck ? $recheck['error'] : null,
            'recheckFinishedAt' => $recheck ? datetime_to_ms($recheck['finished_at'] ?? null) : null,
        ];
    }

    json_response(['recordings' => $records]);
}

if ($method === 'POST') {
    $payload = null;
    $companyId = null;
    $action = '';

    $contentType = $_SERVER['CONTENT_TYPE'] ?? '';
    if (is_string($contentType) && stripos($contentType, 'multipart/form-data') !== false) {
        $companyId = require_company_id();
        $action = strtoupper(trim((string)($_POST['action'] ?? '')));
    } else {
        $payload = json_input();
        $companyId = require_company_id($payload);
        $action = strtoupper(trim((string)($payload['action'] ?? '')));
    }

    if ($action === 'INIT') {
        if (!$recordingSchemaReady) {
            json_response(['error' => 'RECORDING_SCHEMA_UNAVAILABLE', 'message' => 'Recording tables are unavailable. Please run schema migration.'], 503);
        }
        $examId = trim((string)(($payload['examId'] ?? $_POST['examId'] ?? '')));
        $studentId = trim((string)(($payload['studentId'] ?? $_POST['studentId'] ?? '')));
        $sessionIdRaw = $payload['sessionId'] ?? $_POST['sessionId'] ?? null;
        $sessionId = is_numeric($sessionIdRaw) ? (int)$sessionIdRaw : null;
        if ($examId === '' || $studentId === '') {
            json_response(['error' => 'examId and studentId are required.'], 400);
        }

        $stmt = $pdo->prepare("INSERT INTO recording_sessions (company_id, exam_id, student_id, session_id, status, started_at)
                               VALUES (?, ?, ?, ?, 'RECORDING', NOW(3))");
        $stmt->execute([$companyId, $examId, $studentId, $sessionId]);
        $recordingId = (int)$pdo->lastInsertId();

        audit_log($pdo, [
            'companyId' => $companyId,
            'actorRole' => 'SYSTEM',
            'actorId' => $studentId,
            'action' => 'RECORDING_INIT',
            'targetType' => 'exam',
            'targetId' => $examId,
            'message' => "Recording started (#{$recordingId})",
            'metadata' => ['recordingId' => $recordingId, 'sessionId' => $sessionId]
        ]);

        json_response(['ok' => true, 'recordingId' => $recordingId]);
    }

    if ($action === 'CHUNK') {
        if (!$recordingSchemaReady) {
            json_response(['error' => 'RECORDING_SCHEMA_UNAVAILABLE', 'message' => 'Recording tables are unavailable. Please run schema migration.'], 503);
        }
        $recordingId = isset($_POST['recordingId']) ? (int)$_POST['recordingId'] : (int)($payload['recordingId'] ?? 0);
        $streamType = strtolower(trim((string)($_POST['streamType'] ?? ($payload['streamType'] ?? ''))));
        $mimeType = trim((string)($_POST['mimeType'] ?? ($payload['mimeType'] ?? 'video/webm')));
        if ($recordingId <= 0 || !in_array($streamType, ['camera', 'screen', 'combined'], true)) {
            json_response(['error' => 'recordingId and valid streamType are required.'], 400);
        }
        if (!isset($_FILES['chunk']) || !is_uploaded_file($_FILES['chunk']['tmp_name'])) {
            json_response(['error' => 'chunk file is required.'], 400);
        }

        $rsStmt = $pdo->prepare("SELECT id, exam_id, student_id
                                 FROM recording_sessions
                                 WHERE id = ? AND company_id = ?
                                 LIMIT 1");
        $rsStmt->execute([$recordingId, $companyId]);
        $session = $rsStmt->fetch();
        $rsStmt->closeCursor();
        if (!$session) {
            json_response(['error' => 'RECORDING_NOT_FOUND'], 404);
        }

        $ext = file_ext_from_mime($mimeType);
        $root = storage_root();
        $dir = $root . DIRECTORY_SEPARATOR
            . (int)$companyId . DIRECTORY_SEPARATOR
            . safe_path_segment($session['exam_id']) . DIRECTORY_SEPARATOR
            . safe_path_segment($session['student_id']) . DIRECTORY_SEPARATOR
            . (int)$recordingId;
        ensure_dir($dir);
        $path = $dir . DIRECTORY_SEPARATOR . $streamType . '.' . $ext;

        $tmp = $_FILES['chunk']['tmp_name'];
        $data = file_get_contents($tmp);
        if ($data === false) {
            json_response(['error' => 'Failed to read uploaded chunk.'], 500);
        }
        $written = file_put_contents($path, $data, FILE_APPEND | LOCK_EX);
        if ($written === false) {
            json_response(['error' => 'Failed to store chunk.'], 500);
        }

        $upsert = $pdo->prepare("INSERT INTO recording_streams
            (recording_session_id, stream_type, mime_type, file_path, size_bytes, chunk_count)
            VALUES (?, ?, ?, ?, ?, 1)
            ON DUPLICATE KEY UPDATE
                mime_type = VALUES(mime_type),
                file_path = VALUES(file_path),
                size_bytes = size_bytes + VALUES(size_bytes),
                chunk_count = chunk_count + 1");
        $upsert->execute([$recordingId, $streamType, $mimeType, $path, (int)$written]);

        // Only promote INIT -> RECORDING. A chunk still draining from the client's upload queue after
        // the recording was finalized (client COMPLETE, or the server-side close-out when the exam
        // session ended) used to flip a COMPLETED/FAILED recording back to RECORDING, leaving it
        // looking live/stuck again. The bytes are still appended above; only the status is protected.
        $statusStmt = $pdo->prepare("UPDATE recording_sessions SET status = 'RECORDING' WHERE id = ? AND company_id = ? AND status = 'INIT'");
        $statusStmt->execute([$recordingId, $companyId]);

        json_response(['ok' => true, 'written' => (int)$written]);
    }

    if ($action === 'COMPLETE') {
        if (!$recordingSchemaReady) {
            json_response(['error' => 'RECORDING_SCHEMA_UNAVAILABLE', 'message' => 'Recording tables are unavailable. Please run schema migration.'], 503);
        }
        $recordingId = (int)($payload['recordingId'] ?? $_POST['recordingId'] ?? 0);
        $durationSecRaw = $payload['durationSec'] ?? $_POST['durationSec'] ?? null;
        $durationSec = is_numeric($durationSecRaw) ? max(0, (int)$durationSecRaw) : null;
        $status = strtoupper(trim((string)($payload['status'] ?? $_POST['status'] ?? 'COMPLETED')));
        if (!in_array($status, ['COMPLETED', 'FAILED'], true)) {
            $status = 'COMPLETED';
        }
        if ($recordingId <= 0) {
            json_response(['error' => 'recordingId is required.'], 400);
        }

        $stmt = $pdo->prepare("UPDATE recording_sessions
                               SET status = ?, ended_at = NOW(3), duration_sec = ?
                               WHERE id = ? AND company_id = ?");
        $stmt->execute([$status, $durationSec, $recordingId, $companyId]);

        json_response(['ok' => true]);
    }

    // Admin-triggered, on-demand re-analysis of a recording's camera stream against the live AI
    // detection engine — the same manual recheck workflow used to catch what live detection
    // missed for Nandhakumar S's sessions, now reachable as a button instead of an ad hoc script.
    // The actual work runs in scripts/recheck_recording.php as a detached background process
    // (it can take several minutes on a long recording), so this only starts the job and returns.
    if ($action === 'RECHECK') {
        if (!$recordingSchemaReady) {
            json_response(['error' => 'RECORDING_SCHEMA_UNAVAILABLE', 'message' => 'Recording tables are unavailable. Please run schema migration.'], 503);
        }
        $actorRole = require_role(['ADMIN', 'SUPER_ADMIN'], $payload);
        $recordingId = (int)($payload['recordingId'] ?? 0);
        if ($recordingId <= 0) {
            json_response(['error' => 'recordingId is required.'], 400);
        }

        $recStmt = $pdo->prepare("SELECT r.id, r.session_id
                                  FROM recording_sessions r
                                  JOIN recording_streams s ON s.recording_session_id = r.id AND s.stream_type = 'camera' AND s.size_bytes > 0
                                  WHERE r.id = ? AND r.company_id = ? LIMIT 1");
        $recStmt->execute([$recordingId, $companyId]);
        $rec = $recStmt->fetch();
        $recStmt->closeCursor();
        if (!$rec) {
            json_response(['error' => 'No camera recording found for this session.'], 404);
        }
        if ($rec['session_id'] === null) {
            json_response(['error' => 'This recording has no linked exam session.'], 409);
        }

        $existing = $pdo->prepare('SELECT status FROM recording_rechecks WHERE recording_id = ?');
        $existing->execute([$recordingId]);
        $existingStatus = $existing->fetchColumn();
        $existing->closeCursor();
        if ($existingStatus === 'PENDING' || $existingStatus === 'RUNNING') {
            json_response(['error' => 'A recheck is already in progress for this recording.'], 409);
        }

        $upsert = $pdo->prepare('INSERT INTO recording_rechecks (recording_id, company_id, session_id, status, found_count, error, started_at, finished_at)
                                 VALUES (?, ?, ?, "PENDING", NULL, NULL, NOW(3), NULL)
                                 ON DUPLICATE KEY UPDATE
                                     status = "PENDING", found_count = NULL, error = NULL,
                                     started_at = NOW(3), finished_at = NULL');
        $upsert->execute([$recordingId, $companyId, (int)$rec['session_id']]);

        // storage/logs is owned by the deploy user (gokul), not group-writable by www-data — unlike
        // its sibling storage/recordings and storage/live. Log into a www-data-writable directory
        // instead of touching that directory's permissions.
        $recheckLogDir = storage_root() . '/_recheck_logs';
        ensure_dir($recheckLogDir);
        // NOT PHP_BINARY: under php-fpm that resolves to the fpm binary itself, not a CLI runner.
        $phpBin = '/usr/bin/php';
        $script = escapeshellarg(__DIR__ . '/../scripts/recheck_recording.php');
        $logPath = escapeshellarg($recheckLogDir . '/recheck_' . $recordingId . '.log');
        $cmd = escapeshellarg($phpBin) . ' ' . $script . ' ' . escapeshellarg((string)$recordingId)
            . ' >> ' . $logPath . ' 2>&1 &';
        exec($cmd);

        audit_log($pdo, [
            'companyId' => $companyId, 'actorRole' => $actorRole, 'actorId' => get_actor_id($payload),
            'action' => 'RECORDING_RECHECK_START', 'targetType' => 'recording', 'targetId' => (string)$recordingId,
            'message' => "Started on-demand recheck for recording {$recordingId}",
        ]);

        json_response(['ok' => true, 'status' => 'PENDING']);
    }

    json_response(['error' => 'Invalid action.'], 400);
}

json_response(['error' => 'Method not allowed.'], 405);
