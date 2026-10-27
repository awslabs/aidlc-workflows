// covers: function:reviewVerdictStep, function:reviewVerdictNote, subcommand:aidlc-log:review
//
// Under Guard Policy strict, the reviewed document changes at an open gate (the
// agent edits it there) and the person approves. The approval is refused for
// the stale review and the one recovery review runs. When it is READY, the
// person's reply at the gate still stands and nothing has used it, so the
// verdict's note names that message and tells the agent to record it, without
// asking them again; the report with that message records their approval. A
// NOT-READY recovery review brings its findings to them at the gate, as before.
//
// Mechanism: function - the shipped human-turn hook, `log review` and `report`
// on a seeded project; no agent runs.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { auditBlockField, readAuditShardEvents, setGuardPolicyLine } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { cleanupTestProject, seededRecordDir, seededStateFile, setupIntegrationProject } from "../harness/fixtures.ts";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS } from "../harness/test-budget.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const STAGE = "requirements-analysis";
const REVIEWER = "aidlc-product-lead-agent";
const SESSION = "t-recovery-review-reply-stands";

const projects: string[] = [];
afterEach(() => {
  for (const proj of projects.splice(0)) cleanupTestProject(proj);
});

// The tools as a person's run calls them: the presence and reviewer guards on.
function env(proj: string, session = SESSION): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = { ...process.env, AIDLC_SKIP_REVIEWER_GATE_GUARD: "0", AIDLC_SESSION_OVERRIDE: session,
    CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj };
  for (const key of ["AIDLC_SKIP_HUMAN_PRESENCE_GUARD", "AIDLC_UNATTENDED", "CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CLAUDE_PID",
    "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_ENTRYPOINT"]) delete e[key];
  return e;
}

function engine(proj: string, args: string[], input?: string, session = SESSION) {
  const r = spawnSync(process.execPath, [join(proj, ".claude", "tools", "aidlc.ts"), ...args], {
    cwd: proj, input, encoding: "utf-8", env: env(proj, session),
  });
  return { status: r.status, stdout: r.stdout ?? "", out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}
const last = (text: string): Record<string, unknown> => {
  try {
    return JSON.parse(text.trim().split("\n").at(-1) ?? "{}");
  } catch {
    return {};
  }
};

async function personSays(proj: string, prompt: string): Promise<string> {
  const r = engine(proj, ["engine", "hook", "record-human-turn"],
    JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: SESSION, prompt }));
  expect(r.status, r.out).toBe(0);
  await Bun.sleep(1100);
  const turn = readAuditShardEvents(proj).filter((row) => row.event === "HUMAN_TURN").at(-1)!;
  return auditBlockField(turn.block, "Message Id")!;
}

// One review pass, requested and recorded with the verdict given, from the
// chat named (this one by default), with the findings given (none by default;
// NOT-READY gets a Major one).
function review(
  proj: string,
  iteration: number,
  verdict: "READY" | "NOT-READY",
  opts: { session?: string; finding?: string } = {},
): Record<string, unknown> {
  const session = opts.session ?? SESSION;
  const base = ["engine", "log", "review", "--stage", STAGE, "--reviewer", REVIEWER, "--iteration", String(iteration)];
  const requested = last(engine(proj, base, undefined, session).stdout);
  const finding = opts.finding ?? (verdict === "NOT-READY" ? "| Major | requirements.md | FR2 has no acceptance rule | Add one |\n" : "");
  const findings = `| Severity | Location | Finding | Required action |\n|---|---|---|---|\n${finding}`;
  const body = `## Review\n\n**Verdict:** ${verdict}\n**Reviewer:** ${REVIEWER}\n**Iteration:** ${iteration}\n\n### Findings\n\n` +
    `**Prior findings**\n\n| ID | Now | Severity | Note |\n|---|---|---|---|\n\n**New findings**\n\n${findings}`;
  const file = requested.reviewFile as string | undefined;
  const target = file ? (isAbsolute(file) ? file : join(proj, file)) : join(seededRecordDir(proj), "inception", STAGE, "requirements.md");
  mkdirSync(dirname(target), { recursive: true });
  if (file) writeFileSync(target, body);
  else appendFileSync(target, `\n${body}`);
  const done = engine(proj, [...base, "--verdict", verdict], undefined, session);
  expect(done.status, done.out).toBe(0);
  return last(done.stdout);
}

// Strict, Requirements Analysis reviewed and its gate open; the agent edits
// the document at the gate, the person approves, and the approval is refused
// for the stale review with the one recovery review to run.
async function approvedThenStale(): Promise<{ proj: string; approve: string }> {
  const proj = setupIntegrationProject({ withState: "state-mid-inception.md", stripEnvScope: true });
  projects.push(proj);
  const state = seededStateFile(proj);
  writeFileSync(state, setGuardPolicyLine(readFileSync(state, "utf-8"), "strict (set by you)"));
  const dir = join(seededRecordDir(proj), "inception", STAGE);
  mkdirSync(dir, { recursive: true });
  for (const name of ["requirements.md", `${STAGE}-questions.md`]) {
    if (!existsSync(join(dir, name))) writeFileSync(join(dir, name), `# ${name}\n\n- FR1 Sign up\n`);
  }
  review(proj, 1, "READY");
  const opened = last(engine(proj, ["engine", "orchestrate", "report", "--stage", STAGE, "--result", "awaiting-approval"]).stdout);
  expect(opened.kind, JSON.stringify(opened)).toBe("print");
  appendFileSync(join(dir, "requirements.md"), "- FR2 Sign in\n");
  const approve = await personSays(proj, "Approve");
  const refused = last(engine(proj, ["engine", "orchestrate", "report", "--stage", STAGE, "--result", "approved",
    "--user-input", "Approve"]).stdout);
  expect(refused.kind, JSON.stringify(refused)).toBe("ask");
  expect(JSON.stringify(refused.reason_codes)).toContain("ARTIFACT_REVIEW_STALE");
  return { proj, approve };
}

describe("t-recovery-review-reply-stands: after the recovery review, the person's approval stands", () => {
  test("a READY recovery review names their reply at the gate and records it, without asking again", async () => {
    const { proj, approve } = await approvedThenStale();
    const verdict = review(proj, 2, "READY");
    const note = String(verdict.agent_note ?? "");
    expect(note).toContain(`record the person's reply at the "${STAGE}" gate, which still stands, without asking them again: if their message ${approve} (sent `);
    expect(note).toContain(`--result approved --user-input "Approve" --message <id>`);
    expect(note).toContain(`--result rejected --user-input "Request Changes" --message <id>`);
    const recorded = last(engine(proj, ["engine", "orchestrate", "report", "--stage", STAGE, "--result", "approved",
      "--user-input", "Approve", "--message", approve]).stdout);
    expect(recorded.kind, JSON.stringify(recorded)).toBe("done");
    const rows = readAuditShardEvents(proj).filter((row) => row.event === "GATE_APPROVED");
    expect(rows.length).toBe(1);
    expect(auditBlockField(rows[0].block, "Message Id")).toBe(approve);
  });

  // The person approved in one chat; the recovery review is recorded from
  // another (they picked the work up there). The agent there never saw their
  // words, so the note names no message of the other chat's and the gate is
  // asked, as before.
  test("a READY recovery review recorded in another chat shows the gate there", async () => {
    const { proj, approve } = await approvedThenStale();
    const note = String(review(proj, 2, "READY", { session: "t-recovery-review-reply-stands-2" }).agent_note ?? "");
    expect(note).not.toContain(approve);
    expect(note).toContain("printing its output as the review brief, and ask the approval question in this turn.");
  });

  // A finding the person has not seen comes to them at the gate, with the
  // review brief: their approval came before it.
  test("a READY recovery review with a minor finding shows it at the gate and asks", async () => {
    const { proj } = await approvedThenStale();
    const note = String(review(proj, 2, "READY", { finding: "| Minor | requirements.md | FR1 names no error case | Name one |\n" })
      .agent_note ?? "");
    expect(note).not.toContain("still stands");
    expect(note).toContain("printing its output as the review brief, and ask the approval question in this turn.");
  });

  test("a NOT-READY recovery review brings its findings to the gate, as before", async () => {
    const { proj } = await approvedThenStale();
    const note = String(review(proj, 2, "NOT-READY").agent_note ?? "");
    expect(note).not.toContain("still stands");
    expect(note).toContain("printing its output as the review brief, and ask the approval question in this turn.");
  });
});
