// "Needs fixing" collection over synthetic records: hooks-health, audit events, engine files, resolution pairing,
// containment, the opt-in transcript scan, and the HTTP API.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildHealth, intentHealth } from "../../core/command-center/server/health";
import { listIntents } from "../../core/command-center/server/parse/registry";
import { startServer } from "../../core/command-center/server/index";
import { scanTranscripts } from "../../core/command-center/server/transcripts";
import { AUDIT_HEADER, block, DEFAULT_AUDIT, makeWorkspace } from "./fixtures/make";

const KEY = "default/260811-demo";
const REC = (w: string) => join(w, "aidlc/spaces/default/intents/260811-demo");
const ENG = (w: string) => join(REC(w), ".aidlc-engine");
const NOW = new Date("2026-08-13T23:21:00Z");
const found = (path: string) => ({ path, origin: "pin" as const, root: null, exists: true });
async function put(p: string, body: string) { await mkdir(join(p, ".."), { recursive: true }); await writeFile(p, body); }
async function health(ws: string) {
  const ref = (await listIntents(ws)).find((r) => `${r.space}/${r.dir}` === KEY)!;
  return intentHealth(ws, ref, REC(ws), NOW);
}
const guardAsk = (o: object) => JSON.stringify({ kind: "ask", ask_type: "guard-recovery", response_route: "execute-remedy", question: "?", stage: "functional-design", reason_codes: ["R1"], ...o });

describe("hooks-health", () => {
  test("drops become issues by category; by-design carve-outs are counted, not listed; orphans are resolved", async () => {
    const ws = await makeWorkspace();
    const hh = join(ENG(ws), "hooks-health");
    await put(join(hh, "write-audit-log.last"), "2026-08-12T22:21:00Z\n");
    await put(join(hh, "reviewer-scope.missing-record.last"), "2020-01-01T00:00:00Z\n");
    await put(join(hh, "review-freeze.drops"), "2026-08-12T10:00:00Z\taudit lock contended; REVIEW_FREEZE_BLOCKED row dropped (block still enforced)\n2026-08-12T10:05:00Z\taudit lock contended; REVIEW_FREEZE_BLOCKED row dropped (block still enforced)\n");
    await put(join(hh, "reviewer-scope.drops"), "2026-08-12T11:00:00Z\tignoring an orphaned reviewer dispatch record (older than the freshness window); cleaned it up\n");
    await put(join(hh, "continue-workflow.drops"), "2026-08-12T12:00:00Z\tactive stage x has an unanswered question; allowing the stop (pending-question carve-out)\n");
    const h = await health(ws);
    const lost = h.issues.find((i) => i.kind === "Hook drop · audit write lost")!;
    expect(lost).toMatchObject({ group: "failure", recoverable: "no", count: 2, at: "2026-08-12T10:05:00Z", firstAt: "2026-08-12T10:00:00Z", where: { hook: "review-freeze", hookPhase: "PreToolUse" }, needsFixing: true });
    expect(lost.source.file).toBe("aidlc/spaces/default/intents/260811-demo/.aidlc-engine/hooks-health/review-freeze.drops");
    expect(lost.fix?.source).toBe("hint");
    const orphan = h.issues.find((i) => i.kind === "Hook drop · orphan cleaned up")!;
    expect(orphan.resolved).toEqual({ by: "AIDLC cleaned it up", at: "2026-08-12T11:00:00Z" });
    expect(orphan.needsFixing).toBe(false);
    expect(h.issues.some((i) => i.message.includes("carve-out"))).toBe(false);
    const row = (n: string) => h.hooks.find((r) => r.hook === n)!;
    expect(row("continue-workflow")).toMatchObject({ drops: 0, benignDrops: 1, phase: "Stop", state: "never" });
    expect(row("write-audit-log")).toMatchObject({ state: "ok", lastAt: "2026-08-12T22:21:00Z", phase: "Post" });
    // The rate-limit marker is not a heartbeat and never shows as a hook.
    expect(h.hooks.some((r) => r.hook.includes("missing-record"))).toBe(false);
    expect(h.issues.some((i) => i.kind === "Hook not running")).toBe(false);
  });

  test("a stale heartbeat is a hard stop; frozen hooks are flagged in the table only", async () => {
    const ws = await makeWorkspace(); await put(join(ws, "aidlc/spaces/default/intents/active-intent"), "260811-demo\n");
    const hh = join(ENG(ws), "hooks-health");
    await put(join(hh, "write-audit-log.last"), "2026-08-12T22:10:00Z");
    await put(join(hh, "session-end.last"), "2026-08-10T22:10:00Z");
    const h = await health(ws);
    const hs = h.issues.find((i) => i.kind === "Hook not running")!;
    expect(hs).toMatchObject({ group: "hard-stop", recoverable: "needs-you", needsFixing: true, at: "2026-08-12T22:22:00Z" });
    expect(hs.message).toBe("Hooks last fired 2026-08-12T22:10:00Z, but the workflow last advanced 2026-08-12T22:22:00Z");
    expect(h.hooks.find((r) => r.hook === "write-audit-log")!.state).toBe("stale");
    await put(join(hh, "write-audit-log.last"), "2026-08-12T22:21:00Z");
    const h2 = await health(ws);
    expect(h2.issues.some((i) => i.kind === "Hook not running")).toBe(false);
    expect(h2.hooks.find((r) => r.hook === "session-end")!.state).toBe("frozen");
  });

  test("no heartbeat at all with stage rows is a hard stop (never fired) for the active intent", async () => {
    const ws = await makeWorkspace(); await put(join(ws, "aidlc/spaces/default/intents/active-intent"), "260811-demo\n");
    const h = await health(ws);
    expect(h.issues.find((i) => i.kind === "Hook not running")?.message).toContain("No hook has recorded a heartbeat");
    expect(h.hooks.every((r) => r.state === "never")).toBe(true);
  });

  test("the legacy .aidlc-hooks-health folder is read when the engine folder has none", async () => {
    const ws = await makeWorkspace();
    await put(join(REC(ws), ".aidlc-hooks-health/write-audit-log.last"), "2026-08-12T22:21:00Z");
    expect((await health(ws)).issues.some((i) => i.kind === "Hook not running")).toBe(false);
  });
});

describe("audit events", () => {
  const audit = DEFAULT_AUDIT
    + block("2026-08-12T22:40:00Z", "ERROR_LOGGED", { Tool: "Bash", Command: "aidlc state set x", Error: "ENOENT: no such file or directory, open 'plan.md'" })
    + block("2026-08-12T22:41:00Z", "ERROR_LOGGED", { Tool: "Bash", Command: "aidlc report", Error: `Refused.\\n${guardAsk({ remedies: [], state_signature: "sig", question: "Line one\\nline two" })}` })
    + block("2026-08-12T22:42:00Z", "ERROR_LOGGED", { Tool: "Bash", Command: "aidlc next", Error: "Refusing to advance: the gate is open." })
    + block("2026-08-12T22:43:00Z", "ERROR_LOGGED", { Tool: "Bash", Command: "aidlc next", Error: "Refusing to advance: the gate is open." })
    + block("2026-08-12T22:44:00Z", "ERROR_LOGGED", { Tool: "Bash", Command: "aidlc next", Error: "Refusing to advance: the gate is open." })
    + block("2026-08-12T22:45:00Z", "ERROR_LOGGED", { Tool: "Bash", Command: "aidlc x", Error: "Usage: aidlc x <y>" })
    + block("2026-08-12T22:46:00Z", "SENSOR_PASSED", { "Sensor ID": "linter", "Stage slug": "functional-design", Note: "tool-unavailable" })
    + block("2026-08-12T22:47:00Z", "SENSOR_FAILED", { "Sensor ID": "traceability", "Stage slug": "functional-design", Unit: "alpha", "Findings count": "3", "Detail path": "/elsewhere/proj/aidlc/spaces/default/intents/260811-demo/.aidlc-engine/sensors/functional-design/traceability-1.md" })
    + block("2026-08-12T22:48:00Z", "SENSOR_PASSED", { "Sensor ID": "traceability", "Stage slug": "functional-design", Unit: "beta" })
    + block("2026-08-12T22:49:00Z", "SENSOR_FAILED", { "Sensor ID": "required-sections", "Stage slug": "functional-design", "Findings count": "1" })
    + block("2026-08-12T22:50:00Z", "SENSOR_PASSED", { "Sensor ID": "required-sections", "Stage slug": "functional-design" })
    + block("2026-08-12T22:51:00Z", "SESSION_COMPACTED", { "Current Stage": "functional-design", "State Validity": "invalid" })
    + block("2026-08-12T22:52:00Z", "RECOVERY_COMPLETED", {})
    + block("2026-08-12T22:53:00Z", "SESSION_COMPACTED", { "Current Stage": "functional-design", "State Validity": "invalid" })
    + block("2026-08-12T22:54:00Z", "GUARD_DISABLED", { Guard: "plan-approval-guard", Tool: "Write" })
    + block("2026-08-12T22:55:00Z", "GUARD_RESTORED", { Guard: "plan-approval-guard" })
    + block("2026-08-12T22:56:00Z", "GUARD_DISABLED", { Guard: "review-freeze", Tool: "Edit" })
    + block("2026-08-12T22:57:00Z", "REVIEW_FREEZE_BLOCKED", { Tool: "Edit", Target: "x.md", Stage: "functional-design", Unit: "alpha" })
    + block("2026-08-12T22:58:00Z", "GUARD_STOOD_ASIDE", { Guard: "review-freeze", Authority: "instruction", Grant: "none", Actor: "subagent", Tool: "Edit", Details: "d1" })
    + block("2026-08-12T22:59:00Z", "GUARD_STOOD_ASIDE", { Guard: "review-freeze", Authority: "instruction", Grant: "none", Actor: "subagent", Tool: "Edit", Details: "d2" })
    + block("2026-08-12T23:00:00Z", "SWARM_UNIT_FAILED", { Unit: "alpha", Reason: "budget-exhausted" })
    + block("2026-08-12T23:01:00Z", "SWARM_UNIT_CONVERGED", { Unit: "alpha" })
    + block("2026-08-12T23:02:00Z", "BOLT_FAILED", { Unit: "beta", Reason: "error" });
  let h: Awaited<ReturnType<typeof health>>;
  beforeAll(async () => { const ws = await makeWorkspace({ audit }); await put(join(ENG(ws), "hooks-health/write-audit-log.last"), "2026-08-12T22:22:00Z"); h = await health(ws); });
  const by = (kind: string) => h.issues.filter((i) => i.kind === kind);

  test("an errno error is an internal error, with the stage inferred from timing", () => {
    const [e] = by("Internal error");
    expect(e).toMatchObject({ group: "failure", needsFixing: true, message: "ENOENT: no such file or directory, open 'plan.md'", where: { tool: "Bash", stage: "functional-design", inferred: expect.stringContaining("timing") } });
    expect(e!.detail).toContain("aidlc state set x");
  });
  test("a terminal typed guard refusal counts toward needs fixing even once", () => {
    const [t] = by("Guard refusal (terminal)");
    expect(t).toMatchObject({ group: "refused", recoverable: "needs-you", needsFixing: true, count: 1 });
  });
  test("identical refusals fold; three or more count toward needs fixing, fewer do not", () => {
    expect(by("Refused")[0]).toMatchObject({ count: 3, needsFixing: true, at: "2026-08-12T22:44:00Z", firstAt: "2026-08-12T22:42:00Z" });
    expect(by("Command misuse")[0]).toMatchObject({ count: 1, needsFixing: false });
  });
  test("SENSOR_PASSED with a Note did not run; a failure followed by a pass for the same sensor, stage and unit is resolved", () => {
    expect(by("Check did not run")[0]).toMatchObject({ message: "linter: tool-unavailable", resolved: null, needsFixing: true });
    const failed = by("Check failed");
    const tr = failed.find((i) => i.message.startsWith("traceability"))!;
    expect(tr.resolved).toBeNull(); // the pass was for another unit: not paired
    expect(tr.source.file).toBe("aidlc/spaces/default/intents/260811-demo/.aidlc-engine/sensors/functional-design/traceability-1.md");
    const rs = failed.find((i) => i.message.startsWith("required-sections"))!;
    expect(rs.resolved).toEqual({ by: "a later passing run of the same check", at: "2026-08-12T22:50:00Z" });
    expect(rs.needsFixing).toBe(false);
  });
  test("an invalid compaction is resolved by a later RECOVERY_COMPLETED, not by an earlier one", () => {
    const c = by("Invalid state at compaction");
    expect(c.map((i) => i.resolved?.by ?? null)).toEqual(["RECOVERY_COMPLETED", null]);
  });
  test("guard bypasses: GUARD_RESTORED resolves its own guard only; stood-aside rows fold", () => {
    const d = by("Bypass · guard disabled");
    expect(d.find((i) => i.where.hook === "plan-approval-guard")!.resolved?.by).toBe("GUARD_RESTORED");
    expect(d.find((i) => i.where.hook === "review-freeze")!.resolved).toBeNull();
    expect(d.every((i) => !i.needsFixing)).toBe(true);
    expect(by("Bypass · guard stood aside")[0]).toMatchObject({ count: 2, group: "bypass", detail: "d2" });
  });
  test("a guard block names its hook and phase", () => {
    expect(by("Guard block")[0]).toMatchObject({ group: "refused", where: { hook: "review-freeze", hookPhase: "PreToolUse", tool: "Edit", stage: "functional-design", unit: "alpha" } });
  });
  test("a swarm unit failure is resolved by its unit converging; a Bolt failure without one stays open", () => {
    expect(by("Swarm unit failed · budget-exhausted")[0]!.resolved?.by).toBe("SWARM_UNIT_CONVERGED");
    expect(by("Bolt failed")[0]!.resolved).toBeNull();
  });
});

describe("engine files", () => {
  test("terminal guard-refusal record, crashed checkpoint, stalled autonomous Stop counter, invalid recovery breadcrumb, out-of-date directive", async () => {
    const ws = await makeWorkspace({ engineDirective: { kind: "error", code: "out_of_date", message: "The active step is out of date", stage: "code-generation" } });
    await put(join(ENG(ws), "hooks-health/write-audit-log.last"), "2026-08-12T22:22:00Z");
    await put(join(ENG(ws), "guard-refusals/abc.json"), JSON.stringify({ version: 1, stateSignature: "s", signature: "g", count: 3, codes: ["REVIEW_BUDGET_SPENT"], resetToken: "", updatedAt: "2026-08-13T10:00:00Z",
      refusal: { code: "REVIEW_BUDGET_SPENT", blockedAction: "record a verdict", stage: "functional-design", unit: "alpha", state: "x", invariant: "y", userMessage: "The review budget is spent.", remedies: [{ op: "ask", action: "Ask the person to grant one more review", requiresHuman: true, executableNow: false }] } }));
    await put(join(REC(ws), ".aidlc-construction-checkpoints/alpha/unit.json"), JSON.stringify({ version: 4, kind: "unit", unit: "alpha", command_label: "smoke", started_at: "2026-08-13T09:00:00Z", finished_at: null, exit_code: null, signal: null, error: null, verified: false, stdout_tail: "", stderr_tail: "" }));
    await put(join(REC(ws), ".aidlc-construction-checkpoints/beta/unit.json"), JSON.stringify({ version: 4, unit: "beta", command_label: "smoke", started_at: "a", finished_at: "2026-08-13T09:05:00Z", exit_code: 0, verified: true }));
    await put(join(ENG(ws), "stop-hook/block-count.json"), JSON.stringify({ signature: "s", count: 8 }));
    await put(join(ENG(ws), "recovery.md"), "# AIDLC Recovery Breadcrumb\n**State file**: INVALID — missing sections: Stage Progress\n");
    // Interactive state: the Stop counter at 8 is not a stalled run.
    let h = await health(ws);
    expect(h.issues.some((i) => i.kind === "Stalled run")).toBe(false);
    const st = await Bun.file(join(REC(ws), "aidlc-state.md")).text();
    await writeFile(join(REC(ws), "aidlc-state.md"), st.replace("## Current Status", "## Current Status\n- **Construction Autonomy Mode**: autonomous"));
    h = await health(ws);
    const k = (kind: string) => h.issues.find((i) => i.kind === kind)!;
    expect(k("Guard refusal (terminal)")).toMatchObject({ group: "hard-stop", count: 3, message: "The review budget is spent.", fix: { text: "Ask the person to grant one more review", source: "aidlc" }, where: { stage: "functional-design", unit: "alpha" } });
    expect(k("Checkpoint crashed")).toMatchObject({ group: "failure", where: { unit: "alpha" }, message: "smoke started 2026-08-13T09:00:00Z and never finished" });
    expect(h.issues.some((i) => i.where.unit === "beta" && i.kind.startsWith("Checkpoint"))).toBe(false);
    expect(k("Stalled run")).toMatchObject({ where: { hook: "continue-workflow", hookPhase: "Stop" } });
    expect(k("Invalid state (recovery breadcrumb)").message).toBe("INVALID — missing sections: Stage Progress");
    expect(k("Active step out of date").message).toBe("The active step is out of date");
  });
});

describe("containment", () => {
  test("symlinked hooks-health and guard-refusals folders resolving outside the workspace are not read", async () => {
    const ws = await makeWorkspace();
    const out = await mkdtemp(join(tmpdir(), "cc-out-"));
    await put(join(out, "hh/review-freeze.drops"), "2026-08-12T10:00:00Z\tOUTSIDE row dropped\n");
    await put(join(out, "hh/write-audit-log.last"), "2026-08-12T22:21:00Z");
    await put(join(out, "gr/x.json"), JSON.stringify({ version: 1, count: 5, codes: [], refusal: { code: "X", userMessage: "OUTSIDE", remedies: [] } }));
    await mkdir(ENG(ws), { recursive: true });
    await symlink(join(out, "hh"), join(ENG(ws), "hooks-health"));
    await symlink(join(out, "gr"), join(ENG(ws), "guard-refusals"));
    const h = await health(ws);
    expect(h.issues.some((i) => i.message.includes("OUTSIDE"))).toBe(false);
    expect(h.hooks.some((r) => r.lastAt)).toBe(false);
  });
  test("a single symlinked drops file pointing outside is skipped", async () => {
    const ws = await makeWorkspace();
    const out = await mkdtemp(join(tmpdir(), "cc-out-"));
    await put(join(out, "x.drops"), "2026-08-12T10:00:00Z\tOUTSIDE row dropped\n");
    await mkdir(join(ENG(ws), "hooks-health"), { recursive: true });
    await symlink(join(out, "x.drops"), join(ENG(ws), "hooks-health/review-freeze.drops"));
    expect((await health(ws)).issues.some((i) => i.message.includes("OUTSIDE"))).toBe(false);
  });
});

describe("transcript scan", () => {
  const lines = (...o: object[]) => o.map((x) => JSON.stringify(x)).join("\n") + "\n";
  // Shapes as Claude Code writes them (attachment.type hook_success / hook_blocking_error, system stop_hook_summary).
  const SECRET = "PRIVATE-CONVERSATION-TEXT";
  const transcript = lines(
    { type: "user", message: { role: "user", content: `PreToolUse:Bash hook error: ${SECRET}` }, timestamp: "2026-08-13T10:00:00Z" },
    { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: `the hook failed ${SECRET}` }] }, timestamp: "2026-08-13T10:00:01Z" },
    { type: "attachment", attachment: { type: "hook_success", hookName: "PostToolUse:Write", hookEvent: "PostToolUse", command: "aidlc engine hook run-sensors", content: SECRET, durationMs: 9, stdout: SECRET, stderr: "TypeError: x is not a function", exitCode: 1, toolUseID: "t1" }, timestamp: "2026-08-13T10:01:00Z" },
    { type: "attachment", attachment: { type: "hook_blocking_error", hookName: "PreToolUse:Edit", hookEvent: "PreToolUse", blockingError: { blockingError: "review frozen", command: "aidlc engine hook review-freeze" } }, timestamp: "2026-08-13T10:02:00Z" },
    { type: "attachment", attachment: { type: "hook_success", hookName: "PostToolUse:Write", stdout: SECRET }, timestamp: "2026-08-13T10:03:00Z" },
    { type: "system", subtype: "stop_hook_summary", hookCount: 1, hookInfos: [{ command: "aidlc engine hook continue-workflow" }], hookErrors: ["The AIDLC workflow has a pending step; carry on with the workflow loop."], timestamp: "2026-08-13T10:04:00Z" },
  );
  async function setup(body: string, outside = false) {
    const ws = await makeWorkspace();
    const projects = await mkdtemp(join(tmpdir(), "cc-projects-"));
    const elsewhere = await mkdtemp(join(tmpdir(), "cc-elsewhere-"));
    const t = join(outside ? elsewhere : join(projects, "proj"), "s1.jsonl");
    await put(t, body);
    await put(join(ws, "aidlc/.aidlc-sessions/current.transcript"), `${t}\n`);
    await put(join(ws, "aidlc/spaces/default/intents/active-intent"), "260811-demo\n");
    return { ws, projects };
  }
  test("returns only hook-failure fields, never conversation content", async () => {
    const { ws, projects } = await setup(transcript);
    const s = await scanTranscripts(ws, projects);
    expect(s.status).toBe("on");
    expect(s.failures.map((f) => [f.hook, f.event, f.at, f.error])).toEqual([
      ["run-sensors", "PostToolUse", "2026-08-13T10:01:00Z", "exit 1: TypeError: x is not a function"],
      ["review-freeze", "PreToolUse", "2026-08-13T10:02:00Z", "review frozen"],
    ]);
    expect(s.reprompts).toBe(1); // AIDLC's own Stop hook re-prompting: by design
    expect(JSON.stringify(s)).not.toContain(SECRET);
    for (const f of s.failures) expect(Object.keys(f).sort()).toEqual(["at", "error", "event", "hook", "line", "transcript"]);
  });
  test("off: nothing is read and coverage says so; on: issues attributed to the active intent", async () => {
    const { ws, projects } = await setup(transcript);
    const off = await buildHealth([found(ws)], NOW, { scanTranscripts: false, projectsRoot: projects });
    expect(off.coverage.transcripts).toBe("off");
    expect(off.coverage.note).toContain("Hook crashes are not recorded by AIDLC");
    expect(off.issues.some((i) => i.kind === "Hook failure (transcript)")).toBe(false);
    const on = await buildHealth([found(ws)], NOW, { scanTranscripts: true, projectsRoot: projects });
    expect(on.coverage.transcripts).toBe("on");
    const tx = on.issues.filter((i) => i.kind === "Hook failure (transcript)");
    expect(tx).toHaveLength(2);
    expect(tx[0]).toMatchObject({ intentKey: KEY, where: { inferred: "intent inferred from the active-intent cursor" } });
    expect(JSON.stringify(on)).not.toContain(SECRET);
  });
  test("a pointer to a file outside ~/.claude/projects is refused", async () => {
    const { ws, projects } = await setup(transcript, true);
    const s = await scanTranscripts(ws, projects);
    expect(s).toMatchObject({ status: "unavailable", refused: 1, failures: [] });
  });
  test("a symlink inside the projects folder that resolves outside it is refused", async () => {
    const { ws, projects } = await setup(transcript, true);
    const ptr = (await Bun.file(join(ws, "aidlc/.aidlc-sessions/current.transcript")).text()).trim();
    await mkdir(join(projects, "proj"), { recursive: true });
    await symlink(ptr, join(projects, "proj/link.jsonl"));
    await writeFile(join(ws, "aidlc/.aidlc-sessions/current.transcript"), join(projects, "proj/link.jsonl"));
    expect((await scanTranscripts(ws, projects)).refused).toBe(1);
  });
  test("an unknown format is reported as unrecognised, not guessed at", async () => {
    const { ws, projects } = await setup(lines({ kind: "x", hook: "PreToolUse" }, { foo: "hook error" }));
    expect((await scanTranscripts(ws, projects)).status).toBe("unrecognised");
    expect((await buildHealth([found(ws)], NOW, { scanTranscripts: true, projectsRoot: projects })).coverage.transcripts).toBe("unrecognised");
  });
  test("a large transcript is read from its end only", async () => {
    const pad = lines({ type: "user", message: { content: "x".repeat(500) } });
    const { ws, projects } = await setup(pad.repeat(50) + lines({ type: "attachment", attachment: { type: "hook_cancelled", hookName: "Stop" }, timestamp: "2026-08-13T11:00:00Z" }));
    const s = await scanTranscripts(ws, projects, 4096);
    expect(s.truncated).toBe(true);
    expect(s.failures.map((f) => f.error)).toEqual(["hook cancelled"]);
  });
});

describe("trace dir", () => {
  test("dispatcher-error lines are read only when the trace dir lies inside the workspace", async () => {
    const ws = await makeWorkspace();
    await put(join(ws, "trace/hook-123.ndjson"), [{ phase: "hook-import-begin" }, { at: "2026-08-13T10:00:00Z", pid: 123, phase: "dispatcher-error", message: "Cannot find module x" }].map((x) => JSON.stringify(x)).join("\n"));
    const inside = await buildHealth([found(ws)], NOW, { traceDir: join(ws, "trace") });
    expect(inside.coverage.trace).toBe(true);
    expect(inside.issues.filter((i) => i.kind === "Hook crash (trace)").map((i) => i.message)).toEqual(["Cannot find module x"]);
    const outside = await buildHealth([found(ws)], NOW, { traceDir: await mkdtemp(join(tmpdir(), "cc-trace-")) });
    expect(outside.coverage.trace).toBe(false);
  });
});

describe("HTTP API", () => {
  let s: Awaited<ReturnType<typeof startServer>>; let ws: string;
  const get = (p: string) => fetch(`http://127.0.0.1:${s.port}${p}${p.includes("?") ? "&" : "?"}t=${s.token}`);
  beforeAll(async () => {
    ws = await makeWorkspace({ extraShard: AUDIT_HEADER + block("2026-08-12T22:40:00Z", "ERROR_LOGGED", { Tool: "Bash", Error: "EACCES: permission denied" }) });
    await put(join(ws, "aidlc/spaces/default/intents/active-intent"), "260811-demo\n");
    s = await startServer({ port: 0, config: { version: 1, roots: [], pins: [ws], hidden: [], repos: [], theme: "auto" }, configPath: join(await mkdtemp(join(tmpdir(), "cc-")), "c.json"), now: () => NOW });
  });
  afterAll(() => s.stop());
  test("/api/health is token-gated and returns issues, hooks and coverage", async () => {
    expect((await fetch(`http://127.0.0.1:${s.port}/api/health`)).status).toBe(401);
    const h = await (await get("/api/health")).json();
    expect(Object.keys(h).sort()).toEqual(["coverage", "generatedAt", "hooks", "issues"]);
    const e = h.issues.find((i: { kind: string }) => i.kind === "Internal error");
    expect(e).toMatchObject({ workspace: ws, intentKey: KEY, intentName: "demo", group: "failure" });
    expect(h.issues.find((i: { kind: string }) => i.kind === "Hook not running")).toBeTruthy();
    expect(h.coverage).toMatchObject({ transcripts: "off", trace: false });
    expect(h.hooks[0]).toMatchObject({ workspace: ws, intentKey: KEY });
  });
  test("/api/lens/issues scopes to one intent; an unknown intent is 404", async () => {
    const l = await (await get(`/api/lens/issues?ws=${encodeURIComponent(ws)}&key=${encodeURIComponent(KEY)}`)).json();
    expect(l.issues.length).toBeGreaterThan(0);
    expect(l.issues.every((i: { intentKey: string }) => i.intentKey === KEY)).toBe(true);
    expect((await get(`/api/lens/issues?ws=${encodeURIComponent(ws)}&key=default/nope`)).status).toBe(404);
  });
  test("home carries the health counts for the header badge", async () => {
    const h = await (await get("/api/home")).json();
    expect(h.health.needsFixing).toBeGreaterThanOrEqual(2);
    expect(h.health.open["hard-stop"]).toBe(1);
    expect(h.health.byIntent[`${ws}::${KEY}`]).toBe(h.health.needsFixing);
  });
  test("the transcript setting is persisted by validateConfig only as a boolean", async () => {
    const { validateConfig } = await import("../../core/command-center/server/config");
    expect(validateConfig({ settings: { scanTranscripts: true } }).settings).toEqual({ scanTranscripts: true });
    expect(validateConfig({ settings: { scanTranscripts: "yes" } }).settings).toEqual({ scanTranscripts: false });
    expect(validateConfig({}).settings).toBeUndefined();
  });
});

test("a SENSOR_PASSED with a Note is counted as did-not-run, never as passed (Story hidden counts)", async () => {
  const { buildIntent } = await import("../../core/command-center/server/model/intent");
  const { loadCatalog } = await import("../../core/command-center/server/parse/stage-graph");
  const ws = await makeWorkspace({ audit: DEFAULT_AUDIT
    + block("2026-08-12T22:46:00Z", "SENSOR_PASSED", { "Stage slug": "functional-design", "Sensor ID": "linter", Note: "tool-unavailable" })
    + block("2026-08-12T22:47:00Z", "SENSOR_PASSED", { "Stage slug": "functional-design", "Sensor ID": "type-check" }) });
  const ref = (await listIntents(ws))[0]!;
  const m = await buildIntent(ws, ref, (await loadCatalog(ws)).stages, NOW);
  expect(m.hiddenCounts["functional-design"]).toEqual({ sensorPassed: 1, sensorFired: 0, humanTurns: 0, sensorNotRun: 1 });
});

test("source paths are workspace-relative even when the workspace path is a symlink (macOS /tmp)", async () => {
  const real = await makeWorkspace({ audit: DEFAULT_AUDIT + block("2026-08-12T22:40:00Z", "ERROR_LOGGED", { Tool: "Bash", Error: "EBUSY: x" }) });
  const link = join(await mkdtemp(join(tmpdir(), "cc-link-")), "ws");
  await symlink(real, link);
  const h = await buildHealth([found(link)], NOW);
  expect(h.issues.find((i) => i.kind === "Internal error")!.source.file).toBe("aidlc/spaces/default/intents/260811-demo/audit/hosta-aaaaaaaaaaaa.md");
});
