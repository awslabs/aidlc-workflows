// covers: subcommand:aidlc-orchestrate:next, subcommand:aidlc-log:answer, subcommand:aidlc-utility:scope-change, subcommand:aidlc-orchestrate:report
//
// "1. also can you switch this to the express plan?" typed at Intent Capture's summary confirmation on a poc. The
// confirmation said "record this confirmation and generate the named artifacts", but the switch dropped the running
// stage before anything was written (a live Codex run), so later stages never read what the person confirmed. Now the
// step the switch gets has the agent write the confirmed documents first, nothing else of the stage, and then switch;
// the switch skips the stage as before, and its line says the plan does not include it instead of "does not apply
// here". A switch before the confirmation, with the documents already written, or to a plan that runs the stage keeps
// its own step. Every move is a shipped tool's: intent-create, the human-turn hook, `log decision|answer`, then `next`
// and the commands its step names.

import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS } from "../harness/test-budget.ts";
import { AIDLC_SRC, cleanupTestProject, createOrchestrationTestProject, removeWorkspaceRecord } from "../harness/fixtures.ts";
import { env, exec, next, say, type Exec } from "../harness/aidlc-input-corpus.ts";
import { getField, stateFilePath } from "../../dist/claude/.claude/tools/aidlc-lib.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS * 2);

const UTILITY = join(AIDLC_SRC, "tools", "aidlc-utility.ts");
const LOG = join(AIDLC_SRC, "tools", "aidlc-log.ts");
const REPLY = "1. also can you switch this to the express plan? i might want to deploy it later";

const projects: string[] = [];
afterAll(() => {
  for (const proj of projects) cleanupTestProject(proj);
});

const state = (proj: string): string => readFileSync(stateFilePath(proj), "utf-8");
const box = (proj: string, slug: string): string =>
  new RegExp(`^- \\[(.)\\] ${slug} — (EXECUTE|SKIP)`, "m").exec(state(proj))?.slice(1).join(" ") ?? "";
const stageFolder = (proj: string): string => join(dirname(stateFilePath(proj)), "ideation", "intent-capture");

/** A command a step names (`bun .claude/tools/<tool>.ts ...`), run from the shipped tree on this project. */
async function runNamed(proj: string, command: string): Promise<Exec> {
  const parts = (command.match(/'[^']*'|"[^"]*"|\S+/g) ?? []).map((part) => part.replace(/^['"]|['"]$/g, ""));
  if (parts[0] === "bun") parts.shift();
  const tool = join(AIDLC_SRC, "tools", (parts.shift() ?? "").replace(/^.*tools\//, ""));
  const result = await exec([process.execPath, tool, ...parts, "--project-dir", proj], { cwd: proj, env: env(proj) });
  expect(result.status, `${command}\n${result.stdout}${result.stderr}`).toBe(0);
  return result;
}
/** The commands a step names that match `pattern`, in order. */
function named(message: string, pattern: RegExp): string[] {
  return [...message.matchAll(/`([^`]+)`/g)].map((match) => match[1]).filter((command) => pattern.test(command));
}

/** A poc at Intent Capture, its questions answered and the consolidated summary shown; `confirm` records "Looks correct". */
async function pocAtSummary(confirm: boolean): Promise<string> {
  const proj = createOrchestrationTestProject();
  projects.push(proj);
  removeWorkspaceRecord(proj);
  const made = await exec([process.execPath, UTILITY, "intent-create", "--scope", "poc", "--project-type", "greenfield",
    "--label", "due-dates", "--arguments", "add due dates to my todo app", "--project-dir", proj], { cwd: proj, env: env(proj) });
  expect(made.status, `${made.stdout}${made.stderr}`).toBe(0);
  await say(proj, "/aidlc", "claude");
  expect((await next(proj, [])).directive?.stage).toBe("intent-capture");
  mkdirSync(stageFolder(proj), { recursive: true });
  const questions = join(stageFolder(proj), "intent-capture-questions.md");
  writeFileSync(questions, "# Intent Capture Questions\n\n## Q1. What would make this useful?\n\nA. Due dates, overdue first\nX. Other\n\n" +
    "[Answer]: A\n\n## Consolidated Summary Confirmation\n\n- Add a due date to a task; list overdue ones first.\n\n[Answer]: \n", "utf-8");
  const summary = ["--checkpoint", "summary-confirmation", "--stage", "intent-capture", "--questions-file", questions, "--project-dir", proj];
  const shown = await exec([process.execPath, LOG, "decision", ...summary, "--decision", "Does this all look correct?",
    "--options", "Looks correct,Request changes"], { cwd: proj, env: env(proj) });
  expect(shown.status, `${shown.stdout}${shown.stderr}`).toBe(0);
  await say(proj, confirm ? REPLY : "can you switch this to the express plan?", "claude");
  if (confirm) {
    writeFileSync(questions, readFileSync(questions, "utf-8").replace(/\[Answer\]: \n$/, "[Answer]: Looks correct\n"), "utf-8");
    const answered = await exec([process.execPath, LOG, "answer", ...summary, "--details", "Looks correct"], { cwd: proj, env: env(proj) });
    expect(answered.status, `${answered.stdout}${answered.stderr}`).toBe(0);
  }
  expect(box(proj, "intent-capture")).toBe("- EXECUTE");
  return proj;
}
async function switchStep(proj: string, scope: string): Promise<string> {
  const step = await next(proj, ["--scope", scope]);
  expect(step.status, step.out).toBe(0);
  expect(step.directive?.kind).toBe("print");
  return String(step.directive?.message ?? "");
}

describe("t-confirm-and-switch-plan: a confirmed summary's documents are written before a switch drops the stage", () => {
  test("confirm and switch: the confirmed documents first, then the switch, and later stages read them", async () => {
    const proj = await pocAtSummary(true);
    const message = await switchStep(proj, "express");
    const folder = "aidlc/spaces/default/intents/";
    expect(message).toContain("The person confirmed Intent Capture & Framing's summary, and express does not run Intent Capture & Framing");
    expect(message).toMatch(new RegExp(`${folder}[^\`]+/ideation/intent-capture/intent-statement\\.md`));
    expect(message).toContain("stakeholder-map.md");
    expect(message).not.toContain("intent-capture-questions.md");
    expect(message).toContain("do nothing else of Intent Capture & Framing");
    const [scopeChange] = named(message, /engine scope change --scope express/);
    expect(message.indexOf("stakeholder-map.md")).toBeLessThan(message.indexOf(scopeChange));

    // The agent writes the two documents from what was confirmed, then switches.
    writeFileSync(join(stageFolder(proj), "intent-statement.md"), "# Intent Statement\n\nDue dates, overdue first.\n", "utf-8");
    writeFileSync(join(stageFolder(proj), "stakeholder-map.md"), "# Stakeholder Map\n\n- The owner, sole user.\n", "utf-8");
    await runNamed(proj, scopeChange);
    expect(getField(state(proj), "Scope")).toBe("express");
    const recover = await next(proj, []);
    for (const command of named(String(recover.directive?.message ?? ""), /--result skipped/)) {
      const skipped = await runNamed(proj, command);
      const done = JSON.parse(skipped.stdout.trim().split("\n").findLast((row) => row.startsWith("{")) ?? "{}") as { narration?: string };
      expect(done.narration).toBe("Intent Capture & Framing is not part of the express plan, so I skipped it.");
    }
    expect(box(proj, "intent-capture")).toBe("S SKIP");
    expect(existsSync(join(stageFolder(proj), "intent-statement.md"))).toBe(true);
    const after = await next(proj, []);
    expect(after.directive?.stage).toBe("requirements-analysis");
    expect(JSON.stringify(after.directive?.consumes ?? [])).toContain("intent-capture/intent-statement.md");
  });

  test("a switch before the confirmation keeps today's step: the summary question still waits", async () => {
    const proj = await pocAtSummary(false);
    const message = await switchStep(proj, "express");
    expect(message).not.toContain("The person confirmed");
    expect(message).toContain("to change scope, then print its output verbatim and stop.");
  });

  test("with the confirmed documents already written the switch keeps today's step", async () => {
    const proj = await pocAtSummary(true);
    writeFileSync(join(stageFolder(proj), "intent-statement.md"), "# Intent Statement\n\nDue dates.\n", "utf-8");
    writeFileSync(join(stageFolder(proj), "stakeholder-map.md"), "# Stakeholder Map\n\n- The owner.\n", "utf-8");
    const message = await switchStep(proj, "express");
    expect(message).not.toContain("The person confirmed");
  });

  test("a switch to a plan that runs the stage keeps today's step", async () => {
    const proj = await pocAtSummary(true);
    const message = await switchStep(proj, "mvp");
    expect(message).not.toContain("The person confirmed");
  });
});
