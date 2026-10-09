import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Action, Explain } from "./capability.ts";
import type { StartedRun } from "./expo.ts";
import type { LocalJob } from "./localbuild.ts";

// What the bot remembers between restarts, in one JSON file next to the config. Deleting the file
// resets everything. Entries are removed when their purpose is over (a Confirm click, a finished
// run) and otherwise swept by age, on startup and once a day. Pure apart from the file itself, so
// the sweep can be tested with a temp file.

// A Slack thread the bot is part of. `run` is the workflow run last started from it, so "why did
// it fail?" explains that one. Keyed by `${channel}:${threadTs}`.
export type Thread = { projectId: string | null; messages: string[]; run?: { projectId: string; id: string }; lastSeenAt: number };

export type Request = { channel: string; threadTs: string; messageTs: string; user?: string; text: string };

// A proposed action waiting for Confirm / Cancel.
export type Pending = { projectId: string; action: Action; createdAt: number };
// A request Jev couldn't route (or a failure to explain), kept so the OpenAI button can hand it over.
export type Unrouted = { projectId: string; messages: string[]; explain?: Explain; threadTs: string; createdAt: number };
// A message waiting for the user to pick a project.
export type Unassigned = { request: Request; createdAt: number };
// A workflow run (or a build on this machine) being followed until it finishes, with where to
// report. Keyed by run ID. A local build doesn't survive a restart; its watch then reports that.
export type Watch = { projectId: string; run: StartedRun | LocalJob; channel: string; threadTs: string; userId: string; startedAt: number };
// A PostHog AI conversation for a thread and project, so follow-ups keep their context.
export type Conversation = { id: string; lastSeenAt: number };

export type Data = {
  threads: Record<string, Thread>;
  pending: Record<string, Pending>;
  unrouted: Record<string, Unrouted>;
  unassigned: Record<string, Unassigned>;
  watches: Record<string, Watch>;
  conversations: Record<string, Conversation>;
};

export const empty = (): Data => ({ threads: {}, pending: {}, unrouted: {}, unassigned: {}, watches: {}, conversations: {} });

// How long each kind of entry is kept when nothing ends it first.
export type Retention = { threadMs: number; confirmMs: number; watchMs: number };

export const DAY_MS = 24 * 60 * 60 * 1000;

// The latest file, as long as it parses and has the expected shape; otherwise empty, with the
// unreadable file moved aside rather than overwritten.
function load(path: string): Data {
  if (!existsSync(path)) return empty();
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    const data = empty();
    for (const key of Object.keys(data) as (keyof Data)[]) {
      if (parsed[key] && typeof parsed[key] === "object" && !Array.isArray(parsed[key])) data[key] = parsed[key];
    }
    return data;
  } catch (err) {
    const aside = `${path}.corrupt-${Date.now()}`;
    console.warn(`Couldn't read ${path} (${err instanceof Error ? err.message : err}); moved it to ${aside} and starting fresh`);
    renameSync(path, aside);
    return empty();
  }
}

export class Store {
  readonly data: Data;

  constructor(private readonly path: string) {
    this.data = load(path);
  }

  // Changes go through here so nothing is forgotten before it's written.
  update<T>(change: (data: Data) => T): T {
    const result = change(this.data);
    this.save();
    return result;
  }

  // Written whole, via a temp file, so a crash mid-write can't leave half a file.
  private save() {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2) + "\n");
    renameSync(tmp, this.path);
  }

  // Drops entries older than their retention. Returns how many of each were removed.
  sweep(retention: Retention, now = Date.now()): Record<keyof Data, number> {
    return this.update((data) => sweep(data, retention, now));
  }
}

export function sweep(data: Data, retention: Retention, now: number): Record<keyof Data, number> {
  const drop = <T>(entries: Record<string, T>, stale: (entry: T) => boolean) => {
    let removed = 0;
    for (const [key, entry] of Object.entries(entries)) {
      if (stale(entry)) {
        delete entries[key];
        removed++;
      }
    }
    return removed;
  };
  const olderThan = (at: number, ms: number) => now - at > ms;
  return {
    threads: drop(data.threads, (t) => olderThan(t.lastSeenAt, retention.threadMs)),
    conversations: drop(data.conversations, (c) => olderThan(c.lastSeenAt, retention.threadMs)),
    pending: drop(data.pending, (e) => olderThan(e.createdAt, retention.confirmMs)),
    unrouted: drop(data.unrouted, (e) => olderThan(e.createdAt, retention.confirmMs)),
    unassigned: drop(data.unassigned, (e) => olderThan(e.createdAt, retention.confirmMs)),
    watches: drop(data.watches, (w) => olderThan(w.startedAt, retention.watchMs)),
  };
}
