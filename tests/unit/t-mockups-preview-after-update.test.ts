// covers: function:gateOutputWriting, function:inspectRequiredArtifactInstances, subcommand:aidlc-log:review
//
// An update lands while Refined Mockups waits at its gate: the preview is now
// a required output, so the review recorded before the update no longer
// matches, and the person approves. The approval is refused for the stale
// review, the recovery review request names the missing preview, the agent
// writes it, and after the READY recovery review the person's approval goes
// through on their own reply, without asking them again.
//
// Mechanism: function - the shipped hooks, `log decision|answer|review` and
// `report` on a seeded project, with the stage graph from before the update
// (no preview) for everything up to the gate; no agent runs.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { auditBlockField, readAuditShardEvents } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { PREVIEW_CONTENT_POLICY } from "../../dist/claude/.claude/tools/aidlc-artifact-resolution.ts";
import { cleanupTestProject, seededRecordDir, seededStateFile, setupIntegrationProject } from "../harness/fixtures.ts";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS } from "../harness/test-budget.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const STAGE = "refined-mockups";
const REVIEWER = "aidlc-product-lead-agent";
const SESSION = "t-mockups-preview-after-update";
const GRAPH = join(import.meta.dir, "..", "..", "dist", "claude", ".claude", "tools", "data", "stage-graph.json");

const projects: string[] = [];
afterEach(() => {
  for (const proj of projects.splice(0)) cleanupTestProject(proj);
});

// The tools as a person's run calls them: the guards this path meets are on.
function env(proj: string, graph: string | null): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = { ...process.env, AIDLC_SKIP_REVIEWER_GATE_GUARD: "0", AIDLC_SKIP_ARTIFACT_GUARD: "0",
    AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD: "0", AIDLC_SESSION_OVERRIDE: SESSION, CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj };
  for (const key of ["AIDLC_SKIP_HUMAN_PRESENCE_GUARD", "AIDLC_UNATTENDED", "CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CLAUDE_PID",
    "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_ENTRYPOINT", "AIDLC_STAGE_GRAPH"]) delete e[key];
  if (graph !== null) e.AIDLC_STAGE_GRAPH = graph;
  return e;
}

const last = (text: string): Record<string, unknown> => {
  try {
    return JSON.parse(text.trim().split("\n").at(-1) ?? "{}");
  } catch {
    return {};
  }
};

// Refined Mockups in progress on a feature run, its answers confirmed, its
// outputs written and reviewed and its gate open, all under the stage graph
// from before the update, which has no preview.
async function waitingAtGateBeforeUpdate() {
  const proj = setupIntegrationProject({ withState: "state-brownfield-feature.md", stripEnvScope: true });
  projects.push(proj);
  const state = seededStateFile(proj);
  writeFileSync(state, readFileSync(state, "utf-8")
    .replace("- [-] requirements-analysis", "- [x] requirements-analysis")
    .replace("- [ ] user-stories", "- [x] user-stories")
    .replace("- [ ] refined-mockups", "- [-] refined-mockups")
    .replace("**Current Stage**: requirements-analysis", "**Current Stage**: refined-mockups")
    .replace("**In Progress**: requirements-analysis", "**In Progress**: refined-mockups"));
  const graph = JSON.parse(readFileSync(GRAPH, "utf-8"));
  for (const stage of graph.stages ?? graph) {
    if (stage.slug === STAGE) stage.produces = stage.produces.filter((name: string) => name !== "mockups-preview");
  }
  const before = join(proj, "..", `${SESSION}-graph-${process.pid}-${projects.length}.json`);
  writeFileSync(before, JSON.stringify(graph));

  let graphNow: string | null = before;
  const engine = (args: string[], input?: string) => {
    const r = spawnSync(process.execPath, [join(proj, ".claude", "tools", "aidlc.ts"), ...args], {
      cwd: proj, input, encoding: "utf-8", env: env(proj, graphNow),
    });
    return { status: r.status, stdout: r.stdout ?? "", out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
  };
  const ok = (args: string[]) => {
    const r = engine(args);
    expect(r.status, r.out).toBe(0);
    return last(r.stdout);
  };
  const say = async (prompt: string): Promise<string> => {
    const r = engine(["engine", "hook", "record-human-turn"],
      JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: SESSION, prompt }));
    expect(r.status, r.out).toBe(0);
    await Bun.sleep(1100);
    const turn = readAuditShardEvents(proj).filter((row) => row.event === "HUMAN_TURN").at(-1)!;
    return auditBlockField(turn.block, "Message Id")!;
  };
  // The agent's file tool, with the write hook a host fires after it.
  const put = (abs: string, content: string) => {
    const existed = existsSync(abs);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
    const r = engine(["engine", "hook", "write-audit-log"], JSON.stringify({
      session_id: SESSION, cwd: proj, hook_event_name: "PostToolUse", tool_name: "Write",
      tool_input: { file_path: abs, content }, tool_response: { type: existed ? "update" : "create", filePath: abs },
    }));
    expect(r.status, r.out).toBe(0);
  };
  const reviewPass = (iteration: number) => {
    const base = ["engine", "log", "review", "--stage", STAGE, "--reviewer", REVIEWER, "--iteration", String(iteration)];
    const requested = engine(base);
    if (requested.status !== 0) return { requested, verdict: null };
    const file = last(requested.stdout).reviewFile as string;
    const target = isAbsolute(file) ? file : join(proj, file);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, `## Review\n\n**Verdict:** READY\n**Reviewer:** ${REVIEWER}\n**Iteration:** ${iteration}\n\n### Findings\n\n` +
      "**Prior findings**\n\n| ID | Now | Severity | Note |\n|---|---|---|---|\n\n**New findings**\n\n" +
      "| Severity | Location | Finding | Required action |\n|---|---|---|---|\n");
    return { requested, verdict: ok([...base, "--verdict", "READY"]) };
  };

  const dir = join(seededRecordDir(proj), "inception", STAGE);
  mkdirSync(dir, { recursive: true });
  const questions = join(dir, "refined-mockups-questions.md");
  const questionText = (answer: string, summary?: string) =>
    `# refined-mockups questions\n\n## Question 1\n\nWhich layout fits?\n\nA. One page\nB. A wizard\nX. Other (please specify)\n\n[Answer]: ${answer}\n` +
    (summary === undefined ? "" : "\n## Consolidated Summary Confirmation\n\nDoes this all look correct before I generate the artifact?\n\n" +
      `- Looks correct\n- Request changes\n\n[Answer]: ${summary}\n`);
  writeFileSync(questions, questionText(""));
  ok(["engine", "log", "decision", "--stage", STAGE, "--decision", "Question 1", "--options", "A,B,X"]);
  await say("A");
  writeFileSync(questions, questionText("A"));
  ok(["engine", "log", "answer", "--stage", STAGE, "--details", "A"]);
  writeFileSync(questions, questionText("A", ""));
  const summary = "Does this all look correct before I generate the artifact?";
  ok(["engine", "log", "decision", "--stage", STAGE, "--checkpoint", "summary-confirmation", "--questions-file", questions,
    "--decision", summary, "--options", "Looks correct,Request changes"]);
  await say("Looks correct");
  writeFileSync(questions, questionText("A", "Looks correct"));
  ok(["engine", "log", "answer", "--stage", STAGE, "--checkpoint", "summary-confirmation", "--questions-file", questions,
    "--details", "Looks correct"]);
  for (const name of ["mockups.md", "interaction-spec.md", "design-system-mapping.md", "accessibility-checklist.md"]) {
    put(join(dir, name), `# ${name}\n\n- UX1.1.1 Sign in on one page [Q1]\n`);
  }
  expect(reviewPass(1).verdict, "the review before the update").not.toBeNull();
  expect(ok(["engine", "orchestrate", "report", "--stage", STAGE, "--result", "awaiting-approval"]).kind).toBe("print");
  graphNow = null;
  return { proj, dir, engine, say, put, reviewPass };
}

describe("t-mockups-preview-after-update", () => {
  test("an update at the open gate ends with the preview written and the person's approval through, not asked again", async () => {
    const { proj, dir, engine, say, put, reviewPass } = await waitingAtGateBeforeUpdate();
    const approve = await say("Approve");
    const refused = last(engine(["engine", "orchestrate", "report", "--stage", STAGE, "--result", "approved",
      "--user-input", "Approve"]).stdout);
    expect(JSON.stringify(refused.reason_codes)).toContain("ARTIFACT_REVIEW_STALE");
    expect(refused.agent_work, "the recovery is the agent's to run, not a question for the person").toBe(true);

    // The recovery review cannot bind to outputs with the preview missing; its
    // refusal names the preview, so the agent writes it.
    const early = reviewPass(2);
    expect(early.requested.status, early.requested.out).not.toBe(0);
    expect(early.requested.out).toContain("mockups-preview.html");

    put(join(dir, "mockups-preview.html"), `<!doctype html><html><head>${PREVIEW_CONTENT_POLICY}</head><body>UX1.1.1</body></html>\n`);
    const recovery = reviewPass(2);
    expect(recovery.requested.status, recovery.requested.out).toBe(0);
    expect(String(recovery.verdict?.agent_note)).toContain(`if their message ${approve} (sent `);

    const recorded = last(engine(["engine", "orchestrate", "report", "--stage", STAGE, "--result", "approved",
      "--user-input", "Approve", "--message", approve]).stdout);
    expect(recorded.kind, JSON.stringify(recorded)).toBe("done");
    const approvals = readAuditShardEvents(proj).filter((row) =>
      row.event === "GATE_APPROVED" && auditBlockField(row.block, "Stage") === STAGE);
    expect(approvals.length).toBe(1);
    expect(auditBlockField(approvals[0].block, "Message Id")).toBe(approve);
    expect(readAuditShardEvents(proj).filter((row) => row.event === "HUMAN_TURN").length, "nothing asked them again").toBe(3);
  });

  // A file the gate did show, changed after their reply, is still something
  // they did not see: their reply no longer answers the gate.
  test("a change to an output the gate showed still needs their new answer", async () => {
    const { dir, engine, say, put, reviewPass } = await waitingAtGateBeforeUpdate();
    const approve = await say("Approve");
    put(join(dir, "mockups-preview.html"), `<!doctype html><html><head>${PREVIEW_CONTENT_POLICY}</head><body>UX1.1.1</body></html>\n`);
    put(join(dir, "mockups.md"), "# mockups.md\n\n- UX1.1.1 Sign in on two pages [Q1]\n");
    expect(reviewPass(2).verdict).not.toBeNull();
    const refused = engine(["engine", "orchestrate", "report", "--stage", STAGE, "--result", "approved",
      "--user-input", "Approve", "--message", approve]);
    expect(refused.out).toContain(`their message ${approve} came before the gate's output was last written`);
  });
});
