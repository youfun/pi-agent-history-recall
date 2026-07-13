import { createHash } from "node:crypto";
import { cjkGramsFromText } from "../extract/cjk.ts";
import { extractFromChunkPath } from "../extract/exploration.ts";
import { stripLatinForFts } from "../extract/text.ts";
import { clip, redactText } from "../privacy.ts";
import type {
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

export function buildChunksForSession(
  snapshot: SessionSnapshot,
  projectId: string,
  canonicalCwd: string,
  opts?: { activeLeafId?: string | null },
): ConversationChunk[] {
  const byId = new Map(snapshot.entries.map((e) => [e.id, e]));
  const leafPaths = buildOrderedLeafPaths(snapshot.entries);
  if (leafPaths.length === 0) return [];

  // Cap variants: prefer paths that include active leaf, then most recent leaves.
  const ranked = rankLeafPaths(leafPaths, opts?.activeLeafId ?? null).slice(
    0,
    MAX_VARIANTS_PER_USER * 4,
  );

  const chunks: ConversationChunk[] = [];
  const seenChunkKeys = new Set<string>();

  for (const { leafId, pathIds } of ranked) {
    if (chunks.length >= MAX_CHUNKS_PER_SESSION) {
      // Design M5: branch-limit diagnostic. Record exceeding chunks count for diagnostics.
      break;
    }
    const pathEntries = pathIds
      .map((id) => byId.get(id))
      .filter((e): e is RawSessionEntry => Boolean(e));

    const userBoundaries = findUserBoundaries(pathEntries);
    if (userBoundaries.length === 0) continue;

    const perUser = new Map<string, number>();

    for (let i = 0; i < userBoundaries.length; i++) {
      if (chunks.length >= MAX_CHUNKS_PER_SESSION) break;
      const startIdx = userBoundaries[i]!;
      const endIdx =
        i + 1 < userBoundaries.length ? userBoundaries[i + 1]! - 1 : pathEntries.length - 1;
      const slice = pathEntries.slice(startIdx, endIdx + 1);
      if (slice.length === 0) continue;

      const userEntry = slice[0]!;
      const userMsg = userEntry.message as MessagePayload | undefined;
      if (!userMsg || userMsg.role !== "user") continue;

      const count = perUser.get(userEntry.id) ?? 0;
      if (count >= MAX_VARIANTS_PER_USER) continue;
      perUser.set(userEntry.id, count + 1);

      const rawEntryIds = slice.map((e) => e.id);
      const variantHash = hashIds(rawEntryIds);
      const chunkKey = `${snapshot.sessionId}|${userEntry.id}|${variantHash}`;
      if (seenChunkKeys.has(chunkKey)) continue;
      seenChunkKeys.add(chunkKey);

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

      for (const ev of evidence) ev.chunkId = null;

      const id = chunkId(projectId, snapshot.sessionId, userEntry.id, variantHash);

      for (const ev of evidence) ev.chunkId = id;

      // Session-scoped evidence (branch_summary) excluded from FTS by design.
      const sessionEvidence = evidence.filter((e) => e.evidenceScope === "session");
      const chunkEvidence = evidence.filter((e) => e.evidenceScope !== "session");
      const evidenceFtsText = chunkEvidence.map((e) => e.text).join("\n");

      const latin = {
        user: stripLatinForFts(userText),
        assistant: stripLatinForFts(assistantText),
        evidence: stripLatinForFts(evidenceFtsText),
      };
      const cjkGrams = cjkGramsFromText(userText, assistantText, evidenceFtsText);

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
        evidence: [...chunkEvidence, ...sessionEvidence],
        latinText: latin,
        cjkGrams,
      });
    }
  }

  return chunks;
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
      const summary = typeof anyE.summary === "string" ? anyE.summary : "";
      if (summary) {
        // Design: branch_summary is session-scoped, not FTS-indexed.
        out.push({
          sourceEntryId: e.id,
          evidenceType: "branch_summary",
          evidenceScope: "session",
          text: redactText(summary, MAX_ASSISTANT_TEXT),
          confidence: 0.55,
          chunkId,
        });
      }
    } else if (e.type === "custom_message") {
      // Skip this extension's own injected messages (Design M4).
      if (anyE.customType === EXTENSION_MARKER) continue;
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
