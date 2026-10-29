// covers: subcommand:aidlc-unit:gate
//
// A Unit merge decision in the person's own words can come in a request file
// AI-DLC wrote, so no shell reads them on the way: on Claude Code for Windows,
// Git Bash read the PowerShell form of "Don't merge, it's unsafe!" as "Dont
// merge, its unsafe!". The gate records the file's words exactly and spends the
// file; passing both --user-input and --request-file is refused before anything
// is recorded. Pin's own gate commands name the file for the person's reply,
// which the agent writes with its file tool, and make its folder. The commands
// run through bash (Git Bash on Windows).
import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readUnitMergeTransaction } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { gitBashPath, gitBashSkipReason } from "../harness/git-bash.ts";
import { UNIT, cleanupTempDirs, makeSeed, prepareCandidate, replyAfterPin, runMergeTool } from "../harness/team-unit-merge.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);
afterEach(cleanupTempDirs);

const WORDS = "Don't merge, it's unsafe! It costs $0.00 \"now\"";

const skip = gitBashSkipReason();
describe("a Unit merge decision in the person's words, from a request file", () => {
  test.skipIf(skip !== null)("is recorded exactly through bash, and the file is spent", () => {
    const { seed, remote } = makeSeed();
    prepareCandidate(remote, "alpha", "gate-words-file");
    const pin = runMergeTool(UNIT, ["pin", "alpha"], seed);
    expect(pin.status, pin.out).toBe(0);
    replyAfterPin(seed, "alpha");
    const folder = join(seed, "aidlc", ".aidlc-request-text");
    mkdirSync(folder, { recursive: true });
    const file = join(folder, "gate-alpha.txt");
    writeFileSync(file, WORDS, "utf-8");
    const quote = (value: string) => `'${value}'`;
    const both = runMergeTool(UNIT, [
      "gate", "alpha", "--decision", "reject", "--user-input", "Reject", "--request-file", "aidlc/.aidlc-request-text/gate-alpha.txt",
    ], seed);
    expect(both.status).not.toBe(0);
    expect(both.out).toContain("Pass either --user-input or --request-file, not both.");
    expect(existsSync(file)).toBe(true);
    const run = spawnSync(process.platform === "win32" ? gitBashPath() : "bash", [
      "-c",
      `${[process.execPath, UNIT].map(quote).join(" ")} gate alpha --decision reject ` +
        "--request-file aidlc/.aidlc-request-text/gate-alpha.txt",
    ], {
      cwd: seed,
      encoding: "utf-8",
      env: { ...process.env, AIDLC_PROJECT_DIR: seed },
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    });
    expect(run.status, `${run.stdout}${run.stderr}`).toBe(0);
    expect(readUnitMergeTransaction(seed, "alpha")?.user_input).toBe(WORDS);
    expect(existsSync(file)).toBe(false);
  });

  test.skipIf(skip !== null)("pin's reject command, with the reply the agent wrote to the file it names, records it exactly", () => {
    const { seed, remote } = makeSeed();
    prepareCandidate(remote, "alpha", "gate-words-pin");
    // A reply left from an earlier gate of this Unit answers nothing this pin asks.
    const folder = join(seed, "aidlc", ".aidlc-request-text");
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "gate-alpha.txt"), "Approve", "utf-8");
    const pin = runMergeTool(UNIT, ["pin", "alpha"], seed);
    expect(pin.status, pin.out).toBe(0);
    const gate = JSON.parse(pin.stdout).merge_gate as Record<string, string>;
    const named = / unit gate alpha --decision reject --request-file (aidlc\/\.aidlc-request-text\/gate-alpha\.txt)$/.exec(gate.reject);
    expect(named, gate.reject).not.toBeNull();
    expect(gate.approve).toEndWith(` unit gate alpha --decision approve --request-file ${named![1]}`);
    expect(gate.ask).toContain(named![1]);
    const file = join(seed, ...named![1].split("/"));
    expect(existsSync(file)).toBe(false);
    // Pin keeps the folder, since some hosts' file tools make none.
    expect(statSync(folder).isDirectory()).toBe(true);
    replyAfterPin(seed, "alpha");
    writeFileSync(file, WORDS, "utf-8");
    const run = spawnSync(process.platform === "win32" ? gitBashPath() : "bash", [
      "-c",
      gate.reject.replace(/^.* unit gate /, `${[process.execPath, UNIT].map((value) => `'${value}'`).join(" ")} gate `),
    ], {
      cwd: seed,
      encoding: "utf-8",
      env: { ...process.env, AIDLC_PROJECT_DIR: seed },
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    });
    expect(run.status, `${run.stdout}${run.stderr}`).toBe(0);
    expect(readUnitMergeTransaction(seed, "alpha")?.user_input).toBe(WORDS);
    expect(existsSync(file)).toBe(false);
  });
});
