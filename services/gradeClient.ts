import { Question, QuestionType, isManualGraded } from '../types';

export type LocalGrade = 'correct' | 'incorrect' | 'pending' | 'unanswered';

const norm = (s: any): string => String(s ?? '').trim().toLowerCase();
const isEmpty = (v: any): boolean =>
  v === undefined || v === null || v === '' ||
  (Array.isArray(v) && v.length === 0) ||
  (typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0);

/**
 * Client-side mirror of the server grader (api/_bootstrap.php grade_question) used only for the
 * candidate's immediate result preview. The server remains the source of truth. All-or-nothing.
 */
export const gradeLocalAnswer = (q: Question, answer: any): LocalGrade => {
  if (isManualGraded(q.type)) return 'pending';
  if (isEmpty(answer)) return 'unanswered';
  const key = q.answerKey || {};
  const match = q.matchOptions || {};
  let ok = false;

  switch (q.type) {
    case QuestionType.MCQ:
    case QuestionType.TRUE_FALSE:
    case QuestionType.YES_NO:
      ok = Number(answer) === q.correctOptionIndex;
      break;
    case QuestionType.MULTI_SELECT: {
      const picked = [...(answer as number[])].map(Number).sort((a, b) => a - b);
      const exp = [...(key.correctIndices || [])].map(Number).sort((a, b) => a - b);
      ok = picked.length === exp.length && picked.every((v, i) => v === exp[i]);
      break;
    }
    case QuestionType.FILL_BLANK: {
      const blanks = key.blanks || [];
      ok = blanks.length > 0 && blanks.every((b, i) =>
        b.accepted.map(norm).includes(norm((answer as string[])[i])));
      break;
    }
    case QuestionType.NUMERIC: {
      if (key.value === undefined || isNaN(Number(answer))) { ok = false; break; }
      const tol = key.tolerance != null ? Math.abs(Number(key.tolerance)) : 0;
      ok = Math.abs(Number(answer) - Number(key.value)) <= tol + 1e-9;
      break;
    }
    case QuestionType.DATE:
    case QuestionType.TIME:
      ok = norm(answer) === norm(key.value);
      break;
    case QuestionType.MATCHING: {
      const pairs = key.pairs || {};
      const map = answer as Record<number, number>;
      const keys = Object.keys(pairs);
      ok = keys.length === Object.keys(map).length &&
        keys.every(k => Number(map[Number(k)]) === Number(pairs[Number(k)]));
      break;
    }
    case QuestionType.ORDERING: {
      const order = key.order || [];
      const ans = answer as number[];
      ok = ans.length === order.length && ans.every((v, i) => Number(v) === Number(order[i]));
      break;
    }
    case QuestionType.DRAG_DROP: {
      const placements = key.placements || {};
      const map = answer as Record<number, number>;
      const keys = Object.keys(placements);
      ok = keys.length === Object.keys(map).length &&
        keys.every(k => Number(map[Number(k)]) === Number(placements[Number(k)]));
      break;
    }
    default:
      return 'pending';
  }
  return ok ? 'correct' : 'incorrect';
};

/** Human-readable "your answer" / "correct answer" for the non-option types in the preview. */
export const formatLocalAnswer = (q: Question, answer: any): { yours: string; correct: string } => {
  const match = q.matchOptions || {};
  const key = q.answerKey || {};
  switch (q.type) {
    case QuestionType.MULTI_SELECT:
      return {
        yours: Array.isArray(answer) ? answer.map((i: number) => q.options?.[i] ?? '—').join(', ') : '—',
        correct: (key.correctIndices || []).map(i => q.options?.[i] ?? '—').join(', '),
      };
    case QuestionType.FILL_BLANK:
      return {
        yours: Array.isArray(answer) ? answer.map((s: string) => s || '—').join(' | ') : '—',
        correct: (key.blanks || []).map(b => b.accepted.join(' / ')).join(' | '),
      };
    case QuestionType.NUMERIC:
      return { yours: String(answer ?? '—'), correct: `${key.value}${key.tolerance != null ? ` ± ${key.tolerance}` : ''}` };
    case QuestionType.DATE:
    case QuestionType.TIME:
      return { yours: String(answer ?? '—'), correct: String(key.value ?? '—') };
    case QuestionType.MATCHING: {
      const left = match.left || [], right = match.right || [];
      const map = (answer && typeof answer === 'object') ? answer : {};
      return {
        yours: left.map((l, i) => `${l} → ${right[map[i]] ?? '—'}`).join('; '),
        correct: left.map((l, i) => `${l} → ${right[i] ?? '—'}`).join('; '),
      };
    }
    case QuestionType.ORDERING: {
      const items = match.items || [];
      const order = Array.isArray(answer) ? answer : [];
      return { yours: order.map((i: number) => items[i] ?? '—').join(' → '), correct: items.join(' → ') };
    }
    case QuestionType.DRAG_DROP: {
      const items = match.items || [], buckets = match.buckets || [];
      const map = (answer && typeof answer === 'object') ? answer : {};
      const placements = key.placements || {};
      return {
        yours: items.map((it, i) => `${it} → ${buckets[map[i]] ?? '—'}`).join('; '),
        correct: items.map((it, i) => `${it} → ${buckets[placements[i]] ?? '—'}`).join('; '),
      };
    }
    default:
      return { yours: String(answer ?? '—'), correct: '—' };
  }
};
