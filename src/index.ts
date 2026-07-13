/**
 * pi-agent-history-recall
 *
 * Project Conversation Retrieval from Pi Session JSONL.
 * Index is disposable SQLite; Session is Source of Truth.
 * History is evidence — not fact.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getIndexForCwd } from "./index/store.ts";
import { searchProjectHistory } from "./retrieve/search.ts";
import {
  registerHistorySearchAlias,
  registerSearchProjectHistory,
} from "./tools/search_project_history.ts";
import { registerReadProjectHistory } from "./tools/read_project_history.ts";
import {
  EXTENSION_MARKER,
  HINT_MIN_CONFIDENCE,
  HINT_MIN_RELEVANCE,
} from "./types.ts";

export default function (pi: ExtensionAPI) {
  registerSearchProjectHistory(pi);
  registerReadProjectHistory(pi);
  registerHistorySearchAlias(pi);

  pi.registerCommand("history-recall", {
    description:
      "Search this project's session history (evidence, not fact). Usage: /history-recall <query>",
    getArgumentCompletions: () => null,
    handler: async (args, ctx) => {
      const query = (args ?? "").trim();
      if (!query) {
        ctx.ui.notify(
          "Usage: /history-recall <query>\nTools: search_project_history, read_project_history",
          "info",
        );
        return;
      }
      try {
        const index = getIndexForCwd(ctx.cwd);
        const recon = index.reconcile({
          activeSessionId: ctx.sessionManager.getSessionId(),
        });
        const results = searchProjectHistory(index, {
          query,
          project: index.project,
          maxResults: 5,
          excludeOpen: true,
        });
        if (results.length === 0) {
          ctx.ui.notify(
            `No history matches for "${query}" (sessions indexed: ${recon.diagnostics.indexedSessions}).`,
            "info",
          );
          return;
        }
        const text = results
          .map(
            (r, i) =>
              `${i + 1}. R:${r.relevance} C:${r.confidence} F:${r.freshness}  ${r.chunkId.slice(0, 8)}…\n` +
              `   ${r.userText.slice(0, 120).replace(/\n/g, " ")}\n` +
              (r.files.length ? `   files: ${r.files.slice(0, 5).join(", ")}\n` : ""),
          )
          .join("\n");
        ctx.ui.notify(text, "info");
      } catch (err) {
        ctx.ui.notify(
          `history-recall failed: ${err instanceof Error ? err.message : String(err)}`,
          "error",
        );
      }
    },
  });

  // Lightweight hint only — never inject full history as fact.
  pi.on("before_agent_start", async (event, ctx) => {
    try {
      const prompt = (event.prompt ?? "").trim();
      if (!prompt || prompt.length < 4) return;

      const index = getIndexForCwd(ctx.cwd);
      const sessionId = ctx.sessionManager.getSessionId();
      index.reconcile({ activeSessionId: sessionId });

      const results = searchProjectHistory(index, {
        query: prompt,
        project: index.project,
        maxResults: 1,
        minRelevance: HINT_MIN_RELEVANCE,
        minConfidence: HINT_MIN_CONFIDENCE,
        excludeSessionId: sessionId,
        excludeOpen: true,
      });
      if (results.length === 0) return;

      const top = results[0]!;
      const files = top.files.slice(0, 4).join(", ");
      const hint =
        `[History hint] Prior work may relate (R:${top.relevance} C:${top.confidence} F:${top.freshness}).` +
        (files ? ` files: ${files}.` : "") +
        ` Use search_project_history / read_project_history — verify current code. chunkId=${top.chunkId}`;

      return {
        message: {
          customType: EXTENSION_MARKER,
          content: hint,
          display: true,
        },
      };
    } catch {
      // Never block the agent on history failures.
      return;
    }
  });
}
