// covers: scope:enterprise
//
// MR9 live scope-routing journey. The deterministic scope transpose and runner
// tests already prove the enterprise scope data compiles; this test drives a
// real `/aidlc --scope enterprise` turn through the SDK and asserts the
// routing as data: creation stdout, state fields, and audit events. It stops at
// the creation Bash tool_result, before any human gate or stage body, so it
// proves live conductor-to-tool routing without spending a full workflow. (The
// legacy `--init` flag is retired: passed through, it became the intent's
// description and invited the conductor to ask what it meant.)
//
// Enterprise is the representative comprehensive v0.6.0 scope here: it was
// still UNCOVERED in the registry on the MR8 base, while the lower-depth scope
// families already had live or deterministic claims. This moves a real shipped
// scope off zero without inventing custom scope units.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  assertAuditEvent,
  assertStateField,
  assertToolResultContains,
} from "../harness/assert.ts";
import {
  cleanupTestProject,
  setupIntegrationProject,
} from "../harness/fixtures.ts";
import { driveAidlc, readStateField } from "../harness/sdk-drive.ts";

const SCOPE = "enterprise";
const TIMEOUT_S = Number.parseInt(process.env.AIDLC_TEST_TIMEOUT ?? "900", 10);
const TEST_TIMEOUT_MS = (Number.isFinite(TIMEOUT_S) ? TIMEOUT_S : 900) * 1000;
const DRIVE_TIMEOUT_MS = Math.max(120_000, TEST_TIMEOUT_MS - 15_000);

const AIDLC_SRC = join(import.meta.dir, "..", "..", "dist", "claude", ".claude");
const SCOPE_GRID = join(AIDLC_SRC, "tools", "data", "scope-grid.json");
const STAGE_GRAPH = join(AIDLC_SRC, "tools", "data", "stage-graph.json");

interface StageRow {
  slug: string;
  number: string;
  phase: string;
  lead_agent: string;
}

function numericStageOrder(a: string, b: string): number {
  const [aMajor, aMinor] = a.split(".").map((x) => Number.parseInt(x, 10));
  const [bMajor, bMinor] = b.split(".").map((x) => Number.parseInt(x, 10));
  if (aMajor !== bMajor) return aMajor - bMajor;
  return aMinor - bMinor;
}

function firstPostInitStage(scope: string): StageRow {
  const grid = JSON.parse(readFileSync(SCOPE_GRID, "utf8")) as Record<
    string,
    { stages: Record<string, string> }
  >;
  const stages = JSON.parse(readFileSync(STAGE_GRAPH, "utf8")) as StageRow[];
  const entry = grid[scope];
  if (!entry) throw new Error(`scope-grid.json has no ${scope} scope`);
  const first = stages
    .filter((s) => s.phase !== "initialization")
    .filter((s) => entry.stages[s.slug] === "EXECUTE")
    .sort((a, b) => numericStageOrder(a.number, b.number))[0];
  if (!first) throw new Error(`${scope} has no post-init EXECUTE stage`);
  return first;
}

describe("t141 enterprise scope routing (sdk live, MR9)", () => {
  test(
    "enterprise init records the scope and routes to the first post-init stage from scope-grid.json",
    async () => {
      const first = firstPostInitStage(SCOPE);
      const proj = setupIntegrationProject({
        noAidlcDocs: true,
        stripEnvScope: true,
      });
      try {
        const r = await driveAidlc(`/aidlc --scope ${SCOPE}`, {
          projectDir: proj,
          timeoutMs: DRIVE_TIMEOUT_MS,
          stopAfterToolResult: {
            toolName: "Bash",
            resultIncludes: `First post-init stage: ${first.slug}`,
          },
        });

        assertToolResultContains(r, "Bash", `State initialized: ${SCOPE} scope`);
        assertToolResultContains(r, "Bash", `First post-init stage: ${first.slug}`);
        assertAuditEvent(r, "WORKFLOW_STARTED");
        assertAuditEvent(r, "WORKSPACE_INITIALISED");
        assertAuditEvent(r, "STAGE_STARTED");

        expect(r.stateFile).toBeDefined();
        assertStateField(r, "Scope", SCOPE);
        assertStateField(r, "Current Stage", first.slug);
        assertStateField(r, "Active Agent", first.lead_agent);

        const state = r.stateFile ?? "";
        expect(readStateField(state, "Lifecycle Phase")).toBe(first.phase.toUpperCase());
      } finally {
        cleanupTestProject(proj);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
