import React, { useEffect, useMemo, useState } from 'react';
import { Award, BarChart3, CheckCircle2, Download, FileText, Search, ShieldAlert, XCircle } from 'lucide-react';
import { apiGet, apiPost } from '../../services/api';
import { Exam, ExamResultRecord, QuestionType, ResultAuditLog, SessionFeedback, Student } from '../../types';

interface ResultsProps {
  exams: Exam[];
  students: Student[];
}

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

export const Results: React.FC<ResultsProps> = ({ exams, students }) => {
  const [results, setResults] = useState<ExamResultRecord[]>([]);
  const [selectedExamId, setSelectedExamId] = useState<string>('ALL');
  const [selectedStudentId, setSelectedStudentId] = useState<string>('ALL');
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
  const [report, setReport] = useState<EnterpriseReport | null>(null);
  const [reportLoading, setReportLoading] = useState(false);
  const [feedback, setFeedback] = useState<Array<SessionFeedback & {
    examTitle?: string;
    studentName?: string;
    registrationId?: string;
    batch?: string | null;
  }>>([]);

  const loadResults = async () => {
    setLoading(true);
    setLoadError('');
    try {
      const data = await apiGet<{ results: ExamResultRecord[] }>('results.php');
      if (data?.results) {
        setResults(data.results);
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Failed to load results.';
      setLoadError(message);
      console.error('Failed to load results:', e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadResults();
  }, []);

  const loadEnterpriseReport = async () => {
    setReportLoading(true);
    try {
      const data = await apiGet<EnterpriseReport>('reports.php');
      setReport(data || null);
    } catch (e) {
      console.error('Failed to load enterprise report:', e);
      setReport(null);
    } finally {
      setReportLoading(false);
    }
  };

  useEffect(() => {
    loadEnterpriseReport();
  }, []);

  useEffect(() => {
    const loadFeedback = async () => {
      try {
        const data = await apiGet<{ feedback: Array<SessionFeedback & {
          examTitle?: string;
          studentName?: string;
          registrationId?: string;
          batch?: string | null;
        }> }>('feedback.php?limit=250');
        setFeedback(data?.feedback || []);
      } catch (e) {
        console.error('Failed to load feedback:', e);
        setFeedback([]);
      }
    };
    loadFeedback();
  }, []);

  useEffect(() => {
    const loadAnalytics = async () => {
      if (selectedExamId === 'ALL') {
        setAnalytics([]);
        return;
      }
      setAnalyticsLoading(true);
      try {
        const data = await apiGet<{ questions: QuestionAnalytics[] }>(`analytics.php?examId=${selectedExamId}`);
        setAnalytics(data?.questions || []);
      } catch (e) {
        console.error('Failed to load analytics:', e);
        setAnalytics([]);
      } finally {
        setAnalyticsLoading(false);
      }
    };
    loadAnalytics();
  }, [selectedExamId]);

  const filteredResults = useMemo(() => {
    const term = search.trim().toLowerCase();
    return results
      .filter(r => (selectedExamId === 'ALL' ? true : r.examId === selectedExamId))
      .filter(r => (selectedStudentId === 'ALL' ? true : r.studentId === selectedStudentId))
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
  }, [results, selectedExamId, selectedStudentId, search, students, exams]);

  const selectedResult = useMemo(() => {
    if (selectedSessionId) {
      return filteredResults.find(r => r.sessionId === selectedSessionId) || null;
    }
    return filteredResults[0] || null;
  }, [filteredResults, selectedSessionId]);

  const loadAudit = async (sessionId: number) => {
    setAuditLoading(true);
    try {
      const data = await apiGet<{ audits: ResultAuditLog[] }>(`results.php?audit=1&sessionId=${sessionId}`);
      if (data?.audits) {
        setAuditLogs(data.audits);
      } else {
        setAuditLogs([]);
      }
    } catch (e) {
      console.error('Failed to load audit logs:', e);
      setAuditLogs([]);
    } finally {
      setAuditLoading(false);
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
    const passRate = completed > 0 ? Math.round((passed / completed) * 100) : 0;

    let topResult: ExamResultRecord | null = null;
    scoredFinals.forEach(r => {
      if (!topResult) {
        topResult = r;
        return;
      }
      if ((r.finalScore || 0) > (topResult.finalScore || 0)) topResult = r;
    });

    return { attempts, avgPercent, passRate, completed, topResult };
  }, [filteredResults]);

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
    const str = String(value);
    if (/[",\n]/.test(str)) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };

  const downloadCsv = (filename: string, rows: string[][]) => {
    const csv = rows.map(r => r.map(csvEscape).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
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
            .brand { display: flex; justify-content: space-between; align-items: start; border-bottom: 3px solid #3558ff; padding-bottom: 14px; }
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
            .bar i { display: block; height: 100%; border-radius: inherit; background: linear-gradient(90deg, #3558ff, #ff6b4a); }
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

    const win = window.open('', '_blank');
    if (!win) return;
    win.document.open();
    win.document.write(html);
    win.document.close();
    win.focus();
    win.print();
  };

  const handleExportFiltered = () => {
    const rows: string[][] = [
      ['Student Name', 'Registration ID', 'Exam Title', 'Attempt', 'Status', 'Score', 'Percent', 'Final Score', 'Final Percent', 'Start Time', 'End Time'],
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
        new Date(result.startTime).toLocaleString(),
        result.endTime ? new Date(result.endTime).toLocaleString() : '',
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
      const isMcq = a.questionType === QuestionType.MCQ;
      const answerText = isMcq
        ? (a.answerOptionIndex !== null && a.answerOptionIndex !== undefined && a.options)
            ? a.options[a.answerOptionIndex] ?? ''
            : ''
        : (a.answerText || '');
      const correctText = isMcq
        ? (a.correctOptionIndex !== null && a.correctOptionIndex !== undefined && a.options)
            ? a.options[a.correctOptionIndex] ?? ''
            : ''
        : '';
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
      const isMcq = a.questionType === QuestionType.MCQ;
      const answerText = isMcq
        ? (a.answerOptionIndex !== null && a.answerOptionIndex !== undefined && a.options)
            ? a.options[a.answerOptionIndex] ?? ''
            : ''
        : (a.answerText || '');
      const correctText = isMcq
        ? (a.correctOptionIndex !== null && a.correctOptionIndex !== undefined && a.options)
            ? a.options[a.correctOptionIndex] ?? ''
            : ''
        : '';
      const awarded = a.awardedMarks === null || a.awardedMarks === undefined ? '' : String(a.awardedMarks);
      const correct = a.isCorrect === null || a.isCorrect === undefined ? '' : (a.isCorrect ? 'Yes' : 'No');
      return `
        <tr>
          <td>${idx + 1}</td>
          <td>${escapeHtml(a.questionText)}</td>
          <td>${a.questionType}</td>
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

    const win = window.open('', '_blank');
    if (!win) return;
    win.document.open();
    win.document.write(html);
    win.document.close();
    win.focus();
    win.print();
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
      .filter(Boolean);

    if (changes.length === 0) {
      setEditMode(false);
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
    } catch (e) {
      console.error('Failed to save regrade:', e);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h2 className="lsc-title flex items-center gap-2">
            <FileText size={20} className="text-[#3558ff]" /> Results Analysis
          </h2>
          <p className="lsc-subtitle mt-1">Filter by exam or student to review marks and answer sheets.</p>
        </div>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className="relative">
            <Search className="absolute left-3 top-2.5 text-slate-400" size={16} />
            <input
              type="text"
              placeholder="Search student or exam..."
              className="pl-9 pr-4 py-2 border border-slate-200 rounded-lg outline-none w-full sm:w-64 text-sm bg-white"
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </div>
          <button
            onClick={handleExportFiltered}
            className="px-3 py-2 lsc-button-ghost text-sm"
          >
            <Download size={14} className="inline mr-1" /> CSV
          </button>
          <button
            onClick={handleExportEnterpriseReportPdf}
            disabled={!report}
            className="px-3 py-2 lsc-button-primary text-sm disabled:opacity-50"
          >
            <FileText size={14} className="inline mr-1" /> Report PDF
          </button>
        </div>
      </div>
      {loadError && (
        <div className="lsc-panel p-3 text-sm text-rose-700 bg-rose-50 border border-rose-200">
          Failed to load results. {loadError}
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="lsc-panel p-4 h-full">
          <div className="text-xs uppercase tracking-widest text-slate-400">Attempts</div>
          <div className="text-2xl font-semibold text-slate-900 mt-1">{summary.attempts}</div>
          <div className="text-xs text-slate-500 mt-2">Completed: {summary.completed}</div>
        </div>
        <div className="lsc-panel p-4 h-full">
          <div className="text-xs uppercase tracking-widest text-slate-400">Final Average Score</div>
          <div className="text-2xl font-semibold text-slate-900 mt-1">{summary.avgPercent}%</div>
          <div className="text-xs text-slate-500 mt-2">Pass rate: {summary.passRate}%</div>
        </div>
        <div className="lsc-panel p-4 h-full">
          <div className="text-xs uppercase tracking-widest text-slate-400">Top Performer</div>
          <div className="text-base font-semibold text-slate-900 mt-1">
            {summary.topResult ? (students.find(s => s.id === summary.topResult?.studentId)?.fullName || summary.topResult?.studentId) : '-'}
          </div>
          <div className="text-xs text-slate-500 mt-2">
            {summary.topResult ? `${formatFinalScore(summary.topResult)} (${formatFinalPercent(summary.topResult)})` : 'No results yet'}
          </div>
        </div>
      </div>

      <div className="lsc-panel overflow-hidden">
        <div className="p-4 lsc-panel-header flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="text-sm font-semibold text-slate-800 flex items-center gap-2">
              <BarChart3 size={16} className="text-[#3558ff]" /> Enterprise Reports
            </div>
            <div className="text-xs text-slate-500 mt-1">
              Batch-wise, student-wise, exam-wise, and violation analytics for compliance review.
            </div>
          </div>
          <button
            onClick={loadEnterpriseReport}
            disabled={reportLoading}
            className="px-3 py-2 rounded-lg border border-slate-200 text-xs font-semibold text-slate-600 hover:bg-slate-50 disabled:opacity-50"
          >
            {reportLoading ? 'Refreshing...' : 'Refresh Report'}
          </button>
        </div>
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
                rows={report.byBatch.slice(0, 8).map(row => [
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
                rows={report.byExam.slice(0, 8).map(row => [
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
                  <ShieldAlert size={15} className="text-[#d94f34]" /> Violation Types
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
                            className="h-full rounded-full bg-[linear-gradient(90deg,#3558ff,#ff6b4a)]"
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
                rows={report.byStudent.slice(0, 8).map(row => [
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
              rows={feedback.slice(0, 8).map(item => [
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

      {selectedExamId !== 'ALL' && (
        <div className="lsc-panel overflow-hidden">
          <div className="p-4 lsc-panel-header flex items-center justify-between">
            <div className="text-sm font-semibold text-slate-800">Question Analytics</div>
            <div className="text-xs text-slate-500">
              {exams.find(e => e.id === selectedExamId)?.title || selectedExamId}
            </div>
          </div>
          <div className="p-4">
            {analyticsLoading && (
              <div className="text-xs text-slate-400">Loading analytics...</div>
            )}
            {!analyticsLoading && analytics.length === 0 && (
              <div className="text-xs text-slate-400">No analytics data yet.</div>
            )}
            {!analyticsLoading && analytics.length > 0 && (
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
                    {analytics.map(item => (
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
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 xl:grid-cols-[360px_1fr] gap-6">
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
          <div className="p-4 border-b border-slate-200 bg-slate-50 space-y-3">
            <div className="text-sm font-semibold text-slate-800">Filters</div>
            <div className="space-y-2">
              <select
                value={selectedExamId}
                onChange={e => setSelectedExamId(e.target.value)}
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
                className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm outline-none bg-white"
              >
                <option value="ALL">All Students</option>
                {students.map(student => (
                  <option key={student.id} value={student.id}>{student.fullName}</option>
                ))}
              </select>
            </div>
          </div>
          <div className="p-4 space-y-3 max-h-[640px] overflow-y-auto">
            {loading && (
              <div className="text-xs text-slate-400">Loading results...</div>
            )}
            {!loading && filteredResults.length === 0 && (
              <div className="text-xs text-slate-400">No results found.</div>
            )}
            {!loading && filteredResults.map(result => {
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
                </button>
              );
            })}
          </div>
        </div>

        <div className="lsc-panel overflow-hidden">
          <div className="p-4 lsc-panel-header flex items-center justify-between">
            <div className="text-sm font-semibold text-slate-800 flex items-center gap-2">
              <Award size={16} className="text-[#3558ff]" /> Answer Sheet
            </div>
            <div className="flex items-center gap-3">
              {selectedResult && (
                <div className="text-xs text-slate-500">
                  Attempt {selectedResult.attemptIndex || 1}
                  {selectedResult.attemptCount ? `/${selectedResult.attemptCount}` : ''} -
                  Score {formatScore(selectedResult)} ({formatPercent(selectedResult)}) -
                  Final {formatFinalScore(selectedResult)} ({formatFinalPercent(selectedResult)})
                </div>
              )}
              {selectedResult && !editMode && (
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
              {selectedResult && editMode && (
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
            </div>
          </div>
          {!selectedResult && (
            <div className="p-6 text-sm text-slate-400">Select a result to view the answer sheet.</div>
          )}
          {selectedResult && (
            <div className="p-6 space-y-4 max-h-[640px] overflow-y-auto">
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
                    <label className="text-[11px] uppercase tracking-widest text-slate-400">Graded By</label>
                    <input
                      type="text"
                      className="mt-1 w-full px-3 py-2 border border-slate-200 rounded-lg text-sm outline-none"
                      value={graderName}
                      onChange={e => setGraderName(e.target.value)}
                      placeholder="Admin name"
                    />
                  </div>
                  <div>
                    <label className="text-[11px] uppercase tracking-widest text-slate-400">Regrade Note</label>
                    <input
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
                const isMcq = answer.questionType === QuestionType.MCQ;
                const selectedIdx = answer.answerOptionIndex;
                const correctIdx = answer.correctOptionIndex;
                const awardedText = isMcq
                  ? `${answer.awardedMarks ?? 0}`
                  : (answer.awardedMarks === null || answer.awardedMarks === undefined ? 'Pending' : `${answer.awardedMarks}`);
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
                      <div className="mt-3 border border-slate-200 rounded-lg p-3 bg-slate-50 text-sm text-slate-700">
                        {answer.answerText || 'No response provided.'}
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
}: {
  title: string;
  headers: string[];
  rows: string[][];
  empty: string;
}) => (
  <div className="rounded-lg border border-slate-200 overflow-hidden bg-white">
    <div className="px-4 py-3 border-b border-slate-200 text-sm font-semibold text-slate-800">{title}</div>
    {rows.length === 0 ? (
      <div className="p-4 text-xs text-slate-400">{empty}</div>
    ) : (
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
            {rows.map((row, idx) => (
              <tr key={`${title}-${idx}`} className="text-slate-700">
                {row.map((cell, cellIdx) => (
                  <td key={`${title}-${idx}-${cellIdx}`} className="px-3 py-2 max-w-[220px] truncate" title={cell}>
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )}
  </div>
);
