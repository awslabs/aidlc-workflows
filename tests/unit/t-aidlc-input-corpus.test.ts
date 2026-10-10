// covers: subcommand:aidlc-orchestrate:next, function:parseNextFlags, function:parseWorkspaceCommand,
// function:splitKiroCommandArgs, hook:aidlc-record-human-turn
//
// What people type after /aidlc (and in plain chat once work is under way), as a checked-in corpus:
// tests/fixtures/aidlc-input/corpus.json. Each item is one typed line at one workspace state, with
// MEANING (what the person means, in plain words) and EXPECTED (what the engine's first step must
// do about it). The person's turn goes through each host's own human-turn hook (Claude Code, Codex,
// Kiro CLI, Kiro IDE), then `next` runs with the line exactly as that host hands it over (bare, for a
// plain-chat line). Pass, for every item: the message record keeps the typed text verbatim, the
// person's words whole and in order, and the settings they typed; and `next` either acts exactly as
// EXPECTED names (a known flag, verb, record name or pick) or returns the one agent-facing note,
// never a wrong name, a dropped word, a setting silently lost, or a question to the person when
// the item is not `ambiguous`.
//
// An item whose EXPECTED needs a change not merged yet carries `after`: it is skipped, with the
// reason, until that change is in the source (LANDED in the harness reads for it), so the file is
// green on main and tightens by itself as each one lands. The corpus is generated; see
// tests/harness/aidlc-input-corpus.ts for the shared mechanics and the item schema.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS } from "../harness/test-budget.ts";
import { cleanupTestProject } from "../harness/fixtures.ts";
import {
  CORPUS,
  HARNESSES,
  LANDED,
  argvVariants,
  messageRecord,
  next,
  projectAt,
  say,
  typedPrompt,
  waitsFor,
  type ArgvVariant,
  type CorpusItem,
  type Directive,
  type Exec,
  type Harness,
  type StoredRecord,
} from "../harness/aidlc-input-corpus.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const PARALLEL = Math.max(1, Number.parseInt(process.env.AIDLC_INPUT_PARALLEL ?? "6", 10) || 6);
const ONLY = process.env.AIDLC_INPUT_ONLY?.split(",").map((s) => s.trim()).filter(Boolean);

interface Observed {
  hooks: Partial<Record<Harness, { exit: Exec; record: StoredRecord | null }>>;
  steps: Partial<Record<ArgvVariant, { argv: string[]; status: number; directive: Directive | null; out: string }>>;
  error?: string;
}
const observed = new Map<string, Observed>();
const projects: string[] = [];

async function observe(item: CorpusItem): Promise<Observed> {
  const result: Observed = { hooks: {}, steps: {} };
  const prompt = typedPrompt(item);
  try {
    for (const harness of HARNESSES) {
      const proj = await projectAt(item.state);
      projects.push(proj);
      const exit = await say(proj, prompt, harness);
      result.hooks[harness] = { exit, record: messageRecord(proj, prompt) };
      if (harness !== "claude") continue;
      for (const [variant, argv] of argvVariants(item)) {
        const step = await next(proj, argv);
        result.steps[variant] = { argv, ...step };
      }
    }
  } catch (error) {
    result.error = (error as Error).message;
  }
  return result;
}

const live = CORPUS.filter((item) => waitsFor(item) === null && (!ONLY || ONLY.includes(item.id)));

beforeAll(async () => {
  const queue = [...live];
  await Promise.all(Array.from({ length: PARALLEL }, async () => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) observed.set(item.id, await observe(item));
  }));
}, NATIVE_FIXTURE_SETUP_TIMEOUT_MS * 4);

afterAll(() => {
  while (projects.length > 0) cleanupTestProject(projects.pop());
});

test("the corpus is well formed", () => {
  const ids = new Set<string>();
  for (const item of CORPUS) {
    expect(ids.has(item.id), `duplicate id ${item.id}`).toBe(false);
    ids.add(item.id);
    expect(item.meaning, item.id).toMatch(/^the person means: /);
    expect(item.expected.engine.kinds.length, `${item.id}: kinds`).toBeGreaterThan(0);
    if (item.ambiguous) expect(item.expected.engine.no_ask, `${item.id}: an ambiguous item is asked once`).toBeFalsy();
    if (item.after !== undefined) expect(LANDED[item.after], `${item.id}: unknown after ${item.after}`).toBeDefined();
  }
});

const categories = [...new Set(CORPUS.map((item) => item.category))];
for (const category of categories) {
  describe(category, () => {
    for (const item of CORPUS.filter((i) => i.category === category)) {
      const name = `${item.id} ${typedPrompt(item)} [${item.state}]: ${item.meaning}`;
      const waiting = waitsFor(item);
      if (waiting !== null) {
        test.skip(`${name} (after ${waiting} lands)`, () => {});
        continue;
      }
      if (ONLY && !ONLY.includes(item.id)) continue;
      test(name, () => {
        const seen = observed.get(item.id);
        expect(seen, `${item.id} was not observed`).toBeDefined();
        expect(seen?.error, `${item.id}: fixture`).toBeUndefined();
        const engine = item.expected.engine;
        const prompt = typedPrompt(item);

        // The record: every host's hook keeps the typed text, the words and the settings.
        for (const harness of HARNESSES) {
          const hook = seen!.hooks[harness];
          expect(hook, `${harness}: no hook result`).toBeDefined();
          expect(hook!.exit.status, `${harness} hook: ${hook!.exit.stderr}`).toBe(0);
          const record = hook!.record;
          expect(record, `${harness}: no message record for ${JSON.stringify(prompt)}`).not.toBeNull();
          expect(record!.text.trim(), `${harness}: the typed text`).toBe(prompt.trim());
          if (engine.words !== undefined) expect(record!.words, `${harness}: the person's words`).toBe(engine.words);
          if (engine.settings !== undefined) {
            expect(record!.settings.map((s) => [s.key, s.value]), `${harness}: the typed settings`).toEqual(engine.settings);
          }
        }

        // The first step, per way the host hands the line over.
        for (const [variant, step] of Object.entries(seen!.steps)) {
          const label = `${variant} ${JSON.stringify(step.argv)}`;
          expect(step.directive, `${label}: no directive: ${step.out}`).not.toBeNull();
          const d = step.directive!;
          const text = [d.message, d.question, d.narration, ...Object.values(d).filter((v) => typeof v === "string")].join("\n");
          expect(engine.kinds, `${label}: kind ${d.kind} ${d.ask_type ?? ""}: ${d.message ?? d.question ?? ""}`).toContain(d.kind ?? "");
          for (const named of engine.names ?? []) expect(text, `${label}: names ${JSON.stringify(named)}`).toContain(named);
          for (const forbidden of engine.never ?? []) expect(text, `${label}: never ${JSON.stringify(forbidden)}`).not.toContain(forbidden);
          if (engine.no_ask) expect(d.kind, `${label}: a question reached the person: ${d.question ?? d.message}`).not.toBe("ask");
        }
      });
    }
  });
}
