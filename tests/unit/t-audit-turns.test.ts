// covers: subcommand:aidlc-audit:turns
//
// `audit turns` shows each HUMAN_TURN with what the person sent, read from this
// machine's message record by the row's Message Id. The committed audit keeps
// no words (#1505), and the reader writes nothing.

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { UNTRUSTED_AUDIT_NOTICE } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { saveMessage, type StoredMessage } from "../../dist/claude/.claude/tools/aidlc-message-store.ts";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createTestProject,
  seededAuditDir,
  seedStateFile,
} from "../harness/fixtures.ts";
import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const CHAT = "sess-person";
const projects: string[] = [];

afterEach(() => {
  for (const project of projects.splice(0)) cleanupTestProject(project);
});

function project(): string {
  const pd = createTestProject();
  projects.push(pd);
  seedStateFile(pd, "state-mid-ideation.md");
  mkdirSync(seededAuditDir(pd), { recursive: true });
  return pd;
}

function now(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function message(pd: string, text: string, session: string | null = CHAT): StoredMessage {
  return saveMessage(pd, {
    session, at: now(), source: "prompt", text, picker: null, words: text, settings: [],
    route: { scope: null, newIntent: false, skip: [], add: [], projectType: null },
  });
}

function turn(fields: Record<string, string>, timestamp = "2026-10-14T01:00:00Z"): string {
  return `## Human Turn\n**Timestamp**: ${timestamp}\n**Event**: HUMAN_TURN\n` +
    Object.entries({ Origin: "person", Source: "typed", ...fields }).map(([key, value]) => `**${key}**: ${value}\n`).join("") +
    "\n---\n";
}

function shard(pd: string, content: string): void {
  writeFileSync(join(seededAuditDir(pd), "fixture.md"), content);
}

function snapshot(dir: string): Record<string, string> {
  const entries: Record<string, string> = {};
  const walk = (path: string, prefix: string): void => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const name = `${prefix}${entry.name}`;
      if (entry.isDirectory()) {
        entries[`${name}/`] = "";
        walk(join(path, entry.name), `${name}/`);
      } else if (!entry.isSymbolicLink()) {
        entries[name] = readFileSync(join(path, entry.name)).toString("base64");
      }
    }
  };
  walk(dir, "");
  return entries;
}

function turns(pd: string, args: string[] = []) {
  const before = snapshot(pd);
  const result = spawnSync(process.execPath, [
    join(AIDLC_SRC, "tools", "aidlc.ts"), "engine", "audit", "turns", ...args, "--project-dir", pd,
  ], { cwd: pd, encoding: "utf-8", timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS) });
  expect(result.error).toBeUndefined();
  expect(snapshot(pd)).toEqual(before);
  return result;
}

function read(pd: string, args: string[] = []) {
  const result = turns(pd, args);
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout.trim().split("\n")).toHaveLength(1);
  expect(Object.keys(JSON.parse(result.stdout))[0]).toBe("data_notice");
  const { data_notice, ...payload } = JSON.parse(result.stdout);
  expect(data_notice).toBe(UNTRUSTED_AUDIT_NOTICE);
  return payload.turns as Array<Record<string, unknown> & { message: Record<string, unknown> | null }>;
}

describe("audit turns", () => {
  test("a turn shows the words its message record holds, and nothing is written", () => {
    const pd = project();
    const sent = message(pd, "keep the API key out of the README");
    shard(pd, turn({ Session: CHAT, "Message Id": sent.id }));
    const [only] = read(pd);
    expect(only.message).toEqual({ at: sent.at, source: "prompt", text: sent.text, words: sent.text, picker: null });
    expect(only).not.toHaveProperty("message_unavailable");
    // The committed shard carries no words: they come from the local record only.
    expect(readFileSync(join(seededAuditDir(pd), "fixture.md"), "utf-8")).not.toContain("README");
  });

  test("a record not on this machine, or expired, is said, never guessed", () => {
    const pd = project();
    shard(pd, turn({ Session: CHAT, "Message Id": "0badc0de" }));
    const [only] = read(pd);
    expect(only.message).toBeNull();
    expect(only.message_unavailable).toBe("not on this machine, or expired");
  });

  test("a record from another chat is never joined to the row", () => {
    const pd = project();
    const elsewhere = message(pd, "words typed in another chat", "sess-other");
    shard(pd, turn({ Session: CHAT, "Message Id": elsewhere.id }));
    expect(read(pd)[0].message).toBeNull();
  });

  test("a row an earlier release wrote, with no Message Id, says it has no record", () => {
    const pd = project();
    shard(pd, turn({ Session: CHAT }));
    const [only] = read(pd);
    expect(only.message).toBeNull();
    expect(only.message_unavailable).toBe("no message record");
  });

  test("a record that is a link is not followed", () => {
    const pd = project();
    const sent = message(pd, "original words");
    const record = join(pd, "aidlc", ".aidlc-sessions", "messages", `${sent.id}.json`);
    const outside = join(dirname(pd), `outside-${sent.id}.json`);
    writeFileSync(outside, readFileSync(record));
    writeFileSync(record, "");
    const linked = join(dirname(record), "deadbeef.json");
    symlinkSync(outside, linked);
    shard(pd, turn({ Session: CHAT, "Message Id": "deadbeef" }));
    expect(read(pd)[0].message).toBeNull();
  });

  test("only HUMAN_TURN rows are listed, oldest first, and --limit keeps the latest", () => {
    const pd = project();
    const first = message(pd, "first");
    const second = message(pd, "second");
    shard(pd, [
      turn({ Session: CHAT, "Message Id": first.id }, "2026-10-14T01:00:00Z"),
      "## Gate\n**Timestamp**: 2026-10-14T01:00:30Z\n**Event**: GATE_APPROVED\n**Stage**: requirements-analysis\n\n---\n",
      turn({ Session: CHAT, "Message Id": second.id }, "2026-10-14T01:01:00Z"),
    ].join(""));
    expect(read(pd).map((entry) => entry.message?.text)).toEqual(["first", "second"]);
    expect(read(pd, ["--limit", "1"]).map((entry) => entry.message?.text)).toEqual(["second"]);
  });

  test("an unknown argument is refused", () => {
    const pd = project();
    shard(pd, turn({ Session: CHAT }));
    const result = turns(pd, ["--event", "HUMAN_TURN"]);
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain("Unknown turns argument: --event");
  });

  test("a delegated agent is not admitted to the person's words", () => {
    const guard = readFileSync(join(AIDLC_SRC, "hooks", "aidlc-state-transition-guard.ts"), "utf-8");
    expect(guard).toContain('"aidlc-audit.ts": ["history"],');
  });
});
