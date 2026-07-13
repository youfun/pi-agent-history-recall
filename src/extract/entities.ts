import { displayPath, isSensitivePath, redactText } from "../privacy.ts";
import type { EntityType, ExtractedEntity } from "../types.ts";
import { MAX_CONTEXT } from "../types.ts";

const BACKTICK_ID = /`([A-Za-z_][\w./:-]{1,120})`/g;
const SYMBOL_RE = /\b([A-Z][A-Za-z0-9_]{2,}(?:\.[A-Za-z_][\w]*)*|[a-z_][a-z0-9_]{2,}\/[0-9]+)\b/g;
const PATH_RE =
  /(?:^|[\s"'`(])((?:\.\.?\/|\/)?[\w.@+-]+(?:\/[\w.@+-]+)+\.\w{1,8}|[\w.@+-]+\.\w{1,8})(?=[\s"'`,);:\]]|$)/g;

const ERROR_LINE_RE =
  /(?:Error|Exception|FAILED|fatal:|panic:|Traceback|undefined|not found|E\d{3,4})\b[^\n]{0,200}/gi;

export function normalizeEntityValue(value: string, type: EntityType, canonicalCwd: string): string {
  let v = value.trim().normalize("NFC");
  if (type === "file_path") {
    v = displayPath(v.replace(/\\/g, "/"), canonicalCwd);
  }
  return v.toLowerCase();
}

export function extractPathEntities(
  text: string,
  sourceEntryId: string,
  canonicalCwd: string,
  confidence = 0.7,
): ExtractedEntity[] {
  const out: ExtractedEntity[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(PATH_RE)) {
    const raw = m[1]!;
    if (isSensitivePath(raw)) continue;
    const display = displayPath(raw, canonicalCwd);
    const key = `file_path:${display.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      entityType: "file_path",
      value: display,
      normalizedValue: normalizeEntityValue(display, "file_path", canonicalCwd),
      context: redactText(surrounding(text, m.index ?? 0), MAX_CONTEXT),
      confidence,
      sourceEntryId,
    });
  }
  return out;
}

export function extractSymbolEntities(
  text: string,
  sourceEntryId: string,
  canonicalCwd: string,
  confidence = 0.6,
): ExtractedEntity[] {
  const out: ExtractedEntity[] = [];
  const seen = new Set<string>();
  for (const re of [BACKTICK_ID, SYMBOL_RE]) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      const raw = m[1]!;
      if (raw.includes("/") && raw.includes(".")) {
        // Likely a path; skip here.
        continue;
      }
      if (raw.length < 3) continue;
      const key = `symbol:${raw.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        entityType: "symbol",
        value: raw,
        normalizedValue: normalizeEntityValue(raw, "symbol", canonicalCwd),
        context: redactText(surrounding(text, m.index ?? 0), MAX_CONTEXT),
        confidence,
        sourceEntryId,
      });
    }
  }
  return out;
}

export function extractErrorEntities(
  text: string,
  sourceEntryId: string,
  canonicalCwd: string,
  confidence = 0.8,
): ExtractedEntity[] {
  const out: ExtractedEntity[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(ERROR_LINE_RE)) {
    const raw = redactText(m[0]!.trim(), 240);
    if (raw.length < 8) continue;
    const key = raw.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      entityType: "error",
      value: raw,
      normalizedValue: normalizeEntityValue(raw, "error", canonicalCwd),
      context: "",
      confidence,
      sourceEntryId,
    });
  }
  return out;
}

export function entityFromPathArg(
  path: string,
  sourceEntryId: string,
  canonicalCwd: string,
  confidence = 0.95,
): ExtractedEntity | null {
  if (!path || isSensitivePath(path)) return null;
  const display = displayPath(path, canonicalCwd);
  return {
    entityType: "file_path",
    value: display,
    normalizedValue: normalizeEntityValue(display, "file_path", canonicalCwd),
    context: "",
    confidence,
    sourceEntryId,
  };
}

export function entityFromModule(
  moduleName: string,
  sourceEntryId: string,
  canonicalCwd: string,
  confidence = 0.75,
): ExtractedEntity {
  return {
    entityType: "module",
    value: moduleName,
    normalizedValue: normalizeEntityValue(moduleName, "module", canonicalCwd),
    context: "",
    confidence,
    sourceEntryId,
  };
}

function surrounding(text: string, index: number, radius = 80): string {
  const start = Math.max(0, index - radius);
  const end = Math.min(text.length, index + radius);
  return text.slice(start, end).replace(/\s+/g, " ");
}
