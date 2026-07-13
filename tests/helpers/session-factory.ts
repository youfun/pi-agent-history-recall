/**
 * Synthetic Pi Session JSONL builders for acceptance fixtures.
 * All fixtures are self-contained — no reads outside this project.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

let seq = 0;
function id(prefix = "e"): string {
  seq += 1;
  return `${prefix}-${seq.toString(16).padStart(8, "0")}-${Math.random().toString(16).slice(2, 10)}`;
}

export function resetIds(): void {
  seq = 0;
}

export interface BuiltSession {
  sessionId: string;
  path: string;
  headerCwd: string;
  entries: Record<string, unknown>[];
}

export function writeSession(
  dir: string,
  headerCwd: string,
  entries: Record<string, unknown>[],
  opts?: { sessionId?: string; filename?: string },
): BuiltSession {
  mkdirSync(dir, { recursive: true });
  const sessionId = opts?.sessionId ?? id("sess");
  const header = {
    type: "session",
    id: sessionId,
    cwd: headerCwd,
    timestamp: "2026-07-01T00:00:00.000Z",
    version: 3,
  };
  const filename =
    opts?.filename ??
    `2026-07-01T00-00-00-000Z_${sessionId}.jsonl`;
  const path = join(dir, filename);
  const lines = [JSON.stringify(header), ...entries.map((e) => JSON.stringify(e))];
  writeFileSync(path, lines.join("\n") + "\n", "utf8");
  return { sessionId, path, headerCwd, entries };
}

export function userMsg(parentId: string | null, text: string, entryId?: string) {
  const eid = entryId ?? id("user");
  return {
    type: "message",
    id: eid,
    parentId,
    timestamp: nextTs(),
    message: {
      role: "user",
      content: [{ type: "text", text }],
    },
  };
}

export function assistantText(parentId: string | null, text: string, entryId?: string) {
  const eid = entryId ?? id("asst");
  return {
    type: "message",
    id: eid,
    parentId,
    timestamp: nextTs(),
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
    },
  };
}

export function assistantWithTools(
  parentId: string | null,
  text: string,
  tools: Array<{ id: string; name: string; arguments: Record<string, unknown> }>,
  entryId?: string,
) {
  const eid = entryId ?? id("asst");
  return {
    type: "message",
    id: eid,
    parentId,
    timestamp: nextTs(),
    message: {
      role: "assistant",
      content: [
        { type: "text", text },
        ...tools.map((t) => ({
          type: "toolCall",
          id: t.id,
          name: t.name,
          arguments: t.arguments,
        })),
      ],
    },
  };
}

export function toolResult(
  parentId: string | null,
  toolCallId: string,
  toolName: string,
  text: string,
  isError = false,
  entryId?: string,
) {
  const eid = entryId ?? id("tres");
  return {
    type: "message",
    id: eid,
    parentId,
    timestamp: nextTs(),
    message: {
      role: "toolResult",
      toolCallId,
      toolName,
      isError,
      content: [{ type: "text", text }],
    },
  };
}

let ts = Date.parse("2026-07-01T00:00:00.000Z");
function nextTs(): string {
  ts += 1000;
  return new Date(ts).toISOString();
}

export function resetTs(iso = "2026-07-01T00:00:00.000Z"): void {
  ts = Date.parse(iso);
}

/** Linear session: user → tools → assistant final. */
export function linearDeliverySession(headerCwd: string, dir: string): BuiltSession {
  resetTs();
  const u = userMsg(null, "修改货期规则，佣金入口在销售单编辑页");
  const a1 = assistantWithTools(u.id as string, "Searching delivery rules. Because delivery date must not be earlier than order date.", [
    { id: "tc1", name: "grep", arguments: { pattern: "delivery_rule|货期", path: "src" } },
    { id: "tc2", name: "read", arguments: { path: "src/order/delivery_rule.ts" } },
  ]);
  const r1 = toolResult(a1.id as string, "tc1", "grep", "src/order/delivery_rule.ts: applyDeliveryDate");
  const r2 = toolResult(r1.id as string, "tc2", "read", "export function applyDeliveryDate() {}");
  const a2 = assistantWithTools(
    r2.id as string,
    "I ruled out inventory module because stock is unrelated.",
    [{ id: "tc3", name: "edit", arguments: { path: "src/order/delivery_rule.ts" } }],
  );
  const r3 = toolResult(a2.id as string, "tc3", "edit", "ok");
  const a3 = assistantWithTools(r3.id as string, "Running tests.", [
    { id: "tc4", name: "bash", arguments: { command: "bun test src/order/delivery_rule.test.ts" } },
  ]);
  const r4 = toolResult(a3.id as string, "tc4", "bash", "1 pass");
  return writeSession(dir, headerCwd, [u, a1, r1, r2, a2, r3, a3, r4]);
}

/** English auth session. */
export function linearAuthSession(headerCwd: string, dir: string): BuiltSession {
  resetTs("2026-07-02T00:00:00.000Z");
  const u = userMsg(null, "fix JWT token expiration on auth middleware");
  const a = assistantWithTools(u.id as string, "Looking at auth middleware JWT expiry.", [
    { id: "tc5", name: "grep", arguments: { pattern: "jwt|expiresIn", path: "src/auth" } },
  ]);
  const r = toolResult(a.id as string, "tc5", "grep", "src/auth/middleware.ts: expiresIn");
  return writeSession(dir, headerCwd, [u, a, r]);
}

/**
 * Branching session: shared prefix user U, then two sibling assistant variants.
 * Returns both leaf chains under one session file.
 */
export function branchedSession(headerCwd: string, dir: string): BuiltSession {
  resetTs("2026-07-03T00:00:00.000Z");
  const u = userMsg(null, "shared prefix question about DeliveryRule");
  // variant A
  const aA = assistantWithTools(u.id as string, "Variant A explores module A", [
    { id: "tA", name: "read", arguments: { path: "src/a.ts" } },
  ]);
  const rA = toolResult(aA.id as string, "tA", "read", "module A contents");
  // variant B (sibling: same parent as aA)
  const aB = assistantWithTools(u.id as string, "Variant B explores module B", [
    { id: "tB", name: "read", arguments: { path: "src/b.ts" } },
  ]);
  const rB = toolResult(aB.id as string, "tB", "read", "module B contents");
  return writeSession(dir, headerCwd, [u, aA, rA, aB, rB]);
}

/**
 * Session with many sibling variants under one user (for fail-closed).
 * Creates `variantCount` sibling assistant leaves under the same user entry.
 */
export function manyVariantsSession(
  headerCwd: string,
  dir: string,
  variantCount: number,
): BuiltSession {
  resetTs("2026-07-04T00:00:00.000Z");
  const u = userMsg(null, "explode variants for fail-closed test");
  const entries: Record<string, unknown>[] = [u];
  for (let i = 0; i < variantCount; i++) {
    const a = assistantText(u.id as string, `variant leaf ${i} unique-${i}-${createHash("sha256").update(String(i)).digest("hex").slice(0, 8)}`);
    entries.push(a);
  }
  return writeSession(dir, headerCwd, entries);
}

/** Foreign project session (different header.cwd). */
export function foreignSession(foreignCwd: string, dir: string): BuiltSession {
  resetTs("2026-07-05T00:00:00.000Z");
  const u = userMsg(null, "secret other project should never surface");
  return writeSession(dir, foreignCwd, [u], {
    filename: `foreign_${id("f")}.jsonl`,
  });
}

/** Session containing secrets that must be redacted. */
export function secretsSession(headerCwd: string, dir: string): BuiltSession {
  resetTs("2026-07-06T00:00:00.000Z");
  const u = userMsg(null, "rotate key sk-abcdefghijklmnopqrstuvwxyz123456 and password=supersecretvalue99");
  const a = assistantText(
    u.id as string,
    "Received Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.aa.bb and ghp_abcdefghijklmnopqrstuv",
  );
  return writeSession(dir, headerCwd, [u, a]);
}

/** Session with only tool-arg path (entity-only recall). */
export function entityOnlyPathSession(headerCwd: string, dir: string): BuiltSession {
  resetTs("2026-07-07T00:00:00.000Z");
  const u = userMsg(null, "please investigate the shipping calendar");
  const a = assistantWithTools(u.id as string, "opening file", [
    { id: "tcP", name: "read", arguments: { path: "src/shipping/calendar_rules.ts" } },
  ]);
  const r = toolResult(a.id as string, "tcP", "read", "export const calendar = 1");
  return writeSession(dir, headerCwd, [u, a, r]);
}
