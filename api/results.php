<?php
declare(strict_types=1);

require __DIR__ . '/_bootstrap.php';
require_once __DIR__ . '/certificates.php';

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
    require_staff(); // admin-only read: blocks tokenless/forged-header access
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
                'previousAwardedMarks' => $row['previous_awarded_marks'] !== null ? (float)$row['previous_awarded_marks'] : null,
                'newAwardedMarks' => $row['new_awarded_marks'] !== null ? (float)$row['new_awarded_marks'] : null,
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

    // Reconcile unfinished attempts so no attempt (and its violations) is lost from results.
    // Both of these must surface as a FAIL:
    //   (a) Abandoned — still IN_PROGRESS but the attempt has outlived its own allotted time by a
    //       30-minute grace, so the candidate never submitted. Definitively over → TERMINATED + fail.
    //       (Duration-based only: this never touches a genuinely live attempt within its time.)
    //   (b) Terminated attempts that predate pass/fail stamping (passed IS NULL) → stamp passed = 0.
    db_add_column_if_missing($pdo, 'exam_sessions', 'termination_reason', 'VARCHAR(255) NULL AFTER passed');
    try {
        $sweepAbandoned = $pdo->prepare(
            "UPDATE exam_sessions es
             JOIN exams e ON e.id = es.exam_id AND e.company_id = es.company_id
                SET es.status = 'TERMINATED', es.end_time = NOW(3), es.passed = 0,
                    es.termination_reason = COALESCE(es.termination_reason, 'Not submitted — exam time elapsed. Scored on attended questions.')
              WHERE es.company_id = ?
                AND es.status = 'IN_PROGRESS'
                AND DATE_ADD(es.start_time, INTERVAL (COALESCE(e.duration_minutes, 0) + 30) MINUTE) < NOW(3)"
        );
        $sweepAbandoned->execute([$companyId]);
        $sweepAbandoned->closeCursor();

        $sweepTerminated = $pdo->prepare(
            "UPDATE exam_sessions
                SET passed = 0
              WHERE company_id = ? AND status = 'TERMINATED' AND passed IS NULL"
        );
        $sweepTerminated->execute([$companyId]);
        $sweepTerminated->closeCursor();
    } catch (Throwable $e) {
        // Best-effort reconciliation — never block the results listing on it.
    }

    $sql = 'SELECT es.id, es.exam_id, es.student_id, es.start_time, es.end_time, es.status, es.total_score, es.max_score, es.passed,
                   es.termination_reason,
                   e.pass_percent,
                   (SELECT COUNT(*) FROM violation_logs vl WHERE vl.session_id = es.id) AS violation_count
            FROM exam_sessions es
            JOIN exams e ON e.id = es.exam_id AND e.company_id = es.company_id
            WHERE es.company_id = ?';
    if (!empty($where)) {
        $sql .= ' AND ' . implode(' AND ', $where);
    }
    // Include TERMINATED attempts (violation-blocked or abandoned) alongside COMPLETED so they show
    // as fails — nothing a candidate did is lost, even if they never submitted. The frontend already
    // renders and counts the TERMINATED status.
    $sql .= ' AND es.status IN (\'COMPLETED\', \'TERMINATED\')';
    $sql .= ' ORDER BY es.start_time DESC';

    $stmt = $pdo->prepare($sql);
    $stmt->execute($params);
    $sessions = $stmt->fetchAll();

    // violation_count above is the RAW event count, which reports one sustained problem (a webcam
    // showing a placeholder for 19 minutes) as 112 violations against the candidate. Report real
    // incidents instead, and keep the raw tally alongside it so nothing is hidden.
    $episodeCounts = violation_episode_counts($pdo, $companyId);

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
            sa.answer_json,
            sa.is_correct,
            sa.awarded_marks,
            q.text,
            q.type,
            q.options_json,
            q.correct_option_index,
            q.answer_key_json,
            q.match_options_json,
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
            $decodeJson = function ($raw) {
                if ($raw === null || $raw === '') return null;
                $decoded = json_decode((string)$raw, true);
                return $decoded === null && json_last_error() !== JSON_ERROR_NONE ? null : $decoded;
            };
            $options = $decodeJson($row['options_json']);
            return [
                'questionId' => $row['question_id'],
                'questionText' => $row['text'],
                'questionType' => $row['type'],
                'options' => is_array($options) ? $options : null,
                'correctOptionIndex' => $row['correct_option_index'] !== null ? (int)$row['correct_option_index'] : null,
                'answerKey' => $decodeJson($row['answer_key_json']),
                'matchOptions' => $decodeJson($row['match_options_json']),
                'marks' => (int)$row['marks'],
                'answerText' => $row['answer_text'],
                'answerOptionIndex' => $row['answer_option_index'] !== null ? (int)$row['answer_option_index'] : null,
                'answerJson' => $decodeJson($row['answer_json']),
                'isCorrect' => $row['is_correct'] !== null ? (bool)$row['is_correct'] : null,
                'awardedMarks' => $row['awarded_marks'] !== null ? (float)$row['awarded_marks'] : null,
                'timeSpentSec' => $row['seconds_spent'] !== null ? (int)$row['seconds_spent'] : null,
            ];
        }, $answerRows);

        $score = $s['total_score'] !== null ? (float)$s['total_score'] : null;
        $maxScore = $s['max_score'] !== null ? (float)$s['max_score'] : null;
        $passPercent = isset($s['pass_percent']) ? (int)$s['pass_percent'] : 60;
        if ($passPercent < 0) $passPercent = 0;
        if ($passPercent > 100) $passPercent = 100;
        $finalPercent = null;
        if ($score !== null && $maxScore !== null && $maxScore > 0) {
            $finalPercent = (int)round(($score / $maxScore) * 100);
        }

        // How many questions the candidate actually attended (answered), for terminated/abandoned
        // attempts where that differs from the full paper.
        $answeredCount = 0;
        foreach ($answers as $a) {
            if ($a['answerOptionIndex'] !== null || ($a['answerText'] !== null && $a['answerText'] !== '')) {
                $answeredCount++;
            }
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
            'answeredCount' => $answeredCount,
            'terminationReason' => $s['termination_reason'] ?? null,
            // Real incidents (a sustained problem counts once), with the raw detector-event tally
            // kept alongside it. Falls back to the raw count if episode grouping was unavailable.
            'violationCount' => $episodeCounts[(int)$s['id']]
                ?? (isset($s['violation_count']) ? (int)$s['violation_count'] : 0),
            'violationEventCount' => isset($s['violation_count']) ? (int)$s['violation_count'] : 0,
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
        $prevAwarded = $row['awarded_marks'] !== null ? (float)$row['awarded_marks'] : null;
        $prevCorrect = $row['is_correct'] !== null ? (bool)$row['is_correct'] : null;
        $qType = $row['type'];
        $qMarks = (int)$row['marks'];

        $newAwarded = array_key_exists('awardedMarks', $change) ? $change['awardedMarks'] : $prevAwarded;
        if ($newAwarded === '' || $newAwarded === null) {
            $newAwarded = null;
        } elseif (is_numeric($newAwarded)) {
            $newAwarded = (float)$newAwarded;
        } else {
            $newAwarded = $prevAwarded;
        }

        $newCorrect = array_key_exists('isCorrect', $change) ? $change['isCorrect'] : null;
        if ($newCorrect !== null) {
            $newCorrect = (bool)$newCorrect;
        } else {
            if (!is_manual_question_type($qType) && $newAwarded !== null) {
                // Auto-graded types are all-or-nothing: derive correctness from the marks.
                if ($newAwarded >= $qMarks) {
                    $newCorrect = true;
                } elseif ((float)$newAwarded === 0.0) {
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
        if (is_manual_question_type($r['type']) && $r['awarded_marks'] === null) {
            $pending = true;
        }
        $totalScore += $r['awarded_marks'] !== null ? (float)$r['awarded_marks'] : 0;
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

    // Certification is on-demand only — this regrade no longer auto-fires maybe_issue_certificate().
    // An admin issues a certificate explicitly from a passed result. See api/certificates.php.

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

    respond_then_continue(['ok' => true, 'updated' => $updated]);
    exit;
}

json_response(['error' => 'Method not allowed.'], 405);
