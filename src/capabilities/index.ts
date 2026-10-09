import type { ActionSpec, Capability, IntentSpec } from "../capability.ts";
import type { Project } from "../project.ts";
import { expo } from "./expo.ts";
import { github } from "./github.ts";
import { posthog } from "./posthog.ts";

// Every capability the bot has. To add one: write a module that exports a Capability, add its
// settings type to Project (src/project.ts), and list it here. Order is the order of Jev's intent
// list and of the help reply.
export const capabilities: Capability[] = [github, expo, posthog];

export type { ExpoAction } from "./expo.ts";
export type { GithubAction } from "./github.ts";

export type IntentOwner = { capability: Capability; spec: IntentSpec };

const intentOwners = new Map<string, IntentOwner>();
const actionOwners = new Map<string, { capability: Capability; spec: ActionSpec }>();
for (const capability of capabilities) {
  for (const [intent, spec] of Object.entries(capability.intents)) {
    if (intentOwners.has(intent)) throw new Error(`Intent "${intent}" is defined by two capabilities`);
    intentOwners.set(intent, { capability, spec });
  }
  for (const [kind, spec] of Object.entries(capability.actions)) {
    if (actionOwners.has(kind)) throw new Error(`Action "${kind}" is defined by two capabilities`);
    actionOwners.set(kind, { capability, spec });
  }
}

export const intentOwner = (intent: string) => intentOwners.get(intent) ?? null;
export const actionSpec = (kind: string) => actionOwners.get(kind)?.spec ?? null;

// Whether a project is set up for a command. Used to pick a project when nothing else names it.
export const supports = (p: Project, intent: string) => intentOwners.get(intent)?.spec.supports(p) ?? false;

// What a project can do, as lines for the help reply.
export const helpLines = (p: Project) => capabilities.flatMap((c) => c.help(p));

// Jev's intent descriptions, in order.
export const intentDescriptions = (): Record<string, string> =>
  Object.fromEntries([...intentOwners].map(([intent, { spec }]) => [intent, spec.description]));

// What each capability fetched for this turn, by capability id.
export async function prepareAll(p: Project): Promise<Record<string, unknown>> {
  const entries = await Promise.all(capabilities.map(async (c) => [c.id, c.prepare ? await c.prepare(p) : undefined] as const));
  return Object.fromEntries(entries);
}
