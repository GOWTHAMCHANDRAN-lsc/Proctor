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

/**
 * Recompute a session's total_score/max_score/passed purely from what's ALREADY stored in
 * session_answers — no live browser payload needed. Used by an admin-triggered reset, where
 * (unlike 'complete'/'terminate') there is no in-browser answer state to grade: the candidate's
 * own client already mirrored its answers to session_answers via periodic 'save_progress' calls
 * (or a full 'complete'), so whatever was last autosaved is graded and sitting there already.
 * Returns [totalScore, maxScore].
 */
function recompute_session_score_from_stored_answers(PDO $pdo, int $sessionId): array {
    $scoreStmt = $pdo->prepare('SELECT q.marks, sa.awarded_marks
                                FROM session_answers sa
                                JOIN questions q ON q.id = sa.question_id
                                WHERE sa.session_id = ?');
    $scoreStmt->execute([$sessionId]);
    $totalScore = 0;
    $maxScore = 0;
    foreach ($scoreStmt->fetchAll() as $r) {
        $maxScore += (int)$r['marks'];
        $totalScore += $r['awarded_marks'] !== null ? (float)$r['awarded_marks'] : 0;
    }
    $scoreStmt->closeCursor();
    return [$totalScore, $maxScore];
}

/**
 * Grade the answers a candidate has provided and upsert them into session_answers, returning
 * [totalScore, maxScore, answeredCount]. Shared by 'complete' (final submit), 'terminate'
 * (violation block) and 'save_progress' (periodic autosave) so attended questions are ALWAYS
 * scored — even when the candidate never reaches a clean submit. Idempotent via ON DUPLICATE KEY,
 * so repeated autosaves and a final submit converge on the same graded rows.
 * $questionIds must be the SERVER's list (exam_served_question_ids()), never the browser's.
 * $candidateView: the answers use the candidate view's order (exam_candidate_question_view()) and
 * are mapped back to the stored order for $studentId before grading/storing.
 */
function grade_and_store_answers(PDO $pdo, $companyId, string $examId, int $sessionId, $answers, $questionIds, $questionTimes, string $studentId = '', bool $candidateView = false): array {
    if (!is_array($answers) || !is_array($questionIds)) {
        return [0, 0, 0];
    }
    $questionIds = array_values(array_filter(array_unique($questionIds), function ($id) {
        return is_string($id) && $id !== '';
    }));
    if (count($questionIds) === 0) {
        return [0, 0, 0];
    }

    $placeholders = implode(',', array_fill(0, count($questionIds), '?'));
    $qStmt = $pdo->prepare("SELECT q.id, q.type, q.correct_option_index, q.answer_key_json, q.match_options_json, q.marks, q.negative_marks, q.word_limit
                            FROM exam_questions eq
                            JOIN questions q ON q.id = eq.question_id
                            WHERE eq.exam_id = ? AND q.id IN ($placeholders)");
    $qStmt->execute(array_merge([$examId], $questionIds));
    $questions = $qStmt->fetchAll();
    $qStmt->closeCursor();

    $insert = $pdo->prepare('INSERT INTO session_answers (session_id, question_id, answer_text, answer_option_index, answer_json, is_correct, awarded_marks)
                             VALUES (?, ?, ?, ?, ?, ?, ?)
                             ON DUPLICATE KEY UPDATE answer_text = VALUES(answer_text),
                                                     answer_option_index = VALUES(answer_option_index),
                                                     answer_json = VALUES(answer_json),
                                                     is_correct = VALUES(is_correct),
                                                     awarded_marks = VALUES(awarded_marks)');
    $insertTime = $pdo->prepare('INSERT INTO session_question_times (session_id, question_id, seconds_spent)
                                 VALUES (?, ?, ?)
                                 ON DUPLICATE KEY UPDATE seconds_spent = VALUES(seconds_spent)');

    $totalScore = 0;
    $maxScore = 0;
    $answeredCount = 0;

    foreach ($questions as $q) {
        $qid = $q['id'];
        $qType = $q['type'];
        $marks = (int)$q['marks'];
        $maxScore += $marks;

        $answerValue = $answers[$qid] ?? null;
        $answerText = null;
        $answerOptionIndex = null;
        $answerJson = null;   // stored JSON string for structured responses
        $answerJsonVal = null; // decoded value passed to the grader
        $isCorrect = null;
        $awarded = null;

        $upperType = strtoupper((string)$qType);
        $answered = false;

        if (in_array($upperType, ['MCQ', 'TRUE_FALSE', 'YES_NO'], true)) {
            // Single option index.
            if ($answerValue !== null && $answerValue !== '' && is_numeric($answerValue)) {
                $answerOptionIndex = (int)$answerValue;
                $answered = true;
            }
        } elseif (in_array($upperType, ['MULTI_SELECT', 'FILL_BLANK', 'ORDERING', 'MATCHING', 'DRAG_DROP'], true)) {
            // Structured (array / map) responses.
            if ($candidateView && $studentId !== '' && is_array($answerValue) && in_array($upperType, ['ORDERING', 'MATCHING', 'DRAG_DROP'], true)) {
                $match = json_decode((string)($q['match_options_json'] ?? ''), true);
                $key = json_decode((string)($q['answer_key_json'] ?? ''), true);
                $perm = exam_candidate_question_permutation($upperType, is_array($match) ? $match : null, is_array($key) ? $key : null, $examId, $studentId, (string)$qid);
                $answerValue = exam_candidate_answer_to_stored($upperType, $answerValue, $perm);
                if (is_array($answerValue) && $upperType !== 'ORDERING') {
                    ksort($answerValue);
                }
            }
            if (is_array($answerValue) && count($answerValue) > 0) {
                $answerJsonVal = $answerValue;
                $answerJson = json_encode($answerValue);
                $answered = true;
            }
        } elseif (in_array($upperType, ['NUMERIC', 'DATE', 'TIME'], true)) {
            // Scalar answer graded as text.
            if ($answerValue !== null && $answerValue !== '') {
                $answerText = is_string($answerValue) ? $answerValue : (string)json_encode($answerValue);
                $answered = true;
            }
        } else {
            // SHORT_TEXT / LONG_TEXT / TEXT (manual) — free descriptive answer.
            if ($answerValue !== null && $answerValue !== '') {
                $answerText = is_string($answerValue) ? $answerValue : json_encode($answerValue);
                // Enforce the descriptive word limit HERE as well as in the browser. The client-side
                // cap is a usability feature (a live counter and a hard stop); it is not a control —
                // anyone with devtools can post a longer answer. This is the control: whatever is
                // stored and graded is within the limit the admin set.
                $limit = isset($q['word_limit']) && $q['word_limit'] !== null ? (int)$q['word_limit'] : 0;
                if ($limit > 0) {
                    $answerText = truncate_to_words($answerText, $limit);
                }
                $answered = true;
            }
        }

        if ($answered) {
            $answeredCount++;
            $graded = grade_question($q, $answerText, $answerOptionIndex, $answerJsonVal);
            $isCorrect = $graded['isCorrect'];
            $awarded = $graded['awarded'];
            if ($awarded !== null) {
                $totalScore += (float)$awarded;
            }
        }

        $insert->execute([$sessionId, $qid, $answerText, $answerOptionIndex, $answerJson, $isCorrect, $awarded]);

        if (is_array($questionTimes) && array_key_exists($qid, $questionTimes)) {
            $seconds = $questionTimes[$qid];
            if (is_numeric($seconds)) {
                $insertTime->execute([$sessionId, $qid, (int)$seconds]);
            }
        }
    }

    return [$totalScore, $maxScore, $answeredCount];
}

/**
 * What a candidate may see after submitting: score, pass/fail and, per served question, only
 * correct / incorrect / pending (manual marking) / unanswered — never the correct answers. Null when
 * the exam doesn't show results to candidates.
 */
function candidate_result_summary(PDO $pdo, string $examId, int $sessionId, array $servedIds): ?array {
    $stmt = $pdo->prepare('SELECT e.show_results, e.pass_percent, s.total_score, s.max_score, s.passed
                             FROM exam_sessions s JOIN exams e ON e.id = s.exam_id
                            WHERE s.id = ? AND s.exam_id = ? LIMIT 1');
    $stmt->execute([$sessionId, $examId]);
    $row = $stmt->fetch();
    $stmt->closeCursor();
    if (!$row || empty($row['show_results'])) {
        return null;
    }
    $answerStmt = $pdo->prepare('SELECT sa.question_id, sa.answer_text, sa.answer_option_index, sa.answer_json, sa.is_correct, q.type
                                   FROM session_answers sa JOIN questions q ON q.id = sa.question_id
                                  WHERE sa.session_id = ?');
    $answerStmt->execute([$sessionId]);
    $byId = [];
    foreach ($answerStmt->fetchAll() as $a) {
        $byId[(string)$a['question_id']] = $a;
    }
    $answerStmt->closeCursor();
    $grades = [];
    $pending = 0;
    foreach ($servedIds as $qid) {
        $a = $byId[$qid] ?? null;
        $answered = $a !== null && (
            ($a['answer_text'] !== null && $a['answer_text'] !== '')
            || $a['answer_option_index'] !== null
            || ($a['answer_json'] !== null && $a['answer_json'] !== '' && $a['answer_json'] !== '[]' && $a['answer_json'] !== '{}')
        );
        if (!$answered) {
            $grades[$qid] = 'unanswered';
        } elseif (is_manual_question_type((string)$a['type'])) {
            $grades[$qid] = 'pending';
            $pending++;
        } else {
            $grades[$qid] = (int)$a['is_correct'] === 1 ? 'correct' : 'incorrect';
        }
    }
    return [
        'score' => $row['total_score'] !== null ? (float)$row['total_score'] : 0.0,
        'maxScore' => $row['max_score'] !== null ? (int)$row['max_score'] : 0,
        'passed' => (int)($row['passed'] ?? 0) === 1,
        'passPercent' => max(0, min(100, (int)($row['pass_percent'] ?? 60))),
        'pending' => $pending,
        'grades' => (object)$grades,
    ];
}

/** Minutes after an attempt's own duration in which its answers are still accepted (clock pauses, retries). */
const SESSION_ANSWER_GRACE_MINUTES = 20;

/**
 * True once an attempt is past start + duration + grace. The exam clock runs in the browser, so
 * without this a candidate could reset it (clear site data and reload) or keep a tab open and
 * submit hours later. Answers arriving after this are ignored; the last autosave stands.
 */
function session_answers_closed(PDO $pdo, int $sessionId): bool {
    $stmt = $pdo->prepare('SELECT DATE_ADD(s.start_time, INTERVAL (COALESCE(e.duration_minutes, 0) + ?) MINUTE) < NOW(3) AS closed
                             FROM exam_sessions s JOIN exams e ON e.id = s.exam_id
                            WHERE s.id = ? LIMIT 1');
    $stmt->execute([SESSION_ANSWER_GRACE_MINUTES, $sessionId]);
    $closed = $stmt->fetchColumn();
    $stmt->closeCursor();
    return (int)$closed === 1;
}

/** [score, maxScore] of the already-stored answers, over the served questions only. */
function stored_score_for_served(PDO $pdo, int $sessionId, array $servedIds): array {
    if (count($servedIds) === 0) {
        return [0, 0];
    }
    $ph = implode(',', array_fill(0, count($servedIds), '?'));
    $stmt = $pdo->prepare("SELECT q.id, q.marks, sa.awarded_marks
                             FROM questions q
                             LEFT JOIN session_answers sa ON sa.question_id = q.id AND sa.session_id = ?
                            WHERE q.id IN ($ph)");
    $stmt->execute(array_merge([$sessionId], $servedIds));
    $score = 0.0;
    $max = 0;
    foreach ($stmt->fetchAll() as $r) {
        $max += (int)$r['marks'];
        $score += $r['awarded_marks'] !== null ? (float)$r['awarded_marks'] : 0;
    }
    $stmt->closeCursor();
    return [$score, $max];
}

/**
 * The violation category whose recorded count has reached the exam's limit, or null. Mirrors
 * ExamTake.tsx (violationCategoriesByType + categoryLimits): the page ends the attempt itself at the
 * limit, so this only catches a page that was stopped from doing so. Retried uploads of the same
 * violation are counted once (same type + timestamp). Exams without auto-terminate, or unproctored,
 * never breach.
 */
function session_violation_limit_breach(PDO $pdo, string $examId, int $sessionId): ?string {
    try {
        $stmt = $pdo->prepare('SELECT proctoring_mode, auto_terminate, tab_switch_limit, violation_limits_json FROM exams WHERE id = ? LIMIT 1');
        $stmt->execute([$examId]);
        $exam = $stmt->fetch();
        $stmt->closeCursor();
    } catch (Throwable $e) {
        return null; // older schema without the switches: keep the previous behaviour
    }
    if (!$exam || strtoupper((string)($exam['proctoring_mode'] ?? 'PROCTORED')) === 'UNPROCTORED' || (int)($exam['auto_terminate'] ?? 1) !== 1) {
        return null;
    }
    $raw = json_decode((string)($exam['violation_limits_json'] ?? ''), true);
    $limits = [
        'camera' => max(0, (int)($raw['camera'] ?? 0)),
        'microphone' => max(0, (int)($raw['microphone'] ?? 0)),
        'fullscreen' => max(0, (int)($raw['fullscreen'] ?? 0)),
        'copyPaste' => max(0, (int)($raw['copyPaste'] ?? 0)),
        'tabSwitch' => max(0, (int)($exam['tab_switch_limit'] ?? 0)),
    ];
    $categoryOf = [
        'TAB_SWITCH' => 'tabSwitch', 'NO_FACE' => 'camera', 'MULTIPLE_FACES' => 'camera', 'GAZE_AWAY' => 'camera',
        'AUDIO_DETECTED' => 'microphone', 'FULLSCREEN_EXIT' => 'fullscreen', 'COPY_PASTE' => 'copyPaste',
        'PHONE_DETECTED' => 'camera', 'ANOMALY_OBJECT' => 'camera', 'IDENTITY_CHANGE' => 'camera', 'SUSPICIOUS_BEHAVIOR' => 'camera',
    ];
    $counts = [];
    try {
        $stmt = $pdo->prepare('SELECT type, COUNT(DISTINCT occurred_at) AS n FROM violation_logs WHERE session_id = ? GROUP BY type');
        $stmt->execute([$sessionId]);
        foreach ($stmt->fetchAll() as $r) {
            $category = $categoryOf[(string)$r['type']] ?? null;
            if ($category !== null) {
                $counts[$category] = ($counts[$category] ?? 0) + (int)$r['n'];
            }
        }
        $stmt->closeCursor();
    } catch (Throwable $e) {
        return null;
    }
    foreach ($limits as $category => $limit) {
        if ($limit > 0 && ($counts[$category] ?? 0) >= $limit) {
            return $category;
        }
    }
    return null;
}

/** Violation counts by type already recorded for an attempt (restored on reconnect). */
function session_violation_counts(PDO $pdo, int $sessionId): array {
    try {
        $stmt = $pdo->prepare('SELECT type, COUNT(*) AS n FROM violation_logs WHERE session_id = ? GROUP BY type');
        $stmt->execute([$sessionId]);
        $out = [];
        foreach ($stmt->fetchAll() as $r) {
            $out[(string)$r['type']] = (int)$r['n'];
        }
        $stmt->closeCursor();
        return $out;
    } catch (Throwable $e) {
        return [];
    }
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
    require_staff();
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

    // Everything a candidate's page does to an attempt must come with that candidate's own token.
    if (in_array($action, ['location', 'save_progress', 'terminate', 'complete'], true)) {
        require_candidate_or_staff((string)$examId, (string)$studentId, (int)$companyId);
    }

    if ($action === 'reset_mac') {
        require_role(['ADMIN', 'SUPER_ADMIN'], $payload);
        $adminId = get_actor_id($payload);
        
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
        // Verify the SIGNED access token binds to exactly this (exam, student, company). This is the
        // control that stops a candidate editing their link's `sid`/`eid` to impersonate another
        // student or open an unassigned exam. Legacy unsigned links (no signature) fail this check;
        // they are allowed only while EXAM_ENFORCE_TOKEN is off (grace period for links already sent).
        $accessToken = isset($payload['accessToken']) && is_string($payload['accessToken']) ? trim($payload['accessToken']) : '';
        $tokenClaims = null;
        if ($accessToken !== '') {
            $decoded = json_decode(base64url_decode($accessToken), true);
            if (is_array($decoded)) $tokenClaims = $decoded;
        }
        $tokenOk = is_array($tokenClaims)
            && exam_token_valid($tokenClaims)
            && (string)($tokenClaims['eid'] ?? '') === (string)$examId
            && (string)($tokenClaims['sid'] ?? '') === (string)$studentId
            && (int)($tokenClaims['cid'] ?? 0) === (int)$companyId;
        if (exam_token_enforced() && !$tokenOk) {
            $log = $pdo->prepare('CALL sp_log_access(?, ?, ?, ?, ?, ?)');
            $log->execute([$companyId, $examId, $studentId, 'START', 'DENY', 'Invalid or tampered access token.']);
            while ($log->nextRowset()) {}
            $log->closeCursor();
            json_response([
                'error' => 'INVALID_ACCESS_TOKEN',
                'message' => 'This exam link is invalid or has been tampered with. Please use the original link from your invitation email.',
            ], 403);
        }

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

        // An exam with an assignment list (students or batches) is only for those students — a link
        // kept by someone who was removed from it no longer opens it. Exams with no list stay open to
        // the company's students, as before.
        try {
            $assignStmt = $pdo->prepare('SELECT
                    (SELECT COUNT(*) FROM exam_assignments WHERE exam_id = ?) AS direct_total,
                    (SELECT COUNT(*) FROM exam_batch_assignments WHERE exam_id = ?) AS batch_total,
                    (SELECT COUNT(*) FROM exam_assignments WHERE exam_id = ? AND student_id = ?) AS direct_me,
                    (SELECT COUNT(*) FROM exam_batch_assignments eba JOIN student_batches sb ON sb.batch_id = eba.batch_id
                      WHERE eba.exam_id = ? AND sb.student_id = ?) AS batch_me');
            $assignStmt->execute([$examId, $examId, $examId, $studentId, $examId, $studentId]);
            $assign = $assignStmt->fetch();
            $assignStmt->closeCursor();
            if ($assign && ((int)$assign['direct_total'] + (int)$assign['batch_total']) > 0
                && ((int)$assign['direct_me'] + (int)$assign['batch_me']) === 0) {
                $log = $pdo->prepare('CALL sp_log_access(?, ?, ?, ?, ?, ?)');
                $log->execute([$companyId, $examId, $studentId, 'START', 'DENY', 'Student is not assigned to this exam.']);
                while ($log->nextRowset()) {}
                $log->closeCursor();
                json_response(['error' => 'NOT_ASSIGNED', 'message' => 'You are not assigned to this exam. Please contact your administrator.'], 403);
            }
        } catch (PDOException $e) {
            // Assignment tables missing on an old database: keep the previous (open) behaviour.
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

                // An admin "Renew" (action=reset, staff-only) issued AFTER the block is an explicit
                // decision to let this candidate reattempt — the same authority as granting their
                // access request. Without this, Renew on a violation-blocked candidate reported
                // "Link renewed" while start kept refusing them with ACCESS_REQUEST_REQUIRED.
                $renewStmt = $pdo->prepare("SELECT id FROM exam_access_logs
                                            WHERE company_id = ? AND exam_id = ? AND student_id = ?
                                              AND action = 'RESET' AND status = 'OK' AND id > ?
                                            LIMIT 1");
                $renewStmt->execute([$companyId, $examId, $studentId, (int)$latestBlock['id']]);
                $renewedAfterBlock = (bool)$renewStmt->fetch();
                $renewStmt->closeCursor();

                $status = $latestRequest['status'] ?? null;
                if ($status !== 'GRANTED' && !$renewedAfterBlock) {
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

        // An attempt that ENDED without being submitted (the abandoned-attempt sweep, or any other
        // termination) needs the same approval as a violation block before a new attempt: an admin
        // Renew (RESET) or a granted reattempt request made after that attempt began. Otherwise a
        // candidate could read the paper, walk away, and come back for a fresh attempt.
        $lastStmt = $pdo->prepare("SELECT id, status, start_time FROM exam_sessions
                                   WHERE company_id = ? AND exam_id = ? AND student_id = ?
                                   ORDER BY start_time DESC, id DESC LIMIT 1");
        $lastStmt->execute([$companyId, $examId, $studentId]);
        $lastSession = $lastStmt->fetch();
        $lastStmt->closeCursor();
        if ($lastSession && ($lastSession['status'] ?? '') === 'TERMINATED') {
            $renewed = db_scalar_int($pdo, "SELECT COUNT(*) FROM exam_access_logs
                                             WHERE company_id = ? AND exam_id = ? AND student_id = ?
                                               AND action = 'RESET' AND status = 'OK' AND created_at >= ?",
                [$companyId, $examId, $studentId, $lastSession['start_time']]) > 0;
            $requestStatus = null;
            try {
                $reqStmt = $pdo->prepare("SELECT status FROM exam_access_requests
                                          WHERE company_id = ? AND exam_id = ? AND student_id = ?
                                            AND request_type = 'REATTEMPT' AND requested_at >= ?
                                          ORDER BY requested_at DESC LIMIT 1");
                $reqStmt->execute([$companyId, $examId, $studentId, $lastSession['start_time']]);
                $requestStatus = $reqStmt->fetchColumn() ?: null;
                $reqStmt->closeCursor();
            } catch (Throwable $e) {
                $requestStatus = null;
            }
            if (!$renewed && $requestStatus !== 'GRANTED') {
                $errorCode = $requestStatus === 'PENDING' ? 'ACCESS_REQUEST_PENDING' : ($requestStatus === 'REVOKED' ? 'ACCESS_REQUEST_REVOKED' : 'ACCESS_REQUEST_REQUIRED');
                $message = $requestStatus === 'PENDING'
                    ? 'Your access request is pending admin review.'
                    : ($requestStatus === 'REVOKED'
                        ? 'Your access request was revoked by admin.'
                        : 'Your previous attempt has ended. Request admin approval to reattempt.');
                $log = $pdo->prepare('CALL sp_log_access(?, ?, ?, ?, ?, ?)');
                $log->execute([$companyId, $examId, $studentId, 'START', 'DENY', $message]);
                while ($log->nextRowset()) {}
                $log->closeCursor();
                json_response(['error' => $errorCode, 'message' => $message, 'requestStatus' => $requestStatus], 409);
            }
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

            // A reconnect that sends NO fingerprint counts as a different device (leaving it out used
            // to skip this check entirely).
            if ($existingDevice && $deviceFingerprint !== $existingDevice) {
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
                        // A label for the screen, not the bound value itself (which could be replayed).
                        'previousDeviceFingerprint' => substr(hash('sha256', (string)$existingDevice), 0, 12),
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

            // Count only reconnects into THIS attempt. Counting every reconnect ever logged for the
            // exam meant a candidate renewed by an admin inherited the old attempt's used-up allowance
            // and was refused ("No more reconnection is possible") on their very first reload.
            // created_at has second precision, so compare against the attempt start truncated to the second.
            $attemptStartedAt = substr((string)($existing['start_time'] ?? ''), 0, 19);
            $countStmt = $pdo->prepare("SELECT COUNT(*) AS cnt FROM exam_access_logs WHERE company_id = ? AND exam_id = ? AND student_id = ? AND action = 'RECONNECT' AND status = 'OK' AND created_at >= ?");
            $countStmt->execute([$companyId, $examId, $studentId, $attemptStartedAt !== '' ? $attemptStartedAt : '1970-01-01 00:00:01']);
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
            // The page's clock and violation counters live in the browser (localStorage). Clearing
            // site data used to restart both; the server's own elapsed time and recorded violations
            // let the page resume from the truth.
            $elapsed = db_scalar_int($pdo, 'SELECT GREATEST(0, TIMESTAMPDIFF(SECOND, start_time, NOW(3))) FROM exam_sessions WHERE id = ?', [(int)$existingId]);
            json_response([
                'ok' => true,
                'reconnect' => true,
                'remaining' => $remaining,
                'sessionId' => $existingId ? (int)$existingId : null,
                'attempt' => $attemptNumber,
                'elapsedSeconds' => $elapsed,
                'violationCounts' => (object)session_violation_counts($pdo, (int)$existingId),
            ]);
        }

        // Entry gate for a NEW attempt (a reconnect into a live attempt returned above, so a started
        // exam still always runs its full duration). The browser checks the window too, but only
        // against the candidate's own clock — a machine clock set back, or a direct API call, could
        // otherwise open an archived exam or one whose window closed hours ago. A few minutes of
        // slack absorbs ordinary clock skew between the candidate's device and the server.
        $windowStmt = $pdo->prepare("SELECT status,
                                            (start_time IS NOT NULL AND NOW(3) < DATE_SUB(start_time, INTERVAL 5 MINUTE)) AS not_open,
                                            (end_time IS NOT NULL AND NOW(3) > DATE_ADD(end_time, INTERVAL 5 MINUTE)) AS closed
                                     FROM exams WHERE id = ? AND company_id = ? LIMIT 1");
        $windowStmt->execute([$examId, $companyId]);
        $windowRow = $windowStmt->fetch();
        $windowStmt->closeCursor();
        $windowError = null;
        if ($windowRow && ($windowRow['status'] ?? '') === 'ARCHIVED') {
            $windowError = ['EXAM_ARCHIVED', 'This exam is archived.'];
        } elseif ($windowRow && !empty($windowRow['not_open'])) {
            $windowError = ['EXAM_NOT_OPEN', 'This exam has not opened yet. Please use your link during the scheduled exam window.'];
        } elseif ($windowRow && !empty($windowRow['closed'])) {
            $windowError = ['EXAM_WINDOW_CLOSED', 'The exam window has closed. Please contact your administrator.'];
        }
        if ($windowError !== null) {
            $log = $pdo->prepare('CALL sp_log_access(?, ?, ?, ?, ?, ?)');
            $log->execute([$companyId, $examId, $studentId, 'START', 'DENY', $windowError[1]]);
            while ($log->nextRowset()) {}
            $log->closeCursor();
            json_response(['error' => $windowError[0], 'message' => $windowError[1]], 403);
        }

        $userAgent = $_SERVER['HTTP_USER_AGENT'] ?? '';
        $ipAddress = $_SERVER['REMOTE_ADDR'] ?? '';
        $location = $geo['label'] ?? ($payload['location'] ?? null);

        if (is_string($deviceFingerprint) && strlen($deviceFingerprint) > 128) {
            $deviceFingerprint = substr($deviceFingerprint, 0, 128);
        }

        $sessionId = null;
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
            // The id of THIS insert — re-selecting "latest by start_time" could return a different
            // row when two starts land in the same millisecond (double-click / duplicate request).
            $insertedId = (int)$pdo->lastInsertId();
            $sessionId = $insertedId > 0 ? $insertedId : null;
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

        if ($sessionId === null) {
            $sessionStmt = $pdo->prepare('SELECT id FROM exam_sessions WHERE company_id = ? AND exam_id = ? AND student_id = ? ORDER BY start_time DESC LIMIT 1');
            $sessionStmt->execute([$companyId, $examId, $studentId]);
            $session = $sessionStmt->fetch();
            $sessionId = $session ? (int)$session['id'] : null;
        }

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

        json_response(['ok' => true, 'sessionId' => $sessionId, 'attempt' => $attemptNumber, 'elapsedSeconds' => 0, 'violationCounts' => new stdClass()]);
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

    if ($action === 'save_progress') {
        // Periodic server-side autosave of in-progress answers. Without this, a candidate who closes
        // the tab / loses the browser before submitting leaves NO answers on the server, so their
        // attended questions can't be scored. Grading here (idempotent) means an abandoned attempt
        // is later finalized as a FAIL that still reflects what they actually answered.
        // Row-locked so an autosave that was already in flight when the candidate submitted can't
        // land AFTER 'complete' and overwrite the final graded answers with its older snapshot:
        // whichever runs second sees the other's committed status.
        $pdo->beginTransaction();
        try {
            $sessionStmt = $pdo->prepare("SELECT id, status FROM exam_sessions
                                          WHERE company_id = ? AND exam_id = ? AND student_id = ?
                                          ORDER BY start_time DESC LIMIT 1
                                          FOR UPDATE");
            $sessionStmt->execute([$companyId, $examId, $studentId]);
            $session = $sessionStmt->fetch();
            $sessionStmt->closeCursor();

            // Only autosave into a live attempt; a completed/terminated session is final.
            if (!$session || ($session['status'] ?? '') !== 'IN_PROGRESS') {
                $pdo->rollBack();
                json_response(['ok' => true, 'saved' => false]);
            }

            $sessionId = (int)$session['id'];
            if (session_answers_closed($pdo, $sessionId)) {
                // Past the attempt's time: the last in-time autosave stands.
                $pdo->rollBack();
                json_response(['ok' => true, 'saved' => false, 'reason' => 'TIME_UP']);
            }
            [$totalScore, $maxScore, $answeredCount] = grade_and_store_answers(
                $pdo, $companyId, (string)$examId, $sessionId,
                $payload['answers'] ?? null, exam_served_question_ids($pdo, (string)$examId, $sessionId), $payload['questionTimes'] ?? null,
                (string)$studentId, ($payload['answerSpace'] ?? '') === 'candidate-v1'
            );
            if ($maxScore > 0) {
                $update = $pdo->prepare('UPDATE exam_sessions SET total_score = ?, max_score = ? WHERE id = ? AND company_id = ?');
                $update->execute([$totalScore, $maxScore, $sessionId, $companyId]);
            }
            $pdo->commit();
        } catch (Throwable $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            throw $e;
        }
        json_response(['ok' => true, 'saved' => true, 'answered' => $answeredCount]);
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
        db_add_column_if_missing($pdo, 'exam_sessions', 'termination_reason', 'VARCHAR(255) NULL AFTER passed');
        if (($session['status'] ?? '') === 'IN_PROGRESS') {
            // Grade whatever the candidate attended before being blocked, so the terminated attempt
            // shows the real score of answered questions (not a blank row). A terminated attempt is
            // still a FAIL regardless of that score — passed = 0.
            $servedIds = exam_served_question_ids($pdo, (string)$examId, $sessionId);
            if (session_answers_closed($pdo, $sessionId)) {
                [$termScore, $termMax] = stored_score_for_served($pdo, $sessionId, $servedIds);
            } else {
                [$termScore, $termMax] = grade_and_store_answers(
                    $pdo, $companyId, (string)$examId, $sessionId,
                    $payload['answers'] ?? null, $servedIds, $payload['questionTimes'] ?? null,
                    (string)$studentId, ($payload['answerSpace'] ?? '') === 'candidate-v1'
                );
            }
            $reasonStore = mb_substr($reason, 0, 255);
            if ($termMax > 0) {
                $update = $pdo->prepare("UPDATE exam_sessions
                                         SET status = 'TERMINATED', end_time = NOW(3), passed = 0,
                                             total_score = ?, max_score = ?, termination_reason = ?
                                         WHERE id = ? AND company_id = ?");
                $update->execute([$termScore, $termMax, $reasonStore, $sessionId, $companyId]);
            } else {
                $update = $pdo->prepare("UPDATE exam_sessions
                                         SET status = 'TERMINATED', end_time = NOW(3), passed = 0,
                                             termination_reason = ?
                                         WHERE id = ? AND company_id = ?");
                $update->execute([$reasonStore, $sessionId, $companyId]);
            }
        }

        // Session ended by termination — close out any recordings still marked 'RECORDING'.
        finalize_stuck_recordings($pdo, $companyId, (string)$examId, (string)$studentId, 'COMPLETED');

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
        $questionTimes = $payload['questionTimes'] ?? null;
        // The browser also sends questionIds; they are deliberately ignored (see exam_served_question_ids()).
        $candidateView = ($payload['answerSpace'] ?? '') === 'candidate-v1';

        // Only a LIVE attempt can be submitted. This used to complete-then-regrade whatever the latest
        // session was, so a 'complete' arriving for an attempt that had already ended rewrote it:
        //  - a TERMINATED attempt (violation block, admin Renew, abandoned sweep) flipped back to
        //    COMPLETED with a freshly computed pass — undoing the block/renewal, and letting a blocked
        //    candidate post a passing submission;
        //  - a COMPLETED attempt was re-graded from whatever answers the new request carried, so a
        //    candidate could re-submit different answers after seeing their result.
        // Grading now happens BEFORE the status flip, in one row-locked transaction, so a retry after
        // a failed first attempt still finds the session IN_PROGRESS and grades it, while a retry
        // after a successful one is a harmless no-op.
        $pdo->beginTransaction();
        try {
            $sessionStmt = $pdo->prepare('SELECT id, status FROM exam_sessions WHERE company_id = ? AND exam_id = ? AND student_id = ? ORDER BY start_time DESC LIMIT 1 FOR UPDATE');
            $sessionStmt->execute([$companyId, $examId, $studentId]);
            $session = $sessionStmt->fetch();
            $sessionStmt->closeCursor();

            if (!$session) {
                $pdo->rollBack();
                json_response(['error' => 'SESSION_NOT_FOUND'], 404);
            }

            $sessionId = (int)$session['id'];
            $sessionStatus = (string)($session['status'] ?? '');

            if ($sessionStatus === 'COMPLETED') {
                // Already submitted (e.g. a retry whose first request landed but whose response was lost).
                $pdo->rollBack();
                json_response(['ok' => true, 'alreadyCompleted' => true,
                    'result' => candidate_result_summary($pdo, (string)$examId, $sessionId, exam_served_question_ids($pdo, (string)$examId, $sessionId))]);
            }
            if ($sessionStatus !== 'IN_PROGRESS') {
                $pdo->rollBack();
                json_response([
                    'error' => 'SESSION_TERMINATED',
                    'message' => 'This exam attempt has already ended and can no longer be submitted. Please contact your administrator.',
                ], 409);
            }

            $servedIds = exam_served_question_ids($pdo, (string)$examId, $sessionId);
            if (session_answers_closed($pdo, $sessionId)) {
                // Submitted after the attempt's time (plus grace): grade what was autosaved in time.
                [$totalScore, $maxScore] = stored_score_for_served($pdo, $sessionId, $servedIds);
            } else {
                [$totalScore, $maxScore, $answeredCount] = grade_and_store_answers(
                    $pdo, $companyId, (string)$examId, $sessionId, $answers, $servedIds, $questionTimes,
                    (string)$studentId, $candidateView
                );
            }

            // A page that was stopped from ending the attempt at a violation limit can't turn it into a
            // completed (possibly passing) result: the attempt is ended as a violation block instead.
            $breach = session_violation_limit_breach($pdo, (string)$examId, $sessionId);
            if ($breach !== null) {
                db_add_column_if_missing($pdo, 'exam_sessions', 'termination_reason', 'VARCHAR(255) NULL AFTER passed');
                $reason = "Violation limit reached ({$breach}) — submission recorded as terminated.";
                $term = $pdo->prepare("UPDATE exam_sessions SET status = 'TERMINATED', end_time = NOW(3), passed = 0,
                                              total_score = ?, max_score = ?, termination_reason = ?
                                        WHERE id = ? AND company_id = ?");
                $term->execute([$totalScore, $maxScore, $reason, $sessionId, $companyId]);
                $term->closeCursor();
                $log = $pdo->prepare('CALL sp_log_access(?, ?, ?, ?, ?, ?)');
                $log->execute([$companyId, $examId, $studentId, 'VIOLATION_BLOCK', 'DENY', $reason]);
                while ($log->nextRowset()) {}
                $log->closeCursor();
                $pdo->commit();
                finalize_stuck_recordings($pdo, $companyId, (string)$examId, (string)$studentId, 'COMPLETED');
                audit_log($pdo, [
                    'companyId' => $companyId, 'actorRole' => 'SYSTEM', 'actorId' => $studentId,
                    'action' => 'SESSION_TERMINATE', 'targetType' => 'exam', 'targetId' => $examId,
                    'message' => $reason, 'metadata' => ['sessionId' => $sessionId, 'category' => $breach],
                ]);
                json_response(['ok' => true, 'terminated' => true, 'result' => null]);
            }

            if ($maxScore > 0) {
                $passed = null;
                $passStmt = $pdo->prepare('SELECT pass_percent FROM exams WHERE id = ? AND company_id = ? LIMIT 1');
                $passStmt->execute([$examId, $companyId]);
                $passRow = $passStmt->fetch();
                $passStmt->closeCursor();
                $passPercent = $passRow && isset($passRow['pass_percent']) ? (int)$passRow['pass_percent'] : 60;
                if ($passPercent < 0) $passPercent = 0;
                if ($passPercent > 100) $passPercent = 100;
                $passed = ($totalScore / $maxScore) >= ($passPercent / 100) ? 1 : 0;

                $update = $pdo->prepare('UPDATE exam_sessions SET total_score = ?, max_score = ?, passed = ?, end_time = NOW(3), status = \'COMPLETED\' WHERE id = ? AND company_id = ?');
                $update->execute([$totalScore, $maxScore, $passed, $sessionId, $companyId]);
            }

            // Flips this attempt (when nothing was gradable above) and any stray duplicate live
            // attempt for the same candidate to COMPLETED.
            $done = $pdo->prepare('CALL sp_complete_exam_session(?, ?, ?)');
            $done->execute([$companyId, $examId, $studentId]);
            while ($done->nextRowset()) {}
            $done->closeCursor();

            $pdo->commit();
        } catch (Throwable $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            throw $e;
        }

        // Certification is on-demand only (an admin triggers it explicitly from a passed result,
        // gated per-exam by certificateEnabled) — a passing submission no longer auto-fires
        // maybe_issue_certificate() here. See api/certificates.php.

        // Exam is over — close out any recordings the client left open (tab close / crash / network
        // drop can skip the client-side COMPLETE call, stranding them in 'RECORDING').
        finalize_stuck_recordings($pdo, $companyId, (string)$examId, (string)$studentId, 'COMPLETED');

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

        respond_then_continue(['ok' => true, 'result' => candidate_result_summary($pdo, (string)$examId, $sessionId, $servedIds)]);
        exit;
    }

    if ($action === 'reset') {
        // NON-DESTRUCTIVE by design. This used to CALL sp_reset_exam_session, which hard-DELETEs
        // the session row — and session_answers/violation_logs cascade-delete with it, permanently
        // losing every answer the candidate had given (including ones already autosaved via
        // 'save_progress'). That destroyed a real candidate's completed answers when used to try to
        // unblock a device-fingerprint lock (see the SAL_Warehouse_Executives_Pre_Assessment
        // incident). A "renew" must never be able to erase data — it can only relabel the existing
        // session as TERMINATED (which already doesn't block a fresh start, same as the 'terminate'
        // action) so the candidate can begin a NEW attempt while the old one stays on record,
        // preserved, for review.
        //
        // Staff-only (the Monitoring "Renew" button — ADMIN / SUPER_ADMIN / PROCTOR). This had no role
        // check at all, so a candidate could "renew" their own COMPLETED attempt and retake the exam
        // as many times as they liked, or end a classmate's live attempt.
        $resetActorRole = require_role(['ADMIN', 'PROCTOR'], $payload);
        db_add_column_if_missing($pdo, 'exam_sessions', 'termination_reason', 'VARCHAR(255) NULL AFTER passed');

        $sessionStmt = $pdo->prepare("SELECT id, status
                                      FROM exam_sessions
                                      WHERE company_id = ? AND exam_id = ? AND student_id = ?
                                      ORDER BY start_time DESC
                                      LIMIT 1");
        $sessionStmt->execute([$companyId, $examId, $studentId]);
        $session = $sessionStmt->fetch();
        $sessionStmt->closeCursor();

        if ($session && ($session['status'] ?? '') !== 'TERMINATED') {
            $sessionId = (int)$session['id'];
            [$score, $maxScore] = recompute_session_score_from_stored_answers($pdo, $sessionId);
            $update = $pdo->prepare("UPDATE exam_sessions
                                     SET status = 'TERMINATED',
                                         end_time = COALESCE(end_time, NOW(3)),
                                         total_score = ?, max_score = ?, passed = 0,
                                         termination_reason = 'Renewed by admin — candidate may reattempt.'
                                     WHERE id = ? AND company_id = ?");
            $update->execute([$score, $maxScore, $sessionId, $companyId]);
            finalize_stuck_recordings($pdo, $companyId, (string)$examId, (string)$studentId, 'COMPLETED');
        }
        // If no session exists, or it's already TERMINATED, there is nothing to do — a fresh
        // start already isn't blocked (only a COMPLETED status blocks 'start', and this session
        // is no longer COMPLETED either way).

        $log = $pdo->prepare('CALL sp_log_access(?, ?, ?, ?, ?, ?)');
        $log->execute([$companyId, $examId, $studentId, 'RESET', 'OK', 'Session renewed by admin (previous attempt preserved as TERMINATED).']);
        while ($log->nextRowset()) {}
        $log->closeCursor();

        audit_log($pdo, [
            'companyId' => $companyId,
            'actorRole' => $resetActorRole,
            'actorId' => get_actor_id($payload) ?? ($payload['actor'] ?? null),
            'action' => 'SESSION_RESET',
            'targetType' => 'exam',
            'targetId' => $examId,
            'message' => "Session renewed for student {$studentId} (previous attempt preserved)"
        ]);

        json_response(['ok' => true]);
    }

    json_response(['error' => 'Invalid action.'], 400);
}

json_response(['error' => 'Method not allowed.'], 405);
