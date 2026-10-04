import OpenAI from "openai";
import type { FunctionTool, ResponseFunctionToolCall, ResponseInputItem } from "openai/resources/responses/responses";
import type { Action } from "./actions.ts";
import { config } from "./config.ts";
import { lastWorkflowRun } from "./expo.ts";
import { listBranches } from "./github.ts";
import { channelState, planRollback, planStop } from "./ota.ts";
import { planVersion } from "./version.ts";

// OpenAI is only used when Jev can't route a request and the user asks for it. It can answer,
// ask a question, or propose actions; proposals still go through the Confirm button.

const SYSTEM = `You are the fallback brain of a Slack release bot for the Expo app "${config.appName}" (GitHub: ${config.owner}/${config.repo}). A faster model couldn't understand the user's request, so it was handed to you. Help one developer by calling tools or answering briefly.

What the bot can do:
- merge_branches: merge any source branch into a target branch through a PR. It is merged only if there are no conflicts.
- release_ota: publish an iOS over-the-air update from "${config.releaseBranch}" to the "${config.otaChannel}" channel.
- release_testflight: build iOS from "${config.releaseBranch}" and upload it to TestFlight. The bot bumps the version if needed.
- rollback_ota: roll "${config.otaChannel}" back to the previous OTA update (or the store build's code if there is none).
- stop_rollout: stop an OTA from continuing: cancel a running OTA workflow and pause the "${config.otaChannel}" channel.
- resume_rollout: resume the paused "${config.otaChannel}" channel.
- status: the latest EAS workflow run and whether "${config.otaChannel}" is paused.

Rules:
- Releases always run from the "${config.releaseBranch}" branch. If asked to release from another branch, explain that and offer to merge it into "${config.releaseBranch}" first.
- Only iOS is supported. Releasing to the App Store (submitting for review or to users) is not supported yet; say so and offer release_testflight.
- merge_branches, release_ota and release_testflight only propose the action. The user then sees a Confirm button, and nothing happens until they click it. Never say one of these has run.
- Only use branch names from the branch list given to you.
- If the request is still ambiguous, ask a short question instead of guessing. If it needs something no tool does, say so plainly.
- Reply in Slack mrkdwn: *bold*, \`code\`, <url|text>. Keep replies short.`;

const noInput = { type: "object", properties: {}, required: [], additionalProperties: false };

const tools: FunctionTool[] = [
  {
    type: "function",
    name: "merge_branches",
    description: "Propose merging one branch into another via a GitHub PR. The user must confirm.",
    strict: true,
    parameters: {
      type: "object",
      properties: {
        source: { type: "string", description: "Branch to merge from" },
        target: { type: "string", description: "Branch to merge into" },
      },
      required: ["source", "target"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "release_ota",
    description: `Propose publishing an iOS OTA update from ${config.releaseBranch} to ${config.otaChannel}. The user must confirm.`,
    strict: true,
    parameters: {
      type: "object",
      properties: { message: { type: "string", description: "Short update message. Use 'OTA update' if none was given." } },
      required: ["message"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "release_testflight",
    description: `Propose building iOS from ${config.releaseBranch} and uploading it to TestFlight. The user must confirm.`,
    strict: true,
    parameters: {
      type: "object",
      properties: {
        version: { type: ["string", "null"], description: "Version the user asked for, like 1.2.0, or null to pick automatically." },
      },
      required: ["version"],
      additionalProperties: false,
    },
  },
  { type: "function", name: "rollback_ota", description: `Propose rolling ${config.otaChannel} back to the previous OTA update. The user must confirm.`, strict: true, parameters: noInput },
  { type: "function", name: "stop_rollout", description: `Propose stopping the OTA rollout (cancel a running OTA workflow, pause ${config.otaChannel}). The user must confirm.`, strict: true, parameters: noInput },
  { type: "function", name: "resume_rollout", description: `Propose resuming the paused ${config.otaChannel} channel. The user must confirm.`, strict: true, parameters: noInput },
  { type: "function", name: "status", description: `The latest EAS workflow run and whether ${config.otaChannel} is paused.`, strict: true, parameters: noInput },
];

const client = config.openaiApiKey ? new OpenAI({ apiKey: config.openaiApiKey }) : null;
export const fallbackAvailable = client !== null;

type ToolOutcome = { result: string; action?: Action };

async function runTool(call: ResponseFunctionToolCall, branches: string[]): Promise<ToolOutcome> {
  const input = JSON.parse(call.arguments) as Record<string, string | null>;
  const proposed = "Proposed. The user now sees a Confirm button; it runs only if they click it.";
  switch (call.name) {
    case "merge_branches": {
      const { source, target } = input as { source: string; target: string };
      const unknown = [source, target].filter((b) => !branches.includes(b));
      if (unknown.length) return { result: `Not a branch: ${unknown.join(", ")}. Ask the user which branch they meant.` };
      return { result: proposed, action: { kind: "merge", source, target } };
    }
    case "release_ota":
      if ((await channelState()).paused) return { result: "Production is paused; a new OTA wouldn't reach anyone. Tell the user to resume rollout first." };
      return { result: proposed, action: { kind: "release_ota", message: input.message || "OTA update" } };
    case "release_testflight": {
      const plan = await planVersion(input.version || null);
      return {
        result: `${proposed} Version ${plan.version}${plan.bumpFrom ? ` (bumping from ${plan.bumpFrom})` : ""}.`,
        action: { kind: "release_testflight", version: plan.version, bumpFrom: plan.bumpFrom },
      };
    }
    case "rollback_ota": {
      const plan = await planRollback();
      if (!plan.possible) return { result: plan.reason };
      return { result: proposed, action: { kind: "rollback_ota", from: plan.from, to: plan.to, resume: plan.resume } };
    }
    case "stop_rollout": {
      const plan = await planStop();
      if ("nothingToStop" in plan) return { result: plan.nothingToStop };
      return { result: proposed, action: { kind: "stop_rollout", ...plan } };
    }
    case "resume_rollout":
      if (!(await channelState()).paused) return { result: "Production isn't paused." };
      return { result: proposed, action: { kind: "resume_rollout" } };
    case "status": {
      const [run, channel] = await Promise.all([lastWorkflowRun(), channelState()]);
      return { result: JSON.stringify({ latestRun: run, channelPaused: channel.paused }) };
    }
    default:
      throw new Error(`Unknown tool ${call.name}`);
  }
}

// `messages` are the thread's user messages, oldest first, ending with the one Jev couldn't route.
export async function askOpenAI(messages: string[]): Promise<{ text: string; actions: Action[] }> {
  if (!client) throw new Error("OPENAI_API_KEY isn't set");
  const branches = await listBranches();
  const input: ResponseInputItem[] = [
    { role: "developer", content: `Branches: ${branches.join(", ")}` },
    ...messages.map((content) => ({ role: "user" as const, content })),
  ];
  const actions: Action[] = [];

  for (let iteration = 0; iteration < 6; iteration++) {
    const response = await client.responses.create({
      model: config.openaiModel,
      reasoning: { effort: "low" },
      instructions: SYSTEM,
      tools,
      input,
    });
    input.push(...(response.output as ResponseInputItem[]));

    const calls = response.output.filter((item): item is ResponseFunctionToolCall => item.type === "function_call");
    if (calls.length === 0) return { text: response.output_text, actions };

    for (const call of calls) {
      try {
        const outcome = await runTool(call, branches);
        if (outcome.action) actions.push(outcome.action);
        input.push({ type: "function_call_output", call_id: call.call_id, output: outcome.result });
      } catch (err) {
        input.push({ type: "function_call_output", call_id: call.call_id, output: `Error: ${String(err)}` });
      }
    }
  }
  return { text: "OpenAI couldn't finish that one either. Try rephrasing?", actions };
}
