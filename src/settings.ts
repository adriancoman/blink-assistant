// Parses and validates blink.config.json plus secrets into a Config. No file or network
// access, so it can be tested without credentials. Each capability parses its own block.

import { actionSpec, capabilities } from "./capabilities/index.ts";
import { type Env, isString, type ParseContext, type Raw } from "./capability.ts";
import type { Project } from "./project.ts";

export type { ExpoProject, ExpoSettings, GithubProject, GithubSettings, PosthogSettings, Project } from "./project.ts";
export { hasExpo, hasGithub, hasPosthog } from "./project.ts";

// Which actions run without a Confirm click: "none" asks for every action, "partial" only for
// releases (OTA, TestFlight, Android), "full" for none.
export const AUTONOMY = ["none", "partial", "full"] as const;
export type Autonomy = (typeof AUTONOMY)[number];

export const needsConfirm = (autonomy: Autonomy, actionKind: string) =>
  autonomy === "none" || (autonomy === "partial" && Boolean(actionSpec(actionKind)?.release));

// How long remembered state is kept when nothing ends it first (see state.ts).
export type RetentionSettings = { threadDays: number; confirmMinutes: number };
export const DEFAULT_RETENTION: RetentionSettings = { threadDays: 7, confirmMinutes: 30 };

export type Config = {
  allowedUserIds: string[];
  autonomy: Autonomy;
  models: { jev: string; openai: string };
  retention: RetentionSettings;
  projects: Project[];
};

// The flat, single-app format Blink used before projects. Still accepted.
function fromLegacy(raw: Raw): Raw {
  const id = String(raw.appName ?? "app").toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return {
    allowedSlackUserId: raw.allowedSlackUserId,
    autonomy: raw.autonomy,
    models: raw.models,
    projects: [
      {
        id,
        name: raw.appName,
        github: { repo: raw.githubRepo, releaseBranch: raw.releaseBranch },
        expo: {
          iosBundleId: raw.iosBundleId,
          otaChannel: raw.otaChannel,
          workflows: raw.workflows,
          repoDir: raw.repoDir,
        },
      },
    ],
  };
}

export function parseConfig(input: Raw, env: Env): Config {
  const raw = "projects" in input ? input : fromLegacy(input);
  const problems: string[] = [];

  // One member ID, or a list of them.
  const allowedUserIds = [raw.allowedSlackUserId].flat().filter(isString);
  if (!allowedUserIds.length) problems.push(`"allowedSlackUserId" is required (a Slack member ID, or a list of them)`);
  const autonomy = raw.autonomy ?? "none";
  if (!AUTONOMY.includes(autonomy)) problems.push(`"autonomy" must be "none", "partial" or "full"`);
  if (!Array.isArray(raw.projects) || raw.projects.length === 0) problems.push(`"projects" must list at least one project`);

  const retention = { ...DEFAULT_RETENTION };
  for (const key of Object.keys(DEFAULT_RETENTION) as (keyof RetentionSettings)[]) {
    const value = raw.retention?.[key];
    if (value === undefined) continue;
    if (typeof value !== "number" || !(value > 0)) problems.push(`"retention.${key}" must be a positive number`);
    else retention[key] = value;
  }

  const ids = new Set<string>();
  const projects: Project[] = (Array.isArray(raw.projects) ? raw.projects : []).map((p: Raw, i: number) => {
    const where = `projects[${i}]${isString(p.id) ? ` ("${p.id}")` : ""}`;
    if (!isString(p.id) || !/^[a-z0-9-]+$/.test(p.id)) problems.push(`${where}: "id" is required (lowercase letters, digits, dashes)`);
    else if (ids.has(p.id)) problems.push(`${where}: duplicate id`);
    else ids.add(p.id);

    const name = isString(p.name) ? p.name : String(p.id ?? "");
    const project: Project = {
      id: String(p.id ?? ""),
      name,
      aliases: [...new Set([p.id, name, ...(Array.isArray(p.aliases) ? p.aliases : [])].filter(isString))],
      slackChannels: Array.isArray(p.slackChannels) ? p.slackChannels.filter(isString) : [],
    };

    const ctx: ParseContext = {
      env,
      problems,
      where,
      secret: (secretName, what) => {
        const value = env[secretName];
        if (!value) problems.push(`${what} needs the secret ${secretName} in .env`);
        return value ?? "";
      },
    };
    for (const capability of capabilities) Object.assign(project, capability.parseSettings(p, ctx));

    if (!capabilities.some((c) => c.id in project)) {
      problems.push(`${where}: needs at least one of ${capabilities.map((c) => `"${c.id}"`).join(", ")}`);
    }
    return project;
  });

  if (problems.length) throw new Error(problems.join("; "));
  return {
    allowedUserIds,
    autonomy,
    models: { jev: raw.models?.jev ?? "jev-1.13.0", openai: raw.models?.openai ?? "gpt-6-luna" },
    retention,
    projects,
  };
}
