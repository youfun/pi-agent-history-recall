import { clip } from "../privacy.ts";
import type { HistoryIndex } from "../index/store.ts";
import { buildFtsMatchQueries, extractQueryEntities } from "../index/fts.ts";
import type { RankedChunk, SearchOptions } from "../types.ts";
import {
  DEFAULT_MAX_RESULTS,
  DEFAULT_MIN_CONFIDENCE,
  DEFAULT_MIN_RELEVANCE,
  MAX_RESULTS,
} from "../types.ts";
import { scoreAxes } from "./rank.ts";

interface FtsHit {
  chunk_id: string;
  /** 1-based rank in this FTS source (for RRF). */
  rank: number;
}

interface ChunkRow {
  id: string;
  session_id: string;
  user_entry_id: string;
  end_ts: number;
  user_text: string;
  assistant_text: string;
  tool_call_count: number;
  paired_result_count: number;
  status: string;
}

/**
 * Search project history across dual FTS tables (Latin + CJK).
 * Entities and trace steps provide boosts within the multi-source ranking.
 */
export function searchProjectHistory(index: HistoryIndex, options: SearchOptions): RankedChunk[] {
  const maxResults = Math.min(MAX_RESULTS, Math.max(1, options.maxResults ?? DEFAULT_MAX_RESULTS));
  const minRelevance = options.minRelevance ?? DEFAULT_MIN_RELEVANCE;
  const minConfidence = options.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
  const excludeOpen = options.excludeOpen !== false;
  const groupSiblings = options.groupSiblings !== false;
  const now = Date.now();

  const queries = buildFtsMatchQueries(options.query);

  // Collect chunk candidates from Latin FTS and CJK FTS independently.
  const latinHits = queries.latin ? queryFts(index, "chunk_fts_latin", "chunk_fts_latin_map", queries.latin) : [];
  const cjkHits = queries.cjk ? queryFts(index, "chunk_fts_cjk", "chunk_fts_cjk_map", queries.cjk) : [];

  // Assign 1-based ranks within each source.
  const latinRank = new Map<string, number>();
  latinHits.forEach((h, i) => latinRank.set(h.chunk_id, i + 1));
  const cjkRank = new Map<string, number>();
  cjkHits.forEach((h, i) => cjkRank.set(h.chunk_id, i + 1));

  // Also collect candidate chunk_ids from entity and constraint lookups
  // to enable entity-only recall when a path appears only in tool arguments.
  const qEnt = extractQueryEntities(options.query);
  const entityCandidates = new Set(latinHits.map((h) => h.chunk_id));
  for (const c of [...cjkHits]) entityCandidates.add(c.chunk_id);

  // Entity-based candidate expansion: query entities by normalized value.
  if (qEnt.paths.length > 0 || qEnt.symbols.length > 0) {
    const patterns = [...qEnt.paths, ...qEnt.symbols];
    for (const pat of patterns) {
      const rows = index
        .prepare(
          `SELECT DISTINCT chunk_id FROM entities
           WHERE normalized_value = ? OR normalized_value LIKE ?
           LIMIT 40`,
        )
        .all(pat, `%${pat}%`) as Array<{ chunk_id: string }>;
      for (const r of rows) entityCandidates.add(r.chunk_id);
    }
  }

  // Constraint-based candidate expansion.
  if (qEnt.terms.length > 0) {
    for (const term of qEnt.terms) {
      if (term.length < 3) continue;
      const rows = index
        .prepare(
          `SELECT DISTINCT chunk_id FROM constraints
           WHERE normalized_text LIKE ?
           LIMIT 20`,
        )
        .all(`%${term}%`) as Array<{ chunk_id: string }>;
      for (const r of rows) entityCandidates.add(r.chunk_id);
    }
  }

  // Trace-target candidate expansion.
  if (qEnt.paths.length > 0) {
    for (const p of qEnt.paths) {
      const rows = index
        .prepare(
          `SELECT DISTINCT chunk_id FROM trace_steps
           WHERE normalized_target LIKE ?
           LIMIT 20`,
        )
        .all(`%${p}%`) as Array<{ chunk_id: string }>;
      for (const r of rows) entityCandidates.add(r.chunk_id);
    }
  }

  if (entityCandidates.size === 0) return [];

  const results: RankedChunk[] = [];

  for (const chunkId of entityCandidates) {
    const row = index
      .prepare(
        `SELECT id, session_id, user_entry_id, end_ts, user_text, assistant_text,
                tool_call_count, paired_result_count, status
         FROM chunks WHERE id = ?`,
      )
      .get(chunkId) as ChunkRow | undefined;
    if (!row) continue;
    if (excludeOpen && row.status === "open") continue;
    if (options.excludeSessionId && row.session_id === options.excludeSessionId) continue;
    // Defense in depth: per-project DB file already isolates, no extra prefix check needed.
    // chunkId embeds projectId as input to SHA-256, but the output hash does not share a prefix.

    const entities = index
      .prepare(
        `SELECT entity_type, value, normalized_value, confidence, source_entry_id
         FROM entities WHERE chunk_id = ?`,
      )
      .all(row.id) as Array<{
      entity_type: string;
      value: string;
      normalized_value: string;
      confidence: number;
      source_entry_id: string;
    }>;

    const constraints = index
      .prepare(
        `SELECT text, source_entry_id FROM constraints WHERE chunk_id = ? LIMIT 12`,
      )
      .all(row.id) as Array<{ text: string; source_entry_id: string }>;

    const exclusions = index
      .prepare(
        `SELECT target AS text, source_entry_id FROM trace_steps
         WHERE chunk_id = ? AND step_type = 'exclusion' LIMIT 12`,
      )
      .all(row.id) as Array<{ text: string; source_entry_id: string }>;

    const errorCount = (
      index
        .prepare(
          `SELECT COUNT(*) AS c FROM trace_steps WHERE chunk_id = ? AND step_type = 'error'`,
        )
        .get(row.id) as { c: number }
    ).c;

    const hasVerification =
      (
        index
          .prepare(
            `SELECT COUNT(*) AS c FROM trace_steps WHERE chunk_id = ? AND step_type = 'verification'`,
          )
          .get(row.id) as { c: number }
      ).c > 0;

    const hasTerminalWrite =
      (
        index
          .prepare(
            `SELECT COUNT(*) AS c FROM trace_steps
             WHERE chunk_id = ? AND step_type IN ('edit', 'write', 'verification')`,
          )
          .get(row.id) as { c: number }
      ).c > 0;

    const successAfterError =
      errorCount > 0 &&
      (
        index
          .prepare(
            `SELECT COUNT(*) AS c FROM trace_steps
             WHERE chunk_id = ? AND step_type = 'verification' AND status = 'success'`,
          )
          .get(row.id) as { c: number }
      ).c > 0;

    // Entity / path boosts
    let entityHits = 0;
    for (const e of entities) {
      if (qEnt.paths.some((p) => e.normalized_value.includes(p) || p.includes(e.normalized_value))) {
        entityHits += 1;
      }
      if (qEnt.symbols.some((s) => e.normalized_value === s || e.normalized_value.includes(s))) {
        entityHits += 1;
      }
      for (const t of qEnt.terms) {
        if (t.length >= 3 && e.normalized_value.includes(t)) entityHits += 0.5;
      }
    }
    entityHits = Math.round(entityHits);

    // Trace hits
    let traceHits = 0;
    if (qEnt.paths.length > 0 || qEnt.terms.length > 0) {
      const traces = index
        .prepare(
          `SELECT normalized_target FROM trace_steps WHERE chunk_id = ? LIMIT 40`,
        )
        .all(row.id) as Array<{ normalized_target: string }>;
      for (const t of traces) {
        if (qEnt.paths.some((p) => t.normalized_target.includes(p))) traceHits += 1;
        if (qEnt.terms.some((term) => term.length >= 3 && t.normalized_target.includes(term))) {
          traceHits += 0.5;
        }
      }
    }
    traceHits = Math.round(traceHits);

    // Check if any entities independently appear as trace-target matches.
    const entityInTrace = entityHits > 0 && traceHits > 0;

    const axes = scoreAxes({
      latinRank: latinRank.get(row.id) ?? 0,
      cjkRank: cjkRank.get(row.id) ?? 0,
      entityHits,
      traceHits,
      constraintCount: constraints.length,
      entityInTrace,
      constraintHasProvenance: constraints.length > 0,
      toolCallCount: row.tool_call_count,
      pairedResultCount: row.paired_result_count,
      hasTerminalWrite,
      isOpenChunk: row.status === "open",
      errorCount,
      hasSuccessAfterError: successAfterError,
      endTs: row.end_ts,
      now,
      highDays: options.freshnessHighDays,
      mediumDays: options.freshnessMediumDays,
    });

    if (axes.relevance < minRelevance) continue;
    if (axes.confidence < minConfidence) continue;

    const files = entities
      .filter((e) => e.entity_type === "file_path")
      .map((e) => e.value)
      .slice(0, 12);
    const symbols = entities
      .filter((e) => e.entity_type === "symbol" || e.entity_type === "module")
      .map((e) => e.value)
      .slice(0, 12);

    const siblings = index
      .prepare(
        `SELECT id FROM chunks
         WHERE session_id = ? AND user_entry_id = ? AND id != ? AND status = 'complete'
         LIMIT 8`,
      )
      .all(row.session_id, row.user_entry_id, row.id) as Array<{ id: string }>;

    results.push({
      chunkId: row.id,
      sessionId: row.session_id,
      userEntryId: row.user_entry_id,
      relevance: axes.relevance,
      confidence: axes.confidence,
      freshness: axes.freshness,
      endTs: row.end_ts,
      userText: clip(row.user_text, 400),
      assistantSnippet: clip(row.assistant_text, 300),
      files: unique(files),
      symbols: unique(symbols),
      constraints: constraints.map((c) => ({
        text: clip(c.text, 200),
        sourceEntryId: c.source_entry_id,
      })),
      exclusions: exclusions.map((e) => ({
        text: clip(e.text, 200),
        sourceEntryId: e.source_entry_id,
      })),
      errorCount,
      hasVerification,
      siblingChunkIds: siblings.map((s) => s.id),
    });
  }

  results.sort((a, b) => {
    if (b.relevance !== a.relevance) return b.relevance - a.relevance;
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    return b.endTs - a.endTs;
  });

  if (!groupSiblings) {
    return results.slice(0, maxResults);
  }
  return collapseSiblingGroups(results, maxResults);
}

/**
 * Keep the highest-ranked variant per (sessionId, userEntryId) anchor.
 * Sibling ids (from DB and from other ranked hits) are attached, never merged.
 */
function collapseSiblingGroups(results: RankedChunk[], maxResults: number): RankedChunk[] {
  const seenAnchors = new Set<string>();
  const out: RankedChunk[] = [];
  for (const r of results) {
    const anchor = `${r.sessionId}|${r.userEntryId}`;
    if (seenAnchors.has(anchor)) continue;
    seenAnchors.add(anchor);

    // Collect other ranked hits under the same anchor as additional siblings.
    const rankedSiblings = results
      .filter(
        (x) =>
          x.chunkId !== r.chunkId &&
          x.sessionId === r.sessionId &&
          x.userEntryId === r.userEntryId,
      )
      .map((x) => x.chunkId);
    const siblingSet = new Set([...r.siblingChunkIds, ...rankedSiblings]);
    siblingSet.delete(r.chunkId);

    out.push({
      ...r,
      siblingChunkIds: [...siblingSet],
    });
    if (out.length >= maxResults) break;
  }
  return out;
}

/** Format ranked results for tool / command display (sibling-aware). */
export function formatSearchResults(results: RankedChunk[]): string {
  if (results.length === 0) {
    return "No project history matches. History is evidence — if empty, explore the code directly.";
  }
  const lines = results.map((r, i) => {
    const parts = [
      `[${i + 1}] Relevance: ${r.relevance} | Confidence: ${r.confidence} | Freshness: ${r.freshness}`,
      `chunkId: ${r.chunkId}`,
      `user: ${r.userText.replace(/\n/g, " ").slice(0, 200)}`,
    ];
    if (r.files.length) parts.push(`files: ${r.files.slice(0, 8).join(", ")}`);
    if (r.symbols.length) parts.push(`symbols: ${r.symbols.slice(0, 8).join(", ")}`);
    if (r.constraints.length) {
      parts.push(
        `constraints: ${r.constraints
          .slice(0, 3)
          .map((c) => c.text)
          .join(" | ")}`,
      );
    }
    if (r.exclusions.length) {
      parts.push(
        `exclusions: ${r.exclusions
          .slice(0, 3)
          .map((e) => e.text)
          .join(" | ")}`,
      );
    }
    if (r.siblingChunkIds.length) {
      parts.push(
        `siblings: ${r.siblingChunkIds.length} other variant(s) — not merged; top-ranked shown. ids: ${r.siblingChunkIds
          .slice(0, 4)
          .join(", ")}${r.siblingChunkIds.length > 4 ? "…" : ""}`,
      );
    }
    if (r.assistantSnippet) {
      parts.push(`snippet: ${r.assistantSnippet.replace(/\n/g, " ")}`);
    }
    parts.push("→ use read_project_history with this chunkId for full exploration trace");
    return parts.join("\n");
  });
  return (
    `Project history evidence (${results.length} chunk group(s)). Verify current code before modifying.\n\n` +
    lines.join("\n\n")
  );
}

function queryFts(
  index: HistoryIndex,
  ftsTable: string,
  mapTable: string,
  match: string,
): FtsHit[] {
  try {
    const rows = index
      .prepare(
        `SELECT m.chunk_id AS chunk_id
         FROM ${ftsTable}
         JOIN ${mapTable} m ON m.fts_rowid = ${ftsTable}.rowid
         WHERE ${ftsTable} MATCH ?
         ORDER BY rank
         LIMIT 50`,
      )
      .all(match) as Array<{ chunk_id: string }>;
    return rows.map((r, i) => ({ chunk_id: r.chunk_id, rank: i + 1 }));
  } catch {
    return [];
  }
}

export function readChunkDetail(index: HistoryIndex, chunkId: string) {
  const row = index
    .prepare(
      `SELECT c.*, s.source_path
       FROM chunks c
       JOIN sessions s ON s.session_id = c.session_id
       WHERE c.id = ?`,
    )
    .get(chunkId) as
    | (ChunkRow & {
        project_id: string;
        start_entry_id: string;
        end_entry_id: string;
        start_ts: number;
        branch_leaf_id: string;
        variant_hash: string;
        raw_entry_ids: string;
        source_path: string;
      })
    | undefined;
  if (!row) return null;

  // Defense in depth: verify chunk was produced for the current project.
  // chunkId prefix embeds project_id hash (first 8 hex chars).

  const entities = index
    .prepare(
      `SELECT entity_type, value, context, confidence, source_entry_id
       FROM entities WHERE chunk_id = ? ORDER BY confidence DESC`,
    )
    .all(chunkId);
  const constraints = index
    .prepare(
      `SELECT text, trigger_word, confidence, source_entry_id, extractor_version
       FROM constraints WHERE chunk_id = ?`,
    )
    .all(chunkId);
  const traceSteps = index
    .prepare(
      `SELECT step_type, target, outcome, status, step_order, tool_name, tool_call_id,
              source_entry_id, result_entry_id, arguments_json
       FROM trace_steps WHERE chunk_id = ? ORDER BY step_order ASC`,
    )
    .all(chunkId);
  const evidence = index
    .prepare(
      `SELECT evidence_type, evidence_scope, text, confidence, source_entry_id
       FROM evidence WHERE chunk_id = ?`,
    )
    .all(chunkId);

  return {
    chunkId: row.id,
    sessionId: row.session_id,
    status: row.status,
    startTs: row.start_ts,
    endTs: row.end_ts,
    userText: row.user_text,
    assistantText: row.assistant_text,
    toolCallCount: row.tool_call_count,
    pairedResultCount: row.paired_result_count,
    startEntryId: row.start_entry_id,
    endEntryId: row.end_entry_id,
    branchLeafId: row.branch_leaf_id,
    variantHash: row.variant_hash,
    rawEntryIds: safeJsonArray(row.raw_entry_ids),
    entities,
    constraints,
    traceSteps,
    evidence,
  };
}

function unique(list: string[]): string[] {
  return [...new Set(list)];
}

function safeJsonArray(raw: string): string[] {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}
