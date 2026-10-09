import type { Action } from "./capability.ts";
import { FINISHED_STATUSES, runDetails, runFailure, type StartedRun } from "./expo.ts";
import { followLocalBuild, isLocalJob, type LocalJob, retryLocally } from "./localbuild.ts";
import { quotaExceeded } from "./logs.ts";
import type { ExpoProject } from "./project.ts";
import * as replies from "./replies.ts";

const POLL_MS = 30 * 1000;
// Store builds can sit in the free-tier queue for a long time, so give up only after a while.
export const GIVE_UP_MS = 4 * 60 * 60 * 1000;

// The final message, and sometimes an action to offer along with it (a Confirm card).
export type Report = (message: string, offer?: Action) => Promise<unknown>;

// Follows a workflow run, or a build on this machine, and calls `report` once with the final
// message. `startedAt` is when the watch began, so one resumed after a restart still gives up at
// the same time.
export function watchRun(p: ExpoProject, run: StartedRun | LocalJob, report: Report, startedAt = Date.now()) {
  if (isLocalJob(run)) {
    void followLocalBuild(run).then((outcome) => {
      if (!outcome) return report(replies.localBuildLost(run));
      return report(outcome.run.status === "FAILURE" ? replies.failedRun(outcome.run, outcome.failure) : replies.status(p, outcome.run));
    });
    return;
  }

  let failedPolls = 0;

  const poll = async () => {
    try {
      const details = await runDetails(p, run.id);
      failedPolls = 0;
      if (FINISHED_STATUSES.has(details.status)) {
        if (details.status !== "FAILURE") {
          await report(replies.status(p, details));
          return;
        }
        // A failure comes with the end of the failing step's log, so there's no need to ask. When
        // EAS refused the build because the month's free builds are spent, offer to build here.
        const failure = await runFailure(p, details);
        const offerLocal = Boolean(p.expo.localBuild) && failure !== null && quotaExceeded(failure.lines);
        await report(replies.failedRun(details, failure) + (offerLocal ? replies.quotaSpent() : ""), offerLocal ? retryLocally(details) : undefined);
        return;
      }
    } catch (err) {
      // A transient eas or network error shouldn't end the watch; several in a row should.
      console.warn(`Couldn't check workflow run ${run.id}:`, err instanceof Error ? err.message : err);
      if (++failedPolls >= 10) {
        await report(`⚠️ Stopped checking this run after repeated errors. <${run.url}|View run>`);
        return;
      }
    }
    if (Date.now() - startedAt > GIVE_UP_MS) {
      await report(`⚠️ Still not finished after 4 hours, so I've stopped checking. <${run.url}|View run>`);
      return;
    }
    setTimeout(poll, POLL_MS);
  };

  setTimeout(poll, POLL_MS);
}
