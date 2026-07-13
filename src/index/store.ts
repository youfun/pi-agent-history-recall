import { mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { buildChunksForSession } from "../chunk/builder.ts";
import { indexDbPath, resolveProjectIdentity } from "../project.ts";
import {
  fingerprintSession,
  listSessionFiles,
  parseSessionFile,
  projectSessionDir,
  isActiveSessionPath,
} from "../session/ingest.ts";
import type {
  ConversationChunk,
  IndexDiagnostics,
  ProjectIdentity,
  ReconcileResult,
  SessionSnapshot,
} from "../types.ts";
import { EXTRACTOR_VERSION, REDACTION_VERSION, SCHEMA_VERSION } from "../types.ts";
import { openDatabase, type SqlDatabase } from "./db.ts";
import { META_KEYS, SCHEMA_SQL } from "./schema.ts";

export class HistoryIndex {
  readonly project: ProjectIdentity;
  readonly dbPath: string;
  private db: SqlDatabase;
  private nextLatinRowid: number;
  private nextCjkRowid: number;

  constructor(project: ProjectIdentity, agentDir?: string) {
    this.project = project;
    this.dbPath = indexDbPath(project.projectId, project.canonicalCwd, agentDir);
    mkdirSync(dirname(this.dbPath), { recursive: true });
    this.db = openDatabase(this.dbPath);
    this.db.exec(SCHEMA_SQL);
    this.ensureMeta();
    this.nextLatinRowid = this.loadMaxFtsRowid("chunk_fts_latin_map") + 1;
    this.nextCjkRowid = this.loadMaxFtsRowid("chunk_fts_cjk_map") + 1;
  }

  close(): void {
    this.db.close();
  }

  getMeta(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM index_meta WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO index_meta(key, value) VALUES(?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, value);
  }

  private ensureMeta(): void {
    const ver = this.getMeta(META_KEYS.schemaVersion);
    if (ver !== String(SCHEMA_VERSION)) {
      // Schema version mismatch: full rebuild.
      this.db.exec(`
        DELETE FROM evidence;
        DELETE FROM trace_steps;
        DELETE FROM constraints;
        DELETE FROM entities;
        DELETE FROM chunk_fts_latin_map;
        DELETE FROM chunk_fts_latin;
        DELETE FROM chunk_fts_cjk_map;
        DELETE FROM chunk_fts_cjk;
        DELETE FROM chunks;
        DELETE FROM sessions;
      `);
      // Also clear meta so we can re-validate project identity fresh.
      this.db.exec("DELETE FROM index_meta");
      this.setMeta(META_KEYS.schemaVersion, String(SCHEMA_VERSION));
    }

    // Project identity guard: reject mismatch as hard error (Design H6).
    const existingProject = this.getMeta(META_KEYS.projectId);
    const existingCwd = this.getMeta(META_KEYS.canonicalCwd);
    if (existingProject !== null && existingProject !== this.project.projectId) {
      throw new Error(
        `Project identity mismatch: database was created for project ${existingProject} but current cwd resolves to ${this.project.projectId}. The database cannot be reopened under a different project.`,
      );
    }
    if (existingCwd !== null && existingCwd !== this.project.canonicalCwd) {
      throw new Error(
        `Canonical CWD mismatch: database records ${existingCwd} but current cwd resolves to ${this.project.canonicalCwd}.`,
      );
    }

    this.setMeta(META_KEYS.projectId, this.project.projectId);
    this.setMeta(META_KEYS.canonicalCwd, this.project.canonicalCwd);
    this.setMeta(META_KEYS.extractorVersion, EXTRACTOR_VERSION);
    this.setMeta(META_KEYS.redactionVersion, REDACTION_VERSION);
  }

  private loadMaxFtsRowid(mapTable: string): number {
    const row = this.db.prepare(`SELECT MAX(fts_rowid) AS m FROM ${mapTable}`).get() as
      | { m: number | null }
      | undefined;
    return row?.m ?? 0;
  }

  reconcile(opts?: {
    agentDir?: string;
    activeSessionId?: string;
  }): ReconcileResult {
    const diagnostics: IndexDiagnostics = {
      skippedMissingCwd: 0,
      skippedForeign: 0,
      skippedMalformed: 0,
      skippedBranchLimit: 0,
      dirtySessions: 0,
      indexedSessions: 0,
      indexedChunks: 0,
    };

    const sessionDir = projectSessionDir(this.project.canonicalCwd, opts?.agentDir);
    if (!existsSync(sessionDir)) {
      this.setMeta(META_KEYS.lastRebuild, String(Date.now()));
      this.setMeta(META_KEYS.sessionCount, "0");
      this.setMeta(META_KEYS.chunkCount, "0");
      return { diagnostics, changed: false };
    }

    const files = listSessionFiles(sessionDir);
    const known = this.db
      .prepare("SELECT session_id, fingerprint, source_path FROM sessions")
      .all() as Array<{ session_id: string; fingerprint: string; source_path: string }>;
    const knownByPath = new Map(known.map((k) => [k.source_path, k]));
    const seenPaths = new Set<string>();
    let changed = false;

    for (const file of files) {
      seenPaths.add(file.path);
      const fp = fingerprintSession({
        sourcePath: file.path,
        mtimeNs: file.mtimeNs,
        sizeBytes: file.sizeBytes,
      });
      const prev = knownByPath.get(file.path);
      if (prev && prev.fingerprint === fp) {
        diagnostics.indexedSessions += 1;
        continue;
      }

      diagnostics.dirtySessions += 1;
      const isActive = isActiveSessionPath(file.path, opts?.activeSessionId);
      const snapshot = parseSessionFile(file.path, this.project.canonicalCwd, { isActive });
      if (!snapshot) {
        diagnostics.skippedMalformed += 1;
        diagnostics.skippedForeign += 1;
        continue;
      }
      this.upsertSession(snapshot, opts?.activeSessionId);
      this.validateSession(snapshot.sessionId);
      changed = true;
      diagnostics.indexedSessions += 1;
    }

    for (const k of known) {
      if (!seenPaths.has(k.source_path)) {
        this.deleteSession(k.session_id);
        changed = true;
      }
    }

    const chunkCount = (
      this.db.prepare("SELECT COUNT(*) AS c FROM chunks").get() as { c: number }
    ).c;
    this.setMeta(META_KEYS.lastRebuild, String(Date.now()));
    this.setMeta(META_KEYS.sessionCount, String(diagnostics.indexedSessions));
    this.setMeta(META_KEYS.chunkCount, String(chunkCount));
    diagnostics.indexedChunks = chunkCount;

    return { diagnostics, changed };
  }

  private deleteSession(sessionId: string): void {
    const latinMaps = this.db
      .prepare(
        `SELECT fts_rowid FROM chunk_fts_latin_map WHERE chunk_id IN
         (SELECT id FROM chunks WHERE session_id = ?)`,
      )
      .all(sessionId) as Array<{ fts_rowid: number }>;
    const delLatin = this.db.prepare("DELETE FROM chunk_fts_latin WHERE rowid = ?");
    for (const m of latinMaps) delLatin.run(m.fts_rowid);

    const cjkMaps = this.db
      .prepare(
        `SELECT fts_rowid FROM chunk_fts_cjk_map WHERE chunk_id IN
         (SELECT id FROM chunks WHERE session_id = ?)`,
      )
      .all(sessionId) as Array<{ fts_rowid: number }>;
    const delCjk = this.db.prepare("DELETE FROM chunk_fts_cjk WHERE rowid = ?");
    for (const m of cjkMaps) delCjk.run(m.fts_rowid);

    this.db.prepare("DELETE FROM sessions WHERE session_id = ?").run(sessionId);
  }

  private upsertSession(snapshot: SessionSnapshot, activeSessionId?: string): void {
    const chunks = buildChunksForSession(
      snapshot,
      this.project.projectId,
      this.project.canonicalCwd,
      { activeLeafId: null },
    );

    const isActive = snapshot.sessionId === activeSessionId ? 1 : 0;

    const run = () => {
      this.deleteSession(snapshot.sessionId);

      this.db
        .prepare(
          `INSERT INTO sessions(
            session_id, source_path, header_cwd, format_version,
            mtime_ns, size_bytes, indexed_bytes, fingerprint, source_identity,
            is_active, is_dirty, incomplete_trailing, last_indexed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          snapshot.sessionId,
          snapshot.sourcePath,
          snapshot.headerCwd,
          snapshot.formatVersion,
          snapshot.mtimeNs,
          snapshot.sizeBytes,
          snapshot.indexedBytes,
          snapshot.fingerprint,
          snapshot.sourceIdentity,
          isActive,
          snapshot.incompleteTrailing ? 1 : 0,
          snapshot.incompleteTrailing ? 1 : 0,
          Date.now(),
        );

      for (const chunk of chunks) {
        if (chunk.status === "open" && snapshot.sessionId !== activeSessionId) {
          chunk.status = "complete";
        }
        this.insertChunk(chunk, snapshot.sessionId);
      }
    };

    this.db.exec("BEGIN");
    try {
      run();
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  private insertChunk(chunk: ConversationChunk, sessionId: string): void {
    this.db
      .prepare(
        `INSERT INTO chunks(
          id, project_id, session_id, user_entry_id, branch_leaf_id, variant_hash,
          start_entry_id, end_entry_id, start_ts, end_ts, status,
          user_text, assistant_text, tool_call_count, paired_result_count, raw_entry_ids
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        chunk.id,
        chunk.projectId,
        chunk.sessionId,
        chunk.userEntryId,
        chunk.branchLeafId,
        chunk.variantHash,
        chunk.startEntryId,
        chunk.endEntryId,
        chunk.startTs,
        chunk.endTs,
        chunk.status,
        chunk.userText,
        chunk.assistantText,
        chunk.toolCallCount,
        chunk.pairedResultCount,
        JSON.stringify(chunk.rawEntryIds),
      );

    // Insert into Latin FTS
    const latinRowid = this.nextLatinRowid++;
    this.db
      .prepare(
        `INSERT INTO chunk_fts_latin(rowid, user_text, assistant_text, evidence_text)
         VALUES (?, ?, ?, ?)`,
      )
      .run(latinRowid, chunk.latinText.user, chunk.latinText.assistant, chunk.latinText.evidence);
    this.db
      .prepare("INSERT INTO chunk_fts_latin_map(fts_rowid, chunk_id) VALUES (?, ?)")
      .run(latinRowid, chunk.id);

    // Insert into CJK FTS
    if (chunk.cjkGrams) {
      const cjkRowid = this.nextCjkRowid++;
      this.db
        .prepare(
          `INSERT INTO chunk_fts_cjk(rowid, cjk_grams) VALUES (?, ?)`,
        )
        .run(cjkRowid, chunk.cjkGrams);
      this.db
        .prepare("INSERT INTO chunk_fts_cjk_map(fts_rowid, chunk_id) VALUES (?, ?)")
        .run(cjkRowid, chunk.id);
    }

    // Entities
    const insEnt = this.db.prepare(
      `INSERT INTO entities(chunk_id, entity_type, value, normalized_value, context, confidence, source_entry_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const e of chunk.entities) {
      insEnt.run(
        chunk.id,
        e.entityType,
        e.value,
        e.normalizedValue,
        e.context,
        e.confidence,
        e.sourceEntryId,
      );
    }

    // Constraints
    const insCon = this.db.prepare(
      `INSERT INTO constraints(chunk_id, text, normalized_text, trigger_word, confidence, source_entry_id, extractor_version)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const c of chunk.constraints) {
      insCon.run(
        chunk.id,
        c.text,
        c.normalizedText,
        c.trigger,
        c.confidence,
        c.sourceEntryId,
        c.extractorVersion,
      );
    }

    // Trace steps
    const insTrace = this.db.prepare(
      `INSERT INTO trace_steps(
        chunk_id, source_entry_id, result_entry_id, tool_call_id, tool_name,
        arguments_json, step_type, target, normalized_target, outcome, status, step_order
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const t of chunk.traceSteps) {
      insTrace.run(
        chunk.id,
        t.sourceEntryId,
        t.resultEntryId,
        t.toolCallId,
        t.toolName,
        t.argumentsJson,
        t.stepType,
        t.target,
        t.normalizedTarget,
        t.outcome,
        t.status,
        t.stepOrder,
      );
    }

    // Evidence
    const insEv = this.db.prepare(
      `INSERT INTO evidence(chunk_id, session_id, source_entry_id, evidence_type, evidence_scope, text, confidence)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const ev of chunk.evidence) {
      insEv.run(
        chunk.id,
        sessionId,
        ev.sourceEntryId,
        ev.evidenceType,
        ev.evidenceScope,
        ev.text,
        ev.confidence,
      );
    }
  }

  /**
   * Post-transaction integrity validation for a session (Design H5).
   * Verifies FTS↔chunk consistency and constraint lookup presence.
   * Throws on critical integrity violations so a dirty index is never served.
   */
  private validateSession(sessionId: string): void {
    // 1. Every FTS latin row maps to a valid chunk.
    const orphanLatin = (
      this.db
        .prepare(
          `SELECT COUNT(*) AS c FROM chunk_fts_latin_map m
           LEFT JOIN chunks c ON c.id = m.chunk_id
           WHERE c.id IS NULL AND m.chunk_id IN (SELECT id FROM chunks WHERE session_id = ?)`,
        )
        .get(sessionId) as { c: number }
    ).c;
    if (orphanLatin > 0) {
      throw new Error(
        `Integrity failure: ${orphanLatin} orphan Latin FTS rows for session ${sessionId}`,
      );
    }

    // 2. Every CJK FTS row maps to a valid chunk.
    const orphanCjk = (
      this.db
        .prepare(
          `SELECT COUNT(*) AS c FROM chunk_fts_cjk_map m
           LEFT JOIN chunks c ON c.id = m.chunk_id
           WHERE c.id IS NULL AND m.chunk_id IN (SELECT id FROM chunks WHERE session_id = ?)`,
        )
        .get(sessionId) as { c: number }
    ).c;
    if (orphanCjk > 0) {
      throw new Error(
        `Integrity failure: ${orphanCjk} orphan CJK FTS rows for session ${sessionId}`,
      );
    }

    // 3. Complete chunks have at least one FTS entry.
    const missingFts = (
      this.db
        .prepare(
          `SELECT COUNT(*) AS c FROM chunks c
           WHERE c.session_id = ? AND c.status = 'complete'
           AND NOT EXISTS (SELECT 1 FROM chunk_fts_latin_map WHERE chunk_id = c.id)`,
        )
        .get(sessionId) as { c: number }
    ).c;
    if (missingFts > 0) {
      throw new Error(
        `Integrity failure: ${missingFts} complete chunks with no Latin FTS entry for session ${sessionId}`,
      );
    }
  }

  prepare(sql: string) {
    return this.db.prepare(sql);
  }

  get database(): SqlDatabase {
    return this.db;
  }
}

const cache = new Map<string, HistoryIndex>();

export function getIndexForCwd(cwd: string, agentDir?: string): HistoryIndex {
  const project = resolveProjectIdentity(cwd);
  const key = `${project.projectId}|${agentDir ?? ""}`;
  let idx = cache.get(key);
  if (!idx) {
    idx = new HistoryIndex(project, agentDir);
    cache.set(key, idx);
  }
  return idx;
}

export function clearIndexCache(): void {
  for (const idx of cache.values()) {
    try {
      idx.close();
    } catch {
      // ignore
    }
  }
  cache.clear();
}
