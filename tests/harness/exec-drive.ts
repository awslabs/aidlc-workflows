// Headless CLI project setup and invocation helpers shared by live e2e tests
// and plugin tests. These preserve the command lines and scratch-project
// shapes proven by the harness-specific status journeys.

import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO_ROOT } from "./fixtures.ts";

const CODEX_DIST = join(REPO_ROOT, "dist", "codex");
const COPILOT_DIST = join(REPO_ROOT, "dist", "copilot");
const OPENCODE_DIST = join(REPO_ROOT, "dist", "opencode");
const CURSOR_DIST = join(REPO_ROOT, "dist", "cursor");

const CODEX_BIN = process.env.AIDLC_CODEX_BIN ?? "codex";
const COPILOT_BIN = process.env.AIDLC_COPILOT_BIN ?? "copilot";
const OPENCODE_BIN = process.env.AIDLC_OPENCODE_BIN ?? "opencode";
const CURSOR_BIN = process.env.AIDLC_CURSOR_BIN ?? "agent";

const AWS_PROFILE = process.env.AIDLC_CODEX_AWS_PROFILE ?? "codex";
const AWS_REGION = process.env.AIDLC_CODEX_AWS_REGION ?? "us-east-2";
const OPENCODE_MODEL =
  process.env.AIDLC_OPENCODE_MODEL ??
  "amazon-bedrock/global.anthropic.claude-sonnet-4-6";
// "auto" is the one model every Cursor plan can use (Free rejects all named
// models with rc 0). Override for repeatable named-model runs.
const CURSOR_MODEL = process.env.AIDLC_CURSOR_MODEL ?? "auto";

const TIMEOUT_S = Number.parseInt(process.env.AIDLC_TEST_TIMEOUT ?? "600", 10);
const TEST_TIMEOUT_MS = (Number.isFinite(TIMEOUT_S) ? TIMEOUT_S : 600) * 1000;

function initializeGit(projectDir: string): void {
  for (const args of [
    ["init", "-q"],
    ["add", "-A"],
    ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "install"],
  ]) {
    const result = spawnSync("git", args, {
      cwd: projectDir,
      encoding: "utf-8",
    });
    if (result.status !== 0) {
      throw new Error(`git ${args[0]} failed: ${result.stderr}`);
    }
  }
}

export interface CodexProject {
  proj: string;
  home: string;
  root: string;
}

// A scratch install: dist/codex copied verbatim, git-initialized (project
// hooks.json discovery requires a git repo), a scratch CODEX_HOME with Bedrock
// provider + project trust + the trust pre-seed from `package.ts codex trust`
// so hooks fire with zero TUI passes.
export function setupCodexProject(): CodexProject {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "codex-exec-")));
  const proj = join(root, "proj");
  const home = join(root, "codex-home");
  mkdirSync(home, { recursive: true });
  cpSync(join(CODEX_DIST, ".codex"), join(proj, ".codex"), {
    recursive: true,
  });
  cpSync(join(CODEX_DIST, ".agents"), join(proj, ".agents"), {
    recursive: true,
  });
  cpSync(join(CODEX_DIST, "AGENTS.md"), join(proj, "AGENTS.md"));
  initializeGit(proj);
  const trust = spawnSync(
    "bun",
    [
      join(REPO_ROOT, "scripts", "package.ts"),
      "codex",
      "trust",
      "--project",
      proj,
    ],
    { encoding: "utf-8", cwd: REPO_ROOT },
  );
  if (trust.status !== 0) {
    throw new Error(`trust emit failed: ${trust.stderr}`);
  }
  writeFileSync(
    join(home, "config.toml"),
    [
      `model = "openai.gpt-5.5"`,
      `model_provider = "amazon-bedrock"`,
      `model_context_window = 1000000`,
      `model_reasoning_effort = "low"`,
      ``,
      `[model_providers.amazon-bedrock.aws]`,
      `profile = "${AWS_PROFILE}"`,
      `region = "${AWS_REGION}"`,
      ``,
      `[shell_environment_policy]`,
      `set = { AIDLC_RULES_DIR = ".codex/aidlc-rules" }`,
      ``,
      `[projects."${proj}"]`,
      `trust_level = "trusted"`,
      ``,
      trust.stdout,
    ].join("\n"),
    "utf-8",
  );
  return { proj, home, root };
}

export interface ExecResult {
  rc: number;
  out: string;
}

export function execCodex(
  proj: string,
  home: string,
  prompt: string,
): ExecResult {
  const result = spawnSync(CODEX_BIN, ["exec", prompt], {
    cwd: proj,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, CODEX_HOME: home },
    timeout: TEST_TIMEOUT_MS,
  });
  return {
    rc: result.status ?? -1,
    out: `${result.stdout ?? ""}\n${result.stderr ?? ""}`,
  };
}

// A scratch install: dist/copilot copied verbatim (dotfiles included: the
// engine at .aidlc/, the shell at .github/), then git-initialized (Copilot
// resolves repo context from the git root).
export function setupCopilotProject(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "copilot-exec-")));
  const proj = join(root, "proj");
  cpSync(COPILOT_DIST, proj, { recursive: true });
  initializeGit(proj);
  return proj;
}

// The /aidlc text rides the prompt (slash-skill invocation); --allow-all-tools
// lets the engine's read-only bun calls run unprompted in -p mode. --no-remote
// keeps the session off GitHub's session sync.
export function runCopilot(proj: string, args: string): ExecResult {
  const result = spawnSync(
    COPILOT_BIN,
    ["-p", `/aidlc ${args}`, "-s", "--no-remote", "--allow-all-tools"],
    {
      cwd: proj,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PWD: proj },
      timeout: TEST_TIMEOUT_MS,
    },
  );
  return {
    rc: result.status ?? -1,
    out: `${result.stdout ?? ""}\n${result.stderr ?? ""}`,
  };
}

export interface OpencodeProject {
  proj: string;
  root: string;
}

// A scratch install: dist/opencode copied verbatim (dotfiles included: the
// engine at .aidlc/, the native shell at .opencode/, the project opencode.json
// whose skills.paths + permission allowlist the status journey exercises),
// then git-initialized (opencode resolves the project root by walking to the
// worktree root).
export function setupOpencodeProject(): OpencodeProject {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "opencode-run-")));
  const proj = join(root, "proj");
  cpSync(OPENCODE_DIST, proj, { recursive: true });
  initializeGit(proj);
  return { proj, root };
}

// `--command aidlc` invokes the shipped .opencode/command/aidlc.md; the
// message tokens after `--` land in its $ARGUMENTS. No --auto: an unexpected
// permission ask auto-rejects and fails the asserts (the honest signal).
//
// PWD must be pinned to the project: spawnSync's `cwd` does not rewrite the
// inherited PWD env var, and opencode trusts PWD over the real cwd when
// resolving its instance directory - with the runner's checkout leaking
// through, `opencode run` dies with "Unexpected server error"
// (live-reproduced on 1.17.18).
export function runOpencode(proj: string, args: string[]): ExecResult {
  const result = spawnSync(
    OPENCODE_BIN,
    ["run", "--command", "aidlc", "-m", OPENCODE_MODEL, "--", ...args],
    {
      cwd: proj,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PWD: proj },
      timeout: TEST_TIMEOUT_MS,
    },
  );
  return {
    rc: result.status ?? -1,
    out: `${result.stdout ?? ""}\n${result.stderr ?? ""}`,
  };
}

export interface CursorProject {
  proj: string;
  root: string;
}

// A scratch install: dist/cursor copied verbatim (dotfiles included: the
// engine + native surfaces at .cursor/, AGENTS.md and the aidlc/ memory tree
// at the root), then git-initialized (Cursor resolves the workspace root by
// walking to the repo root).
export function setupCursorProject(): CursorProject {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cursor-run-")));
  const proj = join(root, "proj");
  cpSync(CURSOR_DIST, proj, { recursive: true });
  initializeGit(proj);
  return { proj, root };
}

// `agent -p "<prompt>"` invokes the shipped .cursor/skills/aidlc skill with
// the flag text forwarded inline (live-verified forwarding shape). --trust
// skips the workspace-trust prompt on the scratch dir. No -f/--force: an
// unexpected permission ask auto-rejects and fails the asserts (the honest
// signal).
export function runCursor(proj: string, promptText: string): ExecResult {
  const result = spawnSync(
    CURSOR_BIN,
    [
      "-p",
      promptText,
      "--trust",
      "--model",
      CURSOR_MODEL,
      "--output-format",
      "text",
    ],
    {
      cwd: proj,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PWD: proj },
      timeout: TEST_TIMEOUT_MS,
    },
  );
  return {
    rc: result.status ?? -1,
    out: `${result.stdout ?? ""}\n${result.stderr ?? ""}`,
  };
}
