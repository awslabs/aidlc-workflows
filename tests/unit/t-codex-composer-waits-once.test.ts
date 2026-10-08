// covers: harness/codex/skills/aidlc/composer.md
//
// On Codex the lead waits for the composer helper through Codex's own wait tool,
// and every wait prints lines the person reads ("Waiting for <agent id>",
// "Finished waiting", "No agents completed yet"). Measured live on Codex 0.160:
// 28 such triplets in a 1 m 44 s compose. The Codex composer annex tells the lead
// to wait once, at the longest timeout the wait tool takes, so the person sees one
// line, not a screen of polling.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const WAIT_ONCE = /Wait for it with one wait call at the longest timeout the wait tool takes/;

describe("the Codex composer dispatch waits once", () => {
  test("the authored Codex composer annex tells the lead to wait once, never poll", () => {
    const body = readFileSync(join(REPO_ROOT, "harness", "codex", "skills", "aidlc", "composer.md"), "utf-8");
    expect(body).toMatch(WAIT_ONCE);
    expect(body).toMatch(/never poll in short waits/);
  });

  test("the shipped Codex composer annex carries the same sentence", () => {
    const body = readFileSync(join(REPO_ROOT, "dist", "codex", ".agents", "skills", "aidlc", "composer.md"), "utf-8");
    expect(body).toMatch(WAIT_ONCE);
  });
});
