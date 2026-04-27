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

function table_exists(PDO $pdo, string $tableName): bool {
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

$method = $_SERVER['REQUEST_METHOD'];

if ($method === 'GET') {
    $companyId = require_company_id();
    $audit = isset($_GET['audit']) && (string)$_GET['audit'] === '1';
    $sessionIdParam = isset($_GET['sessionId']) ? (int)$_GET['sessionId'] : null;
    $hasAuditTable = table_exists($pdo, 'result_audit_logs');
    if ($audit && $sessionIdParam) {
        if (!$hasAuditTable) {
            json_response(['audits' => []]);
        }
        $sessionCheck = $pdo->prepare('SELECT id FROM exam_sessions WHERE id = ? AND company_id = ? LIMIT 1');
        $sessionCheck->execute([$sessionIdParam, $companyId]);
        if (!$sessionCheck->fetch()) {
            json_response(['audits' => []]);
        }

        $auditStmt = $pdo->prepare('SELECT id, session_id, question_id, previous_awarded_marks, new_awarded_marks, previous_is_correct, new_is_correct, actor, note, created_at
                                    FROM result_audit_logs
                                    WHERE session_id = ?
                                    ORDER BY created_at DESC, id DESC');
        $auditStmt->execute([$sessionIdParam]);
        $rows = $auditStmt->fetchAll();
        $audits = array_map(function ($row) {
            return [
                'id' => (int)$row['id'],
                'sessionId' => (int)$row['session_id'],
                'questionId' => $row['question_id'],
                'previousAwardedMarks' => $row['previous_awarded_marks'] !== null ? (int)$row['previous_awarded_marks'] : null,
                'newAwardedMarks' => $row['new_awarded_marks'] !== null ? (int)$row['new_awarded_marks'] : null,
                'previousIsCorrect' => $row['previous_is_correct'] !== null ? (bool)$row['previous_is_correct'] : null,
                'newIsCorrect' => $row['new_is_correct'] !== null ? (bool)$row['new_is_correct'] : null,
                'actor' => $row['actor'],
                'note' => $row['note'],
                'createdAt' => datetime_to_ms($row['created_at']) ?? 0,
            ];
        }, $rows);
        json_response(['audits' => $audits]);
    }

    $examId = isset($_GET['examId']) ? trim((string)$_GET['examId']) : null;
    $studentId = isset($_GET['studentId']) ? trim((string)$_GET['studentId']) : null;

    $where = [];
    $params = [$companyId];
    if ($examId) {
        $where[] = 'es.exam_id = ?';
        $params[] = $examId;
    }
    if ($studentId) {
        $where[] = 'es.student_id = ?';
        $params[] = $studentId;
    }
    if ($sessionIdParam) {
        $where[] = 'es.id = ?';
        $params[] = $sessionIdParam;
    }

    $sql = 'SELECT es.id, es.exam_id, es.student_id, es.start_time, es.end_time, es.status, es.total_score, es.max_score, es.passed,
                   e.pass_percent
            FROM exam_sessions es
            JOIN exams e ON e.id = es.exam_id AND e.company_id = es.company_id
            WHERE es.company_id = ?';
    if (!empty($where)) {
        $sql .= ' AND ' . implode(' AND ', $where);
    }
    $sql .= ' AND es.status = \'COMPLETED\'';
    $sql .= ' ORDER BY es.start_time DESC';

    $stmt = $pdo->prepare($sql);
    $stmt->execute($params);
    $sessions = $stmt->fetchAll();

    $groups = [];
    foreach ($sessions as $s) {
        $key = $s['exam_id'] . '|' . $s['student_id'];
        if (!isset($groups[$key])) {
            $groups[$key] = [];
        }
        $groups[$key][] = $s;
    }

    $groupMeta = [];
    foreach ($groups as $key => $group) {
        usort($group, function ($a, $b) {
            return strtotime($a['start_time']) <=> strtotime($b['start_time']);
        });

        $attemptIndex = [];
        foreach ($group as $idx => $g) {
            $attemptIndex[(int)$g['id']] = $idx + 1;
        }

        $groupMeta[$key] = [
            'attemptCount' => count($group),
            'attemptIndex' => $attemptIndex,
        ];
    }

    $hasQuestionTimesTable = table_exists($pdo, 'session_question_times');
    $timeSelect = $hasQuestionTimesTable ? 'sqt.seconds_spent' : 'NULL AS seconds_spent';
    $timeJoin = $hasQuestionTimesTable
        ? 'LEFT JOIN session_question_times sqt ON sqt.session_id = sa.session_id AND sqt.question_id = sa.question_id'
        : '';

    $answersStmt = $pdo->prepare("SELECT
            sa.question_id,
            sa.answer_text,
            sa.answer_option_index,
            sa.is_correct,
            sa.awarded_marks,
            q.text,
            q.type,
            q.options_json,
            q.correct_option_index,
            q.marks,
            eq.display_order,
            {$timeSelect}
        FROM session_answers sa
        JOIN questions q ON q.id = sa.question_id
        LEFT JOIN exam_questions eq ON eq.exam_id = ? AND eq.question_id = sa.question_id
        {$timeJoin}
        WHERE sa.session_id = ?
        ORDER BY (eq.display_order IS NULL), eq.display_order ASC, sa.question_id ASC");

    $results = [];
    foreach ($sessions as $s) {
        $key = $s['exam_id'] . '|' . $s['student_id'];
        $meta = $groupMeta[$key] ?? null;

        $answersStmt->execute([$s['exam_id'], $s['id']]);
        $answerRows = $answersStmt->fetchAll();
        $answersStmt->closeCursor();

        $answers = array_map(function ($row) {
            $options = null;
            if (!empty($row['options_json'])) {
                $decoded = json_decode($row['options_json'], true);
                $options = is_array($decoded) ? $decoded : null;
            }
            return [
                'questionId' => $row['question_id'],
                'questionText' => $row['text'],
                'questionType' => $row['type'],
                'options' => $options,
                'correctOptionIndex' => $row['correct_option_index'] !== null ? (int)$row['correct_option_index'] : null,
                'marks' => (int)$row['marks'],
                'answerText' => $row['answer_text'],
                'answerOptionIndex' => $row['answer_option_index'] !== null ? (int)$row['answer_option_index'] : null,
                'isCorrect' => $row['is_correct'] !== null ? (bool)$row['is_correct'] : null,
                'awardedMarks' => $row['awarded_marks'] !== null ? (int)$row['awarded_marks'] : null,
                'timeSpentSec' => $row['seconds_spent'] !== null ? (int)$row['seconds_spent'] : null,
            ];
        }, $answerRows);

        $score = $s['total_score'] !== null ? (int)$s['total_score'] : null;
        $maxScore = $s['max_score'] !== null ? (int)$s['max_score'] : null;
        $passPercent = isset($s['pass_percent']) ? (int)$s['pass_percent'] : 60;
        if ($passPercent < 0) $passPercent = 0;
        if ($passPercent > 100) $passPercent = 100;
        $finalPercent = null;
        if ($score !== null && $maxScore !== null && $maxScore > 0) {
            $finalPercent = (int)round(($score / $maxScore) * 100);
        }

        $results[] = [
            'sessionId' => (int)$s['id'],
            'examId' => $s['exam_id'],
            'studentId' => $s['student_id'],
            'startTime' => datetime_to_ms($s['start_time']) ?? 0,
            'endTime' => datetime_to_ms($s['end_time']),
            'status' => $s['status'],
            'totalScore' => $score,
            'maxScore' => $maxScore,
            'passed' => $s['passed'] !== null ? (bool)$s['passed'] : null,
            'attemptPolicy' => 'LAST',
            'attemptIndex' => $meta ? ($meta['attemptIndex'][(int)$s['id']] ?? null) : null,
            'attemptCount' => $meta['attemptCount'] ?? null,
            'finalScore' => $score,
            'finalMaxScore' => $maxScore,
            'finalPercent' => $finalPercent,
            'finalPassed' => $s['passed'] !== null
                ? (bool)$s['passed']
                : ($finalPercent !== null ? ($finalPercent >= $passPercent) : null),
            'answers' => $answers,
        ];
    }

    json_response(['results' => $results]);
}

if ($method === 'POST') {
    $payload = json_input();
    require_role(['ADMIN'], $payload);
    $companyId = require_company_id($payload);
    $sessionId = isset($payload['sessionId']) ? (int)$payload['sessionId'] : 0;
    $changes = isset($payload['changes']) && is_array($payload['changes']) ? $payload['changes'] : [];
    $actor = isset($payload['actor']) ? trim((string)$payload['actor']) : null;
    $note = isset($payload['note']) ? trim((string)$payload['note']) : null;

    if ($sessionId <= 0 || count($changes) === 0) {
        json_response(['error' => 'sessionId and changes are required.'], 400);
    }

    $sessStmt = $pdo->prepare('SELECT id, exam_id, student_id FROM exam_sessions WHERE id = ? AND company_id = ? LIMIT 1');
    $sessStmt->execute([$sessionId, $companyId]);
    $session = $sessStmt->fetch();
    if (!$session) {
        json_response(['error' => 'Session not found.'], 404);
    }

    $questionIds = [];
    foreach ($changes as $c) {
        if (is_array($c) && isset($c['questionId'])) {
            $questionIds[] = (string)$c['questionId'];
        }
    }
    $questionIds = array_values(array_filter(array_unique($questionIds), function ($id) {
        return $id !== '';
    }));

    if (count($questionIds) === 0) {
        json_response(['error' => 'No valid questionIds.'], 400);
    }

    $placeholders = implode(',', array_fill(0, count($questionIds), '?'));
    $currentStmt = $pdo->prepare("SELECT sa.question_id, sa.awarded_marks, sa.is_correct, q.type, q.marks
                                  FROM session_answers sa
                                  JOIN questions q ON q.id = sa.question_id
                                  WHERE sa.session_id = ? AND sa.question_id IN ($placeholders)");
    $currentStmt->execute(array_merge([$sessionId], $questionIds));
    $currentRows = $currentStmt->fetchAll();

    $currentMap = [];
    foreach ($currentRows as $row) {
        $currentMap[$row['question_id']] = $row;
    }

    $updateStmt = $pdo->prepare('UPDATE session_answers SET awarded_marks = ?, is_correct = ? WHERE session_id = ? AND question_id = ?');
    $hasAuditTable = table_exists($pdo, 'result_audit_logs');
    $auditStmt = null;
    if ($hasAuditTable) {
        $auditStmt = $pdo->prepare('INSERT INTO result_audit_logs (session_id, question_id, previous_awarded_marks, new_awarded_marks, previous_is_correct, new_is_correct, actor, note)
                                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    }

    $updated = 0;
    foreach ($changes as $change) {
        if (!is_array($change) || !isset($change['questionId'])) continue;
        $qid = (string)$change['questionId'];
        if (!isset($currentMap[$qid])) continue;

        $row = $currentMap[$qid];
        $prevAwarded = $row['awarded_marks'] !== null ? (int)$row['awarded_marks'] : null;
        $prevCorrect = $row['is_correct'] !== null ? (bool)$row['is_correct'] : null;
        $qType = $row['type'];
        $qMarks = (int)$row['marks'];

        $newAwarded = array_key_exists('awardedMarks', $change) ? $change['awardedMarks'] : $prevAwarded;
        if ($newAwarded === '' || $newAwarded === null) {
            $newAwarded = null;
        } elseif (is_numeric($newAwarded)) {
            $newAwarded = (int)$newAwarded;
        } else {
            $newAwarded = $prevAwarded;
        }

        $newCorrect = array_key_exists('isCorrect', $change) ? $change['isCorrect'] : null;
        if ($newCorrect !== null) {
            $newCorrect = (bool)$newCorrect;
        } else {
            if ($qType === 'MCQ' && $newAwarded !== null) {
                if ($newAwarded >= $qMarks) {
                    $newCorrect = true;
                } elseif ($newAwarded === 0) {
                    $newCorrect = false;
                } else {
                    $newCorrect = null;
                }
            } else {
                $newCorrect = null;
            }
        }

        if ($prevAwarded === $newAwarded && $prevCorrect === $newCorrect) {
            continue;
        }

        $updateStmt->execute([$newAwarded, $newCorrect, $sessionId, $qid]);
        if ($auditStmt) {
            $auditStmt->execute([
                $sessionId,
                $qid,
                $prevAwarded,
                $newAwarded,
                $prevCorrect === null ? null : ($prevCorrect ? 1 : 0),
                $newCorrect === null ? null : ($newCorrect ? 1 : 0),
                $actor,
                $note
            ]);
        }
        $updated++;
    }

    $scoreStmt = $pdo->prepare('SELECT q.type, q.marks, sa.awarded_marks
                                FROM session_answers sa
                                JOIN questions q ON q.id = sa.question_id
                                WHERE sa.session_id = ?');
    $scoreStmt->execute([$sessionId]);
    $scoreRows = $scoreStmt->fetchAll();

    $totalScore = 0;
    $maxScore = 0;
    $pending = false;
    foreach ($scoreRows as $r) {
        $marks = (int)$r['marks'];
        $maxScore += $marks;
        if ($r['type'] === 'TEXT' && $r['awarded_marks'] === null) {
            $pending = true;
        }
        $totalScore += $r['awarded_marks'] !== null ? (int)$r['awarded_marks'] : 0;
    }

    $passed = null;
    if (!$pending && $maxScore > 0) {
        $passStmt = $pdo->prepare('SELECT e.pass_percent
                                   FROM exam_sessions es
                                   JOIN exams e ON e.id = es.exam_id
                                   WHERE es.id = ? AND es.company_id = ? LIMIT 1');
        $passStmt->execute([$sessionId, $companyId]);
        $passRow = $passStmt->fetch();
        $passPercent = $passRow && isset($passRow['pass_percent']) ? (int)$passRow['pass_percent'] : 60;
        if ($passPercent < 0) $passPercent = 0;
        if ($passPercent > 100) $passPercent = 100;
        $passed = ($totalScore / $maxScore) >= ($passPercent / 100) ? 1 : 0;
    }

    $updateSession = $pdo->prepare('UPDATE exam_sessions SET total_score = ?, max_score = ?, passed = ? WHERE id = ? AND company_id = ?');
    $updateSession->execute([$totalScore, $maxScore, $passed, $sessionId, $companyId]);

    $log = $pdo->prepare('CALL sp_log_access(?, ?, ?, ?, ?, ?)');
    $log->execute([$companyId, $session['exam_id'], $session['student_id'], 'RE-GRADE', 'OK', "Updated {$updated} answers"]);
    while ($log->nextRowset()) {}
    $log->closeCursor();

    audit_log($pdo, [
        'companyId' => $companyId,
        'actorRole' => 'ADMIN',
        'actorId' => $actor,
        'action' => 'RESULT_REGRADE',
        'targetType' => 'session',
        'targetId' => (string)$sessionId,
        'message' => "Regraded {$updated} answers",
        'metadata' => ['note' => $note]
    ]);

    json_response(['ok' => true, 'updated' => $updated]);
}

json_response(['error' => 'Method not allowed.'], 405);
