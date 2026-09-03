import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  cleanupTestProject,
  createTestProject,
  FIXTURES_DIR,
  runOrchestrateNext,
  seedAidlcMemory,
  seededRecordDir,
  seededStateFile,
  seedStateFile,
} from "../harness/fixtures.ts";
import { tmpdir } from "node:os";
import { compileStageGraph } from "../../core/tools/aidlc-graph.ts";

const ROOT = join(import.meta.dir, "..", "..");
const ORCHESTRATE = join(ROOT, "core", "tools", "aidlc-orchestrate.ts");
const projects: string[] = [];
let graphHome = "";
let graphPath = "";

const env: NodeJS.ProcessEnv = {
  ...process.env,
  AIDLC_HARNESS_DIR: ".claude",
  AIDLC_RUNTIME_HARNESS_ROOT: join(ROOT, "dist", "claude", ".claude"),
  AIDLC_SKIP_ARTIFACT_GUARD: "1",
  AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "1",
  AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD: "1",
};

beforeAll(() => {
  graphHome = mkdtempSync(join(tmpdir(), "aidlc-t347-"));
  graphPath = join(graphHome, "stage-graph.json");
  const previousRoot = process.env.AIDLC_RUNTIME_HARNESS_ROOT;
  process.env.AIDLC_RUNTIME_HARNESS_ROOT = env.AIDLC_RUNTIME_HARNESS_ROOT;
  try {
    writeFileSync(graphPath, compileStageGraph().json);
  } finally {
    if (previousRoot === undefined) delete process.env.AIDLC_RUNTIME_HARNESS_ROOT;
    else process.env.AIDLC_RUNTIME_HARNESS_ROOT = previousRoot;
  }
});

afterAll(() => {
  for (const project of projects) cleanupTestProject(project);
  if (graphHome) rmSync(graphHome, { recursive: true, force: true });
});

function fixture(html: "on" | "off" | "absent"): string {
  const project = createTestProject();
  projects.push(project);
  seedAidlcMemory(project);
  seedStateFile(project, join(FIXTURES_DIR, "state-mid-ideation.md"));
  if (html !== "absent") {
    const path = seededStateFile(project);
    const state = readFileSync(path, "utf-8").replace(
      "- **Test Strategy**: Standard",
      `- **Test Strategy**: Standard\n- **HTML Artifacts**: ${html}`,
    );
    writeFileSync(path, state);
  }

  const input = join(
    seededRecordDir(project),
    "ideation",
    "intent-capture",
    `intent-statement.${html === "on" ? "html" : "md"}`,
  );
  mkdirSync(dirname(input), { recursive: true });
  writeFileSync(input, html === "on" ? "<!doctype html><p>intent</p>\n" : "# Intent\n");
  return project;
}

function directive(project: string): Record<string, unknown> {
  const result = runOrchestrateNext(ORCHESTRATE, project, [], {
    env: { ...env, AIDLC_STAGE_GRAPH: graphPath },
  });
  expect(result.status, result.stderr).toBe(0);
  expect(result.directive?.kind).toBe("run-stage");
  return result.directive!;
}

function allArtifactEntries(d: Record<string, unknown>): unknown[] {
  return [
    ...((d.consumes as unknown[]) ?? []),
    ...((d.produces as unknown[]) ?? []),
  ];
}

describe("HTML artifact directive format", () => {
  test("HTML-on emits the protocol and enriched HTML consume/produce entries", () => {
    const d = directive(fixture("on"));
    expect(d.protocol_modules).toContain("html");

    const consumes = d.consumes as Array<string | Record<string, string>>;
    const htmlConsume = consumes.find(
      (entry): entry is Record<string, string> =>
        typeof entry === "object" && entry.format === "html",
    );
    expect(htmlConsume).toBeDefined();
    expect(htmlConsume!.path).toEndWith(
      "/ideation/intent-capture/intent-statement.html",
    );
    expect(htmlConsume!.text_command).toBe(
      `bun .claude/tools/aidlc-html.ts text ${htmlConsume!.path}`,
    );

    const produces = d.produces as Array<string | Record<string, string>>;
    for (const suffix of [
      "/ideation/feasibility/feasibility-assessment.html",
      "/ideation/feasibility/constraint-register.html",
      "/ideation/feasibility/raid-log.html",
    ]) {
      expect(produces.some((entry) =>
        typeof entry === "object" &&
        entry.format === "html" &&
        entry.path.endsWith(suffix)
      )).toBe(true);
    }
    expect(produces.some((entry) =>
      typeof entry === "string" && entry.endsWith("/feasibility-questions.md")
    )).toBe(true);
    expect(produces.every((entry) =>
      typeof entry === "string" || !("text_command" in entry)
    )).toBe(true);
  });

  for (const setting of ["off", "absent"] as const) {
    test(`HTML-${setting} preserves the legacy Markdown wire shape`, () => {
      const d = directive(fixture(setting));
      expect((d.protocol_modules as string[] | undefined) ?? []).not.toContain("html");
      const entries = allArtifactEntries(d);
      expect(entries.length).toBeGreaterThan(0);
      expect(entries.every((entry) => typeof entry === "string")).toBe(true);
      expect(JSON.stringify(d)).not.toContain("text_command");
      expect(entries.some((entry) =>
        typeof entry === "string" &&
        entry.endsWith("/ideation/intent-capture/intent-statement.md")
      )).toBe(true);
      expect(entries.some((entry) =>
        typeof entry === "string" &&
        entry.endsWith("/ideation/feasibility/feasibility-assessment.md")
      )).toBe(true);
    });
  }
});
