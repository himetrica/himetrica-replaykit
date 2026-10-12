// Calls to the ingest (POST {apiUrl}/api/t/r/<op>?apiKey=...), text/plain JSON so
// they are "simple" CORS requests with no preflight, plus the PUT of a chunk to R2.
//
// Every response is reduced to an outcome the client acts on (see the contract in
// packages/shared/src/replaykit.ts):
//   ok        2xx
//   drop      400/413: this body is unusable, forget it
//   stop      401: bad key / origin not allowed, ReplayKit stops for this page
//   off       403: rollout, plan or this op is off for the project
//   quota     429: no more recordings this session (signals continue)
//   retry     5xx, network error, or no fetch at all

import type { Env } from "./env";
import type {
  ReplayKitChunkRequest,
  ReplayKitChunkResponse,
  ReplayKitInitRequest,
  ReplayKitInitResponse,
  ReplayKitSignalsRequest,
} from "./protocol";

export type Outcome = "ok" | "drop" | "stop" | "off" | "quota" | "retry";

export function outcomeOf(status: number): Outcome {
  if (status >= 200 && status < 300) return "ok";
  if (status === 401) return "stop";
  if (status === 403) return "off";
  if (status === 429) return "quota";
  if (status === 400 || status === 413 || status === 404 || status === 422) return "drop";
  return "retry";
}

export interface Result<T> {
  outcome: Outcome;
  data?: T;
}

export class Api {
  constructor(
    private readonly env: Env,
    private readonly apiUrl: string,
    private readonly apiKey: string,
  ) {}

  url(op: "init" | "chunk" | "signals"): string {
    return `${this.apiUrl}/api/t/r/${op}?apiKey=${encodeURIComponent(this.apiKey)}`;
  }

  init(body: ReplayKitInitRequest): Promise<Result<ReplayKitInitResponse>> {
    return this.post<ReplayKitInitResponse>("init", body, true);
  }

  chunk(body: ReplayKitChunkRequest): Promise<Result<ReplayKitChunkResponse>> {
    return this.post<ReplayKitChunkResponse>("chunk", body, true);
  }

  signals(body: ReplayKitSignalsRequest): Promise<Result<void>> {
    return this.post<void>("signals", body, false);
  }

  /** On page hide: fire-and-forget. False when the beacon could not be queued. */
  beaconSignals(body: ReplayKitSignalsRequest): boolean {
    return !!this.env.sendBeacon?.(this.url("signals"), JSON.stringify(body));
  }

  /** PUT the gzip'd chunk to the presigned R2 URL. R2 answers 200; 403 = URL expired or bad signature. */
  async put(url: string, blob: Blob): Promise<Outcome> {
    if (!this.env.fetch) return "retry";
    try {
      const res = await this.env.fetch(url, { method: "PUT", body: blob, headers: { "Content-Type": "application/gzip" } });
      if (res.status >= 200 && res.status < 300) return "ok";
      // An expired/rejected signature is fixed by asking for a new URL, not by dropping the chunk.
      return res.status === 400 || res.status === 413 ? "drop" : "retry";
    } catch {
      return "retry";
    }
  }

  private async post<T>(op: "init" | "chunk" | "signals", body: unknown, wantJson: boolean): Promise<Result<T>> {
    if (!this.env.fetch) return { outcome: "retry" };
    try {
      const res = await this.env.fetch(this.url(op), {
        method: "POST",
        body: JSON.stringify(body),
        headers: { "Content-Type": "text/plain" },
        keepalive: false,
        credentials: "omit",
      });
      const outcome = outcomeOf(res.status);
      if (outcome !== "ok" || !wantJson) return { outcome };
      try {
        return { outcome, data: (await res.json()) as T };
      } catch {
        return { outcome: "retry" };
      }
    } catch {
      return { outcome: "retry" };
    }
  }
}

export const BASE_BACKOFF_MS = 2_000;
export const MAX_BACKOFF_MS = 60_000;

export function backoff(failures: number): number {
  return Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** Math.max(0, failures - 1));
}
