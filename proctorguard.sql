-- phpMyAdmin SQL Dump
-- version 5.2.1
-- https://www.phpmyadmin.net/
--
-- Host: 127.0.0.1
-- Generation Time: Feb 12, 2026 at 09:10 AM
-- Server version: 10.4.32-MariaDB
-- PHP Version: 8.2.12

SET SQL_MODE = "NO_AUTO_VALUE_ON_ZERO";
START TRANSACTION;
SET time_zone = "+00:00";


/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
/*!40101 SET @OLD_CHARACTER_SET_RESULTS=@@CHARACTER_SET_RESULTS */;
/*!40101 SET @OLD_COLLATION_CONNECTION=@@COLLATION_CONNECTION */;
/*!40101 SET NAMES utf8mb4 */;

--
-- Database: `proctorguard`
--

DELIMITER $$
--
-- Procedures
--

-- Batch Management Procedures
CREATE DEFINER=`root`@`localhost` PROCEDURE `sp_create_batch` (IN `p_company_id` INT, IN `p_name` VARCHAR(255), IN `p_description` TEXT)   BEGIN
  INSERT INTO batches (company_id, name, description)
  VALUES (p_company_id, p_name, p_description);
  
  SELECT id, company_id, name, description, created_at
  FROM batches
  WHERE id = LAST_INSERT_ID() AND company_id = p_company_id
  LIMIT 1;
END$$

CREATE DEFINER=`root`@`localhost` PROCEDURE `sp_list_batches` (IN `p_company_id` INT)   BEGIN
  SELECT 
    b.id,
    b.company_id,
    b.name,
    b.description,
    b.created_at,
    (SELECT COUNT(*) FROM students s WHERE s.batch_id = b.id AND s.company_id = p_company_id) AS student_count
  FROM batches b
  WHERE b.company_id = p_company_id
  ORDER BY b.created_at DESC;
END$$

CREATE DEFINER=`root`@`localhost` PROCEDURE `sp_update_batch` (IN `p_company_id` INT, IN `p_id` BIGINT, IN `p_name` VARCHAR(255), IN `p_description` TEXT)   BEGIN
  UPDATE batches
  SET name = p_name, description = p_description
  WHERE id = p_id AND company_id = p_company_id;
  
  SELECT id, company_id, name, description, created_at
  FROM batches
  WHERE id = p_id AND company_id = p_company_id
  LIMIT 1;
END$$

CREATE DEFINER=`root`@`localhost` PROCEDURE `sp_delete_batch` (IN `p_company_id` INT, IN `p_id` BIGINT)   BEGIN
  -- First, unassign all students from this batch
  UPDATE students SET batch_id = NULL WHERE batch_id = p_id AND company_id = p_company_id;
  
  -- Then delete the batch
  DELETE FROM batches WHERE id = p_id AND company_id = p_company_id;
END$$

CREATE DEFINER=`root`@`localhost` PROCEDURE `sp_bulk_import_students` (IN `p_company_id` INT, IN `p_batch_id` BIGINT, IN `p_students_json` JSON)   BEGIN
  DECLARE v_student_data JSON DEFAULT p_students_json;
  DECLARE v_count INT DEFAULT 0;
  DECLARE v_i INT DEFAULT 0;
  DECLARE v_student_count INT;
  DECLARE v_full_name VARCHAR(255);
  DECLARE v_email VARCHAR(255);
  DECLARE v_registration_id VARCHAR(128);
  DECLARE v_student_id VARCHAR(64);
  
  SET v_student_count = JSON_LENGTH(v_student_data);
  
  WHILE v_i < v_student_count DO
    SET v_full_name = JSON_UNQUOTE(JSON_EXTRACT(v_student_data, CONCAT('$[', v_i, '].full_name')));
    SET v_email = JSON_UNQUOTE(JSON_EXTRACT(v_student_data, CONCAT('$[', v_i, '].email')));
    SET v_registration_id = JSON_UNQUOTE(JSON_EXTRACT(v_student_data, CONCAT('$[', v_i, '].registration_id')));
    
    -- Generate student ID if not provided
    SET v_student_id = JSON_UNQUOTE(JSON_EXTRACT(v_student_data, CONCAT('$[', v_i, '].id')));
    IF v_student_id IS NULL OR v_student_id = '' THEN
      SET v_student_id = MD5(CONCAT(p_company_id, v_email, NOW(3)));
    END IF;
    
    -- Insert or update student with batch_id
    INSERT INTO students (id, company_id, full_name, email, registration_id, batch_id)
    VALUES (v_student_id, p_company_id, v_full_name, v_email, v_registration_id, p_batch_id)
    ON DUPLICATE KEY UPDATE 
      full_name = VALUES(full_name),
      email = VALUES(email),
      registration_id = VALUES(registration_id),
      batch_id = p_batch_id;
    
    SET v_count = v_count + 1;
    SET v_i = v_i + 1;
  END WHILE;
  
  SELECT v_count AS imported_count;
END$$

CREATE DEFINER=`root`@`localhost` PROCEDURE `sp_add_audit` (IN `p_company_id` INT, IN `p_actor_role` ENUM('ADMIN','PROCTOR','STUDENT','SYSTEM'), IN `p_actor_id` VARCHAR(64), IN `p_action` VARCHAR(64), IN `p_target_type` VARCHAR(64), IN `p_target_id` VARCHAR(64), IN `p_message` TEXT, IN `p_metadata` JSON, IN `p_ip_address` VARCHAR(64), IN `p_user_agent` VARCHAR(512))   BEGIN
  INSERT INTO audit_logs (company_id, actor_role, actor_id, action, target_type, target_id, message, metadata, ip_address, user_agent)
  VALUES (p_company_id, p_actor_role, p_actor_id, p_action, p_target_type, p_target_id, p_message, p_metadata, p_ip_address, p_user_agent);
END$$

CREATE DEFINER=`root`@`localhost` PROCEDURE `sp_add_delivery_log` (IN `p_company_id` INT, IN `p_channel` ENUM('EMAIL','SMS'), IN `p_recipient` VARCHAR(255), IN `p_subject` VARCHAR(255), IN `p_body` TEXT, IN `p_status` ENUM('SENT','FAILED','SKIPPED'), IN `p_error` TEXT, IN `p_template_id` BIGINT, IN `p_metadata` JSON)   BEGIN
  INSERT INTO delivery_logs (company_id, channel, recipient, subject, body, status, error, template_id, metadata)
  VALUES (p_company_id, p_channel, p_recipient, p_subject, p_body, p_status, p_error, p_template_id, p_metadata);
END$$

CREATE DEFINER=`root`@`localhost` PROCEDURE `sp_add_violation` (IN `p_company_id` INT, IN `p_exam_id` VARCHAR(64), IN `p_student_id` VARCHAR(64), IN `p_type` ENUM('TAB_SWITCH','NO_FACE','MULTIPLE_FACES','GAZE_AWAY','AUDIO_DETECTED','FULLSCREEN_EXIT','COPY_PASTE','PHONE_DETECTED','ANOMALY_OBJECT','LOCATION_CHANGE'), IN `p_description` TEXT, IN `p_snapshot` LONGTEXT)   BEGIN
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
END$$

CREATE DEFINER=`root`@`localhost` PROCEDURE `sp_assign_exam_student` (IN `p_exam_id` VARCHAR(64), IN `p_student_id` VARCHAR(64))   BEGIN
  INSERT IGNORE INTO exam_assignments (exam_id, student_id)
  VALUES (p_exam_id, p_student_id);
END$$

CREATE DEFINER=`root`@`localhost` PROCEDURE `sp_clear_exam_assignments` (IN `p_exam_id` VARCHAR(64))   BEGIN
  DELETE FROM exam_assignments WHERE exam_id = p_exam_id;
END$$

CREATE DEFINER=`root`@`localhost` PROCEDURE `sp_clear_exam_questions` (IN `p_exam_id` VARCHAR(64))   BEGIN
  DELETE FROM exam_questions WHERE exam_id = p_exam_id;
END$$

CREATE DEFINER=`root`@`localhost` PROCEDURE `sp_clear_exam_sections` (IN `p_exam_id` VARCHAR(64))   BEGIN
  DELETE FROM exam_sections WHERE exam_id = p_exam_id;
END$$

CREATE DEFINER=`root`@`localhost` PROCEDURE `sp_complete_exam_session` (IN `p_company_id` INT, IN `p_exam_id` VARCHAR(64), IN `p_student_id` VARCHAR(64))   BEGIN
  UPDATE exam_sessions
  SET status = 'COMPLETED', end_time = NOW(3)
  WHERE company_id = p_company_id AND exam_id = p_exam_id AND student_id = p_student_id AND status = 'IN_PROGRESS';
END$$

CREATE DEFINER=`root`@`localhost` PROCEDURE `sp_create_student` (IN `p_id` VARCHAR(64), IN `p_company_id` INT, IN `p_full_name` VARCHAR(255), IN `p_email` VARCHAR(255), IN `p_registration_id` VARCHAR(128))   BEGIN
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
END$$

CREATE DEFINER=`root`@`localhost` PROCEDURE `sp_delete_template` (IN `p_company_id` INT, IN `p_id` BIGINT)   BEGIN
  DELETE FROM notification_templates WHERE company_id = p_company_id AND id = p_id;
END$$

CREATE DEFINER=`root`@`localhost` PROCEDURE `sp_get_exam_session` (IN `p_company_id` INT, IN `p_exam_id` VARCHAR(64), IN `p_student_id` VARCHAR(64))   BEGIN
  SELECT id, status, ip_address, device_fingerprint, start_time
  FROM exam_sessions
  WHERE company_id = p_company_id AND exam_id = p_exam_id AND student_id = p_student_id
  ORDER BY start_time DESC
  LIMIT 1;
END$$

CREATE DEFINER=`root`@`localhost` PROCEDURE `sp_link_exam_question` (IN `p_exam_id` VARCHAR(64), IN `p_question_id` VARCHAR(64), IN `p_display_order` INT)   BEGIN
  INSERT INTO exam_questions (exam_id, question_id, display_order)
  VALUES (p_exam_id, p_question_id, p_display_order);
END$$

CREATE DEFINER=`root`@`localhost` PROCEDURE `sp_link_exam_section_question` (IN `p_section_id` VARCHAR(64), IN `p_question_id` VARCHAR(64), IN `p_display_order` INT)   BEGIN
  INSERT INTO exam_section_questions (section_id, question_id, display_order)
  VALUES (p_section_id, p_question_id, p_display_order);
END$$

CREATE DEFINER=`root`@`localhost` PROCEDURE `sp_list_audits` (IN `p_company_id` INT, IN `p_actor_role` VARCHAR(16), IN `p_actor_id` VARCHAR(64), IN `p_action` VARCHAR(64), IN `p_target_type` VARCHAR(64), IN `p_target_id` VARCHAR(64), IN `p_limit` INT, IN `p_offset` INT)   BEGIN
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
END$$

CREATE DEFINER=`root`@`localhost` PROCEDURE `sp_list_delivery_logs` (IN `p_company_id` INT, IN `p_channel` VARCHAR(16), IN `p_status` VARCHAR(16), IN `p_limit` INT, IN `p_offset` INT)   BEGIN
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
END$$

CREATE DEFINER=`root`@`localhost` PROCEDURE `sp_list_exams` (IN `p_company_id` INT)   BEGIN
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
    notification_enabled,
    reminder_hours24,
    reminder_hours1,
    notification_subject,
    notification_message
  FROM exams
  WHERE company_id = p_company_id
  ORDER BY updated_at DESC;
END$$

CREATE DEFINER=`root`@`localhost` PROCEDURE `sp_list_exam_assignments` (IN `p_exam_id` VARCHAR(64))   BEGIN
  SELECT student_id FROM exam_assignments WHERE exam_id = p_exam_id;
END$$

CREATE DEFINER=`root`@`localhost` PROCEDURE `sp_list_exam_questions` (IN `p_exam_id` VARCHAR(64))   BEGIN
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
END$$

CREATE DEFINER=`root`@`localhost` PROCEDURE `sp_list_exam_sections` (IN `p_exam_id` VARCHAR(64))   BEGIN
  SELECT id, title, display_order, question_limit, shuffle_questions, time_limit_minutes, lock_on_complete
  FROM exam_sections
  WHERE exam_id = p_exam_id
  ORDER BY display_order ASC;
END$$

CREATE DEFINER=`root`@`localhost` PROCEDURE `sp_list_exam_section_questions` (IN `p_section_id` VARCHAR(64))   BEGIN
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
END$$

CREATE DEFINER=`root`@`localhost` PROCEDURE `sp_list_sessions` (IN `p_company_id` INT)   BEGIN
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
END$$

CREATE DEFINER=`root`@`localhost` PROCEDURE `sp_list_students` (IN `p_company_id` INT)   BEGIN
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
END$$

CREATE DEFINER=`root`@`localhost` PROCEDURE `sp_list_templates` (IN `p_company_id` INT, IN `p_channel` VARCHAR(16))   BEGIN
  SELECT id, name, channel, subject, body, is_default, created_at, updated_at
  FROM notification_templates
  WHERE company_id = p_company_id
    AND (p_channel IS NULL OR channel = p_channel)
  ORDER BY updated_at DESC, id DESC;
END$$

CREATE DEFINER=`root`@`localhost` PROCEDURE `sp_list_violations` (IN `p_company_id` INT, IN `p_limit` INT)   BEGIN
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
END$$

CREATE DEFINER=`root`@`localhost` PROCEDURE `sp_log_access` (IN `p_company_id` INT, IN `p_exam_id` VARCHAR(64), IN `p_student_id` VARCHAR(64), IN `p_action` VARCHAR(32), IN `p_status` VARCHAR(32), IN `p_message` TEXT)   BEGIN
  INSERT INTO exam_access_logs (company_id, exam_id, student_id, action, status, message)
  VALUES (p_company_id, p_exam_id, p_student_id, p_action, p_status, p_message);
END$$

CREATE DEFINER=`root`@`localhost` PROCEDURE `sp_reset_exam_session` (IN `p_company_id` INT, IN `p_exam_id` VARCHAR(64), IN `p_student_id` VARCHAR(64))   BEGIN
  DELETE FROM exam_sessions
  WHERE company_id = p_company_id AND exam_id = p_exam_id AND student_id = p_student_id AND status <> 'COMPLETED';
END$$

CREATE DEFINER=`root`@`localhost` PROCEDURE `sp_save_exam` (IN `p_id` VARCHAR(64), IN `p_company_id` INT, IN `p_title` VARCHAR(255), IN `p_duration_minutes` INT, IN `p_start_time` DATETIME(3), IN `p_end_time` DATETIME(3), IN `p_question_count` INT, IN `p_shuffle_questions` TINYINT(1), IN `p_show_results` TINYINT(1), IN `p_pass_percent` INT, IN `p_attempt_policy` ENUM('BEST','LAST','AVERAGE'), IN `p_reconnect_limit` INT, IN `p_total_marks` INT, IN `p_status` ENUM('DRAFT','PUBLISHED','ARCHIVED'), IN `p_camera_required` TINYINT(1), IN `p_microphone_required` TINYINT(1), IN `p_fullscreen_enforced` TINYINT(1), IN `p_tab_switch_limit` INT, IN `p_notification_enabled` TINYINT(1), IN `p_reminder_hours24` TINYINT(1), IN `p_reminder_hours1` TINYINT(1), IN `p_notification_subject` VARCHAR(255), IN `p_notification_message` TEXT)   BEGIN
  IF p_title IS NULL OR p_title = '' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Exam title is required.';
  END IF;

  INSERT INTO exams (
    id, company_id, title, duration_minutes, start_time, end_time, question_count, shuffle_questions, show_results,
    pass_percent, attempt_policy, reconnect_limit, total_marks, status, camera_required, microphone_required, fullscreen_enforced, tab_switch_limit,
    notification_enabled, reminder_hours24, reminder_hours1, notification_subject, notification_message
  ) VALUES (
    p_id, p_company_id, p_title, p_duration_minutes, p_start_time, p_end_time, p_question_count, p_shuffle_questions, p_show_results,
    p_pass_percent, p_attempt_policy, p_reconnect_limit, p_total_marks, p_status, p_camera_required, p_microphone_required, p_fullscreen_enforced, p_tab_switch_limit,
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
    notification_enabled = VALUES(notification_enabled),
    reminder_hours24 = VALUES(reminder_hours24),
    reminder_hours1 = VALUES(reminder_hours1),
    notification_subject = VALUES(notification_subject),
    notification_message = VALUES(notification_message);
END$$

CREATE DEFINER=`root`@`localhost` PROCEDURE `sp_save_exam_section` (IN `p_id` VARCHAR(64), IN `p_exam_id` VARCHAR(64), IN `p_title` VARCHAR(255), IN `p_display_order` INT, IN `p_question_limit` INT, IN `p_shuffle_questions` TINYINT(1), IN `p_time_limit_minutes` INT, IN `p_lock_on_complete` TINYINT(1))   BEGIN
  INSERT INTO exam_sections (id, exam_id, title, display_order, question_limit, shuffle_questions, time_limit_minutes, lock_on_complete)
  VALUES (p_id, p_exam_id, p_title, p_display_order, p_question_limit, p_shuffle_questions, p_time_limit_minutes, p_lock_on_complete)
  ON DUPLICATE KEY UPDATE
    title = VALUES(title),
    display_order = VALUES(display_order),
    question_limit = VALUES(question_limit),
    shuffle_questions = VALUES(shuffle_questions),
    time_limit_minutes = VALUES(time_limit_minutes),
    lock_on_complete = VALUES(lock_on_complete);
END$$

CREATE DEFINER=`root`@`localhost` PROCEDURE `sp_save_question` (IN `p_id` VARCHAR(64), IN `p_type` ENUM('MCQ','TEXT'), IN `p_text` TEXT, IN `p_options_json` JSON, IN `p_correct_option_index` INT, IN `p_marks` INT)   BEGIN
  INSERT INTO questions (id, type, text, options_json, correct_option_index, marks)
  VALUES (p_id, p_type, p_text, p_options_json, p_correct_option_index, p_marks)
  ON DUPLICATE KEY UPDATE
    type = VALUES(type),
    text = VALUES(text),
    options_json = VALUES(options_json),
    correct_option_index = VALUES(correct_option_index),
    marks = VALUES(marks);
END$$

CREATE DEFINER=`root`@`localhost` PROCEDURE `sp_save_template` (IN `p_company_id` INT, IN `p_id` BIGINT, IN `p_name` VARCHAR(255), IN `p_channel` ENUM('EMAIL','SMS'), IN `p_subject` VARCHAR(255), IN `p_body` TEXT, IN `p_is_default` TINYINT(1))   BEGIN
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
END$$

CREATE DEFINER=`root`@`localhost` PROCEDURE `sp_start_exam_session` (IN `p_company_id` INT, IN `p_exam_id` VARCHAR(64), IN `p_student_id` VARCHAR(64), IN `p_user_agent` VARCHAR(512), IN `p_ip_address` VARCHAR(64), IN `p_location` VARCHAR(255), IN `p_device_fingerprint` VARCHAR(128), IN `p_mac_address` VARCHAR(17))   BEGIN
  DECLARE v_existing_mac VARCHAR(17);
  DECLARE v_mac_bound TINYINT(1);
  DECLARE v_session_id BIGINT;
  
  -- Check for existing IN_PROGRESS session with MAC binding
  SELECT mac_address, mac_bound INTO v_existing_mac, v_mac_bound
  FROM exam_sessions
  WHERE company_id = p_company_id AND exam_id = p_exam_id AND student_id = p_student_id AND status = 'IN_PROGRESS'
  ORDER BY start_time DESC
  LIMIT 1;
  
  -- If MAC is bound and doesn't match, block the new session
  IF v_mac_bound = 1 AND v_existing_mac IS NOT NULL AND v_existing_mac != p_mac_address AND p_mac_address IS NOT NULL THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'MAC_ADDRESS_MISMATCH';
  END IF;
  
  INSERT INTO exam_sessions (company_id, exam_id, student_id, start_time, status, ip_address, user_agent, location, device_fingerprint, mac_address, mac_bound, mac_bound_at)
  VALUES (p_company_id, p_exam_id, p_student_id, NOW(3), 'IN_PROGRESS', p_ip_address, p_user_agent, p_location, p_device_fingerprint, p_mac_address, IF(p_mac_address IS NOT NULL, 1, 0), IF(p_mac_address IS NOT NULL, NOW(3), NULL));
  
  SET v_session_id = LAST_INSERT_ID();
  
  -- Update previous sessions to mark them as not the current one
  UPDATE exam_sessions
  SET status = 'COMPLETED', end_time = NOW(3)
  WHERE company_id = p_company_id AND exam_id = p_exam_id AND student_id = p_student_id AND status = 'IN_PROGRESS' AND id != v_session_id;
END$$

CREATE DEFINER=`root`@`localhost` PROCEDURE `sp_reset_mac_binding` (IN `p_company_id` INT, IN `p_exam_id` VARCHAR(64), IN `p_student_id` VARCHAR(64))   BEGIN
  UPDATE exam_sessions
  SET mac_bound = 0, mac_bound_at = NULL, mac_address = NULL
  WHERE company_id = p_company_id AND exam_id = p_exam_id AND student_id = p_student_id AND status = 'IN_PROGRESS';
END$$

DELIMITER ;

-- --------------------------------------------------------

--
-- Table structure for table `audit_logs`
--

CREATE TABLE `audit_logs` (
  `id` bigint(20) UNSIGNED NOT NULL,
  `company_id` int(11) NOT NULL DEFAULT 1,
  `actor_role` enum('ADMIN','PROCTOR','STUDENT','SYSTEM') NOT NULL DEFAULT 'SYSTEM',
  `actor_id` varchar(64) DEFAULT NULL,
  `action` varchar(64) NOT NULL,
  `target_type` varchar(64) DEFAULT NULL,
  `target_id` varchar(64) DEFAULT NULL,
  `message` text DEFAULT NULL,
  `metadata` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`metadata`)),
  `ip_address` varchar(64) DEFAULT NULL,
  `user_agent` varchar(512) DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `delivery_logs`
--

CREATE TABLE `delivery_logs` (
  `id` bigint(20) UNSIGNED NOT NULL,
  `company_id` int(11) NOT NULL DEFAULT 1,
  `channel` enum('EMAIL','SMS') NOT NULL,
  `recipient` varchar(255) NOT NULL,
  `subject` varchar(255) DEFAULT NULL,
  `body` text DEFAULT NULL,
  `status` enum('SENT','FAILED','SKIPPED') NOT NULL DEFAULT 'SENT',
  `error` text DEFAULT NULL,
  `template_id` bigint(20) UNSIGNED DEFAULT NULL,
  `metadata` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`metadata`)),
  `created_at` timestamp NOT NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `exams`
--

CREATE TABLE `exams` (
  `id` varchar(64) NOT NULL,
  `company_id` int(11) NOT NULL DEFAULT 1,
  `title` varchar(255) NOT NULL,
  `duration_minutes` int(11) NOT NULL,
  `start_time` datetime(3) NOT NULL,
  `end_time` datetime(3) NOT NULL,
  `question_count` int(11) DEFAULT NULL,
  `shuffle_questions` tinyint(1) NOT NULL DEFAULT 1,
  `total_marks` int(11) NOT NULL DEFAULT 0,
  `status` enum('DRAFT','PUBLISHED','ARCHIVED') NOT NULL DEFAULT 'DRAFT',
  `camera_required` tinyint(1) NOT NULL DEFAULT 0,
  `microphone_required` tinyint(1) NOT NULL DEFAULT 0,
  `fullscreen_enforced` tinyint(1) NOT NULL DEFAULT 0,
  `tab_switch_limit` int(11) NOT NULL DEFAULT 3,
  `notification_enabled` tinyint(1) NOT NULL DEFAULT 0,
  `reminder_hours24` tinyint(1) NOT NULL DEFAULT 1,
  `reminder_hours1` tinyint(1) NOT NULL DEFAULT 1,
  `notification_subject` varchar(255) DEFAULT NULL,
  `notification_message` text DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  `show_results` tinyint(1) NOT NULL DEFAULT 0,
  `pass_percent` int(11) NOT NULL DEFAULT 60,
  `reconnect_limit` int(11) NOT NULL DEFAULT 0,
  `attempt_policy` enum('BEST','LAST','AVERAGE') NOT NULL DEFAULT 'LAST'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

--
-- Dumping data for table `exams`
--

INSERT INTO `exams` (`id`, `title`, `duration_minutes`, `start_time`, `end_time`, `question_count`, `shuffle_questions`, `total_marks`, `status`, `camera_required`, `microphone_required`, `fullscreen_enforced`, `tab_switch_limit`, `notification_enabled`, `reminder_hours24`, `reminder_hours1`, `notification_subject`, `notification_message`, `created_at`, `updated_at`, `show_results`, `pass_percent`, `reconnect_limit`, `attempt_policy`) VALUES
('mzxu3htd4', 'Demo', 15, '2026-02-05 10:20:00.000', '2026-02-07 10:15:00.000', 15, 1, 130, 'PUBLISHED', 1, 1, 1, 3, 1, 1, 1, 'Reminder: Demo', 'Hello {StudentName},\n\nThis is a reminder for your upcoming exam: {ExamTitle}.\nIt is scheduled to start at {StartTime}.\n\n{Link}\n\nPlease ensure your system is ready.\n\nGood luck!', '2026-02-05 09:17:26', '2026-02-06 13:02:21', 0, 60, 0, 'LAST');

-- --------------------------------------------------------

--
-- Table structure for table `exam_access_logs`
--

CREATE TABLE `exam_access_logs` (
  `id` bigint(20) UNSIGNED NOT NULL,
  `company_id` int(11) NOT NULL DEFAULT 1,
  `exam_id` varchar(64) NOT NULL,
  `student_id` varchar(64) NOT NULL,
  `action` varchar(32) NOT NULL,
  `status` varchar(32) NOT NULL,
  `message` text DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

--
-- Dumping data for table `exam_access_logs`
--

INSERT INTO `exam_access_logs` (`id`, `exam_id`, `student_id`, `action`, `status`, `message`, `created_at`) VALUES
(1, 'mzxu3htd4', 'nkue69f8p', 'START', 'OK', 'Session started', '2026-02-05 10:31:41'),
(2, 'mzxu3htd4', 'bc4dcae2b7dfa60e', 'START', 'OK', 'Session started', '2026-02-05 11:48:38'),
(3, 'mzxu3htd4', 'bc4dcae2b7dfa60e', 'START', 'DENY', 'Session already exists (IN_PROGRESS).', '2026-02-05 12:11:43'),
(4, 'mzxu3htd4', 'bc4dcae2b7dfa60e', 'RESET', 'OK', 'Session reset by admin', '2026-02-05 12:11:58'),
(5, 'mzxu3htd4', 'bc4dcae2b7dfa60e', 'START', 'OK', 'Session started', '2026-02-05 12:12:06'),
(6, 'mzxu3htd4', 'bc4dcae2b7dfa60e', 'START', 'DENY', 'Session already exists (IN_PROGRESS).', '2026-02-05 12:12:36'),
(7, 'mzxu3htd4', 'bc4dcae2b7dfa60e', 'START', 'DENY', 'Session already exists (IN_PROGRESS).', '2026-02-05 12:12:46'),
(8, 'mzxu3htd4', 'bc4dcae2b7dfa60e', 'RESET', 'OK', 'Session reset by admin', '2026-02-05 12:12:47'),
(9, 'mzxu3htd4', 'bc4dcae2b7dfa60e', 'START', 'OK', 'Session started', '2026-02-05 12:12:47'),
(10, 'mzxu3htd4', 'bc4dcae2b7dfa60e', 'RESET', 'OK', 'Session reset by admin', '2026-02-05 12:12:56'),
(11, 'mzxu3htd4', 'bc4dcae2b7dfa60e', 'START', 'OK', 'Session started', '2026-02-06 13:02:42'),
(12, 'mzxu3htd4', 'bc4dcae2b7dfa60e', 'COMPLETE', 'OK', 'Session completed', '2026-02-06 13:04:07');

-- --------------------------------------------------------

--
-- Table structure for table `exam_assignments`
--

CREATE TABLE `exam_assignments` (
  `exam_id` varchar(64) NOT NULL,
  `student_id` varchar(64) NOT NULL,
  `assigned_at` timestamp NOT NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `exam_batch_assignments`
--

CREATE TABLE `exam_batch_assignments` (
  `exam_id` varchar(64) NOT NULL,
  `batch_id` bigint(20) unsigned NOT NULL,
  `assigned_at` timestamp NOT NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

--
-- Dumping data for table `exam_assignments`
--

INSERT INTO `exam_assignments` (`exam_id`, `student_id`, `assigned_at`) VALUES
('mzxu3htd4', 'bc4dcae2b7dfa60e', '2026-02-06 13:02:22');

-- --------------------------------------------------------

--
-- Table structure for table `exam_questions`
--

CREATE TABLE `exam_questions` (
  `exam_id` varchar(64) NOT NULL,
  `question_id` varchar(64) NOT NULL,
  `display_order` int(11) DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

--
-- Dumping data for table `exam_questions`
--

INSERT INTO `exam_questions` (`exam_id`, `question_id`, `display_order`) VALUES
('mzxu3htd4', '07cmnk600', 35),
('mzxu3htd4', '0bbt1hwy2', 14),
('mzxu3htd4', '0bmzbwlcy', 7),
('mzxu3htd4', '12v2bfkhd', 98),
('mzxu3htd4', '1dte7jo8w', 45),
('mzxu3htd4', '1lbltcccg', 120),
('mzxu3htd4', '1xsigpvl9', 47),
('mzxu3htd4', '210vhqu88', 6),
('mzxu3htd4', '2kxhfaa8h', 127),
('mzxu3htd4', '35jtn3wv9', 93),
('mzxu3htd4', '3n5jgr9la', 119),
('mzxu3htd4', '4apqlpvta', 40),
('mzxu3htd4', '4xx7b61j7', 28),
('mzxu3htd4', '59caxb1si', 56),
('mzxu3htd4', '5azck04zl', 31),
('mzxu3htd4', '5g6hz4skg', 103),
('mzxu3htd4', '5jzc6x11q', 108),
('mzxu3htd4', '5sh8gysaa', 83),
('mzxu3htd4', '6f4wntc93', 69),
('mzxu3htd4', '6fmljlusu', 115),
('mzxu3htd4', '6o3q4eg73', 58),
('mzxu3htd4', '70qaaquhy', 17),
('mzxu3htd4', '75j0r6mbv', 10),
('mzxu3htd4', '7938ey187', 111),
('mzxu3htd4', '7lx9f2k5y', 3),
('mzxu3htd4', '7niilk8su', 59),
('mzxu3htd4', '7tgrnal6d', 19),
('mzxu3htd4', '84v6zv20x', 25),
('mzxu3htd4', '85y6gcy6g', 125),
('mzxu3htd4', '86l0s3h06', 21),
('mzxu3htd4', '8f2dj6b5q', 81),
('mzxu3htd4', '8g0ciiley', 34),
('mzxu3htd4', '8rjxxv6lw', 126),
('mzxu3htd4', '8vsov7dqv', 11),
('mzxu3htd4', '9544mgdn0', 70),
('mzxu3htd4', '98ndhy1sz', 38),
('mzxu3htd4', '9hlyhrcma', 110),
('mzxu3htd4', '9zg43x0qd', 79),
('mzxu3htd4', 'a52gk44hv', 13),
('mzxu3htd4', 'aamj06y6l', 72),
('mzxu3htd4', 'aapprnqjm', 91),
('mzxu3htd4', 'alhca1fbd', 71),
('mzxu3htd4', 'b6iyydl10', 86),
('mzxu3htd4', 'brnuo35ie', 18),
('mzxu3htd4', 'bv10mk93v', 100),
('mzxu3htd4', 'cbzbl0xvn', 61),
('mzxu3htd4', 'cvi3e8534', 0),
('mzxu3htd4', 'd19it739z', 15),
('mzxu3htd4', 'd2erk9jnv', 57),
('mzxu3htd4', 'dc24dru9s', 32),
('mzxu3htd4', 'edjkmdz7t', 123),
('mzxu3htd4', 'eirzhzku9', 101),
('mzxu3htd4', 'eomqib6jt', 30),
('mzxu3htd4', 'fww5o2c8k', 66),
('mzxu3htd4', 'gsiyvrpbm', 107),
('mzxu3htd4', 'h4wsr49zb', 122),
('mzxu3htd4', 'hhwck7l5p', 29),
('mzxu3htd4', 'hitflnspm', 52),
('mzxu3htd4', 'htgud2hj6', 112),
('mzxu3htd4', 'hyij5qdzs', 99),
('mzxu3htd4', 'i08i9my15', 67),
('mzxu3htd4', 'i4tyzpw8r', 78),
('mzxu3htd4', 'i5xc57q8t', 121),
('mzxu3htd4', 'ia99g31cn', 36),
('mzxu3htd4', 'ihzcevb1b', 95),
('mzxu3htd4', 'ivuqkqzgu', 129),
('mzxu3htd4', 'j57ld9fc8', 9),
('mzxu3htd4', 'j9euianv1', 124),
('mzxu3htd4', 'jegp8vt9n', 55),
('mzxu3htd4', 'jm7mjocqv', 128),
('mzxu3htd4', 'jmh67vgzw', 27),
('mzxu3htd4', 'jn84a59zg', 60),
('mzxu3htd4', 'jx4c226li', 104),
('mzxu3htd4', 'k2721q78q', 105),
('mzxu3htd4', 'kjw9iy7x8', 26),
('mzxu3htd4', 'kmaax56tl', 65),
('mzxu3htd4', 'kq19orbh6', 5),
('mzxu3htd4', 'l62aog991', 20),
('mzxu3htd4', 'lk19zgzb7', 96),
('mzxu3htd4', 'lw17xkm4j', 39),
('mzxu3htd4', 'm6yqx6svy', 82),
('mzxu3htd4', 'mxopfxjth', 48),
('mzxu3htd4', 'n60v7z7tb', 24),
('mzxu3htd4', 'n6fjeozp3', 76),
('mzxu3htd4', 'nd7n8vfke', 74),
('mzxu3htd4', 'ne1fy7k67', 33),
('mzxu3htd4', 'nudulrjiq', 68),
('mzxu3htd4', 'od3gbo5fi', 8),
('mzxu3htd4', 'ogwyuz5v4', 109),
('mzxu3htd4', 'oq9bg9wgn', 43),
('mzxu3htd4', 'p4no3zqoq', 44),
('mzxu3htd4', 'p7bhtvyb2', 88),
('mzxu3htd4', 'q68ezyqs6', 4),
('mzxu3htd4', 'qcikqftyr', 12),
('mzxu3htd4', 'qkq1ckk12', 102),
('mzxu3htd4', 'qmlxgmzvt', 1),
('mzxu3htd4', 'qxir8rg8o', 94),
('mzxu3htd4', 'qymxn3kzn', 84),
('mzxu3htd4', 'r1r3r2ugn', 53),
('mzxu3htd4', 'r7rwz6brs', 77),
('mzxu3htd4', 'r8yg1s71l', 42),
('mzxu3htd4', 'rxw22gdjj', 114),
('mzxu3htd4', 't5v894qxl', 51),
('mzxu3htd4', 'tbsmoqkzd', 75),
('mzxu3htd4', 'tc9z0f795', 92),
('mzxu3htd4', 'tcd4jcpwc', 97),
('mzxu3htd4', 'tin2cmw1c', 49),
('mzxu3htd4', 'tknu3v315', 22),
('mzxu3htd4', 'ttr2unhiq', 73),
('mzxu3htd4', 'tv0ph1rjd', 54),
('mzxu3htd4', 'tv30tvih6', 63),
('mzxu3htd4', 'uxkvgcq4g', 46),
('mzxu3htd4', 'uzovq5vnd', 90),
('mzxu3htd4', 'vr3gc8tw9', 106),
('mzxu3htd4', 'vyr2gl554', 80),
('mzxu3htd4', 'w0ecdh70q', 113),
('mzxu3htd4', 'widb5sr1m', 64),
('mzxu3htd4', 'wiulzr4l9', 41),
('mzxu3htd4', 'wncojlozy', 2),
('mzxu3htd4', 'wuv4xtcnx', 87),
('mzxu3htd4', 'x2rnlruy8', 62),
('mzxu3htd4', 'xgky52zai', 116),
('mzxu3htd4', 'xq1eb8ugv', 16),
('mzxu3htd4', 'y4bklbek2', 23),
('mzxu3htd4', 'yi6u2gchb', 85),
('mzxu3htd4', 'zivl9w421', 37),
('mzxu3htd4', 'zldloaqto', 50),
('mzxu3htd4', 'zn02tedzy', 118),
('mzxu3htd4', 'zq92ez8st', 89),
('mzxu3htd4', 'zzuuqomht', 117);

-- --------------------------------------------------------

--
-- Table structure for table `exam_sections`
--

CREATE TABLE `exam_sections` (
  `id` varchar(64) NOT NULL,
  `exam_id` varchar(64) NOT NULL,
  `title` varchar(255) NOT NULL,
  `display_order` int(11) NOT NULL DEFAULT 0,
  `question_limit` int(11) NOT NULL DEFAULT 0,
  `shuffle_questions` tinyint(1) NOT NULL DEFAULT 1,
  `time_limit_minutes` int(11) NOT NULL DEFAULT 0,
  `lock_on_complete` tinyint(1) NOT NULL DEFAULT 1
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `exam_section_questions`
--

CREATE TABLE `exam_section_questions` (
  `section_id` varchar(64) NOT NULL,
  `question_id` varchar(64) NOT NULL,
  `display_order` int(11) DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `exam_sessions`
--

CREATE TABLE `exam_sessions` (
  `id` bigint(20) UNSIGNED NOT NULL,
  `company_id` int(11) NOT NULL DEFAULT 1,
  `exam_id` varchar(64) NOT NULL,
  `student_id` varchar(64) NOT NULL,
  `start_time` datetime(3) NOT NULL,
  `end_time` datetime(3) DEFAULT NULL,
  `status` enum('IN_PROGRESS','COMPLETED','TERMINATED') NOT NULL DEFAULT 'IN_PROGRESS',
  `ip_address` varchar(64) DEFAULT NULL,
  `user_agent` varchar(512) DEFAULT NULL,
  `location` varchar(255) DEFAULT NULL,
  `location_lat` decimal(10,7) DEFAULT NULL,
  `location_lng` decimal(10,7) DEFAULT NULL,
  `location_accuracy_m` int(11) DEFAULT NULL,
  `total_score` int(11) DEFAULT NULL,
  `max_score` int(11) DEFAULT NULL,
  `passed` tinyint(1) DEFAULT NULL,
  `device_fingerprint` varchar(128) DEFAULT NULL,
  `device_metadata_json` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`device_metadata_json`)),
  `mac_address` varchar(17) DEFAULT NULL,
  `mac_bound` tinyint(1) NOT NULL DEFAULT 0,
  `mac_bound_at` datetime(3) DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

--
-- Dumping data for table `exam_sessions`
--

INSERT INTO `exam_sessions` (`id`, `exam_id`, `student_id`, `start_time`, `end_time`, `status`, `ip_address`, `user_agent`, `location`, `total_score`, `max_score`, `passed`, `device_fingerprint`) VALUES
(1, 'mzxu3htd4', 'nkue69f8p', '2026-02-05 16:01:41.703', NULL, 'IN_PROGRESS', '::1', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36', 'Library Network (Suspicious Cluster)', NULL, NULL, NULL, NULL),
(5, 'mzxu3htd4', 'bc4dcae2b7dfa60e', '2026-02-06 18:32:42.011', '2026-02-06 18:34:07.561', 'COMPLETED', '::1', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36', 'Residential ISP', NULL, NULL, NULL, NULL);

-- --------------------------------------------------------

--
-- Table structure for table `exam_location_logs`
--

CREATE TABLE `exam_location_logs` (
  `id` bigint(20) UNSIGNED NOT NULL,
  `company_id` int(11) NOT NULL DEFAULT 1,
  `session_id` bigint(20) UNSIGNED NOT NULL,
  `exam_id` varchar(64) NOT NULL,
  `student_id` varchar(64) NOT NULL,
  `latitude` decimal(10,7) DEFAULT NULL,
  `longitude` decimal(10,7) DEFAULT NULL,
  `accuracy_m` int(11) DEFAULT NULL,
  `location_label` varchar(255) DEFAULT NULL,
  `distance_from_start_m` int(11) DEFAULT NULL,
  `flagged` tinyint(1) NOT NULL DEFAULT 0,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `session_feedback`
--

CREATE TABLE `session_feedback` (
  `id` bigint(20) UNSIGNED NOT NULL,
  `company_id` int(11) NOT NULL DEFAULT 1,
  `session_id` bigint(20) UNSIGNED DEFAULT NULL,
  `exam_id` varchar(64) NOT NULL,
  `student_id` varchar(64) NOT NULL,
  `batch_id` bigint(20) UNSIGNED DEFAULT NULL,
  `rating` tinyint(3) UNSIGNED NOT NULL,
  `clarity_rating` tinyint(3) UNSIGNED DEFAULT NULL,
  `platform_rating` tinyint(3) UNSIGNED DEFAULT NULL,
  `comment` text DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `notification_templates`
--

CREATE TABLE `notification_templates` (
  `id` bigint(20) UNSIGNED NOT NULL,
  `company_id` int(11) NOT NULL DEFAULT 1,
  `name` varchar(255) NOT NULL,
  `channel` enum('EMAIL','SMS') NOT NULL DEFAULT 'EMAIL',
  `subject` varchar(255) DEFAULT NULL,
  `body` text NOT NULL,
  `is_default` tinyint(1) NOT NULL DEFAULT 0,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `questions`
--

CREATE TABLE `questions` (
  `id` varchar(64) NOT NULL,
  `type` enum('MCQ','TEXT') NOT NULL,
  `text` text NOT NULL,
  `options_json` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`options_json`)),
  `correct_option_index` int(11) DEFAULT NULL,
  `marks` int(11) NOT NULL DEFAULT 1
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

--
-- Dumping data for table `questions`
--

INSERT INTO `questions` (`id`, `type`, `text`, `options_json`, `correct_option_index`, `marks`) VALUES
('07cmnk600', 'MCQ', 'Only Incoterm used for sea transport only:', '[\"A. CIF\",\"B. FOB\",\"C. CFR\",\"D. All above\"]', 3, 1),
('0bbt1hwy2', 'MCQ', 'Port of Durban is in:', '[\"A. Kenya\",\"B. South Africa\",\"C. Australia\",\"D. UAE\"]', 1, 1),
('0bmzbwlcy', 'MCQ', 'Kamarajar Port (Ennore) is mainly known for handling:', '[\"A. Automobiles\",\"B. Textile\",\"C. Tea\",\"D. Timber\"]', 0, 1),
('12v2bfkhd', 'MCQ', 'ODC cargo means:', '[\"A. Over-dimension cargo\",\"B. Over-duty cargo\",\"C. On-demand cargo\",\"D. Overnight cargo\"]', 0, 1),
('1dte7jo8w', 'MCQ', 'For export, which document is mandatory?', '[\"A. Shipping Bill\",\"B. Bill of Entry\",\"C. Import license\",\"D. Cargo receipt\"]', 0, 1),
('1lbltcccg', 'MCQ', 'ICC A covers:', '[\"A. Named risks\",\"B. All risks\",\"C. Partial risks\",\"D. No risks\"]', 1, 1),
('1xsigpvl9', 'MCQ', 'Duty drawback given on:', '[\"A. Imports\",\"B. Exports\",\"C. Warehouse goods\",\"D. Bonded goods\"]', 1, 1),
('210vhqu88', 'MCQ', 'Port located in Tamil Nadu:', '[\"A. Marmugao\",\"B. Chennai\",\"C. Kandla\",\"D. Dahej\"]', 1, 1),
('2kxhfaa8h', 'MCQ', 'Export incentive scheme is:', '[\"A. MEIS\",\"B. GST\",\"C. NOC\",\"D. CBIC\"]', 0, 1),
('35jtn3wv9', 'MCQ', 'CSC plate appears on:', '[\"A. Invoice\",\"B. Container\",\"C. BL\",\"D. Warehouse\"]', 1, 1),
('3n5jgr9la', 'MCQ', 'PPE stands for:', '[\"A. Personal Protective Equipment\",\"B. Primary Package Entry\",\"C. Protective Packing Element\",\"D. Product Packaging Essentials\"]', 0, 1),
('4apqlpvta', 'MCQ', 'Bill of Entry filed for:', '[\"A. Export\",\"B. Import\",\"C. Transit\",\"D. Warehouse\"]', 1, 1),
('4xx7b61j7', 'MCQ', 'If flight departs Dubai 0900 hrs local and arrives Delhi at 1400 IST, flight duration is approx.:', '[\"A. 3 hrs\",\"B. 4 hrs\",\"C. 4.5 hrs\",\"D. 5 hrs\"]', 2, 1),
('59caxb1si', 'MCQ', 'Dangerous goods are accepted only with:', '[\"A. Invoice\",\"B. MSDS\",\"C. Job letter\",\"D. Port entry pass\"]', 1, 1),
('5azck04zl', 'MCQ', 'Which Incoterm includes insurance by seller?', '[\"A. CIF\",\"B. EXW\",\"C. FOB\",\"D. FCA\"]', 0, 1),
('5g6hz4skg', 'MCQ', 'AWB is a:', '[\"A. Negotiable document\",\"B. Non-negotiable document\",\"C. Payment instrument\",\"D. Insurance document\"]', 1, 1),
('5jzc6x11q', 'MCQ', 'A 747 aircraft called:', '[\"A. Intercontinental\",\"B. Jumbo Jet\",\"C. Sky Racer\",\"D. Titan Aircraft\"]', 1, 1),
('5sh8gysaa', 'MCQ', 'Anti-dumping duty imposed to:', '[\"A. Increase exports\",\"B. Prevent cheap imports\",\"C. Increase tax revenue\",\"D. Support aviation\"]', 1, 1),
('6f4wntc93', 'MCQ', 'FASTag uses:', '[\"A. RFID\",\"B. GPS\",\"C. Bluetooth\",\"D. Wi-Fi\"]', 0, 1),
('6fmljlusu', 'MCQ', 'Hazard symbols are based on:', '[\"A. IMDG\",\"B. OSHA\",\"C. GHS\",\"D. FSSAI\"]', 2, 1),
('6o3q4eg73', 'MCQ', 'Freight prepaid means charges paid by:', '[\"A. Buyer\",\"B. Seller\",\"C. Forwarder\",\"D. Carrier\"]', 1, 1),
('70qaaquhy', 'MCQ', 'Port Klang is in:', '[\"A. Indonesia\",\"B. Malaysia\",\"C. Vietnam\",\"D. Thailand\"]', 1, 1),
('75j0r6mbv', 'MCQ', 'World�s busiest container port:', '[\"A. Singapore\",\"B. Rotterdam\",\"C. Shanghai\",\"D. Hong Kong\"]', 2, 1),
('7938ey187', 'MCQ', 'MSDS stands for:', '[\"A. Material Safety Data Sheet\",\"B. Manufacturing Safety Data Sheet\",\"C. Material Storage Document Sheet\",\"D. Mandatory Safety Data Sheet\"]', 0, 1),
('7lx9f2k5y', 'MCQ', 'Which of the following is a private port?', '[\"A. Kandla\",\"B. Paradip\",\"C. Mundra\",\"D. Mumbai\"]', 2, 1),
('7niilk8su', 'MCQ', 'IATA deals with:', '[\"A. Sea rules\",\"B. Air transport\",\"C. Road transport\",\"D. Customs\"]', 1, 1),
('7tgrnal6d', 'MCQ', 'The busiest port in Europe is:', '[\"A. Rotterdam\",\"B. Hamburg\",\"C. Antwerp\",\"D. Marseille\"]', 0, 1),
('84v6zv20x', 'MCQ', 'Japan Standard Time is:', '[\"A. UTC +9\",\"B. UTC +8\",\"C. UTC +7\",\"D. UTC +6\"]', 0, 1),
('85y6gcy6g', 'MCQ', 'IEC stands for:', '[\"A. Indian Export Code\",\"B. Importer Exporter Code\",\"C. Internal Economic Code\",\"D. International Export Certificate\"]', 1, 1),
('86l0s3h06', 'MCQ', 'When it is 12:00 IST, time in London is approximately:', '[\"A. 6:30 AM\",\"B. 7:00 AM\",\"C. 5:30 AM\",\"D. 11:30 AM\"]', 0, 1),
('8f2dj6b5q', 'MCQ', 'IGST on imports is calculated on:', '[\"A. FOB\",\"B. CIF + duty\",\"C. MRP\",\"D. Retail price\"]', 1, 1),
('8g0ciiley', 'MCQ', 'Under CIP, insurance coverage is:', '[\"A. ICC A\",\"B. ICC B\",\"C. ICC C\",\"D. Minimum as per A\"]', 0, 1),
('8rjxxv6lw', 'MCQ', 'RCMC issued by:', '[\"A. Customs\",\"B. DGFT\",\"C. Export Promotion Council\",\"D. Bank\"]', 2, 1),
('8vsov7dqv', 'MCQ', 'Port of Antwerp is located in:', '[\"A. Germany\",\"B. Belgium\",\"C. Netherlands\",\"D. France\"]', 1, 1),
('9544mgdn0', 'MCQ', 'GST stands for:', '[\"A. Global Service Tax\",\"B. Goods and Services Tax\",\"C. General Sales Tax\",\"D. Goods Supply Tax\"]', 1, 1),
('98ndhy1sz', 'MCQ', 'Marine insurance is mandatory in which term?', '[\"A. CPT\",\"B. CIP\",\"C. EXW\",\"D. DDP\"]', 1, 1),
('9hlyhrcma', 'MCQ', 'DG Class 3 is:', '[\"A. Explosives\",\"B. Flammable liquids\",\"C. Gases\",\"D. Corrosives\"]', 1, 1),
('9zg43x0qd', 'MCQ', 'GST council headed by:', '[\"A. PM\",\"B. Finance Minister\",\"C. President\",\"D. RBI Governor\"]', 1, 1),
('a52gk44hv', 'MCQ', 'Which is a major transshipment hub?', '[\"A. Colombo\",\"B. Stockholm\",\"C. Osaka\",\"D. Dubai\"]', 0, 1),
('aamj06y6l', 'MCQ', 'IGST applies on:', '[\"A. Within-state supply\",\"B. Inter-state supply\",\"C. Petrol\",\"D. Alcohol\"]', 1, 1),
('aapprnqjm', 'MCQ', 'A 40 HC is:', '[\"A. 8 ft high\",\"B. 9.6 ft high\",\"C. 10 ft high\",\"D. 12 ft high\"]', 1, 1),
('alhca1fbd', 'MCQ', 'GST in India started in:', '[\"A. 2010\",\"B. 2017\",\"C. 2015\",\"D. 2020\"]', 1, 1),
('b6iyydl10', 'MCQ', 'Duty-free import under:', '[\"A. ATA Carnet\",\"B. Bill of Entry\",\"C. BL\",\"D. AWB\"]', 0, 1),
('brnuo35ie', 'MCQ', 'Which port is a major hub for LNG trade?', '[\"A. Ras Laffan\",\"B. Antwerp\",\"C. Chennai\",\"D. Rotterdam\"]', 0, 1),
('bv10mk93v', 'MCQ', 'IATA code for Delhi:', '[\"A. DEL\",\"B. BOM\",\"C. MAA\",\"D. HYD\"]', 0, 1),
('cbzbl0xvn', 'MCQ', 'FTWZ stands for:', '[\"A. Free Trade Warehousing Zone\",\"B. Fast Trade Work Zone\",\"C. Freight Transit & Warehousing Zone\",\"D. Foreign Trade Work Zone\"]', 0, 1),
('cvi3e8534', 'MCQ', 'India�s largest container port is:', '[\"A. Paradip Port\",\"B. Jawaharlal Nehru Port (JNPT)\",\"C. Chennai Port\",\"D. Mundra Port\"]', 1, 1),
('d19it739z', 'MCQ', 'Which port is known for bulk iron ore shipping?', '[\"A. Santos\",\"B. Qingdao\",\"C. Felixstowe\",\"D. Hamburg\"]', 1, 1),
('d2erk9jnv', 'MCQ', 'Transshipment means:', '[\"A. Final delivery\",\"B. Cargo transfer between vessels\",\"C. Cargo storage\",\"D. Cargo stuffing\"]', 1, 1),
('dc24dru9s', 'MCQ', 'Under EXW, export clearance is responsibility of:', '[\"A. Buyer\",\"B. Seller\",\"C. Carrier\",\"D. Forwarder\"]', 0, 1),
('edjkmdz7t', 'MCQ', 'Marine insurance governed by:', '[\"A. Contract Act\",\"B. Marine Insurance Act\",\"C. Customs Act\",\"D. Carriage of Goods Act\"]', 1, 1),
('eirzhzku9', 'MCQ', 'IATA code for Dubai airport:', '[\"A. DOH\",\"B. DXB\",\"C. DWC\",\"D. DUH\"]', 1, 1),
('eomqib6jt', 'MCQ', 'Under FOB, seller responsibility ends when goods:', '[\"A. Delivered to buyer\",\"B. Onboard vessel\",\"C. Reach destination port\",\"D. Customs cleared in buyer country\"]', 1, 1),
('fww5o2c8k', 'MCQ', 'ULD is used in:', '[\"A. Air cargo\",\"B. Sea cargo\",\"C. Road cargo\",\"D. Warehousing only\"]', 0, 1),
('gsiyvrpbm', 'MCQ', 'Most common ULD type:', '[\"A. PAG\",\"B. PMC\",\"C. DPN\",\"D. AXU\"]', 1, 1),
('h4wsr49zb', 'MCQ', 'General average means:', '[\"A. Loss shared by all\",\"B. Loss of ship only\",\"C. Loss of cargo only\",\"D. Loss to buyer\"]', 0, 1),
('hhwck7l5p', 'MCQ', 'China Standard Time is:', '[\"A. UTC +7\",\"B. UTC +8\",\"C. UTC +9\",\"D. UTC +10\"]', 1, 1),
('hitflnspm', 'MCQ', 'Cargo consolidation means:', '[\"A. Splitting cargo\",\"B. Combining LCL cargo\",\"C. Transshipment\",\"D. Repacking\"]', 1, 1),
('htgud2hj6', 'MCQ', 'DG Declaration signed by:', '[\"A. Cleaning staff\",\"B. Consignor\",\"C. Airport\",\"D. Buyer\"]', 1, 1),
('hyij5qdzs', 'MCQ', 'CSC stands for:', '[\"A. Container Safety Convention\",\"B. Cargo Safety Code\",\"C. Container Shipping Code\",\"D. Central Safety Clause\"]', 0, 1),
('i08i9my15', 'MCQ', '20 ft container length is approx.:', '[\"A. 25 ft\",\"B. 22 ft\",\"C. 19.5 ft\",\"D. 21.6 ft\"]', 2, 1),
('i4tyzpw8r', 'MCQ', 'Customs duty is:', '[\"A. Part of GST\",\"B. Separate from GST\",\"C. Replaced by GST\",\"D. Social tax\"]', 1, 1),
('i5xc57q8t', 'MCQ', 'Abandonment applies in:', '[\"A. Fire\",\"B. Constructive total loss\",\"C. Theft\",\"D. Minor damage\"]', 1, 1),
('ia99g31cn', 'MCQ', 'Under DDP, who pays import duty?', '[\"A. Buyer\",\"B. Seller\",\"C. Carrier\",\"D. Freight forwarder\"]', 1, 1),
('ihzcevb1b', 'MCQ', 'Flat rack used for:', '[\"A. Cars\",\"B. Over-dimensional cargo\",\"C. Electronics\",\"D. Refrigerated goods\"]', 1, 1),
('ivuqkqzgu', 'MCQ', 'LCL export requires:', '[\"A. Master BL only\",\"B. House BL\",\"C. Bill of Entry\",\"D. COO\"]', 1, 1),
('j57ld9fc8', 'MCQ', 'Haldia Dock Complex is part of:', '[\"A. Mumbai Port\",\"B. Kolkata Port Trust\",\"C. Cochin Port\",\"D. Chennai Port\"]', 1, 1),
('j9euianv1', 'MCQ', 'Surveyor appointed to:', '[\"A. Pack cargo\",\"B. Assess damages\",\"C. File shipping bill\",\"D. Book vessel\"]', 1, 1),
('jegp8vt9n', 'MCQ', 'NVOCC stands for:', '[\"A. New Voice of Container\",\"B. Non-Vessel Operating Common Carrier\",\"C. National Vessel Operator\",\"D. Non Value Of Cargo Carrier\"]', 1, 1),
('jm7mjocqv', 'MCQ', 'Advance Authorisation allows:', '[\"A. Duty-free import of inputs\",\"B. Export without license\",\"C. GST exemption\",\"D. Bonded warehouse\"]', 0, 1),
('jmh67vgzw', 'MCQ', 'Dubai time is:', '[\"A. UTC +2\",\"B. UTC +3\",\"C. UTC +4\",\"D. UTC +5\"]', 2, 1),
('jn84a59zg', 'MCQ', 'The smallest commercial road vehicle:', '[\"A. Ashok Leyland 3118\",\"B. Tata Ace\",\"C. Eicher 19 ft\",\"D. Volvo FM\"]', 1, 1),
('jx4c226li', 'MCQ', 'Dangerous goods handled as per:', '[\"A. ICAO\",\"B. IATA DGR\",\"C. IMDG\",\"D. OSHA\"]', 1, 1),
('k2721q78q', 'MCQ', 'Cargo build-up happens at:', '[\"A. Warehouse\",\"B. Ramp\",\"C. Terminal\",\"D. ACL\"]', 2, 1),
('kjw9iy7x8', 'MCQ', 'Greenwich Mean Time is same as:', '[\"A. UTC \\ufffd1\",\"B. UTC +1\",\"C. UTC 0\",\"D. UTC +5\"]', 2, 1),
('kmaax56tl', 'MCQ', 'Rail transport advantage:', '[\"A. Fast\",\"B. Economical for bulk\",\"C. Most flexible\",\"D. Best for small parcels\"]', 1, 1),
('kq19orbh6', 'MCQ', 'The deepest port in India is:', '[\"A. Vizag\",\"B. Mumbai\",\"C. Chennai\",\"D. Tuticorin\"]', 0, 1),
('l62aog991', 'MCQ', 'IST is:', '[\"A. UTC +5\",\"B. UTC +4:30\",\"C. UTC +5:30\",\"D. UTC +6\"]', 2, 1),
('lk19zgzb7', 'MCQ', 'Container number format is:', '[\"A. 3 letters + 7 numbers\",\"B. 4 letters + 7 numbers\",\"C. 4 letters + 6 numbers\",\"D. 2 letters + 5 numbers\"]', 1, 1),
('lw17xkm4j', 'MCQ', 'Most buyer-friendly term:', '[\"A. EXW\",\"B. DDP\",\"C. FCA\",\"D. CIP\"]', 1, 1),
('m6yqx6svy', 'MCQ', 'SWS stands for:', '[\"A. Social Welfare Surcharge\",\"B. Standard Welfare Surcharge\",\"C. Shipping Welfare Surcharge\",\"D. Special Wagon Surcharge\"]', 0, 1),
('mxopfxjth', 'MCQ', 'HS code stands for:', '[\"A. Harmonised System\",\"B. Host System\",\"C. High Security\",\"D. Harbour System\"]', 0, 1),
('n60v7z7tb', 'MCQ', 'Time difference between India and New York is approx.:', '[\"A. 6 hrs\",\"B. 9.5 hrs\",\"C. 12.5 hrs\",\"D. 24 hrs\"]', 1, 1),
('n6fjeozp3', 'MCQ', 'RCM stands for:', '[\"A. Reverse Company Mode\",\"B. Reverse Charge Mechanism\",\"C. Return Credit Mode\",\"D. Registered Company Model\"]', 1, 1),
('nd7n8vfke', 'MCQ', 'GST exemption applies on:', '[\"A. Exports\",\"B. Domestic supply\",\"C. Tobacco\",\"D. Gold\"]', 0, 1),
('ne1fy7k67', 'MCQ', 'Under DAP, seller delivers goods:', '[\"A. At factory\",\"B. Onboard ship\",\"C. At buyer\\ufffds premises\",\"D. At named place, not unloaded\"]', 3, 1),
('nudulrjiq', 'MCQ', 'Reefer container is used for:', '[\"A. Timber\",\"B. Dry cargo\",\"C. Perishables\",\"D. Machinery\"]', 2, 1),
('od3gbo5fi', 'MCQ', 'Which port lies on the Gujarat coast?', '[\"A. Marmugao\",\"B. Kandla\",\"C. Kochi\",\"D. Paradip\"]', 1, 1),
('ogwyuz5v4', 'MCQ', 'Air cargo is priced using:', '[\"A. CBM\",\"B. Chargeable weight\",\"C. Invoice\",\"D. Tonnage tax\"]', 1, 1),
('oq9bg9wgn', 'MCQ', 'Who issues Out-of-Charge?', '[\"A. Freight forwarder\",\"B. Customs officer\",\"C. CHA\",\"D. Shipping line\"]', 1, 1),
('p4no3zqoq', 'MCQ', 'Green Channel means:', '[\"A. Duty-free goods\",\"B. No examination\",\"C. High value cargo\",\"D. Hazardous cargo\"]', 1, 1),
('p7bhtvyb2', 'MCQ', 'T1 bond used for:', '[\"A. Warehousing\",\"B. Transshipment\",\"C. Export\",\"D. Courier\"]', 1, 1),
('q68ezyqs6', 'MCQ', 'Which port handles the maximum crude oil in India?', '[\"A. Hazira\",\"B. Cochin\",\"C. Mumbai\",\"D. Vadinar\"]', 3, 1),
('qcikqftyr', 'MCQ', 'Port of Los Angeles is also known as:', '[\"A. LA Port\",\"B. West Coast Hub\",\"C. America\\ufffds Port\",\"D. Skyline Port\"]', 2, 1),
('qkq1ckk12', 'MCQ', 'Chargeable weight is:', '[\"A. Actual weight only\",\"B. Volume weight or actual weight whichever higher\",\"C. Volume weight\",\"D. Packing weight\"]', 1, 1),
('qmlxgmzvt', 'MCQ', 'Which port is known as the �Diamond Harbour�?', '[\"A. Kolkata\",\"B. Haldia\",\"C. Kandla\",\"D. Tuticorin\"]', 0, 1),
('qxir8rg8o', 'MCQ', 'Maximum payload of 20 ft:', '[\"A. 10 tons\",\"B. 22 tons\",\"C. 5 tons\",\"D. 35 tons\"]', 1, 1),
('qymxn3kzn', 'MCQ', 'Customs assesses goods using:', '[\"A. Transaction value\",\"B. Market value\",\"C. MRP\",\"D. Declared value alone\"]', 0, 1),
('r1r3r2ugn', 'MCQ', 'LCL means:', '[\"A. Large Cargo Load\",\"B. Less than Container Load\",\"C. Long Container Load\",\"D. Loose Cargo Load\"]', 1, 1),
('r7rwz6brs', 'MCQ', 'Input tax credit means:', '[\"A. Claiming tax paid on purchases\",\"B. Extra tax\",\"C. Refund on salary\",\"D. Bank interest\"]', 0, 1),
('r8yg1s71l', 'MCQ', 'First document verified in customs import:', '[\"A. BL\\/AWB\",\"B. Invoice\",\"C. Packing list\",\"D. IEC\"]', 0, 1),
('rxw22gdjj', 'MCQ', 'Class 8 refers to:', '[\"A. Flammable\",\"B. Corrosive\",\"C. Radioactive\",\"D. Toxic\"]', 1, 1),
('t5v894qxl', 'MCQ', 'HAWB stands for:', '[\"A. High Airway Bill\",\"B. House Airway Bill\",\"C. Heavy Airway Bill\",\"D. Handling AWB\"]', 1, 1),
('tbsmoqkzd', 'MCQ', 'GSTIN is:', '[\"A. 10 digits\",\"B. 15 digits\",\"C. 12 digits\",\"D. 20 digits\"]', 1, 1),
('tc9z0f795', 'MCQ', 'ISO tank used for:', '[\"A. Dry cargo\",\"B. Liquid chemicals\",\"C. Machinery\",\"D. Garments\"]', 1, 1),
('tcd4jcpwc', 'MCQ', 'SOC means:', '[\"A. Ship Owned Container\",\"B. Shipper Owned Container\",\"C. Standard Owned Container\",\"D. Shipping Operator Cargo\"]', 1, 1),
('tin2cmw1c', 'MCQ', 'AEO stands for:', '[\"A. Automated Export Order\",\"B. Authorised Economic Operator\",\"C. Advanced Export Operation\",\"D. Audit Entry Operator\"]', 1, 1),
('tknu3v315', 'MCQ', 'USA Eastern Time is generally:', '[\"A. UTC \\ufffd1\",\"B. UTC \\ufffd4 or \\ufffd5\",\"C. UTC \\ufffd8\",\"D. UTC \\ufffd10\"]', 1, 1),
('ttr2unhiq', 'MCQ', 'GSTR-1 is filed by:', '[\"A. Buyer\",\"B. Supplier\",\"C. CHA\",\"D. Carrier\"]', 1, 1),
('tv0ph1rjd', 'MCQ', 'Freight rates depend mainly on:', '[\"A. Cargo taste\",\"B. Cargo value\",\"C. Cargo volume\\/weight\",\"D. Invoice value\"]', 2, 1),
('tv30tvih6', 'MCQ', 'Multimodal transport uses:', '[\"A. One mode only\",\"B. Two or more modes\",\"C. Only rail\",\"D. Only sea\"]', 1, 1),
('uxkvgcq4g', 'MCQ', 'EDI system of customs is called:', '[\"A. ICEGATE\",\"B. ICES\",\"C. DGFT portal\",\"D. AEO portal\"]', 1, 1),
('uzovq5vnd', 'MCQ', 'TEU stands for:', '[\"A. Twenty Foot Equivalent Unit\",\"B. Twenty Export Unit\",\"C. Total Equipment Unit\",\"D. Truck Equivalent Unit\"]', 0, 1),
('vr3gc8tw9', 'MCQ', 'ULD full form:', '[\"A. Universal Logistics Device\",\"B. Unit Load Device\",\"C. Unique Load Door\",\"D. Universal Line Deck\"]', 1, 1),
('vyr2gl554', 'MCQ', 'BCD stands for:', '[\"A. Basic Customs Duty\",\"B. Basic Cargo Duty\",\"C. Border Control Duty\",\"D. Bonded Cargo Duty\"]', 0, 1),
('w0ecdh70q', 'MCQ', 'DG Labels are:', '[\"A. Green\",\"B. Square-on-point\",\"C. Round\",\"D. Hidden\"]', 1, 1),
('widb5sr1m', 'MCQ', 'Document for road movement:', '[\"A. AWB\",\"B. LR\\/Bilty\",\"C. BL\",\"D. Import license\"]', 1, 1),
('wiulzr4l9', 'MCQ', 'Import duty is assessed based on:', '[\"A. MRP\",\"B. CIF value\",\"C. FOB value\",\"D. Retail value\"]', 1, 1),
('wncojlozy', 'MCQ', 'The only riverine major port in India is:', '[\"A. Kolkata Port\",\"B. Vizag Port\",\"C. Ennore Port\",\"D. Cochin Port\"]', 0, 1),
('wuv4xtcnx', 'MCQ', 'Duty drawback given as % of:', '[\"A. Selling price\",\"B. Customs value\",\"C. FOB value\",\"D. Domestic value\"]', 2, 1),
('x2rnlruy8', 'MCQ', 'Cabotage refers to:', '[\"A. Inland shipping\",\"B. Coastal shipping\",\"C. International trade\",\"D. Cross-stuffing\"]', 1, 1),
('xgky52zai', 'MCQ', 'UN Number identifies:', '[\"A. Shipper\",\"B. Consignee\",\"C. Hazardous substance\",\"D. Country\"]', 2, 1),
('xq1eb8ugv', 'MCQ', 'The world�s deepest port:', '[\"A. Busan\",\"B. Rotterdam\",\"C. Milford Haven\",\"D. Jebel Ali\"]', 2, 1),
('y4bklbek2', 'MCQ', 'Singapore time is:', '[\"A. UTC +8\",\"B. UTC +9\",\"C. UTC +7\",\"D. UTC +5:30\"]', 0, 1),
('yi6u2gchb', 'MCQ', 'Which notification governs customs valuation?', '[\"A. 44\\/2011\",\"B. 50\\/2017\",\"C. Customs Valuation Rules\",\"D. FEMA rules\"]', 2, 1),
('zivl9w421', 'MCQ', 'Under FCA, delivery is completed when:', '[\"A. Goods reach port\",\"B. Goods handed to carrier\",\"C. Goods onboard\",\"D. Payment done\"]', 1, 1),
('zldloaqto', 'MCQ', 'A Master Bill of Lading is issued by:', '[\"A. Forwarder\",\"B. Shipping Line\",\"C. Customs\",\"D. Exporter\"]', 1, 1),
('zn02tedzy', 'MCQ', 'SDS section 4 covers:', '[\"A. First aid\",\"B. Transport\",\"C. Packing\",\"D. Insurance\"]', 0, 1),
('zq92ez8st', 'MCQ', 'Customs duty collected by:', '[\"A. DGFT\",\"B. CBIC\",\"C. RBI\",\"D. TRAI\"]', 1, 1),
('zzuuqomht', 'MCQ', 'Red diamond symbol is for:', '[\"A. Toxic\",\"B. Corrosive\",\"C. Flammable\",\"D. Radioactive\"]', 2, 1);

-- --------------------------------------------------------

--
-- Table structure for table `result_audit_logs`
--

CREATE TABLE `result_audit_logs` (
  `id` bigint(20) UNSIGNED NOT NULL,
  `session_id` bigint(20) UNSIGNED NOT NULL,
  `question_id` varchar(64) DEFAULT NULL,
  `previous_awarded_marks` int(11) DEFAULT NULL,
  `new_awarded_marks` int(11) DEFAULT NULL,
  `previous_is_correct` tinyint(1) DEFAULT NULL,
  `new_is_correct` tinyint(1) DEFAULT NULL,
  `actor` varchar(128) DEFAULT NULL,
  `note` text DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `session_answers`
--

CREATE TABLE `session_answers` (
  `session_id` bigint(20) UNSIGNED NOT NULL,
  `question_id` varchar(64) NOT NULL,
  `answer_text` text DEFAULT NULL,
  `answer_option_index` int(11) DEFAULT NULL,
  `is_correct` tinyint(1) DEFAULT NULL,
  `awarded_marks` int(11) DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `session_question_times`
--

CREATE TABLE `session_question_times` (
  `session_id` bigint(20) UNSIGNED NOT NULL,
  `question_id` varchar(64) NOT NULL,
  `seconds_spent` int(11) NOT NULL DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `batches`
--

CREATE TABLE `batches` (
  `id` bigint(20) UNSIGNED NOT NULL,
  `company_id` int(11) NOT NULL DEFAULT 1,
  `name` varchar(255) NOT NULL,
  `description` text DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `students`
--

CREATE TABLE `students` (
  `id` varchar(64) NOT NULL,
  `company_id` int(11) NOT NULL DEFAULT 1,
  `full_name` varchar(255) NOT NULL,
  `email` varchar(255) NOT NULL,
  `registration_id` varchar(128) NOT NULL,
  `batch_id` bigint(20) UNSIGNED DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

--
-- Dumping data for table `students`
--

INSERT INTO `students` (`id`, `full_name`, `email`, `registration_id`, `created_at`) VALUES
('4ipabls66', 'Gokul', 'gokulrajg@lsc-india.com', '2', '2026-02-05 08:59:07'),
('bc4dcae2b7dfa60e', 'priyadarshini', 'priyadarshini@lsc-india.com', '3', '2026-02-05 11:46:18'),
('nkue69f8p', 'Gowtham', 'gowthamchandran@lsc-india.com', '1', '2026-02-05 08:59:07');

-- --------------------------------------------------------

--
-- Table structure for table `violation_logs`
--

CREATE TABLE `violation_logs` (
  `id` bigint(20) UNSIGNED NOT NULL,
  `company_id` int(11) NOT NULL DEFAULT 1,
  `session_id` bigint(20) UNSIGNED NOT NULL,
  `occurred_at` datetime(3) NOT NULL,
  `type` enum('TAB_SWITCH','NO_FACE','MULTIPLE_FACES','GAZE_AWAY','AUDIO_DETECTED','FULLSCREEN_EXIT','COPY_PASTE','PHONE_DETECTED','ANOMALY_OBJECT','LOCATION_CHANGE') NOT NULL,
  `category` varchar(32) DEFAULT NULL,
  `confidence` decimal(5,4) DEFAULT NULL,
  `description` text NOT NULL,
  `snapshot_base64` longtext DEFAULT NULL,
  `metadata_json` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`metadata_json`))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

--
-- Dumping data for table `violation_logs`
--

INSERT INTO `violation_logs` (`id`, `session_id`, `occurred_at`, `type`, `description`, `snapshot_base64`) VALUES
(1, 1, '2026-02-05 16:02:34.334', 'TAB_SWITCH', 'Focus lost. Return to exam immediately.', 'data:image/jpeg;base64,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'),
(2, 1, '2026-02-05 16:02:45.263', 'TAB_SWITCH', 'Focus lost. Return to exam immediately.', 'data:image/jpeg;base64,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'),
(3, 1, '2026-02-05 16:03:02.849', 'TAB_SWITCH', 'Focus lost. Return to exam immediately.', 'data:image/jpeg;base64,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'),
(4, 1, '2026-02-05 16:03:10.452', 'MULTIPLE_FACES', 'Multiple people detected. Only one person allowed.', 'data:image/jpeg;base64,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'),
(5, 1, '2026-02-05 16:03:14.783', 'NO_FACE', 'No person detected. Please stay in frame.', 'data:image/jpeg;base64,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');
INSERT INTO `violation_logs` (`id`, `session_id`, `occurred_at`, `type`, `description`, `snapshot_base64`) VALUES
(6, 1, '2026-02-05 16:03:24.320', 'TAB_SWITCH', 'Focus lost. Return to exam immediately.', 'data:image/jpeg;base64,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'),
(7, 1, '2026-02-05 16:03:38.736', 'NO_FACE', 'No person detected. Please stay in frame.', 'data:image/jpeg;base64,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'),
(8, 1, '2026-02-05 16:03:58.452', 'NO_FACE', 'No person detected. Please stay in frame.', 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/4gHYSUNDX1BST0ZJTEUAAQEAAAHIAAAAAAQwAABtbnRyUkdCIFhZWiAH4AABAAEAAAAAAABhY3NwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAA9tYAAQAAAADTLQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAlkZXNjAAAA8AAAACRyWFlaAAABFAAAABRnWFlaAAABKAAAABRiWFlaAAABPAAAABR3dHB0AAABUAAAABRyVFJDAAABZAAAAChnVFJDAAABZAAAAChiVFJDAAABZAAAAChjcHJ0AAABjAAAADxtbHVjAAAAAAAAAAEAAAAMZW5VUwAAAAgAAAAcAHMAUgBHAEJYWVogAAAAAAAAb6IAADj1AAADkFhZWiAAAAAAAABimQAAt4UAABjaWFlaIAAAAAAAACSgAAAPhAAAts9YWVogAAAAAAAA9tYAAQAAAADTLXBhcmEAAAAAAAQAAAACZmYAAPKnAAANWQAAE9AAAApbAAAAAAAAAABtbHVjAAAAAAAAAAEAAAAMZW5VUwAAACAAAAAcAEcAbwBvAGcAbABlACAASQBuAGMALgAgADIAMAAxADb/2wBDABALDA4MChAODQ4SERATGCgaGBYWGDEjJR0oOjM9PDkzODdASFxOQERXRTc4UG1RV19iZ2hnPk1xeXBkeFxlZ2P/2wBDARESEhgVGC8aGi9jQjhCY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2P/wAARCADwAUADASIAAhEBAxEB/8QAFwABAQEBAAAAAAAAAAAAAAAAAAECBv/EAB0QAQEBAAMAAwEAAAAAAAAAAAABESExQQJhcVH/xAAVAQEBAAAAAAAAAAAAAAAAAAAAAf/EABURAQEAAAAAAAAAAAAAAAAAAAAB/9oADAMBAAIRAxEAPwDgfUvapVCixAXU0oATsBT0BEAAABTQQRSUBQAQ0ADTQAAAAANAAABfjwhqiid0vYq28moZwC/ayxmNTCIyqW7QCgYBq3PEAAAAEABQAQAAAAAAAAAAAAAAKB6oAAAQCFFnQIAKvR+Ivd4EQAD7DQUAEMAAAQAAAAAAAAAFABAAAAAAAAUAIACgh+AKLlxCCEih2CLMzlAABABAUAAAAAURQAAQEAUEBRFARQAEBQAAAAPAAAAKoL4gABgGAIBnAeAIoAAAAAIoAAAAAAAACCgAAIoAAAAAAoAAQAACARd4QAAQAAAAKAKACIoAiiAKICoqAoAAACCgIoACAoAAigCKAEAAAAXVEARQABFBBFQFABFABABQARQAEABUBRFARUAFQAAFRQARQEUFABAJD0AAAAUAEAAAAAARUUEFAQABRAFABABUVAUAAAAAAAAAUBcmKIBmIAAgAKACAigCKAigIoAAAgoAIoIKACKAioCoKAAAAAAAAAAKRahFAgCFAAAAAQAAAQFAABAUEBQAAQFAAAARQAAAAAAU/QFQAQCCzhROAAAEAAEUQFAAAAEAFQAFAAQBQARQAAAAAAAAAAACzADwBQMFQgFAAQAPAABQAQAAAAQUAQBUUAAAABFRQBFAAAAAAAAAAUA8EF8QFUOwEARBQABFAAAAAEUEUAAAAAEVAUEBQAABQARbMQKoAUAAAgoGiAoaE4ENAAAQAAAQFBAUAAEBQAAAAARQAAAAAAUAIgAKCoQCh4ToUXTP6lggGGIAGcaoACgAgAgACgAgHgoAIIoAAAAAACgAgAqhAEKE75UVPBTsRDqkW0V//9k='),
(9, 1, '2026-02-05 16:04:02.757', 'NO_FACE', 'No person detected. Please stay in frame.', 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/4gHYSUNDX1BST0ZJTEUAAQEAAAHIAAAAAAQwAABtbnRyUkdCIFhZWiAH4AABAAEAAAAAAABhY3NwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAA9tYAAQAAAADTLQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAlkZXNjAAAA8AAAACRyWFlaAAABFAAAABRnWFlaAAABKAAAABRiWFlaAAABPAAAABR3dHB0AAABUAAAABRyVFJDAAABZAAAAChnVFJDAAABZAAAAChiVFJDAAABZAAAAChjcHJ0AAABjAAAADxtbHVjAAAAAAAAAAEAAAAMZW5VUwAAAAgAAAAcAHMAUgBHAEJYWVogAAAAAAAAb6IAADj1AAADkFhZWiAAAAAAAABimQAAt4UAABjaWFlaIAAAAAAAACSgAAAPhAAAts9YWVogAAAAAAAA9tYAAQAAAADTLXBhcmEAAAAAAAQAAAACZmYAAPKnAAANWQAAE9AAAApbAAAAAAAAAABtbHVjAAAAAAAAAAEAAAAMZW5VUwAAACAAAAAcAEcAbwBvAGcAbABlACAASQBuAGMALgAgADIAMAAxADb/2wBDABALDA4MChAODQ4SERATGCgaGBYWGDEjJR0oOjM9PDkzODdASFxOQERXRTc4UG1RV19iZ2hnPk1xeXBkeFxlZ2P/2wBDARESEhgVGC8aGi9jQjhCY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2P/wAARCADwAUADASIAAhEBAxEB/8QAFwABAQEBAAAAAAAAAAAAAAAAAAECBv/EABsQAQEBAQEBAQEAAAAAAAAAAAABEUEhAjFx/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAH/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwDgIC+YqoS5QQa+vrZ6zwFQARQAAAAoAAAAAAALqCi6gIgXQFOAAFABduIKi8wlyYgKaS2XQRF/SWpAVd8w3xCqACIcAAAABAUAAAAAAAAEBQAABQARFAAAAAAAAAAAACfooAAAIAAAAAAAAAAGBoAAAAAAoAIAAAAcAAAAAAA0AAUAggAKACAAAAAAAAAAAAAAAAAAAAAAAAAAAABwAAAABQAQAAAAEUAEBQAAAAABFBFAAAEUAEUAEUAAEUARQAEUAAAAAAAAEUAAAIAAigIoAAAAACAKAAAAAACAoAIoAAgKAAAAAAAAH9AAAAAAAAARUUAAAEBQAAAAQFEUEUAAAAABAFAAAAAAAAAAAAAAAAAAAAAAAARQARQAAAAEUBFAAAAAAAAAAAAAAAUAEAAAAAAAAAAAAAAQUAABFAEUAAAAABFAAARQAABFQFOAAAKACAAAAAAAAAACKAAAAAAAAAAgKAAAAABAAAAAAAABFARQAAAAEUAABQAQAAAAABFAAABFAAAAAAAABQAAAQAFABAAA4AAICgACAKAAAAAAgAoAAgCiKCKIAqKAAKCKICKAAACAoAAUAAFABAAAEBQAAAAAAAAAAAAAAAAAAAAARd8AUAAAEDhboAAAIoAAAAoAAAIAACKAigAAAAAABwABFAAFABAAA4GeAAAQAUAEAAAoAIooAIHAAAAAAAAABFAAAAAAAAKAAAACkDAQAB//9k='),
(10, 1, '2026-02-05 16:04:10.453', 'NO_FACE', 'No person detected. Please stay in frame.', 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/4gHYSUNDX1BST0ZJTEUAAQEAAAHIAAAAAAQwAABtbnRyUkdCIFhZWiAH4AABAAEAAAAAAABhY3NwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAA9tYAAQAAAADTLQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAlkZXNjAAAA8AAAACRyWFlaAAABFAAAABRnWFlaAAABKAAAABRiWFlaAAABPAAAABR3dHB0AAABUAAAABRyVFJDAAABZAAAAChnVFJDAAABZAAAAChiVFJDAAABZAAAAChjcHJ0AAABjAAAADxtbHVjAAAAAAAAAAEAAAAMZW5VUwAAAAgAAAAcAHMAUgBHAEJYWVogAAAAAAAAb6IAADj1AAADkFhZWiAAAAAAAABimQAAt4UAABjaWFlaIAAAAAAAACSgAAAPhAAAts9YWVogAAAAAAAA9tYAAQAAAADTLXBhcmEAAAAAAAQAAAACZmYAAPKnAAANWQAAE9AAAApbAAAAAAAAAABtbHVjAAAAAAAAAAEAAAAMZW5VUwAAACAAAAAcAEcAbwBvAGcAbABlACAASQBuAGMALgAgADIAMAAxADb/2wBDABALDA4MChAODQ4SERATGCgaGBYWGDEjJR0oOjM9PDkzODdASFxOQERXRTc4UG1RV19iZ2hnPk1xeXBkeFxlZ2P/2wBDARESEhgVGC8aGi9jQjhCY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2P/wAARCADwAUADASIAAhEBAxEB/8QAFwABAQEBAAAAAAAAAAAAAAAAAAECBv/EABoQAQEBAQEBAQAAAAAAAAAAAAABEUExIRL/xAAVAQEBAAAAAAAAAAAAAAAAAAAAAf/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AOBQPRRdSgiy4lAUAANAF1NADfoABQABAalsSiApoA1vxJfz9QULdoCCym4gAABLlXdqACy4gC6gAupoARdyoX0AAAAQAAAAAAAAAAAAAAAFABAAAAACAAAAAKgBboCqaegiAAoHD0QA4KAAACAICgAAAAAAAAAAAAAAAAAAgL4AKACAAAAAAoCAoAAAgAAigAICooAAAAAIoAICgCgAgAAAAAAAAAABoHAABFAEAUEBQABFAEUAEBQAAAAAAAEVAUEBQAABQEEUAAAAAAAUAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIAF9AMDhwAAAAEVFAAAAAAAAAAAAAAAAAAAAAAFEUEAKCKABwAAAABQAQAAAAwAEUAABQABFBAAAAAABFAAAAAAAAAAAAAAAAIAAAAAAKACAAAICgAAACKAAAAAAAAAAAIoAAAAAAAAAACKAAUAAAAAAAABFARQAEUBFAAAAAAAAAAAAAAAAAAAXUAAAAAAAAAAAUAEAAAAAAAAAAAAQUBFABFAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEUAAAAAAAAAAABAUAAMADPgAAAAAAAAAAAAAaAAAAAAAAAAAAAAAKIoABwQAAAAAFAwEAAAAANAAAAAAgAEFABAAAAAAAAAACgAACnzABAAAMBQAQAFAAF+YgIAAAAAAAAEAUAEEUA4AAAAAAAAAAAAAAB4KAsVEAQAAf//Z'),
(11, 1, '2026-02-05 16:04:18.769', 'NO_FACE', 'No person detected. Please stay in frame.', 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/4gHYSUNDX1BST0ZJTEUAAQEAAAHIAAAAAAQwAABtbnRyUkdCIFhZWiAH4AABAAEAAAAAAABhY3NwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAA9tYAAQAAAADTLQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAlkZXNjAAAA8AAAACRyWFlaAAABFAAAABRnWFlaAAABKAAAABRiWFlaAAABPAAAABR3dHB0AAABUAAAABRyVFJDAAABZAAAAChnVFJDAAABZAAAAChiVFJDAAABZAAAAChjcHJ0AAABjAAAADxtbHVjAAAAAAAAAAEAAAAMZW5VUwAAAAgAAAAcAHMAUgBHAEJYWVogAAAAAAAAb6IAADj1AAADkFhZWiAAAAAAAABimQAAt4UAABjaWFlaIAAAAAAAACSgAAAPhAAAts9YWVogAAAAAAAA9tYAAQAAAADTLXBhcmEAAAAAAAQAAAACZmYAAPKnAAANWQAAE9AAAApbAAAAAAAAAABtbHVjAAAAAAAAAAEAAAAMZW5VUwAAACAAAAAcAEcAbwBvAGcAbABlACAASQBuAGMALgAgADIAMAAxADb/2wBDABALDA4MChAODQ4SERATGCgaGBYWGDEjJR0oOjM9PDkzODdASFxOQERXRTc4UG1RV19iZ2hnPk1xeXBkeFxlZ2P/2wBDARESEhgVGC8aGi9jQjhCY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2P/wAARCADwAUADASIAAhEBAxEB/8QAFgABAQEAAAAAAAAAAAAAAAAAAAEG/8QAHRABAQEAAwADAQAAAAAAAAAAAAERITFBAhJRYf/EABUBAQEAAAAAAAAAAAAAAAAAAAAB/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AwAAobtAFnys4hLiCi2oCC9GoKGgIC6ngBaAIACmmgAsQAlyrt3UAAAAANXeMQBdzk+yAKbd1CqLbpLiCBbphAFTeTxc/QQAADAAAAAABAAAAUAEAAIAKigIAAAAAAAChQAAEAADPQANAUAAAA0AAAQAFABAPAAPQUAEABQAQAAAAAAAAAAAvQoEBAAAAUAEAAAAAAABQAQAAAAAAAAAAAAAAAAzgAAAAACAAAAEAUAEAAAQFAARQAAAAAAAAAAAAAEBUUARQAAAAAAAAAAAAAAAAAAAAAAUAEAABFARQAAAEAUAAAAAAAAQFAAAAAAhYAoAIAAIKAIAoigAAACgIIoAAAAAAigAAAAAAAAAAAAAAAAAAAAAAAAAAigAAAAAAAAAAAAAAAiwFABAAAAUAEABQAQRQUEUBBQAAABAAAAAAARQAAAQFEUAAAAEUAAAAAAAAAAAAAABQAQ8ABFEBQAAAAAABQRRAAAAAAAAAAAAAAAAAAAAAAUAEKIooAIIqAogCiKAAAAAAAACKICiKAAAAAAAAAAAAKGAIAABQAAAAAAUAEAAAAAAEUAAAAAAAABFAAAAAAAUAAAEAACdgBQAAAAARUUAAAAAEBQAAAAAAAAAAAAAAAAAL/AAAAAAABQAQAAABFAAABFAEUAAAAAABFAAAAAAAAAACdigUACAAHYhQAAAAAAAMAAAAAAAAAAAACUAVCKBh6AAIAAGFBQAQBekFMAB//9k='),
(12, 1, '2026-02-05 16:04:22.445', 'NO_FACE', 'No person detected. Please stay in frame.', 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/4gHYSUNDX1BST0ZJTEUAAQEAAAHIAAAAAAQwAABtbnRyUkdCIFhZWiAH4AABAAEAAAAAAABhY3NwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAA9tYAAQAAAADTLQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAlkZXNjAAAA8AAAACRyWFlaAAABFAAAABRnWFlaAAABKAAAABRiWFlaAAABPAAAABR3dHB0AAABUAAAABRyVFJDAAABZAAAAChnVFJDAAABZAAAAChiVFJDAAABZAAAAChjcHJ0AAABjAAAADxtbHVjAAAAAAAAAAEAAAAMZW5VUwAAAAgAAAAcAHMAUgBHAEJYWVogAAAAAAAAb6IAADj1AAADkFhZWiAAAAAAAABimQAAt4UAABjaWFlaIAAAAAAAACSgAAAPhAAAts9YWVogAAAAAAAA9tYAAQAAAADTLXBhcmEAAAAAAAQAAAACZmYAAPKnAAANWQAAE9AAAApbAAAAAAAAAABtbHVjAAAAAAAAAAEAAAAMZW5VUwAAACAAAAAcAEcAbwBvAGcAbABlACAASQBuAGMALgAgADIAMAAxADb/2wBDABALDA4MChAODQ4SERATGCgaGBYWGDEjJR0oOjM9PDkzODdASFxOQERXRTc4UG1RV19iZ2hnPk1xeXBkeFxlZ2P/2wBDARESEhgVGC8aGi9jQjhCY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2P/wAARCADwAUADASIAAhEBAxEB/8QAFwABAQEBAAAAAAAAAAAAAAAAAAECBv/EABsQAQEBAQEBAQEAAAAAAAAAAAABEUEhMQJh/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAH/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwDgeJoCrqUAXfEADVqAG+YABq7cxAAgAWgALqALagAAAsqS4AG+rbqAL+bhagAaALLlJc1AAAF1ABqXfqb5Yknoos+IRQQBEAAAAAAAAICAoAoAAAIAAAAAAAAAAAAHAAAAOBAAIKvmpugAAIAAAAAAAAAAAAAAACgAgIoAAAICgAAAAAAAATADAgoAAAIAAACgAgCAqLnmgCKAAAAAIoAAACCqAIACgAgAAABwn0BQACZ0AAOggAAAAAAABwAAAAAAAEUAAQFAAAA4CAoAAAAigAAACnAAABAAAAAAAAAAAAAAAAAABFAAAAAAAAAAAAAAAAAA+gAAoAIiooAAAAIoAAAAAAAigAAAIooAIAAigAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAoigAgKAAAAAAAAAAAKACAAFAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIAFAAAAAAAAAAAAEUAAAAAAAAAAAAAEBUUAAAABFAAAAAAOAGAAAQUAEAAAAANAAAAAAAAFABAAAAAAAAAAAAAAAsAUA4IAAAAAAAAAAAAAAIoACAoAAAAAIqKAigAAAAAAAICgAHwAKAAAAAAAAAAAAAAAAAAACKACKAAAAACKAAAQAAAABQgCAAAAAAAAAAAigAAAAAACKAAAAAAKACIqAKCAoAAAAABwAAi4CBfDgAACKAAAAAAAAAAAAZ4AAAAAAAAAAAAAT6AF8BZ/RUAwQD4A//2Q=='),
(13, 1, '2026-02-05 16:04:26.765', 'NO_FACE', 'No person detected. Please stay in frame.', 'data:image/jpeg;base64,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'),
(14, 1, '2026-02-05 16:04:34.442', 'NO_FACE', 'No person detected. Please stay in frame.', 'data:image/jpeg;base64,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'),
(15, 1, '2026-02-05 16:04:42.816', 'NO_FACE', 'No person detected. Please stay in frame.', 'data:image/jpeg;base64,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'),
(16, 1, '2026-02-05 16:04:52.349', 'TAB_SWITCH', 'Focus lost. Return to exam immediately.', 'data:image/jpeg;base64,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');
INSERT INTO `violation_logs` (`id`, `session_id`, `occurred_at`, `type`, `description`, `snapshot_base64`) VALUES
(17, 1, '2026-02-05 16:05:02.945', 'TAB_SWITCH', 'Focus lost. Return to exam immediately.', 'data:image/jpeg;base64,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'),
(18, 1, '2026-02-05 16:05:10.912', 'TAB_SWITCH', 'Exam window hidden. Incident logged.', 'data:image/jpeg;base64,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'),
(22, 5, '2026-02-06 18:32:42.917', 'TAB_SWITCH', 'Focus lost. Return to exam immediately.', 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/4gHYSUNDX1BST0ZJTEUAAQEAAAHIAAAAAAQwAABtbnRyUkdCIFhZWiAH4AABAAEAAAAAAABhY3NwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAA9tYAAQAAAADTLQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAlkZXNjAAAA8AAAACRyWFlaAAABFAAAABRnWFlaAAABKAAAABRiWFlaAAABPAAAABR3dHB0AAABUAAAABRyVFJDAAABZAAAAChnVFJDAAABZAAAAChiVFJDAAABZAAAAChjcHJ0AAABjAAAADxtbHVjAAAAAAAAAAEAAAAMZW5VUwAAAAgAAAAcAHMAUgBHAEJYWVogAAAAAAAAb6IAADj1AAADkFhZWiAAAAAAAABimQAAt4UAABjaWFlaIAAAAAAAACSgAAAPhAAAts9YWVogAAAAAAAA9tYAAQAAAADTLXBhcmEAAAAAAAQAAAACZmYAAPKnAAANWQAAE9AAAApbAAAAAAAAAABtbHVjAAAAAAAAAAEAAAAMZW5VUwAAACAAAAAcAEcAbwBvAGcAbABlACAASQBuAGMALgAgADIAMAAxADb/2wBDABALDA4MChAODQ4SERATGCgaGBYWGDEjJR0oOjM9PDkzODdASFxOQERXRTc4UG1RV19iZ2hnPk1xeXBkeFxlZ2P/2wBDARESEhgVGC8aGi9jQjhCY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2P/wAARCADwAUADASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAAP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AJ+AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD/2Q=='),
(23, 5, '2026-02-06 18:33:18.196', 'AUDIO_DETECTED', 'High noise detected. Please remain quiet.', 'data:image/jpeg;base64,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'),
(24, 5, '2026-02-06 18:33:23.668', 'AUDIO_DETECTED', 'High noise detected. Please remain quiet.', 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/4gHYSUNDX1BST0ZJTEUAAQEAAAHIAAAAAAQwAABtbnRyUkdCIFhZWiAH4AABAAEAAAAAAABhY3NwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAA9tYAAQAAAADTLQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAlkZXNjAAAA8AAAACRyWFlaAAABFAAAABRnWFlaAAABKAAAABRiWFlaAAABPAAAABR3dHB0AAABUAAAABRyVFJDAAABZAAAAChnVFJDAAABZAAAAChiVFJDAAABZAAAAChjcHJ0AAABjAAAADxtbHVjAAAAAAAAAAEAAAAMZW5VUwAAAAgAAAAcAHMAUgBHAEJYWVogAAAAAAAAb6IAADj1AAADkFhZWiAAAAAAAABimQAAt4UAABjaWFlaIAAAAAAAACSgAAAPhAAAts9YWVogAAAAAAAA9tYAAQAAAADTLXBhcmEAAAAAAAQAAAACZmYAAPKnAAANWQAAE9AAAApbAAAAAAAAAABtbHVjAAAAAAAAAAEAAAAMZW5VUwAAACAAAAAcAEcAbwBvAGcAbABlACAASQBuAGMALgAgADIAMAAxADb/2wBDABALDA4MChAODQ4SERATGCgaGBYWGDEjJR0oOjM9PDkzODdASFxOQERXRTc4UG1RV19iZ2hnPk1xeXBkeFxlZ2P/2wBDARESEhgVGC8aGi9jQjhCY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2P/wAARCADwAUADASIAAhEBAxEB/8QAGwAAAgMBAQEAAAAAAAAAAAAAAQIAAwQFBgf/xAA7EAABBAAFAgQDBwMDAwUAAAABAAIDEQQSITFRBUETImFxFFKRBjJCgaGxwSOS0RUzYnLh8ENEU1Tx/8QAGAEBAQEBAQAAAAAAAAAAAAAAAAECAwT/xAAeEQEBAQADAQADAQAAAAAAAAAAARECEiFBEyIxYf/aAAwDAQACEQMRAD8A6/maiC6tkx1StOU0fyWUS3cIWflTqaJqkzH5SgXH5SrFE0V5vQqZwOxT0omoTO1QvampSk0VlwLgQmzjuUXCwi3UJoGccohw5TUFMo4CaiZhyiHDlDI3gfREMb8o+iaGBCII5CAY3gI5RwmhrCIq0uVvCOQK6iO2ThJlAcrMgQFEJcgRyBXQyBUyhDL7oooKFvugW+pTRFEtepUqhuVdEcaCA0CFWpXqU1RQS/mUCDyU1TIWl15QN8poYoJTfKGvKaouOhPCxPkBdmK1EGt1ilA1ATR0LSu1UtRYEa69O6ZIQdxui11hEMogooIooBaVzsp1QFRS1EQUrdHEJkrtHAoH7IoBFERFRQIGCIQCYICEQoEwCoG5T0g0eZWAKgUjSYBHKgSlKT5UCECFKUxCBCBClO9JnaJQgG2yBRKBRQKUlFKUUCUCVCUpVBtAlC0pd2CKLna6LJiIiCXA6LVsleA4EFBZaiTMeFMx4KyHSk0b7KZvQoZvQohwbRVYdRrsjnHB+igZ2opLk812a4u1M49fojnHKAgUil8RvzBTO3kIhkCLCmdvIUzN5CIZhsJlU0gEi1YCOUDKBAEchEEIGCYJQQnCBgEwCDVa0KgMGpVzWpoYr7LQ2HlUZwxNkK1CMBHIEMYyxKWaraYwlMSDC5tKshbJISBss0gpFUO1PogU5FBIUQhSlMUhRQKUlE6JSUUCUpKJKQm9AioT2CGymyFqgkoWggSgsv0UtNSlLIFhS0cqOVQIaIUaexT5VA1EBRNSlIgaKIhvoplUEUoeiBahRVRHAAg6J6HASZbRohA+UcBENHASgFNRQMGt4CYMb8o+iEbTms3Svy0gDWDgLTFGD2VLQtUAshVGyJoawUEyiK02iiiiCKKKIAsGIYM5rZbzssUx1USsbgq3D3Vz1S5EVkep+qQj1KsKQopCPU/VIR6lOUh10QIRZ0JQLfVWIFGlZb6lKW/8iE5CCoUg8lCjyUSECUGhBFAiwsg2oqjbdwgHIL7UtZJJJWHyRZx/1Uk8efvhb9pB/hMRvBRtYBPN/wDWd/eEfiJB/wC3k/uCmI3Wjaw/Ev8A/gl+oRbinWAYZQOaCYNylKqzyiCeSiLKRpKw3unCCAI0oEQgtZ/tk8OH8pyqgf6bh6g/v/lHTkqi1u60wEZm+6xivX6qxjqcACfqqjrIrOyfQAqwStVa1YolzjlTMOUNMolzDlI6UbBDRlfQpYZXWrJHk91nf7lEVuKrKZ18lVn3QApCifcpDr3UUDqhsoQeSlN8lBEpUIPKXXlFRAqH3S6nvoqqEoVypl9SgQfmKDQooooIRYpVOYQ6wTSuUURTuKVL3PafRanM7hVkA6HdBR4r+UfGco+Mt9ktIG8Z6njvHCXKhSqNEU5doRqrJHua0ObVdyRssgsEELVG4PbR2O6lgmHlLrDwA9pogLWNlziTDNfYUHe3Y/wtzHaIh0UEUDX5Xeo/lQFKToVG6jdUWgotPn/JVAH5iqnYqNhIzkkfLSDoNerBIeVyBji51N0Hrur2Ys6WL9VcR0hIj4qxMmDx5X7bpw49nINRloIF+izBxJu9kxca3VDudarcUCTylJPKAOVZTOvlIbPdFIdUCib5Sm+QooFKibvf9EpvkIAUhOqY2lojuihXKBKmvKU3aKJS2oSeUuqDSEdFWHhMCFA6gQtEIA5xHZEDNrVJqtO0Aboyr8O1PAF2tseGc8ZoxmHotDcA8jb6pia5fw49Poj8OPT6LqfAycD6o/AycJg5XgD0U8GjuK9l0n4KQaht+yofEW7iimDL4agZRu1cQlpMQFFDsiNQgiAIARWbHz+BBofM7QIrLi8Y6RxZG6o+55WTOB3VL3lzdFUL5WhuY/ghXskdz+q5jXH1VglLdrVxHR8cjXY8p2Yx5OrlzfHJ3TtlFpg7keKboHGlpDgRYOi4LHkx32BXTwEhcwsJstTBrscqGlYyMu2CsGGkd+E/mFcVkIvdAhbvhH/KgcG8/hQYCEhC3SYR7BZCzuhd3FKYrI5wCXMO6ukjs6KoxHlQKXikhcOUXsy7lJWiigXBDMECByh+aKNgFKXIEhISg5Ac7lO2R4Ojj9U2RGNllTVaoMe5tCSyOe66EU7ZBbXArkGOlt6aymvPsqjotcrAVUEwKiNmExDoH2Nu45XailbKzMw2P2Xm2uV8OIfE62OpVHfUXKkxvjRixleO47qn4t+xcUw121lxzGeH4hoEfquccU/5iq3zOduiaj3tSFzVcMJiHRh4ZYOo1GyqdBM3dn6hVCl7UGuFkIFj71akJpw0UF2Zq5XWSTJHW1FdDMs2OiE0BvdlkUkHHtobylzj0SSmtAVXleQHUQPVUag+hqFDJ6LOA7dWNDjuLVFgfe6NUdEA08UrGZO5cfYoYaOZzdOy6nSyJMR5vlP7hc5ggMjWuEgBNWHD/C6mChELnPFkEDLe9LUV6WCFsTBQF9yrVx2Yp7dA4ge6f4147n6rOLrqqLmR4qSRwzPLW99VokxzQCGD8ynU1olkbE23H8uVy8RMZXknQdghLMXm3G1nc+9lZMUXEBUucDtqmyOeVczDE7ojDNYAPK5+Le+Oi1xAK7eNgywXWxXIxDLLSRe6zfGowfES93KfESditJY35Qh4TflH0Wey4yuxMnIQdiZRwVpMTPkH0QMLD+EfROxivKnibuiVGvyOawMLnvNABSKYsWvBgNi17mws5NHK4FruHCitcLT4bf0VZXWpaWiiGOJAAJJU1DZkQ5I5j2HzAg+qXVXUXB9IiSlRqjqmpi4zV2CV2IoWG37KtFkJkNNBJ4CaY6sfWMO3DsYWSZmtANAce6ok6nA7Zkn0H+Ug6TORYYdeSAkd0vEj/wBI/UKpYLsbDVkOA9lQ2YOF6KuSBzCWPBB2IKVrMoobIY0eJ6BVyOBJvYhILUdsTwiuGYwMUWEZqJHumkaQwto6FGPSRjnOJceVvDI3xnNoUtaxz2Bo0c76KN+8rHwgONJCcu9ADlNOq1o8ubskqnXSsGJYIyBq0oxSMcNrHqmrgsaXOuqXVgkLomm9diueZKHlqvZa8IDJEa2DqVlSzGgynYFMy9yUuQNQJ4WmV/i0EpmJ2VNElWsagsaI3N80wD/ldoPqnYGNaXyODWje+yw4vDv8QSMPlO4PKxSFz2eG4uGtAnspuVuTY9RhWxTszREObyFqEFLznTeqxdNwzovBlkeTZJoBdrpHUh1GBzy0Mc11Ft2rd+M4HUIrwsmna/1Xnp222+CvW4pmfDyDlp/ZeWmbbHLFrUZKQpMgubQUgUxQpFUlLFbuoQNAJIBOgur0tYPjZfT81bh8e+KYyhoDizJe9BdJxsZ2OrNK/wAExufnaSKLtStjHEMArYLitx7fBDHanNdncen7IjqMu3iJZankdvxBWrdVfhMYcM4vEQdellY+kdVw2HEjsUQ95rLpsm6n1duODGxOijDCd3E3+izg0YzHvxTwXMDQ0aUs2YcLE0yOdXxcH5ur+Fsi6djJW5mPhe3lr7SoOZqmdqtZ0jFucA4xgdzmQxnRZjIBhcQ2QAU43VH9VEV52p45gx4c00RqCqf9D6iPxs/vP+E8fRMcLzPj9PMf8KnjtR9ahyf1GuDv+OoWWbG4J7i578TrxSx/6NjPnj/uP+Fy8TL4Mjo8wc5pq2nRWVHVlxGCzAxmf1zNCV+JwpFt8QD1AC43izHUGkPiJR94A36KpjrGSPsSldKBsVzRi2ndpHsU4njd+L6pis80WRznN0a06J2yZgFXjZsrAGOBDtws8UhqipjWtrpBSokbm1JQDrFpB53auyjlJGtTbYBWseAK2SmOICg6/VVuDRo0krQ1eJpuut0iT+g8ZbJef2C4APl1Xqfs1APhGzSaNc4kft/Cs8ZqyaGQRGQt4oKmJpMdneyP1XdxXhy4Z7BuRpoubHhpAwhwANnumxGUEDtqrYhoFDhZbPl091bFE5rRmFJsRbGwPaWuFg7rBN03EMn8SJpmjO7a1r+V0oyG7rVFPG3dwV2KxYKGWCCRzmljCDTXbrm9Be7DdQmw5O4v6H/uu9iJo3x014PoskcUDJjKGtDjua3SUdWw5vuvLzMouae1hegZiYts405XGxTC7EyFgsFxIIWKscqlKV7sPJZ8jt+EGwuDgXsfl70FiuhWQFzcznBjOSm8XCxbMMjuXHT6I4qR8oyxEZa0B7LL8FLu5rz7NUbyR50O1spg/tf5qvOK0KW/Veh5WlrxSJcFma7VNZGqLK1Rh0l5e2qsLow0EXmHYrPh5HgODFa17PAcCLes0WkAG3DKCNKW7o2KdhsfE+/6bzld7Fc5xczIX6+iLH3OHAVrsor6J2WbB4d8JkL3A53l36rQDoi1cQxUUJQtEYus4o4Tp8jmmnu8jfc/9rXj2NMhLjzS7P2sxNPghH4QXn89B+xXKw2kABG4/wDP4XTjPBW4EJMxtXSDjVVahaMMNeyIaw7tQa4A6kK5oY4E3+XdFZcVA10ZLNx2WUhzGtJBF8rqPhOUk20VeoWFhE7HtJpzXae1JpipspqkASTSpeHRupyLJNf5TBoDNNXIu8oFFUCUqZ7KY1qzMSaC3QSzsADHObXBpY8OzM8u41pdCEZznB1VqNWG6vicO4CRznt7hxtd/BYyPGRlzNHDdt7LykjvFflOhVvT8WcDi8zrLRYcB3WbNR60pXGguM/r7dckP1Kyzdcke0tLGgEV3WcqtnUOrNhbUHmdyRoFyh1HEvOfx5AeL0+izy4pjySYm37n/Kq+IZX+21dJEdvB9at2TEgf9bf5C6zJGyNDmODmnYgrxnjtBvwxasw/UpcK4mLy3v3tS8R6jGNkdGDFeYEK4HReaH2hxF6hh9wr4vtF2lhaRy00plV3e6WRwEbiRoAqMLjYcY0uidqNwdwhj5MuFdR1OiixyXSkd16TpPVYZsEGyECSMZXX3XlXAVra04LDSTYVxjIHnO6xZrrf9eVzN/Df5otN6pL5ThwDrrThemvOYmijnLhR1S202Qa9FLrXRQasNiBCHAtu1ZC1sgkJ33CysDizQWOVpkezw2ujNOGhClXBjlL5GF+oGi34drJ+pYaJo3eL9r//AFc8ERwuY8U46grp/Ztl9WjLtaaT+hWaR7UHRFpS3oiCuIclC0jnBoJJAA3JXFx/XmNBjwpt3d5Gg9lZNHM+0QM/VpATTWho/RZDPkY1jeypmxDpJS5ziSdSTuVn8S32usnia1umKQyG1nMlvUz0gsMhvX6qyOfK4OBuln8QbJHvAHlQdrxWSgEOtpFGt1zsRGcM+KUDRwLX+9/4pZGTPY7M00tDsWyeHw5gW62CNrWeuNy6aVgkbdLE6MtOi3xEZA3hK+O03FzWHXlM1O6BwcoxlFanJOroYLDvdBJKBbWVaewPu6FaejYyKAOimsAuBurGyzT5GTSBhtmYhp9Oym+liAtB8+/KpyOJJzApDIYzT9Wq0FuWwtIAytbcgcT6bLO6RpPlJWkPF1sUHtjdq5oJ5RGRziFU6WjSukgI8zHWOFmkIvdagLpUpl0VR1QsqjZBCZmEhwFK74Q5fv69uFR099SObehC6GbSlmrE+z0rh1EMs6tIK63UpS54jbsN1w+j4mODHvllNNANUO9rrmdskheNLWObXH+scjXusBp91u6fj4YYGwva5rmb8FVPc1c7G0Gkg0sR1yVxnBw/DQvT1SbE6py8u77BI11XYBXoefB7a0mF5bSvIO3ZFptwBukTG3CziMZZG7pA0SYghpoHZWYxrPCzNWZltYHjfssq053B/nGYR6LpfZ+YM6tD/wAiW/ULjskvNmP3u3K04WcMxsL2W2ng2OylhH0WxWiIWWGUvHmOyyda6l8HB4cbv6zxoflHK4z1WH7Q9VvNhcO7Rp855PC8545Oj0Jn24m9VRI7M1dZMZtPJJlBrVUMkc5++irLzSkRt5HotGLmyEvKbMeVQ37ysRDZuyJd5SkOqJ/RRQz9ihm7FANQLdFVboHmSPfUaWqnYmVhLSdQruiRxzY0QykgPFAg1r2V/WumNw7WTx5y0uLHB24Pb/z0WfNyrNjn/GSk6kH8lBLI/Y0qi2wKVjfKKB1O61kO1b8E22EnXVNKae5q09N6dipcIZ4YzI0Oo5d9h2WXENLZnAgg9wVPoAdmbRVRcYXWNWHf0TWQlcbsHZVDuNixrwUhkNd9FUx5if4bvunZM40VRYHkG7STxiRpc0+bf3VZcdkQ8hhHdBid67qa/krZmhwzAebuqLI7qmLsK/LO1x07LZicRkb5dzouWSS70CtdL4jm+imK39MmbBM5z4WSXVXu32XQbN/UOlArgQuJmDR3cAF3HZS/1C582uC9xvUFYsX90k1S3RQPmFM25V/+nsDfMcx5K566x5ABB2m6dzgQaB43Vfal6HDBBHbdNYsUkG3qiLv0SpIvMpdHlUD/AOllKsc2OKEA2XHZK6NrIQdcx2UWqxqQro7DgkY7K7NXalcJTIGxhutAWiSPfS4zD9N6eJjUk0jfK07arxeJxLpZC97rJT4zGPnbGHEVGwMbXosTnLM44tSaQHXZUOeMhUkIJKqefIe61jPhXn1Rw7rc4qpxpWYf7rj6qri0aFWAqturtVaoiblMVANPdEjZFwoChFlPQpL3VQY3mGRr2XmaQ4H1C9XicVg+p9MkHitbJIzNlcKpw13915SSMsdlc0gjcFW4SQlxhvcWFm8dalU1RtFg86kzTHIQUIt77rSPd/Z1uXobKJGaVzgf0XE+03l6vLfytv8AtCXpXUcRhYg2GYtHG4+izdWxT8VjHyyVmIF0PRc5P21rfGQ+hS32OiI12QcDutsqpacyu42SMlzNo7hWOGqzuGR9gadwtQW5jWiUOu9ULSvdQQO1w7qiWPKSWnRMHAb6qyOXI9rt/QhDGRrh31WmOJphdIBQ2T4qR8xDYwPN+ELQBFF4OGeQ4A29RYWLBEYlsjS0Rt1rMug0ZjaTFuwcLGfD20k6jM4/upFLbQRra5cq6cfGuGZ0Jq9Fo+KB+8Vgc+20s7y9v3duCubo4Q39FBWptS9VK4XqecwOijTqktM2q7IHL73N0jnJ3SA2bOygq7URbG8ZtfotcQ8NtuHnKow0QcfEOw0F91oe690Ae4d1U92lAqOeDYP1VLz9VBHHt3VchptWiS1zhe4VUruysQriFfEKYOVm3oLTdVSVVzW0E2lqrMQ31KsjFqIsB0UzJTwiG82qrRhcO/EyZIhbiCVXQw+JqWPNlNFpUhldBIHsJa4GwllL5Xl7iXOPcouOv1KbDy4RuTKJS1pqrOXi/ouL4nhubI0WWm6UbFJI4BjXOPAFq+PpuKeD/TrT8RASTCtroYcZHnc/w6ZmDqv8lzaykgGwO/K0YMywSPw+IbRNka7jYhUcgD6pBvwTc0IJ5VWKNTkHgI4ZxZhGkdyT+qplnMjtSSBsp9BDgES76K6TAOj6eMUHggkeWtQsocB7Kod2uqzyjTQK0uFgpXURaQtZmmrB3VUsmmpVrjTqWWX753VFsLs7CL1CtY3Ks0Jyu3WootWRzeEx1NBdyqoT404zEhx7pXaB1XsqYHVOHE97UI1dQDmxsPYHdTCdQ8OhJoNiQFtdG2WMtdRaVzcTg5ICXAZo+RuPdYln8rfzXYbiI5W2xwNoPcK312Xnw8g2DRVrZ5PnOqfjWc3/2Q=='),
(25, 5, '2026-02-06 18:33:27.905', 'MULTIPLE_FACES', 'Multiple people detected. Only one person allowed.', 'data:image/jpeg;base64,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');
INSERT INTO `violation_logs` (`id`, `session_id`, `occurred_at`, `type`, `description`, `snapshot_base64`) VALUES
(26, 5, '2026-02-06 18:33:33.771', 'AUDIO_DETECTED', 'High noise detected. Please remain quiet.', 'data:image/jpeg;base64,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'),
(27, 5, '2026-02-06 18:34:01.004', 'AUDIO_DETECTED', 'High noise detected. Please remain quiet.', 'data:image/jpeg;base64,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'),
(28, 5, '2026-02-06 18:34:05.812', 'AUDIO_DETECTED', 'High noise detected. Please remain quiet.', 'data:image/jpeg;base64,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'),
(29, 5, '2026-02-06 18:34:12.757', 'AUDIO_DETECTED', 'High noise detected. Please remain quiet.', NULL),
(30, 5, '2026-02-06 18:34:25.006', 'AUDIO_DETECTED', 'High noise detected. Please remain quiet.', NULL),
(31, 5, '2026-02-06 18:34:31.714', 'AUDIO_DETECTED', 'High noise detected. Please remain quiet.', NULL),
(32, 5, '2026-02-06 18:35:00.644', 'AUDIO_DETECTED', 'High noise detected. Please remain quiet.', NULL),
(33, 5, '2026-02-06 18:35:05.179', 'AUDIO_DETECTED', 'High noise detected. Please remain quiet.', NULL),
(34, 5, '2026-02-06 18:35:10.477', 'AUDIO_DETECTED', 'High noise detected. Please remain quiet.', NULL),
(35, 5, '2026-02-06 18:35:19.123', 'AUDIO_DETECTED', 'High noise detected. Please remain quiet.', NULL),
(36, 5, '2026-02-06 18:35:24.954', 'AUDIO_DETECTED', 'High noise detected. Please remain quiet.', NULL),
(37, 5, '2026-02-06 18:35:30.780', 'AUDIO_DETECTED', 'High noise detected. Please remain quiet.', NULL),
(38, 5, '2026-02-06 18:35:34.783', 'AUDIO_DETECTED', 'High noise detected. Please remain quiet.', NULL),
(39, 5, '2026-02-06 18:35:39.234', 'AUDIO_DETECTED', 'High noise detected. Please remain quiet.', NULL),
(40, 5, '2026-02-06 18:35:44.164', 'AUDIO_DETECTED', 'High noise detected. Please remain quiet.', NULL),
(41, 5, '2026-02-06 18:35:55.235', 'AUDIO_DETECTED', 'High noise detected. Please remain quiet.', NULL),
(42, 5, '2026-02-06 18:36:03.975', 'AUDIO_DETECTED', 'High noise detected. Please remain quiet.', NULL),
(43, 5, '2026-02-06 18:36:08.511', 'AUDIO_DETECTED', 'High noise detected. Please remain quiet.', NULL),
(44, 5, '2026-02-06 18:36:14.916', 'AUDIO_DETECTED', 'High noise detected. Please remain quiet.', NULL),
(45, 5, '2026-02-06 18:36:21.942', 'AUDIO_DETECTED', 'High noise detected. Please remain quiet.', NULL),
(46, 5, '2026-02-06 18:36:28.804', 'AUDIO_DETECTED', 'High noise detected. Please remain quiet.', NULL),
(47, 5, '2026-02-06 18:36:33.700', 'AUDIO_DETECTED', 'High noise detected. Please remain quiet.', NULL),
(48, 5, '2026-02-06 18:36:38.664', 'AUDIO_DETECTED', 'High noise detected. Please remain quiet.', NULL),
(49, 5, '2026-02-06 18:36:45.192', 'AUDIO_DETECTED', 'High noise detected. Please remain quiet.', NULL),
(50, 5, '2026-02-06 18:36:50.764', 'AUDIO_DETECTED', 'High noise detected. Please remain quiet.', NULL),
(51, 5, '2026-02-06 18:36:59.332', 'AUDIO_DETECTED', 'High noise detected. Please remain quiet.', NULL),
(52, 5, '2026-02-06 18:37:11.713', 'AUDIO_DETECTED', 'High noise detected. Please remain quiet.', NULL),
(53, 5, '2026-02-06 18:37:16.401', 'AUDIO_DETECTED', 'High noise detected. Please remain quiet.', NULL),
(54, 5, '2026-02-06 18:37:20.199', 'AUDIO_DETECTED', 'High noise detected. Please remain quiet.', NULL),
(55, 5, '2026-02-06 18:37:27.140', 'AUDIO_DETECTED', 'High noise detected. Please remain quiet.', NULL),
(56, 5, '2026-02-06 18:37:33.411', 'AUDIO_DETECTED', 'High noise detected. Please remain quiet.', NULL),
(57, 5, '2026-02-06 18:37:39.838', 'AUDIO_DETECTED', 'High noise detected. Please remain quiet.', NULL),
(58, 5, '2026-02-06 18:37:44.164', 'AUDIO_DETECTED', 'High noise detected. Please remain quiet.', NULL),
(59, 5, '2026-02-06 18:37:51.977', 'AUDIO_DETECTED', 'High noise detected. Please remain quiet.', NULL),
(60, 5, '2026-02-06 18:37:57.860', 'AUDIO_DETECTED', 'High noise detected. Please remain quiet.', NULL),
(61, 5, '2026-02-06 18:38:02.415', 'AUDIO_DETECTED', 'High noise detected. Please remain quiet.', NULL),
(62, 5, '2026-02-06 18:38:08.236', 'AUDIO_DETECTED', 'High noise detected. Please remain quiet.', NULL),
(63, 5, '2026-02-06 18:38:15.338', 'AUDIO_DETECTED', 'High noise detected. Please remain quiet.', NULL),
(64, 5, '2026-02-06 18:38:24.609', 'AUDIO_DETECTED', 'High noise detected. Please remain quiet.', NULL),
(65, 5, '2026-02-06 18:38:30.373', 'AUDIO_DETECTED', 'High noise detected. Please remain quiet.', NULL),
(66, 5, '2026-02-06 18:38:42.366', 'AUDIO_DETECTED', 'High noise detected. Please remain quiet.', NULL),
(67, 5, '2026-02-06 18:38:51.304', 'AUDIO_DETECTED', 'High noise detected. Please remain quiet.', NULL),
(68, 5, '2026-02-06 18:38:57.932', 'AUDIO_DETECTED', 'High noise detected. Please remain quiet.', NULL),
(69, 5, '2026-02-06 18:39:01.990', 'AUDIO_DETECTED', 'High noise detected. Please remain quiet.', NULL),
(70, 5, '2026-02-06 18:39:08.787', 'AUDIO_DETECTED', 'High noise detected. Please remain quiet.', NULL);

-- --------------------------------------------------------

--
-- Table structure for table `violation_reviews`
--

CREATE TABLE `violation_reviews` (
  `violation_id` bigint(20) UNSIGNED NOT NULL,
  `decision` enum('CLEARED','CONFIRMED','ESCALATED') NOT NULL,
  `reviewer` varchar(128) DEFAULT NULL,
  `note` text DEFAULT NULL,
  `reviewed_at` datetime(3) NOT NULL DEFAULT current_timestamp(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

--
-- Indexes for dumped tables
--

--
-- Indexes for table `audit_logs`
--
ALTER TABLE `audit_logs`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_audit_actor` (`actor_role`,`actor_id`),
  ADD KEY `idx_audit_action` (`action`),
  ADD KEY `idx_audit_target` (`target_type`,`target_id`),
  ADD KEY `idx_audit_created` (`created_at`);

--
-- Indexes for table `delivery_logs`
--
ALTER TABLE `delivery_logs`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_delivery_channel` (`channel`),
  ADD KEY `idx_delivery_status` (`status`),
  ADD KEY `idx_delivery_created` (`created_at`),
  ADD KEY `fk_delivery_template` (`template_id`);

--
-- Indexes for table `exams`
--
ALTER TABLE `exams`
  ADD PRIMARY KEY (`id`);

--
-- Indexes for table `exam_access_logs`
--
ALTER TABLE `exam_access_logs`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_exam_access` (`exam_id`,`student_id`);

--
-- Indexes for table `exam_assignments`
--
ALTER TABLE `exam_assignments`
  ADD PRIMARY KEY (`exam_id`,`student_id`),
  ADD KEY `fk_exam_assignments_student` (`student_id`);

--
-- Indexes for table `exam_batch_assignments`
--
ALTER TABLE `exam_batch_assignments`
  ADD PRIMARY KEY (`exam_id`,`batch_id`),
  ADD KEY `idx_exam_batch_assignments_batch` (`batch_id`);

--
-- Indexes for table `exam_questions`
--
ALTER TABLE `exam_questions`
  ADD PRIMARY KEY (`exam_id`,`question_id`),
  ADD KEY `idx_exam_questions_question` (`question_id`);

--
-- Indexes for table `exam_sections`
--
ALTER TABLE `exam_sections`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_exam_sections_exam` (`exam_id`);

--
-- Indexes for table `exam_section_questions`
--
ALTER TABLE `exam_section_questions`
  ADD PRIMARY KEY (`section_id`,`question_id`),
  ADD KEY `idx_section_questions_question` (`question_id`);

--
-- Indexes for table `exam_sessions`
--
ALTER TABLE `exam_sessions`
  ADD PRIMARY KEY (`id`),
  ADD KEY `fk_sessions_student` (`student_id`),
  ADD KEY `idx_sessions_exam_student` (`exam_id`,`student_id`);

--
-- Indexes for table `notification_templates`
--
ALTER TABLE `notification_templates`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_template_channel` (`channel`);

--
-- Indexes for table `questions`
--
ALTER TABLE `questions`
  ADD PRIMARY KEY (`id`);

--
-- Indexes for table `result_audit_logs`
--
ALTER TABLE `result_audit_logs`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_result_audit_session` (`session_id`),
  ADD KEY `fk_result_audit_question` (`question_id`);

--
-- Indexes for table `session_answers`
--
ALTER TABLE `session_answers`
  ADD PRIMARY KEY (`session_id`,`question_id`),
  ADD KEY `fk_session_answers_question` (`question_id`);

--
-- Indexes for table `session_question_times`
--
ALTER TABLE `session_question_times`
  ADD PRIMARY KEY (`session_id`,`question_id`),
  ADD KEY `fk_sqt_question` (`question_id`);

--
-- Indexes for table `students`
--
ALTER TABLE `students`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `email` (`email`),
  ADD UNIQUE KEY `registration_id` (`registration_id`);

--
-- Indexes for table `violation_logs`
--
ALTER TABLE `violation_logs`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_violation_session` (`session_id`);

--
-- Indexes for table `violation_reviews`
--
ALTER TABLE `violation_reviews`
  ADD PRIMARY KEY (`violation_id`);

--
-- AUTO_INCREMENT for dumped tables
--

--
-- AUTO_INCREMENT for table `audit_logs`
--
ALTER TABLE `audit_logs`
  MODIFY `id` bigint(20) UNSIGNED NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `delivery_logs`
--
ALTER TABLE `delivery_logs`
  MODIFY `id` bigint(20) UNSIGNED NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `exam_access_logs`
--
ALTER TABLE `exam_access_logs`
  MODIFY `id` bigint(20) UNSIGNED NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=13;

--
-- AUTO_INCREMENT for table `exam_sessions`
--
ALTER TABLE `exam_sessions`
  MODIFY `id` bigint(20) UNSIGNED NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=6;

--
-- AUTO_INCREMENT for table `notification_templates`
--
ALTER TABLE `notification_templates`
  MODIFY `id` bigint(20) UNSIGNED NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `result_audit_logs`
--
ALTER TABLE `result_audit_logs`
  MODIFY `id` bigint(20) UNSIGNED NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `violation_logs`
--
ALTER TABLE `violation_logs`
  MODIFY `id` bigint(20) UNSIGNED NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=71;

--
-- Constraints for dumped tables
--

--
-- Constraints for table `delivery_logs`
--
ALTER TABLE `delivery_logs`
  ADD CONSTRAINT `fk_delivery_template` FOREIGN KEY (`template_id`) REFERENCES `notification_templates` (`id`) ON DELETE SET NULL;

--
-- Constraints for table `exam_assignments`
--
ALTER TABLE `exam_assignments`
  ADD CONSTRAINT `fk_exam_assignments_exam` FOREIGN KEY (`exam_id`) REFERENCES `exams` (`id`) ON DELETE CASCADE,
  ADD CONSTRAINT `fk_exam_assignments_student` FOREIGN KEY (`student_id`) REFERENCES `students` (`id`) ON DELETE CASCADE;

--
-- Constraints for table `exam_questions`
--
ALTER TABLE `exam_questions`
  ADD CONSTRAINT `fk_exam_questions_exam` FOREIGN KEY (`exam_id`) REFERENCES `exams` (`id`) ON DELETE CASCADE,
  ADD CONSTRAINT `fk_exam_questions_question` FOREIGN KEY (`question_id`) REFERENCES `questions` (`id`) ON DELETE CASCADE;

--
-- Constraints for table `exam_sections`
--
ALTER TABLE `exam_sections`
  ADD CONSTRAINT `fk_exam_sections_exam` FOREIGN KEY (`exam_id`) REFERENCES `exams` (`id`) ON DELETE CASCADE;

--
-- Constraints for table `exam_section_questions`
--
ALTER TABLE `exam_section_questions`
  ADD CONSTRAINT `fk_section_questions_question` FOREIGN KEY (`question_id`) REFERENCES `questions` (`id`) ON DELETE CASCADE,
  ADD CONSTRAINT `fk_section_questions_section` FOREIGN KEY (`section_id`) REFERENCES `exam_sections` (`id`) ON DELETE CASCADE;

--
-- Constraints for table `exam_sessions`
--
ALTER TABLE `exam_sessions`
  ADD CONSTRAINT `fk_sessions_exam` FOREIGN KEY (`exam_id`) REFERENCES `exams` (`id`) ON DELETE CASCADE,
  ADD CONSTRAINT `fk_sessions_student` FOREIGN KEY (`student_id`) REFERENCES `students` (`id`) ON DELETE CASCADE;

--
-- Constraints for table `result_audit_logs`
--
ALTER TABLE `result_audit_logs`
  ADD CONSTRAINT `fk_result_audit_question` FOREIGN KEY (`question_id`) REFERENCES `questions` (`id`) ON DELETE SET NULL,
  ADD CONSTRAINT `fk_result_audit_session` FOREIGN KEY (`session_id`) REFERENCES `exam_sessions` (`id`) ON DELETE CASCADE;

--
-- Constraints for table `session_answers`
--
ALTER TABLE `session_answers`
  ADD CONSTRAINT `fk_session_answers_question` FOREIGN KEY (`question_id`) REFERENCES `questions` (`id`) ON DELETE CASCADE,
  ADD CONSTRAINT `fk_session_answers_session` FOREIGN KEY (`session_id`) REFERENCES `exam_sessions` (`id`) ON DELETE CASCADE;

--
-- Constraints for table `session_question_times`
--
ALTER TABLE `session_question_times`
  ADD CONSTRAINT `fk_sqt_question` FOREIGN KEY (`question_id`) REFERENCES `questions` (`id`) ON DELETE CASCADE,
  ADD CONSTRAINT `fk_sqt_session` FOREIGN KEY (`session_id`) REFERENCES `exam_sessions` (`id`) ON DELETE CASCADE;

--
-- Constraints for table `violation_logs`
--
ALTER TABLE `violation_logs`
  ADD CONSTRAINT `fk_violation_session` FOREIGN KEY (`session_id`) REFERENCES `exam_sessions` (`id`) ON DELETE CASCADE;

--
-- Constraints for table `violation_reviews`
--
ALTER TABLE `violation_reviews`
  ADD CONSTRAINT `fk_violation_review` FOREIGN KEY (`violation_id`) REFERENCES `violation_logs` (`id`) ON DELETE CASCADE;
COMMIT;

/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;
/*!40101 SET CHARACTER_SET_RESULTS=@OLD_CHARACTER_SET_RESULTS */;
/*!40101 SET COLLATION_CONNECTION=@OLD_COLLATION_CONNECTION */;
