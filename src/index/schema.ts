/** SQLite DDL for the disposable project history index. */

export const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS index_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  session_id       TEXT PRIMARY KEY,
  source_path      TEXT NOT NULL,
  header_cwd       TEXT NOT NULL,
  format_version   INTEGER NOT NULL DEFAULT 0,
  mtime_ns         TEXT NOT NULL,
  size_bytes       INTEGER NOT NULL,
  indexed_bytes    INTEGER NOT NULL DEFAULT 0,
  fingerprint      TEXT NOT NULL,
  source_identity  TEXT,
  is_active        INTEGER NOT NULL DEFAULT 0 CHECK (is_active IN (0, 1)),
  is_dirty         INTEGER NOT NULL DEFAULT 0 CHECK (is_dirty IN (0, 1)),
  incomplete_trailing INTEGER NOT NULL DEFAULT 0,
  last_indexed_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS chunks (
  id                  TEXT PRIMARY KEY,
  project_id          TEXT NOT NULL,
  session_id          TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  user_entry_id       TEXT NOT NULL,
  branch_leaf_id      TEXT NOT NULL,
  variant_hash        TEXT NOT NULL,
  start_entry_id      TEXT NOT NULL,
  end_entry_id        TEXT NOT NULL,
  start_ts            INTEGER NOT NULL,
  end_ts              INTEGER NOT NULL,
  status              TEXT NOT NULL DEFAULT 'complete',
  user_text           TEXT NOT NULL,
  assistant_text      TEXT NOT NULL DEFAULT '',
  tool_call_count     INTEGER NOT NULL DEFAULT 0,
  paired_result_count INTEGER NOT NULL DEFAULT 0,
  raw_entry_ids       TEXT NOT NULL DEFAULT '[]',
  UNIQUE(session_id, user_entry_id, variant_hash)
);
CREATE INDEX IF NOT EXISTS idx_chunks_session ON chunks(session_id);
CREATE INDEX IF NOT EXISTS idx_chunks_end_ts ON chunks(end_ts DESC);
CREATE INDEX IF NOT EXISTS idx_chunks_user_entry ON chunks(session_id, user_entry_id);
CREATE INDEX IF NOT EXISTS idx_chunks_status ON chunks(status);

-- Latin FTS: porter stemmer for English, remove diacritics, prefix index length 2.
CREATE VIRTUAL TABLE IF NOT EXISTS chunk_fts_latin USING fts5(
  user_text,
  assistant_text,
  evidence_text,
  content='',
  tokenize='porter unicode61 remove_diacritics 2'
);

-- CJK FTS: unicode61 only; indexed via precomputed n-grams in the cjk_grams column.
CREATE VIRTUAL TABLE IF NOT EXISTS chunk_fts_cjk USING fts5(
  cjk_grams,
  content='',
  tokenize='unicode61'
);

-- Rowid-to-chunk_id mapping for Latin FTS.
CREATE TABLE IF NOT EXISTS chunk_fts_latin_map (
  fts_rowid INTEGER PRIMARY KEY,
  chunk_id   TEXT NOT NULL UNIQUE REFERENCES chunks(id) ON DELETE CASCADE
);

-- Rowid-to-chunk_id mapping for CJK FTS.
CREATE TABLE IF NOT EXISTS chunk_fts_cjk_map (
  fts_rowid INTEGER PRIMARY KEY,
  chunk_id   TEXT NOT NULL UNIQUE REFERENCES chunks(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS entities (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  chunk_id         TEXT NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
  entity_type      TEXT NOT NULL,
  value            TEXT NOT NULL,
  normalized_value TEXT NOT NULL,
  context          TEXT NOT NULL DEFAULT '',
  confidence       REAL NOT NULL DEFAULT 1.0,
  source_entry_id  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_entities_chunk ON entities(chunk_id);
CREATE INDEX IF NOT EXISTS idx_entities_type_value ON entities(entity_type, normalized_value);

CREATE TABLE IF NOT EXISTS constraints (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  chunk_id          TEXT NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
  text              TEXT NOT NULL,
  normalized_text   TEXT NOT NULL,
  trigger_word      TEXT NOT NULL,
  confidence        REAL NOT NULL DEFAULT 0.55,
  source_entry_id   TEXT NOT NULL,
  extractor_version TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_constraints_chunk ON constraints(chunk_id);
CREATE INDEX IF NOT EXISTS idx_constraints_lookup ON constraints(normalized_text);

CREATE TABLE IF NOT EXISTS trace_steps (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  chunk_id           TEXT NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
  source_entry_id    TEXT NOT NULL,
  result_entry_id    TEXT,
  tool_call_id       TEXT,
  tool_name          TEXT,
  arguments_json     TEXT,
  step_type          TEXT NOT NULL,
  target             TEXT NOT NULL,
  normalized_target  TEXT NOT NULL,
  outcome            TEXT NOT NULL DEFAULT '',
  status             TEXT NOT NULL DEFAULT 'unknown',
  step_order         INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_trace_chunk ON trace_steps(chunk_id);
CREATE INDEX IF NOT EXISTS idx_trace_type ON trace_steps(step_type, normalized_target);

CREATE TABLE IF NOT EXISTS evidence (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  chunk_id        TEXT REFERENCES chunks(id) ON DELETE CASCADE,
  session_id      TEXT NOT NULL,
  source_entry_id TEXT NOT NULL,
  evidence_type   TEXT NOT NULL,
  evidence_scope  TEXT NOT NULL,
  text            TEXT NOT NULL,
  confidence      REAL NOT NULL DEFAULT 0.5
);
CREATE INDEX IF NOT EXISTS idx_evidence_chunk ON evidence(chunk_id);
CREATE INDEX IF NOT EXISTS idx_evidence_session ON evidence(session_id);
`;

export const META_KEYS = {
  schemaVersion: "schema_version",
  projectId: "project_id",
  canonicalCwd: "canonical_cwd",
  extractorVersion: "extractor_version",
  redactionVersion: "redaction_version",
  lastRebuild: "last_rebuild",
  sessionCount: "session_count",
  chunkCount: "chunk_count",
} as const;
