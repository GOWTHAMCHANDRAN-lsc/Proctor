<?php
declare(strict_types=1);

require_once __DIR__ . '/_bootstrap.php';
require_once __DIR__ . '/notify.php';

$method = $_SERVER['REQUEST_METHOD'];

/** Brute-force throttle for login attempts (V5). Best-effort; never blocks on its own errors. */
function ensure_login_attempts_table(PDO $pdo): void {
    try {
        $pdo->exec("CREATE TABLE IF NOT EXISTS login_attempts (
            id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
            ip VARCHAR(64) NULL,
            email VARCHAR(255) NULL,
            success TINYINT(1) NOT NULL DEFAULT 0,
            attempted_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_la_ip (ip, attempted_at),
            INDEX idx_la_email (email, attempted_at)
        ) ENGINE=InnoDB");
    } catch (Throwable $e) { /* best effort */ }
}
function login_rate_limited(PDO $pdo, string $ip, string $email): bool {
    try {
        // Block when a single IP or a single email accumulates too many failures in 15 minutes.
        $ipFails = db_scalar_int($pdo, "SELECT COUNT(*) FROM login_attempts WHERE ip = ? AND success = 0 AND attempted_at > (NOW() - INTERVAL 15 MINUTE)", [$ip]);
        $emailFails = db_scalar_int($pdo, "SELECT COUNT(*) FROM login_attempts WHERE email = ? AND success = 0 AND attempted_at > (NOW() - INTERVAL 15 MINUTE)", [$email]);
        return $ipFails >= 20 || $emailFails >= 8;
    } catch (Throwable $e) {
        return false;
    }
}
function record_login_attempt(PDO $pdo, string $ip, string $email, bool $success): void {
    try {
        $pdo->prepare("INSERT INTO login_attempts (ip, email, success) VALUES (?, ?, ?)")
            ->execute([$ip, $email, $success ? 1 : 0]);
    } catch (Throwable $e) { /* best effort */ }
}

/**
 * Verify super-admin credentials against the external LSC auth service SERVER-SIDE, so the server —
 * not the browser — decides whether a super-admin token is minted. Returns the decoded auth payload
 * on success, or null on failure.
 */
function external_auth_login(array $env, string $email, string $password, string $systemId): ?array {
    $url = $env['AUTH_LOGIN_URL'] ?? 'https://auth.lsc-india.org/api/login';
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT => 15,
        CURLOPT_CONNECTTIMEOUT => 6,
        CURLOPT_POST => true,
        CURLOPT_POSTFIELDS => ['email' => $email, 'password' => $password, 'system_id' => $systemId],
    ]);
    $body = curl_exec($ch);
    $status = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
    if ($body === false || $status < 200 || $status >= 300) {
        return null;
    }
    $data = json_decode((string)$body, true);
    if (!is_array($data) || empty($data['success']) || empty($data['data']['access_token'])) {
        return null;
    }
    return $data;
}

function request_company_filter(?array $payload = null): ?int {
    if (isset($_GET['companyId'])) {
        $value = (int)$_GET['companyId'];
        return $value > 0 ? $value : null;
    }
    if (is_array($payload) && isset($payload['companyId'])) {
        $value = (int)$payload['companyId'];
        return $value > 0 ? $value : null;
    }
    return null;
}

function can_manage_directory_role(string $actorRole, string $targetRole): bool {
    if ($actorRole === 'SUPER_ADMIN') {
        return in_array($targetRole, ['SUPER_ADMIN', 'ADMIN', 'VIEWER', 'PROCTOR', 'STUDENT'], true);
    }
    if ($actorRole === 'ADMIN') {
        return in_array($targetRole, ['VIEWER', 'PROCTOR', 'STUDENT'], true);
    }
    return false;
}

/**
 * Generate a human-friendly temporary password (mixed case + digits, no ambiguous chars).
 */
function generate_temp_password(int $length = 10): string {
    $alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
    $max = strlen($alphabet) - 1;
    $out = '';
    for ($i = 0; $i < $length; $i++) {
        $out .= $alphabet[random_int(0, $max)];
    }
    return $out;
}

/**
 * Provision a login account on the external auth service.
 * Returns ['ok' => bool, 'error' => ?string].
 */
function provision_external_auth_user(string $url, array $fields, int $timeout = 15): array {
    if ($url === '') {
        return ['ok' => false, 'error' => 'Auth register URL is not configured.'];
    }
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_POST => true,
        CURLOPT_POSTFIELDS => $fields, // multipart/form-data
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT => $timeout,
        CURLOPT_CONNECTTIMEOUT => $timeout,
    ]);
    $response = curl_exec($ch);
    $status = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $curlErr = curl_error($ch);
    curl_close($ch);

    if ($response === false) {
        return ['ok' => false, 'error' => 'Auth service unreachable: ' . ($curlErr !== '' ? $curlErr : 'unknown error')];
    }

    $decoded = json_decode((string)$response, true);
    if (is_array($decoded) && ($decoded['success'] ?? false) === true) {
        // The auth service returns success=true WITH already_exists=true when the email is
        // already registered. In that case it keeps the account's existing password and does
        // NOT apply the temp password we sent, so emailing that temp password would be
        // misleading (it can never work). Treat this as a non-success for provisioning.
        if (($decoded['already_exists'] ?? false) === true) {
            return [
                'ok' => false,
                'already_exists' => true,
                'error' => 'A login account already exists for this email address. The temporary password was not applied — the user should sign in with their existing password or reset it.',
            ];
        }
        return ['ok' => true, 'error' => null];
    }

    $message = is_array($decoded) ? (string)($decoded['message'] ?? '') : '';
    if ($message === '') {
        $message = "Auth service returned HTTP {$status}.";
    }
    return ['ok' => false, 'error' => $message];
}

/**
 * Roles whose credentials live in OUR database (verified with password_hash / password_verify).
 * Super admins authenticate against the external LSC auth service; students use exam tokens.
 */
function role_uses_local_password(string $role): bool {
    return in_array($role, ['ADMIN', 'PROCTOR', 'VIEWER'], true);
}

/**
 * Compose and send a staff account email (account created OR password reset) and log delivery.
 * $a keys: companyId(?int), companyName, fullName, email, roleLabel, registrationDisplay,
 *          tempPassword, accountAlreadyExisted(bool), mode('created'|'reset').
 * Returns ['ok' => bool, 'error' => ?string]. A missing SMTP config is treated as a no-op success.
 */
function send_account_credentials_email(PDO $pdo, array $env, array $a): array {
    $companyId    = $a['companyId'] ?? null;
    $companyName  = (string)($a['companyName'] ?? 'LSC Proctor');
    $fullName     = (string)($a['fullName'] ?? '');
    $email        = (string)($a['email'] ?? '');
    $roleLabel    = (string)($a['roleLabel'] ?? 'user');
    $registrationDisplay   = (string)($a['registrationDisplay'] ?? 'N/A');
    $tempPassword          = (string)($a['tempPassword'] ?? '');
    $accountAlreadyExisted = (bool)($a['accountAlreadyExisted'] ?? false);
    $isReset               = (($a['mode'] ?? 'created') === 'reset');

    $subject = $isReset
        ? "Your {$companyName} password has been reset"
        : "Your {$companyName} account has been created";

    $safeFullName    = htmlspecialchars($fullName, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
    $safeRoleLabel   = htmlspecialchars(ucwords($roleLabel), ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
    $safeCompanyName = htmlspecialchars($companyName, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
    $safeEmail       = htmlspecialchars($email, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
    $safeRegId       = htmlspecialchars($registrationDisplay, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
    $safeTempPassword = htmlspecialchars($tempPassword, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');

    // Admin dashboard link so the new staff member can jump straight to sign-in. The client sends
    // its own origin (+ /admin); if it's missing or malformed, fall back to the request origin/host.
    $dashboardUrl = trim((string)($a['dashboardUrl'] ?? ''));
    if (!preg_match('#^https?://#i', $dashboardUrl)) {
        $origin = (string)($_SERVER['HTTP_ORIGIN'] ?? '');
        if ($origin === '' && !empty($_SERVER['HTTP_HOST'])) {
            $scheme = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') ? 'https' : 'http';
            $origin = $scheme . '://' . $_SERVER['HTTP_HOST'];
        }
        $dashboardUrl = $origin !== '' ? rtrim($origin, '/') . '/admin' : '';
    }
    $safeDashboardUrl = htmlspecialchars($dashboardUrl, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
    $dashboardButton = $dashboardUrl !== ''
        ? "<p style=\"margin:0 0 12px;\"><a href=\"{$safeDashboardUrl}\" style=\"display:inline-block;padding:11px 22px;background:#0f172a;color:#ffffff;text-decoration:none;border-radius:8px;font-weight:600;font-size:14px;\">Go to Admin Dashboard</a></p><p style=\"margin:0 0 16px;color:#64748b;font-size:12px;\">Or open this link in your browser: <a href=\"{$safeDashboardUrl}\" style=\"color:#2563eb;\">{$safeDashboardUrl}</a></p>"
        : '';

    $heading = $isReset ? 'Password reset' : "Welcome to {$safeCompanyName}";
    $intro = $isReset
        ? "The password for your <strong>{$safeRoleLabel}</strong> account on the <strong>{$safeCompanyName}</strong> platform has been reset."
        : "Your <strong>{$safeRoleLabel}</strong> account on the <strong>{$safeCompanyName}</strong> platform has been created.";

    // Temp password is shown in a prominent card rather than a table row. Email clients block
    // JavaScript, so a real "copy" button can't run; instead the value uses `user-select:all` so a
    // single click/tap selects the whole password ready to copy, with a hint to guide the user.
    $passwordCard = '';
    if ($tempPassword !== '') {
        $passwordRow = '';
        $passwordCard = "<div style=\"margin:0 0 20px;padding:16px;border:1px dashed #cbd5e1;border-radius:10px;background:#f8fafc;text-align:center;\">"
            . "<div style=\"font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#64748b;margin-bottom:8px;\">Temporary Password</div>"
            . "<div style=\"font-family:'Courier New',monospace;font-size:22px;font-weight:700;letter-spacing:2px;color:#0f172a;background:#ffffff;border:1px solid #e2e8f0;border-radius:8px;padding:10px 14px;display:inline-block;user-select:all;-webkit-user-select:all;-moz-user-select:all;\">{$safeTempPassword}</div>"
            . "<div style=\"font-size:11px;color:#94a3b8;margin-top:8px;\">Click to select the password, then copy it (on mobile, tap and hold).</div>"
            . "</div>";
        $loginBlock = "<p style=\"margin:0 0 16px;\">Log in using your email address and the temporary password above. For your security, please change it after signing in.</p>";
    } elseif ($accountAlreadyExisted) {
        // Existing LSC login — no temp password was issued; point them at their current one.
        $passwordRow = '';
        $loginBlock = "<p style=\"margin:0 0 16px;\">This email already has an <strong>LSC account</strong>, so sign in with your <strong>existing LSC password</strong>. If you don’t remember it, use the “Forgot password” option or contact your administrator.</p>";
    } else {
        $passwordRow = '';
        $loginBlock = "<p style=\"margin:0 0 16px;\">Please log in to the platform using your email address.</p>";
    }

    $body = <<<HTML
<!doctype html><html><head><meta charset="utf-8"><title>{$subject}</title></head>
<body style="margin:0;padding:24px;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;font-size:14px;line-height:1.6;color:#0f172a;background-color:#f8fafc;">
<div style="max-width:600px;margin:0 auto;background:#ffffff;border-radius:12px;border:1px solid #e2e8f0;padding:32px;">
  <h2 style="margin:0 0 16px;font-size:20px;color:#1e293b;">{$heading}</h2>
  <p style="margin:0 0 12px;">Hello <strong>{$safeFullName}</strong>,</p>
  <p style="margin:0 0 16px;">{$intro}</p>
  <table style="width:100%;border-collapse:collapse;margin:0 0 20px;font-size:13px;">
    <tr><td style="padding:8px 12px;background:#f1f5f9;border-radius:6px 6px 0 0;font-weight:600;color:#475569;">Email</td><td style="padding:8px 12px;background:#f8fafc;border-radius:0 0 0 0;">{$safeEmail}</td></tr>
    <tr><td style="padding:8px 12px;background:#f1f5f9;font-weight:600;color:#475569;">Role</td><td style="padding:8px 12px;background:#ffffff;">{$safeRoleLabel}</td></tr>
    <tr><td style="padding:8px 12px;background:#f1f5f9;font-weight:600;color:#475569;">Registration ID</td><td style="padding:8px 12px;background:#f8fafc;">{$safeRegId}</td></tr>
    {$passwordRow}
  </table>
  {$passwordCard}
  {$loginBlock}
  {$dashboardButton}
  <p style="margin:0;color:#64748b;font-size:12px;">This is an automated message from {$safeCompanyName} ProctorGuard. If you did not expect this, please contact your administrator.</p>
</div>
</body></html>
HTML;

    $smtpHost = $env['SMTP_HOST'] ?? '';
    $smtpPort = (int)($env['SMTP_PORT'] ?? 0);
    $smtpUser = $env['SMTP_USER'] ?? '';
    $smtpPass = $env['SMTP_PASS'] ?? '';
    $smtpFrom = $env['SMTP_FROM'] ?? '';
    $smtpSecure = $env['SMTP_SECURE'] ?? '';
    $smtpTimeout = (int)($env['SMTP_TIMEOUT'] ?? 15);
    $smtpAllowSelfSigned = ($env['SMTP_ALLOW_SELF_SIGNED'] ?? '0') === '1';

    if ($smtpHost === '' || $smtpPort <= 0 || $smtpFrom === '') {
        // Email isn't configured on this environment — nothing to send, and not an error.
        return ['ok' => true, 'error' => null];
    }

    $smtpResult = smtp_send($smtpHost, $smtpPort, $smtpUser, $smtpPass, $smtpFrom, [
        'to' => $email,
        'subject' => $subject,
        'body' => $body,
        'fromName' => $companyName . ' ProctorGuard',
    ], $smtpSecure, $smtpTimeout, $smtpAllowSelfSigned);

    // Never persist the plaintext temporary password in the delivery log — the recipient's inbox
    // already holds it, and storing it at rest is an unnecessary credential exposure.
    $loggedBody = $body;
    if ($tempPassword !== '') {
        $loggedBody = str_replace($safeTempPassword, '••••••••', $loggedBody);
        $loggedBody = str_replace($tempPassword, '••••••••', $loggedBody);
    }
    $logStmt = $pdo->prepare('INSERT INTO delivery_logs (company_id, channel, recipient, subject, body, status, error) VALUES (?, ?, ?, ?, ?, ?, ?)');
    $logStmt->execute([
        $companyId ?? 1,
        'EMAIL',
        $email,
        $subject,
        $loggedBody,
        $smtpResult['ok'] ? 'SENT' : 'FAILED',
        $smtpResult['ok'] ? null : ($smtpResult['error'] ?? 'Send failed'),
    ]);
    $logStmt->closeCursor();

    return ['ok' => (bool)$smtpResult['ok'], 'error' => $smtpResult['ok'] ? null : ($smtpResult['error'] ?? 'Send failed')];
}

function fetch_legacy_student_directory_users(PDO $pdo, ?int $filterCompanyId, string $search): array {
    if (!db_table_exists($pdo, 'students')) {
        return [];
    }

    $hasCompanies = db_table_exists($pdo, 'companies');
    $hasCreatedAt = db_column_exists($pdo, 'students', 'created_at');
    $sql = "SELECT
                s.id,
                " . (db_column_exists($pdo, 'students', 'company_id') ? 's.company_id' : '1 AS company_id') . ",
                " . ($hasCompanies && db_column_exists($pdo, 'students', 'company_id') ? 'c.name AS company_name' : 'NULL AS company_name') . ",
                s.full_name,
                s.email,
                s.registration_id,
                " . ($hasCreatedAt ? 's.created_at' : 'NOW() AS created_at') . ",
                " . ($hasCreatedAt ? 's.created_at' : 'NOW() AS updated_at') . "
            FROM students s
            " . ($hasCompanies && db_column_exists($pdo, 'students', 'company_id') ? 'LEFT JOIN companies c ON c.id = s.company_id' : '') . "
            WHERE 1 = 1";
    $params = [];

    if ($filterCompanyId !== null && db_column_exists($pdo, 'students', 'company_id')) {
        $sql .= " AND s.company_id = ?";
        $params[] = $filterCompanyId;
    }

    if ($search !== '') {
        $like = "%{$search}%";
        $sql .= " AND (s.full_name LIKE ? OR s.email LIKE ? OR COALESCE(s.registration_id, '') LIKE ?)";
        array_push($params, $like, $like, $like);
    }

    $sql .= " ORDER BY s.full_name ASC";
    $stmt = $pdo->prepare($sql);
    $stmt->execute($params);
    $rows = $stmt->fetchAll();
    $stmt->closeCursor();

    return array_map(static function (array $row): array {
        return [
            'id' => crc32((string)$row['id']),
            'companyId' => $row['company_id'] !== null ? (int)$row['company_id'] : null,
            'companyName' => $row['company_name'] !== null ? (string)$row['company_name'] : null,
            'role' => 'STUDENT',
            'fullName' => (string)$row['full_name'],
            'email' => (string)$row['email'],
            'status' => 'ACTIVE',
            'registrationId' => $row['registration_id'] !== null ? (string)$row['registration_id'] : null,
            'externalAuthId' => null,
            'notes' => 'Legacy student directory record',
            'createdAt' => strtotime((string)$row['created_at']) * 1000,
            'updatedAt' => strtotime((string)$row['updated_at']) * 1000,
        ];
    }, $rows);
}

function ensure_student_directory_sync(PDO $pdo, int $companyId, array $record): void {
    $email = trim((string)($record['email'] ?? ''));
    $fullName = trim((string)($record['fullName'] ?? ''));
    $registrationId = trim((string)($record['registrationId'] ?? ''));
    if ($email === '' || $fullName === '' || $registrationId === '') {
        return;
    }

    $lookup = $pdo->prepare("SELECT id FROM students WHERE company_id = ? AND (email = ? OR registration_id = ?) LIMIT 1");
    $lookup->execute([$companyId, $email, $registrationId]);
    $existing = $lookup->fetch();
    $lookup->closeCursor();

    if ($existing) {
        $update = $pdo->prepare("UPDATE students
                                 SET full_name = ?, email = ?, registration_id = ?
                                 WHERE id = ? AND company_id = ?");
        $update->execute([$fullName, $email, $registrationId, (string)$existing['id'], $companyId]);
        $update->closeCursor();
        return;
    }

    $studentId = substr(hash('sha256', "{$companyId}|{$email}|{$registrationId}"), 0, 16);
    $insert = $pdo->prepare("INSERT INTO students (id, company_id, full_name, email, registration_id)
                             VALUES (?, ?, ?, ?, ?)");
    $insert->execute([$studentId, $companyId, $fullName, $email, $registrationId]);
    $insert->closeCursor();
}

function fetch_directory_users(PDO $pdo, string $actorRole, ?int $actorCompanyId, ?int $filterCompanyId, ?string $filterRole, string $search): array {
    if (!db_table_exists($pdo, 'platform_users')) {
        if ($filterRole !== null && $filterRole !== 'STUDENT') {
            return [];
        }
        return fetch_legacy_student_directory_users($pdo, $filterCompanyId, $search);
    }

    $hasCompanies = db_table_exists($pdo, 'companies');
    $hasRegistrationId = db_column_exists($pdo, 'platform_users', 'registration_id');
    $hasExternalAuthId = db_column_exists($pdo, 'platform_users', 'external_auth_id');
    $hasNotes = db_column_exists($pdo, 'platform_users', 'notes');
    $sql = "SELECT
                u.id,
                u.company_id,
                " . ($hasCompanies ? 'c.name AS company_name' : 'NULL AS company_name') . ",
                u.role,
                u.full_name,
                u.email,
                u.status,
                " . ($hasRegistrationId ? 'u.registration_id' : 'NULL AS registration_id') . ",
                " . ($hasExternalAuthId ? 'u.external_auth_id' : 'NULL AS external_auth_id') . ",
                " . ($hasNotes ? 'u.notes' : 'NULL AS notes') . ",
                u.created_at,
                u.updated_at
            FROM platform_users u
            " . ($hasCompanies ? 'LEFT JOIN companies c ON c.id = u.company_id' : '') . "
            WHERE 1 = 1";
    $params = [];

    if ($actorRole !== 'SUPER_ADMIN') {
        $sql .= " AND u.company_id = ? AND u.role IN ('VIEWER','PROCTOR','STUDENT')";
        $params[] = $actorCompanyId;
    } elseif ($filterCompanyId !== null) {
        $sql .= " AND u.company_id = ?";
        $params[] = $filterCompanyId;
    }

    if ($filterRole !== null) {
        $sql .= " AND u.role = ?";
        $params[] = $filterRole;
    }

    if ($search !== '') {
        $sql .= " AND (u.full_name LIKE ? OR u.email LIKE ? OR COALESCE(u.registration_id, '') LIKE ? OR COALESCE(c.name, '') LIKE ?)";
        $like = "%{$search}%";
        array_push($params, $like, $like, $like, $like);
    }

    $sql .= " ORDER BY
                CASE u.role
                    WHEN 'SUPER_ADMIN' THEN 1
                    WHEN 'ADMIN' THEN 2
                    WHEN 'VIEWER' THEN 3
                    WHEN 'PROCTOR' THEN 4
                    ELSE 5
                END,
                u.full_name ASC";

    $stmt = $pdo->prepare($sql);
    $stmt->execute($params);
    $rows = $stmt->fetchAll();
    $stmt->closeCursor();

    return array_map(static function (array $row): array {
        return [
            'id' => (int)$row['id'],
            'companyId' => $row['company_id'] !== null ? (int)$row['company_id'] : null,
            'companyName' => $row['company_name'] !== null ? (string)$row['company_name'] : null,
            'role' => (string)$row['role'],
            'fullName' => (string)$row['full_name'],
            'email' => (string)$row['email'],
            'status' => (string)$row['status'],
            'registrationId' => $row['registration_id'] !== null ? (string)$row['registration_id'] : null,
            'externalAuthId' => $row['external_auth_id'] !== null ? (string)$row['external_auth_id'] : null,
            'notes' => $row['notes'] !== null ? (string)$row['notes'] : null,
            'createdAt' => strtotime((string)$row['created_at']) * 1000,
            'updatedAt' => strtotime((string)$row['updated_at']) * 1000,
        ];
    }, $rows);
}

if ($method === 'GET') {
    $actorRole = require_role(['SUPER_ADMIN', 'ADMIN']);
    $actorCompanyId = $actorRole === 'SUPER_ADMIN' ? null : require_company_id();
    $filterCompanyId = $actorRole === 'SUPER_ADMIN' ? request_company_filter() : $actorCompanyId;
    $filterRole = strtoupper(trim((string)($_GET['role'] ?? '')));
    if (!in_array($filterRole, ['SUPER_ADMIN', 'ADMIN', 'VIEWER', 'PROCTOR', 'STUDENT'], true)) {
        $filterRole = '';
    }
    $search = trim((string)($_GET['q'] ?? ''));

    json_response([
        'users' => fetch_directory_users($pdo, $actorRole, $actorCompanyId, $filterCompanyId, $filterRole !== '' ? $filterRole : null, $search),
    ]);
}

if ($method === 'POST') {
    $payload = json_input();
    $action = strtoupper(trim((string)($payload['action'] ?? 'CREATE')));

    if (!db_table_exists($pdo, 'platform_users')) {
        json_response(['error' => 'User directory storage is unavailable on this database. Apply the latest schema and try again.'], 503);
    }

    // Post-login identity resolution: the external auth service only verifies credentials.
    // Company/tenant ownership and role are sourced from OUR database, keyed by the verified email.
    // Runs before the role gate because at login the client has no company/role context yet.
    if ($action === 'RESOLVE_IDENTITY') {
        $lookupEmail = strtolower(trim((string)($payload['email'] ?? '')));
        if ($lookupEmail === '' || !filter_var($lookupEmail, FILTER_VALIDATE_EMAIL)) {
            json_response(['found' => false]);
        }
        // Unauthenticated, this was an open directory oracle: anyone could POST any email and learn
        // whether it is a staff account plus its role, company id and full name (the very enumeration
        // LOGIN's uniform error avoids). Login now resolves identity via LOGIN / EXTERNAL_LOGIN, so
        // under token enforcement this only answers for the caller's own verified email (or a super admin).
        if (auth_enforced()) {
            $idClaims = current_session_claims();
            $idRole = strtoupper((string)($idClaims['role'] ?? ''));
            $idEmail = strtolower(trim((string)($idClaims['email'] ?? '')));
            if ($idClaims === null || ($idRole !== 'SUPER_ADMIN' && $idEmail !== $lookupEmail)) {
                json_response(['found' => false]);
            }
        }
        $idStmt = $pdo->prepare("SELECT company_id, role, full_name FROM platform_users WHERE email = ? AND status <> 'DISABLED' LIMIT 1");
        $idStmt->execute([$lookupEmail]);
        $idRow = $idStmt->fetch();
        $idStmt->closeCursor();
        if (!$idRow) {
            json_response(['found' => false]);
        }
        json_response([
            'found' => true,
            'companyId' => $idRow['company_id'] !== null ? (int)$idRow['company_id'] : null,
            'role' => (string)$idRow['role'],
            'fullName' => (string)$idRow['full_name'],
        ]);
    }

    // Password login against OUR database for non-super-admin staff (ADMIN / PROCTOR).
    // Super admins are told to authenticate against the external LSC auth service instead.
    // Runs before the role gate because at login the client has no verified role yet.
    if ($action === 'LOGIN') {
        $loginEmail = strtolower(trim((string)($payload['email'] ?? '')));
        $loginPassword = (string)($payload['password'] ?? '');
        $ip = (string)($_SERVER['REMOTE_ADDR'] ?? '');
        ensure_login_attempts_table($pdo);
        if (login_rate_limited($pdo, $ip, $loginEmail)) {
            json_response(['ok' => false, 'error' => 'Too many attempts. Please wait a few minutes and try again.'], 429);
        }
        if ($loginEmail === '' || !filter_var($loginEmail, FILTER_VALIDATE_EMAIL) || $loginPassword === '') {
            record_login_attempt($pdo, $ip, $loginEmail, false);
            json_response(['ok' => false, 'error' => 'Invalid email or password.'], 200);
        }
        $hasPwCol = db_column_exists($pdo, 'platform_users', 'password_hash');
        $hasCompanies = db_table_exists($pdo, 'companies');
        $sql = "SELECT u.id, u.company_id, u.role, u.full_name, u.status, "
            . ($hasPwCol ? 'u.password_hash' : 'NULL AS password_hash') . ", "
            . ($hasCompanies ? 'c.name AS company_name' : 'NULL AS company_name')
            . " FROM platform_users u "
            . ($hasCompanies ? 'LEFT JOIN companies c ON c.id = u.company_id ' : '')
            . "WHERE u.email = ? LIMIT 1";
        $stmt = $pdo->prepare($sql);
        $stmt->execute([$loginEmail]);
        $row = $stmt->fetch();
        $stmt->closeCursor();

        // Super admins authenticate against the external LSC auth service, not our DB.
        if ($row && (string)$row['role'] === 'SUPER_ADMIN') {
            if ((string)$row['status'] === 'DISABLED') {
                json_response(['ok' => false, 'error' => 'This account has been disabled.'], 200);
            }
            json_response(['ok' => false, 'external' => true, 'role' => 'SUPER_ADMIN'], 200);
        }

        // Uniform error for unknown email or bad password — avoids leaking which emails exist.
        if (!$row || (string)($row['password_hash'] ?? '') === '' || !password_verify($loginPassword, (string)$row['password_hash'])) {
            record_login_attempt($pdo, $ip, $loginEmail, false);
            json_response(['ok' => false, 'error' => 'Invalid email or password.'], 200);
        }
        if ((string)$row['status'] === 'DISABLED') {
            record_login_attempt($pdo, $ip, $loginEmail, false);
            json_response(['ok' => false, 'error' => 'This account has been disabled. Contact your administrator.'], 200);
        }

        record_login_attempt($pdo, $ip, $loginEmail, true);
        // Password verified server-side → issue a signed session token. Every later request proves
        // its role/company by presenting this token (X-Auth-Token), instead of self-declaring them.
        $sessionToken = mint_session_token([
            'uid' => (int)$row['id'],
            'role' => (string)$row['role'],
            'cid' => $row['company_id'] !== null ? (int)$row['company_id'] : null,
            'email' => $loginEmail,
        ]);

        json_response([
            'ok' => true,
            'token' => $sessionToken,
            'userId' => (int)$row['id'],
            'companyId' => $row['company_id'] !== null ? (int)$row['company_id'] : null,
            'companyName' => isset($row['company_name']) && $row['company_name'] !== null ? (string)$row['company_name'] : null,
            'role' => (string)$row['role'],
            'fullName' => (string)$row['full_name'],
            'email' => $loginEmail,
        ]);
    }

    if ($action === 'EXTERNAL_LOGIN') {
        // Super-admin (and other externally-authenticated) login, verified SERVER-SIDE against the
        // LSC auth service so the server — not the browser — decides the minted token's role/company.
        $loginEmail = strtolower(trim((string)($payload['email'] ?? '')));
        $loginPassword = (string)($payload['password'] ?? '');
        $systemId = trim((string)($payload['systemId'] ?? $payload['system_id'] ?? '3'));
        $ip = (string)($_SERVER['REMOTE_ADDR'] ?? '');
        ensure_login_attempts_table($pdo);
        if (login_rate_limited($pdo, $ip, $loginEmail)) {
            json_response(['ok' => false, 'error' => 'Too many attempts. Please wait a few minutes and try again.'], 429);
        }
        if ($loginEmail === '' || !filter_var($loginEmail, FILTER_VALIDATE_EMAIL) || $loginPassword === '') {
            record_login_attempt($pdo, $ip, $loginEmail, false);
            json_response(['ok' => false, 'error' => 'Invalid email or password.'], 200);
        }

        $auth = external_auth_login($env, $loginEmail, $loginPassword, $systemId !== '' ? $systemId : '3');
        if ($auth === null) {
            record_login_attempt($pdo, $ip, $loginEmail, false);
            json_response(['ok' => false, 'error' => 'Invalid email or password.'], 200);
        }
        record_login_attempt($pdo, $ip, $loginEmail, true);

        // Resolve role/company from OUR directory (authoritative), not from the auth response.
        $dbRole = null; $dbCompanyId = null; $dbFullName = null; $dbCompanyName = null; $dbUserId = null;
        if (db_table_exists($pdo, 'platform_users')) {
            $hasCompanies = db_table_exists($pdo, 'companies');
            $sql = "SELECT u.id, u.company_id, u.role, u.full_name, u.status, "
                . ($hasCompanies ? 'c.name AS company_name' : 'NULL AS company_name')
                . " FROM platform_users u "
                . ($hasCompanies ? 'LEFT JOIN companies c ON c.id = u.company_id ' : '')
                . "WHERE u.email = ? LIMIT 1";
            $st = $pdo->prepare($sql);
            $st->execute([$loginEmail]);
            $r = $st->fetch();
            $st->closeCursor();
            if ($r) {
                if ((string)$r['status'] === 'DISABLED') {
                    json_response(['ok' => false, 'error' => 'This account has been disabled.'], 200);
                }
                $dbUserId = (int)$r['id'];
                $dbRole = strtoupper((string)$r['role']);
                $dbCompanyId = $r['company_id'] !== null ? (int)$r['company_id'] : null;
                $dbFullName = (string)$r['full_name'];
                $dbCompanyName = isset($r['company_name']) ? $r['company_name'] : null;
            }
        }

        // Only the directory can confer SUPER_ADMIN. Unknown externally-authed users must be mapped.
        $role = $dbRole ?: null;
        if ($role === null) {
            json_response(['ok' => false, 'error' => 'This account is not mapped to a role. Contact your administrator.'], 200);
        }
        if ($role !== 'SUPER_ADMIN' && ($dbCompanyId === null || $dbCompanyId <= 0)) {
            json_response(['ok' => false, 'error' => 'This account is not mapped to a company. Contact your administrator.'], 200);
        }

        $sessionToken = mint_session_token([
            'uid' => $dbUserId,
            'role' => $role,
            'cid' => $dbCompanyId,
            'email' => $loginEmail,
        ]);
        json_response([
            'ok' => true,
            'token' => $sessionToken,
            'userId' => $dbUserId,
            'role' => $role,
            'companyId' => $dbCompanyId,
            'companyName' => $dbCompanyName,
            'fullName' => $dbFullName ?: (string)($auth['data']['name'] ?? ''),
            'email' => $loginEmail,
        ]);
    }

    if ($action === 'RESET_OWN_PASSWORD') {
        // Self-service reset from Settings, available to any signed-in staff member (ADMIN / PROCTOR /
        // VIEWER) — it only ever changes the CALLER's own password, so it sits ahead of the admin-only
        // gate below. Super admins authenticate against the central LSC auth service, so their
        // password is not stored here and is deliberately left alone.
        // Must be a signed-in staff member. Previously this used get_actor_role()/get_actor_id(),
        // which with no token fall back to the client-supplied X-Actor-Id / payload actorId — so an
        // anonymous POST {action:'RESET_OWN_PASSWORD', actorId:'<any admin email>'} reset that admin's
        // password (locking them out, repeatably) and mailed them an attacker-chosen dashboard link.
        $selfRole = require_staff($payload);
        $selfActorId = get_actor_id($payload);
        if ($selfRole === 'SUPER_ADMIN') {
            json_response(['error' => 'Super admin passwords are managed by the central LSC auth service and cannot be reset here.'], 400);
        }
        $actorEmail = strtolower(trim((string)($selfActorId ?? '')));
        if ($actorEmail === '' || strpos($actorEmail, '@') === false) {
            json_response(['error' => 'Could not identify your account.'], 400);
        }
        if (!db_column_exists($pdo, 'platform_users', 'password_hash')) {
            json_response(['error' => 'Password storage is unavailable on this database.'], 503);
        }

        $lookup = $pdo->prepare("SELECT id, company_id, role, full_name, email, password_hash, password_updated_at FROM platform_users WHERE LOWER(email) = ? LIMIT 1");
        $lookup->execute([$actorEmail]);
        $me = $lookup->fetch();
        $lookup->closeCursor();
        if (!$me) {
            json_response(['error' => 'Account not found.'], 404);
        }
        $myRole = strtoupper((string)$me['role']);
        if ($myRole === 'SUPER_ADMIN') {
            json_response(['error' => 'Super admin passwords are managed by the central LSC auth service and cannot be reset here.'], 400);
        }
        if (!role_uses_local_password($myRole)) {
            json_response(['error' => 'Only ADMIN, PROCTOR and VIEWER accounts have a password to reset here.'], 400);
        }

        $newPassword = generate_temp_password();
        $newHash = password_hash($newPassword, PASSWORD_DEFAULT);
        $upd = $pdo->prepare("UPDATE platform_users SET password_hash = ?, password_updated_at = ? WHERE id = ? LIMIT 1");
        $upd->execute([$newHash, date('Y-m-d H:i:s'), (int)$me['id']]);
        $upd->closeCursor();

        $companyName = 'LSC Proctor';
        $myCompanyId = $me['company_id'] !== null ? (int)$me['company_id'] : null;
        if ($myCompanyId !== null && $myCompanyId > 0) {
            $cStmt = $pdo->prepare("SELECT name FROM companies WHERE id = ? LIMIT 1");
            $cStmt->execute([$myCompanyId]);
            $cRow = $cStmt->fetch();
            $cStmt->closeCursor();
            if ($cRow) {
                $companyName = (string)$cRow['name'];
            }
        }

        $emailResult = send_account_credentials_email($pdo, $env, [
            'companyId' => $myCompanyId,
            'companyName' => $companyName,
            'fullName' => (string)$me['full_name'],
            'email' => (string)$me['email'],
            'roleLabel' => str_replace('_', ' ', strtolower($myRole)),
            'registrationDisplay' => 'N/A',
            'tempPassword' => $newPassword,
            'accountAlreadyExisted' => false,
            'mode' => 'reset',
            'dashboardUrl' => (string)($payload['dashboardUrl'] ?? ''),
        ]);

        if (!$emailResult['ok']) {
            // The new password exists only in the email that just failed — keeping it would leave the
            // user with a password nobody knows (locked out once their session expires). Put the old
            // one back and report that nothing changed.
            $restore = $pdo->prepare("UPDATE platform_users SET password_hash = ?, password_updated_at = ? WHERE id = ? LIMIT 1");
            $restore->execute([$me['password_hash'] ?? null, $me['password_updated_at'] ?? null, (int)$me['id']]);
            $restore->closeCursor();
            json_response([
                'ok' => false,
                'error' => 'Your password was not changed because the email with the new password could not be sent ('
                    . ($emailResult['error'] ?? 'Unknown error') . '). Please try again later.',
            ]);
        }

        audit_log($pdo, [
            'companyId' => $myCompanyId ?? 1,
            'actorRole' => $selfRole,
            'actorId' => $selfActorId,
            'action' => 'RESET_OWN_PASSWORD',
            'targetType' => 'user',
            'targetId' => (string)$me['id'],
            'message' => "Self-service password reset for {$me['email']}.",
        ]);

        json_response(['ok' => true, 'message' => 'A temporary password has been emailed to you.']);
    }

    $actorRole = require_role(['SUPER_ADMIN', 'ADMIN'], $payload);
    $actorId = get_actor_id($payload);

    if ($action === 'CREATE' || $action === 'UPDATE') {
        $targetRole = strtoupper(trim((string)($payload['role'] ?? '')));
        if (!can_manage_directory_role($actorRole, $targetRole)) {
            json_response(['error' => 'You cannot manage this role.'], 403);
        }

        $companyId = $actorRole === 'SUPER_ADMIN'
            ? request_company_filter($payload)
            : require_company_id($payload);
        if ($targetRole !== 'SUPER_ADMIN' && ($companyId === null || $companyId <= 0)) {
            json_response(['error' => 'companyId is required for this role.'], 400);
        }
        if ($actorRole !== 'SUPER_ADMIN' && $companyId !== require_company_id($payload)) {
            json_response(['error' => 'Company scope mismatch.'], 403);
        }

        $fullName = trim((string)($payload['fullName'] ?? ''));
        $email = strtolower(trim((string)($payload['email'] ?? '')));
        $status = strtoupper(trim((string)($payload['status'] ?? 'ACTIVE')));
        $notes = trim((string)($payload['notes'] ?? ''));
        $registrationId = trim((string)($payload['registrationId'] ?? ''));
        if ($registrationId === '' && $targetRole === 'STUDENT') {
            $registrationId = strtoupper(substr(preg_replace('/[^A-Za-z0-9]+/', '', strtok($email, '@') ?: 'student') ?: 'STUDENT', 0, 24));
        }

        if ($fullName === '' || $email === '') {
            json_response(['error' => 'fullName and email are required.'], 400);
        }
        if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
            json_response(['error' => 'Valid email is required.'], 400);
        }
        if (!in_array($status, ['ACTIVE', 'INVITED', 'DISABLED'], true)) {
            $status = 'ACTIVE';
        }

        $sendInviteEmail = $action === 'CREATE' && in_array($status, ['ACTIVE', 'INVITED'], true);

        // ADMIN / PROCTOR authenticate against our DB, so we mint a temp password at create time,
        // store its hash, and email the plaintext (this password actually works, unlike external auth).
        $dbAuthRole = role_uses_local_password($targetRole);
        $plainPassword = '';
        $passwordHash = null;
        if ($action === 'CREATE' && $dbAuthRole && $sendInviteEmail) {
            $plainPassword = generate_temp_password();
            $passwordHash = password_hash($plainPassword, PASSWORD_DEFAULT);
        }

        // email is UNIQUE: report a clash clearly instead of letting the INSERT/UPDATE throw a raw
        // "Duplicate entry" 500 (which the directory screen printed verbatim).
        $assertEmailFree = static function (PDO $pdo, string $email, int $exceptId): void {
            $dupStmt = $pdo->prepare('SELECT id FROM platform_users WHERE email = ? AND id <> ? LIMIT 1');
            $dupStmt->execute([$email, $exceptId]);
            $dupRow = $dupStmt->fetch();
            $dupStmt->closeCursor();
            if ($dupRow) {
                json_response(['error' => 'A user with this email already exists.'], 409);
            }
        };

        if ($action === 'CREATE') {
            $assertEmailFree($pdo, $email, 0);
            if (db_column_exists($pdo, 'platform_users', 'password_hash')) {
                $stmt = $pdo->prepare("INSERT INTO platform_users
                    (company_id, role, full_name, email, status, registration_id, notes, password_hash, password_updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
                $stmt->execute([
                    $targetRole === 'SUPER_ADMIN' ? null : $companyId,
                    $targetRole,
                    $fullName,
                    $email,
                    $status,
                    $registrationId !== '' ? $registrationId : null,
                    $notes !== '' ? $notes : null,
                    $passwordHash,
                    $passwordHash !== null ? date('Y-m-d H:i:s') : null,
                ]);
            } else {
                $stmt = $pdo->prepare("INSERT INTO platform_users
                    (company_id, role, full_name, email, status, registration_id, notes)
                    VALUES (?, ?, ?, ?, ?, ?, ?)");
                $stmt->execute([
                    $targetRole === 'SUPER_ADMIN' ? null : $companyId,
                    $targetRole,
                    $fullName,
                    $email,
                    $status,
                    $registrationId !== '' ? $registrationId : null,
                    $notes !== '' ? $notes : null,
                ]);
            }
            $stmt->closeCursor();
            $userId = (int)$pdo->lastInsertId();
        } else {
            $sendInviteEmail = false;
            $userId = isset($payload['userId']) ? (int)$payload['userId'] : 0;
            if ($userId <= 0) {
                json_response(['error' => 'userId is required.'], 400);
            }

            $scopeSql = "SELECT company_id, role, email FROM platform_users WHERE id = ? LIMIT 1";
            $scopeStmt = $pdo->prepare($scopeSql);
            $scopeStmt->execute([$userId]);
            $existing = $scopeStmt->fetch();
            $scopeStmt->closeCursor();
            if (!$existing) {
                json_response(['error' => 'User not found.'], 404);
            }
            // The check above only validated the NEW role. STATUS/DELETE/RESET_PASSWORD also check the
            // user's CURRENT role; without it an ADMIN could UPDATE a peer ADMIN of the same company
            // (role -> VIEWER, change their email, disable them) despite not being allowed to manage admins.
            if (!can_manage_directory_role($actorRole, strtoupper((string)$existing['role']))) {
                json_response(['error' => 'You cannot manage this role.'], 403);
            }
            if ($actorRole !== 'SUPER_ADMIN' && (int)($existing['company_id'] ?? 0) !== require_company_id($payload)) {
                json_response(['error' => 'Forbidden for this company.'], 403);
            }
            // Don't let the signed-in user demote or disable their own account (a sole super admin
            // doing so locks the platform out of super-admin access).
            if ($actorId !== null && strcasecmp((string)$actorId, (string)$existing['email']) === 0
                && (strtoupper((string)$existing['role']) !== $targetRole || $status === 'DISABLED')) {
                json_response(['error' => 'You cannot change the role of, or disable, your own account.'], 400);
            }
            $assertEmailFree($pdo, $email, $userId);

            $stmt = $pdo->prepare("UPDATE platform_users
                                   SET company_id = ?, role = ?, full_name = ?, email = ?, status = ?, registration_id = ?, notes = ?
                                   WHERE id = ?
                                   LIMIT 1");
            $stmt->execute([
                $targetRole === 'SUPER_ADMIN' ? null : $companyId,
                $targetRole,
                $fullName,
                $email,
                $status,
                $registrationId !== '' ? $registrationId : null,
                $notes !== '' ? $notes : null,
                $userId,
            ]);
            $stmt->closeCursor();
        }

        if ($targetRole === 'STUDENT' && $companyId !== null && $companyId > 0) {
            ensure_student_directory_sync($pdo, $companyId, [
                'fullName' => $fullName,
                'email' => $email,
                'registrationId' => $registrationId,
            ]);
        }

        audit_log($pdo, [
            'companyId' => $companyId ?? 1,
            'actorRole' => $actorRole,
            'actorId' => $actorId,
            'action' => $action === 'CREATE' ? 'USER_CREATE' : 'USER_UPDATE',
            'targetType' => 'platform_user',
            'targetId' => (string)$userId,
            'message' => ($action === 'CREATE' ? 'Created' : 'Updated') . " {$targetRole} user {$email}",
            'metadata' => ['role' => $targetRole, 'companyId' => $companyId, 'status' => $status],
        ]);

        $emailWarning = null;
        if ($sendInviteEmail) {
            $companyName = 'LSC Proctor';
            $targetCompanyId = $targetRole === 'SUPER_ADMIN' ? 1 : $companyId;
            if ($targetCompanyId !== null && $targetCompanyId > 0) {
                $companyStmt = $pdo->prepare("SELECT name FROM companies WHERE id = ? LIMIT 1");
                $companyStmt->execute([$targetCompanyId]);
                $companyRow = $companyStmt->fetch();
                $companyStmt->closeCursor();
                if ($companyRow) {
                    $companyName = (string)$companyRow['name'];
                }
            }

            // Credential handling depends on where the role authenticates:
            //  - SUPER_ADMIN   -> external LSC auth service (provision a login there).
            //  - ADMIN/PROCTOR -> OUR database (temp password already hashed into the row above).
            //  - STUDENT       -> no password (exam-token access); password-free welcome.
            $tempPassword = '';
            $accountAlreadyExisted = false;
            if ($targetRole === 'SUPER_ADMIN') {
                $authRegisterUrl = $env['AUTH_REGISTER_URL'] ?? 'https://auth.lsc-india.org/api/register';
                $authSystemId    = (string)($env['AUTH_SYSTEM_ID'] ?? '3');
                // The auth service only handles credentials. Company/tenant ownership lives in OUR
                // database (platform_users.company_id), so we send a fixed placeholder company_id
                // to satisfy the required field instead of leaking our tenant ids into the auth service.
                $authCompanyId   = (string)($env['AUTH_COMPANY_ID'] ?? '2');
                $authTimeout     = (int)($env['AUTH_TIMEOUT'] ?? 15);
                $tempPassword    = generate_temp_password();
                $authResult = provision_external_auth_user($authRegisterUrl, [
                    'company_id'  => $authCompanyId,
                    'system_id'   => $authSystemId,
                    'name'        => $fullName,
                    'email'       => $email,
                    'password'    => $tempPassword,
                    'c_password'  => $tempPassword,
                ], $authTimeout);

                if (!$authResult['ok']) {
                    $tempPassword = '';
                    if (($authResult['already_exists'] ?? false) === true) {
                        $accountAlreadyExisted = true;
                        $emailWarning = 'This email already had an LSC login, so no new password was issued. The welcome email asks them to sign in with their existing LSC password.';
                    } else {
                        $emailWarning = 'User created but a login account could not be provisioned: ' . ($authResult['error'] ?? 'Unknown error');
                        $sendInviteEmail = false;
                    }
                }
            } elseif ($dbAuthRole) {
                // Temp password was minted and hashed into platform_users.password_hash before insert.
                $tempPassword = $plainPassword;
            }
        }

        if ($sendInviteEmail) {
            $emailResult = send_account_credentials_email($pdo, $env, [
                'companyId' => $companyId,
                'companyName' => $companyName,
                'fullName' => $fullName,
                'email' => $email,
                'roleLabel' => str_replace('_', ' ', strtolower($targetRole)),
                'registrationDisplay' => $registrationId !== '' ? $registrationId : 'N/A',
                'tempPassword' => $tempPassword,
                'accountAlreadyExisted' => $accountAlreadyExisted,
                'mode' => 'created',
                'dashboardUrl' => (string)($payload['dashboardUrl'] ?? ''),
            ]);
            if (!$emailResult['ok']) {
                $emailWarning = 'User created but invite email could not be sent: ' . ($emailResult['error'] ?? 'Unknown error');
            }
        }

        $actorCompanyId = $actorRole === 'SUPER_ADMIN' ? null : require_company_id($payload);
        $filterCompanyId = $actorRole === 'SUPER_ADMIN' ? request_company_filter($payload) : $actorCompanyId;
        $resp = [
            'ok' => true,
            'users' => fetch_directory_users($pdo, $actorRole, $actorCompanyId, $filterCompanyId, null, ''),
        ];
        if ($emailWarning !== null) {
            $resp['emailWarning'] = $emailWarning;
        }
        json_response($resp, $action === 'CREATE' ? 201 : 200);
    }

    if ($action === 'RESET_PASSWORD') {
        $userId = isset($payload['userId']) ? (int)$payload['userId'] : 0;
        if ($userId <= 0) {
            json_response(['error' => 'userId is required.'], 400);
        }

        $lookup = $pdo->prepare("SELECT id, company_id, role, full_name, email, status FROM platform_users WHERE id = ? LIMIT 1");
        $lookup->execute([$userId]);
        $target = $lookup->fetch();
        $lookup->closeCursor();
        if (!$target) {
            json_response(['error' => 'User not found.'], 404);
        }

        $targetRole = (string)$target['role'];
        if ($targetRole === 'SUPER_ADMIN') {
            json_response(['error' => 'Super admins are managed by the central LSC auth service and cannot be reset here.'], 400);
        }
        if (!role_uses_local_password($targetRole)) {
            json_response(['error' => 'Only ADMIN, PROCTOR and VIEWER accounts have a password to reset. Students sign in with exam access tokens.'], 400);
        }
        if (!can_manage_directory_role($actorRole, $targetRole)) {
            json_response(['error' => 'You cannot manage this role.'], 403);
        }
        if ($actorRole !== 'SUPER_ADMIN' && (int)($target['company_id'] ?? 0) !== require_company_id($payload)) {
            json_response(['error' => 'Forbidden for this company.'], 403);
        }
        if (!db_column_exists($pdo, 'platform_users', 'password_hash')) {
            json_response(['error' => 'Password storage is unavailable on this database. Apply the latest schema and try again.'], 503);
        }

        $newPassword = generate_temp_password();
        $newHash = password_hash($newPassword, PASSWORD_DEFAULT);
        $upd = $pdo->prepare("UPDATE platform_users SET password_hash = ?, password_updated_at = ? WHERE id = ? LIMIT 1");
        $upd->execute([$newHash, date('Y-m-d H:i:s'), $userId]);
        $upd->closeCursor();

        $companyName = 'LSC Proctor';
        $tCompanyId = $target['company_id'] !== null ? (int)$target['company_id'] : null;
        if ($tCompanyId !== null && $tCompanyId > 0) {
            $cStmt = $pdo->prepare("SELECT name FROM companies WHERE id = ? LIMIT 1");
            $cStmt->execute([$tCompanyId]);
            $cRow = $cStmt->fetch();
            $cStmt->closeCursor();
            if ($cRow) {
                $companyName = (string)$cRow['name'];
            }
        }

        $emailResult = send_account_credentials_email($pdo, $env, [
            'companyId' => $tCompanyId,
            'companyName' => $companyName,
            'fullName' => (string)$target['full_name'],
            'email' => (string)$target['email'],
            'roleLabel' => str_replace('_', ' ', strtolower($targetRole)),
            'registrationDisplay' => 'N/A',
            'tempPassword' => $newPassword,
            'accountAlreadyExisted' => false,
            'mode' => 'reset',
            'dashboardUrl' => (string)($payload['dashboardUrl'] ?? ''),
        ]);

        audit_log($pdo, [
            'companyId' => $tCompanyId ?? 1,
            'actorRole' => $actorRole,
            'actorId' => $actorId,
            'action' => 'USER_PASSWORD_RESET',
            'targetType' => 'platform_user',
            'targetId' => (string)$userId,
            'message' => 'Reset password for ' . (string)$target['email'],
            'metadata' => ['role' => $targetRole, 'emailed' => $emailResult['ok']],
        ]);

        $resp = ['ok' => true, 'email' => (string)$target['email']];
        if (!$emailResult['ok']) {
            // Email failed — hand the plaintext back to the admin (who triggered this) so it isn't lost.
            $resp['emailWarning'] = 'Password was reset but the email could not be sent (' . ($emailResult['error'] ?? 'Unknown error') . '). Share this new password securely: ' . $newPassword;
        }
        json_response($resp);
    }

    if ($action === 'STATUS') {
        $userId = isset($payload['userId']) ? (int)$payload['userId'] : 0;
        $status = strtoupper(trim((string)($payload['status'] ?? '')));
        if ($userId <= 0 || !in_array($status, ['ACTIVE', 'INVITED', 'DISABLED'], true)) {
            json_response(['error' => 'userId and valid status are required.'], 400);
        }

        $scopeStmt = $pdo->prepare("SELECT company_id, role, email FROM platform_users WHERE id = ? LIMIT 1");
        $scopeStmt->execute([$userId]);
        $existing = $scopeStmt->fetch();
        $scopeStmt->closeCursor();
        if (!$existing) {
            json_response(['error' => 'User not found.'], 404);
        }
        if (!can_manage_directory_role($actorRole, (string)$existing['role'])) {
            json_response(['error' => 'You cannot manage this role.'], 403);
        }
        if ($actorRole !== 'SUPER_ADMIN' && (int)($existing['company_id'] ?? 0) !== require_company_id($payload)) {
            json_response(['error' => 'Forbidden for this company.'], 403);
        }
        // Mirror DELETE's self-guard: disabling yourself (e.g. the only super admin) is a lock-out.
        if ($status === 'DISABLED' && $actorId !== null && strcasecmp((string)$actorId, (string)$existing['email']) === 0) {
            json_response(['error' => 'You cannot disable your own account.'], 400);
        }

        $stmt = $pdo->prepare("UPDATE platform_users SET status = ? WHERE id = ? LIMIT 1");
        $stmt->execute([$status, $userId]);
        $stmt->closeCursor();

        audit_log($pdo, [
            'companyId' => (int)($existing['company_id'] ?? 1) ?: 1,
            'actorRole' => $actorRole,
            'actorId' => $actorId,
            'action' => 'USER_STATUS_UPDATE',
            'targetType' => 'platform_user',
            'targetId' => (string)$userId,
            'message' => "Updated user status to {$status}",
            'metadata' => ['email' => (string)$existing['email'], 'role' => (string)$existing['role']],
        ]);

        $actorCompanyId = $actorRole === 'SUPER_ADMIN' ? null : require_company_id($payload);
        $filterCompanyId = $actorRole === 'SUPER_ADMIN' ? request_company_filter($payload) : $actorCompanyId;
        json_response([
            'ok' => true,
            'users' => fetch_directory_users($pdo, $actorRole, $actorCompanyId, $filterCompanyId, null, ''),
        ]);
    }

    if ($action === 'DELETE') {
        $userId = isset($payload['userId']) ? (int)$payload['userId'] : 0;
        if ($userId <= 0) {
            json_response(['error' => 'userId is required.'], 400);
        }

        $scopeStmt = $pdo->prepare("SELECT company_id, role, email FROM platform_users WHERE id = ? LIMIT 1");
        $scopeStmt->execute([$userId]);
        $existing = $scopeStmt->fetch();
        $scopeStmt->closeCursor();
        if (!$existing) {
            json_response(['error' => 'User not found.'], 404);
        }
        // Block self-deletion. The actor is identified by email/name/id via X-Actor-Id.
        if ($actorId !== null && strcasecmp((string)$actorId, (string)$existing['email']) === 0) {
            json_response(['error' => 'You cannot delete your own account.'], 400);
        }
        if (!can_manage_directory_role($actorRole, (string)$existing['role'])) {
            json_response(['error' => 'You cannot manage this role.'], 403);
        }
        if ($actorRole !== 'SUPER_ADMIN' && (int)($existing['company_id'] ?? 0) !== require_company_id($payload)) {
            json_response(['error' => 'Forbidden for this company.'], 403);
        }

        $stmt = $pdo->prepare("DELETE FROM platform_users WHERE id = ? LIMIT 1");
        $stmt->execute([$userId]);
        $stmt->closeCursor();

        audit_log($pdo, [
            'companyId' => (int)($existing['company_id'] ?? 1) ?: 1,
            'actorRole' => $actorRole,
            'actorId' => $actorId,
            'action' => 'USER_DELETE',
            'targetType' => 'platform_user',
            'targetId' => (string)$userId,
            'message' => 'Deleted user ' . (string)$existing['email'],
            'metadata' => ['email' => (string)$existing['email'], 'role' => (string)$existing['role']],
        ]);

        $actorCompanyId = $actorRole === 'SUPER_ADMIN' ? null : require_company_id($payload);
        $filterCompanyId = $actorRole === 'SUPER_ADMIN' ? request_company_filter($payload) : $actorCompanyId;
        json_response([
            'ok' => true,
            'deleted' => true,
            'users' => fetch_directory_users($pdo, $actorRole, $actorCompanyId, $filterCompanyId, null, ''),
        ]);
    }

    json_response(['error' => 'Invalid action.'], 400);
}

json_response(['error' => 'Method not allowed.'], 405);
