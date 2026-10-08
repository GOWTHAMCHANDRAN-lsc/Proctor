import React, { useState, useRef, useEffect } from 'react';
import { Batch, Exam, ExamMailKind, Question, QuestionType, Student, NotificationTemplate, UserRole, CompanyDirectoryRecord } from '../../types';
import { Plus, Trash2, Save, FileSpreadsheet, Upload, Download, CheckCircle, AlertCircle, Share2, Calendar, Clock, XCircle, FileWarning, Users, Search, Lock, Mail, Send, Loader2, Shuffle, Bell, ListOrdered, Eye, Copy, Monitor, Tablet, Smartphone, Pencil, Award, Library, Camera, Mic, Maximize, ShieldCheck, ShieldOff, Info, MessageCircle } from 'lucide-react';
import type { DeviceType, ProctoringMode, QuestionBank, QuestionBankDetail, WhatsAppSendSummary, WhatsAppStatus } from '../../types';
import { ExamTake } from '../student/ExamTake';
import { ApiError, apiGet, apiPost, getApiErrorMessage } from '../../services/api';
import { Pagination, usePagination } from './Pagination';
import { useSettings } from '../../services/appSettings';
import { buildQuestionCsvTemplate, parseCsvLine, parseQuestionCsv } from '../../services/questionCsv';
import {
  EXAM_TIMEZONES, DEFAULT_EXAM_TIMEZONE, resolveExamTimezone,
  epochToZonedInput, zonedInputToEpoch,
  formatScheduleShort,
} from '../../services/timezone';
import { buildExamEmailContent, resolveExamMailTemplate, DEFAULT_INVITE_MESSAGE, DEFAULT_REMINDER_MESSAGE } from '../../services/examEmail';
import type { ExamMailTemplate } from '../../types';
import { ExamEmailsEditor, EmailPreviewFrame } from './ExamEmailsEditor';

// A student resolved as the target of one exam's mail run.
// attemptStatus / attemptCount come from the server's exam_sessions aggregate and drive the Mail
// Composer's audience filters — NOT_STARTED means the student never opened the exam at all.
type ExamRecipient = {
  id: string; fullName: string; email: string; registrationId: string; companyId: number;
  invitedAt?: number | null; token?: string;
  // Short-link code: the student's link is `${origin}?${code}` (falls back to ?token= without one).
  code?: string;
  attemptCount?: number;
  attemptStatus?: 'NOT_STARTED' | 'IN_PROGRESS' | 'COMPLETED' | 'TERMINATED';
  completed?: boolean;
  lastAttemptAt?: number | null;
};

// Who a composed mail goes to. NOT_ATTEMPTED is the common case this screen exists for: chase the
// candidates who never opened the exam. NOT_COMPLETED additionally catches attempts that were
// started and then abandoned or terminated.
type MailAudience = 'ALL' | 'NOT_ATTEMPTED' | 'NOT_COMPLETED' | 'NOT_INVITED';

const MAIL_AUDIENCES: { id: MailAudience; label: string; hint: string }[] = [
  { id: 'NOT_ATTEMPTED', label: 'Not attempted', hint: 'Never opened the exam' },
  { id: 'NOT_COMPLETED', label: 'Not completed', hint: 'No submitted attempt (includes abandoned)' },
  { id: 'NOT_INVITED', label: 'Never invited', hint: 'No access link sent yet' },
  { id: 'ALL', label: 'All assigned', hint: 'Everyone assigned to this exam' },
];

const filterByAudience = (recipients: ExamRecipient[], audience: MailAudience): ExamRecipient[] => {
  switch (audience) {
    case 'NOT_ATTEMPTED':
      return recipients.filter(r => (r.attemptStatus ?? 'NOT_STARTED') === 'NOT_STARTED');
    case 'NOT_COMPLETED':
      return recipients.filter(r => !r.completed);
    case 'NOT_INVITED':
      return recipients.filter(r => !r.invitedAt);
    default:
      return recipients;
  }
};

// A student's personal exam link: the short `<origin>?<code>` form when the server allocated a code, else
// the long signed `?token=` link (both open the same exam; codes and tokens are minted server-side).
const examLinkFor = (r: Pick<ExamRecipient, 'code' | 'token'>): string =>
  r.code ? `${window.location.origin}?${r.code}` : `${window.location.origin}?token=${r.token}`;
// Placeholder link for previews and sample emails (never a real code).
const sampleExamLink = () => `${window.location.origin}?SAMPLE1234`;

// The invitation/reminder email (defaults, per-exam template resolution and the HTML builder) lives in
// services/examEmail.ts, shared with the editor's Emails section and mirrored by
// api/exam_mail_render.php. Re-exported here for existing importers.
export { buildExamEmailContent, resolveExamMailTemplate, DEFAULT_INVITE_MESSAGE, DEFAULT_REMINDER_MESSAGE };

const readTextFile = async (file: File) => {
  const buffer = await file.arrayBuffer();
  try {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    return decoder.decode(buffer).replace(/^\uFEFF/, '');
  } catch {
    const decoder = new TextDecoder('windows-1252');
    return decoder.decode(buffer).replace(/^\uFEFF/, '');
  }
};

// apiGet/apiPost throw the raw response body, which for this API is JSON like {"error":"..."}.
// Surface the server's own reason (e.g. "endTime must be later than startTime.") instead of either a
// generic message or a raw JSON blob; fall back when the body is HTML/JSON without an error field.
const apiErrorMessage = (e: unknown, fallback: string): string => {
  const raw = (e instanceof Error ? e.message : typeof e === 'string' ? e : '').trim();
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed.error === 'string' && parsed.error.trim() ? parsed.error.trim() : fallback;
  } catch {
    return raw.startsWith('<') || raw.length > 300 ? fallback : raw;
  }
};

// Build a CSV download href. encodeURIComponent (not encodeURI) is required: encodeURI leaves '#'
// unescaped, and browsers treat '#' in a data: URL as the start of a fragment — silently truncating
// the file at the first '#' (e.g. the question template's '#' guide rows, or a '#' in an exam title).
const csvDataUri = (content: string) => 'data:text/csv;charset=utf-8,' + encodeURIComponent(String.fromCharCode(0xFEFF) + content);

// Quote one CSV cell, doubling embedded quotes so a name like `Ann "Annie" Lee` stays one column.
const csvCell = (value: unknown) => `"${String(value ?? '').replace(/"/g, '""')}"`;

// datetime-local value that never throws: Intl throws RangeError on an Invalid Date, and there is no
// error boundary above this screen, so a NaN/undefined instant would blank the whole admin panel.
const zonedInputValue = (epoch: number | undefined, tz: string): string =>
  typeof epoch === 'number' && Number.isFinite(epoch) ? epochToZonedInput(epoch, tz) : '';

const getAdminCompanyId = () => {
  if (typeof window === 'undefined') return 1;
  try {
    const raw = localStorage.getItem('pg_admin_auth');
    if (!raw) return 1;
    const parsed = JSON.parse(raw);
    const companyId = Number(parsed?.companyId);
    return Number.isFinite(companyId) && companyId > 0 ? companyId : 1;
  } catch {
    return 1;
  }
};

const defaultViolationLimits = {
  camera: 0,
  microphone: 0,
  fullscreen: 0,
  copyPaste: 0,
};

const defaultProctorTiming = {
  gazeAwaySeconds: 9,
  audioSeconds: 2,
};

const defaultProctoringConfig: Exam['proctoringConfig'] = {
  mode: 'PROCTORED',
  showAlerts: true,
  autoTerminate: true,
  cameraRequired: true,
  microphoneRequired: false,
  fullScreenEnforced: true,
  tabSwitchLimit: 3,
  violationLimits: { ...defaultViolationLimits },
  proctorTiming: { ...defaultProctorTiming },
};

// What an exam actually enforces. UNPROCTORED switches every monitoring check off; the server stores
// it that way too, but the editor keeps the admin's proctored settings in its draft so flipping the
// mode back and forth while editing doesn't lose them — so normalise on the way out (save, preview).
const effectiveProctoringConfig = (config: Exam['proctoringConfig']): Exam['proctoringConfig'] => (
  config.mode === 'UNPROCTORED'
    ? {
        ...config,
        cameraRequired: false,
        microphoneRequired: false,
        fullScreenEnforced: false,
        tabSwitchLimit: 0,
        violationLimits: { ...defaultViolationLimits },
      }
    : config
);

interface CsvError {
  row: number;
  message: string;
  rawData: string;
}

// Maps CSV "Type" cells (uppercased, with spaces/_/-/slashes stripped) to a canonical QuestionType.
interface ExamManagerProps {
  students: Student[];
  exams: Exam[];
  onUpdateExams: React.Dispatch<React.SetStateAction<Exam[]>>;
  onUpdateStudents?: React.Dispatch<React.SetStateAction<Student[]>>;
  role?: UserRole;
}

export const ExamManager: React.FC<ExamManagerProps> = ({ students: propStudents, exams: propExams, onUpdateExams: propOnUpdateExams, onUpdateStudents: propOnUpdateStudents, role }) => {
  const { settings } = useSettings();
  const isSuperAdmin = role === UserRole.SUPER_ADMIN;

  // Super admin operates across every tenant: it keeps its own per-company exam/student list and
  // a company selector. A regular admin stays bound to its own company via props + request headers.
  const [companies, setCompanies] = useState<CompanyDirectoryRecord[]>([]);
  const [selectedCompanyId, setSelectedCompanyId] = useState<number | ''>('');
  const [superExams, setSuperExams] = useState<Exam[]>([]);
  const [superStudents, setSuperStudents] = useState<Student[]>([]);
  const [superExamsLoading, setSuperExamsLoading] = useState(false);

  // Effective bindings — the rest of the component uses these transparently.
  const exams = isSuperAdmin ? superExams : propExams;
  const students = isSuperAdmin ? superStudents : propStudents;
  const onUpdateExams = isSuperAdmin ? setSuperExams : propOnUpdateExams;
  const onUpdateStudents = isSuperAdmin ? setSuperStudents : propOnUpdateStudents;
  const effectiveCompanyId = isSuperAdmin ? (selectedCompanyId === '' ? null : selectedCompanyId) : null;
  // Extra query string / payload field that pins super-admin requests to the chosen company.
  const companyQuery = isSuperAdmin && effectiveCompanyId ? `?companyId=${effectiveCompanyId}` : '';

  React.useEffect(() => {
    // templates.php is company-scoped: a super admin must name the company (as every other call here
    // does), and has nothing to load until one is picked — otherwise it fails with "companyId is required".
    if (isSuperAdmin && !effectiveCompanyId) {
      setTemplates([]);
      return;
    }
    let cancelled = false;
    const loadTemplates = async () => {
      try {
        const scope = isSuperAdmin && effectiveCompanyId ? `&companyId=${effectiveCompanyId}` : '';
        const data = await apiGet<{ templates: NotificationTemplate[] }>(`templates.php?channel=EMAIL${scope}`);
        if (!cancelled) {
          setTemplates(data?.templates || []);
        }
      } catch (e) {
        console.error('Failed to load templates:', e);
      }
    };
    loadTemplates();
    return () => {
      cancelled = true;
    };
  }, [isSuperAdmin, effectiveCompanyId]);
  // Merge the selected companyId into a POST body so the backend scopes the write correctly.
  const withCompany = <T extends object>(body: T): T & { companyId?: number } =>
    isSuperAdmin && effectiveCompanyId ? { ...body, companyId: effectiveCompanyId } : body;
  // Build a fresh exam draft pre-filled from the admin's configurable defaults.
  const buildExamDefaults = (): Partial<Exam> => {
    const d = settings.examDefaults;
    return {
      title: '',
      durationMinutes: d.durationMinutes,
      startTime: Date.now(),
      endTime: Date.now() + 86400000 * 2,
      timezone: DEFAULT_EXAM_TIMEZONE,
      questions: [],
      sections: [],
      questionCount: 0,
      shuffleQuestions: true,
      showResults: d.showResults,
      certificateEnabled: false,
      feedbackEnabled: true,
      reconnectLimit: d.reconnectLimit,
      passPercent: d.passPercent,
      proctoringConfig: {
        mode: 'PROCTORED',
        showAlerts: true,
        autoTerminate: true,
        cameraRequired: d.cameraRequired,
        microphoneRequired: d.microphoneRequired,
        fullScreenEnforced: d.fullScreenEnforced,
        tabSwitchLimit: d.tabSwitchLimit,
        violationLimits: { ...d.violationLimits },
        proctorTiming: { gazeAwaySeconds: d.gazeAwaySeconds, audioSeconds: d.audioSeconds },
      },
      totalMarks: 0,
      allowedDeviceTypes: ['desktop', 'tablet', 'mobile'],
      assignedStudentIds: [],
      assignedBatchIds: [],
      status: 'DRAFT',
      notificationConfig: {
        enabled: false,
        reminders: { hours24: true, hours1: true },
        customSubject: '',
        customMessage: '',
      },
    };
  };
  const [isCreating, setIsCreating] = useState(false);
  const [batchSearch, setBatchSearch] = useState('');
  const [emailSendingId, setEmailSendingId] = useState<string | null>(null);
  const [sendingMode, setSendingMode] = useState<'notify' | 'reminder' | null>(null);
  const [activeSectionId, setActiveSectionId] = useState<string | null>(null);
  const [templates, setTemplates] = useState<NotificationTemplate[]>([]);
  const [batches, setBatches] = useState<Batch[]>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState<number | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Exam | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  // In-flight guards: each of these POSTs/downloads used to be re-triggerable by a double click
  // (a double-clicked Save on a NEW exam minted two client ids and created the exam twice).
  const [savingExam, setSavingExam] = useState(false);
  const [duplicatingId, setDuplicatingId] = useState<string | null>(null);
  const [exportingLinksId, setExportingLinksId] = useState<string | null>(null);
  // Archived exams are hidden from the grid unless the admin asks to see them.
  const [showArchived, setShowArchived] = useState(false);
  // JSON snapshot of the exam as it was when the editor opened, so Cancel can warn about unsaved edits.
  const editorSnapshotRef = useRef<string>('');
  // Set when an exam has both already-invited and newly-assigned students: the admin picks who to mail.
  // Also used (with confirmText) as the plain send confirmation when WhatsApp invitations are on, so
  // the "Also send on WhatsApp" checkbox can sit next to the send button.
  const [inviteScopeTarget, setInviteScopeTarget] = useState<{ exam: Exam; recipients: ExamRecipient[]; pending: ExamRecipient[]; confirmText?: string } | null>(null);
  // WhatsApp copies of invitations/reminders. Nothing is shown unless the server says WhatsApp is ready
  // for that message kind (it ships disabled until .env is configured — see docs/WHATSAPP_SETUP.md).
  const [waStatus, setWaStatus] = useState<WhatsAppStatus | null>(null);
  const [waOptIn, setWaOptIn] = useState(true);
  // Student ids (of the exam being sent) that have a mobile number; null while loading.
  const [waCoverage, setWaCoverage] = useState<{ examId: string; ids: Set<string> } | null>(null);
  // Per-exam Mail Composer: pick the audience (e.g. only students who never attempted), edit the
  // subject/message, preview it, optionally save it as this exam's default, then send.
  const [mailComposer, setMailComposer] = useState<{
    exam: Exam;
    kind: ExamMailKind;
    subject: string;
    message: string;
    audience: MailAudience;
    recipients: ExamRecipient[];
    loading: boolean;
    saving: boolean;
    dirty: boolean;
    error: string | null;
    notice: string | null;
  } | null>(null);
  
  // Preview State
  const [showPreview, setShowPreview] = useState(false);
  const [showMailPreview, setShowMailPreview] = useState(false);
  const [mailPreviewMode, setMailPreviewMode] = useState<'invite' | 'reminder'>('invite');
  
  // New Exam State — seeded from the configurable defaults.
  const [newExam, setNewExam] = useState<Partial<Exam>>(buildExamDefaults);

  // "Add from Question Bank" picker. Banks belong to one company (a super admin sees the company
  // picked above). Adding a bank appends ALL of its questions, linked rather than copied: they keep
  // their ids, stay read-only here and are edited in the Question Bank tab.
  const [bankPickerOpen, setBankPickerOpen] = useState(false);
  const [bankList, setBankList] = useState<QuestionBank[]>([]);
  const [bankListLoading, setBankListLoading] = useState(false);
  const [bankListError, setBankListError] = useState<string | null>(null);
  const [bankSearch, setBankSearch] = useState('');
  const [selectedBankId, setSelectedBankId] = useState<number | null>(null);
  const [bankAdding, setBankAdding] = useState(false);
  const [bankAddError, setBankAddError] = useState<string | null>(null);
  const [bankNotice, setBankNotice] = useState<string | null>(null);
  // Bumped on every bank request so a slow response from an earlier open can't overwrite a newer one.
  const bankRequestRef = useRef(0);

  // "Archive (Hide from list)" must stay hidden after a reload too — the API returns archived exams,
  // so the grid filters them out unless the admin opts to show them.
  const archivedCount = exams.filter(e => e.status === 'ARCHIVED').length;
  const visibleExams = showArchived ? exams : exams.filter(e => e.status !== 'ARCHIVED');

  // The exam grid and the editor's question list both grow without bound; each pages on its own.
  const examPaging = usePagination(visibleExams, showArchived ? 'all' : 'active');
  const questionPaging = usePagination(newExam.questions || [], newExam.id || '');
  // Show the page a freshly appended question landed on.
  const jumpToLastQuestionPage = (newTotal: number) =>
    questionPaging.setPage(Math.max(0, Math.ceil(newTotal / questionPaging.pageSize) - 1));

  const bankSearchTerm = bankSearch.trim().toLowerCase();
  const filteredBanks = bankSearchTerm
    ? bankList.filter(b => b.name.toLowerCase().includes(bankSearchTerm) || (b.description || '').toLowerCase().includes(bankSearchTerm))
    : bankList;
  const bankPaging = usePagination(filteredBanks, `${bankPickerOpen}:${bankSearchTerm}`, 6);

  const sections = newExam.sections || [];
  const useSections = sections.length > 0;

  const proctoringConfig: Exam['proctoringConfig'] = { ...defaultProctoringConfig, ...(newExam.proctoringConfig || {}) };
  const proctoringMode: ProctoringMode = proctoringConfig.mode === 'UNPROCTORED' ? 'UNPROCTORED' : 'PROCTORED';
  const isUnproctored = proctoringMode === 'UNPROCTORED';
  const autoTerminate = proctoringConfig.autoTerminate !== false;

  const patchProctoring = (patch: Partial<Exam['proctoringConfig']>) =>
    setNewExam(prev => ({ ...prev, proctoringConfig: { ...defaultProctoringConfig, ...(prev.proctoringConfig || {}), ...patch } }));

  const setProctoringMode = (mode: ProctoringMode) => {
    setNewExam(prev => {
      const current = { ...defaultProctoringConfig, ...(prev.proctoringConfig || {}) };
      if ((current.mode === 'UNPROCTORED' ? 'UNPROCTORED' : 'PROCTORED') === mode) return prev;
      let next: Exam['proctoringConfig'] = { ...current, mode };
      // An exam saved as UNPROCTORED comes back with every monitoring switch off. Turning proctoring
      // back on should not produce a "proctored" exam that checks nothing, so start from the
      // workspace's exam defaults in that case.
      const limits = current.violationLimits || defaultViolationLimits;
      const nothingOn = !current.cameraRequired && !current.microphoneRequired && !current.fullScreenEnforced && !current.tabSwitchLimit;
      if (mode === 'PROCTORED' && nothingOn) {
        const d = settings.examDefaults;
        next = {
          ...next,
          cameraRequired: d.cameraRequired,
          microphoneRequired: d.microphoneRequired,
          fullScreenEnforced: d.fullScreenEnforced,
          tabSwitchLimit: d.tabSwitchLimit,
          violationLimits: Object.values(limits).every(v => !v) ? { ...d.violationLimits } : limits,
        };
      }
      return { ...prev, proctoringConfig: next };
    });
  };

  // Super admin requests carry the company picked in this screen, like every other call here.
  const companyScopedPath = (path: string) =>
    isSuperAdmin && effectiveCompanyId ? `${path}${path.includes('?') ? '&' : '?'}companyId=${effectiveCompanyId}` : path;

  const loadQuestionBanks = async () => {
    const reqId = ++bankRequestRef.current;
    setBankListLoading(true);
    setBankListError(null);
    try {
      const data = await apiGet<{ banks: QuestionBank[] }>(companyScopedPath('question_banks.php'));
      if (bankRequestRef.current !== reqId) return;
      setBankList(Array.isArray(data?.banks) ? data.banks : []);
    } catch (e) {
      if (bankRequestRef.current !== reqId) return;
      setBankList([]);
      // A bare (non-JSON) 404 means this server has no question-bank endpoint at all.
      const missing = e instanceof ApiError && e.status === 404 && !e.message.trim().startsWith('{');
      setBankListError(missing
        ? 'Question banks are not available on this server yet.'
        : getApiErrorMessage(e, 'Could not load the question banks. Please try again.'));
    } finally {
      if (bankRequestRef.current === reqId) setBankListLoading(false);
    }
  };

  const openBankPicker = () => {
    setBankSearch('');
    setSelectedBankId(null);
    setBankAddError(null);
    setBankPickerOpen(true);
    loadQuestionBanks();
  };

  const closeBankPicker = () => {
    if (bankAdding) return;
    bankRequestRef.current++;
    setBankListLoading(false);
    setBankPickerOpen(false);
  };

  // The section bank questions land in: the active one, or the first if the active id went stale.
  const bankTargetSection = useSections
    ? (sections.find(s => s.id === activeSectionId) || sections[0])
    : undefined;

  const addSelectedBank = async () => {
    if (bankAdding || selectedBankId === null) return;
    const reqId = ++bankRequestRef.current;
    setBankAdding(true);
    setBankAddError(null);
    try {
      const data = await apiGet<{ bank: QuestionBankDetail }>(
        companyScopedPath(`question_banks.php?id=${encodeURIComponent(String(selectedBankId))}`),
      );
      if (bankRequestRef.current !== reqId) return;
      const bank = data?.bank;
      if (!bank || !Array.isArray(bank.questions)) {
        throw new Error('The server returned an unexpected response for this question bank.');
      }
      const targetSectionId = bankTargetSection?.id;
      const existingIds = new Set((newExam.questions || []).map(q => q.id));
      const seen = new Set<string>();
      const toAdd: Question[] = [];
      bank.questions.forEach(q => {
        if (!q?.id || existingIds.has(q.id) || seen.has(q.id)) return;
        seen.add(q.id);
        toAdd.push({
          ...q,
          bankId: q.bankId ?? bank.id,
          bankName: q.bankName ?? bank.name,
          sectionId: targetSectionId,
          sectionTitle: undefined,
        });
      });
      const skipped = bank.questions.length - toAdd.length;
      if (toAdd.length > 0) {
        setNewExam(prev => {
          const prevIds = new Set((prev.questions || []).map(q => q.id));
          return { ...prev, questions: [...(prev.questions || []), ...toAdd.filter(q => !prevIds.has(q.id))] };
        });
        jumpToLastQuestionPage((newExam.questions?.length || 0) + toAdd.length);
      }
      const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
      setBankNotice(
        bank.questions.length === 0
          ? `“${bank.name}” has no questions yet — add some in the Question Bank tab.`
          : toAdd.length === 0
            ? `All ${plural(bank.questions.length, 'question')} from “${bank.name}” are already in this exam.`
            : `Added ${plural(toAdd.length, 'question')} from “${bank.name}”${bankTargetSection ? ` to ${bankTargetSection.title || 'the active section'}` : ''}.`
              + (skipped > 0 ? ` ${skipped} already in this exam ${skipped === 1 ? 'was' : 'were'} skipped.` : ''),
      );
      setBankPickerOpen(false);
    } catch (e) {
      if (bankRequestRef.current !== reqId) return;
      setBankAddError(getApiErrorMessage(e, 'Could not load this bank’s questions. Please try again.'));
    } finally {
      if (bankRequestRef.current === reqId) setBankAdding(false);
    }
  };

  // Manual Question State — one object holding the fields for every question type.
  // Only the field(s) relevant to `type` are read when building the Question on save.
  const manualQDefaults = {
    type: QuestionType.MCQ,
    text: '',
    options: ['', '', '', ''],   // MCQ / MULTI_SELECT choices
    correctIdx: 0,               // MCQ / TRUE_FALSE / YES_NO single correct option
    correctIndices: [] as number[], // MULTI_SELECT correct options
    blanks: [''],                // FILL_BLANK: each entry = comma-separated accepted answers for that blank
    numericValue: '',            // NUMERIC expected value
    numericTolerance: '',        // NUMERIC +/- tolerance (blank = exact)
    dateValue: '',               // DATE 'YYYY-MM-DD'
    timeValue: '',               // TIME 'HH:MM'
    matchLeft: ['', ''],         // MATCHING left column (row i pairs with right row i)
    matchRight: ['', ''],        // MATCHING right column
    orderItems: ['', ''],        // ORDERING items, entered in the CORRECT order
    dragItems: ['', ''],         // DRAG_DROP items
    dragBuckets: ['', ''],       // DRAG_DROP buckets
    dragItemBucket: [0, 0],      // DRAG_DROP: correct bucket index for each item
    marks: 1,
    negativeMarks: 0,     // deducted if answered but wrong; 0 = no negative marking
    // Kept as a STRING so the field can be left blank, which is what "no limit" is.
    wordLimit: ''
  };
  type ManualQState = typeof manualQDefaults;
  const [manualQ, setManualQ] = useState<ManualQState>(manualQDefaults);

  // Question Upload State
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploadStatus, setUploadStatus] = useState<'IDLE' | 'SUCCESS' | 'ERROR' | 'PARTIAL'>('IDLE');
  const [uploadMsg, setUploadMsg] = useState('');
  const [csvErrors, setCsvErrors] = useState<CsvError[]>([]);



  // Super admin: load the company list for the selector, and default to the first company.
  useEffect(() => {
    if (!isSuperAdmin) return;
    let cancelled = false;
    (async () => {
      try {
        const data = await apiGet<{ companies: CompanyDirectoryRecord[] }>('companies.php');
        if (cancelled) return;
        const list = data?.companies || [];
        setCompanies(list);
        setSelectedCompanyId(current => (current === '' ? (list[0]?.id ?? '') : current));
      } catch (e) {
        console.error('Failed to load companies:', e);
      }
    })();
    return () => { cancelled = true; };
  }, [isSuperAdmin]);

  // Super admin: (re)load the selected company's exams + students whenever the selection changes.
  useEffect(() => {
    if (!isSuperAdmin) return;
    if (!effectiveCompanyId) {
      setSuperExams([]);
      setSuperStudents([]);
      return;
    }
    let cancelled = false;
    (async () => {
      setSuperExamsLoading(true);
      try {
        const [examData, studentData] = await Promise.all([
          apiGet<{ exams: Exam[] }>(`exams.php${companyQuery}`),
          apiGet<{ students: Student[] }>(`students.php${companyQuery}`),
        ]);
        if (cancelled) return;
        setSuperExams(examData?.exams || []);
        setSuperStudents(studentData?.students || []);
      } catch (e) {
        if (!cancelled) console.error('Failed to load company exams:', e);
      } finally {
        if (!cancelled) setSuperExamsLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [isSuperAdmin, effectiveCompanyId]);

  useEffect(() => {
    let cancelled = false;
    const loadBatches = async () => {
      try {
        // A super admin scopes batches to the company chosen in the exam-tab selector, so the
        // assignment picker only offers that company's batches. Until a company is picked there is
        // nothing to load. A regular admin stays scoped to its own company via the request headers.
        if (isSuperAdmin && !effectiveCompanyId) {
          if (!cancelled) setBatches([]);
          return;
        }
        const endpoint = isSuperAdmin ? `batches.php${companyQuery}` : 'batches.php';
        const data = await apiGet<{ batches: Batch[] }>(endpoint);
        if (!cancelled) {
          setBatches(data?.batches || []);
        }
      } catch (e) {
        console.error('Failed to load batches:', e);
      }
    };
    loadBatches();
    return () => {
      cancelled = true;
    };
  }, [isSuperAdmin, effectiveCompanyId]);

  // Escape closes the top-most dialog (none of them handled it). The composer asks before discarding
  // unsaved edits, and the remove dialog stays put while its request is in flight.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (bankPickerOpen) { closeBankPicker(); return; }
      if (showMailPreview) { setShowMailPreview(false); return; }
      if (mailComposer) { closeComposer(); return; }
      if (inviteScopeTarget) { setInviteScopeTarget(null); return; }
      if (deleteTarget && !deleteBusy) setDeleteTarget(null);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [showMailPreview, mailComposer, inviteScopeTarget, deleteTarget, deleteBusy, bankPickerOpen, bankAdding]);

  // Batch Assign State
  const studentBatchInputRef = useRef<HTMLInputElement>(null);
  const examImportRef = useRef<HTMLInputElement>(null);
  const studentCreateInputRef = useRef<HTMLInputElement>(null);

  const createSection = (title: string, order: number) => ({
    id: Math.random().toString(36).substr(2, 9),
    title,
    questionLimit: 0,
    shuffleQuestions: true,
    timeLimitMinutes: 0,
    lockOnComplete: true,
    displayOrder: order,
    questions: []
  });

  const enableSections = () => {
    if (useSections) return;
    const first = createSection('Section 1', 0);
    setNewExam(prev => ({
      ...prev,
      sections: [first],
      questions: (prev.questions || []).map(q => ({ ...q, sectionId: first.id }))
    }));
    setActiveSectionId(first.id);
  };

  const disableSections = () => {
    setNewExam(prev => ({ ...prev, sections: [] }));
    setActiveSectionId(null);
  };

  const getSectionQuestionCount = (sectionId: string) => {
    return (newExam.questions || []).filter(q => q.sectionId === sectionId).length;
  };

  // Split a comma-separated "accepted answers" cell into trimmed, non-empty alternates.
  const parseAccepted = (raw: string): string[] =>
    raw.split(',').map(s => s.trim()).filter(Boolean);

  // Build the per-type Question payload (options / answerKey / matchOptions). Returns an error
  // string if the form is incomplete, otherwise the partial Question fields.
  const buildQuestionByType = (): { error?: string; fields?: Partial<Question> } => {
    const t = manualQ.type;
    switch (t) {
      case QuestionType.MCQ: {
        // Blank option rows (e.g. the 4th default slot on a 3-choice question) are dropped — they used
        // to ship to candidates as empty, clickable answer cards — and the correct index is remapped
        // onto the compacted list.
        const raw = manualQ.options.map(o => o.trim());
        const keptIdx = raw.map((o, i) => (o ? i : -1)).filter(i => i >= 0);
        if (keptIdx.length < 2) return { error: 'Provide at least 2 options.' };
        if (manualQ.correctIdx < 0 || !raw[manualQ.correctIdx]) return { error: 'Mark a non-empty option as the correct answer.' };
        return { fields: { options: keptIdx.map(i => raw[i]), correctOptionIndex: keptIdx.indexOf(manualQ.correctIdx) } };
      }
      case QuestionType.MULTI_SELECT: {
        const raw = manualQ.options.map(o => o.trim());
        const keptIdx = raw.map((o, i) => (o ? i : -1)).filter(i => i >= 0);
        if (keptIdx.length < 2) return { error: 'Provide at least 2 options.' };
        if (manualQ.correctIndices.length < 1) return { error: 'Select at least one correct option.' };
        if (manualQ.correctIndices.some(i => !raw[i])) return { error: 'A ticked correct option is empty — fill it in or untick it.' };
        const correctIndices = manualQ.correctIndices.map(i => keptIdx.indexOf(i)).sort((a, b) => a - b);
        return { fields: { options: keptIdx.map(i => raw[i]), answerKey: { correctIndices } } };
      }
      case QuestionType.TRUE_FALSE:
        return { fields: { options: ['True', 'False'], correctOptionIndex: manualQ.correctIdx } };
      case QuestionType.YES_NO:
        return { fields: { options: ['Yes', 'No'], correctOptionIndex: manualQ.correctIdx } };
      case QuestionType.SHORT_TEXT:
      case QuestionType.LONG_TEXT:
        return { fields: {} }; // graded manually
      case QuestionType.FILL_BLANK: {
        const blanks = manualQ.blanks.map(parseAccepted);
        if (blanks.length === 0 || blanks.some(b => b.length === 0))
          return { error: 'Each blank needs at least one accepted answer.' };
        return { fields: { answerKey: { blanks: blanks.map(accepted => ({ accepted })) } } };
      }
      case QuestionType.NUMERIC: {
        if (manualQ.numericValue.trim() === '' || isNaN(Number(manualQ.numericValue)))
          return { error: 'Enter a valid numeric answer.' };
        const tol = manualQ.numericTolerance.trim();
        return { fields: { answerKey: { value: Number(manualQ.numericValue), tolerance: tol === '' ? null : Number(tol) } } };
      }
      case QuestionType.DATE:
        if (!manualQ.dateValue) return { error: 'Pick the correct date.' };
        return { fields: { answerKey: { value: manualQ.dateValue } } };
      case QuestionType.TIME:
        if (!manualQ.timeValue) return { error: 'Pick the correct time.' };
        return { fields: { answerKey: { value: manualQ.timeValue } } };
      case QuestionType.MATCHING: {
        const rows = manualQ.matchLeft
          .map((l, i) => ({ l: l.trim(), r: (manualQ.matchRight[i] || '').trim() }))
          .filter(p => p.l && p.r);
        if (rows.length < 2) return { error: 'Provide at least 2 complete match pairs.' };
        const pairs: Record<number, number> = {};
        rows.forEach((_, i) => { pairs[i] = i; });
        return { fields: { matchOptions: { left: rows.map(p => p.l), right: rows.map(p => p.r) }, answerKey: { pairs } } };
      }
      case QuestionType.ORDERING: {
        const items = manualQ.orderItems.map(s => s.trim()).filter(Boolean);
        if (items.length < 2) return { error: 'Provide at least 2 items to order.' };
        return { fields: { matchOptions: { items }, answerKey: { order: items.map((_, i) => i) } } };
      }
      case QuestionType.DRAG_DROP: {
        const items = manualQ.dragItems.map(s => s.trim());
        // Blank bucket rows are dropped, so each item's bucket index is remapped onto the compacted
        // list. Without this an item mapped to the bucket after a blank row silently landed one
        // bucket off (wrong answer key) or was rejected as out of range.
        const bucketRemap = new Map<number, number>();
        const buckets: string[] = [];
        manualQ.dragBuckets.forEach((b, i) => {
          const name = b.trim();
          if (name) { bucketRemap.set(i, buckets.length); buckets.push(name); }
        });
        const validItems = items.map((it, i) => ({ it, bucket: bucketRemap.get(manualQ.dragItemBucket[i] ?? 0) })).filter(x => x.it);
        if (validItems.length < 2) return { error: 'Provide at least 2 items.' };
        if (buckets.length < 2) return { error: 'Provide at least 2 buckets.' };
        if (validItems.some(x => x.bucket === undefined)) return { error: 'Every item must map to a non-empty bucket.' };
        const placements: Record<number, number> = {};
        validItems.forEach((x, i) => { placements[i] = x.bucket as number; });
        return { fields: { matchOptions: { items: validItems.map(x => x.it), buckets }, answerKey: { placements } } };
      }
      default:
        return { fields: {} };
    }
  };

  const handleAddManualQuestion = () => {
    if (!manualQ.text.trim()) {
      alert("Please enter the question text.");
      return;
    }

    // Marks are stored as INT and graded all-or-nothing, so 0, negatives, blanks (NaN) and fractions
    // (silently truncated server-side, desyncing the exam's total) are rejected up front.
    if (!Number.isInteger(manualQ.marks) || manualQ.marks < 1) {
      alert("Marks must be a whole number of at least 1.");
      return;
    }

    const built = buildQuestionByType();
    if (built.error) {
      alert(built.error);
      return;
    }

    const isManual = manualQ.type === QuestionType.SHORT_TEXT || manualQ.type === QuestionType.LONG_TEXT;
    const newQuestion: Question = {
      id: Math.random().toString(36).substr(2, 9),
      text: manualQ.text,
      type: manualQ.type,
      marks: manualQ.marks,
      // Manual (free-text) answers are never auto-graded, so a penalty would never apply to them.
      negativeMarks: isManual ? 0 : Math.max(0, Number(manualQ.negativeMarks) || 0),
      // Only descriptive (manual) answers can carry a word limit; blank or non-positive means no limit.
      wordLimit: isManual && parseInt(manualQ.wordLimit, 10) > 0 ? parseInt(manualQ.wordLimit, 10) : null,
      sectionId: useSections ? (activeSectionId || sections[0]?.id) : undefined,
      ...built.fields,
    };

    setNewExam(prev => ({
      ...prev,
      questions: [...(prev.questions || []), newQuestion]
    }));
    // Questions append to the end, so follow them onto the last page — otherwise a newly added
    // question silently lands on a page the admin isn't looking at.
    jumpToLastQuestionPage((newExam.questions?.length || 0) + 1);

    // Reset form, preserving the chosen type for fast entry of similar questions.
    setManualQ({ ...manualQDefaults, type: manualQ.type });
  };

  const updateOption = (idx: number, val: string) => {
    const newOptions = [...manualQ.options];
    newOptions[idx] = val;
    setManualQ({ ...manualQ, options: newOptions });
  };

  // Generic helper to edit a string[] field on manualQ (options, blanks, match columns, etc.).
  const updateListField = (field: keyof ManualQState, idx: number, val: string) => {
    setManualQ(prev => {
      const list = [...(prev[field] as string[])];
      list[idx] = val;
      return { ...prev, [field]: list };
    });
  };
  const addListItem = (field: keyof ManualQState, empty: string | number = '') => {
    setManualQ(prev => ({ ...prev, [field]: [...(prev[field] as any[]), empty] }));
  };
  const removeListItem = (field: keyof ManualQState, idx: number) => {
    setManualQ(prev => {
      const list = [...(prev[field] as any[])];
      if (list.length <= 1) return prev;
      list.splice(idx, 1);
      return { ...prev, [field]: list };
    });
  };
  // Removing an MCQ/Multi-Select option shifts every later option up one slot, so the answer key has
  // to shift with it — otherwise the "correct" mark silently moves to a different option. Removing the
  // correct option itself clears the mark (-1) so the admin must pick again rather than inherit A.
  const removeOption = (idx: number) => {
    setManualQ(prev => {
      if (prev.options.length <= 1) return prev;
      return {
        ...prev,
        options: prev.options.filter((_, i) => i !== idx),
        correctIdx: prev.correctIdx === idx ? -1 : prev.correctIdx > idx ? prev.correctIdx - 1 : prev.correctIdx,
        correctIndices: prev.correctIndices.filter(x => x !== idx).map(x => (x > idx ? x - 1 : x)),
      };
    });
  };
  // Same index-shift problem for Drag & Drop: items point at buckets by position.
  const removeDragBucket = (idx: number) => {
    setManualQ(prev => {
      if (prev.dragBuckets.length <= 1) return prev;
      return {
        ...prev,
        dragBuckets: prev.dragBuckets.filter((_, i) => i !== idx),
        dragItemBucket: prev.dragItemBucket.map(b => (b === idx ? 0 : b > idx ? b - 1 : b)),
      };
    });
  };
  const removeDragItem = (idx: number) => {
    setManualQ(prev => {
      if (prev.dragItems.length <= 1) return prev;
      return {
        ...prev,
        dragItems: prev.dragItems.filter((_, i) => i !== idx),
        dragItemBucket: prev.dragItemBucket.filter((_, i) => i !== idx),
      };
    });
  };

  const inputCls = "w-full px-3 py-2 border rounded-lg outline-none text-sm";
  const smallBtn = "text-xs text-slate-500 hover:text-red-600 px-2";

  // A labelled on/off row (icon, title, one-line explanation, switch) for the proctoring options.
  const renderSwitchRow = ({ icon, label, hint, checked, onChange }: {
    icon: React.ReactNode; label: string; hint: string; checked: boolean; onChange: (checked: boolean) => void;
  }) => (
    <label
      className={`flex items-start gap-3 rounded-lg border p-3 cursor-pointer transition-colors focus-within:ring-2 focus-within:ring-blue-200 ${
        checked ? 'border-blue-200 bg-blue-50/60' : 'border-slate-200 bg-white hover:bg-slate-50'
      }`}
    >
      <span className={`mt-0.5 shrink-0 ${checked ? 'text-[var(--lsc-primary)]' : 'text-slate-400'}`} aria-hidden="true">{icon}</span>
      <span className="flex-1 min-w-0">
        <span className="block text-sm font-medium text-slate-800 leading-snug">{label}</span>
        <span className="block text-[11px] text-slate-500 leading-snug mt-0.5">{hint}</span>
      </span>
      <span className={`w-9 h-5 rounded-full relative transition-colors shrink-0 mt-0.5 ${checked ? 'bg-[var(--lsc-primary)]' : 'bg-slate-300'}`}>
        <input type="checkbox" role="switch" className="sr-only" checked={checked} onChange={e => onChange(e.target.checked)} />
        <span className={`absolute top-1 left-1 bg-white w-3 h-3 rounded-full transition-transform ${checked ? 'translate-x-4' : 'translate-x-0'}`}></span>
      </span>
    </label>
  );

  // The per-question-type answer editor rendered inside the manual-entry form.
  const renderQuestionTypeEditor = () => {
    const t = manualQ.type;

    if (t === QuestionType.SHORT_TEXT || t === QuestionType.LONG_TEXT) {
      return (
        <p className="text-xs text-slate-500 bg-slate-50 border border-slate-200 rounded-lg p-3">
          Free-text answers are reviewed and scored manually in Results after the exam.
        </p>
      );
    }

    if (t === QuestionType.MCQ || t === QuestionType.MULTI_SELECT) {
      const multi = t === QuestionType.MULTI_SELECT;
      return (
        <div className="space-y-2">
          <label className="block text-xs text-slate-500">Options — mark the correct {multi ? 'answers' : 'answer'}</label>
          {manualQ.options.map((opt, i) => (
            <div key={i} className="flex items-center gap-2">
              <input
                type={multi ? 'checkbox' : 'radio'}
                name="mcq-correct"
                checked={multi ? manualQ.correctIndices.includes(i) : manualQ.correctIdx === i}
                onChange={() => {
                  if (multi) {
                    setManualQ(prev => ({
                      ...prev,
                      correctIndices: prev.correctIndices.includes(i)
                        ? prev.correctIndices.filter(x => x !== i)
                        : [...prev.correctIndices, i],
                    }));
                  } else {
                    setManualQ({ ...manualQ, correctIdx: i });
                  }
                }}
              />
              <input
                type="text" className={inputCls}
                placeholder={`Option ${String.fromCharCode(65 + i)}`}
                aria-label={`Option ${String.fromCharCode(65 + i)}`}
                value={opt}
                onChange={e => updateOption(i, e.target.value)}
              />
              <button type="button" className={smallBtn} aria-label={`Remove option ${String.fromCharCode(65 + i)}`} onClick={() => removeOption(i)}>✕</button>
            </div>
          ))}
          <button type="button" className="text-xs text-blue-600 hover:underline" onClick={() => addListItem('options')}>+ Add option</button>
        </div>
      );
    }

    if (t === QuestionType.TRUE_FALSE || t === QuestionType.YES_NO) {
      const labels = t === QuestionType.TRUE_FALSE ? ['True', 'False'] : ['Yes', 'No'];
      return (
        <div className="space-y-2">
          <label className="block text-xs text-slate-500">Correct answer</label>
          <div className="flex gap-4">
            {labels.map((lbl, i) => (
              <label key={i} className="flex items-center gap-2 text-sm">
                <input type="radio" name="tfyn-correct" checked={manualQ.correctIdx === i} onChange={() => setManualQ({ ...manualQ, correctIdx: i })} />
                {lbl}
              </label>
            ))}
          </div>
        </div>
      );
    }

    if (t === QuestionType.FILL_BLANK) {
      return (
        <div className="space-y-2">
          <label className="block text-xs text-slate-500">Accepted answers — one row per blank, comma-separate alternates (case-insensitive)</label>
          {manualQ.blanks.map((b, i) => (
            <div key={i} className="flex items-center gap-2">
              <span className="text-xs text-slate-400 w-14">Blank {i + 1}</span>
              <input type="text" className={inputCls} placeholder="e.g. Paris, paris city" value={b} onChange={e => updateListField('blanks', i, e.target.value)} />
              <button type="button" className={smallBtn} aria-label={`Remove blank ${i + 1}`} onClick={() => removeListItem('blanks', i)}>✕</button>
            </div>
          ))}
          <button type="button" className="text-xs text-blue-600 hover:underline" onClick={() => addListItem('blanks')}>+ Add blank</button>
        </div>
      );
    }

    if (t === QuestionType.NUMERIC) {
      return (
        <div className="flex gap-4">
          <div className="flex-1">
            <label className="block text-xs text-slate-500 mb-1">Correct value</label>
            <input type="number" step="any" className={inputCls} value={manualQ.numericValue} onChange={e => setManualQ({ ...manualQ, numericValue: e.target.value })} />
          </div>
          <div className="flex-1">
            <label className="block text-xs text-slate-500 mb-1">± Tolerance (optional)</label>
            <input type="number" step="any" min="0" className={inputCls} placeholder="Exact" value={manualQ.numericTolerance} onChange={e => setManualQ({ ...manualQ, numericTolerance: e.target.value })} />
          </div>
        </div>
      );
    }

    if (t === QuestionType.DATE) {
      return (
        <div>
          <label className="block text-xs text-slate-500 mb-1">Correct date</label>
          <input type="date" className={inputCls} value={manualQ.dateValue} onChange={e => setManualQ({ ...manualQ, dateValue: e.target.value })} />
        </div>
      );
    }

    if (t === QuestionType.TIME) {
      return (
        <div>
          <label className="block text-xs text-slate-500 mb-1">Correct time</label>
          <input type="time" className={inputCls} value={manualQ.timeValue} onChange={e => setManualQ({ ...manualQ, timeValue: e.target.value })} />
        </div>
      );
    }

    if (t === QuestionType.MATCHING) {
      return (
        <div className="space-y-2">
          <label className="block text-xs text-slate-500">Match pairs — each left item pairs with the right item on the same row (shuffled for the candidate)</label>
          {manualQ.matchLeft.map((l, i) => (
            <div key={i} className="flex items-center gap-2">
              <input type="text" className={inputCls} placeholder={`Left ${i + 1}`} value={l} onChange={e => updateListField('matchLeft', i, e.target.value)} />
              <span className="text-slate-400">↔</span>
              <input type="text" className={inputCls} placeholder={`Right ${i + 1}`} value={manualQ.matchRight[i] || ''} onChange={e => updateListField('matchRight', i, e.target.value)} />
              <button type="button" className={smallBtn} aria-label={`Remove pair ${i + 1}`} onClick={() => { removeListItem('matchLeft', i); removeListItem('matchRight', i); }}>✕</button>
            </div>
          ))}
          <button type="button" className="text-xs text-blue-600 hover:underline" onClick={() => { addListItem('matchLeft'); addListItem('matchRight'); }}>+ Add pair</button>
        </div>
      );
    }

    if (t === QuestionType.ORDERING) {
      return (
        <div className="space-y-2">
          <label className="block text-xs text-slate-500">Items — enter them in the CORRECT order (shuffled for the candidate)</label>
          {manualQ.orderItems.map((it, i) => (
            <div key={i} className="flex items-center gap-2">
              <span className="text-xs text-slate-400 w-5">{i + 1}.</span>
              <input type="text" className={inputCls} placeholder={`Item ${i + 1}`} value={it} onChange={e => updateListField('orderItems', i, e.target.value)} />
              <button type="button" className={smallBtn} aria-label={`Remove item ${i + 1}`} onClick={() => removeListItem('orderItems', i)}>✕</button>
            </div>
          ))}
          <button type="button" className="text-xs text-blue-600 hover:underline" onClick={() => addListItem('orderItems')}>+ Add item</button>
        </div>
      );
    }

    if (t === QuestionType.DRAG_DROP) {
      const buckets = manualQ.dragBuckets;
      return (
        <div className="space-y-3">
          <div className="space-y-2">
            <label className="block text-xs text-slate-500">Buckets / drop zones</label>
            {buckets.map((b, i) => (
              <div key={i} className="flex items-center gap-2">
                <input type="text" className={inputCls} placeholder={`Bucket ${i + 1}`} value={b} onChange={e => updateListField('dragBuckets', i, e.target.value)} />
                <button type="button" className={smallBtn} aria-label={`Remove bucket ${i + 1}`} onClick={() => removeDragBucket(i)}>✕</button>
              </div>
            ))}
            <button type="button" className="text-xs text-blue-600 hover:underline" onClick={() => addListItem('dragBuckets')}>+ Add bucket</button>
          </div>
          <div className="space-y-2">
            <label className="block text-xs text-slate-500">Items — pick the correct bucket for each</label>
            {manualQ.dragItems.map((it, i) => (
              <div key={i} className="flex items-center gap-2">
                <input type="text" className={inputCls} placeholder={`Item ${i + 1}`} value={it} onChange={e => updateListField('dragItems', i, e.target.value)} />
                <select className="px-2 py-2 border rounded-lg text-sm bg-white" value={manualQ.dragItemBucket[i] ?? 0} onChange={e => {
                  const v = Number(e.target.value);
                  setManualQ(prev => { const arr = [...prev.dragItemBucket]; arr[i] = v; return { ...prev, dragItemBucket: arr }; });
                }}>
                  {buckets.map((bk, bi) => <option key={bi} value={bi}>{bk.trim() || `Bucket ${bi + 1}`}</option>)}
                </select>
                <button type="button" className={smallBtn} aria-label={`Remove item ${i + 1}`} onClick={() => removeDragItem(i)}>✕</button>
              </div>
            ))}
            <button type="button" className="text-xs text-blue-600 hover:underline" onClick={() => { addListItem('dragItems'); addListItem('dragItemBucket', 0); }}>+ Add item</button>
          </div>
        </div>
      );
    }

    return null;
  };

  // Compact read-only preview of a saved question's answer, shown in the builder list.
  const renderAddedQuestionAnswer = (q: Question) => {
    const optionTypes = [QuestionType.MCQ, QuestionType.MULTI_SELECT, QuestionType.TRUE_FALSE, QuestionType.YES_NO];
    if (optionTypes.includes(q.type) && q.options?.length) {
      const correct = new Set<number>(
        q.type === QuestionType.MULTI_SELECT
          ? (q.answerKey?.correctIndices || [])
          : (q.correctOptionIndex !== undefined && q.correctOptionIndex !== null ? [q.correctOptionIndex] : [])
      );
      return (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {q.options.map((opt, i) => (
            <div key={i} className={`text-sm p-2 rounded border ${correct.has(i) ? 'bg-teal-50 border-teal-200 text-teal-700' : 'bg-slate-50 border-slate-100 text-slate-600'}`}>
              <span className="font-bold mr-2">{String.fromCharCode(65 + i)}.</span>{opt}
            </div>
          ))}
        </div>
      );
    }
    let summary: string | null = null;
    switch (q.type) {
      case QuestionType.FILL_BLANK:
        summary = 'Answers: ' + (q.answerKey?.blanks || []).map(b => b.accepted.join(' / ')).join('  |  ');
        break;
      case QuestionType.NUMERIC:
        summary = `Answer: ${q.answerKey?.value}${q.answerKey?.tolerance != null ? ` ± ${q.answerKey.tolerance}` : ''}`;
        break;
      case QuestionType.DATE:
      case QuestionType.TIME:
        summary = `Answer: ${q.answerKey?.value}`;
        break;
      case QuestionType.MATCHING:
        summary = (q.matchOptions?.left || []).map((l, i) => `${l} ↔ ${q.matchOptions?.right?.[i] ?? ''}`).join('  |  ');
        break;
      case QuestionType.ORDERING:
        summary = 'Correct order: ' + (q.matchOptions?.items || []).join(' → ');
        break;
      case QuestionType.DRAG_DROP:
        summary = (q.matchOptions?.items || []).map((it, i) => `${it} → ${q.matchOptions?.buckets?.[q.answerKey?.placements?.[i] ?? 0] ?? ''}`).join('  |  ');
        break;
      case QuestionType.SHORT_TEXT:
      case QuestionType.LONG_TEXT:
        summary = 'Manually graded';
        break;
    }
    return summary ? <p className="text-xs text-slate-500 bg-slate-50 border border-slate-100 rounded p-2 whitespace-pre-wrap">{summary}</p> : null;
  };

  const removeQuestion = (id: string) => {
    setNewExam(prev => ({
      ...prev,
      questions: prev.questions?.filter(q => q.id !== id) || []
    }));
  };

  const getStudentIdsForBatchIds = (batchIds: number[]): string[] => {
    if (batchIds.length === 0) return [];
    return Array.from(new Set<string>(
      students
        .filter(student => student.batches.some(b => batchIds.includes(b.id)))
        .map(student => student.id)
    ));
  };

  const toggleBatch = (batchId: number) => {
    const current = newExam.assignedBatchIds || [];
    const nextBatchIds = current.includes(batchId)
      ? current.filter(id => id !== batchId)
      : [...current, batchId];

    // Students picked individually (CSV upload / create-and-assign) are NOT part of any selected batch,
    // so rebuilding the roster from the batch expansion alone would silently drop them. Keep everyone
    // who isn't a member of the batch just unchecked.
    const removedBatchIds = current.filter(id => !nextBatchIds.includes(id));
    const removedStudentIds = new Set(getStudentIdsForBatchIds(removedBatchIds));

    setNewExam(prev => {
      const kept = (prev.assignedStudentIds || []).filter(id => !removedStudentIds.has(id));
      return {
        ...prev,
        assignedBatchIds: nextBatchIds,
        assignedStudentIds: Array.from(new Set([...kept, ...getStudentIdsForBatchIds(nextBatchIds)])),
      };
    });
  };

  // Toggle a device class in the exam's allow-list. We never let the list become empty — that would
  // lock every candidate out — so unchecking the last remaining device is a no-op.
  const toggleDeviceType = (device: DeviceType) => {
    setNewExam(prev => {
      const current = prev.allowedDeviceTypes && prev.allowedDeviceTypes.length > 0
        ? prev.allowedDeviceTypes
        : (['desktop', 'tablet', 'mobile'] as DeviceType[]);
      const next = current.includes(device)
        ? current.filter(d => d !== device)
        : [...current, device];
      if (next.length === 0) return prev;
      return { ...prev, allowedDeviceTypes: next };
    });
  };

  const handleSaveExam = async () => {
    if (savingExam) return;
    if (!newExam.questions?.length) return;
    if (!newExam.title?.trim()) {
        alert("Please enter an exam title.");
        return;
    }
    if (isSuperAdmin && !effectiveCompanyId) {
        alert("Select a company first to create or edit an exam.");
        return;
    }
    if (!Number.isFinite(newExam.startTime) || !Number.isFinite(newExam.endTime)) {
        alert("Please set a valid start and end time.");
        return;
    }
    if (newExam.startTime! >= newExam.endTime!) {
        alert("End time must be after start time");
        return;
    }
    // The API rejects duration <= 0 (and truncates fractions), which used to surface only as the
    // generic "Failed to save" alert.
    const durationNum = Number(newExam.durationMinutes);
    if (!Number.isInteger(durationNum) || durationNum < 1) {
        alert("Duration must be a whole number of minutes (at least 1).");
        return;
    }

    // With sections on, the API persists ONLY the questions listed inside a section. A question whose
    // sectionId matches no section would be silently dropped while still counted in totalMarks, so
    // route any such orphan into the first section instead.
    const sectionIdSet = new Set(sections.map(s => s.id));
    const resolveSectionId = (q: Question) => (q.sectionId && sectionIdSet.has(q.sectionId) ? q.sectionId : sections[0]?.id);
    const sectionsPayload = useSections
      ? sections.map((section, idx) => ({
          id: section.id,
          title: section.title,
          displayOrder: idx,
          questionLimit: section.questionLimit ?? 0,
          shuffleQuestions: section.shuffleQuestions ?? true,
          timeLimitMinutes: section.timeLimitMinutes ?? 0,
          lockOnComplete: section.lockOnComplete ?? true,
          questions: (newExam.questions || []).filter(q => resolveSectionId(q) === section.id)
        }))
      : [];

    const payload: Exam = {
      ...(newExam as Exam),
      id: newExam.id || Math.random().toString(36).substr(2, 9),
      status: newExam.status || 'DRAFT',
      totalMarks: newExam.questions.reduce((sum, q) => sum + q.marks, 0),
      sections: sectionsPayload,
      proctoringConfig: effectiveProctoringConfig(proctoringConfig),
      assignedBatchIds: newExam.assignedBatchIds || [],
      // Union, not replacement: batch members PLUS anyone assigned individually. The server re-expands
      // the batches too, so students added to an assigned batch since the last save get picked up.
      assignedStudentIds: Array.from(new Set([
        ...(newExam.assignedStudentIds || []),
        ...getStudentIdsForBatchIds(newExam.assignedBatchIds || []),
      ])),
    };

    setSavingExam(true);
    try {
      const result = await apiPost<{ exam: Exam }>('exams.php', withCompany({ exam: payload }));
      const savedExam = result.exam || payload;
      onUpdateExams(prev => {
        const exists = prev.some(e => e.id === savedExam.id);
        return exists ? prev.map(e => (e.id === savedExam.id ? savedExam : e)) : [savedExam, ...prev];
      });
    } catch (e) {
      console.error(e);
      alert(`Failed to save exam: ${apiErrorMessage(e, 'the server did not accept the request. Please try again.')}`);
      return;
    } finally {
      setSavingExam(false);
    }

    resetForm();
  };

  const handleEditExam = (exam: Exam) => {
    const normalizedSections = (exam.sections || []).map((section, idx) => ({
      ...section,
      displayOrder: section.displayOrder ?? idx,
      questionLimit: section.questionLimit ?? 0,
      shuffleQuestions: section.shuffleQuestions ?? true,
      timeLimitMinutes: section.timeLimitMinutes ?? 0,
      lockOnComplete: section.lockOnComplete ?? true,
    }));
    const sectionMap = new Map<string, string>();
    if (normalizedSections.length > 0) {
      normalizedSections.forEach(section => {
        section.questions.forEach(q => {
          sectionMap.set(q.id, section.id);
        });
      });
    }
    const questionsWithSections = (exam.questions || []).map(q => ({
      ...q,
      sectionId: sectionMap.get(q.id)
    }));
    const editable: Partial<Exam> = {
        ...exam,
        sections: normalizedSections,
        assignedStudentIds: exam.assignedStudentIds || [],
        assignedBatchIds: exam.assignedBatchIds || [],
        questions: questionsWithSections,
        shuffleQuestions: exam.shuffleQuestions ?? true, // Default to true if undefined
        allowedDeviceTypes: exam.allowedDeviceTypes && exam.allowedDeviceTypes.length > 0
          ? exam.allowedDeviceTypes
          : ['desktop', 'tablet', 'mobile'],
        showResults: exam.showResults ?? false,
        certificateEnabled: exam.certificateEnabled ?? false,
        feedbackEnabled: exam.feedbackEnabled ?? true,
        reconnectLimit: exam.reconnectLimit ?? 0,
        passPercent: exam.passPercent ?? 60,
        proctoringConfig: {
          ...defaultProctoringConfig,
          ...(exam.proctoringConfig || {}),
          tabSwitchLimit: Math.max(0, Number(exam.proctoringConfig?.tabSwitchLimit ?? defaultProctoringConfig.tabSwitchLimit)),
          violationLimits: {
            ...defaultViolationLimits,
            ...(exam.proctoringConfig?.violationLimits || {})
          },
          proctorTiming: {
            ...defaultProctorTiming,
            ...(exam.proctoringConfig?.proctorTiming || {})
          }
        },
        notificationConfig: exam.notificationConfig || {
        enabled: false,
        reminders: { hours24: true, hours1: true },
        customSubject: `Reminder: ${exam.title}`,
        customMessage: 'Please ensure your environment is ready 15 minutes before the exam starts.'
      }
    };
    setNewExam(editable);
    editorSnapshotRef.current = JSON.stringify(editable);
    if (exam.sections && exam.sections.length > 0) {
      setActiveSectionId(exam.sections[0].id);
    } else {
      setActiveSectionId(null);
    }
    setSelectedTemplateId(null);
    setIsCreating(true);
    setUploadStatus('IDLE');
    setCsvErrors([]);
    setBankNotice(null);
  };

  const resetForm = () => {
    setIsCreating(false);
    setShowPreview(false);
    setActiveSectionId(null);
    setSelectedTemplateId(null);
    const fresh = buildExamDefaults();
    setNewExam(fresh);
    editorSnapshotRef.current = JSON.stringify(fresh);
    setUploadStatus('IDLE');
    setCsvErrors([]);
    setBankNotice(null);
  };

  // Cancel used to drop every unsaved edit (a whole question paper) on a single misclick.
  const handleCancelEdit = () => {
    if (JSON.stringify(newExam) !== editorSnapshotRef.current
      && !confirm('Discard your unsaved changes to this exam?')) return;
    resetForm();
  };

  const handleDuplicateExam = async (source: Exam) => {
    if (duplicatingId) return;
    const makeId = () => Math.random().toString(36).substr(2, 9);
    const now = Date.now();
    const durationMs = (source.durationMinutes || 0) * 60000;
    const windowMs = source.startTime && source.endTime ? Math.max(source.endTime - source.startTime, durationMs) : durationMs;
    const startTime = now + 86400000;
    const endTime = startTime + (windowMs || durationMs || 3600000);

    const questionIdMap = new Map<string, string>();
    const sectionIdMap = new Map<string, string>();

    // Question Bank questions are linked, not copied: the copy keeps their ids so it uses the same
    // shared bank questions. Every other question gets a fresh id (a real copy).
    const cloneId = (q: Question) => (q.bankId ? q.id : makeId());
    (source.questions || []).forEach(q => questionIdMap.set(q.id, cloneId(q)));
    (source.sections || []).forEach(section => {
      sectionIdMap.set(section.id, makeId());
      (section.questions || []).forEach(q => {
        if (!questionIdMap.has(q.id)) questionIdMap.set(q.id, cloneId(q));
      });
    });

    const clonedSections = (source.sections || []).map((section, idx) => {
      const newSectionId = sectionIdMap.get(section.id) || makeId();
      return {
        ...section,
        id: newSectionId,
        displayOrder: section.displayOrder ?? idx,
        questions: (section.questions || []).map(q => ({
          ...q,
          id: questionIdMap.get(q.id) || makeId(),
          sectionId: newSectionId
        }))
      };
    });

    const clonedQuestions = clonedSections.length > 0
      ? clonedSections.flatMap(section => section.questions.map(q => ({ ...q, sectionId: section.id })))
      : (source.questions || []).map(q => ({
          ...q,
          id: questionIdMap.get(q.id) || makeId()
        }));

    const payload: Exam = {
      ...source,
      id: makeId(),
      title: `Copy of ${source.title}`,
      status: 'DRAFT',
      startTime,
      endTime,
      questions: clonedQuestions,
      sections: clonedSections,
      totalMarks: clonedQuestions.reduce((sum, q) => sum + (q.marks || 0), 0),
      assignedStudentIds: [],
      assignedBatchIds: [],
      // Server-computed roster counters and per-exam mail overrides belong to the SOURCE exam. The
      // API echoes the payload back, so spreading them made the brand-new, unassigned copy show the
      // source's "N to invite" / "N not attempted" badges and mail template until the next reload.
      pendingInviteCount: 0,
      notAttemptedCount: 0,
      mailTemplates: {},
      notificationConfig: {
        enabled: false,
        reminders: source.notificationConfig?.reminders || { hours24: false, hours1: false },
        customSubject: source.notificationConfig?.customSubject || '',
        customMessage: source.notificationConfig?.customMessage || '',
      }
    };

    setDuplicatingId(source.id);
    try {
      const result = await apiPost<{ exam: Exam }>('exams.php', withCompany({ exam: payload }));
      const savedExam = result.exam || payload;
      onUpdateExams(prev => [savedExam, ...prev]);
    } catch (e) {
      console.error(e);
      alert(`Failed to duplicate exam: ${apiErrorMessage(e, 'please try again.')}`);
    } finally {
      setDuplicatingId(null);
    }
  };

  const handleDeleteExam = (exam: Exam) => {
    setDeleteTarget(exam);
  };

  const handleArchiveExam = async () => {
    if (!deleteTarget || deleteBusy) return;
    setDeleteBusy(true);
    try {
      // Status-only ARCHIVE action rather than re-POSTing the whole exam: the full upsert rewrites
      // every question/section/assignment row just to flip a flag, and it re-validates the schedule,
      // so a legacy exam with a bad window (end <= start, 0 duration) could never be archived.
      await apiPost('exams.php', withCompany({ action: 'ARCHIVE', id: deleteTarget.id }));
      // Keep it in state as ARCHIVED (what a reload returns too); the grid hides archived exams.
      onUpdateExams(prev => prev.map(e => (e.id === deleteTarget.id ? { ...e, status: 'ARCHIVED' } : e)));
    } catch (e) {
      console.error('Failed to archive exam:', e);
      alert(`Failed to archive exam: ${apiErrorMessage(e, 'please try again.')}`);
    } finally {
      setDeleteBusy(false);
      setDeleteTarget(null);
    }
  };

  const handlePermanentDeleteExam = async () => {
    if (!deleteTarget || deleteBusy) return;
    // exam_sessions (and through them session_answers / violation_logs) are ON DELETE CASCADE from
    // exams, so this wipes every candidate's attempt and result for the exam — irreversibly.
    if (!confirm(`Permanently delete "${deleteTarget.title}"?\n\nThis also erases every candidate attempt, answer, violation log and result recorded for this exam. It cannot be undone — choose Archive instead to keep them.`)) return;
    setDeleteBusy(true);
    try {
      await apiPost('exams.php', withCompany({ action: 'DELETE', id: deleteTarget.id, permanent: true }));
      onUpdateExams(prev => prev.filter(e => e.id !== deleteTarget.id));
    } catch (e) {
      console.error('Failed to delete exam permanently:', e);
      alert(`Failed to delete exam permanently: ${apiErrorMessage(e, 'please try again.')}`);
    } finally {
      setDeleteBusy(false);
      setDeleteTarget(null);
    }
  };

  // --- WhatsApp (optional companion to the invitation / reminder emails) ---
  useEffect(() => {
    let cancelled = false;
    apiGet<WhatsAppStatus>('whatsapp.php')
      .then(status => { if (!cancelled) setWaStatus(status); })
      .catch(() => { if (!cancelled) setWaStatus(null); }); // unavailable = treated as "off"
    return () => { cancelled = true; };
  }, []);

  const waReadyFor = (kind: ExamMailKind): boolean => !!waStatus?.ready && !!waStatus.kinds?.[kind];

  // Which of these recipients have a mobile number (for the "N of M" hint). Best-effort.
  const loadWaCoverage = async (exam: Exam, recipients: ExamRecipient[]) => {
    setWaCoverage(null);
    const ids = recipients.map(r => r.id);
    const withMobile = new Set<string>();
    try {
      for (let i = 0; i < ids.length; i += 5000) {
        const res = await apiPost<{ withMobile: string[] }>('whatsapp.php', withCompany({ action: 'COVERAGE', studentIds: ids.slice(i, i + 5000) }));
        (res?.withMobile || []).forEach(id => withMobile.add(id));
      }
    } catch (e) {
      console.error('Could not check which students have a mobile number:', e);
    }
    setWaCoverage({ examId: exam.id, ids: withMobile });
  };

  // Send the WhatsApp copy to students whose email went out, in small chunks so no single request
  // runs long. Counts are summed across chunks.
  const sendWhatsAppNotices = async (exam: Exam, studentIds: string[], kind: ExamMailKind): Promise<WhatsAppSendSummary> => {
    const total: WhatsAppSendSummary = { sent: 0, failed: 0, skippedNoMobile: 0, skippedDisabled: 0, failures: [] };
    for (let i = 0; i < studentIds.length; i += 25) {
      const res = await apiPost<WhatsAppSendSummary>('whatsapp.php', withCompany({
        action: 'SEND_EXAM_NOTICE',
        examId: exam.id,
        kind,
        studentIds: studentIds.slice(i, i + 25),
      }));
      total.sent += res?.sent || 0;
      total.failed += res?.failed || 0;
      total.skippedNoMobile += res?.skippedNoMobile || 0;
      total.skippedDisabled += res?.skippedDisabled || 0;
      total.failures.push(...(res?.failures || []));
    }
    return total;
  };

  // "Also send on WhatsApp (N of M recipients have a mobile number)" — shared by the invitation
  // dialog and the Mail Composer. Renders nothing when WhatsApp isn't ready for this kind.
  const renderWhatsAppOptIn = (exam: Exam, kind: ExamMailKind, targets: ExamRecipient[]) => {
    if (!waReadyFor(kind)) return null;
    const coverage = waCoverage && waCoverage.examId === exam.id ? waCoverage.ids : null;
    const withMobile = coverage ? targets.filter(t => coverage.has(t.id)).length : null;
    return (
      <label className="flex items-start gap-2 text-sm text-slate-700 cursor-pointer select-none">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={waOptIn}
          onChange={e => setWaOptIn(e.target.checked)}
        />
        <span className="flex items-center gap-1.5 flex-wrap">
          <MessageCircle size={14} className="text-emerald-600 shrink-0" aria-hidden="true" />
          Also send on WhatsApp
          <span className="text-slate-500">
            {withMobile === null
              ? '(checking mobile numbers…)'
              : `(${withMobile} of ${targets.length} recipient${targets.length === 1 ? ' has' : 's have'} a mobile number)`}
          </span>
        </span>
      </label>
    );
  };

  // --- Email System Logic ---
  // Resolve the real recipients for an exam. When students are explicitly assigned we fetch them
  // from the server so cross-company assignments (a super admin can pick batches from any company)
  // carry each student's OWN companyId — the local `students` prop only holds one company. With no
  // assignments the exam goes to every locally-loaded student, as before.
  // invitedAt is null for students assigned since the last invitation run — the only ones who still
  // need a link. Students loaded from the local list (exam with no explicit assignment = everyone)
  // have never been tracked, so they count as uninvited.
  const resolveRecipients = async (exam: Exam, requireTokens = false): Promise<ExamRecipient[]> => {
    let recipients: ExamRecipient[];
    if (exam.assignedStudentIds && exam.assignedStudentIds.length > 0) {
      const data = await apiGet<{ recipients: ExamRecipient[] }>(`exams.php?recipients=${encodeURIComponent(exam.id)}`);
      recipients = data?.recipients || [];
    } else {
      const fallbackCompany = getAdminCompanyId();
      // No assignment list means "every student", so the enriched recipients payload doesn't apply —
      // pull the exam's attempt map separately so the composer can still target non-attempters.
      let attempts: Record<string, { attemptCount: number; attemptStatus: ExamRecipient['attemptStatus']; completed: boolean; lastAttemptAt: number | null }> = {};
      try {
        const data = await apiGet<{ attempts: typeof attempts }>(`exams.php?attempts=${encodeURIComponent(exam.id)}`);
        attempts = data?.attempts || {};
      } catch (e) {
        // Attempt data is an audience filter, not a send requirement — a failure here must not block
        // an invitation going out, so fall back to treating everyone as not-yet-attempted.
        console.error('Could not load attempt status for this exam:', e);
      }
      recipients = students.map(s => ({
        id: s.id,
        fullName: s.fullName,
        email: s.email,
        registrationId: s.registrationId,
        companyId: s.companyId ?? fallbackCompany,
        invitedAt: null,
        attemptCount: attempts[s.id]?.attemptCount ?? 0,
        attemptStatus: attempts[s.id]?.attemptStatus ?? 'NOT_STARTED',
        completed: attempts[s.id]?.completed ?? false,
        lastAttemptAt: attempts[s.id]?.lastAttemptAt ?? null,
      }));
    }
    // Only invitation emails and CSV export need a ?token= link; reminders carry none, so skip the
    // mint round-trip entirely for them. When links ARE needed we ask the server to mint SIGNED
    // access tokens — the browser can't sign (no secret), so a client-built token would be forgeable,
    // which is what stops a candidate editing their link to impersonate another student.
    if (requireTokens && recipients.length > 0) {
      // Let a mint failure propagate to the caller, which alerts and aborts. Silently returning
      // token-less recipients would ship invitations/CSV rows with an empty (useless) link.
      recipients = await mintAccessTokens(exam, recipients);
    }
    return recipients;
  };

  // Ask the server to mint SIGNED access tokens for exactly these recipients. Throws if any token is
  // missing so a caller never mails an invitation with an empty (useless) link.
  const mintAccessTokens = async (exam: Exam, recipients: ExamRecipient[]): Promise<ExamRecipient[]> => {
    if (recipients.length === 0) return recipients;
    const { tokens, codes } = await apiPost<{ tokens: Record<string, string>; codes?: Record<string, string> }>('exams.php', {
      action: 'MINT_ACCESS_TOKENS',
      examId: exam.id,
      studentIds: recipients.map(r => r.id),
    });
    const withTokens = recipients.map(r => ({ ...r, token: tokens?.[r.id], code: codes?.[r.id] || undefined }));
    const missing = withTokens.filter(r => !r.token);
    if (missing.length > 0) {
      throw new Error(
        `Could not generate secure exam links for ${missing.length} recipient(s). Nothing was sent — please try again.`
      );
    }
    return withTokens;
  };

  // The card's one-click "Notify" invitation blast. Reminders (and any targeted send) go through the
  // Mail Composer instead, which is where the audience and the copy are chosen.
  const handleSendEmail = async (exam: Exam) => {
    setEmailSendingId(exam.id);
    setSendingMode('notify');

    let recipients: ExamRecipient[] = [];
    try {
      // Invitations need signed links, so mint them up front.
      recipients = await resolveRecipients(exam, true);
    } catch (e: any) {
      console.error(e);
      alert(apiErrorMessage(e, 'Failed to load the recipient list for this exam.'));
      return;
    } finally {
      setEmailSendingId(null);
      setSendingMode(null);
    }

    if (recipients.length === 0) {
      alert('No recipients found for this exam. Assign students or batches first.');
      return;
    }

    const pending = recipients.filter(r => !r.invitedAt);

    // Mixed roster — students were added after the exam went out. Re-mailing everyone would push a
    // duplicate invitation at candidates who may already be sitting the exam, so make it a choice.
    const waInvites = waReadyFor('INVITE');
    if (waInvites) {
      setWaOptIn(true);
      void loadWaCoverage(exam, recipients);
    }

    if (pending.length > 0 && pending.length < recipients.length) {
      setInviteScopeTarget({ exam, recipients, pending });
      return;
    }

    // When every student already has a link, say so — the old prompt read like a first send and made
    // it easy to re-mail a whole roster that may already be sitting the exam.
    const confirmText = pending.length === 0
      ? `All ${recipients.length} assigned students have already been sent a link. Resend the same invitation to all of them?`
      : `Are you sure you want to send exam invitations to ${recipients.length} students?`;
    if (waInvites) {
      // Same question, in the in-app dialog so the WhatsApp opt-in can sit next to the send button.
      setInviteScopeTarget({ exam, recipients, pending, confirmText });
      return;
    }
    if (!confirm(confirmText)) return;
    await dispatchEmails(exam, recipients, false);
  };

  const dispatchEmails = async (
    exam: Exam,
    targetStudents: ExamRecipient[],
    reminder: boolean,
    override?: { subject?: string; message?: string },
    // Also send the WhatsApp copy to the students whose email went out (caller checked readiness).
    whatsapp = false,
  ) => {
    setEmailSendingId(exam.id);
    setSendingMode(reminder ? 'reminder' : 'notify');

    try {
        const messages = targetStudents.map(student => {
          // Reminder emails carry the exam details only — no access link/token.
          // The token is minted+signed server-side (resolveRecipients); we never build it here.
          let link = '';
          if (!reminder && (student.code || student.token)) {
            link = examLinkFor(student);
          }

          const { subject, body } = buildExamEmailContent(exam, student.fullName, link, reminder, override);

          // Normalise the address — emails typed in ALL CAPS or Mixed Case go to the
          // same mailbox, so send to the correctly-formatted lowercase address.
          // Instructions are linked in the body (instructionsBlock), not attached — see above.
          return { to: student.email.trim().toLowerCase(), subject, body };
        });

        // withCompany: notify.php scopes SMTP + delivery logs by company, like every other write here;
        // without it a super admin's send was rejected ("companyId is required") or logged under
        // whichever company the top bar happened to hold.
        const result = await apiPost<{ sent: number; failed?: { to: string; error: string }[] }>('notify.php', withCompany({ messages }));

        // Record who actually received a link. Addresses that bounced stay uninvited so the next send
        // retries them instead of quietly leaving those students without a way in.
        const failedTo = new Set((result.failed || []).map(f => (f.to || '').trim().toLowerCase()));
        const deliveredIds = targetStudents
          .filter(s => !failedTo.has(s.email.trim().toLowerCase()))
          .map(s => s.id);
        if (!reminder) {
          if (deliveredIds.length > 0) {
            try {
              await apiPost('exams.php', withCompany({ action: 'MARK_INVITED', examId: exam.id, studentIds: deliveredIds }));
              onUpdateExams(prev => prev.map(e => e.id === exam.id
                ? { ...e, pendingInviteCount: Math.max(0, (e.pendingInviteCount ?? 0) - deliveredIds.length) }
                : e));
            } catch (err) {
              console.error('Invitations were sent but could not be recorded:', err);
            }
          }
        }

        // WhatsApp copy for the students whose email went out. A WhatsApp problem is reported in the
        // same summary but never undoes or blocks the email side, which has already happened.
        let waLine = '';
        if (whatsapp && deliveredIds.length > 0) {
          try {
            const wa = await sendWhatsAppNotices(exam, deliveredIds, reminder ? 'REMINDER' : 'INVITE');
            const parts = [`${wa.sent} sent`];
            if (wa.failed > 0) parts.push(`${wa.failed} failed`);
            if (wa.skippedNoMobile > 0) parts.push(`${wa.skippedNoMobile} without a mobile number`);
            if (wa.skippedDisabled > 0) parts.push(`${wa.skippedDisabled} skipped (WhatsApp not configured)`);
            waLine = `\nWhatsApp: ${parts.join(', ')}.`;
            if (wa.failures.length > 0) {
              waLine += ` First error: ${wa.failures[0].error}`;
            }
          } catch (err) {
            console.error('WhatsApp send failed:', err);
            waLine = `\nWhatsApp: ${apiErrorMessage(err, 'the WhatsApp messages could not be sent.')}`;
          }
        }

        if (result.failed && result.failed.length > 0) {
          alert(`Sent ${result.sent} emails. Failed: ${result.failed.length}. Check server response for details.${waLine}`);
        } else {
          alert(`Success! ${reminder ? 'Reminders' : 'Invitations'} sent to ${result.sent} students.${waLine}`);
        }
    } catch (e) {
        console.error(e);
        alert("Failed to send emails. Please try again.");
    } finally {
        setEmailSendingId(null);
        setSendingMode(null);
    }
  };

  // --- Mail Composer ---
  // Opens the per-exam composer, seeded with that exam's saved template (or the built-in default) and
  // with the recipient list loaded in the background so audience counts are live.
  const openMailComposer = async (exam: Exam, kind: ExamMailKind) => {
    const tpl = resolveExamMailTemplate(exam, kind === 'REMINDER');
    setMailComposer({
      exam,
      kind,
      subject: tpl.subject,
      message: tpl.message,
      // A reminder exists to chase people who haven't sat the exam; an invitation defaults to the
      // students who have never been sent a link.
      audience: kind === 'REMINDER' ? 'NOT_ATTEMPTED' : 'NOT_INVITED',
      recipients: [],
      loading: true,
      saving: false,
      dirty: false,
      error: null,
      notice: null,
    });

    try {
      // Tokens are minted at send time for the filtered audience only, so skip them here.
      const recipients = await resolveRecipients(exam, false);
      setMailComposer(prev => (prev && prev.exam.id === exam.id ? { ...prev, recipients, loading: false } : prev));
      if (waReadyFor('INVITE') || waReadyFor('REMINDER')) {
        setWaOptIn(true);
        void loadWaCoverage(exam, recipients);
      }
    } catch (e: any) {
      console.error(e);
      setMailComposer(prev => (prev && prev.exam.id === exam.id
        ? { ...prev, loading: false, error: apiErrorMessage(e, 'Failed to load the recipient list for this exam.') }
        : prev));
    }
  };

  // Closing (X / Cancel / Escape) used to drop an edited subject/message without a word, while
  // switching kinds below already asked first — ask on close too. Not while a save/mint is running.
  const closeComposer = () => {
    if (!mailComposer || mailComposer.saving) return;
    if (mailComposer.dirty && !confirm('Discard your unsaved changes to this email?')) return;
    setMailComposer(null);
  };

  // Switching between Invitation and Reminder swaps in that kind's template. Unsaved edits would be
  // lost, so confirm first.
  const switchComposerKind = (kind: ExamMailKind) => {
    setMailComposer(prev => {
      if (!prev || prev.kind === kind) return prev;
      if (prev.dirty && !confirm('Discard your unsaved changes to this email?')) return prev;
      const tpl = resolveExamMailTemplate(prev.exam, kind === 'REMINDER');
      return { ...prev, kind, subject: tpl.subject, message: tpl.message, dirty: false, notice: null };
    });
  };

  // Mirror what SAVE_MAIL_TEMPLATE stored (or cleared) into the exam list.
  type SavedMailTemplateResponse = { ok?: boolean; cleared?: boolean; template?: ExamMailTemplate | null };
  const applySavedMailTemplate = (examId: string, kind: ExamMailKind, result: SavedMailTemplateResponse) =>
    onUpdateExams(prev => prev.map(e => {
      if (e.id !== examId) return e;
      const next = { ...(e.mailTemplates || {}) };
      if (result?.cleared || !result?.template) delete next[kind];
      else next[kind] = { subject: result.template.subject ?? '', message: result.template.message ?? '', options: result.template.options || {} };
      return { ...e, mailTemplates: next };
    }));

  // Persist the composed subject/message as this exam's default for that kind, so the next send (and
  // the next admin) starts from it. Sending does NOT require saving.
  const saveComposerTemplate = async () => {
    const composer = mailComposer;
    if (!composer) return;
    setMailComposer(prev => (prev ? { ...prev, saving: true, notice: null, error: null } : prev));
    try {
      // No `options` in the request: the server keeps the design set in the exam editor's Emails
      // section and returns the stored template.
      const result = await apiPost<SavedMailTemplateResponse>('exams.php', withCompany({
        action: 'SAVE_MAIL_TEMPLATE',
        examId: composer.exam.id,
        kind: composer.kind,
        subject: composer.subject,
        message: composer.message,
      }));
      applySavedMailTemplate(composer.exam.id, composer.kind, result);
      setMailComposer(prev => (prev ? { ...prev, saving: false, dirty: false, notice: 'Saved as this exam’s default email.' } : prev));
    } catch (e: any) {
      console.error(e);
      setMailComposer(prev => (prev ? { ...prev, saving: false, error: apiErrorMessage(e, 'Could not save this email template.') } : prev));
    }
  };

  // Clear the saved override and go back to the built-in default copy.
  const resetComposerTemplate = async () => {
    const composer = mailComposer;
    if (!composer) return;
    if (!confirm('Reset this email back to the built-in default text?')) return;
    setMailComposer(prev => (prev ? { ...prev, saving: true, notice: null, error: null } : prev));
    try {
      // Resets the TEXT only; a design saved in the exam editor (colour, blocks…) is kept.
      const result = await apiPost<SavedMailTemplateResponse>('exams.php', withCompany({
        action: 'SAVE_MAIL_TEMPLATE',
        examId: composer.exam.id,
        kind: composer.kind,
        subject: '',
        message: '',
      }));
      const bare: Exam = { ...composer.exam, mailTemplates: {}, notificationConfig: undefined };
      const tpl = resolveExamMailTemplate(bare, composer.kind === 'REMINDER');
      applySavedMailTemplate(composer.exam.id, composer.kind, result);
      setMailComposer(prev => (prev
        ? { ...prev, saving: false, dirty: false, subject: tpl.subject, message: tpl.message, notice: 'Restored the default email.' }
        : prev));
    } catch (e: any) {
      console.error(e);
      setMailComposer(prev => (prev ? { ...prev, saving: false, error: apiErrorMessage(e, 'Could not reset this email template.') } : prev));
    }
  };

  const sendFromComposer = async () => {
    const composer = mailComposer;
    if (!composer) return;

    const targets = filterByAudience(composer.recipients, composer.audience);
    if (targets.length === 0) {
      alert('No students match the selected audience, so there is nothing to send.');
      return;
    }
    if (composer.subject.trim() === '' || composer.message.trim() === '') {
      alert('Please provide both a subject and a message before sending.');
      return;
    }

    const kindLabel = composer.kind === 'REMINDER' ? 'reminder' : 'invitation';
    if (!confirm(`Send this ${kindLabel} to ${targets.length} student${targets.length === 1 ? '' : 's'}?`)) return;

    // Only invitations carry an access link, so only they need signed tokens — and only for the
    // filtered audience, not the whole roster.
    let sendTargets = targets;
    if (composer.kind === 'INVITE') {
      setMailComposer(prev => (prev ? { ...prev, saving: true, error: null } : prev));
      try {
        sendTargets = await mintAccessTokens(composer.exam, targets);
      } catch (e: any) {
        console.error(e);
        setMailComposer(prev => (prev ? { ...prev, saving: false, error: apiErrorMessage(e, 'Could not generate secure exam links. Nothing was sent.') } : prev));
        return;
      }
    }

    setMailComposer(null);
    await dispatchEmails(composer.exam, sendTargets, composer.kind === 'REMINDER', {
      subject: composer.subject,
      message: composer.message,
    }, waReadyFor(composer.kind) && waOptIn);
  };

  // --- Link Generation & Export ---
  const handleExportLinks = async (exam: Exam) => {
    if (exportingLinksId) return;
    // CSV Header
    const csvRows = [
      ["Student Name", "Registration ID", "Email", "Exam Link", "Valid From", "Valid Until", "Invite Status"]
    ];

    // Resolve recipients server-side so cross-company assignments carry each student's own companyId.
    // requireTokens=true: a mint failure throws here rather than exporting rows with empty links.
    let targetStudents: ExamRecipient[];
    setExportingLinksId(exam.id);
    try {
      targetStudents = await resolveRecipients(exam, true);
    } catch (e: any) {
      console.error(e);
      alert(apiErrorMessage(e, 'Failed to generate exam links for export.'));
      return;
    } finally {
      setExportingLinksId(null);
    }

    if (targetStudents.length === 0) {
      alert('No recipients found for this exam. Assign students or batches first.');
      return;
    }

    targetStudents.forEach(student => {
      // The signed token / short code is minted server-side (resolveRecipients, validated non-empty
      // above). Never build a token client-side — an unsigned one would be forgeable.
      const link = examLinkFor(student);

      // Lets an admin filter the sheet down to students who were added after the invitations went out.
      const inviteStatus = student.invitedAt
        ? `Sent ${formatScheduleShort(student.invitedAt, resolveExamTimezone(exam.timezone))}`
        : 'Not sent';

      csvRows.push([
        csvCell(student.fullName),
        csvCell(student.registrationId),
        csvCell(student.email),
        csvCell(link),
        csvCell(formatScheduleShort(exam.startTime, resolveExamTimezone(exam.timezone))),
        csvCell(formatScheduleShort(exam.endTime, resolveExamTimezone(exam.timezone))),
        csvCell(inviteStatus)
      ]);
    });

    const encodedUri = csvDataUri(csvRows.map(e => e.join(",")).join("\n"));
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    link.setAttribute("download", `${exam.title.replace(/\s+/g, '_')}_Links.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  // --- Bulk Upload Logic (Questions) ---
  const downloadTemplate = () => {
    // Same format the Question Bank tab uses (services/questionCsv.ts); the optional Section column
    // only appears when Sections is switched on for this exam.
    const encodedUri = csvDataUri(buildQuestionCsvTemplate(useSections ? { sections } : {}));
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    link.setAttribute("download", "exam_questions_template.csv");
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const parseCSVLine = parseCsvLine;

  const downloadStudentTemplate = () => {
    const headers = 'Full Name,Email,Registration ID\n';
    const sample = '"Ada Lovelace",ada@example.com,REG-1001\n';
    const encodedUri = csvDataUri(headers + sample);
    const link = document.createElement('a');
    link.setAttribute('href', encodedUri);
    link.setAttribute('download', 'exam_students_template.csv');
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const parseCSV = (text: string) => parseQuestionCsv(text, useSections
    ? { sections, activeSectionId: activeSectionId || sections[0]?.id }
    : {});

  const parseStudentCsv = (text: string) => {
    const lines = text.split('\n');
    const rows: { fullName: string; email: string; registrationId: string }[] = [];
    const errors: string[] = [];

    lines.forEach((line, idx) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      const cols = parseCSVLine(trimmed);
      if (idx === 0) {
        const header = cols.join(' ').toLowerCase();
        if (header.includes('email') && header.includes('name')) return;
      }

      if (cols.length < 3) {
        errors.push(`Row ${idx + 1}: expected 3 columns (Full Name, Email, Registration ID).`);
        return;
      }

      const fullName = cols[0]?.trim() || '';
      const email = cols[1]?.trim() || '';
      const registrationId = cols[2]?.trim() || '';

      if (!fullName || !email || !registrationId) {
        errors.push(`Row ${idx + 1}: missing full name, email, or registration ID.`);
        return;
      }

      rows.push({ fullName, email, registrationId });
    });

    return { rows, errors };
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    setUploadStatus('IDLE');
    setCsvErrors([]);
    setUploadMsg('');
    
    const file = e.target.files?.[0];
    if (!file) return;

    readTextFile(file).then((text) => {
      const { questions, errors } = parseCSV(text);

      setCsvErrors(errors);

      if (questions.length > 0) {
        // Each question's sectionId was already resolved per-row in parseCSV (from the CSV's
        // Section column, or the active section as a fallback), so nothing to assign here.
        setNewExam(prev => ({
          ...prev,
          questions: [...(prev.questions || []), ...questions]
        }));
        jumpToLastQuestionPage((newExam.questions?.length || 0) + questions.length);

        if (errors.length === 0) {
          setUploadStatus('SUCCESS');
          setUploadMsg(`Successfully added ${questions.length} questions.`);
        } else {
          setUploadStatus('PARTIAL');
          setUploadMsg(`Added ${questions.length} valid questions. ${errors.length} rows failed.`);
        }
      } else {
        if (errors.length > 0) {
          setUploadStatus('ERROR');
          setUploadMsg("No valid questions found. Please fix the errors below.");
        } else {
           setUploadStatus('ERROR');
           setUploadMsg("File appears empty or invalid.");
        }
      }
    }).catch(() => {
      setUploadStatus('ERROR');
      setUploadMsg('Failed to read file. Please re-save as UTF-8 or Windows-1252.');
    });
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const exportExams = () => {
    const payload = exams.map(exam => ({
      ...exam,
      id: exam.id,
    }));
    const json = JSON.stringify(payload, null, 2);
    const blob = new Blob([json], { type: 'application/json;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `exams_export_${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const importExams = async (file: File) => {
    const text = await file.text();
    let data: any = null;
    try {
      data = JSON.parse(text);
    } catch (e) {
      alert('Invalid JSON file.');
      return;
    }
    const list = Array.isArray(data) ? data : [data];
    const created: Exam[] = [];
    const failed: string[] = [];
    for (const raw of list) {
      if (!raw || typeof raw !== 'object') continue;
      const makeId = () => Math.random().toString(36).substr(2, 9);
      const questionMap = new Map<string, string>();
      const sectionMap = new Map<string, string>();

      const sourceQuestions: Question[] = Array.isArray(raw.questions) ? raw.questions : [];
      sourceQuestions.forEach(q => {
        if (!q?.id) return;
        questionMap.set(q.id, makeId());
      });

      const sourceSections = Array.isArray(raw.sections) ? raw.sections : [];
      sourceSections.forEach((section: any) => {
        if (!section?.id) return;
        sectionMap.set(section.id, makeId());
        if (Array.isArray(section.questions)) {
          section.questions.forEach((q: any) => {
            if (q?.id && !questionMap.has(q.id)) {
              questionMap.set(q.id, makeId());
            }
          });
        }
      });

      // Imported questions become this exam's own copies (fresh ids), including any that came from a
      // Question Bank — the file may come from another company whose bank this one can't use — so
      // the bank tags are dropped along with the old ids.
      const mappedQuestions: Question[] = sourceQuestions.map(({ bankId: _bankId, bankName: _bankName, ...q }) => ({
        ...q,
        id: (q.id && questionMap.get(q.id)) || makeId(),
        sectionId: q.sectionId ? sectionMap.get(q.sectionId) : undefined
      }));

      const mappedSections = sourceSections.map((section: any, idx: number) => ({
        ...section,
        id: (section.id && sectionMap.get(section.id)) || makeId(),
        displayOrder: section.displayOrder ?? idx,
        questions: Array.isArray(section.questions)
          ? section.questions.map(({ bankId: _bankId, bankName: _bankName, ...q }: any) => ({
              ...q,
              id: (q.id && questionMap.get(q.id)) || makeId()
            }))
          : []
      }));

      const payload: Exam = {
        ...(raw as Exam),
        id: makeId(),
        status: 'DRAFT',
        questions: mappedQuestions,
        sections: mappedSections,
        totalMarks: mappedQuestions.reduce((sum, q) => sum + (q.marks || 0), 0),
        // Batch and student assignments are company-scoped: their IDs reference the SOURCE
        // company's batches/students. Carrying them into another company would enroll the
        // source company's students into this exam (backend expands batch_id globally), a
        // cross-company data leak. Always import an exam with a clean, unassigned roster.
        assignedBatchIds: [],
        assignedStudentIds: [],
        // Export files carry the source exam's server-computed counters and mail overrides; the API
        // echoes them back, so reset them or the imported (unassigned) exam shows stale badges.
        pendingInviteCount: 0,
        notAttemptedCount: 0,
        mailTemplates: {},
      };

      try {
        const result = await apiPost<{ exam: Exam }>('exams.php', withCompany({ exam: payload }));
        if (result.exam) {
          created.push(result.exam);
        }
      } catch (e) {
        console.error('Failed to import exam', e);
        failed.push(`${raw.title || '(untitled)'}: ${apiErrorMessage(e, 'rejected by the server')}`);
      }
    }
    if (created.length > 0) {
      onUpdateExams(prev => [...created, ...prev]);
    }
    // Report per-exam failures — they used to be swallowed into a bare "No exams imported."
    const failedNote = failed.length > 0 ? `\n\nFailed (${failed.length}):\n${failed.slice(0, 10).join('\n')}` : '';
    alert(created.length > 0 ? `Imported ${created.length} exams.${failedNote}` : `No exams imported.${failedNote}`);
  };

  // --- Batch Student Upload Logic ---
  const handleBatchStudentUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    readTextFile(file).then((text) => {
      const lines = text.split('\n');
      const foundIds: string[] = [];
      let notFoundCount = 0;

      // Extract emails/IDs from all lines (skipping header roughly)
      lines.forEach((line, idx) => {
         const cleanLine = line.trim().replace(/^"|"$/g, '');
         if (!cleanLine || (idx === 0 && (cleanLine.toLowerCase().includes('email') || cleanLine.toLowerCase().includes('id')))) return;
         
         // Try to find by Email OR Registration ID
         const student = students.find(s => s.email === cleanLine || s.registrationId === cleanLine);
         if (student) {
            foundIds.push(student.id);
         } else {
            // Also try comma separated?
            const parts = cleanLine.split(',');
            const match = students.find(s => parts.some(p => p.trim() === s.email || p.trim() === s.registrationId));
            if (match) {
                foundIds.push(match.id);
            } else {
                notFoundCount++;
            }
         }
      });

      // Merge with existing
      const newAssignment = Array.from(new Set([...(newExam.assignedStudentIds || []), ...foundIds]));
      
      setNewExam(prev => ({ ...prev, assignedStudentIds: newAssignment }));
      alert(`Batch Assignment Complete:\n- ${foundIds.length} students matched and selected.\n- ${notFoundCount} rows did not match existing students.`);
    }).catch(() => {
      alert('Failed to read file. Please re-save as UTF-8 or Windows-1252.');
    });
    if (studentBatchInputRef.current) studentBatchInputRef.current.value = '';
  };

  const handleStudentCreateUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    readTextFile(file).then(async (text) => {
      const { rows, errors } = parseStudentCsv(text);

      if (rows.length === 0) {
        alert(`No valid student rows found.${errors.length ? `\n${errors.join('\n')}` : ''}`);
        return;
      }

      const existingMap = new Map<string, Student>();
      students.forEach(s => {
        existingMap.set(s.email.toLowerCase(), s);
        existingMap.set(s.registrationId.toLowerCase(), s);
      });

      const toCreate: { fullName: string; email: string; registrationId: string }[] = [];
      const existingIds: string[] = [];
      const seen = new Set<string>();

      rows.forEach(row => {
        const key = `${row.email.toLowerCase()}|${row.registrationId.toLowerCase()}`;
        if (seen.has(key)) return;
        seen.add(key);

        const byEmail = existingMap.get(row.email.toLowerCase());
        const byReg = existingMap.get(row.registrationId.toLowerCase());
        const existing = byEmail || byReg;
        if (existing) {
          existingIds.push(existing.id);
        } else {
          toCreate.push(row);
        }
      });

      let created: Student[] = [];
      let createErrors: string[] = [];
      if (toCreate.length > 0) {
        try {
          const result = await apiPost<{ students: Student[]; errors?: string[] }>('students.php', withCompany({
            students: toCreate,
            actor: 'Admin'
          }));
          created = result.students || [];
          createErrors = result.errors || [];
        } catch (err) {
          console.error('Failed to create students:', err);
          createErrors.push('Failed to create some students. Check server logs.');
        }
      }

      const createdIds = created.map(s => s.id);
      const mergedAssigned = Array.from(new Set([...(newExam.assignedStudentIds || []), ...existingIds, ...createdIds]));
      setNewExam(prev => ({ ...prev, assignedStudentIds: mergedAssigned }));

      if (created.length > 0 && onUpdateStudents) {
        onUpdateStudents(prev => {
          const byId = new Map(prev.map(s => [s.id, s]));
          created.forEach(s => byId.set(s.id, s));
          return Array.from(byId.values());
        });
      }

      const summary = [
        `Created: ${created.length}`,
        `Matched existing: ${existingIds.length}`,
        `Assigned to this exam: ${existingIds.length + created.length}`,
      ];
      if (errors.length > 0) summary.push(`Skipped rows: ${errors.length}`);
      if (createErrors.length > 0) summary.push(`Create errors: ${createErrors.length}`);
      alert(summary.join('\n'));
    }).catch(() => {
      alert('Failed to read file. Please re-save as UTF-8 or Windows-1252.');
    });
    if (studentCreateInputRef.current) studentCreateInputRef.current.value = '';
  };


  if (isCreating) {
    // PREVIEW MODE RENDER
    if (showPreview) {
        const previewSections = useSections
            ? sections.map((section, idx) => ({
                id: section.id,
                title: section.title,
                displayOrder: idx,
                questionLimit: section.questionLimit ?? 0,
                shuffleQuestions: section.shuffleQuestions ?? true,
                timeLimitMinutes: section.timeLimitMinutes ?? 0,
                lockOnComplete: section.lockOnComplete ?? true,
                questions: (newExam.questions || []).filter(q => q.sectionId === section.id)
              }))
            : [];
        const previewExam = {
            ...newExam,
            id: newExam.id || 'PREVIEW-ID',
            totalMarks: newExam.questions?.reduce((sum, q) => sum + q.marks, 0) || 0,
            startTime: Date.now(),
            endTime: Date.now() + 3600000,
            status: 'PUBLISHED',
            questions: newExam.questions || [],
            sections: previewSections,
            // Preview what candidates will get: an UNPROCTORED draft previews with monitoring off.
            proctoringConfig: newExam.proctoringConfig
              ? effectiveProctoringConfig(proctoringConfig)
              : {
                  cameraRequired: false,
                  microphoneRequired: false,
                  fullScreenEnforced: false,
                  tabSwitchLimit: 3,
                  violationLimits: { ...defaultViolationLimits },
                  proctorTiming: { ...defaultProctorTiming }
                }
        } as Exam;
        
        const previewStudent: Student = {
            id: 'ADMIN-PREVIEW',
            fullName: 'Administrator Preview',
            email: 'admin@proctorguard.com',
            registrationId: 'ADMIN',
            batches: []
        };

        return (
            <div className="fixed inset-0 z-[100] bg-white">
                <div className="absolute top-4 right-20 z-[110]">
                    <div className="bg-amber-100 text-amber-800 px-4 py-2 rounded-full font-bold text-sm border border-amber-200 shadow-sm flex items-center gap-2">
                       <Eye size={16} /> Admin Preview Mode
                    </div>
                </div>
                <div className="absolute top-4 right-4 z-[110]">
                    <button 
                       onClick={() => setShowPreview(false)}
                       className="bg-slate-900 text-white p-2 rounded-full hover:bg-slate-700 shadow-lg transition-colors"
                       title="Exit Preview"
                       aria-label="Exit preview"
                    >
                       <XCircle size={24} />
                    </button>
                </div>
                <ExamTake 
                    exam={previewExam} 
                    student={previewStudent} 
                    onFinish={() => {
                        alert("Preview Finished. In a real session, results would be submitted.");
                        setShowPreview(false);
                    }} 
                />
            </div>
        );
    }

    const isPublished = newExam.status === 'PUBLISHED';
    const violationLimits = {
      ...defaultViolationLimits,
      ...(newExam.proctoringConfig?.violationLimits || {})
    };
    const proctorTiming = {
      ...defaultProctorTiming,
      ...(newExam.proctoringConfig?.proctorTiming || {})
    };

    return (
      <>
      <div className="space-y-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <h2 className="lsc-title">{newExam.id ? 'Edit Exam' : 'Create New Exam'}</h2>
          <button onClick={handleCancelEdit} disabled={savingExam} className="px-4 py-2 lsc-button-ghost text-sm disabled:opacity-50">Cancel</button>
        </div>

        {/* Warning for Published Exams */}
        {isPublished && (
          <div className="bg-amber-50 border-l-4 border-amber-500 p-4 rounded-r shadow-sm flex items-start gap-3">
             <AlertCircle className="text-amber-600 mt-0.5 shrink-0" />
             <div>
               <h4 className="font-bold text-amber-800">Restricted Editing Mode</h4>
               <p className="text-sm text-amber-700 mt-1">
                 This exam is <strong>PUBLISHED</strong>. To ensure integrity for students who may be taking the exam:
               </p>
               <ul className="list-disc list-inside text-sm text-amber-700 mt-1 ml-1 space-y-0.5">
                 <li>Question modification (add/edit/delete) is <strong>disabled</strong>.</li>
                 <li>Changes to Duration, Schedule, and Proctoring rules will apply <strong>immediately</strong> to active sessions.</li>
               </ul>
             </div>
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          {/* Left Col: Config */}
          <div className="lg:col-span-1 space-y-6">
            <div className="lsc-panel p-6 space-y-4">
              <h3 className="font-semibold text-slate-800">Exam Details</h3>
              
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Status</label>
                <select 
                  className={`w-full px-3 py-2 border rounded-lg outline-none bg-white font-medium ${
                    newExam.status === 'PUBLISHED' ? 'text-teal-700 border-teal-200 bg-teal-50' :
                    newExam.status === 'DRAFT' ? 'text-orange-700 border-orange-200 bg-orange-50' : 'text-slate-700'
                  }`}
                  value={newExam.status || 'DRAFT'}
                  onChange={e => setNewExam({...newExam, status: e.target.value as any})}
                >
                  <option value="DRAFT">Draft (Editing Allowed)</option>
                  <option value="PUBLISHED">Published (Restricted)</option>
                  <option value="ARCHIVED">Archived</option>
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Title</label>
                <input 
                  type="text" 
                  className="w-full px-3 py-2 border rounded-lg outline-none"
                  value={newExam.title}
                  onChange={e => setNewExam({...newExam, title: e.target.value})}
                  placeholder="e.g. Advanced React Pattern"
                />
              </div>
              
              {/* Schedule */}
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1 flex items-center gap-1">
                    <Clock size={14} /> Timezone
                </label>
                <select
                  className="w-full px-3 py-2 border rounded-lg outline-none text-sm bg-white"
                  value={resolveExamTimezone(newExam.timezone)}
                  onChange={e => {
                    const newTz = e.target.value;
                    const oldTz = resolveExamTimezone(newExam.timezone);
                    // Keep the wall-clock numbers the admin already typed, but
                    // re-interpret them in the newly chosen zone. (Guarded: Intl throws on an
                    // invalid instant, which would blank the whole screen.)
                    const reinterpret = (epoch?: number) => (typeof epoch === 'number' && Number.isFinite(epoch)
                      ? zonedInputToEpoch(epochToZonedInput(epoch, oldTz), newTz)
                      : epoch);
                    setNewExam({
                      ...newExam,
                      timezone: newTz,
                      startTime: reinterpret(newExam.startTime),
                      endTime: reinterpret(newExam.endTime),
                    });
                  }}
                >
                  {EXAM_TIMEZONES.map(tz => (
                    <option key={tz.value} value={tz.value}>{tz.label}</option>
                  ))}
                </select>
                <p className="text-xs text-slate-400 mt-1">All exam times below and in student emails are shown in this timezone.</p>
              </div>

              <div className="grid grid-cols-1 gap-4">
                 <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1 flex items-center gap-1">
                        <Calendar size={14} /> Start Time
                    </label>
                    <input
                      type="datetime-local"
                      className="w-full px-3 py-2 border rounded-lg outline-none text-sm"
                      value={zonedInputValue(newExam.startTime, resolveExamTimezone(newExam.timezone))}
                      onChange={e => {
                        // A cleared/partially-cleared picker reports '' → NaN. Storing NaN crashed the
                        // next render (Intl RangeError) and took the whole admin panel down, losing
                        // every unsaved edit — keep the last valid time instead.
                        const next = zonedInputToEpoch(e.target.value, resolveExamTimezone(newExam.timezone));
                        if (Number.isFinite(next)) setNewExam({...newExam, startTime: next});
                      }}
                    />
                 </div>
                 <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1 flex items-center gap-1">
                        <Calendar size={14} /> End Time
                    </label>
                    <input
                      type="datetime-local"
                      className="w-full px-3 py-2 border rounded-lg outline-none text-sm"
                      value={zonedInputValue(newExam.endTime, resolveExamTimezone(newExam.timezone))}
                      onChange={e => {
                        const next = zonedInputToEpoch(e.target.value, resolveExamTimezone(newExam.timezone));
                        if (Number.isFinite(next)) setNewExam({...newExam, endTime: next});
                      }}
                    />
                 </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1 flex items-center gap-1">
                    <Clock size={14} /> Duration (mins)
                </label>
                <input
                  type="number"
                  min="1"
                  step="1"
                  className="w-full px-3 py-2 border rounded-lg outline-none"
                  value={newExam.durationMinutes}
                  onChange={e => setNewExam({...newExam, durationMinutes: Number(e.target.value)})}
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-700 mb-2">Results Visibility</label>
                <div className="bg-slate-50 p-3 rounded-lg border border-slate-200">
                  <label className="flex items-center gap-2 text-sm text-slate-700 cursor-pointer">
                      <div className={`w-9 h-5 rounded-full relative transition-colors ${newExam.showResults ? 'bg-[var(--lsc-primary)]' : 'bg-slate-300'}`}>
                        <input 
                          type="checkbox" 
                          className="sr-only"
                          checked={newExam.showResults ?? false}
                          onChange={e => setNewExam({...newExam, showResults: e.target.checked})}
                        />
                        <div className={`absolute top-1 left-1 bg-white w-3 h-3 rounded-full transition-transform ${newExam.showResults ? 'translate-x-4' : 'translate-x-0'}`}></div>
                      </div>
                      <span>Show results immediately after submission</span>
                  </label>
                  <p className="text-[10px] text-slate-500 mt-1 leading-tight">
                    If disabled, students see an "exam completed" message only.
                  </p>
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-700 mb-2">Candidate Feedback</label>
                <div className="bg-slate-50 p-3 rounded-lg border border-slate-200">
                  <label className="flex items-center gap-2 text-sm text-slate-700 cursor-pointer">
                      <div className={`w-9 h-5 rounded-full relative transition-colors ${newExam.feedbackEnabled !== false ? 'bg-[var(--lsc-primary)]' : 'bg-slate-300'}`}>
                        <input
                          type="checkbox"
                          className="sr-only"
                          checked={newExam.feedbackEnabled !== false}
                          onChange={e => setNewExam({...newExam, feedbackEnabled: e.target.checked})}
                        />
                        <div className={`absolute top-1 left-1 bg-white w-3 h-3 rounded-full transition-transform ${newExam.feedbackEnabled !== false ? 'translate-x-4' : 'translate-x-0'}`}></div>
                      </div>
                      <span>Ask for feedback after the exam</span>
                  </label>
                  <p className="text-[10px] text-slate-500 mt-1 leading-tight">
                    Shows the star ratings and comments form on the completion screen. Turn off to show only the completion message.
                  </p>
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-700 mb-2">Pass Percentage</label>
                <div className="bg-slate-50 p-3 rounded-lg border border-slate-200">
                  <input
                    type="number"
                    min="0"
                    max="100"
                    className="w-full px-3 py-2 border rounded-lg outline-none text-sm"
                    value={newExam.passPercent ?? 60}
                    onChange={e => {
                      const next = Math.max(0, Math.min(100, Number(e.target.value)));
                      setNewExam({ ...newExam, passPercent: Number.isNaN(next) ? 60 : next });
                    }}
                  />
                  <p className="text-[10px] text-slate-500 mt-1 leading-tight">
                    Students must score at least this percentage to pass.
                  </p>
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-700 mb-2 flex items-center gap-1">
                    <Award size={14} /> Certification
                </label>
                <div className="bg-slate-50 p-3 rounded-lg border border-slate-200">
                  <label className="flex items-center gap-2 text-sm text-slate-700 cursor-pointer">
                      <div className={`w-9 h-5 rounded-full relative transition-colors ${newExam.certificateEnabled ? 'bg-[var(--lsc-primary)]' : 'bg-slate-300'}`}>
                        <input
                          type="checkbox"
                          className="sr-only"
                          checked={newExam.certificateEnabled ?? false}
                          onChange={e => setNewExam({...newExam, certificateEnabled: e.target.checked})}
                        />
                        <div className={`absolute top-1 left-1 bg-white w-3 h-3 rounded-full transition-transform ${newExam.certificateEnabled ? 'translate-x-4' : 'translate-x-0'}`}></div>
                      </div>
                      <span>Enable certificate issuance for this exam</span>
                  </label>
                  <p className="text-[10px] text-slate-500 mt-1 leading-tight">
                    Certificates are never issued automatically. When enabled, an admin can issue one on demand from a passed result. When disabled, on-demand issuance is blocked for this exam.
                  </p>
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-700 mb-2">Question Pools / Sections</label>
                <div className="bg-slate-50 p-3 rounded-lg border border-slate-200">
                  <label className="flex items-center gap-2 text-sm text-slate-700 cursor-pointer">
                    <div className={`w-9 h-5 rounded-full relative transition-colors ${useSections ? 'bg-[var(--lsc-primary)]' : 'bg-slate-300'}`}>
                      <input
                        type="checkbox"
                        className="sr-only"
                        checked={useSections}
                        onChange={e => (e.target.checked ? enableSections() : disableSections())}
                      />
                      <div className={`absolute top-1 left-1 bg-white w-3 h-3 rounded-full transition-transform ${useSections ? 'translate-x-4' : 'translate-x-0'}`}></div>
                    </div>
                    <span>Enable sections with randomized pools</span>
                  </label>
                  <p className="text-[10px] text-slate-500 mt-1 leading-tight">
                    Build sections and pull a randomized subset of questions from each pool.
                  </p>
                </div>

                {useSections && (
                  <div className="mt-3 space-y-3">
                    {sections.map((section, idx) => (
                      <div key={section.id} className={`rounded-lg border p-3 bg-white ${activeSectionId === section.id ? 'border-blue-300 ring-1 ring-blue-200' : 'border-slate-200'}`}>
                        <div className="flex items-center justify-between gap-2">
                          <button
                            type="button"
                            onClick={() => setActiveSectionId(section.id)}
                            className={`text-xs font-semibold px-2 py-1 rounded ${activeSectionId === section.id ? 'bg-blue-100 text-blue-700' : 'bg-slate-100 text-slate-600'}`}
                          >
                            {activeSectionId === section.id ? 'Active' : 'Set Active'}
                          </button>
                          <div className="text-[10px] text-slate-400">
                            {getSectionQuestionCount(section.id)} questions
                          </div>
                        </div>
                        <div className="mt-2 grid grid-cols-1 gap-2">
                          <input
                            type="text"
                            className="w-full px-3 py-2 border rounded-lg outline-none text-sm"
                            value={section.title}
                            onChange={e => {
                              const updated = sections.map(s => s.id === section.id ? { ...s, title: e.target.value } : s);
                              setNewExam({ ...newExam, sections: updated });
                            }}
                            placeholder={`Section ${idx + 1}`}
                          />
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                            <div>
                              <label className="block text-[10px] text-slate-500 mb-1">Question Limit</label>
                              <input
                                type="number"
                                min="0"
                                className="w-full px-3 py-2 border rounded-lg outline-none text-sm"
                                value={section.questionLimit ?? 0}
                                onChange={e => {
                                  const updated = sections.map(s => s.id === section.id ? { ...s, questionLimit: Math.max(0, Number(e.target.value)) } : s);
                                  setNewExam({ ...newExam, sections: updated });
                                }}
                              />
                              <p className="text-[10px] text-slate-400 mt-1">0 means all questions in this section. Add a whole bank and set e.g. 25 — with Randomize order on, each candidate gets 25 random ones.</p>
                            </div>
                            <div>
                              <label className="block text-[10px] text-slate-500 mb-1">Shuffle Questions</label>
                              <label className="flex items-center gap-2 text-sm text-slate-700 cursor-pointer">
                                <div className={`w-9 h-5 rounded-full relative transition-colors ${section.shuffleQuestions ? 'bg-[var(--lsc-primary)]' : 'bg-slate-300'}`}>
                                  <input
                                    type="checkbox"
                                    className="sr-only"
                                    checked={section.shuffleQuestions ?? true}
                                    onChange={e => {
                                      const updated = sections.map(s => s.id === section.id ? { ...s, shuffleQuestions: e.target.checked } : s);
                                      setNewExam({ ...newExam, sections: updated });
                                    }}
                                  />
                                  <div className={`absolute top-1 left-1 bg-white w-3 h-3 rounded-full transition-transform ${section.shuffleQuestions ? 'translate-x-4' : 'translate-x-0'}`}></div>
                                </div>
                                <span className="text-xs">Randomize order</span>
                              </label>
                            </div>
                          </div>
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                            <div>
                              <label className="block text-[10px] text-slate-500 mb-1">Section Time (mins)</label>
                              <input
                                type="number"
                                min="0"
                                className="w-full px-3 py-2 border rounded-lg outline-none text-sm"
                                value={section.timeLimitMinutes ?? 0}
                                onChange={e => {
                                  const updated = sections.map(s => s.id === section.id ? { ...s, timeLimitMinutes: Math.max(0, Number(e.target.value)) } : s);
                                  setNewExam({ ...newExam, sections: updated });
                                }}
                              />
                              <p className="text-[10px] text-slate-400 mt-1">0 uses the global exam timer.</p>
                            </div>
                            <div>
                              <label className="block text-[10px] text-slate-500 mb-1">Lock On Complete</label>
                              <label className="flex items-center gap-2 text-sm text-slate-700 cursor-pointer">
                                <div className={`w-9 h-5 rounded-full relative transition-colors ${section.lockOnComplete ? 'bg-[var(--lsc-primary)]' : 'bg-slate-300'}`}>
                                  <input
                                    type="checkbox"
                                    className="sr-only"
                                    checked={section.lockOnComplete ?? true}
                                    onChange={e => {
                                      const updated = sections.map(s => s.id === section.id ? { ...s, lockOnComplete: e.target.checked } : s);
                                      setNewExam({ ...newExam, sections: updated });
                                    }}
                                  />
                                  <div className={`absolute top-1 left-1 bg-white w-3 h-3 rounded-full transition-transform ${section.lockOnComplete ? 'translate-x-4' : 'translate-x-0'}`}></div>
                                </div>
                                <span className="text-xs">Lock previous section</span>
                              </label>
                            </div>
                          </div>
                        </div>
                        <div className="mt-3 flex justify-between items-center text-[10px] text-slate-400">
                          <span>Section {idx + 1}</span>
                          {sections.length > 1 && (
                            <button
                              type="button"
                              onClick={() => {
                                const remaining = sections.filter(s => s.id !== section.id);
                                const fallbackId = remaining[0]?.id;
                                setNewExam(prev => ({
                                  ...prev,
                                  sections: remaining,
                                  questions: (prev.questions || []).map(q => q.sectionId === section.id ? { ...q, sectionId: fallbackId } : q)
                                }));
                                if (activeSectionId === section.id) {
                                  setActiveSectionId(fallbackId || null);
                                }
                              }}
                              className="text-[10px] text-rose-600 hover:underline"
                            >
                              Remove
                            </button>
                          )}
                        </div>
                      </div>
                    ))}
                    <button
                      type="button"
                      onClick={() => {
                        const next = createSection(`Section ${sections.length + 1}`, sections.length);
                        setNewExam(prev => ({ ...prev, sections: [...(prev.sections || []), next] }));
                        setActiveSectionId(next.id);
                      }}
                      className="w-full py-2 border border-dashed border-blue-300 text-blue-600 rounded-lg text-sm hover:bg-blue-50"
                    >
                      Add Section
                    </button>
                    {activeSectionId && (
                      <div className="text-[10px] text-slate-400">
                        New questions will be added to: {sections.find(s => s.id === activeSectionId)?.title || 'Section'}
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Question Limit & Shuffling */}
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-2 flex items-center gap-1">
                    <ListOrdered size={14} /> Question Order & Limits
                </label>
                
                <div className="bg-slate-50 p-3 rounded-lg border border-slate-200 space-y-3">
                  <label className="flex items-center gap-2 text-sm text-slate-700 cursor-pointer">
                      <div className={`w-9 h-5 rounded-full relative transition-colors ${newExam.shuffleQuestions ? 'bg-[var(--lsc-primary)]' : 'bg-slate-300'} ${useSections ? 'opacity-50' : ''}`}>
                        <input 
                          type="checkbox" 
                          className="sr-only"
                          checked={newExam.shuffleQuestions ?? true}
                          onChange={e => !useSections && setNewExam({...newExam, shuffleQuestions: e.target.checked})}
                          disabled={useSections}
                        />
                        <div className={`absolute top-1 left-1 bg-white w-3 h-3 rounded-full transition-transform ${newExam.shuffleQuestions ? 'translate-x-4' : 'translate-x-0'}`}></div>
                      </div>
                      <span className="flex items-center gap-1.5">
                        <Shuffle size={14} className={newExam.shuffleQuestions ? 'text-blue-600' : 'text-slate-400'} />
                        Randomize Order
                      </span>
                  </label>

                  <div>
                     <div className="flex items-center justify-between mb-1">
                        <span className="text-xs font-medium text-slate-600">Question Subset Limit</span>
                        <span className="text-xs text-slate-400">{newExam.questionCount === 0 ? 'All' : newExam.questionCount} / {newExam.questions?.length || 0}</span>
                     </div>
                     <input 
                      type="number" 
                      min="0"
                      max={newExam.questions?.length}
                      className="w-full px-3 py-2 border rounded-lg outline-none text-sm"
                      value={newExam.questionCount}
                      onChange={e => !useSections && setNewExam({...newExam, questionCount: Math.max(0, Math.floor(Number(e.target.value) || 0))})}
                      disabled={useSections}
                      placeholder="0 for all"
                     />
                     <p className="text-[10px] text-slate-500 mt-1 leading-tight">
                        {useSections
                          ? 'Section settings override global question limits.'
                          : newExam.questionCount === 0
                            ? `Students see all ${newExam.questions?.length || 0} questions.`
                            : `Students see ${newExam.questionCount} questions selected ${newExam.shuffleQuestions ? 'randomly' : 'sequentially'} from the pool.`}
                     </p>
                     {!useSections && (
                       <p className="text-[10px] text-slate-500 mt-1.5 leading-tight flex items-start gap-1">
                         <Info size={11} className="shrink-0 mt-px text-blue-500" aria-hidden="true" />
                         <span>
                           Each candidate gets this many random questions from the pool — e.g. add a whole question bank and set 25
                           {newExam.shuffleQuestions ? '' : ' (turn on Randomize Order so every candidate gets a different set)'}.
                         </span>
                       </p>
                     )}
                  </div>
                </div>
              </div>
            </div>

            <div className="lsc-panel p-6 space-y-4">
              <h3 className="font-semibold text-slate-800 flex items-center gap-2">
                <div className={`w-2 h-2 rounded-full ${isUnproctored ? 'bg-slate-400' : 'bg-red-500 animate-pulse'}`}></div>
                Proctoring Rules
              </h3>
              <div className="space-y-4">
                {/* Proctored vs Unproctored — decides whether any monitoring runs at all. */}
                <div role="radiogroup" aria-label="Proctoring mode" className="grid grid-cols-2 gap-1 p-1 rounded-xl bg-slate-100 border border-slate-200">
                  {([
                    { id: 'PROCTORED', label: 'Proctored', hint: 'Camera, mic & screen checks', icon: <ShieldCheck size={15} /> },
                    { id: 'UNPROCTORED', label: 'Unproctored', hint: 'Questions only, no monitoring', icon: <ShieldOff size={15} /> },
                  ] as { id: ProctoringMode; label: string; hint: string; icon: React.ReactNode }[]).map(opt => {
                    const active = proctoringMode === opt.id;
                    return (
                      <button
                        key={opt.id}
                        type="button"
                        role="radio"
                        aria-checked={active}
                        onClick={() => setProctoringMode(opt.id)}
                        className={`flex flex-col items-start gap-0.5 rounded-lg px-3 py-2 text-left transition-colors ${
                          active ? 'bg-white shadow-sm ring-1 ring-slate-200 text-slate-900' : 'text-slate-500 hover:text-slate-800'
                        }`}
                      >
                        <span className={`flex items-center gap-1.5 text-sm font-semibold ${active ? (opt.id === 'PROCTORED' ? 'text-[var(--lsc-primary)]' : 'text-slate-800') : ''}`}>
                          {opt.icon} {opt.label}
                        </span>
                        <span className="text-[10px] leading-tight text-slate-500">{opt.hint}</span>
                      </button>
                    );
                  })}
                </div>

                {isUnproctored ? (
                  <div className="flex items-start gap-2 rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600 leading-relaxed">
                    <ShieldOff size={14} className="shrink-0 mt-0.5 text-slate-500" aria-hidden="true" />
                    <span>No camera, microphone, screen recording, fullscreen or tab monitoring — candidates just answer the questions.</span>
                  </div>
                ) : (
                  <>
                    <div>
                      <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Monitoring</p>
                      <div className="space-y-2">
                        {renderSwitchRow({
                          icon: <Camera size={16} />,
                          label: 'Camera',
                          hint: 'Enable the webcam — face, gaze and object detection plus live snapshots.',
                          checked: !!proctoringConfig.cameraRequired,
                          onChange: checked => patchProctoring({ cameraRequired: checked }),
                        })}
                        {renderSwitchRow({
                          icon: <Mic size={16} />,
                          label: 'Microphone',
                          hint: 'Listens for sustained talking near the candidate.',
                          checked: !!proctoringConfig.microphoneRequired,
                          onChange: checked => patchProctoring({ microphoneRequired: checked }),
                        })}
                        {renderSwitchRow({
                          icon: <Maximize size={16} />,
                          label: 'Fullscreen',
                          hint: 'Keeps the exam in fullscreen and counts every exit.',
                          checked: !!proctoringConfig.fullScreenEnforced,
                          onChange: checked => patchProctoring({ fullScreenEnforced: checked }),
                        })}
                      </div>
                      {!proctoringConfig.cameraRequired && (
                        <p className="text-[11px] text-amber-600 mt-2 flex items-start gap-1">
                          <AlertCircle size={12} className="shrink-0 mt-px" /> Camera off — no face, gaze or object checks will run for this exam.
                        </p>
                      )}
                    </div>

                    <div>
                      <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">When a violation happens</p>
                      <div className="space-y-2">
                        {renderSwitchRow({
                          icon: <Bell size={16} />,
                          label: 'Show violation alerts to the candidate',
                          hint: proctoringConfig.showAlerts !== false
                            ? 'Candidates see a warning each time a violation is recorded.'
                            : 'Off — violations are recorded silently; candidates see no warnings.',
                          checked: proctoringConfig.showAlerts !== false,
                          onChange: checked => patchProctoring({ showAlerts: checked }),
                        })}
                        {renderSwitchRow({
                          icon: <XCircle size={16} />,
                          label: 'End the exam automatically when a violation limit is reached',
                          hint: autoTerminate
                            ? 'The attempt is terminated as soon as any limit below is reached.'
                            : 'Off — limits only flag the attempt for review; the candidate can finish.',
                          checked: autoTerminate,
                          onChange: checked => patchProctoring({ autoTerminate: checked }),
                        })}
                      </div>
                    </div>
                  </>
                )}

                {/* Allowed Devices — restrict which device classes may sit this exam. */}
                {(() => {
                  const allowed = newExam.allowedDeviceTypes && newExam.allowedDeviceTypes.length > 0
                    ? newExam.allowedDeviceTypes
                    : (['desktop', 'tablet', 'mobile'] as DeviceType[]);
                  const deviceOptions: { key: DeviceType; label: string; hint: string; icon: React.ReactNode }[] = [
                    { key: 'desktop', label: 'Desktop / Laptop', hint: 'Windows, Mac & Linux computers', icon: <Monitor size={18} /> },
                    { key: 'tablet', label: 'Tablet', hint: 'iPad & Android tablets', icon: <Tablet size={18} /> },
                    { key: 'mobile', label: 'Mobile Phone', hint: 'iPhone & Android phones', icon: <Smartphone size={18} /> },
                  ];
                  return (
                    <div className="pt-1">
                      <label className="text-sm text-slate-700 font-medium block mb-1">Allowed Devices</label>
                      <p className="text-[10px] text-slate-500 mb-3">
                        Uncheck a device type to stop candidates from taking this exam on it. At least one must stay selected.
                      </p>
                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                        {deviceOptions.map(opt => {
                          const isOn = allowed.includes(opt.key);
                          const isLastOn = isOn && allowed.length === 1;
                          return (
                            <button
                              key={opt.key}
                              type="button"
                              onClick={() => toggleDeviceType(opt.key)}
                              disabled={isLastOn}
                              title={isLastOn ? 'At least one device type must remain allowed' : undefined}
                              className={`flex items-start gap-2 text-left px-3 py-2.5 rounded-lg border transition-all ${
                                isOn
                                  ? 'border-[var(--lsc-primary)] bg-blue-50 ring-1 ring-[var(--lsc-primary)]/30'
                                  : 'border-slate-200 bg-white hover:border-slate-300'
                              } ${isLastOn ? 'cursor-not-allowed' : ''}`}
                            >
                              <span className={isOn ? 'text-[var(--lsc-primary)] mt-0.5' : 'text-slate-400 mt-0.5'}>{opt.icon}</span>
                              <span className="flex-1 min-w-0">
                                <span className="flex items-center gap-1.5">
                                  <span className={`text-sm font-medium ${isOn ? 'text-slate-900' : 'text-slate-500'}`}>{opt.label}</span>
                                  {isOn && <CheckCircle size={13} className="text-[var(--lsc-primary)] flex-shrink-0" />}
                                </span>
                                <span className="block text-[10px] text-slate-400 leading-tight mt-0.5">{opt.hint}</span>
                              </span>
                            </button>
                          );
                        })}
                      </div>
                      {!allowed.includes('mobile') && (
                        <p className="text-[11px] text-amber-600 mt-2 flex items-center gap-1">
                          <AlertCircle size={12} /> Candidates on a mobile phone will be blocked from starting this exam.
                        </p>
                      )}
                    </div>
                  );
                })()}

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="text-sm text-slate-700 font-medium block mb-1">Reconnect Attempts</label>
                    <input
                      type="number"
                      min="0"
                      className="w-full px-3 py-2 border rounded-lg outline-none text-sm"
                      value={newExam.reconnectLimit ?? 0}
                      onChange={e => setNewExam({ ...newExam, reconnectLimit: Math.max(0, Number(e.target.value)) })}
                    />
                    <p className="text-[10px] text-slate-500 mt-1">
                      Number of times a student can reconnect to an active session after disconnect.
                    </p>
                  </div>
                  {!isUnproctored && (<>
                  <div>
                    <label className="text-sm text-slate-700 font-medium block mb-1">Tab Switch Limit</label>
                    <input
                      type="number"
                      min="0"
                      className="w-full px-3 py-2 border rounded-lg outline-none text-sm"
                      value={newExam.proctoringConfig?.tabSwitchLimit ?? 0}
                      onChange={e => setNewExam({
                        ...newExam,
                        proctoringConfig: {
                          ...newExam.proctoringConfig!,
                          tabSwitchLimit: Math.max(0, Number(e.target.value))
                        }
                      })}
                    />
                    <p className="text-[10px] text-slate-500 mt-1">
                      {autoTerminate ? 'Ends the attempt' : 'Flags the attempt for review'} after this many tab switches. Use 0 to disable.
                    </p>
                  </div>
                  <div>
                    <label className="text-sm text-slate-700 font-medium block mb-1">Camera Violation Limit</label>
                    <input
                      type="number"
                      min="0"
                      className="w-full px-3 py-2 border rounded-lg outline-none text-sm"
                      value={violationLimits.camera}
                      onChange={e => setNewExam({
                        ...newExam,
                        proctoringConfig: {
                          ...newExam.proctoringConfig!,
                          violationLimits: {
                            ...violationLimits,
                            camera: Math.max(0, Number(e.target.value))
                          }
                        }
                      })}
                    />
                    <p className="text-[10px] text-slate-500 mt-1">
                      Counts camera-related alerts (no face, multiple faces, phone, suspicious object).
                    </p>
                  </div>
                  <div>
                    <label className="text-sm text-slate-700 font-medium block mb-1">Microphone Violation Limit</label>
                    <input
                      type="number"
                      min="0"
                      className="w-full px-3 py-2 border rounded-lg outline-none text-sm"
                      value={violationLimits.microphone}
                      onChange={e => setNewExam({
                        ...newExam,
                        proctoringConfig: {
                          ...newExam.proctoringConfig!,
                          violationLimits: {
                            ...violationLimits,
                            microphone: Math.max(0, Number(e.target.value))
                          }
                        }
                      })}
                    />
                    <p className="text-[10px] text-slate-500 mt-1">
                      Counts speech or strong microphone violations. Mild background noise is tolerated. Use 0 to disable.
                    </p>
                  </div>
                  <div>
                    <label className="text-sm text-slate-700 font-medium block mb-1">Fullscreen Exit Limit</label>
                    <input
                      type="number"
                      min="0"
                      className="w-full px-3 py-2 border rounded-lg outline-none text-sm"
                      value={violationLimits.fullscreen}
                      onChange={e => setNewExam({
                        ...newExam,
                        proctoringConfig: {
                          ...newExam.proctoringConfig!,
                          violationLimits: {
                            ...violationLimits,
                            fullscreen: Math.max(0, Number(e.target.value))
                          }
                        }
                      })}
                    />
                    <p className="text-[10px] text-slate-500 mt-1">
                      {autoTerminate ? 'Ends the attempt' : 'Flags the attempt for review'} after this many fullscreen exits. Use 0 to disable.
                    </p>
                  </div>
                  <div>
                    <label className="text-sm text-slate-700 font-medium block mb-1">Copy/Paste Limit</label>
                    <input
                      type="number"
                      min="0"
                      className="w-full px-3 py-2 border rounded-lg outline-none text-sm"
                      value={violationLimits.copyPaste}
                      onChange={e => setNewExam({
                        ...newExam,
                        proctoringConfig: {
                          ...newExam.proctoringConfig!,
                          violationLimits: {
                            ...violationLimits,
                            copyPaste: Math.max(0, Number(e.target.value))
                          }
                        }
                      })}
                    />
                    <p className="text-[10px] text-slate-500 mt-1">
                      {autoTerminate ? 'Ends the attempt' : 'Flags the attempt for review'} after this many copy/paste attempts. Use 0 to disable.
                    </p>
                  </div>
                  </>)}
                </div>
                {!isUnproctored && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-4">
                  <div>
                    <label className="text-sm text-slate-700 font-medium block mb-1">Gaze Away Sensitivity (sec)</label>
                    <input
                      type="number"
                      min="1"
                      max="60"
                      className="w-full px-3 py-2 border rounded-lg outline-none text-sm"
                      value={proctorTiming.gazeAwaySeconds}
                      onChange={e => setNewExam({
                        ...newExam,
                        proctoringConfig: {
                          ...newExam.proctoringConfig!,
                          proctorTiming: {
                            ...proctorTiming,
                            gazeAwaySeconds: Math.max(1, Math.min(60, Number(e.target.value)))
                          }
                        }
                      })}
                    />
                    <p className="text-[10px] text-slate-500 mt-1">
                      Seconds of sustained looking-away before it's logged. Lower = stricter.
                    </p>
                  </div>
                  <div>
                    <label className="text-sm text-slate-700 font-medium block mb-1">Talking Sensitivity (sec)</label>
                    <input
                      type="number"
                      min="1"
                      max="60"
                      className="w-full px-3 py-2 border rounded-lg outline-none text-sm"
                      value={proctorTiming.audioSeconds}
                      onChange={e => setNewExam({
                        ...newExam,
                        proctoringConfig: {
                          ...newExam.proctoringConfig!,
                          proctorTiming: {
                            ...proctorTiming,
                            audioSeconds: Math.max(1, Math.min(60, Number(e.target.value)))
                          }
                        }
                      })}
                    />
                    <p className="text-[10px] text-slate-500 mt-1">
                      Seconds of sustained talking before it's logged. Lower = stricter.
                    </p>
                  </div>
                </div>
                )}
              </div>
            </div>

            {/* Student Assignment */}
            <div className="lsc-panel p-6 space-y-4">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <h3 className="font-semibold text-slate-800 flex items-center gap-2">
                  <Users size={16} /> Assign Batches
                </h3>
                <div className="text-xs text-slate-500">
                  {(newExam.assignedBatchIds || []).length} batches selected
                </div>
              </div>
              <div className="grid gap-3 sm:grid-cols-3 text-[11px] text-slate-500 leading-snug">
                <p>
                  <span className="font-semibold text-slate-700">Batch-Based Assignment:</span> Select one or more batches and everyone in those batches will be assigned to the exam automatically.
                </p>
                <p>
                  <span className="font-semibold text-slate-700">Company Scope:</span> {isSuperAdmin
                    ? 'Batches shown belong to the company selected above. Selecting a batch enrolls all of its students.'
                    : 'Only batches under the current authenticated company are shown here.'}
                </p>
                <p>
                  <span className="font-semibold text-slate-700">Auto Expansion:</span> Selected batches are expanded to student IDs automatically when the exam is saved.
                </p>
              </div>
              
              <div className="relative">
                <Search className="absolute left-2.5 top-2.5 text-slate-400" size={14} />
                <input 
                  type="text" 
                  placeholder="Search batches..." 
                  className="w-full pl-8 pr-3 py-2 text-sm border rounded-lg outline-none"
                  value={batchSearch}
                  onChange={e => setBatchSearch(e.target.value)}
                />
              </div>
              <div className="max-h-48 overflow-y-auto border rounded-lg divide-y divide-slate-50">
                {(() => {
                  const term = batchSearch.toLowerCase();
                  const matches = (batch: Batch) =>
                    batch.name.toLowerCase().includes(term)
                    || (batch.description || '').toLowerCase().includes(term)
                    || (batch.companyName || '').toLowerCase().includes(term);
                  const filtered = batches.filter(matches);

                  const renderBatchRow = (batch: Batch) => (
                    <label key={batch.id} className="flex items-center gap-3 p-3 hover:bg-slate-50 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={(newExam.assignedBatchIds || []).includes(batch.id)}
                        onChange={() => toggleBatch(batch.id)}
                        className="rounded text-blue-600"
                      />
                      <div className="text-sm">
                        <div className="font-medium text-slate-900">{batch.name}</div>
                        <div className="text-xs text-slate-500">
                          {typeof batch.studentCount === 'number' ? `${batch.studentCount} students` : `${students.filter(student => student.batches.some(b => b.id === batch.id)).length} students`}
                          {batch.description ? ` • ${batch.description}` : ''}
                        </div>
                      </div>
                    </label>
                  );

                  if (filtered.length === 0) {
                    return <div className="p-3 text-xs text-slate-400 text-center">No batches found. Create batches in Student Registry first.</div>;
                  }

                  // Super admin: group the flat list by owning company so it reads clearly.
                  if (isSuperAdmin) {
                    const groups: { companyId: number; companyName: string; batches: Batch[] }[] = [];
                    filtered.forEach(batch => {
                      const label = batch.companyName || `Company ${batch.companyId}`;
                      let group = groups.find(g => g.companyId === batch.companyId);
                      if (!group) {
                        group = { companyId: batch.companyId, companyName: label, batches: [] };
                        groups.push(group);
                      }
                      group.batches.push(batch);
                    });
                    return groups.map(group => (
                      <div key={group.companyId}>
                        <div className="sticky top-0 bg-slate-100 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                          {group.companyName}
                        </div>
                        {group.batches.map(renderBatchRow)}
                      </div>
                    ));
                  }

                  return filtered.map(renderBatchRow);
                })()}
              </div>
              <div className="text-xs text-slate-500 text-right">
                {(() => {
                  const selected = newExam.assignedBatchIds || [];
                  const explicit = newExam.assignedStudentIds || [];
                  // With no assignment at all, Notify/Links go to EVERY student in the company
                  // (resolveRecipients' fallback) — "0 students will receive this exam" was wrong.
                  if (selected.length === 0 && explicit.length === 0) {
                    return 'No batches selected — invitations will go to every student in this company';
                  }
                  // Cross-company batches aren't in the local `students` prop, so for a super admin we
                  // trust the per-batch counts from the API instead of expanding against local students.
                  // Otherwise count the real union the save sends: batch members PLUS individually
                  // assigned students (the old count ignored the latter).
                  const count = isSuperAdmin
                    ? Math.max(batches.filter(b => selected.includes(b.id)).reduce((sum, b) => sum + (b.studentCount || 0), 0), explicit.length)
                    : new Set([...explicit, ...getStudentIdsForBatchIds(selected)]).size;
                  return `${count} students will receive this exam`;
                })()}
              </div>
            </div>
            
            {/* Email Notifications Config */}
            <div className="lsc-panel p-6 space-y-4">
                <div className="flex justify-between items-start">
                    <div>
                        <h3 className="font-semibold text-slate-800 flex items-center gap-2">
                            <Bell size={16} /> Email Notifications
                        </h3>
                        <p className="text-xs text-slate-500 mt-1">Configure automated reminders sent to students.</p>
                    </div>
                    <label className="relative inline-flex items-center cursor-pointer">
                        <input 
                            type="checkbox" 
                            className="sr-only peer"
                            checked={newExam.notificationConfig?.enabled ?? false}
                            onChange={e => setNewExam({
                                ...newExam, 
                                notificationConfig: {
                                    enabled: e.target.checked,
                                    reminders: newExam.notificationConfig?.reminders || { hours24: true, hours1: true },
                                    customSubject: newExam.notificationConfig?.customSubject || `Reminder: ${newExam.title || '{ExamTitle}'}`,
                                    customMessage: newExam.notificationConfig?.customMessage || "Hello {StudentName},\n\nThis is a reminder for your upcoming exam: {ExamTitle}.\nIt is scheduled to start at {StartTime}.\n\nPlease ensure your system is ready.\n\nGood luck!"
                                }
                            })}
                        />
                        <div className="w-9 h-5 bg-slate-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-[var(--lsc-primary)]"></div>
                    </label>
                </div>
                
                {newExam.notificationConfig?.enabled && (
                    <div className="space-y-4 animate-in fade-in slide-in-from-top-2 pt-2">
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                            <label className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${newExam.notificationConfig.reminders.hours24 ? 'bg-blue-50 border-blue-200' : 'bg-slate-50 border-slate-100 hover:bg-slate-100'}`}>
                                <input 
                                    type="checkbox" 
                                    className="w-4 h-4 text-blue-600 rounded"
                                    checked={newExam.notificationConfig.reminders.hours24}
                                    onChange={e => setNewExam({
                                        ...newExam,
                                        notificationConfig: {
                                            ...newExam.notificationConfig!,
                                            reminders: { ...newExam.notificationConfig!.reminders, hours24: e.target.checked }
                                        }
                                    })}
                                />
                                <span className="text-sm font-medium text-slate-700">24 Hours Before</span>
                            </label>
                            <label className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${newExam.notificationConfig.reminders.hours1 ? 'bg-blue-50 border-blue-200' : 'bg-slate-50 border-slate-100 hover:bg-slate-100'}`}>
                                <input 
                                    type="checkbox" 
                                    className="w-4 h-4 text-blue-600 rounded"
                                    checked={newExam.notificationConfig.reminders.hours1}
                                    onChange={e => setNewExam({
                                        ...newExam,
                                        notificationConfig: {
                                            ...newExam.notificationConfig!,
                                            reminders: { ...newExam.notificationConfig!.reminders, hours1: e.target.checked }
                                        }
                                    })}
                                />
                                <span className="text-sm font-medium text-slate-700">1 Hour Before</span>
                            </label>
                        </div>
                        
                        {templates.length > 0 && (
                          <div className="pt-2">
                            <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1.5">Use Template</label>
                            <select
                              className="w-full px-3 py-2 border border-slate-200 rounded-lg outline-none text-sm bg-white"
                              value={selectedTemplateId ?? ''}
                              onChange={e => {
                                const val = e.target.value;
                                if (!val) {
                                  setSelectedTemplateId(null);
                                  return;
                                }
                                const tpl = templates.find(t => t.id === Number(val));
                                if (!tpl) return;
                                setSelectedTemplateId(tpl.id);
                                setNewExam({
                                  ...newExam,
                                  notificationConfig: {
                                    ...newExam.notificationConfig!,
                                    customSubject: tpl.subject || newExam.notificationConfig!.customSubject,
                                    customMessage: tpl.body
                                  }
                                });
                              }}
                            >
                              <option value="">Select a template</option>
                              {templates.map(tpl => (
                                <option key={tpl.id} value={tpl.id}>
                                  {tpl.name}
                                </option>
                              ))}
                            </select>
                          </div>
                        )}

                        <div className="space-y-3 pt-2">
                            <div>
                                <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1.5">Email Subject</label>
                                <input 
                                    type="text" 
                                    className="w-full px-3 py-2 border border-slate-200 rounded-lg outline-none text-sm transition-shadow"
                                    placeholder="e.g. Reminder: {ExamTitle}"
                                    value={newExam.notificationConfig.customSubject}
                                    onChange={e => setNewExam({
                                        ...newExam,
                                        notificationConfig: {
                                            ...newExam.notificationConfig!,
                                            customSubject: e.target.value
                                        }
                                    })}
                                />
                            </div>
                             <div>
                                <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1.5">Message Body</label>
                                <textarea 
                                    className="w-full px-3 py-2 border border-slate-200 rounded-lg outline-none text-sm transition-shadow min-h-[120px]"
                                    rows={5}
                                    value={newExam.notificationConfig.customMessage}
                                    onChange={e => setNewExam({
                                        ...newExam,
                                        notificationConfig: {
                                            ...newExam.notificationConfig!,
                                            customMessage: e.target.value
                                        }
                                    })}
                                />
                                <div className="mt-2 flex flex-wrap gap-2">
                                    {['{StudentName}', '{ExamTitle}', '{StartTime}', '{Link}'].map(tag => (
                                        <button 
                                            key={tag}
                                            onClick={() => setNewExam({
                                                ...newExam,
                                                notificationConfig: {
                                                    ...newExam.notificationConfig!,
                                                    customMessage: (newExam.notificationConfig!.customMessage || '') + tag
                                                }
                                            })}
                                            className="px-2 py-1 bg-slate-100 hover:bg-slate-200 text-slate-600 text-[10px] font-mono rounded border border-slate-200 transition-colors"
                                            title="Click to insert"
                                        >
                                            {tag}
                                        </button>
                                    ))}
                                </div>
                            </div>
                        </div>

                        <div className="pt-2">
                            <button
                                type="button"
                                onClick={() => setShowMailPreview(true)}
                                className="w-full py-2.5 bg-white border border-slate-200 text-slate-700 rounded-lg font-medium text-sm hover:bg-slate-50 flex justify-center items-center gap-2 shadow-sm"
                            >
                                <Eye size={16} />
                                Preview Email
                            </button>
                        </div>
                    </div>
                )}
            </div>

            <button 
                onClick={() => {
                  if (!newExam.title || !newExam.questions?.length) {
                    alert("Please add a title and at least one question to preview.");
                    return;
                  }
                  setShowPreview(true);
                }}
                disabled={!newExam.title || !newExam.questions?.length}
                className="w-full py-3 bg-white border border-slate-300 text-slate-700 rounded-lg font-semibold hover:bg-slate-50 disabled:bg-slate-100 disabled:text-slate-400 disabled:cursor-not-allowed flex justify-center items-center gap-2 mb-3 shadow-sm"
            >
                <Eye size={18} />
                Preview Exam
            </button>
            <button
              onClick={handleSaveExam}
              disabled={!newExam.title || !newExam.questions?.length || savingExam}
              className="w-full py-3 lsc-button-primary disabled:bg-slate-300 disabled:cursor-not-allowed flex justify-center items-center gap-2"
            >
              {savingExam ? <Loader2 size={18} className="animate-spin" /> : <Save size={18} />}
              {savingExam ? 'Saving…' : 'Save Exam'}
            </button>
            {(!newExam.title || !newExam.questions?.length) && (
              // The disabled button gave no hint as to why it could not be clicked.
              <p className="text-xs text-slate-500 text-center">
                Add a title and at least one question to save.
              </p>
            )}
          </div>

          {/* Right Col: Questions */}
          <div className="lg:col-span-2 space-y-6">
             <div className={`lsc-panel overflow-hidden relative ${isPublished ? 'opacity-60 grayscale pointer-events-none select-none' : ''}`}>
                
                {isPublished && (
                    <div className="absolute inset-0 z-50 flex items-center justify-center bg-slate-50/20 backdrop-blur-[1px]">
                       <div className="bg-white px-4 py-2 rounded-full shadow-lg border border-slate-200 text-sm font-bold text-slate-500 flex items-center gap-2">
                         <Lock size={16} /> Questions Locked
                       </div>
                    </div>
                )}

                <div className="p-4 bg-slate-50 border-b border-slate-100 flex items-center gap-2">
                  <Plus size={18} className="text-slate-500" />
                  <h3 className="font-semibold text-slate-800">Add Questions</h3>
                </div>
                
                <div className="p-6 space-y-8">
                  {/* Question Bank: link a whole shared bank instead of re-typing or re-uploading it. */}
                  <div className="space-y-3">
                    <div className="rounded-lg border border-blue-100 bg-blue-50/50 p-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                      <div className="min-w-0">
                        <h4 className="text-sm font-semibold text-slate-700 flex items-center gap-2">
                          <Library size={16} className="text-[var(--lsc-primary)]" aria-hidden="true" /> Question Bank
                        </h4>
                        <p className="text-xs text-slate-500 mt-1 leading-snug">
                          Reuse a shared bank. Its questions stay linked — edit them in the Question Bank tab and every exam using them updates.
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={openBankPicker}
                        disabled={isPublished}
                        className="shrink-0 px-4 py-2 lsc-button-ghost text-sm flex items-center justify-center gap-2 disabled:opacity-50"
                      >
                        <Library size={16} aria-hidden="true" /> Add from Question Bank
                      </button>
                    </div>
                    {bankNotice && (
                      <div className="p-3 bg-teal-50 text-teal-700 text-sm rounded-lg flex items-start gap-2 border border-teal-100" role="status">
                        <CheckCircle size={16} className="shrink-0 mt-0.5" aria-hidden="true" />
                        <span className="flex-1">{bankNotice}</span>
                        <button
                          type="button"
                          onClick={() => setBankNotice(null)}
                          className="shrink-0 text-teal-600 hover:text-teal-800"
                          aria-label="Dismiss message"
                        >
                          <XCircle size={16} />
                        </button>
                      </div>
                    )}
                  </div>

                  {/* Manual Entry Form */}
                  <div className="space-y-4 border-t border-slate-100 pt-6">
                     <div className="flex justify-between items-center">
                        <h4 className="text-sm font-semibold text-slate-600 uppercase tracking-wide">Manual Entry</h4>
                        
                        {/* Type Selector */}
                        <select
                           aria-label="Question type"
                           value={manualQ.type}
                           onChange={e => setManualQ({ ...manualQDefaults, type: e.target.value as QuestionType })}
                           className="px-3 py-1.5 border border-slate-200 rounded-lg text-xs font-medium bg-white outline-none"
                        >
                           <option value={QuestionType.MCQ}>Multiple Choice (single)</option>
                           <option value={QuestionType.MULTI_SELECT}>Multiple Select (checkbox)</option>
                           <option value={QuestionType.TRUE_FALSE}>True / False</option>
                           <option value={QuestionType.YES_NO}>Yes / No</option>
                           <option value={QuestionType.SHORT_TEXT}>Short Text Answer</option>
                           <option value={QuestionType.LONG_TEXT}>Long Text / Essay</option>
                           <option value={QuestionType.FILL_BLANK}>Fill in the Blank</option>
                           <option value={QuestionType.NUMERIC}>Numeric Answer</option>
                           <option value={QuestionType.DATE}>Date Answer</option>
                           <option value={QuestionType.TIME}>Time Answer</option>
                           <option value={QuestionType.MATCHING}>Matching</option>
                           <option value={QuestionType.ORDERING}>Ordering / Sequence</option>
                           <option value={QuestionType.DRAG_DROP}>Drag and Drop</option>
                        </select>
                     </div>
                     
                     <div>
                       <label className="block text-sm text-slate-600 mb-1">Question Text</label>
                       <textarea 
                          className="w-full p-3 border rounded-lg outline-none"
                          rows={2}
                          placeholder={manualQ.type === QuestionType.FILL_BLANK ? "e.g. The capital of France is _______." : "e.g. What is the complexity of binary search?"}
                          value={manualQ.text}
                          onChange={e => setManualQ({...manualQ, text: e.target.value})}
                       />
                       {manualQ.type === QuestionType.FILL_BLANK && (
                           <p className="text-[10px] text-slate-400 mt-1">
                               Tip: use underscores (____) in the text to show each blank. Add one "accepted answers" row per blank below.
                           </p>
                       )}
                     </div>
                     
                     {/* ---- Per-type answer editor ---- */}
                     {renderQuestionTypeEditor()}

                     <div className="flex gap-4">
                       <div className="w-24">
                         <label className="block text-sm text-slate-600 mb-1">Marks</label>
                         <input
                            type="number"
                            className="w-full px-3 py-2 border rounded-lg outline-none"
                            min="1"
                            value={manualQ.marks}
                            onChange={e => setManualQ({...manualQ, marks: Number(e.target.value)})}
                         />
                       </div>
                       {manualQ.type !== QuestionType.SHORT_TEXT && manualQ.type !== QuestionType.LONG_TEXT && (
                         <div className="w-32">
                           <label className="block text-sm text-slate-600 mb-1">Negative marks</label>
                           <input
                              type="number"
                              className="w-full px-3 py-2 border rounded-lg outline-none"
                              min="0"
                              step="0.25"
                              placeholder="0"
                              value={manualQ.negativeMarks}
                              onChange={e => setManualQ({...manualQ, negativeMarks: Number(e.target.value)})}
                           />
                           <p className="text-[11px] text-slate-400 mt-1">Deducted if wrong. 0 = off</p>
                         </div>
                       )}
                       {(manualQ.type === QuestionType.SHORT_TEXT || manualQ.type === QuestionType.LONG_TEXT) && (
                         <div className="w-32">
                           <label className="block text-sm text-slate-600 mb-1">Word limit</label>
                           <input
                              type="number"
                              className="w-full px-3 py-2 border rounded-lg outline-none"
                              min="1"
                              placeholder="No limit"
                              value={manualQ.wordLimit}
                              onChange={e => setManualQ({...manualQ, wordLimit: e.target.value})}
                           />
                           <p className="text-[11px] text-slate-400 mt-1">Blank = no limit</p>
                         </div>
                       )}
                     </div>

                     <button 
                        onClick={handleAddManualQuestion}
                        className="w-full py-2 bg-slate-900 text-white rounded-lg hover:bg-slate-800 transition-colors flex justify-center items-center gap-2"
                     >
                       <Plus size={16} /> Add Question
                     </button>
                  </div>

                  <div className="border-t border-slate-100 pt-6">
                    <div className="flex justify-between items-center mb-4">
                       <h4 className="text-sm font-semibold text-slate-600 uppercase tracking-wide flex items-center gap-2">
                         <FileSpreadsheet size={16} /> Bulk Upload (Excel/CSV)
                       </h4>
                       <button 
                         onClick={downloadTemplate}
                         className="text-blue-600 text-sm hover:underline flex items-center gap-1"
                       >
                         <Download size={14} /> Download Template
                       </button>
                    </div>
                    
                    <div className="border-2 border-dashed border-slate-300 rounded-lg p-6 flex flex-col items-center justify-center bg-slate-50 hover:bg-blue-50 hover:border-blue-300 transition-colors cursor-pointer relative">
                      <input 
                        ref={fileInputRef}
                        type="file" 
                        accept=".csv" 
                        className="absolute inset-0 opacity-0 cursor-pointer"
                        onChange={handleFileUpload}
                      />
                      <Upload size={32} className="text-slate-400 mb-2" />
                      <p className="text-sm text-slate-600 font-medium">Click to upload CSV</p>
                    </div>
                    <p className="mt-2 text-xs text-slate-500">
                      Supports MCQ, Multi-Select, True/False, Yes/No, Short/Long Text, Fill-Blank, Numeric, Date &amp; Time.
                      The template explains each column. Matching, Ordering &amp; Drag-Drop use the manual editor.
                    </p>

                    {/* Upload Status Messages */}
                    {uploadStatus === 'SUCCESS' && (
                      <div className="mt-3 p-3 bg-teal-50 text-teal-700 text-sm rounded-lg flex items-center gap-2 border border-teal-100">
                        <CheckCircle size={16} /> {uploadMsg}
                      </div>
                    )}
                    {uploadStatus === 'PARTIAL' && (
                      <div className="mt-3 p-3 bg-orange-50 text-orange-800 text-sm rounded-lg flex items-center gap-2 border border-orange-100">
                        <FileWarning size={16} /> {uploadMsg}
                      </div>
                    )}
                    {uploadStatus === 'ERROR' && (
                      <div className="mt-3 p-3 bg-red-50 text-red-700 text-sm rounded-lg flex items-center gap-2 border border-red-100">
                        <AlertCircle size={16} /> {uploadMsg}
                      </div>
                    )}

                    {/* Detailed Error Report */}
                    {csvErrors.length > 0 && (
                      <div className="mt-4 bg-red-50 rounded-lg border border-red-100 overflow-hidden">
                        <div className="px-4 py-2 bg-red-100 border-b border-red-200 flex items-center gap-2 text-red-800 text-xs font-bold uppercase">
                          <XCircle size={14} /> Failed Rows ({csvErrors.length})
                        </div>
                        <div className="max-h-40 overflow-auto lsc-table-wrap">
                          <table className="w-full text-left text-xs">
                             <thead className="bg-red-100/50 text-red-700">
                               <tr>
                                 <th className="px-4 py-2 w-16">Row</th>
                                 <th className="px-4 py-2">Error</th>
                                 <th className="px-4 py-2 text-slate-500">Raw Data (Truncated)</th>
                               </tr>
                             </thead>
                             <tbody className="divide-y divide-red-100">
                               {csvErrors.map((err, i) => (
                                 <tr key={i} className="hover:bg-red-100/40 transition-colors">
                                   <td className="px-4 py-2 font-mono text-red-600 font-semibold">{err.row}</td>
                                   <td className="px-4 py-2 text-red-800">{err.message}</td>
                                   <td className="px-4 py-2 text-slate-500 font-mono truncate max-w-xs" title={err.rawData}>
                                     {err.rawData.substring(0, 50)}...
                                   </td>
                                 </tr>
                               ))}
                             </tbody>
                          </table>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
             </div>

             {/* Question List */}
             <div className="space-y-3 max-h-[420px] overflow-y-auto pr-1">
               <h3 className="font-semibold text-slate-800 sticky top-0 bg-white/90 backdrop-blur z-10 py-2">
                 Questions ({newExam.questions?.length || 0})
               </h3>
               {questionPaging.pageItems.map((q, pageIdx) => {
                 // Numbering must stay global — Q1 is the first question of the exam, not of the page.
                 const idx = questionPaging.page * questionPaging.pageSize + pageIdx;
                 // Question Bank questions are shared with other exams, so this editor only links or
                 // unlinks them; their content (incl. marks / word limit) is edited in the bank.
                 const fromBank = !!q.bankId;
                 const bankLockTitle = fromBank ? 'Shared Question Bank question — edit it in the Question Bank tab' : undefined;
                 return (
                 <div key={q.id} className={`bg-white p-4 rounded-lg border shadow-sm relative group ${fromBank ? 'border-blue-100' : 'border-slate-200'}`}>
                   {!isPublished && (
                     // Hover-only reveal left the delete control invisible on touch screens and to
                     // keyboard users; it now stays visible on small screens and on focus.
                     <div className="absolute top-4 right-4 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                       <button
                         onClick={() => removeQuestion(q.id)}
                         className="text-red-500 hover:bg-red-50 p-1 rounded transition-colors"
                         aria-label={fromBank ? `Remove question ${idx + 1} from this exam` : `Delete question ${idx + 1}`}
                         title={fromBank ? 'Remove from this exam (stays in the Question Bank)' : 'Delete question'}
                       >
                         <Trash2 size={16} />
                       </button>
                     </div>
                   )}
                   <div className="flex gap-3 mb-2 flex-wrap items-center pr-8">
                     <span className="bg-slate-100 text-slate-600 px-2 py-0.5 rounded text-xs font-mono">Q{idx + 1}</span>
                     <span className="bg-blue-50 text-blue-600 px-2 py-0.5 rounded text-xs font-mono">{q.type}</span>
                     <span className="bg-teal-50 text-teal-600 px-2 py-0.5 rounded text-xs font-mono">{q.marks} marks</span>
                     {fromBank && (
                       <span className="lsc-chip-primary max-w-full" title={`From the “${q.bankName || 'Question Bank'}” question bank`}>
                         <Library size={12} className="shrink-0" aria-hidden="true" />
                         <span className="truncate">From bank: {q.bankName || `#${q.bankId}`}</span>
                       </span>
                     )}
                     {q.type !== QuestionType.SHORT_TEXT && q.type !== QuestionType.LONG_TEXT && q.type !== QuestionType.TEXT && (
                       // Editable in place, same reasoning as the word-limit field below: a penalty
                       // often gets tuned while reviewing the paper, not just at authoring time.
                       <span className="flex items-center gap-1 text-xs text-slate-500">
                         <span className="uppercase tracking-widest text-[10px]">Negative marks</span>
                         <input
                           type="number"
                           min="0"
                           step="0.25"
                           placeholder="0"
                           disabled={isPublished || fromBank}
                           title={bankLockTitle}
                           aria-label={`Negative marks for question ${idx + 1}`}
                           value={q.negativeMarks ?? 0}
                           onChange={e => {
                             const parsed = parseFloat(e.target.value);
                             setNewExam(prev => ({
                               ...prev,
                               questions: (prev.questions || []).map(item =>
                                 item.id === q.id
                                   ? { ...item, negativeMarks: parsed > 0 ? parsed : 0 }
                                   : item
                               ),
                             }));
                           }}
                           className="w-16 px-2 py-0.5 border border-slate-200 rounded text-xs bg-white disabled:bg-slate-50"
                         />
                       </span>
                     )}
                     {(q.type === QuestionType.SHORT_TEXT || q.type === QuestionType.LONG_TEXT || q.type === QuestionType.TEXT) && (
                       // Editable in place: the cap is the kind of thing that gets adjusted while
                       // reviewing a paper, and re-creating the question to change it would be silly.
                       <span className="flex items-center gap-1 text-xs text-slate-500">
                         <span className="uppercase tracking-widest text-[10px]">Word limit</span>
                         <input
                           type="number"
                           min="1"
                           placeholder="none"
                           disabled={isPublished || fromBank}
                           title={bankLockTitle}
                           aria-label={`Word limit for question ${idx + 1}`}
                           value={q.wordLimit ?? ''}
                           onChange={e => {
                             const parsed = parseInt(e.target.value, 10);
                             setNewExam(prev => ({
                               ...prev,
                               questions: (prev.questions || []).map(item =>
                                 item.id === q.id
                                   ? { ...item, wordLimit: parsed > 0 ? parsed : null }
                                   : item
                               ),
                             }));
                           }}
                           className="w-20 px-2 py-0.5 border border-slate-200 rounded text-xs bg-white disabled:bg-slate-50"
                         />
                       </span>
                     )}
                   </div>
                   {useSections && (
                     <div className="flex items-center gap-2 mb-2">
                       <span className="text-[10px] text-slate-500 uppercase tracking-widest">Section</span>
                       <select
                         aria-label={`Section for question ${idx + 1}`}
                         // Moving a question between sections is a question edit — locked once
                         // published, like add/delete and the inline marks fields above.
                         disabled={isPublished}
                         className="px-2 py-1 border border-slate-200 rounded text-xs bg-white disabled:bg-slate-50"
                         value={q.sectionId || sections[0]?.id}
                         onChange={e => {
                           const sectionId = e.target.value;
                           setNewExam(prev => ({
                             ...prev,
                             questions: (prev.questions || []).map(item =>
                               item.id === q.id ? { ...item, sectionId } : item
                             )
                           }));
                         }}
                       >
                         {sections.map(section => (
                           <option key={section.id} value={section.id}>
                             {section.title}
                           </option>
                         ))}
                       </select>
                     </div>
                   )}
                   <p className="text-slate-800 font-medium mb-3 whitespace-pre-wrap">{q.text}</p>
                   {renderAddedQuestionAnswer(q)}
                   {fromBank && (
                     <p className="mt-2 text-[11px] text-slate-500 flex items-start gap-1">
                       <Lock size={11} className="shrink-0 mt-px" aria-hidden="true" />
                       <span>Read-only here — edit it in the Question Bank tab. Removing it only takes it out of this exam.</span>
                     </p>
                   )}
                 </div>
                 );
               })}
               <Pagination state={questionPaging} label="questions" hidePageSize />

               {newExam.questions?.length === 0 && (
                 <div className="text-center py-8 px-4 text-slate-400 border-2 border-dashed border-slate-200 rounded-xl">
                   No questions added yet. Add a question bank, use the manual form or upload a CSV.
                 </div>
               )}
             </div>

             {/* Emails: per-exam invitation / reminder content and design, saved with the exam.
                 Stays editable on a published exam (it changes nothing a candidate is sitting). */}
             <ExamEmailsEditor
               exam={{ ...newExam, proctoringConfig: effectiveProctoringConfig(proctoringConfig) }}
               sampleLink={sampleExamLink()}
               onChange={mailTemplates => setNewExam(prev => ({ ...prev, mailTemplates }))}
             />
          </div>
        </div>
      </div>

      {bankPickerOpen && (() => {
        const selectedBank = bankList.find(b => b.id === selectedBankId) || null;
        const selectedCount = selectedBank ? Math.max(0, Number(selectedBank.questionCount) || 0) : 0;
        return (
          <div
            className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-900/50 p-4"
            onClick={closeBankPicker}
          >
            <div
              role="dialog"
              aria-modal="true"
              aria-labelledby="bank-picker-title"
              onClick={e => e.stopPropagation()}
              className="w-full max-w-lg max-h-[90vh] rounded-2xl bg-white shadow-xl border border-slate-200 flex flex-col overflow-hidden"
            >
              <div className="p-4 border-b border-slate-100 flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 id="bank-picker-title" className="text-lg font-semibold text-slate-900 flex items-center gap-2">
                    <Library size={18} className="text-[var(--lsc-primary)]" aria-hidden="true" /> Add from Question Bank
                  </h3>
                  <p className="text-sm text-slate-500 mt-0.5">
                    Pick a bank to add all of its questions{bankTargetSection ? <> to <span className="font-medium text-slate-700">{bankTargetSection.title || 'the active section'}</span></> : ''}.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={closeBankPicker}
                  disabled={bankAdding}
                  className="shrink-0 p-1.5 rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-600 disabled:opacity-50"
                  aria-label="Close question bank picker"
                >
                  <XCircle size={20} />
                </button>
              </div>

              <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-3">
                {bankListLoading ? (
                  <div className="flex items-center justify-center gap-2 text-sm text-slate-500 py-10">
                    <Loader2 size={16} className="animate-spin" /> Loading question banks…
                  </div>
                ) : bankListError ? (
                  <div className="p-3 rounded-lg bg-rose-50 border border-rose-100 text-sm text-rose-700 flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between" role="alert">
                    <span className="flex items-start gap-2"><AlertCircle size={16} className="shrink-0 mt-0.5" /> {bankListError}</span>
                    <button type="button" onClick={loadQuestionBanks} className="shrink-0 self-start px-3 py-1.5 rounded-lg border border-rose-200 bg-white text-xs font-semibold text-rose-700 hover:bg-rose-50">
                      Try again
                    </button>
                  </div>
                ) : bankList.length === 0 ? (
                  <div className="text-center py-8 px-4 border-2 border-dashed border-slate-200 rounded-xl">
                    <Library size={28} className="mx-auto text-slate-300 mb-2" aria-hidden="true" />
                    <p className="text-sm font-semibold text-slate-700">No question banks yet</p>
                    <p className="text-xs text-slate-500 mt-1 leading-relaxed">
                      Create one in the <span className="font-semibold text-slate-700">Question Bank</span> tab in the sidebar, then come back here.
                      Save this exam as a draft first so you don’t lose your changes.
                    </p>
                  </div>
                ) : (
                  <>
                    <div className="relative">
                      <Search className="absolute left-2.5 top-2.5 text-slate-400" size={14} aria-hidden="true" />
                      <input
                        type="text"
                        placeholder="Search banks…"
                        aria-label="Search question banks"
                        className="w-full pl-8 pr-3 py-2 text-sm border rounded-lg outline-none"
                        value={bankSearch}
                        onChange={e => setBankSearch(e.target.value)}
                      />
                    </div>
                    {filteredBanks.length === 0 ? (
                      <p className="text-sm text-slate-500 text-center py-6">No banks match “{bankSearch.trim()}”.</p>
                    ) : (
                      <div role="radiogroup" aria-label="Question banks" className="space-y-2">
                        {bankPaging.pageItems.map(bank => {
                          const active = bank.id === selectedBankId;
                          const count = Math.max(0, Number(bank.questionCount) || 0);
                          return (
                            <button
                              key={bank.id}
                              type="button"
                              role="radio"
                              aria-checked={active}
                              onClick={() => { setSelectedBankId(bank.id); setBankAddError(null); }}
                              className={`w-full text-left px-3 py-2.5 rounded-lg border transition-colors ${
                                active ? 'border-[var(--lsc-primary)] bg-blue-50 ring-1 ring-[var(--lsc-primary)]/30' : 'border-slate-200 bg-white hover:bg-slate-50'
                              }`}
                            >
                              <div className="flex items-start justify-between gap-3">
                                <span className={`text-sm font-medium break-words min-w-0 ${active ? 'text-slate-900' : 'text-slate-700'}`}>{bank.name}</span>
                                <span className={`shrink-0 text-xs font-semibold ${active ? 'text-[var(--lsc-primary)]' : 'text-slate-500'}`}>
                                  {count} question{count === 1 ? '' : 's'}
                                </span>
                              </div>
                              {bank.description && (
                                <p className="text-xs text-slate-500 mt-0.5 line-clamp-2 break-words">{bank.description}</p>
                              )}
                              {bank.examCount > 0 && (
                                <p className="text-[11px] text-slate-400 mt-0.5">Used in {bank.examCount} exam{bank.examCount === 1 ? '' : 's'}</p>
                              )}
                            </button>
                          );
                        })}
                      </div>
                    )}
                    {bankPaging.totalPages > 1 && <Pagination state={bankPaging} label="banks" hidePageSize />}
                  </>
                )}

                {bankAddError && (
                  <div className="p-3 rounded-lg bg-rose-50 border border-rose-100 text-xs text-rose-700 flex items-start gap-2" role="alert">
                    <AlertCircle size={14} className="shrink-0 mt-0.5" /> {bankAddError}
                  </div>
                )}
              </div>

              <div className="p-4 border-t border-slate-100 bg-slate-50 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <p className="text-xs text-slate-500 min-w-0 flex-1">
                  {selectedBank
                    ? (selectedCount === 0 ? 'This bank has no questions yet.' : 'Questions already in this exam are skipped.')
                    : bankList.length > 0 && !bankListLoading && !bankListError
                      ? 'Then set the question count to give each candidate a random subset.'
                      : ''}
                </p>
                <div className="flex items-center gap-2 justify-end shrink-0">
                  <button
                    type="button"
                    onClick={closeBankPicker}
                    disabled={bankAdding}
                    className="px-4 py-2 rounded-lg text-sm text-slate-500 hover:bg-slate-100 disabled:opacity-50"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={addSelectedBank}
                    disabled={!selectedBank || selectedCount === 0 || bankAdding || bankListLoading}
                    className="px-4 py-2 lsc-button-primary text-sm whitespace-nowrap flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {bankAdding ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
                    {bankAdding ? 'Adding…' : selectedBank ? `Add all ${selectedCount} question${selectedCount === 1 ? '' : 's'}` : 'Add questions'}
                  </button>
                </div>
              </div>
            </div>
          </div>
        );
      })()}

      {showMailPreview && (() => {
        const mailPreviewExam = {
          ...newExam,
          title: newExam.title || 'Sample Exam',
          startTime: newExam.startTime || Date.now(),
          endTime: newExam.endTime || Date.now() + 3600000,
          durationMinutes: newExam.durationMinutes || 60,
          proctoringConfig: effectiveProctoringConfig(proctoringConfig),
        } as Exam;
        const sampleLink = sampleExamLink();
        const { subject, body } = buildExamEmailContent(
          mailPreviewExam,
          'Sample Student',
          sampleLink,
          mailPreviewMode === 'reminder'
        );
        return (
          <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-900/50 p-4">
            <div className="w-full max-w-2xl max-h-[90vh] rounded-2xl bg-white shadow-xl border border-slate-200 flex flex-col overflow-hidden">
              <div className="p-4 border-b border-slate-100 flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="text-lg font-semibold text-slate-900">Email Preview</h3>
                  <p className="text-sm text-slate-500 mt-0.5 truncate">Subject: <span className="text-slate-700 font-medium">{subject}</span></p>
                </div>
                <button
                  onClick={() => setShowMailPreview(false)}
                  className="shrink-0 p-1.5 rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-600"
                  aria-label="Close preview"
                >
                  <XCircle size={20} />
                </button>
              </div>
              <div className="px-4 pt-3 flex gap-2">
                <button
                  onClick={() => setMailPreviewMode('invite')}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold border ${mailPreviewMode === 'invite' ? 'bg-blue-50 border-blue-200 text-blue-700' : 'bg-white border-slate-200 text-slate-500 hover:bg-slate-50'}`}
                >
                  Invitation
                </button>
                <button
                  onClick={() => setMailPreviewMode('reminder')}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold border ${mailPreviewMode === 'reminder' ? 'bg-blue-50 border-blue-200 text-blue-700' : 'bg-white border-slate-200 text-slate-500 hover:bg-slate-50'}`}
                >
                  Reminder
                </button>
              </div>
              <p className="px-4 pt-2 text-xs text-slate-400">
                Rendered with sample data ("Sample Student"). This is exactly the HTML that will be sent — edit the subject/message above and reopen this preview to see your changes.
              </p>
              <div className="flex-1 min-h-0 p-4">
                <iframe
                  title="Email preview"
                  srcDoc={body}
                  className="w-full h-full min-h-[420px] rounded-lg border border-slate-200 bg-white"
                  sandbox=""
                />
              </div>
            </div>
          </div>
        );
      })()}
      </>
    );
  };
  
  // Per-exam Mail Composer. Audience counts are computed from the loaded recipient list, and the
  // preview is rendered from the SAME builder that sends, so what the admin sees is what goes out.
  const renderMailComposer = () => {
    if (!mailComposer) return null;
    const { exam, kind, subject, message, audience, recipients, loading, saving, error, notice } = mailComposer;
    const reminder = kind === 'REMINDER';
    const targets = filterByAudience(recipients, audience);
    const sample = targets[0] || recipients[0];
    const previewLink = reminder ? '' : sampleExamLink();
    const preview = buildExamEmailContent(exam, sample?.fullName || 'Sample Student', previewLink, reminder, { subject, message });
    const busy = saving || emailSendingId === exam.id;

    return (
      <div className="fixed inset-0 z-[90] flex items-center justify-center bg-slate-900/50 p-4">
        <div className="w-full max-w-5xl max-h-[92vh] rounded-2xl bg-white shadow-xl border border-slate-200 flex flex-col overflow-hidden">
          <div className="p-4 border-b border-slate-100 flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h3 className="text-lg font-semibold text-slate-900">Compose Email</h3>
              <p className="text-sm text-slate-500 mt-0.5 truncate">{exam.title}</p>
            </div>
            <button
              onClick={closeComposer}
              className="shrink-0 p-1.5 rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-600"
              aria-label="Close composer"
            >
              <XCircle size={20} />
            </button>
          </div>

          {/* Stacked on small screens, so the body scrolls as a whole there; side-by-side panes scroll
              independently from lg up. (With overflow-hidden at every size, a phone squeezed the
              editor pane to a sliver above the fixed-height preview.) */}
          <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-2 gap-0 overflow-y-auto lg:overflow-hidden">
            {/* Editor */}
            <div className="min-h-0 overflow-y-auto p-4 space-y-4 border-b lg:border-b-0 lg:border-r border-slate-100">
              <div>
                <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5">Email type</label>
                <div className="flex gap-2">
                  {(['INVITE', 'REMINDER'] as ExamMailKind[]).map(k => (
                    <button
                      key={k}
                      onClick={() => switchComposerKind(k)}
                      className={`px-3 py-1.5 rounded-lg text-xs font-semibold border ${kind === k ? 'bg-blue-50 border-blue-200 text-blue-700' : 'bg-white border-slate-200 text-slate-500 hover:bg-slate-50'}`}
                    >
                      {k === 'INVITE' ? 'Invitation (with link)' : 'Reminder (no link)'}
                    </button>
                  ))}
                </div>
                <p className="text-[11px] text-slate-400 mt-1.5">
                  {reminder
                    ? 'Reminders deliberately carry no access link — students reuse the link from their invitation.'
                    : 'Invitations include each student’s own secure, signed exam link.'}
                </p>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5">Send to</label>
                {loading ? (
                  <div className="flex items-center gap-2 text-sm text-slate-500 py-2">
                    <Loader2 size={14} className="animate-spin" /> Loading recipients…
                  </div>
                ) : (
                  <div className="grid grid-cols-2 gap-2">
                    {MAIL_AUDIENCES.map(opt => {
                      const count = filterByAudience(recipients, opt.id).length;
                      const active = audience === opt.id;
                      return (
                        <button
                          key={opt.id}
                          onClick={() => setMailComposer(prev => (prev ? { ...prev, audience: opt.id } : prev))}
                          className={`text-left px-3 py-2 rounded-lg border transition-colors ${active ? 'bg-blue-50 border-blue-200' : 'bg-white border-slate-200 hover:bg-slate-50'}`}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className={`text-xs font-semibold ${active ? 'text-blue-700' : 'text-slate-700'}`}>{opt.label}</span>
                            <span className={`text-xs font-bold ${active ? 'text-blue-700' : 'text-slate-500'}`}>{count}</span>
                          </div>
                          <p className="text-[11px] text-slate-400 mt-0.5 leading-snug">{opt.hint}</p>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5">Subject</label>
                <input
                  type="text"
                  value={subject}
                  onChange={e => setMailComposer(prev => (prev ? { ...prev, subject: e.target.value, dirty: true, notice: null } : prev))}
                  className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-blue-100 focus:border-blue-300"
                  placeholder={reminder ? 'Reminder — {ExamTitle}' : 'Your Exam Invitation — {ExamTitle}'}
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5">Message</label>
                <textarea
                  value={message}
                  onChange={e => setMailComposer(prev => (prev ? { ...prev, message: e.target.value, dirty: true, notice: null } : prev))}
                  rows={10}
                  className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm font-mono leading-relaxed focus:outline-none focus:ring-2 focus:ring-blue-100 focus:border-blue-300"
                />
                <p className="text-[11px] text-slate-400 mt-1.5">
                  Placeholders: <code>{'{StudentName}'}</code>, <code>{'{ExamTitle}'}</code>, <code>{'{StartTime}'}</code>,
                  {' '}<code>{'{EndTime}'}</code>, <code>{'{Duration}'}</code>
                  {!reminder && <> , <code>{'{Link}'}</code></>}. Blank lines start a new paragraph. The exam details,
                  requirements and instructions link are added below your message; their design (header, colour,
                  which blocks show) is set in the exam editor’s Emails section.
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <button
                  onClick={saveComposerTemplate}
                  disabled={busy}
                  className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-slate-200 text-xs font-semibold text-slate-600 hover:bg-slate-50 disabled:opacity-50"
                >
                  <Save size={13} /> Save as default
                </button>
                <button
                  onClick={resetComposerTemplate}
                  disabled={busy}
                  className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-slate-200 text-xs font-semibold text-slate-500 hover:bg-slate-50 disabled:opacity-50"
                >
                  Reset to default
                </button>
                {notice && <span className="text-xs text-teal-600 font-medium">{notice}</span>}
              </div>

              {error && (
                <div className="flex items-start gap-2 p-3 rounded-lg bg-rose-50 border border-rose-100 text-xs text-rose-700">
                  <AlertCircle size={14} className="shrink-0 mt-0.5" /> {error}
                </div>
              )}
            </div>

            {/* Live preview */}
            <div className="min-h-0 flex flex-col p-4">
              <p className="text-xs text-slate-500 mb-2">
                Preview as <span className="font-medium text-slate-700">{sample?.fullName || 'Sample Student'}</span> — exactly the HTML that will be sent.
              </p>
              <EmailPreviewFrame
                html={preview.body}
                title="Composed email preview"
                className="flex-1 min-h-0 flex flex-col"
                viewportClassName="flex-1 min-h-[320px]"
              />
            </div>
          </div>

          <div className="p-4 border-t border-slate-100 flex flex-wrap items-center justify-between gap-3 bg-slate-50">
            <div className="space-y-1.5 min-w-0">
              <p className="text-sm text-slate-600">
                {loading
                  ? 'Resolving recipients…'
                  : <>Sending to <span className="font-semibold text-slate-900">{targets.length}</span> of {recipients.length} assigned student{recipients.length === 1 ? '' : 's'}</>}
              </p>
              {!loading && renderWhatsAppOptIn(exam, kind, targets)}
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={closeComposer}
                className="px-4 py-2 rounded-lg text-sm text-slate-500 hover:bg-slate-100"
              >
                Cancel
              </button>
              <button
                onClick={sendFromComposer}
                disabled={busy || loading || targets.length === 0}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
              >
                {busy ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
                Send to {targets.length}
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  };

  // Render List View (Default)
  return (
    <div className="space-y-6">
      {renderMailComposer()}
      {inviteScopeTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
          <div className="w-full max-w-md rounded-2xl bg-white shadow-xl border border-slate-200">
            <div className="p-5 border-b border-slate-100">
              <h3 className="text-lg font-semibold text-slate-900">Send Invitations</h3>
              {inviteScopeTarget.confirmText ? (
                <p className="text-sm text-slate-600 mt-1">{inviteScopeTarget.confirmText}</p>
              ) : (
                <p className="text-sm text-slate-600 mt-1">
                  <span className="font-medium text-slate-900">{inviteScopeTarget.pending.length}</span> of{' '}
                  {inviteScopeTarget.recipients.length} students assigned to{' '}
                  <span className="font-medium text-slate-900">{inviteScopeTarget.exam.title}</span> have not received a link yet.
                </p>
              )}
            </div>
            <div className="p-5 space-y-3">
              {waReadyFor('INVITE') && (
                <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5">
                  {renderWhatsAppOptIn(inviteScopeTarget.exam, 'INVITE', inviteScopeTarget.confirmText ? inviteScopeTarget.recipients : inviteScopeTarget.pending)}
                </div>
              )}
              {inviteScopeTarget.confirmText ? (
                <button
                  onClick={() => {
                    const target = inviteScopeTarget;
                    setInviteScopeTarget(null);
                    dispatchEmails(target.exam, target.recipients, false, undefined, waReadyFor('INVITE') && waOptIn);
                  }}
                  className="w-full px-4 py-2.5 rounded-lg bg-blue-600 text-white font-medium hover:bg-blue-700"
                >
                  Send to {inviteScopeTarget.recipients.length} student{inviteScopeTarget.recipients.length === 1 ? '' : 's'}
                </button>
              ) : (
                <>
                  <button
                    onClick={() => {
                      const target = inviteScopeTarget;
                      setInviteScopeTarget(null);
                      dispatchEmails(target.exam, target.pending, false, undefined, waReadyFor('INVITE') && waOptIn);
                    }}
                    className="w-full px-4 py-2.5 rounded-lg bg-blue-600 text-white font-medium hover:bg-blue-700"
                  >
                    Send to {inviteScopeTarget.pending.length} new students only
                  </button>
                  <button
                    onClick={() => {
                      const target = inviteScopeTarget;
                      setInviteScopeTarget(null);
                      dispatchEmails(target.exam, target.recipients, false, undefined, waReadyFor('INVITE') && waOptIn);
                    }}
                    className="w-full px-4 py-2.5 rounded-lg border border-slate-200 text-slate-700 hover:bg-slate-50"
                  >
                    Resend to all {inviteScopeTarget.recipients.length} students
                  </button>
                </>
              )}
              <p className="text-xs text-slate-400 text-center px-2">
                Existing links never change — resending only mails the same link again.
              </p>
              <button
                onClick={() => setInviteScopeTarget(null)}
                className="w-full px-4 py-2.5 rounded-lg text-slate-500 hover:bg-slate-50"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
          <div className="w-full max-w-md rounded-2xl bg-white shadow-xl border border-slate-200">
            <div className="p-5 border-b border-slate-100">
              <h3 className="text-lg font-semibold text-slate-900">Remove Exam</h3>
              <p className="text-sm text-slate-600 mt-1">
                Choose how to remove <span className="font-medium text-slate-900">{deleteTarget.title}</span>.
              </p>
            </div>
            <div className="p-5 space-y-3">
              <button
                onClick={handleArchiveExam}
                disabled={deleteBusy}
                className="w-full px-4 py-2.5 rounded-lg border border-slate-200 text-slate-700 hover:bg-slate-50 disabled:opacity-60"
              >
                Archive (Hide from list)
              </button>
              <button
                onClick={handlePermanentDeleteExam}
                disabled={deleteBusy}
                className="w-full px-4 py-2.5 rounded-lg border border-rose-200 text-rose-600 hover:bg-rose-50 disabled:opacity-60"
              >
                Delete Permanently
              </button>
              <p className="text-xs text-slate-500 text-center px-2">
                Archiving keeps every attempt and result. Deleting permanently also erases all candidate attempts, answers and results for this exam.
              </p>
              <button
                onClick={() => !deleteBusy && setDeleteTarget(null)}
                disabled={deleteBusy}
                className="w-full px-4 py-2.5 rounded-lg text-slate-500 hover:bg-slate-50 disabled:opacity-60"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
      
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="lsc-title">Exam Management</h2>
          <p className="lsc-subtitle mt-1">Create, duplicate, and publish exams with full security controls.</p>
        </div>
        <div className="flex flex-wrap gap-2 items-center">
          {isSuperAdmin && (
            <select
              value={selectedCompanyId}
              onChange={e => setSelectedCompanyId(e.target.value === '' ? '' : Number(e.target.value))}
              className="px-3 py-2 border border-slate-200 rounded-lg bg-white text-sm outline-none min-w-[200px]"
              title="Select a company to manage its exams"
            >
              <option value="">Select a company…</option>
              {companies.map(company => (
                <option key={company.id} value={company.id}>{company.name}</option>
              ))}
            </select>
          )}
          <input
            ref={examImportRef}
            type="file"
            accept=".json"
            className="hidden"
            onChange={e => {
              const file = e.target.files?.[0];
              if (file) {
                importExams(file);
              }
              if (examImportRef.current) examImportRef.current.value = '';
            }}
          />
          {archivedCount > 0 && (
            <button
              onClick={() => setShowArchived(v => !v)}
              aria-pressed={showArchived}
              className="px-4 py-2 lsc-button-ghost flex items-center gap-2 text-sm"
            >
              {showArchived ? 'Hide archived' : `Show archived (${archivedCount})`}
            </button>
          )}
          <button
            onClick={() => examImportRef.current?.click()}
            // Same gate as Create: with no company picked, a super admin's import would land in
            // whatever company the request headers resolve to and never appear in this (empty) grid.
            disabled={isSuperAdmin && !effectiveCompanyId}
            className="px-4 py-2 lsc-button-ghost flex items-center gap-2 text-sm disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Upload size={16} /> Import
          </button>
          <button
            onClick={exportExams}
            className="px-4 py-2 lsc-button-ghost flex items-center gap-2 text-sm"
          >
            <Download size={16} /> Export
          </button>
          <button
            onClick={() => { resetForm(); setIsCreating(true); }}
            disabled={isSuperAdmin && !effectiveCompanyId}
            className="px-4 py-2 lsc-button-primary flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Plus size={20} /> Create Exam
          </button>
        </div>
      </div>

      {isSuperAdmin && !effectiveCompanyId ? (
        <div className="bg-white rounded-xl border border-dashed border-slate-300 p-10 text-center text-slate-500">
          Select a company above to view and manage its exams.
        </div>
      ) : isSuperAdmin && superExamsLoading ? (
        <div className="bg-white rounded-xl border border-slate-200 p-10 text-center text-slate-500">
          Loading exams…
        </div>
      ) : visibleExams.length === 0 ? (
        // An empty grid used to render as blank space with no hint of what to do next.
        <div className="bg-white rounded-xl border border-dashed border-slate-300 p-10 text-center text-slate-500">
          {exams.length === 0
            ? 'No exams yet. Click “Create Exam” to build your first one.'
            : 'All exams are archived. Use “Show archived” to view them.'}
        </div>
      ) : (
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {examPaging.pageItems.map(exam => (
          <div
            key={exam.id}
            onClick={() => handleEditExam(exam)}
            className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden hover:shadow-md transition-shadow cursor-pointer group"
          >
            <div className="p-5 border-b border-slate-100 relative">
              <div className="flex justify-between items-start mb-2">
                <div className="flex flex-wrap items-center gap-2 min-w-0">
                  <span className={`px-2 py-1 text-xs font-bold rounded uppercase tracking-wide ${
                    exam.status === 'PUBLISHED' ? 'bg-teal-100 text-teal-700' :
                    exam.status === 'DRAFT' ? 'bg-orange-100 text-orange-700' : 'bg-slate-100 text-slate-600'
                  }`}>
                    {exam.status}
                  </span>
                  {exam.proctoringConfig?.mode === 'UNPROCTORED' && (
                    <span className="lsc-chip-neutral" title="No camera, microphone, screen or tab monitoring">
                      <ShieldOff size={12} aria-hidden="true" /> Unproctored
                    </span>
                  )}
                </div>
                <button
                  onClick={e => {
                    e.stopPropagation();
                    handleDeleteExam(exam);
                  }}
                  className="p-1 rounded-full text-rose-400 hover:text-rose-600 hover:bg-rose-50 transition-colors"
                  title="Delete exam"
                  aria-label={`Delete exam ${exam.title}`}
                >
                  <Trash2 size={16} />
                </button>
              </div>
              <h3 className="font-bold text-slate-800 text-lg truncate" title={exam.title}>{exam.title}</h3>
              <div className="flex items-center gap-4 mt-3 text-sm text-slate-500">
                <div className="flex items-center gap-1"><Clock size={14}/> {exam.durationMinutes}m</div>
                {/* Individually assigned students (no batch) were shown as "All", though only they get mailed. */}
                <div className="flex items-center gap-1"><Users size={14}/> {exam.assignedBatchIds?.length
                  ? `${exam.assignedBatchIds.length} batches`
                  : exam.assignedStudentIds?.length ? `${exam.assignedStudentIds.length} students` : 'All'}</div>
                {!!exam.pendingInviteCount && (
                  <div
                    className="flex items-center gap-1 text-amber-600 font-medium"
                    title={`${exam.pendingInviteCount} assigned students have not been sent a link yet`}
                  >
                    <Mail size={14}/> {exam.pendingInviteCount} to invite
                  </div>
                )}
                {!!exam.notAttemptedCount && (
                  <div
                    className="flex items-center gap-1 text-rose-600 font-medium"
                    title={`${exam.notAttemptedCount} assigned students have not attempted this exam yet`}
                  >
                    <Bell size={14}/> {exam.notAttemptedCount} not attempted
                  </div>
                )}
              </div>
              <div className="flex items-center gap-1 mt-2 text-xs text-slate-400 truncate" title={formatScheduleShort(exam.startTime, resolveExamTimezone(exam.timezone))}>
                <Calendar size={12}/> {formatScheduleShort(exam.startTime, resolveExamTimezone(exam.timezone))}
              </div>
            </div>
            <div className="bg-slate-50 px-3 py-2">
              <div className="flex flex-wrap items-center justify-center gap-2 sm:gap-3">
                <button
                  onClick={e => {
                    e.stopPropagation();
                    handleEditExam(exam);
                  }}
                  className="inline-flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-white/80 text-[11px] sm:text-xs font-medium text-slate-600 hover:text-blue-600 hover:bg-white shadow-xs"
                >
                  <Pencil size={12} /> Edit
                </button>
                <button
                  onClick={e => {
                    e.stopPropagation();
                    handleDuplicateExam(exam);
                  }}
                  disabled={!!duplicatingId}
                  className="inline-flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-white/80 text-[11px] sm:text-xs font-medium text-slate-600 hover:text-blue-600 hover:bg-white disabled:opacity-50 shadow-xs"
                >
                  {duplicatingId === exam.id ? <Loader2 size={12} className="animate-spin" /> : <Copy size={12} />} Duplicate
                </button>
                <button
                  onClick={e => {
                    e.stopPropagation();
                    handleSendEmail(exam);
                  }}
                  disabled={!!emailSendingId}
                  className="inline-flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-white/80 text-[11px] sm:text-xs font-medium text-slate-600 hover:text-blue-600 hover:bg-white disabled:opacity-50 shadow-xs"
                >
                  {emailSendingId === exam.id && sendingMode === 'notify' ? <Loader2 size={12} className="animate-spin"/> : <Mail size={12} />}
                  Notify
                </button>
                <button
                  onClick={e => {
                    e.stopPropagation();
                    // Opens the composer pre-set to chase the students who never attempted, with the
                    // subject/message editable per exam before anything goes out.
                    openMailComposer(exam, 'REMINDER');
                  }}
                  disabled={!!emailSendingId}
                  className="inline-flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-white/80 text-[11px] sm:text-xs font-medium text-slate-600 hover:text-amber-600 hover:bg-white disabled:opacity-50 shadow-xs"
                >
                  {emailSendingId === exam.id && sendingMode === 'reminder' ? <Loader2 size={12} className="animate-spin"/> : <Bell size={12} />}
                  Reminder
                </button>
                <button
                  onClick={e => {
                    e.stopPropagation();
                    handleExportLinks(exam);
                  }}
                  disabled={!!exportingLinksId}
                  className="inline-flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-white/80 text-[11px] sm:text-xs font-medium text-slate-600 hover:text-blue-600 hover:bg-white disabled:opacity-50 shadow-xs"
                >
                  {exportingLinksId === exam.id ? <Loader2 size={12} className="animate-spin" /> : <Share2 size={12} />} Links
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>
      )}
      {/* Guarded on totalPages so a single page of exams doesn't leave an empty panel behind. */}
      {examPaging.totalPages > 1 && !(isSuperAdmin && (!effectiveCompanyId || superExamsLoading)) && (
        <div className="lsc-panel overflow-hidden">
          <Pagination state={examPaging} label="exams" />
        </div>
      )}
    </div>
  );
};
