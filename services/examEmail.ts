// Exam invitation / reminder email: the single source of truth for both what the admin previews and
// what actually sends. Used by the exam editor's "Emails" section, the Mail Composer and
// ExamManager's dispatchEmails. api/exam_mail_render.php is a byte-for-byte PHP port of this file —
// change both together (scratchpad parity test: same HTML for the same input).
//
// The HTML is deliberately inline-hex email markup (mail clients ignore stylesheets and CSS
// variables), so it is never tokenised.

import type { Exam, ExamMailKind, ExamMailTemplate, ExamMailTemplateOptions } from '../types';
import { resolveExamTimezone, formatScheduleLabel, formatDateInZone, formatTimeInZone } from './timezone';

// Render an exam duration in minutes as a human-friendly string, e.g. "1 hr 30 min".
export const formatDuration = (mins: number): string => {
  const total = Math.max(0, Math.round(Number(mins) || 0));
  if (total === 0) return 'Not specified';
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m} min`;
  if (m === 0) return `${h} hr`;
  return `${h} hr ${m} min`;
};

// Built-in copy for each mail kind. These are only the DEFAULTS — an admin can override the subject
// and message per exam (exam editor "Emails" section / Mail Composer, persisted as exam.mailTemplates),
// and the invitation additionally honours the older notificationConfig.customSubject/customMessage.
export const DEFAULT_INVITE_MESSAGE =
  'Dear {StudentName},\n\n'
  + 'You have been invited to appear for a proctored online examination. Please review the details '
  + 'below and click the button to begin when you are ready.';

export const DEFAULT_REMINDER_MESSAGE =
  'Dear {StudentName},\n\n'
  + 'This is a friendly reminder about your proctored online examination "{ExamTitle}". Our records '
  + 'show that you have not completed it yet. Please review the details below and make sure you are '
  + 'prepared before the assessment window closes.\n\n'
  + 'Your secure exam link was shared in your invitation email. Kindly ignore this message if you '
  + 'have already taken the assessment.';

export const DEFAULT_INVITE_SUBJECT = 'Your Exam Invitation — {ExamTitle}';
export const DEFAULT_REMINDER_SUBJECT = 'Reminder — {ExamTitle}';
/** Shown as the button-text placeholder; the default button renders as "Open Exam Portal &rarr;". */
export const DEFAULT_BUTTON_TEXT = 'Open Exam Portal →';
/** The brand blue suggested in the accent picker. No accent at all keeps the original blue palette. */
export const BRAND_ACCENT = '#1a73e8';

/** Placeholders substituted in the subject, message, header title, button text and closing note. */
export const EXAM_MAIL_PLACEHOLDERS: { tag: string; label: string; inviteOnly?: boolean }[] = [
  { tag: '{StudentName}', label: 'Candidate name' },
  { tag: '{ExamTitle}', label: 'Exam title' },
  { tag: '{StartTime}', label: 'Opens at' },
  { tag: '{EndTime}', label: 'Closes at' },
  { tag: '{Duration}', label: 'Duration' },
  { tag: '{Link}', label: 'Exam link', inviteOnly: true },
];

/** Length caps, mirrored by the server (api/exam_mail_render.php exam_mail_normalize_options). */
export const EXAM_MAIL_LIMITS = {
  subject: 255,
  message: 20000,
  headerTitle: 120,
  buttonText: 60,
  closingNote: 1000,
} as const;

const ACCENT_RE = /^#[0-9a-fA-F]{6}$/;
const OPTION_TEXT_KEYS = ['headerTitle', 'buttonText', 'closingNote'] as const;
const OPTION_BOOL_KEYS = [
  'showSchedule', 'showDuration', 'showCandidate', 'showRequirements', 'showInstructionsPdf', 'showProctoringNotice',
] as const;

/** True when a colour is a 6-digit hex like #1a73e8 (the only accent format the server accepts). */
export const isValidAccentColor = (value: unknown): value is string => typeof value === 'string' && ACCENT_RE.test(value);

/**
 * Client-side twin of the server's option validation: strings trimmed and capped (empty → dropped),
 * accent kept only when it is a 6-digit hex (lower-cased), booleans kept only when boolean, unknown
 * keys dropped.
 */
export const normalizeMailOptions = (raw: unknown): ExamMailTemplateOptions => {
  const out: ExamMailTemplateOptions = {};
  if (!raw || typeof raw !== 'object') return out;
  const src = raw as Record<string, unknown>;
  for (const key of OPTION_TEXT_KEYS) {
    const value = src[key];
    if (typeof value === 'string' && value.trim() !== '') out[key] = value.trim().slice(0, EXAM_MAIL_LIMITS[key]);
  }
  if (isValidAccentColor(src.accentColor)) out.accentColor = src.accentColor.toLowerCase();
  for (const key of OPTION_BOOL_KEYS) {
    if (typeof src[key] === 'boolean') out[key] = src[key] as boolean;
  }
  return out;
};

/** A template with no subject, no message and no options means "use the built-in email". */
export const isEmptyMailTemplate = (tpl?: Partial<ExamMailTemplate> | null): boolean =>
  !tpl || ((tpl.subject ?? '').trim() === '' && (tpl.message ?? '').trim() === ''
    && Object.keys(normalizeMailOptions(tpl.options)).length === 0);

// An unproctored exam has no camera, microphone or screen monitoring, so its built-in copy must not
// call it "proctored".
const isUnproctoredExam = (exam: Partial<Exam>) => exam.proctoringConfig?.mode === 'UNPROCTORED';
const unproctoredCopy = (text: string) => text.replace(/proctored online examination/g, 'online examination');

// Resolve the subject/message actually used for one exam + mail kind, in priority order:
// per-exam override (exam editor / Mail Composer) → legacy notificationConfig (invitations only) →
// built-in default. Placeholders are left unsubstituted so editors can show the template text.
// `options` is the saved per-exam design (header, colour, blocks), if any.
export const resolveExamMailTemplate = (exam: Partial<Exam>, reminder: boolean): ExamMailTemplate => {
  const saved = exam.mailTemplates?.[reminder ? 'REMINDER' : 'INVITE'];
  const unproctored = isUnproctoredExam(exam);
  const options = saved?.options;
  if (reminder) {
    return {
      subject: saved?.subject?.trim() || DEFAULT_REMINDER_SUBJECT,
      message: saved?.message?.trim() || (unproctored ? unproctoredCopy(DEFAULT_REMINDER_MESSAGE) : DEFAULT_REMINDER_MESSAGE),
      options,
    };
  }
  return {
    subject: saved?.subject?.trim() || exam.notificationConfig?.customSubject?.trim() || DEFAULT_INVITE_SUBJECT,
    message: saved?.message?.trim() || exam.notificationConfig?.customMessage?.trim()
      || (unproctored ? unproctoredCopy(DEFAULT_INVITE_MESSAGE) : DEFAULT_INVITE_MESSAGE),
    options,
  };
};

/** The block switches and texts an email is built with, after applying each one's default. */
export interface ResolvedMailOptions {
  headerTitle: string;   // '' → the exam title
  buttonText: string;    // '' → "Open Exam Portal →"
  accentColor: string | null; // null → the original blue palette
  closingNote: string;   // '' → no closing note
  showSchedule: boolean;
  showDuration: boolean;
  showCandidate: boolean;
  showRequirements: boolean;
  showInstructionsPdf: boolean;
  showProctoringNotice: boolean;
}

// Defaults reproduce the original email exactly. The only per-mode default: the instructions PDF is
// off for an unproctored exam (the guide is about camera/mic/screen permissions), though an admin
// may switch it back on. The requirements and notice blocks adapt their own copy to the mode, so an
// unproctored email never mentions a camera, a microphone or AI monitoring whatever is switched on.
export const resolveMailOptions = (options: ExamMailTemplateOptions | undefined | null, unproctored: boolean): ResolvedMailOptions => {
  const o = options || {};
  const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
  const flag = (value: unknown, fallback: boolean) => (typeof value === 'boolean' ? value : fallback);
  return {
    headerTitle: text(o.headerTitle),
    buttonText: text(o.buttonText),
    accentColor: isValidAccentColor(o.accentColor) ? o.accentColor.toLowerCase() : null,
    closingNote: text(o.closingNote),
    showSchedule: flag(o.showSchedule, true),
    showDuration: flag(o.showDuration, true),
    showCandidate: flag(o.showCandidate, true),
    showRequirements: flag(o.showRequirements, true),
    showInstructionsPdf: flag(o.showInstructionsPdf, !unproctored),
    showProctoringNotice: flag(o.showProctoringNotice, true),
  };
};

// --- Accent palette ---------------------------------------------------------------------------
// Every colour the accent touches. With no accent the values are the original email's literals, so
// the default output is unchanged byte for byte.
interface MailPalette {
  headerBg: string;
  headerEyebrow: string;
  headerSub: string;
  ctaBg: string;
  ctaText: string;
  ctaShadow: string;
  link: string;
  bandBg: string;
  bandBorder: string;
  bandHeading: string;
  pdfBg: string;
  pdfText: string;
  pdfBorder: string;
}

const DEFAULT_PALETTE: MailPalette = {
  headerBg: 'linear-gradient(135deg,#1e3a8a 0%,#2563eb 60%,#3b82f6 100%)',
  headerEyebrow: '#bfdbfe',
  headerSub: '#93c5fd',
  ctaBg: 'linear-gradient(135deg,#1d4ed8,#2563eb)',
  ctaText: '#ffffff',
  ctaShadow: 'rgba(37,99,235,0.4)',
  link: '#2563eb',
  bandBg: '#eff6ff',
  bandBorder: '#dbeafe',
  bandHeading: '#1d4ed8',
  pdfBg: '#eff6ff',
  pdfText: '#1d4ed8',
  pdfBorder: '#bfdbfe',
};

type Rgb = [number, number, number];
const hexToRgb = (hex: string): Rgb => [
  parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16),
];
const rgbToHex = (c: Rgb) => `#${c.map(v => v.toString(16).padStart(2, '0')).join('')}`;
// Move each channel `t` of the way toward `target` (0 = black, 255 = white).
const mixRgb = (c: Rgb, target: number, t: number): Rgb => [
  Math.round(c[0] + (target - c[0]) * t),
  Math.round(c[1] + (target - c[1]) * t),
  Math.round(c[2] + (target - c[2]) * t),
];
const channelLum = (v: number) => {
  const s = v / 255;
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
};
const luminance = (c: Rgb) => 0.2126 * channelLum(c[0]) + 0.7152 * channelLum(c[1]) + 0.0722 * channelLum(c[2]);
const contrastWithWhite = (c: Rgb) => 1.05 / (luminance(c) + 0.05);
// Darken in 10% steps until white text on it (or it as text on white) reaches `min` contrast.
const darkenForContrast = (c: Rgb, min: number): Rgb => {
  for (let i = 0; i <= 9; i++) {
    const candidate = i === 0 ? c : mixRgb(c, 0, i / 10);
    if (contrastWithWhite(candidate) >= min) return candidate;
  }
  return mixRgb(c, 0, 0.9);
};

const buildMailPalette = (accent: string | null): MailPalette => {
  if (!accent) return DEFAULT_PALETTE;
  const base = hexToRgb(accent);
  // Header band: keep white headline text legible however light the chosen colour is.
  const mid = darkenForContrast(base, 3);
  const link = darkenForContrast(base, 4.5);
  const strong = darkenForContrast(mixRgb(base, 0, 0.12), 4.5);
  return {
    headerBg: `linear-gradient(135deg,${rgbToHex(mixRgb(mid, 0, 0.4))} 0%,${rgbToHex(mid)} 60%,${rgbToHex(mixRgb(mid, 255, 0.2))} 100%)`,
    headerEyebrow: rgbToHex(mixRgb(mid, 255, 0.75)),
    headerSub: rgbToHex(mixRgb(mid, 255, 0.55)),
    ctaBg: `linear-gradient(135deg,${rgbToHex(mixRgb(base, 0, 0.12))},${rgbToHex(base)})`,
    ctaText: contrastWithWhite(base) >= 3 ? '#ffffff' : '#0f172a',
    ctaShadow: `rgba(${base[0]},${base[1]},${base[2]},0.4)`,
    link: rgbToHex(link),
    bandBg: rgbToHex(mixRgb(base, 255, 0.93)),
    bandBorder: rgbToHex(mixRgb(base, 255, 0.82)),
    bandHeading: rgbToHex(strong),
    pdfBg: rgbToHex(mixRgb(base, 255, 0.93)),
    pdfText: rgbToHex(strong),
    pdfBorder: rgbToHex(mixRgb(base, 255, 0.7)),
  };
};

// Student names (CSV / LMS webhook imports), exam titles and the admin's header/button/closing texts
// are plain text; escape them wherever they land in the email HTML so a name like "<b>Ana</b>" or
// "R&D" can't inject markup or break the layout. The admin-authored message template itself is left
// as-is (saved templates may carry HTML).
const escapeEmailHtml = (value: string) => value
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

// One pass over every placeholder, so a value that itself contains "{Link}" is never re-expanded.
const PLACEHOLDER_RE = /\{(StudentName|ExamTitle|StartTime|EndTime|Duration|Link)\}/g;

// The instructions PDF is served from the app's own public root.
const appOrigin = () => (typeof window !== 'undefined' && window.location ? window.location.origin : '');

// Builds the exact invitation/reminder email HTML sent by dispatchEmails. Also used by the live
// previews (exam editor "Emails" section, Email Notifications preview, Mail Composer), so what admins
// see is exactly what sends. `override` lets the composer preview unsaved subject/message edits
// without persisting them; the design options always come from the exam's saved template.
export const buildExamEmailContent = (
  exam: Exam,
  recipientName: string,
  link: string,
  reminder: boolean,
  override?: { subject?: string; message?: string },
): { subject: string; body: string } => {
  // Exam instructions are LINKED, not attached: a 700 KB PDF on every message made large
  // batches slow and risked Gmail size/rate limits. The file is served from the app's public
  // root, so candidates download it on demand from a tiny link instead.
  const instructionsUrl = `${appOrigin()}/ProctorGuard_Exam_Instructions_updated.pdf`;

  // Every date/time in the email is rendered in the exam's own timezone so the
  // student sees the same schedule the admin set, regardless of local clocks.
  const examTz = resolveExamTimezone(exam.timezone);
  // Use the exam's actual time limit, not the availability window (endTime - startTime).
  const durationMin = exam.durationMinutes;
  const durationLabel = formatDuration(durationMin);
  const dateStr = formatDateInZone(exam.startTime, examTz);
  const timeStr = formatTimeInZone(exam.startTime, examTz);

  // Availability window (portal open → close) for the reminder email,
  // rendered as an explicit "From → To" range in the exam's timezone.
  const winOpenLabel = formatScheduleLabel(exam.startTime, examTz);
  const winCloseLabel = formatScheduleLabel(exam.endTime, examTz);

  const startLabel = `${dateStr} at ${timeStr}`;
  const endLabel = `${formatDateInZone(exam.endTime, examTz)} at ${formatTimeInZone(exam.endTime, examTz)}`;
  const safeName = escapeEmailHtml(recipientName);
  const safeTitle = escapeEmailHtml(exam.title);
  const safeLink = escapeEmailHtml(link);
  // Function replacer: a plain replacement string would expand "$&" / "$1" sequences that can
  // legitimately appear in a title or name. `html` escapes the substituted values for the body.
  const fillTemplate = (tpl: string, html = false) => tpl.replace(PLACEHOLDER_RE, (_match, key: string) => {
    switch (key) {
      case 'StudentName': return html ? safeName : recipientName;
      case 'ExamTitle': return html ? safeTitle : exam.title;
      case 'StartTime': return startLabel;
      case 'EndTime': return endLabel;
      case 'Duration': return durationLabel;
      default: return html ? safeLink : link;
    }
  });
  // Admin-authored plain text (header title, button text, closing note): escaped, then filled.
  const fillText = (text: string) => fillTemplate(escapeEmailHtml(text), true);

  // Composer edits (override) win over the saved per-exam template, which wins over the default.
  const resolved = resolveExamMailTemplate(exam, reminder);
  const subjectTpl = override?.subject?.trim() || resolved.subject;
  const messageTpl = override?.message !== undefined ? override.message : resolved.message;
  const subject = fillTemplate(subjectTpl);
  // In the HTML body the candidate's name is emphasised, matching how the salutation has always
  // rendered. The subject stays plain text.
  const message = recipientName.trim() === ''
    ? fillTemplate(messageTpl, true)
    : fillTemplate(messageTpl, true).split(safeName).join(`<strong>${safeName}</strong>`);

  // The requirements and the monitoring notice follow the exam's own proctoring settings: an
  // UNPROCTORED exam needs no camera or microphone (and has no monitoring at all), and a proctored
  // exam only asks for the hardware it actually requires. A config-less exam keeps the classic copy.
  const proctoring = exam.proctoringConfig;
  const unproctored = proctoring?.mode === 'UNPROCTORED';
  const opts = resolveMailOptions(resolved.options, unproctored);
  const pal = buildMailPalette(opts.accentColor);

  // The message carries its own greeting ("Dear {StudentName},"), so it is rendered on its own —
  // no separate intro block, which is what used to produce the doubled greeting. The first
  // paragraph is styled as the salutation and the rest as body copy.
  const messageParas = message.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
  const greetingBlock = messageParas.length === 0
    ? ''
    : messageParas.map((para, i) => i === 0
        ? `<p style="margin:0;font-size:16px;color:#1e293b;line-height:1.6;">${para.replace(/\n/g, '<br/>')}</p>`
        : `<p style="margin:12px 0 0;font-size:14px;color:#475569;line-height:1.7;">${para.replace(/\n/g, '<br/>')}</p>`
      ).join('\n  ');

  // Both invitations and reminders show the availability window (when the exam
  // portal is open) as an explicit "Date From → To" range, plus the duration it
  // runs for — instead of a single fixed start date/time. Each block can be switched off; the
  // last row of the card never carries a bottom border.
  const metaCells: [string, string][] = [];
  if (opts.showDuration) metaCells.push(['Duration', durationLabel]);
  if (opts.showCandidate) metaCells.push(['Candidate', safeName]);
  const rowBorder = (last: boolean) => (last ? '' : 'border-bottom:1px solid #e2e8f0;');
  const scheduleRow = (label: string, value: string, last: boolean) => `
    <tr>
      <td class="lsc-pad" style="padding:16px 24px;${rowBorder(last)}">
        <p style="margin:0 0 3px;font-size:10px;font-weight:700;letter-spacing:2px;color:#94a3b8;text-transform:uppercase;">${label}</p>
        <p style="margin:0;font-size:14px;font-weight:600;color:#0f172a;">${value}</p>
      </td>
    </tr>`;
  const metaCellStyle = (i: number) => (metaCells.length === 1
    ? 'padding:16px 24px;width:100%;'
    : i === 0 ? 'padding:16px 24px;border-right:1px solid #e2e8f0;width:50%;' : 'padding:16px 24px;width:50%;');
  const metaRow = metaCells.length === 0 ? '' : `
    <tr>
      <td style="padding:0;">
        <table width="100%" cellpadding="0" cellspacing="0">
          <tr>${metaCells.map(([label, value], i) => `
            <td class="lsc-stack" style="${metaCellStyle(i)}">
              <p style="margin:0 0 3px;font-size:10px;font-weight:700;letter-spacing:2px;color:#94a3b8;text-transform:uppercase;">${label}</p>
              <p style="margin:0;font-size:14px;font-weight:600;color:#0f172a;">${value}</p>
            </td>`).join('')}
          </tr>
        </table>
      </td>
    </tr>`;
  const detailsGrid = (opts.showSchedule
    ? scheduleRow('Date From', winOpenLabel, false) + scheduleRow('To', winCloseLabel, metaRow === '')
    : '') + metaRow;

  // Invitations get a call-to-action button + link; reminders deliberately omit it.
  const ctaLabel = opts.buttonText ? fillText(opts.buttonText) : 'Open Exam Portal &rarr;';
  const ctaBlock = reminder ? '' : `
<!-- CTA Button -->
<tr>
<td class="lsc-pad" style="background:#ffffff;padding:8px 40px 32px;text-align:center;">
  <a href="${safeLink}" target="_blank" class="lsc-cta" style="display:inline-block;background:${pal.ctaBg};color:${pal.ctaText};font-size:16px;font-weight:700;text-decoration:none;padding:16px 48px;border-radius:8px;letter-spacing:0.3px;box-shadow:0 4px 14px ${pal.ctaShadow};">
    ${ctaLabel}
  </a>
  <p style="margin:16px 0 0;font-size:12px;color:#94a3b8;">Button not working? Copy and paste this link into your browser:</p>
  <p style="margin:6px 0 0;"><a href="${safeLink}" style="font-size:12px;color:${pal.link};word-break:break-all;">${safeLink}</a></p>
</td>
</tr>`;

  // Device requirements — reflect the exam's allowed-device restriction so the email
  // only tells candidates about devices they may actually use. Empty/undefined = all.
  const allowedDevices = (exam.allowedDeviceTypes && exam.allowedDeviceTypes.length > 0)
    ? exam.allowedDeviceTypes
    : (['desktop', 'tablet', 'mobile'] as const);
  const devicePhrase: Record<string, string> = {
    desktop: 'a laptop or desktop computer',
    tablet: 'a tablet',
    mobile: 'a smartphone',
  };
  const deviceParts = allowedDevices.map(d => devicePhrase[d]);
  const deviceListText = deviceParts.length === 1
    ? deviceParts[0]
    : deviceParts.length === 2
    ? `${deviceParts[0]} or ${deviceParts[1]}`
    : `${deviceParts.slice(0, -1).join(', ')}, or ${deviceParts[deviceParts.length - 1]}`;
  const allowsMobileOrTablet = allowedDevices.includes('mobile') || allowedDevices.includes('tablet');
  const isRestricted = !!(exam.allowedDeviceTypes && exam.allowedDeviceTypes.length > 0 && exam.allowedDeviceTypes.length < 3);

  const browserLine = allowsMobileOrTablet
    ? 'An up-to-date browser: <strong>Chrome</strong>, <strong>Edge</strong>, <strong>Firefox</strong>, or <strong>Safari</strong> (including iPhone &amp; iPad)'
    : 'An up-to-date browser: <strong>Chrome</strong>, <strong>Edge</strong>, or <strong>Firefox</strong> on your computer';

  const deviceRestrictionRow = isRestricted ? `
    <tr>
      <td style="padding:3px 0;font-size:13px;color:#334155;">&#10003; &nbsp;This exam can <strong>only</strong> be taken on ${deviceListText} — other devices will be blocked before you can start.</td>
    </tr>` : '';

  const needsCamera = !unproctored && (proctoring ? !!proctoring.cameraRequired : true);
  const needsMic = !unproctored && (proctoring ? !!proctoring.microphoneRequired : true);
  const hardwareHtml = needsCamera && needsMic
    ? ' with a working <strong>camera</strong> and <strong>microphone</strong>'
    : needsCamera ? ' with a working <strong>camera</strong>'
    : needsMic ? ' with a working <strong>microphone</strong>'
    : '';
  const permissionText = needsCamera && needsMic ? 'camera and microphone' : needsCamera ? 'camera' : needsMic ? 'microphone' : '';
  const requirementRow = (html: string) => `
            <tr>
              <td style="padding:3px 0;font-size:13px;color:#334155;">&#10003; &nbsp;${html}</td>
            </tr>`;
  const requirementRows = [
    requirementRow(`${deviceListText.charAt(0).toUpperCase() + deviceListText.slice(1)}${hardwareHtml}`) + deviceRestrictionRow,
    requirementRow(browserLine),
    permissionText ? requirementRow(`Allow ${permissionText} access when your browser prompts you`) : '',
    unproctored
      ? requirementRow('A <strong>stable internet connection</strong> and a quiet place where you can focus')
      : requirementRow(`A ${needsCamera ? '<strong>well-lit, quiet room</strong>' : '<strong>quiet room</strong>'} and a <strong>stable internet connection</strong>`),
    unproctored ? '' : requirementRow('Stay on the exam screen — do <strong>not</strong> switch tabs, apps, or leave the window'),
  ].join('');
  const requirementsBlock = !opts.showRequirements ? '' : `
      <!-- Requirements -->
      <tr>
        <td class="lsc-pad" style="background:${pal.bandBg};padding:20px 40px;border-top:1px solid ${pal.bandBorder};">
          <p style="margin:0 0 10px;font-size:12px;font-weight:700;color:${pal.bandHeading};text-transform:uppercase;letter-spacing:1px;">Before You Begin — What You Need</p>
          <table width="100%" cellpadding="0" cellspacing="0">${requirementRows}
          </table>
        </td>
      </tr>
`;
  const monitoredParts = [needsCamera ? 'webcam' : '', needsMic ? 'microphone' : '', 'screen activity'].filter(Boolean);
  const monitoredText = monitoredParts.length === 1
    ? monitoredParts[0]
    : `${monitoredParts.slice(0, -1).join(', ')}${monitoredParts.length > 2 ? ',' : ''} and ${monitoredParts[monitoredParts.length - 1]}`;
  const noticeBlock = !opts.showProctoringNotice ? '' : unproctored ? `
      <!-- Notice -->
      <tr>
        <td class="lsc-pad" style="background:#f8fafc;border-top:1px solid #e2e8f0;padding:16px 40px;">
          <p style="margin:0;font-size:12px;color:#334155;line-height:1.6;">
            <strong>&#9432; Please note:</strong> This exam is <strong>not proctored</strong> — there is no camera, microphone or screen monitoring. Answer the questions on your own and submit before the exam window closes.
          </p>
        </td>
      </tr>` : `
      <!-- Warning Banner -->
      <tr>
        <td class="lsc-pad" style="background:#fef2f2;border-top:1px solid #fecaca;padding:16px 40px;">
          <p style="margin:0;font-size:12px;color:#b91c1c;line-height:1.6;">
            <strong>&#9888; Important:</strong> This exam is proctored by AI. Your ${monitoredText} will be monitored continuously. Any suspicious behaviour will be flagged as a violation and reported to the exam administrator.
          </p>
        </td>
      </tr>`;
  const examKind = unproctored ? 'exam' : 'proctored exam';

  // The inbox preview line only mentions the blocks the email actually shows.
  const preheaderDuration = opts.showDuration ? ` Duration ${durationLabel}.` : '';
  const preheader = reminder
    ? `Reminder: your ${examKind} "${safeTitle}"${opts.showSchedule ? ` is open from ${winOpenLabel} to ${winCloseLabel}.` : ' is still open.'}${preheaderDuration}`
    : `Your ${examKind} "${safeTitle}"${opts.showSchedule ? ` is scheduled for ${dateStr} at ${timeStr}.` : ' is ready for you.'}${preheaderDuration} Open the secure portal to begin.`;

  // Downloadable instructions (linked, not attached — keeps the email tiny and fast to send). The
  // guide is all about camera / microphone / screen permissions and violations, so an unproctored
  // exam leaves it out by default rather than contradict the "no monitoring" notice.
  const instructionsBlock = !opts.showInstructionsPdf ? '' : `
<tr>
<td class="lsc-pad" style="background:#ffffff;padding:4px 40px 24px;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;">
    <tr>
      <td style="padding:16px 20px;">
        <p style="margin:0 0 6px;font-size:12px;font-weight:700;color:#334155;">&#128196; Exam Instructions</p>
        <p style="margin:0 0 12px;font-size:13px;color:#475569;line-height:1.6;">Please read the full instructions before your exam. Download the guide below.</p>
        <a href="${instructionsUrl}" target="_blank" style="display:inline-block;background:${pal.pdfBg};color:${pal.pdfText};font-size:13px;font-weight:600;text-decoration:none;padding:10px 20px;border-radius:6px;border:1px solid ${pal.pdfBorder};">Download Exam Instructions (PDF) &rarr;</a>
      </td>
    </tr>
  </table>
</td>
</tr>`;

  // Optional sign-off just above the footer.
  const closingBlock = !opts.closingNote ? '' : `
      <!-- Closing Note -->
      <tr>
        <td class="lsc-pad" style="background:#ffffff;padding:24px 40px;border-top:1px solid #e2e8f0;">
          <p style="margin:0;font-size:14px;color:#475569;line-height:1.7;">${fillText(opts.closingNote).replace(/\n/g, '<br/>')}</p>
        </td>
      </tr>`;

  const headerTitle = opts.headerTitle ? fillText(opts.headerTitle) : safeTitle;

  const body = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta name="x-apple-disable-message-reformatting" />
<meta name="color-scheme" content="light only" />
<title>${escapeEmailHtml(subject)}</title>
<style>
  body { margin:0; padding:0; -webkit-text-size-adjust:100%; }
  img { border:0; line-height:100%; outline:none; text-decoration:none; }
  a { color:${pal.link}; }
  @media only screen and (max-width:620px) {
    .lsc-container { width:100% !important; border-radius:0 !important; }
    .lsc-pad { padding-left:22px !important; padding-right:22px !important; }
    .lsc-stack { display:block !important; width:100% !important; border-right:none !important; }
    .lsc-h1 { font-size:22px !important; }
    .lsc-cta { display:block !important; width:auto !important; }
  }
</style>
</head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:'Segoe UI',Arial,sans-serif;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:#f1f5f9;font-size:1px;line-height:1px;">
  ${preheader}
</div>
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:32px 0;">
  <tr><td align="center">
    <table width="600" cellpadding="0" cellspacing="0" class="lsc-container" style="max-width:600px;width:100%;border-radius:12px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.10);">

      <!-- Header -->
      <tr>
        <td class="lsc-pad" style="background:${pal.headerBg};padding:36px 40px 28px;">
          <p style="margin:0 0 6px;font-size:11px;font-weight:700;letter-spacing:3px;color:${pal.headerEyebrow};text-transform:uppercase;">${unproctored ? 'Online Examination' : 'Proctored Online Examination'}</p>
          <h1 class="lsc-h1" style="margin:0;font-size:26px;font-weight:700;color:#ffffff;line-height:1.3;">${headerTitle}</h1>
          <p style="margin:8px 0 0;font-size:13px;color:${pal.headerSub};">${unproctored ? 'Secure · Online' : 'Secure · Proctored · Online'}</p>
        </td>
      </tr>

      <!-- Greeting -->
      <tr>
        <td class="lsc-pad" style="background:#ffffff;padding:32px 40px 0;">
          ${greetingBlock}
        </td>
      </tr>

      <!-- Exam Details Card -->
      <tr>
        <td class="lsc-pad" style="background:#ffffff;padding:24px 40px;">
          <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;overflow:hidden;">
            <tr>
              <td style="padding:20px 24px;${rowBorder(detailsGrid === '')}">
                <p style="margin:0 0 3px;font-size:10px;font-weight:700;letter-spacing:2px;color:#94a3b8;text-transform:uppercase;">Exam</p>
                <p style="margin:0;font-size:15px;font-weight:600;color:#0f172a;">${safeTitle}</p>
              </td>
            </tr>
            ${detailsGrid}
          </table>
        </td>
      </tr>

      ${ctaBlock}
${requirementsBlock}      ${instructionsBlock}
${noticeBlock}${closingBlock}

      <!-- Footer -->
      <tr>
        <td class="lsc-pad" style="background:#1e293b;padding:24px 40px;text-align:center;">
          <p style="margin:0 0 4px;font-size:13px;font-weight:600;color:#f1f5f9;">ProctorGuard &mdash; Secure Online Examinations</p>
          <p style="margin:0;font-size:11px;color:#64748b;">This is an automated message. Please do not reply to this email.</p>
          <p style="margin:8px 0 0;font-size:11px;color:#475569;">If you have any issues, contact your examination coordinator.</p>
        </td>
      </tr>

    </table>
  </td></tr>
</table>
</body>
</html>`;

  return { subject, body };
};

/** Convenience for previews: the email for one kind of an exam. */
export const buildExamEmailForKind = (exam: Exam, kind: ExamMailKind, recipientName: string, link: string) =>
  buildExamEmailContent(exam, recipientName, kind === 'REMINDER' ? '' : link, kind === 'REMINDER');
