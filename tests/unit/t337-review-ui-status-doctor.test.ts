// covers: subcommand:aidlc-utility:status, subcommand:aidlc-utility:doctor

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  readServerInfo,
  writeServerInfo,
} from "../../core/tools/aidlc-review-ui-shared.ts";
import {
  cleanupTestProject,
  createTestProject,
  FIXTURES_DIR,
  seedStateFile,
} from "../harness/fixtures.ts";

const BUN = process.execPath;
const REPO_ROOT = join(import.meta.dir, "..", "..");
const UTILITY = join(REPO_ROOT, "core", "tools", "aidlc-utility.ts");
const SHARED = join(REPO_ROOT, "core", "tools", "aidlc-review-ui-shared.ts");
const DIST_DATA = join(REPO_ROOT, "dist", "claude", ".claude", "tools", "data");
const project = createTestProject();
const reviewHome = mkdtempSync(join(tmpdir(), "aidlc-t337-review-"));
const stubFile = join(reviewHome, "health-server.ts");
let daemon: Bun.Subprocess<"ignore", "pipe", "pipe"> | null = null;

seedStateFile(project, join(FIXTURES_DIR, "state-mid-ideation.md"));
writeFileSync(
  stubFile,
  `import { resolve } from "node:path";
import { reviewUiProjectId, writeServerInfo } from ${JSON.stringify(pathToFileURL(SHARED).href)};
const projectDir = resolve(process.argv[2]);
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    const url = new URL(request.url);
    return url.pathname === "/api/health"
      ? Response.json({ ok: true, project_id: reviewUiProjectId(projectDir), pid: process.pid, version: 1 })
      : new Response("not found", { status: 404 });
  },
});
const now = new Date().toISOString();
const token = "t337-token";
writeServerInfo({
  version: 1,
  pid: process.pid,
  host: "127.0.0.1",
  port: server.port,
  url: "http://127.0.0.1:" + server.port + "/",
  token,
  project_dir: projectDir,
  project_id: reviewUiProjectId(projectDir),
  started_at: now,
  heartbeat_at: now,
  idle_minutes: 240,
});
console.log("ready");
`,
  { mode: 0o600 },
);

interface UtilityRun {
  status: number;
  stdout: string;
  stderr: string;
}

function runUtility(command: "status" | "doctor", enabled: boolean): UtilityRun {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    AIDLC_STAGE_GRAPH: join(DIST_DATA, "stage-graph.json"),
    AIDLC_SCOPE_GRID: join(DIST_DATA, "scope-grid.json"),
    AIDLC_REVIEW_HOME: reviewHome,
    AIDLC_HARNESS_DIR: ".claude",
  };
  if (enabled) env.AIDLC_REVIEW_UI = "1";
  else delete env.AIDLC_REVIEW_UI;
  const result = Bun.spawnSync({
    cmd: [BUN, UTILITY, command, "--project-dir", project],
    stdout: "pipe",
    stderr: "pipe",
    env,
    timeout: 10_000,
  });
  return {
    status: result.exitCode,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
  };
}

beforeAll(async () => {
  daemon = Bun.spawn({
    cmd: [BUN, stubFile, project],
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, AIDLC_REVIEW_HOME: reviewHome },
  });
  const reader = daemon.stdout.getReader();
  const first = await reader.read();
  reader.releaseLock();
  expect(first.done).toBe(false);
  expect(new TextDecoder().decode(first.value)).toContain("ready");
});

afterAll(async () => {
  if (daemon) {
    daemon.kill("SIGTERM");
    await daemon.exited;
  }
  cleanupTestProject(project);
  rmSync(reviewHome, { recursive: true, force: true });
});

describe("t337 status and doctor review UI reporting", () => {
  test("status prints a fresh one-time URL only while review UI is enabled", () => {
    const info = readServerInfo(project, { ...process.env, AIDLC_REVIEW_HOME: reviewHome });
    expect(info).not.toBeNull();
    const enabled = runUtility("status", true);
    expect(enabled.status, enabled.stderr).toBe(0);
    expect(enabled.stdout).toContain(`Review UI: ${info!.url}open/`);

    const disabled = runUtility("status", false);
    expect(disabled.status, disabled.stderr).toBe(0);
    expect(disabled.stdout).not.toContain("Review UI:");

    writeServerInfo({
      ...info!,
      heartbeat_at: "2000-01-01T00:00:00.000Z",
    }, { ...process.env, AIDLC_REVIEW_HOME: reviewHome });
    const stale = runUtility("status", true);
    expect(stale.status, stale.stderr).toBe(0);
    expect(stale.stdout).not.toContain("Review UI:");
    writeServerInfo({
      ...info!,
      heartbeat_at: new Date().toISOString(),
    }, { ...process.env, AIDLC_REVIEW_HOME: reviewHome });
  });

  test("doctor reports disabled, alive, and stale states with the recovery command", () => {
    const disabled = runUtility("doctor", false);
    expect(disabled.stdout).toContain("✓  review-ui: disabled (AIDLC_REVIEW_UI unset)");

    const aliveInfo = readServerInfo(project, { ...process.env, AIDLC_REVIEW_HOME: reviewHome });
    expect(aliveInfo).not.toBeNull();
    const alive = runUtility("doctor", true);
    expect(alive.stdout).toContain(`✓  review-ui: alive at ${aliveInfo!.url}`);

    const stale = {
      ...aliveInfo!,
      heartbeat_at: "2000-01-01T00:00:00.000Z",
    };
    writeServerInfo(stale, { ...process.env, AIDLC_REVIEW_HOME: reviewHome });
    const dead = runUtility("doctor", true);
    expect(dead.stdout).toContain(
      "✓  review-ui: enabled but daemon is not alive or reachable (warning)",
    );
    expect(dead.stdout).toContain(
      `bun .claude/tools/aidlc-review-ui.ts serve --project-dir ${project}`,
    );

    writeServerInfo({
      ...stale,
      heartbeat_at: new Date().toISOString(),
    }, { ...process.env, AIDLC_REVIEW_HOME: reviewHome });
  });
});
