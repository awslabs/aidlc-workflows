import {
  currentHookWorkflow, hookWorkflowIsInactive, isTerminalWorkflow,
  runInHookWorkflow, withAuditLock, type HookWorkflow,
} from "./aidlc-lib.ts";
import { AsyncLocalStorage } from "node:async_hooks";

interface HookResponse {
  code: number;
  out: string[];
  err: string[];
  refused: boolean;
}

const responses = new AsyncLocalStorage<{ refused: boolean }>();

// Some hosts encode a denial in JSON with exit 0. Their adapter marks that
// typed decision here instead of asking the shared publisher to inspect prose
// or guess a host's output schema.
export function noteHookRefusal(): void {
  const response = responses.getStore();
  if (response) response.refused = true;
}

// Hooks run serially within one adapter process. Every capture restores the
// caller's streams, including nested adapter/core captures and thrown errors.
async function capture(evaluate: () => number | Promise<number>): Promise<HookResponse> {
  const stdout = process.stdout.write;
  const stderr = process.stderr.write;
  const out: string[] = [];
  const err: string[] = [];
  const text = (chunk: unknown): string =>
    typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString("utf-8");
  process.stdout.write = ((chunk: unknown) => { out.push(text(chunk)); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown) => { err.push(text(chunk)); return true; }) as typeof process.stderr.write;
  try {
    const decision = { refused: false };
    const code = await responses.run(decision, evaluate);
    return { code, out, err, refused: decision.refused };
  } finally {
    process.stdout.write = stdout;
    process.stderr.write = stderr;
  }
}

function publish(response: HookResponse): number {
  if (response.refused || response.code === 2) noteHookRefusal();
  if (response.out.length > 0) process.stdout.write(response.out.join(""));
  if (response.err.length > 0) process.stderr.write(response.err.join(""));
  return response.code;
}

// The independent callback owns runtime-integrity/checkout refusals and
// bootstrap notices. Its scope forbids workflow mutations, including nested
// callbacks and trusted hook children. A refusal from this channel never waits
// for the workflow lock. Only active-workflow output needs publication admission.
export async function publishHookOutput(
  projectDir: string,
  workflow: HookWorkflow,
  evaluate: () => number | Promise<number>,
  independent: () => number | Promise<number> = () => 0,
): Promise<number> {
  const independentChecks = () => runInHookWorkflow(projectDir, {
    ...workflow, mode: "independent",
  }, independent);
  if (hookWorkflowIsInactive(workflow) || currentHookWorkflow(projectDir)?.mode === "independent") {
    return independentChecks();
  }
  // Guard refusals remain independent of bookkeeping or publication failures.
  const before = await capture(independentChecks);
  if (before.code !== 0 || before.refused) return publish(before);
  if (workflow.selection === null) return evaluate();

  const response = await capture(evaluate);
  let entered = false;
  let published = false;
  try {
    published = withAuditLock(projectDir, () => {
      entered = true;
      if (isTerminalWorkflow(projectDir, workflow.selection!)) return false;
      publish(response);
      return true;
    }, undefined, undefined, 5, 25);
  } catch (error) {
    if (entered) throw error; // A failed output sink is not lock contention.
    // Unadmitted workflow context is withheld. Independent checks still run;
    // acquisition failure must never replace their refusal with exit 1.
  }
  // Re-read independent data after evaluation: a SessionStart child may have
  // produced a one-time setup notice while its workflow context became stale.
  return published ? response.code : independentChecks();
}
