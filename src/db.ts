// SQLite storage (bun:sqlite). One row per deduplicated turn + a files table for incremental reindex.
import { Database } from "bun:sqlite";
import { fileURLToPath } from "node:url";
import type { Turn } from "./core/schema.ts";

export function openDb(path = fileURLToPath(new URL("../tokana.db", import.meta.url))): Database {
  const db = new Database(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(`CREATE TABLE IF NOT EXISTS turns (
    message_id   TEXT PRIMARY KEY,
    session_id   TEXT,
    project      TEXT,
    model        TEXT,
    ts           TEXT,
    is_sidechain INTEGER,
    source       TEXT,
    uncached     INTEGER,
    cc5m         INTEGER,
    cc1h         INTEGER,
    cache_read   INTEGER,
    output       INTEGER,
    total_input  INTEGER,
    total_tokens INTEGER,
    cost_list    REAL,
    cost_actual  REAL,
    cost_no_cache REAL,
    file         TEXT
  );`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_turns_session ON turns(session_id);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_turns_project ON turns(project);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_turns_ts ON turns(ts);`);
  db.exec(`CREATE TABLE IF NOT EXISTS files (
    path       TEXT PRIMARY KEY,
    mtime_ms   REAL,
    size       INTEGER,
    turns      INTEGER,
    indexed_at TEXT
  );`);
  return db;
}

export function upsertTurn(db: Database, t: Turn) {
  db.query(
    `INSERT OR REPLACE INTO turns
      (message_id, session_id, project, model, ts, is_sidechain, source,
       uncached, cc5m, cc1h, cache_read, output, total_input, total_tokens, cost_list, cost_actual, cost_no_cache, file)
     VALUES ($mid,$sid,$proj,$model,$ts,$side,$src,$unc,$cc5m,$cc1h,$cr,$out,$ti,$tt,$cl,$ca,$cnc,$file)`,
  ).run({
    $mid: t.messageId,
    $sid: t.sessionId,
    $proj: t.project,
    $model: t.model,
    $ts: t.ts,
    $side: t.isSidechain ? 1 : 0,
    $src: t.source,
    $unc: t.billing.uncached,
    $cc5m: t.billing.cacheCreate5m,
    $cc1h: t.billing.cacheCreate1h,
    $cr: t.billing.cacheRead,
    $out: t.billing.output,
    $ti: t.totalInput,
    $tt: t.totalTokens,
    $cl: t.cost.list,
    $ca: t.cost.actual,
    $cnc: t.costNoCache,
    $file: t.sourceFile ?? null,
  });
}

export function markFileIndexed(db: Database, path: string, mtimeMs: number, size: number, turns: number) {
  db.query(
    `INSERT OR REPLACE INTO files (path, mtime_ms, size, turns, indexed_at)
     VALUES ($p, $m, $s, $t, $at)`,
  ).run({ $p: path, $m: mtimeMs, $s: size, $t: turns, $at: new Date().toISOString() });
}

export function fileMtime(db: Database, path: string): number | null {
  const row = db.query(`SELECT mtime_ms FROM files WHERE path = $p`).get({ $p: path }) as
    | { mtime_ms: number }
    | undefined;
  return row?.mtime_ms ?? null;
}
