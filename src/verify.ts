// Independent verification.
//
// The active session file grows while this runs (it's the live conversation), so comparing a
// DB snapshot to a later raw scan races the clock. Instead we take ONE in-memory snapshot of the
// bytes and run TWO independent implementations over it:
//   Path A = the real parser (parseSessionText, per-file dedup, global re-dedup here)
//   Path B = a minimal inline scanner written from scratch
// If A and B agree on identical bytes, the dedup + summing logic is correct. We then compare the
// live DB to Path A for information only (any gap = turns written since the last index).
import { openDb } from "./db.ts";
import { listSessionFiles } from "./ingest/paths.ts";
import { parseSessionText } from "./ingest/claude-code.ts";
import { loadPricing, priceForModel } from "./core/pricing.ts";

interface T {
  turns: number;
  uncached: number;
  output: number;
  cacheRead: number;
}
const zero = (): T => ({ turns: 0, uncached: 0, output: 0, cacheRead: 0 });

function assert(name: string, a: number, b: number, fail = true) {
  const ok = a === b;
  console.log(`  ${ok ? "PASS" : fail ? "FAIL" : "····"}  ${name}: A=${a.toLocaleString()} B=${b.toLocaleString()}`);
  if (!ok && fail) process.exitCode = 1;
}

const pricing = await loadPricing();
const priceLookup = (m: string) => priceForModel(m, pricing);

// 1. Snapshot every session's bytes ONCE.
const files = await listSessionFiles();
const snapshots = await Promise.all(files.map((f) => Bun.file(f.path).text()));

// Path A — the real parser, globally deduped by messageId.
const seenA = new Set<string>();
const A = zero();
for (const raw of snapshots) {
  const { turns } = parseSessionText(raw, { priceLookup, actualMultiplier: pricing.actualCostMultiplier });
  for (const t of turns) {
    if (seenA.has(t.messageId)) continue;
    seenA.add(t.messageId);
    A.turns++;
    A.uncached += t.billing.uncached;
    A.output += t.billing.output;
    A.cacheRead += t.billing.cacheRead;
  }
}

// Path B — a from-scratch inline scanner, globally deduped by message.id.
const seenB = new Set<string>();
const B = zero();
for (const raw of snapshots) {
  for (const line of raw.split("\n")) {
    if (!line.includes('"assistant"')) continue;
    let r: any;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    const u = r?.message?.usage;
    const id = r?.message?.id;
    if (r.type !== "assistant" || !u || !id || seenB.has(id)) continue;
    seenB.add(id);
    B.turns++;
    B.uncached += u.input_tokens ?? 0;
    B.output += u.output_tokens ?? 0;
    B.cacheRead += u.cache_read_input_tokens ?? 0;
  }
}

console.log("Two independent implementations over the SAME byte snapshot:\n");
assert("distinct turns", A.turns, B.turns);
assert("uncached input tokens", A.uncached, B.uncached);
assert("output tokens", A.output, B.output);
assert("cache-read tokens", A.cacheRead, B.cacheRead);

// Informational: how far has the live session drifted past the last index?
const db = openDb();
const dbT = db.query(`SELECT COUNT(*) n, SUM(output) out FROM turns`).get() as any;
db.close();
const driftTurns = A.turns - (dbT.n ?? 0);
console.log(
  `\n  (info) live parser now sees ${A.turns.toLocaleString()} turns; DB has ${(dbT.n ?? 0).toLocaleString()} — ` +
    `${driftTurns >= 0 ? "+" : ""}${driftTurns.toLocaleString()} written since last index. Re-run 'bun run index' to refresh.`,
);

console.log(
  process.exitCode
    ? "\nVERIFICATION FAILED — the two implementations disagree; the parser has a bug."
    : "\nVERIFICATION PASSED — independent re-count agrees to the token. The numbers are the logs' own numbers.",
);
