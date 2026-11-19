import type { AdapterType } from "../types.ts";
import { grokTagAdapter } from "./grok_tag.ts";
import { grokWebhookAdapter } from "./grok_webhook.ts";
import { storeOnlyAdapter } from "./store_only.ts";
import type { DeliveryAdapter } from "./types.ts";

export type { AdapterContext, AdapterResult, DeliveryAdapter } from "./types.ts";

const adapters: Record<Exclude<AdapterType, "drop">, DeliveryAdapter> = {
  grok_webhook: grokWebhookAdapter,
  grok_tag: grokTagAdapter,
  store_only: storeOnlyAdapter,
};

export function getAdapter(type: AdapterType): DeliveryAdapter | null {
  if (type === "drop") return null;
  return adapters[type] ?? null;
}
