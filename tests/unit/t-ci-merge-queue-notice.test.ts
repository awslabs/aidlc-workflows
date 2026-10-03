import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Annotation,
  type DropFacts,
  type Job,
  loadFacts,
  noticeFor,
  type QueueEvent,
  queuedPullRequest,
} from "../../.github/scripts/merge-queue-notice.ts";
import { REPO_ROOT } from "../harness/fixtures.ts";

// Trimmed records of real merge-queue drops (jobs, failure annotations, and
// the queue's removal event). Steps are kept only on jobs a rule reads: red
// jobs and jobs still open when the queue gave up.
interface Fixture {
  run: { headSha: string; url: string };
  removal: QueueEvent;
  annotations: Record<string, Annotation[]>;
  jobs: Job[];
}
const fixture = (name: string): Fixture =>
  JSON.parse(readFileSync(join(REPO_ROOT, "tests/fixtures/merge-queue-notice", `${name}.json`), "utf8"));

// The PR as it stood right after the drop: open, out of the queue, added once
// before its merge group ran, and touching no workflow file.
function facts(name: string, pr: Partial<DropFacts["pr"]> = {}, edit?: (record: Fixture) => void): DropFacts {
  const record = fixture(name);
  edit?.(record);
  return {
    run: record.run,
    jobs: record.jobs,
    annotations: record.annotations,
    pr: {
      state: "OPEN",
      inQueue: false,
      files: ["core/tools/aidlc-utility.ts"],
      events: [{ kind: "added", createdAt: "2026-09-01T00:00:00Z" }, record.removal],
      botComments: [],
      ...pr,
    },
  };
}

const notice = (jobs: string, url: string) =>
  `This PR left the merge queue because a GitHub runner failed (${jobs}), not because of its changes. Add it back to the queue to retry. [Run details](${url})`;
const RUNS = "https://github.com/awslabs/aidlc-workflows/actions/runs";

describe("merge-queue runner notice", () => {
  test("each recorded runner failure gets one plain note naming the jobs it hit", () => {
    expect(noticeFor(facts("runner-lost")))
      .toBe(notice("Tests (macos-15, unit-5): the runner lost contact with GitHub", `${RUNS}/37074610438`));
    expect(noticeFor(facts("checkout-dns")))
      .toBe(notice("Tests (macos-15, smoke): checkout could not reach github.com", `${RUNS}/36405772694`));
    expect(noticeFor(facts("setup-hung")))
      .toBe(notice("Tests (ubuntu-latest, unit-7): its tool install hung past the queue's time limit", `${RUNS}/36732390217`));
    // Twelve macOS jobs had no runner when the queue's time limit ran out.
    expect(noticeFor(facts("runner-wait"))).toBe(notice(
      "Native terminal units (macos-15), Tests (macos-15, smoke), Tests (macos-15, integration) and 9 more: waited for a runner past the queue's time limit",
      `${RUNS}/36936394204`,
    ));
  });

  test("a real test failure, or any red job a signature does not explain, gets nothing", () => {
    expect(noticeFor(facts("windows-test-failure"))).toBeNull();
    expect(noticeFor(facts("windows-test-failure-2"))).toBeNull();
    // The lost runner plus one ordinary failure elsewhere: the PR may be at fault.
    expect(noticeFor(facts("runner-lost", {}, (record) => {
      const job = record.jobs.find((entry) => entry.name === "Tests (ubuntu-latest, unit-5) / test")!;
      job.conclusion = "failure";
      record.annotations[String(job.id)] = [{ annotation_level: "failure", message: "Process completed with exit code 1." }];
    }))).toBeNull();
    // The same timed-out run, had the hang been in the tests rather than the install.
    expect(noticeFor(facts("setup-hung", {}, (record) => {
      const job = record.jobs.find((entry) => entry.name === "Tests (ubuntu-latest, unit-7) / test")!;
      const setup = job.steps.find((step) => step.name === "Prepare unit test substrates")!;
      setup.completed_at = setup.started_at;
      const tier = job.steps.find((step) => step.name === "Run deterministic tier")!;
      tier.started_at = setup.started_at;
      tier.completed_at = job.completed_at;
    }))).toBeNull();
  });

  test("conflicts, manual removals, workflow edits, repeats and a PR already back get nothing", () => {
    const removedAs = (reason: string) => facts("runner-lost", {}, (record) => { record.removal.reason = reason; });
    for (const reason of ["merge_conflict", "manual", "merged"]) expect(noticeFor(removedAs(reason)), reason).toBeNull();
    expect(noticeFor(facts("runner-lost", { files: [".github/workflows/ci.yml"] }))).toBeNull();
    expect(noticeFor(facts("runner-lost", { botComments: [`earlier note [Run details](${RUNS}/37074610438)`] }))).toBeNull();
    expect(noticeFor(facts("runner-lost", { inQueue: true }))).toBeNull();
    expect(noticeFor(facts("runner-lost", { state: "MERGED" }))).toBeNull();
    const removal = fixture("runner-lost").removal;
    expect(noticeFor(facts("runner-lost", {
      events: [removal, { kind: "added", createdAt: "2026-10-02T23:43:28Z" }],
    }))).toBeNull();
    // No removal recorded for this run's commit: nothing to explain.
    expect(noticeFor(facts("runner-lost", { events: [{ ...removal, beforeCommit: "0".repeat(40) }] }))).toBeNull();
    // A note about an earlier run of the same PR does not count as this one.
    expect(noticeFor(facts("runner-lost", { botComments: [`[Run details](${RUNS}/36405772694)`] }))).not.toBeNull();
  });

  test("only merge-queue branches name a PR", () => {
    expect(queuedPullRequest(`gh-readonly-queue/main/pr-4242-${"a".repeat(40)}`)).toBe(4242);
    for (const branch of ["main", "fix/ci-evidence-upload-non-fatal", "gh-readonly-queue/main/pr-4242-aaaaaaa"]) {
      expect(queuedPullRequest(branch), branch).toBeNull();
    }
  });

  test("GitHub's records are read into the facts the decision uses", () => {
    const record = fixture("runner-lost");
    const lost = record.jobs.find((job) => job.conclusion === "failure" && job.name !== "Tests (smoke + unit)")!;
    const dir = mkdtempSync(join(tmpdir(), "t-ci-merge-queue-notice-"));
    try {
      const responses: Record<string, unknown> = {
        "repos/o/r/actions/runs/37074610438/attempts/1/jobs?per_page=100": [{ total_count: record.jobs.length, jobs: record.jobs }],
        "repos/o/r/pulls/4242/files?per_page=100": [[{ filename: "core/tools/aidlc-utility.ts" }]],
        "repos/o/r/issues/4242/comments?per_page=100": [[
          { user: { login: "someone" }, body: "looks good" },
          { user: { login: "github-actions[bot]" }, body: "ledger" },
        ]],
        graphql: { data: { repository: { pullRequest: {
          state: "OPEN", mergeQueueEntry: null,
          timelineItems: { nodes: [
            { __typename: "AddedToMergeQueueEvent", createdAt: "2026-10-02T22:42:17Z" },
            { __typename: "RemovedFromMergeQueueEvent", createdAt: record.removal.createdAt, reason: "failed_checks", beforeCommit: { oid: record.run.headSha } },
          ] },
        } } } },
      };
      for (const job of record.jobs.filter((entry) => entry.conclusion === "failure")) {
        responses[`repos/o/r/check-runs/${job.id}/annotations`] = [record.annotations[String(job.id)] ?? []];
      }
      writeFileSync(join(dir, "responses.json"), JSON.stringify(responses));
      // A stand-in for gh: answers each read by its path and refuses any write.
      writeFileSync(join(dir, "gh.ts"), [
        `const responses = JSON.parse(await Bun.file(${JSON.stringify(join(dir, "responses.json"))}).text());`,
        "const args = process.argv.slice(2);",
        "if (args.some((arg) => arg.startsWith(\"body=\"))) process.exit(3);",
        "const path = args.includes(\"graphql\") ? \"graphql\" : args.find((arg) => arg.startsWith(\"repos/\"));",
        "if (!(path in responses)) { console.error(\"unexpected \" + args.join(\" \")); process.exit(2); }",
        "process.stdout.write(JSON.stringify(responses[path]));",
      ].join("\n"));
      const loaded = loadFacts({
        workflow_run: {
          id: 37074610438, event: "merge_group", conclusion: "failure", run_attempt: 1,
          head_branch: `gh-readonly-queue/main/pr-4242-${"a".repeat(40)}`,
          head_sha: record.run.headSha, html_url: record.run.url,
        },
        repository: { full_name: "o/r" },
      }, 4242, [process.execPath, join(dir, "gh.ts")]);
      expect(loaded.jobs).toHaveLength(record.jobs.length);
      expect(loaded.annotations[String(lost.id)]?.[0]?.message).toStartWith("The hosted runner lost communication");
      expect(loaded.pr).toEqual({
        state: "OPEN", inQueue: false, files: ["core/tools/aidlc-utility.ts"], botComments: ["ledger"],
        events: [
          { kind: "added", createdAt: "2026-10-02T22:42:17Z" },
          { kind: "removed", createdAt: record.removal.createdAt, reason: "failed_checks", beforeCommit: record.run.headSha },
        ],
      });
      expect(noticeFor(loaded)).toBe(notice("Tests (macos-15, unit-5): the runner lost contact with GitHub", record.run.url));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the workflow runs from main with the built-in token, least permissions, and no queue action", () => {
    const text = readFileSync(join(REPO_ROOT, ".github/workflows/merge-queue-notice.yml"), "utf8");
    const script = readFileSync(join(REPO_ROOT, ".github/scripts/merge-queue-notice.ts"), "utf8");
    const workflow = Bun.YAML.parse(text) as {
      on: unknown;
      permissions: unknown;
      jobs: Record<string, {
        if?: string; permissions?: unknown; "timeout-minutes"?: number;
        steps: Array<{ uses?: string; with?: Record<string, unknown>; env?: Record<string, string>; run?: string }>;
      }>;
    };
    expect(workflow.on).toEqual({ workflow_run: { workflows: ["CI"], types: ["completed"] } });
    expect(workflow.permissions).toEqual({});
    expect(Object.keys(workflow.jobs)).toEqual(["notice"]);
    const job = workflow.jobs.notice;
    expect(job.if).toBe("github.event.workflow_run.event == 'merge_group'");
    expect(job.permissions).toEqual({ actions: "read", checks: "read", contents: "read", "pull-requests": "write" });
    expect(job["timeout-minutes"]).toBe(10);
    const checkout = job.steps.find((step) => step.uses?.startsWith("actions/checkout@"))!;
    expect(checkout.with).toEqual({ "persist-credentials": false, ref: `\${{ github.event.repository.default_branch }}` });
    for (const step of job.steps) if (step.uses) expect(step.uses, step.uses).toMatch(/^[^@\s]+@[a-f0-9]{40}$/);
    const run = job.steps.at(-1)!;
    expect(run.env).toEqual({ GH_TOKEN: `\${{ github.token }}` });
    expect(run.run).toBe(`bun .github/scripts/merge-queue-notice.ts "$GITHUB_EVENT_PATH"`);
    // Nothing reads a secret, checks out the run's code, or changes the queue.
    expect(text).not.toMatch(/secrets\.|id-token/);
    for (const source of [text, script]) {
      expect(source).not.toMatch(/enqueuePullRequest|dequeuePullRequest|mergePullRequest|mutation|pulls\/[^/\s]+\/merge\b|pr merge/);
    }
    // The only write is the one comment.
    expect(script.match(/"-f", `body=/g)).toHaveLength(1);
  });
});
