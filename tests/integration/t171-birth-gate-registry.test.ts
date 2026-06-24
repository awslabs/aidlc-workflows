// covers: subcommand:aidlc-orchestrate:next, subcommand:aidlc-utility:intent-birth, function:intentPickPromptIfRecordsExist, function:birthPrintDirective, function:listIntents, function:activeSpace
//
// Mechanism: cli (spawned dist tools) — birth + `next` run end-to-end the way
// the conductor runs them.
//
// Blocker B1 — the no-state birth gate (Branch 7b valid-scope positional /
// Branch 9a explicit --scope flag) fires purely on `!stateContent`, but
// stateContent is empty in TWO worlds: a truly empty workspace (zero intents →
// birth) AND a workspace that already holds intents whose per-user
// active-intent CURSOR is unset (a fresh clone of a >1-intent workspace — the
// cursor is gitignored). Without the guard the gate would mint a DUPLICATE
// intent over the existing ones, violating "auto-birth fires only on ZERO
// intents". The fix: before birthing, consult listIntents over the active
// space; if intents EXIST but none is flagged active, emit an `ask` directive
// that lists them and asks the human to pick one via `/aidlc intent <slug>`,
// instead of the birth `print`. The zero-intent case STILL births unchanged.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  cleanupTestProject,
  createTestProject,
  removeWorkspaceRecord,
} from "../harness/fixtures.ts";
import { readIntentRegistry } from "../../dist/claude/.claude/tools/aidlc-lib.ts";

const BUN = process.execPath;
const REPO_ROOT = join(import.meta.dir, "..", "..");
const UTIL = join(REPO_ROOT, "dist", "claude", ".claude", "tools", "aidlc-utility.ts");
const ORCH = join(REPO_ROOT, "dist", "claude", ".claude", "tools", "aidlc-orchestrate.ts");

let proj: string;
beforeEach(() => {
  proj = createTestProject();
  // P9: the birth gate's whole point is consulting an EMPTY registry (zero
  // intents → birth; >0 intents + no cursor → prompt). createTestProject seeds
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
function util(args: string[], p = proj): Run {
  const env = { ...process.env };
  delete env.AWS_AIDLC_DEFAULT_SCOPE;
  const r = Bun.spawnSync({
    cmd: [BUN, UTIL, ...args, "--project-dir", p],
    stdout: "pipe",
    stderr: "pipe",
    env,
  });
  const stdout = r.stdout.toString();
  return { status: r.exitCode, stdout, out: `${stdout}${r.stderr.toString()}` };
}
function next(args: string[], p = proj): Run {
  const env = { ...process.env };
  delete env.AWS_AIDLC_DEFAULT_SCOPE;
  const r = Bun.spawnSync({
    cmd: [BUN, ORCH, "next", ...args, "--project-dir", p],
    stdout: "pipe",
    stderr: "pipe",
    env,
  });
  const stdout = r.stdout.toString();
  return { status: r.exitCode, stdout, out: `${stdout}${r.stderr.toString()}` };
}

const intentsDir = (p: string, space = "default"): string =>
  join(p, "aidlc", "spaces", space, "intents");
const cursorPath = (p: string, space = "default"): string =>
  join(intentsDir(p, space), "active-intent");
const recordDirs = (p: string, space = "default"): string[] =>
  readdirSync(intentsDir(p, space)).filter((d) =>
    existsSync(join(intentsDir(p, space), d, "aidlc-state.md")),
  );

describe("t171 birth gate consults the intent registry (Blocker B1)", () => {
  // ----------------------------------------------------------------
  // (1) >1 intents + no active-intent cursor (fresh clone) → PROMPT, not birth
  // ----------------------------------------------------------------
  describe("a multi-intent workspace with the cursor unset prompts to pick — never births a duplicate", () => {
    // Build the fixture: birth two intents (each birth sets the cursor to the
    // last-born), then DELETE the active-intent cursor to simulate a fresh clone
    // (the cursor is gitignored per-user state, never carried by a clone).
    const seedTwoIntentsNoCursor = (): string[] => {
      expect(util(["intent-birth", "--scope", "poc"]).status).toBe(0);
      expect(util(["intent-birth", "--scope", "feature"]).status).toBe(0);
      const records = recordDirs(proj);
      expect(records.length).toBe(2);
      // Drop the per-user cursor → records on disk, nothing flagged active.
      rmSync(cursorPath(proj), { force: true });
      expect(existsSync(cursorPath(proj))).toBe(false);
      return records;
    };

    test("Branch 9a (explicit --scope flag) emits an `ask` listing the existing intents, not a birth print", () => {
      seedTwoIntentsNoCursor();
      const r = next(["--scope", "poc"]);
      const d = JSON.parse(r.stdout.trim());
      // NOT a birth print: the gate must not name intent-birth here.
      expect(d.kind).not.toBe("print");
      expect(d.kind).toBe("ask");
      expect(d.message ?? "").not.toContain("intent-birth");
      // It prompts to pick an existing intent by slug via `/aidlc intent <slug>`.
      expect(d.question).toContain("/aidlc intent <slug>");
      // The two existing intent slugs are named in the prompt. The engine lists
      // the registry `slug` values (aidlc-orchestrate.ts intentPickPrompt →
      // intents.map(i => i.slug)), NOT the dir names — so derive the expected
      // slugs from the registry, not by stripping the (now date-prefixed, no-hex)
      // dir name. These births passed no description, so each slug is its scope
      // token ("poc", "feature").
      const slugs = readIntentRegistry(proj).map((e) => e.slug);
      expect(slugs.length).toBe(2);
      for (const s of slugs) expect(d.question).toContain(s);
      // Read-only: no third intent was born; the cursor is still unset.
      expect(recordDirs(proj).length).toBe(2);
      expect(existsSync(cursorPath(proj))).toBe(false);
    });

    test("Branch 7b (bare valid-scope positional) also prompts, not births", () => {
      seedTwoIntentsNoCursor();
      const r = next(["poc"]); // positional valid-scope name, no --scope flag
      const d = JSON.parse(r.stdout.trim());
      expect(d.kind).toBe("ask");
      expect(d.message ?? "").not.toContain("intent-birth");
      expect(d.question).toContain("/aidlc intent <slug>");
      expect(recordDirs(proj).length).toBe(2); // no duplicate born
    });
  });

  // ----------------------------------------------------------------
  // (2) ZERO intents → STILL births exactly as before
  // ----------------------------------------------------------------
  describe("a fresh empty workspace still names intent-birth (unchanged)", () => {
    test("Branch 9a births on zero intents", () => {
      const r = next(["--scope", "poc"]);
      const d = JSON.parse(r.stdout.trim());
      expect(d.kind).toBe("print");
      expect(d.message).toContain("intent-birth --scope poc");
      // Read-only: next did not birth anything itself.
      expect(existsSync(intentsDir(proj))).toBe(false);
    });

    test("Branch 7b births on zero intents (bare valid-scope positional)", () => {
      const r = next(["poc"]);
      const d = JSON.parse(r.stdout.trim());
      expect(d.kind).toBe("print");
      expect(d.message).toContain("intent-birth --scope poc");
      expect(existsSync(intentsDir(proj))).toBe(false);
    });
  });

  // ----------------------------------------------------------------
  // (3) A single intent with the cursor set → the happy path resolves it
  //     (NOT a birth, NOT a prompt) — the active intent's state drives `next`.
  // ----------------------------------------------------------------
  test("one intent with a live cursor resolves to its workflow (neither birth nor prompt)", () => {
    expect(util(["intent-birth", "--scope", "poc"]).status).toBe(0);
    expect(recordDirs(proj).length).toBe(1);
    expect(existsSync(cursorPath(proj))).toBe(true);
    const r = next(["--scope", "poc"]);
    const d = JSON.parse(r.stdout.trim());
    // The lone born intent has a live cursor + state → the engine reads its
    // position and advances; it must NOT re-name intent-birth nor prompt to pick.
    expect(d.kind).not.toBe("ask");
    if (d.kind === "print") expect(d.message).not.toContain("intent-birth");
    // The cursor was never disturbed.
    const cursor = readFileSync(cursorPath(proj), "utf-8").trim();
    expect(recordDirs(proj)).toContain(cursor);
  });
});
