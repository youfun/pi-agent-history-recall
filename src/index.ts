/**
 * pi-agent-history-recall
 *
 * Project Conversation Retrieval from Pi Session JSONL.
 * Index is disposable SQLite; Session is Source of Truth.
 * History is evidence — not fact.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerHistoryRecallCommand } from "./commands.ts";
import { loadSettings } from "./config.ts";
import { getIndexForCwd } from "./index/store.ts";
import { searchProjectHistory } from "./retrieve/search.ts";
import {
  registerHistorySearchAlias,
  registerSearchProjectHistory,
} from "./tools/search_project_history.ts";
import { registerReadProjectHistory } from "./tools/read_project_history.ts";
import { EXTENSION_MARKER } from "./types.ts";

export default function (pi: ExtensionAPI) {
  registerSearchProjectHistory(pi);
  registerReadProjectHistory(pi);
  registerHistorySearchAlias(pi);
  registerHistoryRecallCommand(pi);
}
