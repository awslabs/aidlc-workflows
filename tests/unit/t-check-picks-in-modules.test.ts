// covers: file:aidlc-common/protocols/stage-protocol-learnings.md, file:aidlc-common/protocols/stage-protocol-sensors.md
//
// What the agent reads about a team's check's own question, which no tool can
// read for it (the learnings step takes the agent's account of a correction,
// never a turn). The person's answer to the check's question, Fix findings or
// Override blocking sensors in any words, is a decision on those findings and
// never offered to keep as a project rule (a live run kept a rule that skipped
// the team's own blocking check). When the person names one check to switch
// off, there is no switch for one check: the agent asks once which reach they
// mean, as the check's own question with the work's switch as a third option,
// so either pick is taken from that one ask (the Override's pick still offers
// both of the check's choices), and never asks it twice.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BLOCKING_SENSOR_OVERRIDE_DECISION, BLOCKING_SENSOR_OVERRIDE_OPTIONS } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { SWITCH_CHECKS_OFF_CHOICE } from "../../dist/claude/.claude/tools/aidlc-orchestrate.ts";
import { AIDLC_SRC } from "../harness/fixtures.ts";

const protocolModule = (name: string): string =>
  readFileSync(join(AIDLC_SRC, "aidlc-common", "protocols", `stage-protocol-${name}.md`), "utf-8");

describe("a team's check's own question, in the modules", () => {
  test("the learnings step never offers the person's answer to a check's question as a correction", () => {
    const whenToRun = protocolModule("learnings").split("### When to run")[1]?.split("### The ritual")[0] ?? "";
    expect(whenToRun).toContain(
      "neither is their answer to a check's own question (Fix findings or Override blocking sensors, in any words)",
    );
  });

  test("one check named to switch off is asked once, with both reaches in the check's own question", () => {
    const sensors = protocolModule("sensors");
    const bullet = sensors.split("\n").find((line) => line.startsWith("- **One check named to switch off**")) ?? "";
    expect(bullet).toContain("there is no switch for one check");
    expect(bullet).toContain("Never ask which they meant a second time: a request to switch this check off again at a later Unit takes their earlier pick");
    expect(bullet).toContain("next --sensors off");
    const options = /--options "([^"]+)"/.exec(bullet)?.[1]?.split(",") ?? [];
    // The Override is still the check's own pick: its question offers both of the check's choices.
    for (const option of BLOCKING_SENSOR_OVERRIDE_OPTIONS) expect(options).toContain(option);
    // The engine's label for that choice, which the switch records as their answer to the check's question.
    expect(options).toContain(SWITCH_CHECKS_OFF_CHOICE);
    expect(sensors).toContain(`--decision "${BLOCKING_SENSOR_OVERRIDE_DECISION}"`);
  });
});
