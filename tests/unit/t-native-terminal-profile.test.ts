// covers: file:tests/native-terminal-profile.json
//
// Every case of a file the native terminal profile names is in the profile. Only the Full Suite runs the profile's
// jobs, and there a case the profile does not list fails the job's coverage ("JUnit testcase inventory mismatch")
// after the PR that added it has merged; this check meets it on the PR.
//
// Mechanism: process - `bun test <file>` with a name pattern no case matches lists every case as a skipped testcase
// without running it; the JUnit is read with the matrix's own reader and compared with each job's list for the file
// by classname and name, as the receipt compares them. Linux only: PR CI runs there, every job lists a file's cases
// alike, and a file for one OS can register its cases differently on another.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO_ROOT } from "../harness/fixtures.ts";
import { NATIVE_STARTUP_TIMEOUT_MS } from "../harness/test-budget.ts";
import { readJUnitEvidence } from "../lib/e2e-plan.ts";

interface ProfileCase { classname: string; name: string }
interface Profile { jobs: { id: string; files: { path: string; cases: ProfileCase[] }[] }[] }

const SKIP = process.platform === "linux"
  ? null
  : "the profile is checked on Linux, where PR CI runs; a file for one OS can register its cases differently on another";
const NO_CASE = "^no case is named this, so every case is listed and none runs$";
const key = (testcase: ProfileCase) => JSON.stringify([testcase.classname, testcase.name]);

/** The cases `bun test` collects from a file, by classname and name, none of them run. */
function listedCases(path: string, junit: string): Set<string> {
  const run = spawnSync(process.execPath, ["test", path, "--test-name-pattern", NO_CASE, "--reporter=junit", `--reporter-outfile=${junit}`], {
    cwd: REPO_ROOT, encoding: "utf8", timeout: NATIVE_STARTUP_TIMEOUT_MS,
  });
  let xml = "";
  try {
    xml = readFileSync(junit, "utf8");
  } catch {
    throw new Error(`${path} listed no cases: ${`${run.stdout}\n${run.stderr}`.trim().split("\n").slice(-5).join(" | ")}`);
  }
  const evidence = readJUnitEvidence(xml);
  if (!evidence.complete) throw new Error(`${path} listed no readable cases: ${evidence.error}`);
  return new Set(evidence.testcases.map(key));
}

describe("the native terminal profile", () => {
  test.skipIf(SKIP !== null)(`lists every case of each file it names, in every job that runs the file${SKIP ? ` [SKIP: ${SKIP}]` : ""}`, () => {
    const profile = JSON.parse(readFileSync(join(REPO_ROOT, "tests", "native-terminal-profile.json"), "utf8")) as Profile;
    const scratch = mkdtempSync(join(tmpdir(), "t-native-terminal-profile-"));
    try {
      const paths = [...new Set(profile.jobs.flatMap((job) => job.files.map((file) => file.path)))];
      const listed = new Map(paths.map((path, n) => [path, listedCases(path, join(scratch, `${n}.xml`))]));
      const problems: string[] = [];
      for (const job of profile.jobs) {
        for (const file of job.files) {
          const planned = new Set(file.cases.map(key));
          const cases = listed.get(file.path) ?? new Set<string>();
          for (const testcase of cases) if (!planned.has(testcase)) problems.push(`${job.id}, ${file.path}: not in the profile: ${testcase}`);
          for (const testcase of planned) if (!cases.has(testcase)) problems.push(`${job.id}, ${file.path}: no longer in the file: ${testcase}`);
        }
      }
      expect(problems).toEqual([]);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }, NATIVE_STARTUP_TIMEOUT_MS);
});
