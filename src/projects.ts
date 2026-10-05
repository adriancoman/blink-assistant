import { mentioned } from "./parsing.ts";
import type { Project } from "./settings.ts";

// Which project a message is about, in order: the Slack channel, a project named in the message,
// the only project there is. Otherwise the caller decides with pickByCapability (the thread's
// project if it can do the request, else the only project that can), and asks if that fails. Pure.

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

  const named = projects.filter((p) => p.aliases.some((alias) => mentioned(alias, text)));
  if (named.length === 1) return { project: named[0], via: "message" };
  if (named.length > 1) return { ask: named };

  if (projects.length === 1) return { project: projects[0], via: "only" };
  // The thread and what the request needs decide the rest (see pickByCapability).
  return { ask: projects };
}

// Commands and what a project needs to run them. Used when nothing else names the project.
const SUPPORTS: Record<string, (p: Project) => boolean> = {
  merge: (p) => Boolean(p.github),
  release_ota: (p) => Boolean(p.github && p.expo?.workflows.ota),
  release_testflight: (p) => Boolean(p.github && p.expo?.workflows.testflight),
  release_android: (p) => Boolean(p.github && p.expo?.workflows.android),
  rollback_ota: (p) => Boolean(p.github && p.expo),
  stop_rollout: (p) => Boolean(p.github && p.expo),
  resume_rollout: (p) => Boolean(p.github && p.expo),
  status: (p) => Boolean(p.github && p.expo),
  app_store_release: (p) => Boolean(p.github && p.expo),
  analytics: (p) => Boolean(p.posthog),
};

export const supports = (p: Project, intent: string) => SUPPORTS[intent]?.(p) ?? false;

// Picks the project from what the request needs: the thread's project if it can do it, otherwise
// the only project that can. Null means it's still ambiguous (or nothing can), so ask.
export function pickByCapability(candidates: Project[], intent: string | null, threadProjectId: string | null): Project | null {
  if (!intent) return null;
  const thread = candidates.find((p) => p.id === threadProjectId);
  if (thread && supports(thread, intent)) return thread;
  const able = candidates.filter((p) => supports(p, intent));
  return able.length === 1 ? able[0] : null;
}
