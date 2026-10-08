import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Award, Ban, BarChart3, CheckCircle2, ChevronDown, ClipboardList, Download, FileText, GraduationCap, Search, ShieldAlert, TrendingUp, Trophy, UserX, Users, XCircle } from 'lucide-react';
import { apiGet, apiPost } from '../../services/api';
import { Pagination, usePagination } from './Pagination';
import { Exam, ExamResultRecord, QuestionType, ResultAuditLog, SessionFeedback, Student, UserRole, isManualGraded } from '../../types';
import { formatResultAnswer } from '../../services/answerFormat';
import { resolveExamTimezone, formatScheduleShort } from '../../services/timezone';
import { groupViolationEpisodes, formatEpisodeDuration } from '../../services/violationEpisodes';

interface ResultsProps {
  exams: Exam[];
  students: Student[];
  /** Signed-in staff role. Falls back to the stored admin session when the caller doesn't pass it. */
  role?: UserRole;
}

// Stable empty list for the not-attempted roster when no exam is selected — a fresh `[]` each render
// would make the paging hook recompute its slice on every pass.
const EMPTY_ROSTER: never[] = [];

// Same source App.tsx uses for the signed-in role; only consulted when no `role` prop is passed.
const getStoredStaffRole = (): string => {
  if (typeof window === 'undefined') return UserRole.ADMIN;
  try {
    const raw = localStorage.getItem('pg_admin_auth');
    if (!raw) return UserRole.ADMIN;
    return String(JSON.parse(raw)?.role || UserRole.ADMIN).trim().toUpperCase();
  } catch {
    return UserRole.ADMIN;
  }
};

// The super-admin's globally selected company (the top-bar switcher writes it; services/api.ts sends
// it as X-Company-Id). This screen stays mounted across a switch, so its data must reload when this
// changes — otherwise the previous company's attempts keep showing under the new company's exams.
const getActiveCompanyScope = (): string => {
  if (typeof window === 'undefined') return '';
  try {
    return localStorage.getItem('pg_admin_active_company') || '';
  } catch {
    return '';
  }
};

// Spreadsheet apps execute a cell that starts with = + - @ (or a tab/CR) as a formula. Student names,
// free-text answers and feedback all flow into these exports, so neutralise them with a leading
// apostrophe — but leave plain numbers (e.g. "-1" marks) and the "-" placeholder untouched.
const neutraliseCsvFormula = (str: string): string =>
  /^[=+\-@\t\r]/.test(str) && str !== '-' && !/^-?\d+(\.\d+)?%?$/.test(str) ? `'${str}` : str;

interface QuestionAnalytics {
  questionId: string;
  questionText: string;
  questionType: string;
  marks: number;
  attempts: number;
  gradedAttempts: number;
  correctRate: number;
  difficulty: number;
  avgAwardedMarks: number;
  avgTimeSec: number;
  discrimination: number;
}

interface EnterpriseReport {
  generatedAt: number;
  dateFilter: { from: string; to: string } | null;
  summary: {
    exams: number;
    students: number;
    sessions: number;
    completed: number;
    terminated: number;
    violations: number;
    completionRate: number;
    passRate: number;
    avgPercent: number;
  };
  byExam: Array<{
    id: string;
    title: string;
    status: string;
    attempts: number;
    completed: number;
    terminated: number;
    passed: number;
    passRate: number;
    avgPercent: number;
    violations: number;
  }>;
  byBatch: Array<{
    id: number;
    name: string;
    students: number;
    attempts: number;
    completed: number;
    terminated: number;
    passed: number;
    passRate: number;
    avgPercent: number;
    violations: number;
  }>;
  byStudent: Array<{
    id: string;
    name: string;
    registrationId: string;
    batch?: string | null;
    attempts: number;
    completed: number;
    terminated: number;
    passed: number;
    passRate: number;
    avgPercent: number;
    violations: number;
  }>;
  violationsByType: Array<{ type: string; count: number }>;
  violationTimeline: Array<{ date: string; count: number }>;
  recentViolations: Array<{
    id: number;
    sessionId: number;
    examTitle: string;
    studentName: string;
    registrationId: string;
    batch?: string | null;
    timestamp: number;
    type: string;
    description: string;
  }>;
}

export const Results: React.FC<ResultsProps> = ({ exams, students, role }) => {
  // Regrading and certificate issuance are ADMIN / SUPER_ADMIN actions (the API rejects anyone else);
  // a read-only VIEWER must not be offered them.
  const effectiveRole = role ?? getStoredStaffRole();
  const canManageResults = effectiveRole === UserRole.ADMIN || effectiveRole === UserRole.SUPER_ADMIN;
  const companyScope = getActiveCompanyScope();
  const [results, setResults] = useState<ExamResultRecord[]>([]);
  const [selectedExamId, setSelectedExamId] = useState<string>('ALL');
  const [selectedStudentId, setSelectedStudentId] = useState<string>('ALL');
  const [statusFilter, setStatusFilter] = useState<'ALL' | 'COMPLETED' | 'TERMINATED'>('ALL');
  const [activeTab, setActiveTab] = useState<'results' | 'analytics' | 'report'>('results');
  const [notAttemptedOpen, setNotAttemptedOpen] = useState(false);
  const [selectedSessionId, setSelectedSessionId] = useState<number | null>(null);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string>('');
  const [saving, setSaving] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [draftMarks, setDraftMarks] = useState<Record<string, string>>({});
  const [graderName, setGraderName] = useState('Admin');
  const [gradeNote, setGradeNote] = useState('');
  const [auditLogs, setAuditLogs] = useState<ResultAuditLog[]>([]);
  const [auditLoading, setAuditLoading] = useState(false);
  const [analytics, setAnalytics] = useState<QuestionAnalytics[]>([]);
  const [analyticsLoading, setAnalyticsLoading] = useState(false);
  const [attemptReasons, setAttemptReasons] = useState<Record<string, { reason: string; lastActivity: number | null }>>({});
  const [report, setReport] = useState<EnterpriseReport | null>(null);
  const [reportLoading, setReportLoading] = useState(false);
  const [reportFromDate, setReportFromDate] = useState('');
  const [reportToDate, setReportToDate] = useState('');
  const [dossierBusy, setDossierBusy] = useState(false);
  const [certBusy, setCertBusy] = useState(false);
  const [certStatus, setCertStatus] = useState<Record<number, string>>({});
  const [rosterBusy, setRosterBusy] = useState(false);
  const [batchBusy, setBatchBusy] = useState(false);
  const [examReportBusy, setExamReportBusy] = useState(false);
  const [examZipBusy, setExamZipBusy] = useState(false);
  const [zipProgress, setZipProgress] = useState('');
  const [reportsMenuOpen, setReportsMenuOpen] = useState(false);
  const reportsMenuRef = useRef<HTMLDivElement>(null);
  const [feedback, setFeedback] = useState<Array<SessionFeedback & {
    examTitle?: string;
    studentName?: string;
    registrationId?: string;
    batch?: string | null;
  }>>([]);

  // Only the newest request may write state: a slow response for a previous company (or a previous
  // report date range) must not land on top of the current one.
  const resultsRequestRef = useRef(0);
  const reportRequestRef = useRef(0);

  const loadResults = async () => {
    const requestId = ++resultsRequestRef.current;
    setLoading(true);
    setLoadError('');
    try {
      const data = await apiGet<{ results: ExamResultRecord[] }>('results.php');
      if (requestId !== resultsRequestRef.current) return;
      if (data?.results) {
        setResults(data.results);
      }
    } catch (e) {
      if (requestId !== resultsRequestRef.current) return;
      const message = e instanceof Error ? e.message : 'Failed to load results.';
      setLoadError(message);
      console.error('Failed to load results:', e);
    } finally {
      if (requestId === resultsRequestRef.current) setLoading(false);
    }
  };

  // Reload whenever the super admin switches company (the screen is not remounted by the switch).
  // Filters pointing at the previous company's exam/student/attempt are cleared with it.
  const lastCompanyScopeRef = useRef(companyScope);
  useEffect(() => {
    if (lastCompanyScopeRef.current !== companyScope) {
      lastCompanyScopeRef.current = companyScope;
      setResults([]);
      setSelectedExamId('ALL');
      setSelectedStudentId('ALL');
      setSelectedSessionId(null);
    }
    loadResults();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyScope]);

  const loadEnterpriseReport = async (fromDate = reportFromDate, toDate = reportToDate) => {
    const requestId = ++reportRequestRef.current;
    setReportLoading(true);
    try {
      const params = new URLSearchParams();
      if (fromDate) params.set('from', fromDate);
      if (toDate) params.set('to', toDate);
      const query = params.toString();
      const data = await apiGet<EnterpriseReport>(`reports.php${query ? `?${query}` : ''}`);
      if (requestId !== reportRequestRef.current) return;
      setReport(data || null);
    } catch (e) {
      if (requestId !== reportRequestRef.current) return;
      console.error('Failed to load enterprise report:', e);
      setReport(null);
    } finally {
      if (requestId === reportRequestRef.current) setReportLoading(false);
    }
  };

  useEffect(() => {
    loadEnterpriseReport();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyScope]);

  const handleApplyReportDateFilter = () => {
    loadEnterpriseReport(reportFromDate, reportToDate);
  };

  const handleClearReportDateFilter = () => {
    setReportFromDate('');
    setReportToDate('');
    loadEnterpriseReport('', '');
  };

  // Close the reports menu when clicking outside it or pressing Escape.
  useEffect(() => {
    if (!reportsMenuOpen) return;
    const onPointer = (e: MouseEvent) => {
      if (reportsMenuRef.current && !reportsMenuRef.current.contains(e.target as Node)) {
        setReportsMenuOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setReportsMenuOpen(false); };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [reportsMenuOpen]);

  useEffect(() => {
    let cancelled = false;
    const loadFeedback = async () => {
      try {
        const data = await apiGet<{ feedback: Array<SessionFeedback & {
          examTitle?: string;
          studentName?: string;
          registrationId?: string;
          batch?: string | null;
        }> }>('feedback.php?limit=250');
        if (!cancelled) setFeedback(data?.feedback || []);
      } catch (e) {
        console.error('Failed to load feedback:', e);
        if (!cancelled) setFeedback([]);
      }
    };
    loadFeedback();
    return () => { cancelled = true; };
  }, [companyScope]);

  useEffect(() => {
    // Switching exams quickly must not let the previous exam's (slower) analytics overwrite these.
    let cancelled = false;
    const loadAnalytics = async () => {
      if (selectedExamId === 'ALL') {
        setAnalytics([]);
        setAnalyticsLoading(false);
        return;
      }
      setAnalyticsLoading(true);
      try {
        const data = await apiGet<{ questions: QuestionAnalytics[] }>(`analytics.php?examId=${encodeURIComponent(selectedExamId)}`);
        if (!cancelled) setAnalytics(data?.questions || []);
      } catch (e) {
        console.error('Failed to load analytics:', e);
        if (!cancelled) setAnalytics([]);
      } finally {
        if (!cancelled) setAnalyticsLoading(false);
      }
    };
    loadAnalytics();
    return () => { cancelled = true; };
  }, [selectedExamId]);

  // Load the plain-language "why no attempt" reasons (from access logs) for the selected exam.
  useEffect(() => {
    if (selectedExamId === 'ALL') {
      setAttemptReasons({});
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const data = await apiGet<{ statuses: Array<{ studentId: string; reason: string; lastActivity: number | null }> }>(
          `attempt_status.php?examId=${encodeURIComponent(selectedExamId)}`
        );
        if (cancelled) return;
        const map: Record<string, { reason: string; lastActivity: number | null }> = {};
        (data?.statuses || []).forEach(s => { map[s.studentId] = { reason: s.reason, lastActivity: s.lastActivity }; });
        setAttemptReasons(map);
      } catch (e) {
        if (!cancelled) setAttemptReasons({});
        console.error('Failed to load attempt reasons:', e);
      }
    })();
    return () => { cancelled = true; };
  }, [selectedExamId]);

  const filteredResults = useMemo(() => {
    const term = search.trim().toLowerCase();
    return results
      .filter(r => (selectedExamId === 'ALL' ? true : r.examId === selectedExamId))
      .filter(r => (selectedStudentId === 'ALL' ? true : r.studentId === selectedStudentId))
      .filter(r => (statusFilter === 'ALL' ? true : r.status === statusFilter))
      .filter(r => {
        if (!term) return true;
        const student = students.find(s => s.id === r.studentId);
        const exam = exams.find(e => e.id === r.examId);
        return (
          (student?.fullName || '').toLowerCase().includes(term) ||
          (exam?.title || '').toLowerCase().includes(term) ||
          r.studentId.toLowerCase().includes(term) ||
          r.examId.toLowerCase().includes(term)
        );
      })
      .sort((a, b) => b.startTime - a.startTime);
  }, [results, selectedExamId, selectedStudentId, statusFilter, search, students, exams]);

  // The attempt list, the per-question analytics table and the not-attempted roster all grow with the
  // cohort, so each pages on its own.
  const resultPaging = usePagination(filteredResults, `${selectedExamId}|${selectedStudentId}|${statusFilter}|${search}`);
  const analyticsPaging = usePagination(analytics, selectedExamId);

  const selectedResult = useMemo(() => {
    if (selectedSessionId) {
      return filteredResults.find(r => r.sessionId === selectedSessionId) || null;
    }
    return filteredResults[0] || null;
  }, [filteredResults, selectedSessionId]);

  // Clicking through attempts quickly must not show one attempt's regrade history under another.
  const auditRequestRef = useRef(0);
  const loadAudit = async (sessionId: number) => {
    const requestId = ++auditRequestRef.current;
    setAuditLoading(true);
    try {
      const data = await apiGet<{ audits: ResultAuditLog[] }>(`results.php?audit=1&sessionId=${sessionId}`);
      if (requestId !== auditRequestRef.current) return;
      if (data?.audits) {
        setAuditLogs(data.audits);
      } else {
        setAuditLogs([]);
      }
    } catch (e) {
      if (requestId !== auditRequestRef.current) return;
      console.error('Failed to load audit logs:', e);
      setAuditLogs([]);
    } finally {
      if (requestId === auditRequestRef.current) setAuditLoading(false);
    }
  };

  const buildDraftMarks = (result: ExamResultRecord | null) => {
    if (!result) return {};
    const draft: Record<string, string> = {};
    result.answers.forEach(a => {
      draft[a.questionId] = a.awardedMarks !== null && a.awardedMarks !== undefined ? String(a.awardedMarks) : '';
    });
    return draft;
  };

  useEffect(() => {
    if (!selectedResult) {
      setAuditLogs([]);
      setEditMode(false);
      setDraftMarks({});
      return;
    }
    setEditMode(false);
    setGradeNote('');
    setDraftMarks(buildDraftMarks(selectedResult));
    loadAudit(selectedResult.sessionId);
  }, [selectedResult]);

  const summary = useMemo(() => {
    const attempts = filteredResults.length;
    const finals = filteredResults.filter(
      r => r.finalMaxScore !== null && r.finalMaxScore !== undefined
    );

    // const finalGroups = new Map<string, ExamResultRecord>();
    // filteredResults.forEach(r => {
    //   const key = `${r.examId}|${r.studentId}`;
    //   if (!finalGroups.has(key)) finalGroups.set(key, r);
    // });

    // const finals = Array.from(finalGroups.values());
    const scoredFinals = finals.filter(r => (r.finalMaxScore || 0) > 0);
    const totalFinalScore = scoredFinals.reduce((sum, r) => sum + (r.finalScore || 0), 0);
    const totalFinalMax = scoredFinals.reduce((sum, r) => sum + (r.finalMaxScore || 0), 0);
    const avgPercent = totalFinalMax > 0 ? Math.round((totalFinalScore / totalFinalMax) * 100) : 0;
    const completed = finals.filter(r => r.finalPercent !== null && r.finalPercent !== undefined).length;
    const passed = finals.filter(r => r.finalPassed).length;
    // Pass rate is over attempts that have a verdict. Attempts still awaiting manual grading have no
    // pass/fail yet and must not count as failures (this matches the Exam Report PDF).
    const graded = finals.filter(r => r.finalPassed !== null && r.finalPassed !== undefined).length;
    const passRate = graded > 0 ? Math.round((passed / graded) * 100) : 0;

    // Top performer = best PERCENTAGE (raw marks aren't comparable across exams with different
    // totals), ties broken by raw score. Terminated attempts are recorded as fails, never as the top.
    const pct = (r: ExamResultRecord) => (r.finalScore || 0) / (r.finalMaxScore || 1);
    let topResult: ExamResultRecord | null = null;
    for (const r of scoredFinals) {
      if (r.status === 'TERMINATED') continue;
      if (
        !topResult ||
        pct(r) > pct(topResult) ||
        (pct(r) === pct(topResult) && (r.finalScore || 0) > (topResult.finalScore || 0))
      ) {
        topResult = r;
      }
    }

    const completedCount = filteredResults.filter(r => r.status === 'COMPLETED').length;
    const terminatedCount = filteredResults.filter(r => r.status === 'TERMINATED').length;
    const violations = filteredResults.reduce((sum, r) => sum + (r.violationCount || 0), 0);
    const pendingGrade = filteredResults.filter(
      r => r.status === 'COMPLETED' && (r.finalPassed === null || r.finalPassed === undefined)
    ).length;

    return { attempts, avgPercent, passRate, completed, topResult, completedCount, terminatedCount, violations, passed, pendingGrade };
  }, [filteredResults]);

  // Students who were assigned the selected exam (directly or via batch) but have no attempt on record.
  const notAttempted = useMemo(() => {
    if (selectedExamId === 'ALL') return null;
    const exam = exams.find(e => e.id === selectedExamId);
    if (!exam) return null;
    const assignedIds = new Set(exam.assignedStudentIds || []);
    const assignedBatches = new Set((exam.assignedBatchIds || []).map(Number));
    const hasAssignments = assignedIds.size > 0 || assignedBatches.size > 0;
    const eligible = students.filter(s =>
      assignedIds.has(s.id) || s.batches.some(b => assignedBatches.has(b.id))
    );
    const attempted = new Set(results.filter(r => r.examId === selectedExamId).map(r => r.studentId));
    const list = eligible
      .filter(s => !attempted.has(s.id))
      .sort((a, b) => a.fullName.localeCompare(b.fullName));
    return { eligibleCount: eligible.length, attemptedCount: eligible.length - list.length, list, hasAssignments };
  }, [selectedExamId, exams, students, results]);

  // Declared here rather than beside the other paging hooks: it reads `notAttempted`, which is only
  // defined above this line.
  const notAttemptedPaging = usePagination(notAttempted?.list ?? EMPTY_ROSTER, selectedExamId);

  // Plain-language reason a student has no attempt on record (falls back to no-show).
  const reasonFor = (studentId: string): string =>
    attemptReasons[studentId]?.reason || 'No-show — never opened the exam';

  const handleExportNotAttendedCsv = () => {
    if (!notAttempted || selectedExamId === 'ALL') return;
    const exam = exams.find(e => e.id === selectedExamId);
    const tz = resolveExamTimezone(exam?.timezone);
    const rows: string[][] = [
      ['Name', 'Registration ID', 'Email', 'Batch', 'Face ID Enrolled', 'Reason', 'Last Activity'],
      ...notAttempted.list.map(s => {
        const last = attemptReasons[s.id]?.lastActivity;
        return [
          s.fullName,
          s.registrationId,
          s.email || '',
          s.batches.map(b => b.name).join(', '),
          s.enrolled ? 'Yes' : 'No',
          reasonFor(s.id),
          last ? formatScheduleShort(last, tz) : '',
        ];
      }),
    ];
    const safeExam = (exam?.title || 'exam').replace(/[^\w\-]+/g, '_');
    const stamp = new Date().toISOString().slice(0, 10);
    downloadCsv(`not_attempted_${safeExam}_${stamp}.csv`, rows);
  };

  const formatScore = (result: ExamResultRecord) => {
    if (!result.maxScore || result.maxScore <= 0) return '-';
    return `${result.totalScore || 0} / ${result.maxScore}`;
  };

  const formatPercent = (result: ExamResultRecord) => {
    if (!result.maxScore || result.maxScore <= 0) return '-';
    return `${Math.round(((result.totalScore || 0) / result.maxScore) * 100)}%`;
  };

  const formatFinalScore = (result: ExamResultRecord) => {
    if (!result.finalMaxScore || result.finalMaxScore <= 0) return '-';
    return `${result.finalScore || 0} / ${result.finalMaxScore}`;
  };

  const formatFinalPercent = (result: ExamResultRecord) => {
    if (!result.finalMaxScore || result.finalMaxScore <= 0) return '-';
    return `${Math.round(((result.finalScore || 0) / result.finalMaxScore) * 100)}%`;
  };

  const getPassBadge = (result: ExamResultRecord) => {
    if (result.finalPassed === null || result.finalPassed === undefined) {
      return { label: 'PENDING', tone: 'bg-slate-100 text-slate-600 border-slate-200' };
    }

    return result.finalPassed
      ? { label: 'PASS', tone: 'bg-teal-100 text-teal-700 border-teal-200' }
      : { label: 'FAIL', tone: 'bg-rose-100 text-rose-700 border-rose-200' };
  };


  const formatRate = (value: number) => `${Math.round(value * 100)}%`;
  const formatSeconds = (value: number) => `${Math.round(value)}s`;

  const csvEscape = (value: string | number | null | undefined) => {
    if (value === null || value === undefined) return '';
    const str = neutraliseCsvFormula(String(value));
    if (/[",\r\n]/.test(str)) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };

  const downloadCsv = (filename: string, rows: string[][]) => {
    const csv = rows.map(r => r.map(csvEscape).join(',')).join('\n');
    // BOM so Excel opens UTF-8 (Arabic / accented names) correctly — same as ExamManager's exports.
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const escapeHtml = (value: string) => {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  };

  const renderReportRows = (rows: string[][]) => rows.map(row => `
    <tr>${row.map(cell => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>
  `).join('');

  const handleExportEnterpriseReportPdf = () => {
    if (!report) return;
    const generatedAt = new Date(report.generatedAt).toLocaleString();
    const topExamRows = report.byExam.slice(0, 12).map(item => [
      item.title,
      item.status,
      String(item.attempts),
      `${item.passRate}%`,
      `${item.avgPercent}%`,
      String(item.violations),
    ]);
    const batchRows = report.byBatch.slice(0, 16).map(item => [
      item.name,
      String(item.students),
      String(item.attempts),
      `${item.passRate}%`,
      `${item.avgPercent}%`,
      String(item.violations),
    ]);
    const studentRows = report.byStudent.slice(0, 20).map(item => [
      item.name,
      item.registrationId,
      item.batch || '-',
      String(item.attempts),
      `${item.avgPercent}%`,
      String(item.violations),
    ]);
    const violationRows = report.recentViolations.slice(0, 24).map(item => [
      new Date(item.timestamp).toLocaleString(),
      item.type.replace(/_/g, ' '),
      item.studentName,
      item.examTitle,
      item.description,
    ]);
    const feedbackRows = feedback.slice(0, 20).map(item => [
      new Date(item.createdAt).toLocaleString(),
      item.studentName || item.studentId,
      item.batch || '-',
      item.examTitle || item.examId,
      `${item.rating}/5`,
      item.comment || '',
    ]);
    const maxViolationCount = Math.max(1, ...report.violationsByType.map(v => v.count));
    const violationBars = report.violationsByType.map(item => `
      <div class="bar-row">
        <span>${escapeHtml(item.type.replace(/_/g, ' '))}</span>
        <div class="bar"><i style="width:${Math.max(4, (item.count / maxViolationCount) * 100)}%"></i></div>
        <strong>${item.count}</strong>
      </div>
    `).join('');

    const html = `
      <!doctype html>
      <html>
        <head>
          <meta charset="utf-8" />
          <title>LSC Proctor Enterprise Report</title>
          <style>
            body { font-family: Arial, sans-serif; margin: 24px; color: #101828; }
            h1 { margin: 0; font-size: 22px; }
            h2 { font-size: 14px; margin: 24px 0 10px; color: #344054; }
            .brand { display: flex; justify-content: space-between; align-items: start; border-bottom: 3px solid #1a73e8; padding-bottom: 14px; }
            .brand small { color: #667085; }
            .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin: 18px 0; }
            .metric { border: 1px solid #d8e0ef; border-radius: 8px; padding: 10px; background: #f8faff; }
            .metric span { display: block; font-size: 9px; text-transform: uppercase; color: #667085; letter-spacing: 1px; }
            .metric strong { display: block; font-size: 20px; margin-top: 4px; }
            table { width: 100%; border-collapse: collapse; font-size: 10px; page-break-inside: auto; }
            th, td { border: 1px solid #d8e0ef; padding: 6px; vertical-align: top; }
            th { background: #eef2ff; color: #344054; text-transform: uppercase; font-size: 8px; letter-spacing: .08em; }
            .bar-row { display: grid; grid-template-columns: 130px 1fr 32px; gap: 8px; align-items: center; font-size: 10px; margin: 7px 0; }
            .bar { height: 8px; border-radius: 999px; background: #edf1f8; overflow: hidden; }
            .bar i { display: block; height: 100%; border-radius: inherit; background: #1a73e8; }
            .risk-high { color: #b42318; font-weight: 700; }
            @media print { body { margin: 14mm; } }
          </style>
        </head>
        <body>
          <div class="brand">
            <div>
              <h1>LSC Proctor Enterprise Report</h1>
              <small>Generated ${escapeHtml(generatedAt)}</small>
            </div>
            <strong>LSC</strong>
          </div>
          <div class="grid">
            <div class="metric"><span>Exams</span><strong>${report.summary.exams}</strong></div>
            <div class="metric"><span>Students</span><strong>${report.summary.students}</strong></div>
            <div class="metric"><span>Pass Rate</span><strong>${report.summary.passRate}%</strong></div>
            <div class="metric"><span>Violations</span><strong class="${report.summary.violations > 0 ? 'risk-high' : ''}">${report.summary.violations}</strong></div>
            <div class="metric"><span>Sessions</span><strong>${report.summary.sessions}</strong></div>
            <div class="metric"><span>Completed</span><strong>${report.summary.completed}</strong></div>
            <div class="metric"><span>Terminated</span><strong>${report.summary.terminated}</strong></div>
            <div class="metric"><span>Average Score</span><strong>${report.summary.avgPercent}%</strong></div>
          </div>
          <h2>Violation Distribution</h2>
          ${violationBars || '<p>No violations recorded.</p>'}
          <h2>Exam-wise Report</h2>
          <table><thead><tr><th>Exam</th><th>Status</th><th>Attempts</th><th>Pass Rate</th><th>Avg Score</th><th>Violations</th></tr></thead><tbody>${renderReportRows(topExamRows)}</tbody></table>
          <h2>Batch-wise Report</h2>
          <table><thead><tr><th>Batch</th><th>Students</th><th>Attempts</th><th>Pass Rate</th><th>Avg Score</th><th>Violations</th></tr></thead><tbody>${renderReportRows(batchRows)}</tbody></table>
          <h2>Student-wise Risk Snapshot</h2>
          <table><thead><tr><th>Student</th><th>Registration</th><th>Batch</th><th>Attempts</th><th>Avg Score</th><th>Violations</th></tr></thead><tbody>${renderReportRows(studentRows)}</tbody></table>
          <h2>Recent Violation Log</h2>
          <table><thead><tr><th>Time</th><th>Type</th><th>Student</th><th>Exam</th><th>Description</th></tr></thead><tbody>${renderReportRows(violationRows)}</tbody></table>
          <h2>Student Feedback</h2>
          <table><thead><tr><th>Time</th><th>Student</th><th>Batch</th><th>Exam</th><th>Rating</th><th>Comment</th></tr></thead><tbody>${renderReportRows(feedbackRows)}</tbody></table>
        </body>
      </html>
    `;

    // Shared opener (defined below; runs at click time): tells the admin to allow pop-ups instead of
    // silently doing nothing when the browser blocks the report window.
    openPrintWindow(html);
  };

  // ---- Detailed student reports (dossier + roster) ----

  type DossierViolation = {
    id: number | string;
    sessionId?: number | null;
    examId?: string;
    studentId?: string;
    timestamp: number;
    type: string;
    category?: string | null;
    confidence?: number | null;
    description?: string;
    snapshot?: string | null;
    metadata?: Record<string, any> | null;
    /** Set once grouped: how long the incident lasted and how many raw events it produced. */
    episodeCount?: number;
    episodeMs?: number;
  };

  // The dossier is evidence that goes to a candidate or a client, so it must report INCIDENTS, not
  // detector pings: a 19-minute webcam failure belongs in the report once, with its duration — not
  // as 112 identical "No face detected" lines that drown out the events that matter.
  const asIncidents = (raw: DossierViolation[]): DossierViolation[] =>
    groupViolationEpisodes(raw).map(ep => ({
      ...ep.first,
      description: ep.description || ep.first.description,
      snapshot: ep.snapshot ?? ep.first.snapshot,
      episodeCount: ep.count,
      episodeMs: ep.durationMs,
    }));

  // Severity weights for an at-a-glance integrity score (100 = clean).
  const VIOLATION_WEIGHTS: Record<string, number> = {
    IDENTITY_CHANGE: 16,
    PHONE_DETECTED: 14,
    MULTIPLE_FACES: 12,
    ANOMALY_OBJECT: 8,
    FULLSCREEN_EXIT: 6,
    TAB_SWITCH: 6,
    COPY_PASTE: 6,
    NO_FACE: 5,
    LOCATION_CHANGE: 5,
    AUDIO_DETECTED: 3,
    GAZE_AWAY: 2,
    SUSPICIOUS_BEHAVIOR: 10, // AI-confirmed behaviour pattern — stronger than any single glance
  };

  const computeIntegrityScore = (vios: Array<{ type: string }>): number => {
    let score = 100;
    vios.forEach(v => { score -= (VIOLATION_WEIGHTS[v.type] ?? 4); });
    return Math.max(0, Math.min(100, Math.round(score)));
  };

  const resultPercentValue = (r: ExamResultRecord): number | null => {
    if (r.finalMaxScore && r.finalMaxScore > 0) return Math.round(((r.finalScore || 0) / r.finalMaxScore) * 100);
    if (r.maxScore && r.maxScore > 0) return Math.round(((r.totalScore || 0) / r.maxScore) * 100);
    return null;
  };

  const integrityTone = (score: number): string =>
    score >= 80 ? '#067647' : score >= 55 ? '#b54708' : '#b42318';

  const openPrintWindow = (html: string) => {
    const win = window.open('', '_blank');
    if (!win) {
      alert('The report could not open. Please allow pop-ups for this site and try again.');
      return;
    }
    win.document.open();
    win.document.write(html);
    win.document.close();
    win.focus();
    win.print();
  };

  const DOSSIER_STYLE = `
    body { font-family: Arial, sans-serif; margin: 24px; color: #101828; }
    h1 { margin: 0; font-size: 22px; }
    h2 { font-size: 14px; margin: 22px 0 10px; color: #344054; }
    .brand { display: flex; justify-content: space-between; align-items: start; border-bottom: 3px solid #1a73e8; padding-bottom: 14px; }
    .sub { color: #667085; font-size: 12px; margin-top: 4px; }
    .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin: 18px 0; }
    .metric { border: 1px solid #d8e0ef; border-radius: 8px; padding: 10px; background: #f8faff; }
    .metric span { display: block; font-size: 9px; text-transform: uppercase; color: #667085; letter-spacing: 1px; }
    .metric strong { display: block; font-size: 20px; margin-top: 4px; }
    table { width: 100%; border-collapse: collapse; font-size: 10px; page-break-inside: auto; }
    th, td { border: 1px solid #d8e0ef; padding: 6px; vertical-align: top; }
    th { background: #eef2ff; color: #344054; text-transform: uppercase; font-size: 8px; letter-spacing: .08em; }
    .bar-row { display: grid; grid-template-columns: 150px 1fr 32px; gap: 8px; align-items: center; font-size: 10px; margin: 7px 0; }
    .bar { height: 8px; border-radius: 999px; background: #edf1f8; overflow: hidden; }
    .bar i { display: block; height: 100%; background: #1a73e8; }
    .snap { width: 96px; height: 72px; object-fit: cover; border-radius: 4px; border: 1px solid #d8e0ef; }
    .muted { color: #98a2b3; }
    .risk { color: #b42318; font-weight: 700; }
    .pill { display: inline-block; padding: 3px 10px; border-radius: 999px; font-weight: 700; color: #fff; }
    .dossier { page-break-after: always; }
    .dossier:last-child { page-break-after: auto; }
    @media print { body { margin: 12mm; } tr { page-break-inside: avoid; } }
  `;

  const wrapPrintDocument = (title: string, body: string): string => `
    <!doctype html>
    <html>
      <head><meta charset="utf-8" /><title>${escapeHtml(title)}</title><style>${DOSSIER_STYLE}</style></head>
      <body>${body}</body>
    </html>`;

  const fetchStudentViolations = async (studentId: string): Promise<DossierViolation[]> => {
    try {
      const data = await apiGet<{ violations: DossierViolation[] }>(
        `violations.php?studentId=${encodeURIComponent(studentId)}&limit=2000`
      );
      return asIncidents(Array.isArray(data?.violations) ? data.violations : []);
    } catch {
      return [];
    }
  };

  const fetchAllViolations = async (): Promise<DossierViolation[]> => {
    try {
      const data = await apiGet<{ violations: DossierViolation[] }>('violations.php?limit=2000');
      return asIncidents(Array.isArray(data?.violations) ? data.violations : []);
    } catch {
      return [];
    }
  };

  // Builds one student's <div class="dossier"> body — reused by single and batch exports.
  const buildDossierSection = (targetId: string, viosInput: DossierViolation[], timelineCap: number): string => {
    const student = students.find(s => s.id === targetId);
    const vios = [...viosInput].sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    const studentResults = results
      .filter(r => r.studentId === targetId)
      .sort((a, b) => (a.startTime || 0) - (b.startTime || 0));

    const percents = studentResults.map(resultPercentValue).filter((x): x is number => x !== null);
    const avgPercent = percents.length ? Math.round(percents.reduce((a, b) => a + b, 0) / percents.length) : null;
    const passedCount = studentResults.filter(r => r.finalPassed).length;
    const terminatedCount = studentResults.filter(r => r.status === 'TERMINATED').length;
    const integrity = computeIntegrityScore(vios);

    const typeCounts = new Map<string, number>();
    vios.forEach(v => typeCounts.set(v.type, (typeCounts.get(v.type) || 0) + 1));
    const distRows = Array.from(typeCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([type, count]) => `
        <div class="bar-row">
          <span>${escapeHtml(type.replace(/_/g, ' '))}</span>
          <div class="bar"><i style="width:${Math.max(6, (count / Math.max(1, vios.length)) * 100)}%"></i></div>
          <strong>${count}</strong>
        </div>`).join('');

    const attemptRows = studentResults.map(r => {
      const exam = exams.find(e => e.id === r.examId);
      return `
        <tr>
          <td>${escapeHtml(exam?.title || r.examId)}</td>
          <td>${r.attemptIndex || 1}${r.attemptCount ? `/${r.attemptCount}` : ''}</td>
          <td>${escapeHtml(r.status)}</td>
          <td>${escapeHtml(formatFinalScore(r))}</td>
          <td>${escapeHtml(formatFinalPercent(r))}</td>
          <td>${r.finalPassed === null || r.finalPassed === undefined ? '-' : (r.finalPassed ? 'PASS' : 'FAIL')}</td>
          <td>${escapeHtml(formatScheduleShort(r.startTime, resolveExamTimezone(exam?.timezone)))}</td>
        </tr>`;
    }).join('');

    const timelineRows = vios.slice(0, timelineCap).map(v => {
      const exam = exams.find(e => e.id === v.examId);
      const conf = v.confidence !== null && v.confidence !== undefined ? `${Math.round(Number(v.confidence) * 100)}%` : '-';
      const img = v.snapshot
        ? `<img class="snap" src="${escapeHtml(String(v.snapshot))}" alt="snapshot" />`
        : '<span class="muted">—</span>';
      // A sustained incident is reported once, with how long it went on for.
      const span = (v.episodeCount ?? 1) > 1 && (v.episodeMs ?? 0) >= 1000
        ? ` <span class="muted">(continuous ${escapeHtml(formatEpisodeDuration(v.episodeMs || 0))}, ${v.episodeCount}×)</span>`
        : '';
      return `
        <tr>
          <td>${escapeHtml(new Date(v.timestamp).toLocaleString())}</td>
          <td>${escapeHtml(v.type.replace(/_/g, ' '))}${span}</td>
          <td>${escapeHtml(exam?.title || v.examId || '-')}</td>
          <td>${conf}</td>
          <td>${escapeHtml(v.description || '')}</td>
          <td>${img}</td>
        </tr>`;
    }).join('');

    const enrolledLabel = student?.enrolled
      ? `Enrolled${student?.enrolledAt ? ` (${escapeHtml(String(student.enrolledAt))})` : ''}`
      : 'Not enrolled';

    return `
      <div class="dossier">
        <div class="brand">
          <div>
            <h1>Student Proctoring Dossier</h1>
            <div class="sub">${escapeHtml(student?.fullName || targetId)} &middot; ${escapeHtml(student?.registrationId || '')} &middot; ${escapeHtml(student?.email || '')}</div>
            <div class="sub">Batch: ${escapeHtml(student?.batches?.map(b => b.name).join(', ') || '-')} &middot; Face ID: ${enrolledLabel} &middot; Generated ${escapeHtml(new Date().toLocaleString())}</div>
          </div>
          <strong>LSC</strong>
        </div>
        <div class="grid">
          <div class="metric"><span>Exams Attempted</span><strong>${studentResults.length}</strong></div>
          <div class="metric"><span>Passed</span><strong>${passedCount}/${studentResults.length}</strong></div>
          <div class="metric"><span>Average Score</span><strong>${avgPercent === null ? '-' : `${avgPercent}%`}</strong></div>
          <div class="metric"><span>Terminated</span><strong>${terminatedCount}</strong></div>
          <div class="metric"><span>Total Violations</span><strong>${vios.length}</strong></div>
          <div class="metric"><span>Integrity Score</span><strong><span class="pill" style="background:${integrityTone(integrity)}">${integrity}/100</span></strong></div>
        </div>
        <h2>Exam Attempts</h2>
        <table><thead><tr><th>Exam</th><th>Attempt</th><th>Status</th><th>Score</th><th>Percent</th><th>Result</th><th>Started</th></tr></thead>
          <tbody>${attemptRows || '<tr><td colspan="7">No attempts recorded.</td></tr>'}</tbody></table>
        <h2>Violation Distribution</h2>
        ${distRows || '<p class="muted">No violations recorded for this student.</p>'}
        <h2>Integrity Timeline ${vios.length > timelineCap ? `(latest ${timelineCap} of ${vios.length})` : ''}</h2>
        <table><thead><tr><th>Time</th><th>Type</th><th>Exam</th><th>Confidence</th><th>Description</th><th>Snapshot</th></tr></thead>
          <tbody>${timelineRows || '<tr><td colspan="6">No violations recorded.</td></tr>'}</tbody></table>
      </div>`;
  };

  const handleExportStudentDossier = async (studentIdArg?: string) => {
    setReportsMenuOpen(false);
    const targetId = studentIdArg || (selectedStudentId !== 'ALL' ? selectedStudentId : '');
    if (!targetId) {
      alert('Select a specific student in the Student filter to generate a dossier.');
      return;
    }
    const student = students.find(s => s.id === targetId);
    setDossierBusy(true);
    try {
      const vios = await fetchStudentViolations(targetId);
      const section = buildDossierSection(targetId, vios, 150);
      openPrintWindow(wrapPrintDocument(`Student Dossier - ${student?.fullName || targetId}`, section));
    } finally {
      setDossierBusy(false);
    }
  };

  // Certification is on-demand only — this is the one place that ever calls ISSUE_NOW. The
  // button that triggers it is only rendered when the exam's certificateEnabled toggle is on and
  // the result has finally passed (see the render below); the server re-checks both anyway.
  const handleIssueCertificate = async (sessionId: number) => {
    setCertBusy(true);
    try {
      const res = await apiPost<{ ok: boolean; status: string }>('certificates.php', { action: 'ISSUE_NOW', sessionId });
      setCertStatus(prev => ({ ...prev, [sessionId]: res?.status || 'ISSUED' }));
    } catch (e: any) {
      alert(e?.message || 'Could not issue certificate.');
    } finally {
      setCertBusy(false);
    }
  };

  const handleExportBatchDossiers = async () => {
    setReportsMenuOpen(false);
    // Target the students currently in view (respects the exam / status / search filters).
    const targetIds = Array.from(new Set<string>(filteredResults.map(r => r.studentId)));
    if (targetIds.length === 0) {
      alert('No students match the current filters. Adjust the filters and try again.');
      return;
    }
    if (targetIds.length > 60 && !confirm(`Build dossiers for ${targetIds.length} students in one document? This may be large.`)) {
      return;
    }
    setBatchBusy(true);
    try {
      const allVios = await fetchAllViolations();
      const byStudent = new Map<string, DossierViolation[]>();
      allVios.forEach(v => {
        if (!v.studentId) return;
        const list = byStudent.get(v.studentId) || [];
        list.push(v);
        byStudent.set(v.studentId, list);
      });
      // Cap each student's timeline in a combined document to keep the output manageable.
      const sections = targetIds.map(id => buildDossierSection(id, byStudent.get(id) || [], 24)).join('');
      openPrintWindow(wrapPrintDocument(`Batch Dossiers (${targetIds.length} students)`, sections));
    } finally {
      setBatchBusy(false);
    }
  };

  const fetchExamViolations = async (examId: string): Promise<DossierViolation[]> => {
    try {
      const data = await apiGet<{ violations: DossierViolation[] }>(
        `violations.php?examId=${encodeURIComponent(examId)}&limit=2000`
      );
      // Incidents, not raw detector pings — same as the dossier and the Results list's violation
      // counts, so the Exam Report / ZIP don't report one 19-minute webcam failure as 112 violations.
      return asIncidents(Array.isArray(data?.violations) ? data.violations : []);
    } catch {
      return [];
    }
  };

  // Comprehensive single-exam report: results, analytics, violations and feedback for ONE exam.
  // This is the "everything about this exam" PDF the team asked for.
  const handleExportExamReport = async () => {
    setReportsMenuOpen(false);
    if (selectedExamId === 'ALL') {
      alert('Select a specific exam in the Exam filter to generate its report.');
      return;
    }
    const exam = exams.find(e => e.id === selectedExamId);
    setExamReportBusy(true);
    try {
      const [vios, freshAnalytics] = await Promise.all([
        fetchExamViolations(selectedExamId),
        analytics.length > 0
          ? Promise.resolve(analytics)
          : apiGet<{ questions: QuestionAnalytics[] }>(`analytics.php?examId=${encodeURIComponent(selectedExamId)}`)
              .then(d => d?.questions || []).catch(() => [] as QuestionAnalytics[]),
      ]);

      const examResults = results
        .filter(r => r.examId === selectedExamId)
        .sort((a, b) => (b.startTime || 0) - (a.startTime || 0));
      const examFeedback = feedback.filter(f => f.examId === selectedExamId);

      // ---- Summary metrics ----
      const attempts = examResults.length;
      const completed = examResults.filter(r => r.status === 'COMPLETED').length;
      const terminated = examResults.filter(r => r.status === 'TERMINATED').length;
      const passed = examResults.filter(r => r.finalPassed).length;
      const graded = examResults.filter(r => r.finalPassed !== null && r.finalPassed !== undefined).length;
      const passRate = graded > 0 ? Math.round((passed / graded) * 100) : 0;
      const percents = examResults.map(resultPercentValue).filter((x): x is number => x !== null);
      const avgPercent = percents.length ? Math.round(percents.reduce((a, b) => a + b, 0) / percents.length) : 0;
      const ratings = examFeedback.map(f => Number(f.rating)).filter(n => Number.isFinite(n) && n > 0);
      const avgRating = ratings.length ? (ratings.reduce((a, b) => a + b, 0) / ratings.length).toFixed(1) : '-';

      // ---- Per-student violations grouped (count + types for an accurate integrity score) ----
      const vioByStudent = new Map<string, number>();
      const vioTypesByStudent = new Map<string, Array<{ type: string }>>();
      vios.forEach(v => {
        if (!v.studentId) return;
        vioByStudent.set(v.studentId, (vioByStudent.get(v.studentId) || 0) + 1);
        const list = vioTypesByStudent.get(v.studentId) || [];
        list.push({ type: v.type });
        vioTypesByStudent.set(v.studentId, list);
      });

      // ---- Violation distribution ----
      const typeCounts = new Map<string, number>();
      vios.forEach(v => typeCounts.set(v.type, (typeCounts.get(v.type) || 0) + 1));
      const distRows = Array.from(typeCounts.entries()).sort((a, b) => b[1] - a[1]).map(([type, count]) => `
        <div class="bar-row">
          <span>${escapeHtml(type.replace(/_/g, ' '))}</span>
          <div class="bar"><i style="width:${Math.max(6, (count / Math.max(1, vios.length)) * 100)}%"></i></div>
          <strong>${count}</strong>
        </div>`).join('');

      // ---- Results table ----
      const resultRows = examResults.map(r => {
        const student = students.find(s => s.id === r.studentId);
        const vio = vioByStudent.get(r.studentId) || 0;
        const integrity = computeIntegrityScore(vioTypesByStudent.get(r.studentId) || []);
        return `
          <tr>
            <td>${escapeHtml(student?.fullName || r.studentId)}</td>
            <td>${escapeHtml(student?.registrationId || '')}</td>
            <td>${escapeHtml(student?.batches?.map(b => b.name).join(', ') || '-')}</td>
            <td>${escapeHtml(r.status)}</td>
            <td>${escapeHtml(formatFinalScore(r))}</td>
            <td>${escapeHtml(formatFinalPercent(r))}</td>
            <td>${r.finalPassed === null || r.finalPassed === undefined ? '-' : (r.finalPassed ? 'PASS' : 'FAIL')}</td>
            <td style="text-align:center" class="${vio > 0 ? 'risk' : ''}">${vio}</td>
            <td style="text-align:center">${integrity}</td>
          </tr>`;
      }).join('');

      // ---- Question analytics table ----
      const analyticsRows = freshAnalytics.map((q, idx) => `
        <tr>
          <td>${idx + 1}</td>
          <td>${escapeHtml(q.questionText)}</td>
          <td>${escapeHtml(q.questionType)}</td>
          <td style="text-align:center">${q.attempts}</td>
          <td style="text-align:center">${formatRate(q.correctRate)}</td>
          <td style="text-align:center">${formatRate(q.difficulty)}</td>
          <td style="text-align:center">${formatSeconds(q.avgTimeSec)}</td>
        </tr>`).join('');

      // ---- Recent violation log (with snapshots) ----
      const violationRows = [...vios].sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0)).slice(0, 60).map(v => {
        const student = students.find(s => s.id === v.studentId);
        const conf = v.confidence !== null && v.confidence !== undefined ? `${Math.round(Number(v.confidence) * 100)}%` : '-';
        const img = v.snapshot ? `<img class="snap" src="${escapeHtml(String(v.snapshot))}" alt="snapshot" />` : '<span class="muted">—</span>';
        const span = (v.episodeCount ?? 1) > 1 && (v.episodeMs ?? 0) >= 1000
          ? ` <span class="muted">(continuous ${escapeHtml(formatEpisodeDuration(v.episodeMs || 0))}, ${v.episodeCount}×)</span>`
          : '';
        return `
          <tr>
            <td>${escapeHtml(new Date(v.timestamp).toLocaleString())}</td>
            <td>${escapeHtml(student?.fullName || v.studentId || '-')}</td>
            <td>${escapeHtml(v.type.replace(/_/g, ' '))}${span}</td>
            <td>${conf}</td>
            <td>${escapeHtml(v.description || '')}</td>
            <td>${img}</td>
          </tr>`;
      }).join('');

      // ---- Feedback table ----
      const feedbackRows = examFeedback.map(f => {
        const student = students.find(s => s.id === f.studentId);
        return `
          <tr>
            <td>${escapeHtml(new Date(f.createdAt).toLocaleString())}</td>
            <td>${escapeHtml(student?.fullName || f.studentId)}</td>
            <td style="text-align:center">${f.rating}/5</td>
            <td style="text-align:center">${f.clarityRating ?? '-'}${f.clarityRating ? '/5' : ''}</td>
            <td style="text-align:center">${f.platformRating ?? '-'}${f.platformRating ? '/5' : ''}</td>
            <td>${escapeHtml(f.comment || '')}</td>
          </tr>`;
      }).join('');

      const body = `
        <div class="brand">
          <div>
            <h1>Exam Report</h1>
            <div class="sub">${escapeHtml(exam?.title || selectedExamId)} &middot; ${escapeHtml(exam?.status || '')} &middot; Generated ${escapeHtml(new Date().toLocaleString())}</div>
          </div>
          <strong>LSC</strong>
        </div>
        <div class="grid">
          <div class="metric"><span>Attempts</span><strong>${attempts}</strong></div>
          <div class="metric"><span>Completed</span><strong>${completed}</strong></div>
          <div class="metric"><span>Terminated</span><strong class="${terminated > 0 ? 'risk' : ''}">${terminated}</strong></div>
          <div class="metric"><span>Pass Rate</span><strong>${passRate}%</strong></div>
          <div class="metric"><span>Average Score</span><strong>${avgPercent}%</strong></div>
          <div class="metric"><span>Total Violations</span><strong class="${vios.length > 0 ? 'risk' : ''}">${vios.length}</strong></div>
          <div class="metric"><span>Feedback</span><strong>${examFeedback.length}</strong></div>
          <div class="metric"><span>Avg Rating</span><strong>${avgRating === '-' ? '-' : `${avgRating}/5`}</strong></div>
        </div>

        <h2>Student Results</h2>
        <table>
          <thead><tr><th>Student</th><th>Registration</th><th>Batch</th><th>Status</th><th>Score</th><th>Percent</th><th>Result</th><th>Violations</th><th>Integrity</th></tr></thead>
          <tbody>${resultRows || '<tr><td colspan="9">No attempts recorded for this exam.</td></tr>'}</tbody>
        </table>

        <h2>Question Analytics</h2>
        <table>
          <thead><tr><th>#</th><th>Question</th><th>Type</th><th>Attempts</th><th>Correct Rate</th><th>Difficulty</th><th>Avg Time</th></tr></thead>
          <tbody>${analyticsRows || '<tr><td colspan="7" class="muted">No analytics available.</td></tr>'}</tbody>
        </table>

        <h2>Violation Distribution</h2>
        ${distRows || '<p class="muted">No violations recorded for this exam.</p>'}

        <h2>Violation Log ${vios.length > 60 ? '(latest 60)' : ''}</h2>
        <table>
          <thead><tr><th>Time</th><th>Student</th><th>Type</th><th>Confidence</th><th>Description</th><th>Snapshot</th></tr></thead>
          <tbody>${violationRows || '<tr><td colspan="6" class="muted">No violations recorded.</td></tr>'}</tbody>
        </table>

        <h2>Student Feedback</h2>
        <table>
          <thead><tr><th>Time</th><th>Student</th><th>Overall</th><th>Clarity</th><th>Platform</th><th>Comment</th></tr></thead>
          <tbody>${feedbackRows || '<tr><td colspan="6" class="muted">No feedback submitted.</td></tr>'}</tbody>
        </table>`;

      openPrintWindow(wrapPrintDocument(`Exam Report - ${exam?.title || selectedExamId}`, body));
    } finally {
      setExamReportBusy(false);
    }
  };

  // ---- Per-student detailed PDF for the selected exam, bundled into one ZIP ----

  const PDF_PRIMARY: [number, number, number] = [26, 115, 232];
  const PDF_INK: [number, number, number] = [16, 24, 40];
  const PDF_MUTED: [number, number, number] = [102, 112, 133];

  const answerDisplay = (a: ExamResultRecord['answers'][number]) => formatResultAnswer(a);

  // Builds one student's detailed exam report onto a jsPDF document.
  const buildStudentExamPdf = (
    doc: any,
    autoTable: any,
    studentId: string,
    exam: Exam | undefined,
    vios: DossierViolation[],
    tz: string,
  ) => {
    const student = students.find(s => s.id === studentId);
    const studentResults = results
      .filter(r => r.examId === exam?.id && r.studentId === studentId)
      .sort((a, b) => (a.startTime || 0) - (b.startTime || 0));
    const sortedVios = [...vios].sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

    const pageW = doc.internal.pageSize.getWidth();
    const pageH = doc.internal.pageSize.getHeight();
    const margin = 40;

    // ---- Header ----
    doc.setFillColor(...PDF_PRIMARY);
    doc.rect(0, 0, pageW, 6, 'F');
    doc.setTextColor(...PDF_INK);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(18);
    doc.text('Student Exam Report', margin, 34);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(13);
    doc.setTextColor(...PDF_PRIMARY);
    doc.text('LSC', pageW - margin, 30, { align: 'right' });
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    doc.setTextColor(...PDF_MUTED);
    doc.text(String(exam?.title || exam?.id || ''), margin, 50);
    doc.text(`Generated ${new Date().toLocaleString()}`, margin, 63);

    // ---- Identity + summary metrics ----
    const percents = studentResults.map(resultPercentValue).filter((x): x is number => x !== null);
    const bestPercent = percents.length ? Math.max(...percents) : null;
    const passedAny = studentResults.some(r => r.finalPassed);
    const terminated = studentResults.some(r => r.status === 'TERMINATED');
    const integrity = computeIntegrityScore(sortedVios.map(v => ({ type: v.type })));
    const overall = studentResults.length === 0
      ? 'NOT ATTEMPTED'
      : terminated ? 'TERMINATED' : (passedAny ? 'PASS' : (studentResults.some(r => r.finalPassed === false) ? 'FAIL' : 'PENDING'));

    autoTable(doc, {
      startY: 78,
      theme: 'plain',
      styles: { fontSize: 9, cellPadding: 3, textColor: PDF_INK },
      columnStyles: { 0: { fontStyle: 'bold', textColor: PDF_MUTED, cellWidth: 90 }, 1: { cellWidth: 170 }, 2: { fontStyle: 'bold', textColor: PDF_MUTED, cellWidth: 90 }, 3: { cellWidth: 'auto' } },
      body: [
        ['Name', student?.fullName || studentId, 'Registration', student?.registrationId || '—'],
        ['Email', student?.email || '—', 'Batch', student?.batches?.map(b => b.name).join(', ') || '—'],
        ['Face ID', student?.enrolled ? 'Enrolled' : 'Not enrolled', 'Attempts', String(studentResults.length)],
      ],
    });

    autoTable(doc, {
      startY: (doc.lastAutoTable?.finalY || 78) + 8,
      head: [['Best Score', 'Result', 'Violations', 'Integrity']],
      body: [[
        bestPercent === null ? '—' : `${bestPercent}%`,
        overall,
        String(sortedVios.length),
        `${integrity}/100`,
      ]],
      styles: { fontSize: 11, halign: 'center', cellPadding: 6, fontStyle: 'bold' },
      headStyles: { fillColor: [238, 242, 255], textColor: PDF_MUTED, fontSize: 8, halign: 'center' },
      bodyStyles: { textColor: PDF_INK },
      didParseCell: (data: any) => {
        if (data.section === 'body' && data.column.index === 1) {
          if (overall === 'PASS') data.cell.styles.textColor = [6, 118, 71];
          else if (overall === 'FAIL' || overall === 'TERMINATED') data.cell.styles.textColor = [180, 35, 24];
          else if (overall === 'NOT ATTEMPTED') data.cell.styles.textColor = [181, 71, 8];
        }
        if (data.section === 'body' && data.column.index === 3) {
          data.cell.styles.textColor = integrity >= 80 ? [6, 118, 71] : integrity >= 55 ? [181, 71, 8] : [180, 35, 24];
        }
      },
    });

    // ---- Attempts overview ----
    const attemptsY = (doc.lastAutoTable?.finalY || 120) + 20;
    doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.setTextColor(...PDF_INK);
    doc.text('Exam Attempts', margin, attemptsY);
    if (studentResults.length === 0) {
      doc.setFont('helvetica', 'normal'); doc.setFontSize(10); doc.setTextColor(181, 71, 8);
      doc.text('This student was assigned the exam but did not attempt it.', margin, attemptsY + 18);
    } else {
      autoTable(doc, {
        startY: attemptsY + 6,
        head: [['#', 'Status', 'Score', 'Percent', 'Result', 'Started']],
        body: studentResults.map(r => [
          `${r.attemptIndex || 1}${r.attemptCount ? `/${r.attemptCount}` : ''}`,
          r.status,
          formatFinalScore(r),
          formatFinalPercent(r),
          r.finalPassed === null || r.finalPassed === undefined ? '—' : (r.finalPassed ? 'PASS' : 'FAIL'),
          formatScheduleShort(r.startTime, tz),
        ]),
        styles: { fontSize: 8.5, cellPadding: 4 },
        headStyles: { fillColor: PDF_PRIMARY, textColor: [255, 255, 255], fontSize: 8 },
        alternateRowStyles: { fillColor: [248, 250, 255] },
      });
    }

    // ---- Per-attempt answer sheets ----
    studentResults.forEach(r => {
      if (!r.answers || r.answers.length === 0) return;
      doc.setFont('helvetica', 'bold'); doc.setFontSize(10.5); doc.setTextColor(...PDF_INK);
      const label = `Answer Sheet — Attempt ${r.attemptIndex || 1} (${formatFinalScore(r)}, ${formatFinalPercent(r)})`;
      let startY = (doc.lastAutoTable?.finalY || 0) + 22;
      if (startY > pageH - 80) { doc.addPage(); startY = margin; }
      doc.text(label, margin, startY);
      autoTable(doc, {
        startY: startY + 6,
        head: [['#', 'Question', 'Answer', 'Correct Answer', 'Marks', 'OK']],
        body: r.answers.map((a, idx) => {
          const { answerText, correctText } = answerDisplay(a);
          const awarded = a.awardedMarks === null || a.awardedMarks === undefined ? '—' : String(a.awardedMarks);
          const ok = a.isCorrect === null || a.isCorrect === undefined ? '—' : (a.isCorrect ? 'Yes' : 'No');
          return [String(idx + 1), a.questionText, answerText, correctText, `${awarded}/${a.marks}`, ok];
        }),
        styles: { fontSize: 8, cellPadding: 3, valign: 'top', overflow: 'linebreak' },
        headStyles: { fillColor: [238, 242, 255], textColor: PDF_MUTED, fontSize: 7.5 },
        columnStyles: {
          0: { cellWidth: 20, halign: 'center' },
          1: { cellWidth: 165 },
          2: { cellWidth: 120 },
          3: { cellWidth: 120 },
          4: { cellWidth: 42, halign: 'center' },
          5: { cellWidth: 26, halign: 'center' },
        },
        didParseCell: (data: any) => {
          if (data.section === 'body' && data.column.index === 5) {
            if (data.cell.raw === 'Yes') data.cell.styles.textColor = [6, 118, 71];
            else if (data.cell.raw === 'No') data.cell.styles.textColor = [180, 35, 24];
          }
        },
      });
    });

    // ---- Violation distribution + timeline ----
    if (sortedVios.length > 0) {
      const typeCounts = new Map<string, number>();
      sortedVios.forEach(v => typeCounts.set(v.type, (typeCounts.get(v.type) || 0) + 1));
      let startY = (doc.lastAutoTable?.finalY || 0) + 22;
      if (startY > pageH - 80) { doc.addPage(); startY = margin; }
      doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.setTextColor(...PDF_INK);
      doc.text('Proctoring Violations', margin, startY);
      autoTable(doc, {
        startY: startY + 6,
        head: [['Type', 'Count']],
        body: Array.from(typeCounts.entries()).sort((a, b) => b[1] - a[1]).map(([t, c]) => [t.replace(/_/g, ' '), String(c)]),
        styles: { fontSize: 8.5, cellPadding: 4 },
        headStyles: { fillColor: [180, 35, 24], textColor: [255, 255, 255], fontSize: 8 },
        columnStyles: { 1: { cellWidth: 60, halign: 'center' } },
      });

      autoTable(doc, {
        startY: (doc.lastAutoTable?.finalY || 0) + 10,
        head: [['Time', 'Type', 'Conf.', 'Description']],
        body: sortedVios.slice(0, 60).map(v => [
          new Date(v.timestamp).toLocaleString(),
          v.type.replace(/_/g, ' ') + ((v.episodeCount ?? 1) > 1 && (v.episodeMs ?? 0) >= 1000
            ? ` (continuous ${formatEpisodeDuration(v.episodeMs || 0)}, ${v.episodeCount}x)`
            : ''),
          v.confidence !== null && v.confidence !== undefined ? `${Math.round(Number(v.confidence) * 100)}%` : '—',
          v.description || '—',
        ]),
        styles: { fontSize: 7.5, cellPadding: 3, overflow: 'linebreak' },
        headStyles: { fillColor: [238, 242, 255], textColor: PDF_MUTED, fontSize: 7.5 },
        columnStyles: { 0: { cellWidth: 105 }, 1: { cellWidth: 95 }, 2: { cellWidth: 34, halign: 'center' }, 3: { cellWidth: 'auto' } },
      });

      // Snapshot grid
      const snaps = sortedVios.filter(v => v.snapshot).slice(0, 24);
      if (snaps.length > 0) {
        let sy = (doc.lastAutoTable?.finalY || 0) + 20;
        if (sy > pageH - 100) { doc.addPage(); sy = margin; }
        doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.setTextColor(...PDF_INK);
        doc.text('Violation Snapshots', margin, sy);
        sy += 10;
        const cols = 4;
        const gap = 8;
        const imgW = (pageW - margin * 2 - gap * (cols - 1)) / cols;
        const imgH = imgW * 0.72;
        snaps.forEach((v, i) => {
          const col = i % cols;
          if (col === 0 && i > 0) sy += imgH + 16;
          if (sy + imgH > pageH - margin) { doc.addPage(); sy = margin; }
          const x = margin + col * (imgW + gap);
          const src = String(v.snapshot);
          const m = /^data:image\/(\w+);/.exec(src);
          let fmt = (m ? m[1] : 'jpeg').toUpperCase();
          if (fmt === 'JPG') fmt = 'JPEG';
          try {
            doc.addImage(src, fmt, x, sy, imgW, imgH);
          } catch {
            doc.setDrawColor(226, 232, 240);
            doc.rect(x, sy, imgW, imgH);
          }
          doc.setFontSize(6); doc.setTextColor(...PDF_MUTED); doc.setFont('helvetica', 'normal');
          doc.text(v.type.replace(/_/g, ' ').slice(0, 22), x, sy + imgH + 8);
        });
      }
    }

    // ---- Footer page numbers ----
    const pageCount = doc.internal.getNumberOfPages();
    for (let p = 1; p <= pageCount; p++) {
      doc.setPage(p);
      doc.setFontSize(7); doc.setTextColor(...PDF_MUTED); doc.setFont('helvetica', 'normal');
      doc.text(`${student?.fullName || studentId} · ${exam?.title || ''}`, margin, pageH - 18);
      doc.text(`Page ${p} of ${pageCount}`, pageW - margin, pageH - 18, { align: 'right' });
    }
  };

  const handleExportExamStudentZip = async () => {
    setReportsMenuOpen(false);
    if (selectedExamId === 'ALL') {
      alert('Select a specific exam in the Exam filter to generate its student reports.');
      return;
    }
    const exam = exams.find(e => e.id === selectedExamId);
    // Cover EVERY assigned student (directly or via batch) plus anyone with an attempt —
    // students who didn't sit the exam get a short "did not attempt" report so the ZIP is complete.
    const assignedIds = new Set(exam?.assignedStudentIds || []);
    const assignedBatches = new Set((exam?.assignedBatchIds || []).map(Number));
    const eligibleIds = students
      .filter(s => assignedIds.has(s.id) || s.batches.some(b => assignedBatches.has(b.id)))
      .map(s => s.id);
    const attemptedIds = results.filter(r => r.examId === selectedExamId).map(r => r.studentId);
    const studentIds = Array.from(new Set<string>([...eligibleIds, ...attemptedIds]))
      .sort((a, b) => (students.find(s => s.id === a)?.fullName || a).localeCompare(students.find(s => s.id === b)?.fullName || b));
    if (studentIds.length === 0) {
      alert('No assigned students or attempts found for this exam yet.');
      return;
    }
    if (studentIds.length > 80 && !confirm(`Generate ${studentIds.length} PDF reports and bundle them into one ZIP? This can take a moment.`)) {
      return;
    }

    setExamZipBusy(true);
    setZipProgress('Loading…');
    try {
      const [jsPdfMod, autoTableMod, jsZipMod] = await Promise.all([
        import('jspdf'),
        import('jspdf-autotable'),
        import('jszip'),
      ]);
      const JsPDF = jsPdfMod.jsPDF;
      const autoTable = autoTableMod.default;
      const JSZip = jsZipMod.default;

      const vios = await fetchExamViolations(selectedExamId);
      const viosByStudent = new Map<string, DossierViolation[]>();
      vios.forEach(v => {
        if (!v.studentId) return;
        const list = viosByStudent.get(v.studentId) || [];
        list.push(v);
        viosByStudent.set(v.studentId, list);
      });

      const tz = resolveExamTimezone(exam?.timezone);
      const zip = new JSZip();
      const usedNames = new Set<string>();

      for (let i = 0; i < studentIds.length; i++) {
        const sid = studentIds[i];
        setZipProgress(`Building ${i + 1} of ${studentIds.length}…`);
        // Yield to the event loop so the progress label repaints.
        await new Promise(res => setTimeout(res, 0));
        const doc = new JsPDF({ unit: 'pt', format: 'a4' });
        buildStudentExamPdf(doc, autoTable, sid, exam, viosByStudent.get(sid) || [], tz);
        const student = students.find(s => s.id === sid);
        const safeName = (student?.fullName || sid).replace(/[^\w\-]+/g, '_');
        const reg = (student?.registrationId || sid).replace(/[^\w\-]+/g, '_');
        let fname = `${reg}_${safeName}.pdf`;
        let n = 2;
        while (usedNames.has(fname)) { fname = `${reg}_${safeName}_${n++}.pdf`; }
        usedNames.add(fname);
        zip.file(fname, doc.output('arraybuffer'));
      }

      setZipProgress('Compressing…');
      const blob = await zip.generateAsync({ type: 'blob' });
      const safeExam = (exam?.title || 'exam').replace(/[^\w\-]+/g, '_');
      const stamp = new Date().toISOString().slice(0, 10);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${safeExam}_student_reports_${stamp}.zip`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } catch (e) {
      console.error('Failed to build student report ZIP:', e);
      alert('Could not generate the reports. Please try again.');
    } finally {
      setExamZipBusy(false);
      setZipProgress('');
    }
  };

  const computeRosterRows = async () => {
    const allVios = await fetchAllViolations();
    const vioByStudent = new Map<string, number>();
    allVios.forEach(v => {
      if (v.studentId) vioByStudent.set(v.studentId, (vioByStudent.get(v.studentId) || 0) + 1);
    });
    return students.map(s => {
      const rs = results.filter(r => r.studentId === s.id);
      const percents = rs.map(resultPercentValue).filter((x): x is number => x !== null);
      const avg = percents.length ? Math.round(percents.reduce((a, b) => a + b, 0) / percents.length) : null;
      const passed = rs.filter(r => r.finalPassed).length;
      const vio = vioByStudent.get(s.id) || 0;
      return { s, attempts: rs.length, avg, passed, vio };
    }).sort((a, b) => (b.vio - a.vio) || ((b.avg ?? -1) - (a.avg ?? -1)));
  };

  const handleExportRosterReport = async () => {
    setReportsMenuOpen(false);
    setRosterBusy(true);
    try {
      const rows = await computeRosterRows();
      const enrolledCount = students.filter(s => s.enrolled).length;
      const flaggedCount = rows.filter(r => r.vio > 0).length;
      const cohortPercents = rows.map(r => r.avg).filter((x): x is number => x !== null);
      const cohortAvg = cohortPercents.length ? Math.round(cohortPercents.reduce((a, b) => a + b, 0) / cohortPercents.length) : 0;

      const bodyRows = rows.map(r => `
        <tr>
          <td>${escapeHtml(r.s.fullName)}</td>
          <td>${escapeHtml(r.s.registrationId)}</td>
          <td>${escapeHtml(r.s.batches.map(b => b.name).join(', ') || '-')}</td>
          <td style="text-align:center">${r.s.enrolled ? 'Yes' : 'No'}</td>
          <td style="text-align:center">${r.attempts}</td>
          <td style="text-align:center">${r.avg === null ? '-' : `${r.avg}%`}</td>
          <td style="text-align:center">${r.passed}/${r.attempts}</td>
          <td style="text-align:center" class="${r.vio > 0 ? 'risk' : ''}">${r.vio}</td>
        </tr>`).join('');

      const body = `
        <div class="brand">
          <div>
            <h1>Student Roster Report</h1>
            <div class="sub">${students.length} students &middot; Generated ${escapeHtml(new Date().toLocaleString())}</div>
          </div>
          <strong>LSC</strong>
        </div>
        <div class="grid">
          <div class="metric"><span>Students</span><strong>${students.length}</strong></div>
          <div class="metric"><span>Face ID Enrolled</span><strong>${enrolledCount}/${students.length}</strong></div>
          <div class="metric"><span>Cohort Avg Score</span><strong>${cohortAvg}%</strong></div>
          <div class="metric"><span>Flagged (violations)</span><strong class="${flaggedCount > 0 ? 'risk' : ''}">${flaggedCount}</strong></div>
        </div>
        <table>
          <thead><tr><th>Name</th><th>Registration</th><th>Batch</th><th>Face ID</th><th>Attempts</th><th>Avg Score</th><th>Passed</th><th>Violations</th></tr></thead>
          <tbody>${bodyRows || '<tr><td colspan="8">No students found.</td></tr>'}</tbody>
        </table>`;
      openPrintWindow(wrapPrintDocument('Student Roster Report', body));
    } finally {
      setRosterBusy(false);
    }
  };

  const handleExportRosterCsv = async () => {
    setReportsMenuOpen(false);
    setRosterBusy(true);
    try {
      const rows = await computeRosterRows();
      const csvRows: string[][] = [
        ['Name', 'Registration ID', 'Email', 'Batch', 'Face ID Enrolled', 'Attempts', 'Avg Score %', 'Passed', 'Violations'],
        ...rows.map(r => [
          r.s.fullName,
          r.s.registrationId,
          r.s.email || '',
          r.s.batches.map(b => b.name).join(', '),
          r.s.enrolled ? 'Yes' : 'No',
          String(r.attempts),
          r.avg === null ? '' : String(r.avg),
          `${r.passed}/${r.attempts}`,
          String(r.vio),
        ]),
      ];
      const stamp = new Date().toISOString().slice(0, 10);
      downloadCsv(`student_roster_${stamp}.csv`, csvRows);
    } finally {
      setRosterBusy(false);
    }
  };

  const handleExportFiltered = () => {
    const rows: string[][] = [
      // 'Result' is appended last so existing column positions are unchanged for anyone parsing this.
      ['Student Name', 'Registration ID', 'Exam Title', 'Attempt', 'Status', 'Score', 'Percent', 'Final Score', 'Final Percent', 'Start Time', 'End Time', 'Result'],
    ];

    filteredResults.forEach(result => {
      const student = students.find(s => s.id === result.studentId);
      const exam = exams.find(e => e.id === result.examId);
      rows.push([
        student?.fullName || result.studentId,
        student?.registrationId || '',
        exam?.title || result.examId,
        result.attemptIndex ? `Attempt ${result.attemptIndex}${result.attemptCount ? `/${result.attemptCount}` : ''}` : '',
        result.status,
        formatScore(result),
        formatPercent(result),
        formatFinalScore(result),
        formatFinalPercent(result),
        formatScheduleShort(result.startTime, resolveExamTimezone(exam?.timezone)),
        result.endTime ? formatScheduleShort(result.endTime, resolveExamTimezone(exam?.timezone)) : '',
        getPassBadge(result).label,
      ]);
    });

    const stamp = new Date().toISOString().slice(0, 10);
    downloadCsv(`results_export_${stamp}.csv`, rows);
  };

  const handleExportAnswerSheet = () => {
    if (!selectedResult) return;
    const exam = exams.find(e => e.id === selectedResult.examId);
    const student = students.find(s => s.id === selectedResult.studentId);

    const rows: string[][] = [
      ['Exam', exam?.title || selectedResult.examId],
      ['Student', student?.fullName || selectedResult.studentId],
      ['Registration ID', student?.registrationId || ''],
      ['Status', selectedResult.status],
      ['Score', formatScore(selectedResult)],
      ['Percent', formatPercent(selectedResult)],
      [],
      ['Q#', 'Question', 'Type', 'Answer', 'Correct Answer', 'Marks', 'Awarded', 'Correct?'],
    ];

    selectedResult.answers.forEach((a, idx) => {
      const { answerText, correctText } = formatResultAnswer(a);
      rows.push([
        String(idx + 1),
        a.questionText,
        a.questionType,
        answerText,
        correctText,
        String(a.marks),
        a.awardedMarks === null || a.awardedMarks === undefined ? '' : String(a.awardedMarks),
        a.isCorrect === null || a.isCorrect === undefined ? '' : (a.isCorrect ? 'Yes' : 'No'),
      ]);
    });

    const safeExam = (exam?.title || 'exam').replace(/[^\w\-]+/g, '_');
    const safeStudent = (student?.fullName || 'student').replace(/[^\w\-]+/g, '_');
    downloadCsv(`answer_sheet_${safeExam}_${safeStudent}.csv`, rows);
  };

  const handleExportAnswerSheetPdf = () => {
    if (!selectedResult) return;
    const exam = exams.find(e => e.id === selectedResult.examId);
    const student = students.find(s => s.id === selectedResult.studentId);
    const safeExam = (exam?.title || 'exam').replace(/[^\w\-]+/g, '_');
    const safeStudent = (student?.fullName || 'student').replace(/[^\w\-]+/g, '_');

    const answerRows = selectedResult.answers.map((a, idx) => {
      const { answerText, correctText } = formatResultAnswer(a);
      const awarded = a.awardedMarks === null || a.awardedMarks === undefined ? '' : String(a.awardedMarks);
      const correct = a.isCorrect === null || a.isCorrect === undefined ? '' : (a.isCorrect ? 'Yes' : 'No');
      return `
        <tr>
          <td>${idx + 1}</td>
          <td>${escapeHtml(a.questionText)}</td>
          <td>${escapeHtml(String(a.questionType || ''))}</td>
          <td>${escapeHtml(answerText)}</td>
          <td>${escapeHtml(correctText)}</td>
          <td>${a.marks}</td>
          <td>${awarded}</td>
          <td>${correct}</td>
        </tr>
      `;
    }).join('');

    const html = `
      <!doctype html>
      <html>
        <head>
          <meta charset="utf-8" />
          <title>Answer Sheet - ${escapeHtml(safeExam)} - ${escapeHtml(safeStudent)}</title>
          <style>
            body { font-family: Arial, sans-serif; margin: 24px; color: #0f172a; }
            h1 { font-size: 20px; margin: 0 0 8px; }
            h2 { font-size: 14px; margin: 0 0 16px; color: #475569; }
            .meta { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-bottom: 16px; }
            .card { border: 1px solid #e2e8f0; padding: 10px; border-radius: 8px; font-size: 12px; }
            .label { text-transform: uppercase; font-size: 10px; color: #64748b; letter-spacing: 1px; }
            .value { font-weight: 600; margin-top: 4px; }
            table { width: 100%; border-collapse: collapse; font-size: 11px; }
            th, td { border: 1px solid #e2e8f0; padding: 6px; vertical-align: top; }
            th { background: #f1f5f9; text-transform: uppercase; letter-spacing: 0.08em; font-size: 9px; color: #475569; }
            .summary { margin: 12px 0 18px; font-size: 12px; color: #334155; }
          </style>
        </head>
        <body>
          <h1>Answer Sheet</h1>
          <h2>${escapeHtml(exam?.title || selectedResult.examId)} - ${escapeHtml(student?.fullName || selectedResult.studentId)}</h2>
          <div class="summary">
            Attempt ${selectedResult.attemptIndex || 1}${selectedResult.attemptCount ? `/${selectedResult.attemptCount}` : ''} -
            Score ${formatScore(selectedResult)} (${formatPercent(selectedResult)}) -
            Final ${formatFinalScore(selectedResult)} (${formatFinalPercent(selectedResult)})
          </div>
          <div class="meta">
            <div class="card">
              <div class="label">Student</div>
              <div class="value">${escapeHtml(student?.fullName || selectedResult.studentId)}</div>
            </div>
            <div class="card">
              <div class="label">Registration ID</div>
              <div class="value">${escapeHtml(student?.registrationId || '')}</div>
            </div>
            <div class="card">
              <div class="label">Status</div>
              <div class="value">${escapeHtml(selectedResult.status)}</div>
            </div>
          </div>
          <table>
            <thead>
              <tr>
                <th>Q#</th>
                <th>Question</th>
                <th>Type</th>
                <th>Answer</th>
                <th>Correct Answer</th>
                <th>Marks</th>
                <th>Awarded</th>
                <th>Correct?</th>
              </tr>
            </thead>
            <tbody>
              ${answerRows}
            </tbody>
          </table>
        </body>
      </html>
    `;

    openPrintWindow(html);
  };

  const handleSaveRegrade = async () => {
    if (!selectedResult) return;
    const changes = selectedResult.answers
      .map(answer => {
        const raw = draftMarks[answer.questionId];
        const normalized = raw === '' || raw === undefined ? null : Number(raw);
        const prev = answer.awardedMarks === null || answer.awardedMarks === undefined ? null : answer.awardedMarks;
        if (normalized === prev || (Number.isNaN(normalized) && prev === null)) return null;
        return {
          questionId: answer.questionId,
          awardedMarks: Number.isNaN(normalized) ? null : normalized,
        };
      })
      .filter((c): c is { questionId: string; awardedMarks: number | null } => c !== null);

    // The server stores whatever number it is sent, so an out-of-range mark (e.g. 50 on a 5-mark
    // question) would push the attempt past 100% and could flip it to PASS. Hold the input to the
    // same 0..marks range the field advertises; clearing a field (back to "Pending") is still allowed.
    const invalid = changes.filter(c => {
      if (c.awardedMarks === null) return false;
      const max = selectedResult.answers.find(a => a.questionId === c.questionId)?.marks ?? 0;
      return !Number.isFinite(c.awardedMarks) || c.awardedMarks < 0 || c.awardedMarks > max;
    });
    if (invalid.length > 0) {
      const labels = invalid.map(c => {
        const idx = selectedResult.answers.findIndex(a => a.questionId === c.questionId);
        const max = selectedResult.answers[idx]?.marks ?? 0;
        return `Question ${idx + 1} (0–${max})`;
      });
      alert(`Marks must be between 0 and the question's maximum:\n${labels.join('\n')}`);
      return;
    }

    setSaving(true);
    try {
      await apiPost('results.php', {
        sessionId: selectedResult.sessionId,
        changes,
        actor: graderName || 'Admin',
        note: gradeNote || null,
      });
      await loadResults();
      await loadAudit(selectedResult.sessionId);
      setEditMode(false);
    } catch (e: any) {
      console.error('Failed to save regrade:', e);
      alert(e?.message || 'Could not save the mark changes. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h2 className="lsc-title flex items-center gap-2">
            <FileText size={20} className="text-[var(--lsc-primary)]" /> Results Analysis
          </h2>
          <p className="lsc-subtitle mt-1">Filter by exam or student to review marks and answer sheets.</p>
        </div>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className="relative">
            <Search className="absolute left-3 top-2.5 text-slate-400" size={16} />
            <input
              type="text"
              placeholder="Search student or exam..."
              aria-label="Search results by student or exam"
              className="pl-9 pr-4 py-2 border border-slate-200 rounded-lg outline-none w-full sm:w-64 text-sm bg-white"
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </div>
          <div className="relative" ref={reportsMenuRef}>
            <button
              onClick={() => setReportsMenuOpen(o => !o)}
              className="px-3 py-2 lsc-button-primary text-sm flex items-center gap-1.5"
              aria-haspopup="menu"
              aria-expanded={reportsMenuOpen}
            >
              <FileText size={14} />
              {(dossierBusy || rosterBusy || batchBusy || examReportBusy || examZipBusy) ? (zipProgress || 'Generating…') : 'Reports & Exports'}
              <ChevronDown size={14} className={`transition-transform ${reportsMenuOpen ? 'rotate-180' : ''}`} />
            </button>
            {reportsMenuOpen && (
              <div
                role="menu"
                className="lsc-menu absolute right-0 mt-2 w-72 p-1.5 z-30"
              >
                <div className="px-3 pt-2 pb-1 text-[10px] font-bold uppercase tracking-wide text-slate-400">Students</div>
                <button
                  role="menuitem"
                  onClick={() => handleExportStudentDossier()}
                  disabled={dossierBusy || selectedStudentId === 'ALL'}
                  className="w-full text-left px-3 py-2 rounded-lg hover:bg-slate-50 disabled:opacity-40 disabled:hover:bg-transparent flex items-start gap-2.5"
                >
                  <FileText size={15} className="text-[var(--lsc-primary)] mt-0.5 shrink-0" />
                  <span>
                    <span className="block text-sm font-medium text-slate-800">Student Dossier (PDF)</span>
                    <span className="block text-[11px] text-slate-400">
                      {selectedStudentId === 'ALL' ? 'Pick a student in the filter first' : 'Full proctoring report for the selected student'}
                    </span>
                  </span>
                </button>
                <button
                  role="menuitem"
                  onClick={handleExportBatchDossiers}
                  disabled={batchBusy}
                  className="w-full text-left px-3 py-2 rounded-lg hover:bg-slate-50 disabled:opacity-40 disabled:hover:bg-transparent flex items-start gap-2.5"
                >
                  <Users size={15} className="text-[var(--lsc-primary)] mt-0.5 shrink-0" />
                  <span>
                    <span className="block text-sm font-medium text-slate-800">{batchBusy ? 'Building…' : 'Batch Dossiers (PDF)'}</span>
                    <span className="block text-[11px] text-slate-400">Combined dossiers for all students in the current view</span>
                  </span>
                </button>
                <button
                  role="menuitem"
                  onClick={handleExportRosterReport}
                  disabled={rosterBusy}
                  className="w-full text-left px-3 py-2 rounded-lg hover:bg-slate-50 disabled:opacity-40 disabled:hover:bg-transparent flex items-start gap-2.5"
                >
                  <BarChart3 size={15} className="text-[var(--lsc-primary)] mt-0.5 shrink-0" />
                  <span>
                    <span className="block text-sm font-medium text-slate-800">{rosterBusy ? 'Building…' : 'Roster Report (PDF)'}</span>
                    <span className="block text-[11px] text-slate-400">Cohort overview of every student</span>
                  </span>
                </button>
                <button
                  role="menuitem"
                  onClick={handleExportRosterCsv}
                  disabled={rosterBusy}
                  className="w-full text-left px-3 py-2 rounded-lg hover:bg-slate-50 disabled:opacity-40 disabled:hover:bg-transparent flex items-start gap-2.5"
                >
                  <Download size={15} className="text-slate-500 mt-0.5 shrink-0" />
                  <span>
                    <span className="block text-sm font-medium text-slate-800">Roster (CSV)</span>
                    <span className="block text-[11px] text-slate-400">Spreadsheet of all students &amp; their stats</span>
                  </span>
                </button>

                <div className="my-1 border-t border-slate-100" />
                <div className="px-3 pt-2 pb-1 text-[10px] font-bold uppercase tracking-wide text-slate-400">Exams</div>
                <button
                  role="menuitem"
                  onClick={handleExportExamReport}
                  disabled={examReportBusy || selectedExamId === 'ALL'}
                  className="w-full text-left px-3 py-2 rounded-lg hover:bg-slate-50 disabled:opacity-40 disabled:hover:bg-transparent flex items-start gap-2.5"
                >
                  <FileText size={15} className="text-[var(--lsc-primary)] mt-0.5 shrink-0" />
                  <span>
                    <span className="block text-sm font-medium text-slate-800">{examReportBusy ? 'Building…' : 'Exam Report (PDF)'}</span>
                    <span className="block text-[11px] text-slate-400">
                      {selectedExamId === 'ALL' ? 'Pick an exam in the filter first' : 'Results, analytics, violations & feedback for the selected exam'}
                    </span>
                  </span>
                </button>
                <button
                  role="menuitem"
                  onClick={handleExportExamStudentZip}
                  disabled={examZipBusy || selectedExamId === 'ALL'}
                  className="w-full text-left px-3 py-2 rounded-lg hover:bg-slate-50 disabled:opacity-40 disabled:hover:bg-transparent flex items-start gap-2.5"
                >
                  <Download size={15} className="text-[var(--lsc-primary)] mt-0.5 shrink-0" />
                  <span>
                    <span className="block text-sm font-medium text-slate-800">{examZipBusy ? (zipProgress || 'Zipping…') : 'All Student Reports (ZIP of PDFs)'}</span>
                    <span className="block text-[11px] text-slate-400">
                      {selectedExamId === 'ALL' ? 'Pick an exam in the filter first' : 'One PDF per assigned student (incl. did-not-attempt), zipped'}
                    </span>
                  </span>
                </button>
                <button
                  role="menuitem"
                  onClick={() => { setReportsMenuOpen(false); handleExportNotAttendedCsv(); }}
                  disabled={selectedExamId === 'ALL' || !notAttempted || notAttempted.list.length === 0}
                  className="w-full text-left px-3 py-2 rounded-lg hover:bg-slate-50 disabled:opacity-40 disabled:hover:bg-transparent flex items-start gap-2.5"
                >
                  <UserX size={15} className="text-slate-500 mt-0.5 shrink-0" />
                  <span>
                    <span className="block text-sm font-medium text-slate-800">Not Attempted (CSV)</span>
                    <span className="block text-[11px] text-slate-400">
                      {selectedExamId === 'ALL'
                        ? 'Pick an exam in the filter first'
                        : notAttempted && notAttempted.list.length > 0
                          ? `${notAttempted.list.length} assigned student(s) with no attempt`
                          : 'All assigned students have attempted'}
                    </span>
                  </span>
                </button>

                <div className="my-1 border-t border-slate-100" />
                <div className="px-3 pt-2 pb-1 text-[10px] font-bold uppercase tracking-wide text-slate-400">Results</div>
                <button
                  role="menuitem"
                  onClick={() => { setReportsMenuOpen(false); handleExportFiltered(); }}
                  className="w-full text-left px-3 py-2 rounded-lg hover:bg-slate-50 flex items-start gap-2.5"
                >
                  <Download size={15} className="text-slate-500 mt-0.5 shrink-0" />
                  <span>
                    <span className="block text-sm font-medium text-slate-800">Results (CSV)</span>
                    <span className="block text-[11px] text-slate-400">Current filtered results table</span>
                  </span>
                </button>
                <button
                  role="menuitem"
                  onClick={() => { setReportsMenuOpen(false); handleExportEnterpriseReportPdf(); }}
                  disabled={!report}
                  className="w-full text-left px-3 py-2 rounded-lg hover:bg-slate-50 disabled:opacity-40 disabled:hover:bg-transparent flex items-start gap-2.5"
                >
                  <BarChart3 size={15} className="text-slate-500 mt-0.5 shrink-0" />
                  <span>
                    <span className="block text-sm font-medium text-slate-800">Enterprise Report (PDF)</span>
                    <span className="block text-[11px] text-slate-400">Organization-wide analytics summary</span>
                  </span>
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
      {loadError && (
        <div className="lsc-panel p-3 text-sm text-rose-700 bg-rose-50 border border-rose-200">
          Failed to load results. {loadError}
        </div>
      )}

      {/* ---- KPI strip: an at-a-glance read on the current filter selection ---- */}
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
        <StatTile icon={<ClipboardList size={16} />} label="Attempts" value={summary.attempts}
          sub={`${summary.completedCount} completed`} tone="primary" />
        <StatTile icon={<CheckCircle2 size={16} />} label="Passed" value={summary.passed}
          sub={`${summary.pendingGrade} pending grade`} tone="success" />
        <StatTile icon={<Ban size={16} />} label="Terminated" value={summary.terminatedCount}
          sub={summary.terminatedCount > 0 ? 'recorded as fail' : 'none'} tone={summary.terminatedCount > 0 ? 'danger' : 'neutral'} />
        <StatTile icon={<TrendingUp size={16} />} label="Pass Rate" value={`${summary.passRate}%`}
          sub={`avg ${summary.avgPercent}%`} tone="primary" />
        <StatTile icon={<Award size={16} />} label="Avg Score" value={`${summary.avgPercent}%`}
          sub="across scored attempts" tone="neutral" />
        <StatTile icon={<ShieldAlert size={16} />} label="Violations" value={summary.violations}
          sub={summary.violations > 0 ? 'flagged events' : 'clean'} tone={summary.violations > 0 ? 'warm' : 'neutral'} />
      </div>

      {summary.topResult && (
        <div className="lsc-panel p-4 flex items-center gap-4">
          <div className="w-11 h-11 rounded-full bg-amber-50 border border-amber-200 flex items-center justify-center shrink-0">
            <Trophy size={20} className="text-amber-500" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[11px] uppercase tracking-widest text-slate-400">Top Performer</div>
            <div className="text-sm font-semibold text-slate-900 truncate">
              {students.find(s => s.id === summary.topResult?.studentId)?.fullName || summary.topResult?.studentId}
              <span className="text-slate-400 font-normal"> · {exams.find(e => e.id === summary.topResult?.examId)?.title || summary.topResult?.examId}</span>
            </div>
          </div>
          <div className="text-right shrink-0">
            <div className="text-lg font-bold text-[var(--lsc-primary)]">{formatFinalPercent(summary.topResult)}</div>
            <div className="text-[11px] text-slate-400">{formatFinalScore(summary.topResult)}</div>
          </div>
        </div>
      )}

      {/* ---- Section tabs: keep the dense page organized ---- */}
      <div className="flex items-center gap-1 p-1 rounded-xl bg-slate-100 border border-slate-200 w-full sm:w-auto sm:inline-flex">
        {([
          { id: 'results', label: 'Results', icon: <ClipboardList size={15} /> },
          { id: 'analytics', label: 'Question Analytics', icon: <BarChart3 size={15} /> },
          { id: 'report', label: 'Enterprise Report', icon: <GraduationCap size={15} /> },
        ] as const).map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`flex-1 sm:flex-none flex items-center justify-center gap-1.5 px-3.5 py-2 rounded-lg text-sm font-medium transition-colors ${
              activeTab === tab.id
                ? 'bg-white text-[var(--lsc-primary-700)] shadow-sm'
                : 'text-slate-500 hover:text-slate-800'
            }`}
          >
            {tab.icon}
            <span className="whitespace-nowrap">{tab.label}</span>
          </button>
        ))}
      </div>

      {activeTab === 'report' && (
      <div className="lsc-panel overflow-hidden">
        <div className="p-4 lsc-panel-header flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="text-sm font-semibold text-slate-800 flex items-center gap-2">
              <BarChart3 size={16} className="text-[var(--lsc-primary)]" /> Enterprise Reports
            </div>
            <div className="text-xs text-slate-500 mt-1">
              Batch-wise, student-wise, exam-wise, and violation analytics for compliance review.
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1.5">
              <label htmlFor="report-from-date" className="text-[11px] font-medium text-slate-500">From</label>
              <input
                id="report-from-date"
                type="date"
                value={reportFromDate}
                max={reportToDate || undefined}
                onChange={e => setReportFromDate(e.target.value)}
                className="px-2 py-1.5 border border-slate-200 rounded-lg text-xs outline-none bg-white"
              />
              <label htmlFor="report-to-date" className="text-[11px] font-medium text-slate-500">To</label>
              <input
                id="report-to-date"
                type="date"
                value={reportToDate}
                min={reportFromDate || undefined}
                onChange={e => setReportToDate(e.target.value)}
                className="px-2 py-1.5 border border-slate-200 rounded-lg text-xs outline-none bg-white"
              />
            </div>
            <button
              onClick={handleApplyReportDateFilter}
              disabled={reportLoading || (!reportFromDate && !reportToDate)}
              className="px-3 py-2 rounded-lg border border-[var(--lsc-primary-50)] bg-[var(--lsc-primary-50)] text-xs font-semibold text-[var(--lsc-primary-700)] hover:bg-[var(--lsc-primary-50)]/70 disabled:opacity-50"
            >
              Apply
            </button>
            {(reportFromDate || reportToDate) && (
              <button
                onClick={handleClearReportDateFilter}
                disabled={reportLoading}
                className="px-3 py-2 rounded-lg border border-slate-200 text-xs font-semibold text-slate-500 hover:bg-slate-50 disabled:opacity-50"
              >
                Clear
              </button>
            )}
            <button
              onClick={() => loadEnterpriseReport()}
              disabled={reportLoading}
              className="px-3 py-2 rounded-lg border border-slate-200 text-xs font-semibold text-slate-600 hover:bg-slate-50 disabled:opacity-50"
            >
              {reportLoading ? 'Refreshing...' : 'Refresh Report'}
            </button>
          </div>
        </div>
        {report?.dateFilter && (
          <div className="px-4 pt-3 text-[11px] text-slate-500">
            Showing exams and students with activity from <strong>{report.dateFilter.from}</strong> to <strong>{report.dateFilter.to}</strong>.
          </div>
        )}
        {!report && (
          <div className="p-5 text-sm text-slate-400">
            {reportLoading ? 'Loading enterprise report...' : 'No report data available yet.'}
          </div>
        )}
        {report && (
          <div className="p-4 space-y-5">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <ReportMetric label="Sessions" value={report.summary.sessions} />
              <ReportMetric label="Completion" value={`${report.summary.completionRate}%`} />
              <ReportMetric label="Pass Rate" value={`${report.summary.passRate}%`} />
              <ReportMetric label="Violations" value={report.summary.violations} tone={report.summary.violations > 0 ? 'danger' : 'neutral'} />
            </div>

            <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
              <ReportTable
                title="Batch-wise Report"
                empty="No batches found."
                headers={['Batch', 'Students', 'Attempts', 'Pass', 'Violations']}
                rows={report.byBatch.map(row => [
                  row.name,
                  String(row.students),
                  String(row.attempts),
                  `${row.passRate}%`,
                  String(row.violations),
                ])}
              />
              <ReportTable
                title="Exam-wise Report"
                empty="No exams found."
                headers={['Exam', 'Status', 'Attempts', 'Avg', 'Violations']}
                rows={report.byExam.map(row => [
                  row.title,
                  row.status,
                  String(row.attempts),
                  `${row.avgPercent}%`,
                  String(row.violations),
                ])}
              />
            </div>

            <div className="grid grid-cols-1 xl:grid-cols-[1fr_1.2fr] gap-5">
              <div className="rounded-lg border border-slate-200 p-4">
                <div className="text-sm font-semibold text-slate-800 flex items-center gap-2">
                  <ShieldAlert size={15} className="text-[#d93025]" /> Violation Types
                </div>
                <div className="mt-3 space-y-2">
                  {report.violationsByType.length === 0 && (
                    <div className="text-xs text-slate-400">No violations recorded.</div>
                  )}
                  {report.violationsByType.map(item => {
                    const max = Math.max(1, ...report.violationsByType.map(v => v.count));
                    return (
                      <div key={item.type} className="grid grid-cols-[120px_1fr_32px] items-center gap-2 text-xs">
                        <span className="text-slate-600 truncate">{item.type.replace(/_/g, ' ')}</span>
                        <div className="h-2 rounded-full bg-slate-100 overflow-hidden">
                          <div
                            className="h-full rounded-full bg-[var(--lsc-primary)]"
                            style={{ width: `${Math.max(5, (item.count / max) * 100)}%` }}
                          />
                        </div>
                        <span className="font-semibold text-slate-800 text-right">{item.count}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
              <ReportTable
                title="Highest Risk Students"
                empty="No student activity yet."
                headers={['Student', 'Batch', 'Attempts', 'Avg', 'Violations']}
                rows={report.byStudent.map(row => [
                  row.name,
                  row.batch || '-',
                  String(row.attempts),
                  `${row.avgPercent}%`,
                  String(row.violations),
                ])}
              />
            </div>

            <ReportTable
              title="Recent Student Feedback"
              empty="No feedback submitted yet."
              headers={['Student', 'Batch', 'Exam', 'Rating', 'Comment']}
              rows={feedback.map(item => [
                item.studentName || item.studentId,
                item.batch || '-',
                item.examTitle || item.examId,
                `${item.rating}/5`,
                item.comment || '-',
              ])}
            />
          </div>
        )}
      </div>
      )}

      {activeTab === 'analytics' && (
        <div className="lsc-panel overflow-hidden">
          <div className="p-4 lsc-panel-header flex items-center justify-between">
            <div className="text-sm font-semibold text-slate-800 flex items-center gap-2">
              <BarChart3 size={16} className="text-[var(--lsc-primary)]" /> Question Analytics
            </div>
            <div className="text-xs text-slate-500">
              {selectedExamId === 'ALL' ? 'Select an exam to view' : (exams.find(e => e.id === selectedExamId)?.title || selectedExamId)}
            </div>
          </div>
          <div className="p-4">
            {selectedExamId === 'ALL' && (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <div className="w-12 h-12 rounded-full bg-slate-100 flex items-center justify-center mb-3">
                  <BarChart3 size={22} className="text-slate-400" />
                </div>
                <div className="text-sm font-medium text-slate-600">Pick an exam to see per-question analytics</div>
                <div className="text-xs text-slate-400 mt-1">Correct rate, difficulty, discrimination and average time for every question.</div>
                <select
                  value={selectedExamId}
                  onChange={e => setSelectedExamId(e.target.value)}
                  aria-label="Choose an exam for question analytics"
                  className="mt-4 px-3 py-2 border border-slate-200 rounded-lg text-sm outline-none bg-white max-w-xs"
                >
                  <option value="ALL">Choose an exam…</option>
                  {exams.map(exam => (
                    <option key={exam.id} value={exam.id}>{exam.title}</option>
                  ))}
                </select>
              </div>
            )}
            {selectedExamId !== 'ALL' && analyticsLoading && (
              <div className="text-xs text-slate-400">Loading analytics...</div>
            )}
            {selectedExamId !== 'ALL' && !analyticsLoading && analytics.length === 0 && (
              <div className="text-xs text-slate-400">No analytics data yet.</div>
            )}
            {selectedExamId !== 'ALL' && !analyticsLoading && analytics.length > 0 && (
              <div className="lsc-table-wrap">
                <table className="w-full text-left text-xs">
                  <thead className="text-slate-500 uppercase tracking-wider">
                    <tr>
                      <th className="py-2 pr-4">Question</th>
                      <th className="py-2 pr-4">Type</th>
                      <th className="py-2 pr-4">Attempts</th>
                      <th className="py-2 pr-4">Correct</th>
                      <th className="py-2 pr-4">Difficulty</th>
                      <th className="py-2 pr-4">Discrimination</th>
                      <th className="py-2 pr-4">Avg Marks</th>
                      <th className="py-2">Avg Time</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {analyticsPaging.pageItems.map(item => (
                      <tr key={item.questionId} className="text-slate-700">
                        <td className="py-2 pr-4 min-w-[260px]">
                          <div className="font-medium text-slate-900">{item.questionText}</div>
                          <div className="text-[10px] text-slate-400">Marks: {item.marks}</div>
                        </td>
                        <td className="py-2 pr-4">{item.questionType}</td>
                        <td className="py-2 pr-4">{item.attempts}</td>
                        <td className="py-2 pr-4">{formatRate(item.correctRate)}</td>
                        <td className="py-2 pr-4">{formatRate(item.difficulty)}</td>
                        <td className="py-2 pr-4">{item.discrimination.toFixed(2)}</td>
                        <td className="py-2 pr-4">{item.avgAwardedMarks.toFixed(2)}</td>
                        <td className="py-2">{formatSeconds(item.avgTimeSec)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {selectedExamId !== 'ALL' && !analyticsLoading && analytics.length > 0 && (
              <Pagination state={analyticsPaging} label="questions" className="-mx-4 -mb-4 mt-2" />
            )}
          </div>
        </div>
      )}

      {activeTab === 'results' && notAttempted && (
        <div className="lsc-panel overflow-hidden">
          <button
            onClick={() => setNotAttemptedOpen(o => !o)}
            className="w-full p-4 flex items-center justify-between gap-3 text-left hover:bg-slate-50/60 transition-colors"
            aria-expanded={notAttemptedOpen}
          >
            <div className="flex items-center gap-3 min-w-0">
              <span className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${notAttempted.list.length > 0 ? 'bg-amber-50 text-amber-600' : 'bg-teal-50 text-teal-600'}`}>
                <UserX size={18} />
              </span>
              <div className="min-w-0">
                <div className="text-sm font-semibold text-slate-800">
                  Not Attempted
                  <span className={`ml-2 text-xs font-bold px-2 py-0.5 rounded-full ${notAttempted.list.length > 0 ? 'bg-amber-100 text-amber-700' : 'bg-teal-100 text-teal-700'}`}>
                    {notAttempted.list.length}
                  </span>
                </div>
                <div className="text-[11px] text-slate-500 mt-0.5">
                  {notAttempted.hasAssignments
                    ? `${notAttempted.attemptedCount} of ${notAttempted.eligibleCount} assigned students attempted`
                    : 'This exam has no student/batch assignments recorded'}
                </div>
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {notAttempted.list.length > 0 && (
                <span
                  role="button"
                  tabIndex={0}
                  onClick={(e) => { e.stopPropagation(); handleExportNotAttendedCsv(); }}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); handleExportNotAttendedCsv(); } }}
                  className="hidden sm:inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-slate-200 text-xs text-slate-600 hover:bg-white"
                >
                  <Download size={13} /> CSV
                </span>
              )}
              <ChevronDown size={18} className={`text-slate-400 transition-transform ${notAttemptedOpen ? 'rotate-180' : ''}`} />
            </div>
          </button>
          {notAttemptedOpen && (
            <div className="border-t border-slate-200">
              {notAttempted.list.length === 0 ? (
                <div className="p-5 text-sm text-slate-500 flex items-center gap-2">
                  <CheckCircle2 size={16} className="text-teal-500" />
                  {notAttempted.hasAssignments
                    ? 'Every assigned student has attempted this exam.'
                    : 'No assignments recorded, so there is no pending list to show.'}
                </div>
              ) : (
                <div className="max-h-[360px] overflow-y-auto lsc-table-wrap">
                  <table className="w-full text-left text-xs">
                    <thead className="sticky top-0 bg-slate-50 text-slate-500 uppercase tracking-wider">
                      <tr>
                        <th className="px-4 py-2 font-semibold">Student</th>
                        <th className="px-4 py-2 font-semibold">Registration</th>
                        <th className="px-4 py-2 font-semibold">Batch</th>
                        <th className="px-4 py-2 font-semibold text-center">Face ID</th>
                        <th className="px-4 py-2 font-semibold">Reason</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {notAttemptedPaging.pageItems.map(s => {
                        const reason = reasonFor(s.id);
                        const isNoShow = reason.startsWith('No-show');
                        return (
                        <tr key={s.id} className="text-slate-700">
                          <td className="px-4 py-2 font-medium text-slate-900">
                            {s.fullName}
                            {s.email && <div className="text-[10px] text-slate-400 font-normal truncate max-w-[200px]">{s.email}</div>}
                          </td>
                          <td className="px-4 py-2 text-slate-500">{s.registrationId || '—'}</td>
                          <td className="px-4 py-2 text-slate-500">{s.batches.map(b => b.name).join(', ') || '—'}</td>
                          <td className="px-4 py-2 text-center">
                            {s.enrolled
                              ? <span className="text-teal-600 text-[11px] font-semibold">Enrolled</span>
                              : <span className="text-slate-400 text-[11px]">No</span>}
                          </td>
                          <td className="px-4 py-2">
                            <span className={`inline-block text-[11px] font-medium px-2 py-0.5 rounded-full ${isNoShow ? 'bg-slate-100 text-slate-500' : 'bg-amber-50 text-amber-700 border border-amber-200'}`}>
                              {reason}
                            </span>
                          </td>
                        </tr>
                      );})}
                    </tbody>
                  </table>
                </div>
              )}
              <Pagination state={notAttemptedPaging} label="students" />
            </div>
          )}
        </div>
      )}

      {activeTab === 'results' && (
      <div className="grid grid-cols-1 xl:grid-cols-[360px_1fr] gap-6">
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
          <div className="p-4 border-b border-slate-200 bg-slate-50 space-y-3">
            <div className="flex items-center justify-between">
              <div className="text-sm font-semibold text-slate-800">Filters</div>
              <span className="text-[11px] font-medium text-slate-400">{filteredResults.length} shown</span>
            </div>
            <div className="space-y-2">
              <select
                value={selectedExamId}
                onChange={e => setSelectedExamId(e.target.value)}
                aria-label="Filter by exam"
                className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm outline-none bg-white"
              >
                <option value="ALL">All Exams</option>
                {exams.map(exam => (
                  <option key={exam.id} value={exam.id}>{exam.title}</option>
                ))}
              </select>
              <select
                value={selectedStudentId}
                onChange={e => setSelectedStudentId(e.target.value)}
                aria-label="Filter by student"
                className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm outline-none bg-white"
              >
                <option value="ALL">All Students</option>
                {students.map(student => (
                  <option key={student.id} value={student.id}>{student.fullName}</option>
                ))}
              </select>
              <div className="flex items-center gap-1.5">
                {(['ALL', 'COMPLETED', 'TERMINATED'] as const).map(s => (
                  <button
                    key={s}
                    onClick={() => setStatusFilter(s)}
                    aria-pressed={statusFilter === s}
                    className={`flex-1 px-2 py-1.5 rounded-lg text-[11px] font-semibold border transition-colors ${
                      statusFilter === s
                        ? (s === 'TERMINATED' ? 'border-rose-300 bg-rose-50 text-rose-700'
                          : s === 'COMPLETED' ? 'border-teal-300 bg-teal-50 text-teal-700'
                          : 'border-blue-300 bg-blue-50 text-blue-700')
                        : 'border-slate-200 bg-white text-slate-500 hover:bg-slate-50'
                    }`}
                  >
                    {s === 'ALL' ? 'All' : s === 'COMPLETED' ? 'Completed' : 'Terminated'}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <div className="p-4 space-y-3 max-h-[640px] overflow-y-auto">
            {loading && (
              <div className="text-xs text-slate-400">Loading results...</div>
            )}
            {!loading && filteredResults.length === 0 && (
              <div className="text-xs text-slate-400">No results found.</div>
            )}
            {!loading && resultPaging.pageItems.map(result => {
              const student = students.find(s => s.id === result.studentId);
              const exam = exams.find(e => e.id === result.examId);
              const active = selectedResult?.sessionId === result.sessionId;
              const passBadge = getPassBadge(result);
              return (
                <button
                  key={result.sessionId}
                  onClick={() => setSelectedSessionId(result.sessionId)}
                  className={`w-full text-left p-3 rounded-xl border transition-all ${
                    active ? 'border-blue-300 bg-blue-50/60 shadow-sm' : 'border-slate-200 hover:bg-slate-50'
                  }`}
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-sm font-semibold text-slate-900 truncate">{student?.fullName || result.studentId}</div>
                      <div className="text-[11px] text-slate-500 truncate">{exam?.title || result.examId}</div>
                    </div>
                    <span className={`text-[10px] px-2 py-1 rounded-full border ${passBadge.tone}`}>
                      {passBadge.label}
                    </span>
                  </div>
                  <div className="mt-2 text-[11px] text-slate-500 flex justify-between">
                    <span>
                      Attempt {result.attemptIndex || 1}
                      {result.attemptCount ? `/${result.attemptCount}` : ''}
                    </span>
                    <span>Score: {formatScore(result)}</span>
                  </div>
                  <div className="text-[10px] text-slate-400 flex justify-between mt-1">
                    <span>Final: {formatFinalScore(result)}</span>
                    <span>{formatFinalPercent(result)}</span>
                  </div>
                  {result.status === 'TERMINATED' && (
                    <div className="mt-2 flex items-center flex-wrap gap-1.5">
                      <span className="text-[9px] font-semibold px-1.5 py-0.5 rounded bg-rose-100 text-rose-700 border border-rose-200">
                        TERMINATED
                      </span>
                      {typeof result.answeredCount === 'number' && (
                        <span className="text-[9px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-600 border border-slate-200">
                          {result.answeredCount} attended
                        </span>
                      )}
                      {(result.violationCount ?? 0) > 0 && (
                        <span className="text-[9px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 border border-amber-200">
                          {result.violationCount} violation{(result.violationCount ?? 0) === 1 ? '' : 's'}
                        </span>
                      )}
                    </div>
                  )}
                  {result.status === 'TERMINATED' && result.terminationReason && (
                    <div className="mt-1 text-[10px] text-rose-600/90 leading-snug line-clamp-2">
                      {result.terminationReason}
                    </div>
                  )}
                </button>
              );
            })}
          </div>
          <Pagination state={resultPaging} label="attempts" />
        </div>

        <div className="lsc-panel overflow-hidden">
          {/* Wraps on narrow screens — the panel clips overflow, so a single row hid the export buttons. */}
          <div className="p-4 lsc-panel-header flex flex-wrap items-center justify-between gap-3">
            <div className="text-sm font-semibold text-slate-800 flex items-center gap-2">
              <Award size={16} className="text-[var(--lsc-primary)]" /> Answer Sheet
            </div>
            <div className="flex flex-wrap items-center gap-2 sm:gap-3">
              {selectedResult && (
                <div className="text-xs text-slate-500">
                  Attempt {selectedResult.attemptIndex || 1}
                  {selectedResult.attemptCount ? `/${selectedResult.attemptCount}` : ''} -
                  Score {formatScore(selectedResult)} ({formatPercent(selectedResult)}) -
                  Final {formatFinalScore(selectedResult)} ({formatFinalPercent(selectedResult)})
                </div>
              )}
              {canManageResults && selectedResult && !editMode && (
                <button
                  onClick={() => {
                    setDraftMarks(buildDraftMarks(selectedResult));
                    setEditMode(true);
                  }}
                  className="px-2.5 py-1.5 rounded-lg border border-slate-200 text-xs text-slate-600 hover:bg-slate-50"
                >
                  Regrade
                </button>
              )}
              {canManageResults && selectedResult && editMode && (
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => {
                      setDraftMarks(buildDraftMarks(selectedResult));
                      setEditMode(false);
                    }}
                    className="px-2.5 py-1.5 rounded-lg border border-slate-200 text-xs text-slate-600 hover:bg-slate-50"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleSaveRegrade}
                    disabled={saving}
                    className="px-2.5 py-1.5 rounded-lg border border-slate-200 text-xs text-slate-600 hover:bg-slate-50 disabled:opacity-50"
                  >
                    {saving ? 'Saving...' : 'Save'}
                  </button>
                </div>
              )}
              <button
                onClick={handleExportAnswerSheet}
                disabled={!selectedResult}
                className="px-2.5 py-1.5 rounded-lg border border-slate-200 text-xs text-slate-600 hover:bg-slate-50 disabled:opacity-50 disabled:hover:bg-transparent"
              >
                Export Answer Sheet
              </button>
              <button
                onClick={handleExportAnswerSheetPdf}
                disabled={!selectedResult}
                className="px-2.5 py-1.5 rounded-lg border border-slate-200 text-xs text-slate-600 hover:bg-slate-50 disabled:opacity-50 disabled:hover:bg-transparent"
              >
                Export PDF
              </button>
              <button
                onClick={() => selectedResult && handleExportStudentDossier(selectedResult.studentId)}
                disabled={!selectedResult || dossierBusy}
                title="Full proctoring dossier for this student"
                className="px-2.5 py-1.5 rounded-lg border border-[var(--lsc-primary-50)] bg-[var(--lsc-primary-50)] text-xs text-[var(--lsc-primary-700)] font-medium hover:bg-[var(--lsc-primary-50)] disabled:opacity-50"
              >
                {dossierBusy ? 'Building…' : 'Student Dossier'}
              </button>
              {canManageResults && selectedResult && selectedResult.finalPassed && exams.find(e => e.id === selectedResult.examId)?.certificateEnabled && (
                <button
                  onClick={() => handleIssueCertificate(selectedResult.sessionId)}
                  disabled={certBusy}
                  title="Issue a certificate for this result on demand"
                  className="px-2.5 py-1.5 rounded-lg border border-emerald-200 bg-emerald-50 text-xs text-emerald-700 font-medium hover:bg-emerald-100 disabled:opacity-50"
                >
                  {certBusy
                    ? 'Issuing…'
                    : certStatus[selectedResult.sessionId]
                      ? `Certificate: ${certStatus[selectedResult.sessionId]}`
                      : 'Issue Certificate'}
                </button>
              )}
            </div>
          </div>
          {!selectedResult && (
            <div className="p-6 text-sm text-slate-400">Select a result to view the answer sheet.</div>
          )}
          {selectedResult && (
            <div className="p-6 space-y-4 max-h-[640px] overflow-y-auto">
              {selectedResult.status === 'TERMINATED' && (
                <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3">
                  <div className="flex items-center gap-2 text-sm font-semibold text-rose-800">
                    <ShieldAlert size={15} /> Attempt terminated — recorded as FAIL
                  </div>
                  {selectedResult.terminationReason && (
                    <div className="mt-1 text-xs text-rose-700">{selectedResult.terminationReason}</div>
                  )}
                  <div className="mt-2 flex flex-wrap gap-2 text-[11px]">
                    {typeof selectedResult.answeredCount === 'number' && (
                      <span className="px-2 py-0.5 rounded-full bg-white border border-rose-200 text-rose-700">
                        {selectedResult.answeredCount} questions attended (scored below)
                      </span>
                    )}
                    <span className="px-2 py-0.5 rounded-full bg-white border border-amber-200 text-amber-700">
                      {selectedResult.violationCount ?? 0} violation{(selectedResult.violationCount ?? 0) === 1 ? '' : 's'} logged
                    </span>
                  </div>
                </div>
              )}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <div className="border border-slate-200 rounded-lg p-3">
                  <div className="text-[11px] uppercase tracking-widest text-slate-400">Student</div>
                  <div className="text-sm font-semibold text-slate-900 mt-1">
                    {students.find(s => s.id === selectedResult.studentId)?.fullName || selectedResult.studentId}
                  </div>
                </div>
                <div className="border border-slate-200 rounded-lg p-3">
                  <div className="text-[11px] uppercase tracking-widest text-slate-400">Exam</div>
                  <div className="text-sm font-semibold text-slate-900 mt-1">
                    {exams.find(e => e.id === selectedResult.examId)?.title || selectedResult.examId}
                  </div>
                </div>
                <div className="border border-slate-200 rounded-lg p-3">
                  <div className="text-[11px] uppercase tracking-widest text-slate-400">Status</div>
                  <div className="text-sm font-semibold text-slate-900 mt-1">
                    {selectedResult.status}
                  </div>
                </div>
              </div>

              {editMode && (
                <div className="border border-slate-200 rounded-lg p-3 grid grid-cols-1 md:grid-cols-[1fr_2fr] gap-3">
                  <div>
                    <label htmlFor="regrade-grader" className="text-[11px] uppercase tracking-widest text-slate-400">Graded By</label>
                    <input
                      id="regrade-grader"
                      type="text"
                      className="mt-1 w-full px-3 py-2 border border-slate-200 rounded-lg text-sm outline-none"
                      value={graderName}
                      onChange={e => setGraderName(e.target.value)}
                      placeholder="Admin name"
                    />
                  </div>
                  <div>
                    <label htmlFor="regrade-note" className="text-[11px] uppercase tracking-widest text-slate-400">Regrade Note</label>
                    <input
                      id="regrade-note"
                      type="text"
                      className="mt-1 w-full px-3 py-2 border border-slate-200 rounded-lg text-sm outline-none"
                      value={gradeNote}
                      onChange={e => setGradeNote(e.target.value)}
                      placeholder="Reason or notes for this change"
                    />
                  </div>
                </div>
              )}

              {selectedResult.answers.length === 0 && (
                <div className="text-sm text-slate-400">No answers recorded for this session.</div>
              )}

              {selectedResult.answers.map((answer, idx) => {
                // MCQ / True-False / Yes-No all store a single option index, so all three render as
                // the option list. Every other type stores its response in answer_json (or as a
                // scalar), which only formatResultAnswer knows how to read — answerText alone is
                // empty for them, which used to show "No response provided." for answered questions.
                const isOptionType = answer.questionType === QuestionType.MCQ
                  || answer.questionType === QuestionType.TRUE_FALSE
                  || answer.questionType === QuestionType.YES_NO;
                const isMcq = isOptionType && Array.isArray(answer.options) && answer.options.length > 0;
                const isManual = isManualGraded(answer.questionType);
                const formatted = isMcq ? null : formatResultAnswer(answer);
                const responseText = formatted && formatted.answerText && formatted.answerText !== '—'
                  ? formatted.answerText
                  : 'No response provided.';
                const correctText = formatted && !isManual && formatted.correctText !== '—' ? formatted.correctText : '';
                const selectedIdx = answer.answerOptionIndex;
                const correctIdx = answer.correctOptionIndex;
                // Only manually graded (free-text) questions can be "Pending"; an unanswered
                // auto-graded question simply scored nothing.
                const awardedText = answer.awardedMarks === null || answer.awardedMarks === undefined
                  ? (isManual ? 'Pending' : '0')
                  : `${answer.awardedMarks}`;
                const timeLabel = answer.timeSpentSec !== null && answer.timeSpentSec !== undefined
                  ? formatSeconds(answer.timeSpentSec)
                  : '-';
                return (
                  <div key={`${answer.questionId}-${idx}`} className="border border-slate-200 rounded-xl p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="text-[11px] uppercase tracking-widest text-slate-400">Question {idx + 1}</div>
                        <div className="text-sm font-semibold text-slate-900 mt-1">{answer.questionText}</div>
                      </div>
                      <div className="text-xs text-slate-500 whitespace-nowrap">
                        {editMode ? (
                          <div className="flex items-center gap-2">
                            <span className="text-slate-500">Marks</span>
                            <input
                              type="number"
                              min="0"
                              max={answer.marks}
                              aria-label={`Marks for question ${idx + 1} (out of ${answer.marks})`}
                              className="w-20 px-2 py-1 border border-slate-200 rounded text-xs outline-none"
                              value={draftMarks[answer.questionId] ?? ''}
                              onChange={e => setDraftMarks(prev => ({ ...prev, [answer.questionId]: e.target.value }))}
                              placeholder="0"
                            />
                            <span className="text-slate-400">/ {answer.marks}</span>
                            <span className="text-slate-400">| Time: {timeLabel}</span>
                          </div>
                        ) : (
                          <>Marks: {awardedText} / {answer.marks} | Time: {timeLabel}</>
                        )}
                      </div>
                    </div>

                    {isMcq && answer.options && (
                      <div className="mt-3 space-y-2">
                        {answer.options.map((opt, optIdx) => {
                          const isSelected = selectedIdx === optIdx;
                          const isCorrect = correctIdx === optIdx;
                          return (
                            <div
                              key={optIdx}
                              className={`flex items-center justify-between text-sm px-3 py-2 rounded-lg border ${
                                isCorrect
                                  ? 'border-teal-200 bg-teal-50 text-teal-800'
                                  : isSelected
                                    ? 'border-rose-200 bg-rose-50 text-rose-700'
                                    : 'border-slate-200 bg-white text-slate-600'
                              }`}
                            >
                              <span>{opt}</span>
                              <span className="text-[11px]">
                                {isCorrect ? 'Correct' : isSelected ? 'Selected' : ''}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    )}

                    {!isMcq && (
                      <div className="mt-3 border border-slate-200 rounded-lg p-3 bg-slate-50 text-sm text-slate-700 whitespace-pre-wrap break-words">
                        {responseText}
                      </div>
                    )}
                    {!isMcq && correctText && (
                      <div className="mt-2 text-xs text-teal-700">
                        <span className="font-semibold">Correct answer:</span> {correctText}
                      </div>
                    )}

                    {answer.isCorrect !== null && answer.isCorrect !== undefined && (
                      <div className="mt-3 flex items-center gap-2 text-xs">
                        {answer.isCorrect ? (
                          <span className="inline-flex items-center gap-1 text-teal-600">
                            <CheckCircle2 size={12} /> Correct
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-rose-600">
                            <XCircle size={12} /> Incorrect
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}

              <div className="border-t border-slate-200 pt-4">
                <div className="text-sm font-semibold text-slate-800 mb-3">Regrade Audit Log</div>
                {auditLoading && (
                  <div className="text-xs text-slate-400">Loading audit logs...</div>
                )}
                {!auditLoading && auditLogs.length === 0 && (
                  <div className="text-xs text-slate-400">No regrade activity yet.</div>
                )}
                {!auditLoading && auditLogs.length > 0 && (
                  <div className="space-y-2">
                    {auditLogs.map(log => (
                      <div key={log.id} className="flex items-start justify-between gap-3 border border-slate-200 rounded-lg p-3 text-xs">
                        <div>
                          <div className="text-slate-700 font-semibold">
                            {log.actor || 'Admin'} updated {log.questionId ? `Q:${log.questionId}` : 'session'}
                          </div>
                          <div className="text-slate-500 mt-1">
                            {log.previousAwardedMarks ?? '-'}{' -> '}{log.newAwardedMarks ?? '-'} marks
                          </div>
                          {log.note && (
                            <div className="text-slate-400 mt-1">Note: {log.note}</div>
                          )}
                        </div>
                        <div className="text-slate-400 whitespace-nowrap">
                          {new Date(log.createdAt).toLocaleString()}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
      )}
    </div>
  );
};

const STAT_TONES: Record<string, { icon: string; value: string }> = {
  primary: { icon: 'bg-[var(--lsc-primary-50)] text-[var(--lsc-primary)]', value: 'text-slate-900' },
  success: { icon: 'bg-teal-50 text-teal-600', value: 'text-slate-900' },
  danger: { icon: 'bg-rose-50 text-rose-600', value: 'text-rose-700' },
  warm: { icon: 'bg-amber-50 text-amber-600', value: 'text-amber-700' },
  neutral: { icon: 'bg-slate-100 text-slate-500', value: 'text-slate-900' },
};

const StatTile = ({ icon, label, value, sub, tone = 'neutral' }: {
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
  sub?: string;
  tone?: 'primary' | 'success' | 'danger' | 'warm' | 'neutral';
}) => {
  const t = STAT_TONES[tone] || STAT_TONES.neutral;
  return (
    <div className="lsc-panel p-3.5 flex flex-col gap-2 h-full">
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-semibold uppercase tracking-widest text-slate-400">{label}</span>
        <span className={`w-7 h-7 rounded-lg flex items-center justify-center ${t.icon}`}>{icon}</span>
      </div>
      <div className={`text-2xl font-bold leading-none ${t.value}`}>{value}</div>
      {sub && <div className="text-[11px] text-slate-400 truncate">{sub}</div>}
    </div>
  );
};

const ReportMetric = ({ label, value, tone = 'neutral' }: { label: string; value: React.ReactNode; tone?: 'neutral' | 'danger' }) => (
  <div className={`rounded-lg border p-3 ${tone === 'danger' ? 'border-orange-200 bg-orange-50' : 'border-slate-200 bg-white'}`}>
    <div className="text-[10px] uppercase tracking-widest text-slate-400">{label}</div>
    <div className={`mt-1 text-2xl font-semibold ${tone === 'danger' ? 'text-orange-700' : 'text-slate-900'}`}>{value}</div>
  </div>
);

const ReportTable = ({
  title,
  headers,
  rows,
  empty,
  pageSize = 8,
}: {
  title: string;
  headers: string[];
  rows: string[][];
  empty: string;
  pageSize?: number;
}) => {
  // Report tables are stacked several to a page, so they keep their own small fixed size instead of
  // following the global "Rows per page" preference.
  const paging = usePagination(rows, title, pageSize);

  return (
    <div className="rounded-lg border border-slate-200 overflow-hidden bg-white">
      <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between gap-3">
        <span className="text-sm font-semibold text-slate-800">{title}</span>
        {rows.length > 0 && <span className="text-[11px] text-slate-400">{rows.length} total</span>}
      </div>
      {rows.length === 0 ? (
        <div className="p-4 text-xs text-slate-400">{empty}</div>
      ) : (
        <>
          <div className="lsc-table-wrap">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-50 text-slate-500 uppercase tracking-wider">
                <tr>
                  {headers.map(header => (
                    <th key={header} className="px-3 py-2 font-semibold">{header}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {paging.pageItems.map((row, idx) => (
                  <tr key={`${title}-${paging.page}-${idx}`} className="text-slate-700">
                    {row.map((cell, cellIdx) => (
                      <td key={`${title}-${paging.page}-${idx}-${cellIdx}`} className="px-3 py-2 max-w-[220px] truncate" title={cell}>
                        {cell}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination state={paging} label="rows" hidePageSize />
        </>
      )}
    </div>
  );
};
