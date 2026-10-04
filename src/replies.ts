import { config } from "./config.ts";
import type { LastRun } from "./expo.ts";

// Jev only makes decisions, so every reply is a template.

export const help = (prefix = "") =>
  `${prefix}I can:\n` +
  `• *merge* one branch into another (e.g. _merge main into ${config.releaseBranch}_)\n` +
  `• *release an OTA* update to ${config.otaChannel}\n` +
  `• *roll back the OTA*, *stop rollout* (pause OTA delivery), *resume rollout*\n` +
  `• *release to TestFlight* (optionally with a version, e.g. _ship 1.1.0 to TestFlight_)\n` +
  `• show *status*`;

export const notUnderstood = () => help("Sorry, I'm not sure what you mean. ");

export const appStoreNotSupported = () =>
  "Releasing to the App Store (submitting for review or releasing to users) isn't supported yet. " +
  "I can upload a build to *TestFlight* instead: just say _release to TestFlight_.";

export const askBranch = (role: "source" | "target", branches: string[]) =>
  `Which branch should I merge ${role === "source" ? "*from*" : "*into*"}? ` +
  `Branches: ${branches.map((b) => `\`${b}\``).join(", ")}`;

export const releaseFromOtherBranch = (branch: string | null) =>
  `Releases always run from \`${config.releaseBranch}\`. ` +
  (branch
    ? `Want me to merge \`${branch}\` into \`${config.releaseBranch}\` first? Say _merge ${branch} into ${config.releaseBranch}_.`
    : `Merge your branch into \`${config.releaseBranch}\` first, e.g. _merge main into ${config.releaseBranch}_.`);

const runEmoji: Record<string, string> = { SUCCESS: "✅", FAILURE: "❌", IN_PROGRESS: "⏳", NEW: "⏳", WAITING: "⏳", CANCELED: "⚪", ACTION_REQUIRED: "✋" };
const runVerb: Record<string, string> = { SUCCESS: "succeeded", FAILURE: "failed", IN_PROGRESS: "in progress", NEW: "queued", WAITING: "waiting", CANCELED: "canceled", ACTION_REQUIRED: "needs approval" };

const minutesBetween = (from: string, to: string) => Math.max(1, Math.round((Date.parse(to) - Date.parse(from)) / 60000));

const pausedNote = `\n⏸️ *${config.otaChannel}* OTA channel is paused. Say _resume rollout_ to start sending updates again.`;

export const otaWhilePaused = () =>
  `The *${config.otaChannel}* channel is paused, so a new OTA wouldn't reach anyone. Say _resume rollout_ first.`;

export function status(run: LastRun | null, paused = false) {
  if (!run) return `No builds yet.${paused ? pausedNote : ""}`;
  const version = run.version ? ` · iOS ${run.version}${run.buildNumber ? ` (build ${run.buildNumber})` : ""}` : "";
  const failedAt = run.failedSteps.length ? ` at *${run.failedSteps.join(", ")}*` : "";
  const timing = !run.startedAt
    ? ""
    : run.finishedAt
      ? `\nStarted ${run.startedAt.slice(0, 16).replace("T", " ")} UTC · took ${minutesBetween(run.startedAt, run.finishedAt)} min`
      : `\nStarted ${minutesBetween(run.startedAt, new Date().toISOString())} min ago`;
  return `${runEmoji[run.status] ?? "•"} *${run.workflow}* ${runVerb[run.status] ?? run.status.toLowerCase()}${failedAt}${version}${timing}\n<${run.url}|View run>${paused ? pausedNote : ""}`;
}
