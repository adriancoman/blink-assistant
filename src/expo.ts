import { eas, ensureRepo, syncRepo, withRepo } from "./repo.ts";
import type { ExpoProject } from "./settings.ts";

export type StartedRun = { id: string; url: string };

// Uploads the release branch from the bot's clone, like running `eas workflow:run` yourself.
// (Starting runs by git ref needs the Expo project linked to GitHub, which isn't possible for
// a personal Expo account with an organization's repo.)
export async function runWorkflow(p: ExpoProject, fileName: string, inputs: Record<string, string> = {}): Promise<StartedRun> {
  return withRepo(p, async () => {
    await syncRepo(p, p.github.releaseBranch);
    const inputFlags = Object.entries(inputs).flatMap(([key, value]) => ["-F", `${key}=${value}`]);
    const stdout = await eas(p, ["workflow:run", `.eas/workflows/${fileName}`, "--non-interactive", "--json", ...inputFlags]);
    const { id, url } = JSON.parse(stdout);
    if (!id || !url) throw new Error(`eas workflow:run did not return a run: ${stdout}`);
    return { id, url };
  });
}

export type LastRun = {
  workflow: string;
  status: string;
  startedAt: string | null;
  finishedAt: string | null;
  url: string;
  failedSteps: string[];
  version: string | null;
  buildNumber: string | null;
};

// `--json` implies non-interactive on most commands; workflow:runs rejects an explicit --non-interactive.
export async function easJson(p: ExpoProject, args: string[], { nonInteractiveFlag = true } = {}) {
  return withRepo(p, async () => {
    await ensureRepo(p);
    const stdout = await eas(p, [...args, "--json", ...(nonInteractiveFlag ? ["--non-interactive"] : [])]);
    return stdout.trim() ? JSON.parse(stdout) : null;
  });
}

export const FINISHED_STATUSES = new Set(["SUCCESS", "FAILURE", "CANCELED"]);

export async function runDetails(p: ExpoProject, id: string): Promise<LastRun> {
  const run = await easJson(p, ["workflow:view", id]);
  const jobs: { name: string; status: string; outputs?: Record<string, string> }[] = run.jobs ?? [];
  const build = jobs.find((j) => j.outputs?.app_version);
  return {
    workflow: run.workflow?.name ?? run.workflow?.fileName ?? "workflow",
    status: run.status,
    startedAt: run.createdAt ?? null,
    finishedAt: FINISHED_STATUSES.has(run.status) ? (run.updatedAt ?? null) : null,
    url: run.logURL,
    failedSteps: jobs.filter((j) => j.status === "FAILURE").map((j) => j.name),
    version: build?.outputs?.app_version ?? null,
    buildNumber: build?.outputs?.app_build_version ?? null,
  };
}

export async function lastWorkflowRun(p: ExpoProject): Promise<LastRun | null> {
  const [latest] = await easJson(p, ["workflow:runs", "--limit", "1"], { nonInteractiveFlag: false });
  if (!latest) return null;
  // workflow:runs has the precise start and finish times.
  return { ...(await runDetails(p, latest.id)), startedAt: latest.startedAt, finishedAt: latest.finishedAt };
}

// Versions of finished store builds, including ones made from the CLI that never went live.
export async function builtStoreVersions(p: ExpoProject): Promise<string[]> {
  const builds: { appVersion?: string; distribution?: string }[] = await easJson(p, [
    "build:list", "--platform", "ios", "--status", "finished", "--limit", "50",
  ]);
  return builds.filter((b) => b.distribution === "STORE" && b.appVersion).map((b) => b.appVersion!);
}
