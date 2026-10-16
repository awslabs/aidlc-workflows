// The model identifies product choices. Only a permission-checked maintainer
// command approves them; GitHub check output keeps the decision and its scope.
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { actorHasWrite } from "./ai-pr-ledger.ts";
import type { ChangedFileManifest, GhExecutable } from "./ai-pr-review.ts";

export const CHECK_NAME = "AIDA product decision";
const APP_ID = 15368;
const SHA = /^[0-9a-f]{40}$/;
const EXTERNAL_ID = "aida-product-v1:";
const RECORD_PREFIX = "<!-- aida-product-record ";

export interface ProductChoice {
  change: string;
  before: string;
  after: string;
  question: string;
  paths: string[];
}

export interface Assessment {
  base: string;
  head: string;
  status: "no-product-change" | "needs-approval" | "approved-scope";
  summary: string;
  decisions: ProductChoice[];
  approvalId: number | null;
}

export interface ProductRecord {
  version: 1;
  pr: number;
  base: string;
  head: string;
  assessment: Assessment | null;
  approval: { actor: string; commentId: number; reason: string } | null;
  reopened: { actor: string; commentId: number; reason: string } | null;
}

export interface ApprovedScope {
  checkId: number;
  head: string;
  actor: string;
  reason: string;
  decisions: ProductChoice[];
}

interface CheckRun {
  id: number;
  name: string;
  head_sha: string;
  external_id: string;
  app: { id: number };
  conclusion: string | null;
  output: { text: string | null };
}

interface Pull {
  number: number;
  state: string;
  draft: boolean;
  base: { sha: string; ref: string };
  head: { sha: string };
}

interface Comment {
  id: number;
  body: string;
  issue_url: string;
  user: { login: string; type: string };
}

export interface QueueEntry {
  baseCommit: { oid: string };
  headCommit: { oid: string };
  pullRequest: { number: number; headRefOid: string };
}

export type Api = <T>(endpoint: string, method?: string, body?: unknown) => T;

function apiFor(ghExecutable: GhExecutable): Api {
  const [command, ...prefix] = typeof ghExecutable === "string" ? [ghExecutable] : ghExecutable;
  return <T>(endpoint: string, method = "GET", body?: unknown): T => {
    const args = [...prefix, "api", endpoint, "--method", method];
    if (body !== undefined) args.push("--input", "-");
    return JSON.parse(execFileSync(command, args, {
      encoding: "utf8", input: body === undefined ? undefined : JSON.stringify(body),
      maxBuffer: 10 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"],
    })) as T;
  };
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("expected an object");
  return value as Record<string, unknown>;
}

function text(value: unknown, limit: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > limit) throw new Error("missing or oversized text");
  return value;
}

export function validateAssessment(
  value: unknown, manifest: ChangedFileManifest, approvals: ApprovedScope[],
): Assessment {
  const input = object(value);
  if (input.base !== manifest.base || input.head !== manifest.head) throw new Error("assessment revisions do not match");
  if (!["no-product-change", "needs-approval", "approved-scope"].includes(String(input.status))) throw new Error("invalid product status");
  if (!Array.isArray(input.decisions) || input.decisions.length > 20) throw new Error("invalid product decisions");
  const paths = new Set(manifest.files.map(file => file.path));
  const decisions = input.decisions.map(value => {
    const choice = object(value);
    if (!Array.isArray(choice.paths) || choice.paths.length === 0 || choice.paths.length > 20
      || choice.paths.some(path => typeof path !== "string" || !paths.has(path))) {
      throw new Error("a product choice must cite changed files");
    }
    return {
      change: text(choice.change, 1000), before: text(choice.before, 1000),
      after: text(choice.after, 1000), question: text(choice.question, 1000),
      paths: choice.paths as string[],
    };
  });
  if ((input.status === "no-product-change") !== (decisions.length === 0)) throw new Error("product status contradicts its choices");
  if (input.status === "approved-scope") {
    if (!Number.isSafeInteger(input.approvalId) || !approvals.some(entry => entry.checkId === input.approvalId)) {
      throw new Error("the model cannot invent product approval");
    }
  } else if (input.approvalId !== null) throw new Error("unexpected approval reference");
  return {
    base: manifest.base, head: manifest.head, status: input.status as Assessment["status"],
    summary: text(input.summary, 2000), decisions, approvalId: input.approvalId as number | null,
  };
}

export function encodeRecord(record: ProductRecord): string {
  const data = JSON.stringify(record).replace(/</g, "\\u003c").replace(/>/g, "\\u003e");
  if (Buffer.byteLength(data) > 60000) throw new Error("product record exceeds the check output limit");
  return `${RECORD_PREFIX}${data} -->`;
}

export function readRecord(check: CheckRun, pr: number): ProductRecord {
  if (check.app?.id !== APP_ID || check.name !== CHECK_NAME || check.external_id !== `${EXTERNAL_ID}${pr}`) {
    throw new Error("not an AIDA product check for this PR");
  }
  const encoded = check.output.text ?? "";
  if (!encoded.startsWith(RECORD_PREFIX) || !encoded.endsWith(" -->")) throw new Error("missing product record");
  const record = object(JSON.parse(encoded.slice(RECORD_PREFIX.length, -4)));
  if (record.version !== 1 || record.pr !== pr || record.head !== check.head_sha
    || !SHA.test(String(record.base)) || !SHA.test(String(record.head))) throw new Error("invalid product record");
  // The record is written only by the trusted workflow, never parsed from PR prose.
  if (!("assessment" in record) || !("approval" in record) || !("reopened" in record)) throw new Error("incomplete product record");
  for (const key of ["approval", "reopened"]) {
    if (record[key] === null) continue;
    const decision = object(record[key]);
    text(decision.actor, 39);
    text(decision.reason, 2000);
    if (!Number.isSafeInteger(decision.commentId) || Number(decision.commentId) < 1) throw new Error("invalid decision comment");
  }
  if (record.approval !== null && record.reopened !== null) throw new Error("contradictory product decisions");
  if (record.assessment !== null) {
    const assessment = object(record.assessment);
    if (assessment.base !== record.base || assessment.head !== record.head
      || !["needs-approval", "no-product-change", "approved-scope"].includes(String(assessment.status))
      || !Array.isArray(assessment.decisions)) throw new Error("invalid recorded assessment");
  }
  return record as unknown as ProductRecord;
}

export function productApproved(record: ProductRecord): boolean {
  return record.reopened === null && (record.approval !== null || record.assessment?.status === "no-product-change"
    || record.assessment?.status === "approved-scope");
}

function plain(value: string): string {
  return value.replace(/[&<>`*_~[\]\\]/g, char => `&#${char.charCodeAt(0)};`).replace(/@/g, "&#64;");
}

export function checkSummary(record: ProductRecord, id: number): string {
  const result = record.reopened
    ? `Product decision reopened by ${plain(record.reopened.actor)}: ${plain(record.reopened.reason)}`
    : record.approval
    ? `Product scope approved by ${plain(record.approval.actor)}: ${plain(record.approval.reason)}`
    : record.assessment ? plain(record.assessment.summary) : "Product assessment did not finish. Retry the workflow, or record the product scope you approve below.";
  const lines = [result];
  for (const choice of record.assessment?.decisions ?? []) {
    lines.push("", `- ${plain(choice.change)}`, `  Before: ${plain(choice.before)}`,
      `  After: ${plain(choice.after)}`, `  Decision: ${plain(choice.question)}`,
      `  Files: ${choice.paths.map(plain).join(", ")}`);
  }
  if (record.assessment?.status === "approved-scope") lines.push("", `Within the scope approved in check ${record.assessment.approvalId}.`);
  const explanation = lines.join("\n").slice(0, 50000);
  return [explanation, "", "Technical findings remain advisory. This check only tracks product approval.",
    "", "A maintainer with write, maintain, or admin permission can comment on this PR:",
    "", `\`/aida product approve ${id} <the product scope you approve, or why no product decision is needed>\``,
    "", `\`/aida product reopen ${id} <what still needs a decision>\``].join("\n");
}

function publish(api: Api, repo: string, check: CheckRun, record: ProductRecord, running = false): void {
  const data = encodeRecord(record);
  api(`repos/${repo}/check-runs/${check.id}`, "PATCH", {
    status: running ? "in_progress" : "completed",
    ...(running ? {} : { conclusion: productApproved(record) ? "success" : "action_required" }),
    output: {
      title: running ? "Assessing product scope" : productApproved(record) ? "Product scope cleared" : "Maintainer product decision needed",
      summary: checkSummary(record, check.id), text: data,
    },
  });
}

function checks(api: Api, repo: string, head: string, pr: number): CheckRun[] {
  const found: CheckRun[] = [];
  for (let page = 1; ; page++) {
    const response = api<{ check_runs: CheckRun[] }>(`repos/${repo}/commits/${head}/check-runs?check_name=${encodeURIComponent(CHECK_NAME)}&filter=all&per_page=100&page=${page}`);
    found.push(...response.check_runs.filter(check => check.app?.id === APP_ID && check.external_id === `${EXTERNAL_ID}${pr}`));
    if (response.check_runs.length < 100) return found.sort((a, b) => b.id - a.id);
  }
}

function comments(api: Api, repo: string, pr: number): Comment[] {
  const all: Comment[] = [];
  for (let page = 1; ; page++) {
    const batch = api<Comment[]>(`repos/${repo}/issues/${pr}/comments?per_page=100&page=${page}`);
    all.push(...batch);
    if (batch.length < 100) return all;
  }
}

export function parseProductCommand(body: string): { action: "approve" | "reopen"; checkId: number; reason: string } | null {
  const match = /^\/aida product (approve|reopen) ([1-9][0-9]*) ([^\r\n]+)\s*$/.exec(body);
  if (!match || !Number.isSafeInteger(Number(match[2])) || !match[3].trim() || match[3].trim().length > 2000) return null;
  return { action: match[1] as "approve" | "reopen", checkId: Number(match[2]), reason: match[3].trim() };
}

export function priorApprovals(api: Api, repo: string, pr: number): ApprovedScope[] {
  const approvals = new Map<number, ApprovedScope>();
  let reopenedAfter = 0;
  const approvalComments = new Map<number, number>();
  for (const comment of comments(api, repo, pr)) {
    const command = parseProductCommand(comment.body);
    if (!command) continue;
    // A comment is only a pointer. Approval exists only in a check written after
    // authenticating the original command, for the same PR and comment author.
    let record: ProductRecord;
    try {
      record = readRecord(api<CheckRun>(`repos/${repo}/check-runs/${command.checkId}`), pr);
    } catch { continue; }
    if (record.reopened?.commentId === comment.id && record.reopened.actor === comment.user.login) {
      reopenedAfter = Math.max(reopenedAfter, comment.id);
    }
    if (command.action !== "approve" || !record.approval
      || record.approval.commentId !== comment.id || record.approval.actor !== comment.user.login) continue;
    approvalComments.set(command.checkId, comment.id);
    approvals.set(command.checkId, {
      checkId: command.checkId, head: record.head, actor: record.approval.actor,
      reason: record.approval.reason, decisions: record.assessment?.decisions ?? [],
    });
  }
  // Each command approves the PR's whole product scope. A later human decision
  // supersedes an earlier one; the classifier cannot pick an older, wider scope.
  return [...approvals.values()]
    .filter(entry => (approvalComments.get(entry.checkId) ?? 0) > reopenedAfter)
    .sort((left, right) => (approvalComments.get(right.checkId) ?? 0) - (approvalComments.get(left.checkId) ?? 0))
    .slice(0, 1);
}

export function applyProductCommand(
  api: Api, repo: string, pr: number, commentId: number, actor: string,
  hasWrite: (repo: string, actor: string) => boolean,
): void {
  const comment = api<Comment>(`repos/${repo}/issues/comments/${commentId}`);
  if (comment.id !== commentId || comment.user.login !== actor || comment.user.type === "Bot"
    || comment.issue_url !== `https://api.github.com/repos/${repo}/issues/${pr}` || !hasWrite(repo, actor)) {
    throw new Error("product approval requires a maintainer comment on this PR");
  }
  const command = parseProductCommand(comment.body);
  if (!command) throw new Error("use /aida product approve|reopen <check-id> <reason> on one line");
  const pull = api<Pull>(`repos/${repo}/pulls/${pr}`);
  const check = api<CheckRun>(`repos/${repo}/check-runs/${command.checkId}`);
  const record = readRecord(check, pr);
  if (commentId < Math.max(record.approval?.commentId ?? 0, record.reopened?.commentId ?? 0)) {
    throw new Error("a newer maintainer decision already supersedes this command");
  }
  if (pull.state !== "open" || pull.base.ref !== "main" || pull.head.sha !== record.head
    || checks(api, repo, record.head, pr)[0]?.id !== check.id) {
    throw new Error("this is not the current product check; use the check on the latest PR head");
  }
  if (command.action === "approve") {
    record.approval = { actor, commentId, reason: command.reason };
    record.reopened = null;
  }
  else {
    record.approval = null;
    record.reopened = { actor, commentId, reason: command.reason };
  }
  if (api<Pull>(`repos/${repo}/pulls/${pr}`).head.sha !== record.head) throw new Error("PR head changed while approving");
  publish(api, repo, check, record);
  api(`repos/${repo}/issues/comments/${commentId}/reactions`, "POST", { content: "+1" });
}

export function queueMembers(entries: QueueEntry[], base: string, head: string): QueueEntry[] {
  const members: QueueEntry[] = [];
  const seen = new Set<string>();
  let current = head;
  while (current !== base) {
    if (seen.has(current)) throw new Error("merge queue entry cycle");
    seen.add(current);
    const entry = entries.find(entry => entry.headCommit.oid === current);
    if (!entry) throw new Error("merge group no longer matches the live queue");
    members.push(entry);
    current = entry.baseCommit.oid;
  }
  if (!members.length) throw new Error("empty merge group");
  return members;
}

export function verifyQueue(api: Api, repo: string, base: string, head: string): void {
  const [owner, name] = repo.split("/");
  const query = `query($owner:String!,$name:String!){repository(owner:$owner,name:$name){mergeQueue{entries(first:100){pageInfo{hasNextPage} nodes{baseCommit{oid} headCommit{oid} pullRequest{number headRefOid}}}}}}`;
  const load = (): QueueEntry[] => {
    const response = api<{ data: { repository: { mergeQueue: { entries: { pageInfo: { hasNextPage: boolean }; nodes: QueueEntry[] } } } } }>(
      "graphql", "POST", { query, variables: { owner, name } },
    );
    const connection = response.data.repository.mergeQueue.entries;
    if (connection.pageInfo.hasNextPage) throw new Error("queue exceeds the supported 100 entries");
    return queueMembers(connection.nodes, base, head);
  };
  const members = load();
  for (const entry of members) {
    const pr = entry.pullRequest.number;
    const current = api<Pull>(`repos/${repo}/pulls/${pr}`);
    if (current.head.sha !== entry.pullRequest.headRefOid || current.base.ref !== "main") throw new Error(`PR #${pr} moved in the queue`);
    const check = checks(api, repo, current.head.sha, pr)[0];
    if (check?.conclusion !== "success" || !productApproved(readRecord(check, pr))) {
      throw new Error(`PR #${pr} needs its product decision before merging`);
    }
  }
  if (JSON.stringify(load()) !== JSON.stringify(members)) throw new Error("merge queue changed during verification");
}

function output(values: Record<string, string | number | boolean>): void {
  const lines = Object.entries(values).map(([key, value]) => `${key}=${value}`).join("\n");
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${lines}\n`);
}

export function main(argv = process.argv.slice(2), ghExecutable: GhExecutable = "gh"): void {
  const [command, ...args] = argv;
  const arg = (key: string): string => {
    const index = args.indexOf(key);
    if (index < 0 || !args[index + 1]) throw new Error(`missing ${key}`);
    return args[index + 1];
  };
  const repo = arg("--repo");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error("invalid repository");
  const api = apiFor(ghExecutable);
  if (command === "queue") {
    const head = arg("--head");
    const base = arg("--base");
    if (!SHA.test(head) || !SHA.test(base)) throw new Error("invalid queue revisions");
    const check = api<CheckRun>(`repos/${repo}/check-runs`, "POST", {
      name: CHECK_NAME, head_sha: head, external_id: `${EXTERNAL_ID}queue`, status: "in_progress",
    });
    try {
      verifyQueue(api, repo, base, head);
      api(`repos/${repo}/check-runs/${check.id}`, "PATCH", {
        status: "completed", conclusion: "success",
        output: { title: "Product scopes cleared", summary: "Every PR in this merge group has a successful product check on its current head." },
      });
    } catch (error) {
      api(`repos/${repo}/check-runs/${check.id}`, "PATCH", {
        status: "completed", conclusion: "action_required",
        output: { title: "Product decision unresolved", summary: plain(String(error)) },
      });
      throw error;
    }
    return;
  }
  const pr = Number(arg("--pr"));
  if (!Number.isSafeInteger(pr) || pr < 1) throw new Error("invalid PR");
  if (command === "command") {
    applyProductCommand(api, repo, pr, Number(arg("--comment")), arg("--actor"),
      (repository, actor) => actorHasWrite(repository, actor, ghExecutable));
    return;
  }
  const context = ".ai-review-context";
  const checkFile = ".ai-product-state/check.json";
  const pull = api<Pull>(`repos/${repo}/pulls/${pr}`);
  if (pull.state !== "open" || pull.base.ref !== "main") { output({ skip: true }); return; }
  const head = pull.head.sha;
  if (!SHA.test(head) || !SHA.test(pull.base.sha)) throw new Error("invalid PR revisions");
  if (command === "start") {
    if (pull.draft) { output({ skip: true }); return; }
    const current = checks(api, repo, head, pr)[0];
    if (current && productApproved(readRecord(current, pr))) { output({ skip: true }); return; }
    const record: ProductRecord = { version: 1, pr, base: pull.base.sha, head, assessment: null, approval: null, reopened: null };
    const check = current ?? api<CheckRun>(`repos/${repo}/check-runs`, "POST", {
      name: CHECK_NAME, head_sha: head, external_id: `${EXTERNAL_ID}${pr}`, status: "in_progress",
      output: { title: "Assessing product scope", summary: "AIDA is checking for product choices.", text: encodeRecord(record) },
    });
    // Keep a completed assessment stable: commands name this exact check.
    if (current && (readRecord(current, pr).assessment !== null || readRecord(current, pr).reopened !== null)) {
      output({ skip: true }); return;
    }
    publish(api, repo, check, record, true);
    mkdirSync(".ai-product-state", { recursive: true });
    writeFileSync(checkFile, JSON.stringify({ id: check.id, record }));
    output({ skip: false, head, base: pull.base.sha, check: check.id });
    return;
  }
  const saved = JSON.parse(readFileSync(checkFile, "utf8")) as { id: number; record: ProductRecord };
  if (saved.record.pr !== pr || saved.record.head !== head) throw new Error("PR head changed during product assessment");
  if (command === "prepare") {
    const manifest = JSON.parse(readFileSync(`${context}/changed-files.json`, "utf8")) as ChangedFileManifest;
    if (manifest.base !== saved.record.base || manifest.head !== head) throw new Error("shared context differs from the product check");
    writeFileSync(`${context}/product-approvals.json`, JSON.stringify(priorApprovals(api, repo, pr)));
    return;
  }
  if (command === "finish" || command === "fail") {
    const check = api<CheckRun>(`repos/${repo}/check-runs/${saved.id}`);
    const record = readRecord(check, pr);
    if (command === "finish") {
      record.assessment = validateAssessment(
        JSON.parse(readFileSync(arg("--input"), "utf8")),
        JSON.parse(readFileSync(`${context}/changed-files.json`, "utf8")),
        priorApprovals(api, repo, pr),
      );
    }
    if (api<Pull>(`repos/${repo}/pulls/${pr}`).head.sha !== head) throw new Error("PR moved before publication");
    publish(api, repo, check, record);
    return;
  }
  throw new Error("usage: ai-product-decision.ts start|prepare|finish|fail|command|queue");
}

if (import.meta.main) {
  try { main(); }
  catch (error) {
    process.stderr.write(`Product check: ${String(error).replace(/[\r\n]/g, " ").slice(0, 1000)}\n`);
    process.exitCode = 1;
  }
}
