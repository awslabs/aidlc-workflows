// covers: function:readNextTokens, function:nextLineFlags, function:nextFlagLacksValue, function:beforeDelimiter, function:readOrchestratorLauncherOptions, function:isReadOnlyNextArgv, function:classifyTerminalCommand, function:isEngineEngagementSegment, function:parseNextFlags
//
// One reading of which tokens on a `next` line are the engine's own and which
// are the person's (readNextTokens, readOrchestratorLauncherOptions in
// aidlc-lib.ts). The engine's parser and every seam that reads a line before
// the engine does ask it, so a word of theirs that looks like a flag (behind
// the `--` mark, or among their own words) is never read as one by a seam, and
// a flag's value is never read as a flag of its own.

import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyTerminalCommand,
  isEngineEngagementSegment,
  isReadOnlyNextArgv,
  readNextLine,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { parseNextFlags } from "../../dist/claude/.claude/tools/aidlc-orchestrate.ts";
import { REPO_ROOT, toPortablePath } from "../harness/fixtures.ts";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const projects: string[] = [];
afterAll(() => {
  for (const proj of projects) rmSync(proj, { recursive: true, force: true });
});

// An installed project, the reply of one `next` there, and the requests it kept.
// `lead` goes in front of `next`, with `{proj}` naming the project.
function nextIn(args: string[], lead: string[] = []): { message: string; kept: string[] } {
  let proj = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "aidlc-next-reading-"));
  try {
    proj = realpathSync(proj);
  } catch {
    // Keep the temp path as created.
  }
  proj = toPortablePath(proj);
  projects.push(proj);
  cpSync(join(REPO_ROOT, "dist", "opencode"), proj, { recursive: true });
  spawnSync("git", ["init", "-q"], { cwd: proj });
  const env: NodeJS.ProcessEnv = { ...process.env, AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "1" };
  for (const key of ["AIDLC_PROJECT_DIR", "CLAUDE_PROJECT_DIR", "AIDLC_SESSION_OVERRIDE", "AIDLC_UNATTENDED"]) delete env[key];
  const r = spawnSync(process.execPath, [join(proj, ".aidlc", "tools", "aidlc-orchestrate.ts"), ...lead.map((token) => token.replace("{proj}", proj)), "next", ...args], {
    cwd: proj,
    encoding: "utf-8",
    env,
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  expect(r.status, r.stderr).toBe(0);
  const message = String((JSON.parse(r.stdout) as { message?: string }).message ?? "");
  const dir = join(proj, "aidlc", ".aidlc-sessions", "questions");
  const kept = existsSync(dir)
    ? readdirSync(dir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => (JSON.parse(readFileSync(join(dir, name), "utf-8")) as { text: string }).text)
    : [];
  return { message, kept };
}

describe("a word behind the `--` mark is the person's, for every reader of the line", () => {
  test("`--config` behind the mark does not make a stage-plan change a read-only command", () => {
    expect(isReadOnlyNextArgv(["--skip", "user-stories", "--", "--config"])).toBe(false);
    expect(isEngineEngagementSegment("aidlc engine orchestrate next --skip user-stories -- --config")).toBe(true);
    // The engine's own `--config` in front of the mark still is.
    expect(isReadOnlyNextArgv(["--config"])).toBe(true);
  });

  test("a valued flag never takes the mark as its value, so the words behind it stay theirs", () => {
    const parsed = parseNextFlags(["--scope", "--", "--resume"]);
    expect(parsed.resume).toBeUndefined();
    expect(parsed.scope).toBeUndefined();
    expect(parsed.intent).toBe("--resume");
    expect(readNextLine(["--scope", "--", "--resume"])).toEqual({ kind: "untaken-flag", token: "--scope" });
  });

  test("`intent list` reads no option from the words behind the mark", () => {
    expect(parseNextFlags(["intent", "list", "--", "--all"]).workspaceCommand).toEqual(
      { kind: "list", noun: "intent", json: false },
    );
    expect(classifyTerminalCommand(["intent", "list", "--", "--all"])?.args).toBeUndefined();
    expect(parseNextFlags(["intent", "list", "--all"]).workspaceCommand).toEqual(
      { kind: "list", noun: "intent", json: false, all: true },
    );
  });

});

describe("a flag's value is never read as a flag of its own", () => {
  test("`--report --status` reports from a file named `--status`, for the engine and the seams alike", () => {
    expect(parseNextFlags(["--report", "--status"]).report).toBe("--status");
    expect(classifyTerminalCommand(["--report", "--status"])).toBeNull();
    expect(isReadOnlyNextArgv(["--report", "--status"])).toBe(false);
    expect(classifyTerminalCommand(["--status"])).toEqual({ subcommand: "status", source: "read-only-flag" });
  });

  test("a flag left without its value is the engine's refusal, so no seam runs the utility after it", () => {
    // The engine answers `--depth --status` with the `--depth` refusal first.
    expect(parseNextFlags(["--depth", "--status"]).parseError).toContain("--depth requires");
    expect(classifyTerminalCommand(["--depth", "--status"])).toBeNull();
    expect(classifyTerminalCommand(["--review", "--doctor"])).toBeNull();
    // `--propose` with no plan is the agent's own step, which the engine gives first too.
    expect(parseNextFlags(["--propose", "--status"]).propose).toBe("");
    expect(classifyTerminalCommand(["--propose", "--status"])).toBeNull();
    expect(classifyTerminalCommand(["--depth", "minimal", "--status"]))
      .toEqual({ subcommand: "status", source: "read-only-flag" });
  });
});

describe("the launcher's options are taken the one way the engine takes them", () => {
  test("an attempt id among the person's own words stays two of their words", () => {
    // Read as theirs, the flag-shaped token is one `next` does not take: the
    // agent is told so and runs it again, and none of their words is dropped.
    expect(nextIn(["fix", "the", "--aidlc-attempt-id", "x", "handling"]).message)
      .toContain("`next` does not take `--aidlc-attempt-id x`");
    // In front of their words it is the launcher's, as every caller puts it.
    expect(nextIn(["--aidlc-attempt-id", "x", "fix", "the", "handling"]).kept).toEqual(["fix the handling"]);
  });

  test("a folder among the person's words is theirs, with this project's folder named in front", () => {
    const elsewhere = join(process.env.TMPDIR || tmpdir(), "aidlc-next-reading-elsewhere");
    expect(nextIn(["fix", "it", "--project-dir", elsewhere], ["--project-dir", "{proj}"]).message)
      .toContain(`\`next\` does not take \`--project-dir ${elsewhere}\``);
  });

  test("`--project-dir` never takes the mark as its folder, so the words behind it keep the line engaged", () => {
    expect(isEngineEngagementSegment("aidlc engine orchestrate next add --project-dir -- --config")).toBe(true);
  });
});
