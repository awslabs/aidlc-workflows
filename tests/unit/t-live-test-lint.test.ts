// covers: harness-instrument:live-test-lint
//
// Live tests assert what the person meets or what the engine recorded, never
// the route the agent happened to take (tests/README.md, "Live tests: what to
// assert"). This lint reads every live test file (scripts/ci-live-filter.ts
// discoverLiveFiles) with the TypeScript parser and rejects four shapes the
// 2026-10-14 flake study found behind its reds, unless the line, or a comment
// right above it, says `// person-facing: <what the person sees>`.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as ts from "typescript";
import { discoverLiveFiles } from "../../scripts/ci-live-filter.ts";
import { REPO_ROOT } from "../harness/fixtures.ts";

type Check =
  | "the agent's own words"
  | "a fixed sleep"
  | "a fixed bound on a measured time"
  | "the order or count of the agent's tool calls";

interface Finding {
  file: string;
  line: number;
  check: Check;
  /** The asserted value as written: what a known entry names. */
  subject: string;
}

const AGENT_WORDS = new Set(["assistantText", "assistantTextBeforeFirstAsk"]);
const MEASURED = /(?:Ms|_ms|Seconds|_seconds|Elapsed|elapsed)$/;
const TOOL_CALLS = /(?:Calls|Commands|Reports|Invocations|toolCalls|toolResults)$/;
const TOOL_INDEX = /\b(?:readIndex|findIndex|indexOf)\b[\s\S]*?(?:toolResults|toolCalls|[cC]ommands|Reports)\b|(?:toolResults|toolCalls|[cC]ommands|Reports)\b[\s\S]*?\b(?:findIndex|indexOf)\b/;
const LOOPS = new Set([
  ts.SyntaxKind.WhileStatement, ts.SyntaxKind.DoStatement, ts.SyntaxKind.ForStatement,
  ts.SyntaxKind.ForOfStatement, ts.SyntaxKind.ForInStatement,
]);
const FUNCTIONS = new Set([
  ts.SyntaxKind.FunctionDeclaration, ts.SyntaxKind.FunctionExpression, ts.SyntaxKind.ArrowFunction, ts.SyntaxKind.MethodDeclaration,
]);

/** The last name of `a.b?.c`, `Number(a.b)` or `a`. */
function finalName(node: ts.Expression): string | undefined {
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && ["Number", "parseFloat", "parseInt"].includes(node.expression.text)) {
    return node.arguments[0] ? finalName(node.arguments[0]) : undefined;
  }
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isNonNullExpression(node) || ts.isParenthesizedExpression(node)) return finalName(node.expression);
  return undefined;
}

/** `expect(subject, ...).<matcher>(bound)`, when node is one. */
function assertion(node: ts.Node): { subject: ts.Expression; matcher: string; bound?: ts.Expression } | undefined {
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return undefined;
  let target: ts.Expression = node.expression.expression;
  if (ts.isPropertyAccessExpression(target) && target.name.text === "not") target = target.expression;
  if (!ts.isCallExpression(target) || !ts.isIdentifier(target.expression) || target.expression.text !== "expect") return undefined;
  const [subject] = target.arguments;
  return subject ? { subject, matcher: node.expression.name.text, bound: node.arguments[0] } : undefined;
}

function insideWaitLoop(node: ts.Node): boolean {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (LOOPS.has(parent.kind)) return true;
    if (FUNCTIONS.has(parent.kind)) return false;
  }
  return false;
}

function isSleep(call: ts.Expression): boolean {
  if (ts.isNewExpression(call) && ts.isIdentifier(call.expression) && call.expression.text === "Promise") {
    return /\bsetTimeout\s*\(/.test(call.getText());
  }
  if (!ts.isCallExpression(call)) return false;
  const callee = call.expression.getText();
  return ["Bun.sleep", "Bun.sleepSync", "sleep", "sleepSync"].includes(callee);
}

export function lintLiveTest(file: string, source: string): Finding[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const findings: Finding[] = [];
  const toolIndexes = new Set<string>();
  const add = (node: ts.Node, check: Check, subject: ts.Node | string) => findings.push({
    file, check,
    line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
    subject: typeof subject === "string" ? subject : subject.getText(sf).replace(/\s+/g, " "),
  });
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && TOOL_INDEX.test(node.initializer.getText(sf))) {
      toolIndexes.add(node.name.text);
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "assertAssistantTextContains__DANGER_NONDETERMINISTIC") {
      add(node, "the agent's own words", node.expression);
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "expect") {
      const words = (n: ts.Node): boolean =>
        ((ts.isIdentifier(n) || ts.isPrivateIdentifier(n)) && AGENT_WORDS.has(n.text)) || ts.forEachChild(n, words) === true;
      if (node.arguments[0] && words(node.arguments[0])) add(node, "the agent's own words", node.arguments[0]);
    }
    if (ts.isAwaitExpression(node) && isSleep(node.expression) && !insideWaitLoop(node)) add(node, "a fixed sleep", node.expression);
    if (ts.isExpressionStatement(node) && ts.isCallExpression(node.expression) && /^(?:Bun\.)?sleepSync$/.test(node.expression.expression.getText(sf)) &&
        !insideWaitLoop(node)) {
      add(node, "a fixed sleep", node.expression);
    }
    const asserted = assertion(node);
    if (asserted) {
      const { subject, matcher, bound } = asserted;
      const name = finalName(subject);
      const fixed = bound !== undefined && (ts.isNumericLiteral(bound) || (ts.isIdentifier(bound) && /^[A-Z][A-Z0-9_]*$/.test(bound.text)));
      if (/^toBeLessThan(?:OrEqual)?$/.test(matcher) && fixed && !ts.isIdentifier(subject) && name && MEASURED.test(name)) {
        add(node, "a fixed bound on a measured time", subject);
      }
      const counted = ts.isPropertyAccessExpression(subject) && subject.name.text === "length" ? finalName(subject.expression) : undefined;
      if ((matcher === "toHaveLength" && name && TOOL_CALLS.test(name)) ||
          (["toBe", "toEqual"].includes(matcher) && counted && TOOL_CALLS.test(counted))) {
        add(node, "the order or count of the agent's tool calls", subject);
      }
      if (/^toBe(?:Greater|Less)Than(?:OrEqual)?$/.test(matcher) && name && toolIndexes.has(name) &&
          bound && ts.isIdentifier(bound) && toolIndexes.has(bound.text)) {
        add(node, "the order or count of the agent's tool calls", subject);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return findings;
}

/**
 * A finding passes when its line, or the comment above a run of `expect`
 * lines it heads, says `// person-facing: <reason>`.
 */
function personFacing(source: string, line: number): boolean {
  const lines = source.split(/\r?\n/);
  const reason = /\/\/\s*person-facing:\s*\S/;
  if (reason.test(lines[line - 1] ?? "")) return true;
  for (let index = line - 2; index >= 0; index--) {
    const text = lines[index].trim();
    if (reason.test(text)) return true;
    if (!text.startsWith("expect(")) return false;
  }
  return false;
}

// Checks of the agent's own route that predate this lint, each with what
// would replace it. The list only shrinks: an entry whose line is gone fails
// below, so a rewrite removes it here too.
const KNOWN: ReadonlyArray<{ file: string; check: Check; subject: string; instead: string }> = [
  {
    file: "tests/integration/t238-user-stories-mob.sdk.test.ts",
    check: "the order or count of the agent's tool calls",
    subject: "approvedIndex",
    instead: "the record: STAGE_AWAITING_APPROVAL before GATE_APPROVED for user-stories",
  },
  {
    file: "tests/e2e/t-acp-kiro-compose-inflight.serial.test.ts",
    check: "the order or count of the agent's tool calls",
    subject: "composerIndex",
    instead: "the record: the composer's dispatch after the engine's compose directive",
  },
  {
    file: "tests/e2e/t-acp-kiro-rule-preload.serial.test.ts",
    check: "the order or count of the agent's tool calls",
    subject: "result.toolCalls",
    instead: "the native crew run's own record of its stages",
  },
];

const known = (finding: Finding) =>
  KNOWN.some((entry) => entry.file === finding.file && entry.check === finding.check && entry.subject === finding.subject);

describe("t-live-test-lint", () => {
  test("every live test file checks what the person meets or what the engine recorded", () => {
    const files = [...discoverLiveFiles(REPO_ROOT).keys()].filter((file) => !file.startsWith("tests/unit/"));
    expect(files.length).toBeGreaterThan(50);
    const found: Finding[] = [];
    for (const file of files) {
      const source = readFileSync(join(REPO_ROOT, file), "utf8");
      found.push(...lintLiveTest(file, source).filter((finding) => !personFacing(source, finding.line)));
    }
    const describe = (finding: Finding) => `${finding.file}:${finding.line}: ${finding.check} (${finding.subject})`;
    expect(found.filter((finding) => !known(finding)).map(describe), "say why the person meets it, or assert the outcome or the record").toEqual([]);
    const stale = KNOWN.filter((entry) => !found.some((finding) =>
      finding.file === entry.file && finding.check === entry.check && finding.subject === entry.subject));
    expect(stale.map((entry) => `${entry.file}: ${entry.subject}`), "rewritten: remove it from KNOWN").toEqual([]);
  });

  describe("the checks", () => {
    const checks = (source: string) => lintLiveTest("t-x.test.ts", source).map((finding) => finding.check);

    test("the agent's own words are flagged; the record and an asked question are not", () => {
      expect(checks("expect(r.assistantText).toContain('Approve');")).toEqual(["the agent's own words"]);
      expect(checks("const { assistantText } = r;\nexpect(assistantText).toMatch(/1\\./);")).toEqual(["the agent's own words"]);
      expect(checks("assertAssistantTextContains__DANGER_NONDETERMINISTIC(r, 'x');")).toEqual(["the agent's own words"]);
      expect(checks("expect(r.askedQuestions.length).toBe(1);\nexpect(stageEvents(p, 'STAGE_COMPLETED', 's')).toBe(1);")).toEqual([]);
    });

    test("a fixed sleep is flagged; a poll inside a wait loop and a fixture's code are not", () => {
      expect(checks("await Bun.sleep(1000);")).toEqual(["a fixed sleep"]);
      expect(checks("await new Promise((r) => setTimeout(r, 500));")).toEqual(["a fixed sleep"]);
      expect(checks("await sleep(600);")).toEqual(["a fixed sleep"]);
      expect(checks("Bun.sleepSync(5);")).toEqual(["a fixed sleep"]);
      expect(checks("while (!done()) { await Bun.sleep(50); }")).toEqual([]);
      expect(checks("for (;;) { if (ready()) break; await new Promise((r) => setTimeout(r, 25)); }")).toEqual([]);
      expect(checks("const sleep = (ms) => new Promise((r) => setTimeout(r, ms));")).toEqual([]);
      expect(checks("const fixture = `await Bun.sleep(20);`;")).toEqual([]);
    });

    test("a fixed bound on a measured time is flagged; the call's own bound and budgets are not", () => {
      expect(checks("expect(Number(settled.json?.waited_ms)).toBeLessThan(900);")).toEqual(["a fixed bound on a measured time"]);
      expect(checks("expect(sample.startupWallMs).toBeLessThanOrEqual(STARTUP_WALL_BOUND_MS);")).toEqual(["a fixed bound on a measured time"]);
      expect(checks("expect(sample.startupWallMs).toBeLessThan(first.startupWallMs * 3);")).toEqual([]);
      expect(checks("expect(parentTimeoutMs).toBeLessThan(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);")).toEqual([]);
      expect(checks("expect(message.length).toBeLessThan(13_000);")).toEqual([]);
    });

    test("the order or count of the agent's tool calls is flagged; the record's order and a check that one ran are not", () => {
      expect(checks("expect(result.toolCalls).toHaveLength(2);")).toEqual(["the order or count of the agent's tool calls"]);
      expect(checks("expect(reportCommands.length).toBe(1);")).toEqual(["the order or count of the agent's tool calls"]);
      expect(checks([
        "const leadIndex = readIndex(result.toolResults, lead);",
        "const stageIndex = readIndex(result.toolResults, stage);",
        "expect(stageIndex).toBeGreaterThan(leadIndex);",
      ].join("\n"))).toEqual(["the order or count of the agent's tool calls"]);
      expect(checks([
        "const targetIndex = rows.findIndex((row) => row.slug === target);",
        "const currentIndex = rows.findIndex((row) => row.slug === current);",
        "expect(currentIndex).toBeGreaterThanOrEqual(targetIndex);",
      ].join("\n"))).toEqual([]);
      expect(checks("const leadIndex = readIndex(result.toolResults, lead);\nexpect(leadIndex).toBeGreaterThanOrEqual(0);")).toEqual([]);
    });

    test("a person-facing reason on the line, or above a run of expects, lets a line through", () => {
      const source = [
        "// person-facing: on Kiro ACP the question is the agent's numbered prose",
        "expect(r.assistantText).toMatch(/1\\./);",
        "expect(r.assistantText).toMatch(/2\\./);",
        "",
        "expect(r.assistantText).toMatch(/3\\./);",
        "expect(r.assistantText).toMatch(/4\\./); // person-facing: the fourth option is Other",
      ].join("\n");
      const passed = lintLiveTest("t-x.test.ts", source).filter((finding) => personFacing(source, finding.line)).map((finding) => finding.line);
      expect(passed).toEqual([2, 3, 6]);
    });
  });
});
