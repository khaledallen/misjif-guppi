import { readFileSync } from "fs";
import * as path from "path";
import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import type { TriageResult } from "./triage";
import type { SimpleThread } from "./gmail";

if (getApps().length === 0) initializeApp();
export const db = getFirestore();

// Collections:
//   config/priorities   { markdown, updatedAt }
//   state/gmail         { historyId, watchExpiration, updatedAt }
//   triage/{threadId}   TriageRecord
//   priorities_history/{auto}  { markdown, savedAt, source, reason } — previous versions
//   conversations/{id}  chat sessions (see chat.ts); messages in a subcollection
//   state/chat          { currentId }

const priorities = db.doc("config/priorities");
const gmailState = db.doc("state/gmail");

export interface TriageRecord extends TriageResult {
  threadId: string;
  lastMessageId: string;
  from: string;
  subject: string;
  receivedAt: string;
  triagedAt: string;
  model: string;
  status: "open" | "done" | "dismissed";
  closedReason?: "left_inbox" | null;
  closedAt?: string | null;
}

export async function getPriorities(): Promise<string> {
  const snap = await priorities.get();
  const md = snap.exists ? (snap.get("markdown") as string | undefined) : undefined;
  if (md) return md;
  // First run: seed from the bundled default.
  const seeded = readFileSync(path.join(__dirname, "..", "prompts", "priorities.default.md"), "utf8");
  await priorities.set({ markdown: seeded, updatedAt: FieldValue.serverTimestamp() });
  return seeded;
}

export interface PrioritiesVersion {
  id: string;
  savedAt: string;
  source: string; // "api" | "chat" | "restore"
  reason: string;
  chars: number;
  markdown?: string;
}

/**
 * Replace the priorities doc, first saving the current version to
 * priorities_history so any change (by Khaled or by GUPPI) can be rolled back.
 */
export async function setPriorities(markdown: string, meta: { source?: string; reason?: string } = {}): Promise<void> {
  const snap = await priorities.get();
  const previous = snap.exists ? (snap.get("markdown") as string | undefined) : undefined;
  if (previous !== undefined) {
    await db.collection("priorities_history").add({
      markdown: previous,
      savedAt: new Date().toISOString(),
      source: meta.source ?? "api",
      reason: meta.reason ?? "",
      chars: previous.length,
    });
  }
  await priorities.set({ markdown, updatedAt: FieldValue.serverTimestamp() });
}

/** Most recent first. Each entry is the doc as it was BEFORE that change. */
export async function prioritiesHistory(limit = 20, withMarkdown = false): Promise<PrioritiesVersion[]> {
  const snap = await db.collection("priorities_history").orderBy("savedAt", "desc").limit(limit).get();
  return snap.docs.map((d) => {
    const v = d.data();
    return {
      id: d.id,
      savedAt: v.savedAt,
      source: v.source,
      reason: v.reason,
      chars: v.chars,
      ...(withMarkdown ? { markdown: v.markdown } : {}),
    };
  });
}

export async function restorePriorities(versionId: string): Promise<PrioritiesVersion> {
  const doc = await db.doc(`priorities_history/${versionId}`).get();
  if (!doc.exists) throw new Error(`No priorities version ${versionId}`);
  const v = doc.data() as { markdown: string; savedAt: string };
  await setPriorities(v.markdown, { source: "restore", reason: `restored version from ${v.savedAt}` });
  return { id: doc.id, savedAt: v.savedAt, source: "restore", reason: "", chars: v.markdown.length };
}

export async function getHistoryId(): Promise<string | null> {
  const snap = await gmailState.get();
  return snap.exists ? ((snap.get("historyId") as string | undefined) ?? null) : null;
}

export async function setGmailState(update: { historyId?: string; watchExpiration?: number }): Promise<void> {
  await gmailState.set({ ...update, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
}

/** True if this thread's latest message has already been triaged. */
export async function alreadyTriaged(threadId: string, lastMessageId: string): Promise<boolean> {
  const snap = await db.doc(`triage/${threadId}`).get();
  // Failed triage stand-ins don't count: retry them.
  return snap.exists && snap.get("lastMessageId") === lastMessageId && snap.get("rule_applied") !== "triage_failed";
}

export async function saveTriage(thread: SimpleThread, result: TriageResult, model: string): Promise<void> {
  const record: TriageRecord = {
    ...result,
    threadId: thread.threadId,
    lastMessageId: thread.lastMessageId,
    from: thread.from,
    subject: thread.subject,
    receivedAt: thread.receivedAt,
    triagedAt: new Date().toISOString(),
    model,
    status: "open",
    closedReason: null,
    closedAt: null,
  };
  await db.doc(`triage/${thread.threadId}`).set(record);
}

export async function recentTriage(limit = 300, status?: TriageRecord["status"]): Promise<TriageRecord[]> {
  // Filter in memory to avoid needing a composite index (single user, small volume).
  const snap = await db.collection("triage").orderBy("triagedAt", "desc").limit(status ? limit * 3 : limit).get();
  const all = snap.docs.map((d) => d.data() as TriageRecord);
  return (status ? all.filter((r) => (r.status ?? "open") === status) : all).slice(0, limit);
}

/**
 * Align triage status with the real inbox: open items whose thread left the
 * inbox (archived, deleted, filed) become done; items closed that way reopen
 * if the thread comes back. Only the most recent `window` records are checked.
 */
export async function reconcileWithInbox(
  inbox: Set<string>,
  opts: { allowClose: boolean; window?: number },
): Promise<{ closed: number; reopened: number }> {
  const snap = await db.collection("triage").orderBy("triagedAt", "desc").limit(opts.window ?? 500).get();
  const now = new Date().toISOString();
  let batch = db.batch();
  let pending = 0;
  let closed = 0;
  let reopened = 0;
  for (const doc of snap.docs) {
    const r = doc.data() as TriageRecord;
    const inInbox = inbox.has(r.threadId);
    if (r.status === "open" && !inInbox && opts.allowClose) {
      batch.update(doc.ref, { status: "done", closedReason: "left_inbox", closedAt: now });
      closed++;
    } else if (r.status === "done" && r.closedReason === "left_inbox" && inInbox) {
      batch.update(doc.ref, { status: "open", closedReason: null, closedAt: null });
      reopened++;
    } else continue;
    if (++pending === 400) {
      await batch.commit();
      batch = db.batch();
      pending = 0;
    }
  }
  if (pending) await batch.commit();
  return { closed, reopened };
}
