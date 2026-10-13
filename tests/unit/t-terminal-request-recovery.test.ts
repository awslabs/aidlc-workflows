// covers: function:saveMessage, function:resumeTerminalMutation, subcommand:aidlc-utility:config-change, subcommand:aidlc-utility:intent-create
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { latestMessage, listMessages, saveMessage } from "../../core/tools/aidlc-message-store.ts";
import { applyTerminalMutation, currentTerminalRequest, resumeTerminalMutation, takeTerminalRequest, terminalOperation } from "../../core/tools/aidlc-terminal-request.ts";
import { auditBlockField, markHumanTurn, readAuditShardEvents, readIntentRegistry, readSessionBinding, turnMarkersShowConversational, withAuditLock, writeSessionBinding } from "../../core/tools/aidlc-lib.ts";
import { AIDLC_SRC, cleanupTestProject, createOrchestrationTestProject, FIXTURES_DIR, REPO_ROOT, seededRecordDir, seededStateFile } from "../harness/fixtures.ts";
import { env, exec, SESSION } from "../harness/aidlc-input-corpus.ts";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS } from "../harness/test-budget.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
const projects: string[] = [];
afterEach(() => { for (const project of projects.splice(0)) cleanupTestProject(project); });
function fixture() {
  const project = createOrchestrationTestProject();
  projects.push(project);
  writeFileSync(seededStateFile(project), readFileSync(join(FIXTURES_DIR, "state-completed.md"), "utf8"));
  const selection = { space: "default", intent: basename(seededRecordDir(project)), sessionId: SESSION };
  writeSessionBinding(project, SESSION, selection.space, selection.intent, "create");
  return { project, selection };
}
function prompt(project: string, text = "/aidlc --plan-approval off", at = new Date().toISOString()) {
  return saveMessage(project, {
    session: SESSION, at, source: "prompt", text, words: null, picker: null,
    settings: [{ key: "plan-approval", value: "off" }],
    route: { scope: null, newIntent: false, skip: [], add: [], projectType: null },
    workflow: { space: "default", intent: basename(seededRecordDir(project)), status: "Completed" },
  });
}
function utility(project: string, args: string[], extra: Record<string, string> = {}) {
  return exec([process.execPath, join(REPO_ROOT, "core", "tools", "aidlc-utility.ts"), ...args, "--project-dir", project], {
    cwd: project,
    env: env(project, { env: {
      AIDLC_STAGE_GRAPH: join(AIDLC_SRC, "tools", "data", "stage-graph.json"),
      AIDLC_SCOPE_GRID: join(AIDLC_SRC, "tools", "data", "scope-grid.json"),
      AIDLC_SCOPES_DIR: join(AIDLC_SRC, "scopes"),
      ...extra,
    } }),
  });
}
const output = (result: { stdout: string; stderr: string }) => result.stdout + result.stderr;
function journals(project: string) {
  const directory = join(project, "aidlc", ".aidlc-sessions", "terminal-requests");
  return readdirSync(directory).filter(name => name.endsWith(".taken")).map(name => {
    const path = join(directory, name);
    return { path, value: JSON.parse(readFileSync(path, "utf8")) };
  });
}

describe("terminal request intake order", () => {
  test("equal timestamps preserve arrival order and supersede the old proof", () => {
    const { project, selection } = fixture();
    const at = new Date().toISOString();
    const first = prompt(project, "/aidlc --plan-approval off", at);
    const proof = currentTerminalRequest(project, selection, "settings")!;
    const second = prompt(project, "/aidlc --new-intent --scope bugfix fix parser", at);
    expect(second.sequence).toBeGreaterThan(first.sequence!);
    expect(latestMessage(project, SESSION)?.id).toBe(second.id);
    expect(takeTerminalRequest(project, proof, "settings")).toBe(false);
    expect(listMessages(project).map(message => message.id)).toEqual([first.id, second.id]);
  });
  test("concurrent writers allocate unique ordered receipts", async () => {
    const { project } = fixture();
    const script = join(project, "intake.ts");
    writeFileSync(script, `import { saveMessage } from ${JSON.stringify(join(REPO_ROOT, "core/tools/aidlc-message-store.ts"))};
saveMessage(process.argv[2], JSON.parse(process.argv[3]));`);
    const seed = prompt(project);
    const { id: _id, sequence: _sequence, ...message } = seed;
    const results = await Promise.all(Array.from({ length: 8 }, (_, index) => exec([
      process.execPath, script, project, JSON.stringify({ ...message, text: `message ${index}` }),
    ], { cwd: project, env: env(project) })));
    for (const result of results) expect(result.status, output(result)).toBe(0);
    const records = listMessages(project);
    expect(new Set(records.map(message => message.sequence)).size).toBe(9);
    expect(latestMessage(project, SESSION)?.sequence).toBe(9);
  });
  test("a real completion preserves the prompt waiting behind it as a terminal request", async () => {
    const { project, selection } = fixture();
    writeFileSync(seededStateFile(project), readFileSync(seededStateFile(project), "utf8").replace("**Status**: Completed", "**Status**: Running"));
    const script = join(project, "complete-with-prompt.ts");
    const tools = join(REPO_ROOT, "core", "tools");
    writeFileSync(script, `
import { withAuditLock } from ${JSON.stringify(join(tools, "aidlc-lib.ts"))};
import { latestMessage } from ${JSON.stringify(join(tools, "aidlc-message-store.ts"))};
import { main } from ${JSON.stringify(join(tools, "aidlc-state.ts"))};
import { writeFileSync } from "node:fs";
const project = process.argv[2], session = ${JSON.stringify(SESSION)};
const payload = project + "/prompt.json";
writeFileSync(payload, JSON.stringify({hook_event_name:"UserPromptSubmit",session_id:session,cwd:project,
  prompt:"/aidlc --new-intent --scope bugfix --plan-approval off fix parser"}));
let child, seen=false;
withAuditLock(project, () => {
  child=Bun.spawn([process.execPath,${JSON.stringify(join(tools, "aidlc.ts"))},"engine","hook","record-human-turn"],
    {cwd:project,env:process.env,stdin:Bun.file(payload),stdout:"pipe",stderr:"pipe"});
  const deadline=Date.now()+10000;
  while(Date.now()<deadline) {
    if(latestMessage(project,session)!==null){seen=true;break;}
    Bun.sleepSync(10);
  }
  if(!seen) throw new Error("prompt did not reach intake");
  main(["complete-workflow","feedback-optimization","--project-dir",project]);
});
const result=await child.exited;
if(result!==0) throw new Error(await new Response(child.stderr).text());
`);
    const completed = await exec([process.execPath, script, project], { cwd: project, env: env(project, { env: {
      AIDLC_STAGE_GRAPH: join(AIDLC_SRC, "tools", "data", "stage-graph.json"),
      AIDLC_SCOPE_GRID: join(AIDLC_SRC, "tools", "data", "scope-grid.json"),
      AIDLC_SCOPES_DIR: join(AIDLC_SRC, "scopes"),
      AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS: "1",
      AIDLC_SKIP_ARTIFACT_GUARD: "1",
      AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "1",
      AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD: "1",
    } }) });
    expect(completed.status, output(completed)).toBe(0);
    expect(readFileSync(seededStateFile(project), "utf8")).toContain("**Status**: Completed");
    expect(readAuditShardEvents(project).some(row => row.event === "HUMAN_TURN")).toBe(false);
    expect(currentTerminalRequest(project, selection, "settings")?.workflow.status).toBe("Completed");
    const next = await exec([process.execPath, join(tools, "aidlc-orchestrate.ts"), "next", "--resume", "--project-dir", project], {
      cwd: project, env: env(project, { env: {
        AIDLC_STAGE_GRAPH: join(AIDLC_SRC, "tools", "data", "stage-graph.json"),
        AIDLC_SCOPE_GRID: join(AIDLC_SRC, "tools", "data", "scope-grid.json"),
        AIDLC_SCOPES_DIR: join(AIDLC_SRC, "scopes"),
      } }),
    });
    expect(next.status, output(next)).toBe(0);
    expect(next.stdout).toContain("--request");
    expect((await utility(project, ["config-change", "--plan-approval", "off"])).status).toBe(0);
  });
});

describe("terminal operations resume their saved application", () => {
  for (const point of ["before-audit", "after-audit", "after-state", "before-finalize"]) {
    test(`settings recover ${point} without duplicate audit or later replay`, async () => {
      const { project } = fixture();
      prompt(project);
      const args = ["config-change", "--plan-approval", "off"];
      const failed = await utility(project, args, { AIDLC_TEST_TERMINAL_MUTATION_FAIL_AT: point });
      expect(failed.status, output(failed)).not.toBe(0);
      const retry = await utility(project, args);
      expect(retry.status, output(retry)).toBe(0);
      expect(readFileSync(seededStateFile(project), "utf8")).toContain("Plan Approval**: off (set by you)");
      const rows = readAuditShardEvents(project).filter(row => Boolean(auditBlockField(row.block, "Request Operation")));
      expect(rows).toHaveLength(1);
      expect((await utility(project, ["config-change", "--plan-approval", "on"])).status).toBe(0);
      expect((await utility(project, args)).status).not.toBe(0);
    });
    test(`creation recovers ${point} into one record`, async () => {
      const { project } = fixture();
      prompt(project);
      const args = ["intent-create", "--scope", "bugfix", "--label", "new parser", "--arguments", "fix parser", "--plan-approval", "off"];
      const failed = await utility(project, args, { AIDLC_TEST_TERMINAL_MUTATION_FAIL_AT: point });
      expect(failed.status, output(failed)).not.toBe(0);
      const retry = await utility(project, args);
      expect(retry.status, output(retry)).toBe(0);
      const intents = join(project, "aidlc", "spaces", "default", "intents");
      const active = readFileSync(join(intents, "active-intent"), "utf8").trim();
      expect(active).not.toBe(basename(seededRecordDir(project)));
      const directories = readdirSync(intents, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name);
      expect(directories).toHaveLength(2);
      const rows = readAuditShardEvents(project, active, "default");
      expect(rows.filter(row => row.event === "WORKFLOW_STARTED")).toHaveLength(1);
      const again = await utility(project, args);
      expect(again.status, output(again)).toBe(0);
      expect(readdirSync(intents, { withFileTypes: true }).filter(entry => entry.isDirectory())).toHaveLength(2);
    });
    test(`scope recovers ${point} without duplicate audit`, async () => {
      const { project } = fixture();
      prompt(project);
      const args = ["scope-change", "--scope", "bugfix", "--plan-approval", "off"];
      const failed = await utility(project, args, { AIDLC_TEST_TERMINAL_MUTATION_FAIL_AT: point });
      expect(failed.status, output(failed)).not.toBe(0);
      const retry = await utility(project, args);
      expect(retry.status, output(retry)).toBe(0);
      expect(readFileSync(seededStateFile(project), "utf8")).toContain("Scope**: bugfix");
      const rows = readAuditShardEvents(project).filter(row => Boolean(auditBlockField(row.block, "Request Operation")));
      const entries = rows.map(row => auditBlockField(row.block, "Request Entry"));
      expect(entries.length).toBeGreaterThan(0);
      expect(new Set(entries).size).toBe(entries.length);
    });
  }
  test("an actual read-only state failure remains retryable after repair", async () => {
    const { project } = fixture();
    prompt(project);
    const before = readFileSync(seededStateFile(project), "utf8");
    chmodSync(seededStateFile(project), 0o444);
    const failed = await utility(project, ["config-change", "--plan-approval", "off"]);
    expect(failed.status, output(failed)).not.toBe(0);
    expect(readFileSync(seededStateFile(project), "utf8")).toBe(before);
    chmodSync(seededStateFile(project), 0o644);
    expect((await utility(project, ["config-change", "--plan-approval", "off"])).status).toBe(0);
  });
  test("a changed state cannot be overwritten by an interrupted operation", async () => {
    const { project } = fixture();
    prompt(project);
    await utility(project, ["config-change", "--plan-approval", "off"], { AIDLC_TEST_TERMINAL_MUTATION_FAIL_AT: "after-audit" });
    const newer = `${readFileSync(seededStateFile(project), "utf8")}\nNew explicit state edit\n`;
    writeFileSync(seededStateFile(project), newer);
    const retry = await utility(project, ["config-change", "--plan-approval", "off"]);
    expect(retry.status, output(retry)).not.toBe(0);
    expect(readFileSync(seededStateFile(project), "utf8")).toBe(newer);
  });
  test("restoring identical pre-operation bytes cannot revive an already applied request", async () => {
    const { project } = fixture();
    prompt(project);
    const before = readFileSync(seededStateFile(project), "utf8");
    const args = ["config-change", "--plan-approval", "off"];
    await utility(project, args, { AIDLC_TEST_TERMINAL_MUTATION_FAIL_AT: "after-state" });
    writeFileSync(seededStateFile(project), before);
    const retry = await utility(project, args);
    expect(retry.status, output(retry)).not.toBe(0);
    expect(output(retry)).toContain("state was rewritten");
    expect(readFileSync(seededStateFile(project), "utf8")).toBe(before);
  });
  test("concurrent retries apply one audit batch", async () => {
    const { project } = fixture();
    prompt(project);
    const args = ["config-change", "--plan-approval", "off"];
    const results = await Promise.all([utility(project, args), utility(project, args)]);
    for (const result of results) expect(result.status, output(result)).toBe(0);
    const rows = readAuditShardEvents(project).filter(row => Boolean(auditBlockField(row.block, "Request Operation")));
    expect(rows).toHaveLength(1);
  });
  test("a successful settings no-op also spends its prompt", async () => {
    const { project } = fixture();
    prompt(project);
    const args = ["config-change", "--plan-approval", "off"];
    expect((await utility(project, args)).status).toBe(0);
    prompt(project);
    const before = readFileSync(seededStateFile(project), "utf8");
    expect((await utility(project, args)).status).toBe(0);
    expect(readFileSync(seededStateFile(project), "utf8")).toBe(before);
    expect((await utility(project, ["config-change", "--plan-approval", "on"])).status).toBe(0);
    expect((await utility(project, args)).status).not.toBe(0);
  });
  test("flat terminal selections recover without drifting to the shared cursor", async () => {
    const { project } = fixture();
    const original = readFileSync(seededStateFile(project), "utf8");
    const flat = join(project, "aidlc", "spaces", "default", "intents", "aidlc-state.md");
    writeFileSync(flat, original);
    writeSessionBinding(project, SESSION, "default", null, "create");
    const message = prompt(project);
    const { id: _id, sequence: _sequence, ...copy } = message;
    saveMessage(project, { ...copy, workflow: { space: "default", intent: null, status: "Completed" } });
    const args = ["config-change", "--plan-approval", "off"];
    const failed = await utility(project, args, { AIDLC_TEST_TERMINAL_MUTATION_FAIL_AT: "after-audit" });
    expect(failed.status, output(failed)).not.toBe(0);
    const retry = await utility(project, args);
    expect(retry.status, output(retry)).toBe(0);
    expect(readFileSync(flat, "utf8")).toContain("Plan Approval**: off (set by you)");
    expect(readFileSync(seededStateFile(project), "utf8")).toBe(original);
  });
  test("retry preserves the unattended and later team-policy restrictions", async () => {
    const { project } = fixture();
    prompt(project);
    const args = ["config-change", "--plan-approval", "off"];
    const before = readFileSync(seededStateFile(project), "utf8");
    await utility(project, args, { AIDLC_TEST_TERMINAL_MUTATION_FAIL_AT: "after-audit" });
    const unattended = await utility(project, args, { AIDLC_UNATTENDED: "1" });
    expect(unattended.status, output(unattended)).not.toBe(0);
    expect(readFileSync(seededStateFile(project), "utf8")).toBe(before);
    const memory = join(project, "aidlc", "spaces", "default", "memory");
    mkdirSync(memory, { recursive: true });
    writeFileSync(join(memory, "project.md"), "# Project\n\n## Guard Policy\n\nMode: strict\n");
    const locked = await utility(project, args);
    expect(locked.status, output(locked)).not.toBe(0);
    expect(output(locked)).toContain("plan approval stays on for everyone");
    expect(readFileSync(seededStateFile(project), "utf8")).toBe(before);
  });
  test("completed and archived records still refuse recompose before settings can change", async () => {
    for (const status of ["Completed", "Archived"]) {
      const { project } = fixture();
      const before = readFileSync(seededStateFile(project), "utf8").replace("**Status**: Completed", `**Status**: ${status}`);
      writeFileSync(seededStateFile(project), before);
      prompt(project);
      const result = await utility(project, ["recompose", "--skip", "feedback-optimization", "--summary-confirmation", "off"]);
      expect(result.status, output(result)).not.toBe(0);
      expect(readFileSync(seededStateFile(project), "utf8")).toBe(before);
    }
  });
  test("a later policy lock does not prevent finalizing state that already committed", async () => {
    const { project } = fixture();
    prompt(project);
    const args = ["config-change", "--plan-approval", "off"];
    await utility(project, args, { AIDLC_TEST_TERMINAL_MUTATION_FAIL_AT: "after-state" });
    const committed = readFileSync(seededStateFile(project), "utf8");
    writeFileSync(join(project, "aidlc", "spaces", "default", "memory", "project.md"), "# Project\n\n## Guard Policy\n\nMode: strict\n");
    const retry = await utility(project, args);
    expect(retry.status, output(retry)).toBe(0);
    expect(readFileSync(seededStateFile(project), "utf8")).toBe(committed);
  });
  test("an oversized plan fails before spending the prompt", async () => {
    const { project, selection } = fixture();
    prompt(project);
    const before = `${readFileSync(seededStateFile(project), "utf8")}\n${"Large retained state note ".repeat(100_000)}\n`;
    writeFileSync(seededStateFile(project), before);
    const result = await utility(project, ["config-change", "--plan-approval", "off"]);
    expect(result.status, output(result)).not.toBe(0);
    expect(output(result)).toContain("too large to save safely");
    expect(readFileSync(seededStateFile(project), "utf8")).toBe(before);
    expect(journals(project)).toHaveLength(0);
    expect(currentTerminalRequest(project, selection, "settings")).not.toBeNull();
  });
  test("a superseded committed creation repairs its registry without moving the newer binding", async () => {
    const { project } = fixture();
    prompt(project);
    const args = ["intent-create", "--scope", "bugfix", "--label", "interrupted parser", "--arguments", "fix parser", "--plan-approval", "off"];
    const failed = await utility(project, args, { AIDLC_TEST_TERMINAL_MUTATION_FAIL_AT: "after-state" });
    expect(failed.status, output(failed)).not.toBe(0);
    const journal = journals(project)[0]!;
    const created = journal.value.plan.creation.created;
    const statePath = join(created.recordDir, "aidlc-state.md");
    const committed = readFileSync(statePath, "utf8");
    expect(readIntentRegistry(project, "default").some(row => row.uuid === created.uuid)).toBe(false);
    prompt(project, "Start the other task now");
    const other = await utility(project, ["intent-create", "--scope", "bugfix", "--label", "other task", "--arguments", "handle the other task"]);
    expect(other.status, output(other)).toBe(0);
    const binding = readSessionBinding(project, SESSION);
    const cursor = readFileSync(join(project, "aidlc", "spaces", "default", "intents", "active-intent"), "utf8");
    // The journal carries no prompt words and remains useful after inbox pruning.
    rmSync(join(project, "aidlc", ".aidlc-sessions", "messages"), { recursive: true, force: true });
    expect(latestMessage(project, SESSION)).toBeNull();
    const retry = await utility(project, args);
    expect(retry.status, output(retry)).toBe(0);
    expect(readIntentRegistry(project, "default").filter(row => row.uuid === created.uuid)).toHaveLength(1);
    expect(readSessionBinding(project, SESSION)).toEqual(binding);
    expect(readFileSync(join(project, "aidlc", "spaces", "default", "intents", "active-intent"), "utf8")).toBe(cursor);
    expect(readFileSync(statePath, "utf8")).toBe(committed);
    expect(journals(project)[0]!.value.phase).toBe("applied");
    expect(readAuditShardEvents(project, created.dirName, "default").filter(row => row.event === "WORKFLOW_STARTED")).toHaveLength(1);
  });
  test("supersession cannot revive an old pre-state mutation", async () => {
    const { project } = fixture();
    prompt(project);
    const args = ["config-change", "--plan-approval", "off"];
    const before = readFileSync(seededStateFile(project), "utf8");
    await utility(project, args, { AIDLC_TEST_TERMINAL_MUTATION_FAIL_AT: "after-audit" });
    const saved = journals(project)[0]!;
    const latest = prompt(project, "Explain the result");
    // A normal later prompt carries no authority for the historical record.
    const { id: _id, sequence: _sequence, workflow: _workflow, ...ordinary } = latest;
    saveMessage(project, ordinary);
    const retry = await utility(project, args);
    expect(retry.status, output(retry)).not.toBe(0);
    expect(readFileSync(seededStateFile(project), "utf8")).toBe(before);
    expect(JSON.parse(readFileSync(saved.path, "utf8")).phase).toBe("pending");
  });
  test("an explicit pick after committed creation survives retry without a newer prompt", async () => {
    const { project } = fixture();
    const receipt = prompt(project);
    const args = ["intent-create", "--scope", "bugfix", "--label", "interrupted parser", "--arguments", "fix parser", "--plan-approval", "off"];
    expect((await utility(project, args, { AIDLC_TEST_TERMINAL_MUTATION_FAIL_AT: "after-state" })).status).not.toBe(0);
    const created = journals(project)[0]!.value.plan.creation.created;
    expect((await utility(project, ["intent-create", "--scope", "bugfix", "--label", "other task", "--arguments", "handle other work"])).status).toBe(0);
    const binding = readSessionBinding(project, SESSION);
    const cursor = readFileSync(join(project, "aidlc", "spaces", "default", "intents", "active-intent"), "utf8");
    const otherMarker = join(project, "aidlc", "spaces", "default", "intents", binding!.intent!, ".aidlc-engine", "engine-touch");
    const otherMarkerBefore = statSync(otherMarker, { bigint: true }).mtimeNs;
    expect(latestMessage(project, SESSION)?.id).toBe(receipt.id);
    const retry = await utility(project, args);
    expect(retry.status, output(retry)).toBe(0);
    expect(readIntentRegistry(project, "default").filter(row => row.uuid === created.uuid)).toHaveLength(1);
    expect(readSessionBinding(project, SESSION)).toEqual(binding);
    expect(readFileSync(join(project, "aidlc", "spaces", "default", "intents", "active-intent"), "utf8")).toBe(cursor);
    expect(statSync(otherMarker, { bigint: true }).mtimeNs).toBe(otherMarkerBefore);
    expect(existsSync(join(created.recordDir, ".aidlc-engine", "engine-touch"))).toBe(true);
  });
  for (const humanBeforeRecovery of [false, true]) {
  test(`creation recovery seeds turn evidence once with a human turn ${humanBeforeRecovery ? "before" : "after"} recovery`, async () => {
    const { project } = fixture();
    prompt(project);
    const args = ["intent-create", "--scope", "bugfix", "--label", "recovered parser", "--arguments", "fix parser", "--plan-approval", "off"];
    expect((await utility(project, args, { AIDLC_TEST_TERMINAL_MUTATION_FAIL_AT: "after-state" })).status).not.toBe(0);
    const created = journals(project)[0]!.value.plan.creation.created;
    const marker = join(created.recordDir, ".aidlc-engine", "engine-touch");
    const humanMarker = join(created.recordDir, ".aidlc-engine", "human-turn");
    expect(existsSync(marker)).toBe(false);
    if (humanBeforeRecovery) markHumanTurn(project, created.dirName, created.space);
    const originalHuman = humanBeforeRecovery ? statSync(humanMarker, { bigint: true }).mtimeNs : null;
    expect((await utility(project, args)).status).toBe(0);
    expect(existsSync(marker)).toBe(true);
    const markerBefore = statSync(marker, { bigint: true }).mtimeNs;
    if (originalHuman !== null) expect(statSync(humanMarker, { bigint: true }).mtimeNs).toBe(originalHuman);
    else {
      markHumanTurn(project, created.dirName, created.space);
      const later = new Date(statSync(marker).mtimeMs + 1000);
      utimesSync(humanMarker, later, later);
    }
    expect(turnMarkersShowConversational(project, created.dirName, created.space)).toBe(true);
    expect((await utility(project, args)).status).toBe(0);
    expect(statSync(marker, { bigint: true }).mtimeNs).toBe(markerBefore);
    expect(turnMarkersShowConversational(project, created.dirName, created.space)).toBe(true);
  });
  }
  test("superseded committed settings finalize without restoring later edits", async () => {
    const { project } = fixture();
    prompt(project);
    const args = ["config-change", "--plan-approval", "off"];
    await utility(project, args, { AIDLC_TEST_TERMINAL_MUTATION_FAIL_AT: "after-state" });
    const committed = readFileSync(seededStateFile(project), "utf8");
    const latest = prompt(project, "Explain the result");
    const { id: _id, sequence: _sequence, workflow: _workflow, ...ordinary } = latest;
    saveMessage(project, ordinary);
    const retry = await utility(project, args);
    expect(retry.status, output(retry)).toBe(0);
    expect(readFileSync(seededStateFile(project), "utf8")).toBe(committed);
    expect(journals(project)[0]!.value.phase).toBe("applied");
    expect((await utility(project, ["config-change", "--plan-approval", "on"])).status).toBe(0);
    const newer = `${readFileSync(seededStateFile(project), "utf8")}\nNewer explicit edit\n`;
    writeFileSync(seededStateFile(project), newer);
    expect((await utility(project, args)).status).not.toBe(0);
    expect(readFileSync(seededStateFile(project), "utf8")).toBe(newer);
  });
  for (const tampered of [false, true]) {
    test(`committed recovery checks the audit emitter's normalized fields${tampered ? " and rejects tampering" : ""}`, () => {
      const { project, selection } = fixture();
      prompt(project);
      const receipt = currentTerminalRequest(project, selection, "settings")!;
      const operation = terminalOperation("audit-field-recovery", {});
      const before = readFileSync(seededStateFile(project), "utf8");
      const after = `${before}\nSaved explicit change\n`;
      const oldFault = process.env.AIDLC_TEST_TERMINAL_MUTATION_FAIL_AT;
      process.env.AIDLC_TEST_TERMINAL_MUTATION_FAIL_AT = "after-state";
      try {
        expect(() => withAuditLock(project, () => applyTerminalMutation(project, receipt, "settings", operation, {
          selection, before, after, settings: {}, output: [],
          audit: [{ eventType: "GUARD_POLICY_SET", fields: { Reason: `First line\r\n${project}/file.ts\u2028Last line` } }],
        }, () => {}))).toThrow("injected terminal request failure");
      } finally {
        if (oldFault === undefined) delete process.env.AIDLC_TEST_TERMINAL_MUTATION_FAIL_AT;
        else process.env.AIDLC_TEST_TERMINAL_MUTATION_FAIL_AT = oldFault;
      }
      prompt(project, "Later prompt");
      if (tampered) {
        const row = readAuditShardEvents(project).find(entry => entry.event === "GUARD_POLICY_SET")!;
        writeFileSync(row.shard, readFileSync(row.shard, "utf8").replace("First line", "Changed value"));
      }
      const recover = () => withAuditLock(project, () =>
        resumeTerminalMutation(project, SESSION, "settings", operation, () => { throw new Error("must not reapply"); }, selection));
      if (tampered) {
        expect(recover).toThrow("audit is incomplete");
        expect(journals(project)[0]!.value.phase).toBe("pending");
      } else {
        expect(recover()?.after).toBe(after);
        expect(journals(project)[0]!.value.phase).toBe("applied");
      }
      expect(readFileSync(seededStateFile(project), "utf8")).toBe(after);
    });
  }
});
