import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  reviewUiProjectId,
  writeServerInfo,
} from "../../core/tools/aidlc-review-ui-shared.ts";
import {
  cleanupTestProject,
  createTestProject,
  FIXTURES_DIR,
  runOrchestrateNext,
  seedAidlcMemory,
  seedStateFile,
  seededRecordDir,
} from "../harness/fixtures.ts";

const BUN = process.execPath;
const ROOT = join(import.meta.dir, "..", "..");
const ORCHESTRATE = join(ROOT, "core", "tools", "aidlc-orchestrate.ts");
const projects: string[] = [];
const homes: string[] = [];

afterAll(() => {
  for (const project of projects) cleanupTestProject(project);
  for (const home of homes) rmSync(home, { recursive: true, force: true });
});

function fixture(): { project: string; home: string; env: NodeJS.ProcessEnv; stageDir: string } {
  const project = createTestProject();
  const home = mkdtempSync(join(tmpdir(), "aidlc-t335-"));
  projects.push(project);
  homes.push(home);
  seedAidlcMemory(project);
  seedStateFile(project, join(FIXTURES_DIR, "state-mid-ideation.md"));
  const stageDir = join(seededRecordDir(project), "ideation", "feasibility");
  mkdirSync(stageDir, { recursive: true });
  writeFileSync(join(stageDir, "feasibility-assessment.md"), "# assessment\nalpha\n");
  writeFileSync(join(stageDir, "constraint-register.md"), "# constraints\nbeta\n");
  writeFileSync(join(stageDir, "raid-log.md"), "# raid\ngamma\n");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    AIDLC_RUNTIME_HARNESS_ROOT: join(ROOT, "dist", "claude", ".claude"),
    AIDLC_REVIEW_UI: "1",
    AIDLC_REVIEW_HOME: home,
    AIDLC_SKIP_ARTIFACT_GUARD: "1",
    AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "1",
    AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD: "1",
  };
  return { project, home, env, stageDir };
}

function report(project: string, env: NodeJS.ProcessEnv, args: string[]): Record<string, unknown> {
  const result = Bun.spawnSync({
    cmd: [BUN, ORCHESTRATE, "report", ...args, "--project-dir", project],
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode, new TextDecoder().decode(result.stderr)).toBe(0);
  const output = JSON.parse(new TextDecoder().decode(result.stdout).trim()) as Record<string, unknown>;
  expect(output.kind, String(output.message ?? "")).not.toBe("error");
  return output;
}

function server(project: string, env: NodeJS.ProcessEnv, heartbeat: string): void {
  const now = new Date().toISOString();
  writeServerInfo({
    version: 1,
    pid: process.pid,
    host: "127.0.0.1",
    port: 43123,
    url: "http://127.0.0.1:43123/",
    token: "t335-token",
    project_dir: project,
    project_id: reviewUiProjectId(project),
    started_at: now,
    heartbeat_at: heartbeat,
    idle_minutes: 240,
  }, env);
}

describe("review UI manifest and directive publication", () => {
  test("awaiting and revised gates publish resolved manifests, snapshots, and pointers", () => {
    const { project, env, stageDir } = fixture();
    report(project, env, ["--stage", "feasibility", "--result", "awaiting-approval"]);
    const review = join(stageDir, ".review-ui");
    const manifest = JSON.parse(readFileSync(join(review, "manifest.json"), "utf-8"));
    expect(manifest.revision).toBe(0);
    expect(manifest.artifacts).toHaveLength(4);
    // Kinds come from the artifact vocabulary: prose deliverables are
    // `document`, the questions form is `machine` (never HTML-capable).
    for (const artifact of manifest.artifacts) {
      expect(artifact.format).toBe("md");
      expect(artifact.kind).toBe(artifact.name === "feasibility-questions" ? "machine" : "document");
    }
    const existing = manifest.artifacts.find((artifact: { name: string }) => artifact.name === "feasibility-assessment");
    expect(existing.sha256).toBe(createHash("sha256").update(readFileSync(join(stageDir, "feasibility-assessment.md"))).digest("hex"));
    const missing = manifest.artifacts.find((artifact: { name: string }) => artifact.name === "feasibility-questions");
    expect(missing).toMatchObject({ exists: false, sha256: null });
    expect(readFileSync(join(review, "snapshots", "r0", "feasibility-assessment.md"))).toEqual(
      readFileSync(join(stageDir, "feasibility-assessment.md")),
    );
    const pointer = JSON.parse(readFileSync(join(seededRecordDir(project), ".review-ui", "current.json"), "utf-8"));
    expect(pointer.stage_dir).toBe(
      `aidlc/spaces/default/intents/${seededRecordDir(project).split("/").pop()}/ideation/feasibility`,
    );

    report(project, env, ["--result", "rejected", "--reason", "change it"]);
    writeFileSync(join(stageDir, "feasibility-assessment.md"), "# assessment\nrevision one\n");
    report(project, env, ["--result", "revised"]);
    expect(JSON.parse(readFileSync(join(review, "manifest.json"), "utf-8")).revision).toBe(1);
    expect(readFileSync(join(review, "snapshots", "r1", "feasibility-assessment.md"), "utf-8")).toContain("revision one");
  }, 30_000);

  test("run-stage and report output expose only a live stored open link", () => {
    const { project, env } = fixture();
    server(project, env, new Date().toISOString());
    const before = runOrchestrateNext(ORCHESTRATE, project, [], { env }).directive;
    expect(before?.review_ui).toEqual({ origin: "http://127.0.0.1:43123/" });

    const opened = report(project, env, ["--stage", "feasibility", "--result", "awaiting-approval"]);
    expect((opened.review_ui as { origin: string }).origin).toBe("http://127.0.0.1:43123/");
    expect((opened.review_ui as { url: string }).url).toMatch(/^http:\/\/127\.0\.0\.1:43123\/open\/[0-9a-f]{32}$/);
    const after = runOrchestrateNext(ORCHESTRATE, project, [], { env }).directive;
    expect((after?.review_ui as { url: string }).url).toBe((opened.review_ui as { url: string }).url);

    const stale = { ...env };
    server(project, stale, new Date(Date.now() - 10 * 60_000).toISOString());
    const staleDirective = runOrchestrateNext(ORCHESTRATE, project, [], { env: stale }).directive;
    expect(staleDirective?.review_ui).toBeUndefined();
  }, 30_000);
});
