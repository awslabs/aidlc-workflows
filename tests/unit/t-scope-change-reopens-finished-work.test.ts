// covers: subcommand:aidlc-utility:scope-change, subcommand:aidlc-utility:doctor, function:stageReopenedByScopeChange
//
// Issue #2261. A workflow is finished (Status Completed) and the person types
// `/aidlc --scope <scope>` for a scope that runs a stage after the last one
// (stock pair: bugfix finished, then express, which adds observability-setup).
// The scope change used to rewrite the plan and leave the record finished, so
// `next` handed out run-stage for a stage nothing had started and every gate
// report refused it as "pending". Now the scope change reopens the work at the
// first stage the new scope adds after the cursor (the field set `advance`
// writes, one STAGE_STARTED row, the registry row back in flight), and `next`
// tells the agent to carry on into it instead of ending the turn. One lib
// predicate decides both, so the print can never promise work the tool leaves
// finished. Nothing approved before is asked again.

import { afterEach, describe, expect, test, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";
import {
  cleanupTestProject,
  createOrchestrationTestProject,
  resetAidlcEnv,
  runOrchestrateNext,
  seedStateFile,
} from "../harness/fixtures.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const TOOLS = join(import.meta.dir, "..", "..", "dist", "claude", ".claude", "tools");
const STATE = join(TOOLS, "aidlc-state.ts");
const UTILITY = join(TOOLS, "aidlc-utility.ts");
const ORCH = join(TOOLS, "aidlc-orchestrate.ts");
const LIB = join(TOOLS, "aidlc-lib.ts");

// bugfix's plan, in graph order; it ends at deployment-execution.
const BUGFIX = [
  "workspace-scaffold", "workspace-detection", "state-init", "requirements-analysis",
  "code-generation", "build-and-test", "deployment-pipeline", "deployment-execution",
];
const LAST = "deployment-execution";
const ADDED = "observability-setup";

// No chat names itself to the tools unless a case says so: a run from inside a
// host's own chat would otherwise lend the tools that chat.
const noChat: Record<string, string | undefined> = { ...process.env, AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS: "1" };
for (const key of ["AIDLC_SESSION_OVERRIDE", "AIDLC_SESSION_OVERRIDE_SOURCE", "CLAUDE_CODE_SESSION_ID", "CLAUDE_PID", "CODEX_THREAD_ID", "KIRO_SESSION_ID"]) {
  delete noChat[key];
}
let env = noChat;
const SESSION = "01995000-7a11-7000-8000-000000002261";

function run(tool: string, proj: string, args: string[]): { rc: number; out: string; stdout: string } {
  const res = spawnSync(process.execPath, [tool, ...args, "--project-dir", proj], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    encoding: "utf-8",
    cwd: proj,
    env,
  });
  return { rc: res.status ?? -1, out: `${res.stdout ?? ""}${res.stderr ?? ""}`, stdout: res.stdout ?? "" };
}

type Directive = { kind: string; message?: string; stage?: string; reason?: string; produces?: string[]; narration?: string };

function next(proj: string, args: string[] = []): Directive {
  const res = runOrchestrateNext(ORCH, proj, args, { cwd: proj, env });
  expect(res.directive, res.out).not.toBeNull();
  return res.directive as Directive;
}

function report(proj: string, stage: string, args: string[]): Directive {
  const res = spawnSync(process.execPath, [ORCH, "report", "--stage", stage, ...args, "--project-dir", proj], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    encoding: "utf-8",
    cwd: proj,
    env: { ...env, AIDLC_SKIP_REVIEWER_GATE_GUARD: "1", AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD: "1" },
  });
  const line = (res.stdout ?? "").trim().split(/\r?\n/).at(-1) ?? "";
  expect(res.status, `${res.stdout}${res.stderr}`).toBe(0);
  return JSON.parse(line) as Directive;
}

function recordDir(proj: string): string {
  const intents = join(proj, "aidlc", "spaces", "default", "intents");
  return join(intents, readFileSync(join(intents, "active-intent"), "utf-8").trim());
}
const state = (proj: string): string => readFileSync(join(recordDir(proj), "aidlc-state.md"), "utf-8");
const field = (text: string, name: string): string =>
  new RegExp(`^- \\*\\*${name}\\*\\*: ?(.*)$`, "m").exec(text)?.[1].trim() ?? "";
const box = (text: string, slug: string): string =>
  new RegExp(`^- \\[(.)\\] ${slug} `, "m").exec(text)?.[1] ?? "";
function events(proj: string): string[] {
  const dir = join(recordDir(proj), "audit");
  const text = readdirSync(dir).filter((f) => f.endsWith(".md")).sort()
    .map((f) => readFileSync(join(dir, f), "utf-8")).join("\n");
  return [...text.matchAll(/\*\*Event\*\*: ([A-Z_]+)(?:\n\*\*Stage\*\*: ([a-z0-9-]+))?/g)]
    .map((m) => (m[2] ? `${m[1]}:${m[2]}` : m[1]));
}
const REGISTRY = (proj: string): string => join(proj, "aidlc", "spaces", "default", "intents", "intents.json");
type Row = { dirName: string; status: string; scope?: string };
/** The registry row of the work under test (the fixture seeds a row of its own beside it). */
function registryRow(proj: string): Row {
  const dir = recordDir(proj).split(/[\\/]/).at(-1);
  const row = (JSON.parse(readFileSync(REGISTRY(proj), "utf-8")) as Row[]).find((r) => r.dirName === dir);
  expect(row, dir).toBeDefined();
  return row!;
}
function setRegistryStatus(proj: string, status: string): void {
  const dir = recordDir(proj).split(/[\\/]/).at(-1);
  const rows = JSON.parse(readFileSync(REGISTRY(proj), "utf-8")) as Row[];
  for (const row of rows) if (row.dirName === dir) row.status = status;
  writeFileSync(REGISTRY(proj), `${JSON.stringify(rows, null, 2)}\n`, "utf-8");
}
function doctor(proj: string): { rc: number; out: string } {
  return run(UTILITY, proj, ["doctor"]);
}

const created: string[] = [];
afterEach(() => {
  env = noChat;
  resetAidlcEnv();
  for (const proj of created.splice(0)) cleanupTestProject(proj);
});

/** A bugfix run to its end, as complete-workflow leaves it: Status Completed, WORKFLOW_COMPLETED on record. */
function finishedBugfix(): string {
  const proj = createOrchestrationTestProject();
  created.push(proj);
  expect(run(UTILITY, proj, ["intent-create", "--scope", "bugfix"]).rc).toBe(0);
  expect(run(STATE, proj, ["checkbox", ...BUGFIX.map((s) => `${s}=completed`)]).rc).toBe(0);
  expect(run(STATE, proj, [
    "set", `Current Stage=${LAST}`, "Status=Running", "Lifecycle Phase=OPERATION",
    "Next Stage=none", "In Progress=none", `Last Completed Stage=${LAST}`,
  ]).rc).toBe(0);
  expect(run(STATE, proj, ["complete-workflow", LAST]).rc).toBe(0);
  const text = state(proj);
  expect(field(text, "Status")).toBe("Completed");
  expect(field(text, "Current Stage")).toBe(LAST);
  // The registry row as a real completion leaves it.
  setRegistryStatus(proj, "complete");
  expect(registryRow(proj).status).toBe("complete");
  return proj;
}

/** Run the scope change a print names, as the agent would: the dispatcher line, through the dist tool. */
function actOnScopeChangePrint(proj: string, directive: Directive): string {
  expect(directive.kind, JSON.stringify(directive)).toBe("print");
  const m = /`bun \.claude\/tools\/aidlc\.ts engine scope change --scope ([a-z-]+)`/.exec(directive.message ?? "");
  expect(m, directive.message).not.toBeNull();
  const res = run(UTILITY, proj, ["scope-change", "--scope", m![1]]);
  expect(res.rc, res.out).toBe(0);
  return res.out;
}

const CARRY_ON = "print its output verbatim and re-run next to carry on with the work.";
const STOP = "print its output verbatim and stop.";

describe("t-scope-change-reopens-finished-work: a scope switch on finished work starts the stage it adds (#2261)", () => {
  test("the scope change reopens finished work at the first stage the new scope adds after the last one", () => {
    const proj = finishedBugfix();
    const before = events(proj);
    const said = run(UTILITY, proj, ["scope-change", "--scope", "express"]);
    expect(said.rc, said.out).toBe(0);
    expect(said.out).toContain("Switched to express");

    const text = state(proj);
    expect(field(text, "Scope")).toBe("express");
    expect(field(text, "Status")).toBe("Running");
    expect(field(text, "Current Stage")).toBe(ADDED);
    expect(box(text, ADDED)).toBe("-");
    expect(field(text, "In Progress")).toBe(ADDED);
    expect(field(text, "Active Agent")).toBe("aidlc-operations-agent");
    expect(field(text, "Lifecycle Phase")).toBe("OPERATION");
    expect(field(text, "Next Stage")).toBe("none");
    expect(field(text, "Next Action")).toBe("Execute Observability Setup");
    expect(field(text, "Operation")).toBe("Active");
    // What the person approved stands.
    expect(box(text, LAST)).toBe("x");
    expect(field(text, "Last Completed Stage")).toBe(LAST);

    const added = events(proj).slice(before.length);
    expect(added).toContain("SCOPE_CHANGED");
    expect(added).toContain(`STAGE_STARTED:${ADDED}`);
    expect(added.indexOf("SCOPE_CHANGED")).toBeLessThan(added.indexOf(`STAGE_STARTED:${ADDED}`));
    expect(added.filter((e) => /^(GATE_APPROVED|GATE_REJECTED|STAGE_COMPLETED|WORKFLOW_COMPLETED)/.test(e))).toEqual([]);

    const row = registryRow(proj);
    expect(row.status).toBe("in-flight");
    expect(row.scope).toBe("express");
  });

  // Part C (Arden 2026-10-12): a WORKFLOW_COMPLETED followed by a later
  // STAGE_STARTED is a reopened run, not a torn write, on both doctor surfaces.
  test("doctor reads the reopened run as a run, not as drift from the earlier completion", () => {
    const proj = finishedBugfix();
    expect(run(UTILITY, proj, ["scope-change", "--scope", "express"]).rc).toBe(0);
    expect(field(state(proj), "Status")).toBe("Running");
    const after = doctor(proj);
    expect(after.out).not.toContain("State/audit drift");
    expect(after.out).not.toContain("state-audit-drift");
    expect(after.out).not.toContain("Audit recorded WORKFLOW_COMPLETED");
  });

  // AIDA F2 on #2369: a team clone reads every shard, joined in file-name
  // order. A teammate's shard that sorts after this clone's own, holding the
  // completion recorded before the reopen, is no drift either: events are read
  // in time order, as the doctor bundle's own rule reads them.
  test("in a team clone, a teammate's shard that sorts after this clone's and holds the earlier completion is not drift", () => {
    const proj = finishedBugfix();
    const audit = join(recordDir(proj), "audit");
    const own = readdirSync(audit).filter((f) => f.endsWith(".md")).sort();
    expect(own.length).toBe(1);
    const completedAt = /\*\*Timestamp\*\*: (\S+)\n\*\*Event\*\*: WORKFLOW_COMPLETED/.exec(readFileSync(join(audit, own[0]), "utf-8"))?.[1];
    expect(completedAt).toBeDefined();
    const teammate = "zz-host-abcd.md";
    expect([own[0], teammate].sort().at(-1)).toBe(teammate);
    expect(run(UTILITY, proj, ["scope-change", "--scope", "express"]).rc).toBe(0);
    expect(field(state(proj), "Status")).toBe("Running");
    const before = new Date(Date.parse(completedAt!) - 60_000).toISOString().replace(/\.\d{3}Z$/, "Z");
    writeFileSync(join(audit, teammate),
      "# AI-DLC Audit Log\n\n## Workflow Completion\n" +
        `**Timestamp**: ${before}\n**Event**: WORKFLOW_COMPLETED\n**Scope**: bugfix\n` +
        "**Details**: Scope: bugfix, completed on a teammate's clone\n\n---\n", "utf-8");
    const after = doctor(proj);
    expect(after.out).not.toContain("State/audit drift");
    expect(after.out).not.toContain("state-audit-drift");
    expect(after.out).not.toContain("set Status=Completed");
  });

  test("a real torn write after the completion is still flagged by both doctor surfaces", () => {
    const proj = finishedBugfix();
    // The state write was lost after WORKFLOW_COMPLETED landed: nothing started since.
    expect(run(STATE, proj, ["set", "Status=Running"]).rc).toBe(0);
    const torn = doctor(proj);
    expect(torn.out).toContain("State/audit drift: audit has WORKFLOW_COMPLETED but state Status=Running");
    expect(torn.out).toContain("state-audit-drift");
    expect(torn.rc).toBe(1);
  });

  // The agent goes straight on into the reopened stage, so what the switch did
  // (the switch line, every setting the new scope changed) is said with the
  // stage's first line, as a backward jump's notice is: a live Claude Code run
  // on the carry-on print said the stage's line and never the switch's.
  test("with a chat, what the switch did is said with the reopened stage's first line", async () => {
    const lib = await import(LIB) as typeof import("../../dist/claude/.claude/tools/aidlc-lib.ts");
    env = { ...noChat, AIDLC_SESSION_OVERRIDE: SESSION };
    const proj = finishedBugfix();
    expect(next(proj, ["--scope", "express"]).message).toContain(CARRY_ON);
    const changed = run(UTILITY, proj, ["scope-change", "--scope", "express"]);
    expect(changed.rc, changed.out).toBe(0);
    expect(changed.stdout).not.toContain("Switched to");
    const kept = lib.pendingPersonLines(proj, SESSION).lines.join(" ");
    expect(kept).toContain("Switched to express");
    expect(kept).toContain("Plan Approval changed: on (from scope bugfix) to off (from scope express).");
    expect(kept).toContain("Each code plan is now built without asking you first.");

    const step = next(proj);
    expect(step.kind, JSON.stringify(step)).toBe("run-stage");
    expect(step.stage).toBe(ADDED);
    const said = step.narration ?? "";
    expect(said.startsWith("Switched to express"), said).toBe(true);
    expect(said).toContain("Plan Approval changed: on (from scope bugfix) to off (from scope express).");
    expect(said.endsWith("Now working on Observability Setup (stage 6 of 6), wearing the operations engineer hat."), said).toBe(true);
    // Said once: the next step does not say it again.
    expect(lib.pendingPersonLines(proj, SESSION).lines).toEqual([]);
    expect(next(proj).narration ?? "").not.toContain("Switched to");
  });

  test("a new scope that adds nothing after the last stage leaves finished work finished", () => {
    const proj = finishedBugfix();
    const before = events(proj);
    // security-patch adds nfr-requirements, which is behind the cursor.
    expect(run(UTILITY, proj, ["scope-change", "--scope", "security-patch"]).rc).toBe(0);
    const text = state(proj);
    expect(field(text, "Scope")).toBe("security-patch");
    expect(field(text, "Status")).toBe("Completed");
    expect(field(text, "Current Stage")).toBe(LAST);
    expect(box(text, "nfr-requirements")).toBe(" ");
    expect(events(proj).slice(before.length).filter((e) => e.startsWith("STAGE_STARTED"))).toEqual([]);
    expect(registryRow(proj).status).toBe("complete");
    expect(next(proj).kind).toBe("done");
  });

  test("next tells the agent to carry on into the added stage, and still stops where nothing is added or the work runs", () => {
    const finished = finishedBugfix();
    const carry = next(finished, ["--scope", "express"]);
    expect(carry.kind).toBe("print");
    expect(carry.message).toContain("engine scope change --scope express");
    expect(carry.message).toContain(CARRY_ON);
    expect(carry.message).not.toMatch(/\bstop\b/);

    const nothingAdded = next(finished, ["--scope", "security-patch"]);
    expect(nothingAdded.kind).toBe("print");
    expect(nothingAdded.message).toContain("engine scope change --scope security-patch");
    expect(nothingAdded.message).toContain(STOP);

    const running = createOrchestrationTestProject();
    created.push(running);
    seedStateFile(running, "state-mid-ideation.md");
    const stops = next(running, ["--scope", "mvp"]);
    expect(stops.kind).toBe("print");
    expect(stops.message).toContain(`to change scope, then ${STOP}`);
  });

  // The deadlock check: from the switch, the chain reaches the added stage
  // within 3 engine calls, repeats no print, asks nothing, and the stage's gate
  // opens and closes once like any other. Agents re-run the flagged command as
  // often as a bare `next`; the same scope then falls through to Branch 10.
  for (const rerun of [[], ["--scope", "express"]] as const) {
    test(`after the switch, \`next${rerun.length ? " " + rerun.join(" ") : ""}\` runs the added stage and its gate opens`, () => {
      const proj = finishedBugfix();
      const prints: string[] = [];
      let calls = 0;
      const switched = next(proj, ["--scope", "express"]);
      calls++;
      prints.push(switched.message ?? "");
      expect(actOnScopeChangePrint(proj, switched)).toContain("Switched to express");
      const step = next(proj, [...rerun]);
      calls++;
      expect(step.kind, JSON.stringify(step)).toBe("run-stage");
      expect(step.stage).toBe(ADDED);
      expect(calls).toBeLessThanOrEqual(3);
      expect(new Set(prints).size).toBe(prints.length);
      expect(field(state(proj), "Status")).toBe("Running");

      // The stage writes what it produces, then its gate opens and is approved once.
      for (const rel of step.produces ?? []) {
        const abs = join(proj, ...rel.split("/"));
        mkdirSync(dirname(abs), { recursive: true });
        if (!existsSync(abs)) writeFileSync(abs, rel.endsWith("-questions.md") ? "# Questions\n\nNone.\n" : `# ${rel}\n\nWritten.\n`, "utf-8");
      }
      const gate = report(proj, ADDED, ["--result", "awaiting-approval"]);
      expect(gate.kind, JSON.stringify(gate)).not.toBe("error");
      expect(JSON.stringify(gate)).not.toContain("is pending");
      expect(box(state(proj), ADDED)).toBe("?");
      const approved = report(proj, ADDED, ["--result", "approved", "--user-input", "Approve"]);
      expect(approved.kind, JSON.stringify(approved)).not.toBe("error");
      const after = state(proj);
      expect(box(after, ADDED)).toBe("x");
      expect(field(after, "Status")).toBe("Completed");
      expect(next(proj).kind).toBe("done");
      // The earlier approval was never asked again.
      const all = events(proj);
      expect(all.filter((e) => e === `GATE_APPROVED:${LAST}`).length).toBe(0);
      expect(all.filter((e) => e === `GATE_APPROVED:${ADDED}`).length).toBe(1);
    });
  }

  test("one predicate decides both the print and the reopen", async () => {
    const lib = await import(LIB) as typeof import("../../dist/claude/.claude/tools/aidlc-lib.ts");
    const finished = finishedBugfix();
    const text = state(finished);
    expect(lib.stageReopenedByScopeChange(text, "express")?.slug).toBe(ADDED);
    expect(lib.stageReopenedByScopeChange(text, "security-patch")).toBeNull();
    expect(lib.stageReopenedByScopeChange(text, "bugfix")).toBeNull();
    const running = createOrchestrationTestProject();
    created.push(running);
    seedStateFile(running, "state-mid-ideation.md");
    expect(lib.stageReopenedByScopeChange(state(running), "mvp")).toBeNull();

    // Both the router and the tool read it, so they can never disagree.
    expect(readFileSync(join(TOOLS, "aidlc-orchestrate.ts"), "utf-8")).toContain("stageReopenedByScopeChange(");
    expect(readFileSync(join(TOOLS, "aidlc-utility.ts"), "utf-8")).toContain("stageReopenedByScopeChange(");

    // Every shipped scope over finished bugfix: the print carries on exactly when the tool reopens.
    const scopes = Object.keys(lib.loadScopeMapping()).filter((s) => s !== "bugfix").sort();
    expect(scopes.length).toBeGreaterThan(5);
    for (const scope of scopes) {
      const proj = finishedBugfix();
      const predicted = lib.stageReopenedByScopeChange(state(proj), scope);
      const print = next(proj, ["--scope", scope]);
      expect(print.kind, `${scope}: ${JSON.stringify(print)}`).toBe("print");
      expect(run(UTILITY, proj, ["scope-change", "--scope", scope]).rc).toBe(0);
      const after = state(proj);
      const reopened = field(after, "Status") === "Running";
      expect(print.message?.includes(CARRY_ON) ?? false, `${scope}: ${print.message}`).toBe(reopened);
      expect(predicted !== null, scope).toBe(reopened);
      if (predicted) {
        expect(field(after, "Current Stage"), scope).toBe(predicted.slug);
        expect(box(after, predicted.slug), scope).toBe("-");
        expect(events(proj).at(-1), scope).toBe(`STAGE_STARTED:${predicted.slug}`);
      }
    }
  });
});
