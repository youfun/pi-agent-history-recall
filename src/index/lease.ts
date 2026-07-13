/**
 * Filesystem writer lease for the project history index.
 *
 * Goal: two Pi processes must not let an older snapshot overwrite a newer one.
 * No background daemon — acquire around reconcile/upsert only.
 *
 * Protocol:
 * 1. Try exclusive create of `<dbPath>.lock` with owner payload.
 * 2. If exists and not stale, refuse (caller skips write / retries later).
 * 3. If stale (pid dead or age > TTL), break and re-acquire.
 * 4. Holder re-checks session fingerprints after acquire before committing.
 */
import {
  existsSync,
  openSync,
  closeSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  mkdirSync,
  statSync,
} from "node:fs";
import { dirname } from "node:path";

export const DEFAULT_LEASE_TTL_MS = 30_000;

export interface LeaseOwner {
  pid: number;
  startedAt: number;
  token: string;
}

export interface LeaseHandle {
  path: string;
  owner: LeaseOwner;
  release: () => void;
}

export type AcquireLeaseResult =
  | { ok: true; handle: LeaseHandle }
  | { ok: false; reason: "busy" | "error"; detail?: string };

export function acquireWriterLease(
  dbPath: string,
  opts?: { ttlMs?: number; token?: string },
): AcquireLeaseResult {
  const lockPath = `${dbPath}.lock`;
  const ttlMs = opts?.ttlMs ?? DEFAULT_LEASE_TTL_MS;
  const owner: LeaseOwner = {
    pid: process.pid,
    startedAt: Date.now(),
    token: opts?.token ?? `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
  };

  try {
    mkdirSync(dirname(lockPath), { recursive: true });
  } catch {
    // parent may already exist
  }

  // Attempt exclusive create.
  const created = tryExclusiveCreate(lockPath, owner);
  if (created) {
    return {
      ok: true,
      handle: {
        path: lockPath,
        owner,
        release: () => releaseIfOwner(lockPath, owner),
      },
    };
  }

  // Lock exists — check staleness.
  const existing = readLease(lockPath);
  if (!existing) {
    // Unreadable/corrupt lock: try break once.
    try {
      unlinkSync(lockPath);
    } catch {
      return { ok: false, reason: "busy", detail: "corrupt-lock-unreadable" };
    }
    const retry = tryExclusiveCreate(lockPath, owner);
    if (!retry) return { ok: false, reason: "busy", detail: "retry-after-corrupt-failed" };
    return {
      ok: true,
      handle: {
        path: lockPath,
        owner,
        release: () => releaseIfOwner(lockPath, owner),
      },
    };
  }

  if (!isLeaseStale(existing, ttlMs)) {
    return {
      ok: false,
      reason: "busy",
      detail: `held-by-pid-${existing.pid}`,
    };
  }

  // Stale: break and re-acquire.
  try {
    const still = readLease(lockPath);
    if (still && still.token === existing.token) {
      unlinkSync(lockPath);
    }
  } catch {
    return { ok: false, reason: "busy", detail: "stale-break-failed" };
  }

  const afterBreak = tryExclusiveCreate(lockPath, owner);
  if (!afterBreak) {
    return { ok: false, reason: "busy", detail: "lost-race-after-stale-break" };
  }
  return {
    ok: true,
    handle: {
      path: lockPath,
      owner,
      release: () => releaseIfOwner(lockPath, owner),
    },
  };
}

function tryExclusiveCreate(lockPath: string, owner: LeaseOwner): boolean {
  try {
    // wx: fail if exists
    const fd = openSync(lockPath, "wx");
    try {
      writeFileSync(fd, JSON.stringify(owner), "utf8");
    } finally {
      closeSync(fd);
    }
    return true;
  } catch {
    return false;
  }
}

function readLease(lockPath: string): LeaseOwner | null {
  try {
    if (!existsSync(lockPath)) return null;
    const raw = readFileSync(lockPath, "utf8");
    const obj = JSON.parse(raw) as Partial<LeaseOwner>;
    if (typeof obj.pid !== "number" || typeof obj.startedAt !== "number" || typeof obj.token !== "string") {
      return null;
    }
    return { pid: obj.pid, startedAt: obj.startedAt, token: obj.token };
  } catch {
    return null;
  }
}

function isLeaseStale(owner: LeaseOwner, ttlMs: number): boolean {
  const age = Date.now() - owner.startedAt;
  if (age > ttlMs) return true;
  // If process is dead on this host, treat as stale (best-effort; pid reuse possible).
  if (owner.pid !== process.pid && !pidAlive(owner.pid)) return true;
  return false;
}

function pidAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function releaseIfOwner(lockPath: string, owner: LeaseOwner): void {
  try {
    const current = readLease(lockPath);
    if (!current) return;
    if (current.token !== owner.token) return;
    unlinkSync(lockPath);
  } catch {
    // ignore
  }
}

/** Test helper: force-write a lease file as another owner. */
export function writeLeaseForTest(lockPath: string, owner: LeaseOwner): void {
  mkdirSync(dirname(lockPath), { recursive: true });
  writeFileSync(lockPath, JSON.stringify(owner), "utf8");
}

export function leasePathForDb(dbPath: string): string {
  return `${dbPath}.lock`;
}

export function leaseMtimeMs(lockPath: string): number | null {
  try {
    return statSync(lockPath).mtimeMs;
  } catch {
    return null;
  }
}
