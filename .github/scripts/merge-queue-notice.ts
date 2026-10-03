// merge-queue-notice.ts: tell a contributor when the merge queue dropped their
// PR only because a GitHub-hosted runner failed.
//
// Runs after each merge-queue CI run (workflow_run, from the default branch).
// It reads what GitHub recorded about that run and the PR's queue events, and
// posts one comment when every cause is a recorded runner signature. It never
// changes the queue: there is no enqueue, dequeue or merge call here, and the
// only write is the comment, made with the workflow's GITHUB_TOKEN so it starts
// no other workflow. Anything it cannot prove leaves the PR alone.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

// An argv prefix lets fixtures use a native interpreter without a shell.
export type GhExecutable = string | readonly [executable: string, ...args: string[]];

export interface Step {
  name: string;
  number: number;
  conclusion: string | null;
  started_at: string | null;
  completed_at: string | null;
}

export interface Job {
  id: number;
  name: string;
  conclusion: string | null;
  started_at: string | null;
  completed_at: string | null;
  runner_name: string | null;
  steps: Step[];
}

export interface Annotation {
  annotation_level: string;
  message: string;
}

export interface QueueEvent {
  kind: "added" | "removed";
  createdAt: string;
  reason?: string;
  beforeCommit?: string;
}

export interface DropFacts {
  run: { headSha: string; url: string };
  jobs: Job[];
  /** Annotations of each red job, keyed by job id. */
  annotations: Record<string, Annotation[]>;
  pr: {
    state: string;
    inQueue: boolean;
    files: string[];
    events: QueueEvent[];
    /** Bodies of the comments github-actions already left on the PR. */
    botComments: string[];
  };
}

// The required check's summary job only mirrors the others.
const SUMMARY_JOB = "Tests (smoke + unit)";
// GitHub's own words, as recorded on the runs this was built from.
const RUNNER_LOST = "The hosted runner lost communication with the server";
const NO_DNS = "Could not resolve host: github.com";
const SETUP_STEP = "Prepare unit test substrates";
const RED = new Set(["failure", "timed_out", "cancelled", "startup_failure", "action_required"]);

export const WHAT = {
  lost: "the runner lost contact with GitHub",
  checkout: "checkout could not reach github.com",
  noRunner: "waited for a runner past the queue's time limit",
  setupHung: "its tool install hung past the queue's time limit",
} as const;

/** The PR a merge-queue branch was built for, or null for any other branch. */
export function queuedPullRequest(headBranch: string): number | null {
  const match = /^gh-readonly-queue\/[^/]+(?:\/[^/]+)*\/pr-([1-9][0-9]*)-[0-9a-f]{40}$/.exec(headBranch);
  return match ? Number(match[1]) : null;
}

/** The queue removal this run caused, or null if the queue has not recorded one. */
export function removalFor(events: QueueEvent[], headSha: string): QueueEvent | null {
  return events.find((event) => event.kind === "removed" && event.beforeCommit === headSha) ?? null;
}

function failures(annotations: Annotation[] | undefined): string[] {
  return (annotations ?? []).filter((note) => note.annotation_level === "failure").map((note) => note.message);
}

/** Why a red job failed, when the cause is a recorded runner signature. */
export function runnerFailure(job: Job, annotations: Annotation[] | undefined): string | null {
  if (job.conclusion !== "failure") return null;
  const failed = job.steps.filter((step) => step.conclusion === "failure").sort((a, b) => a.number - b.number);
  const messages = failures(annotations);
  if (failed.length === 0 && messages.some((message) => message.startsWith(RUNNER_LOST))) return WHAT.lost;
  if (failed[0]?.name.startsWith("Run actions/checkout@") && messages.some((message) => message.includes(NO_DNS))) {
    return WHAT.checkout;
  }
  return null;
}

const at = (iso: string | null): number => (iso === null ? Number.NaN : Date.parse(iso));

/** Why a job was still open when the queue's check timeout ran out, if a runner explains it. */
export function timeoutCause(job: Job, removedAt: string): string | null {
  const removed = at(removedAt);
  if (!job.runner_name || !(at(job.started_at) <= removed)) return WHAT.noRunner;
  const setup = job.steps.find((step) => step.name === SETUP_STEP);
  if (setup && at(setup.started_at) <= removed && !(at(setup.completed_at) <= removed)) return WHAT.setupHung;
  return null;
}

/** Each runner cause and the jobs it hit, or null when anything is unexplained. */
export function runnerCauses(facts: DropFacts, removal: QueueEvent): Map<string, string[]> | null {
  const causes = new Map<string, string[]>();
  const add = (what: string, job: Job) => causes.set(what, [...(causes.get(what) ?? []), job.name.replace(/ \/ test$/, "")]);
  const jobs = facts.jobs.filter((job) => job.name !== SUMMARY_JOB && job.conclusion !== "skipped");
  if (removal.reason === "failed_checks") {
    for (const job of jobs.filter((entry) => RED.has(entry.conclusion ?? ""))) {
      const what = runnerFailure(job, facts.annotations[String(job.id)]);
      if (what === null) return null;
      add(what, job);
    }
  } else if (removal.reason === "checks_timed_out") {
    // Every job the queue was still waiting on must be explained by a runner.
    const removed = at(removal.createdAt);
    for (const job of jobs.filter((entry) => !(at(entry.completed_at) <= removed))) {
      const what = timeoutCause(job, removal.createdAt);
      if (what === null) return null;
      add(what, job);
    }
  } else {
    return null;
  }
  return causes.size > 0 ? causes : null;
}

/** The one comment to post, or null when the drop is not provably a runner failure. */
export function noticeFor(facts: DropFacts): string | null {
  const { pr } = facts;
  const removal = removalFor(pr.events, facts.run.headSha);
  if (removal === null || pr.state !== "OPEN" || pr.inQueue) return null;
  // Added again since the drop: the person has already acted.
  if (pr.events.some((event) => event.kind === "added" && at(event.createdAt) > at(removal.createdAt))) return null;
  // A PR that edits workflows can break its own merge group, so it is never told otherwise.
  if (pr.files.some((file) => file.startsWith(".github/"))) return null;
  if (pr.botComments.some((body) => body.includes(facts.run.url))) return null;
  const causes = runnerCauses(facts, removal);
  if (causes === null) return null;
  const parts = [...causes].map(([what, jobs]) => {
    const shown = jobs.length > 3 ? `${jobs.slice(0, 3).join(", ")} and ${jobs.length - 3} more` : jobs.join(", ");
    return `${shown}: ${what}`;
  });
  return `This PR left the merge queue because a GitHub runner failed (${parts.join("; ")}), not because of its changes. Add it back to the queue to retry. [Run details](${facts.run.url})`;
}

// --- GitHub I/O ---------------------------------------------------------------

function gh(args: string[], ghExecutable: GhExecutable): unknown {
  const [command, ...prefix] = typeof ghExecutable === "string" ? [ghExecutable] : ghExecutable;
  const raw = execFileSync(command, [...prefix, ...args], {
    encoding: "utf8", maxBuffer: Number.POSITIVE_INFINITY, stdio: ["ignore", "pipe", "pipe"],
  });
  return raw.trim().length === 0 ? null : JSON.parse(raw);
}

const QUEUE_QUERY = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){
  state mergeQueueEntry{id}
  timelineItems(last:100,itemTypes:[ADDED_TO_MERGE_QUEUE_EVENT,REMOVED_FROM_MERGE_QUEUE_EVENT]){nodes{__typename
    ...on AddedToMergeQueueEvent{createdAt}
    ...on RemovedFromMergeQueueEvent{createdAt reason beforeCommit{oid}}}}}}}`;

interface RunEvent {
  workflow_run: {
    id: number; event: string; conclusion: string | null; head_branch: string; head_sha: string; html_url: string; run_attempt: number;
  };
  repository: { full_name: string };
}

function pages(value: unknown): Record<string, unknown>[] {
  return (Array.isArray(value) ? value.flat() : []) as Record<string, unknown>[];
}

/** Read everything noticeFor needs from GitHub. */
export function loadFacts(event: RunEvent, number: number, ghExecutable: GhExecutable = "gh"): DropFacts {
  const repo = event.repository.full_name;
  const run = event.workflow_run;
  const jobs = pages(gh(["api", "--paginate", "--slurp", `repos/${repo}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`], ghExecutable))
    .flatMap((page) => (page.jobs ?? []) as Job[]);
  const annotations: Record<string, Annotation[]> = {};
  for (const job of jobs.filter((entry) => entry.conclusion === "failure")) {
    annotations[String(job.id)] = pages(gh(["api", "--paginate", "--slurp", `repos/${repo}/check-runs/${job.id}/annotations`], ghExecutable)) as unknown as Annotation[];
  }
  const [owner, name] = repo.split("/");
  const queue = gh(["api", "graphql", "-f", `query=${QUEUE_QUERY}`, "-f", `owner=${owner}`, "-f", `name=${name}`, "-F", `number=${number}`], ghExecutable) as {
    data: { repository: { pullRequest: { state: string; mergeQueueEntry: unknown; timelineItems: { nodes: Record<string, unknown>[] } } } };
  };
  const pull = queue.data.repository.pullRequest;
  const events: QueueEvent[] = pull.timelineItems.nodes.map((node) => node.__typename === "AddedToMergeQueueEvent"
    ? { kind: "added", createdAt: String(node.createdAt) }
    : {
        kind: "removed", createdAt: String(node.createdAt), reason: String(node.reason),
        beforeCommit: String((node.beforeCommit as { oid?: string } | null)?.oid ?? ""),
      });
  const files = pages(gh(["api", "--paginate", "--slurp", `repos/${repo}/pulls/${number}/files?per_page=100`], ghExecutable))
    .map((file) => String(file.filename));
  const botComments = pages(gh(["api", "--paginate", "--slurp", `repos/${repo}/issues/${number}/comments?per_page=100`], ghExecutable))
    .filter((comment) => (comment.user as { login?: string } | undefined)?.login === "github-actions[bot]")
    .map((comment) => String(comment.body ?? ""));
  return {
    run: { headSha: run.head_sha, url: run.html_url },
    jobs,
    annotations,
    pr: { state: pull.state, inQueue: pull.mergeQueueEntry !== null, files, events, botComments },
  };
}

function main(): void {
  const event = JSON.parse(readFileSync(process.argv[2] ?? process.env.GITHUB_EVENT_PATH ?? "", "utf8")) as RunEvent;
  const number = queuedPullRequest(event.workflow_run.head_branch);
  if (event.workflow_run.event !== "merge_group" || number === null) {
    process.stdout.write("not a merge-queue run\n");
    return;
  }
  // A failed run's removal is recorded up to about 20 seconds after the run
  // ends; a timed-out one was recorded long before, so only failures wait.
  let facts = loadFacts(event, number);
  const waits = event.workflow_run.conclusion === "success" ? 0 : 9;
  for (let wait = 0; wait < waits && removalFor(facts.pr.events, facts.run.headSha) === null; wait++) {
    Bun.sleepSync(20_000);
    facts = loadFacts(event, number);
  }
  const notice = noticeFor(facts);
  if (notice === null) {
    process.stdout.write(`no runner-failure notice for #${number}\n`);
    return;
  }
  gh(["api", `repos/${event.repository.full_name}/issues/${number}/comments`, "-f", `body=${notice}`], "gh");
  process.stdout.write(`posted on #${number}: ${notice}\n`);
}

if (import.meta.main) {
  try {
    main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`::error::merge-queue-notice ${message.replace(/[\r\n]/g, " ").slice(0, 1000)}\n`);
    process.exit(1);
  }
}
