// covers: file:aidlc-common/stages/construction/code-generation.md, file:aidlc-common/stages/construction/build-and-test.md, file:aidlc-common/protocols/stage-protocol.md, file:memory/org.md
//
// t317 - Defined quality targets remain binding during generation and are
// measured explicitly at the Build and Test approval gate.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../harness/fixtures.ts";

const CORE_ROOT = join(REPO_ROOT, "core");
const CLAUDE_ROOT = join(REPO_ROOT, "dist", "claude", ".claude");
const CLAUDE_ORG = join(
  REPO_ROOT,
  "dist",
  "claude",
  "aidlc",
  "spaces",
  "default",
  "memory",
  "org.md",
);

const FILES = {
  codeGeneration: "aidlc-common/stages/construction/code-generation.md",
  buildAndTest: "aidlc-common/stages/construction/build-and-test.md",
  stageProtocol: "aidlc-common/protocols/stage-protocol.md",
  org: "memory/org.md",
} as const;

function read(root: string, rel: string): string {
  return readFileSync(join(root, rel), "utf-8");
}

function assertQualityTargetGate(root: string, orgPath: string): void {
  const codeGeneration = read(root, FILES.codeGeneration);
  expect(codeGeneration).toContain(
    "Measurable quality targets from NFR Requirements, NFR Design, and the Testing\n" +
      "  Contract coverage floor are inputs, not suggestions.",
  );
  expect(codeGeneration).toContain(
    "NEVER relax, lower, or\n  disable a defined target, including threshold settings in test or build",
  );
  expect(codeGeneration).toContain(
    "The subagent must NEVER relax, lower, or disable a defined target",
  );

  const buildAndTest = read(root, FILES.buildAndTest);
  expect(buildAndTest).toContain(
    "every approved `## Testing Contract` in `code-generation-plan.md`",
  );
  expect(buildAndTest).toContain(
    "Target ID, Source, Expected, Actual, Evidence, Owning Stage, Verdict",
  );
  expect(buildAndTest).toContain(
    "`Pending` is allowed only while\n     Step 8 is being prepared",
  );
  expect(buildAndTest).toContain(
    "Run every applicable command from performance,\n" +
      "   security, contract, E2E, accessibility, and other generated instruction",
  );
  expect(buildAndTest).toContain(
    "A check may be deferred only when it requires a deployed or\n" +
      "   production-like environment",
  );
  expect(buildAndTest).toContain(
    "A deferred target remains `Unverified` and cannot contribute to a\n" +
      "   successful stage result.",
  );
  expect(buildAndTest).toContain(
    "**Failure predicate**: Build and Test has failed when any build or test command\n" +
      "fails OR any applicable target is `Not Met` or `Unverified`.",
  );
  expect(buildAndTest).toContain(
    "including loop-back, halt-and-ask, abort, and\n   accepted failure",
  );
  expect(buildAndTest).toContain(
    "Weakening, relaxing, lowering, or disabling a defined\n" +
      "quality target is never an acceptable fix.",
  );

  expect(read(root, FILES.stageProtocol)).toContain(
    "Relaxing, lowering, or disabling a previously defined quality target (e.g.\n" +
      "    a test coverage threshold) instead of meeting it",
  );
  expect(readFileSync(orgPath, "utf-8")).toContain(
    "Build and Test verifies defined coverage floors and affirmed quality targets;\n" +
      "they may not be weakened to make a step pass.",
  );
}

describe("t317 quality-target verification gate", () => {
  test("authored core carries the non-relaxation and target-verification rules", () => {
    assertQualityTargetGate(CORE_ROOT, join(CORE_ROOT, FILES.org));
  });

  test("Claude projection carries the same quality-target gate", () => {
    assertQualityTargetGate(CLAUDE_ROOT, CLAUDE_ORG);
  });
});
