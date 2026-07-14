// covers: conductor-skill:per-harness-freshness
//
// t181 — PER-HARNESS CONDUCTOR-SKILL FRESHNESS GATE. Mechanism: none
// (readFileSync over harness/*/skills/aidlc/SKILL.md, zero spawn, zero LLM, zero
// tokens). Technique: deterministic closed predicate over the shared,
// manifest-discovered harness matrix, so a new harness cannot escape the gate.
//
// WHY THIS EXISTS (the P11 "RESOLVE (2)" obligation): the workspace refactor
// (per-intent layout, --init retirement, intent/space verbs, multi-repo --repo,
// the "offer a second intent" conductor prose) updated every authored conductor
// SKILL — EXCEPT harness/kiro-ide/skills/aidlc/SKILL.md, which was a stale fork
// byte-identical to kiro CLI's SKILL at origin/v2 and never re-synced across the
// 43-commit stack. It shipped GREEN because NO test reads a per-harness conductor
// SKILL: `package.ts --check` only proves dist==authored, so a self-consistent-
// but-stale authored SKILL passes. This gate closes that hole in BOTH directions:
//   (a) NEGATIVE — the retired `/aidlc --init` command (a bare `--init` flag
//       token; `git init`/`npm init` are NOT the aidlc command, same predicate as
//       t174) must be ABSENT from every shipped conductor SKILL.
//   (b) POSITIVE — the workspace-anchor vocabulary (`intent-birth`, `--repo`,
//       "offer a second intent", "intent and space verbs") must be PRESENT in
//       every shipped conductor SKILL. Catches a future fork that drops `--init`
//       yet still lacks the new verbs.
//
// All four authored SKILLs (claude, codex, kiro, kiro-ide) carry the full
// vocabulary today and none carry a bare `--init`, so the POSITIVE set needs no
// per-harness carve-out — codex included. The gate asserts the shipped AUTHORED
// surface (harness/<h>/skills/aidlc/SKILL.md), the FIRST surface that defines a
// harness's orchestrator vocabulary; dist is its byte-parity-guarded copy (t148/
// package.ts --check), so gating the authored source covers every tree.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../harness/fixtures.ts";
import { HARNESS_MATRIX } from "../harness/harness-matrix.ts";

/** Authored conductor SKILLs for every manifest-discovered distribution. */
function harnessSkills(): string[] {
  return HARNESS_MATRIX
    .map((harness) => `harness/${harness.name}/skills/aidlc/SKILL.md`)
    .sort();
}

// A bare `--init` flag token: `--init` not preceded by another flag char — the
// retired aidlc command. NOT `git init`/`npm init` (no leading hyphen). Same
// predicate as t174's `--init` scan.
const BARE_INIT = /(^|[^-\w])--init\b/;

// The workspace-anchor conductor vocabulary every shipped SKILL must define.
const REQUIRED_TOKENS = [
  "intent-birth", // run-then-continue birth verb (replaced `init`)
  "--repo", // multi-repo swarm prepare flag
  "offer a second intent", // P4-completion new-work conductor prose
  "intent and space verbs", // frontmatter utilities tail
];

describe("t181 per-harness conductor-SKILL freshness gate (P11 RESOLVE-2)", () => {
  const skills = harnessSkills();

  test("the matrix-derived harness-SKILL set covers every shipped tree", () => {
    expect(skills.length).toBe(HARNESS_MATRIX.length);
    for (const rel of skills) expect(existsSync(join(REPO_ROOT, rel)), rel).toBe(true);
  });

  test("no shipped conductor SKILL carries the retired `--init` command", () => {
    const offenders: string[] = [];
    for (const rel of skills) {
      const lines = readFileSync(join(REPO_ROOT, rel), "utf-8").split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (BARE_INIT.test(lines[i])) {
          offenders.push(`${rel}:${i + 1}  ${lines[i].trim()}`);
        }
      }
    }
    // Surface the exact stale line so a fix is a one-line diff (rewrite to the
    // workspace model). A bare `--init` is a genuine bug, never allowlisted.
    expect(offenders).toEqual([]);
  });

  test("every shipped conductor SKILL carries the workspace-anchor vocabulary", () => {
    const missing: string[] = [];
    for (const rel of skills) {
      const body = readFileSync(join(REPO_ROOT, rel), "utf-8");
      for (const tok of REQUIRED_TOKENS) {
        if (!body.includes(tok)) missing.push(`${rel}  missing: ${tok}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
