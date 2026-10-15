// covers: function:evaluate, function:mutationIntent, function:isStageRecordOutput, function:isTrustedToolFile
//
// The no-dead-end sweep for Code Generation. In every state a person can be in
// at this stage, and for every harness's shape of a tool call, the real engine,
// the real human-turn hook and the real plan-approval guard are asked:
//
//   (a) the person's own message is recorded and never refused;
//   (b) `next` hands the agent a step;
//   (c) that step's own work is admitted by the guard;
//   (d) every refusal the guard gives names a way past the guard itself admits
//       in that same state, and the same refusal does not come back after its
//       step (a deadlock);
//   (e) before the approval the developer dispatch and a source write are
//       refused with that way past; after it both are admitted;
//   (f) a call to one of the person's MCP servers runs, whatever the state.
//
// The states and the seven shapes live in tests/harness/code-generation-states.ts.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import { cleanupTestProject } from "../harness/fixtures.ts";
import { refusalSignature } from "../harness/scope-run.ts";
import {
  answer,
  auditEvents,
  type BuiltState,
  cleanupWorktreeFixtures,
  DEVELOPER,
  latestHumanTurnWords,
  namedCommands,
  next,
  reply,
  respell,
  runNamed,
  SESSION,
  shellWords,
  type Shape,
  SHAPES,
  stageDir,
  STATES,
  type Step,
  type ToolCall,
  type Verdict,
  writePlan,
} from "../harness/code-generation-states.ts";

setDefaultTimeout(600_000);

const created: string[] = [];
afterEach(() => {
  while (created.length > 0) cleanupTestProject(created.pop());
  cleanupWorktreeFixtures();
});

/** The brief the agent hands the developer, as the engine prints it (or a stand-in before any plan exists). */
function developerBrief(proj: string): string {
  const brief = runNamed(proj, "bun .claude/tools/aidlc-testing-posture.ts brief --stage-level");
  return brief.status === 0 && brief.stdout.trim().length > 0
    ? brief.stdout
    : `AIDLC-STAGE: code-generation\nAIDLC-TESTING-CONTRACT: sha256:${"a".repeat(64)}\n`;
}

function stepWork(proj: string, step: Step): ToolCall[] {
  const calls: ToolCall[] = [];
  const planFile = join(stageDir(proj), "code-generation-plan.md");
  const instructions = join(stageDir(proj), "unit-test-instructions.md");
  switch (step.kind) {
    case "run-stage": {
      const status = step.plan_approval?.status;
      if (status === "approved") {
        calls.push({ tool: "Bash", command: "bun .claude/tools/aidlc-testing-posture.ts brief --stage-level" });
        calls.push({ tool: "Task", agent: DEVELOPER, prompt: developerBrief(proj) });
        calls.push({ tool: "Write", path: join(proj, "src", "slugify.ts") });
      } else {
        calls.push({ tool: "Bash", command: "bun .claude/tools/aidlc-testing-posture.ts render" });
        calls.push({ tool: "Write", path: planFile });
        calls.push({ tool: "Write", path: instructions });
      }
      break;
    }
    case "ask":
      calls.push({ tool: "Bash", command: "bun .claude/tools/aidlc-orchestrate.ts next" });
      for (const remedy of step.remedies ?? []) {
        if (remedy.interaction === "command" && remedy.command) calls.push({ tool: "Bash", command: remedy.command });
      }
      break;
    case "invoke-swarm":
      for (const unit of step.units ?? []) {
        calls.push({ tool: "Write", path: join(stageDir(proj, unit), "code-generation-plan.md") });
      }
      break;
    default:
      // load-steering and print name their commands in their text, read below.
      break;
  }
  // Every engine command the step names, in any of its fields. A template the
  // agent fills in (`--details '<the option label>'`) is not a command yet.
  for (const command of stepCommands(step)) calls.push({ tool: "Bash", command });
  return calls;
}

/** The engine commands a step's string fields name, templates with `<...>` placeholders left out. */
function stepCommands(value: unknown, found: string[] = []): string[] {
  if (typeof value === "string") {
    for (const command of namedCommands(value)) {
      if (command.startsWith("bun ") && !/[<>]/.test(command) && !found.includes(command)) found.push(command);
    }
  } else if (Array.isArray(value)) {
    for (const item of value) stepCommands(item, found);
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) stepCommands(item, found);
  }
  return found;
}

function describeCall(call: ToolCall): string {
  switch (call.tool) {
    case "Bash": return `Bash ${call.command}`;
    case "Task": return `Task ${call.agent}`;
    default: return `${call.tool} ${call.path}`;
  }
}

/**
 * The way past a refusal: every engine command it names is admitted by the same
 * shape's guard. For the step's own work (`ownWork`), the named `next` is then
 * really run and the work tried again: the same refusal coming back is a
 * deadlock. A door refused before the approval is meant to stay refused until
 * the person approves, so it gets no retry.
 */
async function wayPastIsAdmitted(
  state: BuiltState, shape: Shape, call: ToolCall, verdict: Verdict, problems: string[], ownWork: boolean,
): Promise<void> {
  const named = namedCommands(verdict.said).filter((command) => command.startsWith("bun ") && !/[<>]/.test(command));
  const where = `[${shape.name}] ${describeCall(call)}`;
  if (named.length === 0) {
    // The one refusal that names no command is the open plan question: the way
    // past is the person's answer, which the hook keeps, and `next` after it.
    const waits = /plan waits for your approval|has answered the plan question|editing the plan files/.test(verdict.said);
    if (!waits) problems.push(`${where}: refused with no way past named: ${verdict.said}`);
    const nextStep = await shape.call(state.proj, state.session, { tool: "Bash", command: "bun .claude/tools/aidlc-orchestrate.ts next" });
    if (nextStep.code !== 0) problems.push(`${where}: after the refusal, next itself is refused: ${nextStep.said}`);
    return;
  }
  for (const command of named) {
    // The refusal spells the command for the shape's own tree; the harness runs it on the Claude tree.
    const claudeSpelling = respell(command, ".claude");
    const again = await shape.call(state.proj, state.session, { tool: "Bash", command: claudeSpelling });
    if (again.code !== 0) {
      problems.push(`${where}: the way past it names is refused too: ${command} -> ${again.said}`);
      continue;
    }
    if (!ownWork || !/aidlc-orchestrate\.ts next\b|aidlc\.ts engine orchestrate next\b/.test(claudeSpelling)) continue;
    // Deadlock: the named step taken for real, the same refusal comes back.
    const ran = runNamed(state.proj, claudeSpelling);
    if (ran.status !== 0) {
      problems.push(`${where}: the way past it names fails when run: ${command} -> ${(ran.stdout + ran.stderr).trim().slice(0, 300)}`);
      continue;
    }
    const retry = await shape.call(state.proj, state.session, call);
    if (retry.code === 2 && refusalSignature(retry.said) === refusalSignature(verdict.said)) {
      problems.push(`${where}: DEADLOCK: after ${command} the same refusal returns: ${retry.said}`);
    }
  }
}

describe("the Code Generation no-dead-end sweep", () => {
  for (const builder of STATES) {
    test(`${builder.id}: ${builder.name}`, async () => {
      const state = builder.build();
      created.push(state.proj);
      const problems: string[] = [];
      const report: string[] = [`${builder.id} ${builder.name}: ${state.how}`];

      // (a) the person's own message is recorded and never refused.
      const said = reply(state.proj, "where are we?", state.session);
      expect(said.status, said.stderr).toBe(0);
      const kept = latestHumanTurnWords(state.proj);
      expect(kept ?? "", "the hook kept no words").toContain("where are we?");

      // (b) next hands the agent a step.
      let step: Step | null = null;
      try {
        step = next(state.proj);
      } catch (error) {
        problems.push(`next gave no step: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (step) {
        expect(["run-stage", "ask", "print", "invoke-swarm", "load-steering", "done"], JSON.stringify(step)).toContain(step.kind);
        report.push(`next: ${step.kind}${step.ask_type ? ` ${step.ask_type}` : ""}${step.plan_approval?.status ? ` plan ${step.plan_approval.status}` : ""}`);
      }

      for (const shape of SHAPES) {
        shape.install(state.proj);
        // (c) the step's own work is admitted.
        for (const call of step ? stepWork(state.proj, step) : []) {
          const verdict = await shape.call(state.proj, state.session, call);
          if (verdict.code === 0) continue;
          problems.push(`[${shape.name}] the step's own work is refused: ${describeCall(call)} -> ${verdict.said}`);
          await wayPastIsAdmitted(state, shape, call, verdict, problems, true);
        }
        // (e) the developer dispatch and a source write, before and after approval.
        const doors: ToolCall[] = [
          { tool: "Task", agent: DEVELOPER, prompt: developerBrief(state.proj) },
          { tool: "Write", path: join(state.proj, "src", "slugify.ts") },
          { tool: "Bash", command: "echo built > src/slugify.ts" },
        ];
        for (const door of doors) {
          const verdict = await shape.call(state.proj, state.session, door);
          if (state.approved) {
            if (verdict.code !== 0) problems.push(`[${shape.name}] approved, yet refused: ${describeCall(door)} -> ${verdict.said}`);
          } else {
            if (verdict.code !== 2) problems.push(`[${shape.name}] not approved, yet admitted: ${describeCall(door)}`);
            else await wayPastIsAdmitted(state, shape, door, verdict, problems, false);
          }
        }
        report.push(`[${shape.name}] checked`);
      }

      const summary = `${report.join("\n")}\n${problems.length ? `PROBLEMS:\n${problems.join("\n")}` : "no dead end"}`;
      // The sweep's report, kept beside the project while it runs (the runner's
      // per-test log keeps the thrown text).
      expect(problems, summary).toEqual([]);
    });
  }
});

// The person's lookup while the plan is written ran into a refusal on Kiro IDE;
// on every harness and in every state an MCP call they ask for is theirs to make,
// and the host's own card asks them.
describe("a call to one of the person's MCP servers runs in every Code Generation state", () => {
  for (const builder of STATES) {
    test(`${builder.id}: ${builder.name}`, async () => {
      const state = builder.build();
      created.push(state.proj);
      // The person asks for the lookup, as on Kiro IDE: "quick one while you write the plan".
      expect(reply(state.proj, "quick one: use the everything MCP server to echo this back", state.session).status).toBe(0);
      const refused: string[] = [];
      for (const shape of SHAPES) {
        shape.install(state.proj);
        const verdict = await shape.mcp(state.proj, state.session);
        if (verdict.code !== 0) refused.push(`[${shape.name}] ${verdict.said}`);
      }
      expect(refused).toEqual([]);
    });
  }
});

// What the guard judges and what it leaves alone, pinned in the Claude shape at
// the planning step (S1), the open question (S3) and the open gate (S11a):
// AI-DLC's records and AI-DLC's own commands pass; the doors, the engine's own
// files and the unasked bypass still wait.
describe("the guard judges only the build: records and engine commands pass, the doors wait", () => {
  const claude = SHAPES[0];
  for (const id of ["S1", "S3"]) {
    test(`${id}: a record write and an engine command for another stage pass; code, the developer and unseen writes wait`, async () => {
      const state = STATES.find((builder) => builder.id === id)!.build();
      created.push(state.proj);
      const recordDir = join(stageDir(state.proj), "..", "..");
      const passes: ToolCall[] = [
        { tool: "Write", path: join(recordDir, "inception", "requirements-analysis", "requirements.md") },
        { tool: "Write", path: join(recordDir, "verification", "inception-construction-verification.md") },
        { tool: "Write", path: join(recordDir, "construction", "code-generation", "memory.md") },
        { tool: "Bash", command: "bun .claude/tools/aidlc.ts engine log answer --stage requirements-analysis --message 0badc0de --details 'Chat'" },
        { tool: "Bash", command: "bun .claude/tools/aidlc.ts engine sensors findings --stage code-generation" },
        { tool: "Bash", command: "bun .claude/tools/aidlc-utility.ts status" },
      ];
      for (const call of passes) {
        const verdict = await claude.call(state.proj, state.session, call);
        expect(verdict.code, `${describeCall(call)} -> ${verdict.said}`).toBe(0);
      }
      // A command whose writes cannot be seen waits at the planning step; at the
      // open question it is the person's own side work (a test run, an install)
      // and runs.
      const unseen: ToolCall[] = id === "S1"
        ? [{ tool: "Bash", command: "bash build.sh" }, { tool: "Bash", command: "bun -e 'console.log(1)'" }]
        : [];
      const waits: ToolCall[] = [
        { tool: "Write", path: join(state.proj, "src", "slugify.ts") },
        { tool: "Task", agent: DEVELOPER, prompt: developerBrief(state.proj) },
        ...unseen,
        { tool: "Bash", command: "echo built > src/slugify.ts" },
        { tool: "Write", path: join(state.proj, "aidlc", ".aidlc-sessions", "plan-approval", "receipt-x.json") },
        { tool: "Write", path: join(recordDir, ".aidlc-engine", "x.json") },
        { tool: "Write", path: join(recordDir, "audit", "x.md") },
        { tool: "Write", path: join(recordDir, "aidlc-state.md") },
      ];
      for (const call of waits) {
        const verdict = await claude.call(state.proj, state.session, call);
        expect(verdict.code, `${describeCall(call)} was admitted`).toBe(2);
      }
    });
  }

  test("S11a: at the open gate a record edit passes; the build waits for the next it names, which is admitted", async () => {
    const state = STATES.find((builder) => builder.id === "S11a")!.build();
    created.push(state.proj);
    const edit = await claude.call(state.proj, state.session, {
      tool: "Edit", path: join(stageDir(state.proj), "traceability.json"),
    });
    expect(edit.code, edit.said).toBe(0);
    const doors: ToolCall[] = [
      { tool: "Write", path: join(state.proj, "src", "slugify.ts") },
      { tool: "Task", agent: DEVELOPER, prompt: developerBrief(state.proj) },
    ];
    for (const door of doors) {
      const verdict = await claude.call(state.proj, state.session, door);
      expect(verdict.code, `${describeCall(door)} was admitted at the open gate`).toBe(2);
      const named = namedCommands(verdict.said).filter((command) => command.startsWith("bun ") && !/[<>]/.test(command));
      expect(named.length, `${describeCall(door)} refused with no way past: ${verdict.said}`).toBeGreaterThan(0);
      for (const command of named) {
        const way = await claude.call(state.proj, state.session, { tool: "Bash", command: respell(command, ".claude") });
        expect(way.code, `${command} -> ${way.said}`).toBe(0);
      }
    }
  });

  test("the recorded bypass switch waits for a person to have asked, then passes", async () => {
    // S3: the question is open and no person has spoken yet (an approval turn
    // counts as a person's turn for this switch).
    const state = STATES.find((builder) => builder.id === "S3")!.build();
    created.push(state.proj);
    const bypass = "bun .claude/tools/aidlc.ts config flags --bypass AIDLC_DISABLE_PLAN_APPROVAL_GUARD --local --yes";
    const unasked = await claude.call(state.proj, state.session, { tool: "Bash", command: bypass });
    expect(unasked.code, "the bypass passed with nobody asking").toBe(2);
    expect(reply(state.proj, "turn the plan approval check off for this project").status).toBe(0);
    const asked = await claude.call(state.proj, state.session, { tool: "Bash", command: bypass });
    expect(asked.code, asked.said).toBe(0);
    // Turning a check back on never waits.
    const clear = await claude.call(state.proj, state.session, {
      tool: "Bash", command: "bun .claude/tools/aidlc.ts config flags --clear-bypass AIDLC_DISABLE_PLAN_APPROVAL_GUARD --local --yes",
    });
    expect(clear.code, clear.said).toBe(0);
  });

  test("a release update the person asked for passes in one step in every shape, and the plan question stays", async () => {
    for (const id of ["S2", "S3"]) {
      const state = STATES.find((builder) => builder.id === id)!.build();
      created.push(state.proj);
      // The plain update and the refresh doctor names for a tree that is behind.
      const commands = [
        "bun .claude/tools/aidlc.ts config --download --yes",
        `bun .claude/tools/aidlc.ts config --harness claude --download --project-dir ${state.proj}`,
      ];
      const verdicts = async (expected: number, why: string) => {
        for (const shape of SHAPES) {
          shape.install(state.proj);
          for (const command of commands) {
            const verdict = await shape.call(state.proj, state.session, { tool: "Bash", command });
            expect(verdict.code, `[${id} ${shape.name}] ${why}: ${command}\n${verdict.said}`).toBe(expected);
          }
        }
      };
      await verdicts(2, "passed with nobody asking");
      expect(reply(state.proj, "update AI-DLC").status).toBe(0);
      expect(latestHumanTurnWords(state.proj)).toBe("update AI-DLC");
      await verdicts(0, "refused after the person asked");
      const step = next(state.proj);
      expect(step.kind, JSON.stringify(step)).toBe("ask");
      expect(step.ask_type, JSON.stringify(step)).toBe("plan-approval");
    }
  });

  test("after the person's approve the same turn still counts: an update passes with no new turn, as the four settings do", async () => {
    // personAskedSinceGate: an approval does not use the person's turn up, so
    // "approve and update AI-DLC" in one message is never refused.
    const state = STATES.find((builder) => builder.id === "S3")!.build();
    created.push(state.proj);
    const update = "bun .claude/tools/aidlc.ts config --download --yes";
    const setting = "bun .claude/tools/aidlc.ts config flags --sensor-timeout-ms 5 --local --yes";
    for (const command of [update, setting]) {
      const unasked = await claude.call(state.proj, state.session, { tool: "Bash", command });
      expect(unasked.code, `passed with nobody asking: ${command}`).toBe(2);
    }
    expect(reply(state.proj, "approve").status).toBe(0);
    const recorded = answer(state.proj, "Approve Plan");
    expect(recorded.status, recorded.stdout + recorded.stderr).toBe(0);
    for (const command of [update, setting]) {
      const asked = await claude.call(state.proj, state.session, { tool: "Bash", command });
      expect(asked.code, `${command}\n${asked.said}`).toBe(0);
    }
  });

  test("S6b: the person hands the plan back while editing: every shape's refusal names the answer, and three calls later the plan is the agent's", async () => {
    const state = STATES.find((builder) => builder.id === "S6b")!.build();
    created.push(state.proj);
    const planPath = join(stageDir(state.proj), "code-generation-plan.md");
    for (const shape of SHAPES) {
      shape.install(state.proj);
      const refused = await shape.call(state.proj, state.session, { tool: "Write", path: planPath });
      expect(refused.code, `[${shape.name}] the plan file passed while the person's edit mode is open`).toBe(2);
      const handBack = namedCommands(refused.said).find((command) => command.includes('--details "Request Changes"'));
      expect(handBack, `[${shape.name}] the refusal names no answer: ${refused.said}`).toBeDefined();
      const admitted = await shape.call(state.proj, state.session, { tool: "Bash", command: respell(handBack as string, ".claude") });
      expect(admitted.code, `[${shape.name}] ${handBack} -> ${admitted.said}`).toBe(0);
    }
    // The answer, the write, next: the plan is the agent's, with their words, and no second edit-mode question.
    const recorded = runNamed(state.proj, 'bun .claude/tools/aidlc-log.ts answer --stage code-generation --checkpoint plan-approval --details "Request Changes"');
    expect(recorded.status, recorded.stdout + recorded.stderr).toBe(0);
    const write = await claude.call(state.proj, state.session, { tool: "Write", path: planPath });
    expect(write.code, write.said).toBe(0);
    const step = next(state.proj);
    expect(step.kind, JSON.stringify(step)).toBe("run-stage");
    expect(step.plan_approval, JSON.stringify(step)).toEqual({ status: "revise", feedback: "you finish it" });
  });

  test("S6: while the person edits the plan files, the agent's write to them is refused with that sentence", async () => {
    const state = STATES.find((builder) => builder.id === "S6")!.build();
    created.push(state.proj);
    const plan = await claude.call(state.proj, state.session, { tool: "Write", path: join(stageDir(state.proj), "code-generation-plan.md") });
    expect(plan.code, "the plan file was admitted while the person edits it").toBe(2);
    expect(plan.said).toContain("The person is editing the plan files themselves");
    // Another record of the same work is not theirs to edit: it passes.
    const notes = await claude.call(state.proj, state.session, {
      tool: "Write", path: join(stageDir(state.proj), "..", "..", "inception", "requirements-analysis", "notes.md"),
    });
    expect(notes.code, notes.said).toBe(0);
  });
});

describe("the six plan-answer cases from the hook's gate, at the open question", () => {
  const cases: Array<{ words: string; followUp?: string; builds: boolean }> = [
    { words: "approve", builds: true },
    { words: "1", builds: true },
    { words: "looks good, go ahead", builds: true },
    { words: "2", followUp: "approve", builds: true },
    { words: "/aidlc --plan-approval off", builds: true },
    { words: "/aidlc --review none", followUp: "approve", builds: true },
  ];
  for (const { words, followUp, builds } of cases) {
    test(`"${words}"${followUp ? ` then "${followUp}"` : ""}`, async () => {
      const state = STATES.find((builder) => builder.id === "S3")!.build();
      created.push(state.proj);
      const first = reply(state.proj, words);
      expect(first.status, first.stderr).toBe(0);
      expect(latestHumanTurnWords(state.proj) ?? "").toContain(words);
      // An /aidlc line's flags are the agent's reading, handed to next; a step
      // it prints is carried out: each command it names passes the guard, runs,
      // and next follows.
      let step = words.startsWith("/aidlc ") ? next(state.proj, shellWords(words.slice("/aidlc ".length))) : next(state.proj);
      if (step.kind === "print") {
        for (const command of stepCommands(step)) {
          const admitted = await SHAPES[0].call(state.proj, SESSION, { tool: "Bash", command });
          expect(admitted.code, `${command}\n${admitted.said}`).toBe(0);
          const ran = runNamed(state.proj, command);
          expect(ran.status, `${command}\n${ran.stdout}${ran.stderr}`).toBe(0);
        }
        step = next(state.proj);
      }
      if (followUp) {
        // A setting or a Request Changes first: the engine's step is followed
        // (the setter it names is run; a Request Changes is recorded), then the
        // approval is given.
        for (const command of stepCommands(step)) {
          const ran = runNamed(state.proj, command);
          expect(ran.status, `${command}\n${ran.stdout}${ran.stderr}`).toBe(0);
        }
        if (words === "2") {
          // The hook records the exact pick itself; were it still open, the
          // agent's record would. The engine then asks for the revision, the
          // plan is revised, and the question is asked again.
          if (step.kind === "ask" && step.ask_type === "plan-approval") {
            const changes = answer(state.proj, "Request Changes");
            expect(changes.status, changes.stdout + changes.stderr).toBe(0);
            step = next(state.proj);
          }
          expect(step.plan_approval?.status, JSON.stringify(step)).toBe("revise");
          writePlan(state.proj, "- [ ] Step 2: revised\n");
          step = next(state.proj);
          expect(step.kind, JSON.stringify(step)).toBe("ask");
        }
        const second = reply(state.proj, followUp);
        expect(second.status, second.stderr).toBe(0);
        step = next(state.proj);
      }
      // An exact pick the hook records itself; words need the agent's record.
      if (step.kind === "ask" && step.ask_type === "plan-approval") {
        const recorded = answer(state.proj, "Approve Plan");
        expect(recorded.status, recorded.stdout + recorded.stderr).toBe(0);
        step = next(state.proj);
      }
      expect(step.kind, JSON.stringify(step)).toBe("run-stage");
      expect(step.plan_approval?.status, JSON.stringify(step)).toBe("approved");
      expect(builds).toBe(true);
      const claude = SHAPES[0];
      const dispatch = await claude.call(state.proj, SESSION, { tool: "Task", agent: DEVELOPER, prompt: developerBrief(state.proj) });
      expect(dispatch.code, dispatch.said).toBe(0);
      const write = await claude.call(state.proj, SESSION, { tool: "Write", path: join(state.proj, "src", "slugify.ts") });
      expect(write.code, write.said).toBe(0);
      expect(auditEvents(state.proj).some((row) =>
        row.event === "PLAN_APPROVAL_RECORDED" || row.event === "PLAN_APPROVAL_SKIPPED")).toBe(true);
    });
  }
});
