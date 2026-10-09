import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import type { Action } from "./capability.ts";
import type { LastRun, RunFailure, StartedRun } from "./expo.ts";
import { LOCAL_STEP_HEADER, parseLocalBuildLog } from "./logs.ts";
import type { ExpoProject } from "./project.ts";
import { easToFile, syncRepo, withRepo } from "./repo.ts";
import { readAppJsonVersion } from "./versioning.ts";

// Building iOS on the machine Blink runs on, for when EAS's free-plan cloud builds are spent.
// `eas build --local` drives Xcode through fastlane (no Fastfile needed) and still takes its
// credentials, environment and the next build number from EAS; `eas submit --path` then uploads the
// .ipa, which the quota doesn't limit. Everything is written under .builds/<project>/<job>/: the
// .ipa, one log for both commands, and a result file so "why did it fail?" works after a restart.

export type LocalJob = { kind: "local"; id: string; logPath: string };
export const isLocalJob = (run: StartedRun | LocalJob): run is LocalJob => "kind" in run && run.kind === "local";
// Job IDs share the thread's `run` slot with EAS run IDs (UUIDs), so they're marked.
const ID_PREFIX = "local-";
export const isLocalJobId = (id: string) => id.startsWith(ID_PREFIX);

// Reported like a workflow run, so the same replies serve both.
export type LocalOutcome = { run: LastRun; failure: RunFailure | null };

export const WORKFLOW_NAME = "Local iOS build";
const BUILDS_DIR = resolve(".builds");
// Xcode can take a while on a cold cache; a build that long has hung.
const TIMEOUT_MS = 90 * 60 * 1000;
// Everything that builds and uploads an iOS app on this machine; eas calls these itself.
const TOOLS = ["xcodebuild", "fastlane", "pod"];

// Jobs started in this process, by ID. Gone after a restart: there's no way to pick a build up again.
const jobs = new Map<string, Promise<LocalOutcome>>();

const resultPath = (p: ExpoProject, id: string) => join(BUILDS_DIR, p.id, id, "result.json");

// Tools missing from PATH, checked before starting so the failure is a clear sentence, not a log.
export function missingTools(env: NodeJS.ProcessEnv = process.env): string[] {
  const dirs = (env.PATH ?? "").split(delimiter).filter(Boolean);
  return TOOLS.filter((tool) => !dirs.some((dir) => existsSync(join(dir, tool))));
}

// Syncs the clone to the release branch (awaited, so a bad branch fails right away), then builds and
// submits in the background, holding the project's queue so nothing checks out over the build.
// Follow it with `followLocalBuild`.
export async function startLocalBuild(p: ExpoProject, version: string | null): Promise<LocalJob> {
  const settings = p.expo.localBuild;
  if (!settings) throw new Error(`Local builds aren't set up for ${p.name}`);
  if (process.platform !== "darwin") throw new Error("iOS builds need a Mac; Blink isn't running on one");
  const missing = missingTools();
  if (missing.length) throw new Error(`Can't build on this machine: ${missing.join(", ")} not found in PATH`);

  const id = `${ID_PREFIX}${new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "")}`;
  const dir = join(BUILDS_DIR, p.id, id);
  mkdirSync(dir, { recursive: true });
  const job: LocalJob = { kind: "local", id, logPath: join(dir, "build.log") };
  const ipaPath = join(dir, "app.ipa");

  await withRepo(p, () => syncRepo(p, p.github.releaseBranch));
  const startedAt = new Date().toISOString();
  // Queued right after the sync, and queue tasks run in order, so the clone is still the release
  // branch when the build starts.
  const outcome = withRepo(p, async () => {
    const steps: [string, string[]][] = [
      ["eas build (local)", ["build", "-p", "ios", "--profile", settings.profile, "--local", "--non-interactive", "--output", ipaPath]],
      ["eas submit", ["submit", "-p", "ios", "--profile", settings.profile, "--path", ipaPath, "--non-interactive"]],
    ];
    let failedStep: string | null = null;
    let error: string | null = null;
    for (const [step, args] of steps) {
      writeFileSync(job.logPath, `${LOCAL_STEP_HEADER}${step}\n`, { flag: "a" });
      try {
        await easToFile(p, args, job.logPath, settings.env, TIMEOUT_MS);
      } catch (err) {
        failedStep = step;
        error = err instanceof Error ? err.message : String(err);
        break;
      }
    }
    const result = outcomeOf(p, job, { version, startedAt, failedStep, error });
    writeFileSync(resultPath(p, id), JSON.stringify(result, null, 2));
    return result;
  });
  jobs.set(id, outcome);
  outcome.finally(() => jobs.delete(id)).catch(() => {});
  return job;
}

// The job's result once it finishes, or null if this process didn't start it (Blink restarted).
export const followLocalBuild = (job: LocalJob): Promise<LocalOutcome | null> => jobs.get(job.id) ?? Promise.resolve(null);

// A finished job's result from its file, for "why did it fail?" later or after a restart.
export function localOutcome(p: ExpoProject, id: string): LocalOutcome | null {
  const path = resultPath(p, id);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

// What to propose when a cloud build fails because the month's free builds are spent: the same
// release, on this machine. The version was already bumped on the release branch, if it was going to be.
export const retryLocally = (run: LastRun): Action => ({ kind: "release_testflight", version: run.version, bumpFrom: null, where: "local" });

type Ended = { version: string | null; startedAt: string; failedStep: string | null; error: string | null };

function outcomeOf(p: ExpoProject, job: LocalJob, { version, startedAt, failedStep, error }: Ended): LocalOutcome {
  const log = parseLocalBuildLog(existsSync(job.logPath) ? readFileSync(job.logPath, "utf8") : "");
  const failed = failedStep !== null;
  const run: LastRun = {
    id: job.id,
    workflow: WORKFLOW_NAME,
    status: failed ? "FAILURE" : "SUCCESS",
    startedAt,
    finishedAt: new Date().toISOString(),
    url: !failed && log.testflightUrl ? log.testflightUrl : `file://${job.logPath}`,
    urlLabel: !failed && log.testflightUrl ? "Open TestFlight" : "Open log",
    failedJobs: failed ? [{ id: job.id, name: failedStep }] : [],
    version: version ?? appJsonVersion(p),
    buildNumber: log.buildNumber,
  };
  if (!failed) return { run, failure: null };
  // The failing command's output, with eas's own exit message last so an empty log still says something.
  const lines = log.steps.find((s) => s.step === failedStep)?.lines ?? [];
  return { run, failure: { job: failedStep, step: failedStep, lines: error ? [...lines, error] : lines } };
}

function appJsonVersion(p: ExpoProject): string | null {
  try {
    return readAppJsonVersion(readFileSync(join(p.expo.repoDir, "app.json"), "utf8"));
  } catch {
    return null;
  }
}
