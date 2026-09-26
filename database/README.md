# Database

MySQL 8 (InnoDB, utf8mb4). Database name: `proctorguard`.

| File | Contents |
|------|----------|
| `schema.sql` | Structure of all 41 tables, dumped from production (no rows, no `DEFINER`, no `AUTO_INCREMENT` counters). |
| `routines.sql` | The 37 stored procedures the API calls (`sp_log_access`, `sp_add_delivery_log`, `sp_reset_mac_binding`, ...). |

The root-level `schema.sql` / `proctorguard.sql` are older snapshots and are missing newer tables; use this folder.

## Fresh local setup

```bash
mysql -uroot -e "CREATE DATABASE proctorguard CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
                 CREATE USER 'proctor_user'@'127.0.0.1' IDENTIFIED BY 'changeme';
                 GRANT ALL PRIVILEGES ON proctorguard.* TO 'proctor_user'@'127.0.0.1';"
mysql -uroot proctorguard < database/schema.sql
mysql -uroot proctorguard < database/routines.sql
```

Then set the `MYSQL_*` values in `.env` (see `.env.example`). No seed data is needed: on first request
`api/_bootstrap.php` creates the default company (id 1) and the platform super admins listed in `SUPER_ADMIN_EMAILS`.

## Restoring a production data snapshot

Full data dumps contain candidate PII, face snapshots and credential hashes, so they are **never committed**
(the repo is public). They are kept on the server in `~/proctor-db-exports/` (mode 700). To use one locally:

```bash
scp <server>:~/proctor-db-exports/proctorguard-full-YYYYMMDD-HHMM.sql.gz .
mysql -uroot -e "CREATE DATABASE proctorguard CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
gunzip -c proctorguard-full-*.sql.gz | mysql -uroot proctorguard
mysql -uroot proctorguard < database/routines.sql   # the data dump does not include procedures
```

## Regenerating

Read-only and lock-free (all tables are InnoDB), safe to run against production:

```bash
mysqldump --single-transaction --skip-lock-tables --no-tablespaces --set-gtid-purged=OFF \
  --no-data --skip-routines --triggers --events --skip-dump-date proctorguard \
  | sed -E 's/DEFINER=`[^`]+`@`[^`]+`//g; s/ AUTO_INCREMENT=[0-9]+//' > database/schema.sql
```

`proctor_user` cannot `SHOW CREATE PROCEDURE` (the procedures are owned by root), so `routines.sql` can only be
regenerated with a root login: `mysqldump -uroot --no-data --no-create-info --skip-triggers --routines proctorguard`.
