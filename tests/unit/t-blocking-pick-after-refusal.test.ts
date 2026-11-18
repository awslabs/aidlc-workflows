// covers: function:blockingSensorPicks
//
// The person's pick at a team's blocking check, in solo work built Unit by Unit
// with checkpoints: the refusal itself puts the question to them, so a reply
// that came after the refusal's own fire backs the pick even when the agent
// recorded the question after it. Read from the rows' order alone. A reply
// before the fire (the one that started the turn), a reply another question
// took, a fire after a Fix pick that came after the reply, a boundary between
// the fire and the question, and work outside that walk keep the rule that the
// reply must follow the question's record.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { blockingSensorPicks } from "../../core/tools/aidlc-lib.ts";
import type { AuditShardEvent } from "../../core/tools/aidlc-record-core.ts";
import { AIDLC_SRC } from "../harness/fixtures.ts";

const SLUG = "code-generation";
const CHECK = "retention";
let saved: string | undefined;

beforeAll(() => {
  saved = process.env.AIDLC_STAGE_GRAPH;
  const stages = JSON.parse(readFileSync(join(AIDLC_SRC, "tools", "data", "stage-graph.json"), "utf-8")) as Array<Record<string, unknown>>;
  const stage = stages.find((entry) => entry.slug === SLUG);
  if (stage === undefined) throw new Error(`no ${SLUG} in the shipped graph`);
  stage.sensors_applicable = [
    ...((stage.sensors_applicable as unknown[] | undefined) ?? []),
    { id: CHECK, path: `.claude/sensors/aidlc-${CHECK}.md`, fire_on: "gate", default_severity: "blocking", category: "test", matches: "**/intents/**" },
  ];
  const graph = join(mkdtempSync(join(tmpdir(), "pick-after-refusal-")), "stage-graph.json");
  writeFileSync(graph, `${JSON.stringify(stages, null, 2)}\n`, "utf-8");
  process.env.AIDLC_STAGE_GRAPH = graph;
});
afterAll(() => {
  if (saved === undefined) delete process.env.AIDLC_STAGE_GRAPH;
  else process.env.AIDLC_STAGE_GRAPH = saved;
});

const WALK = [
  "# AI-DLC State", "", "## Current Status",
  "- **Scope**: classic",
  "- **Construction Iteration**: unit-major",
  "- **Construction Checkpoints**: enabled",
  "",
].join("\n");
const STAGE_MAJOR = WALK.replace("- **Construction Iteration**: unit-major\n", "");

type Row = [event: string, fields?: Record<string, string>];

function rows(...list: Row[]): AuditShardEvent[] {
  return list.map(([event, fields = {}], pos) => ({
    event,
    block: Object.entries(fields).map(([name, value]) => `- **${name}**: ${value}`).join("\n"),
    pos,
    shard: "audit.md",
    shardIndex: 0,
    timestamp: `2026-11-06T09:00:${String(pos).padStart(2, "0")}Z`,
  }));
}

const fire = (
  event: "SENSOR_FAILED" | "SENSOR_COULD_NOT_RUN" | "SENSOR_BUDGET_OVERRIDE" | "SENSOR_PASSED" = "SENSOR_FAILED",
  unit?: string,
): Row =>
  [event, { "Stage slug": SLUG, "Sensor ID": CHECK, "Output path": "x/core/code-generation/code-summary.md", ...(unit ? { Unit: unit } : {}) }];
const reply: Row = ["HUMAN_TURN"];
const question = (unit?: string): Row => ["DECISION_RECORDED", {
  Stage: SLUG, Decision: "Blocking gate sensor failure", Options: "Fix findings,Override blocking sensors", ...(unit ? { Unit: unit } : {}),
}];
const answer = (details: string, unit?: string): Row => ["QUESTION_ANSWERED", { Stage: SLUG, Details: details, ...(unit ? { Unit: unit } : {}) }];
const picks = (list: AuditShardEvent[], state: string | null = WALK): string[] =>
  [...blockingSensorPicks(list, SLUG, undefined, undefined, state).values()];

describe("a pick recorded after the person's reply to the refusal", () => {
  test("counts when the reply came after the refusal's fire, at the late gate and at a Unit's checkpoint", () => {
    expect(picks(rows(fire(), reply, question(), answer("Override blocking sensors")))).toEqual(["Override blocking sensors"]);
    expect(picks(rows(fire("SENSOR_COULD_NOT_RUN"), reply, question(), answer("Override blocking sensors"))))
      .toEqual(["Override blocking sensors"]);
    // A check over its time budget, and a pass with a note (the tool was unavailable), refuse the gate too.
    expect(picks(rows(fire("SENSOR_BUDGET_OVERRIDE"), reply, question(), answer("Override blocking sensors"))))
      .toEqual(["Override blocking sensors"]);
    const noted: Row = ["SENSOR_PASSED", { ...fire("SENSOR_PASSED")[1], Note: "tool unavailable" }];
    expect(picks(rows(noted, reply, question(), answer("Override blocking sensors")))).toEqual(["Override blocking sensors"]);
    expect(picks(rows(fire(), reply, question(), answer("Fix findings")))).toEqual(["Fix findings"]);
    // At a checkpoint the fire names the Unit; a question logged without --unit is that Unit's.
    expect(picks(rows(fire("SENSOR_FAILED", "core"), reply, question("core"), answer("Override blocking sensors", "core"))))
      .toEqual(["Override blocking sensors"]);
    expect(picks(rows(fire("SENSOR_FAILED", "core"), reply, question(), answer("Override blocking sensors"))))
      .toEqual(["Override blocking sensors"]);
    // The order the protocol asks for still counts, with or without the fire.
    expect(picks(rows(question(), reply, answer("Override blocking sensors")))).toEqual(["Override blocking sensors"]);
  });

  test("does not count without a reply of the person's after the refusal", () => {
    // The reply that started the turn came before the fire.
    expect(picks(rows(reply, fire(), question(), answer("Override blocking sensors")))).toEqual([]);
    // The reply was spent: routed to other work.
    expect(picks(rows(fire(), reply, ["REQUEST_ROUTED", {}], question(), answer("Override blocking sensors")))).toEqual([]);
    // Another question took the reply.
    expect(picks(rows(fire(), ["DECISION_RECORDED", { Stage: SLUG, Decision: "Which file first?", Options: "core,extra" }],
      reply, answer("core"), question(), answer("Override blocking sensors")))).toEqual([]);
    // A fire after a Fix pick is a new refusal: the reply before it is spent.
    expect(picks(rows(fire(), reply, question(), answer("Fix findings"), fire(), question(), answer("Override blocking sensors"))))
      .toEqual(["Fix findings"]);
    // The gate opened or started again between the fire and the question.
    expect(picks(rows(fire(), reply, ["STAGE_AWAITING_APPROVAL", { Stage: SLUG }], question(), answer("Override blocking sensors"))))
      .toEqual([]);
    // Another Unit's fire is not this pick's refusal.
    expect(picks(rows(fire("SENSOR_FAILED", "extra"), reply, question("core"), answer("Override blocking sensors", "core"))))
      .toEqual([]);
    // A passing check refused nothing.
    expect(picks(rows(fire("SENSOR_PASSED"), reply, question(), answer("Override blocking sensors")))).toEqual([]);
  });

  test("reads as before outside solo work built Unit by Unit with checkpoints", () => {
    const shape = rows(fire(), reply, question(), answer("Override blocking sensors"));
    expect(picks(shape, STAGE_MAJOR)).toEqual([]);
    expect(picks(shape, `${WALK}- **Unit Ownership**: team\n`)).toEqual([]);
    expect(picks(shape, null)).toEqual([]);
  });
});
