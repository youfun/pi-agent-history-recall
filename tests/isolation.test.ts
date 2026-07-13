import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  symlinkSync,
  writeFileSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { canonicalizeCwd, projectIdFromCanonical, resolveProjectIdentity } from "../src/project.ts";
import { HistoryIndex, clearIndexCache } from "../src/index/store.ts";
import { encodeSessionDirName } from "../src/session/ingest.ts";
import { searchProjectHistory } from "../src/retrieve/search.ts";
import {
  foreignSession,
  linearDeliverySession,
  resetIds,
  resetTs,
} from "./helpers/session-factory.ts";
import { openDatabase } from "../src/index/db.ts";
import { indexDbPath } from "../src/project.ts";

const PROJECT_CWD = "/Users/box/dev-code/pi-agent-history-recall";

describe("project isolation hardening", () => {
  let agentDir: string;

  beforeEach(() => {
    resetIds();
    resetTs();
    clearIndexCache();
    agentDir = mkdtempSync(join(tmpdir(), "hist-iso-"));
  });

  afterEach(() => {
    clearIndexCache();
    rmSync(agentDir, { recursive: true, force: true });
  });

  test("foreign header.cwd in same session dir is not indexed", () => {
    const sessionDir = join(agentDir, "sessions", encodeSessionDirName(PROJECT_CWD));
    mkdirSync(sessionDir, { recursive: true });
    linearDeliverySession(PROJECT_CWD, sessionDir);
    foreignSession("/tmp/other-project-xyz", sessionDir);

    const project = resolveProjectIdentity(PROJECT_CWD);
    const index = new HistoryIndex(project, agentDir);
    index.reconcile({ agentDir });

    const hits = searchProjectHistory(index, {
      query: "secret other project",
      project: index.project,
      minRelevance: 0,
      minConfidence: 0,
    });
    for (const h of hits) {
      expect(h.userText).not.toContain("secret other project");
    }
    // Delivery content still present
    const good = searchProjectHistory(index, {
      query: "货期规则",
      project: index.project,
      minRelevance: 0,
      minConfidence: 0,
    });
    expect(good.length).toBeGreaterThan(0);
    index.close();
  });

  test("db project_id mismatch is hard error", () => {
    const project = resolveProjectIdentity(PROJECT_CWD);
    const dbPath = indexDbPath(project.projectId, project.canonicalCwd, agentDir);
    mkdirSync(join(agentDir, "history-recall"), { recursive: true });

    // Plant a DB meta with wrong project_id using raw sqlite
    const db = openDatabase(dbPath);
    db.exec(`
      CREATE TABLE IF NOT EXISTS index_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    db.prepare(
      `INSERT INTO index_meta(key, value) VALUES('schema_version', '1')
       ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
    ).run();
    db.prepare(
      `INSERT INTO index_meta(key, value) VALUES('project_id', 'deadbeef-wrong-project')
       ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
    ).run();
    db.prepare(
      `INSERT INTO index_meta(key, value) VALUES('canonical_cwd', ?)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
    ).run(project.canonicalCwd);
    db.close();

    let threw = false;
    try {
      new HistoryIndex(project, agentDir);
    } catch (err) {
      threw = true;
      expect(String(err)).toContain("isolation hard error");
      expect(String(err)).toContain("project_id mismatch");
    }
    expect(threw).toBe(true);
  });

  test("db canonical_cwd mismatch is hard error", () => {
    const project = resolveProjectIdentity(PROJECT_CWD);
    const dbPath = indexDbPath(project.projectId, project.canonicalCwd, agentDir);
    mkdirSync(join(agentDir, "history-recall"), { recursive: true });
    const db = openDatabase(dbPath);
    db.exec(`CREATE TABLE IF NOT EXISTS index_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
    db.prepare(
      `INSERT INTO index_meta(key, value) VALUES('schema_version', '1')
       ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
    ).run();
    db.prepare(
      `INSERT INTO index_meta(key, value) VALUES('project_id', ?)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
    ).run(project.projectId);
    db.prepare(
      `INSERT INTO index_meta(key, value) VALUES('canonical_cwd', '/tmp/forged-cwd')
       ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
    ).run();
    db.close();

    let threw = false;
    try {
      new HistoryIndex(project, agentDir);
    } catch (err) {
      threw = true;
      expect(String(err)).toContain("canonical_cwd mismatch");
    }
    expect(threw).toBe(true);
  });

  test("symlink cwd canonicalizes to same project_id", () => {
    // Create a temp real dir and symlink to PROJECT_CWD-like structure
    const real = mkdtempSync(join(tmpdir(), "hist-real-"));
    const linkParent = mkdtempSync(join(tmpdir(), "hist-link-parent-"));
    const link = join(linkParent, "proj-link");
    try {
      symlinkSync(real, link);
    } catch {
      // platforms without symlink permission — skip soft
      rmSync(real, { recursive: true, force: true });
      rmSync(linkParent, { recursive: true, force: true });
      return;
    }

    const idReal = projectIdFromCanonical(canonicalizeCwd(real));
    const idLink = projectIdFromCanonical(canonicalizeCwd(link));
    expect(idReal).toBe(idLink);
    expect(canonicalizeCwd(link)).toBe(canonicalizeCwd(real));

    rmSync(link, { force: true });
    rmSync(real, { recursive: true, force: true });
    rmSync(linkParent, { recursive: true, force: true });
  });

  test("session dir encoding collision is not enough — header.cwd still gates", () => {
    // Two different cwds that might encode similarly are still separated by header check.
    // We place a foreign session into our encoded dir; it must be skipped.
    const sessionDir = join(agentDir, "sessions", encodeSessionDirName(PROJECT_CWD));
    mkdirSync(sessionDir, { recursive: true });
    // Manually craft a session that sits in our dir but claims another cwd
    foreignSession("/Users/box/dev-code/totally-different", sessionDir);
    const project = resolveProjectIdentity(PROJECT_CWD);
    const index = new HistoryIndex(project, agentDir);
    const recon = index.reconcile({ agentDir });
    // Foreign only → 0 indexed sessions (or skipped)
    const sessions = (
      index.prepare("SELECT COUNT(*) AS c FROM sessions").get() as { c: number }
    ).c;
    expect(sessions).toBe(0);
    expect(
      recon.diagnostics.skippedForeign + recon.diagnostics.skippedMalformed,
    ).toBeGreaterThan(0);
    index.close();
  });
});
