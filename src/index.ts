// @himetrica/replaykit: session replay and friction signals for the web.
//
//   import * as ReplayKit from "@himetrica/replaykit";
//   ReplayKit.init({ apiKey: "hm_..." });
//
// Needs the Himetrica tracker on the same page: recordings and signals belong to the
// tracker's visitor and session. What is recorded, and when, is configured per
// project in the dashboard; the SDK reads it from /init on every page.

import { ReplayKitClient, type ReplayKitOptions } from "./client";

export type { ReplayKitOptions } from "./client";
export type { ReplayKitSignal, ReplayKitSignalType, ReplayKitTrigger } from "./protocol";

let client: ReplayKitClient | null = null;

/** Starts ReplayKit. A second call is ignored. */
export function init(options: ReplayKitOptions): void {
  if (client) return;
  client = new ReplayKitClient(options);
  client.start();
}

/** Record this session from now on (and keep the pre-trigger buffer). */
export function start(): void {
  client?.manualStart();
}

/**
 * Mark this moment as worth a recording, like an error would. `reason` is for your
 * own debugging (logged with `debug: true`); the recording is tagged "manual".
 */
export function trigger(reason?: string): void {
  client?.manualStart(reason);
}

/** Stop recording for the rest of the session. What was captured is still uploaded. */
export function stop(): void {
  client?.manualStop();
}

/**
 * The visitor's answer to your consent banner. With "require consent" on in the
 * project, nothing is recorded until consent(true). consent(false) stops and drops
 * what was not uploaded yet. Remembered on this device.
 */
export function consent(granted: boolean): void {
  if (client) client.consent(granted);
  else {
    try {
      localStorage.setItem("hm_rk_consent", granted ? "1" : "0");
    } catch {
      // Storage unavailable.
    }
  }
}

/** Id of the recording running on this page, if any. */
export function getRecordingId(): string | null {
  return client?.recordingId() ?? null;
}

/** Stops everything and removes the listeners (tests, SPA teardown). */
export function shutdown(): void {
  client?.destroy();
  client = null;
}
