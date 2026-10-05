import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { help, status } from "../src/replies.ts";
import type { Project } from "../src/settings.ts";

const app = (android: string | null): Project => ({
  id: "myapp",
  name: "MyApp",
  aliases: ["myapp"],
  slackChannels: [],
  github: { owner: "a", repo: "myapp", releaseBranch: "release" },
  expo: { iosBundleId: "x", otaChannel: "production", workflows: { ota: "ota.yml", testflight: "tf.yml", android }, token: "t", versioning: "app-json", repoDir: "r" },
});

describe("help", () => {
  it("lists Android builds only when the workflow is set", () => {
    assert.match(help(app("android.yml")), /build Android/);
    assert.doesNotMatch(help(app(null)), /Android/);
  });
});

describe("status", () => {
  it("shows the version without assuming iOS", () => {
    const text = status(app("android.yml"), {
      workflow: "Build Android",
      status: "SUCCESS",
      startedAt: null,
      finishedAt: null,
      url: "https://expo.dev/run",
      failedSteps: [],
      version: "1.0.0",
      buildNumber: "7",
    });
    assert.match(text, /\*Build Android\* succeeded · 1\.0\.0 \(build 7\)/);
  });
});
