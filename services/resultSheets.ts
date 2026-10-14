// Excel sheets behind the Results screen's downloads: Results, Attendance, and the exam workbook
// (Dashboard + Results + Attendance in one file). Every count and mark is a real number cell (see
// xlsxExport.ts), so nothing is re-read as a date.
import { Exam, ExamResultRecord, ResultAnswer, Student } from '../types';
import { formatScheduleShort, resolveExamTimezone } from './timezone';
import { XlsxCell, XlsxSheet } from './xlsxExport';

/** "+91 98765 43210" for an Indian number, "+<digits>" for any other; '' when there is none. */
export const formatContactNumber = (mobile?: string | null): string => {
  const digits = String(mobile ?? '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.length === 12 && digits.startsWith('91')) return `+91 ${digits.slice(2, 7)} ${digits.slice(7)}`;
  return `+${digits}`;
};

/** Same test as api/results.php's answeredCount: the candidate left some response on the question. */
const isAnswered = (a: ResultAnswer): boolean => {
  if (a.answerOptionIndex !== null && a.answerOptionIndex !== undefined) return true;
  if (a.answerText !== null && a.answerText !== undefined && a.answerText !== '') return true;
  const json = a.answerJson;
  if (json === null || json === undefined) return false;
  if (Array.isArray(json)) return json.length > 0;
  if (typeof json === 'object') return Object.keys(json).length > 0;
  return json !== '';
};

/** Questions on the paper when an attempt has no answer rows at all (ended before the first save). */
const paperSize = (exam?: Exam): number => {
  if (!exam) return 0;
  const sections = exam.sections || [];
  if (sections.length > 0) {
    return sections.reduce((sum, s) => {
      const pool = s.questions?.length || 0;
      return sum + (s.questionLimit > 0 ? Math.min(s.questionLimit, pool) : pool);
    }, 0);
  }
  const pool = exam.questions?.length || 0;
  if (exam.questionCount && exam.questionCount > 0) return pool > 0 ? Math.min(exam.questionCount, pool) : exam.questionCount;
  return pool;
};

export interface AnswerCounts {
  total: number;
  correct: number;
  /** Answered and marked wrong. */
  incorrect: number;
  /** Answered, but not marked right or wrong yet (manually graded questions). */
  awaitingReview: number;
  notAnswered: number;
}

/** Correct + incorrect + awaiting review + not answered always adds up to total. */
export const answerCounts = (r: ExamResultRecord, exam?: Exam): AnswerCounts => {
  const answers = r.answers || [];
  let correct = 0;
  let incorrect = 0;
  let awaitingReview = 0;
  answers.forEach(a => {
    if (a.isCorrect === true) correct++;
    else if (!isAnswered(a)) return;
    else if (a.isCorrect === false) incorrect++;
    else awaitingReview++;
  });
  const total = answers.length > 0 ? answers.length : paperSize(exam);
  return { total, correct, incorrect, awaitingReview, notAnswered: Math.max(0, total - correct - incorrect - awaitingReview) };
};

/**
 * The candidate never pressed Submit: the page was closed (or the connection lost) and the server
 * closed the attempt when its time ran out, grading the answers saved by then (api/results.php).
 * At or above the pass mark it is COMPLETED (a pass); below it, TERMINATED with this reason.
 */
const NOT_SUBMITTED_REASON = /^Not submitted/i;
export const isNotSubmitted = (r: ExamResultRecord): boolean =>
  (r.status === 'COMPLETED' && !!r.terminationReason) || (r.status === 'TERMINATED' && NOT_SUBMITTED_REASON.test(r.terminationReason || ''));

export const statusLabel = (r: ExamResultRecord): string => {
  if (r.status === 'COMPLETED') return isNotSubmitted(r) ? 'Completed (not submitted, time ran out)' : 'Completed';
  if (r.status === 'TERMINATED') return isNotSubmitted(r) ? 'Terminated (not submitted, time ran out)' : 'Terminated';
  if (r.status === 'IN_PROGRESS') return 'In progress';
  return r.status;
};

export const resultLabel = (r: ExamResultRecord): string => {
  if (r.status === 'IN_PROGRESS') return 'In progress';
  if (r.finalPassed === null || r.finalPassed === undefined) return 'Pending';
  return r.finalPassed ? 'PASS' : 'FAIL';
};

const scoreFraction = (r: ExamResultRecord): number | null =>
  r.status !== 'IN_PROGRESS' && r.finalMaxScore && r.finalMaxScore > 0 && r.finalScore !== null && r.finalScore !== undefined
    ? r.finalScore / r.finalMaxScore
    : null;

const minutesTaken = (r: ExamResultRecord): number | null =>
  r.endTime && r.startTime && r.endTime > r.startTime ? Math.round((r.endTime - r.startTime) / 6000) / 10 : null;

/** Earliest start first; same start → earliest end first. */
export const byStartTime = (a: ExamResultRecord, b: ExamResultRecord): number =>
  (a.startTime || 0) - (b.startTime || 0) || (a.endTime || Infinity) - (b.endTime || Infinity);

const header = (labels: string[]): XlsxCell[] => labels.map(value => ({ value, style: 'header' as const }));
const percent = (value: number | null): XlsxCell => (value === null ? null : { value, style: 'percent' });

/** One row per attempt, earliest start first. */
export const resultsSheet = (rows: ExamResultRecord[], students: Student[], exams: Exam[]): XlsxSheet => {
  const studentById = new Map(students.map(s => [s.id, s]));
  const examById = new Map(exams.map(e => [e.id, e]));
  const counted = [...rows].sort(byStartTime).map(r => ({ r, counts: answerCounts(r, examById.get(r.examId)) }));
  // Only shown when some attempt has manually graded answers still open, so the counts add up.
  const showReview = counted.some(x => x.counts.awaitingReview > 0);

  const head = header([
    'S.No', 'Student Name', 'Registration ID', 'Contact Number', 'Exam', 'Attempt No.', 'Total Attempts',
    'Status', 'Result', 'Marks Obtained', 'Total Marks', 'Percentage', 'Total Questions', 'Answered',
    'Correct', 'Incorrect', ...(showReview ? ['Awaiting Review'] : []), 'Not Answered',
    'Started', 'Ended', 'Time Taken (min)', 'Termination Reason',
  ]);

  const body = counted.map(({ r, counts }, i): XlsxCell[] => {
    const student = studentById.get(r.studentId);
    const exam = examById.get(r.examId);
    const tz = resolveExamTimezone(exam?.timezone);
    const fraction = scoreFraction(r);
    return [
      i + 1,
      student?.fullName || r.studentId,
      student?.registrationId || '',
      formatContactNumber(student?.mobile),
      exam?.title || r.examId,
      r.attemptIndex || 1,
      r.attemptCount || 1,
      statusLabel(r),
      resultLabel(r),
      fraction === null ? null : Math.round((r.finalScore as number) * 100) / 100,
      fraction === null ? null : (r.finalMaxScore as number),
      percent(fraction),
      counts.total,
      counts.correct + counts.incorrect + counts.awaitingReview,
      counts.correct,
      counts.incorrect,
      ...(showReview ? [counts.awaitingReview] : []),
      counts.notAnswered,
      r.startTime ? formatScheduleShort(r.startTime, tz) : '',
      r.endTime ? formatScheduleShort(r.endTime, tz) : '',
      minutesTaken(r),
      r.status === 'TERMINATED' ? (r.terminationReason || 'Not recorded') : '',
    ];
  });

  return { name: 'Results', rows: [head, ...body], headerRow: 1 };
};

/** Everyone assigned to the exam (directly or through a batch) plus anyone who started it. */
export interface AttendanceRow {
  exam: Exam;
  student: Student;
  appeared: boolean;
  /** First attempt's start and the latest attempt's end, when the candidate appeared. */
  startTime: number | null;
  endTime: number | null;
}

export const attendanceRows = (exam: Exam, students: Student[], results: ExamResultRecord[]): AttendanceRow[] => {
  const assignedIds = new Set(exam.assignedStudentIds || []);
  const assignedBatches = new Set((exam.assignedBatchIds || []).map(Number));
  // Any attempt at all counts as appeared: completed, terminated or still running.
  const attempts = new Map<string, ExamResultRecord[]>();
  results.filter(r => r.examId === exam.id).forEach(r => {
    attempts.set(r.studentId, [...(attempts.get(r.studentId) || []), r]);
  });
  return students
    .filter(s => attempts.has(s.id) || assignedIds.has(s.id) || (s.batches || []).some(b => assignedBatches.has(Number(b.id))))
    .map(student => {
      const mine = attempts.get(student.id) || [];
      const starts = mine.map(r => r.startTime).filter((t): t is number => !!t);
      const ends = mine.map(r => r.endTime).filter((t): t is number => !!t);
      return {
        exam,
        student,
        appeared: mine.length > 0,
        startTime: starts.length ? Math.min(...starts) : null,
        endTime: ends.length && ends.length === mine.length ? Math.max(...ends) : null,
      };
    })
    // Candidates who appeared in the order they started, then everyone who did not, by name.
    .sort((a, b) => {
      if (a.appeared !== b.appeared) return a.appeared ? -1 : 1;
      if (a.appeared) return (a.startTime || 0) - (b.startTime || 0) || (a.endTime || Infinity) - (b.endTime || Infinity);
      return a.student.fullName.localeCompare(b.student.fullName);
    });
};

/** One exam: its title and window on top. Several exams: one list with an Exam column. */
export const attendanceSheet = (exams: Exam[], rows: AttendanceRow[]): XlsxSheet => {
  const single = exams.length === 1 ? exams[0] : null;
  const appearedCount = rows.filter(r => r.appeared).length;
  const tzOf = (exam: Exam) => resolveExamTimezone(exam.timezone);
  const top: XlsxCell[][] = single
    ? [
      [{ value: single.title, style: 'title' }],
      [single.startTime && single.endTime
        ? `Exam window: ${formatScheduleShort(single.startTime, tzOf(single))} to ${formatScheduleShort(single.endTime, tzOf(single))}`
        : ''],
    ]
    : [[{ value: `Attendance: ${exams.length} exams`, style: 'title' }], ['']];
  const head = header([
    'S.No', ...(single ? [] : ['Exam']), 'Candidate Name', 'Registration ID', 'Contact Number', 'Attendance Status', 'Started', 'Ended',
  ]);
  return {
    name: 'Attendance',
    rows: [
      ...top,
      [`Total candidates: ${rows.length}`],
      [`Appeared: ${appearedCount}`],
      [`Not appeared: ${rows.length - appearedCount}`],
      [],
      head,
      ...rows.map((r, i): XlsxCell[] => [
        i + 1,
        ...(single ? [] : [r.exam.title]),
        r.student.fullName,
        r.student.registrationId || '',
        formatContactNumber(r.student.mobile),
        r.appeared ? 'Appeared' : 'Not Appeared',
        r.startTime ? formatScheduleShort(r.startTime, tzOf(r.exam)) : '',
        r.endTime ? formatScheduleShort(r.endTime, tzOf(r.exam)) : '',
      ]),
    ],
    headerRow: 7,
  };
};

// ---------------------------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------------------------

/** The attempt that counts for a candidate on an exam: the latest one (attempt policy LAST). */
const finalAttempts = (results: ExamResultRecord[]): ExamResultRecord[] => {
  const latest = new Map<string, ExamResultRecord>();
  results.forEach(r => {
    const key = `${r.examId}|${r.studentId}`;
    const prev = latest.get(key);
    if (!prev || (r.startTime || 0) > (prev.startTime || 0)) latest.set(key, r);
  });
  return [...latest.values()];
};

interface ExamStats {
  candidates: number;
  appeared: number;
  attempts: number;
  submitted: number;
  /** Not submitted, reached the pass mark: completed. */
  notSubmittedPassed: number;
  /** Not submitted, below the pass mark: terminated. */
  notSubmittedFailed: number;
  /** Every terminated attempt, including notSubmittedFailed. */
  terminated: number;
  inProgress: number;
  passed: number;
  failed: number;
  pending: number;
  avg: number | null;
  highest: number | null;
  lowest: number | null;
  avgCorrect: number | null;
  avgIncorrect: number | null;
  avgNotAnswered: number | null;
  avgMinutes: number | null;
  /** Final attempts with a score, per 10% band (index 9 holds 90-100%). */
  bands: number[];
}

const mean = (values: number[]): number | null =>
  values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
const round1 = (value: number | null): number | null => (value === null ? null : Math.round(value * 10) / 10);

const examStats = (exams: Exam[], attendance: AttendanceRow[], results: ExamResultRecord[]): ExamStats => {
  const examById = new Map(exams.map(e => [e.id, e]));
  const finals = finalAttempts(results);
  const decided = finals.filter(r => r.status !== 'IN_PROGRESS');
  const scored = decided.map(scoreFraction).filter((x): x is number => x !== null);
  const counts = decided.map(r => answerCounts(r, examById.get(r.examId)));
  const bands = new Array(10).fill(0);
  scored.forEach(f => { bands[Math.min(9, Math.floor(f * 10 + 1e-9))]++; });
  return {
    candidates: attendance.length,
    appeared: attendance.filter(r => r.appeared).length,
    attempts: results.length,
    submitted: results.filter(r => r.status === 'COMPLETED' && !isNotSubmitted(r)).length,
    notSubmittedPassed: results.filter(r => r.status === 'COMPLETED' && isNotSubmitted(r)).length,
    notSubmittedFailed: results.filter(r => r.status === 'TERMINATED' && isNotSubmitted(r)).length,
    terminated: results.filter(r => r.status === 'TERMINATED').length,
    inProgress: results.filter(r => r.status === 'IN_PROGRESS').length,
    passed: decided.filter(r => resultLabel(r) === 'PASS').length,
    failed: decided.filter(r => resultLabel(r) === 'FAIL').length,
    pending: decided.filter(r => resultLabel(r) === 'Pending').length,
    avg: mean(scored),
    highest: scored.length ? Math.max(...scored) : null,
    lowest: scored.length ? Math.min(...scored) : null,
    avgCorrect: round1(mean(counts.map(c => c.correct))),
    avgIncorrect: round1(mean(counts.map(c => c.incorrect))),
    avgNotAnswered: round1(mean(counts.map(c => c.notAnswered))),
    avgMinutes: round1(mean(decided.map(minutesTaken).filter((x): x is number => x !== null))),
    bands,
  };
};

const rate = (part: number, whole: number): number | null => (whole > 0 ? part / whole : null);

export const dashboardSheet = (exams: Exam[], attendanceByExam: Map<string, AttendanceRow[]>, results: ExamResultRecord[]): XlsxSheet => {
  const single = exams.length === 1 ? exams[0] : null;
  const allAttendance = exams.flatMap(e => attendanceByExam.get(e.id) || []);
  const all = examStats(exams, allAttendance, results);
  const tz = resolveExamTimezone(single?.timezone);
  const label = (value: string): XlsxCell => ({ value, style: 'header' });

  const overview: Array<[string, XlsxCell]> = [
    ...(single ? [] : [['Exams', exams.length] as [string, XlsxCell]]),
    ['Candidates assigned', all.candidates],
    ['Appeared', all.appeared],
    ['Not appeared', all.candidates - all.appeared],
    ['Attendance rate', percent(rate(all.appeared, all.candidates))],
    ['Attempts (including re-attempts)', all.attempts],
    ['Completed (submitted)', all.submitted],
    ['Completed (not submitted, time ran out, passed)', all.notSubmittedPassed],
    ['Terminated (not submitted, time ran out, below pass mark)', all.notSubmittedFailed],
    ['Terminated (violations and other reasons)', all.terminated - all.notSubmittedFailed],
    ['In progress', all.inProgress],
    ['Passed', all.passed],
    ['Failed', all.failed],
    ...(all.pending ? [['Awaiting result', all.pending] as [string, XlsxCell]] : []),
    ['Pass rate (of passed + failed)', percent(rate(all.passed, all.passed + all.failed))],
    ['Average score', percent(all.avg)],
    ['Highest score', percent(all.highest)],
    ['Lowest score', percent(all.lowest)],
    ['Average correct answers', all.avgCorrect],
    ['Average incorrect answers', all.avgIncorrect],
    ['Average not answered', all.avgNotAnswered],
    ['Average time taken (min)', all.avgMinutes],
  ];

  const scoredCount = all.bands.reduce((a, b) => a + b, 0);
  const bandRows: XlsxCell[][] = all.bands.map((n, i) => [
    i === 9 ? '90% to 100%' : `${i * 10}% to ${i * 10 + 9}%`, n, percent(rate(n, scoredCount)),
  ]);

  const byExam: XlsxCell[][] = exams.map(exam => {
    const att = attendanceByExam.get(exam.id) || [];
    const st = examStats([exam], att, results.filter(r => r.examId === exam.id));
    const etz = resolveExamTimezone(exam.timezone);
    return [
      exam.title,
      exam.startTime ? formatScheduleShort(exam.startTime, etz) : '',
      exam.endTime ? formatScheduleShort(exam.endTime, etz) : '',
      exam.durationMinutes || null,
      st.candidates, st.appeared, st.candidates - st.appeared, percent(rate(st.appeared, st.candidates)),
      st.passed, st.failed, percent(rate(st.passed, st.passed + st.failed)),
      st.notSubmittedPassed + st.notSubmittedFailed, st.terminated, percent(st.avg), percent(st.highest), percent(st.lowest),
    ];
  });

  return {
    name: 'Dashboard',
    rows: [
      [{ value: single ? single.title : 'Exam Dashboard', style: 'title' }],
      [`Generated ${formatScheduleShort(Date.now(), tz)}. Pass, fail and scores count each candidate's latest attempt.`],
      [],
      [label('Overview'), label('Value')],
      ...overview.map(([name, value]) => [name, value]),
      [],
      [label('Score range'), label('Candidates'), label('Share')],
      ...bandRows,
      [],
      [label('Exam'), label('Starts'), label('Ends'), label('Duration (min)'), label('Assigned'), label('Appeared'),
        label('Not appeared'), label('Attendance'), label('Passed'), label('Failed'), label('Pass rate'),
        label('Not submitted'), label('Terminated'), label('Average'), label('Highest'), label('Lowest')],
      ...byExam,
    ],
    widths: [42, 34, 34, 15, 11, 11, 13, 12, 9, 9, 11, 14, 12, 10, 10, 10],
  };
};

/** Dashboard + Results + Attendance for the given exams, as one workbook. */
export const examWorkbookSheets = (examList: Exam[], students: Student[], results: ExamResultRecord[]): XlsxSheet[] => {
  const attendanceByExam = new Map(examList.map(e => [e.id, attendanceRows(e, students, results)]));
  // Across several exams, leave out the ones nobody is assigned to or has taken; earliest first.
  const exams = (examList.length > 1 ? examList.filter(e => (attendanceByExam.get(e.id) || []).length > 0) : examList)
    .slice().sort((a, b) => (a.startTime || 0) - (b.startTime || 0));
  const examIds = new Set(exams.map(e => e.id));
  const examResults = results.filter(r => examIds.has(r.examId));
  return [
    dashboardSheet(exams, attendanceByExam, examResults),
    resultsSheet(examResults, students, exams),
    attendanceSheet(exams, exams.flatMap(e => attendanceByExam.get(e.id) || [])),
  ];
};
