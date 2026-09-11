// covers: subcommand:aidlc-log:review, subcommand:aidlc-orchestrate:report,
// subcommand:aidlc-state:unit, function:teamUnitGateStatus,
// function:reviewAttemptAccounting, function:evaluateGuardRefusal,
// directive:guard-recovery
//
// OMP F1: terminal summary refusal must use the team Unit gate, not the
// still-in-progress global checkbox. Start/complete, rejection, summary
// authorization, output descent, and the pending request use their owning
// commands/hooks; no review or lifecycle audit rows are fabricated.
//
// This is an isolated CLI regression with an initial state/DAG fixture and
// synthetic human/reviewer content. File writes do not traverse PreToolUse
// guards, so this is NOT full production-guard or live-harness coverage.

import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  auditBlockField,
  docsRoot,
  findStageBySlug,
  getField,
  type GuardRefusalRecord,
  guardRecoveryAskFromRefusalText,
  parseCheckboxes,
  readAuditShardEvents,
  reviewAttemptAccounting,
  reviewAttemptWindow,
  teamUnitGateStatus,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createTestProject,
  recordArtifactWriteViaHook,
  REPO_ROOT,
  seedAidlcMemory,
  seedBoltDag,
  seededRecordDir,
  seededStateFile,
} from "../harness/fixtures.ts";

const STAGE = "functional-design";
const UNIT = "alpha";
const REVIEWER = "aidlc-architecture-reviewer-agent";
const SESSION = "01995000-0995-7000-8000-000000000f01";
const ORIGINAL = "Only the owner can read a saved search.";
const CHANGED = "The owner can share a saved search with their team.";
const projects: string[] = [];

afterAll(() => {
  for (const project of projects) cleanupTestProject(project);
});

type Run = { code: number; stdout: string; stderr: string };
type Json = Record<string, unknown>;

function succeeded(run: Run, context: string): Run {
  expect(run.code, `${context}\n${run.stdout}\n${run.stderr}`).toBe(0);
  return run;
}

function json(run: Run, context: string): Json {
  succeeded(run, context);
  return JSON.parse(run.stdout.trim().split("\n").at(-1)!) as Json;
}

function questionsBody(answer: string, requirement = ORIGINAL): string {
  return [
    "# Functional Design Questions", "",
    "## Q1 — Visibility", "", requirement, "",
    "## Consolidated Summary Confirmation", "",
    "- Looks correct",
    "- Request changes", "",
    `[Answer]: ${answer}`, "",
  ].join("\n");
}

class UnitReview {
  readonly dir: string;
  readonly env: NodeJS.ProcessEnv;
  readonly questions: string;
  readonly stageDir: string;

  constructor() {
    // Keep fixture scratch in the root checkout, including when this file runs
    // from a worktree. No Git write or commit is needed for functional-design.
    const commonDir = execFileSync(
      "git", ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      { cwd: REPO_ROOT, encoding: "utf-8" },
    ).trim();
    const scratch = join(dirname(commonDir), "tmp", "guard-recovery-contract", "omp-fixes");
    mkdirSync(scratch, { recursive: true });
    const previousTmp = process.env.TMPDIR;
    try {
      process.env.TMPDIR = scratch;
      this.dir = createTestProject();
    } finally {
      if (previousTmp === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previousTmp;
    }
    projects.push(this.dir);
    seedAidlcMemory(this.dir);
    this.env = {
      ...process.env,
      TMPDIR: scratch,
      CLAUDE_PROJECT_DIR: this.dir,
      AIDLC_PROJECT_DIR: this.dir,
      AIDLC_HARNESS_DIR: ".claude",
      AIDLC_UNATTENDED: "0",
    };
    // The ordinary runner supplies fixture skips. Restore enforcement for
    // every child, including request admission and the terminal verdict.
    // There is no summary-skip window used to manufacture a pending request.
    for (const key of Object.keys(this.env)) {
      if (/^AIDLC_(?:SKIP|DISABLE|ALLOW_DIRECT)_/.test(key)) this.env[key] = "0";
    }
    for (const key of [
      "AIDLC_SKIP_ARTIFACT_GUARD",
      "AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD",
      "AIDLC_SKIP_HUMAN_PRESENCE_GUARD",
      "AIDLC_SKIP_REVIEWER_GATE_GUARD",
      "AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS",
      "AIDLC_ALLOW_DIRECT_AUDIT_EVENTS",
    ]) this.env[key] = "0";
    delete this.env.AWS_AIDLC_DEFAULT_SCOPE;

    // Initial Construction state follows t335's team Unit fixture. Subsequent
    // lifecycle changes belong exclusively to state unit/orchestrate report.
    writeFileSync(seededStateFile(this.dir), [
      "# AI-DLC State Tracking", "",
      "## Project Information",
      "- **Project**: team Unit terminal review regression",
      "- **Project Type**: Greenfield",
      "- **Scope**: feature",
      "- **State Version**: 8",
      "- **Skeleton Stance**: on", "",
      "## Runtime State",
      "- **Revision Count**: 0",
      "- **Construction Iteration**: unit-major",
      "- **Unit Ownership**: team",
      "- **Unit Gate Rhythm**: per-stage", "",
      "## Scope Configuration",
      "- **Stages to Execute**: all",
      "- **Stages to Skip**: none",
      "- **Depth**: Standard",
      "- **Test Strategy**: Standard",
      "- **Change Control**: strict (set by you)", "",
      "## Stage Progress", "",
      "### CONSTRUCTION PHASE",
      `- [-] ${STAGE} — EXECUTE`,
      "- [ ] nfr-requirements — EXECUTE",
      "- [ ] nfr-design — EXECUTE",
      "- [ ] infrastructure-design — EXECUTE",
      "- [ ] code-generation — EXECUTE",
      "- [ ] build-and-test — EXECUTE", "",
      "## Current Status",
      "- **Lifecycle Phase**: CONSTRUCTION",
      `- **Current Stage**: ${STAGE}`,
      "- **Status**: Running",
      "- **Last Updated**: 2026-09-11T00:00:00Z", "",
    ].join("\n"));
    seedBoltDag(this.dir, [UNIT]);
    this.stageDir = join(seededRecordDir(this.dir), "construction", UNIT, STAGE);
    mkdirSync(this.stageDir, { recursive: true });
    this.questions = join(this.stageDir, `${STAGE}-questions.md`);
  }

  run(argv: string[], input?: Json): Run {
    const child = Bun.spawnSync(argv, {
      cwd: this.dir,
      env: this.env,
      stdin: input === undefined ? "ignore" : Buffer.from(JSON.stringify(input)),
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      code: child.exitCode,
      stdout: child.stdout.toString(),
      stderr: child.stderr.toString(),
    };
  }

  tool(name: string, args: string[]): Run {
    return this.run([
      process.execPath, join(AIDLC_SRC, "tools", `aidlc-${name}.ts`),
      ...args, "--project-dir", this.dir,
    ]);
  }

  human(prompt: string): void {
    succeeded(this.run([
      process.execPath, join(AIDLC_SRC, "hooks", "aidlc-record-human-turn.ts"),
    ], {
      hook_event_name: "UserPromptSubmit", session_id: SESSION,
      cwd: this.dir, prompt,
    }), "Record a separate human response through its hook");
  }

  state(): string {
    return readFileSync(seededStateFile(this.dir), "utf-8");
  }

  events(event: string): string[] {
    return readAuditShardEvents(this.dir)
      .filter((row) =>
        row.event === event &&
        auditBlockField(row.block, "Stage") === STAGE &&
        auditBlockField(row.block, "Unit") === UNIT
      )
      .map((row) => row.block);
  }

  assertGate(status: "pending" | "revising"): void {
    const state = this.state();
    expect(getField(state, "Unit Ownership")).toBe("team");
    expect(parseCheckboxes(state).find((row) => row.slug === STAGE)?.state)
      .toBe("in-progress");
    expect(teamUnitGateStatus(this.dir, state, STAGE, UNIT)).toEqual({
      resolved: true, scope: "per-stage", gateStage: STAGE, status,
    });
  }

  confirm(choice: "Looks correct" | "Request changes" = "Looks correct", requirement = ORIGINAL): Json {
    const args = [
      "--stage", STAGE, "--unit", UNIT,
      "--checkpoint", "summary-confirmation", "--questions-file", this.questions,
    ];
    writeFileSync(this.questions, questionsBody("", requirement));
    json(this.tool("log", [
      "decision", ...args, "--decision", "Does this all look correct?",
      "--options", "Looks correct,Request changes",
    ]), "Present the Unit summary");
    this.human(choice);
    writeFileSync(this.questions, questionsBody(choice, requirement));
    const answer = json(this.tool("log", ["answer", ...args, "--details", choice]),
      "Record the Unit summary answer");
    expect(answer.emitted).toBe("SUMMARY_CONFIRMATION_RECORDED");
    if (choice === "Looks correct") {
      expect(answer.summary_authorization_id).toMatch(/^[a-f0-9]{64}$/);
    } else {
      expect(answer.summary_authorization_id).toBeUndefined();
    }
    return answer;
  }

  outputs(): void {
    for (const [name, body] of [
      ["entities.md", "# Entities\n\n```yaml\nentities: []\n```\n"],
      ["rules.md", "# Rules\n\n```yaml\nrules: []\n```\n"],
      ["functional-spec.md", `# Functional Spec\n\n## Workflows\n\n${ORIGINAL}\n`],
      ["traceability.json", '{"links":[]}\n'],
    ]) {
      const path = join(this.stageDir, name);
      writeFileSync(path, body);
      recordArtifactWriteViaHook(this.dir, path, "Write", this.env);
    }
  }

  reject(): Json {
    const feedback = "Clarify who can read a saved search.";
    this.human(`Request Changes: ${feedback}`);
    return json(this.tool("orchestrate", [
      "report", "--stage", STAGE, "--unit", UNIT, "--result", "rejected",
      "--user-input", "Request Changes", "--reason", feedback,
    ]), "Report the human's Unit rejection");
  }

  reviewArgs(): string[] {
    return [
      "review", "--stage", STAGE, "--unit", UNIT,
      "--reviewer", REVIEWER, "--iteration", "1",
    ];
  }

  accounting() {
    const state = this.state();
    const stage = findStageBySlug(STAGE)!;
    return reviewAttemptAccounting(
      this.dir, reviewAttemptWindow(this.dir, state, stage),
      state, stage, REVIEWER, UNIT, undefined,
    );
  }

  refusal(): GuardRefusalRecord["refusal"] {
    const dir = join(docsRoot(this.dir), ".aidlc-guard-refusals");
    const records = readdirSync(dir).filter((name) => name.endsWith(".json"))
      .map((name) => JSON.parse(readFileSync(join(dir, name), "utf-8")) as GuardRefusalRecord)
      .filter((record) => record.refusal.stage === STAGE && record.refusal.unit === UNIT);
    expect(records).toHaveLength(1);
    return records[0].refusal;
  }
}

describe("OMP F1: terminal review refusal respects the team Unit gate", () => {
  for (const scenario of [
    { name: "missing questions", code: "SUMMARY_QUESTIONS_MISSING" },
    { name: "withdrawn confirmation", code: "SUMMARY_ANSWER_INVALID" },
    { name: "changed confirmed inputs", code: "SUMMARY_ARTIFACT_UNAUTHORIZED" },
  ] as const) {
    for (const verdict of ["READY", "NOT-READY"] as const) {
      test(`${scenario.name} at ${verdict} offers redo for a revising Unit, not another rejection`, () => {
        const p = new UnitReview();
        p.assertGate("pending");
        expect(p.events("REVIEW_REQUESTED")).toEqual([]);
        expect(json(p.tool("state", [
          "unit", "start", "--stage", STAGE, "--unit", UNIT,
        ]), "Start the engine-routed Unit").emitted).toBe("UNIT_STARTED");
        p.confirm();
        p.outputs();
        expect(json(p.tool("state", [
          "unit", "complete", "--stage", STAGE, "--unit", UNIT,
        ]), "Complete the actual active Unit").emitted).toBe("UNIT_COMPLETED");
        expect(p.events("UNIT_STARTED")).toHaveLength(1);
        expect(p.events("UNIT_COMPLETED")).toHaveLength(1);

        // The owning reject command permits a pending Unit gate; no synthetic
        // awaiting-approval/rejection row is needed. Its boundary starts the
        // new review attempt while the global checkbox remains [-].
        expect(p.reject().kind).toBe("print");
        expect(p.events("GATE_REJECTED")).toHaveLength(1);
        expect(p.events("STAGE_REVISING")).toHaveLength(1);
        p.assertGate("revising");
        const confirmed = p.confirm();
        p.outputs();
        const requested = json(p.tool("log", p.reviewArgs()),
          "Request a fresh review while the actual Unit gate is revising");
        expect(requested.emitted).toBe("REVIEW_REQUESTED");
        expect(requested.requestId).toMatch(/^review:[a-f0-9]{32}$/);
        expect(typeof requested.reviewFile).toBe("string");
        const pending = p.accounting();
        expect(pending.ambiguity).toBeNull();
        expect([...pending.pendingIterations]).toEqual([1]);
        expect(pending.pendingRequests.get(1)?.binding?.requestId).toBe(String(requested.requestId));
        p.assertGate("revising");

        const draft = resolve(p.dir, requested.reviewFile as string);
        mkdirSync(dirname(draft), { recursive: true });
        const review = [
          "## Review", "",
          `**Verdict:** ${verdict}`,
          `**Reviewer:** ${REVIEWER}`,
          "**Iteration:** 1", "",
          "### Findings", "",
          verdict === "READY"
            ? "No outstanding findings."
            : "The visibility rule needs a concrete acceptance example.", "",
        ].join("\n");
        writeFileSync(draft, review);
        if (scenario.name === "missing questions") {
          unlinkSync(p.questions);
        } else if (scenario.name === "withdrawn confirmation") {
          p.confirm("Request changes");
        } else {
          expect(p.confirm("Looks correct", CHANGED).summary_authorization_id)
            .not.toBe(confirmed.summary_authorization_id);
        }
        const stateBefore = p.state();
        const requestsBefore = p.events("REVIEW_REQUESTED");
        expect(requestsBefore).toHaveLength(1);
        p.assertGate("revising");
        expect(p.env.AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD).toBe("0");
        const refused = p.tool("log", [...p.reviewArgs(), "--verdict", verdict]);
        expect(refused.code, refused.stdout + refused.stderr).not.toBe(0);
        // aidlc-log wraps the multiline refusal in its JSON error envelope.
        const error = JSON.parse(refused.stderr.trim().split("\n").at(-1)!) as Json;
        expect(typeof error.error, refused.stderr).toBe("string");
        const ask = guardRecoveryAskFromRefusalText(error.error as string);
        expect(ask, refused.stderr).not.toBeNull();
        expect(ask!.reason_codes).toContain(scenario.code);
        expect(ask).toMatchObject({
          kind: "ask", ask_type: "guard-recovery",
          response_route: "execute-remedy", stage: STAGE, unit: UNIT,
        });
        expect(p.state()).toBe(stateBefore);
        expect(p.events("REVIEW_REQUESTED")).toEqual(requestsBefore);
        expect(p.events("REVIEW_COMPLETED")).toEqual([]);
        expect(p.accounting().pendingRequests.get(1)).toEqual(pending.pendingRequests.get(1));
        expect([...p.accounting().pendingIterations]).toEqual([1]);
        expect(readFileSync(draft, "utf-8")).toBe(review);
        expect(existsSync(draft.replace(/\.review\.md$/, ".json"))).toBe(false);
        p.assertGate("revising");

        // Behavioral contrast: another rejection cannot advance this Unit.
        // A fresh human turn ensures this fails on the Unit lifecycle itself,
        // rather than on missing human authority or an absent feedback string.
        const rejectedAgain = p.reject();
        expect(rejectedAgain.kind).toBe("error");
        expect(String(rejectedAgain.message)).toContain(
          `Transition rejected by aidlc-state.ts reject for unit "${UNIT}" of "${STAGE}"`,
        );
        expect(String(rejectedAgain.message)).toContain(
          "is revising; only a pending or awaiting gate can be rejected.",
        );
        expect(p.events("GATE_REJECTED")).toHaveLength(1);
        expect(p.state()).toBe(stateBefore);
        expect(p.accounting().pendingRequests.get(1)).toEqual(pending.pendingRequests.get(1));

        // Primary F1 assertion: before the fix this is "in-progress", inherited
        // from the global checkbox despite the proven revising Unit gate.
        expect(p.refusal()).toMatchObject({
          code: scenario.code, blockedAction: "review-verdict",
          stage: STAGE, unit: UNIT, state: "revising",
        });
        expect(ask!.remedies.map((remedy) => remedy.op)).not.toContain("request-changes");
        expect(ask!.remedies.map((remedy) => remedy.op)).not.toContain("record-verdict");
        expect(ask!.remedies.find((remedy) => remedy.op === "redo-jump")).toMatchObject({
          executableNow: true,
          requiresHuman: true,
          interaction: "command",
          operation: { kind: "restart-stage", stage: STAGE },
        });
        if (scenario.name === "withdrawn confirmation") {
          expect(ask!.remedies.find((remedy) => remedy.op === "reconfirm-summary")).toMatchObject({
            executableNow: true, requiresHuman: true, interaction: "human-input",
          });
          // The lighter remedy actually works through the summary/verdict
          // owners while the Unit remains revising; no redo or second reject.
          expect(p.confirm().summary_authorization_id).toBe(confirmed.summary_authorization_id);
          expect(json(p.tool("log", [...p.reviewArgs(), "--verdict", verdict]),
            "Record the pending review after actual human reconfirmation").emitted)
            .toBe("REVIEW_COMPLETED");
          expect(p.events("REVIEW_REQUESTED")).toEqual(requestsBefore);
          expect(p.events("REVIEW_COMPLETED")).toHaveLength(1);
          expect(p.events("GATE_REJECTED")).toHaveLength(1);
          p.assertGate("revising");
        }
      }, 120_000);
    }
  }
});
