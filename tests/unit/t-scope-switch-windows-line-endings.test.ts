// covers: subcommand:aidlc-utility:scope-change, subcommand:aidlc-orchestrate:next
//
// #3801. The state file travels with the project by git, and Git for Windows checks it out with CRLF line endings
// (core.autocrlf=true; tests/unit/t-clone-line-endings.test.ts runs that clone). On such a checkout the person
// switches a feature waiting at Intent Capture's gate to bugfix. The switch rebuilt the stage list only from LF text,
// so on CRLF it said "Switched to bugfix: 29 stages", recorded the scope and the skip, and left every stage of the
// feature plan on the list the engine routes by, with Intent Capture still waiting. The same steps on an LF twin are
// the expected result: the same lines, the same list and the same next step, with the file still CRLF throughout.

import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS } from "../harness/test-budget.ts";
import { AIDLC_SRC, cleanupTestProject, createOrchestrationTestProject, removeWorkspaceRecord } from "../harness/fixtures.ts";
import { env, exec, next, say, type Directive } from "../harness/aidlc-input-corpus.ts";
import { getField, parseCheckboxes, setCheckbox, stateFilePath } from "../../dist/claude/.claude/tools/aidlc-lib.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS * 2);

const UTILITY = join(AIDLC_SRC, "tools", "aidlc-utility.ts");

const projects: string[] = [];
afterAll(() => {
  for (const proj of projects) cleanupTestProject(proj);
});

const state = (proj: string): string => readFileSync(stateFilePath(proj), "utf-8");

interface Switched {
  /** What the switch printed. */
  lines: string[];
  /** The state file after the switch. */
  content: string;
  /** The step `next` gives after it. */
  after: Directive | null;
}

/**
 * A feature waiting at Intent Capture's gate, its state file with `eol` line endings; the person types
 * `/aidlc --scope bugfix`, and the agent runs `next` and the scope change its step names.
 */
async function switchToBugfix(eol: "\n" | "\r\n"): Promise<Switched> {
  const proj = createOrchestrationTestProject();
  projects.push(proj);
  removeWorkspaceRecord(proj);
  const made = await exec([process.execPath, UTILITY, "intent-create", "--scope", "feature", "--project-type", "greenfield",
    "--label", "tags", "--arguments", "add tags to the to-do app", "--project-dir", proj], { cwd: proj, env: env(proj) });
  expect(made.status, `${made.stdout}${made.stderr}`).toBe(0);
  expect(getField(state(proj), "Current Stage")).toBe("intent-capture");
  // The gate open, as a run leaves it before the person answers; then the line endings a Windows checkout gives.
  writeFileSync(stateFilePath(proj), setCheckbox(state(proj), "intent-capture", "awaiting-approval").replace(/\r?\n/g, eol));

  await say(proj, "/aidlc --scope bugfix", "claude");
  const step = await next(proj, ["--scope", "bugfix"]);
  expect(step.status, step.out).toBe(0);
  const message = String(step.directive?.message ?? "");
  const command = [...message.matchAll(/`([^`]+)`/g)].map((match) => match[1]).find((text) => /\bscope[ -]change\b/.test(text));
  expect(command, message).toBeDefined();
  const parts = (command?.match(/'[^']*'|"[^"]*"|\S+/g) ?? []).map((part) => part.replace(/^['"]|['"]$/g, ""));
  if (parts[0] === "bun") parts.shift();
  const tool = join(AIDLC_SRC, "tools", (parts.shift() ?? "").replace(/^.*tools\//, ""));
  const ran = await exec([process.execPath, tool, ...parts, "--project-dir", proj], { cwd: proj, env: env(proj) });
  expect(ran.status, `${command}\n${ran.stdout}${ran.stderr}`).toBe(0);
  return { lines: ran.stdout.trim().split("\n"), content: state(proj), after: (await next(proj, [])).directive };
}

describe("a scope switch on a state file with Windows line endings", () => {
  test("rebuilds the stage list as it does on LF, and keeps the file's CRLF line endings", async () => {
    const lf = await switchToBugfix("\n");
    const crlf = await switchToBugfix("\r\n");

    // The LF twin is the switch as it has always run: bugfix's five stages, Intent Capture skipped with it.
    expect(lf.lines[0]).toMatch(/^Switched to bugfix \(.*\): 5 stages \(0 done\), 5 approval gates\./);
    expect(lf.lines).toContain(
      "Skipped Intent Capture & Framing (it was waiting for your approval): bugfix does not run it. You can still run it on its own any time.",
    );
    const lfBoxes = parseCheckboxes(lf.content);
    expect(lfBoxes.find((box) => box.slug === "intent-capture")?.state).toBe("skipped");
    expect(lfBoxes.find((box) => box.slug === "user-stories")?.suffix).toBe("SKIP");

    // The CRLF twin says, records and routes the same.
    expect(crlf.lines).toEqual(lf.lines);
    expect(getField(crlf.content, "Scope")).toBe("bugfix");
    expect(parseCheckboxes(crlf.content)).toEqual(lfBoxes);
    expect(crlf.after?.kind, JSON.stringify(crlf.after)).toBe(lf.after?.kind);
    expect(crlf.after?.stage, JSON.stringify(crlf.after)).toBe(lf.after?.stage);
    expect(crlf.after?.message, JSON.stringify(crlf.after)).toBe(lf.after?.message);
    // Every line still ends CRLF, so the checkout does not churn and the next write finds the same file.
    expect(crlf.content.match(/(?<!\r)\n/g) ?? []).toEqual([]);
    expect(crlf.content.replace(/\r\n/g, "\n").split("\n").length).toBe(crlf.content.split("\r\n").length);
  });
});
