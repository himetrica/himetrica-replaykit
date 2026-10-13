// Wire protocol with the Himetrica API: a copy of the ingest half of the contract in
// packages/shared/src/replaykit.ts (the source of truth). The SDK is published on its
// own, so it cannot depend on the private shared package at runtime;
// protocol-compat.ts makes `tsc` fail if the two drift apart.

export type ReplayKitTrigger = "error" | "rage_click" | "checkout" | "paying" | "sample" | "manual";

export type ReplayKitSignalType = "rage_click" | "dead_click" | "error" | "back_nav" | "form_abandon";

export interface ReplayKitClientConfig {
  sampleRate: number;
  triggers: Array<Exclude<ReplayKitTrigger, "sample" | "manual">>;
  checkoutPaths: string[];
  excludePaths: string[];
  blockSelectors: string[];
  maskAllText: boolean;
  requireConsent: boolean;
  minDurationMs: number;
}

export interface ReplayKitInitRequest {
  sid: string;
  vid: string;
  url: string;
}

export interface ReplayKitInitResponse {
  signals: boolean;
  record: boolean;
  forceTrigger: ReplayKitTrigger | null;
  config: ReplayKitClientConfig;
}

export interface ReplayKitRecordingStats {
  startedAt: number;
  endedAt: number;
  activeMs: number;
  clicks: number;
  rageClicks: number;
  deadClicks: number;
  errors: number;
  pages: number;
  entryUrl: string;
}

export interface ReplayKitChunkRequest {
  rid: string;
  sid: string;
  vid: string;
  seq: number;
  bytes: number;
  trigger: ReplayKitTrigger;
  stats: ReplayKitRecordingStats;
  /**
   * Pages shown inside this chunk, in order: page loads (rrweb Meta events) and SPA URL
   * changes, query and fragment stripped. A URL repeated back to back is sent once.
   * Max REPLAYKIT_MAX_PAGES_PER_CHUNK, url max 500 chars.
   */
  pages: Array<{ url: string; ts: number }>;
}

export interface ReplayKitChunkResponse {
  url: string;
  expiresAt: number;
}

export interface ReplayKitSignal {
  type: ReplayKitSignalType;
  ts: number;
  url: string;
  selector?: string;
  text?: string;
  count?: number;
  detail?: string;
}

export interface ReplayKitSignalsRequest {
  sid: string;
  vid: string;
  rid?: string;
  signals: ReplayKitSignal[];
}

export interface ReplayKitChunkFile {
  v: 1;
  rid: string;
  seq: number;
  events: unknown[];
}

export const REPLAYKIT_MAX_CHUNK_BYTES = 2 * 1024 * 1024;
export const REPLAYKIT_MAX_CHUNKS = 600;
export const REPLAYKIT_MAX_PAGES_PER_CHUNK = 50;
/** A recording ends after this long (a tab left open for hours is not one visit). */
export const REPLAYKIT_MAX_DURATION_MS = 20 * 60_000;
/** A recording ends after this long without a click, key or scroll. */
export const REPLAYKIT_MAX_IDLE_MS = 10 * 60_000;
export const REPLAYKIT_MAX_SIGNALS_PER_BATCH = 50;
