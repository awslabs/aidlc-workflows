// covers: hook:aidlc-continue-workflow
//
// The Stop hook's end-of-turn note is one plain line the person can read
// ("AI-DLC is carrying on with Requirements Analysis."): Claude Code prints it
// under its own hook label, so it carries no command, slug or receipt. The
// agent's steps for it live in every orchestrator skill instead. Mechanism:
// none (readFileSync over the authored skills, prose and directive type, zero
// spawn, zero LLM).
//   (a) every authored conductor SKILL carries ONE "When AI-DLC carries on by
//       itself" paragraph with each step the old notes gave the agent;
//   (b) the agent says nothing about the note on any tool: the line comes
//       only where the work carries on by itself (autonomous Construction, a
//       run nobody attends), so no person is waiting to be told it;
//   (c) the old agent-addressed wordings are gone from every prose surface and
//       stay in the hook only as the matcher for older transcripts;
//   (d) a stage the agent was working on ends with the exact `report` built
//       from the run-stage it holds: the line names the stage by its name, so
//       the slug, the Unit and the isolated-run flag come from that directive.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../harness/fixtures.ts";
import { HARNESS_MATRIX } from "../harness/harness-matrix.ts";

const HEADING = "**When AI-DLC carries on by itself.**";

function skillPaths(): string[] {
  return HARNESS_MATRIX.map((harness) => `harness/${harness.name}/skills/aidlc/SKILL.md`).sort();
}

function carryOnParagraph(rel: string): string {
  const lines = readFileSync(join(REPO_ROOT, rel), "utf-8").split("\n");
  const found = lines.filter((line) => line.startsWith(HEADING));
  expect(found.length, `${rel} carries the paragraph once`).toBe(1);
  return found[0] as string;
}

const STEPS = [
  '"AI-DLC is carrying on with <stage>." (or "AI-DLC is carrying on.")',
  '"The last AI-DLC step stopped on a problem: ..."',
  "never record it as their answer or reply to it as if they wrote it",
  "For a problem, follow the `error` row.",
  // A question shown before it was recorded is recorded, never asked again.
  '`{{INVOKE}} engine log decision --stage <stage> --decision "<the question>" --options "<the choices>"`',
  'adding `--unit "<directive.unit>"` in team-owned Unit work',
  "`--single`, `--checkpoint` or `--questions-file`",
  "end your turn without asking it again",
  "If the person asked to stop here, run `{{INVOKE}} engine orchestrate park --person-asked`.",
  "`{{INVOKE}} engine orchestrate continue <receipt>` with the receipt of the last part you hold",
  "a receipt that no longer fits is answered with the current step",
  "after a result you recorded moved the work on",
  "run one fresh `{{INVOKE}} engine orchestrate next` (never an earlier receipt)",
  "Never report an approval the person did not give, and never mark a stage done or approved just to end the turn.",
];

// The stage-work step: the exact report, built from the run-stage the agent holds.
const REPORT_STEP =
  /If you were doing the work of a `run-stage` you still hold, finish its steps, then record its real outcome with the report built from that directive: `([^`]+)`, adding `(--unit "<directive\.unit>")` in team-owned Unit work and `(--single)` when `directive\.single` is true\./;

describe("t-stop-carries-on-line: the agent's steps for the one-line Stop note", () => {
  test("(a) every conductor SKILL carries each step, in one paragraph", () => {
    const paths = skillPaths();
    expect(paths.length).toBeGreaterThanOrEqual(7);
    for (const rel of paths) {
      const paragraph = carryOnParagraph(rel);
      for (const step of STEPS) expect(paragraph, `${rel}: ${step}`).toContain(step);
      expect(readFileSync(join(REPO_ROOT, rel), "utf-8"), rel).not.toContain("**When your turn is stopped with a note.**");
    }
  });

  test("(b) the agent says nothing about the note on any tool, and a question it just asked is recorded in silence", () => {
    for (const rel of skillPaths()) {
      const paragraph = carryOnParagraph(rel);
      expect(paragraph, rel).toStartWith(
        `${HEADING} Under autonomous Construction, or in a run nobody attends, if you end your turn while this work still needs you,`,
      );
      expect(paragraph, rel).toContain(
        "it is for you, not for the person (some tools show it to them too), so say nothing about it.",
      );
      expect(paragraph, rel).not.toContain("first say the carrying-on line to them once");
      expect(paragraph, rel).not.toContain("does not show the note to the person");
      const question = paragraph.slice(paragraph.indexOf("If you had just asked the person a question"));
      expect(question.slice(0, question.indexOf(". ") + 1), rel).toEndWith(
        "and end your turn without asking it again or saying anything else.",
      );
    }
    const start = readFileSync(join(REPO_ROOT, "core/hooks/aidlc-session-start.ts"), "utf-8");
    expect(start).toContain(
      "Under autonomous Construction, or in a run nobody attends, if you end a turn while this work still needs you, " +
        "AI-DLC answers with one line, \"AI-DLC is carrying on with <stage>.\" It is from AI-DLC, not the person: " +
        "never record it as their answer, and say nothing about it.",
    );
    expect(start).not.toContain("This tool does not show that line to the person");
  });

  test("(c) the old agent-addressed wordings are gone from prose and from the hook", () => {
    const stale = [
      "tell the person nothing about this note",
      "The AI-DLC workflow is not finished",
      "is not finished yet. Next:",
      "When your turn is stopped with a note",
    ];
    const roots = ["harness", "core/aidlc-common", "core/knowledge", "docs"];
    const hits: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(join(REPO_ROOT, dir))) {
        const rel = `${dir}/${name}`;
        if (statSync(join(REPO_ROOT, rel)).isDirectory()) {
          walk(rel);
        } else if (name.endsWith(".md")) {
          const text = readFileSync(join(REPO_ROOT, rel), "utf-8");
          for (const phrase of stale) if (text.includes(phrase)) hits.push(`${rel}: ${phrase}`);
        }
      }
    };
    for (const root of roots) walk(root);
    expect(hits).toEqual([]);
    // The hook tells its own entries from the person's by the host's mark
    // (Claude's isMeta, Codex's Stop wrapper), so it keeps no copy of them.
    const hook = readFileSync(join(REPO_ROOT, "core/hooks/aidlc-continue-workflow.ts"), "utf-8");
    for (const phrase of stale) expect(hook, phrase).not.toContain(phrase);
    expect(hook).not.toContain("is not finished yet\\. Next:");
  });

  // The line names the stage the way status does ("Code Generation for
  // alpha"), never its slug, and Claude Code shows it to the person, so it
  // cannot carry the command. The skill gives the agent the exact command and
  // names the directive fields it is built from.
  test("(d) a stage in flight ends with the exact report built from the run-stage the agent holds", () => {
    const directiveType = readFileSync(join(REPO_ROOT, "core/tools/aidlc-directive.ts"), "utf-8");
    const runStage = directiveType.slice(directiveType.indexOf("export interface RunStageDirective {"));
    const body = runStage.slice(0, runStage.indexOf("\n}\n"));
    for (const field of ["  stage: string;", "  unit?: string;", "  single?: boolean;"]) {
      expect(body, `RunStageDirective declares ${field.trim()}`).toContain(`\n${field}`);
    }
    for (const rel of skillPaths()) {
      const step = REPORT_STEP.exec(carryOnParagraph(rel));
      if (step === null) throw new Error(`${rel}: no report step built from the run-stage`);
      expect(step[1], rel).toBe("{{INVOKE}} engine orchestrate report --stage <directive.stage> --result <outcome>");
      const held = { stage: "code-generation", unit: "alpha", single: true };
      const built = [
        step[1].replace("{{INVOKE}}", "aidlc").replace("<directive.stage>", held.stage).replace(" --result", ` ${step[2].replace("<directive.unit>", held.unit)} --result`),
        step[3],
      ].join(" ");
      expect(built, rel).toBe('aidlc engine orchestrate report --stage code-generation --unit "alpha" --result <outcome> --single');
    }
  });
});
