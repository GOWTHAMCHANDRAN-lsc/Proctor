import React, { useEffect, useMemo, useState } from 'react';
import { DeliveryLog, NotificationTemplate } from '../../types';
import { apiGet, apiPost } from '../../services/api';
import { Pagination, usePagination } from './Pagination';
import { Mail, MessageSquare, RefreshCcw, Save, Trash2, Search } from 'lucide-react';

const emptyTemplate: Omit<NotificationTemplate, 'id' | 'createdAt' | 'updatedAt'> = {
  name: '',
  channel: 'EMAIL',
  subject: '',
  body: '',
  isDefault: false
};

export const Communications: React.FC = () => {
  const [templates, setTemplates] = useState<NotificationTemplate[]>([]);
  const [logs, setLogs] = useState<DeliveryLog[]>([]);
  const [loadingTemplates, setLoadingTemplates] = useState(false);
  const [loadingLogs, setLoadingLogs] = useState(false);
  const [activeTemplate, setActiveTemplate] = useState<NotificationTemplate | null>(null);
  const [draft, setDraft] = useState(emptyTemplate);
  const [search, setSearch] = useState('');

  const loadTemplates = async () => {
    setLoadingTemplates(true);
    try {
      const data = await apiGet<{ templates: NotificationTemplate[] }>('templates.php');
      setTemplates(data?.templates || []);
    } catch (e) {
      console.error('Failed to load templates:', e);
      setTemplates([]);
    } finally {
      setLoadingTemplates(false);
    }
  };

  const loadLogs = async () => {
    setLoadingLogs(true);
    try {
      const data = await apiGet<{ logs: DeliveryLog[] }>('deliveries.php?limit=200');
      setLogs(data?.logs || []);
    } catch (e) {
      console.error('Failed to load delivery logs:', e);
      setLogs([]);
    } finally {
      setLoadingLogs(false);
    }
  };

  useEffect(() => {
    loadTemplates();
    loadLogs();
  }, []);

  const resetDraft = () => {
    setActiveTemplate(null);
    setDraft(emptyTemplate);
  };

  const handleSave = async () => {
    if (!draft.name.trim() || !draft.body.trim()) return;
    await apiPost('templates.php', {
      template: {
        id: activeTemplate?.id,
        ...draft
      }
    });
    await loadTemplates();
    resetDraft();
  };

  const handleDelete = async (id: number) => {
    await apiPost('templates.php', { id, action: 'DELETE' });
    await loadTemplates();
    if (activeTemplate?.id === id) resetDraft();
  };

  const filteredLogs = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return logs;
    return logs.filter(log => {
      return [
        log.recipient,
        log.subject,
        log.status,
        log.error,
        log.channel
      ].filter(Boolean).join(' ').toLowerCase().includes(term);
    });
  }, [logs, search]);

  const logPaging = usePagination(filteredLogs, search);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h2 className="lsc-title flex items-center gap-2">
            Communications Center
          </h2>
          <p className="lsc-subtitle mt-1">Manage templates and review delivery history.</p>
        </div>
        <button
          onClick={() => {
            loadTemplates();
            loadLogs();
          }}
          className="inline-flex items-center gap-2 px-3 py-2 rounded-lg lsc-button-ghost text-sm"
        >
          <RefreshCcw size={14} /> Refresh
        </button>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-[360px_1fr] gap-6">
        <div className="lsc-panel overflow-hidden">
          <div className="p-4 lsc-panel-header">
            <div className="text-sm font-semibold text-slate-800">Template Editor</div>
          </div>
          <div className="p-4 space-y-3">
            <input
              type="text"
              className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm outline-none"
              placeholder="Template name"
              value={draft.name}
              onChange={e => setDraft({ ...draft, name: e.target.value })}
            />
            <select
              className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm outline-none bg-white"
              value={draft.channel}
              onChange={e => setDraft({ ...draft, channel: e.target.value as NotificationTemplate['channel'] })}
            >
              <option value="EMAIL">Email</option>
              <option value="SMS">SMS</option>
            </select>
            {draft.channel === 'EMAIL' && (
              <input
                type="text"
                className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm outline-none"
                placeholder="Email subject"
                value={draft.subject || ''}
                onChange={e => setDraft({ ...draft, subject: e.target.value })}
              />
            )}
            <textarea
              className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm outline-none min-h-[140px]"
              placeholder="Template body"
              value={draft.body}
              onChange={e => setDraft({ ...draft, body: e.target.value })}
            />
            <label className="flex items-center gap-2 text-xs text-slate-600">
              <input
                type="checkbox"
                checked={draft.isDefault}
                onChange={e => setDraft({ ...draft, isDefault: e.target.checked })}
              />
              Set as default for this channel
            </label>
            <div className="flex gap-2">
              <button
                onClick={handleSave}
                className="flex-1 inline-flex items-center justify-center gap-2 px-3 py-2 rounded-lg lsc-button-primary text-sm"
              >
                <Save size={14} /> Save
              </button>
              <button
                onClick={resetDraft}
                className="flex-1 inline-flex items-center justify-center gap-2 px-3 py-2 rounded-lg border border-slate-200 text-sm text-slate-600 hover:bg-slate-50"
              >
                New
              </button>
            </div>
          </div>
          <div className="border-t border-slate-200">
            <div className="p-4 text-xs text-slate-500 uppercase tracking-widest">Templates</div>
            <div className="max-h-[320px] overflow-y-auto">
              {loadingTemplates && (
                <div className="px-4 pb-4 text-xs text-slate-400">Loading templates...</div>
              )}
              {!loadingTemplates && templates.length === 0 && (
                <div className="px-4 pb-4 text-xs text-slate-400">No templates yet.</div>
              )}
              {!loadingTemplates && templates.map(template => (
                <div key={template.id} className="px-4 py-3 border-t border-slate-100 flex items-center justify-between">
                  <button
                    onClick={() => {
                      setActiveTemplate(template);
                      setDraft({
                        name: template.name,
                        channel: template.channel,
                        subject: template.subject || '',
                        body: template.body,
                        isDefault: template.isDefault
                      });
                    }}
                    className="text-left"
                  >
                    <div className="text-sm font-semibold text-slate-800 flex items-center gap-2">
                      {template.channel === 'EMAIL' ? <Mail size={14} /> : <MessageSquare size={14} />}
                      {template.name}
                    </div>
                    <div className="text-xs text-slate-400">
                      {template.channel} {template.isDefault ? '- Default' : ''}
                    </div>
                  </button>
                  <button
                    onClick={() => handleDelete(template.id)}
                    className="text-slate-400 hover:text-rose-500"
                    title="Delete template"
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="lsc-panel overflow-hidden">
          <div className="p-4 lsc-panel-header flex items-center justify-between gap-3">
            <div className="text-sm font-semibold text-slate-800">Delivery Logs</div>
            <div className="relative">
              <Search className="absolute left-3 top-2.5 text-slate-400" size={14} />
              <input
                type="text"
                placeholder="Search recipient or status..."
                className="pl-8 pr-3 py-2 border border-slate-200 rounded-lg text-xs outline-none bg-white"
                value={search}
                onChange={e => setSearch(e.target.value)}
              />
            </div>
          </div>
          {loadingLogs && (
            <div className="p-6 text-sm text-slate-400">Loading delivery logs...</div>
          )}
          {!loadingLogs && filteredLogs.length === 0 && (
            <div className="p-6 text-sm text-slate-400">No delivery logs found.</div>
          )}
          {!loadingLogs && filteredLogs.length > 0 && (
            <div className="lsc-table-wrap">
              <table className="w-full text-left text-sm">
                <thead className="bg-white border-b border-slate-200 text-xs uppercase tracking-widest text-slate-400">
                  <tr>
                    <th className="px-4 py-3">Time</th>
                    <th className="px-4 py-3">Channel</th>
                    <th className="px-4 py-3">Recipient</th>
                    <th className="px-4 py-3">Status</th>
                    <th className="px-4 py-3">Error</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {logPaging.pageItems.map(log => (
                    <tr key={log.id} className="text-slate-700 hover:bg-slate-50/70">
                      <td className="px-4 py-3 text-xs text-slate-500 whitespace-nowrap">
                        {new Date(log.createdAt).toLocaleString()}
                      </td>
                      <td className="px-4 py-3 text-xs text-slate-500">{log.channel}</td>
                      <td className="px-4 py-3 text-xs text-slate-500">{log.recipient}</td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex items-center gap-1 text-[10px] font-bold px-2 py-1 rounded-full border ${
                          log.status === 'SENT'
                            ? 'bg-teal-100 text-teal-700 border-teal-200'
                            : log.status === 'FAILED'
                              ? 'bg-rose-100 text-rose-700 border-rose-200'
                              : 'bg-amber-100 text-amber-700 border-amber-200'
                        }`}>
                          {log.status}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-xs text-rose-500 max-w-[240px] truncate" title={log.error || ''}>
                        {log.error || '-'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {!loadingLogs && filteredLogs.length > 0 && <Pagination state={logPaging} label="deliveries" />}
        </div>
      </div>
    </div>
  );
};
