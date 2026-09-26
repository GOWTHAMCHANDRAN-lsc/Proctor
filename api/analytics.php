<?php
declare(strict_types=1);

require __DIR__ . '/_bootstrap.php';

$method = $_SERVER['REQUEST_METHOD'];

if ($method === 'GET') {
    require_staff(); // admin-only read: blocks tokenless/forged-header access
    $companyId = require_company_id();
    $examId = isset($_GET['examId']) ? trim((string)$_GET['examId']) : '';
    if ($examId === '') {
        json_response(['error' => 'examId is required.'], 400);
    }

    $examCheck = $pdo->prepare('SELECT id FROM exams WHERE id = ? AND company_id = ? LIMIT 1');
    $examCheck->execute([$examId, $companyId]);
    if (!$examCheck->fetch()) {
        json_response(['questions' => []]);
    }

    $qStmt = $pdo->prepare('SELECT q.id, q.text, q.type, q.marks, eq.display_order
                            FROM exam_questions eq
                            JOIN questions q ON q.id = eq.question_id
                            WHERE eq.exam_id = ?
                            ORDER BY eq.display_order ASC');
    $qStmt->execute([$examId]);
    $questions = $qStmt->fetchAll();

    $questionMeta = [];
    foreach ($questions as $q) {
        $questionMeta[$q['id']] = [
            'questionId' => $q['id'],
            'questionText' => $q['text'],
            'questionType' => $q['type'],
            'marks' => (int)$q['marks'],
            'displayOrder' => $q['display_order'] !== null ? (int)$q['display_order'] : null,
        ];
    }

    $sessionStmt = $pdo->prepare('SELECT id, total_score
                                  FROM exam_sessions
                                  WHERE company_id = ? AND exam_id = ? AND status = "COMPLETED"');
    $sessionStmt->execute([$companyId, $examId]);
    $sessions = $sessionStmt->fetchAll();

    $sessionScores = [];
    foreach ($sessions as $s) {
        $sessionScores[(int)$s['id']] = $s['total_score'] !== null ? (float)$s['total_score'] : 0;
    }

    $sessionIds = array_keys($sessionScores);
    if (count($sessionIds) === 0) {
        json_response(['questions' => array_values(array_map(function ($q) {
            return array_merge($q, [
                'attempts' => 0,
                'gradedAttempts' => 0,
                'correctRate' => 0,
                'difficulty' => 0,
                'avgAwardedMarks' => 0,
                'avgTimeSec' => 0,
                'discrimination' => 0,
            ]);
        }, $questionMeta))]);
    }

    $sessionIdPlaceholders = implode(',', array_fill(0, count($sessionIds), '?'));

    $aStmt = $pdo->prepare("SELECT sa.session_id, sa.question_id, sa.is_correct, sa.awarded_marks, q.type, q.marks, sqt.seconds_spent
                            FROM session_answers sa
                            JOIN questions q ON q.id = sa.question_id
                            LEFT JOIN session_question_times sqt ON sqt.session_id = sa.session_id AND sqt.question_id = sa.question_id
                            WHERE sa.session_id IN ($sessionIdPlaceholders)");
    $aStmt->execute($sessionIds);
    $answerRows = $aStmt->fetchAll();

    $stats = [];
    foreach ($questionMeta as $qid => $meta) {
        $stats[$qid] = [
            'questionId' => $qid,
            'questionText' => $meta['questionText'],
            'questionType' => $meta['questionType'],
            'marks' => $meta['marks'],
            'displayOrder' => $meta['displayOrder'],
            'attempts' => 0,
            'gradedAttempts' => 0,
            'correct' => 0,
            'totalAwarded' => 0,
            'totalTime' => 0,
        ];
    }

    // Determine top and bottom quartiles by total_score
    arsort($sessionScores);
    $sortedSessionIds = array_keys($sessionScores);
    $quartileSize = max(1, (int)floor(count($sortedSessionIds) * 0.25));
    $topSet = array_flip(array_slice($sortedSessionIds, 0, $quartileSize));
    $bottomSet = array_flip(array_slice($sortedSessionIds, -$quartileSize));

    $topCorrect = [];
    $topGraded = [];
    $bottomCorrect = [];
    $bottomGraded = [];

    foreach ($answerRows as $row) {
        $qid = $row['question_id'];
        if (!isset($stats[$qid])) continue;
        $stats[$qid]['attempts'] += 1;

        $marks = (int)$row['marks'];
        $awarded = $row['awarded_marks'];
        $isCorrect = $row['is_correct'];

        $graded = false;
        $correct = false;
        if ($isCorrect !== null) {
            $graded = true;
            $correct = (bool)$isCorrect;
        } elseif ($awarded !== null) {
            $graded = true;
            $correct = ((float)$awarded === (float)$marks);
        }

        if ($graded) {
            $stats[$qid]['gradedAttempts'] += 1;
            $stats[$qid]['correct'] += $correct ? 1 : 0;
            $stats[$qid]['totalAwarded'] += (float)$awarded;
        }

        if ($row['seconds_spent'] !== null) {
            $stats[$qid]['totalTime'] += (int)$row['seconds_spent'];
        }

        $sid = (int)$row['session_id'];
        if (isset($topSet[$sid]) && $graded) {
            $topGraded[$qid] = ($topGraded[$qid] ?? 0) + 1;
            if ($correct) $topCorrect[$qid] = ($topCorrect[$qid] ?? 0) + 1;
        }
        if (isset($bottomSet[$sid]) && $graded) {
            $bottomGraded[$qid] = ($bottomGraded[$qid] ?? 0) + 1;
            if ($correct) $bottomCorrect[$qid] = ($bottomCorrect[$qid] ?? 0) + 1;
        }
    }

    $result = [];
    foreach ($stats as $qid => $s) {
        $gradedAttempts = $s['gradedAttempts'];
        $correctRate = $gradedAttempts > 0 ? $s['correct'] / $gradedAttempts : 0;
        $difficulty = 1 - $correctRate;
        $avgAwarded = $gradedAttempts > 0 ? $s['totalAwarded'] / $gradedAttempts : 0;
        $avgTime = $s['attempts'] > 0 ? $s['totalTime'] / $s['attempts'] : 0;

        $topRate = (isset($topGraded[$qid]) && $topGraded[$qid] > 0) ? ($topCorrect[$qid] ?? 0) / $topGraded[$qid] : 0;
        $bottomRate = (isset($bottomGraded[$qid]) && $bottomGraded[$qid] > 0) ? ($bottomCorrect[$qid] ?? 0) / $bottomGraded[$qid] : 0;
        $discrimination = $topRate - $bottomRate;

        $result[] = [
            'questionId' => $qid,
            'questionText' => $s['questionText'],
            'questionType' => $s['questionType'],
            'marks' => $s['marks'],
            'displayOrder' => $s['displayOrder'],
            'attempts' => $s['attempts'],
            'gradedAttempts' => $gradedAttempts,
            'correctRate' => round($correctRate, 4),
            'difficulty' => round($difficulty, 4),
            'avgAwardedMarks' => round($avgAwarded, 2),
            'avgTimeSec' => round($avgTime, 2),
            'discrimination' => round($discrimination, 4),
        ];
    }

    usort($result, function ($a, $b) {
        $ao = $a['displayOrder'] ?? PHP_INT_MAX;
        $bo = $b['displayOrder'] ?? PHP_INT_MAX;
        if ($ao === $bo) {
            return ($a['questionId'] <=> $b['questionId']);
        }
        return $ao <=> $bo;
    });

    json_response(['questions' => $result]);
}

json_response(['error' => 'Method not allowed.'], 405);
