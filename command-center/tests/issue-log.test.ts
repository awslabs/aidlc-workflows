// The issue log's server side over synthetic records: audit line numbers, the cause builders (one per recorded
// shape, and null where nothing is recorded), evidence lines against a fixture shard, the read-only /api/file
// endpoint's containment, and the CSV export's quoting.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { intentHealth } from "../../core/command-center/server/health";
import type { Issue } from "../../core/command-center/server/hooks-map";
import { readWorkspaceFile } from "../../core/command-center/server/http";
import { startServer } from "../../core/command-center/server/index";
import {
  checkpointCause, dropCause, errorCause, evidenceFrom, guardAskCause, guardRecordCause, hookNotRunningCause, parseSensorDetail, sensorFailedCause, sensorFindingPoints, sensorNotRunCause, stallCause,
} from "../../core/command-center/server/issue-cause";
import { parseAuditText, readAuditIncremental } from "../../core/command-center/server/parse/audit";
import { listIntents } from "../../core/command-center/server/parse/registry";
import { csvField, CSV_COLUMNS, issuesCsv, issueText } from "../ui/src/health/issueReport";
import { AUDIT_HEADER, block, makeWorkspace } from "./fixtures/make";

const KEY = "default/260811-demo";
const REC = (w: string) => join(w, "aidlc/spaces/default/intents/260811-demo");
const ENG = (w: string) => join(REC(w), ".aidlc-engine");
const NOW = new Date("2026-08-13T23:21:00Z");
async function put(p: string, body: string) { await mkdir(join(p, ".."), { recursive: true }); await writeFile(p, body); }
async function health(ws: string) { const ref = (await listIntents(ws)).find((r) => `${r.space}/${r.dir}` === KEY)!; return intentHealth(ws, ref, REC(ws), NOW); }
const detailMd = (o: object) => ["# traceability finding — build-and-test", "", "**Timestamp**: 2026-08-13T10:00:00Z", "**Fire id**: f1", "**Output path**: x.md", "**Pass**: false", "", "## Findings", "", "```json", JSON.stringify(o, null, 2), "```", ""].join("\n");

describe("audit line numbers", () => {
  test("each entry carries the shard lines of its block, header and separators excluded", () => {
    const text = AUDIT_HEADER + block("2026-08-13T10:00:00Z", "STAGE_STARTED", { Stage: "a" }) + block("2026-08-13T10:01:00Z", "ERROR_LOGGED", { Tool: "Bash", Error: "boom" });
    const lines = text.split("\n");
    const { events } = parseAuditText(text, "s.md");
    expect(events.map((e) => [e.line, e.endLine])).toEqual([[3, 6], [10, 14]]);
    for (const e of events) { expect(lines[e.line! - 1]).toBe("## Entry"); expect(lines[e.endLine! - 1]).toMatch(/^\*\*/); }
    expect(lines[events[1]!.line! + 1]).toBe("**Event**: ERROR_LOGGED");
  });
  test("an incremental read continues the line count from where it left off", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cc-inc-")); const p = join(dir, "s.md");
    const one = AUDIT_HEADER + block("2026-08-13T10:00:00Z", "A");
    await writeFile(p, one);
    const r1 = await readAuditIncremental(p, null);
    await writeFile(p, one + block("2026-08-13T10:01:00Z", "B"));
    const r2 = await readAuditIncremental(p, r1.cursor);
    const all = parseAuditText(one + block("2026-08-13T10:01:00Z", "B"), "s.md").events;
    expect(r2.events[0]!.line).toBe(all[1]!.line);
    expect(r2.events[0]!.endLine).toBe(all[1]!.endLine);
    // A cursor primed from the file size alone has no known line: what it reads carries no line numbers.
    await writeFile(p, one + block("2026-08-13T10:01:00Z", "B") + block("2026-08-13T10:02:00Z", "C"));
    const r3 = await readAuditIncremental(p, { path: p, offset: r2.cursor.offset, size: r2.cursor.size, seq: 0 });
    expect(r3.events.map((e) => [e.event, e.line])).toEqual([["C", undefined]]);
    expect(r3.cursor.line).toBeUndefined();
  });
});

describe("cause builders", () => {
  test("SENSOR_FAILED lists the detail file's findings, then the Sensor ID and Output path", () => {
    const md = detailMd({ pass: false, gaps: ["FR-3"], orphans: [], missing_from_table: ["NFR-1"], findings_count: 2 });
    expect(parseSensorDetail(md)).toMatchObject({ gaps: ["FR-3"] });
    const c = sensorFailedCause({ "Sensor ID": "traceability", "Output path": "x.md", "Findings count": "2" }, md);
    expect(c.source).toBe("aidlc");
    expect(c.summary).toBe("traceability recorded 2 findings on x.md; the first are listed below.");
    expect(c.points).toEqual([{ label: "gap", value: "FR-3" }, { label: "missing from table", value: "NFR-1" }, { label: "Sensor ID", value: "traceability" }, { label: "Output path", value: "x.md" }]);
    // String findings are labelled by the singular of their key.
    expect(sensorFindingPoints({ unreferenced: ["a.md"], findings: ["claim without source"], invalid_entries: ["x"] }).map((p) => p.label)).toEqual(["unreferenced", "finding", "invalid entry"]);
    // required-sections: the H2 count it judged is a point, as are the sections a template says are missing.
    expect(sensorFindingPoints({ pass: false, h2_count: 1, headings: ["Intro"], template_missing: ["Risks"], findings_count: 1 })).toEqual([{ label: "template missing", value: "Risks" }, { label: "H2 sections found", value: "1" }]);
    // Object findings use their rule (or section) and message, with file:line; at most ten.
    const lint = sensorFindingPoints({ violations: Array.from({ length: 14 }, (_, i) => ({ file: "a.ts", line: i + 1, rule: "no-unused-vars", message: `'v${i}' is unused` })) });
    expect(lint).toHaveLength(10);
    expect(lint[0]).toEqual({ label: "no-unused-vars", value: "'v0' is unused (a.ts:1)" });
    // Without a rule, the location (file:line:column) is the label and the message the value.
    expect(sensorFindingPoints({ errors: [{ file: "b.ts", line: 4, column: 2, message: "Type error" }] })).toEqual([{ label: "b.ts:4:2", value: "Type error" }]);
    // A missing detail file still yields what the audit row records, and says the file was not readable.
    const bare = sensorFailedCause({ "Sensor ID": "linter", "Findings count": "1" }, null);
    expect(bare.summary).toContain("is not readable here");
    expect(bare.points).toEqual([{ label: "Sensor ID", value: "linter" }]);
  });
  test("a check that did not run: the Note, or the budget cap and observed value", () => {
    expect(sensorNotRunCause("SENSOR_PASSED", { "Sensor ID": "linter", Note: "tool-unavailable" }).points).toContainEqual({ label: "Note", value: "tool-unavailable" });
    const b = sensorNotRunCause("SENSOR_BUDGET_OVERRIDE", { "Sensor ID": "type-check", "Cap value": "30", "Observed value": "41", "Cap layer": "registry" });
    expect(b.summary).toBe("type-check ran past its time budget (cap 30 s, observed 41 s), so its result was not recorded.");
    expect(b.points.slice(0, 3)).toEqual([{ label: "Cap value", value: "30 s" }, { label: "Observed value", value: "41 s" }, { label: "Cap layer", value: "registry" }]);
  });
  test("guard refusals: the record's blocked action, invariant, codes, state and remedies; the logged ask's codes and remedies", () => {
    const rec = { count: 3, codes: ["REVIEW_BUDGET_SPENT"], updatedAt: "2026-08-13T10:00:00Z", refusal: { code: "REVIEW_BUDGET_SPENT", blockedAction: "record a review verdict", invariant: "at most 3 reviews per stage", state: "review-budget-spent", stage: "application-design",
      remedies: [{ action: "Ask the person", requiresHuman: true, executableNow: false }, { action: "Re-run", command: "aidlc review", executableNow: true }] } };
    const c = guardRecordCause(rec)!;
    expect(c.summary).toBe("AIDLC refused to record a review verdict: at most 3 reviews per stage (refused 3×).");
    for (const p of [{ label: "Invariant", value: "at most 3 reviews per stage" }, { label: "Reason codes", value: "REVIEW_BUDGET_SPENT" }, { label: "State", value: "review-budget-spent" },
      { label: "Remedy 1", value: "Ask the person · needs a person, not runnable now" }, { label: "Remedy 2", value: "Re-run (aidlc review) · the agent can run it now" }]) expect(c.points).toContainEqual(p);
    expect(guardRecordCause({ count: 1 })).toBeNull();
    const ask = JSON.stringify({ kind: "ask", ask_type: "guard-recovery", question: "How?", stage: "s", reason_codes: ["R1", "R2"], remedies: [{ action: "Do it", requiresHuman: false, executableNow: true }], state_signature: "sig" });
    const a = guardAskCause(`Refusing: budget spent.\n${ask}`, { Tool: "Bash", Command: "aidlc x" })!;
    expect(a.summary).toBe("Refusing: budget spent.");
    expect(a.points).toContainEqual({ label: "Reason codes", value: "R1, R2" });
    expect(a.points).toContainEqual({ label: "Remedy 1", value: "Do it · the agent can run it now" });
    expect(guardAskCause("no ask here", {})).toBeNull();
  });
  test("ERROR_LOGGED: tool, clipped command, first line, and the errno or error class", () => {
    const c = errorCause({ Tool: "Bash", Command: "x".repeat(400), Error: "ENOENT: no such file or directory, open 'a'\n    at foo" });
    expect(c.points).toContainEqual({ label: "Error", value: "ENOENT: no such file or directory, open 'a'" });
    expect(c.points).toContainEqual({ label: "Errno", value: "ENOENT" });
    expect(c.points.find((p) => p.label === "Command")!.value).toHaveLength(300);
    expect(errorCause({ Error: "TypeError: x is not a function" }).points).toContainEqual({ label: "Error class", value: "TypeError" });
    expect(c.summary).toBe("ERROR_LOGGED recorded for Bash: ENOENT: no such file or directory, open 'a'");
    expect(errorCause({}).summary).toBe("The entry records no error text.");
  });
  test("checkpoints: exit code, signal, error code, the last lines of stderr and stdout, and times", () => {
    const c = checkpointCause({ command_label: "bun test", exit_code: 134, signal: "SIGABRT", started_at: "s", finished_at: "f", stderr_tail: Array.from({ length: 9 }, (_, i) => `e${i}`).join("\n"), stdout_tail: "" }, "failed");
    expect(c.summary).toBe("bun test finished with exit code 134 and signal SIGABRT.");
    expect(c.points).toContainEqual({ label: "stderr (last lines)", value: "e3\ne4\ne5\ne6\ne7\ne8" });
    expect(c.points.some((p) => p.label.startsWith("stdout"))).toBe(false);
    expect(checkpointCause({ started_at: "s", finished_at: null }, "crashed").points).toContainEqual({ label: "Finished", value: "not recorded" });
    expect(checkpointCause({ error: "CHECK_KEPT_CHANGING" }, "non-idempotent").points).toContainEqual({ label: "Error code", value: "CHECK_KEPT_CHANGING" });
  });
  test("hook drops, hooks not running and a stalled run", () => {
    const d = dropCause({ reason: "row dropped", at: "t", category: "audit write lost", hook: "review-freeze", phase: "PreToolUse", file: "aidlc/x.drops", line: 2 });
    expect(d.points.slice(0, 4)).toEqual([{ label: "Drop line", value: "row dropped" }, { label: "Category", value: "audit write lost" }, { label: "Hook", value: "review-freeze" }, { label: "Phase", value: "PreToolUse" }]);
    const h = hookNotRunningCause({ newestHook: "write-audit-log", newestAt: "2026-08-13T10:00:00Z", progressEvent: "GATE_APPROVED", progressAt: "2026-08-13T10:35:00Z", progressStage: "s" });
    expect(h.summary).toContain("35 min older");
    expect(h.points).toContainEqual({ label: "Dashboard threshold", value: "5 min" });
    expect(JSON.stringify(h)).not.toContain("AIDLC allows");
    expect(h.points).toContainEqual({ label: "Newest heartbeat", value: "write-audit-log · 2026-08-13T10:00:00Z" });
    expect(hookNotRunningCause({ newestHook: null, newestAt: null, progressEvent: "STAGE_STARTED", progressAt: "t", progressStage: null }).points[0]).toEqual({ label: "Newest heartbeat", value: "none recorded" });
    const st = stallCause({ signature: "code-generation::abc::def", count: 9 }, 8);
    expect(st.points).toContainEqual({ label: "Stage in the signature", value: "code-generation" });
    expect(st.summary).toBe("block-count.json records 9 no-progress blocks against a cap of 8 while the state named code-generation.");
  });
  test("evidence is the asked-for line range with real line numbers, clipped around the focus line", () => {
    const lines = Array.from({ length: 200 }, (_, i) => `L${i + 1}`).concat([""]);
    const e = evidenceFrom("f.md", lines, 1, 200, 150);
    expect(e.startLine).toBe(140); expect(e.lines[0]).toBe("L140"); expect(e.lines).toHaveLength(60);
    expect(evidenceFrom("f.md", lines, 199, 210, 200).lines).toEqual(["L199", "L200"]); // the trailing newline is not a line
  });
});

describe("issues carry their cause and evidence", () => {
  let ws: string;
  beforeAll(async () => {
    ws = await makeWorkspace({ extraShard: AUDIT_HEADER
      + block("2026-08-13T10:00:00Z", "SENSOR_FAILED", { "Stage slug": "functional-design", "Sensor ID": "traceability", "Output path": "x.md", "Findings count": "1", "Detail path": "aidlc/spaces/default/intents/260811-demo/.aidlc-engine/sensors/functional-design/traceability-f1.md" }, "SENSOR_FAILED")
      + block("2026-08-13T10:05:00Z", "ERROR_LOGGED", { Tool: "Bash", Command: "aidlc state get", Error: "EACCES: permission denied, open 'x'" }, "ERROR_LOGGED")
      + block("2026-08-13T10:06:00Z", "GUARD_STOOD_ASIDE", { Guard: "review-freeze", Authority: "instruction", Actor: "subagent", Tool: "Edit", Stage: "functional-design" }, "GUARD_STOOD_ASIDE") });
    await put(join(ENG(ws), "sensors/functional-design/traceability-f1.md"), detailMd({ pass: false, gaps: ["FR-9"], findings_count: 1 }));
    await put(join(ENG(ws), "hooks-health/review-freeze.drops"), "2026-08-12T10:00:00Z\taudit lock contended; row dropped\n2026-08-12T10:05:00Z\taudit lock contended; row dropped\n");
  });
  test("a failed check: its audit block with the shard's real line numbers, its findings and its detail file as supporting", async () => {
    const h = await health(ws);
    const it = h.issues.find((i) => i.kind === "Check failed")!;
    expect(it.cause!.points[0]).toEqual({ label: "gap", value: "FR-9" });
    const ev = it.evidence!;
    const shards = join(REC(ws), "audit");
    const file = ev.auditFile.split("/").at(-1)!;
    const real = (await readFile(join(shards, file), "utf8")).split("\n");
    expect(ev.auditFile).toBe(`aidlc/spaces/default/intents/260811-demo/audit/${file}`);
    expect(real[ev.startLine - 1]).toBe("## SENSOR_FAILED");
    expect(ev.lines).toEqual(real.slice(ev.startLine - 1, ev.startLine - 1 + ev.lines.length));
    expect(ev.lines.at(-1)).toMatch(/^\*\*Detail path\*\*/);
    expect(ev.focusLine).toBe(ev.startLine);
    expect(ev.supporting).toEqual([{ path: "aidlc/spaces/default/intents/260811-demo/.aidlc-engine/sensors/functional-design/traceability-f1.md", label: "traceability findings (the sensor's detail file)", kind: "sensor-detail" }]);
    expect(it.source.file).toContain("traceability-f1.md");
  });
  test("an internal error has its errno; a hook drop shows its own line; a bypass has evidence but no cause", async () => {
    const h = await health(ws);
    const err = h.issues.find((i) => i.kind === "Internal error")!;
    expect(err.cause!.points).toContainEqual({ label: "Errno", value: "EACCES" });
    const drop = h.issues.find((i) => i.kind === "Hook drop · audit write lost")!;
    expect(drop.evidence).toMatchObject({ auditFile: "aidlc/spaces/default/intents/260811-demo/.aidlc-engine/hooks-health/review-freeze.drops", startLine: 1, focusLine: 2 });
    expect(drop.evidence!.lines).toEqual(["2026-08-12T10:00:00Z\taudit lock contended; row dropped", "2026-08-12T10:05:00Z\taudit lock contended; row dropped"]);
    expect(drop.cause!.points[0]).toEqual({ label: "Drop line", value: "audit lock contended; row dropped" });
    const by = h.issues.find((i) => i.kind === "Bypass · guard stood aside")!;
    expect(by.cause).toBeNull();
    expect(by.evidence!.lines[0]).toBe("## GUARD_STOOD_ASIDE");
  });
});

describe("GET /api/file", () => {
  type S = Awaited<ReturnType<typeof startServer>>;
  let s: S; let ws: string;
  const get = (w: string, p: string, token = true) => fetch(`http://127.0.0.1:${s.port}/api/file?ws=${encodeURIComponent(w)}&path=${encodeURIComponent(p)}${token ? `&t=${s.token}` : ""}`);
  beforeAll(async () => {
    ws = await makeWorkspace();
    const out = await mkdtemp(join(tmpdir(), "cc-out-"));
    await writeFile(join(out, "secret.md"), "outside");
    await put(join(ENG(ws), "sensors/a/x-1.md"), "# finding\n");
    await put(join(ENG(ws), "bin.json"), "a\u0000b");
    await writeFile(join(ws, "README.md"), "not in aidlc");
    await symlink(join(out, "secret.md"), join(ENG(ws), "escape.md"));
    await symlink(out, join(ENG(ws), "outdir"));
    s = await startServer({ port: 0, config: { version: 1, roots: [], pins: [ws], hidden: [], repos: [], theme: "auto" }, configPath: join(await mkdtemp(join(tmpdir(), "cc-")), "c.json"), uiDir: out });
  });
  afterAll(() => s.stop());
  test("a text file inside <ws>/aidlc is served read-only as JSON", async () => {
    const r = await get(ws, "aidlc/spaces/default/intents/260811-demo/.aidlc-engine/sensors/a/x-1.md");
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ path: "aidlc/spaces/default/intents/260811-demo/.aidlc-engine/sensors/a/x-1.md", body: "# finding\n", truncated: false, size: 10 });
    expect(r.headers.get("cache-control")).toBe("no-store");
  });
  test("`..`, absolute paths, symlink escapes, files outside aidlc/, binaries and unknown workspaces are 404; no token is 401", async () => {
    const eng = "aidlc/spaces/default/intents/260811-demo/.aidlc-engine";
    for (const p of ["aidlc/../README.md", "README.md", `${eng}/../../../../../../README.md`, join(ws, "README.md"), join(ws, "aidlc/spaces/default/intents/intents.json"), "/etc/hosts",
      `${eng}/escape.md`, `${eng}/outdir/secret.md`, `${eng}/bin.json`, "aidlc", "aidlc/spaces", "", "aidlc/x\u0000.md"]) {
      expect([p, (await get(ws, p)).status]).toEqual([p, 404]);
    }
    expect((await get(`${ws}/`, "aidlc/spaces/default/intents/intents.json")).status).toBe(404);
    expect((await get("/elsewhere", "aidlc/spaces/default/intents/intents.json")).status).toBe(404);
    expect((await get(ws, "aidlc/spaces/default/intents/intents.json", false)).status).toBe(401);
    expect((await get(ws, "aidlc/spaces/default/intents/intents.json")).status).toBe(200);
  });
  test("large files are capped and marked truncated", async () => {
    await put(join(ENG(ws), "big.log"), "x".repeat(1024 * 1024 + 10));
    const r = await readWorkspaceFile(ws, "aidlc/spaces/default/intents/260811-demo/.aidlc-engine/big.log");
    expect(r!.truncated).toBe(true); expect(r!.body.length).toBe(1024 * 1024);
  });
});

describe("CSV and the text report", () => {
  const issue: Issue & { workspace: string; intentKey: string; intentName: string } = {
    id: "a", group: "failure", resolved: null, at: "2026-08-13T10:00:00Z", firstAt: "2026-08-13T09:00:00Z", where: { stage: "build-and-test", unit: "api", hook: "run-sensors", hookPhase: "PostToolUse" },
    kind: "Check failed", message: 'lint said "no", then, a\nsecond line', recoverable: "yes", fix: { text: "Fix it", source: "hint" }, source: { file: "aidlc/a.md", line: 3 }, count: 2, needsFixing: true,
    cause: { summary: "x, y", points: [{ label: "gaps", value: "FR-1" }], source: "aidlc" }, evidence: { auditFile: "aidlc/audit/s.md", startLine: 7, lines: ["## SENSOR_FAILED", "**Event**: SENSOR_FAILED"], focusLine: 7, supporting: [] },
    workspace: "/w/a,b", intentKey: "default/x", intentName: "refunds",
  };
  test("RFC 4180: commas, quotes and newlines are quoted, quotes doubled, CRLF line ends; the columns are fixed", () => {
    expect(csvField("plain")).toBe("plain");
    expect(csvField('a "b"')).toBe('"a ""b"""');
    expect(csvField("a,b")).toBe('"a,b"');
    expect(csvField("a\nb")).toBe('"a\nb"');
    expect(csvField(null)).toBe("");
    // Spreadsheet formula injection: a leading = + - @, tab or CR is neutralised with a quote; numbers are left alone.
    expect(["=HYPERLINK(1)", "+1", "-cmd", "@SUM(A1)", "\tx", "\rx"].map(csvField)).toEqual(["'=HYPERLINK(1)", "'+1", "'-cmd", "'@SUM(A1)", "'\tx", "\"'\rx\""]);
    expect(csvField(-3)).toBe("-3");
    expect(issuesCsv([{ ...issue, message: "=cmd|' /C calc'!A0" }])).toContain(",'=cmd|' /C calc'!A0,");
    const csv = issuesCsv([issue]);
    const [head, row] = csv.split("\r\n");
    expect(head).toBe(CSV_COLUMNS.join(","));
    expect(head).toBe("recorded_at,group,state,kind,workspace,intent,stage,unit,hook,phase,count,first_recorded,last_recorded,recoverable,message,cause_summary,remedy,remedy_source,resolved_by,resolved_at,audit_file,audit_line");
    expect(row).toBe('2026-08-13T10:00:00Z,Failure,Open,Check failed,"/w/a,b",refunds,build-and-test,api,run-sensors,PostToolUse,2,2026-08-13T09:00:00Z,2026-08-13T10:00:00Z,yes,"lint said ""no"", then, a\nsecond line","x, y",Fix it,hint,,,aidlc/audit/s.md,7');
    expect(csv.endsWith("7\r\n")).toBe(true);
  });
  test("the text report carries the fields, the cause, and the evidence lines with the focus marked", () => {
    const t = issueText(issue);
    for (const s of ["Check failed [Failure · Open]", "Workspace: /w/a,b", "Stage / unit: build-and-test · api", "Hook / phase: run-sensors · Post", "first 2026-08-13T09:00:00Z, last 2026-08-13T10:00:00Z",
      "Cause (from the records): x, y", "  - gaps: FR-1", "Remedy (Hint): Fix it", "Resolution: No resolution recorded.", "Evidence: aidlc/audit/s.md", ">     7  ## SENSOR_FAILED", "      8  **Event**: SENSOR_FAILED"]) expect(t).toContain(s);
    expect(issueText({ ...issue, cause: null })).toContain("No cause recorded — AIDLC wrote only the message above.");
  });
});
