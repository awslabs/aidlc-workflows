// covers: subcommand:aidlc-orchestrate:report, subcommand:aidlc-orchestrate:next
//
// The line after a skip says why the stage was skipped. A stage the agent
// found does not apply is said as "<stage> does not apply here, so I skipped
// it." A stage the person asked to skip is not one that does not apply: the
// step that skips it already gives the one line ("Skipped <stage>. It can
// still be run on its own with ..."), so the next step says no reason of its
// own. Reverse Engineering kept on the existing code knowledge base applies
// too: the step says it reused that knowledge base and skipped the scan. The
// line rides the next step's change_notices, beside its own narration.
//
// Mechanism: cli - spawns the shipped tools against temp projects created via
// intent-create.

import { afterAll, describe, expect, test, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";
import { cleanupTestProject, runOrchestrateNext, setupIntegrationProject } from "../harness/fixtures.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

// One chat, so a line passed through on one step is said with the next.
const env: Record<string, string | undefined> = {
  ...process.env,
  AIDLC_SESSION_OVERRIDE: "01995000-7a11-7000-8000-000000002400",
  AIDLC_SESSION_OVERRIDE_SOURCE: "payload",
};
for (const key of ["AIDLC_SCOPE_MAPPING", "CLAUDE_CODE_SESSION_ID", "CLAUDE_PID", "CODEX_THREAD_ID", "KIRO_SESSION_ID"]) {
  delete env[key];
}

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) cleanupTestProject(dir);
});

type Directive = { kind?: string; stage?: string; message?: string; narration?: string; change_notices?: string[] };

const toldOf = (d: Directive): string => (d.change_notices ?? []).join(" ");

function run(proj: string, tool: string, args: string[]): { status: number; out: string; stdout: string } {
  const res = spawnSync(process.execPath, [join(proj, ".claude", "tools", tool), ...args, "--project-dir", proj], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    encoding: "utf-8",
    env,
    cwd: proj,
  });
  return { status: res.status ?? -1, out: `${res.stdout ?? ""}${res.stderr ?? ""}`, stdout: res.stdout ?? "" };
}

function next(proj: string, args: string[] = []): Directive {
  const res = runOrchestrateNext(join(proj, ".claude", "tools", "aidlc-orchestrate.ts"), proj, args, { cwd: proj, env });
  expect(res.directive, res.out).not.toBeNull();
  return res.directive as Directive;
}

function lastDirective(stdout: string): Directive {
  const lines = stdout.trim().split("\n").filter((line) => line.startsWith("{"));
  return JSON.parse(lines[lines.length - 1] ?? "{}") as Directive;
}

function startedProject(): string {
  const proj = setupIntegrationProject({ noAidlcDocs: true, stripEnvScope: true });
  tempDirs.push(proj);
  const created = run(proj, "aidlc-utility.ts", ["intent-create", "--scope", "express", "--project-type", "brownfield"]);
  expect(created.status, created.out).toBe(0);
  const first = next(proj);
  expect(first.kind, JSON.stringify(first)).toBe("run-stage");
  expect(first.stage).toBe("reverse-engineering");
  return proj;
}

describe("the line after a skip says why the stage was skipped", () => {
  test("a stage the person asked to skip is not said as one that does not apply", () => {
    const proj = startedProject();
    const asked = next(proj, ["--skip", "reverse-engineering"]);
    expect(asked.kind, JSON.stringify(asked)).toBe("print");
    expect(String(asked.message)).toContain('"Skipped Reverse Engineering. It can still be run on its own with');
    const named = /`[^`]*\breport (--stage reverse-engineering --result skipped --reason '([^']*)')`/.exec(String(asked.message));
    expect(named, String(asked.message)).not.toBeNull();
    const skipped = run(proj, "aidlc-orchestrate.ts", [
      "report", "--stage", "reverse-engineering", "--result", "skipped", "--reason", String(named?.[2]),
    ]);
    expect(skipped.status, skipped.out).toBe(0);
    expect(lastDirective(skipped.stdout).kind, skipped.out).toBe("done");
    const after = next(proj);
    expect(after.kind, JSON.stringify(after)).toBe("run-stage");
    expect(after.stage).toBe("requirements-analysis");
    expect(`${toldOf(after)} ${after.narration ?? ""}`).not.toContain("does not apply");
    expect(String(after.narration ?? "")).toMatch(/^Now working on Requirements Analysis\b/);
  });

  test("the last stage the person asked to skip ends the work with no reason of its own", () => {
    const proj = startedProject();
    const jumped = run(proj, "aidlc-jump.ts", ["execute", "--target", "observability-setup", "--direction", "forward"]);
    expect(jumped.status, jumped.out).toBe(0);
    expect(next(proj).stage).toBe("observability-setup");
    const asked = next(proj, ["--skip", "observability-setup"]);
    expect(String(asked.message)).toContain('"Skipped Observability Setup. It can still be run on its own with');
    const named = /`[^`]*\breport --stage observability-setup --result skipped --reason '([^']*)'`/.exec(String(asked.message));
    expect(named, String(asked.message)).not.toBeNull();
    const skipped = run(proj, "aidlc-orchestrate.ts", [
      "report", "--stage", "observability-setup", "--result", "skipped", "--reason", String(named?.[1]),
    ]);
    expect(skipped.status, skipped.out).toBe(0);
    const done = lastDirective(skipped.stdout) as Directive & { workflow_continues?: boolean };
    expect(done.kind, skipped.out).toBe("done");
    expect(done.workflow_continues, skipped.out).not.toBe(true);
    expect(skipped.out).not.toContain("does not apply");
  });

  test("Reverse Engineering kept on the existing code knowledge base says so, not that it does not apply", () => {
    const proj = startedProject();
    // The person picked "Reuse existing knowledge base"; the agent records it
    // and reports the skip as the stage's Step 1 says.
    const asked = run(proj, "aidlc-log.ts", [
      "decision", "--stage", "reverse-engineering", "--decision", "Reuse it, or rescan?",
      "--options", "Reuse existing knowledge base,Full rescan,Focused scan",
    ]);
    expect(asked.status, asked.out).toBe(0);
    const reply = spawnSync(process.execPath, [join(proj, ".claude", "tools", "aidlc.ts"), "engine", "hook", "record-human-turn"], {
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
      encoding: "utf-8",
      env,
      cwd: proj,
      input: JSON.stringify({ session_id: env.AIDLC_SESSION_OVERRIDE, cwd: proj, hook_event_name: "UserPromptSubmit", prompt: "1" }),
    });
    expect(reply.status, `${reply.stdout}${reply.stderr}`).toBe(0);
    const answered = run(proj, "aidlc-log.ts", ["answer", "--stage", "reverse-engineering", "--details", "Reuse existing knowledge base"]);
    expect(answered.status, answered.out).toBe(0);
    const store = run(proj, "aidlc-utility.ts", ["codekb-path"]);
    expect(store.status, store.out).toBe(0);
    const kept = run(proj, "aidlc-state.ts", [
      "reuse-artifact", "reverse-engineering", "--decision", "keep", "--artifacts", store.stdout.trim(),
    ]);
    expect(kept.status, kept.out).toBe(0);
    const skipped = run(proj, "aidlc-orchestrate.ts", [
      "report", "--stage", "reverse-engineering", "--result", "skipped",
      "--reason", "codekb reuse: all resolved stores CURRENT, human chose reuse",
    ]);
    expect(skipped.status, skipped.out).toBe(0);
    const after = next(proj);
    expect(after.kind, JSON.stringify(after)).toBe("run-stage");
    expect(after.stage).toBe("requirements-analysis");
    expect(toldOf(after)).toBe("Reverse Engineering reused the existing code knowledge base, so I skipped the scan.");
    expect(String(after.narration)).toMatch(/^Now working on Requirements Analysis\b/);
  });

  test("a stage the agent found does not apply still says so", () => {
    const proj = startedProject();
    const skipped = run(proj, "aidlc-orchestrate.ts", [
      "report", "--stage", "reverse-engineering", "--result", "skipped", "--reason", "there is no code here yet",
    ]);
    expect(skipped.status, skipped.out).toBe(0);
    const after = next(proj);
    expect(after.kind, JSON.stringify(after)).toBe("run-stage");
    expect(toldOf(after)).toBe("Reverse Engineering does not apply here, so I skipped it.");
    expect(String(after.narration)).toMatch(/^Now working on Requirements Analysis\b/);
  });
});
