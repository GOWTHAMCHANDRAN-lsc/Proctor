/**
 * Collapsing repeated violation events into real INCIDENTS.
 *
 * The detectors re-report a problem for as long as it persists: NO_FACE fires roughly every 10s and
 * the virtual proctor's behavioural patterns (extended absence, repeated glances, talking alone)
 * re-fire on their own cooldowns. So ONE continuous incident — a candidate whose webcam is showing a
 * placeholder image for 19 minutes — lands in the database as 100+ rows.
 *
 * Displaying those rows one-per-line makes every screen unreadable and, worse, makes an honest
 * camera glitch look like a hundred separate offences while burying the events that actually matter
 * (a phone, a second face, a tab switch). Every admin surface therefore groups events into episodes
 * through THIS function, so "how many incidents" means the same thing everywhere.
 */

/** Events older than this since the last hit of an open episode start a genuinely NEW incident. */
export const EPISODE_GAP_MS = 60_000;

export interface EpisodeSource {
  timestamp: number;
  type: string;
  description?: string;
  snapshot?: string | null;
  metadata?: Record<string, any> | null;
  /** Scope: events are only merged within the same exam attempt. */
  sessionId?: number | null;
  studentId?: string;
  examId?: string;
}

export interface ViolationEpisode<T extends EpisodeSource = EpisodeSource> {
  key: string;
  type: string;
  /** When the incident began, and when it was last still happening. */
  startTs: number;
  endTs: number;
  /** How many raw events this incident produced. */
  count: number;
  /** How long it went on for. 0 for a one-off. */
  durationMs: number;
  description: string;
  snapshot?: string | null;
  /** The first raw event — use it for seeking, severity and drill-down. */
  first: T;
  /** The most recent raw event. Its wording carries the elapsed time for sustained incidents. */
  last: T;
}

/**
 * Group raw violation events into episodes.
 *
 * Events are merged when they share a scope (one exam attempt), a type, AND a behavioural pattern,
 * and land within `gapMs` of the running episode. Grouping is keyed per behaviour rather than by
 * simple adjacency because while a camera is blind, NO_FACE and the absence pattern interleave —
 * each would otherwise keep chopping the other's run into fragments.
 *
 * `input` need not be sorted. The result is ordered oldest-first.
 */
export function groupViolationEpisodes<T extends EpisodeSource>(
  input: readonly T[],
  gapMs: number = EPISODE_GAP_MS,
): ViolationEpisode<T>[] {
  const sorted = [...input].sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
  const episodes: ViolationEpisode<T>[] = [];
  const open = new Map<string, ViolationEpisode<T>>();

  for (const v of sorted) {
    // Distinct behaviours must stay distinct: "talking alone" and "extended absence" are both
    // SUSPICIOUS_BEHAVIOR, but they are different incidents and must not be lumped together.
    const pattern = (v.metadata?.pattern as string | undefined) ?? '';
    // Never merge across candidates or attempts, even when the feed is global.
    const scope = v.sessionId != null ? `s${v.sessionId}` : `${v.examId ?? ''}|${v.studentId ?? ''}`;
    const key = `${scope}::${v.type}::${pattern}`;

    const cur = open.get(key);
    if (cur && (v.timestamp - cur.endTs) <= gapMs) {
      cur.endTs = v.timestamp;
      cur.durationMs = cur.endTs - cur.startTs;
      cur.count += 1;
      cur.last = v;
      // The latest wording describes the incident as a whole ("away for 1152 seconds") rather than
      // just its first second.
      if (v.description) cur.description = v.description;
      // Keep the FIRST snapshot: it shows what the camera looked like when the problem began.
      if (!cur.snapshot && v.snapshot) cur.snapshot = v.snapshot;
      continue;
    }

    const episode: ViolationEpisode<T> = {
      key,
      type: v.type,
      startTs: v.timestamp,
      endTs: v.timestamp,
      count: 1,
      durationMs: 0,
      description: v.description ?? '',
      snapshot: v.snapshot ?? null,
      first: v,
      last: v,
    };
    open.set(key, episode);
    episodes.push(episode);
  }

  return episodes;
}

/** True when an episode is a sustained problem rather than a one-off event. */
export const isSustained = (ep: ViolationEpisode<any>): boolean => ep.count > 1 && ep.durationMs >= 1000;

/** "45s" / "3m" / "19m 24s" */
export const formatEpisodeDuration = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r ? `${m}m ${r}s` : `${m}m`;
};
