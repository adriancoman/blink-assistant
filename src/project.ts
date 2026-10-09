// A project and the settings of each capability it has. Pure types and guards, imported by
// everything, so it depends on nothing.

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
  // Whether `npm ci` in the bot's clone runs the dependencies' install scripts.
  installScripts: boolean;
  // Building iOS on the machine Blink runs on (`eas build --local`, which drives Xcode through
  // fastlane), for when EAS's cloud quota is spent. `profile` names the eas.json build and submit
  // profiles; `env` is added to the build's environment (e.g. SENTRY_DISABLE_AUTO_UPLOAD). Null when
  // not set up.
  localBuild: LocalBuildSettings | null;
};

export type LocalBuildSettings = { profile: string; env: Record<string, string> };

export type PosthogSettings = { host: string; projectId: string; apiKey: string };

// A project only has the capabilities whose blocks are configured. Expo needs GitHub, since
// releases come from the release branch. Each capability module parses its own block.
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
export type PosthogProject = Project & { posthog: PosthogSettings };

export const hasGithub = (p: Project): p is GithubProject => Boolean(p.github);
export const hasExpo = (p: Project): p is ExpoProject => Boolean(p.github && p.expo);
export const hasPosthog = (p: Project): p is PosthogProject => Boolean(p.posthog);
