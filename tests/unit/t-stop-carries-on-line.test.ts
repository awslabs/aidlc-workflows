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
//   (b) where the tool shows the note the agent says nothing about it, and
//       where it hides the note (opencode, Kiro IDE) the agent says the line once;
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

// Every step the old notes named, now in the skill's own words.
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
  "If the person asked to stop here, run `{{INVOKE}} engine orchestrate park`.",
  // Rules parts: the receipt the agent holds; a stale one gets the current step.
  "`{{INVOKE}} engine orchestrate continue <receipt>` with the receipt of the last part you hold",
  "a receipt that no longer fits is answered with the current step",
  // A recorded result that moved on, and stale evidence: one fresh next.
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

  test("(b) the person on every tool gets the line once: shown by the tool, or said by the agent where the tool hides it", () => {
    const hides: Record<string, string> = {
      "harness/kiro/skills/aidlc/SKILL.md": "Kiro CLI",
      "harness/kiro-ide/skills/aidlc/SKILL.md": "Kiro IDE",
      "harness/opencode/skills/aidlc/SKILL.md": "opencode",
    };
    for (const rel of skillPaths()) {
      const paragraph = carryOnParagraph(rel);
      const tool = hides[rel];
      if (tool === undefined) {
        expect(paragraph, rel).toContain(
          "it is for you, not for the person (some tools show it to them too), so say nothing about it.",
        );
        expect(paragraph, rel).not.toContain("first say the carrying-on line to them once");
      } else {
        // One plain sentence in the agent's own reply, only when it carries on
        // with the work: the line as the note names it, and nothing else.
        expect(paragraph, rel).toContain(
          `${tool} does not show the note to the person, so if you carry on with the work (the rules parts, the stage, or a fresh \`next\`), ` +
            "first say the carrying-on line to them once, word for word and as a sentence of its own",
        );
        expect(paragraph, rel).toContain('with " for <unit>" when it names a Unit, or just "AI-DLC is carrying on." when it names none');
        expect(paragraph, rel).toContain("and nothing else about the note.");
        expect(paragraph, rel).not.toContain("so say nothing about it.");
      }
      // A question the agent just asked is recorded and the turn ends in
      // silence on every tool: no line, no account of the recording.
      const question = paragraph.slice(paragraph.indexOf("If you had just asked the person a question"));
      expect(question.slice(0, question.indexOf(". ") + 1), rel).toEndWith(
        "and end your turn without asking it again or saying anything else.",
      );
      // The question case comes before "say the line": on the tools that hide
      // the note, the agent said the line right after its own question when
      // the exception followed the instruction (kiro-ide-win W1, W4).
      if (tool !== undefined) {
        expect(paragraph.indexOf("If you had just asked the person a question"), rel)
          .toBeLessThan(paragraph.indexOf(`${tool} does not show the note to the person`));
      }
    }
  });

  // The hook's own step, read by an agent with no skill loaded: the question
  // case first, then the line, and the line is AI-DLC's, never the person's
  // answer (a Kiro IDE agent recorded "user implicitly confirmed by hook
  // trigger" as a decision right after saying it).
  test("(b2) the hook's step puts the question case first and says the line confirms nothing", () => {
    const stop = readFileSync(join(REPO_ROOT, "core/hooks/aidlc-continue-workflow.ts"), "utf-8");
    const step = stop.slice(stop.indexOf("const SAY_THE_LINE ="), stop.indexOf("const STOP_NOTE ="));
    expect(step.indexOf("If you had just asked the person a question")).toBeGreaterThan(0);
    expect(step.indexOf("If you had just asked the person a question")).toBeLessThan(step.indexOf("first say that line"));
    expect(step).toContain("it is AI-DLC's line, not the person's, and confirms nothing, so record nothing as theirs because of it");
  });

  test("(c) the old agent-addressed wordings are gone from prose and kept only as the hook's matcher", () => {
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
    const hook = readFileSync(join(REPO_ROOT, "core/hooks/aidlc-continue-workflow.ts"), "utf-8");
    for (const phrase of stale.slice(0, 2)) expect(hook.split(phrase).length - 1, phrase).toBe(1);
    // The older one-line note is matched only with its command in backticks.
    expect(hook).toContain("is not finished yet\\. Next: (?:finish its steps, then )?`[^`\\n]+`\\.$/");
  });

  // Kiro CLI showed the person nothing of a Stop block, and its agent, started
  // with a plain prompt and no aidlc skill in context, never said the line.
  // So the engine carries the step: one list of the tools that hide the note,
  // read by the Stop hook (the reason) and the session-start hook (the context
  // sent again after a compaction), through the installed tool name.
  test("(e) the tools that hide the note get the agent's step from the engine, not only from the skill", () => {
    const paths = readFileSync(join(REPO_ROOT, "core/tools/aidlc-runtime-paths.ts"), "utf-8");
    const list = /export function hidesStopNote\(harnessName: string\): boolean \{\n {2}return ([^\n]+);\n\}/.exec(paths);
    if (list === null) throw new Error("aidlc-runtime-paths.ts has no hidesStopNote");
    expect([...list[1].matchAll(/"([a-z-]+)"/g)].map((m) => m[1]).sort()).toEqual(["kiro", "kiro-ide", "opencode"]);
    const stop = readFileSync(join(REPO_ROOT, "core/hooks/aidlc-continue-workflow.ts"), "utf-8");
    expect(stop).toContain("hidesStopNote(runtimeHarnessName(projectDir))");
    expect(stop).toContain("on its own line; ");
    const start = readFileSync(join(REPO_ROOT, "core/hooks/aidlc-session-start.ts"), "utf-8");
    expect(start).toContain("hidesStopNote(runtimeHarnessName(projectDir))");
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
      // Filled from what the agent holds for a team-owned Unit's isolated
      // step, it is one whole command with only the outcome left to fill in.
      const held = { stage: "code-generation", unit: "alpha", single: true };
      const built = [
        step[1].replace("{{INVOKE}}", "aidlc").replace("<directive.stage>", held.stage).replace(" --result", ` ${step[2].replace("<directive.unit>", held.unit)} --result`),
        step[3],
      ].join(" ");
      expect(built, rel).toBe('aidlc engine orchestrate report --stage code-generation --unit "alpha" --result <outcome> --single');
    }
  });
});
