// Product approval stays separate from bug severity and bound to authenticated
// maintainer scope, across pushes, retries and grouped queue entries.
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Api, type Assessment, type ProductRecord, type QueueEntry,
  applyProductCommand, CHECK_NAME, checkSummary, encodeRecord, parseProductCommand,
  priorApprovals, productApproved, queueMembers, readRecord, validateAssessment, verifyQueue,
} from "../../.github/scripts/ai-product-decision.ts";
import { buildContext, type ChangedFileManifest } from "../../.github/scripts/ai-pr-review.ts";
import { posixShellPath } from "../harness/git-bash.ts";

const REVIEW_WORKFLOW = Bun.YAML.parse(readFileSync(
  new URL("../../.github/workflows/ai-pr-review.yml", import.meta.url), "utf8",
)) as { jobs: { review: { steps: Array<{ name?: string; run?: string; env?: Record<string, string> }> } } };
const reviewStep = (name: string): string => REVIEW_WORKFLOW.jobs.review.steps.find(step => step.name === name)?.run ?? "";

const BASE = "b".repeat(40);
const HEAD = "a".repeat(40);
const NEXT = "c".repeat(40);
const REPO = "acme/repo";
const MANIFEST: ChangedFileManifest = {
  base: BASE, head: HEAD,
  files: [{ path: "core/new-format.ts", status: "A", added: [{ start: 1, end: 20 }], deleted: [], fileLevelEvidence: false }],
};
const CHOICE = {
  change: "Add a YAML project format",
  before: "Teams configure projects with JSON.",
  after: "Teams can maintain YAML project files.",
  question: "Should YAML become a supported project format?",
  paths: ["core/new-format.ts"],
};
const assessment = (status: Assessment["status"] = "needs-approval"): Assessment => ({
  base: BASE, head: HEAD, status, summary: "A new supported format needs a product decision.",
  decisions: status === "no-product-change" ? [] : [CHOICE], approvalId: null,
});
const record = (status: Assessment["status"] = "needs-approval"): ProductRecord => ({
  version: 1, pr: 42, base: BASE, head: HEAD, assessment: assessment(status), approval: null, reopened: null,
});
const check = (value = record(), id = 7) => ({
  id, name: CHECK_NAME, head_sha: value.head, external_id: `aida-product-v1:${value.pr}`,
  app: { id: 15368 }, conclusion: productApproved(value) ? "success" : "action_required",
  output: { text: encodeRecord(value) },
});
const comment = (body = "/aida product approve 7 Support YAML alongside JSON.", id = 100) => ({
  id, body, issue_url: `https://api.github.com/repos/${REPO}/issues/42`,
  user: { login: "maintainer", type: "User" },
});

function fixture() {
  const state = {
    checks: [check()],
    comments: [comment()],
    head: HEAD,
    writes: [] as Array<{ endpoint: string; method: string; body: unknown }>,
    queue: [] as QueueEntry[],
    pullReads: 0,
    moveAfter: Number.POSITIVE_INFINITY,
  };
  const api: Api = <T>(endpoint: string, method = "GET", body?: unknown): T => {
    if (method !== "GET" && endpoint !== "graphql") {
      state.writes.push({ endpoint, method, body });
      const match = /check-runs\/(\d+)$/.exec(endpoint);
      if (match) {
        const item = state.checks.find(item => item.id === Number(match[1]));
        if (!item) throw new Error("unknown check");
        Object.assign(item, body);
      }
      return {} as T;
    }
    let value: unknown;
    if (endpoint === "graphql") {
      value = { data: { repository: { mergeQueue: { entries: { pageInfo: { hasNextPage: false }, nodes: state.queue } } } } };
    } else if (/issues\/comments\/\d+$/.test(endpoint)) {
      value = state.comments.find(item => item.id === Number(endpoint.split("/").at(-1)));
    } else if (/issues\/42\/comments\?/.test(endpoint)) value = state.comments;
    else if (/pulls\/\d+$/.test(endpoint)) {
      state.pullReads++;
      const number = Number(endpoint.split("/").at(-1));
      value = {
        number, state: "open", draft: false, base: { sha: BASE, ref: "main" },
        head: { sha: state.pullReads > state.moveAfter ? NEXT : number === 42 ? state.head : NEXT },
      };
    } else if (/commits\/[^/]+\/check-runs\?/.test(endpoint)) {
      const sha = /commits\/([^/]+)/.exec(endpoint)?.[1];
      value = { check_runs: state.checks.filter(item => item.head_sha === sha) };
    } else if (/check-runs\/\d+$/.test(endpoint)) {
      value = state.checks.find(item => item.id === Number(endpoint.split("/").at(-1)));
    } else throw new Error(`unexpected endpoint ${endpoint}`);
    if (value === undefined) throw new Error("not found");
    return structuredClone(value) as T;
  };
  return { state, api };
}

describe("product classification contract", () => {
  test("a feature with no technical findings still needs product approval", () => {
    const validated = validateAssessment(assessment(), MANIFEST, []);
    expect(productApproved({ ...record(), assessment: validated })).toBe(false);
    expect(checkSummary(record(), 7)).toContain(CHOICE.question);
  });

  test("restoring an existing contract does not need product approval", () => {
    const restored = { ...assessment("no-product-change"), summary: "Restore reading the existing JSON format on Windows." };
    expect(productApproved({ ...record(), assessment: validateAssessment(restored, MANIFEST, []) })).toBe(true);
  });

  test("the model can retain a recorded scope but cannot invent approval", () => {
    const within = { ...assessment("approved-scope"), approvalId: 7 };
    const approved = [{ checkId: 7, head: BASE, actor: "maintainer", reason: "Support YAML alongside JSON.", decisions: [CHOICE] }];
    expect(validateAssessment(within, MANIFEST, approved).status).toBe("approved-scope");
    expect(() => validateAssessment(within, MANIFEST, [])).toThrow("cannot invent");
    expect(() => validateAssessment({ ...within, approvalId: 8 }, MANIFEST, approved)).toThrow("cannot invent");
  });

  test("a scope expansion stays pending even when an earlier scope is approved", () => {
    const expanded = { ...assessment(), decisions: [{ ...CHOICE, change: "Also accept executable configuration" }] };
    const validated = validateAssessment(expanded, MANIFEST, [{
      checkId: 7, head: BASE, actor: "maintainer", reason: "Only YAML data files.", decisions: [CHOICE],
    }]);
    expect(productApproved({ ...record(), assessment: validated })).toBe(false);
  });

  test("incomplete, stale, contradictory and uncited assessments cannot pass", () => {
    for (const invalid of [
      null, {}, { ...assessment(), head: NEXT },
      { ...assessment(), status: "no-product-change" },
      { ...assessment(), decisions: [] },
      { ...assessment(), approvalId: 7 },
      { ...assessment(), decisions: [{ ...CHOICE, paths: ["not-changed.ts"] }] },
      { ...assessment(), decisions: [{ ...CHOICE, question: "" }] },
    ]) expect(() => validateAssessment(invalid, MANIFEST, [])).toThrow();
    expect(productApproved({ ...record(), assessment: null })).toBe(false);
  });

  test("rendering cannot turn a model's text into a command or approval link", () => {
    const value = record();
    value.assessment!.summary = "@maintainer <script> [approved](https://example.com)";
    const summary = checkSummary(value, 7);
    expect(summary).not.toContain("@maintainer");
    expect(summary).not.toContain("<script>");
    expect(summary).not.toContain("[approved]");
    expect(summary).toContain("/aida product approve 7");
  });
});

describe("one AIDA review workflow", () => {
  test("opening a same-repository PR runs technical review; pushes, edits and forks only check product scope", () => {
    const context = reviewStep("Build immutable review context");
    const route = context.slice(context.indexOf("technical=true"), context.indexOf("git fetch --no-tags"));
    expect(route).toContain("technical=false");
    for (const [event, action, headRepo, expected] of [
      ["pull_request_target", "opened", REPO, "true"],
      ["pull_request_target", "ready_for_review", REPO, "true"],
      ["pull_request_target", "synchronize", REPO, "false"],
      ["pull_request_target", "edited", REPO, "false"],
      ["pull_request_target", "opened", "contributor/fork", "false"],
      ["workflow_dispatch", "", REPO, "true"],
      ["pull_request_review", "submitted", REPO, "true"],
    ]) {
      const result = execFileSync(posixShellPath(), ["-c", `${route}\nprintf '%s' "$technical"`], {
        encoding: "utf8", env: { ...process.env, EVENT_NAME: event, EVENT_ACTION: action, head_repo: headRepo, REPO },
      });
      expect(result).toBe(expected);
    }
  });

  test("the same model runner performs just the product pass on a push", () => {
    const model = reviewStep("Run review passes sequentially");
    const route = model.slice(model.indexOf('if [ "$PRODUCT_SKIP"'), model.indexOf("# The two security lenses"));
    expect(route).toContain('"Product decision"');
    const stub = `run_model() { printf '%s\\n' "$2"; }\ncat() { :; }\njq() { :; }\n`;
    for (const [technical, alreadyReviewed, productSkip, expected] of [
      ["false", "false", "false", "Product decision\n"],
      ["true", "false", "false", "Product decision\ntechnical lenses\n"],
      ["true", "true", "false", "Product decision\n"],
      ["true", "false", "true", "technical lenses\n"],
      ["false", "false", "true", ""],
    ]) {
      const result = execFileSync(posixShellPath(), ["-c", `${stub}${route}\nprintf 'technical lenses\\n'`], {
        encoding: "utf8", env: { ...process.env, TECHNICAL: technical, ALREADY_REVIEWED: alreadyReviewed, PRODUCT_SKIP: productSkip },
      });
      expect(result).toBe(expected);
    }
    expect(REVIEW_WORKFLOW.jobs.review.steps.filter(step => step.run?.includes("npm install --global"))).toHaveLength(1);
    expect(REVIEW_WORKFLOW.jobs.review.steps.find(step => step.name === "Run review passes sequentially")?.env).not.toHaveProperty("GH_TOKEN");
  });
});

describe("maintainer product commands", () => {
  test("exact standalone commands require a reason and bounded numeric check id", () => {
    expect(parseProductCommand("/aida product approve 7 Ship YAML.")).toEqual({ action: "approve", checkId: 7, reason: "Ship YAML." });
    for (const body of [
      "/aida product approve 7", "/aida product approve 7   ",
      "> /aida product approve 7 Ship YAML.",
      "```\n/aida product approve 7 Ship YAML.\n```",
      "/aida product approve 99999999999999999999 Ship YAML.",
      "/aida product approve 7 Ship YAML.\n/aida product reopen 7 Wait.",
    ]) expect(parseProductCommand(body)).toBeNull();
  });

  test("approval updates the check without a model call or a blocking technical review", () => {
    const { state, api } = fixture();
    applyProductCommand(api, REPO, 42, 100, "maintainer", () => true);
    expect(state.checks[0].conclusion).toBe("success");
    const saved = readRecord(state.checks[0], 42);
    expect(saved.approval).toEqual({ actor: "maintainer", commentId: 100, reason: "Support YAML alongside JSON." });
    expect(state.writes.map(write => write.endpoint)).toEqual([
      `repos/${REPO}/check-runs/7`, `repos/${REPO}/issues/comments/100/reactions`,
    ]);
    expect(priorApprovals(api, REPO, 42)).toEqual([{
      checkId: 7, head: HEAD, actor: "maintainer", reason: "Support YAML alongside JSON.", decisions: [CHOICE],
    }]);
  });

  test("an interrupted model has a human path forward with explicit scope", () => {
    const { state, api } = fixture();
    state.checks[0] = check({ ...record(), assessment: null });
    applyProductCommand(api, REPO, 42, 100, "maintainer", () => true);
    expect(state.checks[0].conclusion).toBe("success");
    expect(priorApprovals(api, REPO, 42)[0].reason).toBe("Support YAML alongside JSON.");
  });

  test("comment text cannot impersonate maintainer permission", () => {
    const { state, api } = fixture();
    expect(() => applyProductCommand(api, REPO, 42, 100, "maintainer", () => false)).toThrow("requires a maintainer");
    expect(state.writes).toHaveLength(0);
    expect(priorApprovals(api, REPO, 42)).toEqual([]);
  });

  test("bots, a different actor, and comments on another issue cannot approve", () => {
    for (const mutate of [
      (state: ReturnType<typeof fixture>["state"]) => { state.comments[0].user.type = "Bot"; },
      (state: ReturnType<typeof fixture>["state"]) => { state.comments[0].user.login = "other"; },
      (state: ReturnType<typeof fixture>["state"]) => { state.comments[0].issue_url = `https://api.github.com/repos/${REPO}/issues/43`; },
    ]) {
      const { state, api } = fixture();
      mutate(state);
      expect(() => applyProductCommand(api, REPO, 42, 100, "maintainer", () => true)).toThrow();
      expect(state.writes).toHaveLength(0);
    }
  });

  test("checks from another app, PR or head cannot be approved", () => {
    for (const mutate of [
      (state: ReturnType<typeof fixture>["state"]) => { state.checks[0].app.id = 123; },
      (state: ReturnType<typeof fixture>["state"]) => { state.checks[0].external_id = "aida-product-v1:43"; },
      (state: ReturnType<typeof fixture>["state"]) => { state.head = NEXT; },
      (state: ReturnType<typeof fixture>["state"]) => { state.checks.push(check(record(), 8)); },
    ]) {
      const { state, api } = fixture();
      mutate(state);
      expect(() => applyProductCommand(api, REPO, 42, 100, "maintainer", () => true)).toThrow();
      expect(state.writes).toHaveLength(0);
    }
  });

  test("a push during approval leaves the new head unapproved", () => {
    const { state, api } = fixture();
    state.moveAfter = 1;
    expect(() => applyProductCommand(api, REPO, 42, 100, "maintainer", () => true)).toThrow("head changed");
    expect(state.writes).toHaveLength(0);
  });

  test("reopening removes approval and an old command replay cannot undo it", () => {
    const { state, api } = fixture();
    applyProductCommand(api, REPO, 42, 100, "maintainer", () => true);
    state.comments.push(comment("/aida product reopen 7 Decide whether YAML replaces JSON.", 101));
    applyProductCommand(api, REPO, 42, 101, "maintainer", () => true);
    expect(state.checks[0].conclusion).toBe("action_required");
    expect(priorApprovals(api, REPO, 42)).toEqual([]);
    expect(() => applyProductCommand(api, REPO, 42, 100, "maintainer", () => true)).toThrow("supersedes");
    state.comments.push(comment("/aida product approve 7 Keep both formats supported.", 102));
    applyProductCommand(api, REPO, 42, 102, "maintainer", () => true);
    expect(state.checks[0].conclusion).toBe("success");
  });

  test("reopening current scope prevents older approvals from resurfacing after a push", () => {
    const { state, api } = fixture();
    const earlier = record();
    earlier.head = BASE;
    earlier.assessment!.head = BASE;
    earlier.approval = { actor: "maintainer", commentId: 90, reason: "Original scope." };
    state.checks.push(check(earlier, 6));
    state.comments.push(comment("/aida product approve 6 Original scope.", 90));
    state.comments.push(comment("/aida product reopen 7 Needs a new product decision.", 101));
    applyProductCommand(api, REPO, 42, 101, "maintainer", () => true);
    expect(priorApprovals(api, REPO, 42)).toEqual([]);
  });

  test("a later approval narrows scope even when an older approved check survives", () => {
    const { state, api } = fixture();
    const earlier = record();
    earlier.head = BASE;
    earlier.assessment!.head = BASE;
    earlier.approval = { actor: "maintainer", commentId: 90, reason: "Allow YAML and executable formats." };
    state.checks.push(check(earlier, 6));
    state.comments.push(comment("/aida product approve 6 Allow YAML and executable formats.", 90));
    applyProductCommand(api, REPO, 42, 100, "maintainer", () => true);
    expect(priorApprovals(api, REPO, 42).map(entry => entry.checkId)).toEqual([7]);
  });
});

describe("merge queue product check", () => {
  const entries: QueueEntry[] = [
    { baseCommit: { oid: BASE }, headCommit: { oid: "d".repeat(40) }, pullRequest: { number: 42, headRefOid: HEAD } },
    { baseCommit: { oid: "d".repeat(40) }, headCommit: { oid: "e".repeat(40) }, pullRequest: { number: 43, headRefOid: NEXT } },
  ];
  test("resolve all PRs in a group by GitHub's commit chain, not the last branch name", () => {
    expect(queueMembers(entries, BASE, "e".repeat(40)).map(entry => entry.pullRequest.number)).toEqual([43, 42]);
    expect(() => queueMembers(entries.slice(1), BASE, "e".repeat(40))).toThrow("no longer matches");
    expect(() => queueMembers([], BASE, BASE)).toThrow("empty");
  });

  test("one uncleared member blocks the entire group", () => {
    const { state, api } = fixture();
    state.queue = entries;
    state.checks.push(check({ ...record("no-product-change"), pr: 43, head: NEXT,
      assessment: { ...assessment("no-product-change"), head: NEXT } }, 8));
    expect(() => verifyQueue(api, REPO, BASE, "e".repeat(40))).toThrow("PR #42");
    state.checks[0] = check(record("no-product-change"));
    expect(() => verifyQueue(api, REPO, BASE, "e".repeat(40))).not.toThrow();
  });

  test("a green result on a previous PR revision cannot clear the group", () => {
    const { state, api } = fixture();
    state.queue = entries.slice(0, 1);
    state.checks[0] = check(record("no-product-change"));
    state.head = NEXT;
    expect(() => verifyQueue(api, REPO, BASE, "d".repeat(40))).toThrow("moved");
  });
});

test("CLI lifecycle: immutable diff, maintainer approval and the next push within that scope", () => {
  const root = mkdtempSync(join(tmpdir(), "aida-product-cli-"));
  try {
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    git("init", "-q");
    git("config", "user.name", "Fixture");
    git("config", "user.email", "fixture@example.com");
    writeFileSync(join(root, "format.ts"), "export const formats = ['json'];\n");
    git("add", "format.ts");
    git("commit", "-qm", "base");
    const base = git("rev-parse", "HEAD");
    writeFileSync(join(root, "format.ts"), "export const formats = ['json', 'yaml'];\n");
    git("commit", "-qam", "support YAML");
    const head = git("rev-parse", "HEAD");
    git("update-ref", "refs/pull/42/head", head);
    git("remote", "add", "origin", root);
    const statePath = join(root, "github.json");
    const state = {
      pull: { number: 42, state: "open", draft: false, base: { sha: base, ref: "main" }, head: { sha: head } },
      checks: [] as Array<ReturnType<typeof check>>,
      comments: [] as Array<ReturnType<typeof comment>>,
    };
    writeFileSync(statePath, JSON.stringify(state));
    const fakeGh = join(root, "gh.ts");
    writeFileSync(fakeGh, `
import { readFileSync, writeFileSync } from "node:fs";
const path = ${JSON.stringify(statePath)};
const state = JSON.parse(readFileSync(path, "utf8"));
const args = process.argv.slice(2);
const endpoint = args[1];
const method = args[args.indexOf("--method") + 1] ?? "GET";
const input = args.includes("--input") ? JSON.parse(readFileSync(0, "utf8")) : null;
let value;
if (endpoint.endsWith("/permission")) value = { permission: "write" };
else if (endpoint.endsWith("/pulls/42")) value = state.pull;
else if (endpoint.includes("/commits/")) value = { check_runs: state.checks.filter(c => endpoint.includes(c.head_sha)) };
else if (endpoint.includes("/issues/42/comments?")) value = state.comments;
else if (endpoint.endsWith("/reactions")) value = {};
else if (endpoint.includes("/issues/comments/")) value = state.comments.find(c => c.id === Number(endpoint.split("/").at(-1)));
else if (endpoint.endsWith("/check-runs") && method === "POST") {
  value = { ...input, id: state.checks.length + 7, app: { id: 15368 }, conclusion: null };
  state.checks.push(value);
} else if (endpoint.includes("/check-runs/")) {
  value = state.checks.find(c => c.id === Number(endpoint.split("/").at(-1)));
  if (method === "PATCH") Object.assign(value, input);
}
if (!value) throw new Error("unexpected request " + args.join(" "));
writeFileSync(path, JSON.stringify(state));
console.log(JSON.stringify(value));
`);
    const runner = join(root, "run.ts");
    const moduleUrl = new URL("../../.github/scripts/ai-product-decision.ts", import.meta.url).href;
    writeFileSync(runner, `import { main } from ${JSON.stringify(moduleUrl)};\nmain(process.argv.slice(2), [process.execPath, ${JSON.stringify(fakeGh)}]);\n`);
    const run = (command: string, ...extra: string[]) => execFileSync(process.execPath,
      [runner, command, "--repo", REPO, "--pr", "42", ...extra],
      { cwd: root, encoding: "utf8", env: { ...process.env, GITHUB_OUTPUT: join(root, "outputs") }, stdio: ["ignore", "pipe", "pipe"] });
    const load = () => JSON.parse(readFileSync(statePath, "utf8")) as typeof state;
    run("start");
    expect(load().checks[0].conclusion).toBeNull();
    git("checkout", "--detach", base);
    buildContext(base, base, join(root, ".ai-review-context"), root);
    expect(() => run("prepare")).toThrow();
    buildContext(base, head, join(root, ".ai-review-context"), root);
    run("prepare");
    expect(git("rev-parse", "HEAD")).toBe(base);
    expect(readFileSync(join(root, ".ai-review-context/head/format.ts"), "utf8")).toContain("'yaml'");
    const inputPath = join(root, "assessment.json");
    const proposed = { ...assessment(), base, head, decisions: [{ ...CHOICE, paths: ["format.ts"] }] };
    writeFileSync(inputPath, JSON.stringify(proposed));
    run("finish", "--input", inputPath);
    expect(load().checks[0].conclusion).toBe("action_required");
    const pending = load();
    pending.comments.push(comment());
    writeFileSync(statePath, JSON.stringify(pending));
    run("command", "--comment", "100", "--actor", "maintainer");
    expect(load().checks[0].conclusion).toBe("success");

    git("checkout", "--detach", head);
    writeFileSync(join(root, "format.ts"), "export const formats = ['json', 'yaml'] as const;\n");
    git("commit", "-qam", "type the existing formats");
    const nextHead = git("rev-parse", "HEAD");
    git("update-ref", "refs/pull/42/head", nextHead);
    const updated = load();
    updated.pull.head.sha = nextHead;
    writeFileSync(statePath, JSON.stringify(updated));
    run("start");
    expect(load().checks[1].conclusion).toBeNull();
    git("checkout", "--detach", base);
    buildContext(base, nextHead, join(root, ".ai-review-context"), root);
    run("prepare");
    const approvals = JSON.parse(readFileSync(join(root, ".ai-review-context/product-approvals.json"), "utf8"));
    expect(approvals[0].checkId).toBe(7);
    writeFileSync(inputPath, JSON.stringify({ ...proposed, head: nextHead, status: "approved-scope", approvalId: 7 }));
    run("finish", "--input", inputPath);
    expect(load().checks[1].conclusion).toBe("success");

    const ready = load();
    ready.comments.push(comment("/aida product reopen 8 Reconsider the supported formats.", 101));
    writeFileSync(statePath, JSON.stringify(ready));
    run("command", "--comment", "101", "--actor", "maintainer");
    run("start");
    expect(load().checks[1].conclusion).toBe("action_required");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
