// covers: hook:aidlc-plan-approval-guard, subcommand:aidlc-log:answer
// #2265: execute the shipped Codex adapter and log owner with a compiled CLI.
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendAuditEntry } from "../../core/tools/aidlc-audit.ts";
import { readAllAuditShards, stateDigest, writeActiveDirectiveMarker } from "../../core/tools/aidlc-lib.ts";
import { createTestProject, seedAidlcMemory, seededRecordDir, seededStateFile } from "../harness/fixtures.ts";
import { NATIVE_COMPILE_TIMEOUT_MS, NATIVE_FIXTURE_SETUP_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";

const ROOT = join(import.meta.dir, "..", "..");

test("native Codex summary receipt precedes the plan without authorizing generation (#2265)", () => {
  const scratch = mkdtempSync(join(tmpdir(), "summary-native-"));
  const proj = createTestProject();
  try {
    const runtime = join(ROOT, "dist-release");
    const binary = join(scratch, process.platform === "win32" ? "aidlc.exe" : "aidlc");
    const build = spawnSync(process.execPath, ["build", join(runtime, "claude", ".claude", "tools", "aidlc.ts"), "--compile", "--outfile", binary], {
      cwd: ROOT, encoding: "utf-8", timeout: remainingOperationTimeoutMs(NATIVE_COMPILE_TIMEOUT_MS),
    });
    expect(build.status, `${build.stdout}\n${build.stderr}`).toBe(0);
    symlinkSync(runtime, join(scratch, "runtime"), "junction");
    cpSync(join(runtime, "codex", ".codex"), join(proj, ".codex"), { recursive: true });
    seedAidlcMemory(proj);
    const state = "# AI-DLC State Tracking\n\n## Project Information\n- **Scope**: classic\n- **Guard Policy**: strict\n\n## Current Status\n- **Lifecycle Phase**: CONSTRUCTION\n- **Current Stage**: code-generation\n";
    writeFileSync(seededStateFile(proj), state);
    writeActiveDirectiveMarker(proj, { kind: "run-stage", stage: "code-generation", unit: "todo-core", state_sha256: stateDigest(state) });
    const dir = join(seededRecordDir(proj), "construction", "todo-core", "code-generation");
    mkdirSync(dir, { recursive: true });
    const questions = join(dir, "code-generation-questions.md");
    writeFileSync(questions, "# Planning questions\n\n## Q1\n\nKeep the current API.\n\n## Consolidated Summary Confirmation\n\n- Looks correct\n- Request changes\n\n[Answer]:\n");
    const env: NodeJS.ProcessEnv = { ...process.env, AIDLC_PROJECT_DIR: proj, AIDLC_HARNESS_NAME: "codex", AIDLC_HARNESS_DIR: ".codex", AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "0", AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD: "0", AIDLC_DISABLE_PLAN_APPROVAL_GUARD: "0" };
    delete env.CODEX_THREAD_ID;
    delete env.CODEX_SESSION_ID;
    delete env.AIDLC_SESSION_OVERRIDE;
    delete env.AIDLC_SESSION_OVERRIDE_SOURCE;
    const run = (args: string[], input?: object) => spawnSync(binary, args, {
      cwd: proj, env, encoding: "utf-8", input: input ? JSON.stringify(input) : undefined,
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    });
    const guard = (tool_name: string, tool_input: object) => run(["engine", "adapter", "codex", "plan-approval-guard"], {
      hook_event_name: "PreToolUse", tool_name, tool_input, cwd: proj,
    });
    const args = ["engine", "log", "decision", "--stage", "code-generation", "--checkpoint", "summary-confirmation", "--questions-file", questions, "--unit", "todo-core", "--decision", "Does this all look correct?", "--options", "Looks correct,Request changes"];
    const command = (verb: string) => `aidlc engine log ${verb} --stage code-generation --checkpoint summary-confirmation --questions-file '${questions}' --unit todo-core --details 'Looks correct'`;
    for (const verb of ["decision", "answer"]) {
      const admitted = guard("Bash", { command: command(verb) });
      expect(admitted.status, admitted.stderr).toBe(0);
    }
    const missing = run(["engine", "log", "answer", "--stage", "code-generation", "--checkpoint", "summary-confirmation", "--questions-file", join(dir, "missing.md"), "--unit", "todo-core", "--details", "Looks correct"]);
    expect(missing.status).not.toBe(0);
    const decision = run(args);
    expect(decision.status, decision.stderr).toBe(0);
    // Synthetic human evidence belongs only to this isolated regression fixture.
    appendAuditEntry("HUMAN_TURN", {}, proj);
    writeFileSync(questions, readFileSync(questions, "utf-8").replace("[Answer]:", "[Answer]: Looks correct"));
    const answer = run(["engine", "log", "answer", "--stage", "code-generation", "--checkpoint", "summary-confirmation", "--questions-file", questions, "--unit", "todo-core", "--details", "Looks correct"]);
    expect(answer.status, answer.stderr).toBe(0);
    expect(readAllAuditShards(proj)).toContain("**Event**: SUMMARY_CONFIRMATION_RECORDED");
    expect(readAllAuditShards(proj)).not.toContain("**Event**: PLAN_APPROVAL_RECORDED");
    expect(guard("Bash", { command: "printf code > src/generated.ts" }).status).toBe(2);
    expect(guard("spawn_agent", { agent_type: "aidlc-developer-agent", message: "AIDLC-UNIT: todo-core\nImplement todo-core" }).status).toBe(2);
  } finally {
    rmSync(proj, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  }
}, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
