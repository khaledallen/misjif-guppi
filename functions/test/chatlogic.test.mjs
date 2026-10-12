// Unit tests for the pure chat logic. Run after `npm run build` (imports lib/).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const L = require(process.env.CHATLOGIC_PATH || "../lib/chatlogic.js");

test("isAffirmative accepts only plain confirmations", () => {
  for (const s of ["yes", "Yes.", "y", "apply", "do it", "ok!", "go ahead", "  sure  ", "sounds good"]) {
    assert.ok(L.isAffirmative(s), s);
  }
  for (const s of [
    "yes but make it high",
    "no",
    "yes, and also archive it",
    "maybe",
    "",
    "yesterday",
    "apply the other one",
  ]) {
    assert.ok(!L.isAffirmative(s), s);
  }
});

test("isStandingInstruction", () => {
  assert.ok(L.isStandingInstruction("Recruiters are always low unless I'm interviewing there"));
  assert.ok(L.isStandingInstruction("from now on treat the flight school as high"));
  assert.ok(!L.isStandingInstruction("make this one high"));
});

test("trimHistory never splits tool_use from tool_result", () => {
  const msgs = [];
  for (let k = 0; k < 30; k++) {
    msgs.push({ role: "user", content: `q${k}` });
    msgs.push({ role: "assistant", content: [{ type: "tool_use", id: `t${k}`, name: "x", input: {} }] });
    msgs.push({ role: "user", content: [{ type: "tool_result", tool_use_id: `t${k}`, content: "r" }] });
    msgs.push({ role: "assistant", content: [{ type: "text", text: `a${k}` }] });
  }
  const t = L.trimHistory(msgs, 40);
  assert.ok(t.length <= 40);
  assert.equal(t[0].role, "user");
  assert.equal(typeof t[0].content, "string");
  assert.equal(t[t.length - 1].content[0].text, "a29");
  const short = [{ role: "user", content: "hi" }];
  assert.deepEqual(L.trimHistory(short, 40), short);
});

test("shouldStartNewSession", () => {
  const now = Date.now();
  const H = 3600_000;
  assert.equal(L.shouldStartNewSession(null, now, "auto"), true);
  assert.equal(L.shouldStartNewSession(now - 1 * H, now, "auto"), false);
  assert.equal(L.shouldStartNewSession(now - 5 * H, now, "auto"), true);
  assert.equal(L.shouldStartNewSession(now - 5 * H, now, "continue"), false);
  assert.equal(L.shouldStartNewSession(now - 1 * H, now, "new"), true);
});

test("lineDiff shows changes with context and is empty when equal", () => {
  const before = "# P\n## People\n- a\n- b\n- c\n- d\n- e\n## Rules\n- r1\n";
  const after = "# P\n## People\n- a\n- b\n- c\n- d\n- e\n## Rules\n- r1\n- recruiters low unless interviewing\n";
  const d = L.lineDiff(before, after);
  assert.match(d, /^\+ - recruiters low unless interviewing$/m);
  assert.match(d, /^  - r1$/m);
  assert.ok(!/^  # P$/m.test(d), "far context omitted");
  assert.equal(L.lineDiff(before, before), "");
  const changed = L.lineDiff("x\ny\n", "x\nz\n");
  assert.match(changed, /^- y$/m);
  assert.match(changed, /^\+ z$/m);
});

test("appendCorrection adds to the existing section, before the next heading", () => {
  const md = "# P\n## Corrections log\n- 2026-10-01: old\n\n## Other\n- x\n";
  const out = L.appendCorrection(md, "Recruiters low  unless\ninterviewing", "2026-10-11T00:00:00Z");
  assert.match(out, /- 2026-10-01: old\n- 2026-10-11: Recruiters low unless interviewing\n/);
  assert.ok(out.indexOf("2026-10-11") < out.indexOf("## Other"));
  const noSection = L.appendCorrection("# P\n- r\n", "note", "2026-10-11");
  assert.match(noSection, /## Corrections log\n- 2026-10-11: note\n$/);
});

test("stripThinking removes thinking blocks only from assistant messages", () => {
  const a = {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "", signature: "s1" },
      { type: "text", text: "ok" },
      { type: "redacted_thinking", data: "x" },
      { type: "tool_use", id: "t1", name: "x", input: {} },
    ],
  };
  assert.deepEqual(
    L.stripThinking(a).content.map((b) => b.type),
    ["text", "tool_use"],
  );
  assert.equal(a.content.length, 4, "input not mutated");
  const onlyThinking = { role: "assistant", content: [{ type: "thinking", thinking: "", signature: "s" }] };
  assert.deepEqual(L.stripThinking(onlyThinking).content, [{ type: "text", text: "[No reply.]" }]);
  const user = { role: "user", content: "hi" };
  assert.equal(L.stripThinking(user), user);
});

// One stored turn: user, system context, assistant tool call (with thinking), tool result, assistant reply.
function turn(k) {
  return [
    { role: "user", content: `q${k}` },
    { role: "system", content: `ctx${k}` },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "", signature: `s${k}a` },
        { type: "tool_use", id: `t${k}`, name: "x", input: {} },
      ],
    },
    { role: "user", content: [{ type: "tool_result", tool_use_id: `t${k}`, content: "r" }] },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "", signature: `s${k}b` },
        { type: "text", text: `a${k}` },
      ],
    },
  ];
}
const hasThinking = (m) => Array.isArray(m.content) && m.content.some((b) => b.type === "thinking");

test("replayed history is append-only between cuts; a cut strips the kept turns' thinking", () => {
  let stored = [];
  let win = { start: 0, thinkingFrom: 0 };
  let prev = null;
  let cuts = 0;
  for (let k = 0; k < 30; k++) {
    const next = L.planHistory(stored, win, 40);
    const replay = L.replayHistory(stored, next);
    if (next.start === win.start) {
      // Same window: what was sent last turn is an exact prefix of what is sent now.
      if (prev) assert.deepEqual(replay.slice(0, prev.length), prev, `turn ${k} edited history`);
    } else {
      cuts++;
      assert.ok(next.start > win.start);
      assert.equal(next.thinkingFrom, stored.length);
      assert.ok(!replay.some(hasThinking), "kept turns lose their thinking at a cut");
      assert.ok(L.isUserTurnStart(replay[0]), "window starts at a user turn");
    }
    assert.ok(replay.length <= 40);
    win = next;
    const sent = [...replay, ...turn(k)];
    stored = [...stored, ...turn(k)];
    prev = sent;
  }
  assert.ok(cuts >= 2 && cuts <= 8, `cuts should be rare, got ${cuts}`);
  // Thinking produced after the last cut is replayed intact.
  const afterCut = L.replayHistory(stored, win).slice(win.thinkingFrom - win.start);
  assert.ok(afterCut.length > 0 && afterCut.some(hasThinking));
});

test("skippedToolResults answers every pending tool_use, so the stored turn replays cleanly", () => {
  const last = {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "", signature: "s" },
      { type: "text", text: "Checking both." },
      { type: "tool_use", id: "t1", name: "get_triage", input: {} },
      { type: "tool_use", id: "t2", name: "list_triage", input: {} },
    ],
  };
  const skipped = L.skippedToolResults(last.content, "Stopped.");
  assert.deepEqual(skipped, [
    { type: "tool_result", tool_use_id: "t1", content: "Stopped.", is_error: true },
    { type: "tool_result", tool_use_id: "t2", content: "Stopped.", is_error: true },
  ]);
  assert.equal(last.content.length, 4, "assistant message not edited");
  // Appended as its own user message: not a turn start, so no cut can land between it and the tool_use.
  const closing = { role: "user", content: skipped };
  assert.ok(!L.isUserTurnStart(closing));
  const stored = [...turn(0), { role: "user", content: "q1" }, last, closing, { role: "user", content: "q2" }];
  for (let i = 0; i < stored.length; i++) {
    const m = stored[i];
    if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
    const ids = m.content.filter((b) => b.type === "tool_use").map((b) => b.id);
    if (!ids.length) continue;
    const next = stored[i + 1]?.content;
    const answered = Array.isArray(next) ? next.filter((b) => b.type === "tool_result").map((b) => b.tool_use_id) : [];
    assert.deepEqual(answered, ids, `tool_use at ${i} answered in the next message`);
  }
  assert.deepEqual(L.skippedToolResults([{ type: "text", text: "done" }], "x"), []);
  assert.deepEqual(L.skippedToolResults("plain text", "x"), []);
});

test("planHistory leaves short histories alone", () => {
  const stored = [...turn(0), ...turn(1)];
  const win = { start: 0, thinkingFrom: 0 };
  assert.equal(L.planHistory(stored, win, 40), win);
  assert.deepEqual(L.replayHistory(stored, win), stored);
  // A legacy session replays without thinking from before thinkingFrom.
  const legacy = L.replayHistory(stored, { start: 0, thinkingFrom: stored.length });
  assert.ok(!legacy.some(hasThinking));
  assert.equal(legacy.length, stored.length);
});
