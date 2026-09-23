// Filesystem/receipt contracts. The supplied retirement value models a verified
// native result; these tests do not claim to exercise Windows Job Object APIs.
import { afterEach, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import * as promises from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createE2eNativeRoot, finishE2eTemporaryFiles } from "../lib/e2e-workers.ts";
import type { IsolatedProcessRetirement } from "../lib/e2e-process.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "e2e-deferred-")));
  roots.push(root);
  const temp = join(root, "aidlc-e2e-fixtures-owned");
  const project = join(temp, "codex-mem-include-owned");
  const checkout = join(root, "checkout");
  const name = "t-exec-codex-memory-include.serial.test.ts";
  const artifacts = join(root, "logs", "stamp", "e2e-artifacts", "t-exec-codex-memory-include.serial");
  const reportPath = join(root, "logs", "stamp", "e2e-results.json");
  for (const path of [project, checkout, artifacts]) mkdirSync(path, { recursive: true });
  writeFileSync(join(project, "proof.txt"), "the passing fixture's complete evidence\n");
  const configPath = join(artifacts, "process-config.json");
  const config = {
    token: randomUUID(), cwd: checkout,
    command: [process.execPath, "test", join(checkout, "tests", "e2e", name)],
    status: join(artifacts, "process-status.json"),
    job: `Local\\aidlc-e2e-${randomUUID()}`,
  };
  const configText = JSON.stringify(config);
  writeFileSync(configPath, configText);
  writeFileSync(config.status, JSON.stringify({ token: config.token, phase: "exited", code: 0 }));
  const report = { files: [{
    worker: 1, file: `tests/e2e/${name}`, state: "RUNNING",
    artifacts, temporaryDirectory: temp, checkout,
  }] };
  writeFileSync(reportPath, JSON.stringify(report));
  const receiptPath = join(artifacts, "codex-deferred-cleanup-1.json");
  const receipt = {
    root: project, temporaryDirectory: temp, coordinatorReport: reportPath,
    runnerConfig: configPath, job: config.job,
  };
  writeFileSync(receiptPath, JSON.stringify(receipt));
  const env = {
    TEMP: temp, TMP: temp, TMPDIR: temp,
    AIDLC_TEST_WORKER_ROOT: artifacts, AIDLC_TEST_LOG_DIR: artifacts,
    AIDLC_TEST_WORKER_ID: "1", AIDLC_TEST_WORKER_PROCESS_GROUP: "0",
    AIDLC_CODEX_EXEC_LIVE: "1", AIDLC_TEST_NAME: name,
  };
  const retirement: IsolatedProcessRetirement = {
    platform: "win32", job: config.job, configPath, configText,
  };
  return { root, temp, project, artifacts, env, retirement, receipt, receiptPath, report, reportPath, config };
}

test("a validated Windows Codex handoff moves the container and preserves its bytes after retirement", async () => {
  const f = fixture();
  const retained = await finishE2eTemporaryFiles(f.env, f.artifacts, false, f.retirement);
  expect(retained).toBe(join(f.artifacts, "retained-fixtures"));
  expect(existsSync(f.temp)).toBe(false);
  expect(readFileSync(join(retained!, "codex-mem-include-owned", "proof.txt"), "utf8"))
    .toBe("the passing fixture's complete evidence\n");
  const record = JSON.parse(readFileSync(join(f.artifacts, "deferred-cleanup.json"), "utf8"));
  expect(record).toMatchObject({
    state: "process-retired-fixtures-retained", temporaryDirectory: f.temp,
    roots: [f.project], snapshot: retained, sourceKept: false,
    retiredJob: f.retirement.job, cleanupOwner: "host",
  });
  expect(existsSync(f.receiptPath)).toBe(true);
  expect(existsSync(f.retirement.configPath)).toBe(true);
});

test("multiple deferred fixtures from one retired job move together", async () => {
  const f = fixture();
  const second = join(f.temp, "codex-exec-second");
  mkdirSync(second);
  writeFileSync(join(second, "proof.txt"), "second fixture");
  writeFileSync(join(f.artifacts, "codex-deferred-cleanup-2.json"), JSON.stringify({ ...f.receipt, root: second }));
  const retained = await finishE2eTemporaryFiles(f.env, f.artifacts, false, f.retirement);
  expect(readFileSync(join(retained!, "codex-mem-include-owned", "proof.txt"), "utf8"))
    .toBe("the passing fixture's complete evidence\n");
  expect(readFileSync(join(retained!, "codex-exec-second", "proof.txt"), "utf8")).toBe("second fixture");
  expect(JSON.parse(readFileSync(join(f.artifacts, "deferred-cleanup.json"), "utf8")).roots).toHaveLength(2);
  expect(existsSync(f.temp)).toBe(false);
});

test("an EXDEV fallback copies evidence but never deletes the protected source", async () => {
  const f = fixture();
  const move = spyOn(promises, "rename").mockRejectedValueOnce(Object.assign(new Error("cross-volume fixture"), { code: "EXDEV" }));
  try {
    const retained = await finishE2eTemporaryFiles(f.env, f.artifacts, false, f.retirement);
    expect(readFileSync(join(f.project, "proof.txt"), "utf8")).toBe("the passing fixture's complete evidence\n");
    expect(readFileSync(join(retained!, "codex-mem-include-owned", "proof.txt"), "utf8"))
      .toBe("the passing fixture's complete evidence\n");
    expect(JSON.parse(readFileSync(join(f.artifacts, "deferred-cleanup.json"), "utf8")).sourceKept).toBe(true);
  } finally { move.mockRestore(); }
});

test("a deferred rename EPERM still fails and preserves the original", async () => {
  const f = fixture();
  const error = Object.assign(new Error("injected rename EPERM"), { code: "EPERM" });
  const move = spyOn(promises, "rename").mockRejectedValueOnce(error);
  try {
    await expect(finishE2eTemporaryFiles(f.env, f.artifacts, false, f.retirement)).rejects.toBe(error);
    expect(existsSync(join(f.project, "proof.txt"))).toBe(true);
  } finally { move.mockRestore(); }
});

test("an unreadable EXDEV snapshot remains a failure with its original retained", async () => {
  const f = fixture();
  const failure = Object.assign(new Error("injected copy EPERM"), { code: "EPERM" });
  const move = spyOn(promises, "rename").mockRejectedValueOnce(Object.assign(new Error("cross-volume fixture"), { code: "EXDEV" }));
  const copy = spyOn(promises, "cp").mockRejectedValueOnce(failure);
  try {
    await expect(finishE2eTemporaryFiles(f.env, f.artifacts, false, f.retirement)).rejects.toBe(failure);
    expect(existsSync(join(f.project, "proof.txt"))).toBe(true);
    expect(existsSync(join(f.artifacts, "deferred-cleanup.json"))).toBe(false);
  } finally {
    copy.mockRestore();
    move.mockRestore();
  }
});
test("a disk receipt cannot establish process retirement", async () => {
  const f = fixture();
  await expect(finishE2eTemporaryFiles(f.env, f.artifacts, false)).rejects.toThrow("retired file");
  await expect(finishE2eTemporaryFiles(f.env, f.artifacts, false, {
    ...f.retirement, platform: "linux", job: undefined,
  })).rejects.toThrow("retired file");
  expect(existsSync(f.project)).toBe(true);
  expect(existsSync(join(f.artifacts, "retained-fixtures"))).toBe(false);
});

test("deferred files cannot bypass unconfirmed native transport cleanup", async () => {
  const f = fixture();
  const nativeRoot = createE2eNativeRoot(f.artifacts);
  const env = { ...f.env, AIDLC_TUI_BUN_ROOT: nativeRoot };
  try {
    await expect(finishE2eTemporaryFiles(env, f.artifacts, false, f.retirement)).rejects.toThrow("unconfirmed");
    expect(existsSync(f.project)).toBe(true);
    expect(existsSync(join(f.artifacts, "retained-fixtures"))).toBe(false);
  } finally {
    // This test allocated the sibling root and never launched a process in it.
    rmSync(dirname(nativeRoot), { recursive: true, force: true });
  }
});

for (const mismatch of ["job", "root", "config", "status", "report", "temp", "family"] as const) {
  test(`a mismatched ${mismatch} cannot grant deferred cleanup`, async () => {
    const f = fixture();
    switch (mismatch) {
      case "job":
        writeFileSync(f.receiptPath, JSON.stringify({ ...f.receipt, job: `Local\\aidlc-e2e-${randomUUID()}` }));
        break;
      case "root":
        writeFileSync(f.receiptPath, JSON.stringify({ ...f.receipt, root: f.root }));
        break;
      case "config":
        writeFileSync(f.retirement.configPath, JSON.stringify({ ...f.config, token: randomUUID() }));
        break;
      case "status":
        writeFileSync(f.config.status, JSON.stringify({ token: randomUUID(), phase: "exited" }));
        break;
      case "report":
        f.report.files[0].worker = 2;
        writeFileSync(f.reportPath, JSON.stringify(f.report));
        break;
      case "temp":
        f.env.TMP = f.root;
        break;
      case "family":
        f.env.AIDLC_TEST_NAME = "t-unrelated.test.ts";
        break;
    }
    await expect(finishE2eTemporaryFiles(f.env, f.artifacts, false, f.retirement)).rejects.toThrow();
    expect(existsSync(join(f.project, "proof.txt"))).toBe(true);
    expect(existsSync(join(f.artifacts, "retained-fixtures"))).toBe(false);
  });
}

test("a redirected root and an occupied snapshot destination remain failures", async () => {
  const f = fixture();
  const external = join(f.root, "external");
  mkdirSync(external);
  rmSync(f.project, { recursive: true });
  symlinkSync(external, f.project, process.platform === "win32" ? "junction" : "dir");
  await expect(finishE2eTemporaryFiles(f.env, f.artifacts, false, f.retirement)).rejects.toThrow("plain directories");
  rmSync(f.project);
  mkdirSync(f.project);
  mkdirSync(join(f.artifacts, "retained-fixtures"));
  writeFileSync(join(f.artifacts, "retained-fixtures", "keep"), "existing evidence");
  await expect(finishE2eTemporaryFiles(f.env, f.artifacts, false, f.retirement)).rejects.toThrow();
  expect(readFileSync(join(f.artifacts, "retained-fixtures", "keep"), "utf8")).toBe("existing evidence");
});

test("ordinary cleanup still deletes successfully and propagates EPERM", async () => {
  const f = fixture();
  rmSync(f.receiptPath);
  const failure = Object.assign(new Error("injected EPERM"), { code: "EPERM" });
  const remove = spyOn(promises, "rm").mockRejectedValueOnce(failure);
  try {
    await expect(finishE2eTemporaryFiles(f.env, f.artifacts, false)).rejects.toBe(failure);
  } finally { remove.mockRestore(); }
  expect(existsSync(f.temp)).toBe(true);
  expect(await finishE2eTemporaryFiles(f.env, f.artifacts, false)).toBeUndefined();
  expect(existsSync(f.temp)).toBe(false);
});
