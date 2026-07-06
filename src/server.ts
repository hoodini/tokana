// tokana hub: serves the dashboard + a REST API over the indexed turns, on-demand attribution,
// and a live SSE meter that tails the most-recently-active session so you see tokens accrue live.
import { openDb } from "./db.ts";
import { fileURLToPath } from "node:url";
import { stat } from "node:fs/promises";
import { listSessionFiles } from "./ingest/paths.ts";
import { parseSessionFile, type SessionParse } from "./ingest/claude-code.ts";
import { analyzeContext } from "./core/attribution.ts";
import { loadPricing, priceForModel } from "./core/pricing.ts";
import type { Turn } from "./core/schema.ts";

const PORT = Number(Bun.env.TOKANA_PORT ?? 4188);
const WEB = fileURLToPath(new URL("../web/", import.meta.url));
const db = openDb();
const pricing = await loadPricing();
const priceLookup = (m: string) => priceForModel(m, pricing);

// Parse cache keyed by path+mtime — attribution clicks and the live tick re-use a parse until the
// file changes, so we don't re-read and re-tokenize a multi-MB transcript on every request.
const parseCache = new Map<string, { mtimeMs: number; parsed: SessionParse }>();
async function cachedParse(path: string): Promise<SessionParse> {
  const mtimeMs = (await stat(path)).mtimeMs;
  const hit = parseCache.get(path);
  if (hit && hit.mtimeMs === mtimeMs) return hit.parsed;
  const parsed = await parseSessionFile(path, { priceLookup, actualMultiplier: pricing.actualCostMultiplier });
  parseCache.set(path, { mtimeMs, parsed });
  return parsed;
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

function summary() {
  const grand = db
    .query(
      `SELECT COUNT(*) turns, SUM(uncached) uncached, SUM(cc5m) cc5m, SUM(cc1h) cc1h,
              SUM(cache_read) cacheRead, SUM(output) output, SUM(total_input) totalInput,
              SUM(total_tokens) totalTokens, SUM(cost_list) costList, SUM(cost_actual) costActual,
              SUM(cost_no_cache) costNoCache FROM turns`,
    )
    .get() as any;
  grand.savings = (grand.costNoCache ?? 0) - (grand.costList ?? 0);
  const byModel = db
    .query(
      `SELECT model, COUNT(*) turns, SUM(total_tokens) tokens, SUM(cost_list) costList
       FROM turns GROUP BY model ORDER BY costList DESC`,
    )
    .all();
  const byProject = db
    .query(
      `SELECT project, COUNT(*) turns, SUM(total_tokens) totalTokens, SUM(cost_list) costList
       FROM turns GROUP BY project ORDER BY costList DESC LIMIT 20`,
    )
    .all();
  const byDay = db
    .query(
      `SELECT substr(ts,1,10) day, SUM(cost_list) costList, SUM(total_tokens) totalTokens, COUNT(*) turns
       FROM turns WHERE ts <> '' GROUP BY day ORDER BY day DESC LIMIT 45`,
    )
    .all();
  return { grand, byModel, byProject, byDay, actualMultiplier: pricing.actualCostMultiplier };
}

function sessions(project: string | null, limit: number) {
  const where = project ? `WHERE project = $proj` : ``;
  return db
    .query(
      `SELECT session_id, project, is_sidechain,
              MIN(ts) firstTs, MAX(ts) lastTs, COUNT(*) turns,
              SUM(uncached) uncached, SUM(cache_read) cacheRead, SUM(output) output,
              SUM(total_tokens) totalTokens, SUM(cost_list) costList, SUM(cost_no_cache) costNoCache,
              GROUP_CONCAT(DISTINCT model) models
       FROM turns ${where}
       GROUP BY session_id ORDER BY costList DESC LIMIT $lim`,
    )
    .all(project ? { $proj: project, $lim: limit } : { $lim: limit });
}

function sessionTurns(id: string) {
  return db
    .query(
      `SELECT message_id, ts, model, is_sidechain, uncached, cc5m, cc1h, cache_read, output,
              total_input, total_tokens, cost_list, cost_no_cache, file
       FROM turns WHERE session_id = $id ORDER BY ts ASC`,
    )
    .all({ $id: id });
}

async function attribution(messageId: string) {
  const row = db
    .query(`SELECT message_id, session_id, ts, model, total_input, file FROM turns WHERE message_id = $id`)
    .get({ $id: messageId }) as any;
  if (!row) return json({ error: "turn not found" }, 404);
  if (!row.file) return json({ error: "no source file recorded for this turn" }, 422);
  const { turns, records } = await cachedParse(row.file);
  const turn = turns.find((t) => t.messageId === messageId);
  if (!turn) return json({ error: "turn no longer in file" }, 410);
  const analysis = analyzeContext(turn, records);
  return json({
    messageId,
    model: turn.model,
    totalInput: turn.totalInput,
    billing: turn.billing,
    attribution: analysis.categories,
    visibleTokens: analysis.visibleTokens,
    baseline: analysis.baseline,
    items: analysis.items, // the ACTUAL redacted content of each context segment
    tokenizer: analysis.tokenizer,
    note:
      "Baseline (system + tool/MCP/skill schemas) is a RESIDUAL: totalInput minus tokenized visible content. " +
      "It has no content to show because it is NOT stored in the transcript. Per-item token counts use a proxy " +
      "tokenizer (Claude's real tokenizer is not public) — approximate. Content is redacted for obvious secrets.",
  });
}

// ---- Live meter: poll the newest session file, broadcast new turns over SSE. ----
const clients = new Set<(chunk: string) => void>();
let lastBroadcastMsgId = "";

async function liveTick() {
  const files = await listSessionFiles();
  if (!files.length) return;
  const newest = files.reduce((a, b) => (b.mtimeMs > a.mtimeMs ? b : a));
  const { turns } = await cachedParse(newest.path);
  if (!turns.length) return;
  const last = turns[turns.length - 1];
  if (last.messageId === lastBroadcastMsgId) return;
  lastBroadcastMsgId = last.messageId;
  const acc = turns.reduce(
    (s, t: Turn) => {
      s.totalTokens += t.totalTokens;
      s.cacheRead += t.billing.cacheRead;
      s.output += t.billing.output;
      s.costList += t.cost.list;
      s.costNoCache += t.costNoCache;
      return s;
    },
    { totalTokens: 0, cacheRead: 0, output: 0, costList: 0, costNoCache: 0 },
  );
  const payload = JSON.stringify({
    sessionId: last.sessionId,
    project: last.project,
    model: last.model,
    turns: turns.length,
    turn: { totalInput: last.totalInput, billing: last.billing, costList: last.cost.list },
    session: acc,
    ts: last.ts,
  });
  for (const send of clients) send(`event: turn\ndata: ${payload}\n\n`);
}
setInterval(() => void liveTick().catch(() => {}), 1500);

Bun.serve({
  port: PORT,
  idleTimeout: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const p = url.pathname;

    if (p === "/api/summary") return json(summary());
    if (p === "/api/sessions")
      return json(sessions(url.searchParams.get("project"), Number(url.searchParams.get("limit") ?? 50)));
    if (p.startsWith("/api/session/")) return json(sessionTurns(decodeURIComponent(p.slice("/api/session/".length))));
    if (p.startsWith("/api/turn/") && p.endsWith("/attribution"))
      return attribution(decodeURIComponent(p.slice("/api/turn/".length, -"/attribution".length)));

    if (p === "/api/live") {
      const stream = new ReadableStream({
        start(controller) {
          const send = (chunk: string) => {
            try {
              controller.enqueue(new TextEncoder().encode(chunk));
            } catch {}
          };
          send(`event: hello\ndata: {"ok":true}\n\n`);
          clients.add(send);
          const ping = setInterval(() => send(`: ping\n\n`), 15000);
          req.signal.addEventListener("abort", () => {
            clearInterval(ping);
            clients.delete(send);
          });
        },
      });
      return new Response(stream, {
        headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
      });
    }

    // static files
    const file = Bun.file(WEB + (p === "/" ? "index.html" : p.replace(/^\//, "")));
    if (await file.exists()) return new Response(file);
    return new Response("not found", { status: 404 });
  },
});

console.log(`tokana hub → http://localhost:${PORT}`);
