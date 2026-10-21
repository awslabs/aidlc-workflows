// covers: function:stageReviewStep, function:nextReviewStepFor, function:personSpokeSinceReviewRequest, subcommand:aidlc-orchestrate:next, subcommand:aidlc-log:review
// A stage-level review that is open is finished by the step `next` names, in every state the
// review log can leave it in, and each command the step names is one the log accepts.
import { afterEach, describe, expect, test, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import {
  AIDLC_SRC, cleanupTestProject, createOrchestrationTestProject, createTestProject, FIXTURES_DIR, resetAidlcEnv,
  runOrchestrateNext, seedAidlcMemory, seededRecordDir, seededStateFile, seedStateFile,
} from "../harness/fixtures.ts";
import {
  artifactFilename, findStageBySlug, nextReviewStepFor, turnEndIsOpen, type GuardAttemptState,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { codeGenerationRecordDir } from "../../dist/claude/.claude/tools/aidlc-testing-posture.ts";

setDefaultTimeout(600_000);
resetAidlcEnv();
const projects: string[] = [];
afterEach(() => { while (projects.length) cleanupTestProject(projects.pop()); });

const SESSION = "01995000-7a11-7000-8000-00000000a519";
const NEXT = join(AIDLC_SRC, "tools/aidlc-orchestrate.ts");
const SLUG = "code-generation";
const REVIEWER = findStageBySlug(SLUG)!.reviewer!;

function agentEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, AIDLC_UNATTENDED: "0" };
  delete env.AIDLC_SKIP_HUMAN_PRESENCE_GUARD;
  delete env.AIDLC_SESSION_OVERRIDE_SOURCE;
  return { ...env, AIDLC_SKIP_ARTIFACT_GUARD: "1", AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD: "1", AIDLC_SESSION_OVERRIDE: SESSION };
}
function review(p: string, iteration: number, extra: string[] = []) {
  const r = spawnSync(process.execPath, [
    join(AIDLC_SRC, "tools/aidlc-log.ts"), "review", "--stage", SLUG, "--reviewer", REVIEWER,
    "--iteration", String(iteration), ...extra, "--project-dir", p,
  ], { timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS), encoding: "utf-8", env: agentEnv() });
  const last = (r.stdout ?? "").trim().split(/\r?\n/).at(-1) ?? "";
  let json: Record<string, unknown> = {};
  try { json = JSON.parse(last); } catch { /* not json */ }
  return { status: r.status, json };
}
function next(p: string): { kind?: string; message?: string } {
  return runOrchestrateNext(NEXT, p, [], { env: agentEnv() }).directive as { kind?: string; message?: string };
}

// What the person types, through the real prompt hook every harness uses.
function says(p: string, prompt: string): void {
  const env: NodeJS.ProcessEnv = { ...agentEnv(), AIDLC_PROJECT_DIR: p, CLAUDE_PROJECT_DIR: p };
  const result = spawnSync(process.execPath, [join(AIDLC_SRC, "tools/aidlc.ts"), "engine", "hook", "record-human-turn"], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS), encoding: "utf-8", cwd: p, env,
    input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: SESSION, prompt }),
  });
  expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
}

// Zero-Unit Code Generation under an adversarial review: the stage-level route, with a repair state.
function fixture(): string {
  const p = createOrchestrationTestProject();
  projects.push(p);
  const state = readFileSync(join(FIXTURES_DIR, "state-brownfield-feature.md"), "utf-8")
    .replace("- **Scope**: feature", "- **Scope**: poc")
    .replace("- **Change Control**: strict (from scope feature)", "- **Guard Policy**: relaxed (from scope poc)\n- **Review Override**: adversarial")
    .replace(/^- \*\*Current Stage\*\*:.*$/m, "- **Current Stage**: code-generation")
    .replace("- [ ] units-generation — EXECUTE", "- [S] units-generation — SKIP");
  writeFileSync(seededStateFile(p), state, "utf-8");
  const dir = codeGenerationRecordDir(p, null);
  mkdirSync(dir, { recursive: true });
  for (const slug of findStageBySlug(SLUG)!.produces ?? []) {
    writeFileSync(join(dir, artifactFilename(slug)), `# ${slug}\n\n## One\n\n## Two\n`, "utf-8");
  }
  return p;
}
interface Run { p: string; iter: number; file: string }
function start(): Run { return { p: fixture(), iter: 0, file: "" }; }
function request(r: Run): void { r.iter += 1; r.file = String(review(r.p, r.iter).json.reviewFile); }
function retry(r: Run): void { review(r.p, r.iter, ["--retry-pending"]); }
function writeReview(r: Run, verdict: "READY" | "NOT-READY"): void {
  const f = join(r.p, r.file);
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, `**Verdict:** ${verdict}\n**Reviewer:** ${REVIEWER}\n**Iteration:** ${r.iter}\n\n### Findings\n\n` +
    (verdict === "READY" ? "No blocking findings.\n"
      : "| ID | Severity | Location | Finding | Required action | Status |\n|---|---|---|---|---|---|\n| R-01 | Major | src/base.ts | Not covered. | Cover it. | New |\n"));
}
function verdict(r: Run, v: "READY" | "NOT-READY"): void { review(r.p, r.iter, ["--verdict", v]); }
function editDeliverable(r: Run): void {
  appendFileSync(join(codeGenerationRecordDir(r.p, null), artifactFilename(findStageBySlug(SLUG)!.produces![0])), "\nedited\n");
}
const reviewCmd = (iteration: number, extra = ""): string =>
  `review --stage ${SLUG} --reviewer ${REVIEWER} --iteration ${iteration}${extra}`;

describe("stage-level review step: next names the step the review log accepts", () => {
  test("requested, no review written: verdict, or the one retry", () => {
    const r = start(); request(r);
    const d = next(r.p);
    expect(d.kind).toBe("print");
    expect(d.message).toContain("waiting for a verdict");
    expect(d.message).toContain(reviewCmd(1, " --verdict"));
    expect(d.message).toContain(reviewCmd(1, " --retry-pending"));
    expect(turnEndIsOpen(r.p)).toBe(false);
    expect(review(r.p, 1, ["--retry-pending"]).status).toBe(0);
  });
  test("a chat that never saw the request is told which review file holds the verdict", () => {
    const r = start(); request(r); writeReview(r, "READY");
    const d = next(r.p);
    expect(r.file).toContain(".aidlc-engine/reviews/");
    expect(d.message).toContain(r.file);
    expect(d.message).toContain(reviewCmd(1, " --verdict"));
    expect(turnEndIsOpen(r.p)).toBe(false);
  });
  test("the file is named when the person has written too", () => {
    const r = start(); request(r); writeReview(r, "READY");
    says(r.p, "carry on");
    expect(next(r.p).message).toContain(r.file);
  });
  test("retry spent: the verdict only, and the fallback is named as a review that did not finish", () => {
    const r = start(); request(r); retry(r);
    const d = next(r.p);
    expect(d.kind).toBe("print");
    expect(d.message).toContain("retry is spent");
    expect(d.message).not.toContain("--retry-pending");
    expect(d.message).toContain("did not finish");
    expect(review(r.p, 1, ["--verdict", "NOT-READY"]).status).toBe(0);
  });
  test("documents changed since the request: the same pass is asked for again", () => {
    const r = start(); request(r); editDeliverable(r);
    const d = next(r.p);
    expect(d.kind).toBe("print");
    expect(d.message).toContain("asked for again");
    expect(d.message).toContain(reviewCmd(1));
    expect(d.message).not.toContain("--retry-pending");
    expect(review(r.p, 1).status).toBe(0);
  });
  test("repairs made after NOT-READY: the next pass is requested", () => {
    const r = start(); request(r); writeReview(r, "NOT-READY"); verdict(r, "NOT-READY"); editDeliverable(r);
    const d = next(r.p);
    expect(d.kind).toBe("print");
    expect(d.message).toContain(reviewCmd(2));
    expect(review(r.p, 2).status).toBe(0);
  });
  test("a review that did not finish: a new pass is requested", () => {
    const r = start(); request(r); retry(r); verdict(r, "NOT-READY");
    const d = next(r.p);
    expect(d.kind).toBe("print");
    expect(d.message).toContain("did not finish");
    expect(d.message).toContain(reviewCmd(2));
  });
});

// Per Unit, units-generation planned, and no Unit DAG yet: the stage-level route.
function noDagFixture(extra: string): string {
  const p = createOrchestrationTestProject();
  projects.push(p);
  const state = readFileSync(join(FIXTURES_DIR, "state-brownfield-feature.md"), "utf-8")
    .replace(/^- \*\*Current Stage\*\*:.*$/m, "- **Current Stage**: code-generation")
    .replace("- **Change Control**: strict (from scope feature)", `- **Change Control**: strict (from scope feature)\n- **Review Override**: adversarial${extra}`);
  writeFileSync(seededStateFile(p), state, "utf-8");
  const dir = codeGenerationRecordDir(p, null);
  mkdirSync(dir, { recursive: true });
  for (const slug of findStageBySlug(SLUG)!.produces ?? []) {
    writeFileSync(join(dir, artifactFilename(slug)), `# ${slug}\n\n## One\n\n## Two\n`, "utf-8");
  }
  return p;
}

describe("stage-level review step: a per-unit stage with no Unit DAG", () => {
  test("solo: an open review is finished by the step", () => {
    const r: Run = { p: noDagFixture(""), iter: 0, file: "" }; request(r);
    const d = next(r.p);
    expect(d.kind).toBe("print");
    expect(d.message).toContain(reviewCmd(1, " --verdict"));
  });
  test("team ownership under unit-major: the route's error is not hidden by the step", () => {
    const r: Run = { p: noDagFixture("\n- **Unit Ownership**: team\n- **Construction Iteration**: unit-major"), iter: 0, file: "" };
    request(r);
    const d = next(r.p);
    expect(d.kind).toBe("error");
    expect(d.message).toContain("Unit Ownership: team requires a valid non-empty authoritative Unit DAG");
  });
});

describe("stage-level review step: the person wrote since the review was asked", () => {
  test("what they asked comes first; the retry is theirs to ask for, the NOT-READY fallback is not named, and the step ends the turn", () => {
    const r = start(); request(r);
    says(r.p, "approve it as it is");
    const d = next(r.p);
    expect(d.kind).toBe("print");
    expect(d.message).toContain("what they asked comes first");
    expect(d.message).toContain("if they asked to approve the work as it is, report that approval with their words");
    expect(d.message).toContain("If they asked to carry on with the review");
    expect(d.message).toContain(reviewCmd(1, " --retry-pending"));
    expect(d.message).not.toContain("NOT-READY without");
    expect(d.message).toContain("If they asked for anything else, do that and stop.");
    expect((d.message ?? "").indexOf("Then run")).toBeGreaterThan((d.message ?? "").indexOf("If they asked to carry on"));
    expect(turnEndIsOpen(r.p)).toBe(true);
  });
  test("a question changes nothing, so the same step comes back and still ends the turn, and carrying on works", () => {
    const r = start(); request(r);
    says(r.p, "how is it going?");
    expect(next(r.p).message).toContain("If they asked for anything else, do that and stop.");
    expect(next(r.p).message).toContain(reviewCmd(1, " --retry-pending"));
    expect(review(r.p, 1, ["--retry-pending"]).status).toBe(0);
  });
  test("a spent retry: no retry, and the fallback only if they asked to carry on; following it advances", () => {
    const r = start(); request(r); retry(r);
    says(r.p, "carry on");
    const d = next(r.p);
    const msg = d.message ?? "";
    expect(msg).toContain("what they asked comes first");
    expect(msg).not.toContain("--retry-pending");
    expect(msg.indexOf("record NOT-READY without one")).toBeGreaterThan(msg.indexOf("If they asked to carry on and no review file is there"));
    expect(msg).toContain("If they asked for anything else, do that and stop.");
    // the person asked to carry on, no review is there: the step's own fallback records and the review moves on
    expect(review(r.p, 1, ["--verdict", "NOT-READY"]).status).toBe(0);
    const after = next(r.p);
    expect(after.message).not.toBe(d.message);
    expect(after.message).toContain("did not finish");
  });
  test("a team lock on strict, through the real next: approval waits for the review and the file is named", () => {
    const r = start(); request(r);
    const dir = join(r.p, "aidlc", "spaces", "default", "memory");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "project.md"), "# Project\n\n## Guard Policy\n\nMode: strict\n", "utf-8");
    says(r.p, "approve it as it is");
    const d = next(r.p);
    expect(d.kind).toBe("print");
    expect(d.message).toContain("approval cannot go over this review");
    expect(d.message).toContain("project.md");
    expect(d.message).not.toContain("report that approval");
  });
  test("the same words before the review was asked change nothing", () => {
    const r = start();
    says(r.p, "approve it as it is");
    request(r);
    expect(next(r.p).message).toContain("--retry-pending");
  });
});

describe("stage-level review step: states that keep the stage body", () => {
  test("never asked for", () => {
    expect(next(start().p).kind).toBe("run-stage");
  });
  test("the reviewer asked for repairs: they are the lead's own work", () => {
    const r = start(); request(r); writeReview(r, "NOT-READY"); verdict(r, "NOT-READY");
    expect(next(r.p).kind).toBe("run-stage");
  });
  test("a final verdict is recorded", () => {
    const r = start(); request(r); writeReview(r, "READY"); verdict(r, "READY");
    expect(next(r.p).kind).toBe("run-stage");
  });
});

// Requirements Analysis under an advisory review: one pass, and a NOT-READY is terminal.
describe("stage-level review step: an advisory review", () => {
  const RA = "requirements-analysis";
  const raReviewer = findStageBySlug(RA)!.reviewer!;
  function inception(): string {
    const p = createTestProject();
    projects.push(p);
    seedAidlcMemory(p);
    seedStateFile(p, "state-mid-inception.md");
    const path = seededStateFile(p);
    writeFileSync(path, readFileSync(path, "utf-8").replace(
      /^- \*\*Change Control\*\*: .*$/m,
      "- **Guard Policy**: off (set by you)\n- **Review Override**: advisory",
    ));
    const dir = join(seededRecordDir(p), "inception", RA);
    mkdirSync(dir, { recursive: true });
    for (const name of ["requirements.md", "requirements-analysis-questions.md"]) writeFileSync(join(dir, name), `# ${name}\n`);
    return p;
  }
  const raReview = (p: string, extra: string[] = []) => {
    const r = spawnSync(process.execPath, [
      join(AIDLC_SRC, "tools/aidlc-log.ts"), "review", "--stage", RA, "--reviewer", raReviewer,
      "--iteration", "1", ...extra, "--project-dir", p,
    ], { timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS), encoding: "utf-8", env: agentEnv() });
    return r.status;
  };
  test("never asked for keeps the body; asked for, it names the step the log accepts", () => {
    const p = inception();
    expect(next(p).kind).toBe("run-stage");
    expect(raReview(p)).toBe(0);
    const d = next(p);
    expect(d.kind).toBe("print");
    expect(d.message).toContain(`review --stage ${RA} --reviewer ${raReviewer} --iteration 1 --verdict`);
    expect(raReview(p, ["--retry-pending"])).toBe(0);
  });
});

// The rows a fixture cannot build: the table over a hand-made attempt state.
describe("nextReviewStepFor: the table", () => {
  const base: GuardAttemptState = { recovery: "available", summaryCoverage: "current", reviewCoverage: "missing", sourceCoverage: "current" };
  const step = (attempt: Partial<GuardAttemptState>, didNotFinish = false, retryRequest?: string) =>
    nextReviewStepFor({ attempt: { ...base, ...attempt }, didNotFinish, ...(retryRequest ? { retryRequest } : {}), subject: "S" });
  test("nothing pending: no step", () => { expect(step({})).toBeNull(); });
  test("an owed request names it", () => {
    expect(step({ nextReview: { iteration: 2, request: "REQ2" } })?.kind).toBe("request");
  });
  test("repairs are repairs; a review that did not finish is a request", () => {
    expect(step({ repairReview: { iteration: 1 }, requestReview: "REQ2" })?.kind).toBe("repairs");
    expect(step({ repairReview: { iteration: 1 }, requestReview: "REQ2" }, true)?.kind).toBe("request");
  });
  test("a waiting request with its retry unspent offers both", () => {
    const s = step({ pendingReview: { iteration: 1, retryable: true, verdictRecordable: true, recordVerdict: "VERD" } }, false, "RETRY");
    expect(s?.text).toContain("VERD");
    expect(s?.text).toContain("RETRY");
  });
  test("a request with an older binding can only be retried", () => {
    const s = step({ pendingReview: { iteration: 1, retryable: true, verdictRecordable: false, recordVerdict: "VERD" } }, false, "RETRY");
    expect(s?.text).toContain("RETRY");
    expect(s?.text).not.toContain("VERD");
  });
  test("a review that could not be verified is run again before any verdict", () => {
    const attempt = { pendingReview: { iteration: 1, retryable: true, verdictRecordable: true, recordVerdict: "VERD" } };
    const s = nextReviewStepFor({ attempt: { ...base, ...attempt }, retryRequest: "RETRY", verificationFailed: true, subject: "S" });
    expect(s?.text).toContain("RETRY");
    expect(s?.text).not.toContain("VERD");
    const spent = { pendingReview: { iteration: 1, retryable: false, verdictRecordable: true, recordVerdict: "VERD" } };
    expect(nextReviewStepFor({ attempt: { ...base, ...spent }, verificationFailed: true, subject: "S" })).toBeNull();
  });
  test("when the person wrote since, their words first, the retry theirs to ask for, and the turn ends", () => {
    const attempt = { pendingReview: { iteration: 1, retryable: true, verdictRecordable: true, recordVerdict: "VERD" } };
    const s = nextReviewStepFor({ attempt: { ...base, ...attempt }, retryRequest: "RETRY", personSpoke: true, subject: "S" });
    expect(s?.personFirst).toBe(true);
    expect(s?.text).toContain("what they asked comes first");
    expect(s?.text).toContain("VERD");
    expect(s?.text).toContain("If they asked to carry on");
    expect(s?.text).toContain("RETRY");
    expect(s?.text).toContain("If they asked for anything else, do that and stop.");
    const spent = nextReviewStepFor({ attempt: { ...base, ...attempt, pendingReview: { ...attempt.pendingReview, retryable: false } }, personSpoke: true, subject: "S" });
    expect(spent?.text).not.toContain("RETRY");
    const owed = nextReviewStepFor({ attempt: { ...base, nextReview: { iteration: 2, request: "REQ2" } }, personSpoke: true, subject: "S" });
    expect(owed?.personFirst).toBe(true);
    expect(owed?.text).toContain("REQ2");
    expect(nextReviewStepFor({ attempt: { ...base, ...attempt }, retryRequest: "RETRY", subject: "S" })?.personFirst).toBeUndefined();
  });
  test("the verdict is recorded only if they asked to carry on, and then next runs; approval or a question ends the turn", () => {
    const attempt = { pendingReview: { iteration: 1, retryable: true, verdictRecordable: true, recordVerdict: "VERD" } };
    const s = nextReviewStepFor({ attempt: { ...base, ...attempt }, retryRequest: "RETRY", personSpoke: true, nextCommand: "NEXT", subject: "S" });
    const text = s?.text ?? "";
    expect(text.indexOf("VERD")).toBeGreaterThan(text.indexOf("If they asked to carry on"));
    expect(text.indexOf("`NEXT`")).toBeGreaterThan(text.indexOf("RETRY"));
    expect(text.endsWith("If they asked for anything else, do that and stop.")).toBe(true);
    const owed = nextReviewStepFor({ attempt: { ...base, nextReview: { iteration: 2, request: "REQ2" } }, personSpoke: true, nextCommand: "NEXT", subject: "S" });
    expect(owed?.text.indexOf("REQ2")).toBeGreaterThan((owed?.text ?? "").indexOf("If they asked to carry on"));
    expect(owed?.text).toContain("`NEXT`");
  });
  test("fallback off: a spent retry records the verdict and names no NOT-READY fallback", () => {
    const attempt = { pendingReview: { iteration: 1, retryable: false, verdictRecordable: true, recordVerdict: "VERD" } };
    const on = nextReviewStepFor({ attempt: { ...base, ...attempt }, subject: "S" });
    const off = nextReviewStepFor({ attempt: { ...base, ...attempt }, fallback: false, subject: "S" });
    expect(on?.text).toContain("still wrote no whole review, record NOT-READY;");
    expect(off?.text).toContain("VERD");
    expect(off?.text).not.toContain("NOT-READY");
    expect(off?.personFirst).toBeUndefined();
  });
  test("the person wrote and the retry is spent: the fallback is theirs to ask for, and the file is named", () => {
    const attempt = { pendingReview: { iteration: 1, retryable: false, verdictRecordable: true, recordVerdict: "VERD" } };
    const s = nextReviewStepFor({ attempt: { ...base, ...attempt }, personSpoke: true, nextCommand: "NEXT", reviewFile: "REVIEW.md", subject: "S" });
    const text = s?.text ?? "";
    expect(text).toContain("REVIEW.md");
    expect(text.indexOf("record NOT-READY without one")).toBeGreaterThan(text.indexOf("If they asked to carry on and no review file is there"));
    expect(text.indexOf("`NEXT`")).toBeGreaterThan(text.indexOf("record NOT-READY without one"));
    expect(text).not.toContain("RETRY");
    const off = nextReviewStepFor({ attempt: { ...base, ...attempt }, personSpoke: true, fallback: false, subject: "S" });
    expect(off?.text).not.toContain("NOT-READY without one");
  });
  test("a team lock on strict says approval waits for the review, and names the file", () => {
    const attempt = { pendingReview: { iteration: 1, retryable: true, verdictRecordable: true, recordVerdict: "VERD" } };
    const s = nextReviewStepFor({
      attempt: { ...base, ...attempt }, retryRequest: "RETRY", personSpoke: true,
      approval: { allowed: false, lockedIn: "aidlc/memory/team.md" }, subject: "S",
    });
    expect(s?.text).toContain("approval cannot go over this review");
    expect(s?.text).toContain("aidlc/memory/team.md");
    expect(s?.text).not.toContain("report that approval");
    expect(s?.text).toContain("RETRY");
  });
  test("a review that could not be verified, and the person wrote: their words first, the rerun theirs to ask for, approval refused", () => {
    const attempt = { pendingReview: { iteration: 1, retryable: true, verdictRecordable: true, recordVerdict: "VERD" } };
    const s = nextReviewStepFor({
      attempt: { ...base, ...attempt }, retryRequest: "RETRY", verificationFailed: true, personSpoke: true, subject: "S",
    });
    expect(s?.personFirst).toBe(true);
    expect(s?.text).toContain("what they asked comes first");
    expect(s?.text).toContain("approval cannot go over a review that could not be verified");
    expect(s?.text).toContain("If they asked to carry on with the review");
    expect(s?.text).toContain("RETRY");
    expect(s?.text).not.toContain("VERD");
    const spent = nextReviewStepFor({
      attempt: { ...base, pendingReview: { ...attempt.pendingReview, retryable: false } }, verificationFailed: true, personSpoke: true, subject: "S",
    });
    expect(spent?.personFirst).toBe(true);
    expect(spent?.text).not.toContain("RETRY");
  });
  test("a request or a retry carries the reviewer dispatch and the review file", () => {
    const owed = step({ nextReview: { iteration: 2, request: "REQ2" } });
    expect(owed?.text).toContain("dispatch the reviewer");
    expect(owed?.text).toContain("reviewFile");
    const waiting = step({ pendingReview: { iteration: 1, retryable: true, verdictRecordable: true, recordVerdict: "VERD" } }, false, "RETRY");
    expect(waiting?.text).toContain("dispatch the reviewer");
  });
  test("a request that can be neither retried nor recorded gives no step", () => {
    expect(step({ pendingReview: { iteration: 1, retryable: false, verdictRecordable: false } })).toBeNull();
  });
});
