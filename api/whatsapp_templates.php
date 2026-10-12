<?php
declare(strict_types=1);

/**
 * WhatsApp message text managed from ProctorGuard (Settings → WhatsApp → Message text).
 *
 * WhatsApp only delivers business-initiated messages through templates Meta has approved, and a
 * template's text, variables and buttons are fixed once approved. So "editing the message" here
 * means: write the text with readable placeholders ({StudentName}, {Link}, …), ProctorGuard submits
 * it to Meta as a NEW template version, and switches to it by itself once Meta approves it. The
 * version in use keeps sending until then, so an edit never interrupts messages and never touches
 * Meta's "one edit a day" limit on approved templates.
 *
 * Each version remembers which placeholders it uses and in what order (fields_json); a send fills
 * exactly those. That is what lets a reminder be written without {Link} and without a button.
 *
 * Library only (required by whatsapp.php); the staff endpoints live in whatsapp.php.
 */

/** Placeholders each message kind can use: key => [label shown in the editor, sample value sent to Meta]. */
const WHATSAPP_TEMPLATE_FIELDS = [
    'EXAM' => [
        'StudentName' => ['Candidate name', 'Asha Rao'],
        'ExamTitle' => ['Exam title', 'Sales Assessment Q4'],
        'ExamWindow' => ['Exam date & time (opens – closes)', '15 Oct 2026, 10:00 – 18:00 IST'],
        'StartTime' => ['Opens at', '15 Oct 2026, 10:00 IST'],
        'EndTime' => ['Closes at', '15 Oct 2026, 18:00 IST'],
        'Duration' => ['Duration', '30 minutes'],
        'QuestionCount' => ['Number of questions', '25'],
        'Link' => ['Personal exam link', 'https://proctor.lsc-crm.in?Ab3dE5gH9k'],
    ],
    'REQUEST_UPDATE' => [
        'EmployeeName' => ['Employee name', 'Priya Sharma'],
        'RequestRef' => ['Request reference', '#42'],
        'ExamTitle' => ['Exam title', 'Sales Assessment Q4'],
        'Status' => ['Status message', 'approved — 25 candidates invited'],
    ],
];

/** Variable order of the templates named in .env (created before versions were managed here). */
const WHATSAPP_LEGACY_FIELDS = [
    'INVITE' => ['StudentName', 'ExamTitle', 'ExamWindow', 'Duration', 'Link'],
    'REMINDER' => ['StudentName', 'ExamTitle', 'ExamWindow', 'Link'],
    'REQUEST_UPDATE' => ['EmployeeName', 'RequestRef', 'ExamTitle', 'Status'],
];

const WHATSAPP_TEMPLATE_BODY_MAX = 1024;   // Meta's limit for a template body
const WHATSAPP_TEMPLATE_BUTTON_MAX = 25;   // Meta's limit for a button label
// A version waiting for Meta's review is re-checked at most this often when messages are being sent.
const WHATSAPP_TEMPLATE_RECHECK_SECONDS = 60;

function whatsapp_template_field_defs(string $kind): array {
    return WHATSAPP_TEMPLATE_FIELDS[$kind === 'REQUEST_UPDATE' ? 'REQUEST_UPDATE' : 'EXAM'];
}

function ensure_whatsapp_template_schema(PDO $pdo): void {
    static $done = false;
    if ($done) {
        return;
    }
    $done = true;
    $pdo->exec("CREATE TABLE IF NOT EXISTS whatsapp_templates (
      id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      kind            VARCHAR(20) NOT NULL,
      name            VARCHAR(128) NOT NULL,
      language        VARCHAR(16) NOT NULL DEFAULT 'en',
      body_text       TEXT NOT NULL,
      fields_json     TEXT NOT NULL,
      button_text     VARCHAR(40) NULL,
      status          VARCHAR(16) NOT NULL DEFAULT 'PENDING',
      meta_id         VARCHAR(64) NULL,
      meta_status     VARCHAR(32) NULL,
      meta_category   VARCHAR(32) NULL,
      rejected_reason VARCHAR(255) NULL,
      created_by      VARCHAR(255) NULL,
      created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      checked_at      TIMESTAMP NULL,
      activated_at    TIMESTAMP NULL,
      UNIQUE KEY uq_whatsapp_templates_name (name),
      INDEX idx_whatsapp_templates_kind (kind, status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
}

/**
 * Turn editor text into what Meta stores. Returns [metaBody, fields, errors]: every {Placeholder}
 * becomes {{n}} numbered by first appearance, and fields lists them in that order.
 */
function whatsapp_template_compile(string $kind, string $text): array {
    $defs = whatsapp_template_field_defs($kind);
    $text = str_replace(["\r\n", "\r", "\t"], ["\n", "\n", ' '], $text);
    $text = (string)preg_replace("/[ \u{00A0}]+\n/u", "\n", $text);
    $text = trim((string)preg_replace("/\n{3,}/", "\n\n", $text));
    $errors = [];
    if ($text === '') {
        return ['', [], ['Write the message text.']];
    }
    if (strpos($text, '{{') !== false || strpos($text, '}}') !== false) {
        $errors[] = 'Use single braces for placeholders, e.g. {StudentName} — not {{1}}.';
    }
    if (preg_match('/ {5,}/', $text) === 1) {
        $errors[] = 'WhatsApp does not allow more than four spaces in a row.';
    }
    $fields = [];
    $metaBody = (string)preg_replace_callback('/\{([A-Za-z][A-Za-z0-9]*)\}/', static function (array $m) use ($defs, &$fields, &$errors): string {
        $key = null;
        foreach (array_keys($defs) as $candidate) {
            if (strcasecmp($candidate, $m[1]) === 0) {
                $key = $candidate;
                break;
            }
        }
        if ($key === null) {
            $errors[] = 'Unknown placeholder {' . $m[1] . '}. Available: {' . implode('}, {', array_keys($defs)) . '}.';
            return $m[0];
        }
        $index = array_search($key, $fields, true);
        if ($index === false) {
            $fields[] = $key;
            $index = count($fields) - 1;
        }
        return '{{' . ($index + 1) . '}}';
    }, $text);
    if (preg_match('/^\{\{\d+\}\}/', $metaBody) === 1 || preg_match('/\{\{\d+\}\}$/', $metaBody) === 1) {
        $errors[] = 'WhatsApp does not allow the message to start or end with a placeholder — add some text before the first and after the last one.';
    }
    if (preg_match('/\}\}\s*\{\{/', $metaBody) === 1) {
        $errors[] = 'Put some text between two placeholders.';
    }
    if (mb_strlen($metaBody, 'UTF-8') > WHATSAPP_TEMPLATE_BODY_MAX) {
        $errors[] = 'The message is ' . mb_strlen($metaBody, 'UTF-8') . ' characters; WhatsApp allows at most ' . WHATSAPP_TEMPLATE_BODY_MAX . '.';
    }
    return [$metaBody, $fields, array_values(array_unique($errors))];
}

/** Meta body text ({{n}}) back to editor text ({Placeholder}) for the given variable order. */
function whatsapp_template_decompile(string $metaBody, array $fields): string {
    return (string)preg_replace_callback('/\{\{\s*(\d+)\s*\}\}/', static function (array $m) use ($fields): string {
        $key = $fields[(int)$m[1] - 1] ?? null;
        return $key !== null ? '{' . $key . '}' : $m[0];
    }, $metaBody);
}

function whatsapp_template_row_public(array $row): array {
    $fields = json_decode((string)$row['fields_json'], true);
    return [
        'id' => (int)$row['id'],
        'kind' => (string)$row['kind'],
        'name' => (string)$row['name'],
        'status' => (string)$row['status'],
        'metaStatus' => $row['meta_status'] ?? null,
        'category' => $row['meta_category'] ?? null,
        'body' => (string)$row['body_text'],
        'fields' => is_array($fields) ? array_values($fields) : [],
        'buttonText' => $row['button_text'] !== null && $row['button_text'] !== '' ? (string)$row['button_text'] : null,
        'rejectedReason' => $row['rejected_reason'] ?? null,
        'createdBy' => $row['created_by'] ?? null,
        'createdAt' => isset($row['created_at']) ? strtotime((string)$row['created_at']) * 1000 : null,
        'activatedAt' => !empty($row['activated_at']) ? strtotime((string)$row['activated_at']) * 1000 : null,
    ];
}

/** Make one version the one in use for its kind; the previous one is kept as RETIRED (can be restored). */
function whatsapp_template_activate(PDO $pdo, int $id): void {
    $stmt = $pdo->prepare('SELECT kind FROM whatsapp_templates WHERE id = ? LIMIT 1');
    $stmt->execute([$id]);
    $kind = $stmt->fetchColumn();
    $stmt->closeCursor();
    if ($kind === false) {
        return;
    }
    $retire = $pdo->prepare("UPDATE whatsapp_templates SET status = 'RETIRED' WHERE kind = ? AND status = 'ACTIVE' AND id <> ?");
    $retire->execute([(string)$kind, $id]);
    $retire->closeCursor();
    $activate = $pdo->prepare("UPDATE whatsapp_templates SET status = 'ACTIVE', activated_at = NOW() WHERE id = ?");
    $activate->execute([$id]);
    $activate->closeCursor();
}

/**
 * Ask Meta how the versions under review are doing and act on the answer:
 *   approved (and still Utility)  → becomes the version in use
 *   approved but moved to Marketing → HELD (an admin decides; marketing messages are capped per person)
 *   rejected / disabled             → REJECTED with Meta's reason
 * $force skips the per-version throttle (the Settings screen's Refresh). Returns how many changed.
 */
function whatsapp_templates_refresh(PDO $pdo, array $cfg, ?string $kind = null, bool $force = false): int {
    ensure_whatsapp_template_schema($pdo);
    $sql = "SELECT * FROM whatsapp_templates WHERE status = 'PENDING'";
    $params = [];
    if ($kind !== null) {
        $sql .= ' AND kind = ?';
        $params[] = $kind;
    }
    if (!$force) {
        $sql .= ' AND (checked_at IS NULL OR checked_at < NOW() - INTERVAL ' . WHATSAPP_TEMPLATE_RECHECK_SECONDS . ' SECOND)';
    }
    $stmt = $pdo->prepare($sql . ' ORDER BY id ASC');
    $stmt->execute($params);
    $rows = $stmt->fetchAll();
    $stmt->closeCursor();
    $changed = 0;
    foreach ($rows as $row) {
        $live = whatsapp_meta_template($cfg, (string)$row['name'], true);
        $touch = $pdo->prepare('UPDATE whatsapp_templates SET checked_at = NOW(), meta_status = COALESCE(?, meta_status), meta_category = COALESCE(?, meta_category) WHERE id = ?');
        $touch->execute([$live['status'] ?? null, $live['category'] ?? null, (int)$row['id']]);
        $touch->closeCursor();
        if ($live === null) {
            continue; // Meta unreachable: try again later
        }
        $status = (string)$live['status'];
        if ($status === 'APPROVED') {
            if (($live['category'] ?? '') === 'MARKETING') {
                $upd = $pdo->prepare("UPDATE whatsapp_templates SET status = 'HELD' WHERE id = ?");
                $upd->execute([(int)$row['id']]);
                $upd->closeCursor();
            } else {
                whatsapp_template_activate($pdo, (int)$row['id']);
            }
            $changed++;
        } elseif (in_array($status, ['REJECTED', 'DISABLED', 'NOT_FOUND', 'PAUSED'], true)) {
            $upd = $pdo->prepare("UPDATE whatsapp_templates SET status = 'REJECTED', rejected_reason = ? WHERE id = ?");
            $reason = $status === 'NOT_FOUND' ? 'The template no longer exists in WhatsApp Manager.' : (string)($live['rejectedReason'] ?? $status);
            $upd->execute([mb_substr($reason, 0, 255, 'UTF-8'), (int)$row['id']]);
            $upd->closeCursor();
            $changed++;
        }
    }
    return $changed;
}

/**
 * The template a message of this kind is sent with right now: {name, fields, managed}. A version
 * approved from the editor wins; otherwise the template named in .env with its original variable
 * order. Versions still under review are checked on the way (throttled), so an approval takes
 * effect on the next message without anyone opening Settings.
 */
function whatsapp_active_template(PDO $pdo, array $cfg, string $kind): array {
    static $memo = [];
    if (isset($memo[$kind])) {
        return $memo[$kind];
    }
    $fallback = [
        'name' => (string)($cfg['templates'][$kind] ?? ''),
        'fields' => WHATSAPP_LEGACY_FIELDS[$kind] ?? [],
        'managed' => false,
        'id' => null,
    ];
    try {
        ensure_whatsapp_template_schema($pdo);
        if ($cfg['provider'] === 'meta') {
            whatsapp_templates_refresh($pdo, $cfg, $kind);
        }
        $stmt = $pdo->prepare("SELECT id, name, fields_json FROM whatsapp_templates WHERE kind = ? AND status = 'ACTIVE' ORDER BY activated_at DESC, id DESC LIMIT 1");
        $stmt->execute([$kind]);
        $row = $stmt->fetch();
        $stmt->closeCursor();
        if ($row) {
            $fields = json_decode((string)$row['fields_json'], true);
            if (is_array($fields)) {
                return $memo[$kind] = ['name' => (string)$row['name'], 'fields' => array_values($fields), 'managed' => true, 'id' => (int)$row['id']];
            }
        }
    } catch (Throwable $e) {
        error_log('[whatsapp] active template lookup failed: ' . $e->getMessage());
    }
    return $memo[$kind] = $fallback;
}

/**
 * Validate the editor's text and submit it to Meta as a new Utility template version. Returns
 * ['ok' => true, 'row' => …] or ['ok' => false, 'errors' => [...]]. Nothing changes for messages
 * being sent until Meta approves the version.
 */
function whatsapp_template_create(PDO $pdo, array $cfg, string $kind, string $text, ?string $buttonText, string $actor): array {
    ensure_whatsapp_template_schema($pdo);
    $t = $cfg['_transport']['meta'] ?? null;
    if ($cfg['provider'] !== 'meta' || empty($cfg['ready']) || $t === null || (string)($t['wabaId'] ?? '') === '') {
        return ['ok' => false, 'errors' => ['Editing message text needs the Meta provider with WHATSAPP_META_WABA_ID set on the server.']];
    }
    [$metaBody, $fields, $errors] = whatsapp_template_compile($kind, $text);
    $isExamKind = in_array($kind, WHATSAPP_EXAM_KINDS, true);
    $buttonText = $buttonText !== null ? trim($buttonText) : null;
    if ($buttonText === '') {
        $buttonText = null;
    }
    if ($buttonText !== null) {
        if (!$isExamKind) {
            $errors[] = 'This message has no exam link, so it cannot have a link button.';
        } elseif (mb_strlen($buttonText, 'UTF-8') > WHATSAPP_TEMPLATE_BUTTON_MAX) {
            $errors[] = 'The button label can be at most ' . WHATSAPP_TEMPLATE_BUTTON_MAX . ' characters.';
        } elseif (preg_match('/[\r\n{}]/', $buttonText) === 1) {
            $errors[] = 'The button label cannot contain line breaks or placeholders.';
        }
    }
    if ($kind === 'INVITE' && $buttonText === null && !in_array('Link', $fields, true)) {
        $errors[] = 'An invitation must give the candidate their exam link: keep {Link} in the text or switch the link button on.';
    }
    $pending = db_scalar_int($pdo, "SELECT COUNT(*) FROM whatsapp_templates WHERE kind = ? AND status = 'PENDING'", [$kind]);
    if ($pending > 0) {
        $errors[] = 'A version of this message is already waiting for WhatsApp\'s review. Wait for the result (or remove it) before submitting another.';
    }
    if ($errors) {
        return ['ok' => false, 'errors' => array_values(array_unique($errors))];
    }

    $defs = whatsapp_template_field_defs($kind);
    $origin = rtrim((string)pg_env('APP_ORIGIN', 'https://proctor.lsc-crm.in'), '/');
    $bodyComponent = ['type' => 'BODY', 'text' => $metaBody];
    if (count($fields) > 0) {
        $bodyComponent['example'] = ['body_text' => [array_map(static fn(string $f) => $defs[$f][1], $fields)]];
    }
    $components = [$bodyComponent];
    if ($buttonText !== null) {
        $components[] = ['type' => 'BUTTONS', 'buttons' => [[
            'type' => 'URL',
            'text' => $buttonText,
            'url' => $origin . '/{{1}}',
            'example' => [$origin . '/Ab3dE5gH9k'],
        ]]];
    }
    $name = 'pg_exam_' . strtolower($kind) . '_' . gmdate('ymdHis');
    $language = (string)$cfg['language'];
    $url = rtrim((string)$t['baseUrl'], '/') . '/' . rawurlencode((string)$t['version']) . '/' . rawurlencode((string)$t['wabaId']) . '/message_templates';
    $res = whatsapp_http_post_json($url, ['Authorization: Bearer ' . $t['accessToken']], [
        'name' => $name,
        'language' => $language,
        'category' => 'UTILITY',
        'components' => $components,
    ]);
    $metaId = (string)($res['body']['id'] ?? '');
    if ($res['error'] !== null || (int)$res['status'] < 200 || (int)$res['status'] >= 300 || $metaId === '') {
        $e = is_array($res['body']['error'] ?? null) ? $res['body']['error'] : [];
        $message = trim((string)($e['error_user_msg'] ?? $e['message'] ?? ($res['error'] ?? 'WhatsApp did not accept the template.')));
        $title = trim((string)($e['error_user_title'] ?? ''));
        return ['ok' => false, 'errors' => [whatsapp_mask('WhatsApp did not accept it: ' . ($title !== '' ? $title . ' — ' : '') . $message, $cfg)]];
    }

    $insert = $pdo->prepare("INSERT INTO whatsapp_templates (kind, name, language, body_text, fields_json, button_text, status, meta_id, meta_status, meta_category, created_by)
                             VALUES (?, ?, ?, ?, ?, ?, 'PENDING', ?, ?, ?, ?)");
    $insert->execute([
        $kind, $name, $language, whatsapp_template_decompile($metaBody, $fields), (string)json_encode($fields), $buttonText,
        $metaId, strtoupper((string)($res['body']['status'] ?? 'PENDING')), strtoupper((string)($res['body']['category'] ?? 'UTILITY')),
        mb_substr($actor, 0, 255, 'UTF-8'),
    ]);
    $insert->closeCursor();
    $id = (int)$pdo->lastInsertId();
    // Meta sometimes approves within seconds: pick that up straight away.
    whatsapp_templates_refresh($pdo, $cfg, $kind, true);
    $stmt = $pdo->prepare('SELECT * FROM whatsapp_templates WHERE id = ?');
    $stmt->execute([$id]);
    $row = $stmt->fetch();
    $stmt->closeCursor();
    return ['ok' => true, 'row' => whatsapp_template_row_public($row)];
}

/**
 * Everything the editor screen shows for one kind: the placeholders, the template in use (text read
 * from Meta for the .env templates, so edits made in WhatsApp Manager show too) and the versions
 * made here.
 */
function whatsapp_template_editor_state(PDO $pdo, array $cfg, string $kind): array {
    ensure_whatsapp_template_schema($pdo);
    $defs = whatsapp_template_field_defs($kind);
    $active = whatsapp_active_template($pdo, $cfg, $kind);
    $live = $active['name'] !== '' ? whatsapp_meta_template($cfg, $active['name']) : null;
    $stmt = $pdo->prepare('SELECT * FROM whatsapp_templates WHERE kind = ? ORDER BY id DESC LIMIT 20');
    $stmt->execute([$kind]);
    $versions = array_map('whatsapp_template_row_public', $stmt->fetchAll());
    $stmt->closeCursor();
    $fields = [];
    foreach ($defs as $key => [$label, $sample]) {
        $fields[] = ['key' => $key, 'label' => $label, 'sample' => $sample];
    }
    return [
        'kind' => $kind,
        'fields' => $fields,
        'supportsButton' => in_array($kind, WHATSAPP_EXAM_KINDS, true),
        'active' => $active['name'] === '' ? null : [
            'name' => $active['name'],
            'managed' => (bool)$active['managed'],
            'status' => $live['status'] ?? null,
            'category' => $live['category'] ?? null,
            'body' => $live !== null && isset($live['bodyText']) ? whatsapp_template_decompile((string)$live['bodyText'], $active['fields']) : null,
            'buttonText' => $live['buttonText'] ?? null,
            'fields' => $active['fields'],
            'problems' => $live !== null ? whatsapp_template_problems($live, $kind, count($active['fields'])) : [],
        ],
        'versions' => $versions,
    ];
}
