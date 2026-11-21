// The security plugin's content and composition. The shipped validator accepts
// the authored root, and the packager's projection for Claude Code and Kiro IDE
// composes into a copy of that harness's install with no compose drops. The
// install's own dispatcher then fires the gate check the way the gate does, to
// prove the check reads the project's override mode on a real fire.
//
// Run: bash tests/run-tests.sh --integration --filter 'plugin-security'

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { harnessByName } from "../../../tests/harness/harness-matrix.ts";
import { composePluginFixture, validatePluginContent } from "../../../tests/harness/plugin-kit.ts";
import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../../../tests/harness/test-budget.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const PLUGIN_ROOT = join(import.meta.dir, "..");
const FIXTURES = join(import.meta.dir, "fixtures");

interface GraphNode {
  slug: string;
  phase: string;
  lead_agent: string;
  scopes?: string[];
  produces?: string[];
  consumes?: { artifact: string; required: boolean }[];
  requires_stage?: string[];
  sensors_applicable?: {
    id: string;
    path: string;
    fire_on: string;
    default_severity: string;
    category?: string;
    matches?: string;
  }[];
}

test("the shipped validator accepts the authored plugin root", () => {
  expect(validatePluginContent(PLUGIN_ROOT)).toEqual([]);
});

for (const harness of ["claude", "kiro-ide"] as const) {
  const harnessDir = harnessByName(harness).manifest.harnessDir;

  describe(`${harness} projection`, () => {
    let scratch = "";
    let project = "";
    let installed = "";
    let graph: GraphNode[] = [];
    let dropLogs = "";

    beforeAll(() => {
      scratch = mkdtempSync(join(tmpdir(), `aidlc-security-plugin-${harness}-`));
      const fixture = composePluginFixture({ plugin: "security", harness, projectDir: join(scratch, "project") });
      dropLogs = fixture.dropLogs;
      project = fixture.projectDir;
      installed = join(project, harnessDir);
      graph = JSON.parse(readFileSync(join(installed, "tools", "data", "stage-graph.json"), "utf-8")) as GraphNode[];
    });

    afterAll(() => {
      if (scratch) rmSync(scratch, { recursive: true, force: true });
    });

    test("composes with an empty drop log", () => {
      expect(dropLogs).toBe("");
    });

    test("puts the threat model in Inception, led by the core DevSecOps agent", () => {
      const stage = graph.find((node) => node.slug === "security-threat-model");
      expect(stage?.phase).toBe("inception");
      expect(stage?.lead_agent).toBe("aidlc-devsecops-agent");
      expect(stage?.scopes).toEqual(["enterprise", "feature", "mvp", "classic", "workshop"]);
    });

    test("binds the blocking findings gate to Code Generation, which writes the scan record", () => {
      const stage = graph.find((node) => node.slug === "code-generation");
      expect(stage?.sensors_applicable).toContainEqual({
        id: "security-findings-gate",
        path: `${harnessDir}/sensors/aidlc-security-findings-gate.md`,
        fire_on: "gate",
        default_severity: "blocking",
        category: "security",
        matches: "**/code-generation/{code-generation-plan,security-scan-result}.md",
      });
      expect(stage?.produces).toContain("security-scan-result");
      expect(stage?.consumes).toContainEqual({ artifact: "security-threat-model", required: false });
      expect(stage?.requires_stage).toContain("security-threat-model");
    });

    test("the dispatcher's fire blocks a recorded override without a config, and passes it with a lenient one", () => {
      const record = join(project, "aidlc-docs", "construction", "unit-a", "code-generation", "security-scan-result.md");
      mkdirSync(dirname(record), { recursive: true });
      copyFileSync(join(FIXTURES, "scan-records", "override-accepted", "security-scan-result.md"), record);
      const fire = (): string => {
        const run = spawnSync(
          process.execPath,
          [
            join(installed, "tools", "aidlc-sensor.ts"),
            "fire",
            "security-findings-gate",
            "--stage",
            "code-generation",
            "--output-path",
            record,
          ],
          {
            cwd: project,
            encoding: "utf-8",
            env: { ...process.env, AIDLC_PROJECT_DIR: project, CLAUDE_PROJECT_DIR: project },
            timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
          },
        );
        expect(run.status, `${run.stdout}${run.stderr}`).toBe(0);
        return (JSON.parse(run.stdout) as { result: string }).result;
      };
      expect(fire()).toBe("failed");
      copyFileSync(join(FIXTURES, "projects", "lenient", ".aidlc-security.json"), join(project, ".aidlc-security.json"));
      expect(fire()).toBe("passed");
    });

    test("gives the core DevSecOps agent the security baseline and the AWS Security Agent guidance", () => {
      const knowledge = join(installed, "knowledge", "aidlc-devsecops-agent");
      expect(readdirSync(knowledge)).toContain("security-baseline.md");
      expect(readFileSync(join(knowledge, "security-baseline.md"), "utf-8")).toContain("## SECURITY-15:");
      const persona = readFileSync(join(installed, "agents", "aidlc-devsecops-agent.md"), "utf-8");
      expect(persona).toContain("**AWS writes need the person's yes (security plugin).**");
      expect(persona).toContain("## AWS Security Agent (security plugin)");
    });
  });
}
