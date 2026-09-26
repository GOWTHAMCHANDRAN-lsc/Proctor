-- ProctorGuard Enterprise - MySQL schema (XAMPP)
-- Compatible with MySQL 8.x (JSON, DATETIME(3))

CREATE DATABASE IF NOT EXISTS proctorguard
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE proctorguard;

-- Students
-- email / registration_id are unique per company (not globally) — the same real person can be
-- enrolled as a separate student record under two different companies. See
-- ensure_student_company_scoped_uniqueness() in api/_bootstrap.php for the live-DB migration.
CREATE TABLE IF NOT EXISTS students (
  id              VARCHAR(64) PRIMARY KEY,
  company_id      INT NOT NULL DEFAULT 1,
  full_name       VARCHAR(255) NOT NULL,
  email           VARCHAR(255) NOT NULL,
  registration_id VARCHAR(128) NOT NULL,
  face_descriptor TEXT NULL,
  face_photo      MEDIUMTEXT NULL,
  enrolled_at     TIMESTAMP NULL DEFAULT NULL,
  batch_id        BIGINT UNSIGNED NULL,
  created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_students_company_email (company_id, email),
  UNIQUE KEY uq_students_company_regid (company_id, registration_id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS batches (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  company_id  INT NOT NULL DEFAULT 1,
  name        VARCHAR(255) NOT NULL,
  description TEXT NULL,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_batches_company_name (company_id, name)
) ENGINE=InnoDB;

-- Many-to-many: a student can be enrolled in more than one batch. students.batch_id
-- above is legacy/unused (kept only so no historical data is lost) — batch membership
-- is authoritative here.
CREATE TABLE IF NOT EXISTS student_batches (
  student_id  VARCHAR(64) NOT NULL,
  batch_id    BIGINT UNSIGNED NOT NULL,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (student_id, batch_id),
  INDEX idx_student_batches_batch (batch_id),
  CONSTRAINT fk_student_batches_student FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE,
  CONSTRAINT fk_student_batches_batch FOREIGN KEY (batch_id) REFERENCES batches(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Company-scoped app settings (branding, exam defaults, UI prefs) as one JSON blob
CREATE TABLE IF NOT EXISTS app_settings (
  company_id    INT UNSIGNED NOT NULL PRIMARY KEY,
  settings_json LONGTEXT NOT NULL,
  updated_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- Exams
CREATE TABLE IF NOT EXISTS exams (
  id                    VARCHAR(64) PRIMARY KEY,
  company_id            INT NOT NULL DEFAULT 1,
  title                 VARCHAR(255) NOT NULL,
  duration_minutes      INT NOT NULL,
  start_time            DATETIME(3) NOT NULL,
  end_time              DATETIME(3) NOT NULL,
  timezone              VARCHAR(64) NULL,
  question_count        INT NULL,
  shuffle_questions     TINYINT(1) NOT NULL DEFAULT 1,
  show_results          TINYINT(1) NOT NULL DEFAULT 0,
  pass_percent          INT NOT NULL DEFAULT 60,
  attempt_policy        ENUM('BEST','LAST','AVERAGE') NOT NULL DEFAULT 'LAST',
  reconnect_limit       INT NOT NULL DEFAULT 0,
  total_marks           INT NOT NULL DEFAULT 0,
  status                ENUM('DRAFT','PUBLISHED','ARCHIVED') NOT NULL DEFAULT 'DRAFT',

  -- Proctoring config
  camera_required       TINYINT(1) NOT NULL DEFAULT 0,
  microphone_required   TINYINT(1) NOT NULL DEFAULT 0,
  fullscreen_enforced   TINYINT(1) NOT NULL DEFAULT 0,
  tab_switch_limit      INT NOT NULL DEFAULT 3,
  violation_limits_json JSON NULL,
  allowed_device_types_json JSON NULL,
  certificate_enabled   TINYINT(1) NOT NULL DEFAULT 0,

  -- Notification config
  notification_enabled  TINYINT(1) NOT NULL DEFAULT 0,
  reminder_hours24      TINYINT(1) NOT NULL DEFAULT 1,
  reminder_hours1       TINYINT(1) NOT NULL DEFAULT 1,
  notification_subject  VARCHAR(255) NULL,
  notification_message  TEXT NULL,

  created_at            TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at            TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- Ensure show_results exists for existing databases
SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = 'proctorguard' AND TABLE_NAME = 'exams' AND COLUMN_NAME = 'show_results'
);
SET @sql = IF(@col_exists = 0,
  'ALTER TABLE exams ADD COLUMN show_results TINYINT(1) NOT NULL DEFAULT 0',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Ensure company_id exists for existing databases
SET @students_company_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = 'proctorguard' AND TABLE_NAME = 'students' AND COLUMN_NAME = 'company_id'
);
SET @students_company_sql = IF(@students_company_exists = 0,
  'ALTER TABLE students ADD COLUMN company_id INT NOT NULL DEFAULT 1',
  'SELECT 1'
);
PREPARE students_company_stmt FROM @students_company_sql;
EXECUTE students_company_stmt;
DEALLOCATE PREPARE students_company_stmt;

SET @students_batch_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = 'proctorguard' AND TABLE_NAME = 'students' AND COLUMN_NAME = 'batch_id'
);
SET @students_batch_sql = IF(@students_batch_exists = 0,
  'ALTER TABLE students ADD COLUMN batch_id BIGINT UNSIGNED NULL',
  'SELECT 1'
);
PREPARE students_batch_stmt FROM @students_batch_sql;
EXECUTE students_batch_stmt;
DEALLOCATE PREPARE students_batch_stmt;

SET @exams_company_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = 'proctorguard' AND TABLE_NAME = 'exams' AND COLUMN_NAME = 'company_id'
);
SET @exams_company_sql = IF(@exams_company_exists = 0,
  'ALTER TABLE exams ADD COLUMN company_id INT NOT NULL DEFAULT 1',
  'SELECT 1'
);
PREPARE exams_company_stmt FROM @exams_company_sql;
EXECUTE exams_company_stmt;
DEALLOCATE PREPARE exams_company_stmt;

SET @sessions_company_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = 'proctorguard' AND TABLE_NAME = 'exam_sessions' AND COLUMN_NAME = 'company_id'
);
SET @sessions_company_sql = IF(@sessions_company_exists = 0,
  'ALTER TABLE exam_sessions ADD COLUMN company_id INT NOT NULL DEFAULT 1',
  'SELECT 1'
);
PREPARE sessions_company_stmt FROM @sessions_company_sql;
EXECUTE sessions_company_stmt;
DEALLOCATE PREPARE sessions_company_stmt;

SET @violations_company_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = 'proctorguard' AND TABLE_NAME = 'violation_logs' AND COLUMN_NAME = 'company_id'
);
SET @violations_company_sql = IF(@violations_company_exists = 0,
  'ALTER TABLE violation_logs ADD COLUMN company_id INT NOT NULL DEFAULT 1',
  'SELECT 1'
);
PREPARE violations_company_stmt FROM @violations_company_sql;
EXECUTE violations_company_stmt;
DEALLOCATE PREPARE violations_company_stmt;

SET @access_company_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = 'proctorguard' AND TABLE_NAME = 'exam_access_logs' AND COLUMN_NAME = 'company_id'
);
SET @access_company_sql = IF(@access_company_exists = 0,
  'ALTER TABLE exam_access_logs ADD COLUMN company_id INT NOT NULL DEFAULT 1',
  'SELECT 1'
);
PREPARE access_company_stmt FROM @access_company_sql;
EXECUTE access_company_stmt;
DEALLOCATE PREPARE access_company_stmt;

SET @audit_company_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = 'proctorguard' AND TABLE_NAME = 'audit_logs' AND COLUMN_NAME = 'company_id'
);
SET @audit_company_sql = IF(@audit_company_exists = 0,
  'ALTER TABLE audit_logs ADD COLUMN company_id INT NOT NULL DEFAULT 1',
  'SELECT 1'
);
PREPARE audit_company_stmt FROM @audit_company_sql;
EXECUTE audit_company_stmt;
DEALLOCATE PREPARE audit_company_stmt;

SET @templates_company_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = 'proctorguard' AND TABLE_NAME = 'notification_templates' AND COLUMN_NAME = 'company_id'
);
SET @templates_company_sql = IF(@templates_company_exists = 0,
  'ALTER TABLE notification_templates ADD COLUMN company_id INT NOT NULL DEFAULT 1',
  'SELECT 1'
);
PREPARE templates_company_stmt FROM @templates_company_sql;
EXECUTE templates_company_stmt;
DEALLOCATE PREPARE templates_company_stmt;

SET @delivery_company_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = 'proctorguard' AND TABLE_NAME = 'delivery_logs' AND COLUMN_NAME = 'company_id'
);
SET @delivery_company_sql = IF(@delivery_company_exists = 0,
  'ALTER TABLE delivery_logs ADD COLUMN company_id INT NOT NULL DEFAULT 1',
  'SELECT 1'
);
PREPARE delivery_company_stmt FROM @delivery_company_sql;
EXECUTE delivery_company_stmt;
DEALLOCATE PREPARE delivery_company_stmt;

-- Ensure pass_percent exists for existing databases
SET @pass_percent_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = 'proctorguard' AND TABLE_NAME = 'exams' AND COLUMN_NAME = 'pass_percent'
);
SET @pass_percent_sql = IF(@pass_percent_exists = 0,
  'ALTER TABLE exams ADD COLUMN pass_percent INT NOT NULL DEFAULT 60',
  'SELECT 1'
);
PREPARE pass_percent_stmt FROM @pass_percent_sql;
EXECUTE pass_percent_stmt;
DEALLOCATE PREPARE pass_percent_stmt;

-- Ensure reconnect_limit exists for existing databases
SET @reconnect_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = 'proctorguard' AND TABLE_NAME = 'exams' AND COLUMN_NAME = 'reconnect_limit'
);
SET @reconnect_sql = IF(@reconnect_exists = 0,
  'ALTER TABLE exams ADD COLUMN reconnect_limit INT NOT NULL DEFAULT 0',
  'SELECT 1'
);
PREPARE reconnect_stmt FROM @reconnect_sql;
EXECUTE reconnect_stmt;
DEALLOCATE PREPARE reconnect_stmt;

-- Ensure attempt_policy exists for existing databases
SET @attempt_policy_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = 'proctorguard' AND TABLE_NAME = 'exams' AND COLUMN_NAME = 'attempt_policy'
);
SET @attempt_policy_sql = IF(@attempt_policy_exists = 0,
  'ALTER TABLE exams ADD COLUMN attempt_policy ENUM(''BEST'',''LAST'',''AVERAGE'') NOT NULL DEFAULT ''LAST''',
  'SELECT 1'
);
PREPARE attempt_policy_stmt FROM @attempt_policy_sql;
EXECUTE attempt_policy_stmt;
DEALLOCATE PREPARE attempt_policy_stmt;

-- Ensure violation_limits_json exists for existing databases
SET @violation_limits_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = 'proctorguard' AND TABLE_NAME = 'exams' AND COLUMN_NAME = 'violation_limits_json'
);
SET @violation_limits_sql = IF(@violation_limits_exists = 0,
  'ALTER TABLE exams ADD COLUMN violation_limits_json JSON NULL',
  'SELECT 1'
);
PREPARE violation_limits_stmt FROM @violation_limits_sql;
EXECUTE violation_limits_stmt;
DEALLOCATE PREPARE violation_limits_stmt;

-- Ensure timezone exists for existing databases
SET @exam_timezone_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = 'proctorguard' AND TABLE_NAME = 'exams' AND COLUMN_NAME = 'timezone'
);
SET @exam_timezone_sql = IF(@exam_timezone_exists = 0,
  'ALTER TABLE exams ADD COLUMN timezone VARCHAR(64) NULL AFTER end_time',
  'SELECT 1'
);
PREPARE exam_timezone_stmt FROM @exam_timezone_sql;
EXECUTE exam_timezone_stmt;
DEALLOCATE PREPARE exam_timezone_stmt;

-- Ensure allowed_device_types_json exists for existing databases
SET @allowed_devices_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = 'proctorguard' AND TABLE_NAME = 'exams' AND COLUMN_NAME = 'allowed_device_types_json'
);
SET @allowed_devices_sql = IF(@allowed_devices_exists = 0,
  'ALTER TABLE exams ADD COLUMN allowed_device_types_json JSON NULL',
  'SELECT 1'
);
PREPARE allowed_devices_stmt FROM @allowed_devices_sql;
EXECUTE allowed_devices_stmt;
DEALLOCATE PREPARE allowed_devices_stmt;

-- Ensure certificate_enabled exists for existing databases. Certificate issuance is on-demand
-- only (never automatic on pass) and is gated per-exam by this flag, set on exam creation.
SET @cert_enabled_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = 'proctorguard' AND TABLE_NAME = 'exams' AND COLUMN_NAME = 'certificate_enabled'
);
SET @cert_enabled_sql = IF(@cert_enabled_exists = 0,
  'ALTER TABLE exams ADD COLUMN certificate_enabled TINYINT(1) NOT NULL DEFAULT 0',
  'SELECT 1'
);
PREPARE cert_enabled_stmt FROM @cert_enabled_sql;
EXECUTE cert_enabled_stmt;
DEALLOCATE PREPARE cert_enabled_stmt;

-- Ensure device_fingerprint exists for existing databases
SET @device_fp_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = 'proctorguard' AND TABLE_NAME = 'exam_sessions' AND COLUMN_NAME = 'device_fingerprint'
);
SET @device_fp_sql = IF(@device_fp_exists = 0,
  'ALTER TABLE exam_sessions ADD COLUMN device_fingerprint VARCHAR(128) NULL',
  'SELECT 1'
);
PREPARE device_fp_stmt FROM @device_fp_sql;
EXECUTE device_fp_stmt;
DEALLOCATE PREPARE device_fp_stmt;

-- Ensure exam_sections.time_limit_minutes exists for existing databases
SET @section_table_exists = (
  SELECT COUNT(*) FROM information_schema.TABLES
  WHERE TABLE_SCHEMA = 'proctorguard' AND TABLE_NAME = 'exam_sections'
);
SET @section_time_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = 'proctorguard' AND TABLE_NAME = 'exam_sections' AND COLUMN_NAME = 'time_limit_minutes'
);
SET @section_time_sql = IF(@section_table_exists = 1 AND @section_time_exists = 0,
  'ALTER TABLE exam_sections ADD COLUMN time_limit_minutes INT NOT NULL DEFAULT 0',
  'SELECT 1'
);
PREPARE section_time_stmt FROM @section_time_sql;
EXECUTE section_time_stmt;
DEALLOCATE PREPARE section_time_stmt;

-- Ensure exam_sections.lock_on_complete exists for existing databases
SET @section_lock_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = 'proctorguard' AND TABLE_NAME = 'exam_sections' AND COLUMN_NAME = 'lock_on_complete'
);
SET @section_lock_sql = IF(@section_table_exists = 1 AND @section_lock_exists = 0,
  'ALTER TABLE exam_sections ADD COLUMN lock_on_complete TINYINT(1) NOT NULL DEFAULT 1',
  'SELECT 1'
);
PREPARE section_lock_stmt FROM @section_lock_sql;
EXECUTE section_lock_stmt;
DEALLOCATE PREPARE section_lock_stmt;

-- Questions
CREATE TABLE IF NOT EXISTS questions (
  id                    VARCHAR(64) PRIMARY KEY,
  -- One of: MCQ, MULTI_SELECT, TRUE_FALSE, YES_NO, SHORT_TEXT, LONG_TEXT, FILL_BLANK,
  -- NUMERIC, DATE, TIME, MATCHING, ORDERING, DRAG_DROP (legacy: TEXT). Validated in PHP.
  type                  VARCHAR(32) NOT NULL,
  text                  TEXT NOT NULL,
  options_json          JSON NULL,           -- string[] options for MCQ / MULTI_SELECT
  correct_option_index  INT NULL,            -- MCQ / TRUE_FALSE / YES_NO
  answer_key_json       JSON NULL,           -- structured correct-answer spec (see AnswerKey)
  match_options_json    JSON NULL,           -- left/right/items/buckets for MATCHING/ORDERING/DRAG_DROP
  marks                 INT NOT NULL DEFAULT 1,
  negative_marks        DECIMAL(8,2) NOT NULL DEFAULT 0, -- deducted on a wrong auto-graded answer; supports fractions (0.25, 0.5); 0 = off
  word_limit            INT NULL             -- SHORT_TEXT / LONG_TEXT word cap (NULL = no limit)
) ENGINE=InnoDB;

-- Exam <-> Question linkage (with optional ordering)
CREATE TABLE IF NOT EXISTS exam_questions (
  exam_id        VARCHAR(64) NOT NULL,
  question_id    VARCHAR(64) NOT NULL,
  display_order  INT NULL,
  PRIMARY KEY (exam_id, question_id),
  INDEX idx_exam_questions_question (question_id),
  CONSTRAINT fk_exam_questions_exam
    FOREIGN KEY (exam_id) REFERENCES exams(id)
    ON DELETE CASCADE,
  CONSTRAINT fk_exam_questions_question
    FOREIGN KEY (question_id) REFERENCES questions(id)
    ON DELETE CASCADE
) ENGINE=InnoDB;

-- Exam sections (question pools)
CREATE TABLE IF NOT EXISTS exam_sections (
  id               VARCHAR(64) PRIMARY KEY,
  exam_id          VARCHAR(64) NOT NULL,
  title            VARCHAR(255) NOT NULL,
  display_order    INT NOT NULL DEFAULT 0,
  question_limit   INT NOT NULL DEFAULT 0,
  shuffle_questions TINYINT(1) NOT NULL DEFAULT 1,
  time_limit_minutes INT NOT NULL DEFAULT 0,
  lock_on_complete TINYINT(1) NOT NULL DEFAULT 1,
  INDEX idx_exam_sections_exam (exam_id),
  CONSTRAINT fk_exam_sections_exam
    FOREIGN KEY (exam_id) REFERENCES exams(id)
    ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS exam_section_questions (
  section_id     VARCHAR(64) NOT NULL,
  question_id    VARCHAR(64) NOT NULL,
  display_order  INT NULL,
  PRIMARY KEY (section_id, question_id),
  INDEX idx_section_questions_question (question_id),
  CONSTRAINT fk_section_questions_section
    FOREIGN KEY (section_id) REFERENCES exam_sections(id)
    ON DELETE CASCADE,
  CONSTRAINT fk_section_questions_question
    FOREIGN KEY (question_id) REFERENCES questions(id)
    ON DELETE CASCADE
) ENGINE=InnoDB;

-- Exam assignments (empty set means open to all students)
CREATE TABLE IF NOT EXISTS exam_assignments (
  exam_id     VARCHAR(64) NOT NULL,
  student_id  VARCHAR(64) NOT NULL,
  assigned_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (exam_id, student_id),
  CONSTRAINT fk_exam_assignments_exam
    FOREIGN KEY (exam_id) REFERENCES exams(id)
    ON DELETE CASCADE,
  CONSTRAINT fk_exam_assignments_student
    FOREIGN KEY (student_id) REFERENCES students(id)
    ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS exam_batch_assignments (
  exam_id     VARCHAR(64) NOT NULL,
  batch_id    BIGINT UNSIGNED NOT NULL,
  assigned_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (exam_id, batch_id),
  INDEX idx_exam_batch_assignments_batch (batch_id)
) ENGINE=InnoDB;

-- One row per student who has been sent an access link for an exam. Lets a later send target only
-- the students assigned since the last invitation, instead of re-mailing candidates mid-exam.
CREATE TABLE IF NOT EXISTS exam_invitations (
  exam_id    VARCHAR(64) NOT NULL,
  student_id VARCHAR(64) NOT NULL,
  sent_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (exam_id, student_id),
  INDEX idx_exam_invitations_student (student_id)
) ENGINE=InnoDB;

-- Exam sessions (attempts)
CREATE TABLE IF NOT EXISTS exam_sessions (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  company_id   INT NOT NULL DEFAULT 1,
  exam_id      VARCHAR(64) NOT NULL,
  student_id   VARCHAR(64) NOT NULL,
  start_time   DATETIME(3) NOT NULL,
  end_time     DATETIME(3) NULL,
  status       ENUM('IN_PROGRESS','COMPLETED','TERMINATED') NOT NULL DEFAULT 'IN_PROGRESS',
  ip_address   VARCHAR(64) NULL,
  user_agent   VARCHAR(512) NULL,
  device_fingerprint VARCHAR(128) NULL,
  device_metadata_json JSON NULL,
  mac_address VARCHAR(32) NULL,
  mac_bound TINYINT(1) NOT NULL DEFAULT 0,
  location     VARCHAR(255) NULL,
  location_lat DECIMAL(10,7) NULL,
  location_lng DECIMAL(10,7) NULL,
  location_accuracy_m INT NULL,
  total_score  DECIMAL(8,2) NULL,
  max_score    DECIMAL(8,2) NULL,
  passed       TINYINT(1) NULL,
  INDEX idx_sessions_exam_student (exam_id, student_id),
  CONSTRAINT fk_sessions_exam
    FOREIGN KEY (exam_id) REFERENCES exams(id)
    ON DELETE CASCADE,
  CONSTRAINT fk_sessions_student
    FOREIGN KEY (student_id) REFERENCES students(id)
    ON DELETE CASCADE
) ENGINE=InnoDB;

-- Answers per session/question
CREATE TABLE IF NOT EXISTS session_answers (
  session_id           BIGINT UNSIGNED NOT NULL,
  question_id          VARCHAR(64) NOT NULL,
  answer_text          TEXT NULL,
  answer_option_index  INT NULL,
  answer_json          JSON NULL,   -- structured response (arrays/maps) for non-option-index types
  is_correct           TINYINT(1) NULL,
  awarded_marks        DECIMAL(8,2) NULL,
  created_at           TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (session_id, question_id),
  CONSTRAINT fk_session_answers_session
    FOREIGN KEY (session_id) REFERENCES exam_sessions(id)
    ON DELETE CASCADE,
  CONSTRAINT fk_session_answers_question
    FOREIGN KEY (question_id) REFERENCES questions(id)
    ON DELETE CASCADE
) ENGINE=InnoDB;

-- Time spent per question (seconds)
CREATE TABLE IF NOT EXISTS session_question_times (
  session_id   BIGINT UNSIGNED NOT NULL,
  question_id  VARCHAR(64) NOT NULL,
  seconds_spent INT NOT NULL DEFAULT 0,
  PRIMARY KEY (session_id, question_id),
  CONSTRAINT fk_sqt_session
    FOREIGN KEY (session_id) REFERENCES exam_sessions(id)
    ON DELETE CASCADE,
  CONSTRAINT fk_sqt_question
    FOREIGN KEY (question_id) REFERENCES questions(id)
    ON DELETE CASCADE
) ENGINE=InnoDB;

-- Result regrade audit logs
CREATE TABLE IF NOT EXISTS result_audit_logs (
  id                    BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  session_id            BIGINT UNSIGNED NOT NULL,
  question_id           VARCHAR(64) NULL,
  previous_awarded_marks DECIMAL(8,2) NULL,
  new_awarded_marks     DECIMAL(8,2) NULL,
  previous_is_correct   TINYINT(1) NULL,
  new_is_correct        TINYINT(1) NULL,
  actor                VARCHAR(128) NULL,
  note                 TEXT NULL,
  created_at           TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_result_audit_session (session_id),
  CONSTRAINT fk_result_audit_session
    FOREIGN KEY (session_id) REFERENCES exam_sessions(id)
    ON DELETE CASCADE,
  CONSTRAINT fk_result_audit_question
    FOREIGN KEY (question_id) REFERENCES questions(id)
    ON DELETE SET NULL
) ENGINE=InnoDB;

-- Proctoring violations
CREATE TABLE IF NOT EXISTS violation_logs (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  company_id    INT NOT NULL DEFAULT 1,
  session_id    BIGINT UNSIGNED NOT NULL,
  occurred_at   DATETIME(3) NOT NULL,
  type          ENUM('TAB_SWITCH','NO_FACE','MULTIPLE_FACES','GAZE_AWAY','AUDIO_DETECTED','FULLSCREEN_EXIT','COPY_PASTE','PHONE_DETECTED','ANOMALY_OBJECT','LOCATION_CHANGE','IDENTITY_CHANGE','SUSPICIOUS_BEHAVIOR') NOT NULL,
  category      VARCHAR(32) NULL,
  confidence    DECIMAL(5,4) NULL,
  description   TEXT NOT NULL,
  snapshot_base64 LONGTEXT NULL,
  metadata_json JSON NULL,
  INDEX idx_violation_session (session_id),
  CONSTRAINT fk_violation_session
    FOREIGN KEY (session_id) REFERENCES exam_sessions(id)
    ON DELETE CASCADE
) ENGINE=InnoDB;

-- Evidence review decisions for violations
CREATE TABLE IF NOT EXISTS violation_reviews (
  violation_id  BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  decision      ENUM('CLEARED','CONFIRMED','ESCALATED') NOT NULL,
  reviewer      VARCHAR(128) NULL,
  note          TEXT NULL,
  reviewed_at   DATETIME(3) NOT NULL DEFAULT NOW(3),
  CONSTRAINT fk_violation_review
    FOREIGN KEY (violation_id) REFERENCES violation_logs(id)
    ON DELETE CASCADE
) ENGINE=InnoDB;

-- Ensure new violation types are allowed
SET @vlog_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = 'proctorguard' AND TABLE_NAME = 'violation_logs' AND COLUMN_NAME = 'type'
);
SET @vlog_sql = IF(@vlog_exists = 1,
  'ALTER TABLE violation_logs MODIFY type ENUM(''TAB_SWITCH'',''NO_FACE'',''MULTIPLE_FACES'',''GAZE_AWAY'',''AUDIO_DETECTED'',''FULLSCREEN_EXIT'',''COPY_PASTE'',''PHONE_DETECTED'',''ANOMALY_OBJECT'',''LOCATION_CHANGE'',''IDENTITY_CHANGE'',''SUSPICIOUS_BEHAVIOR'') NOT NULL',
  'SELECT 1'
);
PREPARE vlog_stmt FROM @vlog_sql;
EXECUTE vlog_stmt;
DEALLOCATE PREPARE vlog_stmt;

-- Exam access logs
CREATE TABLE IF NOT EXISTS exam_access_logs (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  company_id INT NOT NULL DEFAULT 1,
  exam_id    VARCHAR(64) NOT NULL,
  student_id VARCHAR(64) NOT NULL,
  action     VARCHAR(32) NOT NULL,
  status     VARCHAR(32) NOT NULL,
  message    TEXT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_exam_access (exam_id, student_id)
) ENGINE=InnoDB;

-- Access requests for re-attempt after policy blocks
CREATE TABLE IF NOT EXISTS exam_access_requests (
  id                     BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  company_id             INT NOT NULL DEFAULT 1,
  exam_id                VARCHAR(64) NOT NULL,
  student_id             VARCHAR(64) NOT NULL,
  session_id             BIGINT UNSIGNED NULL,
  request_type           VARCHAR(32) NOT NULL DEFAULT 'REATTEMPT',
  status                 ENUM('PENDING','GRANTED','REVOKED') NOT NULL DEFAULT 'PENDING',
  reason                 TEXT NULL,
  previous_device_fingerprint VARCHAR(128) NULL,
  new_device_fingerprint VARCHAR(128) NULL,
  previous_device_json   JSON NULL,
  new_device_json        JSON NULL,
  violation_summary_json JSON NULL,
  review_note            TEXT NULL,
  reviewed_by            VARCHAR(64) NULL,
  requested_at           TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  reviewed_at            TIMESTAMP NULL DEFAULT NULL,
  INDEX idx_access_request_lookup (company_id, exam_id, student_id, status),
  INDEX idx_access_request_created (requested_at)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS exam_location_logs (
  id                     BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  company_id             INT NOT NULL DEFAULT 1,
  session_id             BIGINT UNSIGNED NOT NULL,
  exam_id                VARCHAR(64) NOT NULL,
  student_id             VARCHAR(64) NOT NULL,
  latitude               DECIMAL(10,7) NULL,
  longitude              DECIMAL(10,7) NULL,
  accuracy_m             INT NULL,
  location_label         VARCHAR(255) NULL,
  distance_from_start_m  INT NULL,
  flagged                TINYINT(1) NOT NULL DEFAULT 0,
  created_at             TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_location_session (session_id, created_at),
  INDEX idx_location_flagged (company_id, flagged, created_at)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS session_feedback (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  company_id       INT NOT NULL DEFAULT 1,
  session_id       BIGINT UNSIGNED NULL,
  exam_id          VARCHAR(64) NOT NULL,
  student_id       VARCHAR(64) NOT NULL,
  batch_id         BIGINT UNSIGNED NULL,
  rating           TINYINT UNSIGNED NOT NULL,
  clarity_rating   TINYINT UNSIGNED NULL,
  platform_rating  TINYINT UNSIGNED NULL,
  comment          TEXT NULL,
  created_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_feedback_session (session_id),
  INDEX idx_feedback_exam (company_id, exam_id, created_at),
  INDEX idx_feedback_student (company_id, student_id, created_at),
  INDEX idx_feedback_batch (company_id, batch_id, created_at)
) ENGINE=InnoDB;

-- Recording sessions (organized by company, exam, student, session)
CREATE TABLE IF NOT EXISTS recording_sessions (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  company_id   INT NOT NULL DEFAULT 1,
  exam_id      VARCHAR(64) NOT NULL,
  student_id   VARCHAR(64) NOT NULL,
  session_id   BIGINT UNSIGNED NULL,
  status       ENUM('INIT','RECORDING','COMPLETED','FAILED') NOT NULL DEFAULT 'INIT',
  started_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ended_at     TIMESTAMP NULL DEFAULT NULL,
  duration_sec INT NULL,
  created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_recording_session_lookup (company_id, exam_id, student_id, started_at),
  INDEX idx_recording_session_status (status)
) ENGINE=InnoDB;

-- Per-session stream assets: camera, screen, combined
CREATE TABLE IF NOT EXISTS recording_streams (
  id                   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  recording_session_id BIGINT UNSIGNED NOT NULL,
  stream_type          ENUM('camera','screen','combined') NOT NULL,
  mime_type            VARCHAR(128) NULL,
  file_path            VARCHAR(1024) NOT NULL,
  size_bytes           BIGINT UNSIGNED NOT NULL DEFAULT 0,
  chunk_count          INT NOT NULL DEFAULT 0,
  created_at           TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at           TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_recording_stream_unique (recording_session_id, stream_type),
  INDEX idx_recording_stream_type (stream_type),
  CONSTRAINT fk_recording_stream_session
    FOREIGN KEY (recording_session_id) REFERENCES recording_sessions(id)
    ON DELETE CASCADE
) ENGINE=InnoDB;

-- Activity audit logs
CREATE TABLE IF NOT EXISTS audit_logs (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  company_id  INT NOT NULL DEFAULT 1,
  actor_role  ENUM('ADMIN','PROCTOR','STUDENT','SYSTEM') NOT NULL DEFAULT 'SYSTEM',
  actor_id    VARCHAR(64) NULL,
  action      VARCHAR(64) NOT NULL,
  target_type VARCHAR(64) NULL,
  target_id   VARCHAR(64) NULL,
  message     TEXT NULL,
  metadata    JSON NULL,
  ip_address  VARCHAR(64) NULL,
  user_agent  VARCHAR(512) NULL,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_audit_actor (actor_role, actor_id),
  INDEX idx_audit_action (action),
  INDEX idx_audit_target (target_type, target_id),
  INDEX idx_audit_created (created_at)
) ENGINE=InnoDB;

-- Notification templates
CREATE TABLE IF NOT EXISTS notification_templates (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  company_id  INT NOT NULL DEFAULT 1,
  name        VARCHAR(255) NOT NULL,
  channel     ENUM('EMAIL','SMS') NOT NULL DEFAULT 'EMAIL',
  subject     VARCHAR(255) NULL,
  body        TEXT NOT NULL,
  is_default  TINYINT(1) NOT NULL DEFAULT 0,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_template_channel (channel)
) ENGINE=InnoDB;

-- Delivery logs
CREATE TABLE IF NOT EXISTS delivery_logs (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  company_id  INT NOT NULL DEFAULT 1,
  channel     ENUM('EMAIL','SMS') NOT NULL,
  recipient   VARCHAR(255) NOT NULL,
  subject     VARCHAR(255) NULL,
  body        TEXT NULL,
  status      ENUM('SENT','FAILED','SKIPPED') NOT NULL DEFAULT 'SENT',
  error       TEXT NULL,
  template_id BIGINT UNSIGNED NULL,
  metadata    JSON NULL,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_delivery_channel (channel),
  INDEX idx_delivery_status (status),
  INDEX idx_delivery_created (created_at),
  CONSTRAINT fk_delivery_template
    FOREIGN KEY (template_id) REFERENCES notification_templates(id)
    ON DELETE SET NULL
) ENGINE=InnoDB;

-- Stored Procedures (for controlled access)
DROP PROCEDURE IF EXISTS sp_list_students;
DROP PROCEDURE IF EXISTS sp_create_student;
DROP PROCEDURE IF EXISTS sp_list_exams;
DROP PROCEDURE IF EXISTS sp_save_exam;
DROP PROCEDURE IF EXISTS sp_list_exam_questions;
DROP PROCEDURE IF EXISTS sp_save_question;
DROP PROCEDURE IF EXISTS sp_clear_exam_questions;
DROP PROCEDURE IF EXISTS sp_link_exam_question;
DROP PROCEDURE IF EXISTS sp_list_exam_sections;
DROP PROCEDURE IF EXISTS sp_save_exam_section;
DROP PROCEDURE IF EXISTS sp_clear_exam_sections;
DROP PROCEDURE IF EXISTS sp_list_exam_section_questions;
DROP PROCEDURE IF EXISTS sp_link_exam_section_question;
DROP PROCEDURE IF EXISTS sp_list_exam_assignments;
DROP PROCEDURE IF EXISTS sp_clear_exam_assignments;
DROP PROCEDURE IF EXISTS sp_assign_exam_student;
DROP PROCEDURE IF EXISTS sp_log_access;
DROP PROCEDURE IF EXISTS sp_get_exam_session;
DROP PROCEDURE IF EXISTS sp_start_exam_session;
DROP PROCEDURE IF EXISTS sp_complete_exam_session;
DROP PROCEDURE IF EXISTS sp_reset_exam_session;
DROP PROCEDURE IF EXISTS sp_list_sessions;
DROP PROCEDURE IF EXISTS sp_add_violation;
DROP PROCEDURE IF EXISTS sp_list_violations;
DROP PROCEDURE IF EXISTS sp_add_audit;
DROP PROCEDURE IF EXISTS sp_list_audits;
DROP PROCEDURE IF EXISTS sp_list_templates;
DROP PROCEDURE IF EXISTS sp_save_template;
DROP PROCEDURE IF EXISTS sp_delete_template;
DROP PROCEDURE IF EXISTS sp_add_delivery_log;
DROP PROCEDURE IF EXISTS sp_list_delivery_logs;

DELIMITER $$

CREATE PROCEDURE sp_list_students(IN p_company_id INT)
BEGIN
  SELECT
    s.id,
    s.full_name AS fullName,
    s.email,
    s.registration_id AS registrationId,
    s.company_id AS companyId,
    CONCAT('Company ', s.company_id) AS company,
    s.batch_id AS batchId,
    b.name AS batch
  FROM students s
  LEFT JOIN batches b
    ON b.id = s.batch_id
   AND b.company_id = s.company_id
  WHERE s.company_id = p_company_id
  ORDER BY s.created_at DESC;
END $$

CREATE PROCEDURE sp_create_student(
  IN p_id VARCHAR(64),
  IN p_company_id INT,
  IN p_full_name VARCHAR(255),
  IN p_email VARCHAR(255),
  IN p_registration_id VARCHAR(128)
)
BEGIN
  IF p_full_name IS NULL OR p_full_name = '' OR
     p_email IS NULL OR p_email = '' OR
     p_registration_id IS NULL OR p_registration_id = '' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Missing required fields.';
  END IF;

  IF LOCATE('@', p_email) = 0 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Invalid email format.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM students WHERE email = p_email OR registration_id = p_registration_id
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Duplicate student.';
  END IF;

  INSERT INTO students (id, company_id, full_name, email, registration_id)
  VALUES (p_id, p_company_id, p_full_name, p_email, p_registration_id);

  SELECT id, full_name AS fullName, email, registration_id AS registrationId
  FROM students
  WHERE id = p_id AND company_id = p_company_id
  LIMIT 1;
END $$

CREATE PROCEDURE sp_list_exams(IN p_company_id INT)
BEGIN
  SELECT
    id,
    company_id,
    title,
    duration_minutes,
    start_time,
    end_time,
    question_count,
    shuffle_questions,
    show_results,
    pass_percent,
    attempt_policy,
    reconnect_limit,
    total_marks,
    status,
    camera_required,
    microphone_required,
    fullscreen_enforced,
    tab_switch_limit,
    violation_limits_json,
    notification_enabled,
    reminder_hours24,
    reminder_hours1,
    notification_subject,
    notification_message
  FROM exams
  WHERE company_id = p_company_id
  ORDER BY updated_at DESC;
END $$

CREATE PROCEDURE sp_save_exam(
  IN p_id VARCHAR(64),
  IN p_company_id INT,
  IN p_title VARCHAR(255),
  IN p_duration_minutes INT,
  IN p_start_time DATETIME(3),
  IN p_end_time DATETIME(3),
  IN p_question_count INT,
  IN p_shuffle_questions TINYINT(1),
  IN p_show_results TINYINT(1),
  IN p_pass_percent INT,
  IN p_attempt_policy ENUM('BEST','LAST','AVERAGE'),
  IN p_reconnect_limit INT,
  IN p_total_marks INT,
  IN p_status ENUM('DRAFT','PUBLISHED','ARCHIVED'),
  IN p_camera_required TINYINT(1),
  IN p_microphone_required TINYINT(1),
  IN p_fullscreen_enforced TINYINT(1),
  IN p_tab_switch_limit INT,
  IN p_violation_limits_json JSON,
  IN p_notification_enabled TINYINT(1),
  IN p_reminder_hours24 TINYINT(1),
  IN p_reminder_hours1 TINYINT(1),
  IN p_notification_subject VARCHAR(255),
  IN p_notification_message TEXT
)
BEGIN
  IF p_title IS NULL OR p_title = '' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Exam title is required.';
  END IF;

  INSERT INTO exams (
    id, company_id, title, duration_minutes, start_time, end_time, question_count, shuffle_questions, show_results,
    pass_percent, attempt_policy, reconnect_limit, total_marks, status, camera_required, microphone_required, fullscreen_enforced, tab_switch_limit, violation_limits_json,
    notification_enabled, reminder_hours24, reminder_hours1, notification_subject, notification_message
  ) VALUES (
    p_id, p_company_id, p_title, p_duration_minutes, p_start_time, p_end_time, p_question_count, p_shuffle_questions, p_show_results,
    p_pass_percent, p_attempt_policy, p_reconnect_limit, p_total_marks, p_status, p_camera_required, p_microphone_required, p_fullscreen_enforced, p_tab_switch_limit, p_violation_limits_json,
    p_notification_enabled, p_reminder_hours24, p_reminder_hours1, p_notification_subject, p_notification_message
  )
  ON DUPLICATE KEY UPDATE
    title = VALUES(title),
    company_id = VALUES(company_id),
    duration_minutes = VALUES(duration_minutes),
    start_time = VALUES(start_time),
    end_time = VALUES(end_time),
    question_count = VALUES(question_count),
    shuffle_questions = VALUES(shuffle_questions),
    show_results = VALUES(show_results),
    pass_percent = VALUES(pass_percent),
    attempt_policy = VALUES(attempt_policy),
    reconnect_limit = VALUES(reconnect_limit),
    total_marks = VALUES(total_marks),
    status = VALUES(status),
    camera_required = VALUES(camera_required),
    microphone_required = VALUES(microphone_required),
    fullscreen_enforced = VALUES(fullscreen_enforced),
    tab_switch_limit = VALUES(tab_switch_limit),
    violation_limits_json = VALUES(violation_limits_json),
    notification_enabled = VALUES(notification_enabled),
    reminder_hours24 = VALUES(reminder_hours24),
    reminder_hours1 = VALUES(reminder_hours1),
    notification_subject = VALUES(notification_subject),
    notification_message = VALUES(notification_message);
END $$

CREATE PROCEDURE sp_list_exam_questions(IN p_exam_id VARCHAR(64))
BEGIN
  SELECT
    q.id,
    q.type,
    q.text,
    q.options_json,
    q.correct_option_index,
    q.marks,
    eq.display_order
  FROM exam_questions eq
  JOIN questions q ON q.id = eq.question_id
  WHERE eq.exam_id = p_exam_id
  ORDER BY eq.display_order ASC;
END $$

CREATE PROCEDURE sp_save_question(
  IN p_id VARCHAR(64),
  IN p_type ENUM('MCQ','TEXT'),
  IN p_text TEXT,
  IN p_options_json JSON,
  IN p_correct_option_index INT,
  IN p_marks INT
)
BEGIN
  INSERT INTO questions (id, type, text, options_json, correct_option_index, marks)
  VALUES (p_id, p_type, p_text, p_options_json, p_correct_option_index, p_marks)
  ON DUPLICATE KEY UPDATE
    type = VALUES(type),
    text = VALUES(text),
    options_json = VALUES(options_json),
    correct_option_index = VALUES(correct_option_index),
    marks = VALUES(marks);
END $$

CREATE PROCEDURE sp_clear_exam_questions(IN p_exam_id VARCHAR(64))
BEGIN
  DELETE FROM exam_questions WHERE exam_id = p_exam_id;
END $$

CREATE PROCEDURE sp_link_exam_question(
  IN p_exam_id VARCHAR(64),
  IN p_question_id VARCHAR(64),
  IN p_display_order INT
)
BEGIN
  INSERT INTO exam_questions (exam_id, question_id, display_order)
  VALUES (p_exam_id, p_question_id, p_display_order);
END $$

CREATE PROCEDURE sp_list_exam_sections(IN p_exam_id VARCHAR(64))
BEGIN
  SELECT id, title, display_order, question_limit, shuffle_questions, time_limit_minutes, lock_on_complete
  FROM exam_sections
  WHERE exam_id = p_exam_id
  ORDER BY display_order ASC;
END $$

CREATE PROCEDURE sp_save_exam_section(
  IN p_id VARCHAR(64),
  IN p_exam_id VARCHAR(64),
  IN p_title VARCHAR(255),
  IN p_display_order INT,
  IN p_question_limit INT,
  IN p_shuffle_questions TINYINT(1),
  IN p_time_limit_minutes INT,
  IN p_lock_on_complete TINYINT(1)
)
BEGIN
  INSERT INTO exam_sections (id, exam_id, title, display_order, question_limit, shuffle_questions, time_limit_minutes, lock_on_complete)
  VALUES (p_id, p_exam_id, p_title, p_display_order, p_question_limit, p_shuffle_questions, p_time_limit_minutes, p_lock_on_complete)
  ON DUPLICATE KEY UPDATE
    title = VALUES(title),
    display_order = VALUES(display_order),
    question_limit = VALUES(question_limit),
    shuffle_questions = VALUES(shuffle_questions),
    time_limit_minutes = VALUES(time_limit_minutes),
    lock_on_complete = VALUES(lock_on_complete);
END $$

CREATE PROCEDURE sp_clear_exam_sections(IN p_exam_id VARCHAR(64))
BEGIN
  DELETE FROM exam_sections WHERE exam_id = p_exam_id;
END $$

CREATE PROCEDURE sp_list_exam_section_questions(IN p_section_id VARCHAR(64))
BEGIN
  SELECT
    q.id,
    q.type,
    q.text,
    q.options_json,
    q.correct_option_index,
    q.marks,
    esq.display_order
  FROM exam_section_questions esq
  JOIN questions q ON q.id = esq.question_id
  WHERE esq.section_id = p_section_id
  ORDER BY esq.display_order ASC;
END $$

CREATE PROCEDURE sp_link_exam_section_question(
  IN p_section_id VARCHAR(64),
  IN p_question_id VARCHAR(64),
  IN p_display_order INT
)
BEGIN
  INSERT INTO exam_section_questions (section_id, question_id, display_order)
  VALUES (p_section_id, p_question_id, p_display_order);
END $$

CREATE PROCEDURE sp_list_exam_assignments(IN p_exam_id VARCHAR(64))
BEGIN
  SELECT student_id FROM exam_assignments WHERE exam_id = p_exam_id;
END $$

CREATE PROCEDURE sp_clear_exam_assignments(IN p_exam_id VARCHAR(64))
BEGIN
  DELETE FROM exam_assignments WHERE exam_id = p_exam_id;
END $$

CREATE PROCEDURE sp_assign_exam_student(
  IN p_exam_id VARCHAR(64),
  IN p_student_id VARCHAR(64)
)
BEGIN
  INSERT IGNORE INTO exam_assignments (exam_id, student_id)
  VALUES (p_exam_id, p_student_id);
END $$

CREATE PROCEDURE sp_log_access(
  IN p_company_id INT,
  IN p_exam_id VARCHAR(64),
  IN p_student_id VARCHAR(64),
  IN p_action VARCHAR(32),
  IN p_status VARCHAR(32),
  IN p_message TEXT
)
BEGIN
  INSERT INTO exam_access_logs (company_id, exam_id, student_id, action, status, message)
  VALUES (p_company_id, p_exam_id, p_student_id, p_action, p_status, p_message);
END $$

CREATE PROCEDURE sp_get_exam_session(
  IN p_exam_id VARCHAR(64),
  IN p_student_id VARCHAR(64)
)
BEGIN
  SELECT id, status, ip_address, device_fingerprint, start_time
  FROM exam_sessions
  WHERE exam_id = p_exam_id AND student_id = p_student_id
  ORDER BY start_time DESC
  LIMIT 1;
END $$

CREATE PROCEDURE sp_start_exam_session(
  IN p_company_id INT,
  IN p_exam_id VARCHAR(64),
  IN p_student_id VARCHAR(64),
  IN p_user_agent VARCHAR(512),
  IN p_ip_address VARCHAR(64),
  IN p_location VARCHAR(255),
  IN p_device_fingerprint VARCHAR(128)
)
BEGIN
  INSERT INTO exam_sessions (company_id, exam_id, student_id, start_time, status, ip_address, user_agent, location, device_fingerprint)
  VALUES (p_company_id, p_exam_id, p_student_id, NOW(3), 'IN_PROGRESS', p_ip_address, p_user_agent, p_location, p_device_fingerprint);
END $$

CREATE PROCEDURE sp_complete_exam_session(
  IN p_company_id INT,
  IN p_exam_id VARCHAR(64),
  IN p_student_id VARCHAR(64)
)
BEGIN
  UPDATE exam_sessions
  SET status = 'COMPLETED', end_time = NOW(3)
  WHERE company_id = p_company_id AND exam_id = p_exam_id AND student_id = p_student_id AND status = 'IN_PROGRESS';
END $$

CREATE PROCEDURE sp_reset_exam_session(
  IN p_company_id INT,
  IN p_exam_id VARCHAR(64),
  IN p_student_id VARCHAR(64)
)
BEGIN
  DELETE FROM exam_sessions
  WHERE company_id = p_company_id AND exam_id = p_exam_id AND student_id = p_student_id AND status <> 'COMPLETED';
END $$

CREATE PROCEDURE sp_list_sessions(IN p_company_id INT)
BEGIN
  SELECT
    es.exam_id,
    es.student_id,
    es.start_time,
    es.end_time,
    es.status,
    es.ip_address,
    es.user_agent,
    es.device_fingerprint,
    es.location,
      EXISTS(
        SELECT 1 FROM exam_access_logs l
        WHERE l.company_id = p_company_id
          AND l.exam_id = es.exam_id
          AND l.student_id = es.student_id
          AND l.action = 'RECONNECT'
          AND l.status = 'WARN_IP'
          AND l.created_at >= es.start_time
      ) AS ip_change_detected,
      EXISTS(
        SELECT 1 FROM exam_access_logs l
        WHERE l.company_id = p_company_id
          AND l.exam_id = es.exam_id
          AND l.student_id = es.student_id
          AND l.action = 'RECONNECT'
          AND l.status = 'WARN_DEVICE'
        AND l.created_at >= es.start_time
    ) AS device_change_detected
  FROM exam_sessions es
  WHERE es.company_id = p_company_id
  ORDER BY start_time DESC;
END $$

CREATE PROCEDURE sp_add_violation(
  IN p_company_id INT,
  IN p_exam_id VARCHAR(64),
  IN p_student_id VARCHAR(64),
  IN p_type ENUM('TAB_SWITCH','NO_FACE','MULTIPLE_FACES','GAZE_AWAY','AUDIO_DETECTED','FULLSCREEN_EXIT','COPY_PASTE','PHONE_DETECTED','ANOMALY_OBJECT','LOCATION_CHANGE','IDENTITY_CHANGE','SUSPICIOUS_BEHAVIOR'),
  IN p_description TEXT,
  IN p_snapshot LONGTEXT
)
BEGIN
  DECLARE v_session_id BIGINT;
  SELECT id INTO v_session_id
  FROM exam_sessions
  WHERE company_id = p_company_id AND exam_id = p_exam_id AND student_id = p_student_id
  ORDER BY start_time DESC
  LIMIT 1;

  IF v_session_id IS NULL THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Session not found.';
  END IF;

  INSERT INTO violation_logs (company_id, session_id, occurred_at, type, description, snapshot_base64)
  VALUES (p_company_id, v_session_id, NOW(3), p_type, p_description, p_snapshot);
END $$

CREATE PROCEDURE sp_list_violations(IN p_company_id INT, IN p_limit INT)
BEGIN
  SELECT
    vl.id,
    vl.session_id,
    es.exam_id,
    es.student_id,
    vl.occurred_at,
    vl.type,
    vl.description,
    vl.snapshot_base64,
    vr.decision AS review_decision,
    vr.note AS review_note,
    vr.reviewer AS review_reviewer,
    vr.reviewed_at AS review_time
  FROM violation_logs vl
  JOIN exam_sessions es ON es.id = vl.session_id
  LEFT JOIN violation_reviews vr ON vr.violation_id = vl.id
  WHERE es.company_id = p_company_id
  ORDER BY vl.occurred_at DESC
  LIMIT p_limit;
END $$

CREATE PROCEDURE sp_add_audit(
  IN p_company_id INT,
  IN p_actor_role ENUM('ADMIN','PROCTOR','STUDENT','SYSTEM'),
  IN p_actor_id VARCHAR(64),
  IN p_action VARCHAR(64),
  IN p_target_type VARCHAR(64),
  IN p_target_id VARCHAR(64),
  IN p_message TEXT,
  IN p_metadata JSON,
  IN p_ip_address VARCHAR(64),
  IN p_user_agent VARCHAR(512)
)
BEGIN
  INSERT INTO audit_logs (company_id, actor_role, actor_id, action, target_type, target_id, message, metadata, ip_address, user_agent)
  VALUES (p_company_id, p_actor_role, p_actor_id, p_action, p_target_type, p_target_id, p_message, p_metadata, p_ip_address, p_user_agent);
END $$

CREATE PROCEDURE sp_list_audits(
  IN p_company_id INT,
  IN p_actor_role VARCHAR(16),
  IN p_actor_id VARCHAR(64),
  IN p_action VARCHAR(64),
  IN p_target_type VARCHAR(64),
  IN p_target_id VARCHAR(64),
  IN p_limit INT,
  IN p_offset INT
)
BEGIN
  SELECT
    id,
    actor_role,
    actor_id,
    action,
    target_type,
    target_id,
    message,
    metadata,
    ip_address,
    user_agent,
    created_at
  FROM audit_logs
  WHERE company_id = p_company_id
    AND (p_actor_role IS NULL OR actor_role = p_actor_role)
    AND (p_actor_id IS NULL OR actor_id = p_actor_id)
    AND (p_action IS NULL OR action = p_action)
    AND (p_target_type IS NULL OR target_type = p_target_type)
    AND (p_target_id IS NULL OR target_id = p_target_id)
  ORDER BY created_at DESC, id DESC
  LIMIT p_limit OFFSET p_offset;
END $$

CREATE PROCEDURE sp_list_templates(IN p_company_id INT, IN p_channel VARCHAR(16))
BEGIN
  SELECT id, name, channel, subject, body, is_default, created_at, updated_at
  FROM notification_templates
  WHERE company_id = p_company_id
    AND (p_channel IS NULL OR channel = p_channel)
  ORDER BY updated_at DESC, id DESC;
END $$

CREATE PROCEDURE sp_save_template(
  IN p_company_id INT,
  IN p_id BIGINT,
  IN p_name VARCHAR(255),
  IN p_channel ENUM('EMAIL','SMS'),
  IN p_subject VARCHAR(255),
  IN p_body TEXT,
  IN p_is_default TINYINT(1)
)
BEGIN
  IF p_is_default = 1 THEN
    UPDATE notification_templates SET is_default = 0 WHERE company_id = p_company_id AND channel = p_channel;
  END IF;

  INSERT INTO notification_templates (company_id, id, name, channel, subject, body, is_default)
  VALUES (p_company_id, p_id, p_name, p_channel, p_subject, p_body, p_is_default)
  ON DUPLICATE KEY UPDATE
    company_id = VALUES(company_id),
    name = VALUES(name),
    channel = VALUES(channel),
    subject = VALUES(subject),
    body = VALUES(body),
    is_default = VALUES(is_default);
END $$

CREATE PROCEDURE sp_delete_template(IN p_company_id INT, IN p_id BIGINT)
BEGIN
  DELETE FROM notification_templates WHERE company_id = p_company_id AND id = p_id;
END $$

CREATE PROCEDURE sp_add_delivery_log(
  IN p_company_id INT,
  IN p_channel ENUM('EMAIL','SMS'),
  IN p_recipient VARCHAR(255),
  IN p_subject VARCHAR(255),
  IN p_body TEXT,
  IN p_status ENUM('SENT','FAILED','SKIPPED'),
  IN p_error TEXT,
  IN p_template_id BIGINT,
  IN p_metadata JSON
)
BEGIN
  INSERT INTO delivery_logs (company_id, channel, recipient, subject, body, status, error, template_id, metadata)
  VALUES (p_company_id, p_channel, p_recipient, p_subject, p_body, p_status, p_error, p_template_id, p_metadata);
END $$

CREATE PROCEDURE sp_list_delivery_logs(
  IN p_company_id INT,
  IN p_channel VARCHAR(16),
  IN p_status VARCHAR(16),
  IN p_limit INT,
  IN p_offset INT
)
BEGIN
  SELECT
    dl.id,
    dl.channel,
    dl.recipient,
    dl.subject,
    dl.body,
    dl.status,
    dl.error,
    dl.template_id,
    dl.metadata,
    dl.created_at
  FROM delivery_logs dl
  WHERE dl.company_id = p_company_id
    AND (p_channel IS NULL OR dl.channel = p_channel)
    AND (p_status IS NULL OR dl.status = p_status)
  ORDER BY dl.created_at DESC, dl.id DESC
  LIMIT p_limit OFFSET p_offset;
END $$

DELIMITER ;






