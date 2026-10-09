import { helpLines } from "./capabilities/index.ts";
import type { Project } from "./project.ts";

// Help replies, built from what each capability says a project can do.

export const help = (p: Project, prefix = "") => {
  const lines = helpLines(p);
  if (!lines.length) return `${prefix}Nothing I can do for *${p.name}* is set up yet.`;
  return `${prefix}For *${p.name}* I can:\n${lines.join("\n")}`;
};

// For "what can you do?" when no project is in play: one section per project.
export const helpAll = (projects: Project[]) =>
  projects.map((p) => help(p)).join("\n\n") +
  (projects.length > 1 ? "\n\nName the project in your message (or use its channel) if it isn't obvious from the request." : "");

export const notUnderstood = (p: Project) => help(p, "Sorry, I'm not sure what you mean. ");

export const notConfigured = (p: Project, what: string) => `${what} isn't set up for *${p.name}*. ${help(p)}`;
