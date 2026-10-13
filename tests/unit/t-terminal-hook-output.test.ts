// covers: function:publishHookOutput
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { noteHookRefusal, publishHookOutput } from "../../core/tools/aidlc-hook-output.ts";
import { currentHookWorkflow, withHookWorkflowMutation, withAuditLock, type HookWorkflow } from "../../core/tools/aidlc-lib.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(status = "Running") {
  const project = mkdtempSync(join(tmpdir(), "aidlc-terminal-output-"));
  roots.push(project);
  const record = join(project, "aidlc", "spaces", "default", "intents", "a");
  mkdirSync(record, { recursive: true });
  const state = join(record, "aidlc-state.md");
  writeFileSync(state, `- **Status**: ${status}\n`);
  const workflow: HookWorkflow = {
    selection: { space: "default", intent: "a", sessionId: null, binding: null },
    participation: "participant", lifecycle: status === "Running" ? "running" : "completed", restore: () => {},
  };
  return { project, state, workflow };
}
async function capture(action: () => Promise<number>) {
  const stdout = process.stdout.write;
  const stderr = process.stderr.write;
  let out = "";
  let err = "";
  process.stdout.write = ((chunk: unknown) => { out += String(chunk); return true; }) as typeof stdout;
  process.stderr.write = ((chunk: unknown) => { err += String(chunk); return true; }) as typeof stderr;
  try { return { code: await action(), out, err }; }
  finally { process.stdout.write = stdout; process.stderr.write = stderr; }
}

describe("a hook publishes only the response its target's lifecycle still admits", () => {
  test("running work keeps stdout, stderr and the original refusal code", async () => {
    const f = fixture();
    const result = await capture(() => publishHookOutput(f.project, f.workflow, async () => {
      process.stdout.write("context");
      await Promise.resolve();
      process.stderr.write("plan refusal");
      return 2;
    }));
    expect(result).toEqual({ code: 2, out: "context", err: "plan refusal" });
  });

  for (const status of ["Completed", "Archived"]) {
    test(`${status} winning before publication discards stale context and reruns independent checks`, async () => {
      const f = fixture();
      let terminalChecks = 0;
      let completed = false;
      const result = await capture(() => publishHookOutput(f.project, f.workflow, async () => {
        process.stdout.write("active stage instructions");
        await Promise.resolve();
        withAuditLock(f.project, () => writeFileSync(f.state, `- **Status**: ${status}\n`));
        completed = true;
        process.stderr.write("old plan refusal");
        return 2;
      }, () => {
        terminalChecks++;
        if (!completed) return 0;
        process.stderr.write("claimed checkout refusal");
        return 2;
      }));
      expect(result).toEqual({ code: 2, out: "", err: "claimed checkout refusal" });
      expect(terminalChecks).toBe(2);
    });
  }

  test("a terminal selection never evaluates its old workflow", async () => {
    const f = fixture("Completed");
    const result = await capture(() => publishHookOutput(f.project, f.workflow,
      () => { throw new Error("old workflow evaluated"); },
      () => { process.stderr.write("runtime integrity refusal"); return 2; }));
    expect(result).toEqual({ code: 2, out: "", err: "runtime integrity refusal" });
  });

  test("a failed evaluator restores the caller's output streams", async () => {
    const f = fixture();
    const stdout = process.stdout.write;
    const stderr = process.stderr.write;
    await expect(publishHookOutput(f.project, f.workflow, () => { throw new Error("failed read"); })).rejects.toThrow("failed read");
    expect(process.stdout.write).toBe(stdout);
    expect(process.stderr.write).toBe(stderr);
  });

  test("independent refusal precedes all workflow work and cannot mutate its record", async () => {
    const f = fixture();
    let wrote = false;
    const result = await capture(() => publishHookOutput(f.project, f.workflow,
      () => { throw new Error("workflow evaluation must not run"); },
      () => {
        expect(currentHookWorkflow(f.project)?.mode).toBe("independent");
        // Even a caller constructing its own Running context cannot escape the scope.
        withHookWorkflowMutation(f.project, f.workflow, () => { wrote = true; });
        process.stderr.write("runtime integrity refusal");
        return 2;
      }));
    expect(wrote).toBe(false);
    expect(result).toEqual({ code: 2, out: "", err: "runtime integrity refusal" });
  });

  test("a host JSON denial with exit zero is still an independent refusal", async () => {
    const f = fixture();
    const result = await capture(() => publishHookOutput(f.project, f.workflow,
      () => { throw new Error("workflow evaluation must not run"); },
      () => {
        noteHookRefusal();
        process.stdout.write('{"permission":"deny"}');
        return 0;
      }));
    expect(result).toEqual({ code: 0, out: '{"permission":"deny"}', err: "" });
  });

  test("a bootstrap produced during evaluation survives a late completion", async () => {
    const f = fixture();
    let bootstrap = "";
    const result = await capture(() => publishHookOutput(f.project, f.workflow, () => {
      bootstrap = "One-time setup notice.";
      process.stdout.write(`${bootstrap} Active workflow mission.`);
      withAuditLock(f.project, () => writeFileSync(f.state, "- **Status**: Completed\n"));
      return 0;
    }, () => {
      if (bootstrap) process.stdout.write(bootstrap);
      return 0;
    }));
    expect(result).toEqual({ code: 0, out: "One-time setup notice.", err: "" });
  });
});
