# Design: pi-agent-history-recall

## Overview

**Goal**: Project Conversation Retrieval — reduce exploration cost when an agent resumes work on a project it worked on before.

When the agent receives a request such as "修改货期规则", it should:

1. Search prior conversations for the current project.
2. Recover relevant files, symbols, constraints, failed directions, and the exploration path that found them.
3. Verify the evidence against the current working tree.
4. Modify only after verification.

The system does **not** primarily save context tokens. It saves **exploration cost**.

---

## Core principles

### 1. Session JSONL is the sole source of truth

Pi session JSONL is the only durable source. SQLite is a disposable derived index: deleting the index and rebuilding it from eligible session files must produce equivalent retrieval results.

The index never becomes a second chat database and never writes generated summaries back into sessions.

### 2. Project isolation is a verified invariant

Queries are always scoped to the current project. The extension must never ingest, search, or return a chunk belonging to another project, including when two cwd values collide under Pi's session-directory encoding.

Project identity is defined as:

```text
canonical_cwd = NFC(realpath(ctx.cwd))
project_id    = SHA-256(canonical_cwd)
```

Rules:

- Pi's encoded session-directory name is a discovery hint only; it is not a unique project identifier.
- Every candidate session header must contain a cwd whose canonical form exactly equals `canonical_cwd` before any entry is indexed.
- Sessions with a missing or unresolvable header cwd are skipped by default. Supporting legacy sessions requires an explicit user mapping.
- The opened database must contain the same `project_id` and `canonical_cwd`; a mismatch is a hard error, not a rebuild-in-place.
- `read_project_history` re-checks that the requested chunk belongs to the current `project_id`.
- Chunk IDs are namespaced by `project_id`, so an ID from another project cannot be resolved accidentally.

### 3. The session is a tree; the retrieval unit is a branch-safe Conversation Chunk

Pi session JSONL is an append-only tree linked by `id` and `parentId`. File order is not conversation-path order. The ingester must build the tree before constructing chunks.

A **Conversation Chunk** represents one user turn on one valid branch variant:

```text
user: "修改货期规则"
 ↓
assistant: visible text + tool calls
 ↓
tool results paired by toolCallId
 ↓
... more assistant/tool-loop entries on the same branch ...
 ↓
next user entry, branch leaf, or session end
```

A chunk captures the exploration and action chain, not an arbitrary range of adjacent JSONL lines.

If a user turn forks before the next user entry, each root-to-boundary path becomes a separate chunk variant. Sibling variants must never be merged. Retrieval groups sibling variants by user anchor and avoids double-counting their shared prefix.

### 4. History is evidence, not fact

The workflow is:

```text
Recall → Locate → Verify Current Code → Modify
```

History narrows exploration but does not replace it. Files may have moved, symbols may have changed, and old constraints may no longer apply. The agent must read the current files before editing and may expand to adjacent dependencies when current code shows that this is necessary.

### 5. Exploration trace is first-class data

The most useful recovered data is often **how** the agent found the implementation:

- Which patterns were searched?
- Which files were opened?
- Why were modules excluded?
- Which attempts failed?
- Which edit or verification completed the work?

Tool calls and results retain stable provenance so this trace can be reconstructed without relying on generated summaries.

### 6. Privacy is a default, not an optional cleanup

Session files may contain secrets, environment values, private keys, customer data, and absolute paths. The index stores only the text and structured metadata needed for retrieval; it does not persist full tool-result bodies.

All indexed and returned content passes through the same deterministic redaction layer. Sensitive paths and tool outputs are excluded by default. See [Privacy and retention](#index-location-privacy-and-retention).

---

## Reference boundaries

### vs cog-cli (`vendor/cog-cli`)

| Aspect | cog-cli | This project |
|--------|---------|--------------|
| Focus | Long-term AI memory | Project conversation retrieval |
| Who writes | Agent proactively calls a learn tool | System derives an index from session JSONL |
| Data source | Agent-generated memories | Pi behavior log |
| Scope | Cross-project/persona | One verified project |
| Embedding | Present | Deferred to v2+ |

Take inspiration from disposable indexes, structured fields, and recall-then-explore workflows. Do not copy proactive memory writes, cross-project reasoning, preference learning, or generated summaries as primary storage.

### vs pi-context-prune (`vendor/pi-context-prune`)

| Aspect | pi-context-prune | This project |
|--------|------------------|--------------|
| Scope | Current session | Eligible historical sessions for one project |
| Unit | Assistant turn | Branch-safe user-turn chunk variant |
| Purpose | Compress current context | Retrieve prior exploration evidence |
| Storage | Session custom entries | Disposable SQLite index |
| Retrieval | Entry lookup | Multi-source lexical/entity/trace retrieval |

Take inspiration from pairing tool calls and results by ID, structured tool returns, and explicit provenance. Do not copy single-session assumptions or LLM summarization.

---

## Architecture (v1)

```text
Pi Session JSONL (source of truth)
        │
        ▼
Project Gate
  canonicalize ctx.cwd → verify every session header cwd
        │
        ▼
Session Parser
  version migration → id/parentId tree → compaction/branch metadata
        │
        ▼
Branch-safe Chunk Builder
  user anchor + valid path variant → Conversation Chunk
        │
        ├── toolCall.id ↔ toolResult.toolCallId → Exploration Trace
        ├── deterministic extraction → entities + constraints
        ├── visible text → Latin FTS terms
        └── CJK spans → generated bigram/trigram terms
        │
        ▼
Disposable SQLite Index
  sessions, chunks, entities, constraints, trace_steps,
  evidence_records, chunk_fts_latin, chunk_fts_cjk, index_meta
        │
        ▼
Retriever
  safe query compiler → union candidate sources → deterministic rank
        │
        ▼
Agent tools
  search_project_history → read_project_history → verify current code
```

### No embeddings in v1

v1 uses Latin BM25, deterministic CJK n-grams, exact/prefix entity matching, constraint matching, and trace matching. Embeddings and semantic re-ranking are deferred to v2+; v1 does not reserve an unused vector column.

### No LLM summary generation

Extraction is deterministic. The extension does not call an LLM to generate summaries, decisions, or insights. Any displayed outcome is a bounded excerpt from a source entry with provenance, not a generated fact.

### Runtime requirement

v1 uses `node:sqlite` and declares a compatible minimum Node version in `package.json`. Startup performs a capability check for SQLite FTS5 and fails with an actionable diagnostic if the runtime lacks it.

---

## Module breakdown

```text
src/
  index.ts                     # register tools, commands, and lifecycle hook
  project.ts                   # canonical cwd, project id, isolation checks
  privacy.ts                   # path policy, redaction, output limits
  session/
    discover.ts                # discover candidates, verify session headers
    parse.ts                   # parse/migrate JSONL and build id/parentId tree
    paths.ts                   # enumerate valid branch paths
  chunk/
    builder.ts                 # build user-turn chunk variants
    provenance.ts              # stable ids and source references
  extract/
    entities.ts                # paths, symbols, modules, and errors
    constraints.ts             # conservative business-rule extraction
    exploration.ts             # paired tool-call exploration trace
    cjk.ts                     # CJK span detection and n-gram generation
  index/
    schema.ts                  # SQLite DDL and migrations
    manifest.ts                # per-session change reconciliation
    lock.ts                    # cross-process writer lease and stale recovery
    store.ts                   # transactional replace/delete/rebuild
    fts.ts                     # explicit Latin/CJK FTS synchronization
  retrieve/
    query.ts                   # safe query compiler
    candidates.ts              # union FTS/entity/constraint/trace candidates
    rank.ts                    # relevance, confidence, and freshness
    search.ts                  # project-scoped orchestration
  tools/
    search_project_history.ts
    read_project_history.ts
```

---

## SQLite schema (v1)

The database is per project, but `project_id` is still stored on project-owned rows as defense in depth.

```sql
PRAGMA foreign_keys = ON;

CREATE TABLE index_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- Required keys: schema_version, project_id, canonical_cwd,
-- extractor_version, redaction_version, last_reconcile

CREATE TABLE sessions (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL,
  source_path    TEXT NOT NULL UNIQUE,
  header_cwd     TEXT NOT NULL,
  source_identity TEXT,
  mtime_ns       TEXT NOT NULL,
  size_bytes     INTEGER NOT NULL,
  indexed_bytes  INTEGER NOT NULL,
  fingerprint    TEXT NOT NULL,
  format_version INTEGER NOT NULL,
  is_active      INTEGER NOT NULL DEFAULT 0 CHECK (is_active IN (0, 1)),
  is_dirty       INTEGER NOT NULL DEFAULT 0 CHECK (is_dirty IN (0, 1)),
  UNIQUE(id, project_id)
);
CREATE INDEX idx_sessions_project ON sessions(project_id);

CREATE TABLE chunks (
  id                  TEXT PRIMARY KEY,
  project_id          TEXT NOT NULL,
  session_id          TEXT NOT NULL,
  user_entry_id       TEXT NOT NULL,
  branch_leaf_id      TEXT NOT NULL,
  variant_hash        TEXT NOT NULL,
  start_entry_id      TEXT NOT NULL,
  end_entry_id        TEXT NOT NULL,
  start_ts            INTEGER NOT NULL,
  end_ts              INTEGER NOT NULL,
  status              TEXT NOT NULL CHECK (status IN ('complete', 'open')),
  user_text           TEXT NOT NULL,
  assistant_text      TEXT NOT NULL DEFAULT '',
  tool_call_count     INTEGER NOT NULL DEFAULT 0,
  paired_result_count INTEGER NOT NULL DEFAULT 0,
  raw_entry_ids       TEXT NOT NULL DEFAULT '[]',
  UNIQUE(session_id, user_entry_id, variant_hash),
  UNIQUE(id, session_id),
  FOREIGN KEY (session_id, project_id)
    REFERENCES sessions(id, project_id) ON DELETE CASCADE
);
CREATE INDEX idx_chunks_project_end ON chunks(project_id, end_ts DESC);
CREATE INDEX idx_chunks_session ON chunks(session_id);

CREATE TABLE entities (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  chunk_id        TEXT NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
  source_entry_id TEXT NOT NULL,
  entity_type     TEXT NOT NULL CHECK (
    entity_type IN ('file_path', 'symbol', 'module', 'error')
  ),
  value           TEXT NOT NULL,
  normalized_value TEXT NOT NULL,
  context         TEXT NOT NULL DEFAULT '',
  confidence      REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1)
);
CREATE INDEX idx_entities_chunk ON entities(chunk_id);
CREATE INDEX idx_entities_lookup ON entities(entity_type, normalized_value);

CREATE TABLE constraints (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  chunk_id         TEXT NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
  source_entry_id  TEXT NOT NULL,
  text             TEXT NOT NULL,
  normalized_text  TEXT NOT NULL,
  trigger           TEXT NOT NULL,
  confidence        REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  extractor_version TEXT NOT NULL
);
CREATE INDEX idx_constraints_chunk ON constraints(chunk_id);
CREATE INDEX idx_constraints_lookup ON constraints(normalized_text);

CREATE TABLE trace_steps (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  chunk_id        TEXT NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
  source_entry_id TEXT NOT NULL,
  result_entry_id TEXT,
  tool_call_id    TEXT,
  tool_name       TEXT,
  arguments_json  TEXT,
  step_type       TEXT NOT NULL CHECK (
    step_type IN ('read', 'grep', 'find', 'list', 'bash', 'edit', 'write', 'tool',
                  'error', 'exclusion', 'verification')
  ),
  target          TEXT NOT NULL,
  normalized_target TEXT NOT NULL,
  outcome         TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL DEFAULT 'unknown' CHECK (
    status IN ('success', 'error', 'unknown')
  ),
  step_order      INTEGER NOT NULL
);
CREATE INDEX idx_trace_chunk_order ON trace_steps(chunk_id, step_order);
CREATE INDEX idx_trace_target ON trace_steps(normalized_target);
CREATE INDEX idx_trace_tool_call ON trace_steps(tool_call_id);

CREATE TABLE evidence_records (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id      TEXT NOT NULL,
  session_id      TEXT NOT NULL,
  chunk_id        TEXT,
  source_entry_id TEXT NOT NULL,
  evidence_type   TEXT NOT NULL CHECK (
    evidence_type IN ('compaction', 'branch_summary', 'custom_message')
  ),
  evidence_scope  TEXT NOT NULL CHECK (evidence_scope IN ('chunk', 'session')),
  text            TEXT NOT NULL,
  confidence      REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  CHECK (
    (evidence_scope = 'chunk' AND chunk_id IS NOT NULL) OR
    (evidence_scope = 'session' AND chunk_id IS NULL)
  ),
  FOREIGN KEY (session_id, project_id)
    REFERENCES sessions(id, project_id) ON DELETE CASCADE,
  FOREIGN KEY (chunk_id, session_id)
    REFERENCES chunks(id, session_id) ON DELETE CASCADE
);

-- Explicitly synchronized FTS tables. They are not external-content tables.
CREATE VIRTUAL TABLE chunk_fts_latin USING fts5(
  chunk_id UNINDEXED,
  user_text,
  assistant_text,
  evidence_text,
  tokenize='porter unicode61 remove_diacritics 2'
);

CREATE VIRTUAL TABLE chunk_fts_cjk USING fts5(
  chunk_id UNINDEXED,
  grams,
  tokenize='unicode61'
);
```

Stable chunk IDs are computed as:

```text
SHA-256(project_id + NUL + session_id + NUL + user_entry_id + NUL + variant_hash)
```

No source path or user text participates in the ID, so ordinary file movement or redaction changes do not silently create duplicate logical chunks.

---

## Session ingestion and chunk construction

### 1. Discover and verify sessions

1. Canonicalize `ctx.cwd` and compute `project_id`.
2. Ask Pi for session candidates associated with the cwd.
3. Read each candidate header before the remaining entries.
4. Canonicalize the header cwd and require exact equality with the current `canonical_cwd`.
5. Skip malformed, foreign, missing-cwd, or unsupported-version sessions and record a local diagnostic count.

Discovery must not trust the encoded directory name, because different cwd values can encode to the same directory.

### 2. Parse the session tree

- Use Pi's session parsing/migration helpers when available; otherwise implement equivalent support for all declared v1 input versions.
- Parse each entry by `id` and `parentId` and reject duplicate IDs, dangling parents, and cycles.
- Pair tool calls and results only by `ToolCall.id == ToolResult.toolCallId`.
- Preserve source entry IDs and source ordinals. Never pair calls and results by adjacency.
- Recognize `compaction` and `branch_summary` entries explicitly. Normalize migrated aliases to the current parser representation.
- Recognize bash history as a `type: "message"` entry whose message role is `bashExecution`; it is not a top-level session entry type.
- Recognize current `custom_message` entries and migrated custom-entry aliases. Extension-generated entries carry an extension marker and are excluded from retrieval text.
- Compaction records are auxiliary chunk evidence with direct source provenance. They never replace raw entries that still exist in the JSONL source.
- A branch summary is attached structurally to the new navigation path but describes an abandoned branch. Because its `fromId` is a navigation target rather than complete provenance for every summarized statement, store it as session-scoped auxiliary evidence only. It must not generate branch-local entities, constraints, traces, FTS terms, or ranking bonuses.

### 3. Enumerate branch-safe chunk variants

For each user entry:

1. Follow each valid descendant path until the next user entry or a branch leaf.
2. Collect visible assistant text, tool calls, and paired results on that path only.
3. If multiple paths exist before the boundary, emit one variant per path.
4. Compute `variant_hash` from the ordered entry IDs after the user anchor.
5. Mark a chunk `complete` when its path reaches a later user entry or belongs to a settled historical session. Mark the current session's unfinished tail `open`.

Sibling variants share a user anchor but remain separate rows. Search presentation groups siblings and shows the highest-ranked variant first; scoring does not add the same shared prefix multiple times.

Branch expansion is bounded to protect indexing from adversarial or unusually branch-heavy sessions. The default limits are 64 variants per user anchor and 10,000 chunks per session. If a limit is exceeded, the ingester fails closed for the affected anchor or session, records a diagnostic, and retains the previously indexed revision. It must never merge sibling paths or silently publish a truncated branch set as complete history.

### 4. Text policy

- `user_text` contains the visible user text.
- `assistant_text` contains visible assistant `text` blocks only.
- Pi `thinking` blocks are not indexed or returned by default because they can contain sensitive latent reasoning and substantially increase index size.
- A future opt-in `indexThinking` setting may store redacted thinking in a separate field; it must never be silently merged into `assistant_text`.
- Full tool-result bodies are not stored in SQLite. Only redacted, bounded outcome excerpts and structured entities are stored.

### 5. Current-turn exclusion

Searches initiated by `before_agent_start` exclude:

- the entire current session, because this hook runs before the new user prompt has a stable persisted entry ID;
- `custom_message` entries carrying this extension's marker;
- any chunk whose source entries have not finished parsing.

Explicit tool searches made after the agent loop starts may include completed earlier chunks from the current session, but always exclude its latest `open` chunk. The implementation must not pretend that `before_agent_start` provides a current user entry ID. These rules prevent the current prompt or previous unfinished tail from being presented as historical evidence.

---

## Deterministic extraction

### Structured tool extraction

Structured arguments take precedence over text regexes:

| Tool | Relevant arguments | Trace type |
|------|--------------------|------------|
| `read` | `path`, `offset`, `limit` | `read` |
| `grep` | `pattern`, `path`, `glob` | `grep` |
| `find` | `pattern`, `path` | `find` |
| `ls` | `path`, `limit` | `list` |
| `edit` | `path` | `edit` |
| `write` | `path` | `write` |
| `bash` | `command` | parsed as search/bash/verification |

Unknown and extension-provided tools retain `tool_name` and redacted `arguments_json`; recognized path-like fields are extracted conservatively.

Shell commands are tokenized with a shell-aware parser. The system must not use whitespace regexes as the primary parser for quoted paths, Unicode paths, pipes, or redirections.

### File paths

- Prefer structured tool arguments.
- Normalize separators and resolve relative paths against `canonical_cwd`.
- Store project-relative display paths where possible.
- Reject normalized paths outside the project and symlink escapes unless an explicit setting permits them.
- Text fallback supports backticks, quotes, Unicode letters, spaces inside quotes, and trailing punctuation.

### Symbols, modules, and errors

- Extract symbols from structured tool arguments, search patterns, compiler/test output, and backtick-quoted identifiers.
- Associate every entity with `source_entry_id`.
- Extract errors from paired `toolResult.isError`, non-zero command results, and conservative language-specific error signatures.
- A failed step remains valuable trace evidence. It is not automatically treated as low-quality history.

### Business rules and constraints

Constraint extraction is deliberately conservative and keeps the original sentence:

- English triggers: `because`, `must`, `must not`, `cannot`, `constraint`, `rule`, `invariant`, `required`.
- Chinese triggers: `因为`, `必须`, `不得`, `不能`, `约束`, `规则`, `不变量`, `要求`.
- Negation and quoted-code filters prevent obvious false positives.
- Each row stores the trigger, source entry, extractor version, and confidence.

Constraint text is evidence to verify, never an authoritative current business rule.

### Exploration trace

Trace steps are ordered by source ordinal. Each tool call records its call ID, source entry, arguments, result entry, status, target, and bounded outcome. Direct `grep`, `find`, and `ls` calls are captured in addition to equivalent shell commands.

Assistant statements such as “I ruled out X because…” or “问题不在 Y，因为…” may produce an `exclusion` step with the exact source sentence and entry ID.

---

## Retrieval pipeline

### Input normalization and safe query compilation

Given:

```text
query:       "修改货期规则 src/order/delivery.ex"
project_cwd: "/Users/box/dev-code/erp"
```

The query compiler:

1. Applies Unicode NFC normalization and bounded case folding.
2. Enforces configured query length and token-count limits.
3. Extracts path, symbol, and error-like terms before FTS compilation.
4. Converts Latin terms into individually quoted FTS terms; raw user operators are never passed to `MATCH`.
5. Converts CJK spans into overlapping two- and three-code-point grams separated by spaces.
6. Handles empty/one-character/symbol-only queries without constructing invalid FTS syntax.

Inputs such as `C++`, `src/order.ts`, `foo-bar`, unmatched quotes, and `apply_delivery_date/2` must not raise FTS syntax errors.

### Candidate generation

Candidates are the union of independent sources, not “FTS first, boosts later”:

1. Latin FTS over user, assistant, and evidence text.
2. CJK n-gram FTS over the same redacted source text.
3. Exact/prefix entity lookup for paths, symbols, modules, and errors.
4. Constraint lookup.
5. Exact/prefix exploration-target lookup.

This allows a chunk to be recalled when a path appears only in a tool argument and never in conversational prose.

### Deterministic ranking

Each candidate has three separate axes.

#### Relevance (0–100)

For each active candidate source `s`, assign a one-based rank `rank_s`. Compute weighted reciprocal-rank fusion with `k = 60`:

```text
rrf       = Σ(weight_s / (60 + rank_s))
rrf_max   = Σ(weight_s / 61) for the query's active sources
rrf_norm  = 100 × rrf / rrf_max

weights:
  Latin FTS       1.0
  CJK FTS         1.0
  entity          1.4
  constraint      1.1
  trace target    1.2

exact_bonus:
  exact project-relative path   +20
  exact symbol/error            +15
  exact normalized user phrase  +10
  maximum combined bonus        +25

Relevance = clamp(round(0.75 × rrf_norm + exact_bonus), 0, 100)
```

SQLite's raw negative `bm25()` value is used only to rank rows within an FTS source; it is never presented as an absolute confidence score.

#### Confidence (0–100)

Confidence measures provenance completeness, not semantic relevance:

```text
base                                                 40
all tool calls in the variant are paired             +15
all referenced source entry IDs resolve              +15
entity is independently present in a trace target    +10
trace contains a terminal edit/write/verification    +10
constraint/exclusion has direct source provenance    +10
open or partially parsed chunk                       -30
orphaned tool result or unresolved source entry      -20
error-only trace with no later success/verification  -10
```

The result is clamped to 0–100. A failed direction followed by successful verification is not penalized.

The tool-pairing bonus applies only when `tool_call_count > 0`; a chunk with no tool calls does not receive the bonus by vacuous truth. Missing evidence cannot increase confidence.

#### Freshness

Freshness is displayed separately and never silently changes relevance:

| Age | Label |
|-----|-------|
| `< 7 days` | High |
| `7–30 days` | Medium |
| `> 30 days` | Low |

Tie-break order is `Relevance DESC`, `Confidence DESC`, `end_ts DESC`, `chunk_id ASC`.

Default thresholds are calibrated and frozen against the regression fixtures before release. Until calibration is complete, automatic hints remain disabled even though explicit search remains available.

---

## Tools

### `search_project_history`

```typescript
{
  query: string;
  maxResults?: number;     // default 5, max 20
  minRelevance?: number;   // calibrated default
  minConfidence?: number;  // calibrated default
}
```

Returns grouped, ranked chunk variants:

```text
[1] Relevance: 91 | Confidence: 85 | Freshness: High
Session: 2026-07-10T...
Files: src/order/delivery.ex, lib/delivery_rule.ex
Symbols: DeliveryRule, apply_delivery_date/2
Constraints: “货期不能早于已确认的出库日期” [source entry: ...]
Rejected: legacy_shipping because it bypassed order validation [source entry: ...]
Errors: one failed test followed by a successful verification
Snippet: redacted user prompt + bounded assistant excerpt
```

The tool returns source session ID and entry IDs, but does not expose an absolute session path in normal model-facing output.

### `read_project_history`

```typescript
{
  chunkId: string;
}
```

Before reading, the tool verifies current `project_id == chunk.project_id`. It returns:

- user prompt and visible assistant text;
- paired tool calls with redacted arguments and bounded result excerpts;
- complete exploration trace and statuses;
- extracted entities, constraints, exclusions, and provenance;
- source session ID and entry IDs for verification;
- sibling branch variants when relevant.

Full raw tool-result bodies remain in the source session and are read only on demand under the same redaction and size limits; they are never copied wholesale into SQLite.

### `history_search`

Backward-compatible alias for `search_project_history`.

### Administrative command

`/history-recall clear` deletes the current project's disposable index only. Rebuild remains possible from eligible session JSONL files. A project-level opt-out disables both indexing and hints.

---

## Agent workflow and lifecycle hook

### Tool guidance

```text
Use search_project_history when prior work may identify relevant files or constraints.
History is evidence, not current truth.

1. search_project_history → find prior evidence
2. read_project_history   → inspect trace and provenance
3. read current files     → verify the live implementation
4. expand only as needed  → follow current dependencies when evidence is stale
5. modify and test

Do not repeat a broad repository scan when verified history already narrows the area.
Do not avoid necessary adjacent-file checks merely because they were absent from history.
```

### `before_agent_start`

The hook never injects a full chunk. Once ranking thresholds are calibrated, it may inject one redacted line when a complete historical chunk exceeds both thresholds:

```text
[History hint: prior work on "货期规则" involved src/order/delivery.ex — use search_project_history for evidence]
```

The hook excludes the entire current session because Pi has not yet assigned the submitted prompt a persisted entry ID at this point. It also excludes extension-marked `custom_message` content. If indexing is stale, incomplete, disabled, or below threshold, it injects nothing.

---

## Transactional indexing and incremental reconciliation

### Per-session manifest

`sessions` is the manifest. Reconciliation enumerates the currently eligible, header-verified session set and compares it with stored rows using:

- stable session ID and source path;
- source identity where the platform exposes it (for example device/inode);
- nanosecond mtime and file size as scheduling hints only;
- a content fingerprint as the authoritative equality check, including when size and mtime are unchanged.

The reconcile operation detects additions, modifications, same-metadata content replacement, deletions, and renames. A single global `last_rebuild` timestamp is not used to decide correctness. Metadata may avoid reparsing a file only after its fingerprint has been verified for the current reconcile generation.

### Stable file snapshot

Parsing and manifest metadata must describe the same byte snapshot:

1. Open the source once and record `fstat` identity, size, and nanosecond mtime.
2. Read and hash exactly that initial byte range from the same file descriptor while parsing complete JSONL lines.
3. Record `indexed_bytes`, including the exact boundary before any incomplete trailing line.
4. `fstat` the same descriptor again before committing.
5. If identity, size, or mtime changed, discard the candidate rows and retry from a new descriptor.
6. If the file remains unstable after the bounded retry count, retain the prior indexed revision, mark the session dirty, and retry later; never publish new manifest metadata for a partially observed revision.

An append after the final `fstat` leaves the stored older size/fingerprint visible as stale on the next reconcile. Fingerprint comparison also catches replacements that preserve size and mtime.

### Atomic replacement

For each changed or removed session, one SQLite transaction:

1. Deletes its Latin/CJK FTS rows explicitly.
2. Deletes or replaces the `sessions` row; foreign-key cascades remove chunks and child rows.
3. Inserts rebuilt chunks, entities, constraints, traces, and evidence.
4. Inserts the corresponding FTS rows explicitly.
5. Updates manifest metadata only after all writes succeed.

After every changed-session transaction, and again on startup/full rebuild, integrity checks assert:

- every FTS `chunk_id` resolves to exactly one chunk;
- every complete searchable chunk has both expected FTS rows when it contains relevant text;
- every chunk's `(session_id, project_id)` resolves through the composite foreign key;
- no row has a foreign `project_id`;
- full rebuild and incremental reconcile produce equivalent logical rows.

### Cross-process writer safety

Multiple Pi processes may open the same project index. v1 therefore requires a per-project writer lease; process-safe coordination is not deferred to a later version.

- Acquire the lease through an atomic filesystem operation before the final source `fstat` and hold it through the SQLite commit.
- Store owner PID, process-start identity where available, acquisition time, and a random nonce in the lease metadata.
- Recover a stale lease only after verifying that its owner is no longer alive or after an explicitly documented conservative timeout; timeout alone must not break a demonstrably live owner.
- After acquiring the lease, re-check both the source snapshot and the current database manifest. Discard parsed rows if either changed while waiting.
- Use `BEGIN IMMEDIATE`, a bounded busy timeout, and rollback on every failed integrity check.
- Readers continue using the last committed snapshot and never observe partially replaced session rows.

Crash-recovery fixtures must cover termination while holding the lease and while a SQLite transaction is open.

### Active session safety

The parser tolerates one incomplete trailing JSONL line while a session is actively being appended. It hashes the observed bytes but records `indexed_bytes` only through the last complete line, marks the unfinished tail open, and never claims that unparsed bytes were indexed. A later stable-snapshot reconcile replaces that session atomically.

### Performance budgets

Performance is measured separately for reconciliation and query execution:

- full rebuild target: `< 5s` for the checked-in representative 300-session fixture;
- incremental reconcile target: `< 250ms` when one ordinary session changes;
- warm search target: `< 10ms` p95 over the representative index;
- `before_agent_start` target: no synchronous full rebuild; skip the hint if the index is unavailable or stale beyond the allowed budget.

These are benchmark targets, not assumptions. CI records regressions using fixed fixtures.

---

## Index location, privacy, and retention

### Index location

```text
~/.pi/agent/history-recall/<sha256-canonical-cwd>.sqlite
```

The parent directory is created with mode `0700`; SQLite files and sidecars use `0600`. On platforms without POSIX modes, the implementation uses the strongest available user-only permissions and documents limitations.

### Redaction and exclusion

Before persistence and again before tool output:

- redact common API keys, bearer tokens, private-key blocks, credentials, and configured patterns;
- exclude `.env*`, credential stores, key files, and user-configured sensitive paths;
- cap text, argument, and outcome lengths;
- prefer project-relative display paths;
- never place absolute session paths in automatic hints.

Redaction is versioned. Changing `redaction_version` forces affected sessions to be rebuilt.

### Retention and control

- The index follows source-session retention; reconciliation removes deleted sessions.
- Users can clear the disposable index for the current project.
- Projects can opt out through `.pi/history-recall.json` or user settings.
- Raw session deletion remains Pi's responsibility; the extension does not claim that clearing the index deletes source history.

---

## Non-goals (v1)

- Embedding or vector search.
- Knowledge-graph construction.
- Cross-project reasoning.
- User-preference learning.
- Agent-written long-term memory.
- LLM-based summarization or insight generation.
- Automatic consolidation across sessions.
- Treating historical constraints as current truth.

---

## v2+ candidates

- Embedding-based re-ranking over the v1 candidate union.
- Versioned architectural-decision extraction.
- Optional, separately stored thinking-block indexing with explicit consent.
- Cross-session entity relationships within the same verified project.
- Background reconciliation and scheduling; it reuses the mandatory v1 writer lease.

---

## Acceptance and regression tests

All correctness tests use deterministic, checked-in JSONL fixtures with fixed expected chunk IDs, candidate sets, ordering, provenance, and threshold boundaries.

### Required fixture cases

1. **CJK recall** — “货期规则” matches a longer Chinese sentence containing that phrase; two-character terms and mixed Chinese/English queries work.
2. **Safe MATCH compilation** — `C++`, paths, hyphens, slashes, symbols, unmatched quotes, and empty queries never produce FTS syntax errors.
3. **Entity-only recall** — a file path present only in a tool argument still yields its chunk.
4. **Branch isolation** — two descendants of the same user entry become separate variants and never share sibling-only tool results.
5. **Compaction and branch summaries** — compaction retains direct provenance; an abandoned-branch summary remains session-scoped and cannot leak entities, constraints, traces, or ranking weight into the new branch.
6. **Tool pairing** — parallel calls/results are paired by ID regardless of completion order.
7. **Project isolation** — cwd values that collide under Pi's directory encoding, plus symlink/path aliases, return zero cross-project rows; a chunk cannot reference a session with a different `project_id` even through direct SQL.
8. **Current-turn exclusion** — `before_agent_start` returns no row from the entire current session without depending on an unavailable current user entry ID; explicit search still excludes the current open chunk.
9. **Incremental equivalence** — add, modify, delete, rename, old-mtime, same-size/same-mtime replacement, and interrupted-write scenarios produce the same logical index as a clean rebuild.
10. **Snapshot race** — appending or replacing a session between the two `fstat` calls never commits mismatched parsed rows and manifest metadata; repeated instability leaves the previous revision plus a dirty marker.
11. **Session entry forms** — message-role `bashExecution`, current `custom_message`, and migrated custom aliases are recognized without treating them as incorrect top-level types.
12. **Privacy** — fixture secrets and sensitive paths are absent from SQLite, search results, detail output, and hints.
13. **Ranking stability** — expected ordering and thresholds remain stable for the labeled fixture corpus.
14. **Branch limits** — excessive branch fan-out fails closed without sibling merging, partial publication, or loss of the prior indexed revision.
15. **Concurrent writers** — two processes reconciling old and new snapshots cannot let the older snapshot overwrite the newer manifest; stale lease recovery and crash rollback preserve the last committed index.

### End-to-end workflow

Given a project with relevant prior history, when the agent receives:

> 修改货期规则

the system should:

1. Return the available relevant chunks up to `maxResults`; it must not fabricate a requirement that 2–5 matches always exist.
2. Show involved files, constraints, rejected directions, failures, and direct source provenance.
3. Let `read_project_history` reconstruct the branch-safe exploration trace.
4. Lead the agent to verify the named current files first.
5. Allow bounded expansion when current imports, callers, tests, or moved code require it.
6. Reduce broad repository searches and unrelated file reads relative to a no-history baseline.

Success is measured by retrieval precision/recall, isolation tests, provenance completeness, and a reduction in broad exploration actions. It is **not** defined as forbidding every additional grep or adjacent-file read.
