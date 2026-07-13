/**
 * Settings for history-recall.
 *
 * Load order (later wins for overlapping keys):
 * 1. built-in defaults
 * 2. user: ~/.pi/agent/history-recall/settings.json
 * 3. project: {cwd}/.pi/history-recall.json
 *
 * Project opt-out (`enabled: false`) disables indexing and hints for that project.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  DEFAULT_MIN_CONFIDENCE,
  DEFAULT_MIN_RELEVANCE,
  HINT_MIN_CONFIDENCE,
  HINT_MIN_RELEVANCE,
} from "./types.ts";

export interface HistoryRecallSettings {
  /** Master switch: false disables indexing, tools, and hints. */
  enabled: boolean;
  /** Inject one-line before_agent_start hints when thresholds met. */
  hintsEnabled: boolean;
  minRelevance: number;
  minConfidence: number;
  hintMinRelevance: number;
  hintMinConfidence: number;
  /** Freshness High bucket in days. */
  freshnessHighDays: number;
  /** Freshness Medium bucket in days. */
  freshnessMediumDays: number;
}

export const DEFAULT_SETTINGS: HistoryRecallSettings = {
  enabled: true,
  hintsEnabled: true,
  minRelevance: DEFAULT_MIN_RELEVANCE,
  minConfidence: DEFAULT_MIN_CONFIDENCE,
  hintMinRelevance: HINT_MIN_RELEVANCE,
  hintMinConfidence: HINT_MIN_CONFIDENCE,
  freshnessHighDays: 7,
  freshnessMediumDays: 30,
};

export function userSettingsPath(agentDir?: string): string {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  const base = agentDir ?? join(home, ".pi", "agent");
  return join(base, "history-recall", "settings.json");
}

export function projectSettingsPath(cwd: string): string {
  return join(cwd, ".pi", "history-recall.json");
}

function readJsonFile(path: string): Record<string, unknown> | null {
  try {
    if (!existsSync(path)) return null;
    const raw = readFileSync(path, "utf8");
    const obj = JSON.parse(raw) as unknown;
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
    return obj as Record<string, unknown>;
  } catch {
    return null;
  }
}

function pickBool(obj: Record<string, unknown>, key: string): boolean | undefined {
  const v = obj[key];
  return typeof v === "boolean" ? v : undefined;
}

function pickNumber(obj: Record<string, unknown>, key: string): number | undefined {
  const v = obj[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function mergePartial(
  base: HistoryRecallSettings,
  partial: Record<string, unknown> | null,
): HistoryRecallSettings {
  if (!partial) return { ...base };
  return {
    enabled: pickBool(partial, "enabled") ?? base.enabled,
    hintsEnabled: pickBool(partial, "hintsEnabled") ?? base.hintsEnabled,
    minRelevance: clamp01to100(pickNumber(partial, "minRelevance") ?? base.minRelevance),
    minConfidence: clamp01to100(pickNumber(partial, "minConfidence") ?? base.minConfidence),
    hintMinRelevance: clamp01to100(
      pickNumber(partial, "hintMinRelevance") ?? base.hintMinRelevance,
    ),
    hintMinConfidence: clamp01to100(
      pickNumber(partial, "hintMinConfidence") ?? base.hintMinConfidence,
    ),
    freshnessHighDays: Math.max(
      1,
      pickNumber(partial, "freshnessHighDays") ?? base.freshnessHighDays,
    ),
    freshnessMediumDays: Math.max(
      1,
      pickNumber(partial, "freshnessMediumDays") ?? base.freshnessMediumDays,
    ),
  };
}

function clamp01to100(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)));
}

/**
 * Load effective settings for a project.
 * Single enforcement point for freshnessMediumDays >= freshnessHighDays.
 */
export function loadSettings(cwd: string, agentDir?: string): HistoryRecallSettings {
  let settings = { ...DEFAULT_SETTINGS };
  settings = mergePartial(settings, readJsonFile(userSettingsPath(agentDir)));
  settings = mergePartial(settings, readJsonFile(projectSettingsPath(cwd)));
  return enforceInvariants(settings);
}

/** Normalize cross-field constraints. Call only from loadSettings. */
function enforceInvariants(settings: HistoryRecallSettings): HistoryRecallSettings {
  const next = { ...settings };
  if (next.freshnessMediumDays < next.freshnessHighDays) {
    next.freshnessMediumDays = next.freshnessHighDays;
  }
  return next;
}

/** Write user-level settings (does not touch project file). */
export function saveUserSettings(
  partial: Partial<HistoryRecallSettings>,
  agentDir?: string,
): HistoryRecallSettings {
  const path = userSettingsPath(agentDir);
  mkdirSync(dirname(path), { recursive: true });
  const current = mergePartial(DEFAULT_SETTINGS, readJsonFile(path));
  const next = { ...current, ...partial };
  writeFileSync(path, JSON.stringify(next, null, 2) + "\n", "utf8");
  return next;
}

/** Write project-level settings at {cwd}/.pi/history-recall.json */
export function saveProjectSettings(
  cwd: string,
  partial: Partial<HistoryRecallSettings>,
): HistoryRecallSettings {
  const path = projectSettingsPath(cwd);
  mkdirSync(dirname(path), { recursive: true });
  const current = mergePartial(DEFAULT_SETTINGS, readJsonFile(path));
  const next = { ...current, ...partial };
  writeFileSync(path, JSON.stringify(next, null, 2) + "\n", "utf8");
  return next;
}

export function formatSettings(settings: HistoryRecallSettings): string {
  return [
    `enabled: ${settings.enabled}`,
    `hintsEnabled: ${settings.hintsEnabled}`,
    `minRelevance: ${settings.minRelevance}`,
    `minConfidence: ${settings.minConfidence}`,
    `hintMinRelevance: ${settings.hintMinRelevance}`,
    `hintMinConfidence: ${settings.hintMinConfidence}`,
    `freshnessHighDays: ${settings.freshnessHighDays}`,
    `freshnessMediumDays: ${settings.freshnessMediumDays}`,
  ].join("\n");
}
