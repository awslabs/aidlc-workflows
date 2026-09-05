import { afterAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderFeedbackMarkdown } from "../../core/tools/aidlc-review-ui-render.ts";
import { parseFeedbackFile } from "../../core/tools/aidlc-review-ui-shared.ts";
import {
  cleanupTestProject,
  createTestProject,
  FIXTURES_DIR,
  seedStateFile,
  seededAuditDir,
  seededRecordDir,
} from "../harness/fixtures.ts";

const BUN = process.execPath;
const ROOT = join(import.meta.dir, "..", "..");
const ORCHESTRATE = join(ROOT, "core", "tools", "aidlc-orchestrate.ts");
const projects: string[] = [];
const homes: string[] = [];
const responseDirs: string[] = [];

afterAll(() => {
  for (const project of projects) cleanupTestProject(project);
  for (const home of homes) rmSync(home, { recursive: true, force: true });
  for (const dir of responseDirs) rmSync(dir, { recursive: true, force: true });
});

function fixture(): {
  project: string;
  env: NodeJS.ProcessEnv;
  stageDir: string;
} {
  const project = createTestProject();
  const home = mkdtempSync(join(tmpdir(), "aidlc-t361-home-"));
  projects.push(project);
  homes.push(home);
  seedStateFile(project, join(FIXTURES_DIR, "state-mid-ideation.md"));
  const stageDir = join(seededRecordDir(project), "ideation", "feasibility");
  mkdirSync(stageDir, { recursive: true });
  for (const name of [
    "feasibility-assessment.md",
    "constraint-register.md",
    "raid-log.md",
    "feasibility-questions.md",
  ]) {
    writeFileSync(join(stageDir, name), `# ${name}\n`);
  }
  return {
    project,
    stageDir,
    env: {
      ...process.env,
      AIDLC_RUNTIME_HARNESS_ROOT: join(ROOT, "dist", "claude", ".claude"),
      AIDLC_REVIEW_HOME: home,
      AIDLC_REVIEW_UI: "1",
      AIDLC_SKIP_ARTIFACT_GUARD: "1",
      AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "1",
      AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD: "1",
    },
  };
}

interface RunResult {
  exitCode: number;
  output: Record<string, unknown>;
}

function run(
  project: string,
  env: NodeJS.ProcessEnv,
  args: string[],
): RunResult {
  const result = Bun.spawnSync({
    cmd: [BUN, ORCHESTRATE, "report", ...args, "--project-dir", project],
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = new TextDecoder().decode(result.stdout).trim();
  return {
    exitCode: result.exitCode,
    output: JSON.parse(stdout) as Record<string, unknown>,
  };
}

function expectSuccess(result: RunResult): void {
  expect(result.output.kind, String(result.output.message ?? "")).not.toBe("error");
}

function audit(project: string): string {
  if (!existsSync(seededAuditDir(project))) return "";
  return Array.from(new Bun.Glob("*.md").scanSync(seededAuditDir(project)))
    .map((file) => readFileSync(join(seededAuditDir(project), file), "utf-8"))
    .join("\n");
}

function writeFeedback(stageDir: string): string {
  const markdown = renderFeedbackMarkdown(
    {
      stage: "feasibility",
      unit: null,
      revision: 0,
      decision_hint: "request-changes",
      annotations: [
        {
          id: "a3",
          artifact: "feasibility-assessment.md",
          kind: "comment",
          heading_path: ["Cost"],
          selection: "Monthly total",
          body: "Show the assumptions.",
        },
        {
          id: "a3",
          artifact: "feasibility-assessment.md",
          kind: "delete",
          heading_path: ["Risks"],
          selection: "Duplicated risk",
        },
        {
          id: "a8",
          artifact: "constraint-register.md",
          kind: "looks-good",
          heading_path: [],
        },
      ],
    },
    { created: "2026-09-05T10:00:00Z" },
  );
  const dir = join(stageDir, ".review-ui");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "feedback-001.md"), markdown);
  return markdown;
}

function responseSource(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "aidlc-t361-responses-"));
  const path = join(dir, "responses.md");
  responseDirs.push(dir);
  writeFileSync(path, body);
  return path;
}

describe("review UI feedback responses", () => {
  test("serializer assigns stable unique ids and feedback parsing exposes remarks", () => {
    const markdown = writeFeedback(fixture().stageDir);
    expect(markdown).toContain("### Comment · a1 — Cost");
    expect(markdown).toContain("### Delete · a2 — Risks");
    expect(markdown).toContain("### Looks good · a8");

    const parsed = parseFeedbackFile("feedback-001.md", markdown);
    expect(parsed?.body).toBe(markdown.slice(markdown.indexOf("# Review feedback:")));
    expect(parsed?.remarks).toEqual([
      { id: "a1", kind: "comment", heading: "Cost", quote: "Monthly total" },
      { id: "a2", kind: "delete", heading: "Risks", quote: "Duplicated risk" },
      { id: "a8", kind: "looks-good", heading: "" },
    ]);
  });

  test("report revised copies valid responses and appends the response audit row", () => {
    const { project, env, stageDir } = fixture();
    expectSuccess(run(project, env, ["--stage", "feasibility", "--result", "awaiting-approval"]));
    writeFeedback(stageDir);
    expectSuccess(run(project, env, [
      "--stage",
      "feasibility",
      "--result",
      "rejected",
      "--user-input",
      "Request Changes",
      "--reason",
      "Address the browser remarks.",
    ]));

    const body = [
      "# Feedback addressed: feasibility (revision 1)",
      "",
      "- a1: applied — Added the cost assumptions.",
      "- a2: kept — The risks differ by trigger.",
      "- a8: answered — Thank you.",
      "",
    ].join("\n");
    const source = responseSource(body);
    expectSuccess(run(project, env, [
      "--stage",
      "feasibility",
      "--result",
      "revised",
      "--responses",
      source,
    ]));

    const copied = join(stageDir, ".review-ui", "responses-001.md");
    expect(readFileSync(copied, "utf-8")).toBe(body);
    const log = audit(project);
    expect(log).toContain("**Event**: REVIEW_UI_RESPONSES");
    expect(log).toContain("**Stage**: feasibility");
    expect(log).toContain("**Revision**: 1");
    expect(log).toContain("**File**: responses-001.md");
    expect(log).toContain("**Remarks**: 3");
  }, 30_000);

  test("report revised refuses unknown remark ids before changing the gate", () => {
    const { project, env, stageDir } = fixture();
    expectSuccess(run(project, env, ["--stage", "feasibility", "--result", "awaiting-approval"]));
    writeFeedback(stageDir);
    expectSuccess(run(project, env, [
      "--stage",
      "feasibility",
      "--result",
      "rejected",
      "--user-input",
      "Request Changes",
      "--reason",
      "Address the browser remarks.",
    ]));
    const source = responseSource(
      "# Feedback addressed: feasibility (revision 1)\n\n- a999: applied — Changed it.\n",
    );
    const result = run(project, env, [
      "--stage",
      "feasibility",
      "--result",
      "revised",
      "--responses",
      source,
    ]);
    expect(result.output.kind).toBe("error");
    expect(result.output.message).toContain("unknown feedback remark id: a999");
    expect(readFileSync(join(seededRecordDir(project), "aidlc-state.md"), "utf-8"))
      .toContain("- [R] feasibility");
    expect(existsSync(join(stageDir, ".review-ui", "responses-001.md"))).toBe(false);
    expect(audit(project)).not.toContain("REVIEW_UI_RESPONSES");
  }, 30_000);
});
