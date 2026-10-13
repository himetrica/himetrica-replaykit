// The ReplayKit client: one per page load.
//
//   1. waits for the tracker's visitor and session ids (read-only, identity.ts);
//   2. starts the signal listeners at once, so errors during startup are caught,
//      holding what they find until /init answers;
//   3. POST /api/t/r/init: signals on/off, recordings on/off, the project's config and
//      a server-side trigger ("paying");
//   4. decides the page (decide.ts): off, continue the session's recording, start
//      one, or keep a pre-trigger buffer and wait for a trigger.
//
// Conditional recording: in buffer mode rrweb runs into an in-memory ring buffer cut
// at full snapshots (buffer.ts), parked in IndexedDB when the page hides so a trigger
// on the next page of the session still shows the page before. A trigger promotes
// the buffer into a recording: a recording id is minted, the buffer becomes the
// first chunk and every later event streams through the uploader.

import { emptyStats, StateStore, type SessionState, type StopReason } from "./state";
import { browserEnv, isBrowser, type Env } from "./env";
import { readIdentity } from "./identity";
import { inSample, matchAny, stripUrl } from "./match";
import { trimBuffer, BUFFER_WINDOW_MS, CHECKOUT_MS, EVENT_FULL_SNAPSHOT, type RrEvent } from "./buffer";
import { activeIncrement } from "./detect";
import { decidePage, waitBeforeRecording } from "./decide";
import { Api, backoff } from "./transport";
import { SignalQueue } from "./signal-queue";
import { SignalCollector } from "./signals-dom";
import { Recorder } from "./recorder";
import { Uploader } from "./uploader";
import type { ReplayKitClientConfig, ReplayKitInitResponse, ReplayKitRecordingStats, ReplayKitSignal, ReplayKitTrigger } from "./protocol";

export interface ReplayKitOptions {
  /** Your project's public API key (the same one the tracker uses). */
  apiKey: string;
  /** Defaults to https://app.himetrica.com. */
  apiUrl?: string;
  /** Run on localhost (off by default, like the tracker). */
  allowLocalhost?: boolean;
  /** Log decisions to the console. */
  debug?: boolean;
}

const CONSENT_KEY = "hm_rk_consent";
const bufferKey = (sid: string) => `rk:buf:${sid}`;
const IDENTITY_POLL_MS = 500;
const IDENTITY_WAIT_MS = 15_000;
const INIT_ATTEMPTS = 3;

type Mode = "idle" | "off" | "wait_consent" | "buffer" | "live";

interface ParkedBuffer {
  at: number;
  events: RrEvent[];
}

export class ReplayKitClient {
  private readonly env: Env;
  private readonly api: Api;
  private readonly states: StateStore;
  private ids: { sid: string; vid: string } | null = null;
  private queue: SignalQueue | null = null;
  private collector: SignalCollector | null = null;
  private recorder: Recorder | null = null;
  private uploader: Uploader | null = null;
  private init: ReplayKitInitResponse | null = null;
  private config: ReplayKitClientConfig | null = null;
  private mode: Mode = "idle";
  private buffer: RrEvent[] = [];
  /** Clicks, signals and input times while buffering, folded into the stats on promotion. */
  private recent: Array<{ k: "click" | "rage" | "dead" | "error" | "input"; ts: number }> = [];
  private stats: ReplayKitRecordingStats | null = null;
  private lastInputTs = 0;
  /** A trigger that fired before /init answered. */
  private earlyTrigger: ReplayKitTrigger | null = null;
  /** A trigger waiting for the session to reach minDurationMs on screen. */
  private pending: ReplayKitTrigger | null = null;
  /** Bumped on every wait scheduled, so only the latest timer acts. */
  private pendingGen = 0;
  /** Visible time of the session's earlier pages (state.visibleMs, read once ids are known). */
  private baseVisibleMs = 0;
  /** Visible time of this page so far, excluding the current visible stretch. */
  private pageVisibleMs = 0;
  /** Start of the current visible stretch, null while the tab is hidden. */
  private visibleSince: number | null = null;
  private destroyed = false;
  private offWindow: Array<() => void> = [];

  constructor(private readonly options: ReplayKitOptions, env: Env = browserEnv()) {
    this.env = env;
    const apiUrl = (options.apiUrl || "https://app.himetrica.com").replace(/\/+$/, "");
    this.api = new Api(env, apiUrl, options.apiKey);
    this.states = new StateStore(env);
  }

  private log(...args: unknown[]): void {
    if (this.options.debug) console.debug("[ReplayKit]", ...args);
  }

  /** Starts everything. Safe to call once per page; no-op outside a browser. */
  start(): void {
    if (!isBrowser || !this.options.apiKey) return;
    const host = location.hostname;
    if (!this.options.allowLocalhost && (host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host.endsWith(".localhost"))) {
      this.log("localhost: idle (allowLocalhost to enable)");
      return;
    }
    this.trackVisibility();
    const started = this.env.now();
    const tryIds = () => {
      if (this.destroyed) return;
      const id = readIdentity(this.env);
      if (id.sessionId && id.visitorId) {
        this.ids = { sid: id.sessionId, vid: id.visitorId };
        this.boot();
      } else if (this.env.now() - started < IDENTITY_WAIT_MS) {
        this.env.setTimer(tryIds, IDENTITY_POLL_MS);
      } else {
        this.log("no tracker ids on this page: idle");
      }
    };
    tryIds();
  }

  private boot(): void {
    const ids = this.ids!;
    this.baseVisibleMs = this.states.load(ids.sid).visibleMs ?? 0;
    this.queue = new SignalQueue(this.env, this.api, () => ({ ...ids, rid: this.mode === "live" ? this.state().rid : undefined }));
    this.collector = new SignalCollector({
      now: () => this.env.now(),
      maskAllText: () => this.config?.maskAllText ?? true,
      signal: (s) => this.onSignal(s),
      trigger: (t) => this.trigger(t),
      input: (kind, ts) => this.onInput(kind, ts),
      navigated: (url) => this.onNavigate(url),
    });
    this.collector.start();
    this.listenPage();
    void this.callInit(1);
  }

  private state(): SessionState {
    return this.states.load(this.ids!.sid);
  }

  private async callInit(attempt: number): Promise<void> {
    const ids = this.ids!;
    const r = await this.api.init({ sid: ids.sid, vid: ids.vid, url: stripUrl(location.href) });
    if (this.destroyed) return;
    if (r.outcome === "ok" && r.data) return this.applyInit(r.data);
    if (r.outcome === "retry" && attempt < INIT_ATTEMPTS) {
      this.env.setTimer(() => void this.callInit(attempt + 1), backoff(attempt));
      return;
    }
    this.log("init refused:", r.outcome);
    if (r.outcome === "quota") {
      // Quota is about recordings; signals never count.
      this.queue?.release(true);
      this.mode = "off";
      return;
    }
    this.shutdown();
  }

  private applyInit(res: ReplayKitInitResponse): void {
    this.init = res;
    this.config = res.config;
    this.queue!.release(res.signals);
    if (!res.signals && !res.record) {
      this.shutdown();
      return;
    }
    this.decide();
  }

  private consentValue(): boolean | null {
    const v = this.env.getLocal(CONSENT_KEY);
    return v === "1" ? true : v === "0" ? false : null;
  }

  private triggerEnabled(t: ReplayKitTrigger): boolean {
    if (t === "manual" || t === "sample") return true;
    return !!this.config?.triggers.includes(t as ReplayKitClientConfig["triggers"][number]);
  }

  private pathExcluded(): boolean {
    return matchAny(this.config?.excludePaths ?? [], location.pathname);
  }

  private onCheckoutPath(): boolean {
    return this.triggerEnabled("checkout") && matchAny(this.config?.checkoutPaths ?? [], location.pathname);
  }

  private decide(): void {
    if (!this.init || !this.config) return;
    const s = this.state();
    const mode = decidePage({
      record: this.init.record,
      canGzip: !!this.env.gzip,
      state: s,
      excluded: this.pathExcluded(),
      requireConsent: this.config.requireConsent,
      consent: this.consentValue(),
      forceTrigger: this.init.forceTrigger,
      sampled: inSample(this.ids!.sid, this.config.sampleRate),
      checkout: this.onCheckoutPath(),
    });
    this.log("page:", mode.kind, mode.kind === "start" ? mode.trigger : "");
    if (mode.kind === "off" || mode.kind === "wait_consent") {
      this.mode = mode.kind;
      return;
    }
    if (mode.kind === "continue") {
      this.mode = "live";
      const st = s.stats ?? emptyStats(this.env.now(), stripUrl(location.href));
      this.stats = { ...st, pages: st.pages + 1 };
      this.makeUploader();
      void this.uploader!.restorePending();
      void this.startRecorder();
      return;
    }
    this.mode = "buffer";
    void this.restoreParkedBuffer().then(async () => {
      if (this.mode !== "buffer") return;
      // rrweb emits the page's full snapshot synchronously on start: it lands in the buffer
      // before a promotion, so the first chunk always opens with a replayable page.
      await this.startRecorder();
      if (this.mode !== "buffer") return;
      const t = mode.kind === "start" ? mode.trigger : this.earlyTrigger;
      this.earlyTrigger = null;
      if (t && this.triggerEnabled(t)) this.requestPromote(t);
    });
  }

  private async restoreParkedBuffer(): Promise<void> {
    const store = this.env.store;
    if (!store) return;
    const key = bufferKey(this.ids!.sid);
    const parked = await store.get<ParkedBuffer>(key);
    if (!parked) return;
    void store.del(key);
    const fresh = this.env.now() - parked.at < BUFFER_WINDOW_MS + CHECKOUT_MS;
    if (fresh && Array.isArray(parked.events) && parked.events.length) this.buffer = parked.events.concat(this.buffer);
  }

  private async startRecorder(): Promise<void> {
    if (this.recorder) return;
    const rec = (this.recorder = new Recorder());
    const ok = await rec.start({
      blockSelectors: this.config?.blockSelectors ?? [],
      maskAllText: this.config?.maskAllText ?? false,
      emit: (e) => this.onEvent(e),
    });
    if (!ok && this.recorder === rec) {
      this.log("rrweb failed to start");
      this.recorder = null;
      this.mode = "off";
    }
  }

  private onEvent(e: RrEvent): void {
    if (this.mode === "buffer") {
      this.buffer.push(e);
      // Trim only when a new checkout lands: the only moment a cut point appears.
      if (e.type === EVENT_FULL_SNAPSHOT) this.buffer = trimBuffer(this.buffer, this.env.now());
      return;
    }
    if (this.mode === "live" && this.uploader) {
      if (this.stats) this.stats.endedAt = Math.max(this.stats.endedAt, e.timestamp);
      this.uploader.add(e);
    }
  }

  private makeUploader(): void {
    this.uploader = new Uploader(this.env, this.api, this.states, this.ids!, {
      onStop: (reason) => this.stopRecording(reason),
      beforeChunk: () => this.saveStats(),
    });
  }

  private saveStats(): void {
    if (!this.stats || this.mode !== "live") return;
    const s = this.state();
    if (s.rid) this.states.save({ ...s, stats: this.stats });
  }

  /** A trigger fired: turn the buffer into a recording, or remember it until /init answers. */
  trigger(t: ReplayKitTrigger): void {
    if (this.destroyed || !this.ids) return;
    if (!this.init) {
      if (!this.earlyTrigger) this.earlyTrigger = t;
      return;
    }
    if (this.mode !== "buffer" || !this.triggerEnabled(t)) return;
    if (!this.recorder) {
      // Still restoring the parked buffer: the buffer setup promotes it when it is done.
      this.earlyTrigger ??= t;
      return;
    }
    this.requestPromote(t);
  }

  // ── Minimum duration ──────────────────────────────────────

  private trackVisibility(): void {
    if (document.visibilityState === "visible") this.visibleSince = this.env.now();
    const onVis = () => {
      const now = this.env.now();
      if (document.visibilityState === "hidden") {
        if (this.visibleSince !== null) this.pageVisibleMs += now - this.visibleSince;
        this.visibleSince = null;
      } else if (this.visibleSince === null) {
        this.visibleSince = now;
        // Hidden tabs do not count: the wait resumes where it stopped.
        if (this.pending) this.schedulePending();
      }
    };
    document.addEventListener("visibilitychange", onVis);
    this.offWindow.push(() => document.removeEventListener("visibilitychange", onVis));
  }

  /** Session time on screen: earlier pages + this one, the current visible stretch included. */
  private visibleMs(): number {
    const live = this.visibleSince !== null ? this.env.now() - this.visibleSince : 0;
    return this.baseVisibleMs + this.pageVisibleMs + live;
  }

  /** Open the recording now, or once the session has been on screen for minDurationMs. */
  private requestPromote(t: ReplayKitTrigger): void {
    const wait = waitBeforeRecording(t, this.visibleMs(), this.config?.minDurationMs ?? 0);
    if (wait === 0) {
      this.pending = null;
      this.promote(t);
      return;
    }
    // The first waiting trigger is the one the recording reports.
    this.pending ??= t;
    this.log("waiting for the minimum duration:", t, wait, "ms");
    this.schedulePending();
  }

  private schedulePending(): void {
    const t = this.pending;
    if (!t) return;
    const gen = ++this.pendingGen;
    const wait = waitBeforeRecording(t, this.visibleMs(), this.config?.minDurationMs ?? 0);
    this.env.setTimer(() => {
      if (gen !== this.pendingGen || this.pending !== t || this.mode !== "buffer" || this.destroyed) return;
      // Hidden meanwhile: the visibilitychange handler reschedules when the tab comes back.
      if (this.visibleSince === null) return;
      this.requestPromote(t);
    }, Math.max(wait, 50));
  }

  private promote(t: ReplayKitTrigger): void {
    const now = this.env.now();
    // The buffer starts at a full snapshot; recordings begin there, so stats do too.
    const events = this.buffer;
    this.buffer = [];
    const startedAt = events.length ? events[0].timestamp : now;
    const stats = emptyStats(startedAt, stripUrl(location.href));
    // The visit lasted until now even if the page was quiet: a recording opened after the
    // minimum duration must not read as shorter than it (the API hides short ones).
    stats.endedAt = Math.max(events.length ? events[events.length - 1].timestamp : now, now);
    this.pending = null;
    let last = 0;
    for (const r of this.recent) {
      if (r.ts < startedAt) continue;
      if (r.k === "click") stats.clicks++;
      else if (r.k === "rage") stats.rageClicks++;
      else if (r.k === "dead") stats.deadClicks++;
      else if (r.k === "error") stats.errors++;
      if (r.k === "click" || r.k === "input") {
        stats.activeMs += activeIncrement(last, r.ts);
        last = r.ts;
      }
    }
    this.recent = [];
    this.stats = stats;
    this.states.save({ ...this.state(), rid: this.env.uuid(), seq: 0, trigger: t, stats, stopped: undefined });
    this.mode = "live";
    this.log("recording:", t);
    this.makeUploader();
    this.uploader!.addMany(events);
    if (!events.length) this.recorder?.snapshot();
    // Open the recording right away: short sessions that end soon after a trigger are the interesting ones.
    void this.uploader!.flush();
  }

  private stopRecording(reason: StopReason): void {
    this.log("recording stopped:", reason);
    this.recorder?.stop();
    this.recorder = null;
    this.mode = "off";
    this.buffer = [];
    const s = this.state();
    this.states.save({ ...s, stopped: reason });
  }

  private onSignal(s: ReplayKitSignal): void {
    if (this.mode === "live" && this.stats) {
      if (s.type === "rage_click") this.stats.rageClicks++;
      else if (s.type === "dead_click") this.stats.deadClicks++;
      else if (s.type === "error") this.stats.errors++;
    } else if (this.mode === "buffer" || this.mode === "idle") {
      const k = s.type === "rage_click" ? "rage" : s.type === "dead_click" ? "dead" : s.type === "error" ? "error" : null;
      if (k) this.pushRecent(k, s.ts);
    }
    this.queue?.add(s);
  }

  private onInput(kind: "click" | "key" | "scroll", ts: number): void {
    if (this.mode === "live" && this.stats) {
      this.stats.activeMs += activeIncrement(this.lastInputTs, ts);
      if (kind === "click") this.stats.clicks++;
    } else if (this.mode === "buffer" || this.mode === "idle") {
      this.pushRecent(kind === "click" ? "click" : "input", ts);
    }
    this.lastInputTs = ts;
  }

  private pushRecent(k: "click" | "rage" | "dead" | "error" | "input", ts: number): void {
    this.recent.push({ k, ts });
    if (this.recent.length > 1000) this.recent.splice(0, this.recent.length - 1000);
  }

  private onNavigate(url: string): void {
    if (!this.init || !this.config) return;
    if (this.mode === "live" && this.stats) this.stats.pages++;
    const excluded = this.pathExcluded();
    if (excluded && (this.mode === "live" || this.mode === "buffer")) {
      // SPA route that must not be recorded: pause rrweb, keep the session's state.
      this.recorder?.stop();
      this.recorder = null;
      if (this.mode === "buffer") this.buffer = [];
      void this.uploader?.flush();
      this.mode = "off";
      return;
    }
    if (!excluded && this.mode === "off" && !this.state().stopped) {
      // Back from an excluded route: decide again (continues the recording or rebuffers).
      this.uploader = null;
      this.decide();
      return;
    }
    // Excluded routes never reach here: their URL is not written into the stream.
    this.recorder?.page(url);
    if (this.onCheckoutPath()) this.trigger("checkout");
  }

  private listenPage(): void {
    const hide = (unloading: boolean) => {
      if (unloading) this.collector?.pageHide();
      // The next page of the session continues the minimum-duration count from here.
      this.states.save({ ...this.state(), visibleMs: this.visibleMs() });
      this.queue?.beacon();
      if (this.mode === "live") {
        this.saveStats();
        this.uploader?.persist();
      } else if (this.mode === "buffer" && this.buffer.length && this.env.store) {
        const events = trimBuffer(this.buffer, this.env.now());
        void this.env.store.set(bufferKey(this.ids!.sid), { at: this.env.now(), events } satisfies ParkedBuffer);
      }
    };
    const onVis = () => {
      if (document.visibilityState === "hidden") hide(false);
      else this.uploader?.unpersist();
    };
    const onHide = () => hide(true);
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("pagehide", onHide);
    this.offWindow.push(
      () => document.removeEventListener("visibilitychange", onVis),
      () => window.removeEventListener("pagehide", onHide),
    );
  }

  // ── Public API ────────────────────────────────────────────

  /** Start recording this session now (ReplayKit.start()). Still subject to /init, consent and excludePaths. */
  manualStart(reason?: string): void {
    if (!this.ids) return;
    if (reason) this.log("manual trigger:", reason);
    if (this.state().stopped === "manual") {
      // Started again after ReplayKit.stop(): a new recording, decided like a fresh page.
      this.states.save({ ...this.state(), stopped: undefined, rid: undefined, seq: 0, trigger: undefined, stats: undefined });
      this.uploader = null;
      this.earlyTrigger = "manual";
      this.decide();
      return;
    }
    this.trigger("manual");
  }

  /** Stop recording for the rest of the session; what was captured is still uploaded. */
  manualStop(): void {
    if (!this.ids) return;
    this.recorder?.stop();
    this.recorder = null;
    this.buffer = [];
    if (this.mode === "live") {
      this.saveStats();
      void this.uploader?.flush();
    }
    this.mode = "off";
    this.states.save({ ...this.state(), stopped: "manual" });
  }

  /** The visitor's answer to the customer's consent banner. Stored on this device. */
  consent(granted: boolean): void {
    this.env.setLocal(CONSENT_KEY, granted ? "1" : "0");
    if (!this.ids) return;
    if (granted) {
      if (this.mode === "wait_consent") this.decide();
      return;
    }
    // Withdrawn: stop now and drop everything not uploaded yet.
    this.recorder?.stop();
    this.recorder = null;
    this.buffer = [];
    this.uploader?.discard();
    void this.env.store?.del(bufferKey(this.ids.sid));
    this.mode = "off";
  }

  recordingId(): string | null {
    return this.mode === "live" ? (this.ids ? this.state().rid ?? null : null) : null;
  }

  private shutdown(): void {
    this.collector?.stop();
    this.queue?.disable();
    this.recorder?.stop();
    this.recorder = null;
    this.mode = "off";
  }

  destroy(): void {
    this.destroyed = true;
    this.shutdown();
    for (const f of this.offWindow) f();
    this.offWindow = [];
  }
}
