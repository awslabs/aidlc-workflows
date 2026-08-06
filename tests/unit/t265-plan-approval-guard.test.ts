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
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import {
  evaluatePlanApprovalDispatch,
  blockReason,
  promptUnitMarkers,
  questionsFileApproved,
  questionsFileHasPendingPlanApproval,
  normalizeStageName,
  type UnitEvidence,
} from "../../dist/claude/.claude/hooks/aidlc-plan-approval-guard.ts";
import { AIDLC_SRC, FIXTURE_CLONE_ID } from "../harness/fixtures.ts";

const BUN = process.execPath;
const REPO_ROOT = join(import.meta.dir, "..", "..");

// ---------------------------------------------------------------------------
// (a) The pure decision.
// ---------------------------------------------------------------------------

const APPROVED: UnitEvidence = { unit: "todo-core", planExists: true, approved: true };
const PLANNED_ONLY: UnitEvidence = { unit: "todo-core", planExists: true, approved: false };
const BARE: UnitEvidence = { unit: "todo-core", planExists: false, approved: false };
const SIBLING_APPROVED: UnitEvidence = { unit: "auth", planExists: true, approved: true };

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
      "AIDLC-UNIT: todo-core\nImplement todo-core per the approved plan",
      { ...CTX, units: [APPROVED] },
    );
    expect(v.block).toBe(false);
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
      "AIDLC-UNIT: todo-core\nImplement todo-core using the auth contract for reference",
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
  });

  test("duplicate copies of the same marker remain unambiguous", () => {
    const v = evaluatePlanApprovalDispatch(
      "Task",
      "aidlc-developer-agent",
      "AIDLC-UNIT: todo-core\nTask copy\nAIDLC-UNIT: todo-core\nTemplate copy",
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
  for (const t of ["aidlc-lib.ts", "aidlc-runtime-paths.ts", "aidlc-audit.ts"]) {
    cpSync(join(AIDLC_SRC, "tools", t), join(dir, ".claude", "tools", t));
  }
  mkdirSync(join(dir, RECORD_REL), { recursive: true });
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
  writeFileSync(
    join(proj, RECORD_REL, ".aidlc-active-directive.json"),
    `${JSON.stringify({
      version: 1,
      stage,
      ...(unit ? { unit } : {}),
      state_sha256: createHash("sha256").update(state, "utf-8").digest("hex"),
    })}\n`,
  );
}

function seedUnit(
  proj: string,
  unit: string,
  opts: {
    plan?: boolean | "empty";
    answer?: string | null;
    heading?: string;
    questionText?: string;
  } = {},
): void {
  const dir = join(proj, RECORD_REL, "construction", unit, "code-generation");
  mkdirSync(dir, { recursive: true });
  if (opts.plan) {
    writeFileSync(
      join(dir, "code-generation-plan.md"),
      opts.plan === "empty" ? "  \n" : "# Plan\n- [ ] Step 1\n",
      "utf-8",
    );
  }
  if (opts.answer !== undefined) {
    writeFileSync(
      join(dir, "code-generation-questions.md"),
      `## ${opts.heading ?? "Plan Approval"}\n${
        opts.questionText === undefined ? "" : `\n${opts.questionText}\n`
      }[Answer]:${
        opts.answer === null ? "" : ` ${opts.answer}`
      }\n`,
      "utf-8",
    );
  }
}

const DISPATCH = (prompt: string) => ({
  hook_event_name: "PreToolUse",
  tool_name: "Task",
  tool_input: {
    subagent_type: "aidlc-developer-agent",
    prompt: `AIDLC-UNIT: todo-core\n${prompt}`,
  },
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
      const r = runHook(proj, DISPATCH("Generate all code for todo-core"));
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("plan-approval guard");
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
      expect(runHook(proj, DISPATCH("Implement todo-core")).code).toBe(2);
      seedUnit(proj, "todo-core", {
        plan: true,
        answer: "A. Approve Plan",
        heading: "Q1: Plan Approval",
      });
      expect(runHook(proj, DISPATCH("Implement todo-core")).code).toBe(0);
      seedUnit(proj, "todo-core", {
        plan: true,
        answer: "A. Approve Plan",
        heading: "Q1",
        questionText: "Plan Approval",
      });
      expect(runHook(proj, DISPATCH("Implement todo-core")).code).toBe(0);
    } finally {
      rmSync(proj, { recursive: true, force: true });
    }
  });

  test("an empty plan file remains blocked even with an explicit approval answer", () => {
    const proj = scratchProject();
    try {
      seedState(proj);
      seedUnit(proj, "todo-core", { plan: "empty", answer: "A. Approve Plan" });
      expect(runHook(proj, DISPATCH("Implement todo-core")).code).toBe(2);
    } finally {
      rmSync(proj, { recursive: true, force: true });
    }
  });

  test("autonomous Construction still requires the mandatory per-unit approval", () => {
    const proj = scratchProject();
    try {
      seedState(proj, { autonomy: "autonomous" });
      seedUnit(proj, "todo-core", { plan: false });
      expect(runHook(proj, DISPATCH("Implement todo-core")).code).toBe(2);
      seedUnit(proj, "todo-core", { plan: true, answer: "A. Approve Plan" });
      expect(runHook(proj, DISPATCH("Implement todo-core")).code).toBe(0);
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
      expect(runHook(proj, DISPATCH("Implement todo-core")).code).toBe(2);
      seedUnit(proj, "todo-core", { plan: true, answer: "A. Approve Plan" });
      expect(runHook(proj, DISPATCH("Implement todo-core")).code).toBe(0);
    } finally {
      rmSync(proj, { recursive: true, force: true });
    }
  });

  test("fail-open: other stages, other agents, other tools, no state, garbage stdin, off-switch", () => {
    const proj = scratchProject();
    try {
      // No state file at all.
      expect(runHook(proj, DISPATCH("x")).code).toBe(0);
      seedState(proj, { stage: "build-and-test" });
      seedUnit(proj, "todo-core", { plan: false });
      expect(runHook(proj, DISPATCH("todo-core")).code).toBe(0);
      seedState(proj);
      // Other agent / other tool.
      expect(
        runHook(proj, {
          hook_event_name: "PreToolUse",
          tool_name: "Task",
          tool_input: { subagent_type: "aidlc-quality-agent", prompt: "todo-core" },
        }).code,
      ).toBe(0);
      expect(
        runHook(proj, {
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_input: { command: "echo todo-core" },
        }).code,
      ).toBe(0);
      // Garbage stdin.
      expect(runHook(proj, "not json{{").code).toBe(0);
      // Off-switch on an otherwise-blocking call.
      seedState(proj);
      expect(
        runHook(proj, DISPATCH("todo-core"), { AIDLC_DISABLE_PLAN_APPROVAL_GUARD: "1" }).code,
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
      const r = runHook(proj, DISPATCH("Generate code for todo-core"));
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
  });

  test("claude: settings.json wires the guard on the Task matcher", () => {
    const settings = JSON.parse(
      readFileSync(join(REPO_ROOT, "dist", "claude", ".claude", "settings.json"), "utf-8"),
    ) as { hooks: { PreToolUse: Array<{ matcher: string; hooks: Array<{ command: string }> }> } };
    const taskGroup = settings.hooks.PreToolUse.find((g) => g.matcher === "Task");
    expect(taskGroup).toBeDefined();
    expect(
      taskGroup?.hooks.some((h) => h.command.includes("aidlc-plan-approval-guard.ts")),
    ).toBe(true);
  });

  test("codex: hooks.json wires the plan-approval-guard adapter target", () => {
    const hooksJson = readFileSync(join(REPO_ROOT, "dist", "codex", ".codex", "hooks.json"), "utf-8");
    expect(hooksJson).toContain("aidlc-codex-adapter.ts plan-approval-guard");
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
    const entry = parsed.hooks.preToolUse.find((h) => h.command.includes("plan-approval-guard"));
    expect(entry?.matcher).toBe("subagent");
  });

  test("opencode: the plugin consults the guard on task dispatches", () => {
    const plugin = readFileSync(
      join(REPO_ROOT, "dist", "opencode", ".opencode", "plugin", "aidlc-opencode-adapter.ts"),
      "utf-8",
    );
    expect(plugin).toContain("aidlc-plan-approval-guard.ts");
  });

  test("kiro-ide: no registration ships; the SKILL documents the prose-only bound", () => {
    const ideHooks = join(REPO_ROOT, "harness", "kiro-ide", "hooks");
    expect(existsSync(join(ideHooks, "aidlc-plan-approval-guard.kiro.hook"))).toBe(false);
    expect(existsSync(join(ideHooks, "aidlc-plan-approval-guard.json"))).toBe(false);
    const skill = readFileSync(
      join(REPO_ROOT, "harness", "kiro-ide", "skills", "aidlc", "SKILL.md"),
      "utf-8",
    );
    expect(skill).toContain("plan-approval guard is likewise prose-only");
  });
});
