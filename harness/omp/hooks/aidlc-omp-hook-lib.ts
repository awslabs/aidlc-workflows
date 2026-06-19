// Shared helpers for omp hooks — the shared hook helpers (omp)
// `aidlc-lib.ts` helper. Same surface as much as possible so the hook
// bodies (which use these) read identically across both implementations.

import * as fs from "node:fs";
import * as path from "node:path";
import * as url from "node:url";

const f = fs;
const p = path;

/**
 * Project directory for this AIDLC install. omp sources the project root
 * from the script location (stripping the trailing `.omp/hooks/` suffix),
 * with a back-compat fallback to OMP_PROJECT_DIR / a legacy env name.
 */
export function resolveProjectDir(): string {
  if (process.env.OMP_PROJECT_DIR) return process.env.OMP_PROJECT_DIR;
  if (process.env.AIDLC_PROJECT_DIR) return process.env.AIDLC_PROJECT_DIR;

  try {
    const scriptDir = p.dirname(url.fileURLToPath(import.meta.url));
    const suffix = `${p.sep}.omp${p.sep}hooks`;
    if (scriptDir.endsWith(suffix)) {
      return scriptDir.slice(0, -suffix.length);
    }
  } catch {
    /* import.meta.url not available — fall through */
  }

  const cwd = process.cwd();
  if (f.existsSync(p.join(cwd, ".omp"))) return cwd;
  return cwd;
}

export function stateFilePath(projectDir: string): string {
  return p.join(projectDir, "aidlc-docs", "aidlc-state.md");
}

export function auditFilePath(projectDir: string): string {
  return p.join(projectDir, "aidlc-docs", "audit", "audit.md");
}

export function isoTimestamp(d: Date = new Date()): string {
  return d.toISOString();
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Extract the value following `**Label**:` in the markdown state file. Anchored
 * to the start of the line so prose lines referencing the same label still
 * don't shadow the metadata.
 */
export function getField(text: string, label: string): string | null {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^-\\s*\\*\\*${escaped}\\*\\*[^\\S\\n]*([^\\n]*)`, "m");
  const m = text.match(re);
  return m && m[1] ? m[1].replace(/\r$/, "").trim() : null;
}

/**
 * Append a row to the structured audit log. Creates the file and parent
 * directories if missing.
 */
export function appendAuditEntry(
  eventType: string,
  fields: Record<string, string | number | boolean>,
  projectDir: string,
): void {
  const file = auditFilePath(projectDir);
  f.mkdirSync(p.dirname(file), { recursive: true });
  const ts = isoTimestamp();
  const fieldRows = Object.entries(fields)
    .map(([k, v]) => `  - **${k}**: ${v}`)
    .join("\n");
  const row = `\n## ${eventType} - ${ts}\n${fieldRows}\n`;
  f.appendFileSync(file, row);
}

/**
 * Record a dropped hook so operators can see why a hook didn't fire.
 * Mirrors the engine's `recordHookDrop`.
 */
export function recordHookDrop(projectDir: string, hookName: string, errMsg: string): void {
  const dropFile = p.join(projectDir, "aidlc-docs", ".aidlc-hooks-health", `${hookName}.dropped`);
  f.mkdirSync(p.dirname(dropFile), { recursive: true });
  f.writeFileSync(dropFile, `${isoTimestamp()} ${errorMessage(errMsg)}\n`, { encoding: "utf-8" });
}

/**
 * Write a hook heartbeat so the test suite can verify the hook fired.
 */
export function writeHeartbeat(projectDir: string, hookName: string): void {
  const dir = p.join(projectDir, "aidlc-docs", ".aidlc-hooks-health");
  f.mkdirSync(dir, { recursive: true });
  f.writeFileSync(p.join(dir, `${hookName}.last`), isoTimestamp(), { encoding: "utf-8" });
}

/**
 * Read the project state file. Returns null if no state.
 */
export function readStateFile(projectDir: string): string | null {
  const file = stateFilePath(projectDir);
  if (!f.existsSync(file)) return null;
  return f.readFileSync(file, { encoding: "utf-8" });
}

/**
 * omp hook input shape — mirrors the schema exposed by `HookAPI` event
 * callbacks. Keep this loose; we only depend on `toolName`, `input`, and
 * `output` for the post-tool hooks.
 */
export type OmpHookEvent = {
  toolName?: string;
  input?: Record<string, unknown>;
  output?: unknown;
  isError?: boolean;
  // omp event names — populate whichever the event provides
  source?: string;
  message?: string;
};

/**
 * Handler shape used by every hook below.
 */
export type HookHandler<T = OmpHookEvent> = (event: T) => void | Promise<void>;

/**
 * Sanitize path-like input to deny traversal beyond `.omp/`.
 */
export function safeWithinOmp(projectDir: string, candidate: string): boolean {
  const resolved = p.join(projectDir, candidate);
  return resolved.startsWith(projectDir);
}
