import { existsSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.ts";
import { eas, syncRepo, withRepo } from "./repo.ts";

// OTA controls for the configured OTA channel (default "production"): pause/resume delivery, cancel a publish that hasn't
// happened yet, and roll back. None of these upload code, so the clone only needs to exist.

const CHANNEL = config.otaChannel;
const OTA_WORKFLOW = config.workflows.ota;
const ACTIVE_RUN_STATUSES = new Set(["NEW", "IN_PROGRESS", "WAITING", "ACTION_REQUIRED"]);

// `--json` implies non-interactive on most commands; workflow:runs rejects an explicit --non-interactive.
async function easJson(args: string[], { nonInteractiveFlag = true } = {}) {
  return withRepo(async () => {
    if (!existsSync(join(config.repoDir, "node_modules"))) await syncRepo(config.releaseBranch);
    const stdout = await eas([...args, "--json", ...(nonInteractiveFlag ? ["--non-interactive"] : [])]);
    return stdout.trim() ? JSON.parse(stdout) : null;
  });
}

export type UpdateGroup = {
  group: string;
  message: string; // eas formats this as `"<message>" (<time> ago by <actor>)`
  runtimeVersion: string;
  isRollBackToEmbedded: boolean;
  rolloutPercentage?: number;
};

export async function channelState(): Promise<{ paused: boolean; branch: string | null }> {
  const { currentPage: channel } = await easJson(["channel:view", CHANNEL]);
  const mapping: { data: { branchId: string }[] } = JSON.parse(channel.branchMapping ?? '{"data":[]}');
  const branchId = mapping.data[0]?.branchId;
  const branch = (channel.updateBranches as { id: string; name: string }[]).find((b) => b.id === branchId)?.name ?? null;
  return { paused: channel.isPaused, branch };
}

// Newest first.
export async function channelUpdates(branch: string): Promise<UpdateGroup[]> {
  const result = await easJson(["update:list", "--branch", branch, "--limit", "25"]);
  return result?.currentPage ?? [];
}

export async function activeOtaRuns(): Promise<{ id: string; status: string }[]> {
  const runs: { id: string; status: string; workflowFileName: string }[] = await easJson(["workflow:runs", "--limit", "10"], { nonInteractiveFlag: false });
  return runs.filter((r) => r.workflowFileName === OTA_WORKFLOW && ACTIVE_RUN_STATUSES.has(r.status));
}

export async function cancelRuns(ids: string[]) {
  await withRepo(() => eas(["workflow:cancel", ...ids, "--non-interactive"]));
}

export async function setChannelPaused(paused: boolean) {
  await easJson([paused ? "channel:pause" : "channel:resume", CHANNEL]);
}

export async function republish(group: string, message: string) {
  await easJson(["update:republish", "--group", group, "--message", message]);
}

export async function rollBackToEmbedded(runtimeVersion: string, message: string) {
  await easJson(["update:roll-back-to-embedded", "--channel", CHANNEL, "--runtime-version", runtimeVersion, "--message", message]);
}

// Plans. These only read, so the Confirm card can show exactly what will happen.

export type RollbackPlan =
  | { possible: false; reason: string }
  | {
      possible: true;
      from: UpdateGroup;
      to: { kind: "update"; update: UpdateGroup } | { kind: "embedded"; runtimeVersion: string };
      resume: boolean;
    };

export async function planRollback(): Promise<RollbackPlan> {
  const { paused, branch } = await channelState();
  if (!branch) return { possible: false, reason: `No OTA updates have been published to ${CHANNEL} yet.` };
  const [current, ...older] = await channelUpdates(branch);
  if (!current) return { possible: false, reason: `No OTA updates have been published to ${CHANNEL} yet.` };
  if (current.isRollBackToEmbedded) {
    return { possible: false, reason: "Production is already rolled back to the code in the store build." };
  }
  // An update only reaches builds with the same runtime, so roll back within the current one.
  const previous = older.find((u) => u.runtimeVersion === current.runtimeVersion && u.group !== current.group);
  return {
    possible: true,
    from: current,
    to: previous ? { kind: "update", update: previous } : { kind: "embedded", runtimeVersion: current.runtimeVersion },
    resume: paused,
  };
}

export type StopPlan = { cancelRunIds: string[]; pause: boolean } | { nothingToStop: string };

export async function planStop(): Promise<StopPlan> {
  const [runs, { paused, branch }] = await Promise.all([activeOtaRuns(), channelState()]);
  const hasUpdates = branch ? (await channelUpdates(branch)).length > 0 : false;
  const pause = hasUpdates && !paused;
  if (runs.length === 0 && !pause) {
    return { nothingToStop: paused ? "Production is already paused. Say _resume rollout_ to start sending updates again." : "No OTA is running or rolling out right now." };
  }
  return { cancelRunIds: runs.map((r) => r.id), pause };
}
