import { REDACTION_VERSION } from "./types.ts";

const SECRET_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, label: "[REDACTED_PRIVATE_KEY]" },
  { re: /\b(sk-[A-Za-z0-9]{20,})\b/g, label: "[REDACTED_API_KEY]" },
  { re: /\b(ghp_[A-Za-z0-9]{20,})\b/g, label: "[REDACTED_TOKEN]" },
  { re: /\b(xox[baprs]-[A-Za-z0-9-]{10,})\b/g, label: "[REDACTED_TOKEN]" },
  { re: /\bBearer\s+[A-Za-z0-9\-._~+/]+=*\b/gi, label: "Bearer [REDACTED]" },
  { re: /\b(api[_-]?key|token|password|secret)\s*[:=]\s*["']?[^\s"']{8,}["']?/gi, label: "[REDACTED_CREDENTIAL]" },
  { re: /\b[A-Za-z0-9+/]{40,}={0,2}\b/g, label: "[REDACTED_BLOB]" },
];

const SENSITIVE_PATH_RE =
  /(?:^|\/)(?:\.env(?:\..+)?|credentials(?:\.json)?|\.npmrc|\.netrc|id_rsa|id_ed25519|.*\.(?:pem|key|p12|pfx))$/i;

export function redactionVersion(): string {
  return REDACTION_VERSION;
}

export function isSensitivePath(path: string): boolean {
  const base = path.split(/[/\\]/).pop() ?? path;
  return SENSITIVE_PATH_RE.test(base) || SENSITIVE_PATH_RE.test(path);
}

export function redactText(input: string, maxLen = 12_000): string {
  if (!input) return "";
  let out = input;
  for (const { re, label } of SECRET_PATTERNS) {
    out = out.replace(re, label);
  }
  if (out.length > maxLen) {
    out = `${out.slice(0, maxLen)}\n…[truncated ${out.length - maxLen} chars]`;
  }
  return out;
}

export function clip(input: string, maxLen: number): string {
  if (!input) return "";
  if (input.length <= maxLen) return input;
  return `${input.slice(0, maxLen)}…`;
}

/** Prefer project-relative display path; never invent absolute session paths for model output. */
export function displayPath(path: string, canonicalCwd: string): string {
  const p = path.replace(/\\/g, "/");
  const root = canonicalCwd.replace(/\\/g, "/");
  if (p === root) return ".";
  if (p.startsWith(`${root}/`)) return p.slice(root.length + 1);
  // Collapse home for non-project paths that leak through.
  const home = (process.env.HOME || "").replace(/\\/g, "/");
  if (home && p.startsWith(`${home}/`)) return `~/${p.slice(home.length + 1)}`;
  return p;
}

export function safeArgsJson(args: unknown, maxLen = 2_000): string {
  try {
    let raw = JSON.stringify(args ?? {});
    // Apply redaction without truncation (redactText may append invalid JSON suffix).
    for (const { re, label } of SECRET_PATTERNS) {
      raw = raw.replace(re, label);
    }
    if (raw.length > maxLen) {
      // Truncate at the last complete JSON structure boundary.
      raw = truncateJson(raw, maxLen);
    }
    return raw;
  } catch {
    return "{}";
  }
}

function truncateJson(json: string, maxLen: number): string {
  if (json.length <= maxLen) return json;
  const head = json.slice(0, maxLen);
  // Walk backwards to find a safe JSON truncation point.
  let depth = 0;
  let inString = false;
  let escapeNext = false;
  for (let i = 0; i < head.length; i++) {
    const ch = head[i]!;
    if (escapeNext) { escapeNext = false; continue; }
    if (ch === "\\") { escapeNext = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "{" || ch === "[") depth++;
    if (ch === "}" || ch === "]") depth--;
  }
  // Close any open strings and containers.
  let result = head;
  if (inString) result += '"';
  while (depth > 0) {
    // Heuristic: if last structural char was '{' → close with '}', '[' → close with ']'
    const lastStructural = head.match(/[{[]$/)?.[0];
    if (lastStructural === "[") { result += "]"; depth--; }
    else { result += "}"; depth--; }
  }
  result += JSON.stringify("…[truncated]");
  return result;
}
