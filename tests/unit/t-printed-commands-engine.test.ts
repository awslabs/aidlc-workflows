// covers: harness-instrument:printed-commands-renderer, function:constructionPolicyRecovery
//
// A command or next step a tool prints goes through the renderer its kind has:
// aidlcInvocation() for the install's command, aidlcDispatcherInvocation() or
// aidlcToolInvocation() for an engine command the agent runs, and the
// {{INVOKE}} token in shipped prose. A hand-written `aidlc <noun>` runs on no
// copy install, and a bare tool file (`aidlc-state.ts unit resume`,
// `aidlc-unit pin`) runs on no install at all. This pin reads every string and
// template literal under core/tools with the TypeScript parser and counts the
// hand-written commands in each file: the sites fixed so far stay fixed and a
// new one fails, while the count of sites not yet moved (and the lines that
// only look like a command: an error label naming the step that failed, an
// audit heading, a native-only lifecycle verb) can only fall.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as ts from "typescript";
import { constructionPolicyRecovery } from "../../dist/claude/.claude/tools/aidlc-guard-operation.ts";
import { REPO_ROOT } from "../harness/fixtures.ts";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS } from "../harness/test-budget.ts";

// Parsing every tool takes longer than bun's default case timeout.
setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const TOOLS = join(REPO_ROOT, "core", "tools");
const PROTOCOLS = join(REPO_ROOT, "core", "aidlc-common", "protocols");

// A bare tool file named as a command: `aidlc-<tool>[.ts] <verb>`, where the
// verb is not an error label's (`aidlc-runtime fragment-fork: ...`).
const BARE_TOOL = /(?:^|[\s`'"(])aidlc-(?:audit|bolt|graph|jump|knowledge|learnings|log|orchestrate|plugin|runtime|sensor|state|swarm|unit|utility|worktree)(?:\.ts)? (?!-)[a-z][a-z-]*(?![a-z-]*:)/;
// The install's command written by hand: `aidlc <noun>`.
const HARD_AIDLC = /(?:^|[\s`'"(])aidlc (?:config|unit|engine|system|plugin|intent|space|knowledge|help|doctor|status|--help)\b/;

// Per file, the most literals of each kind not yet moved to the renderer. A
// file over its number, or not listed, fails; a fix lowers its number here.
const BARE_TOOL_LEFT: Readonly<Record<string, number>> = {
  "aidlc-audit.ts": 1,
  "aidlc-bolt.ts": 7,
  "aidlc-directive.ts": 1,
  "aidlc-graph.ts": 2,
  "aidlc-learnings.ts": 2,
  "aidlc-orchestrate.ts": 2,
  "aidlc-runtime.ts": 2,
  "aidlc-state.ts": 35,
  "aidlc-swarm.ts": 1,
  "aidlc-utility.ts": 11,
  "aidlc-worktree.ts": 1,
};
const HARD_AIDLC_LEFT: Readonly<Record<string, number>> = {
  "aidlc-completions.ts": 1,
  "aidlc-config-diagnostics.ts": 1,
  "aidlc-directive.ts": 6,
  "aidlc-graph.ts": 2,
  "aidlc-guard-operation.ts": 1,
  "aidlc-lib.ts": 3,
  // Its lines name the native-only lifecycle commands, where `aidlc` is right.
  "aidlc-lifecycle.ts": 9,
  "aidlc-model-policy.ts": 1,
  "aidlc-plugin-validate.ts": 1,
  "aidlc-plugin.ts": 2,
  "aidlc-statusline-choice.ts": 2,
  "aidlc-unit.ts": 2,
  "aidlc-update.ts": 1,
  "aidlc.ts": 13,
};
// Bare tool commands still in the protocol modules' prose.
const PROTOCOL_BARE_LEFT = 27;

function literals(file: string, text: string): string[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) || ts.isTemplateTail(node)
    ) found.push(node.text);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

// The files whose count is over what the table allows.
function over(found: Record<string, number>, allowed: Readonly<Record<string, number>>): Record<string, number> {
  return Object.fromEntries(Object.entries(found).filter(([file, n]) => n > (allowed[file] ?? 0)));
}

function counts(pattern: RegExp): Record<string, number> {
  const out: Record<string, number> = {};
  for (const name of readdirSync(TOOLS).filter((file) => file.endsWith(".ts")).sort()) {
    const n = literals(name, readFileSync(join(TOOLS, name), "utf-8")).filter((text) => pattern.test(text)).length;
    if (n > 0) out[name] = n;
  }
  return out;
}

describe("a printed command goes through its renderer", () => {
  test("no new bare tool-file command in a tool's printed strings", () => {
    expect(over(counts(BARE_TOOL), BARE_TOOL_LEFT), "name the command with aidlcDispatcherInvocation() or aidlcToolInvocation()").toEqual({});
  });

  test("no new hand-written `aidlc <noun>` command in a tool's printed strings", () => {
    expect(over(counts(HARD_AIDLC), HARD_AIDLC_LEFT), "name the command with aidlcInvocation() (or entrySkillInvocation() for the person's entry)").toEqual({});
  });

  test("the protocol modules name commands with the install's token", () => {
    let n = 0;
    for (const name of readdirSync(PROTOCOLS).filter((file) => file.endsWith(".md"))) {
      n += readFileSync(join(PROTOCOLS, name), "utf-8").split("\n").filter((line) => /`aidlc-[a-z-]+\.ts [a-z]|`aidlc (?:unit|engine|config) /.test(line)).length;
    }
    expect(n, "write {{INVOKE}} engine <route> ... in a run instruction").toBeLessThanOrEqual(PROTOCOL_BARE_LEFT);
  });

  test("the Windows installer's messages name its parameters as PowerShell takes them", () => {
    const messages = readFileSync(join(REPO_ROOT, "scripts", "install.ps1"), "utf-8").split("\n")
      .filter((line) => /-Message '[^']*--[A-Z]/.test(line));
    expect(messages).toEqual([]);
  });

  test("the Construction policy refusal names the state tool as this install runs it", () => {
    expect(constructionPolicyRecovery()).toContain("run bun .claude/tools/aidlc-state.ts set-construction-checkpoints, ");
  });
});
