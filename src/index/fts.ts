import { cjkGramsFromText, hasCjk } from "../extract/cjk.ts";
import { tokenizeQueryLatin } from "../extract/text.ts";
import { MAX_QUERY_CHARS, MAX_QUERY_TOKENS } from "../types.ts";

/**
 * Build safe FTS5 MATCH queries for the dual FTS tables.
 * Returns { latin, cjk } strings, each suitable for MATCH on the respective table.
 * Returns null if an FTS table would have no terms.
 */
export function buildFtsMatchQueries(rawQuery: string): {
  latin: string | null;
  cjk: string | null;
} {
  const q = rawQuery.normalize("NFC").trim().slice(0, MAX_QUERY_CHARS);
  if (!q) return { latin: null, cjk: null };

  const latinTerms: string[] = [];
  for (const t of tokenizeQueryLatin(q).slice(0, MAX_QUERY_TOKENS)) {
    const safe = sanitizeToken(t);
    if (safe) latinTerms.push(safe);
  }

  const cjkTerms: string[] = [];
  if (hasCjk(q)) {
    const grams = cjkGramsFromText(q).split(/\s+/).filter(Boolean);
    for (const g of grams.slice(0, MAX_QUERY_TOKENS)) {
      const safe = sanitizeToken(g);
      if (safe) cjkTerms.push(safe);
    }
  }

  return {
    latin:
      latinTerms.length > 0
        ? latinTerms.map((t) => `"${t}"`).join(" OR ")
        : null,
    cjk:
      cjkTerms.length > 0
        ? cjkTerms.map((t) => `"${t}"`).join(" OR ")
        : null,
  };
}

function sanitizeToken(t: string): string | null {
  // Strip FTS operators / quotes.
  const cleaned = t.replace(/["\*\^\(\):]/g, "").trim();
  if (cleaned.length < 1) return null;
  if (cleaned.length > 64) return cleaned.slice(0, 64);
  return cleaned;
}

/**
 * Extract query-side entities (paths, symbols, terms) for boosting
 * independent of FTS recall.
 */
export function extractQueryEntities(query: string): {
  paths: string[];
  symbols: string[];
  terms: string[];
} {
  const q = query.normalize("NFC").slice(0, MAX_QUERY_CHARS);
  const paths: string[] = [];
  const symbols: string[] = [];
  const pathRe =
    /(?:^|[\s"'`(])((?:\.\.?\/|\/)?[\w.@+-]+(?:\/[\w.@+-]+)+\.\w{1,8}|[\w.@+-]+\.\w{1,8})/g;
  for (const m of q.matchAll(pathRe)) {
    paths.push(m[1]!.toLowerCase());
  }
  const symRe = /`([^`]+)`|\b([A-Z][A-Za-z0-9_]{2,})\b/g;
  for (const m of q.matchAll(symRe)) {
    const s = (m[1] || m[2] || "").trim();
    if (s) symbols.push(s.toLowerCase());
  }
  const terms = tokenizeQueryLatin(q);
  return { paths, symbols, terms };
}
