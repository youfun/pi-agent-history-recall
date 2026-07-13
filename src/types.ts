/** Shared types for project conversation retrieval. */

export const SCHEMA_VERSION = 1;
export const EXTRACTOR_VERSION = "1.0.0";
export const REDACTION_VERSION = "1.0.0";
export const EXTENSION_MARKER = "pi-agent-history-recall";

export const MAX_VARIANTS_PER_USER = 64;
export const MAX_CHUNKS_PER_SESSION = 10_000;
export const DEFAULT_MAX_RESULTS = 5;
export const MAX_RESULTS = 20;
export const DEFAULT_MIN_RELEVANCE = 40;
export const DEFAULT_MIN_CONFIDENCE = 30;
export const HINT_MIN_RELEVANCE = 80;
export const HINT_MIN_CONFIDENCE = 70;

export const MAX_USER_TEXT = 8_000;
export const MAX_ASSISTANT_TEXT = 12_000;
export const MAX_OUTCOME = 1_200;
export const MAX_CONTEXT = 400;
export const MAX_ARGS_JSON = 2_000;
export const MAX_QUERY_CHARS = 500;
export const MAX_QUERY_TOKENS = 64;

export type EntityType = "file_path" | "symbol" | "module" | "error";
export type TraceStepType =
  | "read"
  | "grep"
  | "find"
  | "list"
  | "bash"
  | "edit"
  | "write"
  | "tool"
  | "error"
  | "exclusion"
  | "verification";
export type TraceStatus = "success" | "error" | "unknown";
export type ChunkStatus = "complete" | "open";
export type EvidenceType = "compaction" | "branch_summary" | "custom_message";
export type EvidenceScope = "chunk" | "session";
export type Freshness = "High" | "Medium" | "Low";

export interface ProjectIdentity {
  cwd: string;
  canonicalCwd: string;
  projectId: string;
}

export interface ParsedSessionHeader {
  id: string;
  cwd: string;
  timestamp?: string;
  version?: number;
}

export interface RawSessionEntry {
  type: string;
  id: string;
  parentId: string | null;
  timestamp: string;
  [key: string]: unknown;
}

export interface SessionSnapshot {
  sourcePath: string;
  sessionId: string;
  headerCwd: string;
  formatVersion: number;
  mtimeNs: string;
  sizeBytes: number;
  indexedBytes: number;
  fingerprint: string;
  sourceIdentity: string | null;
  entries: RawSessionEntry[];
  incompleteTrailing: boolean;
  isActive: boolean;
}

export interface ContentPart {
  type: string;
  text?: string;
  thinking?: string;
  name?: string;
  id?: string;
  arguments?: unknown;
  toolCallId?: string;
  isError?: boolean;
  content?: unknown;
}

export interface MessagePayload {
  role: string;
  content?: string | ContentPart[];
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
}

export interface ToolCallRef {
  entryId: string;
  toolCallId: string;
  toolName: string;
  arguments: Record<string, unknown>;
  ordinal: number;
}

export interface ToolResultRef {
  entryId: string;
  toolCallId: string;
  toolName?: string;
  isError: boolean;
  text: string;
  ordinal: number;
}

export interface ExtractedEntity {
  entityType: EntityType;
  value: string;
  normalizedValue: string;
  context: string;
  confidence: number;
  sourceEntryId: string;
}

export interface ExtractedConstraint {
  text: string;
  normalizedText: string;
  trigger: string;
  confidence: number;
  sourceEntryId: string;
  extractorVersion: string;
}

export interface TraceStep {
  sourceEntryId: string;
  resultEntryId: string | null;
  toolCallId: string | null;
  toolName: string | null;
  argumentsJson: string | null;
  stepType: TraceStepType;
  target: string;
  normalizedTarget: string;
  outcome: string;
  status: TraceStatus;
  stepOrder: number;
}

export interface EvidenceRecord {
  sourceEntryId: string;
  evidenceType: EvidenceType;
  evidenceScope: EvidenceScope;
  text: string;
  confidence: number;
  chunkId: string | null;
}

export interface ConversationChunk {
  id: string;
  projectId: string;
  sessionId: string;
  userEntryId: string;
  branchLeafId: string;
  variantHash: string;
  startEntryId: string;
  endEntryId: string;
  startTs: number;
  endTs: number;
  status: ChunkStatus;
  userText: string;
  assistantText: string;
  toolCallCount: number;
  pairedResultCount: number;
  rawEntryIds: string[];
  entities: ExtractedEntity[];
  constraints: ExtractedConstraint[];
  traceSteps: TraceStep[];
  evidence: EvidenceRecord[];
  latinText: { user: string; assistant: string; evidence: string };
  cjkGrams: string;
}

export interface RankedChunk {
  chunkId: string;
  sessionId: string;
  relevance: number;
  confidence: number;
  freshness: Freshness;
  endTs: number;
  userText: string;
  assistantSnippet: string;
  files: string[];
  symbols: string[];
  constraints: Array<{ text: string; sourceEntryId: string }>;
  exclusions: Array<{ text: string; sourceEntryId: string }>;
  errorCount: number;
  hasVerification: boolean;
  siblingChunkIds: string[];
}

export interface SearchOptions {
  query: string;
  project: ProjectIdentity;
  maxResults?: number;
  minRelevance?: number;
  minConfidence?: number;
  /** Exclude all chunks from this session id (before_agent_start). */
  excludeSessionId?: string;
  /** Exclude open chunks (always for safety). */
  excludeOpen?: boolean;
}

export interface IndexDiagnostics {
  skippedMissingCwd: number;
  skippedForeign: number;
  skippedMalformed: number;
  skippedBranchLimit: number;
  dirtySessions: number;
  indexedSessions: number;
  indexedChunks: number;
}

export interface ReconcileResult {
  diagnostics: IndexDiagnostics;
  changed: boolean;
}
