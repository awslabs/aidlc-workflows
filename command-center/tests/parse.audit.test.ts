import { describe, expect, test } from "bun:test";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { mergeShards, parseAuditText, readAuditDir, readAuditIncremental } from "../../core/command-center/server/parse/audit";
import { AUDIT_HEADER, block, makeWorkspace } from "./fixtures/make";

describe("parseAuditText", () => {
  test("parses blocks with fields", () => {
    const r = parseAuditText(AUDIT_HEADER + block("2026-08-12T17:13:18Z", "GATE_APPROVED", { Stage: "x", "User Input": "Approve" }), "s1");
    expect(r.events).toHaveLength(1);
    expect(r.events[0]!.event).toBe("GATE_APPROVED");
    expect(r.events[0]!.fields["User Input"]).toBe("Approve");
  });
  test("holds back an unterminated tail", () => {
    const text = AUDIT_HEADER + block("2026-08-12T17:00:00Z", "STAGE_STARTED", { Stage: "x" }) + "\n## Half\n**Timestamp**: 2026-08-12T17:01:00Z\n**Event**: STAGE_COMP";
    const r = parseAuditText(text, "s1");
    expect(r.events).toHaveLength(1);
    expect(r.tailHeld).toBeGreaterThan(0);
  });
  test("tolerates a block with no Event line (append-raw)", () => {
    const r = parseAuditText(AUDIT_HEADER + block("2026-08-12T17:00:00Z", null, { Note: "free" }, "Raw note"), "s1");
    expect(r.events[0]!.event).toBeNull();
    expect(r.unparsed).toBe(0);
  });
  test("uses the first Timestamp when a block has two", () => {
    const r = parseAuditText("\n## X\n**Timestamp**: 2026-01-01T00:00:00Z\n**Timestamp**: 2027-01-01T00:00:00Z\n**Event**: HUMAN_TURN\n\n---\n", "s");
    expect(r.events[0]!.ts).toBe("2026-01-01T00:00:00Z");
  });
  test("counts a block with no Timestamp as unparsed", () => {
    expect(parseAuditText("\n## X\n**Event**: HUMAN_TURN\n\n---\n", "s").unparsed).toBe(1);
  });
  test("unescapes \\n in values", () => {
    const r = parseAuditText(block("2026-01-01T00:00:00Z", "ERROR_LOGGED", { Error: "a\\nb" }), "s");
    expect(r.events[0]!.fields.Error).toBe("a\nb");
  });
});

test("mergeShards sorts by timestamp, stable within a shard", () => {
  const a = parseAuditText(block("2026-01-01T00:00:02Z", "A") + block("2026-01-01T00:00:02Z", "B"), "a").events;
  const b = parseAuditText(block("2026-01-01T00:00:01Z", "C"), "b").events;
  expect(mergeShards([a, b]).map((e) => e.event)).toEqual(["C", "A", "B"]);
});

test("readAuditDir merges every shard", async () => {
  const ws = await makeWorkspace({ extraShard: AUDIT_HEADER + block("2026-08-11T21:00:00Z", "WORKFLOW_STARTED", {}) });
  const r = await readAuditDir(join(ws, "aidlc/spaces/default/intents/260811-demo/audit"), join(ws, "aidlc"));
  expect(r.events[0]!.event).toBe("WORKFLOW_STARTED");
  expect(r.events.length).toBe(19);
});

test("readAuditIncremental returns only new complete blocks and rewinds on truncation", async () => {
  const ws = await makeWorkspace();
  const p = join(ws, "aidlc/spaces/default/intents/260811-demo/audit/hosta-aaaaaaaaaaaa.md");
  const first = await readAuditIncremental(p, null);
  expect(first.events.length).toBe(18);
  await appendFile(p, block("2026-08-13T23:40:00Z", "HUMAN_TURN"));
  const second = await readAuditIncremental(p, first.cursor);
  expect(second.events.map((e) => e.event)).toEqual(["HUMAN_TURN"]);
  expect(second.reset).toBe(false);
  await Bun.write(p, AUDIT_HEADER);
  const third = await readAuditIncremental(p, second.cursor);
  expect(third.reset).toBe(true);
});

test("readAuditIncremental holds a non-ASCII tail and completes it byte-correctly", async () => {
  const ws = await makeWorkspace();
  const p = join(ws, "aidlc/spaces/default/intents/260811-demo/audit/hosta-aaaaaaaaaaaa.md");
  const full = block("2026-08-13T23:40:00Z", "HUMAN_TURN", { Note: "caf\u00e9 \u2014 \u2192 done" });
  const cut = full.indexOf("done");
  const first = await readAuditIncremental(p, null);
  await appendFile(p, full.slice(0, cut));
  const held = await readAuditIncremental(p, first.cursor);
  expect(held.events).toEqual([]);
  expect(held.cursor.offset).toBe(first.cursor.offset);
  await appendFile(p, full.slice(cut));
  const done = await readAuditIncremental(p, held.cursor);
  expect(done.events.map((e) => e.fields.Note)).toEqual(["caf\u00e9 \u2014 \u2192 done"]);
  expect(done.cursor.offset).toBe((await Bun.file(p).arrayBuffer()).byteLength);
});

describe("CRLF shards (a Windows checkout)", () => {
  const crlf = (s: string) => s.replace(/\n/g, "\r\n");
  const lf = AUDIT_HEADER + block("2026-08-12T17:13:18Z", "GATE_APPROVED", { Stage: "x", "User Input": "Approve" })
    + block("2026-08-12T17:14:00Z", "STAGE_STARTED", { Stage: "y" });

  test("parse the same events, fields and line numbers as LF", () => {
    const a = parseAuditText(lf, "s1"); const b = parseAuditText(crlf(lf), "s1");
    expect(b.events).toEqual(a.events);
    expect(b.events.map((e) => e.event)).toEqual(["GATE_APPROVED", "STAGE_STARTED"]);
    expect(b.events[0]!.fields["User Input"]).toBe("Approve");
    expect(b.tailHeld).toBe(0);
  });

  test("an incremental read of a CRLF shard advances to the end and returns only the new block", async () => {
    const ws = await makeWorkspace();
    const p = join(ws, "aidlc/spaces/default/intents/260811-demo/audit/hosta-aaaaaaaaaaaa.md");
    await Bun.write(p, crlf(lf));
    const first = await readAuditIncremental(p, null);
    expect(first.events.map((e) => e.event)).toEqual(["GATE_APPROVED", "STAGE_STARTED"]);
    expect(first.cursor.offset).toBe(Bun.file(p).size);
    await appendFile(p, crlf(block("2026-08-12T17:15:00Z", "HUMAN_TURN")));
    const second = await readAuditIncremental(p, first.cursor);
    expect(second.events.map((e) => e.event)).toEqual(["HUMAN_TURN"]);
    const whole = parseAuditText(crlf(lf + block("2026-08-12T17:15:00Z", "HUMAN_TURN")), "hosta-aaaaaaaaaaaa.md");
    expect(second.events[0]!.line).toBe(whole.events[2]!.line);
    expect(second.cursor.offset).toBe(Bun.file(p).size);
  });
});
