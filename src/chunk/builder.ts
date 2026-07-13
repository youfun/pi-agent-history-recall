import { createHash } from "node:crypto";
import { cjkGramsFromText } from "../extract/cjk.ts";
import { extractFromChunkPath } from "../extract/exploration.ts";
import { stripLatinForFts } from "../extract/text.ts";
import { clip, redactText } from "../privacy.ts";
import type {
  ChunkBuildResult,
  ConversationChunk,
  EvidenceRecord,
  MessagePayload,
  RawSessionEntry,
  SessionSnapshot,
} from "../types.ts";
import {
  EXTENSION_MARKER,
  MAX_ASSISTANT_TEXT,
  MAX_CHUNKS_PER_SESSION,
  MAX_USER_TEXT,
  MAX_VARIANTS_PER_USER,
} from "../types.ts";

/**
 * Build Conversation Chunks for one session.
 *
 * Fail-closed (DESIGN M5 / branch safety):
 * - Sibling variants are NEVER merged.
 * - If any user entry would exceed MAX_VARIANTS_PER_USER, or total chunks would
 *   exceed MAX_CHUNKS_PER_SESSION, return failClosed=true with empty chunks.
 * - Callers must retain the prior indexed revision when failClosed is true.
 * - No silent slice()/truncate publication of a partial branch set.
 */
export function buildChunksForSession(
  snapshot: SessionSnapshot,
  projectId: string,
  canonicalCwd: string,
  opts?: { activeLeafId?: string | null },
): ChunkBuildResult {
  const emptyDiagnostics = {
    leafPathCount: 0,
    chunkCount: 0,
    variantLimitHit: false,
    chunkLimitHit: false,
    limitedUserEntryIds: [] as string[],
  };

  const byId = new Map(snapshot.entries.map((e) => [e.id, e]));
  const leafPaths = buildOrderedLeafPaths(snapshot.entries);
  if (leafPaths.length === 0) {
    return { chunks: [], failClosed: false, diagnostics: emptyDiagnostics };
  }

  // Prefer active leaf, then longer/more recent paths — but do NOT silently drop
  // excess paths: if the full expansion would exceed limits, fail closed.
  const ranked = rankLeafPaths(leafPaths, opts?.activeLeafId ?? null);

  const chunks: ConversationChunk[] = [];
  const seenChunkKeys = new Set<string>();
  const perUser = new Map<string, number>();
  const limitedUserEntryIds = new Set<string>();
  let variantLimitHit = false;
  let chunkLimitHit = false;

  // First pass: count what full expansion would produce (fail-closed decision).
  for (const { pathIds } of ranked) {
    const pathEntries = pathIds
      .map((id) => byId.get(id))
      .filter((e): e is RawSessionEntry => Boolean(e));
    const userBoundaries = findUserBoundaries(pathEntries);
    for (let i = 0; i < userBoundaries.length; i++) {
      const startIdx = userBoundaries[i]!;
      const endIdx =
        i + 1 < userBoundaries.length ? userBoundaries[i + 1]! - 1 : pathEntries.length - 1;
      const slice = pathEntries.slice(startIdx, endIdx + 1);
      if (slice.length === 0) continue;
      const userEntry = slice[0]!;
      const userMsg = userEntry.message as MessagePayload | undefined;
      if (!userMsg || userMsg.role !== "user") continue;

      const rawEntryIds = slice.map((e) => e.id);
      const variantHash = hashIds(rawEntryIds);
      const chunkKey = `${snapshot.sessionId}|${userEntry.id}|${variantHash}`;
      if (seenChunkKeys.has(chunkKey)) continue;
      seenChunkKeys.add(chunkKey);

      const count = (perUser.get(userEntry.id) ?? 0) + 1;
      perUser.set(userEntry.id, count);
      if (count > MAX_VARIANTS_PER_USER) {
        variantLimitHit = true;
        limitedUserEntryIds.add(userEntry.id);
      }
    }
  }

  const totalDistinct = seenChunkKeys.size;
  if (totalDistinct > MAX_CHUNKS_PER_SESSION) {
    chunkLimitHit = true;
  }

  if (variantLimitHit || chunkLimitHit) {
    return {
      chunks: [],
      failClosed: true,
      diagnostics: {
        leafPathCount: leafPaths.length,
        chunkCount: totalDistinct,
        variantLimitHit,
        chunkLimitHit,
        limitedUserEntryIds: [...limitedUserEntryIds],
      },
    };
  }

  // Second pass: actually build (limits known safe).
  seenChunkKeys.clear();
  perUser.clear();

  for (const { leafId, pathIds } of ranked) {
    const pathEntries = pathIds
      .map((id) => byId.get(id))
      .filter((e): e is RawSessionEntry => Boolean(e));

    const userBoundaries = findUserBoundaries(pathEntries);
    if (userBoundaries.length === 0) continue;

    for (let i = 0; i < userBoundaries.length; i++) {
      const startIdx = userBoundaries[i]!;
      const endIdx =
        i + 1 < userBoundaries.length ? userBoundaries[i + 1]! - 1 : pathEntries.length - 1;
      const slice = pathEntries.slice(startIdx, endIdx + 1);
      if (slice.length === 0) continue;

      const userEntry = slice[0]!;
      const userMsg = userEntry.message as MessagePayload | undefined;
      if (!userMsg || userMsg.role !== "user") continue;

      const rawEntryIds = slice.map((e) => e.id);
      const variantHash = hashIds(rawEntryIds);
      const chunkKey = `${snapshot.sessionId}|${userEntry.id}|${variantHash}`;
      if (seenChunkKeys.has(chunkKey)) continue;
      seenChunkKeys.add(chunkKey);

      const count = perUser.get(userEntry.id) ?? 0;
      perUser.set(userEntry.id, count + 1);

      const extracted = extractFromChunkPath(slice, canonicalCwd);
      const evidence = collectEvidence(slice, null);

      const startTs = Date.parse(userEntry.timestamp) || 0;
      const endEntry = slice[slice.length - 1]!;
      const endTs = Date.parse(endEntry.timestamp) || startTs;

      const status =
        snapshot.isActive && i === userBoundaries.length - 1 && !isClosedTurn(slice)
          ? "open"
          : "complete";

      const userText = clip(redactText(extracted.userText || userVisible(userMsg)), MAX_USER_TEXT);
      const assistantText = clip(redactText(extracted.assistantText), MAX_ASSISTANT_TEXT);

      const id = chunkId(projectId, snapshot.sessionId, userEntry.id, variantHash);
      for (const ev of evidence) {
        // Session-scoped evidence stays attached for read/debug but is not FTS-indexed.
        if (ev.evidenceScope === "chunk") ev.chunkId = id;
      }

      // Only chunk-scoped evidence contributes to FTS (DESIGN: branch_summary is session-scoped).
      const ftsEvidenceText = evidence
        .filter((e) => e.evidenceScope === "chunk")
        .map((e) => e.text)
        .join("\n");

      const latin = {
        user: stripLatinForFts(userText),
        assistant: stripLatinForFts(assistantText),
        evidence: stripLatinForFts(ftsEvidenceText),
      };
      const cjkGrams = cjkGramsFromText(userText, assistantText, ftsEvidenceText);

      chunks.push({
        id,
        projectId,
        sessionId: snapshot.sessionId,
        userEntryId: userEntry.id,
        branchLeafId: leafId,
        variantHash,
        startEntryId: userEntry.id,
        endEntryId: endEntry.id,
        startTs,
        endTs,
        status,
        userText,
        assistantText,
        toolCallCount: extracted.toolCallCount,
        pairedResultCount: extracted.pairedResultCount,
        rawEntryIds,
        entities: extracted.entities,
        constraints: extracted.constraints,
        traceSteps: extracted.traceSteps,
        evidence,
        latinText: latin,
        cjkGrams,
      });
    }
  }

  return {
    chunks,
    failClosed: false,
    diagnostics: {
      leafPathCount: leafPaths.length,
      chunkCount: chunks.length,
      variantLimitHit: false,
      chunkLimitHit: false,
      limitedUserEntryIds: [],
    },
  };
}

function buildOrderedLeafPaths(
  entries: RawSessionEntry[],
): Array<{ leafId: string; pathIds: string[] }> {
  const byId = new Map(entries.map((e) => [e.id, e]));

  const isParent = new Set<string>();
  for (const e of entries) {
    if (e.parentId) isParent.add(e.parentId);
  }
  const leaves = entries.filter((e) => !isParent.has(e.id));
  leaves.sort((a, b) => (Date.parse(b.timestamp) || 0) - (Date.parse(a.timestamp) || 0));

  const out: Array<{ leafId: string; pathIds: string[] }> = [];
  for (const leaf of leaves) {
    const chain: string[] = [];
    let cur: RawSessionEntry | undefined = leaf;
    const guard = new Set<string>();
    while (cur && !guard.has(cur.id)) {
      guard.add(cur.id);
      chain.push(cur.id);
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
    chain.reverse();
    out.push({ leafId: leaf.id, pathIds: chain });
  }
  return out;
}

function rankLeafPaths(
  paths: Array<{ leafId: string; pathIds: string[] }>,
  activeLeafId: string | null,
): Array<{ leafId: string; pathIds: string[] }> {
  return [...paths].sort((a, b) => {
    if (activeLeafId) {
      if (a.leafId === activeLeafId) return -1;
      if (b.leafId === activeLeafId) return 1;
      if (a.pathIds.includes(activeLeafId)) return -1;
      if (b.pathIds.includes(activeLeafId)) return 1;
    }
    return b.pathIds.length - a.pathIds.length;
  });
}

function findUserBoundaries(pathEntries: RawSessionEntry[]): number[] {
  const idxs: number[] = [];
  for (let i = 0; i < pathEntries.length; i++) {
    const e = pathEntries[i]!;
    if (e.type !== "message") continue;
    const msg = e.message as MessagePayload | undefined;
    if (msg?.role === "user") idxs.push(i);
  }
  return idxs;
}

function isClosedTurn(slice: RawSessionEntry[]): boolean {
  for (let i = slice.length - 1; i >= 0; i--) {
    const e = slice[i]!;
    if (e.type !== "message") continue;
    const msg = e.message as MessagePayload | undefined;
    if (!msg) continue;
    if (msg.role === "assistant") {
      const content = msg.content;
      if (Array.isArray(content)) {
        const hasTool = content.some(
          (p) => p && typeof p === "object" && (p as { type?: string }).type === "toolCall",
        );
        if (hasTool) {
          const after = slice.slice(i + 1);
          return after.some((x) => {
            if (x.type !== "message") return false;
            const m = x.message as MessagePayload | undefined;
            return m?.role === "toolResult";
          });
        }
      }
      return true;
    }
    if (msg.role === "toolResult") return true;
    if (msg.role === "user") return false;
  }
  return false;
}

function collectEvidence(slice: RawSessionEntry[], chunkId: string | null): EvidenceRecord[] {
  const out: EvidenceRecord[] = [];
  for (const e of slice) {
    const anyE = e as unknown as Record<string, unknown>;
    if (e.type === "compaction") {
      const summary =
        typeof anyE.summary === "string" ? anyE.summary : JSON.stringify(e).slice(0, 2000);
      out.push({
        sourceEntryId: e.id,
        evidenceType: "compaction",
        evidenceScope: "chunk",
        text: redactText(summary, MAX_ASSISTANT_TEXT),
        confidence: 0.5,
        chunkId,
      });
    } else if (e.type === "branch_summary") {
      // Session-scoped auxiliary evidence only — must NOT enter FTS or ranking (DESIGN).
      const summary = typeof anyE.summary === "string" ? anyE.summary : "";
      if (summary) {
        out.push({
          sourceEntryId: e.id,
          evidenceType: "branch_summary",
          evidenceScope: "session",
          text: redactText(summary, MAX_ASSISTANT_TEXT),
          confidence: 0.55,
          chunkId: null,
        });
      }
    } else if (e.type === "custom_message") {
      // Exclude our own extension-marked messages to prevent self-hint FTS loops (DESIGN).
      const customType = typeof anyE.customType === "string" ? anyE.customType : "";
      if (
        customType === EXTENSION_MARKER ||
        customType.startsWith("history-recall") ||
        customType.startsWith(`${EXTENSION_MARKER}`)
      ) {
        continue;
      }
      const content = typeof anyE.content === "string" ? anyE.content : "";
      if (content) {
        out.push({
          sourceEntryId: e.id,
          evidenceType: "custom_message",
          evidenceScope: "chunk",
          text: redactText(content, MAX_ASSISTANT_TEXT),
          confidence: 0.45,
          chunkId,
        });
      }
    }
  }
  return out;
}

function userVisible(msg: MessagePayload): string {
  const c = msg.content;
  if (typeof c === "string") return c;
  if (!Array.isArray(c)) return "";
  return c
    .filter((p) => p && typeof p === "object" && (p as { type?: string }).type === "text")
    .map((p) => String((p as { text?: string }).text ?? ""))
    .join("\n");
}

function hashIds(ids: string[]): string {
  return createHash("sha256").update(ids.join("|"), "utf8").digest("hex").slice(0, 16);
}

function chunkId(
  projectId: string,
  sessionId: string,
  userEntryId: string,
  variantHash: string,
): string {
  return createHash("sha256")
    .update(`${projectId}|${sessionId}|${userEntryId}|${variantHash}`, "utf8")
    .digest("hex")
    .slice(0, 32);
}
