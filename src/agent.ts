import { type ChoiceResponse, choice, type Questions, TypeSafeClient } from "@typesafe-ai/sdk";
import { capabilities, intentDescriptions, intentOwner, prepareAll } from "./capabilities/index.ts";
import type { AgentResult, TurnContext } from "./capability.ts";
import { config } from "./config.ts";
import * as help from "./help.ts";
import { MIN_CONFIDENCE } from "./parsing.ts";
import type { Project } from "./project.ts";

export type { AgentResult, TurnContext };

// Made on first use, so this module can be imported without a config.
let jev: TypeSafeClient | undefined;
const client = () => (jev ??= new TypeSafeClient({ apiKey: config.typesafeApiKey, defaultModel: config.jevModel }));

// Jev degrades with irrelevant context, so only send the recent turns. Threads keep this many too.
export const MAX_TURNS = 5;

// The intent list is the same for every project, so Jev's answer doesn't depend on setup;
// unsupported commands are rejected afterwards with a clear reply. The capabilities' intents come
// first, then the two the core handles.
export const INTENTS: Record<string, string> = {
  ...intentDescriptions(),
  help: "Asks what the bot can do, which commands it has, or for help",
  unclear: "Anything else, or the request is not clear",
};
export type Intent = keyof typeof INTENTS;

const intentQuestion = () =>
  choice("What does the latest_message ask the release bot to do? Earlier messages are context only.", INTENTS);

// Just the command, without project details. Used to pick a project when nothing else says which.
export async function classifyIntent(history: string[], userText: string): Promise<Intent | null> {
  const turns = history.slice(-MAX_TURNS);
  const { answers } = await client().systemOne({
    state: { earlier_messages: turns.slice(0, -1), latest_message: userText },
    questions: { intent: intentQuestion() },
  });
  return answers.intent.confidence < MIN_CONFIDENCE || answers.intent.choice === "unclear" ? null : answers.intent.choice;
}

const notUnderstood = (p: Project): AgentResult => ({ text: help.notUnderstood(p), actions: [], notUnderstood: true });

// Runs one user turn for a resolved project. `history` is the thread's user messages. Jev answers
// the intent question and every capability's questions at once; the capability that owns the
// intent then turns the answers into a reply or a proposed action.
export async function respond(p: Project, history: string[], userText: string, ctx: TurnContext): Promise<AgentResult> {
  const turns = history.slice(-MAX_TURNS);
  const prepared = await prepareAll(p);

  const questions: Questions = { intent: intentQuestion() };
  for (const c of capabilities) Object.assign(questions, c.questions?.(p, prepared[c.id]) ?? {});

  const { answers } = await client().systemOne({
    state: { earlier_messages: turns.slice(0, -1), latest_message: userText },
    questions,
  });
  const intent = answers.intent as ChoiceResponse;
  if (intent.confidence < MIN_CONFIDENCE) return notUnderstood(p);

  if (intent.choice === "help") return { text: help.help(p), actions: [] };
  const owner = intentOwner(intent.choice);
  if (!owner) return notUnderstood(p);
  if (!owner.spec.supports(p)) return { text: help.notConfigured(p, owner.spec.label), actions: [] };
  return owner.capability.respond(p, intent.choice, { answers, turns, userText, ctx, prepared: prepared[owner.capability.id] });
}
