import React, { useEffect, useMemo, useState } from 'react';
import { Award, RefreshCw, Loader2, ChevronDown, ChevronRight, Mail, RotateCw } from 'lucide-react';
import { apiGet, apiPost } from '../../services/api';
import { Pagination, usePagination } from './Pagination';
import { CertificateIssuance, UserRole } from '../../types';

// DEAD = retries exhausted (certificates.php marks an issuance DEAD after CERTIFICATE_MAX_ATTEMPTS).
// It was missing here, so DEAD rows got a neutral badge and couldn't be filtered for at all.
const STATUS_TONE: Record<string, string> = {
  PENDING: 'bg-slate-100 text-slate-600 border-slate-200',
  ISSUED: 'bg-emerald-100 text-emerald-700 border-emerald-200',
  FAILED: 'bg-amber-100 text-amber-700 border-amber-200',
  DEAD: 'bg-rose-100 text-rose-700 border-rose-200',
};

// Human-readable outcome of a manual Retry (the `status` certificates.php returns).
const RETRY_OUTCOME_TEXT: Record<string, string> = {
  ISSUED: 'Certificate issued.',
  ALREADY_ISSUED: 'This certificate was already issued.',
  FAILED: 'Retry failed again — see the error on the row.',
  DEAD: 'Retry limit reached — this issuance will not be retried again.',
  DISABLED: 'Certification is turned off for this exam, so nothing was issued.',
  NOT_ELIGIBLE: 'This attempt is not eligible (not passed, or still pending manual grading).',
  LOCK_BUSY: 'Another process is handling this certificate right now — try again shortly.',
};

const StatusBadge: React.FC<{ status: string }> = ({ status }) => (
  <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium ${STATUS_TONE[status] || 'bg-slate-100 text-slate-600 border-slate-200'}`}>
    {status}
  </span>
);

export const Certificates: React.FC<{ role?: UserRole }> = ({ role }) => {
  const [issuances, setIssuances] = useState<CertificateIssuance[]>([]);
  const [loading, setLoading] = useState(false);
  const [statusFilter, setStatusFilter] = useState('ALL');
  const [expanded, setExpanded] = useState<number | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [notice, setNotice] = useState<{ tone: 'success' | 'warn' | 'error'; text: string } | null>(null);

  const isFullAdmin = role === UserRole.ADMIN || role === UserRole.SUPER_ADMIN;

  const load = async () => {
    setLoading(true);
    try {
      const data = await apiGet<{ issuances: CertificateIssuance[] }>('certificates.php');
      setIssuances(data?.issuances || []);
    } catch (e: any) {
      console.error('Failed to load certificate issuances:', e);
      setNotice({ tone: 'error', text: e?.message || 'Could not load certificate issuances.' });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const filtered = useMemo(() => {
    if (statusFilter === 'ALL') return issuances;
    return issuances.filter(i => i.status === statusFilter);
  }, [issuances, statusFilter]);

  const paging = usePagination(filtered, statusFilter);

  const handleRetry = async (issuance: CertificateIssuance) => {
    setBusyId(issuance.id);
    setNotice(null);
    try {
      // The API answers 200 with the outcome (ISSUED / FAILED / DEAD / DISABLED / NOT_ELIGIBLE /
      // LOCK_BUSY …). It used to be ignored, so a retry that changed nothing looked like a dead button.
      const res = await apiPost<{ ok?: boolean; status?: string }>('certificates.php', { action: 'RETRY', id: issuance.id });
      const outcome = String(res?.status || '');
      setNotice({
        tone: outcome === 'ISSUED' || outcome === 'ALREADY_ISSUED' ? 'success' : 'warn',
        text: RETRY_OUTCOME_TEXT[outcome] || `Retry finished${outcome ? ` (${outcome})` : ''}.`,
      });
      await load();
    } catch (e: any) {
      alert(e?.message || 'Could not retry issuance.');
    } finally {
      setBusyId(null);
    }
  };

  const handleResend = async (issuance: CertificateIssuance) => {
    setBusyId(issuance.id);
    setNotice(null);
    try {
      await apiPost('certificates.php', { action: 'RESEND', id: issuance.id });
      setNotice({ tone: 'success', text: `Certificate email re-sent to ${issuance.studentEmail || issuance.studentName}.` });
      await load();
    } catch (e: any) {
      alert(e?.message || 'Could not resend certificate email.');
    } finally {
      setBusyId(null);
    }
  };

  if (!isFullAdmin) {
    return <div className="lsc-panel p-6 text-sm text-slate-500">You don't have access to Certificates.</div>;
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h2 className="lsc-title flex items-center gap-2"><Award size={20} /> Certificates</h2>
          <p className="lsc-subtitle mt-1">
            Certificates are issued on demand only, from a passed result in Results, and only for exams with certification enabled. The external certificate system isn't wired up yet — issuances show FAILED/DEAD with the reason until that's configured.
          </p>
        </div>
        <button onClick={load} disabled={loading} className="px-3.5 py-2 lsc-button-ghost text-sm inline-flex items-center gap-2 self-start disabled:opacity-60">
          <RefreshCw size={15} className={loading ? 'animate-spin' : ''} /> Refresh
        </button>
      </div>

      {notice && (
        <div
          role={notice.tone === 'success' ? 'status' : 'alert'}
          className={`flex items-start justify-between gap-3 text-sm rounded-lg border px-3.5 py-2.5 ${
            notice.tone === 'success'
              ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
              : notice.tone === 'warn'
                ? 'bg-amber-50 border-amber-200 text-amber-800'
                : 'bg-rose-50 border-rose-200 text-rose-700'
          }`}
        >
          <span>{notice.text}</span>
          <button onClick={() => setNotice(null)} className="text-xs opacity-70 hover:opacity-100 shrink-0">Dismiss</button>
        </div>
      )}

      <div className="lsc-panel overflow-hidden">
        <div className="p-4 lsc-panel-header flex flex-wrap items-center justify-between gap-3">
          <div className="text-sm font-semibold text-slate-800">Issuances</div>
          <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)} aria-label="Filter by status" className="px-3 py-1.5 border border-slate-200 rounded-lg text-xs outline-none bg-white">
            <option value="ALL">All statuses</option>
            {Object.keys(STATUS_TONE).map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        {loading && <div className="p-6 text-sm text-slate-400">Loading issuances...</div>}
        {!loading && filtered.length === 0 && (
          <div className="p-6 text-sm text-slate-400">
            {issuances.length > 0
              ? `No issuances with status ${statusFilter}.`
              : 'No certificate issuances yet — an admin issues one on demand from a passed result in Results.'}
          </div>
        )}
        {!loading && filtered.length > 0 && (
          <div className="lsc-table-wrap">
            <table className="w-full text-left text-sm">
              <thead className="bg-white border-b border-slate-200 text-xs uppercase tracking-widest text-slate-400">
                <tr>
                  <th className="px-4 py-3 w-6"></th>
                  <th className="px-4 py-3">Student</th>
                  <th className="px-4 py-3">Exam</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Emailed</th>
                  <th className="px-4 py-3">Error</th>
                  <th className="px-4 py-3"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {paging.pageItems.map(row => {
                  const isExpanded = expanded === row.id;
                  return (
                    <React.Fragment key={row.id}>
                      <tr className="text-slate-700 hover:bg-slate-50/70 cursor-pointer" onClick={() => setExpanded(isExpanded ? null : row.id)}>
                        <td className="px-4 py-3">{isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</td>
                        <td className="px-4 py-3">
                          <div className="font-medium">{row.studentName}</div>
                          <div className="text-xs text-slate-400">{row.studentEmail}</div>
                        </td>
                        <td className="px-4 py-3">{row.examTitle}</td>
                        <td className="px-4 py-3"><StatusBadge status={row.status} /></td>
                        <td className="px-4 py-3 text-xs text-slate-500">{row.emailCount > 0 ? `${row.emailCount}× sent` : '—'}</td>
                        <td className="px-4 py-3 max-w-xs truncate text-rose-600">{row.error || ''}</td>
                        <td className="px-4 py-3 text-right">
                          <div className="flex items-center justify-end gap-1.5">
                            {row.status === 'FAILED' && (
                              <button
                                onClick={(e) => { e.stopPropagation(); handleRetry(row); }}
                                disabled={busyId === row.id}
                                className="px-2.5 py-1.5 lsc-button-ghost text-xs inline-flex items-center gap-1.5 disabled:opacity-60"
                              >
                                {busyId === row.id ? <Loader2 size={13} className="animate-spin" /> : <RotateCw size={13} />} Retry
                              </button>
                            )}
                            {row.status === 'ISSUED' && (
                              <button
                                onClick={(e) => { e.stopPropagation(); handleResend(row); }}
                                disabled={busyId === row.id}
                                className="px-2.5 py-1.5 lsc-button-ghost text-xs inline-flex items-center gap-1.5 disabled:opacity-60"
                              >
                                {busyId === row.id ? <Loader2 size={13} className="animate-spin" /> : <Mail size={13} />} Resend
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                      {isExpanded && (
                        <tr className="bg-slate-50/70">
                          <td colSpan={7} className="px-4 py-3 text-xs text-slate-600 space-y-1">
                            <div>Verification ID: <code className="bg-white border border-slate-200 rounded px-1.5 py-0.5">{row.verificationId}</code></div>
                            {row.verificationUrl && <div>Verification URL: <a className="text-[var(--lsc-primary)]" href={row.verificationUrl} target="_blank" rel="noreferrer">{row.verificationUrl}</a></div>}
                            <div>Attempts: {row.attempts}</div>
                            {row.issuedAt && <div>Issued: {new Date(row.issuedAt).toLocaleString()}</div>}
                            {row.lastEmailedAt && <div>Last emailed: {new Date(row.lastEmailedAt).toLocaleString()}</div>}
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {!loading && filtered.length > 0 && <Pagination state={paging} label="certificates" />}
      </div>
    </div>
  );
};
