// covers: hook:aidlc-continue-workflow
//
// t195 - the pending-compose Stop-hook carve-out (tier 2b).
//
// An IN-FLIGHT compose proposal's approve/edit/reject gate is a turn-stop like
// a stage gate, but it has no [?]/[R] checkbox signal: the hook's bare-`next`
// probe sees the pending run-stage and would BLOCK the turn - shoving the
// conductor back into stage execution mid-compose. The carve-out is
// POSITIVE-CONFIRMATION via the engine's own record: `next compose` publishes
// its step as the open compose question (the step on record, ask type
// compose, bound to the state it was asked on), and composeGateOpen reads it.
// The agent writes no file for it.
//
// Cases (the t121 mock-engine pattern - the hook spawns the project's own
// tools/aidlc-orchestrate.ts, which here is a one-line mock), through every
// harness tree's Stop hook:
//   1. question open + pending run-stage          -> ALLOW (the carve-out)
//   2. no question + pending run-stage            -> BLOCK (nothing weakened)
//   3. question open + AUTONOMOUS construction, a run nobody attends
//                                                 -> BLOCK (nobody answers the gate)
//   3b. question open + AUTONOMOUS construction, a person there
//                                                 -> ALLOW (they answer it; without
//                                                    it -> BLOCK)
//   4. the state moved on after it was asked (the approval's recompose)
//                                                 -> BLOCK again
//   5. only the file an earlier version had the agent write
//                                                 -> BLOCK, and the file is left alone
//
// Mechanism: cli - stdin JSON + env + stdout decision, exactly t121's seam.

import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";
import { setDefaultTimeout, afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_RECORD_DIR,
  DEFAULT_SPACE,
  intentsDirOf,
  seededAuditDir,
  seededRecordDir,
  seededStateFile,
} from "../harness/fixtures.ts";
import {
  COMPOSE_ASK_TYPE,
  composeGateOpen,
  stateDigest,
  writeActiveDirectiveMarker,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const BUN = process.execPath;
const REPO_ROOT = join(import.meta.dir, "..", "..");
// Every harness tree's Stop hook: each harness's own Stop seam reaches this core hook.
const TREES: Array<{ harness: string; dir: string }> = [
  { harness: "claude", dir: ".claude" },
  { harness: "codex", dir: ".codex" },
  { harness: "cursor", dir: ".cursor" },
  { harness: "kiro", dir: ".kiro" },
  { harness: "kiro-ide", dir: ".kiro" },
  { harness: "opencode", dir: ".aidlc" },
  { harness: "copilot", dir: ".aidlc" },
];

const PINNED_CLONE_ID = "testcloneid195";
function pinnedShardPath(proj: string): string {
  const host =
    hostname()
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "host";
  return join(seededAuditDir(proj), `${host}-${PINNED_CLONE_ID}.md`);
}

const MOCK_ENGINE = `console.log(JSON.stringify({ kind: "run-stage", stage: "requirements-analysis" }));
process.exit(0);
`;

const tempDirs: string[] = [];
afterAll(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

function makeProject(dir: string): string {
  const proj = mkdtempSync(join(tmpdir(), "aidlc-t195-"));
  tempDirs.push(proj);
  mkdirSync(join(proj, dir, "tools"), { recursive: true });
  writeFileSync(join(proj, dir, "tools", "aidlc-orchestrate.ts"), MOCK_ENGINE, "utf-8");
  const intentsDir = intentsDirOf(proj, DEFAULT_SPACE);
  mkdirSync(join(proj, "aidlc", "spaces", DEFAULT_SPACE, "memory"), { recursive: true });
  mkdirSync(seededRecordDir(proj), { recursive: true });
  writeFileSync(join(proj, "aidlc", "active-space"), `${DEFAULT_SPACE}\n`, "utf-8");
  writeFileSync(join(intentsDir, "active-intent"), `${DEFAULT_RECORD_DIR}\n`, "utf-8");
  writeFileSync(
    join(intentsDir, "intents.json"),
    `${JSON.stringify([{ uuid: "00000000-0000-7000-8000-000000000001", slug: DEFAULT_RECORD_DIR.replace(/-[0-9a-f]+$/, ""), status: "in-flight" }], null, 2)}\n`,
    "utf-8",
  );
  writeFileSync(join(proj, "aidlc", ".aidlc-clone-id"), `${PINNED_CLONE_ID}\n`, "utf-8");
  mkdirSync(seededAuditDir(proj), { recursive: true });
  writeFileSync(pinnedShardPath(proj), "audit row 1\n", "utf-8");
  return proj;
}

function seedActive(proj: string, opts: { autonomy?: string } = {}): void {
  const autonomyLine = opts.autonomy
    ? `- **Construction Autonomy Mode**: ${opts.autonomy}\n`
    : "";
  writeFileSync(
    seededStateFile(proj),
    `- **Workflow**: feature\n- **Scope**: feature\n- **Current Stage**: requirements-analysis\n${autonomyLine}`,
    "utf-8",
  );
}

// The open compose question as `next compose` publishes it: the step on
// record, bound to the state it was asked on, written by the engine's own
// publisher.
function askCompose(proj: string): void {
  const previous = process.env.CLAUDE_PROJECT_DIR;
  process.env.CLAUDE_PROJECT_DIR = proj;
  try {
    writeActiveDirectiveMarker(proj, {
      kind: "ask",
      ask_type: COMPOSE_ASK_TYPE,
      stage: "requirements-analysis",
      state_sha256: stateDigest(readFileSync(seededStateFile(proj), "utf-8")),
    });
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = previous;
  }
  expect(composeGateOpen(proj)).toBe(true);
}

const OLD_FILE = (proj: string): string => join(proj, "aidlc", ".aidlc-compose-pending");

// A run nobody attends by default: there the block and this carve-out still
// decide (an attended, gated run ends its turn whether or not a compose gate is
// open). Under autonomous Construction a person who is there decides with it.
function runHook(tree: { harness: string; dir: string }, proj: string, unattended = true): { rc: number; out: string } {
  const res = spawnSync(BUN, [join(REPO_ROOT, "dist", tree.harness, tree.dir, "hooks", "aidlc-continue-workflow.ts")], {
    cwd: proj,
    input: JSON.stringify({ stop_hook_active: false }),
    encoding: "utf-8",
    env: {
      ...(process.env as Record<string, string>),
      CLAUDE_PROJECT_DIR: proj,
      AIDLC_PROJECT_DIR: proj,
      CLAUDE_CODE_STOP_HOOK_BLOCK_CAP: "",
      AIDLC_UNATTENDED: unattended ? "1" : "0",
    },
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  return { rc: res.status ?? -1, out: (res.stdout ?? "").trim() };
}

describe.each(TREES)("t195 pending-compose Stop-hook carve-out (tier 2b), $harness", (tree) => {
  const project = (opts: { autonomy?: string } = {}): string => {
    const proj = makeProject(tree.dir);
    seedActive(proj, opts);
    return proj;
  };

  test("1: the compose question open + pending run-stage -> ALLOW (the turn ends at the compose gate)", () => {
    const proj = project();
    askCompose(proj);
    const r = runHook(tree, proj);
    expect(r.rc).toBe(0);
    expect(r.out).not.toContain('"decision":"block"');
    expect(existsSync(OLD_FILE(proj))).toBe(false);
  });

  test("2: no question + pending run-stage -> BLOCK (enforcement not weakened)", () => {
    const proj = project();
    const r = runHook(tree, proj);
    expect(r.out).toContain('"decision":"block"');
  });

  test("3: the question open under AUTONOMOUS construction in a run nobody attends -> BLOCK", () => {
    const proj = project({ autonomy: "autonomous" });
    askCompose(proj);
    const r = runHook(tree, proj);
    expect(r.out).toContain('"decision":"block"');
  });

  // The person asked to reshape the plan while Construction runs by itself:
  // the composer's proposal waits for their answer, so the turn ends at it.
  test("3b: the question open under AUTONOMOUS construction with a person there -> ALLOW", () => {
    const proj = project({ autonomy: "autonomous" });
    expect(runHook(tree, proj, false).out).toContain('"decision":"block"');
    askCompose(proj);
    const r = runHook(tree, proj, false);
    expect(r.rc).toBe(0);
    expect(r.out).not.toContain('"decision":"block"');
  });

  test("4: once the state moves on (the approval's recompose), the question is closed -> BLOCK again", () => {
    const proj = project();
    askCompose(proj);
    expect(runHook(tree, proj).out).not.toContain('"decision":"block"');
    writeFileSync(seededStateFile(proj), `${readFileSync(seededStateFile(proj), "utf-8")}- **Last Recomposed**: now\n`, "utf-8");
    const r = runHook(tree, proj);
    expect(r.out).toContain('"decision":"block"');
  });

  test("5: only the file an earlier version had the agent write -> BLOCK, and the file is left where it is", () => {
    const proj = project({ autonomy: "autonomous" });
    writeFileSync(OLD_FILE(proj), "pending\n", "utf-8");
    const r = runHook(tree, proj, false);
    expect(r.rc).toBe(0);
    expect(r.out).toContain('"decision":"block"');
    expect(existsSync(OLD_FILE(proj))).toBe(true);
  });
});
