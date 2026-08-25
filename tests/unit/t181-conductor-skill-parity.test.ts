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
//   (b) POSITIVE — the workspace-anchor vocabulary (`intent-create`, `--repo`,
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

/** Authored question-rendering annexes for every shipped distribution. */
function harnessQuestionAnnexes(): string[] {
  return HARNESS_MATRIX
    .map(
      (harness) =>
        `harness/${harness.name}/skills/aidlc/question-rendering.md`,
    )
    .sort();
}

// A bare `--init` flag token: `--init` not preceded by another flag char — the
// retired aidlc command. NOT `git init`/`npm init` (no leading hyphen). Same
// predicate as t174's `--init` scan.
const BARE_INIT = /(^|[^-\w])--init\b/;

// The workspace-anchor conductor vocabulary every shipped SKILL must define.
const REQUIRED_TOKENS = [
  "intent-create", // run-then-continue birth verb (replaced `init`)
  "stage-protocol-swarm.md", // conditional swarm transport + --repo contract
  "offer a second intent", // P4-completion new-work conductor prose
  "intent and space verbs", // frontmatter utilities tail
];

// The narration layer: the engine authors a spoken line on the directive and
// every harness relays it. The failure this pins is asymmetric and silent - the
// field is emitted harness-independently (aidlc-orchestrate.ts), so a SKILL that
// lacks the relay rule drops it on the floor and the harness keeps narrating its
// own internals with nothing red. That is exactly how it shipped Claude-only
// before this pin existed.
const NARRATION_TOKENS = [
  "narration", // the field name the relay rule is written around
  "**Quiet in between.**", // the resting-state rule between tool calls
  "**SAY:**", // the marker whose quoted text is the only speakable prose
  "the very first turn", // the one moment no carrier reaches
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
  "the first tool calls after receiving `run-stage`",
  "do not batch those reads with later stage reads",
  "blocking context-load precondition",
  "A mob MUST explicitly read its lead persona path first",
  "path's presence in `inline_context_paths` is not evidence",
  "stage-protocol-ensemble.md",
  "directive.protocol_modules",
  '--result skipped --reason "<specific reason>"',
];

const COMPOSER_ROUTE_TOKENS = [
  "**Composition-moment authority.**",
  "apply ONLY to front/report composition",
  "mode: in-flight",
  "`nearest_stock` is advisory",
  "`changes.skip` / `changes.add` arrays",
  "no stock grid or scope-registry write is allowed",
];

const KIRO_TASK_LIST_TOKEN =
  '{command:"create", task_list_description:"...", tasks:[{task_description:"..."}]}';

const KIRO_SUBAGENT_TOKEN =
  '{mode:"blocking", task:"...", stages:[{name:"...", role:"aidlc-...", prompt_template:"..."}]}';

const SUMMARY_STOP_SKILL_TOKENS = [
  "before running the stage body or writing `produces`",
  "checkpoint-specific `aidlc-log.ts decision` / `answer` pair with `--single`",
  "only after that separate human turn and receipt",
  "PRE-GENERATION SUMMARY STOP",
  "before artifact generation, reviewer, learnings, or approval",
  "--checkpoint summary-confirmation --questions-file",
  '`--unit "<directive.unit>"`',
  "`--single`",
  '**"What should change?"**',
];

const SUMMARY_STOP_ANNEX_TOKENS = [
  "## Mandatory consolidated-summary checkpoint",
  "both options without A/B file-letter prefixes",
  "and a blank",
  "END THE TURN",
  "`[Answer]: Looks correct`",
  "`[Answer]: A. Looks correct`, `[Answer]: 1. Looks correct`",
  "a self-selected answer",
  "receipt command succeeds",
  "checkpoint-specific `aidlc-log.ts decision`",
  "checkpoint-specific `aidlc-log.ts answer`",
  '**"What should change?"**',
];

const FRESH_SESSION_TOKENS: Record<string, string[]> = {
  claude: ["/clear", "`/aidlc`"],
  codex: ["restart Codex CLI", "`$aidlc`"],
  kiro: ["restart Kiro CLI", "`/aidlc`"],
  "kiro-ide": ["new Kiro IDE chat", "`/aidlc`"],
  opencode: ["restart OpenCode", "`/aidlc`"],
  copilot: ["new Copilot CLI session", "new VS Code agent chat", "`/aidlc`"],
  cursor: ["new Cursor chat", "`/aidlc`"],
};

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

  test("every shipped conductor SKILL separates in-flight deltas from stock routing", () => {
    const missing: string[] = [];
    for (const rel of skills) {
      const body = readFileSync(join(REPO_ROOT, rel), "utf-8");
      for (const tok of COMPOSER_ROUTE_TOKENS) {
        if (!body.includes(tok)) missing.push(`${rel}  missing: ${tok}`);
      }
    }
    expect(missing).toEqual([]);
  });

  test("every shipped conductor SKILL relays engine-authored narration", () => {
    const missing: string[] = [];
    for (const rel of skills) {
      const body = readFileSync(join(REPO_ROOT, rel), "utf-8");
      for (const tok of NARRATION_TOKENS) {
        if (!body.includes(tok)) missing.push(`${rel}  missing: ${tok}`);
      }
    }
    expect(missing).toEqual([]);
  });

  test("the narration rule is worded identically across every harness", () => {
    // Byte-alignment, not just presence: the rule is authored once and ported,
    // so a per-harness reword is drift. Extracted by its own anchors rather than
    // line numbers, which move as each SKILL gains harness-specific prose.
    const blocks = new Map<string, string[]>();
    for (const rel of skills) {
      const body = readFileSync(join(REPO_ROOT, rel), "utf-8");
      const start = body.indexOf("**Saying what is happening");
      const end = body.indexOf("**Isolated stage-runner branch.**");
      expect(start, `${rel} lacks the narration rule`).toBeGreaterThan(-1);
      expect(end, `${rel} lacks the isolated-run anchor`).toBeGreaterThan(start);
      const block = body.slice(start, end).trim();
      const seen = blocks.get(block) ?? [];
      seen.push(rel);
      blocks.set(block, seen);
    }
    // One distinct block text => every harness agrees.
    expect([...blocks.values()].map((v) => v.sort())).toHaveLength(1);
  });

  test("every shipped conductor SKILL stops new-intent births and names its fresh-session flow", () => {
    const failures: string[] = [];
    for (const harness of HARNESS_MATRIX) {
      const rel = `harness/${harness.name}/skills/aidlc/SKILL.md`;
      const body = readFileSync(join(REPO_ROOT, rel), "utf-8");
      for (const token of [
        "**run-then-stop**",
        "Then **STOP and hand off to a fresh session** rather than re-running `next`",
        ...(FRESH_SESSION_TOKENS[harness.name] ?? []),
      ]) {
        if (!body.includes(token)) failures.push(`${rel}  missing: ${token}`);
      }
      if (body.includes("run it, then re-run `next` to land on the new intent's first stage")) {
        failures.push(`${rel}  still continues a new intent in the prior session`);
      }
    }
    expect(failures).toEqual([]);
  });

  test("Codex conductor guidance uses its native $aidlc invocation", () => {
    const body = readFileSync(
      join(REPO_ROOT, "harness/codex/skills/aidlc/SKILL.md"),
      "utf-8",
    );
    for (const stale of [
      "`/aidlc --resume`",
      "fresh `/aidlc`",
      "`/aidlc intent",
      "`/aidlc space",
      "on `/aidlc compose",
      "second `/aidlc` invocation",
    ]) {
      expect(body).not.toContain(stale);
    }
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

  test("conditional swarm module keeps autonomous review logging on the main tool", () => {
    const body = readFileSync(
      join(
        REPO_ROOT,
        "core",
        "aidlc-common",
        "protocols",
        "stage-protocol-swarm.md",
      ),
      "utf-8",
    );
    expect(body).toContain('--project-dir "<worktree>"');
    expect(body).not.toMatch(
      /bun "<worktree>\/\.[^/]+\/tools\/aidlc-log\.ts"/,
    );
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

  test("every conductor stops for summary confirmation before artifact work", () => {
    const missing: string[] = [];
    for (const rel of skills) {
      const body = readFileSync(join(REPO_ROOT, rel), "utf-8");
      for (const token of SUMMARY_STOP_SKILL_TOKENS) {
        if (!body.includes(token)) {
          missing.push(`${rel}  missing: ${token}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  test("every question renderer pins the mandatory summary checkpoint", () => {
    const missing: string[] = [];
    for (const rel of harnessQuestionAnnexes()) {
      const body = readFileSync(join(REPO_ROOT, rel), "utf-8");
      for (const token of SUMMARY_STOP_ANNEX_TOKENS) {
        if (!body.includes(token)) {
          missing.push(`${rel}  missing: ${token}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  test("Codex routes typed new-work questions through next, not report", () => {
    const annex = readFileSync(
      join(
        REPO_ROOT,
        "harness/codex/skills/aidlc/question-rendering.md",
      ),
      "utf-8",
    );
    expect(annex).toContain('ask_type: "new-work-routing"');
    expect(annex).toContain("routes through `next`");
    expect(annex).toContain("never through `report`");
  });

  test("prose renderers remap file-backed source letters to numbered prose", () => {
    const missing: string[] = [];
    for (const harness of ["cursor", "kiro", "kiro-ide"]) {
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
      if (!annex.includes("1. **Looks correct**")) {
        missing.push(`${annexRel}  missing numbered Looks correct option`);
      }
      if (!annex.includes("options have no source letters")) {
        missing.push(`${annexRel}  missing file-label exception`);
      }
    }
    expect(missing).toEqual([]);
  });

  test("every prose question renderer starts a fresh local numbering scope", () => {
    const missing: string[] = [];
    for (const harness of [
      "copilot",
      "codex",
      "cursor",
      "kiro",
      "kiro-ide",
      "opencode",
    ]) {
      const rel = `harness/${harness}/skills/aidlc/question-rendering.md`;
      const body = readFileSync(join(REPO_ROOT, rel), "utf-8");
      if (!body.includes("start every question at `1`")) {
        missing.push(`${rel}  missing fresh numbering`);
      }
      if (!/Use unordered\s+bullets/.test(body)) {
        missing.push(`${rel}  missing summary-list separation`);
      }
      if (!/Visible `1`\s+maps/.test(body)) {
        missing.push(`${rel}  missing visible-key mapping`);
      }
    }
    expect(missing).toEqual([]);
  });
});
