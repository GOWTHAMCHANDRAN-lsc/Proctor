import { Question, QuestionType } from '../types';

/**
 * The candidate's own answer as readable text, for the result review. Uses only what the candidate
 * was shown (their copy has no answer keys — see exam_candidate_question_view in api/_bootstrap.php);
 * whether it was right comes from the server (CandidateResult.grades).
 */
export const formatCandidateAnswer = (q: Question, answer: any): string => {
  const match = q.matchOptions || {};
  switch (q.type) {
    case QuestionType.MULTI_SELECT:
      return Array.isArray(answer) ? answer.map((i: number) => q.options?.[i] ?? '—').join(', ') : '—';
    case QuestionType.FILL_BLANK:
      return Array.isArray(answer) ? answer.map((s: string) => s || '—').join(' | ') : '—';
    case QuestionType.MATCHING: {
      const left = match.left || [], right = match.right || [];
      const map = (answer && typeof answer === 'object') ? answer : {};
      return left.map((l, i) => `${l} → ${right[map[i]] ?? '—'}`).join('; ');
    }
    case QuestionType.ORDERING: {
      const items = match.items || [];
      const order = Array.isArray(answer) ? answer : [];
      return order.map((i: number) => items[i] ?? '—').join(' → ');
    }
    case QuestionType.DRAG_DROP: {
      const items = match.items || [], buckets = match.buckets || [];
      const map = (answer && typeof answer === 'object') ? answer : {};
      return items.map((it, i) => `${it} → ${buckets[map[i]] ?? '—'}`).join('; ');
    }
    default:
      return answer === undefined || answer === null || answer === '' ? '' : String(answer);
  }
};
