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

import { deterministicCaseTimeoutMs } from "../harness/test-budget.ts";
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { cpSync, existsSync, readdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
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
// Every case here spawns several dist tools in sequence; under a parallel tier
// run that comfortably exceeds bun's 5 s default, so pin the file-wide budget
// the way t188/t224 do.
const TIMEOUT_MS = 60_000;
setDefaultTimeout(Math.max(TIMEOUT_MS, deterministicCaseTimeoutMs()));
const REPO_ROOT = join(import.meta.dir, "..", "..");
const CLAUDE_DIST = join(REPO_ROOT, "dist", "claude");
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
  symlinkSync(join(CLAUDE_DIST, ".claude"), join(proj, ".claude"), "dir");
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
function runEmittedCommand(command: string, p = proj): Run {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    AIDLC_PROJECT_DIR: p,
  };
  delete env.AWS_AIDLC_DEFAULT_SCOPE;
  delete env.AIDLC_HARNESS_DIR;
  delete env.AIDLC_HARNESS_NAME;
  const r = Bun.spawnSync({
    cmd: ["sh", "-c", command],
    cwd: p,
    stdout: "pipe",
    stderr: "pipe",
    env,
  });
  const stdout = r.stdout.toString();
  return { status: r.exitCode, stdout, out: `${stdout}${r.stderr.toString()}` };
}

function printedCommand(message: string): string {
  const command = message.match(/Run `([^`]+)`/)?.[1];
  expect(command, message).toBeDefined();
  return command!.replace('"<2-3 word kebab essence>"', "pending-work");
}

function createdDescription(): string {
  const active = readFileSync(cursorPath(proj), "utf-8").trim();
  const state = readFileSync(join(intentsDir(proj), active, "aidlc-state.md"), "utf-8");
  return state.match(/^- \*\*Project\*\*: (.*)$/m)?.[1] ?? "";
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
      expect(d.available_intents).toEqual(records);
      expect(d.ask_type).toBe("intent-pick");
      expect(d.response_route).toBe("next");
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
      expect(d.available_intents).toHaveLength(2);
      expect(recordDirs(proj).length).toBe(2); // no duplicate created
    });

    for (const selector of ["customer work", "x; touch pwned"]) {
      test(`intent picker executes literal selector ${selector}`, () => {
        const records = seedTwoIntentsNoCursor();
        // Orphan/migrated directory names need not be slugified. The relative
        // payload targets <fixture>/pwned because emitted commands run there.
        cpSync(join(intentsDir(proj), records[0]), join(intentsDir(proj), selector), { recursive: true });
        const picked = JSON.parse(next(["--scope", "poc"]).stdout.trim());
        const entry = picked.select_commands.find((row: { selector: string }) => row.selector === selector);
        expect(entry).toBeDefined();
        const routed = runEmittedCommand(entry.command);
        expect(existsSync(join(proj, "pwned")), "selector command must not execute shell metacharacters").toBe(false);
        expect(routed.status, routed.out).toBe(0);
        const directive = JSON.parse(routed.stdout.trim());
        const switched = runEmittedCommand(printedCommand(directive.message));
        expect(existsSync(join(proj, "pwned")), "selector handoff must not execute shell metacharacters").toBe(false);
        expect(switched.status, switched.out).toBe(0);
        expect(readFileSync(cursorPath(proj), "utf-8").trim(), "selector must stay a single literal argv value").toBe(selector);
      });
    }

    for (const harness of HARNESS_MATRIX.filter(
      (candidate) => candidate.name !== "kiro" && candidate.name !== "kiro-ide",
    )) {
      test(`${harness.name}: scoped new prose preserves the request through routing`, () => {
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
        expect(d.ask_type).toBe("new-work-routing");
        expect(d.response_route).toBe("next");
        expect(d.available_intents).toHaveLength(2);
        expect(d.new_work_description).toBe("Create a tiny TypeScript command-line program that prints Hello World.");
        expect(d.proposed_scope).toBe("poc");
      });
    }

    test("non-Kiro confirmation preserves pending work on the second hop and route 2 creates it", () => {
      seedTwoIntentsNoCursor();
      const description = "fix the broken login button";
      const first = JSON.parse(next([description]).stdout.trim());
      expect(first.ask_type).toBe("scope-confirm");
      expect(first.intent_text).toBe(description);
      const confirmed = runEmittedCommand(first.confirm_command);
      expect(confirmed.status, confirmed.out).toBe(0);
      const second = JSON.parse(confirmed.stdout.trim());
      expect(second.ask_type, "confirmed pending work must reach new-work-routing, not a bare picker").toBe("new-work-routing");
      expect(second.new_work_description).toBe(description);
      expect(second.proposed_scope).toBe(first.proposed_scope);
      // Routes are fields; the human-facing text carries no engine commands.
      for (const text of [second.question, second.numbered_prose_question]) {
        expect(text).not.toContain("--pending-request");
        expect(text).not.toContain("aidlc-orchestrate");
      }
      const firstId = first.confirm_command.match(/--pending-request ([0-9a-f]{8})/)?.[1];
      expect(firstId).toBeDefined();
      for (const field of ["new_intent_command", "scope_command_template", "compose_command"]) {
        expect(second[field], `${field} keeps the confirmed request's id`).toContain(`--pending-request ${firstId}`);
      }
      expect(second.scope_command_template).toContain("--scope <scope>");
      expect(second.select_commands.map((row: { selector: string }) => row.selector)).toEqual(second.available_intents);
      const routed = runEmittedCommand(second.new_intent_command);
      expect(routed.status, routed.out).toBe(0);
      const creation = JSON.parse(routed.stdout.trim());
      const created = runEmittedCommand(printedCommand(creation.message));
      expect(created.status, created.out).toBe(0);
      expect(recordDirs(proj)).toHaveLength(3);
      expect(createdDescription()).toBe(description);
    });

    test("non-Kiro reshape selects the listed record, then composes the same pending request", () => {
      seedTwoIntentsNoCursor();
      const description = "fix the broken login button";
      const first = JSON.parse(next([description]).stdout.trim());
      const second = JSON.parse(runEmittedCommand(first.confirm_command).stdout.trim());
      expect(second.ask_type).toBe("new-work-routing");
      const [target] = second.select_commands;
      const selected = runEmittedCommand(target.command);
      expect(selected.status, selected.out).toBe(0);
      const switched = runEmittedCommand(printedCommand(JSON.parse(selected.stdout.trim()).message));
      expect(switched.status, switched.out).toBe(0);
      expect(readFileSync(cursorPath(proj), "utf-8").trim()).toBe(target.selector);
      const composed = runEmittedCommand(second.compose_command);
      expect(composed.status, composed.out).toBe(0);
      const dispatch = JSON.parse(composed.stdout.trim());
      expect(dispatch.kind).toBe("print");
      expect(dispatch.message).toContain(description);
      expect(recordDirs(proj)).toHaveLength(2);
    });

    test("pending work over registry-only records keeps the plain picker", () => {
      const records = seedTwoIntentsNoCursor();
      // Registry rows survive, record dirs do not: nothing is selectable, so
      // options 1 and 3 of new-work routing would have no record to name.
      for (const record of records) rmSync(join(intentsDir(proj), record), { recursive: true, force: true });
      const d = JSON.parse(next(["--scope", "poc", "fix the broken login button"]).stdout.trim());
      expect(d.kind).toBe("ask");
      expect(d.ask_type).toBe("intent-pick");
      expect(d.available_intents).toEqual([]);
      expect(d.select_commands).toEqual([]);
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
    for (const size of [6000, 20000]) {
      test(`${size}-character scope-confirm stays within transport and creates the exact request`, () => {
        const prefix = "team's workshop $(touch$IFS'pwned') ";
        const intentText = prefix + "x".repeat(size - prefix.length);
        const routed = next([intentText]);
        expect(routed.status, `detailed request must emit JSON, not exceed the directive limit: ${routed.out}`).toBe(0);
        const directive = JSON.parse(routed.stdout.trim());
        expect(directive.ask_type).toBe("scope-confirm");
        expect(directive.intent_text).toBe(intentText);
        expect(directive.question).toContain(`${intentText.slice(0, 240)}...`);
        expect(directive.question).not.toContain(intentText.slice(0, 241));
        expect(directive.confirm_command).not.toContain(intentText);
        const confirmed = runEmittedCommand(directive.confirm_command);
        expect(confirmed.status, confirmed.out).toBe(0);
        const creation = JSON.parse(confirmed.stdout.trim());
        expect(creation.kind).toBe("print");
        const created = runEmittedCommand(printedCommand(creation.message));
        expect(created.status, created.out).toBe(0);
        expect(createdDescription()).toBe(intentText);
        expect(existsSync(join(proj, "pwned"))).toBe(false);
        const replayed = JSON.parse(runEmittedCommand(directive.confirm_command).stdout.trim());
        expect(replayed.kind).toBe("error");
        expect(recordDirs(proj)).toHaveLength(1);
      });
    }

    test("compose-offer resolves its stored request and can select another scope", () => {
      const intentText = "build an onboarding portal for new engineers with SSO";
      const directive = JSON.parse(next([intentText]).stdout.trim());
      expect(directive.ask_type).toBe("compose-offer");
      const composed = runEmittedCommand(directive.compose_command);
      expect(composed.status, composed.out).toBe(0);
      expect(JSON.parse(composed.stdout.trim()).message).toContain(intentText);
      const confirmed = runEmittedCommand(directive.scope_command_template.replace("<scope>", "poc"));
      expect(confirmed.status, confirmed.out).toBe(0);
      const created = runEmittedCommand(printedCommand(JSON.parse(confirmed.stdout.trim()).message));
      expect(created.status, created.out).toBe(0);
      expect(createdDescription()).toBe(intentText);
    });

    test("concurrent requests keep independent ids and each creates its own request", () => {
      // Two sessions in one clone: the second request must not invalidate the first.
      const first = JSON.parse(next(["fix the first bug"]).stdout.trim());
      const second = JSON.parse(next(["fix the second bug"]).stdout.trim());
      const firstId = first.confirm_command.match(/--pending-request ([0-9a-f]{8})/)?.[1];
      const secondId = second.confirm_command.match(/--pending-request ([0-9a-f]{8})/)?.[1];
      expect(firstId).toBeDefined();
      expect(secondId).toBeDefined();
      expect(firstId).not.toBe(secondId);
      const confirmed = runEmittedCommand(first.confirm_command);
      expect(confirmed.status, confirmed.out).toBe(0);
      const created = runEmittedCommand(printedCommand(JSON.parse(confirmed.stdout.trim()).message));
      expect(created.status, created.out).toBe(0);
      expect(createdDescription()).toBe("fix the first bug");
      expect(existsSync(join(proj, "aidlc", ".aidlc-sessions", "pending-requests", `${firstId}.json`))).toBe(false);
      expect(existsSync(join(proj, "aidlc", ".aidlc-sessions", "pending-requests", `${secondId}.json`))).toBe(true);
    });

    test("asking again for the same request returns the same id", () => {
      const once = JSON.parse(next(["fix the login bug"]).stdout.trim());
      const twice = JSON.parse(next(["fix the login bug"]).stdout.trim());
      expect(twice.confirm_command).toBe(once.confirm_command);
      expect(twice).toEqual(once);
    });

    test("an unknown pending id errors on next and intent create without creating work", () => {
      const message = "Pending request deadbeef is no longer available; restate the request.";
      const rejected = JSON.parse(next(["--scope", "bugfix", "--pending-request", "deadbeef"]).stdout.trim());
      expect(rejected).toMatchObject({ kind: "error", message });
      const creation = util(["intent-create", "--scope", "bugfix", "--pending-request", "deadbeef"]);
      expect(creation.status).toBe(1);
      expect(creation.out).toContain(message);
      expect(existsSync(intentsDir(proj))).toBe(false);
    });

    test("--pending-request without an id is a parse error, not a lookup", () => {
      for (const args of [["--pending-request", "--scope", "bugfix"], ["--scope", "bugfix", "--pending-request"]]) {
        const d = JSON.parse(next(args).stdout.trim());
        expect(d).toMatchObject({ kind: "error", message: "--pending-request requires <8-hex id>." });
      }
    });

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

// ----------------------------------------------------------------
// (4) Archived intents (issue #980) are retired work: the gate never offers
//     them as a pick and never lets them block creation.
// ----------------------------------------------------------------
describe("t171 archived intents never block or appear in the creation gate (issue #980)", () => {
  test("the pick prompt lists only in-flight records; an all-archived space creates", () => {
    expect(util(["intent-create", "--scope", "poc", "--label", "alpha work"]).status).toBe(0);
    expect(util(["intent-create", "--scope", "poc", "--label", "beta work"]).status).toBe(0);
    expect(util(["intent-create", "--scope", "poc", "--label", "gamma work"]).status).toBe(0);
    const dirs = recordDirs(proj);
    expect(dirs.length).toBe(3);
    const gamma = dirs.find((d) => d.endsWith("-gamma-work")) as string;
    const inFlight = dirs.filter((d) => d !== gamma);
    expect(util(["intent", "archive", gamma, "--reason", "went nowhere"]).status).toBe(0);
    // A fresh clone: records on disk, no per-user cursor.
    rmSync(cursorPath(proj), { force: true });
    const r = next(["--scope", "poc"]);
    const d = JSON.parse(r.stdout.trim());
    expect(d.kind).toBe("ask");
    for (const name of inFlight) expect(d.question).toContain(name);
    expect(d.question).not.toContain(gamma);
    expect(d.question).toContain("2 pieces of work in progress");
    // Retire the rest: the gate now sees zero intents and names the create
    // move instead of offering retired records.
    for (const name of inFlight) {
      expect(util(["intent", "archive", name]).status).toBe(0);
    }
    const created = JSON.parse(next(["--scope", "poc"]).stdout.trim());
    expect(created.kind).toBe("print");
    expect(created.message).toContain("intent create --scope poc");
    // Read-only throughout: three records remain, all archived, no cursor.
    expect(recordDirs(proj).length).toBe(3);
    expect(readIntentRegistry(proj).every((entry) => entry.status === "archived")).toBe(true);
    expect(existsSync(cursorPath(proj))).toBe(false);
  });
});
