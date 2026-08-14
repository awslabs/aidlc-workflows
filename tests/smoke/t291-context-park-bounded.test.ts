// covers: doc:harness/claude/skills/aidlc/SKILL.md(context-park-bounded), doc:harness/codex/skills/aidlc/SKILL.md(context-park-bounded), doc:harness/copilot/skills/aidlc/SKILL.md(context-park-bounded), doc:harness/cursor/skills/aidlc/SKILL.md(context-park-bounded), doc:harness/kiro/skills/aidlc/SKILL.md(context-park-bounded), doc:harness/kiro-ide/skills/aidlc/SKILL.md(context-park-bounded), doc:harness/opencode/skills/aidlc/SKILL.md(context-park-bounded)
//
// t291: regression guard for issue #547 — the conductor parking a workflow on
// a SUBJECTIVE sense that "context is heavy". The orchestrator skill used to
// license parking "when you are running low on context mid-loop", which is an
// unmeasurable trigger: the conductor has no access to its own token count, so
// it guessed from conversation length. Reported in the field at 37% of a 1M
// window used (63% free) — while the framework's own statusline paints that
// same reading GREEN (core/hooks/aidlc-statusline.ts contextColor(): yellow at
// >=50, red at >=75). The cost is a forced /aidlc --resume handshake every one
// or two stages.
//
// Mechanism: none. There is no tool / process / argv seam — the subject IS the
// prose contract in the shipped orchestrator skills. The failure mode (an LLM
// parking on a hunch at runtime) is behavioural and no static test can observe
// it directly. What a static test CAN pin, and what this guard exists to hold,
// is that the unbounded licence does not silently regress back INTO the source
// and that the bounded replacement keeps a numeric floor. Zero LLM, zero
// tokens, zero subprocess.
//
// Assert against SOURCE (harness/), not dist/: source is the authored
// contract, and the dist projection is regenerated from it and guarded
// separately by the package.ts `--check` drift tests. Pinning source keeps
// this guard meaningful in a worktree where dist was not rebuilt.
//
// Design note: the positive pins are substring/regex matches on the load-
// bearing clause, not the full sentence, so ordinary copy-editing does not
// fail the guard while a removal of the bound does.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..");

// Every harness that ships an orchestrator SKILL.md. Kept as an explicit
// literal (not globbed) so that ADDING a harness without extending this guard
// surfaces here as a missing-file failure rather than a silent skip.
const HARNESSES = [
  "claude",
  "codex",
  "copilot",
  "cursor",
  "kiro",
  "kiro-ide",
  "opencode",
] as const;

function skillPath(harness: string): string {
  return join(REPO_ROOT, "harness", harness, "skills", "aidlc", "SKILL.md");
}

function readSkill(harness: string): string {
  const path = skillPath(harness);
  if (!existsSync(path)) throw new Error(`missing orchestrator skill: ${path}`);
  return readFileSync(path, "utf-8");
}

describe("t291 (smoke) parking for context needs a measured figure, not a feeling", () => {
  test("all seven orchestrator skills exist (no vacuous pass on a rename)", () => {
    for (const h of HARNESSES) {
      expect(existsSync(skillPath(h))).toBe(true);
    }
  });

  for (const harness of HARNESSES) {
    describe(`harness: ${harness}`, () => {
      test("does not license parking on 'running low on context'", () => {
        // The exact unbounded clause removed for #547.
        expect(readSkill(harness)).not.toContain("running low on context");
      });

      test("forbids parking on how context FEELS", () => {
        const t = readSkill(harness);
        expect(/do not park because context \*feels\* heavy/i.test(t)).toBe(true);
      });

      test("states the conductor cannot measure its own context window", () => {
        const t = readSkill(harness);
        expect(/cannot measure your own context window/i.test(t)).toBe(true);
      });

      test("binds context-parking to a surfaced numeric threshold", () => {
        const t = readSkill(harness);
        // A number must survive: a bound with no figure is not a bound. 80 is
        // the floor the issue asked for, and it sits above the statusline's own
        // red line (75), so the two can never contradict.
        expect(/at or above 80%/i.test(t)).toBe(true);
        expect(/only when the harness has actually surfaced a usage figure/i.test(t)).toBe(true);
      });

      test("tells the conductor to keep going when it has no figure", () => {
        const t = readSkill(harness);
        expect(/absent such a figure you have no grounds to park/i.test(t)).toBe(true);
      });

      test("still permits the user-initiated park (the fix removed a trigger, not the feature)", () => {
        const t = readSkill(harness);
        expect(/Park when the user wants to stop and continue later/i.test(t)).toBe(true);
        // And the anti-fabrication rule that makes parking the safe exit is intact.
        expect(t).toContain("Never advance or approve stages you did not actually run");
      });
    });
  }
});
