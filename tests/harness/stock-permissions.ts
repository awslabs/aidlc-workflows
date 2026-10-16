// stock-permissions.ts - what a person on stock settings is asked during a live drive.
//
// AI-DLC ships what its own commands need: Claude Code allow rules
// (dist/claude/.claude/settings.json) and Codex prefix rules beside its
// workspace-write sandbox (dist/codex/.codex/rules/default.rules,
// .codex/config.toml). A person who keeps those settings is asked only about
// their own project's commands. So a permission request for AI-DLC's own
// command or record, a write outside the project, or a Codex sandbox refusal of
// AI-DLC's own command is a break the person meets; any other request (the
// project's build or test command, an agent's look at the person's code) is
// listed for the record and left to them.
import { isAbsolute, join, relative, sep } from "node:path";

/** One request Claude Code put to `canUseTool` (a prompt to a person on stock settings). */
export interface PermissionRequest {
  toolName: string;
  input: Record<string, unknown>;
}

export interface StockPermissionReport {
  /** Prompts or refusals a person on stock settings must never meet. */
  problems: string[];
  /** Every other prompt or refusal, for the record. */
  listed: string[];
}

const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
const PATH_KEYS = ["file_path", "notebook_path", "path"] as const;

/** A path in `text` that is, or starts with, AI-DLC's records folder or the harness folder (`.claude`, `.codex`). */
function namesAidlc(text: string, harnessDir: string): boolean {
  const folder = harnessDir.replace(".", "\\.");
  return new RegExp(`(?:^|[\\s'"=(:/\\\\])(?:${folder}|aidlc)(?:[/\\\\\\s'")]|$)`).test(text);
}

function primary(input: Record<string, unknown>): string {
  for (const key of ["command", ...PATH_KEYS, "url", "pattern"]) {
    if (typeof input[key] === "string") return input[key] as string;
  }
  return JSON.stringify(input);
}

const describe = (request: PermissionRequest): string => `${request.toolName} ${JSON.stringify(primary(request.input))}`;

/** Where a file tool's path lands: inside the project (its first folder) or outside it. */
function place(path: string, projectDir: string): { outside: boolean; top: string } {
  const rel = relative(projectDir, isAbsolute(path) ? path : join(projectDir, path));
  const outside = rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
  return { outside, top: outside ? "" : rel.split(sep)[0] };
}

/** Claude Code's prompts in a drive, split into what AI-DLC must never ask and the rest. */
export function claudePromptProblems(requests: readonly PermissionRequest[], projectDir: string): StockPermissionReport {
  const report: StockPermissionReport = { problems: [], listed: [] };
  for (const request of requests) {
    const path = PATH_KEYS.map((key) => request.input[key]).find((value): value is string => typeof value === "string");
    const where = path === undefined ? undefined : place(path, projectDir);
    if (where?.outside && WRITE_TOOLS.has(request.toolName)) {
      report.problems.push(`a write outside the project asked for permission: ${describe(request)}`);
    } else if (where && (where.top === "aidlc" || where.top === ".claude") ||
      (request.toolName === "Bash" && namesAidlc(String(request.input.command ?? ""), ".claude"))) {
      report.problems.push(`AI-DLC's own command or record asked for permission: ${describe(request)}`);
    } else {
      report.listed.push(describe(request));
    }
  }
  return report;
}

const REFUSED = /Read-only file system|Operation not permitted|Access is denied|Access to the path .* is denied/i;

/** The commands Codex's sandbox refused in one `codex exec --json` turn, AI-DLC's own split from the rest. */
export function codexSandboxProblems(stdout: string): StockPermissionReport {
  const report: StockPermissionReport = { problems: [], listed: [] };
  for (const line of stdout.split("\n")) {
    if (!line.startsWith("{")) continue;
    let event: { type?: unknown; item?: { type?: unknown; command?: unknown; aggregated_output?: unknown } };
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type !== "item.completed" || event.item?.type !== "command_execution") continue;
    const command = String(event.item.command ?? "");
    const refusal = String(event.item.aggregated_output ?? "").split("\n").find((text) => REFUSED.test(text));
    if (refusal === undefined) continue;
    const said = `${command} (${refusal.trim().slice(0, 200)})`;
    if (namesAidlc(command, ".codex")) report.problems.push(`the sandbox refused AI-DLC's own command: ${said}`);
    else report.listed.push(said);
  }
  return report;
}
