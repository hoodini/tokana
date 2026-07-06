#!/usr/bin/env node
// tokana statusline for Claude Code.
//
// Wire it up in ~/.claude/settings.json (use the absolute path to this file on your machine):
//   "statusLine": { "type": "command", "command": "node '/absolute/path/to/tokana/bin/statusline.mjs'" }
//
// Claude Code passes a JSON blob on stdin (session_id, transcript_path, model, cwd, ...).
// We read the transcript, dedup by message.id (the critical rule), and print one live line:
// session list-cost, the latest turn's in/out, and what share of context is cache-read.
// Node-only, zero deps — never assumes bun is on PATH inside Claude Code's environment.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const PRICES = {
  "claude-opus-4": { in: 15, out: 75, w5: 18.75, w1: 30, r: 1.5 },
  "claude-sonnet-4": { in: 3, out: 15, w5: 3.75, w1: 6, r: 0.3 },
  "claude-haiku-4": { in: 1, out: 5, w5: 1.25, w1: 2, r: 0.1 },
};
const FALLBACK = PRICES["claude-opus-4"];
function priceFor(model = "") {
  let best = null;
  for (const k of Object.keys(PRICES)) if (model.startsWith(k) && (!best || k.length > best.length)) best = k;
  return best ? PRICES[best] : FALLBACK;
}

// Optional: honor actualCostMultiplier from pricing.json next to the repo.
let actualMult = 0;
try {
  const p = JSON.parse(readFileSync(fileURLToPath(new URL("../pricing.json", import.meta.url)), "utf8"));
  if (typeof p.actualCostMultiplier === "number") actualMult = p.actualCostMultiplier;
} catch {}

function read(stream) {
  return new Promise((res) => {
    let d = "";
    stream.setEncoding("utf8");
    stream.on("data", (c) => (d += c));
    stream.on("end", () => res(d));
    stream.on("error", () => res(d));
  });
}

const raw = await read(process.stdin);
let ctx = {};
try {
  ctx = JSON.parse(raw || "{}");
} catch {}
const path = ctx.transcript_path;
if (!path) {
  process.stdout.write("⧉ tokana: no transcript");
  process.exit(0);
}

let text = "";
try {
  text = readFileSync(path, "utf8");
} catch {
  process.stdout.write("⧉ tokana: transcript unreadable");
  process.exit(0);
}

const seen = new Set();
let costList = 0,
  totalIn = 0,
  cacheRead = 0,
  turns = 0;
let last = null;
for (const line of text.split("\n")) {
  if (!line.includes('"assistant"')) continue;
  let r;
  try {
    r = JSON.parse(line);
  } catch {
    continue;
  }
  const u = r?.message?.usage,
    id = r?.message?.id;
  if (r.type !== "assistant" || !u || !id || seen.has(id)) continue;
  seen.add(id);
  turns++;
  const p = priceFor(r.message.model || ctx.model?.id || "");
  const cc = u.cache_creation ?? {};
  const w5 = cc.ephemeral_5m_input_tokens ?? 0;
  const w1 = cc.ephemeral_1h_input_tokens ?? u.cache_creation_input_tokens ?? 0;
  const rd = u.cache_read_input_tokens ?? 0;
  const unc = u.input_tokens ?? 0;
  const out = u.output_tokens ?? 0;
  costList += (unc * p.in + w5 * p.w5 + w1 * p.w1 + rd * p.r + out * p.out) / 1e6;
  totalIn += unc + w5 + w1 + rd;
  cacheRead += rd;
  last = { in: unc + w5 + w1 + rd, out };
}

const usd = (n) => "$" + n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const cachePct = totalIn ? Math.round((100 * cacheRead) / totalIn) : 0;
const lastStr = last ? `${(last.in / 1000).toFixed(0)}k in/${last.out} out` : "—";
const money = actualMult > 0 ? usd(costList * actualMult) : `${usd(costList)} list`;
process.stdout.write(`⧉ ${turns} turns · ${money} · last ${lastStr} · ${cachePct}% cached`);
