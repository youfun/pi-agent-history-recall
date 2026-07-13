/** CJK detection and n-gram generation for FTS. */

const CJK_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

export function hasCjk(text: string): boolean {
  return CJK_RE.test(text);
}

export function extractCjkSpans(text: string): string[] {
  if (!text) return [];
  const spans: string[] = [];
  let buf = "";
  for (const ch of text.normalize("NFC")) {
    if (CJK_RE.test(ch)) {
      buf += ch;
    } else if (buf) {
      spans.push(buf);
      buf = "";
    }
  }
  if (buf) spans.push(buf);
  return spans;
}

/** Overlapping 2- and 3-code-point grams for a CJK span. */
export function gramsForSpan(span: string): string[] {
  const chars = [...span];
  const grams: string[] = [];
  if (chars.length === 1) {
    grams.push(chars[0]!);
    return grams;
  }
  for (let i = 0; i < chars.length - 1; i++) {
    grams.push(chars[i]! + chars[i + 1]!);
    if (i + 2 < chars.length) {
      grams.push(chars[i]! + chars[i + 1]! + chars[i + 2]!);
    }
  }
  return grams;
}

export function cjkGramsFromText(...parts: string[]): string {
  const set = new Set<string>();
  for (const part of parts) {
    for (const span of extractCjkSpans(part)) {
      for (const g of gramsForSpan(span)) set.add(g);
    }
  }
  return [...set].join(" ");
}
