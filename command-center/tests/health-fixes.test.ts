// Fix round 1 for "Needs fixing": sensor pairing per output file, the hooks hard stop only for the active intent,
// guard-refusal reset events and de-duplication, the narrowed by-design rule, the real transcript shapes, and minors.
import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyDrop, checkpointState } from "../../core/command-center/server/health-classify";
import { buildHealth, intentHealth } from "../../core/command-center/server/health";
import { listIntents } from "../../core/command-center/server/parse/registry";
import { scanTranscripts } from "../../core/command-center/server/transcripts";
import { block, DEFAULT_AUDIT, makeWorkspace } from "./fixtures/make";

const KEY = "default/260811-demo";
const REC = (w: string) => join(w, "aidlc/spaces/default/intents/260811-demo");
const ENG = (w: string) => join(REC(w), ".aidlc-engine");
const NOW = new Date("2026-08-13T23:21:00Z");
const found = (path: string) => ({ path, origin: "pin" as const, root: null, exists: true });
async function put(p: string, body: string) { await mkdir(join(p, ".."), { recursive: true }); await writeFile(p, body); }
const active = (ws: string, dir = "260811-demo") => put(join(ws, "aidlc/spaces/default/intents/active-intent"), `${dir}\n`);
const fresh = (ws: string) => put(join(ENG(ws), "hooks-health/write-audit-log.last"), "2026-08-12T22:22:00Z");
async function health(ws: string) {
  const ref = (await listIntents(ws)).find((r) => `${r.space}/${r.dir}` === KEY)!;
  return intentHealth(ws, ref, REC(ws), NOW);
}

test("sensor pairing is per output file: a pass on file B does not resolve a failure on file A", async () => {
  const S = { "Sensor ID": "traceability", "Stage slug": "functional-design" };
  const ws = await makeWorkspace({ audit: DEFAULT_AUDIT
    + block("2026-08-12T22:40:00Z", "SENSOR_FAILED", { ...S, "Output path": "/p/aidlc/a.md", "Findings count": "2" })
    + block("2026-08-12T22:41:00Z", "SENSOR_PASSED", { ...S, "Output path": "/p/aidlc/b.md" })
    + block("2026-08-12T22:42:00Z", "SENSOR_FAILED", { ...S, "Output path": "/p/aidlc/c.md", "Findings count": "1" })
    + block("2026-08-12T22:43:00Z", "SENSOR_PASSED", { ...S, "Output path": "/p/aidlc/c.md" }) });
  await fresh(ws);
  const f = (await health(ws)).issues.filter((i) => i.kind === "Check failed");
  expect(f).toHaveLength(2);
  expect(f.find((i) => i.at === "2026-08-12T22:40:00Z")!.resolved).toBeNull();
  expect(f.find((i) => i.at === "2026-08-12T22:42:00Z")!.resolved?.by).toBe("a later passing run of the same check");
});

describe("hooks hard stop: the active intent only", () => {
  test("no heartbeats on an intent that is not the active one is informational, not an issue", async () => {
    const ws = await makeWorkspace();
    const h = await health(ws);
    expect(h.issues.some((i) => i.kind === "Hook not running")).toBe(false);
    expect(h.hooks.length).toBeGreaterThan(0);
    expect(h.hooks.every((r) => r.state === "never" && r.note === "no heartbeats here — normal for a clone or another machine")).toBe(true);
  });
  test("the active intent with no heartbeats is a hard stop; stale too", async () => {
    const ws = await makeWorkspace(); await active(ws);
    expect((await buildHealth([found(ws)], NOW)).issues.filter((i) => i.kind === "Hook not running")).toHaveLength(1);
    await put(join(ENG(ws), "hooks-health/write-audit-log.last"), "2026-08-12T22:00:00Z");
    const h = await buildHealth([found(ws)], NOW);
    expect(h.issues.find((i) => i.kind === "Hook not running")!.message).toContain("but the workflow last advanced");
    expect(h.hooks.find((r) => r.hook === "write-audit-log")!.note).toBeUndefined();
  });
  test("a completed or archived active intent is not a hard stop", async () => {
    const ws = await makeWorkspace(); await active(ws);
    await writeFile(join(ws, "aidlc/spaces/default/intents/intents.json"), JSON.stringify([{ uuid: "u-1", slug: "demo", dirName: "260811-demo", status: "complete" }]));
    expect((await buildHealth([found(ws)], NOW)).issues.some((i) => i.kind === "Hook not running")).toBe(false);
  });
});

describe("guard refusals", () => {
  const record = (o: object = {}) => JSON.stringify({ version: 1, stateSignature: "s", signature: "g", count: 3, codes: ["R"], resetToken: "", updatedAt: "2026-08-12T22:30:00Z",
    refusal: { code: "R", blockedAction: "a", stage: "functional-design", unit: "alpha", userMessage: "Budget spent.", remedies: [] }, ...o });
  const ask = JSON.stringify({ kind: "ask", ask_type: "guard-recovery", response_route: "execute-remedy", question: "?", stage: "functional-design", unit: "alpha", reason_codes: ["R"], remedies: [], state_signature: "s" });
  for (const [ev, f] of [["SESSION_STARTED", {}], ["SESSION_RESUMED", {}], ["WORKFLOW_STARTED", {}], ["STAGE_JUMPED", { Target: "x" }], ["GATE_REJECTED", { Stage: "functional-design" }],
    ["BOLT_STARTED", { "Bolt names": "beta, alpha" }], ["STAGE_COMPLETED", { Stage: "functional-design" }], ["UNIT_COMPLETED", { Stage: "functional-design", Unit: "alpha" }]] as const) {
    test(`a later ${ev} resolves the record`, async () => {
      const ws = await makeWorkspace({ audit: DEFAULT_AUDIT + block("2026-08-12T22:35:00Z", ev, f as Record<string, string>) });
      await fresh(ws); await put(join(ENG(ws), "guard-refusals/x.json"), record());
      const i = (await health(ws)).issues.find((x) => x.kind === "Guard refusal (terminal)")!;
      expect(i.resolved?.by).toBe(ev);
      expect(i.needsFixing).toBe(false);
    });
  }
  test("reset events for another stage or unit, or earlier than the record, do not resolve it", async () => {
    const ws = await makeWorkspace({ audit: DEFAULT_AUDIT
      + block("2026-08-12T22:20:00Z", "SESSION_STARTED", {})
      + block("2026-08-12T22:35:00Z", "GATE_REJECTED", { Stage: "code-generation" })
      + block("2026-08-12T22:36:00Z", "BOLT_STARTED", { "Bolt names": "beta" })
      + block("2026-08-12T22:37:00Z", "UNIT_COMPLETED", { Stage: "functional-design", Unit: "beta" }) });
    await fresh(ws); await put(join(ENG(ws), "guard-refusals/x.json"), record({ refusal: { code: "R", stage: "functional-design", unit: "gamma", userMessage: "Budget spent.", remedies: [] } }));
    expect((await health(ws)).issues.find((x) => x.kind === "Guard refusal (terminal)")!.resolved).toBeNull();
  });
  test("a resolved recoverable record repeated 3 times does not count toward the badge", async () => {
    const ws = await makeWorkspace({ audit: DEFAULT_AUDIT + block("2026-08-12T22:35:00Z", "SESSION_STARTED", {}) });
    await fresh(ws); await put(join(ENG(ws), "guard-refusals/x.json"), record({ refusal: { code: "R", stage: "functional-design", unit: "alpha", userMessage: "m", remedies: [{ action: "Run it", requiresHuman: false, executableNow: true }] } }));
    const i = (await health(ws)).issues.find((x) => x.kind === "Guard refusal")!;
    expect(i.count).toBe(3); expect(i.resolved).not.toBeNull(); expect(i.needsFixing).toBe(false);
  });
  test("the same terminal situation as a record and an ERROR_LOGGED shows once, with the log row as evidence", async () => {
    const ws = await makeWorkspace({ audit: DEFAULT_AUDIT + block("2026-08-12T22:29:00Z", "ERROR_LOGGED", { Tool: "Bash", Error: `Refused.\\n${ask}` }) });
    await fresh(ws); await put(join(ENG(ws), "guard-refusals/x.json"), record());
    const t = (await health(ws)).issues.filter((x) => x.kind === "Guard refusal (terminal)");
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ group: "hard-stop" });
    expect(t[0]!.detail).toContain("Also logged as ERROR_LOGGED at 2026-08-12T22:29:00Z");
  });
});

test("by design is only the named Stop carve-outs; any other '; allowing stop' is a failure", () => {
  expect(classifyDrop("active-directive evidence unavailable while reading shared resume wait: Unexpected end of JSON input; allowing stop")).not.toBe("by-design");
  expect(classifyDrop("something odd happened; allowing stop")).toBe("other");
  for (const r of ["x; allowing the stop (pending-question carve-out)", "allowing stop at the exact post-create fresh-session handoff boundary",
    "active resume choice is waiting on the human; allowing the stop before the shared next probe", "parked directive seen under autonomous Construction; declining the parked allow (an unattended run must not self-park)"])
    expect(classifyDrop(r)).toBe("by-design");
});

describe("transcripts, real Claude Code shapes", () => {
  const L = (...o: object[]) => o.map((x) => JSON.stringify(x)).join("\n") + "\n";
  const SECRET = "STDOUT-OR-CONTENT-NEVER-SHOWN";
  const ok = (ev: string, name: string, cmd: string) => ({ type: "attachment", timestamp: "2026-08-13T10:00:00Z", attachment: { type: "hook_success", command: cmd, content: SECRET, durationMs: 12, exitCode: 0, hookEvent: ev, hookName: name, stderr: "", stdout: SECRET, toolUseID: "t1" } });
  const body = L(
    { type: "user", message: { content: `PreToolUse:Bash hook error ${SECRET}` } },
    ok("PostToolUse", "PostToolUse:Write", "aidlc engine hook write-audit-log"),
    { type: "attachment", timestamp: "2026-08-13T10:01:00Z", attachment: { type: "hook_success", command: "aidlc engine hook run-sensors", content: SECRET, durationMs: 40, exitCode: 2, hookEvent: "PostToolUse", hookName: "PostToolUse:Write", stderr: "TypeError: boom", stdout: SECRET, toolUseID: "t2" } },
    { type: "attachment", timestamp: "2026-08-13T10:02:00Z", attachment: { type: "hook_blocking_error", blockingError: { blockingError: "The AI-DLC workflow is not finished.", command: "aidlc engine hook continue-workflow" }, hookEvent: "Stop", hookName: "Stop" } },
    { type: "attachment", timestamp: "2026-08-13T10:03:00Z", attachment: { type: "hook_blocking_error", blockingError: { blockingError: "frozen", command: "aidlc engine hook review-freeze" }, hookEvent: "PreToolUse", hookName: "PreToolUse:Edit" } },
    { type: "system", subtype: "stop_hook_summary", timestamp: "2026-08-13T10:04:00Z", hookCount: 2, hookInfos: [{ command: "aidlc engine hook continue-workflow" }, { command: "/usr/local/bin/notify" }], hookErrors: ["The AIDLC workflow still has a stage to run.", "notify: not found"], preventedContinuation: false },
  );
  async function setup(text: string) {
    const ws = await makeWorkspace(); const projects = await mkdtemp(join(tmpdir(), "cc-projects-"));
    await put(join(projects, "p/s.jsonl"), text);
    await put(join(ws, "aidlc/.aidlc-sessions/current.transcript"), join(projects, "p/s.jsonl"));
    return { ws, projects };
  }
  test("non-zero hook_success exits are failures; AIDLC's own Stop re-prompts are by design; never stdout or content", async () => {
    const { ws, projects } = await setup(body);
    const s = await scanTranscripts(ws, projects);
    expect(s.status).toBe("on");
    expect(s.runs).toBe(4);
    expect(s.reprompts).toBe(2);
    expect(s.failures.map((f) => [f.hook, f.event, f.error])).toEqual([
      ["run-sensors", "PostToolUse", "exit 2: TypeError: boom"],
      ["review-freeze", "PreToolUse", "frozen"],
      ["Stop hook (unnamed)", "Stop", "notify: not found"],
    ]);
    expect(JSON.stringify(s)).not.toContain(SECRET);
    const h = await buildHealth([found(ws)], NOW, { scanTranscripts: true, projectsRoot: projects });
    expect(h.coverage).toMatchObject({ transcripts: "on", transcriptRuns: 4, transcriptFailures: 3, transcriptReprompts: 2 });
  });
  test("a non-empty transcript with no hook_* attachments is unrecognised; on with zero failures is distinguishable", async () => {
    const a = await setup(L({ type: "user", message: { content: "hi" } }, { type: "assistant", message: { content: "x" } }));
    expect((await scanTranscripts(a.ws, a.projects)).status).toBe("unrecognised");
    const b = await setup(L(ok("PostToolUse", "PostToolUse:Write", "aidlc engine hook write-audit-log")));
    expect(await scanTranscripts(b.ws, b.projects)).toMatchObject({ status: "on", runs: 1, failures: [] });
  });
});

describe("minors", () => {
  test("a checkpoint with finished_at:null is crashed only once older than the check timeout", () => {
    const cp = { version: 4, started_at: "2026-08-13T23:20:00Z", finished_at: null };
    expect(checkpointState(cp, Date.parse("2026-08-13T23:21:00Z"))).toBe("running");
    expect(checkpointState(cp, Date.parse("2026-08-13T23:30:00Z"))).toBe("crashed");
  });
  test("a stalled Stop counter resolves when progress follows it", async () => {
    const ws = await makeWorkspace({ audit: DEFAULT_AUDIT + block("2026-08-13T23:30:00Z", "UNIT_COMPLETED", { Stage: "code-generation", Unit: "beta" }) });
    await fresh(ws);
    const st = await Bun.file(join(REC(ws), "aidlc-state.md")).text();
    await writeFile(join(REC(ws), "aidlc-state.md"), st.replace("## Current Status", "## Current Status\n- **Construction Autonomy Mode**: autonomous"));
    await put(join(ENG(ws), "stop-hook/block-count.json"), JSON.stringify({ signature: "s", count: 8 }));
    const { utimes } = await import("node:fs/promises");
    const t = new Date("2026-08-13T23:25:00Z"); await utimes(join(ENG(ws), "stop-hook/block-count.json"), t, t);
    expect((await health(ws)).issues.find((i) => i.kind === "Stalled run")!.resolved?.by).toBe("UNIT_COMPLETED");
  });
});

test("the home health cache is reused while no audit shard changes, and rebuilt when one does", async () => {
  const { cachedHealth } = await import("../../core/command-center/server/health");
  const ws = await makeWorkspace();
  const a = await cachedHealth([found(ws)], NOW); const b = await cachedHealth([found(ws)], NOW);
  expect(b).toBe(a);
  const { appendFile } = await import("node:fs/promises");
  await appendFile(join(REC(ws), "audit/hosta-aaaaaaaaaaaa.md"), block("2026-08-13T23:20:00Z", "ERROR_LOGGED", { Error: "EPERM: x" }));
  const c = await cachedHealth([found(ws)], NOW);
  expect(c).not.toBe(a);
  expect(c.issues.some((i) => i.kind === "Internal error")).toBe(true);
});

describe("sensor failures accepted at a gate", () => {
  const S = { "Sensor ID": "traceability", "Stage slug": "feasibility", "Output path": "/p/aidlc/a.md", "Findings count": "2" };
  const run = async (tail: string) => {
    const ws = await makeWorkspace({ audit: DEFAULT_AUDIT.replace(/\n## Entry\n\*\*Timestamp\*\*: 2026-08-12T17:39:00Z[\s\S]*?---\n/g, "") + tail });
    await fresh(ws);
    return (await health(ws)).issues.filter((i) => i.kind === "Check failed" || i.kind === "Check did not run");
  };
  test("open while the stage has not passed its gate", async () => {
    const [i] = await run(block("2026-08-12T17:30:00Z", "SENSOR_FAILED", S));
    expect(i).toMatchObject({ group: "failure", needsFixing: true, resolved: null });
  });
  test("accepted after GATE_APPROVED / STAGE_COMPLETED: listed, not counted", async () => {
    for (const ev of ["GATE_APPROVED", "STAGE_COMPLETED"]) {
      const [i] = await run(block("2026-08-12T17:30:00Z", "SENSOR_FAILED", S) + block("2026-08-12T17:40:00Z", ev, { Stage: "feasibility" }));
      expect(i).toMatchObject({ group: "accepted", needsFixing: false, resolved: null });
      expect(i!.detail).toContain(`Accepted at gate: ${ev} at 2026-08-12T17:40:00Z`);
    }
  });
  test("a unit's failure is accepted by its UNIT_COMPLETED, not another unit's", async () => {
    const U = { ...S, "Stage slug": "code-generation", Unit: "gamma" };
    expect((await run(block("2026-08-13T10:00:00Z", "SENSOR_FAILED", U) + block("2026-08-13T10:05:00Z", "UNIT_COMPLETED", { Stage: "code-generation", Unit: "delta" })))[0]!.group).toBe("failure");
    expect((await run(block("2026-08-13T10:00:00Z", "SENSOR_FAILED", U) + block("2026-08-13T10:05:00Z", "UNIT_COMPLETED", { Stage: "code-generation", Unit: "gamma" })))[0]!.group).toBe("accepted");
  });
  test("a blocking sensor keeps counting after the gate", async () => {
    const [i] = await run(block("2026-08-12T17:30:00Z", "SENSOR_FAILED", { ...S, "Gate effect": "blocking" }) + block("2026-08-12T17:40:00Z", "GATE_APPROVED", { Stage: "feasibility" }));
    expect(i).toMatchObject({ group: "failure", needsFixing: true });
  });
  test("a later pass still wins over accepted", async () => {
    const [i] = await run(block("2026-08-12T17:30:00Z", "SENSOR_FAILED", S) + block("2026-08-12T17:40:00Z", "GATE_APPROVED", { Stage: "feasibility" })
      + block("2026-08-12T17:50:00Z", "SENSOR_PASSED", { ...S, "Findings count": "0" }));
    expect(i!.resolved?.by).toBe("a later passing run of the same check");
    expect(i!.group).toBe("failure");
  });
  test("a check that did not run is accepted the same way", async () => {
    const [i] = await run(block("2026-08-12T17:30:00Z", "SENSOR_PASSED", { "Sensor ID": "linter", "Stage slug": "feasibility", "Output path": "/p/aidlc/a.md", Note: "tool-unavailable" })
      + block("2026-08-12T17:40:00Z", "STAGE_COMPLETED", { Stage: "feasibility" }));
    expect(i).toMatchObject({ kind: "Check did not run", group: "accepted", needsFixing: false });
  });
  test("accepted items are excluded from the counts but counted in their own chip", async () => {
    const { countIssues } = await import("../../core/command-center/server/hooks-map");
    const items = await run(block("2026-08-12T17:30:00Z", "SENSOR_FAILED", S) + block("2026-08-12T17:40:00Z", "GATE_APPROVED", { Stage: "feasibility" }));
    const c = countIssues(items);
    expect(c.needsFixing).toBe(0); expect(c.open.accepted).toBe(1); expect(c.open.failure).toBe(0);
  });
});

describe("sensor unit from the file path", () => {
  const P = (rel: string) => `/elsewhere/p/aidlc/spaces/default/intents/260811-demo/${rel}`;
  const S = (path: string) => ({ "Sensor ID": "traceability", "Stage slug": "code-generation", "Output path": path, "Findings count": "1" });
  const run = async (tail: string) => {
    const ws = await makeWorkspace({ audit: DEFAULT_AUDIT + tail }); await fresh(ws);
    return (await health(ws)).issues.filter((i) => i.kind === "Check failed");
  };
  test("a per-unit file gives the unit (inferred), and that unit's later gate accepts it", async () => {
    const [i] = await run(block("2026-08-13T23:20:10Z", "SENSOR_FAILED", S(P("construction/gamma/code-generation/code-summary.md")))
      + block("2026-08-13T23:20:20Z", "UNIT_COMPLETED", { Stage: "code-generation", Unit: "gamma" }));
    expect(i).toMatchObject({ group: "accepted", where: { stage: "code-generation", unit: "gamma", inferred: "from the file path" } });
  });
  test("another unit's gate does not accept it", async () => {
    const [i] = await run(block("2026-08-13T23:20:10Z", "SENSOR_FAILED", S(P("construction/gamma/code-generation/code-summary.md")))
      + block("2026-08-13T23:20:20Z", "GATE_APPROVED", { Stage: "code-generation", Unit: "delta" }));
    expect(i).toMatchObject({ group: "failure", where: { unit: "gamma" } });
  });
  test("a path whose stage segment is another stage gives no unit", async () => {
    const [i] = await run(block("2026-08-13T23:20:10Z", "SENSOR_FAILED", S(P("construction/gamma/functional-design/model.md"))));
    expect(i!.where.unit).toBeNull();
    expect(i!.where.inferred).toBeUndefined();
  });
  test("a stage-level file (construction/<stage>/…) is unchanged", async () => {
    const [i] = await run(block("2026-08-13T23:20:10Z", "SENSOR_FAILED", S(P("construction/code-generation/notes/x.md")))
      + block("2026-08-13T23:20:20Z", "UNIT_COMPLETED", { Stage: "code-generation", Unit: "notes" }));
    expect(i).toMatchObject({ group: "failure", where: { unit: null } });
  });
});

describe("round 4: exact Stop-hook carve-out", () => {
  const L = (...o: object[]) => o.map((x) => JSON.stringify(x)).join("\n") + "\n";
  const blocking = (ts: string, command: string, text: string, hookEvent = "Stop") => ({ type: "attachment", timestamp: ts, toolUseID: "u1", attachment: { type: "hook_blocking_error", blockingError: { blockingError: text, command }, hookEvent, hookName: hookEvent } });
  const summary = (ts: string, errors: string[]) => ({ type: "system", subtype: "stop_hook_summary", timestamp: ts, hookCount: 2, hookInfos: [{ command: "aidlc engine hook continue-workflow", durationMs: 30 }, { command: "/opt/bin/notify", durationMs: 4 }], hookErrors: errors, preventedContinuation: true });
  async function scan(text: string) {
    const ws = await makeWorkspace(); const projects = await mkdtemp(join(tmpdir(), "cc-projects-"));
    await put(join(projects, "p/s.jsonl"), text);
    await put(join(ws, "aidlc/.aidlc-sessions/current.transcript"), join(projects, "p/s.jsonl"));
    return scanTranscripts(ws, projects);
  }
  test("AIDLC re-prompts from continue-workflow on Stop (any path prefix) are by design", async () => {
    const s = await scan(L(blocking("2026-08-13T10:00:00Z", "aidlc engine hook continue-workflow", "The AI-DLC workflow is not finished: run next."),
      blocking("2026-08-13T10:05:00Z", "/Users/x/.local/bin/aidlc engine hook continue-workflow", "The AIDLC workflow still has a pending stage.")));
    expect(s).toMatchObject({ reprompts: 2, failures: [] });
  });
  test("a non-AIDLC Stop hook blocking error is a failure", async () => {
    const s = await scan(L(blocking("2026-08-13T10:00:00Z", "/opt/bin/notify", "The AI-DLC workflow is lying")));
    expect(s.failures.map((f) => f.hook)).toEqual(["notify"]); expect(s.reprompts).toBe(0);
  });
  test("an AIDLC continue-workflow crash text is a failure", async () => {
    const s = await scan(L(blocking("2026-08-13T10:00:00Z", "aidlc engine hook continue-workflow", "TypeError: Cannot read properties of undefined")));
    expect(s.failures.map((f) => [f.hook, f.error])).toEqual([["continue-workflow", "TypeError: Cannot read properties of undefined"]]);
  });
  test("summary strings: a second hook's error is a failure of the unnamed Stop hook, never paired with hookInfos", async () => {
    const s = await scan(L(summary("2026-08-13T10:00:00Z", ["notify: not found"])));
    expect(s.failures.map((f) => [f.hook, f.event, f.error])).toEqual([["Stop hook (unnamed)", "Stop", "notify: not found"]]);
    expect(s.reprompts).toBe(0);
  });
  test("a summary repeating a counted blocking error is not counted twice; a lone re-prompt string is by design", async () => {
    const text = "The AI-DLC workflow is not finished: run next.";
    const s = await scan(L(blocking("2026-08-13T10:00:00Z", "aidlc engine hook continue-workflow", text), summary("2026-08-13T10:00:01Z", [text]),
      blocking("2026-08-13T10:10:00Z", "aidlc engine hook continue-workflow", "TypeError: boom"), summary("2026-08-13T10:10:01Z", ["TypeError: boom"]),
      summary("2026-08-13T11:00:00Z", ["The AIDLC workflow still has work."])));
    expect(s.reprompts).toBe(2); // the duplicate summary string is not counted again
    expect(s.failures.map((f) => [f.hook, f.error])).toEqual([["continue-workflow", "TypeError: boom"], ["Stop hook (unnamed)", "TypeError: boom"]]);
  });
});

test("round 4: the home cache sees a guard-refusal change at once, not after the TTL", async () => {
  const { cachedHealth } = await import("../../core/command-center/server/health");
  const ws = await makeWorkspace(); await fresh(ws);
  const a = await cachedHealth([found(ws)], NOW);
  expect(a.issues.some((i) => i.kind.startsWith("Guard refusal"))).toBe(false);
  await put(join(ENG(ws), "guard-refusals/x.json"), JSON.stringify({ version: 1, count: 3, codes: ["R"], updatedAt: "2026-08-13T23:20:00Z", refusal: { code: "R", stage: "code-generation", unit: "beta", userMessage: "m", remedies: [] } }));
  const b = await cachedHealth([found(ws)], NOW);
  expect(b.issues.some((i) => i.kind === "Guard refusal (terminal)")).toBe(true);
  const [c, d] = await Promise.all([cachedHealth([found(ws)], NOW), cachedHealth([found(ws)], NOW)]);
  expect(c).toBe(d); // concurrent builds share one
});

test("round 4: identical guard refusals do not fold across a reset event", async () => {
  const ask = JSON.stringify({ kind: "ask", ask_type: "guard-recovery", response_route: "execute-remedy", question: "?", stage: "code-generation", unit: "beta", reason_codes: ["R"], remedies: [{ action: "Run it", requiresHuman: false, executableNow: true }] });
  const err = { Tool: "Bash", Error: `Refused.\\n${ask}` };
  const ws = await makeWorkspace({ audit: DEFAULT_AUDIT
    + block("2026-08-13T23:20:01Z", "ERROR_LOGGED", err) + block("2026-08-13T23:20:02Z", "ERROR_LOGGED", err)
    + block("2026-08-13T23:20:03Z", "SESSION_STARTED", {})
    + block("2026-08-13T23:20:04Z", "ERROR_LOGGED", err) });
  await fresh(ws);
  const rows = (await health(ws)).issues.filter((i) => i.kind === "Guard refusal");
  expect(rows.map((r) => [r.count, r.resolved?.by ?? null])).toEqual([[2, "SESSION_STARTED"], [1, null]]);
});

describe("round 5: the Stop carve-out judged by command and crash shape, not wording", () => {
  const L = (...o: object[]) => o.map((x) => JSON.stringify(x)).join("\n") + "\n";
  const CMD = "aidlc engine hook continue-workflow";
  const blocking = (ts: string, command: string, text: string, hookEvent = "Stop") => ({ type: "attachment", timestamp: ts, toolUseID: `u-${ts}`, attachment: { type: "hook_blocking_error", blockingError: { blockingError: text, command }, hookEvent, hookName: hookEvent } });
  const summary = (ts: string, errors: string[]) => ({ type: "system", subtype: "stop_hook_summary", timestamp: ts, hookCount: 1, hookInfos: [{ command: CMD, durationMs: 20 }], hookErrors: errors, preventedContinuation: true });
  async function scan(text: string) {
    const ws = await makeWorkspace(); const projects = await mkdtemp(join(tmpdir(), "cc-projects-"));
    await put(join(projects, "p/s.jsonl"), text);
    await put(join(ws, "aidlc/.aidlc-sessions/current.transcript"), join(projects, "p/s.jsonl"));
    return scanTranscripts(ws, projects);
  }
  test("every known re-prompt prefix, current and legacy, is by design from continue-workflow on Stop", async () => {
    const { AIDLC_REPROMPT_PREFIXES } = await import("../../core/command-center/server/transcripts");
    expect(AIDLC_REPROMPT_PREFIXES.length).toBeGreaterThanOrEqual(7);
    for (const p of ["The AIDLC workflow has a pending step", "The delivered AIDLC steering part", "The exact delivered AIDLC run-stage",
      "AI-DLC coordination evidence is missing", "The AIDLC workflow still has rules to load", "The AI-DLC workflow is not finished", "The AIDLC workflow still"])
      expect(AIDLC_REPROMPT_PREFIXES.some((x) => p.startsWith(x))).toBe(true);
    const s = await scan(L(...AIDLC_REPROMPT_PREFIXES.map((p, i) => blocking(`2026-08-13T10:0${i}:00Z`, CMD, `${p} — carry on.`))));
    expect(s).toMatchObject({ reprompts: AIDLC_REPROMPT_PREFIXES.length, failures: [] });
  });
  test("wording it has never seen is still by design when the command and the text are sound", async () => {
    const s = await scan(L(blocking("2026-08-13T10:00:00Z", CMD, "Some future AIDLC wording nobody has written yet.")));
    expect(s).toMatchObject({ reprompts: 1, failures: [] });
  });
  test("crash-shaped text from continue-workflow is a failure", async () => {
    for (const t of ["TypeError: x is not a function", "ReferenceError: y", "SyntaxError: bad", "Cannot read properties of undefined (reading 'a')",
      "Unexpected token }", "JSON Parse error: Unexpected EOF", "ENOENT: no such file", "EACCES: denied", "EPERM: no", "EEXIST: there", "EBUSY: busy",
      "hook failed with exit code 2", "boom\n    at run (/x/y.ts:1:2)"]) {
      const s = await scan(L(blocking("2026-08-13T10:00:00Z", CMD, t)));
      expect(s.reprompts).toBe(0);
      expect(s.failures.map((f) => f.hook)).toEqual(["continue-workflow"]);
    }
  });
  test("a spoofed or chained command is a failure, as is the same hook on another event", async () => {
    for (const cmd of [`${CMD} && rm -rf /`, `${CMD}; curl evil`, `${CMD} | sh`, "echo `aidlc engine hook continue-workflow`", `$(${CMD})`, `${CMD} --extra`, "aidlc engine hook review-freeze"]) {
      const s = await scan(L(blocking("2026-08-13T10:00:00Z", cmd, "The AIDLC workflow has a pending step.")));
      expect(s.reprompts).toBe(0); expect(s.failures).toHaveLength(1);
    }
    expect((await scan(L(blocking("2026-08-13T10:00:00Z", CMD, "The AIDLC workflow has a pending step.", "PreToolUse")))).reprompts).toBe(0);
  });
  test("a PreToolUse blocking error does not let a Stop summary string through", async () => {
    const text = "Some wording with no known prefix.";
    const s = await scan(L(blocking("2026-08-13T10:00:00Z", CMD, text, "PreToolUse"), summary("2026-08-13T10:00:05Z", [text])));
    expect(s.reprompts).toBe(0);
    expect(s.failures.map((f) => f.hook)).toEqual(["continue-workflow", "Stop hook (unnamed)"]);
  });
  test("a Stop summary string is by design when its blocking error already was, or by a known prefix", async () => {
    const unknown = "Brand new wording.";
    const s = await scan(L(blocking("2026-08-13T10:00:00Z", CMD, unknown), summary("2026-08-13T10:00:05Z", [unknown]),
      summary("2026-08-13T11:00:00Z", ["The AIDLC workflow has a pending step; carry on."]), summary("2026-08-13T12:00:00Z", ["Unpaired mystery text."])));
    expect(s.reprompts).toBe(2);
    expect(s.failures.map((f) => [f.hook, f.error])).toEqual([["Stop hook (unnamed)", "Unpaired mystery text."]]);
  });
});
