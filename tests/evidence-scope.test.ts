import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildChunksForSession } from "../src/chunk/builder.ts";
import { resolveProjectIdentity } from "../src/project.ts";
import { HistoryIndex, clearIndexCache } from "../src/index/store.ts";
import { encodeSessionDirName, parseSessionFile } from "../src/session/ingest.ts";
import { searchProjectHistory } from "../src/retrieve/search.ts";
import { EXTENSION_MARKER } from "../src/types.ts";
import {
  resetIds,
  resetTs,
  userMsg,
  assistantText,
  writeSession,
} from "./helpers/session-factory.ts";

const PROJECT_CWD = "/Users/box/dev-code/pi-agent-history-recall";

describe("evidence scope regressions", () => {
  let agentDir: string;

  beforeEach(() => {
    resetIds();
    resetTs();
    clearIndexCache();
    agentDir = mkdtempSync(join(tmpdir(), "hist-evscope-"));
  });

  afterEach(() => {
    clearIndexCache();
    rmSync(agentDir, { recursive: true, force: true });
  });

  test("extension-marked custom_message is excluded from evidence (no self-hint loop)", () => {
    const sessionDir = join(agentDir, "sessions", encodeSessionDirName(PROJECT_CWD));
    mkdirSync(sessionDir, { recursive: true });

    const u = userMsg(null, "normal user question about widgets");
    const hint = {
      type: "custom_message",
      id: "hint-1",
      parentId: u.id,
      timestamp: "2026-07-01T00:00:02.000Z",
      customType: EXTENSION_MARKER,
      content:
        "[History hint] Prior work may relate (R:90 C:80 F:High). Use search_project_history. UNIQUE_HINT_TOKEN_XYZ",
    };
    const a = assistantText(hint.id as string, "Working on widgets.");
    const built = writeSession(sessionDir, PROJECT_CWD, [u, hint, a]);

    const snap = parseSessionFile(built.path, PROJECT_CWD)!;
    const project = resolveProjectIdentity(PROJECT_CWD);
    const result = buildChunksForSession(snap, project.projectId, project.canonicalCwd);
    expect(result.failClosed).toBe(false);
    expect(result.chunks.length).toBeGreaterThan(0);

    for (const c of result.chunks) {
      for (const ev of c.evidence) {
        expect(ev.evidenceType).not.toBe("custom_message");
        expect(ev.text).not.toContain("UNIQUE_HINT_TOKEN_XYZ");
      }
      expect(c.latinText.evidence).not.toContain("unique_hint_token_xyz");
      expect(c.userText).not.toContain("UNIQUE_HINT_TOKEN_XYZ");
      expect(c.assistantText).not.toContain("UNIQUE_HINT_TOKEN_XYZ");
    }

    // Also ensure search cannot find the exclusive hint token after indexing.
    const index = new HistoryIndex(project, agentDir);
    index.reconcile({ agentDir });
    const hits = searchProjectHistory(index, {
      query: "UNIQUE_HINT_TOKEN_XYZ",
      project: index.project,
      minRelevance: 0,
      minConfidence: 0,
    });
    for (const h of hits) {
      expect(h.userText).not.toContain("UNIQUE_HINT_TOKEN_XYZ");
      expect(h.assistantSnippet).not.toContain("UNIQUE_HINT_TOKEN_XYZ");
    }
    index.close();
  });

  test("branch_summary is session-scoped and excluded from FTS", () => {
    const sessionDir = join(agentDir, "sessions", encodeSessionDirName(PROJECT_CWD));
    mkdirSync(sessionDir, { recursive: true });

    const u = userMsg(null, "implement feature alpha");
    const summary = {
      type: "branch_summary",
      id: "bs-1",
      parentId: u.id,
      timestamp: "2026-07-01T00:00:02.000Z",
      summary:
        "Abandoned branch discussed UNIQUE_BRANCH_SUMMARY_TOKEN about inventory module only.",
    };
    const a = assistantText(summary.id as string, "Continuing on alpha feature path.");
    const built = writeSession(sessionDir, PROJECT_CWD, [u, summary, a]);

    const snap = parseSessionFile(built.path, PROJECT_CWD)!;
    const project = resolveProjectIdentity(PROJECT_CWD);
    const result = buildChunksForSession(snap, project.projectId, project.canonicalCwd);
    expect(result.failClosed).toBe(false);

    const allEvidence = result.chunks.flatMap((c) => c.evidence);
    const branchEv = allEvidence.filter((e) => e.evidenceType === "branch_summary");
    expect(branchEv.length).toBeGreaterThan(0);
    for (const ev of branchEv) {
      expect(ev.evidenceScope).toBe("session");
      expect(ev.chunkId).toBeNull();
    }
    // Must not be in FTS evidence channel
    for (const c of result.chunks) {
      expect(c.latinText.evidence).not.toContain("unique_branch_summary_token");
    }

    const index = new HistoryIndex(project, agentDir);
    index.reconcile({ agentDir });

    // Stored as session-scoped evidence
    const rows = index
      .prepare(
        `SELECT evidence_scope, chunk_id, text FROM evidence WHERE evidence_type = 'branch_summary'`,
      )
      .all() as Array<{ evidence_scope: string; chunk_id: string | null; text: string }>;
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.evidence_scope).toBe("session");
      expect(r.chunk_id).toBeNull();
    }

    // Exclusive token should not surface via search
    const hits = searchProjectHistory(index, {
      query: "UNIQUE_BRANCH_SUMMARY_TOKEN",
      project: index.project,
      minRelevance: 0,
      minConfidence: 0,
    });
    for (const h of hits) {
      expect(h.userText).not.toContain("UNIQUE_BRANCH_SUMMARY_TOKEN");
      expect(h.assistantSnippet).not.toContain("UNIQUE_BRANCH_SUMMARY_TOKEN");
    }
    index.close();
  });
});
