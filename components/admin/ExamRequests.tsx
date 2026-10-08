import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Inbox, Users, FileText, RefreshCw, Loader2, AlertCircle, AlertTriangle, Check, Copy, X, Plus, Trash2,
  KeyRound, Ban, Send, ShieldCheck, Mail, Download, Search, ChevronDown, ChevronRight, UserPlus, Info,
  CalendarClock, ClipboardList,
} from 'lucide-react';
import { apiGet, apiPost, getApiErrorMessage } from '../../services/api';
import { parseCsvLine } from '../../services/questionCsv';
import {
  EXAM_TIMEZONES, resolveExamTimezone, epochToZonedInput, zonedInputToEpoch,
  formatScheduleShort,
} from '../../services/timezone';
import { Pagination, usePagination } from './Pagination';
import {
  CompanyDirectoryRecord, ExamRequest, ExamRequestDetails, ExamRequestStudent, ExamRequester, ExamRequestStatus,
} from '../../types';

// Exam Requests tab (SUPER_ADMIN): exam requests employees send by email (see api/exam_requests.php,
// scripts/mail_intake.py), the employees allowed to send them, and the template they use.

const API = 'exam_requests.php';
const MAX_STUDENTS = 2000;

/** Extra fields api/exam_requests.php returns alongside the ExamRequest contract. */
type ExamRequestRow = ExamRequest & {
  senderName?: string | null;
  studentCount?: number;
  createdExamTitle?: string | null;
  bodyRedacted?: string | null;
  assignedCount?: number;
  pendingInviteCount?: number;
};

interface BankOption { id: number; name: string; questionCount: number }
interface BatchOption { id: number; name: string; studentCount: number }
interface InviteFailure { email: string; error: string }
interface InviteChunk {
  invited: number;
  inviteFailures: InviteFailure[];
  inviteRemaining: number;
  inviteCursor: string | null;
  inviteError: string | null;
  pendingTotal?: number;
}

type Tab = 'requests' | 'employees' | 'template';
type Filter = 'PENDING' | 'ATTENTION' | 'APPROVED' | 'REJECTED' | 'INVALID' | 'ALL';

const inputCls = 'w-full px-3 py-2 border border-slate-300 rounded-lg outline-none text-slate-800 bg-white text-sm disabled:bg-slate-50 disabled:text-slate-400';
const labelCls = 'block text-xs font-medium text-slate-600 mb-1';

const TEMPLATE_SUBJECT = 'EXAM REQUEST - <Exam Title>';
const TEMPLATE_BODY = `Security Code: XXXX-XXXX
Exam Title: Sales Assessment Q4
Question Bank: Sales Fundamentals
Number of Questions: 25      (ALL = whole bank)
Duration (minutes): 30
Pass Percentage: 60
Start: 2026-10-15 10:00
End: 2026-10-15 18:00
Timezone: Asia/Kolkata
Proctoring: PROCTORED        (or UNPROCTORED)
Camera: ON
Show Alerts: YES
Throw Out On Violations: NO
Batch: Batch_7                (or attach students.csv: Full Name, Email, Registration ID)
Notes: optional text for the approver`;
const CSV_SAMPLE = 'Full Name,Email,Registration ID\nAsha Rao,asha.rao@example.com,REG-1001\nBilal Khan,bilal.khan@example.com,REG-1002\n';

// ---------------------------------------------------------------------------------------------
// Small building blocks
// ---------------------------------------------------------------------------------------------

const errorList = (e: unknown): string[] => {
  const raw = e instanceof Error ? e.message : '';
  if (raw.trim().startsWith('{')) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed?.errors)) return parsed.errors.map(String);
    } catch {
      // not JSON
    }
  }
  return [];
};

const fmtDateTime = (ms?: number | null) => (ms ? new Date(ms).toLocaleString(undefined, {
  day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit',
}) : '—');

const scheduleLabel = (ms: number | null, tz: string) => (
  typeof ms === 'number' && Number.isFinite(ms) ? formatScheduleShort(ms, resolveExamTimezone(tz)) : '—'
);

const needsAttention = (r: ExamRequestRow) => r.status === 'PENDING' && r.errors.length > 0;

const STATUS_CHIP: Record<ExamRequestStatus, { cls: string; label: string }> = {
  PENDING: { cls: 'lsc-chip-primary', label: 'Pending' },
  APPROVED: { cls: 'lsc-chip-success', label: 'Approved' },
  REJECTED: { cls: 'lsc-chip-neutral', label: 'Rejected' },
  INVALID: { cls: 'lsc-chip-danger', label: 'Invalid' },
};

const StatusChip: React.FC<{ request: ExamRequestRow }> = ({ request }) => (
  <span className="inline-flex flex-wrap items-center gap-1">
    <span className={STATUS_CHIP[request.status].cls}>{STATUS_CHIP[request.status].label}</span>
    {needsAttention(request) && (
      <span className="lsc-chip-warm"><AlertTriangle size={11} /> Needs attention</span>
    )}
  </span>
);

const CopyButton: React.FC<{ value: string; label?: string }> = ({ value, label = 'Copy' }) => {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  // Only claim "Copied" once the clipboard write succeeded — codes are shown once.
  const copy = async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(value);
      setState('copied');
    } catch {
      setState('failed');
    }
    window.setTimeout(() => setState('idle'), 1600);
  };
  return (
    <button
      type="button"
      onClick={() => { void copy(); }}
      title={state === 'failed' ? 'Copy failed — select the text and copy it manually' : undefined}
      className="px-2.5 py-1.5 lsc-button-ghost text-xs inline-flex items-center gap-1.5 shrink-0"
    >
      {state === 'copied' ? <Check size={13} /> : state === 'failed' ? <AlertCircle size={13} /> : <Copy size={13} />}
      {state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : label}
    </button>
  );
};

const Notice: React.FC<{ tone: 'error' | 'success' | 'info'; children: React.ReactNode; onClose?: () => void }> = ({ tone, children, onClose }) => {
  const cls = tone === 'error'
    ? 'bg-rose-50 border-rose-200 text-rose-700'
    : tone === 'success' ? 'bg-emerald-50 border-emerald-200 text-emerald-800' : 'bg-slate-50 border-slate-200 text-slate-700';
  const Icon = tone === 'error' ? AlertCircle : tone === 'success' ? Check : Info;
  return (
    <div role={tone === 'error' ? 'alert' : 'status'} className={`flex items-start gap-2 text-sm rounded-lg border px-3.5 py-2.5 ${cls}`}>
      <Icon size={16} className="mt-0.5 shrink-0" />
      <div className="min-w-0 flex-1">{children}</div>
      {onClose && (
        <button type="button" onClick={onClose} aria-label="Dismiss" className="shrink-0 opacity-60 hover:opacity-100">
          <X size={14} />
        </button>
      )}
    </div>
  );
};

/** Centered dialog. Escape / backdrop close it unless `busy`. */
const Modal: React.FC<{
  title: string;
  onClose: () => void;
  busy?: boolean;
  wide?: boolean;
  children: React.ReactNode;
  footer?: React.ReactNode;
}> = ({ title, onClose, busy, wide, children, footer }) => {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onClose]);
  return (
    // stopPropagation: a modal opened from the request drawer must not also close the drawer.
    <div className="fixed inset-0 z-[210] bg-slate-900/50 backdrop-blur-sm flex items-center justify-center p-4" onClick={e => { e.stopPropagation(); if (!busy) onClose(); }}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={e => e.stopPropagation()}
        className={`bg-white rounded-2xl shadow-2xl w-full ${wide ? 'max-w-xl' : 'max-w-md'} border border-slate-200 overflow-hidden max-h-[90vh] flex flex-col`}
      >
        <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between gap-3">
          <h3 className="text-base font-semibold text-slate-900">{title}</h3>
          <button type="button" onClick={onClose} disabled={busy} aria-label="Close" className="text-slate-400 hover:text-slate-700 disabled:opacity-40">
            <X size={18} />
          </button>
        </div>
        <div className="px-5 py-4 text-sm text-slate-600 overflow-y-auto">{children}</div>
        {footer && <div className="px-5 py-3.5 bg-slate-50 border-t border-slate-100 flex flex-wrap justify-end gap-2">{footer}</div>}
      </div>
    </div>
  );
};

const Switch: React.FC<{ label: string; checked: boolean; disabled?: boolean; hint?: string; onChange: (v: boolean) => void }> = ({ label, checked, disabled, hint, onChange }) => (
  <label className={`flex items-start justify-between gap-3 rounded-lg border border-slate-200 px-3 py-2.5 ${disabled ? 'opacity-60' : 'cursor-pointer hover:bg-slate-50'}`}>
    <span className="min-w-0">
      <span className="block text-sm font-medium text-slate-700">{label}</span>
      {hint && <span className="block text-[11px] text-slate-400">{hint}</span>}
    </span>
    <input type="checkbox" className="mt-1 h-4 w-4 shrink-0 accent-[var(--lsc-primary)]" checked={checked} disabled={disabled} onChange={e => onChange(e.target.checked)} />
  </label>
);

const downloadText = (filename: string, content: string, type = 'text/csv') => {
  const blob = new Blob([content], { type: `${type};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
};

/** "Full Name, Email, Registration ID" rows (header optional) → students. */
const parseStudentsCsv = (text: string): ExamRequestStudent[] => {
  const rows = text.split(/\r\n|\r|\n/).map(l => l.trim()).filter(Boolean).map(l => parseCsvLine(l.includes('\t') && !l.includes(',') ? l.replace(/\t/g, ',') : l));
  if (rows.length > 0 && rows[0].some(c => /e-?mail/i.test(c)) && !rows[0].some(c => c.includes('@'))) rows.shift();
  return rows
    .map(c => ({ fullName: (c[0] || '').trim(), email: (c[1] || '').trim().toLowerCase(), registrationId: (c[2] || '').trim() }))
    .filter(s => s.fullName || s.email || s.registrationId);
};

const looksLikeEmail = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);

// ---------------------------------------------------------------------------------------------
// Request detail drawer
// ---------------------------------------------------------------------------------------------

interface DetailProps {
  request: ExamRequestRow;
  onClose: () => void;
  onChanged: () => void;
}

const StudentsEditor: React.FC<{
  students: ExamRequestStudent[];
  readOnly: boolean;
  onChange: (next: ExamRequestStudent[]) => void;
}> = ({ students, readOnly, onChange }) => {
  const paging = usePagination(students, undefined, 10);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState('');
  const [pasteNote, setPasteNote] = useState('');

  const update = (index: number, patch: Partial<ExamRequestStudent>) => {
    onChange(students.map((s, i) => (i === index ? { ...s, ...patch } : s)));
  };
  const remove = (index: number) => onChange(students.filter((_, i) => i !== index));
  const addRow = () => {
    onChange([...students, { fullName: '', email: '', registrationId: '' }]);
    paging.setPage(Math.floor(students.length / paging.pageSize));
  };
  const addPasted = () => {
    const parsed = parseStudentsCsv(pasteText);
    const seen = new Set(students.map(s => s.email).filter(Boolean));
    const fresh = parsed.filter(s => !s.email || !seen.has(s.email));
    const room = Math.max(0, MAX_STUDENTS - students.length);
    onChange([...students, ...fresh.slice(0, room)]);
    setPasteNote(`${Math.min(fresh.length, room)} added${parsed.length - fresh.length > 0 ? `, ${parsed.length - fresh.length} already listed` : ''}${fresh.length > room ? `, ${fresh.length - room} over the ${MAX_STUDENTS} limit` : ''}.`);
    setPasteText('');
  };

  return (
    <div className="rounded-xl border border-slate-200 overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5 bg-slate-50 border-b border-slate-200">
        <span className="text-xs font-semibold text-slate-600 uppercase tracking-wide">Students from CSV ({students.length})</span>
        {!readOnly && (
          <div className="flex flex-wrap gap-1.5">
            <button type="button" onClick={addRow} disabled={students.length >= MAX_STUDENTS} className="px-2.5 py-1.5 lsc-button-ghost text-xs inline-flex items-center gap-1.5">
              <Plus size={13} /> Add row
            </button>
            <button type="button" onClick={() => setPasteOpen(v => !v)} className="px-2.5 py-1.5 lsc-button-ghost text-xs inline-flex items-center gap-1.5">
              <ClipboardList size={13} /> Paste CSV
            </button>
          </div>
        )}
      </div>
      {!readOnly && pasteOpen && (
        <div className="p-3 border-b border-slate-200 space-y-2">
          <textarea
            className={`${inputCls} font-mono text-xs min-h-[90px]`}
            aria-label="Paste students as CSV"
            placeholder={'Full Name,Email,Registration ID\nAsha Rao,asha@example.com,REG-1'}
            value={pasteText}
            onChange={e => setPasteText(e.target.value)}
          />
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={addPasted} disabled={!pasteText.trim()} className="px-3 py-1.5 lsc-button-primary text-xs disabled:opacity-60">Add rows</button>
            {pasteNote && <span className="text-xs text-slate-500">{pasteNote}</span>}
          </div>
        </div>
      )}
      {students.length === 0 ? (
        <p className="px-3 py-4 text-sm text-slate-400">No CSV students{readOnly ? '.' : ' — add rows, paste a CSV, or rely on the batch.'}</p>
      ) : (
        <div className="lsc-table-wrap">
          <table className="w-full text-left text-sm lsc-grid">
            <thead>
              <tr>
                <th className="px-3 py-2 w-10">#</th>
                <th className="px-3 py-2">Full name</th>
                <th className="px-3 py-2">Email</th>
                <th className="px-3 py-2">Registration ID</th>
                {!readOnly && <th className="px-3 py-2 w-10"><span className="sr-only">Remove</span></th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {paging.pageItems.map((s, i) => {
                const index = paging.page * paging.pageSize + i;
                const badEmail = !looksLikeEmail(s.email);
                return (
                  <tr key={index}>
                    <td className="px-3 py-1.5 text-xs text-slate-400 lsc-tabular">{index + 1}</td>
                    {readOnly ? (
                      <>
                        <td className="px-3 py-2 text-slate-700">{s.fullName || '—'}</td>
                        <td className="px-3 py-2 text-slate-700 break-all">{s.email || '—'}</td>
                        <td className="px-3 py-2 text-slate-700">{s.registrationId || '—'}</td>
                      </>
                    ) : (
                      <>
                        <td className="px-2 py-1.5 min-w-[150px]">
                          <input className={`${inputCls} py-1.5 ${!s.fullName.trim() ? 'border-rose-300' : ''}`} aria-label={`Student ${index + 1} full name`} value={s.fullName} onChange={e => update(index, { fullName: e.target.value })} />
                        </td>
                        <td className="px-2 py-1.5 min-w-[190px]">
                          <input className={`${inputCls} py-1.5 ${badEmail ? 'border-rose-300' : ''}`} aria-label={`Student ${index + 1} email`} value={s.email} onChange={e => update(index, { email: e.target.value.trim().toLowerCase() })} />
                        </td>
                        <td className="px-2 py-1.5 min-w-[130px]">
                          <input className={`${inputCls} py-1.5 ${!s.registrationId.trim() ? 'border-rose-300' : ''}`} aria-label={`Student ${index + 1} registration ID`} value={s.registrationId} onChange={e => update(index, { registrationId: e.target.value })} />
                        </td>
                        <td className="px-2 py-1.5">
                          <button type="button" onClick={() => remove(index)} aria-label={`Remove student ${index + 1}`} className="p-1.5 text-slate-400 hover:text-rose-600">
                            <Trash2 size={14} />
                          </button>
                        </td>
                      </>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <Pagination state={paging} label="students" hidePageSize />
    </div>
  );
};

const KeyValue: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div className="min-w-0">
    <dt className="text-[11px] font-medium uppercase tracking-wide text-slate-400">{label}</dt>
    <dd className="text-sm text-slate-800 break-words">{children}</dd>
  </div>
);

const RequestDetail: React.FC<DetailProps> = ({ request, onClose, onChanged }) => {
  const [current, setCurrent] = useState<ExamRequestRow>(request);
  const [draft, setDraft] = useState<ExamRequestDetails>(request.details);
  const [students, setStudents] = useState<ExamRequestStudent[]>(request.students);
  const [dirty, setDirty] = useState(false);
  const [banks, setBanks] = useState<BankOption[]>([]);
  const [batches, setBatches] = useState<BatchOption[]>([]);
  const [optionsError, setOptionsError] = useState('');
  const [loadingFull, setLoadingFull] = useState(false);
  const [busy, setBusy] = useState<'' | 'save' | 'approve' | 'reject' | 'invite'>('');
  const [notice, setNotice] = useState<{ tone: 'error' | 'success' | 'info'; text: string } | null>(null);
  const [approveOpen, setApproveOpen] = useState(false);
  const [sendInvites, setSendInvites] = useState(true);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectNote, setRejectNote] = useState('');
  const [inviteProgress, setInviteProgress] = useState<{ sent: number; failed: InviteFailure[]; remaining: number; done: boolean; error: string | null } | null>(null);
  const [showBody, setShowBody] = useState(false);

  const isPending = current.status === 'PENDING';
  const tz = resolveExamTimezone(draft.timezone);
  const proctored = draft.proctoringMode === 'PROCTORED';

  const reset = useCallback((r: ExamRequestRow) => {
    setCurrent(r);
    setDraft(r.details);
    setStudents(r.students);
    setDirty(false);
  }, []);

  // Decided requests are listed without their student list; fetch it for the read-only view.
  useEffect(() => {
    if (request.status === 'PENDING' || !(request.studentCount && request.studentCount > 0) || request.students.length > 0) return;
    let cancelled = false;
    setLoadingFull(true);
    apiGet<{ request: ExamRequestRow }>(`${API}?id=${request.id}`)
      .then(res => { if (!cancelled && res?.request) reset(res.request); })
      .catch(() => { /* the summary still renders without the list */ })
      .finally(() => { if (!cancelled) setLoadingFull(false); });
    return () => { cancelled = true; };
  }, [request, reset]);

  useEffect(() => {
    if (!isPending || !current.companyId) return;
    let cancelled = false;
    apiGet<{ banks: BankOption[]; batches: BatchOption[] }>(`${API}?banksFor=${current.companyId}`)
      .then(res => {
        if (cancelled) return;
        setBanks(res?.banks || []);
        setBatches(res?.batches || []);
      })
      .catch(e => { if (!cancelled) setOptionsError(getApiErrorMessage(e, 'Could not load question banks and batches.')); });
    return () => { cancelled = true; };
  }, [isPending, current.companyId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy && !approveOpen && !rejectOpen) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, approveOpen, rejectOpen, onClose]);

  const patch = (p: Partial<ExamRequestDetails>) => {
    setDraft(d => ({ ...d, ...p }));
    setDirty(true);
  };
  const changeStudents = (next: ExamRequestStudent[]) => {
    setStudents(next);
    setDirty(true);
  };

  const bank = banks.find(b => b.id === draft.questionBankId) || null;
  const batch = draft.batchName ? batches.find(b => b.name.toLowerCase() === draft.batchName!.toLowerCase()) || null : null;
  const recipientEstimate = students.length + (batch ? batch.studentCount : 0);
  const canApprove = isPending && !busy && (dirty || current.errors.length === 0);

  const save = async () => {
    setBusy('save');
    setNotice(null);
    try {
      const res = await apiPost<{ request: ExamRequestRow; errors: string[] }>(API, { action: 'UPDATE', id: current.id, details: draft, students });
      reset(res.request);
      setNotice(res.errors.length
        ? { tone: 'info', text: `Saved. ${res.errors.length} problem${res.errors.length === 1 ? '' : 's'} still block approval.` }
        : { tone: 'success', text: 'Saved — the request is ready to approve.' });
      onChanged();
    } catch (e) {
      setNotice({ tone: 'error', text: getApiErrorMessage(e, 'Could not save the request.') });
    } finally {
      setBusy('');
    }
  };

  const reloadCurrent = async () => {
    try {
      const res = await apiGet<{ request: ExamRequestRow }>(`${API}?id=${current.id}`);
      if (res?.request) reset(res.request);
    } catch {
      // keep what we have
    }
  };

  /** Continue sending invitations chunk by chunk (each server call is time-boxed). */
  const continueInvites = async (start: InviteChunk, notifyRequester: boolean) => {
    let sent = start.invited;
    let failed = [...start.inviteFailures];
    let remaining = start.inviteRemaining;
    let cursor = start.inviteCursor;
    let error = start.inviteError;
    setInviteProgress({ sent, failed, remaining, done: remaining === 0 || !!error, error });
    while (remaining > 0 && !error && cursor !== null) {
      const res: InviteChunk = await apiPost<InviteChunk>(API, { action: 'SEND_INVITES', id: current.id, after: cursor, notifyRequester });
      sent += res.invited;
      failed = [...failed, ...res.inviteFailures];
      error = res.inviteError;
      const progressed = res.invited > 0 || res.inviteFailures.length > 0 || res.inviteCursor !== cursor;
      remaining = res.inviteRemaining;
      cursor = res.inviteCursor;
      setInviteProgress({ sent, failed, remaining, done: false, error });
      if (!progressed) break;
    }
    setInviteProgress({ sent, failed, remaining, done: true, error });
  };

  const approve = async () => {
    setBusy('approve');
    setNotice(null);
    setInviteProgress(null);
    try {
      const body: Record<string, unknown> = { action: 'APPROVE', id: current.id, sendInvites };
      if (dirty) {
        body.details = draft;
        body.students = students;
      }
      const res = await apiPost<InviteChunk & { request: ExamRequestRow; examId: string; assigned: number }>(API, body);
      setApproveOpen(false);
      reset(res.request);
      setNotice({ tone: 'success', text: `Approved — exam "${res.request.details.title}" created with ${res.assigned} student${res.assigned === 1 ? '' : 's'} enrolled.` });
      if (sendInvites) {
        setBusy('invite');
        await continueInvites(res, true);
        await reloadCurrent();
      }
      onChanged();
    } catch (e) {
      setApproveOpen(false);
      const errs = errorList(e);
      setNotice({ tone: 'error', text: getApiErrorMessage(e, 'Could not approve the request.') });
      if (errs.length) await reloadCurrent();
    } finally {
      setBusy('');
    }
  };

  const sendPending = async () => {
    setBusy('invite');
    setNotice(null);
    try {
      const first = await apiPost<InviteChunk>(API, { action: 'SEND_INVITES', id: current.id });
      await continueInvites(first, false);
      await reloadCurrent();
      onChanged();
    } catch (e) {
      setNotice({ tone: 'error', text: getApiErrorMessage(e, 'Could not send invitations.') });
    } finally {
      setBusy('');
    }
  };

  const reject = async () => {
    if (!rejectNote.trim()) return;
    setBusy('reject');
    setNotice(null);
    try {
      const res = await apiPost<{ request: ExamRequestRow }>(API, { action: 'REJECT', id: current.id, note: rejectNote.trim() });
      setRejectOpen(false);
      setRejectNote('');
      reset(res.request);
      setNotice({ tone: 'success', text: 'Request rejected — the employee has been emailed your note.' });
      onChanged();
    } catch (e) {
      setNotice({ tone: 'error', text: getApiErrorMessage(e, 'Could not reject the request.') });
    } finally {
      setBusy('');
    }
  };

  const setTimezone = (newTz: string) => {
    // Keep the wall-clock times already entered, re-interpreted in the new zone (as the exam editor does).
    const oldTz = tz;
    const reinterpret = (ms: number | null) => (typeof ms === 'number' && Number.isFinite(ms) ? zonedInputToEpoch(epochToZonedInput(ms, oldTz), newTz) : ms);
    patch({ timezone: newTz, startTime: reinterpret(draft.startTime), endTime: reinterpret(draft.endTime) });
  };
  const setDate = (key: 'startTime' | 'endTime', value: string) => {
    const ms = zonedInputToEpoch(value, tz);
    patch({ [key]: Number.isFinite(ms) ? ms : null } as Partial<ExamRequestDetails>);
  };

  const timezoneOptions = useMemo(() => {
    const list = EXAM_TIMEZONES.map(t => ({ value: t.value, label: t.label }));
    if (!list.some(t => t.value === tz)) list.unshift({ value: tz, label: tz });
    return list;
  }, [tz]);

  const d = draft;
  return (
    <div className="fixed inset-0 z-[200] flex justify-end bg-slate-900/40" onClick={() => !busy && onClose()}>
      <aside
        role="dialog"
        aria-modal="true"
        aria-label={`Exam request #${current.id}`}
        onClick={e => e.stopPropagation()}
        className="h-full w-full max-w-3xl bg-white shadow-2xl flex flex-col"
      >
        <header className="px-5 py-4 border-b border-slate-200 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-base font-semibold text-slate-900">Request #{current.id}</h3>
              <StatusChip request={current} />
            </div>
            <p className="text-xs text-slate-500 mt-1 break-words">
              {current.requesterName || current.senderName || current.senderEmail} &lt;{current.senderEmail}&gt;
              {current.companyName ? ` · ${current.companyName}` : ''} · received {fmtDateTime(current.receivedAt)}
            </p>
            {current.subject && <p className="text-xs text-slate-400 mt-0.5 break-words">Subject: {current.subject}</p>}
          </div>
          <button type="button" onClick={onClose} disabled={!!busy} aria-label="Close request" className="p-1.5 text-slate-400 hover:text-slate-700 disabled:opacity-40">
            <X size={18} />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {notice && <Notice tone={notice.tone} onClose={() => setNotice(null)}>{notice.text}</Notice>}

          {inviteProgress && (
            <div className="rounded-lg border border-slate-200 bg-slate-50 px-3.5 py-3 text-sm space-y-1.5">
              <div className="flex items-center gap-2 font-medium text-slate-700">
                {inviteProgress.done ? <Mail size={15} /> : <Loader2 size={15} className="animate-spin" />}
                {inviteProgress.done ? 'Invitations' : 'Sending invitations…'}
              </div>
              <p className="text-slate-600">
                {inviteProgress.sent} sent · {inviteProgress.failed.length} failed
                {inviteProgress.remaining > 0 ? ` · ${inviteProgress.remaining} not sent yet` : ''}
              </p>
              {inviteProgress.error && <p className="text-rose-700">{inviteProgress.error}</p>}
              {inviteProgress.failed.length > 0 && (
                <ul className="text-xs text-rose-700 list-disc pl-5 max-h-32 overflow-y-auto">
                  {inviteProgress.failed.slice(0, 50).map((f, i) => <li key={`${f.email}-${i}`}><span className="break-all">{f.email}</span>: {f.error}</li>)}
                </ul>
              )}
            </div>
          )}

          {current.status === 'INVALID' && (
            <Notice tone="error">
              <p className="font-medium">This email was not accepted as a request.</p>
              <ul className="list-disc pl-5 mt-1">{current.errors.map(e => <li key={e}>{e}</li>)}</ul>
              <p className="text-xs mt-1 opacity-80">Nothing can be done with an invalid request; the employee can send a new one.</p>
            </Notice>
          )}

          {current.status === 'APPROVED' && (
            <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3.5 py-3 text-sm text-emerald-900 space-y-2">
              <p className="flex items-start gap-2">
                <ShieldCheck size={16} className="mt-0.5 shrink-0" />
                <span>
                  Created exam <strong>{current.createdExamTitle || current.details.title}</strong>{' '}
                  <code className="text-xs bg-white/70 border border-emerald-200 rounded px-1">{current.createdExamId}</code>
                  {' '}— manage it in the <strong>Exams</strong> tab{current.companyName ? <> with <strong>{current.companyName}</strong> selected in the company switcher</> : null}.
                </span>
              </p>
              <p className="text-xs text-emerald-800">
                {current.assignedCount ?? 0} student{current.assignedCount === 1 ? '' : 's'} enrolled · {current.pendingInviteCount ?? 0} still waiting for their invitation
                {current.reviewedBy ? ` · approved by ${current.reviewedBy} on ${fmtDateTime(current.reviewedAt)}` : ''}
              </p>
              {(current.pendingInviteCount ?? 0) > 0 && (
                <button type="button" onClick={() => { void sendPending(); }} disabled={!!busy} className="px-3 py-1.5 lsc-button-primary text-xs inline-flex items-center gap-1.5 disabled:opacity-60">
                  {busy === 'invite' ? <Loader2 size={13} className="animate-spin" /> : <Send size={13} />}
                  Send {current.pendingInviteCount} pending invitation{current.pendingInviteCount === 1 ? '' : 's'}
                </button>
              )}
            </div>
          )}

          {current.status === 'REJECTED' && (
            <Notice tone="info">
              <p className="font-medium">Rejected{current.reviewedBy ? ` by ${current.reviewedBy}` : ''} on {fmtDateTime(current.reviewedAt)}</p>
              {current.reviewNote && <p className="mt-1 whitespace-pre-wrap">{current.reviewNote}</p>}
            </Notice>
          )}

          {isPending && current.errors.length > 0 && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-3.5 py-3 text-sm text-amber-900">
              <p className="font-medium flex items-center gap-2"><AlertTriangle size={15} /> Fix these before approving</p>
              <ul className="list-disc pl-5 mt-1.5 space-y-0.5">{current.errors.map(e => <li key={e}>{e}</li>)}</ul>
              {dirty && <p className="text-xs mt-2 text-amber-800">You have unsaved changes — save to re-check.</p>}
            </div>
          )}

          {isPending && optionsError && <Notice tone="error">{optionsError}</Notice>}

          {current.status !== 'INVALID' && (isPending ? (
            <div className="space-y-4">
              <div>
                <label className={labelCls} htmlFor="er-title">Exam title</label>
                <input id="er-title" className={inputCls} value={d.title} maxLength={255} onChange={e => patch({ title: e.target.value })} />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className={labelCls} htmlFor="er-bank">Question bank</label>
                  <select
                    id="er-bank"
                    className={inputCls}
                    value={d.questionBankId ?? ''}
                    onChange={e => {
                      const picked = banks.find(b => b.id === Number(e.target.value));
                      patch({ questionBankId: picked ? picked.id : null, questionBankName: picked ? picked.name : '' });
                    }}
                  >
                    <option value="">{d.questionBankId === null && d.questionBankName ? `"${d.questionBankName}" (not found)` : 'Select a question bank…'}</option>
                    {banks.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
                  </select>
                  <p className="text-[11px] text-slate-400 mt-1">
                    {bank ? `${bank.questionCount} question${bank.questionCount === 1 ? '' : 's'} in bank` : 'Banks of this request\'s company'}
                  </p>
                </div>
                <div>
                  <label className={labelCls} htmlFor="er-count">Questions per candidate</label>
                  <div className="flex items-center gap-2">
                    <input
                      id="er-count"
                      type="number"
                      min={1}
                      max={bank?.questionCount || undefined}
                      className={inputCls}
                      disabled={d.questionCount === 0}
                      value={d.questionCount > 0 ? d.questionCount : ''}
                      placeholder={d.questionCount === 0 ? 'All' : ''}
                      onChange={e => patch({ questionCount: e.target.value === '' ? -1 : Math.max(-1, Math.floor(Number(e.target.value))) })}
                    />
                    <label className="flex items-center gap-1.5 text-xs text-slate-600 whitespace-nowrap">
                      <input type="checkbox" checked={d.questionCount === 0} onChange={e => patch({ questionCount: e.target.checked ? 0 : (bank?.questionCount || 1) })} />
                      Whole bank
                    </label>
                  </div>
                  <p className="text-[11px] text-slate-400 mt-1">Drawn at random from the bank for each candidate.</p>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={labelCls} htmlFor="er-duration">Duration (minutes)</label>
                  <input id="er-duration" type="number" min={1} max={600} className={inputCls} value={d.durationMinutes || ''} onChange={e => patch({ durationMinutes: Math.floor(Number(e.target.value) || 0) })} />
                </div>
                <div>
                  <label className={labelCls} htmlFor="er-pass">Pass percentage</label>
                  <input id="er-pass" type="number" min={0} max={100} className={inputCls} value={d.passPercent >= 0 ? d.passPercent : ''} onChange={e => patch({ passPercent: e.target.value === '' ? -1 : Math.floor(Number(e.target.value)) })} />
                </div>
              </div>

              <div>
                <label className={labelCls} htmlFor="er-tz">Timezone</label>
                <select id="er-tz" className={inputCls} value={tz} onChange={e => setTimezone(e.target.value)}>
                  {timezoneOptions.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                </select>
                {d.timezone !== tz && <p className="text-[11px] text-rose-600 mt-1">The email asked for "{d.timezone}", which is not a valid timezone — pick one.</p>}
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className={labelCls} htmlFor="er-start">Start ({tz})</label>
                  <input id="er-start" type="datetime-local" className={inputCls} value={typeof d.startTime === 'number' && Number.isFinite(d.startTime) ? epochToZonedInput(d.startTime, tz) : ''} onChange={e => setDate('startTime', e.target.value)} />
                </div>
                <div>
                  <label className={labelCls} htmlFor="er-end">End ({tz})</label>
                  <input id="er-end" type="datetime-local" className={inputCls} value={typeof d.endTime === 'number' && Number.isFinite(d.endTime) ? epochToZonedInput(d.endTime, tz) : ''} onChange={e => setDate('endTime', e.target.value)} />
                </div>
              </div>

              <div>
                <span className={labelCls}>Proctoring</span>
                <div className="flex items-center gap-1 p-1 rounded-xl bg-slate-100 border border-slate-200 w-full sm:inline-flex sm:w-auto" role="radiogroup" aria-label="Proctoring mode">
                  {(['PROCTORED', 'UNPROCTORED'] as const).map(mode => (
                    <button
                      key={mode}
                      type="button"
                      role="radio"
                      aria-checked={d.proctoringMode === mode}
                      onClick={() => patch(mode === 'UNPROCTORED'
                        ? { proctoringMode: mode, cameraRequired: false, microphoneRequired: false }
                        : { proctoringMode: mode, cameraRequired: true, microphoneRequired: true })}
                      className={`flex-1 sm:flex-none px-3.5 py-1.5 rounded-lg text-sm font-medium transition-colors ${d.proctoringMode === mode ? 'bg-white text-[var(--lsc-primary-700)] shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}
                    >
                      {mode === 'PROCTORED' ? 'Proctored' : 'Unproctored'}
                    </button>
                  ))}
                </div>
                {!proctored && <p className="text-[11px] text-slate-400 mt-1">Unproctored exams switch off camera, microphone, screen recording, fullscreen and tab tracking.</p>}
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <Switch label="Camera" checked={d.cameraRequired} disabled={!proctored} onChange={v => patch({ cameraRequired: v })} />
                <Switch label="Microphone" checked={d.microphoneRequired} disabled={!proctored} onChange={v => patch({ microphoneRequired: v })} />
                <Switch label="Show alerts" hint="Show violation warnings to the candidate" checked={d.showAlerts} onChange={v => patch({ showAlerts: v })} />
                <Switch label="Throw out on violations" hint="End the attempt when a limit is reached" checked={d.autoTerminate} onChange={v => patch({ autoTerminate: v })} />
              </div>

              <div>
                <label className={labelCls} htmlFor="er-batch">Batch</label>
                <select id="er-batch" className={inputCls} value={batch ? batch.name : (d.batchName || '')} onChange={e => patch({ batchName: e.target.value || null })}>
                  <option value="">No batch</option>
                  {d.batchName && !batch && <option value={d.batchName}>"{d.batchName}" (not found)</option>}
                  {batches.map(b => <option key={b.id} value={b.name}>{b.name} ({b.studentCount} student{b.studentCount === 1 ? '' : 's'})</option>)}
                </select>
                <p className="text-[11px] text-slate-400 mt-1">The batch's current members are enrolled along with the CSV students below.</p>
              </div>

              <StudentsEditor students={students} readOnly={false} onChange={changeStudents} />

              <div>
                <label className={labelCls} htmlFor="er-notes">Notes from the employee</label>
                <textarea id="er-notes" className={`${inputCls} min-h-[70px]`} maxLength={5000} value={d.notes} onChange={e => patch({ notes: e.target.value })} />
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-3 rounded-xl border border-slate-200 p-4">
                <KeyValue label="Exam title">{d.title || '—'}</KeyValue>
                <KeyValue label="Question bank">{d.questionBankName || '—'}</KeyValue>
                <KeyValue label="Questions">{d.questionCount === 0 ? 'Whole bank' : d.questionCount > 0 ? d.questionCount : '—'}</KeyValue>
                <KeyValue label="Duration">{d.durationMinutes ? `${d.durationMinutes} minutes` : '—'}</KeyValue>
                <KeyValue label="Pass percentage">{d.passPercent >= 0 ? `${d.passPercent}%` : '—'}</KeyValue>
                <KeyValue label="Timezone">{d.timezone}</KeyValue>
                <KeyValue label="Start">{scheduleLabel(d.startTime, d.timezone)}</KeyValue>
                <KeyValue label="End">{scheduleLabel(d.endTime, d.timezone)}</KeyValue>
                <KeyValue label="Proctoring">{d.proctoringMode === 'PROCTORED' ? `Proctored · camera ${d.cameraRequired ? 'on' : 'off'} · mic ${d.microphoneRequired ? 'on' : 'off'}` : 'Unproctored'}</KeyValue>
                <KeyValue label="Alerts / throw out">{d.showAlerts ? 'Alerts shown' : 'Alerts hidden'} · {d.autoTerminate ? 'throw out' : 'flag only'}</KeyValue>
                <KeyValue label="Batch">{d.batchName || '—'}</KeyValue>
                <KeyValue label="Notes"><span className="whitespace-pre-wrap">{d.notes || '—'}</span></KeyValue>
              </dl>
              {loadingFull ? (
                <p className="text-sm text-slate-400 flex items-center gap-2"><Loader2 size={14} className="animate-spin" /> Loading students…</p>
              ) : (
                <StudentsEditor students={students} readOnly onChange={() => undefined} />
              )}
            </div>
          ))}

          {current.bodyRedacted && (
            <div className="rounded-xl border border-slate-200">
              <button type="button" onClick={() => setShowBody(v => !v)} aria-expanded={showBody} className="w-full flex items-center gap-2 px-3.5 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50">
                {showBody ? <ChevronDown size={15} /> : <ChevronRight size={15} />} Original email <span className="text-xs font-normal text-slate-400">(security code removed)</span>
              </button>
              {showBody && <pre className="px-3.5 pb-3.5 text-xs text-slate-600 whitespace-pre-wrap break-words font-mono max-h-80 overflow-y-auto">{current.bodyRedacted}</pre>}
            </div>
          )}
        </div>

        {isPending && (
          <footer className="px-5 py-3.5 border-t border-slate-200 bg-slate-50 flex flex-wrap items-center justify-end gap-2">
            <button type="button" onClick={() => setRejectOpen(true)} disabled={!!busy} className="px-3.5 py-2 text-sm rounded-lg border border-slate-200 bg-white text-rose-600 hover:bg-rose-50 disabled:opacity-60 inline-flex items-center gap-1.5">
              <Ban size={15} /> Reject
            </button>
            <button type="button" onClick={() => { void save(); }} disabled={!!busy || !dirty} className="px-3.5 py-2 lsc-button-ghost text-sm inline-flex items-center gap-1.5 disabled:opacity-60">
              {busy === 'save' ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />} Save changes
            </button>
            <button
              type="button"
              onClick={() => setApproveOpen(true)}
              disabled={!canApprove}
              title={!canApprove && !busy ? 'Fix the problems listed above and save first' : undefined}
              className="px-3.5 py-2 lsc-button-primary text-sm inline-flex items-center gap-1.5 disabled:opacity-60"
            >
              {busy === 'approve' || busy === 'invite' ? <Loader2 size={15} className="animate-spin" /> : <ShieldCheck size={15} />} Approve
            </button>
          </footer>
        )}
      </aside>

      {approveOpen && (
        <Modal
          title="Approve and schedule this exam?"
          onClose={() => setApproveOpen(false)}
          busy={busy === 'approve'}
          footer={(
            <>
              <button type="button" onClick={() => setApproveOpen(false)} disabled={busy === 'approve'} className="px-4 py-2 text-sm rounded-lg border border-slate-200 bg-white text-slate-700 hover:bg-slate-100 disabled:opacity-60">Cancel</button>
              <button type="button" onClick={() => { void approve(); }} disabled={busy === 'approve'} className="px-4 py-2 lsc-button-primary text-sm inline-flex items-center gap-2 disabled:opacity-60">
                {busy === 'approve' ? <><Loader2 size={15} className="animate-spin" /> Approving…</> : <><ShieldCheck size={15} /> Approve</>}
              </button>
            </>
          )}
        >
          <p>
            This creates a published exam <strong className="text-slate-900">{d.title || 'Untitled'}</strong> in{' '}
            <strong className="text-slate-900">{current.companyName || 'the requester\'s company'}</strong>, linked to the bank
            {' '}<strong className="text-slate-900">{d.questionBankName || '—'}</strong>, and enrolls the students.
          </p>
          <p className="mt-2 text-xs text-slate-500 flex items-center gap-1.5"><CalendarClock size={13} /> {scheduleLabel(d.startTime, d.timezone)} → {scheduleLabel(d.endTime, d.timezone)}</p>
          {dirty && <p className="mt-2 text-xs text-slate-500">Your unsaved changes are included.</p>}
          <label className="mt-4 flex items-start gap-2.5 rounded-lg border border-slate-200 px-3 py-2.5 cursor-pointer">
            <input type="checkbox" className="mt-0.5 accent-[var(--lsc-primary)]" checked={sendInvites} onChange={e => setSendInvites(e.target.checked)} />
            <span>
              <span className="block font-medium text-slate-800">Send invitations to {batch ? 'about ' : ''}{recipientEstimate} student{recipientEstimate === 1 ? '' : 's'} now</span>
              <span className="block text-xs text-slate-500">Each student gets their personal, signed exam link. Otherwise send them later from this request or the Exams tab.</span>
            </span>
          </label>
        </Modal>
      )}

      {rejectOpen && (
        <Modal
          title="Reject this request?"
          onClose={() => setRejectOpen(false)}
          busy={busy === 'reject'}
          footer={(
            <>
              <button type="button" onClick={() => setRejectOpen(false)} disabled={busy === 'reject'} className="px-4 py-2 text-sm rounded-lg border border-slate-200 bg-white text-slate-700 hover:bg-slate-100 disabled:opacity-60">Cancel</button>
              <button type="button" onClick={() => { void reject(); }} disabled={busy === 'reject' || !rejectNote.trim()} className="px-4 py-2 text-sm rounded-lg bg-rose-600 text-white hover:bg-rose-700 disabled:opacity-60 inline-flex items-center gap-2">
                {busy === 'reject' ? <><Loader2 size={15} className="animate-spin" /> Rejecting…</> : <><Ban size={15} /> Reject</>}
              </button>
            </>
          )}
        >
          <label className={labelCls} htmlFor="er-reject-note">Note to the employee (required)</label>
          <textarea
            id="er-reject-note"
            className={`${inputCls} min-h-[110px]`}
            maxLength={2000}
            value={rejectNote}
            onChange={e => setRejectNote(e.target.value)}
            placeholder="Why it was rejected and what to change before sending it again."
          />
          <p className="text-xs text-slate-400 mt-1">The note is emailed to {current.senderEmail}.</p>
        </Modal>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------------------------

const RequestsTab: React.FC<{
  requests: ExamRequestRow[];
  loading: boolean;
  onOpen: (r: ExamRequestRow) => void;
}> = ({ requests, loading, onOpen }) => {
  const [filter, setFilter] = useState<Filter>('PENDING');
  const [search, setSearch] = useState('');

  const counts = useMemo(() => ({
    PENDING: requests.filter(r => r.status === 'PENDING').length,
    ATTENTION: requests.filter(needsAttention).length,
    APPROVED: requests.filter(r => r.status === 'APPROVED').length,
    REJECTED: requests.filter(r => r.status === 'REJECTED').length,
    INVALID: requests.filter(r => r.status === 'INVALID').length,
    ALL: requests.length,
  }), [requests]);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return requests.filter(r => {
      if (filter === 'ATTENTION' ? !needsAttention(r) : filter !== 'ALL' && r.status !== filter) return false;
      if (!term) return true;
      return [r.details.title, r.subject, r.senderEmail, r.requesterName, r.companyName, String(r.id)]
        .filter(Boolean).join(' ').toLowerCase().includes(term);
    });
  }, [requests, filter, search]);
  const paging = usePagination(filtered, `${filter}|${search}`);

  const chips: { id: Filter; label: string }[] = [
    { id: 'PENDING', label: 'Pending' },
    { id: 'ATTENTION', label: 'Needs attention' },
    { id: 'APPROVED', label: 'Approved' },
    { id: 'REJECTED', label: 'Rejected' },
    { id: 'INVALID', label: 'Invalid' },
    { id: 'ALL', label: 'All' },
  ];

  return (
    <div className="lsc-panel overflow-hidden">
      <div className="p-4 lsc-panel-header flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter requests">
          {chips.map(c => (
            <button
              key={c.id}
              type="button"
              onClick={() => setFilter(c.id)}
              aria-pressed={filter === c.id}
              className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-semibold transition-colors ${filter === c.id ? 'border-[var(--lsc-primary)] bg-[var(--lsc-primary-50)] text-[var(--lsc-primary)]' : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'}`}
            >
              {c.id === 'ATTENTION' && <AlertTriangle size={11} />}
              {c.label}
              <span className="lsc-tabular text-[11px] opacity-70">{counts[c.id]}</span>
            </button>
          ))}
        </div>
        <div className="relative w-full lg:w-64">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input className={`${inputCls} pl-8 py-1.5`} placeholder="Search title, employee…" aria-label="Search requests" value={search} onChange={e => setSearch(e.target.value)} />
        </div>
      </div>
      {loading && requests.length === 0 && <div className="p-6 text-sm text-slate-400 flex items-center gap-2"><Loader2 size={15} className="animate-spin" /> Loading requests…</div>}
      {!loading && filtered.length === 0 && (
        <div className="p-8 text-center text-sm text-slate-400">
          <Inbox size={28} className="mx-auto mb-2 text-slate-300" />
          {requests.length === 0 ? 'No exam requests yet. Employees send them by email — see the Email template tab.' : 'No requests match this filter.'}
        </div>
      )}
      {filtered.length > 0 && (
        <div className="lsc-table-wrap">
          <table className="w-full text-left text-sm lsc-grid">
            <thead>
              <tr>
                <th className="px-4 py-3">Received</th>
                <th className="px-4 py-3">Employee</th>
                <th className="px-4 py-3">Company</th>
                <th className="px-4 py-3">Exam title</th>
                <th className="px-4 py-3">Students</th>
                <th className="px-4 py-3">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {paging.pageItems.map(r => {
                const count = r.studentCount ?? r.students.length;
                return (
                  <tr key={r.id} className="cursor-pointer" onClick={() => onOpen(r)}>
                    <td className="px-4 py-3 whitespace-nowrap text-slate-600">{fmtDateTime(r.receivedAt)}</td>
                    <td className="px-4 py-3 min-w-[160px]">
                      <div className="font-medium text-slate-800">{r.requesterName || r.senderName || '—'}</div>
                      <div className="text-xs text-slate-400 break-all">{r.senderEmail}</div>
                    </td>
                    <td className="px-4 py-3 text-slate-600">{r.companyName || '—'}</td>
                    <td className="px-4 py-3 min-w-[180px]">
                      <button type="button" onClick={e => { e.stopPropagation(); onOpen(r); }} className="text-left font-medium text-slate-800 hover:text-[var(--lsc-primary)]">
                        {r.details.title || r.subject || `Request #${r.id}`}
                      </button>
                      <div className="text-xs text-slate-400">#{r.id}</div>
                    </td>
                    <td className="px-4 py-3 text-slate-600 whitespace-nowrap">
                      {count > 0 ? count : (r.details.batchName ? '' : '—')}
                      {r.details.batchName ? <span className="text-xs text-slate-400">{count > 0 ? ' + ' : ''}{r.details.batchName}</span> : null}
                    </td>
                    <td className="px-4 py-3"><StatusChip request={r} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {filtered.length > 0 && <Pagination state={paging} label="requests" />}
    </div>
  );
};

const EmployeesTab: React.FC<{
  requesters: ExamRequester[];
  loading: boolean;
  onChanged: () => void;
}> = ({ requesters, loading, onChanged }) => {
  const [companies, setCompanies] = useState<CompanyDirectoryRecord[]>([]);
  const [companiesError, setCompaniesError] = useState('');
  const [addOpen, setAddOpen] = useState(false);
  const [form, setForm] = useState({ companyId: '', name: '', email: '' });
  const [busy, setBusy] = useState(false);
  const [rowBusy, setRowBusy] = useState<number | null>(null);
  const [formError, setFormError] = useState('');
  const [reveal, setReveal] = useState<{ name: string; email: string; code: string } | null>(null);
  const [confirm, setConfirm] = useState<{ kind: 'regenerate' | 'delete'; requester: ExamRequester } | null>(null);
  const [notice, setNotice] = useState<{ tone: 'error' | 'success'; text: string } | null>(null);
  const [search, setSearch] = useState('');

  useEffect(() => {
    apiGet<{ companies: CompanyDirectoryRecord[] }>('companies.php')
      .then(res => setCompanies(res?.companies || []))
      .catch(e => setCompaniesError(getApiErrorMessage(e, 'Could not load companies.')));
  }, []);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return requesters;
    return requesters.filter(r => [r.name, r.email, r.companyName].filter(Boolean).join(' ').toLowerCase().includes(term));
  }, [requesters, search]);
  const paging = usePagination(filtered, search);

  const openAdd = () => {
    setForm({ companyId: companies.length === 1 ? String(companies[0].id) : '', name: '', email: '' });
    setFormError('');
    setAddOpen(true);
  };

  const create = async () => {
    setBusy(true);
    setFormError('');
    try {
      const res = await apiPost<{ requester: ExamRequester; code: string }>(API, {
        action: 'CREATE_REQUESTER', companyId: Number(form.companyId), name: form.name.trim(), email: form.email.trim(),
      });
      setAddOpen(false);
      setReveal({ name: res.requester.name, email: res.requester.email, code: res.code });
      onChanged();
    } catch (e) {
      setFormError(getApiErrorMessage(e, 'Could not add the employee.'));
    } finally {
      setBusy(false);
    }
  };

  const runConfirm = async () => {
    if (!confirm) return;
    const { kind, requester } = confirm;
    setBusy(true);
    try {
      if (kind === 'regenerate') {
        const res = await apiPost<{ code: string }>(API, { action: 'REGENERATE_CODE', id: requester.id });
        setReveal({ name: requester.name, email: requester.email, code: res.code });
      } else {
        await apiPost(API, { action: 'DELETE_REQUESTER', id: requester.id });
        setNotice({ tone: 'success', text: `${requester.name} can no longer send exam requests.` });
      }
      setConfirm(null);
      onChanged();
    } catch (e) {
      setConfirm(null);
      setNotice({ tone: 'error', text: getApiErrorMessage(e, kind === 'regenerate' ? 'Could not regenerate the code.' : 'Could not delete the employee.') });
    } finally {
      setBusy(false);
    }
  };

  const toggleStatus = async (r: ExamRequester) => {
    setRowBusy(r.id);
    try {
      await apiPost(API, { action: 'SET_REQUESTER_STATUS', id: r.id, status: r.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE' });
      onChanged();
    } catch (e) {
      setNotice({ tone: 'error', text: getApiErrorMessage(e, 'Could not update the employee.') });
    } finally {
      setRowBusy(null);
    }
  };

  const canCreate = !!form.companyId && form.name.trim() !== '' && looksLikeEmail(form.email.trim());

  return (
    <div className="space-y-4">
      {notice && <Notice tone={notice.tone} onClose={() => setNotice(null)}>{notice.text}</Notice>}
      <div className="lsc-panel overflow-hidden">
        <div className="p-4 lsc-panel-header flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="text-sm font-semibold text-slate-800">Employees allowed to request exams</div>
            <div className="text-xs text-slate-500">A request is accepted only from the registered address <em>and</em> with that employee's own security code.</div>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <div className="relative sm:w-52">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <input className={`${inputCls} pl-8 py-1.5`} placeholder="Search employees…" aria-label="Search employees" value={search} onChange={e => setSearch(e.target.value)} />
            </div>
            <button type="button" onClick={openAdd} className="px-3.5 py-2 lsc-button-primary text-sm inline-flex items-center justify-center gap-2">
              <UserPlus size={15} /> Add employee
            </button>
          </div>
        </div>
        {loading && requesters.length === 0 && <div className="p-6 text-sm text-slate-400 flex items-center gap-2"><Loader2 size={15} className="animate-spin" /> Loading…</div>}
        {!loading && filtered.length === 0 && (
          <div className="p-8 text-center text-sm text-slate-400">
            <Users size={28} className="mx-auto mb-2 text-slate-300" />
            {requesters.length === 0 ? 'No employees yet. Add one to issue their personal security code.' : 'No employees match.'}
          </div>
        )}
        {filtered.length > 0 && (
          <div className="lsc-table-wrap">
            <table className="w-full text-left text-sm lsc-grid">
              <thead>
                <tr>
                  <th className="px-4 py-3">Name</th>
                  <th className="px-4 py-3">Email</th>
                  <th className="px-4 py-3">Company</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Code</th>
                  <th className="px-4 py-3">Last request</th>
                  <th className="px-4 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {paging.pageItems.map(r => (
                  <tr key={r.id}>
                    <td className="px-4 py-3 font-medium text-slate-800">{r.name}</td>
                    <td className="px-4 py-3 text-slate-600 break-all">{r.email}</td>
                    <td className="px-4 py-3 text-slate-600">{r.companyName || `#${r.companyId}`}</td>
                    <td className="px-4 py-3"><span className={r.status === 'ACTIVE' ? 'lsc-chip-success' : 'lsc-chip-neutral'}>{r.status === 'ACTIVE' ? 'Active' : 'Disabled'}</span></td>
                    <td className="px-4 py-3 font-mono text-xs text-slate-500 whitespace-nowrap">{r.codeHint ? `••••-${r.codeHint}` : '—'}</td>
                    <td className="px-4 py-3 text-slate-500 whitespace-nowrap">{r.lastRequestAt ? fmtDateTime(r.lastRequestAt) : 'Never'}</td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap justify-end gap-1.5">
                        <button type="button" onClick={() => setConfirm({ kind: 'regenerate', requester: r })} className="px-2.5 py-1.5 lsc-button-ghost text-xs inline-flex items-center gap-1.5">
                          <KeyRound size={13} /> New code
                        </button>
                        <button type="button" onClick={() => { void toggleStatus(r); }} disabled={rowBusy === r.id} className="px-2.5 py-1.5 lsc-button-ghost text-xs inline-flex items-center gap-1.5 disabled:opacity-60">
                          {rowBusy === r.id ? <Loader2 size={13} className="animate-spin" /> : r.status === 'ACTIVE' ? <Ban size={13} /> : <Check size={13} />}
                          {r.status === 'ACTIVE' ? 'Disable' : 'Enable'}
                        </button>
                        <button type="button" onClick={() => setConfirm({ kind: 'delete', requester: r })} aria-label={`Delete ${r.name}`} title="Delete employee" className="px-2 py-1.5 text-slate-400 hover:text-rose-600">
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {filtered.length > 0 && <Pagination state={paging} label="employees" />}
      </div>

      {addOpen && (
        <Modal
          title="Add employee"
          onClose={() => setAddOpen(false)}
          busy={busy}
          footer={(
            <>
              <button type="button" onClick={() => setAddOpen(false)} disabled={busy} className="px-4 py-2 text-sm rounded-lg border border-slate-200 bg-white text-slate-700 hover:bg-slate-100 disabled:opacity-60">Cancel</button>
              <button type="button" onClick={() => { void create(); }} disabled={busy || !canCreate} className="px-4 py-2 lsc-button-primary text-sm inline-flex items-center gap-2 disabled:opacity-60">
                {busy ? <Loader2 size={15} className="animate-spin" /> : <Plus size={15} />} Add &amp; create code
              </button>
            </>
          )}
        >
          <div className="space-y-3">
            {formError && <Notice tone="error">{formError}</Notice>}
            {companiesError && <Notice tone="error">{companiesError}</Notice>}
            <div>
              <label className={labelCls} htmlFor="er-emp-company">Company</label>
              <select id="er-emp-company" className={inputCls} value={form.companyId} onChange={e => setForm(f => ({ ...f, companyId: e.target.value }))}>
                <option value="">Select a company…</option>
                {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
              <p className="text-[11px] text-slate-400 mt-1">Requests from this employee create exams in this company, using its question banks and batches.</p>
            </div>
            <div>
              <label className={labelCls} htmlFor="er-emp-name">Name</label>
              <input id="er-emp-name" className={inputCls} maxLength={255} value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
            </div>
            <div>
              <label className={labelCls} htmlFor="er-emp-email">Email address they send from</label>
              <input id="er-emp-email" type="email" className={inputCls} maxLength={255} value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} />
            </div>
          </div>
        </Modal>
      )}

      {confirm && (
        <Modal
          title={confirm.kind === 'regenerate' ? 'Issue a new security code?' : 'Delete this employee?'}
          onClose={() => setConfirm(null)}
          busy={busy}
          footer={(
            <>
              <button type="button" onClick={() => setConfirm(null)} disabled={busy} className="px-4 py-2 text-sm rounded-lg border border-slate-200 bg-white text-slate-700 hover:bg-slate-100 disabled:opacity-60">Cancel</button>
              <button
                type="button"
                onClick={() => { void runConfirm(); }}
                disabled={busy}
                className={`px-4 py-2 text-sm rounded-lg inline-flex items-center gap-2 disabled:opacity-60 ${confirm.kind === 'delete' ? 'bg-rose-600 text-white hover:bg-rose-700' : 'lsc-button-primary'}`}
              >
                {busy ? <Loader2 size={15} className="animate-spin" /> : confirm.kind === 'delete' ? <Trash2 size={15} /> : <KeyRound size={15} />}
                {confirm.kind === 'delete' ? 'Delete' : 'Issue new code'}
              </button>
            </>
          )}
        >
          {confirm.kind === 'regenerate' ? (
            <p>The current code for <strong className="text-slate-900">{confirm.requester.name}</strong> stops working immediately. You'll see the new code once.</p>
          ) : (
            <p>
              <strong className="text-slate-900">{confirm.requester.name}</strong> ({confirm.requester.email}) will no longer be able to send exam requests.
              Their past requests stay in the list. To pause them temporarily, use Disable instead.
            </p>
          )}
        </Modal>
      )}

      {reveal && (
        <Modal
          title="Security code"
          onClose={() => setReveal(null)}
          footer={<button type="button" onClick={() => setReveal(null)} className="px-4 py-2 lsc-button-primary text-sm">Done</button>}
        >
          <p>Code for <strong className="text-slate-900">{reveal.name}</strong> ({reveal.email}):</p>
          <div className="mt-3 rounded-xl border-2 border-amber-300 bg-amber-50 p-4 flex flex-wrap items-center justify-between gap-3">
            <code className="text-2xl font-bold tracking-[0.2em] text-slate-900 font-mono">{reveal.code}</code>
            <CopyButton value={reveal.code} />
          </div>
          <p className="mt-3 text-xs font-semibold text-amber-800 flex items-start gap-1.5">
            <AlertCircle size={13} className="mt-0.5 shrink-0" /> Share this code privately with the employee. It is shown only now — only a scrambled form is stored.
          </p>
        </Modal>
      )}
    </div>
  );
};

const TemplateTab: React.FC<{ mailbox: string }> = ({ mailbox }) => (
  <div className="grid grid-cols-1 xl:grid-cols-[1fr_380px] gap-4">
    <div className="space-y-4 min-w-0">
      <div className="lsc-panel p-5 space-y-3">
        <div className="flex items-start gap-3">
          <div className="lsc-icon-tile-primary p-2.5 shrink-0"><Mail size={18} /></div>
          <div className="min-w-0">
            <h3 className="text-base font-semibold text-slate-900">Send requests to</h3>
            <p className="text-sm text-slate-500">Employees email the filled-in template below to this address, from their registered email.</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <code className="flex-1 min-w-0 truncate px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm">{mailbox || 'Mailbox not configured'}</code>
          {mailbox && <CopyButton value={mailbox} />}
        </div>
        <div>
          <span className={labelCls}>Subject (must start with EXAM REQUEST)</span>
          <div className="flex items-center gap-2">
            <code className="flex-1 min-w-0 truncate px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm">{TEMPLATE_SUBJECT}</code>
            <CopyButton value="EXAM REQUEST - " />
          </div>
        </div>
      </div>

      <div className="lsc-panel overflow-hidden">
        <div className="p-4 lsc-panel-header flex items-center justify-between gap-3">
          <div className="text-sm font-semibold text-slate-800 flex items-center gap-2"><FileText size={15} /> Email body template</div>
          <CopyButton value={TEMPLATE_BODY} label="Copy template" />
        </div>
        <pre className="p-4 text-xs sm:text-sm font-mono text-slate-800 whitespace-pre-wrap break-words bg-white">{TEMPLATE_BODY}</pre>
      </div>

      <div className="lsc-panel overflow-hidden">
        <div className="p-4 lsc-panel-header flex flex-wrap items-center justify-between gap-3">
          <div className="text-sm font-semibold text-slate-800">Students CSV (attach as students.csv)</div>
          <button type="button" onClick={() => downloadText('students.csv', CSV_SAMPLE)} className="px-2.5 py-1.5 lsc-button-ghost text-xs inline-flex items-center gap-1.5">
            <Download size={13} /> Download sample
          </button>
        </div>
        <div className="p-4 space-y-2 text-sm text-slate-600">
          <p>Three columns: <strong>Full Name</strong>, <strong>Email</strong>, <strong>Registration ID</strong>. The header row is optional. Up to {MAX_STUDENTS} students, file up to 2 MB, UTF-8 (Excel's CSV export is fine).</p>
          <pre className="p-3 rounded-lg bg-slate-50 border border-slate-200 text-xs font-mono whitespace-pre-wrap break-words">{CSV_SAMPLE}</pre>
          <p className="text-xs text-slate-500">Existing students are matched by registration ID or email within the company and updated; new ones are created.</p>
        </div>
      </div>
    </div>

    <div className="lsc-panel p-5 h-fit">
      <h3 className="text-sm font-semibold text-slate-900 flex items-center gap-2 mb-3"><ListRules /> Rules</h3>
      <ul className="space-y-2.5 text-sm text-slate-600 list-disc pl-5">
        <li><strong>Security Code</strong> is the employee's personal code (case, spaces and dashes don't matter). Wrong or missing code → the request is refused and the employee is told.</li>
        <li>Emails from unregistered or disabled addresses are ignored silently.</li>
        <li><strong>Exam Title</strong> and <strong>Question Bank</strong> (an existing bank of the employee's company, by name) are required.</li>
        <li><strong>Number of Questions</strong>: a number up to the bank size, or <code>ALL</code> for the whole bank. Each candidate gets a random draw.</li>
        <li><strong>Duration</strong>: 1–600 minutes. <strong>Pass Percentage</strong>: 0–100 (default 60).</li>
        <li><strong>Start / End</strong>: <code>YYYY-MM-DD HH:MM</code>, <code>DD-MM-YYYY HH:MM</code> or <code>DD/MM/YYYY HH:MM</code>, optional AM/PM, in the given <strong>Timezone</strong> (IANA name, default Asia/Kolkata). End must be after Start.</li>
        <li><strong>Proctoring</strong> PROCTORED (default) or UNPROCTORED (turns camera and microphone off). <strong>Camera</strong> ON/OFF (default ON), <strong>Microphone</strong> defaults to the camera setting.</li>
        <li><strong>Show Alerts</strong> and <strong>Throw Out On Violations</strong>: YES/NO, both default YES.</li>
        <li>Students: name an existing <strong>Batch</strong>, attach a <strong>students.csv</strong>, or both.</li>
        <li>Text in brackets after a value, e.g. <code>(ALL = whole bank)</code>, is ignored. At most 10 requests per employee per hour.</li>
        <li>Every accepted request waits here as <strong>Pending</strong> (problems are flagged as <em>Needs attention</em>). A super admin reviews, edits and approves it; the employee is emailed at each step.</li>
      </ul>
    </div>
  </div>
);

const ListRules: React.FC = () => <Info size={15} />;

// ---------------------------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------------------------

export const ExamRequests: React.FC = () => {
  const [tab, setTab] = useState<Tab>('requests');
  const [requests, setRequests] = useState<ExamRequestRow[]>([]);
  const [requesters, setRequesters] = useState<ExamRequester[]>([]);
  const [mailbox, setMailbox] = useState('');
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [openRequest, setOpenRequest] = useState<ExamRequestRow | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError('');
    try {
      const res = await apiGet<{ requests: ExamRequestRow[]; requesters: ExamRequester[]; mailbox: string }>(API);
      setRequests(res?.requests || []);
      setRequesters(res?.requesters || []);
      setMailbox(res?.mailbox || '');
    } catch (e) {
      setLoadError(getApiErrorMessage(e, 'Could not load exam requests.'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const pendingCount = requests.filter(r => r.status === 'PENDING').length;
  const tabs: { id: Tab; label: string; icon: React.ReactNode; badge?: number }[] = [
    { id: 'requests', label: 'Requests', icon: <Inbox size={15} />, badge: pendingCount },
    { id: 'employees', label: 'Employees & codes', icon: <Users size={15} /> },
    { id: 'template', label: 'Email template', icon: <FileText size={15} /> },
  ];

  return (
    <div className="lsc-page space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h2 className="lsc-title">Exam Requests</h2>
          <p className="lsc-subtitle mt-1">Exams employees request by email — review, correct and approve them, and manage who may send requests.</p>
        </div>
        <button type="button" onClick={() => { void load(); }} disabled={loading} className="px-3.5 py-2 lsc-button-ghost text-sm inline-flex items-center gap-2 self-start disabled:opacity-60">
          <RefreshCw size={15} className={loading ? 'animate-spin' : ''} /> Refresh
        </button>
      </div>

      {loadError && <Notice tone="error">{loadError}</Notice>}

      <div className="flex items-center gap-1 p-1 rounded-xl bg-slate-100 border border-slate-200 w-full overflow-x-auto sm:w-auto sm:inline-flex" role="tablist" aria-label="Exam request sections">
        {tabs.map(t => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className={`flex-1 sm:flex-none flex items-center justify-center gap-1.5 px-3.5 py-2 rounded-lg text-sm font-medium transition-colors whitespace-nowrap ${tab === t.id ? 'bg-white text-[var(--lsc-primary-700)] shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}
          >
            {t.icon}
            <span>{t.label}</span>
            {!!t.badge && <span className="lsc-chip-primary !py-0 !px-1.5 text-[10px]">{t.badge}</span>}
          </button>
        ))}
      </div>

      {tab === 'requests' && <RequestsTab requests={requests} loading={loading} onOpen={setOpenRequest} />}
      {tab === 'employees' && <EmployeesTab requesters={requesters} loading={loading} onChanged={() => { void load(); }} />}
      {tab === 'template' && <TemplateTab mailbox={mailbox} />}

      {openRequest && (
        <RequestDetail
          key={openRequest.id}
          request={openRequest}
          onClose={() => setOpenRequest(null)}
          onChanged={() => { void load(); }}
        />
      )}
    </div>
  );
};
