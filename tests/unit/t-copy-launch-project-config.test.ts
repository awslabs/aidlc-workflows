// covers: file:core/tools/aidlc-runtime-paths.ts, file:core/tools/aidlc.ts
//
// A copy install runs its engine with Bun inside the person's project, and
// Bun reads the project's bunfig.toml and .env files for every process it
// starts there. The engine's own launches pass Bun the two options that keep
// them out, and so must every Bun child of engine code the engine starts (a
// tool the dispatcher runs, a hook an adapter runs, a sibling tool), since a
// child is a new Bun process that reads them again. This pin reads every
// launch of the running Bun under core/ and harness/ with the TypeScript
// parser: each one whose next word is not a compiled route word carries
// `...bunLaunchFlags()` right after the executable, or is named below with the
// reason it starts no engine code from a copy tree. And every reader of a
// command (the Stop hook's reading of engine work, the stage graph rebuild,
// the fold mode, the refresh that tells AI-DLC's hook entries and status line
// from the person's) reads a copy launch the same with the two options as
// without them, so a launch AI-DLC prints with them is still its own.
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import * as ts from "typescript";
import { isLifecycleBoundaryCommand } from "../../dist/claude/.claude/hooks/aidlc-state-transition-guard.ts";
import { aidlcHookTarget } from "../../dist/claude/.claude/tools/aidlc-distribution.ts";
import {
  classifyRuntimeCompileCommand,
  isEngineEngagementSegment,
  isEngineToolCall,
  isStageWorkLogCall,
  literalOrchestrateVerb,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { isAidlcClaudeStatusLine } from "../../dist/claude/.claude/tools/aidlc-statusline-choice.ts";
import { aidlcInvocation } from "../../dist/claude/.claude/tools/aidlc-runtime-paths.ts";
import { COPY_LAUNCH_CONFIG, withCopyLaunchOptions } from "../harness/copy-launch.ts";
import { cleanupTestProject, createTestProject, REPO_ROOT } from "../harness/fixtures.ts";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

// file :: enclosing function :: the launch's next word, as written.
const NOT_ENGINE_FROM_A_COPY: Readonly<Record<string, string>> = {
  "core/tools/aidlc-install-paths.ts :: activeVersion :: commandPath()": "a list of paths to resolve, not a launch",
  "core/tools/aidlc-lib.ts :: settingsBesideDecision :: ...args": "the compiled branch: the executable is the installed engine",
  "core/tools/aidlc-orchestrate.ts :: toolCommand :: ...args": "the compiled branch: the executable is the installed engine",
};

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sources(path);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [path] : [];
  });
}

// The running Bun as a launch's program: `process.execPath`, `bunExecutable()`,
// or an `execPath` parameter that defaults to it.
function isRunningBun(node: ts.Node): boolean {
  if (ts.isPropertyAccessExpression(node)) {
    return ts.isIdentifier(node.expression) && node.expression.text === "process" && node.name.text === "execPath";
  }
  if (ts.isCallExpression(node)) return ts.isIdentifier(node.expression) && node.expression.text === "bunExecutable";
  return ts.isIdentifier(node) && node.text === "execPath";
}

function enclosingName(node: ts.Node): string {
  for (let at: ts.Node | undefined = node.parent; at; at = at.parent) {
    if ((ts.isFunctionDeclaration(at) || ts.isMethodDeclaration(at)) && at.name) return at.name.getText();
    if ((ts.isArrowFunction(at) || ts.isFunctionExpression(at)) && ts.isVariableDeclaration(at.parent)) {
      return at.parent.name.getText();
    }
  }
  return "(top level)";
}

type Launch = { key: string; flagged: boolean };

// Each launch and its next word: the second element of `[bun, ...]`, or the
// first of the argument list in `spawnSync(bun, [...])`.
function launches(file: string): Launch[] {
  const text = readFileSync(file, "utf-8");
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const found: Launch[] = [];
  const record = (at: ts.Node, next: ts.Expression | undefined) => {
    // No next word, or a literal one (`"engine"`, an internal flag): the compiled engine's own route.
    if (next === undefined || ts.isStringLiteralLike(next)) return;
    const flagged = ts.isSpreadElement(next) && ts.isCallExpression(next.expression) &&
      ts.isIdentifier(next.expression.expression) && next.expression.expression.text === "bunLaunchFlags";
    const where = relative(REPO_ROOT, file).replaceAll("\\", "/");
    found.push({ key: `${where} :: ${enclosingName(at)} :: ${next.getText().replace(/\s+/g, " ")}`, flagged });
  };
  const visit = (node: ts.Node) => {
    if (ts.isArrayLiteralExpression(node) && node.elements.length > 0 && isRunningBun(node.elements[0])) {
      record(node, node.elements[1]);
    } else if (
      ts.isCallExpression(node) && node.arguments.length > 0 && isRunningBun(node.arguments[0]) &&
      /^(?:spawnSync|spawn|execFileSync|execFile)$/.test(node.expression.getText().split(".").pop() ?? "")
    ) {
      const args = node.arguments[1];
      record(node, args && ts.isArrayLiteralExpression(args) ? args.elements[0] : args);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe("t-copy-launch-project-config: every Bun child of engine code gets the copy launch's options", () => {
  test("no launch of the running Bun under core/ or harness/ starts engine code without them", () => {
    const all = ["core", "harness"].flatMap((root) => sources(join(REPO_ROOT, root))).flatMap(launches);
    // A parser that stopped finding launches would pass on nothing.
    expect(all.length).toBeGreaterThan(30);
    const missing = all.filter((launch) => !launch.flagged && !(launch.key in NOT_ENGINE_FROM_A_COPY)).map((launch) => launch.key);
    expect(missing).toEqual([]);
  });

  test("every launch named as not engine code is still there to name", () => {
    const keys = new Set(["core", "harness"].flatMap((root) => sources(join(REPO_ROOT, root))).flatMap(launches).map((launch) => launch.key));
    expect(Object.keys(NOT_ENGINE_FROM_A_COPY).filter((key) => !keys.has(key))).toEqual([]);
  });
});

describe("t-copy-launch-project-config: a copy launch reads the same with its two Bun options", () => {
  // Commands the engine prints or the agent runs, each in its copy spelling.
  const commands = [
    "bun .claude/tools/aidlc.ts engine orchestrate next",
    "bun .claude/tools/aidlc.ts engine orchestrate report --stage code-generation --result approved --user-input Approve",
    "bun .claude/tools/aidlc-orchestrate.ts next --status",
    "bun .claude/tools/aidlc.ts engine log answer --stage requirements-analysis --questions-file q.md",
    "bun .claude/tools/aidlc.ts engine state approve code-generation",
    "bun .claude/tools/aidlc-state.ts approve code-generation",
    "bun .claude/tools/aidlc.ts engine runtime compile",
    "bun .claude/tools/aidlc-jump.ts execute --to requirements-analysis",
  ];
  const readers: ReadonlyArray<[string, (command: string) => unknown]> = [
    ["isEngineToolCall", (command) => isEngineToolCall("Bash", { command })],
    ["literalOrchestrateVerb", literalOrchestrateVerb],
    ["classifyRuntimeCompileCommand", classifyRuntimeCompileCommand],
    ["isStageWorkLogCall", (command) => isStageWorkLogCall("Bash", { command })],
    ["isEngineEngagementSegment", (command) => isEngineEngagementSegment(command)],
    ["isLifecycleBoundaryCommand", isLifecycleBoundaryCommand],
  ];
  for (const [name, read] of readers) {
    test(`${name} reads each command alike`, () => {
      const differs = commands.filter((command) => JSON.stringify(read(withCopyLaunchOptions(command))) !== JSON.stringify(read(command)));
      expect(differs).toEqual([]);
    });
  }

  const hooks = [
    'bun "$CLAUDE_PROJECT_DIR/.claude/tools/aidlc.ts" engine hook guard-tool-call',
    'bun "$CLAUDE_PROJECT_DIR/.claude/tools/aidlc.ts" engine hook record-human-turn',
    'bun "$CLAUDE_PROJECT_DIR/.claude/tools/aidlc.ts" engine statusline',
  ];
  test("a hook or status line with the options is still AI-DLC's own entry", () => {
    for (const command of hooks) {
      expect(aidlcHookTarget(withCopyLaunchOptions(command)), command).toBe(aidlcHookTarget(command));
    }
    const statusLine = { type: "command", command: hooks[2] };
    expect(isAidlcClaudeStatusLine({ ...statusLine, command: withCopyLaunchOptions(statusLine.command) })).toBe(true);
  });
});

// The copy trees the packager builds, by harness folder.
const COPY_TREES: ReadonlyArray<[string, string]> = [
  ["claude", ".claude"], ["codex", ".codex"], ["cursor", ".cursor"], ["kiro", ".kiro"],
  ["kiro-ide", ".kiro"], ["opencode", ".aidlc"], ["copilot", ".aidlc"],
];
const CONFIG_LINE = "# AI-DLC starts its own Bun with this file in place of your project's bunfig.toml. It holds no settings on purpose.\n";

const projects: string[] = [];
afterAll(() => {
  for (const project of projects) cleanupTestProject(project);
});

// A Claude Code copy project whose bunfig.toml preloads a file that appends a
// line to a marker file each time Bun loads it.
function copyProject(bunfig = 'preload = ["./setup.ts"]\n'): { project: string; preloadRuns: () => number } {
  const project = createTestProject();
  projects.push(project);
  cpSync(join(REPO_ROOT, "dist", "claude", ".claude"), join(project, ".claude"), { recursive: true });
  const marker = join(project, "setup-ran.txt");
  writeFileSync(join(project, "setup.ts"), `require("fs").appendFileSync(${JSON.stringify(marker)}, "ran\\n");\n`);
  writeFileSync(join(project, "bunfig.toml"), bunfig);
  return { project, preloadRuns: () => existsSync(marker) ? readFileSync(marker, "utf-8").split("\n").length - 1 : 0 };
}

function run(project: string, command: string): { status: number | null; stdout: string; stderr: string } {
  const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_PROJECT_DIR: project };
  const res = spawnSync("sh", ["-c", command], {
    cwd: project,
    encoding: "utf-8",
    env,
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

type DoctorCheck = { pass: boolean; label: string; fix?: string; severity?: string };
function doctorChecks(project: string, command: string): DoctorCheck[] {
  const res = run(project, `${command} --json`);
  return (JSON.parse(res.stdout) as { data: { checks: DoctorCheck[] } }).data.checks;
}
const preloadRows = (checks: DoctorCheck[]) => checks.filter((check) => check.label.startsWith("Your project's bunfig.toml preloads"));

// Every command string a hook registration file holds (`command`, and Copilot's `bash` and `powershell`).
function registeredCommands(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(registeredCommands);
  if (!value || typeof value !== "object") return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, item]) =>
    typeof item === "string" && ["command", "bash", "powershell"].includes(key) ? [item] : registeredCommands(item));
}

describe("t-copy-launch-project-config: a copy install's own launches keep the project's bunfig.toml and .env out", () => {
  test("every copy tree holds the empty config file, and no native tree does", () => {
    for (const [harness, dir] of COPY_TREES) {
      const file = join(REPO_ROOT, "dist", harness, dir, "tools", COPY_LAUNCH_CONFIG);
      expect(existsSync(file) ? readFileSync(file, "utf-8") : null, harness).toBe(CONFIG_LINE);
      expect(existsSync(join(REPO_ROOT, "dist-release", harness, dir, "tools", COPY_LAUNCH_CONFIG)), harness).toBe(false);
    }
  });

  test("every hook and status line a copy tree registers starts Bun with the two options", () => {
    const files: ReadonlyArray<[string, string]> = [
      ["claude", ".claude/settings.json"], ["claude", ".claude/tools/data/harness.json"], ["codex", ".codex/hooks.json"],
      ["cursor", ".cursor/hooks.json"], ["copilot", ".github/hooks/aidlc.json"], ["kiro", ".kiro/agents/aidlc.json"],
      ["kiro-ide", ".kiro/hooks/aidlc-guard-tool-call.json"],
    ];
    const plain: string[] = [];
    for (const [harness, file] of files) {
      const commands = registeredCommands(JSON.parse(readFileSync(join(REPO_ROOT, "dist", harness, file), "utf-8")));
      expect(commands.length, `${harness} ${file}`).toBeGreaterThan(0);
      for (const command of commands) {
        if (/^bun /.test(command) && !/^bun "?--config=\S*\/tools\/aidlc-bunfig\.toml"? --no-env-file /.test(command)) plain.push(`${harness} ${file}: ${command}`);
      }
    }
    expect(plain).toEqual([]);
  });

  test("doctor, run as a copy install prints it, runs no preload of the project's", () => {
    const { project, preloadRuns } = copyProject();
    run(project, `${aidlcInvocation()} doctor`);
    expect(aidlcInvocation()).toStartWith(`bun --config=.claude/tools/${COPY_LAUNCH_CONFIG} --no-env-file `);
    expect(preloadRuns()).toBe(0);
  });

  test("doctor says once when AI-DLC's hooks here start Bun without the options, with the setup line that fixes it", () => {
    const { project } = copyProject();
    const settingsPath = join(project, ".claude", "settings.json");
    const flagged = `bun "--config=$CLAUDE_PROJECT_DIR/.claude/tools/${COPY_LAUNCH_CONFIG}" --no-env-file `;
    writeFileSync(settingsPath, readFileSync(settingsPath, "utf-8").replaceAll(JSON.stringify(flagged).slice(1, -1), "bun "));
    const rows = preloadRows(doctorChecks(project, `${aidlcInvocation()} doctor`));
    expect(rows.map((row) => row.label)).toEqual([
      "Your project's bunfig.toml preloads ./setup.ts, and AI-DLC's hooks here were set up before AI-DLC kept that file out of its own runs, so the preload still runs inside each hook",
    ]);
    expect(rows[0].fix).toBe(
      `run \`${aidlcInvocation()} config --harness claude --from <the runtime/claude root you copied from>\` to put back AI-DLC's hooks (your own hooks are kept)`,
    );
  });

  test("doctor says once when it was itself started without the options, with the command that runs it the same way", () => {
    const { project } = copyProject();
    const rows = preloadRows(doctorChecks(project, "bun .claude/tools/aidlc.ts doctor"));
    expect(rows.map((row) => row.label)).toEqual([
      "Your project's bunfig.toml preloads ./setup.ts, and this command was typed without AI-DLC's two Bun options, so the preload ran inside this doctor run",
    ]);
    expect(rows[0].fix).toBe(
      `AI-DLC's own hooks and commands pass them; to run doctor the same way: \`bun --config=.claude/tools/${COPY_LAUNCH_CONFIG} --no-env-file .claude/tools/aidlc.ts doctor\``,
    );
  });

  test("doctor names at most three preloads, then how many more", () => {
    const { project } = copyProject('preload = ["./setup.ts", "./b.ts", "./c.ts", "./d.ts"]\n');
    for (const name of ["b.ts", "c.ts", "d.ts"]) writeFileSync(join(project, name), "");
    const [row] = preloadRows(doctorChecks(project, "bun .claude/tools/aidlc.ts doctor"));
    expect(row?.label).toStartWith("Your project's bunfig.toml preloads ./setup.ts, ./b.ts, ./c.ts and 1 more, ");
  });

  test("doctor says nothing of it when every launch has the options, or nothing is preloaded for a script", () => {
    for (const bunfig of ['preload = ["./setup.ts"]\n', '[test]\npreload = ["./setup.ts"]\n', ""]) {
      const { project } = copyProject(bunfig);
      expect(preloadRows(doctorChecks(project, `${aidlcInvocation()} doctor`)), bunfig).toEqual([]);
    }
    const { project } = copyProject('[test]\npreload = ["./setup.ts"]\n');
    expect(preloadRows(doctorChecks(project, "bun .claude/tools/aidlc.ts doctor"))).toEqual([]);
  });
});
