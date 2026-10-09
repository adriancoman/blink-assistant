import type { Questions } from "@typesafe-ai/sdk";
import type { FunctionTool } from "openai/resources/responses/responses";
import type { StartedRun } from "./expo.ts";
import type { LocalJob } from "./localbuild.ts";
import type { Conversations } from "./posthog.ts";
import type { Project } from "./project.ts";

// What a capability (GitHub, Expo, PostHog, ...) plugs into the bot. One module each, under
// src/capabilities/, registered in src/capabilities/index.ts. The core never names a capability:
// it parses settings, asks Jev, replies, runs actions and offers OpenAI tools through this interface.

// A project's raw JSON block and where to report problems with it.
export type Raw = Record<string, any>;
export type Env = Record<string, string | undefined>;
export type ParseContext = {
  env: Env;
  problems: string[];
  // Names the project in problem messages, like `projects[0] ("mobile")`.
  where: string;
  // Reads a secret from .env, reporting it as a problem when missing.
  secret: (name: string, what: string) => string;
};

export const isString = (v: unknown): v is string => typeof v === "string" && v.length > 0;

// A command Jev can route to. `supports` says whether a project is set up for it; when it isn't,
// the core replies that `label` isn't set up and shows what is.
export type IntentSpec = { description: string; label: string; supports: (p: Project) => boolean };

// Something with side effects, proposed by a model and run after Confirm (or right away, if the
// autonomy setting allows). `kind` picks the capability's ActionSpec.
export type Action = { kind: string; [key: string]: unknown };

// `watch` is a workflow run, or a build on this machine, the core should follow and report on in the thread.
export type ExecuteResult = { text: string; watch?: StartedRun | LocalJob };

export type ActionSpec<A extends Action = Action> = {
  // A release: with "partial" autonomy it still needs Confirm.
  release?: boolean;
  describe: (p: Project, action: A) => string;
  execute: (p: Project, action: A) => Promise<string | ExecuteResult>;
};

// Context from Slack: which thread this is and its PostHog AI conversations (for follow-ups), the
// workflow run last started from it, and a way to post a quick "working on it" note before slow steps.
export type TurnContext = {
  threadKey: string;
  conversations: Conversations;
  threadRunId: string | null;
  progress: (text: string) => Promise<unknown>;
};

// Something OpenAI can be asked to explain: a developer message with the details.
export type Explain = { context: string };

// `notUnderstood` marks replies where Jev couldn't route the request, so the core can offer OpenAI.
export type AgentResult = { text: string; actions: Action[]; notUnderstood?: boolean; explain?: Explain };

export const reply = (text: string): AgentResult => ({ text, actions: [] });
export const propose = (action: Action): AgentResult => ({ text: "", actions: [action] });

// One user turn, after Jev answered. `answers` holds every question's answer (the capability's own
// and the others'); `turns` the recent thread messages, ending with `userText`.
export type TurnInput = {
  answers: Record<string, unknown>;
  turns: string[];
  userText: string;
  ctx: TurnContext;
  prepared: unknown;
};

export type ToolContext = Omit<TurnContext, "progress"> & { prepared: unknown };
export type ToolOutcome = { result: string; action?: Action };

// A command for the OpenAI fallback. `ability` is its one-line description in the instructions.
export type ToolSpec = {
  definition: FunctionTool;
  ability: string;
  run: (p: Project, input: Record<string, unknown>, ctx: ToolContext) => Promise<ToolOutcome>;
};

export type Capability = {
  // Also the name of the project's settings block.
  id: string;
  // Turns the project's raw block into typed settings on the project (nothing when it has no block).
  parseSettings: (raw: Raw, ctx: ParseContext) => Partial<Project>;
  intents: Record<string, IntentSpec>;
  // Fetched once per turn and handed to `questions`, `respond`, `context` and tools (e.g. the branch list).
  prepare?: (p: Project) => Promise<unknown>;
  // Extra questions for Jev, answered alongside the intent.
  questions?: (p: Project, prepared: unknown) => Questions;
  // Handles one of this capability's intents for a project that supports it.
  respond: (p: Project, intent: string, input: TurnInput) => Promise<AgentResult>;
  actions: Record<string, ActionSpec<any>>;
  // OpenAI fallback: tools for what the project supports, developer messages with context, and rules.
  tools: (p: Project) => ToolSpec[];
  context?: (p: Project, prepared: unknown) => string[];
  rules?: (p: Project) => string[];
  // Lines for the help reply, only for what the project supports.
  help: (p: Project) => string[];
};

const noInput = { type: "object", properties: {}, required: [], additionalProperties: false };
export const tool = (name: string, description: string, parameters: Record<string, unknown> = noInput): FunctionTool => ({
  type: "function",
  name,
  description,
  strict: true,
  parameters,
});

export const PROPOSED = "Proposed. The user now sees a Confirm button; it runs only if they click it.";
