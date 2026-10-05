import { type ChoiceResponse, choice, noul, type Questions, TypeSafeClient } from "@typesafe-ai/sdk";
import type { Action } from "./actions.ts";
import { config } from "./config.ts";
import { lastWorkflowRun } from "./expo.ts";
import { listBranches } from "./github.ts";
import { channelState, planRollback, planStop } from "./ota.ts";
import { MIN_CONFIDENCE, NOT_MENTIONED, otaMessage, pickBranch, versionInText } from "./parsing.ts";
import * as replies from "./replies.ts";
import { hasExpo, hasGithub, type Project } from "./settings.ts";
import { askInThread } from "./posthog.ts";
import { planVersion } from "./version.ts";

const client = new TypeSafeClient({ apiKey: config.typesafeApiKey, defaultModel: config.jevModel });

// Jev degrades with irrelevant context, so only send the recent turns.
const MAX_TURNS = 5;

// The intent list is the same for every project, so Jev's answer doesn't depend on setup;
// unsupported commands are rejected afterwards with a clear reply.
export const INTENTS = {
  merge: 'Merge one git branch into another branch. Includes short forms that only name two branches, like "main to release" or "dev into main".',
  release_ota: "Publish a new over-the-air (OTA) update",
  rollback_ota: "Roll back, revert, or undo the latest OTA update so phones go back to the previous one",
  stop_rollout: "Stop, pause, halt, or cancel an OTA update or rollout that is in progress",
  resume_rollout: "Resume, unpause, or continue OTA updates or a rollout that was paused or stopped",
  release_testflight: "Build the iOS app and upload it to TestFlight (an iOS build)",
  release_android: "Build the Android app (an Android or Google Play build)",
  status: "Show the status of the latest build or workflow run",
  app_store_release: "Submit to the App Store, send for App Store review, or release the app to users in the App Store",
  help: "Asks what the bot can do, which commands it has, or for help",
  analytics: "A question about product analytics or usage data: users, events, signups, retention, conversion, traffic, funnels",
  unclear: "Anything else, or the request is not clear",
};
export type Intent = keyof typeof INTENTS;

const intentQuestion = () =>
  choice("What does the latest_message ask the release bot to do? Earlier messages are context only.", INTENTS);

// Questions are literal on purpose: jev-1.13 reads instructions at face value.
function buildQuestions(p: Project, branches: string[]): Questions {
  const questions: Questions = { intent: intentQuestion() };
  if (p.github) {
    const branchOptions = (role: string) => ({
      ...Object.fromEntries(branches.map((b) => [b, `The branch named exactly "${b}"`])),
      [NOT_MENTIONED]: `The messages don't name the ${role} branch`,
    });
    questions.source_branch = choice(
      'Which branch is the source of the merge? It is the FIRST branch name in the message, written before "into" or "to".',
      branchOptions("merged-from"),
    );
    questions.target_branch = choice(
      'Which branch is the destination of the merge? It is the SECOND branch name in the message, written after "into" or "to".',
      branchOptions("merged-into"),
    );
    questions.other_release_branch = noul(
      `Does the latest_message ask to release from a specific branch whose name is not "${p.github.releaseBranch}"?`,
    );
  }
  return questions;
}

// Just the command, without project details. Used to pick a project when nothing else says which.
export async function classifyIntent(history: string[], userText: string): Promise<Intent | null> {
  const turns = history.slice(-MAX_TURNS);
  const { answers } = await client.systemOne({
    state: { earlier_messages: turns.slice(0, -1), latest_message: userText },
    questions: { intent: intentQuestion() },
  });
  return answers.intent.confidence < MIN_CONFIDENCE || answers.intent.choice === "unclear" ? null : answers.intent.choice;
}

// `notUnderstood` marks replies where Jev couldn't route the request, so the caller can offer a fallback.
export type AgentResult = { text: string; actions: Action[]; notUnderstood?: boolean };

const reply = (text: string): AgentResult => ({ text, actions: [] });
const propose = (action: Action): AgentResult => ({ text: "", actions: [action] });

// Runs one user turn for a resolved project. `history` is the thread's user messages.
// Context from Slack: which thread this is (for PostHog AI follow-ups) and a way to post a quick
// "working on it" note before slow steps.
export type TurnContext = { threadKey: string; progress: (text: string) => Promise<unknown> };

export async function respond(p: Project, history: string[], userText: string, ctx: TurnContext): Promise<AgentResult> {
  const turns = history.slice(-MAX_TURNS);
  const branches = hasGithub(p) ? await listBranches(p) : [];

  const { answers } = await client.systemOne({
    state: { earlier_messages: turns.slice(0, -1), latest_message: userText },
    questions: buildQuestions(p, branches),
  });
  const intent = answers.intent as ChoiceResponse;
  const branchAnswer = (key: string) => answers[key] as ChoiceResponse | undefined;
  if (intent.confidence < MIN_CONFIDENCE) return { text: replies.notUnderstood(p), actions: [], notUnderstood: true };

  switch (intent.choice) {
    case "merge": {
      if (!hasGithub(p)) return reply(replies.notConfigured(p, "Merging"));
      const text = turns.join("\n");
      const source = branchAnswer("source_branch") && pickBranch(branchAnswer("source_branch")!, text);
      const target = branchAnswer("target_branch") && pickBranch(branchAnswer("target_branch")!, text);
      if (!source) return reply(replies.askBranch("source", branches));
      if (!target) return reply(replies.askBranch("target", branches));
      return propose({ kind: "merge", source, target });
    }

    case "status":
      if (!hasExpo(p)) return reply(replies.notConfigured(p, "Build status"));
      {
        const [run, channel] = await Promise.all([lastWorkflowRun(p), channelState(p)]);
        return reply(replies.status(p, run, channel.paused));
      }

    case "rollback_ota": {
      if (!hasExpo(p)) return reply(replies.notConfigured(p, "OTA"));
      const plan = await planRollback(p);
      if (!plan.possible) return reply(plan.reason);
      return propose({ kind: "rollback_ota", from: plan.from, to: plan.to, resume: plan.resume });
    }

    case "stop_rollout": {
      if (!hasExpo(p)) return reply(replies.notConfigured(p, "OTA"));
      const plan = await planStop(p);
      if ("nothingToStop" in plan) return reply(plan.nothingToStop);
      return propose({ kind: "stop_rollout", ...plan });
    }

    case "resume_rollout": {
      if (!hasExpo(p)) return reply(replies.notConfigured(p, "OTA"));
      if (!(await channelState(p)).paused) return reply(`*${p.expo.otaChannel}* isn't paused, so OTA updates are already being delivered.`);
      return propose({ kind: "resume_rollout" });
    }

    case "app_store_release":
      return reply(hasExpo(p) ? replies.appStoreNotSupported() : replies.notConfigured(p, "App Store releases"));

    case "release_android": {
      if (!hasExpo(p) || !p.expo.workflows.android) return reply(replies.notConfigured(p, "Android builds"));
      const otherBranch = (answers.other_release_branch as { noul: number } | undefined)?.noul ?? 0;
      if (otherBranch > 0.5) {
        const named = branchAnswer("source_branch");
        return reply(replies.releaseFromOtherBranch(p, named ? pickBranch(named, userText) : null));
      }
      return propose({ kind: "release_android" });
    }

    case "help":
      return reply(replies.help(p));

    case "analytics": {
      const { posthog } = p;
      if (!posthog) return reply(replies.notConfigured(p, "PostHog"));
      await ctx.progress(replies.askingPosthog(p));
      return reply(await askInThread({ ...p, posthog }, ctx.threadKey, userText));
    }

    case "release_ota":
    case "release_testflight": {
      const isOta = intent.choice === "release_ota";
      if (!hasExpo(p) || !(isOta ? p.expo.workflows.ota : p.expo.workflows.testflight)) {
        return reply(replies.notConfigured(p, isOta ? "OTA" : "TestFlight"));
      }
      const otherBranch = (answers.other_release_branch as { noul: number } | undefined)?.noul ?? 0;
      if (otherBranch > 0.5) {
        const named = branchAnswer("source_branch");
        return reply(replies.releaseFromOtherBranch(p, named ? pickBranch(named, userText) : null));
      }
      if (isOta) {
        if ((await channelState(p)).paused) return reply(replies.otaWhilePaused(p));
        return propose({ kind: "release_ota", message: otaMessage(userText) });
      }
      if (p.expo.versioning === "none") return propose({ kind: "release_testflight", version: null, bumpFrom: null });
      try {
        const plan = await planVersion(p, versionInText(userText));
        return propose({ kind: "release_testflight", version: plan.version, bumpFrom: plan.bumpFrom });
      } catch (err) {
        return reply(`Can't release that: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    default:
      return { text: replies.notUnderstood(p), actions: [], notUnderstood: true };
  }
}
