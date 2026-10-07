import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { chooseMinorVersion, chooseVersion, compareVersions, countOta, maxVersion, nextMinor, nextPatch, readAppJsonVersion, setAppJsonVersion } from "../src/versioning.ts";

describe("compareVersions", () => {
  it("compares numerically, not as strings", () => {
    assert.ok(compareVersions("1.0.10", "1.0.9") > 0);
    assert.ok(compareVersions("2.0.0", "1.9.9") > 0);
    assert.ok(compareVersions("1.0.3", "1.0.4") < 0);
    assert.equal(compareVersions("1.0.4", "1.0.4"), 0);
  });
});

describe("nextPatch / maxVersion", () => {
  it("bumps the patch number", () => assert.equal(nextPatch("4.0.9"), "4.0.10"));
  it("bumps the minor number and resets the patch", () => assert.equal(nextMinor("0.9.3"), "0.10.0"));
  it("finds the highest version", () => assert.equal(maxVersion(["1.0.3", "4.0.0", "1.0.10"]), "4.0.0"));
  it("returns null for no versions", () => assert.equal(maxVersion([]), null));
});

describe("app.json version", () => {
  const appJson = `{\n  "expo": {\n    "name": "App",\n    "version": "1.0.3",\n    "plugins": [["x", { "version": "9.9.9" }]]\n  }\n}\n`;

  it("reads expo.version", () => assert.equal(readAppJsonVersion(appJson), "1.0.3"));

  it("changes only the expo.version line", () => {
    const bumped = setAppJsonVersion(appJson, "1.0.5");
    assert.equal(readAppJsonVersion(bumped), "1.0.5");
    const changed = appJson.split("\n").filter((line, i) => line !== bumped.split("\n")[i]);
    assert.deepEqual(changed, ['    "version": "1.0.3",']);
  });

  it("throws when there's no version", () => assert.throws(() => readAppJsonVersion("{}")));
});

describe("chooseVersion", () => {
  it("keeps the repo version when it's above everything", () => {
    assert.deepEqual(chooseVersion({ live: "1.0.4", built: ["1.0.3"], current: "1.0.5", requested: null }), {
      version: "1.0.5", bumpFrom: null, live: "1.0.4", highestBuilt: "1.0.3",
    });
  });

  it("bumps past the live version", () => {
    const plan = chooseVersion({ live: "1.0.4", built: [], current: "1.0.3", requested: null });
    assert.equal(plan.version, "1.0.5");
    assert.equal(plan.bumpFrom, "1.0.3");
  });

  // The real case: a CLI-built 4.0.0 was approved but never went live.
  it("bumps past an approved build that never went live", () => {
    const plan = chooseVersion({ live: "1.0.4", built: ["1.0.5", "4.0.0", "1.0.3"], current: "1.0.5", requested: null });
    assert.equal(plan.version, "4.0.1");
    assert.equal(plan.bumpFrom, "1.0.5");
  });

  it("allows more builds of the highest built version", () => {
    const plan = chooseVersion({ live: "1.0.4", built: ["4.0.1"], current: "4.0.1", requested: null });
    assert.equal(plan.version, "4.0.1");
    assert.equal(plan.bumpFrom, null);
  });

  it("accepts a requested version that's high enough", () => {
    assert.equal(chooseVersion({ live: "1.0.4", built: ["4.0.0"], current: "1.0.5", requested: "4.1.0" }).version, "4.1.0");
  });

  it("refuses a requested version that's too low", () => {
    assert.throws(
      () => chooseVersion({ live: "1.0.4", built: ["4.0.0"], current: "1.0.5", requested: "2.0.0" }),
      /too low/,
    );
  });

  it("refuses something that isn't a version", () => {
    assert.throws(() => chooseVersion({ live: "1.0.4", built: [], current: "1.0.5", requested: "v2" }), /isn't a version/);
  });
});

describe("chooseMinorVersion", () => {
  it("bumps the minor past a version that was already built", () => {
    const plan = chooseMinorVersion({ live: null, built: ["0.1.0"], current: "0.1.0", requested: null });
    assert.equal(plan.version, "0.2.0");
    assert.equal(plan.bumpFrom, "0.1.0");
  });

  it("keeps a repo version that was never built (a retry)", () => {
    const plan = chooseMinorVersion({ live: null, built: ["0.1.0"], current: "0.2.0", requested: null });
    assert.equal(plan.version, "0.2.0");
    assert.equal(plan.bumpFrom, null);
  });

  it("bumps past the live and the highest built version", () => {
    assert.equal(chooseMinorVersion({ live: "1.3.0", built: ["0.9.0"], current: "0.9.0", requested: null }).version, "1.4.0");
    assert.equal(chooseMinorVersion({ live: "1.3.0", built: ["2.0.0"], current: "1.3.0", requested: null }).version, "2.1.0");
  });

  it("accepts a requested x.y.0 that's high enough, and refuses a patch", () => {
    assert.equal(chooseMinorVersion({ live: null, built: ["0.1.0"], current: "0.1.0", requested: "1.0.0" }).version, "1.0.0");
    assert.throws(() => chooseMinorVersion({ live: null, built: [], current: "0.1.0", requested: "0.2.1" }), /counts OTA updates/);
    assert.throws(() => chooseMinorVersion({ live: "1.0.0", built: [], current: "0.1.0", requested: "0.5.0" }), /too low/);
  });
});

describe("countOta", () => {
  const app = (extra: object) => JSON.stringify({ expo: { name: "App", version: "0.2.0", extra } }, null, 2) + "\n";

  it("counts on from the last update of the same version", () => {
    const { version, content } = countOta(app({ eas: { projectId: "p" }, ota: { for: "0.2.0", n: 3 } }));
    assert.equal(version, "0.2.4");
    assert.deepEqual(JSON.parse(content).expo.extra, { eas: { projectId: "p" }, ota: { for: "0.2.0", n: 4 } });
  });

  it("starts at 1 after a new TestFlight version, or with no count yet", () => {
    assert.equal(countOta(app({ ota: { for: "0.1.0", n: 7 } })).version, "0.2.1");
    assert.equal(countOta(app({})).version, "0.2.1");
  });

  it("keeps the file's formatting", () => {
    const before = app({ ota: { for: "0.2.0", n: 1 } });
    assert.equal(countOta(before).content, before.replace('"n": 1', '"n": 2'));
  });
});
