// t293-kiro-unified-adapter: the contract the unified Kiro adapter adds on top
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
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_RECORD_DIR,
  DEFAULT_SPACE,
  intentsDirOf,
  seededRecordDir,
  seededStateFile,
} from "../harness/fixtures.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TREE = join(REPO_ROOT, "dist", "kiro-unified");

const projects: string[] = [];

function freshProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "aidlc-t293-"));
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

describe("t293 kiro-unified adapter — verb-intercept (UserPromptSubmit)", () => {
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

describe("t293 kiro-unified adapter — payload acquisition for the PreToolUse guards", () => {
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

  // review-freeze reads a nested `operations[]` off an fs_write payload, and it
  // fires on EVERY write rather than only on a dispatch, so a throw there blocks
  // more than the plan-approval crash did. The envelope validation the adapter
  // does on parse covers `toolArgs` itself, never what is inside it.
  test("review-freeze drops a malformed operations member instead of throwing", () => {
    const project = freshProject();
    const run = runAdapter(project, "review-freeze", {
      tool_name: "fs_write",
      tool_input: { operations: [null] },
    });

    expect(run.status).toBe(0);
    expect(run.stderr).not.toContain("TypeError");
  });

  test("review-freeze survives a non-array operations", () => {
    const project = freshProject();
    const run = runAdapter(project, "review-freeze", {
      tool_name: "fs_write",
      tool_input: { operations: "oops" },
    });

    expect(run.status).toBe(0);
    expect(run.stderr).not.toContain("TypeError");
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

// The plan-approval guard reads the DISPATCH payload, and on this tree the
// dispatched agent's identity arrives in one of two places depending on the shape
// the runtime sends: the tool-name suffix (`subagent_<agent>`, the shape measured
// on both surfaces) or `stages[].role` (the crew shape, kept as a fallback). Each
// is a seam whose failure mode is SILENCE — a shape the adapter does not
// recognise exits 0 and the unapproved dispatch proceeds — so each is pinned here
// rather than left to a probe. t147 test 1b is the same contract for `dist/kiro`.
describe("t293 kiro-unified adapter — plan-approval guard (PreToolUse)", () => {
  const DEV_PROMPT = "AIDLC-UNIT: todo-core\nImplement todo-core";
  const DEV_STAGE = {
    name: "implement_todo_core",
    role: "aidlc-developer-agent",
    prompt_template: DEV_PROMPT,
  };

  /** freshProject() + the per-intent shell with an unapproved code-generation
   *  stage, so the core guard's self-gate opens and a developer dispatch is
   *  refusable. Mirrors t147's seedShell + seedUnapprovedCodeGeneration. */
  function seededProject(): string {
    const project = freshProject();
    const intentsDir = intentsDirOf(project, DEFAULT_SPACE);
    mkdirSync(seededRecordDir(project), { recursive: true });
    writeFileSync(join(project, "aidlc", "active-space"), `${DEFAULT_SPACE}\n`, "utf-8");
    writeFileSync(join(intentsDir, "active-intent"), `${DEFAULT_RECORD_DIR}\n`, "utf-8");
    writeFileSync(
      join(intentsDir, "intents.json"),
      `${JSON.stringify(
        [
          {
            uuid: "00000000-0000-7000-8000-000000000001",
            slug: DEFAULT_RECORD_DIR.replace(/-[0-9a-f]+$/, ""),
            status: "in-flight",
          },
        ],
        null,
        2,
      )}\n`,
      "utf-8",
    );
    const state = readFileSync(
      join(REPO_ROOT, "tests", "fixtures", "state-brownfield-feature.md"),
      "utf-8",
    ).replace(/(- \*\*Current Stage\*\*:\s*)[^\n]+/, "$1code-generation");
    writeFileSync(seededStateFile(project), state, "utf-8");
    mkdirSync(join(seededRecordDir(project), "construction", "todo-core", "code-generation"), {
      recursive: true,
    });
    return project;
  }

  test("the suffixed dispatch shape blocks an unapproved developer stage", () => {
    const run = runAdapter(seededProject(), "plan-approval-guard", {
      hook_event_name: "preToolUse",
      tool_name: "subagent_aidlc-developer-agent",
      tool_input: { prompt: DEV_PROMPT },
    });

    expect(run.status).toBe(2);
    expect(run.stderr).toContain("plan-approval guard");
  });

  test("the crew shape blocks too — identity comes from stages[].role", () => {
    const run = runAdapter(seededProject(), "plan-approval-guard", {
      hook_event_name: "preToolUse",
      tool_name: "subagent",
      tool_input: { task: DEV_PROMPT, stages: [DEV_STAGE] },
    });

    expect(run.status).toBe(2);
    expect(run.stderr).toContain("plan-approval guard");
  });

  test("a crew dispatch with no developer stage is allowed", () => {
    const run = runAdapter(seededProject(), "plan-approval-guard", {
      hook_event_name: "preToolUse",
      tool_name: "subagent",
      tool_input: {
        task: DEV_PROMPT,
        stages: [{ name: "review", role: "aidlc-architecture-reviewer-agent" }],
      },
    });

    expect(run.status).toBe(0);
  });

  // A malformed member must not crash. This hook's non-zero exit is documented as
  // BLOCKING, so a throw would turn bad input into a hard block on EVERY subagent
  // dispatch with a stack trace as the reason. Dropping the member lands on the
  // same fail-open the core guard already commits to for malformed stdin.
  test("a malformed stages member is dropped, not a crash", () => {
    const run = runAdapter(seededProject(), "plan-approval-guard", {
      hook_event_name: "preToolUse",
      tool_name: "subagent",
      tool_input: { stages: [null] },
    });

    expect(run.status).toBe(0);
    expect(run.stderr).not.toContain("TypeError");
  });

  // ...and dropping it must not disarm the guard: a well-formed developer stage
  // next to the malformed ones still blocks.
  test("a malformed member alongside a developer stage still blocks", () => {
    const run = runAdapter(seededProject(), "plan-approval-guard", {
      hook_event_name: "preToolUse",
      tool_name: "subagent",
      tool_input: {
        task: DEV_PROMPT,
        stages: [null, "not-an-object", { role: 42 }, DEV_STAGE],
      },
    });

    expect(run.status).toBe(2);
    expect(run.stderr).toContain("plan-approval guard");
  });
});

// On an agent-v1 JSON tree the conductor config genuinely embeds the hook wiring,
// so doctor's `agents/aidlc.json present` row covers it. On THIS tree the wiring
// is the standalone manifests, and doctor's two Markdown-conductor rows are the
// only thing that looks at them — a row whose failure mode is a healthy report on
// a tree that would not fire a single hook. Each row is pinned in both directions.
describe("t293 kiro-unified adapter — doctor's Markdown-conductor hook rows", () => {
  function runDoctor(project: string): AdapterRun {
    const result = spawnSync(
      process.execPath,
      [join(project, ".kiro", "tools", "aidlc-utility.ts"), "doctor"],
      { cwd: project, encoding: "utf-8", timeout: 120_000 },
    );
    return {
      status: result.status ?? -1,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    };
  }

  const hooksDirOf = (project: string) => join(project, ".kiro", "hooks");

  function removeManifests(project: string): void {
    const dir = hooksDirOf(project);
    for (const f of readdirSync(dir)) {
      if (f.startsWith("aidlc-") && f.endsWith(".json")) rmSync(join(dir, f));
    }
  }

  test("a shipped tree reports both hook rows green", () => {
    const run = runDoctor(freshProject());

    expect(run.stdout).toContain("standalone hooks/aidlc-*.json manifest(s) wired");
    expect(run.stdout).toContain("every wired manifest dispatches a shipped hook script");
    expect(run.stdout).not.toContain("0 standalone");
  });

  test("deleting every manifest fails the wired row", () => {
    const project = freshProject();
    removeManifests(project);
    const run = runDoctor(project);

    expect(run.stdout).toContain("0 standalone hooks/aidlc-*.json manifest(s) wired");
    // Row 2 is vacuous with nothing wired, so the wired row is the whole signal.
    expect(run.stdout).not.toContain("every wired manifest dispatches a shipped hook script");
  });

  // The row counts the framework's OWN manifests. Counting every `*.json` let an
  // unrelated file a project drops next to them carry the row green with all
  // twelve deleted — an inert roster reading healthy.
  test("an unrelated .json does not stand in for the roster", () => {
    const project = freshProject();
    removeManifests(project);
    writeFileSync(
      join(hooksDirOf(project), "unrelated.json"),
      `${JSON.stringify({ version: "v1", hooks: [] })}\n`,
      "utf-8",
    );
    const run = runDoctor(project);

    expect(run.stdout).toContain("0 standalone hooks/aidlc-*.json manifest(s) wired");
  });

  // All twelve manifests dispatch through the adapter, so the adapter IS the
  // script row 2 resolves. Removing it fails two rows: the pre-existing
  // `aidlc-kiro-adapter.ts present` one and this new resolve row.
  test("a manifest dispatching a script that does not ship fails the resolve row", () => {
    const project = freshProject();
    rmSync(join(hooksDirOf(project), "aidlc-kiro-adapter.ts"));
    const run = runDoctor(project);

    expect(run.stdout).toContain("manifest dispatches a missing hook script");
    expect(run.stdout).toContain("aidlc-kiro-adapter.ts");
    expect(run.stdout).not.toContain("every wired manifest dispatches a shipped hook script");
  });
});
