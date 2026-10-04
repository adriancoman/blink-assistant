import { config } from "./config.ts";
import { runWorkflow, type StartedRun } from "./expo.ts";
import { createBranch, deleteBranch, mergeBranches, readFile, writeFile } from "./github.ts";
import { cancelRuns, republish, rollBackToEmbedded, setChannelPaused, type UpdateGroup } from "./ota.ts";
import { compareVersions, readAppJsonVersion, setAppJsonVersion } from "./versioning.ts";

// Actions with side effects. The model can only propose these; they run when the user clicks Confirm.
export type Action =
  | { kind: "merge"; source: string; target: string }
  | { kind: "release_ota"; message: string }
  | { kind: "release_testflight"; version: string; bumpFrom: string | null }
  | {
      kind: "rollback_ota";
      from: UpdateGroup;
      to: { kind: "update"; update: UpdateGroup } | { kind: "embedded"; runtimeVersion: string };
      resume: boolean;
    }
  | { kind: "stop_rollout"; cancelRunIds: string[]; pause: boolean }
  | { kind: "resume_rollout" };

const shortGroup = (u: UpdateGroup) => `${u.message} \`${u.group.slice(0, 8)}\``;

export function describe(action: Action): string {
  switch (action.kind) {
    case "merge":
      return `Merge \`${action.source}\` into \`${action.target}\` (via PR, merged only if there are no conflicts)`;
    case "release_ota":
      return `Publish an iOS OTA update from \`${config.releaseBranch}\` to the *${config.otaChannel}* channel\n> ${action.message}`;
    case "release_testflight":
      return action.bumpFrom
        ? `Bump the version ${action.bumpFrom} → *${action.version}* on \`${config.releaseBranch}\` (and \`main\` via PR), then build iOS and upload it to TestFlight`
        : `Build iOS *${action.version}* from \`${config.releaseBranch}\` and upload it to TestFlight`;
    case "rollback_ota": {
      const to = action.to.kind === "update" ? `the previous update ${shortGroup(action.to.update)}` : "the code in the store build (no earlier update for this runtime)";
      return `Roll back *${config.otaChannel}* from ${shortGroup(action.from)} to ${to}${action.resume ? ", and resume the paused channel so phones receive it" : ""}`;
    }
    case "stop_rollout": {
      const steps = [
        action.cancelRunIds.length ? `cancel the running OTA workflow before it publishes` : null,
        action.pause ? `pause the *${config.otaChannel}* channel so phones that don't have the latest update yet won't get it` : null,
      ].filter(Boolean);
      return `Stop the OTA rollout: ${steps.join(", and ")}. Phones that already downloaded it keep it (use _roll back the OTA_ for those).`;
    }
    case "resume_rollout":
      return `Resume the *${config.otaChannel}* channel so phones start receiving OTA updates again`;
  }
}

async function commitVersion(branch: string, version: string): Promise<boolean> {
  const appJson = await readFile("app.json", branch);
  if (compareVersions(readAppJsonVersion(appJson.content), version) >= 0) return false;
  await writeFile("app.json", branch, setAppJsonVersion(appJson.content, version), appJson.sha, `Bump version to ${version}`);
  return true;
}

// Keeps main in step with release so the next merge doesn't bring the old version back into view.
async function bumpMain(version: string): Promise<string> {
  const branch = `release-bot/version-${version}`;
  await createBranch(branch, "main");
  if (!(await commitVersion(branch, version))) {
    await deleteBranch(branch);
    return `\`main\` is already on ${version} or later.`;
  }
  const result = await mergeBranches(branch, "main");
  if (result.outcome === "needs_attention") return `Couldn't bump \`main\` (${result.reason}). <${result.prUrl}|PR>`;
  await deleteBranch(branch);
  return `\`main\` bumped to ${version}.`;
}

// `watch` is a workflow run the caller should follow until it finishes.
export type ExecuteResult = { text: string; watch?: StartedRun };

export async function execute(action: Action): Promise<ExecuteResult> {
  const result = await run(action);
  return typeof result === "string" ? { text: result } : result;
}

async function run(action: Action): Promise<string | ExecuteResult> {
  switch (action.kind) {
    case "merge": {
      const result = await mergeBranches(action.source, action.target);
      if (result.outcome === "up_to_date") return `\`${action.target}\` already has everything from \`${action.source}\`. Nothing to merge.`;
      if (result.outcome === "merged") return `Merged \`${action.source}\` into \`${action.target}\` (${result.sha.slice(0, 7)}). <${result.prUrl}|PR>`;
      return `Couldn't merge: ${result.reason}. The PR is open for you: <${result.prUrl}|PR>`;
    }
    case "release_ota": {
      const started = await runWorkflow(config.workflows.ota, { message: action.message });
      return { text: `OTA workflow started from \`${config.releaseBranch}\`. <${started.url}|View run>`, watch: started };
    }
    case "release_testflight": {
      const lines: string[] = [];
      if (action.bumpFrom) {
        const current = readAppJsonVersion((await readFile("app.json", config.releaseBranch)).content);
        if (current !== action.bumpFrom && current !== action.version) {
          throw new Error(`app.json on \`${config.releaseBranch}\` changed to ${current} since you asked. Ask me again.`);
        }
        await commitVersion(config.releaseBranch, action.version);
        lines.push(`Bumped \`${config.releaseBranch}\` to ${action.version}.`);
      }
      const started = await runWorkflow(config.workflows.testflight);
      lines.push(`iOS ${action.version} build + TestFlight upload started. <${started.url}|View run>`);
      // Also when release was bumped by an earlier attempt whose build failed to start.
      lines.push(await bumpMain(action.version).catch((err) => `Couldn't bump \`main\`: ${String(err)}`));
      return { text: lines.join("\n"), watch: started };
    }
    case "rollback_ota": {
      const message = `Roll back from ${action.from.group.slice(0, 8)} (via Slack)`;
      if (action.to.kind === "update") await republish(action.to.update.group, message);
      else await rollBackToEmbedded(action.to.runtimeVersion, message);
      if (action.resume) await setChannelPaused(false);
      return `Rolled back *${config.otaChannel}*${action.to.kind === "update" ? ` to ${shortGroup(action.to.update)}` : " to the store build's code"}. Phones switch on their next app launch.${action.resume ? " Channel resumed." : ""}`;
    }
    case "stop_rollout": {
      if (action.cancelRunIds.length) await cancelRuns(action.cancelRunIds);
      if (action.pause) await setChannelPaused(true);
      return `Stopped.${action.cancelRunIds.length ? " Running OTA workflow canceled." : ""}${action.pause ? ` *${config.otaChannel}* is paused; say _resume rollout_ to start sending updates again.` : ""}`;
    }
    case "resume_rollout":
      await setChannelPaused(false);
      return `*${config.otaChannel}* resumed. Phones will receive OTA updates again.`;
  }
}
