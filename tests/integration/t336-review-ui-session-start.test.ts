// covers: hook:aidlc-session-start, function:ensureReviewUiDaemon

import { afterAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  readServerInfo,
  serverInfoPath,
} from "../../core/tools/aidlc-review-ui-shared.ts";
import {
  cleanupTestProject,
  createTestProject,
  FIXTURES_DIR,
  seedStateFile,
} from "../harness/fixtures.ts";

const BUN = process.execPath;
const REPO_ROOT = join(import.meta.dir, "..", "..");
const HOOK = join(REPO_ROOT, "core", "hooks", "aidlc-session-start.ts");
const SHARED = join(REPO_ROOT, "core", "tools", "aidlc-review-ui-shared.ts");
const HARNESS_DIR = ".review-harness";

const project = createTestProject();
const reviewHome = mkdtempSync(join(tmpdir(), "aidlc-t336-review-"));
const disabledHome = mkdtempSync(join(tmpdir(), "aidlc-t336-disabled-"));
let daemonPid: number | null = null;

seedStateFile(project, join(FIXTURES_DIR, "state-mid-ideation.md"));
const toolsDir = join(project, HARNESS_DIR, "tools");
mkdirSync(toolsDir, { recursive: true });
writeFileSync(
  join(toolsDir, "aidlc-review-ui.ts"),
  `import { resolve } from "node:path";
import { reviewUiProjectId, writeServerInfo } from ${JSON.stringify(pathToFileURL(SHARED).href)};

const projectFlag = process.argv.indexOf("--project-dir");
const projectDir = resolve(process.argv[projectFlag + 1]);
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch() { return new Response("ok"); },
});
const now = new Date().toISOString();
const token = "t336-token";
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
`,
  { mode: 0o600 },
);

interface HookRun {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function runHook(enabled: boolean, home: string): HookRun {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CLAUDE_PROJECT_DIR: project,
    AIDLC_HARNESS_DIR: HARNESS_DIR,
    AIDLC_REVIEW_HOME: home,
    AIDLC_REVIEW_OPEN: "0",
  };
  if (enabled) env.AIDLC_REVIEW_UI = "1";
  else delete env.AIDLC_REVIEW_UI;

  const result = Bun.spawnSync({
    cmd: [BUN, HOOK],
    stdin: new TextEncoder().encode('{"source":"startup"}'),
    stdout: "pipe",
    stderr: "pipe",
    env,
    timeout: 5_000,
  });
  return {
    exitCode: result.exitCode,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
  };
}

function additionalContext(stdout: string): string {
  const parsed: unknown = JSON.parse(stdout);
  if (!parsed || typeof parsed !== "object" || !("additionalContext" in parsed) ||
    typeof parsed.additionalContext !== "string") {
    throw new Error("hook output omitted additionalContext");
  }
  return parsed.additionalContext;
}

afterAll(() => {
  const info = readServerInfo(project, { ...process.env, AIDLC_REVIEW_HOME: reviewHome });
  daemonPid = info?.pid ?? daemonPid;
  if (daemonPid) {
    try {
      process.kill(daemonPid, "SIGTERM");
    } catch {
      // The daemon may already have exited; cleanup remains idempotent.
    }
  }
  cleanupTestProject(project);
  rmSync(reviewHome, { recursive: true, force: true });
  rmSync(disabledHome, { recursive: true, force: true });
});

describe("t336 review UI session-start lifecycle", () => {
  test("env-gated hook spawns once, reuses the daemon, and preserves disabled output", () => {
    const baseline = runHook(false, disabledHome);
    expect(baseline.exitCode).toBe(0);
    expect(baseline.stderr).toBe("");
    expect(existsSync(serverInfoPath(project, {
      ...process.env,
      AIDLC_REVIEW_HOME: disabledHome,
    }))).toBe(false);

    const first = runHook(true, reviewHome);
    expect(first.exitCode).toBe(baseline.exitCode);
    expect(first.stderr).toBe("");
    const firstInfo = readServerInfo(project, {
      ...process.env,
      AIDLC_REVIEW_HOME: reviewHome,
    });
    expect(firstInfo).not.toBeNull();
    const spawnedPid = firstInfo!.pid;
    daemonPid = spawnedPid;
    const firstContext = additionalContext(first.stdout);
    expect(firstContext).toStartWith(
      `${additionalContext(baseline.stdout)}\nReview UI: ${firstInfo!.url}open/`,
    );
    expect(firstContext.slice(-32)).toMatch(/^[0-9a-f]{32}$/);
    expect(() => process.kill(spawnedPid, 0)).not.toThrow();

    const second = runHook(true, reviewHome);
    expect(second.exitCode).toBe(0);
    expect(readServerInfo(project, {
      ...process.env,
      AIDLC_REVIEW_HOME: reviewHome,
    })?.pid).toBe(daemonPid);

    const disabled = runHook(false, disabledHome);
    expect(disabled.exitCode).toBe(0);
    expect(disabled.stdout).toBe(baseline.stdout);
    expect(existsSync(serverInfoPath(project, {
      ...process.env,
      AIDLC_REVIEW_HOME: disabledHome,
    }))).toBe(false);
  });
});
