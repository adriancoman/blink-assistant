// Parses and validates release-bot.config.json plus secrets into a Config. Pure (no file or
// network access), so it can be tested without credentials.

export type GithubSettings = { owner: string; repo: string; releaseBranch: string };

export type ExpoSettings = {
  iosBundleId: string;
  otaChannel: string;
  // null means the command isn't set up for this project.
  workflows: { ota: string | null; testflight: string | null; android: string | null };
  token: string;
  // "app-json": Blink bumps expo.version in app.json; "minor": Blink bumps the minor for TestFlight
  // and counts OTA updates as the patch (see chooseMinorVersion); "none": the workflow handles versions.
  versioning: "app-json" | "minor" | "none";
  repoDir: string;
};

export type PosthogSettings = { host: string; projectId: string; apiKey: string };

// A project only has the capabilities whose blocks are configured. Expo needs GitHub, since
// releases come from the release branch.
export type Project = {
  id: string;
  name: string;
  aliases: string[];
  slackChannels: string[];
  github?: GithubSettings;
  expo?: ExpoSettings;
  posthog?: PosthogSettings;
};

export type GithubProject = Project & { github: GithubSettings };
export type ExpoProject = Project & { github: GithubSettings; expo: ExpoSettings };

export const hasGithub = (p: Project): p is GithubProject => Boolean(p.github);
export const hasExpo = (p: Project): p is ExpoProject => Boolean(p.github && p.expo);

// Which actions run without a Confirm click: "none" asks for every action, "partial" only for
// releases (OTA, TestFlight, Android), "full" for none.
export const AUTONOMY = ["none", "partial", "full"] as const;
export type Autonomy = (typeof AUTONOMY)[number];

const RELEASES = ["release_ota", "release_testflight", "release_android"];

export const needsConfirm = (autonomy: Autonomy, actionKind: string) =>
  autonomy === "none" || (autonomy === "partial" && RELEASES.includes(actionKind));

export type Config = {
  allowedUserIds: string[];
  autonomy: Autonomy;
  models: { jev: string; openai: string };
  projects: Project[];
};

type Env = Record<string, string | undefined>;
type Raw = Record<string, any>;

const isString = (v: unknown): v is string => typeof v === "string" && v.length > 0;

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

  const secret = (name: string, where: string) => {
    const value = env[name];
    if (!value) problems.push(`${where} needs the secret ${name} in .env`);
    return value ?? "";
  };

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

    if (p.github) {
      const repo = p.github.repo;
      if (!isString(repo) || !/^[\w.-]+\/[\w.-]+$/.test(repo)) problems.push(`${where}: "github.repo" should look like "owner/repo"`);
      const [owner, name] = isString(repo) ? repo.split("/") : ["", ""];
      project.github = { owner, repo: name, releaseBranch: isString(p.github.releaseBranch) ? p.github.releaseBranch : "release" };
    }

    if (p.expo) {
      if (!p.github) problems.push(`${where}: "expo" also needs a "github" block`);
      if (!isString(p.expo.iosBundleId)) problems.push(`${where}: "expo.iosBundleId" is required`);
      const versioning = p.expo.versioning ?? "app-json";
      if (!["app-json", "minor", "none"].includes(versioning)) problems.push(`${where}: "expo.versioning" must be "app-json", "minor" or "none"`);
      const workflow = (key: "ota" | "testflight" | "android", fallback: string | null) =>
        p.expo.workflows && key in p.expo.workflows ? (isString(p.expo.workflows[key]) ? p.expo.workflows[key] : null) : fallback;
      project.expo = {
        iosBundleId: p.expo.iosBundleId ?? "",
        otaChannel: isString(p.expo.otaChannel) ? p.expo.otaChannel : "production",
        // Android is opt-in, since older configs predate it and their repos may not have the file.
        workflows: {
          ota: workflow("ota", "ota-production.yml"),
          testflight: workflow("testflight", "release-native.yml"),
          android: workflow("android", null),
        },
        token: secret(isString(p.expo.tokenEnv) ? p.expo.tokenEnv : "EXPO_TOKEN", `${where} expo`),
        versioning,
        repoDir: isString(p.expo.repoDir) ? p.expo.repoDir : `.repos/${p.id}`,
      };
    }

    if (p.posthog) {
      if (!isString(p.posthog.host)) problems.push(`${where}: "posthog.host" is required (e.g. "https://eu.posthog.com")`);
      if (!isString(String(p.posthog.projectId ?? ""))) problems.push(`${where}: "posthog.projectId" is required`);
      project.posthog = {
        host: p.posthog.host ?? "",
        projectId: String(p.posthog.projectId ?? ""),
        apiKey: secret(isString(p.posthog.apiKeyEnv) ? p.posthog.apiKeyEnv : "POSTHOG_API_KEY", `${where} posthog`),
      };
    }

    if (!project.github && !project.expo && !project.posthog) problems.push(`${where}: needs at least one of "github", "expo", "posthog"`);
    return project;
  });

  if (problems.length) throw new Error(problems.join("; "));
  return {
    allowedUserIds,
    autonomy,
    models: { jev: raw.models?.jev ?? "jev-1.13.0", openai: raw.models?.openai ?? "gpt-6-luna" },
    projects,
  };
}
