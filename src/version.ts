import { builtStoreVersions } from "./expo.ts";
import { readFile } from "./github.ts";
import type { ExpoProject } from "./settings.ts";
import { chooseVersion, readAppJsonVersion, type VersionPlan } from "./versioning.ts";

export async function liveAppStoreVersion(p: ExpoProject): Promise<string> {
  const response = await fetch(`https://itunes.apple.com/lookup?bundleId=${p.expo.iosBundleId}`);
  const result = (await response.json()).results?.[0];
  if (!result?.version) throw new Error(`Couldn't find ${p.expo.iosBundleId} on the App Store`);
  return result.version;
}

export async function planVersion(p: ExpoProject, requested: string | null): Promise<VersionPlan> {
  const branch = p.github.releaseBranch;
  const [live, built, appJson] = await Promise.all([
    liveAppStoreVersion(p),
    builtStoreVersions(p),
    readFile(p, "app.json", branch).catch(() => {
      throw new Error(`Couldn't read app.json on \`${branch}\`. Does the branch exist?`);
    }),
  ]);
  return chooseVersion({ live, built, current: readAppJsonVersion(appJson.content), requested });
}
