// t291-kiro-unified-adapter: the contract the unified Kiro adapter adds on top
// of the shim t218 covers for the IDE tree. Two surfaces run this tree (Kiro IDE
// 1.x and Kiro CLI v3) and both deliver the hook context as JSON on stdin, so
// every case here pipes a captured payload shape and asserts the observable
// effect on disk, on stdout, or in the exit code.
//
// What is NEW here, and therefore what this file contracts:
//   - verb-intercept (UserPromptSubmit): a terminal `/aidlc` command runs
//     off-band, its output comes back with a do-NOT-advance instruction, and the
//     turn-scoped read-only latch + turn counter are stamped for the engine's
//     done-guard to read.
//   - the guards' membership in the adapter's payload-acquisition set. A guard
//     that reads the tool payload is inert unless the adapter acquires it, and
//     the failure is silent (exit 0, no refusal), so the negative control here
//     is a payload-less call.
//
// covers: file:hooks/aidlc-state-transition-guard.ts
//
// WHY SUBPROCESS. The adapter IS a subprocess shim; running it in-process would
// bypass the stdin/stdout/exit-code surface being contracted. Each case runs
// `bun <tree>/.kiro/hooks/aidlc-kiro-adapter.ts <target>` inside a throwaway copy
// of the shipped tree, which is also how the adapter resolves its project dir.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TREE = join(REPO_ROOT, "dist", "kiro-unified");

const projects: string[] = [];

function freshProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "aidlc-t291-"));
  cpSync(TREE, dir, { recursive: true });
  projects.push(dir);
  return dir;
}

type AdapterRun = { status: number; stdout: string; stderr: string };

function runAdapter(project: string, target: string, payload: unknown): AdapterRun {
  const result = spawnSync(
    process.execPath,
    [join(project, ".kiro", "hooks", "aidlc-kiro-adapter.ts"), target],
    {
      cwd: project,
      input: payload === undefined ? "" : JSON.stringify(payload),
      encoding: "utf-8",
      timeout: 60_000,
    },
  );
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function latch(project: string): Record<string, unknown> | null {
  const path = join(project, "aidlc", ".aidlc-readonly-latch");
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
}

function turnCounter(project: string): number | null {
  const path = join(project, "aidlc", ".aidlc-turn-counter");
  if (!existsSync(path)) return null;
  return Number.parseInt(readFileSync(path, "utf-8").trim(), 10);
}

beforeAll(() => {
  // Guards the whole file: without the built tree there is nothing to contract.
  expect(existsSync(join(TREE, ".kiro", "hooks", "aidlc-kiro-adapter.ts"))).toBe(true);
});

afterAll(() => {
  for (const dir of projects) rmSync(dir, { recursive: true, force: true });
});

describe("t291 kiro-unified adapter — verb-intercept (UserPromptSubmit)", () => {
  test("a read-only flag runs off-band and comes back with the do-not-advance instruction", () => {
    const project = freshProject();
    const run = runAdapter(project, "verb-intercept", { prompt: "/aidlc --status" });

    expect(run.status).toBe(0);
    expect(run.stdout).toContain("SYSTEM (deterministic harness dispatch)");
    expect(run.stdout).toContain("`/aidlc --status`");
    expect(run.stdout).toContain("Do NOT run `aidlc-orchestrate.ts next`");
    expect(run.stdout).toContain("--- OUTPUT ---");

    // The latch is what the engine's done-guard reads, and it is turn-scoped:
    // the stamped turn must equal the counter written in the same firing.
    const stamped = latch(project);
    expect(stamped).not.toBeNull();
    expect(stamped?.flag).toBe("status");
    expect(stamped?.source).toBe("read-only-flag");
    expect(stamped?.turn).toBe(1);
    expect(turnCounter(project)).toBe(1);
  });

  test("a workspace verb is intercepted too, and the latch records the verb", () => {
    const project = freshProject();
    const run = runAdapter(project, "verb-intercept", { prompt: "/aidlc space" });

    expect(run.status).toBe(0);
    expect(run.stdout).toContain("`/aidlc space`");
    const stamped = latch(project);
    expect(stamped?.flag).toBe("space");
    expect(stamped?.source).not.toBe("read-only-flag");
  });

  test("a non-terminal prompt advances the turn clock and arms no latch", () => {
    const project = freshProject();
    const run = runAdapter(project, "verb-intercept", {
      prompt: "/aidlc add a login form to the web app",
    });

    expect(run.status).toBe(0);
    expect(run.stdout).toBe("");
    expect(latch(project)).toBeNull();
    // The clock advances even here: it is what makes a previous turn's latch go
    // stale, so the neutralization can never outlive the turn that armed it.
    expect(turnCounter(project)).toBe(1);
  });

  test("an adjacent slash command is not intercepted", () => {
    const project = freshProject();
    const run = runAdapter(project, "verb-intercept", { prompt: "/aidlc-status" });

    expect(run.status).toBe(0);
    expect(run.stdout).toBe("");
    expect(latch(project)).toBeNull();
  });

  test("a payload with no prompt is a no-op, not a crash", () => {
    const project = freshProject();
    const run = runAdapter(project, "verb-intercept", { tool_name: "execute_bash" });

    expect(run.status).toBe(0);
    expect(run.stdout).toBe("");
    expect(latch(project)).toBeNull();
  });

  test("the latch goes stale as soon as the next turn fires", () => {
    const project = freshProject();
    runAdapter(project, "verb-intercept", { prompt: "/aidlc --status" });
    const armed = latch(project);
    runAdapter(project, "verb-intercept", { prompt: "/aidlc now build the thing" });

    // Same latch file, but the counter has moved past the turn it stamped - the
    // done-guard's `latch.turn === counter` test no longer holds.
    expect(latch(project)?.turn).toBe(armed?.turn as number);
    expect(turnCounter(project)).toBe(2);
    expect(latch(project)?.turn).not.toBe(turnCounter(project));
  });
});

describe("t291 kiro-unified adapter — payload acquisition for the PreToolUse guards", () => {
  test("a blocked aidlc-state.ts verb is refused with exit 2 and a stderr reason", () => {
    const project = freshProject();
    const run = runAdapter(project, "state-transition-guard", {
      tool_name: "execute_bash",
      tool_input: { command: "bun .kiro/tools/aidlc-state.ts advance --stage intent-capture" },
    });

    // Kiro's reject contract: exit 2 plus the reason on stderr blocks the call.
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("Direct aidlc-state.ts advance is blocked");
    expect(run.stderr).toContain("aidlc-orchestrate.ts report");
  });

  test("an unrelated shell command passes through", () => {
    const project = freshProject();
    const run = runAdapter(project, "state-transition-guard", {
      tool_name: "execute_bash",
      tool_input: { command: "echo hi" },
    });

    expect(run.status).toBe(0);
    expect(run.stderr).toBe("");
  });

  test("without an acquired payload the guard cannot refuse — the silent-inert failure mode", () => {
    const project = freshProject();
    // Same blocked verb as above, except the payload carries no arguments. This is
    // what the guard sees when its target is left out of the adapter's
    // payload-acquisition set: it runs, finds nothing to inspect, and allows.
    const run = runAdapter(project, "state-transition-guard", { tool_name: "execute_bash" });

    expect(run.status).toBe(0);
  });

  test("a non-shell tool is not forwarded at all", () => {
    const project = freshProject();
    const run = runAdapter(project, "state-transition-guard", {
      tool_name: "fs_write",
      tool_input: { path: "notes.md", text: "hello" },
    });

    expect(run.status).toBe(0);
  });
});
