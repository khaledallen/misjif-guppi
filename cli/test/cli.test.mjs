// End-to-end tests: run the real CLI against a local mock of the GUPPI API,
// with a fake `gcloud` on PATH standing in for Secret Manager.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "guppi.mjs");
const GOOD = "good-token-0123456789";
const PROJECT = "test-proj";

let server;
let base;
let mode = "normal"; // "normal" | "google401"
let priorities = "# Priorities\n- initial rule\n";
let lastTriageStatus = null;
let lastChat = null;

const TRIAGE = [
  {
    threadId: "t1",
    from: '"Pat Recruiter" <pat@stripe.com>',
    subject: "Role",
    summary: "Recruiter outreach for staff role",
    category: "fyi",
    priority: "low",
    confidence: 0.82,
    rule_applied: "Recruiters from companies I'm NOT interviewing with",
    receivedAt: "2026-10-10T10:00:00Z",
    injection_suspected: false,
  },
  {
    threadId: "t2",
    from: "Avionics Shop <quotes@shop.example>",
    subject: "Quote",
    summary: "Panel quote ready, needs approval",
    category: "action",
    priority: "high",
    confidence: 0.91,
    rule_applied: "Avionics upgrade: shop quotes are HIGH",
    receivedAt: "2026-10-11T10:00:00Z",
    injection_suspected: false,
  },
  {
    threadId: "t3",
    from: "random@example.com",
    subject: "Hi",
    summary: "Unclear request from unknown sender",
    category: "fyi",
    priority: "normal",
    confidence: 0.4,
    rule_applied: "judgment",
    receivedAt: "2026-10-09T10:00:00Z",
    injection_suspected: true,
  },
];

before(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/api/health") return res.end("[Operational.]");
    if (mode === "google401") {
      res.writeHead(401, { "www-authenticate": 'Bearer error="invalid_token"', "content-type": "text/html" });
      return res.end("<html><title>401 Unauthorized</title></html>");
    }
    if (req.headers.authorization !== `Bearer ${GOOD}`) {
      res.writeHead(401);
      return res.end("[Unauthorized.]");
    }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const route = `${req.method} ${url.pathname}`;
      switch (route) {
        case "GET /api/briefing":
          return res.end(
            "[Briefing. 1 action item. 0 would be auto-handled. 1 needs your call.]\n1. HIGH | Avionics Shop | Panel quote",
          );
        case "GET /api/triage": {
          lastTriageStatus = url.searchParams.get("status");
          res.setHeader("content-type", "application/json");
          return res.end(JSON.stringify(TRIAGE.slice(0, Number(url.searchParams.get("limit") || 50))));
        }
        case "POST /api/chat": {
          const msg = JSON.parse(body);
          lastChat = msg;
          res.setHeader("content-type", "application/json");
          if (msg.message === "yes") {
            return res.end(
              JSON.stringify({
                conversation_id: "c1",
                session: "continued",
                reply: "[Applied. Re-ranked.]",
                proposals: [],
                tools_used: ["apply_priorities_change"],
                applied: [
                  {
                    diff: "+ - recruiters low unless interviewing",
                    reason: "recruiter rule",
                    retriage: {
                      checked: 5,
                      failed: 0,
                      moved: [
                        {
                          threadId: "t1",
                          from: "Pat <p@x.com>",
                          subject: "Role",
                          before: "normal/fyi",
                          after: "low/fyi",
                        },
                      ],
                    },
                  },
                ],
              }),
            );
          }
          return res.end(
            JSON.stringify({
              conversation_id: "c1",
              session: msg.session === "new" ? "new" : "continued",
              reply: "[1 rule change proposed.]",
              applied: [],
              tools_used: ["propose_priorities_change"],
              proposals: [
                {
                  id: "p1",
                  diff: "  ## Rules\n+ - recruiters low unless interviewing",
                  reason: "recruiter rule",
                  can_apply_now: false,
                },
              ],
            }),
          );
        }
        case "GET /api/chat/session":
          res.setHeader("content-type", "application/json");
          return res.end(
            JSON.stringify({
              conversation_id: "c1",
              lastActiveAt: new Date(Date.now() - 5 * 3600_000).toISOString(),
              idle_expired: true,
              turns: 3,
            }),
          );
        case "GET /api/priorities/history":
          res.setHeader("content-type", "application/json");
          return res.end(
            JSON.stringify([
              { id: "v1", savedAt: "2026-10-11T20:00:00.000Z", source: "chat", reason: "recruiter rule", chars: 1200 },
            ]),
          );
        case "POST /api/priorities/restore":
          res.setHeader("content-type", "application/json");
          return res.end(
            JSON.stringify({
              status: "[Priorities restored.]",
              restored: { id: url.searchParams.get("id"), savedAt: "2026-10-11T20:00:00.000Z" },
            }),
          );
        case "POST /api/sync":
          res.setHeader("content-type", "application/json");
          return res.end(JSON.stringify({ status: "[Inbox synced.]", closed: 4, reopened: 1, complete: true }));
        case "GET /api/priorities":
          return res.end(priorities);
        case "PUT /api/priorities":
          priorities = body;
          return res.end("[Priorities updated.]");
        case "POST /api/backfill":
          res.setHeader("content-type", "application/json");
          return res.end(
            JSON.stringify({
              status: "[Backfill complete.]",
              seen: Number(url.searchParams.get("n")),
              triaged: 3,
              skipped: 1,
              failed: url.searchParams.get("force") ? 1 : 0,
            }),
          );
        case "POST /api/watch":
          res.setHeader("content-type", "application/json");
          return res.end(JSON.stringify({ status: "[Watch active.]", expiration: "2026-10-19T00:00:00.000Z" }));
        default:
          res.writeHead(404);
          return res.end(`[Unknown route: ${route}]`);
      }
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}/api`;
});

after(() => server.close());

/** Fresh sandbox: config dir + fake gcloud that serves `token` from "Secret Manager". */
function sandbox(token = GOOD) {
  const root = mkdtempSync(join(tmpdir(), "guppi-test-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "gcloud"),
    `#!/bin/sh
case "$*" in
  "config get-value project") echo "${PROJECT}" ;;
  "secrets versions access latest --secret=GUPPI_API_TOKEN --project=${PROJECT}") printf '%s\\n' "${token}" ;;
  *) echo "unexpected: $*" >&2; exit 1 ;;
esac
`,
  );
  chmodSync(join(bin, "gcloud"), 0o755);
  return {
    root,
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      HOME: root,
      XDG_CONFIG_HOME: join(root, "config"),
      GUPPI_NO_KEYCHAIN: "1",
    },
  };
}

function cli(args, env, input) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input ?? "");
  });
}

async function initialized(token = GOOD) {
  const sb = sandbox(token);
  const r = await cli(["init", "--project", PROJECT, "--api", base], sb.env);
  assert.equal(r.code, 0, r.stderr);
  return sb;
}

test("init saves config, caches token from Secret Manager, verifies auth", async () => {
  const sb = sandbox();
  const r = await cli(["init", "--api", base], sb.env); // project from `gcloud config get-value project`
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /GUPPI is ready/);
  const cfg = JSON.parse(readFileSync(join(sb.env.XDG_CONFIG_HOME, "guppi", "config.json"), "utf8"));
  assert.equal(cfg.project, PROJECT);
  assert.equal(cfg.api, base);
  const tokenFile = join(sb.env.XDG_CONFIG_HOME, "guppi", `token-${PROJECT}`);
  assert.equal(readFileSync(tokenFile, "utf8"), GOOD);
  assert.ok(!r.stdout.includes(GOOD) && !r.stderr.includes(GOOD), "token must never be printed");
});

test("briefing works with no env vars after init", async () => {
  const sb = await initialized();
  const r = await cli(["briefing"], sb.env);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /\[Briefing\. 1 action item/);
});

test("stale cached token is refreshed from Secret Manager automatically", async () => {
  const sb = await initialized();
  const tokenFile = join(sb.env.XDG_CONFIG_HOME, "guppi", `token-${PROJECT}`);
  writeFileSync(tokenFile, "stale-token");
  const r = await cli(["briefing"], sb.env);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(readFileSync(tokenFile, "utf8"), GOOD);
});

test("Secret Manager token that doesn't match the function gives a clear error", async () => {
  const sb = await initialized();
  // Simulate the secret being rotated without a redeploy.
  const sb2 = sandbox("rotated-but-not-deployed");
  writeFileSync(join(sb.env.XDG_CONFIG_HOME, "guppi", `token-${PROJECT}`), "stale-token");
  const r = await cli(["briefing"], { ...sb.env, PATH: sb2.env.PATH });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /does not match the deployed function/);
});

test("wrong GUPPI_TOKEN override is reported as such", async () => {
  const sb = await initialized();
  const r = await cli(["briefing"], { ...sb.env, GUPPI_TOKEN: "nope" });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /\$GUPPI_TOKEN is wrong/);
});

test("Google front-end 401 explains the invoker fix", async () => {
  const sb = await initialized();
  mode = "google401";
  try {
    const r = await cli(["briefing"], sb.env);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /not publicly invokable/);
    assert.match(r.stderr, /add-iam-policy-binding api/);
    assert.match(r.stderr, new RegExp(`--project=${PROJECT}`));
  } finally {
    mode = "normal";
  }
});

test("unreachable API gives a clear error", async () => {
  const sb = await initialized();
  const r = await cli(["briefing"], { ...sb.env, GUPPI_API: "http://127.0.0.1:1/api" });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /API unreachable/);
});

test("not configured", async () => {
  const sb = sandbox();
  const r = await cli(["briefing"], sb.env);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /Run: guppi init/);
});

test("triage table sorts by priority and flags judgment + injection", async () => {
  const sb = await initialized();
  const r = await cli(["triage"], sb.env);
  assert.equal(r.code, 0, r.stderr);
  const lines = r.stdout.trim().split("\n");
  assert.match(lines[0], /^PRIO/);
  assert.match(lines[1], /^high/);
  assert.match(lines[2], /^normal.*judgment.*⚠/);
  assert.match(lines[3], /^low/);
  assert.match(r.stdout, /1 of 3 decided by judgment/);

  const j = await cli(["triage", "--judgment"], sb.env);
  assert.equal(
    j.stdout
      .trim()
      .split("\n")
      .filter((l) => /^(top|high|normal|low)/.test(l)).length,
    1,
  );

  const json = await cli(["triage", "--json", "--limit", "2"], sb.env);
  assert.equal(JSON.parse(json.stdout).length, 2);
});

test("triage defaults to open threads; --all includes handled ones", async () => {
  const sb = await initialized();
  await cli(["triage"], sb.env);
  assert.equal(lastTriageStatus, "open");
  await cli(["triage", "--all"], sb.env);
  assert.equal(lastTriageStatus, "all");
});

test("sync", async () => {
  const sb = await initialized();
  const r = await cli(["sync"], sb.env);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /\[Inbox synced\.\] 4 closed \(left the inbox\), 1 reopened\./);
});

test("backfill passes flags and reports failures", async () => {
  const sb = await initialized();
  const r = await cli(["backfill", "--n", "20", "--days", "3", "--force"], sb.env);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /Seen 20, triaged 3, skipped 1, failed 1/);
  assert.match(r.stdout, /Triage failed/);
});

test("watch", async () => {
  const sb = await initialized();
  const r = await cli(["watch"], sb.env);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /\[Watch active\.\] Expires 2026-10-19/);
});

test("priorities put from stdin, then get", async () => {
  const sb = await initialized();
  const put = await cli(["priorities", "put", "-"], sb.env, "# Priorities\n- from stdin\n");
  assert.equal(put.code, 0, put.stderr);
  assert.match(put.stdout, /Priorities updated/);
  const get = await cli(["priorities", "get"], sb.env);
  assert.equal(get.stdout, "# Priorities\n- from stdin\n");
});

test("priorities edit uploads changes made in $EDITOR and shows a diff", async () => {
  const sb = await initialized();
  await cli(["priorities", "put", "-"], sb.env, "# Priorities\n- base\n");
  const editor = join(sb.root, "bin", "fake-editor");
  writeFileSync(editor, `#!/bin/sh\necho "- added in editor" >> "$1"\n`);
  chmodSync(editor, 0o755);
  const r = await cli(["priorities", "edit"], { ...sb.env, EDITOR: editor });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /\+- added in editor/);
  assert.match(r.stdout, /Priorities updated/);
  assert.equal(priorities, "# Priorities\n- base\n- added in editor\n");

  const noop = join(sb.root, "bin", "noop-editor");
  writeFileSync(noop, "#!/bin/sh\nexit 0\n");
  chmodSync(noop, 0o755);
  const r2 = await cli(["priorities", "edit"], { ...sb.env, EDITOR: noop });
  assert.match(r2.stdout, /No changes/);
});

test("token clear and refresh", async () => {
  const sb = await initialized();
  const tokenFile = join(sb.env.XDG_CONFIG_HOME, "guppi", `token-${PROJECT}`);
  const c = await cli(["token", "clear"], sb.env);
  assert.equal(c.code, 0);
  assert.ok(!existsSync(tokenFile));
  const f = await cli(["token", "refresh"], sb.env);
  assert.equal(f.code, 0, f.stderr);
  assert.equal(readFileSync(tokenFile, "utf8"), GOOD);
});

test("help and unknown command", async () => {
  const sb = sandbox();
  const h = await cli(["help"], sb.env);
  assert.match(h.stdout, /guppi priorities edit/);
  const u = await cli(["frobnicate"], sb.env);
  assert.equal(u.code, 2);
});

test("chat one-shot prints the server diff verbatim and asks for yes", async () => {
  const sb = await initialized();
  const r = await cli(["chat", "-m", "recruiters are low unless I'm interviewing there", "--new"], sb.env);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(lastChat.session, "new");
  assert.equal(lastChat.channel, "cli");
  assert.match(r.stdout, /\[1 rule change proposed\.\]/);
  assert.match(r.stdout, /\[Proposed priorities change p1\] recruiter rule/);
  assert.match(r.stdout, /^\+ - recruiters low unless interviewing$/m);
  assert.match(r.stdout, /Reply 'yes' to apply/);
});

test("chat positional message, applied result shows re-triage moves", async () => {
  const sb = await initialized();
  const r = await cli(["chat", "yes"], sb.env);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /\[Applied\] recruiter rule/);
  assert.match(r.stdout, /\[Re-triaged 5\. 1 moved\.\]/);
  assert.match(r.stdout, /normal\/fyi -> low\/fyi  Pat: Role/);
});

test("chat REPL: session notice, /briefing, /continue, message, /quit", async () => {
  const sb = await initialized();
  const r = await cli(["chat"], sb.env, "/briefing\n/continue\nhello\n/quit\n");
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /Last session ended 5\.0 h ago/);
  assert.match(r.stdout, /\[Briefing\. 1 action item/);
  assert.equal(lastChat.message, "hello");
  assert.equal(lastChat.session, "continue");
  assert.match(r.stdout, /\[1 rule change proposed\.\]/);
});

test("priorities history and restore", async () => {
  const sb = await initialized();
  const h = await cli(["priorities", "history"], sb.env);
  assert.equal(h.code, 0, h.stderr);
  assert.match(h.stdout, /v1\s+2026-10-11 20:00:00\s+chat\s+1200\s+recruiter rule/);
  const r = await cli(["priorities", "restore", "v1"], sb.env);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /\[Priorities restored\.\] Version from 2026-10-11/);
  const bad = await cli(["priorities", "restore"], sb.env);
  assert.equal(bad.code, 2);
});
