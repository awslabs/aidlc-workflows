// covers: hook:aidlc-record-human-turn, hook:aidlc-continue-workflow, subcommand:aidlc-orchestrate:report, subcommand:aidlc-orchestrate:next, cli:aidlc-log(answer), cli:aidlc-bolt(checkpoint)
//
// The engine is text-blind: shard 2 of the gate fuzz's short mode (tests/harness/text-blind-fuzz.ts says what each
// run checks and how a failure today's main still has is named to its row).
import { expect, setDefaultTimeout, test } from "bun:test";
import { runTextBlindShard, TEXT_BLIND_SHARDS } from "../harness/text-blind-fuzz.ts";

setDefaultTimeout(20 * 60_000);

test(`the engine is text-blind: shard 2 of ${TEXT_BLIND_SHARDS} of the seeded runs`, async () => {
  const result = await runTextBlindShard(1);
  console.log(`gate fuzz shard 2: ${result.runs} runs, ${result.lines.length} failures, ${result.fresh.length} with no row${result.lines.length ? `\n${result.lines.join("\n")}` : ""}`);
  // The output names runs and rows, never the person's words.
  const shown = [...result.lines, ...result.fresh].join("\n");
  expect(result.typed.filter((text) => text.trim().length >= 12 && shown.includes(text.trim())).length).toBe(0);
  expect(result.fresh, "a failure no FUZZ_STILL_TO_GO row in tests/harness/persons-words-readers.ts names").toEqual([]);
});
