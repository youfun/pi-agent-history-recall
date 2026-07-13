/** Latin/code tokenization helpers for FTS side channel. */

const CJK_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g;

export function stripLatinForFts(text: string): string {
  if (!text) return "";
  // Keep latin identifiers, numbers, paths; drop pure CJK (handled by grams).
  return text
    .normalize("NFC")
    .replace(CJK_RE, " ")
    .replace(/[^\x00-\x7F]+/g, " ")
    .replace(/[^A-Za-z0-9_./:@+-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function tokenizeQueryLatin(query: string): string[] {
  return stripLatinForFts(query)
    .split(/\s+/)
    .filter((t) => t.length >= 2)
    .slice(0, 64);
}
