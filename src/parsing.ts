// What code (not Jev) reads out of a message. Pure, so it's testable without credentials.

export const NOT_MENTIONED = "not_mentioned";
// Below this, ask instead of guessing. Tuned for jev-1.13.0; revisit when changing models.
export const MIN_CONFIDENCE = 0.6;

// A cheap guard on top of Jev: only accept a branch that actually appears in what the user wrote.
export function mentioned(branch: string, text: string): boolean {
  const escaped = branch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\w/.-])${escaped}($|[^\\w/.-])`, "i").test(text);
}

export function pickBranch(answer: { choice: string; confidence: number }, text: string): string | null {
  if (answer.choice === NOT_MENTIONED || answer.confidence < MIN_CONFIDENCE) return null;
  return mentioned(answer.choice, text) ? answer.choice : null;
}

export const versionInText = (text: string): string | null => text.match(/\b(\d+\.\d+\.\d+)\b/)?.[1] ?? null;

export const otaMessage = (text: string): string => text.match(/["“”']([^"“”']{3,})["“”']/)?.[1] ?? "OTA update";
