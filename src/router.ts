import type { AdapterType, RouteRule } from "./types.ts";

/**
 * Minimal YAML subset loader for routes.example.yaml style lists.
 * No extra parser dependency (MVP shortcut; upgrade if the file grows).
 */
export function parseRoutesYaml(src: string): RouteRule[] {
  const rules: RouteRule[] = [];
  let current: Partial<RouteRule> & { allowedSenders: string[] } | null = null;
  let inAllow = false;

  const flush = () => {
    if (!current?.address) return;
    const type = (current.type ?? "store_only") as AdapterType;
    rules.push({
      id: current.id ?? current.address,
      address: current.address.toLowerCase(),
      type,
      target: current.target,
      allowedSenders: current.allowedSenders,
    });
  };

  for (const raw of src.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "");
    if (!line.trim()) continue;

    // Top-level list items only (no leading indent). Nested "- " belong to allowlists.
    if (/^-\s+/.test(line)) {
      if (current) flush();
      current = { allowedSenders: [] };
      inAllow = false;
      const idm = line.match(/^-\s+id:\s*(.+)$/);
      if (idm) current.id = unquote(idm[1]);
      const adm = line.match(/^-\s+address:\s*(.+)$/);
      if (adm) current.address = unquote(adm[1]);
      continue;
    }
    if (!current) continue;

    if (/^\s+allowed_senders:\s*$/.test(line)) {
      inAllow = true;
      continue;
    }
    const allowItem = line.match(/^\s+-\s+(.+)$/);
    if (inAllow && allowItem) {
      current.allowedSenders.push(unquote(allowItem[1]));
      continue;
    }
    inAllow = false;
    const kv = line.match(/^\s+(id|address|type|target):\s*(.+)$/);
    if (kv) {
      const key = kv[1] as "id" | "address" | "type" | "target";
      const val = unquote(kv[2]);
      if (key === "type") current.type = val as AdapterType;
      else current[key] = val;
    }
  }
  if (current) flush();
  return rules;
}

function unquote(s: string): string {
  const t = s.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

export function matchRoute(rules: RouteRule[], recipient: string): RouteRule | null {
  const addr = recipient.toLowerCase();
  return rules.find((r) => r.address === addr) ?? null;
}
