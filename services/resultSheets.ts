// Excel sheets behind the Results screen's "Results (Excel)" and "Attendance (Excel)" downloads.
// Every count and mark is a real number cell (see xlsxExport.ts), so nothing is re-read as a date.
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

const STATUS_LABEL: Record<string, string> = {
  COMPLETED: 'Completed',
  TERMINATED: 'Terminated',
  IN_PROGRESS: 'In progress',
};

const resultLabel = (r: ExamResultRecord): string => {
  if (r.status === 'IN_PROGRESS') return 'In progress';
  if (r.finalPassed === null || r.finalPassed === undefined) return 'Pending';
  return r.finalPassed ? 'PASS' : 'FAIL';
};

/** One row per attempt, in the order given (the filtered Results table). */
export const resultsSheet = (rows: ExamResultRecord[], students: Student[], exams: Exam[]): XlsxSheet => {
  const studentById = new Map(students.map(s => [s.id, s]));
  const examById = new Map(exams.map(e => [e.id, e]));
  const counted = rows.map(r => ({ r, counts: answerCounts(r, examById.get(r.examId)) }));
  // Only shown when some attempt has manually graded answers still open, so the counts add up.
  const showReview = counted.some(x => x.counts.awaitingReview > 0);

  const header: XlsxCell[] = [
    'S.No', 'Student Name', 'Registration ID', 'Contact Number', 'Exam', 'Attempt No.', 'Total Attempts',
    'Status', 'Result', 'Marks Obtained', 'Total Marks', 'Percentage', 'Total Questions', 'Answered',
    'Correct', 'Incorrect', ...(showReview ? ['Awaiting Review'] : []), 'Not Answered',
    'Started', 'Ended', 'Termination Reason',
  ].map(value => ({ value, style: 'header' as const }));

  const body = counted.map(({ r, counts }, i): XlsxCell[] => {
    const student = studentById.get(r.studentId);
    const exam = examById.get(r.examId);
    const tz = resolveExamTimezone(exam?.timezone);
    const scored = r.finalMaxScore !== null && r.finalMaxScore !== undefined && r.finalMaxScore > 0
      && r.finalScore !== null && r.finalScore !== undefined;
    const reason = r.status === 'TERMINATED' ? (r.terminationReason || 'Not recorded') : '';
    return [
      i + 1,
      student?.fullName || r.studentId,
      student?.registrationId || '',
      formatContactNumber(student?.mobile),
      exam?.title || r.examId,
      r.attemptIndex || 1,
      r.attemptCount || 1,
      STATUS_LABEL[r.status] || r.status,
      resultLabel(r),
      scored ? Math.round((r.finalScore as number) * 100) / 100 : null,
      scored ? (r.finalMaxScore as number) : null,
      scored ? { value: (r.finalScore as number) / (r.finalMaxScore as number), style: 'percent' } : null,
      counts.total,
      counts.correct + counts.incorrect + counts.awaitingReview,
      counts.correct,
      counts.incorrect,
      ...(showReview ? [counts.awaitingReview] : []),
      counts.notAnswered,
      r.startTime ? formatScheduleShort(r.startTime, tz) : '',
      r.endTime ? formatScheduleShort(r.endTime, tz) : '',
      reason,
    ];
  });

  return { name: 'Results', rows: [header, ...body], headerRow: 1 };
};

/** Everyone assigned to the exam (directly or through a batch) plus anyone who started it. */
export interface AttendanceRow {
  student: Student;
  appeared: boolean;
}

export const attendanceRows = (exam: Exam, students: Student[], results: ExamResultRecord[]): AttendanceRow[] => {
  const assignedIds = new Set(exam.assignedStudentIds || []);
  const assignedBatches = new Set((exam.assignedBatchIds || []).map(Number));
  // Any attempt at all counts as appeared: completed, terminated or still running.
  const appeared = new Set(results.filter(r => r.examId === exam.id).map(r => r.studentId));
  return students
    .filter(s => appeared.has(s.id) || assignedIds.has(s.id) || (s.batches || []).some(b => assignedBatches.has(Number(b.id))))
    .map(student => ({ student, appeared: appeared.has(student.id) }))
    .sort((a, b) => a.student.fullName.localeCompare(b.student.fullName));
};

export const attendanceSheet = (exam: Exam, rows: AttendanceRow[]): XlsxSheet => {
  const tz = resolveExamTimezone(exam.timezone);
  const appearedCount = rows.filter(r => r.appeared).length;
  const window = exam.startTime && exam.endTime
    ? `Exam window: ${formatScheduleShort(exam.startTime, tz)} to ${formatScheduleShort(exam.endTime, tz)}`
    : '';
  const header: XlsxCell[] = ['S.No', 'Candidate Name', 'Registration ID', 'Contact Number', 'Attendance Status']
    .map(value => ({ value, style: 'header' as const }));
  return {
    name: 'Attendance',
    rows: [
      [{ value: exam.title, style: 'title' }],
      [window],
      [`Total candidates: ${rows.length}`],
      [`Appeared: ${appearedCount}`],
      [`Not appeared: ${rows.length - appearedCount}`],
      [],
      header,
      ...rows.map((r, i): XlsxCell[] => [
        i + 1,
        r.student.fullName,
        r.student.registrationId || '',
        formatContactNumber(r.student.mobile),
        r.appeared ? 'Appeared' : 'Not Appeared',
      ]),
    ],
    headerRow: 7,
  };
};
