import type { NormalizedMessage, RouteRule } from "../types.ts";

export interface AdapterResult {
  ok: boolean;
  httpStatus?: number;
  error?: string;
}

export interface AdapterContext {
  fetch: typeof fetch;
  env: Record<string, string | undefined>;
  now: number;
  consoleUrl?: string;
  /** Outbound hop to stamp when an adapter actually sends mail. */
  nextHop: number;
  loopToken: string;
}

export interface DeliveryAdapter {
  type: RouteRule["type"];
  deliver(
    rowId: string,
    msg: NormalizedMessage,
    route: RouteRule,
    ctx: AdapterContext,
  ): Promise<AdapterResult>;
}
