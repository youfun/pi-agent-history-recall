/**
 * Acceptance fixture matrix (DESIGN).
 * Each case is self-contained under a temp agentDir — no external project reads.
 *
 * Categories covered:
 *  1. Linear multi-turn chunking + exploration trace
 *  2. CJK query recall
 *  3. English keyword recall
 *  4. Sibling branch isolation (no merge)
 *  5. Variant fail-closed (no partial publish)
 *  6. Project isolation (foreign header.cwd)
 *  7. Privacy redaction
 *  8. Entity-only path recall (path only in tool args)
 *  9. Open/current-session exclusion knobs
 * 10. Incremental fingerprint skip (unchanged session not dirty)
 * 11. Writer lease busy skip
 * 12. Hard isolation project_id mismatch
 * 13. Three-axis ranking present
 * 14. read_project_history detail + no absolute session path leak in tool shape
 * 15. Symlink cwd → same project_id
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { canonicalizeCwd, projectIdFromCanonical, resolveProjectIdentity } from "../src/project.ts";
import { HistoryIndex, clearIndexCache } from "../src/index/store.ts";
import { encodeSessionDirName } from "../src/session/ingest.ts";
import { searchProjectHistory, readChunkDetail } from "../src/retrieve/search.ts";
import { buildChunksForSession } from "../src/chunk/builder.ts";
import { parseSessionFile } from "../src/session/ingest.ts";
import { acquireWriterLease } from "../src/index/lease.ts";
import { openDatabase } from "../src/index/db.ts";
import { indexDbPath } from "../src/project.ts";
import { MAX_VARIANTS_PER_USER } from "../src/types.ts";
import {
  branchedSession,
  entityOnlyPathSession,
  foreignSession,
  linearAuthSession,
  linearDeliverySession,
  manyVariantsSession,
  resetIds,
  resetTs,
  secretsSession,
} from "./helpers/session-factory.ts";

const PROJECT_CWD = "/Users/box/dev-code/pi-agent-history-recall";

describe("acceptance matrix", () => {
  let agentDir: string;
  let sessionDir: string;
  let index: HistoryIndex;

  beforeEach(() => {
    resetIds();
    resetTs();
    clearIndexCache();
    agentDir = mkdtempSync(join(tmpdir(), "hist-accept-"));
    sessionDir = join(agentDir, "sessions", encodeSessionDirName(PROJECT_CWD));
    mkdirSync(sessionDir, { recursive: true });
    const project = resolveProjectIdentity(PROJECT_CWD);
    index = new HistoryIndex(project, agentDir);
  });

  afterEach(() => {
    try {
      index.close();
    } catch {
      // ignore
    }
    clearIndexCache();
    rmSync(agentDir, { recursive: true, force: true });
  });

  test("1. linear multi-turn produces exploration trace with tools", () => {
    linearDeliverySession(PROJECT_CWD, sessionDir);
    index.reconcile({ agentDir });
    const hits = searchProjectHistory(index, {
      query: "货期",
      project: index.project,
      minRelevance: 0,
      minConfidence: 0,
    });
    expect(hits.length).toBeGreaterThan(0);
    const detail = readChunkDetail(index, hits[0]!.chunkId);
    expect(detail).toBeTruthy();
    const types = (detail!.traceSteps as Array<{ step_type: string }>).map((t) => t.step_type);
    expect(types.some((t) => ["grep", "read", "edit", "bash", "verification"].includes(t))).toBe(
      true,
    );
  });

  test("2. CJK query recall", () => {
    linearDeliverySession(PROJECT_CWD, sessionDir);
    index.reconcile({ agentDir });
    const hits = searchProjectHistory(index, {
      query: "修改货期规则",
      project: index.project,
      minRelevance: 0,
      minConfidence: 0,
    });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.userText).toContain("货期");
  });

  test("3. English keyword recall", () => {
    linearAuthSession(PROJECT_CWD, sessionDir);
    index.reconcile({ agentDir });
    const hits = searchProjectHistory(index, {
      query: "JWT token expiration middleware",
      project: index.project,
      minRelevance: 0,
      minConfidence: 0,
    });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.userText.toLowerCase()).toContain("jwt");
  });

  test("4. sibling branch isolation — no merge", () => {
    const built = branchedSession(PROJECT_CWD, sessionDir);
    const snap = parseSessionFile(built.path, PROJECT_CWD)!;
    const result = buildChunksForSession(
      snap,
      index.project.projectId,
      index.project.canonicalCwd,
    );
    expect(result.failClosed).toBe(false);
    expect(result.chunks.length).toBe(2);
    const texts = result.chunks.map((c) => c.assistantText);
    expect(texts.some((t) => t.includes("Variant A"))).toBe(true);
    expect(texts.some((t) => t.includes("Variant B"))).toBe(true);
    expect(texts.every((t) => !(t.includes("Variant A") && t.includes("Variant B")))).toBe(true);
  });

  test("5. variant fail-closed — no partial publish", () => {
    manyVariantsSession(PROJECT_CWD, sessionDir, MAX_VARIANTS_PER_USER + 2);
    const recon = index.reconcile({ agentDir });
    expect(recon.diagnostics.skippedBranchLimit).toBeGreaterThanOrEqual(1);
    const chunks = (
      index.prepare("SELECT COUNT(*) AS c FROM chunks").get() as { c: number }
    ).c;
    expect(chunks).toBe(0);
  });

  test("6. project isolation — foreign header.cwd skipped", () => {
    linearDeliverySession(PROJECT_CWD, sessionDir);
    foreignSession("/tmp/other-project", sessionDir);
    index.reconcile({ agentDir });
    const hits = searchProjectHistory(index, {
      query: "secret other project",
      project: index.project,
      minRelevance: 0,
      minConfidence: 0,
    });
    for (const h of hits) expect(h.userText).not.toContain("secret other project");
  });

  test("7. privacy redaction strips secrets from indexed text", () => {
    secretsSession(PROJECT_CWD, sessionDir);
    index.reconcile({ agentDir });
    const rows = index.prepare("SELECT user_text, assistant_text FROM chunks").all() as Array<{
      user_text: string;
      assistant_text: string;
    }>;
    expect(rows.length).toBeGreaterThan(0);
    const blob = rows.map((r) => r.user_text + r.assistant_text).join("\n");
    expect(blob).not.toContain("sk-abcdefghijklmnopqrstuvwxyz123456");
    expect(blob).not.toContain("supersecretvalue99");
    expect(blob.toLowerCase()).toContain("redacted");
  });

  test("8. entity-only path recall (path only in tool args)", () => {
    entityOnlyPathSession(PROJECT_CWD, sessionDir);
    index.reconcile({ agentDir });
    const hits = searchProjectHistory(index, {
      query: "calendar_rules.ts",
      project: index.project,
      minRelevance: 0,
      minConfidence: 0,
    });
    // Path appears as entity / FTS via tool extraction — should surface
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.files.join(" ").toLowerCase()).toContain("calendar");
  });

  test("9. excludeSessionId filters current session", () => {
    const built = linearDeliverySession(PROJECT_CWD, sessionDir);
    index.reconcile({ agentDir });
    const all = searchProjectHistory(index, {
      query: "货期",
      project: index.project,
      minRelevance: 0,
      minConfidence: 0,
    });
    expect(all.length).toBeGreaterThan(0);
    const filtered = searchProjectHistory(index, {
      query: "货期",
      project: index.project,
      minRelevance: 0,
      minConfidence: 0,
      excludeSessionId: built.sessionId,
    });
    expect(filtered.every((h) => h.sessionId !== built.sessionId)).toBe(true);
  });

  test("10. incremental fingerprint — second reconcile not dirty", () => {
    linearDeliverySession(PROJECT_CWD, sessionDir);
    const r1 = index.reconcile({ agentDir });
    expect(r1.diagnostics.dirtySessions).toBeGreaterThanOrEqual(1);
    const r2 = index.reconcile({ agentDir });
    expect(r2.diagnostics.dirtySessions).toBe(0);
    expect(r2.changed).toBe(false);
  });

  test("11. writer lease busy — reconcile skips writes", () => {
    linearDeliverySession(PROJECT_CWD, sessionDir);
    const held = acquireWriterLease(index.dbPath, { token: "busy-holder" });
    expect(held.ok).toBe(true);
    const recon = index.reconcile({ agentDir });
    expect(recon.diagnostics.skippedLeaseBusy).toBe(1);
    expect(recon.changed).toBe(false);
    if (held.ok) held.handle.release();
  });

  test("12. hard isolation — wrong project_id refuses open", () => {
    // Create a clean index first so schema exists, then poison meta via second open path.
    index.reconcile({ agentDir });
    index.close();
    clearIndexCache();

    const project = resolveProjectIdentity(PROJECT_CWD);
    const dbPath = indexDbPath(project.projectId, project.canonicalCwd, agentDir);
    const db = openDatabase(dbPath);
    db.prepare(
      `INSERT INTO index_meta(key, value) VALUES('project_id', 'forged')
       ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
    ).run();
    const poisoned = db.prepare(`SELECT value FROM index_meta WHERE key = 'project_id'`).get() as {
      value: string;
    };
    expect(poisoned.value).toBe("forged");
    db.close();

    let threw = false;
    let message = "";
    try {
      new HistoryIndex(project, agentDir);
    } catch (e) {
      threw = true;
      message = String(e);
    }
    expect(threw).toBe(true);
    expect(message).toContain("isolation hard error");

    // Recreate a clean index handle for afterEach.
    const freshDir = mkdtempSync(join(tmpdir(), "hist-accept-fresh-"));
    index = new HistoryIndex(project, freshDir);
    // afterEach cleans agentDir; also clean old dir
    rmSync(agentDir, { recursive: true, force: true });
    agentDir = freshDir;
  });

  test("13. ranking exposes Relevance / Confidence / Freshness", () => {
    linearDeliverySession(PROJECT_CWD, sessionDir);
    index.reconcile({ agentDir });
    const hits = searchProjectHistory(index, {
      query: "delivery_rule 货期",
      project: index.project,
      minRelevance: 0,
      minConfidence: 0,
    });
    expect(hits.length).toBeGreaterThan(0);
    const h = hits[0]!;
    expect(typeof h.relevance).toBe("number");
    expect(typeof h.confidence).toBe("number");
    expect(["High", "Medium", "Low"]).toContain(h.freshness);
    expect(h.relevance).toBeGreaterThanOrEqual(0);
    expect(h.confidence).toBeGreaterThanOrEqual(0);
  });

  test("14. read detail has entry ids; tool-facing path not required as absolute", () => {
    linearDeliverySession(PROJECT_CWD, sessionDir);
    index.reconcile({ agentDir });
    const hits = searchProjectHistory(index, {
      query: "货期",
      project: index.project,
      minRelevance: 0,
      minConfidence: 0,
    });
    const detail = readChunkDetail(index, hits[0]!.chunkId)!;
    expect(detail.startEntryId).toBeTruthy();
    expect(detail.rawEntryIds.length).toBeGreaterThan(0);
    // Model-facing search results must not embed home session absolute paths
    const packed = JSON.stringify(hits[0]);
    expect(packed.includes("/.pi/agent/sessions/")).toBe(false);
  });

  test("15. symlink cwd canonicalizes to same project_id", () => {
    const real = mkdtempSync(join(tmpdir(), "hist-sym-real-"));
    const parent = mkdtempSync(join(tmpdir(), "hist-sym-parent-"));
    const link = join(parent, "link");
    try {
      symlinkSync(real, link);
    } catch {
      // skip if symlink not permitted
      rmSync(real, { recursive: true, force: true });
      rmSync(parent, { recursive: true, force: true });
      return;
    }
    expect(projectIdFromCanonical(canonicalizeCwd(link))).toBe(
      projectIdFromCanonical(canonicalizeCwd(real)),
    );
    rmSync(link, { force: true });
    rmSync(real, { recursive: true, force: true });
    rmSync(parent, { recursive: true, force: true });
  });
});
