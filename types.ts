export enum UserRole {
  ADMIN = 'ADMIN',
  SUPER_ADMIN = 'SUPER_ADMIN',
  PROCTOR = 'PROCTOR',
  // Read-only staff role: can only see the Dashboard and Results tabs.
  VIEWER = 'VIEWER',
  STUDENT = 'STUDENT'
}

export enum QuestionType {
  MCQ = 'MCQ',                   // single correct option
  MULTI_SELECT = 'MULTI_SELECT', // multiple correct options (checkbox)
  TRUE_FALSE = 'TRUE_FALSE',     // True / False
  YES_NO = 'YES_NO',             // Yes / No
  SHORT_TEXT = 'SHORT_TEXT',     // one-line free text (manual grade)
  LONG_TEXT = 'LONG_TEXT',       // essay / paragraph (manual grade)
  FILL_BLANK = 'FILL_BLANK',     // fill in the blank(s)
  NUMERIC = 'NUMERIC',           // numeric value (+/- tolerance)
  DATE = 'DATE',                 // calendar date
  TIME = 'TIME',                 // time of day
  MATCHING = 'MATCHING',         // match left column to right column
  ORDERING = 'ORDERING',         // arrange items into the correct order
  DRAG_DROP = 'DRAG_DROP',       // drag items into buckets
  // Legacy alias. Historic rows stored 'TEXT'; treated as LONG_TEXT everywhere.
  TEXT = 'TEXT'
}

// The auto-gradable objective types. SHORT_TEXT / LONG_TEXT / TEXT are graded manually.
export const AUTO_GRADED_TYPES: QuestionType[] = [
  QuestionType.MCQ,
  QuestionType.MULTI_SELECT,
  QuestionType.TRUE_FALSE,
  QuestionType.YES_NO,
  QuestionType.FILL_BLANK,
  QuestionType.NUMERIC,
  QuestionType.DATE,
  QuestionType.TIME,
  QuestionType.MATCHING,
  QuestionType.ORDERING,
  QuestionType.DRAG_DROP,
];

export const isManualGraded = (type: QuestionType): boolean =>
  type === QuestionType.SHORT_TEXT || type === QuestionType.LONG_TEXT || type === QuestionType.TEXT;

/**
 * Structured correct-answer specification, stored on the question as `answerKey`.
 * Only the field(s) relevant to the question's type are populated:
 *  - MULTI_SELECT: correctIndices
 *  - FILL_BLANK:   blanks (one entry per blank, each with accepted alternates)
 *  - NUMERIC:      value (+ optional tolerance)
 *  - DATE/TIME:    value ('YYYY-MM-DD' / 'HH:MM')
 *  - MATCHING:     pairs (leftIndex -> rightIndex)
 *  - ORDERING:     order (correct sequence of item indices)
 *  - DRAG_DROP:    placements (itemIndex -> bucketIndex)
 * MCQ / TRUE_FALSE / YES_NO use correctOptionIndex instead of answerKey.
 */
export interface AnswerKey {
  correctIndices?: number[];
  blanks?: { accepted: string[] }[];
  value?: number | string;
  tolerance?: number | null;
  pairs?: Record<number, number>;
  order?: number[];
  placements?: Record<number, number>;
}

// Column/bucket data for structured types, stored on the question as `matchOptions`.
export interface MatchOptions {
  left?: string[];    // MATCHING
  right?: string[];   // MATCHING
  items?: string[];   // ORDERING / DRAG_DROP
  buckets?: string[]; // DRAG_DROP
}

// Device classes an exam can be restricted to. 'desktop' covers laptops and desktop
// computers (a browser cannot tell them apart); 'tablet' and 'mobile' (phone) are detected
// separately. If an exam allows none of the candidate's device class, the exam is blocked.
export type DeviceType = 'desktop' | 'tablet' | 'mobile';

export interface Question {
  id: string;
  text: string;
  type: QuestionType;
  options?: string[];
  correctOptionIndex?: number; // For MCQ / TRUE_FALSE / YES_NO
  // Structured correct-answer spec for MULTI_SELECT, FILL_BLANK, NUMERIC, DATE, TIME,
  // MATCHING, ORDERING, DRAG_DROP. Null/undefined for option-index and free-text types.
  answerKey?: AnswerKey | null;
  // Column/bucket/item data for MATCHING, ORDERING, DRAG_DROP.
  matchOptions?: MatchOptions | null;
  marks: number;
  /**
   * Marks deducted when this question is answered but wrong (auto-graded types only).
   * 0/undefined = no negative marking, which is what every question keeps until an admin sets one.
   */
  negativeMarks?: number;
  /**
   * Max words a candidate may write, for TEXT (descriptive) questions only.
   * null / undefined = no limit, which is what every question without an explicit cap gets.
   */
  wordLimit?: number | null;
  sectionId?: string;
  sectionTitle?: string;
  /**
   * Set when this question lives in a Question Bank (server-computed, read-only). Bank questions are
   * shared by every exam that uses them, so the exam editor shows them read-only — they are edited
   * in the Question Bank tab.
   */
  bankId?: number | null;
  bankName?: string | null;
}

export interface NotificationConfig {
  enabled: boolean;
  reminders: {
    hours24: boolean;
    hours1: boolean;
  };
  customSubject: string;
  customMessage: string;
}

export interface Exam {
  id: string;
  title: string;
  durationMinutes: number;
  startTime: number; // Timestamp in ms
  endTime: number;   // Timestamp in ms
  timezone?: string; // IANA zone (e.g. "Asia/Riyadh") for displaying/entering the schedule
  questions: Question[];
  sections?: ExamSection[];
  questionCount?: number; // Number of questions to present to student (subset limit)
  shuffleQuestions?: boolean; // Whether to randomize question order/selection
  showResults?: boolean; // Whether to show results immediately after submission
  // Certificate issuance is on-demand only (never automatic on pass) and only reachable at all
  // when this is enabled for the exam. Set once at exam creation/edit.
  certificateEnabled?: boolean;
  attemptPolicy?: 'LAST'; // Multi-attempt scoring policy disabled; always last attempt
  reconnectLimit?: number; // Allowed reconnection attempts for active sessions
  passPercent?: number; // Percentage required to pass the exam
  totalMarks: number;
  status: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';
  // Which device classes may take this exam. Empty/undefined means all devices allowed.
  allowedDeviceTypes?: DeviceType[];
  proctoringConfig: {
    /**
     * PROCTORED (default) runs the checks below. UNPROCTORED switches ALL monitoring off: no camera,
     * microphone, screen recording, fullscreen, tab-switch / copy-paste tracking or AI analysis.
     */
    mode?: ProctoringMode;
    /** Show violation alerts to the candidate (default true). When false, violations are still recorded silently. */
    showAlerts?: boolean;
    /** End the attempt when a violation limit is reached (default true). When false, limits only flag the attempt. */
    autoTerminate?: boolean;
    cameraRequired: boolean;
    microphoneRequired: boolean;
    fullScreenEnforced: boolean;
    tabSwitchLimit: number;
    violationLimits?: {
      camera: number;
      microphone: number;
      fullscreen: number;
      copyPaste: number;
    };
    // Seconds of sustained gaze-away / talking tolerated before GAZE_AWAY / AUDIO_DETECTED fires.
    proctorTiming?: {
      gazeAwaySeconds: number;
      audioSeconds: number;
    };
  };
  assignedStudentIds?: string[];
  assignedBatchIds?: number[];
  // Assigned students who have not been sent an access link yet (server-computed, read-only).
  pendingInviteCount?: number;
  // Assigned students who have never opened this exam — no session row at all (server-computed,
  // read-only). This is the audience a "not attempted" reminder targets.
  notAttemptedCount?: number;
  // Per-exam subject/message/design overrides (exam editor "Emails" section, Mail Composer). An
  // absent kind means the built-in default email is used for that mail.
  mailTemplates?: Partial<Record<ExamMailKind, ExamMailTemplate>>;
  notificationConfig?: NotificationConfig;
}

export type ProctoringMode = 'PROCTORED' | 'UNPROCTORED';

/** A reusable, company-owned collection of questions (Question Bank tab). */
export interface QuestionBank {
  id: number;
  companyId: number;
  name: string;
  description?: string | null;
  questionCount: number;
  /** Exams that use at least one question from this bank. */
  examCount: number;
  createdBy?: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface QuestionBankDetail extends QuestionBank {
  questions: Question[];
}

export type ExamRequestStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'INVALID';

export interface ExamRequestStudent {
  fullName: string;
  email: string;
  registrationId: string;
}

/** The exam an employee asked for by email (editable by the super admin before approval). */
export interface ExamRequestDetails {
  title: string;
  questionBankId: number | null;
  questionBankName: string;
  /** Questions each candidate gets, drawn at random from the bank. 0 = the whole bank. */
  questionCount: number;
  durationMinutes: number;
  passPercent: number;
  startTime: number | null; // UTC ms
  endTime: number | null;   // UTC ms
  timezone: string;         // IANA zone the Start/End were written in
  proctoringMode: ProctoringMode;
  cameraRequired: boolean;
  microphoneRequired: boolean;
  showAlerts: boolean;
  autoTerminate: boolean;
  /** Existing batch to invite, when the email named one instead of attaching a student CSV. */
  batchName: string | null;
  notes: string;
}

export interface ExamRequest {
  id: number;
  companyId: number | null;
  companyName?: string | null;
  requesterId: number | null;
  requesterName?: string | null;
  senderEmail: string;
  subject: string;
  status: ExamRequestStatus;
  details: ExamRequestDetails;
  students: ExamRequestStudent[];
  /** Validation problems found at intake (an INVALID request) or that still block approval. */
  errors: string[];
  receivedAt: number;
  reviewedBy?: string | null;
  reviewedAt?: number | null;
  reviewNote?: string | null;
  createdExamId?: string | null;
}

/** An employee allowed to request exams by email, with their own security code. */
export interface ExamRequester {
  id: number;
  companyId: number;
  companyName?: string | null;
  name: string;
  email: string;
  status: 'ACTIVE' | 'DISABLED';
  /** Last 4 characters of the code, for recognising which code an employee holds. */
  codeHint?: string | null;
  createdAt: number;
  lastRequestAt?: number | null;
  /** Optional WhatsApp number for request status updates (bare international digits). */
  mobile?: string | null;
}

export type ExamMailKind = 'INVITE' | 'REMINDER';

/**
 * Per-exam design of one email kind (exam editor "Emails" section). Every field is optional and an
 * absent field keeps the original email, so `{}` renders exactly the built-in design.
 */
export interface ExamMailTemplateOptions {
  /** Heading in the coloured header band (placeholders allowed). Default: the exam title. */
  headerTitle?: string;
  /** Invitation button label (placeholders allowed). Default: "Open Exam Portal →". */
  buttonText?: string;
  /** "#rrggbb" for the header band, button and links. Default: the original blue palette. */
  accentColor?: string;
  /** Exam window (Date From / To). Default on. */
  showSchedule?: boolean;
  /** Duration tile. Default on. */
  showDuration?: boolean;
  /** Candidate-name tile. Default on. */
  showCandidate?: boolean;
  /** "Before you begin" device/system requirements. Default on (unproctored: no camera/mic items). */
  showRequirements?: boolean;
  /** Instructions PDF link. Default on for proctored exams, off for unproctored ones. */
  showInstructionsPdf?: boolean;
  /** AI-proctoring warning (unproctored: the "not proctored" note). Default on. */
  showProctoringNotice?: boolean;
  /** Optional sign-off above the footer (plain text, placeholders allowed). */
  closingNote?: string;
}

export interface ExamMailTemplate {
  subject: string;
  message: string;
  options?: ExamMailTemplateOptions;
}

export interface ExamSection {
  id: string;
  title: string;
  questionLimit: number;
  shuffleQuestions: boolean;
  timeLimitMinutes: number;
  lockOnComplete: boolean;
  displayOrder: number;
  questions: Question[];
}

export interface Student {
  id: string;
  fullName: string;
  email: string;
  registrationId: string;
  /** Optional WhatsApp number, stored as bare international digits (e.g. "919876543210"). */
  mobile?: string | null;
  companyId?: number;
  company?: string;
  batches: { id: number; name: string }[];
  enrolled?: boolean;
  enrolledAt?: string | null;
}

export interface Batch {
  id: number;
  companyId: number;
  companyName?: string | null;
  name: string;
  description?: string | null;
  studentCount?: number;
  createdAt?: number;
}

export interface CompanyDirectoryRecord {
  id: number;
  code: string;
  name: string;
  contactName?: string | null;
  contactEmail?: string | null;
  status: 'ACTIVE' | 'INACTIVE';
  notes?: string | null;
  createdAt: number;
  updatedAt: number;
  adminCount: number;
  proctorCount: number;
  userStudentCount: number;
  studentCount: number;
  examCount: number;
  liveSessionCount: number;
  violationCount: number;
  pendingRequestCount: number;
}

export interface ManagedUserRecord {
  id: number;
  companyId?: number | null;
  companyName?: string | null;
  role: UserRole;
  fullName: string;
  email: string;
  status: 'ACTIVE' | 'INVITED' | 'DISABLED';
  registrationId?: string | null;
  externalAuthId?: string | null;
  notes?: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface PlatformOverview {
  companyCount: number;
  activeCompanyCount: number;
  platformUserCount: number;
  examCount: number;
  studentCount: number;
  liveSessionCount: number;
  completedSessionCount: number;
  violationCount: number;
  pendingRequestCount: number;
  recordingCount: number;
}

export interface PlatformCompanyRollup {
  companyId: number;
  companyName: string;
  companyCode: string;
  status: 'ACTIVE' | 'INACTIVE';
  adminCount: number;
  proctorCount: number;
  userStudentCount: number;
  studentCount: number;
  examCount: number;
  liveSessionCount: number;
  violationCount: number;
}

export interface PlatformExamReportRow {
  companyId: number;
  companyName?: string | null;
  examId: string;
  examTitle: string;
  status: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';
  sessionCount: number;
  completedCount: number;
  terminatedCount: number;
  averageScore: number;
  violationCount: number;
}

export interface PlatformBatchReportRow {
  companyId: number;
  companyName?: string | null;
  batchId: number;
  batchName: string;
  studentCount: number;
  sessionCount: number;
  violationCount: number;
}

export interface PlatformStudentReportRow {
  companyId: number;
  companyName?: string | null;
  studentId: string;
  fullName: string;
  email: string;
  registrationId: string;
  sessionCount: number;
  completedCount: number;
  violationCount: number;
}

export interface ExamSession {
  examId: string;
  studentId: string;
  startTime: number;
  answers: Record<string, string | number>; // questionId -> answer
  violations: ViolationLog[];
  status: 'IN_PROGRESS' | 'COMPLETED' | 'TERMINATED';
  ipAddress?: string;
  userAgent?: string;
  deviceFingerprint?: string;
  deviceMetadata?: Record<string, any> | null;
  macAddress?: string;
  macBound?: boolean;
  location?: string; // Mocked Geo-location based on IP
  locationLat?: number | null;
  locationLng?: number | null;
  locationAccuracy?: number | null;
  ipChangeDetected?: boolean;
  deviceChangeDetected?: boolean;
  locationChangeDetected?: boolean;
}

export interface ViolationLog {
  timestamp: number;
  type: 'TAB_SWITCH' | 'NO_FACE' | 'MULTIPLE_FACES' | 'GAZE_AWAY' | 'AUDIO_DETECTED' | 'FULLSCREEN_EXIT' | 'COPY_PASTE' | 'PHONE_DETECTED' | 'ANOMALY_OBJECT' | 'LOCATION_CHANGE' | 'IDENTITY_CHANGE' | 'SUSPICIOUS_BEHAVIOR';
  description: string;
  snapshot?: string; // Base64 image string of the webcam at that moment
  category?: 'camera' | 'microphone' | 'screen' | 'browser' | 'device' | 'location' | 'behavior';
  confidence?: number;
  metadata?: Record<string, any>;
}

export interface AnalyticsData {
  name: string;
  score: number;
  passed: boolean;
}

export interface ResultAnswer {
  questionId: string;
  questionText: string;
  questionType: QuestionType;
  options?: string[] | null;
  correctOptionIndex?: number | null;
  answerKey?: AnswerKey | null;
  matchOptions?: MatchOptions | null;
  marks: number;
  answerText?: string | null;
  answerOptionIndex?: number | null;
  // Structured student response (arrays/objects) for non-option-index types.
  answerJson?: any;
  isCorrect?: boolean | null;
  awardedMarks?: number | null;
  timeSpentSec?: number | null;
}

export interface ExamResultRecord {
  sessionId: number;
  examId: string;
  studentId: string;
  startTime: number;
  endTime?: number | null;
  status: 'IN_PROGRESS' | 'COMPLETED' | 'TERMINATED';
  totalScore?: number | null;
  maxScore?: number | null;
  passed?: boolean | null;
  attemptPolicy?: 'LAST';
  attemptIndex?: number;
  attemptCount?: number;
  finalScore?: number | null;
  finalMaxScore?: number | null;
  finalPassed?: boolean | null;
  finalPercent?: number | null;
  answeredCount?: number | null;
  terminationReason?: string | null;
  violationCount?: number | null;
  answers: ResultAnswer[];
}

export interface ResultAuditLog {
  id: number;
  sessionId: number;
  questionId?: string | null;
  previousAwardedMarks?: number | null;
  newAwardedMarks?: number | null;
  previousIsCorrect?: boolean | null;
  newIsCorrect?: boolean | null;
  actor?: string | null;
  note?: string | null;
  createdAt: number;
}

export interface AuditLog {
  id: number;
  actorRole: 'ADMIN' | 'SUPER_ADMIN' | 'PROCTOR' | 'STUDENT' | 'SYSTEM';
  actorId?: string | null;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  message?: string | null;
  metadata?: Record<string, any> | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  createdAt: number;
}

export interface NotificationTemplate {
  id: number;
  name: string;
  channel: 'EMAIL' | 'SMS';
  subject?: string | null;
  body: string;
  isDefault: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface DeliveryLog {
  id: number;
  channel: 'EMAIL' | 'SMS' | 'WHATSAPP';
  recipient: string;
  subject?: string | null;
  body?: string | null;
  status: 'SENT' | 'FAILED' | 'SKIPPED';
  error?: string | null;
  templateId?: number | null;
  metadata?: Record<string, any> | null;
  createdAt: number;
}

// V1 automation Phase 1: inbound webhook connector that auto-schedules an exam when a source
// platform reports a learner completed a mapped course. See docs/ProctorGuard_V1_Requirements.md.
export interface IntegrationConnector {
  id: string;
  name: string;
  status: 'ACTIVE' | 'DISABLED';
  secretMasked: string;
  fieldMap: Record<string, string>;
  createdAt: number;
}

export interface IntegrationEvent {
  id: number;
  connectorId: string;
  eventType?: string | null;
  status: 'RECEIVED' | 'PROCESSED' | 'FAILED' | 'DEAD' | 'UNMAPPED' | 'SKIPPED_GATE';
  attempts: number;
  error?: string | null;
  payload?: Record<string, any> | null;
  receivedAt: number;
  processedAt?: number | null;
}

export interface CourseExamMapping {
  id: number;
  connectorId: string;
  externalCourseId: string;
  examId: string;
  examTitle?: string | null;
  batchId?: number | null;
  batchName?: string | null;
  active: boolean;
}

// V1 automation Phase 2: certificate hand-off to an external certificate system on a session's
// final pass. See docs/ProctorGuard_V1_Requirements.md §7.6. The external call is currently a
// stub (call_certificate_api() in api/certificates.php) pending the vendor's real API contract, so
// issuances typically sit in FAILED with an explanatory error until that's wired in.
export interface CertificateIssuance {
  id: number;
  sessionId: number;
  studentId: string;
  studentName: string;
  studentEmail: string;
  examId: string;
  examTitle: string;
  verificationId: string;
  externalCertificateId?: string | null;
  verificationUrl?: string | null;
  status: 'PENDING' | 'ISSUED' | 'FAILED' | 'DEAD';
  attempts: number;
  error?: string | null;
  issuedAt?: number | null;
  lastEmailedAt?: number | null;
  emailCount: number;
  createdAt: number;
}

export interface AccessRequestRecord {
  id: number;
  examId: string;
  studentId: string;
  sessionId?: number | null;
  requestType?: 'REATTEMPT' | 'DEVICE_CHANGE';
  status: 'PENDING' | 'GRANTED' | 'REVOKED';
  reason?: string | null;
  previousDeviceFingerprint?: string | null;
  newDeviceFingerprint?: string | null;
  previousDevice?: Record<string, any> | null;
  newDevice?: Record<string, any> | null;
  violationSummary?: {
    total?: number;
    byType?: Record<string, number>;
    byCategory?: Record<string, number>;
  } | null;
  requestedAt: number;
  reviewedAt?: number | null;
  reviewedBy?: string | null;
  reviewNote?: string | null;
}

export interface SessionFeedback {
  id: number;
  sessionId?: number | null;
  examId: string;
  studentId: string;
  batchId?: number | null;
  rating: number;
  clarityRating?: number | null;
  platformRating?: number | null;
  comment?: string | null;
  createdAt: number;
}

export type RecordingStreamType = 'camera' | 'screen' | 'combined';

export interface RecordingSessionRecord {
  id: number;
  examId: string;
  studentId: string;
  sessionId?: number | null;
  status: 'INIT' | 'RECORDING' | 'COMPLETED' | 'FAILED';
  startedAt: number;
  endedAt?: number | null;
  durationSec?: number | null;
  streams: Array<{
    streamType: RecordingStreamType;
    mimeType?: string | null;
    sizeBytes: number;
    hasFile: boolean;
    fileUrl?: string | null;
    createdAt?: number | null;
  }>;
  // On-demand re-analysis of this recording's camera stream against the live AI detector.
  recheckStatus?: 'PENDING' | 'RUNNING' | 'DONE' | 'FAILED' | null;
  recheckFoundCount?: number | null;
  recheckError?: string | null;
  recheckFinishedAt?: number | null;
}

export interface RecordingSummary {
  cameraCount: number;
  screenCount: number;
  combinedCount: number;
  totalCount: number;
}

/** GET api/whatsapp.php — WhatsApp notification status (no secrets). */
export type WhatsAppKind = 'INVITE' | 'REMINDER' | 'REQUEST_UPDATE';
export interface WhatsAppStatus {
  enabled: boolean;
  provider: 'meta' | 'lsc' | null;
  /** True once enabled + provider credentials + at least one template are configured. */
  ready: boolean;
  /** Which message kinds have a template name configured. */
  kinds: Record<WhatsAppKind, boolean>;
  /** .env keys that still need setting (names only, never values). */
  issues?: string[];
}

/** POST api/whatsapp.php {action:'SEND_EXAM_NOTICE'} result. */
export interface WhatsAppSendSummary {
  sent: number;
  failed: number;
  skippedNoMobile: number;
  skippedDisabled: number;
  failures: { studentId: string; error: string }[];
}
