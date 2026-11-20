import data from "./notice-patterns.json";

/**
 * Auto-notice patterns live in notice-patterns.json (one data file).
 * A match is blocked_autonotice and is never delivered.
 */
export const AUTO_NOTICE_PATTERNS: RegExp[] = (data.patterns as string[]).map(
  (p) => new RegExp(p, "i"),
);

export function matchesAutoNotice(subject: string, text: string): string | null {
  const hay = `${subject}\n${text}`;
  for (const re of AUTO_NOTICE_PATTERNS) {
    if (re.test(hay)) return re.source;
  }
  return null;
}
