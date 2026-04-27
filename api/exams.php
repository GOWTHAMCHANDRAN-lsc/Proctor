<?php
declare(strict_types=1);

require __DIR__ . '/_bootstrap.php';

function ms_to_datetime(?int $ms): ?string {
    if ($ms === null) return null;
    $sec = intdiv($ms, 1000);
    $msPart = $ms % 1000;
    $dt = (new DateTimeImmutable("@{$sec}"))->setTimezone(new DateTimeZone(date_default_timezone_get()));
    return $dt->format('Y-m-d H:i:s') . '.' . str_pad((string)$msPart, 3, '0', STR_PAD_LEFT);
}

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

function normalize_violation_limits($raw): array {
    $defaults = [
        'camera' => 0,
        'microphone' => 0,
        'fullscreen' => 0,
        'copyPaste' => 0,
    ];

    if (is_string($raw) && $raw !== '') {
        $decoded = json_decode($raw, true);
        if (is_array($decoded)) {
            $raw = $decoded;
        }
    }

    if (!is_array($raw)) {
        return $defaults;
    }

    foreach ($defaults as $key => $fallback) {
        $val = $raw[$key] ?? $fallback;
        $num = is_numeric($val) ? (int)$val : $fallback;
        $defaults[$key] = max(0, $num);
    }

    return $defaults;
}

function ensure_exam_batch_assignment_schema(PDO $pdo): void {
    $pdo->exec("CREATE TABLE IF NOT EXISTS exam_batch_assignments (
      exam_id     VARCHAR(64) NOT NULL,
      batch_id    BIGINT UNSIGNED NOT NULL,
      assigned_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (exam_id, batch_id),
      INDEX idx_exam_batch_assignments_batch (batch_id)
    ) ENGINE=InnoDB");
}

function fetch_assigned_batch_ids(PDO $pdo, string $examId): array {
    $stmt = $pdo->prepare('SELECT batch_id FROM exam_batch_assignments WHERE exam_id = ? ORDER BY batch_id ASC');
    $stmt->execute([$examId]);
    $rows = $stmt->fetchAll();
    $stmt->closeCursor();
    return array_map(static fn($row) => (int)$row['batch_id'], $rows);
}

function fetch_exam_questions_direct(PDO $pdo, string $examId): array {
    $stmt = $pdo->prepare('SELECT
            q.id,
            q.type,
            q.text,
            q.options_json,
            q.correct_option_index,
            q.marks,
            eq.display_order
        FROM exam_questions eq
        JOIN questions q ON q.id = eq.question_id
        WHERE eq.exam_id = ?
        ORDER BY eq.display_order ASC');
    $stmt->execute([$examId]);
    $rows = $stmt->fetchAll();
    $stmt->closeCursor();
    return $rows;
}

function fetch_exam_assignments_direct(PDO $pdo, string $examId): array {
    $stmt = $pdo->prepare('SELECT student_id FROM exam_assignments WHERE exam_id = ? ORDER BY student_id ASC');
    $stmt->execute([$examId]);
    $rows = $stmt->fetchAll();
    $stmt->closeCursor();
    return $rows;
}

function fetch_exam_sections_direct(PDO $pdo, string $examId): array {
    $stmt = $pdo->prepare('SELECT id, title, display_order, question_limit, shuffle_questions, time_limit_minutes, lock_on_complete
                           FROM exam_sections
                           WHERE exam_id = ?
                           ORDER BY display_order ASC');
    $stmt->execute([$examId]);
    $rows = $stmt->fetchAll();
    $stmt->closeCursor();
    return $rows;
}

function fetch_exam_section_questions_direct(PDO $pdo, string $sectionId): array {
    $stmt = $pdo->prepare('SELECT
            q.id,
            q.type,
            q.text,
            q.options_json,
            q.correct_option_index,
            q.marks,
            esq.display_order
        FROM exam_section_questions esq
        JOIN questions q ON q.id = esq.question_id
        WHERE esq.section_id = ?
        ORDER BY esq.display_order ASC');
    $stmt->execute([$sectionId]);
    $rows = $stmt->fetchAll();
    $stmt->closeCursor();
    return $rows;
}

$method = $_SERVER['REQUEST_METHOD'];
ensure_exam_batch_assignment_schema($pdo);

if ($method === 'GET') {
    $companyId = require_company_id();
    $stmt = $pdo->prepare('SELECT * FROM exams WHERE company_id = ? ORDER BY updated_at DESC');
    $stmt->execute([$companyId]);
    $rows = $stmt->fetchAll();
    $stmt->closeCursor();

    $exams = [];
    foreach ($rows as $row) {
        $examId = $row['id'];
        $violationLimitsRaw = db_column_exists($pdo, 'exams', 'violation_limits_json')
            ? ($row['violation_limits_json'] ?? null)
            : null;
        $questions = fetch_exam_questions_direct($pdo, $examId);

        $mappedQuestions = array_map(function ($q) {
            $options = null;
            if (!empty($q['options_json'])) {
                $decoded = json_decode($q['options_json'], true);
                $options = is_array($decoded) ? $decoded : null;
            }
            return [
                'id' => $q['id'],
                'text' => $q['text'],
                'type' => $q['type'],
                'options' => $options,
                'correctOptionIndex' => $q['correct_option_index'] !== null ? (int)$q['correct_option_index'] : null,
                'marks' => (int)$q['marks'],
            ];
        }, $questions);

        $assignments = fetch_exam_assignments_direct($pdo, $examId);
        $assignedIds = array_map(fn($a) => $a['student_id'], $assignments);
        $assignedBatchIds = fetch_assigned_batch_ids($pdo, $examId);

        $sections = [];
        $secRows = fetch_exam_sections_direct($pdo, $examId);

        foreach ($secRows as $sec) {
            $secId = $sec['id'];
            $secQuestions = fetch_exam_section_questions_direct($pdo, $secId);

            $mappedSecQuestions = array_map(function ($q) {
                $options = null;
                if (!empty($q['options_json'])) {
                    $decoded = json_decode($q['options_json'], true);
                    $options = is_array($decoded) ? $decoded : null;
                }
                return [
                    'id' => $q['id'],
                    'text' => $q['text'],
                    'type' => $q['type'],
                    'options' => $options,
                    'correctOptionIndex' => $q['correct_option_index'] !== null ? (int)$q['correct_option_index'] : null,
                    'marks' => (int)$q['marks'],
                ];
            }, $secQuestions);

            $sections[] = [
                'id' => $secId,
                'title' => $sec['title'],
                'displayOrder' => (int)$sec['display_order'],
                'questionLimit' => (int)$sec['question_limit'],
                'shuffleQuestions' => (bool)$sec['shuffle_questions'],
                'timeLimitMinutes' => isset($sec['time_limit_minutes']) ? (int)$sec['time_limit_minutes'] : 0,
                'lockOnComplete' => isset($sec['lock_on_complete']) ? (bool)$sec['lock_on_complete'] : true,
                'questions' => $mappedSecQuestions,
            ];
        }

        $exams[] = [
            'id' => $examId,
            'title' => $row['title'],
            'durationMinutes' => (int)$row['duration_minutes'],
            'startTime' => datetime_to_ms($row['start_time']),
            'endTime' => datetime_to_ms($row['end_time']),
            'questions' => $mappedQuestions,
            'sections' => $sections,
            'questionCount' => $row['question_count'] !== null ? (int)$row['question_count'] : null,
            'shuffleQuestions' => (bool)$row['shuffle_questions'],
            'showResults' => (bool)$row['show_results'],
            'attemptPolicy' => $row['attempt_policy'] ?? 'LAST',
            'passPercent' => isset($row['pass_percent']) ? (int)$row['pass_percent'] : 60,
            'reconnectLimit' => isset($row['reconnect_limit']) ? (int)$row['reconnect_limit'] : 0,
            'totalMarks' => (int)$row['total_marks'],
            'status' => $row['status'],
            'proctoringConfig' => [
                'cameraRequired' => (bool)$row['camera_required'],
                'microphoneRequired' => (bool)$row['microphone_required'],
                'fullScreenEnforced' => (bool)$row['fullscreen_enforced'],
                'tabSwitchLimit' => (int)$row['tab_switch_limit'],
                'violationLimits' => normalize_violation_limits($violationLimitsRaw),
            ],
            'assignedStudentIds' => $assignedIds,
            'assignedBatchIds' => $assignedBatchIds,
            'notificationConfig' => [
                'enabled' => (bool)$row['notification_enabled'],
                'reminders' => [
                    'hours24' => (bool)$row['reminder_hours24'],
                    'hours1' => (bool)$row['reminder_hours1'],
                ],
                'customSubject' => $row['notification_subject'] ?? '',
                'customMessage' => $row['notification_message'] ?? '',
            ],
        ];
    }

    json_response(['exams' => $exams]);
}

if ($method === 'POST') {
    $payload = json_input();
    require_role(['ADMIN'], $payload);
    $companyId = require_company_id($payload);
    if (isset($payload['action'])) {
        $action = strtoupper(trim((string)$payload['action']));
        if ($action === 'DELETE' || $action === 'ARCHIVE') {
            $id = trim((string)($payload['id'] ?? ''));
            if ($id === '') {
                json_response(['error' => 'Exam id is required.'], 400);
            }
            $permanent = !empty($payload['permanent']);
            if ($action === 'ARCHIVE' || !$permanent) {
                $stmt = $pdo->prepare("UPDATE exams SET status = 'ARCHIVED' WHERE id = ? AND company_id = ?");
                $stmt->execute([$id, $companyId]);
                audit_log($pdo, [
                    'companyId' => $companyId,
                    'actorRole' => 'ADMIN',
                    'actorId' => $payload['actor'] ?? null,
                    'action' => 'EXAM_ARCHIVE',
                    'targetType' => 'exam',
                    'targetId' => $id,
                    'message' => 'Exam archived'
                ]);
                json_response(['ok' => true, 'archived' => true]);
            }

            $stmt = $pdo->prepare('DELETE FROM exams WHERE id = ? AND company_id = ?');
            $stmt->execute([$id, $companyId]);
            audit_log($pdo, [
                'companyId' => $companyId,
                'actorRole' => 'ADMIN',
                'actorId' => $payload['actor'] ?? null,
                'action' => 'EXAM_DELETE',
                'targetType' => 'exam',
                'targetId' => $id,
                'message' => 'Exam permanently deleted'
            ]);
            json_response(['ok' => true, 'deleted' => true]);
        }
        json_response(['error' => 'Invalid action.'], 400);
    }
    $exam = $payload;
    if (isset($payload['exam']) && is_array($payload['exam'])) {
        $exam = $payload['exam'];
    }

    if (!is_array($exam)) {
        json_response(['error' => 'Invalid exam payload.'], 400);
    }

    $id = $exam['id'] ?? bin2hex(random_bytes(8));
    $title = trim((string)($exam['title'] ?? ''));
    $duration = (int)($exam['durationMinutes'] ?? 0);
    $startMs = isset($exam['startTime']) ? (int)$exam['startTime'] : null;
    $endMs = isset($exam['endTime']) ? (int)$exam['endTime'] : null;
    $questionCount = isset($exam['questionCount']) ? (int)$exam['questionCount'] : null;
    $shuffle = !empty($exam['shuffleQuestions']) ? 1 : 0;
    $reconnectLimit = isset($exam['reconnectLimit']) ? (int)$exam['reconnectLimit'] : 0;
    $totalMarks = (int)($exam['totalMarks'] ?? 0);
    $status = $exam['status'] ?? 'DRAFT';
    $passPercent = isset($exam['passPercent']) ? (int)$exam['passPercent'] : 60;
    if ($passPercent < 0) $passPercent = 0;
    if ($passPercent > 100) $passPercent = 100;

    if ($title === '' || $duration <= 0 || $startMs === null || $endMs === null) {
        json_response(['error' => 'Exam title, durationMinutes, startTime, and endTime are required.'], 400);
    }
    if ($endMs <= $startMs) {
        json_response(['error' => 'endTime must be later than startTime.'], 400);
    }

    $attemptPolicy = 'LAST';
    $sectionsInput = $exam['sections'] ?? [];
    $proctor = $exam['proctoringConfig'] ?? [];
    $violationLimits = normalize_violation_limits($proctor['violationLimits'] ?? null);
    $notif = $exam['notificationConfig'] ?? [];

    $saveArgs = [
        'id' => $id,
        'companyId' => $companyId,
        'title' => $title,
        'duration' => $duration,
        'startTime' => ms_to_datetime($startMs),
        'endTime' => ms_to_datetime($endMs),
        'questionCount' => $questionCount,
        'shuffle' => $shuffle,
        'showResults' => !empty($exam['showResults']) ? 1 : 0,
        'passPercent' => $passPercent,
        'attemptPolicy' => $attemptPolicy,
        'reconnectLimit' => $reconnectLimit,
        'totalMarks' => $totalMarks,
        'status' => $status,
        'cameraRequired' => !empty($proctor['cameraRequired']) ? 1 : 0,
        'microphoneRequired' => !empty($proctor['microphoneRequired']) ? 1 : 0,
        'fullscreenEnforced' => !empty($proctor['fullScreenEnforced']) ? 1 : 0,
        'tabSwitchLimit' => (int)($proctor['tabSwitchLimit'] ?? 3),
        'violationLimits' => json_encode($violationLimits),
        'notificationEnabled' => !empty($notif['enabled']) ? 1 : 0,
        'reminderHours24' => !empty($notif['reminders']['hours24']) ? 1 : 0,
        'reminderHours1' => !empty($notif['reminders']['hours1']) ? 1 : 0,
        'notificationSubject' => $notif['customSubject'] ?? null,
        'notificationMessage' => $notif['customMessage'] ?? null,
    ];

    $sections = [];
    $questionMap = [];

    if (is_array($sectionsInput) && count($sectionsInput) > 0) {
        $sectionOrder = 0;
        foreach ($sectionsInput as $section) {
            if (!is_array($section)) continue;
            $sectionId = $section['id'] ?? bin2hex(random_bytes(8));
            $sectionTitle = trim((string)($section['title'] ?? 'Section'));
            $sectionLimit = isset($section['questionLimit']) ? (int)$section['questionLimit'] : 0;
            $sectionShuffle = !empty($section['shuffleQuestions']) ? 1 : 0;

            $sectionQuestions = [];
            if (isset($section['questions']) && is_array($section['questions'])) {
                foreach ($section['questions'] as $q) {
                    if (!is_array($q)) continue;
                    $qid = $q['id'] ?? bin2hex(random_bytes(8));
                    $q['id'] = $qid;
                    $questionMap[$qid] = $q;
                    $sectionQuestions[] = $q;
                }
            }

            $sections[] = [
                'id' => $sectionId,
                'title' => $sectionTitle,
                'displayOrder' => $sectionOrder,
                'questionLimit' => $sectionLimit,
                'shuffleQuestions' => $sectionShuffle ? true : false,
                'timeLimitMinutes' => isset($section['timeLimitMinutes']) ? (int)$section['timeLimitMinutes'] : 0,
                'lockOnComplete' => array_key_exists('lockOnComplete', $section) ? !empty($section['lockOnComplete']) : true,
                'questions' => $sectionQuestions,
            ];
            $sectionOrder++;
        }
    } else {
        $questions = $exam['questions'] ?? [];
        if (is_array($questions)) {
            foreach ($questions as $q) {
                if (!is_array($q)) continue;
                $qid = $q['id'] ?? bin2hex(random_bytes(8));
                $q['id'] = $qid;
                $questionMap[$qid] = $q;
            }
        }
    }

    $order = 0;
    foreach ($questionMap as $qid => $q) {
        $qType = $q['type'] ?? 'MCQ';
        $qText = $q['text'] ?? '';
        $optionsJson = null;
        if (isset($q['options']) && is_array($q['options'])) {
            $optionsJson = json_encode(array_values($q['options']));
        }
        $correctIdx = $q['correctOptionIndex'] ?? null;
        $marks = (int)($q['marks'] ?? 1);

        $saveQStmt = $pdo->prepare('CALL sp_save_question(?, ?, ?, ?, ?, ?)');
        $saveQStmt->execute([
            $qid,
            $qType,
            $qText,
            $optionsJson,
            $correctIdx,
            $marks,
        ]);
        while ($saveQStmt->nextRowset()) {}
        $saveQStmt->closeCursor();

        $linkStmt = $pdo->prepare('CALL sp_link_exam_question(?, ?, ?)');
        $linkStmt->execute([$id, $qid, $order]);
        while ($linkStmt->nextRowset()) {}
        $linkStmt->closeCursor();
        $order++;
    }

    if (count($sections) > 0) {
        foreach ($sections as $sectionIdx => $section) {
            $saveSectionStmt = $pdo->prepare('CALL sp_save_exam_section(?, ?, ?, ?, ?, ?, ?, ?)');
            $saveSectionStmt->execute([
                $section['id'],
                $id,
                $section['title'],
                $sectionIdx,
                (int)$section['questionLimit'],
                !empty($section['shuffleQuestions']) ? 1 : 0,
                isset($section['timeLimitMinutes']) ? (int)$section['timeLimitMinutes'] : 0,
                !empty($section['lockOnComplete']) ? 1 : 0,
            ]);
            while ($saveSectionStmt->nextRowset()) {}
            $saveSectionStmt->closeCursor();

            $qOrder = 0;
            foreach ($section['questions'] as $q) {
                $qid = $q['id'] ?? null;
                if (!$qid) continue;
                $linkSectionStmt = $pdo->prepare('CALL sp_link_exam_section_question(?, ?, ?)');
                $linkSectionStmt->execute([$section['id'], $qid, $qOrder]);
                while ($linkSectionStmt->nextRowset()) {}
                $linkSectionStmt->closeCursor();
                $qOrder++;
            }
        }
    }

    $assignedBatchIds = array_values(array_filter(array_map('intval', $exam['assignedBatchIds'] ?? []), static fn($value) => $value > 0));
    foreach ($assignedBatchIds as $batchId) {
        $batchAssignStmt = $pdo->prepare('INSERT IGNORE INTO exam_batch_assignments (exam_id, batch_id) VALUES (?, ?)');
        $batchAssignStmt->execute([$id, $batchId]);
        $batchAssignStmt->closeCursor();
    }

    if (count($assignedBatchIds) > 0) {
        $placeholders = implode(',', array_fill(0, count($assignedBatchIds), '?'));
        $assignStudentStmt = $pdo->prepare("SELECT id
                                            FROM students
                                            WHERE company_id = ?
                                              AND batch_id IN ($placeholders)
                                            ORDER BY id ASC");
        $assignStudentStmt->execute(array_merge([$companyId], $assignedBatchIds));
        $assignedStudentRows = $assignStudentStmt->fetchAll();
        $assignStudentStmt->closeCursor();
        $assignedIds = array_values(array_unique(array_map(static fn($row) => (string)$row['id'], $assignedStudentRows)));
    } else {
        $assignedIds = $exam['assignedStudentIds'] ?? [];
    }

    try {
        $pdo->beginTransaction();

        $saveStmt = $pdo->prepare('INSERT INTO exams
            (id, company_id, title, duration_minutes, start_time, end_time, question_count, shuffle_questions, show_results,
             pass_percent, attempt_policy, reconnect_limit, total_marks, status, camera_required, microphone_required,
             fullscreen_enforced, tab_switch_limit, notification_enabled, reminder_hours24, reminder_hours1,
             notification_subject, notification_message)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
                company_id = VALUES(company_id),
                title = VALUES(title),
                duration_minutes = VALUES(duration_minutes),
                start_time = VALUES(start_time),
                end_time = VALUES(end_time),
                question_count = VALUES(question_count),
                shuffle_questions = VALUES(shuffle_questions),
                show_results = VALUES(show_results),
                pass_percent = VALUES(pass_percent),
                attempt_policy = VALUES(attempt_policy),
                reconnect_limit = VALUES(reconnect_limit),
                total_marks = VALUES(total_marks),
                status = VALUES(status),
                camera_required = VALUES(camera_required),
                microphone_required = VALUES(microphone_required),
                fullscreen_enforced = VALUES(fullscreen_enforced),
                tab_switch_limit = VALUES(tab_switch_limit),
                notification_enabled = VALUES(notification_enabled),
                reminder_hours24 = VALUES(reminder_hours24),
                reminder_hours1 = VALUES(reminder_hours1),
                notification_subject = VALUES(notification_subject),
                notification_message = VALUES(notification_message)');
        $saveStmt->execute([
            $saveArgs['id'],
            $saveArgs['companyId'],
            $saveArgs['title'],
            $saveArgs['duration'],
            $saveArgs['startTime'],
            $saveArgs['endTime'],
            $saveArgs['questionCount'],
            $saveArgs['shuffle'],
            $saveArgs['showResults'],
            $saveArgs['passPercent'],
            $saveArgs['attemptPolicy'],
            $saveArgs['reconnectLimit'],
            $saveArgs['totalMarks'],
            $saveArgs['status'],
            $saveArgs['cameraRequired'],
            $saveArgs['microphoneRequired'],
            $saveArgs['fullscreenEnforced'],
            $saveArgs['tabSwitchLimit'],
            $saveArgs['notificationEnabled'],
            $saveArgs['reminderHours24'],
            $saveArgs['reminderHours1'],
            $saveArgs['notificationSubject'],
            $saveArgs['notificationMessage'],
        ]);
        $saveStmt->closeCursor();

        if (db_column_exists($pdo, 'exams', 'violation_limits_json')) {
            $limitUpdate = $pdo->prepare('UPDATE exams SET violation_limits_json = ? WHERE id = ? AND company_id = ?');
            $limitUpdate->execute([$saveArgs['violationLimits'], $id, $companyId]);
            $limitUpdate->closeCursor();
        }

        $sectionIdStmt = $pdo->prepare('SELECT id FROM exam_sections WHERE exam_id = ?');
        $sectionIdStmt->execute([$id]);
        $existingSectionIds = array_map(static fn(array $row): string => (string)$row['id'], $sectionIdStmt->fetchAll());
        $sectionIdStmt->closeCursor();

        if ($existingSectionIds !== []) {
            $placeholders = implode(',', array_fill(0, count($existingSectionIds), '?'));
            $deleteSectionQuestions = $pdo->prepare("DELETE FROM exam_section_questions WHERE section_id IN ($placeholders)");
            $deleteSectionQuestions->execute($existingSectionIds);
            $deleteSectionQuestions->closeCursor();
        }

        $deleteSections = $pdo->prepare('DELETE FROM exam_sections WHERE exam_id = ?');
        $deleteSections->execute([$id]);
        $deleteSections->closeCursor();

        $deleteExamQuestions = $pdo->prepare('DELETE FROM exam_questions WHERE exam_id = ?');
        $deleteExamQuestions->execute([$id]);
        $deleteExamQuestions->closeCursor();

        $deleteAssignments = $pdo->prepare('DELETE FROM exam_assignments WHERE exam_id = ?');
        $deleteAssignments->execute([$id]);
        $deleteAssignments->closeCursor();

        $clearBatchStmt = $pdo->prepare('DELETE FROM exam_batch_assignments WHERE exam_id = ?');
        $clearBatchStmt->execute([$id]);
        $clearBatchStmt->closeCursor();

        $saveQuestionStmt = $pdo->prepare('INSERT INTO questions (id, type, text, options_json, correct_option_index, marks)
                                           VALUES (?, ?, ?, ?, ?, ?)
                                           ON DUPLICATE KEY UPDATE
                                             type = VALUES(type),
                                             text = VALUES(text),
                                             options_json = VALUES(options_json),
                                             correct_option_index = VALUES(correct_option_index),
                                             marks = VALUES(marks)');
        $linkQuestionStmt = $pdo->prepare('INSERT INTO exam_questions (exam_id, question_id, display_order) VALUES (?, ?, ?)');

        $order = 0;
        foreach ($questionMap as $qid => $q) {
            $optionsJson = isset($q['options']) && is_array($q['options']) ? json_encode(array_values($q['options'])) : null;
            $saveQuestionStmt->execute([
                $qid,
                $q['type'] ?? 'MCQ',
                $q['text'] ?? '',
                $optionsJson,
                $q['correctOptionIndex'] ?? null,
                (int)($q['marks'] ?? 1),
            ]);
            $linkQuestionStmt->execute([$id, $qid, $order]);
            $order++;
        }
        $saveQuestionStmt->closeCursor();
        $linkQuestionStmt->closeCursor();

        if (count($sections) > 0) {
            $saveSectionStmt = $pdo->prepare('INSERT INTO exam_sections
                (id, exam_id, title, display_order, question_limit, shuffle_questions, time_limit_minutes, lock_on_complete)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON DUPLICATE KEY UPDATE
                    title = VALUES(title),
                    display_order = VALUES(display_order),
                    question_limit = VALUES(question_limit),
                    shuffle_questions = VALUES(shuffle_questions),
                    time_limit_minutes = VALUES(time_limit_minutes),
                    lock_on_complete = VALUES(lock_on_complete)');
            $linkSectionQuestionStmt = $pdo->prepare('INSERT INTO exam_section_questions (section_id, question_id, display_order) VALUES (?, ?, ?)');

            foreach ($sections as $sectionIdx => $section) {
                $saveSectionStmt->execute([
                    $section['id'],
                    $id,
                    $section['title'],
                    $sectionIdx,
                    (int)$section['questionLimit'],
                    !empty($section['shuffleQuestions']) ? 1 : 0,
                    isset($section['timeLimitMinutes']) ? (int)$section['timeLimitMinutes'] : 0,
                    !empty($section['lockOnComplete']) ? 1 : 0,
                ]);

                $qOrder = 0;
                foreach ($section['questions'] as $q) {
                    $qid = $q['id'] ?? null;
                    if (!$qid) {
                        continue;
                    }
                    $linkSectionQuestionStmt->execute([$section['id'], $qid, $qOrder]);
                    $qOrder++;
                }
            }
            $saveSectionStmt->closeCursor();
            $linkSectionQuestionStmt->closeCursor();
        }

        foreach ($assignedBatchIds as $batchId) {
            $batchAssignStmt = $pdo->prepare('INSERT IGNORE INTO exam_batch_assignments (exam_id, batch_id) VALUES (?, ?)');
            $batchAssignStmt->execute([$id, $batchId]);
            $batchAssignStmt->closeCursor();
        }

        if (is_array($assignedIds)) {
            foreach ($assignedIds as $sid) {
                $assignStmt = $pdo->prepare('INSERT IGNORE INTO exam_assignments (exam_id, student_id) VALUES (?, ?)');
                $assignStmt->execute([$id, $sid]);
                $assignStmt->closeCursor();
            }
        }

        $pdo->commit();
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) {
            $pdo->rollBack();
        }
        throw $e;
    }

    audit_log($pdo, [
        'companyId' => $companyId,
        'actorRole' => 'ADMIN',
        'actorId' => $exam['actor'] ?? null,
        'action' => 'EXAM_SAVE',
        'targetType' => 'exam',
        'targetId' => $id,
        'message' => $title !== '' ? "Exam saved: {$title}" : 'Exam saved',
        'metadata' => [
            'status' => $status,
            'questionCount' => is_array($exam['questions'] ?? null) ? count($exam['questions']) : 0,
            'sectionCount' => count($sections),
            'assignedCount' => is_array($assignedIds) ? count($assignedIds) : 0,
            'assignedBatchCount' => count($assignedBatchIds),
        ]
    ]);

    $exam['id'] = $id;
    $exam['assignedStudentIds'] = is_array($assignedIds) ? array_values(array_unique($assignedIds)) : [];
    $exam['assignedBatchIds'] = $assignedBatchIds;
    $exam['attemptPolicy'] = 'LAST';
    $exam['passPercent'] = $passPercent;
    $exam['proctoringConfig'] = array_merge([
        'cameraRequired' => false,
        'microphoneRequired' => false,
        'fullScreenEnforced' => false,
        'tabSwitchLimit' => 3,
        'violationLimits' => normalize_violation_limits(null),
    ], is_array($proctor) ? $proctor : []);
    $exam['proctoringConfig']['violationLimits'] = $violationLimits;
    if (count($sections) > 0) {
        $exam['sections'] = $sections;
    }
    json_response(['exam' => $exam]);
}

json_response(['error' => 'Method not allowed.'], 405);
