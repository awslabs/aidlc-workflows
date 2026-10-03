// covers: hook:aidlc-session-start, hook:aidlc-record-human-turn, function:resolveProjectDirFromHook
// A compiled engine loads its hooks and adapters from the runtime payload
// beside the executable. Kiro IDE and Kiro CLI fire them from the project
// directory and set no project variable, so the project must come from that
// directory:
// state written through a payload path lands in the install and never in the
// project, and the approval gate never sees the human's turn. Claude names its
// project in CLAUDE_PROJECT_DIR, which must keep winning over the directory.
import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";
import { afterAll, beforeAll, describe, expect, test, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { auditShardName } from "../../core/tools/aidlc-lib.ts";
import {
  DEFAULT_RECORD_DIR,
  DEFAULT_SPACE,
  intentsDirOf,
  REPO_ROOT,
  seededRecordDir,
  seededStateFile,
} from "../harness/fixtures.ts";
import { testGuardEnvironment } from "../harness/runner-profile.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const scratchRoot = process.platform === "win32"
  ? join(process.env.SystemRoot || "C:\\Windows", "Temp")
  : tmpdir();
const runtimeRoot = join(REPO_ROOT, "dist-release");
let scratch: string;
let binary: string;
let payload: string;

beforeAll(() => {
  mkdirSync(scratchRoot, { recursive: true });
  scratch = mkdtempSync(join(scratchRoot, "aidlc-nh-"));
  const install = join(scratch, "install");
  mkdirSync(install);
  binary = join(install, process.platform === "win32" ? "aidlc.exe" : "aidlc");
  const result = spawnSync(process.execPath, [
    "build", join(runtimeRoot, "claude", ".claude", "tools", "aidlc.ts"),
    "--compile", "--outfile", binary,
  ], { encoding: "utf-8", timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS) });
  expect(result.status, result.stdout + result.stderr).toBe(0);
  // Copy rather than link the payload, as an install does, so a write into it
  // shows up here and never in the checkout's generated runtime.
  payload = join(install, "runtime");
  for (const distribution of ["claude", "kiro", "kiro-ide"]) {
    cpSync(join(runtimeRoot, distribution), join(payload, distribution), { recursive: true });
  }
}, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

afterAll(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

function fixture(distribution: "claude" | "kiro" | "kiro-ide" = "kiro-ide"): string {
  const project = mkdtempSync(join(scratch, "project-"));
  const harnessDir = distribution === "claude" ? ".claude" : ".kiro";
  cpSync(join(runtimeRoot, distribution, harnessDir), join(project, harnessDir), { recursive: true });
  cpSync(
    join(runtimeRoot, distribution, harnessDir, "tools", "data", "memory-seed"),
    join(project, "aidlc", "spaces", DEFAULT_SPACE, "memory"),
    { recursive: true },
  );
  const intents = intentsDirOf(project, DEFAULT_SPACE);
  mkdirSync(seededRecordDir(project), { recursive: true });
  writeFileSync(join(project, "aidlc", "active-space"), `${DEFAULT_SPACE}\n`);
  writeFileSync(join(intents, "active-intent"), `${DEFAULT_RECORD_DIR}\n`);
  writeFileSync(join(intents, "intents.json"), JSON.stringify([{
    uuid: "00000000-0000-7000-8000-000000000001",
    slug: DEFAULT_RECORD_DIR.replace(/-[0-9a-f]+$/, ""),
    status: "in-flight",
  }]));
  writeFileSync(seededStateFile(project), readFileSync(
    join(REPO_ROOT, "tests", "fixtures", "state-brownfield-feature.md"), "utf-8",
  ).replace(/^- \*\*Current Stage\*\*:.*$/m, "- **Current Stage**: requirements-analysis"));
  writeFileSync(join(project, "aidlc", ".aidlc-clone-id"), "nativehookroottest\n", "utf-8");
  const ledger = join(seededRecordDir(project), "audit", auditShardName(project));
  mkdirSync(dirname(ledger), { recursive: true });
  writeFileSync(ledger, "# AI-DLC Audit Log\n", "utf-8");
  return project;
}

// Kiro IDE launches hook commands in the project directory with none of the
// project or runtime variables a test runner or another host may carry.
function hostEnvironment(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env = testGuardEnvironment(process.env, "production");
  for (const key of Object.keys(env)) {
    if (
      /^(?:AIDLC|CLAUDE|KIRO|CURSOR)_PROJECT_DIR$/i.test(key) ||
      /^AIDLC_(?:HARNESS_DIR|HARNESS_NAME|RUNTIME_ROOT|RUNTIME_HARNESS_ROOT|COMPILED_EXECUTABLE)$/i
        .test(key)
    ) {
      delete env[key];
    }
  }
  return { ...env, AIDLC_UNATTENDED: "0", VSCODE_PID: "native-hook-root-test", ...extra };
}

function run(
  project: string,
  args: string[],
  input: object,
  extra?: Record<string, string>,
  cwd = project,
) {
  const result = spawnSync(resolve(binary), args, {
    cwd,
    input: JSON.stringify(input),
    encoding: "utf-8",
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    env: hostEnvironment(extra),
  });
  return { code: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function snapshot(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else {
        const digest = createHash("sha256").update(readFileSync(path)).digest("hex");
        out.push(`${relative(root, path).replace(/\\/g, "/")} ${digest}`);
      }
    }
  };
  walk(root);
  return out.sort();
}

function auditRows(project: string): string {
  const audit = join(seededRecordDir(project), "audit");
  return readdirSync(audit).filter((name) => name.endsWith(".md"))
    .map((name) => readFileSync(join(audit, name), "utf-8")).join("\n");
}

const health = ".aidlc-engine/hooks-health/session-start.last";

function wroteHealth(project: string): boolean {
  return existsSync(join(seededRecordDir(project), health)) ||
    existsSync(join(dirname(seededRecordDir(project)), health));
}

const sessionStart = {
  hook_event_name: "SessionStart",
  session_id: "native-hook-root-test",
};

const prompt = {
  hook_event_name: "UserPromptSubmit",
  session_id: "native-hook-root-test",
  prompt: "Continue with the requirements",
};

describe("compiled hook routes resolve the project from the host", () => {
  test("a hook routed from the project directory writes the project, not the payload", () => {
    const project = fixture();
    const before = snapshot(payload);
    const result = run(project, ["engine", "hook", "session-start"], sessionStart);
    expect(result.code, result.stderr).toBe(0);
    expect(wroteHealth(project)).toBe(true);
    expect(snapshot(payload)).toEqual(before);
  });

  test("a Claude hook writes the project Claude names, from any directory", () => {
    // Claude keeps CLAUDE_PROJECT_DIR on its hooks after a command changes the
    // working directory, so the variable decides over the launch directory.
    const project = fixture("claude");
    const elsewhere = mkdtempSync(join(scratch, "elsewhere-"));
    const before = snapshot(payload);
    const result = run(
      project,
      ["engine", "hook", "session-start"],
      sessionStart,
      { CLAUDE_PROJECT_DIR: project },
      elsewhere,
    );
    expect(result.code, result.stderr).toBe(0);
    expect(wroteHealth(project)).toBe(true);
    expect(readdirSync(elsewhere)).toEqual([]);
    expect(snapshot(payload)).toEqual(before);
  });

  test("a Claude hook launched with no project variable writes its directory", () => {
    const project = fixture("claude");
    const before = snapshot(payload);
    const result = run(project, ["engine", "hook", "session-start"], sessionStart);
    expect(result.code, result.stderr).toBe(0);
    expect(wroteHealth(project)).toBe(true);
    expect(snapshot(payload)).toEqual(before);
  });

  test("the Kiro IDE adapter records the human turn in the project audit", () => {
    const project = fixture();
    const before = snapshot(payload);
    const result = run(project, ["engine", "adapter", "kiro-ide", "record-human-turn"], prompt);
    expect(result.code, result.stderr).toBe(0);
    expect(auditRows(project)).toContain("HUMAN_TURN");
    expect(snapshot(payload)).toEqual(before);
  });

  test("the Kiro CLI adapter records the human turn in the project audit", () => {
    // Issue #1532: the adapter found the project from the payload cwd, but the
    // core hook it spawned took its project from its own payload path, so
    // every gate answer was refused as having no human reply.
    const project = fixture("kiro");
    const before = snapshot(payload);
    const result = run(project, ["engine", "adapter", "kiro", "verb-intercept"], {
      hook_event_name: "userPromptSubmit",
      cwd: project,
      session_id: "native-hook-root-test",
      prompt: "Continue with the requirements",
    });
    expect(result.code, result.stderr).toBe(0);
    expect(auditRows(project)).toContain("HUMAN_TURN");
    expect(snapshot(payload)).toEqual(before);
  });

  test("a payload hook imported without a pinned project still resolves the project", () => {
    // The human-turn authority route imports the packaged hook directly, so the
    // hook's own resolution must refuse a root inside the payload.
    const project = fixture();
    const before = snapshot(payload);
    const hook = join(payload, "kiro-ide", ".kiro", "hooks", "aidlc-record-human-turn.ts");
    const result = run(project, ["--internal-aidlc-record-human-turn", hook], prompt, {
      AIDLC_INTERNAL_HUMAN_TURN_TOKEN: "native-hook-root-test",
    });
    expect(result.code, result.stderr).toBe(0);
    expect(auditRows(project)).toContain("HUMAN_TURN");
    expect(snapshot(payload)).toEqual(before);
  });
});
