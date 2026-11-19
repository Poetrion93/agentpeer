/**
 * Fixed auto-notice patterns. A match is blocked_autonotice and is never delivered.
 * Seeded from a real 2026-11-19 Hermes "No home channel" ping-pong.
 */
export const AUTO_NOTICE_PATTERNS: RegExp[] = [
  /no home channel/i,
  /does not have a home channel/i,
  /홈\s*채널이 없/i,
];

export function matchesAutoNotice(subject: string, text: string): string | null {
  const hay = `${subject}\n${text}`;
  for (const re of AUTO_NOTICE_PATTERNS) {
    if (re.test(hay)) return re.source;
  }
  return null;
}
