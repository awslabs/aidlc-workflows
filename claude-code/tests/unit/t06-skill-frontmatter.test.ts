// covers: file:skills/aidlc/SKILL.md, file:settings.json
//
// t06 — orchestrator SKILL.md frontmatter + the v0.6.0 hooks-move contract.
// Migrated from tests/unit/t06-skill-frontmatter.sh (TAP plan 9, 9 assertions,
// all grep/not-grep over two shipped dist/ assets — no spawn, no tool function).
//
// Mechanism: none. The .sh asserted on the literal BYTES of two shipped files;
// the twin reads the same two files in-process and asserts on their parsed
// structure. There is no process boundary, no exit code, no stdout, and no LLM
// here — the subject is a static file-asset contract, so the body imports
// nothing executable and only reads/parses. (Per milestone 3 body-derived mechanism:
// zero driver calls => mechanism none.)
//
// As of the v0.6.0 hooks-move (Fork 2->B), the orchestrator's SKILL.md no
// longer carries a `hooks:` block — all framework hooks register project-wide
// in settings.json. This test pins the SURVIVING SKILL.md frontmatter
// (name/description/user-invocable) AND that the hooks moved OUT of the
// SKILL.md frontmatter and INTO settings.json. The registration is the
// contract here; t131 covers the firing behaviour.
//
// Files under test (read from the shipped tree, AIDLC_SRC = dist/claude/.claude):
//   skills/aidlc/SKILL.md  — YAML frontmatter delimited by the first two `---`
//     lines (SKILL.md:1-14). Fields asserted: name, description, user-invocable;
//     the absence of a top-level `hooks:` key in that block.
//   settings.json          — the project-wide hook registration. PostToolUse
//     Write|Edit matcher carries aidlc-audit-logger.ts; PreCompact carries
//     aidlc-validate-state.ts; SubagentStop carries aidlc-log-subagent.ts.
//
// Old TAP -> new test parity (1:1, every .sh assertion -> a named test()):
//   .sh 1  assert_grep SKILL  "^name: aidlc"                  -> "frontmatter declares name: aidlc"
//   .sh 2  assert_grep SKILL  "^description:"                 -> "frontmatter carries a description field"
//   .sh 3  assert_grep SKILL  "^user-invocable: true"         -> "frontmatter is user-invocable: true"
//   .sh 4  assert_not_grep SKILL "^hooks:"                    -> "frontmatter carries NO hooks: block (moved to settings.json)"
//   .sh 5  assert_grep SETTINGS "aidlc-audit-logger.ts"       -> "settings.json registers aidlc-audit-logger.ts"
//   .sh 6  assert_grep SETTINGS "\"PostToolUse\""             -> "settings.json registers a PostToolUse hook block"
//   .sh 7  assert_grep SETTINGS "\"PreCompact\""              -> "settings.json registers a PreCompact hook block"
//   .sh 8  assert_grep SETTINGS "aidlc-validate-state.ts"     -> "settings.json references aidlc-validate-state.ts"
//   .sh 9  assert_grep SETTINGS "aidlc-log-subagent.ts"       -> "settings.json references aidlc-log-subagent.ts"
//
// Equal-or-stronger: each .sh did a whole-file grep. The twin instead parses
// the frontmatter block and the settings JSON, so the field/key checks are
// BLOCK-SCOPED (a `name:` in the SKILL body prose would not satisfy them, and
// the no-hooks check is scoped to the frontmatter — the SKILL body legitimately
// mentions "settings.json hooks" in prose). The settings.json checks bind each
// hook command to the CORRECT event array (PostToolUse / PreCompact /
// SubagentStop), stronger than the .sh's "appears anywhere in the file" grep.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AIDLC_SRC } from "../harness/fixtures.ts";

const SKILL = join(AIDLC_SRC, "skills", "aidlc", "SKILL.md");
const SETTINGS = join(AIDLC_SRC, "settings.json");

/**
 * Extract the YAML frontmatter block — the lines BETWEEN the first two `---`
 * delimiters — from SKILL.md. Anything in the document body (prose, code
 * fences) is excluded, so a `name:`/`hooks:` mention in the body cannot satisfy
 * a frontmatter assertion. Mirrors the `^field:` anchoring the .sh grepped for,
 * but scoped to the block instead of the whole file.
 */
function frontmatterLines(): string[] {
  const text = readFileSync(SKILL, "utf-8");
  const lines = text.split("\n");
  expect(lines[0]).toBe("---"); // opening delimiter on line 1
  const close = lines.indexOf("---", 1);
  expect(close).toBeGreaterThan(0); // closing delimiter exists
  return lines.slice(1, close);
}

/** True iff some frontmatter line matches /^<field>:/ (top-level YAML key). */
function frontmatterHasKey(field: string): boolean {
  const re = new RegExp(`^${field}:`);
  return frontmatterLines().some((l) => re.test(l));
}

interface HookEntry {
  type: string;
  command: string;
}
interface HookBlock {
  matcher?: string;
  hooks: HookEntry[];
}
interface Settings {
  hooks?: Record<string, HookBlock[]>;
}

function settings(): Settings {
  return JSON.parse(readFileSync(SETTINGS, "utf-8")) as Settings;
}

/** All hook commands registered under a given event name in settings.json. */
function commandsForEvent(event: string): string[] {
  const blocks = settings().hooks?.[event] ?? [];
  return blocks.flatMap((b) => b.hooks.map((h) => h.command));
}

describe("t06 SKILL.md frontmatter (migrated from t06-skill-frontmatter.sh, plan 9)", () => {
  // --- SKILL.md frontmatter (.sh tests 1-4) --------------------------------
  test("frontmatter declares name: aidlc [.sh 1]", () => {
    // STRONGER than `grep ^name: aidlc`: the value is read from inside the
    // frontmatter block and matched exactly.
    const nameLine = frontmatterLines().find((l) => /^name:/.test(l));
    expect(nameLine).toBe("name: aidlc");
  });

  test("frontmatter carries a description field [.sh 2]", () => {
    // The shipped SKILL uses a folded block scalar: `description: >`.
    expect(frontmatterHasKey("description")).toBe(true);
  });

  test("frontmatter is user-invocable: true [.sh 3]", () => {
    const line = frontmatterLines().find((l) => /^user-invocable:/.test(l));
    expect(line).toBe("user-invocable: true");
  });

  test("frontmatter carries NO hooks: block — moved to settings.json [.sh 4]", () => {
    // The v0.6.0 hooks-move contract. STRONGER than the .sh's whole-file
    // `assert_not_grep "^hooks:"`: scoped to the frontmatter block, so the
    // SKILL body's prose about settings.json hooks cannot trip a false negative.
    expect(frontmatterHasKey("hooks")).toBe(false);
  });

  // --- settings.json hook registration (.sh tests 5-9) ---------------------
  test("settings.json registers aidlc-audit-logger.ts on PostToolUse [.sh 5 + 6]", () => {
    // .sh 5: aidlc-audit-logger.ts appears; .sh 6: a PostToolUse block exists.
    // STRONGER: the audit-logger command is bound to the PostToolUse event
    // (the .sh only proved each appears SOMEWHERE in the file independently).
    const postCmds = commandsForEvent("PostToolUse");
    expect(postCmds.length).toBeGreaterThan(0); // PostToolUse block present (.sh 6)
    expect(
      postCmds.some((c) => c.includes("aidlc-audit-logger.ts")),
    ).toBe(true); // audit-logger registered there (.sh 5)
  });

  test("settings.json registers aidlc-validate-state.ts on PreCompact [.sh 7 + 8]", () => {
    // .sh 7: a PreCompact block exists; .sh 8: aidlc-validate-state.ts appears.
    // STRONGER: validate-state is the PreCompact hook (not just present).
    const preCompactCmds = commandsForEvent("PreCompact");
    expect(preCompactCmds.length).toBeGreaterThan(0); // PreCompact block present (.sh 7)
    expect(
      preCompactCmds.some((c) => c.includes("aidlc-validate-state.ts")),
    ).toBe(true); // validate-state registered there (.sh 8)
  });

  test("settings.json registers aidlc-log-subagent.ts on SubagentStop [.sh 9]", () => {
    // STRONGER: log-subagent is the SubagentStop hook, the event that owns it
    // (the .sh only proved the filename appears anywhere in settings.json).
    const subagentCmds = commandsForEvent("SubagentStop");
    expect(
      subagentCmds.some((c) => c.includes("aidlc-log-subagent.ts")),
    ).toBe(true);
  });
});
