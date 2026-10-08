import React, { useState, useRef, useEffect } from 'react';
import { Batch, Exam, ExamMailKind, Question, QuestionType, Student, NotificationTemplate, UserRole, CompanyDirectoryRecord } from '../../types';
import { Plus, Trash2, Save, FileSpreadsheet, Upload, Download, CheckCircle, AlertCircle, Share2, Calendar, Clock, XCircle, FileWarning, Users, Search, Lock, Mail, Send, Loader2, Shuffle, Bell, ListOrdered, Eye, Copy, Monitor, Tablet, Smartphone, Pencil, Award } from 'lucide-react';
import type { DeviceType } from '../../types';
import { ExamTake } from '../student/ExamTake';
import { apiGet, apiPost } from '../../services/api';
import { Pagination, usePagination } from './Pagination';
import { useSettings } from '../../services/appSettings';
import {
  EXAM_TIMEZONES, DEFAULT_EXAM_TIMEZONE, resolveExamTimezone,
  epochToZonedInput, zonedInputToEpoch,
  formatScheduleLabel, formatScheduleShort, formatDateInZone, formatTimeInZone,
} from '../../services/timezone';

// Render an exam duration in minutes as a human-friendly string, e.g. "1 hr 30 min".
const formatDuration = (mins: number): string => {
  const total = Math.max(0, Math.round(Number(mins) || 0));
  if (total === 0) return 'Not specified';
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m} min`;
  if (m === 0) return `${h} hr`;
  return `${h} hr ${m} min`;
};

// A student resolved as the target of one exam's mail run.
// attemptStatus / attemptCount come from the server's exam_sessions aggregate and drive the Mail
// Composer's audience filters — NOT_STARTED means the student never opened the exam at all.
type ExamRecipient = {
  id: string; fullName: string; email: string; registrationId: string; companyId: number;
  invitedAt?: number | null; token?: string;
  attemptCount?: number;
  attemptStatus?: 'NOT_STARTED' | 'IN_PROGRESS' | 'COMPLETED' | 'TERMINATED';
  completed?: boolean;
  lastAttemptAt?: number | null;
};

// Who a composed mail goes to. NOT_ATTEMPTED is the common case this screen exists for: chase the
// candidates who never opened the exam. NOT_COMPLETED additionally catches attempts that were
// started and then abandoned or terminated.
type MailAudience = 'ALL' | 'NOT_ATTEMPTED' | 'NOT_COMPLETED' | 'NOT_INVITED';

const MAIL_AUDIENCES: { id: MailAudience; label: string; hint: string }[] = [
  { id: 'NOT_ATTEMPTED', label: 'Not attempted', hint: 'Never opened the exam' },
  { id: 'NOT_COMPLETED', label: 'Not completed', hint: 'No submitted attempt (includes abandoned)' },
  { id: 'NOT_INVITED', label: 'Never invited', hint: 'No access link sent yet' },
  { id: 'ALL', label: 'All assigned', hint: 'Everyone assigned to this exam' },
];

const filterByAudience = (recipients: ExamRecipient[], audience: MailAudience): ExamRecipient[] => {
  switch (audience) {
    case 'NOT_ATTEMPTED':
      return recipients.filter(r => (r.attemptStatus ?? 'NOT_STARTED') === 'NOT_STARTED');
    case 'NOT_COMPLETED':
      return recipients.filter(r => !r.completed);
    case 'NOT_INVITED':
      return recipients.filter(r => !r.invitedAt);
    default:
      return recipients;
  }
};

// Built-in copy for each mail kind. These are only the DEFAULTS — an admin can override the subject
// and message per exam in the Mail Composer (persisted as exam.mailTemplates), and the invitation
// additionally honours the older notificationConfig.customSubject/customMessage fields.
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

// Resolve the subject/message actually used for one exam + mail kind, in priority order:
// per-exam override (Mail Composer) → legacy notificationConfig (invitations only) → built-in default.
// Placeholders are left unsubstituted here so the composer can show the editable template text.
export const resolveExamMailTemplate = (exam: Partial<Exam>, reminder: boolean): { subject: string; message: string } => {
  const saved = exam.mailTemplates?.[reminder ? 'REMINDER' : 'INVITE'];
  if (reminder) {
    return {
      subject: saved?.subject?.trim() || 'Reminder — {ExamTitle}',
      message: saved?.message?.trim() || DEFAULT_REMINDER_MESSAGE,
    };
  }
  return {
    subject: saved?.subject?.trim() || exam.notificationConfig?.customSubject?.trim() || 'Your Exam Invitation — {ExamTitle}',
    message: saved?.message?.trim() || exam.notificationConfig?.customMessage?.trim() || DEFAULT_INVITE_MESSAGE,
  };
};

// Student names (CSV / LMS webhook imports) and exam titles are plain text; escape them wherever they
// land in the email HTML so a name like "<b>Ana</b>" or "R&D" can't inject markup or break the layout.
// The admin-authored message template itself is left as-is (saved templates may carry HTML).
const escapeEmailHtml = (value: string) => value
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

// Builds the exact invitation/reminder email HTML sent by dispatchEmails. Also used by the
// live preview in the Email Notifications editor and the Mail Composer, so what admins see is
// exactly what sends. `override` lets the composer preview unsaved edits without persisting them.
const buildExamEmailContent = (
  exam: Exam,
  recipientName: string,
  link: string,
  reminder: boolean,
  override?: { subject?: string; message?: string },
): { subject: string; body: string } => {
  // Exam instructions are LINKED, not attached: a 700 KB PDF on every message made large
  // batches slow and risked Gmail size/rate limits. The file is served from the app's public
  // root, so candidates download it on demand from a tiny link instead.
  const instructionsUrl = `${window.location.origin}/ProctorGuard_Exam_Instructions_updated.pdf`;

  // Every date/time in the email is rendered in the exam's own timezone so the
  // student sees the same schedule the admin set, regardless of local clocks.
  const examTz = resolveExamTimezone(exam.timezone);
  // Use the exam's actual time limit, not the availability window (endTime - startTime).
  const durationMin = exam.durationMinutes;
  const dateStr = formatDateInZone(exam.startTime, examTz);
  const timeStr = formatTimeInZone(exam.startTime, examTz);

  // Availability window (portal open → close) for the reminder email,
  // rendered as an explicit "From → To" range in the exam's timezone.
  const winOpenLabel = formatScheduleLabel(exam.startTime, examTz);
  const winCloseLabel = formatScheduleLabel(exam.endTime, examTz);

  const startLabel = `${dateStr} at ${timeStr}`;
  const safeName = escapeEmailHtml(recipientName);
  const safeTitle = escapeEmailHtml(exam.title);
  const safeLink = escapeEmailHtml(link);
  // Function replacers: a plain replacement string would expand "$&" / "$1" sequences that can
  // legitimately appear in a title or name. `html` escapes the substituted values for the body.
  const fillTemplate = (tpl: string, html = false) => tpl
    .replace(/\{StudentName\}/g, () => (html ? safeName : recipientName))
    .replace(/\{ExamTitle\}/g, () => (html ? safeTitle : exam.title))
    .replace(/\{StartTime\}/g, () => startLabel)
    .replace(/\{Link\}/g, () => (html ? safeLink : link));

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
  // runs for — instead of a single fixed start date/time.
  const detailsGrid = `
    <tr>
      <td class="lsc-pad" style="padding:16px 24px;border-bottom:1px solid #e2e8f0;">
        <p style="margin:0 0 3px;font-size:10px;font-weight:700;letter-spacing:2px;color:#94a3b8;text-transform:uppercase;">Date From</p>
        <p style="margin:0;font-size:14px;font-weight:600;color:#0f172a;">${winOpenLabel}</p>
      </td>
    </tr>
    <tr>
      <td class="lsc-pad" style="padding:16px 24px;border-bottom:1px solid #e2e8f0;">
        <p style="margin:0 0 3px;font-size:10px;font-weight:700;letter-spacing:2px;color:#94a3b8;text-transform:uppercase;">To</p>
        <p style="margin:0;font-size:14px;font-weight:600;color:#0f172a;">${winCloseLabel}</p>
      </td>
    </tr>
    <tr>
      <td style="padding:0;">
        <table width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td class="lsc-stack" style="padding:16px 24px;border-right:1px solid #e2e8f0;width:50%;">
              <p style="margin:0 0 3px;font-size:10px;font-weight:700;letter-spacing:2px;color:#94a3b8;text-transform:uppercase;">Duration</p>
              <p style="margin:0;font-size:14px;font-weight:600;color:#0f172a;">${formatDuration(durationMin)}</p>
            </td>
            <td class="lsc-stack" style="padding:16px 24px;width:50%;">
              <p style="margin:0 0 3px;font-size:10px;font-weight:700;letter-spacing:2px;color:#94a3b8;text-transform:uppercase;">Candidate</p>
              <p style="margin:0;font-size:14px;font-weight:600;color:#0f172a;">${safeName}</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>`;

  // Invitations get a call-to-action button + link; reminders deliberately omit it.
  const ctaBlock = reminder ? '' : `
<!-- CTA Button -->
<tr>
<td class="lsc-pad" style="background:#ffffff;padding:8px 40px 32px;text-align:center;">
  <a href="${safeLink}" target="_blank" class="lsc-cta" style="display:inline-block;background:linear-gradient(135deg,#1d4ed8,#2563eb);color:#ffffff;font-size:16px;font-weight:700;text-decoration:none;padding:16px 48px;border-radius:8px;letter-spacing:0.3px;box-shadow:0 4px 14px rgba(37,99,235,0.4);">
    Open Exam Portal &rarr;
  </a>
  <p style="margin:16px 0 0;font-size:12px;color:#94a3b8;">Button not working? Copy and paste this link into your browser:</p>
  <p style="margin:6px 0 0;"><a href="${safeLink}" style="font-size:12px;color:#2563eb;word-break:break-all;">${safeLink}</a></p>
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

  const preheader = reminder
    ? `Reminder: your proctored exam "${safeTitle}" is open from ${winOpenLabel} to ${winCloseLabel}. Duration ${formatDuration(durationMin)}.`
    : `Your proctored exam "${safeTitle}" is scheduled for ${dateStr} at ${timeStr}. Duration ${formatDuration(durationMin)}. Open the secure portal to begin.`;

  // Downloadable instructions (linked, not attached — keeps the email tiny and fast to send).
  const instructionsBlock = `
<tr>
<td class="lsc-pad" style="background:#ffffff;padding:4px 40px 24px;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;">
    <tr>
      <td style="padding:16px 20px;">
        <p style="margin:0 0 6px;font-size:12px;font-weight:700;color:#334155;">&#128196; Exam Instructions</p>
        <p style="margin:0 0 12px;font-size:13px;color:#475569;line-height:1.6;">Please read the full instructions before your exam. Download the guide below.</p>
        <a href="${instructionsUrl}" target="_blank" style="display:inline-block;background:#eff6ff;color:#1d4ed8;font-size:13px;font-weight:600;text-decoration:none;padding:10px 20px;border-radius:6px;border:1px solid #bfdbfe;">Download Exam Instructions (PDF) &rarr;</a>
      </td>
    </tr>
  </table>
</td>
</tr>`;

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
  a { color:#2563eb; }
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
        <td class="lsc-pad" style="background:linear-gradient(135deg,#1e3a8a 0%,#2563eb 60%,#3b82f6 100%);padding:36px 40px 28px;">
          <p style="margin:0 0 6px;font-size:11px;font-weight:700;letter-spacing:3px;color:#bfdbfe;text-transform:uppercase;">Proctored Online Examination</p>
          <h1 class="lsc-h1" style="margin:0;font-size:26px;font-weight:700;color:#ffffff;line-height:1.3;">${safeTitle}</h1>
          <p style="margin:8px 0 0;font-size:13px;color:#93c5fd;">Secure · Proctored · Online</p>
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
              <td style="padding:20px 24px;border-bottom:1px solid #e2e8f0;">
                <p style="margin:0 0 3px;font-size:10px;font-weight:700;letter-spacing:2px;color:#94a3b8;text-transform:uppercase;">Exam</p>
                <p style="margin:0;font-size:15px;font-weight:600;color:#0f172a;">${safeTitle}</p>
              </td>
            </tr>
            ${detailsGrid}
          </table>
        </td>
      </tr>

      ${ctaBlock}

      <!-- Requirements -->
      <tr>
        <td class="lsc-pad" style="background:#eff6ff;padding:20px 40px;border-top:1px solid #dbeafe;">
          <p style="margin:0 0 10px;font-size:12px;font-weight:700;color:#1d4ed8;text-transform:uppercase;letter-spacing:1px;">Before You Begin — What You Need</p>
          <table width="100%" cellpadding="0" cellspacing="0">
            <tr>
              <td style="padding:3px 0;font-size:13px;color:#334155;">&#10003; &nbsp;${deviceListText.charAt(0).toUpperCase() + deviceListText.slice(1)} with a working <strong>camera</strong> and <strong>microphone</strong></td>
            </tr>${deviceRestrictionRow}
            <tr>
              <td style="padding:3px 0;font-size:13px;color:#334155;">&#10003; &nbsp;${browserLine}</td>
            </tr>
            <tr>
              <td style="padding:3px 0;font-size:13px;color:#334155;">&#10003; &nbsp;Allow camera and microphone access when your browser prompts you</td>
            </tr>
            <tr>
              <td style="padding:3px 0;font-size:13px;color:#334155;">&#10003; &nbsp;A <strong>well-lit, quiet room</strong> and a <strong>stable internet connection</strong></td>
            </tr>
            <tr>
              <td style="padding:3px 0;font-size:13px;color:#334155;">&#10003; &nbsp;Stay on the exam screen — do <strong>not</strong> switch tabs, apps, or leave the window</td>
            </tr>
          </table>
        </td>
      </tr>
      ${instructionsBlock}

      <!-- Warning Banner -->
      <tr>
        <td class="lsc-pad" style="background:#fef2f2;border-top:1px solid #fecaca;padding:16px 40px;">
          <p style="margin:0;font-size:12px;color:#b91c1c;line-height:1.6;">
            <strong>&#9888; Important:</strong> This exam is proctored by AI. Your webcam, microphone, and screen activity will be monitored continuously. Any suspicious behaviour will be flagged as a violation and reported to the exam administrator.
          </p>
        </td>
      </tr>

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

const readTextFile = async (file: File) => {
  const buffer = await file.arrayBuffer();
  try {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    return decoder.decode(buffer).replace(/^\uFEFF/, '');
  } catch {
    const decoder = new TextDecoder('windows-1252');
    return decoder.decode(buffer).replace(/^\uFEFF/, '');
  }
};

// apiGet/apiPost throw the raw response body, which for this API is JSON like {"error":"..."}.
// Surface the server's own reason (e.g. "endTime must be later than startTime.") instead of either a
// generic message or a raw JSON blob; fall back when the body is HTML/JSON without an error field.
const apiErrorMessage = (e: unknown, fallback: string): string => {
  const raw = (e instanceof Error ? e.message : typeof e === 'string' ? e : '').trim();
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed.error === 'string' && parsed.error.trim() ? parsed.error.trim() : fallback;
  } catch {
    return raw.startsWith('<') || raw.length > 300 ? fallback : raw;
  }
};

// Build a CSV download href. encodeURIComponent (not encodeURI) is required: encodeURI leaves '#'
// unescaped, and browsers treat '#' in a data: URL as the start of a fragment — silently truncating
// the file at the first '#' (e.g. the question template's '#' guide rows, or a '#' in an exam title).
const csvDataUri = (content: string) => 'data:text/csv;charset=utf-8,' + encodeURIComponent(String.fromCharCode(0xFEFF) + content);

// Quote one CSV cell, doubling embedded quotes so a name like `Ann "Annie" Lee` stays one column.
const csvCell = (value: unknown) => `"${String(value ?? '').replace(/"/g, '""')}"`;

// datetime-local value that never throws: Intl throws RangeError on an Invalid Date, and there is no
// error boundary above this screen, so a NaN/undefined instant would blank the whole admin panel.
const zonedInputValue = (epoch: number | undefined, tz: string): string =>
  typeof epoch === 'number' && Number.isFinite(epoch) ? epochToZonedInput(epoch, tz) : '';

const getAdminCompanyId = () => {
  if (typeof window === 'undefined') return 1;
  try {
    const raw = localStorage.getItem('pg_admin_auth');
    if (!raw) return 1;
    const parsed = JSON.parse(raw);
    const companyId = Number(parsed?.companyId);
    return Number.isFinite(companyId) && companyId > 0 ? companyId : 1;
  } catch {
    return 1;
  }
};

const defaultViolationLimits = {
  camera: 0,
  microphone: 0,
  fullscreen: 0,
  copyPaste: 0,
};

const defaultProctorTiming = {
  gazeAwaySeconds: 9,
  audioSeconds: 2,
};

const defaultProctoringConfig: Exam['proctoringConfig'] = {
  cameraRequired: true,
  microphoneRequired: false,
  fullScreenEnforced: true,
  tabSwitchLimit: 3,
  violationLimits: { ...defaultViolationLimits },
  proctorTiming: { ...defaultProctorTiming },
};

interface CsvError {
  row: number;
  message: string;
  rawData: string;
}

// Maps CSV "Type" cells (uppercased, with spaces/_/-/slashes stripped) to a canonical QuestionType.
// Structured types (MATCHING/ORDERING/DRAG_DROP) are intentionally absent — they import via the
// question editor or JSON only. Keys must already be normalised the same way as the lookup.
const CSV_TYPE_ALIASES: Record<string, QuestionType> = {
  MCQ: QuestionType.MCQ,
  MULTISELECT: QuestionType.MULTI_SELECT,
  MULTIPLESELECT: QuestionType.MULTI_SELECT,
  MSQ: QuestionType.MULTI_SELECT,
  TRUEFALSE: QuestionType.TRUE_FALSE,
  TF: QuestionType.TRUE_FALSE,
  YESNO: QuestionType.YES_NO,
  YN: QuestionType.YES_NO,
  SHORTTEXT: QuestionType.SHORT_TEXT,
  SHORT: QuestionType.SHORT_TEXT,
  LONGTEXT: QuestionType.LONG_TEXT,
  ESSAY: QuestionType.LONG_TEXT,
  LONG: QuestionType.LONG_TEXT,
  TEXT: QuestionType.TEXT,
  FILLBLANK: QuestionType.FILL_BLANK,
  FILLINTHEBLANK: QuestionType.FILL_BLANK,
  FIB: QuestionType.FILL_BLANK,
  BLANK: QuestionType.FILL_BLANK,
  NUMERIC: QuestionType.NUMERIC,
  NUMBER: QuestionType.NUMERIC,
  NUM: QuestionType.NUMERIC,
  DATE: QuestionType.DATE,
  TIME: QuestionType.TIME,
};

interface ExamManagerProps {
  students: Student[];
  exams: Exam[];
  onUpdateExams: React.Dispatch<React.SetStateAction<Exam[]>>;
  onUpdateStudents?: React.Dispatch<React.SetStateAction<Student[]>>;
  role?: UserRole;
}

export const ExamManager: React.FC<ExamManagerProps> = ({ students: propStudents, exams: propExams, onUpdateExams: propOnUpdateExams, onUpdateStudents: propOnUpdateStudents, role }) => {
  const { settings } = useSettings();
  const isSuperAdmin = role === UserRole.SUPER_ADMIN;

  // Super admin operates across every tenant: it keeps its own per-company exam/student list and
  // a company selector. A regular admin stays bound to its own company via props + request headers.
  const [companies, setCompanies] = useState<CompanyDirectoryRecord[]>([]);
  const [selectedCompanyId, setSelectedCompanyId] = useState<number | ''>('');
  const [superExams, setSuperExams] = useState<Exam[]>([]);
  const [superStudents, setSuperStudents] = useState<Student[]>([]);
  const [superExamsLoading, setSuperExamsLoading] = useState(false);

  // Effective bindings — the rest of the component uses these transparently.
  const exams = isSuperAdmin ? superExams : propExams;
  const students = isSuperAdmin ? superStudents : propStudents;
  const onUpdateExams = isSuperAdmin ? setSuperExams : propOnUpdateExams;
  const onUpdateStudents = isSuperAdmin ? setSuperStudents : propOnUpdateStudents;
  const effectiveCompanyId = isSuperAdmin ? (selectedCompanyId === '' ? null : selectedCompanyId) : null;
  // Extra query string / payload field that pins super-admin requests to the chosen company.
  const companyQuery = isSuperAdmin && effectiveCompanyId ? `?companyId=${effectiveCompanyId}` : '';
  // Merge the selected companyId into a POST body so the backend scopes the write correctly.
  const withCompany = <T extends object>(body: T): T & { companyId?: number } =>
    isSuperAdmin && effectiveCompanyId ? { ...body, companyId: effectiveCompanyId } : body;
  // Build a fresh exam draft pre-filled from the admin's configurable defaults.
  const buildExamDefaults = (): Partial<Exam> => {
    const d = settings.examDefaults;
    return {
      title: '',
      durationMinutes: d.durationMinutes,
      startTime: Date.now(),
      endTime: Date.now() + 86400000 * 2,
      timezone: DEFAULT_EXAM_TIMEZONE,
      questions: [],
      sections: [],
      questionCount: 0,
      shuffleQuestions: true,
      showResults: d.showResults,
      certificateEnabled: false,
      reconnectLimit: d.reconnectLimit,
      passPercent: d.passPercent,
      proctoringConfig: {
        cameraRequired: d.cameraRequired,
        microphoneRequired: d.microphoneRequired,
        fullScreenEnforced: d.fullScreenEnforced,
        tabSwitchLimit: d.tabSwitchLimit,
        violationLimits: { ...d.violationLimits },
        proctorTiming: { gazeAwaySeconds: d.gazeAwaySeconds, audioSeconds: d.audioSeconds },
      },
      totalMarks: 0,
      allowedDeviceTypes: ['desktop', 'tablet', 'mobile'],
      assignedStudentIds: [],
      assignedBatchIds: [],
      status: 'DRAFT',
      notificationConfig: {
        enabled: false,
        reminders: { hours24: true, hours1: true },
        customSubject: '',
        customMessage: '',
      },
    };
  };
  const [isCreating, setIsCreating] = useState(false);
  const [batchSearch, setBatchSearch] = useState('');
  const [emailSendingId, setEmailSendingId] = useState<string | null>(null);
  const [sendingMode, setSendingMode] = useState<'notify' | 'reminder' | null>(null);
  const [activeSectionId, setActiveSectionId] = useState<string | null>(null);
  const [templates, setTemplates] = useState<NotificationTemplate[]>([]);
  const [batches, setBatches] = useState<Batch[]>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState<number | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Exam | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  // In-flight guards: each of these POSTs/downloads used to be re-triggerable by a double click
  // (a double-clicked Save on a NEW exam minted two client ids and created the exam twice).
  const [savingExam, setSavingExam] = useState(false);
  const [duplicatingId, setDuplicatingId] = useState<string | null>(null);
  const [exportingLinksId, setExportingLinksId] = useState<string | null>(null);
  // Archived exams are hidden from the grid unless the admin asks to see them.
  const [showArchived, setShowArchived] = useState(false);
  // JSON snapshot of the exam as it was when the editor opened, so Cancel can warn about unsaved edits.
  const editorSnapshotRef = useRef<string>('');
  // Set when an exam has both already-invited and newly-assigned students: the admin picks who to mail.
  const [inviteScopeTarget, setInviteScopeTarget] = useState<{ exam: Exam; recipients: ExamRecipient[]; pending: ExamRecipient[] } | null>(null);
  // Per-exam Mail Composer: pick the audience (e.g. only students who never attempted), edit the
  // subject/message, preview it, optionally save it as this exam's default, then send.
  const [mailComposer, setMailComposer] = useState<{
    exam: Exam;
    kind: ExamMailKind;
    subject: string;
    message: string;
    audience: MailAudience;
    recipients: ExamRecipient[];
    loading: boolean;
    saving: boolean;
    dirty: boolean;
    error: string | null;
    notice: string | null;
  } | null>(null);
  
  // Preview State
  const [showPreview, setShowPreview] = useState(false);
  const [showMailPreview, setShowMailPreview] = useState(false);
  const [mailPreviewMode, setMailPreviewMode] = useState<'invite' | 'reminder'>('invite');
  
  // New Exam State — seeded from the configurable defaults.
  const [newExam, setNewExam] = useState<Partial<Exam>>(buildExamDefaults);

  // "Archive (Hide from list)" must stay hidden after a reload too — the API returns archived exams,
  // so the grid filters them out unless the admin opts to show them.
  const archivedCount = exams.filter(e => e.status === 'ARCHIVED').length;
  const visibleExams = showArchived ? exams : exams.filter(e => e.status !== 'ARCHIVED');

  // The exam grid and the editor's question list both grow without bound; each pages on its own.
  const examPaging = usePagination(visibleExams, showArchived ? 'all' : 'active');
  const questionPaging = usePagination(newExam.questions || [], newExam.id || '');
  // Show the page a freshly appended question landed on.
  const jumpToLastQuestionPage = (newTotal: number) =>
    questionPaging.setPage(Math.max(0, Math.ceil(newTotal / questionPaging.pageSize) - 1));

  const sections = newExam.sections || [];
  const useSections = sections.length > 0;

  // Manual Question State — one object holding the fields for every question type.
  // Only the field(s) relevant to `type` are read when building the Question on save.
  const manualQDefaults = {
    type: QuestionType.MCQ,
    text: '',
    options: ['', '', '', ''],   // MCQ / MULTI_SELECT choices
    correctIdx: 0,               // MCQ / TRUE_FALSE / YES_NO single correct option
    correctIndices: [] as number[], // MULTI_SELECT correct options
    blanks: [''],                // FILL_BLANK: each entry = comma-separated accepted answers for that blank
    numericValue: '',            // NUMERIC expected value
    numericTolerance: '',        // NUMERIC +/- tolerance (blank = exact)
    dateValue: '',               // DATE 'YYYY-MM-DD'
    timeValue: '',               // TIME 'HH:MM'
    matchLeft: ['', ''],         // MATCHING left column (row i pairs with right row i)
    matchRight: ['', ''],        // MATCHING right column
    orderItems: ['', ''],        // ORDERING items, entered in the CORRECT order
    dragItems: ['', ''],         // DRAG_DROP items
    dragBuckets: ['', ''],       // DRAG_DROP buckets
    dragItemBucket: [0, 0],      // DRAG_DROP: correct bucket index for each item
    marks: 1,
    negativeMarks: 0,     // deducted if answered but wrong; 0 = no negative marking
    // Kept as a STRING so the field can be left blank, which is what "no limit" is.
    wordLimit: ''
  };
  type ManualQState = typeof manualQDefaults;
  const [manualQ, setManualQ] = useState<ManualQState>(manualQDefaults);

  // Question Upload State
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploadStatus, setUploadStatus] = useState<'IDLE' | 'SUCCESS' | 'ERROR' | 'PARTIAL'>('IDLE');
  const [uploadMsg, setUploadMsg] = useState('');
  const [csvErrors, setCsvErrors] = useState<CsvError[]>([]);

  React.useEffect(() => {
    let cancelled = false;
    const loadTemplates = async () => {
      try {
        const data = await apiGet<{ templates: NotificationTemplate[] }>('templates.php?channel=EMAIL');
        if (!cancelled) {
          setTemplates(data?.templates || []);
        }
      } catch (e) {
        console.error('Failed to load templates:', e);
      }
    };
    loadTemplates();
    return () => {
      cancelled = true;
    };
  }, []);

  // Super admin: load the company list for the selector, and default to the first company.
  useEffect(() => {
    if (!isSuperAdmin) return;
    let cancelled = false;
    (async () => {
      try {
        const data = await apiGet<{ companies: CompanyDirectoryRecord[] }>('companies.php');
        if (cancelled) return;
        const list = data?.companies || [];
        setCompanies(list);
        setSelectedCompanyId(current => (current === '' ? (list[0]?.id ?? '') : current));
      } catch (e) {
        console.error('Failed to load companies:', e);
      }
    })();
    return () => { cancelled = true; };
  }, [isSuperAdmin]);

  // Super admin: (re)load the selected company's exams + students whenever the selection changes.
  useEffect(() => {
    if (!isSuperAdmin) return;
    if (!effectiveCompanyId) {
      setSuperExams([]);
      setSuperStudents([]);
      return;
    }
    let cancelled = false;
    (async () => {
      setSuperExamsLoading(true);
      try {
        const [examData, studentData] = await Promise.all([
          apiGet<{ exams: Exam[] }>(`exams.php${companyQuery}`),
          apiGet<{ students: Student[] }>(`students.php${companyQuery}`),
        ]);
        if (cancelled) return;
        setSuperExams(examData?.exams || []);
        setSuperStudents(studentData?.students || []);
      } catch (e) {
        if (!cancelled) console.error('Failed to load company exams:', e);
      } finally {
        if (!cancelled) setSuperExamsLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [isSuperAdmin, effectiveCompanyId]);

  useEffect(() => {
    let cancelled = false;
    const loadBatches = async () => {
      try {
        // A super admin scopes batches to the company chosen in the exam-tab selector, so the
        // assignment picker only offers that company's batches. Until a company is picked there is
        // nothing to load. A regular admin stays scoped to its own company via the request headers.
        if (isSuperAdmin && !effectiveCompanyId) {
          if (!cancelled) setBatches([]);
          return;
        }
        const endpoint = isSuperAdmin ? `batches.php${companyQuery}` : 'batches.php';
        const data = await apiGet<{ batches: Batch[] }>(endpoint);
        if (!cancelled) {
          setBatches(data?.batches || []);
        }
      } catch (e) {
        console.error('Failed to load batches:', e);
      }
    };
    loadBatches();
    return () => {
      cancelled = true;
    };
  }, [isSuperAdmin, effectiveCompanyId]);

  // Escape closes the top-most dialog (none of them handled it). The composer asks before discarding
  // unsaved edits, and the remove dialog stays put while its request is in flight.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (showMailPreview) { setShowMailPreview(false); return; }
      if (mailComposer) { closeComposer(); return; }
      if (inviteScopeTarget) { setInviteScopeTarget(null); return; }
      if (deleteTarget && !deleteBusy) setDeleteTarget(null);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [showMailPreview, mailComposer, inviteScopeTarget, deleteTarget, deleteBusy]);

  // Batch Assign State
  const studentBatchInputRef = useRef<HTMLInputElement>(null);
  const examImportRef = useRef<HTMLInputElement>(null);
  const studentCreateInputRef = useRef<HTMLInputElement>(null);

  const createSection = (title: string, order: number) => ({
    id: Math.random().toString(36).substr(2, 9),
    title,
    questionLimit: 0,
    shuffleQuestions: true,
    timeLimitMinutes: 0,
    lockOnComplete: true,
    displayOrder: order,
    questions: []
  });

  const enableSections = () => {
    if (useSections) return;
    const first = createSection('Section 1', 0);
    setNewExam(prev => ({
      ...prev,
      sections: [first],
      questions: (prev.questions || []).map(q => ({ ...q, sectionId: first.id }))
    }));
    setActiveSectionId(first.id);
  };

  const disableSections = () => {
    setNewExam(prev => ({ ...prev, sections: [] }));
    setActiveSectionId(null);
  };

  const getSectionQuestionCount = (sectionId: string) => {
    return (newExam.questions || []).filter(q => q.sectionId === sectionId).length;
  };

  // Split a comma-separated "accepted answers" cell into trimmed, non-empty alternates.
  const parseAccepted = (raw: string): string[] =>
    raw.split(',').map(s => s.trim()).filter(Boolean);

  // Build the per-type Question payload (options / answerKey / matchOptions). Returns an error
  // string if the form is incomplete, otherwise the partial Question fields.
  const buildQuestionByType = (): { error?: string; fields?: Partial<Question> } => {
    const t = manualQ.type;
    switch (t) {
      case QuestionType.MCQ: {
        // Blank option rows (e.g. the 4th default slot on a 3-choice question) are dropped — they used
        // to ship to candidates as empty, clickable answer cards — and the correct index is remapped
        // onto the compacted list.
        const raw = manualQ.options.map(o => o.trim());
        const keptIdx = raw.map((o, i) => (o ? i : -1)).filter(i => i >= 0);
        if (keptIdx.length < 2) return { error: 'Provide at least 2 options.' };
        if (manualQ.correctIdx < 0 || !raw[manualQ.correctIdx]) return { error: 'Mark a non-empty option as the correct answer.' };
        return { fields: { options: keptIdx.map(i => raw[i]), correctOptionIndex: keptIdx.indexOf(manualQ.correctIdx) } };
      }
      case QuestionType.MULTI_SELECT: {
        const raw = manualQ.options.map(o => o.trim());
        const keptIdx = raw.map((o, i) => (o ? i : -1)).filter(i => i >= 0);
        if (keptIdx.length < 2) return { error: 'Provide at least 2 options.' };
        if (manualQ.correctIndices.length < 1) return { error: 'Select at least one correct option.' };
        if (manualQ.correctIndices.some(i => !raw[i])) return { error: 'A ticked correct option is empty — fill it in or untick it.' };
        const correctIndices = manualQ.correctIndices.map(i => keptIdx.indexOf(i)).sort((a, b) => a - b);
        return { fields: { options: keptIdx.map(i => raw[i]), answerKey: { correctIndices } } };
      }
      case QuestionType.TRUE_FALSE:
        return { fields: { options: ['True', 'False'], correctOptionIndex: manualQ.correctIdx } };
      case QuestionType.YES_NO:
        return { fields: { options: ['Yes', 'No'], correctOptionIndex: manualQ.correctIdx } };
      case QuestionType.SHORT_TEXT:
      case QuestionType.LONG_TEXT:
        return { fields: {} }; // graded manually
      case QuestionType.FILL_BLANK: {
        const blanks = manualQ.blanks.map(parseAccepted);
        if (blanks.length === 0 || blanks.some(b => b.length === 0))
          return { error: 'Each blank needs at least one accepted answer.' };
        return { fields: { answerKey: { blanks: blanks.map(accepted => ({ accepted })) } } };
      }
      case QuestionType.NUMERIC: {
        if (manualQ.numericValue.trim() === '' || isNaN(Number(manualQ.numericValue)))
          return { error: 'Enter a valid numeric answer.' };
        const tol = manualQ.numericTolerance.trim();
        return { fields: { answerKey: { value: Number(manualQ.numericValue), tolerance: tol === '' ? null : Number(tol) } } };
      }
      case QuestionType.DATE:
        if (!manualQ.dateValue) return { error: 'Pick the correct date.' };
        return { fields: { answerKey: { value: manualQ.dateValue } } };
      case QuestionType.TIME:
        if (!manualQ.timeValue) return { error: 'Pick the correct time.' };
        return { fields: { answerKey: { value: manualQ.timeValue } } };
      case QuestionType.MATCHING: {
        const rows = manualQ.matchLeft
          .map((l, i) => ({ l: l.trim(), r: (manualQ.matchRight[i] || '').trim() }))
          .filter(p => p.l && p.r);
        if (rows.length < 2) return { error: 'Provide at least 2 complete match pairs.' };
        const pairs: Record<number, number> = {};
        rows.forEach((_, i) => { pairs[i] = i; });
        return { fields: { matchOptions: { left: rows.map(p => p.l), right: rows.map(p => p.r) }, answerKey: { pairs } } };
      }
      case QuestionType.ORDERING: {
        const items = manualQ.orderItems.map(s => s.trim()).filter(Boolean);
        if (items.length < 2) return { error: 'Provide at least 2 items to order.' };
        return { fields: { matchOptions: { items }, answerKey: { order: items.map((_, i) => i) } } };
      }
      case QuestionType.DRAG_DROP: {
        const items = manualQ.dragItems.map(s => s.trim());
        // Blank bucket rows are dropped, so each item's bucket index is remapped onto the compacted
        // list. Without this an item mapped to the bucket after a blank row silently landed one
        // bucket off (wrong answer key) or was rejected as out of range.
        const bucketRemap = new Map<number, number>();
        const buckets: string[] = [];
        manualQ.dragBuckets.forEach((b, i) => {
          const name = b.trim();
          if (name) { bucketRemap.set(i, buckets.length); buckets.push(name); }
        });
        const validItems = items.map((it, i) => ({ it, bucket: bucketRemap.get(manualQ.dragItemBucket[i] ?? 0) })).filter(x => x.it);
        if (validItems.length < 2) return { error: 'Provide at least 2 items.' };
        if (buckets.length < 2) return { error: 'Provide at least 2 buckets.' };
        if (validItems.some(x => x.bucket === undefined)) return { error: 'Every item must map to a non-empty bucket.' };
        const placements: Record<number, number> = {};
        validItems.forEach((x, i) => { placements[i] = x.bucket as number; });
        return { fields: { matchOptions: { items: validItems.map(x => x.it), buckets }, answerKey: { placements } } };
      }
      default:
        return { fields: {} };
    }
  };

  const handleAddManualQuestion = () => {
    if (!manualQ.text.trim()) {
      alert("Please enter the question text.");
      return;
    }

    // Marks are stored as INT and graded all-or-nothing, so 0, negatives, blanks (NaN) and fractions
    // (silently truncated server-side, desyncing the exam's total) are rejected up front.
    if (!Number.isInteger(manualQ.marks) || manualQ.marks < 1) {
      alert("Marks must be a whole number of at least 1.");
      return;
    }

    const built = buildQuestionByType();
    if (built.error) {
      alert(built.error);
      return;
    }

    const isManual = manualQ.type === QuestionType.SHORT_TEXT || manualQ.type === QuestionType.LONG_TEXT;
    const newQuestion: Question = {
      id: Math.random().toString(36).substr(2, 9),
      text: manualQ.text,
      type: manualQ.type,
      marks: manualQ.marks,
      // Manual (free-text) answers are never auto-graded, so a penalty would never apply to them.
      negativeMarks: isManual ? 0 : Math.max(0, Number(manualQ.negativeMarks) || 0),
      // Only descriptive (manual) answers can carry a word limit; blank or non-positive means no limit.
      wordLimit: isManual && parseInt(manualQ.wordLimit, 10) > 0 ? parseInt(manualQ.wordLimit, 10) : null,
      sectionId: useSections ? (activeSectionId || sections[0]?.id) : undefined,
      ...built.fields,
    };

    setNewExam(prev => ({
      ...prev,
      questions: [...(prev.questions || []), newQuestion]
    }));
    // Questions append to the end, so follow them onto the last page — otherwise a newly added
    // question silently lands on a page the admin isn't looking at.
    jumpToLastQuestionPage((newExam.questions?.length || 0) + 1);

    // Reset form, preserving the chosen type for fast entry of similar questions.
    setManualQ({ ...manualQDefaults, type: manualQ.type });
  };

  const updateOption = (idx: number, val: string) => {
    const newOptions = [...manualQ.options];
    newOptions[idx] = val;
    setManualQ({ ...manualQ, options: newOptions });
  };

  // Generic helper to edit a string[] field on manualQ (options, blanks, match columns, etc.).
  const updateListField = (field: keyof ManualQState, idx: number, val: string) => {
    setManualQ(prev => {
      const list = [...(prev[field] as string[])];
      list[idx] = val;
      return { ...prev, [field]: list };
    });
  };
  const addListItem = (field: keyof ManualQState, empty: string | number = '') => {
    setManualQ(prev => ({ ...prev, [field]: [...(prev[field] as any[]), empty] }));
  };
  const removeListItem = (field: keyof ManualQState, idx: number) => {
    setManualQ(prev => {
      const list = [...(prev[field] as any[])];
      if (list.length <= 1) return prev;
      list.splice(idx, 1);
      return { ...prev, [field]: list };
    });
  };
  // Removing an MCQ/Multi-Select option shifts every later option up one slot, so the answer key has
  // to shift with it — otherwise the "correct" mark silently moves to a different option. Removing the
  // correct option itself clears the mark (-1) so the admin must pick again rather than inherit A.
  const removeOption = (idx: number) => {
    setManualQ(prev => {
      if (prev.options.length <= 1) return prev;
      return {
        ...prev,
        options: prev.options.filter((_, i) => i !== idx),
        correctIdx: prev.correctIdx === idx ? -1 : prev.correctIdx > idx ? prev.correctIdx - 1 : prev.correctIdx,
        correctIndices: prev.correctIndices.filter(x => x !== idx).map(x => (x > idx ? x - 1 : x)),
      };
    });
  };
  // Same index-shift problem for Drag & Drop: items point at buckets by position.
  const removeDragBucket = (idx: number) => {
    setManualQ(prev => {
      if (prev.dragBuckets.length <= 1) return prev;
      return {
        ...prev,
        dragBuckets: prev.dragBuckets.filter((_, i) => i !== idx),
        dragItemBucket: prev.dragItemBucket.map(b => (b === idx ? 0 : b > idx ? b - 1 : b)),
      };
    });
  };
  const removeDragItem = (idx: number) => {
    setManualQ(prev => {
      if (prev.dragItems.length <= 1) return prev;
      return {
        ...prev,
        dragItems: prev.dragItems.filter((_, i) => i !== idx),
        dragItemBucket: prev.dragItemBucket.filter((_, i) => i !== idx),
      };
    });
  };

  const inputCls = "w-full px-3 py-2 border rounded-lg outline-none text-sm";
  const smallBtn = "text-xs text-slate-500 hover:text-red-600 px-2";

  // The per-question-type answer editor rendered inside the manual-entry form.
  const renderQuestionTypeEditor = () => {
    const t = manualQ.type;

    if (t === QuestionType.SHORT_TEXT || t === QuestionType.LONG_TEXT) {
      return (
        <p className="text-xs text-slate-500 bg-slate-50 border border-slate-200 rounded-lg p-3">
          Free-text answers are reviewed and scored manually in Results after the exam.
        </p>
      );
    }

    if (t === QuestionType.MCQ || t === QuestionType.MULTI_SELECT) {
      const multi = t === QuestionType.MULTI_SELECT;
      return (
        <div className="space-y-2">
          <label className="block text-xs text-slate-500">Options — mark the correct {multi ? 'answers' : 'answer'}</label>
          {manualQ.options.map((opt, i) => (
            <div key={i} className="flex items-center gap-2">
              <input
                type={multi ? 'checkbox' : 'radio'}
                name="mcq-correct"
                checked={multi ? manualQ.correctIndices.includes(i) : manualQ.correctIdx === i}
                onChange={() => {
                  if (multi) {
                    setManualQ(prev => ({
                      ...prev,
                      correctIndices: prev.correctIndices.includes(i)
                        ? prev.correctIndices.filter(x => x !== i)
                        : [...prev.correctIndices, i],
                    }));
                  } else {
                    setManualQ({ ...manualQ, correctIdx: i });
                  }
                }}
              />
              <input
                type="text" className={inputCls}
                placeholder={`Option ${String.fromCharCode(65 + i)}`}
                aria-label={`Option ${String.fromCharCode(65 + i)}`}
                value={opt}
                onChange={e => updateOption(i, e.target.value)}
              />
              <button type="button" className={smallBtn} aria-label={`Remove option ${String.fromCharCode(65 + i)}`} onClick={() => removeOption(i)}>✕</button>
            </div>
          ))}
          <button type="button" className="text-xs text-blue-600 hover:underline" onClick={() => addListItem('options')}>+ Add option</button>
        </div>
      );
    }

    if (t === QuestionType.TRUE_FALSE || t === QuestionType.YES_NO) {
      const labels = t === QuestionType.TRUE_FALSE ? ['True', 'False'] : ['Yes', 'No'];
      return (
        <div className="space-y-2">
          <label className="block text-xs text-slate-500">Correct answer</label>
          <div className="flex gap-4">
            {labels.map((lbl, i) => (
              <label key={i} className="flex items-center gap-2 text-sm">
                <input type="radio" name="tfyn-correct" checked={manualQ.correctIdx === i} onChange={() => setManualQ({ ...manualQ, correctIdx: i })} />
                {lbl}
              </label>
            ))}
          </div>
        </div>
      );
    }

    if (t === QuestionType.FILL_BLANK) {
      return (
        <div className="space-y-2">
          <label className="block text-xs text-slate-500">Accepted answers — one row per blank, comma-separate alternates (case-insensitive)</label>
          {manualQ.blanks.map((b, i) => (
            <div key={i} className="flex items-center gap-2">
              <span className="text-xs text-slate-400 w-14">Blank {i + 1}</span>
              <input type="text" className={inputCls} placeholder="e.g. Paris, paris city" value={b} onChange={e => updateListField('blanks', i, e.target.value)} />
              <button type="button" className={smallBtn} aria-label={`Remove blank ${i + 1}`} onClick={() => removeListItem('blanks', i)}>✕</button>
            </div>
          ))}
          <button type="button" className="text-xs text-blue-600 hover:underline" onClick={() => addListItem('blanks')}>+ Add blank</button>
        </div>
      );
    }

    if (t === QuestionType.NUMERIC) {
      return (
        <div className="flex gap-4">
          <div className="flex-1">
            <label className="block text-xs text-slate-500 mb-1">Correct value</label>
            <input type="number" step="any" className={inputCls} value={manualQ.numericValue} onChange={e => setManualQ({ ...manualQ, numericValue: e.target.value })} />
          </div>
          <div className="flex-1">
            <label className="block text-xs text-slate-500 mb-1">± Tolerance (optional)</label>
            <input type="number" step="any" min="0" className={inputCls} placeholder="Exact" value={manualQ.numericTolerance} onChange={e => setManualQ({ ...manualQ, numericTolerance: e.target.value })} />
          </div>
        </div>
      );
    }

    if (t === QuestionType.DATE) {
      return (
        <div>
          <label className="block text-xs text-slate-500 mb-1">Correct date</label>
          <input type="date" className={inputCls} value={manualQ.dateValue} onChange={e => setManualQ({ ...manualQ, dateValue: e.target.value })} />
        </div>
      );
    }

    if (t === QuestionType.TIME) {
      return (
        <div>
          <label className="block text-xs text-slate-500 mb-1">Correct time</label>
          <input type="time" className={inputCls} value={manualQ.timeValue} onChange={e => setManualQ({ ...manualQ, timeValue: e.target.value })} />
        </div>
      );
    }

    if (t === QuestionType.MATCHING) {
      return (
        <div className="space-y-2">
          <label className="block text-xs text-slate-500">Match pairs — each left item pairs with the right item on the same row (shuffled for the candidate)</label>
          {manualQ.matchLeft.map((l, i) => (
            <div key={i} className="flex items-center gap-2">
              <input type="text" className={inputCls} placeholder={`Left ${i + 1}`} value={l} onChange={e => updateListField('matchLeft', i, e.target.value)} />
              <span className="text-slate-400">↔</span>
              <input type="text" className={inputCls} placeholder={`Right ${i + 1}`} value={manualQ.matchRight[i] || ''} onChange={e => updateListField('matchRight', i, e.target.value)} />
              <button type="button" className={smallBtn} aria-label={`Remove pair ${i + 1}`} onClick={() => { removeListItem('matchLeft', i); removeListItem('matchRight', i); }}>✕</button>
            </div>
          ))}
          <button type="button" className="text-xs text-blue-600 hover:underline" onClick={() => { addListItem('matchLeft'); addListItem('matchRight'); }}>+ Add pair</button>
        </div>
      );
    }

    if (t === QuestionType.ORDERING) {
      return (
        <div className="space-y-2">
          <label className="block text-xs text-slate-500">Items — enter them in the CORRECT order (shuffled for the candidate)</label>
          {manualQ.orderItems.map((it, i) => (
            <div key={i} className="flex items-center gap-2">
              <span className="text-xs text-slate-400 w-5">{i + 1}.</span>
              <input type="text" className={inputCls} placeholder={`Item ${i + 1}`} value={it} onChange={e => updateListField('orderItems', i, e.target.value)} />
              <button type="button" className={smallBtn} aria-label={`Remove item ${i + 1}`} onClick={() => removeListItem('orderItems', i)}>✕</button>
            </div>
          ))}
          <button type="button" className="text-xs text-blue-600 hover:underline" onClick={() => addListItem('orderItems')}>+ Add item</button>
        </div>
      );
    }

    if (t === QuestionType.DRAG_DROP) {
      const buckets = manualQ.dragBuckets;
      return (
        <div className="space-y-3">
          <div className="space-y-2">
            <label className="block text-xs text-slate-500">Buckets / drop zones</label>
            {buckets.map((b, i) => (
              <div key={i} className="flex items-center gap-2">
                <input type="text" className={inputCls} placeholder={`Bucket ${i + 1}`} value={b} onChange={e => updateListField('dragBuckets', i, e.target.value)} />
                <button type="button" className={smallBtn} aria-label={`Remove bucket ${i + 1}`} onClick={() => removeDragBucket(i)}>✕</button>
              </div>
            ))}
            <button type="button" className="text-xs text-blue-600 hover:underline" onClick={() => addListItem('dragBuckets')}>+ Add bucket</button>
          </div>
          <div className="space-y-2">
            <label className="block text-xs text-slate-500">Items — pick the correct bucket for each</label>
            {manualQ.dragItems.map((it, i) => (
              <div key={i} className="flex items-center gap-2">
                <input type="text" className={inputCls} placeholder={`Item ${i + 1}`} value={it} onChange={e => updateListField('dragItems', i, e.target.value)} />
                <select className="px-2 py-2 border rounded-lg text-sm bg-white" value={manualQ.dragItemBucket[i] ?? 0} onChange={e => {
                  const v = Number(e.target.value);
                  setManualQ(prev => { const arr = [...prev.dragItemBucket]; arr[i] = v; return { ...prev, dragItemBucket: arr }; });
                }}>
                  {buckets.map((bk, bi) => <option key={bi} value={bi}>{bk.trim() || `Bucket ${bi + 1}`}</option>)}
                </select>
                <button type="button" className={smallBtn} aria-label={`Remove item ${i + 1}`} onClick={() => removeDragItem(i)}>✕</button>
              </div>
            ))}
            <button type="button" className="text-xs text-blue-600 hover:underline" onClick={() => { addListItem('dragItems'); addListItem('dragItemBucket', 0); }}>+ Add item</button>
          </div>
        </div>
      );
    }

    return null;
  };

  // Compact read-only preview of a saved question's answer, shown in the builder list.
  const renderAddedQuestionAnswer = (q: Question) => {
    const optionTypes = [QuestionType.MCQ, QuestionType.MULTI_SELECT, QuestionType.TRUE_FALSE, QuestionType.YES_NO];
    if (optionTypes.includes(q.type) && q.options?.length) {
      const correct = new Set<number>(
        q.type === QuestionType.MULTI_SELECT
          ? (q.answerKey?.correctIndices || [])
          : (q.correctOptionIndex !== undefined && q.correctOptionIndex !== null ? [q.correctOptionIndex] : [])
      );
      return (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {q.options.map((opt, i) => (
            <div key={i} className={`text-sm p-2 rounded border ${correct.has(i) ? 'bg-teal-50 border-teal-200 text-teal-700' : 'bg-slate-50 border-slate-100 text-slate-600'}`}>
              <span className="font-bold mr-2">{String.fromCharCode(65 + i)}.</span>{opt}
            </div>
          ))}
        </div>
      );
    }
    let summary: string | null = null;
    switch (q.type) {
      case QuestionType.FILL_BLANK:
        summary = 'Answers: ' + (q.answerKey?.blanks || []).map(b => b.accepted.join(' / ')).join('  |  ');
        break;
      case QuestionType.NUMERIC:
        summary = `Answer: ${q.answerKey?.value}${q.answerKey?.tolerance != null ? ` ± ${q.answerKey.tolerance}` : ''}`;
        break;
      case QuestionType.DATE:
      case QuestionType.TIME:
        summary = `Answer: ${q.answerKey?.value}`;
        break;
      case QuestionType.MATCHING:
        summary = (q.matchOptions?.left || []).map((l, i) => `${l} ↔ ${q.matchOptions?.right?.[i] ?? ''}`).join('  |  ');
        break;
      case QuestionType.ORDERING:
        summary = 'Correct order: ' + (q.matchOptions?.items || []).join(' → ');
        break;
      case QuestionType.DRAG_DROP:
        summary = (q.matchOptions?.items || []).map((it, i) => `${it} → ${q.matchOptions?.buckets?.[q.answerKey?.placements?.[i] ?? 0] ?? ''}`).join('  |  ');
        break;
      case QuestionType.SHORT_TEXT:
      case QuestionType.LONG_TEXT:
        summary = 'Manually graded';
        break;
    }
    return summary ? <p className="text-xs text-slate-500 bg-slate-50 border border-slate-100 rounded p-2 whitespace-pre-wrap">{summary}</p> : null;
  };

  const removeQuestion = (id: string) => {
    setNewExam(prev => ({
      ...prev,
      questions: prev.questions?.filter(q => q.id !== id) || []
    }));
  };

  const getStudentIdsForBatchIds = (batchIds: number[]): string[] => {
    if (batchIds.length === 0) return [];
    return Array.from(new Set<string>(
      students
        .filter(student => student.batches.some(b => batchIds.includes(b.id)))
        .map(student => student.id)
    ));
  };

  const toggleBatch = (batchId: number) => {
    const current = newExam.assignedBatchIds || [];
    const nextBatchIds = current.includes(batchId)
      ? current.filter(id => id !== batchId)
      : [...current, batchId];

    // Students picked individually (CSV upload / create-and-assign) are NOT part of any selected batch,
    // so rebuilding the roster from the batch expansion alone would silently drop them. Keep everyone
    // who isn't a member of the batch just unchecked.
    const removedBatchIds = current.filter(id => !nextBatchIds.includes(id));
    const removedStudentIds = new Set(getStudentIdsForBatchIds(removedBatchIds));

    setNewExam(prev => {
      const kept = (prev.assignedStudentIds || []).filter(id => !removedStudentIds.has(id));
      return {
        ...prev,
        assignedBatchIds: nextBatchIds,
        assignedStudentIds: Array.from(new Set([...kept, ...getStudentIdsForBatchIds(nextBatchIds)])),
      };
    });
  };

  // Toggle a device class in the exam's allow-list. We never let the list become empty — that would
  // lock every candidate out — so unchecking the last remaining device is a no-op.
  const toggleDeviceType = (device: DeviceType) => {
    setNewExam(prev => {
      const current = prev.allowedDeviceTypes && prev.allowedDeviceTypes.length > 0
        ? prev.allowedDeviceTypes
        : (['desktop', 'tablet', 'mobile'] as DeviceType[]);
      const next = current.includes(device)
        ? current.filter(d => d !== device)
        : [...current, device];
      if (next.length === 0) return prev;
      return { ...prev, allowedDeviceTypes: next };
    });
  };

  const handleSaveExam = async () => {
    if (savingExam) return;
    if (!newExam.questions?.length) return;
    if (!newExam.title?.trim()) {
        alert("Please enter an exam title.");
        return;
    }
    if (isSuperAdmin && !effectiveCompanyId) {
        alert("Select a company first to create or edit an exam.");
        return;
    }
    if (!Number.isFinite(newExam.startTime) || !Number.isFinite(newExam.endTime)) {
        alert("Please set a valid start and end time.");
        return;
    }
    if (newExam.startTime! >= newExam.endTime!) {
        alert("End time must be after start time");
        return;
    }
    // The API rejects duration <= 0 (and truncates fractions), which used to surface only as the
    // generic "Failed to save" alert.
    const durationNum = Number(newExam.durationMinutes);
    if (!Number.isInteger(durationNum) || durationNum < 1) {
        alert("Duration must be a whole number of minutes (at least 1).");
        return;
    }

    // With sections on, the API persists ONLY the questions listed inside a section. A question whose
    // sectionId matches no section would be silently dropped while still counted in totalMarks, so
    // route any such orphan into the first section instead.
    const sectionIdSet = new Set(sections.map(s => s.id));
    const resolveSectionId = (q: Question) => (q.sectionId && sectionIdSet.has(q.sectionId) ? q.sectionId : sections[0]?.id);
    const sectionsPayload = useSections
      ? sections.map((section, idx) => ({
          id: section.id,
          title: section.title,
          displayOrder: idx,
          questionLimit: section.questionLimit ?? 0,
          shuffleQuestions: section.shuffleQuestions ?? true,
          timeLimitMinutes: section.timeLimitMinutes ?? 0,
          lockOnComplete: section.lockOnComplete ?? true,
          questions: (newExam.questions || []).filter(q => resolveSectionId(q) === section.id)
        }))
      : [];

    const payload: Exam = {
      ...(newExam as Exam),
      id: newExam.id || Math.random().toString(36).substr(2, 9),
      status: newExam.status || 'DRAFT',
      totalMarks: newExam.questions.reduce((sum, q) => sum + q.marks, 0),
      sections: sectionsPayload,
      assignedBatchIds: newExam.assignedBatchIds || [],
      // Union, not replacement: batch members PLUS anyone assigned individually. The server re-expands
      // the batches too, so students added to an assigned batch since the last save get picked up.
      assignedStudentIds: Array.from(new Set([
        ...(newExam.assignedStudentIds || []),
        ...getStudentIdsForBatchIds(newExam.assignedBatchIds || []),
      ])),
    };

    setSavingExam(true);
    try {
      const result = await apiPost<{ exam: Exam }>('exams.php', withCompany({ exam: payload }));
      const savedExam = result.exam || payload;
      onUpdateExams(prev => {
        const exists = prev.some(e => e.id === savedExam.id);
        return exists ? prev.map(e => (e.id === savedExam.id ? savedExam : e)) : [savedExam, ...prev];
      });
    } catch (e) {
      console.error(e);
      alert(`Failed to save exam: ${apiErrorMessage(e, 'the server did not accept the request. Please try again.')}`);
      return;
    } finally {
      setSavingExam(false);
    }

    resetForm();
  };

  const handleEditExam = (exam: Exam) => {
    const normalizedSections = (exam.sections || []).map((section, idx) => ({
      ...section,
      displayOrder: section.displayOrder ?? idx,
      questionLimit: section.questionLimit ?? 0,
      shuffleQuestions: section.shuffleQuestions ?? true,
      timeLimitMinutes: section.timeLimitMinutes ?? 0,
      lockOnComplete: section.lockOnComplete ?? true,
    }));
    const sectionMap = new Map<string, string>();
    if (normalizedSections.length > 0) {
      normalizedSections.forEach(section => {
        section.questions.forEach(q => {
          sectionMap.set(q.id, section.id);
        });
      });
    }
    const questionsWithSections = (exam.questions || []).map(q => ({
      ...q,
      sectionId: sectionMap.get(q.id)
    }));
    const editable: Partial<Exam> = {
        ...exam,
        sections: normalizedSections,
        assignedStudentIds: exam.assignedStudentIds || [],
        assignedBatchIds: exam.assignedBatchIds || [],
        questions: questionsWithSections,
        shuffleQuestions: exam.shuffleQuestions ?? true, // Default to true if undefined
        allowedDeviceTypes: exam.allowedDeviceTypes && exam.allowedDeviceTypes.length > 0
          ? exam.allowedDeviceTypes
          : ['desktop', 'tablet', 'mobile'],
        showResults: exam.showResults ?? false,
        certificateEnabled: exam.certificateEnabled ?? false,
        reconnectLimit: exam.reconnectLimit ?? 0,
        passPercent: exam.passPercent ?? 60,
        proctoringConfig: {
          ...defaultProctoringConfig,
          ...(exam.proctoringConfig || {}),
          tabSwitchLimit: Math.max(0, Number(exam.proctoringConfig?.tabSwitchLimit ?? defaultProctoringConfig.tabSwitchLimit)),
          violationLimits: {
            ...defaultViolationLimits,
            ...(exam.proctoringConfig?.violationLimits || {})
          },
          proctorTiming: {
            ...defaultProctorTiming,
            ...(exam.proctoringConfig?.proctorTiming || {})
          }
        },
        notificationConfig: exam.notificationConfig || {
        enabled: false,
        reminders: { hours24: true, hours1: true },
        customSubject: `Reminder: ${exam.title}`,
        customMessage: 'Please ensure your environment is ready 15 minutes before the exam starts.'
      }
    };
    setNewExam(editable);
    editorSnapshotRef.current = JSON.stringify(editable);
    if (exam.sections && exam.sections.length > 0) {
      setActiveSectionId(exam.sections[0].id);
    } else {
      setActiveSectionId(null);
    }
    setSelectedTemplateId(null);
    setIsCreating(true);
    setUploadStatus('IDLE');
    setCsvErrors([]);
  };

  const resetForm = () => {
    setIsCreating(false);
    setShowPreview(false);
    setActiveSectionId(null);
    setSelectedTemplateId(null);
    const fresh = buildExamDefaults();
    setNewExam(fresh);
    editorSnapshotRef.current = JSON.stringify(fresh);
    setUploadStatus('IDLE');
    setCsvErrors([]);
  };

  // Cancel used to drop every unsaved edit (a whole question paper) on a single misclick.
  const handleCancelEdit = () => {
    if (JSON.stringify(newExam) !== editorSnapshotRef.current
      && !confirm('Discard your unsaved changes to this exam?')) return;
    resetForm();
  };

  const handleDuplicateExam = async (source: Exam) => {
    if (duplicatingId) return;
    const makeId = () => Math.random().toString(36).substr(2, 9);
    const now = Date.now();
    const durationMs = (source.durationMinutes || 0) * 60000;
    const windowMs = source.startTime && source.endTime ? Math.max(source.endTime - source.startTime, durationMs) : durationMs;
    const startTime = now + 86400000;
    const endTime = startTime + (windowMs || durationMs || 3600000);

    const questionIdMap = new Map<string, string>();
    const sectionIdMap = new Map<string, string>();

    (source.questions || []).forEach(q => questionIdMap.set(q.id, makeId()));
    (source.sections || []).forEach(section => {
      sectionIdMap.set(section.id, makeId());
      (section.questions || []).forEach(q => {
        if (!questionIdMap.has(q.id)) questionIdMap.set(q.id, makeId());
      });
    });

    const clonedSections = (source.sections || []).map((section, idx) => {
      const newSectionId = sectionIdMap.get(section.id) || makeId();
      return {
        ...section,
        id: newSectionId,
        displayOrder: section.displayOrder ?? idx,
        questions: (section.questions || []).map(q => ({
          ...q,
          id: questionIdMap.get(q.id) || makeId(),
          sectionId: newSectionId
        }))
      };
    });

    const clonedQuestions = clonedSections.length > 0
      ? clonedSections.flatMap(section => section.questions.map(q => ({ ...q, sectionId: section.id })))
      : (source.questions || []).map(q => ({
          ...q,
          id: questionIdMap.get(q.id) || makeId()
        }));

    const payload: Exam = {
      ...source,
      id: makeId(),
      title: `Copy of ${source.title}`,
      status: 'DRAFT',
      startTime,
      endTime,
      questions: clonedQuestions,
      sections: clonedSections,
      totalMarks: clonedQuestions.reduce((sum, q) => sum + (q.marks || 0), 0),
      assignedStudentIds: [],
      assignedBatchIds: [],
      // Server-computed roster counters and per-exam mail overrides belong to the SOURCE exam. The
      // API echoes the payload back, so spreading them made the brand-new, unassigned copy show the
      // source's "N to invite" / "N not attempted" badges and mail template until the next reload.
      pendingInviteCount: 0,
      notAttemptedCount: 0,
      mailTemplates: {},
      notificationConfig: {
        enabled: false,
        reminders: source.notificationConfig?.reminders || { hours24: false, hours1: false },
        customSubject: source.notificationConfig?.customSubject || '',
        customMessage: source.notificationConfig?.customMessage || '',
      }
    };

    setDuplicatingId(source.id);
    try {
      const result = await apiPost<{ exam: Exam }>('exams.php', withCompany({ exam: payload }));
      const savedExam = result.exam || payload;
      onUpdateExams(prev => [savedExam, ...prev]);
    } catch (e) {
      console.error(e);
      alert(`Failed to duplicate exam: ${apiErrorMessage(e, 'please try again.')}`);
    } finally {
      setDuplicatingId(null);
    }
  };

  const handleDeleteExam = (exam: Exam) => {
    setDeleteTarget(exam);
  };

  const handleArchiveExam = async () => {
    if (!deleteTarget || deleteBusy) return;
    setDeleteBusy(true);
    try {
      // Status-only ARCHIVE action rather than re-POSTing the whole exam: the full upsert rewrites
      // every question/section/assignment row just to flip a flag, and it re-validates the schedule,
      // so a legacy exam with a bad window (end <= start, 0 duration) could never be archived.
      await apiPost('exams.php', withCompany({ action: 'ARCHIVE', id: deleteTarget.id }));
      // Keep it in state as ARCHIVED (what a reload returns too); the grid hides archived exams.
      onUpdateExams(prev => prev.map(e => (e.id === deleteTarget.id ? { ...e, status: 'ARCHIVED' } : e)));
    } catch (e) {
      console.error('Failed to archive exam:', e);
      alert(`Failed to archive exam: ${apiErrorMessage(e, 'please try again.')}`);
    } finally {
      setDeleteBusy(false);
      setDeleteTarget(null);
    }
  };

  const handlePermanentDeleteExam = async () => {
    if (!deleteTarget || deleteBusy) return;
    // exam_sessions (and through them session_answers / violation_logs) are ON DELETE CASCADE from
    // exams, so this wipes every candidate's attempt and result for the exam — irreversibly.
    if (!confirm(`Permanently delete "${deleteTarget.title}"?\n\nThis also erases every candidate attempt, answer, violation log and result recorded for this exam. It cannot be undone — choose Archive instead to keep them.`)) return;
    setDeleteBusy(true);
    try {
      await apiPost('exams.php', withCompany({ action: 'DELETE', id: deleteTarget.id, permanent: true }));
      onUpdateExams(prev => prev.filter(e => e.id !== deleteTarget.id));
    } catch (e) {
      console.error('Failed to delete exam permanently:', e);
      alert(`Failed to delete exam permanently: ${apiErrorMessage(e, 'please try again.')}`);
    } finally {
      setDeleteBusy(false);
      setDeleteTarget(null);
    }
  };

  // --- Email System Logic ---
  // Resolve the real recipients for an exam. When students are explicitly assigned we fetch them
  // from the server so cross-company assignments (a super admin can pick batches from any company)
  // carry each student's OWN companyId — the local `students` prop only holds one company. With no
  // assignments the exam goes to every locally-loaded student, as before.
  // invitedAt is null for students assigned since the last invitation run — the only ones who still
  // need a link. Students loaded from the local list (exam with no explicit assignment = everyone)
  // have never been tracked, so they count as uninvited.
  const resolveRecipients = async (exam: Exam, requireTokens = false): Promise<ExamRecipient[]> => {
    let recipients: ExamRecipient[];
    if (exam.assignedStudentIds && exam.assignedStudentIds.length > 0) {
      const data = await apiGet<{ recipients: ExamRecipient[] }>(`exams.php?recipients=${encodeURIComponent(exam.id)}`);
      recipients = data?.recipients || [];
    } else {
      const fallbackCompany = getAdminCompanyId();
      // No assignment list means "every student", so the enriched recipients payload doesn't apply —
      // pull the exam's attempt map separately so the composer can still target non-attempters.
      let attempts: Record<string, { attemptCount: number; attemptStatus: ExamRecipient['attemptStatus']; completed: boolean; lastAttemptAt: number | null }> = {};
      try {
        const data = await apiGet<{ attempts: typeof attempts }>(`exams.php?attempts=${encodeURIComponent(exam.id)}`);
        attempts = data?.attempts || {};
      } catch (e) {
        // Attempt data is an audience filter, not a send requirement — a failure here must not block
        // an invitation going out, so fall back to treating everyone as not-yet-attempted.
        console.error('Could not load attempt status for this exam:', e);
      }
      recipients = students.map(s => ({
        id: s.id,
        fullName: s.fullName,
        email: s.email,
        registrationId: s.registrationId,
        companyId: s.companyId ?? fallbackCompany,
        invitedAt: null,
        attemptCount: attempts[s.id]?.attemptCount ?? 0,
        attemptStatus: attempts[s.id]?.attemptStatus ?? 'NOT_STARTED',
        completed: attempts[s.id]?.completed ?? false,
        lastAttemptAt: attempts[s.id]?.lastAttemptAt ?? null,
      }));
    }
    // Only invitation emails and CSV export need a ?token= link; reminders carry none, so skip the
    // mint round-trip entirely for them. When links ARE needed we ask the server to mint SIGNED
    // access tokens — the browser can't sign (no secret), so a client-built token would be forgeable,
    // which is what stops a candidate editing their link to impersonate another student.
    if (requireTokens && recipients.length > 0) {
      // Let a mint failure propagate to the caller, which alerts and aborts. Silently returning
      // token-less recipients would ship invitations/CSV rows with an empty (useless) link.
      recipients = await mintAccessTokens(exam, recipients);
    }
    return recipients;
  };

  // Ask the server to mint SIGNED access tokens for exactly these recipients. Throws if any token is
  // missing so a caller never mails an invitation with an empty (useless) link.
  const mintAccessTokens = async (exam: Exam, recipients: ExamRecipient[]): Promise<ExamRecipient[]> => {
    if (recipients.length === 0) return recipients;
    const { tokens } = await apiPost<{ tokens: Record<string, string> }>('exams.php', {
      action: 'MINT_ACCESS_TOKENS',
      examId: exam.id,
      studentIds: recipients.map(r => r.id),
    });
    const withTokens = recipients.map(r => ({ ...r, token: tokens?.[r.id] }));
    const missing = withTokens.filter(r => !r.token);
    if (missing.length > 0) {
      throw new Error(
        `Could not generate secure exam links for ${missing.length} recipient(s). Nothing was sent — please try again.`
      );
    }
    return withTokens;
  };

  // The card's one-click "Notify" invitation blast. Reminders (and any targeted send) go through the
  // Mail Composer instead, which is where the audience and the copy are chosen.
  const handleSendEmail = async (exam: Exam) => {
    setEmailSendingId(exam.id);
    setSendingMode('notify');

    let recipients: ExamRecipient[] = [];
    try {
      // Invitations need signed links, so mint them up front.
      recipients = await resolveRecipients(exam, true);
    } catch (e: any) {
      console.error(e);
      alert(apiErrorMessage(e, 'Failed to load the recipient list for this exam.'));
      return;
    } finally {
      setEmailSendingId(null);
      setSendingMode(null);
    }

    if (recipients.length === 0) {
      alert('No recipients found for this exam. Assign students or batches first.');
      return;
    }

    const pending = recipients.filter(r => !r.invitedAt);

    // Mixed roster — students were added after the exam went out. Re-mailing everyone would push a
    // duplicate invitation at candidates who may already be sitting the exam, so make it a choice.
    if (pending.length > 0 && pending.length < recipients.length) {
      setInviteScopeTarget({ exam, recipients, pending });
      return;
    }

    // When every student already has a link, say so — the old prompt read like a first send and made
    // it easy to re-mail a whole roster that may already be sitting the exam.
    const confirmText = pending.length === 0
      ? `All ${recipients.length} assigned students have already been sent a link. Resend the same invitation to all of them?`
      : `Are you sure you want to send exam invitations to ${recipients.length} students?`;
    if (!confirm(confirmText)) return;
    await dispatchEmails(exam, recipients, false);
  };

  const dispatchEmails = async (
    exam: Exam,
    targetStudents: ExamRecipient[],
    reminder: boolean,
    override?: { subject?: string; message?: string },
  ) => {
    setEmailSendingId(exam.id);
    setSendingMode(reminder ? 'reminder' : 'notify');

    try {
        const messages = targetStudents.map(student => {
          // Reminder emails carry the exam details only — no access link/token.
          // The token is minted+signed server-side (resolveRecipients); we never build it here.
          let link = '';
          if (!reminder && student.token) {
            link = `${window.location.origin}?token=${student.token}`;
          }

          const { subject, body } = buildExamEmailContent(exam, student.fullName, link, reminder, override);

          // Normalise the address — emails typed in ALL CAPS or Mixed Case go to the
          // same mailbox, so send to the correctly-formatted lowercase address.
          // Instructions are linked in the body (instructionsBlock), not attached — see above.
          return { to: student.email.trim().toLowerCase(), subject, body };
        });

        // withCompany: notify.php scopes SMTP + delivery logs by company, like every other write here;
        // without it a super admin's send was rejected ("companyId is required") or logged under
        // whichever company the top bar happened to hold.
        const result = await apiPost<{ sent: number; failed?: { to: string; error: string }[] }>('notify.php', withCompany({ messages }));

        // Record who actually received a link. Addresses that bounced stay uninvited so the next send
        // retries them instead of quietly leaving those students without a way in.
        if (!reminder) {
          const failedTo = new Set((result.failed || []).map(f => (f.to || '').trim().toLowerCase()));
          const deliveredIds = targetStudents
            .filter(s => !failedTo.has(s.email.trim().toLowerCase()))
            .map(s => s.id);
          if (deliveredIds.length > 0) {
            try {
              await apiPost('exams.php', withCompany({ action: 'MARK_INVITED', examId: exam.id, studentIds: deliveredIds }));
              onUpdateExams(prev => prev.map(e => e.id === exam.id
                ? { ...e, pendingInviteCount: Math.max(0, (e.pendingInviteCount ?? 0) - deliveredIds.length) }
                : e));
            } catch (err) {
              console.error('Invitations were sent but could not be recorded:', err);
            }
          }
        }

        if (result.failed && result.failed.length > 0) {
          alert(`Sent ${result.sent} emails. Failed: ${result.failed.length}. Check server response for details.`);
        } else {
          alert(`Success! ${reminder ? 'Reminders' : 'Invitations'} sent to ${result.sent} students.`);
        }
    } catch (e) {
        console.error(e);
        alert("Failed to send emails. Please try again.");
    } finally {
        setEmailSendingId(null);
        setSendingMode(null);
    }
  };

  // --- Mail Composer ---
  // Opens the per-exam composer, seeded with that exam's saved template (or the built-in default) and
  // with the recipient list loaded in the background so audience counts are live.
  const openMailComposer = async (exam: Exam, kind: ExamMailKind) => {
    const tpl = resolveExamMailTemplate(exam, kind === 'REMINDER');
    setMailComposer({
      exam,
      kind,
      subject: tpl.subject,
      message: tpl.message,
      // A reminder exists to chase people who haven't sat the exam; an invitation defaults to the
      // students who have never been sent a link.
      audience: kind === 'REMINDER' ? 'NOT_ATTEMPTED' : 'NOT_INVITED',
      recipients: [],
      loading: true,
      saving: false,
      dirty: false,
      error: null,
      notice: null,
    });

    try {
      // Tokens are minted at send time for the filtered audience only, so skip them here.
      const recipients = await resolveRecipients(exam, false);
      setMailComposer(prev => (prev && prev.exam.id === exam.id ? { ...prev, recipients, loading: false } : prev));
    } catch (e: any) {
      console.error(e);
      setMailComposer(prev => (prev && prev.exam.id === exam.id
        ? { ...prev, loading: false, error: apiErrorMessage(e, 'Failed to load the recipient list for this exam.') }
        : prev));
    }
  };

  // Closing (X / Cancel / Escape) used to drop an edited subject/message without a word, while
  // switching kinds below already asked first — ask on close too. Not while a save/mint is running.
  const closeComposer = () => {
    if (!mailComposer || mailComposer.saving) return;
    if (mailComposer.dirty && !confirm('Discard your unsaved changes to this email?')) return;
    setMailComposer(null);
  };

  // Switching between Invitation and Reminder swaps in that kind's template. Unsaved edits would be
  // lost, so confirm first.
  const switchComposerKind = (kind: ExamMailKind) => {
    setMailComposer(prev => {
      if (!prev || prev.kind === kind) return prev;
      if (prev.dirty && !confirm('Discard your unsaved changes to this email?')) return prev;
      const tpl = resolveExamMailTemplate(prev.exam, kind === 'REMINDER');
      return { ...prev, kind, subject: tpl.subject, message: tpl.message, dirty: false, notice: null };
    });
  };

  // Persist the composed subject/message as this exam's default for that kind, so the next send (and
  // the next admin) starts from it. Sending does NOT require saving.
  const saveComposerTemplate = async () => {
    const composer = mailComposer;
    if (!composer) return;
    setMailComposer(prev => (prev ? { ...prev, saving: true, notice: null, error: null } : prev));
    try {
      await apiPost('exams.php', withCompany({
        action: 'SAVE_MAIL_TEMPLATE',
        examId: composer.exam.id,
        kind: composer.kind,
        subject: composer.subject,
        message: composer.message,
      }));
      onUpdateExams(prev => prev.map(e => (e.id === composer.exam.id
        ? { ...e, mailTemplates: { ...(e.mailTemplates || {}), [composer.kind]: { subject: composer.subject, message: composer.message } } }
        : e)));
      setMailComposer(prev => (prev ? { ...prev, saving: false, dirty: false, notice: 'Saved as this exam’s default email.' } : prev));
    } catch (e: any) {
      console.error(e);
      setMailComposer(prev => (prev ? { ...prev, saving: false, error: apiErrorMessage(e, 'Could not save this email template.') } : prev));
    }
  };

  // Clear the saved override and go back to the built-in default copy.
  const resetComposerTemplate = async () => {
    const composer = mailComposer;
    if (!composer) return;
    if (!confirm('Reset this email back to the built-in default text?')) return;
    setMailComposer(prev => (prev ? { ...prev, saving: true, notice: null, error: null } : prev));
    try {
      await apiPost('exams.php', withCompany({
        action: 'SAVE_MAIL_TEMPLATE',
        examId: composer.exam.id,
        kind: composer.kind,
        subject: '',
        message: '',
      }));
      const bare: Exam = { ...composer.exam, mailTemplates: {}, notificationConfig: undefined };
      const tpl = resolveExamMailTemplate(bare, composer.kind === 'REMINDER');
      onUpdateExams(prev => prev.map(e => {
        if (e.id !== composer.exam.id) return e;
        const next = { ...(e.mailTemplates || {}) };
        delete next[composer.kind];
        return { ...e, mailTemplates: next };
      }));
      setMailComposer(prev => (prev
        ? { ...prev, saving: false, dirty: false, subject: tpl.subject, message: tpl.message, notice: 'Restored the default email.' }
        : prev));
    } catch (e: any) {
      console.error(e);
      setMailComposer(prev => (prev ? { ...prev, saving: false, error: apiErrorMessage(e, 'Could not reset this email template.') } : prev));
    }
  };

  const sendFromComposer = async () => {
    const composer = mailComposer;
    if (!composer) return;

    const targets = filterByAudience(composer.recipients, composer.audience);
    if (targets.length === 0) {
      alert('No students match the selected audience, so there is nothing to send.');
      return;
    }
    if (composer.subject.trim() === '' || composer.message.trim() === '') {
      alert('Please provide both a subject and a message before sending.');
      return;
    }

    const kindLabel = composer.kind === 'REMINDER' ? 'reminder' : 'invitation';
    if (!confirm(`Send this ${kindLabel} to ${targets.length} student${targets.length === 1 ? '' : 's'}?`)) return;

    // Only invitations carry an access link, so only they need signed tokens — and only for the
    // filtered audience, not the whole roster.
    let sendTargets = targets;
    if (composer.kind === 'INVITE') {
      setMailComposer(prev => (prev ? { ...prev, saving: true, error: null } : prev));
      try {
        sendTargets = await mintAccessTokens(composer.exam, targets);
      } catch (e: any) {
        console.error(e);
        setMailComposer(prev => (prev ? { ...prev, saving: false, error: apiErrorMessage(e, 'Could not generate secure exam links. Nothing was sent.') } : prev));
        return;
      }
    }

    setMailComposer(null);
    await dispatchEmails(composer.exam, sendTargets, composer.kind === 'REMINDER', {
      subject: composer.subject,
      message: composer.message,
    });
  };

  // --- Link Generation & Export ---
  const handleExportLinks = async (exam: Exam) => {
    if (exportingLinksId) return;
    // CSV Header
    const csvRows = [
      ["Student Name", "Registration ID", "Email", "Exam Link", "Valid From", "Valid Until", "Invite Status"]
    ];

    // Resolve recipients server-side so cross-company assignments carry each student's own companyId.
    // requireTokens=true: a mint failure throws here rather than exporting rows with empty links.
    let targetStudents: ExamRecipient[];
    setExportingLinksId(exam.id);
    try {
      targetStudents = await resolveRecipients(exam, true);
    } catch (e: any) {
      console.error(e);
      alert(apiErrorMessage(e, 'Failed to generate exam links for export.'));
      return;
    } finally {
      setExportingLinksId(null);
    }

    if (targetStudents.length === 0) {
      alert('No recipients found for this exam. Assign students or batches first.');
      return;
    }

    targetStudents.forEach(student => {
      // The signed token is minted server-side (resolveRecipients, validated non-empty above). Never
      // build it client-side — an unsigned token would be forgeable and defeat impersonation protection.
      const link = `${window.location.origin}?token=${student.token}`;

      // Lets an admin filter the sheet down to students who were added after the invitations went out.
      const inviteStatus = student.invitedAt
        ? `Sent ${formatScheduleShort(student.invitedAt, resolveExamTimezone(exam.timezone))}`
        : 'Not sent';

      csvRows.push([
        csvCell(student.fullName),
        csvCell(student.registrationId),
        csvCell(student.email),
        csvCell(link),
        csvCell(formatScheduleShort(exam.startTime, resolveExamTimezone(exam.timezone))),
        csvCell(formatScheduleShort(exam.endTime, resolveExamTimezone(exam.timezone))),
        csvCell(inviteStatus)
      ]);
    });

    const encodedUri = csvDataUri(csvRows.map(e => e.join(",")).join("\n"));
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    link.setAttribute("download", `${exam.title.replace(/\s+/g, '_')}_Links.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  // --- Bulk Upload Logic (Questions) ---
  const downloadTemplate = () => {
    // 10 columns; the trailing Word Limit and Negative Marks are optional. An 11th "Section"
    // column is appended ONLY when Sections is switched on for this exam. The Option/Correct
    // columns are reused per type (see the '#' guide rows below — import skips lines starting with '#').
    const headers = "Type,Question Text,Option A,Option B,Option C,Option D,Correct Option,Marks,Word Limit,Negative Marks"
      + (useSections ? ",Section\n" : "\n");
    const guide = [
      "# ---------------------------------------------------------------------------------------------",
      "# HOW TO USE: one question per row. The '#' guide rows are skipped on import (delete if you like).",
      "# Supported types: MCQ, MULTI_SELECT, TRUE_FALSE, YES_NO, SHORT_TEXT, LONG_TEXT, FILL_BLANK,",
      "#   NUMERIC, DATE, TIME.  (MATCHING / ORDERING / DRAG_DROP: use the editor or JSON import.)",
      "# Column usage by type:",
      "#   MCQ          -> Option A-D = choices; Correct Option = 1-4 (single).",
      "#   MULTI_SELECT -> Option A-D = choices; Correct Option = comma list of numbers e.g. \"\"1,3\"\".",
      "#   TRUE_FALSE   -> options auto; Correct Option = True or False (or 1/2). Leave A-D blank.",
      "#   YES_NO       -> options auto; Correct Option = Yes or No (or 1/2). Leave A-D blank.",
      "#   SHORT_TEXT   -> manual grade; only Question Text + Marks needed.",
      "#   LONG_TEXT    -> manual grade; Word Limit optional (blank = no limit).",
      "#   FILL_BLANK   -> one blank per Option cell (A,B,...); alternates separated by | e.g. paris|Paris.",
      "#   NUMERIC      -> Option A = expected value; Option B = optional +/- tolerance (blank = exact).",
      "#   DATE         -> Option A = answer as YYYY-MM-DD.",
      "#   TIME         -> Option A = answer as HH:MM (24-hour).",
      "# Negative Marks: deducted if the question is answered but wrong (blank/0 = no penalty).",
      "#   Fractions are allowed, e.g. 0.25 or 0.5.",
      "#   Ignored for SHORT_TEXT / LONG_TEXT, which are graded manually.",
      ...(useSections ? [
        "# Section: which section this question goes into. Use its position (1, 2, 3, ...) below,",
        "#   or its exact title. Leave blank to use whichever section is currently \"Active\".",
        `#   Your sections: ${sections.map((s, i) => `${i + 1}=${s.title}`).join(', ') || '(none yet — add one above first)'}`,
      ] : []),
      "# ---------------------------------------------------------------------------------------------",
    ].join("\n") + "\n";
    // Round-robins sample rows across the real sections (1,2,3,1,2,...) so the template actually
    // demonstrates a multi-section upload; falls back to no column at all when sections are off.
    const withSection = (row: string, n: number): string =>
      useSections ? `${row},${sections.length > 0 ? (n % sections.length) + 1 : 1}` : row;
    const samples = [
      withSection('MCQ,"What is the capital of France?",Berlin,London,Paris,Madrid,3,5,,1', 0),
      withSection('MULTI_SELECT,"Which of these are prime numbers?",2,4,5,9,"1,3",5,,1', 1),
      withSection('TRUE_FALSE,"The Earth orbits the Sun.",,,,,True,2,,', 2),
      withSection('YES_NO,"Is water a compound?",,,,,Yes,2,,', 0),
      withSection('SHORT_TEXT,"Name the first President of the United States.",,,,,,3,,', 1),
      withSection('LONG_TEXT,"Explain the concept of recursion in your own words.",,,,,,10,150,', 2),
      withSection('FILL_BLANK,"___ is the capital of France and ___ is the capital of Japan.",paris|Paris,tokyo|Tokyo,,,,5,,', 0),
      withSection('NUMERIC,"What is 15 divided by 4? (round to 2 decimals)",3.75,0.01,,,,4,,', 1),
      withSection('DATE,"On what date did India gain independence?",1947-08-15,,,,,3,,', 2),
      withSection('TIME,"At what time (24h) does solar noon occur (approx)?",12:00,,,,,2,,', 0),
    ].join("\n");
    // csvDataUri escapes '#': with encodeURI every '#' guide row (and all samples after it) was cut off.
    const encodedUri = csvDataUri(headers + guide + samples);
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    link.setAttribute("download", "exam_questions_template.csv");
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  // Robust CSV Line Parser (Handles quoted strings containing commas)
  const parseCSVLine = (text: string): string[] => {
    const result: string[] = [];
    let start = 0;
    let inQuotes = false;
    for (let i = 0; i < text.length; i++) {
      if (text[i] === '"') { 
        inQuotes = !inQuotes; 
      } else if (text[i] === ',' && !inQuotes) {
        let field = text.substring(start, i).trim();
        // Remove surrounding quotes and unescape double quotes
        if (field.startsWith('"') && field.endsWith('"')) {
          field = field.slice(1, -1).replace(/""/g, '"');
        }
        result.push(field);
        start = i + 1;
      }
    }
    // Push last field
    let lastField = text.substring(start).trim();
    if (lastField.startsWith('"') && lastField.endsWith('"')) {
      lastField = lastField.slice(1, -1).replace(/""/g, '"');
    }
    result.push(lastField);
    return result;
  };

  const downloadStudentTemplate = () => {
    const headers = 'Full Name,Email,Registration ID\n';
    const sample = '"Ada Lovelace",ada@example.com,REG-1001\n';
    const encodedUri = csvDataUri(headers + sample);
    const link = document.createElement('a');
    link.setAttribute('href', encodedUri);
    link.setAttribute('download', 'exam_students_template.csv');
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const parseCSV = (text: string) => {
    const lines = text.split('\n');
    const questions: Question[] = [];
    const errors: CsvError[] = [];

    // Skip header row (index 0)
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      // Lines beginning with '#' are template instructions/comments — skip them.
      if (line.startsWith('#')) continue;

      const cols = parseCSVLine(line);

      // Basic structure validation
      if (cols.length < 8) {
        errors.push({ row: i + 1, message: `Insufficient columns. Expected 8, got ${cols.length}.`, rawData: line });
        continue;
      }

      // The 9th "WordLimit", 10th "Negative Marks" and 11th "Section" columns are all OPTIONAL,
      // so CSVs written before any of these features still import.
      const [typeRaw, qText, optA, optB, optC, optD, correctStr, marksStr, wordLimitStr, negativeMarksStr, sectionStr] = cols;
      // Number (not parseInt) so "2.5" or "5 pts" is rejected instead of silently becoming 2 / 5 —
      // marks are whole numbers end to end (INT column, all-or-nothing grading).
      const marks = Number((marksStr ?? '').trim());
      const wordLimitTrim = (wordLimitStr ?? '').trim();
      const wordLimit = parseInt(wordLimitTrim, 10);
      const negativeMarksTrim = (negativeMarksStr ?? '').trim();
      // parseFloat (not parseInt) — negative marking supports fractions like 0.5 or 0.25.
      const negativeMarksVal = parseFloat(negativeMarksTrim);

      // Resolve which section this row belongs to — only meaningful when Sections is switched
      // on. A number picks a section by position (1-based, matching the template's guide);
      // any other text must match a section title exactly (case-insensitive). Blank falls back
      // to whichever section is currently "Active" in the editor above.
      let rowSectionId: string | undefined;
      if (useSections) {
        const sectionTrim = (sectionStr ?? '').trim();
        if (sectionTrim === '') {
          rowSectionId = activeSectionId || sections[0]?.id;
        } else if (/^\d+$/.test(sectionTrim)) {
          const sectionIdx = parseInt(sectionTrim, 10) - 1;
          if (sectionIdx < 0 || sectionIdx >= sections.length) {
            errors.push({ row: i + 1, message: `Section ${sectionTrim} doesn't exist — this exam has ${sections.length} section(s) (1-${sections.length}).`, rawData: line });
            continue;
          }
          rowSectionId = sections[sectionIdx].id;
        } else {
          const matchedSection = sections.find(s => s.title.trim().toLowerCase() === sectionTrim.toLowerCase());
          if (!matchedSection) {
            errors.push({ row: i + 1, message: `Section "${sectionTrim}" not found. Use a position number (1-${sections.length}) or an exact section title.`, rawData: line });
            continue;
          }
          rowSectionId = matchedSection.id;
        }
      }

      // Normalise the type: uppercase and strip spaces / _ / - / slashes so "Multi Select",
      // "MULTI_SELECT", "true/false", "Fill-Blank" all resolve to the same canonical type.
      const type = CSV_TYPE_ALIASES[typeRaw.toUpperCase().replace(/[\s_\-/]/g, '')];

      // Validate Marks
      if ((marksStr ?? '').trim() === '' || !Number.isInteger(marks) || marks <= 0) {
        errors.push({ row: i + 1, message: "Invalid marks. Must be a positive whole number.", rawData: line });
        continue;
      }

      // Validate Question Text
      if (!qText) {
        errors.push({ row: i + 1, message: "Question text is empty.", rawData: line });
        continue;
      }

      if (!type) {
        const normalized = typeRaw.toUpperCase().replace(/[\s_\-/]/g, '');
        if (['MATCHING', 'ORDERING', 'DRAGDROP'].includes(normalized)) {
          errors.push({ row: i + 1, message: `"${typeRaw}" can't be imported from CSV — add Matching/Ordering/Drag-Drop questions in the editor or via JSON import.`, rawData: line });
        } else {
          errors.push({ row: i + 1, message: `Invalid Type "${typeRaw}". Supported: MCQ, MULTI_SELECT, TRUE_FALSE, YES_NO, SHORT_TEXT, LONG_TEXT, FILL_BLANK, NUMERIC, DATE, TIME.`, rawData: line });
        }
        continue;
      }

      // Negative marks (deducted if answered but wrong) is optional; blank/0 = no penalty.
      if (negativeMarksTrim !== '' && (isNaN(negativeMarksVal) || negativeMarksVal < 0)) {
        errors.push({ row: i + 1, message: "Negative marks must be a non-negative number (or left blank for none).", rawData: line });
        continue;
      }
      const resolvedNegativeMarks = negativeMarksVal > 0 ? negativeMarksVal : 0;
      const base = { id: Math.random().toString(36).substr(2, 9), text: qText, marks, negativeMarks: resolvedNegativeMarks, sectionId: rowSectionId };
      // Word limit is only meaningful for free-text types; validate it when supplied.
      if (wordLimitTrim !== '' && (isNaN(wordLimit) || wordLimit <= 0)) {
        errors.push({ row: i + 1, message: "Word limit must be a positive number (or left blank for no limit).", rawData: line });
        continue;
      }
      const resolvedWordLimit = wordLimit > 0 ? wordLimit : null;

      // Contiguous options run (A..D up to the last filled cell); used by MCQ / MULTI_SELECT.
      const optCells = [optA, optB, optC, optD].map(c => (c ?? '').trim());
      const lastFilled = optCells.reduce((acc, c, idx) => (c ? idx : acc), -1);
      const options = lastFilled >= 0 ? optCells.slice(0, lastFilled + 1) : [];
      const hasGap = options.some(o => !o);

      if (type === QuestionType.MCQ) {
        const correctVal = parseInt(correctStr);
        if (options.length !== 4 || hasGap) {
          errors.push({ row: i + 1, message: "MCQ requires all 4 options to be filled.", rawData: line });
          continue;
        }
        if (isNaN(correctVal) || correctVal < 1 || correctVal > 4) {
          errors.push({ row: i + 1, message: "Correct Option must be between 1 and 4 for MCQ.", rawData: line });
          continue;
        }
        questions.push({ ...base, type, options, correctOptionIndex: correctVal - 1 });

      } else if (type === QuestionType.MULTI_SELECT) {
        if (options.length < 2 || hasGap) {
          errors.push({ row: i + 1, message: "Multi-Select needs at least 2 options filled in order (Option A, B, ...).", rawData: line });
          continue;
        }
        const picks = correctStr.split(/[,;\s]+/).map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
        const indices = Array.from(new Set(picks.map(n => n - 1))).sort((a, b) => a - b);
        if (indices.length < 1 || indices.some(idx => idx < 0 || idx >= options.length)) {
          errors.push({ row: i + 1, message: `Correct Option for Multi-Select must be a list of option numbers (e.g. "1,3") within 1-${options.length}.`, rawData: line });
          continue;
        }
        questions.push({ ...base, type, options, answerKey: { correctIndices: indices } });

      } else if (type === QuestionType.TRUE_FALSE || type === QuestionType.YES_NO) {
        const opts = type === QuestionType.TRUE_FALSE ? ['True', 'False'] : ['Yes', 'No'];
        const c = correctStr.trim().toUpperCase();
        const firstWords = type === QuestionType.TRUE_FALSE ? ['1', 'TRUE', 'T'] : ['1', 'YES', 'Y'];
        const secondWords = type === QuestionType.TRUE_FALSE ? ['2', 'FALSE', 'F'] : ['2', 'NO', 'N'];
        const correctOptionIndex = firstWords.includes(c) ? 0 : secondWords.includes(c) ? 1 : -1;
        if (correctOptionIndex < 0) {
          errors.push({ row: i + 1, message: `Correct Option for ${type} must be "${opts[0]}" or "${opts[1]}" (or 1/2).`, rawData: line });
          continue;
        }
        questions.push({ ...base, type, options: opts, correctOptionIndex });

      } else if (type === QuestionType.SHORT_TEXT || type === QuestionType.LONG_TEXT || type === QuestionType.TEXT) {
        // Manually graded — a negative-marks column value here would never be applied, so drop it.
        questions.push({ ...base, type, negativeMarks: 0, wordLimit: resolvedWordLimit });

      } else if (type === QuestionType.FILL_BLANK) {
        // Each filled Option cell is one blank; alternates within a blank are separated by "|".
        const blanks = [optA, optB, optC, optD]
          .map(c => (c ?? '').trim())
          .filter(Boolean)
          .map(cell => ({ accepted: cell.split('|').map(s => s.trim()).filter(Boolean) }));
        if (blanks.length === 0 || blanks.some(b => b.accepted.length === 0)) {
          errors.push({ row: i + 1, message: "Fill-Blank needs at least one accepted answer per blank (put each blank in Option A, B, ...; separate alternates with |).", rawData: line });
          continue;
        }
        questions.push({ ...base, type, answerKey: { blanks } });

      } else if (type === QuestionType.NUMERIC) {
        // Option A = expected value, Option B = optional ± tolerance.
        const value = Number((optA ?? '').trim());
        if ((optA ?? '').trim() === '' || isNaN(value)) {
          errors.push({ row: i + 1, message: "Numeric requires an expected value in Option A.", rawData: line });
          continue;
        }
        const tolRaw = (optB ?? '').trim();
        const tolerance = tolRaw === '' ? null : Number(tolRaw);
        if (tolerance !== null && (isNaN(tolerance) || tolerance < 0)) {
          errors.push({ row: i + 1, message: "Numeric tolerance (Option B) must be a non-negative number, or left blank.", rawData: line });
          continue;
        }
        questions.push({ ...base, type, answerKey: { value, tolerance } });

      } else if (type === QuestionType.DATE) {
        const value = (optA ?? '').trim();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
          errors.push({ row: i + 1, message: "Date answer (Option A) must be in YYYY-MM-DD format.", rawData: line });
          continue;
        }
        questions.push({ ...base, type, answerKey: { value } });

      } else if (type === QuestionType.TIME) {
        const raw = (optA ?? '').trim();
        const m = raw.match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
        if (!m) {
          errors.push({ row: i + 1, message: "Time answer (Option A) must be in HH:MM 24-hour format.", rawData: line });
          continue;
        }
        const value = `${m[1].padStart(2, '0')}:${m[2]}`;
        questions.push({ ...base, type, answerKey: { value } });
      }
    }

    return { questions, errors };
  };

  const parseStudentCsv = (text: string) => {
    const lines = text.split('\n');
    const rows: { fullName: string; email: string; registrationId: string }[] = [];
    const errors: string[] = [];

    lines.forEach((line, idx) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      const cols = parseCSVLine(trimmed);
      if (idx === 0) {
        const header = cols.join(' ').toLowerCase();
        if (header.includes('email') && header.includes('name')) return;
      }

      if (cols.length < 3) {
        errors.push(`Row ${idx + 1}: expected 3 columns (Full Name, Email, Registration ID).`);
        return;
      }

      const fullName = cols[0]?.trim() || '';
      const email = cols[1]?.trim() || '';
      const registrationId = cols[2]?.trim() || '';

      if (!fullName || !email || !registrationId) {
        errors.push(`Row ${idx + 1}: missing full name, email, or registration ID.`);
        return;
      }

      rows.push({ fullName, email, registrationId });
    });

    return { rows, errors };
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    setUploadStatus('IDLE');
    setCsvErrors([]);
    setUploadMsg('');
    
    const file = e.target.files?.[0];
    if (!file) return;

    readTextFile(file).then((text) => {
      const { questions, errors } = parseCSV(text);

      setCsvErrors(errors);

      if (questions.length > 0) {
        // Each question's sectionId was already resolved per-row in parseCSV (from the CSV's
        // Section column, or the active section as a fallback), so nothing to assign here.
        setNewExam(prev => ({
          ...prev,
          questions: [...(prev.questions || []), ...questions]
        }));
        jumpToLastQuestionPage((newExam.questions?.length || 0) + questions.length);

        if (errors.length === 0) {
          setUploadStatus('SUCCESS');
          setUploadMsg(`Successfully added ${questions.length} questions.`);
        } else {
          setUploadStatus('PARTIAL');
          setUploadMsg(`Added ${questions.length} valid questions. ${errors.length} rows failed.`);
        }
      } else {
        if (errors.length > 0) {
          setUploadStatus('ERROR');
          setUploadMsg("No valid questions found. Please fix the errors below.");
        } else {
           setUploadStatus('ERROR');
           setUploadMsg("File appears empty or invalid.");
        }
      }
    }).catch(() => {
      setUploadStatus('ERROR');
      setUploadMsg('Failed to read file. Please re-save as UTF-8 or Windows-1252.');
    });
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const exportExams = () => {
    const payload = exams.map(exam => ({
      ...exam,
      id: exam.id,
    }));
    const json = JSON.stringify(payload, null, 2);
    const blob = new Blob([json], { type: 'application/json;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `exams_export_${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const importExams = async (file: File) => {
    const text = await file.text();
    let data: any = null;
    try {
      data = JSON.parse(text);
    } catch (e) {
      alert('Invalid JSON file.');
      return;
    }
    const list = Array.isArray(data) ? data : [data];
    const created: Exam[] = [];
    const failed: string[] = [];
    for (const raw of list) {
      if (!raw || typeof raw !== 'object') continue;
      const makeId = () => Math.random().toString(36).substr(2, 9);
      const questionMap = new Map<string, string>();
      const sectionMap = new Map<string, string>();

      const sourceQuestions: Question[] = Array.isArray(raw.questions) ? raw.questions : [];
      sourceQuestions.forEach(q => {
        if (!q?.id) return;
        questionMap.set(q.id, makeId());
      });

      const sourceSections = Array.isArray(raw.sections) ? raw.sections : [];
      sourceSections.forEach((section: any) => {
        if (!section?.id) return;
        sectionMap.set(section.id, makeId());
        if (Array.isArray(section.questions)) {
          section.questions.forEach((q: any) => {
            if (q?.id && !questionMap.has(q.id)) {
              questionMap.set(q.id, makeId());
            }
          });
        }
      });

      const mappedQuestions: Question[] = sourceQuestions.map(q => ({
        ...q,
        id: (q.id && questionMap.get(q.id)) || makeId(),
        sectionId: q.sectionId ? sectionMap.get(q.sectionId) : undefined
      }));

      const mappedSections = sourceSections.map((section: any, idx: number) => ({
        ...section,
        id: (section.id && sectionMap.get(section.id)) || makeId(),
        displayOrder: section.displayOrder ?? idx,
        questions: Array.isArray(section.questions)
          ? section.questions.map((q: any) => ({
              ...q,
              id: (q.id && questionMap.get(q.id)) || makeId()
            }))
          : []
      }));

      const payload: Exam = {
        ...(raw as Exam),
        id: makeId(),
        status: 'DRAFT',
        questions: mappedQuestions,
        sections: mappedSections,
        totalMarks: mappedQuestions.reduce((sum, q) => sum + (q.marks || 0), 0),
        // Batch and student assignments are company-scoped: their IDs reference the SOURCE
        // company's batches/students. Carrying them into another company would enroll the
        // source company's students into this exam (backend expands batch_id globally), a
        // cross-company data leak. Always import an exam with a clean, unassigned roster.
        assignedBatchIds: [],
        assignedStudentIds: [],
        // Export files carry the source exam's server-computed counters and mail overrides; the API
        // echoes them back, so reset them or the imported (unassigned) exam shows stale badges.
        pendingInviteCount: 0,
        notAttemptedCount: 0,
        mailTemplates: {},
      };

      try {
        const result = await apiPost<{ exam: Exam }>('exams.php', withCompany({ exam: payload }));
        if (result.exam) {
          created.push(result.exam);
        }
      } catch (e) {
        console.error('Failed to import exam', e);
        failed.push(`${raw.title || '(untitled)'}: ${apiErrorMessage(e, 'rejected by the server')}`);
      }
    }
    if (created.length > 0) {
      onUpdateExams(prev => [...created, ...prev]);
    }
    // Report per-exam failures — they used to be swallowed into a bare "No exams imported."
    const failedNote = failed.length > 0 ? `\n\nFailed (${failed.length}):\n${failed.slice(0, 10).join('\n')}` : '';
    alert(created.length > 0 ? `Imported ${created.length} exams.${failedNote}` : `No exams imported.${failedNote}`);
  };

  // --- Batch Student Upload Logic ---
  const handleBatchStudentUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    readTextFile(file).then((text) => {
      const lines = text.split('\n');
      const foundIds: string[] = [];
      let notFoundCount = 0;

      // Extract emails/IDs from all lines (skipping header roughly)
      lines.forEach((line, idx) => {
         const cleanLine = line.trim().replace(/^"|"$/g, '');
         if (!cleanLine || (idx === 0 && (cleanLine.toLowerCase().includes('email') || cleanLine.toLowerCase().includes('id')))) return;
         
         // Try to find by Email OR Registration ID
         const student = students.find(s => s.email === cleanLine || s.registrationId === cleanLine);
         if (student) {
            foundIds.push(student.id);
         } else {
            // Also try comma separated?
            const parts = cleanLine.split(',');
            const match = students.find(s => parts.some(p => p.trim() === s.email || p.trim() === s.registrationId));
            if (match) {
                foundIds.push(match.id);
            } else {
                notFoundCount++;
            }
         }
      });

      // Merge with existing
      const newAssignment = Array.from(new Set([...(newExam.assignedStudentIds || []), ...foundIds]));
      
      setNewExam(prev => ({ ...prev, assignedStudentIds: newAssignment }));
      alert(`Batch Assignment Complete:\n- ${foundIds.length} students matched and selected.\n- ${notFoundCount} rows did not match existing students.`);
    }).catch(() => {
      alert('Failed to read file. Please re-save as UTF-8 or Windows-1252.');
    });
    if (studentBatchInputRef.current) studentBatchInputRef.current.value = '';
  };

  const handleStudentCreateUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    readTextFile(file).then(async (text) => {
      const { rows, errors } = parseStudentCsv(text);

      if (rows.length === 0) {
        alert(`No valid student rows found.${errors.length ? `\n${errors.join('\n')}` : ''}`);
        return;
      }

      const existingMap = new Map<string, Student>();
      students.forEach(s => {
        existingMap.set(s.email.toLowerCase(), s);
        existingMap.set(s.registrationId.toLowerCase(), s);
      });

      const toCreate: { fullName: string; email: string; registrationId: string }[] = [];
      const existingIds: string[] = [];
      const seen = new Set<string>();

      rows.forEach(row => {
        const key = `${row.email.toLowerCase()}|${row.registrationId.toLowerCase()}`;
        if (seen.has(key)) return;
        seen.add(key);

        const byEmail = existingMap.get(row.email.toLowerCase());
        const byReg = existingMap.get(row.registrationId.toLowerCase());
        const existing = byEmail || byReg;
        if (existing) {
          existingIds.push(existing.id);
        } else {
          toCreate.push(row);
        }
      });

      let created: Student[] = [];
      let createErrors: string[] = [];
      if (toCreate.length > 0) {
        try {
          const result = await apiPost<{ students: Student[]; errors?: string[] }>('students.php', withCompany({
            students: toCreate,
            actor: 'Admin'
          }));
          created = result.students || [];
          createErrors = result.errors || [];
        } catch (err) {
          console.error('Failed to create students:', err);
          createErrors.push('Failed to create some students. Check server logs.');
        }
      }

      const createdIds = created.map(s => s.id);
      const mergedAssigned = Array.from(new Set([...(newExam.assignedStudentIds || []), ...existingIds, ...createdIds]));
      setNewExam(prev => ({ ...prev, assignedStudentIds: mergedAssigned }));

      if (created.length > 0 && onUpdateStudents) {
        onUpdateStudents(prev => {
          const byId = new Map(prev.map(s => [s.id, s]));
          created.forEach(s => byId.set(s.id, s));
          return Array.from(byId.values());
        });
      }

      const summary = [
        `Created: ${created.length}`,
        `Matched existing: ${existingIds.length}`,
        `Assigned to this exam: ${existingIds.length + created.length}`,
      ];
      if (errors.length > 0) summary.push(`Skipped rows: ${errors.length}`);
      if (createErrors.length > 0) summary.push(`Create errors: ${createErrors.length}`);
      alert(summary.join('\n'));
    }).catch(() => {
      alert('Failed to read file. Please re-save as UTF-8 or Windows-1252.');
    });
    if (studentCreateInputRef.current) studentCreateInputRef.current.value = '';
  };


  if (isCreating) {
    // PREVIEW MODE RENDER
    if (showPreview) {
        const previewSections = useSections
            ? sections.map((section, idx) => ({
                id: section.id,
                title: section.title,
                displayOrder: idx,
                questionLimit: section.questionLimit ?? 0,
                shuffleQuestions: section.shuffleQuestions ?? true,
                timeLimitMinutes: section.timeLimitMinutes ?? 0,
                lockOnComplete: section.lockOnComplete ?? true,
                questions: (newExam.questions || []).filter(q => q.sectionId === section.id)
              }))
            : [];
        const previewExam = {
            ...newExam,
            id: newExam.id || 'PREVIEW-ID',
            totalMarks: newExam.questions?.reduce((sum, q) => sum + q.marks, 0) || 0,
            startTime: Date.now(),
            endTime: Date.now() + 3600000,
            status: 'PUBLISHED',
            questions: newExam.questions || [],
            sections: previewSections,
            proctoringConfig: newExam.proctoringConfig || {
              cameraRequired: false,
              microphoneRequired: false,
              fullScreenEnforced: false,
              tabSwitchLimit: 3,
              violationLimits: { ...defaultViolationLimits },
              proctorTiming: { ...defaultProctorTiming }
            }
        } as Exam;
        
        const previewStudent: Student = {
            id: 'ADMIN-PREVIEW',
            fullName: 'Administrator Preview',
            email: 'admin@proctorguard.com',
            registrationId: 'ADMIN',
            batches: []
        };

        return (
            <div className="fixed inset-0 z-[100] bg-white">
                <div className="absolute top-4 right-20 z-[110]">
                    <div className="bg-amber-100 text-amber-800 px-4 py-2 rounded-full font-bold text-sm border border-amber-200 shadow-sm flex items-center gap-2">
                       <Eye size={16} /> Admin Preview Mode
                    </div>
                </div>
                <div className="absolute top-4 right-4 z-[110]">
                    <button 
                       onClick={() => setShowPreview(false)}
                       className="bg-slate-900 text-white p-2 rounded-full hover:bg-slate-700 shadow-lg transition-colors"
                       title="Exit Preview"
                       aria-label="Exit preview"
                    >
                       <XCircle size={24} />
                    </button>
                </div>
                <ExamTake 
                    exam={previewExam} 
                    student={previewStudent} 
                    onFinish={() => {
                        alert("Preview Finished. In a real session, results would be submitted.");
                        setShowPreview(false);
                    }} 
                />
            </div>
        );
    }

    const isPublished = newExam.status === 'PUBLISHED';
    const violationLimits = {
      ...defaultViolationLimits,
      ...(newExam.proctoringConfig?.violationLimits || {})
    };
    const proctorTiming = {
      ...defaultProctorTiming,
      ...(newExam.proctoringConfig?.proctorTiming || {})
    };

    return (
      <>
      <div className="space-y-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <h2 className="lsc-title">{newExam.id ? 'Edit Exam' : 'Create New Exam'}</h2>
          <button onClick={handleCancelEdit} disabled={savingExam} className="px-4 py-2 lsc-button-ghost text-sm disabled:opacity-50">Cancel</button>
        </div>

        {/* Warning for Published Exams */}
        {isPublished && (
          <div className="bg-amber-50 border-l-4 border-amber-500 p-4 rounded-r shadow-sm flex items-start gap-3">
             <AlertCircle className="text-amber-600 mt-0.5 shrink-0" />
             <div>
               <h4 className="font-bold text-amber-800">Restricted Editing Mode</h4>
               <p className="text-sm text-amber-700 mt-1">
                 This exam is <strong>PUBLISHED</strong>. To ensure integrity for students who may be taking the exam:
               </p>
               <ul className="list-disc list-inside text-sm text-amber-700 mt-1 ml-1 space-y-0.5">
                 <li>Question modification (add/edit/delete) is <strong>disabled</strong>.</li>
                 <li>Changes to Duration, Schedule, and Proctoring rules will apply <strong>immediately</strong> to active sessions.</li>
               </ul>
             </div>
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          {/* Left Col: Config */}
          <div className="lg:col-span-1 space-y-6">
            <div className="lsc-panel p-6 space-y-4">
              <h3 className="font-semibold text-slate-800">Exam Details</h3>
              
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Status</label>
                <select 
                  className={`w-full px-3 py-2 border rounded-lg outline-none bg-white font-medium ${
                    newExam.status === 'PUBLISHED' ? 'text-teal-700 border-teal-200 bg-teal-50' :
                    newExam.status === 'DRAFT' ? 'text-orange-700 border-orange-200 bg-orange-50' : 'text-slate-700'
                  }`}
                  value={newExam.status || 'DRAFT'}
                  onChange={e => setNewExam({...newExam, status: e.target.value as any})}
                >
                  <option value="DRAFT">Draft (Editing Allowed)</option>
                  <option value="PUBLISHED">Published (Restricted)</option>
                  <option value="ARCHIVED">Archived</option>
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Title</label>
                <input 
                  type="text" 
                  className="w-full px-3 py-2 border rounded-lg outline-none"
                  value={newExam.title}
                  onChange={e => setNewExam({...newExam, title: e.target.value})}
                  placeholder="e.g. Advanced React Pattern"
                />
              </div>
              
              {/* Schedule */}
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1 flex items-center gap-1">
                    <Clock size={14} /> Timezone
                </label>
                <select
                  className="w-full px-3 py-2 border rounded-lg outline-none text-sm bg-white"
                  value={resolveExamTimezone(newExam.timezone)}
                  onChange={e => {
                    const newTz = e.target.value;
                    const oldTz = resolveExamTimezone(newExam.timezone);
                    // Keep the wall-clock numbers the admin already typed, but
                    // re-interpret them in the newly chosen zone. (Guarded: Intl throws on an
                    // invalid instant, which would blank the whole screen.)
                    const reinterpret = (epoch?: number) => (typeof epoch === 'number' && Number.isFinite(epoch)
                      ? zonedInputToEpoch(epochToZonedInput(epoch, oldTz), newTz)
                      : epoch);
                    setNewExam({
                      ...newExam,
                      timezone: newTz,
                      startTime: reinterpret(newExam.startTime),
                      endTime: reinterpret(newExam.endTime),
                    });
                  }}
                >
                  {EXAM_TIMEZONES.map(tz => (
                    <option key={tz.value} value={tz.value}>{tz.label}</option>
                  ))}
                </select>
                <p className="text-xs text-slate-400 mt-1">All exam times below and in student emails are shown in this timezone.</p>
              </div>

              <div className="grid grid-cols-1 gap-4">
                 <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1 flex items-center gap-1">
                        <Calendar size={14} /> Start Time
                    </label>
                    <input
                      type="datetime-local"
                      className="w-full px-3 py-2 border rounded-lg outline-none text-sm"
                      value={zonedInputValue(newExam.startTime, resolveExamTimezone(newExam.timezone))}
                      onChange={e => {
                        // A cleared/partially-cleared picker reports '' → NaN. Storing NaN crashed the
                        // next render (Intl RangeError) and took the whole admin panel down, losing
                        // every unsaved edit — keep the last valid time instead.
                        const next = zonedInputToEpoch(e.target.value, resolveExamTimezone(newExam.timezone));
                        if (Number.isFinite(next)) setNewExam({...newExam, startTime: next});
                      }}
                    />
                 </div>
                 <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1 flex items-center gap-1">
                        <Calendar size={14} /> End Time
                    </label>
                    <input
                      type="datetime-local"
                      className="w-full px-3 py-2 border rounded-lg outline-none text-sm"
                      value={zonedInputValue(newExam.endTime, resolveExamTimezone(newExam.timezone))}
                      onChange={e => {
                        const next = zonedInputToEpoch(e.target.value, resolveExamTimezone(newExam.timezone));
                        if (Number.isFinite(next)) setNewExam({...newExam, endTime: next});
                      }}
                    />
                 </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1 flex items-center gap-1">
                    <Clock size={14} /> Duration (mins)
                </label>
                <input
                  type="number"
                  min="1"
                  step="1"
                  className="w-full px-3 py-2 border rounded-lg outline-none"
                  value={newExam.durationMinutes}
                  onChange={e => setNewExam({...newExam, durationMinutes: Number(e.target.value)})}
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-700 mb-2">Results Visibility</label>
                <div className="bg-slate-50 p-3 rounded-lg border border-slate-200">
                  <label className="flex items-center gap-2 text-sm text-slate-700 cursor-pointer">
                      <div className={`w-9 h-5 rounded-full relative transition-colors ${newExam.showResults ? 'bg-[var(--lsc-primary)]' : 'bg-slate-300'}`}>
                        <input 
                          type="checkbox" 
                          className="sr-only"
                          checked={newExam.showResults ?? false}
                          onChange={e => setNewExam({...newExam, showResults: e.target.checked})}
                        />
                        <div className={`absolute top-1 left-1 bg-white w-3 h-3 rounded-full transition-transform ${newExam.showResults ? 'translate-x-4' : 'translate-x-0'}`}></div>
                      </div>
                      <span>Show results immediately after submission</span>
                  </label>
                  <p className="text-[10px] text-slate-500 mt-1 leading-tight">
                    If disabled, students see a thank-you message only.
                  </p>
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-700 mb-2">Pass Percentage</label>
                <div className="bg-slate-50 p-3 rounded-lg border border-slate-200">
                  <input
                    type="number"
                    min="0"
                    max="100"
                    className="w-full px-3 py-2 border rounded-lg outline-none text-sm"
                    value={newExam.passPercent ?? 60}
                    onChange={e => {
                      const next = Math.max(0, Math.min(100, Number(e.target.value)));
                      setNewExam({ ...newExam, passPercent: Number.isNaN(next) ? 60 : next });
                    }}
                  />
                  <p className="text-[10px] text-slate-500 mt-1 leading-tight">
                    Students must score at least this percentage to pass.
                  </p>
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-700 mb-2 flex items-center gap-1">
                    <Award size={14} /> Certification
                </label>
                <div className="bg-slate-50 p-3 rounded-lg border border-slate-200">
                  <label className="flex items-center gap-2 text-sm text-slate-700 cursor-pointer">
                      <div className={`w-9 h-5 rounded-full relative transition-colors ${newExam.certificateEnabled ? 'bg-[var(--lsc-primary)]' : 'bg-slate-300'}`}>
                        <input
                          type="checkbox"
                          className="sr-only"
                          checked={newExam.certificateEnabled ?? false}
                          onChange={e => setNewExam({...newExam, certificateEnabled: e.target.checked})}
                        />
                        <div className={`absolute top-1 left-1 bg-white w-3 h-3 rounded-full transition-transform ${newExam.certificateEnabled ? 'translate-x-4' : 'translate-x-0'}`}></div>
                      </div>
                      <span>Enable certificate issuance for this exam</span>
                  </label>
                  <p className="text-[10px] text-slate-500 mt-1 leading-tight">
                    Certificates are never issued automatically. When enabled, an admin can issue one on demand from a passed result. When disabled, on-demand issuance is blocked for this exam.
                  </p>
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-700 mb-2">Question Pools / Sections</label>
                <div className="bg-slate-50 p-3 rounded-lg border border-slate-200">
                  <label className="flex items-center gap-2 text-sm text-slate-700 cursor-pointer">
                    <div className={`w-9 h-5 rounded-full relative transition-colors ${useSections ? 'bg-[var(--lsc-primary)]' : 'bg-slate-300'}`}>
                      <input
                        type="checkbox"
                        className="sr-only"
                        checked={useSections}
                        onChange={e => (e.target.checked ? enableSections() : disableSections())}
                      />
                      <div className={`absolute top-1 left-1 bg-white w-3 h-3 rounded-full transition-transform ${useSections ? 'translate-x-4' : 'translate-x-0'}`}></div>
                    </div>
                    <span>Enable sections with randomized pools</span>
                  </label>
                  <p className="text-[10px] text-slate-500 mt-1 leading-tight">
                    Build sections and pull a randomized subset of questions from each pool.
                  </p>
                </div>

                {useSections && (
                  <div className="mt-3 space-y-3">
                    {sections.map((section, idx) => (
                      <div key={section.id} className={`rounded-lg border p-3 bg-white ${activeSectionId === section.id ? 'border-blue-300 ring-1 ring-blue-200' : 'border-slate-200'}`}>
                        <div className="flex items-center justify-between gap-2">
                          <button
                            type="button"
                            onClick={() => setActiveSectionId(section.id)}
                            className={`text-xs font-semibold px-2 py-1 rounded ${activeSectionId === section.id ? 'bg-blue-100 text-blue-700' : 'bg-slate-100 text-slate-600'}`}
                          >
                            {activeSectionId === section.id ? 'Active' : 'Set Active'}
                          </button>
                          <div className="text-[10px] text-slate-400">
                            {getSectionQuestionCount(section.id)} questions
                          </div>
                        </div>
                        <div className="mt-2 grid grid-cols-1 gap-2">
                          <input
                            type="text"
                            className="w-full px-3 py-2 border rounded-lg outline-none text-sm"
                            value={section.title}
                            onChange={e => {
                              const updated = sections.map(s => s.id === section.id ? { ...s, title: e.target.value } : s);
                              setNewExam({ ...newExam, sections: updated });
                            }}
                            placeholder={`Section ${idx + 1}`}
                          />
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                            <div>
                              <label className="block text-[10px] text-slate-500 mb-1">Question Limit</label>
                              <input
                                type="number"
                                min="0"
                                className="w-full px-3 py-2 border rounded-lg outline-none text-sm"
                                value={section.questionLimit ?? 0}
                                onChange={e => {
                                  const updated = sections.map(s => s.id === section.id ? { ...s, questionLimit: Math.max(0, Number(e.target.value)) } : s);
                                  setNewExam({ ...newExam, sections: updated });
                                }}
                              />
                              <p className="text-[10px] text-slate-400 mt-1">0 means all questions in this section.</p>
                            </div>
                            <div>
                              <label className="block text-[10px] text-slate-500 mb-1">Shuffle Questions</label>
                              <label className="flex items-center gap-2 text-sm text-slate-700 cursor-pointer">
                                <div className={`w-9 h-5 rounded-full relative transition-colors ${section.shuffleQuestions ? 'bg-[var(--lsc-primary)]' : 'bg-slate-300'}`}>
                                  <input
                                    type="checkbox"
                                    className="sr-only"
                                    checked={section.shuffleQuestions ?? true}
                                    onChange={e => {
                                      const updated = sections.map(s => s.id === section.id ? { ...s, shuffleQuestions: e.target.checked } : s);
                                      setNewExam({ ...newExam, sections: updated });
                                    }}
                                  />
                                  <div className={`absolute top-1 left-1 bg-white w-3 h-3 rounded-full transition-transform ${section.shuffleQuestions ? 'translate-x-4' : 'translate-x-0'}`}></div>
                                </div>
                                <span className="text-xs">Randomize order</span>
                              </label>
                            </div>
                          </div>
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                            <div>
                              <label className="block text-[10px] text-slate-500 mb-1">Section Time (mins)</label>
                              <input
                                type="number"
                                min="0"
                                className="w-full px-3 py-2 border rounded-lg outline-none text-sm"
                                value={section.timeLimitMinutes ?? 0}
                                onChange={e => {
                                  const updated = sections.map(s => s.id === section.id ? { ...s, timeLimitMinutes: Math.max(0, Number(e.target.value)) } : s);
                                  setNewExam({ ...newExam, sections: updated });
                                }}
                              />
                              <p className="text-[10px] text-slate-400 mt-1">0 uses the global exam timer.</p>
                            </div>
                            <div>
                              <label className="block text-[10px] text-slate-500 mb-1">Lock On Complete</label>
                              <label className="flex items-center gap-2 text-sm text-slate-700 cursor-pointer">
                                <div className={`w-9 h-5 rounded-full relative transition-colors ${section.lockOnComplete ? 'bg-[var(--lsc-primary)]' : 'bg-slate-300'}`}>
                                  <input
                                    type="checkbox"
                                    className="sr-only"
                                    checked={section.lockOnComplete ?? true}
                                    onChange={e => {
                                      const updated = sections.map(s => s.id === section.id ? { ...s, lockOnComplete: e.target.checked } : s);
                                      setNewExam({ ...newExam, sections: updated });
                                    }}
                                  />
                                  <div className={`absolute top-1 left-1 bg-white w-3 h-3 rounded-full transition-transform ${section.lockOnComplete ? 'translate-x-4' : 'translate-x-0'}`}></div>
                                </div>
                                <span className="text-xs">Lock previous section</span>
                              </label>
                            </div>
                          </div>
                        </div>
                        <div className="mt-3 flex justify-between items-center text-[10px] text-slate-400">
                          <span>Section {idx + 1}</span>
                          {sections.length > 1 && (
                            <button
                              type="button"
                              onClick={() => {
                                const remaining = sections.filter(s => s.id !== section.id);
                                const fallbackId = remaining[0]?.id;
                                setNewExam(prev => ({
                                  ...prev,
                                  sections: remaining,
                                  questions: (prev.questions || []).map(q => q.sectionId === section.id ? { ...q, sectionId: fallbackId } : q)
                                }));
                                if (activeSectionId === section.id) {
                                  setActiveSectionId(fallbackId || null);
                                }
                              }}
                              className="text-[10px] text-rose-600 hover:underline"
                            >
                              Remove
                            </button>
                          )}
                        </div>
                      </div>
                    ))}
                    <button
                      type="button"
                      onClick={() => {
                        const next = createSection(`Section ${sections.length + 1}`, sections.length);
                        setNewExam(prev => ({ ...prev, sections: [...(prev.sections || []), next] }));
                        setActiveSectionId(next.id);
                      }}
                      className="w-full py-2 border border-dashed border-blue-300 text-blue-600 rounded-lg text-sm hover:bg-blue-50"
                    >
                      Add Section
                    </button>
                    {activeSectionId && (
                      <div className="text-[10px] text-slate-400">
                        New questions will be added to: {sections.find(s => s.id === activeSectionId)?.title || 'Section'}
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Question Limit & Shuffling */}
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-2 flex items-center gap-1">
                    <ListOrdered size={14} /> Question Order & Limits
                </label>
                
                <div className="bg-slate-50 p-3 rounded-lg border border-slate-200 space-y-3">
                  <label className="flex items-center gap-2 text-sm text-slate-700 cursor-pointer">
                      <div className={`w-9 h-5 rounded-full relative transition-colors ${newExam.shuffleQuestions ? 'bg-[var(--lsc-primary)]' : 'bg-slate-300'} ${useSections ? 'opacity-50' : ''}`}>
                        <input 
                          type="checkbox" 
                          className="sr-only"
                          checked={newExam.shuffleQuestions ?? true}
                          onChange={e => !useSections && setNewExam({...newExam, shuffleQuestions: e.target.checked})}
                          disabled={useSections}
                        />
                        <div className={`absolute top-1 left-1 bg-white w-3 h-3 rounded-full transition-transform ${newExam.shuffleQuestions ? 'translate-x-4' : 'translate-x-0'}`}></div>
                      </div>
                      <span className="flex items-center gap-1.5">
                        <Shuffle size={14} className={newExam.shuffleQuestions ? 'text-blue-600' : 'text-slate-400'} />
                        Randomize Order
                      </span>
                  </label>

                  <div>
                     <div className="flex items-center justify-between mb-1">
                        <span className="text-xs font-medium text-slate-600">Question Subset Limit</span>
                        <span className="text-xs text-slate-400">{newExam.questionCount === 0 ? 'All' : newExam.questionCount} / {newExam.questions?.length || 0}</span>
                     </div>
                     <input 
                      type="number" 
                      min="0"
                      max={newExam.questions?.length}
                      className="w-full px-3 py-2 border rounded-lg outline-none text-sm"
                      value={newExam.questionCount}
                      onChange={e => !useSections && setNewExam({...newExam, questionCount: Math.max(0, Math.floor(Number(e.target.value) || 0))})}
                      disabled={useSections}
                      placeholder="0 for all"
                     />
                     <p className="text-[10px] text-slate-500 mt-1 leading-tight">
                        {useSections
                          ? 'Section settings override global question limits.'
                          : newExam.questionCount === 0 
                            ? `Students see all ${newExam.questions?.length || 0} questions.` 
                            : `Students see ${newExam.questionCount} questions selected ${newExam.shuffleQuestions ? 'randomly' : 'sequentially'} from the pool.`}
                     </p>
                  </div>
                </div>
              </div>
            </div>

            <div className="lsc-panel p-6 space-y-4">
              <h3 className="font-semibold text-slate-800 flex items-center gap-2">
                <div className="w-2 h-2 rounded-full bg-red-500 animate-pulse"></div>
                Proctoring Rules
              </h3>
              <div className="space-y-4">
                <label className="flex items-center gap-2 text-sm text-slate-700">
                  <input type="checkbox" checked={newExam.proctoringConfig?.cameraRequired} onChange={e => setNewExam({...newExam, proctoringConfig: {...newExam.proctoringConfig!, cameraRequired: e.target.checked}})} />
                  Require Camera
                </label>
                <label className="flex items-center gap-2 text-sm text-slate-700">
                  <input type="checkbox" checked={newExam.proctoringConfig?.microphoneRequired} onChange={e => setNewExam({...newExam, proctoringConfig: {...newExam.proctoringConfig!, microphoneRequired: e.target.checked}})} />
                  Require Microphone
                </label>
                <label className="flex items-center gap-2 text-sm text-slate-700">
                  <input type="checkbox" checked={newExam.proctoringConfig?.fullScreenEnforced} onChange={e => setNewExam({...newExam, proctoringConfig: {...newExam.proctoringConfig!, fullScreenEnforced: e.target.checked}})} />
                  Enforce Fullscreen
                </label>

                {/* Allowed Devices — restrict which device classes may sit this exam. */}
                {(() => {
                  const allowed = newExam.allowedDeviceTypes && newExam.allowedDeviceTypes.length > 0
                    ? newExam.allowedDeviceTypes
                    : (['desktop', 'tablet', 'mobile'] as DeviceType[]);
                  const deviceOptions: { key: DeviceType; label: string; hint: string; icon: React.ReactNode }[] = [
                    { key: 'desktop', label: 'Desktop / Laptop', hint: 'Windows, Mac & Linux computers', icon: <Monitor size={18} /> },
                    { key: 'tablet', label: 'Tablet', hint: 'iPad & Android tablets', icon: <Tablet size={18} /> },
                    { key: 'mobile', label: 'Mobile Phone', hint: 'iPhone & Android phones', icon: <Smartphone size={18} /> },
                  ];
                  return (
                    <div className="pt-1">
                      <label className="text-sm text-slate-700 font-medium block mb-1">Allowed Devices</label>
                      <p className="text-[10px] text-slate-500 mb-3">
                        Uncheck a device type to stop candidates from taking this exam on it. At least one must stay selected.
                      </p>
                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                        {deviceOptions.map(opt => {
                          const isOn = allowed.includes(opt.key);
                          const isLastOn = isOn && allowed.length === 1;
                          return (
                            <button
                              key={opt.key}
                              type="button"
                              onClick={() => toggleDeviceType(opt.key)}
                              disabled={isLastOn}
                              title={isLastOn ? 'At least one device type must remain allowed' : undefined}
                              className={`flex items-start gap-2 text-left px-3 py-2.5 rounded-lg border transition-all ${
                                isOn
                                  ? 'border-[var(--lsc-primary)] bg-blue-50 ring-1 ring-[var(--lsc-primary)]/30'
                                  : 'border-slate-200 bg-white hover:border-slate-300'
                              } ${isLastOn ? 'cursor-not-allowed' : ''}`}
                            >
                              <span className={isOn ? 'text-[var(--lsc-primary)] mt-0.5' : 'text-slate-400 mt-0.5'}>{opt.icon}</span>
                              <span className="flex-1 min-w-0">
                                <span className="flex items-center gap-1.5">
                                  <span className={`text-sm font-medium ${isOn ? 'text-slate-900' : 'text-slate-500'}`}>{opt.label}</span>
                                  {isOn && <CheckCircle size={13} className="text-[var(--lsc-primary)] flex-shrink-0" />}
                                </span>
                                <span className="block text-[10px] text-slate-400 leading-tight mt-0.5">{opt.hint}</span>
                              </span>
                            </button>
                          );
                        })}
                      </div>
                      {!allowed.includes('mobile') && (
                        <p className="text-[11px] text-amber-600 mt-2 flex items-center gap-1">
                          <AlertCircle size={12} /> Candidates on a mobile phone will be blocked from starting this exam.
                        </p>
                      )}
                    </div>
                  );
                })()}

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="text-sm text-slate-700 font-medium block mb-1">Reconnect Attempts</label>
                    <input
                      type="number"
                      min="0"
                      className="w-full px-3 py-2 border rounded-lg outline-none text-sm"
                      value={newExam.reconnectLimit ?? 0}
                      onChange={e => setNewExam({ ...newExam, reconnectLimit: Math.max(0, Number(e.target.value)) })}
                    />
                    <p className="text-[10px] text-slate-500 mt-1">
                      Number of times a student can reconnect to an active session after disconnect.
                    </p>
                  </div>
                  <div>
                    <label className="text-sm text-slate-700 font-medium block mb-1">Tab Switch Limit</label>
                    <input
                      type="number"
                      min="0"
                      className="w-full px-3 py-2 border rounded-lg outline-none text-sm"
                      value={newExam.proctoringConfig?.tabSwitchLimit ?? 0}
                      onChange={e => setNewExam({
                        ...newExam,
                        proctoringConfig: {
                          ...newExam.proctoringConfig!,
                          tabSwitchLimit: Math.max(0, Number(e.target.value))
                        }
                      })}
                    />
                    <p className="text-[10px] text-slate-500 mt-1">
                      Kicks the student after this many tab switches. Use 0 to disable.
                    </p>
                  </div>
                  <div>
                    <label className="text-sm text-slate-700 font-medium block mb-1">Camera Violation Limit</label>
                    <input
                      type="number"
                      min="0"
                      className="w-full px-3 py-2 border rounded-lg outline-none text-sm"
                      value={violationLimits.camera}
                      onChange={e => setNewExam({
                        ...newExam,
                        proctoringConfig: {
                          ...newExam.proctoringConfig!,
                          violationLimits: {
                            ...violationLimits,
                            camera: Math.max(0, Number(e.target.value))
                          }
                        }
                      })}
                    />
                    <p className="text-[10px] text-slate-500 mt-1">
                      Counts camera-related alerts (no face, multiple faces, phone, suspicious object).
                    </p>
                  </div>
                  <div>
                    <label className="text-sm text-slate-700 font-medium block mb-1">Microphone Violation Limit</label>
                    <input
                      type="number"
                      min="0"
                      className="w-full px-3 py-2 border rounded-lg outline-none text-sm"
                      value={violationLimits.microphone}
                      onChange={e => setNewExam({
                        ...newExam,
                        proctoringConfig: {
                          ...newExam.proctoringConfig!,
                          violationLimits: {
                            ...violationLimits,
                            microphone: Math.max(0, Number(e.target.value))
                          }
                        }
                      })}
                    />
                    <p className="text-[10px] text-slate-500 mt-1">
                      Counts speech or strong microphone violations. Mild background noise is tolerated. Use 0 to disable.
                    </p>
                  </div>
                  <div>
                    <label className="text-sm text-slate-700 font-medium block mb-1">Fullscreen Exit Limit</label>
                    <input
                      type="number"
                      min="0"
                      className="w-full px-3 py-2 border rounded-lg outline-none text-sm"
                      value={violationLimits.fullscreen}
                      onChange={e => setNewExam({
                        ...newExam,
                        proctoringConfig: {
                          ...newExam.proctoringConfig!,
                          violationLimits: {
                            ...violationLimits,
                            fullscreen: Math.max(0, Number(e.target.value))
                          }
                        }
                      })}
                    />
                    <p className="text-[10px] text-slate-500 mt-1">
                      Auto-kick after this many fullscreen exits. Use 0 to disable.
                    </p>
                  </div>
                  <div>
                    <label className="text-sm text-slate-700 font-medium block mb-1">Copy/Paste Limit</label>
                    <input
                      type="number"
                      min="0"
                      className="w-full px-3 py-2 border rounded-lg outline-none text-sm"
                      value={violationLimits.copyPaste}
                      onChange={e => setNewExam({
                        ...newExam,
                        proctoringConfig: {
                          ...newExam.proctoringConfig!,
                          violationLimits: {
                            ...violationLimits,
                            copyPaste: Math.max(0, Number(e.target.value))
                          }
                        }
                      })}
                    />
                    <p className="text-[10px] text-slate-500 mt-1">
                      Auto-kick after this many copy/paste attempts. Use 0 to disable.
                    </p>
                  </div>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-4">
                  <div>
                    <label className="text-sm text-slate-700 font-medium block mb-1">Gaze Away Sensitivity (sec)</label>
                    <input
                      type="number"
                      min="1"
                      max="60"
                      className="w-full px-3 py-2 border rounded-lg outline-none text-sm"
                      value={proctorTiming.gazeAwaySeconds}
                      onChange={e => setNewExam({
                        ...newExam,
                        proctoringConfig: {
                          ...newExam.proctoringConfig!,
                          proctorTiming: {
                            ...proctorTiming,
                            gazeAwaySeconds: Math.max(1, Math.min(60, Number(e.target.value)))
                          }
                        }
                      })}
                    />
                    <p className="text-[10px] text-slate-500 mt-1">
                      Seconds of sustained looking-away before it's logged. Lower = stricter.
                    </p>
                  </div>
                  <div>
                    <label className="text-sm text-slate-700 font-medium block mb-1">Talking Sensitivity (sec)</label>
                    <input
                      type="number"
                      min="1"
                      max="60"
                      className="w-full px-3 py-2 border rounded-lg outline-none text-sm"
                      value={proctorTiming.audioSeconds}
                      onChange={e => setNewExam({
                        ...newExam,
                        proctoringConfig: {
                          ...newExam.proctoringConfig!,
                          proctorTiming: {
                            ...proctorTiming,
                            audioSeconds: Math.max(1, Math.min(60, Number(e.target.value)))
                          }
                        }
                      })}
                    />
                    <p className="text-[10px] text-slate-500 mt-1">
                      Seconds of sustained talking before it's logged. Lower = stricter.
                    </p>
                  </div>
                </div>
              </div>
            </div>

            {/* Student Assignment */}
            <div className="lsc-panel p-6 space-y-4">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <h3 className="font-semibold text-slate-800 flex items-center gap-2">
                  <Users size={16} /> Assign Batches
                </h3>
                <div className="text-xs text-slate-500">
                  {(newExam.assignedBatchIds || []).length} batches selected
                </div>
              </div>
              <div className="grid gap-3 sm:grid-cols-3 text-[11px] text-slate-500 leading-snug">
                <p>
                  <span className="font-semibold text-slate-700">Batch-Based Assignment:</span> Select one or more batches and everyone in those batches will be assigned to the exam automatically.
                </p>
                <p>
                  <span className="font-semibold text-slate-700">Company Scope:</span> {isSuperAdmin
                    ? 'Batches shown belong to the company selected above. Selecting a batch enrolls all of its students.'
                    : 'Only batches under the current authenticated company are shown here.'}
                </p>
                <p>
                  <span className="font-semibold text-slate-700">Auto Expansion:</span> Selected batches are expanded to student IDs automatically when the exam is saved.
                </p>
              </div>
              
              <div className="relative">
                <Search className="absolute left-2.5 top-2.5 text-slate-400" size={14} />
                <input 
                  type="text" 
                  placeholder="Search batches..." 
                  className="w-full pl-8 pr-3 py-2 text-sm border rounded-lg outline-none"
                  value={batchSearch}
                  onChange={e => setBatchSearch(e.target.value)}
                />
              </div>
              <div className="max-h-48 overflow-y-auto border rounded-lg divide-y divide-slate-50">
                {(() => {
                  const term = batchSearch.toLowerCase();
                  const matches = (batch: Batch) =>
                    batch.name.toLowerCase().includes(term)
                    || (batch.description || '').toLowerCase().includes(term)
                    || (batch.companyName || '').toLowerCase().includes(term);
                  const filtered = batches.filter(matches);

                  const renderBatchRow = (batch: Batch) => (
                    <label key={batch.id} className="flex items-center gap-3 p-3 hover:bg-slate-50 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={(newExam.assignedBatchIds || []).includes(batch.id)}
                        onChange={() => toggleBatch(batch.id)}
                        className="rounded text-blue-600"
                      />
                      <div className="text-sm">
                        <div className="font-medium text-slate-900">{batch.name}</div>
                        <div className="text-xs text-slate-500">
                          {typeof batch.studentCount === 'number' ? `${batch.studentCount} students` : `${students.filter(student => student.batches.some(b => b.id === batch.id)).length} students`}
                          {batch.description ? ` • ${batch.description}` : ''}
                        </div>
                      </div>
                    </label>
                  );

                  if (filtered.length === 0) {
                    return <div className="p-3 text-xs text-slate-400 text-center">No batches found. Create batches in Student Registry first.</div>;
                  }

                  // Super admin: group the flat list by owning company so it reads clearly.
                  if (isSuperAdmin) {
                    const groups: { companyId: number; companyName: string; batches: Batch[] }[] = [];
                    filtered.forEach(batch => {
                      const label = batch.companyName || `Company ${batch.companyId}`;
                      let group = groups.find(g => g.companyId === batch.companyId);
                      if (!group) {
                        group = { companyId: batch.companyId, companyName: label, batches: [] };
                        groups.push(group);
                      }
                      group.batches.push(batch);
                    });
                    return groups.map(group => (
                      <div key={group.companyId}>
                        <div className="sticky top-0 bg-slate-100 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                          {group.companyName}
                        </div>
                        {group.batches.map(renderBatchRow)}
                      </div>
                    ));
                  }

                  return filtered.map(renderBatchRow);
                })()}
              </div>
              <div className="text-xs text-slate-500 text-right">
                {(() => {
                  const selected = newExam.assignedBatchIds || [];
                  const explicit = newExam.assignedStudentIds || [];
                  // With no assignment at all, Notify/Links go to EVERY student in the company
                  // (resolveRecipients' fallback) — "0 students will receive this exam" was wrong.
                  if (selected.length === 0 && explicit.length === 0) {
                    return 'No batches selected — invitations will go to every student in this company';
                  }
                  // Cross-company batches aren't in the local `students` prop, so for a super admin we
                  // trust the per-batch counts from the API instead of expanding against local students.
                  // Otherwise count the real union the save sends: batch members PLUS individually
                  // assigned students (the old count ignored the latter).
                  const count = isSuperAdmin
                    ? Math.max(batches.filter(b => selected.includes(b.id)).reduce((sum, b) => sum + (b.studentCount || 0), 0), explicit.length)
                    : new Set([...explicit, ...getStudentIdsForBatchIds(selected)]).size;
                  return `${count} students will receive this exam`;
                })()}
              </div>
            </div>
            
            {/* Email Notifications Config */}
            <div className="lsc-panel p-6 space-y-4">
                <div className="flex justify-between items-start">
                    <div>
                        <h3 className="font-semibold text-slate-800 flex items-center gap-2">
                            <Bell size={16} /> Email Notifications
                        </h3>
                        <p className="text-xs text-slate-500 mt-1">Configure automated reminders sent to students.</p>
                    </div>
                    <label className="relative inline-flex items-center cursor-pointer">
                        <input 
                            type="checkbox" 
                            className="sr-only peer"
                            checked={newExam.notificationConfig?.enabled ?? false}
                            onChange={e => setNewExam({
                                ...newExam, 
                                notificationConfig: {
                                    enabled: e.target.checked,
                                    reminders: newExam.notificationConfig?.reminders || { hours24: true, hours1: true },
                                    customSubject: newExam.notificationConfig?.customSubject || `Reminder: ${newExam.title || '{ExamTitle}'}`,
                                    customMessage: newExam.notificationConfig?.customMessage || "Hello {StudentName},\n\nThis is a reminder for your upcoming exam: {ExamTitle}.\nIt is scheduled to start at {StartTime}.\n\nPlease ensure your system is ready.\n\nGood luck!"
                                }
                            })}
                        />
                        <div className="w-9 h-5 bg-slate-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-[var(--lsc-primary)]"></div>
                    </label>
                </div>
                
                {newExam.notificationConfig?.enabled && (
                    <div className="space-y-4 animate-in fade-in slide-in-from-top-2 pt-2">
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                            <label className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${newExam.notificationConfig.reminders.hours24 ? 'bg-blue-50 border-blue-200' : 'bg-slate-50 border-slate-100 hover:bg-slate-100'}`}>
                                <input 
                                    type="checkbox" 
                                    className="w-4 h-4 text-blue-600 rounded"
                                    checked={newExam.notificationConfig.reminders.hours24}
                                    onChange={e => setNewExam({
                                        ...newExam,
                                        notificationConfig: {
                                            ...newExam.notificationConfig!,
                                            reminders: { ...newExam.notificationConfig!.reminders, hours24: e.target.checked }
                                        }
                                    })}
                                />
                                <span className="text-sm font-medium text-slate-700">24 Hours Before</span>
                            </label>
                            <label className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${newExam.notificationConfig.reminders.hours1 ? 'bg-blue-50 border-blue-200' : 'bg-slate-50 border-slate-100 hover:bg-slate-100'}`}>
                                <input 
                                    type="checkbox" 
                                    className="w-4 h-4 text-blue-600 rounded"
                                    checked={newExam.notificationConfig.reminders.hours1}
                                    onChange={e => setNewExam({
                                        ...newExam,
                                        notificationConfig: {
                                            ...newExam.notificationConfig!,
                                            reminders: { ...newExam.notificationConfig!.reminders, hours1: e.target.checked }
                                        }
                                    })}
                                />
                                <span className="text-sm font-medium text-slate-700">1 Hour Before</span>
                            </label>
                        </div>
                        
                        {templates.length > 0 && (
                          <div className="pt-2">
                            <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1.5">Use Template</label>
                            <select
                              className="w-full px-3 py-2 border border-slate-200 rounded-lg outline-none text-sm bg-white"
                              value={selectedTemplateId ?? ''}
                              onChange={e => {
                                const val = e.target.value;
                                if (!val) {
                                  setSelectedTemplateId(null);
                                  return;
                                }
                                const tpl = templates.find(t => t.id === Number(val));
                                if (!tpl) return;
                                setSelectedTemplateId(tpl.id);
                                setNewExam({
                                  ...newExam,
                                  notificationConfig: {
                                    ...newExam.notificationConfig!,
                                    customSubject: tpl.subject || newExam.notificationConfig!.customSubject,
                                    customMessage: tpl.body
                                  }
                                });
                              }}
                            >
                              <option value="">Select a template</option>
                              {templates.map(tpl => (
                                <option key={tpl.id} value={tpl.id}>
                                  {tpl.name}
                                </option>
                              ))}
                            </select>
                          </div>
                        )}

                        <div className="space-y-3 pt-2">
                            <div>
                                <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1.5">Email Subject</label>
                                <input 
                                    type="text" 
                                    className="w-full px-3 py-2 border border-slate-200 rounded-lg outline-none text-sm transition-shadow"
                                    placeholder="e.g. Reminder: {ExamTitle}"
                                    value={newExam.notificationConfig.customSubject}
                                    onChange={e => setNewExam({
                                        ...newExam,
                                        notificationConfig: {
                                            ...newExam.notificationConfig!,
                                            customSubject: e.target.value
                                        }
                                    })}
                                />
                            </div>
                             <div>
                                <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1.5">Message Body</label>
                                <textarea 
                                    className="w-full px-3 py-2 border border-slate-200 rounded-lg outline-none text-sm transition-shadow min-h-[120px]"
                                    rows={5}
                                    value={newExam.notificationConfig.customMessage}
                                    onChange={e => setNewExam({
                                        ...newExam,
                                        notificationConfig: {
                                            ...newExam.notificationConfig!,
                                            customMessage: e.target.value
                                        }
                                    })}
                                />
                                <div className="mt-2 flex flex-wrap gap-2">
                                    {['{StudentName}', '{ExamTitle}', '{StartTime}', '{Link}'].map(tag => (
                                        <button 
                                            key={tag}
                                            onClick={() => setNewExam({
                                                ...newExam,
                                                notificationConfig: {
                                                    ...newExam.notificationConfig!,
                                                    customMessage: (newExam.notificationConfig!.customMessage || '') + tag
                                                }
                                            })}
                                            className="px-2 py-1 bg-slate-100 hover:bg-slate-200 text-slate-600 text-[10px] font-mono rounded border border-slate-200 transition-colors"
                                            title="Click to insert"
                                        >
                                            {tag}
                                        </button>
                                    ))}
                                </div>
                            </div>
                        </div>

                        <div className="pt-2">
                            <button
                                type="button"
                                onClick={() => setShowMailPreview(true)}
                                className="w-full py-2.5 bg-white border border-slate-200 text-slate-700 rounded-lg font-medium text-sm hover:bg-slate-50 flex justify-center items-center gap-2 shadow-sm"
                            >
                                <Eye size={16} />
                                Preview Email
                            </button>
                        </div>
                    </div>
                )}
            </div>

            <button 
                onClick={() => {
                  if (!newExam.title || !newExam.questions?.length) {
                    alert("Please add a title and at least one question to preview.");
                    return;
                  }
                  setShowPreview(true);
                }}
                disabled={!newExam.title || !newExam.questions?.length}
                className="w-full py-3 bg-white border border-slate-300 text-slate-700 rounded-lg font-semibold hover:bg-slate-50 disabled:bg-slate-100 disabled:text-slate-400 disabled:cursor-not-allowed flex justify-center items-center gap-2 mb-3 shadow-sm"
            >
                <Eye size={18} />
                Preview Exam
            </button>
            <button
              onClick={handleSaveExam}
              disabled={!newExam.title || !newExam.questions?.length || savingExam}
              className="w-full py-3 lsc-button-primary disabled:bg-slate-300 disabled:cursor-not-allowed flex justify-center items-center gap-2"
            >
              {savingExam ? <Loader2 size={18} className="animate-spin" /> : <Save size={18} />}
              {savingExam ? 'Saving…' : 'Save Exam'}
            </button>
            {(!newExam.title || !newExam.questions?.length) && (
              // The disabled button gave no hint as to why it could not be clicked.
              <p className="text-xs text-slate-500 text-center">
                Add a title and at least one question to save.
              </p>
            )}
          </div>

          {/* Right Col: Questions */}
          <div className="lg:col-span-2 space-y-6">
             <div className={`lsc-panel overflow-hidden relative ${isPublished ? 'opacity-60 grayscale pointer-events-none select-none' : ''}`}>
                
                {isPublished && (
                    <div className="absolute inset-0 z-50 flex items-center justify-center bg-slate-50/20 backdrop-blur-[1px]">
                       <div className="bg-white px-4 py-2 rounded-full shadow-lg border border-slate-200 text-sm font-bold text-slate-500 flex items-center gap-2">
                         <Lock size={16} /> Questions Locked
                       </div>
                    </div>
                )}

                <div className="p-4 bg-slate-50 border-b border-slate-100 flex items-center gap-2">
                  <Plus size={18} className="text-slate-500" />
                  <h3 className="font-semibold text-slate-800">Add Questions</h3>
                </div>
                
                <div className="p-6 space-y-8">
                  {/* Manual Entry Form */}
                  <div className="space-y-4">
                     <div className="flex justify-between items-center">
                        <h4 className="text-sm font-semibold text-slate-600 uppercase tracking-wide">Manual Entry</h4>
                        
                        {/* Type Selector */}
                        <select
                           aria-label="Question type"
                           value={manualQ.type}
                           onChange={e => setManualQ({ ...manualQDefaults, type: e.target.value as QuestionType })}
                           className="px-3 py-1.5 border border-slate-200 rounded-lg text-xs font-medium bg-white outline-none"
                        >
                           <option value={QuestionType.MCQ}>Multiple Choice (single)</option>
                           <option value={QuestionType.MULTI_SELECT}>Multiple Select (checkbox)</option>
                           <option value={QuestionType.TRUE_FALSE}>True / False</option>
                           <option value={QuestionType.YES_NO}>Yes / No</option>
                           <option value={QuestionType.SHORT_TEXT}>Short Text Answer</option>
                           <option value={QuestionType.LONG_TEXT}>Long Text / Essay</option>
                           <option value={QuestionType.FILL_BLANK}>Fill in the Blank</option>
                           <option value={QuestionType.NUMERIC}>Numeric Answer</option>
                           <option value={QuestionType.DATE}>Date Answer</option>
                           <option value={QuestionType.TIME}>Time Answer</option>
                           <option value={QuestionType.MATCHING}>Matching</option>
                           <option value={QuestionType.ORDERING}>Ordering / Sequence</option>
                           <option value={QuestionType.DRAG_DROP}>Drag and Drop</option>
                        </select>
                     </div>
                     
                     <div>
                       <label className="block text-sm text-slate-600 mb-1">Question Text</label>
                       <textarea 
                          className="w-full p-3 border rounded-lg outline-none"
                          rows={2}
                          placeholder={manualQ.type === QuestionType.FILL_BLANK ? "e.g. The capital of France is _______." : "e.g. What is the complexity of binary search?"}
                          value={manualQ.text}
                          onChange={e => setManualQ({...manualQ, text: e.target.value})}
                       />
                       {manualQ.type === QuestionType.FILL_BLANK && (
                           <p className="text-[10px] text-slate-400 mt-1">
                               Tip: use underscores (____) in the text to show each blank. Add one "accepted answers" row per blank below.
                           </p>
                       )}
                     </div>
                     
                     {/* ---- Per-type answer editor ---- */}
                     {renderQuestionTypeEditor()}

                     <div className="flex gap-4">
                       <div className="w-24">
                         <label className="block text-sm text-slate-600 mb-1">Marks</label>
                         <input
                            type="number"
                            className="w-full px-3 py-2 border rounded-lg outline-none"
                            min="1"
                            value={manualQ.marks}
                            onChange={e => setManualQ({...manualQ, marks: Number(e.target.value)})}
                         />
                       </div>
                       {manualQ.type !== QuestionType.SHORT_TEXT && manualQ.type !== QuestionType.LONG_TEXT && (
                         <div className="w-32">
                           <label className="block text-sm text-slate-600 mb-1">Negative marks</label>
                           <input
                              type="number"
                              className="w-full px-3 py-2 border rounded-lg outline-none"
                              min="0"
                              step="0.25"
                              placeholder="0"
                              value={manualQ.negativeMarks}
                              onChange={e => setManualQ({...manualQ, negativeMarks: Number(e.target.value)})}
                           />
                           <p className="text-[11px] text-slate-400 mt-1">Deducted if wrong. 0 = off</p>
                         </div>
                       )}
                       {(manualQ.type === QuestionType.SHORT_TEXT || manualQ.type === QuestionType.LONG_TEXT) && (
                         <div className="w-32">
                           <label className="block text-sm text-slate-600 mb-1">Word limit</label>
                           <input
                              type="number"
                              className="w-full px-3 py-2 border rounded-lg outline-none"
                              min="1"
                              placeholder="No limit"
                              value={manualQ.wordLimit}
                              onChange={e => setManualQ({...manualQ, wordLimit: e.target.value})}
                           />
                           <p className="text-[11px] text-slate-400 mt-1">Blank = no limit</p>
                         </div>
                       )}
                     </div>

                     <button 
                        onClick={handleAddManualQuestion}
                        className="w-full py-2 bg-slate-900 text-white rounded-lg hover:bg-slate-800 transition-colors flex justify-center items-center gap-2"
                     >
                       <Plus size={16} /> Add Question
                     </button>
                  </div>

                  <div className="border-t border-slate-100 pt-6">
                    <div className="flex justify-between items-center mb-4">
                       <h4 className="text-sm font-semibold text-slate-600 uppercase tracking-wide flex items-center gap-2">
                         <FileSpreadsheet size={16} /> Bulk Upload (Excel/CSV)
                       </h4>
                       <button 
                         onClick={downloadTemplate}
                         className="text-blue-600 text-sm hover:underline flex items-center gap-1"
                       >
                         <Download size={14} /> Download Template
                       </button>
                    </div>
                    
                    <div className="border-2 border-dashed border-slate-300 rounded-lg p-6 flex flex-col items-center justify-center bg-slate-50 hover:bg-blue-50 hover:border-blue-300 transition-colors cursor-pointer relative">
                      <input 
                        ref={fileInputRef}
                        type="file" 
                        accept=".csv" 
                        className="absolute inset-0 opacity-0 cursor-pointer"
                        onChange={handleFileUpload}
                      />
                      <Upload size={32} className="text-slate-400 mb-2" />
                      <p className="text-sm text-slate-600 font-medium">Click to upload CSV</p>
                    </div>
                    <p className="mt-2 text-xs text-slate-500">
                      Supports MCQ, Multi-Select, True/False, Yes/No, Short/Long Text, Fill-Blank, Numeric, Date &amp; Time.
                      The template explains each column. Matching, Ordering &amp; Drag-Drop use the manual editor.
                    </p>

                    {/* Upload Status Messages */}
                    {uploadStatus === 'SUCCESS' && (
                      <div className="mt-3 p-3 bg-teal-50 text-teal-700 text-sm rounded-lg flex items-center gap-2 border border-teal-100">
                        <CheckCircle size={16} /> {uploadMsg}
                      </div>
                    )}
                    {uploadStatus === 'PARTIAL' && (
                      <div className="mt-3 p-3 bg-orange-50 text-orange-800 text-sm rounded-lg flex items-center gap-2 border border-orange-100">
                        <FileWarning size={16} /> {uploadMsg}
                      </div>
                    )}
                    {uploadStatus === 'ERROR' && (
                      <div className="mt-3 p-3 bg-red-50 text-red-700 text-sm rounded-lg flex items-center gap-2 border border-red-100">
                        <AlertCircle size={16} /> {uploadMsg}
                      </div>
                    )}

                    {/* Detailed Error Report */}
                    {csvErrors.length > 0 && (
                      <div className="mt-4 bg-red-50 rounded-lg border border-red-100 overflow-hidden">
                        <div className="px-4 py-2 bg-red-100 border-b border-red-200 flex items-center gap-2 text-red-800 text-xs font-bold uppercase">
                          <XCircle size={14} /> Failed Rows ({csvErrors.length})
                        </div>
                        <div className="max-h-40 overflow-auto lsc-table-wrap">
                          <table className="w-full text-left text-xs">
                             <thead className="bg-red-100/50 text-red-700">
                               <tr>
                                 <th className="px-4 py-2 w-16">Row</th>
                                 <th className="px-4 py-2">Error</th>
                                 <th className="px-4 py-2 text-slate-500">Raw Data (Truncated)</th>
                               </tr>
                             </thead>
                             <tbody className="divide-y divide-red-100">
                               {csvErrors.map((err, i) => (
                                 <tr key={i} className="hover:bg-red-100/40 transition-colors">
                                   <td className="px-4 py-2 font-mono text-red-600 font-semibold">{err.row}</td>
                                   <td className="px-4 py-2 text-red-800">{err.message}</td>
                                   <td className="px-4 py-2 text-slate-500 font-mono truncate max-w-xs" title={err.rawData}>
                                     {err.rawData.substring(0, 50)}...
                                   </td>
                                 </tr>
                               ))}
                             </tbody>
                          </table>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
             </div>

             {/* Question List */}
             <div className="space-y-3 max-h-[420px] overflow-y-auto pr-1">
               <h3 className="font-semibold text-slate-800 sticky top-0 bg-white/90 backdrop-blur z-10 py-2">
                 Questions ({newExam.questions?.length || 0})
               </h3>
               {questionPaging.pageItems.map((q, pageIdx) => {
                 // Numbering must stay global — Q1 is the first question of the exam, not of the page.
                 const idx = questionPaging.page * questionPaging.pageSize + pageIdx;
                 return (
                 <div key={q.id} className="bg-white p-4 rounded-lg border border-slate-200 shadow-sm relative group">
                   {!isPublished && (
                     // Hover-only reveal left the delete control invisible on touch screens and to
                     // keyboard users; it now stays visible on small screens and on focus.
                     <div className="absolute top-4 right-4 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                       <button
                         onClick={() => removeQuestion(q.id)}
                         className="text-red-500 hover:bg-red-50 p-1 rounded transition-colors"
                         aria-label={`Delete question ${idx + 1}`}
                         title="Delete question"
                       >
                         <Trash2 size={16} />
                       </button>
                     </div>
                   )}
                   <div className="flex gap-3 mb-2 flex-wrap items-center">
                     <span className="bg-slate-100 text-slate-600 px-2 py-0.5 rounded text-xs font-mono">Q{idx + 1}</span>
                     <span className="bg-blue-50 text-blue-600 px-2 py-0.5 rounded text-xs font-mono">{q.type}</span>
                     <span className="bg-teal-50 text-teal-600 px-2 py-0.5 rounded text-xs font-mono">{q.marks} marks</span>
                     {q.type !== QuestionType.SHORT_TEXT && q.type !== QuestionType.LONG_TEXT && q.type !== QuestionType.TEXT && (
                       // Editable in place, same reasoning as the word-limit field below: a penalty
                       // often gets tuned while reviewing the paper, not just at authoring time.
                       <span className="flex items-center gap-1 text-xs text-slate-500">
                         <span className="uppercase tracking-widest text-[10px]">Negative marks</span>
                         <input
                           type="number"
                           min="0"
                           step="0.25"
                           placeholder="0"
                           disabled={isPublished}
                           value={q.negativeMarks ?? 0}
                           onChange={e => {
                             const parsed = parseFloat(e.target.value);
                             setNewExam(prev => ({
                               ...prev,
                               questions: (prev.questions || []).map(item =>
                                 item.id === q.id
                                   ? { ...item, negativeMarks: parsed > 0 ? parsed : 0 }
                                   : item
                               ),
                             }));
                           }}
                           className="w-16 px-2 py-0.5 border border-slate-200 rounded text-xs bg-white disabled:bg-slate-50"
                         />
                       </span>
                     )}
                     {(q.type === QuestionType.SHORT_TEXT || q.type === QuestionType.LONG_TEXT || q.type === QuestionType.TEXT) && (
                       // Editable in place: the cap is the kind of thing that gets adjusted while
                       // reviewing a paper, and re-creating the question to change it would be silly.
                       <span className="flex items-center gap-1 text-xs text-slate-500">
                         <span className="uppercase tracking-widest text-[10px]">Word limit</span>
                         <input
                           type="number"
                           min="1"
                           placeholder="none"
                           disabled={isPublished}
                           value={q.wordLimit ?? ''}
                           onChange={e => {
                             const parsed = parseInt(e.target.value, 10);
                             setNewExam(prev => ({
                               ...prev,
                               questions: (prev.questions || []).map(item =>
                                 item.id === q.id
                                   ? { ...item, wordLimit: parsed > 0 ? parsed : null }
                                   : item
                               ),
                             }));
                           }}
                           className="w-20 px-2 py-0.5 border border-slate-200 rounded text-xs bg-white disabled:bg-slate-50"
                         />
                       </span>
                     )}
                   </div>
                   {useSections && (
                     <div className="flex items-center gap-2 mb-2">
                       <span className="text-[10px] text-slate-500 uppercase tracking-widest">Section</span>
                       <select
                         aria-label={`Section for question ${idx + 1}`}
                         // Moving a question between sections is a question edit — locked once
                         // published, like add/delete and the inline marks fields above.
                         disabled={isPublished}
                         className="px-2 py-1 border border-slate-200 rounded text-xs bg-white disabled:bg-slate-50"
                         value={q.sectionId || sections[0]?.id}
                         onChange={e => {
                           const sectionId = e.target.value;
                           setNewExam(prev => ({
                             ...prev,
                             questions: (prev.questions || []).map(item =>
                               item.id === q.id ? { ...item, sectionId } : item
                             )
                           }));
                         }}
                       >
                         {sections.map(section => (
                           <option key={section.id} value={section.id}>
                             {section.title}
                           </option>
                         ))}
                       </select>
                     </div>
                   )}
                   <p className="text-slate-800 font-medium mb-3 whitespace-pre-wrap">{q.text}</p>
                   {renderAddedQuestionAnswer(q)}
                 </div>
                 );
               })}
               <Pagination state={questionPaging} label="questions" hidePageSize />

               {newExam.questions?.length === 0 && (
                 <div className="text-center py-8 text-slate-400 border-2 border-dashed border-slate-200 rounded-xl">
                   No questions added yet. Use the manual form or upload a CSV.
                 </div>
               )}
             </div>
          </div>
        </div>
      </div>

      {showMailPreview && (() => {
        const mailPreviewExam = {
          ...newExam,
          title: newExam.title || 'Sample Exam',
          startTime: newExam.startTime || Date.now(),
          endTime: newExam.endTime || Date.now() + 3600000,
          durationMinutes: newExam.durationMinutes || 60,
        } as Exam;
        const sampleLink = `${window.location.origin}?token=SAMPLE-TOKEN`;
        const { subject, body } = buildExamEmailContent(
          mailPreviewExam,
          'Sample Student',
          sampleLink,
          mailPreviewMode === 'reminder'
        );
        return (
          <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-900/50 p-4">
            <div className="w-full max-w-2xl max-h-[90vh] rounded-2xl bg-white shadow-xl border border-slate-200 flex flex-col overflow-hidden">
              <div className="p-4 border-b border-slate-100 flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="text-lg font-semibold text-slate-900">Email Preview</h3>
                  <p className="text-sm text-slate-500 mt-0.5 truncate">Subject: <span className="text-slate-700 font-medium">{subject}</span></p>
                </div>
                <button
                  onClick={() => setShowMailPreview(false)}
                  className="shrink-0 p-1.5 rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-600"
                  aria-label="Close preview"
                >
                  <XCircle size={20} />
                </button>
              </div>
              <div className="px-4 pt-3 flex gap-2">
                <button
                  onClick={() => setMailPreviewMode('invite')}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold border ${mailPreviewMode === 'invite' ? 'bg-blue-50 border-blue-200 text-blue-700' : 'bg-white border-slate-200 text-slate-500 hover:bg-slate-50'}`}
                >
                  Invitation
                </button>
                <button
                  onClick={() => setMailPreviewMode('reminder')}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold border ${mailPreviewMode === 'reminder' ? 'bg-blue-50 border-blue-200 text-blue-700' : 'bg-white border-slate-200 text-slate-500 hover:bg-slate-50'}`}
                >
                  Reminder
                </button>
              </div>
              <p className="px-4 pt-2 text-xs text-slate-400">
                Rendered with sample data ("Sample Student"). This is exactly the HTML that will be sent — edit the subject/message above and reopen this preview to see your changes.
              </p>
              <div className="flex-1 min-h-0 p-4">
                <iframe
                  title="Email preview"
                  srcDoc={body}
                  className="w-full h-full min-h-[420px] rounded-lg border border-slate-200 bg-white"
                  sandbox=""
                />
              </div>
            </div>
          </div>
        );
      })()}
      </>
    );
  };
  
  // Per-exam Mail Composer. Audience counts are computed from the loaded recipient list, and the
  // preview is rendered from the SAME builder that sends, so what the admin sees is what goes out.
  const renderMailComposer = () => {
    if (!mailComposer) return null;
    const { exam, kind, subject, message, audience, recipients, loading, saving, error, notice } = mailComposer;
    const reminder = kind === 'REMINDER';
    const targets = filterByAudience(recipients, audience);
    const sample = targets[0] || recipients[0];
    const previewLink = reminder ? '' : `${window.location.origin}?token=SAMPLE-TOKEN`;
    const preview = buildExamEmailContent(exam, sample?.fullName || 'Sample Student', previewLink, reminder, { subject, message });
    const busy = saving || emailSendingId === exam.id;

    return (
      <div className="fixed inset-0 z-[90] flex items-center justify-center bg-slate-900/50 p-4">
        <div className="w-full max-w-5xl max-h-[92vh] rounded-2xl bg-white shadow-xl border border-slate-200 flex flex-col overflow-hidden">
          <div className="p-4 border-b border-slate-100 flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h3 className="text-lg font-semibold text-slate-900">Compose Email</h3>
              <p className="text-sm text-slate-500 mt-0.5 truncate">{exam.title}</p>
            </div>
            <button
              onClick={closeComposer}
              className="shrink-0 p-1.5 rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-600"
              aria-label="Close composer"
            >
              <XCircle size={20} />
            </button>
          </div>

          {/* Stacked on small screens, so the body scrolls as a whole there; side-by-side panes scroll
              independently from lg up. (With overflow-hidden at every size, a phone squeezed the
              editor pane to a sliver above the fixed-height preview.) */}
          <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-2 gap-0 overflow-y-auto lg:overflow-hidden">
            {/* Editor */}
            <div className="min-h-0 overflow-y-auto p-4 space-y-4 border-b lg:border-b-0 lg:border-r border-slate-100">
              <div>
                <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5">Email type</label>
                <div className="flex gap-2">
                  {(['INVITE', 'REMINDER'] as ExamMailKind[]).map(k => (
                    <button
                      key={k}
                      onClick={() => switchComposerKind(k)}
                      className={`px-3 py-1.5 rounded-lg text-xs font-semibold border ${kind === k ? 'bg-blue-50 border-blue-200 text-blue-700' : 'bg-white border-slate-200 text-slate-500 hover:bg-slate-50'}`}
                    >
                      {k === 'INVITE' ? 'Invitation (with link)' : 'Reminder (no link)'}
                    </button>
                  ))}
                </div>
                <p className="text-[11px] text-slate-400 mt-1.5">
                  {reminder
                    ? 'Reminders deliberately carry no access link — students reuse the link from their invitation.'
                    : 'Invitations include each student’s own secure, signed exam link.'}
                </p>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5">Send to</label>
                {loading ? (
                  <div className="flex items-center gap-2 text-sm text-slate-500 py-2">
                    <Loader2 size={14} className="animate-spin" /> Loading recipients…
                  </div>
                ) : (
                  <div className="grid grid-cols-2 gap-2">
                    {MAIL_AUDIENCES.map(opt => {
                      const count = filterByAudience(recipients, opt.id).length;
                      const active = audience === opt.id;
                      return (
                        <button
                          key={opt.id}
                          onClick={() => setMailComposer(prev => (prev ? { ...prev, audience: opt.id } : prev))}
                          className={`text-left px-3 py-2 rounded-lg border transition-colors ${active ? 'bg-blue-50 border-blue-200' : 'bg-white border-slate-200 hover:bg-slate-50'}`}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className={`text-xs font-semibold ${active ? 'text-blue-700' : 'text-slate-700'}`}>{opt.label}</span>
                            <span className={`text-xs font-bold ${active ? 'text-blue-700' : 'text-slate-500'}`}>{count}</span>
                          </div>
                          <p className="text-[11px] text-slate-400 mt-0.5 leading-snug">{opt.hint}</p>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5">Subject</label>
                <input
                  type="text"
                  value={subject}
                  onChange={e => setMailComposer(prev => (prev ? { ...prev, subject: e.target.value, dirty: true, notice: null } : prev))}
                  className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-blue-100 focus:border-blue-300"
                  placeholder={reminder ? 'Reminder — {ExamTitle}' : 'Your Exam Invitation — {ExamTitle}'}
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5">Message</label>
                <textarea
                  value={message}
                  onChange={e => setMailComposer(prev => (prev ? { ...prev, message: e.target.value, dirty: true, notice: null } : prev))}
                  rows={10}
                  className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm font-mono leading-relaxed focus:outline-none focus:ring-2 focus:ring-blue-100 focus:border-blue-300"
                />
                <p className="text-[11px] text-slate-400 mt-1.5">
                  Placeholders: <code>{'{StudentName}'}</code>, <code>{'{ExamTitle}'}</code>, <code>{'{StartTime}'}</code>
                  {!reminder && <> , <code>{'{Link}'}</code></>}. Blank lines start a new paragraph. The exam schedule,
                  duration, device rules and instructions link are added automatically below your message.
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <button
                  onClick={saveComposerTemplate}
                  disabled={busy}
                  className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-slate-200 text-xs font-semibold text-slate-600 hover:bg-slate-50 disabled:opacity-50"
                >
                  <Save size={13} /> Save as default
                </button>
                <button
                  onClick={resetComposerTemplate}
                  disabled={busy}
                  className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-slate-200 text-xs font-semibold text-slate-500 hover:bg-slate-50 disabled:opacity-50"
                >
                  Reset to default
                </button>
                {notice && <span className="text-xs text-teal-600 font-medium">{notice}</span>}
              </div>

              {error && (
                <div className="flex items-start gap-2 p-3 rounded-lg bg-rose-50 border border-rose-100 text-xs text-rose-700">
                  <AlertCircle size={14} className="shrink-0 mt-0.5" /> {error}
                </div>
              )}
            </div>

            {/* Live preview */}
            <div className="min-h-0 flex flex-col p-4">
              <p className="text-xs text-slate-500 mb-2">
                Preview as <span className="font-medium text-slate-700">{sample?.fullName || 'Sample Student'}</span> — exactly the HTML that will be sent.
              </p>
              <iframe
                title="Composed email preview"
                srcDoc={preview.body}
                className="flex-1 w-full min-h-[320px] rounded-lg border border-slate-200 bg-white"
                sandbox=""
              />
            </div>
          </div>

          <div className="p-4 border-t border-slate-100 flex flex-wrap items-center justify-between gap-3 bg-slate-50">
            <p className="text-sm text-slate-600">
              {loading
                ? 'Resolving recipients…'
                : <>Sending to <span className="font-semibold text-slate-900">{targets.length}</span> of {recipients.length} assigned student{recipients.length === 1 ? '' : 's'}</>}
            </p>
            <div className="flex items-center gap-2">
              <button
                onClick={closeComposer}
                className="px-4 py-2 rounded-lg text-sm text-slate-500 hover:bg-slate-100"
              >
                Cancel
              </button>
              <button
                onClick={sendFromComposer}
                disabled={busy || loading || targets.length === 0}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
              >
                {busy ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
                Send to {targets.length}
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  };

  // Render List View (Default)
  return (
    <div className="space-y-6">
      {renderMailComposer()}
      {inviteScopeTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
          <div className="w-full max-w-md rounded-2xl bg-white shadow-xl border border-slate-200">
            <div className="p-5 border-b border-slate-100">
              <h3 className="text-lg font-semibold text-slate-900">Send Invitations</h3>
              <p className="text-sm text-slate-600 mt-1">
                <span className="font-medium text-slate-900">{inviteScopeTarget.pending.length}</span> of{' '}
                {inviteScopeTarget.recipients.length} students assigned to{' '}
                <span className="font-medium text-slate-900">{inviteScopeTarget.exam.title}</span> have not received a link yet.
              </p>
            </div>
            <div className="p-5 space-y-3">
              <button
                onClick={() => {
                  const target = inviteScopeTarget;
                  setInviteScopeTarget(null);
                  dispatchEmails(target.exam, target.pending, false);
                }}
                className="w-full px-4 py-2.5 rounded-lg bg-blue-600 text-white font-medium hover:bg-blue-700"
              >
                Send to {inviteScopeTarget.pending.length} new students only
              </button>
              <button
                onClick={() => {
                  const target = inviteScopeTarget;
                  setInviteScopeTarget(null);
                  dispatchEmails(target.exam, target.recipients, false);
                }}
                className="w-full px-4 py-2.5 rounded-lg border border-slate-200 text-slate-700 hover:bg-slate-50"
              >
                Resend to all {inviteScopeTarget.recipients.length} students
              </button>
              <p className="text-xs text-slate-400 text-center px-2">
                Existing links never change — resending only mails the same link again.
              </p>
              <button
                onClick={() => setInviteScopeTarget(null)}
                className="w-full px-4 py-2.5 rounded-lg text-slate-500 hover:bg-slate-50"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
          <div className="w-full max-w-md rounded-2xl bg-white shadow-xl border border-slate-200">
            <div className="p-5 border-b border-slate-100">
              <h3 className="text-lg font-semibold text-slate-900">Remove Exam</h3>
              <p className="text-sm text-slate-600 mt-1">
                Choose how to remove <span className="font-medium text-slate-900">{deleteTarget.title}</span>.
              </p>
            </div>
            <div className="p-5 space-y-3">
              <button
                onClick={handleArchiveExam}
                disabled={deleteBusy}
                className="w-full px-4 py-2.5 rounded-lg border border-slate-200 text-slate-700 hover:bg-slate-50 disabled:opacity-60"
              >
                Archive (Hide from list)
              </button>
              <button
                onClick={handlePermanentDeleteExam}
                disabled={deleteBusy}
                className="w-full px-4 py-2.5 rounded-lg border border-rose-200 text-rose-600 hover:bg-rose-50 disabled:opacity-60"
              >
                Delete Permanently
              </button>
              <p className="text-xs text-slate-500 text-center px-2">
                Archiving keeps every attempt and result. Deleting permanently also erases all candidate attempts, answers and results for this exam.
              </p>
              <button
                onClick={() => !deleteBusy && setDeleteTarget(null)}
                disabled={deleteBusy}
                className="w-full px-4 py-2.5 rounded-lg text-slate-500 hover:bg-slate-50 disabled:opacity-60"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
      
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="lsc-title">Exam Management</h2>
          <p className="lsc-subtitle mt-1">Create, duplicate, and publish exams with full security controls.</p>
        </div>
        <div className="flex flex-wrap gap-2 items-center">
          {isSuperAdmin && (
            <select
              value={selectedCompanyId}
              onChange={e => setSelectedCompanyId(e.target.value === '' ? '' : Number(e.target.value))}
              className="px-3 py-2 border border-slate-200 rounded-lg bg-white text-sm outline-none min-w-[200px]"
              title="Select a company to manage its exams"
            >
              <option value="">Select a company…</option>
              {companies.map(company => (
                <option key={company.id} value={company.id}>{company.name}</option>
              ))}
            </select>
          )}
          <input
            ref={examImportRef}
            type="file"
            accept=".json"
            className="hidden"
            onChange={e => {
              const file = e.target.files?.[0];
              if (file) {
                importExams(file);
              }
              if (examImportRef.current) examImportRef.current.value = '';
            }}
          />
          {archivedCount > 0 && (
            <button
              onClick={() => setShowArchived(v => !v)}
              aria-pressed={showArchived}
              className="px-4 py-2 lsc-button-ghost flex items-center gap-2 text-sm"
            >
              {showArchived ? 'Hide archived' : `Show archived (${archivedCount})`}
            </button>
          )}
          <button
            onClick={() => examImportRef.current?.click()}
            // Same gate as Create: with no company picked, a super admin's import would land in
            // whatever company the request headers resolve to and never appear in this (empty) grid.
            disabled={isSuperAdmin && !effectiveCompanyId}
            className="px-4 py-2 lsc-button-ghost flex items-center gap-2 text-sm disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Upload size={16} /> Import
          </button>
          <button
            onClick={exportExams}
            className="px-4 py-2 lsc-button-ghost flex items-center gap-2 text-sm"
          >
            <Download size={16} /> Export
          </button>
          <button
            onClick={() => { resetForm(); setIsCreating(true); }}
            disabled={isSuperAdmin && !effectiveCompanyId}
            className="px-4 py-2 lsc-button-primary flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Plus size={20} /> Create Exam
          </button>
        </div>
      </div>

      {isSuperAdmin && !effectiveCompanyId ? (
        <div className="bg-white rounded-xl border border-dashed border-slate-300 p-10 text-center text-slate-500">
          Select a company above to view and manage its exams.
        </div>
      ) : isSuperAdmin && superExamsLoading ? (
        <div className="bg-white rounded-xl border border-slate-200 p-10 text-center text-slate-500">
          Loading exams…
        </div>
      ) : visibleExams.length === 0 ? (
        // An empty grid used to render as blank space with no hint of what to do next.
        <div className="bg-white rounded-xl border border-dashed border-slate-300 p-10 text-center text-slate-500">
          {exams.length === 0
            ? 'No exams yet. Click “Create Exam” to build your first one.'
            : 'All exams are archived. Use “Show archived” to view them.'}
        </div>
      ) : (
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {examPaging.pageItems.map(exam => (
          <div
            key={exam.id}
            onClick={() => handleEditExam(exam)}
            className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden hover:shadow-md transition-shadow cursor-pointer group"
          >
            <div className="p-5 border-b border-slate-100 relative">
              <div className="flex justify-between items-start mb-2">
                <span className={`px-2 py-1 text-xs font-bold rounded uppercase tracking-wide ${
                  exam.status === 'PUBLISHED' ? 'bg-teal-100 text-teal-700' :
                  exam.status === 'DRAFT' ? 'bg-orange-100 text-orange-700' : 'bg-slate-100 text-slate-600'
                }`}>
                  {exam.status}
                </span>
                <button
                  onClick={e => {
                    e.stopPropagation();
                    handleDeleteExam(exam);
                  }}
                  className="p-1 rounded-full text-rose-400 hover:text-rose-600 hover:bg-rose-50 transition-colors"
                  title="Delete exam"
                  aria-label={`Delete exam ${exam.title}`}
                >
                  <Trash2 size={16} />
                </button>
              </div>
              <h3 className="font-bold text-slate-800 text-lg truncate" title={exam.title}>{exam.title}</h3>
              <div className="flex items-center gap-4 mt-3 text-sm text-slate-500">
                <div className="flex items-center gap-1"><Clock size={14}/> {exam.durationMinutes}m</div>
                {/* Individually assigned students (no batch) were shown as "All", though only they get mailed. */}
                <div className="flex items-center gap-1"><Users size={14}/> {exam.assignedBatchIds?.length
                  ? `${exam.assignedBatchIds.length} batches`
                  : exam.assignedStudentIds?.length ? `${exam.assignedStudentIds.length} students` : 'All'}</div>
                {!!exam.pendingInviteCount && (
                  <div
                    className="flex items-center gap-1 text-amber-600 font-medium"
                    title={`${exam.pendingInviteCount} assigned students have not been sent a link yet`}
                  >
                    <Mail size={14}/> {exam.pendingInviteCount} to invite
                  </div>
                )}
                {!!exam.notAttemptedCount && (
                  <div
                    className="flex items-center gap-1 text-rose-600 font-medium"
                    title={`${exam.notAttemptedCount} assigned students have not attempted this exam yet`}
                  >
                    <Bell size={14}/> {exam.notAttemptedCount} not attempted
                  </div>
                )}
              </div>
              <div className="flex items-center gap-1 mt-2 text-xs text-slate-400 truncate" title={formatScheduleShort(exam.startTime, resolveExamTimezone(exam.timezone))}>
                <Calendar size={12}/> {formatScheduleShort(exam.startTime, resolveExamTimezone(exam.timezone))}
              </div>
            </div>
            <div className="bg-slate-50 px-3 py-2">
              <div className="flex flex-wrap items-center justify-center gap-2 sm:gap-3">
                <button
                  onClick={e => {
                    e.stopPropagation();
                    handleEditExam(exam);
                  }}
                  className="inline-flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-white/80 text-[11px] sm:text-xs font-medium text-slate-600 hover:text-blue-600 hover:bg-white shadow-xs"
                >
                  <Pencil size={12} /> Edit
                </button>
                <button
                  onClick={e => {
                    e.stopPropagation();
                    handleDuplicateExam(exam);
                  }}
                  disabled={!!duplicatingId}
                  className="inline-flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-white/80 text-[11px] sm:text-xs font-medium text-slate-600 hover:text-blue-600 hover:bg-white disabled:opacity-50 shadow-xs"
                >
                  {duplicatingId === exam.id ? <Loader2 size={12} className="animate-spin" /> : <Copy size={12} />} Duplicate
                </button>
                <button
                  onClick={e => {
                    e.stopPropagation();
                    handleSendEmail(exam);
                  }}
                  disabled={!!emailSendingId}
                  className="inline-flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-white/80 text-[11px] sm:text-xs font-medium text-slate-600 hover:text-blue-600 hover:bg-white disabled:opacity-50 shadow-xs"
                >
                  {emailSendingId === exam.id && sendingMode === 'notify' ? <Loader2 size={12} className="animate-spin"/> : <Mail size={12} />}
                  Notify
                </button>
                <button
                  onClick={e => {
                    e.stopPropagation();
                    // Opens the composer pre-set to chase the students who never attempted, with the
                    // subject/message editable per exam before anything goes out.
                    openMailComposer(exam, 'REMINDER');
                  }}
                  disabled={!!emailSendingId}
                  className="inline-flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-white/80 text-[11px] sm:text-xs font-medium text-slate-600 hover:text-amber-600 hover:bg-white disabled:opacity-50 shadow-xs"
                >
                  {emailSendingId === exam.id && sendingMode === 'reminder' ? <Loader2 size={12} className="animate-spin"/> : <Bell size={12} />}
                  Reminder
                </button>
                <button
                  onClick={e => {
                    e.stopPropagation();
                    handleExportLinks(exam);
                  }}
                  disabled={!!exportingLinksId}
                  className="inline-flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-white/80 text-[11px] sm:text-xs font-medium text-slate-600 hover:text-blue-600 hover:bg-white disabled:opacity-50 shadow-xs"
                >
                  {exportingLinksId === exam.id ? <Loader2 size={12} className="animate-spin" /> : <Share2 size={12} />} Links
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>
      )}
      {/* Guarded on totalPages so a single page of exams doesn't leave an empty panel behind. */}
      {examPaging.totalPages > 1 && !(isSuperAdmin && (!effectiveCompanyId || superExamsLoading)) && (
        <div className="lsc-panel overflow-hidden">
          <Pagination state={examPaging} label="exams" />
        </div>
      )}
    </div>
  );
};
