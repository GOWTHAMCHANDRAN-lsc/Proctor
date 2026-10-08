import { QuestionType, ResultAnswer } from '../types';

/**
 * Turn a stored result answer into human-readable "your answer" / "correct answer" strings,
 * for every question type. Used by the admin Results table, CSV/PDF exports, and reports so
 * the presentation stays consistent. `correctText` is '—' for manually graded free-text types.
 */
export interface FormattedAnswer {
  answerText: string;
  correctText: string;
}

const opt = (options: (string[] | null | undefined), idx: number | null | undefined): string =>
  idx !== null && idx !== undefined && options ? (options[idx] ?? '—') : '—';

export const formatResultAnswer = (a: ResultAnswer): FormattedAnswer => {
  const type = a.questionType;
  const options = a.options ?? undefined;
  const key = a.answerKey ?? undefined;
  const match = a.matchOptions ?? undefined;
  const resp = a.answerJson;

  switch (type) {
    case QuestionType.MCQ:
    case QuestionType.TRUE_FALSE:
    case QuestionType.YES_NO:
      return { answerText: opt(options, a.answerOptionIndex), correctText: opt(options, a.correctOptionIndex) };

    case QuestionType.MULTI_SELECT: {
      const picked = Array.isArray(resp) ? resp : [];
      const correct = key?.correctIndices ?? [];
      return {
        answerText: picked.length ? picked.map((i: number) => opt(options, i)).join(', ') : '—',
        correctText: correct.length ? correct.map(i => opt(options, i)).join(', ') : '—',
      };
    }

    case QuestionType.FILL_BLANK: {
      const arr = Array.isArray(resp) ? resp : [];
      const blanks = key?.blanks ?? [];
      return {
        answerText: arr.length ? arr.map(s => String(s || '—')).join(' | ') : '—',
        correctText: blanks.length ? blanks.map(b => b.accepted.join(' / ')).join(' | ') : '—',
      };
    }

    case QuestionType.NUMERIC:
      return {
        // `||` not `??`: an emptied field is stored as '' and should read as "no answer", not blank.
        answerText: a.answerText || '—',
        correctText: key?.value !== undefined ? `${key.value}${key.tolerance != null ? ` ± ${key.tolerance}` : ''}` : '—',
      };

    case QuestionType.DATE:
    case QuestionType.TIME:
      return { answerText: a.answerText || '—', correctText: key?.value !== undefined ? String(key.value) : '—' };

    case QuestionType.MATCHING: {
      const left = match?.left ?? [];
      const right = match?.right ?? [];
      const map: Record<number, number> = (resp && typeof resp === 'object') ? resp : {};
      const answerText = left.length
        ? left.map((l, i) => `${l} → ${right[map[i]] ?? '—'}`).join('; ')
        : '—';
      const correctText = left.length ? left.map((l, i) => `${l} → ${right[i] ?? '—'}`).join('; ') : '—';
      return { answerText, correctText };
    }

    case QuestionType.ORDERING: {
      const items = match?.items ?? [];
      const order: number[] = Array.isArray(resp) ? resp : [];
      return {
        answerText: order.length ? order.map(i => items[i] ?? '—').join(' → ') : '—',
        correctText: items.length ? items.join(' → ') : '—',
      };
    }

    case QuestionType.DRAG_DROP: {
      const items = match?.items ?? [];
      const buckets = match?.buckets ?? [];
      const map: Record<number, number> = (resp && typeof resp === 'object') ? resp : {};
      const placements = key?.placements ?? {};
      return {
        answerText: items.length ? items.map((it, i) => `${it} → ${buckets[map[i]] ?? '—'}`).join('; ') : '—',
        correctText: items.length ? items.map((it, i) => `${it} → ${buckets[placements[i]] ?? '—'}`).join('; ') : '—',
      };
    }

    default:
      // SHORT_TEXT / LONG_TEXT / legacy TEXT — free text, graded manually.
      return { answerText: a.answerText || '—', correctText: '—' };
  }
};
