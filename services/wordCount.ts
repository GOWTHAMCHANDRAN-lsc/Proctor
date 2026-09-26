/**
 * Word counting for descriptive (TEXT) answers.
 *
 * The candidate's live counter, the hard stop that enforces the limit, and anything that reports on
 * an answer's length must all agree on what "a word" is — otherwise a candidate is stopped at 100
 * words while the screen still reads 98, which during a timed exam is the kind of thing that ends in
 * a support call. So there is exactly ONE definition, here.
 *
 * A word is a run of non-whitespace characters. That treats "state-of-the-art" and "don't" as one
 * word each (what a human counting an essay would say), and it means punctuation never inflates the
 * count.
 */

export const countWords = (text: string): number => {
  const trimmed = (text ?? '').trim();
  if (trimmed === '') return 0;
  return trimmed.split(/\s+/).length;
};

/**
 * Cut `text` down to at most `limit` words, preserving the candidate's own spacing and line breaks
 * up to the cut. Returns the text unchanged when it is already within the limit.
 *
 * Trailing whitespace is kept while the answer is still under the limit, so that typing a space
 * after a word doesn't jump the cursor backwards — the candidate can keep going into the next word.
 */
export const truncateToWords = (text: string, limit: number): string => {
  if (!Number.isFinite(limit) || limit <= 0) return text;
  if (countWords(text) <= limit) return text;

  // Walk the string and stop right after the `limit`-th word ends.
  const re = /\S+/g;
  let words = 0;
  let end = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    words += 1;
    if (words === limit) {
      end = match.index + match[0].length;
      break;
    }
  }
  return end > 0 ? text.slice(0, end) : text;
};
