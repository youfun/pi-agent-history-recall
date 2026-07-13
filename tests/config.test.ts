import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  DEFAULT_SETTINGS,
  loadSettings,
  projectSettingsPath,
  saveProjectSettings,
  saveUserSettings,
  userSettingsPath,
} from "../src/config.ts";

describe("settings load/save", () => {
  let agentDir: string;
  let projectCwd: string;

  beforeEach(() => {
    agentDir = mkdtempSync(join(tmpdir(), "hist-cfg-agent-"));
    projectCwd = mkdtempSync(join(tmpdir(), "hist-cfg-proj-"));
  });

  afterEach(() => {
    rmSync(agentDir, { recursive: true, force: true });
    rmSync(projectCwd, { recursive: true, force: true });
  });

  test("defaults when no files exist", () => {
    const s = loadSettings(projectCwd, agentDir);
    expect(s.enabled).toBe(DEFAULT_SETTINGS.enabled);
    expect(s.minRelevance).toBe(DEFAULT_SETTINGS.minRelevance);
  });

  test("user settings apply", () => {
    saveUserSettings({ minRelevance: 55, hintsEnabled: false }, agentDir);
    const s = loadSettings(projectCwd, agentDir);
    expect(s.minRelevance).toBe(55);
    expect(s.hintsEnabled).toBe(false);
    expect(existsSync(userSettingsPath(agentDir))).toBe(true);
  });

  test("project settings override user", () => {
    saveUserSettings({ minRelevance: 55, enabled: true }, agentDir);
    saveProjectSettings(projectCwd, { minRelevance: 70, enabled: false });
    const s = loadSettings(projectCwd, agentDir);
    expect(s.minRelevance).toBe(70);
    expect(s.enabled).toBe(false);
    expect(existsSync(projectSettingsPath(projectCwd))).toBe(true);
  });

  test("invalid JSON is ignored", () => {
    mkdirSync(join(agentDir, "history-recall"), { recursive: true });
    writeFileSync(userSettingsPath(agentDir), "{not-json", "utf8");
    const s = loadSettings(projectCwd, agentDir);
    expect(s.minRelevance).toBe(DEFAULT_SETTINGS.minRelevance);
  });

  test("loadSettings enforces medium days >= high (single guard point)", () => {
    mkdirSync(join(projectCwd, ".pi"), { recursive: true });
    writeFileSync(
      projectSettingsPath(projectCwd),
      JSON.stringify({ freshnessHighDays: 30, freshnessMediumDays: 7 }),
      "utf8",
    );
    const s = loadSettings(projectCwd, agentDir);
    expect(s.freshnessHighDays).toBe(30);
    expect(s.freshnessMediumDays).toBe(30);
  });

  test("saveUserSettings stores raw values; loadSettings clamps on read", () => {
    // Simulate panel writing high=30 then medium=7 without a second clamp on write.
    saveUserSettings({ freshnessHighDays: 30, freshnessMediumDays: 7 }, agentDir);
    const onDisk = JSON.parse(readFileSync(userSettingsPath(agentDir), "utf8")) as {
      freshnessHighDays: number;
      freshnessMediumDays: number;
    };
    expect(onDisk.freshnessHighDays).toBe(30);
    expect(onDisk.freshnessMediumDays).toBe(7);
    const loaded = loadSettings(projectCwd, agentDir);
    expect(loaded.freshnessMediumDays).toBe(30);
  });

  test("saveUserSettings round-trips", () => {
    saveUserSettings({ hintMinRelevance: 85 }, agentDir);
    const raw = JSON.parse(readFileSync(userSettingsPath(agentDir), "utf8")) as {
      hintMinRelevance: number;
    };
    expect(raw.hintMinRelevance).toBe(85);
  });
});
