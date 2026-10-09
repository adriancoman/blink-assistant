import { type Capability, isString, reply, tool } from "../capability.ts";
import { askInThread } from "../posthog.ts";
import { hasPosthog, type Project } from "../project.ts";
import * as replies from "../replies.ts";

// Analytics questions, answered by PostHog AI from the project's own PostHog data. Read-only.

function posthogOf(p: Project) {
  if (!hasPosthog(p)) throw new Error(`PostHog isn't set up for ${p.name}`);
  return p;
}

export const posthog: Capability = {
  id: "posthog",

  parseSettings(raw, { problems, where, secret }) {
    if (!raw.posthog) return {};
    if (!isString(raw.posthog.host)) problems.push(`${where}: "posthog.host" is required (e.g. "https://eu.posthog.com")`);
    if (!isString(String(raw.posthog.projectId ?? ""))) problems.push(`${where}: "posthog.projectId" is required`);
    return {
      posthog: {
        host: raw.posthog.host ?? "",
        projectId: String(raw.posthog.projectId ?? ""),
        apiKey: secret(isString(raw.posthog.apiKeyEnv) ? raw.posthog.apiKeyEnv : "POSTHOG_API_KEY", `${where} posthog`),
      },
    };
  },

  intents: {
    analytics: {
      description: "A question about product analytics or usage data: users, events, signups, retention, conversion, traffic, funnels",
      label: "PostHog",
      supports: hasPosthog,
    },
  },

  async respond(project, _intent, { userText, ctx }) {
    const p = posthogOf(project);
    await ctx.progress(replies.askingPosthog(p));
    try {
      return reply(await askInThread(p, ctx.threadKey, userText, ctx.conversations));
    } catch (err) {
      console.error(err);
      return reply(replies.posthogFailed(err));
    }
  },

  actions: {},

  tools(project) {
    if (!hasPosthog(project)) return [];
    const p = project;
    return [
      {
        definition: tool("ask_posthog", "Ask PostHog AI a question about the project's product analytics (users, events, signups, retention, funnels). Slow: tens of seconds.", {
          type: "object",
          properties: { question: { type: "string", description: "The analytics question, in plain language" } },
          required: ["question"],
          additionalProperties: false,
        }),
        ability: "- ask_posthog: answer a product analytics question from the project's PostHog data.",
        run: async (_p, input, { threadKey, conversations }) => ({ result: await askInThread(p, threadKey, input.question as string, conversations) }),
      },
    ];
  },

  help: (p) => (p.posthog ? [`• answer *analytics questions* with PostHog AI (e.g. _how many signups this week?_)`] : []),
};
