// Friction detectors, DOM-free so node:test can drive them with plain numbers.
// signals-dom.ts feeds them real clicks and reports what they decide.

export interface ClickPoint {
  x: number;
  y: number;
  ts: number;
  /** Identity of the clicked element (one key per DOM node), so a burst on one button counts even if the mouse drifts. */
  target: string;
}

/**
 * Rage click: RAGE_MIN_CLICKS clicks on the same element (or within RAGE_RADIUS_PX of the first)
 * inside RAGE_WINDOW_MS; once it is rage, the burst goes on while clicks keep coming less than
 * RAGE_WINDOW_MS apart. Only clicks on elements that promise something are fed (see signals-dom),
 * so selecting text with a triple click is not rage.
 */
export const RAGE_MIN_CLICKS = 3;
export const RAGE_WINDOW_MS = 1000;
export const RAGE_RADIUS_PX = 30;

export interface RageBurst {
  first: ClickPoint;
  count: number;
  lastTs: number;
  /** Last click of the burst, so a burst too slow to become rage can slide forward. */
  last: ClickPoint;
}

/**
 * Feeds clicks in order. `onClick` returns "trigger" on the click that turns a burst
 * into a rage click (the 3rd), so recording starts right away; the finished burst
 * (with its final count) comes out of `onClick` of the next unrelated click, of
 * `interrupt()`, or of `flush(now)` once the window has passed.
 */
export class RageDetector {
  private burst: RageBurst | null = null;

  onClick(c: ClickPoint): { trigger: boolean; finished: RageBurst | null } {
    const b = this.burst;
    if (b && c.ts - b.lastTs <= RAGE_WINDOW_MS && near(b.first, c)) {
      if (b.count >= RAGE_MIN_CLICKS || c.ts - b.first.ts <= RAGE_WINDOW_MS) {
        b.count++;
        b.lastTs = c.ts;
        b.last = c;
        return { trigger: b.count === RAGE_MIN_CLICKS, finished: null };
      }
      // Steady clicking slower than the window: restart from the previous click (2 clicks so far).
      this.burst = { first: b.last, count: 2, lastTs: c.ts, last: c };
      return { trigger: false, finished: null };
    }
    const finished = b && b.count >= RAGE_MIN_CLICKS ? b : null;
    this.burst = { first: c, count: 1, lastTs: c.ts, last: c };
    return { trigger: false, finished };
  }

  /** A click that cannot be rage (text, background, a field) ends the current burst. */
  interrupt(): RageBurst | null {
    const b = this.burst;
    this.burst = null;
    return b && b.count >= RAGE_MIN_CLICKS ? b : null;
  }

  /** The burst that ended (quiet for the window) before `now`, if it was a rage click. */
  flush(now: number): RageBurst | null {
    const b = this.burst;
    if (!b || now - b.lastTs <= RAGE_WINDOW_MS) return null;
    this.burst = null;
    return b.count >= RAGE_MIN_CLICKS ? b : null;
  }

  /** Clicks of the current burst so far (a rage burst is not also a dead click). */
  currentCount(): number {
    return this.burst?.count ?? 0;
  }
}

function near(a: ClickPoint, b: ClickPoint): boolean {
  if (a.target && a.target === b.target) return true;
  return Math.abs(a.x - b.x) <= RAGE_RADIUS_PX && Math.abs(a.y - b.y) <= RAGE_RADIUS_PX;
}

/** How long after a click something must happen for the click not to be "dead". */
export const DEAD_CLICK_WAIT_MS = 500;

export interface ClickTargetFacts {
  /** Lowercase tag name of the clicked element. */
  tag: string;
  /** The element or an ancestor is a link/button/[role=button…]/[onclick]/summary. */
  insideInteractive: boolean;
  /** Text fields, selects, labels, contenteditable: a click there focuses, nothing else to expect. */
  isFormField: boolean;
  /** Computed cursor is "pointer": the page tells the user it is clickable. */
  pointerCursor: boolean;
  /** Text is selected after the click (the user was selecting, not clicking). */
  hasSelection: boolean;
}

/**
 * A click can only be dead when the element promised something: it is (inside) an
 * interactive element or shows a pointer cursor. A click on plain text or on a
 * background is not friction, whatever happens after it.
 */
export function isDeadClickCandidate(f: ClickTargetFacts): boolean {
  if (f.isFormField || f.hasSelection) return false;
  if (f.tag === "html" || f.tag === "body") return false;
  return f.insideInteractive || f.pointerCursor;
}

export interface AfterClickReaction {
  /** DOM mutations observed in the wait window. */
  mutations: number;
  urlChanged: boolean;
  scrolled: boolean;
  focusChanged: boolean;
  /** The page is unloading (a navigation or a download started). */
  unloading: boolean;
}

/** Nothing reacted within DEAD_CLICK_WAIT_MS: the click was dead. */
export function isDeadClick(r: AfterClickReaction): boolean {
  return r.mutations === 0 && !r.urlChanged && !r.scrolled && !r.focusChanged && !r.unloading;
}

/** Active time: input gaps up to ACTIVE_GAP_MS count, longer gaps are idle. */
export const ACTIVE_GAP_MS = 5000;

export function activeIncrement(lastInputTs: number, ts: number): number {
  if (!lastInputTs) return 0;
  const gap = ts - lastInputTs;
  return gap > 0 && gap <= ACTIVE_GAP_MS ? gap : 0;
}
