// rrweb, loaded only when this page may record.
//
// The ESM build turns the dynamic import into a separate chunk, so a page that only
// sends signals never downloads rrweb (~24 KB gzip). The IIFE build bundles it.
//
// Privacy defaults that config cannot turn off:
//   - every input value is masked (maskAllInputs), passwords and card fields included;
//   - card fields ([autocomplete^="cc-"]) and [data-hm-block] / .hm-block are blocked:
//     replaced by an empty box of the same size, their content never leaves the page;
//   - text marked .hm-mask / [data-hm-mask] is masked; maskAllText masks every text node;
//   - canvas, cross-origin iframes and inlined images are not recorded.

import type { RrEvent } from "./buffer";
import { CHECKOUT_MS, PAGE_TAG } from "./buffer";

export interface RecorderOptions {
  blockSelectors: string[];
  maskAllText: boolean;
  emit(e: RrEvent): void;
}

type RecordFn = typeof import("@rrweb/record").record;

const BASE_BLOCK = ['[data-hm-block]', ".hm-block", '[autocomplete^="cc-"]', 'input[type="password"]'];
const BASE_MASK = ".hm-mask,[data-hm-mask]";

let recordFn: Promise<RecordFn> | null = null;

function loadRecord(): Promise<RecordFn> {
  return (recordFn ??= import("@rrweb/record").then((m) => m.record));
}

/** Drops selectors the browser rejects: one bad entry in the config must not stop rrweb. */
export function validSelectors(list: string[]): string[] {
  return list.filter((s) => {
    if (!s || typeof s !== "string") return false;
    try {
      document.createDocumentFragment().querySelector(s);
      return true;
    } catch {
      return false;
    }
  });
}

export class Recorder {
  private stopFn: (() => void) | undefined;
  private record: RecordFn | null = null;
  private stopped = false;

  async start(o: RecorderOptions): Promise<boolean> {
    try {
      this.record = await loadRecord();
    } catch {
      return false;
    }
    if (this.stopped) return false;
    try {
      this.stopFn = this.record({
        emit: (e) => o.emit(e as unknown as RrEvent),
        checkoutEveryNms: CHECKOUT_MS,
        maskAllInputs: true,
        maskInputOptions: { password: true },
        maskTextSelector: o.maskAllText ? "*" : BASE_MASK,
        blockSelector: validSelectors([...BASE_BLOCK, ...o.blockSelectors]).join(","),
        recordCanvas: false,
        recordCrossOriginIframes: false,
        inlineImages: false,
        collectFonts: false,
        slimDOMOptions: { script: true, comment: true, headFavicon: true, headWhitespace: true, headMetaSocial: true, headMetaRobots: true, headMetaHttpEquiv: true, headMetaVerification: true, headMetaAuthorship: true },
        sampling: { mousemove: 50, scroll: 150, input: "last" },
      }) ?? undefined;
      return !!this.stopFn;
    } catch {
      return false;
    }
  }

  /** New full snapshot right now (the first event of a fresh recording must be one). */
  snapshot(): void {
    try {
      this.record?.takeFullSnapshot(true);
    } catch {
      // Not recording.
    }
  }

  /** Marks an SPA URL change in the stream (the player and the page list read it). */
  page(href: string): void {
    try {
      this.record?.addCustomEvent(PAGE_TAG, { href });
    } catch {
      // Not recording.
    }
  }

  stop(): void {
    this.stopped = true;
    try {
      this.stopFn?.();
    } catch {
      // Already stopped.
    }
    this.stopFn = undefined;
  }
}
