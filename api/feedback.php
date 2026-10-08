<?php
declare(strict_types=1);

require __DIR__ . '/_bootstrap.php';

function feedback_datetime_to_ms(?string $dt): ?int {
    if ($dt === null) return null;
    $ts = strtotime($dt);
    return $ts === false ? null : (int)($ts * 1000);
}

function ensure_feedback_schema(PDO $pdo): void {
    $pdo->exec("CREATE TABLE IF NOT EXISTS session_feedback (
      id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      company_id       INT NOT NULL DEFAULT 1,
      session_id       BIGINT UNSIGNED NULL,
      exam_id          VARCHAR(64) NOT NULL,
      student_id       VARCHAR(64) NOT NULL,
      batch_id         BIGINT UNSIGNED NULL,
      rating           TINYINT UNSIGNED NOT NULL,
      clarity_rating   TINYINT UNSIGNED NULL,
      platform_rating  TINYINT UNSIGNED NULL,
      comment          TEXT NULL,
      created_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uk_feedback_session (session_id),
      INDEX idx_feedback_exam (company_id, exam_id, created_at),
      INDEX idx_feedback_student (company_id, student_id, created_at),
      INDEX idx_feedback_batch (company_id, batch_id, created_at)
    ) ENGINE=InnoDB");
}

function clamp_rating($value, int $default = 5): int {
    if (!is_numeric($value)) return $default;
    $rating = (int)$value;
    if ($rating < 1) return 1;
    if ($rating > 5) return 5;
    return $rating;
}

ensure_feedback_schema($pdo);
$method = $_SERVER['REQUEST_METHOD'];

if ($method === 'GET') {
    // Any staff reader. Was ADMIN/PROCTOR only, so the read-only VIEWER role — whose whole console is
    // Dashboard + Results — got a 403 and an always-empty feedback panel on the Results screen.
    require_staff();
    $companyId = require_company_id();
    $limit = isset($_GET['limit']) ? (int)$_GET['limit'] : 250;
    if ($limit <= 0) $limit = 250;
    if ($limit > 500) $limit = 500;

    $stmt = $pdo->prepare("SELECT
            f.id,
            f.session_id,
            f.exam_id,
            f.student_id,
            f.batch_id,
            f.rating,
            f.clarity_rating,
            f.platform_rating,
            f.comment,
            f.created_at,
            e.title AS exam_title,
            s.full_name,
            s.registration_id,
            b.name AS batch_name
        FROM session_feedback f
        LEFT JOIN exams e ON e.id = f.exam_id AND e.company_id = f.company_id
        LEFT JOIN students s ON s.id = f.student_id AND s.company_id = f.company_id
        LEFT JOIN batches b ON b.id = f.batch_id AND b.company_id = f.company_id
        WHERE f.company_id = ?
        ORDER BY f.created_at DESC
        LIMIT {$limit}");
    $stmt->execute([$companyId]);
    $rows = $stmt->fetchAll();
    $stmt->closeCursor();

    json_response([
        'feedback' => array_map(static function (array $row): array {
            return [
                'id' => (int)$row['id'],
                'sessionId' => $row['session_id'] !== null ? (int)$row['session_id'] : null,
                'examId' => $row['exam_id'],
                'examTitle' => $row['exam_title'] ?? $row['exam_id'],
                'studentId' => $row['student_id'],
                'studentName' => $row['full_name'] ?? $row['student_id'],
                'registrationId' => $row['registration_id'] ?? '',
                'batchId' => $row['batch_id'] !== null ? (int)$row['batch_id'] : null,
                'batch' => $row['batch_name'] ?? null,
                'rating' => (int)$row['rating'],
                'clarityRating' => $row['clarity_rating'] !== null ? (int)$row['clarity_rating'] : null,
                'platformRating' => $row['platform_rating'] !== null ? (int)$row['platform_rating'] : null,
                'comment' => $row['comment'] ?? null,
                'createdAt' => feedback_datetime_to_ms($row['created_at']) ?? 0,
            ];
        }, $rows)
    ]);
}

if ($method === 'POST') {
    $payload = json_input();
    $companyId = require_company_id($payload);
    $examId = trim((string)($payload['examId'] ?? ''));
    $studentId = trim((string)($payload['studentId'] ?? ''));
    $sessionId = isset($payload['sessionId']) && is_numeric($payload['sessionId']) ? (int)$payload['sessionId'] : null;
    $comment = trim((string)($payload['comment'] ?? ''));

    if ($examId === '' || $studentId === '') {
        json_response(['error' => 'examId and studentId are required.'], 400);
    }

    // The exam's "Collect feedback" switch (exams.feedback_enabled, added by exams.php; absent = on).
    if (db_column_exists($pdo, 'exams', 'feedback_enabled')) {
        $enabledStmt = $pdo->prepare('SELECT feedback_enabled FROM exams WHERE id = ? AND company_id = ? LIMIT 1');
        $enabledStmt->execute([$examId, $companyId]);
        $feedbackEnabled = $enabledStmt->fetchColumn();
        $enabledStmt->closeCursor();
        if ($feedbackEnabled !== false && (int)$feedbackEnabled === 0) {
            json_response(['error' => 'FEEDBACK_DISABLED', 'message' => 'Feedback is turned off for this exam.'], 403);
        }
    }

    // A client-supplied sessionId must belong to this company/exam/student. session_feedback has a
    // UNIQUE session_id + ON DUPLICATE KEY UPDATE, so an unchecked (sequential) id let any caller
    // overwrite the rating/comment stored for someone else's session, in any company.
    if ($sessionId !== null) {
        $ownStmt = $pdo->prepare('SELECT id FROM exam_sessions WHERE id = ? AND company_id = ? AND exam_id = ? AND student_id = ? LIMIT 1');
        $ownStmt->execute([$sessionId, $companyId, $examId, $studentId]);
        $ownsSession = (bool)$ownStmt->fetch();
        $ownStmt->closeCursor();
        if (!$ownsSession) {
            $sessionId = null;
        }
    }

    if ($sessionId === null) {
        $sessionStmt = $pdo->prepare('SELECT id FROM exam_sessions WHERE company_id = ? AND exam_id = ? AND student_id = ? ORDER BY start_time DESC LIMIT 1');
        $sessionStmt->execute([$companyId, $examId, $studentId]);
        $session = $sessionStmt->fetch();
        $sessionStmt->closeCursor();
        $sessionId = $session ? (int)$session['id'] : null;
    }

    // A student can now be in more than one batch — this column is a denormalized snapshot
    // (one value), so we just record any one of their current batches.
    try { ensure_student_batches_schema($pdo); } catch (Throwable $e) { /* best-effort */ }
    $batchStmt = $pdo->prepare('SELECT batch_id FROM student_batches WHERE student_id = ? LIMIT 1');
    $batchStmt->execute([$studentId]);
    $batchId = $batchStmt->fetchColumn();
    $batchStmt->closeCursor();
    $batchId = $batchId !== false && $batchId !== null ? (int)$batchId : null;

    $stmt = $pdo->prepare('INSERT INTO session_feedback
        (company_id, session_id, exam_id, student_id, batch_id, rating, clarity_rating, platform_rating, comment)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE rating = VALUES(rating),
                                clarity_rating = VALUES(clarity_rating),
                                platform_rating = VALUES(platform_rating),
                                comment = VALUES(comment),
                                created_at = CURRENT_TIMESTAMP');
    $stmt->execute([
        $companyId,
        $sessionId,
        $examId,
        $studentId,
        $batchId,
        clamp_rating($payload['rating'] ?? 5),
        clamp_rating($payload['clarityRating'] ?? null, 0) ?: null,
        clamp_rating($payload['platformRating'] ?? null, 0) ?: null,
        $comment !== '' ? $comment : null,
    ]);

    audit_log($pdo, [
        'companyId' => $companyId,
        'actorRole' => 'STUDENT',
        'actorId' => $studentId,
        'action' => 'FEEDBACK_SUBMIT',
        'targetType' => 'exam',
        'targetId' => $examId,
        'message' => 'Student submitted exam feedback',
        'metadata' => ['sessionId' => $sessionId]
    ]);

    json_response(['ok' => true]);
}

json_response(['error' => 'Method not allowed.'], 405);
