// covers: hook:aidlc-record-human-turn, function:exactOptionPick, function:personsLatestGatePick,
// function:recordProtectedHumanResponse, function:notePlanApprovalAskReply, function:routingOptionReply,
// function:consumeSharedDirectiveAsk, function:offeredChoiceLabel, subcommand:aidlc-orchestrate:next,
// subcommand:aidlc-orchestrate:report, subcommand:aidlc-log:answer, subcommand:aidlc-bolt:checkpoint
//
// Every question AI-DLC asks the person, and the replies people give, as a checked-in corpus:
// tests/fixtures/aidlc-answers/corpus.json. Each item is one reply at the state where that question is open, with
// MEANING (what the person means) and EXPECTED. The reply goes through each host's own human-turn hook (typed in chat,
// typed after /aidlc, or picked in the question box), then the engine's step where there is one. Pass, for every item:
//  1. the record keeps what they typed, verbatim;
//  2. a tool records a choice only from an exact pick as the options were shown (a number where numbers were shown,
//     the label, "(Recommended)" stripped); anything else is left for the agent, with nothing recorded and no question
//     put to the person by the engine;
//  3. a non-answer (empty, the host's cancellation text, a dismissed box) records nothing and keeps nothing as a reply;
//  4. the agent's answer command with the exact choice it read puts the person's own words on the record beside it.
// An item whose EXPECTED needs a change not merged yet carries `after`: it is skipped, with the reason, until that
// change is in the source (LANDED in the harness reads for it). The corpus is generated; see
// tests/harness/aidlc-answers-corpus.ts for the shared mechanics and the item schema.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS } from "../harness/test-budget.ts";
import { cleanupTestProject } from "../harness/fixtures.ts";
import {
  ANSWERS, NO_FIXTURE, PICKER_HARNESSES, argvVariants, choiceRowCount, messageRecord, next, pick, projectAt,
  recordByAgent, recorded, rows, say, templateProjects, typedPrompt, waitsFor,
  type AnswersItem, type Directive, type Exec, type Harness, type Question, type Recorded, type StoredRecord,
} from "../harness/aidlc-answers-corpus.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const HARNESSES: Harness[] = ["claude", "codex", "kiro", "kiro-ide"];
const PARALLEL = Math.max(1, Number.parseInt(process.env.AIDLC_ANSWERS_PARALLEL ?? "6", 10) || 6);
const ONLY = process.env.AIDLC_ANSWERS_ONLY?.split(",").map((s) => s.trim()).filter(Boolean);

/** Questions whose exact pick a tool records at the hook, before any agent runs. The others are recorded only by the
 * agent's command, where the tool checks the label it passes (offeredChoiceLabel). */
const HOOK_RECORDS = new Set<Question>([
  "stage-gate", "stage-gate-accept-as-is", "code-plan", "code-plan-grouped", "unit-checkpoint", "batch-checkpoint",
  "verification-command", "construction-policy", "guard-recovery",
]);
/** Questions with an answer command of the agent's that this check runs (step 4). */
const AGENT_RECORDS = new Set<Question>([
  "stage-gate", "stage-gate-accept-as-is", "stage-gate-sensor-failure", "code-plan", "code-plan-grouped", "unit-checkpoint",
  "batch-checkpoint", "verification-command", "construction-policy", "summary-confirmation", "stage-question", "answer-mode",
  "learnings", "reopened-stage", "guard-recovery",
]);
/** The engine reads the typed reply itself when the agent forwards it to `next`. */
const ENGINE_READS = new Set<Question>(["routing"]);

interface HookSeen { exit: Exec; record: StoredRecord | null; recorded: Recorded; delta: number }
interface Observed {
  hooks: Partial<Record<Harness, HookSeen>>;
  steps: Array<{ variant: string; argv: string[]; status: number; directive: Directive | null; out: string }>;
  agent?: { event: string; exec: Exec; row: Record<string, string | null> | undefined };
  error?: string;
}
const observed = new Map<string, Observed>();
const projects: string[] = [];

const recordsByAgent = (item: AnswersItem): boolean =>
  AGENT_RECORDS.has(item.question) && item.expected.end.recorded !== "none" && item.expected.end.asks === 0 && !item.ambiguous;
const runsEngine = (item: AnswersItem): boolean =>
  (item.via === "aidlc" || item.via === "codex" || ENGINE_READS.has(item.question)) && item.input.trim() !== "";
const typedText = (item: AnswersItem): string => (item.via === "picker" ? item.picker?.answer ?? "" : typedPrompt(item));

async function observe(item: AnswersItem): Promise<Observed> {
  const result: Observed = { hooks: {}, steps: [] };
  try {
    for (const harness of HARNESSES) {
      if (item.via === "picker" && !PICKER_HARNESSES.includes(harness)) continue;
      const proj = await projectAt(item.question);
      projects.push(proj);
      const before = choiceRowCount(proj);
      const exit = item.via === "picker" ? await pick(proj, item, harness) : await say(proj, typedPrompt(item), harness);
      result.hooks[harness] = { exit, record: messageRecord(proj, typedText(item)), recorded: recorded(proj, item), delta: choiceRowCount(proj) - before };
      if (harness !== "claude") continue;
      if (runsEngine(item)) {
        for (const [variant, argv] of argvVariants(item)) {
          const step = await next(proj, argv);
          result.steps.push({ variant, argv, ...step });
        }
      }
      if (recordsByAgent(item)) {
        const recordedBy = await recordByAgent(proj, item, item.expected.end.recorded);
        if (recordedBy !== null) result.agent = { ...recordedBy, row: recordedBy.event === "" ? undefined : rows(proj, recordedBy.event).at(-1) };
      }
    }
  } catch (error) {
    result.error = (error as Error).message;
  }
  return result;
}

const items = ANSWERS.filter((item) => (ONLY ? ONLY.includes(item.id) : true));
const live = items.filter((item) => waitsFor(item) === null && NO_FIXTURE[item.question] === undefined);

beforeAll(async () => {
  const queue = [...live];
  await Promise.all(Array.from({ length: PARALLEL }, async () => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) observed.set(item.id, await observe(item));
  }));
});
afterAll(() => {
  for (const proj of [...projects, ...templateProjects()]) cleanupTestProject(proj);
});

describe("the answers corpus: a tool records only an exact pick as shown, keeps the words, and records nothing from a non-answer", () => {
  for (const item of items) {
    const waits = waitsFor(item) ?? NO_FIXTURE[item.question];
    if (waits !== undefined && waits !== null) {
      test.skip(`${item.id} ${JSON.stringify(item.input)} (waits for ${waits})`, () => {});
      continue;
    }
    test(`${item.id} ${item.question} ${item.via} ${JSON.stringify(item.input)}: ${item.meaning.slice(0, 80)}`, () => {
      const seen = observed.get(item.id);
      expect(seen, "observed").toBeDefined();
      expect(seen!.error, "fixture or hook").toBeUndefined();
      const engine = item.expected.engine;
      const text = typedText(item);
      const hookChoice = item.reader === "tool" && HOOK_RECORDS.has(item.question) ? engine.recorded : "none";
      for (const [harness, hook] of Object.entries(seen!.hooks) as Array<[Harness, HookSeen]>) {
        const where = `${harness}: ${hook.exit.stdout}${hook.exit.stderr}`;
        // 1. The host's hook took the turn and the record keeps what they typed, verbatim.
        expect(hook.exit.status, where).toBe(0);
        if (text !== "") {
          expect(hook.record, `${harness}: no message record`).not.toBeNull();
          expect(hook.record!.text, `${harness}: the record's text`).toBe(text);
        }
        // 2. A choice is recorded by a tool only from an exact pick as shown; 3. a non-answer records nothing.
        if (!ENGINE_READS.has(item.question)) {
          expect(hook.recorded.choice, `${harness}: the choice a tool recorded`).toBe(hookChoice);
        }
        // A plan approved from an exact pick writes its row at once; the edit choice and every other question's pick
        // land on their own record, never on a choice row.
        const rowsAllowed = item.question === "code-plan" && hookChoice !== "none" ? [0, 1]
          : item.question === "code-plan-grouped" && hookChoice !== "none" ? [0, 2] : [0];
        expect(rowsAllowed, `${harness}: choice rows the hook alone added (${hook.delta})`).toContain(hook.delta);
        // The words: kept whole where the question keeps them; nothing kept for a non-answer.
        if (hook.recorded.words !== null && !item.question.startsWith("code-plan")) {
          if (engine.words === null) {
            if (["stage-gate", "stage-gate-accept-as-is", "unit-checkpoint", "batch-checkpoint", "verification-command", "construction-policy"].includes(item.question)) {
              expect(hook.recorded.words, `${harness}: a non-answer kept as a reply`).toBeNull();
            }
          } else if (text !== "") {
            // A picked gate label is kept without its "(Recommended)" tag, as the picker returned it.
            expect(hook.recorded.words, `${harness}: the kept words`).toContain(text.replace(/^[/$]aidlc\s*/, "").replace(/\s*\(recommended\)\s*$/i, ""));
          }
        }
      }
      // The engine's step for an /aidlc line, or a reply the agent forwards to next: never a question to the person,
      // never a wrong action; a reading step carries the words for the agent.
      for (const step of seen!.steps) {
        const where = `${step.variant} next ${step.argv.join(" ")}: ${step.out.slice(0, 600)}`;
        expect(step.directive, where).not.toBeNull();
        const kind = step.directive!.kind;
        if (engine.no_ask) expect(kind, where).not.toBe("ask");
        if (engine.step === "reading-step") {
          expect(kind, where).toBe("print");
          expect(String(step.directive!.message ?? ""), where).toMatch(/--request [0-9a-f]{8}|--details|--action|--choice/);
        } else if (engine.step === "recorded") {
          expect(["print", "run-stage"], where).toContain(kind);
        }
        for (const never of engine.never ?? []) expect(JSON.stringify(step.directive), where).not.toContain(never);
      }
      // 4. The agent records the choice it read; the person's own words ride on the record beside it.
      if (seen!.agent !== undefined) {
        const { event, exec, row } = seen!.agent;
        const where = `${event}: ${exec.stdout}${exec.stderr}`;
        expect(exec.status, where).toBe(0);
        if (event !== "") {
          expect(row, `${event}: no row: ${exec.stdout}`).toBeDefined();
          if (text !== "" && item.via !== "picker" && row!["Person Reply"] !== null && row!["Person Reply"] !== undefined) {
            expect(row!["Person Reply"], `${event}: Person Reply`).toContain(text.replace(/^[/$]aidlc\s*/, ""));
          }
        }
      }
    });
  }
});
