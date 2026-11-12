// covers: file:aidlc-common/stages/inception/reverse-engineering.md, file:aidlc-common/stages/inception/requirements-analysis.md, file:aidlc-common/stages/construction/ci-pipeline.md, file:aidlc-common/stages/operation/deployment-execution.md, file:aidlc-common/stages/operation/environment-provisioning.md
//
// A stage file's own step says what the engine and the stage protocol do, not
// something else beside them:
//   - the Approve choice names the next stage from the engine's next_stage, so
//     no stage file fixes one (Reverse Engineering said "continue to
//     Requirements Analysis" where most plans go to Practices Discovery);
//   - an inline stage dispatches no agent (stage-protocol-ensemble.md); its
//     support agents are perspectives the conductor takes on itself;
//   - a once-run stage that reads every Unit's Code Generation folder also
//     reads the stage-level one a zero-Unit plan writes;
//   - depth comes from the scope or the person, recorded in state, not from
//     Requirements Analysis's own assessment;
//   - Reverse Engineering's mint, coverage compare and publish are read on the
//     developer-alone path too, not left to the full roster.
// Every shipped tree is read, with its stage list from the shipped stage graph,
// so a later stage file that does the same fails here.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HARNESS_MATRIX } from "../harness/harness-matrix.ts";

type GraphStage = { slug: string; name: string; phase: string; mode: string };

const read = (path: string): string => readFileSync(path, "utf-8").replace(/\r\n/g, "\n");

function stages(engineRoot: string): Array<GraphStage & { text: string }> {
  const graph = JSON.parse(read(join(engineRoot, "tools", "data", "stage-graph.json"))) as GraphStage[];
  return graph.map((stage) => ({
    ...stage,
    text: read(join(engineRoot, "aidlc-common", "stages", stage.phase, `${stage.slug}.md`)),
  }));
}

const DISPATCH = [/subagent_type/, /Task tool/, /will invoke aidlc-/];

describe("t-stage-steps-agree-with-the-engine", () => {
  test.each(HARNESS_MATRIX.map((harness) => [harness.name, harness] as const))(
    "%s: each stage's steps say what the engine does",
    (_name, harness) => {
      const all = stages(harness.engineRoot);
      const found: string[] = [];
      for (const stage of all) {
        for (const other of all) {
          const name = other.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          if (new RegExp(`[Cc]ontinue to ${name}\\b`).test(stage.text)) {
            found.push(`${stage.slug}: names "${other.name}" as the next stage`);
          }
        }
        if (stage.mode === "inline") {
          for (const pattern of DISPATCH) {
            if (pattern.test(stage.text)) found.push(`${stage.slug}: inline, dispatches an agent (${pattern.source})`);
          }
        }
        if (stage.text.includes("/construction/*/code-generation/") && !stage.text.includes("/construction/code-generation/")) {
          found.push(`${stage.slug}: reads only the per-Unit Code Generation folders`);
        }
      }
      expect(found).toEqual([]);
    },
  );

  test.each(HARNESS_MATRIX.map((harness) => [harness.name, harness] as const))(
    "%s: Requirements Analysis takes its depth from the run, and Reverse Engineering publishes on every path",
    (_name, harness) => {
      const inception = join(harness.engineRoot, "aidlc-common", "stages", "inception");
      const requirements = read(join(inception, "requirements-analysis.md"));
      expect(requirements).toContain("### Step 3: Determine Depth");
      expect(requirements).not.toContain("Based on complexity assessment");
      const reverse = read(join(inception, "reverse-engineering.md"));
      expect(reverse).not.toContain("The rest of this step is the full-roster path");
      expect(reverse).not.toContain("Run this step only when");
      expect(reverse).toContain("codekb-publish");
    },
  );
});
