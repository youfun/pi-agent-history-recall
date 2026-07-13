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
 * 1. `{cwd}/.pi/history-recall.sqlite` — colocated with project, never shared accidentally.
 * 2. `{agentDir}/history-recall/{projectId}.sqlite` — central fallback when the project
 *    directory is not writable (e.g. readonly mount, permission error).
 */
export function indexDbPath(projectId: string, cwd: string, agentDir?: string): string {
  const localDir = join(cwd, ".pi");
  const localPath = join(localDir, "history-recall.sqlite");
  try {
    // Pre-flight: try to create the directory (mkdir returns first created path, or throws).
    if (!isWritable(localDir)) throw new Error("local .pi not writable");
    return localPath;
  } catch {
    const home = process.env.HOME || process.env.USERPROFILE || "";
    const base = agentDir ?? `${home}/.pi/agent`;
    const fallback = `${base}/history-recall/${projectId}.sqlite`;
    return fallback;
  }
}

function isWritable(dir: string): boolean {
  try {
    if (!accessSync(dir, constants.W_OK)) {
      // exists and writable
      return true;
    }
    return true;
  } catch {
    // doesn't exist — try to create it
    try {
      mkdirSync(dir, { recursive: true });
      return true;
    } catch {
      return false;
    }
  }
}

export function indexDir(agentDir?: string): string {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  const base = agentDir ?? `${home}/.pi/agent`;
  return `${base}/history-recall`;
}
