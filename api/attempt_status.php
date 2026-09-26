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

// Turn a student's ordered access-log rows into a plain-language reason for why
// they have no surviving attempt. The admin "reset" action is deliberately NOT
// used as a reason — we surface the underlying cause (violation / network / no submit).
function derive_attempt_reason(array $logs): array {
    $hasComplete = false;
    $hasStartOk = false;
    $hasStartDeny = false;
    $reconnectDevice = false;
    $reconnectIssue = false;
    $violationMsg = null;
    $lastAt = null;

    foreach ($logs as $l) {
        $action = (string)$l['action'];
        $status = (string)$l['status'];
        $lastAt = $l['created_at'];
        if ($action === 'COMPLETE') $hasComplete = true;
        if ($action === 'START' && $status === 'OK') $hasStartOk = true;
        if ($action === 'START' && $status !== 'OK') $hasStartDeny = true;
        if ($action === 'VIOLATION_BLOCK') $violationMsg = (string)$l['message'];
        if ($action === 'RECONNECT') {
            if ($status === 'DENY_DEVICE') $reconnectDevice = true;
            elseif ($status !== 'OK') $reconnectIssue = true;
        }
    }

    if ($hasComplete) {
        $reason = 'Completed (submitted)';
    } elseif ($violationMsg !== null) {
        $reason = 'Auto-terminated for proctoring violations';
        $decoded = json_decode($violationMsg, true);
        if (is_array($decoded) && !empty($decoded['reason'])) {
            $clean = trim(str_replace('Exam terminated.', '', (string)$decoded['reason']));
            if ($clean !== '') $reason = 'Terminated — ' . $clean;
        }
    } elseif ($reconnectDevice) {
        $reason = 'Blocked — signed in from a different device';
    } elseif ($reconnectIssue) {
        $reason = 'Network / connection failure (disconnected)';
    } elseif ($hasStartOk) {
        $reason = 'Started but did not submit';
    } elseif ($hasStartDeny) {
        $reason = 'Could not start — access blocked / pending approval';
    } else {
        $reason = 'Opened but no session started';
    }

    return ['reason' => $reason, 'lastActivity' => datetime_to_ms($lastAt)];
}

$method = $_SERVER['REQUEST_METHOD'];

if ($method === 'GET') {
    require_staff(); // admin-only read: blocks tokenless/forged-header access to per-student attempt data
    $companyId = require_company_id();
    $examId = isset($_GET['examId']) ? trim((string)$_GET['examId']) : '';
    if ($examId === '') {
        json_response(['error' => 'examId is required.'], 400);
    }

    $examCheck = $pdo->prepare('SELECT id FROM exams WHERE id = ? AND company_id = ? LIMIT 1');
    $examCheck->execute([$examId, $companyId]);
    if (!$examCheck->fetch()) {
        json_response(['statuses' => []]);
    }

    $stmt = $pdo->prepare(
        'SELECT student_id, action, status, message, created_at
         FROM exam_access_logs
         WHERE exam_id = ? AND company_id = ?
         ORDER BY student_id ASC, created_at ASC, id ASC'
    );
    $stmt->execute([$examId, $companyId]);
    $rows = $stmt->fetchAll();

    $byStudent = [];
    foreach ($rows as $row) {
        $sid = (string)$row['student_id'];
        if (!isset($byStudent[$sid])) $byStudent[$sid] = [];
        $byStudent[$sid][] = $row;
    }

    $statuses = [];
    foreach ($byStudent as $sid => $logs) {
        $info = derive_attempt_reason($logs);
        $statuses[] = [
            'studentId' => $sid,
            'reason' => $info['reason'],
            'lastActivity' => $info['lastActivity'],
        ];
    }

    json_response(['statuses' => $statuses]);
}

json_response(['error' => 'Method not allowed.'], 405);
