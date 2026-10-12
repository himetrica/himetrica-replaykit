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
