// Browser globals behind one interface, like ErrorKit's env.ts.
//
// Network, storage, timers and the clock go through an Env, so the transport, the
// uploader and the client run in plain Node under node:test with fakes. DOM wiring
// (listeners, rrweb) stays in signals-dom.ts / recorder.ts and is not unit-tested.

export interface FetchResult {
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}

export interface Env {
  now(): number;
  uuid(): string;
  fetch?: (url: string, init: RequestInit) => Promise<FetchResult>;
  sendBeacon?: (url: string, body: string) => boolean;
  getLocal(key: string): string | null;
  setLocal(key: string, value: string | null): void;
  getSession(key: string): string | null;
  setSession(key: string, value: string | null): void;
  getCookie(name: string): string | null;
  /** Async key/value store that survives a page load (IndexedDB). Missing = nothing carried across pages. */
  store?: KvStore;
  /** gzip; undefined when CompressionStream is unavailable (recording is then skipped). */
  gzip?: (text: string) => Promise<Blob>;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

export interface KvStore {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  del(key: string): Promise<void>;
}

export const isBrowser = typeof window !== "undefined" && typeof document !== "undefined";

export function uuidV4(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c && typeof c.randomUUID === "function") {
    try {
      return c.randomUUID();
    } catch {
      // randomUUID throws on insecure origins in some browsers; fall through.
    }
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    return (ch === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

// Storage throws in Safari private mode, sandboxed iframes and under storage policies.
function safeGet(storage: () => Storage, key: string): string | null {
  try {
    return storage().getItem(key);
  } catch {
    return null;
  }
}

function safeSet(storage: () => Storage, key: string, value: string | null): void {
  try {
    if (value === null) storage().removeItem(key);
    else storage().setItem(key, value);
  } catch {
    // Unavailable or full: in-memory state still works for this page.
  }
}

/** One IndexedDB object store used as a key/value map. Every failure degrades to "nothing stored". */
function indexedDbStore(): KvStore | undefined {
  if (typeof indexedDB === "undefined") return undefined;
  let dbp: Promise<IDBDatabase> | null = null;
  const open = () =>
    (dbp ??= new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open("himetrica-replaykit", 1);
      req.onupgradeneeded = () => req.result.createObjectStore("kv");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }));
  const run = <T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest | void): Promise<T | undefined> =>
    open()
      .then(
        (db) =>
          new Promise<T | undefined>((resolve) => {
            const tx = db.transaction("kv", mode);
            const req = fn(tx.objectStore("kv"));
            tx.oncomplete = () => resolve(req ? (req.result as T) : undefined);
            tx.onerror = tx.onabort = () => resolve(undefined);
          }),
      )
      .catch(() => undefined);
  return {
    get: <T>(key: string) => run<T>("readonly", (s) => s.get(key)),
    set: (key, value) => run<void>("readwrite", (s) => void s.put(value, key)).then(() => undefined),
    del: (key) => run<void>("readwrite", (s) => void s.delete(key)).then(() => undefined),
  };
}

function gzipFn(): Env["gzip"] {
  if (typeof CompressionStream === "undefined" || typeof Blob === "undefined" || typeof Response === "undefined") return undefined;
  return (text) => new Response(new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"))).blob();
}

export function browserEnv(): Env {
  const originalFetch = typeof fetch === "function" ? fetch.bind(globalThis) : undefined;
  const nav = typeof navigator !== "undefined" ? navigator : undefined;
  return {
    now: () => Date.now(),
    uuid: () => uuidV4(),
    fetch: originalFetch as Env["fetch"],
    sendBeacon:
      nav && typeof nav.sendBeacon === "function"
        ? (url, body) => {
            try {
              return nav.sendBeacon(url, new Blob([body], { type: "text/plain" }));
            } catch {
              return false;
            }
          }
        : undefined,
    getLocal: (key) => safeGet(() => localStorage, key),
    setLocal: (key, value) => safeSet(() => localStorage, key, value),
    getSession: (key) => safeGet(() => sessionStorage, key),
    setSession: (key, value) => safeSet(() => sessionStorage, key, value),
    getCookie: (name) => {
      try {
        const match = document.cookie.match(new RegExp("(?:^|; )" + name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "=([^;]*)"));
        return match ? decodeURIComponent(match[1]) : null;
      } catch {
        return null;
      }
    },
    store: indexedDbStore(),
    gzip: gzipFn(),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  };
}
