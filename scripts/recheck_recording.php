<?php
declare(strict_types=1);

/**
 * Re-analyzes one recording's stored camera video against the live proctoring detection engine
 * and inserts any violations it finds into violation_logs (deduped against anything already
 * logged for that session/type within +/-5s, whether from live detection or an earlier recheck).
 * Invoked in the background by api/recordings.php's RECHECK action — never called directly by a
 * request, so it has no time-of-request budget and can take minutes on a long recording.
 *
 * Usage: php recheck_recording.php <recordingId>
 */

if (!isset($_SERVER['REQUEST_METHOD'])) {
    $_SERVER['REQUEST_METHOD'] = 'CLI';
}

require __DIR__ . '/../api/_bootstrap.php';

function recheck_ms_to_datetime(int $ms): string {
    $seconds = intdiv($ms, 1000);
    $millis = $ms - ($seconds * 1000);
    return gmdate('Y-m-d H:i:s', $seconds) . '.' . str_pad((string)$millis, 3, '0', STR_PAD_LEFT);
}

function recheck_datetime_to_ms(string $dt): int {
    $parts = explode('.', $dt, 2);
    $ts = strtotime($parts[0] . ' UTC');
    $ms = $ts !== false ? $ts * 1000 : 0;
    if (isset($parts[1])) {
        $ms += (int)str_pad(substr($parts[1], 0, 3), 3, '0');
    }
    return $ms;
}

function recheck_mark(PDO $pdo, int $recordingId, string $status, ?int $foundCount = null, ?string $error = null): void {
    $stmt = $pdo->prepare("UPDATE recording_rechecks
                           SET status = ?,
                               found_count = COALESCE(?, found_count),
                               error = ?,
                               finished_at = IF(? IN ('DONE', 'FAILED'), NOW(3), finished_at)
                           WHERE recording_id = ?");
    $stmt->execute([$status, $foundCount, $error, $status, $recordingId]);
}

const RECHECK_DESCRIPTIONS = [
    'NO_FACE' => 'No face detected in the camera frame.',
    'MULTIPLE_FACES' => 'Multiple people detected in the camera frame.',
    'GAZE_AWAY' => 'Candidate appears to be looking away from the screen.',
    'PHONE_DETECTED' => 'A mobile phone was detected in the camera frame.',
    'ANOMALY_OBJECT' => 'Unauthorized item detected in the camera frame.',
    'IDENTITY_CHANGE' => 'The person on camera may not match the enrolled student.',
    'SUSPICIOUS_BEHAVIOR' => 'Suspicious behaviour pattern detected.',
];

$recordingId = isset($argv[1]) ? (int)$argv[1] : 0;
if ($recordingId <= 0) {
    fwrite(STDERR, "usage: recheck_recording.php <recordingId>\n");
    exit(1);
}

try {
    $rsStmt = $pdo->prepare('SELECT id, company_id, exam_id, student_id, session_id, started_at FROM recording_sessions WHERE id = ? LIMIT 1');
    $rsStmt->execute([$recordingId]);
    $rec = $rsStmt->fetch();
    $rsStmt->closeCursor();
    if (!$rec) {
        recheck_mark($pdo, $recordingId, 'FAILED', null, 'Recording not found.');
        exit(1);
    }

    $companyId = (int)$rec['company_id'];
    $sessionId = $rec['session_id'] !== null ? (int)$rec['session_id'] : null;
    if ($sessionId === null) {
        recheck_mark($pdo, $recordingId, 'FAILED', null, 'Recording has no linked exam session.');
        exit(1);
    }

    $camStmt = $pdo->prepare("SELECT file_path FROM recording_streams WHERE recording_session_id = ? AND stream_type = 'camera' LIMIT 1");
    $camStmt->execute([$recordingId]);
    $videoPath = (string)($camStmt->fetchColumn() ?: '');
    $camStmt->closeCursor();
    if ($videoPath === '' || !is_file($videoPath)) {
        recheck_mark($pdo, $recordingId, 'FAILED', null, 'No camera recording file on disk.');
        exit(1);
    }

    $sessStmt = $pdo->prepare('SELECT start_time FROM exam_sessions WHERE id = ? AND company_id = ? LIMIT 1');
    $sessStmt->execute([$sessionId, $companyId]);
    $startTimeRaw = $sessStmt->fetchColumn();
    $sessStmt->closeCursor();
    if ($startTimeRaw === false || $startTimeRaw === null) {
        recheck_mark($pdo, $recordingId, 'FAILED', null, 'Exam session not found.');
        exit(1);
    }
    // ai_recheck.py reports offsets from the START OF THIS VIDEO, and the video starts when this
    // recording was INIT'd (recordings.php stamps started_at right before ExamTake creates the
    // MediaRecorder) — not when the exam session started. Every page reload mid-exam opens a NEW
    // recording, so anchoring on exam_sessions.start_time shifted every rechecked violation earlier by
    // however far into the exam the recording began, broke the +/-5s dedupe against live detections,
    // and put the markers in the wrong place on the player (Recordings.tsx maps a violation to
    // timestamp - recording.startedAt). Fall back to the session start only if started_at is missing.
    $recStartRaw = $rec['started_at'] ?? null;
    $startMs = ($recStartRaw !== null && (string)$recStartRaw !== '')
        ? recheck_datetime_to_ms((string)$recStartRaw)
        : recheck_datetime_to_ms((string)$startTimeRaw);

    $studStmt = $pdo->prepare('SELECT face_descriptor FROM students WHERE id = ? AND company_id = ? LIMIT 1');
    $studStmt->execute([$rec['student_id'], $companyId]);
    $descriptorJson = (string)($studStmt->fetchColumn() ?: '');
    $studStmt->closeCursor();

    recheck_mark($pdo, $recordingId, 'RUNNING');

    $venvPython = '/srv/apps/proctor/python_ai/venv/bin/python';
    $script = __DIR__ . '/ai_recheck.py';
    // storage/logs isn't group-writable by www-data (the user this runs as when spawned from the
    // admin panel) — use the same www-data-writable directory api/recordings.php logs the outer
    // job to.
    $recheckLogDir = '/srv/apps/proctor/storage/recordings/_recheck_logs';
    if (!is_dir($recheckLogDir)) {
        @mkdir($recheckLogDir, 0775, true);
    }
    $errLog = $recheckLogDir . '/recheck_' . $recordingId . '.err';
    $cmd = escapeshellarg($venvPython) . ' ' . escapeshellarg($script) . ' '
        . escapeshellarg($videoPath) . ' ' . escapeshellarg($descriptorJson) . ' 1000'
        . ' 2>' . escapeshellarg($errLog);
    $output = shell_exec($cmd);

    if ($output === null || trim($output) === '') {
        recheck_mark($pdo, $recordingId, 'FAILED', null, 'Recheck script produced no output — see ' . basename($errLog));
        exit(1);
    }
    $result = json_decode(trim($output), true);
    if (!is_array($result) || isset($result['error'])) {
        $err = is_array($result) ? (string)($result['error'] ?? 'Invalid script output.') : 'Invalid script output.';
        recheck_mark($pdo, $recordingId, 'FAILED', null, $err);
        exit(1);
    }

    $violations = is_array($result['violations'] ?? null) ? $result['violations'] : [];
    $inserted = 0;

    foreach ($violations as $v) {
        $type = (string)($v['type'] ?? '');
        if ($type === '' || !isset(RECHECK_DESCRIPTIONS[$type])) {
            continue;
        }
        $occurredAtMs = $startMs + (int)($v['offset_ms'] ?? 0);
        $occurredAt = recheck_ms_to_datetime($occurredAtMs);

        // Dedupe against anything already logged for this session/type nearby — whether it came
        // from live detection or an earlier recheck run — so re-running this is always safe.
        $dupStmt = $pdo->prepare('SELECT id FROM violation_logs
                                  WHERE session_id = ? AND type = ?
                                    AND ABS(TIMESTAMPDIFF(SECOND, occurred_at, ?)) <= 5
                                  LIMIT 1');
        $dupStmt->execute([$sessionId, $type, $occurredAt]);
        $dup = $dupStmt->fetchColumn();
        $dupStmt->closeCursor();
        if ($dup) {
            continue;
        }

        $metadata = is_array($v['metadata'] ?? null) ? $v['metadata'] : [];
        $metadata['source'] = 'recording_recheck';
        $confidence = is_numeric($v['confidence'] ?? null) ? (float)$v['confidence'] : null;
        $snapshot = is_string($v['snapshot'] ?? null) && $v['snapshot'] !== '' ? $v['snapshot'] : null;

        $insert = $pdo->prepare('INSERT INTO violation_logs
            (session_id, occurred_at, type, category, confidence, description, snapshot_base64, metadata_json, company_id)
            VALUES (?, ?, ?, "camera", ?, ?, ?, ?, ?)');
        $insert->execute([
            $sessionId, $occurredAt, $type, $confidence,
            RECHECK_DESCRIPTIONS[$type] . ' (added via recording re-check)',
            $snapshot, json_encode($metadata), $companyId,
        ]);
        $inserted++;
    }

    recheck_mark($pdo, $recordingId, 'DONE', $inserted);

    audit_log($pdo, [
        'companyId' => $companyId,
        'actorRole' => 'SYSTEM',
        'actorId' => 'recheck',
        'action' => 'RECORDING_RECHECK',
        'targetType' => 'exam_session',
        'targetId' => (string)$sessionId,
        'message' => "Recording recheck for recording {$recordingId}: {$inserted} new violation(s) found",
        'metadata' => ['recordingId' => $recordingId, 'sessionId' => $sessionId, 'found' => $inserted, 'totalDetected' => count($violations)],
    ]);
} catch (Throwable $e) {
    recheck_mark($pdo, $recordingId, 'FAILED', null, $e->getMessage());
    exit(1);
}
