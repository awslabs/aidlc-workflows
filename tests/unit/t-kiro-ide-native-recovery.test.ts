// covers: subcommand:aidlc-orchestrate:next
// The installed native dispatcher must keep the remedy reachable when the
// durable stage has advanced but the preceding directive has not.
import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";
import { afterAll, beforeAll, describe, expect, test, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  auditShardName,
  readAuditShardEvents,
  readPlanApprovalLegacyWindows,
  stateDigest,
  writeActiveDirectiveMarker,
} from "../../core/tools/aidlc-lib.ts";
import {
  renderTestingContract,
  resolveTestingPosture,
} from "../../core/tools/aidlc-testing-posture.ts";
import {
  DEFAULT_RECORD_DIR,
  DEFAULT_SPACE,
  intentsDirOf,
  REPO_ROOT,
  seededRecordDir,
  seededStateFile,
} from "../harness/fixtures.ts";
import { testGuardEnvironment } from "../harness/runner-profile.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const scratchRoot = process.env.AIDLC_NATIVE_RECOVERY_SCRATCH ??
  (process.platform === "win32"
    ? join(process.env.SystemRoot || "C:\\Windows", "Temp")
    : tmpdir());
const runtimeRoot = process.env.AIDLC_NATIVE_RECOVERY_RUNTIME ??
  join(REPO_ROOT, "dist-release");
let binary = process.env.AIDLC_NATIVE_RECOVERY_BINARY ?? "";
let scratch: string;

beforeAll(() => {
  mkdirSync(scratchRoot, { recursive: true });
  // Keep nested intent/lock paths below Windows tool path limits even when
  // the source checkout or inherited TEMP directory is deeply nested.
  scratch = mkdtempSync(join(scratchRoot, "aidlc-nr-"));
  if (binary) return;
  binary = join(scratch, process.platform === "win32" ? "aidlc.exe" : "aidlc");
  const result = spawnSync(process.execPath, [
    "build", join(runtimeRoot, "claude", ".claude", "tools", "aidlc.ts"),
    "--compile", "--outfile", binary,
  ], { encoding: "utf-8", timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS) });
  expect(result.status, result.stdout + result.stderr).toBe(0);
}, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

afterAll(() => {
  if (scratch && !process.env.AIDLC_NATIVE_RECOVERY_KEEP) {
    rmSync(scratch, { recursive: true, force: true });
  }
});

// Every policy publishes authority and requires initial Plan Approval.
// Lowered fences permit changed content only after that approval.
function fixture(policy: "relaxed" | "strict" | "off" = "relaxed"): string {
  const project = mkdtempSync(join(scratch, "project-"));
  cpSync(join(runtimeRoot, "kiro-ide", ".kiro"), join(project, ".kiro"), {
    recursive: true,
  });
  cpSync(
    join(runtimeRoot, "kiro-ide", ".kiro", "tools", "data", "memory-seed"),
    join(project, "aidlc", "spaces", DEFAULT_SPACE, "memory"),
    { recursive: true },
  );
  const intents = intentsDirOf(project, DEFAULT_SPACE);
  mkdirSync(seededRecordDir(project), { recursive: true });
  writeFileSync(join(project, "aidlc", "active-space"), `${DEFAULT_SPACE}\n`);
  writeFileSync(join(intents, "active-intent"), `${DEFAULT_RECORD_DIR}\n`);
  writeFileSync(join(intents, "intents.json"), JSON.stringify([{
    uuid: "00000000-0000-7000-8000-000000000001",
    slug: DEFAULT_RECORD_DIR.replace(/-[0-9a-f]+$/, ""),
    status: "in-flight",
  }]));
  const previous = readFileSync(
    join(REPO_ROOT, "tests", "fixtures", "state-brownfield-feature.md"), "utf-8",
  ).replace("- **Scope**: feature", "- **Scope**: poc\n- **Skeleton Stance**: on")
    // The retired "Change Control" field name is deliberate: the engine still
    // reads it as the Guard Policy alias for one release, and this fixture is
    // where that alias stays exercised.
    .replace("- **Change Control**: strict (from scope feature)",
      `- **Change Control**: ${policy} (from scope poc)`)
    .replace(
    /^- \*\*Current Stage\*\*:.*$/m,
    "- **Current Stage**: requirements-analysis",
  );
  writeFileSync(seededStateFile(project), previous);
  // Seed the record's audit ledger a real workflow always has by this point: a
  // guard that stands aside records its row best-effort, into a ledger that
  // exists. Pinning the clone id keeps the spawned binary on the same shard.
  writeFileSync(join(project, "aidlc", ".aidlc-clone-id"), "nativerecoverytest\n", "utf-8");
  const ledger = join(seededRecordDir(project), "audit", auditShardName(project));
  mkdirSync(dirname(ledger), { recursive: true });
  writeFileSync(ledger, "# AI-DLC Audit Log\n", "utf-8");
  writeActiveDirectiveMarker(project, {
    kind: "run-stage",
    stage: "requirements-analysis",
    state_sha256: stateDigest(previous),
  });
  const markerFile = join(seededRecordDir(project), ".aidlc-engine/active-directive.json");
  const marker = JSON.parse(readFileSync(markerFile, "utf-8"));
  marker.revision = 4;
  delete marker.code_generation_authority_revision;
  delete marker.code_generation_source_sha256;
  mkdirSync(dirname(markerFile), { recursive: true });
  writeFileSync(markerFile, JSON.stringify(marker));
  writeFileSync(seededStateFile(project), previous.replace(
    "- **Current Stage**: requirements-analysis",
    "- **Current Stage**: code-generation",
  ));
  mkdirSync(join(project, "src"));
  writeFileSync(join(project, "src", "base.ts"), "export const base = true;\n");
  for (const args of [
    ["init", "-q"],
    ["-c", "user.name=Test", "-c", "user.email=test@example.com", "add", "-A"],
    ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "fixture"],
  ]) {
    const result = spawnSync("git", args, { timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS), cwd: project, encoding: "utf-8" });
    expect(result.status, result.stderr).toBe(0);
  }
  return project;
}

function run(project: string, args: string[], payload?: object, legacy = false) {
  const result = spawnSync(resolve(binary), args, {
    cwd: project,
    input: payload && !legacy ? JSON.stringify(payload) : "",
    encoding: "utf-8",
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    env: {
      ...testGuardEnvironment(process.env, "production"),
      AIDLC_UNATTENDED: "0",
      AIDLC_PROJECT_DIR: project,
      CLAUDE_PROJECT_DIR: project,
      AIDLC_RUNTIME_ROOT: runtimeRoot,
      AIDLC_HARNESS_DIR: ".kiro",
      AIDLC_HARNESS_NAME: "kiro-ide",
      VSCODE_PID: "native-recovery-test",
      USER_PROMPT: payload && legacy ? JSON.stringify(payload) : "",
    },
  });
  return {
    code: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function guard(project: string, tool: string, input: object) {
  return run(project, ["engine", "adapter", "kiro-ide", "plan-approval-guard"], {
    hook_event_name: "PreToolUse",
    session_id: "native-recovery-test",
    cwd: project,
    tool_name: tool,
    tool_input: input,
  });
}

function marker(project: string) {
  return JSON.parse(readFileSync(
    join(seededRecordDir(project), ".aidlc-engine/active-directive.json"), "utf-8",
  ));
}

function assertPublished(project: string) {
  const active = marker(project);
  expect(active.stage).toBe("code-generation");
  expect(active.state_present).toBe(true);
  expect(active.code_generation_authority_revision).toBeGreaterThan(4);
  expect(active.code_generation_source_sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(active.revision).toBeGreaterThan(4);
}

function auditRows(project: string): string {
  const audit = join(seededRecordDir(project), "audit");
  return readdirSync(audit).filter((name) => name.endsWith(".md"))
    .map((name) => readFileSync(join(audit, name), "utf-8")).join("\n");
}

const LOWER_FENCE_SWITCH = "config set guard.plan-approval off";

// GUARD_STOOD_ASIDE rows whose Guard is plan-approval.
function stoodAsideRows(project: string): number {
  if (!existsSync(join(seededRecordDir(project), "audit"))) return 0;
  return auditRows(project).split("\n## ").filter((block) =>
    block.includes("**Event**: GUARD_STOOD_ASIDE") &&
    block.includes("**Guard**: plan-approval")
  ).length;
}

// Drive the stale upstream directive through `next` and every receipt-continued
// part until the engine publishes code-generation authority.
function publishAuthority(project: string): Record<string, unknown> {
  expect(marker(project).stage).toBe("requirements-analysis");
  const admitted = guard(project, "execute_pwsh", {
    command: "aidlc engine orchestrate next",
  });
  console.log("NATIVE_RECOVERY populated next", JSON.stringify(admitted));
  expect(admitted.code, admitted.stderr).toBe(0);
  let response = run(project, ["engine", "orchestrate", "next"]);
  expect(response.code, response.stderr).toBe(0);
  let directive = JSON.parse(response.stdout);
  for (let i = 0; directive.kind === "load-steering" && i < 64; i++) {
    const args = ["engine", "orchestrate", "continue", directive.receipt];
    const allowed = guard(project, "execute_pwsh", {
      command: `aidlc ${args.join(" ")}`,
    });
    expect(allowed.code, allowed.stderr).toBe(0);
    response = run(project, args);
    expect(response.code, response.stderr).toBe(0);
    directive = JSON.parse(response.stdout);
  }
  expect(directive.kind, response.stdout).toBe("run-stage");
  assertPublished(project);
  return directive;
}

function sourceWriteOf(project: string) {
  return guard(project, "fs_write", {
    path: join(project, "src", "slugify.ts"),
    content: "export const slugify = () => '';\n",
  });
}

function writePlanArtifacts(project: string): string {
  const stageDir = join(seededRecordDir(project), "construction", "code-generation");
  mkdirSync(stageDir, { recursive: true });
  writeFileSync(join(stageDir, "code-generation-plan.md"),
    `# Plan\n\nImplement slugify with unit tests.\n\n${renderTestingContract(resolveTestingPosture(project))}`);
  writeFileSync(join(stageDir, "unit-test-instructions.md"),
    "# Tests\n\nTest whitespace, punctuation, and empty input.\n");
  const questions = join(stageDir, "code-generation-questions.md");
  writeFileSync(questions,
    "## Plan Approval\n\n- Approve Plan\n- Request Changes\n[Answer]:\n");
  return questions;
}

function assertFence(project: string, policy: "strict" | "relaxed" | "off") {
  const setting = run(project, ["engine", "config", "get", "guard.plan-approval"]);
  expect(setting.code, setting.stderr).toBe(0);
  expect(setting.stdout.trim()).toBe(policy === "strict"
    ? "on (default)"
    : `off (guard policy ${policy} (from scope poc))`);
}

describe("native Kiro IDE recovery from a stale upstream directive", () => {
  test.each(["relaxed", "off"] as const)("populated shell next preserves initial approval with the %s fence off", (policy) => {
    const project = fixture(policy);
    const directive = publishAuthority(project);
    expect(directive.gate).toBe(true);
    const assertBlocked = (reason: string) => {
      assertFence(project, policy);
      const blocked = sourceWriteOf(project);
      expect(blocked.code, blocked.stderr).toBe(2);
      expect(JSON.parse(blocked.stderr).code).toBe("CODE_GENERATION_EXECUTION_INELIGIBLE");
      expect(blocked.stderr).toContain(reason);
      expect(blocked.stdout).toBe("");
      assertFence(project, policy);
      expect(stoodAsideRows(project)).toBe(0);
      expect(auditRows(project)).not.toContain("**Event**: PLAN_APPROVAL_RECORDED");
    };
    assertBlocked("code-generation-plan.md is missing or empty");
    writePlanArtifacts(project);
    assertBlocked("Plan Approval");
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("under a strict policy the same flow keeps source writes refused until the plan is approved", () => {
    const project = fixture("strict");
    publishAuthority(project);
    // Nothing has lowered the fence (no policy word, no per-run switch), so the
    // ordering invariant holds: the write is refused, the refusal names the one
    // switch that would lower it, and no stand-aside is recorded.
    const blocked = sourceWriteOf(project);
    expect(blocked.code, blocked.stdout).toBe(2);
    expect(blocked.stderr).toContain(LOWER_FENCE_SWITCH);
    expect(stoodAsideRows(project)).toBe(0);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("an argument-less shell invokes native recovery and republishes authority", () => {
    const project = fixture();
    const recovered = guard(project, "execute_pwsh", {});
    console.log("NATIVE_RECOVERY opaque shell", JSON.stringify(recovered));
    // The adapter refuses the original uninspectable command after carrying
    // out its own engine recovery. It must not execute arbitrary shell input.
    expect(recovered.code, recovered.stderr).toBe(2);
    expect(recovered.stderr).toContain("recovery issued a fresh directive");
    assertPublished(project);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test.each(["strict", "relaxed", "off"] as const)("native recovery under %s admits generation only after the human response", (policy) => {
    const project = fixture(policy);
    const recovered = run(
      project,
      ["engine", "adapter", "kiro-ide", "plan-approval-guard"],
      { toolName: "execute_pwsh", toolArgs: {} },
      true,
    );
    expect(recovered.code, recovered.stderr).toBe(2);
    expect(recovered.stderr).toContain("recovery issued a fresh directive");
    assertPublished(project);
    const directive = JSON.parse(
      recovered.stderr.split("Resume canonical planning from: ")[1],
    );
    const approveChoice = directive.legacy_plan_approval_choices?.approve;
    expect(typeof approveChoice).toBe("string");
    const questions = writePlanArtifacts(project);
    const mediateQuestions = () => run(
      project,
      ["engine", "adapter", "kiro-ide", "audit-and-sensors"],
      {
        toolName: "fs_write",
        toolArgs: {},
        toolResult: `Created the ${questions} file.`,
        toolSuccess: true,
      },
      true,
    );
    const decision = mediateQuestions();
    console.log("NATIVE_RECOVERY decision", JSON.stringify(decision));
    expect(decision.code, decision.stderr).toBe(0);
    const rows = auditRows(project);
    expect(rows).toContain("DECISION_RECORDED");
    expect(rows).not.toContain("PLAN_APPROVAL_RECORDED");
    const sourceWrite = () => sourceWriteOf(project);
    const beforeApproval = sourceWrite();
    expect(beforeApproval.code, beforeApproval.stdout).toBe(2);
    if (policy === "strict") {
      expect(beforeApproval.stderr).toContain(LOWER_FENCE_SWITCH);
    } else {
      expect(JSON.parse(beforeApproval.stderr).code).toBe("CODE_GENERATION_EXECUTION_INELIGIBLE");
    }
    assertFence(project, policy);
    expect(stoodAsideRows(project)).toBe(0);
    // Only the fixture's exact offered human choice may authorize this plan.
    const human = run(project, ["engine", "adapter", "kiro-ide", "record-human-turn"],
      { prompt: approveChoice }, true);
    expect(human.code, human.stderr).toBe(0);
    writeFileSync(questions, readFileSync(questions, "utf-8")
      .replace("[Answer]:", "[Answer]: Approve Plan"));
    const answer = mediateQuestions();
    expect(answer.code, answer.stderr).toBe(0);
    expect(auditRows(project)).toContain("PLAN_APPROVAL_RECORDED");
    const verified = run(project, ["engine", "testing-posture", "verify", "--stage-level"]);
    expect(verified.code, verified.stderr).toBe(0);
    expect(JSON.parse(verified.stdout).ok).toBe(true);
    const generation = sourceWrite();
    expect(generation.code, generation.stderr).toBe(0);
    expect(generation.stdout).toBe("");
    expect(stoodAsideRows(project)).toBe(0);

    const approvalRows = readAuditShardEvents(project)
      .filter((entry) => entry.event === "PLAN_APPROVAL_RECORDED");
    expect(approvalRows).toHaveLength(1);
    const approvedQuestions = readFileSync(questions, "utf-8");
    appendFileSync(join(dirname(questions), "code-generation-plan.md"),
      "\nAlso handle repeated punctuation.\n");
    const continuation = sourceWrite();
    expect(continuation.code, continuation.stderr).toBe(policy === "strict" ? 2 : 0);
    if (policy !== "strict") {
      expect(continuation.stdout).toContain(
        `Continuing past the plan-approval check because it is off for this piece of work (guard policy ${policy} (from scope poc))`,
      );
    }
    expect(stoodAsideRows(project)).toBe(policy === "strict" ? 0 : 1);
    expect(readFileSync(questions, "utf-8")).toBe(approvedQuestions);
    expect(readAuditShardEvents(project)
      .filter((entry) => entry.event === "PLAN_APPROVAL_RECORDED")).toEqual(approvalRows);
    assertFence(project, policy);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("a recorded recovery choice clears an interrupted native planning write", () => {
    const project = fixture();
    const legacy = (target: string, payload: object) =>
      run(project, ["engine", "adapter", "kiro-ide", target], payload, true);
    const shell = () => legacy("plan-approval-guard", {
      toolName: "execute_pwsh", toolArgs: {},
    });
    expect(shell().stderr).toContain("recovery issued a fresh directive");
    const opened = legacy("plan-approval-guard", { toolName: "fs_write", toolArgs: {} });
    expect(opened.code, opened.stderr).toBe(0);
    // Deliberately omit PostToolUse in this synthetic fixture.
    const pending = shell();
    expect(pending.code, pending.stderr).toBe(2);
    expect(pending.stderr).toContain("recovery requires a human response");
    const response = legacy("record-human-turn", { prompt: "Recover Plan Approval" });
    expect(response.code, response.stderr).toBe(0);
    const recovered = shell();
    expect(recovered.code, recovered.stderr).toBe(2);
    expect(recovered.stderr).toContain("recovery issued a fresh directive");
    expect(auditRows(project)).toContain("HUMAN_TURN");
    expect(readPlanApprovalLegacyWindows(project)).toHaveLength(0);
    expect(auditRows(project)).not.toContain("PLAN_APPROVAL_RECORDED");
    const planning = legacy("plan-approval-guard", { toolName: "fs_write", toolArgs: {} });
    expect(planning.code, planning.stderr).toBe(0);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
});
