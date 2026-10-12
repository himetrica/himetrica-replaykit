// The pre-trigger ring buffer.
//
// rrweb can only replay from a full snapshot: a Meta event (type 4) followed by a
// FullSnapshot (type 2). The recorder takes one every CHECKOUT_MS, so the buffer can
// always be cut at the last checkout that is older than the window and still start
// with a replayable page. The cut keeps BUFFER_WINDOW_MS..BUFFER_WINDOW_MS+CHECKOUT_MS
// of history before the trigger.

export interface RrEvent {
  type: number;
  timestamp: number;
  data?: unknown;
}

export const EVENT_FULL_SNAPSHOT = 2;
export const EVENT_META = 4;
export const EVENT_CUSTOM = 5;
/** rrweb custom event the SDK adds on SPA URL changes (rrweb only emits Meta on page loads/checkouts). */
export const PAGE_TAG = "replaykit:page";

/**
 * Pages shown in a run of events, in order: Meta hrefs (page loads, and every
 * checkout repeats the current one) plus PAGE_TAG custom events. Query/fragment
 * stripped, back-to-back repeats folded, `prev` = last page already reported for
 * this recording (so a checkout's repeated Meta is not a new page). Capped at `max`.
 */
export function pagesOf(events: RrEvent[], prev: string, max: number): Array<{ url: string; ts: number }> {
  const out: Array<{ url: string; ts: number }> = [];
  let last = prev;
  for (const e of events) {
    let href: unknown;
    if (e.type === EVENT_META) href = (e.data as { href?: unknown } | undefined)?.href;
    else if (e.type === EVENT_CUSTOM) {
      const d = e.data as { tag?: unknown; payload?: { href?: unknown } } | undefined;
      if (d?.tag === PAGE_TAG) href = d.payload?.href;
    }
    if (typeof href !== "string" || !href) continue;
    const cut = href.search(/[?#]/);
    const url = (cut === -1 ? href : href.slice(0, cut)).slice(0, 500);
    if (url === last) continue;
    last = url;
    out.push({ url, ts: e.timestamp });
    if (out.length >= max) break;
  }
  return out;
}

export const BUFFER_WINDOW_MS = 30_000;
export const CHECKOUT_MS = 30_000;

/** Index of the Meta event that opens the snapshot the event list may start from. */
function snapshotStart(events: RrEvent[], i: number): number {
  // rrweb emits Meta right before FullSnapshot; keep the Meta so the player knows the viewport.
  return i > 0 && events[i - 1].type === EVENT_META ? i - 1 : i;
}

/**
 * Drops everything before the most recent full snapshot whose timestamp is at or
 * before `now - windowMs`. If no snapshot is that old, nothing is dropped (the buffer
 * is still shorter than the window). A list that does not start with a snapshot (the
 * head was lost) is cut at its first snapshot, since nothing before it can replay.
 */
export function trimBuffer(events: RrEvent[], now: number, windowMs = BUFFER_WINDOW_MS): RrEvent[] {
  const cutoff = now - windowMs;
  let keepFrom = -1;
  let firstSnapshot = -1;
  for (let i = 0; i < events.length; i++) {
    if (events[i].type !== EVENT_FULL_SNAPSHOT) continue;
    if (firstSnapshot === -1) firstSnapshot = i;
    if (events[i].timestamp <= cutoff) keepFrom = i;
    else break;
  }
  if (keepFrom === -1) keepFrom = firstSnapshot;
  if (keepFrom === -1) return [];
  const start = snapshotStart(events, keepFrom);
  return start === 0 ? events : events.slice(start);
}

/** Rough serialized size, to cut chunks without stringifying on every event. */
export function approxBytes(e: RrEvent): number {
  // Mutations and snapshots dominate; JSON.stringify per event is acceptable: events
  // are stringified once here and the chunk is re-stringified once at flush.
  try {
    return JSON.stringify(e).length;
  } catch {
    return 0;
  }
}
