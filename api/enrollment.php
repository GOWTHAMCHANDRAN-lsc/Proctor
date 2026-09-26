<?php
declare(strict_types=1);

require __DIR__ . '/_bootstrap.php';

/**
 * Biometric enrollment storage for face-recognition based identity verification.
 *
 * Columns are added to the students table on demand so this works on existing deployments:
 *   - face_descriptor : JSON-encoded 128-float face embedding (the matching reference)
 *   - face_photo      : base64 reference snapshot captured at enrollment (admin review)
 *   - enrolled_at     : when enrollment was last (re)captured
 */
function ensure_enrollment_schema(PDO $pdo): void {
    db_add_column_if_missing($pdo, 'students', 'face_descriptor', 'TEXT NULL AFTER registration_id');
    db_add_column_if_missing($pdo, 'students', 'face_photo', 'MEDIUMTEXT NULL AFTER face_descriptor');
    db_add_column_if_missing($pdo, 'students', 'enrolled_at', 'TIMESTAMP NULL DEFAULT NULL AFTER face_photo');
}

ensure_enrollment_schema($pdo);

$method = $_SERVER['REQUEST_METHOD'];

if ($method === 'GET') {
    $companyId = require_company_id();
    $studentId = isset($_GET['studentId']) ? trim((string)$_GET['studentId']) : '';
    if ($studentId === '') {
        json_response(['error' => 'studentId is required.'], 400);
    }
    if (!db_column_exists($pdo, 'students', 'face_descriptor')) {
        json_response(['enrolled' => false, 'descriptor' => null]);
    }

    $stmt = $pdo->prepare('SELECT face_descriptor, enrolled_at FROM students WHERE id = ? AND company_id = ?');
    $stmt->execute([$studentId, $companyId]);
    $row = $stmt->fetch();
    $stmt->closeCursor();

    if (!$row || empty($row['face_descriptor'])) {
        json_response(['enrolled' => false, 'descriptor' => null]);
    }

    $descriptor = json_decode((string)$row['face_descriptor'], true);
    $descriptor = is_array($descriptor) ? array_values(array_map('floatval', $descriptor)) : null;
    json_response([
        'enrolled'   => is_array($descriptor) && count($descriptor) >= 64,
        'descriptor' => $descriptor,
        'enrolledAt' => isset($row['enrolled_at']) ? $row['enrolled_at'] : null,
    ]);
}

if ($method === 'POST') {
    $payload = json_input();
    $companyId = require_company_id($payload);
    $action = strtolower(trim((string)($payload['action'] ?? 'enroll')));

    if ($action === 'reset') {
        // Admin / proctor may clear an enrollment so the student can re-enroll.
        require_role(['ADMIN', 'PROCTOR'], $payload);
        $studentId = trim((string)($payload['studentId'] ?? ''));
        if ($studentId === '') {
            json_response(['error' => 'studentId is required.'], 400);
        }
        $stmt = $pdo->prepare('UPDATE students SET face_descriptor = NULL, face_photo = NULL, enrolled_at = NULL WHERE id = ? AND company_id = ?');
        $stmt->execute([$studentId, $companyId]);
        json_response(['ok' => true, 'enrolled' => false]);
    }

    // Default: enroll / re-enroll the student's face descriptor.
    $studentId = trim((string)($payload['studentId'] ?? ''));
    $descriptor = $payload['descriptor'] ?? null;
    $photo = isset($payload['photo']) ? (string)$payload['photo'] : null;

    if ($studentId === '' || !is_array($descriptor)) {
        json_response(['error' => 'studentId and descriptor are required.'], 400);
    }

    $descriptor = array_values(array_map('floatval', $descriptor));
    $len = count($descriptor);
    // face-api descriptors are 128-d; accept >=64 to be tolerant of model variants, reject noise.
    if ($len < 64 || $len > 1024) {
        json_response(['error' => 'Invalid face descriptor.'], 400);
    }
    foreach ($descriptor as $v) {
        if (!is_finite($v)) {
            json_response(['error' => 'Face descriptor contains invalid values.'], 400);
        }
    }

    // Keep the stored reference photo bounded so a huge data URL cannot bloat the row.
    if ($photo !== null && strlen($photo) > 600000) {
        $photo = null;
    }

    $check = $pdo->prepare('SELECT id FROM students WHERE id = ? AND company_id = ?');
    $check->execute([$studentId, $companyId]);
    $exists = $check->fetchColumn();
    $check->closeCursor();
    if (!$exists) {
        json_response(['error' => 'Student not found.'], 404);
    }

    $stmt = $pdo->prepare('UPDATE students SET face_descriptor = ?, face_photo = ?, enrolled_at = NOW() WHERE id = ? AND company_id = ?');
    $stmt->execute([json_encode($descriptor), $photo, $studentId, $companyId]);

    json_response(['ok' => true, 'enrolled' => true, 'length' => $len]);
}

json_response(['error' => 'Method not allowed.'], 405);
