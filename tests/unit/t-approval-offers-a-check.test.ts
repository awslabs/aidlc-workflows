// covers: subcommand:aidlc-orchestrate:next, subcommand:aidlc-orchestrate:report, subcommand:aidlc-bolt:checkpoint, subcommand:aidlc-log:review
// covers: function:reviewCheckOffer
//
// The reviewer turned the work down until its review passes were used up, the
// work then changed course, and the approval came with nothing to say the
// person could have the new approach checked (#1189). When the passes are
// spent and the reviewed files changed after the last review, the approval
// offers one check, in the engine's words; the person's answer is read as
// usual, and a review they ask for runs past the passes (#1852). Nothing is
// refused and the approval stays as it is.

import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import {
  AIDLC_SRC, cleanupTestProject, createTestProject, resetAidlcEnv,
  runOrchestrateNext, seedAidlcMemory, seedBoltDag, seededRecordDir, seededStateFile,
} from "../harness/fixtures.ts";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import {
  artifactFilename, auditBlockField, findStageBySlug, latestMainWorkflowStageRunFloorForProject, readAuditShardEvents,
  reviewArtifactFingerprint,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

resetAidlcEnv();
const projects: string[] = [];
afterEach(() => {
  while (projects.length) cleanupTestProject(projects.pop());
});
const STAGES = ["functional-design", "nfr-requirements", "nfr-design", "infrastructure-design", "code-generation"];
const OFFER = "Do you want me to have the new approach checked before you decide?";
const SESSION = "offer";

type Options = { policy?: string; review?: string; checkpoints?: boolean; current?: string };

// The t342 fixture under the feature scope's own Guard Policy (off), or the
// policy and review level given.
function fixture(options: Options = {}) {
  const p = createTestProject();
  projects.push(p);
  seedAidlcMemory(p);
  const current = options.current ?? "functional-design";
  writeFileSync(seededStateFile(p), `# AI-DLC State Tracking
## Project Information
- **Project**: A changed approach
- **Project Type**: Greenfield
- **Project Type Source**: you
- **Scope**: feature
- **State Version**: 8
## Runtime State
- **Revision Count**: 0
- **Skeleton Stance**: off
- **Construction Iteration**: unit-major
${options.checkpoints === false ? "" : "- **Construction Checkpoints**: enabled\n- **Construction Execution**: serial\n"}- **Construction Autonomy Mode**: gated
- **Guard Policy**: ${options.policy ?? "off (from scope feature)"}
${options.review ? `- **Review Override**: ${options.review}\n` : ""}## Scope Configuration
- **Stages to Execute**: all
- **Stages to Skip**: none
- **Depth**: Standard
- **Test Strategy**: Standard
## Stage Progress
### CONSTRUCTION PHASE
${STAGES.map((stage) => `- [${stage === current ? "-" : " "}] ${stage} \u2014 EXECUTE`).join("\n")}
- [ ] build-and-test \u2014 EXECUTE
## Current Status
- **Lifecycle Phase**: CONSTRUCTION
- **Current Stage**: ${current}
- **Status**: Running
`);
  seedBoltDag(p, ["alpha", "beta"]);
  mkdirSync(join(p, "src"), { recursive: true });
  for (const unit of ["alpha", "beta"]) writeFileSync(join(p, "src", `${unit}.ts`), `export const ${unit} = 1;\n`);
  appendAuditEntry("WORKFLOW_STARTED", { Scope: "feature" }, p);
  return p;
}

function tool(p: string, name: string, args: string[], env: NodeJS.ProcessEnv = process.env) {
  const result = spawnSync(process.execPath, [join(AIDLC_SRC, `tools/aidlc-${name}.ts`), ...args, "--project-dir", p], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS), encoding: "utf-8", env,
  });
  return { status: result.status, stdout: result.stdout, out: `${result.stdout}${result.stderr}` };
}

function json(result: { status: number | null; stdout: string; out: string }): Record<string, unknown> {
  expect(result.status, result.out).toBe(0);
  return JSON.parse(result.stdout.trim().split("\n").at(-1)!) as Record<string, unknown>;
}

function reviewArgs(slug: string, unit: string, iteration: number): string[] {
  return ["review", "--stage", slug, "--reviewer", findStageBySlug(slug)!.reviewer!, "--unit", unit, "--iteration", String(iteration)];
}

// One review through the logger, as a run records it: the request, the
// reviewer's file, the verdict. A `finding` makes it NOT-READY.
function review(p: string, slug: string, iteration: number, finding?: string, unit = "alpha") {
  const args = reviewArgs(slug, unit, iteration);
  const request = json(tool(p, "log", args)) as { reviewFile: string };
  const verdict = finding === undefined ? "READY" : "NOT-READY";
  mkdirSync(dirname(join(p, request.reviewFile)), { recursive: true });
  writeFileSync(join(p, request.reviewFile), `**Verdict:** ${verdict}\n**Reviewer:** ${findStageBySlug(slug)!.reviewer!}\n` +
    `**Iteration:** ${iteration}\n\n### Findings\n\n${finding === undefined ? "No blocking findings.\n" :
      "| ID | Severity | Location | Finding | Required action | Status |\n|---|---|---|---|---|---|\n" +
      `| R-01 | Major | ${finding} | It cannot work on this platform. | Change the approach. | New |\n`}`);
  json(tool(p, "log", [...args, "--verdict", verdict]));
}

// One stage of a Unit: its outputs, its reviews with the verdicts given, and
// `afterReview` run after the last one (the changed approach), then its
// completion receipt.
function buildStage(p: string, slug: string, unit: string, verdicts: Array<string | undefined>, afterReview?: () => void) {
  const stage = findStageBySlug(slug)!;
  const output = join(seededRecordDir(p), "construction", unit, slug);
  mkdirSync(output, { recursive: true });
  for (const name of stage.produces ?? []) writeFileSync(join(output, artifactFilename(name)), `# ${unit} ${name}\n`);
  if (stage.workspace_requires) {
    writeFileSync(join(output, "source-manifest.json"), JSON.stringify({
      stage: slug, unit, version: 1, writes: [{ path: `src/${unit}.ts` }],
    }));
  }
  for (const [index, finding] of verdicts.entries()) review(p, slug, index + 1, finding, unit);
  afterReview?.();
  appendAuditEntry("UNIT_COMPLETED", {
    Stage: slug, Unit: unit, Mode: "wave",
    "Run floor": latestMainWorkflowStageRunFloorForProject(p, slug, true, unit),
    "Artifact Fingerprint": reviewArtifactFingerprint(p, stage, unit, { requireRequiredArtifacts: true })!,
  }, p);
}

function build(p: string, codeVerdicts: Array<string | undefined>, afterReview?: () => void) {
  for (const slug of STAGES) {
    if (slug === "code-generation") buildStage(p, slug, "alpha", codeVerdicts, afterReview);
    else buildStage(p, slug, "alpha", [undefined]);
  }
}

// A design document edited after its review, as the write hook records it.
function editDocument(p: string, slug: string, unit: string, words: string) {
  const document = join(seededRecordDir(p), "construction", unit, slug, artifactFilename(findStageBySlug(slug)!.produces![0]));
  writeFileSync(document, `${readFileSync(document, "utf-8")}\n${words}\n`);
  appendAuditEntry("ARTIFACT_UPDATED", { File: relative(p, document).replaceAll("\\", "/"), Stage: slug, Unit: unit }, p);
}

function humanTurn(p: string, prompt: string) {
  const env: NodeJS.ProcessEnv = { ...process.env, AIDLC_PROJECT_DIR: p, CLAUDE_PROJECT_DIR: p };
  delete env.AIDLC_SKIP_HUMAN_PRESENCE_GUARD;
  const result = spawnSync(process.execPath, [join(AIDLC_SRC, "tools/aidlc.ts"), "engine", "hook", "record-human-turn"], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS), encoding: "utf-8", cwd: p, env,
    input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: SESSION, prompt }),
  });
  expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
}

function recordCommand(p: string) {
  const script = join(seededRecordDir(p), "check.cjs");
  writeFileSync(script, "process.exit(0);");
  const quote = (value: string) => process.platform === "win32"
    ? `"${value.replaceAll('"', '""')}"`
    : `'${value.replaceAll("'", "'\\''")}'`;
  const command = `${quote(process.execPath)} ${quote(script)}`;
  const identity = ["--stage", "code-generation", "--checkpoint", "verification-command", "--command", command, "--session", SESSION];
  const env = { ...process.env, AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "1" };
  json(tool(p, "log", ["decision", ...identity, "--decision", "Use this command to verify each completed Unit?", "--options", "Approve,Request Changes"], env));
  humanTurn(p, "Approve");
  json(tool(p, "log", ["answer", ...identity, "--details", "Approve"], env));
  json(tool(p, "state", ["set-construction-verification-command", command], env));
}

function checkpoint(p: string, action: string, extra: string[] = []) {
  return json(tool(p, "bolt", ["checkpoint", "--unit", "alpha", "--kind", "unit", "--action", action, ...extra]));
}

// The Unit's approval as the person meets it: verified, then asked. What `ask`
// returns is the last thing before the question.
function toTheQuestion(p: string, command = true) {
  if (command) recordCommand(p);
  const verified = checkpoint(p, "verify");
  expect(verified.verified, JSON.stringify(verified)).toBe(true);
  const asked = checkpoint(p, "ask", ["--session", SESSION]);
  return { verified, asked };
}

function heard(step: { verified: Record<string, unknown>; asked: Record<string, unknown> }): string {
  return [...((step.verified.change_notices as string[] | undefined) ?? []), String(step.asked.check_offer ?? "")].join("\n");
}

function approve(p: string) {
  humanTurn(p, "Approve");
  return checkpoint(p, "approve", ["--session", SESSION, "--user-input", "Approve"]);
}

const changedApproach = (p: string) => () => writeFileSync(join(p, "src", "alpha.ts"), "export const alpha = 2; // compensating controls\n");
const accepted = (p: string) => readAuditShardEvents(p).filter((row) => row.event === "CHANGE_ACCEPTED");

describe("t-approval-offers-a-check", () => {
  test("passes spent and the code changed after the last review: the approval offers a check, once, with the question", () => {
    const p = fixture();
    build(p, ["src/alpha.ts", "src/alpha.ts"], changedApproach(p));
    const step = toTheQuestion(p);
    expect(heard(step)).toContain("changed after the alpha Unit was reviewed");
    expect(step.asked.check_offer, JSON.stringify(step.asked)).toBe(OFFER);
    expect(JSON.stringify(step.verified)).not.toContain(OFFER);
  });

  test("control: READY with a pass left, and the code changed after the review: the change line, no offer", () => {
    const p = fixture();
    build(p, [undefined], changedApproach(p));
    const said = heard(toTheQuestion(p));
    expect(said).toContain("changed after the alpha Unit was reviewed");
    expect(said).not.toContain(OFFER);
  });

  test("control: passes spent and nothing changed after the last review: no offer", () => {
    const p = fixture();
    build(p, ["src/alpha.ts", "src/alpha.ts"]);
    expect(JSON.stringify(toTheQuestion(p))).not.toContain(OFFER);
  });

  test("the person says yes: the check runs past the passes, and the approval comes back with no offer", () => {
    const p = fixture();
    build(p, ["src/alpha.ts", "src/alpha.ts"], changedApproach(p));
    expect(toTheQuestion(p).asked.check_offer).toBe(OFFER);
    humanTurn(p, "Yes, have the new approach checked before I decide");
    review(p, "code-generation", 3);
    const again = toTheQuestion(p, false);
    // The question says the re-check's verdict ("alpha's code changed after its review, so it was re-checked: ready").
    expect(again.asked.rechecked).toEqual({ verdict: "READY", approved_before: false, changed: "code" });
    expect(JSON.stringify(again)).not.toContain(OFFER);
    expect(approve(p).approved).toBe(true);
  });

  test("the person approves instead: approved as it is, nothing refused, nothing asked again", () => {
    const p = fixture();
    build(p, ["src/alpha.ts", "src/alpha.ts"], changedApproach(p));
    expect(toTheQuestion(p).asked.check_offer).toBe(OFFER);
    expect(approve(p).approved).toBe(true);
    expect(readAuditShardEvents(p).filter((row) => row.event === "GATE_REJECTED")).toEqual([]);
  });

  test("an advisory review (one pass) spent and a design document changed after it: the offer", () => {
    const p = fixture({ review: "advisory" });
    build(p, [undefined]);
    editDocument(p, "infrastructure-design", "alpha", "Accept the residual risk with compensating controls.");
    const step = toTheQuestion(p);
    expect(step.asked.check_offer, JSON.stringify(step)).toBe(OFFER);
  });

  test("the stage's approval: the offer ends the change line it follows, and the change lines still count the kept changes", () => {
    const p = fixture({ checkpoints: false });
    const slug = "functional-design";
    buildStage(p, slug, "alpha", ["entities.md", "entities.md"]);
    buildStage(p, slug, "beta", [undefined]);
    editDocument(p, slug, "alpha", "A new approach.");
    const before = accepted(p).length;
    const env = { ...process.env };
    delete env.AIDLC_SKIP_ARTIFACT_GUARD;
    const gate = json(tool(p, "orchestrate", ["report", "--stage", slug, "--result", "awaiting-approval"], env));
    const notices = (gate.change_notices as string[] | undefined) ?? [];
    const kept = accepted(p).slice(before).map((row) => auditBlockField(row.block, "Details") ?? "");
    const line = kept.find((details) => details.includes("alpha"));
    expect(line, JSON.stringify(gate)).toBeDefined();
    expect(notices).toContain(`${line} ${OFFER}`);
    expect(notices).toHaveLength(kept.length);
    expect(JSON.stringify(gate).split(OFFER)).toHaveLength(2);
  });

  test("Guard Policy strict: the changed work is re-checked on its own, and no offer is made", () => {
    const p = fixture({ policy: "strict (set by you)" });
    build(p, ["src/alpha.ts", "src/alpha.ts"], changedApproach(p));
    const result = runOrchestrateNext(join(AIDLC_SRC, "tools/aidlc-orchestrate.ts"), p, []);
    expect(result.directive, result.out).not.toBeNull();
    expect(JSON.stringify(result.directive)).not.toContain(OFFER);
    expect(accepted(p)).toEqual([]);
  });
});
