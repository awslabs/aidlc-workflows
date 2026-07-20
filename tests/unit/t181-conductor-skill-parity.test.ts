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
// Every manifest-discovered authored SKILL carries the full vocabulary and none
// carries a bare `--init`, so the POSITIVE set needs no per-harness carve-out.
// The gate asserts the shipped AUTHORED surface
// (harness/<h>/skills/aidlc/SKILL.md), the FIRST surface that defines a
// harness's orchestrator vocabulary; dist is its byte-parity-guarded copy
// (t148/package.ts --check), so gating the authored source covers every tree.

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

const LEARNINGS_QUESTION_TOKENS = [
  "at least two explicit options",
  "Nothing to add",
  "Add a note",
  "one-option",
  "even when `surface` returns zero candidates",
  "never infer `Nothing to add`",
];

const APPROVAL_REPORT_TOKEN =
  '--result approved --user-input "<exact choice>"';

const ENSEMBLE_TOKENS = [
  "directive.single === true",
  "directive.rules_in_context",
  "directive.inline_context_paths",
  "`subagent` (hub-and-spoke:",
  "`pipeline` (chain:",
  "`mob` (mesh",
  "ensemble's completion evidence",
  '--result skipped --reason "<specific reason>"',
];

const KIRO_TASK_LIST_TOKEN =
  '{command:"create", task_list_description:"...", tasks:[{task_description:"..."}]}';

const KIRO_SUBAGENT_TOKEN =
  '{mode:"blocking", task:"...", stages:[{name:"...", role:"aidlc-...", prompt_template:"..."}]}';

function stageTableRows(body: string): string[] {
  const lines = body.split(/\r?\n/);
  const start = lines.indexOf("## Stage Graph");
  if (start < 0) return [];
  const end = lines.findIndex((line, index) => index > start && line === "---");
  if (end < 0) return [];
  return lines
    .slice(start, end)
    .filter((line) => line.startsWith("|"))
    .slice(2);
}

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

  test("every shipped conductor SKILL requires a valid two-option learning question", () => {
    const missing: string[] = [];
    for (const rel of skills) {
      const body = readFileSync(join(REPO_ROOT, rel), "utf-8");
      for (const tok of LEARNINGS_QUESTION_TOKENS) {
        if (!body.includes(tok)) missing.push(`${rel}  missing: ${tok}`);
      }
    }
    expect(missing).toEqual([]);
  });

  test("every shipped conductor SKILL records the exact approval choice", () => {
    const missing: string[] = [];
    for (const rel of skills) {
      const body = readFileSync(join(REPO_ROOT, rel), "utf-8");
      if (!body.includes(APPROVAL_REPORT_TOKEN)) {
        missing.push(`${rel}  missing: ${APPROVAL_REPORT_TOKEN}`);
      }
    }
    expect(missing).toEqual([]);
  });

  test("every shipped conductor SKILL carries the ensemble execution contract", () => {
    const missing: string[] = [];
    for (const rel of skills) {
      const body = readFileSync(join(REPO_ROOT, rel), "utf-8");
      for (const tok of ENSEMBLE_TOKENS) {
        if (!body.includes(tok)) missing.push(`${rel}  missing: ${tok}`);
      }
    }
    expect(missing).toEqual([]);
  });

  test("autonomous review logging uses the main harness tool with a worktree target", () => {
    const offenders: string[] = [];
    for (const rel of skills) {
      const body = readFileSync(join(REPO_ROOT, rel), "utf-8");
      if (!body.includes('--project-dir "<worktree>"')) {
        offenders.push(`${rel}  missing worktree project target`);
      }
      if (/bun "<worktree>\/\.[^/]+\/tools\/aidlc-log\.ts"/.test(body)) {
        offenders.push(`${rel}  resolves the logger inside the worktree`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("every harness Stage Graph table matches the canonical generated table", () => {
    const canonicalRel = "harness/claude/skills/aidlc/SKILL.md";
    const canonical = stageTableRows(
      readFileSync(join(REPO_ROOT, canonicalRel), "utf-8"),
    );
    expect(canonical.length).toBeGreaterThan(0);
    for (const rel of skills) {
      expect(stageTableRows(readFileSync(join(REPO_ROOT, rel), "utf-8")), rel)
        .toEqual(canonical);
    }
  });

  test("Kiro conductor SKILLs pin the native todo_list schema", () => {
    const missing: string[] = [];
    for (const harness of ["kiro", "kiro-ide"]) {
      const rel = `harness/${harness}/skills/aidlc/SKILL.md`;
      const body = readFileSync(join(REPO_ROOT, rel), "utf-8");
      if (!body.includes(KIRO_TASK_LIST_TOKEN)) {
        missing.push(`${rel}  missing: ${KIRO_TASK_LIST_TOKEN}`);
      }
    }
    expect(missing).toEqual([]);
  });

  test("Kiro conductor SKILLs pin the native subagent crew schema", () => {
    const missing: string[] = [];
    for (const harness of ["kiro", "kiro-ide"]) {
      const rel = `harness/${harness}/skills/aidlc/SKILL.md`;
      const body = readFileSync(join(REPO_ROOT, rel), "utf-8");
      if (!body.includes(KIRO_SUBAGENT_TOKEN)) {
        missing.push(`${rel}  missing: ${KIRO_SUBAGENT_TOKEN}`);
      }
    }
    expect(missing).toEqual([]);
  });

  test("Kiro file-backed questions are presented as numbered prose", () => {
    const missing: string[] = [];
    for (const harness of ["kiro", "kiro-ide"]) {
      const skillRel = `harness/${harness}/skills/aidlc/SKILL.md`;
      const annexRel =
        `harness/${harness}/skills/aidlc/question-rendering.md`;
      const skill = readFileSync(join(REPO_ROOT, skillRel), "utf-8");
      const annex = readFileSync(join(REPO_ROOT, annexRel), "utf-8");
      if (!skill.includes("interactive presentation remaps")) {
        missing.push(`${skillRel}  missing remap instruction`);
      }
      if (!skill.includes("user never answers with file letters")) {
        missing.push(`${skillRel}  missing no-letter answer rule`);
      }
      if (!annex.includes("remap those choices to numbered prose")) {
        missing.push(`${annexRel}  missing numbered file-choice rule`);
      }
      if (!annex.includes("Never present file letters as response keys")) {
        missing.push(`${annexRel}  missing no-letter response rule`);
      }
    }
    expect(missing).toEqual([]);
  });
});
