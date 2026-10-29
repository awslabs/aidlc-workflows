// covers: subcommand:aidlc-log:review, function:prepareReviewCopy, function:removeReviewCopy, function:sweepReviewCopies, function:reviewRequestNote, hook:aidlc-log-subagent, hook:aidlc-session-start
//
// The reviewer read-scope copy on Kiro (kiro-ide), end to end on an installed
// tree of a stable release: a Unit's review request writes a copy of the
// installed reviewer that carries the review's read scope and hands its name
// back; the completion Kiro reports under the copy's name is the reviewer's;
// the verdict removes the copy. With the reviewer read-scope check off, the
// request is the request it was. A review that is over without its verdict (the
// person approved the Unit over it) leaves its copy only until the next chat
// starts or the next review is asked for; its request stays open for a verdict
// that comes in later.
// Kiro itself is not driven here: that a delegated agent's fs_read deny with an
// exclude is enforced was measured on Kiro CLI 2.31.0 and Kiro IDE 1.3.0.

import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS } from "../harness/test-budget.ts";
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import {
  artifactFilename,
  auditBlockField,
  findStageBySlug,
  latestMainWorkflowStageRunFloorForProject,
  openReviewRequests,
  readAuditShardEvents,
  reviewArtifactFingerprint,
  sourceBaselineAuditFields,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  cleanupTestProject,
  createTestProject,
  REPO_ROOT,
  seededAuditDir,
  seedAidlcMemory,
  seedBoltDag,
  seededRecordDir,
  seededStateFile,
} from "../harness/fixtures.ts";

// The stage's checks run once before its review or gate, and again at the gate
// (completionChecksStep, t-checks-before-review); this file's fixture documents
// are not written for them and its subject is not them, so they stay off here.
process.env.AIDLC_DISABLE_SENSORS = "1";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const STAGE = "functional-design";
const UNIT = "alpha";
const REVIEWER = "aidlc-architecture-reviewer-agent";
const KIRO_IDE_TREE = join(REPO_ROOT, "dist", "kiro-ide", ".kiro");
const projects: string[] = [];

afterAll(() => {
  for (const project of projects) cleanupTestProject(project);
});

type Run = { code: number; stdout: string; stderr: string };
type Json = Record<string, unknown>;

function json(run: Run, context: string): Json {
  expect(run.code, `${context}\n${run.stdout}\n${run.stderr}`).toBe(0);
  return JSON.parse(run.stdout.trim().split("\n").at(-1)!) as Json;
}

class KiroUnitReview {
  readonly dir: string;
  readonly env: NodeJS.ProcessEnv;

  constructor() {
    this.dir = createTestProject();
    projects.push(this.dir);
    seedAidlcMemory(this.dir);
    cpSync(KIRO_IDE_TREE, join(this.dir, ".kiro"), { recursive: true });
    // A record the dropped preview switch left behind changes nothing.
    const harnessData = join(this.dir, ".kiro", "tools", "data", "harness.json");
    writeFileSync(
      harnessData,
      `${JSON.stringify({ ...JSON.parse(readFileSync(harnessData, "utf-8")), previewFeatures: { "reviewer-read-scope": "off" } }, null, 2)}\n`,
    );
    this.env = { ...process.env, AIDLC_PROJECT_DIR: this.dir };
    for (const key of ["AIDLC_HARNESS_DIR", "AIDLC_AGENTS_DIR", "AIDLC_HARNESS_NAME", "AIDLC_DISABLE_REVIEWER_SCOPE_HOOK", "CLAUDE_PROJECT_DIR"]) {
      delete this.env[key];
    }
    writeFileSync(seededStateFile(this.dir), [
      "# AI-DLC State Tracking", "",
      "## Project Information",
      "- **Project**: Kiro reviewer copy",
      "- **Project Type**: Greenfield",
      "- **Scope**: feature",
      "- **State Version**: 8",
      "- **Skeleton Stance**: on", "",
      "## Runtime State",
      "- **Revision Count**: 0",
      "- **Construction Iteration**: unit-major", "",
      "## Scope Configuration",
      "- **Stages to Execute**: all",
      "- **Stages to Skip**: none",
      "- **Depth**: Standard",
      "- **Test Strategy**: Standard", "",
      "## Stage Progress", "",
      "### CONSTRUCTION PHASE",
      `- [-] ${STAGE} — EXECUTE`,
      "- [ ] code-generation — EXECUTE", "",
      "## Current Status",
      "- **Lifecycle Phase**: CONSTRUCTION",
      `- **Current Stage**: ${STAGE}`,
      "- **Status**: Running",
      "- **Last Updated**: 2026-10-15T00:00:00Z", "",
    ].join("\n"));
    seedBoltDag(this.dir, [UNIT, "beta"]);
    const stageDir = join(seededRecordDir(this.dir), "construction", UNIT, STAGE);
    mkdirSync(stageDir, { recursive: true });
    writeFileSync(join(stageDir, `${STAGE}-questions.md`), "# Questions\n\n[Answer]: Looks correct\n");
    for (const [name, body] of [
      ["entities.md", "# Entities\n\n```yaml\nentities: []\n```\n"],
      ["rules.md", "# Rules\n\n```yaml\nrules: []\n```\n"],
      ["functional-spec.md", "# Functional Spec\n\n## Workflows\n\nOnly the owner reads a note.\n"],
      ["traceability.json", '{"links":[]}\n'],
    ]) writeFileSync(join(stageDir, name), body);
  }

  run(argv: string[], input?: Json, env: NodeJS.ProcessEnv = {}): Run {
    const child = Bun.spawnSync(argv, {
      cwd: this.dir,
      env: { ...this.env, ...env },
      stdin: input === undefined ? "ignore" : Buffer.from(JSON.stringify(input)),
      stdout: "pipe",
      stderr: "pipe",
    });
    return { code: child.exitCode, stdout: child.stdout.toString(), stderr: child.stderr.toString() };
  }

  // As the conductor runs it: `{{INVOKE}} engine log review ...`.
  log(args: string[]): Run {
    return this.run([
      process.execPath, join(this.dir, ".kiro", "tools", "aidlc.ts"), "engine", "log", ...args, "--project-dir", this.dir,
    ]);
  }

  reviewArgs(...extra: string[]): string[] {
    return ["review", "--stage", STAGE, "--unit", UNIT, "--reviewer", REVIEWER, "--iteration", "1", ...extra];
  }

  // What the Kiro adapter receives when a dispatch returns.
  dispatched(name: string, response: string): Run {
    return this.run([process.execPath, join(this.dir, ".kiro", "hooks", "aidlc-kiro-adapter.ts"), "log-subagent"], {
      session_id: "sess_t-kiro-review-copy", hook_event_name: "PostToolUse", cwd: this.dir,
      tool_name: "invoke_sub_agent", tool_input: { name, prompt: "Review" }, tool_response: response,
    });
  }

  completions(): string[] {
    return readAuditShardEvents(this.dir).filter((row) => row.event === "SUBAGENT_COMPLETED").map((row) => row.block);
  }

  agents(): string[] {
    return readdirSync(join(this.dir, ".kiro", "agents")).sort();
  }
}

describe("the reviewer read-scope copy on Kiro", () => {
  test("a request on a stable release writes the copy and names it; its completion is the reviewer's; the verdict removes it", () => {
    const p = new KiroUnitReview();
    const shippedAgents = p.agents();
    const requested = json(p.log(p.reviewArgs()), "Request the Unit's review");
    expect(requested.emitted).toBe("REVIEW_REQUESTED");
    const requestId = String(requested.requestId);
    const copyName = `aidlc-scoped-review-${requestId.slice("review:".length, "review:".length + 12)}`;
    expect(requested.dispatchAgent).toBe(copyName);
    expect(String(requested.agent_note)).toContain(`Dispatch ${copyName} (${REVIEWER} with this review's read scope`);
    expect(String(requested.agent_note)).toContain(`name ${REVIEWER} as the reviewer in the brief`);

    const copy = readFileSync(join(p.dir, ".kiro", "agents", `${copyName}.md`), "utf-8");
    expect(copy).toContain(`\nname: ${copyName}\n`);
    expect(copy).toContain('        - "aidlc/spaces/*/intents/*/construction/**"');
    // Only this intent's folder of the Unit is opened again.
    const record = relative(p.dir, seededRecordDir(p.dir)).split(sep).join("/");
    expect(copy).toContain(`        - "${record}/construction/${UNIT}/**"`);
    expect(copy).not.toContain(`"aidlc/spaces/*/intents/*/construction/${UNIT}`);
    expect(copy).not.toContain("construction/beta");
    expect(readFileSync(join(p.dir, ".kiro", "agents", `${REVIEWER}.md`), "utf-8"))
      .toBe(readFileSync(join(KIRO_IDE_TREE, "agents", `${REVIEWER}.md`), "utf-8"));
    expect(p.agents()).toEqual([...shippedAgents, `${copyName}.md`].sort());
    // AI-DLC's .gitignore block keeps the copy out of the person's commits.
    expect(readFileSync(join(KIRO_IDE_TREE, "..", ".gitignore"), "utf-8").split("\n")).toContain(".kiro/agents/aidlc-scoped-review-*.md");

    const reviewFile = resolve(p.dir, String(requested.reviewFile));
    mkdirSync(dirname(reviewFile), { recursive: true });
    writeFileSync(reviewFile, [
      "## Review", "", "**Verdict:** READY", `**Reviewer:** ${REVIEWER}`, "**Iteration:** 1",
      "**Verdict Dictated:** no", "", "### Findings", "", "**Prior findings**", "",
      "| ID | Now | Severity | Note |", "|---|---|---|---|", "", "**New findings**", "",
      "| Severity | Location | Finding | Required action |", "|---|---|---|---|", "",
    ].join("\n"));
    expect(p.dispatched(copyName, `**Reviewer:** ${REVIEWER}\n\nVerdict: READY`).code).toBe(0);
    const [completion] = p.completions();
    expect(auditBlockField(completion, "Agent Type")).toBe(REVIEWER);
    expect(auditBlockField(completion, "Dispatch Agent")).toBe(copyName);
    // The review file's digest is taken as the reviewer's, so the verdict reads it as the reviewer's review.
    expect(auditBlockField(completion, "Review File Digest")).toMatch(/=[0-9a-f]{64}$/);

    json(p.log(p.reviewArgs("--verdict", "READY")), "Record the reviewer's verdict");
    expect(existsSync(join(p.dir, ".kiro", "agents", `${copyName}.md`))).toBe(false);
    expect(p.agents()).toEqual(shippedAgents);
  });

  test("a dispatch Kiro cannot find is no completion, so the reviewer it falls back to finishes the review", () => {
    const p = new KiroUnitReview();
    const requested = json(p.log(p.reviewArgs()), "Request the Unit's review");
    const copyName = String(requested.dispatchAgent);
    expect(copyName).toMatch(/^aidlc-scoped-review-[0-9a-f]{12}$/);
    expect(p.dispatched(copyName, `Agent '${copyName}' not found in registry`).code).toBe(0);
    expect(p.completions()).toEqual([]);
    // The fallback is said where doctor looks: the read scope was not held.
    expect(readFileSync(join(seededRecordDir(p.dir), ".aidlc-engine", "hooks-health", "kiro-adapter.drops"), "utf-8"))
      .toContain(`Kiro has no agent named ${copyName}`);
    expect(p.dispatched(REVIEWER, `**Reviewer:** ${REVIEWER}\n\nVerdict: READY`).code).toBe(0);
    expect(p.completions().map((row) => auditBlockField(row, "Agent Type"))).toEqual([REVIEWER]);
  });

  test("a copy that cannot be written is said in one line, and the reviewer itself is dispatched", () => {
    const p = new KiroUnitReview();
    const reviewerFile = join(p.dir, ".kiro", "agents", `${REVIEWER}.md`);
    writeFileSync(reviewerFile, readFileSync(reviewerFile, "utf-8").replace(/\npermissions:\n/, "\nreviewer_permissions:\n"));
    const requested = json(p.log(p.reviewArgs()), "Request the Unit's review");
    expect(requested.dispatchAgent).toBeUndefined();
    expect(requested.change_notices).toEqual([
      `This review of ${UNIT} can read other Units' files: AI-DLC could not hold the reviewer to this Unit this time.`,
    ]);
    expect(String(requested.agent_note)).toStartWith(`Dispatch ${REVIEWER} as a subagent`);
    // Doctor lists a drop by its reason up to the first ": ", cut to 120 characters: the cause fits.
    const drops = readFileSync(join(seededRecordDir(p.dir), ".aidlc-engine", "hooks-health", "reviewer-scope.drops"), "utf-8");
    const shown = drops.trim().split("\t").at(-1)!.split(": ")[0];
    expect(shown).toBe("reviewer copy not written, a name is not plain or the reviewer file is not in the installed shape");
    expect(shown.length).toBeLessThanOrEqual(120);
  });

  test("with the reviewer read-scope check switched off, the request is the request it was", () => {
    const p = new KiroUnitReview();
    p.env.AIDLC_DISABLE_REVIEWER_SCOPE_HOOK = "1";
    const shippedAgents = p.agents();
    const requested = json(p.log(p.reviewArgs()), "Request the Unit's review");
    expect(requested.emitted).toBe("REVIEW_REQUESTED");
    expect(requested.dispatchAgent).toBeUndefined();
    expect(String(requested.agent_note)).toStartWith(`Dispatch ${REVIEWER} as a subagent and have it write`);
    expect(p.agents()).toEqual(shippedAgents);
  });
});

// --- A Unit approved over its unfinished review (Code Generation, Unit checkpoints on). ---

const CG = "code-generation";
const CG_REVIEWER = findStageBySlug(CG)!.reviewer!;
const SESSION = "01995000-7a11-7000-8000-00000000a584";
const DASH = "\u2014"; // the state file's stage-line separator

class KiroUnitCheckpoint extends KiroUnitReview {
  constructor() {
    super();
    this.env.AIDLC_UNATTENDED = "0";
    for (const key of ["AIDLC_SKIP_HUMAN_PRESENCE_GUARD", "AIDLC_SESSION_OVERRIDE_SOURCE"]) delete this.env[key];
    const skipped = ["functional-design", "nfr-requirements", "nfr-design", "infrastructure-design"];
    writeFileSync(seededStateFile(this.dir), [
      "# AI-DLC State Tracking",
      "## Project Information",
      "- **Project**: Kiro reviewer copy after an approval",
      "- **Project Type**: Greenfield",
      "- **Project Type Source**: you",
      "- **Scope**: classic",
      "- **State Version**: 8",
      "## Runtime State",
      "- **Revision Count**: 0",
      "- **Skeleton Stance**: off",
      "- **Construction Iteration**: unit-major",
      "- **Construction Checkpoints**: enabled",
      "- **Construction Execution**: serial",
      "- **Construction Autonomy Mode**: gated",
      // Classic's default stands the read-scope check aside; set by the person, it holds.
      "- **Guard Policy**: strict (set by you)",
      "- **Review Override**: advisory",
      "## Scope Configuration",
      "- **Stages to Execute**: all",
      "- **Stages to Skip**: none",
      "- **Depth**: Standard",
      "- **Test Strategy**: Standard",
      "## Stage Progress",
      "### CONSTRUCTION PHASE",
      ...skipped.map((stage) => `- [S] ${stage} ${DASH} SKIP`),
      `- [-] ${CG} ${DASH} EXECUTE`,
      `- [ ] build-and-test ${DASH} EXECUTE`,
      "## Current Status",
      "- **Lifecycle Phase**: CONSTRUCTION",
      `- **Current Stage**: ${CG}`,
      "- **Status**: Running", "",
    ].join("\n"));
    mkdirSync(join(this.dir, "src"), { recursive: true });
    for (const unit of [UNIT, "beta"]) writeFileSync(join(this.dir, "src", `${unit}.ts`), `export const ${unit} = 1;\n`);
    appendAuditEntry("WORKFLOW_STARTED", { Scope: "classic", ...sourceBaselineAuditFields(this.dir, CG) }, this.dir);
    // The command each completed Unit is verified with, as the person approved it.
    const script = join(seededRecordDir(this.dir), "check.cjs");
    writeFileSync(script, "process.exit(0);");
    const command = process.platform === "win32"
      ? `"${process.execPath}" "${script}"`
      : `'${process.execPath}' '${script}'`;
    const identity = ["--stage", CG, "--checkpoint", "verification-command", "--command", command, "--session", "verify-command"];
    json(this.tool("log", ["decision", ...identity, "--decision", "Use this command to verify each completed Unit?",
      "--options", "Approve,Request Changes"]), "Ask for the verification command");
    this.says("Approve", "verify-command");
    json(this.tool("log", ["answer", ...identity, "--details", "Approve"]), "Record the answer");
    json(this.tool("state", ["set-construction-verification-command", command]), "Set the verification command");
  }

  tool(name: string, args: string[], env: NodeJS.ProcessEnv = {}): Run {
    return this.run([process.execPath, join(this.dir, ".kiro", "tools", `aidlc-${name}.ts`), ...args, "--project-dir", this.dir], undefined, env);
  }

  // What the person types, through the prompt hook.
  says(prompt: string, session = SESSION): void {
    const said = this.run([process.execPath, join(this.dir, ".kiro", "tools", "aidlc.ts"), "engine", "hook", "record-human-turn"],
      { hook_event_name: "UserPromptSubmit", session_id: session, prompt });
    expect(said.code, `${said.stdout}\n${said.stderr}`).toBe(0);
  }

  build(unit: string): void {
    const stage = findStageBySlug(CG)!;
    const output = join(seededRecordDir(this.dir), "construction", unit, CG);
    mkdirSync(output, { recursive: true });
    for (const name of stage.produces ?? []) writeFileSync(join(output, artifactFilename(name)), `# ${unit} ${name}\n`);
    writeFileSync(join(output, "source-manifest.json"), JSON.stringify({ stage: CG, unit, version: 1, writes: [{ path: `src/${unit}.ts` }] }));
    appendAuditEntry("UNIT_COMPLETED", {
      Stage: CG, Unit: unit, Mode: "wave",
      "Run floor": latestMainWorkflowStageRunFloorForProject(this.dir, CG, true, unit),
      "Artifact Fingerprint": reviewArtifactFingerprint(this.dir, stage, unit, { requireRequiredArtifacts: true })!,
    }, this.dir);
  }

  requestReview(unit: string): string {
    const requested = json(this.log(["review", "--stage", CG, "--unit", unit, "--reviewer", CG_REVIEWER, "--iteration", "1"]),
      `Request ${unit}'s review`);
    const copyName = String(requested.dispatchAgent);
    expect(copyName).toMatch(/^aidlc-scoped-review-[0-9a-f]{12}$/);
    return copyName;
  }

  // The person says to approve the Unit as it is, and the Unit is approved
  // over its review, which never got a verdict.
  approveOverReview(unit: string, beforeApproval: () => void = () => {}): void {
    this.says("approve it as it is");
    const turn = readAuditShardEvents(this.dir).filter((row) => row.event === "HUMAN_TURN" &&
      auditBlockField(row.block, "Session") === SESSION && auditBlockField(row.block, "Message Id") !== null).at(-1);
    const verified = json(this.tool("bolt", ["checkpoint", "--unit", unit, "--kind", "unit", "--action", "verify", "--session", SESSION,
      "--over-unfinished-review", "--message", turn ? auditBlockField(turn.block, "Message Id") ?? "" : ""],
      { AIDLC_SESSION_OVERRIDE: SESSION }), `Verify ${unit} over its review`);
    expect(verified.verified).toBe(true);
    beforeApproval();
    const approved = json(this.tool("bolt", ["checkpoint", "--unit", unit, "--kind", "unit", "--action", "approve", "--session", SESSION]),
      `Approve ${unit}`);
    expect(approved.approved).toBe(true);
    expect(approved.change_notices).toEqual([`Approved. The Code Generation review for ${unit} did not finish.`]);
  }

  // A chat starts in Kiro.
  chatStarts(): void {
    const started = this.run([process.execPath, join(this.dir, ".kiro", "hooks", "aidlc-kiro-adapter.ts"), "session-start"], {
      session_id: "sess_t-kiro-review-copy-next-chat", hook_event_name: "SessionStart", cwd: this.dir,
    });
    expect(started.code, `${started.stdout}\n${started.stderr}`).toBe(0);
  }

  hasCopy(copyName: string): boolean {
    return existsSync(join(this.dir, ".kiro", "agents", `${copyName}.md`));
  }
}

describe("a reviewer copy whose review is over without its verdict", () => {
  test("a Unit approved over its review: the copy leaves when the next chat starts, and the request stays open for a later verdict", () => {
    const p = new KiroUnitCheckpoint();
    p.build(UNIT);
    const copyName = p.requestReview(UNIT);
    // Another piece of work's copy: a request this record does not name.
    const otherWork = "aidlc-scoped-review-0123456789ab";
    cpSync(join(p.dir, ".kiro", "agents", `${copyName}.md`), join(p.dir, ".kiro", "agents", `${otherWork}.md`));
    p.approveOverReview(UNIT, () => {
      // Verified is not approved: the review may still finish.
      p.chatStarts();
      expect(p.hasCopy(copyName)).toBe(true);
    });
    expect(p.hasCopy(copyName)).toBe(true);

    p.chatStarts();
    expect(p.hasCopy(copyName)).toBe(false);
    expect(p.hasCopy(otherWork)).toBe(true);
    const requestId = `review:${copyName.slice("aidlc-scoped-review-".length)}`;
    expect(openReviewRequests(readAuditShardEvents(p.dir)).map((request) => request.requestId.slice(0, requestId.length)))
      .toContain(requestId);
    expect(readAuditShardEvents(p.dir).filter((row) => row.event === "REVIEW_COMPLETED")).toEqual([]);
    // The reviewer that was running when the person approved still finishes as the reviewer.
    expect(p.dispatched(copyName, `**Reviewer:** ${CG_REVIEWER}\n\nVerdict: READY`).code).toBe(0);
    expect(p.completions().map((row) => auditBlockField(row, "Agent Type"))).toEqual([CG_REVIEWER]);
  });

  test("the stage approved at its gate over a Unit's unfinished review: the copy leaves when the next chat starts", () => {
    const p = new KiroUnitCheckpoint();
    p.build(UNIT);
    const copyName = p.requestReview(UNIT);
    p.chatStarts();
    expect(p.hasCopy(copyName)).toBe(true);
    // The row the stage gate's approval writes (aidlc-state approve), with no Unit.
    appendAuditEntry("GATE_APPROVED", { Stage: CG, "User Input": "Approve", Review: "not finished" }, p.dir);
    p.chatStarts();
    expect(p.hasCopy(copyName)).toBe(false);
  });

  test("a Unit approved over its review and opened again before the next chat: the copy still leaves", () => {
    const p = new KiroUnitCheckpoint();
    p.build(UNIT);
    const copyName = p.requestReview(UNIT);
    p.approveOverReview(UNIT);
    // The Unit's checkpoint opened again (a reopen records the checkpoint's rejection).
    appendAuditEntry("GATE_REJECTED", {
      Unit: UNIT, Stage: CG, "Gate Stages": CG, "Gate Scope": "unit-end", Checkpoint: "construction-unit", Reopen: "jump",
    }, p.dir);
    p.chatStarts();
    expect(p.hasCopy(copyName)).toBe(false);
  });

  test("a reopen in another clone's log at the approval's second leaves their order unknown: the copy stays", () => {
    const p = new KiroUnitCheckpoint();
    p.build(UNIT);
    const copyName = p.requestReview(UNIT);
    p.approveOverReview(UNIT);
    const approval = readAuditShardEvents(p.dir).filter((row) => row.event === "GATE_APPROVED").at(-1)!;
    // Another clone's log (host "0", a token of zeros), named to sort before
    // this clone's own on an ordinary machine name: a reading that took rows in
    // file order would see the approval last and remove the copy.
    writeFileSync(join(seededAuditDir(p.dir), "0-00000000.md"), [
      "# AI-DLC Audit Log", "", "## GATE_REJECTED", `**Timestamp**: ${approval.timestamp}`, "**Event**: GATE_REJECTED",
      `**Unit**: ${UNIT}`, `**Stage**: ${CG}`, `**Gate Stages**: ${CG}`, "**Gate Scope**: unit-end",
      "**Checkpoint**: construction-unit", "", "---", "",
    ].join("\n"));
    expect(readAuditShardEvents(p.dir).filter((row) => row.event === "GATE_REJECTED")).toHaveLength(1);
    p.chatStarts();
    expect(p.hasCopy(copyName)).toBe(true);
  });

  test("an isolated run of the stage, or a batch of other Units approved, does not end the Unit's review: its copy stays", () => {
    const p = new KiroUnitCheckpoint();
    p.build(UNIT);
    const copyName = p.requestReview(UNIT);
    // An isolated run's start and approvals (`--single`) are its own.
    appendAuditEntry("WORKFLOW_STARTED", { Scope: "classic", Workflow: `single-stage:${CG}` }, p.dir);
    appendAuditEntry("GATE_APPROVED", { Stage: CG, Workflow: `single-stage:${CG}`, "User Input": "Approve" }, p.dir);
    appendAuditEntry("GATE_APPROVED", { Stage: CG, Unit: UNIT, Workflow: `single-stage:${CG}`, "User Input": "Approve" }, p.dir);
    // A batch of Units built side by side is approved as a checkpoint naming its Units.
    appendAuditEntry("GATE_APPROVED", {
      Checkpoint: "swarm-batch", Stage: CG, "Gate Stages": CG, "Batch number": "2", Units: "beta", "User Input": "Approve",
    }, p.dir);
    p.chatStarts();
    expect(p.hasCopy(copyName)).toBe(true);
  });

  test("the next Unit's review request removes the copy of a Unit approved over its review, and writes its own", () => {
    const p = new KiroUnitCheckpoint();
    p.build(UNIT);
    const alphaCopy = p.requestReview(UNIT);
    p.approveOverReview(UNIT);
    p.build("beta");
    const betaCopy = p.requestReview("beta");
    expect(p.hasCopy(alphaCopy)).toBe(false);
    expect(p.hasCopy(betaCopy)).toBe(true);
    // A chat that starts while beta's review waits leaves its copy.
    p.chatStarts();
    expect(p.hasCopy(betaCopy)).toBe(true);
  });
});
