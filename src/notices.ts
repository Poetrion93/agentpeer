import data from "./notice-patterns.json";

/**
 * Auto-notice patterns live in notice-patterns.json (one data file).
 * hard_block: always blocked_autonotice and never delivered.
 * suspect: delivered normally, only marked with a suspect_autonotice event.
 */
function compile(list: string[]): RegExp[] {
  return list.map((p) => new RegExp(p, "i"));
}

export const HARD_NOTICE_PATTERNS: RegExp[] = compile(data.hard_block as string[]);
export const SUSPECT_NOTICE_PATTERNS: RegExp[] = compile(data.suspect as string[]);

function firstMatch(patterns: RegExp[], subject: string, text: string): string | null {
  const hay = `${subject}\n${text}`;
  for (const re of patterns) {
    if (re.test(hay)) return re.source;
  }
  return null;
}

export function matchesHardAutoNotice(subject: string, text: string): string | null {
  return firstMatch(HARD_NOTICE_PATTERNS, subject, text);
}

export function matchesSuspectAutoNotice(subject: string, text: string): string | null {
  return firstMatch(SUSPECT_NOTICE_PATTERNS, subject, text);
}
