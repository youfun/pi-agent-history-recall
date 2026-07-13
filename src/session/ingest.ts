import { createHash } from "node:crypto";
import { openSync, readSync, closeSync, fstatSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { canonicalizeCwd, sameProject } from "../project.ts";
import type {
  ParsedSessionHeader,
  RawSessionEntry,
  SessionSnapshot,
} from "../types.ts";

const MAX_SESSION_BYTES = 50 * 1024 * 1024;
const MAX_SNAPSHOT_RETRIES = 3;

export interface ListSessionFile {
  path: string;
  mtimeMs: number;
  mtimeNs: string;
  sizeBytes: number;
}

/** List *.jsonl under a sessions project directory. */
export function listSessionFiles(sessionDir: string): ListSessionFile[] {
  let names: string[];
  try {
    names = readdirSync(sessionDir);
  } catch {
    return [];
  }
  const out: ListSessionFile[] = [];
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    const path = join(sessionDir, name);
    try {
      const st = statSync(path);
      if (!st.isFile()) continue;
      out.push({
        path,
        mtimeMs: st.mtimeMs,
        mtimeNs: mtimeNs(st),
        sizeBytes: st.size,
      });
    } catch {
      // skip unreadable
    }
  }
  return out;
}

/**
 * Encode cwd the way Pi does for session directory names.
 * Mirrors getDefaultSessionDirPath:
 *   `--${resolvedCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`
 */
export function encodeSessionDirName(cwd: string): string {
  const resolved = canonicalizeCwd(cwd);
  return `--${resolved.replace(/^[\/\\]/, "").replace(/[\/\\:]/g, "-")}--`;
}

export function defaultSessionsRoot(agentDir?: string): string {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  const base = agentDir ?? `${home}/.pi/agent`;
  return join(base, "sessions");
}

export function projectSessionDir(cwd: string, agentDir?: string): string {
  return join(defaultSessionsRoot(agentDir), encodeSessionDirName(cwd));
}

export function fingerprintSession(meta: {
  sourcePath: string;
  mtimeNs: string;
  sizeBytes: number;
}): string {
  return createHash("sha256")
    .update(`${meta.sourcePath}|${meta.mtimeNs}|${meta.sizeBytes}`, "utf8")
    .digest("hex");
}

/**
 * Parse a session file for a known project using a stable-snapshot protocol
 * (Design H4):
 *   1. Open and fstat the file.
 *   2. Read the exact byte range determined by the initial fstat.
 *   3. fstat again after reading.
 *   4. If the file changed while reading, retry up to MAX_SNAPSHOT_RETRIES times.
 *   5. If still unstable, return null (caller retains the previously indexed revision).
 */
export function parseSessionFile(
  sourcePath: string,
  projectCanonicalCwd: string,
  opts?: { isActive?: boolean },
): SessionSnapshot | null {
  let retries = 0;

  while (retries < MAX_SNAPSHOT_RETRIES) {
    let fd: number;
    try {
      fd = openSync(sourcePath, "r");
    } catch {
      return null;
    }

    try {
      const stBefore = fstatSync(fd);
      if (stBefore.size <= 0) return null;
      if (stBefore.size > MAX_SESSION_BYTES) {
        // Oversized sessions: still try first 50MB.
      }

      const readSize = Math.min(stBefore.size, MAX_SESSION_BYTES);
      const buf = Buffer.alloc(readSize);
      readSync(fd, buf, 0, readSize, 0);

      const stAfter = fstatSync(fd);

      // Check if size or mtime changed during read.
      const changed =
        stAfter.size !== stBefore.size ||
        Number(mtimeNs(stAfter)) !== Number(mtimeNs(stBefore));

      if (changed && !opts?.isActive) {
        retries++;
        continue; // retry
      }
      // For active sessions, minor append-only growth is acceptable.
      // Non-active sessions must be stable.

      const mtime = mtimeNs(stBefore);
      const text = buf.toString("utf8");
      const lines = text.split("\n");

      let incompleteTrailing = false;
      if (text.length > 0 && !text.endsWith("\n") && lines.length > 0) {
        lines.pop();
        incompleteTrailing = true;
      }

      const entries: RawSessionEntry[] = [];
      let header: ParsedSessionHeader | null = null;
      let formatVersion = 0;
      let malformed = 0;

      for (const line of lines) {
        if (!line.trim()) continue;
        let obj: Record<string, unknown>;
        try {
          obj = JSON.parse(line) as Record<string, unknown>;
        } catch {
          malformed += 1;
          incompleteTrailing = true;
          continue;
        }
        if (!obj || typeof obj !== "object") {
          malformed += 1;
          continue;
        }
        const type = String(obj.type ?? "");
        if (type === "session") {
          const cwd = String(obj.cwd ?? "");
          if (!cwd || !sameProject(cwd, projectCanonicalCwd)) {
            return null;
          }
          header = {
            id: String(obj.id ?? ""),
            cwd,
            timestamp: typeof obj.timestamp === "string" ? obj.timestamp : undefined,
            version: typeof obj.version === "number" ? obj.version : undefined,
          };
          formatVersion = header.version ?? 0;
          continue;
        }
        if (!header) {
          return null;
        }
        if (!obj.id || typeof obj.id !== "string") {
          malformed += 1;
          continue;
        }
        entries.push(obj as RawSessionEntry);
      }

      if (!header || !header.id) return null;
      if (malformed > 0 && entries.length === 0) return null;

      let sourceIdentity: string | null = null;
      for (const e of entries) {
        if (e.type === "custom" || e.type === "custom_message") {
          const data = (e as { customType?: string; data?: { source?: string } }).data;
          const customType = (e as { customType?: string }).customType;
          if (customType && data?.source) {
            sourceIdentity = `${customType}:${data.source}`;
            break;
          }
        }
      }

      return {
        sourcePath,
        sessionId: header.id,
        headerCwd: canonicalizeCwd(header.cwd),
        formatVersion,
        mtimeNs: mtime,
        sizeBytes: stBefore.size,
        indexedBytes: readSize,
        fingerprint: fingerprintSession({ sourcePath, mtimeNs: mtime, sizeBytes: stBefore.size }),
        sourceIdentity,
        entries,
        incompleteTrailing,
        isActive: opts?.isActive ?? false,
      };
    } finally {
      try {
        closeSync(fd);
      } catch {
        // ignore
      }
    }
  }

  // Exhausted retries — file is unstable.
  return null;
}

/**
 * Build leaf→root path following parentId. Skipped entries are those not on path.
 * Compaction summaries are kept as evidence nodes on the path when present.
 */
export function buildLeafPaths(entries: RawSessionEntry[]): Map<string, string[]> {
  const byId = new Map<string, RawSessionEntry>();
  for (const e of entries) byId.set(e.id, e);

  const children = new Map<string | null, string[]>();
  for (const e of entries) {
    const p = e.parentId ?? null;
    const list = children.get(p) ?? [];
    list.push(e.id);
    children.set(p, list);
  }

  const hasChild = new Set<string>();
  for (const e of entries) {
    if (e.parentId) hasChild.add(e.parentId);
  }
  const leaves = entries.filter((e) => !hasChild.has(e.id));

  const paths = new Map<string, string[]>();
  for (const leaf of leaves) {
    const chain: string[] = [];
    let cur: RawSessionEntry | undefined = leaf;
    const guard = new Set<string>();
    while (cur && !guard.has(cur.id)) {
      guard.add(cur.id);
      chain.push(cur.id);
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
    chain.reverse();
    paths.set(leaf.id, chain);
  }
  return paths;
}

export function mtimeNs(st: { mtimeMs: number; mtimeNs?: number | bigint }): string {
  if (typeof st.mtimeNs === "bigint") return st.mtimeNs.toString();
  if (typeof st.mtimeNs === "number") return String(st.mtimeNs);
  return String(Math.trunc(st.mtimeMs * 1e6));
}

/** Detect if a path is likely the currently open session by matching session id. */
export function isActiveSessionPath(path: string, activeSessionId?: string): boolean {
  if (!activeSessionId) return false;
  return path.includes(activeSessionId);
}

export function sessionIdFromPath(path: string): string | null {
  const base = path.split(/[/\\]/).pop() ?? "";
  const m = base.match(/_([0-9a-fA-F-]{36})\.jsonl$/);
  return m?.[1] ?? null;
}
