import { easJson } from "./expo.ts";
import { eas, withRepo } from "./repo.ts";
import type { ExpoProject } from "./settings.ts";

// OTA controls for a project's OTA channel: pause/resume delivery, cancel a publish that hasn't
// happened yet, and roll back. None of these upload code, so the clone only needs to exist.

const ACTIVE_RUN_STATUSES = new Set(["NEW", "IN_PROGRESS", "WAITING", "ACTION_REQUIRED"]);

export type UpdateGroup = {
  group: string;
  message: string; // eas formats this as `"<message>" (<time> ago by <actor>)`
  runtimeVersion: string;
  isRollBackToEmbedded: boolean;
  rolloutPercentage?: number;
};

export async function channelState(p: ExpoProject): Promise<{ paused: boolean; branch: string | null }> {
  const { currentPage: channel } = await easJson(p, ["channel:view", p.expo.otaChannel]);
  const mapping: { data: { branchId: string }[] } = JSON.parse(channel.branchMapping ?? '{"data":[]}');
  const branchId = mapping.data[0]?.branchId;
  const branch = (channel.updateBranches as { id: string; name: string }[]).find((b) => b.id === branchId)?.name ?? null;
  return { paused: channel.isPaused, branch };
}

// Newest first.
export async function channelUpdates(p: ExpoProject, branch: string): Promise<UpdateGroup[]> {
  const result = await easJson(p, ["update:list", "--branch", branch, "--limit", "25"]);
  return result?.currentPage ?? [];
}

export async function activeOtaRuns(p: ExpoProject): Promise<{ id: string; status: string }[]> {
  if (!p.expo.workflows.ota) return [];
  const runs: { id: string; status: string; workflowFileName: string }[] = await easJson(p, ["workflow:runs", "--limit", "10"], { nonInteractiveFlag: false });
  return runs.filter((r) => r.workflowFileName === p.expo.workflows.ota && ACTIVE_RUN_STATUSES.has(r.status));
}

export async function cancelRuns(p: ExpoProject, ids: string[]) {
  await withRepo(p, () => eas(p, ["workflow:cancel", ...ids, "--non-interactive"]));
}

export async function setChannelPaused(p: ExpoProject, paused: boolean) {
  await easJson(p, [paused ? "channel:pause" : "channel:resume", p.expo.otaChannel]);
}

export async function republish(p: ExpoProject, group: string, message: string) {
  await easJson(p, ["update:republish", "--group", group, "--message", message]);
}

export async function rollBackToEmbedded(p: ExpoProject, runtimeVersion: string, message: string) {
  await easJson(p, ["update:roll-back-to-embedded", "--channel", p.expo.otaChannel, "--runtime-version", runtimeVersion, "--message", message]);
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

export async function planRollback(p: ExpoProject): Promise<RollbackPlan> {
  const channel = p.expo.otaChannel;
  const { paused, branch } = await channelState(p);
  if (!branch) return { possible: false, reason: `No OTA updates have been published to ${channel} yet.` };
  const [current, ...older] = await channelUpdates(p, branch);
  if (!current) return { possible: false, reason: `No OTA updates have been published to ${channel} yet.` };
  if (current.isRollBackToEmbedded) {
    return { possible: false, reason: `${channel} is already rolled back to the code in the store build.` };
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

export async function planStop(p: ExpoProject): Promise<StopPlan> {
  const [runs, { paused, branch }] = await Promise.all([activeOtaRuns(p), channelState(p)]);
  const hasUpdates = branch ? (await channelUpdates(p, branch)).length > 0 : false;
  const pause = hasUpdates && !paused;
  if (runs.length === 0 && !pause) {
    return {
      nothingToStop: paused
        ? `${p.expo.otaChannel} is already paused. Say _resume rollout_ to start sending updates again.`
        : "No OTA is running or rolling out right now.",
    };
  }
  return { cancelRunIds: runs.map((r) => r.id), pause };
}
