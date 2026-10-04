import { existsSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.ts";
import { eas, syncRepo, withRepo } from "./repo.ts";

// Uploads the release branch from the bot's clone, like running `eas workflow:run` yourself.
// (Starting runs by git ref needs the Expo project linked to GitHub, which isn't possible for
// a personal Expo account with an organization's repo.)
export type StartedRun = { id: string; url: string };

export async function runWorkflow(fileName: string, inputs: Record<string, string> = {}): Promise<StartedRun> {
  return withRepo(async () => {
    await syncRepo(config.releaseBranch);
    const inputFlags = Object.entries(inputs).flatMap(([key, value]) => ["-F", `${key}=${value}`]);
    const stdout = await eas(["workflow:run", `.eas/workflows/${fileName}`, "--non-interactive", "--json", ...inputFlags]);
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

// Read-only eas commands only need the clone to exist, not to be freshly synced.
async function easReadOnly(args: string[]) {
  return withRepo(async () => {
    if (!existsSync(join(config.repoDir, "node_modules"))) await syncRepo(config.releaseBranch);
    return JSON.parse(await eas(args));
  });
}

export const FINISHED_STATUSES = new Set(["SUCCESS", "FAILURE", "CANCELED"]);

export async function runDetails(id: string): Promise<LastRun> {
  const run = await easReadOnly(["workflow:view", id, "--json", "--non-interactive"]);
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

export async function lastWorkflowRun(): Promise<LastRun | null> {
  const [latest] = await easReadOnly(["workflow:runs", "--json", "--limit", "1"]);
  if (!latest) return null;
  // workflow:runs has the precise start and finish times.
  return { ...(await runDetails(latest.id)), startedAt: latest.startedAt, finishedAt: latest.finishedAt };
}

// Versions of finished store builds, including ones made from the CLI that never went live.
export async function builtStoreVersions(): Promise<string[]> {
  const builds: { appVersion?: string; distribution?: string }[] = await easReadOnly([
    "build:list", "--platform", "ios", "--status", "finished", "--limit", "50", "--json", "--non-interactive",
  ]);
  return builds.filter((b) => b.distribution === "STORE" && b.appVersion).map((b) => b.appVersion!);
}
