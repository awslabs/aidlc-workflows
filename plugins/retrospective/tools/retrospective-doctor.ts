import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(
  process.env.AIDLC_PROJECT_DIR ?? process.cwd(),
  process.env.AIDLC_HARNESS_DIR ?? ".claude",
);

const stageGraph = join(root, "tools", "data", "stage-graph.json");

let stagePresent = false;
try {
  if (existsSync(stageGraph)) {
    const graph = JSON.parse(readFileSync(stageGraph, "utf-8")) as Array<{
      slug?: string;
    }>;
    stagePresent = graph.some((stage) => stage?.slug === "retrospective-ceremony");
  }
} catch {
  stagePresent = false;
}

console.log(
  JSON.stringify({
    checks: [
      {
        pass: stagePresent,
        label: "retrospective stage composed into the stage graph",
        fix: "Run `aidlc engine plugin sync` (or re-run hooks/compose.ts) after selecting the retrospective plugin.",
        severity: "error",
      },
    ],
  }),
);
