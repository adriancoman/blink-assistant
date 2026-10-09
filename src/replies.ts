import type { LastFailure, LastRun, RunFailure } from "./expo.ts";
import type { LocalJob } from "./localbuild.ts";
import { excerpt } from "./logs.ts";
import type { Project } from "./project.ts";

// Jev only makes decisions, so every reply is a template. Help replies are in help.ts.

export const posthogFailed = (err: unknown) => `:warning: ${err instanceof Error ? err.message : String(err)}`;

export const askingPosthog = (p: Project) => `🔍 Asking PostHog AI about *${p.name}*… this usually takes 20–60 seconds.`;

export const askProject = (prefix = "") => `${prefix}Which project is this for?`;

export const appStoreNotSupported = () =>
  "Releasing to the App Store (submitting for review or releasing to users) isn't supported yet. " +
  "I can upload a build to *TestFlight* instead: just say _release to TestFlight_.";

export const askBranch = (role: "source" | "target", branches: string[]) =>
  `Which branch should I merge ${role === "source" ? "*from*" : "*into*"}? ` +
  `Branches: ${branches.map((b) => `\`${b}\``).join(", ")}`;

export const releaseFromOtherBranch = (p: Project, branch: string | null) => {
  const release = p.github?.releaseBranch ?? "release";
  return (
    `Releases always run from \`${release}\`. ` +
    (branch
      ? `Want me to merge \`${branch}\` into \`${release}\` first? Say _merge ${branch} into ${release}_.`
      : `Merge your branch into \`${release}\` first, e.g. _merge main into ${release}_.`)
  );
};

const runEmoji: Record<string, string> = { SUCCESS: "✅", FAILURE: "❌", IN_PROGRESS: "⏳", NEW: "⏳", WAITING: "⏳", CANCELED: "⚪", ACTION_REQUIRED: "✋" };
const runVerb: Record<string, string> = { SUCCESS: "succeeded", FAILURE: "failed", IN_PROGRESS: "in progress", NEW: "queued", WAITING: "waiting", CANCELED: "canceled", ACTION_REQUIRED: "needs approval" };

const minutesBetween = (from: string, to: string) => Math.max(1, Math.round((Date.parse(to) - Date.parse(from)) / 60000));

const pausedNote = (p: Project) =>
  `\n⏸️ *${p.expo?.otaChannel}* OTA channel is paused. Say _resume rollout_ to start sending updates again.`;

export const otaWhilePaused = (p: Project) =>
  `The *${p.expo?.otaChannel}* channel is paused, so a new OTA wouldn't reach anyone. Say _resume rollout_ first.`;

// The run's result, version and timing, without the link.
function runSummary(run: LastRun) {
  const version = run.version ? ` · ${run.version}${run.buildNumber ? ` (build ${run.buildNumber})` : ""}` : "";
  const failedAt = run.failedJobs.length ? ` at *${run.failedJobs.map((j) => j.name).join(", ")}*` : "";
  const timing = !run.startedAt
    ? ""
    : run.finishedAt
      ? `\nStarted ${run.startedAt.slice(0, 16).replace("T", " ")} UTC · took ${minutesBetween(run.startedAt, run.finishedAt)} min`
      : `\nStarted ${minutesBetween(run.startedAt, new Date().toISOString())} min ago`;
  return `${runEmoji[run.status] ?? "•"} *${run.workflow}* ${runVerb[run.status] ?? run.status.toLowerCase()}${failedAt}${version}${timing}`;
}

const runLink = (run: LastRun) => `<${run.url}|${run.urlLabel ?? "View run"}>`;

export function status(p: Project, run: LastRun | null, paused = false) {
  if (!run) return `No builds yet.${paused ? pausedNote(p) : ""}`;
  return `${runSummary(run)}\n${runLink(run)}${paused ? pausedNote(p) : ""}`;
}

// After a cloud build was refused for the month's quota, with a Confirm card for building here.
export const quotaSpent = () => "\n\nEAS has used up this month's free iOS builds. I can build on this Mac instead:";

// A build on this machine that Blink lost track of, because it restarted while the build was running.
export const localBuildLost = (job: LocalJob) =>
  `⚠️ Blink restarted while the local iOS build was running, so the build didn't finish. Ask for it again. Log: \`${job.logPath}\``;

// Small enough that a reply with an OpenAI button stays under Slack's 3000-character section limit.
export const SLACK_LOG_LINES = 15;
const MAX_LOG_LINE = 150;

// Log text inside a code block: Slack still reads &, < and > as markup there.
const escapeLog = (line: string) =>
  (line.length > MAX_LOG_LINE ? `${line.slice(0, MAX_LOG_LINE - 1)}…` : line)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/```/g, "'''");

// A failed run with its failing step and the end of that step's log.
export function failedRun(run: LastRun, failure: RunFailure | null) {
  const log = failure?.lines.length ? `\n\`\`\`\n${excerpt(failure.lines, SLACK_LOG_LINES).map(escapeLog).join("\n")}\n\`\`\`` : "";
  const detail = failure
    ? `\nFailed step: *${failure.step}*${run.failedJobs.length > 1 ? ` (in ${failure.job})` : ""}${log}`
    : "\nI couldn't find the error in the logs.";
  return `${runSummary(run)}${detail}\n${runLink(run)}`;
}

// For "why did it fail?". When the latest run didn't fail, it says so and shows the last one that did.
export function lastFailure({ latest, failed, failure, fromThread }: LastFailure) {
  if (!failed) {
    if (!latest) return "No builds yet.";
    return `${fromThread ? "This thread's run hasn't failed:" : "No workflow run has failed. The latest:"}\n${runSummary(latest)}\n${runLink(latest)}`;
  }
  const note = latest && latest.id !== failed.id ? `The latest run, *${latest.workflow}*, ${runVerb[latest.status] ?? latest.status.toLowerCase()}. The last one that failed:\n` : "";
  return `${note}${failedRun(failed, failure)}`;
}
