// Unit tests for the ReplayKit SDK (no DOM: fake Env with clock, storage, network).
//
// Run from packages/replaykit:
//   node --import tsx --test src/replaykit.test.ts
//
// What matters: the recording decision (sample, globs, decide table), the detectors,
// a buffer that always starts at a replayable snapshot, and an upload path that obeys
// the status codes and never sends a chunk twice under a different seq.

import { test } from "node:test";
import assert from "node:assert/strict";
import { inSample, matchAny, matchPath, sampleDraw, stripUrl } from "./match";
import { activeIncrement, isDeadClick, isDeadClickCandidate, RageDetector } from "./detect";
import { pagesOf, PAGE_TAG, trimBuffer, type RrEvent } from "./buffer";
import { decidePage, type DecideInput } from "./decide";
import { outcomeOf, Api } from "./transport";
import { StateStore, emptyStats } from "./state";
import { Uploader } from "./uploader";
import { SignalQueue } from "./signal-queue";
import type { Env, KvStore } from "./env";
import type { ReplayKitSignal } from "./protocol";

// ── Fakes ────────────────────────────────────────────────────

type Call = { url: string; method: string; body: unknown };

function fakeEnv(script: { chunk?: number[]; put?: number[]; signals?: number[] } = {}) {
  let t = 1_760_000_000_000;
  const session = new Map<string, string>();
  const local = new Map<string, string>();
  const kv = new Map<string, unknown>();
  const calls: Call[] = [];
  const timers: Array<{ fn: () => void; at: number; id: number }> = [];
  let timerId = 0;
  const next = (list: number[] | undefined) => (list && list.length ? list.shift()! : 200);
  const store: KvStore = {
    get: async <T>(k: string) => kv.get(k) as T | undefined,
    set: async (k, v) => void kv.set(k, structuredClone(v)),
    del: async (k) => void kv.delete(k),
  };
  const env: Env = {
    now: () => t,
    uuid: () => "rid-" + ++timerId,
    fetch: async (url, init) => {
      const method = init.method || "GET";
      const body = typeof init.body === "string" ? JSON.parse(init.body) : init.body;
      calls.push({ url, method, body });
      let status = 200;
      let json: unknown = {};
      if (method === "PUT") status = next(script.put);
      else if (url.includes("/r/chunk")) {
        status = next(script.chunk);
        json = { url: `https://r2.example/put/${(body as { seq: number }).seq}`, expiresAt: t + 60_000 };
      } else if (url.includes("/r/signals")) status = next(script.signals);
      return { status, headers: { get: () => null }, json: async () => json };
    },
    sendBeacon: (url, body) => {
      calls.push({ url, method: "BEACON", body: JSON.parse(body) });
      return true;
    },
    getLocal: (k) => local.get(k) ?? null,
    setLocal: (k, v) => (v === null ? local.delete(k) : local.set(k, v)) && undefined,
    getSession: (k) => session.get(k) ?? null,
    setSession: (k, v) => (v === null ? session.delete(k) : session.set(k, v)) && undefined,
    getCookie: () => null,
    store,
    gzip: async (text) => new Blob([text]),
    setTimer: (fn, ms) => {
      const id = ++timerId;
      timers.push({ fn, at: t + ms, id });
      return id;
    },
    clearTimer: (h) => {
      const i = timers.findIndex((x) => x.id === h);
      if (i >= 0) timers.splice(i, 1);
    },
  };
  return {
    env,
    calls,
    kv,
    session,
    advance: (ms: number) => {
      t += ms;
    },
    timers,
  };
}

const ev = (type: number, timestamp: number, data?: unknown): RrEvent => ({ type, timestamp, data });

function liveUploader(f: ReturnType<typeof fakeEnv>) {
  const api = new Api(f.env, "https://api.test", "hm_key");
  const states = new StateStore(f.env);
  states.save({ sid: "s1", rid: "r1", seq: 0, trigger: "error", stats: emptyStats(f.env.now(), "https://x.test/") });
  const stops: string[] = [];
  const up = new Uploader(f.env, api, states, { sid: "s1", vid: "v1" }, { onStop: (r) => stops.push(r) });
  return { up, states, stops };
}

// ── match.ts ────────────────────────────────────────────────

test("sampleDraw is deterministic per session and roughly uniform", () => {
  assert.equal(sampleDraw("abc"), sampleDraw("abc"));
  assert.notEqual(sampleDraw("abc"), sampleDraw("abd"));
  let hits = 0;
  for (let i = 0; i < 20_000; i++) if (inSample(`session-${i}`, 0.05)) hits++;
  assert.ok(hits > 800 && hits < 1200, `5% of 20k should be ~1000, got ${hits}`);
  assert.equal(inSample("x", 0), false);
  assert.equal(inSample("x", 1), true);
});

test("matchPath: globs and segment prefixes", () => {
  assert.ok(matchPath("/checkout*", "/checkout"));
  assert.ok(matchPath("/checkout*", "/checkout/step-2"));
  assert.ok(matchPath("/checkout*", "/checkouts"));
  assert.ok(matchPath("/checkout", "/checkout/step-2"));
  assert.ok(!matchPath("/checkout", "/checkouts"));
  assert.ok(matchPath("/Checkout/", "/checkout"));
  assert.ok(matchPath("*/pay", "/br/pay"));
  assert.ok(!matchPath("/admin*", "/blog/admin"));
  assert.ok(matchPath("/a.b*", "/a.b/c"));
  assert.ok(!matchPath("/a.b*", "/aXb"));
  assert.ok(!matchPath("", "/"));
  assert.ok(matchAny(["/x", "/cart*"], "/cart/1"));
  assert.equal(stripUrl("https://a.test/p?token=1#h"), "https://a.test/p");
});

// ── detect.ts ───────────────────────────────────────────────

test("rage click: triggers on the 3rd click, reports the final count when the burst ends", () => {
  const r = new RageDetector();
  const c = (ts: number, x = 10, target = "button.buy") => r.onClick({ x, y: 10, ts, target });
  assert.deepEqual(c(0), { trigger: false, finished: null });
  assert.equal(c(200).trigger, false);
  assert.equal(c(400).trigger, true);
  assert.equal(c(600).trigger, false);
  assert.equal(r.flush(1000), null, "still inside the window");
  const done = r.flush(1700);
  assert.equal(done?.count, 4);
});

test("rage click: slow or scattered clicks are not rage", () => {
  const r = new RageDetector();
  r.onClick({ x: 0, y: 0, ts: 0, target: "a" });
  r.onClick({ x: 0, y: 0, ts: 1500, target: "a" });
  assert.equal(r.onClick({ x: 0, y: 0, ts: 3000, target: "a" }).trigger, false);
  const s = new RageDetector();
  s.onClick({ x: 0, y: 0, ts: 0, target: "a" });
  s.onClick({ x: 200, y: 0, ts: 100, target: "b" });
  assert.equal(s.onClick({ x: 400, y: 0, ts: 200, target: "c" }).trigger, false);
  // Same element with a drifting mouse still counts.
  const d = new RageDetector();
  d.onClick({ x: 0, y: 0, ts: 0, target: "btn" });
  d.onClick({ x: 90, y: 0, ts: 100, target: "btn" });
  assert.equal(d.onClick({ x: 180, y: 0, ts: 200, target: "btn" }).trigger, true);
});

test("rage click: an unrelated click closes the burst", () => {
  const r = new RageDetector();
  for (const ts of [0, 100, 200]) r.onClick({ x: 0, y: 0, ts, target: "a" });
  const out = r.onClick({ x: 500, y: 500, ts: 300, target: "z" });
  assert.equal(out.finished?.count, 3);
});

test("dead click: only promising elements, and only when nothing reacted", () => {
  const base = { tag: "div", insideInteractive: false, isFormField: false, pointerCursor: false, hasSelection: false };
  assert.equal(isDeadClickCandidate(base), false, "plain text is not friction");
  assert.equal(isDeadClickCandidate({ ...base, pointerCursor: true }), true);
  assert.equal(isDeadClickCandidate({ ...base, insideInteractive: true }), true);
  assert.equal(isDeadClickCandidate({ ...base, insideInteractive: true, isFormField: true }), false);
  assert.equal(isDeadClickCandidate({ ...base, pointerCursor: true, hasSelection: true }), false);
  assert.equal(isDeadClickCandidate({ ...base, tag: "body", pointerCursor: true }), false);
  const quiet = { mutations: 0, urlChanged: false, scrolled: false, focusChanged: false, unloading: false };
  assert.equal(isDeadClick(quiet), true);
  assert.equal(isDeadClick({ ...quiet, mutations: 1 }), false);
  assert.equal(isDeadClick({ ...quiet, urlChanged: true }), false);
  assert.equal(isDeadClick({ ...quiet, unloading: true }), false);
});

test("active time counts short gaps only", () => {
  assert.equal(activeIncrement(0, 1000), 0);
  assert.equal(activeIncrement(1000, 3000), 2000);
  assert.equal(activeIncrement(1000, 9000), 0);
});

// ── buffer.ts ───────────────────────────────────────────────

test("trimBuffer cuts at the last full snapshot older than the window, keeping its Meta", () => {
  const events = [ev(4, 0), ev(2, 0), ev(3, 5_000), ev(4, 30_000), ev(2, 30_000), ev(3, 40_000), ev(4, 60_000), ev(2, 60_000), ev(3, 65_000)];
  const out = trimBuffer(events, 65_000, 30_000);
  assert.deepEqual(
    out.map((e) => [e.type, e.timestamp]),
    [
      [4, 30_000],
      [2, 30_000],
      [3, 40_000],
      [4, 60_000],
      [2, 60_000],
      [3, 65_000],
    ],
  );
  assert.equal(out[0].type, 4);
});

test("trimBuffer keeps everything while shorter than the window, and drops an unreplayable head", () => {
  const young = [ev(4, 0), ev(2, 0), ev(3, 1_000)];
  assert.equal(trimBuffer(young, 10_000, 30_000), young);
  const headless = [ev(3, 0), ev(3, 1_000), ev(4, 2_000), ev(2, 2_000), ev(3, 3_000)];
  assert.deepEqual(
    trimBuffer(headless, 5_000, 30_000).map((e) => e.type),
    [4, 2, 3],
  );
  assert.deepEqual(trimBuffer([ev(3, 0)], 100_000, 30_000), []);
});

// ── decide.ts ───────────────────────────────────────────────

test("decidePage table", () => {
  const base: DecideInput = {
    record: true,
    canGzip: true,
    state: { sid: "s", seq: 0 },
    excluded: false,
    requireConsent: false,
    consent: null,
    forceTrigger: null,
    sampled: false,
    checkout: false,
  };
  assert.equal(decidePage(base).kind, "buffer");
  assert.equal(decidePage({ ...base, record: false }).kind, "off");
  assert.equal(decidePage({ ...base, canGzip: false }).kind, "off");
  assert.equal(decidePage({ ...base, excluded: true, state: { sid: "s", seq: 3, rid: "r" } }).kind, "off");
  assert.equal(decidePage({ ...base, state: { sid: "s", seq: 0, stopped: "quota" } }).kind, "off");
  assert.equal(decidePage({ ...base, requireConsent: true }).kind, "wait_consent");
  assert.equal(decidePage({ ...base, requireConsent: true, consent: true }).kind, "buffer");
  assert.equal(decidePage({ ...base, consent: false }).kind, "off");
  assert.equal(decidePage({ ...base, state: { sid: "s", seq: 2, rid: "r" } }).kind, "continue");
  assert.deepEqual(decidePage({ ...base, forceTrigger: "paying" }), { kind: "start", trigger: "paying" });
  assert.deepEqual(decidePage({ ...base, checkout: true }), { kind: "start", trigger: "checkout" });
  assert.deepEqual(decidePage({ ...base, sampled: true }), { kind: "start", trigger: "sample" });
});

// ── transport.ts / uploader.ts ──────────────────────────────

test("outcomeOf maps the contract's status codes", () => {
  assert.equal(outcomeOf(202), "ok");
  assert.equal(outcomeOf(400), "drop");
  assert.equal(outcomeOf(413), "drop");
  assert.equal(outcomeOf(401), "stop");
  assert.equal(outcomeOf(403), "off");
  assert.equal(outcomeOf(429), "quota");
  assert.equal(outcomeOf(503), "retry");
  assert.equal(outcomeOf(0), "retry");
});

test("uploader: presign then PUT, seq advances only after R2 accepts", async () => {
  const f = fakeEnv({ put: [503, 200] });
  const { up, states } = liveUploader(f);
  up.addMany([ev(4, 1), ev(2, 1), ev(3, 2)]);
  await up.flush();
  assert.equal(states.load("s1").seq, 0, "PUT failed: same seq on retry");
  assert.equal(up.pendingEvents, 3);
  await up.flush();
  assert.equal(states.load("s1").seq, 1);
  assert.equal(up.pendingEvents, 0);
  const chunkCalls = f.calls.filter((c) => c.url.includes("/r/chunk"));
  assert.deepEqual(
    chunkCalls.map((c) => (c.body as { seq: number }).seq),
    [0, 0],
  );
  assert.ok(chunkCalls[0].url.includes("apiKey=hm_key"));
  const put = f.calls.filter((c) => c.method === "PUT");
  assert.equal(put.length, 2);
});

test("uploader: 429 stops for the session, 403 stops the page, 400 drops the chunk", async () => {
  const q = fakeEnv({ chunk: [429] });
  const a = liveUploader(q);
  a.up.add(ev(2, 1));
  await a.up.flush();
  assert.deepEqual(a.stops, ["quota"]);
  assert.equal(q.calls.filter((c) => c.method === "PUT").length, 0);

  const o = fakeEnv({ chunk: [403] });
  const b = liveUploader(o);
  b.up.add(ev(2, 1));
  await b.up.flush();
  assert.deepEqual(b.stops, ["off"]);

  const d = fakeEnv({ chunk: [400] });
  const c = liveUploader(d);
  c.up.add(ev(2, 1));
  await c.up.flush();
  assert.deepEqual(c.stops, []);
  assert.equal(c.up.pendingEvents, 0);
  assert.equal(c.states.load("s1").seq, 0, "dropped chunk does not take a seq");
});

test("uploader: 5xx on presign schedules a backoff retry", async () => {
  const f = fakeEnv({ chunk: [503] });
  const { up, states } = liveUploader(f);
  up.add(ev(2, 1));
  await up.flush();
  assert.equal(up.pendingEvents, 1);
  assert.ok(f.timers.length >= 1, "retry timer set");
  await up.flush();
  assert.equal(states.load("s1").seq, 1);
});

test("uploader: unsent events park in the store and the next page sends them first", async () => {
  const f = fakeEnv({ chunk: [503] });
  const a = liveUploader(f);
  a.up.addMany([ev(3, 1), ev(3, 2)]);
  await a.up.flush();
  a.up.persist();
  await new Promise((r) => setImmediate(r));
  assert.equal((f.kv.get("rk:pending:s1") as { events: unknown[] }).events.length, 2);

  // Next page: same session storage and store, new uploader.
  const api = new Api(f.env, "https://api.test", "hm_key");
  const up2 = new Uploader(f.env, api, new StateStore(f.env), { sid: "s1", vid: "v1" }, { onStop: () => {} });
  up2.add(ev(4, 10));
  await up2.restorePending();
  assert.equal(f.kv.has("rk:pending:s1"), false);
  await up2.flush();
  const lastPut = f.calls.filter((c) => c.method === "PUT").pop();
  assert.ok(lastPut);
  const file = JSON.parse(await (lastPut.body as Blob).text());
  assert.deepEqual(
    file.events.map((e: RrEvent) => e.timestamp),
    [1, 2, 10],
  );
  assert.equal(file.seq, 0);
  assert.equal(file.rid, "r1");
});

test("uploader: parked copy is cleared when the hidden tab's upload lands", async () => {
  const f = fakeEnv();
  const { up } = liveUploader(f);
  up.add(ev(2, 1));
  up.persist();
  await new Promise((r) => setImmediate(r));
  assert.ok(f.kv.has("rk:pending:s1"));
  await up.flush();
  await new Promise((r) => setImmediate(r));
  assert.equal(f.kv.has("rk:pending:s1"), false);
});

test("uploader: an oversized chunk is split in halves", async () => {
  const f = fakeEnv();
  const { up, states } = liveUploader(f);
  const big = "x".repeat(700_000);
  up.addMany([ev(2, 1, big), ev(3, 2, big), ev(3, 3, big), ev(3, 4, big)]);
  await up.flush();
  const seqs = f.calls.filter((c) => c.url.includes("/r/chunk")).map((c) => (c.body as { seq: number; bytes: number }).bytes);
  assert.ok(seqs.every((b) => b <= 2 * 1024 * 1024));
  assert.equal(states.load("s1").seq, 2);
});

// ── signal-queue.ts ─────────────────────────────────────────

const sig = (ts: number, type: ReplayKitSignal["type"] = "dead_click", selector = "div.a"): ReplayKitSignal => ({ type, ts, url: "https://x.test/", selector });

test("signals: held until init, then batched; 403 disables", async () => {
  const f = fakeEnv({ signals: [202, 403] });
  const api = new Api(f.env, "https://api.test", "k");
  const q = new SignalQueue(f.env, api, () => ({ sid: "s", vid: "v" }));
  q.add(sig(1));
  q.add(sig(5_000, "error"));
  assert.equal(f.calls.length, 0);
  q.release(true);
  await q.flush();
  assert.equal(f.calls.length, 1);
  assert.equal((f.calls[0].body as { signals: unknown[] }).signals.length, 2);
  q.add(sig(10_000, "rage_click"));
  await q.flush();
  assert.equal(q.disabled, true);
  q.add(sig(20_000));
  assert.equal(q.size, 0);
});

test("signals: duplicates folded, batches capped at 50, beacon on hide", async () => {
  const f = fakeEnv();
  const api = new Api(f.env, "https://api.test", "k");
  const q = new SignalQueue(f.env, api, () => ({ sid: "s", vid: "v" }));
  q.add(sig(0));
  q.add(sig(500));
  assert.equal(q.size, 1, "same signal within 2 s folded");
  for (let i = 0; i < 120; i++) q.add(sig(10_000 + i * 3000, "dead_click", `div.n${i}`));
  q.release(true);
  q.beacon();
  const beacons = f.calls.filter((c) => c.method === "BEACON");
  assert.equal(beacons.length, 3);
  assert.ok(beacons.every((b) => (b.body as { signals: unknown[] }).signals.length <= 50));
  assert.equal(q.size, 0);
});

test("signals: released with signals off drops everything", () => {
  const f = fakeEnv();
  const q = new SignalQueue(f.env, new Api(f.env, "https://api.test", "k"), () => ({ sid: "s", vid: "v" }));
  q.add(sig(0));
  q.release(false);
  assert.equal(q.size, 0);
  assert.equal(q.disabled, true);
});

test("pagesOf: page loads + SPA marks, query stripped, checkout repeats folded", () => {
  const ev: RrEvent[] = [
    { type: 4, timestamp: 1, data: { href: "https://a.com/x?token=1", width: 1, height: 1 } },
    { type: 2, timestamp: 2, data: {} },
    { type: 4, timestamp: 30_000, data: { href: "https://a.com/x?token=2" } },
    { type: 5, timestamp: 31_000, data: { tag: PAGE_TAG, payload: { href: "https://a.com/y#h" } } },
    { type: 5, timestamp: 32_000, data: { tag: "other", payload: { href: "https://a.com/z" } } },
  ];
  assert.deepEqual(pagesOf(ev, "", 50), [
    { url: "https://a.com/x", ts: 1 },
    { url: "https://a.com/y", ts: 31_000 },
  ]);
  // Next chunk starts with a checkout of the page already reported.
  assert.deepEqual(pagesOf([{ type: 4, timestamp: 60_000, data: { href: "https://a.com/y" } }], "https://a.com/y", 50), []);
  assert.equal(pagesOf(ev, "", 1).length, 1);
});
