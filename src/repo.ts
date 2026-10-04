import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { config } from "./config.ts";

const execFileAsync = promisify(execFile);
const LOCK_HASH_FILE = join(config.repoDir, "node_modules", ".bot-lock-hash");
// The bot's pinned eas-cli, so a global upgrade or downgrade can't change its behavior.
const EAS_BIN = resolve("node_modules/.bin/eas");

// HTTPS auth for git via env-only config, so the token isn't stored in .git/config or visible in `ps`.
const githubAuth = Buffer.from(`x-access-token:${config.githubToken}`).toString("base64");
const gitAuthEnv = {
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
  GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${githubAuth}`,
};

async function run(command: string, args: string[], cwd = config.repoDir) {
  const promise = execFileAsync(command, args, {
    cwd,
    maxBuffer: 50 * 1024 * 1024,
    env: { ...process.env, ...gitAuthEnv, EXPO_TOKEN: config.expoToken },
  });
  // eas reads workflow inputs from stdin when it's a pipe, so close it.
  promise.child.stdin?.end();
  return (await promise).stdout;
}

// Serializes everything that touches the clone, so two releases can't check out over each other.
let queue: Promise<unknown> = Promise.resolve();
export function withRepo<T>(task: () => Promise<T>): Promise<T> {
  const next = queue.then(task, task);
  queue = next.catch(() => {});
  return next;
}

// The bot's own clone, reset to exactly what's on GitHub. Never your working copy.
export async function syncRepo(branch: string) {
  if (!existsSync(join(config.repoDir, ".git"))) {
    await run("git", ["clone", `https://github.com/${config.owner}/${config.repo}.git`, config.repoDir], process.cwd());
  }
  await run("git", ["fetch", "--prune", "origin"]);
  await run("git", ["checkout", "--force", "-B", branch, `origin/${branch}`]);
  await run("git", ["clean", "-fdx", "-e", "node_modules"]);

  // eas evaluates app.json plugins, which need node_modules. Reinstall only when the lockfile changes.
  const lockHash = createHash("sha256").update(readFileSync(join(config.repoDir, "package-lock.json"))).digest("hex");
  if (!existsSync(LOCK_HASH_FILE) || readFileSync(LOCK_HASH_FILE, "utf8") !== lockHash) {
    await run("npm", ["ci", "--no-audit", "--no-fund"]);
    writeFileSync(LOCK_HASH_FILE, lockHash);
  }
}

export async function eas(args: string[]): Promise<string> {
  return run(EAS_BIN, args);
}
