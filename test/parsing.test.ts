import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mentioned, NOT_MENTIONED, otaMessage, pickBranch, versionInText } from "../src/parsing.ts";

describe("mentioned", () => {
  it("finds a branch name as a whole word", () => {
    assert.ok(mentioned("main", "merge main into release"));
    assert.ok(mentioned("feature/new-onboarding", "merge feature/new-onboarding into main"));
    assert.ok(mentioned("release", "Release"));
  });

  it("doesn't match a branch name inside another one", () => {
    assert.ok(!mentioned("main", "merge mainline into release"));
    assert.ok(!mentioned("creionel", "merge creionel_v3 into main"));
    assert.ok(!mentioned("release", "merge main into release-candidate"));
  });

  it("treats regex characters in branch names literally", () => {
    assert.ok(mentioned("v1.2", "merge v1.2 into main"));
    assert.ok(!mentioned("v1.2", "merge v1x2 into main"));
  });
});

describe("pickBranch", () => {
  const text = "main to release";

  it("accepts a confident pick that appears in the message", () => {
    assert.equal(pickBranch({ choice: "main", confidence: 0.94 }, text), "main");
  });

  it("rejects low confidence", () => assert.equal(pickBranch({ choice: "main", confidence: 0.4 }, text), null));

  it("rejects a branch the user never wrote", () => {
    assert.equal(pickBranch({ choice: "android-parity", confidence: 0.99 }, text), null);
  });

  it("rejects 'not mentioned'", () => assert.equal(pickBranch({ choice: NOT_MENTIONED, confidence: 0.99 }, text), null));
});

describe("versionInText / otaMessage", () => {
  it("reads a version", () => assert.equal(versionInText("ship 4.1.0 to testflight"), "4.1.0"));
  it("returns null without a version", () => assert.equal(versionInText("release to testflight"), null));
  it("uses quoted text as the OTA message", () => assert.equal(otaMessage('push an ota "fix the stars animation"'), "fix the stars animation"));
  it("accepts curly quotes", () => assert.equal(otaMessage("push an ota “fix stars”"), "fix stars"));
  it("defaults the OTA message", () => assert.equal(otaMessage("release an OTA"), "OTA update"));
});
