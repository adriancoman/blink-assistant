import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { LastRun } from "../src/expo.ts";
import { failedRun, help, lastFailure, status } from "../src/replies.ts";
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
  it("lists Android releases only when the workflow is set", () => {
    assert.match(help(app("android.yml")), /release Android/);
    assert.doesNotMatch(help(app(null)), /Android/);
  });
});

describe("status", () => {
  it("shows the version without assuming iOS", () => {
    const text = status(app("android.yml"), {
      id: "run-1",
      workflow: "Release Android",
      status: "SUCCESS",
      startedAt: null,
      finishedAt: null,
      url: "https://expo.dev/run",
      failedJobs: [],
      version: "1.0.0",
      buildNumber: "7",
    });
    assert.match(text, /\*Release Android\* succeeded · 1\.0\.0 \(build 7\)/);
  });
});

const run = (over: Partial<LastRun> = {}): LastRun => ({
  id: "run-2",
  workflow: "Release iOS",
  status: "FAILURE",
  startedAt: null,
  finishedAt: null,
  url: "https://expo.dev/run-2",
  failedJobs: [{ id: "job-1", name: "Submit iOS" }],
  version: null,
  buildNumber: null,
  ...over,
});

describe("failedRun", () => {
  it("shows the failing step and its log in a code block, escaped for Slack", () => {
    const text = failedRun(run(), { job: "Submit iOS", step: "Prepare credentials", lines: ["<ref *1> Error: a & b"] });
    assert.match(text, /❌ \*Release iOS\* failed at \*Submit iOS\*/);
    assert.match(text, /Failed step: \*Prepare credentials\*\n```\n&lt;ref \*1&gt; Error: a &amp; b\n```\n<https:\/\/expo\.dev\/run-2\|View run>$/);
  });

  it("names the job when several failed", () => {
    const jobs = [{ id: "a", name: "Build iOS" }, { id: "b", name: "Build Android" }];
    assert.match(failedRun(run({ failedJobs: jobs }), { job: "Build iOS", step: "x", lines: [] }), /Failed step: \*x\* \(in Build iOS\)\n</);
  });

  it("says so when the logs don't show the error", () => {
    assert.match(failedRun(run(), null), /couldn't find the error in the logs/);
  });
});

describe("lastFailure", () => {
  it("notes when the failed run isn't the latest", () => {
    const latest = run({ id: "run-3", workflow: "OTA", status: "SUCCESS", failedJobs: [] });
    assert.match(lastFailure({ latest, failed: run(), failure: null, fromThread: false }), /^The latest run, \*OTA\*, succeeded\. The last one that failed:\n❌/);
  });

  it("doesn't when it is", () => {
    assert.match(lastFailure({ latest: run(), failed: run(), failure: null, fromThread: false }), /^❌/);
  });

  it("says when the thread's run hasn't failed", () => {
    const own = run({ status: "IN_PROGRESS", failedJobs: [] });
    assert.match(lastFailure({ latest: own, failed: null, failure: null, fromThread: true }), /^This thread's run hasn't failed:\n⏳ \*Release iOS\* in progress/);
  });

  it("handles no failed runs", () => {
    assert.match(lastFailure({ latest: run({ status: "SUCCESS", failedJobs: [] }), failed: null, failure: null, fromThread: false }), /^No workflow run has failed\./);
  });
});
