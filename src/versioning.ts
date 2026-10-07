// Pure version rules, kept free of I/O so they can be tested without any credentials.

const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
// The first "version" key in app.json is expo.version.
const APP_JSON_VERSION = /("version":\s*")([^"]+)(")/;

export function compareVersions(a: string, b: string): number {
  const [pa, pb] = [a.split(".").map(Number), b.split(".").map(Number)];
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

export function nextPatch(version: string): string {
  const [major, minor, patch] = version.split(".").map(Number);
  return `${major}.${minor}.${patch + 1}`;
}

export function nextMinor(version: string): string {
  const [major, minor] = version.split(".").map(Number);
  return `${major}.${minor + 1}.0`;
}

export const maxVersion = (versions: string[]) =>
  versions.reduce<string | null>((a, b) => (!a || compareVersions(b, a) > 0 ? b : a), null);

export function readAppJsonVersion(appJson: string): string {
  const match = appJson.match(APP_JSON_VERSION);
  if (!match) throw new Error("Couldn't find the version in app.json");
  return match[2];
}

export function setAppJsonVersion(appJson: string, version: string): string {
  return appJson.replace(APP_JSON_VERSION, `$1${version}$3`);
}

export type VersionPlan = { version: string; bumpFrom: string | null; live: string; highestBuilt: string | null };

// Apple rejects a build unless its version is above the live one and above any previously
// approved one. Approved-but-unreleased versions (like a CLI build) aren't in the public lookup,
// so EAS's build history stands in for them. More builds of the newest built version are fine,
// since its train is usually still open.
export function chooseVersion(args: { live: string; built: string[]; current: string; requested: string | null }): VersionPlan {
  const { live, built, current, requested } = args;
  const highestBuilt = maxVersion(built);
  const isAllowed = (v: string) => compareVersions(v, live) > 0 && (!highestBuilt || compareVersions(v, highestBuilt) >= 0);
  const plan = (version: string) => ({ version, bumpFrom: version === current ? null : current, live, highestBuilt });

  if (requested) {
    if (!VERSION_PATTERN.test(requested)) throw new Error(`"${requested}" isn't a version like 1.2.3`);
    if (!isAllowed(requested)) {
      throw new Error(`${requested} is too low: the App Store has ${live} live and EAS has built up to ${highestBuilt ?? live}`);
    }
    return plan(requested);
  }
  if (isAllowed(current)) return plan(current);
  return plan(nextPatch(maxVersion([live, ...built])!));
}

// "minor" versioning: every TestFlight build is a new major.minor, and the patch the app shows
// counts the OTA updates published on top of it (app.json expo.extra.ota = { for, n }, where the
// count only holds for the version it was made for). An app that isn't on the App Store yet has
// no live version.
export function chooseMinorVersion(args: { live: string | null; built: string[]; current: string; requested: string | null }): VersionPlan {
  const { live, built, current, requested } = args;
  const highestBuilt = maxVersion(built);
  const above = (v: string, floor: string | null) => !floor || compareVersions(v, floor) > 0;
  const plan = (version: string) => ({ version, bumpFrom: version === current ? null : current, live: live ?? "none", highestBuilt });

  if (requested) {
    if (!VERSION_PATTERN.test(requested)) throw new Error(`"${requested}" isn't a version like 1.2.0`);
    if (!requested.endsWith(".0")) throw new Error(`${requested} won't do: the last number counts OTA updates, so ask for a version like ${nextMinor(requested)}`);
    if (!above(requested, live) || (highestBuilt && compareVersions(requested, highestBuilt) < 0)) {
      throw new Error(`${requested} is too low: the App Store has ${live ?? "nothing"} live and EAS has built up to ${highestBuilt ?? "nothing"}`);
    }
    return plan(requested);
  }
  // The repo version gets its first build (e.g. a retry after a build that failed); otherwise next minor.
  if (above(current, live) && above(current, highestBuilt)) return plan(current);
  return plan(nextMinor(maxVersion([current, ...built, ...(live ? [live] : [])])!));
}

type OtaCount = { for?: string; n?: number };

// The version the next OTA update will show, and app.json with it counted.
export function countOta(appJson: string): { version: string; content: string } {
  const json = JSON.parse(appJson);
  const expo = json.expo, current: string = expo.version;
  const ota: OtaCount | undefined = expo.extra?.ota;
  const n = (ota?.for === current && typeof ota.n === "number" ? ota.n : 0) + 1;
  expo.extra = { ...expo.extra, ota: { for: current, n } };
  const [major, minor] = current.split(".");
  return { version: `${major}.${minor}.${n}`, content: JSON.stringify(json, null, 2) + "\n" };
}
