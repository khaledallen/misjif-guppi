import * as logger from "firebase-functions/logger";
import type { gmail_v1 } from "googleapis";
import { fetchThread, inboxSnapshot, type SimpleThread } from "./gmail";
import { failedTriage, triageThread } from "./triage";
import { alreadyTriaged, getPriorities, reconcileWithInbox, saveTriage } from "./store";

export interface RunStats {
  seen: number;
  triaged: number;
  skipped: number;
  failed: number;
}

/** Fetch + triage a batch of threads with bounded concurrency. Idempotent per message. */
export async function triageThreads(
  gmail: gmail_v1.Gmail,
  threadIds: string[],
  model: string,
  opts: { concurrency?: number; force?: boolean } = {},
): Promise<RunStats> {
  const priorities = await getPriorities();
  const stats: RunStats = { seen: threadIds.length, triaged: 0, skipped: 0, failed: 0 };
  const queue = [...threadIds];

  async function worker() {
    for (let id = queue.shift(); id; id = queue.shift()) {
      let thread: SimpleThread | null = null;
      try {
        thread = await fetchThread(gmail, id);
        if (!thread || !thread.inInbox) {
          stats.skipped++;
          continue;
        }
        if (!opts.force && (await alreadyTriaged(id, thread.lastMessageId))) {
          stats.skipped++;
          continue;
        }
        // Khaled's own outgoing message is the latest: nothing new to triage.
        if (thread.messages[thread.messages.length - 1]?.sentByMe) {
          stats.skipped++;
          continue;
        }
        const result = await triageThread(thread, priorities, model);
        await saveTriage(thread, result, model);
        stats.triaged++;
        if (result.injection_suspected) logger.warn("Possible prompt injection in thread", { threadId: id });
      } catch (err) {
        stats.failed++;
        logger.error("Triage failed", { threadId: id, err: String(err) });
        // Fail visible: record a zero-confidence stand-in so the thread shows up
        // under "Needs your call" rather than vanishing. Retried on next run.
        if (thread) {
          try {
            await saveTriage(thread, failedTriage(err), model);
          } catch (saveErr) {
            logger.error("Could not record failed triage", { threadId: id, err: String(saveErr) });
          }
        }
      }
    }
  }

  await Promise.all(Array.from({ length: opts.concurrency ?? 4 }, worker));
  return stats;
}

/**
 * Close triage items whose threads are no longer in the inbox (and reopen ones
 * that came back). Never throws: a failed sync just leaves the view stale.
 */
export async function syncInboxState(
  gmail: gmail_v1.Gmail,
): Promise<{ closed: number; reopened: number; complete: boolean } | null> {
  try {
    const { ids, complete } = await inboxSnapshot(gmail);
    // If the inbox is bigger than we listed, don't close anything we merely didn't see.
    const res = await reconcileWithInbox(ids, { allowClose: complete });
    if (res.closed || res.reopened) logger.info("Inbox sync", { ...res, complete });
    return { ...res, complete };
  } catch (err) {
    logger.error("Inbox sync failed", { err: String(err) });
    return null;
  }
}
