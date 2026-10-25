// covers: subcommand:aidlc-orchestrate:next, subcommand:aidlc-utility:codekb-scope-diff, function:takePersonsOwnLine
// covers: function:openQuestionReplyDirective, function:pipelineLinkEvidence, function:pipelineAttemptStartedAt
// covers: function:chatLatestMessage, function:saveReadingQuestion
//
// A live run on Kiro CLI: Reverse Engineering finished its scan and asked "Anything to add for next time?" before
// its gate; the person quit, opened a new chat and answered "nothing to add, keep going". The agent ran a bare
// `next`, which read nothing of their plain reply and handed the stage back; the stage's rerun guard then found
// the store this same run had just published CURRENT and offered it for reuse, and Reuse recorded the stage
// skipped. Their answer was never recorded, the overview never came to them for approval, and the record says
// they skipped a stage that ran.
//
// These cases pin both halves on the Claude and Kiro trees: a bare `next` (or the agent's `--resume`) right after
// their plain reply at an open stage question reads that reply as `next <their words>` does, once; and
// `codekb-scope-diff` says SCANNED for a store whose link chain this attempt recorded, so the stage goes on to its
// gate. A store from an earlier attempt (a new start, a jump, a rejection under any Guard Policy) reads as before.

import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import { auditBlockField, readAuditShardEvents } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  cleanupTestProject, createTestProject, DEFAULT_SPACE, REPO_ROOT, seedAidlcMemory, seededRecordDir,
  seededStateFile, seedStateFile,
} from "../harness/fixtures.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS * 2);

const TREES = [
  { name: "claude", dir: ".claude" },
  { name: "kiro", dir: ".kiro" },
] as const;
type Tree = (typeof TREES)[number];
const STAGE = "reverse-engineering";
const LEAD = "aidlc-developer-agent";
const QUESTION = "Anything to add for next time?";
const FIRST = "01995000-7a11-7000-8000-00000000a1a1";
const SECOND = "01995000-7a11-7000-8000-00000000b2b2";
const REPLY = "nothing to add, keep going";
const ARTIFACTS = [
  "business-overview", "architecture", "code-structure", "api-documentation", "component-inventory",
  "technology-stack", "dependencies", "code-quality-assessment",
];

const created: string[] = [];
afterEach(() => {
  while (created.length > 0) cleanupTestProject(created.pop()!);
});

function env(proj: string, chat: string): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {
    ...process.env, CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj, AIDLC_UNATTENDED: "0",
    AIDLC_SESSION_OVERRIDE: chat,
  };
  for (const key of [
    "AIDLC_SESSION_OVERRIDE_SOURCE", "AIDLC_SKIP_HUMAN_PRESENCE_GUARD", "AIDLC_SKIP_ARTIFACT_GUARD",
    "AIDLC_DISABLE_ENSEMBLE_EVIDENCE",
  ]) delete out[key];
  return out;
}

function run(tree: Tree, proj: string, chat: string, tool: string, args: string[], stdin?: string) {
  const result = spawnSync(process.execPath, [join(proj, tree.dir, "tools", `${tool}.ts`), ...args], {
    cwd: proj, env: env(proj, chat), input: stdin, encoding: "utf-8",
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  return { status: result.status, stdout: result.stdout ?? "", out: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

function hook(tree: Tree, proj: string, chat: string, name: string, payload: Record<string, unknown>): void {
  const result = run(tree, proj, chat, "aidlc", ["engine", "hook", name],
    JSON.stringify({ session_id: chat, cwd: proj, ...payload }));
  expect(result.status, result.out).toBe(0);
}

const newChat = (tree: Tree, proj: string, chat: string) =>
  hook(tree, proj, chat, "session-start", { hook_event_name: "SessionStart", source: "startup" });
const says = (tree: Tree, proj: string, chat: string, prompt: string) =>
  hook(tree, proj, chat, "record-human-turn", { hook_event_name: "UserPromptSubmit", prompt });

// The agent's `next`, followed through rules parts as the agent follows them.
function next(tree: Tree, proj: string, chat: string, args: string[] = []): Record<string, unknown> {
  let command = ["next", ...args];
  for (let parts = 0; parts < 20; parts++) {
    const result = run(tree, proj, chat, "aidlc-orchestrate", command);
    const directive = JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "") as Record<string, unknown>;
    if (directive.kind !== "load-steering") return directive;
    command = ["continue", String(directive.receipt)];
  }
  throw new Error("rules never finished arriving");
}

function scopeDiff(tree: Tree, proj: string, chat: string, json = false): { text: string; verdict: string } {
  const result = run(tree, proj, chat, "aidlc", ["engine", "workspace", "codekb-scope-diff", ...(json ? ["--json"] : [])]);
  expect(result.status, result.out).toBe(0);
  const text = result.stdout.trim();
  return { text, verdict: json ? String((JSON.parse(text) as { verdict: string }).verdict) : text.split(":")[0] };
}

const rows = (proj: string, event: string) => readAuditShardEvents(proj).filter((row) => row.event === event);

// Reverse Engineering on the bugfix plan (the developer works alone): started, the developer's handoff and the
// store it published, its link, then the learnings question, all in the first chat.
function scanned(tree: Tree, options: { asked?: boolean; policy?: "relaxed" } = {}): string {
  const proj = createTestProject();
  created.push(proj);
  seedAidlcMemory(proj);
  seedStateFile(proj, "state-brownfield-init-done.md");
  if (options.policy) {
    const state = seededStateFile(proj);
    writeFileSync(state, readFileSync(state, "utf-8").replace(/- \*\*Change Control\*\*: [^\n]*/,
      `- **Guard Policy**: ${options.policy} (set by you)`));
  }
  cpSync(join(REPO_ROOT, "dist", tree.name, tree.dir), join(proj, tree.dir), { recursive: true });
  spawnSync("git", ["init", "-q"], { cwd: proj });
  mkdirSync(join(proj, "src"), { recursive: true });
  writeFileSync(join(proj, "src", "app.js"), "export const notes = [];\n");
  newChat(tree, proj, FIRST);
  says(tree, proj, FIRST, "/aidlc");
  expect(next(tree, proj, FIRST, ["--resume"])).toMatchObject({ kind: "run-stage", stage: STAGE });
  // The seeded state already has the stage in progress, so its start is written here.
  appendAuditEntry("STAGE_STARTED", { Stage: STAGE, Agent: LEAD }, proj);
  Bun.sleepSync(1100);
  const dir = join(seededRecordDir(proj), "inception", STAGE);
  mkdirSync(dir, { recursive: true });
  const handoff = join(dir, "developer-scan.md");
  writeFileSync(handoff, "## Developer Code Scan Results\n\n### Scan Coverage\n\n- ./\n\n## Handoff Summary\n\nDone.\n");
  const store = join(proj, "aidlc", "spaces", DEFAULT_SPACE, "codekb", basename(proj));
  mkdirSync(store, { recursive: true });
  for (const name of ARTIFACTS) writeFileSync(join(store, `${name}.md`), `# ${name}\n`);
  const fingerprint = run(tree, proj, FIRST, "aidlc", ["engine", "workspace", "codekb-scope-diff", "--mint", "--paths", "./"])
    .stdout.trim();
  writeFileSync(join(store, "reverse-engineering-timestamp.md"), [
    "# Reverse Engineering Timestamp", "", "## Run Record", "", "- today", "", "## Scope of Analysis", "", "```yaml",
    "scope_version: 1", "kind: full", "intent: fixture", `fingerprint: ${fingerprint}`, "analyzed:", "  paths:",
    "    - ./", "  components: []", "shallow:", "  paths: []", "```", "",
  ].join("\n"));
  const link = run(tree, proj, FIRST, "aidlc-log", ["link", "--stage", STAGE, "--link", LEAD, "--artifact", relative(proj, handoff)]);
  expect(link.status, link.out).toBe(0);
  if (options.asked !== false) {
    const asked = run(tree, proj, FIRST, "aidlc-log", [
      "decision", "--stage", STAGE, "--decision", QUESTION, "--options", "Nothing to add,Add a note",
      "--question-kind", "learnings-note",
    ]);
    expect(asked.status, asked.out).toBe(0);
  }
  return proj;
}

// The reply the engine hands for their words: the open question, read by the agent.
function readsTheirReply(directive: Record<string, unknown>): void {
  expect(directive.kind).toBe("print");
  const message = String(directive.message);
  expect(message).toContain(`Stage "${STAGE}" has a question you asked that the person has not answered yet: ` +
    `${JSON.stringify(QUESTION)}, with the choices "Nothing to add", "Add a note". Read their reply.`);
  expect(message).toMatch(/next --request [0-9a-f]{8}/);
}

for (const tree of TREES) {
  describe(`t-new-chat-keeps-the-gate (${tree.name})`, () => {
    test("a new chat at the learnings question: a bare next reads their plain reply, and the gate comes", () => {
      const proj = scanned(tree);
      newChat(tree, proj, SECOND);
      says(tree, proj, SECOND, REPLY);
      readsTheirReply(next(tree, proj, SECOND));

      const answered = run(tree, proj, SECOND, "aidlc-log", ["answer", "--stage", STAGE, "--details", "Nothing to add"]);
      expect(answered.status, answered.out).toBe(0);
      const answer = rows(proj, "QUESTION_ANSWERED").at(-1)!.block;
      expect(auditBlockField(answer, "Details")).toBe("Nothing to add");
      expect(auditBlockField(answer, "Person Reply")).toBe(REPLY);

      // The stage comes back to the chat that never held it; its rerun guard finds this run's own store.
      expect(next(tree, proj, SECOND)).toMatchObject({ kind: "run-stage", stage: STAGE });
      const text = scopeDiff(tree, proj, SECOND);
      expect(text.verdict).toBe("SCANNED");
      expect(text.text).toContain("there is nothing to reuse or rescan");
      expect(scopeDiff(tree, proj, SECOND, true).verdict).toBe("SCANNED");

      const gate = run(tree, proj, SECOND, "aidlc-orchestrate", ["report", "--stage", STAGE, "--result", "awaiting-approval"]);
      expect(gate.status, gate.out).toBe(0);
      expect(gate.stdout).toContain(`Recorded awaiting-approval for \\"${STAGE}\\"`);
      expect(rows(proj, "DECISION_RECORDED").filter((row) => auditBlockField(row.block, "Question Kind") === "learnings-note"))
        .toHaveLength(1);
      expect(rows(proj, "STAGE_SKIPPED")).toHaveLength(0);
    });

    test("the agent's --resume after their plain reply reads it too, instead of asking again", () => {
      const proj = scanned(tree);
      newChat(tree, proj, SECOND);
      says(tree, proj, SECOND, REPLY);
      readsTheirReply(next(tree, proj, SECOND, ["--resume"]));
    });

    test("their reply is read once: a second bare next is the work in hand", () => {
      const proj = scanned(tree);
      newChat(tree, proj, SECOND);
      says(tree, proj, SECOND, REPLY);
      readsTheirReply(next(tree, proj, SECOND));
      expect(next(tree, proj, SECOND)).toMatchObject({ kind: "run-stage", stage: STAGE });
    });

    test("two messages kept in one second: the reply the record shows last is the one read", () => {
      const proj = scanned(tree);
      newChat(tree, proj, SECOND);
      says(tree, proj, SECOND, REPLY);
      // A second message of the same second whose id sorts after theirs, with no turn of its own after their reply:
      // the store alone cannot say which came last.
      const dir = join(proj, "aidlc", ".aidlc-sessions", "messages");
      const id = auditBlockField(rows(proj, "HUMAN_TURN").at(-1)!.block, "Message Id")!;
      const kept = JSON.parse(readFileSync(join(dir, `${id}.json`), "utf-8")) as Record<string, unknown>;
      writeFileSync(join(dir, "ffffffff.json"), `${JSON.stringify({ ...kept, id: "ffffffff", text: "older words", words: "older words" })}\n`);
      readsTheirReply(next(tree, proj, SECOND));
    });

    test("the same, with the host's session row recorded after their reply (Copilot CLI's order)", () => {
      const proj = scanned(tree);
      newChat(tree, proj, SECOND);
      says(tree, proj, SECOND, REPLY);
      const id = auditBlockField(rows(proj, "HUMAN_TURN").at(-1)!.block, "Message Id")!;
      appendAuditEntry("SESSION_RESUMED", { Source: "resume", Session: SECOND }, proj);
      const dir = join(proj, "aidlc", ".aidlc-sessions", "messages");
      const kept = JSON.parse(readFileSync(join(dir, `${id}.json`), "utf-8")) as Record<string, unknown>;
      writeFileSync(join(dir, "ffffffff.json"), `${JSON.stringify({ ...kept, id: "ffffffff", text: "older words", words: "older words" })}\n`);
      readsTheirReply(next(tree, proj, SECOND));
    });

    test("in the same chat, a bare next before their answer is logged reads their reply", () => {
      const proj = scanned(tree);
      says(tree, proj, FIRST, REPLY);
      readsTheirReply(next(tree, proj, FIRST));
    });
  });
}

describe("t-new-chat-keeps-the-gate: what stays as it was", () => {
  const tree = TREES[0];

  test("plain words with no question open: a bare next is the work in hand", () => {
    const proj = scanned(tree, { asked: false });
    newChat(tree, proj, SECOND);
    says(tree, proj, SECOND, REPLY);
    expect(next(tree, proj, SECOND)).toMatchObject({ kind: "run-stage", stage: STAGE });
  });

  // The agent read their words as a plan switch and named the plan: that reading is its own, and so is the step
  // (`--scope` changes the plan; a plan name alone beside work gets its own which-did-they-mean step).
  test("plain words at the open question that the agent passes as a plan switch: its switch step stands", () => {
    for (const [args, own] of [[["--scope", "feature"], "scope change --scope feature"], [["feature"], "next --scope feature`"]] as const) {
      const proj = scanned(tree);
      newChat(tree, proj, SECOND);
      says(tree, proj, SECOND, "can you switch this to the feature plan?");
      const step = String(next(tree, proj, SECOND, [...args]).message ?? "");
      expect(step, args.join(" ")).not.toContain("has a question you asked that the person has not answered yet");
      expect(step, args.join(" ")).toContain(own);
    }
  });

  test("a store from an earlier attempt reads CURRENT: a new start, a jump back, a rejection under relaxed", () => {
    const restarted = scanned(tree);
    Bun.sleepSync(1100);
    appendAuditEntry("STAGE_STARTED", { Stage: STAGE, Agent: LEAD }, restarted);
    expect(scopeDiff(tree, restarted, FIRST).verdict).toBe("CURRENT");

    const jumped = scanned(tree);
    Bun.sleepSync(1100);
    appendAuditEntry("STAGE_JUMPED", { Source: "requirements-analysis", Target: STAGE }, jumped);
    expect(scopeDiff(tree, jumped, FIRST).verdict).toBe("CURRENT");

    // Relaxed keeps the rejected attempt's links, so the rework is not asked for again; the store is still not
    // this attempt's own.
    const rejected = scanned(tree, { policy: "relaxed" });
    expect(scopeDiff(tree, rejected, FIRST).verdict).toBe("SCANNED");
    Bun.sleepSync(1100);
    appendAuditEntry("GATE_REJECTED", { Stage: STAGE, Feedback: "cover the tests folder too" }, rejected);
    expect(scopeDiff(tree, rejected, FIRST).verdict).toBe("CURRENT");
  });

  test("an isolated start left open does not hide the main run's chain; no store is NO_STORE", () => {
    const proj = scanned(tree);
    Bun.sleepSync(1100);
    appendAuditEntry("STAGE_STARTED", { Stage: STAGE, Agent: LEAD, Workflow: `single-stage:${STAGE}` }, proj);
    expect(scopeDiff(tree, proj, FIRST).verdict).toBe("SCANNED");
    unlinkSync(join(proj, "aidlc", "spaces", DEFAULT_SPACE, "codekb", basename(proj), "reverse-engineering-timestamp.md"));
    expect(scopeDiff(tree, proj, FIRST).verdict).toBe("NO_STORE");
  });

  test("an isolated rescan after the stage was approved: the store reads CURRENT, so the rescan is still asked", () => {
    const proj = scanned(tree);
    says(tree, proj, FIRST, "nothing to add");
    expect(run(tree, proj, FIRST, "aidlc-log", ["answer", "--stage", STAGE, "--details", "Nothing to add"]).status).toBe(0);
    const gate = run(tree, proj, FIRST, "aidlc-orchestrate", ["report", "--stage", STAGE, "--result", "awaiting-approval"]);
    expect(gate.status, gate.out).toBe(0);
    says(tree, proj, FIRST, "approve");
    const approved = run(tree, proj, FIRST, "aidlc-orchestrate", ["report", "--stage", STAGE, "--result", "approved", "--user-input", "Approve"]);
    expect(approved.status, approved.out).toBe(0);
    expect(scopeDiff(tree, proj, FIRST).verdict).toBe("SCANNED");

    Bun.sleepSync(1100);
    says(tree, proj, FIRST, "/aidlc --stage reverse-engineering --single");
    expect(next(tree, proj, FIRST, ["--stage", STAGE, "--single"])).toMatchObject({ kind: "run-stage", stage: STAGE, single: true });
    expect(scopeDiff(tree, proj, FIRST).verdict).toBe("CURRENT");
  });

  test("the stage's rerun guard says what SCANNED means", () => {
    const stage = readFileSync(join(REPO_ROOT, "dist", "claude", ".claude", "aidlc-common", "stages", "inception",
      `${STAGE}.md`), "utf-8");
    const guard = stage.slice(stage.indexOf("#### Rerun guard"), stage.indexOf("Reuse question (CURRENT"))
      .replace(/\s+/g, " ");
    expect(guard).toContain("- **SCANNED** - ");
    expect(guard).toContain("go on to Step 4");
  });
});
