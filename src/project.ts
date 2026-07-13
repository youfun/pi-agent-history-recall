import { createHash } from "node:crypto";
import { mkdirSync, accessSync, constants, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ProjectIdentity } from "./types.ts";

/** NFC + realpath canonicalization for project isolation. */
export function canonicalizeCwd(cwd: string): string {
  const resolved = resolve(cwd);
  let real = resolved;
  try {
    real = realpathSync(resolved);
  } catch {
    // Path may not exist yet; keep resolved absolute form.
  }
  return real.normalize("NFC");
}

export function projectIdFromCanonical(canonicalCwd: string): string {
  return createHash("sha256").update(canonicalCwd, "utf8").digest("hex");
}

export function resolveProjectIdentity(cwd: string): ProjectIdentity {
  const canonicalCwd = canonicalizeCwd(cwd);
  return {
    cwd,
    canonicalCwd,
    projectId: projectIdFromCanonical(canonicalCwd),
  };
}

/** True when two cwd strings refer to the same project after canonicalization. */
export function sameProject(a: string, b: string): boolean {
  try {
    return canonicalizeCwd(a) === canonicalizeCwd(b);
  } catch {
    return false;
  }
}

/**
 * Return the SQLite path for a project.
 *
 * Priority:
 * 1. `{cwd}/.pi/history-recall.sqlite` when project dir is writable.
 * 2. `{agentDir}/history-recall/{projectId}.sqlite` fallback (tests / readonly mounts).
 *
 * When `agentDir` is provided (tests), always use the agentDir layout so fixtures
 * stay isolated from the real project tree.
 */
export function indexDbPath(projectId: string, cwd: string, agentDir?: string): string {
  if (agentDir) {
    return join(agentDir, "history-recall", `${projectId}.sqlite`);
  }

  const localDir = join(cwd, ".pi");
  const localPath = join(localDir, "history-recall.sqlite");
  if (ensureWritableDir(localDir)) {
    return localPath;
  }

  const home = process.env.HOME || process.env.USERPROFILE || "";
  const base = `${home}/.pi/agent`;
  return join(base, "history-recall", `${projectId}.sqlite`);
}

function ensureWritableDir(dir: string): boolean {
  try {
    mkdirSync(dir, { recursive: true });
    accessSync(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

export function indexDir(agentDir?: string): string {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  const base = agentDir ?? `${home}/.pi/agent`;
  return join(base, "history-recall");
}
