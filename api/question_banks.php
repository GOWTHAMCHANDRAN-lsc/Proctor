<?php
declare(strict_types=1);

/**
 * Question banks: reusable, company-owned collections of questions (Question Bank tab).
 *
 * Bank questions are ordinary rows in the shared `questions` table, linked to a bank through
 * question_bank_items and into any number of exams through exam_questions — so an exam never copies a
 * bank question, and editing it here changes it in every exam that uses it. Schema:
 * ensure_question_bank_schema() in _bootstrap.php.
 *
 *   GET                                   → {banks: QuestionBank[]}
 *   GET  ?id=<bankId>                     → {bank: QuestionBankDetail}
 *   POST {action:'CREATE_BANK', name, description?}                → {bank}
 *   POST {action:'UPDATE_BANK', id, name?, description?}           → {bank}
 *   POST {action:'DELETE_BANK', id}                                → {ok, deletedQuestions, keptQuestions}
 *   POST {action:'ADD_QUESTIONS', bankId, questions: Question[]}   → {bank, added, errors[{index, message}]}
 *   POST {action:'UPDATE_QUESTION', bankId, question}              → {question}
 *   POST {action:'DELETE_QUESTION', bankId, questionId}            → {ok, keptForExams}
 *
 * ADMIN / SUPER_ADMIN only; every bank is scoped to require_company_id() (a SUPER_ADMIN acts on the
 * company picked in the top-bar switcher, sent as X-Company-Id). A bank outside that company is a 404.
 */

require __DIR__ . '/_bootstrap.php';

const QB_MAX_ADD = 2000;          // questions per ADD_QUESTIONS call
const QB_NAME_MAX = 255;          // question_banks.name is VARCHAR(255)
const QB_DESCRIPTION_MAX = 2000;
const QB_TEXT_MAX = 10000;        // questions.text is TEXT (64 KB); 10k chars of utf8mb4 always fits
const QB_OPTION_MAX = 1000;       // one option / blank alternate / match cell
const QB_MAX_OPTIONS = 20;        // MCQ / MULTI_SELECT choices
const QB_MAX_ITEMS = 50;          // MATCHING rows, ORDERING / DRAG_DROP items and buckets
const QB_MAX_BLANKS = 20;         // FILL_BLANK blanks
const QB_MAX_ALTERNATES = 50;     // accepted answers per blank
const QB_MARKS_MAX = 1000;
const QB_NEGATIVE_MAX = 1000;
const QB_WORD_LIMIT_MAX = 100000;
const QB_SQL_CHUNK = 250;         // rows per multi-row INSERT / IN() list

const QB_TYPES = [
    'MCQ', 'MULTI_SELECT', 'TRUE_FALSE', 'YES_NO', 'SHORT_TEXT', 'LONG_TEXT', 'TEXT',
    'FILL_BLANK', 'NUMERIC', 'DATE', 'TIME', 'MATCHING', 'ORDERING', 'DRAG_DROP',
];

function qb_ms(?string $dt): int {
    if ($dt === null || $dt === '') {
        return 0;
    }
    $ts = strtotime($dt);
    return $ts === false ? 0 : $ts * 1000;
}

function qb_strlen(string $value): int {
    return function_exists('mb_strlen') ? mb_strlen($value, 'UTF-8') : strlen($value);
}

/** Server-minted question id. Client ids are never trusted (a reused id would overwrite another row). */
function qb_new_question_id(): string {
    return 'qb' . bin2hex(random_bytes(8));
}

/**
 * Same API shape as serialize_question_row() in api/exams.php (kept field-for-field identical so the
 * exam editor and this tab read one Question format), plus the bank fields.
 */
function qb_serialize_question_row(array $q, int $bankId, string $bankName, int $examCount): array {
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
        'bankId' => $bankId,
        'bankName' => $bankName,
        'examCount' => $examCount,
    ];
}

function qb_serialize_bank(array $row, int $questionCount, int $examCount): array {
    return [
        'id' => (int)$row['id'],
        'companyId' => (int)$row['company_id'],
        'name' => (string)$row['name'],
        'description' => $row['description'] !== null && $row['description'] !== '' ? (string)$row['description'] : null,
        'questionCount' => $questionCount,
        'examCount' => $examCount,
        'createdBy' => $row['created_by'] ?? null,
        'createdAt' => qb_ms($row['created_at'] ?? null),
        'updatedAt' => qb_ms($row['updated_at'] ?? null),
    ];
}

/** The bank row if it belongs to $companyId, else null. */
function qb_find_bank(PDO $pdo, int $bankId, int $companyId, bool $forUpdate = false): ?array {
    if ($bankId <= 0) {
        return null;
    }
    $sql = 'SELECT id, company_id, name, description, created_by, created_at, updated_at
            FROM question_banks WHERE id = ? AND company_id = ?' . ($forUpdate ? ' FOR UPDATE' : '');
    $stmt = $pdo->prepare($sql);
    $stmt->execute([$bankId, $companyId]);
    $row = $stmt->fetch();
    $stmt->closeCursor();
    return $row ?: null;
}

function qb_require_bank(PDO $pdo, int $bankId, int $companyId): array {
    $bank = qb_find_bank($pdo, $bankId, $companyId);
    if ($bank === null) {
        json_response(['error' => 'Question bank not found.'], 404);
    }
    return $bank;
}

/** question_id => number of distinct exams linking it (directly or through an exam section). */
function qb_question_exam_counts(PDO $pdo, int $bankId): array {
    $stmt = $pdo->prepare('SELECT u.question_id, COUNT(DISTINCT u.exam_id) AS exam_count FROM (
            SELECT eq.question_id, eq.exam_id
              FROM question_bank_items i
              JOIN exam_questions eq ON eq.question_id = i.question_id
             WHERE i.bank_id = ?
            UNION
            SELECT esq.question_id, es.exam_id
              FROM question_bank_items i
              JOIN exam_section_questions esq ON esq.question_id = i.question_id
              JOIN exam_sections es ON es.id = esq.section_id
             WHERE i.bank_id = ?
        ) u GROUP BY u.question_id');
    $stmt->execute([$bankId, $bankId]);
    $out = [];
    foreach ($stmt->fetchAll() as $r) {
        $out[(string)$r['question_id']] = (int)$r['exam_count'];
    }
    $stmt->closeCursor();
    return $out;
}

/** Distinct exams that link at least one question of the bank. */
function qb_bank_exam_count(PDO $pdo, int $bankId): int {
    $stmt = $pdo->prepare('SELECT COUNT(DISTINCT u.exam_id) AS exam_count FROM (
            SELECT eq.exam_id
              FROM question_bank_items i
              JOIN exam_questions eq ON eq.question_id = i.question_id
             WHERE i.bank_id = ?
            UNION
            SELECT es.exam_id
              FROM question_bank_items i
              JOIN exam_section_questions esq ON esq.question_id = i.question_id
              JOIN exam_sections es ON es.id = esq.section_id
             WHERE i.bank_id = ?
        ) u');
    $stmt->execute([$bankId, $bankId]);
    $row = $stmt->fetch();
    $stmt->closeCursor();
    return (int)($row['exam_count'] ?? 0);
}

function qb_bank_question_count(PDO $pdo, int $bankId): int {
    $stmt = $pdo->prepare('SELECT COUNT(*) AS cnt FROM question_bank_items WHERE bank_id = ?');
    $stmt->execute([$bankId]);
    $row = $stmt->fetch();
    $stmt->closeCursor();
    return (int)($row['cnt'] ?? 0);
}

function qb_bank_summary(PDO $pdo, array $bankRow): array {
    $bankId = (int)$bankRow['id'];
    return qb_serialize_bank($bankRow, qb_bank_question_count($pdo, $bankId), qb_bank_exam_count($pdo, $bankId));
}

function qb_list_banks(PDO $pdo, int $companyId): array {
    $stmt = $pdo->prepare('SELECT b.id, b.company_id, b.name, b.description, b.created_by, b.created_at, b.updated_at,
                                  (SELECT COUNT(*) FROM question_bank_items i WHERE i.bank_id = b.id) AS question_count
                             FROM question_banks b
                            WHERE b.company_id = ?
                            ORDER BY b.name ASC, b.id ASC');
    $stmt->execute([$companyId]);
    $rows = $stmt->fetchAll();
    $stmt->closeCursor();

    // One grouped query for every bank's exam usage instead of one per bank.
    $examCounts = [];
    $countStmt = $pdo->prepare('SELECT u.bank_id, COUNT(DISTINCT u.exam_id) AS exam_count FROM (
            SELECT i.bank_id, eq.exam_id
              FROM question_banks b
              JOIN question_bank_items i ON i.bank_id = b.id
              JOIN exam_questions eq ON eq.question_id = i.question_id
             WHERE b.company_id = ?
            UNION
            SELECT i.bank_id, es.exam_id
              FROM question_banks b
              JOIN question_bank_items i ON i.bank_id = b.id
              JOIN exam_section_questions esq ON esq.question_id = i.question_id
              JOIN exam_sections es ON es.id = esq.section_id
             WHERE b.company_id = ?
        ) u GROUP BY u.bank_id');
    $countStmt->execute([$companyId, $companyId]);
    foreach ($countStmt->fetchAll() as $r) {
        $examCounts[(int)$r['bank_id']] = (int)$r['exam_count'];
    }
    $countStmt->closeCursor();

    return array_map(
        static fn(array $r) => qb_serialize_bank($r, (int)$r['question_count'], $examCounts[(int)$r['id']] ?? 0),
        $rows
    );
}

function qb_bank_detail(PDO $pdo, array $bankRow): array {
    $bankId = (int)$bankRow['id'];
    $stmt = $pdo->prepare('SELECT q.id, q.type, q.text, q.options_json, q.correct_option_index, q.answer_key_json,
                                  q.match_options_json, q.marks, q.negative_marks, q.word_limit, i.display_order
                             FROM question_bank_items i
                             JOIN questions q ON q.id = i.question_id
                            WHERE i.bank_id = ?
                            ORDER BY i.display_order ASC, i.added_at ASC, q.id ASC');
    $stmt->execute([$bankId]);
    $rows = $stmt->fetchAll();
    $stmt->closeCursor();

    $usage = qb_question_exam_counts($pdo, $bankId);
    $bankName = (string)$bankRow['name'];
    $questions = array_map(
        static fn(array $r) => qb_serialize_question_row($r, $bankId, $bankName, $usage[(string)$r['id']] ?? 0),
        $rows
    );
    $detail = qb_serialize_bank($bankRow, count($questions), qb_bank_exam_count($pdo, $bankId));
    $detail['questions'] = $questions;
    return $detail;
}

function qb_fetch_question(PDO $pdo, int $bankId, string $bankName, string $questionId): ?array {
    $stmt = $pdo->prepare('SELECT q.id, q.type, q.text, q.options_json, q.correct_option_index, q.answer_key_json,
                                  q.match_options_json, q.marks, q.negative_marks, q.word_limit
                             FROM question_bank_items i
                             JOIN questions q ON q.id = i.question_id
                            WHERE i.bank_id = ? AND i.question_id = ?');
    $stmt->execute([$bankId, $questionId]);
    $row = $stmt->fetch();
    $stmt->closeCursor();
    if (!$row) {
        return null;
    }
    return qb_serialize_question_row($row, $bankId, $bankName, qb_single_question_exam_count($pdo, $questionId));
}

/** Distinct exams linking one question (directly or through an exam section). */
function qb_single_question_exam_count(PDO $pdo, string $questionId): int {
    $stmt = $pdo->prepare('SELECT COUNT(DISTINCT u.exam_id) AS exam_count FROM (
            SELECT exam_id FROM exam_questions WHERE question_id = ?
            UNION
            SELECT es.exam_id FROM exam_section_questions esq JOIN exam_sections es ON es.id = esq.section_id WHERE esq.question_id = ?
        ) u');
    $stmt->execute([$questionId, $questionId]);
    $row = $stmt->fetch();
    $stmt->closeCursor();
    return (int)($row['exam_count'] ?? 0);
}

/** Bump the bank's updated_at (its questions changed, which the row itself doesn't see). */
function qb_touch_bank(PDO $pdo, int $bankId): void {
    $stmt = $pdo->prepare('UPDATE question_banks SET updated_at = CURRENT_TIMESTAMP WHERE id = ?');
    $stmt->execute([$bankId]);
    $stmt->closeCursor();
}

/* ------------------------------------------------------------------------------------------------
 * Question validation / normalisation
 *
 * Mirrors what the exam editor builds (ExamManager buildQuestionByType), the shared CSV parser
 * (services/questionCsv.ts) and what grade_question() in _bootstrap.php reads, so a bank question is
 * always gradable. Throws InvalidArgumentException with a human-readable message on bad input.
 * --------------------------------------------------------------------------------------------- */

/** A whole number from an int / integral float / digit string, else null. */
function qb_int_value($value): ?int {
    if (is_int($value)) return $value;
    if (is_float($value) && is_finite($value) && floor($value) === $value && abs($value) < 1e9) return (int)$value;
    if (is_string($value) && preg_match('/^\s*-?\d{1,9}\s*$/', $value)) return (int)trim($value);
    return null;
}

/** A finite number from an int / float / numeric string (never a bool), else null. */
function qb_number_value($value): ?float {
    if (is_bool($value) || $value === null) return null;
    if (is_int($value) || is_float($value)) {
        $f = (float)$value;
        return is_finite($f) ? $f : null;
    }
    if (is_string($value) && trim($value) !== '' && is_numeric(trim($value))) {
        $f = (float)trim($value);
        return is_finite($f) ? $f : null;
    }
    return null;
}

/** Store integral numbers as ints so 4 doesn't come back as 4.0. */
function qb_json_number(float $value) {
    return (floor($value) === $value && abs($value) < 1e15) ? (int)$value : $value;
}

/** Non-empty trimmed strings; $what names the field in error messages. */
function qb_string_list($value, string $what, int $min, int $max): array {
    if (!is_array($value) || !array_is_list($value)) {
        throw new InvalidArgumentException("{$what} must be a list.");
    }
    $out = [];
    foreach ($value as $i => $item) {
        if (!is_string($item) && !is_int($item) && !is_float($item)) {
            throw new InvalidArgumentException("{$what} #" . ($i + 1) . ' must be text.');
        }
        $s = trim((string)$item);
        if ($s === '') {
            throw new InvalidArgumentException("{$what} #" . ($i + 1) . ' is empty.');
        }
        if (qb_strlen($s) > QB_OPTION_MAX) {
            throw new InvalidArgumentException("{$what} #" . ($i + 1) . ' is longer than ' . QB_OPTION_MAX . ' characters.');
        }
        $out[] = $s;
    }
    if (count($out) < $min) {
        throw new InvalidArgumentException("{$what}: at least {$min} required.");
    }
    if (count($out) > $max) {
        throw new InvalidArgumentException("{$what}: at most {$max} allowed.");
    }
    return $out;
}

/**
 * An index map (MATCHING pairs / DRAG_DROP placements) given as a JSON object {"0":1,...} or list
 * [1,...]. Must cover exactly the source indices 0..$sourceCount-1, each mapping into 0..$targetCount-1.
 * Returned as an object so it re-encodes as the Record<number, number> the frontend type declares.
 */
function qb_index_map($value, string $what, int $sourceCount, int $targetCount): object {
    if (!is_array($value)) {
        throw new InvalidArgumentException("{$what} is required.");
    }
    $map = [];
    foreach ($value as $k => $v) {
        $src = qb_int_value(is_int($k) ? $k : (string)$k);
        $dst = qb_int_value($v);
        if ($src === null || $src < 0 || $src >= $sourceCount) {
            throw new InvalidArgumentException("{$what} refers to an item that doesn't exist.");
        }
        if ($dst === null || $dst < 0 || $dst >= $targetCount) {
            throw new InvalidArgumentException("{$what} for item " . ($src + 1) . ' points outside the list.');
        }
        $map[$src] = $dst;
    }
    if (count($map) !== $sourceCount) {
        throw new InvalidArgumentException("{$what} must give an answer for every item.");
    }
    ksort($map);
    $obj = new stdClass();
    foreach ($map as $k => $v) {
        $obj->{(string)$k} = $v;
    }
    return $obj;
}

/**
 * Validate one incoming Question and return the normalised column values for `questions`.
 * The client's id / bankId / sectionId etc. are ignored.
 */
function qb_normalize_question($q): array {
    if (!is_array($q) || array_is_list($q) && count($q) > 0) {
        throw new InvalidArgumentException('Each question must be an object.');
    }

    $type = strtoupper(trim(is_string($q['type'] ?? null) ? $q['type'] : ''));
    if (!in_array($type, QB_TYPES, true)) {
        throw new InvalidArgumentException('Unknown question type "' . (is_scalar($q['type'] ?? null) ? (string)$q['type'] : '') . '".');
    }

    $text = is_string($q['text'] ?? null) ? trim($q['text']) : '';
    if ($text === '') {
        throw new InvalidArgumentException('Question text is required.');
    }
    if (qb_strlen($text) > QB_TEXT_MAX) {
        throw new InvalidArgumentException('Question text is longer than ' . QB_TEXT_MAX . ' characters.');
    }

    $marks = qb_int_value($q['marks'] ?? null);
    if ($marks === null || $marks < 1 || $marks > QB_MARKS_MAX) {
        throw new InvalidArgumentException('Marks must be a whole number from 1 to ' . QB_MARKS_MAX . '.');
    }

    $negRaw = $q['negativeMarks'] ?? null;
    $negativeMarks = 0.0;
    if ($negRaw !== null && $negRaw !== '') {
        $neg = qb_number_value($negRaw);
        if ($neg === null || $neg < 0 || $neg > QB_NEGATIVE_MAX) {
            throw new InvalidArgumentException('Negative marks must be a number from 0 to ' . QB_NEGATIVE_MAX . '.');
        }
        $negativeMarks = round($neg, 2);
    }

    $isManual = is_manual_question_type($type);
    $wordLimit = null;
    if ($isManual) {
        // Manually graded — a penalty would never be applied, so it is not stored (same as the CSV).
        $negativeMarks = 0.0;
        $wlRaw = $q['wordLimit'] ?? null;
        if ($wlRaw !== null && $wlRaw !== '' && $wlRaw !== 0 && $wlRaw !== '0') {
            $wl = qb_int_value($wlRaw);
            if ($wl === null || $wl < 1 || $wl > QB_WORD_LIMIT_MAX) {
                throw new InvalidArgumentException('Word limit must be a positive whole number (or blank for no limit).');
            }
            $wordLimit = $wl;
        }
    }

    $options = null;
    $correctOptionIndex = null;
    $answerKey = null;
    $matchOptions = null;
    $key = is_array($q['answerKey'] ?? null) ? $q['answerKey'] : [];
    $match = is_array($q['matchOptions'] ?? null) ? $q['matchOptions'] : [];

    switch ($type) {
        case 'MCQ': {
            $options = qb_string_list($q['options'] ?? null, 'Option', 2, QB_MAX_OPTIONS);
            $idx = qb_int_value($q['correctOptionIndex'] ?? null);
            if ($idx === null || $idx < 0 || $idx >= count($options)) {
                throw new InvalidArgumentException('Choose which option is correct.');
            }
            $correctOptionIndex = $idx;
            break;
        }
        case 'MULTI_SELECT': {
            $options = qb_string_list($q['options'] ?? null, 'Option', 2, QB_MAX_OPTIONS);
            $raw = $key['correctIndices'] ?? null;
            if (!is_array($raw) || count($raw) === 0) {
                throw new InvalidArgumentException('Select at least one correct option.');
            }
            $indices = [];
            foreach ($raw as $v) {
                $i = qb_int_value($v);
                if ($i === null || $i < 0 || $i >= count($options)) {
                    throw new InvalidArgumentException('A correct option is outside the option list.');
                }
                $indices[$i] = $i;
            }
            $indices = array_values($indices);
            sort($indices);
            $answerKey = ['correctIndices' => $indices];
            break;
        }
        case 'TRUE_FALSE':
        case 'YES_NO': {
            $options = $type === 'TRUE_FALSE' ? ['True', 'False'] : ['Yes', 'No'];
            $idx = qb_int_value($q['correctOptionIndex'] ?? null);
            if ($idx === null || ($idx !== 0 && $idx !== 1)) {
                throw new InvalidArgumentException("Choose \"{$options[0]}\" or \"{$options[1]}\" as the correct answer.");
            }
            $correctOptionIndex = $idx;
            break;
        }
        case 'SHORT_TEXT':
        case 'LONG_TEXT':
        case 'TEXT':
            break; // graded manually: text + marks (+ word limit) only
        case 'FILL_BLANK': {
            $blanksRaw = $key['blanks'] ?? null;
            if (!is_array($blanksRaw) || !array_is_list($blanksRaw) || count($blanksRaw) === 0) {
                throw new InvalidArgumentException('Fill-blank needs at least one blank with an accepted answer.');
            }
            if (count($blanksRaw) > QB_MAX_BLANKS) {
                throw new InvalidArgumentException('Fill-blank: at most ' . QB_MAX_BLANKS . ' blanks.');
            }
            $blanks = [];
            foreach ($blanksRaw as $bi => $blank) {
                $accepted = is_array($blank) ? ($blank['accepted'] ?? null) : null;
                if (!is_array($accepted)) {
                    throw new InvalidArgumentException('Blank ' . ($bi + 1) . ' needs at least one accepted answer.');
                }
                $alts = [];
                foreach ($accepted as $alt) {
                    if (!is_string($alt) && !is_int($alt) && !is_float($alt)) continue;
                    $s = trim((string)$alt);
                    if ($s === '') continue;
                    if (qb_strlen($s) > QB_OPTION_MAX) {
                        throw new InvalidArgumentException('Blank ' . ($bi + 1) . ': an accepted answer is too long.');
                    }
                    $alts[] = $s;
                }
                if (count($alts) === 0) {
                    throw new InvalidArgumentException('Blank ' . ($bi + 1) . ' needs at least one accepted answer.');
                }
                if (count($alts) > QB_MAX_ALTERNATES) {
                    throw new InvalidArgumentException('Blank ' . ($bi + 1) . ': at most ' . QB_MAX_ALTERNATES . ' accepted answers.');
                }
                $blanks[] = ['accepted' => array_values(array_unique($alts))];
            }
            $answerKey = ['blanks' => $blanks];
            break;
        }
        case 'NUMERIC': {
            $value = qb_number_value($key['value'] ?? null);
            if ($value === null) {
                throw new InvalidArgumentException('Numeric questions need a numeric expected answer.');
            }
            $tolRaw = $key['tolerance'] ?? null;
            $tolerance = null;
            if ($tolRaw !== null && $tolRaw !== '') {
                $tolerance = qb_number_value($tolRaw);
                if ($tolerance === null || $tolerance < 0) {
                    throw new InvalidArgumentException('Tolerance must be a non-negative number, or blank for an exact answer.');
                }
            }
            $answerKey = [
                'value' => qb_json_number($value),
                'tolerance' => $tolerance === null ? null : qb_json_number($tolerance),
            ];
            break;
        }
        case 'DATE': {
            $value = is_string($key['value'] ?? null) ? trim($key['value']) : '';
            if (!preg_match('/^(\d{4})-(\d{2})-(\d{2})$/', $value, $m) || !checkdate((int)$m[2], (int)$m[3], (int)$m[1])) {
                throw new InvalidArgumentException('Date answer must be a real date in YYYY-MM-DD format.');
            }
            $answerKey = ['value' => $value];
            break;
        }
        case 'TIME': {
            $value = is_string($key['value'] ?? null) ? trim($key['value']) : '';
            if (!preg_match('/^([01]?\d|2[0-3]):([0-5]\d)$/', $value, $m)) {
                throw new InvalidArgumentException('Time answer must be HH:MM in 24-hour format.');
            }
            $answerKey = ['value' => str_pad($m[1], 2, '0', STR_PAD_LEFT) . ':' . $m[2]];
            break;
        }
        case 'MATCHING': {
            $left = qb_string_list($match['left'] ?? null, 'Left item', 2, QB_MAX_ITEMS);
            $right = qb_string_list($match['right'] ?? null, 'Right item', 2, QB_MAX_ITEMS);
            $pairs = qb_index_map($key['pairs'] ?? null, 'Match pairs', count($left), count($right));
            $matchOptions = ['left' => $left, 'right' => $right];
            $answerKey = ['pairs' => $pairs];
            break;
        }
        case 'ORDERING': {
            $items = qb_string_list($match['items'] ?? null, 'Item', 2, QB_MAX_ITEMS);
            $orderRaw = $key['order'] ?? null;
            if (!is_array($orderRaw) || !array_is_list($orderRaw)) {
                throw new InvalidArgumentException('Ordering questions need the correct order.');
            }
            $order = [];
            foreach ($orderRaw as $v) {
                $i = qb_int_value($v);
                if ($i === null) {
                    throw new InvalidArgumentException('The correct order must list item numbers.');
                }
                $order[] = $i;
            }
            $sorted = $order;
            sort($sorted);
            if ($sorted !== range(0, count($items) - 1)) {
                throw new InvalidArgumentException('The correct order must include every item exactly once.');
            }
            $matchOptions = ['items' => $items];
            $answerKey = ['order' => $order];
            break;
        }
        case 'DRAG_DROP': {
            $items = qb_string_list($match['items'] ?? null, 'Item', 2, QB_MAX_ITEMS);
            $buckets = qb_string_list($match['buckets'] ?? null, 'Bucket', 2, QB_MAX_ITEMS);
            $placements = qb_index_map($key['placements'] ?? null, 'Placements', count($items), count($buckets));
            $matchOptions = ['items' => $items, 'buckets' => $buckets];
            $answerKey = ['placements' => $placements];
            break;
        }
    }

    $encode = static fn($v) => $v === null ? null : json_encode($v, JSON_UNESCAPED_UNICODE);
    return [
        'type' => $type,
        'text' => $text,
        'options_json' => $encode($options),
        'correct_option_index' => $correctOptionIndex,
        'answer_key_json' => $encode($answerKey),
        'match_options_json' => $encode($matchOptions),
        'marks' => $marks,
        'negative_marks' => $negativeMarks,
        'word_limit' => $wordLimit,
    ];
}

function qb_validation_message(Throwable $e): string {
    return $e instanceof InvalidArgumentException ? $e->getMessage() : 'Invalid question.';
}

/**
 * Delete the given question rows that nothing else needs any more: not linked into an exam (directly or
 * via a section), not in any bank, and with no candidate answers / timings recorded against them
 * (session_answers & session_question_times cascade on a question delete, so deleting an answered
 * question would silently erase exam results). The guard runs inside the DELETE itself, so a link
 * created concurrently can't be lost. Returns the number of rows deleted.
 */
function qb_delete_orphan_questions(PDO $pdo, array $questionIds): int {
    $deleted = 0;
    $answerGuard = db_table_exists($pdo, 'session_answers')
        ? 'AND NOT EXISTS (SELECT 1 FROM session_answers sa WHERE sa.question_id = q.id)' : '';
    $timeGuard = db_table_exists($pdo, 'session_question_times')
        ? 'AND NOT EXISTS (SELECT 1 FROM session_question_times st WHERE st.question_id = q.id)' : '';
    foreach (array_chunk(array_values($questionIds), QB_SQL_CHUNK) as $chunk) {
        $ph = implode(',', array_fill(0, count($chunk), '?'));
        $stmt = $pdo->prepare("DELETE q FROM questions q
                                WHERE q.id IN ($ph)
                                  AND NOT EXISTS (SELECT 1 FROM exam_questions eq WHERE eq.question_id = q.id)
                                  AND NOT EXISTS (SELECT 1 FROM exam_section_questions esq WHERE esq.question_id = q.id)
                                  AND NOT EXISTS (SELECT 1 FROM question_bank_items i WHERE i.question_id = q.id)
                                  $answerGuard
                                  $timeGuard");
        $stmt->execute($chunk);
        $deleted += $stmt->rowCount();
        $stmt->closeCursor();
    }
    return $deleted;
}

/** Whether a question is linked into any exam (directly or through a section). */
function qb_question_in_exam(PDO $pdo, string $questionId): bool {
    $stmt = $pdo->prepare('SELECT
            EXISTS (SELECT 1 FROM exam_questions WHERE question_id = ?) AS direct_link,
            EXISTS (SELECT 1 FROM exam_section_questions WHERE question_id = ?) AS section_link');
    $stmt->execute([$questionId, $questionId]);
    $row = $stmt->fetch();
    $stmt->closeCursor();
    return !empty($row['direct_link']) || !empty($row['section_link']);
}

function qb_read_name($raw): string {
    if (!is_string($raw)) {
        json_response(['error' => 'Bank name is required.'], 400);
    }
    $name = trim(preg_replace('/\s+/u', ' ', $raw) ?? '');
    if ($name === '') {
        json_response(['error' => 'Bank name is required.'], 400);
    }
    if (qb_strlen($name) > QB_NAME_MAX) {
        json_response(['error' => 'Bank name must be ' . QB_NAME_MAX . ' characters or fewer.'], 400);
    }
    return $name;
}

function qb_read_description($raw): ?string {
    if ($raw === null) {
        return null;
    }
    if (!is_string($raw)) {
        json_response(['error' => 'Description must be text.'], 400);
    }
    $description = trim($raw);
    if (qb_strlen($description) > QB_DESCRIPTION_MAX) {
        json_response(['error' => 'Description must be ' . QB_DESCRIPTION_MAX . ' characters or fewer.'], 400);
    }
    return $description === '' ? null : $description;
}

/** True when another bank of the company already uses $name (case-insensitive, like the unique key). */
function qb_name_taken(PDO $pdo, int $companyId, string $name, int $exceptId = 0): bool {
    $stmt = $pdo->prepare('SELECT id FROM question_banks WHERE company_id = ? AND name = ? AND id <> ?');
    $stmt->execute([$companyId, $name, $exceptId]);
    $row = $stmt->fetch();
    $stmt->closeCursor();
    return (bool)$row;
}

function qb_is_duplicate_key(Throwable $e): bool {
    return $e instanceof PDOException && (string)$e->getCode() === '23000' && (int)($e->errorInfo[1] ?? 0) === 1062;
}

/* ------------------------------------------------------------------------------------------------ */

ensure_question_bank_schema($pdo);
$method = $_SERVER['REQUEST_METHOD'];

if ($method === 'GET') {
    require_role(['ADMIN', 'SUPER_ADMIN']);
    $companyId = require_company_id();

    if (isset($_GET['id'])) {
        $bankId = is_string($_GET['id']) ? (qb_int_value($_GET['id']) ?? 0) : 0;
        $bank = qb_require_bank($pdo, $bankId, $companyId);
        json_response(['bank' => qb_bank_detail($pdo, $bank)]);
    }

    json_response(['banks' => qb_list_banks($pdo, $companyId)]);
}

if ($method !== 'POST') {
    json_response(['error' => 'Method not allowed.'], 405);
}

$payload = json_input();
$actorRole = require_role(['ADMIN', 'SUPER_ADMIN'], $payload);
$companyId = require_company_id($payload);
$actorId = get_actor_id($payload);
$action = strtoupper(trim(is_string($payload['action'] ?? null) ? $payload['action'] : ''));

$audit = static function (string $auditAction, string $targetType, string $targetId, string $message, ?array $metadata = null) use ($pdo, $companyId, $actorRole, $actorId): void {
    audit_log($pdo, [
        'companyId' => $companyId,
        'actorRole' => $actorRole,
        'actorId' => $actorId,
        'action' => $auditAction,
        'targetType' => $targetType,
        'targetId' => $targetId,
        'message' => $message,
        'metadata' => $metadata,
    ]);
};

switch ($action) {
    case 'CREATE_BANK': {
        $name = qb_read_name($payload['name'] ?? null);
        $description = qb_read_description($payload['description'] ?? null);
        if (qb_name_taken($pdo, $companyId, $name)) {
            json_response(['error' => "A question bank named \"{$name}\" already exists."], 409);
        }
        try {
            $stmt = $pdo->prepare('INSERT INTO question_banks (company_id, name, description, created_by) VALUES (?, ?, ?, ?)');
            $stmt->execute([$companyId, $name, $description, $actorId]);
            $stmt->closeCursor();
        } catch (Throwable $e) {
            if (qb_is_duplicate_key($e)) {
                json_response(['error' => "A question bank named \"{$name}\" already exists."], 409);
            }
            throw $e;
        }
        $bankId = (int)$pdo->lastInsertId();
        $bank = qb_require_bank($pdo, $bankId, $companyId);
        $audit('QUESTION_BANK_CREATE', 'question_bank', (string)$bankId, "Question bank created: {$name}", ['description' => $description]);
        json_response(['bank' => qb_serialize_bank($bank, 0, 0)]);
    }

    case 'UPDATE_BANK': {
        $bankId = qb_int_value($payload['id'] ?? null) ?? 0;
        $bank = qb_require_bank($pdo, $bankId, $companyId);
        $sets = [];
        $params = [];
        $changes = [];
        if (array_key_exists('name', $payload)) {
            $name = qb_read_name($payload['name']);
            if ($name !== (string)$bank['name']) {
                if (qb_name_taken($pdo, $companyId, $name, $bankId)) {
                    json_response(['error' => "A question bank named \"{$name}\" already exists."], 409);
                }
                $sets[] = 'name = ?';
                $params[] = $name;
                $changes['name'] = ['from' => (string)$bank['name'], 'to' => $name];
            }
        }
        if (array_key_exists('description', $payload)) {
            $description = qb_read_description($payload['description']);
            $current = $bank['description'] !== null && $bank['description'] !== '' ? (string)$bank['description'] : null;
            if ($description !== $current) {
                $sets[] = 'description = ?';
                $params[] = $description;
                $changes['description'] = true;
            }
        }
        if (count($sets) > 0) {
            try {
                $params[] = $bankId;
                $params[] = $companyId;
                $stmt = $pdo->prepare('UPDATE question_banks SET ' . implode(', ', $sets) . ' WHERE id = ? AND company_id = ?');
                $stmt->execute($params);
                $stmt->closeCursor();
            } catch (Throwable $e) {
                if (qb_is_duplicate_key($e)) {
                    json_response(['error' => 'A question bank with that name already exists.'], 409);
                }
                throw $e;
            }
            $bank = qb_require_bank($pdo, $bankId, $companyId);
            $audit('QUESTION_BANK_UPDATE', 'question_bank', (string)$bankId, 'Question bank updated: ' . (string)$bank['name'], $changes);
        }
        json_response(['bank' => qb_bank_summary($pdo, $bank)]);
    }

    case 'DELETE_BANK': {
        $bankId = qb_int_value($payload['id'] ?? null) ?? 0;
        $deleted = 0;
        $total = 0;
        $pdo->beginTransaction();
        try {
            $bank = qb_find_bank($pdo, $bankId, $companyId, true);
            if ($bank === null) {
                $pdo->rollBack();
                json_response(['error' => 'Question bank not found.'], 404);
            }
            $idStmt = $pdo->prepare('SELECT question_id FROM question_bank_items WHERE bank_id = ?');
            $idStmt->execute([$bankId]);
            $questionIds = array_map(static fn($r) => (string)$r['question_id'], $idStmt->fetchAll());
            $idStmt->closeCursor();
            $total = count($questionIds);

            // Items cascade with the bank; then drop the question rows nothing else uses.
            $del = $pdo->prepare('DELETE FROM question_banks WHERE id = ? AND company_id = ?');
            $del->execute([$bankId, $companyId]);
            $del->closeCursor();
            $deleted = qb_delete_orphan_questions($pdo, $questionIds);
            $pdo->commit();
        } catch (Throwable $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            throw $e;
        }
        $kept = $total - $deleted;
        $audit('QUESTION_BANK_DELETE', 'question_bank', (string)$bankId, 'Question bank deleted: ' . (string)$bank['name'], [
            'questions' => $total,
            'deletedQuestions' => $deleted,
            'keptQuestions' => $kept,
        ]);
        json_response(['ok' => true, 'deletedQuestions' => $deleted, 'keptQuestions' => $kept]);
    }

    case 'ADD_QUESTIONS': {
        $bankId = qb_int_value($payload['bankId'] ?? null) ?? 0;
        qb_require_bank($pdo, $bankId, $companyId);
        $input = $payload['questions'] ?? null;
        if (!is_array($input) || !array_is_list($input) || count($input) === 0) {
            json_response(['error' => 'Send at least one question.'], 400);
        }
        if (count($input) > QB_MAX_ADD) {
            json_response(['error' => 'Too many questions in one upload (max ' . QB_MAX_ADD . '). Split the file and upload it in parts.'], 400);
        }

        $valid = [];
        $errors = [];
        foreach ($input as $index => $q) {
            try {
                $valid[] = qb_normalize_question($q);
            } catch (Throwable $e) {
                $errors[] = ['index' => $index, 'message' => qb_validation_message($e)];
            }
        }
        if (count($valid) === 0) {
            json_response(['error' => 'None of the questions are valid, so nothing was added.', 'errors' => $errors], 400);
        }

        $pdo->beginTransaction();
        try {
            // Lock the bank row so concurrent uploads append one after the other (display_order).
            $bank = qb_find_bank($pdo, $bankId, $companyId, true);
            if ($bank === null) {
                $pdo->rollBack();
                json_response(['error' => 'Question bank not found.'], 404);
            }
            $maxStmt = $pdo->prepare('SELECT COALESCE(MAX(display_order), -1) AS max_order FROM question_bank_items WHERE bank_id = ?');
            $maxStmt->execute([$bankId]);
            $nextOrder = (int)($maxStmt->fetch()['max_order'] ?? -1) + 1;
            $maxStmt->closeCursor();

            foreach (array_chunk($valid, QB_SQL_CHUNK) as $chunk) {
                $qRows = [];
                $qParams = [];
                $iRows = [];
                $iParams = [];
                foreach ($chunk as $row) {
                    $qid = qb_new_question_id();
                    $qRows[] = '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';
                    array_push($qParams, $qid, $row['type'], $row['text'], $row['options_json'], $row['correct_option_index'],
                        $row['answer_key_json'], $row['match_options_json'], $row['marks'], $row['negative_marks'], $row['word_limit']);
                    $iRows[] = '(?, ?, ?)';
                    array_push($iParams, $bankId, $qid, $nextOrder++);
                }
                $insQ = $pdo->prepare('INSERT INTO questions (id, type, text, options_json, correct_option_index, answer_key_json,
                                                              match_options_json, marks, negative_marks, word_limit)
                                       VALUES ' . implode(', ', $qRows));
                $insQ->execute($qParams);
                $insQ->closeCursor();
                $insI = $pdo->prepare('INSERT INTO question_bank_items (bank_id, question_id, display_order) VALUES ' . implode(', ', $iRows));
                $insI->execute($iParams);
                $insI->closeCursor();
            }
            qb_touch_bank($pdo, $bankId);
            $pdo->commit();
        } catch (Throwable $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            throw $e;
        }

        $added = count($valid);
        $bank = qb_require_bank($pdo, $bankId, $companyId);
        $audit('QUESTION_BANK_ADD_QUESTIONS', 'question_bank', (string)$bankId,
            "Added {$added} question(s) to bank: " . (string)$bank['name'],
            ['added' => $added, 'rejected' => count($errors)]);
        json_response(['bank' => qb_bank_detail($pdo, $bank), 'added' => $added, 'errors' => $errors]);
    }

    case 'UPDATE_QUESTION': {
        $bankId = qb_int_value($payload['bankId'] ?? null) ?? 0;
        $bank = qb_require_bank($pdo, $bankId, $companyId);
        $question = $payload['question'] ?? null;
        $questionId = is_array($question) && is_string($question['id'] ?? null) ? trim($question['id']) : '';
        if ($questionId === '' || qb_fetch_question($pdo, $bankId, (string)$bank['name'], $questionId) === null) {
            json_response(['error' => 'Question not found in this bank.'], 404);
        }
        try {
            $row = qb_normalize_question($question);
        } catch (Throwable $e) {
            json_response(['error' => qb_validation_message($e)], 400);
        }
        $pdo->beginTransaction();
        try {
            $stmt = $pdo->prepare('UPDATE questions
                                      SET type = ?, text = ?, options_json = ?, correct_option_index = ?, answer_key_json = ?,
                                          match_options_json = ?, marks = ?, negative_marks = ?, word_limit = ?
                                    WHERE id = ?');
            $stmt->execute([$row['type'], $row['text'], $row['options_json'], $row['correct_option_index'], $row['answer_key_json'],
                $row['match_options_json'], $row['marks'], $row['negative_marks'], $row['word_limit'], $questionId]);
            $stmt->closeCursor();
            qb_touch_bank($pdo, $bankId);
            $pdo->commit();
        } catch (Throwable $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            throw $e;
        }
        $updated = qb_fetch_question($pdo, $bankId, (string)$bank['name'], $questionId);
        $audit('QUESTION_BANK_QUESTION_UPDATE', 'question', $questionId, 'Bank question updated in: ' . (string)$bank['name'], [
            'bankId' => $bankId,
            'type' => $row['type'],
            'examCount' => $updated['examCount'] ?? 0,
        ]);
        json_response(['question' => $updated]);
    }

    case 'DELETE_QUESTION': {
        $bankId = qb_int_value($payload['bankId'] ?? null) ?? 0;
        $bank = qb_require_bank($pdo, $bankId, $companyId);
        $questionId = is_string($payload['questionId'] ?? null) ? trim($payload['questionId']) : '';
        if ($questionId === '') {
            json_response(['error' => 'questionId is required.'], 400);
        }
        $pdo->beginTransaction();
        try {
            $del = $pdo->prepare('DELETE FROM question_bank_items WHERE bank_id = ? AND question_id = ?');
            $del->execute([$bankId, $questionId]);
            $removed = $del->rowCount();
            $del->closeCursor();
            if ($removed === 0) {
                $pdo->rollBack();
                json_response(['error' => 'Question not found in this bank.'], 404);
            }
            $deleted = qb_delete_orphan_questions($pdo, [$questionId]);
            qb_touch_bank($pdo, $bankId);
            $pdo->commit();
        } catch (Throwable $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            throw $e;
        }
        // Kept = still needed by an exam: linked into one, or answered in a past attempt.
        $keptForExams = $deleted === 0;
        $inExam = $keptForExams && qb_question_in_exam($pdo, $questionId);
        $audit('QUESTION_BANK_QUESTION_DELETE', 'question', $questionId, 'Question removed from bank: ' . (string)$bank['name'], [
            'bankId' => $bankId,
            'questionRowDeleted' => !$keptForExams,
            'linkedToExam' => $inExam,
        ]);
        json_response(['ok' => true, 'keptForExams' => $keptForExams]);
    }

    default:
        json_response(['error' => 'Unknown action.'], 400);
}
