// covers: function:markHumanTurn, function:markEngineTouch, function:turnMarkersShowConversational, function:humanTurnMarkerPath, function:engineTouchMarkerPath, function:markTurnEnd, function:turnEndIsOpen, function:turnEndMarkerPath
//
// The turn-shape marker family: the transcript-free reading of the Stop hook's
// tier-3 conversational carve-out. On harnesses that deliver no
// `transcript_path` (Kiro IDE, Kiro CLI, opencode) the hook cannot parse turn
// history, so the same predicate is reconstructed from two mtimes the framework
// writes on seams that already exist:
//
//   conversational  <=>  mtime(.aidlc-engine/human-turn) > mtime(.aidlc-engine/engine-touch)
//
// WHY THIS FILE EXISTS AS A SEPARATE UNIT TIER. t121 drives the real Stop hook,
// but it does so against a MOCK engine that never calls markEngineTouch. That
// makes t121 structurally incapable of pinning the LIB half of the contract:
// its `.aidlc-engine/engine-touch` cannot be refreshed by the hook's probe no matter
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
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  turnEndIsOpen,
  turnEndMarkerPath,
  engineTouchMarkerPath,
  humanTurnMarkerPath,
  markTurnEnd,
  markEngineTouch,
  markHumanTurn,
  STOP_HOOK_PROBE_ENV,
  turnMarkersShowConversational,
} from "../../core/tools/aidlc-lib.ts";
import { setupIntegrationProject } from "../harness/fixtures.ts";

const tempDirs: string[] = [];
afterEach(() => {
  delete process.env[STOP_HOOK_PROBE_ENV];
  for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/**
 * A workspace with a CREATED intent: the record dir plus the state file and the
 * space/intent cursors the marker family's docsRoot resolution walks. Both
 * writers self-gate on the state file existing, so without it every call is a
 * no-op and the tests below would be vacuous for the wrong reason.
 */
function makeCreatedProject(): string {
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

/** A workspace with the harness shell but NO created intent (pre-creation). */
function makeUncreatedProject(): string {
  const proj = mkdtempSync(join(tmpdir(), "aidlc-t259-uncreated-"));
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
    const proj = makeCreatedProject();
    process.env[STOP_HOOK_PROBE_ENV] = "1";
    markEngineTouch(proj);
    expect(() => statSync(engineTouchMarkerPath(proj))).toThrow(); // never created
  });

  test("markEngineTouch DOES write when the probe env var is absent (a real advance)", () => {
    const proj = makeCreatedProject();
    markEngineTouch(proj);
    expect(statSync(engineTouchMarkerPath(proj)).isFile()).toBe(true);
  });

  test("a probe-marked call does not REFRESH an existing marker either", () => {
    const proj = makeCreatedProject();
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
    const proj = makeCreatedProject();
    process.env[STOP_HOOK_PROBE_ENV] = "0";
    markEngineTouch(proj);
    expect(statSync(engineTouchMarkerPath(proj)).isFile()).toBe(true);
  });

  // =========================================================================
  // The predicate itself.
  // =========================================================================
  test("human turn NEWER than the engine touch reads as conversational", () => {
    const proj = makeCreatedProject();
    const base = Math.floor(Date.now() / 1000) - 600;
    markEngineTouch(proj);
    markHumanTurn(proj);
    utimesSync(engineTouchMarkerPath(proj), base, base);
    utimesSync(humanTurnMarkerPath(proj), base + 60, base + 60);
    expect(turnMarkersShowConversational(proj)).toBe(true);
  });

  test("engine touch NEWER than the human turn does NOT read as conversational", () => {
    const proj = makeCreatedProject();
    const base = Math.floor(Date.now() / 1000) - 600;
    markEngineTouch(proj);
    markHumanTurn(proj);
    utimesSync(humanTurnMarkerPath(proj), base, base);
    utimesSync(engineTouchMarkerPath(proj), base + 60, base + 60);
    expect(turnMarkersShowConversational(proj)).toBe(false);
  });

  test("FAIL-CLOSED: a missing engine marker is 'no evidence', not 'the engine was never touched'", () => {
    const proj = makeCreatedProject();
    markHumanTurn(proj); // human marker only — a pre-upgrade workspace
    expect(turnMarkersShowConversational(proj)).toBe(false);
  });

  test("FAIL-CLOSED: a missing human marker also reads false", () => {
    const proj = makeCreatedProject();
    markEngineTouch(proj);
    expect(turnMarkersShowConversational(proj)).toBe(false);
  });

  test("FAIL-CLOSED: both markers missing reads false", () => {
    const proj = makeCreatedProject();
    expect(turnMarkersShowConversational(proj)).toBe(false);
  });

  // =========================================================================
  // The creation self-gate. Without it a marker write on a pre-creation workspace
  // would scaffold the record tree as a side effect (touchTurnMarker mkdir -p's
  // its parent, and docsRoot falls back to the bare space record root before
  // creation), breaking the invariant that `aidlc-orchestrate next` is a PURE READ
  // that creates nothing - pinned end-to-end by t165/t171.
  // =========================================================================
  test("neither writer touches disk before an intent is created", () => {
    const proj = makeUncreatedProject();
    markHumanTurn(proj);
    markEngineTouch(proj);
    expect(() => statSync(humanTurnMarkerPath(proj))).toThrow();
    expect(() => statSync(engineTouchMarkerPath(proj))).toThrow();
  });

  test("the predicate reads false on an uncreated workspace rather than throwing", () => {
    expect(turnMarkersShowConversational(makeUncreatedProject())).toBe(false);
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
    const proj = makeCreatedProject();
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
    const proj = makeCreatedProject();
    const path = humanTurnMarkerPath(proj);
    mkdirSync(path, { recursive: true }); // writeFileSync will fail EISDIR
    expect(() => markHumanTurn(proj)).not.toThrow();
  });

  test.skipIf(process.platform === "win32")("a link in the record never sends a marker write or clean-up outside it", () => {
    const outside = mkdtempSync(join(tmpdir(), "aidlc-t259-outside-"));
    tempDirs.push(outside);
    const canary = join(outside, "canary");
    // The marker leaf is a link to a file outside the record.
    const proj = makeCreatedProject();
    writeFileSync(canary, "keep\n", "utf-8");
    mkdirSync(join(engineTouchMarkerPath(proj), ".."), { recursive: true });
    symlinkSync(canary, turnEndMarkerPath(proj));
    symlinkSync(canary, humanTurnMarkerPath(proj));
    symlinkSync(canary, engineTouchMarkerPath(proj));
    markTurnEnd(proj, true);
    markHumanTurn(proj);
    markEngineTouch(proj);
    expect(readFileSync(canary, "utf-8")).toBe("keep\n");
    expect(turnEndIsOpen(proj)).toBe(false);
    // The engine folder itself is a link to a folder outside the record.
    const other = makeCreatedProject();
    const engine = join(engineTouchMarkerPath(other), "..");
    rmSync(engine, { recursive: true, force: true });
    writeFileSync(join(outside, "turn-end"), "keep\n", "utf-8");
    symlinkSync(outside, engine);
    markTurnEnd(other, true);
    markTurnEnd(other, false);
    markHumanTurn(other);
    expect(readFileSync(join(outside, "turn-end"), "utf-8")).toBe("keep\n");
    expect(readFileSync(canary, "utf-8")).toBe("keep\n");
    expect(existsSync(join(outside, "human-turn"))).toBe(false);
    // Marks found through a linked engine folder read as no marks.
    const now = Date.now() / 1000;
    writeFileSync(join(outside, "human-turn"), "x\n", "utf-8");
    writeFileSync(join(outside, "engine-touch"), "x\n", "utf-8");
    utimesSync(join(outside, "engine-touch"), now - 60, now - 60);
    utimesSync(join(outside, "human-turn"), now - 30, now - 30);
    utimesSync(join(outside, "turn-end"), now, now);
    expect(turnEndIsOpen(other)).toBe(false);
    expect(turnMarkersShowConversational(other)).toBe(false);
  });
});

describe("t259 the engine's last word ended the turn", () => {
  test("an ask sets the marker, any other step clears it, and the Stop hook's own probe changes nothing", () => {
    const proj = makeCreatedProject();
    markTurnEnd(proj, true);
    expect(statSync(turnEndMarkerPath(proj)).isFile()).toBe(true);
    process.env[STOP_HOOK_PROBE_ENV] = "1";
    markTurnEnd(proj, false);
    expect(existsSync(turnEndMarkerPath(proj))).toBe(true);
    delete process.env[STOP_HOOK_PROBE_ENV];
    markTurnEnd(proj, false);
    expect(existsSync(turnEndMarkerPath(proj))).toBe(false);
  });

  test("the question is open only while it is newer than the person's last message", () => {
    const proj = makeCreatedProject();
    const base = Math.floor(Date.now() / 1000) - 600;
    expect(turnEndIsOpen(proj)).toBe(false);
    markHumanTurn(proj);
    markTurnEnd(proj, true);
    utimesSync(humanTurnMarkerPath(proj), base, base);
    utimesSync(turnEndMarkerPath(proj), base + 60, base + 60);
    expect(turnEndIsOpen(proj)).toBe(true);
    utimesSync(humanTurnMarkerPath(proj), base + 120, base + 120);
    expect(turnEndIsOpen(proj)).toBe(false);
    rmSync(humanTurnMarkerPath(proj), { force: true });
    expect(turnEndIsOpen(proj)).toBe(false);
  });

  // A live run: mid-Feasibility the person typed unrelated new work, got "Work
  // is already in progress on ... How should I handle this?", and picked
  // "Chat about this". The Stop hook's own `next` returned Feasibility, the
  // reminder fired, and the agent went back to the old work, dropping the
  // question. The turn now ends at the question.
  test("the Stop hook lets the turn end at the new-work question, and nudges again once other work is handed out", async () => {
    const proj = setupIntegrationProject({ withState: "state-mid-ideation.md", stripEnvScope: true });
    tempDirs.push(proj);
    const env: Record<string, string | undefined> = { ...process.env, CLAUDE_PROJECT_DIR: proj };
    delete env[STOP_HOOK_PROBE_ENV];
    const run = (args: string[], input?: string) =>
      spawnSync(process.execPath, [".claude/tools/aidlc.ts", ...args], { cwd: proj, input, encoding: "utf-8", env });
    const stop = () =>
      run(["engine", "hook", "continue-workflow"], JSON.stringify({ hook_event_name: "Stop", stop_hook_active: false, session_id: "t259-stop" }));
    markHumanTurn(proj);
    await Bun.sleep(20);
    // Words alone first get the re-entry readings; the agent reads them as new
    // work and runs the `next --request` the print names.
    const read = JSON.parse(run([
      "engine", "orchestrate", "next",
      "build a standalone Python CLI that scrapes NOAA weather data and writes it to a SQLite database",
    ]).stdout) as { kind: string; message: string };
    expect(read.kind).toBe("print");
    const request = /`[^`]* next (--request [0-9a-f]{8})`/.exec(read.message)?.[1];
    expect(request, read.message).toBeDefined();
    const asked = run(["engine", "orchestrate", "next", ...request!.split(" ")]);
    expect(JSON.parse(asked.stdout).ask_type).toBe("new-work-routing");
    const atQuestion = stop();
    expect(atQuestion.status, atQuestion.stderr).toBe(0);
    expect(atQuestion.stdout).not.toContain('"decision":"block"');

    // The agent ran a bare next anyway and was handed the work in progress.
    expect(JSON.parse(run(["engine", "orchestrate", "next"]).stdout).kind).toBe("run-stage");
    expect(stop().stdout).toContain('"decision":"block"');
  });

  // Live runs: after a read-only /aidlc --status, and after a scope change at a
  // gate, the reminder sent the agent into the next stage with no word from the
  // person. A print the agent stops after now ends the turn; one that hands the
  // agent back to `next` still does not.
  for (const copilot of [false, true]) {
    test(`the Stop hook lets the turn end after a print the agent stops after${copilot ? ", in a Copilot session" : ""}`, async () => {
      const proj = setupIntegrationProject({ withState: "state-mid-ideation.md", stripEnvScope: true });
      tempDirs.push(proj);
      const env: Record<string, string | undefined> = { ...process.env, CLAUDE_PROJECT_DIR: proj };
      delete env[STOP_HOOK_PROBE_ENV];
      const run = (args: string[], input?: string, extra: Record<string, string> = {}) =>
        spawnSync(process.execPath, [".claude/tools/aidlc.ts", ...args], {
          cwd: proj, input, encoding: "utf-8", env: { ...env, ...extra },
        });
      const stop = () =>
        run(
          ["engine", "hook", "continue-workflow"],
          JSON.stringify({ hook_event_name: "Stop", stop_hook_active: false, session_id: "t259-stop" }),
          copilot ? { AIDLC_COPILOT_SESSION_ID: "t259-stop" } : {},
        );
      for (const [args, said] of [
        [["--status"], "print its output verbatim, then stop"],
        [["--scope", "mvp"], "to change scope, then print its output verbatim and stop"],
        [["--depth", "minimal"], "to update the configuration, then print its output verbatim and stop"],
      ] as const) {
        markHumanTurn(proj);
        await Bun.sleep(20);
        const printed = JSON.parse(run(["engine", "orchestrate", "next", ...args]).stdout);
        expect(printed.kind).toBe("print");
        expect(printed.message).toContain(said);
        const atEnd = stop();
        expect(atEnd.status, atEnd.stderr).toBe(0);
        expect(atEnd.stdout, args.join(" ")).not.toContain('"decision":"block"');
      }
      // A jump's print hands the agent back to `next`, so the turn goes on.
      markHumanTurn(proj);
      await Bun.sleep(20);
      const jump = JSON.parse(run(["engine", "orchestrate", "next", "--stage", "requirements-analysis"]).stdout);
      expect(jump.kind).toBe("print");
      expect(jump.message).toMatch(/[Tt]hen re-run `next`/);
      expect(existsSync(turnEndMarkerPath(proj))).toBe(false);
      if (!copilot) expect(stop().stdout).toContain('"decision":"block"');
    });
  }
});
