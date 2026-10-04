// covers: function:FILE_TOOLS_RULE function:AS_ITS_OWN_COMMAND
//
// t-agent-conduct: every AI-DLC agent writes files with its file tools, reads
// with them where it has them, and runs AI-DLC's commands as printed. The wording has one owner,
// FILE_TOOLS_RULE in core/tools/aidlc-testing-posture.ts; the engine's worker brief renders it
// (t-plan-approval-ask), and the three shared prose places that reach the
// conductor, every dispatched subagent prompt, and the reviewer carry it
// verbatim, here and in a packaged tree.
//
// Mechanism = none: pure file reads.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FILE_TOOLS_RULE } from "../../core/tools/aidlc-testing-posture.ts";
import { REPO_ROOT } from "../harness/fixtures.ts";

const PROSE = [
  "aidlc-common/conductor.md",
  "aidlc-common/protocols/stage-protocol-ensemble.md",
  "aidlc-common/protocols/stage-protocol-reviewer.md",
];

describe("t-agent-conduct", () => {
  test("the conductor, dispatch, and reviewer prose carry the one rule verbatim", () => {
    for (const rel of PROSE) {
      expect(readFileSync(join(REPO_ROOT, "core", rel), "utf-8"), rel).toContain(FILE_TOOLS_RULE);
      expect(readFileSync(join(REPO_ROOT, "dist", "claude", ".claude", rel), "utf-8"), `dist ${rel}`)
        .toContain(FILE_TOOLS_RULE);
    }
  });

  // Codex has no file-read tool: it reads through the shell, and the rule
  // must leave it a way to read.
  test("the Codex tree carries the rule, which leaves a shell-only reader one plain read", () => {
    for (const rel of PROSE) {
      expect(readFileSync(join(REPO_ROOT, "dist", "codex", ".codex", rel), "utf-8"), `codex ${rel}`)
        .toContain(FILE_TOOLS_RULE);
    }
    expect(FILE_TOOLS_RULE).toContain("where the shell is your only way to read, use one plain read command");
    // A subagent reads its own knowledge files with the file tool too, never
    // through a shell loop.
    expect(FILE_TOOLS_RULE).toContain("Read, list, and search (your own knowledge files included) with your file tools");
    expect(FILE_TOOLS_RULE).not.toMatch(/never through the shell[^.]*`(?:cat|ls|rg|grep|find)`/);
  });

  test("the diary bootstrap uses the write tool, not a shell mkdir", () => {
    const conductor = readFileSync(join(REPO_ROOT, "core", "aidlc-common", "conductor.md"), "utf-8");
    expect(conductor).not.toContain("mkdir -p");
    expect(conductor).toContain("create it with your file-write tool");
  });
});
