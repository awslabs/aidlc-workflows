// covers: ensemble-protocol:per-harness-binding-parity
//
// t333 — ENSEMBLE PROTOCOL HARNESS-BINDING PARITY GATE. Mechanism: none
// (readFileSync over the shared core protocol file, zero spawn, zero LLM,
// zero tokens). Technique: deterministic closed predicate over the
// manifest-discovered harness matrix, so a ninth harness cannot ship
// without a `### <Harness>` binding section and the Devin section cannot
// silently drop the `profile`-field mechanic, the `is_background` split,
// or the model-resolution note.
//
// WHY THIS EXISTS: Devin shipped as the eighth harness WITHOUT a `### Devin`
// binding section in `core/aidlc-common/protocols/stage-protocol-ensemble.md`.
// The conductor had no Devin-specific topology guidance and could fall back
// to inline execution, skipping the `deliver-stage-rules` and `log-subagent`
// hooks and breaking the ensemble's completion-evidence contract. The fix
// (commit 10a0fbd0) added the section; this gate keeps it from regressing
// and keeps a future ninth harness from repeating the gap.
//
// The three Devin-specific invariants without which the hooks silently do
// not fire or the model silently downgrades:
//   - `profile`       — the adapter and the deliver-stage-rules /
//                       plan-approval-guard hooks match on tool_input.profile,
//                       not the prompt text; omitting it silently skips them.
//   - `is_background` — parallel dispatch requires background subagents;
//                       foreground subagents run inline (parent pauses).
//   - default subagent model — a dispatched agent with no `model:` frontmatter
//                       runs on SWE-1.6 (or the org override), not the
//                       parent's model; the conductor must be able to reason
//                       about the dispatch-vs-inline quality tradeoff.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../harness/fixtures.ts";
import { HARNESS_MATRIX, type ShippedHarnessName } from "../harness/harness-matrix.ts";

const PROTOCOL_PATH = join(
  REPO_ROOT,
  "core",
  "aidlc-common",
  "protocols",
  "stage-protocol-ensemble.md",
);

// The display name each harness uses as its `### <Name>` heading in the
// protocol file. Kept in lockstep with the file; a retitle is a one-line
// edit here.
const HARNESS_DISPLAY_NAMES: Record<ShippedHarnessName, string> = {
  claude: "Claude Code",
  codex: "Codex CLI",
  copilot: "GitHub Copilot",
  cursor: "Cursor",
  devin: "Devin",
  kiro: "Kiro CLI",
  "kiro-ide": "Kiro IDE",
  opencode: "opencode",
};

// The two structural invariants every binding shares (per the fix plan's
// "Test impact" section). A binding that drops either is not a binding.
const SHARED_BINDING_TOKENS = [
  "Pipeline receipt rule",
  "directive.mode` tells you HOW to run the body",
];

// The three Devin-specific invariants (per the fix plan). A Devin binding
// that drops any of them silently reintroduces the gap under a different
// name.
const DEVIN_SPECIFIC_TOKENS = [
  "profile", // the hook-firing prerequisite
  "is_background", // the parallel-dispatch mechanism
  "default subagent model", // the model-resolution tradeoff
];

function sectionBody(protocol: string, displayName: string): string {
  const heading = `### ${displayName}`;
  const start = protocol.indexOf(heading);
  expect(start, `### ${displayName} binding section missing`).toBeGreaterThan(
    -1,
  );
  // A binding section ends at the next `---` separator (or end of file for
  // the last section). The `### GitHub Copilot` and `### Devin` sections are
  // the last two; Devin is the file's final section.
  const nextSep = protocol.indexOf("\n---", start + heading.length);
  const end = nextSep === -1 ? protocol.length : nextSep;
  return protocol.slice(start, end);
}

describe("t333 ensemble protocol harness-binding parity", () => {
  const protocol = readFileSync(PROTOCOL_PATH, "utf-8");

  test("every shipped harness has a `### <Display Name>` binding section", () => {
    const missing: string[] = [];
    for (const harness of HARNESS_MATRIX) {
      const displayName = HARNESS_DISPLAY_NAMES[harness.name];
      if (!protocol.includes(`### ${displayName}\n`)) {
        missing.push(`${harness.name} (### ${displayName})`);
      }
    }
    expect(missing, "harnesses without a ### binding section").toEqual([]);
  });

  test("every binding section carries the pipeline receipt rule and the directive.mode paragraph", () => {
    const failures: string[] = [];
    for (const harness of HARNESS_MATRIX) {
      const displayName = HARNESS_DISPLAY_NAMES[harness.name];
      const body = sectionBody(protocol, displayName);
      for (const token of SHARED_BINDING_TOKENS) {
        if (!body.includes(token)) {
          failures.push(`${harness.name}  missing: ${token}`);
        }
      }
    }
    expect(failures).toEqual([]);
  });

  test("the Devin binding names run_subagent, the profile field, the is_background split, and the default subagent model", () => {
    const body = sectionBody(protocol, "Devin");
    // The dispatch verb — the whole point of the binding.
    expect(body).toContain("run_subagent");
    // The three Devin-specific invariants.
    for (const token of DEVIN_SPECIFIC_TOKENS) {
      expect(body, `Devin binding missing: ${token}`).toContain(token);
    }
    // The ask_user_question-withheld constraint (mob mid-stage human
    // surfacing is the parent conductor's job, not a dispatched spoke's).
    expect(body).toContain("ask_user_question");
    // The nesting-depth-0 rule (the parent dispatches every participant).
    expect(body).toContain("nesting depth defaults to 0");
  });

  test("the Devin SKILL.md carries the must-dispatch instruction", () => {
    const skill = readFileSync(
      join(REPO_ROOT, "harness/devin/skills/aidlc/SKILL.md"),
      "utf-8",
    );
    expect(skill).toContain("Dispatched topologies must dispatch");
    expect(skill).toContain("profile");
    expect(skill).toContain("is_background");
    expect(skill).toContain("failure-recovery protocol");
  });
});
