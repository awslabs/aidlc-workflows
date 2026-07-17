// covers: stage:inception/user-stories, subcommand:aidlc-orchestrate:report
//
// t238 - live Claude SDK coverage for the user-stories mob topology.
//
// The deterministic evidence guard is covered exhaustively by t236. This test
// covers the live conductor half: a workflow seeded at user-stories must emit a
// run-stage directive, dispatch the design/developer/quality participants with
// mutually blind round-1 briefs, collect their identity-marked contribution
// files, integrate as the product lead, and approve only after that evidence is
// present. A preflight report on the same fixture proves the missing-evidence
// refusal without reproducing t236's full guard matrix.
//
// It SPENDS TOKENS: driveAidlc runs the real user-stories stage, its three mob
// participants, and product-lead reviewer through the Claude Agent SDK.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import {
  cleanupTestProject,
  seededAuditDir,
  seededRecordDir,
  seededStateFile,
  setupIntegrationProject,
} from "../harness/fixtures.ts";
import {
  driveAidlc,
  readStateField,
  type CapturedToolResult,
} from "../harness/sdk-drive.ts";

const TIMEOUT_S = Number.parseInt(process.env.AIDLC_TEST_TIMEOUT ?? "1800", 10);
const TEST_TIMEOUT_MS = (Number.isFinite(TIMEOUT_S) ? TIMEOUT_S : 1800) * 1000;
const DRIVE_TIMEOUT_MS = Math.max(180_000, TEST_TIMEOUT_MS - 15_000);

const SUPPORT_AGENTS = [
  "aidlc-design-agent",
  "aidlc-developer-agent",
  "aidlc-quality-agent",
] as const;
const RULE_PATHS = [
  "aidlc/spaces/default/memory/org.md",
  "aidlc/spaces/default/memory/team.md",
  "aidlc/spaces/default/memory/project.md",
  "aidlc/spaces/default/memory/phases/inception.md",
] as const;

const APPROVE_ALL = {
  kind: "byHeader" as const,
  map: {
    Resume: { labelContains: "Resume" },
    Approval: { labelContains: "Approve" },
  },
  fallback: { labelContains: "Approve" },
};

interface Directive {
  kind?: string;
  message?: string;
}

function userStoriesState(projectDir: string): string {
  return `# AI-DLC State Tracking

## Project Information
- **Project**: Accessible event check-in
- **Project Type**: Greenfield
- **Scope**: feature
- **Start Date**: 2026-07-17T00:00:00Z
- **State Version**: 7
- **Active Agent**: aidlc-product-agent
- **Worktree Path**:
- **Bolt Refs**:
- **Practices Affirmed Timestamp**:

## Scope Configuration
- **Stages to Execute**: 0.1, 0.2, 0.3, 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 2.2, 2.3, 2.4
- **Stages to Skip**: 2.1, 2.5, 2.6, 2.7, 2.8, 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7
- **Depth**: Minimal
- **Test Strategy**: Minimal

## Workspace State
- **Project Root**: ${projectDir}
- **Languages**: TypeScript
- **Frameworks**: React
- **Build System**: npm

## Execution Plan Summary
- **Total Stages**: 13
- **Completed**: 12
- **In Progress**: user-stories

## Runtime State
- **Revision Count**: 0

## Phase Progress
<!-- Status values: Pending, Active, Verified, Skipped -->

- **Initialization**: Verified
- **Ideation**: Verified
- **Inception**: Active
- **Construction**: Skipped
- **Operation**: Skipped

## Stage Progress

### INITIALIZATION PHASE
- [x] workspace-scaffold — EXECUTE
- [x] workspace-detection — EXECUTE
- [x] state-init — EXECUTE

### IDEATION PHASE
- [x] intent-capture — EXECUTE
- [x] market-research — EXECUTE
- [x] feasibility — EXECUTE
- [x] scope-definition — EXECUTE
- [x] team-formation — EXECUTE
- [x] rough-mockups — EXECUTE
- [x] approval-handoff — EXECUTE

### INCEPTION PHASE
- [S] reverse-engineering — SKIP (greenfield)
- [x] practices-discovery — EXECUTE
- [x] requirements-analysis — EXECUTE
- [-] user-stories — EXECUTE
- [S] refined-mockups — SKIP (live SDK fixture terminal boundary)
- [S] application-design — SKIP (live SDK fixture terminal boundary)
- [S] units-generation — SKIP (live SDK fixture terminal boundary)
- [S] delivery-planning — SKIP (live SDK fixture terminal boundary)

### CONSTRUCTION PHASE
Per unit: [unit-name]
- [S] functional-design — SKIP (live SDK fixture terminal boundary)
- [S] nfr-requirements — SKIP (live SDK fixture terminal boundary)
- [S] nfr-design — SKIP (live SDK fixture terminal boundary)
- [S] infrastructure-design — SKIP (live SDK fixture terminal boundary)
- [S] code-generation — SKIP (live SDK fixture terminal boundary)
- [S] build-and-test — SKIP (live SDK fixture terminal boundary)
- [S] ci-pipeline — SKIP (live SDK fixture terminal boundary)

### OPERATION PHASE
- [S] deployment-pipeline — SKIP (live SDK fixture terminal boundary)
- [S] environment-provisioning — SKIP (live SDK fixture terminal boundary)
- [S] deployment-execution — SKIP (live SDK fixture terminal boundary)
- [S] observability-setup — SKIP (live SDK fixture terminal boundary)
- [S] incident-response — SKIP (live SDK fixture terminal boundary)
- [S] performance-validation — SKIP (live SDK fixture terminal boundary)
- [S] feedback-optimization — SKIP (live SDK fixture terminal boundary)

## Current Status
- **Lifecycle Phase**: INCEPTION
- **Current Stage**: user-stories
- **Next Stage**: none
- **Status**: Running
- **Last Updated**: 2026-07-17T00:00:00Z

## Session Resume Point
- **Last Completed Stage**: requirements-analysis
- **Next Action**: Complete user-stories with the declared mob
- **Pending Artifacts**: stories, personas, user-stories-assessment
`;
}

function seedRequirements(projectDir: string): void {
  const dir = join(
    seededRecordDir(projectDir),
    "inception",
    "requirements-analysis",
  );
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "requirements.md"),
    `# Requirements Analysis

## Functional Requirements

### FR-1: Attendee self check-in
- An attendee can find a registration by confirmation code.
- An attendee can review the matched name before checking in.
- A successful check-in shows a durable confirmation and cannot be submitted twice.

### FR-2: Staff exception handling
- Event staff can identify an invalid or already-used confirmation code.
- Event staff can direct an attendee to a staffed help path without exposing another attendee's data.

## Non-Functional Requirements
- **Accessibility**: The primary flow is keyboard operable and status changes are announced.
- **Performance**: A lookup returns or times out within two seconds.
- **Privacy**: Results reveal only the minimum registration data needed to confirm identity.

## Constraints
- The first release supports one event and one attendee per confirmation code.
- English copy is acceptable for the first release.
`,
  );
}

function seedRuntimeGraph(projectDir: string): void {
  const memoryPath = relative(
    projectDir,
    join(
      seededRecordDir(projectDir),
      "inception",
      "user-stories",
      "memory.md",
    ),
  ).replaceAll("\\", "/");
  writeFileSync(
    join(seededRecordDir(projectDir), "runtime-graph.json"),
    `${JSON.stringify(
      {
        workflow_id: "t238-user-stories-mob",
        scope: "feature",
        stages: [
          {
            stage_slug: "user-stories",
            memory_path: memoryPath,
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
}

function contributionPath(projectDir: string, agent: string): string {
  return join(
    seededRecordDir(projectDir),
    "inception",
    "user-stories",
    "contributions",
    `${agent}.md`,
  );
}

function hasIdentityMarkedContribution(projectDir: string, agent: string): boolean {
  const path = contributionPath(projectDir, agent);
  if (!existsSync(path)) return false;
  const firstLine = readFileSync(path, "utf-8").split("\n", 1)[0].trim();
  return firstLine === `**Collaborator:** ${agent}`;
}

function auditText(projectDir: string): string {
  const dir = seededAuditDir(projectDir);
  if (!existsSync(dir)) return "";
  return readdirSync(dir)
    .filter((name) => name.endsWith(".md"))
    .map((name) => readFileSync(join(dir, name), "utf-8"))
    .join("\n");
}

function eventCount(projectDir: string, event: string): number {
  return auditText(projectDir).split(`**Event**: ${event}`).length - 1;
}

function reportApprovedWithoutEvidence(projectDir: string): Directive {
  const run = spawnSync(
    process.execPath,
    [
      join(projectDir, ".claude", "tools", "aidlc-orchestrate.ts"),
      "report",
      "--stage",
      "user-stories",
      "--result",
      "approved",
      "--user-input",
      "Approve",
      "--project-dir",
      projectDir,
    ],
    { cwd: projectDir, encoding: "utf-8", env: process.env },
  );
  expect(run.status, run.stderr).toBe(0);
  const line = run.stdout.trim().split("\n").pop() ?? "";
  return JSON.parse(line) as Directive;
}

function dispatchedAgent(result: CapturedToolResult): string | undefined {
  if (result.toolName !== "Task" && result.toolName !== "Agent") return undefined;
  return typeof result.input.subagent_type === "string"
    ? result.input.subagent_type
    : undefined;
}

function inputMentions(result: CapturedToolResult, value: string): boolean {
  return JSON.stringify(result.input).includes(value);
}

function shellCommand(result: CapturedToolResult): string | undefined {
  if (result.toolName !== "Bash" && result.toolName !== "Shell") return undefined;
  return typeof result.input.command === "string"
    ? result.input.command
    : undefined;
}

describe("t238 user-stories mob topology (Claude SDK live)", () => {
  test(
    "three mutually blind supports write evidence, the lead integrates, and approval then succeeds",
    async () => {
      const projectDir = setupIntegrationProject({ withAudit: true });
      try {
        writeFileSync(seededStateFile(projectDir), userStoriesState(projectDir));
        seedRequirements(projectDir);
        seedRuntimeGraph(projectDir);

        // Deterministic control on this exact live fixture: approval is refused
        // before the mob writes its evidence, and the refusal commits no gate.
        const approvedBefore = eventCount(projectDir, "GATE_APPROVED");
        const refused = reportApprovedWithoutEvidence(projectDir);
        expect(refused.kind).toBe("error");
        expect(refused.message).toContain("ensemble must convene");
        for (const agent of SUPPORT_AGENTS) {
          expect(refused.message).toContain(agent);
          expect(existsSync(contributionPath(projectDir, agent))).toBe(false);
        }
        expect(eventCount(projectDir, "GATE_APPROVED")).toBe(approvedBefore);

        let approvalMenuSeen = false;
        let evidenceCompleteAtApproval = false;
        const result = await driveAidlc("/aidlc", {
          projectDir,
          answerScript: APPROVE_ALL,
          timeoutMs: DRIVE_TIMEOUT_MS,
          // The approved report is the deterministic terminal boundary for
          // this fixture. aidlc-state approve auto-completes a final stage, so
          // the report tool_result arrives only after WORKFLOW_COMPLETED and
          // the final state write have committed.
          stopAfterToolResult: {
            toolName: "Bash",
            resultIncludes: "Committed approve for",
          },
          onAskUserQuestion: (menu) => {
            const labels = menu.questions.flatMap((question) =>
              question.options.map((option) => option.label)
            );
            if (labels.some((label) => label.includes("Approve"))) {
              approvalMenuSeen = true;
              evidenceCompleteAtApproval = SUPPORT_AGENTS.every((agent) =>
                hasIdentityMarkedContribution(projectDir, agent)
              );
            }
          },
        });

        // This run intentionally stops on the final approved report's
        // tool_result, before a terminal SDK result event. It must never be
        // confused with the timeout that previously occurred during trailing
        // reviewer work under suite contention.
        expect(result.timedOut).toBe(false);
        expect(result.stoppedAfterToolResult).toBe(true);
        expect(result.stoppedAfterAskUserQuestion).toBe(false);

        const commands = result.toolResults
          .map(shellCommand)
          .filter((command): command is string => command !== undefined);
        const reportCommands = commands.filter((command) =>
          /aidlc-orchestrate\.ts["']?\s+report\b/.test(command)
        );
        const stagePinned = /--stage(?:=|\s+)(?:["'])?user-stories\b/;
        const awaitingIndex = reportCommands.findIndex(
          (command) =>
            stagePinned.test(command) &&
            /--result(?:=|\s+)(?:["'])?awaiting-approval\b/.test(command),
        );
        const approvedIndex = reportCommands.findIndex(
          (command) =>
            stagePinned.test(command) &&
            /--result(?:=|\s+)(?:["'])?approved\b/.test(command),
        );
        expect(
          awaitingIndex,
          `missing stage-pinned awaiting-approval report: ${JSON.stringify(reportCommands)}`,
        ).toBeGreaterThanOrEqual(0);
        expect(
          approvedIndex,
          `missing stage-pinned approved report: ${JSON.stringify(reportCommands)}`,
        ).toBeGreaterThan(awaitingIndex);

        const directLifecycleStateCall =
          /aidlc-state\.ts["']?\s+(?:advance|approve|complete-workflow|gate-start|reject|revise|skip)\b/;
        expect(
          commands.filter((command) => directLifecycleStateCall.test(command)),
          "lifecycle transitions must be reported through aidlc-orchestrate.ts",
        ).toEqual([]);
        for (const toolResult of result.toolResults) {
          if (toolResult.toolName !== "Write" && toolResult.toolName !== "Edit") continue;
          expect(
            inputMentions(toolResult, "aidlc-state.md"),
            `${toolResult.toolName} must not mutate aidlc-state.md directly`,
          ).toBe(false);
        }

        // The live turn actually received and acted on user-stories run-stage.
        const runStage = result.toolResults.find(
          (toolResult) =>
            toolResult.toolName === "Bash" &&
            /"kind"\s*:\s*"run-stage"/.test(toolResult.resultText) &&
            /"stage"\s*:\s*"user-stories"/.test(toolResult.resultText),
        );
        expect(runStage, "expected the engine's user-stories run-stage directive").toBeDefined();
        expect(runStage?.resultText).toContain(
          ".claude/agents/aidlc-product-agent.md",
        );
        for (const support of SUPPORT_AGENTS) {
          expect(runStage?.resultText).not.toContain(
            `.claude/agents/${support}.md`,
          );
        }
        expect(
          result.toolResults.some(
            (toolResult) =>
              toolResult.toolName === "Read" &&
              inputMentions(
                toolResult,
                ".claude/agents/aidlc-product-agent.md",
              ),
          ),
          "the inline mob lead persona was not read",
        ).toBe(true);

        // Round 1 dispatched every declared support. Each brief names the
        // shared draft/input and exact rule paths, plus only that participant's
        // contribution filename, never a sibling's contribution.
        const roundOne = new Map<string, CapturedToolResult>();
        for (const agent of SUPPORT_AGENTS) {
          const dispatch = result.toolResults.find(
            (toolResult) => dispatchedAgent(toolResult) === agent,
          );
          expect(dispatch, `missing live support dispatch for ${agent}`).toBeDefined();
          roundOne.set(agent, dispatch as CapturedToolResult);

          const prompt = String(dispatch?.input.prompt ?? "");
          expect(prompt).toContain("stories.md");
          expect(prompt).toContain("personas.md");
          expect(prompt).toContain("requirements.md");
          expect(prompt).toContain(`${agent}.md`);
          for (const rulePath of RULE_PATHS) {
            expect(prompt).toContain(rulePath);
          }
          for (const sibling of SUPPORT_AGENTS) {
            if (sibling === agent) continue;
            expect(
              prompt,
              `${agent}'s round-1 brief exposed ${sibling}'s contribution`,
            ).not.toContain(`${sibling}.md`);
          }
        }

        // After all support results return, the lead must perform a write/edit
        // of a produced artifact (or dispatch the product lead to integrate).
        const lastSupportResult = Math.max(
          ...SUPPORT_AGENTS.map((agent) =>
            result.toolResults.indexOf(roundOne.get(agent) as CapturedToolResult)
          ),
        );
        const afterSupports = result.toolResults.slice(lastSupportResult + 1);
        const leadIntegrated = afterSupports.some((toolResult) => {
          const mutatesProducedArtifact =
            (toolResult.toolName === "Write" || toolResult.toolName === "Edit") &&
            (inputMentions(toolResult, "stories.md") ||
              inputMentions(toolResult, "personas.md"));
          const productLeadIntegration =
            dispatchedAgent(toolResult) === "aidlc-product-agent" &&
            /integrat/i.test(String(toolResult.input.prompt ?? ""));
          return mutatesProducedArtifact || productLeadIntegration;
        });
        expect(
          leadIntegrated,
          "expected a lead-owned integration step after all round-1 support results",
        ).toBe(true);

        // Permanent evidence and final lead-owned artifacts landed on disk.
        for (const agent of SUPPORT_AGENTS) {
          const path = contributionPath(projectDir, agent);
          expect(existsSync(path), `missing ${path}`).toBe(true);
          const contribution = readFileSync(path, "utf-8");
          expect(contribution.split("\n", 1)[0].trim()).toBe(
            `**Collaborator:** ${agent}`,
          );
          expect(contribution).toContain("## Contribution");
          expect(contribution).toContain("## Positions");
        }

        const stageDir = join(
          seededRecordDir(projectDir),
          "inception",
          "user-stories",
        );
        for (const artifact of [
          "stories.md",
          "personas.md",
          "user-stories-assessment.md",
        ]) {
          const path = join(stageDir, artifact);
          expect(existsSync(path), `missing integrated artifact ${path}`).toBe(true);
          expect(readFileSync(path, "utf-8").trim().length).toBeGreaterThan(0);
        }

        // The human approval menu appeared only after all evidence existed;
        // report then committed the gate and completed this terminal fixture.
        expect(approvalMenuSeen).toBe(true);
        expect(evidenceCompleteAtApproval).toBe(true);
        expect(result.auditEvents).toContain("GATE_APPROVED");
        expect(result.auditEvents).toContain("STAGE_COMPLETED");
        expect(result.auditEvents).toContain("WORKFLOW_COMPLETED");
        expect(eventCount(projectDir, "GATE_APPROVED")).toBe(approvedBefore + 1);
        expect(
          result.toolResults.some((toolResult) =>
            toolResult.resultText.includes("ensemble must convene")
          ),
          "live approval was refused after the mob wrote complete evidence",
        ).toBe(false);

        expect(result.stateFile).toBeDefined();
        expect(readStateField(result.stateFile as string, "Status")).toBe("Completed");
        expect(result.stateFile).toMatch(/- \[x\] user-stories — EXECUTE/);
      } finally {
        cleanupTestProject(projectDir);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
