import { isLocalJobId, localOutcome } from "./localbuild.ts";
import { failureInLogs, type JobLogs } from "./logs.ts";
import { eas, ensureRepo, syncRepo, withRepo } from "./repo.ts";
import type { ExpoProject } from "./project.ts";

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
  id: string;
  workflow: string;
  status: string;
  startedAt: string | null;
  finishedAt: string | null;
  url: string;
  // What the link is called in replies; "View run" when absent. A local build links to its log or
  // to TestFlight.
  urlLabel?: string;
  failedJobs: { id: string; name: string }[];
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
  const jobs: { id: string; name: string; status: string; outputs?: Record<string, string> }[] = run.jobs ?? [];
  const build = jobs.find((j) => j.outputs?.app_version);
  return {
    id,
    workflow: run.workflow?.name ?? run.workflow?.fileName ?? "workflow",
    status: run.status,
    startedAt: run.createdAt ?? null,
    finishedAt: FINISHED_STATUSES.has(run.status) ? (run.updatedAt ?? null) : null,
    url: run.logURL,
    failedJobs: jobs.filter((j) => j.status === "FAILURE").map((j) => ({ id: j.id, name: j.name })),
    version: build?.outputs?.app_version ?? null,
    buildNumber: build?.outputs?.app_build_version ?? null,
  };
}

// The latest run, or the latest one with this status (like "FAILURE").
export async function lastWorkflowRun(p: ExpoProject, status?: string): Promise<LastRun | null> {
  const filter = status ? ["--status", status] : [];
  const [latest] = await easJson(p, ["workflow:runs", "--limit", "1", ...filter], { nonInteractiveFlag: false });
  if (!latest) return null;
  // workflow:runs has the precise start and finish times.
  return { ...(await runDetails(p, latest.id)), startedAt: latest.startedAt, finishedAt: latest.finishedAt };
}

export async function jobLogs(p: ExpoProject, jobId: string): Promise<JobLogs> {
  const logs = await easJson(p, ["workflow:logs", jobId]);
  // eas exits 0 even when it can't find the job, with nothing on stdout.
  if (!logs || typeof logs !== "object") throw new Error(`eas returned no logs for job ${jobId}`);
  return logs;
}

// Where a failed run broke: the first failed job's failing step, with its log lines.
export type RunFailure = { job: string; step: string; lines: string[] };

// Null when the logs can't be read or don't show a failed step; the run's link still has them.
export async function runFailure(p: ExpoProject, run: LastRun): Promise<RunFailure | null> {
  const [job] = run.failedJobs;
  if (!job) return null;
  try {
    const found = failureInLogs(await jobLogs(p, job.id));
    return found && { job: job.name, ...found };
  } catch (err) {
    console.warn(`Couldn't read the logs of job ${job.id}:`, err instanceof Error ? err.message : err);
    return null;
  }
}

// For "why did it fail?": the latest run, and the latest failed one (the same run when it's the latest).
// With `threadRunId` (a run started from the thread), only that run, so a parallel run's failure
// isn't explained in the wrong thread.
export type LastFailure = { latest: LastRun | null; failed: LastRun | null; failure: RunFailure | null; fromThread: boolean };

export async function lastFailure(p: ExpoProject, threadRunId: string | null = null): Promise<LastFailure> {
  if (threadRunId && isLocalJobId(threadRunId)) {
    // A build on this machine: its result file, written when it finished (null while it's running).
    const outcome = localOutcome(p, threadRunId);
    const failed = outcome?.run.status === "FAILURE" ? outcome.run : null;
    return { latest: outcome?.run ?? null, failed, failure: failed ? outcome!.failure : null, fromThread: true };
  }
  if (threadRunId) {
    const run = await runDetails(p, threadRunId);
    const failed = run.status === "FAILURE" ? run : null;
    return { latest: run, failed, failure: failed && (await runFailure(p, failed)), fromThread: true };
  }
  const latest = await lastWorkflowRun(p);
  const failed = !latest || latest.status === "FAILURE" ? latest : await lastWorkflowRun(p, "FAILURE");
  return { latest, failed, failure: failed && (await runFailure(p, failed)), fromThread: false };
}

// Versions of finished store builds, including ones made from the CLI that never went live.
export async function builtStoreVersions(p: ExpoProject): Promise<string[]> {
  const builds: { appVersion?: string; distribution?: string }[] = await easJson(p, [
    "build:list", "--platform", "ios", "--status", "finished", "--limit", "50",
  ]);
  return builds.filter((b) => b.distribution === "STORE" && b.appVersion).map((b) => b.appVersion!);
}
