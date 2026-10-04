import { FINISHED_STATUSES, runDetails, type StartedRun } from "./expo.ts";
import * as replies from "./replies.ts";

const POLL_MS = 30 * 1000;
// Store builds can sit in the free-tier queue for a long time, so give up only after a while.
const GIVE_UP_MS = 4 * 60 * 60 * 1000;

// Follows a workflow run and calls `report` once with the final message. Kept in memory, so a
// restart stops watching; `status` still shows the latest run.
export function watchRun(run: StartedRun, report: (message: string) => Promise<unknown>) {
  const startedAt = Date.now();
  let failedPolls = 0;

  const poll = async () => {
    try {
      const details = await runDetails(run.id);
      failedPolls = 0;
      if (FINISHED_STATUSES.has(details.status)) {
        await report(replies.status(details));
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
