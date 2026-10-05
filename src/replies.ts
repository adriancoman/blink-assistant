import type { LastRun } from "./expo.ts";
import type { Project } from "./settings.ts";

// Jev only makes decisions, so every reply is a template.

// What a project supports, as lines for the help reply. Only configured capabilities show up.
function capabilities(p: Project): string[] {
  const lines: string[] = [];
  const branch = p.github?.releaseBranch ?? "release";
  const example = branch === "main" ? `merge my-feature into main` : `merge main into ${branch}`;
  if (p.github) lines.push(`• *merge* one branch into another (e.g. _${example}_)`);
  if (p.github && p.expo) {
    if (p.expo.workflows.ota) lines.push(`• *release an OTA* update to ${p.expo.otaChannel}`);
    lines.push(`• *roll back the OTA*, *stop rollout* (pause OTA delivery), *resume rollout*`);
    if (p.expo.workflows.testflight) {
      lines.push(`• *release to TestFlight*${p.expo.versioning === "app-json" ? " (optionally with a version, e.g. _ship 1.1.0 to TestFlight_)" : ""}`);
    }
    if (p.expo.workflows.android) lines.push(`• *build Android* (a store build to upload to Google Play)`);
    lines.push(`• show *status*`);
  }
  if (p.posthog) lines.push(`• answer *analytics questions* with PostHog AI (e.g. _how many signups this week?_)`);
  return lines;
}

export const help = (p: Project, prefix = "") => {
  const lines = capabilities(p);
  if (!lines.length) return `${prefix}Nothing I can do for *${p.name}* is set up yet.`;
  return `${prefix}For *${p.name}* I can:\n${lines.join("\n")}`;
};

// For "what can you do?" when no project is in play: one section per project.
export const helpAll = (projects: Project[]) =>
  projects.map((p) => help(p)).join("\n\n") +
  (projects.length > 1 ? "\n\nName the project in your message (or use its channel) if it isn't obvious from the request." : "");

export const notUnderstood = (p: Project) => help(p, "Sorry, I'm not sure what you mean. ");

export const notConfigured = (p: Project, what: string) => `${what} isn't set up for *${p.name}*. ${help(p)}`;

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

export function status(p: Project, run: LastRun | null, paused = false) {
  if (!run) return `No builds yet.${paused ? pausedNote(p) : ""}`;
  const version = run.version ? ` · ${run.version}${run.buildNumber ? ` (build ${run.buildNumber})` : ""}` : "";
  const failedAt = run.failedSteps.length ? ` at *${run.failedSteps.join(", ")}*` : "";
  const timing = !run.startedAt
    ? ""
    : run.finishedAt
      ? `\nStarted ${run.startedAt.slice(0, 16).replace("T", " ")} UTC · took ${minutesBetween(run.startedAt, run.finishedAt)} min`
      : `\nStarted ${minutesBetween(run.startedAt, new Date().toISOString())} min ago`;
  return `${runEmoji[run.status] ?? "•"} *${run.workflow}* ${runVerb[run.status] ?? run.status.toLowerCase()}${failedAt}${version}${timing}\n<${run.url}|View run>${paused ? pausedNote(p) : ""}`;
}
