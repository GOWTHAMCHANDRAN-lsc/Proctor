export enum UserRole {
  ADMIN = 'ADMIN',
  SUPER_ADMIN = 'SUPER_ADMIN',
  PROCTOR = 'PROCTOR',
  STUDENT = 'STUDENT'
}

export enum QuestionType {
  MCQ = 'MCQ',
  TEXT = 'TEXT'
}

export interface Question {
  id: string;
  text: string;
  type: QuestionType;
  options?: string[];
  correctOptionIndex?: number; // For MCQ
  marks: number;
  sectionId?: string;
  sectionTitle?: string;
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
  questions: Question[];
  sections?: ExamSection[];
  questionCount?: number; // Number of questions to present to student (subset limit)
  shuffleQuestions?: boolean; // Whether to randomize question order/selection
  showResults?: boolean; // Whether to show results immediately after submission
  attemptPolicy?: 'LAST'; // Multi-attempt scoring policy disabled; always last attempt
  reconnectLimit?: number; // Allowed reconnection attempts for active sessions
  passPercent?: number; // Percentage required to pass the exam
  totalMarks: number;
  status: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';
  proctoringConfig: {
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
  };
  assignedStudentIds?: string[];
  assignedBatchIds?: number[];
  notificationConfig?: NotificationConfig;
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
  companyId?: number;
  company?: string;
  batchId?: number | null;
  batch?: string | null;
}

export interface Batch {
  id: number;
  companyId: number;
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
  type: 'TAB_SWITCH' | 'NO_FACE' | 'MULTIPLE_FACES' | 'GAZE_AWAY' | 'AUDIO_DETECTED' | 'FULLSCREEN_EXIT' | 'COPY_PASTE' | 'PHONE_DETECTED' | 'ANOMALY_OBJECT' | 'LOCATION_CHANGE';
  description: string;
  snapshot?: string; // Base64 image string of the webcam at that moment
  category?: 'camera' | 'microphone' | 'screen' | 'browser' | 'device' | 'location';
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
  marks: number;
  answerText?: string | null;
  answerOptionIndex?: number | null;
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
  channel: 'EMAIL' | 'SMS';
  recipient: string;
  subject?: string | null;
  body?: string | null;
  status: 'SENT' | 'FAILED' | 'SKIPPED';
  error?: string | null;
  templateId?: number | null;
  metadata?: Record<string, any> | null;
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
}

export interface RecordingSummary {
  cameraCount: number;
  screenCount: number;
  combinedCount: number;
  totalCount: number;
}
