<?php
declare(strict_types=1);

require_once __DIR__ . '/_bootstrap.php';
require_once __DIR__ . '/notify.php';

$method = $_SERVER['REQUEST_METHOD'];

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
        return in_array($targetRole, ['SUPER_ADMIN', 'ADMIN', 'PROCTOR', 'STUDENT'], true);
    }
    if ($actorRole === 'ADMIN') {
        return in_array($targetRole, ['PROCTOR', 'STUDENT'], true);
    }
    return false;
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
        $sql .= " AND u.company_id = ? AND u.role IN ('PROCTOR','STUDENT')";
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
                    WHEN 'PROCTOR' THEN 3
                    ELSE 4
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
    if (!in_array($filterRole, ['SUPER_ADMIN', 'ADMIN', 'PROCTOR', 'STUDENT'], true)) {
        $filterRole = '';
    }
    $search = trim((string)($_GET['q'] ?? ''));

    json_response([
        'users' => fetch_directory_users($pdo, $actorRole, $actorCompanyId, $filterCompanyId, $filterRole !== '' ? $filterRole : null, $search),
    ]);
}

if ($method === 'POST') {
    $payload = json_input();
    $actorRole = require_role(['SUPER_ADMIN', 'ADMIN'], $payload);
    $actorId = get_actor_id($payload);
    $action = strtoupper(trim((string)($payload['action'] ?? 'CREATE')));

    if (!db_table_exists($pdo, 'platform_users')) {
        json_response(['error' => 'User directory storage is unavailable on this database. Apply the latest schema and try again.'], 503);
    }

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

        if ($action === 'CREATE') {
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
            $stmt->closeCursor();
            $userId = (int)$pdo->lastInsertId();
        } else {
            $sendInviteEmail = false;
            $userId = isset($payload['userId']) ? (int)$payload['userId'] : 0;
            if ($userId <= 0) {
                json_response(['error' => 'userId is required.'], 400);
            }

            $scopeSql = "SELECT company_id, role FROM platform_users WHERE id = ? LIMIT 1";
            $scopeStmt = $pdo->prepare($scopeSql);
            $scopeStmt->execute([$userId]);
            $existing = $scopeStmt->fetch();
            $scopeStmt->closeCursor();
            if (!$existing) {
                json_response(['error' => 'User not found.'], 404);
            }
            if ($actorRole !== 'SUPER_ADMIN' && (int)($existing['company_id'] ?? 0) !== require_company_id($payload)) {
                json_response(['error' => 'Forbidden for this company.'], 403);
            }

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

            $roleLabel = str_replace(['_'], ' ', strtolower($targetRole));
            $subject = "Your {$companyName} {$roleLabel} account";
            $body = <<<HTML
<p>Hello {$fullName},</p>
<p>You have been created as a <strong>{$roleLabel}</strong> on the <strong>{$companyName}</strong> platform.</p>
<p>Here are your login details:</p>
<ul>
<li><strong>Email:</strong> {$email}</li>
<li><strong>Role:</strong> {$roleLabel}</li>
<li><strong>Registration ID:</strong> {$registrationId ?: 'N/A'}</li>
</ul>
<p>Please log in to the platform using your email and set your password.</p>
<p>- LSC Proctor Admin</p>
HTML;

            $smtpHost = $env['SMTP_HOST'] ?? '';
            $smtpPort = (int)($env['SMTP_PORT'] ?? 0);
            $smtpUser = $env['SMTP_USER'] ?? '';
            $smtpPass = $env['SMTP_PASS'] ?? '';
            $smtpFrom = $env['SMTP_FROM'] ?? '';
            $smtpSecure = $env['SMTP_SECURE'] ?? '';
            $smtpTimeout = (int)($env['SMTP_TIMEOUT'] ?? 15);
            $smtpAllowSelfSigned = ($env['SMTP_ALLOW_SELF_SIGNED'] ?? '0') === '1';

            $sendFailed = false;
            if ($smtpHost !== '' && $smtpPort > 0 && $smtpFrom !== '') {
                $smtpResult = smtp_send($smtpHost, $smtpPort, $smtpUser, $smtpPass, $smtpFrom, [
                    'to' => $email,
                    'subject' => $subject,
                    'body' => $body,
                ], $smtpSecure, $smtpTimeout, $smtpAllowSelfSigned);
                if (!$smtpResult['ok']) {
                    $sendFailed = true;
                }
            }
        }

        $actorCompanyId = $actorRole === 'SUPER_ADMIN' ? null : require_company_id($payload);
        $filterCompanyId = $actorRole === 'SUPER_ADMIN' ? request_company_filter($payload) : $actorCompanyId;
        json_response([
            'ok' => true,
            'users' => fetch_directory_users($pdo, $actorRole, $actorCompanyId, $filterCompanyId, null, ''),
        ], $action === 'CREATE' ? 201 : 200);
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

    json_response(['error' => 'Invalid action.'], 400);
}

json_response(['error' => 'Method not allowed.'], 405);
