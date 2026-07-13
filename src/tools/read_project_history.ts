import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { getIndexForCwd } from "../index/store.ts";
import { readChunkDetail } from "../retrieve/search.ts";
import { clip } from "../privacy.ts";

const DESCRIPTION = `Read one Conversation Chunk from this project's history index by chunkId.

Returns user prompt, assistant text, exploration trace steps, entities, constraints, and evidence.
History is EVIDENCE — verify against current code before modifying.
Does not return absolute session file paths.`;

const readParams = Type.Object({
  chunkId: Type.String({ description: "Chunk id from search_project_history", minLength: 8 }),
});

export function registerReadProjectHistory(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "read_project_history",
    label: "Read Project History",
    description: DESCRIPTION,
    promptSnippet: "Read full exploration trace for a history chunkId.",
    promptGuidelines: [
      "Call after search_project_history when you need the full tool/exploration sequence.",
      "Use the trace to locate files, then read those files from the working tree.",
      "Do not treat past tool results as current file contents.",
    ],
    parameters: readParams as never,
    async execute(_toolCallId, params, signal, _onUpdate, ctx: ExtensionContext) {
      if (signal?.aborted) throw new Error("aborted");
      const p = params as { chunkId: string };
      const index = getIndexForCwd(ctx.cwd);
      index.reconcile({ activeSessionId: ctx.sessionManager.getSessionId() });

      // Defense in depth: verify chunk belongs to current project (Design M3).
      const projectPrefix = index.project.projectId.substring(0, 8);
      if (!p.chunkId.startsWith(projectPrefix)) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Chunk ${p.chunkId} does not belong to this project. Re-run search_project_history.`,
            },
          ],
          details: { found: false, crossedProject: true },
        };
      }

      const detail = readChunkDetail(index, p.chunkId);
      if (!detail) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Chunk not found: ${p.chunkId}. Re-run search_project_history.`,
            },
          ],
          details: { found: false },
        };
      }

      const steps = (detail.traceSteps as Array<Record<string, unknown>>)
        .map((s, i) => {
          const st = String(s.status ?? "");
          const type = String(s.step_type ?? "");
          const target = String(s.target ?? "");
          const outcome = clip(String(s.outcome ?? ""), 180).replace(/\n/g, " ");
          return `  ${i + 1}. [${type}/${st}] ${target}${outcome ? ` → ${outcome}` : ""}`;
        })
        .join("\n");

      const entities = (detail.entities as Array<Record<string, unknown>>)
        .slice(0, 30)
        .map((e) => `  - ${e.entity_type}: ${e.value}`)
        .join("\n");

      const constraints = (detail.constraints as Array<Record<string, unknown>>)
        .map((c) => `  - (${c.trigger_word}) ${c.text}`)
        .join("\n");

      const text = [
        `Chunk ${detail.chunkId}  status=${detail.status}`,
        `tools: ${detail.toolCallCount} paired=${detail.pairedResultCount}`,
        "",
        "USER:",
        clip(detail.userText, 2000),
        "",
        "ASSISTANT:",
        clip(detail.assistantText, 3000),
        "",
        "EXPLORATION TRACE:",
        steps || "  (none)",
        "",
        "ENTITIES:",
        entities || "  (none)",
        "",
        "CONSTRAINTS:",
        constraints || "  (none)",
        "",
        "REMINDER: Verify current code before modifying. History is evidence, not fact.",
      ].join("\n");

      return {
        content: [{ type: "text" as const, text }],
        details: {
          found: true,
          chunkId: detail.chunkId,
          sessionId: detail.sessionId,
          startEntryId: detail.startEntryId,
          endEntryId: detail.endEntryId,
          rawEntryIds: detail.rawEntryIds,
        },
      };
    },
  });
}
