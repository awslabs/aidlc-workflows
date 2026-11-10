// covers: subcommand:aidlc-orchestrate:next, function:activeWorkLabel, function:reentryReplyDirective,
// function:planNamedBesideWorkStep, function:routedGuardPolicyNote
//
// Over work made from a long request, another /aidlc request stopped the chat with "AI-DLC could not send its next
// step" (#3750). Live on Codex 0.167.0 and opencode 1.19.5: the first chat's work came from a 30,000-character spec,
// and the second chat's request reached the question asking where new work belongs, which named the open work by its
// whole request (the state's Project line) twice: 62,407 bytes, over the step size limit. Every step that names the
// open work names it by the start of its request, as the plan question quotes a request (requestPreview), so each
// fits and the person's answer goes on.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import {
  cleanupTestProject,
  createTestProject,
  FIXTURES_DIR,
  followProposal,
  resetAidlcEnv,
  runOrchestrateNext,
  seedAidlcMemory,
  seededStateFile,
  seedStateFile,
} from "../harness/fixtures.ts";
import { type Directive, next, ORCHESTRATE, projectAt, say, SECOND_SESSION, SESSION } from "../harness/aidlc-input-corpus.ts";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS } from "../harness/test-budget.ts";
import { join } from "node:path";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

// The step size limit every harness keeps to (DEFAULT_DIRECTIVE_MAX_BYTES in aidlc-orchestrate.ts).
const STEP_LIMIT = 28 * 1024;
const END = "END-OF-THE-FIRST-REQUEST";

// A spec of about `chars` characters on one line, as the state's Project line holds the request it was made from.
function longRequest(chars: number): string {
  const sentence = (n: number) =>
    `Section ${n}: the ledger keeps every task a team adds, with its owner, its due day and its notes. `;
  let text = "Tally, a command-line task ledger for small teams. ";
  for (let n = 1; text.length < chars - END.length; n++) text += sentence(n);
  return `${text}${END}`;
}
const FIRST = longRequest(30_000);
const NAMED = `"${FIRST.slice(0, 240)}..."`;

const projects: string[] = [];
afterEach(() => {
  resetAidlcEnv();
  while (projects.length > 0) cleanupTestProject(projects.pop());
});

function madeFromLongRequest(proj: string): void {
  const file = seededStateFile(proj);
  writeFileSync(file, readFileSync(file, "utf-8").replace(/^- \*\*Project\*\*: .*$/m, `- **Project**: ${FIRST}`));
}

async function at(state: "work-open" | "stage-question-asked"): Promise<string> {
  const proj = await projectAt(state);
  projects.push(proj);
  madeFromLongRequest(proj);
  return proj;
}

function fits(out: string): void {
  expect(out, out.slice(0, 300)).not.toContain("could not send its next step");
  expect(Buffer.byteLength(out.trim(), "utf-8")).toBeLessThanOrEqual(STEP_LIMIT);
}

function textOf(directive: Directive | null): string {
  return JSON.stringify(directive ?? {});
}

const REQUESTS = [
  ["a short request", "Add a CSV export to the ledger"],
  ["a 30,000-character request", longRequest(30_000).replace(END, "END-OF-THE-SECOND-REQUEST")],
] as const;

// The words the person typed reach the question asking where they belong, through the step the engine prints for
// them (the agent runs its `next --request <id>`).
async function routingAsk(proj: string, words: string, session: string) {
  await say(proj, `/aidlc ${words}`, "claude", { session });
  const reading = await next(proj, [words], { session });
  fits(reading.out);
  const id = /next --request ([0-9a-f]{8})/.exec(String(reading.directive?.message ?? ""))?.[1];
  expect(id, reading.out.slice(0, 400)).toBeDefined();
  const ask = await next(proj, ["--request", id as string], { session });
  return { reading, ask };
}

describe("over work made from a long request, another request reaches the question where it belongs", () => {
  for (const [label, words] of REQUESTS) {
    for (const [chat, session] of [["the same chat", SESSION], ["a second chat", SECOND_SESSION]] as const) {
      test(`a stage question open, ${label}, ${chat}`, async () => {
        const proj = await at("stage-question-asked");
        const { ask } = await routingAsk(proj, words, session);
        fits(ask.out);
        expect(ask.directive?.ask_type, ask.out.slice(0, 300)).toBe("new-work-routing");
        expect(String(ask.directive?.question)).toContain(`Work is already in progress on: ${NAMED}`);
        expect(textOf(ask.directive)).not.toContain(END);
      });

      test(`no stage question open, ${label}, ${chat}: the re-entry step names the work by its start`, async () => {
        const proj = await at("work-open");
        const { reading, ask } = await routingAsk(proj, words, session);
        expect(String(reading.directive?.message)).toContain(`Work is in progress on ${NAMED}`);
        expect(textOf(reading.directive)).not.toContain(END);
        fits(ask.out);
        expect(ask.directive?.ask_type, ask.out.slice(0, 300)).toBe("new-work-routing");
        expect(textOf(ask.directive)).not.toContain(END);
      });
    }
  }

  // No self-loop: each answer the question offers moves on, and neither its step nor the next `next` asks where the
  // work belongs again (every ask has a new id, so the kind of ask is what is compared).
  for (const answer of ["continue_command", "new_intent_command", "compose_command"] as const) {
    test(`the answer ${answer} moves on from the question`, async () => {
      const proj = await at("stage-question-asked");
      const { ask } = await routingAsk(proj, "Add a CSV export to the ledger", SESSION);
      const command = String(ask.directive?.[answer] ?? "");
      expect(command, ask.out.slice(0, 400)).toContain(" next ");
      const answered = await next(proj, command.slice(command.indexOf(" next ") + 6).split(" "));
      fits(answered.out);
      expect(answered.directive?.kind, answered.out.slice(0, 300)).not.toBe("error");
      expect(answered.directive?.ask_type, answered.out.slice(0, 300)).not.toBe("new-work-routing");
      const after = await next(proj, []);
      expect(after.directive?.kind, after.out.slice(0, 300)).not.toBe("error");
      expect(after.directive?.ask_type, after.out.slice(0, 300)).not.toBe("new-work-routing");
    });
  }
});

describe("the other steps that name the open work name it by its start", () => {
  test("a plan's name typed alone beside the work: the reading step", async () => {
    const proj = await at("work-open");
    await say(proj, "/aidlc feature", "claude");
    const step = await next(proj, ["feature"]);
    fits(step.out);
    expect(String(step.directive?.message)).toContain(`beside the work on ${NAMED} on the \`bugfix\` plan`);
    expect(textOf(step.directive)).not.toContain(END);
  });

  test("a lowered Guard Policy on the open work, said when new work is picked with it", () => {
    resetAidlcEnv();
    const proj = createTestProject();
    projects.push(proj);
    seedAidlcMemory(proj);
    seedStateFile(proj, join(FIXTURES_DIR, "state-mid-ideation.md"));
    const file = seededStateFile(proj);
    writeFileSync(file, readFileSync(file, "utf-8")
      .replace("- **Change Control**: strict (from scope feature)", "- **Guard Policy**: relaxed (set by you)")
      .replace(/^- \*\*Project\*\*: .*$/m, `- **Project**: ${FIRST}`));
    const run = (args: string[]) => {
      const options = { cwd: proj, env: process.env };
      const res = followProposal(runOrchestrateNext(ORCHESTRATE, proj, args, options), ORCHESTRATE, proj, options);
      fits(res.out);
      return JSON.parse(res.out.split("\n").find((line) => line.trim().startsWith("{")) as string) as Directive;
    };
    const after = (command: unknown) => {
      const text = String(command);
      return run(text.slice(text.indexOf(" next ") + 6).split(" "));
    };
    const ask = run(["--guard-policy", "relaxed", "Fix the login crash when the session expires"]);
    expect(ask.ask_type).toBe("new-work-routing");
    const plan = after(ask.new_intent_command);
    expect(plan.ask_type, JSON.stringify(plan).slice(0, 300)).toBe("scope-confirm");
    const created = after(plan.confirm_command);
    expect(String(created.narration)).toContain(`is on for ${NAMED}, as you typed it with the request`);
    expect(JSON.stringify(created)).not.toContain(END);
  });
});
