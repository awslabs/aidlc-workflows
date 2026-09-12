// covers: subcommand:aidlc-orchestrate:report, subcommand:aidlc-log:review,
// subcommand:aidlc-log:answer, subcommand:aidlc-testing-posture:begin,
// hook:aidlc-review-freeze, hook:aidlc-record-human-turn,
// hook:aidlc-plan-approval-guard, hook:aidlc-write-audit-log
//
// Deterministic, attended production-guard journeys. Only human/model content
// is synthetic: session, summary, artifact, review, and transition evidence is
// produced by its owning CLI/hook. No live model or cross-harness UI is tested.
// Run with --production-guards; the ordinary synthetic-fixture profile skips
// this file instead of silently restoring its disabled guards.

import { afterAll, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import {
  auditBlockField,
  readAuditShardEvents,
  SUMMARY_AUTHORIZATION_FIELD,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  cleanupTestProject,
  REPO_ROOT,
  seededRecordDir,
  setupIntegrationProject,
} from "../harness/fixtures.ts";

const BUN = process.execPath;
const SESSION = "01995000-0995-7000-8000-000000000333";
const STAGE = "requirements-analysis";
const REVIEWER = "aidlc-product-lead-agent";
const ORIGINAL = "Only the owner can read a saved search.";
const CHANGED = "The owner can explicitly share a saved search with their team.";
const PRE_GUARDS = [
  "state-transition-guard",
  "reviewer-scope",
  "review-freeze",
  "plan-approval-guard",
] as const;
const GUARD_SWITCHES = [
  "AIDLC_SKIP_ARTIFACT_GUARD",
  "AIDLC_SKIP_HUMAN_PRESENCE_GUARD",
  "AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD",
  "AIDLC_SKIP_REVISION_BACKSTOP",
  "AIDLC_SKIP_REVIEWER_GATE_GUARD",
  "AIDLC_SKIP_SOURCE_FRESHNESS",
  "AIDLC_DISABLE_REVIEW_FREEZE_HOOK",
  "AIDLC_DISABLE_REVIEWER_SCOPE_HOOK",
  "AIDLC_DISABLE_PLAN_APPROVAL_GUARD",
  "AIDLC_ALLOW_DIRECT_AUDIT_EVENTS",
  "AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS",
  "AIDLC_UNATTENDED",
] as const;
const productionTest =
  process.env.AIDLC_TEST_GUARD_PROFILE === "production" ? test : test.skip;
const projects: string[] = [];
afterAll(() => {
  for (const project of projects) cleanupTestProject(project);
}, 30000);

type Run = { code: number; stdout: string; stderr: string };
type Json = Record<string, unknown>;
type ToolInput = Record<string, unknown>;
type GuardResult = Run & { guard: string };
type Remedy = { op: string; action: string; executableNow: boolean };
type PendingReview = {
  iteration: number;
  draft: string;
  requestId: string;
  requestBlock: string;
};

function spawn(argv: string[], cwd: string, env: NodeJS.ProcessEnv, stdin?: Json): Run {
  const child = Bun.spawnSync(argv, {
    cwd,
    env,
    stdin: stdin === undefined ? "ignore" : Buffer.from(JSON.stringify(stdin)),
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: child.exitCode,
    stdout: child.stdout.toString(),
    stderr: child.stderr.toString(),
  };
}

function succeeded(run: Run, context: string): Run {
  expect(run.code, `${context}\n${run.stdout}\n${run.stderr}`).toBe(0);
  return run;
}

function json(run: Run): Json {
  succeeded(run, "Expected a successful JSON-producing command");
  const line = run.stdout.trim().split("\n").at(-1);
  expect(line, run.stdout).toBeDefined();
  return JSON.parse(line!) as Json;
}

function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function summaryBody(answer = "", requirement = ORIGINAL): string {
  return [
    "# Requirements Questions",
    "",
    "## Q1 — Visibility",
    "",
    requirement,
    "",
    "## Consolidated Summary Confirmation",
    "",
    "- Looks correct",
    "- Request changes",
    "",
    `[Answer]: ${answer}`,
    "",
  ].join("\n");
}

function artifactBody(requirement = ORIGINAL): string {
  return `# Requirements\n\n## Functional Requirements\n\n- FR-1: ${requirement}\n`;
}

class Journey {
  readonly dir: string;
  readonly record: string;
  readonly env: NodeJS.ProcessEnv;
  readonly trace: string;
  readonly questions: string;
  readonly artifact: string;
  readonly transcript: Json[] = [];
  readonly transcriptPath: string;

  constructor(name: string, options: { optionalQuestions?: boolean } = {}) {
    // Do not sanitize guard flags: a misconfigured production runner must fail
    // visibly, including flags inherited from the invoking developer's shell.
    for (const key of GUARD_SWITCHES) {
      expect(process.env[key], `${key} disables the production contract`).not.toBe("1");
    }
    const git = succeeded(
      spawn(
        ["git", "rev-parse", "--path-format=absolute", "--git-common-dir"],
        REPO_ROOT,
        process.env,
      ),
      "Locate the root checkout's private scratch directory",
    );
    const scratch = join(dirname(git.stdout.trim()), "tmp", "guard-recovery-contract");
    mkdirSync(scratch, { recursive: true });
    const runDir = realpathSync(mkdtempSync(join(scratch, `${name}-`)));
    this.trace = join(runDir, "entrypoints.log");
    this.transcriptPath = join(runDir, "host-transcript.jsonl");

    // The shared fixture supplies only an initial workflow snapshot and install.
    // No audit fixture, summary registry, review record, or runtime authority is
    // seeded. Even the initial stage boundary below goes through aidlc-jump.
    const previousTmp = process.env.TMPDIR;
    try {
      process.env.TMPDIR = runDir;
      this.dir = setupIntegrationProject({ withState: "state-brownfield-feature.md" });
    } finally {
      if (previousTmp === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previousTmp;
    }
    projects.push(this.dir);
    this.record = seededRecordDir(this.dir);
    this.questions = join(this.record, "inception", STAGE, `${STAGE}-questions.md`);
    this.artifact = join(this.record, "inception", STAGE, "requirements.md");
    this.env = { ...process.env, TMPDIR: runDir, CLAUDE_PROJECT_DIR: this.dir };
    delete this.env.AWS_AIDLC_DEFAULT_SCOPE;
    console.log(`Production journey entrypoint trace: ${this.trace}`);

    if (options.optionalQuestions) {
      // Installed configuration only, before the session/stage boundary and
      // before any summary evidence. No authority record is edited.
      const graphPath = join(this.dir, ".claude", "tools", "data", "stage-graph.json");
      const graph = JSON.parse(readFileSync(graphPath, "utf-8")) as Array<{
        slug: string;
        summary_confirmation?: string;
        produces?: string[];
        optional_produces?: string[];
      }>;
      const stage = graph.find((entry) => entry.slug === STAGE)!;
      const questions = `${STAGE}-questions`;
      expect(stage.produces).toContain(questions);
      stage.summary_confirmation = "if-present";
      stage.produces = stage.produces!.filter((artifact) => artifact !== questions);
      stage.optional_produces = [...new Set([...(stage.optional_produces ?? []), questions])];
      writeFileSync(graphPath, `${JSON.stringify(graph, null, 2)}\n`);
    }

    // A local fixture repository gives source fingerprinting a real boundary.
    // These commands operate only in the scratch project, never the worktree.
    for (const args of [
      ["init", "-q"],
      ["config", "user.name", "AI-DLC Fixture"],
      ["config", "user.email", "fixture@example.invalid"],
      ["add", "-A"],
      ["-c", "commit.gpgsign=false", "commit", "-qm", "fixture baseline"],
    ]) {
      succeeded(this.run(["git", ...args]), `fixture git ${args[0]}`);
    }
    succeeded(this.hook("session-start", {
      hook_event_name: "SessionStart",
      source: "startup",
      transcript_path: this.transcriptPath,
    }), "Record the host session");
    expect(this.events("SESSION_STARTED")).toHaveLength(1);
    succeeded(this.tool("jump", [
      "execute", "--target", STAGE, "--direction", "redo",
    ]), "Start an actual stage attempt");
    expect(this.events("STAGE_STARTED", STAGE)).toHaveLength(1);
  }

  run(argv: string[], input?: Json): Run {
    const result = spawn(argv, this.dir, this.env, input);
    appendFileSync(this.trace, `${JSON.stringify({ argv, input, ...result })}\n`);
    return result;
  }

  hook(name: string, payload: Json): Run {
    return this.run([BUN, join(this.dir, ".claude", "hooks", `aidlc-${name}.ts`)], {
      cwd: this.dir,
      session_id: SESSION,
      ...payload,
    });
  }

  preflight(toolName: string, toolInput: ToolInput): GuardResult[] {
    // Evaluate every relevant installed PreToolUse guard. A refused operation
    // is never performed and consequently never gets a PostToolUse receipt.
    return PRE_GUARDS.map((guard) => ({
      guard,
      ...this.hook(guard, {
        hook_event_name: "PreToolUse",
        tool_name: toolName,
        tool_input: toolInput,
      }),
    }));
  }

  tool(name: string, args: string[]): Run {
    return this.command([
      BUN, join(this.dir, ".claude", "tools", `aidlc-${name}.ts`),
      ...args, "--project-dir", this.dir,
    ]);
  }

  command(argv: string[]): Run {
    const command = argv.map(quote).join(" ");
    for (const guard of this.preflight("Bash", { command })) {
      succeeded(guard, `${guard.guard} must admit ${command}`);
    }
    const result = this.run(argv);
    this.transcript.push(
      {
        type: "assistant",
        message: { role: "assistant", content: [{ type: "tool_use", name: "Bash", input: { command } }] },
      },
      {
        type: "user",
        message: { role: "user", content: [{ type: "tool_result", content: result.stdout + result.stderr }] },
      },
    );
    return result;
  }

  deleteQuestions(): void {
    expect(existsSync(this.questions)).toBe(true);
    // Execute the exact command all four PreToolUse hooks inspected. Deletion
    // emits no invented artifact/summary receipt; admission must remember the
    // real summary history even when question discovery returns no files.
    succeeded(this.command([
      BUN, "-e",
      `require("node:fs").unlinkSync(${JSON.stringify(this.questions)})`,
    ]), "Delete the optional question input through a guarded shell command");
    expect(existsSync(this.questions)).toBe(false);
  }

  write(path: string, content: string): void {
    const toolName = existsSync(path) ? "Edit" : "Write";
    const toolInput = toolName === "Edit"
      ? { file_path: path, old_string: readFileSync(path, "utf-8"), new_string: content }
      : { file_path: path, content };
    for (const guard of this.preflight(toolName, toolInput)) {
      succeeded(guard, `${guard.guard} must admit ${relative(this.dir, path)}`);
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    succeeded(this.hook("write-audit-log", {
      hook_event_name: "PostToolUse",
      tool_name: toolName,
      tool_input: toolInput,
      tool_response: { success: true },
    }), "Stamp the admitted artifact write");
  }

  deniedWrite(path: string, content: string, guardName: string): void {
    const before = existsSync(path) ? readFileSync(path, "utf-8") : null;
    const writeCount = this.artifactWrites(path).length;
    const guards = this.preflight("Write", { file_path: path, content });
    const refusing = guards.find((result) => result.guard === guardName)!;
    expect(refusing.code, JSON.stringify(guards)).toBe(2);
    expect(refusing.stderr.length).toBeGreaterThan(0);
    for (const guard of guards.filter((result) => result.guard !== guardName)) {
      succeeded(guard, `Unrelated guard ${guard.guard}`);
    }
    expect(existsSync(path) ? readFileSync(path, "utf-8") : null).toBe(before);
    expect(this.artifactWrites(path)).toHaveLength(writeCount);
  }

  events(event: string, stage?: string) {
    return readAuditShardEvents(this.dir).filter((entry) =>
      entry.event === event &&
      (stage === undefined || auditBlockField(entry.block, "Stage") === stage)
    );
  }

  artifactWrites(path: string) {
    const suffix = relative(this.dir, path).replaceAll("\\", "/");
    return readAuditShardEvents(this.dir).filter((entry) =>
      (entry.event === "ARTIFACT_CREATED" || entry.event === "ARTIFACT_UPDATED") &&
      auditBlockField(entry.block, "File")?.endsWith(suffix)
    );
  }

  state(): string {
    return readFileSync(join(this.record, "aidlc-state.md"), "utf-8");
  }

  marker(): Json {
    return JSON.parse(readFileSync(join(this.record, ".aidlc-active-directive.json"), "utf-8"));
  }

  humanPrompt(prompt: string): void {
    succeeded(this.hook("record-human-turn", {
      hook_event_name: "UserPromptSubmit", prompt,
    }), "Record a separate human turn");
    this.transcript.push({ type: "user", message: { role: "user", content: prompt } });
  }

  pick(question: string, labels: string[], choice: string): void {
    const questions = [{ question, options: labels.map((label) => ({ label })) }];
    succeeded(this.hook("record-human-turn", {
      hook_event_name: "PostToolUse",
      tool_name: "AskUserQuestion",
      tool_input: { questions },
      tool_response: { questions, answers: { [question]: choice } },
    }), "Record the native human selection");
    this.transcript.push(
      {
        type: "assistant",
        message: { role: "assistant", content: [{ type: "tool_use", name: "AskUserQuestion", input: { questions } }] },
      },
      {
        type: "user",
        message: { role: "user", content: [{ type: "tool_result", content: JSON.stringify({ answers: { [question]: choice } }) }] },
      },
    );
  }

  summaryArgs(): string[] {
    return ["--stage", STAGE, "--checkpoint", "summary-confirmation", "--questions-file", this.questions];
  }

  presentSummary(requirement = ORIGINAL): void {
    this.write(this.questions, summaryBody("", requirement));
    expect(json(this.tool("log", [
      "decision", ...this.summaryArgs(), "--decision", "Does this all look correct?",
      "--options", "Looks correct,Request changes",
    ])).emitted).toBe("DECISION_RECORDED");
  }

  answerSummary(choice: "Looks correct" | "Request changes", requirement = ORIGINAL): Json {
    this.presentSummary(requirement);
    this.pick("Does this all look correct?", ["Looks correct", "Request changes"], choice);
    this.write(this.questions, summaryBody(choice, requirement));
    const receipt = json(this.tool("log", [
      "answer", ...this.summaryArgs(), "--details", choice,
    ]));
    expect(receipt.emitted).toBe("SUMMARY_CONFIRMATION_RECORDED");
    return receipt;
  }

  confirm(requirement = ORIGINAL): string {
    const receipt = this.answerSummary("Looks correct", requirement);
    expect(receipt.summary_authorization_id).toMatch(/^[a-f0-9]{64}$/);
    return receipt.summary_authorization_id as string;
  }

  confirmWithDifferentAnswerSpacing(): string {
    this.presentSummary();
    this.pick("Does this all look correct?", ["Looks correct", "Request changes"], "Looks correct");
    this.write(this.questions, summaryBody("Looks correct").replace("[Answer]: Looks", "[Answer]:  Looks"));
    const receipt = json(this.tool("log", [
      "answer", ...this.summaryArgs(), "--details", "Looks correct",
    ]));
    return receipt.summary_authorization_id as string;
  }

  reviewArgs(iteration = 1): string[] {
    return ["--stage", STAGE, "--reviewer", REVIEWER, "--iteration", String(iteration)];
  }

  requestReview(iteration = 1): PendingReview {
    const requested = json(this.tool("log", ["review", ...this.reviewArgs(iteration)]));
    expect(requested.emitted).toBe("REVIEW_REQUESTED");
    expect(typeof requested.reviewFile).toBe("string");
    expect(typeof requested.requestId).toBe("string");
    const draft = resolve(this.dir, requested.reviewFile as string);
    expect(relative(this.record, draft)).toMatch(/^\.aidlc-reviews\//);
    const row = this.events("REVIEW_REQUESTED", STAGE).at(-1)!;
    expect(auditBlockField(row.block, "Request Id")).toBe(requested.requestId as string);
    return {
      iteration,
      draft,
      requestId: requested.requestId as string,
      requestBlock: row.block,
    };
  }

  writeReview(pending: PendingReview, verdict: "READY" | "NOT-READY" = "READY"): void {
    this.write(pending.draft, [
      "## Review", "",
      `**Verdict:** ${verdict}`,
      `**Reviewer:** ${REVIEWER}`,
      `**Iteration:** ${pending.iteration}`, "",
      "### Findings", "",
      verdict === "READY"
        ? "No outstanding findings. The visibility requirement is explicit and testable."
        : "The visibility requirement needs a concrete acceptance example before approval.",
      "",
    ].join("\n"));
  }

  reviewVerdict(pending: PendingReview, verdict: "READY" | "NOT-READY" = "READY"): Run {
    return this.tool("log", [
      "review", ...this.reviewArgs(pending.iteration), "--verdict", verdict,
    ]);
  }

  deniedVerdict(pending: PendingReview, reason: string, verdict: "READY" | "NOT-READY" = "READY"): void {
    const state = this.state();
    const draft = readFileSync(pending.draft, "utf-8");
    const requests = this.events("REVIEW_REQUESTED", STAGE).map((entry) => entry.block);
    const completions = this.events("REVIEW_COMPLETED", STAGE).map((entry) => entry.block);
    const result = this.reviewVerdict(pending, verdict);
    expect(result.code, result.stdout + result.stderr).not.toBe(0);
    expect(result.stderr).toContain(reason);
    expect(this.state()).toBe(state);
    expect(readFileSync(pending.draft, "utf-8")).toBe(draft);
    expect(this.events("REVIEW_REQUESTED", STAGE).map((entry) => entry.block)).toEqual(requests);
    expect(requests).toContain(pending.requestBlock);
    expect(this.events("REVIEW_COMPLETED", STAGE).map((entry) => entry.block)).toEqual(completions);
    expect(existsSync(pending.draft.replace(/\.review\.md$/, ".json"))).toBe(false);
  }

  completeReview(pending: PendingReview): { recordPath: string; bytes: string } {
    const completed = json(this.reviewVerdict(pending));
    expect(completed.emitted).toBe("REVIEW_COMPLETED");
    const row = this.events("REVIEW_COMPLETED", STAGE).at(-1)!;
    expect(auditBlockField(row.block, "Request Id")).toBe(pending.requestId);
    const record = auditBlockField(row.block, "Review Record");
    expect(record).toMatch(/^\.aidlc-reviews\//);
    const recordPath = join(this.record, record!);
    return { recordPath, bytes: readFileSync(recordPath, "utf-8") };
  }

  review(iteration = 1): { recordPath: string; bytes: string } {
    const pending = this.requestReview(iteration);
    this.writeReview(pending);
    return this.completeReview(pending);
  }

  report(result: string, extra: string[] = [], stage = STAGE): Json {
    return json(this.tool("orchestrate", ["report", "--stage", stage, "--result", result, ...extra]));
  }

  deniedCompletion(stage = STAGE): Json {
    const before = this.state();
    const count = this.events("STAGE_COMPLETED", stage).length;
    const result = this.report("approved", ["--user-input", "Approve"], stage);
    expect(["ask", "error"], JSON.stringify(result)).toContain(String(result.kind));
    expect(this.state()).toBe(before);
    expect(this.events("STAGE_COMPLETED", stage)).toHaveLength(count);
    return result;
  }

  approve(revised = false): void {
    const opened = this.report(revised ? "revised" : "awaiting-approval");
    expect(opened.kind, JSON.stringify(opened)).toBe("print");
    expect(this.state()).toMatch(/^- \[\?\] requirements-analysis/m);
    // An approval label alone cannot consume a previous summary/recovery turn.
    this.deniedCompletion();
    this.pick("Approve the reviewed requirements?", ["Approve", "Request Changes"], "Approve");
    const approved = this.report("approved", ["--user-input", "Approve"]);
    expect(approved.kind, JSON.stringify(approved)).toBe("done");
    expect(this.state()).toMatch(/^- \[x\] requirements-analysis/m);
    expect(this.events("STAGE_COMPLETED", STAGE)).toHaveLength(1);
  }

  stopAtHumanWait(): void {
    this.transcript.push({
      type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "What should change?" }] },
    });
    writeFileSync(this.transcriptPath, `${this.transcript.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
    for (const active of [false, true]) {
      const stopped = succeeded(this.hook("continue-workflow", {
        hook_event_name: "Stop",
        stop_hook_active: active,
        transcript_path: this.transcriptPath,
      }), "The recovery question is a human wait");
      expect(stopped.stdout.trim()).toBe("");
    }
  }
}

describe("production guards: summary, terminal review, and recovery compose", () => {
  productionTest("a refused verdict announces persisted acceptance so its retry does not lose the notice", () => {
    const p = new Journey("verdict-refusal-keeps-notice");
    succeeded(p.tool("utility", ["change-control", "relaxed"]), "Select relaxed Change Control");
    p.confirm();
    p.write(p.artifact, artifactBody());
    const pending = p.requestReview();
    p.confirmWithDifferentAnswerSpacing();
    // No review draft yet: the acceptance is valid, but the verdict must fail.
    const refused = p.reviewVerdict(pending);
    expect(refused.code).not.toBe(0);
    const failure = JSON.parse(refused.stderr.trim().split("\n").at(-1)!) as Json;
    expect(failure.change_notices).toEqual([expect.stringContaining("Change Control: relaxed")]);
    expect(String(failure.error)).toContain("Change Control: relaxed");
    expect(p.events("CHANGE_ACCEPTED", STAGE)).toHaveLength(1);
    expect(p.events("REVIEW_COMPLETED", STAGE)).toHaveLength(0);
    p.writeReview(pending);
    const completed = json(p.reviewVerdict(pending));
    expect(completed.emitted).toBe("REVIEW_COMPLETED");
    expect(completed.change_notices ?? []).toEqual([]);
    expect(p.events("CHANGE_ACCEPTED", STAGE)).toHaveLength(1);
  }, 180000);

  productionTest("terminal review records relaxed summary acceptance and announces it once", () => {
    const p = new Journey("verdict-relaxed-acceptance");
    succeeded(p.tool("utility", ["change-control", "relaxed"]), "Select relaxed Change Control");
    const original = p.confirm();
    p.write(p.artifact, artifactBody());
    const pending = p.requestReview();
    // The review projection correctly ignores answer presentation, while the
    // summary authorization still records the new questions-file digest.
    expect(p.confirmWithDifferentAnswerSpacing()).not.toBe(original);
    p.writeReview(pending);
    expect(p.events("CHANGE_ACCEPTED")).toHaveLength(0);
    const completed = json(p.reviewVerdict(pending));
    expect(completed.emitted).toBe("REVIEW_COMPLETED");
    expect(completed.change_notices).toEqual([expect.stringContaining("Change Control: relaxed")]);
    const accepted = p.events("CHANGE_ACCEPTED", STAGE);
    expect(accepted).toHaveLength(1);
    expect(auditBlockField(accepted[0].block, "Checkpoint")).toBe("summary-confirmation");
    const opened = p.report("awaiting-approval");
    expect(opened.kind).toBe("print");
    expect(opened.change_notices ?? []).toEqual([]);
    expect(p.events("CHANGE_ACCEPTED", STAGE)).toHaveLength(1);
  }, 180000);

  productionTest("terminal review retains its pending request when relaxed acceptance cannot be recorded", () => {
    const p = new Journey("verdict-acceptance-ledger-failure");
    succeeded(p.tool("utility", ["change-control", "relaxed"]), "Select relaxed Change Control");
    p.confirm();
    p.write(p.artifact, artifactBody());
    const pending = p.requestReview();
    p.confirmWithDifferentAnswerSpacing();
    p.writeReview(pending);
    p.env.AIDLC_TEST_CHANGE_CONTROL_LEDGER_FAULT = "1";
    try {
      p.deniedVerdict(pending, "could not be recorded");
    } finally {
      delete p.env.AIDLC_TEST_CHANGE_CONTROL_LEDGER_FAULT;
    }
    expect(p.events("CHANGE_ACCEPTED")).toHaveLength(0);
    const completed = json(p.reviewVerdict(pending));
    expect(completed.emitted).toBe("REVIEW_COMPLETED");
    expect(completed.change_notices).toEqual([expect.stringContaining("Change Control: relaxed")]);
    expect(p.events("CHANGE_ACCEPTED", STAGE)).toHaveLength(1);
  }, 180000);

  productionTest("terminal review reports invalid Change Control memory instead of a summary mismatch", () => {
    const p = new Journey("verdict-invalid-change-control");
    p.confirm();
    p.write(p.artifact, artifactBody());
    const pending = p.requestReview();
    p.confirmWithDifferentAnswerSpacing();
    p.writeReview(pending);
    const memory = join(p.dir, "aidlc", "spaces", "default", "memory", "project.md");
    const body = readFileSync(memory, "utf8");
    expect(body).toContain("## Change Control");
    p.write(memory, body.replace("## Change Control", "## Change Control\n\nMode: sometimes"));
    p.deniedVerdict(pending, 'Invalid Change Control Mode');
    expect(p.events("CHANGE_ACCEPTED")).toHaveLength(0);
  }, 180000);

  productionTest("unchanged summary reconfirmation preserves reviewed output and can complete", () => {
    const p = new Journey("unchanged-summary");

    // A filled answer line is not a human-backed confirmation.
    p.presentSummary();
    p.write(p.questions, summaryBody("Looks correct"));
    const withoutHuman = p.tool("log", ["answer", ...p.summaryArgs(), "--details", "Looks correct"]);
    expect(withoutHuman.code).not.toBe(0);
    expect(withoutHuman.stderr).toMatch(/human.*(?:reply|response|turn)/i);
    expect(p.events("SUMMARY_CONFIRMATION_RECORDED", STAGE)).toHaveLength(0);
    p.deniedCompletion();

    const first = p.confirm();
    // A real summary receipt still does not substitute for generated output.
    const missingOutput = p.tool("log", ["review", ...p.reviewArgs()]);
    expect(missingOutput.code).not.toBe(0);
    expect(missingOutput.stderr).toContain("required output document");
    expect(p.events("REVIEW_REQUESTED", STAGE)).toHaveLength(0);
    p.deniedCompletion();

    p.write(p.artifact, artifactBody());
    const writes = p.artifactWrites(p.artifact);
    expect(writes).toHaveLength(1);
    expect(auditBlockField(writes[0].block, SUMMARY_AUTHORIZATION_FIELD)).toBe(first);
    const reviewed = p.review();
    p.deniedWrite(p.artifact, artifactBody(CHANGED), "review-freeze");

    // Re-presenting the same content after review is a normal recovery action.
    // Every question write passes the freeze too; no direct fs repair is used.
    const second = p.confirm();
    expect(second).toBe(first);
    expect(p.artifactWrites(p.artifact)).toHaveLength(1);
    expect(readFileSync(p.artifact, "utf-8")).toBe(artifactBody());
    expect(readFileSync(reviewed.recordPath, "utf-8")).toBe(reviewed.bytes);
    expect(p.events("REVIEW_COMPLETED", STAGE)).toHaveLength(1);
    p.deniedWrite(p.artifact, artifactBody(CHANGED), "review-freeze");
    p.approve();
  }, 240000);

  productionTest("changed summary keeps completion closed until exact Request Changes feedback, regenerated output, and fresh review", () => {
    const p = new Journey("changed-summary");
    const originalId = p.confirm();
    p.write(p.artifact, artifactBody());
    const oldReview = p.review();
    p.deniedWrite(p.artifact, artifactBody(CHANGED), "review-freeze");

    // A human changes the confirmed input while the output is still reviewed.
    // The new receipt must not retrospectively authorize the existing output.
    const changedId = p.confirm(CHANGED);
    expect(changedId).not.toBe(originalId);
    expect(p.artifactWrites(p.artifact)).toHaveLength(1);
    // Material question changes invalidate the prior review. Inputs remain
    // editable; completion still cannot consume its old output or receipt.
    expect(readFileSync(p.artifact, "utf-8")).toBe(artifactBody());
    expect(readFileSync(oldReview.recordPath, "utf-8")).toBe(oldReview.bytes);
    const ask = p.deniedCompletion();
    expect(ask).toMatchObject({ kind: "ask", ask_type: "guard-recovery", stage: STAGE });
    expect(ask.reason_codes).toContain("SUMMARY_ARTIFACT_UNAUTHORIZED");
    const remedies = ask.remedies as Remedy[];
    const change = remedies.find((remedy) => remedy.op === "request-changes");
    expect(change).toBeDefined();
    expect(change?.executableNow).toBe(true);
    p.pick(ask.question as string, remedies.map((remedy) => remedy.action), change!.action);
    expect(p.marker().guard_recovery_response).toMatchObject({
      status: "awaiting-feedback", selected_op: "request-changes",
    });
    p.stopAtHumanWait();

    const beforeRejection = p.state();
    const premature = p.report("rejected", [
      "--user-input", "Request Changes", "--reason", "The assistant selected team sharing.",
    ]);
    expect(premature.kind).toBe("error");
    expect(String(premature.message)).toContain("not revision feedback");
    expect(p.state()).toBe(beforeRejection);
    expect(p.events("GATE_REJECTED", STAGE)).toHaveLength(0);

    const feedback = "Keep saved searches private by default; add an explicit team sharing action.";
    p.humanPrompt(feedback);
    expect(p.marker().guard_recovery_response).toMatchObject({
      status: "ready", selected_op: "request-changes",
    });
    const mismatch = p.report("rejected", [
      "--user-input", "Request Changes", "--reason", "Make all saved searches visible to the team.",
    ]);
    expect(mismatch.kind).toBe("error");
    expect(String(mismatch.message)).toContain("does not exactly match");
    expect(p.state()).toBe(beforeRejection);
    expect(p.events("GATE_REJECTED", STAGE)).toHaveLength(0);

    const rejected = p.report("rejected", ["--user-input", "Request Changes", "--reason", feedback]);
    expect(rejected.kind, JSON.stringify(rejected)).toBe("print");
    expect(p.state()).toMatch(/^- \[R\] requirements-analysis/m);
    expect(p.events("GATE_REJECTED", STAGE)).toHaveLength(1);
    expect(p.events("GATE_REJECTED", STAGE)[0].block).toContain(feedback);
    p.deniedCompletion();

    const revisedId = p.confirm(CHANGED);
    // Rejection resets review authority, not the confirmed answers. Reaffirming
    // those same answers preserves their authorization identity.
    expect(revisedId).toBe(changedId);
    // Confirmation alone cannot authorize output from the earlier answers.
    p.deniedCompletion();
    p.write(p.artifact, artifactBody(CHANGED));
    const writes = p.artifactWrites(p.artifact);
    expect(writes).toHaveLength(2);
    expect(auditBlockField(writes[1].block, SUMMARY_AUTHORIZATION_FIELD)).toBe(revisedId);
    // Regeneration alone cannot reuse the earlier attempt's terminal review.
    p.deniedCompletion();
    const freshReview = p.review();
    expect(freshReview.recordPath).not.toBe(oldReview.recordPath);
    expect(readFileSync(oldReview.recordPath, "utf-8")).toBe(oldReview.bytes);
    expect(p.events("REVIEW_COMPLETED", STAGE)).toHaveLength(2);
    p.deniedWrite(p.artifact, artifactBody(), "review-freeze");
    p.approve(true);
  }, 300000);

  productionTest("a pending review refuses changed confirmed input and recovers on the original confirmation", () => {
    const p = new Journey("pending-changed-summary");
    const originalId = p.confirm();
    p.write(p.artifact, artifactBody());
    const pending = p.requestReview();
    p.writeReview(pending);

    const changedId = p.confirm(CHANGED);
    expect(changedId).not.toBe(originalId);
    p.deniedVerdict(pending, "SUMMARY_ARTIFACT_UNAUTHORIZED");
    expect(p.deniedCompletion().reason_codes).toContain("SUMMARY_ARTIFACT_UNAUTHORIZED");
    expect(p.events("REVIEW_COMPLETED", STAGE)).toHaveLength(0);

    // Restore the actual confirmed inputs through the same human checkpoint,
    // without replacing the request, re-saving output, or editing authority.
    expect(p.confirm()).toBe(originalId);
    expect(p.artifactWrites(p.artifact)).toHaveLength(1);
    expect(readFileSync(p.artifact, "utf-8")).toBe(artifactBody());
    p.completeReview(pending);
    expect(p.events("REVIEW_REQUESTED", STAGE)).toHaveLength(1);
    expect(p.events("REVIEW_COMPLETED", STAGE)).toHaveLength(1);
    p.approve();
  }, 240000);

  productionTest("withdrawing a pending review's summary denies both terminal verdicts until a real reconfirmation", () => {
    const p = new Journey("pending-withdrawn-summary");
    const originalId = p.confirm();
    p.write(p.artifact, artifactBody());
    const pending = p.requestReview();

    const withdrawal = p.answerSummary("Request changes");
    expect(withdrawal.summary_authorization_id).toBeUndefined();
    expect(auditBlockField(
      p.events("SUMMARY_CONFIRMATION_RECORDED", STAGE).at(-1)!.block, "Details",
    )).toBe("Request changes");
    for (const verdict of ["READY", "NOT-READY"] as const) {
      p.writeReview(pending, verdict);
      p.deniedVerdict(pending, "SUMMARY_ANSWER_INVALID", verdict);
    }
    p.deniedCompletion();

    // An answer-looking file cannot undo a real negative receipt, even though
    // canonical answer-only changes leave the pending snapshot's identity.
    p.write(p.questions, summaryBody("Looks correct"));
    p.writeReview(pending);
    p.deniedVerdict(pending, "SUMMARY_RECEIPT_MISSING");
    expect(p.events("REVIEW_COMPLETED", STAGE)).toHaveLength(0);

    expect(p.confirm()).toBe(originalId);
    expect(p.artifactWrites(p.artifact)).toHaveLength(1);
    p.completeReview(pending);
    expect(p.events("REVIEW_REQUESTED", STAGE)).toHaveLength(1);
    expect(p.events("REVIEW_COMPLETED", STAGE)).toHaveLength(1);
    p.approve();
  }, 240000);

  productionTest("deleting optional questions cannot remove a summary obligation already established this attempt", () => {
    const p = new Journey("optional-question-deletion", { optionalQuestions: true });
    const originalId = p.confirm();
    p.write(p.artifact, artifactBody());
    const originalReview = p.review();
    const changedId = p.confirm(CHANGED);
    expect(changedId).not.toBe(originalId);
    expect(p.deniedCompletion().reason_codes).toContain("SUMMARY_ARTIFACT_UNAUTHORIZED");

    const confirmations = p.events("SUMMARY_CONFIRMATION_RECORDED", STAGE).map((entry) => entry.block);
    p.deleteQuestions();
    expect(p.events("SUMMARY_CONFIRMATION_RECORDED", STAGE).map((entry) => entry.block)).toEqual(confirmations);
    expect(p.deniedCompletion().reason_codes).toContain("SUMMARY_QUESTIONS_MISSING");
    // A stale prior review alone also blocks completion. Check request
    // admission independently: no recovery review may certify the no-file
    // state and thereby erase the conditional summary obligation.
    const requests = p.events("REVIEW_REQUESTED", STAGE).map((entry) => entry.block);
    const retry = p.tool("log", ["review", ...p.reviewArgs(2)]);
    expect(retry.code, retry.stdout + retry.stderr).not.toBe(0);
    expect(retry.stderr).toContain("SUMMARY_QUESTIONS_MISSING");
    expect(p.events("REVIEW_REQUESTED", STAGE).map((entry) => entry.block)).toEqual(requests);
    expect(p.events("REVIEW_COMPLETED", STAGE)).toHaveLength(1);
    expect(readFileSync(originalReview.recordPath, "utf-8")).toBe(originalReview.bytes);

    // Restoring and confirming the current input is usable, but still does not
    // authorize the earlier output. Regeneration plus the one recovery review
    // must precede approval.
    expect(p.confirm(CHANGED)).toBe(changedId);
    expect(p.deniedCompletion().reason_codes).toContain("SUMMARY_ARTIFACT_UNAUTHORIZED");
    p.write(p.artifact, artifactBody(CHANGED));
    p.deniedCompletion();
    p.review(2);
    expect(p.events("REVIEW_REQUESTED", STAGE)).toHaveLength(2);
    expect(p.events("REVIEW_COMPLETED", STAGE)).toHaveLength(2);
    p.approve();
  }, 300000);

  productionTest("generation needs a real session-bound plan approval, and completion still needs its own evidence", () => {
    const p = new Journey("generation-evidence");
    succeeded(p.tool("jump", [
      "execute", "--target", "code-generation", "--direction", "forward",
    ]), "Enter Code Generation through the transition owner");
    // Consume rule delivery exactly as a conductor does; no directive marker
    // or plan authority is manufactured by the test.
    let directive = json(p.tool("orchestrate", ["next"]));
    for (let steps = 0; steps < 40; steps++) {
      if (directive.kind === "load-steering") {
        expect(typeof directive.continue_token).toBe("string");
        directive = json(p.tool("orchestrate", ["continue", directive.continue_token as string]));
      } else if (directive.kind === "run-stage" && directive.gate === "unresolved") {
        succeeded(p.tool("orchestrate", ["report", "--skeleton-stance", "off"]), "Resolve walking skeleton stance");
        directive = json(p.tool("orchestrate", ["next"]));
      } else break;
    }
    expect(directive, JSON.stringify(directive)).toMatchObject({
      kind: "run-stage", stage: "code-generation",
    });
    expect(directive.unit).toBeUndefined(); // no authoritative Unit DAG in this fixture
    const target = ["--stage-level"];
    const source = join(p.dir, "src", "saved-search.ts");
    p.deniedWrite(source, "export const shared = true;\n", "plan-approval-guard");
    expect(p.tool("testing-posture", ["begin", ...target]).code).not.toBe(0);
    p.deniedCompletion("code-generation");
    // A completion refusal publishes a recovery ask. Follow the guard's
    // prescribed fresh-next route before resuming canonical planning.
    directive = json(p.tool("orchestrate", ["next"]));
    for (let steps = 0; directive.kind === "load-steering" && steps < 40; steps++) {
      directive = json(p.tool("orchestrate", ["continue", directive.continue_token as string]));
    }
    expect(directive).toMatchObject({ kind: "run-stage", stage: "code-generation" });

    const dir = join(p.record, "construction", "code-generation");
    const contract = succeeded(p.tool("testing-posture", ["render"]), "Render the actual Testing Contract");
    p.write(join(dir, "code-generation-plan.md"), [
      "# Code Generation Plan", "", contract.stdout.trim(), "",
      "## Steps", "", "- [ ] Step 1: Implement private saved search visibility.",
      "- [ ] Step 2: Verify the visibility policy.", "",
    ].join("\n"));
    p.write(join(dir, "unit-test-instructions.md"), "# Unit Test Instructions\n\nRun `bun test`.\n");
    const fingerprint = succeeded(
      p.tool("testing-posture", ["fingerprint", ...target]),
      "Bind plan and source through the fingerprint owner",
    );
    const questions = join(dir, "code-generation-questions.md");
    const questionBody = [
      "## Plan Approval", fingerprint.stdout.trim(),
      "A. Approve Plan", "B. Request Changes", "[Answer]:", "",
    ].join("\n");
    p.write(questions, questionBody);
    const args = [
      "--stage", "code-generation", "--checkpoint", "plan-approval",
      "--questions-file", questions, "--session", SESSION, ...target,
    ];
    const decision = json(p.tool("log", [
      "decision", ...args, "--decision", "Approve this exact Code Generation plan?",
      "--options", "Approve Plan,Request Changes",
    ]));
    expect(typeof decision.challengeId).toBe("string");

    // An answer-looking file without the host's response still grants nothing.
    p.write(questions, questionBody.replace("[Answer]:", "[Answer]: Approve Plan"));
    const premature = p.tool("log", ["answer", ...args, "--details", "Approve Plan"]);
    expect(premature.code).not.toBe(0);
    expect(p.events("PLAN_APPROVAL_RECORDED", "code-generation")).toHaveLength(0);
    p.deniedWrite(source, "export const shared = true;\n", "plan-approval-guard");
    expect(p.tool("testing-posture", ["begin", ...target]).code).not.toBe(0);

    p.humanPrompt("Approve Plan");
    const answered = json(p.tool("log", ["answer", ...args, "--details", "Approve Plan"]));
    expect(answered.emitted).toBe("PLAN_APPROVAL_RECORDED");
    expect(p.events("PLAN_APPROVAL_RECORDED", "code-generation")).toHaveLength(1);
    succeeded(p.tool("testing-posture", ["begin", ...target]), "Begin with the actual plan receipt");
    p.write(source, "export const canRead = (owner: string, viewer: string) => owner === viewer;\n");
    expect(readFileSync(source, "utf-8")).toContain("owner === viewer");
    // Plan approval authorizes work, not stage completion or review synthesis.
    p.deniedCompletion("code-generation");
    expect(p.events("REVIEW_COMPLETED", "code-generation")).toHaveLength(0);
    expect(p.events("STAGE_COMPLETED", "code-generation")).toHaveLength(0);
  }, 240000);
});
