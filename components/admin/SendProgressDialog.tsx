import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, CheckCircle2, Clock, Loader2, Mail, MessageCircle, RotateCcw, Send, Square, X } from 'lucide-react';
import { apiGet, apiPost, getApiErrorMessage } from '../../services/api';
import type { NotifyJob } from '../../types';

// The in-app replacement for "send everything in one request, then alert() the result".
// A send is a background job (api/notify_jobs.php + scripts/notify_worker.php): this dialog asks for
// confirmation, queues it, and then just watches it — progress per channel, why it is paused (the
// mail server's hourly limit), who could not be reached and why. Closing the dialog, the tab or the
// browser does not stop the send.

export interface SendRequest {
  examId: string;
  examTitle: string;
  kind: 'INVITE' | 'REMINDER';
  studentIds: string[];
  channels: { email: boolean; whatsapp: boolean };
  subject?: string;
  message?: string;
}

interface SendProgressDialogProps {
  /** A send to confirm and start… */
  request?: SendRequest | null;
  /** Skip the confirmation step (the caller already asked). */
  autoStart?: boolean;
  /** …or a send already running, to watch. */
  jobId?: number | null;
  examTitle?: string;
  /** Called when the dialog is dismissed. `job` is the last known state (null if nothing was queued). */
  onClose: (job: NotifyJob | null) => void;
  /** Called once when the job reaches a final state, so the page can refresh its own numbers. */
  onFinished?: (job: NotifyJob) => void;
  withCompany: <T extends Record<string, unknown>>(payload: T) => T;
}

const isActive = (job: NotifyJob | null) => !!job && (job.status === 'QUEUED' || job.status === 'RUNNING' || job.status === 'PAUSED');

const formatDuration = (seconds: number): string => {
  if (seconds < 90) return 'about a minute';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `about ${minutes} minutes`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `about ${hours} hour${hours === 1 ? '' : 's'}${rest >= 5 ? ` ${rest} min` : ''}`;
};

const Bar: React.FC<{ icon: React.ReactNode; label: string; done: number; failed: number; total: number; extra?: string }> = ({ icon, label, done, failed, total, extra }) => {
  const pct = total > 0 ? Math.min(100, Math.round(((done + failed) / total) * 100)) : 100;
  const failedPct = total > 0 ? Math.min(100, (failed / total) * 100) : 0;
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2 text-sm">
        <span className="flex items-center gap-1.5 font-medium text-slate-700">{icon}{label}</span>
        <span className="text-slate-600 tabular-nums">
          <span className="font-semibold text-slate-900">{done}</span> of {total} sent
          {failed > 0 && <span className="text-rose-600"> · {failed} failed</span>}
        </span>
      </div>
      <div className="h-2 rounded-full bg-slate-100 overflow-hidden flex" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label={`${label} progress`}>
        <div className="h-full bg-teal-500 transition-all duration-500" style={{ width: `${Math.max(0, pct - failedPct)}%` }} />
        {failed > 0 && <div className="h-full bg-rose-400 transition-all duration-500" style={{ width: `${failedPct}%` }} />}
      </div>
      {extra && <p className="text-xs text-slate-500">{extra}</p>}
    </div>
  );
};

export const SendProgressDialog: React.FC<SendProgressDialogProps> = ({ request, autoStart = false, jobId, examTitle, onClose, onFinished, withCompany }) => {
  const [job, setJob] = useState<NotifyJob | null>(null);
  const [stage, setStage] = useState<'confirm' | 'starting' | 'watching'>(request ? (autoStart ? 'starting' : 'confirm') : 'watching');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<'' | 'stop' | 'retry'>('');
  const [confirmStop, setConfirmStop] = useState(false);
  const finishedRef = useRef<number | null>(null);
  const kind = job?.kind || request?.kind || 'INVITE';
  const noun = kind === 'REMINDER' ? 'reminder' : 'invitation';
  const title = request?.examTitle || examTitle || '';

  const refresh = useCallback(async (id: number) => {
    const res = await apiGet<{ job: NotifyJob }>(`notify_jobs.php?id=${id}`);
    setJob(res.job);
    return res.job;
  }, []);

  // Watching an existing send: load it once.
  useEffect(() => {
    if (!jobId || request) return;
    refresh(jobId).catch(e => setError(getApiErrorMessage(e, 'Could not load this send.')));
  }, [jobId, request, refresh]);

  // Poll while it is in progress (slower while paused — nothing changes for minutes).
  useEffect(() => {
    if (!job || !isActive(job)) return;
    const id = window.setInterval(() => { void refresh(job.id).catch(() => {}); }, job.status === 'PAUSED' ? 10000 : 2000);
    return () => window.clearInterval(id);
  }, [job, refresh]);

  useEffect(() => {
    if (job && !isActive(job) && finishedRef.current !== job.id) {
      finishedRef.current = job.id;
      onFinished?.(job);
    }
  }, [job, onFinished]);

  const start = async () => {
    if (!request) return;
    setStage('starting');
    setError('');
    try {
      const res = await apiPost<{ ok: boolean; job: NotifyJob }>('notify_jobs.php', withCompany({
        action: 'CREATE',
        examId: request.examId,
        kind: request.kind,
        studentIds: request.studentIds,
        channels: request.channels,
        ...(request.subject !== undefined ? { subject: request.subject } : {}),
        ...(request.message !== undefined ? { message: request.message } : {}),
      }));
      finishedRef.current = null;
      setJob(res.job);
      setStage('watching');
    } catch (e) {
      setError(getApiErrorMessage(e, 'Could not start sending.'));
      setStage('confirm');
    }
  };

  // The caller already confirmed (the invitation dialog): queue it straight away, once.
  const autoStartedRef = useRef(false);
  useEffect(() => {
    if (request && autoStart && !autoStartedRef.current) {
      autoStartedRef.current = true;
      void start();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const act = async (action: 'CANCEL' | 'RETRY_FAILED') => {
    if (!job || busy) return;
    setBusy(action === 'CANCEL' ? 'stop' : 'retry');
    setError('');
    try {
      const res = await apiPost<{ ok: boolean; job: NotifyJob }>('notify_jobs.php', withCompany({ action, id: job.id }));
      if (action === 'RETRY_FAILED') finishedRef.current = null;
      setJob(res.job);
    } catch (e) {
      setError(getApiErrorMessage(e, action === 'CANCEL' ? 'Could not stop the send.' : 'Could not retry.'));
    } finally {
      setBusy('');
      setConfirmStop(false);
    }
  };

  const via = (channels: { email: boolean; whatsapp: boolean }) => (channels.email && channels.whatsapp ? 'by email and WhatsApp' : channels.email ? 'by email' : 'on WhatsApp');
  const active = isActive(job);
  const failedTotal = job ? job.email.failed + job.whatsapp.failed : 0;
  const whatsappTotal = job ? job.total - job.whatsapp.noMobile : 0;
  // Students with no email address are not part of the email total (nothing can be emailed to them).
  const noEmail = job ? job.email.noEmail ?? 0 : 0;
  const emailTotal = job ? job.total - noEmail : 0;
  // No contact detail for any channel this send uses: nothing could go to these students.
  const unreachable = job ? job.unreachable ?? 0 : 0;

  let statusLine: React.ReactNode = null;
  if (job) {
    if (job.status === 'QUEUED') {
      statusLine = <span className="flex items-center gap-2 text-slate-700"><Loader2 size={16} className="animate-spin text-blue-600" /> Starting…</span>;
    } else if (job.status === 'RUNNING') {
      statusLine = <span className="flex items-center gap-2 text-slate-700"><Loader2 size={16} className="animate-spin text-blue-600" /> Sending {noun}s…</span>;
    } else if (job.status === 'PAUSED') {
      statusLine = (
        <span className="flex items-start gap-2 text-amber-800">
          <Clock size={16} className="mt-0.5 shrink-0" />
          <span>
            Paused{job.pausedUntil ? ` until ${new Date(job.pausedUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}.
            {job.note ? ` ${job.note}` : ''}
          </span>
        </span>
      );
    } else if (job.status === 'DONE') {
      statusLine = failedTotal > 0
        ? <span className="flex items-center gap-2 text-amber-800"><AlertCircle size={18} /> Finished — {failedTotal} could not be sent (see below).</span>
        : unreachable > 0
          ? <span className="flex items-center gap-2 text-amber-800"><AlertCircle size={18} /> Finished — {unreachable} student{unreachable === 1 ? '' : 's'} could not be reached (see below).</span>
          : <span className="flex items-center gap-2 text-teal-700"><CheckCircle2 size={18} /> All {noun}s were sent.</span>;
    } else {
      statusLine = <span className="flex items-center gap-2 text-slate-600"><Square size={15} /> Stopped. What had already gone out stays sent.</span>;
    }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-900/40 p-4" role="dialog" aria-modal="true" aria-labelledby="send-progress-title">
      <div className="w-full max-w-lg rounded-2xl bg-white shadow-xl border border-slate-200 max-h-[90vh] flex flex-col">
        <div className="p-5 border-b border-slate-100 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 id="send-progress-title" className="text-lg font-semibold text-slate-900">{kind === 'REMINDER' ? 'Send reminders' : 'Send invitations'}</h3>
            {title && <p className="text-sm text-slate-500 truncate">{title}</p>}
          </div>
          <button type="button" onClick={() => onClose(job)} aria-label="Close" className="p-1.5 rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-600"><X size={18} /></button>
        </div>

        <div className="p-5 space-y-4 overflow-y-auto">
          {stage !== 'watching' && request && (
            <>
              <p className="text-sm text-slate-700">
                Send this {noun} {via(request.channels)} to{' '}
                <span className="font-semibold text-slate-900">{request.studentIds.length}</span> student{request.studentIds.length === 1 ? '' : 's'}?
              </p>
              <p className="text-xs text-slate-500">
                Sending runs in the background at a steady pace, so large lists are delivered reliably. You can close this window or the browser — it carries on, and you can come back to see the result.
              </p>
            </>
          )}

          {stage === 'watching' && !job && !error && (
            <p className="text-sm text-slate-500 flex items-center gap-2"><Loader2 size={14} className="animate-spin" /> Loading…</p>
          )}

          {job && (
            <>
              <div className="text-sm" role="status" aria-live="polite">{statusLine}</div>
              {job.useEmail && (
                <Bar
                  icon={<Mail size={15} className="text-slate-500" />}
                  label="Email"
                  done={job.email.sent}
                  failed={job.email.failed}
                  total={emailTotal}
                  extra={[
                    active && job.email.pending > 0
                      ? `${job.email.pending} to go — ${formatDuration(job.emailEtaSeconds)} left${job.email.pending > job.emailLimitPerHour ? ` (the mail account sends at most ${job.emailLimitPerHour} an hour)` : ''}.`
                      : '',
                    noEmail > 0 ? `${noEmail} student${noEmail === 1 ? ' has' : 's have'} no email address on file.` : '',
                  ].filter(Boolean).join(' ') || undefined}
                />
              )}
              {job.useWhatsApp && (
                <Bar
                  icon={<MessageCircle size={15} className="text-emerald-600" />}
                  label="WhatsApp"
                  done={job.whatsapp.sent}
                  failed={job.whatsapp.failed}
                  total={whatsappTotal}
                  extra={job.whatsapp.noMobile > 0 ? `${job.whatsapp.noMobile} student${job.whatsapp.noMobile === 1 ? ' has' : 's have'} no mobile number on file.` : undefined}
                />
              )}
              {unreachable > 0 && (
                <p className="text-xs text-amber-800 bg-amber-50 border border-amber-100 rounded-lg px-3 py-2">
                  {unreachable} student{unreachable === 1 ? ' has' : 's have'} no {job.useEmail && job.useWhatsApp ? 'email address or mobile number' : job.useEmail ? 'email address' : 'mobile number'} on file, so nothing was sent to them. Add it under Students, or give them their exam link yourself.
                </p>
              )}
              {job.status !== 'PAUSED' && job.note && <p className="text-xs text-slate-500">{job.note}</p>}
              {active && (
                <p className="text-xs text-slate-500">You can close this window — sending continues in the background.</p>
              )}
              {job.failures.length > 0 && (
                <div className="rounded-lg border border-rose-100 bg-rose-50/60">
                  <div className="px-3 py-2 text-xs font-semibold text-rose-800 border-b border-rose-100">Could not be sent ({failedTotal})</div>
                  <ul className="max-h-40 overflow-y-auto divide-y divide-rose-100 text-xs">
                    {job.failures.map((f, i) => (
                      <li key={`${f.email}-${f.channel}-${i}`} className="px-3 py-1.5">
                        <span className="font-medium text-slate-800">{f.name || f.email}</span>
                        <span className="text-slate-500"> · {f.channel === 'EMAIL' ? f.email : 'WhatsApp'}</span>
                        <span className="block text-rose-700 break-words">{f.error}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}

          {error && (
            <div role="alert" className="flex items-start gap-2 p-3 rounded-lg bg-rose-50 border border-rose-100 text-sm text-rose-700">
              <AlertCircle size={16} className="shrink-0 mt-0.5" /> {error}
            </div>
          )}
        </div>

        <div className="p-4 border-t border-slate-100 bg-slate-50 rounded-b-2xl flex flex-wrap items-center justify-end gap-2">
          {stage !== 'watching' && request && (
            <>
              <button type="button" onClick={() => onClose(null)} disabled={stage === 'starting'} className="px-4 py-2 rounded-lg text-sm text-slate-600 hover:bg-slate-100 disabled:opacity-60">Cancel</button>
              <button type="button" onClick={() => { void start(); }} disabled={stage === 'starting'} className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:opacity-60">
                {stage === 'starting' ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
                Send to {request.studentIds.length}
              </button>
            </>
          )}
          {stage === 'watching' && (
            <>
              {active && !confirmStop && (
                <button type="button" onClick={() => setConfirmStop(true)} className="mr-auto inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-slate-200 text-sm text-slate-600 hover:bg-white">
                  <Square size={13} /> Stop sending
                </button>
              )}
              {active && confirmStop && (
                <span className="mr-auto flex items-center gap-2 text-sm text-slate-700">
                  Stop the rest?
                  <button type="button" onClick={() => { void act('CANCEL'); }} disabled={!!busy} className="px-3 py-1.5 rounded-lg bg-rose-600 text-white text-sm hover:bg-rose-700 disabled:opacity-60">{busy === 'stop' ? 'Stopping…' : 'Yes, stop'}</button>
                  <button type="button" onClick={() => setConfirmStop(false)} disabled={!!busy} className="px-3 py-1.5 rounded-lg border border-slate-200 text-sm text-slate-600 hover:bg-white">No</button>
                </span>
              )}
              {job && !active && failedTotal > 0 && (
                <button type="button" onClick={() => { void act('RETRY_FAILED'); }} disabled={!!busy} className="mr-auto inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-slate-200 text-sm text-slate-700 hover:bg-white disabled:opacity-60">
                  {busy === 'retry' ? <Loader2 size={13} className="animate-spin" /> : <RotateCcw size={13} />} Retry the {failedTotal} that failed
                </button>
              )}
              <button type="button" onClick={() => onClose(job)} className="px-4 py-2 rounded-lg bg-slate-900 text-white text-sm font-medium hover:bg-slate-800">{active ? 'Close' : 'Done'}</button>
            </>
          )}
        </div>
      </div>
    </div>
  );
};
