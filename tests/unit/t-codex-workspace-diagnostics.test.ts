import { expect, test } from "bun:test";
import {
  existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync,
  renameSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sanitizeLogs } from "../../scripts/ci-sanitize-logs.ts";
import { recordCodexExec, withCodexFixture } from "../harness/codex-test-lifecycle.ts";
import { createCodexWorkspaceFailureCapture } from "../harness/codex-turn-evidence.ts";

const ID = "00000000-0000-4000-8000-000000000001";
const OTHER_ID = "00000000-0000-4000-8000-000000000002";
const COMMAND = 'bun .codex/tools/aidlc.ts engine intent create --scope poc --arguments "example"';
const jsonl = (values: unknown[]) => values.map(value => JSON.stringify(value)).join("\n");
const response = (payload: unknown) => ({ type: "response_item", payload });
const stdout = jsonl([
  { type: "thread.started", thread_id: ID },
  { type: "item.completed", item: { id: "item_0", type: "command_execution",
    command: COMMAND, status: "completed", exit_code: 0, aggregated_output: "" } },
  { type: "turn.completed" },
]);

function fixture() {
  const temporary = realpathSync(mkdtempSync(join(tmpdir(), "codex-diagnostic-")));
  const root = join(temporary, "project"), home = join(root, ".home");
  const artifacts = join(temporary, "artifacts");
  const sessions = join(home, "sessions");
  const shard = join(sessions, "2026", "01", "01");
  const record = join(root, "aidlc", "spaces", "default", "intents", "260101-example");
  for (const path of [shard, artifacts, join(record, "audit")]) mkdirSync(path, { recursive: true });
  writeFileSync(join(root, "aidlc", "active-space"), "default\n");
  writeFileSync(join(record, "..", "active-intent"), "260101-example\n");
  writeFileSync(join(record, "aidlc-state.md"), "Status: Running\nLast Completed Stage: state-init\n");
  writeFileSync(join(record, "audit", "session.md"), "WORKFLOW_STARTED\nSTAGE_COMPLETED state-init\n");
  writeFileSync(join(home, "auth.json"), "AUTH_FILE_MUST_NOT_BE_CAPTURED");
  const rollout = join(shard, `rollout-2026-01-01T00-00-00-${ID}.jsonl`);
  const output = join(artifacts, "codex-workspace-failure.json");
  const metadata = { type: "session_meta", payload: { id: ID, cwd: root, source: "exec",
    privateProfile: "PROFILE_MUST_NOT_BE_CAPTURED" } };
  const rows = [
    metadata,
    response({ type: "reasoning", encrypted_content: "REASONING_MUST_NOT_BE_CAPTURED" }),
    response({ type: "message", role: "assistant", content: "PROSE_MUST_NOT_BE_CAPTURED" }),
    response({ type: "function_call", name: "exec_command", call_id: "call-1",
      arguments: JSON.stringify({ cmd: COMMAND }) }),
    response({ type: "function_call_output", call_id: "call-1", output: "Process running with session ID 123\n" }),
    response({ type: "function_call", name: "write_stdin", call_id: "call-2",
      arguments: JSON.stringify({ session_id: 123, chars: "" }) }),
    response({ type: "function_call_output", call_id: "call-2",
      output: 'Process exited with code 0\nState initialized: poc scope\n{"secretAccessKey":"SYNTHETIC_SECRET"}' }),
    response({ type: "custom_tool_call", name: "shell_command", call_id: "call-3",
      input: "bun .codex/tools/aidlc.ts engine space default" }),
    response({ type: "custom_tool_call_output", call_id: "call-3", output: "Active space -> default\n" }),
    response({ type: "function_call", name: "exec_command", call_id: "unrelated",
      arguments: JSON.stringify({ cmd: "cat .home/auth.json" }) }),
    response({ type: "function_call_output", call_id: "unrelated", output: "UNRELATED_OUTPUT_MUST_NOT_BE_CAPTURED" }),
  ];
  writeFileSync(rollout, jsonl(rows));
  return { temporary, root, home, artifacts, sessions, shard, record, rollout, output, metadata, rows,
    execution: { cwd: root, stdout, rc: 0 },
    capture: () => createCodexWorkspaceFailureCapture(root, home, artifacts),
    read: () => JSON.parse(readFileSync(output, "utf8")),
    cleanup: () => rmSync(temporary, { recursive: true, force: true }) };
}

test("workspace diagnostics retain only the root CLI call/output pairs and active state before cleanup", async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.shard, `rollout-other-${OTHER_ID}.jsonl`), "UNRELATED_THREAD_MUST_NOT_BE_READ");
    const capture = f.capture();
    const primary = new Error("original stdout assertion");
    let cleaned = false;
    await expect(withCodexFixture(f.root, () => {
      expect(existsSync(f.output)).toBe(true);
      rmSync(f.root, { recursive: true, force: true });
      cleaned = true;
    }, () => {
      recordCodexExec("diagnostic-unit", f.root, ["codex", "exec", "--json"], { rc: 0, stdout, stderr: "" });
      throw primary;
    }, undefined, capture)).rejects.toBe(primary);
    expect(cleaned).toBe(true);
    const data = f.read();
    expect(data.threadId).toBe(ID);
    expect(data.issues).toEqual([]);
    expect(data.commands[0]).toMatchObject({ exitCode: 0, status: "completed", output: { text: "" } });
    expect(data.tools.map((row: { callId: string }) => row.callId)).toEqual([
      "call-1", "call-1", "call-2", "call-2", "call-3", "call-3",
    ]);
    expect(data.tools[3]).toMatchObject({ exitCode: 0 });
    expect(data.tools[3].output.text).toContain("State initialized: poc scope");
    expect(data.files).toHaveLength(2);
    expect(data.files[0].text).toContain("state-init");
    expect(data.files[1].text).toContain("WORKFLOW_STARTED");
    await sanitizeLogs(f.artifacts);
    const retained = readFileSync(f.output, "utf8");
    expect(retained).toContain("[REDACTED]");
    for (const forbidden of ["SYNTHETIC_SECRET", "AUTH_FILE_MUST", "PROFILE_MUST", "REASONING_MUST",
      "PROSE_MUST", "UNRELATED_OUTPUT_MUST", "UNRELATED_THREAD_MUST"]) expect(retained).not.toContain(forbidden);
  } finally { f.cleanup(); }
});

test.each(["thread", "cwd", "subagent"] as const)("root rollout rejects mismatched %s metadata", mismatch => {
  const f = fixture();
  try {
    const payload = { ...f.metadata.payload,
      ...(mismatch === "thread" ? { id: OTHER_ID } : mismatch === "cwd" ? { cwd: f.temporary } :
        { source: { subagent: { parent_thread_id: ID } } }) };
    writeFileSync(f.rollout, jsonl([{ type: "session_meta", payload }, ...f.rows.slice(1)]));
    f.capture()(f.execution);
    expect(f.read().tools).toEqual([]);
    expect(f.read().issues.join("\n")).toContain("root rollout:");
  } finally { f.cleanup(); }
});

test.each(["home", "sessions", "shard", "rollout", "hardlink", "state"] as const)(
  "workspace capture refuses external %s links", kind => {
    const f = fixture();
    try {
      const outside = join(f.temporary, "outside");
      mkdirSync(outside);
      const externalFile = join(outside, "secret.txt");
      writeFileSync(externalFile, "EXTERNAL_MUST_NOT_BE_CAPTURED");
      const path = kind === "home" ? f.home : kind === "sessions" ? f.sessions : kind === "shard" ? f.shard :
        kind === "state" ? join(f.record, "aidlc-state.md") : f.rollout;
      const directory = ["home", "sessions", "shard"].includes(kind);
      rmSync(path, { recursive: true, force: true });
      if (kind === "hardlink") linkSync(externalFile, path);
      else symlinkSync(directory ? outside : externalFile, path, directory ? "junction" : "file");
      f.capture()(f.execution);
      expect(readFileSync(f.output, "utf8")).not.toContain("EXTERNAL_MUST");
      expect(f.read().issues.length).toBeGreaterThan(0);
    } finally { f.cleanup(); }
  },
);

test("a replaced Codex home cannot become the captured home after model execution", () => {
  const f = fixture();
  try {
    const capture = f.capture();
    renameSync(f.home, join(f.root, "old-home"));
    mkdirSync(f.home);
    capture(f.execution);
    expect(f.read().tools).toEqual([]);
    expect(f.read().files).toEqual([]);
    expect(f.read().issues.length).toBeGreaterThan(0);
  } finally { f.cleanup(); }
});

test("ambiguous matching rollouts are reported without choosing one", () => {
  const f = fixture();
  try {
    writeFileSync(join(f.shard, `rollout-another-${ID}.jsonl`), jsonl(f.rows));
    f.capture()(f.execution);
    expect(f.read().tools).toEqual([]);
    expect(f.read().issues).toContain("root rollout: ambiguous root rollout");
  } finally { f.cleanup(); }
});

test("a replaced artifact directory is never followed for the diagnostic write", () => {
  const f = fixture();
  try {
    const capture = f.capture();
    const outside = join(f.temporary, "outside");
    mkdirSync(outside);
    renameSync(f.artifacts, join(f.temporary, "old-artifacts"));
    symlinkSync(outside, f.artifacts, "junction");
    capture(f.execution);
    expect(existsSync(join(outside, "codex-workspace-failure.json"))).toBe(false);
  } finally { f.cleanup(); }
});

test("oversized input and retained text are bounded and explicitly marked", () => {
  const f = fixture();
  try {
    writeFileSync(f.rollout, jsonl([f.metadata,
      response({ type: "function_call", name: "exec_command", call_id: "large",
        arguments: JSON.stringify({ cmd: COMMAND }) }),
      response({ type: "function_call_output", call_id: "large", output: "x".repeat(400_000) }),
    ]));
    f.capture()(f.execution);
    expect(f.read().tools[1].output.truncated).toBe(true);
    expect(f.read().issues.join("\n")).toContain("size limit");
    expect(statSync(f.output).size).toBeLessThan(1024 * 1024);
    rmSync(f.output);
    truncateSync(f.rollout, 17 * 1024 * 1024);
    f.capture()(f.execution);
    expect(f.read().tools).toEqual([]);
    expect(f.read().issues.join("\n")).toContain("root rollout:");
  } finally { f.cleanup(); }
});

test("missing thread identity is explicit and diagnostic errors never replace the primary failure", async () => {
  const f = fixture();
  try {
    f.capture()({ ...f.execution, stdout: '{"type":"turn.completed"}\n' });
    expect(f.read().threadId).toBeUndefined();
    expect(f.read().tools).toEqual([]);
    expect(f.read().issues.join("\n")).toContain("root rollout:");
    const primary = new Error("original assertion");
    let cleaned = false;
    await expect(withCodexFixture(f.root, () => { cleaned = true; }, () => { throw primary; },
      undefined, () => { throw new Error("diagnostic unavailable"); })).rejects.toBe(primary);
    expect(cleaned).toBe(true);
  } finally { f.cleanup(); }
});
