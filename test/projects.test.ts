import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { pickByCapability, resolveProject } from "../src/projects.ts";
import type { Project } from "../src/settings.ts";

const project = (id: string, name: string, slackChannels: string[] = [], aliases: string[] = []): Project => ({
  id,
  name,
  aliases: [id, name, ...aliases],
  slackChannels,
});

const myapp = project("myapp", "MyApp", ["C0MYAPP", "#myapp-releases"], ["my cool app"]);
const web = project("web", "Website", ["web-releases"]);
const projects = [myapp, web];

const resolve = (args: Partial<Parameters<typeof resolveProject>[0]>) =>
  resolveProject({ projects, channelId: "CGENERAL", channelName: "general", text: "status", threadProjectId: null, ...args });

describe("resolveProject", () => {
  it("1. uses the channel, by ID or by name (with or without #)", () => {
    assert.deepEqual(resolve({ channelId: "C0MYAPP" }), { project: myapp, via: "channel" });
    assert.deepEqual(resolve({ channelName: "myapp-releases" }), { project: myapp, via: "channel" });
    assert.deepEqual(resolve({ channelName: "Web-Releases" }), { project: web, via: "channel" });
  });

  it("the channel wins over a project named in the message", () => {
    assert.deepEqual(resolve({ channelId: "C0MYAPP", text: "status of website" }), { project: myapp, via: "channel" });
  });

  it("2. uses a project named in the message, including aliases", () => {
    assert.deepEqual(resolve({ text: "release myapp to testflight" }), { project: myapp, via: "message" });
    assert.deepEqual(resolve({ text: "how is My Cool App doing" }), { project: myapp, via: "message" });
    assert.deepEqual(resolve({ text: "merge main into release on website" }), { project: web, via: "message" });
  });

  it("the message wins over the thread, so you can switch projects mid-thread", () => {
    assert.deepEqual(resolve({ text: "now the website", threadProjectId: "myapp" }), { project: web, via: "message" });
  });

  it("doesn't match a project name inside another word", () => {
    assert.deepEqual(resolve({ text: "the webhook failed" }), { ask: projects });
  });

  it("asks when the message names more than one project", () => {
    assert.deepEqual(resolve({ text: "status of myapp and website" }), { ask: [myapp, web] });
  });

  it("leaves the thread and capabilities to pickByCapability", () => {
    assert.deepEqual(resolve({ text: "and roll it back", threadProjectId: "web" }), { ask: projects });
  });

  it("asks when nothing identifies the project", () => {
    assert.deepEqual(resolve({ text: "release an OTA" }), { ask: projects });
  });

  it("doesn't ask when there's only one project", () => {
    assert.deepEqual(resolveProject({ projects: [myapp], channelId: "C1", channelName: null, text: "status", threadProjectId: null }), {
      project: myapp,
      via: "only",
    });
  });
});

describe("pickByCapability", () => {
  const app: Project = {
    ...project("myapp", "MyApp"),
    github: { owner: "a", repo: "myapp", releaseBranch: "release" },
    expo: { iosBundleId: "x", otaChannel: "production", workflows: { ota: "ota.yml", testflight: "tf.yml", android: null }, token: "t", versioning: "app-json", repoDir: "r" },
  };
  const gems: Project = {
    ...project("pmgems", "PMGems"),
    github: { owner: "a", repo: "gems", releaseBranch: "main" },
    posthog: { host: "h", projectId: "1", apiKey: "k" },
  };
  const all = [app, gems];

  it("sends a release to the only project with Expo", () => {
    assert.equal(pickByCapability(all, "release_testflight", null), app);
    assert.equal(pickByCapability(all, "status", null), app);
  });

  it("only sends an Android build to a project with the Android workflow", () => {
    assert.equal(pickByCapability(all, "release_android", null), null);
    const withAndroid: Project = { ...app, expo: { ...app.expo!, workflows: { ...app.expo!.workflows, android: "android.yml" } } };
    assert.equal(pickByCapability([withAndroid, gems], "release_android", "pmgems"), withAndroid);
  });

  it("sends an analytics question to the only project with PostHog", () => {
    assert.equal(pickByCapability(all, "analytics", null), gems);
  });

  it("keeps the thread's project when it can do the request", () => {
    assert.equal(pickByCapability(all, "merge", "pmgems"), gems);
  });

  it("switches away from the thread's project when only another can do it", () => {
    assert.equal(pickByCapability(all, "release_ota", "pmgems"), app);
  });

  it("returns null (ask) when several or no projects can, or the intent is unknown", () => {
    assert.equal(pickByCapability(all, "merge", null), null);
    assert.equal(pickByCapability([gems], "release_testflight", null), null);
    assert.equal(pickByCapability(all, null, "myapp"), null);
  });
});
