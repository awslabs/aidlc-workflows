// Opt-in check against real AIDLC folders on this machine. Skipped unless
// AIDLC_CC_REAL names a folder to scan; it only reads that folder.
//   AIDLC_CC_REAL=~/code bun test tests/real.test.ts
import { expect, test } from "bun:test";
import { discover } from "../../core/command-center/server/discovery";
import { buildHome } from "../../core/command-center/server/model/home";

const dir = process.env.AIDLC_CC_REAL;

test.skipIf(!dir)("real folders: every intent builds; progress uses the EXECUTE denominator", async () => {
  const found = await discover({ version: 1, roots: [dir!], pins: [], hidden: [], repos: [], theme: "auto" });
  const home = await buildHome(found);
  const all = home.workspaces.flatMap((w) => w.intents);
  expect(all.length).toBeGreaterThan(0);
  for (const i of all) {
    // Planned counts EXECUTE stages only; SKIP stages are reported separately.
    expect(i.doneCount, i.name).toBeLessThanOrEqual(i.plannedCount);
    expect(i.skippedCount, i.name).toBeGreaterThanOrEqual(0);
    expect(i.unparsed, i.name).toBe(0);
  }
  console.log(
    all
      .map((i) => `${i.name}: ${i.doneCount}/${i.plannedCount} planned · ${i.skippedCount} skipped · units ${i.unitsDone} · ${i.liveness}`)
      .join("\n"),
  );
}, 60_000);
