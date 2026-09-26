// Shared timezone utilities for exam scheduling.
//
// Exam start/end are stored as absolute instants (ms since epoch). A timezone is
// purely a display/entry concern: it decides which wall-clock time an instant is
// shown as, and how a wall-clock time typed into the scheduler maps back to an
// instant. All formatting/parsing here is IANA-timezone aware via Intl so it stays
// correct across DST without any hard-coded offsets.

export interface ExamTimezone {
  value: string; // IANA zone id, e.g. "Asia/Riyadh"
  label: string; // shown in the dropdown, e.g. "(GMT+3:00) Riyadh, Saudi Arabia"
  name: string;  // short display name used in emails/labels, e.g. "Riyadh Time"
}

// Curated list of common exam timezones, ordered west → east by nominal offset.
export const EXAM_TIMEZONES: ExamTimezone[] = [
  { value: 'Pacific/Honolulu',    label: '(GMT-10:00) Hawaii',                     name: 'Hawaii Time' },
  { value: 'America/Anchorage',   label: '(GMT-9:00) Alaska',                      name: 'Alaska Time' },
  { value: 'America/Los_Angeles', label: '(GMT-8:00) US & Canada — Pacific',       name: 'US Pacific Time' },
  { value: 'America/Denver',      label: '(GMT-7:00) US & Canada — Mountain',      name: 'US Mountain Time' },
  { value: 'America/Chicago',     label: '(GMT-6:00) US & Canada — Central',       name: 'US Central Time' },
  { value: 'America/New_York',    label: '(GMT-5:00) US & Canada — Eastern',       name: 'US Eastern Time' },
  { value: 'America/Sao_Paulo',   label: '(GMT-3:00) Brazil (São Paulo)',          name: 'Brasília Time' },
  { value: 'Etc/UTC',             label: '(GMT+0:00) GMT / UTC',                   name: 'GMT' },
  { value: 'Europe/London',       label: '(GMT+0:00) London, Dublin',              name: 'UK Time' },
  { value: 'Europe/Paris',        label: '(GMT+1:00) Central Europe (Paris)',      name: 'Central Europe Time' },
  { value: 'Europe/Athens',       label: '(GMT+2:00) Eastern Europe (Athens)',     name: 'Eastern Europe Time' },
  { value: 'Asia/Riyadh',         label: '(GMT+3:00) Riyadh, Saudi Arabia',        name: 'Riyadh Time' },
  { value: 'Asia/Dubai',          label: '(GMT+4:00) Dubai, Abu Dhabi (UAE)',      name: 'Gulf Time' },
  { value: 'Asia/Karachi',        label: '(GMT+5:00) Pakistan',                    name: 'Pakistan Time' },
  { value: 'Asia/Kolkata',        label: '(GMT+5:30) India, Sri Lanka',            name: 'India Time' },
  { value: 'Asia/Dhaka',          label: '(GMT+6:00) Bangladesh',                  name: 'Bangladesh Time' },
  { value: 'Asia/Bangkok',        label: '(GMT+7:00) Thailand, Vietnam',           name: 'Indochina Time' },
  { value: 'Asia/Singapore',      label: '(GMT+8:00) Singapore, China, Malaysia',  name: 'Singapore Time' },
  { value: 'Asia/Tokyo',          label: '(GMT+9:00) Japan, Korea',                name: 'Japan Time' },
  { value: 'Australia/Sydney',    label: '(GMT+10:00) Sydney, Melbourne',          name: 'Sydney Time' },
  { value: 'Pacific/Auckland',    label: '(GMT+12:00) New Zealand',                name: 'New Zealand Time' },
];

// Zone used when an exam has no timezone stored (legacy exams / new default).
export const DEFAULT_EXAM_TIMEZONE = 'Asia/Kolkata'; // IST — India Standard Time

const TZ_BY_VALUE = new Map(EXAM_TIMEZONES.map(tz => [tz.value, tz]));

// Resolve a stored zone id to a valid one, falling back to the default.
export function resolveExamTimezone(tz?: string | null): string {
  if (tz && isValidTimeZone(tz)) return tz;
  return DEFAULT_EXAM_TIMEZONE;
}

function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// Friendly short name for a zone (e.g. "Riyadh Time"). Falls back to the live
// GMT-offset abbreviation for zones outside the curated list.
export function timezoneName(tz: string): string {
  const known = TZ_BY_VALUE.get(tz);
  if (known) return known.name;
  return gmtAbbrev(Date.now(), tz);
}

// Live "GMT+3"-style abbreviation for an instant in a zone (DST-aware).
function gmtAbbrev(epoch: number, tz: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, timeZoneName: 'shortOffset', hour: 'numeric',
    }).formatToParts(new Date(epoch));
    return parts.find(p => p.type === 'timeZoneName')?.value ?? tz;
  } catch {
    return tz;
  }
}

// Offset (in minutes, positive = ahead of UTC) of a zone at a given instant.
function tzOffsetMinutes(epoch: number, tz: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const map: Record<string, string> = {};
  for (const p of dtf.formatToParts(new Date(epoch))) {
    if (p.type !== 'literal') map[p.type] = p.value;
  }
  const asUTC = Date.UTC(+map.year, +map.month - 1, +map.day, +map.hour, +map.minute, +map.second);
  return Math.round((asUTC - epoch) / 60000);
}

// Convert a <input type="datetime-local"> value ("YYYY-MM-DDTHH:mm"), interpreted
// as wall-clock time in `tz`, to an absolute epoch (ms). Iterates once to stay
// correct across DST transitions.
export function zonedInputToEpoch(input: string, tz: string): number {
  const m = input.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return NaN;
  const y = +m[1], mo = +m[2], d = +m[3], h = +m[4], mi = +m[5];
  const utcGuess = Date.UTC(y, mo - 1, d, h, mi);
  const off1 = tzOffsetMinutes(utcGuess, tz);
  let epoch = utcGuess - off1 * 60000;
  const off2 = tzOffsetMinutes(epoch, tz);
  if (off2 !== off1) epoch = utcGuess - off2 * 60000;
  return epoch;
}

// Convert an epoch (ms) to a <input type="datetime-local"> value ("YYYY-MM-DDTHH:mm")
// showing the wall-clock time in `tz`.
export function epochToZonedInput(epoch: number, tz: string): string {
  const dtf = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  });
  const map: Record<string, string> = {};
  for (const p of dtf.formatToParts(new Date(epoch))) {
    if (p.type !== 'literal') map[p.type] = p.value;
  }
  return `${map.year}-${map.month}-${map.day}T${map.hour}:${map.minute}`;
}

// "13 July 2026"
export function formatDateInZone(epoch: number, tz: string): string {
  return new Date(epoch).toLocaleDateString('en-GB', {
    day: 'numeric', month: 'long', year: 'numeric', timeZone: tz,
  });
}

// "3:30 AM"
export function formatTimeInZone(epoch: number, tz: string): string {
  return new Date(epoch).toLocaleTimeString('en-US', {
    hour: 'numeric', minute: '2-digit', hour12: true, timeZone: tz,
  });
}

// "Monday"
export function formatWeekdayInZone(epoch: number, tz: string): string {
  return new Date(epoch).toLocaleDateString('en-US', { weekday: 'long', timeZone: tz });
}

// "13 July 2026, 3:30 AM"
export function formatDateTimeInZone(epoch: number, tz: string): string {
  return `${formatDateInZone(epoch, tz)}, ${formatTimeInZone(epoch, tz)}`;
}

// "13 July 2026, 3:30 AM (Riyadh Time) (Monday)" — the full labelled form used in emails.
export function formatScheduleLabel(epoch: number, tz: string): string {
  return `${formatDateTimeInZone(epoch, tz)} (${timezoneName(tz)}) (${formatWeekdayInZone(epoch, tz)})`;
}

// Compact "13 July 2026, 3:30 AM · Riyadh Time" for cards/tables.
export function formatScheduleShort(epoch: number, tz: string): string {
  return `${formatDateTimeInZone(epoch, tz)} · ${timezoneName(tz)}`;
}
