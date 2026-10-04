import { choice, noul, TypeSafeClient } from "@typesafe-ai/sdk";
import type { Action } from "./actions.ts";
import { config } from "./config.ts";
import { lastWorkflowRun } from "./expo.ts";
import { listBranches } from "./github.ts";
import * as replies from "./replies.ts";
import { channelState, planRollback, planStop } from "./ota.ts";
import { MIN_CONFIDENCE, NOT_MENTIONED, otaMessage, pickBranch, versionInText } from "./parsing.ts";
import { planVersion } from "./version.ts";

const client = new TypeSafeClient({ apiKey: config.typesafeApiKey, defaultModel: config.jevModel });

// Jev degrades with irrelevant context, so only send the recent turns.
const MAX_TURNS = 5;

// Questions are literal on purpose: jev-1.13 reads instructions at face value.
function buildQuestions(branches: string[]) {
  const branchOptions = (role: string) => ({
    ...Object.fromEntries(branches.map((b) => [b, `The branch named exactly "${b}"`])),
    [NOT_MENTIONED]: `The messages don't name the ${role} branch`,
  });
  return {
    intent: choice("What does the latest_message ask the release bot to do? Earlier messages are context only.", {
      merge: 'Merge one git branch into another branch. Includes short forms that only name two branches, like "main to release" or "dev into main".',
      release_ota: "Publish a new over-the-air (OTA) update",
      rollback_ota: "Roll back, revert, or undo the latest OTA update so phones go back to the previous one",
      stop_rollout: "Stop, pause, halt, or cancel an OTA update or rollout that is in progress",
      resume_rollout: "Resume, unpause, or continue OTA updates or a rollout that was paused or stopped",
      release_testflight: "Build the iOS app and upload it to TestFlight (a native or iOS build)",
      status: "Show the status of the latest build or workflow run",
      app_store_release: "Submit to the App Store, send for App Store review, or release the app to users in the App Store",
      unclear: "Anything else, or the request is not clear",
    }),
    source_branch: choice(
      'Which branch is the source of the merge? It is the FIRST branch name in the message, written before "into" or "to".',
      branchOptions("merged-from"),
    ),
    target_branch: choice(
      'Which branch is the destination of the merge? It is the SECOND branch name in the message, written after "into" or "to".',
      branchOptions("merged-into"),
    ),
    other_release_branch: noul(
      `Does the latest_message ask to release from a specific branch whose name is not "${config.releaseBranch}"?`,
    ),
  };
}

// `notUnderstood` marks replies where Jev couldn't route the request, so the caller can offer a fallback.
export type AgentResult = { text: string; actions: Action[]; notUnderstood?: boolean };

const notUnderstood = (): AgentResult => ({ text: replies.notUnderstood(), actions: [], notUnderstood: true });

export async function respond(history: string[], userText: string): Promise<AgentResult> {
  history.push(userText);
  const turns = history.slice(-MAX_TURNS);
  const branches = await listBranches();

  const { answers } = await client.systemOne({
    state: { earlier_messages: turns.slice(0, -1), latest_message: userText },
    questions: buildQuestions(branches),
  });
  const { intent } = answers;
  if (intent.confidence < MIN_CONFIDENCE) return notUnderstood();

  switch (intent.choice) {
    case "status": {
      const [run, channel] = await Promise.all([lastWorkflowRun(), channelState()]);
      return { text: replies.status(run, channel.paused), actions: [] };
    }

    case "rollback_ota": {
      const plan = await planRollback();
      if (!plan.possible) return { text: plan.reason, actions: [] };
      return { text: "", actions: [{ kind: "rollback_ota", from: plan.from, to: plan.to, resume: plan.resume }] };
    }

    case "stop_rollout": {
      const plan = await planStop();
      if ("nothingToStop" in plan) return { text: plan.nothingToStop, actions: [] };
      return { text: "", actions: [{ kind: "stop_rollout", ...plan }] };
    }

    case "resume_rollout": {
      const { paused } = await channelState();
      if (!paused) return { text: `*${config.otaChannel}* isn't paused, so OTA updates are already being delivered.`, actions: [] };
      return { text: "", actions: [{ kind: "resume_rollout" }] };
    }

    case "app_store_release":
      return { text: replies.appStoreNotSupported(), actions: [] };

    case "merge": {
      const text = turns.join("\n");
      const source = pickBranch(answers.source_branch, text);
      const target = pickBranch(answers.target_branch, text);
      if (!source) return { text: replies.askBranch("source", branches), actions: [] };
      if (!target) return { text: replies.askBranch("target", branches), actions: [] };
      return { text: "", actions: [{ kind: "merge", source, target }] };
    }

    case "release_ota":
    case "release_testflight": {
      if (answers.other_release_branch.noul > 0.5) {
        return { text: replies.releaseFromOtherBranch(pickBranch(answers.source_branch, userText)), actions: [] };
      }
      if (intent.choice === "release_ota") {
        if ((await channelState()).paused) return { text: replies.otaWhilePaused(), actions: [] };
        const message = otaMessage(userText);
        return { text: "", actions: [{ kind: "release_ota", message }] };
      }
      try {
        const plan = await planVersion(versionInText(userText));
        return { text: "", actions: [{ kind: "release_testflight", version: plan.version, bumpFrom: plan.bumpFrom }] };
      } catch (err) {
        return { text: `Can't release that: ${err instanceof Error ? err.message : String(err)}`, actions: [] };
      }
    }

    default:
      return notUnderstood();
  }
}
