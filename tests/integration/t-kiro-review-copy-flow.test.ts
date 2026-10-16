// covers: subcommand:aidlc-log:review, function:prepareReviewCopy, function:removeReviewCopy, function:reviewRequestNote, hook:aidlc-log-subagent
//
// The reviewer read-scope preview feature on Kiro (kiro-ide), end to end on an
// installed tree: a Unit's review request in a preview build, with the feature
// named in AIDLC_PREVIEW_FEATURES, writes a copy of the installed reviewer that
// carries the review's read scope and hands its name back; the completion Kiro
// reports under the copy's name is the reviewer's; the verdict removes the
// copy. In a stable build the same request is the request it was.
// Kiro itself is not driven here: that a delegated agent's fs_read deny with an
// exclude is enforced was measured on Kiro CLI 2.31.0 and Kiro IDE 1.3.0.

import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS } from "../harness/test-budget.ts";
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { auditBlockField, readAuditShardEvents } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  cleanupTestProject,
  createTestProject,
  REPO_ROOT,
  seedAidlcMemory,
  seedBoltDag,
  seededRecordDir,
  seededStateFile,
} from "../harness/fixtures.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const STAGE = "functional-design";
const UNIT = "alpha";
const REVIEWER = "aidlc-architecture-reviewer-agent";
const KIRO_IDE_TREE = join(REPO_ROOT, "dist", "kiro-ide", ".kiro");
const PREVIEW_VERSION = "2.11.0-preview.20261015.1";
const projects: string[] = [];

afterAll(() => {
  for (const project of projects) cleanupTestProject(project);
});

type Run = { code: number; stdout: string; stderr: string };
type Json = Record<string, unknown>;

function json(run: Run, context: string): Json {
  expect(run.code, `${context}\n${run.stdout}\n${run.stderr}`).toBe(0);
  return JSON.parse(run.stdout.trim().split("\n").at(-1)!) as Json;
}

class KiroUnitReview {
  readonly dir: string;
  readonly env: NodeJS.ProcessEnv;

  constructor(preview: boolean) {
    this.dir = createTestProject();
    projects.push(this.dir);
    seedAidlcMemory(this.dir);
    cpSync(KIRO_IDE_TREE, join(this.dir, ".kiro"), { recursive: true });
    if (preview) {
      // A preview build is the same tree with a preview version stamped in.
      const versionFile = join(this.dir, ".kiro", "tools", "aidlc-version.ts");
      writeFileSync(
        versionFile,
        readFileSync(versionFile, "utf-8").replace(/AIDLC_VERSION = "[^"]+"/, `AIDLC_VERSION = "${PREVIEW_VERSION}"`),
      );
    }
    this.env = { ...process.env, AIDLC_PROJECT_DIR: this.dir, AIDLC_PREVIEW_FEATURES: "reviewer-read-scope" };
    for (const key of ["AIDLC_HARNESS_DIR", "AIDLC_AGENTS_DIR", "AIDLC_HARNESS_NAME", "CLAUDE_PROJECT_DIR"]) {
      delete this.env[key];
    }
    writeFileSync(seededStateFile(this.dir), [
      "# AI-DLC State Tracking", "",
      "## Project Information",
      "- **Project**: Kiro reviewer copy",
      "- **Project Type**: Greenfield",
      "- **Scope**: feature",
      "- **State Version**: 8",
      "- **Skeleton Stance**: on", "",
      "## Runtime State",
      "- **Revision Count**: 0",
      "- **Construction Iteration**: unit-major", "",
      "## Scope Configuration",
      "- **Stages to Execute**: all",
      "- **Stages to Skip**: none",
      "- **Depth**: Standard",
      "- **Test Strategy**: Standard", "",
      "## Stage Progress", "",
      "### CONSTRUCTION PHASE",
      `- [-] ${STAGE} — EXECUTE`,
      "- [ ] code-generation — EXECUTE", "",
      "## Current Status",
      "- **Lifecycle Phase**: CONSTRUCTION",
      `- **Current Stage**: ${STAGE}`,
      "- **Status**: Running",
      "- **Last Updated**: 2026-10-15T00:00:00Z", "",
    ].join("\n"));
    seedBoltDag(this.dir, [UNIT, "beta"]);
    const stageDir = join(seededRecordDir(this.dir), "construction", UNIT, STAGE);
    mkdirSync(stageDir, { recursive: true });
    writeFileSync(join(stageDir, `${STAGE}-questions.md`), "# Questions\n\n[Answer]: Looks correct\n");
    for (const [name, body] of [
      ["entities.md", "# Entities\n\n```yaml\nentities: []\n```\n"],
      ["rules.md", "# Rules\n\n```yaml\nrules: []\n```\n"],
      ["functional-spec.md", "# Functional Spec\n\n## Workflows\n\nOnly the owner reads a note.\n"],
      ["traceability.json", '{"links":[]}\n'],
    ]) writeFileSync(join(stageDir, name), body);
  }

  run(argv: string[], input?: Json, env: NodeJS.ProcessEnv = {}): Run {
    const child = Bun.spawnSync(argv, {
      cwd: this.dir,
      env: { ...this.env, ...env },
      stdin: input === undefined ? "ignore" : Buffer.from(JSON.stringify(input)),
      stdout: "pipe",
      stderr: "pipe",
    });
    return { code: child.exitCode, stdout: child.stdout.toString(), stderr: child.stderr.toString() };
  }

  // As the conductor runs it: `{{INVOKE}} engine log review ...`.
  log(args: string[]): Run {
    return this.run([
      process.execPath, join(this.dir, ".kiro", "tools", "aidlc.ts"), "engine", "log", ...args, "--project-dir", this.dir,
    ]);
  }

  reviewArgs(...extra: string[]): string[] {
    return ["review", "--stage", STAGE, "--unit", UNIT, "--reviewer", REVIEWER, "--iteration", "1", ...extra];
  }

  // What the Kiro adapter receives when a dispatch returns.
  dispatched(name: string, response: string): Run {
    return this.run([process.execPath, join(this.dir, ".kiro", "hooks", "aidlc-kiro-adapter.ts"), "log-subagent"], {
      session_id: "sess_t-kiro-review-copy", hook_event_name: "PostToolUse", cwd: this.dir,
      tool_name: "invoke_sub_agent", tool_input: { name, prompt: "Review" }, tool_response: response,
    });
  }

  completions(): string[] {
    return readAuditShardEvents(this.dir).filter((row) => row.event === "SUBAGENT_COMPLETED").map((row) => row.block);
  }

  agents(): string[] {
    return readdirSync(join(this.dir, ".kiro", "agents")).sort();
  }
}

describe("the reviewer read-scope copy on Kiro (preview)", () => {
  test("a preview request writes the copy and names it; its completion is the reviewer's; the verdict removes it", () => {
    const p = new KiroUnitReview(true);
    const shippedAgents = p.agents();
    const requested = json(p.log(p.reviewArgs()), "Request the Unit's review");
    expect(requested.emitted).toBe("REVIEW_REQUESTED");
    const requestId = String(requested.requestId);
    const copyName = `aidlc-scoped-review-${requestId.slice("review:".length, "review:".length + 12)}`;
    expect(requested.dispatchAgent).toBe(copyName);
    expect(String(requested.agent_note)).toContain(`Dispatch ${copyName} (${REVIEWER} with this review's read scope`);
    expect(String(requested.agent_note)).toContain(`name ${REVIEWER} as the reviewer in the brief`);

    const copy = readFileSync(join(p.dir, ".kiro", "agents", `${copyName}.md`), "utf-8");
    expect(copy).toContain(`\nname: ${copyName}\n`);
    expect(copy).toContain('        - "aidlc/spaces/*/intents/*/construction/**"');
    // Only this intent's folder of the Unit is opened again.
    const record = relative(p.dir, seededRecordDir(p.dir)).split(sep).join("/");
    expect(copy).toContain(`        - "${record}/construction/${UNIT}/**"`);
    expect(copy).not.toContain(`"aidlc/spaces/*/intents/*/construction/${UNIT}`);
    expect(copy).not.toContain("construction/beta");
    expect(readFileSync(join(p.dir, ".kiro", "agents", `${REVIEWER}.md`), "utf-8"))
      .toBe(readFileSync(join(KIRO_IDE_TREE, "agents", `${REVIEWER}.md`), "utf-8"));
    expect(p.agents()).toEqual([...shippedAgents, `${copyName}.md`].sort());
    // AI-DLC's .gitignore block keeps the copy out of the person's commits.
    expect(readFileSync(join(KIRO_IDE_TREE, "..", ".gitignore"), "utf-8").split("\n")).toContain(".kiro/agents/aidlc-scoped-review-*.md");

    const reviewFile = resolve(p.dir, String(requested.reviewFile));
    mkdirSync(dirname(reviewFile), { recursive: true });
    writeFileSync(reviewFile, [
      "## Review", "", "**Verdict:** READY", `**Reviewer:** ${REVIEWER}`, "**Iteration:** 1",
      "**Verdict Dictated:** no", "", "### Findings", "", "**Prior findings**", "",
      "| ID | Now | Severity | Note |", "|---|---|---|---|", "", "**New findings**", "",
      "| Severity | Location | Finding | Required action |", "|---|---|---|---|", "",
    ].join("\n"));
    expect(p.dispatched(copyName, `**Reviewer:** ${REVIEWER}\n\nVerdict: READY`).code).toBe(0);
    const [completion] = p.completions();
    expect(auditBlockField(completion, "Agent Type")).toBe(REVIEWER);
    expect(auditBlockField(completion, "Dispatch Agent")).toBe(copyName);
    // The review file's digest is taken as the reviewer's, so the verdict reads it as the reviewer's review.
    expect(auditBlockField(completion, "Review File Digest")).toMatch(/=[0-9a-f]{64}$/);

    json(p.log(p.reviewArgs("--verdict", "READY")), "Record the reviewer's verdict");
    expect(existsSync(join(p.dir, ".kiro", "agents", `${copyName}.md`))).toBe(false);
    expect(p.agents()).toEqual(shippedAgents);
  });

  test("a dispatch Kiro cannot find is no completion, so the reviewer it falls back to finishes the review", () => {
    const p = new KiroUnitReview(true);
    const requested = json(p.log(p.reviewArgs()), "Request the Unit's review");
    const copyName = String(requested.dispatchAgent);
    expect(copyName).toMatch(/^aidlc-scoped-review-[0-9a-f]{12}$/);
    expect(p.dispatched(copyName, `Agent '${copyName}' not found in registry`).code).toBe(0);
    expect(p.completions()).toEqual([]);
    // The fallback is said where doctor looks: the scope the person turned on was not held.
    expect(readFileSync(join(seededRecordDir(p.dir), ".aidlc-engine", "hooks-health", "kiro-adapter.drops"), "utf-8"))
      .toContain(`Kiro has no agent named ${copyName}`);
    expect(p.dispatched(REVIEWER, `**Reviewer:** ${REVIEWER}\n\nVerdict: READY`).code).toBe(0);
    expect(p.completions().map((row) => auditBlockField(row, "Agent Type"))).toEqual([REVIEWER]);
  });

  test("a copy that cannot be written is said in one line, and the reviewer itself is dispatched", () => {
    const p = new KiroUnitReview(true);
    const reviewerFile = join(p.dir, ".kiro", "agents", `${REVIEWER}.md`);
    writeFileSync(reviewerFile, readFileSync(reviewerFile, "utf-8").replace(/\npermissions:\n/, "\nreviewer_permissions:\n"));
    const requested = json(p.log(p.reviewArgs()), "Request the Unit's review");
    expect(requested.dispatchAgent).toBeUndefined();
    expect(requested.change_notices).toEqual([
      `This review of ${UNIT} can read other Units' files: AI-DLC could not hold the reviewer to this Unit this time.`,
    ]);
    expect(String(requested.agent_note)).toStartWith(`Dispatch ${REVIEWER} as a subagent`);
    // Doctor lists a drop by its reason up to the first ": ", cut to 120 characters: the cause fits.
    const drops = readFileSync(join(seededRecordDir(p.dir), ".aidlc-engine", "hooks-health", "reviewer-scope.drops"), "utf-8");
    const shown = drops.trim().split("\t").at(-1)!.split(": ")[0];
    expect(shown).toBe("reviewer copy not written, a name is not plain or the reviewer file is not in the installed shape");
    expect(shown.length).toBeLessThanOrEqual(120);
  });

  test("a stable build's request is the request it was", () => {
    const p = new KiroUnitReview(false);
    const shippedAgents = p.agents();
    const requested = json(p.log(p.reviewArgs()), "Request the Unit's review");
    expect(requested.emitted).toBe("REVIEW_REQUESTED");
    expect(requested.dispatchAgent).toBeUndefined();
    expect(String(requested.agent_note)).toStartWith(`Dispatch ${REVIEWER} as a subagent and have it write`);
    expect(p.agents()).toEqual(shippedAgents);
  });
});
