// DOM side of the friction signals: listeners that turn real clicks, errors,
// navigations and forms into ReplayKitSignal values. The decisions themselves
// (what is a rage click, what is a dead click) live in detect.ts.
//
// Passive capture-phase listeners only; nothing is patched. The MutationObserver a
// dead-click check needs is attached for DEAD_CLICK_WAIT_MS after a candidate click
// and disconnected right after, so a quiet page costs nothing.
//
// Never sent: what was typed. A clicked element's text is only read when it is not a
// field and not masked (.hm-mask, [data-hm-mask], or maskAllText).

import {
  DEAD_CLICK_WAIT_MS,
  isDeadClick,
  isDeadClickCandidate,
  RAGE_WINDOW_MS,
  RageDetector,
  type ClickTargetFacts,
} from "./detect";
import { stripUrl } from "./match";
import type { ReplayKitSignal } from "./protocol";

export interface SignalHooks {
  now(): number;
  /** Text of clicked elements is withheld (config maskAllText). */
  maskAllText(): boolean;
  signal(s: ReplayKitSignal): void;
  /** A trigger fired: the 3rd click of a rage burst, or a JS error. */
  trigger(t: "rage_click" | "error"): void;
  /** Any click / key / scroll, for active time and click counts. */
  input(kind: "click" | "key" | "scroll", ts: number): void;
  /** The URL changed without a page load (SPA navigation). */
  navigated(url: string): void;
}

const INTERACTIVE = 'a[href],button,summary,[role="button"],[role="link"],[role="tab"],[role="menuitem"],[role="checkbox"],[role="switch"],[role="option"],[onclick]';
const FIELD = "input,textarea,select,label,option,[contenteditable],[contenteditable=true]";
const MASKED = ".hm-mask,[data-hm-mask],[data-hm-block],.hm-block";
const MAX_TEXT = 80;
const MAX_DETAIL = 200;

/** Short CSS path: up to 3 levels, stops at an id. Hashed class names (css-1x2y3z) are skipped. */
export function selectorOf(el: Element | null): string {
  const parts: string[] = [];
  let cur: Element | null = el;
  for (let depth = 0; cur && depth < 3 && cur.nodeType === 1; depth++) {
    const tag = cur.tagName.toLowerCase();
    if (tag === "html" || tag === "body") break;
    if (cur.id && /^[A-Za-z][\w-]{0,40}$/.test(cur.id) && !/\d{3,}/.test(cur.id)) {
      parts.unshift(`${tag}#${cur.id}`);
      break;
    }
    const classes = (typeof cur.className === "string" ? cur.className : "")
      .split(/\s+/)
      .filter((c) => c && c.length < 30 && !/\d{3,}|^css-|^sc-|__/.test(c))
      .slice(0, 2);
    parts.unshift(tag + classes.map((c) => "." + c).join(""));
    cur = cur.parentElement;
  }
  return parts.join(" > ");
}

function visibleText(el: Element, maskAll: boolean): string | undefined {
  if (maskAll || el.closest(MASKED) || el.closest(FIELD)) return undefined;
  const t = ((el as HTMLElement).innerText ?? el.textContent ?? "").replace(/\s+/g, " ").trim();
  if (!t) return (el.getAttribute("aria-label") || el.getAttribute("title") || undefined)?.slice(0, MAX_TEXT);
  return t.slice(0, MAX_TEXT);
}

function targetFacts(el: Element): ClickTargetFacts {
  let pointer = false;
  try {
    pointer = getComputedStyle(el).cursor === "pointer";
  } catch {
    pointer = false;
  }
  const sel = typeof getSelection === "function" ? getSelection() : null;
  return {
    tag: el.tagName.toLowerCase(),
    insideInteractive: !!el.closest(INTERACTIVE),
    isFormField: !!el.closest(FIELD),
    pointerCursor: pointer,
    hasSelection: !!sel && !sel.isCollapsed && sel.toString().trim().length > 0,
  };
}

/** The element a click "means": the nearest interactive ancestor, else the target itself. */
function clickedElement(target: EventTarget | null): Element | null {
  const el = target instanceof Element ? target : target instanceof Node ? target.parentElement : null;
  if (!el) return null;
  return el.closest(INTERACTIVE) || el;
}

export class SignalCollector {
  private rage = new RageDetector();
  private rageEl: Element | null = null;
  private rageTimer: ReturnType<typeof setTimeout> | null = null;
  private lastHref = "";
  private hrefTimer: ReturnType<typeof setInterval> | null = null;
  private unloading = false;
  private lastScrollInput = 0;
  private forms = new Map<HTMLFormElement, Set<string>>();
  private errorsSeen = new Set<string>();
  private off: Array<() => void> = [];

  constructor(private readonly h: SignalHooks) {}

  start(): void {
    this.lastHref = location.href;
    const on = <K extends keyof WindowEventMap>(type: K, fn: (e: WindowEventMap[K]) => void, target: Window | Document = window) => {
      const opts = { capture: true, passive: true };
      target.addEventListener(type, fn as EventListener, opts);
      this.off.push(() => target.removeEventListener(type, fn as EventListener, opts));
    };
    on("click", (e) => this.onClick(e));
    on("keydown", () => this.h.input("key", this.h.now()));
    on("scroll", () => {
      const now = this.h.now();
      if (now - this.lastScrollInput > 250) {
        this.lastScrollInput = now;
        this.h.input("scroll", now);
      }
    });
    on("error", (e) => this.onError(e.message || (e.error as Error | undefined)?.message || ""));
    on("unhandledrejection", (e) => {
      const r = e.reason as { message?: string } | string | undefined;
      this.onError(typeof r === "string" ? r : r?.message || "Unhandled promise rejection");
    });
    on("popstate", () => this.backNav());
    on("input", (e) => this.onField(e.target));
    on("change", (e) => this.onField(e.target));
    on("submit", (e) => {
      if (e.target instanceof HTMLFormElement) this.forms.delete(e.target);
    });
    on("pageshow", () => {
      this.unloading = false;
    });
    // SPA navigations: no patching of history, a cheap href poll instead.
    this.hrefTimer = setInterval(() => this.checkHref(), 1000);
    // Arrived here with the back/forward button.
    try {
      const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
      if (nav?.type === "back_forward") this.emit({ type: "back_nav", detail: stripUrl(location.href) });
    } catch {
      // Navigation Timing unavailable.
    }
  }

  stop(): void {
    for (const f of this.off) f();
    this.off = [];
    if (this.hrefTimer) clearInterval(this.hrefTimer);
    if (this.rageTimer) clearTimeout(this.rageTimer);
    this.hrefTimer = this.rageTimer = null;
  }

  /** Called by the client on pagehide, before it beacons the queue: report what the page leaves behind. */
  pageHide(): void {
    this.unloading = true;
    this.flushForms();
    this.flushRage(true);
  }

  private emit(s: Omit<ReplayKitSignal, "ts" | "url"> & { ts?: number }): void {
    this.h.signal({ ts: s.ts ?? this.h.now(), url: stripUrl(location.href), ...s } as ReplayKitSignal);
  }

  private checkHref(): void {
    const href = location.href;
    if (href === this.lastHref) return;
    const prev = this.lastHref;
    this.lastHref = href;
    if (stripUrl(href) !== stripUrl(prev)) this.h.navigated(stripUrl(href));
  }

  private onClick(e: MouseEvent): void {
    const ts = this.h.now();
    this.h.input("click", ts);
    const el = clickedElement(e.target);
    if (!el) return;
    const selector = selectorOf(el);
    const r = this.rage.onClick({ x: e.clientX, y: e.clientY, ts, target: selector });
    if (r.finished) this.reportRage(r.finished.count, r.finished.first.ts);
    if (r.trigger) this.h.trigger("rage_click");
    this.rageEl = this.rage.currentCount() === 1 ? el : this.rageEl;
    if (this.rageTimer) clearTimeout(this.rageTimer);
    this.rageTimer = setTimeout(() => this.flushRage(false), RAGE_WINDOW_MS + 50);
    if (this.rage.currentCount() === 1) this.watchDeadClick(el, selector, ts);
  }

  private flushRage(force: boolean): void {
    const b = this.rage.flush(force ? Number.MAX_SAFE_INTEGER : this.h.now());
    if (b) this.reportRage(b.count, b.first.ts);
  }

  private reportRage(count: number, ts: number): void {
    const el = this.rageEl;
    this.emit({ type: "rage_click", ts, count, selector: el ? selectorOf(el) : undefined, text: el ? visibleText(el, this.h.maskAllText()) : undefined });
  }

  private watchDeadClick(el: Element, selector: string, ts: number): void {
    if (!isDeadClickCandidate(targetFacts(el))) return;
    const hrefBefore = location.href;
    const scrollBefore = `${scrollX},${scrollY}`;
    const focusBefore = document.activeElement;
    let mutations = 0;
    let mo: MutationObserver | null = null;
    try {
      mo = new MutationObserver((list) => {
        mutations += list.length;
      });
      mo.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
    } catch {
      return;
    }
    setTimeout(() => {
      mo?.disconnect();
      // Part of a rage burst: reported as a rage click, not also as a dead one.
      if (this.rage.currentCount() > 1) return;
      const dead = isDeadClick({
        mutations,
        urlChanged: location.href !== hrefBefore,
        scrolled: `${scrollX},${scrollY}` !== scrollBefore,
        focusChanged: document.activeElement !== focusBefore && document.activeElement !== el,
        unloading: this.unloading,
      });
      if (dead) this.emit({ type: "dead_click", ts, selector, text: visibleText(el, this.h.maskAllText()) });
    }, DEAD_CLICK_WAIT_MS);
  }

  private onError(message: string): void {
    const detail = (message || "Error").slice(0, MAX_DETAIL);
    if (this.errorsSeen.has(detail)) return;
    this.errorsSeen.add(detail);
    this.emit({ type: "error", detail });
    this.h.trigger("error");
  }

  private backNav(): void {
    this.emit({ type: "back_nav", detail: stripUrl(location.href) });
    this.checkHref();
  }

  private onField(target: EventTarget | null): void {
    if (!(target instanceof Element)) return;
    const form = target.closest("form");
    if (!form) return;
    const key = target.getAttribute("name") || target.id || selectorOf(target);
    let set = this.forms.get(form);
    if (!set) this.forms.set(form, (set = new Set()));
    set.add(key);
  }

  /** Forms touched and never submitted, reported when the page goes away. */
  private flushForms(): void {
    for (const [form, fields] of this.forms) {
      if (!form.isConnected && fields.size === 0) continue;
      this.emit({ type: "form_abandon", selector: selectorOf(form), count: fields.size });
    }
    this.forms.clear();
  }
}
