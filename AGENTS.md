# Project-specific agent guidance

This file is optional. Add it only if you want local agent behavior
to include project history recall for this repo.

## History recall

This project may have prior work in Pi session history. If you want to
reduce repeated reads and cold-start context, use the registered tools:

- `search_project_history`
- `read_project_history`
- `history_search`

When to use:
- updating docs/commands/configuration
- tracing an earlier design decision
- resuming work after a gap
- avoiding full-repo grep for context you may have already explored

Workflow:
1. `search_project_history` with a short query
2. `read_project_history` for promising `chunkId`s
3. read/verify the current files in this repo
4. then make changes

Important:
- history is evidence, not fact
- always verify current code before modifying
- do not treat recalled sessions as the source of truth

If history recall is not desired for this repo, set enabled=false in
`.pi/history-recall.json` or remove this section from AGENTS.md.
