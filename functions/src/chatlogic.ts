// Pure logic for the chat layer: no Firebase, Gmail or Anthropic imports, so it
// can be unit-tested in isolation (see functions/test/chatlogic.test.mjs).

/** A session ends after this much inactivity; the next message starts a new one. */
export const SESSION_IDLE_MS = 4 * 60 * 60 * 1000;

/** Max earlier messages replayed at the start of a turn (safety cap; see planHistory). */
export const MAX_HISTORY_MESSAGES = 40;

/**
 * True if the user's whole message is a plain confirmation. Deliberately strict:
 * "yes but change X" is NOT a confirmation. This is the server-side gate for
 * applying a pending priorities change; the model cannot open it.
 */
export function isAffirmative(text: string): boolean {
  return /^\s*(y|yes|yep|yeah|yup|apply|apply it|do it|confirm|confirmed|approve|approved|go ahead|ok|okay|sure|sounds good)\s*[.!]*\s*$/i.test(
    text,
  );
}

/**
 * True if the user states a standing rule ("always", "from now on"). Per the
 * agreed design, a proposal created in the same turn as such a message may be
 * applied without a separate "yes".
 */
export function isStandingInstruction(text: string): boolean {
  return /\b(always|from now on|going forward|in (the )?future|every time|whenever)\b/i.test(text);
}

export type StoredMessage = { role: "user" | "assistant" | "system"; content: unknown };

/** A user message that is the start of a turn (plain text, not a tool_result). */
export function isUserTurnStart(m: StoredMessage): boolean {
  if (m.role !== "user") return false;
  if (typeof m.content === "string") return true;
  return Array.isArray(m.content) && !m.content.some((b: { type?: string }) => b?.type === "tool_result");
}

/**
 * Keep at most `max` trailing messages, cut at a user-turn boundary so a
 * tool_use is never separated from its tool_result.
 */
export function trimHistory<T extends StoredMessage>(messages: T[], max = MAX_HISTORY_MESSAGES): T[] {
  if (messages.length <= max) return messages;
  for (let start = messages.length - max; start < messages.length; start++) {
    if (isUserTurnStart(messages[start])) return messages.slice(start);
  }
  // Last resort: start at the final user turn.
  for (let i = messages.length - 1; i >= 0; i--) if (isUserTurnStart(messages[i])) return messages.slice(i);
  return [];
}

// Thinking blocks are bound to the exact conversation that produced them: the
// system prompt, the tools, and every earlier message. Replaying one after any
// of those changed is a 400 ("bound to a different conversation"). So the
// replayed history must be append-only; these helpers keep it that way.

/** Which stored messages to replay: from `start`, with thinking removed from those before `thinkingFrom`. */
export interface HistoryWindow {
  start: number;
  thinkingFrom: number;
}

const THINKING_TYPES = new Set(["thinking", "redacted_thinking"]);

/** Drop thinking blocks from an assistant message; text and tool_use blocks stay. */
export function stripThinking<T extends StoredMessage>(m: T): T {
  if (m.role !== "assistant" || !Array.isArray(m.content)) return m;
  const content = m.content.filter((b: { type?: string }) => !THINKING_TYPES.has(b?.type ?? ""));
  if (content.length === m.content.length) return m;
  return { ...m, content: content.length ? content : [{ type: "text", text: "[No reply.]" }] };
}

/**
 * Called once per turn, before the new user message. The window only moves when
 * the stored history outgrows `max`; it then jumps forward to keep about half, so
 * cuts are rare. A cut changes the prefix every kept thinking block was produced
 * from, so their thinking is stripped (from then on, every turn) and blocks
 * produced after the cut stay valid.
 */
export function planHistory(messages: StoredMessage[], win: HistoryWindow, max = MAX_HISTORY_MESSAGES): HistoryWindow {
  if (messages.length - win.start <= max) return win;
  const kept = trimHistory(messages.slice(win.start), Math.floor(max / 2));
  return { start: messages.length - kept.length, thinkingFrom: messages.length };
}

/** The messages to send for a window: deterministic, so it is identical on every request until the next cut. */
export function replayHistory<T extends StoredMessage>(messages: T[], win: HistoryWindow): T[] {
  return messages.slice(win.start).map((m, k) => (win.start + k < win.thinkingFrom ? stripThinking(m) : m));
}

/** Should the next message start a new session? */
export function shouldStartNewSession(lastActiveMs: number | null, nowMs: number, mode: "auto" | "new" | "continue"): boolean {
  if (mode === "new") return true;
  if (lastActiveMs === null) return true;
  if (mode === "continue") return false;
  return nowMs - lastActiveMs > SESSION_IDLE_MS;
}

/**
 * Line-based unified-style diff with `context` lines around changes.
 * Small LCS implementation; priorities docs are a page or two.
 */
export function lineDiff(before: string, after: string, context = 2): string {
  const a = before.replace(/\n$/, "").split("\n");
  const b = after.replace(/\n$/, "").split("\n");
  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  type Op = { t: " " | "-" | "+"; s: string };
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ t: " ", s: a[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) ops.push({ t: "-", s: a[i++] });
    else ops.push({ t: "+", s: b[j++] });
  }
  while (i < n) ops.push({ t: "-", s: a[i++] });
  while (j < m) ops.push({ t: "+", s: b[j++] });

  if (!ops.some((o) => o.t !== " ")) return "";
  const keep = new Array<boolean>(ops.length).fill(false);
  ops.forEach((o, k) => {
    if (o.t === " ") return;
    for (let x = Math.max(0, k - context); x <= Math.min(ops.length - 1, k + context); x++) keep[x] = true;
  });
  const out: string[] = [];
  let skipped = false;
  ops.forEach((o, k) => {
    if (keep[k]) {
      if (skipped) out.push("  …");
      skipped = false;
      out.push(`${o.t} ${o.s}`);
    } else skipped = true;
  });
  if (skipped) out.push("  …");
  return out.join("\n");
}

/** Append a dated line under "## Corrections log" (creating the section if absent). */
export function appendCorrection(markdown: string, note: string, dateIso: string): string {
  const line = `- ${dateIso.slice(0, 10)}: ${note.replace(/\s+/g, " ").trim()}`;
  const doc = markdown.replace(/\s+$/, "");
  const header = /^##\s+Corrections log\s*$/im;
  const match = header.exec(doc);
  if (!match) return `${doc}\n\n## Corrections log\n${line}\n`;
  // Insert at the end of that section (before the next "## " heading, or EOF).
  const after = doc.slice(match.index + match[0].length);
  const next = /\n##\s+/.exec(after);
  const insertAt = match.index + match[0].length + (next ? next.index : after.length);
  return `${doc.slice(0, insertAt).replace(/\s+$/, "")}\n${line}\n${doc.slice(insertAt)}`.replace(/\s+$/, "") + "\n";
}
