// Finding the error in an EAS workflow job's logs (`eas workflow:logs <jobId> --json`). Pure.
// The logs are grouped by step. Custom workflow steps end with an `end-step` marker
// (result "fail" when they break), build phases with `END_PHASE` (result "failed").

export type LogLine = { msg?: string; marker?: string; result?: string; err?: unknown };
export type JobLogs = Record<string, LogLine[]>;

export type StepFailure = { step: string; lines: string[] };

// Build jobs end with this phase when an earlier one failed; it never says why.
const GENERIC_PHASES = new Set(["FAIL_BUILD"]);
const MARKERS = new Set(["start-step", "end-step", "START_PHASE", "END_PHASE"]);
// The shell wrapper's own error, which only says that the step's script exited.
const scriptExited = /^\/bin\/bash .* exited with non-zero code/;
const stackFrame = /^\s+at /;
const MAX_STEP_NAME = 60;

const failed = (lines: LogLine[]) => lines.some((l) => (MARKERS.has(l.marker ?? "") && (l.result === "fail" || l.result === "failed")) || l.err);

function stepName(key: string, lines: LogLine[]): string {
  const start = lines.find((l) => l.marker === "start-step")?.msg ?? "";
  const quoted = start.match(/^Executing build step "(.*)"$/)?.[1];
  // Phases are named by their key; unnamed steps show a template like "${this.displayName}".
  const name = quoted && !quoted.includes("${") ? quoted : key.toLowerCase().replace(/_/g, " ");
  return name.length > MAX_STEP_NAME ? `${name.slice(0, MAX_STEP_NAME - 1)}…` : name;
}

// Color codes, and the timestamps fastlane puts on every line.
const noise = /\u001b\[[0-9;]*m|^\[\d\d:\d\d:\d\d\]: /g;
export const stripNoise = (line: string) => line.replace(noise, "").trimEnd();

// The first step that failed, and its log lines without markers, color codes, stack frames or the
// shell wrapper's error.
export function failureInLogs(logs: JobLogs): StepFailure | null {
  const entries = Object.entries(logs).filter(([key, lines]) => !GENERIC_PHASES.has(key) && Array.isArray(lines));
  const found = entries.find(([, lines]) => failed(lines));
  if (!found) return null;
  const [key, lines] = found;
  return {
    step: stepName(key, lines),
    lines: lines
      .filter((l) => !MARKERS.has(l.marker ?? "") && typeof l.msg === "string")
      .map((l) => l.msg!.replace(noise, "").trimEnd())
      .filter((msg) => msg.trim() && !stackFrame.test(msg) && !scriptExited.test(msg)),
  };
}

// EAS refusing a cloud build because the account's free-plan builds for the month are spent.
// The message is EAS's; it shows up in the failed build job's log.
export const quotaExceeded = (lines: string[]) => lines.some((l) => /builds? from the Free plan/i.test(l));

// A local build's log (`eas build --local`, then `eas submit`), written by localbuild.ts as one file
// with a header line before each command. Parsed into the steps, the build number EAS assigned, and
// the TestFlight page eas submit prints.
export const LOCAL_STEP_HEADER = "### ";

export type LocalBuildLog = {
  steps: { step: string; lines: string[] }[];
  buildNumber: string | null;
  testflightUrl: string | null;
};

export function parseLocalBuildLog(text: string): LocalBuildLog {
  const steps: LocalBuildLog["steps"] = [];
  for (const raw of text.split("\n")) {
    if (raw.startsWith(LOCAL_STEP_HEADER)) {
      steps.push({ step: raw.slice(LOCAL_STEP_HEADER.length).trim(), lines: [] });
      continue;
    }
    const line = stripNoise(raw);
    if (line.trim() && steps.length) steps[steps.length - 1].lines.push(line);
  }
  const all = steps.flatMap((s) => s.lines);
  const buildNumber = all.map((l) => l.match(/Incremented buildNumber from \S+ to (\d+)/)?.[1]).find(Boolean) ?? null;
  const testflightUrl = all.map((l) => l.match(/https:\/\/appstoreconnect\.apple\.com\/apps\/\d+\/testflight\/ios/)?.[0]).find(Boolean) ?? null;
  return { steps, buildNumber, testflightUrl };
}

// An unindented line that names an error, like "Error: spawnSync eas ENOENT" (not "    throw error;").
const errorLine = /^\S.*(\berror\b|\bfailed\b|\bfatal\b|❌)/i;

// Up to `max` lines, starting at the first error line: tools often print the error, then pages of
// details or unrelated output (fastlane's changelog). Without an error line, the last lines.
export function excerpt(lines: string[], max: number): string[] {
  const first = lines.findIndex((l) => errorLine.test(l));
  if (first === -1) return lines.slice(-max);
  const start = Math.max(0, Math.min(first, lines.length - max));
  return lines.slice(start, start + max);
}
