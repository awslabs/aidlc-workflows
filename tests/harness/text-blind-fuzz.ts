// text-blind-fuzz.ts - the suite's short mode of the gate fuzz (gate-fuzz.ts): the engine is text-blind.
//
// A fixed seed's runs at every question the engine knows (the answers corpus's fixtures), every tool's hook wiring in
// turn and every Guard Policy in turn, each played twice with other words of the same shapes and checked against I1 to
// I9 (DESIGN.md section 4.2; I5 is the text-blind property, I8 runs on every fourth). A failure no FUZZ_STILL_TO_GO row
// in persons-words-readers.ts names fails the test; a known failure a change cannot remove at once is a row there,
// named with the slice that removes it.
// The output names the run and the row, never the person's text.
//
// The runs are split over unit files by `shard` (each file is one shard of the unit tier's tail);
// AIDLC_TEXT_BLIND_RUNS sets how many runs in all. Thousands go through gate-fuzz-run.ts on the boxes and the nightly.
import {
  checkPolicies, checkSeed, cleanupRuns, cleanupStates, type Failure, FIXTURES, fixtureState, HOST_IDS, play, POLICIES,
  stepsFor,
} from "./gate-fuzz.ts";
import { FUZZ_STILL_TO_GO } from "./persons-words-readers.ts";

export const TEXT_BLIND_SEED = 20261023;
export const TEXT_BLIND_SHARDS = 4;
const RUNS = Number(process.env.AIDLC_TEXT_BLIND_RUNS ?? 46);
const MOST = 12;
const I8_EVERY = 4;

/** A failure's group: what fails, with the run's own values taken out (gate-fuzz's grouping). */
export const group = (failure: Pick<Failure, "invariant" | "what">): string =>
  `${failure.invariant} ${failure.what.replace(/\\/g, "/").replace(/"[^"]*"/g, '"_"').replace(/\d+/g, "#")}`;

export interface ShardResult {
  runs: number;
  /** One line per failure: the run, the invariant and the row that names it (or "no row"). */
  lines: string[];
  /** The failures no row names, with their replay command. */
  fresh: string[];
  /** Every text the runs typed as the person, for the check that the output holds none of them. */
  typed: string[];
}

/** Play this shard's runs and match each failure to a row. */
export async function runTextBlindShard(shard: number, of = TEXT_BLIND_SHARDS): Promise<ShardResult> {
  const questions = Object.keys(FIXTURES);
  const result: ShardResult = { runs: 0, lines: [], fresh: [], typed: [] };
  try {
    for (let n = shard; n < RUNS; n += of) {
      const seed = (TEXT_BLIND_SEED + n * 7919) >>> 0;
      const state = await fixtureState(questions[n % questions.length], HOST_IDS[n % HOST_IDS.length], POLICIES[n % POLICIES.length]);
      const checked = checkSeed(state, seed, { most: MOST });
      const failures = [...checked.failures];
      if (n % I8_EVERY === 0 && state.policy !== "default") {
        const steps = stepsFor(state, seed, MOST);
        const byPolicy: Record<string, ReturnType<typeof play>> = { [state.policy]: checked.run };
        for (const policy of POLICIES) if (policy !== state.policy) byPolicy[policy] = play(state, seed, steps, { policy });
        failures.push(...checkPolicies(byPolicy));
      }
      result.runs++;
      for (const turn of checked.run.turns) result.typed.push(turn.text);
      for (const failure of failures) {
        const name = group(failure);
        const row = FUZZ_STILL_TO_GO.find((entry) => entry.group === name);
        result.lines.push(`run ${checked.id} ${failure.invariant} -> ${row ? `${row.slice} ${row.row}` : "no row"}`);
        if (!row) result.fresh.push(`${name}\n    replay: bun tests/harness/gate-fuzz-run.ts --replay '${checked.id}'\n    at: ${failure.source || "(no source named)"}`);
      }
      cleanupRuns();
    }
  } finally {
    cleanupRuns();
    cleanupStates();
  }
  return result;
}
