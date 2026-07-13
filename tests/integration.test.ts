import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { encodeSessionDirName } from "../src/session/ingest.ts";
import { resolveProjectIdentity } from "../src/project.ts";
import { HistoryIndex, clearIndexCache } from "../src/index/store.ts";
import { searchProjectHistory, readChunkDetail } from "../src/retrieve/search.ts";
import {
  foreignSession,
  linearAuthSession,
  linearDeliverySession,
  resetIds,
  resetTs,
} from "./helpers/session-factory.ts";

const PROJECT_CWD = "/Users/box/dev-code/pi-agent-history-recall";

describe("integration: index + search", () => {
  let agentDir: string;
  let index: HistoryIndex;

  beforeAll(() => {
    resetIds();
    resetTs();
    agentDir = mkdtempSync(join(tmpdir(), "hist-recall-"));
    const sessionDir = join(agentDir, "sessions", encodeSessionDirName(PROJECT_CWD));
    mkdirSync(sessionDir, { recursive: true });
    linearDeliverySession(PROJECT_CWD, sessionDir);
    linearAuthSession(PROJECT_CWD, sessionDir);
    foreignSession("/tmp/other-project", sessionDir);

    clearIndexCache();
    const project = resolveProjectIdentity(PROJECT_CWD);
    index = new HistoryIndex(project, agentDir);
    const recon = index.reconcile({ agentDir });
    expect(recon.diagnostics.indexedSessions).toBeGreaterThanOrEqual(1);
  });

  afterAll(() => {
    try {
      index.close();
    } catch {
      // ignore
    }
    clearIndexCache();
    rmSync(agentDir, { recursive: true, force: true });
  });

  test("indexes Chinese delivery-rule chunk", () => {
    const count = (
      index.prepare("SELECT COUNT(*) AS c FROM chunks").get() as { c: number }
    ).c;
    expect(count).toBeGreaterThanOrEqual(1);
  });

  test("rejects foreign project session content", () => {
    const hits = searchProjectHistory(index, {
      query: "secret other project",
      project: index.project,
      minRelevance: 0,
      minConfidence: 0,
    });
    // Foreign session must not be indexed; query should not surface its user text.
    for (const h of hits) {
      expect(h.userText).not.toContain("secret other project");
    }
  });

  test("CJK query finds 货期规则", () => {
    const hits = searchProjectHistory(index, {
      query: "货期规则",
      project: index.project,
      minRelevance: 0,
      minConfidence: 0,
      maxResults: 5,
    });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.userText).toContain("货期");
    expect(hits[0]!.relevance).toBeGreaterThan(0);
    expect(hits[0]!.confidence).toBeGreaterThan(0);
    expect(["High", "Medium", "Low"]).toContain(hits[0]!.freshness);
  });

  test("english query finds JWT auth", () => {
    const hits = searchProjectHistory(index, {
      query: "JWT token expiration auth middleware",
      project: index.project,
      minRelevance: 0,
      minConfidence: 0,
    });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.userText.toLowerCase()).toContain("jwt");
  });

  test("read_project_history returns exploration trace", () => {
    const hits = searchProjectHistory(index, {
      query: "货期",
      project: index.project,
      minRelevance: 0,
      minConfidence: 0,
    });
    expect(hits.length).toBeGreaterThan(0);
    const detail = readChunkDetail(index, hits[0]!.chunkId);
    expect(detail).toBeTruthy();
    expect(detail!.traceSteps.length).toBeGreaterThan(0);
    const types = (detail!.traceSteps as Array<{ step_type: string }>).map((t) => t.step_type);
    expect(types.some((t) => t === "grep" || t === "read" || t === "edit")).toBe(true);
  });

  test("entities include file paths", () => {
    const hits = searchProjectHistory(index, {
      query: "delivery_rule",
      project: index.project,
      minRelevance: 0,
      minConfidence: 0,
    });
    expect(hits.length).toBeGreaterThan(0);
    // files may be relative
    expect(hits[0]!.files.join(" ")).toMatch(/delivery/i);
  });
});
