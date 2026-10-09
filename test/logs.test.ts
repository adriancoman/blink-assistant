import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { excerpt, failureInLogs, type JobLogs, LOCAL_STEP_HEADER, parseLocalBuildLog, quotaExceeded } from "../src/logs.ts";

describe("a cloud build refused for the month's quota", () => {
  it("is recognized from EAS's message, and nothing else", () => {
    assert.ok(quotaExceeded(["Build request failed.", "This account has used its iOS builds from the Free plan this month."]));
    assert.ok(quotaExceeded(["Error: This account has used its builds from the free plan this month"]));
    assert.ok(!quotaExceeded(["Build failed: xcodebuild exited with code 65"]));
    assert.ok(!quotaExceeded([]));
  });
});

describe("a local build's log", () => {
  const log = [
    `${LOCAL_STEP_HEADER}eas build (local)`,
    "\u001b[32m✔\u001b[39m Incremented buildNumber from \u001b[1m41\u001b[22m to \u001b[1m42\u001b[22m.",
    "Building project",
    "",
    "[12:01:05]: fastlane gym finished",
    `${LOCAL_STEP_HEADER}eas submit`,
    "Scheduling iOS submission",
    "- When it's done, you can see your build here: https://appstoreconnect.apple.com/apps/1459746036/testflight/ios",
    "",
  ].join("\n");

  it("splits into the two commands, without color codes, timestamps or blank lines", () => {
    const parsed = parseLocalBuildLog(log);
    assert.deepEqual(
      parsed.steps.map((s) => s.step),
      ["eas build (local)", "eas submit"],
    );
    assert.deepEqual(parsed.steps[0].lines, ["✔ Incremented buildNumber from 41 to 42.", "Building project", "fastlane gym finished"]);
    assert.equal(parsed.steps[1].lines.length, 2);
  });

  it("finds the build number EAS assigned and the TestFlight page", () => {
    const parsed = parseLocalBuildLog(log);
    assert.equal(parsed.buildNumber, "42");
    assert.equal(parsed.testflightUrl, "https://appstoreconnect.apple.com/apps/1459746036/testflight/ios");
  });

  it("copes with an empty log and lines before the first command", () => {
    assert.deepEqual(parseLocalBuildLog(""), { steps: [], buildNumber: null, testflightUrl: null });
    assert.deepEqual(parseLocalBuildLog("stray line\n").steps, []);
  });
});

// Shaped like `eas workflow:logs <jobId> --json` output from real failed runs.
const shellExit = (step: string) => ({
  msg: `/bin/bash -eo pipefail /tmp/eas-build/abc/steps/${step}/scripts/def.sh exited with non-zero code: 1`,
  err: { message: "…" },
});

const submitJob: JobLogs = {
  SPIN_UP_BUILDER: [
    { msg: "Builder is ready, starting build" },
    { msg: "End phase: SPIN_UP_BUILDER", marker: "END_PHASE", result: "success" },
  ],
  "step-001": [
    { msg: 'Executing build step "Checkout"', marker: "start-step" },
    { msg: 'Finished build step "Checkout" successfully', marker: "end-step", result: "success" },
  ],
  prepare_asc_api_key: [
    { msg: 'Executing build step "Prepare credentials"', marker: "start-step" },
    { msg: 'eas-cli failed to resolve submission config. Add EXPO_DEBUG: "1" to the job env to see the error.' },
    shellExit("prepare_asc_api_key"),
    { msg: 'Build step "Prepare credentials" failed', marker: "end-step", result: "fail" },
  ],
  "step-005": [
    { msg: 'Executing build step "${this.displayName}"', marker: "start-step" },
    { msg: 'Skipped build step "Submit"', marker: "end-step", result: "skipped" },
  ],
};

const buildJob: JobLogs = {
  RUN_FASTLANE: [
    { msg: "Start phase: RUN_FASTLANE", marker: "START_PHASE" },
    { msg: "** ARCHIVE SUCCEEDED **" },
    { msg: "End phase: RUN_FASTLANE", marker: "END_PHASE", result: "success" },
  ],
  UPLOAD_APPLICATION_ARCHIVE: [
    { msg: "Start phase: UPLOAD_APPLICATION_ARCHIVE", marker: "START_PHASE" },
    { msg: "Uploading application archive..." },
    { msg: "Upload to upload session failed", err: { message: "Upload to upload session failed" } },
    { msg: "Error: Failed to upload application archive." },
    { msg: "End phase: UPLOAD_APPLICATION_ARCHIVE", marker: "END_PHASE", result: "failed" },
  ],
  FAIL_BUILD: [
    { msg: "Start phase: FAIL_BUILD", marker: "START_PHASE" },
    { msg: "Build failed", err: { message: "Build failed" } },
    { msg: "End phase: FAIL_BUILD", marker: "END_PHASE", result: "failed" },
  ],
};

describe("failureInLogs", () => {
  it("finds the failed custom step by its name, without markers or the shell wrapper's error", () => {
    assert.deepEqual(failureInLogs(submitJob), {
      step: "Prepare credentials",
      lines: ['eas-cli failed to resolve submission config. Add EXPO_DEBUG: "1" to the job env to see the error.'],
    });
  });

  it("finds the failed build phase, not the generic FAIL_BUILD one", () => {
    assert.deepEqual(failureInLogs(buildJob), {
      step: "upload application archive",
      lines: ["Uploading application archive...", "Upload to upload session failed", "Error: Failed to upload application archive."],
    });
  });

  it("drops color codes and fastlane's timestamps", () => {
    const found = failureInLogs({
      submit: [
        { msg: "[23:00:21]: \u001b[33m[altool] UPLOAD FAILED with 2 errors" },
        { msg: "\u001b[0m" },
        { msg: "End phase: SUBMIT", marker: "END_PHASE", result: "failed" },
      ],
    });
    assert.deepEqual(found?.lines, ["[altool] UPLOAD FAILED with 2 errors"]);
  });

  it("drops stack frames and shortens long step names", () => {
    const step = `echo "No production build matches this fingerprint. Ship a native release instead." >&2`;
    const found = failureInLogs({
      "step-001": [
        { msg: `Executing build step "${step}"`, marker: "start-step" },
        { msg: "Error: spawnSync eas ENOENT" },
        { msg: "    at Object.spawnSync (node:internal/child_process:1123:20)" },
        shellExit("step-001"),
        { msg: `Build step "${step}" failed`, marker: "end-step", result: "fail" },
      ],
    });
    assert.equal(found?.step.length, 60);
    assert.ok(found?.step.endsWith("…"));
    assert.deepEqual(found?.lines, ["Error: spawnSync eas ENOENT"]);
  });

  it("is null when no step failed", () => {
    assert.equal(failureInLogs({ "step-001": submitJob["step-001"] }), null);
  });
});

describe("excerpt", () => {
  const dump = Array.from({ length: 20 }, (_, i) => `  detail ${i}`);

  it("keeps the last lines when there's no error line", () => {
    assert.deepEqual(excerpt(["a", "b", "c"], 2), ["b", "c"]);
  });

  it("starts at the first error line, so output after the error doesn't push it out", () => {
    const lines = ["Uploading", "[altool] UPLOAD FAILED with 2 errors", "[altool] Invalid Version", ...dump, "[!] Error uploading ipa file:"];
    assert.deepEqual(excerpt(lines, 3), ["[altool] UPLOAD FAILED with 2 errors", "[altool] Invalid Version", "  detail 0"]);
  });

  it("shows the lines before an error near the end", () => {
    assert.deepEqual(excerpt([...dump, "Error: Failed to upload application archive."], 3), ["  detail 18", "  detail 19", "Error: Failed to upload application archive."]);
  });

  it("ignores indented lines that only mention errors", () => {
    assert.deepEqual(excerpt(["    throw error;", ...dump], 3), dump.slice(-3));
  });
});
