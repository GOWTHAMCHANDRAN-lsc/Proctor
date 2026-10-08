import React, { useEffect, useMemo, useState } from 'react';
import {
  Webhook, Plus, RefreshCw, Copy, Check, AlertCircle, KeyRound, Trash2,
  ChevronDown, ChevronRight, Loader2, Ban, Link2, Settings2
} from 'lucide-react';
import { apiGet, apiPost } from '../../services/api';
import { Pagination, usePagination } from './Pagination';
import { Exam, Batch, IntegrationConnector, IntegrationEvent, CourseExamMapping, UserRole } from '../../types';

const inputCls = 'w-full px-3.5 py-2.5 border border-slate-300 rounded-lg outline-none text-slate-800 bg-white text-sm';

// Must match default_field_map() in api/integrations.php — dot-paths into the webhook's JSON payload.
const DEFAULT_FIELD_MAP: Record<string, string> = {
  externalEventId: 'eventId',
  eventType: 'eventType',
  courseId: 'courseId',
  learnerId: 'learner.id',
  email: 'learner.email',
  fullName: 'learner.name',
};

const FIELD_MAP_LABELS: Array<{ key: keyof typeof DEFAULT_FIELD_MAP; label: string; hint: string }> = [
  { key: 'eventType', label: 'Event type', hint: 'Must resolve to the literal string "completed" to trigger scheduling' },
  { key: 'courseId', label: 'Course ID', hint: 'Matched against a mapping\'s External course id' },
  { key: 'email', label: 'Learner email', hint: '' },
  { key: 'learnerId', label: 'Learner ID', hint: 'Used to link repeat events for the same learner' },
  { key: 'fullName', label: 'Learner name', hint: '' },
  { key: 'externalEventId', label: 'Event ID', hint: 'Idempotency key — falls back to a payload hash if empty' },
];

const FieldMapEditor: React.FC<{ value: Record<string, string>; onChange: (v: Record<string, string>) => void }> = ({ value, onChange }) => (
  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
    {FIELD_MAP_LABELS.map(({ key, label, hint }) => (
      <div key={key}>
        <label className="block text-[11px] font-medium text-slate-500 mb-1">{label}</label>
        <input
          className={inputCls}
          aria-label={label}
          placeholder={DEFAULT_FIELD_MAP[key]}
          value={value[key] ?? ''}
          onChange={e => onChange({ ...value, [key]: e.target.value })}
        />
        {hint && <p className="text-[11px] text-slate-400 mt-0.5">{hint}</p>}
      </div>
    ))}
  </div>
);

const STATUS_TONE: Record<string, string> = {
  RECEIVED: 'bg-slate-100 text-slate-600 border-slate-200',
  PROCESSED: 'bg-emerald-100 text-emerald-700 border-emerald-200',
  FAILED: 'bg-amber-100 text-amber-700 border-amber-200',
  DEAD: 'bg-rose-100 text-rose-700 border-rose-200',
  UNMAPPED: 'bg-violet-100 text-violet-700 border-violet-200',
  SKIPPED_GATE: 'bg-slate-100 text-slate-500 border-slate-200',
};

const StatusBadge: React.FC<{ status: string }> = ({ status }) => (
  <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium ${STATUS_TONE[status] || 'bg-slate-100 text-slate-600 border-slate-200'}`}>
    {status}
  </span>
);

const Section: React.FC<{ icon: React.ReactNode; title: string; subtitle: string; action?: React.ReactNode; children: React.ReactNode }> = ({ icon, title, subtitle, action, children }) => (
  <div className="lsc-panel p-5 sm:p-6">
    <div className="flex flex-wrap items-start justify-between gap-3 mb-5">
      <div className="flex items-start gap-3 min-w-0">
        <div className="lsc-icon-tile-primary p-2.5 shrink-0">{icon}</div>
        <div className="min-w-0">
          <h3 className="text-base font-semibold text-slate-900">{title}</h3>
          <p className="text-sm text-slate-500">{subtitle}</p>
        </div>
      </div>
      {action}
    </div>
    {children}
  </div>
);

const webhookUrlFor = (connectorId: string) => {
  const base = (import.meta.env.VITE_API_BASE || '/api').replace(/\/+$/, '');
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const path = `${base}/integrations.php?connector=${encodeURIComponent(connectorId)}`;
  return path.startsWith('http') ? path : `${origin}${path}`;
};

const CopyButton: React.FC<{ value: string }> = ({ value }) => {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  // Only claim "Copied" once the clipboard write actually succeeded. It used to flash "Copied" even
  // when the Clipboard API was unavailable or refused — and the webhook secret is shown only once, so
  // an admin who trusted that and dismissed the banner lost the secret and had to rotate it.
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
      {state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : 'Copy'}
    </button>
  );
};

export const Integrations: React.FC<{ role?: UserRole }> = ({ role }) => {
  const [connectors, setConnectors] = useState<IntegrationConnector[]>([]);
  const [mappings, setMappings] = useState<CourseExamMapping[]>([]);
  const [events, setEvents] = useState<IntegrationEvent[]>([]);
  const [exams, setExams] = useState<Exam[]>([]);
  const [batches, setBatches] = useState<Batch[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [statusFilter, setStatusFilter] = useState('ALL');
  const [expandedEvent, setExpandedEvent] = useState<number | null>(null);
  const [retryingId, setRetryingId] = useState<number | null>(null);

  const [newConnectorName, setNewConnectorName] = useState('');
  const [creatingConnector, setCreatingConnector] = useState(false);
  const [revealSecret, setRevealSecret] = useState<{ id: string; secret: string } | null>(null);
  const [showFieldMap, setShowFieldMap] = useState(false);
  const [newFieldMap, setNewFieldMap] = useState<Record<string, string>>({});
  const [editingMappingFor, setEditingMappingFor] = useState<string | null>(null);
  const [editFieldMap, setEditFieldMap] = useState<Record<string, string>>({});
  const [savingFieldMap, setSavingFieldMap] = useState(false);

  const [mappingForm, setMappingForm] = useState({ connectorId: '', externalCourseId: '', examId: '', batchId: '' });
  const [savingMapping, setSavingMapping] = useState(false);

  const isFullAdmin = role === UserRole.ADMIN || role === UserRole.SUPER_ADMIN;

  const loadAll = async () => {
    setLoading(true);
    setLoadError('');
    try {
      // allSettled, not all: one failing request (e.g. batches) used to blank the whole screen, which
      // then read as "No connectors yet" — indistinguishable from a genuinely empty setup.
      const [connRes, mapRes, evtRes, examRes, batchRes] = await Promise.allSettled([
        apiGet<{ connectors: IntegrationConnector[] }>('integrations.php'),
        apiGet<{ mappings: CourseExamMapping[] }>('integrations.php?action=mappings'),
        apiGet<{ events: IntegrationEvent[] }>('integrations.php?action=events'),
        apiGet<{ exams: Exam[] }>('exams.php'),
        apiGet<{ batches: Batch[] }>('batches.php'),
      ]);
      if (connRes.status === 'fulfilled') setConnectors(connRes.value?.connectors || []);
      if (mapRes.status === 'fulfilled') setMappings(mapRes.value?.mappings || []);
      if (evtRes.status === 'fulfilled') setEvents(evtRes.value?.events || []);
      if (examRes.status === 'fulfilled') setExams(examRes.value?.exams || []);
      if (batchRes.status === 'fulfilled') setBatches(batchRes.value?.batches || []);
      const failed = [connRes, mapRes, evtRes, examRes, batchRes].filter(r => r.status === 'rejected');
      if (failed.length > 0) {
        failed.forEach(r => console.error('Failed to load integrations data:', (r as PromiseRejectedResult).reason));
        setLoadError('Some integration data could not be loaded. The lists below may be incomplete — try Refresh.');
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadAll(); }, []);

  const examTitle = useMemo(() => {
    const map = new Map<string, string>();
    exams.forEach(e => map.set(e.id, e.title));
    return map;
  }, [exams]);

  const filteredEvents = useMemo(() => {
    if (statusFilter === 'ALL') return events;
    return events.filter(e => e.status === statusFilter);
  }, [events, statusFilter]);

  const eventPaging = usePagination(filteredEvents, statusFilter);

  const handleCreateConnector = async () => {
    const name = newConnectorName.trim();
    if (!name) return;
    setCreatingConnector(true);
    try {
      const res = await apiPost<{ ok: boolean; webhookSecret: string; connector: IntegrationConnector }>('integrations.php', {
        action: 'CREATE_CONNECTOR',
        name,
        fieldMap: newFieldMap,
      });
      if (res?.ok) {
        setNewConnectorName('');
        setNewFieldMap({});
        setShowFieldMap(false);
        setRevealSecret({ id: res.connector.id, secret: res.webhookSecret });
        await loadAll();
      }
    } catch (e: any) {
      alert(e?.message || 'Could not create connector.');
    } finally {
      setCreatingConnector(false);
    }
  };

  const handleSaveFieldMap = async (connectorId: string) => {
    setSavingFieldMap(true);
    try {
      await apiPost('integrations.php', { action: 'UPDATE_CONNECTOR', id: connectorId, fieldMap: editFieldMap });
      setEditingMappingFor(null);
      await loadAll();
    } catch (e: any) {
      alert(e?.message || 'Could not save field mapping.');
    } finally {
      setSavingFieldMap(false);
    }
  };

  const handleToggleConnector = async (connector: IntegrationConnector) => {
    try {
      await apiPost('integrations.php', {
        action: 'UPDATE_CONNECTOR',
        id: connector.id,
        status: connector.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE',
      });
      await loadAll();
    } catch (e: any) {
      alert(e?.message || 'Could not update connector.');
    }
  };

  const handleRotateSecret = async (connector: IntegrationConnector) => {
    if (!confirm(`Rotate the webhook secret for "${connector.name}"? The old secret will stop working immediately — update the source platform with the new one.`)) return;
    try {
      const res = await apiPost<{ ok: boolean; webhookSecret: string }>('integrations.php', { action: 'ROTATE_SECRET', id: connector.id });
      if (res?.ok) {
        setRevealSecret({ id: connector.id, secret: res.webhookSecret });
        await loadAll();
      }
    } catch (e: any) {
      alert(e?.message || 'Could not rotate secret.');
    }
  };

  const handleDeleteConnector = async (connector: IntegrationConnector) => {
    if (!confirm(`Delete connector "${connector.name}"? Its webhook URL will stop accepting events. This does not remove exams/students already created from it.`)) return;
    try {
      await apiPost('integrations.php', { action: 'DELETE_CONNECTOR', id: connector.id });
      await loadAll();
    } catch (e: any) {
      alert(e?.message || 'Could not delete connector.');
    }
  };

  const handleSaveMapping = async () => {
    const { connectorId, externalCourseId, examId, batchId } = mappingForm;
    if (!connectorId || !externalCourseId.trim() || !examId) return;
    setSavingMapping(true);
    try {
      await apiPost('integrations.php', {
        action: 'CREATE_MAPPING',
        connectorId,
        externalCourseId: externalCourseId.trim(),
        examId,
        batchId: batchId || null,
      });
      setMappingForm({ connectorId, externalCourseId: '', examId: '', batchId: '' });
      await loadAll();
    } catch (e: any) {
      alert(e?.message || 'Could not save mapping.');
    } finally {
      setSavingMapping(false);
    }
  };

  const handleDeleteMapping = async (mapping: CourseExamMapping) => {
    if (!confirm(`Remove the mapping for course "${mapping.externalCourseId}"? Future completion events for it will be held as UNMAPPED.`)) return;
    try {
      await apiPost('integrations.php', { action: 'DELETE_MAPPING', id: mapping.id });
      await loadAll();
    } catch (e: any) {
      alert(e?.message || 'Could not delete mapping.');
    }
  };

  const handleRetryEvent = async (event: IntegrationEvent) => {
    setRetryingId(event.id);
    try {
      await apiPost('integrations.php', { action: 'RETRY_EVENT', eventId: event.id });
      await loadAll();
    } catch (e: any) {
      alert(e?.message || 'Could not retry event.');
    } finally {
      setRetryingId(null);
    }
  };

  if (!isFullAdmin) {
    return (
      <div className="lsc-panel p-6 text-sm text-slate-500">
        You don't have access to Integrations.
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h2 className="lsc-title flex items-center gap-2"><Webhook size={20} /> Integrations</h2>
          <p className="lsc-subtitle mt-1">
            Connect an external course platform's completion webhook to auto-schedule the matching exam — no manual invite needed.
          </p>
        </div>
        <button onClick={loadAll} disabled={loading} className="px-3.5 py-2 lsc-button-ghost text-sm inline-flex items-center gap-2 self-start disabled:opacity-60">
          <RefreshCw size={15} className={loading ? 'animate-spin' : ''} /> Refresh
        </button>
      </div>

      {loadError && (
        <div role="alert" className="flex items-start gap-2 text-sm text-rose-700 bg-rose-50 border border-rose-200 rounded-lg px-3.5 py-2.5">
          <AlertCircle size={16} className="mt-0.5 shrink-0" />
          <span>{loadError}</span>
        </div>
      )}

      {/* Connectors */}
      <Section
        icon={<Link2 size={18} />}
        title="Connectors"
        subtitle="Each connector is a unique, secret-protected webhook URL for one source platform."
        action={
          <div className="flex items-center gap-2">
            <input
              className={`${inputCls} w-48`}
              placeholder="Connector name"
              aria-label="New connector name"
              value={newConnectorName}
              onChange={e => setNewConnectorName(e.target.value)}
            />
            <button
              onClick={handleCreateConnector}
              disabled={creatingConnector || !newConnectorName.trim()}
              className="px-3.5 py-2 lsc-button-primary text-sm inline-flex items-center gap-2 disabled:opacity-60"
            >
              {creatingConnector ? <Loader2 size={15} className="animate-spin" /> : <Plus size={15} />}
              Create
            </button>
          </div>
        }
      >
        <div className="mb-4">
          <button
            type="button"
            onClick={() => setShowFieldMap(v => !v)}
            className="text-xs text-slate-500 hover:text-slate-700 inline-flex items-center gap-1.5"
          >
            <Settings2 size={13} /> {showFieldMap ? 'Hide' : 'Advanced: field mapping for the new connector'}
          </button>
          {showFieldMap && (
            <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-4">
              <p className="text-xs text-slate-500 mb-3">
                Dot-paths into the webhook's JSON payload. Leave a field blank to use its default (shown as placeholder text).
              </p>
              <FieldMapEditor value={newFieldMap} onChange={setNewFieldMap} />
            </div>
          )}
        </div>

        {revealSecret && (
          <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-4 space-y-2">
            <p className="text-xs font-semibold text-amber-800 uppercase tracking-wide flex items-center gap-1.5">
              <AlertCircle size={13} /> Copy this now — the secret won't be shown again
            </p>
            <div className="flex items-center gap-2">
              <code className="flex-1 min-w-0 truncate px-2.5 py-1.5 bg-white border border-slate-200 rounded text-xs">{webhookUrlFor(revealSecret.id)}</code>
              <CopyButton value={webhookUrlFor(revealSecret.id)} />
            </div>
            <div className="flex items-center gap-2">
              <code className="flex-1 min-w-0 truncate px-2.5 py-1.5 bg-white border border-slate-200 rounded text-xs">X-Webhook-Secret: {revealSecret.secret}</code>
              <CopyButton value={revealSecret.secret} />
            </div>
            <button onClick={() => setRevealSecret(null)} className="text-xs text-amber-700 hover:underline">Dismiss</button>
          </div>
        )}

        {connectors.length === 0 && !loading && (
          <p className="text-sm text-slate-400">No connectors yet. Create one to get a webhook URL you can hand to a source platform.</p>
        )}
        <div className="space-y-2">
          {connectors.map(c => (
            <div key={c.id} className="rounded-lg border border-slate-200 px-4 py-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-slate-800">{c.name}</span>
                    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${c.status === 'ACTIVE' ? 'bg-emerald-100 text-emerald-700 border-emerald-200' : 'bg-slate-100 text-slate-500 border-slate-200'}`}>
                      {c.status}
                    </span>
                  </div>
                  <code className="text-xs text-slate-400 truncate block mt-0.5">{webhookUrlFor(c.id)}</code>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  <button
                    onClick={() => { setEditingMappingFor(editingMappingFor === c.id ? null : c.id); setEditFieldMap(c.fieldMap || {}); }}
                    className="px-2.5 py-1.5 lsc-button-ghost text-xs inline-flex items-center gap-1.5"
                  >
                    <Settings2 size={13} /> Field mapping
                  </button>
                  <button onClick={() => handleRotateSecret(c)} className="px-2.5 py-1.5 lsc-button-ghost text-xs inline-flex items-center gap-1.5">
                    <KeyRound size={13} /> Rotate secret
                  </button>
                  <button onClick={() => handleToggleConnector(c)} className="px-2.5 py-1.5 lsc-button-ghost text-xs inline-flex items-center gap-1.5">
                    <Ban size={13} /> {c.status === 'ACTIVE' ? 'Disable' : 'Enable'}
                  </button>
                  <button
                    onClick={() => handleDeleteConnector(c)}
                    className="px-2.5 py-1.5 text-xs text-slate-500 hover:text-red-600 inline-flex items-center gap-1.5"
                    title="Delete connector"
                    aria-label={`Delete connector ${c.name}`}
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              </div>
              {editingMappingFor === c.id && (
                <div className="mt-3 pt-3 border-t border-slate-100">
                  <FieldMapEditor value={editFieldMap} onChange={setEditFieldMap} />
                  <div className="flex items-center gap-2 mt-3">
                    <button
                      onClick={() => handleSaveFieldMap(c.id)}
                      disabled={savingFieldMap}
                      className="px-3 py-1.5 lsc-button-primary text-xs inline-flex items-center gap-1.5 disabled:opacity-60"
                    >
                      {savingFieldMap ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />} Save mapping
                    </button>
                    <button onClick={() => setEditingMappingFor(null)} className="px-3 py-1.5 lsc-button-ghost text-xs">Cancel</button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      </Section>

      {/* Course -> Exam mappings */}
      <Section
        icon={<Webhook size={18} />}
        title="Course → Exam mapping"
        subtitle="When a mapped course's completion event arrives, the exam below is auto-assigned and invited. Unmapped courses are held, never dropped."
      >
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3 mb-5">
          <select className={inputCls} aria-label="Connector" value={mappingForm.connectorId} onChange={e => setMappingForm(f => ({ ...f, connectorId: e.target.value }))}>
            <option value="">Connector…</option>
            {connectors.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <input
            className={inputCls}
            placeholder="External course id"
            aria-label="External course id"
            value={mappingForm.externalCourseId}
            onChange={e => setMappingForm(f => ({ ...f, externalCourseId: e.target.value }))}
          />
          <select className={inputCls} aria-label="Exam" value={mappingForm.examId} onChange={e => setMappingForm(f => ({ ...f, examId: e.target.value }))}>
            <option value="">Exam…</option>
            {exams.map(e => <option key={e.id} value={e.id}>{e.title}</option>)}
          </select>
          <select className={inputCls} aria-label="Batch (optional)" value={mappingForm.batchId} onChange={e => setMappingForm(f => ({ ...f, batchId: e.target.value }))}>
            <option value="">Batch (optional)</option>
            {batches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
          <button
            onClick={handleSaveMapping}
            disabled={savingMapping || !mappingForm.connectorId || !mappingForm.externalCourseId.trim() || !mappingForm.examId}
            className="px-3.5 py-2 lsc-button-primary text-sm inline-flex items-center justify-center gap-2 disabled:opacity-60"
          >
            {savingMapping ? <Loader2 size={15} className="animate-spin" /> : <Plus size={15} />} Add mapping
          </button>
        </div>

        {mappings.length === 0 && !loading && (
          <p className="text-sm text-slate-400">No course mappings yet.</p>
        )}
        <div className="space-y-2">
          {mappings.map(m => (
            <div key={m.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-200 px-4 py-3">
              <div className="text-sm text-slate-700">
                <span className="font-mono text-xs bg-slate-100 rounded px-1.5 py-0.5">{m.externalCourseId}</span>
                <span className="text-slate-400 mx-2">→</span>
                <span className="font-medium">{m.examTitle || examTitle.get(m.examId) || m.examId}</span>
                {m.batchName && <span className="text-slate-400 ml-2">· batch {m.batchName}</span>}
                {!m.active && <span className="ml-2 text-xs text-slate-400">(inactive)</span>}
              </div>
              <button
                onClick={() => handleDeleteMapping(m)}
                className="px-2.5 py-1.5 text-xs text-slate-500 hover:text-red-600 inline-flex items-center gap-1.5 shrink-0"
                title="Remove mapping"
                aria-label={`Remove mapping for course ${m.externalCourseId}`}
              >
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </div>
      </Section>

      {/* Event log */}
      <div className="lsc-panel overflow-hidden">
        <div className="p-4 lsc-panel-header flex flex-wrap items-center justify-between gap-3">
          <div className="text-sm font-semibold text-slate-800">Event log</div>
          <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)} aria-label="Filter events by status" className="px-3 py-1.5 border border-slate-200 rounded-lg text-xs outline-none bg-white">
            <option value="ALL">All statuses</option>
            {Object.keys(STATUS_TONE).map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        {loading && <div className="p-6 text-sm text-slate-400">Loading events...</div>}
        {!loading && filteredEvents.length === 0 && <div className="p-6 text-sm text-slate-400">No events yet.</div>}
        {!loading && filteredEvents.length > 0 && (
          <div className="lsc-table-wrap">
            <table className="w-full text-left text-sm">
              <thead className="bg-white border-b border-slate-200 text-xs uppercase tracking-widest text-slate-400">
                <tr>
                  <th className="px-4 py-3 w-6"></th>
                  <th className="px-4 py-3">Received</th>
                  <th className="px-4 py-3">Connector</th>
                  <th className="px-4 py-3">Type</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Error</th>
                  <th className="px-4 py-3"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {eventPaging.pageItems.map(ev => {
                  const connectorName = connectors.find(c => c.id === ev.connectorId)?.name || ev.connectorId;
                  const canRetry = ['FAILED', 'DEAD', 'UNMAPPED'].includes(ev.status);
                  const expanded = expandedEvent === ev.id;
                  return (
                    <React.Fragment key={ev.id}>
                      <tr className="text-slate-700 hover:bg-slate-50/70 cursor-pointer" onClick={() => setExpandedEvent(expanded ? null : ev.id)}>
                        <td className="px-4 py-3">{expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</td>
                        <td className="px-4 py-3 whitespace-nowrap">{new Date(ev.receivedAt).toLocaleString()}</td>
                        <td className="px-4 py-3">{connectorName}</td>
                        <td className="px-4 py-3">{ev.eventType || '—'}</td>
                        <td className="px-4 py-3"><StatusBadge status={ev.status} /></td>
                        <td className="px-4 py-3 max-w-xs truncate text-rose-600">{ev.error || ''}</td>
                        <td className="px-4 py-3 text-right">
                          {canRetry && (
                            <button
                              onClick={(e) => { e.stopPropagation(); handleRetryEvent(ev); }}
                              disabled={retryingId === ev.id}
                              className="px-2.5 py-1.5 lsc-button-ghost text-xs inline-flex items-center gap-1.5 disabled:opacity-60"
                            >
                              {retryingId === ev.id ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />} Retry
                            </button>
                          )}
                        </td>
                      </tr>
                      {expanded && (
                        <tr className="bg-slate-50/70">
                          <td colSpan={7} className="px-4 py-3">
                            <pre className="text-xs text-slate-600 whitespace-pre-wrap break-all">{JSON.stringify(ev.payload, null, 2)}</pre>
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
        {!loading && filteredEvents.length > 0 && <Pagination state={eventPaging} label="events" />}
      </div>
    </div>
  );
};
