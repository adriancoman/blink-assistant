import { runWorkflow, type StartedRun } from "./expo.ts";
import { createBranch, deleteBranch, mergeBranches, readFile, writeFile } from "./github.ts";
import { cancelRuns, republish, rollBackToEmbedded, setChannelPaused, type UpdateGroup } from "./ota.ts";
import { type ExpoProject, type GithubProject, hasExpo, hasGithub, type Project } from "./settings.ts";
import { compareVersions, readAppJsonVersion, setAppJsonVersion } from "./versioning.ts";

// Actions with side effects. The models can only propose these; they run when the user clicks
// Confirm, against the project the request was resolved to.
export type Action =
  | { kind: "merge"; source: string; target: string }
  | { kind: "release_ota"; message: string }
  // version and bumpFrom are null for projects whose workflow handles versions itself.
  | { kind: "release_testflight"; version: string | null; bumpFrom: string | null }
  | {
      kind: "rollback_ota";
      from: UpdateGroup;
      to: { kind: "update"; update: UpdateGroup } | { kind: "embedded"; runtimeVersion: string };
      resume: boolean;
    }
  | { kind: "stop_rollout"; cancelRunIds: string[]; pause: boolean }
  | { kind: "resume_rollout" };

const shortGroup = (u: UpdateGroup) => `${u.message} \`${u.group.slice(0, 8)}\``;

function expoOf(p: Project): ExpoProject {
  if (!hasExpo(p)) throw new Error(`Expo isn't set up for ${p.name}`);
  return p;
}

function githubOf(p: Project): GithubProject {
  if (!hasGithub(p)) throw new Error(`GitHub isn't set up for ${p.name}`);
  return p;
}

export function describe(p: Project, action: Action): string {
  const branch = p.github?.releaseBranch ?? "release";
  const channel = p.expo?.otaChannel ?? "production";
  switch (action.kind) {
    case "merge":
      return `Merge \`${action.source}\` into \`${action.target}\` (via PR, merged only if there are no conflicts)`;
    case "release_ota":
      return `Publish an iOS OTA update from \`${branch}\` to the *${channel}* channel\n> ${action.message}`;
    case "release_testflight":
      if (!action.version) return `Build iOS from \`${branch}\` and upload it to TestFlight`;
      return action.bumpFrom
        ? `Bump the version ${action.bumpFrom} → *${action.version}* on \`${branch}\` (and \`main\` via PR), then build iOS and upload it to TestFlight`
        : `Build iOS *${action.version}* from \`${branch}\` and upload it to TestFlight`;
    case "rollback_ota": {
      const to = action.to.kind === "update" ? `the previous update ${shortGroup(action.to.update)}` : "the code in the store build (no earlier update for this runtime)";
      return `Roll back *${channel}* from ${shortGroup(action.from)} to ${to}${action.resume ? ", and resume the paused channel so phones receive it" : ""}`;
    }
    case "stop_rollout": {
      const steps = [
        action.cancelRunIds.length ? `cancel the running OTA workflow before it publishes` : null,
        action.pause ? `pause the *${channel}* channel so phones that don't have the latest update yet won't get it` : null,
      ].filter(Boolean);
      return `Stop the OTA rollout: ${steps.join(", and ")}. Phones that already downloaded it keep it (use _roll back the OTA_ for those).`;
    }
    case "resume_rollout":
      return `Resume the *${channel}* channel so phones start receiving OTA updates again`;
  }
}

async function commitVersion(p: GithubProject, branch: string, version: string): Promise<boolean> {
  const appJson = await readFile(p, "app.json", branch);
  if (compareVersions(readAppJsonVersion(appJson.content), version) >= 0) return false;
  await writeFile(p, "app.json", branch, setAppJsonVersion(appJson.content, version), appJson.sha, `Bump version to ${version}`);
  return true;
}

// Keeps main in step with release so the next merge doesn't bring the old version back into view.
async function bumpMain(p: GithubProject, version: string): Promise<string> {
  const branch = `release-bot/version-${version}`;
  await createBranch(p, branch, "main");
  if (!(await commitVersion(p, branch, version))) {
    await deleteBranch(p, branch);
    return `\`main\` is already on ${version} or later.`;
  }
  const result = await mergeBranches(p, branch, "main");
  if (result.outcome === "needs_attention") return `Couldn't bump \`main\` (${result.reason}). <${result.prUrl}|PR>`;
  await deleteBranch(p, branch);
  return `\`main\` bumped to ${version}.`;
}

// `watch` is a workflow run the caller should follow until it finishes.
export type ExecuteResult = { text: string; watch?: StartedRun };

export async function execute(p: Project, action: Action): Promise<ExecuteResult> {
  const result = await run(p, action);
  return typeof result === "string" ? { text: result } : result;
}

async function run(p: Project, action: Action): Promise<string | ExecuteResult> {
  switch (action.kind) {
    case "merge": {
      const gh = githubOf(p);
      const result = await mergeBranches(gh, action.source, action.target);
      if (result.outcome === "up_to_date") return `\`${action.target}\` already has everything from \`${action.source}\`. Nothing to merge.`;
      if (result.outcome === "merged") return `Merged \`${action.source}\` into \`${action.target}\` (${result.sha.slice(0, 7)}). <${result.prUrl}|PR>`;
      return `Couldn't merge: ${result.reason}. The PR is open for you: <${result.prUrl}|PR>`;
    }
    case "release_ota": {
      const ex = expoOf(p);
      if (!ex.expo.workflows.ota) throw new Error(`OTA isn't set up for ${p.name}`);
      const started = await runWorkflow(ex, ex.expo.workflows.ota, { message: action.message });
      return { text: `OTA workflow started from \`${ex.github.releaseBranch}\`. <${started.url}|View run>`, watch: started };
    }
    case "release_testflight": {
      const ex = expoOf(p);
      if (!ex.expo.workflows.testflight) throw new Error(`TestFlight isn't set up for ${p.name}`);
      const branch = ex.github.releaseBranch;
      const lines: string[] = [];
      if (action.version && action.bumpFrom) {
        const current = readAppJsonVersion((await readFile(ex, "app.json", branch)).content);
        if (current !== action.bumpFrom && current !== action.version) {
          throw new Error(`app.json on \`${branch}\` changed to ${current} since you asked. Ask me again.`);
        }
        await commitVersion(ex, branch, action.version);
        lines.push(`Bumped \`${branch}\` to ${action.version}.`);
      }
      const started = await runWorkflow(ex, ex.expo.workflows.testflight);
      lines.push(`iOS${action.version ? ` ${action.version}` : ""} build + TestFlight upload started. <${started.url}|View run>`);
      // Also when release was bumped by an earlier attempt whose build failed to start.
      if (action.version) lines.push(await bumpMain(ex, action.version).catch((err) => `Couldn't bump \`main\`: ${String(err)}`));
      return { text: lines.join("\n"), watch: started };
    }
    case "rollback_ota": {
      const ex = expoOf(p);
      const message = `Roll back from ${action.from.group.slice(0, 8)} (via Slack)`;
      if (action.to.kind === "update") await republish(ex, action.to.update.group, message);
      else await rollBackToEmbedded(ex, action.to.runtimeVersion, message);
      if (action.resume) await setChannelPaused(ex, false);
      return `Rolled back *${ex.expo.otaChannel}*${action.to.kind === "update" ? ` to ${shortGroup(action.to.update)}` : " to the store build's code"}. Phones switch on their next app launch.${action.resume ? " Channel resumed." : ""}`;
    }
    case "stop_rollout": {
      const ex = expoOf(p);
      if (action.cancelRunIds.length) await cancelRuns(ex, action.cancelRunIds);
      if (action.pause) await setChannelPaused(ex, true);
      return `Stopped.${action.cancelRunIds.length ? " Running OTA workflow canceled." : ""}${action.pause ? ` *${ex.expo.otaChannel}* is paused; say _resume rollout_ to start sending updates again.` : ""}`;
    }
    case "resume_rollout": {
      const ex = expoOf(p);
      await setChannelPaused(ex, false);
      return `*${ex.expo.otaChannel}* resumed. Phones will receive OTA updates again.`;
    }
  }
}
