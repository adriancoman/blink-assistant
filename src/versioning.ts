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
