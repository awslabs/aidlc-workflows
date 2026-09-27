// t350: the two required merge-policy jobs in pull-request-lint.yml keep
// enforcing their locks in a cancelled run. "Check Merge Status" holds the
// open-release and HALT_MERGES locks; "Fail by Label" holds the do-not-merge
// label. A newer run superseding this one cancels get-pr-info, and a run can
// also be cancelled with no replacement at all; in both cases each job must
// still evaluate its lock from the event, because a skipped or blind required
// job counts as passing. Each step script runs as-is under bash with a stub
// `gh`, in GitHub's default shell mode (-e -o pipefail).
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO_ROOT } from "../harness/fixtures.ts";

interface Job {
  if?: string;
  needs?: string | string[];
  permissions?: Record<string, string>;
  env?: Record<string, string>;
  steps?: Array<{ run?: string }>;
}

const workflow = Bun.YAML.parse(
  readFileSync(join(REPO_ROOT, ".github", "workflows", "pull-request-lint.yml"), "utf8"),
) as { jobs: Record<string, Job> };
const MERGE_STATUS = "check-merge-status";
const FAIL_BY_LABEL = "fail-by-label";

// The scripts need bash, jq, and GNU grep -P (the merge_group branch), as on
// the ubuntu runner that executes them.
const toolsAvailable =
  spawnSync("bash", ["-c", "command -v jq >/dev/null && echo pr-1 | grep -qP '(?<=pr-)\\d+'"]).status === 0;

const stubDir = mkdtempSync(join(tmpdir(), "t350-gh-"));
afterAll(() => rmSync(stubDir, { recursive: true, force: true }));
// `gh api .../pulls/N` prints the pull request the case supplies (nothing when
// unset); `gh pr list` prints the open pull requests the case supplies.
writeFileSync(
  join(stubDir, "gh"),
  `#!/usr/bin/env bash\nif [ "$1" = "api" ]; then printf "%s\\n" "\${STUB_PR_JSON:-}"; else printf "%s\\n" "\${STUB_OPEN_PRS:-[]}"; fi\n`,
);
chmodSync(join(stubDir, "gh"), 0o755);

// A pull_request_target run whose get-pr-info did not finish: every
// get-pr-info output is empty, and the event still carries the PR.
const CANCELLED_PR_EVENT = {
  GITHUB_EVENT_NAME: "pull_request_target",
  GITHUB_REF: "refs/pull/1422/merge",
  PR_NUMBER_INPUT: "1422",
};
const MERGE_GROUP_REF = "refs/heads/gh-readonly-queue/main/pr-1422-6e57c86ac4b8fc51";
// toJson(github.event.pull_request.labels.*.name) renders indented JSON.
const eventLabels = (...names: string[]): string => JSON.stringify(names, null, 2);

function runJob(name: string, env: Record<string, string>): { status: number | null; out: string } {
  const script = workflow.jobs[name]?.steps?.[0]?.run ?? "";
  const result = spawnSync("bash", ["-e", "-o", "pipefail", "-c", script], {
    encoding: "utf8",
    env: {
      PATH: `${stubDir}:${process.env.PATH ?? ""}`,
      GITHUB_REPOSITORY: "owner/repo",
      GITHUB_EVENT_NAME: "pull_request_target",
      GITHUB_REF: "refs/pull/1422/merge",
      HALT_MERGES: "0",
      DO_NOT_MERGE_LABEL: "do-not-merge",
      PR_NUMBER_OUTPUT: "",
      PR_NUMBER_INPUT: "",
      PR_LABELS_OUTPUT: "",
      PR_LABELS_EVENT: "[]",
      ...env,
    },
  });
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
}

describe("t350 the merge-policy jobs run in every run and read inputs from env", () => {
  test.each([MERGE_STATUS, FAIL_BY_LABEL])("%s", (name) => {
    const job = workflow.jobs[name];
    expect(job.if).toBe("always()");
    expect(job.needs).toBe("get-pr-info");
    expect(job.permissions).toEqual({ "pull-requests": "read" });
    expect(job.steps).toHaveLength(1);
    // No inline expressions: the script is runnable as written.
    expect(job.steps?.[0]?.run ?? "").not.toContain("${{");
  });

  test("each job reads get-pr-info's output and the event through env", () => {
    expect(workflow.jobs[MERGE_STATUS].env).toMatchObject({
      PR_NUMBER_OUTPUT: `\${{ needs.get-pr-info.outputs.pr_number }}`,
      PR_NUMBER_INPUT: `\${{ github.event.pull_request.number }}`,
    });
    expect(workflow.jobs[FAIL_BY_LABEL].env).toMatchObject({
      PR_LABELS_OUTPUT: `\${{ needs.get-pr-info.outputs.pr_labels }}`,
      PR_LABELS_EVENT: `\${{ toJson(github.event.pull_request.labels.*.name) }}`,
    });
  });
});

describe.skipIf(!toolsAvailable)("t350 Check Merge Status keeps the merge locks in a cancelled run", () => {
  test("with get-pr-info's number, an unlocked PR passes", () => {
    const run = runJob(MERGE_STATUS, { PR_NUMBER_OUTPUT: "1422" });
    expect(run.status, run.out).toBe(0);
    expect(run.out).toContain("All merges are allowed");
  });

  test("a superseded run resolves the number from the event and passes", () => {
    const run = runJob(MERGE_STATUS, CANCELLED_PR_EVENT);
    expect(run.status, run.out).toBe(0);
    expect(run.out).toContain("All merges are allowed");
  });

  test("a cancelled run still refuses while HALT_MERGES blocks everything", () => {
    const run = runJob(MERGE_STATUS, { ...CANCELLED_PR_EVENT, HALT_MERGES: "-1" });
    expect(run.status, run.out).toBe(1);
    expect(run.out).toContain("All merges are blocked");
  });

  test("a cancelled run still refuses while another release PR is open", () => {
    const run = runJob(MERGE_STATUS, {
      ...CANCELLED_PR_EVENT,
      STUB_OPEN_PRS: '[{"number":99,"headRefName":"release/2.11.0"}]',
    });
    expect(run.status, run.out).toBe(1);
    expect(run.out).toContain("open release pull requests");
  });

  test("a merge group resolves the number from its ref", () => {
    // HALT_MERGES naming this PR passes only if the number resolved to 1422.
    const run = runJob(MERGE_STATUS, {
      GITHUB_EVENT_NAME: "merge_group",
      GITHUB_REF: MERGE_GROUP_REF,
      HALT_MERGES: "1422",
    });
    expect(run.status, run.out).toBe(0);
    expect(run.out).toContain("This PR #1422 is explicitly allowed");
  });

  test("with no number from get-pr-info or the event, the job fails closed", () => {
    const run = runJob(MERGE_STATUS, {});
    expect(run.status, run.out).toBe(1);
    expect(run.out).toContain("PR number unavailable");
  });
});

describe.skipIf(!toolsAvailable)("t350 Fail by Label keeps the do-not-merge lock in a cancelled run", () => {
  test("with get-pr-info's labels, an unlabelled PR passes and a labelled one fails", () => {
    const clean = runJob(FAIL_BY_LABEL, { PR_LABELS_OUTPUT: '["documentation"]' });
    expect(clean.status, clean.out).toBe(0);
    const blocked = runJob(FAIL_BY_LABEL, { PR_LABELS_OUTPUT: '["documentation","do-not-merge"]' });
    expect(blocked.status, blocked.out).toBe(1);
    expect(blocked.out).toContain('The label "do-not-merge" is used to prevent merging');
  });

  test("a cancelled run reads the labels from the event and still refuses a labelled PR", () => {
    const blocked = runJob(FAIL_BY_LABEL, { ...CANCELLED_PR_EVENT, PR_LABELS_EVENT: eventLabels("do-not-merge") });
    expect(blocked.status, blocked.out).toBe(1);
    expect(blocked.out).toContain("is used to prevent merging");
    const clean = runJob(FAIL_BY_LABEL, { ...CANCELLED_PR_EVENT, PR_LABELS_EVENT: eventLabels("documentation") });
    expect(clean.status, clean.out).toBe(0);
    expect(clean.out).toContain('The label "do-not-merge" is absent');
  });

  test("a cancelled merge group reads the labels from the API", () => {
    const pr = (...names: string[]) => JSON.stringify({ number: 1422, labels: names.map((name) => ({ name })) });
    const group = { GITHUB_EVENT_NAME: "merge_group", GITHUB_REF: MERGE_GROUP_REF, PR_LABELS_EVENT: "[]" };
    const blocked = runJob(FAIL_BY_LABEL, { ...group, STUB_PR_JSON: pr("do-not-merge") });
    expect(blocked.status, blocked.out).toBe(1);
    const clean = runJob(FAIL_BY_LABEL, { ...group, STUB_PR_JSON: pr("documentation") });
    expect(clean.status, clean.out).toBe(0);
  });

  test("labels that cannot be read fail closed", () => {
    // A merge group whose ref names no PR, and one whose API read returns nothing.
    const noNumber = runJob(FAIL_BY_LABEL, { GITHUB_EVENT_NAME: "merge_group", GITHUB_REF: "refs/heads/main" });
    expect(noNumber.status, noNumber.out).toBe(1);
    expect(noNumber.out).toContain("PR labels unavailable");
    const noApi = runJob(FAIL_BY_LABEL, { GITHUB_EVENT_NAME: "merge_group", GITHUB_REF: MERGE_GROUP_REF });
    expect(noApi.status, noApi.out).toBe(1);
    expect(noApi.out).toContain("PR labels unavailable");
  });
});

describe.skipIf(!toolsAvailable)("t350 a cancelled run blocks a labelled PR across the required checks", () => {
  test("merge status passes but the label lock fails, so the combined outcome refuses", () => {
    const env = { ...CANCELLED_PR_EVENT, PR_LABELS_EVENT: eventLabels("do-not-merge") };
    expect(runJob(MERGE_STATUS, env).status).toBe(0);
    expect(runJob(FAIL_BY_LABEL, env).status).toBe(1);
  });

  test("an unlabelled, unlocked PR passes both", () => {
    const env = { ...CANCELLED_PR_EVENT, PR_LABELS_EVENT: eventLabels("documentation") };
    expect(runJob(MERGE_STATUS, env).status).toBe(0);
    expect(runJob(FAIL_BY_LABEL, env).status).toBe(0);
  });
});
