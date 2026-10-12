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
  for (const s of ["yes but make it high", "no", "yes, and also archive it", "maybe", "", "yesterday", "apply the other one"]) {
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
