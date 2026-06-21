// t180-kiro-rollforward-seam: deterministic coverage for the two halves of the
// Kiro read-only/navigation roll-forward seam in
// harness/kiro/hooks/aidlc-kiro-adapter.ts (shipped as
// dist/kiro/.kiro/hooks/aidlc-kiro-adapter.ts):
//
//   verb-intercept (userPromptSubmit) — bumps the per-turn counter
//     aidlc/.aidlc-turn-counter EVERY turn, and on a TERMINAL command
//     (read-only flag / workspace verb) stamps aidlc/.aidlc-readonly-latch
//     {turn,flag,source,ts} + writes the SYSTEM dispatch relay to stdout.
//   pretool-block (preToolUse) — the hard floor: a TRULY BARE advancing
//     `aidlc-orchestrate.ts next` while the latch is fresh-for-this-turn
//     (latch.turn === counter) → exit 2 (Kiro BLOCK). Any deliberate move
//     (advancing flag), a stale latch, or no latch at all → exit 0 (inert).
//
// covers: file:harness/kiro/hooks/aidlc-kiro-adapter.ts
//
// WHY SUBPROCESS. The seam IS a subprocess shim — it reads/writes files under
// <cwd>/aidlc/ and signals Kiro purely via stdout + exit code. In-process
// testing would bypass the exact surface being contracted. No live LLM: the
// verb-intercept args are recovered deterministically from the expanded prompt
// body (the `aidlc-orchestrate.ts next <ARGS>` forwarding anchor), and
// pretool-block reads only the counter/latch files we seed.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const KIRO_TREE = join(REPO_ROOT, "dist", "kiro", ".kiro");

// A scratch project: the .kiro tree (so verb-intercept's aidlc-utility.ts
// subprocess + the adapter path resolve) + an empty aidlc/ roof. The seam
// writes the counter/latch under aidlc/ itself.
function scratchProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "t180-"));
  cpSync(KIRO_TREE, join(dir, ".kiro"), { recursive: true });
  mkdirSync(join(dir, "aidlc"), { recursive: true });
  return dir;
}

function runAdapter(
  projectDir: string,
  target: string,
  payload: unknown,
): { stdout: string; code: number } {
  const r = spawnSync("bun", [join(projectDir, ".kiro", "hooks", "aidlc-kiro-adapter.ts"), target], {
    cwd: projectDir,
    input: typeof payload === "string" ? payload : JSON.stringify(payload),
    encoding: "utf-8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
    timeout: 30_000,
  });
  return { stdout: r.stdout ?? "", code: r.status ?? -1 };
}

// Build an expanded-prompt body carrying the forwarding-loop anchor the seam
// recovers args from: `… aidlc-orchestrate.ts next <ARGS>` inside a backtick
// code span (exactly what Kiro substitutes $ARGUMENTS into).
function promptWithNext(args: string): string {
  return `Step 1: run \`bun .kiro/tools/aidlc-orchestrate.ts next ${args}\` and relay the output.`;
}

const counterPath = (dir: string) => join(dir, "aidlc", ".aidlc-turn-counter");
const latchPath = (dir: string) => join(dir, "aidlc", ".aidlc-readonly-latch");

describe("t180 verb-intercept turn-clock + read-only/nav latch", () => {
  test("1: read-only flag (--status) bumps counter to 1 and stamps the read-only-flag latch", () => {
    const dir = scratchProject();
    try {
      const r = runAdapter(dir, "verb-intercept", { prompt: promptWithNext("--status"), cwd: dir });
      expect(r.code).toBe(0);
      // SYSTEM dispatch relay is on stdout (conductor relays, never advances).
      expect(r.stdout).toContain("SYSTEM (deterministic harness dispatch)");
      expect(r.stdout).toContain("/aidlc --status");
      // Turn-clock bumped to 1.
      expect(existsSync(counterPath(dir))).toBe(true);
      expect(readFileSync(counterPath(dir), "utf-8").trim()).toBe("1");
      // Latch stamped at turn 1, source read-only-flag.
      expect(existsSync(latchPath(dir))).toBe(true);
      const latch = JSON.parse(readFileSync(latchPath(dir), "utf-8")) as {
        turn?: number;
        flag?: string;
        source?: string;
      };
      expect(latch.turn).toBe(1);
      expect(latch.source).toBe("read-only-flag");
      expect(latch.flag).toBe("status");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("2: workspace verb (space-create teamB) stamps the workspace-verb latch", () => {
    const dir = scratchProject();
    try {
      const r = runAdapter(dir, "verb-intercept", { prompt: promptWithNext("space-create teamB"), cwd: dir });
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("SYSTEM (deterministic harness dispatch)");
      expect(readFileSync(counterPath(dir), "utf-8").trim()).toBe("1");
      const latch = JSON.parse(readFileSync(latchPath(dir), "utf-8")) as {
        turn?: number;
        flag?: string;
        source?: string;
      };
      expect(latch.turn).toBe(1);
      expect(latch.source).toBe("workspace-verb");
      expect(latch.flag).toBe("space-create teamB");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("3: non-terminal freeform next bumps the counter but stamps NO latch", () => {
    const dir = scratchProject();
    try {
      const r = runAdapter(dir, "verb-intercept", { prompt: promptWithNext("build an auth service"), cwd: dir });
      // cmd === null → silent exit 0, conductor handles it; clock still advanced.
      expect(r.code).toBe(0);
      expect(r.stdout.trim()).toBe("");
      expect(existsSync(counterPath(dir))).toBe(true);
      expect(readFileSync(counterPath(dir), "utf-8").trim()).toBe("1");
      // No terminal command this turn → no latch.
      expect(existsSync(latchPath(dir))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("t180 pretool-block roll-forward backstop (exit-code contract)", () => {
  // Seed the counter + latch under aidlc/ directly; pretool-block reads them.
  function seedClock(dir: string, counter: number, latchTurn: number | null): void {
    writeFileSync(counterPath(dir), `${counter}\n`, "utf-8");
    if (latchTurn !== null) {
      writeFileSync(
        latchPath(dir),
        `${JSON.stringify({ turn: latchTurn, flag: "status", source: "read-only-flag", ts: 1 })}\n`,
        "utf-8",
      );
    }
  }
  const BARE_NEXT = "bun .kiro/tools/aidlc-orchestrate.ts next";

  test("4: fresh latch (turn===counter) + bare advancing next → exit 2 (BLOCK)", () => {
    const dir = scratchProject();
    try {
      seedClock(dir, 3, 3);
      const r = runAdapter(dir, "pretool-block", { tool_input: { command: BARE_NEXT }, cwd: dir });
      expect(r.code).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("5: fresh latch + deliberate `next --stage foo` → exit 0 (exempt)", () => {
    const dir = scratchProject();
    try {
      seedClock(dir, 3, 3);
      const r = runAdapter(dir, "pretool-block", {
        tool_input: { command: `${BARE_NEXT} --stage foo` },
        cwd: dir,
      });
      expect(r.code).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("6: STALE latch (turn === counter-1) + bare next → exit 0 (not fresh)", () => {
    const dir = scratchProject();
    try {
      seedClock(dir, 3, 2);
      const r = runAdapter(dir, "pretool-block", { tool_input: { command: BARE_NEXT }, cwd: dir });
      expect(r.code).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("7: NO latch files + bare next → exit 0 (fail-open / inert)", () => {
    const dir = scratchProject();
    try {
      // aidlc/ exists but no counter and no latch were ever written.
      const r = runAdapter(dir, "pretool-block", { tool_input: { command: BARE_NEXT }, cwd: dir });
      expect(r.code).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
