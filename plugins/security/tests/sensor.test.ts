// The security-findings-gate worker's verdicts over committed scan records.
// Every case runs the real worker twice, as the copy channel runs it (a Bun
// subprocess) and as a native install does (importing it and calling
// main(argv)), and both must print the same single JSON line. Both run in a
// project folder, because the dispatcher gives the worker the project root as
// its working directory and the worker reads .aidlc-security.json there.
//
// Run: bash tests/run-tests.sh --integration --filter 'plugin-security'

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../../../tests/harness/test-budget.ts";
import { main } from "../tools/aidlc-sensor-security-findings-gate.ts";

const WORKER = join(import.meta.dir, "..", "tools", "aidlc-sensor-security-findings-gate.ts");
const RECORDS = join(import.meta.dir, "fixtures", "scan-records");
const PROJECTS = join(import.meta.dir, "fixtures", "projects");

// A finding names the config file under the worker's working directory, which
// macOS reports as the temp folder's real path.
const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), "aidlc-security-gate-")));
afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));
const NO_CONFIG = join(SCRATCH, "no-config");
mkdirSync(NO_CONFIG);
// Written at test time rather than committed beside the other configs, because
// Biome, which lints this folder, refuses a JSON file that does not parse.
const MALFORMED = join(SCRATCH, "malformed");
mkdirSync(MALFORMED);
writeFileSync(join(MALFORMED, ".aidlc-security.json"), '{ "override_mode": "lenient"\n');

interface Verdict {
  pass: boolean;
  findings: string[];
  findings_count: number;
  threshold: string;
  override_mode: "strict" | "lenient" | null;
  overrides: string[];
}

function viaSubprocess(project: string, argv: string[]): string {
  const run = spawnSync(process.execPath, [WORKER, ...argv], {
    cwd: project,
    encoding: "utf-8",
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  expect(run.status, run.stderr).toBe(0);
  return run.stdout;
}

function viaMain(project: string, argv: string[]): string {
  const chunks: string[] = [];
  const write = process.stdout.write;
  const cwd = process.cwd();
  process.stdout.write = ((chunk: string | Uint8Array) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    process.chdir(project);
    main(argv);
  } finally {
    process.chdir(cwd);
    process.stdout.write = write;
  }
  return chunks.join("");
}

function fireIn(project: string, fixture: string, file = "security-scan-result.md", ...extra: string[]): Verdict {
  const argv = ["--stage", "code-generation", "--output-path", join(RECORDS, fixture, file), ...extra];
  const printed = viaSubprocess(project, argv);
  expect(viaMain(project, argv)).toBe(printed);
  const lines = printed.split("\n").filter((line) => line !== "");
  expect(lines).toHaveLength(1);
  const verdict = JSON.parse(lines[0]) as Verdict;
  expect(verdict.findings_count).toBe(verdict.findings.length);
  return verdict;
}

function fire(fixture: string, file?: string, ...extra: string[]): Verdict {
  return fireIn(NO_CONFIG, fixture, file, ...extra);
}

describe("a completed scan passes", () => {
  test("with no findings", () => {
    expect(fire("clean")).toEqual({
      pass: true,
      findings: [],
      findings_count: 0,
      threshold: "HIGH",
      override_mode: "strict",
      overrides: [],
    });
  });

  test("when every finding ranks below HIGH", () => {
    expect(fire("below-threshold").pass).toBe(true);
  });

  test("when a CRITICAL finding is RESOLVED", () => {
    expect(fire("resolved").pass).toBe(true);
  });
});

describe("open findings at or above the threshold block", () => {
  test("an ACTIVE HIGH and a FALSE_POSITIVE CRITICAL each block, the LOW does not", () => {
    const verdict = fire("open-high");
    expect(verdict.pass).toBe(false);
    expect(verdict.findings_count).toBe(2);
    expect(verdict.findings[0]).toContain("f-101 (HIGH) Hardcoded credential at src/config.ts:12");
    expect(verdict.findings[1]).toContain("f-102 (CRITICAL) Command built from request input at src/run.ts:30-34");
    expect(verdict.findings.join(" ")).not.toContain("f-103");
    expect(verdict.findings[0]).toContain("Override blocking sensors at the gate");
  });

  test("a finding the service could not rate blocks even at the CRITICAL threshold", () => {
    const verdict = fire("unknown-risk", "security-scan-result.md", "--threshold", "CRITICAL");
    expect(verdict.pass).toBe(false);
    expect(verdict.findings[0]).toContain("f-601 (UNKNOWN)");
  });

  test("--threshold CRITICAL lets an open HIGH through and still blocks the CRITICAL", () => {
    const verdict = fire("open-critical", "security-scan-result.md", "--threshold", "CRITICAL");
    expect(verdict.threshold).toBe("CRITICAL");
    expect(verdict.findings_count).toBe(1);
    expect(verdict.findings[0]).toContain("f-702 (CRITICAL)");
  });

  test("--threshold MEDIUM blocks the MEDIUM finding a HIGH gate lets through", () => {
    const verdict = fire("below-threshold", "security-scan-result.md", "--threshold", "MEDIUM");
    expect(verdict.findings_count).toBe(1);
    expect(verdict.findings[0]).toContain("f-201 (MEDIUM)");
  });

  test("a threshold that is not a risk level fails instead of guessing", () => {
    const verdict = fire("clean", "security-scan-result.md", "--threshold", "SEVERE");
    expect(verdict.pass).toBe(false);
    expect(verdict.findings[0]).toContain('"SEVERE" is not a risk level');
  });
});

describe("override modes", () => {
  const ACCEPTED =
    "f-401 (HIGH) Hardcoded credential at test/fixtures/keys.ts:3: accepted by Dana Lee at 2026-11-02T09:55:00Z. Reason: A fake key in a test fixture; it never reaches a deployment.";
  const config = (project: string) => join(PROJECTS, project, ".aidlc-security.json");

  test("without .aidlc-security.json the gate is strict: the record's override does not pass the finding", () => {
    const verdict = fire("override-accepted");
    expect(verdict.pass).toBe(false);
    expect(verdict.override_mode).toBe("strict");
    expect(verdict.overrides).toEqual([]);
    expect(verdict.findings).toHaveLength(1);
    expect(verdict.findings[0]).toContain("f-401 (HIGH)");
    expect(verdict.findings[0]).toContain("ignores its override in the record");
    expect(verdict.findings[0]).toContain("Override blocking sensors at the gate");
  });

  test("a strict .aidlc-security.json blocks the same finding", () => {
    const verdict = fireIn(join(PROJECTS, "strict"), "override-accepted");
    expect(verdict.pass).toBe(false);
    expect(verdict.override_mode).toBe("strict");
    expect(verdict.findings[0]).toContain("ignores its override in the record");
  });

  test("in lenient mode a finding the person accepted passes, and the output says who accepted it, when and why", () => {
    const verdict = fireIn(join(PROJECTS, "lenient"), "override-accepted");
    expect(verdict.pass).toBe(true);
    expect(verdict.override_mode).toBe("lenient");
    expect(verdict.overrides).toEqual([ACCEPTED]);
  });

  test("in lenient mode an override with a blank reason, no one in by, or an unreadable time does not count", () => {
    const verdict = fireIn(join(PROJECTS, "lenient"), "override-invalid");
    expect(verdict.pass).toBe(false);
    expect(verdict.overrides).toEqual([]);
    expect(verdict.findings).toHaveLength(3);
    expect(verdict.findings[0]).toContain("f-501");
    expect(verdict.findings[0]).toContain("gives no `reason`");
    expect(verdict.findings[1]).toContain("f-502");
    expect(verdict.findings[1]).toContain("names no one in `by`");
    expect(verdict.findings[2]).toContain("f-503");
    expect(verdict.findings[2]).toContain('"last Tuesday"');
  });

  test("a .aidlc-security.json that is not JSON fails the gate, naming the file and both modes", () => {
    const verdict = fireIn(MALFORMED, "override-accepted");
    expect(verdict.pass).toBe(false);
    expect(verdict.override_mode).toBeNull();
    expect(verdict.overrides).toEqual([]);
    expect(verdict.findings).toHaveLength(1);
    expect(verdict.findings[0]).toContain(`${join(MALFORMED, ".aidlc-security.json")} is not valid JSON`);
    expect(verdict.findings[0]).toContain('{"override_mode": "strict"} or {"override_mode": "lenient"}');
  });

  test("a mode that is neither strict nor lenient fails the gate", () => {
    const verdict = fireIn(join(PROJECTS, "unknown-mode"), "override-accepted");
    expect(verdict.pass).toBe(false);
    expect(verdict.override_mode).toBeNull();
    expect(verdict.findings).toHaveLength(1);
    expect(verdict.findings[0]).toContain(`${config("unknown-mode")} sets override_mode to "loose"`);
    expect(verdict.findings[0]).toContain('{"override_mode": "strict"} or {"override_mode": "lenient"}');
  });

  test("a misspelled key fails the gate, even on a clean scan, instead of falling back to strict", () => {
    const verdict = fireIn(join(PROJECTS, "unknown-key"), "clean");
    expect(verdict.pass).toBe(false);
    expect(verdict.override_mode).toBeNull();
    expect(verdict.findings[0]).toContain(`${config("unknown-key")} has keys the gate does not read ("overrideMode")`);
  });
});

describe("a record that is no evidence blocks", () => {
  test("a scan that is not COMPLETED", () => {
    const verdict = fire("in-progress");
    expect(verdict.pass).toBe(false);
    expect(verdict.findings[0]).toContain("scan-5e6f7a8b is IN_PROGRESS, not COMPLETED");
  });

  test("a record saying no scan ran, with the person's reason", () => {
    const verdict = fire("not-run");
    expect(verdict.pass).toBe(false);
    expect(verdict.findings[0]).toContain("No diff scan ran for this unit: The AWS account is not set up yet");
  });

  test("a record that does not match the schema, naming each problem", () => {
    const verdict = fire("wrong-schema");
    expect(verdict.pass).toBe(false);
    const problems = verdict.findings.join("\n");
    expect(problems).toContain("schema_version is 2");
    expect(problems).toContain("scan.scan_id must be a non-empty string");
    expect(problems).toContain('scan.status is "DONE"');
    expect(problems).toContain('findings[0].risk_level is "SEVERE"');
  });

  test("a record with two json blocks", () => {
    const verdict = fire("two-blocks");
    expect(verdict.pass).toBe(false);
    expect(verdict.findings[0]).toContain("holds 2 ```json blocks");
  });
});

describe("a missing record blocks", () => {
  test("fired on the unit's plan with no record beside it", () => {
    const verdict = fire("plan-only", "code-generation-plan.md");
    expect(verdict.pass).toBe(false);
    expect(verdict.findings[0]).toContain(join(RECORDS, "plan-only", "security-scan-result.md"));
    expect(verdict.findings[0]).toContain("Code Generation's security step writes it");
  });

  test("fired on a record path that does not exist", () => {
    expect(fire("does-not-exist").pass).toBe(false);
  });

  test("fired on the plan with a record beside it, the plan's fire passes and leaves the record to its own fire", () => {
    expect(fire("plan-with-record", "code-generation-plan.md").pass).toBe(true);
  });
});

test("without --output-path the worker exits 2 and prints no verdict", () => {
  const run = spawnSync(process.execPath, [WORKER, "--stage", "code-generation"], {
    encoding: "utf-8",
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  expect(run.status).toBe(2);
  expect(run.stdout).toBe("");
  expect(run.stderr).toContain("Usage:");
});
