// stock-permissions.ts - what a person on stock settings is asked during a live drive.
//
// AI-DLC ships what its own commands need: Claude Code allow rules
// (dist/claude/.claude/settings.json), Codex prefix rules beside its
// workspace-write sandbox (dist/codex/.codex/rules/default.rules,
// .codex/config.toml) and opencode's permission table (dist/opencode/opencode.json).
// A drive sees a prompt the person answered yes on Claude Code, and a refused
// command whose work did not happen on Codex and opencode.
//
// Three kinds are a break the person meets: a file tool asking on a path inside
// aidlc/ or the harness folder, a write outside the project, and a shell
// command that runs one of AI-DLC's own tools (runsAidlcTool), which keeps a
// drive red when the shipped allow list stops covering what the engine hands
// out. Any other shell command that names AI-DLC's folders is one the agent
// wrote itself, and no allow list can promise a person is never asked about
// it: it is listed and counted under its own heading (folderCommandsBlock),
// never failed. Any other request (the project's build or test command, an
// agent's look at the person's code) is listed for the record and left to them.
//
// runsAidlcTool reads the launcher and the tools folder from the allow list of
// the tree the live fixtures install (dist/), so a tool or subcommand the list
// does not name yet still counts. A command counts as a run when it names both,
// each as a word anywhere in it, in any case (Windows runs `BUN.EXE` and a
// `bun.cmd` shim): a pattern cannot run the shell, and reading a run by its shape
// misses real spellings (a `cd` or `pushd` into the folder, a quoted `$(...)`
// path, a flag with a value). So a line that names both and runs neither
// (`grep -rn bun .claude/tools/`) fails too. Known not to count, and so listed: a
// line with no launcher word (a
// launcher the shipped list does not name, a script run as its own program, a
// launcher held in a variable), the tools folder not written in one piece
// (`cd .claude && bun tools/aidlc.ts`), a script outside the tools folder, and
// the native channel's `aidlc engine` form (dist-release/), which must be added
// before a journey installs that channel.
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** One request Claude Code put to `canUseTool` (a prompt to a person on stock settings). */
export interface PermissionRequest {
  toolName: string;
  input: Record<string, unknown>;
}

export interface StockPermissionReport {
  /** Prompts or refusals a person on stock settings must never meet. */
  problems: string[];
  /** Shell commands that name AI-DLC's folders and run none of its tools: the agent's own, counted, never failed. */
  folderCommands: string[];
  /** Every other prompt or refusal, for the record. */
  listed: string[];
}

type Harness = "claude" | "codex" | "opencode";

const DIST = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "dist");

/** Where each harness ships its allow list, and the words of each command it allows. */
const SHIPPED: Record<Harness, { file: string; allowed: (text: string) => string[][] }> = {
  claude: {
    file: join("claude", ".claude", "settings.json"),
    allowed: (text) => ((JSON.parse(text).permissions?.allow ?? []) as string[])
      .flatMap((entry) => /^Bash\((.+)\)$/.exec(entry)?.[1] ?? [])
      .map((command) => command.split(/\s+/)),
  },
  codex: {
    file: join("codex", ".codex", "rules", "default.rules"),
    allowed: (text) => [...text.matchAll(/prefix_rule\(pattern = (\[[\s\S]*?\]), decision = "allow"\)/g)].flatMap((match) => {
      const [program, next] = JSON.parse(match[1]) as [string, string | string[]];
      return (Array.isArray(next) ? next : [next]).map((word) => [program, word]);
    }),
  },
  opencode: {
    file: join("opencode", "opencode.json"),
    allowed: (text) => Object.entries((JSON.parse(text).permission?.bash ?? {}) as Record<string, string>)
      .filter(([, decision]) => decision === "allow")
      .map(([command]) => command.split(/\s+/)),
  },
};

const literal = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const ownTools = new Map<Harness, Array<{ launcher: RegExp; folder: RegExp }>>();

/** The launcher and the tools folder of each command the harness's shipped allow list runs by a path, read on first use (dist/ is build output). */
function ownToolForms(harness: Harness): Array<{ launcher: RegExp; folder: RegExp }> {
  const known = ownTools.get(harness);
  if (known) return known;
  const file = join(DIST, SHIPPED[harness].file);
  const forms = new Map<string, { launcher: RegExp; folder: RegExp }>();
  for (const [program, script] of SHIPPED[harness].allowed(readFileSync(file, "utf8"))) {
    if (!program || !script?.includes("/")) continue;
    const folder = script.slice(0, script.lastIndexOf("/")).split("/").map(literal).join(String.raw`[/\\]+`);
    forms.set(`${program} ${folder}`, {
      launcher: new RegExp(String.raw`(?:^|[^\w.-])${literal(program)}(?:\.exe|\.cmd)?(?![\w.-])`, "i"),
      folder: new RegExp(String.raw`(?:^|[^\w-])${folder}(?![\w.-])`, "i"),
    });
  }
  if (forms.size === 0) throw new Error(`${file} allows no command that runs a script by its path, so a drive cannot tell AI-DLC's own tools from the agent's other commands`);
  ownTools.set(harness, [...forms.values()]);
  return [...forms.values()];
}

/** Whether a shell command runs one of AI-DLC's own tools: it names a shipped launcher and its tools folder. */
function runsAidlcTool(command: string, harness: Harness): boolean {
  return ownToolForms(harness).some(({ launcher, folder }) => launcher.test(command) && folder.test(command));
}

const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
const PATH_KEYS = ["file_path", "notebook_path", "path"] as const;

/** A path in `text` that is, or starts with, AI-DLC's records folder or the harness folder (`.claude`, `.codex`, `.aidlc`). */
function namesAidlc(text: string, harnessDir: string): boolean {
  const folder = harnessDir.replace(".", "\\.");
  return new RegExp(`(?:^|[\\s'"=(:/\\\\])(?:${folder}|aidlc)(?:[/\\\\\\s'")]|$)`).test(text);
}

/** The counted heading a read of the job log looks for, then one line for each command. */
export function folderCommandsBlock(lines: readonly string[]): string {
  return [`Shell commands that name AI-DLC folders, listed not failed (${lines.length})`, ...lines.map((line) => `  ${line}`)].join("\n");
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

/** Claude Code's prompts in a drive, split into what AI-DLC must never ask, the agent's own lines in its folders, and the rest. */
export function claudePromptProblems(requests: readonly PermissionRequest[], projectDir: string): StockPermissionReport {
  const report: StockPermissionReport = { problems: [], folderCommands: [], listed: [] };
  for (const request of requests) {
    const path = PATH_KEYS.map((key) => request.input[key]).find((value): value is string => typeof value === "string");
    const where = path === undefined ? undefined : place(path, projectDir);
    const command = request.toolName === "Bash" ? String(request.input.command ?? "") : undefined;
    if (where?.outside && WRITE_TOOLS.has(request.toolName)) {
      report.problems.push(`a write outside the project asked for permission: ${describe(request)}`);
    } else if (where && (where.top === "aidlc" || where.top === ".claude")) {
      report.problems.push(`a file tool asked for permission inside AI-DLC's folders: ${describe(request)}`);
    } else if (command !== undefined && runsAidlcTool(command, "claude")) {
      report.problems.push(`a command that runs AI-DLC's own tool asked for permission: ${describe(request)}`);
    } else if (command !== undefined && namesAidlc(command, ".claude")) {
      report.folderCommands.push(describe(request));
    } else {
      report.listed.push(describe(request));
    }
  }
  return report;
}

const REFUSED = /Read-only file system|Operation not permitted|Access is denied|Access to the path .* is denied/i;

/** The commands Codex's sandbox refused in one `codex exec --json` turn, split as Claude Code's prompts are. */
export function codexSandboxProblems(stdout: string): StockPermissionReport {
  const report: StockPermissionReport = { problems: [], folderCommands: [], listed: [] };
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
    // Quoted, so a heredoc stays one line under the heading.
    const said = `${JSON.stringify(command)} (${refusal.trim().slice(0, 200)})`;
    if (runsAidlcTool(command, "codex")) report.problems.push(`the sandbox refused a command that runs AI-DLC's own tool: ${said}`);
    else if (namesAidlc(command, ".codex")) report.folderCommands.push(said);
    else report.listed.push(said);
  }
  return report;
}

// What `opencode run` (1.18) says when the shipped table asks: with no one to
// ask, it refuses the call.
const OPENCODE_REJECTED = /rejected permission/i;

/** The calls opencode refused in one `opencode run --format json` turn, split as Claude Code's prompts are. */
export function opencodePermissionProblems(stdout: string): StockPermissionReport {
  const report: StockPermissionReport = { problems: [], folderCommands: [], listed: [] };
  for (const line of stdout.split("\n")) {
    if (!line.startsWith("{")) continue;
    let event: { type?: unknown; part?: { tool?: unknown; state?: { status?: unknown; input?: Record<string, unknown>; error?: unknown } } };
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const state = event.part?.state;
    if (event.type !== "tool_use" || state?.status !== "error" || !OPENCODE_REJECTED.test(String(state.error ?? ""))) continue;
    const input = state.input ?? {};
    const target = ["command", "filePath", "path"].map((key) => input[key]).find((value): value is string => typeof value === "string") ??
      JSON.stringify(input);
    const tool = String(event.part?.tool);
    const said = `${tool} ${JSON.stringify(target)}`;
    if (tool === "bash" && runsAidlcTool(target, "opencode")) {
      report.problems.push(`opencode refused a command that runs AI-DLC's own tool on the shipped permissions: ${said}`);
    } else if (tool === "bash" && namesAidlc(target, ".aidlc")) {
      report.folderCommands.push(said);
    } else if (namesAidlc(target, ".aidlc")) {
      report.problems.push(`opencode refused a call inside AI-DLC's folders on the shipped permissions: ${said}`);
    } else {
      report.listed.push(said);
    }
  }
  return report;
}
