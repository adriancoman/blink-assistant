import { config } from "./config.ts";
import { builtStoreVersions } from "./expo.ts";
import { readFile } from "./github.ts";
import { chooseVersion, readAppJsonVersion, type VersionPlan } from "./versioning.ts";

export async function liveAppStoreVersion(): Promise<string> {
  const response = await fetch(`https://itunes.apple.com/lookup?bundleId=${config.iosBundleId}`);
  const result = (await response.json()).results?.[0];
  if (!result?.version) throw new Error(`Couldn't find ${config.iosBundleId} on the App Store`);
  return result.version;
}

export async function planVersion(requested: string | null): Promise<VersionPlan> {
  const [live, built, appJson] = await Promise.all([
    liveAppStoreVersion(),
    builtStoreVersions(),
    readFile("app.json", config.releaseBranch).catch(() => {
      throw new Error(`Couldn't read app.json on \`${config.releaseBranch}\`. Does the branch exist?`);
    }),
  ]);
  return chooseVersion({ live, built, current: readAppJsonVersion(appJson.content), requested });
}
