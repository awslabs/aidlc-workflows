// covers: subcommand:aidlc-orchestrate:report, function:openQuestionAgainDirective, function:stageAnsweredSinceStart
//
// A live run on opencode: a second piece of work in a project whose code knowledge base another one had just built.
// Its Reverse Engineering put the reuse question on record, the agent took the reuse itself, its answer was refused
// ("no new human reply has arrived for the question"), and two seconds later the engine committed the stage skipped
// with the stage file's reason "codekb reuse: all resolved stores CURRENT, human chose reuse". The record said the
// person chose reuse; they never saw the question, and their pick (reuse, full or focused rescan) was made for them.
//
// These cases pin that a skip resting on reuse alone stands on the person's own recorded answer to the stage's
// question: while it is open the step shows it and says to report the skip again once they answer; with no answer
// on record the step says how to record one. The person's own skip, a skip that rests on no reuse, an answer they
// left to the agent and an unattended run commit as before.

import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import { auditBlockField, parseCheckboxes, readAuditShardEvents } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  cleanupTestProject, createTestProject, DEFAULT_SPACE, REPO_ROOT, seedAidlcMemory, seededStateFile, seedStateFile,
} from "../harness/fixtures.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS * 2);

const TREES = [
  { name: "claude", dirs: [".claude"], tools: ".claude" },
  { name: "opencode", dirs: [".aidlc", ".opencode"], tools: ".aidlc" },
] as const;
type Tree = (typeof TREES)[number];
const STAGE = "reverse-engineering";
const CHAT = "01995000-7a11-7000-8000-00000000c4c4";
const QUESTION = "Reuse existing code knowledge base or rescan?";
const OPTIONS = "Reuse existing knowledge base,Full rescan,Focused scan";
const REUSE_REASON = "codekb reuse: all resolved stores CURRENT, human chose reuse";
const ARTIFACTS = [
  "business-overview", "architecture", "code-structure", "api-documentation", "component-inventory",
  "technology-stack", "dependencies", "code-quality-assessment",
];

const created: string[] = [];
afterEach(() => {
  while (created.length > 0) cleanupTestProject(created.pop()!);
});

function env(proj: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {
    ...process.env, CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj, AIDLC_UNATTENDED: "0",
    AIDLC_SESSION_OVERRIDE: CHAT, ...extra,
  };
  for (const key of [
    "AIDLC_SESSION_OVERRIDE_SOURCE", "AIDLC_SKIP_HUMAN_PRESENCE_GUARD", "AIDLC_SKIP_ARTIFACT_GUARD",
    "AIDLC_DISABLE_ENSEMBLE_EVIDENCE",
  ]) if (!(key in extra)) delete out[key];
  return out;
}

function run(tree: Tree, proj: string, tool: string, args: string[], options: { stdin?: string; env?: Record<string, string> } = {}) {
  const result = spawnSync(process.execPath, [join(proj, tree.tools, "tools", `${tool}.ts`), ...args], {
    cwd: proj, env: env(proj, options.env), input: options.stdin, encoding: "utf-8",
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  return { status: result.status, stdout: result.stdout ?? "", out: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

function says(tree: Tree, proj: string, prompt: string): void {
  const result = run(tree, proj, "aidlc", ["engine", "hook", "record-human-turn"], {
    stdin: JSON.stringify({ session_id: CHAT, cwd: proj, hook_event_name: "UserPromptSubmit", prompt }),
  });
  expect(result.status, result.out).toBe(0);
}

const lastJson = (stdout: string) => JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}") as Record<string, unknown>;
const rows = (proj: string, event: string) => readAuditShardEvents(proj).filter((row) => row.event === event);
const stageState = (proj: string) =>
  parseCheckboxes(readFileSync(seededStateFile(proj), "utf-8")).find((row) => row.slug === STAGE)?.state;

function skip(tree: Tree, proj: string, extra: Record<string, string> = {}) {
  return run(tree, proj, "aidlc", ["engine", "orchestrate", "report", "--stage", STAGE, "--result", "skipped", "--reason", REUSE_REASON], { env: extra });
}

// A store another piece of work built, current, with no link of this work; Reverse Engineering started in this
// work, whose record holds no reply of the person's (the message that asked for it is on the other work's record).
function storeFromOtherWork(tree: Tree, repos: string[] = []): string {
  const proj = createTestProject();
  created.push(proj);
  seedAidlcMemory(proj);
  seedStateFile(proj, "state-brownfield-init-done.md");
  for (const dir of tree.dirs) cpSync(join(REPO_ROOT, "dist", tree.name, dir), join(proj, dir), { recursive: true });
  if (repos.length > 0) {
    const registry = join(proj, "aidlc", "spaces", DEFAULT_SPACE, "intents", "intents.json");
    const rowsOf = JSON.parse(readFileSync(registry, "utf-8")) as Array<Record<string, unknown>>;
    rowsOf[0].repos = repos;
    writeFileSync(registry, `${JSON.stringify(rowsOf, null, 2)}\n`);
  }
  for (const repo of repos.length > 0 ? repos : [basename(proj)]) {
    const root = repos.length > 0 ? join(proj, repo) : proj;
    mkdirSync(join(root, "src"), { recursive: true });
    spawnSync("git", ["init", "-q"], { cwd: root });
    writeFileSync(join(root, "src", "app.js"), "export const tally = () => 0;\n");
    const kb = join(proj, "aidlc", "spaces", DEFAULT_SPACE, "codekb", repo);
    mkdirSync(kb, { recursive: true });
    for (const name of ARTIFACTS) writeFileSync(join(kb, `${name}.md`), `# ${name}\n`);
    const mint = run(tree, proj, "aidlc", [
      "engine", "workspace", "codekb-scope-diff", "--mint", "--paths", "./", ...(repos.length > 0 ? ["--repo", repo] : []),
    ]);
    writeFileSync(join(kb, "reverse-engineering-timestamp.md"), [
      "# Reverse Engineering Timestamp", "", "## Run Record", "", "- earlier", "", "## Scope of Analysis", "", "```yaml",
      "scope_version: 1", "kind: full", "intent: other-work", `fingerprint: ${mint.stdout.trim()}`, "analyzed:", "  paths:",
      "    - ./", "  components: []", "shallow:", "  paths: []", "```", "",
    ].join("\n"));
  }
  appendAuditEntry("STAGE_STARTED", { Stage: STAGE, Agent: "aidlc-developer-agent" }, proj);
  return proj;
}

function asked(tree: Tree, proj: string, repo?: string): void {
  const result = run(tree, proj, "aidlc-log", [
    "decision", "--stage", STAGE, "--decision", repo ? `${QUESTION} (${repo})` : QUESTION, "--options", OPTIONS,
  ]);
  expect(result.status, result.out).toBe(0);
}

function kept(tree: Tree, proj: string, repo?: string): void {
  const store = `aidlc/spaces/${DEFAULT_SPACE}/codekb/${repo ?? basename(proj)}/`;
  const result = run(tree, proj, "aidlc-state", [
    "reuse-artifact", STAGE, "--decision", "keep", "--artifacts", store, ...(repo ? ["--repo", repo] : []),
  ]);
  expect(result.status, result.out).toBe(0);
}

function nothingSkipped(proj: string): void {
  expect(rows(proj, "STAGE_SKIPPED")).toHaveLength(0);
  expect(stageState(proj)).toBe("in-progress");
}

for (const tree of TREES) {
  describe(`t-reuse-skip-needs-their-answer (${tree.name})`, () => {
    test("the reuse question the person never answered: the skip report shows it, and commits once they answer", () => {
      const proj = storeFromOtherWork(tree);
      asked(tree, proj);
      kept(tree, proj);
      const refused = run(tree, proj, "aidlc-log", ["answer", "--stage", STAGE, "--details", "Reuse existing knowledge base"]);
      expect(refused.status).not.toBe(0);

      const shown = skip(tree, proj);
      expect(shown.status, shown.out).toBe(0);
      const step = lastJson(shown.stdout);
      expect(step.kind).toBe("print");
      const message = String(step.message);
      expect(message).toContain(`Show it to them, word for word as it was asked, with its choices, and end your turn: ${JSON.stringify(QUESTION)}`);
      expect(message).toContain('"Reuse existing knowledge base", "Full rescan", "Focused scan"');
      // The skip is the way on only after a keep; a scan answer carries on with the scan.
      expect(message).toContain(`if they chose to keep the existing knowledge base, run the same skip report again: \`bun ${tree.tools}/tools/aidlc-orchestrate.ts report --stage ${STAGE} --result skipped`);
      expect(message).toContain(`if they chose a scan, carry on with "${STAGE}"'s scan from where you asked.`);
      expect(message).not.toContain("again, word for word");
      nothingSkipped(proj);

      says(tree, proj, "reuse it");
      const answered = run(tree, proj, "aidlc-log", ["answer", "--stage", STAGE, "--details", "Reuse existing knowledge base"]);
      expect(answered.status, answered.out).toBe(0);
      const committed = skip(tree, proj);
      expect(committed.status, committed.out).toBe(0);
      expect(lastJson(committed.stdout)).toMatchObject({ kind: "done" });
      expect(auditBlockField(rows(proj, "STAGE_SKIPPED").at(-1)!.block, "Reason")).toBe(REUSE_REASON);
    });

    test("a reuse skip with no question on record: the step says how to record theirs, and nothing is skipped", () => {
      const proj = storeFromOtherWork(tree);
      kept(tree, proj);
      const refused = skip(tree, proj);
      const step = lastJson(refused.stdout);
      expect(step.kind).toBe("error");
      expect(String(step.message)).toContain(`\`bun ${tree.tools}/tools/aidlc-log.ts decision\``);
      expect(String(step.message)).toContain(`\`bun ${tree.tools}/tools/aidlc-log.ts answer\``);
      expect(String(step.message)).toContain(`if they chose a scan, carry on with "${STAGE}"'s scan from where you asked.`);
      nothingSkipped(proj);
    });

    test("an answer the person left to the agent (you pick) lets the reuse skip commit", () => {
      const proj = storeFromOtherWork(tree);
      says(tree, proj, "you pick, whatever is quicker");
      asked(tree, proj);
      kept(tree, proj);
      const answered = run(tree, proj, "aidlc-log", [
        "answer", "--stage", STAGE, "--details", "Reuse existing knowledge base", "--on-instruction",
      ]);
      expect(answered.status, answered.out).toBe(0);
      expect(lastJson(skip(tree, proj).stdout)).toMatchObject({ kind: "done" });
      expect(rows(proj, "STAGE_SKIPPED")).toHaveLength(1);
    });
  });
}

describe("t-reuse-skip-needs-their-answer: what stays as it was", () => {
  const tree = TREES[0];

  test("every repository reused with one question still open: that question is shown", () => {
    const proj = storeFromOtherWork(tree, ["repo-a", "repo-b"]);
    says(tree, proj, "reuse repo-a");
    asked(tree, proj, "repo-a");
    expect(run(tree, proj, "aidlc-log", ["answer", "--stage", STAGE, "--details", "Reuse existing knowledge base"]).status).toBe(0);
    kept(tree, proj, "repo-a");
    asked(tree, proj, "repo-b");
    kept(tree, proj, "repo-b");
    const step = lastJson(skip(tree, proj).stdout);
    expect(step.kind).toBe("print");
    expect(String(step.message)).toContain(JSON.stringify(`${QUESTION} (repo-b)`));
    nothingSkipped(proj);
  });

  test("a skip that rests on no reuse commits as before", () => {
    const proj = storeFromOtherWork(tree);
    const done = run(tree, proj, "aidlc", ["engine", "orchestrate", "report", "--stage", STAGE, "--result", "skipped", "--reason", "not brownfield"]);
    expect(lastJson(done.stdout)).toMatchObject({ kind: "done" });
    expect(rows(proj, "STAGE_SKIPPED")).toHaveLength(1);
  });

  test("an unattended run commits the reuse skip as before", () => {
    const proj = storeFromOtherWork(tree);
    kept(tree, proj);
    expect(lastJson(skip(tree, proj, { AIDLC_UNATTENDED: "1" }).stdout)).toMatchObject({ kind: "done" });
    expect(rows(proj, "STAGE_SKIPPED")).toHaveLength(1);
  });

  test("the person's own skip of the stage commits through its own step", () => {
    const proj = storeFromOtherWork(tree);
    asked(tree, proj);
    kept(tree, proj);
    says(tree, proj, "just skip reverse engineering");
    const named = run(tree, proj, "aidlc", ["engine", "orchestrate", "next", "--skip", STAGE]);
    const report = `report --stage ${STAGE} --result skipped --reason 'the person asked to skip it'`;
    expect(String(lastJson(named.stdout).message)).toContain(report);
    const own = run(tree, proj, "aidlc", [
      "engine", "orchestrate", "report", "--stage", STAGE, "--result", "skipped", "--reason", "the person asked to skip it",
    ]);
    expect(lastJson(own.stdout)).toMatchObject({ kind: "done" });
    expect(auditBlockField(rows(proj, "STAGE_SKIPPED").at(-1)!.block, "Reason")).toBe("the person asked to skip it");
  });
});
