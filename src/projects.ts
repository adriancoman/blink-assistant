import { supports } from "./capabilities/index.ts";
import { mentioned } from "./parsing.ts";
import type { Project } from "./project.ts";

// Which project a message is about, in order: the Slack channel, a project named in the message,
// the only project there is. Otherwise the caller decides with pickByCapability (the thread's
// project if it can do the request, else the only project that can), and asks if that fails. Pure.

const namedIn = (projects: Project[], text: string) => projects.filter((p) => p.aliases.some((alias) => mentioned(alias, text)));

export type Resolution = { project: Project; via: "channel" | "message" | "only" } | { ask: Project[] };

export function resolveProject(args: {
  projects: Project[];
  channelId: string;
  channelName: string | null;
  text: string;
  threadProjectId: string | null;
}): Resolution {
  const { projects, channelId, channelName, text, threadProjectId } = args;
  const byChannel = projects.find((p) =>
    p.slackChannels.some((c) => c === channelId || (channelName && c.replace(/^#/, "").toLowerCase() === channelName.toLowerCase())),
  );
  if (byChannel) return { project: byChannel, via: "channel" };

  const named = namedIn(projects, text);
  if (named.length === 1) return { project: named[0], via: "message" };
  if (named.length > 1) return { ask: named };

  if (projects.length === 1) return { project: projects[0], via: "only" };
  // The thread and what the request needs decide the rest (see pickByCapability).
  return { ask: projects };
}

// The project the thread is about, from the most recent earlier message that names exactly one.
// Covers threads where the project was named before the bot was mentioned, or before a restart.
export function namedInThread(projects: Project[], messages: string[]): Project | null {
  for (const text of [...messages].reverse()) {
    const named = namedIn(projects, text);
    if (named.length === 1) return named[0];
  }
  return null;
}

// Picks the project from what the request needs: the thread's project if it can do it, otherwise
// the only project that can. The thread's project also wins when the request is unclear or nothing
// can do it, so it gets to answer (help, "not set up"). Null means it's still ambiguous, so ask.
export { supports };

export function pickByCapability(candidates: Project[], intent: string | null, threadProjectId: string | null): Project | null {
  const thread = candidates.find((p) => p.id === threadProjectId) ?? null;
  if (!intent) return thread;
  if (thread && supports(thread, intent)) return thread;
  const able = candidates.filter((p) => supports(p, intent));
  if (able.length === 1) return able[0];
  return able.length === 0 ? thread : null;
}
