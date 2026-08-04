// covers: subcommand:aidlc-onboard:capture, subcommand:aidlc-onboard:classify, subcommand:aidlc-learnings:persist-rule, subcommand:aidlc-graph:compile
//
// t264 (integration) — /aidlc-onboard S1 end-to-end: capture -> classify ->
// (skill's own preventative sweep, modelled by the test as the human-gate
// decision) -> persist-rule -> the REAL consumer
// §6: the promoted rule appears in rules_in_context on the next
// `aidlc-graph.ts compile`. Also proves the two safety properties the design
// calls out: a decline at the gate promotes nothing, and routing `/aidlc
// onboard capture --source <path>` through the top-level dispatcher
// (aidlc.ts) is NOT intercepted by the help-routing guard (the `--source`
// flag is not help-shaped free text).
//
// Mechanism: cli. Every case spawns the shipped tools via the bun runtime
// against the shipped dist/claude/.claude/tools/*.ts paths — the process
// boundary (capture/classify/persist-rule exit codes + the bytes each leaves
// on disk) and the compile step's resolved rules_in_context are the
// observables under test.
//
// Source under test (dist/claude/.claude/tools/):
//   aidlc.ts            top-level dispatcher: `onboard capture|classify`
//   aidlc-onboard.ts     capture | classify
//   aidlc-learnings.ts   persist-rule (Gap-A stage-optional entry)
//   aidlc-graph.ts       compile (rules_in_context resolution)

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AIDLC_SRC } from "../harness/fixtures.ts";

const BUN = process.execPath;
const TOOLS = join(AIDLC_SRC, "tools");
const AIDLC_TS = join(TOOLS, "aidlc.ts");
const ONBOARD_TS = join(TOOLS, "aidlc-onboard.ts");
const LEARNINGS_TS = join(TOOLS, "aidlc-learnings.ts");
const GRAPH_TS = join(TOOLS, "aidlc-graph.ts");
const SEED_GRAPH = join(TOOLS, "data", "stage-graph.json");

const projects: string[] = [];
afterAll(() => {
  for (const p of projects) rmSync(p, { recursive: true, force: true });
});

function bareProject(): string {
  const p = mkdtempSync(join(tmpdir(), "aidlc-t264-"));
  projects.push(p);
  return p;
}

interface CliResult {
  status: number;
  stdout: string;
  stderr: string;
}

function run(tool: string, args: string[], extraEnv?: NodeJS.ProcessEnv): CliResult {
  const r = spawnSync(BUN, [tool, ...args], {
    encoding: "utf-8",
    env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
  });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

// Run a step the way a HARNESS issues it — through a real shell. Spawning by argv
// bypasses the very layer the file-transport design exists to defend: a shell
// expands `$(…)` and backticks before the tool's process starts. A flow test that
// never uses a shell cannot prove the documented shape is safe.
function runViaShell(command: string, cwd: string): CliResult {
  const r = spawnSync("sh", ["-c", command], { cwd, encoding: "utf-8" });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

const TIMEOUT = 30000;

describe("t264 /aidlc-onboard S1 skill flow end-to-end (capture -> classify -> gate -> persist-rule -> compile)", () => {
  // ===========================================================================
  // Acceptance (real consumer): capture -> classify ->
  // (gate confirms) -> persist-rule -> the rule appears in rules_in_context on
  // the NEXT compile.
  //
  // SCOPE OF WHAT THIS TEST ACTUALLY ESTABLISHES (P2e correction): this is a
  // `cli` mechanism test — it spawns tool processes, it does not drive an
  // LLM. It CANNOT exercise the question-rendering annex (a prompt render
  // consumed by an orchestrator-LLM, not by any of these tools) or turn
  // termination (a property of the orchestrator's conversational loop, not
  // of a spawned process's exit code). What it DOES establish, and all it
  // claims to establish: given the human's "confirm, project scope" DECISION
  // (represented here by simply calling persist-rule — that decision is the
  // one thing outside this test's reach, exactly as SKILL.md Step 4 requires
  // a real human turn to produce it), the documented Step 5 command shape —
  // ALL FOUR file-transported values SKILL.md names (candidate id, text,
  // source_path, heading; see "Four values must never appear on the command
  // line" in SKILL.md Step 5) — produces a rule that is live in
  // `rules_in_context` on the next compile. Previously this test omitted
  // `--source-file`, so it never exercised the documented four-value shape
  // it claimed to.
  // ===========================================================================
  test("a confirmed onboard rule appears in rules_in_context on the next compile", () => {
    const pd = bareProject();
    const src = join(pd, "standards.md");
    writeFileSync(src, "All money math must use decimal. We shall never use float for currency.\n");

    // THE COMPLETE DOCUMENTED STEP SHAPE, THROUGH A REAL SHELL. SKILL.md's steps
    // ARE shell command lines, and the whole file-transport design exists because
    // a shell expands `$(…)`/backticks before the tool starts — so every untrusted
    // value travels by file here (`--source-file`, `--id-file`,
    // `--candidate-id-file`, `--text-file`, `--heading-file`) and every step runs
    // via `sh -c`, exactly as a harness would issue it.
    const sourceFile = join(pd, "source.txt");
    writeFileSync(sourceFile, `${src}\n`);

    // Step 1: capture.
    const capture = runViaShell(
      `bun ${ONBOARD_TS} capture --source-file ${sourceFile} --project-dir ${pd}`,
      pd,
    );
    expect(capture.status).toBe(0);
    const captureRow = JSON.parse(capture.stdout).files[0];
    const id = captureRow.id;
    // The captured item's own source_path — the value Step 5 must ALSO carry
    // by file (SKILL.md: "the item's `source_path`" is one of the four values
    // that must never appear on the command line).
    const itemSourcePath: string = captureRow.source_path;

    // Step 2: classify — the id is a committed, network-borne value.
    const idFile = join(pd, "id.txt");
    writeFileSync(idFile, `${id}\n`);
    const classify = runViaShell(
      `bun ${ONBOARD_TS} classify --id-file ${idFile} --project-dir ${pd}`,
      pd,
    );
    expect(classify.status).toBe(0);
    const classified = JSON.parse(classify.stdout);
    expect(classified.disposition).toBe("preventative");
    // The body arrives framed as untrusted data — the boundary travels with it.
    expect(classified.content_trust).toBe("untrusted");

    // Step 4/5: the human gate confirms (project scope) -> promote. This test
    // represents the human's "confirm, project scope" decision simply by
    // calling persist-rule — it cannot itself render or answer the
    // question-rendering annex (see the scope note above). Every
    // document-derived value goes by file, ALL FOUR of them per SKILL.md
    // Step 5: candidate id, text, source_path, heading.
    const cidFile = join(pd, "cid.txt");
    const textFile = join(pd, "text.txt");
    const sourcePathFile = join(pd, "source-path.txt");
    const headingFile = join(pd, "heading.txt");
    writeFileSync(cidFile, `${id}-1\n`);
    writeFileSync(textFile, "All money math uses decimal, never float\n");
    writeFileSync(sourcePathFile, `${itemSourcePath}\n`);
    writeFileSync(headingFile, "Corrections\n");

    const persist = runViaShell(
      `bun ${LEARNINGS_TS} persist-rule --scope project ` +
        `--candidate-id-file ${cidFile} --text-file ${textFile} ` +
        `--source-file ${sourcePathFile} --heading-file ${headingFile} --project-dir ${pd}`,
      pd,
    );
    expect(persist.status).toBe(0);
    const persisted = JSON.parse(persist.stdout);
    expect(persisted.rule_learned).toBe(1);
    // rule_written (P2e): a fresh write is 1 on BOTH fields, distinguishing
    // it from a backfill/no-op which would report rule_learned:1 with
    // rule_written:0 (or vice versa).
    expect(persisted.rule_written).toBe(1);
    expect(persisted.candidate_id).toBe(`${id}-1`);
    expect(persisted.heading).toBe("## Corrections");

    // The audit row records the item's OWN source_path as provenance — the
    // fourth value Step 5 carries by file, not the harness's own source.txt.
    const auditDir = join(pd, "aidlc", "spaces", "default", "intents", "audit");
    const auditFiles = require("node:fs")
      .readdirSync(auditDir)
      .filter((f: string) => f.endsWith(".md"));
    const auditText = auditFiles
      .map((f: string) => readFileSync(join(auditDir, f), "utf-8"))
      .join("\n");
    expect(auditText).toContain(`**Source**: ${itemSourcePath}`);

    // The real consumer: the NEXT compile bakes the rule into rules_in_context.
    // rulesDir() (aidlc-graph.ts) always resolves aidlc/spaces/default/memory —
    // matching where persist-rule wrote (onboard's default-space resolution).
    const sg = join(pd, "sg.json");
    cpSync(SEED_GRAPH, sg);
    const compile = run(GRAPH_TS, ["compile", "--project-dir", pd], {
      AIDLC_STAGE_GRAPH: sg,
    });
    expect(compile.status).toBe(0);
    const graph = JSON.parse(readFileSync(sg, "utf-8")) as Array<{
      slug: string;
      rules_in_context: Array<{ path: string; scope: string }>;
    }>;
    // Every stage carries the project-scoped rule file in its rules_in_context
    // (the additive per-stage chain — the skill step 5 write).
    const projectRuleAttached = graph.every((s) =>
      s.rules_in_context.some(
        (r) => r.scope === "project" && r.path.endsWith("memory/project.md"),
      ),
    );
    expect(projectRuleAttached).toBe(true);
  }, TIMEOUT);

  // ===========================================================================
  // Decline at the gate: no persist-rule call is made -> nothing is promoted.
  // The manifest still records the classified item (capture/classify are
  // deterministic, auditless); only a human "yes" writes a rule.
  // ===========================================================================
  test("a decline at the gate promotes nothing (no persist-rule call -> no rule written)", () => {
    const pd = bareProject();
    const src = join(pd, "standards.md");
    writeFileSync(src, "You must always log every access attempt.\n");

    const capture = run(ONBOARD_TS, ["capture", "--source", src, "--project-dir", pd]);
    expect(capture.status).toBe(0);
    const id = JSON.parse(capture.stdout).files[0].id;
    const classify = run(ONBOARD_TS, ["classify", "--id", id, "--project-dir", pd]);
    expect(classify.status).toBe(0);
    expect(JSON.parse(classify.stdout).disposition).toBe("preventative");

    // The human declines at the gate -> the skill never calls persist-rule.
    // No memory tree is created at all.
    expect(existsSync(join(pd, "aidlc", "spaces", "default", "memory"))).toBe(false);
  }, TIMEOUT);

  // ===========================================================================
  // Confirm promotes EXACTLY one rule (not the whole batch, not zero).
  // ===========================================================================
  test("a confirm at the gate promotes exactly one rule", () => {
    const pd = bareProject();
    const persist = run(LEARNINGS_TS, [
      "persist-rule",
      "--scope",
      "team",
      "--candidate-id",
      "gate-confirm-1",
      "--text",
      "Exactly one rule lands",
      "--project-dir",
      pd,
    ]);
    expect(persist.status).toBe(0);
    const teamMd = readFileSync(
      join(pd, "aidlc", "spaces", "default", "memory", "team.md"),
      "utf-8",
    );
    const ruleLines = teamMd.split("\n").filter((l) => l.startsWith("- "));
    expect(ruleLines.length).toBe(1);
  }, TIMEOUT);

  // ===========================================================================
  // Help-routing guard (v2.1.6-era help routing) does NOT intercept
  // `onboard capture --source <path>` through the top-level dispatcher —
  // it delegates to aidlc-onboard.ts and captures normally, exit 0.
  // ===========================================================================
  test("the top-level dispatcher routes 'onboard capture --source' without help interception", () => {
    const pd = bareProject();
    const src = join(pd, "standards.md");
    writeFileSync(src, "Some material.\n");

    const r = run(AIDLC_TS, ["onboard", "capture", "--source", src, "--project-dir", pd]);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.captured).toBe(1);
  }, TIMEOUT);
});
