// covers: function:registeredRepoDoctorChecks

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  collectDoctorReport,
  registeredRepoDoctorChecks,
} from "../../dist/claude/.claude/tools/aidlc-utility.ts";
import {
  cleanupTestProject,
  createTestProject,
  seedStateFile,
  seedWorkspaceShell,
} from "../harness/fixtures.ts";

const projects: string[] = [];

function projectWithRepos(repos: string[]): string {
  const project = createTestProject();
  projects.push(project);
  seedWorkspaceShell(project);
  seedStateFile(project, "state-mid-ideation.md");
  const registry = join(project, "aidlc", "spaces", "default", "intents", "intents.json");
  const rows = JSON.parse(readFileSync(registry, "utf-8")) as Array<Record<string, unknown>>;
  writeFileSync(registry, `${JSON.stringify(rows.map((row) => ({ ...row, repos })), null, 2)}\n`);
  return project;
}

function repoCheckout(project: string, name: string): void {
  mkdirSync(join(project, name, ".git"), { recursive: true });
}

afterEach(() => {
  for (const project of projects.splice(0)) cleanupTestProject(project);
});

describe("registeredRepoDoctorChecks", () => {
  test("names a registered repo that has no folder in the workspace", () => {
    const rows = registeredRepoDoctorChecks(projectWithRepos(["api"]));
    expect(rows).toHaveLength(1);
    expect(rows[0].pass).toBe(false);
    expect(rows[0].severity).toBe("warn");
    expect(rows[0].label).toContain('Registered repo "api" has no folder in the workspace');
    expect(rows[0].label).toContain("analyse the whole workspace under its name");
    expect(rows[0].fix).toContain('restore or clone "api" into the workspace folder');
    expect(rows[0].fix).toContain("engine intent remove-repo api");
  });

  test("says nothing for a folder that is there without .git: Reverse Engineering reads that folder", () => {
    const project = projectWithRepos(["api"]);
    mkdirSync(join(project, "api"));
    expect(registeredRepoDoctorChecks(project)).toEqual([]);
  });

  test("says nothing once the repo is a checkout there", () => {
    const project = projectWithRepos(["api"]);
    repoCheckout(project, "api");
    expect(registeredRepoDoctorChecks(project)).toEqual([]);
  });

  test("says nothing for an intent that records no repos", () => {
    expect(registeredRepoDoctorChecks(projectWithRepos([]))).toEqual([]);
  });

  test("the doctor report carries the row, as a warning that does not fail the run", async () => {
    const project = projectWithRepos(["api"]);
    const report = await collectDoctorReport(project);
    const row = report.checks.find((candidate) =>
      candidate.label.startsWith('Registered repo "api" has no folder in the workspace'));
    expect(row).toBeDefined();
    expect(row?.pass).toBe(false);
    expect(row?.severity).toBe("warn");
    expect(report.checks.some((candidate) => candidate.pass === false && candidate.severity === undefined &&
      candidate.label.startsWith("Registered repo"))).toBe(false);
  });
});
