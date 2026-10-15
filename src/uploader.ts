// Live recording upload: rrweb events → gzip'd chunk → presigned PUT straight to R2.
//
// Per chunk: POST /api/t/r/chunk (the API answers with a presigned URL and, on seq 0,
// opens the recording and counts it in the quota), then PUT the gzip to R2. Nothing
// of the recording passes through our servers.
//
// A chunk goes out every FLUSH_MS or once FLUSH_BYTES of raw JSON piled up. The two
// requests cannot be trusted to finish while a page unloads, so on page hide the
// unsent events (queued and in flight) are written to IndexedDB instead, and the
// next page of the same session uploads them before its own. A session that never
// comes back loses its last few seconds; nothing else is lost.
//
// seq advances only after R2 accepted the PUT, so a retry re-uses the same seq and
// overwrites the same object: retries are idempotent end to end.

import type { Env } from "./env";
import { approxBytes, pagesOf, type RrEvent } from "./buffer";
import { REPLAYKIT_MAX_CHUNK_BYTES, REPLAYKIT_MAX_CHUNKS, REPLAYKIT_MAX_PAGES_PER_CHUNK, type ReplayKitChunkFile } from "./protocol";
import type { StateStore, SessionState, StopReason } from "./state";
import { backoff, type Api } from "./transport";

export const FLUSH_MS = 30_000;
export const FLUSH_BYTES = 256 * 1024;
/**
 * Most raw rrweb JSON one recording uploads. A page that rewrites itself nonstop (a ticker, a
 * carousel, an animated counter) compresses ~40:1, so its gzip stays small while the player has
 * to inflate, parse and replay hundreds of MB; past this the recording ends (reason "limit").
 */
export const MAX_RECORDING_RAW_BYTES = 40 * 1024 * 1024;

const pendingKey = (sid: string) => `rk:pending:${sid}`;

interface Pending {
  rid: string;
  events: RrEvent[];
}

export interface UploaderHooks {
  /** Recording must stop (quota, ReplayKit off for the project, chunk limit, unusable chunk). */
  onStop(reason: StopReason): void;
  /** Right before a chunk is requested: write the running stats into the session state. */
  beforeChunk?(): void;
}

export class Uploader {
  private queue: RrEvent[] = [];
  private inflight: RrEvent[] = [];
  private queuedBytes = 0;
  private timer: unknown = null;
  private retryTimer: unknown = null;
  private failures = 0;
  private busy = false;
  private stopped = false;
  /** Bumped by pause(); a flush that started before it must not touch the new state. */
  private epoch = 0;
  /** A copy of the unsent events was parked in IndexedDB (page hidden); keep it in step with what lands. */
  private parked = false;
  /** Last page reported for `lastPageRid`: a checkout's repeated Meta href is not a new page. */
  private lastPage = "";
  private lastPageRid = "";

  constructor(
    private readonly env: Env,
    private readonly api: Api,
    private readonly states: StateStore,
    private readonly ids: { sid: string; vid: string },
    private readonly hooks: UploaderHooks,
    private readonly maxRawBytes = MAX_RECORDING_RAW_BYTES,
  ) {}

  private state(): SessionState {
    return this.states.load(this.ids.sid);
  }

  /** Prepends what the previous page of this session could not send. */
  async restorePending(): Promise<void> {
    const store = this.env.store;
    if (!store) return;
    const p = await store.get<Pending>(pendingKey(this.ids.sid));
    if (!p) return;
    await store.del(pendingKey(this.ids.sid));
    const s = this.state();
    if (!s.rid || p.rid !== s.rid || !Array.isArray(p.events) || p.events.length === 0) return;
    this.queue = p.events.concat(this.queue);
    this.queuedBytes += p.events.reduce((n, e) => n + approxBytes(e), 0);
    this.schedule(0);
  }

  add(e: RrEvent): void {
    if (this.stopped) return;
    this.queue.push(e);
    this.queuedBytes += approxBytes(e);
    if (this.queuedBytes >= FLUSH_BYTES) this.schedule(0);
    else if (!this.timer) this.schedule(FLUSH_MS);
  }

  addMany(events: RrEvent[]): void {
    for (const e of events) this.add(e);
  }

  private schedule(ms: number): void {
    if (this.timer) this.env.clearTimer(this.timer);
    this.timer = this.env.setTimer(() => {
      this.timer = null;
      void this.flush();
    }, ms);
  }

  /** Uploads everything queued, one chunk at a time. Resolves when the queue is empty or blocked. */
  async flush(): Promise<void> {
    if (this.busy || this.stopped) return;
    const epoch = this.epoch;
    this.busy = true;
    try {
      while (!this.stopped && epoch === this.epoch && (this.inflight.length > 0 || this.queue.length > 0)) {
        if (this.inflight.length === 0) {
          this.inflight = this.queue;
          this.queue = [];
          this.queuedBytes = 0;
        }
        const ok = await this.sendInflight();
        if (!ok) return;
      }
    } finally {
      this.busy = false;
    }
  }

  /** True when the in-flight events are done with (sent or dropped); false to wait for a retry. */
  private async sendInflight(): Promise<boolean> {
    this.hooks.beforeChunk?.();
    const s = this.state();
    if (!s.rid || !s.trigger || !s.stats) return false;
    if (s.seq >= REPLAYKIT_MAX_CHUNKS) {
      this.stop("limit");
      return false;
    }
    const gzip = this.env.gzip;
    if (!gzip) {
      this.stop("off");
      return false;
    }
    const file: ReplayKitChunkFile = { v: 1, rid: s.rid, seq: s.seq, events: this.inflight };
    const json = JSON.stringify(file);
    // Over the per-recording cap: the recording ends with what it already has.
    if ((s.rawBytes ?? 0) + json.length > this.maxRawBytes) {
      this.stop("limit");
      return false;
    }
    const blob = await gzip(json);
    if (blob.size > REPLAYKIT_MAX_CHUNK_BYTES) {
      // Too big for one chunk: send the first half now, the rest goes back to the head of the queue.
      if (this.inflight.length > 1) {
        const half = Math.ceil(this.inflight.length / 2);
        this.queue = this.inflight.slice(half).concat(this.queue);
        this.inflight = this.inflight.slice(0, half);
        return true;
      }
      // One event over 2 MB gzip'd (a giant full snapshot): unreplayable either way.
      this.stop("limit");
      return false;
    }
    const prevPage = this.lastPageRid === s.rid ? this.lastPage : "";
    const pages = pagesOf(this.inflight, prevPage, REPLAYKIT_MAX_PAGES_PER_CHUNK);
    const presign = await this.api.chunk({ rid: s.rid, sid: this.ids.sid, vid: this.ids.vid, seq: s.seq, bytes: blob.size, trigger: s.trigger, stats: s.stats, pages });
    if (presign.outcome === "drop") {
      this.inflight = [];
      return true;
    }
    if (presign.outcome === "quota") return this.stop("quota"), false;
    if (presign.outcome === "off" || presign.outcome === "stop") return this.stop("off"), false;
    if (presign.outcome !== "ok" || !presign.data?.url) return this.retryLater(), false;
    const put = await this.api.put(presign.data.url, blob);
    if (put === "drop") {
      this.inflight = [];
      return true;
    }
    if (put !== "ok") return this.retryLater(), false;
    this.failures = 0;
    this.inflight = [];
    if (pages.length) {
      this.lastPage = pages[pages.length - 1].url;
      this.lastPageRid = s.rid;
    }
    const cur = this.state();
    if (cur.rid === s.rid) this.states.save({ ...cur, seq: s.seq + 1, rawBytes: (cur.rawBytes ?? 0) + json.length });
    // Hidden tab whose upload still went through: the parked copy must not replay it on the next page.
    if (this.parked) {
      if (this.queue.length) this.persist();
      else this.unpersist();
    }
    return true;
  }

  private retryLater(): void {
    this.failures++;
    if (this.retryTimer) this.env.clearTimer(this.retryTimer);
    this.retryTimer = this.env.setTimer(() => {
      this.retryTimer = null;
      void this.flush();
    }, backoff(this.failures));
  }

  private stop(reason: StopReason): void {
    this.stopped = true;
    this.queue = [];
    this.inflight = [];
    this.queuedBytes = 0;
    this.clearTimers();
    this.hooks.onStop(reason);
  }

  private clearTimers(): void {
    if (this.timer) this.env.clearTimer(this.timer);
    if (this.retryTimer) this.env.clearTimer(this.retryTimer);
    this.timer = this.retryTimer = null;
  }

  /** Page hide: park unsent events for the next page of this session. */
  persist(): void {
    const store = this.env.store;
    const s = this.state();
    const events = this.inflight.concat(this.queue);
    if (!store || !s.rid || events.length === 0 || this.stopped) return;
    this.parked = true;
    void store.set(pendingKey(this.ids.sid), { rid: s.rid, events } satisfies Pending);
  }

  /** The page came back into view: whatever was parked is still in memory, drop the copy. */
  unpersist(): void {
    if (!this.parked) return;
    this.parked = false;
    void this.env.store?.del(pendingKey(this.ids.sid));
  }

  /** Stop without a reason the server gave (manual stop, consent withdrawn): drop what is queued. */
  discard(): void {
    this.epoch++;
    this.stopped = true;
    this.queue = [];
    this.inflight = [];
    this.queuedBytes = 0;
    this.clearTimers();
    this.unpersist();
  }

  get pendingEvents(): number {
    return this.queue.length + this.inflight.length;
  }
}
