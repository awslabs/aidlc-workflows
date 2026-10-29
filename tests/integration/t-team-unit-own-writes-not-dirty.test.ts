// covers: subcommand:aidlc-unit:publish, subcommand:aidlc-unit:land

// A checkout config never ran in (every fresh team clone) gets AI-DLC's part
// of .gitignore and AGENTS.md, and on opencode its entries in opencode.json,
// from the session-start hook (addRootBlocks). Publish and land used to refuse
// that tree as dirty, and agents then committed or stashed the files to get
// through. AI-DLC's own write no longer counts; a change of the person's still
// stops both with the same line as before, and neither commits nor stashes
// anything of theirs.

import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { addRootBlocks } from "../../dist/claude/.claude/tools/aidlc-includes.ts";
import { REPO_ROOT, seededStateFile } from "../harness/fixtures.ts";
import {
  UNIT,
  approveMerge,
  cleanupTempDirs,
  gateAndLand,
  git,
  makeSeed,
  prepareCandidate,
  runMergeTool,
} from "../harness/team-unit-merge.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);

afterEach(cleanupTempDirs);

const PUBLISH_REFUSAL = "Unit publication requires a clean tracked worktree; commit the candidate first.";
const TEAM_AGENTS = "# Team notes\n\nRun the tests before every push.\n";
const TEAM_OPENCODE = '{\n  "$schema": "https://opencode.ai/config.json",\n  "model": "team/model"\n}\n';

type Runtime = "copilot" | "opencode";
const ROOT_FILES: Record<Runtime, string[]> = {
  copilot: [".gitignore", "AGENTS.md"],
  opencode: [".gitignore", "AGENTS.md", "opencode.json"],
};

// The team committed AI-DLC's copy runtime (its projection data and the parts
// it ships for the root files) and its own AGENTS.md (and opencode.json), but
// never AI-DLC's part of them: no config ran in any checkout.
function seedWithRuntime(
  runtime: Runtime = "copilot",
  teamFiles = true,
): { seed: string; remote: string } {
  const { seed, remote } = makeSeed();
  const shipped = join(REPO_ROOT, "dist", runtime, ".aidlc", "tools", "data");
  const data = join(seed, ".aidlc", "tools", "data");
  mkdirSync(data, { recursive: true });
  for (const name of ["aidlc-stamp.json", "harness.json", "aidlc-projection.json", "root-blocks"]) {
    cpSync(join(shipped, name), join(data, name), { recursive: true });
  }
  if (teamFiles) {
    writeFileSync(join(seed, "AGENTS.md"), TEAM_AGENTS);
    if (runtime === "opencode") writeFileSync(join(seed, "opencode.json"), TEAM_OPENCODE);
  }
  git(seed, ["add", "-A"]);
  git(seed, ["commit", "-m", "team runtime"]);
  git(seed, ["push", "origin", "main"]);
  return { seed, remote };
}

// What the session-start hook writes when a chat opens in the checkout.
function sessionStarts(checkout: string, runtime: Runtime = "copilot"): void {
  expect(addRootBlocks(checkout).sort()).toEqual(ROOT_FILES[runtime]);
}

function bytes(checkout: string, path: string): string | null {
  const file = join(checkout, path);
  return existsSync(file) ? readFileSync(file, "utf-8") : null;
}

function snapshot(checkout: string, paths: readonly string[]): Record<string, string | null> {
  return Object.fromEntries(paths.map((path) => [path, bytes(checkout, path)]));
}

function stashes(checkout: string): string {
  return git(checkout, ["stash", "list"]);
}

function appendLine(checkout: string, path: string, line: string): void {
  writeFileSync(join(checkout, path), `${readFileSync(join(checkout, path), "utf-8")}${line}\n`);
}

describe("publish and land are not stopped by AI-DLC's own part of the root files", () => {
  for (const runtime of ["copilot", "opencode"] as const) {
    test(`a team clone whose only uncommitted change is AI-DLC's part publishes, and the files stay as they are (${runtime})`, () => {
      const { remote } = seedWithRuntime(runtime);
      let before: { head: string; files: Record<string, string | null> } | null = null;
      const { checkout, candidateOid } = prepareCandidate(remote, "alpha", "team-a", {
        beforePublish: (clone) => {
          sessionStarts(clone, runtime);
          before = { head: git(clone, ["rev-parse", "HEAD"]), files: snapshot(clone, ROOT_FILES[runtime]) };
        },
      });
      expect(before).not.toBeNull();
      expect(before!.files[".gitignore"]).toContain("# BEGIN AI-DLC:gitignore");
      expect(before!.files["AGENTS.md"]).toContain("<!-- BEGIN AI-DLC:agents -->");
      if (runtime === "opencode") expect(before!.files["opencode.json"]).toContain('"model": "team/model"');
      expect(git(checkout, ["rev-parse", "HEAD"])).toBe(before!.head);
      expect(snapshot(checkout, ROOT_FILES[runtime])).toEqual(before!.files);
      expect(stashes(checkout)).toBe("");
      // The candidate is the committed tree: the team's files without AI-DLC's part.
      for (const path of ROOT_FILES[runtime]) {
        expect(git(checkout, ["rev-parse", `${candidateOid}:${path}`])).toBe(git(checkout, ["rev-parse", `HEAD:${path}`]));
      }
      expect(git(checkout, ["show", `${candidateOid}:.gitignore`])).not.toContain("BEGIN AI-DLC");
    });
  }

  for (const [name, runtime, change] of [
    ["a line of the person's own in .gitignore", "copilot", (checkout: string) => {
      appendLine(checkout, ".gitignore", "coverage/");
    }],
    ["the person's own words in AGENTS.md", "copilot", (checkout: string) => {
      const agents = readFileSync(join(checkout, "AGENTS.md"), "utf-8");
      writeFileSync(join(checkout, "AGENTS.md"), agents.replace("every push", "every commit"));
    }],
    ["a second begin marker in AGENTS.md", "copilot", (checkout: string) => {
      appendLine(checkout, "AGENTS.md", "<!-- BEGIN AI-DLC:agents -->");
    }],
    ["the person's own key in opencode.json", "opencode", (checkout: string) => {
      const config = readFileSync(join(checkout, "opencode.json"), "utf-8");
      writeFileSync(join(checkout, "opencode.json"), config.replace("team/model", "team/other-model"));
    }],
    ["a source file", "copilot", (checkout: string) => {
      writeFileSync(join(checkout, "src", "shared.ts"), 'export const left = "changed";\n');
    }],
    ["the workflow state", "copilot", (checkout: string) => {
      writeFileSync(seededStateFile(checkout), `${readFileSync(seededStateFile(checkout), "utf-8")}\n`);
    }],
  ] as const) {
    test(`beside AI-DLC's part, ${name} still stops publish with the same line`, () => {
      const { remote } = seedWithRuntime(runtime);
      const { checkout } = prepareCandidate(remote, "alpha", "team-a");
      sessionStarts(checkout, runtime);
      change(checkout);
      const status = git(checkout, ["status", "--porcelain"]);
      const head = git(checkout, ["rev-parse", "HEAD"]);
      const published = runMergeTool(UNIT, ["publish", "alpha"], checkout);
      expect(published.status).not.toBe(0);
      expect(published.out).toContain(PUBLISH_REFUSAL);
      expect(git(checkout, ["rev-parse", "HEAD"])).toBe(head);
      expect(git(checkout, ["status", "--porcelain"])).toBe(status);
      expect(stashes(checkout)).toBe("");
    });
  }

  for (const [runtime, teamFiles] of [["copilot", true], ["copilot", false], ["opencode", true]] as const) {
    test(`landing from a checkout whose session wrote AI-DLC's part lands, and the part stays uncommitted (${runtime}, ${teamFiles ? "the team's" : "no"} AGENTS.md)`, () => {
      const { seed, remote } = seedWithRuntime(runtime, teamFiles);
      prepareCandidate(remote, "alpha", "team-a");
      sessionStarts(seed, runtime);
      const files = snapshot(seed, ROOT_FILES[runtime]);
      const head = git(seed, ["rev-parse", "HEAD"]);
      gateAndLand(seed, "alpha");
      expect(snapshot(seed, ROOT_FILES[runtime])).toEqual(files);
      // Neither the checkpoint nor the merge took them.
      expect(git(seed, ["diff", "--name-only", head, "HEAD", "--", ...ROOT_FILES[runtime]])).toBe("");
      expect(git(seed, ["status", "--porcelain", "--untracked-files=all", "--", ...ROOT_FILES[runtime]])
        .split("\n").length).toBe(ROOT_FILES[runtime].length);
      expect(stashes(seed)).toBe("");
    });
  }

  for (const [runtime, teamFiles] of [["copilot", true], ["copilot", false], ["opencode", true]] as const) {
    test(`a Unit that carries AI-DLC's part lands over the same part in the landing checkout (${runtime}, ${teamFiles ? "the team's" : "no"} AGENTS.md)`, () => {
      const { seed, remote } = seedWithRuntime(runtime, teamFiles);
      // The team committed AI-DLC's part on its own, after the Unit's work.
      const { checkout, candidateOid } = prepareCandidate(remote, "alpha", "team-a", {
        beforePublish: (clone) => {
          sessionStarts(clone, runtime);
          git(clone, ["add", "--", ...ROOT_FILES[runtime]]);
          git(clone, ["commit", "-m", "AI-DLC's part of the root files"]);
        },
      });
      expect(git(checkout, ["show", `${candidateOid}:.gitignore`])).toContain("# BEGIN AI-DLC:gitignore");
      sessionStarts(seed, runtime);
      if (!teamFiles) expect(git(seed, ["ls-files", "--", "AGENTS.md"])).toBe("");
      gateAndLand(seed, "alpha");
      for (const path of ROOT_FILES[runtime]) {
        expect(git(seed, ["hash-object", "--", path])).toBe(git(seed, ["rev-parse", `${candidateOid}:${path}`]));
      }
      expect(git(seed, ["status", "--porcelain", "--untracked-files=all", "--", ...ROOT_FILES[runtime]])).toBe("");
      expect(stashes(seed)).toBe("");
    });
  }

  test("a Unit that changes the team's part of .gitignore lands, and AI-DLC's part in the landing checkout stays", () => {
    const { seed, remote } = seedWithRuntime();
    const { candidateOid } = prepareCandidate(remote, "alpha", "team-a", {
      beforePublish: (clone) => {
        appendLine(clone, ".gitignore", "coverage/");
        git(clone, ["commit", "-am", "ignore coverage"]);
      },
    });
    sessionStarts(seed);
    const part = bytes(seed, ".gitignore")!.slice(bytes(seed, ".gitignore")!.indexOf("# BEGIN AI-DLC:gitignore"));
    gateAndLand(seed, "alpha");
    const gitignore = bytes(seed, ".gitignore")!;
    expect(gitignore.startsWith(git(seed, ["show", `${candidateOid}:.gitignore`]))).toBe(true);
    expect(gitignore).toContain("coverage/");
    expect(gitignore.endsWith(part)).toBe(true);
    expect(git(seed, ["diff", "--name-only"])).toBe(".gitignore\nAGENTS.md");
    // AI-DLC's local files stay ignored after the landing: the finalize step met none of them.
    expect(git(seed, ["ls-files", "--others", "--exclude-standard"])).toBe("");
    expect(stashes(seed)).toBe("");
  });

  test("when the landing stops and rolls back, AI-DLC's part set aside comes back as it was", () => {
    const { seed, remote } = seedWithRuntime();
    prepareCandidate(remote, "alpha", "team-a", {
      beforePublish: (clone) => {
        sessionStarts(clone);
        git(clone, ["add", "--", ".gitignore", "AGENTS.md"]);
        git(clone, ["commit", "-m", "AI-DLC's part of the root files"]);
      },
    });
    sessionStarts(seed);
    // AI-DLC's part here differs from the Unit's, so its bytes must come back.
    appendLine(seed, "AGENTS.md", "");
    const files = snapshot(seed, ROOT_FILES.copilot);
    approveMerge(seed, "alpha");
    const hook = join(seed, ".git", "hooks", "pre-commit");
    writeFileSync(hook, '#!/bin/sh\n[ -f "$(git rev-parse --git-dir)/MERGE_HEAD" ] && exit 1\nexit 0\n');
    chmodSync(hook, 0o755);
    const head = git(seed, ["rev-parse", "HEAD"]);
    const refused = runMergeTool(UNIT, ["land", "alpha"], seed);
    expect(refused.status).not.toBe(0);
    expect(git(seed, ["rev-parse", "HEAD"])).toBe(head);
    expect(snapshot(seed, ROOT_FILES.copilot)).toEqual(files);
    expect(stashes(seed)).toBe("");
    rmSync(hook);
    const landed = runMergeTool(UNIT, ["land", "alpha"], seed);
    expect(landed.status, landed.out).toBe(0);
  });

  test("beside AI-DLC's part, a line of the person's own in .gitignore still stops landing with the same line", () => {
    const { seed, remote } = seedWithRuntime();
    prepareCandidate(remote, "alpha", "team-a");
    sessionStarts(seed);
    appendLine(seed, ".gitignore", "coverage/");
    approveMerge(seed, "alpha");
    const gitignore = bytes(seed, ".gitignore");
    const head = git(seed, ["rev-parse", "HEAD"]);
    const landed = runMergeTool(UNIT, ["land", "alpha"], seed);
    expect(landed.status).not.toBe(0);
    expect(landed.out).toContain("Unit landing requires a clean source worktree; commit or stash: .gitignore.");
    expect(git(seed, ["rev-parse", "HEAD"])).toBe(head);
    expect(bytes(seed, ".gitignore")).toBe(gitignore);
    expect(stashes(seed)).toBe("");
  });
});
