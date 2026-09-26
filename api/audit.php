<?php
declare(strict_types=1);

require __DIR__ . '/_bootstrap.php';

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

$method = $_SERVER['REQUEST_METHOD'];

if ($method === 'GET') {
    require_staff(); // admin-only read: blocks tokenless/forged-header access
    $companyId = require_company_id();
    // Company-scoped viewers (ADMIN / PROCTOR / VIEWER) must not see SUPER_ADMIN / platform activity
    // that happens to be recorded under their company (e.g. a super admin provisioning a user,
    // editing exams, or managing students while acting as this company). Only a SUPER_ADMIN viewer
    // sees super-admin actor entries.
    //
    // The stored actor_role is NOT a reliable signal: several endpoints (e.g. exams.php) hardcode
    // 'ADMIN' when writing the audit row even when the real actor is a super admin, and audit_log()
    // downgrades SUPER_ADMIN -> ADMIN for stored-procedure compatibility. So we identify super-admin
    // activity by ACTOR IDENTITY — the actor_id of any account whose role is SUPER_ADMIN in the auth
    // directory — and exclude those rows for company-scoped viewers. This covers both legacy rows and
    // future rows regardless of how actor_role was stamped.
    $viewerRole = get_actor_role();
    $hideSuperAdmin = $viewerRole !== 'SUPER_ADMIN';

    $superAdminActorIds = [];
    if ($hideSuperAdmin) {
        foreach (['platform_users', 'users'] as $dirTable) {
            if (!db_table_exists($pdo, $dirTable)) continue;
            try {
                $idStmt = $pdo->query("SELECT email FROM {$dirTable} WHERE UPPER(role) = 'SUPER_ADMIN' AND email IS NOT NULL AND email <> ''");
                foreach ($idStmt->fetchAll() as $r) {
                    $email = trim((string)($r['email'] ?? ''));
                    if ($email !== '') $superAdminActorIds[$email] = true;
                }
                $idStmt->closeCursor();
            } catch (Throwable $e) {
                // Best effort; a missing column simply means no identity-based exclusion from this table.
            }
        }
    }
    $superAdminActorIds = array_keys($superAdminActorIds);
    $hasSuperAdminIds = count($superAdminActorIds) > 0;
    $actorRole = isset($_GET['actorRole']) ? trim((string)$_GET['actorRole']) : null;
    $actorId = isset($_GET['actorId']) ? trim((string)$_GET['actorId']) : null;
    $action = isset($_GET['action']) ? trim((string)$_GET['action']) : null;
    $targetType = isset($_GET['targetType']) ? trim((string)$_GET['targetType']) : null;
    $targetId = isset($_GET['targetId']) ? trim((string)$_GET['targetId']) : null;
    $limit = isset($_GET['limit']) ? (int)$_GET['limit'] : 100;
    $offset = isset($_GET['offset']) ? (int)$_GET['offset'] : 0;

    if ($actorRole === '') $actorRole = null;
    if ($actorId === '') $actorId = null;
    if ($action === '') $action = null;
    if ($targetType === '') $targetType = null;
    if ($targetId === '') $targetId = null;
    if ($limit <= 0) $limit = 100;
    if ($limit > 500) $limit = 500;
    if ($offset < 0) $offset = 0;

    $countWhere = [];
    $countParams = [];
    if ($actorRole) { $countWhere[] = 'actor_role = ?'; $countParams[] = $actorRole; }
    if ($actorId) { $countWhere[] = 'actor_id = ?'; $countParams[] = $actorId; }
    if ($action) { $countWhere[] = 'action = ?'; $countParams[] = $action; }
    if ($targetType) { $countWhere[] = 'target_type = ?'; $countParams[] = $targetType; }
    if ($targetId) { $countWhere[] = 'target_id = ?'; $countParams[] = $targetId; }
    if ($hideSuperAdmin) { $countWhere[] = "actor_role <> 'SUPER_ADMIN'"; }
    if ($hideSuperAdmin && $hasSuperAdminIds) {
        $ph = implode(',', array_fill(0, count($superAdminActorIds), '?'));
        $countWhere[] = "(actor_id IS NULL OR actor_id NOT IN ($ph))";
        foreach ($superAdminActorIds as $sid) { $countParams[] = $sid; }
    }

    $countSql = 'SELECT COUNT(*) AS total FROM audit_logs WHERE company_id = ?';
    $countParams = array_merge([$companyId], $countParams);
    if (!empty($countWhere)) {
        $countSql .= ' AND ' . implode(' AND ', $countWhere);
    }
    $countStmt = $pdo->prepare($countSql);
    $countStmt->execute($countParams);
    $countRow = $countStmt->fetch();
    $total = $countRow ? (int)$countRow['total'] : 0;

    $sql = 'SELECT id, actor_role, actor_id, action, target_type, target_id, message, metadata, ip_address, user_agent, created_at
            FROM audit_logs
            WHERE company_id = ?';
    $params = [$companyId];
    if ($actorRole) { $sql .= ' AND actor_role = ?'; $params[] = $actorRole; }
    if ($actorId) { $sql .= ' AND actor_id = ?'; $params[] = $actorId; }
    if ($action) { $sql .= ' AND action = ?'; $params[] = $action; }
    if ($targetType) { $sql .= ' AND target_type = ?'; $params[] = $targetType; }
    if ($targetId) { $sql .= ' AND target_id = ?'; $params[] = $targetId; }
    if ($hideSuperAdmin) { $sql .= " AND actor_role <> 'SUPER_ADMIN'"; }
    if ($hideSuperAdmin && $hasSuperAdminIds) {
        $ph = implode(',', array_fill(0, count($superAdminActorIds), '?'));
        $sql .= " AND (actor_id IS NULL OR actor_id NOT IN ($ph))";
        foreach ($superAdminActorIds as $sid) { $params[] = $sid; }
    }
    $sql .= ' ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?';

    $stmt = $pdo->prepare($sql);
    foreach ($params as $index => $value) {
        $stmt->bindValue($index + 1, $value);
    }
    $stmt->bindValue(count($params) + 1, $limit, PDO::PARAM_INT);
    $stmt->bindValue(count($params) + 2, $offset, PDO::PARAM_INT);
    $stmt->execute();
    $rows = $stmt->fetchAll();
    $stmt->closeCursor();

    $logs = array_map(function ($row) {
        $metadata = null;
        if (!empty($row['metadata'])) {
            $decoded = json_decode($row['metadata'], true);
            $metadata = json_last_error() === JSON_ERROR_NONE ? $decoded : null;
        }
        return [
            'id' => (int)$row['id'],
            'actorRole' => $row['actor_role'],
            'actorId' => $row['actor_id'],
            'action' => $row['action'],
            'targetType' => $row['target_type'],
            'targetId' => $row['target_id'],
            'message' => $row['message'],
            'metadata' => $metadata,
            'ipAddress' => $row['ip_address'],
            'userAgent' => $row['user_agent'],
            'createdAt' => datetime_to_ms($row['created_at']) ?? 0,
        ];
    }, $rows);

    json_response(['logs' => $logs, 'total' => $total]);
}

json_response(['error' => 'Method not allowed.'], 405);
