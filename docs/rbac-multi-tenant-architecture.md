# RBAC Multi-Tenant Architecture

## Roles

- `SUPER_ADMIN`
  Global tenant control. Can create companies, manage platform users across companies, view platform-wide analytics, and approve device-change escalations.
- `ADMIN`
  Company admin. Operates only inside one assigned company. Can manage proctor and student identities for that tenant and can use company-scoped exam, result, reporting, and monitoring workflows.
- `PROCTOR`
  Monitoring-only role. Can observe live activity and evidence feeds but cannot manage users, companies, exams, or analytical control-plane data.
- `STUDENT`
  Restricted exam-only role.

## Tenant Isolation

- Company-owned data remains keyed by `company_id`.
- Existing operational tables such as `students`, `batches`, `exams`, `exam_sessions`, `violation_logs`, `audit_logs`, `recording_sessions`, and access-request workflows continue to enforce company scoping.
- New platform-control tables:
  - `companies`
  - `platform_users`

## Control Plane APIs

- `api/companies.php`
  Super-admin-only tenant registry and company lifecycle management.
- `api/users.php`
  Role-aware identity directory.
  - Super admin: can manage `SUPER_ADMIN`, `ADMIN`, `PROCTOR`, `STUDENT`
  - Company admin: can manage `PROCTOR`, `STUDENT` within own company only
- `api/platform_reports.php`
  Super-admin-only cross-company analytics and downloadable report source.

## Workflow Separation

- Company admins and super admins can review general reattempt requests.
- Device-change requests are restricted to `SUPER_ADMIN` review to keep critical exception handling centralized.

## Frontend Surfaces

- Super Admin:
  - `Control Center`
  - `Users`
  - Existing operational views when needed
- Company Admin:
  - `Users`
  - Existing company-scoped exam, student, monitoring, results, recordings, and audit views
- Proctor:
  - Monitoring, security feed, recordings, activity logs
- Student:
  - Exam access only

## Integration Note

The current login flow still authenticates against the external auth endpoint configured in `VITE_ADMIN_AUTH_URL`. The local `platform_users` table is the platform directory and authorization source for management workflows inside this repository, but external identity provisioning may still need to be synchronized by the upstream auth service.
