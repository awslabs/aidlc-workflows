// covers: file:scripts/ci-full-suite-evidence.ts
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { AIDLC_VERSION } from "../../core/tools/aidlc-version.ts";
import {
  EVIDENCE_ARTIFACT, type EvidenceRun, evidenceProblems, findEvidence, type GhRunner, untrustedRunReason,
} from "../../scripts/ci-full-suite-evidence.ts";
import {
  FULL_SUITE_JOBS, FULL_VERIFICATION_OMITTED_JOBS, LIVE_VERIFICATION_OMITTED_JOBS, fullSuiteResult, type SuiteNeeds,
} from "../../scripts/ci-full-suite-result.ts";
import { REPO_ROOT } from "../harness/fixtures.ts";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS } from "../harness/test-budget.ts";

const SHA = "a".repeat(40);
const OTHER = "b".repeat(40);
const SCRIPT = join(REPO_ROOT, "scripts/ci-full-suite-evidence.ts");

interface Step { name?: string; id?: string; if?: string; uses?: string; run?: string; env?: Record<string, string>; with?: Record<string, unknown>; "continue-on-error"?: boolean }
interface Job { name?: string; needs?: string | string[]; if?: string; uses?: string; with?: Record<string, string>; permissions?: Record<string, string>; outputs?: Record<string, string>; steps?: Step[]; secrets?: unknown }
const release = Bun.YAML.parse(readFileSync(join(REPO_ROOT, ".github/workflows/release.yml"), "utf8")) as { jobs: Record<string, Job> };
const step = (job: string, name: string) => release.jobs[job].steps!.find((entry) => entry.name === name)!;
const posix = (path: string) => path.replaceAll("\\", "/");

function bash(script: string, cwd: string, env: NodeJS.ProcessEnv) {
  return spawnSync("bash", ["--noprofile", "--norc", "-c", script], {
    cwd, encoding: "utf8", timeout: NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
    env: { ...process.env, ...env, PATH: `${env.PATH ?? ""}${delimiter}${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ""}` },
  });
}

function needs(overrides: Record<string, "success" | "failure" | "cancelled" | "skipped"> = {}): SuiteNeeds {
  return Object.fromEntries(FULL_SUITE_JOBS.map((job) => [job, { result: overrides[job] ?? "success" }]));
}
// The real reducer produces the evidence, so the producer and gate cannot drift apart.
function passing(runId = "41", sha = SHA): Record<string, unknown> {
  return { ...fullSuiteResult(needs(), { sha, runId, runAttempt: "1" }, "release") };
}
function run(overrides: Partial<EvidenceRun> = {}): EvidenceRun {
  return {
    workflow: "preview-release.yml", databaseId: 41, event: "schedule", headBranch: "main", headSha: SHA,
    conclusion: "success", ...overrides,
  };
}

describe("t-ci-full-suite-evidence stable release Full Suite gate", () => {
  test("only a passing release-purpose result for the exact commit and run qualifies", () => {
    expect(evidenceProblems(passing(), SHA, "41")).toEqual([]);
    expect(evidenceProblems(passing(), OTHER, "41")).toEqual([`sha is "${SHA}", not "${OTHER}"`]);
    expect(evidenceProblems(passing(), SHA, "42")).toEqual(['runId is "41", not "42"']);
    for (const [key, value] of [
      ["purpose", "live-verification"], ["verificationFamily", "codex"], ["coveragePolicy", "optional-live"],
      ["passed", false], ["passed", "true"],
    ] as const) {
      expect(evidenceProblems({ ...passing(), [key]: value }, SHA, "41"), key).toHaveLength(1);
    }
    for (const bad of [null, [], "passed", 1]) {
      expect(evidenceProblems(bad, SHA, "41")).toEqual(["the result is not a JSON object"]);
    }
    expect(evidenceProblems({ ...passing(), verificationTest: "tests/e2e/t.test.ts" }, SHA, "41"))
      .toEqual(['verificationTest selects "tests/e2e/t.test.ts"']);
    expect(evidenceProblems({ ...passing(), omittedLegs: ["live_macos"] }, SHA, "41")).toHaveLength(1);
    expect(evidenceProblems({ ...passing(), disabledLegs: ["live_linux"] }, SHA, "41")).toHaveLength(1);
    expect(evidenceProblems({ ...passing(), omittedLegs: undefined }, SHA, "41")).toHaveLength(1);
    expect(evidenceProblems({ ...passing(), excluded: "none" }, SHA, "41")).toEqual(["excluded is not a list"]);
    expect(evidenceProblems({ ...passing(), legs: undefined }, SHA, "41")).toEqual(["legs are missing"]);
  });

  test("every job the commit declares must have succeeded, and so must any extra leg", () => {
    for (const job of FULL_SUITE_JOBS) {
      for (const status of ["failure", "cancelled", "skipped"] as const) {
        // A hand-edited report that claims passed still fails on its legs.
        const report = { ...passing(), legs: { ...(passing().legs as object), [job]: status } };
        expect(evidenceProblems(report, SHA, "41"), `${job}=${status}`).toEqual([`${job}=${status}`]);
      }
      const legs = { ...(passing().legs as Record<string, string>) };
      delete legs[job];
      expect(evidenceProblems({ ...passing(), legs }, SHA, "41"), job).toEqual([`${job}=missing`]);
    }
    // Evidence from before the Linux and macOS live split names live_hosted instead.
    const legacy: Record<string, string> = { ...(passing().legs as Record<string, string>), live_hosted: "success" };
    delete legacy.live_linux;
    delete legacy.live_macos;
    expect(evidenceProblems({ ...passing(), legs: legacy }, SHA, "41")).toEqual(["live_linux=missing", "live_macos=missing"]);
    expect(evidenceProblems({ ...passing(), legs: { ...(passing().legs as object), future: "skipped" } }, SHA, "41"))
      .toEqual(["future=skipped"]);
  });

  test("reducer results that are not ordinary passing release evidence never qualify", () => {
    const identity = { sha: SHA, runId: "41", runAttempt: "1" };
    const live = needs(Object.fromEntries(LIVE_VERIFICATION_OMITTED_JOBS.map((job) => [job, "skipped"])));
    const full = needs(Object.fromEntries(FULL_VERIFICATION_OMITTED_JOBS.map((job) => [job, "skipped"])));
    expect(fullSuiteResult(live, identity, "live-verification").passed).toBe(true);
    expect(fullSuiteResult(full, identity, "full-verification").passed).toBe(true);
    for (const result of [
      fullSuiteResult(live, identity, "live-verification"),
      fullSuiteResult(full, identity, "full-verification"),
      fullSuiteResult(needs({ live_macos: "failure" }), identity, "release"),
      fullSuiteResult(needs(), identity, "release", "codex"),
    ]) {
      expect(evidenceProblems({ ...result }, SHA, "41").length, JSON.stringify(result.legs)).toBeGreaterThan(0);
    }
  });

  test("evidence comes only from reviewed main workflows: previews of the tag or Full Suite dispatches on main", () => {
    const onMain = (commit: string) => commit === OTHER;
    expect(untrustedRunReason(run(), SHA, onMain)).toBeUndefined();
    expect(untrustedRunReason(run({ event: "workflow_dispatch" }), SHA, onMain)).toBeUndefined();
    expect(untrustedRunReason(run({ headSha: OTHER }), SHA, onMain)).toBe(`previewed ${OTHER}`);
    expect(untrustedRunReason(run({ event: "push" }), SHA, onMain)).toBe("was triggered by push");
    expect(untrustedRunReason(run({ headBranch: "candidate" }), SHA, onMain)).toBe("ran on candidate");
    expect(untrustedRunReason(run({ conclusion: "failure" }), SHA, onMain)).toBe("concluded failure");
    // A manual dispatch tests its ref input from main's workflow, so its own head may differ from the tag.
    const dispatch = run({ workflow: "full-suite.yml", event: "workflow_dispatch", headSha: OTHER });
    expect(untrustedRunReason(dispatch, SHA, onMain)).toBeUndefined();
    expect(untrustedRunReason({ ...dispatch, headSha: SHA }, SHA, onMain))
      .toBe(`ran a workflow from ${SHA}, which is not on main`);
    expect(untrustedRunReason({ ...dispatch, headSha: "main" }, SHA, () => true))
      .toBe("ran a workflow from main, which is not on main");
    expect(untrustedRunReason({ ...dispatch, event: "workflow_call" }, SHA, onMain)).toBe("was triggered by workflow_call");
    expect(untrustedRunReason({ ...dispatch, conclusion: "cancelled" }, SHA, onMain)).toBe("concluded cancelled");
  });

  test("the search reuses the first trusted run whose downloaded result qualifies", () => {
    const scratch = mkdtempSync(join(tmpdir(), "t-ci-full-suite-evidence-"));
    try {
      const calls: string[][] = [];
      const artifacts: Record<string, unknown> = {
        10: passing("10"), 11: { ...passing("11"), passed: false }, 20: passing("99"), 21: passing("21"),
      };
      const listed: Record<string, Array<Omit<EvidenceRun, "workflow">>> = {
        "preview-release.yml": [
          { ...run({ databaseId: 11 }) }, { ...run({ databaseId: 12, headSha: OTHER }) }, { ...run({ databaseId: 13 }) },
        ],
        "full-suite.yml": [
          { ...run({ databaseId: 20, event: "workflow_dispatch", headSha: OTHER }) },
          { ...run({ databaseId: 21, event: "workflow_dispatch", headSha: OTHER }) },
          { ...run({ databaseId: 10, event: "workflow_dispatch", headSha: OTHER }) },
        ],
      };
      const gh: GhRunner = (args) => {
        calls.push(args);
        if (args[0] === "run" && args[1] === "list") {
          const workflow = args[args.indexOf("--workflow") + 1];
          return { status: 0, stdout: JSON.stringify(listed[workflow]), stderr: "" };
        }
        const id = args[2];
        if (args[0] !== "run" || args[1] !== "download" || !(id in artifacts)) return { status: 1, stdout: "", stderr: "no artifact" };
        const directory = args[args.indexOf("--dir") + 1];
        mkdirSync(directory, { recursive: true });
        writeFileSync(join(directory, "full-suite-result.json"), JSON.stringify(artifacts[id]));
        return { status: 0, stdout: "", stderr: "" };
      };
      const log: string[] = [];
      const found = findEvidence({ sha: SHA, repository: "o/r", gh, onMain: (commit) => commit === OTHER, scratch, log: (line) => log.push(line) });
      expect(found).toBe("21");
      expect(calls.slice(0, 2)).toEqual([
        ["run", "list", "--repo", "o/r", "--workflow", "preview-release.yml", "--commit", SHA,
          "--status", "success", "--limit", "100", "--json", "databaseId,event,headBranch,headSha,conclusion"],
        ["run", "list", "--repo", "o/r", "--workflow", "full-suite.yml", "--branch", "main", "--event", "workflow_dispatch",
          "--status", "success", "--limit", "100", "--json", "databaseId,event,headBranch,headSha,conclusion"],
      ]);
      // An untrusted run is never downloaded; the search stops at the first qualifying result.
      expect(calls.slice(2).map((args) => args[2])).toEqual(["11", "13", "20", "21"]);
      expect(calls[2]).toEqual(["run", "download", "11", "--repo", "o/r", "--name", EVIDENCE_ARTIFACT, "--dir", join(scratch, "11")]);
      expect(log).toEqual([
        "preview-release.yml run 11 does not qualify: passed is false, not true",
        `preview-release.yml run 12 previewed ${OTHER}; not used`,
        "preview-release.yml run 13 has no full-suite-result artifact (missing or expired)",
        'full-suite.yml run 20 does not qualify: runId is "99", not "20"',
      ]);
      expect(findEvidence({ sha: OTHER, repository: "o/r", gh, onMain: () => false, scratch, log: () => {} })).toBeUndefined();
      expect(() => findEvidence({
        sha: SHA, repository: "o/r", gh: () => ({ status: 4, stdout: "", stderr: "HTTP 403" }), onMain: () => true, scratch, log: () => {},
      })).toThrow("gh run list --workflow preview-release.yml failed: HTTP 403");
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  test("check refuses publication without a passing result and records the verified commit", () => {
    const root = mkdtempSync(join(tmpdir(), "t-ci-full-suite-evidence-cli-"));
    const check = (runId: string, file: string, sha = SHA) => {
      const output = join(root, "output");
      writeFileSync(output, "");
      const result = spawnSync(process.execPath, [SCRIPT, "check", "--sha", sha, "--run-id", runId, "--file", file], {
        encoding: "utf8", timeout: NATIVE_STARTUP_TIMEOUT_MS, env: { ...process.env, GITHUB_OUTPUT: output },
      });
      return { ...result, output: readFileSync(output, "utf8") };
    };
    try {
      const file = join(root, "full-suite-result.json");
      writeFileSync(file, JSON.stringify(passing("41")));
      const accepted = check("41", file);
      expect(accepted.status, accepted.stderr).toBe(0);
      expect(accepted.stdout).toContain(`Full Suite run 41 passed for ${SHA}`);
      expect(accepted.stderr).toContain(`::warning::Full Suite evidence for ${SHA} excludes families:`);
      expect(accepted.output).toBe(`sha=${SHA}\nrun_id=41\n`);
      for (const [runId, path, sha, detail] of [
        ["42", file, SHA, 'runId is "41", not "42"'],
        ["41", file, OTHER, `sha is "${SHA}", not "${OTHER}"`],
        ["41", join(root, "missing.json"), SHA, "run 41 left no readable full-suite-result artifact"],
      ]) {
        const refused = check(runId, path, sha);
        expect(refused.status, refused.stderr).toBe(1);
        expect(refused.stderr).toContain(`::error::Stable publication refused: no passing release-purpose Full Suite for ${sha}.`);
        expect(refused.stderr).toContain(detail);
        expect(refused.output).toBe("");
      }
      writeFileSync(file, JSON.stringify({ ...passing("41"), passed: false, legs: { ...(passing().legs as object), live_linux: "failure" } }));
      const failed = check("41", file);
      expect(failed.status).toBe(1);
      expect(failed.stderr).toContain("passed is false, not true, live_linux=failure");
      for (const args of [["check", "--sha", "main", "--run-id", "1", "--file", file], ["check", "--sha", SHA], ["other", "--sha", SHA]]) {
        const invalid = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", timeout: NATIVE_STARTUP_TIMEOUT_MS });
        expect(invalid.status, args.join(" ")).toBe(2);
        expect(invalid.stderr).toContain("Usage: bun scripts/ci-full-suite-evidence.ts");
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("a failed search falls back to running the Full Suite instead of blocking the release", () => {
    const root = mkdtempSync(join(tmpdir(), "t-ci-full-suite-evidence-find-"));
    try {
      const output = join(root, "output");
      writeFileSync(output, "");
      // Only Bun is reachable, so the gh search fails as it would during an API outage.
      const result = spawnSync(process.execPath, [SCRIPT, "find", "--sha", SHA, "--repository", "o/r"], {
        cwd: root, encoding: "utf8", timeout: NATIVE_STARTUP_TIMEOUT_MS,
        env: { ...process.env, PATH: dirname(process.execPath), GITHUB_OUTPUT: output },
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("::warning::Could not search earlier runs for Full Suite evidence:");
      expect(result.stdout).toContain(`No earlier passing Full Suite result for ${SHA}; this release runs the Full Suite`);
      expect(readFileSync(output, "utf8")).toBe("run_id=\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
});

describe("t-ci-full-suite-evidence release.yml wiring", () => {
  test("the gate reruns only when needed and publication waits for its verified commit", () => {
    const jobs = release.jobs;
    expect(jobs.full_suite_evidence).toMatchObject({ needs: "validate", permissions: { actions: "read", contents: "read" } });
    expect(jobs.full_suite_evidence.outputs).toEqual({ run_id: `\${{ steps.find.outputs.run_id }}` });
    expect(step("full_suite_evidence", "Find a passing Full Suite for the tagged commit").run)
      .toContain('bun scripts/ci-full-suite-evidence.ts find --sha "$TAG_SHA" --repository "$GITHUB_REPOSITORY"');
    // Mirrors the preview call, including secrets: inherit for the live jobs' environment secret.
    expect(jobs.full_suite).toEqual({
      needs: ["validate", "full_suite_evidence"],
      if: "needs.full_suite_evidence.outputs.run_id == ''",
      permissions: { contents: "read", "id-token": "write" },
      uses: "./.github/workflows/full-suite.yml",
      secrets: "inherit",
      with: { ref: `\${{ needs.validate.outputs.sha }}` },
    });
    expect(jobs.full_suite_gate).toMatchObject({
      name: "Require a passing Full Suite",
      needs: ["validate", "full_suite_evidence", "full_suite"],
      if: `\${{ !cancelled() && needs.validate.result == 'success' && needs.full_suite_evidence.result == 'success' }}`,
      permissions: { actions: "read", contents: "read" },
      outputs: { sha: `\${{ steps.check.outputs.sha }}` },
    });
    expect(step("full_suite_gate", "Download this run's Full Suite result")).toMatchObject({
      if: "needs.full_suite_evidence.outputs.run_id == ''", "continue-on-error": true, with: { name: EVIDENCE_ARTIFACT },
    });
    expect(step("full_suite_gate", "Download the reused Full Suite result")).toMatchObject({
      if: "needs.full_suite_evidence.outputs.run_id != ''", "continue-on-error": true,
    });
    expect(step("full_suite_gate", "Download the reused Full Suite result").run).toContain(`--name ${EVIDENCE_ARTIFACT}`);
    for (const name of ["publish", "release"]) {
      const needs = jobs[name].needs as string[];
      expect(needs, name).toContain("full_suite_gate");
      // full_suite is skipped when evidence is reused; implicit success() would skip publication.
      expect(jobs[name].if, name).toStartWith("${{ !cancelled() && ");
      for (const need of needs) expect(jobs[name].if, `${name} requires ${need}`).toContain(`needs.${need}.result == 'success'`);
      const recheck = step(name, "Recheck release source");
      expect(recheck.env?.FULL_SUITE_SHA).toBe(`\${{ needs.full_suite_gate.outputs.sha }}`);
      expect(recheck.run).toContain('test "$FULL_SUITE_SHA" = "$AUTHORIZED_SHA"');
    }
    // Builds and lifecycle checks run alongside the suite instead of waiting for it.
    for (const name of ["verify", "native-smoke", "build", "musl-smoke", "stage-release", "windows-lifecycle", "unix-lifecycle"]) {
      const needs = [jobs[name].needs ?? []].flat();
      expect(needs.some((need) => need.startsWith("full_suite")), name).toBe(false);
    }
    expect(jobs["release-result"].needs).toEqual(["validate", "full_suite_gate", "release"]);
    expect(step("release-result", "Require a passing Full Suite")).toMatchObject({
      if: `\${{ !cancelled() && needs.validate.result == 'success' }}`,
      env: { GATE_RESULT: `\${{ needs.full_suite_gate.result }}` },
    });
  });

  test("the gate check requires the called suite to succeed and binds the result to its run", () => {
    const check = step("full_suite_gate", "Require a passing Full Suite for the tagged commit");
    expect(check.env).toEqual({
      TAG_SHA: `\${{ needs.validate.outputs.sha }}`,
      REUSED_RUN_ID: `\${{ needs.full_suite_evidence.outputs.run_id }}`,
      FULL_SUITE_RESULT: `\${{ needs.full_suite.result }}`,
    });
    const root = mkdtempSync(join(tmpdir(), "t-ci-full-suite-evidence-gate-"));
    try {
      mkdirSync(join(root, "full-suite-evidence"));
      const output = join(root, "output");
      const gate = (result: unknown, env: Record<string, string>) => {
        writeFileSync(output, "");
        const file = join(root, "full-suite-evidence", "full-suite-result.json");
        rmSync(file, { force: true });
        if (result !== undefined) writeFileSync(file, JSON.stringify(result));
        const outcome = bash(check.run!, REPO_ROOT, {
          TAG_SHA: SHA, GITHUB_RUN_ID: "700", RUNNER_TEMP: posix(root), GITHUB_OUTPUT: posix(output), ...env,
        });
        return { ...outcome, output: readFileSync(output, "utf8") };
      };
      const called = gate(passing("700"), { REUSED_RUN_ID: "", FULL_SUITE_RESULT: "success" });
      expect(called.status, called.stderr).toBe(0);
      expect(called.output).toBe(`sha=${SHA}\nrun_id=700\n`);
      const reused = gate(passing("555"), { REUSED_RUN_ID: "555", FULL_SUITE_RESULT: "skipped" });
      expect(reused.status, reused.stderr).toBe(0);
      expect(reused.output).toBe(`sha=${SHA}\nrun_id=555\n`);
      // A called suite that did not succeed refuses publication even beside a passing file.
      const failed = gate(passing("700"), { REUSED_RUN_ID: "", FULL_SUITE_RESULT: "failure" });
      expect(failed.status).toBe(1);
      expect(failed.stdout).toContain(`::error::The Full Suite this release ran for ${SHA} ended with result failure`);
      for (const [result, env] of [
        [passing("700"), { REUSED_RUN_ID: "555", FULL_SUITE_RESULT: "skipped" }],
        [passing("555", OTHER), { REUSED_RUN_ID: "555", FULL_SUITE_RESULT: "skipped" }],
        [undefined, { REUSED_RUN_ID: "", FULL_SUITE_RESULT: "failure" }],
        [undefined, { REUSED_RUN_ID: "555", FULL_SUITE_RESULT: "skipped" }],
      ] as const) {
        const refused = gate(result, env);
        expect(refused.status, JSON.stringify(env)).toBe(1);
        expect(refused.stderr).toContain("::error::Stable publication refused");
        expect(refused.output).toBe("");
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("a tag outside main fails validation with the Full Suite reason", () => {
    const validate = step("validate", "Validate release tag and source");
    const root = mkdtempSync(join(tmpdir(), "t-ci-full-suite-evidence-validate-"));
    try {
      const bin = join(root, "bin");
      mkdirSync(bin);
      // Only the OS boundary is faked: every ref resolves to the tag commit.
      writeFileSync(join(bin, "git"), [
        "#!/usr/bin/env bash",
        'case "$1" in',
        '  fetch) exit 0 ;;',
        `  rev-parse) printf "%s\\n" "${SHA}" ;;`,
        '  merge-base) exit "$FIXTURE_ANCESTOR" ;;',
        '  *) exit 2 ;;',
        "esac",
      ].join("\n"));
      chmodSync(join(bin, "git"), 0o755);
      const tag = `v${AIDLC_VERSION}`;
      const run = (ancestor: string) => {
        const output = join(root, "output");
        writeFileSync(output, "");
        const outcome = bash(validate.run!, REPO_ROOT, {
          PATH: bin, FIXTURE_ANCESTOR: ancestor, RELEASE_TAG: tag, GITHUB_EVENT_NAME: "push",
          GITHUB_REF: `refs/tags/${tag}`, GITHUB_SHA: SHA, GITHUB_OUTPUT: posix(output),
        });
        return { ...outcome, output: readFileSync(output, "utf8") };
      };
      const outside = run("1");
      expect(outside.status).toBe(1);
      expect(outside.stdout).toContain(`::error::${tag} points at ${SHA}, which is not on main.`);
      expect(outside.stdout).toContain("only tests commits already on main");
      expect(outside.output).toBe("");
      const onMain = run("0");
      expect(onMain.status, onMain.stdout + onMain.stderr).toBe(0);
      expect(onMain.output).toBe(`tag=${tag}\nsha=${SHA}\n`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
});
