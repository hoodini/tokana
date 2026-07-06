// On-demand context analysis for a single turn.
//
// Two things this produces:
//   1. categories  — token totals per bucket (your message / history / tool results / thinking /
//                     files / system+tools baseline). The baseline is a truth-bearing RESIDUAL.
//   2. items       — the ACTUAL CONTENT of each context segment, with its own token count, so you
//                     can literally read what is in the context window and see the math per piece.
//
// HONESTY: Claude's tokenizer is not public, so per-item token counts use a PROXY (cl100k) and are
// approximate. The system/tools baseline has NO content to show — it is not stored in the logs
// (that is exactly why it is a residual), so we surface it as an explicit "not in logs" item.
//
// PRIVACY: item text is passed through redact() to mask obvious secrets (API keys, tokens, private
// keys) so a screenshot of your own context can't leak a credential.
import type { ContextRecord } from "../ingest/claude-code.ts";
import type { Turn, Attribution } from "./schema.ts";
import { approxTokens } from "./tokenizer.ts";

// Ordered secret patterns (specific vendor rules BEFORE the broadened generic ones so each keeps its
// own label). Hardened per an adversarial redaction audit — covers current key formats that the naive
// version missed (OpenAI sk-proj-, Stripe, DB URLs, Google, Bearer, Azure, and package-registry tokens).
const SECRET_PATTERNS: [RegExp, string][] = [
  // Private keys (real newlines AND JSON-escaped \n)
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----(?:\\n|[\s\S])*?-----END [A-Z ]*PRIVATE KEY-----/g, "‹redacted:private-key›"],
  // Anthropic (before the generic sk- rule)
  [/\bsk-ant-[A-Za-z0-9_-]{20,}/g, "‹redacted:anthropic-key›"],
  // Stripe secret/restricted keys (underscore form — bypassed the old sk- rule)
  [/\b[sr]k_(?:live|test)_[A-Za-z0-9]{20,}/g, "‹redacted:stripe-key›"],
  // OpenAI + generic sk- (now includes _ and - so sk-proj- / sk-svcacct- are caught)
  [/\bsk-[A-Za-z0-9_-]{20,}/g, "‹redacted:openai-key›"],
  // GitHub (added r for refresh tokens) + fine-grained PAT
  [/\bgh[oprsu]_[A-Za-z0-9]{20,}/g, "‹redacted:gh-token›"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, "‹redacted:gh-pat›"],
  [/\bglpat-[A-Za-z0-9_-]{20,}/g, "‹redacted:gitlab-pat›"],
  // AWS
  [/\bAKIA[0-9A-Z]{16}\b/g, "‹redacted:aws-key›"],
  [/\baws_?(?:secret_?access_?key|secret)\b[\s"':=]+[A-Za-z0-9/+]{40}\b/gi, "‹redacted:aws-secret›"],
  // Google / GCP (no trailing \b — Google keys are a fixed 39 chars; \b broke when adjacent to text)
  [/\bAIza[0-9A-Za-z_-]{35}/g, "‹redacted:google-api-key›"],
  // Slack (app-level + broadened)
  [/\bxapp-[0-9]-[A-Za-z0-9-]{10,}/g, "‹redacted:slack-app-token›"],
  [/\bxox[abeprs]-[A-Za-z0-9-]{10,}/g, "‹redacted:slack-token›"],
  // Package registries / SaaS
  [/\bnpm_[A-Za-z0-9]{36}\b/g, "‹redacted:npm-token›"],
  [/\bpypi-[A-Za-z0-9_-]{16,}/g, "‹redacted:pypi-token›"],
  [/\bhf_[A-Za-z0-9]{30,}/g, "‹redacted:hf-token›"],
  [/\bdop_v1_[a-f0-9]{64}\b/g, "‹redacted:do-token›"],
  [/\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/g, "‹redacted:sendgrid-key›"],
  // Azure
  [/\bAccountKey=[A-Za-z0-9+/]{86}==/g, "AccountKey=‹redacted:azure-key›"],
  [/\bsig=[A-Za-z0-9%]{40,}/gi, "sig=‹redacted:azure-sas›"],
  // Database / broker connection strings with embedded passwords
  [/\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|rediss?|amqps?):\/\/[^\s:@/]*:[^\s@/]+@[^\s/]+/gi, "‹redacted:db-url›"],
  // JWT
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "‹redacted:jwt›"],
  // Bearer / Authorization tokens (keep the literal Bearer for context)
  [/\bBearer\s+[A-Za-z0-9._~+/-]{15,}=*/g, "Bearer ‹redacted:token›"],
  // Generic keyword=value — mask only the VALUE (group 1 keeps the key name readable). The keyword
  // must sit immediately before the separator, which avoids nuking benign ids like api_key_name=foo.
  [/\b([A-Za-z0-9._-]*(?:secret|token|password|passwd|api[_-]?key)\s*[:=]\s*["']?)[A-Za-z0-9._\-/+]{12,}/gi, "$1‹redacted:credential›"],
];

export function redact(text: string): string {
  let t = text;
  for (const [re, rep] of SECRET_PATTERNS) t = t.replace(re, rep);
  return t;
}

const ITEM_CHAR_CAP = 8000; // per-item displayed characters (token count uses the FULL text)
const TOTAL_CHAR_CAP = 1_500_000; // safety cap on total returned text per turn

export interface ContextItem {
  order: number;
  kind: ContextRecord["kind"] | "baseline";
  label: string;
  ts: string;
  tokens: number; // approximate (proxy tokenizer)
  chars: number; // full length before truncation
  text: string; // redacted + possibly truncated content ("" for baseline)
  truncated: boolean;
  inLogs: boolean; // false for the baseline (not stored in transcripts)
}

export interface ContextAnalysis {
  totalInput: number;
  visibleTokens: number;
  baseline: number;
  categories: Attribution;
  items: ContextItem[];
  tokenizer: "cl100k_base (proxy for Claude — approximate)";
}

const KIND_LABEL: Record<string, string> = {
  user: "conversation history (user)",
  assistant: "conversation history (assistant)",
  tool_result: "tool result",
  thinking: "thinking block",
  file: "file / attachment",
};

export function analyzeContext(turn: Turn, records: ContextRecord[]): ContextAnalysis {
  // Slice by INDEX (file/append order) when we know the boundary — robust even for records with no
  // timestamp. Fall back to a timestamp filter only for turns indexed before recordBoundary existed.
  const inContext =
    typeof turn.recordBoundary === "number"
      ? records.slice(0, turn.recordBoundary)
      : turn.ts
        ? records.filter((r) => r.ts && r.ts <= turn.ts)
        : records.slice();

  let lastUserIdx = -1;
  for (let i = inContext.length - 1; i >= 0; i--) {
    if (inContext[i].kind === "user") {
      lastUserIdx = i;
      break;
    }
  }

  const cat: Attribution = {
    currentMessage: 0,
    history: 0,
    toolResults: 0,
    thinking: 0,
    files: 0,
    systemToolsBaseline: 0,
    approximate: true,
  };

  const items: ContextItem[] = [];
  let usedChars = 0;
  inContext.forEach((r, i) => {
    const tokens = approxTokens(r.text);
    const isCurrent = r.kind === "user" && i === lastUserIdx;
    switch (r.kind) {
      case "user":
        if (isCurrent) cat.currentMessage += tokens;
        else cat.history += tokens;
        break;
      case "assistant":
        cat.history += tokens;
        break;
      case "tool_result":
        cat.toolResults += tokens;
        break;
      case "thinking":
        cat.thinking += tokens;
        break;
      case "file":
        cat.files += tokens;
        break;
    }
    if (tokens === 0) return;
    const budgetLeft = usedChars < TOTAL_CHAR_CAP;
    // Slice first, then redact — cheaper on huge records, and redaction still covers the shown text.
    const rawText = budgetLeft ? redact(r.text.slice(0, ITEM_CHAR_CAP)) : "";
    usedChars += rawText.length;
    items.push({
      order: i,
      kind: r.kind,
      label: isCurrent ? "your message (this turn)" : (KIND_LABEL[r.kind] ?? r.kind),
      ts: r.ts,
      tokens,
      chars: r.text.length,
      text: rawText,
      truncated: r.text.length > rawText.length && budgetLeft,
      inLogs: true,
    });
  });

  const visible = cat.currentMessage + cat.history + cat.toolResults + cat.thinking + cat.files;
  const rawBaseline = turn.totalInput - visible;
  const baseline = Math.max(0, rawBaseline);
  cat.systemToolsBaseline = baseline;
  const unreliable = rawBaseline < 0; // proxy over-counted (e.g. prior thinking stripped on resend)
  if (unreliable) {
    cat.unreliable = true;
    cat.overcounted = -rawBaseline;
  }

  // Surface the invisible baseline as an explicit item so the UI can show WHY it has no content.
  items.push({
    order: -1,
    kind: "baseline",
    label: unreliable
      ? "system + tools baseline — estimate unreliable this turn (proxy over-counted visible content)"
      : "system prompt + tool/MCP/skill schemas + memory (NOT in logs)",
    ts: turn.ts,
    tokens: baseline,
    chars: 0,
    text: "",
    truncated: false,
    inLogs: false,
  });

  return {
    totalInput: turn.totalInput,
    visibleTokens: visible,
    baseline,
    categories: cat,
    items,
    tokenizer: "cl100k_base (proxy for Claude — approximate)",
  };
}

// Back-compat: categories-only view.
export function attributeTurn(turn: Turn, records: ContextRecord[]): Attribution {
  return analyzeContext(turn, records).categories;
}
