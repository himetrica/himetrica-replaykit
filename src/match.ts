// Pure helpers the recording decision is made of: path globs and the session sample.

/**
 * Path glob, as the project config writes them: `*` matches any run of characters
 * (slashes included), everything else is literal. A pattern without `*` is a prefix
 * on a segment boundary: `/checkout` matches `/checkout` and `/checkout/step-2`, not
 * `/checkouts`. Matched against the pathname only, case-insensitive.
 */
export function matchPath(pattern: string, pathname: string): boolean {
  const p = pattern.trim().toLowerCase();
  if (!p) return false;
  const path = (pathname || "/").toLowerCase();
  if (!p.includes("*")) {
    const base = p.endsWith("/") && p.length > 1 ? p.slice(0, -1) : p;
    return path === base || path.startsWith(base.endsWith("/") ? base : base + "/");
  }
  const re = new RegExp("^" + p.split("*").map(escapeRegExp).join(".*") + "$");
  return re.test(path);
}

export function matchAny(patterns: readonly string[], pathname: string): boolean {
  for (const p of patterns) if (matchPath(p, pathname)) return true;
  return false;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Deterministic [0, 1) from the session id (cyrb53). Every page of a session gets the
 * same draw, so a sampled session is recorded across all its pages, and the server
 * could recompute it.
 */
export function sampleDraw(sessionId: string): number {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < sessionId.length; i++) {
    const ch = sessionId.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const n = 4294967296 * (2097151 & h2) + (h1 >>> 0);
  return n / 9007199254740992;
}

export function inSample(sessionId: string, rate: number): boolean {
  if (!(rate > 0)) return false;
  if (rate >= 1) return true;
  return sampleDraw(sessionId) < rate;
}

/** URL without query and hash: queries carry tokens and emails, never sent. */
export function stripUrl(href: string): string {
  const cut = href.search(/[?#]/);
  return cut === -1 ? href : href.slice(0, cut);
}
