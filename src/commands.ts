/**
 * /history-recall command family + interactive settings overlay.
 * Pattern adapted from pi-context-prune (SettingsList + DynamicBorder overlay).
 */
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Container, Text, SettingsList, type SettingItem } from "@earendil-works/pi-tui";
import {
  DEFAULT_SETTINGS,
  formatSettings,
  loadSettings,
  saveUserSettings,
  type HistoryRecallSettings,
} from "./config.ts";
import {
  clearIndexCache,
  clearProjectIndex,
  getIndexForCwd,
} from "./index/store.ts";
import { formatSearchResults, searchProjectHistory } from "./retrieve/search.ts";
import { indexDbPath, resolveProjectIdentity } from "./project.ts";

class SettingsOverlay extends Container {
  constructor(
    title: string,
    private readonly settingsList: SettingsList,
  ) {
    super();
    this.addChild(new DynamicBorder());
    this.addChild(new Text(title, 0, 0));
    this.addChild(settingsList);
    this.addChild(new DynamicBorder());
  }

  handleInput(data: string) {
    this.settingsList.handleInput(data);
  }

  invalidate() {
    this.settingsList.invalidate();
  }
}

const THRESHOLD_VALUES = ["0", "20", "30", "40", "50", "60", "70", "80", "90", "100"];
const DAY_VALUES = ["1", "3", "7", "14", "30", "60", "90"];

const SUBCOMMANDS = [
  { value: "settings", label: "settings  — interactive settings overlay" },
  { value: "status", label: "status    — show settings, index path, and diagnostics" },
  { value: "rebuild", label: "rebuild   — force reindex of this project's sessions" },
  { value: "clear", label: "clear     — delete disposable SQLite index (sessions untouched)" },
  { value: "on", label: "on        — enable history recall (user settings)" },
  { value: "off", label: "off       — disable history recall (user settings)" },
  { value: "help", label: "help      — show help" },
] as const;

const HELP_TEXT = `history-recall — project conversation retrieval from Pi Session JSONL.

History is EVIDENCE, not fact. Always verify current code after recall.

Usage:
  /history-recall <query>                 Search this project's history
  /history-recall settings                Interactive settings overlay
  /history-recall status                  Settings + index diagnostics
  /history-recall rebuild                 Force reindex (clears then rebuilds SQLite)
  /history-recall clear                   Delete disposable SQLite index only
  /history-recall on | off                Enable/disable (user settings)
  /history-recall help                    This help

Tools:
  search_project_history
  read_project_history
  history_search (alias)

Settings files (later wins):
  ~/.pi/agent/history-recall/settings.json
  {project}/.pi/history-recall.json
`;

function boolLabel(v: boolean): string {
  return v ? "true" : "false";
}

function buildSettingItems(settings: HistoryRecallSettings): SettingItem[] {
  return [
    {
      id: "enabled",
      label: "Enabled",
      values: ["true", "false"],
      currentValue: boolLabel(settings.enabled),
      description:
        "Master switch. When false, indexing, tools, and before_agent_start hints are disabled.",
    },
    {
      id: "hintsEnabled",
      label: "Auto hints",
      values: ["true", "false"],
      currentValue: boolLabel(settings.hintsEnabled),
      description:
        "Inject a one-line before_agent_start hint when relevance/confidence thresholds are met. Never injects full history.",
    },
    {
      id: "minRelevance",
      label: "Min relevance",
      values: THRESHOLD_VALUES,
      currentValue: String(settings.minRelevance),
      description: "Default minimum Relevance (0–100) for search_project_history.",
    },
    {
      id: "minConfidence",
      label: "Min confidence",
      values: THRESHOLD_VALUES,
      currentValue: String(settings.minConfidence),
      description: "Default minimum Confidence (0–100) for search_project_history.",
    },
    {
      id: "hintMinRelevance",
      label: "Hint min relevance",
      values: THRESHOLD_VALUES,
      currentValue: String(settings.hintMinRelevance),
      description: "Minimum Relevance required before emitting an auto hint.",
    },
    {
      id: "hintMinConfidence",
      label: "Hint min confidence",
      values: THRESHOLD_VALUES,
      currentValue: String(settings.hintMinConfidence),
      description: "Minimum Confidence required before emitting an auto hint.",
    },
    {
      id: "freshnessHighDays",
      label: "Freshness High (days)",
      values: DAY_VALUES,
      currentValue: String(settings.freshnessHighDays),
      description: "Chunks newer than this many days are Freshness: High.",
    },
    {
      id: "freshnessMediumDays",
      label: "Freshness Medium (days)",
      values: DAY_VALUES,
      currentValue: String(settings.freshnessMediumDays),
      description:
        "Chunks newer than this (but older than High) are Freshness: Medium. Older are Low.",
    },
  ];
}

/** Apply one overlay edit. Freshness invariants are enforced only in loadSettings(). */
function applySettingChange(
  settings: HistoryRecallSettings,
  id: string,
  newValue: string,
): Partial<HistoryRecallSettings> {
  switch (id) {
    case "enabled":
      return { enabled: newValue === "true" };
    case "hintsEnabled":
      return { hintsEnabled: newValue === "true" };
    case "minRelevance":
      return { minRelevance: Number(newValue) };
    case "minConfidence":
      return { minConfidence: Number(newValue) };
    case "hintMinRelevance":
      return { hintMinRelevance: Number(newValue) };
    case "hintMinConfidence":
      return { hintMinConfidence: Number(newValue) };
    case "freshnessHighDays":
      return { freshnessHighDays: Number(newValue) };
    case "freshnessMediumDays":
      return { freshnessMediumDays: Number(newValue) };
    default:
      return {};
  }
}

function syncSettingItems(items: SettingItem[], settings: HistoryRecallSettings): void {
  const byId: Record<string, string> = {
    enabled: boolLabel(settings.enabled),
    hintsEnabled: boolLabel(settings.hintsEnabled),
    minRelevance: String(settings.minRelevance),
    minConfidence: String(settings.minConfidence),
    hintMinRelevance: String(settings.hintMinRelevance),
    hintMinConfidence: String(settings.hintMinConfidence),
    freshnessHighDays: String(settings.freshnessHighDays),
    freshnessMediumDays: String(settings.freshnessMediumDays),
  };
  for (const item of items) {
    const v = byId[item.id];
    if (v !== undefined) item.currentValue = v;
  }
}

async function openSettingsOverlay(ctx: ExtensionCommandContext): Promise<void> {
  let settings = loadSettings(ctx.cwd);
  const items = buildSettingItems(settings);

  let settingsList: SettingsList;
  let closeSettingsOverlay = () => {};

  const onChange = (id: string, newValue: string) => {
    // Persist raw edit; loadSettings() is the single place that enforces
    // freshnessMediumDays >= freshnessHighDays (and other clamps).
    saveUserSettings(applySettingChange(settings, id, newValue));
    settings = loadSettings(ctx.cwd);
    syncSettingItems(items, settings);
    settingsList?.invalidate();
  };

  settingsList = new SettingsList(
    items,
    10,
    getSettingsListTheme(),
    onChange,
    () => closeSettingsOverlay(),
    { enableSearch: false },
  );

  await ctx.ui.custom(
    (_tui, _theme, _keybindings, done) => {
      closeSettingsOverlay = () => done(undefined);
      return new SettingsOverlay("history-recall settings", settingsList);
    },
    {
      overlay: true,
      overlayOptions: { width: 64 },
    },
  );
}

function runStatus(ctx: ExtensionCommandContext): void {
  const settings = loadSettings(ctx.cwd);
  const project = resolveProjectIdentity(ctx.cwd);
  const dbPath = indexDbPath(project.projectId, project.canonicalCwd);

  let diagnosticsLine = "index: (not opened)";
  try {
    if (settings.enabled) {
      const index = getIndexForCwd(ctx.cwd);
      const recon = index.reconcile({
        activeSessionId: ctx.sessionManager.getSessionId(),
      });
      const d = recon.diagnostics;
      diagnosticsLine = [
        `sessions indexed: ${d.indexedSessions}`,
        `chunks: ${d.indexedChunks}`,
        `dirty: ${d.dirtySessions}`,
        `branch-limit skips: ${d.skippedBranchLimit}`,
        `lease-busy: ${d.skippedLeaseBusy}`,
        `foreign/malformed: ${d.skippedForeign}/${d.skippedMalformed}`,
        `isolation errors: ${d.hardIsolationErrors}`,
      ].join("\n");
    } else {
      diagnosticsLine = "index: disabled (enabled=false)";
    }
  } catch (err) {
    diagnosticsLine = `index error: ${err instanceof Error ? err.message : String(err)}`;
  }

  ctx.ui.notify(
    [
      "history-recall status",
      "",
      formatSettings(settings),
      "",
      `project_id: ${project.projectId.slice(0, 16)}…`,
      `canonical_cwd: ${project.canonicalCwd}`,
      `db: ${dbPath}`,
      "",
      diagnosticsLine,
    ].join("\n"),
    "info",
  );
}

function runRebuild(ctx: ExtensionCommandContext): void {
  const settings = loadSettings(ctx.cwd);
  if (!settings.enabled) {
    ctx.ui.notify("history-recall is disabled (enabled=false). Enable first.", "warning");
    return;
  }
  try {
    const cleared = clearProjectIndex(ctx.cwd);
    clearIndexCache();
    const index = getIndexForCwd(ctx.cwd);
    const recon = index.reconcile({
      activeSessionId: ctx.sessionManager.getSessionId(),
    });
    ctx.ui.notify(
      `Rebuilt index.\nremoved: ${cleared.removed.length} file(s)\nsessions: ${recon.diagnostics.indexedSessions}\nchunks: ${recon.diagnostics.indexedChunks}`,
      "info",
    );
  } catch (err) {
    ctx.ui.notify(
      `rebuild failed: ${err instanceof Error ? err.message : String(err)}`,
      "error",
    );
  }
}

function runClear(ctx: ExtensionCommandContext): void {
  try {
    const cleared = clearProjectIndex(ctx.cwd);
    clearIndexCache();
    ctx.ui.notify(
      `Cleared disposable index (${cleared.removed.length} file(s)).\nSession JSONL was not modified.\ndb was: ${cleared.dbPath}`,
      "info",
    );
  } catch (err) {
    ctx.ui.notify(
      `clear failed: ${err instanceof Error ? err.message : String(err)}`,
      "error",
    );
  }
}

function runSearch(ctx: ExtensionCommandContext, query: string): void {
  const settings = loadSettings(ctx.cwd);
  if (!settings.enabled) {
    ctx.ui.notify("history-recall is disabled (enabled=false).", "warning");
    return;
  }
  try {
    const index = getIndexForCwd(ctx.cwd);
    const recon = index.reconcile({
      activeSessionId: ctx.sessionManager.getSessionId(),
    });
    const results = searchProjectHistory(index, {
      query,
      project: index.project,
      maxResults: 5,
      minRelevance: settings.minRelevance,
      minConfidence: settings.minConfidence,
      freshnessHighDays: settings.freshnessHighDays,
      freshnessMediumDays: settings.freshnessMediumDays,
      excludeOpen: true,
    });
    if (results.length === 0) {
      ctx.ui.notify(
        `No history matches for "${query}" (sessions indexed: ${recon.diagnostics.indexedSessions}).`,
        "info",
      );
      return;
    }
    ctx.ui.notify(formatSearchResults(results), "info");
  } catch (err) {
    ctx.ui.notify(
      `history-recall failed: ${err instanceof Error ? err.message : String(err)}`,
      "error",
    );
  }
}

export function registerHistoryRecallCommand(pi: ExtensionAPI): void {
  pi.registerCommand("history-recall", {
    description:
      "Project history retrieval. Usage: /history-recall <query|settings|status|rebuild|clear|help>",
    getArgumentCompletions: (prefix: string) => {
      const p = (prefix ?? "").trim().toLowerCase();
      return SUBCOMMANDS.filter((s) => s.value.startsWith(p)).map((s) => ({
        value: s.value,
        label: s.label,
      }));
    },
    handler: async (args, ctx) => {
      const raw = (args ?? "").trim();
      if (!raw) {
        // Interactive subcommand picker
        const labels = SUBCOMMANDS.map((s) => s.label);
        const picked = await ctx.ui.select("history-recall", labels);
        if (!picked) return;
        const value = SUBCOMMANDS.find((s) => s.label === picked)?.value;
        if (!value) return;
        await dispatch(value, "", ctx);
        return;
      }

      const [head, ...rest] = raw.split(/\s+/);
      const sub = (head ?? "").toLowerCase();
      const known = SUBCOMMANDS.some((s) => s.value === sub);
      if (known) {
        await dispatch(sub, rest.join(" ").trim(), ctx);
        return;
      }
      // Treat full args as search query
      runSearch(ctx, raw);
    },
  });
}

async function dispatch(
  sub: string,
  _rest: string,
  ctx: ExtensionCommandContext,
): Promise<void> {
  switch (sub) {
    case "settings":
      await openSettingsOverlay(ctx);
      break;
    case "status":
      runStatus(ctx);
      break;
    case "rebuild":
      runRebuild(ctx);
      break;
    case "clear":
      runClear(ctx);
      break;
    case "on":
      saveUserSettings({ enabled: true });
      ctx.ui.notify("history-recall enabled (user settings).", "info");
      break;
    case "off":
      saveUserSettings({ enabled: false });
      ctx.ui.notify("history-recall disabled (user settings).", "info");
      break;
    case "help":
      ctx.ui.notify(HELP_TEXT, "info");
      break;
    default:
      ctx.ui.notify(`Unknown subcommand. ${HELP_TEXT}`, "warning");
  }
}

export { DEFAULT_SETTINGS, loadSettings };
