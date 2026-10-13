// What this page does about recording, from what /init said and the session state.
// Pure, so the whole decision table is unit-tested.

import type { ReplayKitTrigger } from "./protocol";
import type { SessionState } from "./state";

export type PageMode =
  /** Nothing is recorded on this page (signals may still flow). */
  | { kind: "off" }
  /** requireConsent and the banner has not said yes yet. */
  | { kind: "wait_consent" }
  /** A recording of this session is already running: continue it. */
  | { kind: "continue" }
  /** Start a recording now, for this reason. */
  | { kind: "start"; trigger: ReplayKitTrigger }
  /** Keep the pre-trigger buffer and wait for a trigger. */
  | { kind: "buffer" };

export interface DecideInput {
  /** /init answered record: true. */
  record: boolean;
  /** CompressionStream exists (chunks are gzip'd in the browser). */
  canGzip: boolean;
  state: SessionState;
  /** Path is in excludePaths. */
  excluded: boolean;
  requireConsent: boolean;
  /** Consent stored by ReplayKit.consent(): true, false, or never given. */
  consent: boolean | null;
  forceTrigger: ReplayKitTrigger | null;
  sampled: boolean;
  /** Path matched checkoutPaths and "checkout" is an enabled trigger. */
  checkout: boolean;
}

/** Triggers that open a recording however short the visit is (same list as the API's). */
export const MIN_DURATION_EXEMPT: readonly ReplayKitTrigger[] = ["error", "rage_click", "manual"];

/**
 * How long trigger `t` still has to wait before it may open a recording, given how long the
 * session has been on screen. 0 = open it now. A bounce never reaches the minimum, so it never
 * opens a recording nor costs quota; an error or a rage click does not wait.
 */
export function waitBeforeRecording(t: ReplayKitTrigger, visibleMs: number, minDurationMs: number): number {
  if (minDurationMs <= 0 || MIN_DURATION_EXEMPT.includes(t)) return 0;
  return Math.max(0, minDurationMs - visibleMs);
}

export function decidePage(i: DecideInput): PageMode {
  // An explicit ReplayKit.consent(false) wins even when the project does not require consent.
  if (!i.record || !i.canGzip || i.state.stopped || i.excluded || i.consent === false) return { kind: "off" };
  if (i.requireConsent && i.consent !== true) return { kind: "wait_consent" };
  if (i.state.rid) return { kind: "continue" };
  if (i.forceTrigger) return { kind: "start", trigger: i.forceTrigger };
  if (i.checkout) return { kind: "start", trigger: "checkout" };
  if (i.sampled) return { kind: "start", trigger: "sample" };
  return { kind: "buffer" };
}
