import React, { useEffect, useMemo, useState } from 'react';
import { Building2, Download, Globe2, Shield, Users, FileBarChart2 } from 'lucide-react';
import {
  CompanyDirectoryRecord,
  PlatformBatchReportRow,
  PlatformCompanyRollup,
  PlatformExamReportRow,
  PlatformOverview,
  PlatformStudentReportRow,
} from '../../types';
import { apiGet, apiPost } from '../../services/api';
import { Pagination, usePagination } from './Pagination';

interface PlatformReportResponse {
  overview: PlatformOverview;
  dateFilter: { from: string; to: string } | null;
  companyRows: PlatformCompanyRollup[];
  examRows: PlatformExamReportRow[];
  batchRows: PlatformBatchReportRow[];
  studentRows: PlatformStudentReportRow[];
}

const emptyOverview: PlatformOverview = {
  companyCount: 0,
  activeCompanyCount: 0,
  platformUserCount: 0,
  examCount: 0,
  studentCount: 0,
  liveSessionCount: 0,
  completedSessionCount: 0,
  violationCount: 0,
  pendingRequestCount: 0,
  recordingCount: 0,
};

const downloadCsv = (filename: string, rows: Array<Record<string, unknown>>) => {
  if (rows.length === 0) return;
  const headers = Object.keys(rows[0]);
  const escape = (value: unknown) => `"${String(value ?? '').replace(/"/g, '""')}"`;
  const csv = [headers.join(','), ...rows.map(row => headers.map(header => escape(row[header])).join(','))].join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
};

export const SuperAdminControl: React.FC = () => {
  const [overview, setOverview] = useState<PlatformOverview>(emptyOverview);
  const [companies, setCompanies] = useState<CompanyDirectoryRecord[]>([]);
  const [companyRows, setCompanyRows] = useState<PlatformCompanyRollup[]>([]);
  const [examRows, setExamRows] = useState<PlatformExamReportRow[]>([]);
  const [batchRows, setBatchRows] = useState<PlatformBatchReportRow[]>([]);
  const [studentRows, setStudentRows] = useState<PlatformStudentReportRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [selectedCompanyId, setSelectedCompanyId] = useState<number | 'ALL'>('ALL');
  const [dateFilter, setDateFilter] = useState<{ from: string; to: string } | null>(null);
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [companyForm, setCompanyForm] = useState({
    name: '',
    code: '',
    contactName: '',
    contactEmail: '',
    status: 'ACTIVE' as CompanyDirectoryRecord['status'],
    notes: '',
  });

  const loadCompanies = async () => {
    try {
      const result = await apiGet<{ companies: CompanyDirectoryRecord[] }>('companies.php');
      setCompanies(result?.companies || []);
    } catch (e: any) {
      console.error('Failed to load companies:', e);
      setCompanies([]);
      setError(current => current || e?.message || 'Failed to load companies.');
    }
  };

  const loadReports = async (from = fromDate, to = toDate) => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams();
      if (selectedCompanyId !== 'ALL') params.set('companyId', String(selectedCompanyId));
      if (from) params.set('from', from);
      if (to) params.set('to', to);
      const query = params.toString();
      const result = await apiGet<PlatformReportResponse>(`platform_reports.php${query ? `?${query}` : ''}`);
      setOverview(result?.overview || emptyOverview);
      setDateFilter(result?.dateFilter || null);
      setCompanyRows(result?.companyRows || []);
      setExamRows(result?.examRows || []);
      setBatchRows(result?.batchRows || []);
      setStudentRows(result?.studentRows || []);
    } catch (e: any) {
      console.error('Failed to load platform reports:', e);
      setError(e?.message || 'Failed to load platform reports.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadCompanies();
  }, []);

  useEffect(() => {
    loadReports();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCompanyId]);

  const handleApplyDateFilter = () => {
    loadReports(fromDate, toDate);
  };

  const handleClearDateFilter = () => {
    setFromDate('');
    setToDate('');
    loadReports('', '');
  };

  const handleCreateCompany = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setMessage('');
    setError('');
    try {
      const result = await apiPost<{ company?: CompanyDirectoryRecord }>('companies.php', {
        action: 'CREATE',
        name: companyForm.name.trim(),
        code: companyForm.code.trim(),
        contactName: companyForm.contactName.trim(),
        contactEmail: companyForm.contactEmail.trim(),
        status: companyForm.status,
        notes: companyForm.notes.trim(),
      });
      await loadCompanies();
      await loadReports();
      setMessage(result?.company ? `Created company ${result.company.name}.` : 'Company created.');
      setCompanyForm({
        name: '',
        code: '',
        contactName: '',
        contactEmail: '',
        status: 'ACTIVE',
        notes: '',
      });
    } catch (e: any) {
      console.error('Failed to create company:', e);
      setError(e?.message || 'Failed to create company.');
    } finally {
      setSaving(false);
    }
  };

  const spotlightCompanies = useMemo(() => companyRows.slice(0, 6), [companyRows]);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h2 className="lsc-title flex items-center gap-2">
            <Shield size={20} className="text-[var(--lsc-primary)]" /> Super Admin Control Center
          </h2>
          <p className="lsc-subtitle mt-1">Global tenant governance, cross-company analytics, and platform-wide reporting.</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <select
            value={selectedCompanyId}
            onChange={e => setSelectedCompanyId(e.target.value === 'ALL' ? 'ALL' : Number(e.target.value))}
            className="px-4 py-2.5 border border-slate-200 rounded-xl bg-white text-sm outline-none"
          >
            <option value="ALL">All Companies</option>
            {companies.map(company => (
              <option key={company.id} value={company.id}>{company.name}</option>
            ))}
          </select>
          <div className="flex items-center gap-1.5">
            <label className="text-[11px] font-medium text-slate-500">From</label>
            <input
              type="date"
              value={fromDate}
              max={toDate || undefined}
              onChange={e => setFromDate(e.target.value)}
              className="px-2.5 py-2 border border-slate-200 rounded-xl text-xs outline-none bg-white"
            />
            <label className="text-[11px] font-medium text-slate-500">To</label>
            <input
              type="date"
              value={toDate}
              min={fromDate || undefined}
              onChange={e => setToDate(e.target.value)}
              className="px-2.5 py-2 border border-slate-200 rounded-xl text-xs outline-none bg-white"
            />
          </div>
          <button
            onClick={handleApplyDateFilter}
            disabled={loading || (!fromDate && !toDate)}
            className="px-3 py-2.5 rounded-xl border border-[var(--lsc-primary-50)] bg-[var(--lsc-primary-50)] text-xs font-semibold text-[var(--lsc-primary-700)] hover:bg-[var(--lsc-primary-50)]/70 disabled:opacity-50"
          >
            Apply
          </button>
          {(fromDate || toDate) && (
            <button
              onClick={handleClearDateFilter}
              disabled={loading}
              className="px-3 py-2.5 rounded-xl border border-slate-200 text-xs font-semibold text-slate-500 hover:bg-slate-50 disabled:opacity-50"
            >
              Clear
            </button>
          )}
          <button
            onClick={() => downloadCsv('exam-report.csv', examRows as unknown as Array<Record<string, unknown>>)}
            className="px-4 py-2.5 rounded-xl border border-slate-200 bg-white text-sm text-slate-700 hover:bg-slate-50 flex items-center gap-2"
          >
            <Download size={15} /> Export Exam Report
          </button>
        </div>
      </div>

      {message && <div className="text-sm text-emerald-700 bg-emerald-50 border border-emerald-100 rounded-xl px-4 py-3">{message}</div>}
      {error && <div className="text-sm text-rose-700 bg-rose-50 border border-rose-100 rounded-xl px-4 py-3">{error}</div>}
      {dateFilter && (
        <div className="text-xs text-slate-500">
          Showing exams and students with activity from <strong>{dateFilter.from}</strong> to <strong>{dateFilter.to}</strong>.
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-5 gap-4">
        <MetricCard title="Companies" value={overview.companyCount} accent="text-[var(--lsc-primary)]" icon={<Building2 size={18} />} />
        <MetricCard title="Platform Users" value={overview.platformUserCount} accent="text-[#1e8e3e]" icon={<Users size={18} />} />
        <MetricCard title="Live Sessions" value={overview.liveSessionCount} accent="text-[#d93025]" icon={<Globe2 size={18} />} />
        <MetricCard title="Violations" value={overview.violationCount} accent="text-[#e37400]" icon={<Shield size={18} />} />
        <MetricCard title="Pending Requests" value={overview.pendingRequestCount} accent="text-[#7c3aed]" icon={<FileBarChart2 size={18} />} />
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-[1.05fr,1.95fr] gap-6">
        <div className="lsc-panel p-6">
          <div className="flex items-center gap-2 mb-4">
            <Building2 size={18} className="text-[var(--lsc-primary)]" />
            <h3 className="text-lg font-semibold text-slate-900">Create Company</h3>
          </div>
          <form onSubmit={handleCreateCompany} className="space-y-4">
            <Field label="Company Name">
              <input
                value={companyForm.name}
                onChange={e => setCompanyForm(current => ({ ...current, name: e.target.value }))}
                className="mt-2 w-full px-4 py-3 border border-slate-200 rounded-xl bg-white outline-none text-sm"
                placeholder="LSC India"
              />
            </Field>
            <Field label="Code">
              <input
                value={companyForm.code}
                onChange={e => setCompanyForm(current => ({ ...current, code: e.target.value }))}
                className="mt-2 w-full px-4 py-3 border border-slate-200 rounded-xl bg-white outline-none text-sm"
                placeholder="lsc-india"
              />
            </Field>
            <Field label="Contact Name">
              <input
                value={companyForm.contactName}
                onChange={e => setCompanyForm(current => ({ ...current, contactName: e.target.value }))}
                className="mt-2 w-full px-4 py-3 border border-slate-200 rounded-xl bg-white outline-none text-sm"
                placeholder="Company owner"
              />
            </Field>
            <Field label="Contact Email">
              <input
                type="email"
                value={companyForm.contactEmail}
                onChange={e => setCompanyForm(current => ({ ...current, contactEmail: e.target.value }))}
                className="mt-2 w-full px-4 py-3 border border-slate-200 rounded-xl bg-white outline-none text-sm"
                placeholder="ops@company.com"
              />
            </Field>
            <Field label="Status">
              <select
                value={companyForm.status}
                onChange={e => setCompanyForm(current => ({ ...current, status: e.target.value as CompanyDirectoryRecord['status'] }))}
                className="mt-2 w-full px-4 py-3 border border-slate-200 rounded-xl bg-white outline-none text-sm"
              >
                <option value="ACTIVE">ACTIVE</option>
                <option value="INACTIVE">INACTIVE</option>
              </select>
            </Field>
            <Field label="Notes">
              <textarea
                value={companyForm.notes}
                onChange={e => setCompanyForm(current => ({ ...current, notes: e.target.value }))}
                className="mt-2 w-full min-h-[100px] px-4 py-3 border border-slate-200 rounded-xl bg-white outline-none text-sm resize-y"
                placeholder="Tenant-specific governance notes"
              />
            </Field>
            <button type="submit" disabled={saving} className="w-full lsc-button-primary py-3 disabled:opacity-60">
              {saving ? 'Creating Company...' : 'Create Company'}
            </button>
          </form>
        </div>

        <div className="space-y-6">
          <div className="lsc-panel p-6">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between mb-4">
              <div>
                <h3 className="text-lg font-semibold text-slate-900">Tenant Health</h3>
                <p className="text-xs text-slate-500">Top-level operating snapshot across the platform.</p>
              </div>
              {loading && <div className="text-xs text-slate-400">Refreshing analytics...</div>}
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
              {spotlightCompanies.map(company => (
                <div key={company.companyId} className="rounded-2xl border border-slate-200 bg-white p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="font-semibold text-slate-900">{company.companyName}</div>
                      <div className="text-xs text-slate-500 mt-1 uppercase tracking-[0.18em]">{company.companyCode}</div>
                    </div>
                    <span className={`inline-flex px-2.5 py-1 rounded-full border text-[11px] font-semibold ${company.status === 'ACTIVE' ? 'bg-emerald-100 text-emerald-700 border-emerald-200' : 'bg-slate-100 text-slate-600 border-slate-200'}`}>
                      {company.status}
                    </span>
                  </div>
                  <div className="grid grid-cols-2 gap-3 mt-4 text-sm">
                    <Stat label="Admins" value={company.adminCount} />
                    <Stat label="Proctors" value={company.proctorCount} />
                    <Stat label="Students" value={company.studentCount} />
                    <Stat label="Live" value={company.liveSessionCount} />
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
            <ReportTable
              title="Exam Report"
              rows={examRows.map(row => ({
                Company: row.companyName || row.companyId,
                Exam: row.examTitle,
                Sessions: row.sessionCount,
                Completed: row.completedCount,
                Violations: row.violationCount,
                AvgScore: row.averageScore,
              }))}
              onDownload={() => downloadCsv('platform-exams.csv', examRows as unknown as Array<Record<string, unknown>>)}
            />
            <ReportTable
              title="Batch Report"
              rows={batchRows.map(row => ({
                Company: row.companyName || row.companyId,
                Batch: row.batchName,
                Students: row.studentCount,
                Sessions: row.sessionCount,
                Violations: row.violationCount,
              }))}
              onDownload={() => downloadCsv('platform-batches.csv', batchRows as unknown as Array<Record<string, unknown>>)}
            />
            <ReportTable
              title="Student Report"
              rows={studentRows.map(row => ({
                Company: row.companyName || row.companyId,
                Student: row.fullName,
                Email: row.email,
                Sessions: row.sessionCount,
                Completed: row.completedCount,
                Violations: row.violationCount,
              }))}
              onDownload={() => downloadCsv('platform-students.csv', studentRows as unknown as Array<Record<string, unknown>>)}
            />
          </div>
        </div>
      </div>
    </div>
  );
};

const MetricCard = ({ title, value, accent, icon }: { title: string; value: number; accent: string; icon: React.ReactNode }) => (
  <div className="lsc-panel p-5 flex items-center justify-between">
    <div>
      <p className="text-xs font-semibold text-slate-500 uppercase tracking-[0.18em]">{title}</p>
      <div className="text-3xl font-semibold text-slate-900 mt-2">{value}</div>
    </div>
    <div className={`p-3 rounded-2xl border bg-slate-50 ${accent}`}>{icon}</div>
  </div>
);

const Field: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div>
    <label className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">{label}</label>
    {children}
  </div>
);

const Stat = ({ label, value }: { label: string; value: number }) => (
  <div>
    <div className="text-[11px] uppercase tracking-[0.16em] text-slate-400">{label}</div>
    <div className="text-lg font-semibold text-slate-900 mt-1">{value}</div>
  </div>
);

const REPORT_TABLE_PAGE_SIZE = 8;

const ReportTable = ({ title, rows, onDownload }: { title: string; rows: Array<Record<string, unknown>>; onDownload: () => void }) => {
  // Report tables sit several to a screen, so they keep a small fixed page size rather than following
  // the global "Rows per page" preference.
  const paging = usePagination(rows, title, REPORT_TABLE_PAGE_SIZE);

  return (
    <div className="lsc-panel overflow-hidden">
      <div className="p-4 lsc-panel-header border-b border-slate-200/70 flex items-center justify-between gap-3">
        <div>
          <div className="font-semibold text-slate-900">{title}</div>
          <div className="text-xs text-slate-500 mt-1">{rows.length} row{rows.length === 1 ? '' : 's'} for the current filter</div>
        </div>
        <button onClick={onDownload} className="text-xs px-3 py-2 rounded-lg border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 flex items-center gap-2">
          <Download size={14} /> CSV
        </button>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-white border-b border-slate-200 text-xs uppercase tracking-[0.16em] text-slate-400">
            <tr>
              {rows[0] ? Object.keys(rows[0]).map(key => <th key={key} className="px-4 py-3 text-left">{key}</th>) : <th className="px-4 py-3 text-left">No Data</th>}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td className="px-4 py-8 text-slate-400">No report rows for the current filter.</td>
              </tr>
            )}
            {paging.pageItems.map((row, index) => (
              <tr key={`${title}-${paging.page}-${index}`} className="border-b border-slate-100 last:border-b-0">
                {Object.values(row).map((value, cellIndex) => (
                  <td key={`${title}-${paging.page}-${index}-${cellIndex}`} className="px-4 py-3 text-slate-700">
                    {String(value)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Pagination state={paging} label="rows" hidePageSize />
    </div>
  );
};

