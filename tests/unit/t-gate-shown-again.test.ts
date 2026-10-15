// covers: subcommand:aidlc-orchestrate:next, subcommand:aidlc-orchestrate:report, hook:aidlc-continue-workflow
// covers: function:markTurnEnd, function:turnEndIsOpen
//
// A live run on Codex (E15-X): at the Requirements Analysis gate the person
// asked for a change, and at Code Generation for a second review. Each time the
// agent showed the gate again, as the engine's own step said, and the Stop hook
// carried the turn on ("AI-DLC is carrying on with ..."): their reply was on
// record since the gate opened, and showing the gate again recorded nothing.
// The gate came twice in one reply. And after the change, the gate-only step
// let the agent show the gate before the report that says the change and
// offers to have it checked; that line came only with the second gate.
//
// The steps that show the gate again end the turn, until the person writes;
// at an open gate whose reviewed work changed and is not on record, `next`
// hands the gate's report first. A reply to the gate shown again still carries
// the turn on into recording it (#2532).

import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import {
  readAuditShardEvents,
  setGuardPolicyLine,
  turnEndMarkerPath,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  cleanupTestProject,
  seededRecordDir,
  seededStateFile,
  setupIntegrationProject,
} from "../harness/fixtures.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const STAGE = "requirements-analysis";
const REVIEWER = "aidlc-product-lead-agent";
const SESSION = "gate-again";
const OFFER = "Do you want me to have the new approach checked before you decide?";
const CARRY_ON = "AI-DLC is carrying on with Requirements Analysis.";
const ENV: NodeJS.ProcessEnv = {
  ...process.env,
  AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS: "1",
  AIDLC_SKIP_ARTIFACT_GUARD: "1",
  AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD: "1",
  AIDLC_SKIP_REVIEWER_GATE_GUARD: "0",
  CLAUDE_CODE_STOP_HOOK_BLOCK_CAP: "",
};
delete ENV.AIDLC_SKIP_HUMAN_PRESENCE_GUARD;
delete ENV.AIDLC_STOP_HOOK_PROBE;
delete ENV.AIDLC_COPILOT_SESSION_ID;

const projects: string[] = [];
afterAll(() => {
  for (const dir of projects) cleanupTestProject(dir);
});

type Policy = "strict" | "relaxed" | "off";

// The install inside the project, as a person has it: a hook run from
// outside the project's own install stands aside.
function project(policy: Policy): string {
  const proj = setupIntegrationProject({ withState: "state-mid-inception.md", stripEnvScope: true });
  projects.push(proj);
  const statePath = seededStateFile(proj);
  writeFileSync(statePath, setGuardPolicyLine(readFileSync(statePath, "utf-8"), `${policy} (set by you)`));
  return proj;
}

function engine(proj: string, args: string[], input?: string) {
  const result = spawnSync(process.execPath, [join(proj, ".claude", "tools", "aidlc.ts"), ...args], {
    cwd: proj,
    input,
    encoding: "utf-8",
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    env: { ...ENV, CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj },
  });
  return { status: result.status, stdout: result.stdout ?? "", out: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

function step(proj: string, args: string[]): Record<string, unknown> {
  const result = engine(proj, ["engine", "orchestrate", ...args]);
  expect(result.status, result.out).toBe(0);
  return JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "{}") as Record<string, unknown>;
}

function artifact(proj: string): string {
  return join(seededRecordDir(proj), "inception", STAGE, "requirements.md");
}

// The stage's outputs, then one READY review through the logger.
function reviewedStage(proj: string): void {
  const dir = join(seededRecordDir(proj), "inception", STAGE);
  mkdirSync(dir, { recursive: true });
  for (const name of ["requirements.md", `${STAGE}-questions.md`]) {
    if (!existsSync(join(dir, name))) writeFileSync(join(dir, name), `# ${name}\n`);
  }
  const base = ["engine", "log", "review", "--stage", STAGE, "--reviewer", REVIEWER, "--iteration", "1"];
  const requested = engine(proj, base);
  expect(requested.status, requested.out).toBe(0);
  appendFileSync(
    artifact(proj),
    `\n## Review\n\n**Verdict:** READY\n**Reviewer:** ${REVIEWER}\n**Iteration:** 1\n\n### Findings\n\nNo blocking findings.\n`,
  );
  const completed = engine(proj, [...base, "--verdict", "READY"]);
  expect(completed.status, completed.out).toBe(0);
}

// The gate as the agent opens it after the review.
function openGate(proj: string): void {
  reviewedStage(proj);
  const opened = step(proj, ["report", "--stage", STAGE, "--result", "awaiting-approval"]);
  expect(opened.kind).toBe("print");
}

// The person's message, as the human-turn hook records it.
async function personSays(proj: string, prompt: string): Promise<void> {
  const result = engine(proj, ["engine", "hook", "record-human-turn"], JSON.stringify({
    hook_event_name: "UserPromptSubmit", session_id: SESSION, prompt,
  }));
  expect(result.status, result.out).toBe(0);
  await Bun.sleep(20);
}

// The change the person asked for, made at the gate as the write hook records it.
function askedChange(proj: string): void {
  appendFileSync(artifact(proj), "\nAn empty name prints hello there.\n");
  appendAuditEntry("ARTIFACT_UPDATED", {
    File: relative(proj, artifact(proj)).replaceAll("\\", "/"),
    Tool: "Edit",
    Context: `inception > ${STAGE} > requirements.md`,
  }, proj);
}

function stop(proj: string, transcript?: string) {
  return engine(proj, ["engine", "hook", "continue-workflow"], JSON.stringify({
    hook_event_name: "Stop",
    stop_hook_active: false,
    session_id: SESSION,
    ...(transcript ? { transcript_path: transcript } : {}),
  }));
}

// The chat as Claude Code records it: the person's message, the agent's
// engine call, then the gate in prose; with `picked`, the gate in the question
// box instead, the person's pick as its tool result, and the agent's last words.
function claudeTranscript(proj: string, command: string, picked?: string): string {
  const path = join(proj, "transcript.jsonl");
  const question = "Requirements Analysis is ready. How would you like to proceed?";
  const entries = [
    { type: "user", message: { role: "user", content: "review it again" } },
    { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "b1", name: "Bash", input: { command } }] } },
    { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "b1", content: "{}" }] } },
    ...(picked === undefined
      ? [{ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Approve, or request changes?" }] } }]
      : [
        { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "q1", name: "AskUserQuestion", input: { questions: [{ question }] } }] } },
        { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "q1", content: `Your questions have been answered: "${question}"="${picked}".` }] } },
        { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Approved." }] } },
      ]),
  ];
  writeFileSync(path, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
  return path;
}

describe("t-gate-shown-again", () => {
  for (const shownBy of ["next", "report"] as const) {
    for (const evidence of ["markers", "claude"] as const) {
      test(`the gate shown again by ${shownBy} after the person's reply ends the turn (${evidence})${evidence === "claude" ? "; a pick at it carries on" : ""}`, async () => {
        const proj = project("off");
        openGate(proj);
        await personSays(proj, "review it again");
        const args = shownBy === "next" ? ["next"] : ["report", "--stage", STAGE, "--result", "awaiting-approval"];
        const shown = step(proj, args);
        if (shownBy === "next") expect(shown).toMatchObject({ kind: "run-stage", gate_only: true });
        else expect(shown.message).toBe(`Stage "${STAGE}" is already awaiting approval; gate evidence revalidated.`);
        const transcript = evidence === "claude"
          ? claudeTranscript(proj, `bun .claude/tools/aidlc.ts engine orchestrate ${args.join(" ")}`)
          : undefined;
        const atGate = stop(proj, transcript);
        expect(atGate.status, atGate.out).toBe(0);
        expect(atGate.stdout).not.toContain('"decision"');
        expect(existsSync(turnEndMarkerPath(proj))).toBe(true);

        // The person picks Approve at the gate shown again (a question box's
        // reply, no new prompt) and the agent ends its turn with nothing
        // recorded: their choice is owed (#2532). A reply typed as a new
        // message and answered with no engine call ends as a chat, as before.
        if (evidence === "claude") {
          await personSays(proj, "Approve");
          const owed = stop(proj, claudeTranscript(proj, `bun .claude/tools/aidlc.ts engine orchestrate ${args.join(" ")}`, "Approve"));
          expect(owed.status, owed.out).toBe(0);
          expect(owed.stdout).toContain(CARRY_ON);
        }
      });
    }
  }

  for (const policy of ["relaxed", "off"] as const) {
    test(`an asked change at the open gate (${policy}): next hands the gate's report first, which says the change once with the offer`, async () => {
      const proj = project(policy);
      openGate(proj);
      await personSays(proj, "also make an empty name print hello there");
      askedChange(proj);
      const owed = step(proj, ["next"]);
      expect(owed.kind).toBe("print");
      expect(owed.message).toContain(`report --stage ${STAGE} --result awaiting-approval`);
      expect(existsSync(turnEndMarkerPath(proj))).toBe(false);
      const reported = step(proj, ["report", "--stage", STAGE, "--result", "awaiting-approval"]);
      const changed = relative(proj, artifact(proj)).replaceAll("\\", "/");
      expect(reported.change_notices).toEqual([
        `${changed} changed after the Requirements Analysis review; carrying on. ${OFFER}`,
      ]);
      expect(readAuditShardEvents(proj).filter((row) => row.event === "CHANGE_ACCEPTED")).toHaveLength(1);
      expect(stop(proj).stdout).not.toContain('"decision"');
      // On record now: the gate is shown again as it was.
      expect(step(proj, ["next"])).toMatchObject({ kind: "run-stage", gate_only: true });
    });
  }

  test("an open gate with nothing changed since its review is shown again as it was", async () => {
    const proj = project("off");
    openGate(proj);
    await personSays(proj, "where are we?");
    expect(step(proj, ["next"])).toMatchObject({ kind: "run-stage", gate_only: true });
  });

  test("strict: the changed work at the open gate gets what it got before, not the report step", async () => {
    const proj = project("strict");
    openGate(proj);
    await personSays(proj, "also make an empty name print hello there");
    askedChange(proj);
    const next = step(proj, ["next"]);
    expect(String(next.message ?? "")).not.toContain(`report --stage ${STAGE} --result awaiting-approval`);
    expect(next.kind).toBe("ask");
  });
});
