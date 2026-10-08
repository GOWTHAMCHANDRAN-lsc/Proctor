import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle, ArrowLeft, CheckCircle, ChevronDown, ChevronUp, Download, Eye, FileSpreadsheet, FileWarning,
  Library, Loader2, Pencil, Plus, RefreshCcw, Search, Trash2, Upload, X,
} from 'lucide-react';
import {
  Question,
  QuestionBank as QuestionBankInfo,
  QuestionBankDetail,
  QuestionType,
  UserRole,
} from '../../types';
import { apiGet, apiPost, getApiErrorMessage } from '../../services/api';
import { buildQuestionCsvTemplate, parseQuestionCsv, QuestionCsvError, readCsvFileText } from '../../services/questionCsv';
import { Pagination, usePagination } from './Pagination';

// Question Bank tab: company-owned, reusable question collections (api/question_banks.php). A bank
// question is shared by every exam that links it, so editing it here changes it in all of them.

interface QuestionBankProps {
  role: UserRole;
}

/** A bank question as the API returns it: the shared Question shape plus its exam usage. */
type BankQuestion = Question & { examCount?: number };
type BankDetail = Omit<QuestionBankDetail, 'questions'> & { questions: BankQuestion[] };

const API = 'question_banks.php';
const MAX_PER_REQUEST = 2000; // server cap per ADD_QUESTIONS call; bigger files are sent in parts
const MAX_CSV_BYTES = 5 * 1024 * 1024;
const MAX_OPTIONS = 20;
const MAX_BLANKS = 20;

const TYPE_LABELS: Record<QuestionType, string> = {
  [QuestionType.MCQ]: 'MCQ',
  [QuestionType.MULTI_SELECT]: 'Multi-select',
  [QuestionType.TRUE_FALSE]: 'True / False',
  [QuestionType.YES_NO]: 'Yes / No',
  [QuestionType.SHORT_TEXT]: 'Short text',
  [QuestionType.LONG_TEXT]: 'Long text',
  [QuestionType.TEXT]: 'Descriptive',
  [QuestionType.FILL_BLANK]: 'Fill blank',
  [QuestionType.NUMERIC]: 'Numeric',
  [QuestionType.DATE]: 'Date',
  [QuestionType.TIME]: 'Time',
  [QuestionType.MATCHING]: 'Matching',
  [QuestionType.ORDERING]: 'Ordering',
  [QuestionType.DRAG_DROP]: 'Drag & drop',
};

// The types the shared CSV format (and therefore this editor) supports. MATCHING / ORDERING /
// DRAG_DROP questions can live in a bank but are shown read-only here.
const EDITABLE_TYPES: QuestionType[] = [
  QuestionType.MCQ, QuestionType.MULTI_SELECT, QuestionType.TRUE_FALSE, QuestionType.YES_NO,
  QuestionType.SHORT_TEXT, QuestionType.LONG_TEXT, QuestionType.FILL_BLANK, QuestionType.NUMERIC,
  QuestionType.DATE, QuestionType.TIME,
];
const isEditableType = (t: QuestionType) => EDITABLE_TYPES.includes(t) || t === QuestionType.TEXT;
const isManualType = (t: QuestionType) =>
  t === QuestionType.SHORT_TEXT || t === QuestionType.LONG_TEXT || t === QuestionType.TEXT;

const typeChipClass = (t: QuestionType): string => {
  if (isManualType(t)) return 'lsc-chip-warm';
  if (t === QuestionType.MATCHING || t === QuestionType.ORDERING || t === QuestionType.DRAG_DROP) return 'lsc-chip-neutral';
  if (t === QuestionType.FILL_BLANK || t === QuestionType.NUMERIC || t === QuestionType.DATE || t === QuestionType.TIME) return 'lsc-chip-success';
  return 'lsc-chip-primary';
};

/** Display label; falls back to the raw value for a type this build doesn't know. */
const typeLabel = (t: QuestionType): string => TYPE_LABELS[t] ?? String(t);

const TypeChip: React.FC<{ type: QuestionType }> = ({ type }) => (
  <span className={`${typeChipClass(type)} whitespace-nowrap`}>{typeLabel(type)}</span>
);

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const formatDateTime = (ms: number): string => {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  try {
    return new Date(ms).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch {
    return '—';
  }
};

// Same download mechanism as the exam editor's template (BOM so Excel opens UTF-8 correctly).
const csvDataUri = (content: string) => 'data:text/csv;charset=utf-8,' + encodeURIComponent(String.fromCharCode(0xFEFF) + content);

const downloadTemplate = () => {
  const link = document.createElement('a');
  link.setAttribute('href', csvDataUri(buildQuestionCsvTemplate()));
  link.setAttribute('download', 'question_bank_template.csv');
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
};

// The super admin's top-bar company (services/api.ts sends it as X-Company-Id). The screen remounts on
// a company switch (App keys it by company), so reading it once at mount is enough.
const hasActiveCompany = (): boolean => {
  try {
    const id = Number(localStorage.getItem('pg_admin_active_company'));
    return Number.isFinite(id) && id > 0;
  } catch {
    return false;
  }
};

/** Structured `errors` array from a 400 ADD_QUESTIONS response (the error body is the raw JSON text). */
const readServerRowErrors = (e: unknown): { index: number; message: string }[] | null => {
  const raw = e instanceof Error ? e.message : '';
  if (!raw.trim().startsWith('{')) return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed?.errors) ? parsed.errors : null;
  } catch {
    return null;
  }
};

const snippet = (text: string, max = 60) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/* ---------------------------------------------------------------------------------------------- */
/* Shared UI bits                                                                                  */
/* ---------------------------------------------------------------------------------------------- */

const useEscapeKey = (active: boolean, onEscape: () => void) => {
  const handler = useRef(onEscape);
  handler.current = onEscape;
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handler.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active]);
};

interface ModalProps {
  titleId: string;
  onClose: () => void;
  /** While busy the dialog can't be dismissed (the request is still running). */
  busy?: boolean;
  /** Backdrop clicks close the dialog (off for forms, so a stray click doesn't lose typing). */
  closeOnBackdrop?: boolean;
  size?: 'md' | 'lg';
  children: React.ReactNode;
}

const Modal: React.FC<ModalProps> = ({ titleId, onClose, busy = false, closeOnBackdrop = true, size = 'md', children }) => {
  useEscapeKey(true, () => { if (!busy) onClose(); });
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/40"
      onClick={() => { if (closeOnBackdrop && !busy) onClose(); }}
    >
      <div
        className={`lsc-card w-full ${size === 'lg' ? 'max-w-2xl' : 'max-w-md'} max-h-[90vh] overflow-y-auto`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={e => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
};

type Notice = { tone: 'success' | 'error' | 'warning'; text: string };

const NoticeBanner: React.FC<{ notice: Notice | null; onDismiss: () => void }> = ({ notice, onDismiss }) => {
  if (!notice) return null;
  const tone = notice.tone === 'error'
    ? 'bg-rose-50 border-rose-200 text-rose-700'
    : notice.tone === 'warning'
      ? 'bg-amber-50 border-amber-200 text-amber-800'
      : 'bg-teal-50 border-teal-200 text-teal-700';
  const Icon = notice.tone === 'error' ? AlertCircle : notice.tone === 'warning' ? FileWarning : CheckCircle;
  return (
    <div role={notice.tone === 'error' ? 'alert' : 'status'} className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-sm ${tone}`}>
      <Icon size={16} className="mt-0.5 shrink-0" />
      <span className="flex-1 min-w-0 break-words">{notice.text}</span>
      <button type="button" onClick={onDismiss} aria-label="Dismiss message" className="shrink-0 opacity-70 hover:opacity-100">
        <X size={14} />
      </button>
    </div>
  );
};

const inputCls = 'w-full px-3 py-2 border border-slate-200 rounded-lg text-sm outline-none bg-white';
const labelCls = 'block text-xs font-semibold text-slate-600 mb-1';
const dangerBtn = 'inline-flex items-center justify-center gap-2 px-5 py-2 rounded-lg bg-red-600 text-white text-sm font-semibold hover:bg-red-700 disabled:opacity-60';

/* ---------------------------------------------------------------------------------------------- */
/* Bank create / edit                                                                              */
/* ---------------------------------------------------------------------------------------------- */

const BankFormModal: React.FC<{
  bank: QuestionBankInfo | null; // null = create
  onClose: () => void;
  onSaved: (bank: QuestionBankInfo) => void;
}> = ({ bank, onClose, onSaved }) => {
  const [name, setName] = useState(bank?.name ?? '');
  const [description, setDescription] = useState(bank?.description ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const trimmed = name.trim();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (!trimmed) {
      setError('Give the bank a name.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const res = bank
        ? await apiPost<{ bank: QuestionBankInfo }>(API, { action: 'UPDATE_BANK', id: bank.id, name: trimmed, description: description.trim() })
        : await apiPost<{ bank: QuestionBankInfo }>(API, { action: 'CREATE_BANK', name: trimmed, description: description.trim() });
      onSaved(res.bank);
    } catch (err) {
      setError(getApiErrorMessage(err, bank ? 'Could not save the bank.' : 'Could not create the bank.'));
      setBusy(false);
    }
  };

  return (
    <Modal titleId="bank-form-title" onClose={onClose} busy={busy} closeOnBackdrop={false}>
      <form onSubmit={submit} className="p-6 space-y-4">
        <div className="flex items-start justify-between gap-3">
          <h3 id="bank-form-title" className="text-lg font-semibold text-slate-900">{bank ? 'Edit bank details' : 'Create question bank'}</h3>
          <button type="button" onClick={onClose} disabled={busy} aria-label="Close" className="text-slate-400 hover:text-slate-600 disabled:opacity-50">
            <X size={18} />
          </button>
        </div>
        {error && <div role="alert" className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</div>}
        <div>
          <label htmlFor="bank-name" className={labelCls}>Name</label>
          <input
            id="bank-name"
            className={inputCls}
            value={name}
            maxLength={255}
            autoFocus
            placeholder="e.g. Sales Fundamentals"
            onChange={e => setName(e.target.value)}
          />
          <p className="mt-1 text-[11px] text-slate-400">Must be unique in this company. Exam requests refer to banks by this name.</p>
        </div>
        <div>
          <label htmlFor="bank-description" className={labelCls}>Description <span className="font-normal text-slate-400">(optional)</span></label>
          <textarea
            id="bank-description"
            className={`${inputCls} min-h-[90px]`}
            value={description}
            maxLength={2000}
            placeholder="What this bank covers, who it is for…"
            onChange={e => setDescription(e.target.value)}
          />
        </div>
        <div className="flex justify-end gap-3 pt-2">
          <button type="button" onClick={onClose} disabled={busy} className="px-5 py-2 lsc-button-ghost text-sm">Cancel</button>
          <button type="submit" disabled={busy || !trimmed} className="inline-flex items-center gap-2 px-5 py-2 lsc-button-primary text-sm">
            {busy && <Loader2 size={15} className="animate-spin" />}
            {busy ? 'Saving…' : bank ? 'Save changes' : 'Create bank'}
          </button>
        </div>
      </form>
    </Modal>
  );
};

/* ---------------------------------------------------------------------------------------------- */
/* Bank delete                                                                                     */
/* ---------------------------------------------------------------------------------------------- */

const DeleteBankModal: React.FC<{
  bank: QuestionBankInfo;
  onClose: () => void;
  onDeleted: (result: { deletedQuestions: number; keptQuestions: number }) => void;
}> = ({ bank, onClose, onDeleted }) => {
  const [usage, setUsage] = useState<{ used: number; total: number } | null>(null);
  const [usageFailed, setUsageFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // How many of the bank's questions exams still use (those are kept) — needs the bank's questions.
  useEffect(() => {
    let cancelled = false;
    apiGet<{ bank: BankDetail }>(`${API}?id=${bank.id}`)
      .then(res => {
        if (cancelled) return;
        const qs = res.bank?.questions || [];
        setUsage({ used: qs.filter(q => (q.examCount ?? 0) > 0).length, total: qs.length });
      })
      .catch(() => { if (!cancelled) setUsageFailed(true); });
    return () => { cancelled = true; };
  }, [bank.id]);

  const confirm = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const res = await apiPost<{ ok: boolean; deletedQuestions: number; keptQuestions: number }>(API, { action: 'DELETE_BANK', id: bank.id });
      onDeleted({ deletedQuestions: res.deletedQuestions ?? 0, keptQuestions: res.keptQuestions ?? 0 });
    } catch (err) {
      setError(getApiErrorMessage(err, 'Could not delete the bank.'));
      setBusy(false);
    }
  };

  return (
    <Modal titleId="delete-bank-title" onClose={onClose} busy={busy}>
      <div className="p-6">
        <div className="flex items-start gap-3">
          <div className="lsc-icon-tile-danger p-2.5 shrink-0"><Trash2 size={18} /></div>
          <div className="min-w-0">
            <h3 id="delete-bank-title" className="text-lg font-semibold text-slate-900">Delete question bank?</h3>
            <p className="text-sm text-slate-500 mt-1">
              This deletes <span className="font-medium text-slate-800 break-words">{bank.name}</span> and removes all {plural(bank.questionCount, 'question')} from it.
            </p>
            <div className="mt-3 text-sm" aria-live="polite">
              {usage === null && !usageFailed && (
                <p className="flex items-center gap-2 text-slate-400"><Loader2 size={14} className="animate-spin" /> Checking which questions exams use…</p>
              )}
              {usageFailed && (
                <p className="text-slate-500">Questions that exams still use are kept so those exams keep working; the rest are deleted permanently.</p>
              )}
              {usage && usage.used > 0 && (
                <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-amber-800">
                  {plural(usage.used, 'question')} {usage.used === 1 ? 'is' : 'are'} used by {plural(bank.examCount, 'exam')} and will be kept so {bank.examCount === 1 ? 'that exam keeps' : 'those exams keep'} working.
                  {usage.total - usage.used > 0 && <> The other {usage.total - usage.used} will be deleted permanently.</>}
                </p>
              )}
              {usage && usage.used === 0 && usage.total > 0 && (
                <p className="text-slate-500">No exam uses these questions, so all {usage.total} will be deleted permanently. This can't be undone.</p>
              )}
            </div>
            {error && <p role="alert" className="mt-3 text-sm text-rose-600">{error}</p>}
          </div>
        </div>
        <div className="mt-6 flex justify-end gap-3">
          <button type="button" onClick={onClose} disabled={busy} autoFocus className="px-5 py-2 lsc-button-ghost text-sm">Cancel</button>
          <button type="button" onClick={confirm} disabled={busy} className={dangerBtn}>
            {busy && <Loader2 size={15} className="animate-spin" />}
            {busy ? 'Deleting…' : 'Delete bank'}
          </button>
        </div>
      </div>
    </Modal>
  );
};

/* ---------------------------------------------------------------------------------------------- */
/* Question editor (CSV-supported types)                                                           */
/* ---------------------------------------------------------------------------------------------- */

interface QuestionDraft {
  type: QuestionType;
  text: string;
  options: string[];        // MCQ / MULTI_SELECT
  correctIdx: number;       // MCQ / TRUE_FALSE / YES_NO
  correctIndices: number[]; // MULTI_SELECT
  blanks: string[];         // FILL_BLANK: accepted answers per blank, alternates separated by |
  numericValue: string;
  numericTolerance: string;
  dateValue: string;        // YYYY-MM-DD
  timeValue: string;        // HH:MM
  marks: string;
  negativeMarks: string;
  wordLimit: string;
}

const emptyDraft = (type: QuestionType = QuestionType.MCQ): QuestionDraft => ({
  type,
  text: '',
  options: ['', '', '', ''],
  correctIdx: 0,
  correctIndices: [],
  blanks: [''],
  numericValue: '',
  numericTolerance: '',
  dateValue: '',
  timeValue: '',
  marks: '1',
  negativeMarks: '0',
  wordLimit: '',
});

const draftFromQuestion = (q: BankQuestion): QuestionDraft => {
  const d = emptyDraft(q.type);
  d.text = q.text;
  d.marks = String(q.marks ?? 1);
  d.negativeMarks = String(q.negativeMarks ?? 0);
  d.wordLimit = q.wordLimit ? String(q.wordLimit) : '';
  if (q.type === QuestionType.MCQ || q.type === QuestionType.MULTI_SELECT) {
    d.options = q.options && q.options.length > 0 ? [...q.options] : d.options;
  }
  if (typeof q.correctOptionIndex === 'number') d.correctIdx = q.correctOptionIndex;
  d.correctIndices = [...(q.answerKey?.correctIndices || [])];
  if (q.type === QuestionType.FILL_BLANK) {
    const blanks = (q.answerKey?.blanks || []).map(b => (b.accepted || []).join(' | '));
    d.blanks = blanks.length > 0 ? blanks : [''];
  }
  if (q.type === QuestionType.NUMERIC) {
    d.numericValue = q.answerKey?.value !== undefined && q.answerKey?.value !== null ? String(q.answerKey.value) : '';
    d.numericTolerance = q.answerKey?.tolerance !== undefined && q.answerKey?.tolerance !== null ? String(q.answerKey.tolerance) : '';
  }
  if (q.type === QuestionType.DATE) d.dateValue = String(q.answerKey?.value ?? '');
  if (q.type === QuestionType.TIME) d.timeValue = String(q.answerKey?.value ?? '');
  return d;
};

/** Build the API Question from the form — same semantics as one CSV row. Returns an error string if incomplete. */
const buildQuestion = (d: QuestionDraft): { error: string } | { question: Partial<Question> } => {
  const text = d.text.trim();
  if (!text) return { error: 'Enter the question text.' };
  const marksTrim = d.marks.trim();
  const marks = Number(marksTrim);
  if (marksTrim === '' || !Number.isInteger(marks) || marks < 1 || marks > 1000) return { error: 'Marks must be a whole number from 1 to 1000.' };
  const manual = isManualType(d.type);
  const negTrim = d.negativeMarks.trim();
  const neg = negTrim === '' ? 0 : Number(negTrim);
  if (!manual && (!Number.isFinite(neg) || neg < 0 || neg > 1000)) return { error: 'Negative marks must be a number from 0 to 1000 (0 = no penalty).' };

  const base: Partial<Question> = { type: d.type, text, marks, negativeMarks: manual ? 0 : Math.round(neg * 100) / 100 };

  switch (d.type) {
    case QuestionType.MCQ:
    case QuestionType.MULTI_SELECT: {
      // Blank option rows are dropped and the correct index(es) remapped onto the compacted list.
      const raw = d.options.map(o => o.trim());
      const kept = raw.map((o, i) => (o ? i : -1)).filter(i => i >= 0);
      if (kept.length < 2) return { error: 'Provide at least 2 options.' };
      if (d.type === QuestionType.MCQ) {
        if (!raw[d.correctIdx]) return { error: 'Mark a non-empty option as the correct answer.' };
        return { question: { ...base, options: kept.map(i => raw[i]), correctOptionIndex: kept.indexOf(d.correctIdx) } };
      }
      if (d.correctIndices.length < 1) return { error: 'Tick at least one correct option.' };
      if (d.correctIndices.some(i => !raw[i])) return { error: 'A ticked correct option is empty — fill it in or untick it.' };
      const correctIndices = d.correctIndices.map(i => kept.indexOf(i)).sort((a, b) => a - b);
      return { question: { ...base, options: kept.map(i => raw[i]), answerKey: { correctIndices } } };
    }
    case QuestionType.TRUE_FALSE:
      return { question: { ...base, options: ['True', 'False'], correctOptionIndex: d.correctIdx === 1 ? 1 : 0 } };
    case QuestionType.YES_NO:
      return { question: { ...base, options: ['Yes', 'No'], correctOptionIndex: d.correctIdx === 1 ? 1 : 0 } };
    case QuestionType.SHORT_TEXT:
    case QuestionType.LONG_TEXT:
    case QuestionType.TEXT: {
      const wlTrim = d.wordLimit.trim();
      if (wlTrim !== '' && (!/^\d+$/.test(wlTrim) || Number(wlTrim) < 1)) return { error: 'Word limit must be a positive whole number (or blank for no limit).' };
      return { question: { ...base, wordLimit: wlTrim === '' ? null : Number(wlTrim) } };
    }
    case QuestionType.FILL_BLANK: {
      const blanks = d.blanks.map(cell => cell.split('|').map(s => s.trim()).filter(Boolean));
      if (blanks.length === 0 || blanks.some(b => b.length === 0)) return { error: 'Each blank needs at least one accepted answer.' };
      return { question: { ...base, answerKey: { blanks: blanks.map(accepted => ({ accepted })) } } };
    }
    case QuestionType.NUMERIC: {
      const v = d.numericValue.trim();
      if (v === '' || !Number.isFinite(Number(v))) return { error: 'Enter the expected numeric answer.' };
      const tol = d.numericTolerance.trim();
      if (tol !== '' && (!Number.isFinite(Number(tol)) || Number(tol) < 0)) return { error: 'Tolerance must be a non-negative number, or blank for an exact answer.' };
      return { question: { ...base, answerKey: { value: Number(v), tolerance: tol === '' ? null : Number(tol) } } };
    }
    case QuestionType.DATE:
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d.dateValue)) return { error: 'Pick the correct date.' };
      return { question: { ...base, answerKey: { value: d.dateValue } } };
    case QuestionType.TIME:
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(d.timeValue)) return { error: 'Pick the correct time (HH:MM, 24-hour).' };
      return { question: { ...base, answerKey: { value: d.timeValue } } };
    default:
      return { error: 'This question type can’t be edited here.' };
  }
};

const QuestionEditorModal: React.FC<{
  bankId: number;
  question: BankQuestion | null; // null = add
  onClose: () => void;
  onAdded: (detail: BankDetail) => void;
  onUpdated: (question: BankQuestion) => void;
}> = ({ bankId, question, onClose, onAdded, onUpdated }) => {
  const initial = useMemo(() => (question ? draftFromQuestion(question) : emptyDraft()), [question]);
  const [draft, setDraft] = useState<QuestionDraft>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial);
  const usedIn = question?.examCount ?? 0;
  const manual = isManualType(draft.type);
  const typeOptions = draft.type === QuestionType.TEXT ? [...EDITABLE_TYPES, QuestionType.TEXT] : EDITABLE_TYPES;

  const set = <K extends keyof QuestionDraft>(key: K, value: QuestionDraft[K]) => setDraft(prev => ({ ...prev, [key]: value }));

  const requestClose = () => {
    if (busy) return;
    if (dirty && !window.confirm('Discard your changes to this question?')) return;
    onClose();
  };

  const changeType = (type: QuestionType) => {
    setDraft(prev => {
      const next = { ...prev, type, correctIdx: 0, correctIndices: [] as number[] };
      // TRUE_FALSE / YES_NO have fixed options; going back to a choice type starts from 4 blank slots.
      if ((type === QuestionType.MCQ || type === QuestionType.MULTI_SELECT) && prev.options.length < 2) next.options = ['', '', '', ''];
      return next;
    });
  };

  const setOption = (i: number, value: string) => setDraft(prev => {
    const options = [...prev.options];
    options[i] = value;
    return { ...prev, options };
  });

  const addOption = () => setDraft(prev => (prev.options.length >= MAX_OPTIONS ? prev : { ...prev, options: [...prev.options, ''] }));

  const removeOption = (idx: number) => setDraft(prev => {
    if (prev.options.length <= 2) return prev;
    return {
      ...prev,
      options: prev.options.filter((_, i) => i !== idx),
      correctIdx: prev.correctIdx === idx ? 0 : prev.correctIdx > idx ? prev.correctIdx - 1 : prev.correctIdx,
      correctIndices: prev.correctIndices.filter(x => x !== idx).map(x => (x > idx ? x - 1 : x)),
    };
  });

  const toggleCorrect = (i: number) => setDraft(prev => ({
    ...prev,
    correctIndices: prev.correctIndices.includes(i) ? prev.correctIndices.filter(x => x !== i) : [...prev.correctIndices, i],
  }));

  const setBlank = (i: number, value: string) => setDraft(prev => {
    const blanks = [...prev.blanks];
    blanks[i] = value;
    return { ...prev, blanks };
  });

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const built = buildQuestion(draft);
    if ('error' in built) {
      setError(built.error);
      return;
    }
    setBusy(true);
    setError('');
    try {
      if (question) {
        const res = await apiPost<{ question: BankQuestion }>(API, { action: 'UPDATE_QUESTION', bankId, question: { ...built.question, id: question.id } });
        onUpdated(res.question);
      } else {
        const res = await apiPost<{ bank: BankDetail; added: number; errors: { index: number; message: string }[] }>(API, {
          action: 'ADD_QUESTIONS', bankId, questions: [built.question],
        });
        onAdded(res.bank);
      }
    } catch (err) {
      const rowErrors = readServerRowErrors(err);
      setError(rowErrors?.[0]?.message || getApiErrorMessage(err, 'Could not save the question.'));
      setBusy(false);
    }
  };

  const choiceType = draft.type === QuestionType.MCQ || draft.type === QuestionType.MULTI_SELECT;
  const binaryType = draft.type === QuestionType.TRUE_FALSE || draft.type === QuestionType.YES_NO;
  const binaryLabels = draft.type === QuestionType.TRUE_FALSE ? ['True', 'False'] : ['Yes', 'No'];

  return (
    <Modal titleId="question-editor-title" onClose={requestClose} busy={busy} closeOnBackdrop={false} size="lg">
      <form onSubmit={save} className="p-6 space-y-4">
        <div className="flex items-start justify-between gap-3">
          <h3 id="question-editor-title" className="text-lg font-semibold text-slate-900">{question ? 'Edit question' : 'Add question'}</h3>
          <button type="button" onClick={requestClose} disabled={busy} aria-label="Close" className="text-slate-400 hover:text-slate-600 disabled:opacity-50">
            <X size={18} />
          </button>
        </div>

        {question && usedIn > 0 && (
          <div role="note" className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
            <FileWarning size={16} className="mt-0.5 shrink-0" />
            <span>Used in {plural(usedIn, 'exam')} — changes apply to all of them.</span>
          </div>
        )}
        {error && <div role="alert" className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</div>}

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div className="sm:col-span-1">
            <label htmlFor="q-type" className={labelCls}>Type</label>
            <select id="q-type" className={inputCls} value={draft.type} onChange={e => changeType(e.target.value as QuestionType)}>
              {typeOptions.map(t => <option key={t} value={t}>{typeLabel(t)}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="q-marks" className={labelCls}>Marks</label>
            <input id="q-marks" type="number" inputMode="numeric" min={1} max={1000} step={1} className={inputCls} value={draft.marks} onChange={e => set('marks', e.target.value)} />
          </div>
          <div>
            <label htmlFor="q-neg" className={labelCls}>Negative marks</label>
            <input
              id="q-neg"
              type="number"
              inputMode="decimal"
              min={0}
              step={0.25}
              className={`${inputCls} disabled:bg-slate-50 disabled:text-slate-400`}
              value={manual ? '0' : draft.negativeMarks}
              disabled={manual}
              title={manual ? 'Not used for manually graded questions' : 'Deducted when answered but wrong (0 = none)'}
              onChange={e => set('negativeMarks', e.target.value)}
            />
          </div>
        </div>

        <div>
          <label htmlFor="q-text" className={labelCls}>Question</label>
          <textarea
            id="q-text"
            className={`${inputCls} min-h-[90px]`}
            value={draft.text}
            maxLength={10000}
            autoFocus
            placeholder={draft.type === QuestionType.FILL_BLANK ? 'e.g. ___ is the capital of France.' : 'Type the question…'}
            onChange={e => set('text', e.target.value)}
          />
        </div>

        {choiceType && (
          <fieldset className="space-y-2">
            <legend className={labelCls}>
              Options — {draft.type === QuestionType.MCQ ? 'select the correct one' : 'tick every correct one'}
            </legend>
            {draft.options.map((opt, i) => {
              const letter = String.fromCharCode(65 + i);
              return (
                <div key={i} className="flex items-center gap-2">
                  {draft.type === QuestionType.MCQ ? (
                    <input type="radio" name="q-correct" className="h-4 w-4 shrink-0" checked={draft.correctIdx === i} onChange={() => set('correctIdx', i)} aria-label={`Option ${letter} is correct`} />
                  ) : (
                    <input type="checkbox" className="h-4 w-4 shrink-0" checked={draft.correctIndices.includes(i)} onChange={() => toggleCorrect(i)} aria-label={`Option ${letter} is correct`} />
                  )}
                  <span className="w-5 shrink-0 text-xs font-bold text-slate-400">{letter}.</span>
                  <input className={inputCls} value={opt} maxLength={1000} placeholder={`Option ${letter}`} aria-label={`Option ${letter}`} onChange={e => setOption(i, e.target.value)} />
                  <button type="button" onClick={() => removeOption(i)} disabled={draft.options.length <= 2} aria-label={`Remove option ${letter}`} className="shrink-0 p-1.5 text-slate-400 hover:text-rose-600 disabled:opacity-30">
                    <X size={15} />
                  </button>
                </div>
              );
            })}
            {draft.options.length < MAX_OPTIONS && (
              <button type="button" onClick={addOption} className="inline-flex items-center gap-1 text-xs font-semibold text-[var(--lsc-primary)] hover:underline">
                <Plus size={13} /> Add option
              </button>
            )}
          </fieldset>
        )}

        {binaryType && (
          <fieldset>
            <legend className={labelCls}>Correct answer</legend>
            <div className="flex flex-wrap gap-2">
              {binaryLabels.map((lbl, i) => (
                <label key={lbl} className={`inline-flex cursor-pointer items-center gap-2 rounded-lg border px-4 py-2 text-sm ${draft.correctIdx === i ? 'border-[var(--lsc-primary)] bg-[var(--lsc-primary-50)] text-[var(--lsc-primary)] font-semibold' : 'border-slate-200 text-slate-600'}`}>
                  <input type="radio" name="q-binary" className="h-4 w-4" checked={draft.correctIdx === i} onChange={() => set('correctIdx', i)} />
                  {lbl}
                </label>
              ))}
            </div>
          </fieldset>
        )}

        {manual && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label htmlFor="q-wordlimit" className={labelCls}>Word limit <span className="font-normal text-slate-400">(optional)</span></label>
              <input id="q-wordlimit" type="number" inputMode="numeric" min={1} step={1} className={inputCls} value={draft.wordLimit} placeholder="No limit" onChange={e => set('wordLimit', e.target.value)} />
            </div>
            <p className="self-end text-xs text-slate-400 sm:pb-2">Graded manually by an admin after the exam.</p>
          </div>
        )}

        {draft.type === QuestionType.FILL_BLANK && (
          <fieldset className="space-y-2">
            <legend className={labelCls}>Accepted answers per blank — separate alternates with |</legend>
            {draft.blanks.map((b, i) => (
              <div key={i} className="flex items-center gap-2">
                <span className="w-14 shrink-0 text-xs font-semibold text-slate-400">Blank {i + 1}</span>
                <input className={inputCls} value={b} placeholder="e.g. paris | Paris" aria-label={`Accepted answers for blank ${i + 1}`} onChange={e => setBlank(i, e.target.value)} />
                <button
                  type="button"
                  onClick={() => setDraft(prev => ({ ...prev, blanks: prev.blanks.filter((_, j) => j !== i) }))}
                  disabled={draft.blanks.length <= 1}
                  aria-label={`Remove blank ${i + 1}`}
                  className="shrink-0 p-1.5 text-slate-400 hover:text-rose-600 disabled:opacity-30"
                >
                  <X size={15} />
                </button>
              </div>
            ))}
            {draft.blanks.length < MAX_BLANKS && (
              <button type="button" onClick={() => setDraft(prev => ({ ...prev, blanks: [...prev.blanks, ''] }))} className="inline-flex items-center gap-1 text-xs font-semibold text-[var(--lsc-primary)] hover:underline">
                <Plus size={13} /> Add blank
              </button>
            )}
            <p className="text-[11px] text-slate-400">Answers are matched case-insensitively; blanks are checked in order.</p>
          </fieldset>
        )}

        {draft.type === QuestionType.NUMERIC && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label htmlFor="q-num" className={labelCls}>Expected value</label>
              <input id="q-num" type="number" inputMode="decimal" step="any" className={inputCls} value={draft.numericValue} onChange={e => set('numericValue', e.target.value)} />
            </div>
            <div>
              <label htmlFor="q-tol" className={labelCls}>Tolerance ± <span className="font-normal text-slate-400">(blank = exact)</span></label>
              <input id="q-tol" type="number" inputMode="decimal" min={0} step="any" className={inputCls} value={draft.numericTolerance} onChange={e => set('numericTolerance', e.target.value)} />
            </div>
          </div>
        )}

        {draft.type === QuestionType.DATE && (
          <div className="sm:w-1/2">
            <label htmlFor="q-date" className={labelCls}>Correct date</label>
            <input id="q-date" type="date" className={inputCls} value={draft.dateValue} onChange={e => set('dateValue', e.target.value)} />
          </div>
        )}

        {draft.type === QuestionType.TIME && (
          <div className="sm:w-1/2">
            <label htmlFor="q-time" className={labelCls}>Correct time (24-hour)</label>
            <input id="q-time" type="time" className={inputCls} value={draft.timeValue} onChange={e => set('timeValue', e.target.value)} />
          </div>
        )}

        <div className="flex flex-col-reverse gap-3 pt-2 sm:flex-row sm:justify-end">
          <button type="button" onClick={requestClose} disabled={busy} className="px-5 py-2 lsc-button-ghost text-sm">Cancel</button>
          <button type="submit" disabled={busy} className="inline-flex items-center justify-center gap-2 px-5 py-2 lsc-button-primary text-sm">
            {busy && <Loader2 size={15} className="animate-spin" />}
            {busy ? 'Saving…' : question ? 'Save changes' : 'Add question'}
          </button>
        </div>
      </form>
    </Modal>
  );
};

/* ---------------------------------------------------------------------------------------------- */
/* Read-only view (structured types, and the answer key preview)                                  */
/* ---------------------------------------------------------------------------------------------- */

const AnswerSummary: React.FC<{ q: BankQuestion }> = ({ q }) => {
  const box = 'rounded-lg border border-slate-100 bg-slate-50 p-3 text-sm text-slate-700';
  if ((q.type === QuestionType.MCQ || q.type === QuestionType.MULTI_SELECT || q.type === QuestionType.TRUE_FALSE || q.type === QuestionType.YES_NO) && q.options?.length) {
    const correct = new Set<number>(
      q.type === QuestionType.MULTI_SELECT
        ? q.answerKey?.correctIndices || []
        : typeof q.correctOptionIndex === 'number' ? [q.correctOptionIndex] : [],
    );
    return (
      <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {q.options.map((opt, i) => (
          <li key={i} className={`rounded-lg border p-2 text-sm break-words ${correct.has(i) ? 'border-teal-200 bg-teal-50 text-teal-800' : 'border-slate-100 bg-slate-50 text-slate-600'}`}>
            <span className="mr-2 font-bold">{String.fromCharCode(65 + i)}.</span>{opt}
            {correct.has(i) && <span className="sr-only"> (correct)</span>}
          </li>
        ))}
      </ul>
    );
  }
  switch (q.type) {
    case QuestionType.FILL_BLANK:
      return (
        <ol className={`${box} list-decimal pl-8 space-y-1`}>
          {(q.answerKey?.blanks || []).map((b, i) => <li key={i} className="break-words">{(b.accepted || []).join(' / ')}</li>)}
        </ol>
      );
    case QuestionType.NUMERIC:
      return <p className={box}>Answer: {String(q.answerKey?.value ?? '—')}{q.answerKey?.tolerance != null ? ` ± ${q.answerKey.tolerance}` : ' (exact)'}</p>;
    case QuestionType.DATE:
    case QuestionType.TIME:
      return <p className={box}>Answer: {String(q.answerKey?.value ?? '—')}</p>;
    case QuestionType.MATCHING: {
      const left = q.matchOptions?.left || [];
      const right = q.matchOptions?.right || [];
      const pairs = (q.answerKey?.pairs || {}) as Record<number, number>;
      return (
        <ul className={`${box} space-y-1`}>
          {left.map((l, i) => <li key={i} className="break-words">{l} <span className="text-slate-400">↔</span> {right[pairs[i] ?? i] ?? '—'}</li>)}
        </ul>
      );
    }
    case QuestionType.ORDERING: {
      const items = q.matchOptions?.items || [];
      const order = q.answerKey?.order || items.map((_, i) => i);
      return (
        <ol className={`${box} list-decimal pl-8 space-y-1`}>
          {order.map((idx, i) => <li key={i} className="break-words">{items[idx] ?? '—'}</li>)}
        </ol>
      );
    }
    case QuestionType.DRAG_DROP: {
      const items = q.matchOptions?.items || [];
      const buckets = q.matchOptions?.buckets || [];
      const placements = (q.answerKey?.placements || {}) as Record<number, number>;
      return (
        <ul className={`${box} space-y-1`}>
          {items.map((it, i) => <li key={i} className="break-words">{it} <span className="text-slate-400">→</span> {buckets[placements[i]] ?? '—'}</li>)}
        </ul>
      );
    }
    default:
      return <p className={box}>Graded manually{q.wordLimit ? ` · word limit ${q.wordLimit}` : ''}.</p>;
  }
};

const QuestionViewModal: React.FC<{ question: BankQuestion; onClose: () => void }> = ({ question, onClose }) => (
  <Modal titleId="question-view-title" onClose={onClose} size="lg">
    <div className="p-6 space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <h3 id="question-view-title" className="text-lg font-semibold text-slate-900">Question</h3>
          <TypeChip type={question.type} />
        </div>
        <button type="button" onClick={onClose} aria-label="Close" autoFocus className="text-slate-400 hover:text-slate-600"><X size={18} /></button>
      </div>
      {!isEditableType(question.type) && (
        <p className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-500">
          Edit not supported here: {typeLabel(question.type)} questions are shown read-only in the Question Bank.
        </p>
      )}
      <p className="whitespace-pre-wrap break-words text-sm text-slate-800">{question.text}</p>
      <AnswerSummary q={question} />
      <div className="flex flex-wrap gap-2 text-xs">
        <span className="lsc-badge">{plural(question.marks, 'mark')}</span>
        {(question.negativeMarks ?? 0) > 0 && <span className="lsc-badge">−{question.negativeMarks} if wrong</span>}
        <span className="lsc-badge">Used in {plural(question.examCount ?? 0, 'exam')}</span>
      </div>
      <div className="flex justify-end pt-2">
        <button type="button" onClick={onClose} className="px-5 py-2 lsc-button-ghost text-sm">Close</button>
      </div>
    </div>
  </Modal>
);

/* ---------------------------------------------------------------------------------------------- */
/* Question delete                                                                                 */
/* ---------------------------------------------------------------------------------------------- */

const DeleteQuestionModal: React.FC<{
  bankId: number;
  question: BankQuestion;
  onClose: () => void;
  onDeleted: (keptForExams: boolean) => void;
}> = ({ bankId, question, onClose, onDeleted }) => {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const usedIn = question.examCount ?? 0;

  const confirm = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const res = await apiPost<{ ok: boolean; keptForExams: boolean }>(API, { action: 'DELETE_QUESTION', bankId, questionId: question.id });
      onDeleted(!!res.keptForExams);
    } catch (err) {
      setError(getApiErrorMessage(err, 'Could not delete the question.'));
      setBusy(false);
    }
  };

  return (
    <Modal titleId="delete-question-title" onClose={onClose} busy={busy}>
      <div className="p-6">
        <div className="flex items-start gap-3">
          <div className="lsc-icon-tile-danger p-2.5 shrink-0"><Trash2 size={18} /></div>
          <div className="min-w-0">
            <h3 id="delete-question-title" className="text-lg font-semibold text-slate-900">Remove question from bank?</h3>
            <p className="mt-1 text-sm text-slate-500 break-words">“{snippet(question.text, 140)}”</p>
            <p className="mt-3 text-sm text-slate-600">
              {usedIn > 0
                ? <>It’s used in {plural(usedIn, 'exam')}, so it is only removed from this bank — {usedIn === 1 ? 'that exam keeps' : 'those exams keep'} it unchanged.</>
                : <>No exam uses it, so it will be deleted permanently. This can’t be undone.</>}
            </p>
            {error && <p role="alert" className="mt-3 text-sm text-rose-600">{error}</p>}
          </div>
        </div>
        <div className="mt-6 flex justify-end gap-3">
          <button type="button" onClick={onClose} disabled={busy} autoFocus className="px-5 py-2 lsc-button-ghost text-sm">Cancel</button>
          <button type="button" onClick={confirm} disabled={busy} className={dangerBtn}>
            {busy && <Loader2 size={15} className="animate-spin" />}
            {busy ? 'Removing…' : usedIn > 0 ? 'Remove from bank' : 'Delete question'}
          </button>
        </div>
      </div>
    </Modal>
  );
};

/* ---------------------------------------------------------------------------------------------- */
/* CSV upload                                                                                      */
/* ---------------------------------------------------------------------------------------------- */

interface CsvPreview {
  fileName: string;
  questions: Question[];
  errors: QuestionCsvError[];
}

interface CsvResult {
  added: number;
  rejected: { label: string; message: string }[];
  failure?: string; // a part could not be sent (network / server); later parts were not attempted
}

const CsvUploadPanel: React.FC<{
  bankId: number;
  onUploaded: (detail: BankDetail) => void;
  onClose: () => void;
}> = ({ bankId, onUploaded, onClose }) => {
  const fileInput = useRef<HTMLInputElement>(null);
  const [dragActive, setDragActive] = useState(false);
  const [reading, setReading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [readError, setReadError] = useState('');
  const [preview, setPreview] = useState<CsvPreview | null>(null);
  const [result, setResult] = useState<CsvResult | null>(null);
  const [progress, setProgress] = useState('');
  const busy = reading || uploading;

  const typeCounts = useMemo(() => {
    const counts = new Map<QuestionType, number>();
    (preview?.questions || []).forEach(q => counts.set(q.type, (counts.get(q.type) || 0) + 1));
    return Array.from(counts.entries());
  }, [preview]);

  const handleFile = async (file: File) => {
    if (busy) return;
    setReadError('');
    setResult(null);
    setPreview(null);
    if (!/\.csv$/i.test(file.name)) {
      setReadError('Choose a .csv file (Excel: File → Save As → CSV UTF-8).');
      return;
    }
    if (file.size > MAX_CSV_BYTES) {
      setReadError('That file is larger than 5 MB. Split it into smaller files.');
      return;
    }
    setReading(true);
    try {
      const text = await readCsvFileText(file);
      const parsed = parseQuestionCsv(text);
      if (parsed.questions.length === 0 && parsed.errors.length === 0) {
        setReadError('No question rows found. Use the template: one question per row under the header.');
      } else {
        setPreview({ fileName: file.name, ...parsed });
      }
    } catch (e) {
      setReadError(getApiErrorMessage(e, 'Could not read that file.'));
    } finally {
      setReading(false);
    }
  };

  const handleDrag = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (busy) return;
    if (e.type === 'dragenter' || e.type === 'dragover') setDragActive(true);
    else if (e.type === 'dragleave') setDragActive(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    const file = e.dataTransfer.files?.[0];
    if (file) handleFile(file);
  };

  // Sent in parts of MAX_PER_REQUEST (the server's cap); each part is its own transaction.
  const upload = async () => {
    if (!preview || preview.questions.length === 0 || uploading) return;
    setUploading(true);
    setResult(null);
    const all = preview.questions;
    const out: CsvResult = { added: 0, rejected: [] };
    let latest: BankDetail | null = null;
    const label = (i: number) => `Question ${i + 1} (“${snippet(all[i]?.text || '', 40)}”)`;
    try {
      for (let start = 0; start < all.length; start += MAX_PER_REQUEST) {
        const part = all.slice(start, start + MAX_PER_REQUEST);
        if (all.length > MAX_PER_REQUEST) setProgress(`Sending ${start + 1}–${start + part.length} of ${all.length}…`);
        try {
          const res = await apiPost<{ bank: BankDetail; added: number; errors: { index: number; message: string }[] }>(API, {
            action: 'ADD_QUESTIONS', bankId, questions: part,
          });
          latest = res.bank;
          out.added += res.added || 0;
          (res.errors || []).forEach(er => out.rejected.push({ label: label(start + er.index), message: er.message }));
        } catch (e) {
          const rowErrors = readServerRowErrors(e);
          if (rowErrors) {
            // Every row of this part was rejected — report them and carry on with the next part.
            rowErrors.forEach(er => out.rejected.push({ label: label(start + er.index), message: er.message }));
            continue;
          }
          out.failure = `${getApiErrorMessage(e, 'Upload failed.')}${start > 0 ? ` Questions ${start + 1}–${all.length} were not added.` : ''}`;
          break;
        }
      }
    } finally {
      setUploading(false);
      setProgress('');
    }
    if (latest) onUploaded(latest);
    setResult(out);
    if (out.added > 0) setPreview(null);
  };

  const reset = () => {
    setPreview(null);
    setResult(null);
    setReadError('');
  };

  return (
    <section className="lsc-panel overflow-hidden" aria-labelledby="csv-upload-title">
      <div className="lsc-panel-header flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h3 id="csv-upload-title" className="flex items-center gap-2 text-sm font-semibold text-slate-800"><FileSpreadsheet size={16} /> Upload questions from CSV</h3>
          <p className="mt-0.5 text-xs text-slate-500">Same format as the exam editor’s question upload. Rows that fail validation are skipped.</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button type="button" onClick={downloadTemplate} className="inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm lsc-button-ghost">
            <Download size={14} /> Download template
          </button>
          <button type="button" onClick={onClose} disabled={uploading} aria-label="Close CSV upload" className="rounded-lg p-2 text-slate-400 hover:bg-slate-50 hover:text-slate-600 disabled:opacity-50">
            <X size={16} />
          </button>
        </div>
      </div>

      <div className="space-y-4 p-4">
        <div
          className={`flex flex-col items-center justify-center rounded-xl border-2 border-dashed p-6 text-center transition-colors ${
            dragActive ? 'border-[var(--lsc-primary)] bg-[var(--lsc-primary-50)]' : busy ? 'border-slate-200 bg-white cursor-wait' : 'border-slate-300 bg-slate-50 hover:border-[var(--lsc-primary)] hover:bg-white cursor-pointer'
          }`}
          onDragEnter={handleDrag}
          onDragLeave={handleDrag}
          onDragOver={handleDrag}
          onDrop={handleDrop}
          onClick={() => { if (!busy) fileInput.current?.click(); }}
          onKeyDown={e => {
            if ((e.key === 'Enter' || e.key === ' ') && !busy) {
              e.preventDefault();
              fileInput.current?.click();
            }
          }}
          role="button"
          tabIndex={0}
          aria-label="Choose a question CSV file, or drop one here"
          aria-disabled={busy}
        >
          <input
            ref={fileInput}
            type="file"
            accept=".csv,text/csv"
            className="hidden"
            disabled={busy}
            onChange={e => {
              const file = e.target.files?.[0];
              e.target.value = ''; // picking the same (fixed) file again must still fire onChange
              if (file) handleFile(file);
            }}
          />
          {reading ? (
            <Loader2 size={28} className="animate-spin text-[var(--lsc-primary)]" />
          ) : (
            <Upload size={28} className={dragActive ? 'text-[var(--lsc-primary)]' : 'text-slate-400'} />
          )}
          <p className="mt-3 text-sm font-semibold text-slate-700">{reading ? 'Reading file…' : dragActive ? 'Drop the file here' : 'Choose a CSV file or drag it here'}</p>
          <p className="mt-1 text-xs text-slate-500">MCQ, Multi-select, True/False, Yes/No, Short/Long text, Fill blank, Numeric, Date, Time · up to 5 MB</p>
        </div>

        {readError && (
          <div role="alert" className="flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
            <AlertCircle size={16} className="mt-0.5 shrink-0" /> {readError}
          </div>
        )}

        {preview && (
          <div className="space-y-3" aria-live="polite">
            <div className="flex flex-col gap-3 rounded-lg border border-slate-200 bg-white p-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-slate-800" title={preview.fileName}>{preview.fileName}</p>
                <div className="mt-1 flex flex-wrap items-center gap-2 text-xs">
                  <span className="lsc-chip-success">{plural(preview.questions.length, 'valid question')}</span>
                  {preview.errors.length > 0 && <span className="lsc-chip-danger">{plural(preview.errors.length, 'row')} with errors</span>}
                  {typeCounts.map(([t, n]) => <span key={t} className="text-slate-500">{typeLabel(t)} {n}</span>)}
                </div>
              </div>
              <div className="flex shrink-0 gap-2">
                <button type="button" onClick={reset} disabled={uploading} className="px-4 py-2 text-sm lsc-button-ghost">Clear</button>
                <button
                  type="button"
                  onClick={upload}
                  disabled={uploading || preview.questions.length === 0}
                  className="inline-flex items-center gap-2 px-4 py-2 text-sm lsc-button-primary"
                >
                  {uploading ? <Loader2 size={15} className="animate-spin" /> : <Plus size={15} />}
                  {uploading ? (progress || 'Adding…') : `Add ${plural(preview.questions.length, 'question')}`}
                </button>
              </div>
            </div>
            {preview.errors.length > 0 && (
              <div className="overflow-hidden rounded-lg border border-rose-200">
                <div className="flex items-center gap-2 border-b border-rose-100 bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-800">
                  <FileWarning size={14} /> These rows will be skipped — fix them in the file and upload again
                </div>
                <ul className="max-h-56 divide-y divide-rose-50 overflow-auto text-xs">
                  {preview.errors.map((er, i) => (
                    <li key={i} className="flex gap-3 px-3 py-2">
                      <span className="w-14 shrink-0 font-semibold text-rose-700">Row {er.row}</span>
                      <span className="min-w-0 text-slate-600 break-words">{er.message}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        {result && (
          <div className="space-y-2" aria-live="polite">
            {result.added > 0 && (
              <div role="status" className="flex items-start gap-2 rounded-lg border border-teal-200 bg-teal-50 px-3 py-2 text-sm text-teal-700">
                <CheckCircle size={16} className="mt-0.5 shrink-0" /> Added {plural(result.added, 'question')} to this bank.
              </div>
            )}
            {result.failure && (
              <div role="alert" className="flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
                <AlertCircle size={16} className="mt-0.5 shrink-0" /> {result.failure}
              </div>
            )}
            {result.rejected.length > 0 && (
              <div className="overflow-hidden rounded-lg border border-amber-200">
                <div className="border-b border-amber-100 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-800">
                  The server rejected {plural(result.rejected.length, 'question')}
                </div>
                <ul className="max-h-48 divide-y divide-amber-50 overflow-auto text-xs">
                  {result.rejected.map((r, i) => (
                    <li key={i} className="px-3 py-2"><span className="font-semibold text-slate-700">{r.label}:</span> <span className="text-slate-600">{r.message}</span></li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
};

/* ---------------------------------------------------------------------------------------------- */
/* Bank detail                                                                                     */
/* ---------------------------------------------------------------------------------------------- */

const BankDetailView: React.FC<{
  bankId: number;
  onBack: () => void;
}> = ({ bankId, onBack }) => {
  const [bank, setBank] = useState<BankDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [notice, setNotice] = useState<Notice | null>(null);
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState<QuestionType | ''>('');
  const [showUpload, setShowUpload] = useState(false);
  const [editing, setEditing] = useState<BankQuestion | 'new' | null>(null);
  const [viewing, setViewing] = useState<BankQuestion | null>(null);
  const [deleting, setDeleting] = useState<BankQuestion | null>(null);
  const [editingBank, setEditingBank] = useState(false);

  const load = async () => {
    setLoading(true);
    setLoadError('');
    try {
      const res = await apiGet<{ bank: BankDetail }>(`${API}?id=${bankId}`);
      setBank(res.bank);
      if ((res.bank?.questions || []).length === 0) setShowUpload(true);
    } catch (e) {
      setLoadError(getApiErrorMessage(e, 'Could not load this question bank.'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bankId]);

  const questions = bank?.questions || [];
  const position = useMemo(() => new Map(questions.map((q, i) => [q.id, i + 1])), [questions]);
  const presentTypes = useMemo(() => {
    const counts = new Map<QuestionType, number>();
    questions.forEach(q => counts.set(q.type, (counts.get(q.type) || 0) + 1));
    return Array.from(counts.entries()).sort((a, b) => typeLabel(a[0]).localeCompare(typeLabel(b[0])));
  }, [questions]);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return questions.filter(q => {
      if (typeFilter && q.type !== typeFilter) return false;
      if (!term) return true;
      return [q.text, ...(q.options || [])].join(' ').toLowerCase().includes(term);
    });
  }, [questions, search, typeFilter]);

  const paging = usePagination(filtered, `${search}|${typeFilter}`);

  const usedQuestionCount = questions.filter(q => (q.examCount ?? 0) > 0).length;

  if (loading && !bank) {
    return (
      <div className="lsc-panel flex items-center justify-center gap-2 p-10 text-sm text-slate-500" role="status">
        <Loader2 size={18} className="animate-spin" /> Loading question bank…
      </div>
    );
  }

  if (!bank) {
    return (
      <div className="space-y-4">
        <button type="button" onClick={onBack} className="inline-flex items-center gap-1.5 text-sm font-medium text-[var(--lsc-primary)] hover:underline">
          <ArrowLeft size={15} /> All question banks
        </button>
        <div className="lsc-panel p-8 text-center" role="alert">
          <AlertCircle size={28} className="mx-auto text-rose-500" />
          <p className="mt-3 text-sm text-slate-700">{loadError || 'Could not load this question bank.'}</p>
          <button type="button" onClick={load} className="mt-4 inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm lsc-button-ghost">
            <RefreshCcw size={14} /> Try again
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div>
        <button type="button" onClick={onBack} className="inline-flex items-center gap-1.5 text-sm font-medium text-[var(--lsc-primary)] hover:underline">
          <ArrowLeft size={15} /> All question banks
        </button>
        <div className="mt-3 flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0">
            <h2 className="lsc-title break-words">{bank.name}</h2>
            {bank.description && <p className="lsc-subtitle mt-1 whitespace-pre-wrap break-words">{bank.description}</p>}
            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
              <span className="lsc-chip-primary">{plural(bank.questionCount, 'question')}</span>
              <span className={bank.examCount > 0 ? 'lsc-chip-success' : 'lsc-chip-neutral'}>Used by {plural(bank.examCount, 'exam')}</span>
              <span className="text-slate-400">Updated {formatDateTime(bank.updatedAt)}</span>
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap gap-2">
            <button type="button" onClick={() => setEditingBank(true)} className="inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm lsc-button-ghost">
              <Pencil size={14} /> Edit details
            </button>
            <button type="button" onClick={() => setShowUpload(s => !s)} aria-expanded={showUpload} className="inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm lsc-button-ghost">
              <Upload size={14} /> Upload CSV {showUpload ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            </button>
            <button type="button" onClick={() => setEditing('new')} className="inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm lsc-button-primary">
              <Plus size={14} /> Add question
            </button>
          </div>
        </div>
      </div>

      <NoticeBanner notice={notice} onDismiss={() => setNotice(null)} />

      {showUpload && (
        <CsvUploadPanel
          bankId={bank.id}
          onClose={() => setShowUpload(false)}
          onUploaded={detail => setBank(detail)}
        />
      )}

      <div className="lsc-panel overflow-hidden">
        <div className="lsc-panel-header flex flex-col gap-3 p-4 md:flex-row md:items-center md:justify-between">
          <div className="text-sm font-semibold text-slate-800">
            Questions
            {usedQuestionCount > 0 && <span className="ml-2 text-xs font-normal text-slate-500">{usedQuestionCount} used in exams</span>}
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <select
              className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700 outline-none"
              value={typeFilter}
              onChange={e => setTypeFilter(e.target.value as QuestionType | '')}
              aria-label="Filter by question type"
            >
              <option value="">All types</option>
              {presentTypes.map(([t, n]) => <option key={t} value={t}>{typeLabel(t)} ({n})</option>)}
            </select>
            <div className="relative">
              <Search className="absolute left-3 top-2.5 text-slate-400" size={14} />
              <input
                type="search"
                className="w-full rounded-lg border border-slate-200 bg-white py-2 pl-8 pr-3 text-xs outline-none sm:w-64"
                placeholder="Search questions or options…"
                aria-label="Search questions"
                value={search}
                onChange={e => setSearch(e.target.value)}
              />
            </div>
          </div>
        </div>

        {questions.length === 0 ? (
          <div className="p-10 text-center">
            <Library size={28} className="mx-auto text-slate-300" />
            <p className="mt-3 text-sm font-semibold text-slate-700">No questions in this bank yet</p>
            <p className="mt-1 text-xs text-slate-500">Upload a CSV (download the template above) or add questions one by one.</p>
            <div className="mt-4 flex flex-wrap justify-center gap-2">
              {!showUpload && (
                <button type="button" onClick={() => setShowUpload(true)} className="inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm lsc-button-ghost">
                  <Upload size={14} /> Upload CSV
                </button>
              )}
              <button type="button" onClick={() => setEditing('new')} className="inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm lsc-button-primary">
                <Plus size={14} /> Add a question
              </button>
            </div>
          </div>
        ) : filtered.length === 0 ? (
          <div className="p-8 text-center text-sm text-slate-500">
            No questions match your filters.{' '}
            <button type="button" className="font-semibold text-[var(--lsc-primary)] hover:underline" onClick={() => { setSearch(''); setTypeFilter(''); }}>Clear filters</button>
          </div>
        ) : (
          <>
            <div className="lsc-table-wrap">
              <table className="lsc-grid w-full min-w-[720px] text-left text-sm">
                <thead>
                  <tr>
                    <th scope="col" className="w-12 px-4 py-3">#</th>
                    <th scope="col" className="w-32 px-4 py-3">Type</th>
                    <th scope="col" className="px-4 py-3">Question</th>
                    <th scope="col" className="w-20 px-4 py-3 text-right">Marks</th>
                    <th scope="col" className="w-24 px-4 py-3 text-right">Negative</th>
                    <th scope="col" className="w-32 px-4 py-3">Used in</th>
                    <th scope="col" className="w-24 px-4 py-3 text-right"><span className="sr-only">Actions</span></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {paging.pageItems.map(q => {
                    const editable = isEditableType(q.type);
                    const used = q.examCount ?? 0;
                    const shortText = snippet(q.text, 50);
                    return (
                      <tr key={q.id} className="align-top text-slate-700">
                        <td className="px-4 py-3 text-xs text-slate-400 lsc-tabular">{position.get(q.id)}</td>
                        <td className="px-4 py-3"><TypeChip type={q.type} /></td>
                        <td className="px-4 py-3">
                          <button
                            type="button"
                            onClick={() => (editable ? setEditing(q) : setViewing(q))}
                            className="block w-full text-left text-sm text-slate-800 hover:text-[var(--lsc-primary)]"
                            title={q.text}
                          >
                            <span className="line-clamp-2 break-words">{q.text}</span>
                          </button>
                        </td>
                        <td className="px-4 py-3 text-right lsc-tabular">{q.marks}</td>
                        <td className="px-4 py-3 text-right lsc-tabular text-slate-500">{(q.negativeMarks ?? 0) > 0 ? `−${q.negativeMarks}` : '—'}</td>
                        <td className="px-4 py-3 text-xs">
                          {used > 0 ? <span className="lsc-chip-success whitespace-nowrap">{plural(used, 'exam')}</span> : <span className="text-slate-400">Not used</span>}
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex justify-end gap-1">
                            {editable ? (
                              <button type="button" onClick={() => setEditing(q)} aria-label={`Edit question: ${shortText}`} title="Edit" className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-[var(--lsc-primary)]">
                                <Pencil size={15} />
                              </button>
                            ) : (
                              <button type="button" onClick={() => setViewing(q)} aria-label={`View question (edit not supported here): ${shortText}`} title="View (edit not supported here)" className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-[var(--lsc-primary)]">
                                <Eye size={15} />
                              </button>
                            )}
                            <button type="button" onClick={() => setDeleting(q)} aria-label={`Delete question: ${shortText}`} title="Delete" className="rounded-lg p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600">
                              <Trash2 size={15} />
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <Pagination state={paging} label="questions" />
          </>
        )}
      </div>

      {editing && (
        <QuestionEditorModal
          bankId={bank.id}
          question={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onAdded={detail => {
            setBank(detail);
            setEditing(null);
            setNotice({ tone: 'success', text: 'Question added.' });
          }}
          onUpdated={updated => {
            setBank(prev => prev && {
              ...prev,
              updatedAt: Date.now(),
              questions: prev.questions.map(q => (q.id === updated.id ? updated : q)),
            });
            setEditing(null);
            const used = updated.examCount ?? 0;
            setNotice({ tone: 'success', text: used > 0 ? `Question saved — updated in ${plural(used, 'exam')}.` : 'Question saved.' });
          }}
        />
      )}

      {viewing && <QuestionViewModal question={viewing} onClose={() => setViewing(null)} />}

      {deleting && (
        <DeleteQuestionModal
          bankId={bank.id}
          question={deleting}
          onClose={() => setDeleting(null)}
          onDeleted={kept => {
            const removedId = deleting.id;
            setBank(prev => {
              if (!prev) return prev;
              const remaining = prev.questions.filter(q => q.id !== removedId);
              const stillUsed = remaining.some(q => (q.examCount ?? 0) > 0);
              return {
                ...prev,
                questions: remaining,
                questionCount: remaining.length,
                updatedAt: Date.now(),
                // Exact per-bank exam usage needs the server; refresh it in the background.
                examCount: stillUsed ? prev.examCount : 0,
              };
            });
            setDeleting(null);
            setNotice({
              tone: 'success',
              text: kept
                ? 'Removed from this bank. Exams that use it keep it unchanged.'
                : 'Question deleted.',
            });
            load();
          }}
        />
      )}

      {editingBank && (
        <BankFormModal
          bank={bank}
          onClose={() => setEditingBank(false)}
          onSaved={saved => {
            setBank(prev => prev && { ...prev, ...saved, questions: prev.questions });
            setEditingBank(false);
            setNotice({ tone: 'success', text: 'Bank details saved.' });
          }}
        />
      )}
    </div>
  );
};

/* ---------------------------------------------------------------------------------------------- */
/* Banks list (screen root)                                                                        */
/* ---------------------------------------------------------------------------------------------- */

export const QuestionBank: React.FC<QuestionBankProps> = ({ role }) => {
  const isSuperAdmin = role === UserRole.SUPER_ADMIN;
  const canManage = role === UserRole.ADMIN || isSuperAdmin;
  const [companyReady] = useState(() => !isSuperAdmin || hasActiveCompany());
  const [banks, setBanks] = useState<QuestionBankInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [search, setSearch] = useState('');
  const [openBankId, setOpenBankId] = useState<number | null>(null);
  const [formBank, setFormBank] = useState<QuestionBankInfo | 'new' | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<QuestionBankInfo | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);

  const loadBanks = async () => {
    setLoading(true);
    setLoadError('');
    try {
      const res = await apiGet<{ banks: QuestionBankInfo[] }>(API);
      setBanks(res.banks || []);
    } catch (e) {
      setLoadError(getApiErrorMessage(e, 'Could not load question banks.'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (companyReady && canManage) loadBanks();
    else setLoading(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyReady, canManage]);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return banks;
    return banks.filter(b => `${b.name} ${b.description || ''}`.toLowerCase().includes(term));
  }, [banks, search]);

  const paging = usePagination(filtered, search);

  const header = (
    <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
      <div className="min-w-0">
        <h1 className="lsc-title flex items-center gap-2"><Library size={20} className="text-[var(--lsc-primary)]" /> Question Bank</h1>
        <p className="lsc-subtitle mt-1 max-w-3xl">
          Banks are reusable across exams: add them to an exam from Exams → edit exam → Add from question bank; each candidate can get a random subset.
        </p>
      </div>
      {companyReady && canManage && openBankId === null && (
        <div className="flex shrink-0 gap-2">
          <button type="button" onClick={loadBanks} disabled={loading} className="inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm lsc-button-ghost">
            <RefreshCcw size={14} className={loading ? 'animate-spin' : ''} /> Refresh
          </button>
          <button type="button" onClick={() => setFormBank('new')} className="inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm lsc-button-primary">
            <Plus size={14} /> New bank
          </button>
        </div>
      )}
    </div>
  );

  if (!canManage) {
    return (
      <div className="lsc-page space-y-6">
        {header}
        <div className="lsc-panel p-10 text-center text-sm text-slate-500">Only admins can manage question banks.</div>
      </div>
    );
  }

  if (!companyReady) {
    return (
      <div className="lsc-page space-y-6">
        {header}
        <div className="lsc-panel p-10 text-center">
          <div className="lsc-icon-tile-primary mx-auto h-12 w-12"><Library size={22} /></div>
          <p className="mt-4 text-sm font-semibold text-slate-800">Select a company in the top bar</p>
          <p className="mt-1 text-xs text-slate-500">Question banks belong to a company. Pick one in the company switcher to see and manage its banks.</p>
        </div>
      </div>
    );
  }

  if (openBankId !== null) {
    return (
      <div className="lsc-page space-y-6">
        <BankDetailView
          bankId={openBankId}
          onBack={() => {
            setOpenBankId(null);
            loadBanks();
          }}
        />
      </div>
    );
  }

  return (
    <div className="lsc-page space-y-6">
      {header}

      <NoticeBanner notice={notice} onDismiss={() => setNotice(null)} />

      {loading && banks.length === 0 ? (
        <div className="lsc-panel flex items-center justify-center gap-2 p-10 text-sm text-slate-500" role="status">
          <Loader2 size={18} className="animate-spin" /> Loading question banks…
        </div>
      ) : loadError && banks.length === 0 ? (
        <div className="lsc-panel p-8 text-center" role="alert">
          <AlertCircle size={28} className="mx-auto text-rose-500" />
          <p className="mt-3 text-sm text-slate-700">{loadError}</p>
          <button type="button" onClick={loadBanks} className="mt-4 inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm lsc-button-ghost">
            <RefreshCcw size={14} /> Try again
          </button>
        </div>
      ) : banks.length === 0 ? (
        <div className="lsc-panel p-10 text-center">
          <div className="lsc-icon-tile-primary mx-auto h-12 w-12"><Library size={22} /></div>
          <p className="mt-4 text-sm font-semibold text-slate-800">No question banks yet</p>
          <p className="mx-auto mt-1 max-w-md text-xs text-slate-500">
            Create a bank, upload its questions once from a CSV, then reuse it in as many exams as you like.
          </p>
          <button type="button" onClick={() => setFormBank('new')} className="mt-5 inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm lsc-button-primary">
            <Plus size={15} /> Create your first bank
          </button>
        </div>
      ) : (
        <div className="space-y-4">
          {loadError && (
            <div role="alert" className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{loadError}</div>
          )}
          <div className="relative max-w-md">
            <Search className="absolute left-3 top-2.5 text-slate-400" size={14} />
            <input
              type="search"
              className="w-full rounded-lg border border-slate-200 bg-white py-2 pl-8 pr-3 text-sm outline-none"
              placeholder="Search banks…"
              aria-label="Search question banks"
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </div>

          {filtered.length === 0 ? (
            <div className="lsc-panel p-8 text-center text-sm text-slate-500">
              No banks match “{search.trim()}”.{' '}
              <button type="button" className="font-semibold text-[var(--lsc-primary)] hover:underline" onClick={() => setSearch('')}>Clear search</button>
            </div>
          ) : (
            <div className="lsc-panel overflow-hidden">
              <ul className="grid grid-cols-1 gap-4 p-4 md:grid-cols-2 xl:grid-cols-3">
                {paging.pageItems.map(b => (
                  <li key={b.id} className="lsc-panel lsc-panel-interactive flex min-w-0 flex-col p-4">
                    <div className="flex items-start justify-between gap-2">
                      <button
                        type="button"
                        onClick={() => setOpenBankId(b.id)}
                        className="min-w-0 text-left text-sm font-semibold text-slate-900 break-words hover:text-[var(--lsc-primary)]"
                      >
                        {b.name}
                      </button>
                      <div className="flex shrink-0 gap-0.5">
                        <button type="button" onClick={() => setFormBank(b)} aria-label={`Edit ${b.name}`} title="Rename / edit description" className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-[var(--lsc-primary)]">
                          <Pencil size={15} />
                        </button>
                        <button type="button" onClick={() => setDeleteTarget(b)} aria-label={`Delete ${b.name}`} title="Delete bank" className="rounded-lg p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600">
                          <Trash2 size={15} />
                        </button>
                      </div>
                    </div>
                    <p className={`mt-1 line-clamp-2 text-xs break-words ${b.description ? 'text-slate-500' : 'italic text-slate-400'}`}>
                      {b.description || 'No description'}
                    </p>
                    <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
                      <span className="lsc-chip-primary">{plural(b.questionCount, 'question')}</span>
                      <span className={b.examCount > 0 ? 'lsc-chip-success' : 'lsc-chip-neutral'}>Used by {plural(b.examCount, 'exam')}</span>
                    </div>
                    <div className="mt-auto flex items-center justify-between gap-2 pt-4">
                      <span className="text-[11px] text-slate-400">Updated {formatDateTime(b.updatedAt)}</span>
                      <button type="button" onClick={() => setOpenBankId(b.id)} className="rounded-lg px-3 py-1.5 text-xs lsc-button-ghost" aria-label={`Open ${b.name}`}>
                        Open
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
              <Pagination state={paging} label="banks" />
            </div>
          )}
        </div>
      )}

      {formBank && (
        <BankFormModal
          bank={formBank === 'new' ? null : formBank}
          onClose={() => setFormBank(null)}
          onSaved={saved => {
            const creating = formBank === 'new';
            setFormBank(null);
            setBanks(prev => {
              const rest = prev.filter(b => b.id !== saved.id);
              return [...rest, saved].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
            });
            if (creating) {
              // Straight into the new bank so its questions can be uploaded.
              setOpenBankId(saved.id);
            } else {
              setNotice({ tone: 'success', text: `Saved “${saved.name}”.` });
            }
          }}
        />
      )}

      {deleteTarget && (
        <DeleteBankModal
          bank={deleteTarget}
          onClose={() => setDeleteTarget(null)}
          onDeleted={({ deletedQuestions, keptQuestions }) => {
            const name = deleteTarget.name;
            setBanks(prev => prev.filter(b => b.id !== deleteTarget.id));
            setDeleteTarget(null);
            setNotice({
              tone: 'success',
              text: `Deleted “${name}”. ${plural(deletedQuestions, 'question')} deleted`
                + (keptQuestions > 0 ? `; ${keptQuestions} kept because exams still use them.` : '.'),
            });
          }}
        />
      )}
    </div>
  );
};
