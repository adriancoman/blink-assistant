import { builtStoreVersions } from "./expo.ts";
import { readFile } from "./github.ts";
import type { ExpoProject } from "./settings.ts";
import { chooseMinorVersion, chooseVersion, countOta, readAppJsonVersion, type VersionPlan } from "./versioning.ts";

export async function liveAppStoreVersion(p: ExpoProject): Promise<string> {
  const response = await fetch(`https://itunes.apple.com/lookup?bundleId=${p.expo.iosBundleId}`);
  const result = (await response.json()).results?.[0];
  if (!result?.version) throw new Error(`Couldn't find ${p.expo.iosBundleId} on the App Store`);
  return result.version;
}

export async function planVersion(p: ExpoProject, requested: string | null): Promise<VersionPlan> {
  const branch = p.github.releaseBranch;
  const minor = p.expo.versioning === "minor";
  const [live, built, appJson] = await Promise.all([
    // A "minor" app may not be on the App Store yet.
    minor ? liveAppStoreVersion(p).catch(() => null) : liveAppStoreVersion(p),
    builtStoreVersions(p),
    readFile(p, "app.json", branch).catch(() => {
      throw new Error(`Couldn't read app.json on \`${branch}\`. Does the branch exist?`);
    }),
  ]);
  const current = readAppJsonVersion(appJson.content);
  return minor ? chooseMinorVersion({ live, built, current, requested }) : chooseVersion({ live: live!, built, current, requested });
}

// The version the next OTA update will show, for projects that count them ("minor"), else null.
export async function planOtaVersion(p: ExpoProject): Promise<string | null> {
  if (p.expo.versioning !== "minor") return null;
  return countOta((await readFile(p, "app.json", p.github.releaseBranch)).content).version;
}
