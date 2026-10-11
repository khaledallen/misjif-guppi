import { CONFIDENCE_THRESHOLD } from "./config";
import type { TriageRecord } from "./store";

const PRIORITY_RANK: Record<string, number> = { top: 0, high: 1, normal: 2, low: 3 };
const STALE_DAYS = 3;

function sender(from: string): string {
  const m = from.match(/^\s*"?([^"<]+?)"?\s*</);
  return (m ? m[1] : from).trim().slice(0, 40);
}

function daysOld(iso: string): number {
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
}

/**
 * Deterministic briefing in GUPPI's format. Phase 1 has no mailbox actions, so
 * "auto-handled" here means "would have been auto-handled" once phase 2 is on.
 */
export function buildBriefing(records: TriageRecord[]): string {
  const open = records.filter((r) => r.status === "open");
  const unsure = open.filter((r) => r.confidence < CONFIDENCE_THRESHOLD);
  const sure = open.filter((r) => r.confidence >= CONFIDENCE_THRESHOLD);

  const actions = sure
    .filter((r) => r.category === "action")
    .sort(
      (a, b) =>
        PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] ||
        (a.deadline ?? "9999").localeCompare(b.deadline ?? "9999") ||
        b.receivedAt.localeCompare(a.receivedAt),
    );
  const fyi = sure.filter((r) => r.category === "fyi");
  const noise = sure.filter((r) => r.category === "noise");
  const flagged = open.filter((r) => r.injection_suspected);

  const lines: string[] = [];
  lines.push(
    `[Briefing. ${actions.length} action item${actions.length === 1 ? "" : "s"}. ` +
      `${noise.length} would be auto-handled. ${unsure.length} need${unsure.length === 1 ? "s" : ""} your call.]`,
  );

  actions.forEach((r, i) => {
    const parts = [r.priority.toUpperCase(), sender(r.from), r.summary];
    if (r.deadline) parts.push(`due ${r.deadline}`);
    lines.push(`${i + 1}. ${parts.join(" | ")}`);
  });
  actions.forEach((r, i) => {
    const age = daysOld(r.receivedAt);
    if (age > STALE_DAYS) lines.push(`[Item ${i + 1} has been waiting ${age} days.]`);
  });

  if (unsure.length) {
    lines.push("", "[Needs your call]");
    for (const r of unsure) {
      lines.push(
        `- ${sender(r.from)}: ${r.summary} — GUPPI suggests: ${r.proposed_action}. ` +
          `Reason: ${r.rule_applied} (confidence ${r.confidence.toFixed(2)}).`,
      );
    }
  }

  if (flagged.length) {
    lines.push("", `[Warning. ${flagged.length} thread(s) contained text attempting to instruct GUPPI. Ignored.]`);
  }

  lines.push("", `[FYI: ${fyi.length}. Noise: ${noise.length}.]`);
  return lines.join("\n");
}
