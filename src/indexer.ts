// Batch indexer: parse every Claude Code session into SQLite. Incremental via mtime.
import { openDb, upsertTurn, markFileIndexed, fileMtime } from "./db.ts";
import { listSessionFiles } from "./ingest/paths.ts";
import { parseSessionFile } from "./ingest/claude-code.ts";
import { loadPricing, priceForModel } from "./core/pricing.ts";

export async function runIndex(opts: { full?: boolean } = {}) {
  const t0 = performance.now();
  const db = openDb();
  const pricing = await loadPricing();
  const priceLookup = (m: string) => priceForModel(m, pricing);

  const files = await listSessionFiles();
  let processed = 0,
    skipped = 0,
    turnCount = 0;

  for (const f of files) {
    if (!opts.full && fileMtime(db, f.path) === f.mtimeMs) {
      skipped++;
      continue;
    }
    try {
      const { turns } = await parseSessionFile(f.path, {
        priceLookup,
        actualMultiplier: pricing.actualCostMultiplier,
      });
      const tx = db.transaction(() => {
        for (const t of turns) upsertTurn(db, t);
        markFileIndexed(db, f.path, f.mtimeMs, f.size, turns.length);
      });
      tx();
      processed++;
      turnCount += turns.length;
    } catch (e) {
      console.error(`  ! failed ${f.path}: ${(e as Error).message}`);
    }
  }

  const totals = db
    .query(
      `SELECT COUNT(*) n, SUM(uncached) unc, SUM(cc5m) cc5m, SUM(cc1h) cc1h,
              SUM(cache_read) cr, SUM(output) out, SUM(cost_list) cost
       FROM turns`,
    )
    .get() as any;

  const secs = ((performance.now() - t0) / 1000).toFixed(1);
  console.log(`\ntokana indexed in ${secs}s`);
  console.log(`  files: ${processed} parsed, ${skipped} unchanged (of ${files.length})`);
  console.log(`  turns: ${totals.n?.toLocaleString() ?? 0} distinct message.id`);
  console.log(`  tokens: ${(totals.unc ?? 0).toLocaleString()} uncached in / ${(totals.out ?? 0).toLocaleString()} out`);
  console.log(
    `          ${(totals.cc5m ?? 0).toLocaleString()} cache-write-5m / ${(totals.cc1h ?? 0).toLocaleString()} cache-write-1h / ${(totals.cr ?? 0).toLocaleString()} cache-read`,
  );
  console.log(`  list-price cost (API-equivalent): $${(totals.cost ?? 0).toFixed(2)}`);
  db.close();
}

if (import.meta.main) {
  await runIndex({ full: Bun.argv.includes("--full") });
}
