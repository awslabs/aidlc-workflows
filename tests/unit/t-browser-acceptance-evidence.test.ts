// covers: file:aidlc-common/stages/construction/build-and-test.md, file:knowledge/aidlc-quality-agent/testing-guide.md
//
// A browser claim names where it ran, and only a real browser engine makes a
// browser target Met; a missing real-browser run is said once at the approval
// gate instead of failing the stage (#2489).

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../harness/fixtures.ts";

const ROOTS = {
  core: join(REPO_ROOT, "core"),
  "dist/claude": join(REPO_ROOT, "dist", "claude", ".claude"),
} as const;

function read(root: string, rel: string): string {
  return readFileSync(join(root, rel), "utf-8").replace(/\s+/g, " ");
}

describe.each(Object.entries(ROOTS))("browser acceptance evidence (%s)", (_name, root) => {
  const stage = (): string => read(root, "aidlc-common/stages/construction/build-and-test.md");

  test("every browser claim names where it ran, and only a real browser engine makes it Met", () => {
    expect(stage()).toContain(
      "Wherever this stage reports browser behavior as tested (a matrix row, a `cross-unit-traceability.md` entry, the summary, or the readiness assessment), name where the check ran: Node, a DOM emulator (jsdom, Happy DOM), or a real browser engine",
    );
    expect(stage()).toContain("so never call them browser or end-to-end evidence");
    expect(stage()).toContain(
      "Only a run in a real browser engine makes a target that requires behavior in a browser `Met`; without one, including when no browser can launch here, that target is `Unverified`.",
    );
  });

  test("a missing real-browser run adds no stop: it is said once at the approval gate", () => {
    expect(stage()).toContain(
      "One exception: a browser target whose only gap is that no real browser engine ran it is said at the approval gate (Step 12), not handled as a failure.",
    );
    expect(stage()).toContain(
      "was checked only in Node or a DOM emulator, say so once, in one line, naming what and where it ran",
    );
    expect(stage()).not.toContain("waives real-browser evidence");
  });

  test("the testing guide does not count a DOM-emulator journey as end to end", () => {
    const guide = read(root, "knowledge/aidlc-quality-agent/testing-guide.md");
    expect(guide).toContain("A browser workflow is end to end only when it runs in a real browser engine");
    expect(guide).toContain("A journey in Node or a DOM emulator (jsdom, Happy DOM) is an integration test");
  });
});
