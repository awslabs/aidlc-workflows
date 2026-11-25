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
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
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
import { withCopyLaunchOptions } from "../harness/copy-launch.ts";
import { REPO_ROOT } from "../harness/fixtures.ts";

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
