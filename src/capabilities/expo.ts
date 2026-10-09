import { type ChoiceResponse, noul, type Questions } from "@typesafe-ai/sdk";
import { type Capability, type Explain, isString, PROPOSED, propose, reply, tool } from "../capability.ts";
import { lastFailure, lastWorkflowRun, type LastRun, type RunFailure, runWorkflow, type StartedRun } from "../expo.ts";
import { createBranch, deleteBranch, mergeBranches, readFile, writeFile } from "../github.ts";
import { type LocalJob, startLocalBuild } from "../localbuild.ts";
import { excerpt } from "../logs.ts";
import { cancelRuns, channelState, planRollback, planStop, republish, rollBackToEmbedded, setChannelPaused, type UpdateGroup } from "../ota.ts";
import { otaMessage, pickBranch, versionInText } from "../parsing.ts";
import { type ExpoProject, type GithubProject, hasExpo, type LocalBuildSettings, type Project } from "../project.ts";
import * as replies from "../replies.ts";
import { planOtaVersion, planVersion } from "../version.ts";
import { compareVersions, countOta, readAppJsonVersion, setAppJsonVersion } from "../versioning.ts";

// Expo releases through EAS: OTA updates (publish, stop, resume, roll back), TestFlight and
// Google Play builds, and the status and logs of workflow runs. Needs the github capability,
// since everything runs from the release branch.

export type ExpoAction =
  // version is what the update will show, for projects that count OTA updates ("minor"), else null.
  | { kind: "release_ota"; message: string; version: string | null }
  // version and bumpFrom are null for projects whose workflow handles versions itself. `where` is
  // the EAS workflow ("cloud") or `eas build --local` on this machine ("local"); absent in actions
  // proposed before local builds existed, which means cloud.
  | { kind: "release_testflight"; version: string | null; bumpFrom: string | null; where?: BuildWhere }
  | { kind: "release_android" }
  | {
      kind: "rollback_ota";
      from: UpdateGroup;
      to: { kind: "update"; update: UpdateGroup } | { kind: "embedded"; runtimeVersion: string };
      resume: boolean;
    }
  | { kind: "stop_rollout"; cancelRunIds: string[]; pause: boolean }
  | { kind: "resume_rollout" };

export type BuildWhere = "cloud" | "local";

const shortGroup = (u: UpdateGroup) => `${u.message} \`${u.group.slice(0, 8)}\``;

function expoOf(p: Project): ExpoProject {
  if (!hasExpo(p)) throw new Error(`Expo isn't set up for ${p.name}`);
  return p;
}

const withOta = (p: Project) => hasExpo(p) && Boolean(p.expo.workflows.ota);
// TestFlight needs a way to build: the EAS workflow, a local build on this machine, or both.
const withTestflight = (p: Project) => hasExpo(p) && Boolean(p.expo.workflows.testflight || p.expo.localBuild);
const withAndroid = (p: Project) => hasExpo(p) && Boolean(p.expo.workflows.android);

// Where a TestFlight build runs: on this machine when asked for (and set up), else the EAS
// workflow, else locally because that's all there is. A string is the reply when it can't be done.
export function chooseWhere(p: ExpoProject, wantsLocal: boolean): BuildWhere | string {
  const { workflows, localBuild } = p.expo;
  if (wantsLocal) {
    if (localBuild) return "local";
    return `Building on this machine isn't set up for *${p.name}* (\`expo.localBuild\`).${workflows.testflight ? " I can build on EAS instead: say _release to TestFlight_." : ""}`;
  }
  if (workflows.testflight) return "cloud";
  if (localBuild) return "local";
  return `TestFlight isn't set up for *${p.name}*.`;
}

const whereOf = (action: { where?: BuildWhere }): BuildWhere => action.where ?? "cloud";

const OPENAI_LOG_LINES = 80;

// A failed run for OpenAI to explain, with more of the log than Slack shows.
const explainFailure = (run: LastRun, failure: RunFailure): Explain => ({
  context:
    `The user is asking why this EAS workflow run failed. Explain the likely cause and how to fix it, briefly.\n` +
    `Workflow: ${run.workflow}\nFailed job: ${failure.job}\nFailed step: ${failure.step}\nRun: ${run.url}\n` +
    `End of the step's log:\n${excerpt(failure.lines, OPENAI_LOG_LINES).join("\n")}`,
});

async function commitVersion(p: GithubProject, branch: string, version: string): Promise<boolean> {
  const appJson = await readFile(p, "app.json", branch);
  if (compareVersions(readAppJsonVersion(appJson.content), version) >= 0) return false;
  await writeFile(p, "app.json", branch, setAppJsonVersion(appJson.content, version), appJson.sha, `Bump version to ${version}`);
  return true;
}

// Keeps main in step with release so the next merge doesn't bring the old version back into view.
async function bumpMain(p: GithubProject, version: string): Promise<string> {
  const branch = `blink/version-${version}`;
  await createBranch(p, branch, "main");
  if (!(await commitVersion(p, branch, version))) {
    await deleteBranch(p, branch);
    return `\`main\` is already on ${version} or later.`;
  }
  const result = await mergeBranches(p, branch, "main");
  if (result.outcome === "needs_attention") return `Couldn't bump \`main\` (${result.reason}). <${result.prUrl}|PR>`;
  await deleteBranch(p, branch);
  return `\`main\` bumped to ${version}.`;
}

export const expo: Capability = {
  id: "expo",

  parseSettings(raw, { problems, where, secret }) {
    if (!raw.expo) return {};
    if (!raw.github) problems.push(`${where}: "expo" also needs a "github" block`);
    if (!isString(raw.expo.iosBundleId)) problems.push(`${where}: "expo.iosBundleId" is required`);
    const versioning = raw.expo.versioning ?? "app-json";
    if (!["app-json", "minor", "none"].includes(versioning)) problems.push(`${where}: "expo.versioning" must be "app-json", "minor" or "none"`);
    if (raw.expo.installScripts !== undefined && typeof raw.expo.installScripts !== "boolean") problems.push(`${where}: "expo.installScripts" must be true or false`);
    // Off unless asked for: `true` for the defaults, or a block with the profile and extra env.
    let localBuild: LocalBuildSettings | null = null;
    const rawLocal = raw.expo.localBuild;
    if (rawLocal === true) localBuild = { profile: "production", env: {} };
    else if (rawLocal && typeof rawLocal === "object" && !Array.isArray(rawLocal)) {
      if (rawLocal.profile !== undefined && !isString(rawLocal.profile)) problems.push(`${where}: "expo.localBuild.profile" must be a build profile name from eas.json`);
      const env = rawLocal.env ?? {};
      if (typeof env !== "object" || Array.isArray(env) || Object.values(env).some((v) => typeof v !== "string")) {
        problems.push(`${where}: "expo.localBuild.env" must be an object of string values`);
      }
      localBuild = { profile: isString(rawLocal.profile) ? rawLocal.profile : "production", env: typeof env === "object" && !Array.isArray(env) ? env : {} };
    } else if (rawLocal !== undefined && rawLocal !== false) problems.push(`${where}: "expo.localBuild" must be true, false or { "profile", "env" }`);
    const workflow = (key: "ota" | "testflight" | "android", fallback: string | null) =>
      raw.expo.workflows && key in raw.expo.workflows ? (isString(raw.expo.workflows[key]) ? raw.expo.workflows[key] : null) : fallback;
    return {
      expo: {
        iosBundleId: raw.expo.iosBundleId ?? "",
        otaChannel: isString(raw.expo.otaChannel) ? raw.expo.otaChannel : "production",
        // Android is opt-in, since older configs predate it and their repos may not have the file.
        workflows: {
          ota: workflow("ota", "ota-production.yml"),
          testflight: workflow("testflight", "release-native.yml"),
          android: workflow("android", null),
        },
        token: secret(isString(raw.expo.tokenEnv) ? raw.expo.tokenEnv : "EXPO_TOKEN", `${where} expo`),
        versioning,
        repoDir: isString(raw.expo.repoDir) ? raw.expo.repoDir : `.repos/${raw.id}`,
        installScripts: raw.expo.installScripts === true,
        localBuild,
      },
    };
  },

  intents: {
    release_ota: { description: "Publish a new over-the-air (OTA) update", label: "OTA", supports: withOta },
    rollback_ota: { description: "Roll back, revert, or undo the latest OTA update so phones go back to the previous one", label: "OTA", supports: hasExpo },
    stop_rollout: { description: "Stop, pause, halt, or cancel an OTA update or rollout that is in progress", label: "OTA", supports: hasExpo },
    resume_rollout: { description: "Resume, unpause, or continue OTA updates or a rollout that was paused or stopped", label: "OTA", supports: hasExpo },
    release_testflight: { description: "Build the iOS app and upload it to TestFlight (an iOS build)", label: "TestFlight", supports: withTestflight },
    release_android: { description: "Build the Android app and upload it to Google Play (an Android build)", label: "Android releases", supports: withAndroid },
    status: { description: "Show the status of the latest build or workflow run", label: "Build status", supports: hasExpo },
    explain_failure: { description: "Asks why a build, release or workflow run failed, what its error was, or to see its logs", label: "Build status", supports: hasExpo },
    app_store_release: {
      description: "Submit to the App Store, send for App Store review, or release the app to users in the App Store",
      label: "App Store releases",
      supports: hasExpo,
    },
  },

  questions(p) {
    const questions: Questions = {};
    if (hasExpo(p)) {
      questions.other_release_branch = noul(`Does the latest_message ask to release from a specific branch whose name is not "${p.github.releaseBranch}"?`);
      if (p.expo.localBuild) {
        questions.build_locally = noul("Does the latest_message ask to build locally, on this machine or Mac, or without using EAS cloud builds or their quota?");
      }
    }
    return questions;
  },

  async respond(project, intent, { answers, userText, ctx }) {
    const p = expoOf(project);
    // Releases run from the release branch; asking for another one gets an offer to merge it first.
    const otherBranch = (answers.other_release_branch as { noul: number } | undefined)?.noul ?? 0;
    const releaseFromOtherBranch = () => {
      const named = answers.source_branch as ChoiceResponse | undefined;
      return reply(replies.releaseFromOtherBranch(p, named ? pickBranch(named, userText) : null));
    };

    switch (intent) {
      case "status": {
        const [run, channel] = await Promise.all([lastWorkflowRun(p), channelState(p)]);
        return reply(replies.status(p, run, channel.paused));
      }
      case "explain_failure": {
        const found = await lastFailure(p, ctx.threadRunId);
        const { failed, failure } = found;
        return { text: replies.lastFailure(found), actions: [], explain: failed && failure ? explainFailure(failed, failure) : undefined };
      }
      case "rollback_ota": {
        const plan = await planRollback(p);
        if (!plan.possible) return reply(plan.reason);
        return propose({ kind: "rollback_ota", from: plan.from, to: plan.to, resume: plan.resume });
      }
      case "stop_rollout": {
        const plan = await planStop(p);
        if ("nothingToStop" in plan) return reply(plan.nothingToStop);
        return propose({ kind: "stop_rollout", ...plan });
      }
      case "resume_rollout":
        if (!(await channelState(p)).paused) return reply(`*${p.expo.otaChannel}* isn't paused, so OTA updates are already being delivered.`);
        return propose({ kind: "resume_rollout" });
      case "app_store_release":
        return reply(replies.appStoreNotSupported());
      case "release_android":
        if (otherBranch > 0.5) return releaseFromOtherBranch();
        return propose({ kind: "release_android" });
      case "release_ota":
        if (otherBranch > 0.5) return releaseFromOtherBranch();
        if ((await channelState(p)).paused) return reply(replies.otaWhilePaused(p));
        return propose({ kind: "release_ota", message: otaMessage(userText), version: await planOtaVersion(p) });
      case "release_testflight": {
        if (otherBranch > 0.5) return releaseFromOtherBranch();
        const wantsLocal = ((answers.build_locally as { noul: number } | undefined)?.noul ?? 0) > 0.5;
        const where = chooseWhere(p, wantsLocal);
        if (where !== "cloud" && where !== "local") return reply(where);
        if (p.expo.versioning === "none") return propose({ kind: "release_testflight", version: null, bumpFrom: null, where });
        try {
          const plan = await planVersion(p, versionInText(userText));
          return propose({ kind: "release_testflight", version: plan.version, bumpFrom: plan.bumpFrom, where });
        } catch (err) {
          return reply(`Can't release that: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      default:
        throw new Error(`Expo doesn't handle ${intent}`);
    }
  },

  actions: {
    release_ota: {
      release: true,
      describe(p, action: ExpoAction & { kind: "release_ota" }) {
        const branch = p.github?.releaseBranch ?? "release";
        const channel = p.expo?.otaChannel ?? "production";
        return `Publish an OTA update${action.version ? ` *${action.version}*` : ""} from \`${branch}\` to the *${channel}* channel\n> ${action.message}`;
      },
      async execute(project, action: ExpoAction & { kind: "release_ota" }) {
        const p = expoOf(project);
        if (!p.expo.workflows.ota) throw new Error(`OTA isn't set up for ${p.name}`);
        const branch = p.github.releaseBranch;
        let message = action.message;
        if (action.version) {
          // Count the update on the release branch first, so the published app.json shows it.
          const appJson = await readFile(p, "app.json", branch);
          const counted = countOta(appJson.content);
          if (counted.version !== action.version) throw new Error(`The next OTA on \`${branch}\` is now ${counted.version}, not ${action.version}. Ask me again.`);
          await writeFile(p, "app.json", branch, counted.content, appJson.sha, `OTA ${action.version} — ${action.message}`);
          message = `${action.version} — ${action.message}`;
        }
        const started = await runWorkflow(p, p.expo.workflows.ota, { message });
        return { text: `OTA${action.version ? ` ${action.version}` : ""} workflow started from \`${branch}\`. <${started.url}|View run>`, watch: started };
      },
    },

    release_testflight: {
      release: true,
      describe(p, action: ExpoAction & { kind: "release_testflight" }) {
        const branch = p.github?.releaseBranch ?? "release";
        const local = whereOf(action) === "local" ? " locally on this Mac" : "";
        if (!action.version) return `Build iOS from \`${branch}\`${local} and upload it to TestFlight`;
        return action.bumpFrom
          ? `Bump the version ${action.bumpFrom} → *${action.version}* on \`${branch}\`${branch === "main" ? "" : " (and \`main\` via PR)"}, then build iOS${local} and upload it to TestFlight`
          : `Build iOS *${action.version}* from \`${branch}\`${local} and upload it to TestFlight`;
      },
      async execute(project, action: ExpoAction & { kind: "release_testflight" }) {
        const p = expoOf(project);
        const where = whereOf(action);
        if (where === "cloud" && !p.expo.workflows.testflight) throw new Error(`TestFlight isn't set up for ${p.name}`);
        if (where === "local" && !p.expo.localBuild) throw new Error(`Local builds aren't set up for ${p.name}`);
        const branch = p.github.releaseBranch;
        const lines: string[] = [];
        if (action.version && action.bumpFrom) {
          const current = readAppJsonVersion((await readFile(p, "app.json", branch)).content);
          if (current !== action.bumpFrom && current !== action.version) {
            throw new Error(`app.json on \`${branch}\` changed to ${current} since you asked. Ask me again.`);
          }
          await commitVersion(p, branch, action.version);
          lines.push(`Bumped \`${branch}\` to ${action.version}.`);
        }
        const version = action.version ? ` ${action.version}` : "";
        let watch: StartedRun | LocalJob;
        if (where === "local") {
          watch = await startLocalBuild(p, action.version);
          lines.push(`iOS${version} is building on this Mac, then uploading to TestFlight. That usually takes 5–15 minutes; I'll post here when it's done. Log: \`${watch.logPath}\``);
        } else {
          watch = await runWorkflow(p, p.expo.workflows.testflight!);
          lines.push(`iOS${version} build + TestFlight upload started. <${watch.url}|View run>`);
        }
        // Also when release was bumped by an earlier attempt whose build failed to start.
        if (action.version && branch !== "main") lines.push(await bumpMain(p, action.version).catch((err) => `Couldn't bump \`main\`: ${String(err)}`));
        return { text: lines.join("\n"), watch };
      },
    },

    release_android: {
      release: true,
      describe: (p) => `Build Android from \`${p.github?.releaseBranch ?? "release"}\` and upload it to Google Play`,
      async execute(project) {
        const p = expoOf(project);
        if (!p.expo.workflows.android) throw new Error(`Android releases aren't set up for ${p.name}`);
        const started = await runWorkflow(p, p.expo.workflows.android);
        return { text: `Android build + Google Play upload started from \`${p.github.releaseBranch}\`. <${started.url}|View run>`, watch: started };
      },
    },

    rollback_ota: {
      describe(p, action: ExpoAction & { kind: "rollback_ota" }) {
        const channel = p.expo?.otaChannel ?? "production";
        const to = action.to.kind === "update" ? `the previous update ${shortGroup(action.to.update)}` : "the code in the store build (no earlier update for this runtime)";
        return `Roll back *${channel}* from ${shortGroup(action.from)} to ${to}${action.resume ? ", and resume the paused channel so phones receive it" : ""}`;
      },
      async execute(project, action: ExpoAction & { kind: "rollback_ota" }) {
        const p = expoOf(project);
        const message = `Roll back from ${action.from.group.slice(0, 8)} (via Slack)`;
        if (action.to.kind === "update") await republish(p, action.to.update.group, message);
        else await rollBackToEmbedded(p, action.to.runtimeVersion, message);
        if (action.resume) await setChannelPaused(p, false);
        return `Rolled back *${p.expo.otaChannel}*${action.to.kind === "update" ? ` to ${shortGroup(action.to.update)}` : " to the store build's code"}. Phones switch on their next app launch.${action.resume ? " Channel resumed." : ""}`;
      },
    },

    stop_rollout: {
      describe(p, action: ExpoAction & { kind: "stop_rollout" }) {
        const channel = p.expo?.otaChannel ?? "production";
        const steps = [
          action.cancelRunIds.length ? `cancel the running OTA workflow before it publishes` : null,
          action.pause ? `pause the *${channel}* channel so phones that don't have the latest update yet won't get it` : null,
        ].filter(Boolean);
        return `Stop the OTA rollout: ${steps.join(", and ")}. Phones that already downloaded it keep it (use _roll back the OTA_ for those).`;
      },
      async execute(project, action: ExpoAction & { kind: "stop_rollout" }) {
        const p = expoOf(project);
        if (action.cancelRunIds.length) await cancelRuns(p, action.cancelRunIds);
        if (action.pause) await setChannelPaused(p, true);
        return `Stopped.${action.cancelRunIds.length ? " Running OTA workflow canceled." : ""}${action.pause ? ` *${p.expo.otaChannel}* is paused; say _resume rollout_ to start sending updates again.` : ""}`;
      },
    },

    resume_rollout: {
      describe: (p) => `Resume the *${p.expo?.otaChannel ?? "production"}* channel so phones start receiving OTA updates again`,
      async execute(project) {
        const p = expoOf(project);
        await setChannelPaused(p, false);
        return `*${p.expo.otaChannel}* resumed. Phones will receive OTA updates again.`;
      },
    },
  },

  tools(project) {
    if (!hasExpo(project)) return [];
    const p = project;
    const { releaseBranch } = p.github;
    const { otaChannel, workflows, localBuild } = p.expo;
    const tools: ReturnType<Capability["tools"]> = [];

    if (workflows.ota) {
      tools.push({
        definition: tool("release_ota", `Propose publishing an OTA update from ${releaseBranch} to ${otaChannel}. The user must confirm.`, {
          type: "object",
          properties: { message: { type: "string", description: "Short update message. Use 'OTA update' if none was given." } },
          required: ["message"],
          additionalProperties: false,
        }),
        ability: `- release_ota: publish an over-the-air update from "${releaseBranch}" to the "${otaChannel}" channel.`,
        async run(_p, input) {
          if ((await channelState(p)).paused) return { result: `${otaChannel} is paused; a new OTA wouldn't reach anyone. Tell the user to resume rollout first.` };
          return { result: PROPOSED, action: { kind: "release_ota", message: (input.message as string) || "OTA update", version: await planOtaVersion(p) } };
        },
      });
    }
    if (workflows.testflight || localBuild) {
      const properties: Record<string, unknown> = { version: { type: ["string", "null"], description: "Version the user asked for, like 1.2.0, or null to pick automatically." } };
      if (localBuild) {
        properties.where = {
          type: "string",
          enum: ["cloud", "local"],
          description: 'Where to build: "local" only if the user asks to build locally / on this Mac / without EAS cloud builds, else "cloud".',
        };
      }
      tools.push({
        definition: tool("release_testflight", `Propose building iOS from ${releaseBranch} and uploading it to TestFlight. The user must confirm.`, {
          type: "object",
          properties,
          required: Object.keys(properties),
          additionalProperties: false,
        }),
        ability:
          `- release_testflight: build iOS from "${releaseBranch}" and upload it to TestFlight` +
          (localBuild ? ` (on EAS, or locally on this machine when asked, e.g. because the EAS quota is used up).` : "."),
        async run(_p, input) {
          const where = chooseWhere(p, input.where === "local");
          if (where !== "cloud" && where !== "local") return { result: where };
          if (p.expo.versioning === "none") return { result: PROPOSED, action: { kind: "release_testflight", version: null, bumpFrom: null, where } };
          const plan = await planVersion(p, (input.version as string | null) || null);
          return {
            result: `${PROPOSED} Version ${plan.version}${plan.bumpFrom ? ` (bumping from ${plan.bumpFrom})` : ""}${where === "local" ? ", building on this machine" : ""}.`,
            action: { kind: "release_testflight", version: plan.version, bumpFrom: plan.bumpFrom, where },
          };
        },
      });
    }
    if (workflows.android) {
      tools.push({
        definition: tool("release_android", `Propose building Android from ${releaseBranch} and uploading it to Google Play. The user must confirm.`),
        ability: `- release_android: build Android from "${releaseBranch}" and upload it to Google Play.`,
        run: async () => ({ result: PROPOSED, action: { kind: "release_android" } }),
      });
    }
    tools.push(
      {
        definition: tool("rollback_ota", `Propose rolling ${otaChannel} back to the previous OTA update. The user must confirm.`),
        ability: `- rollback_ota: roll "${otaChannel}" back to the previous OTA update (or the store build's code if there is none).`,
        async run() {
          const plan = await planRollback(p);
          if (!plan.possible) return { result: plan.reason };
          return { result: PROPOSED, action: { kind: "rollback_ota", from: plan.from, to: plan.to, resume: plan.resume } };
        },
      },
      {
        definition: tool("stop_rollout", `Propose stopping the OTA rollout (cancel a running OTA workflow, pause ${otaChannel}). The user must confirm.`),
        ability: `- stop_rollout: cancel a running OTA workflow and pause the "${otaChannel}" channel.`,
        async run() {
          const plan = await planStop(p);
          if ("nothingToStop" in plan) return { result: plan.nothingToStop };
          return { result: PROPOSED, action: { kind: "stop_rollout", ...plan } };
        },
      },
      {
        definition: tool("resume_rollout", `Propose resuming the paused ${otaChannel} channel. The user must confirm.`),
        ability: `- resume_rollout: resume the paused "${otaChannel}" channel.`,
        async run() {
          if (!(await channelState(p)).paused) return { result: `${otaChannel} isn't paused.` };
          return { result: PROPOSED, action: { kind: "resume_rollout" } };
        },
      },
      {
        definition: tool("status", `The latest EAS workflow run and whether ${otaChannel} is paused.`),
        ability: `- status: the latest EAS workflow run and whether "${otaChannel}" is paused.`,
        async run() {
          const [run, channel] = await Promise.all([lastWorkflowRun(p), channelState(p)]);
          return { result: JSON.stringify({ latestRun: run, channelPaused: channel.paused }) };
        },
      },
      {
        definition: tool("last_failure", "The latest failed EAS workflow run: the failed job and step, and the end of that step's log."),
        ability: `- last_failure: why the latest failed workflow run failed, from its logs.`,
        async run(_p, _input, { threadRunId }) {
          const found = await lastFailure(p, threadRunId);
          return { result: found.failed && found.failure ? explainFailure(found.failed, found.failure).context : replies.lastFailure(found) };
        },
      },
    );
    return tools;
  },

  rules(p) {
    if (!hasExpo(p)) return [];
    return [
      `- Releases always run from the "${p.github.releaseBranch}" branch. If asked to release from another branch, explain that and offer to merge it into "${p.github.releaseBranch}" first.`,
      "- OTA updates are iOS only. Releasing to the App Store (submitting for review or to users) is not supported yet; say so.",
      ...(p.expo.localBuild
        ? [`- TestFlight builds run on EAS unless the user asks to build locally (on this machine / Mac), which avoids the EAS cloud build quota.`]
        : []),
    ];
  },

  help(p) {
    if (!hasExpo(p)) return [];
    const lines: string[] = [];
    if (p.expo.workflows.ota) lines.push(`• *release an OTA* update to ${p.expo.otaChannel}`);
    lines.push(`• *roll back the OTA*, *stop rollout* (pause OTA delivery), *resume rollout*`);
    if (p.expo.workflows.testflight || p.expo.localBuild) {
      const version = p.expo.versioning !== "none" ? "optionally with a version, e.g. _ship 1.1.0 to TestFlight_" : "";
      const local = p.expo.localBuild && p.expo.workflows.testflight ? "add _locally_ to build on this Mac when the EAS quota is used up" : "";
      const notes = [version, local].filter(Boolean).join("; ");
      lines.push(`• *release to TestFlight*${p.expo.localBuild && !p.expo.workflows.testflight ? " (built on this Mac)" : ""}${notes ? ` (${notes})` : ""}`);
    }
    if (p.expo.workflows.android) lines.push(`• *release Android* (build and upload to Google Play)`);
    lines.push(`• show *status*, or *why the last build failed*`);
    return lines;
  },
};
