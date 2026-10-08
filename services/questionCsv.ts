import { Question, QuestionType } from '../types';

// Shared question-CSV format used by BOTH the exam editor (ExamManager) and the Question Bank tab,
// so a file that imports into one imports identically into the other.

export interface QuestionCsvError {
  row: number;
  message: string;
  rawData: string;
}

export interface QuestionCsvOptions {
  /** Pass the exam's sections to enable the optional 11th "Section" column; omit when not using sections. */
  sections?: { id: string; title: string }[];
  /** Section used for rows whose Section cell is blank. */
  activeSectionId?: string;
  /** Id generator for new questions (defaults to a short random id). */
  newId?: () => string;
}

/** Read an uploaded CSV as text: strict UTF-8 first, Windows-1252 fallback (Excel's "CSV (Comma delimited)"). */
export const readCsvFileText = async (file: File): Promise<string> => {
  const buffer = await file.arrayBuffer();
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer).replace(/^\uFEFF/, '');
  } catch {
    return new TextDecoder('windows-1252').decode(buffer).replace(/^\uFEFF/, '');
  }
};

// Structured types (MATCHING/ORDERING/DRAG_DROP) are intentionally absent — they import via the
// question editor or JSON only. Keys must already be normalised the same way as the lookup.
export const QUESTION_CSV_TYPE_ALIASES: Record<string, QuestionType> = {
  MCQ: QuestionType.MCQ,
  MULTISELECT: QuestionType.MULTI_SELECT,
  MULTIPLESELECT: QuestionType.MULTI_SELECT,
  MSQ: QuestionType.MULTI_SELECT,
  TRUEFALSE: QuestionType.TRUE_FALSE,
  TF: QuestionType.TRUE_FALSE,
  YESNO: QuestionType.YES_NO,
  YN: QuestionType.YES_NO,
  SHORTTEXT: QuestionType.SHORT_TEXT,
  SHORT: QuestionType.SHORT_TEXT,
  LONGTEXT: QuestionType.LONG_TEXT,
  ESSAY: QuestionType.LONG_TEXT,
  LONG: QuestionType.LONG_TEXT,
  TEXT: QuestionType.TEXT,
  FILLBLANK: QuestionType.FILL_BLANK,
  FILLINTHEBLANK: QuestionType.FILL_BLANK,
  FIB: QuestionType.FILL_BLANK,
  BLANK: QuestionType.FILL_BLANK,
  NUMERIC: QuestionType.NUMERIC,
  NUMBER: QuestionType.NUMERIC,
  NUM: QuestionType.NUMERIC,
  DATE: QuestionType.DATE,
  TIME: QuestionType.TIME,
};

// Robust CSV Line Parser (Handles quoted strings containing commas)
export const parseCsvLine = (text: string): string[] => {
  const result: string[] = [];
  let start = 0;
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '"') { 
      inQuotes = !inQuotes; 
    } else if (text[i] === ',' && !inQuotes) {
      let field = text.substring(start, i).trim();
      // Remove surrounding quotes and unescape double quotes
      if (field.startsWith('"') && field.endsWith('"')) {
        field = field.slice(1, -1).replace(/""/g, '"');
      }
      result.push(field);
      start = i + 1;
    }
  }
  // Push last field
  let lastField = text.substring(start).trim();
  if (lastField.startsWith('"') && lastField.endsWith('"')) {
    lastField = lastField.slice(1, -1).replace(/""/g, '"');
  }
  result.push(lastField);
  return result;
};

export const buildQuestionCsvTemplate = (opts: { sections?: { id: string; title: string }[] } = {}): string => {
  const sections = opts.sections ?? [];
  const useSections = opts.sections !== undefined;
  // 10 columns; the trailing Word Limit and Negative Marks are optional. An 11th "Section"
  // column is appended ONLY when Sections is switched on for this exam. The Option/Correct
  // columns are reused per type (see the '#' guide rows below — import skips lines starting with '#').
  const headers = "Type,Question Text,Option A,Option B,Option C,Option D,Correct Option,Marks,Word Limit,Negative Marks"
    + (useSections ? ",Section\n" : "\n");
  const guide = [
    "# ---------------------------------------------------------------------------------------------",
    "# HOW TO USE: one question per row. The '#' guide rows are skipped on import (delete if you like).",
    "# Supported types: MCQ, MULTI_SELECT, TRUE_FALSE, YES_NO, SHORT_TEXT, LONG_TEXT, FILL_BLANK,",
    "#   NUMERIC, DATE, TIME.  (MATCHING / ORDERING / DRAG_DROP: use the editor or JSON import.)",
    "# Column usage by type:",
    "#   MCQ          -> Option A-D = choices; Correct Option = 1-4 (single).",
    "#   MULTI_SELECT -> Option A-D = choices; Correct Option = comma list of numbers e.g. \"\"1,3\"\".",
    "#   TRUE_FALSE   -> options auto; Correct Option = True or False (or 1/2). Leave A-D blank.",
    "#   YES_NO       -> options auto; Correct Option = Yes or No (or 1/2). Leave A-D blank.",
    "#   SHORT_TEXT   -> manual grade; only Question Text + Marks needed.",
    "#   LONG_TEXT    -> manual grade; Word Limit optional (blank = no limit).",
    "#   FILL_BLANK   -> one blank per Option cell (A,B,...); alternates separated by | e.g. paris|Paris.",
    "#   NUMERIC      -> Option A = expected value; Option B = optional +/- tolerance (blank = exact).",
    "#   DATE         -> Option A = answer as YYYY-MM-DD.",
    "#   TIME         -> Option A = answer as HH:MM (24-hour).",
    "# Negative Marks: deducted if the question is answered but wrong (blank/0 = no penalty).",
    "#   Fractions are allowed, e.g. 0.25 or 0.5.",
    "#   Ignored for SHORT_TEXT / LONG_TEXT, which are graded manually.",
    ...(useSections ? [
      "# Section: which section this question goes into. Use its position (1, 2, 3, ...) below,",
      "#   or its exact title. Leave blank to use whichever section is currently \"Active\".",
      `#   Your sections: ${sections.map((s, i) => `${i + 1}=${s.title}`).join(', ') || '(none yet — add one above first)'}`,
    ] : []),
    "# ---------------------------------------------------------------------------------------------",
  ].join("\n") + "\n";
  // Round-robins sample rows across the real sections (1,2,3,1,2,...) so the template actually
  // demonstrates a multi-section upload; falls back to no column at all when sections are off.
  const withSection = (row: string, n: number): string =>
    useSections ? `${row},${sections.length > 0 ? (n % sections.length) + 1 : 1}` : row;
  const samples = [
    withSection('MCQ,"What is the capital of France?",Berlin,London,Paris,Madrid,3,5,,1', 0),
    withSection('MULTI_SELECT,"Which of these are prime numbers?",2,4,5,9,"1,3",5,,1', 1),
    withSection('TRUE_FALSE,"The Earth orbits the Sun.",,,,,True,2,,', 2),
    withSection('YES_NO,"Is water a compound?",,,,,Yes,2,,', 0),
    withSection('SHORT_TEXT,"Name the first President of the United States.",,,,,,3,,', 1),
    withSection('LONG_TEXT,"Explain the concept of recursion in your own words.",,,,,,10,150,', 2),
    withSection('FILL_BLANK,"___ is the capital of France and ___ is the capital of Japan.",paris|Paris,tokyo|Tokyo,,,,5,,', 0),
    withSection('NUMERIC,"What is 15 divided by 4? (round to 2 decimals)",3.75,0.01,,,,4,,', 1),
    withSection('DATE,"On what date did India gain independence?",1947-08-15,,,,,3,,', 2),
    withSection('TIME,"At what time (24h) does solar noon occur (approx)?",12:00,,,,,2,,', 0),
  ].join("\n");
  return headers + guide + samples;
};

export const parseQuestionCsv = (text: string, opts: QuestionCsvOptions = {}): { questions: Question[]; errors: QuestionCsvError[] } => {
  // Sections only apply when the caller passes them (the exam editor with Sections switched on).
  const sections = opts.sections ?? [];
  const useSections = opts.sections !== undefined;
  const activeSectionId = opts.activeSectionId ?? '';
  const newId = opts.newId ?? (() => Math.random().toString(36).substr(2, 9));
  const lines = text.split('\n');
  const questions: Question[] = [];
  const errors: QuestionCsvError[] = [];

  // Skip header row (index 0)
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    // Lines beginning with '#' are template instructions/comments — skip them.
    if (line.startsWith('#')) continue;

    const cols = parseCsvLine(line);

    // Basic structure validation
    if (cols.length < 8) {
      errors.push({ row: i + 1, message: `Insufficient columns. Expected 8, got ${cols.length}.`, rawData: line });
      continue;
    }

    // The 9th "WordLimit", 10th "Negative Marks" and 11th "Section" columns are all OPTIONAL,
    // so CSVs written before any of these features still import.
    const [typeRaw, qText, optA, optB, optC, optD, correctStr, marksStr, wordLimitStr, negativeMarksStr, sectionStr] = cols;
    // Number (not parseInt) so "2.5" or "5 pts" is rejected instead of silently becoming 2 / 5 —
    // marks are whole numbers end to end (INT column, all-or-nothing grading).
    const marks = Number((marksStr ?? '').trim());
    const wordLimitTrim = (wordLimitStr ?? '').trim();
    const wordLimit = parseInt(wordLimitTrim, 10);
    const negativeMarksTrim = (negativeMarksStr ?? '').trim();
    // parseFloat (not parseInt) — negative marking supports fractions like 0.5 or 0.25.
    const negativeMarksVal = parseFloat(negativeMarksTrim);

    // Resolve which section this row belongs to — only meaningful when Sections is switched
    // on. A number picks a section by position (1-based, matching the template's guide);
    // any other text must match a section title exactly (case-insensitive). Blank falls back
    // to whichever section is currently "Active" in the editor above.
    let rowSectionId: string | undefined;
    if (useSections) {
      const sectionTrim = (sectionStr ?? '').trim();
      if (sectionTrim === '') {
        rowSectionId = activeSectionId || sections[0]?.id;
      } else if (/^\d+$/.test(sectionTrim)) {
        const sectionIdx = parseInt(sectionTrim, 10) - 1;
        if (sectionIdx < 0 || sectionIdx >= sections.length) {
          errors.push({ row: i + 1, message: `Section ${sectionTrim} doesn't exist — this exam has ${sections.length} section(s) (1-${sections.length}).`, rawData: line });
          continue;
        }
        rowSectionId = sections[sectionIdx].id;
      } else {
        const matchedSection = sections.find(s => s.title.trim().toLowerCase() === sectionTrim.toLowerCase());
        if (!matchedSection) {
          errors.push({ row: i + 1, message: `Section "${sectionTrim}" not found. Use a position number (1-${sections.length}) or an exact section title.`, rawData: line });
          continue;
        }
        rowSectionId = matchedSection.id;
      }
    }

    // Normalise the type: uppercase and strip spaces / _ / - / slashes so "Multi Select",
    // "MULTI_SELECT", "true/false", "Fill-Blank" all resolve to the same canonical type.
    const type = QUESTION_CSV_TYPE_ALIASES[typeRaw.toUpperCase().replace(/[\s_\-/]/g, '')];

    // Validate Marks
    if ((marksStr ?? '').trim() === '' || !Number.isInteger(marks) || marks <= 0) {
      errors.push({ row: i + 1, message: "Invalid marks. Must be a positive whole number.", rawData: line });
      continue;
    }

    // Validate Question Text
    if (!qText) {
      errors.push({ row: i + 1, message: "Question text is empty.", rawData: line });
      continue;
    }

    if (!type) {
      const normalized = typeRaw.toUpperCase().replace(/[\s_\-/]/g, '');
      if (['MATCHING', 'ORDERING', 'DRAGDROP'].includes(normalized)) {
        errors.push({ row: i + 1, message: `"${typeRaw}" can't be imported from CSV — add Matching/Ordering/Drag-Drop questions in the editor or via JSON import.`, rawData: line });
      } else {
        errors.push({ row: i + 1, message: `Invalid Type "${typeRaw}". Supported: MCQ, MULTI_SELECT, TRUE_FALSE, YES_NO, SHORT_TEXT, LONG_TEXT, FILL_BLANK, NUMERIC, DATE, TIME.`, rawData: line });
      }
      continue;
    }

    // Negative marks (deducted if answered but wrong) is optional; blank/0 = no penalty.
    if (negativeMarksTrim !== '' && (isNaN(negativeMarksVal) || negativeMarksVal < 0)) {
      errors.push({ row: i + 1, message: "Negative marks must be a non-negative number (or left blank for none).", rawData: line });
      continue;
    }
    const resolvedNegativeMarks = negativeMarksVal > 0 ? negativeMarksVal : 0;
    const base = { id: newId(), text: qText, marks, negativeMarks: resolvedNegativeMarks, sectionId: rowSectionId };
    // Word limit is only meaningful for free-text types; validate it when supplied.
    if (wordLimitTrim !== '' && (isNaN(wordLimit) || wordLimit <= 0)) {
      errors.push({ row: i + 1, message: "Word limit must be a positive number (or left blank for no limit).", rawData: line });
      continue;
    }
    const resolvedWordLimit = wordLimit > 0 ? wordLimit : null;

    // Contiguous options run (A..D up to the last filled cell); used by MCQ / MULTI_SELECT.
    const optCells = [optA, optB, optC, optD].map(c => (c ?? '').trim());
    const lastFilled = optCells.reduce((acc, c, idx) => (c ? idx : acc), -1);
    const options = lastFilled >= 0 ? optCells.slice(0, lastFilled + 1) : [];
    const hasGap = options.some(o => !o);

    if (type === QuestionType.MCQ) {
      const correctVal = parseInt(correctStr);
      if (options.length !== 4 || hasGap) {
        errors.push({ row: i + 1, message: "MCQ requires all 4 options to be filled.", rawData: line });
        continue;
      }
      if (isNaN(correctVal) || correctVal < 1 || correctVal > 4) {
        errors.push({ row: i + 1, message: "Correct Option must be between 1 and 4 for MCQ.", rawData: line });
        continue;
      }
      questions.push({ ...base, type, options, correctOptionIndex: correctVal - 1 });

    } else if (type === QuestionType.MULTI_SELECT) {
      if (options.length < 2 || hasGap) {
        errors.push({ row: i + 1, message: "Multi-Select needs at least 2 options filled in order (Option A, B, ...).", rawData: line });
        continue;
      }
      const picks = correctStr.split(/[,;\s]+/).map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
      const indices = Array.from(new Set(picks.map(n => n - 1))).sort((a, b) => a - b);
      if (indices.length < 1 || indices.some(idx => idx < 0 || idx >= options.length)) {
        errors.push({ row: i + 1, message: `Correct Option for Multi-Select must be a list of option numbers (e.g. "1,3") within 1-${options.length}.`, rawData: line });
        continue;
      }
      questions.push({ ...base, type, options, answerKey: { correctIndices: indices } });

    } else if (type === QuestionType.TRUE_FALSE || type === QuestionType.YES_NO) {
      const opts = type === QuestionType.TRUE_FALSE ? ['True', 'False'] : ['Yes', 'No'];
      const c = correctStr.trim().toUpperCase();
      const firstWords = type === QuestionType.TRUE_FALSE ? ['1', 'TRUE', 'T'] : ['1', 'YES', 'Y'];
      const secondWords = type === QuestionType.TRUE_FALSE ? ['2', 'FALSE', 'F'] : ['2', 'NO', 'N'];
      const correctOptionIndex = firstWords.includes(c) ? 0 : secondWords.includes(c) ? 1 : -1;
      if (correctOptionIndex < 0) {
        errors.push({ row: i + 1, message: `Correct Option for ${type} must be "${opts[0]}" or "${opts[1]}" (or 1/2).`, rawData: line });
        continue;
      }
      questions.push({ ...base, type, options: opts, correctOptionIndex });

    } else if (type === QuestionType.SHORT_TEXT || type === QuestionType.LONG_TEXT || type === QuestionType.TEXT) {
      // Manually graded — a negative-marks column value here would never be applied, so drop it.
      questions.push({ ...base, type, negativeMarks: 0, wordLimit: resolvedWordLimit });

    } else if (type === QuestionType.FILL_BLANK) {
      // Each filled Option cell is one blank; alternates within a blank are separated by "|".
      const blanks = [optA, optB, optC, optD]
        .map(c => (c ?? '').trim())
        .filter(Boolean)
        .map(cell => ({ accepted: cell.split('|').map(s => s.trim()).filter(Boolean) }));
      if (blanks.length === 0 || blanks.some(b => b.accepted.length === 0)) {
        errors.push({ row: i + 1, message: "Fill-Blank needs at least one accepted answer per blank (put each blank in Option A, B, ...; separate alternates with |).", rawData: line });
        continue;
      }
      questions.push({ ...base, type, answerKey: { blanks } });

    } else if (type === QuestionType.NUMERIC) {
      // Option A = expected value, Option B = optional ± tolerance.
      const value = Number((optA ?? '').trim());
      if ((optA ?? '').trim() === '' || isNaN(value)) {
        errors.push({ row: i + 1, message: "Numeric requires an expected value in Option A.", rawData: line });
        continue;
      }
      const tolRaw = (optB ?? '').trim();
      const tolerance = tolRaw === '' ? null : Number(tolRaw);
      if (tolerance !== null && (isNaN(tolerance) || tolerance < 0)) {
        errors.push({ row: i + 1, message: "Numeric tolerance (Option B) must be a non-negative number, or left blank.", rawData: line });
        continue;
      }
      questions.push({ ...base, type, answerKey: { value, tolerance } });

    } else if (type === QuestionType.DATE) {
      const value = (optA ?? '').trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        errors.push({ row: i + 1, message: "Date answer (Option A) must be in YYYY-MM-DD format.", rawData: line });
        continue;
      }
      questions.push({ ...base, type, answerKey: { value } });

    } else if (type === QuestionType.TIME) {
      const raw = (optA ?? '').trim();
      const m = raw.match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
      if (!m) {
        errors.push({ row: i + 1, message: "Time answer (Option A) must be in HH:MM 24-hour format.", rawData: line });
        continue;
      }
      const value = `${m[1].padStart(2, '0')}:${m[2]}`;
      questions.push({ ...base, type, answerKey: { value } });
    }
  }

  return { questions, errors };
};
