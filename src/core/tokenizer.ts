// Tokenizer adapters.
//
// HONESTY NOTE: Anthropic does not publish Claude's tokenizer. We use cl100k_base as a
// PROXY to approximate Claude token counts for the attribution breakdown and the visualizer.
// Every count produced here for a Claude model is APPROXIMATE and must be labeled as such.
// For GPT/o-series models these counts are EXACT (same encodings the API uses).
import { getEncoding, type Tiktoken } from "js-tiktoken";

const encoders: Record<string, Tiktoken> = {};

function enc(name: "cl100k_base" | "o200k_base"): Tiktoken {
  return (encoders[name] ??= getEncoding(name));
}

// encode(text, allowedSpecial=[], disallowedSpecial=[]) — the empty disallowed set stops js-tiktoken
// from THROWING when reserved sequences like "<|endoftext|>" appear in real content; they are counted
// as ordinary text instead, which is the correct "how many tokens is this string" answer.
function encodeSafe(e: Tiktoken, text: string): number[] {
  return e.encode(text, [], []);
}

/** Approximate token count for Claude context (proxy tokenizer). Never claim this is exact. */
export function approxTokens(text: string): number {
  if (!text) return 0;
  try {
    return encodeSafe(enc("cl100k_base"), text).length;
  } catch {
    // Fall back to the classic ~4 chars/token heuristic if the encoder rejects the input.
    return Math.ceil(text.length / 4);
  }
}

/** Token-by-token segmentation for the visualizer. `exact` is false for Claude proxy. */
export function segment(text: string, encoding: "cl100k_base" | "o200k_base") {
  const e = enc(encoding);
  try {
    const ids = encodeSafe(e, text);
    const pieces = ids.map((id) => ({ id, text: e.decode([id]) }));
    return { count: ids.length, pieces };
  } catch {
    return { count: Math.ceil(text.length / 4), pieces: [] as { id: number; text: string }[] };
  }
}
