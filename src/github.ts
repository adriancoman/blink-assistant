import { Octokit } from "@octokit/rest";
import { RequestError } from "@octokit/request-error";
import { config } from "./config.ts";
import type { GithubProject } from "./project.ts";

// Made on first use, so this module can be imported without a config.
let client: Octokit | undefined;
const octokit = () => (client ??= new Octokit({ auth: config.githubToken }));
const repoOf = (p: GithubProject) => ({ owner: p.github.owner, repo: p.github.repo });

export type MergeResult =
  | { outcome: "up_to_date" }
  | { outcome: "merged"; prUrl: string; sha: string }
  | { outcome: "needs_attention"; prUrl: string; reason: string };

async function branchExists(p: GithubProject, branch: string): Promise<boolean> {
  try {
    await octokit().repos.getBranch({ ...repoOf(p), branch });
    return true;
  } catch (err) {
    if (err instanceof RequestError && err.status === 404) return false;
    throw err;
  }
}

// GitHub computes mergeability in the background; `mergeable` is null until it's done.
async function waitForMergeable(p: GithubProject, pullNumber: number) {
  for (let attempt = 0; attempt < 10; attempt++) {
    const { data } = await octokit().pulls.get({ ...repoOf(p), pull_number: pullNumber });
    if (data.mergeable !== null) return data;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(`GitHub didn't finish checking mergeability of PR #${pullNumber}`);
}

// Merges via a PR so there's a record and branch protection is respected.
export async function mergeBranches(p: GithubProject, source: string, target: string): Promise<MergeResult> {
  const repo = repoOf(p);
  for (const branch of [source, target]) {
    if (!(await branchExists(p, branch))) throw new Error(`Branch \`${branch}\` doesn't exist on GitHub`);
  }

  const { data: comparison } = await octokit().repos.compareCommits({ ...repo, base: target, head: source });
  if (comparison.ahead_by === 0) return { outcome: "up_to_date" };

  const { data: open } = await octokit().pulls.list({ ...repo, state: "open", head: `${repo.owner}:${source}`, base: target });
  const pr =
    open[0] ??
    (
      await octokit().pulls.create({
        ...repo,
        head: source,
        base: target,
        title: `Merge ${source} into ${target}`,
        body: `Opened from Slack. ${comparison.ahead_by} commit(s) from \`${source}\`.`,
      })
    ).data;

  const checked = await waitForMergeable(p, pr.number);
  if (!checked.mergeable) {
    return { outcome: "needs_attention", prUrl: pr.html_url, reason: "it has merge conflicts" };
  }

  try {
    const { data: merged } = await octokit().pulls.merge({ ...repo, pull_number: pr.number, merge_method: "merge" });
    return { outcome: "merged", prUrl: pr.html_url, sha: merged.sha };
  } catch (err) {
    // 405: blocked by branch protection (required reviews or checks).
    if (err instanceof RequestError && err.status === 405) {
      return { outcome: "needs_attention", prUrl: pr.html_url, reason: err.message };
    }
    throw err;
  }
}

export async function readFile(p: GithubProject, path: string, branch: string): Promise<{ content: string; sha: string }> {
  const { data } = await octokit().repos.getContent({ ...repoOf(p), path, ref: branch });
  if (Array.isArray(data) || data.type !== "file") throw new Error(`${path} is not a file`);
  return { content: Buffer.from(data.content, "base64").toString("utf8"), sha: data.sha };
}

export async function writeFile(p: GithubProject, path: string, branch: string, content: string, sha: string, message: string) {
  await octokit().repos.createOrUpdateFileContents({
    ...repoOf(p),
    path,
    branch,
    sha,
    message,
    content: Buffer.from(content, "utf8").toString("base64"),
  });
}

export async function createBranch(p: GithubProject, name: string, from: string) {
  const { data } = await octokit().repos.getBranch({ ...repoOf(p), branch: from });
  await octokit().git.createRef({ ...repoOf(p), ref: `refs/heads/${name}`, sha: data.commit.sha });
}

export async function deleteBranch(p: GithubProject, name: string) {
  await octokit().git.deleteRef({ ...repoOf(p), ref: `heads/${name}` });
}

// Excludes the bot's own temporary branches.
export async function listBranches(p: GithubProject): Promise<string[]> {
  const branches = await octokit().paginate(octokit().repos.listBranches, { ...repoOf(p), per_page: 100 });
  return branches.map((b) => b.name).filter((name) => !name.startsWith("blink/"));
}
