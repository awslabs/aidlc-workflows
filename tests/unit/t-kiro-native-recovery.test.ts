// covers: subcommand:aidlc-orchestrate:next
// The installed native dispatcher must keep the remedy reachable when the
// durable stage has advanced but the preceding directive has not.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import {
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

const scratchRoot = process.env.AIDLC_NATIVE_RECOVERY_SCRATCH ??
  join(REPO_ROOT, "tmp", "kiro-native-recovery");
const runtimeRoot = process.env.AIDLC_NATIVE_RECOVERY_RUNTIME ??
  join(REPO_ROOT, "dist-release");
let binary = process.env.AIDLC_NATIVE_RECOVERY_BINARY ?? "";
let scratch: string;

beforeAll(() => {
  mkdirSync(scratchRoot, { recursive: true });
  scratch = mkdtempSync(join(scratchRoot, "run-"));
  if (binary) return;
  binary = join(scratch, process.platform === "win32" ? "aidlc.exe" : "aidlc");
  const result = spawnSync(process.execPath, [
    "build", join(runtimeRoot, "claude", ".claude", "tools", "aidlc.ts"),
    "--compile", "--outfile", binary,
  ], { encoding: "utf-8", timeout: 120_000 });
  expect(result.status, result.stdout + result.stderr).toBe(0);
}, 120_000);

afterAll(() => {
  if (scratch && !process.env.AIDLC_NATIVE_RECOVERY_KEEP) {
    rmSync(scratch, { recursive: true, force: true });
  }
});

function fixture(): string {
  const project = mkdtempSync(join(scratch, "project-"));
  cpSync(join(runtimeRoot, "kiro", ".kiro"), join(project, ".kiro"), {
    recursive: true,
  });
  cpSync(
    join(runtimeRoot, "kiro", ".kiro", "tools", "data", "memory-seed"),
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
  ).replace("- **Scope**: feature", "- **Scope**: poc")
    .replace("- **Change Control**: strict (from scope feature)",
      "- **Change Control**: relaxed (from scope poc)")
    .replace(
    /^- \*\*Current Stage\*\*:.*$/m,
    "- **Current Stage**: requirements-analysis",
  );
  writeFileSync(seededStateFile(project), previous);
  writeActiveDirectiveMarker(project, {
    kind: "run-stage",
    stage: "requirements-analysis",
    state_sha256: stateDigest(previous),
  });
  const markerFile = join(seededRecordDir(project), ".aidlc-active-directive.json");
  const marker = JSON.parse(readFileSync(markerFile, "utf-8"));
  marker.revision = 4;
  delete marker.code_generation_authority_revision;
  delete marker.code_generation_source_sha256;
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
    const result = spawnSync("git", args, { cwd: project, encoding: "utf-8" });
    expect(result.status, result.stderr).toBe(0);
  }
  return project;
}

function run(project: string, args: string[], payload?: object, legacy = false) {
  const result = spawnSync(resolve(binary), args, {
    cwd: project,
    input: payload && !legacy ? JSON.stringify(payload) : "",
    encoding: "utf-8",
    timeout: 30_000,
    env: {
      ...process.env,
      AIDLC_PROJECT_DIR: project,
      CLAUDE_PROJECT_DIR: project,
      AIDLC_RUNTIME_ROOT: runtimeRoot,
      AIDLC_HARNESS_DIR: ".kiro",
      AIDLC_HARNESS_NAME: "kiro",
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
  return run(project, ["engine", "adapter", "kiro", "plan-approval-guard"], {
    hook_event_name: "PreToolUse",
    session_id: "native-recovery-test",
    cwd: project,
    tool_name: tool,
    tool_input: input,
  });
}

function marker(project: string) {
  return JSON.parse(readFileSync(
    join(seededRecordDir(project), ".aidlc-active-directive.json"), "utf-8",
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

describe("native Kiro IDE recovery from a stale upstream directive", () => {
  test("populated shell next can publish authority while source writes stay blocked", () => {
    const project = fixture();
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
      const args = ["engine", "orchestrate", "continue", directive.continue_token];
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
    const blocked = guard(project, "fs_write", {
      path: join(project, "src", "slugify.ts"),
      content: "export const slugify = () => '';\n",
    });
    expect(blocked.code, blocked.stderr).toBe(2);
  }, 120_000);

  test("an argument-less shell invokes native recovery and republishes authority", () => {
    const project = fixture();
    const recovered = guard(project, "execute_pwsh", {});
    console.log("NATIVE_RECOVERY opaque shell", JSON.stringify(recovered));
    // The adapter refuses the original uninspectable command after carrying
    // out its own engine recovery. It must not execute arbitrary shell input.
    expect(recovered.code, recovered.stderr).toBe(2);
    expect(recovered.stderr).toContain("recovery issued a fresh directive");
    assertPublished(project);
  }, 120_000);

  test("native recovery can record Plan Approval and admit generation after the human response", () => {
    const project = fixture();
    const recovered = run(
      project,
      ["engine", "adapter", "kiro", "plan-approval-guard"],
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
    const stageDir = join(seededRecordDir(project), "construction", "code-generation");
    mkdirSync(stageDir, { recursive: true });
    writeFileSync(join(stageDir, "code-generation-plan.md"),
      `# Plan\n\nImplement slugify with unit tests.\n\n${renderTestingContract(resolveTestingPosture(project))}`);
    writeFileSync(join(stageDir, "unit-test-instructions.md"),
      "# Tests\n\nTest whitespace, punctuation, and empty input.\n");
    const questions = join(stageDir, "code-generation-questions.md");
    writeFileSync(questions,
      "## Plan Approval\n\n- Approve Plan\n- Request Changes\n[Answer]:\n");
    const mediateQuestions = () => run(
      project,
      ["engine", "adapter", "kiro", "audit-and-sensors"],
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
    const sourceWrite = () => guard(project, "fs_write", {
      path: join(project, "src", "slugify.ts"),
      content: "export const slugify = () => '';\n",
    });
    expect(sourceWrite().code).toBe(2);
    // Only the fixture's exact offered human choice may authorize this plan.
    const human = run(project, ["engine", "adapter", "kiro", "record-human-turn"],
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
  }, 120_000);

  test("a recorded recovery choice clears an interrupted native planning write", () => {
    const project = fixture();
    const legacy = (target: string, payload: object) =>
      run(project, ["engine", "adapter", "kiro", target], payload, true);
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
  }, 120_000);
});
