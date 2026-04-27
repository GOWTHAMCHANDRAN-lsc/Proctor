<?php
declare(strict_types=1);

header('Content-Type: application/json');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Headers: Content-Type, X-Company-Id, X-User-Role, X-Actor-Id');
header('Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS');

ini_set('display_errors', '0');
ini_set('display_startup_errors', '0');
error_reporting(E_ALL);

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(204);
    exit;
}

const ENV_PATHS = [
    __DIR__ . '/../.env',
];

// Backwards compatibility: some scripts referenced a single ENV_PATH constant.
// Point it at the primary entry in ENV_PATHS so those scripts keep working.
if (!defined('ENV_PATH')) {
    define('ENV_PATH', ENV_PATHS[0] ?? (__DIR__ . '/../.env'));
}

function load_env_file(string $path): array {
    if (!is_readable($path)) {
        return [];
    }
    $lines = file($path, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);
    $env = [];
    foreach ($lines as $line) {
        $line = trim($line);
        if ($line === '' || ($line[0] ?? '') === '#') {
            continue;
        }
        $parts = explode('=', $line, 2);
        if (count($parts) !== 2) {
            continue;
        }
        $key = trim($parts[0]);
        $value = trim($parts[1]);
        if ($value !== '' && $value[0] === '"' && substr($value, -1) === '"') {
            $value = substr($value, 1, -1);
        }
        $env[$key] = $value;
    }
    return $env;
}

function load_env_files(array $paths): array {
    $env = [];
    foreach ($paths as $path) {
        if (!is_readable($path)) {
            continue;
        }
        $env = array_merge($env, load_env_file($path));
    }
    return $env;
}

function json_input(): array {
    $raw = file_get_contents('php://input');
    if ($raw === false || trim($raw) === '') {
        return [];
    }
    $data = json_decode($raw, true);
    if (json_last_error() !== JSON_ERROR_NONE) {
        json_response(['error' => 'Invalid JSON payload.'], 400);
    }
    return is_array($data) ? $data : [];
}

function json_response(array $data, int $status = 200): void {
    http_response_code($status);
    $json = json_encode($data, JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
    if ($json === false) {
        $json = json_encode(['error' => 'Response encoding failed.'], JSON_UNESCAPED_UNICODE);
    }
    echo $json;
    exit;
}

function get_company_id(?array $payload = null): ?int {
    $header = $_SERVER['HTTP_X_COMPANY_ID'] ?? '';
    if (is_string($header) && trim($header) !== '') {
        return (int)$header;
    }
    if (isset($_GET['companyId'])) {
        return (int)$_GET['companyId'];
    }
    if (is_array($payload) && isset($payload['companyId'])) {
        return (int)$payload['companyId'];
    }
    return null;
}

function require_company_id(?array $payload = null): int {
    $companyId = get_company_id($payload);
    if ($companyId === null || $companyId <= 0) {
        json_response(['error' => 'companyId is required.'], 400);
    }
    return $companyId;
}

function get_actor_role(?array $payload = null): string {
    $role = $_SERVER['HTTP_X_USER_ROLE'] ?? ($payload['actorRole'] ?? 'STUDENT');
    $role = strtoupper(trim((string)$role));
    $allowed = ['ADMIN', 'SUPER_ADMIN', 'PROCTOR', 'STUDENT', 'SYSTEM'];
    return in_array($role, $allowed, true) ? $role : 'STUDENT';
}

function role_matches_required(string $actualRole, string $requiredRole): bool {
    if ($actualRole === $requiredRole) {
        return true;
    }
    if ($actualRole === 'SUPER_ADMIN' && $requiredRole === 'ADMIN') {
        return true;
    }
    return false;
}

function get_actor_id(?array $payload = null): ?string {
    $header = $_SERVER['HTTP_X_ACTOR_ID'] ?? null;
    if (is_string($header) && trim($header) !== '') {
        return trim($header);
    }
    if (is_array($payload) && isset($payload['actorId']) && trim((string)$payload['actorId']) !== '') {
        return trim((string)$payload['actorId']);
    }
    return null;
}

function require_role(array $roles, ?array $payload = null): string {
    $role = get_actor_role($payload);
    $normalized = array_map(static fn($r) => strtoupper((string)$r), $roles);
    foreach ($normalized as $requiredRole) {
        if (role_matches_required($role, $requiredRole)) {
            return $role;
        }
    }
    json_response(['error' => 'Forbidden for this role.'], 403);
}

function db_column_exists(PDO $pdo, string $table, string $column): bool {
    try {
        static $columnCache = [];
        $cacheKey = "{$table}.{$column}";
        if (array_key_exists($cacheKey, $columnCache)) {
            return $columnCache[$cacheKey];
        }
        $stmt = $pdo->prepare("SHOW COLUMNS FROM {$table} LIKE ?");
        $stmt->execute([$column]);
        $exists = (bool)$stmt->fetch();
        $stmt->closeCursor();
        $columnCache[$cacheKey] = $exists;
        return $exists;
    } catch (Throwable $e) {
        return false;
    }
}

function db_table_exists(PDO $pdo, string $table): bool {
    try {
        $stmt = $pdo->prepare('SHOW TABLES LIKE ?');
        $stmt->execute([$table]);
        $exists = (bool)$stmt->fetch();
        $stmt->closeCursor();
        return $exists;
    } catch (Throwable $e) {
        return false;
    }
}

function db_add_column_if_missing(PDO $pdo, string $table, string $column, string $definition): void {
    try {
        if (!db_column_exists($pdo, $table, $column)) {
            $pdo->exec("ALTER TABLE {$table} ADD COLUMN {$column} {$definition}");
        }
    } catch (Throwable $e) {
        // Runtime migrations are best-effort; normal query errors will still surface.
    }
}

function db_scalar_int(PDO $pdo, string $sql, array $params = []): int {
    $stmt = $pdo->prepare($sql);
    $stmt->execute($params);
    $value = (int)($stmt->fetchColumn() ?: 0);
    $stmt->closeCursor();
    return $value;
}

function db_now_ms(): int {
    return (int)(microtime(true) * 1000);
}

function ensure_audit_role_enum(PDO $pdo): void {
    try {
        $stmt = $pdo->query("SHOW COLUMNS FROM audit_logs LIKE 'actor_role'");
        $column = $stmt ? $stmt->fetch() : null;
        if ($stmt) $stmt->closeCursor();
        $type = is_array($column) ? (string)($column['Type'] ?? '') : '';
        if (stripos($type, 'SUPER_ADMIN') !== false) {
            return;
        }
        $pdo->exec("ALTER TABLE audit_logs MODIFY actor_role ENUM('ADMIN','SUPER_ADMIN','PROCTOR','STUDENT','SYSTEM') NOT NULL DEFAULT 'SYSTEM'");
    } catch (Throwable $e) {
        // Best effort only; audit_log is also non-blocking.
    }
}

function humanize_identifier(string $value): string {
    $normalized = trim(preg_replace('/[^A-Za-z0-9]+/', ' ', $value) ?? '');
    if ($normalized === '') {
        return 'User';
    }
    return ucwords(strtolower($normalized));
}

function ensure_company_directory_schema(PDO $pdo): void {
    try {
        $pdo->exec("CREATE TABLE IF NOT EXISTS companies (
            id            INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
            code          VARCHAR(64) NOT NULL,
            name          VARCHAR(255) NOT NULL,
            contact_name  VARCHAR(255) NULL,
            contact_email VARCHAR(255) NULL,
            status        ENUM('ACTIVE','INACTIVE') NOT NULL DEFAULT 'ACTIVE',
            notes         TEXT NULL,
            created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            UNIQUE KEY uq_companies_code (code)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");

        $stmt = $pdo->query("SELECT COUNT(*) AS cnt FROM companies WHERE id = 1");
        $exists = $stmt ? (int)($stmt->fetch()['cnt'] ?? 0) : 0;
        if ($stmt) {
            $stmt->closeCursor();
        }
        if ($exists === 0) {
            $insert = $pdo->prepare("INSERT INTO companies (id, code, name, contact_name, contact_email, status)
                                     VALUES (1, 'default', 'Default Company', 'Platform Admin', NULL, 'ACTIVE')");
            $insert->execute();
            $insert->closeCursor();
        }
    } catch (Throwable $e) {
        // Best effort schema bootstrap.
    }
}

function list_seed_super_admin_emails(array $env): array {
    $raw = trim((string)($env['SUPER_ADMIN_EMAILS'] ?? $env['VITE_SUPER_ADMIN_EMAILS'] ?? ''));
    if ($raw === '') {
        return [];
    }
    $emails = array_filter(array_map(static fn($item) => strtolower(trim((string)$item)), explode(',', $raw)));
    return array_values(array_unique(array_filter($emails, static fn($item) => strpos($item, '@') !== false)));
}

function ensure_platform_user_schema(PDO $pdo, array $env): void {
    try {
        $pdo->exec("CREATE TABLE IF NOT EXISTS platform_users (
            id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
            company_id       INT UNSIGNED NULL,
            role             ENUM('SUPER_ADMIN','ADMIN','PROCTOR','STUDENT') NOT NULL,
            full_name        VARCHAR(255) NOT NULL,
            email            VARCHAR(255) NOT NULL,
            status           ENUM('ACTIVE','INVITED','DISABLED') NOT NULL DEFAULT 'ACTIVE',
            registration_id  VARCHAR(128) NULL,
            external_auth_id VARCHAR(128) NULL,
            notes            TEXT NULL,
            created_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            UNIQUE KEY uq_platform_users_email (email),
            KEY idx_platform_users_company_role (company_id, role),
            KEY idx_platform_users_status (status)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");

        db_add_column_if_missing($pdo, 'platform_users', 'registration_id', "VARCHAR(128) NULL AFTER status");
        db_add_column_if_missing($pdo, 'platform_users', 'external_auth_id', "VARCHAR(128) NULL AFTER registration_id");
        db_add_column_if_missing($pdo, 'platform_users', 'notes', "TEXT NULL AFTER external_auth_id");

        foreach (list_seed_super_admin_emails($env) as $email) {
            $seed = $pdo->prepare("INSERT INTO platform_users (company_id, role, full_name, email, status)
                                   SELECT NULL, 'SUPER_ADMIN', ?, ?, 'ACTIVE'
                                   FROM DUAL
                                   WHERE NOT EXISTS (SELECT 1 FROM platform_users WHERE email = ? LIMIT 1)");
            $seed->execute([
                humanize_identifier(strtok($email, '@') ?: 'Super Admin'),
                $email,
                $email,
            ]);
            $seed->closeCursor();
        }
    } catch (Throwable $e) {
        // Best effort schema bootstrap.
    }
}

set_error_handler(function (int $severity, string $message, string $file, int $line): void {
    if (!(error_reporting() & $severity)) {
        return;
    }
    throw new ErrorException($message, 0, $severity, $file, $line);
});

set_exception_handler(function (Throwable $e): void {
    json_response([
        'error' => 'Server error.',
        'detail' => $e->getMessage(),
    ], 500);
});

function audit_log(PDO $pdo, array $entry): void {
    try {
        $companyId = $entry['companyId'] ?? get_company_id($entry['payload'] ?? null);
        if ($companyId === null || $companyId <= 0) {
            return;
        }
        $actorRole = strtoupper((string)($entry['actorRole'] ?? 'SYSTEM'));
        if ($actorRole === 'SUPER_ADMIN') {
            // Keep audit writes compatible with older stored procedures that only accept ADMIN.
            $actorRole = 'ADMIN';
        }
        $actorId = $entry['actorId'] ?? null;
        $action = $entry['action'] ?? 'UNKNOWN';
        $targetType = $entry['targetType'] ?? null;
        $targetId = $entry['targetId'] ?? null;
        $message = $entry['message'] ?? null;
        $metadata = $entry['metadata'] ?? null;
        $ipAddress = $_SERVER['REMOTE_ADDR'] ?? null;
        $userAgent = $_SERVER['HTTP_USER_AGENT'] ?? null;

        $metadataJson = null;
        if (is_array($metadata) || is_object($metadata)) {
            $metadataJson = json_encode($metadata);
        } elseif (is_string($metadata)) {
            $metadataJson = $metadata;
        }

        $stmt = $pdo->prepare('CALL sp_add_audit(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
        $stmt->execute([
            $companyId,
            $actorRole,
            $actorId,
            $action,
            $targetType,
            $targetId,
            $message,
            $metadataJson,
            $ipAddress,
            $userAgent
        ]);
        while ($stmt->nextRowset()) {}
        $stmt->closeCursor();
    } catch (Throwable $e) {
        // Best-effort audit logging; ignore failures.
    }
}

$env = load_env_files(ENV_PATHS);
if (!ini_get('date.timezone')) {
    date_default_timezone_set('UTC');
}
$dbHost = $env['MYSQL_HOST'] ?? '127.0.0.1';
$dbPort = $env['MYSQL_PORT'] ?? '3306';
$dbName = $env['MYSQL_DATABASE'] ?? 'proctorguard';
$dbUser = $env['MYSQL_USER'] ?? 'root';
$dbPass = $env['MYSQL_PASSWORD'] ?? '';

try {
    $dsn = "mysql:host={$dbHost};port={$dbPort};dbname={$dbName};charset=utf8mb4";
    $pdo = new PDO($dsn, $dbUser, $dbPass, [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
    ]);
    $pdo->exec("SET NAMES utf8mb4 COLLATE utf8mb4_general_ci");
} catch (Throwable $e) {
    json_response(['error' => 'Database connection failed.'], 500);
}

ensure_audit_role_enum($pdo);
ensure_company_directory_schema($pdo);
ensure_platform_user_schema($pdo, $env);
