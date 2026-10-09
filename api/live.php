<?php
declare(strict_types=1);

require __DIR__ . '/_bootstrap.php';

/**
 * Live proctoring relay (frame-push transport).
 *
 * Student (during an active exam) POSTs a small camera snapshot + the current AI proctor status
 * every couple of seconds. A proctor's "live wall" polls mode=wall for all active candidates and
 * renders each latest snapshot as a thumbnail with live status badges. mode=frame streams the
 * latest JPEG for one session.
 *
 * This reuses the existing PHP + MySQL + filesystem stack — no new server process, no WebRTC/TURN.
 * Latency is ~the push interval (a couple of seconds), which is exactly how commercial proctoring
 * "monitoring grids" work.
 */

const LIVE_ONLINE_WINDOW_SEC = 12;   // pushed within this window ⇒ "online" dot
const LIVE_WALL_WINDOW_SEC = 40;     // shown on the wall at all if pushed within this window

function live_datetime_to_ms(?string $dt): ?int {
    if ($dt === null) return null;
    $ts = strtotime($dt);
    if ($ts === false) return null;
    return (int)($ts * 1000);
}

function live_table_exists(PDO $pdo): bool {
    static $exists = null;
    if ($exists !== null) return $exists;
    $stmt = $pdo->prepare("SELECT 1 FROM information_schema.TABLES
                           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'live_proctor_frames' LIMIT 1");
    $stmt->execute();
    $exists = (bool)$stmt->fetchColumn();
    $stmt->closeCursor();
    return $exists;
}

function ensure_live_schema(PDO $pdo): bool {
    if (live_table_exists($pdo)) return true;
    try {
        $pdo->exec("CREATE TABLE IF NOT EXISTS live_proctor_frames (
          session_id          BIGINT UNSIGNED NOT NULL PRIMARY KEY,
          company_id          INT NOT NULL DEFAULT 1,
          exam_id             VARCHAR(64) NOT NULL,
          student_id          VARCHAR(64) NOT NULL,
          face_count          INT NULL,
          gaze_away           TINYINT(1) NOT NULL DEFAULT 0,
          eyes_closed         TINYINT(1) NOT NULL DEFAULT 0,
          mouth_open          TINYINT(1) NOT NULL DEFAULT 0,
          phone               TINYINT(1) NOT NULL DEFAULT 0,
          multiple_faces      TINYINT(1) NOT NULL DEFAULT 0,
          risk_score          INT NULL,
          risk_level          VARCHAR(8) NULL,
          ai_note             VARCHAR(255) NULL,
          last_violation_type VARCHAR(32) NULL,
          last_violation_at   TIMESTAMP NULL DEFAULT NULL,
          frame_path          VARCHAR(1024) NOT NULL,
          size_bytes          INT NOT NULL DEFAULT 0,
          started_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          INDEX idx_live_company_updated (company_id, updated_at)
        ) ENGINE=InnoDB");
    } catch (Throwable $e) {
        // fall through to re-check (DB user may lack CREATE but table already present)
    }
    return live_table_exists($pdo);
}

function live_storage_root(): string {
    return realpath(__DIR__ . '/..') . DIRECTORY_SEPARATOR . 'storage' . DIRECTORY_SEPARATOR . 'live';
}

function live_ensure_dir(string $dir): void {
    if (is_dir($dir)) return;
    if (!@mkdir($dir, 0775, true) && !is_dir($dir)) {
        throw new RuntimeException('Failed to create live storage directory.');
    }
}

/** Decode a data-URL / base64 JPEG payload into raw bytes, or null if not a usable image. */
function live_decode_jpeg(?string $dataUrl): ?string {
    if (!is_string($dataUrl) || $dataUrl === '') return null;
    $b64 = $dataUrl;
    $comma = strpos($dataUrl, ',');
    if (strncmp($dataUrl, 'data:', 5) === 0 && $comma !== false) {
        $b64 = substr($dataUrl, $comma + 1);
    }
    $bytes = base64_decode($b64, true);
    if ($bytes === false || strlen($bytes) < 128) return null;
    if (strlen($bytes) > 2 * 1024 * 1024) return null; // sanity cap: snapshots are tiny
    // JPEG magic (FF D8) or PNG magic.
    $isJpeg = (substr($bytes, 0, 2) === "\xFF\xD8");
    $isPng  = (substr($bytes, 0, 8) === "\x89PNG\r\n\x1a\n");
    if (!$isJpeg && !$isPng) return null;
    return $bytes;
}

$method = $_SERVER['REQUEST_METHOD'];
$schemaReady = ensure_live_schema($pdo);
if ($schemaReady) {
    // v7 virtual-proctor fields on pre-existing installs.
    db_add_column_if_missing($pdo, 'live_proctor_frames', 'risk_score', "INT NULL AFTER multiple_faces");
    db_add_column_if_missing($pdo, 'live_proctor_frames', 'risk_level', "VARCHAR(8) NULL AFTER risk_score");
    db_add_column_if_missing($pdo, 'live_proctor_frames', 'ai_note', "VARCHAR(255) NULL AFTER risk_level");
    // When a proctor opens a candidate we set this a few seconds ahead; while it's in the future the
    // student's push loop switches to a high frame-rate so the focused view looks like live video.
    db_add_column_if_missing($pdo, 'live_proctor_frames', 'watched_until', "TIMESTAMP NULL DEFAULT NULL AFTER ai_note");
}

// Seconds a single WATCH ping keeps a candidate in high-frame-rate mode. The proctor's modal re-pings
// well within this window; once it stops (modal closed), the student eases back to the idle cadence.
const LIVE_WATCH_TTL_SEC = 6;

if ($method === 'GET') {
    $companyId = require_company_id();
    $mode = isset($_GET['mode']) ? strtolower(trim((string)$_GET['mode'])) : 'wall';

    if ($mode === 'frame') {
        // The frame URL is loaded as an <img> src — browsers never send custom auth headers on
        // image requests, so require_staff() would always 401. Instead it's protected by an HMAC
        // signature minted only by mode=wall (which already requires staff auth); a bare companyId +
        // sessionId is no longer sufficient (that was a guessable-ID IDOR).
        $sessionId = isset($_GET['sessionId']) ? (int)$_GET['sessionId'] : 0;
        $sig = trim((string)($_GET['sig'] ?? ''));
        if ($sessionId <= 0 || !$schemaReady || !media_url_signature_valid('live', $companyId, $sessionId, '', $sig)) {
            http_response_code(404);
            header('Content-Type: text/plain');
            echo 'Not found';
            exit;
        }
        $stmt = $pdo->prepare("SELECT frame_path FROM live_proctor_frames
                               WHERE session_id = ? AND company_id = ? LIMIT 1");
        $stmt->execute([$sessionId, $companyId]);
        $row = $stmt->fetch();
        $stmt->closeCursor();
        $path = $row['frame_path'] ?? null;
        if (!$path || !is_file($path)) {
            http_response_code(404);
            header('Content-Type: text/plain');
            echo 'Not found';
            exit;
        }
        header('Content-Type: image/jpeg');
        // The wall requests each frame version at a unique URL (…&_t=updatedAt), so a given URL's
        // bytes never change — let the browser cache it briefly instead of refetching every render.
        header('Cache-Control: private, max-age=60');
        header('Content-Length: ' . (string)filesize($path));
        readfile($path);
        exit;
    }

    // mode = wall — proctor-only live roster of active candidates.
    require_role(['ADMIN', 'SUPER_ADMIN', 'PROCTOR']);
    if (!$schemaReady) {
        json_response(['live' => [], 'serverTime' => db_now_ms()]);
    }
    $scriptDir = rtrim(str_replace('\\', '/', dirname((string)($_SERVER['SCRIPT_NAME'] ?? '/api'))), '/');
    if ($scriptDir === '') $scriptDir = '/api';

    $stmt = $pdo->prepare("SELECT lpf.*,
                                  TIMESTAMPDIFF(SECOND, lpf.updated_at, NOW()) AS age_sec
                           FROM live_proctor_frames lpf
                           WHERE lpf.company_id = ?
                             AND lpf.updated_at >= DATE_SUB(NOW(), INTERVAL ? SECOND)
                           ORDER BY lpf.updated_at DESC");
    $stmt->execute([$companyId, LIVE_WALL_WINDOW_SEC]);
    $rows = $stmt->fetchAll();
    $stmt->closeCursor();

    $live = array_map(function ($r) use ($scriptDir, $companyId) {
        $sid = (int)$r['session_id'];
        $age = (int)($r['age_sec'] ?? 999);
        return [
            'sessionId' => $sid,
            'examId' => $r['exam_id'],
            'studentId' => $r['student_id'],
            'faceCount' => $r['face_count'] !== null ? (int)$r['face_count'] : null,
            'gazeAway' => (bool)$r['gaze_away'],
            'eyesClosed' => (bool)$r['eyes_closed'],
            'mouthOpen' => (bool)$r['mouth_open'],
            'phone' => (bool)$r['phone'],
            'multipleFaces' => (bool)$r['multiple_faces'],
            'riskScore' => isset($r['risk_score']) && $r['risk_score'] !== null ? (int)$r['risk_score'] : null,
            'riskLevel' => $r['risk_level'] ?? null,
            'aiNote' => $r['ai_note'] ?? null,
            'lastViolationType' => $r['last_violation_type'] ?? null,
            'lastViolationAt' => live_datetime_to_ms($r['last_violation_at'] ?? null),
            'updatedAt' => live_datetime_to_ms($r['updated_at'] ?? null),
            'startedAt' => live_datetime_to_ms($r['started_at'] ?? null),
            'online' => $age <= LIVE_ONLINE_WINDOW_SEC,
            'ageSec' => $age,
            'frameUrl' => "{$scriptDir}/live.php?mode=frame&sessionId={$sid}&companyId={$companyId}&sig=" . urlencode(media_url_signature('live', $companyId, $sid)),
        ];
    }, $rows);

    json_response(['live' => $live, 'serverTime' => db_now_ms()]);
}

if ($method === 'POST') {
    $payload = json_input();
    $companyId = require_company_id($payload);
    $action = strtoupper(trim((string)($payload['action'] ?? 'PUSH')));

    if ($action === 'PUSH') {
        if (!$schemaReady) {
            json_response(['ok' => false, 'error' => 'LIVE_SCHEMA_UNAVAILABLE'], 200);
        }
        $sessionId = isset($payload['sessionId']) && is_numeric($payload['sessionId']) ? (int)$payload['sessionId'] : 0;
        $examId = trim((string)($payload['examId'] ?? ''));
        $studentId = trim((string)($payload['studentId'] ?? ''));
        if ($sessionId <= 0 || $examId === '' || $studentId === '') {
            json_response(['ok' => false, 'error' => 'sessionId, examId and studentId are required.'], 400);
        }
        require_candidate_or_staff($examId, $studentId, (int)$companyId);

        // The session must belong to this company AND to the exam/candidate the push claims to be
        // (defence in depth). Session ids are sequential, so checking the company alone let any
        // client overwrite another candidate's live tile (frame + status) by guessing a neighbour id.
        $chk = $pdo->prepare("SELECT id FROM exam_sessions WHERE id = ? AND company_id = ? AND exam_id = ? AND student_id = ? LIMIT 1");
        $chk->execute([$sessionId, $companyId, $examId, $studentId]);
        if (!$chk->fetch()) {
            $chk->closeCursor();
            json_response(['ok' => false, 'error' => 'SESSION_NOT_FOUND'], 404);
        }
        $chk->closeCursor();

        $status = is_array($payload['status'] ?? null) ? $payload['status'] : [];
        $faceCount = isset($status['faceCount']) && is_numeric($status['faceCount']) ? (int)$status['faceCount'] : null;
        $gazeAway = !empty($status['gazeAway']) ? 1 : 0;
        $eyesClosed = !empty($status['eyesClosed']) ? 1 : 0;
        $mouthOpen = !empty($status['mouthOpen']) ? 1 : 0;
        $phone = !empty($status['phone']) ? 1 : 0;
        $multipleFaces = (!empty($status['multipleFaces']) || ($faceCount !== null && $faceCount >= 2)) ? 1 : 0;
        $riskScore = isset($status['riskScore']) && is_numeric($status['riskScore'])
            ? max(0, min(100, (int)$status['riskScore'])) : null;
        $riskLevel = isset($status['riskLevel']) && in_array((string)$status['riskLevel'], ['low', 'medium', 'high'], true)
            ? (string)$status['riskLevel'] : null;
        $aiNote = isset($status['aiNote']) && is_string($status['aiNote']) && $status['aiNote'] !== ''
            ? substr($status['aiNote'], 0, 255) : null;
        $lastViolationType = isset($payload['lastViolationType']) && $payload['lastViolationType'] !== ''
            ? substr((string)$payload['lastViolationType'], 0, 32) : null;

        $bytes = live_decode_jpeg($payload['image'] ?? null);
        $root = live_storage_root();
        $dir = $root . DIRECTORY_SEPARATOR . $companyId;
        live_ensure_dir($dir);
        $path = $dir . DIRECTORY_SEPARATOR . $sessionId . '.jpg';
        $size = 0;
        if ($bytes !== null) {
            $written = file_put_contents($path, $bytes, LOCK_EX);
            if ($written !== false) $size = (int)$written;
        }
        // If no new image this push but a prior frame exists, keep the old path.
        if ($size === 0 && !is_file($path)) {
            // No image at all yet — still record status, point frame_path at (missing) path.
        }

        $lastViolClause = $lastViolationType !== null ? 'NOW()' : 'last_violation_at';
        $sql = "INSERT INTO live_proctor_frames
                  (session_id, company_id, exam_id, student_id, face_count, gaze_away, eyes_closed,
                   mouth_open, phone, multiple_faces, risk_score, risk_level, ai_note,
                   last_violation_type, last_violation_at, frame_path, size_bytes)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, "
                . ($lastViolationType !== null ? 'NOW()' : 'NULL')
                . ", ?, ?)
                ON DUPLICATE KEY UPDATE
                  face_count = VALUES(face_count),
                  gaze_away = VALUES(gaze_away),
                  eyes_closed = VALUES(eyes_closed),
                  mouth_open = VALUES(mouth_open),
                  phone = VALUES(phone),
                  multiple_faces = VALUES(multiple_faces),
                  risk_score = COALESCE(VALUES(risk_score), risk_score),
                  risk_level = COALESCE(VALUES(risk_level), risk_level),
                  ai_note = COALESCE(VALUES(ai_note), ai_note),
                  last_violation_type = COALESCE(VALUES(last_violation_type), last_violation_type),
                  last_violation_at = " . ($lastViolationType !== null ? 'NOW()' : 'last_violation_at') . ",
                  frame_path = VALUES(frame_path),
                  size_bytes = VALUES(size_bytes),
                  updated_at = NOW()";
        $stmt = $pdo->prepare($sql);
        $stmt->execute([
            $sessionId, $companyId, $examId, $studentId, $faceCount, $gazeAway, $eyesClosed,
            $mouthOpen, $phone, $multipleFaces, $riskScore, $riskLevel, $aiNote,
            $lastViolationType, $path, $size,
        ]);

        // Tell the student whether a proctor is actively watching right now. The upsert above never
        // touches watched_until, so a WATCH ping set moments ago survives here. When true the client
        // ramps its push rate up (see the adaptive loop in ExamTake) for near-real-time video.
        $wq = $pdo->prepare("SELECT (watched_until IS NOT NULL AND watched_until > NOW()) AS watched
                             FROM live_proctor_frames WHERE session_id = ? AND company_id = ? LIMIT 1");
        $wq->execute([$sessionId, $companyId]);
        $watched = (bool)$wq->fetchColumn();
        $wq->closeCursor();

        json_response(['ok' => true, 'watched' => $watched]);
    }

    if ($action === 'WATCH') {
        // A proctor opened this candidate's live view — mark the session "watched" so the student's
        // next pushes come at a high frame rate. Staff-only: students must never raise their own rate.
        require_role(['ADMIN', 'SUPER_ADMIN', 'PROCTOR'], $payload);
        if ($schemaReady) {
            $sessionId = isset($payload['sessionId']) && is_numeric($payload['sessionId']) ? (int)$payload['sessionId'] : 0;
            if ($sessionId > 0) {
                $u = $pdo->prepare("UPDATE live_proctor_frames
                                    SET watched_until = DATE_ADD(NOW(), INTERVAL ? SECOND)
                                    WHERE session_id = ? AND company_id = ?");
                $u->execute([LIVE_WATCH_TTL_SEC, $sessionId, $companyId]);
            }
        }
        json_response(['ok' => true]);
    }

    if ($action === 'STOP') {
        // Student leaving the exam — drop them off the wall immediately.
        if ($schemaReady) {
            $sessionId = isset($payload['sessionId']) && is_numeric($payload['sessionId']) ? (int)$payload['sessionId'] : 0;
            if ($sessionId > 0) {
                // Only that candidate (or staff) may take their tile off the wall — session ids are
                // sequential, so this used to let anyone blank the whole wall.
                $own = $pdo->prepare('SELECT exam_id, student_id FROM exam_sessions WHERE id = ? AND company_id = ? LIMIT 1');
                $own->execute([$sessionId, $companyId]);
                $ownRow = $own->fetch();
                $own->closeCursor();
                if (!$ownRow) {
                    json_response(['ok' => true]);
                }
                require_candidate_or_staff((string)$ownRow['exam_id'], (string)$ownRow['student_id'], (int)$companyId);
                $del = $pdo->prepare("DELETE FROM live_proctor_frames WHERE session_id = ? AND company_id = ?");
                $del->execute([$sessionId, $companyId]);
            }
        }
        json_response(['ok' => true]);
    }

    json_response(['ok' => false, 'error' => 'Invalid action.'], 400);
}

json_response(['error' => 'Method not allowed.'], 405);
