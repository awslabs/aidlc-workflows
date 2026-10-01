// covers: function:parseGuessedQuestions, function:guessFileProblems,
// function:readGuessReviewChoice, function:acceptGuessesInContent,
// function:answerIsGuess, function:guessAcceptanceKey,
// function:acceptedGuessKeys, function:checkGuessAcceptance,
// subcommand:aidlc-log:decision, subcommand:aidlc-log:answer,
// subcommand:aidlc-state:gate-start
//
// Guess First (opt-in ceremony `guess_first`). The agent writes its best answer
// to each question as a `[Guess]:` with a `[Basis]:` and leaves `[Answer]:`
// blank; the person answers ONE guess review. These cases pin the trust rule:
// a guess becomes an answer only through the person's own `Accept all`, which
// the engine records as an explicit acceptance (never as the person's answer),
// and the gate refuses a guess nobody accepted.

import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import {
  CEREMONY_ENV,
  acceptGuessesInContent,
  auditBlockField,
  checkGuessAcceptance,
  GUESS_ACCEPTED_SOURCE,
  guessFileProblems,
  hasPendingDecision,
  loadStageGraphAll,
  parseGuessedQuestions,
  readAuditShardEvents,
  readGuessReviewChoice,
  resolveCeremony,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createTestProject,
  seedAidlcMemory,
  seededRecordDir,
  seededStateFile,
  seedStateFile,
  withEnvAndFreshCaches,
} from "../harness/fixtures.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const BUN = process.execPath;
const LOG = join(AIDLC_SRC, "tools", "aidlc-log.ts");
const STATE = join(AIDLC_SRC, "tools", "aidlc-state.ts");
const STAGE = "requirements-analysis";
const OPTIONS = "Accept all,Review flagged,Edit in file,Discuss";
const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) cleanupTestProject(tempDirs.pop()!);
});

const GUESSED = [
  "# Requirements Questions",
  "",
  "## Q1: How do staff sign in?",
  "",
  "A. Corporate SSO",
  "B. Email and password",
  "X. Other (please specify)",
  "",
  "[Guess]: A",
  '[Basis]: intent.md says "staff sign in with the corporate SSO" (input doc)',
  "[Confidence]: high",
  "",
  "[Answer]:",
  "",
  "## Q2: How long are orders kept?",
  "",
  "A. 30 days",
  "B. 1 year",
  "X. Other (please specify)",
  "",
  "[Guess]: B",
  "[Basis]: assumption",
  "[Confidence]: low",
  "",
  "[Answer]:",
  "",
  "## Q3: Which region hosts it?",
  "",
  "A. us-east-1",
  "B. eu-west-1",
  "X. Other (please specify)",
  "",
  "[Guess]: A",
  "[Basis]: infra/main.tf sets region us-east-1 (code)",
  "[Confidence]: high",
  "",
  "[Answer]:",
  "",
].join("\n");

function project(options: { guessFirst?: "on" | "off" | null; content?: string } = {}) {
  const proj = createTestProject();
  tempDirs.push(proj);
  seedAidlcMemory(proj);
  seedStateFile(proj, "state-mid-inception.md");
  const guessFirst = options.guessFirst === undefined ? "on" : options.guessFirst;
  if (guessFirst !== null) {
    const statePath = seededStateFile(proj);
    const state = readFileSync(statePath, "utf-8").replace(
      /^(- \*\*Change Control\*\*:[^\n]*)$/m,
      `$1\n- **Guess First**: ${guessFirst} (set by you)`,
    );
    writeFileSync(statePath, state);
  }
  const dir = join(seededRecordDir(proj), "inception", STAGE);
  mkdirSync(dir, { recursive: true });
  const questions = join(dir, `${STAGE}-questions.md`);
  writeFileSync(questions, options.content ?? GUESSED);
  return { proj, questions, rel: relative(proj, questions).replaceAll("\\", "/") };
}

// The runner's fixture profile switches presence and summary guards off; these
// cases are about the guards, so they stay on.
function run(tool: string, args: string[], proj: string, extraEnv: Record<string, string> = {}) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.AIDLC_SKIP_HUMAN_PRESENCE_GUARD;
  delete env.AIDLC_UNATTENDED;
  delete env.AIDLC_DISABLE_GUESS_FIRST;
  Object.assign(env, extraEnv);
  const result = Bun.spawnSync({
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    cmd: [BUN, tool, ...args, "--project-dir", proj],
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = result.stdout.toString();
  const stderr = result.stderr.toString();
  // Refusals print one JSON object; read its message so quotes compare as the model sees them.
  const line = stderr.split("\n").find((entry) => entry.trim().startsWith("{"));
  let message = "";
  try {
    message = line ? String((JSON.parse(line) as { error?: unknown }).error ?? "") : "";
  } catch {
    message = "";
  }
  return { status: result.exitCode, stdout, stderr, text: `${stdout}\n${stderr}\n${message}` };
}

const log = (args: string[], proj: string, env: Record<string, string> = {}) => run(LOG, args, proj, env);

function decide(proj: string, questions: string, env: Record<string, string> = {}) {
  return log(
    ["decision", "--stage", STAGE, "--checkpoint", "guess-review", "--questions-file", questions,
      "--decision", "How would you like to review my guesses?", "--options", OPTIONS],
    proj,
    env,
  );
}

function reply(proj: string, questions: string, details: string) {
  return log(
    ["answer", "--stage", STAGE, "--checkpoint", "guess-review", "--questions-file", questions, "--details", details],
    proj,
  );
}

const humanTurn = (proj: string) => appendAuditEntry("HUMAN_TURN", {}, proj);
const rows = (proj: string, event: string) => readAuditShardEvents(proj).filter((entry) => entry.event === event);
const guessRows = (proj: string, event: string) =>
  rows(proj, event).filter((entry) => auditBlockField(entry.block, "Checkpoint") === "Guess Review");
const stageNode = () => loadStageGraphAll().find((stage) => stage.slug === STAGE)!;

describe("t-guess-first: the switch", () => {
  test("default off everywhere; scope default, intent line, and kill switch take precedence in that order", () => {
    const proj = createTestProject();
    tempDirs.push(proj);
    const scopes = join(proj, "scopes");
    mkdirSync(scopes);
    writeFileSync(join(scopes, "aidlc-eager.md"), ["---", "name: eager", "depth: Standard", "guess_first: on", "---", ""].join("\n"));
    writeFileSync(join(scopes, "aidlc-plain.md"), ["---", "name: plain", "depth: Standard", "---", ""].join("\n"));
    withEnvAndFreshCaches({
      AIDLC_HARNESS_DIR: ".claude",
      AIDLC_SCOPE_MAPPING: undefined,
      AIDLC_SCOPE_GRID: join(AIDLC_SRC, "tools", "data", "scope-grid.json"),
      AIDLC_STAGE_GRAPH: join(AIDLC_SRC, "tools", "data", "stage-graph.json"),
      AIDLC_SCOPES_DIR: scopes,
      AIDLC_DISABLE_GUESS_FIRST: "0",
    }, () => {
      // No scope line and no intent line: off, the one ceremony whose default is off.
      expect(resolveCeremony("guess_first", "plain", "")).toMatchObject({ value: "off", source: "default" });
      expect(resolveCeremony("guess_first", null, "")).toMatchObject({ value: "off", source: "default" });
      // The scope can default it on.
      expect(resolveCeremony("guess_first", "eager", "")).toMatchObject({ value: "on", source: "scope eager" });
      // The intent line (the person's /aidlc --guess-first) overrides the scope either way.
      expect(resolveCeremony("guess_first", "eager", "- **Guess First**: off (set by you)\n"))
        .toMatchObject({ value: "off", source: "you", scopeDefault: "on" });
      expect(resolveCeremony("guess_first", "plain", "- **Guess First**: on (set by you)\n"))
        .toMatchObject({ value: "on", source: "you" });
      // The machine kill switch beats both.
      process.env[CEREMONY_ENV.guess_first] = "1";
      expect(CEREMONY_ENV.guess_first).toBe("AIDLC_DISABLE_GUESS_FIRST");
      expect(resolveCeremony("guess_first", "eager", "- **Guess First**: on (set by you)\n"))
        .toMatchObject({ value: "off", source: "env AIDLC_DISABLE_GUESS_FIRST" });
    });
  });

  test("every stock scope ships it off", () => {
    for (const scope of ["bugfix", "classic", "enterprise", "express", "feature", "infra", "mvp", "poc", "refactor", "security-patch", "workshop"]) {
      expect(`${scope}: ${resolveCeremony("guess_first", scope, "").value}`).toBe(`${scope}: off`);
    }
  });

  test("with it off the guess review is refused, so the agent never guesses unasked", () => {
    const { proj, questions } = project({ guessFirst: null });
    const result = decide(proj, questions);
    expect(result.status).toBe(1);
    expect(result.text).toContain("Guess First is off");
    expect(rows(proj, "DECISION_RECORDED")).toHaveLength(0);
  });

  test("the kill switch refuses the guess review even when the person turned it on", () => {
    const { proj, questions } = project();
    const result = decide(proj, questions, { AIDLC_DISABLE_GUESS_FIRST: "1" });
    expect(result.status).toBe(1);
    expect(result.text).toContain("env AIDLC_DISABLE_GUESS_FIRST");
  });
});

describe("t-guess-first: guesses are pre-filled with a basis", () => {
  test("each guess carries its basis and confidence, and the answer stays blank", () => {
    const parsed = parseGuessedQuestions(GUESSED);
    expect(parsed.map((q) => [q.id, q.guess, q.confidence, q.answer])).toEqual([
      ["Q1: How do staff sign in?", "A", "high", ""],
      ["Q2: How long are orders kept?", "B", "low", ""],
      ["Q3: Which region hosts it?", "A", "high", ""],
    ]);
    expect(parsed.every((q) => q.basis.length > 0)).toBe(true);
    expect(guessFileProblems(GUESSED)).toEqual([]);
  });

  test("a guess with no basis or confidence cannot be presented", () => {
    const bare = GUESSED.replace('[Basis]: intent.md says "staff sign in with the corporate SSO" (input doc)\n', "")
      .replace("[Confidence]: low\n", "");
    expect(guessFileProblems(bare)).toEqual([
      '"Q1: How do staff sign in?" has no `[Basis]:` naming the evidence or "assumption"',
      '"Q2: How long are orders kept?" needs `[Confidence]: high` or `[Confidence]: low`',
    ]);
    const { proj, questions } = project({ content: bare });
    const result = decide(proj, questions);
    expect(result.status).toBe(1);
    expect(result.text).toContain("Cannot present the guess review");
  });

  test("the review records one question with the engine's four choices and names the flagged guesses", () => {
    const { proj, questions, rel } = project();
    const result = decide(proj, questions);
    expect(result.status, result.text).toBe(0);
    const decision = guessRows(proj, "DECISION_RECORDED");
    expect(decision).toHaveLength(1);
    expect(auditBlockField(decision[0].block, "Options")).toBe(OPTIONS);
    expect(auditBlockField(decision[0].block, "Questions File")).toBe(rel);
    expect(auditBlockField(decision[0].block, "Guesses")).toBe("3");
    expect(auditBlockField(decision[0].block, "Flagged")).toBe("Q2: How long are orders kept?");
    // The file is untouched: the blank tags still say the person has not decided.
    expect(readFileSync(questions, "utf-8")).toBe(GUESSED);
    expect(
      log(["decision", "--stage", STAGE, "--checkpoint", "guess-review", "--questions-file", questions,
        "--decision", "Review?", "--options", "Accept all,Skip review"], proj).text,
    ).toContain('offers exactly "Accept all,Review flagged,Edit in file,Discuss"');
  });

  test("the reply names one of the four choices or records nothing", () => {
    expect(readGuessReviewChoice("Accept all")).toBe("Accept all");
    expect(readGuessReviewChoice("1")).toBe("Accept all");
    expect(readGuessReviewChoice("2. Review flagged")).toBe("Review flagged");
    expect(readGuessReviewChoice("edit in file")).toBe("Edit in file");
    expect(readGuessReviewChoice("Discuss.")).toBe("Discuss");
    expect(readGuessReviewChoice("sure, whatever you think")).toBeNull();
    expect(readGuessReviewChoice("yes")).toBeNull();
  });
});

describe("t-guess-first: acceptance is the person's, and recorded as acceptance", () => {
  test("accept-all records an explicit acceptance, not agent-authored answers; an edit stays the person's answer", () => {
    const { proj, questions, rel } = project();
    expect(decide(proj, questions).status).toBe(0);
    // The person changed Q2 in the file before accepting the rest.
    writeFileSync(questions, readFileSync(questions, "utf-8").replace(
      "[Confidence]: low\n\n[Answer]:",
      "[Confidence]: low\n\n[Answer]: A",
    ));
    humanTurn(proj);
    const result = reply(proj, questions, "Accept all");
    expect(result.status, result.text).toBe(0);

    const receipts = guessRows(proj, "QUESTION_ANSWERED");
    expect(receipts).toHaveLength(1);
    const receipt = receipts[0].block;
    expect(auditBlockField(receipt, "Details")).toBe("Accept all");
    expect(auditBlockField(receipt, "User Input")).toBe("Accept all");
    expect(auditBlockField(receipt, "Answer Source")).toBe(GUESS_ACCEPTED_SOURCE);
    expect(auditBlockField(receipt, "Accepted Guesses")).toBe("Q1: How do staff sign in?; Q3: Which region hosts it?");
    expect(auditBlockField(receipt, "Human Answers")).toBe("Q2: How long are orders kept?");
    expect(auditBlockField(receipt, "Low-Confidence Accepted")).toBe("none");
    expect(auditBlockField(receipt, "Accepted Guess Keys")?.split(",")).toHaveLength(2);

    // The engine copied the accepted guesses and marked them; Q2 is untouched.
    const after = parseGuessedQuestions(readFileSync(questions, "utf-8"));
    expect(after.map((q) => [q.answer, q.acceptedMarker])).toEqual([["A", true], ["A", false], ["A", true]]);
    expect(readFileSync(questions, "utf-8")).toContain(`[Answer]: A\n[Answer Source]: ${GUESS_ACCEPTED_SOURCE}`);
    expect(checkGuessAcceptance(proj, stageNode(), {})).toEqual({ ok: true });
    expect(rel.endsWith(`${STAGE}-questions.md`)).toBe(true);
  });

  test("accepting a low-confidence guess is named on the receipt", () => {
    const { proj, questions } = project();
    expect(decide(proj, questions).status).toBe(0);
    humanTurn(proj);
    expect(reply(proj, questions, "1").status).toBe(0);
    const receipt = guessRows(proj, "QUESTION_ANSWERED")[0].block;
    expect(auditBlockField(receipt, "Low-Confidence Accepted")).toBe("Q2: How long are orders kept?");
    expect(auditBlockField(receipt, "Human Answers")).toBe("none");
  });

  test("Review flagged, Edit in file, and Discuss record the choice and write nothing", () => {
    for (const choice of ["Review flagged", "Edit in file", "Discuss"]) {
      const { proj, questions } = project();
      expect(decide(proj, questions).status).toBe(0);
      humanTurn(proj);
      expect(reply(proj, questions, choice).status).toBe(0);
      expect(readFileSync(questions, "utf-8")).toBe(GUESSED);
      const receipt = guessRows(proj, "QUESTION_ANSWERED")[0].block;
      expect(auditBlockField(receipt, "Details")).toBe(choice);
      expect(auditBlockField(receipt, "Accepted Guess Keys")).toBeNull();
      expect(checkGuessAcceptance(proj, stageNode(), {}).ok).toBe(false);
    }
  });
});

describe("t-guess-first: the agent cannot complete the questions without a human turn", () => {
  test("no human turn after the question: accept-all is refused and the file is unchanged", () => {
    const { proj, questions } = project();
    humanTurn(proj); // a turn BEFORE the question does not count
    expect(decide(proj, questions).status).toBe(0);
    const result = reply(proj, questions, "Accept all");
    expect(result.status).toBe(1);
    expect(result.text).toContain("no human reply has arrived");
    expect(readFileSync(questions, "utf-8")).toBe(GUESSED);
    expect(guessRows(proj, "QUESTION_ANSWERED")).toHaveLength(0);
  });

  test("an answer the assistant attributes to itself is refused", () => {
    const { proj, questions } = project();
    expect(decide(proj, questions).status).toBe(0);
    humanTurn(proj);
    const result = reply(proj, questions, "A. Accept all - CONDUCTOR DEFAULT, session unattended");
    expect(result.status).toBe(1);
    expect(result.text).toContain("Only the person accepts guesses");
    expect(readFileSync(questions, "utf-8")).toBe(GUESSED);
  });

  test("one human turn accepts once: a second answer on the same turn is refused", () => {
    const { proj, questions } = project();
    expect(decide(proj, questions).status).toBe(0);
    humanTurn(proj);
    expect(reply(proj, questions, "Accept all").status).toBe(0);
    const again = log(["answer", "--stage", STAGE, "--details", "B"], proj);
    expect(again.status).toBe(1);
    expect(again.text).toContain("already recorded as an answer");
    // And the guess review itself is closed: no pending question to answer twice.
    expect(reply(proj, questions, "Accept all").text).toContain("no matching unanswered guess review");
  });

  test("a guess the agent copied into its answer is refused at the gate, as is a blank one", () => {
    const { proj, questions } = project();
    // The agent "accepts" for the person by writing the guesses itself.
    writeFileSync(questions, GUESSED.replace("[Confidence]: high\n\n[Answer]:", "[Confidence]: high\n\n[Answer]: A"));
    const check = checkGuessAcceptance(proj, stageNode(), {});
    expect(check.ok).toBe(false);
    const message = check.ok ? "" : check.message;
    expect(message).toContain('"Q1: How do staff sign in?": the answer is the agent\'s guess, and no person accepted it');
    expect(message).toContain('"Q2: How long are orders kept?": the guess is still waiting for the person');
    // A forged marker does not help: the receipt is the authority, not the file.
    writeFileSync(questions, readFileSync(questions, "utf-8").replace(
      "[Answer]: A\n",
      `[Answer]: A\n[Answer Source]: ${GUESS_ACCEPTED_SOURCE}\n`,
    ));
    expect(checkGuessAcceptance(proj, stageNode(), {}).ok).toBe(false);

    // The real gate refuses the same way.
    const env = { AIDLC_SKIP_ARTIFACT_GUARD: "1", AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS: "1" };
    run(STATE, ["checkbox", `${STAGE}=in-progress`], proj, env);
    const gate = run(STATE, ["gate-start", STAGE], proj, env);
    expect(gate.status).not.toBe(0);
    expect(gate.text).toContain("guesses are proposals until a person accepts them");
  });

  test("after the person accepts, the gate no longer refuses on guesses", () => {
    const { proj, questions } = project();
    expect(decide(proj, questions).status).toBe(0);
    humanTurn(proj);
    expect(reply(proj, questions, "Accept all").status).toBe(0);
    const env = {
      AIDLC_SKIP_ARTIFACT_GUARD: "1",
      AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS: "1",
      AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD: "1",
      AIDLC_SKIP_REVIEWER_GATE_GUARD: "1",
    };
    run(STATE, ["checkbox", `${STAGE}=in-progress`], proj, env);
    const gate = run(STATE, ["gate-start", STAGE], proj, env);
    expect(gate.text).not.toContain("guesses are proposals");
    expect(gate.status, gate.text).toBe(0);
  });
});

describe("t-guess-first: no pending-decision or Stop-hook false positives", () => {
  test("the review is a pending human wait until answered, and only then", () => {
    const { proj, questions } = project();
    expect(hasPendingDecision(proj, STAGE)).toBe(false);
    expect(decide(proj, questions).status).toBe(0);
    // Pending: the decision is open, and every guessed `[Answer]:` is still blank
    // (the Stop hook's question-file signal).
    expect(hasPendingDecision(proj, STAGE)).toBe(true);
    expect(/\[Answer\]:[ \t]*_*[ \t]*$/m.test(readFileSync(questions, "utf-8"))).toBe(true);
    humanTurn(proj);
    expect(reply(proj, questions, "Accept all").status).toBe(0);
    // Answered: the decision is closed and no blank tag remains.
    expect(hasPendingDecision(proj, STAGE)).toBe(false);
    expect(/\[Answer\]:[ \t]*_*[ \t]*$/m.test(readFileSync(questions, "utf-8"))).toBe(false);
  });

  test("a file without guesses owes nothing at the gate", () => {
    const plain = GUESSED.replace(/^\[(Guess|Basis|Confidence)\]:.*\n/gm, "");
    const { proj } = project({ content: plain });
    expect(checkGuessAcceptance(proj, stageNode(), {})).toEqual({ ok: true });
  });

  test("accepting is idempotent on the content: a re-accept adds no second marker", () => {
    const once = acceptGuessesInContent(GUESSED).content;
    const twice = acceptGuessesInContent(once);
    expect(twice.content).toBe(once);
    expect(twice.accepted).toHaveLength(3);
  });
});
