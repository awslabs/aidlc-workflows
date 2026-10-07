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
// byte-identical to kiro CLI's SKILL at origin/main and never re-synced across the
// 43-commit stack. It shipped GREEN because NO test reads a per-harness conductor
// SKILL: package determinism cannot detect a self-consistent but stale authored
// SKILL. This gate closes that hole in BOTH directions:
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
// harness's orchestrator vocabulary; dist is regenerated from that source, so
// gating the authored source covers every tree.

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../harness/fixtures.ts";
import { HARNESS_MATRIX } from "../harness/harness-matrix.ts";

/** Authored conductor SKILLs for every manifest-discovered distribution. */
// The tools that hide the Stop note from the person, by the name the skill
// gives them; their agent says the carrying-on line itself.
const SAYS_THE_LINE: Record<string, string> = {
  "harness/kiro/skills/aidlc/SKILL.md": "Kiro CLI",
  "harness/kiro-ide/skills/aidlc/SKILL.md": "Kiro IDE",
  "harness/opencode/skills/aidlc/SKILL.md": "opencode",
};

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
  "intent-create", // run-then-continue creation verb (replaced `init`)
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

const CONFIG_ALIAS_TOKENS = [
  "--config [section]",
  "**In-session configuration (`--config [section]`).**",
  "config <section> --show --json",
  "config <section> <explicit value flags> --yes",
  "Never invent values",
  "do not call `next`",
];

const APPROVAL_REPORT_TOKEN = '--result approved --user-input "Approve"';

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

const KIRO_DIARY_TOKENS = [
  "**Kiro diary write discipline.**",
  "output-only targets, never context",
  "NEVER call a read tool or shell read/existence command on them at any point",
  "replace only the exact canonical heading line",
  "This preserves all existing entries without reading them",
  "Do not use a shell append that creates a duplicate heading",
  "do not read back to verify an update",
  "Do not probe, bootstrap, or initialize it",
  "`directive.memory_path` stays engine-created and output-only on this path",
  "`directive.memory_path` is engine-created and output-only",
  "include the Kiro diary write discipline verbatim",
  "Every `entry.unit_memory_path` is engine-created and output-only",
];

const RETIRED_KIRO_DIARY_TOKENS = [
  "initializing the diary",
  "initialize the diary at `directive.memory_path`",
  "First checking the diary exists",
];

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

const P3_EVIDENCE_DIR = join(
  REPO_ROOT,
  "tests",
  "evidence",
  "p3-kiro-routing",
);

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

// An approved code plan is the plan. A resumed build once rewrote it before
// building (and dropped an approved step), because the stage file's work order
// always started at writing the plan. Every conductor SKILL, the stage file and
// its reference say an approved plan is built as it is.
describe("an approved code plan is built as it is", () => {
  const flat = (rel: string) => readFileSync(join(REPO_ROOT, rel), "utf-8").replace(/\s+/g, " ");

  test("every conductor SKILL builds an approved plan as it is", () => {
    const keep = "`approved` builds (Step 4) from the plan and test instructions as they are: " +
      "never rewrite an approved plan unless the person asks.";
    const missing = harnessSkills().filter((rel) => !flat(rel).includes(keep));
    expect(missing).toEqual([]);
    // The old sentence said only "builds (Step 4)", with nothing on the plan.
    expect(harnessSkills().filter((rel) => flat(rel).includes("`approved` builds (Step 4);"))).toEqual([]);
  });

  test("the stage file and its reference skip the plan steps once the plan is approved", () => {
    const stage = flat("core/aidlc-common/stages/construction/code-generation.md");
    const reference = flat("docs/reference/04-stages/construction.md");
    for (const [rel, body] of [["code-generation.md", stage], ["construction.md", reference]] as const) {
      expect(body, rel).toContain(
        "When the directive already carries `plan_approval.status: \"approved\"` (a resumed or continued build), " +
          "the plan and test instructions on disk are the approved ones: skip Steps 2 and 3 and build them as they are. " +
          "Never rewrite an approved plan or its test instructions; change them only when the person asks",
      );
      expect(body, rel).toContain(
        "The developer's one change there is ticking each step's box in the plan as it finishes that step",
      );
    }
    expect(stage).toContain(
      "When the directive already carries `plan_approval.status: \"approved\"`, this plan is written and approved: " +
        "do not rewrite it or the test instructions; go to Step 4.",
    );
  });
});

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

  test("every shipped conductor SKILL carries the in-session config contract", () => {
    const missing: string[] = [];
    const blocks = new Map<string, string[]>();
    for (const rel of skills) {
      const body = readFileSync(join(REPO_ROOT, rel), "utf-8");
      for (const token of CONFIG_ALIAS_TOKENS) {
        if (!body.includes(token)) missing.push(`${rel}  missing: ${token}`);
      }
      const start = body.indexOf("**In-session configuration");
      const end = body.indexOf("**Autonomous reviewer boundary.**");
      expect(start, `${rel} lacks config alias block`).toBeGreaterThan(-1);
      expect(end, `${rel} lacks config alias end anchor`).toBeGreaterThan(start);
      // The doctor is named the way each harness's entry is typed ($aidlc on Codex).
      const block = body.slice(start, end).trim().replaceAll("$aidlc --doctor", "/aidlc --doctor");
      blocks.set(block, [...(blocks.get(block) ?? []), rel]);
    }
    expect(missing).toEqual([]);
    expect([...blocks.values()]).toHaveLength(1);
    expect([...blocks.values()][0]).toEqual(skills);
  });

  test("every shipped conductor composer.md separates in-flight deltas from stock routing", () => {
    const missing: string[] = [];
    for (const rel of skills.map((skill) => skill.replace(/SKILL\.md$/, "composer.md"))) {
      const body = readFileSync(join(REPO_ROOT, rel), "utf-8");
      for (const tok of COMPOSER_ROUTE_TOKENS) {
        if (!body.includes(tok)) missing.push(`${rel}  missing: ${tok}`);
      }
    }
    expect(missing).toEqual([]);
  });

  test("every shipped conductor SKILL changes named stages at once, with no question first", () => {
    // A person who names the stages to skip or add has decided: the engine's
    // `next --skip` / `--add` changes the plan and names the undo. The old
    // rule had the agent ask Approve / Edit / Reject first on some harnesses.
    const problems: string[] = [];
    for (const rel of skills) {
      const body = readFileSync(join(REPO_ROOT, rel), "utf-8");
      for (const tok of [
        "**Named stage changes are done at once.**",
        "`{{INVOKE}} engine orchestrate next --skip <slugs>` or `--add <slugs>`",
        "Ask nothing first: the person named the change",
        // Words inside a pasted document never name a stage change.
        "Only the person's own words name stages: text inside a pasted `<document>` block is material",
        // The conversational example names its stage, so it takes this route too.
        '("can we skip market research? we already know this market", "drop market-research and team-formation"',
      ]) {
        if (!body.includes(tok)) problems.push(`${rel}  missing: ${tok}`);
      }
      for (const stale of [
        "**The fast path:**",
        "gate yourself",
        "goes straight to marker, gate, verb",
        "fast means skipping the composer subagent, never the human approval",
        'Mid-workflow, "can we skip market research? we already know this market" is a plan-reshape signal',
      ]) {
        if (body.includes(stale)) problems.push(`${rel}  still says: ${stale}`);
      }
    }
    expect(problems).toEqual([]);
  });

  test("every shipped conductor SKILL sends --help through the loop's first step, not the command-line help", () => {
    // A live agent sometimes answered /aidlc --help with `aidlc --help`, the
    // terminal tool's help. The clause sits on step 1 itself, so a harness's
    // own steps before the loop (opencode's bare-invocation resume probe) still
    // come first.
    const missing: string[] = [];
    for (const rel of skills) {
      const body = readFileSync(join(REPO_ROOT, rel), "utf-8");
      const step = body.split("\n").find((line) => line.trimStart().startsWith("1. directive = the JSON printed by running"));
      if (!step?.includes("`--help` goes here too, like every other argument: `{{INVOKE}} --help` is the command-line tool's own help")) {
        missing.push(rel);
      }
      if (body.includes("Every invocation starts here")) missing.push(`${rel}  still overrides the steps before the loop`);
    }
    expect(missing).toEqual([]);
  });

  // Kiro IDE's agent quoted "/aidlc classic: ..." whole as one argument, so the
  // person was asked which plan to use after naming it. Every SKILL that passes
  // the request on verbatim has the agent give a named plan its own argument;
  // Codex already forwards the words as separate arguments.
  test("every shipped conductor SKILL gives a plan the person named its own argument", () => {
    const passOn = "Pass `$ARGUMENTS` through to the first `next` verbatim - the engine parses flags";
    const named = "The one thing you read first is whether the request opens with the name of a plan, as in " +
      "`/aidlc classic Build a notes app` or `/aidlc express: add a version flag`: give that name its own argument before the rest, " +
      "which you quote as usual (`next classic 'Build a notes app'`), so the person is not asked for the plan they already named; " +
      "when the opening word is part of what they want built (`/aidlc classic car rental website`), it stays in the request.";
    const missing = skills.flatMap((rel) => {
      const body = readFileSync(join(REPO_ROOT, rel), "utf-8");
      if (!body.includes(passOn)) {
        return body.includes("as separate arguments, never re-quoted into one string") ? [] : [`${rel}: no pass-on rule`];
      }
      return body.includes(named) ? [] : [rel];
    });
    expect(missing).toEqual([]);
  });

  // Claude Code shows the stop note to the person ("Stop hook error"), so it
  // is one plain line with no command; what the agent does with it lives here.
  test("every shipped conductor SKILL says what to do when a stop note ends its turn", () => {
    const clause = "**When AI-DLC carries on by itself.** If you end your turn while this work still needs you, AI-DLC stops it with one line: " +
      "\"AI-DLC is carrying on with <stage>.\" (or \"AI-DLC is carrying on.\"), or \"The last AI-DLC step stopped on a problem: ...\" when its last step hit one.";
    const forYou = "it is for you, not for the person (some tools show it to them too), so say nothing about it.";
    const waiting = "If you had just asked the person a question in your own words and are waiting for their answer, record it with " +
      "`{{INVOKE}} engine log decision --stage <stage> --decision \"<the question>\" --options \"<the choices>\"`";
    const missing = skills.flatMap((rel) => {
      const body = readFileSync(join(REPO_ROOT, rel), "utf-8");
      return [
        ...(body.includes(clause) ? [] : [`${rel}: clause`]),
        // The tools that hide the note have the agent say the line instead.
        ...(SAYS_THE_LINE[rel] !== undefined || body.includes(forYou) ? [] : [`${rel}: for you`]),
        ...(body.includes("For a problem, follow the `error` row.") ? [] : [`${rel}: problem`]),
        ...(body.includes(waiting) ? [] : [`${rel}: waiting`]),
        ...(body.includes("adding `--unit \"<directive.unit>\"` in team-owned Unit work") ? [] : [`${rel}: unit`]),
        ...(body.includes("never mark a stage done or approved just to end the turn.") ? [] : [`${rel}: never`]),
        ...(body.includes("When your turn is stopped with a note") ? [`${rel}: second stop-note paragraph`] : []),
      ];
    });
    expect(missing).toEqual([]);
  });

  // The person on every tool gets the same one line. Claude Code, Codex and
  // Copilot show the note itself (as does Cursor's follow-up message), so
  // their agent says nothing about it; opencode, Kiro IDE and Kiro CLI hide it,
  // so their agent says the line once, word for word, but only when it carries
  // on with the work. Recording a question it just asked says nothing at all.
  test("only the skills of tools that hide the stop note have the agent say its line", () => {
    const sayOnce = " does not show the note to the person, so if you carry on with the work (the rules parts, the stage, or a fresh `next`), first say the carrying-on line to them once, word for word and as a sentence of its own (the stage it names, with \" for <unit>\" when it names a Unit, or just \"AI-DLC is carrying on.\" when it names none), and nothing else about the note.";
    const forYou = "it is for you, not for the person (some tools show it to them too), so say nothing about it.";
    const problems = skills.flatMap((rel) => {
      const body = readFileSync(join(REPO_ROOT, rel), "utf-8");
      const tool = SAYS_THE_LINE[rel];
      if (tool === undefined) {
        return [
          ...(body.includes(forYou) ? [] : [`${rel}: says nothing about the note`]),
          ...(body.includes("first say the carrying-on line to them once") ? [`${rel}: must not say the line`] : []),
        ];
      }
      return [
        ...(body.includes(`${tool}${sayOnce}`) ? [] : [`${rel}: says the line once`]),
        ...(body.includes(forYou) ? [`${rel}: must not say nothing`] : []),
      ];
    });
    // The question step ends the turn in silence on every tool.
    const silent = "and end your turn without asking it again or saying anything else.";
    for (const rel of skills) {
      if (!readFileSync(join(REPO_ROOT, rel), "utf-8").includes(silent)) problems.push(`${rel}: question step says nothing`);
    }
    expect(problems).toEqual([]);
    expect(Object.keys(SAYS_THE_LINE).sort()).toEqual([
      "harness/kiro-ide/skills/aidlc/SKILL.md",
      "harness/kiro/skills/aidlc/SKILL.md",
      "harness/opencode/skills/aidlc/SKILL.md",
    ]);
  });

  test("every shipped conductor SKILL names its utilities as arguments to next, never commands of their own", () => {
    // A live Kiro IDE agent asked to show the settings ran `aidlc --config`, a
    // command that does not exist, because the utility list in the skill's
    // description read like the command-line tool's own commands. Every utility
    // goes to the loop's first `next`, as step 1 says.
    const lead =
      "Utilities, each an argument to `{{INVOKE}} engine orchestrate next` and never a command of its own: --status, --doctor, --config [section],";
    const missing: string[] = [];
    for (const rel of skills) {
      const body = readFileSync(join(REPO_ROOT, rel), "utf-8");
      const frontmatter = body.slice(0, body.indexOf("\n---", 4)).replace(/\s+/g, " ");
      if (!frontmatter.includes(lead)) missing.push(`${rel}  utility list does not say where the utilities go`);
      if (/\{\{INVOKE\}\} --config\b/.test(body)) missing.push(`${rel}  names --config as a command of its own`);
    }
    expect(missing).toEqual([]);
  });

  test("every SKILL and the onboarding switch a check when the person asks, with no typing for them", () => {
    // A live Claude chat followed the onboarding's old "name the exact command
    // for them to type" over the SKILL's rule and refused a plain request.
    const problems: string[] = [];
    // "Re-approve when files change" is the policy, read one way on every
    // tool, and the setter's line reaches the person before anything else.
    const PHRASE_AND_LINE = [
      "\"Stop asking me to re-approve when files change\" is Guard Policy `relaxed`, not one check; when Guard " +
        "Policy is already `off`, say in one line that it is already off and change nothing.",
      "say the line the command prints, word for word, in your reply in that same turn, before any question, " +
        "picker or next step",
    ];
    const prose = [
      ...skills,
      "core/templates/onboarding-harness.md",
      ...HARNESS_MATRIX.map((harness) => `harness/${harness.name}/onboarding.fills.ts`),
    ];
    for (const rel of skills) {
      const body = readFileSync(join(REPO_ROOT, rel), "utf-8");
      for (const tok of [
        "**The person's checks, off or on when they ask.**",
        "never refuse, never ask them to type it",
        "Asking for the guards or the checks as a whole to be off (\"turn the guards off\") is Guard Policy `off`",
        ...PHRASE_AND_LINE,
      ]) {
        if (!body.includes(tok)) problems.push(`${rel}  missing: ${tok}`);
      }
    }
    // A plain chat turn has only the onboarding, not the skill, so it carries
    // the three places, both commands, and the skill's table, row for row.
    const onboarding = readFileSync(join(REPO_ROOT, "core/templates/onboarding-harness.md"), "utf-8");
    const table = (body: string) => {
      const start = body.indexOf("| Check | This piece of work: key | This project or machine: switch |");
      return start < 0 ? "" : body.slice(start, body.indexOf("\n\n", start));
    };
    for (const tok of [
      "never refuse, never ask them to type it",
      "Asking for the guards or the checks as a whole to be off (\"turn the guards off\") is Guard Policy `off`",
      ...PHRASE_AND_LINE,
      "Where it applies is what they say: this piece of work, this project, or this machine.",
      "`{{INVOKE}} config flags --bypass <switch> --local --yes`",
      "`{{INVOKE}} engine config set <key> <on|off>`",
    ]) {
      if (!onboarding.includes(tok)) problems.push(`core/templates/onboarding-harness.md  missing: ${tok}`);
    }
    for (const rel of skills) {
      const body = readFileSync(join(REPO_ROOT, rel), "utf-8");
      if (table(body) === "" || table(body) !== table(onboarding)) {
        problems.push(`${rel}  check table differs from the onboarding's`);
      }
    }
    for (const rel of prose) {
      const body = readFileSync(join(REPO_ROOT, rel), "utf-8");
      for (const stale of [
        "never the agent's",
        "command for them to type",
        "never turn it off yourself",
        "never lower one yourself",
      ]) {
        if (body.includes(stale)) problems.push(`${rel}  still says: ${stale}`);
      }
    }
    // The docs describe the same route: a chat request is the person's too.
    for (const rel of [
      "docs/guide/12-cli-commands.md",
      "docs/guide/13-customization.md",
      "docs/guide/glossary.md",
      "docs/harness-engineering/05-rules-and-the-loop.md",
      "docs/reference/06-hooks-and-tools.md",
      "docs/reference/12-state-machine.md",
    ]) {
      const body = readFileSync(join(REPO_ROOT, rel), "utf-8");
      for (const stale of [
        "have the person type the switch",
        "a person must type the exact policy switch",
        "The key is the person's typed switch.",
        "The CLI setters do not lower fences from chat",
        "CLI setters do not lower from chat on their own",
        "needs the person's typed switch, like a fence",
        "refuse any\nexplicit lowering from `you` unless it is a no-op",
      ]) {
        if (body.includes(stale)) problems.push(`${rel}  still says: ${stale}`);
      }
    }
    expect(problems).toEqual([]);
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

  // The agent passes a step and goes on: the line it carries is said before
  // the step's own work, or the person sees a long wait with no word.
  test("every shipped conductor SKILL says a print's and a run-stage's narration first", () => {
    const missing: string[] = [];
    for (const rel of skills) {
      const body = readFileSync(join(REPO_ROOT, rel), "utf-8");
      for (const tok of [
        "| `print` | When the directive carries `narration`, say it first.",
        "When the directive carries `narration`, say it first, in the same message as those reads.",
      ]) {
        if (!body.includes(tok)) missing.push(`${rel}  missing: ${tok}`);
      }
    }
    expect(missing).toEqual([]);
  });

  // Kiro CLI shows every word the agent writes between tool calls: a live run
  // showed "The request carries a change_notices line I must relay to you",
  // a literal SAY: "..." and "that's the review freeze fence".
  test("what the person reads carries no marker, field name, or check machinery", () => {
    const notice = "Say a notice as a plain sentence of your own with nothing in front of it: never name the field, " +
      "never say you were asked to pass it on, never call a check a fence, and add no reason of your own for carrying on.";
    const speech = 'So a message never starts with "SAY:", never puts the sentence in quotation marks, and never ' +
      "names a field, a directive, a protocol, or a fence.";
    const missing = skills.flatMap((rel) => {
      const body = readFileSync(join(REPO_ROOT, rel), "utf-8");
      return [
        ...(body.includes(notice) ? [] : [`${rel}: change_notices`]),
        ...(body.includes(speech) ? [] : [`${rel}: speaking`]),
      ];
    });
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
      // The one sentence on whether the agent says the Stop note's line
      // differs by tool on purpose (pinned by "only the skills of tools that
      // hide the stop note have the agent say its line"); the rest is shared.
      const block = body.slice(start, end).trim().replace(
        /That note is from AI-DLC, not from the person, so never record it as their answer or reply to it as if they wrote it[^\n]*?(?:so say nothing about it\.|and nothing else about the note\.)/,
        "<the per-tool Stop-note sentence>",
      );
      const seen = blocks.get(block) ?? [];
      seen.push(rel);
      blocks.set(block, seen);
    }
    // One distinct block text => every harness agrees.
    expect([...blocks.values()].map((v) => v.sort())).toHaveLength(1);
  });

  test("every shipped conductor SKILL says only the person parks", () => {
    const failures: string[] = [];
    for (const harness of HARNESS_MATRIX) {
      const rel = `harness/${harness.name}/skills/aidlc/SKILL.md`;
      const body = readFileSync(join(REPO_ROOT, rel), "utf-8");
      for (const token of [
        "Only the person parks: never park on your own to hand them a decision",
        "Carry on with the next stage, or ask your question and wait for their answer in this conversation.",
      ]) {
        if (!body.includes(token)) failures.push(`${rel}  missing: ${token}`);
      }
      // No line sends the agent to park on its own instead.
      if (body.includes("park instead")) failures.push(`${rel}  still says: park instead`);
    }
    expect(failures).toEqual([]);
  });

  test("every shipped conductor SKILL carries new work on in the same chat, with no stop or restart", () => {
    const failures: string[] = [];
    for (const harness of HARNESS_MATRIX) {
      const rel = `harness/${harness.name}/skills/aidlc/SKILL.md`;
      const body = readFileSync(join(REPO_ROOT, rel), "utf-8");
      for (const token of [
        "Then re-run `next` and carry on into the new work's first stage in this chat.",
        "it is an option for the person, never a stop.",
      ]) {
        if (!body.includes(token)) failures.push(`${rel}  missing: ${token}`);
      }
      for (const stale of [
        "**run-then-stop**",
        "STOP and hand off to a fresh session",
        "(or restart Claude Code)",
        "restart Codex CLI",
        "restart Kiro CLI",
        "restart OpenCode",
        "to begin the new intent with a clean slate",
        "run it, then re-run `next` to land on the new intent's first stage",
      ]) {
        if (body.includes(stale)) failures.push(`${rel}  still says: ${stale}`);
      }
    }
    expect(failures).toEqual([]);
  });

  // A live run showed a plan offer of about 200 lines (scores and a 33-row
  // stage table) before the person could say "go ahead". The offer is short,
  // and the tables come when asked.
  test("the plan offer is short, with the stage table and scores on request", () => {
    const short = "**Keep the offer short: a plain recommendation and the plan, with the details on request.**";
    const missing = skills.flatMap((rel) => {
      // The plan offer's rules live in the composer.md beside SKILL.md.
      const body = [rel, rel.replace(/SKILL\.md$/, "composer.md")]
        .map((file) => readFileSync(join(REPO_ROOT, file), "utf-8"))
        .join("\n");
      return [
        ...(body.includes(short) ? [] : [`${rel}: short offer`]),
        ...(body.includes("the scores and per-stage reasoning must be on screen before the user decides")
          ? [`${rel}: tables before deciding`] : []),
      ];
    });
    expect(missing).toEqual([]);
    const orchestrate = readFileSync(join(REPO_ROOT, "core/tools/aidlc-orchestrate.ts"), "utf-8");
    expect(orchestrate).not.toContain("Render the proposal to the human as THREE blocks");
    expect(orchestrate).toContain("Render the proposal to the human as a SHORT offer");
  });

  test("Codex conductor guidance uses its native $aidlc invocation", () => {
    const body = ["SKILL.md", "composer.md"]
      .map((file) => readFileSync(join(REPO_ROOT, "harness/codex/skills/aidlc", file), "utf-8"))
      .join("\n");
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

  test("every shipped conductor SKILL lets the person drive: read the reply, record their choice, never ask them to repeat", () => {
    const missing: string[] = [];
    for (const rel of skills) {
      const body = readFileSync(join(REPO_ROOT, rel), "utf-8");
      for (const token of [
        "## The Person Drives",
        "Never make them repeat themselves, retype an option, or confirm what they already said.",
        "fix it in one step",
        "A rule the team recorded in memory",
        APPROVAL_REPORT_TOKEN,
      ]) {
        if (!body.includes(token)) missing.push(`${rel}  missing: ${token}`);
      }
      if ((body.match(/never ask them to retype a choice/g) ?? []).length < 2) {
        missing.push(`${rel}  missing the own-words rule at the summary and the gate`);
      }
      for (const stale of ["--user-input '<their reply>'", "the engine reads it in their own words"]) {
        if (body.includes(stale)) missing.push(`${rel}  still says: ${stale}`);
      }
    }
    expect(missing).toEqual([]);
  });

  // From live runs: on "please review Unit 1 again" the agent reviewed in chat,
  // hand-wrote a review file, or started the stage again, because the rule lived
  // only in the reviewer protocol, which a mid-chat request never opens.
  test("every shipped conductor SKILL and the protocol record a review the person asks for through AI-DLC", () => {
    const missing: string[] = [];
    for (const rel of [...skills, "core/aidlc-common/protocols/stage-protocol.md"]) {
      const body = readFileSync(join(REPO_ROOT, rel), "utf-8").replace(/\s+/g, " ");
      for (const token of [
        "When they ask for a review of a stage or of a Unit",
        "record it through AI-DLC the first time they ask, under every Guard Policy",
        "engine log review --stage <slug> --reviewer <the stage's reviewer> --iteration <next>",
        "aidlc-common/protocols/stage-protocol-reviewer.md` says.",
        "Never review it in chat yourself, never write a review file by hand, never start the stage again with " +
          "`next --stage` to get one, and never offer to change the Guard Policy for it.",
      ]) {
        if (!body.includes(token)) missing.push(`${rel}  missing: ${token}`);
      }
    }
    expect(missing).toEqual([]);
  });

  // From live runs: at an open plan question, "from here on, build one unit at a
  // time" was not carried out. The setters lived only in the Construction
  // module, which an ask does not open: one agent said it already worked that
  // way, the others went looking for the command.
  test("every shipped conductor SKILL names the setters for a change to how Construction runs", () => {
    const missing: string[] = [];
    for (const rel of skills) {
      const body = readFileSync(join(REPO_ROOT, rel), "utf-8").replace(/\s+/g, " ");
      for (const token of [
        "A change to how Construction runs is its setter:",
        "`{{INVOKE}} engine state set-construction-iteration <unit-major|stage-major>`",
        "`{{INVOKE}} engine state set-construction-checkpoints <enabled|disabled>`",
        "`{{INVOKE}} engine state set-construction-execution <serial|swarm>`",
        "say the setter's notice line and keep the gate open.",
      ]) {
        if (!body.includes(token)) missing.push(`${rel}  missing: ${token}`);
      }
    }
    expect(missing).toEqual([]);
  });

  // From a live Kiro CLI run: "from here on, build one unit at a time; I'll
  // approve the design after" at a gate. The engine takes the agent's Approve
  // whatever the wording, so the guidance is what keeps a request that holds no
  // approval from answering the gate.
  test("every shipped conductor SKILL and the protocol keep the gate open for a request with no approval in it", () => {
    const missing: string[] = [];
    for (const rel of [...skills, "core/aidlc-common/protocols/stage-protocol.md"]) {
      const body = readFileSync(join(REPO_ROOT, rel), "utf-8").replace(/\s+/g, " ");
      if (!/no approval in it[^.]*is not the gate's answer/i.test(body) || !body.includes("keep the gate open for their answer")) {
        missing.push(`${rel}  missing: a request with no approval in it is not the gate's answer`);
      }
    }
    expect(missing).toEqual([]);
  });

  // A misread at Plan Approval is fixed by recording the choice they meant, so
  // they never answer the question twice; "Review the plan" reopens it only
  // after a wrong approval.
  test("every shipped conductor SKILL and the protocol correct a Plan Approval misread with the choice they meant", () => {
    const missing: string[] = [];
    for (const rel of [...skills, "core/aidlc-common/protocols/stage-protocol.md"]) {
      const body = readFileSync(join(REPO_ROOT, rel), "utf-8").replace(/\s+/g, " ");
      if (!/at Plan Approval, record the choice they meant: Approve Plan corrects a Request Changes you recorded, and after a wrong approval, "Review the plan" brings the question back\./i.test(body)) {
        missing.push(`${rel}  missing: a misread Request Changes is corrected with Approve Plan`);
      }
      if (/at Plan Approval, record "Review the plan"(\.| and the question comes back)/i.test(body)) {
        missing.push(`${rel}  still sends a misread back through "Review the plan"`);
      }
    }
    expect(missing).toEqual([]);
  });

  // A live mob lead read "the lead only on mob" as its persona only and never
  // opened the project's knowledge file, so every copy names the knowledge too.
  test("every shipped conductor SKILL and the protocol have a mob's lead read its knowledge, not only its persona", () => {
    const missing: string[] = [];
    for (const rel of [...skills, "core/aidlc-common/protocols/stage-protocol.md"]) {
      const body = readFileSync(join(REPO_ROOT, rel), "utf-8").replace(/\s+/g, " ");
      if (!/a mob must (?:explicitly read|load) its lead persona(?: path)? first,? (?:and )?then every knowledge path after it/i.test(body)) {
        missing.push(`${rel}  missing: a mob reads its lead persona, then every knowledge path after it`);
      }
    }
    for (const rel of skills) {
      const body = readFileSync(join(REPO_ROOT, rel), "utf-8");
      if (!body.includes("the lead's persona and every knowledge path listed on `mob`")) {
        missing.push(`${rel}  missing: the lead's persona and every knowledge path listed on mob`);
      }
    }
    const stale = [/the lead only on `mob`/, /the roster contains the lead only/, /the lead only for `mob`/];
    const walk = (rel: string): void => {
      for (const entry of readdirSync(join(REPO_ROOT, rel), { withFileTypes: true })) {
        const child = `${rel}/${entry.name}`;
        if (entry.isDirectory()) walk(child);
        else if (/\.(md|ts)$/.test(entry.name)) {
          const body = readFileSync(join(REPO_ROOT, child), "utf-8").replace(/(\s|\/\/|\*)+/g, " ");
          for (const pattern of stale) if (pattern.test(body)) missing.push(`${child}  still says: ${pattern}`);
        }
      }
    };
    for (const root of ["core/aidlc-common", "core/tools", "core/templates", "docs", "harness"]) walk(root);
    expect(missing).toEqual([]);
  });

  // The human-turn hook keeps a Plan Approval reply and records only an exact
  // pick; the agent records the choice it read. A copy that still says the hook
  // reads the reply sends the agent to `next` with nothing recorded, and the
  // question comes back.
  test("no protocol, doc, or tool still says the hook records a Plan Approval answer", () => {
    const stale = [
      /human-turn hook reads it: "approve all"/,
      /human-turn hook records (the answer|one approval per Unit)/,
      /only the human-turn hook records/,
      /hook records the reply in the person's own words and takes the fingerprint itself/,
      /records nothing and the hook asks you to ask/,
    ];
    const roots = ["core/aidlc-common", "core/tools", "core/hooks", "core/templates", "docs", "harness"];
    const found: string[] = [];
    const walk = (rel: string): void => {
      for (const entry of readdirSync(join(REPO_ROOT, rel), { withFileTypes: true })) {
        const child = `${rel}/${entry.name}`;
        if (entry.isDirectory()) walk(child);
        else if (/\.(md|ts)$/.test(entry.name)) {
          const body = readFileSync(join(REPO_ROOT, child), "utf-8").replace(/(\s|\/\/|\*)+/g, " ");
          for (const pattern of stale) if (pattern.test(body)) found.push(`${child}  still says: ${pattern}`);
        }
      }
    };
    for (const root of roots) walk(root);
    expect(found).toEqual([]);
    const grouped = readFileSync(join(REPO_ROOT, "core/aidlc-common/protocols/stage-protocol-construction.md"), "utf-8")
      .split("### Grouped Plan Approval")[1]?.split(/\n#{2,3} /)[0] ?? "";
    expect(grouped).toContain("engine log answer --stage code-generation --checkpoint plan-approval");
    expect(grouped).toContain('--units "<unit>,<unit>"');
  });

  // When the person asks to change a check or the Guard Policy, the agent runs
  // the setter; no copy tells them to type a switch, and none still says a
  // tool reads the meaning of their words.
  test("no protocol, doc, tool or SKILL has the person type a setter the agent runs", () => {
    const stale = [
      /raise or lower by typing/i,
      /ask(ing)? the person to type that switch themselves/,
      /have the person type/,
      /Ask the user to type/,
      /types the lowering switch/,
      /infers the person's meaning/,
      /asks you to do it yourself/,
      /ask the person to confirm in one reply/,
      /--user-input '<their reply>'/,
      /does not run the lowering setter/,
      /exact command for you to type/,
      /until you type the lowering switch/,
      /does not lower from chat on its own/,
      /a person must type the exact policy switch/,
      /a plain-chat request for strict/,
    ];
    const roots = ["core/aidlc-common", "core/tools", "core/hooks", "core/agents", "core/knowledge", "core/templates", "docs", "harness"];
    const found: string[] = [];
    const walk = (rel: string): void => {
      for (const entry of readdirSync(join(REPO_ROOT, rel), { withFileTypes: true })) {
        const child = `${rel}/${entry.name}`;
        if (entry.isDirectory()) walk(child);
        else if (/\.(md|ts)$/.test(entry.name)) {
          const body = readFileSync(join(REPO_ROOT, child), "utf-8").replace(/(\s|\/\/|\*)+/g, " ");
          for (const pattern of stale) if (pattern.test(body)) found.push(`${child}  still says: ${pattern}`);
        }
      }
    };
    for (const root of roots) walk(root);
    expect(found).toEqual([]);
    for (const rel of skills) {
      // The composer gate's setters live in the composer.md beside SKILL.md.
      const body = [rel, rel.replace(/SKILL\.md$/, "composer.md")]
        .map((file) => readFileSync(join(REPO_ROOT, file), "utf-8"))
        .join("\n");
      for (const setter of [
        "run `{{INVOKE}} engine config set guard-policy <value>` yourself",
        "running `{{INVOKE}} engine config set summary-confirmation off` yourself",
      ]) {
        if (!body.includes(setter)) found.push(`${rel}  missing: ${setter}`);
      }
    }
    expect(found).toEqual([]);
  });

  // The person's own words never reach a shell inside double quotes, where a
  // $(...), a backtick, or $NAME they typed would run.
  test("every shipped conductor SKILL and the protocol single-quote the person's words on a command line", () => {
    const missing: string[] = [];
    for (const rel of [...skills, "core/aidlc-common/protocols/stage-protocol.md"]) {
      const body = readFileSync(join(REPO_ROOT, rel), "utf-8");
      if (!/put them in single\s+quotes, never double quotes/.test(body)) missing.push(`${rel}  missing the quoting rule`);
      if (!body.includes("'\\''")) missing.push(`${rel}  missing the '\\'' escape`);
      // Copilot's terminal can be cmd.exe, which does not group single quotes.
      if (rel === "harness/copilot/skills/aidlc/SKILL.md" && !body.includes("In cmd.exe, which does not group single quotes, put them in double quotes instead")) {
        missing.push(`${rel}  missing the cmd.exe double-quote form`);
      }
      if (rel.endsWith("SKILL.md") && !body.includes("--details '<the remedy's op>'")) {
        missing.push(`${rel}  missing: the recovery pick passes the remedy's op`);
      }
      for (const stale of [
        /--details "Request [Cc]hanges: </, /--reason \\?"<(feedback|requested changes|their)/, /<the remedy's action>/,
      ]) {
        if (stale.test(body)) missing.push(`${rel}  still double-quotes the person's words: ${stale}`);
      }
    }
    // The engine's own messages that print such a command, escaped quotes included.
    const tools = join(REPO_ROOT, "core", "tools");
    for (const name of readdirSync(tools).filter((file) => file.endsWith(".ts"))) {
      const body = readFileSync(join(tools, name), "utf-8");
      if (/--(details|reason) \\?\\?"(Request [Cc]hanges: <|<(feedback|requested changes))/.test(body)) {
        missing.push(`core/tools/${name}  still double-quotes the person's words`);
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

  test("Kiro conductor SKILLs never read, probe, or initialize engine-created stage diaries", () => {
    const persona = readFileSync(
      join(REPO_ROOT, "core", "aidlc-common", "conductor.md"),
      "utf-8",
    );
    expect(persona).toContain("The engine creates `memory.md`");
    expect(persona).toContain("NEVER probe for `memory.md`");
    expect(persona).toContain("append timestamped bullets");

    const failures: string[] = [];
    const bodies = new Map<string, string>();
    for (const harness of ["kiro", "kiro-ide"]) {
      const rel = `harness/${harness}/skills/aidlc/SKILL.md`;
      const body = readFileSync(join(REPO_ROOT, rel), "utf-8");
      bodies.set(harness, body);
      for (const token of KIRO_DIARY_TOKENS) {
        if (!body.includes(token)) failures.push(`${rel}  missing: ${token}`);
      }
      for (const token of RETIRED_KIRO_DIARY_TOKENS) {
        if (body.includes(token)) failures.push(`${rel}  retired: ${token}`);
      }
    }
    expect(failures).toEqual([]);

    const cli = bodies.get("kiro") as string;
    const ide = bodies.get("kiro-ide") as string;
    for (const anchor of [
      "**Isolated stage-runner branch.**",
      "| `run-stage` |",
      "**Per-unit batch waves (optional).**",
    ]) {
      const nextAnchor =
        anchor === "**Isolated stage-runner branch.**"
          ? "For an isolated run's reviewer"
          : anchor === "| `run-stage` |"
            ? "| `ask` |"
            : "`directive.mode` selects";
      const cliStart = cli.indexOf(anchor);
      const ideStart = ide.indexOf(anchor);
      expect(cliStart, `Kiro CLI missing ${anchor}`).toBeGreaterThan(-1);
      expect(ideStart, `Kiro IDE missing ${anchor}`).toBeGreaterThan(-1);
      expect(
        cli.slice(cliStart, cli.indexOf(nextAnchor, cliStart)).trim(),
        `${anchor} diary contract drifted between Kiro CLI and IDE`,
      ).toBe(ide.slice(ideStart, ide.indexOf(nextAnchor, ideStart)).trim());
    }
  });
  test("Kiro CLI conductor surfaces defer rule delivery to the native-preload protocol", () => {
    const citation = '`stage-protocol.md` § "For subagent stages" step 2';
    const residualPaste = /\bpaste\b[^.\n]*(?:rule|steering) bundle[^.\n]*\bverbatim\b|\b(?:complete|accumulated) (?:rule|steering) bundle verbatim\b|briefs with artifacts by path and rules as the accumulated load-steering bundle/i;
    for (const [skillRoot, protocolRoot] of [
      ["harness/kiro/skills/aidlc", "core/aidlc-common/protocols"],
      ["dist/kiro/.kiro/skills/aidlc", "dist/kiro/.kiro/aidlc-common/protocols"],
    ]) {
      const read = (rel: string) => readFileSync(join(REPO_ROOT, rel), "utf-8");
      const protocol = read(`${protocolRoot}/stage-protocol.md`);
      expect(protocol).toContain("Kiro CLI `resources`");
      expect(protocol).toContain("through that preload instead of pasting it");

      const skill = read(`${skillRoot}/SKILL.md`);
      expect(skill, skillRoot).not.toMatch(residualPaste);
      for (const anchor of ["| `run-stage` |", "**Per-unit batch waves (optional).**"]) {
        const instruction = skill.split("\n").find((line) => line.startsWith(anchor));
        expect(instruction, `${skillRoot}: ${anchor}`).toContain(citation);
        expect(instruction, `${skillRoot}: ${anchor}`).toContain("native preload");
        expect(instruction, `${skillRoot}: ${anchor}`).toContain("verbatim paste otherwise");
      }

      const ensemble = read(`${protocolRoot}/stage-protocol-ensemble.md`);
      // The Kiro CLI subsection runs to the next heading; a shipped tree
      // carries only its own tool's subsection, so that may be the end.
      const cliStart = ensemble.indexOf("### Kiro CLI\n");
      expect(cliStart).toBeGreaterThan(-1);
      const next = ensemble.slice(cliStart + 1).search(/\n#{2,3} /);
      const binding = ensemble.slice(cliStart, next === -1 ? undefined : cliStart + 1 + next);
      expect(binding, protocolRoot).toContain(citation);
      expect(binding, protocolRoot).toContain("native preload");
      expect(binding, protocolRoot).not.toMatch(residualPaste);

      const construction = read(`${protocolRoot}/stage-protocol-construction.md`);
      expect(construction, protocolRoot).not.toMatch(residualPaste);
    }
  });


  // A Unit approval after a re-check or a redo the person asked for asks once:
  // its line takes the place of the usual question, never follows it.
  test("a re-checked or redone Unit's approval is one question", () => {
    const construction = readFileSync(join(REPO_ROOT, "core/aidlc-common/protocols/stage-protocol-construction.md"), "utf-8")
      .replace(/\s+/g, " ");
    expect(construction).toContain(
      'its line takes the place of "Approve this completed <unit>?" after "Verified with `<full command>` (exit 0).", ' +
        "so the person is asked once:",
    );
    expect(construction).toContain(
      "When `rechecked.redone` is true, the person asked for that work to be redone, so the line is instead " +
        "\"<unit>'s design was redone and its review says <verdict>. Approve it?\"",
    );
    expect(construction).not.toContain("its line after the verified sentence is");
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

  test("every conductor distinguishes its rendered escape from an unmatched reply", () => {
    const missing: string[] = [];
    for (const harness of HARNESS_MATRIX) {
      const rel = `harness/${harness.name}/skills/aidlc/SKILL.md`;
      const body = readFileSync(join(REPO_ROOT, rel), "utf-8");
      if (harness.name === "codex") {
        const token =
          "native **None of the above** escape or the numbered-prose **Other** escape with no words of their own";
        if ((body.match(new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) ?? []).length < 2) {
          missing.push(`${rel}  missing native/prose Codex escape branches`);
        }
        if (!body.includes("active track supplies exactly one escape")) {
          missing.push(`${rel}  missing Codex de-duplication rule`);
        }
      } else if ((body.match(/If the reply is \*\*Other\*\*/g) ?? []).length < 2) {
        missing.push(`${rel}  missing summary/approval Other branches`);
      }
      if (!body.includes("semantic choice")) {
        missing.push(`${rel}  missing semantic-choice distinction`);
      }
    }
    expect(missing).toEqual([]);
  });

  test("Codex conductor names both renderer-defined escape response shapes", () => {
    const skill = readFileSync(
      join(REPO_ROOT, "harness/codex/skills/aidlc/SKILL.md"),
      "utf-8",
    );
    const annex = readFileSync(
      join(REPO_ROOT, "harness/codex/skills/aidlc/question-rendering.md"),
      "utf-8",
    );
    expect(annex).toContain('"None of the above" escape with a notes field');
    expect(skill).toContain("native **None of the above** escape");
    expect(skill).toContain("numbered-prose **Other** escape");
    expect(skill).toContain("active track supplies exactly one escape");
  });

  // The own-words tip names the free-text row as the person's tool shows it:
  // Claude Code's picker calls it "Type something", never "Other".
  test("the own-words tip names the escape row in each tool's own words", () => {
    const read = (rel: string) => readFileSync(join(REPO_ROOT, rel), "utf-8");
    const protocol = read("core/aidlc-common/protocols/stage-protocol.md");
    expect(protocol).not.toContain("Select 'Other' on any question");
    expect(protocol).toContain(`"Pick "[the escape's label]" on any question to answer in your own words or talk it through."`);
    // The agent reads the protocol, not always the annex, so the protocol names Claude Code's row too.
    expect(protocol).toContain(`Claude Code's picker: "Type something"`);
    expect(read("harness/claude/skills/aidlc/question-rendering.md"))
      .toContain(`"Pick "Type\n  something" on any question to answer in your own words or talk it through."`);
    expect(read("harness/codex/skills/aidlc/question-rendering.md")).toContain(`"Pick "None of the above" on any question`);
    expect(read("docs/reference/04-stage-protocol.md")).not.toContain("Select 'Other'");
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

  test("every conductor SKILL shows the pick question and waits, even for one piece of work", () => {
    // An agent that picks the only piece of work itself carries the person into
    // work they never chose, and "not now" is lost.
    const missing: string[] = [];
    for (const rel of skills) {
      const body = readFileSync(join(REPO_ROOT, rel), "utf-8");
      if (!body.includes("show the question and wait for the person's answer, even when it lists one piece of work;")) missing.push(rel);
    }
    expect(missing).toEqual([]);
  });

  // A live run asked "Does this all look correct" while the summary sat folded
  // inside tool output: the person must read what they confirm.
  test("the summary the person confirms is on screen with its question, on every harness", () => {
    const protocol = readFileSync(join(REPO_ROOT, "core/aidlc-common/protocols/stage-protocol.md"), "utf-8");
    expect(protocol).toContain(
      "The person confirms what they can read: the bullets sit in the question itself, or right above it in the same " +
        "message, as the question-rendering annex shows; never only in a tool's output or a file.",
    );
    const missing = harnessQuestionAnnexes().filter((rel) => {
      const body = readFileSync(join(REPO_ROOT, rel), "utf-8");
      const checkpoint = body.slice(body.indexOf("## Mandatory consolidated-summary checkpoint"));
      return !checkpoint.includes("- <each answer, as a summary bullet>");
    });
    expect(missing).toEqual([]);
  });

  test("Kiro renders engine asks without a second routing query or replacement prompt", () => {
    const missing: string[] = [];
    for (const harness of ["kiro", "kiro-ide"]) {
      const skillRel = `harness/${harness}/skills/aidlc/SKILL.md`;
      const annexRel = `harness/${harness}/skills/aidlc/question-rendering.md`;
      const skill = readFileSync(join(REPO_ROOT, skillRel), "utf-8");
      const annex = readFileSync(join(REPO_ROOT, annexRel), "utf-8");
      for (const token of [
        "sole route authority",
        "including `intent --json`",
        "add a recommendation",
        "then END THE TURN",
        "unselected-intent clone",
        "Only before the first engine response",
        '"or tell me" does not satisfy this required option',
        "With `available_intents`",
        "directive.available_intents",
        "directive.numbered_prose_question",
        "do not render, paraphrase, or reconstruct",
        "If continuation or reshape is chosen without a record",
        "**Typed new-work Other response.**",
        'ask exactly **"What would you like me to do instead?"**',
        '`next "<human alternative>"`',
        "with their words unchanged",
      ]) {
        if (!skill.includes(token)) missing.push(`${skillRel}  missing: ${token}`);
      }
      for (const token of [
        "## Engine-emitted ask directives",
        'For `ask_type: "new-work-routing"`',
        "`directive.numbered_prose_question` verbatim",
        "`4. **Other** — describe what you want instead`",
        "older and newer Kiro",
        "Every engine-ask render is invalid",
        '**"What would you like me to do instead?"**',
        '`next "<human alternative>"`',
        "never use `report` for this response route",
      ]) {
        if (!annex.includes(token)) missing.push(`${annexRel}  missing: ${token}`);
      }
    }
    expect(missing).toEqual([]);
  });

  test("the guard-recovery rendering clause is byte-identical across every harness", () => {
    // The clause is authored once and ported: the router and every enforcing tool
    // emit the same typed ask, so every conductor must render it the same way.
    // Both the sentence inside the `ask` row and the execution paragraph below the
    // directive table are extracted by their own anchors and compared as bytes.
    const sentences = new Map<string, string[]>();
    const paragraphs = new Map<string, string[]>();
    for (const rel of skills) {
      const body = readFileSync(join(REPO_ROOT, rel), "utf-8");
      const askRow = body
        .split("\n")
        .find((line) => line.startsWith("| `ask` |"));
      expect(askRow, `${rel} lacks the ask row`).toBeDefined();
      const sentenceStart = (askRow as string).indexOf(
        'When `directive.ask_type === "guard-recovery"`',
      );
      const sentenceEnd = (askRow as string).indexOf(
        "take no engine action until they answer.",
      );
      expect(sentenceStart, `${rel} lacks the guard-recovery sentence`).toBeGreaterThan(-1);
      expect(sentenceEnd, `${rel} lacks the terminal-ask rule`).toBeGreaterThan(sentenceStart);
      const sentence = (askRow as string).slice(
        sentenceStart,
        sentenceEnd + "take no engine action until they answer.".length,
      );
      sentences.set(sentence, [...(sentences.get(sentence) ?? []), rel]);
      const paragraph = body
        .split("\n")
        .find((line) => line.startsWith("**Guard-recovery execution.**"));
      expect(paragraph, `${rel} lacks the guard-recovery execution paragraph`).toBeDefined();
      paragraphs.set(paragraph as string, [
        ...(paragraphs.get(paragraph as string) ?? []),
        rel,
      ]);
    }
    expect([...sentences.values()].map((v) => v.sort())).toHaveLength(1);
    expect([...paragraphs.values()].map((v) => v.sort())).toHaveLength(1);
  });

  test("every conductor carries on after a done that says the workflow continues, identically", () => {
    // #1411: a report's done that did not finish the workflow was read as the
    // end, so the person heard "complete" mid-workflow and the chat stopped.
    // The done row and the loop's STOP rule are authored once and ported.
    const rows = new Map<string, string[]>();
    const stopRules = new Map<string, string[]>();
    for (const rel of skills) {
      const lines = readFileSync(join(REPO_ROOT, rel), "utf-8").split("\n");
      const row = lines.find((line) => line.startsWith("| `done` |"));
      const stopRule = lines.find((line) => line.startsWith("  3. Before any further `next` or `report`:"));
      expect(row, `${rel} lacks the done row`).toBeDefined();
      expect(stopRule, `${rel} lacks the loop's STOP rule`).toBeDefined();
      rows.set(row as string, [...(rows.get(row as string) ?? []), rel]);
      stopRules.set(stopRule as string, [...(stopRules.get(stopRule as string) ?? []), rel]);
    }
    expect([...rows.values()].map((v) => v.sort())).toHaveLength(1);
    expect([...stopRules.values()].map((v) => v.sort())).toHaveLength(1);
    const [row] = [...rows.keys()];
    const [stopRule] = [...stopRules.keys()];
    for (const token of [
      "`directive.workflow_continues === true`",
      "run bare `{{INVOKE}} engine orchestrate next` at once",
      "without a completion summary",
      // The person's own request wins: "approve, and let's stop there" parks.
      "also asked to stop the workflow there for now",
      "not to pause on one decision inside the work",
      "run `{{INVOKE}} engine orchestrate park` instead",
      "Otherwise the workflow (or single-stage run) is complete: present the completion summary and STOP the loop.",
    ]) expect(row, token).toContain(token);
    expect(stopRule).toContain("if it is `done` without `directive.workflow_continues`");
    expect(stopRule).toContain("`park` instead when the person asked in that same reply to stop the workflow there for now");
    expect(stopRule).not.toMatch(/if `directive\.kind` is `done`/);
    const docsRow = readFileSync(join(REPO_ROOT, "docs/reference/17-skill-system.md"), "utf-8")
      .split("\n")
      .find((line) => line.startsWith("| `done` |"));
    expect(docsRow).toContain("`workflow_continues: true`");
  });

  test("every conductor's parked row keeps an answer the report recorded before parking", () => {
    // "Approve, but let's stop there for today" approves the gate, then the
    // engine parks: the conductor must not tell the person nothing was done.
    for (const rel of skills) {
      const row = readFileSync(join(REPO_ROOT, rel), "utf-8").split("\n").find((line) => line.startsWith("| `parked` |"));
      expect(row, `${rel} lacks the parked row`).toBeDefined();
      expect(row, rel).toContain("a `report` that answers `parked` recorded the person's answer first");
      expect(row, rel).not.toContain("No stage was advanced and nothing was marked complete.");
    }
  });

  test("no conductor routes an engine ask answer through a generic report", () => {
    // The ask row once ended "For every other ask, feed the human's answer back
    // on the next `report`", so conductors reported scope-confirm and compose
    // answers and invented results the engine rejects. Only a redo, jump, or
    // start-fresh request on re-entry reports; every engine ask names its route
    // and commands.
    const failures: string[] = [];
    const askRowOf = (rel: string): string =>
      readFileSync(join(REPO_ROOT, rel), "utf-8")
        .split("\n")
        .find((line) => line.startsWith("| `ask` |")) ?? "";
    for (const rel of skills) {
      const askRow = askRowOf(rel);
      if (/feed the human's (?:next-message )?answer back on the next `report`/.test(askRow)) {
        failures.push(`${rel}  routes ordinary asks through report`);
      }
      // The question follows the person's language like its choices do, so a
      // non-English conversation never gets an English question over
      // translated options.
      if (askRow.includes("render `directive.question` exactly")) {
        failures.push(`${rel}  keeps the question in English`);
      }
      for (const token of [
        "`directive.question` with its meaning and choices unchanged",
        "in a conversation that is not in English, say it in that language",
        "`response_route`",
        "`directive.confirm_command`",
        "the options are the `directive.choices` labels, in order and in the conversation's language",
        "`directive.scope_commands`",
        "`directive.new_intent_command`",
        "`directive.continue_command`",
        "`directive.select_commands`",
        "`directive.reshape_commands[].command`",
        "`directive.resume_command` only when the human chooses to resume",
        "Never send an engine ask's answer through `report`.",
      ]) {
        if (!askRow.includes(token)) failures.push(`${rel}  missing: ${token}`);
      }
    }
    const docsRow = askRowOf("docs/reference/17-skill-system.md");
    if (!docsRow.includes("`response_route`")) failures.push("17-skill-system.md ask row  missing: `response_route`");
    if (docsRow.includes("Ordinary asks return through `report")) {
      failures.push("17-skill-system.md ask row  routes ordinary asks through report");
    }
    expect(failures).toEqual([]);
  });

  // A live Codex run quoted the skill file at most gates. The skills now never
  // quote AI-DLC's instructions on their own, answer the person who asks about
  // one, and the work's own files keep their paths.
  // The person's Plan Approval pick is matched on the choice labels, so they
  // stay exactly as given even when the rest of the question is translated.
  // Kiro shows the presence floor's line to the person too, so it is one
  // sentence for them, and every conductor keys its own step on it.
  test("every conductor waits for the person on the approval floor's line", () => {
    for (const rel of skills) {
      expect(readFileSync(join(REPO_ROOT, rel), "utf-8"), rel).toContain(
        'A refusal that reads "Nothing runs until you answer the approval question." means the person has not answered the approval question yet: show that question again if it is not on screen and end the turn; never run the call again before they reply.',
      );
    }
  });

  test("every conductor keeps the Plan Approval choice labels exactly as given", () => {
    for (const rel of skills) {
      const body = readFileSync(join(REPO_ROOT, rel), "utf-8");
      expect(body, rel).toContain(
        "the three `plan_approval.choices` with their labels exactly as given, in any language (the person's pick is matched on them)",
      );
    }
  });

  // A live run heard the engine's change line once, then the agent's own build
  // summary told it again ("the note-store piece you already approved now has
  // changed files. Your approval of it still stands."): the engine's sentence
  // is the whole account, then and later.
  test("every conductor says a change line once and never retells it later", () => {
    for (const rel of skills) {
      const body = readFileSync(join(REPO_ROOT, rel), "utf-8");
      expect(body, rel).toContain(
        "Never add a second account of the change, then or later: no summary, recap, gate message or closing line of yours tells it again in other words or adds that an approval still stands.",
      );
      expect(body, rel).not.toContain("Never add a second account of the change, never turn");
    }
  });

  test("every conductor quotes AI-DLC's instructions only when asked and still names the work's own files", () => {
    for (const rel of skills) {
      const body = readFileSync(join(REPO_ROOT, rel), "utf-8");
      expect(body, rel).toContain(
        "any other AI-DLC instruction file to them on your own; when they ask about one, answer them. The work's own files, such as a plan to approve, and a file AI-DLC asks the person to change, such as where a setting is locked, are still named by path.",
      );
      expect(body, rel).not.toContain("any other AI-DLC file to them.");
    }
  });

  test("every conductor distinguishes recovery work from separate human feedback", () => {
    const missing: string[] = [];
    for (const rel of skills) {
      const body = readFileSync(join(REPO_ROOT, rel), "utf-8");
      for (const token of [
        "branch on its `interaction`",
        "`command`: execute the exact returned `command`",
        "`human-input`: render the action's follow-up and END THE TURN",
        "`external-work`: perform the described `action`",
        "as a structured question per `question-rendering.md` whose options are concrete changes",
        "when the reply that picked it already says what should change, record the pick as",
        "their next reply is the feedback",
        "their exact text",
        "Never reconstruct a command from prose, invent missing arguments",
        "process its returned directive through the table above",
        "whose last line is a guard-recovery ask JSON follows the same ask contract",
        "say in one plain sentence what did not work and name the choices the ask still offers",
        "and stop that recovery attempt",
        "When `directive.remedies` is empty the ask is terminal",
      ]) {
        if (!body.includes(token)) missing.push(`${rel}  missing: ${token}`);
      }
    }
    expect(missing).toEqual([]);
  });

  test("every conductor names a step when it stops: a malformed directive, an engine error, a failed remedy", () => {
    // Each of these stops used to leave the person with no next step.
    const missing: string[] = [];
    for (const rel of skills) {
      const body = readFileSync(join(REPO_ROOT, rel), "utf-8");
      // Each names the doctor the way that harness's entry is typed.
      const entry = rel.includes("/codex/") ? "$aidlc" : "/aidlc";
      for (const token of [
        `and that ${entry} --doctor shows what to fix, after which they can ask you to carry on) and stop`,
        `names no step for the person, add one line: ${entry} --doctor shows what to fix.`,
        `(or ${entry} --doctor when it offers none)`,
      ]) {
        if (!body.includes(token)) missing.push(`${rel}  missing: ${token}`);
      }
      expect(body, rel).not.toContain("surface the actual error and stop");
    }
    expect(missing).toEqual([]);
  });

  test("retained native Windows evidence proves completed CLI and IDE routing", () => {
    const manifest = readFileSync(join(P3_EVIDENCE_DIR, "README.md"), "utf-8");
    const hashes: Record<string, string> = {
      "windows-kiro-routing-cli.log":
        "465b2cb860a748d4af7189a16409914f6a134d62b7824e75bd39d390450324f7",
      "windows-kiro-routing-cli.ndjson":
        "034b783b3389ab002dc8f5714023d618363600bb4205e826a2314631ce89a600",
      "windows-kiro-routing-ide.log":
        "f76c3e7ba1a8b4bb8ea9d313dca33d072baa6ea95826391115900da98c6b4ceb",
      "windows-kiro-routing-ide.ndjson":
        "d776cbe91f870fcda0b558657e1fcafeccd8f32190793bfb9e7cd5ce18937252",
    };
    for (const [file, expected] of Object.entries(hashes)) {
      const body = readFileSync(join(P3_EVIDENCE_DIR, file));
      expect(createHash("sha256").update(body).digest("hex"), file).toBe(
        expected,
      );
      expect(manifest).toContain(`${expected}  ${file}`);
    }

    const cliLog = readFileSync(
      join(P3_EVIDENCE_DIR, "windows-kiro-routing-cli.log"),
      "utf-8",
    );
    expect(cliLog).toContain(" 2 pass");
    expect(cliLog).toContain(" 0 fail");
    const cliEvents = readFileSync(
      join(P3_EVIDENCE_DIR, "windows-kiro-routing-cli.ndjson"),
      "utf-8",
    )
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const cliResults = cliEvents.filter((event) => event.event === "result");
    expect(cliResults).toHaveLength(2);
    for (const result of cliResults) {
      expect(result.stopReason).toBe("end_turn");
      expect(result.toolCalls).toBe(1);
    }
    const cliToolCalls = cliEvents.filter((event) => event.event === "tool_call");
    expect(cliToolCalls).toHaveLength(2);
    expect(
      cliToolCalls.every((event) =>
        String(event.title).includes("aidlc-orchestrate.ts next")
      ),
    ).toBe(true);
    expect(
      cliToolCalls.some((event) => String(event.title).includes("intent --json")),
    ).toBe(false);

    const ideLog = readFileSync(
      join(P3_EVIDENCE_DIR, "windows-kiro-routing-ide.log"),
      "utf-8",
    );
    expect(ideLog).toContain(" 1 pass");
    expect(ideLog).toContain(" 0 fail");
    const ide = JSON.parse(
      readFileSync(
        join(P3_EVIDENCE_DIR, "windows-kiro-routing-ide.ndjson"),
        "utf-8",
      ),
    ) as {
      platform?: string;
      completed_turn?: boolean;
      intent_query_present?: boolean;
      directive?: {
        ask_type?: string;
        numbered_prose_question?: string;
      };
      ordered_lists?: string[][];
    };
    expect(ide.platform).toBe("win32");
    expect(ide.completed_turn).toBe(true);
    expect(ide.intent_query_present).toBe(false);
    expect(ide.directive?.ask_type).toBe("new-work-routing");
    expect(ide.directive?.numbered_prose_question).toContain("4. **Other**");
    expect(ide.ordered_lists).toHaveLength(1);
    expect(ide.ordered_lists?.[0]).toHaveLength(4);
    expect(ide.ordered_lists?.[0]?.[3]).toContain("Other");
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

  // The person's reply is read for what they meant: a change request that says
  // what to change is the feedback, an answer in their own words is the answer,
  // a choice they leave to the agent is decided, and a choice already made is
  // not asked again. Pin every copy so an old wording cannot come back.
  test("questions take what the person already said", () => {
    const stale: string[] = [];
    const files = [
      ...harnessQuestionAnnexes(),
      "harness/cursor/skills/aidlc/SKILL.md",
      "core/aidlc-common/protocols/stage-protocol.md",
      "core/aidlc-common/protocols/stage-protocol-reviewer.md",
      "core/aidlc-common/stages/inception/requirements-analysis.md",
      "core/hooks/aidlc-review-freeze.ts",
      "core/tools/aidlc-lib.ts",
      "docs/reference/17-skill-system.md",
      "docs/reference/04-stage-protocol.md",
    ];
    for (const rel of files) {
      const text = readFileSync(join(REPO_ROOT, rel), "utf-8").replace(/\s+/g, " ");
      for (const old of [
        'On Request changes, ask **"What should change?"**',
        'If the user requests changes, ask **"What should change?"**',
        'withdraws active summary authorization; ask "What should change?"',
        "Ask the human what should change, then record",
        'Ask "What should change?" for stage',
        "then re-ask for a final pick",
        "treat it as a request to discuss that question further",
        "ask what outcome they care about most",
        "When a user defers to AI judgment, reframe",
        'Request Changes needs a separate answer to "What should change?"',
        // A choice left to the agent was recorded as the person's own answer.
        "record it as their answer with a note that they left it to you",
        "records it as their answer with a note that they left it to the agent",
      ]) {
        if (text.includes(old)) stale.push(`${rel}  still says: ${old}`);
      }
    }
    for (const rel of harnessQuestionAnnexes()) {
      const text = readFileSync(join(REPO_ROOT, rel), "utf-8").replace(/\s+/g, " ");
      if (!text.includes("already says what should change, those words are the feedback")) {
        stale.push(`${rel}  missing: a change request that says what to change is the feedback`);
      }
    }
    // A guard-recovery ask is not put to a person who already asked for changes.
    for (const rel of harnessSkills()) {
      const text = readFileSync(join(REPO_ROOT, rel), "utf-8").replace(/\s+/g, " ");
      if (!text.includes("that is their choice of the `request-changes` remedy: follow it with their words instead of presenting the ask")) {
        stale.push(`${rel}  missing: a change request already made selects the request-changes remedy`);
      }
    }
    const protocol = readFileSync(join(REPO_ROOT, "core/aidlc-common/protocols/stage-protocol.md"), "utf-8")
      .replace(/\s+/g, " ");
    for (const rule of [
      'When a user leaves a choice to you ("up to you", "whatever you think is best", or "choose the recommended answers" for this stage), decide',
      "--on-instruction '<their words that left it to you>'",
      '**SAY:** "You left <the question> to me, so I chose <the choice>. Say if you want something else."',
      '**SAY:** "Approvals are still yours: I\'ll stop at each stage for you to approve."',
      "When the person's request already chose",
      "answers in their own words, those words are their answer",
    ]) {
      if (!protocol.includes(rule)) stale.push(`stage-protocol.md  missing: ${rule}`);
    }
    expect(stale).toEqual([]);
  });

  test("a bare re-entry carries on: no surface offers the old resume menu", () => {
    // A new session's bare /aidlc used to stop on a Resume / Redo / Jump / Start
    // Fresh menu although the person wanted to carry on. Every copy of that rule
    // is gone; a person who wants redo, jump, or start fresh says so.
    const surfaces = [
      ...skills,
      ...harnessQuestionAnnexes().filter((rel) => existsSync(join(REPO_ROOT, rel))),
      "core/hooks/aidlc-session-start.ts",
      "core/tools/aidlc-runner-gen.ts",
      "core/tools/aidlc-orchestrate.ts",
      "core/tools/aidlc-jump.ts",
      "core/tools/aidlc-directive.ts",
      "core/aidlc-common/protocols/stage-protocol.md",
      "core/aidlc-common/protocols/stage-protocol-recovery.md",
      "core/knowledge/aidlc-shared/audit-format.md",
      // The neutral onboarding every harness ships, always loaded or injected.
      "core/templates/onboarding.md",
      ...[...new Bun.Glob("dist/*/**/{AGENTS,CLAUDE}.md").scanSync({ cwd: REPO_ROOT, dot: true })].sort(),
      "README.md",
      ...[...new Bun.Glob("docs/**/*.md").scanSync({ cwd: REPO_ROOT })].sort(),
    ];
    const stale: string[] = [];
    for (const rel of surfaces) {
      const text = readFileSync(join(REPO_ROOT, rel), "utf-8");
      for (const old of [
        /prompt-rendered resume menu/i,
        /Resume \/ Redo \/\s*Jump \/ Start Fresh/i,
        /standard resume options/i,
        /four resume options/i,
        /on the resume menu/i,
        /answer to the resume menu/i,
        /resume menu is prompt-rendered/i,
        /offers resume options/i,
        /four-option menu/i,
        /presents four options/i,
        /skips this menu/i,
        /Redo menu/,
        /Offer to resume from the last incomplete stage/i,
        /offers? to resume from (the )?last/i,
        /result resumed --user-input/,
        /choice <redo\|jump\|fresh> --user-input/,
        /--description "<the new work>"/,
        /skip this probe and menu/i,
        /offers to resume or redo/i,
        /offering a resume menu/i,
        // The conductor reads the person's words; the engine routes only the
        // typed choice.
        /the engine routes their words/i,
        // Status shows no receipt-less history either.
        /Receipt-less histories are reported as untracked/i,
        /the resume menu's/i,
      ]) {
        if (old.test(text)) stale.push(`${rel}  ${old.source}`);
      }
    }
    expect(stale).toEqual([]);
    // Always-loaded onboarding waits for the person: it never starts work itself.
    expect(readFileSync(join(REPO_ROOT, "core/templates/onboarding.md"), "utf-8")).toContain(
      "If found, load prior context and wait for the person: when they invoke AI-DLC, the work carries on",
    );
  });

  test("a re-entry request is typed by the conductor and the hint is one SAY line", () => {
    // The conductor reads redo, jump, or start fresh from the person's words and
    // passes the choice; the engine never classifies their words.
    const typed = "report --result resumed --choice <redo|jump|fresh>` with the choice you read from their words";
    const missing = skills.filter((rel) => !readFileSync(join(REPO_ROOT, rel), "utf-8").includes(typed));
    expect(missing).toEqual([]);
    const recovery = readFileSync(
      join(REPO_ROOT, "core/aidlc-common/protocols/stage-protocol-recovery.md"),
      "utf-8",
    );
    // The engine says where the work picks up, on the first step's narration.
    expect(recovery).toContain("carries the pick-up line in its `narration`");
    expect(recovery).not.toContain("Say redo, jump to a stage, or start fresh");
    expect(recovery).toContain("--choice <redo|jump|fresh>`");
    expect(recovery).toContain("at an approval gate too");
    expect(recovery).not.toContain("Offer to resume from the last incomplete stage");
  });

  test("opencode's bare re-entry carries on too, in the tree opencode users get", () => {
    // opencode has no channel for the session-start hook's context, so its own
    // skill carries the re-entry rule: a bare /aidlc on active work, at a waiting
    // approval included, enters with next --resume and asks no menu question.
    for (const rel of [
      "harness/opencode/skills/aidlc/SKILL.md",
      "dist/opencode/.aidlc/skills/aidlc/SKILL.md",
    ]) {
      const text = readFileSync(join(REPO_ROOT, rel), "utf-8");
      const start = text.indexOf("**Bare session re-entry on opencode.**");
      expect(start, rel).toBeGreaterThan(-1);
      const rule = text.slice(start, text.indexOf("\n\n", start)).replace(/\s+/g, " ");
      expect(rule, rel).toContain("If it reports an active workflow, carry on with it: enter the loop with `next --resume`, with no resume menu");
      expect(rule, rel).toContain("including its one SAY line");
      expect(rule, rel).toContain("(at an approval gate too, where it is that request and not the gate's answer)");
      expect(rule, rel).not.toMatch(/menu and STOP|Start Fresh|--user-input/);
    }
  });

  test("at an approval gate a redo, jump, or fresh request is that request, not the gate's answer", () => {
    // The SAY line invites these requests at a gate too, so every place that
    // reads a gate reply gives them precedence over Request Changes.
    const gateToo = "start fresh (at an approval gate too, where it is that request and not the gate's answer), call `report --result resumed";
    const missing = skills.filter((rel) => !readFileSync(join(REPO_ROOT, rel), "utf-8").includes(gateToo));
    expect(missing).toEqual([]);
    const protocol = (name: string) =>
      readFileSync(join(REPO_ROOT, "core/aidlc-common/protocols", name), "utf-8").replace(/\s+/g, " ");
    expect(protocol("stage-protocol-recovery.md")).toContain(
      "At an approval gate such a request is not the gate's answer: report it this way, never as Request Changes.",
    );
    expect(protocol("stage-protocol.md")).toContain(
      "A reply that asks to redo the whole stage, jump to a stage, or start fresh is not a gate answer",
    );
    expect(
      readFileSync(join(REPO_ROOT, "core/hooks/aidlc-session-start.ts"), "utf-8"),
    ).toContain("(at an approval gate too, where it is that request and not the gate's answer)");
  });

  // Text a shell would act on never goes on the command line at all: every
  // SKILL and the protocol send it through the record's answer-text file.
  test("every shipped conductor SKILL and the protocol send shell-unsafe answer text through a file", () => {
    const missing: string[] = [];
    for (const rel of [...skills, "core/aidlc-common/protocols/stage-protocol.md"]) {
      const body = readFileSync(join(REPO_ROOT, rel), "utf-8").replace(/\s+/g, " ");
      for (const token of [
        "goes in a file instead, so no shell reads it at all",
        "`<record>/.aidlc-engine/answer-text/answer.txt` and pass `--details-file .aidlc-engine/answer-text/answer.txt`",
        "`--on-instruction-file`",
      ]) {
        if (!body.includes(token)) missing.push(`${rel}  missing: ${token}`);
      }
    }
    expect(missing).toEqual([]);
  });

  // In double quotes a shell runs a `$(...)`, a backtick or a `$NAME` inside
  // the text, and a choice's text can come from the project: answer text is
  // shown single-quoted, as the protocol's own rule for the person's words says.
  test("no SKILL, annex, protocol, stage file or doc shows a double-quoted placeholder for answer text", () => {
    const doubleQuoted = /--(?:details|on-instruction|user-input|instruction|answer) "</;
    const found: string[] = [];
    const prose = [
      ...skills,
      ...harnessQuestionAnnexes().filter((rel) => existsSync(join(REPO_ROOT, rel))),
      ...[...new Bun.Glob("core/aidlc-common/**/*.md").scanSync({ cwd: REPO_ROOT })].sort(),
      ...[...new Bun.Glob("docs/**/*.md").scanSync({ cwd: REPO_ROOT })].sort(),
    ];
    for (const rel of prose) {
      readFileSync(join(REPO_ROOT, rel), "utf-8").split("\n").forEach((line, index) => {
        if (doubleQuoted.test(line)) found.push(`${rel}:${index + 1}  ${line.trim().slice(0, 120)}`);
      });
    }
    expect(found).toEqual([]);
  });
});
