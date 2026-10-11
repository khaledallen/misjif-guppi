import { google, gmail_v1 } from "googleapis";
import { GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN } from "./config";

// Phase 1 is READ-ONLY. The refresh token is minted with the gmail.readonly
// scope only, so even a bug here cannot modify, archive or send mail.

const MAX_BODY_CHARS = 2000;
const MESSAGES_PER_THREAD = 3;

export interface SimpleMessage {
  id: string;
  from: string;
  to: string;
  cc: string;
  date: string;
  subject: string;
  body: string;
  sentByMe: boolean;
}

export interface SimpleThread {
  threadId: string;
  lastMessageId: string;
  subject: string;
  from: string;
  receivedAt: string;
  inInbox: boolean;
  repliedBefore: boolean;
  messages: SimpleMessage[]; // last N, oldest first
}

export function gmailClient(): gmail_v1.Gmail {
  const auth = new google.auth.OAuth2(GMAIL_CLIENT_ID.value(), GMAIL_CLIENT_SECRET.value());
  auth.setCredentials({ refresh_token: GMAIL_REFRESH_TOKEN.value() });
  return google.gmail({ version: "v1", auth });
}

export async function startWatch(gmail: gmail_v1.Gmail, topic: string) {
  const project = process.env.GCLOUD_PROJECT ?? process.env.GCP_PROJECT;
  if (!project) throw new Error("No GCP project id in environment");
  const res = await gmail.users.watch({
    userId: "me",
    requestBody: {
      topicName: `projects/${project}/topics/${topic}`,
      labelIds: ["INBOX"],
      labelFilterBehavior: "INCLUDE",
    },
  });
  return { historyId: String(res.data.historyId), expiration: Number(res.data.expiration) };
}

export class HistoryExpiredError extends Error {}

/** Thread ids with new INBOX messages since startHistoryId, plus the newest historyId. */
export async function threadsChangedSince(
  gmail: gmail_v1.Gmail,
  startHistoryId: string,
): Promise<{ threadIds: string[]; latestHistoryId: string }> {
  const threadIds = new Set<string>();
  let pageToken: string | undefined;
  let latestHistoryId = startHistoryId;
  try {
    do {
      const res = await gmail.users.history.list({
        userId: "me",
        startHistoryId,
        historyTypes: ["messageAdded"],
        labelId: "INBOX",
        pageToken,
      });
      for (const h of res.data.history ?? []) {
        for (const added of h.messagesAdded ?? []) {
          const m = added.message;
          if (m?.threadId && m.labelIds?.includes("INBOX")) threadIds.add(m.threadId);
        }
      }
      if (res.data.historyId) latestHistoryId = String(res.data.historyId);
      pageToken = res.data.nextPageToken ?? undefined;
    } while (pageToken);
  } catch (err: unknown) {
    if ((err as { code?: number }).code === 404) throw new HistoryExpiredError("historyId too old");
    throw err;
  }
  return { threadIds: [...threadIds], latestHistoryId };
}

export async function listInboxThreadIds(gmail: gmail_v1.Gmail, max: number, query = "in:inbox"): Promise<string[]> {
  const ids: string[] = [];
  let pageToken: string | undefined;
  while (ids.length < max) {
    const res = await gmail.users.threads.list({
      userId: "me",
      q: query,
      maxResults: Math.min(100, max - ids.length),
      pageToken,
    });
    for (const t of res.data.threads ?? []) if (t.id) ids.push(t.id);
    pageToken = res.data.nextPageToken ?? undefined;
    if (!pageToken) break;
  }
  return ids;
}

export async function fetchThread(gmail: gmail_v1.Gmail, threadId: string): Promise<SimpleThread | null> {
  const res = await gmail.users.threads.get({ userId: "me", id: threadId, format: "full" });
  const all = res.data.messages ?? [];
  if (all.length === 0) return null;

  const simple = all.map(toSimpleMessage);
  const recent = simple.slice(-MESSAGES_PER_THREAD);
  const last = all[all.length - 1];
  const lastIncoming = [...simple].reverse().find((m) => !m.sentByMe) ?? simple[simple.length - 1];

  return {
    threadId,
    lastMessageId: last.id ?? "",
    subject: simple[0].subject,
    from: lastIncoming.from,
    receivedAt: new Date(Number(last.internalDate ?? Date.now())).toISOString(),
    inInbox: all.some((m) => m.labelIds?.includes("INBOX")),
    repliedBefore: simple.some((m) => m.sentByMe),
    messages: recent,
  };
}

function toSimpleMessage(m: gmail_v1.Schema$Message): SimpleMessage {
  const headers = m.payload?.headers ?? [];
  const h = (name: string) => headers.find((x) => x.name?.toLowerCase() === name)?.value ?? "";
  return {
    id: m.id ?? "",
    from: h("from"),
    to: h("to"),
    cc: h("cc"),
    date: h("date"),
    subject: h("subject"),
    body: truncate(extractBody(m.payload) || m.snippet || "", MAX_BODY_CHARS),
    sentByMe: !!m.labelIds?.includes("SENT"),
  };
}

function extractBody(part: gmail_v1.Schema$MessagePart | undefined): string {
  if (!part) return "";
  const plain = findPart(part, "text/plain");
  if (plain) return stripQuoted(decode(plain));
  const html = findPart(part, "text/html");
  if (html) return stripQuoted(htmlToText(decode(html)));
  return "";
}

function findPart(part: gmail_v1.Schema$MessagePart, mime: string): string | null {
  if (part.mimeType === mime && part.body?.data) return part.body.data;
  for (const p of part.parts ?? []) {
    const found = findPart(p, mime);
    if (found) return found;
  }
  return null;
}

function decode(data: string): string {
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/p>|<\/div>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"');
}

/** Drop quoted reply history ("On ... wrote:" and "> " lines) — earlier messages are sent separately. */
function stripQuoted(text: string): string {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  for (const line of lines) {
    if (/^On .+wrote:\s*$/.test(line.trim())) break;
    if (line.startsWith(">")) continue;
    out.push(line);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + " …[truncated]" : s;
}
