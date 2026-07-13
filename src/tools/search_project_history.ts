import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { loadSettings } from "../config.ts";
import { getIndexForCwd } from "../index/store.ts";
import { formatSearchResults, searchProjectHistory } from "../retrieve/search.ts";
import {
  DEFAULT_MAX_RESULTS,
  DEFAULT_MIN_CONFIDENCE,
  DEFAULT_MIN_RELEVANCE,
  MAX_RESULTS,
  MAX_QUERY_CHARS,
} from "../types.ts";

const DESCRIPTION = `Search prior Pi sessions for this project only. Returns ranked Conversation Chunks with Relevance, Confidence, Freshness, files, symbols, constraints, and exclusions.

History is EVIDENCE, not fact. After recall you MUST verify current code before modifying.
Workflow: search_project_history → read_project_history → read current files → modify.
Does not search other projects. Does not invent absolute session paths.`;

const GUIDELINES = [
  "Call when the user asks about prior work, design decisions, business rules, or past failures in this project.",
  "Prefer this over re-grepping the entire repo when prior exploration may exist.",
  "Treat results as leads: always verify files against the working tree.",
  "Do not store or invent credentials found in history snippets.",
];

const searchParams = Type.Object({
  query: Type.String({
    description: "Natural language or keywords (supports CJK).",
    minLength: 1,
    maxLength: MAX_QUERY_CHARS,
  }),
  maxResults: Type.Optional(
    Type.Number({ minimum: 1, maximum: MAX_RESULTS, default: DEFAULT_MAX_RESULTS }),
  ),
  minRelevance: Type.Optional(
    Type.Number({ minimum: 0, maximum: 100, default: DEFAULT_MIN_RELEVANCE }),
  ),
  minConfidence: Type.Optional(
    Type.Number({ minimum: 0, maximum: 100, default: DEFAULT_MIN_CONFIDENCE }),
  ),
});

export function registerSearchProjectHistory(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "search_project_history",
    label: "Search Project History",
    description: DESCRIPTION,
    promptSnippet: "Search this project's past sessions for related exploration evidence.",
    promptGuidelines: GUIDELINES,
    parameters: searchParams as never,
    async execute(_toolCallId, params, signal, _onUpdate, ctx: ExtensionContext) {
      if (signal?.aborted) throw new Error("aborted");
      const p = params as {
        query: string;
        maxResults?: number;
        minRelevance?: number;
        minConfidence?: number;
      };
      const settings = loadSettings(ctx.cwd);
      if (!settings.enabled) {
        return {
          content: [
            {
              type: "text" as const,
              text: "history-recall is disabled (enabled=false). Enable via /history-recall settings or on.",
            },
          ],
          details: { results: [], diagnostics: "disabled" },
        };
      }

      const cwd = ctx.cwd;
      const index = getIndexForCwd(cwd);
      index.reconcile({ activeSessionId: ctx.sessionManager.getSessionId() });

      const results = searchProjectHistory(index, {
        query: p.query,
        project: index.project,
        maxResults: p.maxResults,
        minRelevance: p.minRelevance ?? settings.minRelevance,
        minConfidence: p.minConfidence ?? settings.minConfidence,
        freshnessHighDays: settings.freshnessHighDays,
        freshnessMediumDays: settings.freshnessMediumDays,
        excludeOpen: true,
      });

      if (results.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No project history matches for ${JSON.stringify(p.query)} (project-scoped). History is evidence — if empty, explore the code directly.`,
            },
          ],
          details: { results: [], diagnostics: "empty" },
        };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: formatSearchResults(results),
          },
        ],
        details: { results },
      };
    },
  });
}

export function registerHistorySearchAlias(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "history_search",
    label: "History Search (alias)",
    description: "Alias for search_project_history. Prefer search_project_history.",
    promptSnippet: "Alias of search_project_history.",
    promptGuidelines: GUIDELINES,
    parameters: searchParams as never,
    async execute(_toolCallId, params, signal, _onUpdate, ctx: ExtensionContext) {
      if (signal?.aborted) throw new Error("aborted");
      const p = params as {
        query: string;
        maxResults?: number;
        minRelevance?: number;
        minConfidence?: number;
      };
      const settings = loadSettings(ctx.cwd);
      if (!settings.enabled) {
        return {
          content: [
            {
              type: "text" as const,
              text: "history-recall is disabled (enabled=false).",
            },
          ],
          details: { results: [], aliasOf: "search_project_history", diagnostics: "disabled" },
        };
      }
      const index = getIndexForCwd(ctx.cwd);
      index.reconcile({ activeSessionId: ctx.sessionManager.getSessionId() });
      const results = searchProjectHistory(index, {
        query: p.query,
        project: index.project,
        maxResults: p.maxResults,
        minRelevance: p.minRelevance ?? settings.minRelevance,
        minConfidence: p.minConfidence ?? settings.minConfidence,
        freshnessHighDays: settings.freshnessHighDays,
        freshnessMediumDays: settings.freshnessMediumDays,
        excludeOpen: true,
      });
      return {
        content: [
          {
            type: "text" as const,
            text:
              results.length === 0
                ? `No matches for ${JSON.stringify(p.query)}.`
                : formatSearchResults(results),
          },
        ],
        details: { results, aliasOf: "search_project_history" },
      };
    },
  });
}
