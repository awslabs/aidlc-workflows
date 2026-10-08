// covers: function:FILE_TOOLS_RULE function:AS_ITS_OWN_COMMAND
//
// t-agent-conduct: every AI-DLC agent writes files with its file tools, reads
// with them where it has them, and runs AI-DLC's commands as printed. The wording has one owner,
// FILE_TOOLS_RULE in core/tools/aidlc-testing-posture.ts; the engine's worker brief renders it
// (t-plan-approval-ask), and the three shared prose places that reach the
// conductor, every dispatched subagent prompt, and the reviewer carry it
// verbatim, here and in a packaged tree.
//
// Mechanism = none: pure file reads.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FILE_TOOLS_RULE } from "../../core/tools/aidlc-testing-posture.ts";
import { REPO_ROOT } from "../harness/fixtures.ts";

const PROSE = [
  "agents/aidlc-architecture-reviewer-agent.md",
  "agents/aidlc-composer-agent.md",
  "agents/aidlc-product-lead-agent.md",
  "aidlc-common/conductor.md",
  "aidlc-common/protocols/stage-protocol-ensemble.md",
  "aidlc-common/protocols/stage-protocol-reviewer.md",
];

describe("t-agent-conduct", () => {
  test("the conductor, dispatch, and reviewer prose carry the one rule verbatim", () => {
    for (const rel of PROSE) {
      expect(readFileSync(join(REPO_ROOT, "core", rel), "utf-8"), rel).toContain(FILE_TOOLS_RULE);
      expect(readFileSync(join(REPO_ROOT, "dist", "claude", ".claude", rel), "utf-8"), `dist ${rel}`)
        .toContain(FILE_TOOLS_RULE);
    }
  });

  // Codex has no file-read tool: it reads through the shell, and the rule
  // must leave it a way to read.
  test("the Codex tree carries the rule, which leaves a shell-only reader one plain read", () => {
    for (const rel of PROSE) {
      expect(readFileSync(join(REPO_ROOT, "dist", "codex", ".codex", rel), "utf-8"), `codex ${rel}`)
        .toContain(FILE_TOOLS_RULE);
    }
    expect(FILE_TOOLS_RULE).toContain("where the shell is your only way to read, use one plain read command");
    // A live Claude Code run: the composer and a reviewer ran AI-DLC commands with the full project
    // path, which the shipped allow list does not match, so each one asked the person to approve it.
    expect(FILE_TOOLS_RULE).toContain("keeping its path as written (never a full path)");
    // A subagent reads its own knowledge files with the file tool too, never
    // through a shell loop.
    expect(FILE_TOOLS_RULE).toContain("Read, list, and search (your own knowledge files included) with your file tools");
    expect(FILE_TOOLS_RULE).not.toMatch(/never through the shell[^.]*`(?:cat|ls|rg|grep|find)`/);
    // Live Claude Code runs: agents sent `orchestrate next` output to /tmp/r.json, wrote a
    // helper script to /tmp, ran `cd /tmp; bun -e ...`. In default mode each one is a
    // prompt outside the project, a denial, "Interrupted", and the person typing "keep
    // everything in this folder, carry on".
    expect(FILE_TOOLS_RULE).toContain("Every file you make stays inside the project");
    expect(FILE_TOOLS_RULE).toContain("/tmp");
    expect(FILE_TOOLS_RULE).toContain("never sent to a file");
    // A live run on a zsh box (every macOS person): `echo ===gitignore` and an unquoted
    // `--include=*.ts` failed, each a prompt, an error line, and a retry.
    expect(FILE_TOOLS_RULE).toContain("--include='*.ts'");
    expect(FILE_TOOLS_RULE).toContain("zsh");
  });

  // Two tools have a habit of their own that the shared rule cannot name: Copilot's agent
  // wrote a "lesson" into Copilot's memory tool outside the project (W4-VC), and on Kiro IDE
  // every pipe, `;`, `echo` or `Select-String` the agent adds to an AI-DLC command is one
  // more approval card for the person (kiro-ide-win F4).
  // The conductor persona (conductor.md, which carries the rule) is baked into the FIRST
  // run-stage of a workflow only, so a lead that resumes work in a new chat never gets it;
  // the skill is what the lead always has, so the one sentence about where files go rides
  // in every skill's "run the engine" paragraph too.
  test("every skill tells the lead that its files stay inside the project", () => {
    for (const harness of ["claude", "codex", "copilot", "cursor", "kiro-ide", "kiro", "opencode"]) {
      const skill = readFileSync(join(REPO_ROOT, "harness", harness, "skills", "aidlc", "SKILL.md"), "utf-8");
      expect(skill, harness).toMatch(
        /Run the engine binary directly via [^.]*\. Every file you make stays inside the project \(nothing in \/tmp or any folder outside it\), and a command's output is read from the tool result, never sent to a file\./,
      );
    }
  });

  test("the Copilot and Kiro IDE skills carry their own conduct sentence", () => {
    const copilot = readFileSync(join(REPO_ROOT, "harness", "copilot", "skills", "aidlc", "SKILL.md"), "utf-8");
    expect(copilot).toContain("never into Copilot's memory tool");
    const kiroIde = readFileSync(join(REPO_ROOT, "harness", "kiro-ide", "skills", "aidlc", "SKILL.md"), "utf-8");
    expect(kiroIde).toContain("**Every AI-DLC command on its own.**");
    expect(kiroIde).toContain("no pipe, no `;`, no `echo`, no `Select-String`");
  });

  test("the diary bootstrap uses the write tool, not a shell mkdir", () => {
    const conductor = readFileSync(join(REPO_ROOT, "core", "aidlc-common", "conductor.md"), "utf-8");
    expect(conductor).not.toContain("mkdir -p");
    expect(conductor).toContain("create it with your file-write tool");
  });
});
