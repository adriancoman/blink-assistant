import OpenAI from "openai";
import type { FunctionTool, ResponseFunctionToolCall, ResponseInputItem } from "openai/resources/responses/responses";
import type { Action } from "./actions.ts";
import { config } from "./config.ts";
import { lastWorkflowRun } from "./expo.ts";
import { listBranches } from "./github.ts";
import { channelState, planRollback, planStop } from "./ota.ts";
import { hasExpo, hasGithub, type Project } from "./settings.ts";
import { planVersion } from "./version.ts";

// OpenAI is only used when Jev can't route a request and the user asks for it. It can answer,
// ask a question, or propose actions; proposals still go through the Confirm button. It only gets
// the tools the project supports.

const noInput = { type: "object", properties: {}, required: [], additionalProperties: false };
const tool = (name: string, description: string, parameters: Record<string, unknown> = noInput): FunctionTool => ({
  type: "function",
  name,
  description,
  strict: true,
  parameters,
});

function toolsFor(p: Project): { tools: FunctionTool[]; abilities: string[] } {
  const tools: FunctionTool[] = [];
  const abilities: string[] = [];
  if (p.github) {
    tools.push(
      tool("merge_branches", "Propose merging one branch into another via a GitHub PR. The user must confirm.", {
        type: "object",
        properties: {
          source: { type: "string", description: "Branch to merge from" },
          target: { type: "string", description: "Branch to merge into" },
        },
        required: ["source", "target"],
        additionalProperties: false,
      }),
    );
    abilities.push("- merge_branches: merge any source branch into a target branch through a PR, only if there are no conflicts.");
  }
  if (p.github && p.expo) {
    const { releaseBranch } = p.github;
    const { otaChannel, workflows } = p.expo;
    if (workflows.ota) {
      tools.push(
        tool("release_ota", `Propose publishing an iOS OTA update from ${releaseBranch} to ${otaChannel}. The user must confirm.`, {
          type: "object",
          properties: { message: { type: "string", description: "Short update message. Use 'OTA update' if none was given." } },
          required: ["message"],
          additionalProperties: false,
        }),
      );
      abilities.push(`- release_ota: publish an iOS over-the-air update from "${releaseBranch}" to the "${otaChannel}" channel.`);
    }
    if (workflows.testflight) {
      tools.push(
        tool("release_testflight", `Propose building iOS from ${releaseBranch} and uploading it to TestFlight. The user must confirm.`, {
          type: "object",
          properties: {
            version: { type: ["string", "null"], description: "Version the user asked for, like 1.2.0, or null to pick automatically." },
          },
          required: ["version"],
          additionalProperties: false,
        }),
      );
      abilities.push(`- release_testflight: build iOS from "${releaseBranch}" and upload it to TestFlight.`);
    }
    if (workflows.android) {
      tools.push(tool("release_android", `Propose building Android from ${releaseBranch}. The user must confirm.`));
      abilities.push(`- release_android: build Android from "${releaseBranch}" (a store build; uploading it to Google Play is manual).`);
    }
    tools.push(
      tool("rollback_ota", `Propose rolling ${otaChannel} back to the previous OTA update. The user must confirm.`),
      tool("stop_rollout", `Propose stopping the OTA rollout (cancel a running OTA workflow, pause ${otaChannel}). The user must confirm.`),
      tool("resume_rollout", `Propose resuming the paused ${otaChannel} channel. The user must confirm.`),
      tool("status", `The latest EAS workflow run and whether ${otaChannel} is paused.`),
    );
    abilities.push(
      `- rollback_ota: roll "${otaChannel}" back to the previous OTA update (or the store build's code if there is none).`,
      `- stop_rollout: cancel a running OTA workflow and pause the "${otaChannel}" channel.`,
      `- resume_rollout: resume the paused "${otaChannel}" channel.`,
      `- status: the latest EAS workflow run and whether "${otaChannel}" is paused.`,
    );
  }
  return { tools, abilities };
}

function instructions(p: Project, abilities: string[]): string {
  const repo = p.github ? ` (GitHub: ${p.github.owner}/${p.github.repo})` : "";
  const rules = [
    p.github
      ? `- Releases always run from the "${p.github.releaseBranch}" branch. If asked to release from another branch, explain that and offer to merge it into "${p.github.releaseBranch}" first.`
      : null,
    "- OTA updates and TestFlight are iOS only; Android can only be built, not uploaded to Google Play. Releasing to the App Store (submitting for review or to users) is not supported yet; say so.",
    "- Tools that change things only propose them. The user then sees a Confirm button, and nothing happens until they click it. Never say one of these has run.",
    "- Only use branch names from the branch list given to you.",
    "- If the request is still ambiguous, ask a short question instead of guessing. If it needs something no tool does, say so plainly.",
    "- Reply in Slack mrkdwn: *bold*, `code`, <url|text>. Keep replies short.",
  ].filter(Boolean);
  return `You are the fallback brain of a Slack release bot. You're helping with the project "${p.name}"${repo}. A faster model couldn't understand the user's request, so it was handed to you. Help one developer by calling tools or answering briefly.

What the bot can do for this project:
${abilities.length ? abilities.join("\n") : "- Nothing is set up for this project yet."}

Rules:
${rules.join("\n")}`;
}

const client = config.openaiApiKey ? new OpenAI({ apiKey: config.openaiApiKey }) : null;
export const fallbackAvailable = client !== null;

type ToolOutcome = { result: string; action?: Action };

async function runTool(p: Project, call: ResponseFunctionToolCall, branches: string[]): Promise<ToolOutcome> {
  const input = JSON.parse(call.arguments) as Record<string, string | null>;
  const proposed = "Proposed. The user now sees a Confirm button; it runs only if they click it.";
  if (call.name === "merge_branches") {
    const { source, target } = input as { source: string; target: string };
    const unknown = [source, target].filter((b) => !branches.includes(b));
    if (unknown.length) return { result: `Not a branch: ${unknown.join(", ")}. Ask the user which branch they meant.` };
    return { result: proposed, action: { kind: "merge", source, target } };
  }
  if (!hasExpo(p)) throw new Error(`${call.name} isn't available for ${p.name}`);
  switch (call.name) {
    case "release_ota":
      if ((await channelState(p)).paused) return { result: `${p.expo.otaChannel} is paused; a new OTA wouldn't reach anyone. Tell the user to resume rollout first.` };
      return { result: proposed, action: { kind: "release_ota", message: input.message || "OTA update" } };
    case "release_testflight": {
      if (p.expo.versioning === "none") return { result: proposed, action: { kind: "release_testflight", version: null, bumpFrom: null } };
      const plan = await planVersion(p, input.version || null);
      return {
        result: `${proposed} Version ${plan.version}${plan.bumpFrom ? ` (bumping from ${plan.bumpFrom})` : ""}.`,
        action: { kind: "release_testflight", version: plan.version, bumpFrom: plan.bumpFrom },
      };
    }
    case "release_android":
      return { result: proposed, action: { kind: "release_android" } };
    case "rollback_ota": {
      const plan = await planRollback(p);
      if (!plan.possible) return { result: plan.reason };
      return { result: proposed, action: { kind: "rollback_ota", from: plan.from, to: plan.to, resume: plan.resume } };
    }
    case "stop_rollout": {
      const plan = await planStop(p);
      if ("nothingToStop" in plan) return { result: plan.nothingToStop };
      return { result: proposed, action: { kind: "stop_rollout", ...plan } };
    }
    case "resume_rollout":
      if (!(await channelState(p)).paused) return { result: `${p.expo.otaChannel} isn't paused.` };
      return { result: proposed, action: { kind: "resume_rollout" } };
    case "status": {
      const [run, channel] = await Promise.all([lastWorkflowRun(p), channelState(p)]);
      return { result: JSON.stringify({ latestRun: run, channelPaused: channel.paused }) };
    }
    default:
      throw new Error(`Unknown tool ${call.name}`);
  }
}

// `messages` are the thread's user messages, oldest first, ending with the one Jev couldn't route.
export async function askOpenAI(p: Project, messages: string[]): Promise<{ text: string; actions: Action[] }> {
  if (!client) throw new Error("OPENAI_API_KEY isn't set");
  const branches = hasGithub(p) ? await listBranches(p) : [];
  const { tools, abilities } = toolsFor(p);
  const input: ResponseInputItem[] = [
    ...(branches.length ? [{ role: "developer" as const, content: `Branches: ${branches.join(", ")}` }] : []),
    ...messages.map((content) => ({ role: "user" as const, content })),
  ];
  const actions: Action[] = [];

  for (let iteration = 0; iteration < 6; iteration++) {
    const response = await client.responses.create({
      model: config.openaiModel,
      reasoning: { effort: "low" },
      instructions: instructions(p, abilities),
      ...(tools.length ? { tools } : {}),
      input,
    });
    input.push(...(response.output as ResponseInputItem[]));

    const calls = response.output.filter((item): item is ResponseFunctionToolCall => item.type === "function_call");
    if (calls.length === 0) return { text: response.output_text, actions };

    for (const call of calls) {
      try {
        const outcome = await runTool(p, call, branches);
        if (outcome.action) actions.push(outcome.action);
        input.push({ type: "function_call_output", call_id: call.call_id, output: outcome.result });
      } catch (err) {
        input.push({ type: "function_call_output", call_id: call.call_id, output: `Error: ${String(err)}` });
      }
    }
  }
  return { text: "OpenAI couldn't finish that one either. Try rephrasing?", actions };
}
