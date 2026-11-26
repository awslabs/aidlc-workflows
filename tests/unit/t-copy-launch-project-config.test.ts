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
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import { aidlcInvocation, withoutBunLaunchOptions } from "../../dist/claude/.claude/tools/aidlc-runtime-paths.ts";
import { copyChannelOmits, projectionFiles } from "../../core/tools/aidlc-distribution.ts";
import { COPY_LAUNCH_CONFIG, withCopyLaunchOptions } from "../harness/copy-launch.ts";
import { cleanupTestProject, createTestProject, REPO_ROOT } from "../harness/fixtures.ts";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

// file :: enclosing function :: the launch's next word, as written.
const NOT_ENGINE_FROM_A_COPY: Readonly<Record<string, string>> = {
  "core/tools/aidlc-install-paths.ts :: activeVersion :: commandPath()": "a list of paths to resolve, not a launch",
  "core/tools/aidlc-lib.ts :: settingsBesideDecision :: ...args": "the compiled branch: the executable is the installed engine",
  "core/tools/aidlc-orchestrate.ts :: toolCommand :: ...args": "the compiled branch: the executable is the installed engine",
  "core/skills/aidlc-issue-report/scripts/collect.ts :: aidlcCommand :: join(t.dir, \"tools\", \"aidlc.ts\")":
    "the issue-report skill's scripts import no engine module and run with a plain bun from any folder, as the skill says",
};

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sources(path);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [path] : [];
  });
}

// A name a launch uses for a value, read as the value its function (or file)
// declares for it: `const command = executable ?? process.execPath`.
function valueOf(node: ts.Expression): ts.Expression {
  if (!ts.isIdentifier(node)) return node;
  let scope: ts.Node | undefined = node.parent;
  while (scope && !ts.isFunctionLike(scope) && !ts.isSourceFile(scope)) scope = scope.parent;
  let found: ts.Expression | undefined;
  const look = (at: ts.Node) => {
    if (found) return;
    if (ts.isVariableDeclaration(at) && ts.isIdentifier(at.name) && at.name.text === node.text && at.initializer) found = at.initializer;
    else ts.forEachChild(at, look);
  };
  if (scope) look(scope);
  return found ?? node;
}

// The running Bun as a launch's program: `process.execPath`, `bunExecutable()`,
// an `execPath` parameter that defaults to it, the Bun after `??` when the
// compiled engine comes first, or a name holding one of them.
function isRunningBun(node: ts.Node): boolean {
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) return isRunningBun(node.right);
  if (ts.isIdentifier(node) && node.text !== "execPath") {
    const value = valueOf(node);
    return value !== node && isRunningBun(value);
  }
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

// Each launch and its next word: the second element of `[bun, ...]`, the
// first of the argument list in `spawnSync(bun, [...])` (the list a name holds
// read as its value, and each branch of `compiled ? [...] : [...]` but the
// compiled engine's own route), or the first of `args` beside `command: bun`
// in an object a launch is built from.
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
  const recordList = (at: ts.Node, list: ts.Expression | undefined) => {
    const value = list === undefined ? undefined : valueOf(list);
    if (value !== undefined && ts.isConditionalExpression(value)) {
      for (const branch of [value.whenTrue, value.whenFalse]) recordList(at, branch);
    } else {
      record(at, value !== undefined && ts.isArrayLiteralExpression(value) ? value.elements[0] : value);
    }
  };
  const visit = (node: ts.Node) => {
    if (ts.isArrayLiteralExpression(node) && node.elements.length > 0 && isRunningBun(node.elements[0])) {
      record(node, node.elements[1]);
    } else if (
      ts.isCallExpression(node) && node.arguments.length > 0 && isRunningBun(node.arguments[0]) &&
      /^(?:spawnSync|spawn|execFileSync|execFile)$/.test(node.expression.getText().split(".").pop() ?? "")
    ) {
      recordList(node, node.arguments[1]);
    } else if (ts.isObjectLiteralExpression(node)) {
      const field = (name: string) => node.properties.find((property): property is ts.PropertyAssignment =>
        ts.isPropertyAssignment(property) && property.name.getText() === name)?.initializer;
      const command = field("command");
      if (command !== undefined && isRunningBun(command)) recordList(node, field("args"));
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
    // An agent that adds `run`, which Kiro CLI's allow entry takes after the two options.
    "bun run .claude/tools/aidlc.ts engine orchestrate next",
    "bun run .claude/tools/aidlc-state.ts approve code-generation",
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
// line to a marker file each time Bun loads it, in its own folder (`folder`)
// when a case needs a path with a space.
function copyProject(bunfig = 'preload = ["./setup.ts"]\n', folder?: string): { project: string; preloadRuns: () => number } {
  const root = createTestProject();
  projects.push(root);
  const project = folder === undefined ? root : join(root, folder);
  mkdirSync(project, { recursive: true });
  cpSync(join(REPO_ROOT, "dist", "claude", ".claude"), join(project, ".claude"), { recursive: true });
  const marker = join(project, "setup-ran.txt");
  writeFileSync(join(project, "setup.ts"), `require("fs").appendFileSync(${JSON.stringify(marker)}, "ran\\n");\n`);
  writeFileSync(join(project, "bunfig.toml"), bunfig);
  return { project, preloadRuns: () => existsSync(marker) ? readFileSync(marker, "utf-8").split("\n").length - 1 : 0 };
}

function run(project: string, command: string, cwd = project): { status: number | null; stdout: string; stderr: string } {
  const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_PROJECT_DIR: project };
  const res = spawnSync("bash", ["-c", command], {
    cwd,
    encoding: "utf-8",
    env,
    input: "{}",
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

  // As Claude Code runs them: through bash, with the project's folder in
  // CLAUDE_PROJECT_DIR, from a subfolder that holds a bunfig.toml of its own.
  test("each hook and the status line, run as Claude Code runs them, runs no preload, from a path with a space and a subfolder with its own bunfig.toml", () => {
    const { project, preloadRuns } = copyProject(undefined, "my shop");
    const web = join(project, "web");
    mkdirSync(web);
    writeFileSync(join(web, "bunfig.toml"), 'preload = ["../setup.ts"]\n');
    const settings = JSON.parse(readFileSync(join(project, ".claude", "settings.json"), "utf-8")) as { hooks: unknown };
    const statusLine = (JSON.parse(readFileSync(join(project, ".claude", "tools", "data", "harness.json"), "utf-8")) as {
      statusLine: { command: string };
    }).statusLine.command;
    const commands = [...new Set([...registeredCommands(settings.hooks), statusLine])];
    expect(commands.length).toBeGreaterThan(10);
    for (const command of commands) run(project, command, web);
    expect(preloadRuns()).toBe(0);
    // The same hook without the two options runs the subfolder's preload, so the marker can see one.
    run(project, withoutBunLaunchOptions(commands[0]), web);
    expect(preloadRuns()).toBe(1);
  });

  test("a dispatcher started without the options runs the preload once, and the hook it starts does not", () => {
    const { project, preloadRuns } = copyProject();
    run(project, "bun .claude/tools/aidlc.ts engine hook session-start");
    expect(preloadRuns()).toBe(1);
  });

  test("a refresh over a copy set up before this release puts back AI-DLC's hooks with the options, keeps the person's own, and adds none twice", () => {
    const { project } = copyProject();
    const settingsPath = join(project, ".claude", "settings.json");
    const shipped = registeredCommands((JSON.parse(readFileSync(settingsPath, "utf-8")) as { hooks: unknown }).hooks);
    // The older registrations, and a hook of the person's own.
    const older = JSON.parse(readFileSync(settingsPath, "utf-8")) as {
      hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ type: string; command: string }> }>>;
    };
    for (const group of Object.values(older.hooks)) {
      for (const entry of group) for (const hook of entry.hooks) hook.command = withoutBunLaunchOptions(hook.command);
    }
    older.hooks.PreToolUse.push({ matcher: "Bash", hooks: [{ type: "command", command: "bun scripts/my-check.ts" }] });
    writeFileSync(settingsPath, `${JSON.stringify(older, null, 2)}\n`);
    expect(registeredCommands(older.hooks).filter((command) => command.includes("--no-env-file"))).toEqual([]);

    const runtime = join(createTestProject(), "claude");
    projects.push(runtime);
    const release = join(REPO_ROOT, "dist", "claude");
    cpSync(release, runtime, { recursive: true });
    for (const path of copyChannelOmits(projectionFiles(release).descriptor)) rmSync(join(runtime, path), { force: true });
    const refreshed = run(project, `${aidlcInvocation()} config --from ${JSON.stringify(runtime)} --harness claude --mcp none --yes`);
    expect(refreshed.status, `${refreshed.stdout}${refreshed.stderr}`).toBe(0);

    const after = registeredCommands((JSON.parse(readFileSync(settingsPath, "utf-8")) as { hooks: unknown }).hooks);
    expect(after.filter((command) => command !== "bun scripts/my-check.ts").sort()).toEqual([...shipped].sort());
    expect(after.filter((command) => command === "bun scripts/my-check.ts")).toHaveLength(1);
    expect(preloadRows(doctorChecks(project, `${aidlcInvocation()} doctor`))).toEqual([]);
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

  test("doctor, run as printed from a project folder whose name holds an apostrophe or an ampersand, says nothing of it", () => {
    const { project } = copyProject(undefined, "Kate's R&D; shop");
    expect(preloadRows(doctorChecks(project, `${aidlcInvocation()} doctor`))).toEqual([]);
  });

  test("the native tree prints plain bun where a copy tree prints the two options", async () => {
    const copy = await import(join(REPO_ROOT, "dist", "copilot", ".aidlc", "tools", "aidlc-runtime-paths.ts"));
    const native = await import(join(REPO_ROOT, "dist-release", "copilot", ".aidlc", "tools", "aidlc-runtime-paths.ts"));
    expect(copy.bunLaunchFor(".aidlc")).toBe(`bun --config=.aidlc/tools/${COPY_LAUNCH_CONFIG} --no-env-file`);
    expect(native.bunLaunchFor(".aidlc")).toBe("bun");
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

describe("t-copy-launch-project-config: every copy allowlist pre-approves the new shape, and only it", () => {
  const prefix = (dir: string) => `bun --config=${dir}/tools/${COPY_LAUNCH_CONFIG} --no-env-file `;
  const json = (harness: string, file: string) => JSON.parse(readFileSync(join(REPO_ROOT, "dist", harness, file), "utf-8"));

  test("Claude Code and Cursor: every bun entry names the launch with its two options", () => {
    const claude = (json("claude", ".claude/settings.json").permissions.allow as string[]).filter((entry) => entry.startsWith("Bash(bun "));
    const cursor = (json("cursor", ".cursor/cli.json").permissions.allow as string[]).filter((entry) => entry.startsWith("Shell(bun"));
    expect(claude.length).toBeGreaterThan(50);
    expect(cursor.length).toBeGreaterThan(50);
    expect(claude.filter((entry) => !entry.startsWith(`Bash(${prefix(".claude")}.claude/tools/`))).toEqual([]);
    expect(cursor.filter((entry) => !entry.startsWith(`Shell(bun:${prefix(".cursor").slice("bun ".length)}.cursor/tools/`))).toEqual([]);
  });

  test("Kiro CLI: the engine rule matches the new spelling whole, and no rule matches today's", () => {
    const allowed = json("kiro", ".kiro/agents/aidlc.json").toolsSettings.execute_bash.allowedCommands as string[];
    const matches = (command: string) => allowed.filter((rule) => new RegExp(`^(?:${rule})$`).test(command));
    expect(matches(`${prefix(".kiro")}.kiro/tools/aidlc.ts engine orchestrate next`).length).toBeGreaterThan(0);
    expect(matches("bun .kiro/tools/aidlc.ts engine orchestrate next")).toEqual([]);
  });

  test("Kiro IDE: every shell rule naming AI-DLC's tools names the new spelling", () => {
    const dir = join(REPO_ROOT, "dist", "kiro-ide", ".kiro", "agents");
    const lines = readdirSync(dir).filter((name) => name.endsWith(".md"))
      .flatMap((name) => readFileSync(join(dir, name), "utf-8").split("\n"))
      .filter((line) => /^\s+- "bun \S*\.kiro\/tools\//.test(line) || /^\s+- "bun --config=/.test(line));
    expect(lines.length).toBeGreaterThan(50);
    expect(lines.filter((line) => !line.includes(`"${prefix(".kiro")}.kiro/tools/`))).toEqual([]);
  });

  test("opencode: the bun allow names the new spelling only", () => {
    const bash = json("opencode", "opencode.json").permission.bash as Record<string, string>;
    expect(bash[`${prefix(".aidlc")}.aidlc/tools/*`]).toBe("allow");
    expect(bash["bun .aidlc/tools/*"]).toBeUndefined();
  });

  const codexOnPath = spawnSync("codex", ["--version"], { encoding: "utf-8" }).status === 0;
  test.skipIf(!codexOnPath)("Codex's own evaluator allows the new spelling and not today's", () => {
    const rules = join(REPO_ROOT, "dist", "codex", ".codex", "rules", "default.rules");
    // Codex makes a tmp folder in its home even for this check: a scratch one, never the person's.
    const codexHome = createTestProject();
    projects.push(codexHome);
    const decision = (argv: string[]) => {
      const res = spawnSync("codex", ["execpolicy", "check", "--rules", rules, "--", ...argv], {
        encoding: "utf-8",
        env: { ...process.env, CODEX_HOME: codexHome },
      });
      return (JSON.parse(res.stdout) as { decision?: string }).decision ?? "none";
    };
    const flagged = prefix(".codex").trim().split(" ");
    expect(decision([...flagged, ".codex/tools/aidlc.ts", "engine", "orchestrate", "next"])).toBe("allow");
    expect(decision([...flagged, ".codex/tools/aidlc-worktree.ts", "merge", "--slug", "u1"])).toBe("allow");
    expect(decision(["bun", ".codex/tools/aidlc.ts", "engine", "orchestrate", "next"])).not.toBe("allow");
    expect(decision(["bun", "--config=other.toml", "--no-env-file", ".codex/tools/aidlc.ts", "engine", "orchestrate", "next"])).not.toBe("allow");
  });
});
