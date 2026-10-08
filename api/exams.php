<?php
declare(strict_types=1);

require __DIR__ . '/_bootstrap.php';
require_once __DIR__ . '/exam_mail_render.php';

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

// Sustained-duration thresholds before the proctor flags gaze-away / talking. Configurable per
// exam (defaults to the workspace's Settings > Exam defaults, same as violationLimits) so an admin
// can loosen/tighten how many seconds of look-away or speech are tolerated before a violation fires.
function normalize_proctor_timing($raw): array {
    $defaults = [
        'gazeAwaySeconds' => 9,
        'audioSeconds' => 2,
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
        // Clamp to a sane range — too low would spam an honest student, too high defeats the point.
        $defaults[$key] = max(1, min(60, $num));
    }

    return $defaults;
}

function normalize_allowed_devices($raw): array {
    $all = ['desktop', 'tablet', 'mobile'];

    if (is_string($raw) && $raw !== '') {
        $decoded = json_decode($raw, true);
        if (is_array($decoded)) {
            $raw = $decoded;
        }
    }

    if (!is_array($raw) || count($raw) === 0) {
        return $all;
    }

    $filtered = array_values(array_intersect($all, array_map(static fn($v) => (string)$v, $raw)));
    // Never persist an empty allow-list — that would lock every candidate out.
    return count($filtered) > 0 ? $filtered : $all;
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

function ensure_exam_invitation_schema(PDO $pdo): void {
    $fresh = !db_table_exists($pdo, 'exam_invitations');
    $pdo->exec("CREATE TABLE IF NOT EXISTS exam_invitations (
      exam_id    VARCHAR(64) NOT NULL,
      student_id VARCHAR(64) NOT NULL,
      sent_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (exam_id, student_id),
      INDEX idx_exam_invitations_student (student_id)
    ) ENGINE=InnoDB");

    if ($fresh) {
        // Anyone already assigned when this table first appears has, by assumption, already been sent
        // their link. Seeding them keeps the first post-upgrade send from re-mailing candidates who
        // are already sitting a live exam — only students assigned from now on count as uninvited.
        $pdo->exec('INSERT IGNORE INTO exam_invitations (exam_id, student_id)
                    SELECT exam_id, student_id FROM exam_assignments');
    }
}

// Per-exam, per-kind overrides for the invitation / reminder email an admin composes in the Mail
// Composer. Kept in its own table rather than on `exams` so saving a template never has to run the
// full sp_upsert_exam path (which rewrites questions, sections and assignments).
function ensure_exam_mail_template_schema(PDO $pdo): void {
    $pdo->exec("CREATE TABLE IF NOT EXISTS exam_mail_templates (
      exam_id    VARCHAR(64) NOT NULL,
      kind       ENUM('INVITE','REMINDER') NOT NULL,
      subject    VARCHAR(255) NOT NULL DEFAULT '',
      message    TEXT NULL,
      options_json JSON NULL,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (exam_id, kind),
      CONSTRAINT fk_exam_mail_templates_exam
        FOREIGN KEY (exam_id) REFERENCES exams(id)
        ON DELETE CASCADE
    ) ENGINE=InnoDB");
    // Per-exam email design (header title, button text, accent colour, block switches, closing note)
    // from the exam editor's Emails section. NULL = the built-in design.
    db_add_column_if_missing($pdo, 'exam_mail_templates', 'options_json', 'JSON NULL AFTER message');
}

/**
 * Fresh check for options_json, made once per request AFTER ensure_exam_mail_template_schema(). Not
 * db_column_exists(): that caches the "missing" answer it gave db_add_column_if_missing(), so on the
 * request that added the column it would still say false.
 */
function exam_mail_options_ready(PDO $pdo): bool {
    static $ready = null;
    if ($ready !== null) {
        return $ready;
    }
    try {
        $stmt = $pdo->query("SHOW COLUMNS FROM exam_mail_templates LIKE 'options_json'");
        $ready = (bool)$stmt->fetch();
        $stmt->closeCursor();
    } catch (Throwable $e) {
        $ready = false;
    }
    return $ready;
}

/** Decode a stored options_json value into a normalised options array ([] when none / unreadable). */
function exam_mail_decode_options($raw): array {
    if ($raw === null || $raw === '') return [];
    $decoded = json_decode((string)$raw, true);
    if (!is_array($decoded)) return [];
    return exam_mail_normalize_options($decoded) ?? [];
}

/** Stored templates of one exam as the API shape: [kind => {subject, message, options}] (object when empty). */
function fetch_exam_mail_templates(PDO $pdo, string $examId) {
    $cols = exam_mail_options_ready($pdo) ? 'kind, subject, message, options_json' : 'kind, subject, message';
    $stmt = $pdo->prepare("SELECT {$cols} FROM exam_mail_templates WHERE exam_id = ?");
    $stmt->execute([$examId]);
    $out = [];
    foreach ($stmt->fetchAll() as $row) {
        $out[(string)$row['kind']] = exam_mail_template_payload($row);
    }
    $stmt->closeCursor();
    return $out ?: new stdClass();
}

/** One exam_mail_templates row → {subject, message, options}; options is always an object. */
function exam_mail_template_payload(array $row): array {
    $options = exam_mail_decode_options($row['options_json'] ?? null);
    return [
        'subject' => (string)($row['subject'] ?? ''),
        'message' => (string)($row['message'] ?? ''),
        'options' => $options ?: new stdClass(),
    ];
}

/**
 * Validate one posted template ({subject, message, options?}) into what gets stored. `options`
 * absent = keep the stored design ($hasOptions false). Returns null and sets $error when invalid.
 */
function exam_mail_validate_template($raw, ?string &$error = null): ?array {
    $error = null;
    $raw = is_object($raw) ? (array)$raw : $raw;
    if (!is_array($raw)) {
        $error = 'Each mail template must be an object.';
        return null;
    }
    foreach (['subject', 'message'] as $field) {
        if (array_key_exists($field, $raw) && $raw[$field] !== null && !is_string($raw[$field])) {
            $error = "{$field} must be text.";
            return null;
        }
    }
    $hasOptions = array_key_exists('options', $raw);
    $options = [];
    if ($hasOptions) {
        $options = exam_mail_normalize_options($raw['options'], $optionsError);
        if ($options === null) {
            $error = (string)$optionsError;
            return null;
        }
    }
    return [
        'subject' => mb_substr(trim((string)($raw['subject'] ?? '')), 0, EXAM_MAIL_LIMITS['subject']),
        'message' => mb_substr((string)($raw['message'] ?? ''), 0, EXAM_MAIL_LIMITS['message']),
        'hasOptions' => $hasOptions,
        'options' => $options,
    ];
}

/**
 * Upsert (or clear) one exam's template for one kind. An empty subject + message + design clears the
 * override, so the built-in email applies again; options not posted keep the stored design. Returns
 * the stored template payload, or null when the override was cleared.
 */
function save_exam_mail_template(PDO $pdo, string $examId, string $kind, array $tpl): ?array {
    $optionsReady = exam_mail_options_ready($pdo);
    $options = $tpl['options'];
    if (!$tpl['hasOptions'] && $optionsReady) {
        $curStmt = $pdo->prepare('SELECT options_json FROM exam_mail_templates WHERE exam_id = ? AND kind = ? LIMIT 1');
        $curStmt->execute([$examId, $kind]);
        $cur = $curStmt->fetch();
        $curStmt->closeCursor();
        $options = $cur ? exam_mail_decode_options($cur['options_json'] ?? null) : [];
    }

    if ($tpl['subject'] === '' && trim($tpl['message']) === '' && count($options) === 0) {
        $delStmt = $pdo->prepare('DELETE FROM exam_mail_templates WHERE exam_id = ? AND kind = ?');
        $delStmt->execute([$examId, $kind]);
        $delStmt->closeCursor();
        return null;
    }

    if ($optionsReady) {
        $optionsJson = count($options) > 0 ? json_encode($options, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) : null;
        $saveStmt = $pdo->prepare('INSERT INTO exam_mail_templates (exam_id, kind, subject, message, options_json)
                                   VALUES (?, ?, ?, ?, ?)
                                   ON DUPLICATE KEY UPDATE subject = VALUES(subject), message = VALUES(message), options_json = VALUES(options_json)');
        $saveStmt->execute([$examId, $kind, $tpl['subject'], $tpl['message'], $optionsJson]);
    } else {
        $saveStmt = $pdo->prepare('INSERT INTO exam_mail_templates (exam_id, kind, subject, message)
                                   VALUES (?, ?, ?, ?)
                                   ON DUPLICATE KEY UPDATE subject = VALUES(subject), message = VALUES(message)');
        $saveStmt->execute([$examId, $kind, $tpl['subject'], $tpl['message']]);
        $options = [];
    }
    $saveStmt->closeCursor();
    return ['subject' => $tpl['subject'], 'message' => $tpl['message'], 'options' => $options ?: new stdClass()];
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
            q.answer_key_json,
            q.match_options_json,
            q.marks,
            q.negative_marks,
            q.word_limit,
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

/**
 * Map a questions-table row to the API shape used by the frontend Question type.
 * Decodes all JSON columns (options, structured answer key, match/ordering/bucket data).
 */
function serialize_question_row(array $q): array {
    $decodeJson = static function ($raw) {
        if ($raw === null || $raw === '') return null;
        $decoded = json_decode((string)$raw, true);
        return $decoded === null && json_last_error() !== JSON_ERROR_NONE ? null : $decoded;
    };
    $options = $decodeJson($q['options_json'] ?? null);
    return [
        'id' => $q['id'],
        'text' => $q['text'],
        'type' => $q['type'],
        'options' => is_array($options) ? $options : null,
        'correctOptionIndex' => $q['correct_option_index'] !== null ? (int)$q['correct_option_index'] : null,
        'answerKey' => $decodeJson($q['answer_key_json'] ?? null),
        'matchOptions' => $decodeJson($q['match_options_json'] ?? null),
        'marks' => (int)$q['marks'],
        'negativeMarks' => isset($q['negative_marks']) ? (float)$q['negative_marks'] : 0,
        'wordLimit' => isset($q['word_limit']) && $q['word_limit'] !== null ? (int)$q['word_limit'] : null,
    ];
}

const EXAM_PROCTORING_MODES = ['PROCTORED', 'UNPROCTORED'];

/**
 * True once exams.proctoring_mode / show_violation_alerts / auto_terminate exist. Deliberately NOT
 * db_column_exists(): that caches a "missing" answer, so on the very request whose
 * ensure_exam_proctoring_mode_columns() call added the columns it would still say false and the save
 * would silently drop the switches.
 */
function exam_proctoring_mode_ready(PDO $pdo): bool {
    static $ready = null;
    if ($ready !== null) {
        return $ready;
    }
    try {
        $stmt = $pdo->query("SHOW COLUMNS FROM exams LIKE 'auto_terminate'");
        $ready = (bool)$stmt->fetch();
        $stmt->closeCursor();
    } catch (Throwable $e) {
        $ready = false;
    }
    return $ready;
}

/** Normalise a stored/posted proctoring mode; anything unrecognised reads as the safe default. */
function normalize_proctoring_mode($raw): string {
    $mode = strtoupper(trim((string)($raw ?? '')));
    return in_array($mode, EXAM_PROCTORING_MODES, true) ? $mode : 'PROCTORED';
}

/** Lenient boolean for JSON flags (true/false, 1/0, "true"/"false"); null/unparseable → $fallback. */
function exam_bool_flag($raw, bool $fallback): bool {
    if ($raw === null) return $fallback;
    if (is_bool($raw)) return $raw;
    $parsed = filter_var($raw, FILTER_VALIDATE_BOOLEAN, FILTER_NULL_ON_FAILURE);
    return $parsed ?? $fallback;
}

function question_bank_tables_ready(PDO $pdo): bool {
    static $ready = null;
    if ($ready === null) {
        $ready = db_table_exists($pdo, 'question_bank_items') && db_table_exists($pdo, 'question_banks');
    }
    return $ready;
}

/**
 * Question Bank membership for a set of question ids, in ONE query:
 * [questionId => ['bankId' => int, 'bankName' => string, 'companyId' => int]]. A question listed in
 * more than one bank reports the oldest bank.
 */
function fetch_question_bank_links(PDO $pdo, array $questionIds): array {
    $questionIds = array_values(array_unique(array_filter(array_map('strval', $questionIds), static fn($id) => $id !== '')));
    if (count($questionIds) === 0 || !question_bank_tables_ready($pdo)) {
        return [];
    }
    $ph = implode(',', array_fill(0, count($questionIds), '?'));
    $stmt = $pdo->prepare("SELECT qbi.question_id, qb.id AS bank_id, qb.name AS bank_name, qb.company_id
                           FROM question_bank_items qbi
                           JOIN question_banks qb ON qb.id = qbi.bank_id
                           WHERE qbi.question_id IN ($ph)
                           ORDER BY qb.id ASC");
    $stmt->execute($questionIds);
    $links = [];
    foreach ($stmt->fetchAll() as $r) {
        $qid = (string)$r['question_id'];
        if (isset($links[$qid])) continue;
        $links[$qid] = [
            'bankId' => (int)$r['bank_id'],
            'bankName' => (string)$r['bank_name'],
            'companyId' => (int)$r['company_id'],
        ];
    }
    $stmt->closeCursor();
    return $links;
}

/** Set (or clear) a serialized question's bankId/bankName from server-side bank membership. */
function apply_question_bank_link(array $q, array $links): array {
    $qid = (string)($q['id'] ?? '');
    if ($qid !== '' && isset($links[$qid])) {
        $q['bankId'] = $links[$qid]['bankId'];
        $q['bankName'] = $links[$qid]['bankName'];
    } else {
        unset($q['bankId'], $q['bankName']);
    }
    return $q;
}

function fetch_exam_section_questions_direct(PDO $pdo, string $sectionId): array {
    $stmt = $pdo->prepare('SELECT
            q.id,
            q.type,
            q.text,
            q.options_json,
            q.correct_option_index,
            q.answer_key_json,
            q.match_options_json,
            q.marks,
            q.negative_marks,
            q.word_limit,
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
ensure_exam_invitation_schema($pdo);
ensure_exam_mail_template_schema($pdo);
// Per-exam PROCTORED / UNPROCTORED mode plus the "show alerts" and "end on limit" switches.
ensure_exam_proctoring_mode_columns($pdo);
db_add_column_if_missing($pdo, 'exams', 'timezone', 'VARCHAR(64) NULL AFTER end_time');
db_add_column_if_missing($pdo, 'exams', 'proctor_timing_json', 'JSON NULL AFTER violation_limits_json');
// Certificate issuance is on-demand only (never automatic on pass) and gated per-exam by this
// flag, set on exam creation — see api/certificates.php's maybe_issue_certificate().
db_add_column_if_missing($pdo, 'exams', 'certificate_enabled', 'TINYINT(1) NOT NULL DEFAULT 0');
// Optional cap on the length of a descriptive (TEXT) answer. NULL = no limit, which is what every
// existing question keeps, so adding this changes nothing until an admin sets a value.
db_add_column_if_missing($pdo, 'questions', 'word_limit', 'INT NULL AFTER marks');

/**
 * @param bool $includeBankInfo Staff responses tag Question Bank questions with bankId/bankName (the
 *   editor shows them read-only). The candidate's token response leaves them out.
 */
function build_exam_response(array $row, PDO $pdo, int $companyId, bool $includeBankInfo = true): array {
    $examId = $row['id'];
    $violationLimitsRaw = db_column_exists($pdo, 'exams', 'violation_limits_json')
        ? ($row['violation_limits_json'] ?? null)
        : null;
    $proctorTimingRaw = db_column_exists($pdo, 'exams', 'proctor_timing_json')
        ? ($row['proctor_timing_json'] ?? null)
        : null;
    $allowedDevicesRaw = db_column_exists($pdo, 'exams', 'allowed_device_types_json')
        ? ($row['allowed_device_types_json'] ?? null)
        : null;
    // UNPROCTORED switches every check off. The save path already stores the monitoring columns as
    // off/0 for such an exam; forcing them here too keeps rows written by any other path consistent.
    $proctoringMode = normalize_proctoring_mode($row['proctoring_mode'] ?? 'PROCTORED');
    $unproctored = $proctoringMode === 'UNPROCTORED';
    $questions = fetch_exam_questions_direct($pdo, $examId);
    $assignments = fetch_exam_assignments_direct($pdo, $examId);
    $assignedIds = array_map(fn($a) => $a['student_id'], $assignments);
    $assignedBatchIds = fetch_assigned_batch_ids($pdo, $examId);
    $secRows = fetch_exam_sections_direct($pdo, $examId);
    $secQuestionRows = [];
    foreach ($secRows as $sec) {
        $secQuestionRows[(string)$sec['id']] = fetch_exam_section_questions_direct($pdo, (string)$sec['id']);
    }

    // One Question Bank lookup for the whole exam (exam-level and section questions together).
    $bankLinks = [];
    if ($includeBankInfo) {
        $allQuestionIds = array_map(static fn($q) => (string)$q['id'], $questions);
        foreach ($secQuestionRows as $rows) {
            foreach ($rows as $q) {
                $allQuestionIds[] = (string)$q['id'];
            }
        }
        $bankLinks = fetch_question_bank_links($pdo, $allQuestionIds);
    }
    $serialize = static function (array $q) use ($bankLinks): array {
        $mapped = serialize_question_row($q);
        return $bankLinks ? apply_question_bank_link($mapped, $bankLinks) : $mapped;
    };

    $mappedQuestions = array_map($serialize, $questions);
    $sections = [];
    foreach ($secRows as $sec) {
        $secId = $sec['id'];
        $mappedSecQuestions = array_map($serialize, $secQuestionRows[(string)$secId] ?? []);
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
    return [
        'id' => $examId,
        'title' => $row['title'],
        'durationMinutes' => (int)$row['duration_minutes'],
        'startTime' => datetime_to_ms($row['start_time']),
        'endTime' => datetime_to_ms($row['end_time']),
        'timezone' => isset($row['timezone']) && $row['timezone'] !== '' ? $row['timezone'] : null,
        'questions' => $mappedQuestions,
        'sections' => $sections,
        'questionCount' => $row['question_count'] !== null ? (int)$row['question_count'] : null,
        'shuffleQuestions' => (bool)$row['shuffle_questions'],
        'showResults' => (bool)$row['show_results'],
        'certificateEnabled' => (bool)($row['certificate_enabled'] ?? 0),
        'attemptPolicy' => $row['attempt_policy'] ?? 'LAST',
        'passPercent' => isset($row['pass_percent']) ? (int)$row['pass_percent'] : 60,
        'reconnectLimit' => isset($row['reconnect_limit']) ? (int)$row['reconnect_limit'] : 0,
        'totalMarks' => (int)$row['total_marks'],
        'status' => $row['status'],
        'allowedDeviceTypes' => normalize_allowed_devices($allowedDevicesRaw),
        'proctoringConfig' => [
            'mode' => $proctoringMode,
            'showAlerts' => (bool)($row['show_violation_alerts'] ?? 1),
            'autoTerminate' => (bool)($row['auto_terminate'] ?? 1),
            'cameraRequired' => !$unproctored && (bool)$row['camera_required'],
            'microphoneRequired' => !$unproctored && (bool)$row['microphone_required'],
            'fullScreenEnforced' => !$unproctored && (bool)$row['fullscreen_enforced'],
            'tabSwitchLimit' => $unproctored ? 0 : (int)$row['tab_switch_limit'],
            'violationLimits' => normalize_violation_limits($unproctored ? null : $violationLimitsRaw),
            'proctorTiming' => normalize_proctor_timing($proctorTimingRaw),
        ],
        'assignedStudentIds' => $assignedIds,
        'assignedBatchIds' => $assignedBatchIds,
        'pendingInviteCount' => 0,
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

if ($method === 'GET') {
    $examTokenClaims = current_exam_token_claims();

    if ($examTokenClaims !== null) {
        // Student access via signed exam link token — return ONLY the exam this token grants access to.
        $tokenExamId = (string)$examTokenClaims['eid'];
        $tokenCompanyId = (int)$examTokenClaims['cid'];
        $stmt = $pdo->prepare('SELECT * FROM exams WHERE id = ? AND company_id = ? LIMIT 1');
        $stmt->execute([$tokenExamId, $tokenCompanyId]);
        $row = $stmt->fetch();
        $stmt->closeCursor();
        if (!$row) {
            json_response(['error' => 'Exam not found.'], 404);
        }
        $studentExam = build_exam_response($row, $pdo, $tokenCompanyId, false);
        // The candidate's page never uses the roster, and handing every candidate the student ids of
        // everyone else assigned to the exam let them address classmates' attempts directly through
        // the (unauthenticated) session/violation endpoints, which are keyed on examId + studentId.
        $studentExam['assignedStudentIds'] = [];
        $studentExam['assignedBatchIds'] = [];
        json_response(['exams' => [$studentExam]]);
    }

    require_staff(); // admin-only read: blocks tokenless/forged-header access

    // Attempt status per student for one exam, keyed by student id. Used by the Mail Composer when an
    // exam has no explicit assignment list (it then goes to every student, resolved client-side) and
    // the enriched recipients payload below is therefore unavailable.
    $attemptsExamId = isset($_GET['attempts']) ? trim((string)$_GET['attempts']) : '';
    if ($attemptsExamId !== '') {
        if (get_actor_role() === 'SUPER_ADMIN') {
            $aExamStmt = $pdo->prepare('SELECT id FROM exams WHERE id = ? LIMIT 1');
            $aExamStmt->execute([$attemptsExamId]);
        } else {
            $aExamStmt = $pdo->prepare('SELECT id FROM exams WHERE id = ? AND company_id = ? LIMIT 1');
            $aExamStmt->execute([$attemptsExamId, require_company_id()]);
        }
        $aExamRow = $aExamStmt->fetch();
        $aExamStmt->closeCursor();
        if (!$aExamRow) {
            json_response(['error' => 'Exam not found.'], 404);
        }

        $aStmt = $pdo->prepare("SELECT student_id,
                                       COUNT(*) AS attempt_count,
                                       SUM(status = 'COMPLETED') AS completed_count,
                                       SUBSTRING_INDEX(GROUP_CONCAT(status ORDER BY start_time DESC), ',', 1) AS last_status,
                                       MAX(start_time) AS last_start
                                FROM exam_sessions
                                WHERE exam_id = ?
                                GROUP BY student_id");
        $aStmt->execute([$attemptsExamId]);
        $attempts = [];
        foreach ($aStmt->fetchAll() as $aRow) {
            $completed = (int)$aRow['completed_count'] > 0;
            $attempts[(string)$aRow['student_id']] = [
                'attemptCount' => (int)$aRow['attempt_count'],
                'attemptStatus' => $completed ? 'COMPLETED' : (string)($aRow['last_status'] ?? 'IN_PROGRESS'),
                'completed' => $completed,
                'lastAttemptAt' => $aRow['last_start'] ? datetime_to_ms($aRow['last_start']) : null,
            ];
        }
        $aStmt->closeCursor();

        json_response(['attempts' => (object)$attempts]);
    }

    // Recipient lookup for exam invitations. Returns every assigned student WITH its OWN company id
    // and contact details. A super admin may assign cross-company batches, so the client cannot rely
    // on its (single-company) local student list — and each invitation token must carry the student's
    // own companyId, not the sender's. Regular admins/proctors stay scoped to their own company.
    $recipientsExamId = isset($_GET['recipients']) ? trim((string)$_GET['recipients']) : '';
    if ($recipientsExamId !== '') {
        if (get_actor_role() === 'SUPER_ADMIN') {
            $examStmt = $pdo->prepare('SELECT id FROM exams WHERE id = ? LIMIT 1');
            $examStmt->execute([$recipientsExamId]);
        } else {
            $scopedCompanyId = require_company_id();
            $examStmt = $pdo->prepare('SELECT id FROM exams WHERE id = ? AND company_id = ? LIMIT 1');
            $examStmt->execute([$recipientsExamId, $scopedCompanyId]);
        }
        $examRow = $examStmt->fetch();
        $examStmt->closeCursor();
        if (!$examRow) {
            json_response(['error' => 'Exam not found.'], 404);
        }

        // exam_assignments is a snapshot that's normally only re-expanded from assigned batches when
        // the exam itself is saved (see the PUT handler below). An admin adding students to a batch
        // mid-exam shouldn't have to re-save (and risk disturbing) the running exam just to pick up
        // the new roster — so top up exam_assignments here, additively, before resolving recipients.
        // INSERT IGNORE only ever adds rows for students not yet assigned; it never deletes or touches
        // any other exam data, so it can't affect students already mid-attempt.
        $syncBatchIds = fetch_assigned_batch_ids($pdo, $recipientsExamId);
        if (count($syncBatchIds) > 0) {
            ensure_student_batches_schema($pdo);
            $syncPlaceholders = implode(',', array_fill(0, count($syncBatchIds), '?'));
            $syncStmt = $pdo->prepare("INSERT IGNORE INTO exam_assignments (exam_id, student_id)
                                       SELECT ?, student_id FROM student_batches WHERE batch_id IN ($syncPlaceholders)");
            $syncStmt->execute(array_merge([$recipientsExamId], $syncBatchIds));
            $syncStmt->closeCursor();
        }

        // invited_at is NULL for students assigned after the last invitation run — these are the only
        // ones a "new students only" send should reach, so the client can split the list without
        // guessing from batch membership.
        // The exam_sessions aggregate answers the other question the Mail Composer needs: who has
        // actually sat this exam. attempt_count = 0 means the student never opened it (the audience a
        // "not attempted" reminder targets); completed_count distinguishes a finished attempt from one
        // that was started and abandoned or terminated.
        $recStmt = $pdo->prepare("SELECT s.id, s.full_name, s.email, s.registration_id, s.company_id,
                                         ei.sent_at AS invited_at,
                                         COALESCE(att.attempt_count, 0)   AS attempt_count,
                                         COALESCE(att.completed_count, 0) AS completed_count,
                                         att.last_status,
                                         att.last_start
                                  FROM exam_assignments ea
                                  JOIN students s ON s.id = ea.student_id
                                  LEFT JOIN exam_invitations ei
                                    ON ei.exam_id = ea.exam_id AND ei.student_id = ea.student_id
                                  LEFT JOIN (
                                    SELECT student_id,
                                           COUNT(*) AS attempt_count,
                                           SUM(status = 'COMPLETED') AS completed_count,
                                           SUBSTRING_INDEX(GROUP_CONCAT(status ORDER BY start_time DESC), ',', 1) AS last_status,
                                           MAX(start_time) AS last_start
                                    FROM exam_sessions
                                    WHERE exam_id = ?
                                    GROUP BY student_id
                                  ) att ON att.student_id = ea.student_id
                                  WHERE ea.exam_id = ?
                                  ORDER BY s.company_id ASC, s.full_name ASC");
        $recStmt->execute([$recipientsExamId, $recipientsExamId]);
        $recRows = $recStmt->fetchAll();
        $recStmt->closeCursor();

        $recipients = array_map(static function (array $r): array {
            $attempts = (int)$r['attempt_count'];
            $completed = (int)$r['completed_count'] > 0;
            // A completed attempt always wins over a later abandoned/terminated one: once a candidate
            // has submitted, they are done regardless of what happened afterwards.
            $status = $attempts === 0
                ? 'NOT_STARTED'
                : ($completed ? 'COMPLETED' : (string)($r['last_status'] ?? 'IN_PROGRESS'));
            return [
                'id' => (string)$r['id'],
                'fullName' => (string)$r['full_name'],
                'email' => (string)$r['email'],
                'registrationId' => (string)$r['registration_id'],
                'companyId' => (int)$r['company_id'],
                'invitedAt' => $r['invited_at'] ? strtotime((string)$r['invited_at']) * 1000 : null,
                'attemptCount' => $attempts,
                'attemptStatus' => $status,
                'completed' => $completed,
                'lastAttemptAt' => $r['last_start'] ? datetime_to_ms($r['last_start']) : null,
            ];
        }, $recRows);

        json_response(['recipients' => $recipients]);
    }

    $companyId = require_company_id();
    $stmt = $pdo->prepare('SELECT * FROM exams WHERE company_id = ? ORDER BY updated_at DESC');
    $stmt->execute([$companyId]);
    $rows = $stmt->fetchAll();
    $stmt->closeCursor();

    // Students assigned to an exam but never sent a link, per exam — surfaced on the card so an admin
    // can see at a glance that an exam has candidates still waiting for their invitation.
    $pendingStmt = $pdo->prepare('SELECT ea.exam_id, COUNT(*) AS pending
                                  FROM exam_assignments ea
                                  JOIN exams e ON e.id = ea.exam_id
                                  LEFT JOIN exam_invitations ei
                                    ON ei.exam_id = ea.exam_id AND ei.student_id = ea.student_id
                                  WHERE e.company_id = ? AND ei.student_id IS NULL
                                  GROUP BY ea.exam_id');
    $pendingStmt->execute([$companyId]);
    $pendingInvites = [];
    foreach ($pendingStmt->fetchAll() as $pendingRow) {
        $pendingInvites[(string)$pendingRow['exam_id']] = (int)$pendingRow['pending'];
    }
    $pendingStmt->closeCursor();

    // Assigned students who have never opened the exam (no session row at all), per exam. This is the
    // audience the "not attempted" reminder targets, surfaced on the card so an admin can see who is
    // still outstanding without opening the composer.
    $notAttemptedStmt = $pdo->prepare('SELECT ea.exam_id, COUNT(*) AS pending
                                       FROM exam_assignments ea
                                       JOIN exams e ON e.id = ea.exam_id
                                       LEFT JOIN exam_sessions es
                                         ON es.exam_id = ea.exam_id AND es.student_id = ea.student_id
                                       WHERE e.company_id = ? AND es.id IS NULL
                                       GROUP BY ea.exam_id');
    $notAttemptedStmt->execute([$companyId]);
    $notAttempted = [];
    foreach ($notAttemptedStmt->fetchAll() as $naRow) {
        $notAttempted[(string)$naRow['exam_id']] = (int)$naRow['pending'];
    }
    $notAttemptedStmt->closeCursor();

    // Per-exam mail overrides (exam editor Emails section / Mail Composer): {subject, message, options}.
    // Absent kinds fall back to the built-in email on the client.
    $tplCols = exam_mail_options_ready($pdo) ? 't.exam_id, t.kind, t.subject, t.message, t.options_json' : 't.exam_id, t.kind, t.subject, t.message';
    $tplStmt = $pdo->prepare("SELECT {$tplCols}
                              FROM exam_mail_templates t
                              JOIN exams e ON e.id = t.exam_id
                              WHERE e.company_id = ?");
    $tplStmt->execute([$companyId]);
    $mailTemplates = [];
    foreach ($tplStmt->fetchAll() as $tplRow) {
        $mailTemplates[(string)$tplRow['exam_id']][(string)$tplRow['kind']] = exam_mail_template_payload($tplRow);
    }
    $tplStmt->closeCursor();

    $exams = [];
    foreach ($rows as $row) {
        $exam = build_exam_response($row, $pdo, $companyId);
        $exam['pendingInviteCount'] = $pendingInvites[(string)$exam['id']] ?? 0;
        $exam['notAttemptedCount'] = $notAttempted[(string)$exam['id']] ?? 0;
        $exam['mailTemplates'] = $mailTemplates[(string)$exam['id']] ?? new stdClass();
        $exams[] = $exam;
    }

    json_response(['exams' => $exams]);
}

if ($method === 'POST') {
    $payload = json_input();
    require_role(['ADMIN'], $payload);
    $companyId = require_company_id($payload);
    if (isset($payload['action'])) {
        $action = strtoupper(trim((string)$payload['action']));
        if ($action === 'SAVE_MAIL_TEMPLATE') {
            // Persist the subject/message (and, when posted, the design `options`) an admin set for
            // this exam so the next send (and the next admin) starts from it instead of the built-in
            // default. `options` absent keeps the stored design (the Mail Composer edits text only).
            // An empty subject, message AND design clears the override and restores the default.
            $examId = trim((string)($payload['examId'] ?? ''));
            $kind = strtoupper(trim((string)($payload['kind'] ?? '')));

            if ($examId === '' || !in_array($kind, ['INVITE', 'REMINDER'], true)) {
                json_response(['error' => 'examId and a valid kind (INVITE|REMINDER) are required.'], 400);
            }
            $tplInput = ['subject' => $payload['subject'] ?? '', 'message' => $payload['message'] ?? ''];
            if (array_key_exists('options', $payload)) {
                $tplInput['options'] = $payload['options'];
            }
            $tpl = exam_mail_validate_template($tplInput, $tplError);
            if ($tpl === null) {
                json_response(['error' => $tplError], 400);
            }

            if (get_actor_role($payload) === 'SUPER_ADMIN') {
                $ownStmt = $pdo->prepare('SELECT id FROM exams WHERE id = ? LIMIT 1');
                $ownStmt->execute([$examId]);
            } else {
                $ownStmt = $pdo->prepare('SELECT id FROM exams WHERE id = ? AND company_id = ? LIMIT 1');
                $ownStmt->execute([$examId, $companyId]);
            }
            $ownRow = $ownStmt->fetch();
            $ownStmt->closeCursor();
            if (!$ownRow) {
                json_response(['error' => 'Exam not found.'], 404);
            }

            $stored = save_exam_mail_template($pdo, $examId, $kind, $tpl);
            if ($stored === null) {
                json_response(['ok' => true, 'cleared' => true]);
            }
            json_response(['ok' => true, 'template' => ['kind' => $kind] + $stored]);
        }

        if ($action === 'MARK_INVITED') {
            // Recorded after invitation emails actually go out, so a later send can target only the
            // students added since. Idempotent: an existing row keeps its original sent_at.
            $examId = trim((string)($payload['examId'] ?? ''));
            $studentIds = array_values(array_filter(array_map(
                static fn($v) => trim((string)$v),
                is_array($payload['studentIds'] ?? null) ? $payload['studentIds'] : []
            ), static fn(string $v) => $v !== ''));

            if ($examId === '' || count($studentIds) === 0) {
                json_response(['error' => 'examId and studentIds are required.'], 400);
            }

            if (get_actor_role($payload) === 'SUPER_ADMIN') {
                $ownStmt = $pdo->prepare('SELECT id FROM exams WHERE id = ? LIMIT 1');
                $ownStmt->execute([$examId]);
            } else {
                $ownStmt = $pdo->prepare('SELECT id FROM exams WHERE id = ? AND company_id = ? LIMIT 1');
                $ownStmt->execute([$examId, $companyId]);
            }
            $ownRow = $ownStmt->fetch();
            $ownStmt->closeCursor();
            if (!$ownRow) {
                json_response(['error' => 'Exam not found.'], 404);
            }

            $markStmt = $pdo->prepare('INSERT IGNORE INTO exam_invitations (exam_id, student_id) VALUES (?, ?)');
            foreach ($studentIds as $sid) {
                $markStmt->execute([$examId, $sid]);
            }
            $markStmt->closeCursor();

            json_response(['ok' => true, 'marked' => count($studentIds)]);
        }

        if ($action === 'MINT_ACCESS_TOKENS') {
            // Server-side minting of SIGNED exam-access tokens (the ?token=... links). Signing must
            // happen here — the browser has no SESSION_SECRET — so a candidate can't tamper with a
            // token to impersonate another student or open an unassigned exam. Each token binds
            // (examId, studentId, companyId) with an HMAC the server later verifies at exam start.
            $examId = trim((string)($payload['examId'] ?? ''));
            $studentIds = array_values(array_unique(array_filter(array_map(
                static fn($v) => trim((string)$v),
                is_array($payload['studentIds'] ?? null) ? $payload['studentIds'] : []
            ), static fn(string $v) => $v !== '')));

            if ($examId === '' || count($studentIds) === 0) {
                json_response(['error' => 'examId and studentIds are required.'], 400);
            }

            $isSuper = get_actor_role($payload) === 'SUPER_ADMIN';
            if ($isSuper) {
                $ownStmt = $pdo->prepare('SELECT id FROM exams WHERE id = ? LIMIT 1');
                $ownStmt->execute([$examId]);
            } else {
                $ownStmt = $pdo->prepare('SELECT id FROM exams WHERE id = ? AND company_id = ? LIMIT 1');
                $ownStmt->execute([$examId, $companyId]);
            }
            $ownRow = $ownStmt->fetch();
            $ownStmt->closeCursor();
            if (!$ownRow) {
                json_response(['error' => 'Exam not found.'], 404);
            }

            // Resolve each student's OWN company (a super admin may invite cross-company students) and
            // only mint for students the caller is actually allowed to see.
            $ph = implode(',', array_fill(0, count($studentIds), '?'));
            if ($isSuper) {
                $sStmt = $pdo->prepare("SELECT id, company_id FROM students WHERE id IN ($ph)");
                $sStmt->execute($studentIds);
            } else {
                $sStmt = $pdo->prepare("SELECT id, company_id FROM students WHERE id IN ($ph) AND company_id = ?");
                $sStmt->execute(array_merge($studentIds, [$companyId]));
            }
            $sRows = $sStmt->fetchAll();
            $sStmt->closeCursor();

            $tokens = [];
            $studentCompanies = [];
            foreach ($sRows as $r) {
                $sid = (string)$r['id'];
                $tokens[$sid] = mint_exam_access_token((string)$examId, $sid, (int)$r['company_id']);
                $studentCompanies[$sid] = (int)$r['company_id'];
            }
            // Short-link codes ("<origin>/x/<code>") for the same (exam, student, company) — get-or-
            // create, so a resend or a Links CSV reuses each student's existing code. A student with no
            // code (allocation failed) is just absent from `codes`; the client then uses the token link.
            $codes = [];
            try {
                $codes = exam_short_codes($pdo, (string)$examId, $studentCompanies);
            } catch (Throwable $e) {
                error_log('[exams] short link allocation failed: ' . $e->getMessage());
            }
            json_response(['tokens' => $tokens, 'codes' => (object)$codes]);
        }
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
                    'actorId' => get_actor_id($payload),
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
                'actorId' => get_actor_id($payload),
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
    $timezone = isset($exam['timezone']) && is_string($exam['timezone']) && trim($exam['timezone']) !== ''
        ? trim($exam['timezone'])
        : null;
    $sectionsInput = $exam['sections'] ?? [];
    $proctor = is_array($exam['proctoringConfig'] ?? null) ? $exam['proctoringConfig'] : [];
    $violationLimits = normalize_violation_limits($proctor['violationLimits'] ?? null);
    $proctorTiming = normalize_proctor_timing($proctor['proctorTiming'] ?? null);
    $allowedDevices = normalize_allowed_devices($exam['allowedDeviceTypes'] ?? null);
    $notif = $exam['notificationConfig'] ?? [];

    // Proctoring mode + candidate-facing switches. A field the client did not send keeps the exam's
    // stored value (new exams: PROCTORED / alerts on / end on limit), so an older cached editor that
    // knows nothing about these fields can't silently flip an UNPROCTORED exam back to proctored.
    if (array_key_exists('mode', $proctor) && $proctor['mode'] !== null) {
        $modeRaw = strtoupper(trim(is_scalar($proctor['mode']) ? (string)$proctor['mode'] : ''));
        if (!in_array($modeRaw, EXAM_PROCTORING_MODES, true)) {
            json_response(['error' => 'proctoringConfig.mode must be PROCTORED or UNPROCTORED.'], 400);
        }
    }
    $storedModeRow = null;
    if (exam_proctoring_mode_ready($pdo)
        && (!isset($proctor['mode']) || !array_key_exists('showAlerts', $proctor) || !array_key_exists('autoTerminate', $proctor))) {
        $storedStmt = $pdo->prepare('SELECT proctoring_mode, show_violation_alerts, auto_terminate FROM exams WHERE id = ? AND company_id = ? LIMIT 1');
        $storedStmt->execute([(string)$id, $companyId]);
        $storedModeRow = $storedStmt->fetch() ?: null;
        $storedStmt->closeCursor();
    }
    $proctoringMode = normalize_proctoring_mode($proctor['mode'] ?? ($storedModeRow['proctoring_mode'] ?? 'PROCTORED'));
    $showAlerts = exam_bool_flag($proctor['showAlerts'] ?? null, $storedModeRow ? (bool)$storedModeRow['show_violation_alerts'] : true);
    $autoTerminate = exam_bool_flag($proctor['autoTerminate'] ?? null, $storedModeRow ? (bool)$storedModeRow['auto_terminate'] : true);
    $unproctored = $proctoringMode === 'UNPROCTORED';
    if ($unproctored) {
        // No monitoring at all: store the monitoring columns as off so every consumer (emails,
        // monitoring wall, recordings, the candidate page) sees the same thing without having to
        // know about the mode column.
        $violationLimits = normalize_violation_limits(null);
    }

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
        'cameraRequired' => !$unproctored && !empty($proctor['cameraRequired']) ? 1 : 0,
        'microphoneRequired' => !$unproctored && !empty($proctor['microphoneRequired']) ? 1 : 0,
        'fullscreenEnforced' => !$unproctored && !empty($proctor['fullScreenEnforced']) ? 1 : 0,
        'tabSwitchLimit' => $unproctored ? 0 : (int)($proctor['tabSwitchLimit'] ?? 3),
        'violationLimits' => json_encode($violationLimits),
        'proctorTiming' => json_encode($proctorTiming),
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

    $assignedBatchIds = array_values(array_filter(array_map('intval', $exam['assignedBatchIds'] ?? []), static fn($value) => $value > 0));

    // Company-scope enforcement: only a SUPER_ADMIN may assign batches from other companies.
    // A regular admin is confined to batches owned by the exam's company. Without this, exporting an
    // exam from company A and importing it into company B (which carries A's assignedBatchIds) — or a
    // hand-crafted request — would enroll company A's students into company B's exam, a cross-company
    // data leak. Drop any out-of-company batch IDs so they are neither expanded nor persisted.
    if (count($assignedBatchIds) > 0 && get_actor_role($payload) !== 'SUPER_ADMIN') {
        $batchPlaceholders = implode(',', array_fill(0, count($assignedBatchIds), '?'));
        $ownBatchStmt = $pdo->prepare("SELECT id FROM batches WHERE id IN ($batchPlaceholders) AND company_id = ?");
        $ownBatchStmt->execute(array_merge($assignedBatchIds, [$companyId]));
        $ownBatchIds = array_map(static fn($row) => (int)$row['id'], $ownBatchStmt->fetchAll());
        $ownBatchStmt->closeCursor();
        $assignedBatchIds = array_values(array_intersect($assignedBatchIds, $ownBatchIds));
    }

    // Explicitly picked students are kept ALONGSIDE the batch expansion, not replaced by it — otherwise
    // a student added individually to a batch-assigned exam would be dropped on the next save.
    $explicitIds = is_array($exam['assignedStudentIds'] ?? null)
        ? array_values(array_filter(array_map(static fn($v) => trim((string)$v), $exam['assignedStudentIds']), static fn(string $v) => $v !== ''))
        : [];

    // Same company-scope enforcement as batches: a regular admin may only assign students from the
    // exam's own company. Only a SUPER_ADMIN may pick students cross-company. Drop any out-of-company
    // IDs before they are enrolled so a crafted request can't attach another company's students.
    if (count($explicitIds) > 0 && get_actor_role($payload) !== 'SUPER_ADMIN') {
        $studentPlaceholders = implode(',', array_fill(0, count($explicitIds), '?'));
        $ownStudentStmt = $pdo->prepare("SELECT id FROM students WHERE id IN ($studentPlaceholders) AND company_id = ?");
        $ownStudentStmt->execute(array_merge($explicitIds, [$companyId]));
        $ownStudentIds = array_map(static fn($row) => (string)$row['id'], $ownStudentStmt->fetchAll());
        $ownStudentStmt->closeCursor();
        $explicitIds = array_values(array_intersect($explicitIds, $ownStudentIds));
    }

    $assignedIds = $explicitIds;

    if (count($assignedBatchIds) > 0) {
        // Batch IDs are globally unique (single AUTO_INCREMENT PK across all companies), so we expand
        // by batch_id alone rather than pinning to the exam's company. This lets a SUPER_ADMIN assign
        // batches from any company to an exam and have every student in those batches enrolled.
        // Re-expanding on every save also picks up students newly added to an already-assigned batch.
        // A student enrolled in more than one assigned batch is naturally deduped below.
        ensure_student_batches_schema($pdo);
        $assignedIds = array_merge($assignedIds, expand_batch_ids_to_student_ids($pdo, $assignedBatchIds));
    }

    $assignedIds = array_values(array_unique($assignedIds));

    // Question Bank questions are shared by every exam that uses them and are edited only in the
    // Question Bank tab. The exam save LINKS them (exam_questions / exam_section_questions) but never
    // rewrites their text, options or answer key, whatever the client sent for them.
    $questionIdList = array_values(array_map('strval', array_keys($questionMap)));
    $bankOwnedIds = question_bank_owned_ids($pdo, $questionIdList);
    $bankOwnedSet = array_fill_keys($bankOwnedIds, true);

    // Exam, question and section ids are global primary keys and the save below is an upsert. For a
    // regular admin, refuse ids that already belong to ANOTHER company: otherwise a crafted save
    // reusing another company's exam id would move that exam into this company (company_id =
    // VALUES(company_id)) and wipe its questions/sections/assignments, and a reused question or
    // section id would silently rewrite the other company's question text and answer key. The
    // editor, duplicate and import flows always mint fresh ids, so legitimate saves never hit this.
    if (get_actor_role($payload) !== 'SUPER_ADMIN') {
        $foreignStmt = $pdo->prepare('SELECT 1 FROM exams WHERE id = ? AND company_id <> ? LIMIT 1');
        $foreignStmt->execute([$id, $companyId]);
        $foreignExam = (bool)$foreignStmt->fetchColumn();
        $foreignStmt->closeCursor();

        // Bank questions are never rewritten here, so what matters for them is whose bank they sit
        // in — not which exams link them (a super admin may have linked one into another company's
        // exam, which must not lock its own company out of its bank). Every other question keeps the
        // "already used by another company's exam" check.
        $plainQuestionIds = array_values(array_filter($questionIdList, static fn(string $qid) => !isset($bankOwnedSet[$qid])));

        $foreignChild = false;
        if (!$foreignExam && count($plainQuestionIds) > 0) {
            $qPh = implode(',', array_fill(0, count($plainQuestionIds), '?'));
            $fqStmt = $pdo->prepare("SELECT 1 FROM exam_questions eq
                                     JOIN exams e ON e.id = eq.exam_id
                                     WHERE eq.question_id IN ($qPh) AND e.company_id <> ?
                                     LIMIT 1");
            $fqStmt->execute(array_merge($plainQuestionIds, [$companyId]));
            $foreignChild = (bool)$fqStmt->fetchColumn();
            $fqStmt->closeCursor();
        }

        if (!$foreignExam && count($bankOwnedIds) > 0) {
            $bPh = implode(',', array_fill(0, count($bankOwnedIds), '?'));
            $fbStmt = $pdo->prepare("SELECT 1 FROM question_bank_items qbi
                                     JOIN question_banks qb ON qb.id = qbi.bank_id
                                     WHERE qbi.question_id IN ($bPh) AND qb.company_id <> ?
                                     LIMIT 1");
            $fbStmt->execute(array_merge($bankOwnedIds, [$companyId]));
            $foreignBank = (bool)$fbStmt->fetchColumn();
            $fbStmt->closeCursor();
            if ($foreignBank) {
                json_response(['error' => 'One or more questions belong to another company\'s question bank and cannot be used in this exam.'], 409);
            }
        }
        $sectionIdList = array_values(array_map(static fn($s) => (string)$s['id'], $sections));
        if (!$foreignExam && !$foreignChild && count($sectionIdList) > 0) {
            $sPh = implode(',', array_fill(0, count($sectionIdList), '?'));
            $fsStmt = $pdo->prepare("SELECT 1 FROM exam_sections es
                                     JOIN exams e ON e.id = es.exam_id
                                     WHERE es.id IN ($sPh) AND e.company_id <> ?
                                     LIMIT 1");
            $fsStmt->execute(array_merge($sectionIdList, [$companyId]));
            $foreignChild = (bool)$fsStmt->fetchColumn();
            $fsStmt->closeCursor();
        }
        if ($foreignExam || $foreignChild) {
            json_response(['error' => 'This exam (or one of its questions/sections) belongs to another company and cannot be saved here.'], 409);
        }
    }

    // Per-exam emails edited in the exam editor's Emails section, saved with the exam (so a brand-new
    // exam's emails can be set before its first save). Only kinds present in the payload are touched;
    // an empty kind ({subject:'', message:'', options:{}}) clears that override. Validated up front so
    // a bad colour rejects the whole save before anything is written.
    $mailTemplatesInput = [];
    if (array_key_exists('mailTemplates', $exam) && $exam['mailTemplates'] !== null) {
        $rawTemplates = is_object($exam['mailTemplates']) ? (array)$exam['mailTemplates'] : $exam['mailTemplates'];
        if (!is_array($rawTemplates) || ($rawTemplates !== [] && array_is_list($rawTemplates))) {
            json_response(['error' => 'mailTemplates must be an object keyed by INVITE / REMINDER.'], 400);
        }
        foreach (['INVITE', 'REMINDER'] as $mailKind) {
            if (!array_key_exists($mailKind, $rawTemplates) || $rawTemplates[$mailKind] === null) continue;
            $validated = exam_mail_validate_template($rawTemplates[$mailKind], $tplError);
            if ($validated === null) {
                json_response(['error' => "mailTemplates.{$mailKind}: {$tplError}"], 400);
            }
            $mailTemplatesInput[$mailKind] = $validated;
        }
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

        if (db_column_exists($pdo, 'exams', 'proctor_timing_json')) {
            $timingUpdate = $pdo->prepare('UPDATE exams SET proctor_timing_json = ? WHERE id = ? AND company_id = ?');
            $timingUpdate->execute([$saveArgs['proctorTiming'], $id, $companyId]);
            $timingUpdate->closeCursor();
        }

        if (db_column_exists($pdo, 'exams', 'timezone')) {
            $tzUpdate = $pdo->prepare('UPDATE exams SET timezone = ? WHERE id = ? AND company_id = ?');
            $tzUpdate->execute([$timezone, $id, $companyId]);
            $tzUpdate->closeCursor();
        }

        if (db_column_exists($pdo, 'exams', 'allowed_device_types_json')) {
            $deviceUpdate = $pdo->prepare('UPDATE exams SET allowed_device_types_json = ? WHERE id = ? AND company_id = ?');
            $deviceUpdate->execute([json_encode($allowedDevices), $id, $companyId]);
            $deviceUpdate->closeCursor();
        }

        if (db_column_exists($pdo, 'exams', 'certificate_enabled')) {
            $certUpdate = $pdo->prepare('UPDATE exams SET certificate_enabled = ? WHERE id = ? AND company_id = ?');
            $certUpdate->execute([!empty($exam['certificateEnabled']) ? 1 : 0, $id, $companyId]);
            $certUpdate->closeCursor();
        }

        if (exam_proctoring_mode_ready($pdo)) {
            $modeUpdate = $pdo->prepare('UPDATE exams SET proctoring_mode = ?, show_violation_alerts = ?, auto_terminate = ? WHERE id = ? AND company_id = ?');
            $modeUpdate->execute([$proctoringMode, $showAlerts ? 1 : 0, $autoTerminate ? 1 : 0, $id, $companyId]);
            $modeUpdate->closeCursor();
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

        $saveQuestionStmt = $pdo->prepare('INSERT INTO questions (id, type, text, options_json, correct_option_index, answer_key_json, match_options_json, marks, negative_marks, word_limit)
                                           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                                           ON DUPLICATE KEY UPDATE
                                             type = VALUES(type),
                                             text = VALUES(text),
                                             options_json = VALUES(options_json),
                                             correct_option_index = VALUES(correct_option_index),
                                             answer_key_json = VALUES(answer_key_json),
                                             match_options_json = VALUES(match_options_json),
                                             marks = VALUES(marks),
                                             negative_marks = VALUES(negative_marks),
                                             word_limit = VALUES(word_limit)');
        $linkQuestionStmt = $pdo->prepare('INSERT INTO exam_questions (exam_id, question_id, display_order) VALUES (?, ?, ?)');

        $order = 0;
        foreach ($questionMap as $qid => $q) {
            if (isset($bankOwnedSet[(string)$qid])) {
                // Question Bank question: link only, never overwrite the bank's copy.
                $linkQuestionStmt->execute([$id, $qid, $order]);
                $order++;
                continue;
            }
            $qType = strtoupper((string)($q['type'] ?? 'MCQ'));
            $optionsJson = isset($q['options']) && is_array($q['options']) ? json_encode(array_values($q['options'])) : null;
            $answerKeyJson = isset($q['answerKey']) && is_array($q['answerKey']) ? json_encode($q['answerKey']) : null;
            $matchOptionsJson = isset($q['matchOptions']) && is_array($q['matchOptions']) ? json_encode($q['matchOptions']) : null;
            // A word limit only means anything on a descriptive (manual) answer, and only when it is a
            // positive number. Anything else (blank, 0, junk, or an objective type) stores NULL = no limit.
            $wordLimit = null;
            if (is_manual_question_type($qType) && isset($q['wordLimit']) && $q['wordLimit'] !== '' && $q['wordLimit'] !== null) {
                $parsed = (int)$q['wordLimit'];
                $wordLimit = $parsed > 0 ? $parsed : null;
            }
            $saveQuestionStmt->execute([
                $qid,
                $q['type'] ?? 'MCQ',
                $q['text'] ?? '',
                $optionsJson,
                isset($q['correctOptionIndex']) && $q['correctOptionIndex'] !== '' ? $q['correctOptionIndex'] : null,
                $answerKeyJson,
                $matchOptionsJson,
                (int)($q['marks'] ?? 1),
                max(0.0, (float)($q['negativeMarks'] ?? 0)),
                $wordLimit,
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

        foreach ($mailTemplatesInput as $mailKind => $mailTemplate) {
            save_exam_mail_template($pdo, (string)$id, $mailKind, $mailTemplate);
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
        'actorId' => get_actor_id($payload) ?? ($exam['actor'] ?? null),
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
            'proctoringMode' => $proctoringMode,
            'bankQuestionCount' => count($bankOwnedIds),
            'mailTemplateKinds' => array_keys($mailTemplatesInput),
        ]
    ]);

    $exam['id'] = $id;
    // Echo the templates as stored (normalised, cleared kinds gone), not whatever the client sent.
    $exam['mailTemplates'] = fetch_exam_mail_templates($pdo, (string)$id);
    $exam['assignedStudentIds'] = is_array($assignedIds) ? array_values(array_unique($assignedIds)) : [];
    $exam['assignedBatchIds'] = $assignedBatchIds;
    $exam['allowedDeviceTypes'] = $allowedDevices;
    $exam['attemptPolicy'] = 'LAST';
    $exam['passPercent'] = $passPercent;
    $exam['proctoringConfig'] = array_merge([
        'cameraRequired' => false,
        'microphoneRequired' => false,
        'fullScreenEnforced' => false,
        'tabSwitchLimit' => 3,
        'violationLimits' => normalize_violation_limits(null),
        'proctorTiming' => normalize_proctor_timing(null),
    ], is_array($proctor) ? $proctor : []);
    $exam['proctoringConfig']['violationLimits'] = $violationLimits;
    $exam['proctoringConfig']['proctorTiming'] = $proctorTiming;
    // Echo what was actually stored (an UNPROCTORED exam has every monitoring switch off).
    $exam['proctoringConfig']['mode'] = $proctoringMode;
    $exam['proctoringConfig']['showAlerts'] = $showAlerts;
    $exam['proctoringConfig']['autoTerminate'] = $autoTerminate;
    $exam['proctoringConfig']['cameraRequired'] = (bool)$saveArgs['cameraRequired'];
    $exam['proctoringConfig']['microphoneRequired'] = (bool)$saveArgs['microphoneRequired'];
    $exam['proctoringConfig']['fullScreenEnforced'] = (bool)$saveArgs['fullscreenEnforced'];
    $exam['proctoringConfig']['tabSwitchLimit'] = (int)$saveArgs['tabSwitchLimit'];
    if (count($sections) > 0) {
        $exam['sections'] = $sections;
    }
    // bankId/bankName in the echo reflect real bank membership, not whatever the client claimed.
    $bankLinks = fetch_question_bank_links($pdo, $bankOwnedIds);
    if (is_array($exam['questions'] ?? null)) {
        $exam['questions'] = array_map(
            static fn($q) => is_array($q) ? apply_question_bank_link($q, $bankLinks) : $q,
            $exam['questions']
        );
    }
    if (is_array($exam['sections'] ?? null)) {
        foreach ($exam['sections'] as $sIdx => $section) {
            if (is_array($section) && is_array($section['questions'] ?? null)) {
                $exam['sections'][$sIdx]['questions'] = array_map(
                    static fn($q) => is_array($q) ? apply_question_bank_link($q, $bankLinks) : $q,
                    $section['questions']
                );
            }
        }
    }
    json_response(['exam' => $exam]);
}

json_response(['error' => 'Method not allowed.'], 405);
