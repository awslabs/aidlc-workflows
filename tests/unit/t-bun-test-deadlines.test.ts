import { expect, test, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startIsolatedProcess } from "../lib/e2e-process.ts";
import {
  FILE_CLEANUP_ENV,
  FILE_DEADLINE_ENV,
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_RUNTIME_CASE_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

test("Bun's CLI default preserves explicit case and hook deadlines", () => {
  const root = mkdtempSync(join(tmpdir(), "aidlc-bun-deadline-"));
  const fixture = join(root, "deadline.test.ts");
  try {
    writeFileSync(fixture, `
import { beforeAll, describe, test } from "bun:test";
test("uses CLI default", async () => { await Bun.sleep(200); });
test("explicit case deadline", async () => { await Bun.sleep(200); }, 2000);
describe("explicit hook deadline", () => {
  beforeAll(async () => { await Bun.sleep(200); }, 2000);
  test("hook completed", () => {});
});
`);
    const child = spawnSync(process.execPath, ["test", fixture, "--timeout=50"], {
      cwd: root, encoding: "utf8", timeout: NATIVE_STARTUP_TIMEOUT_MS,
    });
    const output = `${child.stdout}\n${child.stderr}`;
    expect(child.status, output).toBe(1);
    expect(output).toContain("2 pass");
    expect(output).toContain("1 fail");
    expect(output).toContain("(fail) uses CLI default");
    expect(output).toContain("timed out after 50ms");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, NATIVE_RUNTIME_CASE_TIMEOUT_MS);

test("the owned file supervisor cancels at the work cutoff and retains its original hard cleanup tail", async () => {
  const root = mkdtempSync(join(tmpdir(), "aidlc-file-work-cutoff-"));
  const allowance = remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS, { phase: "file watchdog calibration" })!;
  // The short work interval is the fault under test. Native startup and
  // observed retirement retain the generous original hard budget.
  const hardDeadline = Date.now() + allowance;
  const env = {
    ...process.env,
    [FILE_DEADLINE_ENV]: String(hardDeadline),
    [FILE_CLEANUP_ENV]: String(Math.max(0, allowance - 100)),
  };
  const controller = new AbortController();
  let owned: Awaited<ReturnType<typeof startIsolatedProcess>> | undefined;
  try {
    owned = await startIsolatedProcess({
      command: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
      cwd: root, env, artifacts: root, signal: controller.signal,
    });
    owned.child.stdout.resume();
    owned.child.stderr.resume();
    await owned.exited;
    expect(controller.signal.aborted).toBe(false); // The supervisor's own watchdog fired.
    expect(owned.workTimedOut).toBe(true);
    expect(Date.now()).toBeLessThan(hardDeadline);
    const receipt = await owned.retire();
    expect(receipt.configPath).toBe(join(root, "process-config.json"));
    expect(owned.child.exitCode !== null || owned.child.signalCode !== null).toBe(true);
    expect(env[FILE_DEADLINE_ENV]).toBe(String(hardDeadline));
  } finally {
    controller.abort();
    if (owned) await owned.retire();
    rmSync(root, { recursive: true, force: true });
  }
}, NATIVE_RUNTIME_CASE_TIMEOUT_MS);
