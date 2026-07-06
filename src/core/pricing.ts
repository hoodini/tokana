// Pricing + cost calculation. Prices are LIST (API-equivalent) and fully editable in pricing.json.
import type { BillingBuckets, Cost } from "./schema.ts";

export interface ModelPrice {
  input: number;
  output: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
}

interface PricingFile {
  actualCostMultiplier: number;
  models: Record<string, ModelPrice>;
  fallback: ModelPrice;
}

let cache: PricingFile | null = null;

export async function loadPricing(path = new URL("../../pricing.json", import.meta.url)): Promise<PricingFile> {
  if (cache) return cache;
  cache = (await Bun.file(path).json()) as PricingFile;
  return cache;
}

/** Longest-prefix match: "claude-opus-4-8" -> "claude-opus-4". Falls back to the fallback price. */
export function priceForModel(model: string, p: PricingFile): ModelPrice {
  let best: { key: string; price: ModelPrice } | null = null;
  for (const [key, price] of Object.entries(p.models)) {
    if (model.startsWith(key) && (!best || key.length > best.key.length)) {
      best = { key, price };
    }
  }
  return best?.price ?? p.fallback;
}

const PER_M = 1_000_000;

/** Cost of one turn's billing buckets. `list` is API-equivalent; `actual` scales by the Max multiplier. */
export function costOf(b: BillingBuckets, price: ModelPrice, actualMultiplier: number): Cost {
  const list =
    (b.uncached * price.input +
      b.cacheCreate5m * price.cacheWrite5m +
      b.cacheCreate1h * price.cacheWrite1h +
      b.cacheRead * price.cacheRead +
      b.output * price.output) /
    PER_M;
  return { list, actual: list * actualMultiplier, currency: "USD" };
}

/**
 * What you would have paid if prompt caching did NOT exist — i.e. every cached token
 * billed at full input price. The gap between this and `costOf().list` is your cache savings.
 */
export function costWithoutCache(b: BillingBuckets, price: ModelPrice): number {
  const allInputAtFull = (b.uncached + b.cacheCreate5m + b.cacheCreate1h + b.cacheRead) * price.input;
  return (allInputAtFull + b.output * price.output) / PER_M;
}
