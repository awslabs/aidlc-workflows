// covers: hook:aidlc-session-start
//
// t275 — a COMPLETED workflow must name the path to new work, in every surface
// that speaks to the conductor. Mechanism: cli (spawns the real hook + engine).
//
// THE BUG THIS PINS. A completed intent is a finished record, never a container
// to re-enter, so the only move onward is to birth a NEW intent. That move
// (`next --new-intent` → `intent-birth`) used to appear in no directive, no hook
// message, and no help text, while the session-start hook simultaneously told the
// conductor to offer "the standard resume options (Resume / Redo / Jump / Start
// Fresh)" — a four-option menu defined NOWHERE:
//
//   - "Start Fresh" appeared in exactly one place in the whole authored tree: the
//     hook instructing the conductor to offer it.
//   - "Redo" IS defined elsewhere — as the intra-stage Keep/Modify/Redo gate loop
//     (aidlc-common/protocols/stage-protocol.md) — which is a different thing
//     entirely, so a conductor that went looking found an actively misleading
//     definition rather than none.
//
// Every scope runner (aidlc-runner-gen.ts) forwards freeform text into `next` and
// terminates its loop on `{kind:"done"}`, so the observable failure was: close a
// workflow, type a new request, get told "Workflow complete", and stop. Reported
// live against the `vibe` scope, where "one session per container" is by design
// and so the closed case is the NORMAL one from the second session onward.
//
// WHAT EACH GUARD DOES AND DOES NOT CATCH — stated because a guard whose real
// coverage is unstated gets read as broader than it is:
//   1-2. Behavioural, per surface: the hook's Completed branch and the engine's
//        `done` directive must NAME `--new-intent`. These catch a regression that
//        drops the signpost.
//   3.   Vocabulary: the two dangling menu names must not come back. This is a
//        literal-string guard — it catches the exact regression, not the class.
//   4.   Dangling-reference class guard: every `--flag` the hook's message names
//        must be a flag the engine's parser actually recognises. This catches
//        "the prose names a command that does not exist", which is the general
//        shape of the bug. It would NOT have caught "Start Fresh" (not a flag) —
//        guard 3 owns that case. The pair is honest; neither alone is.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createOrchestrationTestProject,
  createTestProject,
  FIXTURES_DIR,
  runOrchestrateNext,
  seedStateFile,
} from "../harness/fixtures.ts";

const BUN = process.execPath;
const HOOK = join(AIDLC_SRC, "hooks", "aidlc-session-start.ts");
const ORCHESTRATE = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
const ENGINE_SRC = readFileSync(ORCHESTRATE, "utf-8");

const COMPLETED = join(FIXTURES_DIR, "state-completed.md");
const CONSTRUCTION = join(FIXTURES_DIR, "state-construction.md");

// The two names that were offered to the conductor while resolving to nothing
// (or, for "Redo", to a different mechanism). Neither may return to this message.
const DANGLING_MENU_NAMES = ["Start Fresh", "Redo"];

let proj: string;

/** Fire the real session-start hook with an empty (non-TTY) stdin, as t10 does. */
function fireHook(p: string): string {
  const r = Bun.spawnSync({
    cmd: [BUN, HOOK],
    stdin: new TextEncoder().encode(""),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, CLAUDE_PROJECT_DIR: p },
  });
  const stdout = new TextDecoder().decode(r.stdout);
  let parsed: { additionalContext?: string };
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    throw new Error(
      `session-start hook did not emit parseable JSON. stdout=${JSON.stringify(stdout.slice(0, 400))} stderr=${JSON.stringify(new TextDecoder().decode(r.stderr).slice(0, 400))}`,
    );
  }
  return parsed.additionalContext ?? "";
}

/** The guidance block: everything after `Next Action:` up to the discipline block. */
function guidanceOf(context: string): string {
  const m = context.match(/Next Action:[^\n]*\n([\s\S]*?)\n\nFORWARDING-LOOP/);
  if (!m) {
    throw new Error(
      `could not locate the guidance block in the emitted context:\n${context.slice(0, 600)}`,
    );
  }
  return m[1];
}

describe("t275 a completed workflow names the new-intent path (mechanism cli)", () => {
  beforeEach(() => {
    proj = createTestProject();
  });

  afterEach(() => {
    cleanupTestProject(proj);
  });

  test("1. hook on a COMPLETED workflow names --new-intent and does not offer resume", () => {
    seedStateFile(proj, COMPLETED);
    const guidance = guidanceOf(fireHook(proj));

    if (!guidance.includes("--new-intent")) {
      throw new Error(
        "the Completed branch does not name `--new-intent`. A completed intent " +
          "cannot be re-entered, so this message is the conductor's only pointer " +
          `to the one move that works. Got:\n${guidance}`,
      );
    }
    // The failure the user actually hit: being told the fact instead of the move.
    expect(guidance).toMatch(/COMPLETE/);
    expect(guidance).not.toMatch(/On resume: offer/);
  });

  test("2. engine `done` on a completed workflow names --new-intent", () => {
    const orchProj = createOrchestrationTestProject();
    try {
      seedStateFile(orchProj, COMPLETED);
      const r = runOrchestrateNext(ORCHESTRATE, orchProj, [
        "--scope",
        "feature",
        "add an unrelated second feature",
      ]);
      const reason = String(r.directive?.reason ?? r.out);
      if (!reason.includes("--new-intent")) {
        throw new Error(
          "the `done` directive states the workflow is complete without naming " +
            "the new-work move. Every scope runner ends its loop on `done`, so a " +
            "user who typed a new request here is simply told to stop. " +
            `Got kind=${String(r.directive?.kind)} reason=${JSON.stringify(reason)}`,
        );
      }
    } finally {
      cleanupTestProject(orchProj);
    }
  });

  test("3. the resume guidance never offers a menu name that resolves to nothing", () => {
    for (const fixture of [COMPLETED, CONSTRUCTION]) {
      const p = createTestProject();
      try {
        seedStateFile(p, fixture);
        const guidance = guidanceOf(fireHook(p));
        for (const name of DANGLING_MENU_NAMES) {
          if (guidance.includes(name)) {
            throw new Error(
              `guidance for ${fixture.split("/").pop()} offers "${name}". ` +
                `"Start Fresh" resolves to no command anywhere in the framework, and ` +
                `"Redo" is defined in stage-protocol.md as the INTRA-STAGE gate loop — ` +
                `a different mechanism. Name a runnable command instead of a menu label.`,
            );
          }
        }
      } finally {
        cleanupTestProject(p);
      }
    }
  });

  test("4. every --flag the guidance names is a flag the engine parses", () => {
    for (const fixture of [COMPLETED, CONSTRUCTION]) {
      const p = createTestProject();
      try {
        seedStateFile(p, fixture);
        const guidance = guidanceOf(fireHook(p));
        const flags = [...guidance.matchAll(/--([a-z][a-z-]+)/g)].map((m) => m[1]);
        expect(flags.length).toBeGreaterThan(0); // a guidance block naming no flag is not being checked at all
        for (const flag of new Set(flags)) {
          // The engine's parser matches on the bare token; requiring the literal
          // to appear in its source is the cheapest honest existence check.
          if (!ENGINE_SRC.includes(`"--${flag}"`) && !ENGINE_SRC.includes(`--${flag}`)) {
            throw new Error(
              `guidance names \`--${flag}\`, which does not appear in the engine ` +
                `source at all — the conductor is being told to run a flag that ` +
                `does not exist. (${fixture.split("/").pop()})`,
            );
          }
        }
      } finally {
        cleanupTestProject(p);
      }
    }
  });

  test("5. `intent birth` is discoverable from --help", () => {
    // The capability existed and was documented only in a source comment: the
    // help listed `intent list` and `intent switch` but not the verb that starts
    // a second workflow, so the documented path to new work was unfindable.
    const utility = readFileSync(join(AIDLC_SRC, "tools", "aidlc-utility.ts"), "utf-8");
    const help = utility.match(/Utilities:[\s\S]*?Other:/)?.[0] ?? "";
    expect(help).toContain("intent list");
    if (!help.includes("intent birth")) {
      throw new Error(
        "`intent birth` is missing from the help text. It is the only verb that " +
          "starts a workflow alongside an existing one, and a completed workflow " +
          "cannot be resumed — so omitting it leaves no discoverable path forward.",
      );
    }
  });
});
