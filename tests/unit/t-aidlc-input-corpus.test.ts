// covers: subcommand:aidlc-orchestrate:next, function:parseNextFlags, function:parseWorkspaceCommand,
// function:splitKiroCommandArgs, hook:aidlc-record-human-turn
//
// What people type after /aidlc (and in plain chat once work is under way), as a checked-in corpus:
// tests/fixtures/aidlc-input/corpus.json. Each item is one typed line at one workspace state, with
// MEANING (what the person means, in plain words) and EXPECTED (what the engine's first step must
// do about it). For every item the person's turn goes through the Claude Code human-turn hook, then
// `next` runs with the line exactly as the host hands it over (bare, for a plain-chat line). Pass: the
// message record keeps the typed text verbatim, the person's words whole and in order, and the
// settings they typed; and `next` either acts exactly as EXPECTED names (a known flag, verb, record
// name or pick) or returns the one agent-facing note, never a wrong name, a dropped word, a setting
// silently lost, or a question to the person when the item is not `ambiguous`. The other hosts' hooks
// (Codex, Kiro CLI, Kiro IDE) take the same turn for a fixed sample of items per category (the first
// HOST_HOOK_SAMPLE in corpus order), each in a fresh project at the item's state: the record contract
// is the same hook under every host, so a sample holds the plumbing while the file stays fast enough
// for every PR (one project and about two processes per item).
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
  hookRuns,
  itemEnv,
  messageRecord,
  next,
  projectAt,
  say,
  sessionOf,
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
// How many items per category also take their turn through the Codex, Kiro CLI and Kiro IDE hooks. Fixed, not seeded:
// the same items every run, on every platform.
const HOST_HOOK_SAMPLE = 2;
const HOST_HOOKS = HARNESSES.filter((h) => h !== "claude");

interface Observed {
  hooks: Partial<Record<Harness, { exit: Exec; record: StoredRecord | null }>>;
  steps: Partial<Record<ArgvVariant, { argv: string[]; status: number; directive: Directive | null; out: string }>>;
  error?: string;
}
const observed = new Map<string, Observed>();
const projects: string[] = [];

async function observe(item: CorpusItem, hostHooks: boolean): Promise<Observed> {
  const result: Observed = { hooks: {}, steps: {} };
  const prompt = typedPrompt(item);
  const opts = { session: sessionOf(item), env: itemEnv(item) };
  try {
    // The Claude Code path, in one project: the person's turn through the hook (unless hooks are off, when the engine
    // meets the line with no turn on record), then the engine's first step per way the host hands the line over.
    const proj = await projectAt(item.state);
    projects.push(proj);
    if (hookRuns(item)) {
      const exit = await say(proj, prompt, "claude", opts);
      result.hooks.claude = { exit, record: messageRecord(proj, prompt) };
    }
    for (const [variant, argv] of argvVariants(item)) {
      const step = await next(proj, argv, opts);
      result.steps[variant] = { argv, ...step };
    }
    // The other hosts' hooks, each on a fresh project at the same state, for the sampled items.
    if (hostHooks && hookRuns(item)) {
      for (const harness of HOST_HOOKS) {
        const own = await projectAt(item.state);
        projects.push(own);
        const exit = await say(own, prompt, harness, opts);
        result.hooks[harness] = { exit, record: messageRecord(own, prompt) };
      }
    }
  } catch (error) {
    result.error = (error as Error).message;
  }
  return result;
}

const live = CORPUS.filter((item) => waitsFor(item) === null && (!ONLY || ONLY.includes(item.id)));
const hostHookSample = new Set<string>();
for (const category of new Set(live.map((item) => item.category))) {
  for (const item of live.filter((i) => i.category === category && hookRuns(i)).slice(0, HOST_HOOK_SAMPLE)) hostHookSample.add(item.id);
}

beforeAll(async () => {
  const queue = [...live];
  await Promise.all(Array.from({ length: PARALLEL }, async () => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) observed.set(item.id, await observe(item, hostHookSample.has(item.id)));
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

        // The record: the hook keeps the typed text, the words and the settings, under every host that took the turn
        // (Claude Code for every item, the others for the sampled ones). No record is owed when the hook never ran
        // (hooks off), and none is written today for a chat that has not joined or an unattended run (those items
        // wait on their own changes; their record check is the words expectation, when set).
        const recordOwed = hookRuns(item) && !["second-chat", "unattended"].includes(item.state);
        const hosts = hookRuns(item) ? ["claude", ...(hostHookSample.has(item.id) ? HOST_HOOKS : [])] : [];
        for (const harness of hosts as Harness[]) {
          const hook = seen!.hooks[harness];
          expect(hook, `${harness}: no hook result`).toBeDefined();
          expect(hook!.exit.status, `${harness} hook: ${hook!.exit.stderr}`).toBe(0);
          const record = hook!.record;
          if (!recordOwed && record === null && engine.words === undefined) continue;
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
