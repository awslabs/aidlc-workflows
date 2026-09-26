// t350: the required "Check Merge Status" job in pull-request-lint.yml keeps
// enforcing the merge locks (open release pull requests, HALT_MERGES) in a
// cancelled run. A newer run superseding this one cancels get-pr-info, and a
// run can also be cancelled with no replacement at all; in both cases the job
// must still evaluate the locks, because a skipped required job counts as
// passing. The step script is run as-is under bash with a stub `gh`.
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO_ROOT } from "../harness/fixtures.ts";

interface Job {
  if?: string;
  needs?: string | string[];
  env?: Record<string, string>;
  steps?: Array<{ run?: string }>;
}

const workflow = Bun.YAML.parse(
  readFileSync(join(REPO_ROOT, ".github", "workflows", "pull-request-lint.yml"), "utf8"),
) as { jobs: Record<string, Job> };
const job = workflow.jobs["check-merge-status"];
const script = job.steps?.[0]?.run ?? "";

// The script needs bash, jq, and GNU grep -P (the merge_group branch), as on
// the ubuntu runner that executes it.
const toolsAvailable =
  spawnSync("bash", ["-c", "command -v jq >/dev/null && echo pr-1 | grep -qP '(?<=pr-)\\d+'"]).status === 0;

const stubDir = mkdtempSync(join(tmpdir(), "t350-gh-"));
afterAll(() => rmSync(stubDir, { recursive: true, force: true }));
// `gh pr list` prints the open pull requests the case supplies.
writeFileSync(join(stubDir, "gh"), `#!/usr/bin/env bash\nprintf "%s\\n" "\${STUB_OPEN_PRS:-[]}"\n`);
chmodSync(join(stubDir, "gh"), 0o755);

function runJob(env: Record<string, string>): { status: number | null; out: string } {
  const result = spawnSync("bash", ["-e", "-c", script], {
    encoding: "utf8",
    env: {
      PATH: `${stubDir}:${process.env.PATH ?? ""}`,
      GITHUB_REPOSITORY: "owner/repo",
      GITHUB_EVENT_NAME: "pull_request_target",
      GITHUB_REF: "refs/pull/1422/merge",
      HALT_MERGES: "0",
      PR_NUMBER_OUTPUT: "",
      PR_NUMBER_INPUT: "",
      ...env,
    },
  });
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
}

describe("t350 Check Merge Status keeps the merge locks in a cancelled run", () => {
  test("the job runs in every run and reads its inputs from env", () => {
    expect(job.if).toBe("always()");
    expect(job.needs).toBe("get-pr-info");
    expect(job.env?.PR_NUMBER_OUTPUT).toBe(`\${{ needs.get-pr-info.outputs.pr_number }}`);
    expect(job.env?.PR_NUMBER_INPUT).toBe(`\${{ github.event.pull_request.number }}`);
    // No inline expressions: the script is runnable as written.
    expect(script).not.toContain("${{");
  });

  test.skipIf(!toolsAvailable)("with get-pr-info's number, an unlocked PR passes", () => {
    const run = runJob({ PR_NUMBER_OUTPUT: "1422" });
    expect(run.status, run.out).toBe(0);
    expect(run.out).toContain("All merges are allowed");
  });

  test.skipIf(!toolsAvailable)("a superseded run resolves the number from the event and passes", () => {
    const run = runJob({ PR_NUMBER_INPUT: "1422" });
    expect(run.status, run.out).toBe(0);
    expect(run.out).toContain("All merges are allowed");
  });

  test.skipIf(!toolsAvailable)("a cancelled run still refuses while HALT_MERGES blocks everything", () => {
    const run = runJob({ PR_NUMBER_INPUT: "1422", HALT_MERGES: "-1" });
    expect(run.status, run.out).toBe(1);
    expect(run.out).toContain("All merges are blocked");
  });

  test.skipIf(!toolsAvailable)("a cancelled run still refuses while another release PR is open", () => {
    const run = runJob({
      PR_NUMBER_INPUT: "1422",
      STUB_OPEN_PRS: '[{"number":99,"headRefName":"release/2.11.0"}]',
    });
    expect(run.status, run.out).toBe(1);
    expect(run.out).toContain("open release pull requests");
  });

  test.skipIf(!toolsAvailable)("a merge group resolves the number from its ref", () => {
    // HALT_MERGES naming this PR passes only if the number resolved to 1422.
    const run = runJob({
      GITHUB_EVENT_NAME: "merge_group",
      GITHUB_REF: "refs/heads/gh-readonly-queue/main/pr-1422-6e57c86ac4b8fc51",
      HALT_MERGES: "1422",
    });
    expect(run.status, run.out).toBe(0);
    expect(run.out).toContain("This PR #1422 is explicitly allowed");
  });

  test.skipIf(!toolsAvailable)("with no number from get-pr-info or the event, the job fails closed", () => {
    const run = runJob({});
    expect(run.status, run.out).toBe(1);
    expect(run.out).toContain("PR number unavailable");
  });
});
