// covers: subcommand:aidlc-utility:reclassify, audit:WORKSPACE_RECLASSIFIED, file:skills/aidlc/SKILL.md
//
// t-exec-codex-journey-code-arrives.serial.test.ts - new project, then the
// team's code arrives, on Codex (live `codex exec`, then `codex exec resume`).
//
// What a person hit without this on Codex: the existing-code question came
// once and the answer was recorded, but the reply said "This plan does not
// include Reverse Engineering." and the code was never documented; on Kiro CLI
// the agent answered the question itself and AI-DLC recorded it as the
// person's. The Claude SDK leg (t-journey-code-arrives.sdk) also proves the
// creation line; here the work is created with the same engine commands the
// agent runs, so Codex time goes to the part that failed.
//
//   setup:  a Codex install in an empty folder holding docs/vision.md; the work
//           is created as a classic piece of work (the scan's call: new
//           project, Reverse Engineering left out). Then the team's code
//           lands in the folder.
//   beat 1: `codex exec` "$aidlc", what a person types to carry on. AI-DLC
//           asks whether the code is existing code; in exec mode the question
//           comes as plain text and the turn ends. Nothing may be
//           reclassified yet.
//   beat 2: `codex exec resume --last` "yes, it is our existing code", same
//           session. The type is recorded as the person's, Reverse
//           Engineering goes back on the plan, and it starts.
//
// Pass/fail reads only engine output, the audit and the state file, never the
// agent's prose.
//
// LIVE GATE: requires AIDLC_CODEX_EXEC_LIVE=1 + a codex >= 0.145.0 binary
// (AIDLC_CODEX_BIN or PATH). Bedrock uses the AWS default credential chain;
// AIDLC_CODEX_AWS_PROFILE selects a named profile when needed. Serial.

import { liveCaseTimeoutMs, LIVE_LONG_OPERATION_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, NATIVE_FIXTURE_SETUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { auditBlockField, getField, readAuditShardEvents } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { codexHeadlessArgs, setupCodexProject } from "../harness/exec-drive.ts";
import { REPO_ROOT } from "../harness/fixtures.ts";
import { codexExecDiagnostic, codexExecTimeout, codexPersonTurn, recordCodexExec, withCodexFixture } from "../harness/codex-test-lifecycle.ts";
import { turnEvidence, type CodexTurn } from "../harness/codex-turn-evidence.ts";

function completedStartupProbe<T extends { error?: Error }>(result: T): T {
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT") throw result.error;
  return result;
}

const CODEX_DIST = join(REPO_ROOT, "dist", "codex");
const CODEX_BIN = process.env.AIDLC_CODEX_BIN ?? "codex";

const TIMEOUT_S = Number(process.env.AIDLC_TEST_TIMEOUT);
const TEST_TIMEOUT_MS = Number.isSafeInteger(TIMEOUT_S) && TIMEOUT_S > 0
  ? TIMEOUT_S * 1000
  : liveCaseTimeoutMs(LIVE_LONG_OPERATION_TIMEOUT_MS);

// The existing-code question as `next` returns it to the agent.
const ASKED = '"ask_type":"project-type"';
const ANSWER = "yes, it is our existing code";

function codexVersionOk(): boolean {
  const r = completedStartupProbe(spawnSync(CODEX_BIN, ["--version"], { timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS), encoding: "utf-8" }));
  const m = (r.stdout ?? "").match(/(\d+)\.(\d+)\.(\d+)/);
  if (r.status !== 0 || !m) return false;
  const [maj, min] = [Number(m[1]), Number(m[2])];
  return maj > 0 || min >= 145;
}

function skipReason(): string | null {
  if (process.env.AIDLC_CODEX_EXEC_LIVE !== "1") {
    return "set AIDLC_CODEX_EXEC_LIVE=1 to run the live codex-exec journey (uses Bedrock)";
  }
  if (!codexVersionOk()) return `codex >= 0.145.0 not found (AIDLC_CODEX_BIN=${CODEX_BIN})`;
  if (!existsSync(CODEX_DIST)) return `distributable missing: ${CODEX_DIST}`;
  return null;
}
const SKIP_REASON = skipReason();

function engine(proj: string, args: string[]): string {
  const r = spawnSync("bun", [join(".codex", "tools", "aidlc.ts"), "engine", ...args], {
    cwd: proj,
    encoding: "utf-8",
    timeout: remainingOperationTimeoutMs(NATIVE_FIXTURE_SETUP_TIMEOUT_MS),
  });
  if (r.status !== 0) throw new Error(`engine ${args.join(" ")} failed: ${r.stdout}${r.stderr}`);
  return r.stdout;
}

// The commands the agent runs to create the work, with its label filled in.
function createClassicWork(proj: string): void {
  const directive = JSON.parse(engine(proj, ["orchestrate", "next", "--scope", "classic", "Build what vision.md describes"])) as { message: string };
  const create = /engine intent create (.*?)`/.exec(directive.message)?.[1];
  if (!create) throw new Error(`no creation command in: ${directive.message}`);
  const args = (create.match(/"[^"]*"|\S+/g) ?? []).map((arg) => arg.replace(/^"|"$/g, ""))
    .map((arg) => arg.startsWith("<") ? "lunch-poll" : arg);
  engine(proj, ["intent", "create", ...args]);
}

function teamCodeArrives(proj: string): void {
  const repo = join(proj, "lunch-poll");
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "package.json"), `${JSON.stringify({ name: "lunch-poll", dependencies: { express: "4.19.2" } }, null, 2)}\n`);
  writeFileSync(join(repo, "src", "server.ts"), "export const port = 3000;\n");
  expect(spawnSync("git", ["init", "-q", repo]).status).toBe(0);
}

function state(proj: string): string {
  const intents = join(proj, "aidlc", "spaces", "default", "intents");
  const record = readFileSync(join(intents, "active-intent"), "utf-8").trim();
  return readFileSync(join(intents, record, "aidlc-state.md"), "utf-8");
}

function reStageRow(content: string): string | undefined {
  return /^- \[.\] reverse-engineering \S+ (EXECUTE|SKIP)$/m.exec(content)?.[1];
}

// What AI-DLC's own commands printed during a turn: each completed command's
// output from the JSON stream (never the agent's own messages).
function commandOutputs(stdout: string): string[] {
  const outputs: string[] = [];
  for (const line of stdout.split("\n").filter((entry) => entry.trim())) {
    const event = JSON.parse(line) as { type?: string; item?: { type?: string; aggregated_output?: unknown } };
    if (event.type === "item.completed" && event.item?.type === "command_execution" &&
      typeof event.item.aggregated_output === "string") outputs.push(event.item.aggregated_output);
  }
  return outputs;
}

function codexTurn(proj: string, home: string, prompt: string, opts: { resume?: boolean } = {}): CodexTurn {
  const argv = opts.resume ? ["exec", "resume", "--last", "--json", prompt] : ["exec", "--json", prompt];
  const commandArgs = codexHeadlessArgs(...argv);
  const turn = codexPersonTurn(proj, prompt);
  const r = spawnSync(CODEX_BIN, commandArgs, {
    cwd: proj,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, CODEX_HOME: home },
    timeout: codexExecTimeout(TEST_TIMEOUT_MS),
  });
  const result = { rc: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "", signal: r.signal, error: r.error?.message };
  recordCodexExec("code-arrives", proj, [CODEX_BIN, ...commandArgs], result, turn);
  return { ...result, ...(result.rc === 0 ? turnEvidence(result.stdout) : { agentMessages: [] }) };
}

describe("t-exec-codex-journey-code-arrives - a new project gains the team's code, on Codex", () => {
  test.skipIf(SKIP_REASON !== null)(
    `the question comes once and waits; the person's yes is recorded as theirs and Reverse Engineering starts${SKIP_REASON ? ` [SKIP: ${SKIP_REASON}]` : ""}`,
    async () => {
      const deadlineMs = performance.now() + TEST_TIMEOUT_MS;
      const { proj, home, root } = setupCodexProject({ workspaceWrite: true });
      await withCodexFixture(root, () => rmSync(root, { recursive: true, force: true }), () => {
        mkdirSync(join(proj, "docs"), { recursive: true });
        writeFileSync(join(proj, "docs", "vision.md"), "# Lunch poll\n\nA small web app where a team votes on where to eat lunch each day.\n");
        createClassicWork(proj);
        const start = state(proj);
        expect(getField(start, "Project Type")).toBe("Greenfield");
        expect(getField(start, "Project Type Source")).toBe("workspace scan");
        expect(reStageRow(start)).toBe("SKIP");

        teamCodeArrives(proj);

        // Beat 1: the person carries on and is asked about the code.
        const b1 = codexTurn(proj, home, "$aidlc");
        expect(b1.rc, codexExecDiagnostic(b1)).toBe(0);
        expect(commandOutputs(b1.stdout).some((out) => out.includes(ASKED)), `the existing-code question was never asked\n${codexExecDiagnostic(b1)}`)
          .toBe(true);
        const atQuestion = readAuditShardEvents(proj);
        expect(atQuestion.filter((r) => r.event === "WORKSPACE_RECLASSIFIED"), "reclassified before the person answered").toEqual([]);

        // Beat 2: their answer, in the same session.
        const b2 = codexTurn(proj, home, ANSWER, { resume: true });
        expect(b2.rc, codexExecDiagnostic(b2)).toBe(0);
        expect(b2.sessionId).toBe(b1.sessionId);
        expect(commandOutputs(b2.stdout).filter((out) => out.includes(ASKED)), "the question came back after the answer").toEqual([]);

        // The answer is the person's: the reclassify came only after their
        // reply. When this was written, codex exec 0.151.0 and 0.160.0 ran
        // none of the project's hooks (no hook left its trace), so there is no
        // recorded human turn to pair it with; the SDK leg checks that.
        const rows = readAuditShardEvents(proj);
        const reclassified = rows.filter((r) => r.event === "WORKSPACE_RECLASSIFIED");
        expect(reclassified, "reclassify rows").toHaveLength(1);
        const at = rows.indexOf(reclassified[0]);
        expect(at).toBeGreaterThanOrEqual(atQuestion.length);
        expect(auditBlockField(reclassified[0].block, "New Project Type")).toBe("Brownfield (you)");
        expect(auditBlockField(reclassified[0].block, "Reverse Engineering")).toBe("back on the plan");
        expect(
          rows.slice(at).some((r) => r.event === "STAGE_STARTED" && auditBlockField(r.block, "Stage") === "reverse-engineering"),
          "Reverse Engineering never started",
        ).toBe(true);

        const end = state(proj);
        expect(getField(end, "Project Type")).toBe("Brownfield");
        expect(getField(end, "Project Type Source")).toBe("you");
        expect(reStageRow(end)).toBe("EXECUTE");
      }, deadlineMs);
    },
    TEST_TIMEOUT_MS,
  );
});
