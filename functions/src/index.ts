import { timingSafeEqual } from "crypto";
import { setGlobalOptions } from "firebase-functions/v2";
import { onRequest } from "firebase-functions/v2/https";
import { onMessagePublished } from "firebase-functions/v2/pubsub";
import { onSchedule } from "firebase-functions/v2/scheduler";
import * as logger from "firebase-functions/logger";
import type { Request } from "firebase-functions/v2/https";

import {
  ALL_SECRETS,
  ANTHROPIC_API_KEY,
  GMAIL_SECRETS,
  GUPPI_API_TOKEN,
  PUBSUB_TOPIC,
  TIMEZONE,
  TRIAGE_MODEL,
} from "./config";
import { gmailClient, HistoryExpiredError, listInboxThreadIds, startWatch, threadsChangedSince } from "./gmail";
import { syncInboxState, triageThreads } from "./pipeline";
import { getHistoryId, getPriorities, recentTriage, setGmailState, setPriorities } from "./store";
import { buildBriefing } from "./briefing";

setGlobalOptions({ region: "us-central1", maxInstances: 3 });

// ---------------------------------------------------------------------------
// 1. Gmail push: Gmail -> Pub/Sub -> here. Triage whatever arrived.
//    maxInstances: 1 so historyId advances in order without races.
// ---------------------------------------------------------------------------
export const gmailPush = onMessagePublished(
  {
    topic: PUBSUB_TOPIC,
    secrets: [ANTHROPIC_API_KEY, ...GMAIL_SECRETS],
    maxInstances: 1,
    timeoutSeconds: 300,
    retry: false,
  },
  async (event) => {
    const payload = event.data.message.json as { emailAddress?: string; historyId?: string | number };
    const gmail = gmailClient();
    const stored = await getHistoryId();

    if (!stored) {
      // No baseline yet: just record where we are. /watch normally sets this.
      if (payload.historyId) await setGmailState({ historyId: String(payload.historyId) });
      return;
    }

    let threadIds: string[];
    let latest: string;
    try {
      ({ threadIds, latestHistoryId: latest } = await threadsChangedSince(gmail, stored));
    } catch (err) {
      if (!(err instanceof HistoryExpiredError)) throw err;
      logger.warn("History expired; falling back to last day of inbox");
      threadIds = await listInboxThreadIds(gmail, 50, "in:inbox newer_than:1d");
      latest = String(payload.historyId ?? stored);
    }

    if (threadIds.length) {
      const stats = await triageThreads(gmail, threadIds, TRIAGE_MODEL.value());
      logger.info("Push triage", stats);
    }
    await setGmailState({ historyId: latest });
    await syncInboxState(gmail);
  },
);

// ---------------------------------------------------------------------------
// 2. Gmail watches expire after 7 days. Renew daily.
// ---------------------------------------------------------------------------
export const renewWatch = onSchedule(
  { schedule: "every day 04:07", timeZone: TIMEZONE, secrets: GMAIL_SECRETS },
  async () => {
    const { historyId, expiration } = await startWatch(gmailClient(), PUBSUB_TOPIC);
    const stored = await getHistoryId();
    await setGmailState({ watchExpiration: expiration, ...(stored ? {} : { historyId }) });
    logger.info("Watch renewed", { expiration: new Date(expiration).toISOString() });
  },
);

// ---------------------------------------------------------------------------
// 3. Private HTTP API (bearer token). Used for setup and grading in phase 1;
//    the chat/voice channels in later phases build on the same core.
//
//   GET  /health
//   POST /watch                       start the Gmail watch + set baseline
//   POST /backfill?n=200&days=30      triage recent inbox threads (read-only)
//         &force=1                    re-triage even if already done
//   GET  /briefing                    GUPPI-format text briefing
//   GET  /triage?limit=200&status=    raw triage records (JSON); status=open|done|dismissed|all (default all)
//   POST /sync                        reconcile open items with the current inbox
//   GET  /priorities                  current priorities markdown
//   PUT  /priorities                  replace it (text/plain body)
// ---------------------------------------------------------------------------
function authorized(req: Request): boolean {
  const header = req.get("authorization") ?? "";
  const given = Buffer.from(header.replace(/^Bearer\s+/i, "").trim());
  // trim(): secrets set via a prompt or pipe often carry a trailing newline
  const expected = Buffer.from(GUPPI_API_TOKEN.value().trim());
  return given.length === expected.length && expected.length > 0 && timingSafeEqual(given, expected);
}

export const api = onRequest(
  { secrets: ALL_SECRETS, timeoutSeconds: 540, memory: "512MiB", maxInstances: 2 },
  async (req, res) => {
    const route = `${req.method} ${req.path.replace(/\/+$/, "") || "/"}`;

    if (route === "GET /health") {
      res.send("[Operational.]");
      return;
    }
    if (!authorized(req)) {
      res.status(401).send("[Unauthorized.]");
      return;
    }

    try {
      switch (route) {
        case "POST /watch": {
          const { historyId, expiration } = await startWatch(gmailClient(), PUBSUB_TOPIC);
          const stored = await getHistoryId();
          await setGmailState({ watchExpiration: expiration, ...(stored ? {} : { historyId }) });
          res.json({ status: "[Watch active.]", expiration: new Date(expiration).toISOString() });
          return;
        }
        case "POST /backfill": {
          const n = Math.min(Number(req.query.n ?? 200) || 200, 500);
          const days = Math.min(Number(req.query.days ?? 30) || 30, 365);
          const gmail = gmailClient();
          const ids = await listInboxThreadIds(gmail, n, `in:inbox newer_than:${days}d`);
          const stats = await triageThreads(gmail, ids, TRIAGE_MODEL.value(), {
            concurrency: 5,
            force: req.query.force === "1",
          });
          res.json({ status: "[Backfill complete.]", ...stats });
          return;
        }
        case "GET /briefing": {
          await syncInboxState(gmailClient());
          res.type("text/plain").send(buildBriefing(await recentTriage(300, "open")));
          return;
        }
        case "GET /triage": {
          const limit = Math.min(Number(req.query.limit ?? 200) || 200, 1000);
          const status = req.query.status === "all" ? undefined : ((req.query.status as string) || undefined);
          if (status && !["open", "done", "dismissed"].includes(status)) {
            res.status(400).send("[Rejected. status must be open, done, dismissed or all.]");
            return;
          }
          await syncInboxState(gmailClient());
          res.json(await recentTriage(limit, status as "open" | "done" | "dismissed" | undefined));
          return;
        }
        case "POST /sync": {
          const result = await syncInboxState(gmailClient());
          if (!result) {
            res.status(500).send("[Inbox sync failed. See logs.]");
            return;
          }
          res.json({ status: "[Inbox synced.]", ...result });
          return;
        }
        case "GET /priorities": {
          res.type("text/markdown").send(await getPriorities());
          return;
        }
        case "PUT /priorities": {
          const body = typeof req.body === "string" ? req.body : req.body?.markdown;
          if (typeof body !== "string" || body.trim().length < 20) {
            res.status(400).send("[Rejected. Send the full markdown as text/plain.]");
            return;
          }
          await setPriorities(body);
          res.send("[Priorities updated.]");
          return;
        }
        default:
          res.status(404).send(`[Unknown route: ${route}]`);
      }
    } catch (err) {
      logger.error("API error", { route, err: String(err) });
      res.status(500).send(`[Error. ${String(err).slice(0, 300)}]`);
    }
  },
);
