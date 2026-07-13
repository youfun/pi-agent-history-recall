# pi-agent-history-recall

Pi extension for **Project Conversation Retrieval**.

It recovers prior work from **Pi Session JSONL** so the agent spends less time re-grepping, re-reading, and re-deriving design intent on long-lived projects.

```text
Session JSONL  →  disposable SQLite index  →  search / read tools
     (source of truth)        (rebuildable)         (evidence, not fact)
```

**History is evidence, not fact.**  
After recall, the agent must still verify current code before modifying anything.

Not a long-term AI memory product. Not a second chat database. Not a knowledge base of user preferences.

---

## Goal

Reduce **exploration cost**, not context tokens.

When the user says something like:

> 修改货期规则

the agent should be able to:

1. Search this project’s prior sessions  
2. Recover related files, symbols, constraints, exclusions, and exploration traces  
3. Read and verify those files in the working tree  
4. Modify only after verification  

Ideal outcome: fewer full-repo greps and fewer cold restarts of the mental model.

---

## Install

From this package directory:

```bash
pi install .
```

Or link / register the package so Pi loads:

```json
"pi": {
  "extensions": ["./src/index.ts"]
}
```

Requirements:

- [Pi coding agent](https://github.com/badlogic/pi-mono) (uses `@earendil-works/pi-coding-agent`)
- Bun or Node with SQLite (FTS5)
- Existing Pi sessions under `~/.pi/agent/sessions/`

---

## Tools

| Tool | Purpose |
|------|---------|
| `search_project_history` | Ranked **Conversation Chunks** for the current project |
| `read_project_history` | Full chunk: user text, assistant text, exploration trace, entities, constraints |
| `history_search` | Alias of `search_project_history` |

### `search_project_history`

```ts
{
  query: string;           // natural language or keywords (CJK supported)
  maxResults?: number;     // default 5, max 20
  minRelevance?: number;   // default 40
  minConfidence?: number;  // default 30
}
```

Each result includes:

| Field | Meaning |
|-------|---------|
| **Relevance** | Lexical / entity match strength (0–100) |
| **Confidence** | How trustworthy the evidence looks (trace completeness, pairing, etc.) |
| **Freshness** | `High` / `Medium` / `Low` by chunk age |
| files / symbols | Extracted paths and identifiers |
| constraints / exclusions | Conservative rule-like sentences and “ruled out …” steps |
| `chunkId` | Pass to `read_project_history` |
| sibling variants | Other branch variants of the same user turn (not merged) |

### `read_project_history`

```ts
{
  chunkId: string;
}
```

Returns the full exploration path for one chunk: tool sequence, entities, constraints, and provenance entry ids.  
Does **not** return absolute session file paths to the model.

### Recommended agent workflow

```text
search_project_history
        ↓
read_project_history (for promising chunkIds)
        ↓
read / verify current files in the working tree
        ↓
modify
```

Tool prompts encode: **do not treat history as current truth**.

---

## Command

```text
/history-recall <query>
/history-recall settings
/history-recall status
/history-recall rebuild
/history-recall clear
/history-recall on | off
/history-recall help
```

| Subcommand | Purpose |
|------------|---------|
| `<query>` | Search this project's history |
| `settings` | Interactive TUI settings overlay (like pi-context-prune) |
| `status` | Settings + index path + diagnostics |
| `rebuild` | Delete disposable SQLite index and reindex sessions |
| `clear` | Delete disposable SQLite index only (Session JSONL untouched) |
| `on` / `off` | Enable/disable via user settings |
| bare `/history-recall` | Subcommand picker |

Examples:

```text
/history-recall 货期规则
/history-recall JWT token expiration
/history-recall settings
/history-recall status
```

---

## Behavior (v1)

| Area | Behavior |
|------|----------|
| **Data source** | Pi Session JSONL only |
| **Index** | SQLite + FTS5, disposable and rebuildable |
| **Project isolation** | `canonical_cwd = NFC(realpath(cwd))`, `project_id = SHA-256(canonical_cwd)`; session `header.cwd` must match |
| **Retrieval unit** | Conversation Chunk (user → assistant/tools → results on one branch path) |
| **Branches** | Sibling variants are never merged; over-limit builds **fail closed** and keep the prior revision |
| **Search** | Dual FTS (Latin + CJK n-grams), path/symbol/error boosts |
| **Ranking** | Three axes: Relevance, Confidence, Freshness |
| **Exploration trace** | read / grep / find / list / bash / edit / write / error / exclusion / verification |
| **Auto hint** | `before_agent_start` may inject a **one-line** hint only when scores are high; never full history |
| **Privacy** | Secret redaction; sensitive paths filtered; no absolute session paths in tool output |
| **Concurrency** | Filesystem writer lease so two Pi processes cannot let an old snapshot overwrite a newer index |

---

## Index location

Preferred (when the project directory is writable):

```text
{project}/.pi/history-recall.sqlite
```

Fallback:

```text
~/.pi/agent/history-recall/<project_id>.sqlite
```

Related files (also disposable):

```text
*.sqlite-wal
*.sqlite-shm
*.sqlite.lock
```

Safe to delete at any time. The next reconcile rebuilds from Session JSONL.  
**Never** delete session JSONL as a substitute for clearing the index.

Sessions are discovered under:

```text
~/.pi/agent/sessions/--<encoded-cwd>--/
```

Encoding follows Pi’s session directory rules. Directory name is only a discovery hint; **header.cwd** is the real isolation gate.

---

## Settings (optional)

Settings merge order (later wins):

1. Built-in defaults  
2. User: `~/.pi/agent/history-recall/settings.json`  
3. Project: `{cwd}/.pi/history-recall.json`  

Example project file:

```json
{
  "enabled": true,
  "hintsEnabled": true,
  "minRelevance": 40,
  "minConfidence": 30,
  "hintMinRelevance": 80,
  "hintMinConfidence": 70,
  "freshnessHighDays": 7,
  "freshnessMediumDays": 30
}
```

| Key | Meaning |
|-----|---------|
| `enabled` | Master switch for this scope |
| `hintsEnabled` | Allow one-line `before_agent_start` hints |
| `minRelevance` / `minConfidence` | Default search thresholds |
| `hintMin*` | Thresholds for auto hints |
| `freshnessHighDays` / `freshnessMediumDays` | Freshness buckets |

`enabled: false` in the **project** file is the intended opt-out for that repo.

---

## Architecture (short)

```text
Pi Session JSONL
      │
      ▼
 session/ingest     tree + header.cwd isolation + dual-fstat snapshot
      │
      ▼
 chunk/builder      branch-safe Conversation Chunks (+ fail-closed limits)
      │
      ├─ extract/*  entities, constraints, exploration trace, CJK grams
      ▼
 index/store        SQLite schema, dual FTS, writer lease, incremental fingerprint
      │
      ▼
 retrieve/*         BM25 + boosts → Relevance / Confidence / Freshness
      │
      ▼
 tools + /history-recall + optional before_agent_start hint
```

Deep design, acceptance criteria, and non-goals: **[DESIGN.md](./DESIGN.md)**.

---

## Develop

```bash
bun install
bun test          # acceptance matrix + unit tests
bun run typecheck
```

Layout:

```text
src/
  index.ts              # extension entry
  config.ts             # settings load/save
  project.ts            # project identity + index paths
  privacy.ts            # redaction / path display
  session/ingest.ts     # JSONL parse + session discovery
  chunk/builder.ts      # Conversation Chunk construction
  extract/              # CJK, entities, constraints, exploration
  index/                # schema, store, FTS, lease, db adapter
  retrieve/             # search + ranking
  tools/                # search / read tools
tests/                  # fixtures + acceptance matrix
DESIGN.md               # full specification
```

---

## Privacy & safety

- Redacts common API keys, tokens, PEM blocks, and credential-like assignments  
- Skips sensitive path names (e.g. `.env`, `credentials.json`, private keys)  
- Tool output uses project-relative paths where possible  
- Does not invent absolute `~/.pi/agent/sessions/...` paths for the model  
- Extension-generated hints must not become the primary retrieval corpus (see DESIGN; keep index free of self-hint loops)

---

## Non-goals (v1)

- Embedding / vector search  
- Knowledge graphs  
- Cross-project reasoning  
- Agent-written long-term memory (`learn` / consolidate)  
- Summarizing all chats into a knowledge base  
- Auto-learning user preferences  
- Replacing verification with recalled history  

---

## Inspiration (boundaries)

| Project | Relationship |
|---------|----------------|
| **cog-cli** | Long-term agent memory — **different goal**. We retrieve project sessions; we do not learn engrams. |
| **pi-context-prune** | Same-session context compression — useful engineering patterns (batch capture, tools). We index **project-wide** history, not only the live context window. |

Reference checkouts may live under `vendor/` (gitignored).

---

## License

MIT
