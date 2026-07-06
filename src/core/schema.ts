// Core data model for tokana.
//
// Design principle (from the plan): keep TWO ORTHOGONAL AXES separate.
//   1. BILLING BUCKETS  — how each token was *priced* (disjoint slices of one prompt).
//   2. ATTRIBUTION      — what each token is *made of* (system/tools/history/files/...).
// Conflating them is the mistake that makes token dashboards lie. See docs in the plan.

/** Raw usage object exactly as Claude Code writes it into the JSONL transcript. */
export interface RawUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation?: {
    ephemeral_5m_input_tokens?: number;
    ephemeral_1h_input_tokens?: number;
  };
  service_tier?: string;
}

/** AXIS 1: disjoint billing buckets. Sum = total prompt+completion tokens for the request. */
export interface BillingBuckets {
  uncached: number; // input_tokens — full price (1x)
  cacheCreate5m: number; // ephemeral 5-minute cache write (1.25x)
  cacheCreate1h: number; // ephemeral 1-hour cache write (2x)
  cacheRead: number; // served from cache (0.1x) — the cheap tokens
  output: number; // generated tokens
}

/** AXIS 2: approximate content attribution. Only the baseline residual is truth-bearing. */
export interface Attribution {
  currentMessage: number; // the newest user message on this turn
  history: number; // prior user + assistant text already in context
  toolResults: number; // tool_result payloads (file reads, command output, etc.)
  thinking: number; // extended-thinking blocks
  files: number; // file-read attachment records
  systemToolsBaseline: number; // RESIDUAL = exactTotalInput - sum(visible). Honest lump.
  approximate: true; // segmentation uses a proxy tokenizer for Claude — never exact
  unreliable?: boolean; // true when visible > totalInput (proxy over-counts / thinking stripped on resend)
  overcounted?: number; // how many tokens the visible estimate exceeded the exact input by
}

export interface Cost {
  list: number; // API list-price equivalent, USD
  actual: number; // what you actually pay at the margin (0 on Max/Pro), USD
  currency: "USD";
}

/** One deduplicated assistant turn — the atomic billed unit (one distinct message.id). */
export interface Turn {
  source: "claude-code";
  sessionId: string;
  project: string; // decoded working directory
  messageId: string; // DEDUP KEY — one turn per distinct message.id
  requestId: string | null;
  model: string;
  ts: string; // ISO timestamp
  isSidechain: boolean; // true = subagent/Task usage
  billing: BillingBuckets;
  totalInput: number; // uncached + cacheCreate5m + cacheCreate1h + cacheRead
  totalTokens: number; // totalInput + output
  cost: Cost;
  costNoCache: number; // list cost if caching did not exist — for savings = costNoCache - cost.list
  sourceFile?: string; // absolute path of the JSONL this turn came from (for attribution drill-down)
  recordBoundary?: number; // index into the session's records[] that were IN CONTEXT before this turn
  attribution: Attribution | null; // null when tokenizer disabled
}

/** Convert a RawUsage into the disjoint billing buckets, handling missing fields safely. */
export function toBillingBuckets(u: RawUsage): BillingBuckets {
  const cc = u.cache_creation ?? {};
  const cc5m = cc.ephemeral_5m_input_tokens ?? 0;
  const cc1h = cc.ephemeral_1h_input_tokens ?? 0;
  // Prefer the itemized 5m/1h split; fall back to the flat total if the split is absent.
  const flatCreate = u.cache_creation_input_tokens ?? 0;
  const splitSum = cc5m + cc1h;
  return {
    uncached: u.input_tokens ?? 0,
    cacheCreate5m: cc5m,
    // If only the flat total is present (older logs), attribute it to the 1h bucket
    // ONLY if the split is empty, so we never double-count.
    cacheCreate1h: splitSum > 0 ? cc1h : flatCreate,
    cacheRead: u.cache_read_input_tokens ?? 0,
    output: u.output_tokens ?? 0,
  };
}
