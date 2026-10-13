<?php
declare(strict_types=1);

/**
 * The optional document an exam's emails carry (exam editor → Emails → Attachment).
 *
 * One file per exam. It is attached to every invitation and reminder email of that exam, by every
 * sender: the background send jobs (notify_jobs.php), approved exam-request invitations
 * (exam_requests.php) and LMS invitations (integrations.php). The file lives outside the web root in
 * storage/exam_attachments/ and is never served over HTTP; exam_mail_attachments holds its name,
 * type and size. Deleting the exam deletes the row (foreign key) and exams.php removes the file.
 *
 * Required by those senders for the functions; the HTTP handler at the bottom only runs when this
 * file is the requested script (the notify.php / notify_jobs.php pattern):
 *   POST {action: 'UPLOAD', examId, fileName, dataBase64} → {ok, attachment}
 *   POST {action: 'REMOVE', examId}                       → {ok, removed}
 * The file travels as base64 inside the JSON body, so the limit stays under PHP's post_max_size
 * (8M) without touching upload_max_filesize (2M).
 */

require_once __DIR__ . '/_bootstrap.php';

/** 5 MB: every recipient's email carries the file. Same limit as services/examAttachment.ts. */
const EXAM_ATTACHMENT_MAX_BYTES = 5242880;
const EXAM_ATTACHMENT_MAX_NAME_CHARS = 100;

/** Allowed extensions and the media type each is sent as (never the type the browser claimed). */
const EXAM_ATTACHMENT_TYPES = [
    'pdf' => 'application/pdf',
    'doc' => 'application/msword',
    'docx' => 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'xls' => 'application/vnd.ms-excel',
    'xlsx' => 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'ppt' => 'application/vnd.ms-powerpoint',
    'pptx' => 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'txt' => 'text/plain',
    'csv' => 'text/csv',
    'rtf' => 'application/rtf',
    'png' => 'image/png',
    'jpg' => 'image/jpeg',
    'jpeg' => 'image/jpeg',
];

/**
 * Creates the table on first use. Returns false (and logs why) when it cannot: attachments are an
 * optional extra, so a problem here must never take the exam list or a send down with it.
 */
function ensure_exam_attachment_schema(PDO $pdo): bool {
    static $ok = null;
    if ($ok !== null) {
        return $ok;
    }
    try {
        $pdo->exec("CREATE TABLE IF NOT EXISTS exam_mail_attachments (
          exam_id     VARCHAR(64) NOT NULL,
          file_name   VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
          mime_type   VARCHAR(120) NOT NULL,
          size_bytes  INT UNSIGNED NOT NULL,
          stored_path VARCHAR(255) NOT NULL,
          uploaded_by VARCHAR(255) NULL,
          uploaded_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (exam_id),
          CONSTRAINT fk_exam_mail_attachments_exam
            FOREIGN KEY (exam_id) REFERENCES exams(id)
            ON DELETE CASCADE
        ) ENGINE=InnoDB");
        $ok = true;
    } catch (Throwable $e) {
        error_log('[exam_attachments] schema: ' . $e->getMessage());
        $ok = false;
    }
    return $ok;
}

function exam_attachment_root(): string {
    return dirname(__DIR__) . DIRECTORY_SEPARATOR . 'storage' . DIRECTORY_SEPARATOR . 'exam_attachments';
}

/**
 * Absolute path of a stored file, or null when the stored value is not one this code wrote
 * ("<exam folder>/<random hex>.<ext>") — a row can never point outside the attachment folder.
 */
function exam_attachment_abs_path(string $storedPath): ?string {
    if (preg_match('#^[A-Za-z0-9_-]{1,80}/[a-f0-9]{16,64}\.[a-z0-9]{1,5}$#D', $storedPath) !== 1) {
        return null;
    }
    return exam_attachment_root() . DIRECTORY_SEPARATOR . str_replace('/', DIRECTORY_SEPARATOR, $storedPath);
}

/** One row as the API shape the console uses: {name, size, mimeType, uploadedAt (ms)}. */
function exam_attachment_public(array $row): array {
    $uploadedAt = strtotime((string)($row['uploaded_at'] ?? '') . ' UTC');
    return [
        'name' => (string)$row['file_name'],
        'size' => (int)$row['size_bytes'],
        'mimeType' => (string)$row['mime_type'],
        'uploadedAt' => $uploadedAt === false ? null : $uploadedAt * 1000,
    ];
}

function exam_attachment_row(PDO $pdo, string $examId): ?array {
    $stmt = $pdo->prepare('SELECT exam_id, file_name, mime_type, size_bytes, stored_path, uploaded_at FROM exam_mail_attachments WHERE exam_id = ? LIMIT 1');
    $stmt->execute([$examId]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    $stmt->closeCursor();
    return $row ?: null;
}

/** The exam's attachment row, or null when it has none or it cannot be looked up. Never throws. */
function exam_attachment_row_safe(PDO $pdo, string $examId): ?array {
    if (!ensure_exam_attachment_schema($pdo)) {
        return null;
    }
    try {
        return exam_attachment_row($pdo, $examId);
    } catch (Throwable $e) {
        error_log('[exam_attachments] lookup failed: ' . $e->getMessage());
        return null;
    }
}

/** The exam's attachment in API shape, or null when it has none. Never throws. */
function exam_attachment_meta(PDO $pdo, string $examId): ?array {
    $row = exam_attachment_row_safe($pdo, $examId);
    return $row ? exam_attachment_public($row) : null;
}

/** [examId => API shape] for every exam of a company that has an attachment. Never throws. */
function exam_attachments_for_company(PDO $pdo, int $companyId): array {
    if (!ensure_exam_attachment_schema($pdo)) {
        return [];
    }
    $out = [];
    try {
        $stmt = $pdo->prepare('SELECT a.exam_id, a.file_name, a.mime_type, a.size_bytes, a.uploaded_at
                                 FROM exam_mail_attachments a
                                 JOIN exams e ON e.id = a.exam_id
                                WHERE e.company_id = ?');
        $stmt->execute([$companyId]);
        foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
            $out[(string)$row['exam_id']] = exam_attachment_public($row);
        }
        $stmt->closeCursor();
    } catch (Throwable $e) {
        error_log('[exam_attachments] list failed: ' . $e->getMessage());
    }
    return $out;
}

/** The file name as it will appear in the email: no path, no control or quote characters. */
function exam_attachment_clean_name(string $name): string {
    if (!mb_check_encoding($name, 'UTF-8')) {
        return '';
    }
    $name = str_replace('\\', '/', $name);
    $slash = strrpos($name, '/');
    if ($slash !== false) {
        $name = substr($name, $slash + 1);
    }
    $name = preg_replace('/[\x00-\x1F\x7F"<>:|?*]+/u', '', $name) ?? '';
    $name = preg_replace('/\s+/u', ' ', $name) ?? '';
    return trim($name, ' .');
}

/** True when the bytes are what the extension says: a renamed program is not mailed to candidates. */
function exam_attachment_content_ok(string $ext, string $data): bool {
    $head = substr($data, 0, 8);
    switch ($ext) {
        case 'pdf':
            return strpos(substr($data, 0, 1024), '%PDF-') !== false;
        case 'docx':
        case 'xlsx':
        case 'pptx':
            return strncmp($head, "PK\x03\x04", 4) === 0;
        case 'doc':
        case 'xls':
        case 'ppt':
            return strncmp($head, "\xD0\xCF\x11\xE0\xA1\xB1\x1A\xE1", 8) === 0;
        case 'png':
            return strncmp($head, "\x89PNG\r\n\x1A\n", 8) === 0;
        case 'jpg':
        case 'jpeg':
            return strncmp($head, "\xFF\xD8\xFF", 3) === 0;
        case 'rtf':
            return strncmp($head, '{\\rtf', 5) === 0;
        default:
            // txt / csv: text. UTF-16 (Excel's "Unicode text") legitimately contains zero bytes.
            $utf16 = strncmp($head, "\xFF\xFE", 2) === 0 || strncmp($head, "\xFE\xFF", 2) === 0;
            return $utf16 || strpos($data, "\0") === false;
    }
}

/** Delete a stored file and its (then empty) exam folder. Best effort. */
function exam_attachment_delete_file(?string $storedPath): void {
    if ($storedPath === null || $storedPath === '') {
        return;
    }
    $path = exam_attachment_abs_path($storedPath);
    if ($path === null) {
        return;
    }
    if (is_file($path)) {
        @unlink($path);
    }
    @rmdir(dirname($path)); // only succeeds when nothing else is in it
}

/**
 * Store (or replace) an exam's attachment. Returns ['ok' => true, 'attachment' => API shape] or
 * ['ok' => false, 'error' => text the admin can act on].
 */
function exam_attachment_store(PDO $pdo, string $examId, string $fileName, string $data, ?string $actor): array {
    if (!ensure_exam_attachment_schema($pdo)) {
        return ['ok' => false, 'error' => 'The server could not store the file. Please try again.'];
    }
    $name = exam_attachment_clean_name($fileName);
    $dot = strrpos($name, '.');
    $ext = $dot === false ? '' : strtolower(substr($name, $dot + 1));
    $stem = $dot === false ? $name : substr($name, 0, $dot);
    if (trim($stem) === '' || !isset(EXAM_ATTACHMENT_TYPES[$ext])) {
        return ['ok' => false, 'error' => 'This type of file cannot be attached. Use a PDF, Word, Excel, PowerPoint, text, CSV, PNG or JPG file.'];
    }
    $name = mb_substr($stem, 0, EXAM_ATTACHMENT_MAX_NAME_CHARS, 'UTF-8') . '.' . $ext;
    $size = strlen($data);
    if ($size === 0) {
        return ['ok' => false, 'error' => 'The file is empty.'];
    }
    if ($size > EXAM_ATTACHMENT_MAX_BYTES) {
        return ['ok' => false, 'error' => 'The file is larger than 5 MB. Every email carries it, so please attach a smaller file.'];
    }
    if (!exam_attachment_content_ok($ext, $data)) {
        return ['ok' => false, 'error' => 'This file is not a valid .' . $ext . ' file. Please check it opens on your computer and try again.'];
    }

    $folder = preg_replace('/[^A-Za-z0-9_-]/', '', $examId) ?? '';
    $folder = $folder === '' ? 'exam' : substr($folder, 0, 80);
    $dir = exam_attachment_root() . DIRECTORY_SEPARATOR . $folder;
    if (!is_dir($dir) && !@mkdir($dir, 0775, true) && !is_dir($dir)) {
        error_log('[exam_attachments] cannot create ' . $dir);
        return ['ok' => false, 'error' => 'The server could not store the file. Please try again.'];
    }
    $storedPath = $folder . '/' . bin2hex(random_bytes(16)) . '.' . $ext;
    $absPath = exam_attachment_abs_path($storedPath);
    if ($absPath === null || @file_put_contents($absPath, $data, LOCK_EX) !== $size) {
        if ($absPath !== null) {
            @unlink($absPath);
        }
        error_log('[exam_attachments] cannot write ' . $storedPath);
        return ['ok' => false, 'error' => 'The server could not store the file. Please try again.'];
    }
    // The send worker runs as another user (cron) than the web server that wrote the file.
    @chmod($absPath, 0644);

    $previous = exam_attachment_row($pdo, $examId);
    try {
        $stmt = $pdo->prepare('INSERT INTO exam_mail_attachments (exam_id, file_name, mime_type, size_bytes, stored_path, uploaded_by, uploaded_at)
                               VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
                               ON DUPLICATE KEY UPDATE file_name = VALUES(file_name), mime_type = VALUES(mime_type), size_bytes = VALUES(size_bytes),
                                                       stored_path = VALUES(stored_path), uploaded_by = VALUES(uploaded_by), uploaded_at = CURRENT_TIMESTAMP');
        $stmt->execute([$examId, $name, EXAM_ATTACHMENT_TYPES[$ext], $size, $storedPath, $actor !== null ? mb_substr($actor, 0, 255, 'UTF-8') : null]);
        $stmt->closeCursor();
    } catch (Throwable $e) {
        @unlink($absPath);
        throw $e;
    }
    if ($previous && (string)$previous['stored_path'] !== $storedPath) {
        exam_attachment_delete_file((string)$previous['stored_path']);
    }
    $row = exam_attachment_row($pdo, $examId);
    return ['ok' => true, 'attachment' => $row ? exam_attachment_public($row) : null];
}

/** Remove an exam's attachment (row and file). Returns whether there was one. */
function exam_attachment_remove(PDO $pdo, string $examId): bool {
    $row = exam_attachment_row_safe($pdo, $examId);
    if (!$row) {
        return false;
    }
    $stmt = $pdo->prepare('DELETE FROM exam_mail_attachments WHERE exam_id = ?');
    $stmt->execute([$examId]);
    $stmt->closeCursor();
    exam_attachment_delete_file((string)$row['stored_path']);
    return true;
}

/**
 * What a sender passes to smtp_deliver() for this exam:
 *   ['attachments' => [] or [one build_mime_data() attachment, base64-encoded once for the whole run],
 *    'error' => null, or why the exam's attachment cannot be sent right now]
 * An exam without an attachment (and a database without the table yet) gives [] and no error. An
 * attachment that exists but cannot be read gives an error: the sender must not quietly mail the
 * candidates without the document the admin attached.
 */
function exam_attachment_for_mail(PDO $pdo, string $examId): array {
    // No table (or no way to read it) = nothing was ever uploaded: uploading is what creates it.
    $row = exam_attachment_row_safe($pdo, $examId);
    if (!$row) {
        return ['attachments' => [], 'error' => null];
    }
    $name = (string)$row['file_name'];
    $path = exam_attachment_abs_path((string)$row['stored_path']);
    $data = $path !== null && is_readable($path) ? @file_get_contents($path) : false;
    if ($data === false || $data === '') {
        error_log('[exam_attachments] unreadable file for exam ' . $examId . ': ' . (string)$row['stored_path']);
        return [
            'attachments' => [],
            'error' => 'The attachment "' . $name . '" could not be read on the server. Open the exam, attach the file again in the Emails section, then retry.',
        ];
    }
    return [
        'attachments' => [[
            'filename' => $name,
            'mimetype' => (string)$row['mime_type'],
            'b64' => rtrim(chunk_split(base64_encode($data), 76, "\r\n"), "\r\n"),
        ]],
        'error' => null,
    ];
}

// =============================================================================================
// HTTP handler — skipped when this file is included for its functions.
// =============================================================================================
if (basename($_SERVER['SCRIPT_FILENAME'] ?? '') !== 'exam_attachments.php') {
    return;
}

if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'POST') {
    json_response(['error' => 'Method not allowed.'], 405);
}

$payload = json_input();
$actorRole = require_role(['ADMIN'], $payload);
$companyId = require_company_id($payload);
ensure_exam_attachment_schema($pdo);
if (count($payload) === 0 && (int)($_SERVER['CONTENT_LENGTH'] ?? 0) > 0) {
    // PHP drops a request body larger than post_max_size, which leaves nothing to read.
    json_response(['error' => 'The file is too large for the server. Please attach a file under 5 MB.'], 413);
}
$action = strtoupper(trim((string)($payload['action'] ?? '')));
$examId = trim((string)($payload['examId'] ?? ''));
if ($examId === '' || !in_array($action, ['UPLOAD', 'REMOVE'], true)) {
    json_response(['error' => 'examId and a valid action (UPLOAD|REMOVE) are required.'], 400);
}

// Same ownership rule as the exam's mail templates: a super admin may act on any company's exam.
if ($actorRole === 'SUPER_ADMIN') {
    $ownStmt = $pdo->prepare('SELECT id, company_id, title FROM exams WHERE id = ? LIMIT 1');
    $ownStmt->execute([$examId]);
} else {
    $ownStmt = $pdo->prepare('SELECT id, company_id, title FROM exams WHERE id = ? AND company_id = ? LIMIT 1');
    $ownStmt->execute([$examId, $companyId]);
}
$examRow = $ownStmt->fetch();
$ownStmt->closeCursor();
if (!$examRow) {
    json_response(['error' => 'Exam not found.'], 404);
}
$actorId = get_actor_id($payload);

if ($action === 'UPLOAD') {
    $encoded = $payload['dataBase64'] ?? null;
    $fileName = $payload['fileName'] ?? null;
    if (!is_string($encoded) || $encoded === '' || !is_string($fileName)) {
        json_response(['error' => 'fileName and dataBase64 are required.'], 400);
    }
    // Checked on the encoded length first, so an oversized upload is refused before it is decoded.
    if (strlen($encoded) > (int)ceil(EXAM_ATTACHMENT_MAX_BYTES / 3) * 4 + 4) {
        json_response(['error' => 'The file is larger than 5 MB. Every email carries it, so please attach a smaller file.'], 400);
    }
    $data = base64_decode($encoded, true);
    if ($data === false) {
        json_response(['error' => 'The file did not arrive intact. Please try again.'], 400);
    }
    $result = exam_attachment_store($pdo, (string)$examRow['id'], $fileName, $data, $actorId);
    if (!$result['ok']) {
        json_response(['error' => $result['error']], 400);
    }
    audit_log($pdo, [
        'companyId' => (int)$examRow['company_id'], 'actorRole' => $actorRole, 'actorId' => $actorId,
        'action' => 'EXAM_ATTACHMENT_UPLOAD', 'targetType' => 'exam', 'targetId' => (string)$examRow['id'],
        'message' => 'Email attachment set: ' . (string)($result['attachment']['name'] ?? ''),
        'metadata' => ['size' => (int)($result['attachment']['size'] ?? 0)],
    ]);
    json_response(['ok' => true, 'attachment' => $result['attachment']]);
}

$removed = exam_attachment_remove($pdo, (string)$examRow['id']);
if ($removed) {
    audit_log($pdo, [
        'companyId' => (int)$examRow['company_id'], 'actorRole' => $actorRole, 'actorId' => $actorId,
        'action' => 'EXAM_ATTACHMENT_REMOVE', 'targetType' => 'exam', 'targetId' => (string)$examRow['id'],
        'message' => 'Email attachment removed',
    ]);
}
json_response(['ok' => true, 'removed' => $removed]);
