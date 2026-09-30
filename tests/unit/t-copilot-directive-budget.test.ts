// covers: function:harnessDirectiveMaxBytes, subcommand:aidlc-orchestrate:next, subcommand:aidlc-orchestrate:continue
//
// #1411: VS Code's Copilot `run_in_terminal` tool keeps a command result whole
// only up to 20,000 characters (MAX_OUTPUT_LENGTH in microsoft/vscode
// src/vs/workbench/contrib/terminalContrib/chatAgentTools/browser/outputHelpers.ts).
// A longer result is saved to a temp file and the chat, and the PostToolUse
// hook, get a 500-character preview and the tail instead. The Copilot adapter
// cannot read a directive from that, so the attempt fails, the Stop hook asks
// for a fresh `next`, and the fresh `next` is just as long: a loop. On a stock
// project four Construction stages printed over 20,000 characters.
//
// The Copilot harness declares a directive budget below that cut in its
// tools/data/harness.json. These cases run `next`, and every `continue` it asks
// for, for every shipped stage on the packaged Copilot tree, with stock memory
// and with a team's memory grown past one message, and pin every printed result
// under the budget. A stage whose rules do not fit beside its run-stage still
// reaches that run-stage, through load-steering parts.

import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  appendFileSync,
  cpSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  cleanupTestProject,
  createTestProject,
  FIXTURES_DIR,
  REPO_ROOT,
  seededStateFile,
} from "../harness/fixtures.ts";
import { HARNESS_MATRIX } from "../harness/harness-matrix.ts";
import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

// VS Code's cut, in UTF-16 code units (JavaScript string length).
const VSCODE_TERMINAL_RESULT_MAX_CHARS = 20_000;
const COPILOT_ROOT = join(REPO_ROOT, "dist", "copilot");
const CLAUDE_ROOT = join(REPO_ROOT, "dist", "claude");
const STATE_FIXTURE = join(FIXTURES_DIR, "state-brownfield-feature.md");
// Every lifecycle checkbox line in the fixture: `- [x] <slug> <dash> EXECUTE`.
const STAGE_LINE = /^- \[[ x-]\] ([a-z0-9-]+) \u2014 EXECUTE$/gm;
const WORKERS = 4;

type RuleContent = { path: string; text: string };
type Printed = {
  kind: string;
  stage?: string;
  part?: number;
  parts?: number;
  receipt?: string;
  rules_content?: RuleContent[];
  rules_in_context?: string[];
  change_notices?: string[];
};
type Delivery = {
  stage: string;
  results: Array<{ stdout: string; directive: Printed }>;
  final: Printed;
};

const projects: string[] = [];
afterAll(() => {
  for (const proj of projects) cleanupTestProject(proj);
}, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

function shippedHarnessData(engineRoot: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(engineRoot, "tools", "data", "harness.json"), "utf-8"));
}

function copilotBudget(): number {
  const declared = shippedHarnessData(join(COPILOT_ROOT, ".aidlc")).directiveMaxBytes;
  expect(typeof declared, "dist/copilot harness.json declares directiveMaxBytes").toBe("number");
  return declared as number;
}

const FIXTURE_STATE = readFileSync(STATE_FIXTURE, "utf-8");
const FIXTURE_STAGES = [...FIXTURE_STATE.matchAll(STAGE_LINE)].map((match) => match[1] ?? "");

function shippedStages(root: string, harnessDir: string): string[] {
  const raw = JSON.parse(
    readFileSync(join(root, harnessDir, "tools", "data", "stage-graph.json"), "utf-8"),
  ) as Array<{ slug: string }> | { stages: Array<{ slug: string }> };
  return (Array.isArray(raw) ? raw : raw.stages).map((stage) => stage.slug);
}

// The brownfield feature state with `stage` in progress: every earlier stage
// done, every later one still to run.
function stateAt(stage: string): string {
  const at = FIXTURE_STAGES.indexOf(stage);
  return FIXTURE_STATE
    .replace(/^(- \*\*Current Stage\*\*: ).*$/m, `$1${stage}`)
    .replace(/^(- \*\*In Progress\*\*: ).*$/m, `$1${stage}`)
    .replace(STAGE_LINE, (line, slug: string) => {
      const index = FIXTURE_STAGES.indexOf(slug);
      const mark = index < at ? "x" : index === at ? "-" : " ";
      return line.replace(/^- \[[ x-]\]/, `- [${mark}]`);
    });
}

// A team's memory grown past one message: 20 sections of 1,500 characters
// appended to the shipped org.md (about 30 KB more rule text).
function inflateMemory(proj: string): void {
  appendFileSync(
    join(proj, "aidlc", "spaces", "default", "memory", "org.md"),
    Array.from({ length: 20 }, (_, index) => `\n## Team practice ${index}\n${"x".repeat(1500)}\n`).join(""),
  );
}

function projectFor(root: string, harnessDir: string, stage: string, inflated: boolean): string {
  const proj = createTestProject();
  projects.push(proj);
  cpSync(join(root, harnessDir), join(proj, harnessDir), { recursive: true });
  cpSync(join(root, "aidlc"), join(proj, "aidlc"), { recursive: true });
  writeFileSync(seededStateFile(proj), stateAt(stage), "utf-8");
  if (inflated) inflateMemory(proj);
  return proj;
}

async function orchestrate(proj: string, harnessDir: string, args: string[]): Promise<string> {
  const child = Bun.spawn(
    [process.execPath, join(proj, harnessDir, "tools", "aidlc-orchestrate.ts"), ...args],
    {
      cwd: proj,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        AIDLC_PROJECT_DIR: undefined,
        CLAUDE_PROJECT_DIR: undefined,
        AIDLC_HARNESS_NAME: undefined,
      },
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(code, `${args.join(" ")}: ${stderr}`).toBe(0);
  return stdout;
}

// `next`, then `continue <receipt>` for every load-steering part, exactly as
// the conductor runs them, keeping each printed result verbatim.
async function deliverIn(proj: string, harnessDir: string, stage: string): Promise<Delivery> {
  const results: Delivery["results"] = [];
  let args = ["next"];
  for (let hop = 0; hop < 20; hop++) {
    const stdout = await orchestrate(proj, harnessDir, args);
    const directive = JSON.parse(stdout) as Printed;
    results.push({ stdout, directive });
    if (directive.kind !== "load-steering") return { stage, results, final: directive };
    args = ["continue", directive.receipt ?? ""];
  }
  throw new Error(`${stage}: steering did not reach run-stage in 20 hops`);
}

function deliver(root: string, harnessDir: string, stage: string, inflated: boolean): Promise<Delivery> {
  return deliverIn(projectFor(root, harnessDir, stage, inflated), harnessDir, stage);
}

async function deliverAll(stages: string[], inflated: boolean): Promise<Delivery[]> {
  const deliveries: Delivery[] = [];
  const queue = [...stages];
  await Promise.all(Array.from({ length: WORKERS }, async () => {
    for (let stage = queue.shift(); stage !== undefined; stage = queue.shift()) {
      deliveries.push(await deliver(COPILOT_ROOT, ".aidlc", stage, inflated));
    }
  }));
  return deliveries.sort((a, b) => stages.indexOf(a.stage) - stages.indexOf(b.stage));
}

// Stock deliveries are read by two cases; run them once.
let stock: Promise<Delivery[]> | null = null;
function stockDeliveries(): Promise<Delivery[]> {
  stock ??= deliverAll(FIXTURE_STAGES, false);
  return stock;
}

// Every result fits VS Code's terminal result whole and sits under the
// declared budget, and each stage's run-stage arrives with every rule file it
// names delivered. The host's cut is checked first, across every result.
function expectWholeDeliveries(deliveries: Delivery[]): void {
  const printed = deliveries.flatMap(({ stage, results }) =>
    results.map(({ stdout, directive }) => ({
      stdout,
      label: `${stage} ${directive.kind}${directive.parts ? ` ${directive.part}/${directive.parts}` : ""}`,
    }))
  );
  for (const { stdout, label } of printed) {
    expect(stdout.length, label).toBeLessThan(VSCODE_TERMINAL_RESULT_MAX_CHARS);
  }
  const budget = copilotBudget();
  for (const { stdout, label } of printed) {
    expect(Buffer.byteLength(stdout, "utf-8"), label).toBeLessThanOrEqual(budget);
  }
  for (const { stage, results, final } of deliveries) {
    expect(final.kind, stage).toBe("run-stage");
    expect(final.stage, stage).toBe(stage);
    const delivered = new Set(results.flatMap(({ directive }) => (directive.rules_content ?? []).map((rule) => rule.path)));
    expect([...delivered].sort(), stage).toEqual([...(final.rules_in_context ?? [])].sort());
  }
}

describe("t-copilot-directive-budget: every Copilot directive fits VS Code's terminal result (#1411)", () => {
  test("Copilot declares a directive budget under VS Code's cut; no other harness declares one", () => {
    const budget = copilotBudget();
    expect(budget).toBeGreaterThan(0);
    // A UTF-8 byte count is never below the string's length, so the byte
    // budget plus the trailing newline stays under the character cut.
    expect(budget + 1).toBeLessThan(VSCODE_TERMINAL_RESULT_MAX_CHARS);
    for (const harness of HARNESS_MATRIX) {
      if (harness.name === "copilot") continue;
      expect(Object.hasOwn(shippedHarnessData(harness.engineRoot), "directiveMaxBytes"), harness.name).toBe(false);
    }
  });

  test("the state fixture places every shipped stage", () => {
    expect(FIXTURE_STAGES.length).toBeGreaterThan(0);
    expect([...FIXTURE_STAGES].sort()).toEqual([...shippedStages(COPILOT_ROOT, ".aidlc")].sort());
  });

  test("stock memory: every stage's results fit, and an oversized stage takes one extra continue", async () => {
    const deliveries = await stockDeliveries();
    expectWholeDeliveries(deliveries);
    for (const { stage, results } of deliveries) {
      // Shipped rules fit one load-steering part when they do not fit inline.
      expect(results.length, `${stage}: ${results.map(({ directive }) => directive.kind).join(" -> ")}`)
        .toBeLessThanOrEqual(2);
    }
  });

  test("grown memory: every stage steers in parts that each fit, then reaches its run-stage", async () => {
    const deliveries = await deliverAll(FIXTURE_STAGES, true);
    expectWholeDeliveries(deliveries);
    for (const { stage, results } of deliveries) {
      expect(results[0]?.directive.kind, stage).toBe("load-steering");
      expect(results[0]?.directive.parts ?? 0, stage).toBeGreaterThan(1);
    }
  });

  test("a notice rides on every part and each part, cut as full as the budget allows, still fits", async () => {
    const budget = copilotBudget();
    const proj = projectFor(COPILOT_ROOT, ".aidlc", "functional-design", false);
    // A retired Change Control line below strict puts a Guard Policy notice on
    // every directive, and one long section splits exactly at the part size.
    const state = seededStateFile(proj);
    writeFileSync(state, readFileSync(state, "utf-8").replace(/^(- \*\*Change Control\*\*: )strict/m, "$1relaxed"));
    appendFileSync(
      join(proj, "aidlc", "spaces", "default", "memory", "org.md"),
      `\n## One long team practice\n${"x".repeat(60_000)}\n`,
    );
    const delivery = await deliverIn(proj, ".aidlc", "functional-design");
    expectWholeDeliveries([delivery]);
    const { results, final } = delivery;
    expect(results[0]?.directive.parts ?? 0).toBeGreaterThan(2);
    const notices = final.change_notices;
    expect(notices).toEqual([expect.stringContaining("retired Change Control")]);
    for (const { directive } of results) expect(directive.change_notices).toEqual(notices);
    const sizes = results.map(({ stdout }) => Buffer.byteLength(stdout, "utf-8"));
    expect(Math.max(...sizes)).toBeGreaterThan(budget - 1024);
  });

  test("functional-design, where #1411 was reported, steers on Copilot and stays one message on Claude", async () => {
    const kinds = (delivery: Delivery | undefined) => delivery?.results.map(({ directive }) => directive.kind);
    const copilot = (await stockDeliveries()).find(({ stage }) => stage === "functional-design");
    expect(kinds(copilot)).toEqual(["load-steering", "run-stage"]);
    expect(existsSync(join(CLAUDE_ROOT, ".claude"))).toBe(true);
    const claude = await deliver(CLAUDE_ROOT, ".claude", "functional-design", false);
    expect(kinds(claude)).toEqual(["run-stage"]);
    expect(claude.final.rules_content?.length ?? 0).toBeGreaterThan(0);
  });
});
