import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  reviewUiProjectId,
  writeServerInfo,
} from "../../core/tools/aidlc-review-ui-shared.ts";
import {
  cleanupTestProject,
  createTestProject,
  FIXTURES_DIR,
  runOrchestrateNext,
  seedAidlcMemory,
  seedStateFile,
} from "../harness/fixtures.ts";

const ROOT = join(import.meta.dir, "..", "..");
const ORCHESTRATE = join(ROOT, "core", "tools", "aidlc-orchestrate.ts");
const projects: string[] = [];
const homes: string[] = [];

afterAll(() => {
  for (const project of projects) cleanupTestProject(project);
  for (const home of homes) rmSync(home, { recursive: true, force: true });
});

function fixture(): { project: string; env: NodeJS.ProcessEnv } {
  const project = createTestProject();
  const home = mkdtempSync(join(tmpdir(), "aidlc-t356-"));
  projects.push(project);
  homes.push(home);
  seedAidlcMemory(project);
  seedStateFile(project, join(FIXTURES_DIR, "state-mid-ideation.md"));
  return {
    project,
    env: {
      ...process.env,
      AIDLC_RUNTIME_HARNESS_ROOT: join(ROOT, "dist", "claude", ".claude"),
      AIDLC_REVIEW_UI: "1",
      AIDLC_REVIEW_HOME: home,
    },
  };
}

describe("guide protocol module directive derivation", () => {
  test("live review UI adds guide beside existing modules", () => {
    const { project, env } = fixture();
    const now = new Date().toISOString();
    writeServerInfo({
      version: 1,
      pid: process.pid,
      host: "127.0.0.1",
      port: 43156,
      url: "http://127.0.0.1:43156/",
      token: "t356-token",
      project_dir: project,
      project_id: reviewUiProjectId(project),
      started_at: now,
      heartbeat_at: now,
      idle_minutes: 240,
    }, env);

    const directive = runOrchestrateNext(ORCHESTRATE, project, [], { env }).directive;
    expect(directive?.review_ui).toEqual({ origin: "http://127.0.0.1:43156/" });
    expect(directive?.protocol_modules).toContain("guide");
  });

  test("no live daemon leaves guide and review_ui absent", () => {
    const { project, env } = fixture();
    const directive = runOrchestrateNext(ORCHESTRATE, project, [], { env }).directive;
    expect(directive?.review_ui).toBeUndefined();
    expect(directive?.protocol_modules ?? []).not.toContain("guide");
  });
});
