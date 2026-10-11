import * as logger from "firebase-functions/logger";
import type { gmail_v1 } from "googleapis";
import { fetchThread } from "./gmail";
import { triageThread } from "./triage";
import { alreadyTriaged, getPriorities, saveTriage } from "./store";

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
      try {
        const thread = await fetchThread(gmail, id);
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
      }
    }
  }

  await Promise.all(Array.from({ length: opts.concurrency ?? 4 }, worker));
  return stats;
}
