import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Check, Clock, ExternalLink, Loader2, MessageSquareText, RefreshCw, RotateCcw, Send, Trash2 } from 'lucide-react';
import { apiGet, apiPost, getApiErrorMessage } from '../../services/api';
import type { WhatsAppKind, WhatsAppTemplateEditorData, WhatsAppTemplateKindState, WhatsAppTemplateVersion } from '../../types';

// Settings → WhatsApp → Message text (api/whatsapp.php ?templates=1, api/whatsapp_templates.php).
//
// WhatsApp only delivers messages built from templates Meta has approved, so "editing the message"
// means submitting a new version for review. The version in use keeps sending until the new one is
// approved, then ProctorGuard switches by itself. Text is written with readable placeholders
// ({StudentName}, {Link}, …); a message contains exactly the ones its text uses — leave {Link} and
// the button out and that message goes without a link.

const KIND_LABELS: Record<WhatsAppKind, string> = {
  INVITE: 'Invitation',
  REMINDER: 'Reminder',
  REQUEST_UPDATE: 'Request update',
};

const inputCls = 'w-full px-3 py-2 border border-slate-300 rounded-lg outline-none text-slate-800 bg-white text-sm disabled:bg-slate-50 disabled:text-slate-500';

const statusChip = (version: Pick<WhatsAppTemplateVersion, 'status'>) => {
  switch (version.status) {
    case 'ACTIVE': return <span className="lsc-chip-success">In use</span>;
    case 'PENDING': return <span className="lsc-chip-warm">Under WhatsApp review</span>;
    case 'HELD': return <span className="lsc-chip-warm">Approved as Marketing — not in use</span>;
    case 'REJECTED': return <span className="lsc-chip-danger">Rejected by WhatsApp</span>;
    default: return <span className="lsc-chip-neutral">Previous version</span>;
  }
};

/** WhatsApp's own inline formatting, for the preview bubble: *bold*, _italic_, ~strike~. */
const renderWhatsAppText = (text: string): React.ReactNode => text.split('\n').map((line, lineIdx) => {
  const parts: React.ReactNode[] = [];
  const re = /(\*[^*\n]+\*|_[^_\n]+_|~[^~\n]+~)/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(line)) !== null) {
    if (match.index > last) parts.push(line.slice(last, match.index));
    const inner = match[0].slice(1, -1);
    parts.push(match[0][0] === '*'
      ? <strong key={`${lineIdx}-${match.index}`}>{inner}</strong>
      : match[0][0] === '_'
        ? <em key={`${lineIdx}-${match.index}`}>{inner}</em>
        : <s key={`${lineIdx}-${match.index}`}>{inner}</s>);
    last = match.index + match[0].length;
  }
  if (last < line.length) parts.push(line.slice(last));
  return <React.Fragment key={lineIdx}>{parts}{'\n'}</React.Fragment>;
});

export const WhatsAppTemplateEditor: React.FC = () => {
  const [data, setData] = useState<WhatsAppTemplateEditorData | null>(null);
  const [loadError, setLoadError] = useState('');
  const [kind, setKind] = useState<WhatsAppKind>('INVITE');
  const [body, setBody] = useState('');
  const [useButton, setUseButton] = useState(false);
  const [buttonText, setButtonText] = useState('Start Exam');
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<'' | 'save' | 'refresh' | 'version'>('');
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);

  const state: WhatsAppTemplateKindState | null = data?.kinds.find(k => k.kind === kind) || null;
  const editable = !!data?.editable;
  const pending = state?.versions.find(v => v.status === 'PENDING') || null;

  // Start the editor from what is in use for this kind (unless the admin is mid-edit).
  const loadDraft = useCallback((source: { body: string | null; buttonText: string | null } | null) => {
    setBody(source?.body || '');
    setUseButton(!!source?.buttonText);
    setButtonText(source?.buttonText || 'Start Exam');
    setDirty(false);
  }, []);

  const applyData = useCallback((next: WhatsAppTemplateEditorData, resetDraft: boolean) => {
    setData(next);
    if (resetDraft) {
      const k = next.kinds.find(x => x.kind === kind);
      loadDraft(k?.active ? { body: k.active.body, buttonText: k.active.buttonText } : null);
    }
  }, [kind, loadDraft]);

  const load = useCallback(async (refresh: boolean, resetDraft: boolean) => {
    const next = await apiGet<WhatsAppTemplateEditorData>(`whatsapp.php?templates=1${refresh ? '&refresh=1' : ''}`);
    applyData(next, resetDraft);
  }, [applyData]);

  useEffect(() => {
    let cancelled = false;
    apiGet<WhatsAppTemplateEditorData>('whatsapp.php?templates=1')
      .then(next => {
        if (cancelled) return;
        setData(next);
        const k = next.kinds.find(x => x.kind === 'INVITE');
        loadDraft(k?.active ? { body: k.active.body, buttonText: k.active.buttonText } : null);
      })
      .catch(e => { if (!cancelled) setLoadError(getApiErrorMessage(e, 'Could not load the WhatsApp message text.')); });
    return () => { cancelled = true; };
  }, [loadDraft]);

  // While a version is under review, ask WhatsApp for the result every 20 seconds.
  useEffect(() => {
    if (!data || !data.kinds.some(k => k.versions.some(v => v.status === 'PENDING'))) return;
    const id = window.setInterval(() => { void load(true, false).catch(() => {}); }, 20000);
    return () => window.clearInterval(id);
  }, [data, load]);

  const switchKind = (next: WhatsAppKind) => {
    if (next === kind) return;
    if (dirty && !window.confirm('Discard your unsaved changes to this message?')) return;
    setKind(next);
    setNotice(null);
    const k = data?.kinds.find(x => x.kind === next);
    loadDraft(k?.active ? { body: k.active.body, buttonText: k.active.buttonText } : null);
  };

  const insertPlaceholder = (key: string) => {
    const el = textRef.current;
    const token = `{${key}}`;
    if (!el) {
      setBody(prev => prev + token);
    } else {
      const start = el.selectionStart ?? body.length;
      const end = el.selectionEnd ?? body.length;
      setBody(body.slice(0, start) + token + body.slice(end));
      window.requestAnimationFrame(() => {
        el.focus();
        el.setSelectionRange(start + token.length, start + token.length);
      });
    }
    setDirty(true);
  };

  // Placeholders used / unknown, and the length WhatsApp will count ({Name} becomes {{1}}).
  const analysis = useMemo(() => {
    const known = new Map((state?.fields || []).map(f => [f.key.toLowerCase(), f]));
    const used: string[] = [];
    const unknown: string[] = [];
    const compiled = body.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g, (whole, name: string) => {
      const field = known.get(name.toLowerCase());
      if (!field) {
        if (!unknown.includes(name)) unknown.push(name);
        return whole;
      }
      if (!used.includes(field.key)) used.push(field.key);
      return `{{${used.indexOf(field.key) + 1}}}`;
    });
    const preview = body.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g, (whole, name: string) => known.get(name.toLowerCase())?.sample ?? whole);
    return { used, unknown, length: compiled.trim().length, preview };
  }, [body, state]);

  const hasLink = analysis.used.includes('Link');
  const problems: string[] = [];
  if (body.trim() === '') problems.push('Write the message text.');
  if (analysis.unknown.length > 0) problems.push(`Unknown placeholder${analysis.unknown.length === 1 ? '' : 's'}: ${analysis.unknown.map(u => `{${u}}`).join(', ')}.`);
  if (data && analysis.length > data.limits.body) problems.push(`The message is ${analysis.length} characters; WhatsApp allows at most ${data.limits.body}.`);
  if (kind === 'INVITE' && !hasLink && !useButton) problems.push('An invitation must give the candidate their exam link: keep {Link} in the text or switch the link button on.');
  if (useButton && buttonText.trim() === '') problems.push('Give the button a label.');

  const submit = async () => {
    if (!state || busy || problems.length > 0) return;
    if (!window.confirm(`Submit this ${KIND_LABELS[kind].toLowerCase()} text to WhatsApp for approval?\n\nThe current message keeps sending until WhatsApp approves the new one (usually minutes, sometimes up to a day). ProctorGuard then switches to it automatically.`)) return;
    setBusy('save');
    setNotice(null);
    try {
      const res = await apiPost<{ ok: boolean; state: WhatsAppTemplateKindState; version: WhatsAppTemplateVersion }>('whatsapp.php', {
        action: 'TEMPLATE_SAVE',
        kind,
        body,
        buttonText: state.supportsButton && useButton ? buttonText.trim() : null,
      });
      setData(prev => (prev ? { ...prev, kinds: prev.kinds.map(k => (k.kind === kind ? res.state : k)) } : prev));
      setDirty(false);
      setNotice(res.version.status === 'ACTIVE'
        ? { tone: 'ok', text: 'WhatsApp approved it straight away — new messages use this text now.' }
        : { tone: 'ok', text: 'Submitted. WhatsApp is reviewing it; the current message keeps sending until it is approved.' });
    } catch (e) {
      setNotice({ tone: 'error', text: getApiErrorMessage(e, 'Could not submit the message text.') });
    } finally {
      setBusy('');
    }
  };

  const versionAction = async (action: 'TEMPLATE_ACTIVATE' | 'TEMPLATE_DELETE', version: WhatsAppTemplateVersion) => {
    if (busy) return;
    const question = action === 'TEMPLATE_DELETE'
      ? `Remove the version "${version.name}"? It is also deleted from WhatsApp Manager.`
      : version.status === 'HELD'
        ? 'WhatsApp put this version in the Marketing category. Marketing messages are limited per person, so some students may not receive them. Use it anyway?'
        : 'Switch back to this version? New messages will use it straight away.';
    if (!window.confirm(question)) return;
    setBusy('version');
    setNotice(null);
    try {
      const res = await apiPost<{ ok: boolean; state: WhatsAppTemplateKindState }>('whatsapp.php', { action, id: version.id });
      setData(prev => (prev ? { ...prev, kinds: prev.kinds.map(k => (k.kind === version.kind ? res.state : k)) } : prev));
      if (action === 'TEMPLATE_ACTIVATE' && !dirty) loadDraft(res.state.active ? { body: res.state.active.body, buttonText: res.state.active.buttonText } : null);
    } catch (e) {
      setNotice({ tone: 'error', text: getApiErrorMessage(e, 'Could not update the version.') });
    } finally {
      setBusy('');
    }
  };

  const refresh = async () => {
    if (busy) return;
    setBusy('refresh');
    try {
      await load(true, !dirty);
    } catch (e) {
      setNotice({ tone: 'error', text: getApiErrorMessage(e, 'Could not check with WhatsApp.') });
    } finally {
      setBusy('');
    }
  };

  // Nothing to edit until WhatsApp is set up with Meta (the status card above explains that).
  if (loadError || !data || !state || !data.kinds.some(k => k.active)) return null;

  return (
    <div className="lsc-panel p-5 sm:p-6 space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <div className="lsc-icon-tile-primary p-2.5 shrink-0"><MessageSquareText size={18} /></div>
          <div className="min-w-0">
            <h3 className="text-base font-semibold text-slate-900">WhatsApp message text</h3>
            <p className="text-sm text-slate-500">What students and employees read on WhatsApp. Every change is reviewed by WhatsApp before it is used.</p>
          </div>
        </div>
        <button type="button" onClick={() => { void refresh(); }} disabled={!!busy} className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-slate-200 text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-60">
          {busy === 'refresh' ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />} Check with WhatsApp
        </button>
      </div>

      <div className="inline-flex rounded-lg border border-slate-200 bg-slate-50 p-0.5" role="tablist" aria-label="Message type">
        {data.kinds.map(k => (
          <button
            key={k.kind}
            type="button"
            role="tab"
            aria-selected={k.kind === kind}
            onClick={() => switchKind(k.kind)}
            className={`px-3 py-1.5 rounded-md text-xs font-medium ${k.kind === kind ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
          >
            {KIND_LABELS[k.kind]}
            {k.versions.some(v => v.status === 'PENDING') && <Clock size={11} className="inline ml-1 -mt-0.5 text-amber-500" aria-label="Under review" />}
          </button>
        ))}
      </div>

      {!state.active ? (
        <p className="text-sm text-slate-500">No WhatsApp template is set for this message yet.</p>
      ) : (
        <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
          <span>In use now:</span>
          <code className="text-slate-700">{state.active.name}</code>
          {state.active.status && (
            <span className={state.active.status === 'APPROVED' && state.active.problems.length === 0 ? 'lsc-chip-success' : 'lsc-chip-danger'}>
              {state.active.status === 'APPROVED' ? (state.active.problems.length === 0 ? 'Approved' : 'Needs attention') : state.active.status.replace(/_/g, ' ')}
            </span>
          )}
          {state.active.category && <span className={state.active.category === 'MARKETING' ? 'lsc-chip-warm' : 'lsc-chip-neutral'}>{state.active.category.charAt(0) + state.active.category.slice(1).toLowerCase()}</span>}
          {state.active.problems.map(problem => <p key={problem} role="alert" className="w-full text-rose-600">{problem}</p>)}
        </div>
      )}

      {pending && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs text-amber-900">
          <Clock size={14} className="mt-0.5 shrink-0" />
          <span>
            A new version is with WhatsApp for review. The message above keeps sending until it is approved; this page checks every 20 seconds.
            You can submit another change once WhatsApp has answered.
          </span>
        </div>
      )}

      <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_340px] gap-5">
        <div className="space-y-3 min-w-0">
          <div>
            <label htmlFor="wa-template-body" className="block text-xs font-medium text-slate-600 mb-1">Text</label>
            <textarea
              id="wa-template-body"
              ref={textRef}
              className={`${inputCls} min-h-[260px] font-mono leading-relaxed`}
              value={body}
              disabled={!editable}
              onChange={e => { setBody(e.target.value); setDirty(true); }}
              spellCheck
            />
            <div className="mt-1 flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-400">
              <span>*bold*  _italic_  ~strikethrough~ — as in WhatsApp</span>
              <span className={analysis.length > data.limits.body ? 'text-rose-600 font-medium' : ''}>{analysis.length} / {data.limits.body}</span>
            </div>
          </div>

          <div>
            <div className="text-xs font-medium text-slate-600 mb-1.5">Placeholders <span className="font-normal text-slate-400">— click to insert; each is replaced with the real value when the message is sent</span></div>
            <div className="flex flex-wrap gap-1.5">
              {state.fields.map(field => {
                const used = analysis.used.includes(field.key);
                return (
                  <button
                    key={field.key}
                    type="button"
                    disabled={!editable}
                    onClick={() => insertPlaceholder(field.key)}
                    title={`${field.label} — e.g. ${field.sample}`}
                    className={`inline-flex items-center gap-1 px-2 py-1 rounded-md border text-xs disabled:opacity-60 ${used ? 'border-teal-200 bg-teal-50 text-teal-800' : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'}`}
                  >
                    {used && <Check size={11} />}
                    <code>{`{${field.key}}`}</code>
                    <span className="text-slate-400">{field.label}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {state.supportsButton && (
            <div className="rounded-lg border border-slate-200 px-3 py-2.5 space-y-2">
              <label className="flex items-start gap-2 text-sm text-slate-700 cursor-pointer select-none">
                <input type="checkbox" className="mt-0.5" checked={useButton} disabled={!editable} onChange={e => { setUseButton(e.target.checked); setDirty(true); }} />
                <span>
                  Add a button that opens the candidate’s exam link
                  <span className="block text-xs text-slate-400">Shown under the message. Leave it off (and leave {'{Link}'} out of the text) to send this message without any link.</span>
                </span>
              </label>
              {useButton && (
                <input
                  className={inputCls}
                  value={buttonText}
                  maxLength={data.limits.button}
                  disabled={!editable}
                  onChange={e => { setButtonText(e.target.value); setDirty(true); }}
                  aria-label="Button label"
                  placeholder="Start Exam"
                />
              )}
            </div>
          )}

          {editable && problems.length > 0 && (
            <ul className="text-xs text-rose-600 list-disc list-inside space-y-0.5">
              {problems.map(problem => <li key={problem}>{problem}</li>)}
            </ul>
          )}
          {notice && (
            <p role={notice.tone === 'error' ? 'alert' : 'status'} className={`text-xs ${notice.tone === 'error' ? 'text-rose-600' : 'text-teal-700'}`}>{notice.text}</p>
          )}

          {editable ? (
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => { void submit(); }}
                disabled={!!busy || !dirty || problems.length > 0 || !!pending}
                title={pending ? 'A version is already under review' : !dirty ? 'Change the text first' : undefined}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
              >
                {busy === 'save' ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />} Submit to WhatsApp for approval
              </button>
              {dirty && (
                <button type="button" onClick={() => loadDraft(state.active ? { body: state.active.body, buttonText: state.active.buttonText } : null)} disabled={!!busy} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-slate-200 text-sm text-slate-600 hover:bg-slate-50 disabled:opacity-60">
                  <RotateCcw size={13} /> Undo changes
                </button>
              )}
            </div>
          ) : (
            <p className="text-xs text-slate-500">Only a super admin can change the message text (it is shared by every company).</p>
          )}
        </div>

        <div className="min-w-0">
          <div className="text-xs font-medium text-slate-600 mb-1">Preview <span className="font-normal text-slate-400">with sample values</span></div>
          <div className="rounded-xl bg-[#e7ddd3] p-3">
            <div className="rounded-lg bg-white shadow-sm overflow-hidden max-w-[300px]">
              <div className="px-3 py-2 text-[13px] leading-snug text-slate-800 whitespace-pre-wrap break-words">
                {analysis.preview.trim() === '' ? <span className="text-slate-400">Your message appears here.</span> : renderWhatsAppText(analysis.preview.trim())}
              </div>
              {state.supportsButton && useButton && (
                <div className="border-t border-slate-100 px-3 py-2 text-center text-[13px] font-medium text-sky-600 flex items-center justify-center gap-1.5">
                  <ExternalLink size={13} /> {buttonText.trim() || 'Start Exam'}
                </div>
              )}
            </div>
          </div>
          <p className="mt-2 text-[11px] text-slate-400 flex items-start gap-1">
            <AlertTriangle size={11} className="mt-0.5 shrink-0" />
            Keep the wording factual (schedule, instructions). If it reads like promotion WhatsApp files it under Marketing, which is not delivered reliably — such a version is held for you to decide.
          </p>
        </div>
      </div>

      {state.versions.length > 0 && (
        <div className="rounded-lg border border-slate-200 overflow-hidden">
          <div className="px-3 py-2 bg-slate-50 border-b border-slate-200 text-[13px] font-medium text-slate-700">Versions made here</div>
          <ul className="divide-y divide-slate-100">
            {state.versions.map(version => (
              <li key={version.id} className="px-3 py-2.5 text-sm space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  {statusChip(version)}
                  <span className="text-xs text-slate-400">
                    {version.createdAt ? new Date(version.createdAt).toLocaleString() : ''}{version.createdBy ? ` · ${version.createdBy}` : ''}
                    {version.buttonText ? ` · button “${version.buttonText}”` : ' · no button'}
                    {version.fields.includes('Link') ? '' : ' · no link in text'}
                  </span>
                  <span className="ml-auto flex items-center gap-1.5">
                    <button type="button" onClick={() => { loadDraft({ body: version.body, buttonText: version.buttonText }); setDirty(true); }} disabled={!editable || !!busy} className="px-2 py-1 rounded-md border border-slate-200 text-xs text-slate-600 hover:bg-slate-50 disabled:opacity-50">Edit from this</button>
                    {editable && (version.status === 'HELD' || version.status === 'RETIRED') && (
                      <button type="button" onClick={() => { void versionAction('TEMPLATE_ACTIVATE', version); }} disabled={!!busy} className="px-2 py-1 rounded-md border border-slate-200 text-xs text-slate-600 hover:bg-slate-50 disabled:opacity-50">Use this</button>
                    )}
                    {editable && version.status !== 'ACTIVE' && (
                      <button type="button" onClick={() => { void versionAction('TEMPLATE_DELETE', version); }} disabled={!!busy} aria-label={`Remove version ${version.name}`} className="p-1 rounded-md border border-slate-200 text-slate-500 hover:bg-rose-50 hover:text-rose-600 disabled:opacity-50"><Trash2 size={13} /></button>
                    )}
                  </span>
                </div>
                {version.status === 'REJECTED' && version.rejectedReason && <p className="text-xs text-rose-600">WhatsApp’s reason: {version.rejectedReason.replace(/_/g, ' ').toLowerCase()}</p>}
                <p className="text-xs text-slate-500 whitespace-pre-wrap line-clamp-3">{version.body}</p>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
};
