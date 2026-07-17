// t180-kiro-rollforward-seam: deterministic coverage for the two halves of the
// Kiro read-only/navigation roll-forward seam in
// harness/kiro/hooks/aidlc-kiro-adapter.ts (shipped as
// dist/kiro/.kiro/hooks/aidlc-kiro-adapter.ts):
//
//   verb-intercept (userPromptSubmit) — bumps the per-turn counter
//     aidlc/.aidlc-turn-counter EVERY turn, and on a TERMINAL command
//     (read-only flag / workspace verb) stamps aidlc/.aidlc-readonly-latch
//     {turn,flag,source,ts} + writes the SYSTEM dispatch relay to stdout.
//     Unambiguous compose/routing invocations are pre-dispatched with the exact
//     argv and their directive is injected; ambiguous freeform invocations
//     stamp the exact argv in aidlc/.aidlc-forwarding-latch.
//   pretool-block (preToolUse) — the hard floor: a TRULY BARE advancing
//     `aidlc-orchestrate.ts next` while the latch is fresh-for-this-turn
//     (latch.turn === counter) → exit 2 (Kiro BLOCK). Any deliberate move
//     (advancing flag), a stale latch, or no latch at all → exit 0 (inert). A
//     fresh forwarding latch rejects changed/dropped first-next arguments and
//     is consumed only by an exact shell-normalized match.
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
const forwardingPath = (dir: string) =>
  join(dir, "aidlc", ".aidlc-forwarding-latch");

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

  test("3: non-terminal freeform input stamps a turn-bound forwarding latch", () => {
    const dir = scratchProject();
    try {
      const raw = "build an auth service";
      const r = runAdapter(dir, "verb-intercept", {
        prompt: promptWithNext(raw),
        cwd: dir,
      });
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("SYSTEM (deterministic argument forwarding)");
      expect(r.stdout).toContain(
        `bun .kiro/tools/aidlc-orchestrate.ts next ${raw}`,
      );
      expect(existsSync(counterPath(dir))).toBe(true);
      expect(readFileSync(counterPath(dir), "utf-8").trim()).toBe("1");
      expect(existsSync(latchPath(dir))).toBe(false);
      const forwarding = JSON.parse(
        readFileSync(forwardingPath(dir), "utf-8"),
      ) as { turn?: number; raw?: string; args?: string[] };
      expect(forwarding.turn).toBe(1);
      expect(forwarding.raw).toBe(raw);
      expect(forwarding.args).toEqual(["build", "an", "auth", "service"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("3b: positional scope input stamps the complete forwarding vector", () => {
    const dir = scratchProject();
    try {
      const raw = 'bugfix "Fix duplicate todos"';
      const r = runAdapter(dir, "verb-intercept", {
        prompt: promptWithNext(raw),
        cwd: dir,
      });
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("SYSTEM (deterministic argument forwarding)");
      const forwarding = JSON.parse(
        readFileSync(forwardingPath(dir), "utf-8"),
      ) as { turn?: number; raw?: string; args?: string[] };
      expect(forwarding.turn).toBe(1);
      expect(forwarding.raw).toBe(raw);
      expect(forwarding.args).toEqual(["bugfix", "Fix duplicate todos"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("3c: fresh-workspace --scope input is pre-dispatched with exact argv", () => {
    const dir = scratchProject();
    try {
      const raw = '--scope feature "build auth across both repos"';
      const r = runAdapter(dir, "verb-intercept", {
        prompt: promptWithNext(raw),
        cwd: dir,
      });
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("SYSTEM (deterministic engine pre-dispatch)");
      expect(r.stdout).toContain('"kind":"print"');
      expect(r.stdout).toContain(
        "aidlc-utility.ts intent-birth --scope feature",
      );
      expect(existsSync(counterPath(dir))).toBe(true);
      expect(readFileSync(counterPath(dir), "utf-8").trim()).toBe("1");
      expect(existsSync(latchPath(dir))).toBe(false);
      expect(existsSync(forwardingPath(dir))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("3d: compose is pre-dispatched instead of relying on a guarded retry", () => {
    const dir = scratchProject();
    try {
      const r = runAdapter(dir, "verb-intercept", {
        prompt: promptWithNext(
          'compose "drop market research from this workflow"',
        ),
        cwd: dir,
      });
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("SYSTEM (deterministic engine pre-dispatch)");
      expect(r.stdout).toContain("Dispatch the composer agent");
      expect(existsSync(forwardingPath(dir))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("3e: explicit stage runner flags are pre-dispatched", () => {
    const dir = scratchProject();
    try {
      const r = runAdapter(dir, "verb-intercept", {
        prompt: promptWithNext(
          "--scope poc --stage requirements-analysis --single",
        ),
        cwd: dir,
      });
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("SYSTEM (deterministic engine pre-dispatch)");
      expect(r.stdout).toContain('"kind":"run-stage"');
      expect(r.stdout).toContain('"stage":"requirements-analysis"');
      expect(existsSync(forwardingPath(dir))).toBe(false);
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

  function seedForwarding(
    dir: string,
    counter: number,
    raw: string,
    args: string[],
  ): void {
    writeFileSync(counterPath(dir), `${counter}\n`, "utf-8");
    writeFileSync(
      forwardingPath(dir),
      `${JSON.stringify({ turn: counter, raw, args })}\n`,
      "utf-8",
    );
  }

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

  test("8: same-turn forwarding latch rejects a bare first next", () => {
    const dir = scratchProject();
    try {
      seedForwarding(
        dir,
        4,
        '--scope feature "build auth across both repos"',
        ["--scope", "feature", "build auth across both repos"],
      );
      const r = runAdapter(dir, "pretool-block", {
        tool_input: { command: BARE_NEXT },
        cwd: dir,
      });
      expect(r.code).toBe(2);
      expect(existsSync(forwardingPath(dir))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("9: exact first next consumes the forwarding latch", () => {
    const dir = scratchProject();
    try {
      const raw = '--scope feature "build auth across both repos"';
      seedForwarding(
        dir,
        4,
        raw,
        ["--scope", "feature", "build auth across both repos"],
      );
      const r = runAdapter(dir, "pretool-block", {
        tool_input: { command: `${BARE_NEXT} ${raw}` },
        cwd: dir,
      });
      expect(r.code).toBe(0);
      expect(existsSync(forwardingPath(dir))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("10: shell escaping normalizes before forwarding comparison", () => {
    const dir = scratchProject();
    try {
      const raw =
        '--scope poc "answer the question; continue without waiting"';
      seedForwarding(
        dir,
        4,
        raw,
        ["--scope", "poc", "answer the question; continue without waiting"],
      );
      const r = runAdapter(dir, "pretool-block", {
        tool_input: {
          command:
            `${BARE_NEXT} --scope poc answer\\ the\\ question\\;\\ continue\\ without\\ waiting`,
        },
        cwd: dir,
      });
      expect(r.code).toBe(0);
      expect(existsSync(forwardingPath(dir))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
