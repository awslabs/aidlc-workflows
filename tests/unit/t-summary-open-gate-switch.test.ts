// covers: function:checkSummaryConfirmationEvidence, audit:CEREMONY_SET
//
// Work done while summary confirmation was off is never re-checked against it
// once a later change turns it on (a scope switch or the person's setting): a
// stage whose gate was already open then, and a Unit whose stage work had
// finished. Requirements Analysis waits at its gate with a questions file and
// no summary section, as a run under bugfix leaves it; the switch writes
// CEREMONY_SET summary_confirmation off to on. The gate's Approve is not
// refused for a summary that stage never owed, under every Guard Policy, and a
// gate shown again is the same gate. Work that runs the stage again after the
// switch (Request Changes, the revision backstop's backfill, a new start) owes
// it as usual, and so does a gate when nothing turned the summary on (no row,
// a row that only said on again, a same-second tie across shards). The person
// path is the scope run in t-scope-run-moves-switch.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import {
  checkSummaryConfirmationEvidence,
  loadStageGraphAll,
  readAuditShardEvents,
  setCheckbox,
  setField,
  unitLifecycleRunFloorForProject,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  cleanupTestProject,
  createTestProject,
  seededAuditDir,
  seededRecordDir,
  seededStateFile,
  seedStateFile,
  withEnvAndFreshCaches,
} from "../harness/fixtures.ts";

const STAGE = "requirements-analysis";
const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) cleanupTestProject(tempDirs.pop()!);
});

// The runner's fixture profile switches the summary guard off; these cases are
// about that guard, so it stays on.
const GUARD_ON = { AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD: undefined, AIDLC_DISABLE_SUMMARY_CONFIRMATION: undefined };

function stage(slug: string) {
  const found = loadStageGraphAll().find((entry) => entry.slug === slug);
  if (!found) throw new Error(`no stage ${slug}`);
  return found;
}

/** Requirements Analysis at its gate on `scope`, summary confirmation on from `source`. */
function gateProject(scope = "enterprise", policy = "strict", source = `from scope ${scope}`): string {
  const proj = createTestProject();
  tempDirs.push(proj);
  seedStateFile(proj, "state-mid-inception.md");
  const statePath = seededStateFile(proj);
  let state = readFileSync(statePath, "utf-8")
    .replace(/^- \*\*Change Control\*\*:.*$/m, `- **Guard Policy**: ${policy} (from scope ${scope})`);
  state = setField(state, "Scope", scope);
  state = setField(state, "Summary Confirmation", `on (${source})`);
  state = setCheckbox(state, STAGE, "awaiting-approval");
  writeFileSync(statePath, state);
  const dir = join(seededRecordDir(proj), "inception", STAGE);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${STAGE}-questions.md`), "# Requirements Questions\n\n## Q1\n\nKeep the login flow?\n\n[Answer]: A\n");
  writeFileSync(join(dir, "requirements.md"), "# Requirements\n\n- Keep the login flow.\n");
  return proj;
}

const row = (proj: string, event: string, fields: Record<string, string> = {}) =>
  appendAuditEntry(event, { Stage: STAGE, ...fields }, proj);

const turnedOn = (proj: string, old = "off", source = "scope enterprise") =>
  appendAuditEntry("CEREMONY_SET", { Key: "summary_confirmation", Old: old, New: "on", Source: source }, proj);

/** The stage ran and its gate opened. */
function gateOpened(proj: string): void {
  row(proj, "STAGE_STARTED", { Agent: "aidlc-product-agent" });
  row(proj, "STAGE_AWAITING_APPROVAL");
}

function evidence(proj: string, slug = STAGE, options: { unit?: string; workflow?: string } = {}) {
  return withEnvAndFreshCaches(GUARD_ON, () =>
    checkSummaryConfirmationEvidence(proj, stage(slug), {
      stateContent: readFileSync(seededStateFile(proj), "utf-8"),
      ...options,
    }));
}

const notOwed = { ok: true, required: false } as const;

function expectOwed(result: ReturnType<typeof evidence>, code = "SUMMARY_ANSWER_INVALID"): void {
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.refusal?.code).toBe(code);
}

describe("a stage gate that was open when summary confirmation turned on", () => {
  for (const policy of ["strict", "relaxed", "off"]) {
    test(`owes no summary after the switch, Guard Policy ${policy}`, () => {
      const proj = gateProject("enterprise", policy);
      gateOpened(proj);
      turnedOn(proj);
      expect(evidence(proj)).toEqual(notOwed);
    });
  }

  test("the gate shown again after the switch is the same open gate", () => {
    const proj = gateProject();
    gateOpened(proj);
    turnedOn(proj);
    row(proj, "STAGE_AWAITING_APPROVAL");
    expect(evidence(proj)).toEqual(notOwed);
  });

  test("the person's own setting at the open gate counts the same as a scope switch", () => {
    const proj = gateProject("classic", "off", "set by you");
    gateOpened(proj);
    turnedOn(proj, "off", "you");
    expect(evidence(proj)).toEqual(notOwed);
  });
});

describe("work that runs the stage again after the switch owes the summary as usual", () => {
  test("Request Changes after the switch", () => {
    const proj = gateProject();
    gateOpened(proj);
    turnedOn(proj);
    row(proj, "GATE_REJECTED", { Details: "add offline login" });
    row(proj, "STAGE_REVISING", { "Revision count": "1" });
    row(proj, "STAGE_AWAITING_APPROVAL");
    expectOwed(evidence(proj));
  });

  test("the revision backstop's backfill for an edit at the open gate after the switch", () => {
    const proj = gateProject();
    gateOpened(proj);
    turnedOn(proj);
    row(proj, "GATE_REJECTED", { Recovered: "true", Details: "Backfilled by the revision backstop" });
    row(proj, "STAGE_REVISING", { "Revision count": "1", Recovered: "true" });
    expectOwed(evidence(proj));
    row(proj, "STAGE_AWAITING_APPROVAL", { Recovered: "true" });
    expectOwed(evidence(proj));
  });

  test("the stage started again after the switch", () => {
    const proj = gateProject();
    gateOpened(proj);
    turnedOn(proj);
    gateOpened(proj);
    expectOwed(evidence(proj));
  });
});

describe("a gate is owed the summary when nothing turned it on while the gate was open", () => {
  test("summary confirmation on from the scope from the start: no row", () => {
    const proj = gateProject();
    gateOpened(proj);
    expectOwed(evidence(proj));
  });

  test("a row that only says on again, under a scope already on", () => {
    const proj = gateProject();
    gateOpened(proj);
    turnedOn(proj, "on", "you");
    expectOwed(evidence(proj));
  });

  test("the switch in another clone's shard in the same second as the gate", () => {
    const proj = gateProject();
    row(proj, "STAGE_STARTED", { Agent: "aidlc-product-agent" });
    row(proj, "STAGE_AWAITING_APPROVAL");
    const gate = readAuditShardEvents(proj).filter((entry) => entry.event === "STAGE_AWAITING_APPROVAL").at(-1)!;
    writeFileSync(join(seededAuditDir(proj), "zzz-other-clone.md"), [
      "# AI-DLC Audit Log", "", "## Ceremony Set", `**Timestamp**: ${gate.timestamp}`, "**Event**: CEREMONY_SET",
      "**Key**: summary_confirmation", "**Old**: off", "**New**: on", "**Source**: scope enterprise", "", "---", "",
    ].join("\n"));
    expectOwed(evidence(proj));
  });

  test("an isolated single-stage run reads its own record, as before", () => {
    const proj = gateProject();
    gateOpened(proj);
    turnedOn(proj);
    expect(evidence(proj, STAGE, { workflow: `single-stage:${STAGE}` }).ok).toBe(false);
  });
});

describe("a Unit whose stage work finished before summary confirmation turned on", () => {
  const FD = "functional-design";

  function unitFinished(old: string): string {
    const proj = createTestProject();
    tempDirs.push(proj);
    seedStateFile(proj, "state-construction.md");
    const statePath = seededStateFile(proj);
    writeFileSync(statePath, setField(readFileSync(statePath, "utf-8"), "Summary Confirmation", "on (set by you)"));
    appendAuditEntry("STAGE_STARTED", { Stage: FD, Agent: "aidlc-architect-agent" }, proj);
    const floor = unitLifecycleRunFloorForProject(proj, FD, false, "widget-cart", undefined, false);
    appendAuditEntry("UNIT_STARTED", { Stage: FD, Unit: "widget-cart", "Run floor": floor }, proj);
    appendAuditEntry("UNIT_COMPLETED", { Stage: FD, Unit: "widget-cart", "Run floor": floor }, proj);
    appendAuditEntry("CEREMONY_SET", { Key: "summary_confirmation", Old: old, New: "on", Source: "you" }, proj);
    return proj;
  }

  test("owes no summary when the change turned it on", () => {
    expect(evidence(unitFinished("off"), FD, { unit: "widget-cart" })).toEqual(notOwed);
  });

  test("a row that only says on again turns nothing on", () => {
    expectOwed(evidence(unitFinished("on"), FD, { unit: "widget-cart" }), "SUMMARY_QUESTIONS_MISSING");
  });
});
