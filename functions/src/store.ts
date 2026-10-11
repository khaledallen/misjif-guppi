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
//   corrections/{auto}  reserved for phase 2 (conversation loop)

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

export async function setPriorities(markdown: string): Promise<void> {
  await priorities.set({ markdown, updatedAt: FieldValue.serverTimestamp() });
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
  return snap.exists && snap.get("lastMessageId") === lastMessageId;
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
  };
  await db.doc(`triage/${thread.threadId}`).set(record);
}

export async function recentTriage(limit = 300): Promise<TriageRecord[]> {
  const snap = await db.collection("triage").orderBy("triagedAt", "desc").limit(limit).get();
  return snap.docs.map((d) => d.data() as TriageRecord);
}
