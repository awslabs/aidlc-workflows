// Copilot's terminal on Windows can be cmd.exe, which does not group single
// quotes: there a multiword answer is passed in double quotes, which cmd
// groups and which run no `$(...)`, backtick or `$NAME`. Native cmd.exe only.
import { afterAll, describe, expect, test, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readAllAuditShards } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { cleanupTestProject, createTestProject, seedStateFile } from "../harness/fixtures.ts";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const BUN = process.execPath;
const LOG = join(import.meta.dir, "..", "..", "dist", "claude", ".claude", "tools", "aidlc-log.ts");

const projects: string[] = [];
afterAll(() => {
  for (const p of projects) cleanupTestProject(p);
});

function project(): string {
  const p = createTestProject();
  projects.push(p);
  seedStateFile(p, "state-mid-ideation.md");
  const asked = spawnSync(BUN, [
    LOG, "decision", "--stage", "feasibility", "--decision", "Approve?", "--options", "Approve,Request Changes",
    "--project-dir", p,
  ], { cwd: p, encoding: "utf-8", timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS) });
  expect(asked.status, `${asked.stdout}${asked.stderr}`).toBe(0);
  return p;
}

// `log answer` run the way an agent types it into cmd.exe.
function answerThroughCmd(p: string, details: string): { status: number; out: string } {
  const command = `"${BUN}" "${LOG}" answer --stage feasibility --details ${details} --project-dir "${p}"`;
  const r = spawnSync("cmd.exe", ["/d", "/s", "/c", `"${command}"`], {
    cwd: p,
    encoding: "utf-8",
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    windowsVerbatimArguments: true,
  });
  return { status: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

function recordedDetails(p: string): string | null {
  const block = readAllAuditShards(p).split(/\n---\n/).filter((entry) => entry.includes("**Event**: QUESTION_ANSWERED")).at(-1);
  const line = block?.split("\n").find((entry) => entry.startsWith("**Details**: "));
  return line === undefined ? null : line.slice("**Details**: ".length);
}

describe("t-cmd-answer-quoting: a multiword answer through cmd.exe", () => {
  test("Copilot's skill names the double-quote form for cmd.exe", () => {
    const skill = readFileSync(join(import.meta.dir, "..", "..", "harness", "copilot", "skills", "aidlc", "SKILL.md"), "utf-8");
    expect(skill).toContain("In cmd.exe, which does not group single quotes, put them in double quotes instead");
  });

  test.skipIf(process.platform !== "win32")("in double quotes the whole answer is recorded", () => {
    const p = project();
    const r = answerThroughCmd(p, '"Request Changes"');
    expect(r.status, r.out).toBe(0);
    expect(recordedDetails(p)).toBe("Request Changes");
  });

  test.skipIf(process.platform !== "win32")("single quotes are not grouped by cmd.exe, so that form never records the answer", () => {
    const p = project();
    answerThroughCmd(p, "'Request Changes'");
    expect(recordedDetails(p)).not.toBe("Request Changes");
  });
});
