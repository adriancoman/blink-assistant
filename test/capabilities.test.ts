import assert from "node:assert/strict";
import { describe, it } from "node:test";
// The registry first: loading a capability module directly reaches the registry through the
// settings loader before the capability is defined (a module cycle).
import { actionSpec, capabilities, helpLines, intentDescriptions, intentOwner, supports } from "../src/capabilities/index.ts";
import { chooseWhere } from "../src/capabilities/expo.ts";
import { needsConfirm, parseConfig } from "../src/settings.ts";

const env = { EXPO_TOKEN: "t", POSTHOG_API_KEY: "k" };
const parse = (project: Record<string, unknown>) => parseConfig({ allowedSlackUserId: "U1", projects: [{ id: "app", ...project }] }, env).projects[0];

const github = { repo: "acme/app" };
const expo = { iosBundleId: "com.acme.app", workflows: { android: "android.yml" } };
const posthog = { host: "https://eu.posthog.com", projectId: 1 };

describe("registry", () => {
  it("has every intent and action owned by exactly one capability", () => {
    const intents = capabilities.flatMap((c) => Object.keys(c.intents));
    assert.equal(new Set(intents).size, intents.length);
    for (const intent of intents) assert.ok(intentOwner(intent));
    assert.equal(intentOwner("help"), null);
    assert.equal(actionSpec("nope"), null);
  });

  it("describes intents for Jev in capability order", () => {
    const names = Object.keys(intentDescriptions());
    assert.equal(names[0], "merge");
    assert.ok(names.indexOf("release_ota") < names.indexOf("analytics"));
  });

  it("marks releases, which 'partial' autonomy still confirms", () => {
    for (const kind of ["release_ota", "release_testflight", "release_android"]) assert.equal(needsConfirm("partial", kind), true);
    for (const kind of ["merge", "rollback_ota", "stop_rollout", "resume_rollout"]) assert.equal(needsConfirm("partial", kind), false);
  });
});

describe("what a project supports", () => {
  it("follows its configured blocks", () => {
    const full = parse({ github, expo, posthog });
    const web = parse({ github, posthog });
    assert.ok(supports(full, "release_testflight"));
    assert.ok(supports(full, "release_android"));
    assert.ok(supports(web, "merge"));
    assert.ok(supports(web, "analytics"));
    assert.ok(!supports(web, "release_ota"));
    assert.ok(!supports(web, "status"));
    assert.ok(!supports(full, "unknown"));
  });

  it("turns a command off when its workflow is null", () => {
    const noOta = parse({ github, expo: { ...expo, workflows: { ota: null } } });
    assert.ok(!supports(noOta, "release_ota"));
    assert.ok(supports(noOta, "release_testflight"));
    assert.ok(!supports(noOta, "release_android"));
  });
});

describe("OpenAI tools and help", () => {
  const names = (p: ReturnType<typeof parse>) => capabilities.flatMap((c) => c.tools(p).map((t) => t.definition.name));

  it("only offers what the project has", () => {
    assert.deepEqual(names(parse({ github })), ["merge_branches"]);
    assert.deepEqual(names(parse({ posthog })), ["ask_posthog"]);
    const full = names(parse({ github, expo, posthog }));
    assert.ok(full.includes("release_android"));
    assert.ok(full.includes("last_failure"));
    assert.ok(full.includes("ask_posthog"));
    assert.ok(!names(parse({ github, expo: { ...expo, workflows: {} } })).includes("release_android"));
  });

  it("lists help lines per capability", () => {
    assert.equal(helpLines(parse({ posthog })).length, 1);
    const full = helpLines(parse({ github, expo, posthog }));
    assert.match(full[0], /merge/);
    assert.match(full[full.length - 1], /analytics/);
  });
});

describe("building iOS on this machine", () => {
  const local = { ...expo, localBuild: true };
  const tool = (p: ReturnType<typeof parse>) => capabilities.flatMap((c) => c.tools(p)).find((t) => t.definition.name === "release_testflight");
  const testflight = (action: Record<string, unknown>) => actionSpec("release_testflight")!.describe(parse({ github, expo: local }), { kind: "release_testflight", ...action });

  it("is off unless asked for, and takes a profile and extra env", () => {
    assert.equal(parse({ github, expo }).expo?.localBuild, null);
    assert.equal(parse({ github, expo: { ...expo, localBuild: false } }).expo?.localBuild, null);
    assert.deepEqual(parse({ github, expo: local }).expo?.localBuild, { profile: "production", env: {} });
    assert.deepEqual(parse({ github, expo: { ...expo, localBuild: { profile: "store", env: { SENTRY_DISABLE_AUTO_UPLOAD: "true" } } } }).expo?.localBuild, {
      profile: "store",
      env: { SENTRY_DISABLE_AUTO_UPLOAD: "true" },
    });
    assert.throws(() => parse({ github, expo: { ...expo, localBuild: "yes" } }), /"expo.localBuild" must be true, false or/);
    assert.throws(() => parse({ github, expo: { ...expo, localBuild: { env: { A: 1 } } } }), /"expo.localBuild.env" must be an object of string values/);
  });

  it("is enough for TestFlight on its own, and then builds locally by default", () => {
    const onlyLocal = parse({ github, expo: { ...expo, workflows: { testflight: null }, localBuild: true } });
    assert.ok(supports(onlyLocal, "release_testflight"));
    assert.ok(!supports(parse({ github, expo: { ...expo, workflows: { testflight: null } } }), "release_testflight"));
    assert.equal(chooseWhere(onlyLocal as never, false), "local");
    assert.equal(chooseWhere(onlyLocal as never, true), "local");
  });

  it("builds on EAS unless asked to build locally, and explains when that isn't set up", () => {
    const both = parse({ github, expo: local });
    assert.equal(chooseWhere(both as never, false), "cloud");
    assert.equal(chooseWhere(both as never, true), "local");
    const cloudOnly = parse({ github, expo });
    assert.equal(chooseWhere(cloudOnly as never, false), "cloud");
    assert.match(chooseWhere(cloudOnly as never, true) as string, /isn't set up.*say _release to TestFlight_/);
  });

  it("offers OpenAI the choice only when set up", () => {
    const params = (p: ReturnType<typeof parse>) => Object.keys((tool(p)!.definition.parameters as { properties: object }).properties);
    assert.deepEqual(params(parse({ github, expo })), ["version"]);
    assert.deepEqual(params(parse({ github, expo: local })), ["version", "where"]);
  });

  it("says where the build runs on the Confirm card; older cards mean EAS", () => {
    assert.equal(testflight({ version: "1.2.0", bumpFrom: null, where: "local" }), "Build iOS *1.2.0* from `release` locally on this Mac and upload it to TestFlight");
    assert.match(testflight({ version: "1.2.0", bumpFrom: "1.1.0", where: "local" }), /then build iOS locally on this Mac and upload/);
    assert.equal(testflight({ version: null, bumpFrom: null, where: "local" }), "Build iOS from `release` locally on this Mac and upload it to TestFlight");
    assert.equal(testflight({ version: "1.2.0", bumpFrom: null }), "Build iOS *1.2.0* from `release` and upload it to TestFlight");
  });

  it("mentions it in help", () => {
    assert.match(helpLines(parse({ github, expo: local })).join("\n"), /add _locally_ to build on this Mac/);
    assert.match(helpLines(parse({ github, expo: { ...expo, workflows: { testflight: null }, localBuild: true } })).join("\n"), /TestFlight\* \(built on this Mac\)/);
    assert.doesNotMatch(helpLines(parse({ github, expo })).join("\n"), /locally/);
  });
});

describe("settings per capability", () => {
  it("reads expo.installScripts and rejects non-booleans", () => {
    assert.equal(parse({ github, expo }).expo?.installScripts, false);
    assert.equal(parse({ github, expo: { ...expo, installScripts: true } }).expo?.installScripts, true);
    assert.throws(() => parse({ github, expo: { ...expo, installScripts: "yes" } }), /"expo.installScripts" must be true or false/);
  });

  it("requires at least one block, naming them", () => {
    assert.throws(() => parse({}), /needs at least one of "github", "expo", "posthog"/);
  });
});
