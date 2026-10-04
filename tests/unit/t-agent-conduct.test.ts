// covers: function:FILE_TOOLS_RULE function:AS_ITS_OWN_COMMAND
//
// t-agent-conduct: every AI-DLC agent does file work with its file tools and
// runs AI-DLC's commands as printed. The wording has one owner,
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

  test("the diary bootstrap uses the write tool, not a shell mkdir", () => {
    const conductor = readFileSync(join(REPO_ROOT, "core", "aidlc-common", "conductor.md"), "utf-8");
    expect(conductor).not.toContain("mkdir -p");
    expect(conductor).toContain("create it with your file-write tool");
  });
});
