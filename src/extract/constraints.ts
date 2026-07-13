import { redactText } from "../privacy.ts";
import type { ExtractedConstraint } from "../types.ts";
import { EXTRACTOR_VERSION, MAX_CONTEXT } from "../types.ts";

const EN_TRIGGERS =
  /\b(because|must not|must|cannot|constraint|rule|invariant|required)\b/i;
const ZH_TRIGGERS = /(因为|必须|不得|不能|约束|规则|不变量|要求)/;

const QUOTED_CODE_ONLY = /^[`'"][^`'"]{0,80}[`'"]$/;
const NEGATION_FALSE_POS =
  /\b(?:must\s+see|must\s+have\s+missed|cannot\s+find|cannot\s+locate)\b/i;

export function extractConstraints(
  text: string,
  sourceEntryId: string,
): ExtractedConstraint[] {
  if (!text) return [];
  const out: ExtractedConstraint[] = [];
  const sentences = splitSentences(text);
  for (const sentence of sentences) {
    const s = sentence.trim();
    if (s.length < 8 || s.length > 400) continue;
    if (QUOTED_CODE_ONLY.test(s)) continue;
    if (NEGATION_FALSE_POS.test(s)) continue;

    const en = s.match(EN_TRIGGERS);
    const zh = s.match(ZH_TRIGGERS);
    const trigger = en?.[1] ?? zh?.[1];
    if (!trigger) continue;

    const cleaned = redactText(s.replace(/\s+/g, " "), MAX_CONTEXT);
    out.push({
      text: cleaned,
      normalizedText: cleaned.toLowerCase().normalize("NFC"),
      trigger: trigger.toLowerCase(),
      confidence: 0.55,
      sourceEntryId,
      extractorVersion: EXTRACTOR_VERSION,
    });
  }
  return out;
}

function splitSentences(text: string): string[] {
  // Split on Chinese/English sentence boundaries while keeping content.
  return text
    .split(/(?<=[。！？.!?\n])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}
