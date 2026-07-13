import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveProjectIdentity } from "../src/project.ts";
import { HistoryIndex, clearIndexCache } from "../src/index/store.ts";
import {
  acquireWriterLease,
  writeLeaseForTest,
  leasePathForDb,
  DEFAULT_LEASE_TTL_MS,
} from "../src/index/lease.ts";
import { encodeSessionDirName } from "../src/session/ingest.ts";
import { linearDeliverySession, resetIds, resetTs } from "./helpers/session-factory.ts";

const PROJECT_CWD = "/Users/box/dev-code/pi-agent-history-recall";

describe("writer lease", () => {
  let agentDir: string;

  beforeEach(() => {
    resetIds();
    resetTs();
    clearIndexCache();
    agentDir = mkdtempSync(join(tmpdir(), "hist-lease-"));
  });

  afterEach(() => {
    clearIndexCache();
    rmSync(agentDir, { recursive: true, force: true });
  });

  test("exclusive acquire then second acquire is busy", () => {
    const project = resolveProjectIdentity(PROJECT_CWD);
    // Ensure db path parent exists
    const index = new HistoryIndex(project, agentDir);
    const dbPath = index.dbPath;
    index.close();

    const a = acquireWriterLease(dbPath, { token: "owner-a" });
    expect(a.ok).toBe(true);
    if (!a.ok) return;

    const b = acquireWriterLease(dbPath, { token: "owner-b" });
    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.reason).toBe("busy");

    a.handle.release();
    const c = acquireWriterLease(dbPath, { token: "owner-c" });
    expect(c.ok).toBe(true);
    if (c.ok) c.handle.release();
  });

  test("stale lease (dead pid) can be broken", () => {
    const project = resolveProjectIdentity(PROJECT_CWD);
    const index = new HistoryIndex(project, agentDir);
    const lockPath = leasePathForDb(index.dbPath);
    index.close();

    // pid 1 is usually alive on unix; use a high unlikely pid
    writeLeaseForTest(lockPath, {
      pid: 999999,
      startedAt: Date.now() - DEFAULT_LEASE_TTL_MS - 5_000,
      token: "stale-token",
    });

    const got = acquireWriterLease(index.dbPath, { token: "fresh" });
    expect(got.ok).toBe(true);
    if (got.ok) got.handle.release();
  });

  test("reconcile skips mutation when lease busy", () => {
    const sessionDir = join(agentDir, "sessions", encodeSessionDirName(PROJECT_CWD));
    mkdirSync(sessionDir, { recursive: true });
    linearDeliverySession(PROJECT_CWD, sessionDir);

    const project = resolveProjectIdentity(PROJECT_CWD);
    const index = new HistoryIndex(project, agentDir);

    // Hold lease externally
    const held = acquireWriterLease(index.dbPath, { token: "external" });
    expect(held.ok).toBe(true);

    const recon = index.reconcile({ agentDir });
    expect(recon.changed).toBe(false);
    expect(recon.diagnostics.skippedLeaseBusy).toBe(1);
    // No chunks written while busy
    const chunks = (
      index.prepare("SELECT COUNT(*) AS c FROM chunks").get() as { c: number }
    ).c;
    expect(chunks).toBe(0);

    if (held.ok) held.handle.release();

    // After release, reconcile works
    const recon2 = index.reconcile({ agentDir });
    expect(recon2.diagnostics.indexedChunks).toBeGreaterThan(0);
    index.close();
  });
});
