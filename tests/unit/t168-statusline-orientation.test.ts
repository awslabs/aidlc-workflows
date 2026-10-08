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
//     flat-legacy / pre-auto-create layout activeIntent() returns null, so the
//     prefix is empty and the line reads exactly as it did before the move.
//
// WHY CLI (process-boundary, not in-process): the SUBJECT is a hook. The render
// runs at module top level on `await main()` and writes the painted line to
// stdout; the orientation prefix is built from the active-space/active-intent
// cursors + the on-disk registry, none reachable by importing a function. So
// this twin SPAWNS the real shipped hook with the workspace JSON on stdin (the
// same shape Claude Code pipes), exactly like t61's runStatusline helper.
//
// SEEDING the per-intent workspace layout: createIntent() (aidlc-lib.ts) is the
// real deterministic primitive that mints a record dir under
// aidlc/spaces/<space>/intents/<slug>-<id8>/, appends the intents.json row, and
// sets the active-intent cursor — exactly the on-disk shape activeIntent()/
// listIntents()/orientationPrefix() read. We seed through it (not by hand) so
// the test tracks the real layout, then overwrite the record's aidlc-state.md
// with a phase-bearing body so the render reaches the orientation branch.
//
// Empty-state: a project with no record (no creation) hits the hook's :233 no-op
// gate (stateFilePath resolves the flat fallback, which is absent) and paints
// the bare "[AIDLC] ready" — proving the prefix never leaks onto the no-workflow
// line and the pre-auto-create workspace renders cleanly, not an error.

import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";
import { afterEach, beforeEach, describe, expect, test, setDefaultTimeout } from "bun:test";
import { mkdirSync, readFileSync, renameSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  createIntent,
  setActiveIntentCursor,
  setActiveSpaceCursor,
  stateFilePath,
  writeSessionBinding,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createTestProject,
} from "../harness/fixtures.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

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
function runStatusline(p: string, sessionId?: string): string {
  const r = Bun.spawnSync({
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    cmd: [BUN, HOOK],
    stdin: new TextEncoder().encode(JSON.stringify({
      workspace: { project_dir: p },
      ...(sessionId ? { session_id: sessionId } : {}),
    })),
    stdout: "pipe",
    stderr: "pipe",
  });
  return `${new TextDecoder().decode(r.stdout)}${new TextDecoder().decode(r.stderr)}`;
}

/**
 * Create an intent in `space` and write a CONSTRUCTION-phase state body into its
 * record dir so the statusline reaches the orientation render branch. Returns
 * the created intent's slug. The state body mirrors the t61 seedState shape (a
 * phase + stage so phaseProgress/extractField resolve a non-"ready" line).
 */
function seedIntent(p: string, slug: string, space: string): void {
  const created = createIntent(p, slug, space, "feature");
  // createIntent leaves a header-only stub; overwrite with a phase-bearing body
  // (stateFilePath resolves the active intent's record dir → created.recordDir).
  writeFileSync(
    stateFilePath(p, created.dirName, space),
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
    // Create one intent in "default", then create a second space "teamB" with an
    // active intent and point both cursors at it. Now listSpaces().length === 2,
    // so the space token appears.
    seedIntent(proj, "checkout-flow", "default");
    seedIntent(proj, "export-bug", "team-b");
    setActiveSpaceCursor(proj, "team-b"); // active space → team-b
    const out = runStatusline(proj);
    // team-b's active intent is export-bug → "team-b · export-bug · CONSTRUCTION".
    expect(out).toContain("team-b · export-bug · CONSTRUCTION");
  });

  test("empty state (no record) paints the bare `[AIDLC] ready` — no prefix leak", () => {
    // No creation: stateFilePath resolves the flat fallback (absent) → the hook's
    // no-state gate paints "[AIDLC] ready", with no orientation prefix.
    const out = runStatusline(proj);
    expect(out).toContain("[AIDLC] ready");
    expect(out).not.toContain(" · ");
  });

  test("a record with no resolvable phase still paints bare `[AIDLC] ready` (graceful)", () => {
    // Creation leaves a header-only stub (no Lifecycle Phase) - the hook's !phase
    // gate fires BEFORE the orientation prefix is computed, so the no-workflow
    // line stays clean even with an active record.
    createIntent(proj, "stub-only", "default");
    const out = runStatusline(proj);
    expect(out).toContain("[AIDLC] ready");
    expect(out).not.toContain("stub-only");
  });

  test("an archived cursor or lone record paints `[AIDLC] ready`", () => {
    seedIntent(proj, "retired-work", "default");
    const state = stateFilePath(proj);
    writeFileSync(
      state,
      readFileSync(state, "utf-8").replace("Status**: Running", "Status**: Archived"),
      "utf-8",
    );
    const out = runStatusline(proj);
    expect(out).toContain("[AIDLC] ready");
    expect(out).not.toContain("retired-work");
    expect(out).not.toContain("CONSTRUCTION");
  });

  test("an archived binding paints `[AIDLC] ready` beside a space-root workflow", () => {
    const created = createIntent(proj, "retired-work", "default", "feature");
    writeFileSync(
      stateFilePath(proj, created.dirName, "default"),
      "# AI-DLC State Tracking\n## Current Status\n- **Lifecycle Phase**: CONSTRUCTION\n- **Status**: Archived\n",
      "utf-8",
    );
    // A workflow at the space root, the selection a binding to no record also names.
    writeFileSync(
      join(proj, "aidlc", "spaces", "default", "intents", "aidlc-state.md"),
      "# AI-DLC State Tracking\n## Current Status\n- **Lifecycle Phase**: INCEPTION\n- **Current Stage**: requirements-analysis\n- **Status**: Running\n",
      "utf-8",
    );
    const session = "01995100-0000-7000-8000-000000000168";
    writeSessionBinding(proj, session, "default", created.dirName, "switch");
    expect(runStatusline(proj, session)).toContain("[AIDLC] ready");
    expect(runStatusline(proj, session)).not.toContain("INCEPTION");
    writeSessionBinding(proj, session, "default", null, "archive");
    expect(runStatusline(proj, session)).toContain("[AIDLC] ready");
    expect(runStatusline(proj, session)).not.toContain("INCEPTION");
    // A session that has chosen no record still sees the space-root workflow.
    writeSessionBinding(proj, session, "default", null, "none");
    expect(runStatusline(proj, session)).toContain("INCEPTION");
  });

  test("a binding naming a record with a DEL or C1 control character is not displayed", () => {
    const intents = join(proj, "aidlc", "spaces", "default", "intents");
    const sessions = join(proj, "aidlc", ".aidlc-sessions");
    mkdirSync(sessions, { recursive: true });
    const plain = createIntent(proj, "plain-work", "default", "feature");
    writeFileSync(
      stateFilePath(proj, plain.dirName, "default"),
      "# AI-DLC State Tracking\n## Current Status\n- **Lifecycle Phase**: INCEPTION\n- **Current Stage**: requirements-analysis\n- **Status**: Running\n",
      "utf-8",
    );
    for (const [i, named] of ["del\u007fname", "nel\u0085name", "csi\u009bname"].entries()) {
      const created = createIntent(proj, `control-${i}`, "default", "feature");
      renameSync(join(intents, created.dirName), join(intents, named));
      writeFileSync(
        join(intents, named, "aidlc-state.md"),
        "# AI-DLC State Tracking\n## Current Status\n- **Lifecycle Phase**: CONSTRUCTION\n- **Current Stage**: ci-pipeline\n- **Status**: Running\n",
        "utf-8",
      );
      // Written by hand: the engine refuses to bind such a name.
      const session = `01995100-0000-7000-8000-00000000016${i}`;
      writeFileSync(
        join(sessions, `${session}.binding.json`),
        JSON.stringify({ space: "default", intent: named, boundAt: new Date().toISOString(), source: "switch" }),
      );
      // The binding does not count, so the cursor's record shows instead.
      setActiveIntentCursor(proj, plain.dirName, "default");
      const out = runStatusline(proj, session);
      expect(out).toContain("INCEPTION");
      expect(out).not.toContain("CONSTRUCTION");
      expect(out).not.toContain(named);
    }
  });
});

// Working one Unit at a time, Current Stage stays on the block's first stage
// while the person is on a later step of a Unit: a live run read
// "0/5 > Functional Design -- Architect Agent" at Unit 2's checkpoint.
describe("t168 statusline names the step the person is on", () => {
  function seedUnitWalk(p: string): string {
    const created = createIntent(p, "notes-cli", "default", "feature");
    const state = stateFilePath(p, created.dirName, "default");
    writeFileSync(
      state,
      "# AI-DLC State Tracking\n## Current Status\n- **Lifecycle Phase**: CONSTRUCTION\n" +
        "- **Current Stage**: functional-design\n- **Active Agent**: aidlc-architect-agent\n" +
        "- **Construction Iteration**: unit-major\n- **Status**: Running\n",
      "utf-8",
    );
    return state;
  }

  function writeMarker(state: string, marker: Record<string, unknown>): string {
    const dir = join(dirname(state), ".aidlc-engine");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "active-directive.json");
    writeFileSync(path, JSON.stringify({ version: 2, state_sha256: "0".repeat(64), ...marker }), "utf-8");
    return path;
  }

  test("the Unit's step the engine last put to the person is the step shown", () => {
    const state = seedUnitWalk(proj);
    writeMarker(state, { kind: "run-stage", stage: "code-generation", unit: "u2-note-tags" });
    const out = runStatusline(proj);
    expect(out).toContain("> Code Generation for u2-note-tags");
    expect(out).not.toContain("Functional Design");
    // The Active Agent field follows Current Stage, so it is not shown beside another step.
    expect(out).not.toContain("Architect");
  });

  test("a marker from before the state's last change names nothing; Current Stage shows", () => {
    const state = seedUnitWalk(proj);
    const marker = writeMarker(state, { kind: "run-stage", stage: "code-generation", unit: "u2-note-tags" });
    const past = new Date(Date.now() - 60_000);
    utimesSync(marker, past, past);
    const out = runStatusline(proj);
    expect(out).toContain("> Functional Design");
    expect(out).not.toContain("Code Generation");
  });

  test("a marker Unit that is not a Unit name never reaches the line", () => {
    const state = seedUnitWalk(proj);
    writeMarker(state, { kind: "run-stage", stage: "code-generation", unit: "u2\u001b[31mred" });
    const out = runStatusline(proj);
    expect(out).toContain("> Code Generation");
    expect(out).not.toContain("u2");
  });
});

// Working one Unit at a time, the stage checkboxes tick only once every Unit
// has finished a stage, so a live run read "0/5" with an empty bar while
// Unit 1 was approved and Unit 2 sat at its last step. The line counts Units
// instead while any Unit is still open.
describe("t168 statusline counts Units in a Unit walk", () => {
  const stateBody = (iteration: string, codeGen = "[ ]") =>
    "# AI-DLC State Tracking\n## Runtime State\n" +
    `- **Construction Iteration**: ${iteration}\n` +
    "## Stage Progress\n### CONSTRUCTION PHASE\n" +
    "- [-] functional-design \u2014 EXECUTE\n" +
    `- ${codeGen} code-generation \u2014 EXECUTE\n` +
    "## Current Status\n- **Lifecycle Phase**: CONSTRUCTION\n- **Current Stage**: functional-design\n" +
    "- **Active Agent**: aidlc-architect-agent\n- **Status**: Running\n";

  function seedWalk(p: string, iteration: string, approved: string[]): string {
    const created = createIntent(p, "notes-cli", "default", "feature");
    const state = stateFilePath(p, created.dirName, "default");
    writeFileSync(state, stateBody(iteration), "utf-8");
    const record = dirname(state);
    mkdirSync(join(record, "inception", "units-generation"), { recursive: true });
    writeFileSync(
      join(record, "inception", "units-generation", "unit-of-work-dependency.md"),
      "# Unit Dependency DAG\n\n## Machine-Readable Edge Block\n\n```yaml\nunits:\n" +
        "  - name: u1-note-store\n    kind: library\n    depends_on: []\n" +
        "  - name: u2-note-tags\n    kind: library\n    depends_on: [u1-note-store]\n```\n",
      "utf-8",
    );
    mkdirSync(join(record, "audit"), { recursive: true });
    writeFileSync(
      join(record, "audit", "shard.md"),
      "# AI-DLC Audit Log\n\n" + approved.map((unit, i) =>
        `## Gate Approved\n**Timestamp**: 2026-10-05T09:1${i}:00Z\n**Event**: GATE_APPROVED\n**Unit**: ${unit}\n` +
          "**Stage**: code-generation\n**Checkpoint**: construction-unit\n\n---\n\n").join(""),
      "utf-8",
    );
    const dir = join(record, ".aidlc-engine");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "active-directive.json"), JSON.stringify({
      version: 2, kind: "run-stage", stage: "code-generation", unit: "u2-note-tags", state_sha256: "0".repeat(64),
    }), "utf-8");
    return state;
  }

  test("with Unit 1 approved, the line reads Unit 2 of 2 and the step", () => {
    seedWalk(proj, "unit-major", ["u1-note-store"]);
    const out = runStatusline(proj);
    expect(out).toContain("CONSTRUCTION Unit 2 of 2 > Code Generation for u2-note-tags");
    expect(out).not.toContain("0/2");
  });

  test("a stage-by-stage walk keeps the stage bar and count", () => {
    seedWalk(proj, "stage-major", ["u1-note-store"]);
    const out = runStatusline(proj);
    expect(out).toContain("0/2");
    expect(out).not.toContain("Unit 2 of 2");
  });

  test("once every Unit is approved the stage bar is back", () => {
    seedWalk(proj, "unit-major", ["u1-note-store", "u2-note-tags"]);
    const out = runStatusline(proj);
    expect(out).toContain("0/2");
    expect(out).not.toContain(" of 2 ");
  });
});
