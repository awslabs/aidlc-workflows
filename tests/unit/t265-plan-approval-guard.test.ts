// covers: hook:aidlc-plan-approval-guard, audit:PLAN_APPROVAL_BLOCKED
//
// t265 - code-generation's plan-before-generation ordering, enforced
// deterministically (issue: the plan was generated AFTER the code, beside
// code-summary.md, making it a retroactive summary instead of the input).
//
// Three layers, mirroring t221:
//   (a) the pure decision (evaluatePlanApprovalDispatch + the tag grammar +
//       the explicit unit-marker parser), table-driven, in-process;
//   (b) the hook subprocess lifecycle against a scratch project (fail-open
//       paths, the block + stderr contract, the audit row, the off-switch);
//   (c) the registration pins - every shipped harness wires the guard where
//       its dispatch surface lives, and Kiro IDE documents the prose-only
//       absence.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join, relative } from "node:path";
import {
  evaluatePlanApprovalDispatch,
  blockReason,
  promptStageMarkers,
  promptUnitMarkers,
  questionsFileApproved,
  questionsFileHasPendingPlanApproval,
  normalizeStageName,
  type UnitEvidence,
} from "../../dist/claude/.claude/hooks/aidlc-plan-approval-guard.ts";
import {
  approvalFingerprint,
  codeGenerationRecordDir,
  evaluateCodeGenerationApproval,
  PLAN_APPROVAL_CHECKPOINT,
  renderTestingContract,
  resolveCodeGenerationAuthority,
  resolveTestingPosture,
} from "../../dist/claude/.claude/tools/aidlc-testing-posture.ts";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import {
  acquireAuditLock,
  readAllAuditShards,
  releaseAuditLock,
  toPosix,
  writeActiveDirectiveMarker,
  writePlanApprovalReceipt,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { AIDLC_SRC, FIXTURE_CLONE_ID } from "../harness/fixtures.ts";

const BUN = process.execPath;
const REPO_ROOT = join(import.meta.dir, "..", "..");

// ---------------------------------------------------------------------------
// (a) The pure decision.
// ---------------------------------------------------------------------------

const CONTRACT_HASH = `sha256:${"a".repeat(64)}`;
const APPROVED: UnitEvidence = {
  unit: "todo-core",
  planExists: true,
  instructionsExist: true,
  approved: true,
  contractValid: true,
  fingerprintValid: true,
  receiptValid: true,
  contractHash: CONTRACT_HASH,
};
const PLANNED_ONLY: UnitEvidence = {
  ...APPROVED,
  approved: false,
  fingerprintValid: false,
  receiptValid: false,
};
const BARE: UnitEvidence = {
  unit: "todo-core",
  planExists: false,
  instructionsExist: false,
  approved: false,
  contractValid: false,
  fingerprintValid: false,
  receiptValid: false,
  contractHash: null,
};
const SIBLING_APPROVED: UnitEvidence = { ...APPROVED, unit: "auth" };
const STAGE_APPROVED: UnitEvidence = { ...APPROVED, unit: null };

const CTX = {
  currentStage: "code-generation",
};

describe("t265a plan-approval decision table", () => {
  test("blocks the developer dispatch when no unit has any plan", () => {
    const v = evaluatePlanApprovalDispatch(
      "Task",
      "aidlc-developer-agent",
      "AIDLC-UNIT: todo-core\nGenerate all code for todo-core",
      { ...CTX, units: [BARE] },
    );
    expect(v.block).toBe(true);
    expect(v.mentioned).toEqual(["todo-core"]);
  });

  test("blocks when the plan exists but Plan Approval is unanswered", () => {
    const v = evaluatePlanApprovalDispatch(
      "Task",
      "aidlc-developer-agent",
      "AIDLC-UNIT: todo-core\nImplement todo-core per the plan",
      { ...CTX, units: [PLANNED_ONLY] },
    );
    expect(v.block).toBe(true);
  });

  test("allows once the marked unit's plan is approved", () => {
    const v = evaluatePlanApprovalDispatch(
      "Task",
      "aidlc-developer-agent",
      `AIDLC-UNIT: todo-core\nAIDLC-TESTING-CONTRACT: ${CONTRACT_HASH}\nImplement todo-core per the approved plan`,
      { ...CTX, units: [APPROVED] },
    );
    expect(v.block).toBe(false);
  });

  test("allows a zero-unit dispatch only through the explicit stage marker", () => {
    const approved = evaluatePlanApprovalDispatch(
      "Task",
      "aidlc-developer-agent",
      `AIDLC-STAGE: code-generation\nAIDLC-TESTING-CONTRACT: ${CONTRACT_HASH}\nImplement the approved stage-level plan`,
      { ...CTX, units: [STAGE_APPROVED] },
    );
    expect(approved.block).toBe(false);
    expect(approved.mentioned).toEqual(["stage:code-generation"]);

    const missingMarker = evaluatePlanApprovalDispatch(
      "Task",
      "aidlc-developer-agent",
      `AIDLC-TESTING-CONTRACT: ${CONTRACT_HASH}\nImplement the stage-level plan`,
      { ...CTX, units: [STAGE_APPROVED] },
    );
    expect(missingMarker.block).toBe(true);
  });

  test("a prompt naming only an unapproved unit blocks even when a sibling is approved", () => {
    const v = evaluatePlanApprovalDispatch(
      "Task",
      "aidlc-developer-agent",
      "AIDLC-UNIT: todo-core\nImplement todo-core",
      { ...CTX, units: [BARE, SIBLING_APPROVED] },
    );
    expect(v.block).toBe(true);
    expect(v.mentioned).toEqual(["todo-core"]);
  });

  test("contextual sibling mentions do not change the explicit target", () => {
    const v = evaluatePlanApprovalDispatch(
      "Task",
      "aidlc-developer-agent",
      `AIDLC-UNIT: todo-core\nAIDLC-TESTING-CONTRACT: ${CONTRACT_HASH}\nImplement todo-core using the auth contract for reference`,
      { ...CTX, units: [APPROVED, { ...BARE, unit: "auth" }] },
    );
    expect(v.block).toBe(false);
    expect(v.mentioned).toEqual(["todo-core"]);
  });

  test("missing, unknown, or conflicting target markers block", () => {
    const missing = evaluatePlanApprovalDispatch(
      "Task",
      "aidlc-developer-agent",
      "Execute the approved implementation plan",
      { ...CTX, units: [SIBLING_APPROVED, BARE] },
    );
    expect(missing.block).toBe(true);
    expect(missing.mentioned).toEqual([]);

    const unknown = evaluatePlanApprovalDispatch(
      "Task",
      "aidlc-developer-agent",
      "AIDLC-UNIT: payments\nExecute the approved implementation plan",
      { ...CTX, units: [APPROVED] },
    );
    expect(unknown.block).toBe(true);
    expect(unknown.mentioned).toEqual(["payments"]);

    const conflicting = evaluatePlanApprovalDispatch(
      "Task",
      "aidlc-developer-agent",
      "AIDLC-UNIT: todo-core\nAIDLC-UNIT: auth\nExecute the plan",
      { ...CTX, units: [APPROVED, SIBLING_APPROVED] },
    );
    expect(conflicting.block).toBe(true);
    expect(conflicting.mentioned).toEqual(["todo-core", "auth"]);

    const mixedScopes = evaluatePlanApprovalDispatch(
      "Task",
      "aidlc-developer-agent",
      `AIDLC-UNIT: todo-core\nAIDLC-STAGE: code-generation\nAIDLC-TESTING-CONTRACT: ${CONTRACT_HASH}`,
      { ...CTX, units: [APPROVED, STAGE_APPROVED] },
    );
    expect(mixedScopes.block).toBe(true);
    expect(mixedScopes.mentioned).toEqual(["todo-core", "stage:code-generation"]);
  });

  test("duplicate copies of the same marker remain unambiguous", () => {
    const v = evaluatePlanApprovalDispatch(
      "Task",
      "aidlc-developer-agent",
      `AIDLC-UNIT: todo-core\nAIDLC-TESTING-CONTRACT: ${CONTRACT_HASH}\nTask copy\nAIDLC-UNIT: todo-core\nTemplate copy`,
      { ...CTX, units: [APPROVED] },
    );
    expect(v.block).toBe(false);
    expect(v.mentioned).toEqual(["todo-core"]);
  });

  test("a workflow with no known units blocks outright (the reported failure)", () => {
    const v = evaluatePlanApprovalDispatch(
      "Task",
      "aidlc-developer-agent",
      "AIDLC-UNIT: todo-core\nGenerate code",
      { ...CTX, units: [] },
    );
    expect(v.block).toBe(true);
  });

  test("missing, conflicting, or stale Testing Contract markers block", () => {
    const missing = evaluatePlanApprovalDispatch(
      "Task",
      "aidlc-developer-agent",
      "AIDLC-UNIT: todo-core",
      { ...CTX, units: [APPROVED] },
    );
    expect(missing.block).toBe(true);

    const stale = evaluatePlanApprovalDispatch(
      "Task",
      "aidlc-developer-agent",
      `AIDLC-UNIT: todo-core\nAIDLC-TESTING-CONTRACT: sha256:${"b".repeat(64)}`,
      { ...CTX, units: [APPROVED] },
    );
    expect(stale.block).toBe(true);

    const conflicting = evaluatePlanApprovalDispatch(
      "Task",
      "aidlc-developer-agent",
      `AIDLC-UNIT: todo-core\nAIDLC-TESTING-CONTRACT: ${CONTRACT_HASH}\nAIDLC-TESTING-CONTRACT: sha256:${"b".repeat(64)}`,
      { ...CTX, units: [APPROVED] },
    );
    expect(conflicting.block).toBe(true);
  });

  test("out-of-scope calls always allow: other tools, other agents, other stages", () => {
    const units = [BARE];
    expect(
      evaluatePlanApprovalDispatch("Bash", "aidlc-developer-agent", "x", { ...CTX, units }).block,
    ).toBe(false);
    expect(
      evaluatePlanApprovalDispatch("Task", "aidlc-quality-agent", "x", { ...CTX, units }).block,
    ).toBe(false);
    expect(
      evaluatePlanApprovalDispatch("Task", "aidlc-developer-agent", "x", {
        currentStage: "build-and-test",
        units,
      }).block,
    ).toBe(false);
  });

  test("display-cased Current Stage still guards (normalizeStageName)", () => {
    expect(normalizeStageName("Code Generation")).toBe("code-generation");
    const v = evaluatePlanApprovalDispatch(
      "Task",
      "aidlc-developer-agent",
      "AIDLC-UNIT: todo-core",
      {
        currentStage: "Code Generation",
        units: [BARE],
      },
    );
    expect(v.block).toBe(true);
  });

  test("unit markers are explicit, line-scoped, non-empty, and de-duplicated", () => {
    expect(promptUnitMarkers("AIDLC-UNIT: auth\nimplement the author module")).toEqual(["auth"]);
    expect(promptUnitMarkers("mention AIDLC-UNIT: auth in prose")).toEqual([]);
    expect(promptUnitMarkers("AIDLC-UNIT:\nAIDLC-UNIT: todo-core\nAIDLC-UNIT: todo-core")).toEqual([
      "todo-core",
    ]);
  });

  test("stage markers are explicit, normalized, and de-duplicated", () => {
    expect(
      promptStageMarkers(
        "AIDLC-STAGE: Code Generation\nAIDLC-STAGE: code-generation\nmention AIDLC-STAGE: other",
      ),
    ).toEqual(["code-generation"]);
  });

  test("only an explicit answer on the Plan Approval question authorizes generation", () => {
    expect(questionsFileApproved("## Plan Approval\n[Answer]:\n")).toBe(false);
    expect(questionsFileApproved("## Plan Approval\n[Answer]: ___\n")).toBe(false);
    expect(questionsFileApproved("## Plan Approval\n[Answer]: A. Approve Plan\n")).toBe(true);
    expect(questionsFileApproved("## Q1: Plan Approval\n[Answer]: A. Approve Plan\n")).toBe(true);
    expect(
      questionsFileApproved("## Question 1 - Plan Approval\n[Answer]: A. Approve Plan\n"),
    ).toBe(true);
    expect(
      questionsFileApproved(
        "## Q1\n\nPlan Approval\n\nA. Approve Plan\nB. Request Changes\n[Answer]: A. Approve Plan\n",
      ),
    ).toBe(true);
    expect(
      questionsFileApproved("## Question 1\n\n**Plan Approval**\n[Answer]: A. Approve Plan\n"),
    ).toBe(true);
    expect(
      questionsFileApproved("## Q1\n\nPlan Approval\n[Answer]: B. Request Changes\n"),
    ).toBe(false);
    expect(questionsFileApproved("## Plan Approval\n[Answer]: B. Request Changes\n")).toBe(false);
    expect(
      questionsFileApproved(
        "## Implementation Question\n[Answer]: A. Approve Plan\n## Plan Approval\n[Answer]:\n",
      ),
    ).toBe(false);
    expect(
      questionsFileApproved(
        "## Plan Approval\n[Answer]: A. Approve Plan\n## Notes\n[Answer]: B. Request Changes\n",
      ),
    ).toBe(true);
    expect(
      questionsFileApproved(
        "## Plan Approval\n[Answer]: A. Approve Plan\n## Q2\n\nPlan Approval\n[Answer]:\n",
      ),
    ).toBe(false);
    expect(
      questionsFileApproved(
        "## Q1\n\nWhich checkpoint applies?\n\nA. Plan Approval\n[Answer]: A. Approve Plan\n",
      ),
    ).toBe(false);
    expect(
      questionsFileApproved(
        "<!--\n## Plan Approval\n[Answer]: A. Approve Plan\n-->\n## Plan Approval\n[Answer]:\n",
      ),
    ).toBe(false);
    expect(
      questionsFileApproved(
        "```markdown\n## Plan Approval\n[Answer]: A. Approve Plan\n```\n",
      ),
    ).toBe(false);
    expect(
      questionsFileApproved(
        "~~~markdown\n## Q1\nPlan Approval\n[Answer]: A. Approve Plan\n~~~\n",
      ),
    ).toBe(false);
    expect(questionsFileApproved("")).toBe(false);
  });

  test("only a blank visible Plan Approval section is a pending mandatory stop", () => {
    expect(questionsFileHasPendingPlanApproval("## Plan Approval\n[Answer]:\n")).toBe(true);
    expect(questionsFileHasPendingPlanApproval("## Q1\nPlan Approval\n[Answer]: ___\n")).toBe(
      true,
    );
    expect(
      questionsFileHasPendingPlanApproval("## Clarification\nWhich edge case?\n[Answer]:\n"),
    ).toBe(false);
    expect(
      questionsFileHasPendingPlanApproval(
        "<!--\n## Plan Approval\n[Answer]:\n-->\n## Clarification\n[Answer]:\n",
      ),
    ).toBe(false);
    expect(
      questionsFileHasPendingPlanApproval("## Plan Approval\n[Answer]: A. Approve Plan\n"),
    ).toBe(false);
  });

  test("blockReason names the scope and the stage steps", () => {
    const reason = blockReason(["todo-core"]);
    expect(reason).toContain("todo-core");
    expect(reason).toContain("Steps 2-3");
    expect(reason).toContain("code-generation-plan.md");
  });
});

// ---------------------------------------------------------------------------
// (b) Hook subprocess lifecycle.
// ---------------------------------------------------------------------------

const RECORD_REL = join("aidlc", "spaces", "default", "intents");

function scratchProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "t265-"));
  mkdirSync(join(dir, ".claude", "hooks"), { recursive: true });
  mkdirSync(join(dir, ".claude", "tools"), { recursive: true });
  cpSync(
    join(AIDLC_SRC, "hooks", "aidlc-plan-approval-guard.ts"),
    join(dir, ".claude", "hooks", "aidlc-plan-approval-guard.ts"),
  );
  cpSync(
    join(AIDLC_SRC, "hooks", "aidlc-review-freeze.ts"),
    join(dir, ".claude", "hooks", "aidlc-review-freeze.ts"),
  );
  cpSync(
    join(AIDLC_SRC, "hooks", "review-freeze-command.ts"),
    join(dir, ".claude", "hooks", "review-freeze-command.ts"),
  );
  cpSync(
    join(AIDLC_SRC, "hooks", "aidlc-record-human-turn.ts"),
    join(dir, ".claude", "hooks", "aidlc-record-human-turn.ts"),
  );
  for (const t of [
    "aidlc-lib.ts",
    "aidlc-settings.ts",
    "aidlc-artifact-vocabulary.ts",
    "aidlc-runtime-paths.ts",
    "aidlc-audit.ts",
    "aidlc-log.ts",
    "aidlc-testing-posture.ts",
  ]) {
    cpSync(join(AIDLC_SRC, "tools", t), join(dir, ".claude", "tools", t));
  }
  cpSync(
    join(AIDLC_SRC, "tools", "data"),
    join(dir, ".claude", "tools", "data"),
    { recursive: true },
  );
  mkdirSync(join(dir, RECORD_REL), { recursive: true });
  for (const args of [
    ["init", "-q"],
    ["config", "user.email", "tests@example.com"],
    ["config", "user.name", "AI-DLC Tests"],
    ["add", "-A"],
    ["commit", "-qm", "baseline"],
  ]) {
    const result = spawnSync("git", args, { cwd: dir, encoding: "utf-8" });
    if (result.status !== 0) {
      throw new Error(result.stderr || `git ${args.join(" ")} failed`);
    }
  }
  return dir;
}

function seedState(proj: string, fields: { stage?: string; autonomy?: string } = {}): void {
  const stage = fields.stage ?? "code-generation";
  const autonomy = fields.autonomy
    ? `- **Construction Autonomy Mode**: ${fields.autonomy}\n`
    : "";
  writeFileSync(
    join(proj, RECORD_REL, "aidlc-state.md"),
    `# AI-DLC State Tracking

## Project Information
- **Project**: t265 fixture
- **Scope**: poc
${autonomy}
## Current Status
- **Lifecycle Phase**: CONSTRUCTION
- **Current Stage**: ${stage}
`,
    "utf-8",
  );
}

function seedActiveDirective(proj: string, stage: string, unit?: string): void {
  const statePath = join(proj, RECORD_REL, "aidlc-state.md");
  const state = readFileSync(statePath, "utf-8");
  writeActiveDirectiveMarker(proj, {
    kind: "run-stage",
    stage,
    ...(unit ? { unit } : {}),
    state_sha256: createHash("sha256").update(state, "utf-8").digest("hex"),
  });
}

function seedUnit(
  proj: string,
  unit: string | null,
  opts: {
    plan?: boolean | "empty";
    answer?: string | null;
    heading?: string;
    questionText?: string;
    mutateInstructions?: boolean;
    receipt?: boolean;
  } = {},
): void {
  const dir =
    unit === null
      ? join(proj, RECORD_REL, "construction", "code-generation")
      : join(proj, RECORD_REL, "construction", unit, "code-generation");
  mkdirSync(dir, { recursive: true });
  seedActiveDirective(proj, "code-generation", unit ?? undefined);
  const authority = resolveCodeGenerationAuthority(proj, { unit });
  let plan = "";
  let instructions = "";
  if (opts.plan) {
    const contract = resolveTestingPosture(proj);
    plan =
      opts.plan === "empty"
        ? "  \n"
        : `# Plan\n\n${renderTestingContract(contract)}\n## Steps\n\n- [ ] Step 1\n`;
    instructions = "# Unit Test Instructions\n\n## Command\n\n`bun test todo-core.test.ts`\n";
    writeFileSync(
      join(dir, "code-generation-plan.md"),
      plan,
      "utf-8",
    );
    writeFileSync(
      join(dir, "unit-test-instructions.md"),
      opts.mutateInstructions ? `${instructions}\nchanged\n` : instructions,
      "utf-8",
    );
  }
  if (opts.answer !== undefined) {
    const contract = resolveTestingPosture(proj);
    const fingerprint =
      plan.trim().length > 0 && instructions.length > 0
        ? approvalFingerprint(
            plan,
            opts.mutateInstructions ? `${instructions}\nchanged\n` : instructions,
            contract.contract_sha256,
            authority,
          )
        : `sha256:${"0".repeat(64)}`;
    writeFileSync(
      join(dir, "code-generation-questions.md"),
      `## ${opts.heading ?? "Plan Approval"}\n${
        opts.questionText === undefined ? "" : `\n${opts.questionText}\n`
      }[Approval Fingerprint]: ${fingerprint}\n[Answer]:${
        opts.answer === null ? "" : ` ${opts.answer}`
      }\n`,
      "utf-8",
    );
    if (
      opts.answer !== null &&
      /^(?:A[.)]\s*)?Approve Plan$/.test(opts.answer) &&
      opts.receipt !== false &&
      plan.trim().length > 0 &&
      instructions.length > 0
    ) {
      const questionsPath = join(dir, "code-generation-questions.md");
      const questions = readFileSync(questionsPath, "utf-8");
      writePlanApprovalReceipt(proj, {
        version: 1,
        targetId: authority.targetId,
        intentId: authority.intentId,
        directiveEpoch: authority.directiveEpoch,
        runFloor: authority.runFloor,
        fingerprint,
        questionsFile: toPosix(relative(proj, questionsPath)),
        promptSha256: createHash("sha256")
          .update(
            `${questions
              .replace(/^\[Answer\]:[ \t]*.*$/gm, "[Answer]:")
              .trimEnd()}\n`,
          )
          .digest("hex"),
        sourceFloor: authority.sourceFloor,
        markerRevision: authority.markerRevision,
        session: "fixture-session",
        challengeId: "fixture-challenge",
        choice: "Approve Plan",
        questionsSha256: createHash("sha256")
          .update(questions)
          .digest("hex"),
        certifiedSourceSha256: authority.sourceFloor,
        status: "approved",
      });
    }
  }
}

const DISPATCH = (proj: string, prompt: string) => ({
  hook_event_name: "PreToolUse",
  tool_name: "Task",
  tool_input: {
    subagent_type: "aidlc-developer-agent",
    prompt:
      `AIDLC-UNIT: todo-core\n` +
      `AIDLC-TESTING-CONTRACT: ${resolveTestingPosture(proj).contract_sha256}\n` +
      prompt,
  },
});

const STAGE_DISPATCH = (proj: string, prompt: string) => ({
  hook_event_name: "PreToolUse",
  tool_name: "Task",
  tool_input: {
    subagent_type: "aidlc-developer-agent",
    prompt:
      `AIDLC-STAGE: code-generation\n` +
      `AIDLC-TESTING-CONTRACT: ${resolveTestingPosture(proj).contract_sha256}\n` +
      prompt,
  },
});

const WRITE = (filePath: string) => ({
  hook_event_name: "PreToolUse",
  tool_name: "Write",
  tool_input: { file_path: filePath },
});

const BASH = (command: string) => ({
  hook_event_name: "PreToolUse",
  tool_name: "Bash",
  tool_input: { command },
});

function runHook(
  proj: string,
  payload: Record<string, unknown> | string,
  env: Record<string, string> = {},
): { code: number; stderr: string } {
  const r = spawnSync(BUN, [join(proj, ".claude", "hooks", "aidlc-plan-approval-guard.ts")], {
    input: typeof payload === "string" ? payload : JSON.stringify(payload),
    env: { ...process.env, CLAUDE_PROJECT_DIR: proj, ...env },
    encoding: "utf-8",
  });
  return { code: r.status ?? -1, stderr: r.stderr ?? "" };
}

describe("t265b hook lifecycle", () => {
  test("blocks the unplanned dispatch with exit 2 + a redirecting reason", () => {
    const proj = scratchProject();
    try {
      seedState(proj);
      seedUnit(proj, "todo-core", { plan: false });
      const r = runHook(proj, DISPATCH(proj, "Generate all code for todo-core"));
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("Code generation cannot start");
      expect(r.stderr).toContain("code-generation-plan.md");
    } finally {
      rmSync(proj, { recursive: true, force: true });
    }
  });

  test("still blocks when the plan exists but the tag is blank; allows once answered", () => {
    const proj = scratchProject();
    try {
      seedState(proj);
      seedUnit(proj, "todo-core", { plan: true, answer: null });
      expect(runHook(proj, DISPATCH(proj, "Implement todo-core")).code).toBe(2);
      seedUnit(proj, "todo-core", {
        plan: true,
        answer: "A. Approve Plan",
        heading: "Q1: Plan Approval",
      });
      expect(runHook(proj, DISPATCH(proj, "Implement todo-core")).code).toBe(0);
      seedUnit(proj, "todo-core", {
        plan: true,
        answer: "A. Approve Plan",
        heading: "Q1",
        questionText: "Plan Approval",
      });
      expect(runHook(proj, DISPATCH(proj, "Implement todo-core")).code).toBe(0);
    } finally {
      rmSync(proj, { recursive: true, force: true });
    }
  });

  test("zero-unit stage-level evidence resolves, fingerprints, and authorizes dispatch", () => {
    const proj = scratchProject();
    try {
      seedState(proj);
      seedActiveDirective(proj, "code-generation");
      seedUnit(proj, null, { plan: true, answer: null });
      expect(codeGenerationRecordDir(proj, null)).toBe(
        join(proj, RECORD_REL, "construction", "code-generation"),
      );
      expect(evaluateCodeGenerationApproval(proj, { unit: null }).ok).toBe(false);
      const fingerprint = spawnSync(
        BUN,
        [
          join(proj, ".claude", "tools", "aidlc-testing-posture.ts"),
          "fingerprint",
          "--stage-level",
          "--project-dir",
          proj,
        ],
        { encoding: "utf-8" },
      );
      expect(fingerprint.status).toBe(0);
      expect(fingerprint.stdout.trim()).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(runHook(proj, STAGE_DISPATCH(proj, "Implement the stage-level plan")).code).toBe(2);

      seedUnit(proj, null, { plan: true, answer: "A. Approve Plan" });
      expect(evaluateCodeGenerationApproval(proj, { unit: null }).ok).toBe(true);
      expect(runHook(proj, STAGE_DISPATCH(proj, "Implement the stage-level plan")).code).toBe(0);
    } finally {
      rmSync(proj, { recursive: true, force: true });
    }
  });

  test("zero-unit inline generation is refused before approval and allowed after approval", () => {
    const proj = scratchProject();
    try {
      seedState(proj);
      seedActiveDirective(proj, "code-generation");
      seedUnit(proj, null, { plan: true, answer: null });
      const source = join(proj, "src", "inline.ts");
      const questions = join(
        proj,
        RECORD_REL,
        "construction",
        "code-generation",
        "code-generation-questions.md",
      );

      const writeBlocked = runHook(proj, WRITE(source));
      expect(writeBlocked.code).toBe(2);
      expect(writeBlocked.stderr).toContain(
        "Code generation cannot modify workspace path",
      );
      expect(
        runHook(proj, WRITE(join(tmpdir(), "aidlc-outside-workspace.ts"))).code,
      ).toBe(2);
      expect(runHook(proj, BASH("printf code > src/inline.ts")).code).toBe(2);
      expect(
        runHook(
          proj,
          BASH(process.platform === "win32" ? "echo code > NUL" : "printf code > /dev/null"),
        ).code,
      ).toBe(2);
      expect(
        runHook(
          proj,
          BASH(`bun -e 'await Bun.write("src/opaque.ts", "generated")'`),
        ).code,
      ).toBe(2);
      expect(
        runHook(
          proj,
          BASH(`printf '%s' "$(bun -e 'await Bun.write("src/substitution.ts", "generated")')"`),
        ).code,
      ).toBe(2);
      expect(runHook(proj, BASH('OUT=src/expanded.ts; printf code > "$OUT"')).code).toBe(2);
      expect(runHook(proj, BASH("sort input.txt -o src/sorted.txt")).code).toBe(2);
      expect(runHook(proj, BASH("uniq input.txt src/unique.txt")).code).toBe(2);
      expect(runHook(proj, BASH("git diff --output=src/diff.txt")).code).toBe(2);
      expect(runHook(proj, BASH("git status --short")).code).toBe(0);
      expect(
        runHook(
          proj,
          BASH("bun .claude/tools/aidlc-testing-posture.ts render"),
        ).code,
      ).toBe(0);
      expect(
        runHook(
          proj,
          BASH(
            "bun aidlc/spaces/default/intents/tools/aidlc-fake.ts .claude/tools/aidlc-testing-posture.ts",
          ),
        ).code,
      ).toBe(2);
      expect(
        runHook(
          proj,
          BASH(
            "bun --preload evil.ts .claude/tools/aidlc-testing-posture.ts render",
          ),
        ).code,
      ).toBe(2);
      expect(
        runHook(
          proj,
          BASH(
            "bun fake.ts .claude/tools/aidlc-testing-posture.ts render",
          ),
        ).code,
      ).toBe(2);
      expect(runHook(proj, WRITE(questions)).code).toBe(0);

      seedUnit(proj, null, { plan: true, answer: "A. Approve Plan" });
      expect(runHook(proj, WRITE(source)).code).toBe(0);
      expect(runHook(proj, BASH("printf code > src/inline.ts")).code).toBe(0);
      expect(
        runHook(
          proj,
          BASH(`bun -e 'await Bun.write("src/opaque.ts", "generated")'`),
        ).code,
      ).toBe(0);
    } finally {
      rmSync(proj, { recursive: true, force: true });
    }
  }, 30000);

  test("a conductor-authored Approve Plan markdown answer has no authority receipt", () => {
    const proj = scratchProject();
    try {
      seedState(proj);
      seedUnit(proj, null, {
        plan: true,
        answer: "Approve Plan",
        receipt: false,
      });
      const approval = evaluateCodeGenerationApproval(proj, { unit: null });
      expect(approval.ok).toBe(false);
      expect(approval.approved).toBe(true);
      expect(approval.receiptValid).toBe(false);
      expect(approval.reason).toContain("protected Plan Approval receipt");
      const authority = resolveCodeGenerationAuthority(proj, { unit: null });
      const questionsPath = join(
        codeGenerationRecordDir(proj, null),
        "code-generation-questions.md",
      );
      appendAuditEntry(
        "PLAN_APPROVAL_RECORDED",
        {
          Stage: "code-generation",
          Checkpoint: PLAN_APPROVAL_CHECKPOINT,
          "Plan Target": authority.targetId,
          Intent: authority.intentId,
          "Directive Epoch": authority.directiveEpoch,
          "Run floor": authority.runFloor,
          "Approval Fingerprint": approval.approvalFingerprint ?? "",
          "Questions File": toPosix(relative(proj, questionsPath)),
          "Questions SHA-256": createHash("sha256")
            .update(readFileSync(questionsPath, "utf-8"))
            .digest("hex"),
          "Prompt SHA-256": "forged",
          Session: "forged-session",
          Details: "Approve Plan",
        },
        proj,
      );
      expect(evaluateCodeGenerationApproval(proj, { unit: null }).ok).toBe(false);
      expect(runHook(proj, STAGE_DISPATCH(proj, "Implement")).code).toBe(2);
      expect(runHook(proj, WRITE(join(proj, "src", "self-authored.ts"))).code).toBe(2);
    } finally {
      rmSync(proj, { recursive: true, force: true });
    }
  });

  test("aidlc-log emits Plan Approval authority only after its prompt and a later human turn", () => {
    const proj = scratchProject();
    try {
      seedState(proj);
      seedUnit(proj, null, { plan: true, answer: null });
      const questionsPath = join(
        codeGenerationRecordDir(proj, null),
        "code-generation-questions.md",
      );
      const logTool = join(proj, ".claude", "tools", "aidlc-log.ts");
      const runLog = (args: string[]) => {
        const env: NodeJS.ProcessEnv = {
          ...process.env,
          CLAUDE_PROJECT_DIR: proj,
        };
        delete env.AIDLC_SKIP_HUMAN_PRESENCE_GUARD;
        return spawnSync(BUN, [logTool, ...args], {
          env,
          encoding: "utf-8",
        });
      };
      const identity = [
        "--stage",
        "code-generation",
        "--checkpoint",
        "plan-approval",
        "--questions-file",
        questionsPath,
        "--session",
        "plan-session",
        "--stage-level",
      ];
      appendAuditEntry(
        "SESSION_STARTED",
        { Source: "startup", Session: "plan-session" },
        proj,
      );
      appendAuditEntry(
        "SESSION_STARTED",
        { Source: "startup", Session: "newer-session" },
        proj,
      );
      expect(
        runLog([
          "decision",
          ...identity,
          "--decision",
          "Approve this plan?",
          "--options",
          "Approve Plan,Request Changes",
        ]).status,
      ).toBe(0);

      writeFileSync(
        questionsPath,
        readFileSync(questionsPath, "utf-8").replace(
          /\[Answer\]:\s*$/,
          "[Answer]: Approve Plan",
        ),
      );
      expect(
        runLog([
          "answer",
          ...identity,
          "--details",
          "Approve Plan",
        ]).status,
      ).toBe(1);

      const newerSessionAnswer = spawnSync(
        BUN,
        [join(proj, ".claude", "hooks", "aidlc-record-human-turn.ts")],
        {
          input: JSON.stringify({
            hook_event_name: "UserPromptSubmit",
            session_id: "newer-session",
            prompt: "Approve Plan",
          }),
          env: { ...process.env, CLAUDE_PROJECT_DIR: proj },
          encoding: "utf-8",
        },
      );
      expect(newerSessionAnswer.status).toBe(0);
      expect(
        runLog([
          "answer",
          ...identity,
          "--details",
          "Approve Plan",
        ]).status,
      ).toBe(1);

      const unrelated = spawnSync(
        BUN,
        [join(proj, ".claude", "hooks", "aidlc-record-human-turn.ts")],
        {
          input: JSON.stringify({
            hook_event_name: "UserPromptSubmit",
            session_id: "plan-session",
            prompt: "Can you explain the testing strategy?",
          }),
          env: { ...process.env, CLAUDE_PROJECT_DIR: proj },
          encoding: "utf-8",
        },
      );
      expect(unrelated.status).toBe(0);
      expect(
        runLog([
          "answer",
          ...identity,
          "--details",
          "Approve Plan",
        ]).status,
      ).toBe(1);

      const approvedQuestions = readFileSync(questionsPath, "utf-8");
      writeFileSync(
        questionsPath,
        approvedQuestions.replace(
          "## Plan Approval",
          "## Plan Approval\n\nChanged after presentation.",
        ),
      );

      const human = spawnSync(
        BUN,
        [join(proj, ".claude", "hooks", "aidlc-record-human-turn.ts")],
        {
          input: JSON.stringify({
            hook_event_name: "UserPromptSubmit",
            session_id: "plan-session",
            prompt: "Approve Plan",
          }),
          env: { ...process.env, CLAUDE_PROJECT_DIR: proj },
          encoding: "utf-8",
        },
      );
      expect(human.status).toBe(0);
      expect(
        runLog([
          "answer",
          ...identity,
          "--details",
          "Approve Plan",
        ]).status,
      ).toBe(1);
      writeFileSync(questionsPath, approvedQuestions);
      const approved = runLog([
        "answer",
        ...identity,
        "--details",
        "Approve Plan",
      ]);
      expect(
        approved.status,
        `${approved.stdout}\n${approved.stderr}\n${readAllAuditShards(proj)}`,
      ).toBe(0);
      expect(approved.stdout).toContain("PLAN_APPROVAL_RECORDED");
      expect(evaluateCodeGenerationApproval(proj, { unit: null }).ok).toBe(true);
    } finally {
      rmSync(proj, { recursive: true, force: true });
    }
  });

  test("Plan Approval rechecks the source floor after acquiring the audit lock", async () => {
    const proj = scratchProject();
    try {
      mkdirSync(join(proj, "src"), { recursive: true });
      const source = join(proj, "src", "atomic.ts");
      writeFileSync(source, "export const atomic = 1;\n", "utf-8");
      seedState(proj);
      seedUnit(proj, null, { plan: true, answer: null });
      const questionsPath = join(
        codeGenerationRecordDir(proj, null),
        "code-generation-questions.md",
      );
      const logTool = join(proj, ".claude", "tools", "aidlc-log.ts");
      const identity = [
        "--stage",
        "code-generation",
        "--checkpoint",
        "plan-approval",
        "--questions-file",
        questionsPath,
        "--session",
        "atomic-session",
        "--stage-level",
      ];
      appendAuditEntry(
        "SESSION_STARTED",
        { Source: "startup", Session: "atomic-session" },
        proj,
      );
      const decision = spawnSync(
        BUN,
        [
          logTool,
          "decision",
          ...identity,
          "--decision",
          "Approve this plan?",
          "--options",
          "Approve Plan,Request Changes",
        ],
        {
          env: { ...process.env, CLAUDE_PROJECT_DIR: proj },
          encoding: "utf-8",
        },
      );
      expect(decision.status, decision.stderr).toBe(0);
      appendAuditEntry("HUMAN_TURN", { Session: "atomic-session" }, proj);
      writeFileSync(
        questionsPath,
        readFileSync(questionsPath, "utf-8").replace(
          /\[Answer\]:\s*$/,
          "[Answer]: Approve Plan",
        ),
      );

      expect(acquireAuditLock(proj, 0, 0)).toBe(true);
      let answerExited: Promise<number> | null = null;
      let answerStderr: Promise<string> | null = null;
      try {
        const env: Record<string, string | undefined> = {
          ...process.env,
          CLAUDE_PROJECT_DIR: proj,
        };
        delete env.AIDLC_SKIP_HUMAN_PRESENCE_GUARD;
        const answer = Bun.spawn(
          [
            BUN,
            logTool,
            "answer",
            ...identity,
            "--details",
            "Approve Plan",
          ],
          {
            env,
            stdout: "pipe",
            stderr: "pipe",
          },
        );
        answerExited = answer.exited;
        answerStderr = new Response(answer.stderr).text();
        await Bun.sleep(250);
        writeFileSync(source, "export const atomic = 2;\n", "utf-8");
      } finally {
        releaseAuditLock(proj);
      }
      expect(answerExited).not.toBeNull();
      expect(answerStderr).not.toBeNull();
      const [exitCode, stderr] = await Promise.all([
        answerExited!,
        answerStderr!,
      ]);
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain("pre-planning source floor");
      expect(evaluateCodeGenerationApproval(proj, { unit: null }).ok).toBe(false);
    } finally {
      releaseAuditLock(proj);
      rmSync(proj, { recursive: true, force: true });
    }
  }, 15000);

  test("missing and legacy directive markers fail closed instead of selecting stage-level authority", () => {
    const proj = scratchProject();
    try {
      seedState(proj);
      const source = join(proj, "src", "ambiguous.ts");
      expect(runHook(proj, WRITE(source)).code).toBe(2);
      expect(runHook(proj, STAGE_DISPATCH(proj, "Implement")).code).toBe(2);

      const state = readFileSync(join(proj, RECORD_REL, "aidlc-state.md"), "utf-8");
      writeFileSync(
        join(proj, RECORD_REL, ".aidlc-active-directive.json"),
        `${JSON.stringify({
          version: 1,
          stage: "code-generation",
          state_sha256: createHash("sha256").update(state).digest("hex"),
        })}\n`,
      );
      expect(runHook(proj, WRITE(source)).code).toBe(2);
    } finally {
      rmSync(proj, { recursive: true, force: true });
    }
  });

  test("record-directory symlink and junction aliases cannot exempt workspace writes", () => {
    const proj = scratchProject();
    try {
      seedState(proj);
      seedUnit(proj, null, { plan: true, answer: null });
      const record = codeGenerationRecordDir(proj, null);
      const workspaceSrc = join(proj, "src");
      mkdirSync(workspaceSrc, { recursive: true });
      const alias = join(record, "workspace-alias");
      symlinkSync(
        workspaceSrc,
        alias,
        process.platform === "win32" ? "junction" : "dir",
      );
      expect(runHook(proj, WRITE(join(alias, "bypass.ts"))).code).toBe(2);

      const workspaceFile = join(workspaceSrc, "existing.ts");
      const fileAlias = join(record, "workspace-file-alias.ts");
      writeFileSync(workspaceFile, "export const existing = true;\n");
      symlinkSync(workspaceFile, fileAlias, "file");
      expect(runHook(proj, WRITE(fileAlias)).code).toBe(2);
    } finally {
      rmSync(proj, { recursive: true, force: true });
    }
  });

  test("a symlinked workspace root preserves trusted planning paths without trusting child symlinks", () => {
    const proj = scratchProject();
    const alias = `${proj}-alias`;
    try {
      seedState(proj);
      seedUnit(proj, null, { plan: true, answer: null });
      symlinkSync(
        proj,
        alias,
        process.platform === "win32" ? "junction" : "dir",
      );

      expect(
        runHook(
          alias,
          BASH("bun .claude/tools/aidlc-testing-posture.ts render"),
        ).code,
      ).toBe(0);
      expect(
        runHook(
          alias,
          WRITE(
            join(
              codeGenerationRecordDir(alias, null),
              "code-generation-questions.md",
            ),
          ),
        ).code,
      ).toBe(0);
      expect(runHook(alias, WRITE(join(alias, "src", "blocked.ts"))).code).toBe(2);

      const record = codeGenerationRecordDir(proj, null);
      const workspaceSrc = join(proj, "src");
      mkdirSync(workspaceSrc, { recursive: true });
      const childAlias = join(record, "workspace-alias");
      symlinkSync(
        workspaceSrc,
        childAlias,
        process.platform === "win32" ? "junction" : "dir",
      );
      expect(
        runHook(
          alias,
          WRITE(
            join(
              codeGenerationRecordDir(alias, null),
              "workspace-alias",
              "blocked.ts",
            ),
          ),
        ).code,
      ).toBe(2);
    } finally {
      rmSync(alias, { recursive: true, force: true });
      rmSync(proj, { recursive: true, force: true });
    }
  });

  test("unit-bound inline generation consumes the active unit's existing approval", () => {
    const proj = scratchProject();
    try {
      seedState(proj);
      seedActiveDirective(proj, "code-generation", "todo-core");
      seedUnit(proj, "todo-core", { plan: true, answer: null });
      const source = join(proj, "src", "todo.ts");
      expect(runHook(proj, WRITE(source)).code).toBe(2);

      seedUnit(proj, "todo-core", { plan: true, answer: "A. Approve Plan" });
      expect(runHook(proj, WRITE(source)).code).toBe(0);
      expect(runHook(proj, DISPATCH(proj, "Implement todo-core")).code).toBe(0);
    } finally {
      rmSync(proj, { recursive: true, force: true });
    }
  });

  test("approved bytes cannot replay across targets or a reissued directive", () => {
    const proj = scratchProject();
    try {
      seedState(proj);
      seedUnit(proj, "todo-core", { plan: true, answer: "Approve Plan" });
      expect(evaluateCodeGenerationApproval(proj, { unit: "todo-core" }).ok).toBe(true);

      const sourceDir = codeGenerationRecordDir(proj, "todo-core");
      const replayDir = codeGenerationRecordDir(proj, "auth");
      cpSync(sourceDir, replayDir, { recursive: true });
      seedActiveDirective(proj, "code-generation", "auth");
      const crossTarget = evaluateCodeGenerationApproval(proj, { unit: "auth" });
      expect(crossTarget.ok).toBe(false);
      expect(crossTarget.fingerprintValid).toBe(false);

      seedActiveDirective(proj, "code-generation", "todo-core");
      const reissued = evaluateCodeGenerationApproval(proj, { unit: "todo-core" });
      expect(reissued.ok).toBe(false);
      expect(reissued.fingerprintValid).toBe(false);
    } finally {
      rmSync(proj, { recursive: true, force: true });
    }
  });

  test("fingerprint CLI requires an explicit target that matches the directive", () => {
    const proj = scratchProject();
    try {
      seedState(proj);
      seedUnit(proj, "todo-core", { plan: true, answer: null });
      const tool = join(proj, ".claude", "tools", "aidlc-testing-posture.ts");
      const run = (args: string[]) =>
        spawnSync(BUN, [tool, "fingerprint", "--project-dir", proj, ...args], {
          encoding: "utf-8",
        });
      expect(run([]).status).toBe(1);
      expect(run(["--unit", ""]).status).toBe(1);
      expect(run(["--stage-level"]).status).toBe(1);
      expect(run(["--unit", "auth"]).status).toBe(1);
      expect(run(["--unit", "todo-core"]).status).toBe(0);
    } finally {
      rmSync(proj, { recursive: true, force: true });
    }
  });

  test("an empty plan file remains blocked even with an explicit approval answer", () => {
    const proj = scratchProject();
    try {
      seedState(proj);
      seedUnit(proj, "todo-core", { plan: "empty", answer: "A. Approve Plan" });
      expect(runHook(proj, DISPATCH(proj, "Implement todo-core")).code).toBe(2);
    } finally {
      rmSync(proj, { recursive: true, force: true });
    }
  });

  test("a post-approval plan or instruction change invalidates the fingerprint", () => {
    const proj = scratchProject();
    try {
      seedState(proj);
      seedUnit(proj, "todo-core", {
        plan: true,
        answer: "A. Approve Plan",
      });
      expect(runHook(proj, DISPATCH(proj, "Implement todo-core")).code).toBe(0);
      const instructions = join(
        proj,
        RECORD_REL,
        "construction",
        "todo-core",
        "code-generation",
        "unit-test-instructions.md",
      );
      writeFileSync(
        instructions,
        `${readFileSync(instructions, "utf-8")}\nChanged after approval.\n`,
      );
      expect(runHook(proj, DISPATCH(proj, "Implement todo-core")).code).toBe(2);
    } finally {
      rmSync(proj, { recursive: true, force: true });
    }
  });

  test("autonomous Construction still requires the mandatory per-unit approval", () => {
    const proj = scratchProject();
    try {
      seedState(proj, { autonomy: "autonomous" });
      seedUnit(proj, "todo-core", { plan: false });
      expect(runHook(proj, DISPATCH(proj, "Implement todo-core")).code).toBe(2);
      seedUnit(proj, "todo-core", { plan: true, answer: "A. Approve Plan" });
      expect(runHook(proj, DISPATCH(proj, "Implement todo-core")).code).toBe(0);
    } finally {
      rmSync(proj, { recursive: true, force: true });
    }
  });

  test("an interleaved code-generation directive stays guarded while Current Stage remains earlier", () => {
    const proj = scratchProject();
    try {
      seedState(proj, { stage: "functional-design", autonomy: "autonomous" });
      seedActiveDirective(proj, "code-generation", "todo-core");
      seedUnit(proj, "todo-core", { plan: false });
      expect(runHook(proj, DISPATCH(proj, "Implement todo-core")).code).toBe(2);
      seedUnit(proj, "todo-core", { plan: true, answer: "A. Approve Plan" });
      expect(runHook(proj, DISPATCH(proj, "Implement todo-core")).code).toBe(0);
    } finally {
      rmSync(proj, { recursive: true, force: true });
    }
  });

  test("fail-open outside identified generation paths; missing authority fails closed", () => {
    const proj = scratchProject();
    try {
      // No state file at all.
      expect(runHook(proj, DISPATCH(proj, "x")).code).toBe(0);
      seedState(proj, { stage: "build-and-test" });
      expect(runHook(proj, DISPATCH(proj, "todo-core")).code).toBe(2);
      seedState(proj);
      // Other agent / other tool.
      expect(
        runHook(proj, {
          hook_event_name: "PreToolUse",
          tool_name: "Task",
          tool_input: { subagent_type: "aidlc-quality-agent", prompt: "todo-core" },
        }).code,
      ).toBe(0);
      expect(runHook(proj, BASH("echo todo-core")).code).toBe(0);
      // Garbage stdin.
      expect(runHook(proj, "not json{{").code).toBe(0);
      // Off-switch on an otherwise-blocking call.
      seedState(proj);
      expect(
        runHook(proj, DISPATCH(proj, "todo-core"), { AIDLC_DISABLE_PLAN_APPROVAL_GUARD: "1" }).code,
      ).toBe(0);
    } finally {
      rmSync(proj, { recursive: true, force: true });
    }
  });

  test("a block appends a PLAN_APPROVAL_BLOCKED audit row when a shard exists", () => {
    const proj = scratchProject();
    try {
      seedState(proj);
      seedUnit(proj, "todo-core", { plan: false });
      // Seed the per-clone shard AT the path the hook's auditFilePath resolves
      // (audit/<host>-<clone>.md) - the hook gates its emit on that exact file
      // existing. Pin the clone-id (t221's idiom) so the seeded shard and the
      // hook's resolved shard agree.
      writeFileSync(join(proj, "aidlc", ".aidlc-clone-id"), `${FIXTURE_CLONE_ID}\n`, "utf-8");
      const auditDir = join(proj, RECORD_REL, "audit");
      mkdirSync(auditDir, { recursive: true });
      const host =
        hostname()
          .toLowerCase()
          .replace(/[^a-z0-9-]+/g, "-")
          .replace(/^-+|-+$/g, "")
          .slice(0, 48) || "host";
      const shardPath = join(auditDir, `${host}-${FIXTURE_CLONE_ID}.md`);
      writeFileSync(shardPath, "# AI-DLC Audit Log\n", "utf-8");
      const r = runHook(proj, DISPATCH(proj, "Generate code for todo-core"));
      expect(r.code).toBe(2);
      const shard = readFileSync(shardPath, "utf-8");
      expect(shard).toContain("PLAN_APPROVAL_BLOCKED");
      expect(shard).toContain("todo-core");
    } finally {
      rmSync(proj, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// (c) Registration pins.
// ---------------------------------------------------------------------------

describe("t265c registrations", () => {
  test("Plan Approval source validation and receipt emission share one audit lock", () => {
    const source = readFileSync(
      join(REPO_ROOT, "core", "tools", "aidlc-log.ts"),
      "utf-8",
    );
    const lock = source.indexOf("withAuditLock(pd, () => {");
    const validation = source.indexOf(
      "planEvidence = codeGenerationPlanApprovalQuestionEvidence(",
      lock,
    );
    const emission = source.indexOf(
      'emitAudit(pd, "PLAN_APPROVAL_RECORDED", fields)',
      validation,
    );
    expect(lock).toBeGreaterThan(-1);
    expect(validation).toBeGreaterThan(lock);
    expect(emission).toBeGreaterThan(validation);
  });

  test("code-generation stage requires the explicit dispatch unit marker", () => {
    const stage = readFileSync(
      join(
        REPO_ROOT,
        "dist",
        "claude",
        ".claude",
        "aidlc-common",
        "stages",
        "construction",
        "code-generation.md",
      ),
      "utf-8",
    );
    expect(stage).toContain("AIDLC-UNIT: <directive.unit>");
    expect(stage).toContain("AIDLC-TESTING-CONTRACT: <contract_sha256>");
  });

  test("claude: settings.json wires the guard on the Task matcher", () => {
    const settings = JSON.parse(
      readFileSync(join(REPO_ROOT, "dist", "claude", ".claude", "settings.json"), "utf-8"),
    ) as { hooks: { PreToolUse: Array<{ matcher: string; hooks: Array<{ command: string }> }> } };
    const taskGroup = settings.hooks.PreToolUse.find((g) =>
      g.hooks.some((h) => h.command.includes("hook plan-approval-guard"))
    );
    expect(taskGroup).toBeDefined();
    expect(
      taskGroup?.hooks.some((h) => h.command.includes("hook plan-approval-guard")),
    ).toBe(true);
    for (const mutationTool of ["Edit", "Write", "Bash"]) {
      expect(taskGroup?.matcher.split("|")).toContain(mutationTool);
    }
  });

  test("codex: hooks.json wires the plan-approval-guard adapter target", () => {
    const hooksJson = readFileSync(join(REPO_ROOT, "dist", "codex", ".codex", "hooks.json"), "utf-8");
    expect(hooksJson).toContain("adapter codex plan-approval-guard");
  });

  test("copilot: the shared tool guard invokes the plan-approval guard", () => {
    const adapter = readFileSync(
      join(REPO_ROOT, "harness", "copilot", "hooks", "aidlc-copilot-adapter.ts"),
      "utf-8",
    );
    expect(adapter).toContain('"aidlc-plan-approval-guard.ts"');
    expect(adapter).toContain('tool_name: "Agent"');
  });

  test("kiro: the conductor agent registers the guard on the subagent matcher", () => {
    const agent = readFileSync(
      join(REPO_ROOT, "dist", "kiro", ".kiro", "agents", "aidlc.json"),
      "utf-8",
    );
    expect(agent).toContain("plan-approval-guard");
    const parsed = JSON.parse(agent) as {
      hooks: { preToolUse: Array<{ matcher?: string; command: string }> };
    };
    const entries = parsed.hooks.preToolUse.filter((h) =>
      h.command.includes("plan-approval-guard")
    );
    expect(entries.map((entry) => entry.matcher).sort()).toEqual(
      ["execute_bash", "fs_write", "subagent"],
    );
  });

  test("opencode: the plugin consults the guard on task dispatches", () => {
    const plugin = readFileSync(
      join(REPO_ROOT, "dist", "opencode", ".opencode", "plugin", "aidlc-opencode-adapter.ts"),
      "utf-8",
    );
    expect(plugin).toContain("aidlc-plan-approval-guard.ts");
    expect(plugin).toContain("approved plan before workspace mutation");
  });

  test("cursor: the adapter runs the guard before recording a Task spawn", () => {
    const adapter = readFileSync(
      join(REPO_ROOT, "harness", "cursor", "hooks", "aidlc-cursor-adapter.ts"),
      "utf-8",
    );
    const guard = adapter.indexOf('blockedByGuard("aidlc-plan-approval-guard.ts"');
    const ledger = adapter.indexOf("recordSpawn(sub)", guard);
    expect(guard).toBeGreaterThan(-1);
    expect(ledger).toBeGreaterThan(guard);
    expect(adapter).toContain('const planToolName = toolName === "Delete" ? "Write" : toolName');
  });

  test("kiro-ide: populated PreToolUse payloads route through the plan guard", () => {
    const ideHooks = join(REPO_ROOT, "harness", "kiro-ide", "hooks");
    expect(existsSync(join(ideHooks, "aidlc-plan-approval-guard.kiro.hook"))).toBe(true);
    expect(existsSync(join(ideHooks, "aidlc-plan-approval-guard.json"))).toBe(true);
    const skill = readFileSync(
      join(REPO_ROOT, "harness", "kiro-ide", "skills", "aidlc", "SKILL.md"),
      "utf-8",
    );
    expect(skill).not.toContain("plan-approval guard is likewise prose-only");
  });

  test("the documented off-switch is scoped to the dispatch hook", () => {
    const docs = readFileSync(
      join(REPO_ROOT, "docs", "reference", "06-hooks-and-tools.md"),
      "utf-8",
    );
    expect(docs).toContain(
      "disables this PreToolUse hook only",
    );
    expect(docs).toContain(
      "does **not** disable the autonomous `aidlc-swarm.ts prepare` precondition",
    );
  });
});
