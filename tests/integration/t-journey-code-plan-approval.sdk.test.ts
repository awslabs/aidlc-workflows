// covers: file:aidlc-common/stages/construction/code-generation.md, hook:aidlc-record-human-turn,
// hook:aidlc-plan-approval-guard, audit:PLAN_APPROVAL_RECORDED, audit:WORKFLOW_PARKED
//
// t-journey-code-plan-approval.sdk.test.ts - Code Generation's plan question,
// end to end, with production guards (live SDK).
//
// What a person hit without this (live runs and real-run validation): a
// picker pick was not recorded; "skip plan approval?" got no answer; after an
// interruption "approve it and move on" was refused and the plan was asked
// for again.
//
// The journey: a small bugfix ("formatPrice(0) returns an empty string")
// already at Code Generation.
//   chat 1: `/aidlc`. The plan is written and the person is asked to approve
//           it. If it comes as a picker, they pick "Chat about this" to talk
//           first. Then, while the plan waits:
//             "skip plan approval?"            gets an answer, changes nothing;
//             `/aidlc --skip deployment-execution`
//                                              is done at once, and the plan
//                                              still waits;
//             "approve the plan, but let's stop there for today"
//                                              approves it, as theirs, and stops.
//   chat 2: `/aidlc --resume`. The build starts with no second question. The
//           drive ends after the first plan step is ticked, as if the session
//           closed mid-build.
//   chat 3: `/aidlc --resume`. The build picks up at the first unticked step,
//           with no second question.
//
// Pass/fail reads only what the engine and hooks recorded, the plan file, and
// the engine's own lines handed to the agent, NEVER the agent's prose.
//
// SPENDS TOKENS. Requires AIDLC_CLAUDE_SDK_LIVE=1 and --production-guards;
// the fixture profile skips it (as t-guard-live-chat-lowering does).

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { auditBlockField, readAuditShardEvents } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { planSteps as enginePlanSteps } from "../../dist/claude/.claude/tools/aidlc-testing-posture.ts";
import { cleanupTestProject, seededRecordDir, seededStateFile, setupIntegrationProject } from "../harness/fixtures.ts";
import { type CapturedAskUserQuestion, type DriveResult, driveAidlc, prepareSdkStageFixture, readStateFile } from "../harness/sdk-drive.ts";
import {
  fileCleanupReserveMs,
  LIVE_LONG_OPERATION_TIMEOUT_MS,
  liveCaseTimeoutMs,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";

const productionTest =
  process.env.AIDLC_TEST_GUARD_PROFILE === "production" ? test : test.skip;
const GUARD_SWITCHES = [
  "AIDLC_SKIP_ARTIFACT_GUARD",
  "AIDLC_SKIP_HUMAN_PRESENCE_GUARD",
  "AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD",
  "AIDLC_SKIP_REVISION_BACKSTOP",
  "AIDLC_SKIP_REVIEWER_GATE_GUARD",
  "AIDLC_SKIP_SOURCE_FRESHNESS",
  "AIDLC_DISABLE_REVIEW_FREEZE_HOOK",
  "AIDLC_DISABLE_REVIEWER_SCOPE_HOOK",
  "AIDLC_DISABLE_PLAN_APPROVAL_GUARD",
  "AIDLC_ALLOW_DIRECT_AUDIT_EVENTS",
  "AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS",
  "AIDLC_UNATTENDED",
] as const;

const TIMEOUT_S = Number.parseInt(process.env.AIDLC_TEST_TIMEOUT ?? String(LIVE_LONG_OPERATION_TIMEOUT_MS / 1000), 10);
const LIVE_WORK_TIMEOUT_MS = Number.isFinite(TIMEOUT_S) && TIMEOUT_S > 0
  ? TIMEOUT_S * 1000 : LIVE_LONG_OPERATION_TIMEOUT_MS;
const TEST_TIMEOUT_MS = liveCaseTimeoutMs(LIVE_WORK_TIMEOUT_MS);

const ASKED = '"ask_type":"plan-approval"';
const SKIP_QUESTION = "skip plan approval?";
// A stage this bugfix can leave out: Build and Test's results feed the
// deployment, so skipping it is refused for a reason of its own.
const SKIP_DEPLOYMENT = "/aidlc --skip deployment-execution";
const APPROVE_AND_STOP = "approve the plan, but let's stop there for today";
const PICKING_UP = /Picking up the code at step (\d+) of (\d+)/;
const SEP = "\u2014";

type Row = ReturnType<typeof readAuditShardEvents>[number];

// The bugfix as `intent create --scope bugfix` lays it out, moved on to Code
// Generation: Reverse Engineering and Requirements Analysis are done.
function stageRows(phase: string, rows: Array<[string, string, string]>): string {
  return [`### ${phase}`, ...rows.map(([box, slug, mode]) => `- [${box}] ${slug} ${SEP} ${mode}`)].join("\n");
}

function skipped(...slugs: string[]): Array<[string, string, string]> {
  return slugs.map((slug) => [" ", slug, "SKIP"]);
}

const STATE = `# AI-DLC State Tracking

## Project Information
- **Project**: formatPrice(0) returns an empty string instead of $0.00
- **Project Type**: Brownfield
- **Project Type Source**: workspace scan
- **Scope**: bugfix
- **State Version**: 8
- **Active Agent**: aidlc-developer-agent

## Scope Configuration
- **Stages to Execute**: 0.1, 0.2, 0.3, 2.1, 2.3, 3.5, 3.6, 4.1, 4.3
- **Stages to Skip**: 1.1 (intent-capture), 1.2 (market-research), 1.3 (feasibility), 1.4 (scope-definition), 1.5 (team-formation), 1.6 (rough-mockups), 1.7 (approval-handoff), 2.2 (practices-discovery), 2.4 (user-stories), 2.5 (refined-mockups), 2.6 (domain-design), 2.7 (units-generation), 2.8 (contract-design), 2.9 (delivery-planning), 3.1 (functional-design), 3.2 (nfr-requirements), 3.3 (nfr-design), 3.4 (infrastructure-design), 3.7 (ci-pipeline), 4.2 (environment-provisioning), 4.4 (observability-setup), 4.5 (incident-response), 4.6 (performance-validation), 4.7 (feedback-optimization)
- **Depth**: Minimal
- **Test Strategy**: Minimal
- **Guard Policy**: off (from scope bugfix)
- **Sensors**: on (from scope bugfix)
- **Learnings**: off (from scope bugfix)
- **Summary Confirmation**: off (from scope bugfix)
- **Plan Approval**: on (from scope bugfix)

## Workspace State
- **Project Root**: .
- **Languages**: JavaScript
- **Build System**: npm (package.json)

## Runtime State
- **Revision Count**: 0

## Phase Progress
- **Initialization**: Verified
- **Ideation**: Skipped
- **Inception**: Verified
- **Construction**: Active
- **Operation**: Pending

## Stage Progress

${stageRows("INITIALIZATION PHASE", [["x", "workspace-scaffold", "EXECUTE"], ["x", "workspace-detection", "EXECUTE"], ["x", "state-init", "EXECUTE"]])}

${stageRows("IDEATION PHASE", skipped("intent-capture", "market-research", "feasibility", "scope-definition", "team-formation", "rough-mockups", "approval-handoff"))}

${stageRows("INCEPTION PHASE", [["x", "reverse-engineering", "EXECUTE"], ...skipped("practices-discovery"), ["x", "requirements-analysis", "EXECUTE"], ...skipped("user-stories", "refined-mockups", "domain-design", "units-generation", "contract-design", "delivery-planning")])}

${stageRows("CONSTRUCTION PHASE", [...skipped("functional-design", "nfr-requirements", "nfr-design", "infrastructure-design"), ["-", "code-generation", "EXECUTE"], [" ", "build-and-test", "EXECUTE"], ...skipped("ci-pipeline")])}

${stageRows("OPERATION PHASE", [[" ", "deployment-pipeline", "EXECUTE"], ...skipped("environment-provisioning"), [" ", "deployment-execution", "EXECUTE"], ...skipped("observability-setup", "incident-response", "performance-validation", "feedback-optimization")])}

## Current Status
- **Lifecycle Phase**: CONSTRUCTION
- **Current Stage**: code-generation
- **Next Stage**: build-and-test
- **Status**: Running
`;

async function seedBugfixAtCodeGeneration(proj: string): Promise<string> {
  mkdirSync(join(proj, "src"), { recursive: true });
  writeFileSync(join(proj, "package.json"), `${JSON.stringify({ name: "price-format", type: "module", scripts: { test: "node --test" } }, null, 2)}\n`);
  writeFileSync(join(proj, "src", "price.js"),
    "export function formatPrice(cents) {\n  if (!cents) return \"\";\n  return `$${(cents / 100).toFixed(2)}`;\n}\n");
  writeFileSync(seededStateFile(proj), STATE);
  const record = seededRecordDir(proj);
  mkdirSync(join(record, "inception", "requirements-analysis"), { recursive: true });
  writeFileSync(join(record, "inception", "requirements-analysis", "requirements.md"),
    "# Requirements\n\n## Bug\n`formatPrice(0)` returns an empty string. It must return `$0.00`.\n\n" +
    "## Acceptance\n- `formatPrice(0)` is `$0.00`.\n- `formatPrice(1999)` is still `$19.99`.\n");
  await prepareSdkStageFixture(proj, "code-generation");
  return join(record, "construction", "code-generation", "code-generation-plan.md");
}

// Top-level plan steps, in order: true when ticked.
// Each plan step's tick, read the way the engine reads the plan when it picks
// a build up.
function planSteps(planPath: string): boolean[] {
  if (!existsSync(planPath)) return [];
  return enginePlanSteps(readFileSync(planPath, "utf-8")).map((step) => step.ticked);
}

function untickLastStep(planPath: string): void {
  const plan = readFileSync(planPath, "utf-8");
  const at = Math.max(plan.lastIndexOf("- [x]"), plan.lastIndexOf("- [X]"));
  expect(at, "no ticked step to untick").toBeGreaterThanOrEqual(0);
  writeFileSync(planPath, `${plan.slice(0, at)}- [ ]${plan.slice(at + "- [x]".length)}`, "utf-8");
}

function rowsOf(proj: string, event: string): Row[] {
  return readAuditShardEvents(proj).filter((row) => row.event === event);
}

function engineSaid(result: DriveResult, text: string | RegExp): boolean {
  return result.toolResults.some((t) => t.toolName === "Bash" &&
    (typeof text === "string" ? t.resultText.includes(text) : text.test(t.resultText)));
}

// The plan question as a picker: it offers both approving and changing the plan.
function isPlanQuestion(menu: CapturedAskUserQuestion): boolean {
  const labels = menu.questions.flatMap((q) => q.options.map((o) => o.label));
  return labels.some((l) => /approve/i.test(l)) && labels.some((l) => /change/i.test(l));
}

// The agent's offer, after "skip plan approval?", to turn plan approval off:
// the person was only asking, so they do not take it and go on.
function isPlanApprovalOffOffer(menu: CapturedAskUserQuestion): boolean {
  return menu.questions.some((q) => /plan approval/i.test(q.question) && q.options.some((o) => /\boff\b/i.test(o.label)));
}

function stageMode(state: string, slug: string): string | undefined {
  return new RegExp(`^- \\[.\\] ${slug} \\S+ (EXECUTE|SKIP)$`, "m").exec(state)?.[1];
}

describe.skipIf(
  process.env.AIDLC_CLAUDE_SDK_LIVE !== "1" ||
    process.env.AIDLC_NO_LLM === "1" ||
    !Bun.which("claude"),
)("t-journey-code-plan-approval (sdk, production guards): the code plan is asked once and the person's answers stand", () => {
  productionTest("one question, a question about it, a skip, an approval with a stop, a resume, an interrupted build", async () => {
    for (const key of GUARD_SWITCHES) {
      expect(process.env[key], `${key} disables the production contract`).not.toBe("1");
    }
    const deadlineMs = Date.now() + TEST_TIMEOUT_MS;
    const budget = () => remainingOperationTimeoutMs(LIVE_WORK_TIMEOUT_MS, {
      deadlineMs, reserveMs: fileCleanupReserveMs(TEST_TIMEOUT_MS), phase: "integration SDK drive",
    });
    const proj = setupIntegrationProject({ stripEnvScope: true });
    try {
      const planPath = await seedBugfixAtCodeGeneration(proj);
      const turnEnds: Array<{ turn: number; approvals: number; parked: number; state: string }> = [];
      const replies = [SKIP_QUESTION, SKIP_DEPLOYMENT, APPROVE_AND_STOP];

      // Chat 1: the plan is written and asked about; the person's two messages.
      const chat1 = await driveAidlc("/aidlc", {
        projectDir: proj,
        persistSession: true,
        // The plan question gets "Chat about this": the person's only answer
        // to it is the one they type. So does an offer to turn plan approval
        // off. Any other question the agent asks takes its first option.
        chatAboutQuestionWhen: (menu) => isPlanQuestion(menu) || isPlanApprovalOffOffer(menu),
        nextMessage: (turn) => {
          turnEnds.push({
            turn: turn.turn,
            approvals: rowsOf(proj, "PLAN_APPROVAL_RECORDED").length,
            parked: rowsOf(proj, "WORKFLOW_PARKED").length,
            state: readStateFile(proj) ?? "",
          });
          return replies[turn.turn - 1];
        },
        timeoutMs: budget(),
      });
      expect(chat1.timedOut, "chat 1 timed out").toBe(false);
      expect(engineSaid(chat1, ASKED), "the plan question was never asked").toBe(true);
      expect(planSteps(planPath).length, "the plan has no steps").toBeGreaterThan(1);
      const pickers = chat1.askedQuestions.map((m) => m.questions.map((q) => q.question));
      expect(turnEnds.length, `turns that ended: ${turnEnds.length}; pickers: ${JSON.stringify(pickers)}`).toBe(4);
      const [asked, afterQuestion, afterSkip] = turnEnds;

      // While the plan waited, nothing was approved, and the question about
      // plan approval changed nothing.
      for (const end of [asked, afterQuestion, afterSkip]) expect(end.approvals).toBe(0);
      expect(afterQuestion.state).toContain("- **Plan Approval**: on (from scope bugfix)");
      expect(rowsOf(proj, "CEREMONY_SET"), "plan approval was switched").toEqual([]);
      expect(stageMode(afterQuestion.state, "build-and-test")).toBe("EXECUTE");
      // The skip the person typed was done at once, with the plan still waiting.
      expect(stageMode(afterSkip.state, "deployment-execution"), "the typed skip was not done").toBe("SKIP");

      // "approve the plan, but let's stop there for today": approved as theirs, then stopped.
      const approvals = rowsOf(proj, "PLAN_APPROVAL_RECORDED");
      expect(approvals, `plan approvals after chat 1; pickers: ${JSON.stringify(pickers)}`).toHaveLength(1);
      expect(auditBlockField(approvals[0].block, "Person Reply") ?? "").toContain("approve the plan");
      expect(rowsOf(proj, "WORKFLOW_PARKED"), "the workflow did not stop for today").toHaveLength(1);
      expect(planSteps(planPath).some(Boolean), "the build ran after the person said stop").toBe(false);

      // Chat 2: resume; the build starts with no second question and is cut off
      // once its first step is ticked.
      const chat2 = await driveAidlc("/aidlc --resume", {
        projectDir: proj,
        persistSession: true,
        stopWhen: () => planSteps(planPath).some(Boolean),
        timeoutMs: budget(),
      });
      expect(chat2.stoppedWhen, "the build never ticked a step").toBe(true);
      expect(engineSaid(chat2, ASKED), "the plan was asked about again after approval").toBe(false);
      let interrupted = planSteps(planPath);
      // The agent may do the work and then tick every step in one edit, so
      // the chat is cut off with nothing left unticked. Picking up reads the
      // ticks (task markers are outside what was approved), so the last step
      // is unticked: the build was cut off before it.
      if (!interrupted.includes(false)) {
        untickLastStep(planPath);
        interrupted = planSteps(planPath);
      }
      const firstUnticked = interrupted.indexOf(false) + 1;
      expect(firstUnticked, "every step was ticked before the interruption").toBeGreaterThan(0);

      // Chat 3: resume again; the build picks up at the first unticked step.
      const chat3 = await driveAidlc("/aidlc --resume", {
        projectDir: proj,
        persistSession: true,
        stopAfterToolResult: { toolName: "Bash", resultIncludes: "Picking up the code at step" },
        timeoutMs: budget(),
      });
      expect(chat3.stoppedAfterToolResult, "the build was not picked up").toBe(true);
      expect(engineSaid(chat3, ASKED), "the plan was asked about again after the interruption").toBe(false);
      const pickedUp = chat3.toolResults.map((t) => PICKING_UP.exec(t.resultText)).find(Boolean);
      expect(Number(pickedUp?.[1]), `picked up at the wrong step; ticks at the interruption: ${JSON.stringify(interrupted)}`)
        .toBe(firstUnticked);
      expect(rowsOf(proj, "PLAN_APPROVAL_RECORDED"), "plan approvals at the end").toHaveLength(1);
    } finally {
      cleanupTestProject(proj);
    }
  }, TEST_TIMEOUT_MS);
});
