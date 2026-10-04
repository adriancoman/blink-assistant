import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

// Secrets come from .env; everything else about the app and the bot's behavior comes from
// release-bot.config.json. Both are gitignored; see the .example files.

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

type FileConfig = {
  appName: string;
  githubRepo: string;
  iosBundleId: string;
  allowedSlackUserId: string;
  releaseBranch?: string;
  otaChannel?: string;
  workflows?: { ota?: string; testflight?: string };
  models?: { jev?: string; openai?: string };
  repoDir?: string;
};

function loadFile(): FileConfig {
  if (!existsSync(CONFIG_PATH)) {
    throw new Error(`Missing ${CONFIG_PATH}. Copy release-bot.config.example.json and fill it in.`);
  }
  const file = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Partial<FileConfig>;
  const problems: string[] = [];
  for (const key of ["appName", "githubRepo", "iosBundleId", "allowedSlackUserId"] as const) {
    if (typeof file[key] !== "string" || !file[key]) problems.push(`"${key}" is required`);
  }
  if (file.githubRepo && !/^[\w.-]+\/[\w.-]+$/.test(file.githubRepo)) problems.push(`"githubRepo" should look like "owner/repo"`);
  if (problems.length) throw new Error(`Invalid ${CONFIG_PATH}: ${problems.join("; ")}`);
  return file as FileConfig;
}

const file = loadFile();
const [owner, repo] = file.githubRepo.split("/");

export const config = {
  // Secrets (.env)
  slackBotToken: secret("SLACK_BOT_TOKEN"),
  slackAppToken: secret("SLACK_APP_TOKEN"),
  typesafeApiKey: secret("TYPESAFE_API_KEY"),
  expoToken: secret("EXPO_TOKEN"),
  // Optional: offered as a fallback when Jev can't route a request.
  openaiApiKey: process.env.OPENAI_API_KEY || null,
  githubToken: githubToken(),

  // Settings (release-bot.config.json)
  appName: file.appName,
  owner,
  repo,
  iosBundleId: file.iosBundleId,
  allowedUserId: file.allowedSlackUserId,
  releaseBranch: file.releaseBranch ?? "release",
  otaChannel: file.otaChannel ?? "production",
  workflows: {
    ota: file.workflows?.ota ?? "ota-production.yml",
    testflight: file.workflows?.testflight ?? "release-native.yml",
  },
  // Pinned so behavior (and the confidence threshold tuned for it) only changes when we choose.
  jevModel: file.models?.jev ?? "jev-1.13.0",
  openaiModel: file.models?.openai ?? "gpt-6-luna",
  // The bot's own clone of the app, used to upload releases to EAS. Separate from your working copy.
  repoDir: resolve(file.repoDir ?? ".repo"),
};
