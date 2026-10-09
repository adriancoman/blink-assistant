import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { config } from "./config.ts";
import type { ExpoProject } from "./project.ts";

const execFileAsync = promisify(execFile);
// The bot's pinned eas-cli, so a global upgrade or downgrade can't change its behavior.
const EAS_BIN = resolve("node_modules/.bin/eas");

// HTTPS auth for git via env-only config, so the token isn't stored in .git/config or visible in `ps`.
function gitAuthEnv() {
  const githubAuth = Buffer.from(`x-access-token:${config.githubToken}`).toString("base64");
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${githubAuth}`,
  };
}

// The app repo's code runs in these processes: `npm ci` runs its dependencies' install scripts, and
// eas evaluates its app config. So they only get what they need, never the bot's own secrets
// (Slack, Jev, OpenAI, PostHog, and the Expo tokens of other projects).
const PASSED_THROUGH = ["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "USER", "SHELL", "SYSTEMROOT", "APPDATA", "LOCALAPPDATA"];

function childEnv(p: ExpoProject): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { CI: "1" };
  for (const name of PASSED_THROUGH) if (process.env[name] !== undefined) env[name] = process.env[name];
  return { ...env, ...gitAuthEnv(), EXPO_TOKEN: p.expo.token };
}

async function run(p: ExpoProject, command: string, args: string[], cwd = p.expo.repoDir) {
  const promise = execFileAsync(command, args, { cwd, maxBuffer: 50 * 1024 * 1024, env: childEnv(p) });
  // eas reads workflow inputs from stdin when it's a pipe, so close it.
  promise.child.stdin?.end();
  return (await promise).stdout;
}

// Serializes everything that touches a project's clone, so two releases can't check out over
// each other. Different projects don't wait for each other.
const queues = new Map<string, Promise<unknown>>();
export function withRepo<T>(p: ExpoProject, task: () => Promise<T>): Promise<T> {
  const next = (queues.get(p.id) ?? Promise.resolve()).then(task, task);
  queues.set(p.id, next.catch(() => {}));
  return next;
}

// The bot's own clone, reset to exactly what's on GitHub. Never your working copy.
export async function syncRepo(p: ExpoProject, branch: string) {
  const dir = p.expo.repoDir;
  if (!existsSync(join(dir, ".git"))) {
    mkdirSync(dirname(dir), { recursive: true });
    await run(p, "git", ["clone", `https://github.com/${p.github.owner}/${p.github.repo}.git`, dir], process.cwd());
  }
  await run(p, "git", ["fetch", "--prune", "origin"]);
  await run(p, "git", ["checkout", "--force", "-B", branch, `origin/${branch}`]);
  await run(p, "git", ["clean", "-fdx", "-e", "node_modules"]);

  // eas evaluates app config plugins, which need node_modules. Reinstall only when the lockfile
  // (or whether install scripts run) changes. Scripts are off unless the project opts in, since
  // they'd run every dependency's install hooks on the bot's machine.
  const scripts = p.expo.installScripts ? [] : ["--ignore-scripts"];
  const lockHashFile = join(dir, "node_modules", ".bot-lock-hash");
  const lockHash = createHash("sha256").update(readFileSync(join(dir, "package-lock.json"))).update(scripts.join()).digest("hex");
  if (!existsSync(lockHashFile) || readFileSync(lockHashFile, "utf8") !== lockHash) {
    await run(p, "npm", ["ci", "--no-audit", "--no-fund", ...scripts]);
    writeFileSync(lockHashFile, lockHash);
  }
}

// Read-only eas commands only need the clone to exist, not to be freshly synced.
export async function ensureRepo(p: ExpoProject) {
  if (!existsSync(join(p.expo.repoDir, "node_modules"))) await syncRepo(p, p.github.releaseBranch);
}

export async function eas(p: ExpoProject, args: string[]): Promise<string> {
  return run(p, EAS_BIN, args);
}

// A long eas command (a local build) whose output goes to a log file instead of memory. `extraEnv`
// is added on top of the usual child environment. Killed, and rejected, after `timeoutMs`.
export function easToFile(p: ExpoProject, args: string[], logPath: string, extraEnv: NodeJS.ProcessEnv, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const log = createWriteStream(logPath, { flags: "a" });
    const child = spawn(EAS_BIN, args, { cwd: p.expo.repoDir, env: { ...childEnv(p), ...extraEnv }, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    const finish = (err: Error | null) => {
      clearTimeout(timer);
      log.end(() => (err ? reject(err) : resolve()));
    };
    child.on("error", finish);
    child.on("close", (code, signal) => {
      if (code === 0) finish(null);
      else finish(new Error(signal === "SIGKILL" ? `eas ${args[0]} took longer than ${Math.round(timeoutMs / 60000)} minutes and was stopped` : `eas ${args[0]} exited with code ${code ?? signal}`));
    });
  });
}
