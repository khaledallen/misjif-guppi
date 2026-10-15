// Unit tests for per-hop chat timing. Run after `npm run build` (imports lib/).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const T = require(process.env.TIMING_PATH || "../lib/timing.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("summarize buckets spans; sub-steps are listed but not double-counted", () => {
  const spans = [
    { name: "inbox_sync", bucket: "setup", start_ms: 0, ms: 900 },
    { name: "tool.ask_about_email", bucket: "tools", start_ms: 2000, ms: 1500 },
    { name: "ask_about_email.reader_model", bucket: "sub", start_ms: 2100, ms: 1300 },
    { name: "save_messages", bucket: "save", start_ms: 4900, ms: 100 },
  ];
  const rounds = [
    { round: 0, ms: 1000 },
    { round: 1, ms: 1200 },
  ];
  const t = T.summarize(spans, rounds, 5000, false);
  assert.deepEqual(t.breakdown, { setup_ms: 900, model_ms: 2200, tools_ms: 1500, save_ms: 100, other_ms: 300 });
  assert.equal(t.spans.length, 4);
  assert.ok(
    t.spans.every((s) => !("bucket" in s)),
    "bucket is internal",
  );
  assert.deepEqual(
    t.spans.map((s) => s.name),
    ["inbox_sync", "tool.ask_about_email", "ask_about_email.reader_model", "save_messages"],
  );
});

test("TurnTimer records spans (even on throw) and model usage incl. cache reads", async () => {
  const timer = new T.TurnTimer(true);
  await timer.span("inbox_sync", "setup", () => sleep(15));
  await assert.rejects(timer.span("tool.get_triage", "tools", () => Promise.reject(new Error("boom"))));
  await timer.model(0, async () => ({
    stop_reason: "end_turn",
    usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 4000, cache_creation_input_tokens: null },
  }));
  await timer.sub("ask_about_email")("reader_model", () => sleep(5));
  const t = timer.finish();
  assert.equal(t.cold_start, true);
  assert.ok(t.breakdown.setup_ms >= 10);
  assert.deepEqual(
    t.spans.map((s) => s.name),
    ["inbox_sync", "tool.get_triage", "ask_about_email.reader_model"],
  );
  assert.deepEqual(
    { ...t.model_rounds[0], ms: 0 },
    {
      round: 0,
      ms: 0,
      stop_reason: "end_turn",
      input_tokens: 100,
      output_tokens: 20,
      cache_read_input_tokens: 4000,
      cache_creation_input_tokens: 0,
    },
  );
  assert.ok(t.total_ms >= t.breakdown.setup_ms + t.breakdown.model_ms);
});

test("claimColdStart is true once per instance", () => {
  const first = T.claimColdStart();
  assert.equal(T.claimColdStart(), false);
  assert.equal(typeof first, "boolean");
});
