// covers: hook:aidlc-record-human-turn, hook:aidlc-continue-workflow, subcommand:aidlc-orchestrate:report, subcommand:aidlc-orchestrate:next, cli:aidlc-log(answer), cli:aidlc-bolt(checkpoint)
//
// The engine is a tool the agent uses, and it must not read the person's words (tests/harness/gate-fuzz.ts): at each
// question the engine knows (the answers corpus's fixtures), a seeded run of the person's turns, the agent's calls
// from the closed set, wrong calls, `next`, Stop probes and second chats is played twice, the second time with other
// words of the same shapes, and checked against I1 to I9. This is the suite's short mode: a fixed seed and a few dozen
// runs on Claude Code's wiring and one other tool's; tests/harness/gate-fuzz-run.ts runs thousands, every tool's
// wiring and every walked scope, and replays any run by its id.
//
// Today's main still has tools that read the words, so a run fails in known ways. Each such group (its invariant and
// what fails) is listed in tests/fixtures/gate-fuzz/baseline.json with the code path behind it, and this test fails
// only on a group that is not there: a new reader fails at once. The slice that removes a reader deletes its lines; at
// zero the file goes and every failure fails. AIDLC_GATE_FUZZ_WRITE_BASELINE=1 writes the groups this run met as the
// baseline instead, and only those, keeping the reason of each group already listed.
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../harness/fixtures.ts";
import { checkSeed, cleanupRuns, cleanupStates, FIXTURES, fixtureState, type HostId, POLICIES } from "../harness/gate-fuzz.ts";

setDefaultTimeout(30 * 60_000);

const SEED = 20261022;
const RUNS = Number(process.env.AIDLC_GATE_FUZZ_SEEDS ?? 24);
const MOST = 8;
const BASELINE = join(REPO_ROOT, "tests", "fixtures", "gate-fuzz", "baseline.json");
// Claude Code most of the time, and each other tool's own hook path in turn.
const OTHER: readonly HostId[] = ["codex", "kiro", "kiro-ide", "copilot", "cursor", "opencode"];

/** A failure's group, as the baseline names it: what fails, with the run's own values taken out. */
const group = (invariant: string, what: string) =>
  `${invariant} ${what.replace(/\\/g, "/").replace(/"[^"]*"/g, '"_"').replace(/\d+/g, "#")}`;

describe("the engine does not read the person's words (gate fuzz, short mode)", () => {
  afterAll(() => {
    cleanupRuns();
    cleanupStates();
  });

  test(`${RUNS} seeded runs at the questions the engine knows`, async () => {
    // Each known group with its one-line reason: the code path on main that makes a run fail that way.
    const reasons: Record<string, string> = existsSync(BASELINE) ? (JSON.parse(readFileSync(BASELINE, "utf-8")) as { groups: Record<string, string> }).groups : {};
    const known = new Set<string>(Object.keys(reasons));
    const questions = Object.keys(FIXTURES);
    const fresh: string[] = [];
    const met = new Set<string>();
    let failing = 0;
    for (let n = 0; n < RUNS; n++) {
      const seed = (SEED + n * 7919) >>> 0;
      const host: HostId = n % 4 === 3 ? OTHER[Math.floor(n / 4) % OTHER.length] : "claude";
      const state = await fixtureState(questions[n % questions.length], host, POLICIES[n % POLICIES.length]);
      const checked = checkSeed(state, seed, { most: MOST });
      cleanupRuns();
      if (checked.failures.length > 0) failing++;
      for (const failure of checked.failures) {
        const name = group(failure.invariant, failure.what);
        met.add(name);
        if (!known.has(name)) fresh.push(`${name}\n    run: bun tests/harness/gate-fuzz-run.ts --replay '${checked.id}'\n    ${failure.source} ${failure.detail.slice(0, 300)}`);
      }
    }
    console.log(`gate fuzz: ${RUNS} runs, ${failing} with a failure, ${fresh.length} outside the baseline; groups met: ${[...met].sort().join(" | ")}`);
    if (process.env.AIDLC_GATE_FUZZ_WRITE_BASELINE === "1") {
      mkdirSync(join(BASELINE, ".."), { recursive: true });
      const groups = Object.fromEntries([...met].sort().map((name) => [name, reasons[name] ?? ""]));
      writeFileSync(BASELINE, `${JSON.stringify({ seed: SEED, runs: RUNS, groups }, null, 2)}\n`);
      return;
    }
    expect(fresh, "a failure group outside tests/fixtures/gate-fuzz/baseline.json: a tool reads the person's words or refuses them in a new way").toEqual([]);
  });
});
