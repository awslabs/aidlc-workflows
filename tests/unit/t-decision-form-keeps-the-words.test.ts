// The decision command the engine prints, filled in the way the agent fills it,
// keeps a choice's words through the shell that runs it. On a Windows golden
// journey the double-quoted form carried the choice "$0.00": bash read $0 as
// its own name, Claude Code asked to allow AI-DLC's own command, and the record
// said "/usr/bin/bash.00". The forms are read from the shipped protocol and
// Claude Code skill, so this follows the printed text. Mechanism: bash (Git Bash
// on Windows, the shell Claude Code runs there) runs the shipped aidlc-log.ts.
import { afterAll, describe, expect, test, setDefaultTimeout } from "bun:test";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { readAllAuditShards } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { cleanupTestProject, createTestProject, seedStateFile } from "../harness/fixtures.ts";
import { gitBashPath, gitBashSkipReason } from "../harness/git-bash.ts";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const SHIPPED = join(import.meta.dir, "..", "..", "dist", "claude", ".claude");
const LOG = join(SHIPPED, "tools", "aidlc-log.ts");
const QUESTION = "Q1: What should formatPrice(0) show?";
const CHOICES = "Show $0.00,Keep it empty";

const FORMS = [
  {
    where: "the protocol's non-gate question",
    file: "aidlc-common/protocols/stage-protocol.md",
    form: /engine log decision --stage <slug> (--decision \S*<summary>\S* --options \S*<A,B,C>\S*)`/,
    fill: (flags: string) => flags.replace("<summary>", QUESTION).replace("<A,B,C>", CHOICES),
  },
  {
    where: "the skill's question shown before it was recorded",
    file: "skills/aidlc/SKILL.md",
    form: /engine log decision --stage <stage> (--decision \S*<the question>\S* --options \S*<the choices>\S*)`/,
    fill: (flags: string) => flags.replace("<the question>", QUESTION).replace("<the choices>", CHOICES),
  },
];

const projects: string[] = [];
afterAll(() => {
  for (const p of projects) cleanupTestProject(p);
});

function recorded(p: string, name: string): string | undefined {
  const row = readAllAuditShards(p).split(/\n---\n/).filter((block) => block.includes("**Event**: DECISION_RECORDED")).at(-1);
  return row?.split("\n").find((line) => line.startsWith(`**${name}**: `))?.slice(`**${name}**: `.length);
}

const skip = gitBashSkipReason();
describe("t-decision-form-keeps-the-words: a choice that names a price is recorded as written", () => {
  for (const { where, file, form, fill } of FORMS) {
    test.skipIf(skip !== null)(`${where}, run through bash`, () => {
      const printed = readFileSync(join(SHIPPED, file), "utf-8").match(form);
      expect(printed, `${file} prints the decision form`).not.toBeNull();
      const p = createTestProject();
      projects.push(p);
      seedStateFile(p, "state-mid-ideation.md");
      const quote = (value: string) => `'${value}'`;
      const command = `${[process.execPath, LOG].map(quote).join(" ")} decision --stage feasibility ` +
        `${fill(printed![1])} --project-dir ${quote(p)}`;
      const r = spawnSync(process.platform === "win32" ? gitBashPath() : "bash", ["-c", command], {
        cwd: p, encoding: "utf-8", timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
      });
      expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
      expect(recorded(p, "Decision")).toBe(QUESTION);
      expect(recorded(p, "Options")).toContain("Show $0.00");
    });
  }
});
