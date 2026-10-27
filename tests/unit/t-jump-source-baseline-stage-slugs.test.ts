// covers: subcommand:aidlc-jump:execute
//
// A jump's source baseline is read under the slug of whichever
// workspace_requires stage the jump reaches, not only code-generation's. The
// snapshot is content-addressed, so the one fingerprint the audit records must
// read back under every such stage's slug; a stage whose slug holds no copy
// finds the baseline missing and, under Guard Policy strict, refuses completion.
//
// Mechanism: cli - spawns the shipped tools against a temp project (intent-create,
// then a forward jump), then reads the recorded fingerprint back under each slug
// with the shipped library.

import { afterAll, describe, expect, test, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";
import { cleanupTestProject, setupIntegrationProject } from "../harness/fixtures.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const env: Record<string, string | undefined> = { ...process.env };
for (const key of [
  "AIDLC_SCOPE_MAPPING", "AIDLC_SESSION_OVERRIDE", "AIDLC_SESSION_OVERRIDE_SOURCE",
  "CLAUDE_CODE_SESSION_ID", "CLAUDE_PID", "CODEX_THREAD_ID", "KIRO_SESSION_ID",
]) {
  delete env[key];
}

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) cleanupTestProject(dir);
});

function run(proj: string, tool: string, args: string[]): { status: number; out: string } {
  const res = spawnSync(process.execPath, [join(proj, ".claude", "tools", tool), ...args, "--project-dir", proj], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    encoding: "utf-8",
    env,
    cwd: proj,
  });
  return { status: res.status ?? -1, out: `${res.stdout ?? ""}${res.stderr ?? ""}` };
}

// Runs a script against the project's own library and returns its JSON line.
function inProject(proj: string, script: string): unknown {
  const res = spawnSync(process.execPath, ["-e", script], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    encoding: "utf-8",
    env: { ...env, AIDLC_REPRO_PROJECT: proj },
    cwd: proj,
  });
  expect(res.status, `${res.stdout}${res.stderr}`).toBe(0);
  return JSON.parse((res.stdout ?? "").trim().split("\n").pop() ?? "null");
}

const LIB = (proj: string): string => JSON.stringify(join(proj, ".claude", "tools", "aidlc-lib.ts"));

describe("the jump baseline reads back under every workspace_requires stage", () => {
  test("workspaceBaselineStageSlugs: workspace_requires stages from the target on, code-generation always", () => {
    const proj = setupIntegrationProject({ noAidlcDocs: true, stripEnvScope: true });
    tempDirs.push(proj);
    const slugs = inProject(proj, `
      const lib = await import(${LIB(proj)});
      const workspace = lib.loadStageGraph().filter((s) => s.workspace_requires === true).map((s) => s.slug);
      console.log(JSON.stringify({
        all: lib.workspaceBaselineStageSlugs(),
        early: lib.workspaceBaselineStageSlugs("requirements-analysis"),
        late: lib.workspaceBaselineStageSlugs("deployment-pipeline"),
        workspace,
      }));
    `) as { all: string[]; early: string[]; late: string[]; workspace: string[] };
    expect(slugs.all).toEqual(expect.arrayContaining(slugs.workspace));
    expect(slugs.early).toEqual(expect.arrayContaining(slugs.workspace));
    expect(slugs.late).toContain("code-generation");
    for (const slug of [...slugs.all, ...slugs.early, ...slugs.late]) {
      expect(slugs.workspace.concat("code-generation")).toContain(slug);
    }
  });

  test("a jump's recorded fingerprint reads back under each slug it was written for", () => {
    const proj = setupIntegrationProject({ noAidlcDocs: true, stripEnvScope: true });
    tempDirs.push(proj);
    const created = run(proj, "aidlc-utility.ts", ["intent-create", "--scope", "feature", "--arguments", "x", "--label", "baseline"]);
    expect(created.status, created.out).toBe(0);
    const jumped = run(proj, "aidlc-jump.ts", ["execute", "--target", "requirements-analysis", "--direction", "forward", "--scope", "feature"]);
    expect(jumped.status, jumped.out).toBe(0);
    const read = inProject(proj, `
      const lib = await import(${LIB(proj)});
      const pd = process.env.AIDLC_REPRO_PROJECT;
      const fp = /\\*\\*Event\\*\\*: STAGE_JUMPED[\\s\\S]*?\\*\\*Source Baseline\\*\\*: (sha256:[0-9a-f]{64})/.exec(lib.readAllAuditShards(pd))?.[1];
      const out = {};
      for (const slug of lib.workspaceBaselineStageSlugs("requirements-analysis")) {
        out[slug] = fp !== undefined && lib.readBaselineSourceSnapshot(pd, slug, fp) !== null;
      }
      console.log(JSON.stringify({ fp: fp ?? null, out }));
    `) as { fp: string | null; out: Record<string, boolean> };
    expect(read.fp).not.toBeNull();
    expect(Object.keys(read.out)).toContain("code-generation");
    for (const [slug, found] of Object.entries(read.out)) expect(found, slug).toBe(true);
  });
});
