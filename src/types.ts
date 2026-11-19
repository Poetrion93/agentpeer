export type MessageStatus =
  | "received"
  | "duplicate"
  | "blocked_loop"
  | "blocked_autonotice"
  | "blocked_auth"
  | "routed"
  | "delivered"
  | "failed";

export type MessageKind =
  | "bot_instruction"
  | "bot_report"
  | "human"
  | "auto_notice"
  | "test";

export type Channel = "email"; // later: direct | a2a | feed
export type Source = "forwardemail"; // later: cf-email | api

export type AdapterType = "grok_webhook" | "grok_tag" | "store_only" | "drop";

export interface AuthFlags {
  dkim?: string;
  spf?: string;
  dmarc?: string;
}

export interface NormalizedMessage {
  tenantId: string;
  channel: Channel;
  source: Source;
  messageId: string | null;
  threadId: string;
  from: { addr: string; name: string };
  to: string[];
  recipient: string;
  kind: MessageKind;
  auth: AuthFlags;
  subject: string;
  text: string;
  rawRef: string | null;
  attachmentsMeta: unknown[];
  headers: Record<string, string>;
  receivedAt: number;
  dateHeader: string;
}

export interface RouteRule {
  id: string;
  address: string;
  type: AdapterType;
  /** For grok_webhook: env var name holding the URL. For grok_tag: destination address. */
  target?: string;
  allowedSenders: string[];
}

export interface MessageRow {
  id: string;
  tenant_id: string;
  channel: string;
  source: string;
  message_id: string | null;
  thread_id: string;
  from_addr: string;
  from_name: string;
  recipients_json: string;
  recipient: string;
  kind: string;
  auth_json: string;
  subject: string;
  text: string;
  raw_ref: string | null;
  attachments_meta_json: string;
  headers_subset_json: string;
  received_at: number;
  status: MessageStatus;
  route_id: string | null;
  dedup_key: string;
}

export interface DeliveryRow {
  id?: number;
  message_id: string;
  target: string | null;
  adapter: string;
  attempt: number;
  http_status: number | null;
  error: string | null;
  at: number;
}

export interface EventRow {
  id?: number;
  message_id: string | null;
  type: string;
  detail: string;
  at: number;
}

export interface EnvBindings {
  DB?: D1Database;
  INGEST_PATH_TOKEN?: string;
  FE_WEBHOOK_SIGNING_KEY?: string;
  FE_ALLOWED_IPS?: string;
  CONSOLE_TOKEN?: string;
  LOOP_TOKEN?: string;
  TENANT_ID?: string;
  MAIL_SEND_URL?: string;
  ROUTES_YAML?: string;
  [key: string]: unknown;
}

export interface ProcessResult {
  id: string;
  recipient: string;
  status: MessageStatus;
  reason?: string;
  routeId?: string;
}

export const RATE_WINDOW_MS = 10 * 60 * 1000;
export const RATE_THREAD_LIMIT = 5;
export const RATE_SENDER_LIMIT = 30;
/** Incoming X-Agentpeer-Hop greater than this is blocked. hop <= 3 is allowed. */
export const MAX_HOP = 3;
export const MAX_DELIVERY_ATTEMPTS = 3;
export const TEXT_LIMIT = 4000;
