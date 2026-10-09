import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseConfig } from "./settings.ts";

// Secrets come from .env; projects and behavior come from blink.config.json. Both are
// gitignored; see the .example files. Loaded on first use, not on import, so modules that use
// `config` can still be imported (and tested) without any of it.

function secret(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing secret ${name} in .env (see .env.example)`);
  return value;
}

// Reuse the local `gh` login when no token is configured.
function githubToken(): string {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  try {
    return execFileSync("gh", ["auth", "token"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    throw new Error("Missing GITHUB_TOKEN in .env, and no `gh` CLI login to fall back on");
  }
}

function loadFile(path: string) {
  if (!existsSync(path)) {
    throw new Error(`Missing ${path}. Copy blink.config.example.json and fill it in.`);
  }
  try {
    return parseConfig(JSON.parse(readFileSync(path, "utf8")), process.env);
  } catch (err) {
    throw new Error(`Invalid ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function load() {
  if (existsSync(".env")) process.loadEnvFile(".env");
  const file = loadFile(resolve(process.env.BLINK_CONFIG ?? "blink.config.json"));
  return {
    slackBotToken: secret("SLACK_BOT_TOKEN"),
    slackAppToken: secret("SLACK_APP_TOKEN"),
    typesafeApiKey: secret("TYPESAFE_API_KEY"),
    // Optional: offered as a fallback when Jev can't route a request.
    openaiApiKey: process.env.OPENAI_API_KEY || null,
    githubToken: githubToken(),
    allowedUserIds: file.allowedUserIds,
    autonomy: file.autonomy,
    retention: file.retention,
    // What the bot remembers between restarts (threads, pending confirmations, watched runs).
    statePath: resolve(process.env.BLINK_STATE ?? "blink.state.json"),
    // Pinned so behavior (and the confidence threshold tuned for it) only changes when we choose.
    jevModel: file.models.jev,
    openaiModel: file.models.openai,
    projects: file.projects.map((p) => (p.expo ? { ...p, expo: { ...p.expo, repoDir: resolve(p.expo.repoDir) } } : p)),
  };
}

export type LoadedConfig = ReturnType<typeof load>;

let loaded: LoadedConfig | undefined;
export const config: LoadedConfig = new Proxy({} as LoadedConfig, {
  get: (_, key) => (loaded ??= load())[key as keyof LoadedConfig],
});
