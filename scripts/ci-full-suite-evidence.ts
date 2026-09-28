// Stable releases publish only after a release-purpose Full Suite passed for the
// exact tagged commit. `find` looks for that result in a trusted earlier run, so
// release.yml can reuse it instead of running the suite again; `check` validates
// the result file publication relies on, whichever run produced it.
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SUBPROCESS_TIMEOUT_MS } from "../core/tools/aidlc-runtime-budget.ts";
import { FULL_SUITE_COVERAGE_POLICY, FULL_SUITE_JOBS } from "./ci-full-suite-result.ts";

export const EVIDENCE_ARTIFACT = "full-suite-result";
const COMMIT = /^[a-f0-9]{40}$/;
const RUN_FIELDS = "databaseId,event,headBranch,headSha,conclusion";

/** Why a full-suite-result cannot qualify a stable release of `sha`; empty when it does. */
export function evidenceProblems(result: unknown, sha: string, runId: string): string[] {
  if (typeof result !== "object" || result === null || Array.isArray(result)) return ["the result is not a JSON object"];
  const report = result as Record<string, unknown>;
  const problems: string[] = [];
  // The result must name this commit and the run it was downloaded from.
  const expected: Record<string, unknown> = {
    sha, runId, purpose: "release", verificationFamily: "all", coveragePolicy: FULL_SUITE_COVERAGE_POLICY, passed: true,
  };
  for (const [key, value] of Object.entries(expected)) {
    if (report[key] !== value) problems.push(`${key} is ${JSON.stringify(report[key])}, not ${JSON.stringify(value)}`);
  }
  if (report.verificationTest !== undefined) problems.push(`verificationTest selects ${JSON.stringify(report.verificationTest)}`);
  for (const key of ["omittedLegs", "disabledLegs"]) {
    const value = report[key];
    if (!Array.isArray(value) || value.length > 0) problems.push(`${key} is ${JSON.stringify(value)}, not []`);
  }
  if (!Array.isArray(report.excluded)) problems.push("excluded is not a list");
  const legs = report.legs;
  if (typeof legs !== "object" || legs === null || Array.isArray(legs)) {
    problems.push("legs are missing");
  } else {
    // Every job this commit declares must pass, and so must any extra leg.
    const statuses = legs as Record<string, unknown>;
    for (const job of new Set<string>([...FULL_SUITE_JOBS, ...Object.keys(statuses)])) {
      if (statuses[job] !== "success") problems.push(`${job}=${String(statuses[job] ?? "missing")}`);
    }
  }
  return problems;
}

export type EvidenceWorkflow = "preview-release.yml" | "full-suite.yml";
export interface EvidenceRun {
  workflow: EvidenceWorkflow;
  databaseId: number;
  event: string;
  headBranch: string;
  headSha: string;
  conclusion: string;
}

/**
 * Evidence counts only from reviewed workflow definitions on main: a
 * successful preview of the tagged commit itself, or a successful manual Full
 * Suite dispatch on main. A dispatch tests its `ref` input, so its own head
 * need not be the tag, only a commit on main; its result names the tested SHA.
 */
export function untrustedRunReason(run: EvidenceRun, sha: string, onMain: (commit: string) => boolean): string | undefined {
  if (run.conclusion !== "success") return `concluded ${run.conclusion}`;
  if (run.headBranch !== "main") return `ran on ${run.headBranch}`;
  if (run.workflow === "preview-release.yml") {
    if (run.event !== "schedule" && run.event !== "workflow_dispatch") return `was triggered by ${run.event}`;
    return run.headSha === sha ? undefined : `previewed ${run.headSha}`;
  }
  if (run.event !== "workflow_dispatch") return `was triggered by ${run.event}`;
  return COMMIT.test(run.headSha) && onMain(run.headSha) ? undefined : `ran a workflow from ${run.headSha}, which is not on main`;
}

export type GhRunner = (args: string[]) => { status: number | null; stdout: string; stderr: string };

/** Successful preview runs of `sha`, then successful manual Full Suite dispatches on main, newest first. */
export function evidenceRuns(gh: GhRunner, repository: string, sha: string): EvidenceRun[] {
  const queries: Array<[EvidenceWorkflow, string[]]> = [
    ["preview-release.yml", ["--commit", sha]],
    ["full-suite.yml", ["--branch", "main", "--event", "workflow_dispatch"]],
  ];
  return queries.flatMap(([workflow, filters]) => {
    const listed = gh(["run", "list", "--repo", repository, "--workflow", workflow, ...filters,
      "--status", "success", "--limit", "100", "--json", RUN_FIELDS]);
    if (listed.status !== 0) throw new Error(`gh run list --workflow ${workflow} failed: ${listed.stderr.trim()}`);
    const rows = JSON.parse(listed.stdout) as unknown;
    if (!Array.isArray(rows)) throw new Error(`gh run list --workflow ${workflow} did not return a list`);
    return rows.map((row) => ({ ...(row as Omit<EvidenceRun, "workflow">), workflow }));
  });
}

/** The id of the first trusted run whose downloaded result qualifies `sha`, if any. */
export function findEvidence(options: {
  sha: string;
  repository: string;
  gh: GhRunner;
  onMain: (commit: string) => boolean;
  scratch: string;
  log: (line: string) => void;
}): string | undefined {
  const { sha, repository, gh, onMain, scratch, log } = options;
  for (const run of evidenceRuns(gh, repository, sha)) {
    const id = String(run.databaseId);
    const label = `${run.workflow} run ${id}`;
    const reason = untrustedRunReason(run, sha, onMain);
    if (reason) {
      log(`${label} ${reason}; not used`);
      continue;
    }
    const directory = join(scratch, id);
    if (gh(["run", "download", id, "--repo", repository, "--name", EVIDENCE_ARTIFACT, "--dir", directory]).status !== 0) {
      log(`${label} has no ${EVIDENCE_ARTIFACT} artifact (missing or expired)`);
      continue;
    }
    let result: unknown;
    try {
      result = JSON.parse(readFileSync(join(directory, "full-suite-result.json"), "utf8"));
    } catch {
      log(`${label} has no readable full-suite-result.json`);
      continue;
    }
    const problems = evidenceProblems(result, sha, id);
    if (problems.length === 0) return id;
    log(`${label} does not qualify: ${problems.join(", ")}`);
  }
  return undefined;
}

function option(args: readonly string[], name: string): string {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (!value || value.startsWith("--") || args.indexOf(name, index + 1) >= 0) throw new Error(`expected exactly one ${name}`);
  return value;
}

function main(argv: readonly string[]): number {
  const [command, ...args] = argv;
  const sha = option(args, "--sha");
  if (!COMMIT.test(sha)) throw new Error("--sha must be a 40-character commit SHA");
  if (command === "find") {
    const repository = option(args, "--repository");
    const scratch = mkdtempSync(join(tmpdir(), "aidlc-full-suite-evidence-"));
    let runId: string | undefined;
    try {
      runId = findEvidence({
        sha, repository, scratch, log: (line) => console.log(line),
        gh: (ghArgs) => {
          const result = spawnSync("gh", ghArgs, { encoding: "utf8", timeout: DEFAULT_SUBPROCESS_TIMEOUT_MS });
          return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? String(result.error ?? "") };
        },
        onMain: (commit) => spawnSync("git", ["merge-base", "--is-ancestor", commit, "origin/main"], {
          timeout: DEFAULT_SUBPROCESS_TIMEOUT_MS,
        }).status === 0,
      });
    } catch (error) {
      // Searching is an optimization: without it the release runs the suite itself.
      console.log(`::warning::Could not search earlier runs for Full Suite evidence: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
    console.log(runId
      ? `Reusing the passing Full Suite result of run ${runId} for ${sha}`
      : `No earlier passing Full Suite result for ${sha}; this release runs the Full Suite`);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `run_id=${runId ?? ""}\n`);
    return 0;
  }
  if (command === "check") {
    const runId = option(args, "--run-id");
    const file = option(args, "--file");
    let result: unknown;
    let problems: string[];
    try {
      result = JSON.parse(readFileSync(file, "utf8"));
      problems = evidenceProblems(result, sha, runId);
    } catch {
      problems = [`run ${runId} left no readable ${EVIDENCE_ARTIFACT} artifact`];
    }
    if (problems.length > 0) {
      console.error(`::error::Stable publication refused: no passing release-purpose Full Suite for ${sha}. ` +
        `Run ${runId}: ${problems.join(", ")}`);
      return 1;
    }
    const excluded = (result as { excluded: unknown[] }).excluded;
    if (excluded.length > 0) console.error(`::warning::Full Suite evidence for ${sha} excludes families: ${excluded.join(", ")}`);
    console.log(`Full Suite run ${runId} passed for ${sha}`);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `sha=${sha}\nrun_id=${runId}\n`);
    return 0;
  }
  throw new Error(`unknown command: ${command ?? ""}`);
}

if (import.meta.main) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error("Usage: bun scripts/ci-full-suite-evidence.ts find --sha SHA --repository OWNER/REPO\n" +
      "       bun scripts/ci-full-suite-evidence.ts check --sha SHA --run-id ID --file full-suite-result.json");
    process.exitCode = 2;
  }
}
