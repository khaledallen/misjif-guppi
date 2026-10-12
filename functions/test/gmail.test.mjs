// Unit tests for note-to-self detection and thread rendering. Run after `npm run build` (imports lib/).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const G = require("../lib/gmail.js");
const T = require("../lib/triage.js");

const ME = "Khaled Allen <khaled.allen@gmail.com>";

test("addresses extracts, lowercases and drops +tags", () => {
  assert.deepEqual(G.addresses('"Allen, Khaled" <Khaled.Allen+guppi@gmail.com>, bob@example.com'), [
    "khaled.allen@gmail.com",
    "bob@example.com",
  ]);
  assert.deepEqual(G.addresses(""), []);
});

test("isNoteToSelf only when every recipient is the sender", () => {
  assert.ok(G.isNoteToSelf(ME, ["khaled.allen@gmail.com", "", ""]));
  assert.ok(G.isNoteToSelf(ME, ["Khaled Allen <khaled.allen+todo@gmail.com>", "", "khaled.allen@gmail.com"]));
  assert.ok(!G.isNoteToSelf(ME, ["bob@example.com", "", "khaled.allen@gmail.com"]));
  assert.ok(!G.isNoteToSelf(ME, ["khaled.allen@gmail.com", "bob@example.com", ""]));
  assert.ok(!G.isNoteToSelf(ME, ["", "", ""]));
  assert.ok(!G.isNoteToSelf("", ["khaled.allen@gmail.com"]));
});

function msg(over) {
  return { id: "m", from: ME, to: "", cc: "", date: "", subject: "s", body: "b", sentByMe: false, noteToSelf: false, ...over };
}
function thread(messages, receivedAt = "2026-10-10T12:00:00Z") {
  return { threadId: "t1", lastMessageId: "m", subject: "s", from: ME, receivedAt, inInbox: true, repliedBefore: false, messages };
}
const NOW = Date.parse("2026-10-12T13:00:00Z");

test("renderThread marks who sent the latest message and how long ago", () => {
  const incoming = T.renderThread(thread([msg({ from: "bob@example.com" })]), NOW);
  assert.match(incoming, /latest_message_from="other" days_since_latest_message="2"/);

  const note = T.renderThread(thread([msg({ sentByMe: true, noteToSelf: true })]), NOW);
  assert.match(note, /latest_message_from="khaled_note_to_self"/);
  assert.match(note, /note_to_self="true"/);

  const sent = T.renderThread(thread([msg({ from: "bob@example.com" }), msg({ sentByMe: true })], "2026-10-12T09:00:00Z"), NOW);
  assert.match(sent, /latest_message_from="khaled" days_since_latest_message="0"/);
});
