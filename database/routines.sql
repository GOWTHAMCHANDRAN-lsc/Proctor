-- ProctorGuard stored procedures (37). Called by api/*.php (sp_log_access, sp_add_delivery_log, sp_reset_mac_binding, ...).
-- Import AFTER schema.sql. DEFINER stripped so they are owned by the importing user.

DELIMITER $$
--
-- Procedures
--

-- Batch Management Procedures
CREATE PROCEDURE `sp_create_batch` (IN `p_company_id` INT, IN `p_name` VARCHAR(255), IN `p_description` TEXT)   BEGIN
  INSERT INTO batches (company_id, name, description)
  VALUES (p_company_id, p_name, p_description);
  
  SELECT id, company_id, name, description, created_at
  FROM batches
  WHERE id = LAST_INSERT_ID() AND company_id = p_company_id
  LIMIT 1;
END$$

CREATE PROCEDURE `sp_list_batches` (IN `p_company_id` INT)   BEGIN
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

CREATE PROCEDURE `sp_update_batch` (IN `p_company_id` INT, IN `p_id` BIGINT, IN `p_name` VARCHAR(255), IN `p_description` TEXT)   BEGIN
  UPDATE batches
  SET name = p_name, description = p_description
  WHERE id = p_id AND company_id = p_company_id;
  
  SELECT id, company_id, name, description, created_at
  FROM batches
  WHERE id = p_id AND company_id = p_company_id
  LIMIT 1;
END$$

CREATE PROCEDURE `sp_delete_batch` (IN `p_company_id` INT, IN `p_id` BIGINT)   BEGIN
  -- First, unassign all students from this batch
  UPDATE students SET batch_id = NULL WHERE batch_id = p_id AND company_id = p_company_id;
  
  -- Then delete the batch
  DELETE FROM batches WHERE id = p_id AND company_id = p_company_id;
END$$

CREATE PROCEDURE `sp_bulk_import_students` (IN `p_company_id` INT, IN `p_batch_id` BIGINT, IN `p_students_json` JSON)   BEGIN
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

CREATE PROCEDURE `sp_add_audit` (IN `p_company_id` INT, IN `p_actor_role` ENUM('ADMIN','PROCTOR','STUDENT','SYSTEM'), IN `p_actor_id` VARCHAR(64), IN `p_action` VARCHAR(64), IN `p_target_type` VARCHAR(64), IN `p_target_id` VARCHAR(64), IN `p_message` TEXT, IN `p_metadata` JSON, IN `p_ip_address` VARCHAR(64), IN `p_user_agent` VARCHAR(512))   BEGIN
  INSERT INTO audit_logs (company_id, actor_role, actor_id, action, target_type, target_id, message, metadata, ip_address, user_agent)
  VALUES (p_company_id, p_actor_role, p_actor_id, p_action, p_target_type, p_target_id, p_message, p_metadata, p_ip_address, p_user_agent);
END$$

CREATE PROCEDURE `sp_add_delivery_log` (IN `p_company_id` INT, IN `p_channel` ENUM('EMAIL','SMS'), IN `p_recipient` VARCHAR(255), IN `p_subject` VARCHAR(255), IN `p_body` TEXT, IN `p_status` ENUM('SENT','FAILED','SKIPPED'), IN `p_error` TEXT, IN `p_template_id` BIGINT, IN `p_metadata` JSON)   BEGIN
  INSERT INTO delivery_logs (company_id, channel, recipient, subject, body, status, error, template_id, metadata)
  VALUES (p_company_id, p_channel, p_recipient, p_subject, p_body, p_status, p_error, p_template_id, p_metadata);
END$$

CREATE PROCEDURE `sp_add_violation` (IN `p_company_id` INT, IN `p_exam_id` VARCHAR(64), IN `p_student_id` VARCHAR(64), IN `p_type` ENUM('TAB_SWITCH','NO_FACE','MULTIPLE_FACES','GAZE_AWAY','AUDIO_DETECTED','FULLSCREEN_EXIT','COPY_PASTE','PHONE_DETECTED','ANOMALY_OBJECT','LOCATION_CHANGE'), IN `p_description` TEXT, IN `p_snapshot` LONGTEXT)   BEGIN
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

CREATE PROCEDURE `sp_assign_exam_student` (IN `p_exam_id` VARCHAR(64), IN `p_student_id` VARCHAR(64))   BEGIN
  INSERT IGNORE INTO exam_assignments (exam_id, student_id)
  VALUES (p_exam_id, p_student_id);
END$$

CREATE PROCEDURE `sp_clear_exam_assignments` (IN `p_exam_id` VARCHAR(64))   BEGIN
  DELETE FROM exam_assignments WHERE exam_id = p_exam_id;
END$$

CREATE PROCEDURE `sp_clear_exam_questions` (IN `p_exam_id` VARCHAR(64))   BEGIN
  DELETE FROM exam_questions WHERE exam_id = p_exam_id;
END$$

CREATE PROCEDURE `sp_clear_exam_sections` (IN `p_exam_id` VARCHAR(64))   BEGIN
  DELETE FROM exam_sections WHERE exam_id = p_exam_id;
END$$

CREATE PROCEDURE `sp_complete_exam_session` (IN `p_company_id` INT, IN `p_exam_id` VARCHAR(64), IN `p_student_id` VARCHAR(64))   BEGIN
  UPDATE exam_sessions
  SET status = 'COMPLETED', end_time = NOW(3)
  WHERE company_id = p_company_id AND exam_id = p_exam_id AND student_id = p_student_id AND status = 'IN_PROGRESS';
END$$

CREATE PROCEDURE `sp_create_student` (IN `p_id` VARCHAR(64), IN `p_company_id` INT, IN `p_full_name` VARCHAR(255), IN `p_email` VARCHAR(255), IN `p_registration_id` VARCHAR(128))   BEGIN
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

CREATE PROCEDURE `sp_delete_template` (IN `p_company_id` INT, IN `p_id` BIGINT)   BEGIN
  DELETE FROM notification_templates WHERE company_id = p_company_id AND id = p_id;
END$$

CREATE PROCEDURE `sp_get_exam_session` (IN `p_company_id` INT, IN `p_exam_id` VARCHAR(64), IN `p_student_id` VARCHAR(64))   BEGIN
  SELECT id, status, ip_address, device_fingerprint, start_time
  FROM exam_sessions
  WHERE company_id = p_company_id AND exam_id = p_exam_id AND student_id = p_student_id
  ORDER BY start_time DESC
  LIMIT 1;
END$$

CREATE PROCEDURE `sp_link_exam_question` (IN `p_exam_id` VARCHAR(64), IN `p_question_id` VARCHAR(64), IN `p_display_order` INT)   BEGIN
  INSERT INTO exam_questions (exam_id, question_id, display_order)
  VALUES (p_exam_id, p_question_id, p_display_order);
END$$

CREATE PROCEDURE `sp_link_exam_section_question` (IN `p_section_id` VARCHAR(64), IN `p_question_id` VARCHAR(64), IN `p_display_order` INT)   BEGIN
  INSERT INTO exam_section_questions (section_id, question_id, display_order)
  VALUES (p_section_id, p_question_id, p_display_order);
END$$

CREATE PROCEDURE `sp_list_audits` (IN `p_company_id` INT, IN `p_actor_role` VARCHAR(16), IN `p_actor_id` VARCHAR(64), IN `p_action` VARCHAR(64), IN `p_target_type` VARCHAR(64), IN `p_target_id` VARCHAR(64), IN `p_limit` INT, IN `p_offset` INT)   BEGIN
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

CREATE PROCEDURE `sp_list_delivery_logs` (IN `p_company_id` INT, IN `p_channel` VARCHAR(16), IN `p_status` VARCHAR(16), IN `p_limit` INT, IN `p_offset` INT)   BEGIN
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

CREATE PROCEDURE `sp_list_exams` (IN `p_company_id` INT)   BEGIN
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

CREATE PROCEDURE `sp_list_exam_assignments` (IN `p_exam_id` VARCHAR(64))   BEGIN
  SELECT student_id FROM exam_assignments WHERE exam_id = p_exam_id;
END$$

CREATE PROCEDURE `sp_list_exam_questions` (IN `p_exam_id` VARCHAR(64))   BEGIN
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

CREATE PROCEDURE `sp_list_exam_sections` (IN `p_exam_id` VARCHAR(64))   BEGIN
  SELECT id, title, display_order, question_limit, shuffle_questions, time_limit_minutes, lock_on_complete
  FROM exam_sections
  WHERE exam_id = p_exam_id
  ORDER BY display_order ASC;
END$$

CREATE PROCEDURE `sp_list_exam_section_questions` (IN `p_section_id` VARCHAR(64))   BEGIN
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

CREATE PROCEDURE `sp_list_sessions` (IN `p_company_id` INT)   BEGIN
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

CREATE PROCEDURE `sp_list_students` (IN `p_company_id` INT)   BEGIN
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

CREATE PROCEDURE `sp_list_templates` (IN `p_company_id` INT, IN `p_channel` VARCHAR(16))   BEGIN
  SELECT id, name, channel, subject, body, is_default, created_at, updated_at
  FROM notification_templates
  WHERE company_id = p_company_id
    AND (p_channel IS NULL OR channel = p_channel)
  ORDER BY updated_at DESC, id DESC;
END$$

CREATE PROCEDURE `sp_list_violations` (IN `p_company_id` INT, IN `p_limit` INT)   BEGIN
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

CREATE PROCEDURE `sp_log_access` (IN `p_company_id` INT, IN `p_exam_id` VARCHAR(64), IN `p_student_id` VARCHAR(64), IN `p_action` VARCHAR(32), IN `p_status` VARCHAR(32), IN `p_message` TEXT)   BEGIN
  INSERT INTO exam_access_logs (company_id, exam_id, student_id, action, status, message)
  VALUES (p_company_id, p_exam_id, p_student_id, p_action, p_status, p_message);
END$$

CREATE PROCEDURE `sp_reset_exam_session` (IN `p_company_id` INT, IN `p_exam_id` VARCHAR(64), IN `p_student_id` VARCHAR(64))   BEGIN
  DELETE FROM exam_sessions
  WHERE company_id = p_company_id AND exam_id = p_exam_id AND student_id = p_student_id AND status <> 'COMPLETED';
END$$

CREATE PROCEDURE `sp_save_exam` (IN `p_id` VARCHAR(64), IN `p_company_id` INT, IN `p_title` VARCHAR(255), IN `p_duration_minutes` INT, IN `p_start_time` DATETIME(3), IN `p_end_time` DATETIME(3), IN `p_question_count` INT, IN `p_shuffle_questions` TINYINT(1), IN `p_show_results` TINYINT(1), IN `p_pass_percent` INT, IN `p_attempt_policy` ENUM('BEST','LAST','AVERAGE'), IN `p_reconnect_limit` INT, IN `p_total_marks` INT, IN `p_status` ENUM('DRAFT','PUBLISHED','ARCHIVED'), IN `p_camera_required` TINYINT(1), IN `p_microphone_required` TINYINT(1), IN `p_fullscreen_enforced` TINYINT(1), IN `p_tab_switch_limit` INT, IN `p_notification_enabled` TINYINT(1), IN `p_reminder_hours24` TINYINT(1), IN `p_reminder_hours1` TINYINT(1), IN `p_notification_subject` VARCHAR(255), IN `p_notification_message` TEXT)   BEGIN
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

CREATE PROCEDURE `sp_save_exam_section` (IN `p_id` VARCHAR(64), IN `p_exam_id` VARCHAR(64), IN `p_title` VARCHAR(255), IN `p_display_order` INT, IN `p_question_limit` INT, IN `p_shuffle_questions` TINYINT(1), IN `p_time_limit_minutes` INT, IN `p_lock_on_complete` TINYINT(1))   BEGIN
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

CREATE PROCEDURE `sp_save_question` (IN `p_id` VARCHAR(64), IN `p_type` ENUM('MCQ','TEXT'), IN `p_text` TEXT, IN `p_options_json` JSON, IN `p_correct_option_index` INT, IN `p_marks` INT)   BEGIN
  INSERT INTO questions (id, type, text, options_json, correct_option_index, marks)
  VALUES (p_id, p_type, p_text, p_options_json, p_correct_option_index, p_marks)
  ON DUPLICATE KEY UPDATE
    type = VALUES(type),
    text = VALUES(text),
    options_json = VALUES(options_json),
    correct_option_index = VALUES(correct_option_index),
    marks = VALUES(marks);
END$$

CREATE PROCEDURE `sp_save_template` (IN `p_company_id` INT, IN `p_id` BIGINT, IN `p_name` VARCHAR(255), IN `p_channel` ENUM('EMAIL','SMS'), IN `p_subject` VARCHAR(255), IN `p_body` TEXT, IN `p_is_default` TINYINT(1))   BEGIN
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

CREATE PROCEDURE `sp_start_exam_session` (IN `p_company_id` INT, IN `p_exam_id` VARCHAR(64), IN `p_student_id` VARCHAR(64), IN `p_user_agent` VARCHAR(512), IN `p_ip_address` VARCHAR(64), IN `p_location` VARCHAR(255), IN `p_device_fingerprint` VARCHAR(128), IN `p_mac_address` VARCHAR(17))   BEGIN
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

CREATE PROCEDURE `sp_reset_mac_binding` (IN `p_company_id` INT, IN `p_exam_id` VARCHAR(64), IN `p_student_id` VARCHAR(64))   BEGIN
  UPDATE exam_sessions
  SET mac_bound = 0, mac_bound_at = NULL, mac_address = NULL
  WHERE company_id = p_company_id AND exam_id = p_exam_id AND student_id = p_student_id AND status = 'IN_PROGRESS';
END$$

DELIMITER ;
