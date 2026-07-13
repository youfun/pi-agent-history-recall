# pi-agent-history-recall

Pi extension for **Project Conversation Retrieval**.

Session JSONL is the source of truth. SQLite is a disposable index.  
History is **evidence**, not fact — the agent must still verify current code.

## Goal

Reduce exploration cost when resuming work on a long-lived project:

1. Search prior sessions for related work  
2. Recover files, constraints, exclusions, and exploration traces  
3. Verify against the working tree  
4. Modify  

Not a long-term AI memory system. Not a second chat database.

## Install

```bash
pi install .
# or link this package into your Pi extensions path
```

## Tools

| Tool | Purpose |
|------|---------|
| `search_project_history` | Ranked Conversation Chunks (Relevance / Confidence / Freshness) |
| `read_project_history` | Full chunk: trace, entities, constraints |
| `history_search` | Alias of `search_project_history` |

## Command

```
/history-recall <query>
```

## Behavior (v1)

- **Project isolation**: only sessions whose `header.cwd` matches the current project  
- **Retrieval unit**: Conversation Chunk (user → assistant/tools → results)  
- **Search**: FTS5 BM25 + CJK n-grams + path/symbol boosts  
- **Ranking**: three axes — Relevance, Confidence, Freshness  
- **Exploration Trace**: read / grep / bash / edit / exclusion / verification steps  
- **before_agent_start**: optional one-line hint only (never injects full history as fact)  
- **Privacy**: redacts secrets; never returns absolute session file paths to the model  

## Index location

```
~/.pi/agent/history-recall/<project_id>.sqlite
```

Safe to delete — rebuilt from Session JSONL.

## Design

See [DESIGN.md](./DESIGN.md).

## Develop

```bash
bun install
bun test
bun run typecheck
```

## Non-goals

- Embedding / vector search (v2+)  
- Agent-written long-term memory  
- Cross-project reasoning  
- LLM summarization of all chats  
