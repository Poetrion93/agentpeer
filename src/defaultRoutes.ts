/** Default routes.yaml body (placeholders only). Overridden by env ROUTES_YAML. */
export const DEFAULT_ROUTES_YAML = `# Example routing table. Copy to routes.yaml and edit.
# Targets for grok_webhook are environment variable *names*, never raw URLs or keys.

- id: system
  address: system@bots.example.com
  type: grok_webhook
  target: GROK_WEBHOOK_SYSTEM
  allowed_senders:
    - lead@bots.example.com
    - "*@bots.example.com"

- id: dev
  address: dev@bots.example.com
  type: grok_tag
  target: inbox+dev@bots.example.com

- id: archive
  address: archive@bots.example.com
  type: store_only
`;
