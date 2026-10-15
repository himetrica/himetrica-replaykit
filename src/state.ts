// Per-session recording state, in sessionStorage so it follows the session across the
// pages of a multi-page site (each page load is a new SDK instance).
//
// Keyed to the tracker session id: when the tracker rolls a new session (30 min idle,
// new UTM...), the stored state belongs to the old one and is discarded.

import type { Env } from "./env";
import type { ReplayKitRecordingStats, ReplayKitTrigger } from "./protocol";

export type StopReason = "quota" | "manual" | "limit" | "off";

export interface SessionState {
  sid: string;
  /** Recording id, set once a trigger fired; absent while only buffering. */
  rid?: string;
  /** Next chunk sequence number to upload. */
  seq: number;
  trigger?: ReplayKitTrigger;
  /** Set when recording must not (re)start for the rest of the session. */
  stopped?: StopReason;
  stats?: ReplayKitRecordingStats;
  /** Visible tab time of the session's earlier pages, for the minimum duration. */
  visibleMs?: number;
  /** Raw JSON already uploaded for this recording (the per-recording size cap). */
  rawBytes?: number;
}

const KEY = "hm_rk_state";

export class StateStore {
  private cache: SessionState | null = null;

  constructor(private readonly env: Env) {}

  load(sid: string): SessionState {
    if (this.cache?.sid === sid) return this.cache;
    let s: SessionState | null = null;
    try {
      const raw = this.env.getSession(KEY);
      if (raw) s = JSON.parse(raw) as SessionState;
    } catch {
      s = null;
    }
    if (!s || s.sid !== sid || typeof s.seq !== "number") s = { sid, seq: 0 };
    this.cache = s;
    return s;
  }

  save(s: SessionState): void {
    this.cache = s;
    try {
      this.env.setSession(KEY, JSON.stringify(s));
    } catch {
      // In-memory copy still drives this page.
    }
  }
}

export function emptyStats(now: number, entryUrl: string): ReplayKitRecordingStats {
  return { startedAt: now, endedAt: now, activeMs: 0, clicks: 0, rageClicks: 0, deadClicks: 0, errors: 0, pages: 1, entryUrl };
}
