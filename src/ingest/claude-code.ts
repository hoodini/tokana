// Parse a Claude Code session transcript (.jsonl) into deduplicated turns + context records.
//
// THE CRITICAL RULE: Claude Code writes ONE JSONL LINE PER CONTENT BLOCK (thinking, text,
// each tool_use), and every line for the same assistant response repeats the SAME `usage`
// object under the SAME `message.id`. Summing lines naively over-counts the billed total by
// ~2.3x (measured over the author's full history: ~2.19 content-block lines per billed message;
// output tokens alone over-count by ~3x). We dedup by `message.id` and count each turn exactly
// once. This is the difference between a truthful tool and a lying one.
import type { RawUsage, Turn } from "../core/schema.ts";
import { toBillingBuckets } from "../core/schema.ts";
import { priceForModel, costOf, costWithoutCache } from "../core/pricing.ts";
import type { ModelPrice } from "../core/pricing.ts";

export interface ContextRecord {
  ts: string;
  kind: "user" | "assistant" | "tool_result" | "thinking" | "file";
  text: string;
}

export interface SessionParse {
  turns: Turn[];
  records: ContextRecord[]; // ordered, for on-demand attribution
  meta: { sessionId: string; cwd: string };
}

function textOfBlock(block: any): string {
  if (typeof block === "string") return block;
  if (!block || typeof block !== "object") return "";
  if (typeof block.text === "string") return block.text;
  if (typeof block.thinking === "string") return block.thinking;
  if (typeof block.content === "string") return block.content;
  if (Array.isArray(block.content)) return block.content.map(textOfBlock).join("\n");
  if (block.input) return JSON.stringify(block.input);
  return "";
}

export interface ParseConfig {
  pricing: Record<string, ModelPrice> & { __fallback: ModelPrice; __actualMultiplier: number };
}

export function parseSessionText(
  raw: string,
  cfg: {
    priceLookup: (model: string) => ModelPrice;
    actualMultiplier: number;
    projectFromCwd?: string;
  },
): SessionParse {
  const seen = new Set<string>(); // message.id already counted
  const turns: Turn[] = [];
  const records: ContextRecord[] = [];
  let sessionId = "";
  let cwd = cfg.projectFromCwd ?? "";

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let rec: any;
    try {
      rec = JSON.parse(line);
    } catch {
      continue; // skip malformed / partial lines
    }
    if (!sessionId && rec.sessionId) sessionId = rec.sessionId;
    if (!cwd && rec.cwd) cwd = rec.cwd;

    const ts: string = rec.timestamp ?? "";
    const msg = rec.message;

    // Build a turn ONCE per distinct assistant message.id — BEFORE pushing this line's own output
    // blocks, so recordBoundary = exactly the records that were in context (input) for this turn.
    if (rec.type === "assistant" && msg?.usage && msg?.id && !seen.has(msg.id)) {
      const id: string = msg.id;
      seen.add(id);
      const usage = msg.usage as RawUsage;
      const model: string = msg.model ?? "unknown";
      const billing = toBillingBuckets(usage);
      const price = cfg.priceLookup(model);
      const cost = costOf(billing, price, cfg.actualMultiplier);
      const costNoCache = costWithoutCache(billing, price);
      const totalInput =
        billing.uncached + billing.cacheCreate5m + billing.cacheCreate1h + billing.cacheRead;
      turns.push({
        source: "claude-code",
        sessionId: rec.sessionId ?? sessionId,
        project: rec.cwd ?? cwd,
        messageId: id,
        requestId: rec.requestId ?? null,
        model,
        ts,
        isSidechain: rec.isSidechain === true,
        billing,
        totalInput,
        totalTokens: totalInput + billing.output,
        cost,
        costNoCache,
        recordBoundary: records.length, // records already in context, excluding this turn's output
        attribution: null, // computed on-demand via the attribution endpoint
      });
    }

    // Collect context records (for attribution) from user + assistant + attachment blocks.
    // Ordering is by file position (append order); attribution slices records by INDEX, not
    // timestamp, so records that lack a timestamp are still placed correctly.
    if (rec.type === "user" && msg?.content) {
      const blocks = Array.isArray(msg.content) ? msg.content : [{ type: "text", text: msg.content }];
      for (const b of blocks) {
        if (b?.type === "tool_result") records.push({ ts, kind: "tool_result", text: textOfBlock(b) });
        else records.push({ ts, kind: "user", text: textOfBlock(b) });
      }
    } else if (rec.type === "assistant" && Array.isArray(msg?.content)) {
      for (const b of msg.content) {
        if (b?.type === "thinking") records.push({ ts, kind: "thinking", text: textOfBlock(b) });
        else if (b?.type === "text" || b?.type === "tool_use")
          records.push({ ts, kind: "assistant", text: textOfBlock(b) });
      }
    } else if (rec.type === "attachment" && rec.attachment) {
      // File-read / hook attachments carry content that lands in the context window.
      const a = rec.attachment;
      const text = a.stdout ?? a.content ?? "";
      const ats = ts || a.timestamp || "";
      if (text) records.push({ ts: ats, kind: "file", text: String(text) });
    }
  }

  return { turns, records, meta: { sessionId, cwd } };
}

export async function parseSessionFile(
  path: string,
  cfg: { priceLookup: (m: string) => ModelPrice; actualMultiplier: number; projectFromCwd?: string },
): Promise<SessionParse> {
  const raw = await Bun.file(path).text();
  const parsed = parseSessionText(raw, cfg);
  for (const t of parsed.turns) t.sourceFile = path;
  return parsed;
}

// Re-export for callers wiring pricing.
export { priceForModel };
