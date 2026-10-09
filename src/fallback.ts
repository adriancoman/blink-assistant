import OpenAI from "openai";
import type { ResponseFunctionToolCall, ResponseInputItem } from "openai/resources/responses/responses";
import { capabilities, prepareAll } from "./capabilities/index.ts";
import type { Action, Capability, Explain, ToolContext, ToolSpec } from "./capability.ts";
import { config } from "./config.ts";
import type { Project } from "./project.ts";

// OpenAI is only used when the user asks for it: for a request Jev can't route, or to explain a
// failed run. It can answer, ask a question, or propose actions; proposals still go through the
// Confirm button. It only gets the tools of the capabilities the project has.

// Made on first use, so this module can be imported without a config.
let openai: OpenAI | null | undefined;
const client = () => (openai ??= config.openaiApiKey ? new OpenAI({ apiKey: config.openaiApiKey }) : null);
export const fallbackAvailable = () => client() !== null;

function instructions(p: Project, abilities: string[]): string {
  const repo = p.github ? ` (GitHub: ${p.github.owner}/${p.github.repo})` : "";
  const rules = [
    "- Tools that change things only propose them. The user then sees a Confirm button, and nothing happens until they click it. Never say one of these has run.",
    ...capabilities.flatMap((c) => c.rules?.(p) ?? []),
    "- If the request is still ambiguous, ask a short question instead of guessing. If it needs something no tool does, say so plainly.",
    "- Reply in Slack mrkdwn: *bold*, `code`, <url|text>. Keep replies short.",
  ];
  return `You are the fallback brain of a Slack release bot. You're helping with the project "${p.name}"${repo}. A faster model handed the request to you, because it couldn't understand it or because the user asked you to explain something. Help one developer by calling tools or answering briefly.

What the bot can do for this project:
${abilities.length ? abilities.join("\n") : "- Nothing is set up for this project yet."}

Rules:
${rules.join("\n")}`;
}

// `messages` are the thread's user messages, oldest first, ending with the one to answer.
// `explain` is something the user wants explained, with its details for OpenAI.
export type AskOptions = Omit<ToolContext, "prepared"> & { explain?: Explain };

export async function askOpenAI(p: Project, messages: string[], { explain, ...ctx }: AskOptions): Promise<{ text: string; actions: Action[] }> {
  const api = client();
  if (!api) throw new Error("OPENAI_API_KEY isn't set");
  const prepared = await prepareAll(p);
  const tools: { capability: Capability; spec: ToolSpec }[] = capabilities.flatMap((capability) =>
    capability.tools(p).map((spec) => ({ capability, spec })),
  );
  const context = capabilities.flatMap((c) => c.context?.(p, prepared[c.id]) ?? []);
  const input: ResponseInputItem[] = [
    ...context.map((content) => ({ role: "developer" as const, content })),
    ...(explain ? [{ role: "developer" as const, content: explain.context }] : []),
    ...messages.map((content) => ({ role: "user" as const, content })),
  ];
  const actions: Action[] = [];

  for (let iteration = 0; iteration < 6; iteration++) {
    const response = await api.responses.create({
      model: config.openaiModel,
      reasoning: { effort: "low" },
      instructions: instructions(p, tools.map((t) => t.spec.ability)),
      ...(tools.length ? { tools: tools.map((t) => t.spec.definition) } : {}),
      input,
    });
    input.push(...(response.output as ResponseInputItem[]));

    const calls = response.output.filter((item): item is ResponseFunctionToolCall => item.type === "function_call");
    if (calls.length === 0) return { text: response.output_text, actions };

    for (const call of calls) {
      try {
        const found = tools.find((t) => t.spec.definition.name === call.name);
        if (!found) throw new Error(`Unknown tool ${call.name}`);
        const outcome = await found.spec.run(p, JSON.parse(call.arguments), { ...ctx, prepared: prepared[found.capability.id] });
        if (outcome.action) actions.push(outcome.action);
        input.push({ type: "function_call_output", call_id: call.call_id, output: outcome.result });
      } catch (err) {
        input.push({ type: "function_call_output", call_id: call.call_id, output: `Error: ${String(err)}` });
      }
    }
  }
  return { text: "OpenAI couldn't finish that one either. Try rephrasing?", actions };
}
