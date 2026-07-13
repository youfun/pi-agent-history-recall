import type { Freshness } from "../types.ts";

/**
 * Source weights for Reciprocal Rank Fusion.
 * DESIGN §Ranking: Latin FTS 1.0, CJK FTS 1.0, entity 1.4, constraint 1.1, trace target 1.2.
 */
const SOURCE_WEIGHT = { latinFts: 1.0, cjkFts: 1.0, entity: 1.4, constraint: 1.1, traceTarget: 1.2 } as const;

export interface RankInputs {
  /** Reciprocal rank in Latin FTS result set (1-based; 0 = not present). */
  latinRank: number;
  /** Reciprocal rank in CJK FTS result set (1-based; 0 = not present). */
  cjkRank: number;
  entityHits: number;
  traceHits: number;
  constraintCount: number;
  /** true when one or more entities independently appear as trace-step targets. */
  entityInTrace: boolean;
  /** true when a constraint has direct source-entry provenance (always true for extracted constraints). */
  constraintHasProvenance: boolean;
  toolCallCount: number;
  pairedResultCount: number;
  /** true when trace contains an edit, write, or verification step. */
  hasTerminalWrite: boolean;
  isOpenChunk: boolean;
  errorCount: number;
  hasSuccessAfterError: boolean;
  endTs: number;
  now: number;
  highDays?: number;
  mediumDays?: number;
}

export interface RankAxes {
  relevance: number;
  confidence: number;
  freshness: Freshness;
}

export function scoreAxes(input: RankInputs): RankAxes {
  // ── Relevance via Reciprocal Rank Fusion ──
  let rrf = 0;
  let rrfMax = 0;

  if (input.latinRank > 0) {
    rrf += SOURCE_WEIGHT.latinFts / (60 + input.latinRank);
  }
  if (input.cjkRank > 0) {
    rrf += SOURCE_WEIGHT.cjkFts / (60 + input.cjkRank);
  }
  if (input.entityHits > 0) {
    rrf += SOURCE_WEIGHT.entity / (60 + 1); // entity is boolean: present/absent
  }
  if (input.constraintCount > 0) {
    rrf += SOURCE_WEIGHT.constraint / (60 + 1);
  }
  if (input.traceHits > 0) {
    rrf += SOURCE_WEIGHT.traceTarget / (60 + 1);
  }

  // rrf_max: only count sources that actually participated.
  // Compute as: rrf for the same participating sources if they each scored at rank 1.
  {
    if (input.latinRank > 0) rrfMax += SOURCE_WEIGHT.latinFts / 61;
    if (input.cjkRank > 0) rrfMax += SOURCE_WEIGHT.cjkFts / 61;
    if (input.entityHits > 0) rrfMax += SOURCE_WEIGHT.entity / 61;
    if (input.constraintCount > 0) rrfMax += SOURCE_WEIGHT.constraint / 61;
    if (input.traceHits > 0) rrfMax += SOURCE_WEIGHT.traceTarget / 61;
  }
  // Guard: if no source participated, fall back to the full set so we don't divide by zero.
  if (rrfMax === 0) {
    rrfMax =
      SOURCE_WEIGHT.latinFts / 61 +
      SOURCE_WEIGHT.cjkFts / 61 +
      SOURCE_WEIGHT.entity / 61 +
      SOURCE_WEIGHT.constraint / 61 +
      SOURCE_WEIGHT.traceTarget / 61;
  }

  const rrfNorm = rrfMax > 0 ? (100 * rrf) / rrfMax : 0;

  // Exact bonus: capped at +25 for direct entity/file hits in query.
  const exactBonus = Math.min(25, input.entityHits * 5 + input.traceHits * 3);

  const relevance = clamp(
    Math.round(0.75 * rrfNorm + exactBonus),
  );

  // ── Confidence ──
  let confidence = 40;

  // All tool calls paired
  if (input.toolCallCount > 0) {
    if (input.pairedResultCount >= input.toolCallCount) {
      confidence += 15;
    } else if (input.pairedResultCount === 0) {
      confidence -= 20; // orphaned tool results
    }
  }
  // Tool-pairing bonus only applies when tool_call_count > 0 (vacuous-truth guard).

  // All referenced source entry IDs resolve (+15) — implied by valid paired calls.
  if (input.toolCallCount > 0 && input.pairedResultCount >= input.toolCallCount) {
    confidence += 15;
  }

  // Entity independently present in trace target
  if (input.entityInTrace) confidence += 10;

  // Terminal edit/write/verification
  if (input.hasTerminalWrite) confidence += 10;

  // Constraint has direct source provenance
  if (input.constraintHasProvenance && input.constraintCount > 0) {
    confidence += 10;
  }

  // Open chunk penalty
  if (input.isOpenChunk) confidence -= 30;

  // Error-only trace with no later success/verification
  if (input.errorCount > 0 && !input.hasSuccessAfterError) {
    confidence -= 10;
  }

  return {
    relevance,
    confidence: clamp(confidence),
    freshness: freshnessLabel(input.endTs, input.now, input.highDays ?? 7, input.mediumDays ?? 30),
  };
}

export function freshnessLabel(
  endTs: number,
  now: number,
  highDays = 7,
  mediumDays = 30,
): Freshness {
  if (!endTs) return "Low";
  const ageDays = (now - endTs) / (1000 * 60 * 60 * 24);
  if (ageDays <= highDays) return "High";
  if (ageDays <= mediumDays) return "Medium";
  return "Low";
}

function clamp(n: number): number {
  return Math.max(0, Math.min(100, n));
}
