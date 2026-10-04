// covers: subcommand:aidlc-utility:reclassify, audit:WORKSPACE_RECLASSIFIED, file:skills/aidlc/SKILL.md
//
// t-journey-code-arrives.sdk.test.ts - new project, then the team's code
// arrives (live SDK).
//
// What a person hit without this: a team started AI-DLC in an empty folder,
// then copied their code in. Either nobody asked whether it was existing code,
// or the agent answered that question itself and AI-DLC recorded the answer as
// the person's; Reverse Engineering then never documented the code.
//
// The journey:
//   chat 1: an empty folder holding only docs/vision.md. The person types
//           `/aidlc --scope classic Build what vision.md describes`. The drive
//           stops once the work is created and the engine's new-project line
//           has reached the agent: with the step that creates the work, or,
//           when the engine knows the conversation, with the first stage
//           after it (the step the agent speaks from).
//   then:   the team's code lands in the folder (a small TypeScript repo).
//   chat 2: a new chat. The person types `/aidlc`. AI-DLC asks whether the
//           code is existing code to work on, in a picker. The person answers
//           in their own words, "yes, it is our existing code", typed into the
//           picker (or in their next message, when the agent asked in the
//           chat instead). The drive stops when Reverse Engineering is handed
//           to the agent to run.
//
// Pass/fail reads only engine output, the audit and the state file, NEVER the
// agent's prose:
//   - creation said, in the engine's own line for the person, that the empty
//     folder starts as a new project, and recorded it as the scan's call;
//   - the existing-code question was asked and shown once at most in a
//     picker, and nothing was reclassified before the person answered;
//   - the answer came from the person's turn: a human turn is recorded after
//     the question and before the one reclassify, which records Brownfield as
//     theirs and puts Reverse Engineering back on the plan;
//   - Reverse Engineering is the next stage AI-DLC runs, with no other
//     question on the way.
//
// The composed-plan half (a composer plan that left Reverse Engineering out) is
// pinned without a model in t352; a live composer picks its own base scope,
// which would make this journey depend on the model's plan.
//
// It SPENDS TOKENS: driveAidlc drives the real /aidlc through the Claude Agent
// SDK. Gated on the claude CLI (calling driveAidlc marks the file
// SDK-dependent; the runner skips with a reason when claude is absent).

import {
  liveCaseTimeoutMs,
  LIVE_LONG_OPERATION_TIMEOUT_MS,
  remainingOperationTimeoutMs,
  fileCleanupReserveMs,
} from "../harness/test-budget.ts";
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTestProject, setupIntegrationProject } from "../harness/fixtures.ts";
import { type CapturedToolResult, driveAidlc, readStateField, readStateFile } from "../harness/sdk-drive.ts";
import { auditBlockField, readAuditShardEvents } from "../../dist/claude/.claude/tools/aidlc-lib.ts";

const TIMEOUT_S = Number.parseInt(process.env.AIDLC_TEST_TIMEOUT ?? String(LIVE_LONG_OPERATION_TIMEOUT_MS / 1000), 10);
const LIVE_WORK_TIMEOUT_MS = Number.isFinite(TIMEOUT_S) && TIMEOUT_S > 0
  ? TIMEOUT_S * 1000 : LIVE_LONG_OPERATION_TIMEOUT_MS;
const TEST_TIMEOUT_MS = liveCaseTimeoutMs(LIVE_WORK_TIMEOUT_MS);

// The engine's own line for the person at creation (aidlc-orchestrate.ts).
// It rides the next step the agent speaks from, so it can arrive after the
// work is created.
const NEW_PROJECT_LINE = "The folder has no code yet, so I'm starting this as a new project without Reverse Engineering.";
// Printed only when new work is created (aidlc-utility.ts handleIntentCreate).
const CREATED = "State initialized:";
// The existing-code question, as `next` returns it.
const ASKED = '"ask_type":"project-type"';
// Reverse Engineering handed to the agent to run.
const RE_RUNS = '"kind":"run-stage","stage":"reverse-engineering"';
const ANSWER = "yes, it is our existing code";

type AuditRow = ReturnType<typeof readAuditShardEvents>[number];

function engineSaid(results: readonly CapturedToolResult[], text: string): boolean {
  return results.some((t) => t.toolName === "Bash" && t.resultText.includes(text));
}

function auditRows(proj: string): AuditRow[] {
  return readAuditShardEvents(proj);
}

function reStageRow(state: string): string | undefined {
  return /^- \[.\] reverse-engineering \S+ (EXECUTE|SKIP)$/m.exec(state)?.[1];
}

// A small TypeScript service the team copies in after the work started.
function teamCodeArrives(proj: string): void {
  const repo = join(proj, "lunch-poll");
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "package.json"), `${JSON.stringify({ name: "lunch-poll", dependencies: { express: "4.19.2" } }, null, 2)}\n`);
  writeFileSync(join(repo, "src", "server.ts"), "export const port = 3000;\n");
  expect(spawnSync("git", ["init", "-q", repo]).status).toBe(0);
}

describe("t-journey-code-arrives (sdk): a new project gains the team's code", () => {
  test(
    "the empty folder starts as a new project and says so; when code arrives the person is asked once, their yes is recorded as theirs, and Reverse Engineering runs",
    async () => {
      const deadlineMs = Date.now() + TEST_TIMEOUT_MS;
      const budget = () => remainingOperationTimeoutMs(LIVE_WORK_TIMEOUT_MS, {
        deadlineMs, reserveMs: fileCleanupReserveMs(TEST_TIMEOUT_MS), phase: "integration SDK drive",
      });
      const proj = setupIntegrationProject({ noAidlcDocs: true, stripEnvScope: true });
      try {
        mkdirSync(join(proj, "docs"), { recursive: true });
        writeFileSync(join(proj, "docs", "vision.md"), "# Lunch poll\n\nA small web app where a team votes on where to eat lunch each day.\n");

        // Chat 1: creation in the empty folder.
        const created = await driveAidlc("/aidlc --scope classic Build what vision.md describes", {
          projectDir: proj,
          persistSession: true,
          stopWhen: (results) => engineSaid(results, CREATED) && engineSaid(results, NEW_PROJECT_LINE),
          timeoutMs: budget(),
        });
        expect(engineSaid(created.toolResults, CREATED), "the work was never created").toBe(true);
        expect(engineSaid(created.toolResults, NEW_PROJECT_LINE), "the engine's new-project line never reached the agent")
          .toBe(true);
        const start = readStateFile(proj) ?? "";
        expect(readStateField(start, "Project Type")).toBe("Greenfield");
        expect(readStateField(start, "Project Type Source")).toBe("workspace scan");
        expect(reStageRow(start)).toBe("SKIP");

        teamCodeArrives(proj);

        // Chat 2: the person carries on and is shown the question in a picker,
        // where they type their answer, or in the chat, where they answer in
        // their next message. The audit is read as they answer.
        let atQuestion: number | undefined;
        let answeredInChat = false;
        const answered = await driveAidlc("/aidlc", {
          projectDir: proj,
          persistSession: true,
          answerScript: { kind: "byHeader", map: {}, fallback: { text: ANSWER } },
          onAskUserQuestion: () => { atQuestion ??= auditRows(proj).length; },
          nextMessage: (turn) => {
            if (turn.turn !== 1 || turn.askedQuestions > 0) return undefined;
            atQuestion ??= auditRows(proj).length;
            answeredInChat = true;
            return ANSWER;
          },
          stopAfterToolResult: { toolName: "Bash", resultIncludes: RE_RUNS },
          timeoutMs: budget(),
        });

        const asks = answered.toolResults.filter((t) => t.toolName === "Bash" && t.resultText.includes(ASKED));
        expect(asks.length, "the existing-code question was never asked").toBeGreaterThanOrEqual(1);
        if (answeredInChat) {
          const beforeReply = answered.toolResults.slice(0, answered.turns?.[0]?.toolResults ?? 0);
          expect(engineSaid(beforeReply, ASKED), "the person answered a question the engine never asked").toBe(true);
        }
        // Shown once at most, and no other question before Reverse Engineering.
        const shown = answered.askedQuestions.map((m) => m.questions.map((q) => q.question));
        expect(shown.length, `pickers in chat 2: ${JSON.stringify(shown)}`).toBeLessThanOrEqual(1);
        expect(atQuestion, "the person was never given the question").toBeDefined();

        const rows = auditRows(proj);
        const reclassified = rows.filter((r) => r.event === "WORKSPACE_RECLASSIFIED");
        expect(reclassified, "reclassify rows").toHaveLength(1);
        const at = rows.indexOf(reclassified[0]);
        expect(at, "reclassified before the person was asked").toBeGreaterThanOrEqual(atQuestion!);
        // The rows are read as the picker opens, or as the turn ends before the
        // person's own message, so a human turn after them is the person's.
        expect(
          rows.slice(atQuestion, at).some((r) => r.event === "HUMAN_TURN"),
          "no turn of the person's between the question and the reclassify",
        ).toBe(true);
        expect(auditBlockField(reclassified[0].block, "New Project Type")).toBe("Brownfield (you)");
        expect(auditBlockField(reclassified[0].block, "Reverse Engineering")).toBe("back on the plan");

        const end = readStateFile(proj) ?? "";
        expect(readStateField(end, "Project Type")).toBe("Brownfield");
        expect(readStateField(end, "Project Type Source")).toBe("you");
        expect(reStageRow(end)).toBe("EXECUTE");
        expect(answered.stoppedAfterToolResult, "Reverse Engineering was never started").toBe(true);
      } finally {
        cleanupTestProject(proj);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
