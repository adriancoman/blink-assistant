import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseConfig } from "./settings.ts";

// Secrets come from .env; projects and behavior come from release-bot.config.json. Both are
// gitignored; see the .example files.

if (existsSync(".env")) process.loadEnvFile(".env");

const CONFIG_PATH = resolve(process.env.RELEASE_BOT_CONFIG ?? "release-bot.config.json");

function secret(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing secret ${name} in .env (see .env.example)`);
  return value;
}

// Reuse the local `gh` login when no token is configured.
function githubToken(): string {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  return execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim();
}

function loadFile() {
  if (!existsSync(CONFIG_PATH)) {
    throw new Error(`Missing ${CONFIG_PATH}. Copy release-bot.config.example.json and fill it in.`);
  }
  try {
    return parseConfig(JSON.parse(readFileSync(CONFIG_PATH, "utf8")), process.env);
  } catch (err) {
    throw new Error(`Invalid ${CONFIG_PATH}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

const file = loadFile();

export const config = {
  slackBotToken: secret("SLACK_BOT_TOKEN"),
  slackAppToken: secret("SLACK_APP_TOKEN"),
  typesafeApiKey: secret("TYPESAFE_API_KEY"),
  // Optional: offered as a fallback when Jev can't route a request.
  openaiApiKey: process.env.OPENAI_API_KEY || null,
  githubToken: githubToken(),
  allowedUserId: file.allowedUserId,
  // Pinned so behavior (and the confidence threshold tuned for it) only changes when we choose.
  jevModel: file.models.jev,
  openaiModel: file.models.openai,
  projects: file.projects.map((p) => (p.expo ? { ...p, expo: { ...p.expo, repoDir: resolve(p.expo.repoDir) } } : p)),
};
