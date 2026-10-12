// Signals out: batched POST /api/t/r/signals every FLUSH_MS (or at a full batch),
// sendBeacon for whatever is left when the page hides.
//
// Signals are cheap and never count against the quota, but a page in a rage loop
// should not turn into a request loop: at most MAX_PER_PAGE signals per page load,
// a full batch per request, and identical signals within DEDUPE_MS folded.

import type { Env } from "./env";
import { REPLAYKIT_MAX_SIGNALS_PER_BATCH, type ReplayKitSignal } from "./protocol";
import { backoff, type Api } from "./transport";

export const SIGNAL_FLUSH_MS = 5_000;
export const MAX_PER_PAGE = 200;
const MAX_QUEUED = 500;
const DEDUPE_MS = 2_000;

export class SignalQueue {
  private queue: ReplayKitSignal[] = [];
  private timer: unknown = null;
  private sentThisPage = 0;
  private failures = 0;
  private busy = false;
  private last = new Map<string, number>();
  /** Ingest said no (403 off, 401 bad key): nothing more this page. */
  disabled = false;
  /** Init has not answered yet: keep collecting, send nothing. */
  held = true;

  constructor(
    private readonly env: Env,
    private readonly api: Api,
    private readonly ids: () => { sid: string; vid: string; rid?: string },
  ) {}

  add(s: ReplayKitSignal): void {
    if (this.disabled || this.sentThisPage + this.queue.length >= MAX_PER_PAGE) return;
    const key = `${s.type}|${s.url}|${s.selector || ""}|${s.detail || ""}`;
    const prev = this.last.get(key);
    if (prev !== undefined && s.ts - prev < DEDUPE_MS) return;
    this.last.set(key, s.ts);
    this.queue.push(s);
    if (this.queue.length > MAX_QUEUED) this.queue.shift();
    if (this.held) return;
    if (this.queue.length >= REPLAYKIT_MAX_SIGNALS_PER_BATCH) this.schedule(0);
    else if (!this.timer) this.schedule(SIGNAL_FLUSH_MS);
  }

  /** Init answered: start sending (signals on) or drop everything (off). */
  release(enabled: boolean): void {
    this.held = false;
    if (!enabled) {
      this.disable();
      return;
    }
    if (this.queue.length) this.schedule(0);
  }

  disable(): void {
    this.disabled = true;
    this.queue = [];
    if (this.timer) this.env.clearTimer(this.timer);
    this.timer = null;
  }

  private schedule(ms: number): void {
    if (this.timer) this.env.clearTimer(this.timer);
    this.timer = this.env.setTimer(() => {
      this.timer = null;
      void this.flush();
    }, ms);
  }

  async flush(): Promise<void> {
    if (this.busy || this.held || this.disabled) return;
    this.busy = true;
    try {
      while (this.queue.length && !this.disabled) {
        const batch = this.queue.slice(0, REPLAYKIT_MAX_SIGNALS_PER_BATCH);
        const r = await this.api.signals({ ...this.ids(), signals: batch });
        if (r.outcome === "ok" || r.outcome === "drop" || r.outcome === "quota") {
          // 429 on signals would be a server bug (they never count): drop the batch, don't loop.
          this.queue.splice(0, batch.length);
          this.sentThisPage += batch.length;
          this.failures = 0;
          continue;
        }
        if (r.outcome === "off" || r.outcome === "stop") {
          this.disable();
          return;
        }
        this.failures++;
        this.schedule(backoff(this.failures));
        return;
      }
    } finally {
      this.busy = false;
    }
  }

  /** Page hide: beacon what is left (no status to read; a lost beacon loses a few signals). */
  beacon(): void {
    if (this.held || this.disabled || !this.queue.length) return;
    while (this.queue.length) {
      const batch = this.queue.slice(0, REPLAYKIT_MAX_SIGNALS_PER_BATCH);
      if (!this.api.beaconSignals({ ...this.ids(), signals: batch })) return;
      this.queue.splice(0, batch.length);
      this.sentThisPage += batch.length;
    }
  }

  get size(): number {
    return this.queue.length;
  }
}
