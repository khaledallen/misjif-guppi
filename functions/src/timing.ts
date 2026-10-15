// Per-hop timing for a chat turn, so latency work targets the slow hop instead of a guess.
//
// Each turn records:
//   - setup spans (session lookup, inbox sync, briefing, history load, save)
//   - one entry per model round, with token usage incl. prompt-cache hits
//   - one entry per tool call, with nested spans (e.g. Gmail fetch vs reader model)
// It is returned to the client in ChatResult.timing and logged as "Chat timing".

export interface Span {
  name: string;
  start_ms: number; // offset from the start of the turn
  ms: number;
  meta?: Record<string, unknown>;
}

export interface ModelRound {
  round: number;
  ms: number;
  stop_reason: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

export interface ChatTiming {
  total_ms: number;
  cold_start: boolean; // first request this instance served
  spans: Span[]; // setup, tools and their sub-steps, save
  model_rounds: ModelRound[];
  /** Totals by bucket, for a one-glance answer to "where did the time go". */
  breakdown: { setup_ms: number; model_ms: number; tools_ms: number; save_ms: number; other_ms: number };
}

// Module scope survives between requests on a warm instance.
let servedRequests = 0;
export function claimColdStart(): boolean {
  return servedRequests++ === 0;
}

type Bucket = "setup" | "tools" | "save" | "sub";

interface UsageLike {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

export class TurnTimer {
  private readonly t0 = Date.now();
  private readonly spans: (Span & { bucket: Bucket })[] = [];
  private readonly rounds: ModelRound[] = [];

  constructor(private readonly coldStart: boolean) {}

  /** Time an async step. Records the span even if fn throws. */
  async span<T>(name: string, bucket: Bucket, fn: () => Promise<T>, meta?: Record<string, unknown>): Promise<T> {
    const start = Date.now();
    try {
      return await fn();
    } finally {
      this.spans.push({ name, bucket, start_ms: start - this.t0, ms: Date.now() - start, ...(meta ? { meta } : {}) });
    }
  }

  /** Time a model call; usage is read off the response. */
  async model<T extends { stop_reason?: string | null; usage?: UsageLike }>(
    round: number,
    fn: () => Promise<T>,
  ): Promise<T> {
    const start = Date.now();
    const res = await fn();
    const u = res.usage ?? {};
    this.rounds.push({
      round,
      ms: Date.now() - start,
      stop_reason: res.stop_reason ?? null,
      input_tokens: u.input_tokens ?? 0,
      output_tokens: u.output_tokens ?? 0,
      cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
      cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
    });
    return res;
  }

  /** A child timer callback for steps inside a tool (they are reported, not double-counted). */
  sub(prefix: string): <T>(name: string, fn: () => Promise<T>) => Promise<T> {
    return (name, fn) => this.span(`${prefix}.${name}`, "sub", fn);
  }

  finish(): ChatTiming {
    return summarize(this.spans, this.rounds, Date.now() - this.t0, this.coldStart);
  }
}

/** Pure: bucket totals. Exported for tests. */
export function summarize(
  spans: (Span & { bucket: Bucket })[],
  rounds: ModelRound[],
  total: number,
  coldStart: boolean,
): ChatTiming {
  const sum = (b: Bucket) => spans.filter((s) => s.bucket === b).reduce((n, s) => n + s.ms, 0);
  const setup_ms = sum("setup");
  const tools_ms = sum("tools");
  const save_ms = sum("save");
  const model_ms = rounds.reduce((n, r) => n + r.ms, 0);
  return {
    total_ms: total,
    cold_start: coldStart,
    spans: [...spans]
      .sort((a, b) => a.start_ms - b.start_ms)
      .map((s): Span => ({ name: s.name, start_ms: s.start_ms, ms: s.ms, ...(s.meta ? { meta: s.meta } : {}) })),
    model_rounds: rounds,
    breakdown: {
      setup_ms,
      model_ms,
      tools_ms,
      save_ms,
      other_ms: Math.max(0, total - setup_ms - model_ms - tools_ms - save_ms),
    },
  };
}
