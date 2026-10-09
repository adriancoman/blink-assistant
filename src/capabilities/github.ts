import { type ChoiceResponse, choice, type Questions } from "@typesafe-ai/sdk";
import { type Capability, isString, PROPOSED, propose, reply, tool } from "../capability.ts";
import { listBranches, mergeBranches } from "../github.ts";
import { NOT_MENTIONED, pickBranch } from "../parsing.ts";
import { hasGithub, type Project } from "../project.ts";
import * as replies from "../replies.ts";

// Merging branches through GitHub PRs. Also the base for Expo releases, which run from the
// release branch, so `prepare` (the branch list) and the branch questions live here.

export type GithubAction = { kind: "merge"; source: string; target: string };

const branchAnswer = (answers: Record<string, unknown>, key: string) => answers[key] as ChoiceResponse | undefined;

function githubOf(p: Project) {
  if (!hasGithub(p)) throw new Error(`GitHub isn't set up for ${p.name}`);
  return p;
}

export const github: Capability = {
  id: "github",

  parseSettings(raw, { problems, where }) {
    if (!raw.github) return {};
    const repo = raw.github.repo;
    if (!isString(repo) || !/^[\w.-]+\/[\w.-]+$/.test(repo)) problems.push(`${where}: "github.repo" should look like "owner/repo"`);
    const [owner, name] = isString(repo) ? repo.split("/") : ["", ""];
    return { github: { owner, repo: name, releaseBranch: isString(raw.github.releaseBranch) ? raw.github.releaseBranch : "release" } };
  },

  intents: {
    merge: {
      description: 'Merge one git branch into another branch. Includes short forms that only name two branches, like "main to release" or "dev into main".',
      label: "Merging",
      supports: hasGithub,
    },
  },

  // The repo's real branches: Jev picks from them, and OpenAI's picks are checked against them.
  prepare: (p) => (hasGithub(p) ? listBranches(p) : Promise.resolve([])),

  // Questions are literal on purpose: jev-1.13 reads instructions at face value.
  questions(p, prepared) {
    if (!p.github) return {};
    const branches = prepared as string[];
    const branchOptions = (role: string) => ({
      ...Object.fromEntries(branches.map((b) => [b, `The branch named exactly "${b}"`])),
      [NOT_MENTIONED]: `The messages don't name the ${role} branch`,
    });
    const questions: Questions = {
      source_branch: choice(
        'Which branch is the source of the merge? It is the FIRST branch name in the message, written before "into" or "to".',
        branchOptions("merged-from"),
      ),
      target_branch: choice(
        'Which branch is the destination of the merge? It is the SECOND branch name in the message, written after "into" or "to".',
        branchOptions("merged-into"),
      ),
    };
    return questions;
  },

  async respond(_p, _intent, { answers, turns, prepared }) {
    const branches = prepared as string[];
    const text = turns.join("\n");
    const source = branchAnswer(answers, "source_branch") && pickBranch(branchAnswer(answers, "source_branch")!, text);
    const target = branchAnswer(answers, "target_branch") && pickBranch(branchAnswer(answers, "target_branch")!, text);
    if (!source) return reply(replies.askBranch("source", branches));
    if (!target) return reply(replies.askBranch("target", branches));
    return propose({ kind: "merge", source, target });
  },

  actions: {
    merge: {
      describe: (_p, action: GithubAction) => `Merge \`${action.source}\` into \`${action.target}\` (via PR, merged only if there are no conflicts)`,
      async execute(p, action: GithubAction) {
        const result = await mergeBranches(githubOf(p), action.source, action.target);
        if (result.outcome === "up_to_date") return `\`${action.target}\` already has everything from \`${action.source}\`. Nothing to merge.`;
        if (result.outcome === "merged") return `Merged \`${action.source}\` into \`${action.target}\` (${result.sha.slice(0, 7)}). <${result.prUrl}|PR>`;
        return `Couldn't merge: ${result.reason}. The PR is open for you: <${result.prUrl}|PR>`;
      },
    },
  },

  tools(p) {
    if (!p.github) return [];
    return [
      {
        definition: tool("merge_branches", "Propose merging one branch into another via a GitHub PR. The user must confirm.", {
          type: "object",
          properties: {
            source: { type: "string", description: "Branch to merge from" },
            target: { type: "string", description: "Branch to merge into" },
          },
          required: ["source", "target"],
          additionalProperties: false,
        }),
        ability: "- merge_branches: merge any source branch into a target branch through a PR, only if there are no conflicts.",
        async run(_p, input, { prepared }) {
          const branches = prepared as string[];
          const { source, target } = input as { source: string; target: string };
          const unknown = [source, target].filter((b) => !branches.includes(b));
          if (unknown.length) return { result: `Not a branch: ${unknown.join(", ")}. Ask the user which branch they meant.` };
          return { result: PROPOSED, action: { kind: "merge", source, target } };
        },
      },
    ];
  },

  context: (_p, prepared) => {
    const branches = prepared as string[];
    return branches.length ? [`Branches: ${branches.join(", ")}`] : [];
  },

  rules: () => ["- Only use branch names from the branch list given to you."],

  help(p) {
    if (!p.github) return [];
    const branch = p.github.releaseBranch;
    const example = branch === "main" ? `merge my-feature into main` : `merge main into ${branch}`;
    return [`• *merge* one branch into another (e.g. _${example}_)`];
  },
};
