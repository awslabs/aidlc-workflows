// covers: function:jumpIsPersonsMove, function:lastStepAdmitsPersonsMoves, function:turnKeptSinceFinished, function:standingPersonTurn, function:selectedRecordIsFinished, hook:aidlc-plan-approval-guard
//
// Work whose last stage was Code Generation (every stage after it skipped) is
// finished there with its Current Stage still on Code Generation, so `next
// --stage` leaves a jump to the plan-approval guard's `jump execute` door, and
// the human-turn hook keeps the person's messages beside that finished record
// (#3608). A redo they ask for in this chat since the finish runs, and its plan
// is asked about once; a change they ask for in their code goes through, as
// past Code Generation. A jump nobody asked for, one another chat's message
// asked for, and one inside a line the guard cannot read still wait, under
// every Guard Policy.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTestProject, seededStateFile } from "../harness/fixtures.ts";
import {
  answer,
  auditEvents,
  cleanupWorktreeFixtures,
  copilotAdapter,
  copilotRuns,
  copilotStep,
  DEVELOPER,
  finishedAtCodeGeneration,
  namedCommands,
  next,
  reply,
  runNamed,
  SESSION,
  type Shape,
  SHAPES,
  type Step,
  writePlan,
} from "../harness/code-generation-states.ts";
import {
  activeDirectiveStorageDir,
  getField,
  resolveWorkflowSelection,
  selectedRecordIsFinished,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";

setDefaultTimeout(600_000);

const created: string[] = [];
afterEach(() => {
  while (created.length > 0) cleanupTestProject(created.pop());
  cleanupWorktreeFixtures();
});

const ASK = "Can you redo Code Generation? I'd like the code built again.";
const OTHER_CHAT = "01995000-7a11-7000-8000-0000000065b9";
const claude = SHAPES[0];
const copilot = SHAPES.find((shape) => shape.name === "copilot") as Shape;

/** Work finished at Code Generation; with `join`, this chat has taken a step on it, as the agent's `next` does. */
function finished(policy: "strict" | "relaxed" | "off", join = true): string {
  const proj = finishedAtCodeGeneration(policy, "on");
  created.push(proj);
  expect(getField(readFileSync(seededStateFile(proj), "utf-8"), "Current Stage")).toBe("code-generation");
  if (join) {
    const joined = runNamed(proj, "bun .claude/tools/aidlc-orchestrate.ts next", { AIDLC_SESSION_OVERRIDE: SESSION });
    expect(joined.status, joined.stdout + joined.stderr).toBe(0);
  }
  return proj;
}

/** The jump `next --stage <stage>` names on this work, as the agent reads it. */
function jumpFor(proj: string, stage: string): string {
  const step = next(proj, ["--stage", stage]);
  const jump = namedCommands(String(step.message ?? "")).find((command) => command.includes("aidlc-jump.ts execute"));
  expect(jump, JSON.stringify(step)).toBeDefined();
  return jump as string;
}

const blocked = (proj: string) => auditEvents(proj).filter((row) => row.event === "PLAN_APPROVAL_BLOCKED").length;

/** The step `next` gives after the redo, the plan written again where the stage asks for it. */
function afterRedo(proj: string): Step {
  let step = next(proj);
  if (step.kind === "run-stage" && step.stage === "code-generation" && step.plan_approval?.status !== "approved") {
    writePlan(proj);
    step = next(proj);
  }
  return step;
}

describe("a redo of Code Generation the person asks for after their work finished there", () => {
  test("every harness shape: refused before they ask, admitted once they have", async () => {
    const proj = finished("relaxed");
    const jump = jumpFor(proj, "code-generation");
    expect(jump).toContain("--direction redo");
    const before: string[] = [];
    for (const shape of SHAPES) {
      shape.install(proj);
      const verdict = await shape.call(proj, SESSION, { tool: "Bash", command: jump });
      if (verdict.code === 0) before.push(shape.name);
    }
    expect(before, "a redo nobody asked for was admitted").toEqual([]);
    expect(reply(proj, ASK).status).toBe(0);
    const refused: string[] = [];
    for (const shape of SHAPES) {
      shape.install(proj);
      const verdict = await shape.call(proj, SESSION, { tool: "Bash", command: jump });
      if (verdict.code !== 0) refused.push(`[${shape.name}] ${verdict.said}`);
    }
    expect(refused).toEqual([]);
  });

  test.each(["strict", "relaxed", "off"] as const)(
    "%s, plan approval on: the redo runs, its plan is asked about once, and the approval builds",
    async (policy) => {
      const proj = finished(policy);
      expect(reply(proj, ASK).status).toBe(0);
      const jump = jumpFor(proj, "code-generation");
      const verdict = await claude.call(proj, SESSION, { tool: "Bash", command: jump });
      expect(verdict.code, verdict.said).toBe(0);
      const ran = runNamed(proj, jump);
      expect(ran.status, ran.stdout + ran.stderr).toBe(0);
      const asked = afterRedo(proj);
      expect(asked.kind, JSON.stringify(asked)).toBe("ask");
      expect(asked.ask_type).toBe("plan-approval");
      // The redone plan waits for them: the build does not start before their answer.
      const early = await claude.call(proj, SESSION, { tool: "Write", path: join(proj, "src", "slugify.ts") });
      expect(early.code, "the build's write ran before the redone plan was approved").toBe(2);
      const earlyBrief = runNamed(proj, "bun .claude/tools/aidlc-testing-posture.ts brief --stage-level");
      const earlyDispatch = await claude.call(proj, SESSION, { tool: "Task", agent: DEVELOPER, prompt: earlyBrief.stdout });
      expect(earlyDispatch.code, "the developer started before the redone plan was approved").toBe(2);
      // The question stays the one step; the scope-run test counts it asked once.
      expect(next(proj).ask_type).toBe("plan-approval");
      const recordedBefore = auditEvents(proj).filter((row) => row.event === "PLAN_APPROVAL_RECORDED").length;
      expect(reply(proj, "Approve Plan").status).toBe(0);
      const recorded = answer(proj, "Approve Plan");
      expect(recorded.status, recorded.stdout + recorded.stderr).toBe(0);
      const build = next(proj);
      expect(build.kind, JSON.stringify(build)).toBe("run-stage");
      expect(build.plan_approval?.status, JSON.stringify(build)).toBe("approved");
      expect(auditEvents(proj).filter((row) => row.event === "PLAN_APPROVAL_RECORDED").length).toBe(recordedBefore + 1);
      const write = await claude.call(proj, SESSION, { tool: "Write", path: join(proj, "src", "slugify.ts") });
      expect(write.code, write.said).toBe(0);
      const brief = runNamed(proj, "bun .claude/tools/aidlc-testing-posture.ts brief --stage-level");
      expect(brief.status, brief.stdout + brief.stderr).toBe(0);
      const dispatch = await claude.call(proj, SESSION, { tool: "Task", agent: DEVELOPER, prompt: brief.stdout });
      expect(dispatch.code, dispatch.said).toBe(0);
      expect(next(proj).ask_type).not.toBe("plan-approval");
    },
  );

  test("the re-entry route first, as on Claude Code: the redo it names runs", async () => {
    const proj = finished("off");
    expect(reply(proj, ASK).status).toBe(0);
    const resumed = runNamed(proj, "bun .claude/tools/aidlc.ts engine orchestrate report --result resumed --choice redo --target code-generation");
    expect(resumed.status, resumed.stdout + resumed.stderr).toBe(0);
    const jump = namedCommands(String((JSON.parse(resumed.stdout) as Step).message ?? ""))
      .find((command) => command.includes("aidlc-jump.ts execute"));
    expect(jump, resumed.stdout).toBeDefined();
    const verdict = await claude.call(proj, SESSION, { tool: "Bash", command: jump as string });
    expect(verdict.code, verdict.said).toBe(0);
    expect(runNamed(proj, jump as string).status).toBe(0);
    expect(afterRedo(proj).ask_type).toBe("plan-approval");
  });

  test("a jump back the person asks for from the same finished work runs too", async () => {
    const proj = finished("relaxed");
    expect(reply(proj, "Go back to Requirements Analysis, slugify should cap the slug at 60 characters.").status).toBe(0);
    const jump = jumpFor(proj, "requirements-analysis");
    const verdict = await claude.call(proj, SESSION, { tool: "Bash", command: jump });
    expect(verdict.code, verdict.said).toBe(0);
    expect(runNamed(proj, jump).status).toBe(0);
    expect(next(proj).stage).toBe("requirements-analysis");
  });

  test.each(["strict", "relaxed", "off"] as const)(
    "%s: still refused with no message of theirs since the finish, or with another chat's; this chat's own runs",
    async (policy) => {
      const proj = finished(policy);
      const jump = jumpFor(proj, "code-generation");
      // The message that gave the finishing approval is on the record: it backed that decision.
      const own = await claude.call(proj, SESSION, { tool: "Bash", command: jump });
      expect(own.code, "the agent's own redo was admitted").toBe(2);
      expect(reply(proj, ASK, OTHER_CHAT).status).toBe(0);
      const other = await claude.call(proj, SESSION, { tool: "Bash", command: jump });
      expect(other.code, "another chat's message stood for this chat's redo").toBe(2);
      expect(getField(readFileSync(seededStateFile(proj), "utf-8"), "Status")).toBe("Completed");
      expect(reply(proj, ASK).status).toBe(0);
      const mine = await claude.call(proj, SESSION, { tool: "Bash", command: jump });
      expect(mine.code, mine.said).toBe(0);
    },
  );

  // A new chat: the person's words reach the message record before the
  // agent's first `next` joins the chat to the work, as in the live runs.
  test("a new chat: the person asks before the chat's first step, and the redo runs", async () => {
    const proj = finished("relaxed", false);
    expect(reply(proj, ASK).status).toBe(0);
    const joined = runNamed(proj, "bun .claude/tools/aidlc-orchestrate.ts next", { AIDLC_SESSION_OVERRIDE: SESSION });
    expect(joined.status, joined.stdout + joined.stderr).toBe(0);
    const verdict = await claude.call(proj, SESSION, { tool: "Bash", command: jumpFor(proj, "code-generation") });
    expect(verdict.code, verdict.said).toBe(0);
  });

  // The finish is the last step: an issued Code Generation step it outlived,
  // even one marked superseded since, holds nothing back.
  test("an issued step superseded after the finish: the person's redo is admitted on the first ask", async () => {
    const proj = finished("relaxed");
    expect(reply(proj, ASK).status).toBe(0);
    const jump = jumpFor(proj, "code-generation");
    // The step on record once the jump is printed, superseded after the print.
    const markerFile = join(activeDirectiveStorageDir(proj), "active-directive.json");
    const marker = JSON.parse(readFileSync(markerFile, "utf-8")) as Record<string, unknown>;
    expect(marker.stage).toBe("code-generation");
    writeFileSync(markerFile, `${JSON.stringify({ ...marker, delivery: "superseded", needs_rehydrate: true })}\n`, "utf-8");
    const verdict = await claude.call(proj, SESSION, { tool: "Bash", command: jump });
    expect(verdict.code, verdict.said).toBe(0);
  });

  // Copilot's adapter settles the step after every engine command; the finish
  // leaves nothing for its settled-claim exception to read.
  test("Copilot, through its adapter: refused before they ask; the printed redo and an unprinted jump run once they have", () => {
    const proj = finished("off");
    copilot.install(proj);
    const unprinted = "bun .aidlc/tools/aidlc-jump.ts execute --target requirements-analysis --direction backward --scope poc";
    expect(copilotRuns(proj, unprinted).refused, "a jump nobody asked for ran on Copilot").not.toBeNull();
    const said = copilotAdapter(proj, "record-human-turn", {
      hook_event_name: "UserPromptSubmit", prompt: ASK, timestamp: new Date().toISOString(),
    });
    expect(said.code, said.stderr).toBe(0);
    const step = copilotStep(proj, "next --stage code-generation");
    const jump = namedCommands(String(step.message ?? "")).find((command) => command.includes("aidlc-jump.ts execute"));
    expect(jump, JSON.stringify(step)).toBeDefined();
    const ran = copilotRuns(proj, jump as string);
    expect(ran.refused).toBeNull();
    expect(copilotStep(proj, "next").ask_type).toBe("plan-approval");
  });

  test("Copilot, through its adapter: an unprinted jump they asked for runs", () => {
    const proj = finished("off");
    copilot.install(proj);
    const said = copilotAdapter(proj, "record-human-turn", {
      hook_event_name: "UserPromptSubmit", prompt: "Go back to Requirements Analysis, please.", timestamp: new Date().toISOString(),
    });
    expect(said.code, said.stderr).toBe(0);
    const ran = copilotRuns(proj, "bun .aidlc/tools/aidlc-jump.ts execute --target requirements-analysis --direction backward --scope poc");
    expect(ran.refused).toBeNull();
  });

  // The command-line floor: with no hook running, nothing judges the jump and
  // nothing keeps a message, as on main; `next` still asks about the plan.
  test("hooks off: the redo runs and its plan is asked about", () => {
    const proj = finished("off");
    const jump = jumpFor(proj, "code-generation");
    const ran = runNamed(proj, jump);
    expect(ran.status, ran.stdout + ran.stderr).toBe(0);
    expect(afterRedo(proj).ask_type).toBe("plan-approval");
  });
});

// The same finished work is past Code Generation, though Current Stage stays
// on it: nothing is built and no plan waits, so a change the person asks for
// afterwards (a file edit, a shell command, the developer) goes through the
// guard as it does once a walk is past Code Generation, under every Guard
// Policy. Before, each was refused with a `next` that said the work was
// finished. A jump stays at the door above.
describe("a change the person asks for after their work finished at Code Generation", () => {
  const TYPO = "Fix the typo in src/slugify.ts, please.";

  test("every harness shape: their file edit is admitted", async () => {
    const proj = finished("relaxed");
    expect(reply(proj, TYPO).status).toBe(0);
    const refused: string[] = [];
    for (const shape of SHAPES) {
      shape.install(proj);
      for (const call of [
        { tool: "Write" as const, path: join(proj, "src", "slugify.ts") },
        { tool: "Edit" as const, path: join(proj, "src", "slugify.ts") },
      ]) {
        const verdict = await shape.call(proj, SESSION, call);
        if (verdict.code !== 0) refused.push(`[${shape.name}] ${call.tool}: ${verdict.said}`);
      }
    }
    expect(refused).toEqual([]);
  });

  // AI-DLC's own commands this guard holds keep their own conditions: a jump
  // the guard cannot read is refused whoever asked.
  test.each(["strict", "relaxed", "off"] as const)("%s: a jump the guard cannot read still waits", async (policy) => {
    const proj = finished(policy);
    const jump = jumpFor(proj, "code-generation");
    const commands = [
      `eval "${jump}"`,
      // The spelling a native install prints, handed to a shell.
      `sh -c "${jump.replace(/^bun \.claude\/tools\/aidlc-jump\.ts /, "aidlc engine jump ")}"`,
    ];
    for (const command of commands) {
      expect((await claude.call(proj, SESSION, { tool: "Bash", command })).code, `${command} passed`).toBe(2);
    }
    expect(reply(proj, ASK).status).toBe(0);
    for (const command of commands) {
      expect((await claude.call(proj, SESSION, { tool: "Bash", command })).code, `${command} passed after the ask`).toBe(2);
    }
  });

  // A Code Generation run on its own opened over the finished work is live
  // work: the pass above reads it as not finished, so its build is judged as
  // that run's, as it was.
  test("an isolated Code Generation run opened on the finished work is not read as finished", () => {
    const proj = finished("relaxed");
    expect(selectedRecordIsFinished(proj, resolveWorkflowSelection(proj))).toBe(true);
    expect(reply(proj, "/aidlc --stage code-generation --single").status).toBe(0);
    const single = next(proj, ["--stage", "code-generation", "--single"]);
    expect(single.single, JSON.stringify(single)).toBe(true);
    expect(selectedRecordIsFinished(proj, resolveWorkflowSelection(proj))).toBe(false);
  });

  test.each(["strict", "relaxed", "off"] as const)(
    "%s: the agent's own redo still waits; their edit, a shell command that writes and the developer run; next stays done",
    async (policy) => {
      const proj = finished(policy);
      const own = await claude.call(proj, SESSION, { tool: "Bash", command: jumpFor(proj, "code-generation") });
      expect(own.code, "the agent's own redo was admitted").toBe(2);
      expect(reply(proj, TYPO).status).toBe(0);
      const before = blocked(proj);
      const write = await claude.call(proj, SESSION, { tool: "Write", path: join(proj, "src", "slugify.ts") });
      expect(write.code, write.said).toBe(0);
      const shell = await claude.call(proj, SESSION, { tool: "Bash", command: "cp src/base.ts src/base-copy.ts" });
      expect(shell.code, shell.said).toBe(0);
      const dispatch = await claude.call(proj, SESSION, { tool: "Task", agent: DEVELOPER, prompt: "Fix the typo in src/slugify.ts." });
      expect(dispatch.code, dispatch.said).toBe(0);
      expect(blocked(proj)).toBe(before);
      expect(next(proj).kind).toBe("done");
    },
  );
});
