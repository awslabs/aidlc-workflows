// covers: tool:aidlc, function:resolveAction, function:aidlcToolInvocation, tool:aidlc-unit
//
// Every Unit command the engine hands the agent runs on a native install too.
// The engine prints them through aidlcToolInvocation("unit"): the copy channel
// runs the tool's own script, while the binary reads `aidlc engine unit <verb>`
// through its route table, so each printed verb has to be routed there. The
// public `aidlc unit` route, the form the guide names for people, routes every
// verb the tool runs as well.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveAction, TOOLS } from "../../core/tools/aidlc.ts";
import { aidlcDispatcherInvocation, aidlcInvocation } from "../../core/tools/aidlc-runtime-paths.ts";
import { UNIT_VERBS } from "../../core/tools/aidlc-unit.ts";

const TOOLS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "core", "tools");

// The verb after each printed unit command, in every engine source file.
function printedUnitVerbs(): Set<string> {
  const verbs = new Set<string>();
  for (const file of readdirSync(TOOLS_DIR).filter((name) => name.endsWith(".ts"))) {
    const text = readFileSync(join(TOOLS_DIR, file), "utf-8");
    for (const match of text.matchAll(/\$\{(?:unitTool|aidlcToolInvocation\("unit"\))\}\s+([a-z][a-z-]*)/g)) {
      verbs.add(match[1]);
    }
  }
  return verbs;
}

describe("unit commands on a native install", () => {
  test("every unit command the engine prints is routed by the binary to the unit tool", () => {
    // The binary's argv for the printed form: what follows `aidlc`.
    const route = aidlcDispatcherInvocation("unit").slice(aidlcInvocation().length).trim().split(/\s+/);
    const verbs = [...printedUnitVerbs()].sort();
    expect(verbs).toEqual(expect.arrayContaining(["amend", "assign", "push", "sign-off", "take"]));
    for (const verb of verbs) {
      expect(resolveAction([...route, verb, "refunds"], true), verb).toEqual({
        type: "delegate",
        tool: TOOLS.unit,
        args: [verb, "refunds"],
      });
    }
  });

  test("the public unit route runs every verb the unit tool runs", () => {
    for (const verb of UNIT_VERBS) {
      expect(resolveAction(["unit", verb], true), verb).toEqual({ type: "delegate", tool: TOOLS.unit, args: [verb] });
    }
  });
});
