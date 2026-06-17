// covers: hook:aidlc-statusline
//
// t168 — the P8 statusline ORIENTATION PREFIX. The statusline always tells the
// user which world they're in: `[AIDLC] <space> · <intent-slug> · <phase> …`.
// Two invisibility rules (vision §3 / §11.2) keep it out of the single-team
// user's face:
//   - the "<space> ·" segment renders ONLY when more than one space exists
//     (listSpaces() always reports at least the always-present "default", so a
//     single-team user — exactly one space — never sees the word "space");
//   - the intent SLUG renders whenever a per-intent record is active; on the
//     flat-legacy / pre-auto-birth layout activeIntent() returns null, so the
//     prefix is empty and the line reads exactly as it did before the move.
//
// WHY CLI (process-boundary, not in-process): the SUBJECT is a hook. The render
// runs at module top level on `await main()` and writes the painted line to
// stdout; the orientation prefix is built from the active-space/active-intent
// cursors + the on-disk registry, none reachable by importing a function. So
// this twin SPAWNS the real shipped hook with the workspace JSON on stdin (the
// same shape Claude Code pipes), exactly like t61's runStatusline helper.
//
// SEEDING the per-intent workspace layout: birthIntent() (aidlc-lib.ts) is the
// real deterministic primitive that mints a record dir under
// aidlc/spaces/<space>/intents/<slug>-<id8>/, appends the intents.json row, and
// sets the active-intent cursor — exactly the on-disk shape activeIntent()/
// listIntents()/orientationPrefix() read. We seed through it (not by hand) so
// the test tracks the real layout, then overwrite the record's aidlc-state.md
// with a phase-bearing body so the render reaches the orientation branch.
//
// Empty-state: a project with no record (no birth) hits the hook's :233 no-op
// gate (stateFilePath resolves the flat fallback, which is absent) and paints
// the bare "[AIDLC] ready" — proving the prefix never leaks onto the no-workflow
// line and the pre-auto-birth workspace renders cleanly, not an error.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  birthIntent,
  setActiveSpaceCursor,
  stateFilePath,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createTestProject,
} from "../harness/fixtures.ts";

const BUN = process.execPath; // the bun running this test
const HOOK = join(AIDLC_SRC, "hooks", "aidlc-statusline.ts");

let proj: string;

beforeEach(() => {
  proj = createTestProject();
});
afterEach(() => {
  cleanupTestProject(proj);
});

/** Spawn the per-shipped statusline hook with the workspace JSON on stdin. */
function runStatusline(p: string): string {
  const r = Bun.spawnSync({
    cmd: [BUN, HOOK],
    stdin: new TextEncoder().encode(JSON.stringify({ workspace: { project_dir: p } })),
    stdout: "pipe",
    stderr: "pipe",
  });
  return `${new TextDecoder().decode(r.stdout)}${new TextDecoder().decode(r.stderr)}`;
}

/**
 * Birth an intent in `space` and write a CONSTRUCTION-phase state body into its
 * record dir so the statusline reaches the orientation render branch. Returns
 * the born intent's slug. The state body mirrors the t61 seedState shape (a
 * phase + stage so phaseProgress/extractField resolve a non-"ready" line).
 */
function seedIntent(p: string, slug: string, space: string): void {
  const born = birthIntent(p, slug, space, "feature");
  // birthIntent leaves a header-only stub; overwrite with a phase-bearing body
  // (stateFilePath resolves the active intent's record dir → born.recordDir).
  writeFileSync(
    stateFilePath(p, born.dirName, space),
    `# AI-DLC State Tracking
## Current Status
- **Lifecycle Phase**: CONSTRUCTION
- **Current Stage**: ci-pipeline
- **Active Agent**: aidlc-developer-agent
- **Status**: Running
`,
    "utf-8",
  );
}

describe("t168 statusline orientation prefix (mechanism cli — spawned hook + per-intent seed)", () => {
  test("single space: shows the intent slug but NO space token (invisibility rule)", () => {
    // Default space only (listSpaces().length === 1) → the "<space> ·" segment
    // is suppressed; the intent slug still renders.
    seedIntent(proj, "auth-service", "default");
    const out = runStatusline(proj);
    expect(out).toContain("auth-service · CONSTRUCTION");
    // The single-team user never sees the word "space" or the "default ·" token.
    expect(out).not.toContain("default · auth-service");
  });

  test("two spaces: shows `<space> · <intent> · <phase>` once >1 space exists", () => {
    // Birth one intent in "default", then create a second space "teamB" with an
    // active intent and point both cursors at it. Now listSpaces().length === 2,
    // so the space token appears.
    seedIntent(proj, "checkout-flow", "default");
    seedIntent(proj, "export-bug", "teamB");
    setActiveSpaceCursor(proj, "teamB"); // active space → teamB
    const out = runStatusline(proj);
    // teamB's active intent is export-bug → "teamB · export-bug · CONSTRUCTION".
    expect(out).toContain("teamB · export-bug · CONSTRUCTION");
  });

  test("empty state (no record) paints the bare `[AIDLC] ready` — no prefix leak", () => {
    // No birth: stateFilePath resolves the flat fallback (absent) → the hook's
    // no-state gate paints "[AIDLC] ready", with no orientation prefix.
    const out = runStatusline(proj);
    expect(out).toContain("[AIDLC] ready");
    expect(out).not.toContain(" · ");
  });

  test("a record with no resolvable phase still paints bare `[AIDLC] ready` (graceful)", () => {
    // Birth leaves a header-only stub (no Lifecycle Phase) — the hook's !phase
    // gate fires BEFORE the orientation prefix is computed, so the no-workflow
    // line stays clean even with an active record.
    birthIntent(proj, "stub-only", "default");
    const out = runStatusline(proj);
    expect(out).toContain("[AIDLC] ready");
    expect(out).not.toContain("stub-only");
  });
});
