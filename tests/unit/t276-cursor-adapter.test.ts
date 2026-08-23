// t276-cursor-adapter: pipe live-captured Cursor hook payloads through the
// authored adapter (run() export) against a seeded project and assert the
// Claude-shaped conversions on the wire.
//
// covers: hook:aidlc-record-human-turn, hook:aidlc-log-subagent
//
// The fixture corpus (tests/fixtures/cursor-hook-payloads/payloads.json) is
// field-verbatim off cursor-agent 2026.07.23 on Linux (spike 2026-07-26):
// camelCase event names, tool_name "Shell" for the shell tool, Task spawns
// carrying tool_input.subagent_type, and subagent-side calls arriving under a
// DIFFERENT conversation_id with no identity fields. The adapter's contracts
// under test:
//   - sessionStart: core additionalContext re-keys to Cursor's
//     additional_context (the live-verified injection channel).
//   - guards (preToolUse): Shell maps to Bash for the core guards; a core
//     exit-2 block converts to {"permission":"deny","agent_message"} stdout
//     JSON (exit 0) - Cursor's deny channel, NOT the Claude exit-2 contract.
//     Allow paths emit {"permission":"allow"} (failClosed IDE treats empty
//     stdout as invalid JSON and blocks; CLI treated the same silence as allow).
//   - Task spawn/completion maintains the subagent-identity ledger, so a
//     guard event from another conversation_id gets agent_type attributed
//     (the reviewer-scope bound's identity source on this harness).
//   - postToolUse Write feeds audit (ARTIFACT_*), Task feeds
//     SUBAGENT_COMPLETED, and sessionEnd infers the same terminal event for
//     Cursor's final live Task; beforeSubmitPrompt mints HUMAN_TURN.
//   - stop: a core {"decision":"block","reason"} converts to
//     {"followup_message"} (advisory nudge - Cursor stop cannot block).
//   - malformed stdin denies guards and remains advisory (empty stdout)
//     on every other target.

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  createIntent,
  readAllAuditShards,
  setActiveIntentCursor,
} from "../../dist/cursor/.cursor/tools/aidlc-lib.ts";
import {
  createTestProject,
  FIXTURES_DIR,
  seedAidlcMemory,
  seedAuditFile,
  seededAuditShard,
  seededRecordDir,
  seedStateFile,
} from "../harness/fixtures.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const CURSOR_DIST = join(REPO_ROOT, "dist", "cursor", ".cursor");
const STATE_TOOL = join(CURSOR_DIST, "tools", "aidlc-state.ts");
const LOG_TOOL = join(CURSOR_DIST, "tools", "aidlc-log.ts");
const PAYLOADS = JSON.parse(
  readFileSync(join(import.meta.dir, "..", "fixtures", "cursor-hook-payloads", "payloads.json"), "utf-8"),
) as Record<string, Record<string, unknown>>;

const scratch: string[] = [];

afterEach(() => {
  for (const dir of scratch.splice(0)) {
    clearLedger(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A workspace-shell project with the shipped .cursor engine installed. */
function installedProject(): string {
  const root = createTestProject();
  scratch.push(root);
  cpSync(CURSOR_DIST, join(root, ".cursor"), { recursive: true });
  return root;
}

/** The adapter's project-local subagent ledger. Spawn records are `.json`;
 *  main-conversation markers are `.marker`. */
function ledgerDirFor(projectDir: string): string {
  return join(projectDir, "aidlc", ".aidlc-cursor-subagents");
}

function ledgerFilesFor(projectDir: string, suffix = ".json"): string[] {
  const dir = ledgerDirFor(projectDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(suffix))
    .map((name) => join(dir, name));
}

function clearLedger(projectDir: string): void {
  rmSync(ledgerDirFor(projectDir), { recursive: true, force: true });
}

function payload(name: string, projectDir: string, extra: Record<string, unknown> = {}): string {
  const raw = JSON.stringify(PAYLOADS[name]);
  return JSON.stringify({
    ...(JSON.parse(
      raw.replaceAll("{{PROJECT}}", projectDir).replaceAll("{{TRANSCRIPT}}", `${projectDir}/t.jsonl`),
    ) as Record<string, unknown>),
    ...extra,
  });
}

function runAdapter(
  projectDir: string,
  target: string,
  stdin: string,
  options: {
    cwd?: string;
    env?: Record<string, string | undefined>;
  } = {},
): { stdout: string; stderr: string; code: number } {
  const env: Record<string, string | undefined> = {
    ...process.env,
    AIDLC_PROJECT_DIR: projectDir,
    AIDLC_HARNESS_DIR: ".cursor",
    ...options.env,
  };
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete env[key];
  }
  const r = spawnSync(
    "bun",
    [join(projectDir, ".cursor", "hooks", "aidlc-cursor-adapter.ts"), target],
    {
      cwd: options.cwd ?? projectDir,
      input: stdin,
      encoding: "utf-8",
      env: env as NodeJS.ProcessEnv,
    },
  );
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", code: r.status ?? 0 };
}

/** Cursor failClosed preToolUse requires permission JSON on allow, not silence. */
function expectAllowJson(
  r: { code: number; stdout: string },
  label?: string,
): void {
  expect(r.code, label).toBe(0);
  expect(JSON.parse(r.stdout) as { permission?: string }, label).toEqual({
    permission: "allow",
  });
}

function registerTaskParent(projectDir: string): void {
  const conversation = PAYLOADS.preToolUseTask.conversation_id;
  if (typeof conversation !== "string") {
    throw new Error("preToolUseTask fixture is missing conversation_id");
  }
  runAdapter(
    projectDir,
    "session-start",
    payload("sessionStart", projectDir, {
      conversation_id: conversation,
      session_id: conversation,
    }),
  );
}

function projectWithReadyReview(): { project: string; artifact: string } {
  const project = installedProject();
  seedAidlcMemory(project);
  seedStateFile(project, join(FIXTURES_DIR, "state-mid-inception.md"));
  const artifact = join(
    seededRecordDir(project),
    "inception",
    "requirements-analysis",
    "requirements.md",
  );
  mkdirSync(dirname(artifact), { recursive: true });
  writeFileSync(artifact, "# Requirements\n");
  const env = {
    ...process.env,
    AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS: "1",
    AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD: "1",
    AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "1",
  };
  const args = [
    LOG_TOOL,
    "review",
    "--stage",
    "requirements-analysis",
    "--reviewer",
    "aidlc-product-lead-agent",
    "--iteration",
    "1",
    "--project-dir",
    project,
  ];
  for (const suffix of [[], ["--verdict", "READY"]]) {
    const review = spawnSync("bun", [...args, ...suffix], { encoding: "utf-8" });
    if (review.status !== 0) {
      throw new Error(`review log failed: ${review.stdout}${review.stderr}`);
    }
  }
  const gate = spawnSync(
    "bun",
    [STATE_TOOL, "gate-start", "requirements-analysis", "--project-dir", project],
    { encoding: "utf-8", env },
  );
  if (gate.status !== 0) throw new Error(`gate-start failed: ${gate.stdout}${gate.stderr}`);
  return { project, artifact };
}

describe("t276 cursor adapter payload conversion", () => {
  test("1: sessionStart re-keys core additionalContext to Cursor's additional_context", () => {
    const proj = installedProject();
    seedStateFile(proj, "state-construction.md");
    const r = runAdapter(proj, "session-start", payload("sessionStart", proj));
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout) as Record<string, unknown>;
    expect(typeof out.additional_context).toBe("string");
    expect(out.additional_context as string).toContain("AIDLC WORKFLOW ACTIVE");
    expect(out).not.toHaveProperty("additionalContext");
    // The session start landed in the audit trail through the core hook.
    const shard = readAllAuditShards(proj);
    expect(shard).toContain("SESSION_STARTED");
  });

  test("2: sessionStart without workflow state stays silent (no scaffolding)", () => {
    const proj = installedProject();
    const r = runAdapter(proj, "session-start", payload("sessionStart", proj));
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe("");
  });

  test("3: guards convert a state-guard block to Cursor's permission-deny JSON", () => {
    const proj = installedProject();
    seedStateFile(proj, "state-construction.md");
    // A direct lifecycle mutation through aidlc-state.ts is the state guard's
    // canonical refusal; on Cursor it must arrive as deny JSON, exit 0.
    const stdin = payload("preToolUseShell", proj, {
      tool_input: { command: "bun .cursor/tools/aidlc-state.ts approve", cwd: "", timeout: 30000 },
    });
    const r = runAdapter(proj, "guards", stdin);
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout) as { permission?: string; agent_message?: string };
    expect(out.permission).toBe("deny");
    expect(out.agent_message ?? "").toContain("aidlc-orchestrate");
  });

  test("4: guards allow an ordinary shell command with permission-allow JSON", () => {
    const proj = installedProject();
    seedStateFile(proj, "state-construction.md");
    const r = runAdapter(proj, "guards", payload("preToolUseShell", proj));
    expectAllowJson(r);
  });

  test("5: Task attribution binds unknown conversations only; registered mains are never conflated", () => {
    const proj = installedProject();
    seedStateFile(proj, "state-construction.md");
    const record = seededRecordDir(proj);
    clearLedger(proj);
    // 12a step-1: the conductor's dispatch record scopes the reviewer to
    // unit-a; unit-b is a sibling.
    mkdirSync(join(record, "construction", "unit-b"), { recursive: true });
    writeFileSync(
      join(record, ".aidlc-reviewer-dispatch.json"),
      JSON.stringify({
        reviewer: "aidlc-architecture-reviewer-agent",
        stage: "functional-design",
        unit: "unit-a",
        exempt: [],
      }),
    );
    registerTaskParent(proj);
    // An INDEPENDENT top-level conversation announces itself the way every
    // real one does: sessionStart fires for it (subagents never get one).
    runAdapter(
      proj,
      "session-start",
      payload("sessionStart", proj, {
        conversation_id: "11111111-2222-4333-8444-555555555555",
        session_id: "11111111-2222-4333-8444-555555555555",
      }),
    );
    // Spawn: the MAIN conversation's Task call records the ledger entry.
    const spawn = runAdapter(proj, "guards", payload("preToolUseTask", proj));
    expectAllowJson(spawn);
    expect(ledgerFilesFor(proj)).toHaveLength(1);
    // The registered independent conversation must not inherit the reviewer
    // identity (the review round-1 conflation repro).
    const unrelated = runAdapter(
      proj,
      "guards",
      payload("preToolUseSubagentRead", proj, {
        conversation_id: "11111111-2222-4333-8444-555555555555",
        session_id: "11111111-2222-4333-8444-555555555555",
        tool_input: { file_path: join(record, "construction", "unit-b", "design.md") },
      }),
    );
    expect(unrelated.code).toBe(0);
    expectAllowJson(unrelated);
    // The reviewer's own Read (fresh conversation_id, no sessionStart, no
    // identity fields — the live subagent shape) is scope-enforced.
    const sibling = runAdapter(
      proj,
      "guards",
      payload("preToolUseSubagentRead", proj, {
        tool_input: { file_path: join(record, "construction", "unit-b", "design.md") },
      }),
    );
    expect(sibling.code).toBe(0);
    const out = JSON.parse(sibling.stdout) as { permission?: string; agent_message?: string };
    expect(out.permission).toBe("deny");
    expect(out.agent_message ?? "").toContain("unit-a");
    // Completion clears the ledger, but the independent dispatch record keeps
    // unknown conversations fail-closed until the conductor consumes the
    // verdict and removes the record.
    const done = runAdapter(proj, "audit-and-sensors", payload("postToolUseTask", proj));
    expect(done.code).toBe(0);
    expect(ledgerFilesFor(proj)).toHaveLength(0);
    const whileDispatched = runAdapter(
      proj,
      "guards",
      payload("preToolUseSubagentRead", proj, {
        tool_input: { file_path: join(record, "construction", "unit-b", "design.md") },
      }),
    );
    expect(JSON.parse(whileDispatched.stdout).permission).toBe("deny");

    rmSync(join(record, ".aidlc-reviewer-dispatch.json"));
    const afterDispatch = runAdapter(
      proj,
      "guards",
      payload("preToolUseSubagentRead", proj, {
        tool_input: { file_path: join(record, "construction", "unit-b", "design.md") },
      }),
    );
    expect(afterDispatch.code).toBe(0);
    expectAllowJson(afterDispatch);
  });

  test("6: postToolUse Write lands an audit row; Task lands SUBAGENT_COMPLETED; mint lands HUMAN_TURN", () => {
    const proj = installedProject();
    seedStateFile(proj, "state-construction.md");
    // The audit-logger never auto-creates the trail (orchestrator-owned) -
    // seed the shard the way a running workflow would have.
    seedAuditFile(proj);
    const artifact = join(seededRecordDir(proj), "construction", "functional-design", "design.md");
    mkdirSync(join(seededRecordDir(proj), "construction", "functional-design"), {
      recursive: true,
    });
    writeFileSync(artifact, "# design\n");
    const w = runAdapter(
      proj,
      "audit-and-sensors",
      payload("postToolUseWrite", proj, { tool_input: { file_path: artifact, content: "# design\n" } }),
    );
    expect(w.code).toBe(0);
    const t = runAdapter(proj, "audit-and-sensors", payload("postToolUseTask", proj));
    expect(t.code).toBe(0);
    const m = runAdapter(proj, "mint", payload("sessionStart", proj));
    expect(m.code).toBe(0);
    const shard = readFileSync(seededAuditShard(proj), "utf-8");
    expect(shard).toContain("ARTIFACT_");
    expect(shard).toContain("SUBAGENT_COMPLETED");
    expect(shard).toContain("aidlc-architecture-reviewer-agent");
    expect(shard).toContain("HUMAN_TURN");
  });

  test("7: a delegated conversation cannot spawn a nested Task or overwrite the parent ledger", () => {
    const proj = installedProject();
    seedStateFile(proj, "state-construction.md");
    clearLedger(proj);

    const parent = runAdapter(proj, "guards", payload("preToolUseTask", proj));
    expectAllowJson(parent);
    const [ledger] = ledgerFilesFor(proj);
    const before = readFileSync(ledger, "utf-8");

    // The subagent's own Task attempt arrives as every subagent call does
    // live: a fresh conversation_id that never saw sessionStart, and no
    // lineage fields.
    const nested = runAdapter(
      proj,
      "guards",
      payload("preToolUseTask", proj, {
        conversation_id: "ece1fcdd-ebab-4b21-b074-95e19faafc3a",
        session_id: "ece1fcdd-ebab-4b21-b074-95e19faafc3a",
        tool_input: {
          description: "Nested probe",
          prompt: "Try to delegate again.",
          subagent_type: "aidlc-developer-agent",
        },
      }),
    );
    expect(nested.code).toBe(0);
    const out = JSON.parse(nested.stdout) as { permission?: string; agent_message?: string };
    expect(out.permission).toBe("deny");
    expect(out.agent_message ?? "").toContain("nested delegation is not allowed");
    expect(readFileSync(ledger, "utf-8")).toBe(before);
  });

  test("8: beforeSubmitPrompt rebind falls back from session_id to conversation_id", () => {
    const proj = installedProject();
    const a = createIntent(proj, "intent-a", "default", "feature");
    const b = createIntent(proj, "intent-b", "default", "feature");
    setActiveIntentCursor(proj, a.dirName, "default");

    const started = runAdapter(
      proj,
      "session-start",
      payload("sessionStart", proj, { session_id: undefined }),
    );
    expect(started.code).toBe(0);
    setActiveIntentCursor(proj, b.dirName, "default");

    const warned = runAdapter(
      proj,
      "mint",
      payload("beforeSubmitPrompt", proj, { session_id: undefined }),
    );
    expect(warned.code).toBe(0);
    const out = JSON.parse(warned.stdout) as { continue?: boolean; user_message?: string };
    expect(out.continue).toBe(false);
    expect(out.user_message ?? "").toContain("INTENT REBIND OFFER");
    expect(out.user_message ?? "").toContain("intent-a");
    expect(out.user_message ?? "").toContain("intent-b");
    expect(out.user_message ?? "").toContain("/aidlc intent intent-a");

    // The blocked warning is consumed: resubmitting continues on B instead of
    // deadlocking on the same beforeSubmitPrompt response.
    const next = runAdapter(
      proj,
      "mint",
      payload("beforeSubmitPrompt", proj, { session_id: undefined }),
    );
    expect(next.code).toBe(0);
    expect(next.stdout.trim()).toBe("");
    const shard = readAllAuditShards(proj);
    expect(shard).toContain("HUMAN_TURN");
    expect(shard).not.toContain("SESSION_RESUMED");
  });

  test("9: beforeSubmitPrompt is silent when the session's intent is unchanged", () => {
    const proj = installedProject();
    const a = createIntent(proj, "unchanged", "default", "feature");
    setActiveIntentCursor(proj, a.dirName, "default");
    runAdapter(proj, "session-start", payload("sessionStart", proj));

    const r = runAdapter(proj, "mint", payload("beforeSubmitPrompt", proj));
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe("");
    expect(readAllAuditShards(proj)).toContain("HUMAN_TURN");
  });

  test("10: concurrent parents stay isolated and mixed reviewer attribution remains scope-enforced", () => {
    const proj = installedProject();
    seedStateFile(proj, "state-construction.md");
    const record = seededRecordDir(proj);
    clearLedger(proj);
    mkdirSync(join(record, "construction", "unit-b"), { recursive: true });
    writeFileSync(
      join(record, ".aidlc-reviewer-dispatch.json"),
      JSON.stringify({
        reviewer: "aidlc-architecture-reviewer-agent",
        stage: "functional-design",
        unit: "unit-a",
        exempt: [],
      }),
    );
    registerTaskParent(proj);
    const siblingRead = (extra: Record<string, unknown>) =>
      runAdapter(
        proj,
        "guards",
        payload("preToolUseSubagentRead", proj, {
          tool_input: { file_path: join(record, "construction", "unit-b", "design.md") },
          ...extra,
        }),
      );

    // Two top-level conversations each dispatch the reviewer. Every real
    // main fires sessionStart before it can spawn a Task (subagents never
    // do) — registering B is what keeps its spawn from reading as nested
    // delegation while A's record is live.
    runAdapter(proj, "guards", payload("preToolUseTask", proj));
    runAdapter(
      proj,
      "session-start",
      payload("sessionStart", proj, {
        conversation_id: "parent-conversation-b",
        session_id: "parent-conversation-b",
      }),
    );
    runAdapter(
      proj,
      "guards",
      payload("preToolUseTask", proj, {
        conversation_id: "parent-conversation-b",
        session_id: "parent-conversation-b",
        generation_id: "task-generation-b",
        tool_use_id: "task-use-b",
      }),
    );
    expect(ledgerFilesFor(proj)).toHaveLength(2);

    // A registered parent's own reads stay unattributed.
    const parentB = siblingRead({
      conversation_id: "parent-conversation-b",
      session_id: "parent-conversation-b",
    });
    expectAllowJson(parentB);
    // An unknown conversation (the live subagent shape) is attributed while
    // both records name the same agent...
    expect(JSON.parse(siblingRead({}).stdout).permission).toBe("deny");

    // ...and parent A's completion clears only A's record; enforcement holds
    // through B's still-live dispatch.
    runAdapter(proj, "audit-and-sensors", payload("postToolUseTask", proj));
    expect(ledgerFilesFor(proj)).toHaveLength(1);
    expect(JSON.parse(siblingRead({}).stdout).permission).toBe("deny");

    // A third registered parent dispatching a DIFFERENT agent makes identity
    // ambiguous. Because one live identity is the dispatched reviewer, the
    // adapter conservatively applies that reviewer scope instead of failing
    // open and permitting the sibling read.
    runAdapter(
      proj,
      "session-start",
      payload("sessionStart", proj, {
        conversation_id: "parent-conversation-c",
        session_id: "parent-conversation-c",
      }),
    );
    runAdapter(
      proj,
      "guards",
      payload("preToolUseTask", proj, {
        conversation_id: "parent-conversation-c",
        session_id: "parent-conversation-c",
        generation_id: "task-generation-c",
        tool_use_id: "task-use-c",
        tool_input: {
          description: "Developer probe",
          prompt: "Implement the unit.",
          subagent_type: "aidlc-developer-agent",
        },
      }),
    );
    expect(ledgerFilesFor(proj)).toHaveLength(2);
    expect(JSON.parse(siblingRead({}).stdout).permission).toBe("deny");
  });

  test("11: postToolUseFailure clears only the failed Task record", () => {
    const proj = installedProject();
    seedStateFile(proj, "state-construction.md");
    runAdapter(proj, "guards", payload("preToolUseTask", proj));
    expect(ledgerFilesFor(proj)).toHaveLength(1);

    const failed = runAdapter(proj, "task-failure", payload("postToolUseTask", proj));
    expect(failed.code).toBe(0);
    expect(ledgerFilesFor(proj)).toHaveLength(0);
  });

  test("12: project hook cwd wins over workspace_roots when no project env is set", () => {
    const adapterProject = installedProject();
    const actualProject = installedProject();
    seedStateFile(actualProject, "state-construction.md");
    const stdin = payload("sessionStart", adapterProject, {
      workspace_roots: [adapterProject],
    });
    const r = runAdapter(adapterProject, "session-start", stdin, {
      cwd: actualProject,
      env: {
        AIDLC_PROJECT_DIR: undefined,
        CURSOR_PROJECT_DIR: undefined,
        CLAUDE_PROJECT_DIR: undefined,
      },
    });
    expect(r.code).toBe(0);
    expect(readAllAuditShards(actualProject)).toContain("SESSION_STARTED");
  });

  test("13: sessionEnd audits the final Task, forwards its reason, and clears spawn records", () => {
    const proj = installedProject();
    seedStateFile(proj, "state-construction.md");
    clearLedger(proj);
    // Live CLI never delivers postToolUse/postToolUseFailure for the Task
    // tool, so sessionEnd is the reliable clear point for this conversation's
    // attribution records.
    const endConversation = JSON.parse(payload("sessionEnd", proj)) as {
      conversation_id?: string;
    };
    runAdapter(
      proj,
      "session-start",
      payload("sessionStart", proj, {
        conversation_id: endConversation.conversation_id,
        session_id: endConversation.conversation_id,
      }),
    );
    runAdapter(
      proj,
      "guards",
      payload("preToolUseTask", proj, {
        conversation_id: endConversation.conversation_id,
        session_id: endConversation.conversation_id,
      }),
    );
    expect(ledgerFilesFor(proj)).toHaveLength(1);
    const r = runAdapter(proj, "session-end", payload("sessionEnd", proj));
    expect(r.code).toBe(0);
    expect(ledgerFilesFor(proj)).toHaveLength(0);
    const shard = readAllAuditShards(proj);
    expect(shard.match(/\*\*Event\*\*: SUBAGENT_COMPLETED/g) ?? []).toHaveLength(1);
    expect(shard).toContain("aidlc-architecture-reviewer-agent");
    expect(shard).toContain("inferred: Cursor emitted sessionEnd without Task postToolUse");
    expect(shard).toContain("SESSION_ENDED");
    expect(shard).toContain("completed");
    expect(shard.indexOf("SUBAGENT_COMPLETED")).toBeLessThan(shard.indexOf("SESSION_ENDED"));
  });

  test("14: stop converts a core block into an advisory followup_message", () => {
    const proj = installedProject();
    seedStateFile(proj, "state-construction.md");
    // An in-flight stage (state seeded mid-construction with no completed
    // report) makes the core stop hook emit its pending-directive block.
    const r = runAdapter(proj, "stop", payload("stop", proj));
    expect(r.code).toBe(0);
    if (r.stdout.trim().length > 0) {
      const out = JSON.parse(r.stdout) as Record<string, unknown>;
      // Whatever the core decided, the Cursor wire never carries the Claude
      // block contract - only the advisory follow-up channel.
      expect(out).not.toHaveProperty("decision");
      expect(typeof out.followup_message).toBe("string");
      expect((out.followup_message as string).length).toBeGreaterThan(0);
    }
  });

  test("15: malformed stdin denies guards and remains advisory elsewhere", () => {
    const proj = installedProject();
    for (const target of [
      "session-start",
      "session-end",
      "mint",
      "guards",
      "audit-and-sensors",
      "task-failure",
      "runtime-compile",
      "validate-state",
      "stop",
    ]) {
      const r = runAdapter(proj, target, "{not json");
      expect(r.code).toBe(0);
      if (target === "guards") {
        expect(JSON.parse(r.stdout).permission).toBe("deny");
      } else {
        expect(r.stdout.trim(), `${target}: advisory malformed input`).toBe("");
      }
    }
  });

  test("16: Cursor's Delete tool is reviewer-scope-enforced as a write", () => {
    const proj = installedProject();
    seedStateFile(proj, "state-construction.md");
    const record = seededRecordDir(proj);
    clearLedger(proj);
    mkdirSync(join(record, "construction", "unit-b"), { recursive: true });
    writeFileSync(
      join(record, ".aidlc-reviewer-dispatch.json"),
      JSON.stringify({
        reviewer: "aidlc-architecture-reviewer-agent",
        stage: "functional-design",
        unit: "unit-a",
        exempt: [],
      }),
    );
    registerTaskParent(proj);
    runAdapter(proj, "guards", payload("preToolUseTask", proj));

    // "Delete" is Cursor-only (every other harness removes files through the
    // shell). The reviewer-scope allowlist never mentions it, so without the
    // adapter's reviewer-side rename a scoped reviewer could delete a SIBLING
    // unit's artifacts unchallenged. The call arrives in the live subagent
    // shape: an unknown conversation_id, no lineage fields.
    const del = runAdapter(
      proj,
      "guards",
      payload("preToolUseSubagentRead", proj, {
        tool_name: "Delete",
        tool_input: { file_path: join(record, "construction", "unit-b", "design.md") },
      }),
    );
    expect(del.code).toBe(0);
    const out = JSON.parse(del.stdout) as { permission?: string; agent_message?: string };
    expect(out.permission).toBe("deny");
    expect(out.agent_message ?? "").toContain("unit-a");

    // The reviewer's OWN unit stays deletable - the bound is scope, not a ban.
    mkdirSync(join(record, "construction", "unit-a"), { recursive: true });
    const own = runAdapter(
      proj,
      "guards",
      payload("preToolUseSubagentRead", proj, {
        tool_name: "Delete",
        tool_input: { file_path: join(record, "construction", "unit-a", "scratch.md") },
      }),
    );
    expect(own.code).toBe(0);
    expectAllowJson(own);
  });

  test("17: Delete keeps its real name for the state-transition guard", () => {
    const proj = installedProject();
    const captureFile = join(proj, "state-transition-input.json");
    writeFileSync(
      join(proj, ".cursor", "hooks", "aidlc-state-transition-guard.ts"),
      `await Bun.write(${JSON.stringify(captureFile)}, await Bun.stdin.text());\n`,
    );

    const r = runAdapter(
      proj,
      "guards",
      payload("preToolUseSubagentRead", proj, {
        tool_name: "Delete",
        tool_input: { file_path: join(proj, "obsolete.md") },
      }),
    );
    expectAllowJson(r);
    const forwarded = JSON.parse(readFileSync(captureFile, "utf-8")) as {
      tool_name?: string;
    };
    expect(forwarded.tool_name).toBe("Delete");
  });

  test("18: unknown target is a silent no-op (wiring typo cannot break a turn)", () => {
    const proj = installedProject();
    const r = runAdapter(proj, "no-such-target", payload("sessionStart", proj));
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe("");
  });

  test("19: a background agent's prompt never mints HUMAN_TURN", () => {
    const proj = installedProject();
    seedStateFile(proj, "state-construction.md");
    seedAuditFile(proj);
    const bg = runAdapter(
      proj,
      "mint",
      payload("beforeSubmitPrompt", proj, { is_background_agent: true }),
    );
    expect(bg.code).toBe(0);
    expect(readAllAuditShards(proj)).not.toContain("HUMAN_TURN");
    // The same payload from a human-driven conversation does mint.
    const human = runAdapter(proj, "mint", payload("beforeSubmitPrompt", proj));
    expect(human.code).toBe(0);
    expect(readAllAuditShards(proj)).toContain("HUMAN_TURN");
  });

  test("20: an attributed call refreshes the spawn record so a long review outlives the TTL", () => {
    const proj = installedProject();
    seedStateFile(proj, "state-construction.md");
    clearLedger(proj);
    runAdapter(proj, "guards", payload("preToolUseTask", proj));
    const [record] = ledgerFilesFor(proj);
    // Backdate the record to one minute inside the 30-minute freshness window.
    const nearExpiry = new Date(Date.now() - 29 * 60 * 1000);
    utimesSync(record, nearExpiry, nearExpiry);
    // The working subagent's next call (unknown conversation) re-touches it.
    const r = runAdapter(
      proj,
      "guards",
      payload("preToolUseSubagentRead", proj, {
        tool_input: { file_path: join(proj, "README.md") },
      }),
    );
    expectAllowJson(r);
    expect(Date.now() - statSync(record).mtimeMs).toBeLessThan(60 * 1000);
  });

  test("21: a new same-parent Task retires a stale lead record before reviewer dispatch", () => {
    const proj = installedProject();
    seedStateFile(proj, "state-construction.md");
    seedAuditFile(proj);
    clearLedger(proj);
    const record = seededRecordDir(proj);
    mkdirSync(join(record, "construction", "unit-b"), { recursive: true });
    writeFileSync(
      join(record, ".aidlc-reviewer-dispatch.json"),
      JSON.stringify({
        reviewer: "aidlc-architecture-reviewer-agent",
        stage: "functional-design",
        unit: "unit-a",
        exempt: [],
      }),
    );
    registerTaskParent(proj);

    const developer = runAdapter(
      proj,
      "guards",
      payload("preToolUseTask", proj, {
        tool_input: {
          description: "Implement",
          prompt: "Implement unit-a.",
          subagent_type: "aidlc-developer-agent",
        },
      }),
    );
    expectAllowJson(developer);
    expect(ledgerFilesFor(proj)).toHaveLength(1);

    // Cursor emits no postToolUse for the developer Task. The parent's next
    // synchronous Task dispatch is therefore the first conclusive completion
    // signal available to the adapter.
    const reviewer = runAdapter(
      proj,
      "guards",
      payload("preToolUseTask", proj, {
        generation_id: "review-generation",
        tool_use_id: "review-tool-use",
      }),
    );
    expectAllowJson(reviewer);
    expect(ledgerFilesFor(proj)).toHaveLength(1);
    expect(readAllAuditShards(proj)).toContain("SUBAGENT_COMPLETED");
    expect(readAllAuditShards(proj)).toContain("aidlc-developer-agent");

    const sibling = runAdapter(
      proj,
      "guards",
      payload("preToolUseSubagentRead", proj, {
        tool_input: { file_path: join(record, "construction", "unit-b", "design.md") },
      }),
    );
    expect(JSON.parse(sibling.stdout).permission).toBe("deny");
  });

  test("22: an unavailable child guard denies the operation", () => {
    const proj = installedProject();
    seedStateFile(proj, "state-construction.md");
    rmSync(join(proj, ".cursor", "hooks", "aidlc-reviewer-scope.ts"));

    const r = runAdapter(proj, "guards", payload("preToolUseShell", proj));
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout) as { permission?: string; agent_message?: string };
    expect(out.permission).toBe("deny");
    expect(out.agent_message ?? "").toContain("aidlc-reviewer-scope.ts failed");
  });

  test("23: Shell working_directory and captured cwd feed reviewer-scope and review-freeze", () => {
    const proj = installedProject();
    seedStateFile(proj, "state-construction.md");
    const record = seededRecordDir(proj);
    clearLedger(proj);
    const unitB = join(record, "construction", "unit-b");
    mkdirSync(unitB, { recursive: true });
    writeFileSync(
      join(record, ".aidlc-reviewer-dispatch.json"),
      JSON.stringify({
        reviewer: "aidlc-architecture-reviewer-agent",
        stage: "functional-design",
        unit: "unit-a",
        exempt: [],
      }),
    );
    registerTaskParent(proj);
    runAdapter(proj, "guards", payload("preToolUseTask", proj));

    const siblingRead = runAdapter(
      proj,
      "guards",
      payload("preToolUseShell", proj, {
        conversation_id: "reviewer-shell-conversation",
        session_id: "reviewer-shell-conversation",
        cwd: "",
        tool_input: {
          command: "cat design.md",
          working_directory: unitB,
        },
      }),
    );
    const siblingOut = JSON.parse(siblingRead.stdout) as {
      permission?: string;
      agent_message?: string;
    };
    expect(siblingOut.permission).toBe("deny");
    expect(siblingOut.agent_message ?? "").toContain("unit-a");

    const harmless = runAdapter(
      proj,
      "guards",
      payload("preToolUseShell", proj, {
        conversation_id: "reviewer-shell-conversation",
        session_id: "reviewer-shell-conversation",
        cwd: "",
        tool_input: {
          command: "echo ok",
          working_directory: proj,
        },
      }),
    );
    expectAllowJson(harmless);

    const ready = projectWithReadyReview();
    const protectedWrite = runAdapter(
      ready.project,
      "guards",
      payload("preToolUseShell", ready.project, {
        cwd: "",
        tool_input: {
          command: "printf change >> requirements.md",
          cwd: dirname(ready.artifact),
        },
      }),
    );
    const writeOut = JSON.parse(protectedWrite.stdout) as {
      permission?: string;
      agent_message?: string;
    };
    expect(writeOut.permission).toBe("deny");
    expect(writeOut.agent_message ?? "").toContain("review-freeze");

    const wrappedWrite = runAdapter(
      ready.project,
      "guards",
      payload("preToolUseShell", ready.project, {
        cwd: "",
        tool_input: {
          command: "command truncate -s 0 requirements.md",
          cwd: dirname(ready.artifact),
        },
      }),
    );
    expect(JSON.parse(wrappedWrite.stdout).permission).toBe("deny");
  });

  test("24: delegated tools cannot remove attribution state and missing state fails closed", () => {
    const proj = installedProject();
    seedStateFile(proj, "state-construction.md");
    const record = seededRecordDir(proj);
    clearLedger(proj);
    mkdirSync(join(record, "construction", "unit-b"), { recursive: true });
    const dispatch = join(record, ".aidlc-reviewer-dispatch.json");
    writeFileSync(
      dispatch,
      JSON.stringify({
        reviewer: "aidlc-architecture-reviewer-agent",
        stage: "functional-design",
        unit: "unit-a",
        exempt: [],
      }),
    );
    registerTaskParent(proj);
    runAdapter(proj, "guards", payload("preToolUseTask", proj));
    expect(ledgerFilesFor(proj)).toHaveLength(1);

    for (const target of [ledgerDirFor(proj), dispatch]) {
      const removal = runAdapter(
        proj,
        "guards",
        payload("preToolUseShell", proj, {
          conversation_id: "reviewer-tamper-conversation",
          session_id: "reviewer-tamper-conversation",
          tool_input: { command: `rm -rf ${JSON.stringify(target)}` },
        }),
      );
      const out = JSON.parse(removal.stdout) as {
        permission?: string;
        agent_message?: string;
      };
      expect(out.permission, target).toBe("deny");
      expect(out.agent_message ?? "", target).toContain("attribution state");
    }

    for (const command of [
      `rm -f ${dispatch.slice(0, -1)}*`,
      `rm -f ${dispatch.slice(0, -1)}[n]`,
      `rm -rf ${join(dirname(record), "*")}`,
      `rm -rf ${join(proj, "aidlc", ".aidlc-cursor-sub*")}`,
      `rm -rf ${join(proj, "aidlc", ".aidlc-*")}`,
    ]) {
      const removal = runAdapter(
        proj,
        "guards",
        payload("preToolUseShell", proj, {
          conversation_id: "reviewer-glob-tamper-conversation",
          session_id: "reviewer-glob-tamper-conversation",
          tool_input: { command },
        }),
      );
      const out = JSON.parse(removal.stdout) as {
        permission?: string;
        agent_message?: string;
      };
      expect(out.permission, command).toBe("deny");
      expect(out.agent_message ?? "", command).toContain("attribution state");
    }
    expect(existsSync(dispatch)).toBe(true);
    expect(ledgerFilesFor(proj)).toHaveLength(1);

    const quotedWrapperRemoval =
      `command rm -f ${JSON.stringify(dispatch.slice(0, -1))}''n`;
    expect(quotedWrapperRemoval).not.toContain(".aidlc-reviewer-dispatch.json");
    const wrapped = runAdapter(
      proj,
      "guards",
      payload("preToolUseShell", proj, {
        conversation_id: "reviewer-wrapper-conversation",
        session_id: "reviewer-wrapper-conversation",
        tool_input: { command: quotedWrapperRemoval },
      }),
    );
    expect(JSON.parse(wrapped.stdout).permission).toBe("deny");
    expect(existsSync(dispatch)).toBe(true);

    const encodedRemoval = Buffer.from(
      `require("node:fs").rmSync(${JSON.stringify(ledgerDirFor(proj))}, { recursive: true, force: true });`,
      "utf-8",
    ).toString("base64");
    for (const runtime of ["bun", "node"]) {
      const execution = runAdapter(
        proj,
        "guards",
        payload("preToolUseShell", proj, {
          conversation_id: "reviewer-interpreter-conversation",
          session_id: "reviewer-interpreter-conversation",
          tool_input: {
            command: `${runtime} -e 'eval(Buffer.from("${encodedRemoval}", "base64").toString())'`,
          },
        }),
      );
      const out = JSON.parse(execution.stdout) as {
        permission?: string;
        agent_message?: string;
      };
      expect(out.permission, runtime).toBe("deny");
      expect(out.agent_message ?? "", runtime).toContain("general-purpose interpreters");
    }
    expect(ledgerFilesFor(proj)).toHaveLength(1);

    for (const command of [
      "timeout 5 node -e 'x'",
      "nice node -e 'x'",
      "ionice node -e 'x'",
      "stdbuf -o0 node -e 'x'",
      "setsid node -e 'x'",
      "sudo node -e 'x'",
      "doas node -e 'x'",
      "xargs node -e 'x'",
      "time node -e 'x'",
      "unbuffer node -e 'x'",
      "env -S 'node -e x'",
      "{ node -e 'x'; }",
      "( node -e 'x' )",
      "if true; then node -e 'x'; fi",
      "for i in 1; do node -e 'x'; done",
    ]) {
      const wrappedInterpreter = runAdapter(
        proj,
        "guards",
        payload("preToolUseShell", proj, {
          conversation_id: "reviewer-wrapped-interpreter-conversation",
          session_id: "reviewer-wrapped-interpreter-conversation",
          tool_input: { command },
        }),
      );
      const out = JSON.parse(wrappedInterpreter.stdout) as {
        permission?: string;
        agent_message?: string;
      };
      expect(out.permission, command).toBe("deny");
      expect(out.agent_message ?? "", command).toContain(
        "general-purpose interpreters",
      );
    }

    const dynamicRemovals = [
      [
        `base=${JSON.stringify(join(proj, "aidlc"))}`,
        "stem=.aidlc-cursor",
        "suffix=-subagents",
        'target="$base/$stem$suffix"',
        'rm -rf "$target"',
      ].join("; "),
      [
        `base=${JSON.stringify(dirname(dispatch))}`,
        "stem=.aidlc-reviewer",
        "suffix=-dispatch.json",
        `target="\${base}/\${stem}\${suffix}"`,
        `rm -f "\${target}"`,
      ].join("; "),
    ];
    for (const command of dynamicRemovals) {
      expect(command).not.toContain(".aidlc-cursor-subagents");
      expect(command).not.toContain(".aidlc-reviewer-dispatch.json");
      const expansion = runAdapter(
        proj,
        "guards",
        payload("preToolUseShell", proj, {
          conversation_id: "reviewer-expansion-conversation",
          session_id: "reviewer-expansion-conversation",
          tool_input: { command },
        }),
      );
      const out = JSON.parse(expansion.stdout) as {
        permission?: string;
        agent_message?: string;
      };
      expect(out.permission, command).toBe("deny");
      expect(out.agent_message ?? "", command).toContain("shell parameter expansion");
    }
    expect(existsSync(dispatch)).toBe(true);
    expect(ledgerFilesFor(proj)).toHaveLength(1);

    const literalDollar = runAdapter(
      proj,
      "guards",
      payload("preToolUseShell", proj, {
        conversation_id: "reviewer-literal-dollar-conversation",
        session_id: "reviewer-literal-dollar-conversation",
        tool_input: { command: "printf '%s\\n' '$HOME'" },
      }),
    );
    expectAllowJson(literalDollar);

    for (const command of [
      "rg node README.md",
      "printf '%s\\n' python",
      "rg 'source' README.md",
    ]) {
      const harmlessArgument = runAdapter(
        proj,
        "guards",
        payload("preToolUseShell", proj, {
          conversation_id: "reviewer-harmless-argument-conversation",
          session_id: "reviewer-harmless-argument-conversation",
          tool_input: { command },
        }),
      );
      expectAllowJson(harmlessArgument, command);
    }

    // Simulate corruption outside the delegated tool path. The active dispatch
    // remains the independent fail-closed signal.
    rmSync(ledgerDirFor(proj), { recursive: true, force: true });
    const afterLoss = runAdapter(
      proj,
      "guards",
      payload("preToolUseSubagentRead", proj, {
        conversation_id: "reviewer-after-ledger-loss",
        session_id: "reviewer-after-ledger-loss",
        tool_input: { file_path: join(record, "construction", "unit-b", "design.md") },
      }),
    );
    const lostOut = JSON.parse(afterLoss.stdout) as {
      permission?: string;
      agent_message?: string;
    };
    expect(lostOut.permission).toBe("deny");
    expect(lostOut.agent_message ?? "").toContain("identity is unavailable or ambiguous");
  });

  test("25: partial reviewer-ledger loss cannot resolve an unknown conversation as a developer", () => {
    const proj = installedProject();
    seedStateFile(proj, "state-construction.md");
    const record = seededRecordDir(proj);
    clearLedger(proj);
    mkdirSync(join(record, "construction", "unit-b"), { recursive: true });
    writeFileSync(
      join(record, ".aidlc-reviewer-dispatch.json"),
      JSON.stringify({
        reviewer: "aidlc-architecture-reviewer-agent",
        stage: "functional-design",
        unit: "unit-a",
        exempt: [],
      }),
    );
    registerTaskParent(proj);
    runAdapter(proj, "guards", payload("preToolUseTask", proj));

    runAdapter(
      proj,
      "session-start",
      payload("sessionStart", proj, {
        conversation_id: "developer-parent",
        session_id: "developer-parent",
      }),
    );
    runAdapter(
      proj,
      "guards",
      payload("preToolUseTask", proj, {
        conversation_id: "developer-parent",
        session_id: "developer-parent",
        generation_id: "developer-generation",
        tool_use_id: "developer-tool-use",
        tool_input: {
          description: "Developer probe",
          prompt: "Implement the unit.",
          subagent_type: "aidlc-developer-agent",
        },
      }),
    );

    const entries = ledgerFilesFor(proj).map((path) => ({
      path,
      record: JSON.parse(readFileSync(path, "utf-8")) as { agent?: string },
    }));
    expect(entries).toHaveLength(2);
    const reviewer = entries.find(
      ({ record: entry }) => entry.agent === "aidlc-architecture-reviewer-agent",
    );
    const developer = entries.find(
      ({ record: entry }) => entry.agent === "aidlc-developer-agent",
    );
    expect(reviewer).toBeDefined();
    expect(developer).toBeDefined();
    rmSync(reviewer?.path ?? "");
    expect(existsSync(developer?.path ?? "")).toBe(true);

    const unknown = runAdapter(
      proj,
      "guards",
      payload("preToolUseSubagentRead", proj, {
        conversation_id: "reviewer-after-partial-ledger-loss",
        session_id: "reviewer-after-partial-ledger-loss",
        tool_input: { file_path: join(record, "construction", "unit-b", "design.md") },
      }),
    );
    const out = JSON.parse(unknown.stdout) as {
      permission?: string;
      agent_message?: string;
    };
    expect(out.permission).toBe("deny");
    expect(out.agent_message ?? "").toContain("identity is unavailable or ambiguous");
  });

  test("26: an idle top-level conversation remains main until sessionEnd", () => {
    const proj = installedProject();
    seedStateFile(proj, "state-construction.md");
    const record = seededRecordDir(proj);
    clearLedger(proj);
    mkdirSync(join(record, "construction", "unit-b"), { recursive: true });
    writeFileSync(
      join(record, ".aidlc-reviewer-dispatch.json"),
      JSON.stringify({
        reviewer: "aidlc-architecture-reviewer-agent",
        stage: "functional-design",
        unit: "unit-a",
        exempt: [],
      }),
    );

    const resumedMain = "resumed-main-after-long-idle";
    runAdapter(
      proj,
      "session-start",
      payload("sessionStart", proj, {
        conversation_id: resumedMain,
        session_id: resumedMain,
      }),
    );
    const [resumedMarker] = ledgerFilesFor(proj, ".marker");
    expect(resumedMarker).toBeDefined();

    registerTaskParent(proj);
    runAdapter(proj, "guards", payload("preToolUseTask", proj));
    const expired = new Date(Date.now() - 31 * 60 * 1000);
    utimesSync(resumedMarker, expired, expired);

    const resumed = runAdapter(
      proj,
      "guards",
      payload("preToolUseSubagentRead", proj, {
        conversation_id: resumedMain,
        session_id: resumedMain,
        tool_input: {
          file_path: join(record, "construction", "unit-b", "design.md"),
        },
      }),
    );
    expect(resumed.code).toBe(0);
    expectAllowJson(resumed);
  });
});
