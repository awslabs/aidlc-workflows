// covers: subcommand:aidlc-utility:scope-change, audit:SCOPE_CHANGED
//
// The person types a scope change while Construction runs "Continue
// automatically", with no model (tests/harness/scope-change-run.ts): classic,
// alpha approved, beta's NFR Design question open, then "/aidlc --scope mvp".
// The change goes through like any other, the run stays automatic, and alpha
// is never asked about again (its walking-skeleton checkpoint under mvp would
// stop the automatic run). The unattended refusal is t36's.

import { afterAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { switchAndFinish } from "../harness/scope-change-run.ts";
import { activeRecord, cleanupScopeProjects, SCOPE_RUN_TIMEOUT_MS } from "../harness/scope-run.ts";

afterAll(cleanupScopeProjects);

test("classic to mvp on \"Continue automatically\": the person's change goes through and the run stays automatic, done", () => {
  const { run, said } = switchAndFinish("mvp", [], { autonomy: () => "Continue automatically" });
  expect(said).toContain("Switched to mvp");
  expect(said).not.toContain("unattended");
  expect(readFileSync(activeRecord(run.proj).state, "utf-8")).toContain("- **Construction Autonomy Mode**: autonomous");
}, SCOPE_RUN_TIMEOUT_MS);
