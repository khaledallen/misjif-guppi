#!/usr/bin/env node
// guppi — command-line client for the GUPPI API.
//
// Resolves the API URL and bearer token itself, so no TOKEN/API env vars are
// needed. Zero dependencies: Node 18+ (built-in fetch), plus gcloud for the
// first token fetch.
//
//   guppi init [--project ID] [--region REGION] [--api URL]
//   guppi briefing | triage | backfill | watch | health
//   guppi priorities get | put <file|-> | edit
//   guppi token refresh | clear
//
// Token lookup order:
//   1. $GUPPI_TOKEN (override)
//   2. local cache: macOS Keychain, or ~/.config/guppi/token-<project> (mode 600) elsewhere
//   3. Secret Manager via `gcloud secrets versions access` (then cached)
// The token is never printed, written to shell history, or stored in the repo.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, rmSync, mkdtempSync } from "node:fs";
import { homedir, tmpdir, platform } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";

const SECRET_NAME = "GUPPI_API_TOKEN";
const KEYCHAIN_SERVICE = "guppi-api-token";
const DEFAULT_REGION = "us-central1";

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
class CliError extends Error {
  constructor(message, code = 1) {
    super(message);
    this.code = code;
  }
}

function parseFlags(args) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--") || /^-[a-zA-Z]$/.test(a)) {
      const [k, inline] = a.replace(/^--?/, "").split("=", 2);
      if (inline !== undefined) flags[k] = inline;
      else if (args[i + 1] !== undefined && !args[i + 1].startsWith("--")) flags[k] = args[++i];
      else flags[k] = true;
    } else positional.push(a);
  }
  return { flags, positional };
}

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { encoding: "utf8", ...opts });
  if (res.error && res.error.code === "ENOENT") return { missing: true, status: 127, stdout: "", stderr: "" };
  return { missing: false, status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

const configDir = () => join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "guppi");
const configPath = () => join(configDir(), "config.json");

function ensureConfigDir() {
  mkdirSync(configDir(), { recursive: true, mode: 0o700 });
}

function loadConfig() {
  if (!existsSync(configPath())) return null;
  try {
    return JSON.parse(readFileSync(configPath(), "utf8"));
  } catch {
    throw new CliError(`[Config at ${configPath()} is unreadable. Run: guppi init]`);
  }
}

function saveConfig(cfg) {
  ensureConfigDir();
  writeFileSync(configPath(), JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  chmodSync(configPath(), 0o600);
}

function requireConfig() {
  const cfg = loadConfig();
  const api = process.env.GUPPI_API || cfg?.api;
  const project = process.env.GUPPI_PROJECT || cfg?.project;
  if (!api) throw new CliError("[Not configured. Run: guppi init]");
  return { api: api.replace(/\/+$/, ""), project };
}

// ---------------------------------------------------------------------------
// gcloud
// ---------------------------------------------------------------------------
function gcloud(args) {
  const res = run("gcloud", args);
  if (res.missing) {
    throw new CliError("[gcloud not found. Install the Google Cloud SDK: https://cloud.google.com/sdk/docs/install]");
  }
  return res;
}

function gcloudDefaultProject() {
  const res = gcloud(["config", "get-value", "project"]);
  const p = res.stdout.trim();
  return p && p !== "(unset)" ? p : null;
}

function fetchTokenFromSecretManager(project) {
  if (!project)
    throw new CliError("[No project configured; cannot reach Secret Manager. Run: guppi init --project ID]");
  const res = gcloud(["secrets", "versions", "access", "latest", `--secret=${SECRET_NAME}`, `--project=${project}`]);
  if (res.status !== 0) {
    const err = res.stderr;
    if (/active account|auth(entication)? |login|credentials|reauth/i.test(err)) {
      throw new CliError("[gcloud is not logged in. Run: gcloud auth login]");
    }
    if (/NOT_FOUND|not found/i.test(err)) {
      throw new CliError(
        `[Secret ${SECRET_NAME} not found in project ${project}. Wrong project? Check: gcloud secrets list --project=${project}]`,
      );
    }
    if (/PERMISSION_DENIED|permission/i.test(err)) {
      throw new CliError(
        `[Permission denied reading ${SECRET_NAME} in ${project}. Is gcloud logged in as the project owner?]`,
      );
    }
    throw new CliError(`[Could not read ${SECRET_NAME} from Secret Manager.]\n${err.trim()}`);
  }
  const token = res.stdout.trim();
  if (!token) throw new CliError(`[${SECRET_NAME} is empty in Secret Manager.]`);
  return token;
}

// ---------------------------------------------------------------------------
// Token cache: macOS Keychain, else a 600-mode file
// ---------------------------------------------------------------------------
const useKeychain = () => platform() === "darwin" && process.env.GUPPI_NO_KEYCHAIN !== "1";
const tokenFile = (project) => join(configDir(), `token-${project || "default"}`);

function cacheGet(project) {
  if (useKeychain()) {
    const res = run("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", project || "default", "-w"]);
    return res.status === 0 ? res.stdout.trim() || null : null;
  }
  const f = tokenFile(project);
  return existsSync(f) ? readFileSync(f, "utf8").trim() || null : null;
}

function cacheSet(project, token) {
  if (useKeychain()) {
    // -U updates if present. The token goes via argv to `security`, which is
    // not shell history; this is the standard way to add a generic password.
    const res = run("security", [
      "add-generic-password",
      "-U",
      "-s",
      KEYCHAIN_SERVICE,
      "-a",
      project || "default",
      "-l",
      "GUPPI API token",
      "-w",
      token,
    ]);
    if (res.status !== 0) throw new CliError(`[Could not save token to Keychain.]\n${res.stderr.trim()}`);
    return "macOS Keychain";
  }
  ensureConfigDir();
  const f = tokenFile(project);
  writeFileSync(f, token, { mode: 0o600 });
  chmodSync(f, 0o600);
  return f;
}

function cacheClear(project) {
  if (useKeychain()) {
    run("security", ["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", project || "default"]);
  } else {
    rmSync(tokenFile(project), { force: true });
  }
}

/** Returns { token, source } where source is "env" | "cache" | "secret-manager". */
function resolveToken(project, { refresh = false } = {}) {
  if (process.env.GUPPI_TOKEN) return { token: process.env.GUPPI_TOKEN.trim(), source: "env" };
  if (!refresh) {
    const cached = cacheGet(project);
    if (cached) return { token: cached, source: "cache" };
  }
  const token = fetchTokenFromSecretManager(project);
  cacheSet(project, token);
  return { token, source: "secret-manager" };
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
async function rawRequest(url, { method = "GET", token, body, contentType, timeoutMs = 30_000 } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (contentType) headers["content-type"] = contentType;
  try {
    return await fetch(url, { method, headers, body, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    const cause = err?.cause?.code || err?.name || "";
    if (cause === "TimeoutError" || err?.name === "TimeoutError") {
      throw new CliError(`[Timed out after ${Math.round(timeoutMs / 1000)}s: ${method} ${url}]`);
    }
    throw new CliError(
      `[API unreachable: ${url}${cause ? ` (${cause})` : ""}. Check your connection, or re-run: guppi init]`,
    );
  }
}

/** Classify a 401/403 as GUPPI's own rejection vs Google's front end. */
async function describeAuthFailure(res) {
  const text = await res.text();
  if (text.includes("[Unauthorized.]")) return { kind: "app", text };
  return { kind: "google", text };
}

/** Authenticated request with one automatic token refresh on GUPPI-level 401. */
async function api(path, opts = {}) {
  const { api: base, project } = requireConfig();
  const url = base + path;
  let { token, source } = resolveToken(project);
  let res = await rawRequest(url, { ...opts, token });

  if (res.status === 401 || res.status === 403) {
    const failure = await describeAuthFailure(res);
    if (failure.kind === "app" && source === "cache") {
      // Cached token may be stale (secret rotated). Refetch once and retry.
      ({ token } = resolveToken(project, { refresh: true }));
      res = await rawRequest(url, { ...opts, token });
      if (res.status !== 401 && res.status !== 403) return res;
      const again = await describeAuthFailure(res);
      if (again.kind === "google") throw googleAuthError(project);
      throw new CliError(
        "[Unauthorized. The token in Secret Manager does not match the deployed function. Redeploy after changing GUPPI_API_TOKEN.]",
      );
    }
    if (failure.kind === "google") throw googleAuthError(project);
    throw new CliError(
      source === "env"
        ? "[Unauthorized. $GUPPI_TOKEN is wrong; unset it to use the stored token.]"
        : "[Unauthorized. The token in Secret Manager does not match the deployed function. Redeploy after changing GUPPI_API_TOKEN.]",
    );
  }
  if (!res.ok) {
    const text = await res.text();
    throw new CliError(`[HTTP ${res.status} from ${path}]\n${text.slice(0, 500)}`);
  }
  return res;
}

function googleAuthError(project) {
  const p = project || "<project>";
  return new CliError(
    "[Rejected by Google before reaching GUPPI: the function is not publicly invokable.]\n" +
      "Fix once (the bearer token still guards every route):\n" +
      `  gcloud run services add-iam-policy-binding api --region=${DEFAULT_REGION} --project=${p} \\\n` +
      "    --member=allUsers --role=roles/run.invoker",
  );
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------
async function cmdInit(flags) {
  const existing = loadConfig() || {};
  const project = flags.project || existing.project || gcloudDefaultProject();
  if (!project) {
    throw new CliError("[No project. Run: guppi init --project <firebase-project-id>]", 2);
  }
  const region = flags.region || existing.region || DEFAULT_REGION;
  const apiUrl = (flags.api || `https://${region}-${project}.cloudfunctions.net/api`).replace(/\/+$/, "");

  process.stdout.write(`[Checking ${apiUrl}/health ...] `);
  const health = await rawRequest(apiUrl + "/health", { timeoutMs: 20_000 });
  const healthText = await health.text();
  if (!health.ok || !healthText.includes("Operational")) {
    console.log("failed.");
    if (health.status === 403 || health.status === 401) throw googleAuthError(project);
    throw new CliError(
      `[Health check returned HTTP ${health.status}. If the URL is wrong, find it with: firebase functions:list, then: guppi init --api <url>]`,
    );
  }
  console.log("ok.");

  saveConfig({ project, region, api: apiUrl });
  console.log(`[Config saved: ${configPath()}]`);

  if (process.env.GUPPI_TOKEN) {
    console.log("[Using $GUPPI_TOKEN from the environment; nothing cached.]");
  } else {
    const token = fetchTokenFromSecretManager(project);
    const where = cacheSet(project, token);
    console.log(`[Token fetched from Secret Manager and cached in ${where}.]`);
  }

  await api("/priorities");
  console.log("[Authenticated. GUPPI is ready.]");
}

async function cmdHealth() {
  const { api: base } = requireConfig();
  const res = await rawRequest(base + "/health");
  const text = await res.text();
  if (!res.ok) throw new CliError(`[HTTP ${res.status}] ${text.slice(0, 200)}`);
  console.log(text.trim());
}

async function cmdBriefing() {
  const res = await api("/briefing");
  console.log((await res.text()).trimEnd());
}

async function cmdSync() {
  const res = await api("/sync", { method: "POST" });
  const d = await res.json();
  console.log(`${d.status} ${d.closed} closed (left the inbox), ${d.reopened} reopened.`);
  if (!d.complete) console.log("[Inbox larger than the sync window; nothing was closed to be safe.]");
}

async function cmdWatch() {
  const res = await api("/watch", { method: "POST" });
  const data = await res.json();
  console.log(`${data.status} Expires ${data.expiration}.`);
}

async function cmdBackfill(flags) {
  const q = new URLSearchParams();
  q.set("n", String(flags.n ?? 50));
  q.set("days", String(flags.days ?? 7));
  if (flags.force) q.set("force", "1");
  console.log(
    `[Backfill: up to ${q.get("n")} threads from the last ${q.get("days")} days${flags.force ? ", re-triaging all" : ""}. This can take a few minutes.]`,
  );
  const res = await api(`/backfill?${q}`, { method: "POST", timeoutMs: 600_000 });
  const d = await res.json();
  console.log(`${d.status} Seen ${d.seen}, triaged ${d.triaged}, skipped ${d.skipped}, failed ${d.failed}.`);
  if (d.failed > 0) {
    console.log(
      `[${d.failed} failed. Re-running retries only the failures. Errors: gcloud logging read '"Triage failed"' --freshness=1h --limit=10]`,
    );
  }
}

const PRIO_ORDER = { top: 0, high: 1, normal: 2, low: 3 };

function senderName(from = "") {
  const m = from.match(/^\s*"?([^"<]+?)"?\s*</);
  return (m ? m[1] : from).trim();
}

function pad(s, n) {
  s = String(s ?? "");
  return s.length > n ? s.slice(0, n - 1) + "…" : s.padEnd(n);
}

async function cmdTriage(flags) {
  const limit = flags.limit ?? 50;
  // Default: only what's still in the inbox. --all includes archived/handled threads (for grading).
  const status = flags.all ? "all" : flags.status || "open";
  const res = await api(`/triage?limit=${encodeURIComponent(limit)}&status=${encodeURIComponent(status)}`);
  const records = await res.json();
  if (flags.json) {
    console.log(JSON.stringify(records, null, 2));
    return;
  }
  if (!records.length) {
    console.log(
      status === "open"
        ? "[Nothing open. Inbox clear, or run: guppi backfill]"
        : "[No triage records yet. Run: guppi backfill]",
    );
    return;
  }
  const filtered = flags.judgment ? records.filter((r) => /^judgment/i.test(r.rule_applied || "")) : records;
  filtered.sort(
    (a, b) =>
      (PRIO_ORDER[a.priority] ?? 9) - (PRIO_ORDER[b.priority] ?? 9) ||
      (b.receivedAt || "").localeCompare(a.receivedAt || ""),
  );
  const wide = flags.wide;
  console.log(
    `${pad("PRIO", 7)}${pad("CAT", 7)}${pad("CONF", 5)}${pad("FROM", 22)}${pad("SUMMARY", wide ? 60 : 44)}RULE`,
  );
  for (const r of filtered) {
    const flag = r.injection_suspected ? " ⚠" : "";
    console.log(
      pad(r.priority, 7) +
        pad(r.category, 7) +
        pad(Number(r.confidence ?? 0).toFixed(2), 5) +
        pad(senderName(r.from), 22) +
        pad(r.summary, wide ? 60 : 44) +
        (wide ? r.rule_applied : pad(r.rule_applied, 40)) +
        flag,
    );
  }
  const failed = records.filter((r) => r.rule_applied === "triage_failed").length;
  if (failed) console.log(`[${failed} could not be triaged (rule: triage_failed). Retry with: guppi backfill]`);
  const judgment = records.filter((r) => /^judgment/i.test(r.rule_applied || "")).length;
  console.log(
    `\n[${filtered.length} shown. ${judgment} of ${records.length} decided by judgment, not a rule.${flags.judgment ? "" : " Show only those: guppi triage --judgment"}]`,
  );
}

async function cmdPriorities(positional) {
  const sub = positional[0] || "get";
  if (sub === "get") {
    const res = await api("/priorities");
    process.stdout.write(await res.text());
    return;
  }
  if (sub === "put") {
    const file = positional[1];
    if (!file) throw new CliError("[Usage: guppi priorities put <file>   (use - for stdin)]", 2);
    const body = file === "-" ? readFileSync(0, "utf8") : readFileSync(file, "utf8");
    const res = await api("/priorities", { method: "PUT", body, contentType: "text/plain; charset=utf-8" });
    console.log((await res.text()).trim());
    console.log("[Re-triage existing threads with the new rules: guppi backfill --force]");
    return;
  }
  if (sub === "edit") {
    const res = await api("/priorities");
    const original = await res.text();
    const dir = mkdtempSync(join(tmpdir(), "guppi-"));
    const file = join(dir, "priorities.md");
    writeFileSync(file, original, { mode: 0o600 });
    const editor = process.env.VISUAL || process.env.EDITOR || "vi";
    const ed = spawnSync(editor, [file], { stdio: "inherit", shell: true });
    try {
      if (ed.status !== 0) throw new CliError(`[Editor exited with status ${ed.status}. Nothing uploaded.]`);
      const edited = readFileSync(file, "utf8");
      if (edited === original) {
        console.log("[No changes.]");
        return;
      }
      const diff = run("diff", ["-u", "--label", "current", "--label", "edited", "-", file], { input: original });
      if (!diff.missing && diff.stdout) console.log(diff.stdout.trimEnd());
      const put = await api("/priorities", { method: "PUT", body: edited, contentType: "text/plain; charset=utf-8" });
      console.log((await put.text()).trim());
      console.log("[Re-triage existing threads with the new rules: guppi backfill --force]");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    return;
  }
  if (sub === "history") {
    const res = await api("/priorities/history?limit=20");
    const versions = await res.json();
    if (!versions.length) {
      console.log("[No previous versions yet.]");
      return;
    }
    console.log("Each entry is the doc as it was BEFORE that change. Restore with: guppi priorities restore <id>\n");
    console.log(`${pad("ID", 22)}${pad("SAVED", 22)}${pad("BY", 9)}${pad("SIZE", 7)}REASON`);
    for (const v of versions) {
      console.log(
        pad(v.id, 22) +
          pad(v.savedAt.replace("T", " ").slice(0, 19), 22) +
          pad(v.source, 9) +
          pad(v.chars, 7) +
          (v.reason || ""),
      );
    }
    return;
  }
  if (sub === "restore") {
    const id = positional[1];
    if (!id) throw new CliError("[Usage: guppi priorities restore <id>   (ids from: guppi priorities history)]", 2);
    const res = await api(`/priorities/restore?id=${encodeURIComponent(id)}`, { method: "POST" });
    const d = await res.json();
    console.log(`${d.status} Version from ${d.restored.savedAt}. The replaced version is in history too.`);
    console.log("[Re-triage existing threads with the restored rules: guppi backfill --force]");
    return;
  }
  throw new CliError("[Usage: guppi priorities get | put <file|-> | edit | history | restore <id>]", 2);
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------
const tty = process.stdout.isTTY;
const color = (code, s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);

function printDiff(diff) {
  for (const line of diff.split("\n")) {
    if (line.startsWith("+ ")) console.log(color(32, line));
    else if (line.startsWith("- ")) console.log(color(31, line));
    else console.log(color(2, line));
  }
}

function printChatResult(r) {
  if (r.reply) console.log(`\n${r.reply}`);
  for (const p of r.proposals || []) {
    // Diffs are server-generated and printed verbatim, never paraphrased by the model.
    console.log(color(1, `\n[Proposed priorities change ${p.id}] ${p.reason}`));
    printDiff(p.diff);
    const applied = (r.applied || []).length > 0;
    if (!p.can_apply_now && !applied) console.log(color(1, "[Reply 'yes' to apply.]"));
  }
  for (const a of r.applied || []) {
    console.log(color(1, `\n[Applied] ${a.reason}`));
    if (!(r.proposals || []).length) printDiff(a.diff);
    if (a.retriage) {
      const t = a.retriage;
      console.log(`[Re-triaged ${t.checked}. ${t.moved.length} moved.${t.failed ? ` ${t.failed} failed.` : ""}]`);
      for (const m of t.moved) console.log(`  ${m.before} -> ${m.after}  ${senderName(m.from)}: ${m.subject}`);
    }
  }
}

async function sendChat(message, session) {
  const res = await api("/chat", {
    method: "POST",
    body: JSON.stringify({ message, session, channel: "cli" }),
    contentType: "application/json",
    timeoutMs: 300_000,
  });
  return res.json();
}

function hoursAgo(iso) {
  const h = (Date.now() - Date.parse(iso)) / 3_600_000;
  return h < 1 ? `${Math.max(1, Math.round(h * 60))} min` : `${h.toFixed(1)} h`;
}

async function cmdChat(flags, positional = []) {
  let mode = flags.new ? "new" : flags.continue ? "continue" : "auto";

  const oneShot =
    typeof flags.m === "string" ? flags.m : typeof flags.message === "string" ? flags.message : positional.join(" ");
  if (oneShot.trim()) {
    printChatResult(await sendChat(oneShot.trim(), mode));
    return;
  }

  const info = await (await api("/chat/session")).json();
  if (mode === "new") console.log("[New session.]");
  else if (!info.conversation_id) console.log("[New session.]");
  else if (info.idle_expired && mode !== "continue") {
    console.log(
      `[Last session ended ${hoursAgo(info.lastActiveAt)} ago. Your first message starts a new one; /continue to resume it.]`,
    );
  } else console.log(`[Resuming session: ${info.turns} turns, last active ${hoursAgo(info.lastActiveAt)} ago.]`);
  console.log(color(2, "[/new  /continue  /briefing  /quit]"));

  // Async line iterator buffers input, so lines typed or pasted while a reply is
  // in flight are queued rather than dropped (readline's question() drops them).
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: tty });
  const prompt = () => process.stdout.write(color(36, "\nyou> "));
  rl.on("SIGINT", () => rl.close());
  prompt();
  try {
    for await (const raw of rl) {
      const line = raw.trim();
      if (!line) {
        prompt();
        continue;
      }
      if (line === "/quit" || line === "/exit") break;
      if (line === "/new") {
        mode = "new";
        console.log("[Next message starts a new session.]");
      } else if (line === "/continue") {
        mode = "continue";
        console.log("[Next message continues the previous session.]");
      } else if (line === "/briefing") {
        console.log((await (await api("/briefing")).text()).trimEnd());
      } else {
        if (tty) process.stdout.write(color(2, "[Working…]"));
        try {
          const r = await sendChat(line, mode);
          if (tty) process.stdout.write("\r\x1b[K");
          if (r.session === "new" && mode !== "new") console.log(color(2, "[New session started.]"));
          printChatResult(r);
          mode = "auto";
        } catch (err) {
          if (tty) process.stdout.write("\r\x1b[K");
          console.error(err instanceof CliError ? err.message : String(err));
        }
      }
      prompt();
    }
  } finally {
    rl.close();
    if (tty) process.stdout.write("\n");
  }
}

async function cmdToken(positional) {
  const sub = positional[0];
  const { project } = requireConfig();
  if (sub === "refresh") {
    if (process.env.GUPPI_TOKEN) console.log("[Note: $GUPPI_TOKEN is set and overrides the cache.]");
    const token = fetchTokenFromSecretManager(project);
    const where = cacheSet(project, token);
    console.log(`[Token refreshed from Secret Manager and cached in ${where}.]`);
    return;
  }
  if (sub === "clear") {
    cacheClear(project);
    console.log("[Cached token removed. It will be refetched from Secret Manager on next use.]");
    return;
  }
  throw new CliError("[Usage: guppi token refresh | clear]", 2);
}

const HELP = `guppi — talk to the GUPPI API

Setup
  guppi init [--project ID] [--region R] [--api URL]   configure and cache the token

Inbox
  guppi briefing                          GUPPI-format briefing
  guppi triage [--limit N] [--all] [--judgment] [--wide] [--json]
                                          threads still in the inbox (--all: include handled ones);
                                          --judgment shows calls no rule covered
  guppi sync                              re-check which triaged threads are still in the inbox
  guppi backfill [--n 50] [--days 7] [--force]
                                          triage recent inbox threads (--force re-triages all)
  guppi watch                             start/renew the Gmail watch
  guppi health                            liveness check (no auth)

Chat
  guppi chat [--new | --continue]         talk to GUPPI (/new /continue /briefing /quit)
  guppi chat -m "message"                 one-shot message

Priorities
  guppi priorities get                    print the current priorities markdown
  guppi priorities put <file|->           replace it from a file or stdin
  guppi priorities edit                   open in $EDITOR, upload on save
  guppi priorities history                previous versions (saved on every change)
  guppi priorities restore <id>           roll back to a previous version

Token
  guppi token refresh                     refetch from Secret Manager (after rotating it)
  guppi token clear                       remove the cached copy

Config: ${"~/.config/guppi/config.json"}. Overrides: GUPPI_API, GUPPI_TOKEN, GUPPI_PROJECT.`;

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { flags, positional } = parseFlags(rest);
  switch (cmd) {
    case "init":
      return cmdInit(flags);
    case "health":
      return cmdHealth();
    case "briefing":
      return cmdBriefing();
    case "watch":
      return cmdWatch();
    case "sync":
      return cmdSync();
    case "backfill":
      return cmdBackfill(flags);
    case "triage":
      return cmdTriage(flags);
    case "priorities":
      return cmdPriorities(positional);
    case "token":
      return cmdToken(positional);
    case "chat":
      return cmdChat(flags, positional);
    case undefined:
    case "help":
    case "-h":
    case "--help":
      console.log(HELP);
      return;
    default:
      throw new CliError(`[Unknown command: ${cmd}]\n\n${HELP}`, 2);
  }
}

main().catch((err) => {
  if (err instanceof CliError) {
    console.error(err.message);
    process.exit(err.code);
  }
  console.error(err?.stack || String(err));
  process.exit(1);
});
