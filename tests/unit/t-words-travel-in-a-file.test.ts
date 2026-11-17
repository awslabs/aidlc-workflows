// covers: subcommand:aidlc-orchestrate:next
//
// A step that hands the agent a `next` command for the person's own words
// writes the words to a file and names the file: no shell reads them on the
// way. Quoted on the command line they could not serve every shell: on Claude
// Code for Windows, Git Bash read the PowerShell form of "Don't merge, it's
// unsafe!" ('Don''t merge, it''s unsafe!') as "Dont merge, its unsafe!", and the
// agent's shell there may be Git Bash or PowerShell. The printed command is run
// through bash (Git Bash on Windows), as the agent runs it.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import { AIDLC_SRC, cleanupTestProject, createOrchestrationTestProject, runOrchestrateNext } from "../harness/fixtures.ts";
import { gitBashPath, gitBashSkipReason } from "../harness/git-bash.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
const created: string[] = [];
afterEach(() => {
  while (created.length > 0) cleanupTestProject(created.pop());
});

const ORCH = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
const WORDS = ["Don't", "merge,", "it's", "unsafe!", 'Show', '$0.00', '"now"'];

function next(proj: string, args: string[]): { kind?: string; message?: string } {
  const result = runOrchestrateNext(ORCH, proj, args, { env: { ...process.env, AIDLC_UNATTENDED: "0" } });
  expect(result.status, result.out).toBe(0);
  expect(result.directive, result.out).not.toBeNull();
  return result.directive as { kind?: string; message?: string };
}

const skip = gitBashSkipReason();
describe("the person's words in a printed next step travel in a file", () => {
  test.skipIf(skip !== null)("a sentence that opens with a workspace noun: the step names a file, and bash runs it with every word", () => {
    const proj = createOrchestrationTestProject();
    created.push(proj);
    const typed = ["intent", "nowhere", ...WORDS];
    const d = next(proj, typed);
    expect(d.kind, JSON.stringify(d).slice(0, 300)).toBe("print");
    const step = /`([^`]* next --request-file (aidlc\/\.aidlc-request-text\/[^ `]+))` instead/.exec(String(d.message));
    expect(step, String(d.message)).not.toBeNull();
    // The command holds no word of theirs; the file holds them all, as typed.
    for (const word of WORDS) expect(step![1]).not.toContain(word);
    const file = join(proj, ...step![2].split("/"));
    expect(readFileSync(file, "utf-8")).toBe(typed.join(" "));
    const run = spawnSync(process.platform === "win32" ? gitBashPath() : "bash", [
      "-c", step![1].replace(/^bun \S+aidlc-orchestrate\.ts/, `'${process.execPath}' '${ORCH}'`) + ` --project-dir '${proj}'`,
    ], { cwd: proj, encoding: "utf-8", timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS) });
    expect(run.status, `${run.stdout}${run.stderr}`).toBe(0);
    // `next` read the file and took its words, so the file is spent.
    expect(existsSync(file)).toBe(false);
  });

  test("a Unit gate typed after /aidlc: the step's gate command names a file holding their reason, not the words", () => {
    const proj = createOrchestrationTestProject();
    created.push(proj);
    const reason = WORDS.join(" ");
    for (const typed of [
      ["unit", "gate", "alpha", "--decision", "reject", "--user-input", reason],
      ["unit", "gate", "alpha", "--decision", "reject", `--user-input=${reason}`],
    ]) {
      const d = next(proj, typed);
      expect(d.kind, JSON.stringify(d).slice(0, 300)).toBe("print");
      const step = /`[^`]* unit gate alpha --decision reject --request-file (aidlc\/\.aidlc-request-text\/[^ `]+)`/.exec(String(d.message));
      expect(step, String(d.message)).not.toBeNull();
      for (const word of WORDS) expect(String(d.message)).not.toContain(word);
      expect(readFileSync(join(proj, ...step![1].split("/")), "utf-8")).toBe(reason);
    }
  });
});
