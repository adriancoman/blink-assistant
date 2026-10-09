import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { LastRun } from "../src/expo.ts";
import { isLocalJob, isLocalJobId, missingTools, retryLocally } from "../src/localbuild.ts";

describe("local build jobs", () => {
  it("are told apart from EAS runs by their ID and shape", () => {
    assert.ok(isLocalJobId("local-20261009T120000"));
    assert.ok(!isLocalJobId("5a2d6f8e-1c3b-4a7d-9e0f-123456789abc"));
    assert.ok(isLocalJob({ kind: "local", id: "local-1", logPath: "/tmp/build.log" }));
    assert.ok(!isLocalJob({ id: "run", url: "https://expo.dev/run" }));
  });

  it("checks PATH for the tools eas calls", () => {
    const bin = mkdtempSync(join(tmpdir(), "blink-tools-"));
    assert.deepEqual(missingTools({ PATH: bin }), ["xcodebuild", "fastlane", "pod"]);
    for (const tool of ["xcodebuild", "pod"]) writeFileSync(join(bin, tool), "");
    assert.deepEqual(missingTools({ PATH: `${bin}:${join(bin, "nope")}` }), ["fastlane"]);
    mkdirSync(join(bin, "more"));
    writeFileSync(join(bin, "more", "fastlane"), "");
    assert.deepEqual(missingTools({ PATH: `${bin}:${join(bin, "more")}` }), []);
    assert.deepEqual(missingTools({}), ["xcodebuild", "fastlane", "pod"]);
  });

  it("retries a quota-refused cloud build locally, with the version it was going to build", () => {
    const run: LastRun = { id: "r", workflow: "Release Native", status: "FAILURE", startedAt: null, finishedAt: null, url: "u", failedJobs: [], version: "4.1.0", buildNumber: null };
    assert.deepEqual(retryLocally(run), { kind: "release_testflight", version: "4.1.0", bumpFrom: null, where: "local" });
    assert.equal(retryLocally({ ...run, version: null }).version, null);
  });
});
