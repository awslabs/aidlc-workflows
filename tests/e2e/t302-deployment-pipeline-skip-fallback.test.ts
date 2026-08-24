// covers: subcommand:aidlc-orchestrate:report, subcommand:aidlc-orchestrate:next,
// subcommand:aidlc-jump:execute, scope:bugfix, scope:refactor

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  AIDLC_SRC,
  cleanupTestProject,
  runOrchestrateNext,
  setupIntegrationProject,
} from "../harness/fixtures.ts";

const BUN = process.execPath;
const UTILITY = join(AIDLC_SRC, "tools", "aidlc-utility.ts");
const ORCHESTRATE = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
const JUMP = join(AIDLC_SRC, "tools", "aidlc-jump.ts");
const projects: string[] = [];
type Directive = Record<string, unknown>;

afterAll(() => {
  for (const project of projects) cleanupTestProject(project);
});

function engineEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    AIDLC_SKIP_ARTIFACT_GUARD: "1",
    AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD: "1",
    AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "1",
    AIDLC_SKIP_REVISION_BACKSTOP: "1",
    AIDLC_SKIP_SOURCE_FRESHNESS: "1",
  };
}

function activeRecordDir(project: string): string {
  const space = readFileSync(join(project, "aidlc", "active-space"), "utf-8")
    .trim();
  const intents = join(project, "aidlc", "spaces", space, "intents");
  const record = readFileSync(join(intents, "active-intent"), "utf-8").trim();
  return join(intents, record);
}

function next(project: string): Directive {
  const result = runOrchestrateNext(ORCHESTRATE, project, [], {
    cwd: project,
    env: engineEnv(),
  });
  expect(result.status, result.out).toBe(0);
  expect(result.directive, result.out).not.toBeNull();
  return result.directive as Directive;
}

function report(project: string, args: string[]): Directive {
  const result = spawnSync(
    BUN,
    [ORCHESTRATE, "report", ...args, "--project-dir", project],
    { encoding: "utf-8", env: engineEnv() },
  );
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  return JSON.parse(result.stdout.trim()) as Directive;
}

function writePath(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body, "utf-8");
}

function runSkipFallback(scope: "bugfix" | "refactor"): void {
  const project = setupIntegrationProject({
    withGreenfieldStub: true,
    stripEnvScope: true,
  });
  projects.push(project);

  const born = spawnSync(
    BUN,
    [
      UTILITY,
      "intent-create",
      "--scope",
      scope,
      "--arguments",
      `Ship an existing-pipeline ${scope}`,
      "--project-dir",
      project,
    ],
    { encoding: "utf-8" },
  );
  expect(born.status, `${born.stdout}\n${born.stderr}`).toBe(0);

  const jumped = spawnSync(
    BUN,
    [
      JUMP,
      "execute",
      "--target",
      "deployment-pipeline",
      "--direction",
      "forward",
      "--scope",
      scope,
      "--project-dir",
      project,
    ],
    { encoding: "utf-8" },
  );
  expect(jumped.status, `${jumped.stdout}\n${jumped.stderr}`).toBe(0);

  const record = activeRecordDir(project);
  writePath(
    join(project, ".github", "workflows", "deploy.yml"),
    "name: deploy\non: workflow_dispatch\njobs: {}\n",
  );

  const pipeline = next(project);
  expect(pipeline).toMatchObject({
    kind: "run-stage",
    stage: "deployment-pipeline",
  });
  const skipped = report(project, [
    "--stage",
    "deployment-pipeline",
    "--result",
    "skipped",
    "--reason",
    "The existing workspace deployment pipeline is already adequate",
  ]);
  expect(skipped.kind).toBe("done");

  const deployment = next(project);
  expect(deployment).toMatchObject({
    kind: "run-stage",
    stage: "deployment-execution",
    gate: true,
  });
  const absent = (deployment.consumes_absent ?? []) as Array<{
    path: string;
    expected: boolean;
  }>;
  const expectedByName = new Map(
    absent.map((entry) => [entry.path.split("/").at(-1), entry.expected]),
  );
  expect(expectedByName).toEqual(new Map([
    ["cd-config.md", true],
    ["deployment-strategy.md", true],
    ["environment-inventory.md", true],
    ["test-results.md", false],
  ]));
  expect(existsSync(join(project, ".github", "workflows", "deploy.yml"))).toBe(
    true,
  );

  const stageFile = readFileSync(
    join(project, deployment.stage_file as string),
    "utf-8",
  );
  expect(stageFile).toContain(
    "workspace's existing pipeline is already adequate",
  );
  expect(stageFile).toContain(
    "must inspect and use the real pipeline configuration in the workspace",
  );

  for (const relative of deployment.produces as string[]) {
    writePath(
      join(project, ...relative.split("/")),
      `# ${relative}\n\n## Result\n\nCompleted.\n`,
    );
  }
  const completed = report(project, [
    "--stage",
    "deployment-execution",
    "--result",
    "approved",
    "--user-input",
    "Approve",
  ]);
  expect(completed.kind).toBe("done");
  expect(readFileSync(join(record, "aidlc-state.md"), "utf-8")).toContain(
    "- **Status**: Completed",
  );
}

describe("deployment execution fallback after a conditionally skipped pipeline", () => {
  for (const scope of ["bugfix", "refactor"] as const) {
    test(`${scope} deploys through the existing workspace pipeline without fabricated pipeline artifacts`, () => {
      runSkipFallback(scope);
    }, 30000);
  }
});
