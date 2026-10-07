import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { hasExpo, hasGithub, parseConfig } from "../src/settings.ts";

const env = { EXPO_TOKEN: "expo", EXPO_TOKEN_OTHER: "other", POSTHOG_API_KEY: "ph" };

const myapp = {
  id: "myapp",
  name: "MyApp",
  aliases: ["my cool app"],
  slackChannels: ["myapp-releases"],
  github: { repo: "acme/myapp-mobile" },
  expo: { iosBundleId: "com.acme.myapp" },
};

describe("parseConfig", () => {
  it("fills in defaults", () => {
    const config = parseConfig({ allowedSlackUserId: "U1", projects: [myapp] }, env);
    const [p] = config.projects;
    assert.deepEqual(config.allowedUserIds, ["U1"]);
    assert.deepEqual(config.models, { jev: "jev-1.13.0", openai: "gpt-6-luna" });
    assert.deepEqual(p.github, { owner: "acme", repo: "myapp-mobile", releaseBranch: "release" });
    assert.deepEqual(p.expo, {
      iosBundleId: "com.acme.myapp",
      otaChannel: "production",
      workflows: { ota: "ota-production.yml", testflight: "release-native.yml", android: null },
      token: "expo",
      versioning: "app-json",
      repoDir: ".repos/myapp",
    });
    assert.deepEqual(p.aliases, ["myapp", "MyApp", "my cool app"]);
    assert.ok(hasExpo(p));
  });

  it("supports a project with PostHog but no Expo or GitHub", () => {
    const [p] = parseConfig(
      { allowedSlackUserId: "U1", projects: [{ id: "web", posthog: { host: "https://eu.posthog.com", projectId: 123 } }] },
      env,
    ).projects;
    assert.equal(p.expo, undefined);
    assert.equal(p.github, undefined);
    assert.deepEqual(p.posthog, { host: "https://eu.posthog.com", projectId: "123", apiKey: "ph" });
    assert.ok(!hasGithub(p) && !hasExpo(p));
  });

  it("supports GitHub without Expo", () => {
    const [p] = parseConfig({ allowedSlackUserId: "U1", projects: [{ id: "api", github: { repo: "acme/api" } }] }, env).projects;
    assert.ok(hasGithub(p) && !hasExpo(p));
  });

  it("lets a project turn off a workflow and use its own Expo token", () => {
    const [p] = parseConfig(
      {
        allowedSlackUserId: "U1",
        projects: [{ ...myapp, expo: { iosBundleId: "x", workflows: { ota: null, android: "build-android.yml" }, tokenEnv: "EXPO_TOKEN_OTHER", versioning: "none" } }],
      },
      env,
    ).projects;
    assert.deepEqual(p.expo?.workflows, { ota: null, testflight: "release-native.yml", android: "build-android.yml" });
    assert.equal(p.expo?.token, "other");
    assert.equal(p.expo?.versioning, "none");
  });

  it("converts the old single-app format", () => {
    const config = parseConfig(
      { appName: "myapp-mobile", githubRepo: "acme/myapp-mobile", iosBundleId: "com.acme.myapp", allowedSlackUserId: "U1", releaseBranch: "release" },
      env,
    );
    assert.equal(config.projects.length, 1);
    assert.equal(config.projects[0].id, "myapp-mobile");
    assert.ok(hasExpo(config.projects[0]));
  });

  it("reports every problem at once", () => {
    assert.throws(
      () =>
        parseConfig(
          {
            projects: [
              { id: "Bad Id" },
              { id: "a", expo: { iosBundleId: "x" } },
              { id: "b", github: { repo: "nope" }, posthog: { host: "h", projectId: "1", apiKeyEnv: "MISSING" } },
              { id: "b", github: { repo: "acme/b" } },
            ],
          },
          env,
        ),
      (err: Error) =>
        ["allowedSlackUserId", '"id" is required', '"expo" also needs a "github" block', '"github.repo" should look like', "MISSING", "duplicate id"].every((s) =>
          err.message.includes(s),
        ),
    );
  });

  it("accepts a list of allowed users", () => {
    assert.deepEqual(parseConfig({ allowedSlackUserId: ["U1", "U2"], projects: [myapp] }, env).allowedUserIds, ["U1", "U2"]);
  });

  it("requires the Expo token secret", () => {
    assert.throws(() => parseConfig({ allowedSlackUserId: "U1", projects: [myapp] }, {}), /EXPO_TOKEN/);
  });
});
