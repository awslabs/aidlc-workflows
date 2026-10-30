// covers: subcommand:aidlc-orchestrate:next, function:parseNextFlags, function:unitCommandArgv, function:readNextLine,
// function:classifyTerminalCommand, function:isReadOnlyNextArgv, function:nextArgsAreOnlyWords
//
// `/aidlc unit pin alpha` and the other `unit` verbs are the person's own Unit commands
// (docs/guide/12-cli-commands.md), so `next` names that command for the agent to run, on every harness, instead of
// reading the line as words for new work (#3287: the new-work routing question "You said: unit pin alpha. What should
// I do?"). The line is told apart by its structure only: `unit`, one of the Unit verbs, and at most the one Unit name
// that verb takes, as the Unit tool reads the line. Any other line that starts with "unit" stays the person's words,
// the words behind the `--` mark included. Every seam
// that reads the line before the agent agrees, and none runs a Unit command off-band: they change git and reach the
// remote, so they stay behind the host's own Allow prompt.
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { UNIT_VERBS } from "../../dist/claude/.claude/tools/aidlc-command.ts";
import { classifyTerminalCommand, isReadOnlyNextArgv, readNextLine } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { nextArgsAreOnlyWords, parseNextFlags } from "../../dist/claude/.claude/tools/aidlc-orchestrate.ts";
import { quoteCommandArgument } from "../../dist/claude/.claude/tools/aidlc-runtime-paths.ts";
import { ROUTES } from "../../dist/claude/.claude/tools/aidlc.ts";
import {
  cleanupTestProject,
  createOrchestrationTestProject,
  FIXTURES_DIR,
  REPO_ROOT,
  runOrchestrateNext,
  seedStateFile,
} from "../harness/fixtures.ts";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

// Each harness's projected tree and the invocation its directives name.
const TREES: ReadonlyArray<{ harness: string; tools: string; invoke: string }> = [
  { harness: "claude", tools: join("dist", "claude", ".claude", "tools"), invoke: "bun .claude/tools/aidlc.ts" },
  { harness: "codex", tools: join("dist", "codex", ".codex", "tools"), invoke: "bun .codex/tools/aidlc.ts" },
  { harness: "copilot", tools: join("dist", "copilot", ".aidlc", "tools"), invoke: "bun .aidlc/tools/aidlc.ts" },
  { harness: "cursor", tools: join("dist", "cursor", ".cursor", "tools"), invoke: "bun .cursor/tools/aidlc.ts" },
  { harness: "kiro", tools: join("dist", "kiro", ".kiro", "tools"), invoke: "bun .kiro/tools/aidlc.ts" },
  { harness: "kiro-ide", tools: join("dist", "kiro-ide", ".kiro", "tools"), invoke: "bun .kiro/tools/aidlc.ts" },
  { harness: "opencode", tools: join("dist", "opencode", ".aidlc", "tools"), invoke: "bun .aidlc/tools/aidlc.ts" },
];
const CLAUDE = TREES[0];

// A verb's line as the person types it: the Unit's name after the verbs that take one.
function verbLine(verb: string): string[] {
  return UNIT_VERBS.get(verb) ? ["unit", verb, "alpha"] : ["unit", verb];
}

const projects: string[] = [];
afterAll(() => {
  for (const proj of projects) cleanupTestProject(proj);
});

// One project with work under way (the case the person met: work in progress, then `/aidlc unit pin alpha`).
let workOpen = "";
function projectWithWork(): string {
  if (workOpen === "") {
    workOpen = createOrchestrationTestProject();
    projects.push(workOpen);
    seedStateFile(workOpen, join(FIXTURES_DIR, "state-mid-ideation.md"));
  }
  return workOpen;
}

function nextFrom(tree: (typeof TREES)[number], args: string[]): Record<string, unknown> {
  const env: Record<string, string | undefined> = { ...process.env, AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "1" };
  for (const key of ["AIDLC_PROJECT_DIR", "CLAUDE_PROJECT_DIR", "AIDLC_SESSION_OVERRIDE", "AIDLC_UNATTENDED"]) delete env[key];
  const proj = projectWithWork();
  const result = runOrchestrateNext(join(REPO_ROOT, tree.tools, "aidlc-orchestrate.ts"), proj, args, { cwd: proj, env });
  expect(result.status, result.out).toBe(0);
  expect(result.directive, result.out).not.toBeNull();
  return result.directive as Record<string, unknown>;
}

// The step `next` gives for a Unit command: one print naming the command, which ends the turn once it has run.
function expectUnitCommandStep(directive: Record<string, unknown>, command: string): void {
  expect(directive.kind, JSON.stringify(directive)).toBe("print");
  const message = String(directive.message ?? "");
  expect(message).toContain(`Run \`${command}\``);
  expect(message).toContain("then stop");
  expect(message).not.toContain("Work is in progress");
  expect(message).not.toContain("does not take");
}

describe("a Unit command typed after /aidlc reaches that command", () => {
  test("every Unit verb, over work in progress, names its own command (Claude Code)", () => {
    for (const verb of UNIT_VERBS.keys()) {
      const line = verbLine(verb);
      expectUnitCommandStep(nextFrom(CLAUDE, line), `${CLAUDE.invoke} ${line.join(" ")}`);
    }
  });

  test("`/aidlc unit pin alpha` names the pin on every harness, in that harness's own invocation", () => {
    for (const tree of TREES.slice(1)) {
      expectUnitCommandStep(nextFrom(tree, ["unit", "pin", "alpha"]), `${tree.invoke} unit pin alpha`);
    }
  });

  test("Kiro IDE's one argument holding the whole line is the same command, quotes read as typed", () => {
    const kiroIde = TREES.find((tree) => tree.harness === "kiro-ide")!;
    expectUnitCommandStep(nextFrom(kiroIde, ["unit pin alpha"]), `${kiroIde.invoke} unit pin alpha`);
    expect(parseNextFlags(["unit land alpha --step git"]).unitCommand).toEqual(["land", "alpha", "--step", "git"]);
    expect(readNextLine(["unit status"])).toEqual({ kind: "exact", unit: ["status"] });
    expect(parseNextFlags(['unit claim alpha --team "Team A"']).unitCommand).toEqual(["claim", "alpha", "--team", "Team A"]);
    // The gate's words travel in a request file the gate reads (t-words-travel-in-a-file).
    expectUnitCommandStep(
      nextFrom(kiroIde, ['unit gate alpha --decision approve --user-input "ship it"']),
      `${kiroIde.invoke} unit gate alpha --decision approve --request-file aidlc/.aidlc-request-text/gate-alpha.txt`,
    );
    expect(readFileSync(join(projectWithWork(), "aidlc", ".aidlc-request-text", "gate-alpha.txt"), "utf-8")).toBe("ship it");
  });

  test("the entry word handed on as an argument is how they reached AI-DLC, not part of the command", () => {
    const codex = TREES.find((tree) => tree.harness === "codex")!;
    expectUnitCommandStep(nextFrom(codex, ["$aidlc", "unit", "publish", "alpha"]), `${codex.invoke} unit publish alpha`);
    expectUnitCommandStep(nextFrom(CLAUDE, ["/aidlc", "unit", "status"]), `${CLAUDE.invoke} unit status`);
  });

  test("a verb's options ride with it, each quoted for the shell", () => {
    expectUnitCommandStep(
      nextFrom(CLAUDE, ["unit", "land", "alpha", "--step", "git"]),
      `${CLAUDE.invoke} unit land alpha --step git`,
    );
    const claim = nextFrom(CLAUDE, ["unit", "claim", "alpha", "--team", "Team A", "--rhythm", "unit-end"]);
    expectUnitCommandStep(claim, `${CLAUDE.invoke} unit claim alpha --team ${quoteCommandArgument("Team A")} --rhythm unit-end`);
    expect(String(claim.message)).not.toContain("require --claim");
    const gate = parseNextFlags(["unit", "gate", "alpha", "--decision", "approve", "--user-input", "ship it"]);
    expect(gate.unitCommand).toEqual(["gate", "alpha", "--decision", "approve", "--user-input", "ship it"]);
    expect(gate.intent).toBeUndefined();
  });
});

describe("a line that only starts with the word unit stays the person's words", () => {
  const words: ReadonlyArray<string[]> = [
    ["unit", "tests", "for", "the", "parser"],
    ["unit", "status", "page", "for", "the", "dashboard"],
    ["unit", "pin", "alpha", "and", "beta"],
    ["unit"],
    ["unit", "pinn", "alpha"],
    // A single-dash token is a bare word to the Unit tool, so here it is a second name.
    ["unit", "pin", "alpha", "-x"],
    // Words behind the `--` mark are theirs, never the command's.
    ["unit", "pin", "alpha", "--", "explain", "this", "first"],
    // An option's value is one word; the next word is theirs, so the reason is never cut short.
    ["unit", "gate", "alpha", "--decision", "approve", "--user-input", "ship", "it"],
    // One argument that opens with the entry word is their sentence whole.
    ["/aidlc unit pin alpha"],
  ];
  test("not the verb form: no Unit command, the words kept whole", () => {
    for (const line of words) {
      const parsed = parseNextFlags(line);
      expect(parsed.unitCommand, line.join(" ")).toBeUndefined();
      // The entry word is how they reached AI-DLC, and the mark is not a word: every word of theirs is kept, an
      // option `next` does not take among them, exactly as before.
      for (const word of line.join(" ").replace(/^\/aidlc\s+/, "").split(" ").filter((token) => token !== "--")) {
        expect(parsed.personWords ?? parsed.intent ?? "", line.join(" ")).toContain(word);
      }
      expect(readNextLine(line), line.join(" ")).not.toHaveProperty("unit");
    }
  });

  test("over work in progress such a line still reaches the words step, as before", () => {
    const step = nextFrom(CLAUDE, ["unit", "tests", "for", "the", "parser"]);
    expect(String(step.message)).not.toContain(`${CLAUDE.invoke} unit`);
  });
});

describe("every reader of the line agrees, and none runs a Unit command off-band", () => {
  test("the verb form reads exact, is not a terminal utility and not a read-only line, and is not a reply", () => {
    for (const verb of UNIT_VERBS.keys()) {
      for (const line of [verbLine(verb), [...verbLine(verb), "--project-type", "x"]]) {
        expect(readNextLine(line), line.join(" ")).toEqual({ kind: "exact", unit: line.slice(1) });
        expect(classifyTerminalCommand(line), line.join(" ")).toBeNull();
        expect(isReadOnlyNextArgv(line), line.join(" ")).toBe(false);
        expect(nextArgsAreOnlyWords(line), line.join(" ")).toBe(false);
        expect(parseNextFlags(line).unitCommand, line.join(" ")).toEqual(line.slice(1));
      }
    }
  });
});

describe("a Unit line with `--config` on it is the config refusal for every reader, as for the other nouns", () => {
  test("the engine and the read-only reading agree", () => {
    const line = ["unit", "pin", "alpha", "--config"];
    expect(parseNextFlags(line).unitCommand).toBeUndefined();
    expect(parseNextFlags(line).config).toBe(true);
    expect(isReadOnlyNextArgv(line)).toBe(true);
  });
});

describe("one list of Unit verbs", () => {
  test("the dispatcher's unit route takes exactly the verbs `next` reads", () => {
    const route = ROUTES.find((entry) => entry.id === "unit");
    expect(route).toBeDefined();
    expect([...route!.verbs].sort()).toEqual([...UNIT_VERBS.keys()].sort());
  });

  test("each verb reaches its own branch of the Unit tool, not the tool's list of verbs", () => {
    const proj = createOrchestrationTestProject();
    projects.push(proj);
    const tool = join(REPO_ROOT, CLAUDE.tools, "aidlc-unit.ts");
    const unknown = spawnSync(process.execPath, [tool, "no-such-verb", "--project-dir", proj], {
      encoding: "utf-8",
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    });
    const verbList = unknown.stderr.trim();
    expect(verbList).toContain("Usage: aidlc-unit <");
    for (const verb of UNIT_VERBS.keys()) {
      const run = spawnSync(process.execPath, [tool, verb, "--project-dir", proj], {
        encoding: "utf-8",
        timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
      });
      expect(run.stderr.trim(), verb).not.toBe(verbList);
    }
  });
});
