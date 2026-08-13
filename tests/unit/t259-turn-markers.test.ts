// covers: function:markHumanTurn, function:markEngineTouch, function:turnMarkersShowConversational, function:humanTurnMarkerPath, function:engineTouchMarkerPath
//
// The turn-shape marker family: the transcript-free reading of the Stop hook's
// tier-3 conversational carve-out. On harnesses that deliver no
// `transcript_path` (Kiro IDE, Kiro CLI, opencode) the hook cannot parse turn
// history, so the same predicate is reconstructed from two mtimes the framework
// writes on seams that already exist:
//
//   conversational  <=>  mtime(.aidlc-human-turn) > mtime(.aidlc-engine-touch)
//
// WHY THIS FILE EXISTS AS A SEPARATE UNIT TIER. t121 drives the real Stop hook,
// but it does so against a MOCK engine that never calls markEngineTouch. That
// makes t121 structurally incapable of pinning the LIB half of the contract:
// its `.aidlc-engine-touch` cannot be refreshed by the hook's probe no matter
// what the spawn env carries, so an mtime-equality assertion there passes even
// with the probe marking deleted (proved by mutation in review of #687). t121
// now pins the HOOK half with an env witness; this file pins the LIB half
// in-process. Both halves are needed: the carve-out is dead code if either the
// hook forgets to mark its probe OR markEngineTouch forgets to honour the mark.
import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  engineTouchMarkerPath,
  humanTurnMarkerPath,
  markEngineTouch,
  markHumanTurn,
  STOP_HOOK_PROBE_ENV,
  turnMarkersShowConversational,
} from "../../core/tools/aidlc-lib.ts";

const tempDirs: string[] = [];
afterEach(() => {
  delete process.env[STOP_HOOK_PROBE_ENV];
  for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/**
 * A workspace with a BORN intent: the record dir plus the state file and the
 * space/intent cursors the marker family's docsRoot resolution walks. Both
 * writers self-gate on the state file existing, so without it every call is a
 * no-op and the tests below would be vacuous for the wrong reason.
 */
function makeBornProject(): string {
  const proj = mkdtempSync(join(tmpdir(), "aidlc-t259-"));
  tempDirs.push(proj);
  const intents = join(proj, "aidlc", "spaces", "default", "intents");
  const record = join(intents, "260730-probe");
  mkdirSync(record, { recursive: true });
  writeFileSync(join(proj, "aidlc", "active-space"), "default\n", "utf-8");
  writeFileSync(join(intents, "active-intent"), "260730-probe\n", "utf-8");
  writeFileSync(
    join(record, "aidlc-state.md"),
    "# AIDLC State\n\n- **Current Stage**: requirements-analysis\n- **Scope**: feature\n",
    "utf-8",
  );
  return proj;
}

/** A workspace with the harness shell but NO born intent (pre-birth). */
function makeUnbornProject(): string {
  const proj = mkdtempSync(join(tmpdir(), "aidlc-t259-unborn-"));
  tempDirs.push(proj);
  mkdirSync(join(proj, "aidlc", "spaces", "default", "intents"), { recursive: true });
  return proj;
}

describe("t259 turn-shape markers — the transcript-free tier-3 predicate", () => {
  // =========================================================================
  // THE LOAD-BEARING CASE. The Stop hook consults the engine on EVERY stop by
  // spawning `aidlc-orchestrate next`. If that probe refreshed the engine
  // marker, the engine mtime would always end up newer than the human mtime and
  // the predicate would be false forever — the carve-out would look implemented
  // and never fire. markEngineTouch must therefore honour the probe env var.
  // =========================================================================
  test("markEngineTouch is a NO-OP when the probe env var is set (the hook's own consultation)", () => {
    const proj = makeBornProject();
    process.env[STOP_HOOK_PROBE_ENV] = "1";
    markEngineTouch(proj);
    expect(() => statSync(engineTouchMarkerPath(proj))).toThrow(); // never created
  });

  test("markEngineTouch DOES write when the probe env var is absent (a real advance)", () => {
    const proj = makeBornProject();
    markEngineTouch(proj);
    expect(statSync(engineTouchMarkerPath(proj)).isFile()).toBe(true);
  });

  test("a probe-marked call does not REFRESH an existing marker either", () => {
    const proj = makeBornProject();
    markEngineTouch(proj); // a real advance lays the marker down
    const path = engineTouchMarkerPath(proj);
    const before = Math.floor(Date.now() / 1000) - 300;
    utimesSync(path, before, before);
    process.env[STOP_HOOK_PROBE_ENV] = "1";
    markEngineTouch(proj);
    // Equality is the assertion that matters: a probe must leave the mtime
    // exactly where a real advance left it, or the predicate decays silently.
    expect(Math.floor(statSync(path).mtimeMs / 1000)).toBe(before);
  });

  test("only the literal \"1\" suppresses the touch (an unset-looking value must not disable marking)", () => {
    const proj = makeBornProject();
    process.env[STOP_HOOK_PROBE_ENV] = "0";
    markEngineTouch(proj);
    expect(statSync(engineTouchMarkerPath(proj)).isFile()).toBe(true);
  });

  // =========================================================================
  // The predicate itself.
  // =========================================================================
  test("human turn NEWER than the engine touch reads as conversational", () => {
    const proj = makeBornProject();
    const base = Math.floor(Date.now() / 1000) - 600;
    markEngineTouch(proj);
    markHumanTurn(proj);
    utimesSync(engineTouchMarkerPath(proj), base, base);
    utimesSync(humanTurnMarkerPath(proj), base + 60, base + 60);
    expect(turnMarkersShowConversational(proj)).toBe(true);
  });

  test("engine touch NEWER than the human turn does NOT read as conversational", () => {
    const proj = makeBornProject();
    const base = Math.floor(Date.now() / 1000) - 600;
    markEngineTouch(proj);
    markHumanTurn(proj);
    utimesSync(humanTurnMarkerPath(proj), base, base);
    utimesSync(engineTouchMarkerPath(proj), base + 60, base + 60);
    expect(turnMarkersShowConversational(proj)).toBe(false);
  });

  test("FAIL-CLOSED: a missing engine marker is 'no evidence', not 'the engine was never touched'", () => {
    const proj = makeBornProject();
    markHumanTurn(proj); // human marker only — a pre-upgrade workspace
    expect(turnMarkersShowConversational(proj)).toBe(false);
  });

  test("FAIL-CLOSED: a missing human marker also reads false", () => {
    const proj = makeBornProject();
    markEngineTouch(proj);
    expect(turnMarkersShowConversational(proj)).toBe(false);
  });

  test("FAIL-CLOSED: both markers missing reads false", () => {
    const proj = makeBornProject();
    expect(turnMarkersShowConversational(proj)).toBe(false);
  });

  // =========================================================================
  // The birth self-gate. Without it a marker write on a pre-birth workspace
  // would scaffold the record tree as a side effect (touchTurnMarker mkdir -p's
  // its parent, and docsRoot falls back to the bare space record root before
  // birth), breaking the invariant that `aidlc-orchestrate next` is a PURE READ
  // that births nothing — pinned end-to-end by t165/t171.
  // =========================================================================
  test("neither writer touches disk before an intent is born", () => {
    const proj = makeUnbornProject();
    markHumanTurn(proj);
    markEngineTouch(proj);
    expect(() => statSync(humanTurnMarkerPath(proj))).toThrow();
    expect(() => statSync(engineTouchMarkerPath(proj))).toThrow();
  });

  test("the predicate reads false on an unborn workspace rather than throwing", () => {
    expect(turnMarkersShowConversational(makeUnbornProject())).toBe(false);
  });

  // =========================================================================
  // A FAILED WRITE MUST NOT LEAVE A STALE MARKER. The two markers fail in
  // opposite directions and only one is harmless: a missing HUMAN marker costs
  // one spurious nudge, but a stale ENGINE marker is a silent, PERSISTENT
  // fail-open — the human marker keeps advancing past it, so every subsequent
  // engaged-then-bailed turn reads as conversational. Reachable in practice: an
  // engine run under sudo leaves the file root-owned, after which every
  // user-mode write fails EACCES while the stale file survives.
  //
  // Simulated here by making the marker path un-writable in a way that survives
  // the write attempt: a DIRECTORY at the marker's path. writeFileSync fails
  // (EISDIR) exactly as EACCES would, and the recovery must clear the path.
  // =========================================================================
  test("a failed engine-marker write clears the path instead of leaving a stale mtime", () => {
    const proj = makeBornProject();
    markEngineTouch(proj); // a real advance lays a marker down
    const path = engineTouchMarkerPath(proj);
    const stale = Math.floor(Date.now() / 1000) - 3600;
    utimesSync(path, stale, stale);

    // Make the next write fail without removing the staleness problem.
    rmSync(path, { force: true });
    mkdirSync(path, { recursive: true });

    markEngineTouch(proj); // must not throw, and must remove the stale path
    expect(existsSync(path)).toBe(false);
    // The predicate must independently fail closed after the cleanup.
    markHumanTurn(proj);
    expect(turnMarkersShowConversational(proj)).toBe(false);
  });

  test("a marker write failure never throws to the caller", () => {
    const proj = makeBornProject();
    const path = humanTurnMarkerPath(proj);
    mkdirSync(path, { recursive: true }); // writeFileSync will fail EISDIR
    expect(() => markHumanTurn(proj)).not.toThrow();
  });
});
