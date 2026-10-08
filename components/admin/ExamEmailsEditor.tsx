import React, { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { Mail, Monitor, Smartphone, RotateCcw, Palette, Check, Braces } from 'lucide-react';
import type { Exam, ExamMailKind, ExamMailTemplate, ExamMailTemplateOptions } from '../../types';
import {
  buildExamEmailContent, resolveExamMailTemplate, resolveMailOptions, isEmptyMailTemplate, isValidAccentColor,
  EXAM_MAIL_PLACEHOLDERS, EXAM_MAIL_LIMITS, BRAND_ACCENT, DEFAULT_BUTTON_TEXT,
} from '../../services/examEmail';

type MailTemplates = Partial<Record<ExamMailKind, ExamMailTemplate>>;
type PreviewDevice = 'desktop' | 'phone';

// Logical viewport of each preview device. The frame is scaled down to fit narrower columns, and is
// tall enough that the whole email shows without an inner scrollbar: the OUTER box scrolls, so the
// scroll position survives the srcDoc reload on every keystroke.
const PREVIEW_SIZES: Record<PreviewDevice, { width: number; height: number }> = {
  desktop: { width: 680, height: 1600 },
  phone: { width: 375, height: 2200 },
};

/**
 * Sandboxed (sandbox="", so no scripts and no same-origin access) preview of an email's HTML with a
 * Desktop / Phone width toggle. Shared by the exam editor's Emails section and the Mail Composer.
 */
export const EmailPreviewFrame: React.FC<{
  html: string;
  title: string;
  className?: string;
  /** Classes for the scrolling viewport (e.g. "flex-1 min-h-[320px]" inside a flex column). */
  viewportClassName?: string;
  maxHeight?: number;
}> = ({ html, title, className = '', viewportClassName = '', maxHeight }) => {
  const [device, setDevice] = useState<PreviewDevice>('desktop');
  const viewportRef = useRef<HTMLDivElement>(null);
  const [available, setAvailable] = useState(0);
  // Rebuilding the iframe document on every keystroke is wasteful; let typing stay responsive.
  const deferredHtml = useDeferredValue(html);

  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const measure = () => setAvailable(el.clientWidth);
    measure();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const size = PREVIEW_SIZES[device];
  const scale = available > 0 ? Math.min(1, available / size.width) : 1;

  return (
    <div className={className}>
      <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
        <span className="text-[11px] text-slate-500">
          {device === 'desktop' ? 'Desktop' : 'Phone'} width{scale < 1 ? ` · shown at ${Math.round(scale * 100)}%` : ''}
        </span>
        <div role="group" aria-label="Preview width" className="inline-flex p-0.5 rounded-lg bg-slate-100 border border-slate-200">
          {([
            { id: 'desktop', label: 'Desktop', icon: <Monitor size={13} aria-hidden="true" /> },
            { id: 'phone', label: 'Phone', icon: <Smartphone size={13} aria-hidden="true" /> },
          ] as { id: PreviewDevice; label: string; icon: React.ReactNode }[]).map(opt => (
            <button
              key={opt.id}
              type="button"
              aria-pressed={device === opt.id}
              onClick={() => setDevice(opt.id)}
              className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-semibold transition-colors ${
                device === opt.id ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              {opt.icon} {opt.label}
            </button>
          ))}
        </div>
      </div>
      <div
        ref={viewportRef}
        className={`rounded-lg border border-slate-200 bg-slate-100 overflow-y-auto overflow-x-hidden ${viewportClassName}`}
        style={maxHeight ? { maxHeight } : undefined}
      >
        <div style={{ width: size.width * scale, height: size.height * scale, margin: '0 auto' }}>
          <iframe
            title={title}
            srcDoc={deferredHtml}
            sandbox=""
            style={{
              width: size.width,
              height: size.height,
              border: 0,
              display: 'block',
              background: '#f1f5f9',
              transform: `scale(${scale})`,
              transformOrigin: '0 0',
            }}
          />
        </div>
      </div>
    </div>
  );
};

// A few accents to pick from; "Default" (no accent) keeps the original blue email.
const ACCENT_PRESETS: { label: string; value: string }[] = [
  { label: 'Brand blue', value: BRAND_ACCENT },
  { label: 'Indigo', value: '#4f46e5' },
  { label: 'Teal', value: '#0d9488' },
  { label: 'Green', value: '#15803d' },
  { label: 'Crimson', value: '#b91c1c' },
  { label: 'Orange', value: '#c2410c' },
  { label: 'Purple', value: '#7e22ce' },
  { label: 'Slate', value: '#334155' },
];
// The original email's blue, shown in the colour input while no accent is set.
const DEFAULT_ACCENT_SWATCH = '#2563eb';

type TextField = 'subject' | 'message' | 'headerTitle' | 'buttonText' | 'closingNote';
type BlockKey = 'showSchedule' | 'showDuration' | 'showCandidate' | 'showRequirements' | 'showInstructionsPdf' | 'showProctoringNotice';

const SAMPLE_CANDIDATE = 'Alex Morgan';

/**
 * The exam editor's "Emails" section: per-exam invitation and reminder content and design, with a
 * live preview rendered by the same builder that sends. Edits go straight into the draft exam's
 * `mailTemplates` and are saved with the exam.
 */
export const ExamEmailsEditor: React.FC<{
  /** The draft exam (with its effective proctoring config) — schedule, mode and devices drive the preview. */
  exam: Partial<Exam>;
  /** Link shown in the invitation preview (a sample, never a real token). */
  sampleLink: string;
  onChange: (templates: MailTemplates) => void;
}> = ({ exam, sampleLink, onChange }) => {
  const [kind, setKind] = useState<ExamMailKind>('INVITE');
  const [accentDraft, setAccentDraft] = useState('');
  const fieldRefs = useRef<Partial<Record<TextField, HTMLInputElement | HTMLTextAreaElement | null>>>({});
  const lastFocused = useRef<TextField>('message');

  const reminder = kind === 'REMINDER';
  const templates: MailTemplates = exam.mailTemplates || {};
  const saved = templates[kind];
  const unproctored = exam.proctoringConfig?.mode === 'UNPROCTORED';
  const defaults = resolveExamMailTemplate({ ...exam, mailTemplates: {} }, reminder);
  // What the subject/message fields show: the saved text exactly as typed (the resolver trims it,
  // which would swallow a trailing space or newline mid-typing), else the default text.
  const shown = {
    subject: saved?.subject && saved.subject.trim() !== '' ? saved.subject : defaults.subject,
    message: saved?.message && saved.message.trim() !== '' ? saved.message : defaults.message,
  };
  const options: ExamMailTemplateOptions = saved?.options || {};
  const resolvedOptions = resolveMailOptions(options, unproctored);
  const accent = resolvedOptions.accentColor;

  // Keep the hex text box in step with the stored accent (preset clicks, tab switches, resets).
  useEffect(() => { setAccentDraft(accent || ''); }, [accent, kind]);

  const setTemplate = (next: ExamMailTemplate) => onChange({ ...templates, [kind]: next });
  const current = (): ExamMailTemplate => ({ subject: saved?.subject ?? '', message: saved?.message ?? '', options: { ...options } });

  // Subject / message: the field shows the text that will be used. Text equal to the default is
  // stored as "no override", so an exam that only changes colours keeps following the built-in copy
  // (e.g. it switches to the unproctored wording when the mode changes). Clearing a field restores
  // the default text.
  const setText = (field: 'subject' | 'message', value: string) => {
    const isDefault = value.trim() === defaults[field].trim();
    setTemplate({ ...current(), [field]: isDefault ? '' : value });
  };

  const setOption = <K extends keyof ExamMailTemplateOptions>(key: K, value: ExamMailTemplateOptions[K] | undefined) => {
    const next = { ...options };
    if (value === undefined || value === '') delete next[key];
    else next[key] = value;
    setTemplate({ ...current(), options: next });
  };

  // A block switched back to its default stops being an override, so it keeps following the mode.
  const setBlock = (key: BlockKey, value: boolean) => {
    const fallback = resolveMailOptions({}, unproctored)[key];
    setOption(key, value === fallback ? undefined : value);
  };

  const resetKind = () => {
    if (isEmptyMailTemplate(saved)) return;
    if (!confirm(`Reset the ${reminder ? 'reminder' : 'invitation'} email to the built-in design and text?`)) return;
    // An explicitly empty template (rather than a missing one) tells the server to clear its copy.
    setTemplate({ subject: '', message: '', options: {} });
  };

  // Placeholder chips insert at the cursor of the text field used last (the message by default).
  const insertPlaceholder = (tag: string) => {
    const field = lastFocused.current === 'buttonText' && reminder ? 'message' : lastFocused.current;
    const el = fieldRefs.current[field];
    const currentValue = field === 'subject' || field === 'message' ? shown[field] : String(options[field] ?? '');
    const start = el?.selectionStart ?? currentValue.length;
    const end = el?.selectionEnd ?? currentValue.length;
    const nextValue = currentValue.slice(0, start) + tag + currentValue.slice(end);
    if (field === 'subject' || field === 'message') setText(field, nextValue);
    else setOption(field, nextValue);
    requestAnimationFrame(() => {
      const target = fieldRefs.current[field];
      if (!target) return;
      target.focus();
      const caret = start + tag.length;
      try { target.setSelectionRange(caret, caret); } catch { /* not a text input */ }
    });
  };

  const previewExam = useMemo(() => ({
    ...exam,
    title: exam.title || 'Sample Exam',
    startTime: Number.isFinite(exam.startTime) ? exam.startTime : Date.now(),
    endTime: Number.isFinite(exam.endTime) ? exam.endTime : Date.now() + 3600000,
    durationMinutes: exam.durationMinutes || 60,
  }) as Exam, [exam]);
  const preview = useMemo(
    () => buildExamEmailContent(previewExam, SAMPLE_CANDIDATE, reminder ? '' : sampleLink, reminder),
    [previewExam, sampleLink, reminder],
  );

  const blockToggles: { key: BlockKey; label: string; hint: string }[] = [
    { key: 'showSchedule', label: 'Exam window', hint: 'Date From / To in the exam’s timezone' },
    { key: 'showDuration', label: 'Duration', hint: 'How long the exam runs' },
    { key: 'showCandidate', label: 'Candidate name', hint: 'Name tile in the details card' },
    {
      key: 'showRequirements', label: 'System requirements',
      hint: unproctored ? 'Device, browser and internet (no camera or mic — unproctored)' : 'Device, camera/mic, browser and room',
    },
    {
      key: 'showInstructionsPdf', label: 'Instructions PDF link',
      hint: unproctored ? 'Off by default: the guide covers camera/mic checks' : 'Download link to the exam guide',
    },
    unproctored
      ? { key: 'showProctoringNotice', label: '“Not proctored” note', hint: 'Tells candidates there is no monitoring' }
      : { key: 'showProctoringNotice', label: 'AI proctoring notice', hint: 'Warns that webcam, mic and screen are monitored' },
  ];

  const customised = (k: ExamMailKind) => !isEmptyMailTemplate(templates[k]);
  const labelBase = 'block text-xs font-semibold text-slate-500 uppercase tracking-wide';
  const labelCls = `${labelBase} mb-1.5`;
  const inputCls = 'w-full px-3 py-2 rounded-lg border border-slate-200 text-sm bg-white';
  const counter = (value: string, max: number) => (
    <span className={`text-[11px] ${value.length > max * 0.9 ? 'text-amber-600' : 'text-slate-400'}`}>{value.length}/{max}</span>
  );
  const placeholders = EXAM_MAIL_PLACEHOLDERS.filter(p => !(p.inviteOnly && reminder));

  return (
    <section className="lsc-panel p-4 sm:p-6 space-y-5" aria-labelledby="exam-emails-title">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h3 id="exam-emails-title" className="font-semibold text-slate-800 flex items-center gap-2">
            <Mail size={16} aria-hidden="true" /> Emails
          </h3>
          <p className="text-xs text-slate-500 mt-1">
            Customise the invitation and reminder candidates receive for this exam. Saved with the exam.
          </p>
        </div>
        <div role="tablist" aria-label="Email type" className="inline-flex self-start p-1 rounded-xl bg-slate-100 border border-slate-200">
          {(['INVITE', 'REMINDER'] as ExamMailKind[]).map(k => (
            <button
              key={k}
              type="button"
              role="tab"
              aria-selected={kind === k}
              onClick={() => setKind(k)}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                kind === k ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              {k === 'INVITE' ? 'Invitation' : 'Reminder'}
              {customised(k) && <span className="w-1.5 h-1.5 rounded-full bg-[var(--lsc-primary)]" aria-label="customised" />}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 2xl:grid-cols-2 gap-6">
        {/* Form */}
        <div className="space-y-5 min-w-0" role="tabpanel" aria-label={reminder ? 'Reminder email' : 'Invitation email'}>
          <div className="space-y-3">
            <div>
              <div className="flex items-center justify-between gap-2 mb-1.5">
                <label htmlFor="exam-mail-subject" className={labelBase}>Subject</label>
                {counter(shown.subject, EXAM_MAIL_LIMITS.subject)}
              </div>
              <input
                id="exam-mail-subject"
                ref={el => { fieldRefs.current.subject = el; }}
                type="text"
                maxLength={EXAM_MAIL_LIMITS.subject}
                className={inputCls}
                value={shown.subject}
                onFocus={() => { lastFocused.current = 'subject'; }}
                onChange={e => setText('subject', e.target.value)}
              />
            </div>
            <div>
              <div className="flex items-center justify-between gap-2 mb-1.5">
                <label htmlFor="exam-mail-message" className={labelBase}>Message</label>
                {counter(shown.message, EXAM_MAIL_LIMITS.message)}
              </div>
              <textarea
                id="exam-mail-message"
                ref={el => { fieldRefs.current.message = el; }}
                rows={7}
                maxLength={EXAM_MAIL_LIMITS.message}
                className={`${inputCls} font-mono leading-relaxed`}
                value={shown.message}
                onFocus={() => { lastFocused.current = 'message'; }}
                onChange={e => setText('message', e.target.value)}
              />
              <p className="text-[11px] text-slate-400 mt-1">
                A blank line starts a new paragraph. Clear a field to go back to the default text.
              </p>
            </div>
            <div>
              <p className="text-[11px] font-semibold text-slate-500 mb-1.5 flex items-center gap-1">
                <Braces size={12} aria-hidden="true" /> Insert placeholder
              </p>
              <div className="flex flex-wrap gap-1.5">
                {placeholders.map(p => (
                  <button
                    key={p.tag}
                    type="button"
                    // Keep the caret in the field being edited.
                    onMouseDown={e => e.preventDefault()}
                    onClick={() => insertPlaceholder(p.tag)}
                    className="px-2 py-1 bg-slate-50 hover:bg-slate-100 text-slate-600 text-[11px] font-mono rounded-md border border-slate-200 transition-colors"
                    title={`${p.label} — inserted into the field you edited last`}
                    aria-label={`Insert ${p.tag} (${p.label})`}
                  >
                    {p.tag}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="space-y-3 pt-4 border-t border-slate-100">
            <p className="text-xs font-semibold text-slate-700 flex items-center gap-1.5"><Palette size={14} aria-hidden="true" /> Design</p>
            <div className={`grid grid-cols-1 ${reminder ? '' : 'sm:grid-cols-2'} gap-3`}>
              <div>
                <label htmlFor="exam-mail-header" className={labelCls}>Header title</label>
                <input
                  id="exam-mail-header"
                  ref={el => { fieldRefs.current.headerTitle = el; }}
                  type="text"
                  maxLength={EXAM_MAIL_LIMITS.headerTitle}
                  className={inputCls}
                  placeholder={exam.title || 'Exam title'}
                  value={options.headerTitle ?? ''}
                  onFocus={() => { lastFocused.current = 'headerTitle'; }}
                  onChange={e => setOption('headerTitle', e.target.value)}
                />
              </div>
              {!reminder && (
                <div>
                  <label htmlFor="exam-mail-button" className={labelCls}>Button text</label>
                  <input
                    id="exam-mail-button"
                    ref={el => { fieldRefs.current.buttonText = el; }}
                    type="text"
                    maxLength={EXAM_MAIL_LIMITS.buttonText}
                    className={inputCls}
                    placeholder={DEFAULT_BUTTON_TEXT}
                    value={options.buttonText ?? ''}
                    onFocus={() => { lastFocused.current = 'buttonText'; }}
                    onChange={e => setOption('buttonText', e.target.value)}
                  />
                </div>
              )}
            </div>

            <div>
              <span className={labelCls} id="exam-mail-accent-label">Accent colour</span>
              <div className="flex flex-wrap items-center gap-2">
                <input
                  type="color"
                  aria-labelledby="exam-mail-accent-label"
                  value={accent || DEFAULT_ACCENT_SWATCH}
                  onChange={e => setOption('accentColor', e.target.value.toLowerCase())}
                  className="h-9 w-11 shrink-0 cursor-pointer rounded-lg border border-slate-200 bg-white p-1"
                />
                <input
                  type="text"
                  aria-label="Accent colour hex code"
                  className={`w-28 px-3 py-2 rounded-lg border text-sm font-mono ${accentDraft && !isValidAccentColor(accentDraft) ? 'border-rose-300' : 'border-slate-200'}`}
                  placeholder="Default"
                  maxLength={7}
                  value={accentDraft}
                  onChange={e => {
                    const raw = e.target.value.trim();
                    const value = raw && !raw.startsWith('#') ? `#${raw}` : raw;
                    setAccentDraft(value);
                    if (value === '') setOption('accentColor', undefined);
                    else if (isValidAccentColor(value)) setOption('accentColor', value.toLowerCase());
                  }}
                  onBlur={() => setAccentDraft(accent || '')}
                />
                {accentDraft && !isValidAccentColor(accentDraft) && (
                  <span className="text-[11px] text-rose-600">Use a 6-digit hex like {BRAND_ACCENT}</span>
                )}
              </div>
              <div className="flex flex-wrap gap-1.5 mt-2" role="group" aria-label="Accent presets">
                <button
                  type="button"
                  onClick={() => setOption('accentColor', undefined)}
                  aria-pressed={!accent}
                  className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-md border text-[11px] font-medium ${!accent ? 'border-slate-400 bg-slate-50 text-slate-800' : 'border-slate-200 text-slate-600 hover:bg-slate-50'}`}
                >
                  <span className="w-3 h-3 rounded-full" style={{ background: 'linear-gradient(135deg,#1e3a8a,#3b82f6)' }} aria-hidden="true" />
                  Default
                </button>
                {ACCENT_PRESETS.map(p => (
                  <button
                    key={p.value}
                    type="button"
                    onClick={() => setOption('accentColor', p.value)}
                    aria-pressed={accent === p.value}
                    title={`${p.label} ${p.value}`}
                    className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-md border text-[11px] font-medium ${accent === p.value ? 'border-slate-400 bg-slate-50 text-slate-800' : 'border-slate-200 text-slate-600 hover:bg-slate-50'}`}
                  >
                    <span className="w-3 h-3 rounded-full inline-flex items-center justify-center" style={{ background: p.value }} aria-hidden="true">
                      {accent === p.value && <Check size={9} className="text-white" />}
                    </span>
                    {p.label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <fieldset className="pt-4 border-t border-slate-100">
            <legend className="text-xs font-semibold text-slate-700 mb-2">Show in the email</legend>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {blockToggles.map(t => {
                const checked = resolvedOptions[t.key];
                return (
                  <label
                    key={t.key}
                    className={`flex items-start gap-2.5 rounded-lg border p-2.5 cursor-pointer transition-colors focus-within:ring-2 focus-within:ring-blue-200 ${
                      checked ? 'border-blue-200 bg-blue-50/60' : 'border-slate-200 bg-white hover:bg-slate-50'
                    }`}
                  >
                    <input
                      type="checkbox"
                      className="mt-0.5 w-4 h-4 rounded shrink-0 accent-[var(--lsc-primary)]"
                      checked={checked}
                      onChange={e => setBlock(t.key, e.target.checked)}
                    />
                    <span className="min-w-0">
                      <span className="block text-sm font-medium text-slate-800 leading-snug">{t.label}</span>
                      <span className="block text-[11px] text-slate-500 leading-snug mt-0.5">{t.hint}</span>
                    </span>
                  </label>
                );
              })}
            </div>
          </fieldset>

          <div className="pt-4 border-t border-slate-100">
            <div className="flex items-center justify-between gap-2 mb-1.5">
              <label htmlFor="exam-mail-closing" className={labelBase}>Closing note <span className="normal-case font-normal text-slate-400">(optional)</span></label>
              {counter(options.closingNote ?? '', EXAM_MAIL_LIMITS.closingNote)}
            </div>
            <textarea
              id="exam-mail-closing"
              ref={el => { fieldRefs.current.closingNote = el; }}
              rows={3}
              maxLength={EXAM_MAIL_LIMITS.closingNote}
              className={inputCls}
              placeholder="e.g. Best of luck! — The Assessment Team"
              value={options.closingNote ?? ''}
              onFocus={() => { lastFocused.current = 'closingNote'; }}
              onChange={e => setOption('closingNote', e.target.value)}
            />
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 pt-4 border-t border-slate-100">
            <span className={customised(kind) ? 'lsc-chip-primary' : 'lsc-chip-neutral'}>
              {customised(kind) ? 'Customised for this exam' : 'Built-in email'}
            </span>
            <button
              type="button"
              onClick={resetKind}
              disabled={!customised(kind)}
              className="inline-flex items-center gap-1.5 px-3 py-2 lsc-button-ghost text-xs"
            >
              <RotateCcw size={13} aria-hidden="true" /> Reset to default
            </button>
          </div>
        </div>

        {/* Live preview */}
        <div className="min-w-0 2xl:sticky 2xl:top-4 self-start w-full">
          <p className="text-xs text-slate-500 mb-2 break-words">
            Subject: <span className="font-medium text-slate-800">{preview.subject}</span>
          </p>
          <EmailPreviewFrame html={preview.body} title={`${reminder ? 'Reminder' : 'Invitation'} email preview`} maxHeight={640} />
          <p className="text-[11px] text-slate-400 mt-2">
            Sample candidate “{SAMPLE_CANDIDATE}”{reminder ? '' : ' and a sample link'} — exactly the HTML that will be sent.
          </p>
        </div>
      </div>
    </section>
  );
};
