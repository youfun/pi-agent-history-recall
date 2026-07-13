/**
 * pi-agent-history-recall
 *
 * Project Conversation Retrieval from Pi Session JSONL.
 * Index is disposable SQLite; Session is Source of Truth.
 * History is evidence — not fact.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerHistoryRecallCommand } from "./commands.ts";
import { loadSettings } from "./config.ts";
import { getIndexForCwd } from "./index/store.ts";
import { searchProjectHistory } from "./retrieve/search.ts";
import {
  registerHistorySearchAlias,
  registerSearchProjectHistory,
} from "./tools/search_project_history.ts";
import { registerReadProjectHistory } from "./tools/read_project_history.ts";
import { EXTENSION_MARKER } from "./types.ts";

export default function (pi: ExtensionAPI) {
  registerSearchProjectHistory(pi);
  registerReadProjectHistory(pi);
  registerHistorySearchAlias(pi);
  registerHistoryRecallCommand(pi);

  // Lightweight hint only — never inject full history as fact.
  pi.on("before_agent_start", async (event, ctx) => {
    try {
      const settings = loadSettings(ctx.cwd);
      if (!settings.enabled || !settings.hintsEnabled) return;

      const prompt = (event.prompt ?? "").trim();
      if (!prompt || prompt.length < 4) return;

      const index = getIndexForCwd(ctx.cwd);
      const sessionId = ctx.sessionManager.getSessionId();
      index.reconcile({ activeSessionId: sessionId });

      const results = searchProjectHistory(index, {
        query: prompt,
        project: index.project,
        maxResults: 1,
        minRelevance: settings.hintMinRelevance,
        minConfidence: settings.hintMinConfidence,
        freshnessHighDays: settings.freshnessHighDays,
        freshnessMediumDays: settings.freshnessMediumDays,
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
