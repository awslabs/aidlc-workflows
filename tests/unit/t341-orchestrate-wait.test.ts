// covers: subcommand:aidlc-orchestrate:wait, function:handleWait, function:unrecordedFinishSince,
// hook:aidlc-log-subagent, hook:aidlc-deliver-stage-rules, audit:SUBAGENT_COMPLETED, audit:REVIEW_COMPLETED

import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";
import { afterEach, beforeAll, describe, expect, test, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  auditBlockField,
  hooksHealthDir,
  readAllAuditShards,
  resolveWorkflowSelection,
  REVIEW_EDITED_FIELD,
  REVIEW_FILE_DIGEST_FIELD,
  reviewFileDigest,
  type ReviewRecord,
  setGuardPolicyLine,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createOrchestrationTestProject,
  resetAidlcEnv,
  seededRecordDir,
  seededStateFile,
  seedStateFile,
} from "../harness/fixtures.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

// `aidlc engine orchestrate wait` is the sanctioned wait for dispatched work on
// a harness whose Agent/Task call returns before the worker finishes. It polls
// the same on-disk evidence the engine checks and always returns within its
// bound, so the conductor re-runs one pre-approved command instead of minting
// a shell loop. Every case spawns the CLI: the verb's contract is its argv and
// its JSON, not an importable function.

const ORCHESTRATE = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
const USAGE = "Usage: wait --stage <slug> --for collaborators|artifacts|review";

let project = "";
beforeAll(() => {
  resetAidlcEnv();
});
afterEach(() => {
  resetAidlcEnv();
  if (project) cleanupTestProject(project);
  project = "";
});

/** A project whose seeded intent carries a state file, so the active intent resolves. */
function activeIntentProject(
  fixture = "state-mid-inception.md",
): string {
  const proj = createOrchestrationTestProject();
  seedStateFile(proj, fixture);
  return proj;
}

function wait(args: string[]) {
  const res = spawnSync(
    process.execPath,
    [ORCHESTRATE, "wait", ...args, "--project-dir", project],
    { timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS), encoding: "utf-8" },
  );
  let json: Record<string, unknown> | null = null;
  try {
    json = JSON.parse(res.stdout.trim().split("\n").pop() ?? "") as Record<string, unknown>;
  } catch {
    json = null;
  }
  return { status: res.status ?? -1, stdout: res.stdout, stderr: res.stderr, json };
}

describe("t341 orchestrate wait", () => {
  test("refuses a missing target, an unknown stage, and a review wait without a file", () => {
    project = createOrchestrationTestProject();
    const noTarget = wait(["--stage", "practices-discovery"]);
    expect(noTarget.status).toBe(1);
    expect(noTarget.stderr).toContain(USAGE);

    const unknown = wait(["--stage", "no-such-stage", "--for", "artifacts"]);
    expect(unknown.status).toBe(1);
    expect(unknown.stderr).toContain('Unknown stage "no-such-stage"');

    const reviewWithoutFile = wait(["--stage", "requirements-analysis", "--for", "review"]);
    expect(reviewWithoutFile.status).toBe(1);
    expect(reviewWithoutFile.stderr).toContain("--for review needs --review-file <path>");

    // No state file means no active intent: an artifacts wait must refuse rather
    // than settle against a record that does not exist.
    const noIntent = wait(["--stage", "requirements-analysis", "--for", "artifacts", "--timeout", "1"]);
    expect(noIntent.status).toBe(1);
    expect(noIntent.stderr).toContain("No active intent record resolves");
  });

  test("collaborators: names every missing contribution, then settles once the identity markers exist", () => {
    project = activeIntentProject();
    // The fixture scope ships collaborators off; this case exercises the
    // populated-roster wait, so pin the switch on for this run.
    appendFileSync(
      seededStateFile(project),
      "- **Collaborators**: on (set by you)\n",
    );
    const waiting = wait([
      "--stage", "practices-discovery", "--for", "collaborators", "--timeout", "1",
    ]);
    expect(waiting.status, waiting.stderr).toBe(0);
    expect(waiting.json?.status).toBe("waiting");
    expect(waiting.json?.for).toBe("collaborators");
    expect(waiting.json?.missing).toEqual([
      "aidlc-quality-agent (no contribution file)",
      "aidlc-developer-agent (no contribution file)",
      "aidlc-devsecops-agent (no contribution file)",
    ]);
    expect(Number(waiting.json?.waited_ms)).toBeGreaterThanOrEqual(900);
    expect(String(waiting.json?.next)).toContain("Never replace it with a shell loop");

    const dir = join(seededRecordDir(project), "inception", "practices-discovery", "contributions");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "aidlc-quality-agent.md"), "**Collaborator:** aidlc-quality-agent\n\nnotes\n");
    writeFileSync(join(dir, "aidlc-developer-agent.md"), "# not the identity marker\n");
    writeFileSync(join(dir, "aidlc-devsecops-agent.md"), "**Collaborator:** aidlc-devsecops-agent\n");
    const partial = wait([
      "--stage", "practices-discovery", "--for", "collaborators", "--timeout", "1",
    ]);
    expect(partial.json?.status).toBe("waiting");
    expect(partial.json?.missing).toEqual([
      "aidlc-developer-agent (missing identity-marker first line)",
    ]);

    writeFileSync(join(dir, "aidlc-developer-agent.md"), "**Collaborator:** aidlc-developer-agent\n");
    // Settled comes back at once, not at its bound: waited_ms is then only the
    // time of one check, which is a hosted runner's speed, so the bound here is
    // the call's own and far above any check.
    const settled = wait([
      "--stage", "practices-discovery", "--for", "collaborators", "--timeout", "30",
    ]);
    expect(settled.json?.status).toBe("settled");
    expect(settled.json?.missing).toEqual([]);
    expect(Number(settled.json?.waited_ms)).toBeLessThan(30_000);
    expect(String(settled.json?.next)).toContain("continue the stage body");
  });

  test("artifacts: waits until every required declared artifact of the stage carries bytes", () => {
    project = activeIntentProject();
    const waiting = wait([
      "--stage", "requirements-analysis", "--for", "artifacts", "--timeout", "1",
    ]);
    expect(waiting.status, waiting.stderr).toBe(0);
    expect(waiting.json?.status).toBe("waiting");
    expect(waiting.json?.missing).toEqual([
      "inception/requirements-analysis/requirements.md (absent or empty)",
      "inception/requirements-analysis/requirements-analysis-questions.md (absent or empty)",
    ]);

    const dir = join(seededRecordDir(project), "inception", "requirements-analysis");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "requirements.md"), "# Requirements\n");
    writeFileSync(join(dir, "requirements-analysis-questions.md"), "");
    const emptyFile = wait([
      "--stage", "requirements-analysis", "--for", "artifacts", "--timeout", "1",
    ]);
    expect(emptyFile.json?.status).toBe("waiting");
    expect(emptyFile.json?.missing).toEqual([
      "inception/requirements-analysis/requirements-analysis-questions.md (absent or empty)",
    ]);

    writeFileSync(join(dir, "requirements-analysis-questions.md"), "# Questions\n");
    const settled = wait([
      "--stage", "requirements-analysis", "--for", "artifacts", "--timeout", "1",
    ]);
    expect(settled.json?.status).toBe("settled");
    expect(settled.json?.missing).toEqual([]);
  });

  test("artifacts: unresolved CodeKB and per-unit locations never settle", () => {
    project = activeIntentProject("state-brownfield-feature.md");
    const codekb = wait([
      "--stage", "reverse-engineering", "--for", "artifacts", "--timeout", "1",
    ]);
    expect(codekb.status, codekb.stderr).toBe(0);
    expect(codekb.json?.status).toBe("waiting");
    expect(codekb.json?.missing).toEqual([
      "codekb/*/business-overview.md (location unresolved)",
      "codekb/*/architecture.md (location unresolved)",
      "codekb/*/code-structure.md (location unresolved)",
      "codekb/*/api-documentation.md (location unresolved)",
      "codekb/*/component-inventory.md (location unresolved)",
      "codekb/*/technology-stack.md (location unresolved)",
      "codekb/*/dependencies.md (location unresolved)",
      "codekb/*/code-quality-assessment.md (location unresolved)",
      "codekb/*/reverse-engineering-timestamp.md (location unresolved)",
    ]);

    const perUnit = wait([
      "--stage", "functional-design", "--for", "artifacts", "--timeout", "1",
    ]);
    expect(perUnit.status, perUnit.stderr).toBe(0);
    expect(perUnit.json?.status).toBe("waiting");
    expect(perUnit.json?.missing).toEqual([
      "construction/*/functional-design/entities.md (location unresolved)",
      "construction/*/functional-design/rules.md (location unresolved)",
      "construction/*/functional-design/functional-spec.md (location unresolved)",
      "construction/*/functional-design/traceability.json (location unresolved)",
    ]);
  });

  test("review: settles when the named review file has bytes, resolved against the project", () => {
    project = activeIntentProject();
    const relative = "pending-review.review.md";
    const waiting = wait([
      "--stage", "requirements-analysis", "--for", "review",
      "--review-file", relative, "--timeout", "1",
    ]);
    expect(waiting.status, waiting.stderr).toBe(0);
    expect(waiting.json?.status).toBe("waiting");
    expect(waiting.json?.review_file).toBe(relative);
    expect(waiting.json?.missing).toEqual([`review file ${relative} (absent or empty)`]);

    writeFileSync(join(project, relative), "**Verdict:** READY\n");
    const settled = wait([
      "--stage", "requirements-analysis", "--for", "review",
      "--review-file", relative, "--timeout", "1",
    ]);
    expect(settled.json?.status).toBe("settled");
    expect(settled.json?.missing).toEqual([]);
  });
});

// A review wait holds while the request's reviewer is still out by the record (its
// latest dispatch since the request has no finish after it), so the verdict reads the
// reviewer's finished review and the finish row carries the digest the edited-review
// check compares. On Claude Code the host sends every reviewer to the background, and
// the wait used to settle on the reviewer's first bytes. Each exit settles on bytes, as
// before: the completion hook's own trace of a finish it could not record, the person's
// words since the request, the file unchanged for one quiet window (or a clock that
// disagrees with it), or a record that does not read. Every exit case first shows the
// hold, so none could pass with a hold that never engages.
describe("t341 orchestrate wait: a review holds until its reviewer has finished", () => {
  const LOG_TOOL = join(AIDLC_SRC, "tools", "aidlc-log.ts");
  const STATE_TOOL = join(AIDLC_SRC, "tools", "aidlc-state.ts");
  const SUBAGENT_HOOK = join(AIDLC_SRC, "hooks", "aidlc-log-subagent.ts");
  const DISPATCH_HOOK = join(AIDLC_SRC, "hooks", "aidlc-deliver-stage-rules.ts");
  const WRITE_HOOK = join(AIDLC_SRC, "hooks", "aidlc-write-audit-log.ts");
  const STAGE = "requirements-analysis";
  const REVIEWER = "aidlc-product-lead-agent";
  const CLAUDE_SHELL = { CLAUDE_CODE_SESSION_ID: "5b0c7f1e-9d2a-4c1b-8f3e-2a6d4e8b9c41" };
  const NO_HOST: Record<string, string> = {};
  const OUT = `reviewer ${REVIEWER} (has not finished yet)`;
  const EDITED_LINE = "was edited after the reviewer finished.";
  const LATE_FINDING = "The fix drops the last task when the list has one entry";

  function run(args: string[], env: Record<string, string>, input?: string): { status: number; out: string } {
    const r = spawnSync(process.execPath, args, {
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
      encoding: "utf-8",
      env: { ...process.env, AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD: "1", ...env },
      ...(input === undefined ? {} : { input }),
    });
    return { status: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
  }

  function json(out: string): Record<string, unknown> {
    return JSON.parse(out.slice(out.indexOf("{"))) as Record<string, unknown>;
  }

  function reviewProject(mode: "strict" | "relaxed" = "strict"): string {
    const p = activeIntentProject();
    if (mode === "relaxed") {
      const statePath = seededStateFile(p);
      writeFileSync(statePath, setGuardPolicyLine(readFileSync(statePath, "utf-8"), "relaxed (set by you)"));
    }
    const dir = join(seededRecordDir(p), "inception", STAGE);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "requirements.md"), "# Requirements\n");
    writeFileSync(join(dir, "requirements-analysis-questions.md"), "# Requirements Questions\n");
    return p;
  }

  function logReview(extra: string[], env: Record<string, string> = CLAUDE_SHELL) {
    return run([LOG_TOOL, "review", "--stage", STAGE, "--reviewer", REVIEWER, "--iteration", "1", ...extra, "--project-dir", project], env);
  }

  /** The request; the review file as it names it (project-relative) and its absolute path. */
  function requestReview(env: Record<string, string> = CLAUDE_SHELL): { rel: string; abs: string } {
    const r = logReview([], env);
    expect(r.out, r.out).toContain('"emitted":"REVIEW_REQUESTED"');
    const rel = json(r.out).reviewFile as string;
    return { rel, abs: join(project, rel) };
  }

  /** The reviewer sent as Claude Code 2.1.322 sends it: no flag, then the host backgrounds it (async_launched). */
  function sentByHost(rel: string): void {
    const call = { subagent_type: REVIEWER, description: "review", prompt: `Review and write ${rel}` };
    const env = { CLAUDE_PROJECT_DIR: project };
    expect(run([DISPATCH_HOOK], env, JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Agent", tool_input: call })).status).toBe(0);
    expect(run([DISPATCH_HOOK], env, JSON.stringify({
      hook_event_name: "PostToolUse", tool_name: "Agent", tool_input: call, tool_response: { status: "async_launched" },
    })).status).toBe(0);
  }

  /** The reviewer sent as Codex's adapter forwards spawn_agent, which returns at once. */
  function sentAsSpawnAgent(rel: string): void {
    expect(run([DISPATCH_HOOK], { CLAUDE_PROJECT_DIR: project }, JSON.stringify({
      hook_event_name: "PreToolUse", tool_name: "spawn_agent", tool_input: { agent_type: REVIEWER, message: `Review and write ${rel}` },
    })).status).toBe(0);
  }

  function review(verdict: "READY" | "NOT-READY", note = "Fixture review."): string {
    return (
      `**Verdict:** ${verdict}\n**Reviewer:** ${REVIEWER}\n**Iteration:** 1\n**Verdict Dictated:** no\n\n### Findings\n\n${note}\n\n` +
      "**Prior findings**\n\n| ID | Now | Severity | Note |\n|---|---|---|---|\n\n" +
      "**New findings**\n\n| Severity | Location | Finding | Required action |\n|---|---|---|---|\n" +
      (verdict === "NOT-READY" ? `| High | requirements.md > FR1 | ${LATE_FINDING}. | Add the one-entry case. |\n` : "")
    );
  }

  /** The reviewer's Write as Claude Code reports it, through the shipped PostToolUse audit hook. */
  function reviewerWrites(abs: string, body: string): void {
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body, "utf-8");
    expect(run([WRITE_HOOK], { CLAUDE_PROJECT_DIR: project }, JSON.stringify({
      hook_event_name: "PostToolUse", tool_name: "Write", tool_input: { file_path: abs, content: body },
    })).status).toBe(0);
  }

  /** The reviewer finishes: the shipped SubagentStop hook. */
  function handsBack(fields: Record<string, string> = { agent_type: REVIEWER }): void {
    expect(run([SUBAGENT_HOOK], { CLAUDE_PROJECT_DIR: project }, JSON.stringify({
      hook_event_name: "SubagentStop", agent_id: "a1", ...fields,
    })).status).toBe(0);
  }

  /** What the person types, through the real prompt hook. */
  function personSays(prompt: string): void {
    const env: NodeJS.ProcessEnv = { ...process.env, AIDLC_UNATTENDED: "0", AIDLC_PROJECT_DIR: project, CLAUDE_PROJECT_DIR: project };
    delete env.AIDLC_SKIP_HUMAN_PRESENCE_GUARD;
    delete env.AIDLC_SESSION_OVERRIDE_SOURCE;
    const r = spawnSync(process.execPath, [join(AIDLC_SRC, "tools", "aidlc.ts"), "engine", "hook", "record-human-turn"], {
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
      encoding: "utf-8",
      cwd: project,
      env,
      input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: CLAUDE_SHELL.CLAUDE_CODE_SESSION_ID, prompt }),
    });
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
  }

  function reviewWait(file: string, env: Record<string, string> = CLAUDE_SHELL): Record<string, unknown> {
    const r = run([ORCHESTRATE, "wait", "--stage", STAGE, "--for", "review", "--review-file", file, "--timeout", "1", "--project-dir", project], env);
    expect(r.status, r.out).toBe(0);
    return JSON.parse(r.out.trim().split("\n").pop() ?? "") as Record<string, unknown>;
  }

  /** The hold is on: re-stamped first, since a chain of spawns on a slow box can pass the quiet window by itself. */
  function holds(abs: string, file: string, env: Record<string, string> = CLAUDE_SHELL): void {
    const now = new Date();
    utimesSync(abs, now, now);
    const waited = reviewWait(file, env);
    expect(waited.status).toBe("waiting");
    expect(waited.missing).toEqual([OUT]);
    expect(String(waited.next)).toContain("Not yet: run this same command again.");
  }

  function settles(file: string, env: Record<string, string> = CLAUDE_SHELL): void {
    const waited = reviewWait(file, env);
    expect(waited.status).toBe("settled");
    expect(waited.missing).toEqual([]);
  }

  function blocks(event: string): string[] {
    return readAllAuditShards(project).split("\n---\n").filter((b) => b.includes(`**Event**: ${event}`));
  }

  function healthDir(): string {
    const selection = resolveWorkflowSelection(project);
    const dir = hooksHealthDir(project, selection.intent ?? undefined, selection.space);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  function wholeSecondNow(): string {
    return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  }

  /** A request, the reviewer sent in the background by the host, and its whole READY review on disk. */
  function reviewerOutWithReview(): { rel: string; abs: string } {
    const file = requestReview();
    sentByHost(file.rel);
    reviewerWrites(file.abs, review("READY"));
    return file;
  }

  test("holds while the reviewer is out, settles at its finish, and that finish row carries the review's digest", () => {
    project = reviewProject();
    const file = reviewerOutWithReview();
    holds(file.abs, file.rel);
    handsBack();
    settles(file.rel);
    const finished = blocks("SUBAGENT_COMPLETED").at(-1) ?? "";
    expect(auditBlockField(finished, "Agent Type")).toBe(REVIEWER);
    expect(auditBlockField(finished, REVIEW_FILE_DIGEST_FIELD)).toContain(reviewFileDigest(Buffer.from(review("READY"))));
    const recorded = logReview(["--verdict", "READY"]);
    expect(recorded.status, recorded.out).toBe(0);
    expect(json(recorded.out).change_notices).toBeUndefined();
    expect(blocks("REVIEW_COMPLETED")[0]).not.toContain(REVIEW_EDITED_FIELD);
  });

  for (const mode of ["strict", "relaxed"] as const) {
    test(`${mode}: a review changed after the reviewer finished and before the verdict is flagged again`, () => {
      project = reviewProject(mode);
      const file = reviewerOutWithReview();
      holds(file.abs, file.rel);
      handsBack();
      settles(file.rel);
      writeFileSync(file.abs, review("READY", "Changed after the reviewer finished."), "utf-8");
      const recorded = logReview(["--verdict", "READY"]);
      expect(recorded.status, recorded.out).toBe(0);
      expect((json(recorded.out).change_notices ?? []) as string[]).toContainEqual(expect.stringContaining(EDITED_LINE));
      expect(auditBlockField(blocks("REVIEW_COMPLETED")[0], REVIEW_EDITED_FIELD)).toBe("yes");
      if (mode === "strict") {
        const gate = run([STATE_TOOL, "gate-start", STAGE, "--project-dir", project], { ...CLAUDE_SHELL, AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS: "1" });
        expect(gate.status, gate.out).toBe(0);
        expect(gate.out).toContain(EDITED_LINE);
      }
    });
  }

  for (const [host, env, send] of [
    ["Claude Code, the host backgrounds the reviewer", CLAUDE_SHELL, sentByHost],
    ["Codex shape, spawn_agent still out", NO_HOST, sentAsSpawnAgent],
  ] as const) {
    test(`${host}: a review written again before the reviewer finishes is the one recorded`, () => {
      project = reviewProject();
      const file = requestReview(env);
      send(file.rel);
      reviewerWrites(file.abs, review("READY"));
      holds(file.abs, file.rel, env);
      reviewerWrites(file.abs, review("NOT-READY"));
      handsBack({ agent_type: REVIEWER, last_assistant_message: `NOT-READY: ${LATE_FINDING}.` });
      settles(file.rel, env);
      const stale = logReview(["--verdict", "READY"], env);
      expect(stale.status).not.toBe(0);
      expect(stale.out).toContain("exactly one canonical verdict line matching --verdict");
      const recorded = logReview(["--verdict", "NOT-READY"], env);
      expect(recorded.status, recorded.out).toBe(0);
      const completion = blocks("REVIEW_COMPLETED")[0];
      const record = JSON.parse(
        readFileSync(join(seededRecordDir(project), auditBlockField(completion, "Review Record") as string), "utf-8"),
      ) as ReviewRecord;
      expect(record.verdict).toBe("NOT-READY");
      expect(record.body).toContain(LATE_FINDING);
    });
  }

  test("a review written in two steps does not settle on its first part", () => {
    project = reviewProject();
    const file = requestReview();
    sentByHost(file.rel);
    reviewerWrites(file.abs, `## Review\n\n**Reviewer:** ${REVIEWER}\n\n### Findings\n\nStill reading the requirements.\n`);
    holds(file.abs, file.rel);
    reviewerWrites(file.abs, review("READY"));
    handsBack();
    settles(file.rel);
    const recorded = logReview(["--verdict", "READY"]);
    expect(recorded.status, recorded.out).toBe(0);
  });

  test("the request is found through an absolute review file path too", () => {
    project = reviewProject();
    const file = reviewerOutWithReview();
    holds(file.abs, file.abs);
    handsBack();
    settles(file.abs);
  });

  test("exit: a finish the completion hook recorded with no agent named", () => {
    project = reviewProject();
    const file = reviewerOutWithReview();
    holds(file.abs, file.rel);
    handsBack({});
    expect(auditBlockField(blocks("SUBAGENT_COMPLETED").at(-1) ?? "", "Agent Type")).toBe("unknown");
    settles(file.rel);
  });

  test("exit: the completion hook ran since the request and left no row, or left a beat that does not read", () => {
    project = reviewProject();
    const file = reviewerOutWithReview();
    holds(file.abs, file.rel);
    const beat = join(healthDir(), "log-subagent.last");
    writeFileSync(beat, wholeSecondNow());
    settles(file.rel);
    writeFileSync(beat, "2000-01-01T00:00:00Z");
    holds(file.abs, file.rel);
    writeFileSync(beat, "not a time");
    settles(file.rel);
  });

  test("exit: a failure the completion hook recorded since the request; an older one is no exit", () => {
    project = reviewProject();
    const file = reviewerOutWithReview();
    const drops = join(healthDir(), "log-subagent.drops");
    writeFileSync(drops, "2000-01-01T00:00:00Z\tolder failure\n");
    holds(file.abs, file.rel);
    appendFileSync(drops, `${wholeSecondNow()}\tappend failed\n`);
    settles(file.rel);
  });

  test("exit: the person writes while the reviewer is out (their words come first)", () => {
    project = reviewProject();
    const file = reviewerOutWithReview();
    holds(file.abs, file.rel);
    personSays("hold on, FR2 needs to cover an empty list too");
    settles(file.rel);
  });

  test("exit: the review file unchanged for one quiet window, or a clock that disagrees with it by that much", () => {
    project = reviewProject();
    const file = reviewerOutWithReview();
    holds(file.abs, file.rel);
    const at = (offsetSeconds: number): void => {
      const when = new Date(Date.now() + offsetSeconds * 1000);
      utimesSync(file.abs, when, when);
    };
    // Inside the window with room for the spawn and the one-second wait, which polls again before it answers.
    at(-20);
    expect(reviewWait(file.rel).status).toBe("waiting");
    at(-31);
    settles(file.rel);
    // A future mtime nears now as time passes, so it sits far ahead: a slow spawn must not bring it inside the window.
    at(300);
    settles(file.rel);
  });

  test("exit: an audit shard that does not read", () => {
    project = reviewProject();
    const file = reviewerOutWithReview();
    holds(file.abs, file.rel);
    mkdirSync(join(seededRecordDir(project), "audit", "zz-not-a-shard.md"), { recursive: true });
    settles(file.rel);
  });

  test("no hold where no reviewer was sent since the request: settles on bytes, as before", () => {
    project = reviewProject();
    const file = requestReview();
    reviewerWrites(file.abs, review("READY"));
    settles(file.rel);
  });
});
