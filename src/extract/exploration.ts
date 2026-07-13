import { clip, isSensitivePath, redactText, safeArgsJson } from "../privacy.ts";
import type {
  ContentPart,
  ExtractedConstraint,
  ExtractedEntity,
  MessagePayload,
  RawSessionEntry,
  TraceStatus,
  TraceStep,
  TraceStepType,
} from "../types.ts";
import { MAX_OUTCOME } from "../types.ts";
import {
  entityFromPathArg,
  extractErrorEntities,
  extractPathEntities,
  extractSymbolEntities,
} from "./entities.ts";
import { extractConstraints } from "./constraints.ts";

export interface ExtractionBundle {
  entities: ExtractedEntity[];
  constraints: ExtractedConstraint[];
  traceSteps: TraceStep[];
  assistantText: string;
  userText: string;
  toolCallCount: number;
  pairedResultCount: number;
}

interface PairedTool {
  callEntryId: string;
  resultEntryId: string | null;
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  resultText: string;
  isError: boolean;
  callOrdinal: number;
}

export function extractFromChunkPath(
  entries: RawSessionEntry[],
  canonicalCwd: string,
): ExtractionBundle {
  const entities: ExtractedEntity[] = [];
  const constraints: ExtractedConstraint[] = [];
  const traceSteps: TraceStep[] = [];
  let assistantText = "";
  let userText = "";
  let toolCallCount = 0;
  let pairedResultCount = 0;

  const callsById = new Map<string, PairedTool>();
  const orderedCalls: PairedTool[] = [];

  let ordinal = 0;
  for (const entry of entries) {
    ordinal += 1;
    if (entry.type !== "message") continue;
    const msg = entry.message as MessagePayload | undefined;
    if (!msg) continue;

    if (msg.role === "user") {
      userText = visibleText(msg);
      continue;
    }

    if (msg.role === "assistant") {
      const text = visibleText(msg);
      if (text) {
        assistantText = assistantText ? `${assistantText}\n${text}` : text;
        entities.push(
          ...extractPathEntities(text, entry.id, canonicalCwd, 0.55),
          ...extractSymbolEntities(text, entry.id, canonicalCwd, 0.5),
        );
        constraints.push(...extractConstraints(text, entry.id));
        for (const excl of extractExclusions(text, entry.id, canonicalCwd)) {
          traceSteps.push(excl);
        }
      }
      for (const part of contentParts(msg)) {
        if (part.type !== "toolCall" || !part.id || !part.name) continue;
        toolCallCount += 1;
        const args =
          part.arguments && typeof part.arguments === "object" && !Array.isArray(part.arguments)
            ? (part.arguments as Record<string, unknown>)
            : {};
        const paired: PairedTool = {
          callEntryId: entry.id,
          resultEntryId: null,
          toolCallId: part.id,
          toolName: part.name,
          args,
          resultText: "",
          isError: false,
          callOrdinal: ordinal,
        };
        callsById.set(part.id, paired);
        orderedCalls.push(paired);
      }
      continue;
    }

    if (msg.role === "toolResult") {
      const toolCallId = String(msg.toolCallId ?? findToolCallId(msg) ?? "");
      if (!toolCallId) continue;
      const text = visibleText(msg);
      const isError = Boolean(msg.isError);
      const existing = callsById.get(toolCallId);
      if (existing) {
        existing.resultEntryId = entry.id;
        existing.resultText = text;
        existing.isError = isError;
        pairedResultCount += 1;
      }
      if (isError || /error|fail|exception/i.test(text)) {
        entities.push(...extractErrorEntities(text, entry.id, canonicalCwd, 0.85));
      }
      entities.push(
        ...extractPathEntities(text, entry.id, canonicalCwd, 0.4),
        ...extractSymbolEntities(text, entry.id, canonicalCwd, 0.35),
      );
    }
  }

  let stepOrder = 0;
  for (const call of orderedCalls) {
    stepOrder += 1;
    const parsed = classifyTool(call.toolName, call.args, call.resultText, call.isError, canonicalCwd);
    for (const ent of parsed.entities) {
      entities.push({ ...ent, sourceEntryId: call.callEntryId });
    }
    const status: TraceStatus = call.isError
      ? "error"
      : call.resultEntryId
        ? "success"
        : "unknown";
    traceSteps.push({
      sourceEntryId: call.callEntryId,
      resultEntryId: call.resultEntryId,
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      argumentsJson: safeArgsJson(call.args),
      stepType: call.isError && parsed.stepType !== "error" ? parsed.stepType : parsed.stepType,
      target: parsed.target,
      normalizedTarget: parsed.normalizedTarget,
      outcome: clip(redactText(call.resultText, MAX_OUTCOME), MAX_OUTCOME),
      status: call.isError ? "error" : status,
      stepOrder,
    });
    if (call.isError) {
      stepOrder += 1;
      traceSteps.push({
        sourceEntryId: call.resultEntryId ?? call.callEntryId,
        resultEntryId: call.resultEntryId,
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        argumentsJson: null,
        stepType: "error",
        target: parsed.target,
        normalizedTarget: parsed.normalizedTarget,
        outcome: clip(redactText(call.resultText, MAX_OUTCOME), MAX_OUTCOME),
        status: "error",
        stepOrder,
      });
    }
  }

  return {
    entities: dedupeEntities(entities),
    constraints: dedupeConstraints(constraints),
    traceSteps,
    assistantText: redactText(assistantText),
    userText: redactText(userText),
    toolCallCount,
    pairedResultCount,
  };
}

function classifyTool(
  toolName: string,
  args: Record<string, unknown>,
  resultText: string,
  isError: boolean,
  canonicalCwd: string,
): {
  stepType: TraceStepType;
  target: string;
  normalizedTarget: string;
  entities: ExtractedEntity[];
} {
  const name = toolName.toLowerCase();
  const entities: ExtractedEntity[] = [];
  const pathArg = firstString(args, ["path", "filePath", "file", "filename", "target"]);
  const pattern = firstString(args, ["pattern", "query", "glob", "regex"]);
  const command = firstString(args, ["command", "cmd"]);

  if (name === "read") {
    const p = pathArg ?? "";
    const ent = entityFromPathArg(p, "", canonicalCwd);
    if (ent) entities.push(ent);
    const target = ent?.value || p || "read";
    return {
      stepType: "read",
      target,
      normalizedTarget: target.toLowerCase(),
      entities,
    };
  }
  if (name === "grep") {
    const target = [pattern, pathArg].filter(Boolean).join(" in ") || "grep";
    if (pathArg) {
      const ent = entityFromPathArg(pathArg, "", canonicalCwd);
      if (ent) entities.push(ent);
    }
    if (pattern) entities.push(...extractSymbolEntities(pattern, "", canonicalCwd, 0.7));
    return { stepType: "grep", target, normalizedTarget: target.toLowerCase(), entities };
  }
  if (name === "find") {
    const target = [pattern, pathArg].filter(Boolean).join(" in ") || "find";
    if (pathArg) {
      const ent = entityFromPathArg(pathArg, "", canonicalCwd);
      if (ent) entities.push(ent);
    }
    return { stepType: "find", target, normalizedTarget: target.toLowerCase(), entities };
  }
  if (name === "ls") {
    const target = pathArg || ".";
    const ent = entityFromPathArg(target, "", canonicalCwd);
    if (ent) entities.push(ent);
    return {
      stepType: "list",
      target: ent?.value || target,
      normalizedTarget: (ent?.value || target).toLowerCase(),
      entities,
    };
  }
  if (name === "edit") {
    const p = pathArg ?? "";
    const ent = entityFromPathArg(p, "", canonicalCwd);
    if (ent) entities.push(ent);
    return {
      stepType: "edit",
      target: ent?.value || p || "edit",
      normalizedTarget: (ent?.value || p || "edit").toLowerCase(),
      entities,
    };
  }
  if (name === "write") {
    const p = pathArg ?? "";
    const ent = entityFromPathArg(p, "", canonicalCwd);
    if (ent) entities.push(ent);
    return {
      stepType: "write",
      target: ent?.value || p || "write",
      normalizedTarget: (ent?.value || p || "write").toLowerCase(),
      entities,
    };
  }
  if (name === "bash" || name === "shell") {
    const cmd = command || "";
    const kind = classifyBash(cmd);
    entities.push(...extractPathEntities(cmd, "", canonicalCwd, 0.8));
    entities.push(...extractSymbolEntities(cmd, "", canonicalCwd, 0.5));
    const target = clip(cmd, 240) || "bash";
    return {
      stepType: kind,
      target,
      normalizedTarget: target.toLowerCase(),
      entities,
    };
  }

  // Unknown tools: keep generic trace + path-like fields.
  for (const [k, v] of Object.entries(args)) {
    if (typeof v === "string" && (k.toLowerCase().includes("path") || v.includes("/"))) {
      if (!isSensitivePath(v)) {
        const ent = entityFromPathArg(v, "", canonicalCwd);
        if (ent) entities.push(ent);
      }
    }
  }
  const target = pathArg || pattern || toolName;
  return {
    stepType: isError ? "error" : "tool",
    target: String(target),
    normalizedTarget: String(target).toLowerCase(),
    entities,
  };
}

function classifyBash(cmd: string): TraceStepType {
  const c = cmd.trim();
  if (/^(rg|grep|egrep|fgrep)\b/.test(c) || /\b(rg|grep)\b/.test(c)) return "grep";
  if (/^find\b/.test(c)) return "find";
  if (/^(ls|tree)\b/.test(c)) return "list";
  if (/\b(test|pytest|vitest|jest|mix test|cargo test|go test|bun test)\b/.test(c)) {
    return "verification";
  }
  return "bash";
}

function extractExclusions(
  text: string,
  sourceEntryId: string,
  canonicalCwd: string,
): TraceStep[] {
  const steps: TraceStep[] = [];
  const patterns = [
    /I (?:ruled out|excluded|skipped)\s+([^\n.]{3,80})(?:\s+because\s+([^\n.]{3,120}))?/gi,
    /(?:问题不在|排除了|不是)\s*([^\n。，,]{2,40})(?:[，,]?\s*(?:因为|由于)\s*([^\n。]{2,80}))?/g,
  ];
  let order = 10_000;
  for (const re of patterns) {
    for (const m of text.matchAll(re)) {
      const target = (m[1] || "").trim();
      if (!target) continue;
      const reason = (m[2] || "").trim();
      steps.push({
        sourceEntryId,
        resultEntryId: null,
        toolCallId: null,
        toolName: null,
        argumentsJson: null,
        stepType: "exclusion",
        target,
        normalizedTarget: target.toLowerCase(),
        outcome: reason ? redactText(reason, MAX_OUTCOME) : m[0]!,
        status: "unknown",
        stepOrder: order++,
      });
    }
  }
  return steps;
}

function visibleText(msg: MessagePayload): string {
  const c = msg.content;
  if (typeof c === "string") return c;
  if (!Array.isArray(c)) return "";
  const parts: string[] = [];
  for (const p of c as ContentPart[]) {
    if (!p || typeof p !== "object") continue;
    if (p.type === "text" && typeof p.text === "string") parts.push(p.text);
    // thinking intentionally excluded by default
    if (p.type === "toolResult" || p.type === "image") {
      if (typeof p.text === "string") parts.push(p.text);
    }
  }
  return parts.join("\n");
}

function contentParts(msg: MessagePayload): ContentPart[] {
  return Array.isArray(msg.content) ? (msg.content as ContentPart[]) : [];
}

function findToolCallId(msg: MessagePayload): string | undefined {
  if (msg.toolCallId) return msg.toolCallId;
  for (const p of contentParts(msg)) {
    if (p.toolCallId) return p.toolCallId;
  }
  return undefined;
}

function firstString(args: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = args[k];
    if (typeof v === "string" && v.trim()) return v;
  }
  // case-insensitive fallback
  const lower = new Map(Object.keys(args).map((k) => [k.toLowerCase(), k]));
  for (const k of keys) {
    const real = lower.get(k.toLowerCase());
    if (!real) continue;
    const v = args[real];
    if (typeof v === "string" && v.trim()) return v;
  }
  return undefined;
}

function dedupeEntities(list: ExtractedEntity[]): ExtractedEntity[] {
  const map = new Map<string, ExtractedEntity>();
  for (const e of list) {
    const key = `${e.entityType}|${e.normalizedValue}|${e.sourceEntryId}`;
    const prev = map.get(key);
    if (!prev || e.confidence > prev.confidence) map.set(key, e);
  }
  return [...map.values()];
}

function dedupeConstraints(list: ExtractedConstraint[]): ExtractedConstraint[] {
  const map = new Map<string, ExtractedConstraint>();
  for (const c of list) {
    const key = `${c.normalizedText}|${c.sourceEntryId}`;
    if (!map.has(key)) map.set(key, c);
  }
  return [...map.values()];
}
