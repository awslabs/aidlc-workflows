// Pure offline matrix contracts. Windows/backend identities below are fixture
// data, not claims that a Windows process or a model was executed on this host.
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync,
  symlinkSync, unlinkSync, utimesSync, writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import {
  loadTestMatrixJob, reconcileTestMatrix, TEST_MATRIX_LIVE_GATES,
  validateMatrixSelection, writeTestMatrixReceipt,
  type TestMatrixJob, type TestMatrixPlan, type TestMatrixReceipt,
  type TestMatrixReceiptInput, type TestMatrixRuntimeIdentity,
} from "../lib/test-matrix.ts";
import { captureTestSource } from "../lib/test-source.ts";

const SOURCE = resolve(import.meta.dir, "../..");
const scratchBase = process.env.AIDLC_TEST_LOG_DIR ?? join(SOURCE, "tmp", "test-matrix-fixtures");
const roots: string[] = [];
const file = "tests/portable.test.ts";
const identity = { classname: "portable", name: "preserves <bytes> & identity" };
let attempt = 0;

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function directory(): string {
  mkdirSync(scratchBase, { recursive: true });
  const root = mkdtempSync(join(scratchBase, "matrix-"));
  roots.push(root);
  return root;
}
function git(root: string, ...args: string[]): void {
  const result = spawnSync("git", ["-C", root, ...args], {
    encoding: "utf8", env: process.env, timeout: 10_000,
  });
  if (result.status !== 0) throw new Error(`fixture git failed: ${result.stderr}`);
}
function repo(): string {
  const root = directory();
  git(root, "init", "-q");
  writeFileSync(join(root, ".gitignore"), "plan.json\nartifacts/\nnode_modules/\ndist/\ndist-release/\n");
  mkdirSync(join(root, "tests"));
  writeFileSync(join(root, file), 'throw new Error("matrix source must never execute");\n');
  git(root, "add", ".gitignore", "tests");
  return root;
}
function job(id = "linux-bun", platform: NodeJS.Platform = "linux", backend: TestMatrixJob["backend"] = "bun"): TestMatrixJob {
  return {
    id, platform, architecture: "arm64", backend,
    files: [{ path: file, cases: [{ ...identity }] }],
  };
}
function plan(root: string, jobs = [job()], profile?: TestMatrixPlan["profile"]): { path: string; plan: TestMatrixPlan } {
  const value: TestMatrixPlan = {
    version: 1, cohortId: "offline-fixture-cohort", sourceDigest: captureTestSource(root).sourceDigest, jobs,
    ...(profile ? { profile } : {}),
  };
  const path = join(root, "plan.json");
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  return { path, plan: value };
}
const runtime = (job: TestMatrixJob): TestMatrixRuntimeIdentity => ({
  platform: job.platform, architecture: job.architecture, backend: job.backend, bunVersion: "1.3.14",
});
const xmlEscape = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
function xml(outcome: "PASS" | "FAIL" | "SKIP" = "PASS", name = identity.name, sourceFile = file): string {
  const child = outcome === "FAIL" ? '<failure type="AssertionError"/>' : outcome === "SKIP" ? "<skipped/>" : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<testsuites tests="1" failures="${outcome === "FAIL" ? 1 : 0}" skipped="${outcome === "SKIP" ? 1 : 0}">
<testsuite file="${xmlEscape(sourceFile)}"><testcase classname="${identity.classname}" name="${xmlEscape(name)}">${child}</testcase></testsuite>
</testsuites>\n`;
}
function ready(root: string, planPath: string, selected: TestMatrixJob) {
  const context = loadTestMatrixJob(planPath, selected.id, root);
  const actual = runtime(selected);
  validateMatrixSelection(context, selected.files.map((file) => file.path), actual);
  const stampDir = join(root, "artifacts", `attempt-${++attempt}`);
  mkdirSync(stampDir, { recursive: true });
  const input: TestMatrixReceiptInput = {
    stampDir,
    files: selected.files.map((entry, index) => ({
      file: entry.path, junitPath: `${index}.xml`, state: "PASS", evidenceComplete: true,
    })),
    runStatus: "PASS", errors: [], runtimeIdentity: actual, gates: { ...selected.gates },
  };
  for (const entry of input.files) writeFileSync(join(stampDir, entry.junitPath!), xml("PASS", identity.name, entry.file));
  return { context, input };
}
function seal(root: string, planPath: string, selected: TestMatrixJob, mutate?: (input: TestMatrixReceiptInput) => void) {
  const value = ready(root, planPath, selected);
  mutate?.(value.input);
  return { ...value, ...writeTestMatrixReceipt(value.context, value.input) };
}
function editReceipt(path: string, edit: (value: TestMatrixReceipt) => void): void {
  const value = JSON.parse(readFileSync(path, "utf8")) as TestMatrixReceipt;
  edit(value);
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}
function cli(root: string, args: string[]) {
  return spawnSync(process.execPath, [join(SOURCE, "tests", "reconcile-tests.ts"), ...args], {
    cwd: root, encoding: "utf8", timeout: 20_000,
  });
}

describe("content-bound authored test source", () => {
  test("identical tracked/untracked bytes across roots ignore modes and timestamps", () => {
    const left = repo();
    const right = repo();
    git(right, "rm", "--cached", file);
    const first = captureTestSource(left);
    utimesSync(join(right, file), new Date(1), new Date(1));
    chmodSync(join(right, file), 0o755);
    expect(captureTestSource(right)).toEqual(first);
    expect(first.files.map((entry) => entry.path)).toEqual([".gitignore", file]);
  });

  test("dirty content, new authored inputs and tracked deletion change identity", () => {
    const root = repo();
    const initial = captureTestSource(root).sourceDigest;
    writeFileSync(join(root, file), "different dirty source\n");
    const dirty = captureTestSource(root).sourceDigest;
    expect(dirty).not.toBe(initial);
    writeFileSync(join(root, "untracked.ts"), "new authored input\n");
    const added = captureTestSource(root).sourceDigest;
    expect(added).not.toBe(dirty);
    rmSync(join(root, file));
    const removed = captureTestSource(root);
    expect(removed.sourceDigest).not.toBe(added);
    expect(removed.files.some((entry) => entry.path === file)).toBe(false);
  });

  test("Git-ignored data, generated projections and dependency links do not change identity", () => {
    const root = repo();
    const initial = captureTestSource(root).sourceDigest;
    for (const name of ["artifacts", "dist", "dist-release"]) {
      mkdirSync(join(root, name));
      writeFileSync(join(root, name, "transient.txt"), "not authored\n");
    }
    const dependencies = directory();
    writeFileSync(join(dependencies, "package.json"), '{"private":true}\n');
    symlinkSync(dependencies, join(root, "node_modules"), process.platform === "win32" ? "junction" : "dir");
    expect(captureTestSource(root).sourceDigest).toBe(initial);
  });

  test("link targets contribute identity without reading external content or tracked descendants", () => {
    const root = repo();
    const external = directory();
    writeFileSync(join(external, "secret.txt"), "external value one");
    symlinkSync(external, join(root, "alias"), process.platform === "win32" ? "junction" : "dir");
    const linked = captureTestSource(root);
    expect(linked.files.find((entry) => entry.path === "alias")?.kind).toBe("symlink");
    writeFileSync(join(external, "secret.txt"), "external value two");
    expect(captureTestSource(root)).toEqual(linked);
    rmSync(join(root, "tests"), { recursive: true });
    symlinkSync(external, join(root, "tests"), process.platform === "win32" ? "junction" : "dir");
    const ancestor = captureTestSource(root);
    expect(ancestor.files.find((entry) => entry.path === "tests")?.kind).toBe("symlink");
    expect(ancestor.files.some((entry) => entry.path.startsWith("tests/"))).toBe(false);
    writeFileSync(join(external, "secret.txt"), "external value three");
    expect(captureTestSource(root)).toEqual(ancestor);
    const other = directory();
    unlinkSync(join(root, "alias"));
    symlinkSync(other, join(root, "alias"), process.platform === "win32" ? "junction" : "dir");
    expect(captureTestSource(root).sourceDigest).not.toBe(ancestor.sourceDigest);
  });

  test("a checkout subdirectory and a non-repository cannot pose as the source root", () => {
    const root = repo();
    expect(() => captureTestSource(join(root, "tests"))).toThrow("checkout root");
    expect(() => captureTestSource(directory())).toThrow("Git");
  });
});

describe("matrix planning and pre-dispatch binding", () => {
  test("requires exact files including prerequisites and actual runtime identity", () => {
    const root = repo();
    const prepared = plan(root);
    const context = loadTestMatrixJob(prepared.path, "linux-bun", root);
    expect(() => validateMatrixSelection(context, [], runtime(context.job))).toThrow("inventory");
    expect(() => validateMatrixSelection(context, [file, file], runtime(context.job))).toThrow("duplicate");
    expect(() => validateMatrixSelection(context, [file, "tests/extra.test.ts"], runtime(context.job))).toThrow("inventory");
    for (const change of [
      { platform: "win32" as const }, { architecture: "x64" }, { backend: "tmux" as const },
    ]) expect(() => validateMatrixSelection(context, [file], { ...runtime(context.job), ...change })).toThrow("runtime");
    validateMatrixSelection(context, [file], runtime(context.job));
    expect(() => validateMatrixSelection(context, [file], { ...runtime(context.job), bunVersion: "1.3.15" }))
      .toThrow("cannot be replaced");
    expect(Object.isFrozen(context.source)).toBe(true);
    expect(Object.isFrozen(context.job.files)).toBe(true);
  });

  test.each([
    ["unknown version", (p: TestMatrixPlan) => { p.version = 2 as 1; }],
    ["empty jobs", (p: TestMatrixPlan) => { p.jobs = []; }],
    ["duplicate jobs", (p: TestMatrixPlan) => { p.jobs.push(p.jobs[0]); }],
    ["empty files", (p: TestMatrixPlan) => { p.jobs[0].files = []; }],
    ["duplicate files", (p: TestMatrixPlan) => { p.jobs[0].files.push(p.jobs[0].files[0]); }],
    ["empty cases", (p: TestMatrixPlan) => { p.jobs[0].files[0].cases = []; }],
    ["duplicate cases", (p: TestMatrixPlan) => { p.jobs[0].files[0].cases.push(identity); }],
    ["escaping path", (p: TestMatrixPlan) => { p.jobs[0].files[0].path = "../outside.test.ts"; }],
    ["Windows absolute path", (p: TestMatrixPlan) => { p.jobs[0].files[0].path = "C:/repo/test.ts"; }],
    ["unapproved gate key", (p: TestMatrixPlan) => { p.jobs[0].gates = { AWS_SECRET_ACCESS_KEY: "1" } as never; }],
    ["invalid gate value", (p: TestMatrixPlan) => { p.jobs[0].gates = { AIDLC_TUI_LIVE: "yes" } as never; }],
    ["missing source file", (p: TestMatrixPlan) => { p.jobs[0].files[0].path = "tests/absent.test.ts"; }],
  ])("rejects invalid authoritative plan: %s", (_name, mutate) => {
    const root = repo();
    const prepared = plan(root);
    mutate(prepared.plan);
    writeFileSync(prepared.path, JSON.stringify(prepared.plan));
    expect(() => loadTestMatrixJob(prepared.path, "linux-bun", root)).toThrow();
  });

  test("a stale source plan rejects dispatch even with unchanged Git index", () => {
    const root = repo();
    const prepared = plan(root);
    writeFileSync(join(root, file), "dirty bytes after planning\n");
    expect(() => loadTestMatrixJob(prepared.path, "linux-bun", root)).toThrow("source digest mismatch");
  });
});

describe("offline matrix receipts and reconciliation", () => {
  test("Linux/Bun, Windows/Bun and both compatibility owners fulfill four independent obligations", () => {
    const root = repo();
    const jobs = [
      job(), job("windows-bun", "win32"), job("posix-compat", "linux", "tmux"),
      job("windows-compat", "win32", "node-pty"),
    ];
    const prepared = plan(root, jobs);
    const receipts = jobs.map((selected) => seal(root, prepared.path, selected));
    const report = reconcileTestMatrix(prepared.path, receipts.map((entry) => entry.receiptPath));
    expect(report.status).toBe("PASS");
    expect(report.complete).toBe(true);
    expect(report.obligations.map((row) => [row.jobId, row.status])).toEqual(jobs.map((entry) => [entry.id, "FULFILLED"]));
    expect(report.obligations.every((row) => row.evidence.length === 1 && row.evidence[0].junitSha256?.length === 64)).toBe(true);
    expect(receipts[0].receipt.runtimeIdentity.bunVersion).toBe("1.3.14");
  });

  test("a Linux pass cannot satisfy a missing Windows obligation or an absent receipt universe", () => {
    const root = repo();
    const prepared = plan(root, [job(), job("windows", "win32")]);
    const linux = seal(root, prepared.path, prepared.plan.jobs[0]);
    const report = reconcileTestMatrix(prepared.path, [linux.receiptPath]);
    expect(report.complete).toBe(false);
    expect(report.obligations.map((row) => row.status)).toEqual(["FULFILLED", "MISSING-INCOMPLETE"]);
    expect(reconcileTestMatrix(prepared.path, []).obligations.every((row) => row.status === "MISSING-INCOMPLETE")).toBe(true);
  });

  test("explicit narrower profile reports NOT_REQUESTED without treating it as passed coverage", () => {
    const root = repo();
    const optional = { ...job("legacy", "win32", "node-pty"), reason: "Bun-only profile; no compatibility claim" };
    const prepared = plan(root, [job()], { name: "bun-only", notRequested: [optional] });
    const receipt = seal(root, prepared.path, prepared.plan.jobs[0]);
    const report = reconcileTestMatrix(prepared.path, [receipt.receiptPath]);
    expect(report.complete).toBe(true);
    expect(report.profile).toBe("bun-only");
    expect(report.obligations.map((row) => row.status)).toEqual(["FULFILLED", "NOT_REQUESTED"]);
    expect(report.obligations[1].evidence).toEqual([]);
    expect(() => loadTestMatrixJob(prepared.path, "legacy", root)).toThrow("not requested");
  });

  test.each([
    ["cohort", (r: TestMatrixReceipt) => { r.cohortId = "old-night"; }],
    ["plan", (r: TestMatrixReceipt) => { r.planDigest = "a".repeat(64); }],
    ["source", (r: TestMatrixReceipt) => { r.sourceDigest = "b".repeat(64); }],
    ["source after", (r: TestMatrixReceipt) => { r.sourceAfterDigest = "c".repeat(64); }],
    ["source changed", (r: TestMatrixReceipt) => { r.sourceUnchanged = false; }],
    ["plan changed", (r: TestMatrixReceipt) => { r.planUnchanged = false; }],
    ["platform", (r: TestMatrixReceipt) => { r.runtimeIdentity.platform = "win32"; }],
    ["architecture", (r: TestMatrixReceipt) => { r.runtimeIdentity.architecture = "x64"; }],
    ["backend", (r: TestMatrixReceipt) => { r.runtimeIdentity.backend = "tmux"; }],
    ["unknown job", (r: TestMatrixReceipt) => { r.jobId = "unplanned"; }],
    ["missing file", (r: TestMatrixReceipt) => { r.files = []; r.effectiveInventory = []; }],
    ["case substitution", (r: TestMatrixReceipt) => { r.files[0].cases[0].name = "a different case"; }],
    ["effective inventory", (r: TestMatrixReceipt) => { r.effectiveInventory[0].cases[0].name = "a different case"; }],
    ["digest", (r: TestMatrixReceipt) => { r.files[0].junitSha256 = "d".repeat(64); }],
    ["empty evidence claim", (r: TestMatrixReceipt) => { r.files[0].evidenceComplete = false; }],
    ["non-PASS final status", (r: TestMatrixReceipt) => { r.runStatus = "ERROR"; }],
    ["cleanup error", (r: TestMatrixReceipt) => { r.errors.push("process retirement unconfirmed"); }],
    ["escaping artifact", (r: TestMatrixReceipt) => { r.files[0].junitPath = "../outside.xml"; }],
    ["absolute Windows artifact", (r: TestMatrixReceipt) => { r.files[0].junitPath = "C:\\outside.xml"; }],
  ])("never fulfills using wrong or incomplete %s evidence", (_name, mutate) => {
    const root = repo();
    const prepared = plan(root);
    const receipt = seal(root, prepared.path, prepared.plan.jobs[0]);
    editReceipt(receipt.receiptPath, mutate);
    const report = reconcileTestMatrix(prepared.path, [receipt.receiptPath]);
    expect(report.complete).toBe(false);
    expect(report.obligations.every((row) => row.status !== "FULFILLED")).toBe(true);
  });

  test.each([
    ["empty XML", ""],
    ["truncated XML", xml().slice(0, -17)],
    ["same count, wrong case", xml("PASS", "wrong identity")],
    ["wrong source file", xml("PASS", identity.name, "tests/other.test.ts")],
    ["skipped testcase", xml("SKIP")],
    ["real assertion failure", xml("FAIL")],
    ["mismatched counts", xml().replace('tests="1"', 'tests="2"')],
  ])("validates actual JUnit bytes independently of caller PASS: %s", (_name, contents) => {
    const root = repo();
    const prepared = plan(root);
    const receipt = seal(root, prepared.path, prepared.plan.jobs[0], (input) => {
      writeFileSync(join(input.stampDir, input.files[0].junitPath!), contents);
    });
    expect(receipt.receipt.status).toBe("FAIL");
    const report = reconcileTestMatrix(prepared.path, [receipt.receiptPath]);
    expect(report.complete).toBe(false);
    expect(report.obligations[0].status).not.toBe("FULFILLED");
  });

  test("changed or missing XML after sealing cannot reuse an earlier successful digest", () => {
    const root = repo();
    const prepared = plan(root);
    const receipt = seal(root, prepared.path, prepared.plan.jobs[0]);
    const path = join(receipt.input.stampDir, receipt.input.files[0].junitPath!);
    writeFileSync(path, xml("FAIL"));
    expect(reconcileTestMatrix(prepared.path, [receipt.receiptPath]).obligations[0].status).toBe("FAILED");
    rmSync(path);
    expect(reconcileTestMatrix(prepared.path, [receipt.receiptPath]).complete).toBe(false);
  });

  test.each([
    ["undefined", undefined], ["null", null], ["empty", ""],
    ["parent escape", "../outside.xml"], ["Windows absolute", "C:\\outside.xml"],
    ["missing file", "missing.xml"],
  ] as const)(
    "missing/unsafe JUnit reference %s still publishes a non-PASS receipt",
    (_label, junitPath) => {
      const root = repo();
      const prepared = plan(root);
      const receipt = seal(root, prepared.path, prepared.plan.jobs[0], (input) => {
        input.files[0].junitPath = junitPath;
      });
      expect(existsSync(receipt.receiptPath)).toBe(true);
      expect(receipt.receipt.status).toBe("FAIL");
      expect(receipt.receipt.files[0].xmlComplete).toBe(false);
      expect(receipt.receipt.files[0].errors.length).toBeGreaterThan(0);
      expect(reconcileTestMatrix(prepared.path, [receipt.receiptPath]).complete).toBe(false);
    },
  );

  test("source/plan changes while running are sealed as failure using retained pre-run identity", () => {
    for (const change of ["source", "plan"] as const) {
      const root = repo();
      const prepared = plan(root);
      const value = ready(root, prepared.path, prepared.plan.jobs[0]);
      if (change === "source") writeFileSync(join(root, file), "changed during test\n");
      else writeFileSync(prepared.path, `${readFileSync(prepared.path, "utf8")}\n`);
      const receipt = writeTestMatrixReceipt(value.context, value.input);
      expect(receipt.receipt.sourceDigest).toBe(prepared.plan.sourceDigest);
      expect(receipt.receipt.status).toBe("FAIL");
      expect(receipt.receipt.errors.join("\n")).toContain(`${change} changed`);
      expect(reconcileTestMatrix(prepared.path, [receipt.receiptPath]).complete).toBe(false);
    }
  });

  test("missing pre-dispatch validation and changed Bun runtime cannot produce a PASS receipt", () => {
    const root = repo();
    const prepared = plan(root);
    const value = ready(root, prepared.path, prepared.plan.jobs[0]);
    value.input.runtimeIdentity.bunVersion = "1.3.15";
    expect(writeTestMatrixReceipt(value.context, value.input).receipt.status).toBe("FAIL");
    const fresh = loadTestMatrixJob(prepared.path, "linux-bun", root);
    value.input.stampDir = join(root, "artifacts", "unvalidated");
    expect(writeTestMatrixReceipt(fresh, { ...value.input, files: [] }).receipt.status).toBe("FAIL");
  });

  test("effective gate expectations are checked without exporting unrelated environment values", () => {
    const root = repo();
    const selected = { ...job(), gates: { AIDLC_TUI_LIVE: "1" as const } };
    const prepared = plan(root, [selected]);
    const good = seal(root, prepared.path, selected, (input) => {
      input.gates = { AIDLC_TUI_LIVE: "1", AWS_SECRET_ACCESS_KEY: "do-not-capture", HOME: "/private/profile" };
    });
    const body = readFileSync(good.receiptPath, "utf8");
    expect(body).not.toContain("do-not-capture");
    expect(body).not.toContain("AWS_SECRET_ACCESS_KEY");
    expect(body).not.toContain("/private/profile");
    expect(Object.keys(good.receipt.gates).sort()).toEqual([...TEST_MATRIX_LIVE_GATES].sort());
    for (const value of [undefined, "0", "do-not-capture"] as const) {
      const bad = seal(root, prepared.path, selected, (input) => { input.gates = { AIDLC_TUI_LIVE: value }; });
      expect(bad.receipt.status).toBe("FAIL");
      expect(readFileSync(bad.receiptPath, "utf8")).not.toContain("do-not-capture");
      expect(reconcileTestMatrix(prepared.path, [bad.receiptPath]).complete).toBe(false);
    }
  });

  test("distinct duplicate attempts conflict in either order; exact duplicates remain idempotent", () => {
    const root = repo();
    const prepared = plan(root);
    const good = seal(root, prepared.path, prepared.plan.jobs[0]);
    const bad = seal(root, prepared.path, prepared.plan.jobs[0], (input) => {
      input.runStatus = "FAIL";
      writeFileSync(join(input.stampDir, "0.xml"), xml("FAIL"));
    });
    for (const receipts of [[good.receiptPath, bad.receiptPath], [bad.receiptPath, good.receiptPath]]) {
      const report = reconcileTestMatrix(prepared.path, receipts);
      expect(report.complete).toBe(false);
      expect(report.obligations[0].status).toBe("FAILED");
      expect(report.errors.join("\n")).toContain("conflicting duplicate");
    }
    expect(reconcileTestMatrix(prepared.path, [good.receiptPath, good.receiptPath]).complete).toBe(true);
    expect(() => writeTestMatrixReceipt(good.context, good.input)).toThrow();
  });

  test("identical receipt bytes at another location do not hide missing referenced evidence", () => {
    const root = repo();
    const prepared = plan(root);
    const good = seal(root, prepared.path, prepared.plan.jobs[0]);
    const relocated = join(root, "artifacts", "copy");
    mkdirSync(relocated);
    const path = join(relocated, "test-matrix-receipt.json");
    writeFileSync(path, readFileSync(good.receiptPath));
    expect(reconcileTestMatrix(prepared.path, [good.receiptPath, path]).complete).toBe(false);
  });

  test("JUnit cannot escape through an artifact-directory symlink or be reused for two files", () => {
    const root = repo();
    const prepared = plan(root);
    const external = directory();
    writeFileSync(join(external, "report.xml"), xml());
    const linked = seal(root, prepared.path, prepared.plan.jobs[0], (input) => {
      symlinkSync(external, join(input.stampDir, "linked"), process.platform === "win32" ? "junction" : "dir");
      input.files[0].junitPath = "linked/report.xml";
    });
    expect(linked.receipt.status).toBe("FAIL");
    expect(linked.receipt.files[0].junitSha256).toBeNull();
    expect(reconcileTestMatrix(prepared.path, [linked.receiptPath]).complete).toBe(false);
    const value = ready(root, prepared.path, prepared.plan.jobs[0]);
    value.input.files.push({ ...value.input.files[0], file: "tests/unplanned.test.ts" });
    expect(writeTestMatrixReceipt(value.context, value.input).receipt.status).toBe("FAIL");
  });

  test("receipt publication cannot add a self-referential authored source file", () => {
    const root = repo();
    mkdirSync(join(root, "authored-output"));
    writeFileSync(join(root, "authored-output", "0.xml"), xml());
    const prepared = plan(root);
    const value = ready(root, prepared.path, prepared.plan.jobs[0]);
    value.input.stampDir = join(root, "authored-output");
    expect(() => writeTestMatrixReceipt(value.context, value.input)).toThrow("outside authored source");
    expect(existsSync(join(value.input.stampDir, "test-matrix-receipt.json"))).toBe(false);
  });

  test("unknown and malformed receipts cannot disappear behind otherwise complete evidence", () => {
    const root = repo();
    const prepared = plan(root);
    const good = seal(root, prepared.path, prepared.plan.jobs[0]);
    const bad = join(root, "artifacts", "malformed.json");
    writeFileSync(bad, '{"unfinished":');
    const report = reconcileTestMatrix(prepared.path, [good.receiptPath, bad]);
    expect(report.complete).toBe(false);
    expect(report.errors.join("\n")).toContain("valid UTF-8 JSON");
  });

  test("raw plan bytes, not parsed/re-serialized JSON, bind receipt identity", () => {
    const root = repo();
    const prepared = plan(root);
    const receipt = seal(root, prepared.path, prepared.plan.jobs[0]);
    expect(receipt.receipt.planDigest).toBe(createHash("sha256").update(readFileSync(prepared.path)).digest("hex"));
    writeFileSync(prepared.path, JSON.stringify(prepared.plan));
    expect(reconcileTestMatrix(prepared.path, [receipt.receiptPath]).complete).toBe(false);
  });

  test("CLI source and reconciliation are offline, portable and nonzero for unmet/invalid matrices", () => {
    const root = repo();
    const prepared = plan(root, [job(), job("windows", "win32")]);
    const output = join(root, "artifacts", "matrix.json");
    const source = cli(root, ["source", "--repo", root]);
    expect(source.status, source.stderr).toBe(0);
    expect(source.stdout.trim()).toBe(prepared.plan.sourceDigest);
    const linux = seal(root, prepared.path, prepared.plan.jobs[0]);
    const missing = cli(root, ["reconcile", "--plan", prepared.path, "--receipt", linux.receiptPath, "--output", output]);
    expect(missing.status, missing.stderr).toBe(1);
    expect(JSON.parse(readFileSync(output, "utf8")).obligations).toHaveLength(2);
    const windows = seal(root, prepared.path, prepared.plan.jobs[1]);
    const passed = cli(root, ["reconcile", "--plan", prepared.path, "--receipt", linux.receiptPath, "--receipt", windows.receiptPath, "--output", output]);
    expect(passed.status, passed.stderr).toBe(0);
    expect(JSON.parse(readFileSync(output, "utf8")).complete).toBe(true);
    const protectedInput = cli(root, ["--plan", prepared.path, "--output", prepared.path]);
    expect(protectedInput.status).toBe(2);
    expect(JSON.parse(readFileSync(prepared.path, "utf8")).version).toBe(1);
    renameSync(prepared.path, `${prepared.path}.old`);
    const invalid = cli(root, ["reconcile", "--plan", prepared.path, "--output", output]);
    expect(invalid.status).toBe(2);
    expect(JSON.parse(readFileSync(output, "utf8")).status).toBe("ERROR");
  }, 30_000);

  test.each(["passing", "invalid plan", "unrequested receipt", "missing JUnit"] as const)(
    "CLI protects referenced JUnit from normal/error output for %s evidence",
    (mode) => {
      const root = repo();
      const prepared = plan(root);
      const receipt = seal(root, prepared.path, prepared.plan.jobs[0]);
      const junit = join(receipt.input.stampDir, receipt.input.files[0].junitPath!);
      const originalXml = readFileSync(junit);
      const alias = join(root, "artifacts", "stamp-alias");
      symlinkSync(receipt.input.stampDir, alias, process.platform === "win32" ? "junction" : "dir");
      if (mode === "invalid plan") writeFileSync(prepared.path, '{"unfinished":');
      if (mode === "unrequested receipt") editReceipt(receipt.receiptPath, (value) => { value.jobId = "unrequested"; });
      if (mode === "missing JUnit") rmSync(junit);
      const originalPlan = readFileSync(prepared.path);
      const originalReceipt = readFileSync(receipt.receiptPath);
      const args = ["reconcile", "--plan", prepared.path, "--receipt", receipt.receiptPath, "--output"];
      for (const destination of [junit, join(alias, receipt.input.files[0].junitPath!)]) {
        const denied = cli(root, [...args, destination]);
        expect(denied.status, denied.stderr).toBe(2);
        expect(denied.stderr).toContain("reconciliation output must not overwrite an input");
        if (mode === "missing JUnit") expect(existsSync(junit)).toBe(false);
        else expect(readFileSync(junit)).toEqual(originalXml);
        expect(readFileSync(prepared.path)).toEqual(originalPlan);
        expect(readFileSync(receipt.receiptPath)).toEqual(originalReceipt);
      }
      // Reject only the input collision; distinct destinations still publish
      // the normal PASS/FAIL or ERROR report with the existing exit semantics.
      const output = join(root, "artifacts", "matrix.json");
      const allowed = cli(root, [...args, output]);
      expect(allowed.status, allowed.stderr).toBe(mode === "passing" ? 0 : mode === "invalid plan" ? 2 : 1);
      expect(JSON.parse(readFileSync(output, "utf8")).status)
        .toBe(mode === "passing" ? "PASS" : mode === "invalid plan" ? "ERROR" : "FAIL");
      if (mode === "missing JUnit") expect(existsSync(junit)).toBe(false);
      else expect(readFileSync(junit)).toEqual(originalXml);
    },
    30_000,
  );

  test("CLI cannot authorize an output destination from unreadable receipt JSON", () => {
    const root = repo();
    const prepared = plan(root);
    const receipt = seal(root, prepared.path, prepared.plan.jobs[0]);
    const junit = join(receipt.input.stampDir, receipt.input.files[0].junitPath!);
    const originalXml = readFileSync(junit);
    writeFileSync(receipt.receiptPath, '{"unfinished":');
    const denied = cli(root, [
      "reconcile", "--plan", prepared.path, "--receipt", receipt.receiptPath, "--output", junit,
    ]);
    expect(denied.status, denied.stderr).toBe(2);
    expect(readFileSync(junit)).toEqual(originalXml);
  });

  test("prepare CLI freezes an explicit source-independent profile and refuses authored output", () => {
    const root = repo();
    const profilePath = join(root, "tests", "profile.json");
    const output = join(root, "artifacts", "prepared-plan.json");
    const optional = { ...job("tmux-optional", "linux", "tmux"), reason: "explicitly Bun-only" };
    writeFileSync(profilePath, JSON.stringify({
      version: 1, name: "native-bun", jobs: [job(), job("windows", "win32")], notRequested: [optional],
    }));
    git(root, "add", "tests/profile.json");
    const sourceDigest = captureTestSource(root).sourceDigest;
    const result = cli(root, ["prepare", "--profile", profilePath, "--cohort", "night-42", "--repo", root, "--output", output]);
    expect(result.status, result.stderr).toBe(0);
    const prepared = JSON.parse(readFileSync(output, "utf8")) as TestMatrixPlan;
    expect(prepared.cohortId).toBe("night-42");
    expect(prepared.sourceDigest).toBe(sourceDigest);
    expect(prepared.jobs.map((entry) => entry.id)).toEqual(["linux-bun", "windows"]);
    expect(prepared.profile).toEqual({ name: "native-bun", notRequested: [optional] });
    expect(captureTestSource(root).sourceDigest).toBe(sourceDigest);
    expect(loadTestMatrixJob(output, "windows", root).job.platform).toBe("win32");
    const denied = cli(root, ["prepare", "--profile", profilePath, "--cohort", "night-42", "--repo", root, "--output", join(root, "authored-plan.json")]);
    expect(denied.status).toBe(2);
    expect(existsSync(join(root, "authored-plan.json"))).toBe(false);
    const replaceProfile = cli(root, ["prepare", "--profile", profilePath, "--cohort", "night-42", "--repo", root, "--output", profilePath]);
    expect(replaceProfile.status).toBe(2);
    expect(JSON.parse(readFileSync(profilePath, "utf8")).name).toBe("native-bun");
    // An ignored directory is not permission to replace a tracked source file,
    // even when an ignored directory symlink offers a second spelling.
    const authoredIgnored = join(root, "artifacts", "tracked.json");
    writeFileSync(authoredIgnored, "authored bytes");
    git(root, "add", "-f", "artifacts/tracked.json");
    const aliases = join(root, "artifacts", "alias");
    symlinkSync(join(root, "artifacts"), aliases, process.platform === "win32" ? "junction" : "dir");
    expect(cli(root, ["prepare", "--profile", profilePath, "--cohort", "night-42", "--repo", root,
      "--output", join(aliases, "tracked.json")]).status).toBe(2);
    expect(readFileSync(authoredIgnored, "utf8")).toBe("authored bytes");
    rmSync(authoredIgnored);
    expect(cli(root, ["prepare", "--profile", profilePath, "--cohort", "night-42", "--repo", root,
      "--output", authoredIgnored]).status).toBe(2);
    expect(existsSync(authoredIgnored)).toBe(false);
    const invalidProfile = join(root, "artifacts", "bad-profile.json");
    writeFileSync(invalidProfile, '{"version":1,"name":"empty","jobs":[]}');
    expect(cli(root, ["prepare", "--profile", invalidProfile, "--cohort", "night-43", "--repo", root, "--output", output]).status).toBe(2);
  }, 30_000);
});
