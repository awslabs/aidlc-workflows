// covers: function:ownTitleLine, function:withOwnTitleLine, function:instructionFileDoctorCheck
//
// Earlier releases opened Claude Code's .claude/CLAUDE.md, and AI-DLC's part of
// Copilot's AGENTS.md, with "# Project Name <!-- Replace with your project
// name -->", in a file AI-DLC rewrites on every refresh. Doing what it asked
// made every later refresh a conflict (#2058). Now the title is AI-DLC's own,
// with one line on where the project's notes go; a line the person wrote in
// its place is kept, the rest refreshes, and doctor has nothing to say. Any
// other change is still the person's to resolve, as before.

import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";
import { afterEach, describe, expect, test, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO_ROOT } from "../harness/fixtures.ts";
import { HARNESS_MATRIX } from "../harness/harness-matrix.ts";
import { instructionFileDoctorCheck } from "../../core/tools/aidlc-config-diagnostics.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const BUN = process.execPath;
const INIT = join(REPO_ROOT, "core", "tools", "aidlc-init.ts");
const PLACEHOLDER = "# Project Name <!-- Replace with your project name -->";
const TITLE = "# AI-DLC";
const NOTES_LINE =
  "Your project's name, notes and rules go in `aidlc/spaces/default/memory/project.md`. Every AI tool in this project reads it.";

// `onboarding[0]` is the project's file; `shipped` is the release text config
// writes into it (for Copilot, the part it keeps in root-blocks).
const TOOLS = [
  {
    harness: "claude",
    product: "Claude Code",
    harnessDir: ".claude",
    onboarding: [".claude/CLAUDE.md"],
    shipped: ".claude/CLAUDE.md",
  },
  {
    harness: "copilot",
    product: "GitHub Copilot",
    harnessDir: ".aidlc",
    onboarding: ["AGENTS.md", ".aidlc/tools/data/root-blocks/agents"],
    shipped: ".aidlc/tools/data/root-blocks/agents",
  },
] as const;
type Tool = (typeof TOOLS)[number];

const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
}, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

function temp(prefix: string): string {
  const path = mkdtempSync(join(realpathSync(tmpdir()), prefix));
  temporary.push(path);
  return path;
}

function config(project: string, from: string, harness: string, ...extra: string[]): { status: number; out: string } {
  // Keep the host's AI-DLC install out of it.
  const machine = temp("aidlc-t-title-machine-");
  const result = spawnSync(
    BUN,
    [INIT, "config", "--project-dir", project, "--from", from, "--harness", harness, "--mcp", "none", ...extra],
    {
      cwd: project,
      env: { ...process.env, AIDLC_INSTALL_ROOT: join(machine, "share", "aidlc"), AIDLC_BIN_DIR: join(machine, "bin") },
      encoding: "utf-8",
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    },
  );
  if (result.error) throw result.error;
  return { status: result.status ?? -1, out: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

function release(tool: Tool): string {
  return join(REPO_ROOT, "dist-release", tool.harness);
}

// Every line equal to `from` becomes `to`.
function swapLine(text: string, from: string, to: string): string {
  return text.split("\n").map((line) => (line === from ? to : line)).join("\n");
}

// An earlier release of this tool: today's files, with the onboarding opening
// the way earlier releases did (the placeholder title and no notes line).
function earlierRelease(tool: Tool): string {
  const earlier = join(temp(`aidlc-t-title-${tool.harness}-earlier-`), tool.harness);
  cpSync(release(tool), earlier, { recursive: true });
  for (const rel of tool.onboarding) {
    const path = join(earlier, rel);
    writeFileSync(path, readFileSync(path, "utf-8").replace(`${TITLE}\n\n${NOTES_LINE}\n\n`, `${PLACEHOLDER}\n\n`));
  }
  return earlier;
}

function install(tool: Tool, from: string): string {
  const project = temp(`aidlc-t-title-${tool.harness}-`);
  mkdirSync(join(project, ".git"));
  const installed = config(project, from, tool.harness, "--yes");
  expect(installed.status, installed.out).toBe(0);
  return project;
}

// AI-DLC's text in the person's file: the whole file, or its part of AGENTS.md.
function aidlcText(tool: Tool, text: string): string {
  if (tool.harness === "claude") return text;
  return text.slice(text.indexOf("<!-- BEGIN AI-DLC:agents -->"), text.indexOf("<!-- END AI-DLC:agents -->"));
}

function shippedText(tool: Tool): string {
  const text = readFileSync(join(release(tool), tool.shipped), "utf-8");
  return tool.harness === "claude" ? text : `<!-- BEGIN AI-DLC:agents -->\n${text.trim()}\n<!-- END AI-DLC:agents -->`;
}

describe("the onboarding's title line", () => {
  test("ships as AI-DLC's own title, with the line saying where the project's notes go", () => {
    for (const harness of HARNESS_MATRIX) {
      for (const root of ["dist", "dist-release"]) {
        for (const rel of [harness.onboardingDist, harness.harnessOnboardingDist]) {
          const path = join(REPO_ROOT, root, rel.slice(join(REPO_ROOT, "dist").length + 1));
          expect(readFileSync(path, "utf-8"), path).not.toContain("Replace with your project name");
        }
      }
    }
    for (const tool of TOOLS) {
      for (const root of ["dist", "dist-release"]) {
        for (const rel of tool.onboarding) {
          const text = readFileSync(join(REPO_ROOT, root, tool.harness, rel), "utf-8");
          expect(text, `${root}/${tool.harness}/${rel}`).toContain(`${TITLE}\n\n${NOTES_LINE}\n\n`);
          expect(text.split("\n"), `${root}/${tool.harness}/${rel}`).toContain(TITLE);
        }
      }
    }
  });

  test("a replaced title in a clone with Windows line endings refreshes the same way", () => {
    const tool = TOOLS[0];
    const project = install(tool, earlierRelease(tool));
    const file = join(project, tool.onboarding[0]);
    writeFileSync(file, swapLine(readFileSync(file, "utf-8"), PLACEHOLDER, "# Demo Project").replaceAll("\n", "\r\n"));
    expect(instructionFileDoctorCheck(project, tool.harnessDir).pass).toBe(true);
    const refreshed = config(project, release(tool), tool.harness, "--yes");
    expect(refreshed.status, refreshed.out).toBe(0);
    expect(readFileSync(file, "utf-8").replaceAll("\r\n", "\n")).toBe(swapLine(shippedText(tool), TITLE, "# Demo Project"));
  });

  for (const tool of TOOLS) {
    test(`${tool.product}: a project that replaced the earlier title refreshes, keeping its line`, () => {
      const project = install(tool, earlierRelease(tool));
      const file = join(project, tool.onboarding[0]);
      const original = readFileSync(file, "utf-8");
      writeFileSync(file, swapLine(original, PLACEHOLDER, "# Demo Project"));
      const edited = readFileSync(file, "utf-8");
      expect(edited).not.toBe(original);
      expect(instructionFileDoctorCheck(project, tool.harnessDir).pass).toBe(true);

      const planned = config(project, release(tool), tool.harness, "--dry-run");
      expect(planned.status, planned.out).toBe(0);
      expect(planned.out).not.toContain("conflict(s)");
      expect(readFileSync(file, "utf-8")).toBe(edited);

      const refreshed = config(project, release(tool), tool.harness, "--yes");
      expect(refreshed.status, refreshed.out).toBe(0);
      const kept = swapLine(shippedText(tool), TITLE, "# Demo Project");
      expect(aidlcText(tool, readFileSync(file, "utf-8"))).toBe(aidlcText(tool, kept));
      expect(instructionFileDoctorCheck(project, tool.harnessDir).pass).toBe(true);

      // Later refreshes keep it, and so does a second rename.
      const again = config(project, release(tool), tool.harness, "--yes");
      expect(again.status, again.out).toBe(0);
      expect(aidlcText(tool, readFileSync(file, "utf-8"))).toBe(aidlcText(tool, kept));
      writeFileSync(file, swapLine(readFileSync(file, "utf-8"), "# Demo Project", "# Demo Shop"));
      expect(instructionFileDoctorCheck(project, tool.harnessDir).pass).toBe(true);
      const renamed = config(project, release(tool), tool.harness, "--yes");
      expect(renamed.status, renamed.out).toBe(0);
      expect(aidlcText(tool, readFileSync(file, "utf-8"))).toBe(aidlcText(tool, swapLine(kept, "# Demo Project", "# Demo Shop")));
    });

    test(`${tool.product}: a title replaced on this release is no conflict either`, () => {
      const project = install(tool, release(tool));
      const file = join(project, tool.onboarding[0]);
      const original = readFileSync(file, "utf-8");
      writeFileSync(file, swapLine(original, TITLE, "# Demo Project"));
      const edited = readFileSync(file, "utf-8");
      expect(edited).not.toBe(original);
      expect(instructionFileDoctorCheck(project, tool.harnessDir).pass).toBe(true);
      const refreshed = config(project, release(tool), tool.harness, "--yes");
      expect(refreshed.status, refreshed.out).toBe(0);
      expect(aidlcText(tool, readFileSync(file, "utf-8"))).toBe(
        aidlcText(tool, swapLine(shippedText(tool), TITLE, "# Demo Project")),
      );
    });

    test(`${tool.product}: any other change is still the person's to resolve`, () => {
      const project = install(tool, earlierRelease(tool));
      const file = join(project, tool.onboarding[0]);
      const text = swapLine(readFileSync(file, "utf-8"), PLACEHOLDER, "# Demo Project");
      writeFileSync(
        file,
        tool.harness === "claude"
          ? `${text}\nUse pnpm, never npm.\n`
          : text.replace("<!-- END AI-DLC:agents -->", "Use pnpm, never npm.\n<!-- END AI-DLC:agents -->"),
      );
      const edited = readFileSync(file, "utf-8");
      const doctor = instructionFileDoctorCheck(project, tool.harnessDir);
      expect(doctor.pass).toBe(false);
      expect(doctor.label).toContain("hand-modified - conflict");
      const refused = config(project, release(tool), tool.harness, "--yes");
      expect(refused.status, refused.out).toBe(4);
      expect(refused.out).toContain(`${tool.onboarding[0]} (`);
      expect(readFileSync(file, "utf-8")).toBe(edited);
    });
  }
});
