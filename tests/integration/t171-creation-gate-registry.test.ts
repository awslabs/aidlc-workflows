// covers: subcommand:aidlc-orchestrate:next, subcommand:aidlc-utility:intent-create, function:intentPickPromptIfRecordsExist, function:createPrintDirective, function:listIntents, function:activeSpace
//
// Mechanism: cli (spawned dist tools) — creation + `next` run end-to-end the way
// the conductor runs them.
//
// Blocker B1 — the no-state creation gate (Branch 7b valid-scope positional /
// Branch 9a explicit --scope flag) fires purely on `!stateContent`, but
// stateContent is empty in TWO worlds: a truly empty workspace (zero intents →
// creation) AND a workspace that already holds intents whose per-user
// active-intent CURSOR is unset (a fresh clone of a >1-intent workspace — the
// cursor is gitignored). Without the guard the gate would mint a DUPLICATE
// intent over the existing ones, violating "auto-create fires only on ZERO
// intents". The fix: before creating, consult listIntents over the active
// space; if intents EXIST but none is flagged active, emit an `ask` directive
// that lists them and asks the human to pick one via `/aidlc intent <name>`,
// instead of the creation `print`. The zero-intent case STILL creates unchanged.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  cleanupTestProject,
  createTestProject,
  removeWorkspaceRecord,
} from "../harness/fixtures.ts";
import {
  HARNESS_MATRIX,
  harnessByName,
} from "../harness/harness-matrix.ts";
import { readIntentRegistry } from "../../dist/claude/.claude/tools/aidlc-lib.ts";

const BUN = process.execPath;
const REPO_ROOT = join(import.meta.dir, "..", "..");
const UTIL = join(REPO_ROOT, "dist", "claude", ".claude", "tools", "aidlc-utility.ts");
const ORCH = join(REPO_ROOT, "dist", "claude", ".claude", "tools", "aidlc-orchestrate.ts");

let proj: string;
beforeEach(() => {
  proj = createTestProject();
  // P9: the creation gate's whole point is consulting an EMPTY registry (zero
  // intents → creation; >0 intents + no cursor → prompt). createTestProject seeds
  // ONE default intent record + registry row, so strip it to restore the
  // zero-intent baseline every case here assumes. (Mirrors t160's beforeEach.)
  removeWorkspaceRecord(proj);
});
afterEach(() => {
  cleanupTestProject(proj);
});

interface Run {
  status: number;
  stdout: string;
  out: string;
}
function runTool(tool: string, args: string[], p = proj): Run {
  const env = { ...process.env };
  delete env.AWS_AIDLC_DEFAULT_SCOPE;
  delete env.AIDLC_HARNESS_DIR;
  delete env.AIDLC_HARNESS_NAME;
  const r = Bun.spawnSync({
    cmd: [BUN, tool, ...args, "--project-dir", p],
    stdout: "pipe",
    stderr: "pipe",
    env,
  });
  const stdout = r.stdout.toString();
  return { status: r.exitCode, stdout, out: `${stdout}${r.stderr.toString()}` };
}
function util(args: string[], p = proj): Run {
  return runTool(UTIL, args, p);
}
function next(args: string[], p = proj, orchestrator = ORCH): Run {
  return runTool(orchestrator, ["next", ...args], p);
}

const intentsDir = (p: string, space = "default"): string =>
  join(p, "aidlc", "spaces", space, "intents");
const cursorPath = (p: string, space = "default"): string =>
  join(intentsDir(p, space), "active-intent");
const recordDirs = (p: string, space = "default"): string[] =>
  readdirSync(intentsDir(p, space)).filter((d) =>
    existsSync(join(intentsDir(p, space), d, "aidlc-state.md")),
  );

describe("t171 creation gate consults the intent registry (Blocker B1)", () => {
  // ----------------------------------------------------------------
  // (1) >1 intents + no active-intent cursor (fresh clone) → PROMPT, not creation
  // ----------------------------------------------------------------
  describe("a multi-intent workspace with the cursor unset prompts to pick — never creates a duplicate", () => {
    // Build the fixture: create two intents (each creation sets the cursor to the
    // last-created), then DELETE the active-intent cursor to simulate a fresh clone
    // (the cursor is gitignored per-user state, never carried by a clone).
    const seedTwoIntentsNoCursor = (): string[] => {
      expect(util(["intent-create", "--scope", "poc"]).status).toBe(0);
      expect(util(["intent-create", "--scope", "feature"]).status).toBe(0);
      const records = recordDirs(proj);
      expect(records.length).toBe(2);
      // Drop the per-user cursor → records on disk, nothing flagged active.
      rmSync(cursorPath(proj), { force: true });
      expect(existsSync(cursorPath(proj))).toBe(false);
      return records;
    };

    test("Branch 9a (explicit --scope flag) emits an `ask` listing the existing intents, not a creation print", () => {
      seedTwoIntentsNoCursor();
      const r = next(["--scope", "poc"]);
      const d = JSON.parse(r.stdout.trim());
      // NOT a creation print: the gate must not name intent-create here.
      expect(d.kind).not.toBe("print");
      expect(d.kind).toBe("ask");
      expect(d.message ?? "").not.toContain("intent create");
      // The engine exposes exact record names accepted by the switch command,
      // with the slug retained only as the human label.
      expect(d.question).toContain("/aidlc intent <name>");
      const records = readIntentRegistry(proj)
        .map((entry) => entry.dirName)
        .filter((name): name is string => typeof name === "string");
      expect(records.length).toBe(2);
      for (const name of records) expect(d.question).toContain(name);
      // Read-only: no third intent was created; the cursor is still unset.
      expect(recordDirs(proj).length).toBe(2);
      expect(existsSync(cursorPath(proj))).toBe(false);
    });

    test("Branch 7b (bare valid-scope positional) also prompts, not creates", () => {
      seedTwoIntentsNoCursor();
      const r = next(["poc"]); // positional valid-scope name, no --scope flag
      const d = JSON.parse(r.stdout.trim());
      expect(d.kind).toBe("ask");
      expect(d.message ?? "").not.toContain("intent create");
      expect(d.question).toContain("/aidlc intent <name>");
      expect(recordDirs(proj).length).toBe(2); // no duplicate created
    });

    for (const harness of HARNESS_MATRIX.filter(
      (candidate) => candidate.name !== "kiro" && candidate.name !== "kiro-ide",
    )) {
      test(`${harness.name}: scoped new prose retains the pre-existing untyped picker contract`, () => {
        seedTwoIntentsNoCursor();
        const orchestrator = join(
          harness.engineRoot,
          "tools",
          "aidlc-orchestrate.ts",
        );
        const r = next([
          "poc",
          "Create a tiny TypeScript command-line program that prints Hello World.",
        ], proj, orchestrator);
        const d = JSON.parse(r.stdout.trim());
        expect(d.kind).toBe("ask");
        expect(d.ask_type).toBeUndefined();
        expect(d.available_intents).toBeUndefined();
        expect(d.numbered_prose_question).toBeUndefined();
        expect(d.question).toContain("/aidlc intent <name>");
      });
    }

    test("Claude freeform prose retains its scope-confirm route instead of receiving the Kiro subtype", () => {
      seedTwoIntentsNoCursor();
      const r = next(["fix the broken login button"]);
      const d = JSON.parse(r.stdout.trim());
      expect(d.ask_type).toBeUndefined();
      expect(d.available_intents).toBeUndefined();
      expect(d.question).toContain('This looks like "bugfix" work');
      expect(d.question).toContain("fix the broken login button");
    });

    for (const harnessName of ["kiro", "kiro-ide"] as const) {
      test(`${harnessName}: scoped new prose emits the typed routing ask with record selectors`, () => {
        seedTwoIntentsNoCursor();
        const harness = harnessByName(harnessName);
        const orchestrator = join(
          harness.engineRoot,
          "tools",
          "aidlc-orchestrate.ts",
        );
        const r = next([
          "poc",
          "Create a tiny TypeScript command-line program that prints Hello World.",
        ], proj, orchestrator);
        const d = JSON.parse(r.stdout.trim());
        const selectors = readIntentRegistry(proj)
          .map((entry) => entry.dirName)
          .filter((name): name is string => typeof name === "string");
        expect(d.kind).toBe("ask");
        expect(d.ask_type).toBe("new-work-routing");
        expect(d.response_route).toBe("next");
        expect(d.proposed_scope).toBe("poc");
        expect(d.new_work_description).toContain("Hello World");
        expect(d.available_intents).toEqual(selectors);
        expect(d.numbered_prose_question).toContain(
          "1. **Part of existing work**",
        );
        expect(d.numbered_prose_question).toContain("4. **Other**");
        for (const selector of selectors) {
          expect(d.numbered_prose_question).toContain(selector);
        }
      });
    }

    test("Kiro duplicate labels expose switchable full record selectors", () => {
      const kiro = harnessByName("kiro");
      const kiroUtility = join(
        kiro.engineRoot,
        "tools",
        "aidlc-utility.ts",
      );
      const kiroOrchestrator = join(
        kiro.engineRoot,
        "tools",
        "aidlc-orchestrate.ts",
      );
      expect(
        runTool(kiroUtility, [
          "intent-create",
          "--scope",
          "poc",
          "--label",
          "same label",
        ]).status,
      ).toBe(0);
      expect(
        runTool(kiroUtility, [
          "intent-create",
          "--scope",
          "feature",
          "--label",
          "same label",
        ]).status,
      ).toBe(0);
      const rows = readIntentRegistry(proj);
      expect(rows.map((row) => row.slug)).toEqual(["same-label", "same-label"]);
      const selectors = rows
        .map((row) => row.dirName)
        .filter((name): name is string => typeof name === "string");
      expect(new Set(selectors).size).toBe(2);
      rmSync(cursorPath(proj), { force: true });

      const routed = next([
        "poc",
        "Create a tiny TypeScript command-line program that prints Hello World.",
      ], proj, kiroOrchestrator);
      const directive = JSON.parse(routed.stdout.trim());
      expect(directive.available_intents).toEqual(selectors);
      for (const selector of selectors) {
        expect(directive.numbered_prose_question).toContain(selector);
      }

      const chosen = selectors[1];
      const switchRoute = next(["intent", chosen], proj, kiroOrchestrator);
      const switchDirective = JSON.parse(switchRoute.stdout.trim());
      expect(switchDirective.kind).toBe("print");
      expect(switchDirective.message).toContain(`intent ${chosen}`);
      const switched = runTool(kiroUtility, ["intent", chosen]);
      expect(switched.status, switched.out).toBe(0);
      expect(readFileSync(cursorPath(proj), "utf-8").trim()).toBe(chosen);
    });
  });

  // ----------------------------------------------------------------
  // (2) ZERO intents → STILL creates exactly as before
  // ----------------------------------------------------------------
  describe("a fresh empty workspace still names intent-create (unchanged)", () => {
    test("Branch 9a creates on zero intents", () => {
      const r = next(["--scope", "poc"]);
      const d = JSON.parse(r.stdout.trim());
      expect(d.kind).toBe("print");
      expect(d.message).toContain("intent create --scope poc");
      // Read-only: next did not create anything itself.
      expect(existsSync(intentsDir(proj))).toBe(false);
    });

    test("Branch 7b creates on zero intents (bare valid-scope positional)", () => {
      const r = next(["poc"]);
      const d = JSON.parse(r.stdout.trim());
      expect(d.kind).toBe("print");
      expect(d.message).toContain("intent create --scope poc");
      expect(existsSync(intentsDir(proj))).toBe(false);
    });
  });

  // ----------------------------------------------------------------
  // (3) A single intent with the cursor set → the happy path resolves it
  //     (NOT a creation, NOT a prompt) — the active intent's state drives `next`.
  // ----------------------------------------------------------------
  test("one intent with a live cursor resolves to its workflow (neither creation nor prompt)", () => {
    expect(util(["intent-create", "--scope", "poc"]).status).toBe(0);
    expect(recordDirs(proj).length).toBe(1);
    expect(existsSync(cursorPath(proj))).toBe(true);
    const r = next(["--scope", "poc"]);
    const d = JSON.parse(r.stdout.trim());
    // The lone created intent has a live cursor + state → the engine reads its
    // position and advances; it must NOT re-name intent-create nor prompt to pick.
    expect(d.kind).not.toBe("ask");
    if (d.kind === "print") expect(d.message).not.toContain("intent create");
    // The cursor was never disturbed.
    const cursor = readFileSync(cursorPath(proj), "utf-8").trim();
    expect(recordDirs(proj)).toContain(cursor);
  });
});
