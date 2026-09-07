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

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, sep, win32 } from "node:path";
import {
  createIntent,
  readAllAuditShards,
  setActiveIntentCursor,
  writeActiveDirectiveMarker,
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

setDefaultTimeout(20_000);

afterEach(() => {
  for (const dir of scratch.splice(0)) {
    clearLedger(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});

function setCurrentStage(project: string, stage: string): void {
  const statePath = join(seededRecordDir(project), "aidlc-state.md");
  writeFileSync(
    statePath,
    readFileSync(statePath, "utf-8").replace(
      /^- \*\*Current Stage\*\*:.*$/m,
      `- **Current Stage**: ${stage}`,
    ),
  );
}

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

function witnessFilesFor(projectDir: string): string[] {
  const dir = join(projectDir, "aidlc");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(
      (name) =>
        name.startsWith(".aidlc-cursor-subagent-") && name.endsWith(".json"),
    )
    .map((name) => join(dir, name));
}

function clearLedger(projectDir: string): void {
  rmSync(ledgerDirFor(projectDir), { recursive: true, force: true });
}

function withBackslashes(path: string): string {
  return path.replaceAll("/", "\\");
}

function withMixedSeparators(path: string): string {
  let useBackslash = true;
  return path.replace(/[\\/]/g, () => {
    useBackslash = !useBackslash;
    return useBackslash ? "\\" : "/";
  });
}

function payload(name: string, projectDir: string, extra: Record<string, unknown> = {}): string {
  const replacePlaceholders = (value: unknown): unknown => {
    if (typeof value === "string") {
      return value
        .replaceAll("{{PROJECT}}", projectDir)
        .replaceAll("{{TRANSCRIPT}}", `${projectDir}/t.jsonl`);
    }
    if (Array.isArray(value)) return value.map(replacePlaceholders);
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([key, item]) => [
          key,
          replacePlaceholders(item),
        ]),
      );
    }
    return value;
  };
  return JSON.stringify({
    ...(replacePlaceholders(PAYLOADS[name]) as Record<string, unknown>),
    ...extra,
  });
}

function runAdapter(
  projectDir: string,
  target: string,
  stdin: string,
  options: {
    adapterProjectDir?: string;
    cwd?: string;
    env?: Record<string, string | undefined>;
  } = {},
): { stdout: string; stderr: string; code: number } {
  const adapterProjectDir = options.adapterProjectDir ?? projectDir;
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
    [join(adapterProjectDir, ".cursor", "hooks", "aidlc-cursor-adapter.ts"), target],
    {
      cwd: options.cwd ?? adapterProjectDir,
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

function activateReviewer(project: string): { record: string; dispatch: string } {
  seedStateFile(project, "state-construction.md");
  const record = seededRecordDir(project);
  clearLedger(project);
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
  registerTaskParent(project);
  runAdapter(project, "guards", payload("preToolUseTask", project));
  return { record, dispatch };
}

function windowsAdminUnc(path: string): string {
  const normalized = win32.normalize(path);
  const parsed = win32.parse(normalized);
  if (!/^[A-Za-z]:\\$/.test(parsed.root)) {
    throw new Error(`expected a drive-qualified Windows path, got: ${path}`);
  }
  return `\\\\localhost\\${parsed.root[0]}$\\${normalized.slice(parsed.root.length)}`;
}

function windowsGitBashPath(path: string): string {
  const normalized = win32.normalize(path);
  const parsed = win32.parse(normalized);
  if (!/^[A-Za-z]:\\$/.test(parsed.root)) {
    throw new Error(`expected a drive-qualified Windows path, got: ${path}`);
  }
  return `/${parsed.root[0].toLowerCase()}/${normalized.slice(parsed.root.length).replaceAll("\\", "/")}`;
}

function withMixedUncSeparators(path: string): string {
  if (!path.startsWith("\\\\")) throw new Error(`expected UNC path, got: ${path}`);
  return `\\\\${withMixedSeparators(path.slice(2))}`;
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
  const request = spawnSync("bun", args, { encoding: "utf-8" });
  if (request.status !== 0) {
    throw new Error(`review request failed: ${request.stdout}${request.stderr}`);
  }
  appendFileSync(
    artifact,
    "\n## Review\n\n" +
      "**Verdict:** READY\n" +
      "**Reviewer:** aidlc-product-lead-agent\n" +
      "**Iteration:** 1\n\n" +
      "### Findings\n\nNo blocking findings.\n",
    "utf-8",
  );
  const verdict = spawnSync("bun", [...args, "--verdict", "READY"], {
    encoding: "utf-8",
  });
  if (verdict.status !== 0) {
    throw new Error(`review verdict failed: ${verdict.stdout}${verdict.stderr}`);
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
  test("0: native Write, Shell, and Task paths enforce Plan Approval", () => {
    const proj = installedProject();
    seedStateFile(proj, "state-construction.md");
    const statePath = join(seededRecordDir(proj), "aidlc-state.md");
    const state = readFileSync(statePath, "utf-8").replace(
      /^- \*\*Current Stage\*\*:.*$/m,
      "- **Current Stage**: code-generation",
    );
    writeFileSync(statePath, state);
    writeActiveDirectiveMarker(proj, {
      kind: "run-stage",
      stage: "code-generation",
      state_sha256: createHash("sha256").update(state).digest("hex"),
    });
    for (const input of [
      payload("preToolUseShell", proj, {
        tool_name: "Write",
        tool_input: { file_path: join(proj, "src", "blocked.ts") },
      }),
      payload("preToolUseShell", proj, {
        tool_input: { command: "uniq input.txt src/blocked.txt" },
      }),
      payload("preToolUseTask", proj, {
        tool_input: {
          subagent_type: "aidlc-developer-agent",
          prompt:
            "AIDLC-STAGE: code-generation\n" +
            `AIDLC-TESTING-CONTRACT: sha256:${"a".repeat(64)}`,
        },
      }),
    ]) {
      const result = runAdapter(proj, "guards", input);
      expect(result.code).toBe(0);
      expect((JSON.parse(result.stdout) as { permission?: string }).permission).toBe("deny");
    }
  });

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

  test("2: sessionStart without workflow state exposes only the runtime session", () => {
    const proj = installedProject();
    const r = runAdapter(proj, "session-start", payload("sessionStart", proj));
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout) as { additional_context?: string };
    expect(out.additional_context ?? "").toContain("AIDLC Runtime Session:");
    expect(out.additional_context ?? "").not.toContain("AIDLC WORKFLOW ACTIVE");
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

    // The blocked warning is consumed: resubmitting continues on the bound
    // intent A instead of deadlocking on the same beforeSubmitPrompt response.
    const next = runAdapter(
      proj,
      "mint",
      payload("beforeSubmitPrompt", proj, { session_id: undefined }),
    );
    expect(next.code).toBe(0);
    expect(next.stdout.trim()).toBe("");
    const shard = readAllAuditShards(proj, a.dirName, "default");
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
    setCurrentStage(proj, "functional-design");
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
  }, 30000);

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
  }, 15_000);

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
    setCurrentStage(proj, "functional-design");
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

  test("22b: an unavailable shared freeze parser denies before the guard chain", () => {
    const proj = installedProject();
    seedStateFile(proj, "state-construction.md");
    registerTaskParent(proj);
    runAdapter(
      proj,
      "guards",
      payload("preToolUseTask", proj, {
        tool_input: {
          description: "Developer probe",
          prompt: "Implement the unit.",
          subagent_type: "aidlc-developer-agent",
        },
      }),
    );
    rmSync(join(proj, ".cursor", "hooks", "review-freeze-command.ts"));

    const r = runAdapter(
      proj,
      "guards",
      payload("preToolUseShell", proj, {
        conversation_id: "developer-without-freeze-parser",
        session_id: "developer-without-freeze-parser",
        tool_input: { command: "echo ok" },
      }),
    );
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout) as {
      permission?: string;
      agent_message?: string;
    };
    expect(out.permission).toBe("deny");
    expect(out.agent_message ?? "").toContain(
      "general-purpose interpreters",
    );
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
  }, 15_000);

  test("23b: guards reuse freeze target classification without skipping real writes", () => {
    const proj = installedProject();
    seedStateFile(proj, "state-construction.md");
    const record = seededRecordDir(proj);
    clearLedger(proj);
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

    const marker = join(proj, "review-freeze-child-ran");
    const hook = join(proj, ".cursor", "hooks", "aidlc-review-freeze.ts");
    // Classification comes from the real review-freeze-command.ts; this stub
    // only marks whether the full child hook process was spawned.
    const spawnMarkerHook = `
if (import.meta.main) {
  await Bun.write(${JSON.stringify(marker)}, "ran");
}
`;

    writeFileSync(hook, spawnMarkerHook);
    const harmless = runAdapter(
      proj,
      "guards",
      payload("preToolUseShell", proj, {
        conversation_id: "reviewer-freeze-cache",
        session_id: "reviewer-freeze-cache",
        tool_input: { command: "printf '%s\\n' ok" },
      }),
    );
    expectAllowJson(harmless);
    expect(existsSync(marker)).toBe(false);

    const write = runAdapter(
      proj,
      "guards",
      payload("preToolUseShell", proj, {
        conversation_id: "reviewer-freeze-write",
        session_id: "reviewer-freeze-write",
        tool_input: { command: "printf x >> scratch.txt" },
      }),
    );
    expectAllowJson(write);
    expect(readFileSync(marker, "utf-8")).toBe("ran");
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
      `rm -f ${JSON.stringify(dispatch.slice(0, -1))}*`,
      `rm -f ${JSON.stringify(dispatch.slice(0, -1))}[n]`,
      `rm -rf ${JSON.stringify(`${dirname(record)}${sep}`)}*`,
      `rm -rf ${JSON.stringify(`${join(proj, "aidlc")}${sep}.aidlc-cursor-sub`)}*`,
      `rm -rf ${JSON.stringify(`${join(proj, "aidlc")}${sep}.aidlc-`)}*`,
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
  }, 30_000);

  test("25: partial reviewer-ledger loss cannot resolve an unknown conversation as a developer", () => {
    const proj = installedProject();
    seedStateFile(proj, "state-construction.md");
    setCurrentStage(proj, "functional-design");
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

  test("25b: non-reviewer attribution survives primary-ledger loss and still blocks nested Task", () => {
    const proj = installedProject();
    seedStateFile(proj, "state-construction.md");
    clearLedger(proj);
    registerTaskParent(proj);
    const spawn = runAdapter(
      proj,
      "guards",
      payload("preToolUseTask", proj, {
        tool_input: {
          description: "Developer probe",
          prompt: "Implement the unit.",
          subagent_type: "aidlc-developer-agent",
        },
      }),
    );
    expectAllowJson(spawn);
    expect(ledgerFilesFor(proj)).toHaveLength(1);
    expect(witnessFilesFor(proj)).toHaveLength(1);

    const encodedRemoval = Buffer.from(
      `require("node:fs").rmSync(${JSON.stringify(ledgerDirFor(proj))}, { recursive: true, force: true });`,
      "utf-8",
    ).toString("base64");
    const dynamicRemoval = runAdapter(
      proj,
      "guards",
      payload("preToolUseShell", proj, {
        conversation_id: "developer-child",
        session_id: "developer-child",
        tool_input: {
          command: `node -e 'eval(Buffer.from("${encodedRemoval}", "base64").toString())'`,
        },
      }),
    );
    const dynamicOut = JSON.parse(dynamicRemoval.stdout) as {
      permission?: string;
      agent_message?: string;
    };
    expect(dynamicOut.permission).toBe("deny");
    expect(dynamicOut.agent_message ?? "").toContain(
      "general-purpose interpreters",
    );

    rmSync(ledgerDirFor(proj), { recursive: true, force: true });
    expect(witnessFilesFor(proj)).toHaveLength(1);
    const nested = runAdapter(
      proj,
      "guards",
      payload("preToolUseTask", proj, {
        conversation_id: "developer-child",
        session_id: "developer-child",
        generation_id: "nested-generation",
        tool_use_id: "nested-tool-use",
        tool_input: {
          description: "Nested probe",
          prompt: "Delegate again.",
          subagent_type: "aidlc-quality-agent",
        },
      }),
    );
    const nestedOut = JSON.parse(nested.stdout) as {
      permission?: string;
      agent_message?: string;
    };
    expect(nestedOut.permission).toBe("deny");
    expect(nestedOut.agent_message ?? "").toContain(
      "nested delegation is not allowed",
    );
    expect(ledgerFilesFor(proj)).toHaveLength(0);
    expect(witnessFilesFor(proj)).toHaveLength(1);
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

  test("27: attribution protection parses Windows and mixed-separator shell paths", () => {
    const proj = installedProject();
    seedStateFile(proj, "state-construction.md");
    const record = seededRecordDir(proj);
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

    for (const target of [
      `${withBackslashes(dispatch.slice(0, -1))}*`,
      `${withMixedSeparators(dispatch.slice(0, -1))}*`,
    ]) {
      const removal = runAdapter(
        proj,
        "guards",
        payload("preToolUseShell", proj, {
          conversation_id: "reviewer-windows-path-conversation",
          session_id: "reviewer-windows-path-conversation",
          tool_input: { command: `rm -f ${target}` },
        }),
      );
      const out = JSON.parse(removal.stdout) as {
        permission?: string;
        agent_message?: string;
      };
      if (process.platform === "win32") {
        expect(out.permission, target).toBe("deny");
        expect(out.agent_message ?? "", target).toContain("attribution state");
      } else {
        expectAllowJson(removal, target);
      }
    }

    for (const target of [
      withBackslashes(join(proj, "scratch", "ordinary.txt")),
      `${withMixedSeparators(join(proj, "scratch", "ordinary"))}*`,
    ]) {
      const safe = runAdapter(
        proj,
        "guards",
        payload("preToolUseShell", proj, {
          conversation_id: "reviewer-safe-windows-path-conversation",
          session_id: "reviewer-safe-windows-path-conversation",
          tool_input: { command: `rm -f ${target}` },
        }),
      );
      expectAllowJson(safe, target);
    }

    const executableSafeCommand = "echo aidlc-safe-command";
    const executableSafe = runAdapter(
      proj,
      "guards",
      payload("preToolUseShell", proj, {
        conversation_id: "reviewer-executable-safe-path-conversation",
        session_id: "reviewer-executable-safe-path-conversation",
        tool_input: { command: executableSafeCommand },
      }),
    );
    expectAllowJson(executableSafe, executableSafeCommand);
    const executed =
      process.platform === "win32"
        ? spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/c", executableSafeCommand])
        : spawnSync("sh", ["-c", executableSafeCommand]);
    expect(executed.status, executableSafeCommand).toBe(0);
    expect(executed.stdout.toString(), executableSafeCommand).toContain("aidlc-safe-command");
  });

  test("28: POSIX ordinary-character escapes retain shell meaning for non-allowlisted mutators", () => {
    if (process.platform === "win32") return;
    const proj = installedProject();
    const { dispatch } = activateReviewer(proj);
    const escapedDispatch = dispatch.replace("dispatch", "dispatc\\h");
    expect(escapedDispatch).not.toContain(".aidlc-reviewer-dispatch.json");

    const expanded = spawnSync("sh", ["-c", `printf '%s' ${escapedDispatch}`], {
      encoding: "utf-8",
    });
    expect(expanded.status).toBe(0);
    expect(expanded.stdout).toBe(dispatch);

    const removal = runAdapter(
      proj,
      "guards",
      payload("preToolUseShell", proj, {
        conversation_id: "reviewer-posix-escape-conversation",
        session_id: "reviewer-posix-escape-conversation",
        tool_input: { command: `shred -u ${escapedDispatch}` },
      }),
    );
    const out = JSON.parse(removal.stdout) as {
      permission?: string;
      agent_message?: string;
    };
    expect(out.permission).toBe("deny");
    expect(out.agent_message ?? "").toContain("attribution state");

    const harmless = runAdapter(
      proj,
      "guards",
      payload("preToolUseShell", proj, {
        conversation_id: "reviewer-harmless-posix-escape-conversation",
        session_id: "reviewer-harmless-posix-escape-conversation",
        tool_input: { command: "printf '%s\\n' harmless\\h" },
      }),
    );
    expectAllowJson(harmless);
  });

  test("29: Windows evaluator variants and unresolved expansion remain fail-closed", () => {
    const proj = installedProject();
    const { dispatch } = activateReviewer(proj);
    const externalGitDir = join(proj, "scratch", "git-exec-path");
    mkdirSync(externalGitDir, { recursive: true });
    const externalGitProgram = join(
      externalGitDir,
      process.platform === "win32" ? "git-externalpwn.cmd" : "git-externalpwn",
    );
    writeFileSync(
      externalGitProgram,
      process.platform === "win32" ? "@echo off\r\nexit /b 0\r\n" : "#!/bin/sh\nexit 0\n",
    );
    if (process.platform !== "win32") chmodSync(externalGitProgram, 0o755);
    const hooksDir = join(proj, "scratch", "git-hooks");
    mkdirSync(hooksDir, { recursive: true });
    const preCommitHook = join(hooksDir, "pre-commit");
    writeFileSync(preCommitHook, "#!/bin/sh\nexit 0\n");
    if (process.platform !== "win32") chmodSync(preCommitHook, 0o755);
    const encoded = Buffer.from("Remove-Item $env:AIDLC_REVIEW_TARGET", "utf16le").toString(
      "base64",
    );
    const commands = [
      "builtin eval \"printf harmless\"",
      "builtin builtin -- eval \"printf harmless\"",
      "Invoke-Expression \"'harmless'\"",
      "iex \"'harmless'\"",
      "Start-Process echo -ArgumentList harmless",
      "Invoke-Command { 'harmless' }",
      `powershell.exe -NoProfile -EncodedCommand ${encoded}`,
      `"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -Command "'a' + 'b'"`,
      `cmd.exe /d /c "echo %AIDLC_REVIEW_TARGET%"`,
      "del /q %AIDLC_REVIEW_TARGET%",
      `del /q ${dispatch.replace("dispatch", "dispatc^h")}`,
      "Remove-Item -Path ('ordinary-' + 'name')",
      "cscript.exe harmless.vbs",
      "wscript.exe harmless.vbs",
      "mshta.exe about:blank",
      "awk 'BEGIN { print 1 }'",
      "busybox awk 'BEGIN { print 1 }'",
      "rd -Recurse -Force ('ordinary-' + 'name')",
      "git -c alias.pwn='!echo harmless | sh' pwn",
      `& ('Remove' + '-Item') -Force ('${dispatch.slice(0, -"-dispatch.json".length)}' + '-dispatch.json')`,
      "& ('Remove-Item'.ToString()) ordinary",
      "PWN='!echo harmless | sh' git --config-env=alias.pwn=PWN pwn",
      `GIT_CONFIG_GLOBAL=${join(proj, "scratch", "gitconfig")} git pwn`,
      `git --exec-path=${externalGitDir} externalpwn`,
      `GIT_EXEC_PATH=${externalGitDir} git externalpwn`,
      `env GIT_EXEC_PATH=${externalGitDir} git externalpwn`,
      `git -c core.hooksPath=${hooksDir} -c user.name=x -c user.email=x@y commit --allow-empty -m x`,
      `GIT_EDITOR=${externalGitProgram} git commit --allow-empty -m x`,
      `git -c diff.external=${externalGitProgram} diff`,
      `git bisect run ${externalGitProgram}`,
      `git submodule foreach ${externalGitProgram}`,
      `git -c core.fsmonitor=${externalGitProgram} status --short`,
      `GIT_PAGER=${externalGitProgram} git status --short`,
      "git --no-pager branch -- --list",
      "git --no-pager tag -- --list",
      `git -c diff.external=${externalGitProgram} --no-pager diff --cached -- scratch/ordinary --no-ext-diff --no-textconv --ignore-submodules=all`,
      `git -c diff.external=${externalGitProgram} --no-pager diff --cached --no-ext-diff --ext-diff --no-textconv --ignore-submodules=all scratch/ordinary`,
      `git --no-pager diff --cached --no-ext-diff --no-textconv --textconv --ignore-submodules=all scratch/ordinary`,
      "git --no-pager --paginate branch --list",
      "git config alias.pwn '!echo harmless | sh'",
      "git config --global alias.pwn '!echo harmless | sh'",
    ];
    for (const command of commands) {
      expect(command).not.toContain(".aidlc-reviewer-dispatch.json");
      const evaluation = runAdapter(
        proj,
        "guards",
        payload("preToolUseShell", proj, {
          conversation_id: "reviewer-windows-evaluator-conversation",
          session_id: "reviewer-windows-evaluator-conversation",
          tool_input: { command },
        }),
      );
      const out = JSON.parse(evaluation.stdout) as {
        permission?: string;
        agent_message?: string;
      };
      expect(out.permission, command).toBe("deny");
      expect(out.agent_message ?? "", command).toContain("dynamic command evaluation");
    }

    const harmless = runAdapter(
      proj,
      "guards",
      payload("preToolUseShell", proj, {
        conversation_id: "reviewer-harmless-evaluator-text-conversation",
        session_id: "reviewer-harmless-evaluator-text-conversation",
        tool_input: {
          command:
            "printf '%s\\n' 'powershell.exe cmd.exe cscript.exe wscript.exe mshta.exe awk Remove-Item + %TARGET% ^'",
        },
      }),
    );
    expectAllowJson(harmless);

    for (const command of [
      `rm -f ${join(proj, "scratch", "report+backup.txt")}`,
      "git -c core.quotePath=false status --short",
      "PROXY=http://127.0.0.1 git --config-env=http.proxy=PROXY status --short",
      "git config --get alias.pwn",
      `git --exec-path=${externalGitDir} status --short`,
      `GIT_EXEC_PATH=${externalGitDir} git status --short`,
      "GIT_PAGER=cat git status --short",
      "git -c core.fsmonitor=false status --short",
      "git rev-parse --is-inside-work-tree",
    ]) {
      const safe = runAdapter(
        proj,
        "guards",
        payload("preToolUseShell", proj, {
          conversation_id: "reviewer-safe-evaluator-boundary-conversation",
          session_id: "reviewer-safe-evaluator-boundary-conversation",
          tool_input: { command },
        }),
      );
      expectAllowJson(safe, command);
    }

    const init = spawnSync("git", ["init"], { cwd: proj, encoding: "utf-8" });
    expect(init.status).toBe(0);
    const unsafeAlternateRepo = join(proj, "scratch", "unsafe-alternate-repo");
    const safeAlternateRepo = join(proj, "scratch", "safe-alternate-repo");
    mkdirSync(unsafeAlternateRepo, { recursive: true });
    mkdirSync(safeAlternateRepo, { recursive: true });
    expect(spawnSync("git", ["init"], { cwd: unsafeAlternateRepo }).status).toBe(0);
    expect(spawnSync("git", ["init"], { cwd: safeAlternateRepo }).status).toBe(0);
    expect(
      spawnSync("git", ["config", "core.fsmonitor", externalGitProgram], {
        cwd: unsafeAlternateRepo,
      }).status,
    ).toBe(0);
    const unsafeGitDir = join(unsafeAlternateRepo, ".git").replaceAll("\\", "/");
    const unsafeWorkTree = unsafeAlternateRepo.replaceAll("\\", "/");
    const safeGitDir = join(safeAlternateRepo, ".git").replaceAll("\\", "/");
    const safeWorkTree = safeAlternateRepo.replaceAll("\\", "/");
    for (const command of [
      `GIT_DIR=${unsafeGitDir} GIT_WORK_TREE=${unsafeWorkTree} git status --ignore-submodules=all`,
      `env GIT_DIR=${unsafeGitDir} GIT_WORK_TREE=${unsafeWorkTree} git status --ignore-submodules=all`,
      `GIT_COMMON_DIR=${unsafeGitDir} git status --ignore-submodules=all`,
    ]) {
      const unsafeRepository = runAdapter(
        proj,
        "guards",
        payload("preToolUseShell", proj, {
          conversation_id: "reviewer-unsafe-alternate-repository-conversation",
          session_id: "reviewer-unsafe-alternate-repository-conversation",
          tool_input: { command },
        }),
      );
      const unsafeRepositoryOut = JSON.parse(unsafeRepository.stdout) as {
        permission?: string;
        agent_message?: string;
      };
      expect(unsafeRepositoryOut.permission, command).toBe("deny");
      expect(unsafeRepositoryOut.agent_message ?? "", command).toContain(
        "dynamic command evaluation",
      );
    }

    for (const command of [
      `GIT_DIR=${safeGitDir} GIT_WORK_TREE=${safeWorkTree} git status --ignore-submodules=all`,
      `env GIT_DIR=${safeGitDir} GIT_WORK_TREE=${safeWorkTree} git status --ignore-submodules=all`,
      `GIT_COMMON_DIR=${safeGitDir} git status --ignore-submodules=all`,
      `GIT_NAMESPACE=review git status --ignore-submodules=all`,
    ]) {
      const safeRepository = runAdapter(
        proj,
        "guards",
        payload("preToolUseShell", proj, {
          conversation_id: "reviewer-safe-alternate-repository-conversation",
          session_id: "reviewer-safe-alternate-repository-conversation",
          tool_input: { command },
        }),
      );
      expectAllowJson(safeRepository, command);
    }

    const unsetRepositorySelectors =
      "env -u GIT_DIR -u GIT_WORK_TREE git status --ignore-submodules=all";
    const safeUnsetRepository = runAdapter(
      proj,
      "guards",
      payload("preToolUseShell", proj, {
        conversation_id: "reviewer-unset-alternate-repository-conversation",
        session_id: "reviewer-unset-alternate-repository-conversation",
        tool_input: { command: unsetRepositorySelectors },
      }),
      { env: { GIT_DIR: unsafeGitDir, GIT_WORK_TREE: unsafeWorkTree } },
    );
    expectAllowJson(safeUnsetRepository, unsetRepositorySelectors);

    const resetRepositorySelectors =
      `env -i GIT_DIR=${safeGitDir} GIT_WORK_TREE=${safeWorkTree} git status --ignore-submodules=all`;
    const resetRepository = runAdapter(
      proj,
      "guards",
      payload("preToolUseShell", proj, {
        conversation_id: "reviewer-reset-alternate-repository-conversation",
        session_id: "reviewer-reset-alternate-repository-conversation",
        tool_input: { command: resetRepositorySelectors },
      }),
    );
    const resetRepositoryOut = JSON.parse(resetRepository.stdout) as {
      permission?: string;
      agent_message?: string;
    };
    expect(resetRepositoryOut.permission).toBe("deny");
    expect(resetRepositoryOut.agent_message ?? "").toContain(
      "dynamic command evaluation",
    );

    const alternateChild = join(safeAlternateRepo, "child");
    mkdirSync(alternateChild, { recursive: true });
    expect(spawnSync("git", ["init"], { cwd: alternateChild }).status).toBe(0);
    expect(
      spawnSync("git", ["config", "user.name", "AIDLC Test"], {
        cwd: alternateChild,
      }).status,
    ).toBe(0);
    expect(
      spawnSync("git", ["config", "user.email", "aidlc@example.invalid"], {
        cwd: alternateChild,
      }).status,
    ).toBe(0);
    expect(
      spawnSync("git", ["commit", "--allow-empty", "-m", "fixture"], {
        cwd: alternateChild,
      }).status,
    ).toBe(0);
    expect(
      spawnSync("git", ["config", "core.fsmonitor", externalGitProgram], {
        cwd: alternateChild,
      }).status,
    ).toBe(0);
    const alternateChildHead = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: alternateChild,
      encoding: "utf-8",
    }).stdout.trim();
    expect(
      spawnSync(
        "git",
        ["update-index", "--add", "--cacheinfo", "160000", alternateChildHead, "child"],
        { cwd: safeAlternateRepo },
      ).status,
    ).toBe(0);
    writeFileSync(join(proj, "README.md"), "# Safe pathspec fixture\n");

    for (const command of [
      `GIT_DIR=${safeGitDir} GIT_WORK_TREE=${safeWorkTree} git status --ignore-submodules=none`,
      `env GIT_DIR=${safeGitDir} GIT_WORK_TREE=${safeWorkTree} git status --ignore-submodules=none`,
    ]) {
      const unsafeAlternateChild = runAdapter(
        proj,
        "guards",
        payload("preToolUseShell", proj, {
          conversation_id: "reviewer-unsafe-alternate-submodule-conversation",
          session_id: "reviewer-unsafe-alternate-submodule-conversation",
          tool_input: { command },
        }),
      );
      const unsafeAlternateChildOut = JSON.parse(unsafeAlternateChild.stdout) as {
        permission?: string;
        agent_message?: string;
      };
      expect(unsafeAlternateChildOut.permission, command).toBe("deny");
      expect(unsafeAlternateChildOut.agent_message ?? "", command).toContain(
        "dynamic command evaluation",
      );
    }

    const safeAlternateChildCommand =
      `GIT_DIR=${safeGitDir} GIT_WORK_TREE=${safeWorkTree} git status --ignore-submodules=all`;
    const safeAlternateChild = runAdapter(
      proj,
      "guards",
      payload("preToolUseShell", proj, {
        conversation_id: "reviewer-safe-alternate-submodule-conversation",
        session_id: "reviewer-safe-alternate-submodule-conversation",
        tool_input: { command: safeAlternateChildCommand },
      }),
    );
    expectAllowJson(safeAlternateChild, safeAlternateChildCommand);

    const shellAlias = spawnSync(
      "git",
      ["config", "alias.pwn", "!echo harmless | sh"],
      { cwd: proj, encoding: "utf-8" },
    );
    expect(shellAlias.status).toBe(0);
    const persisted = runAdapter(
      proj,
      "guards",
      payload("preToolUseShell", proj, {
        conversation_id: "reviewer-persisted-git-alias-conversation",
        session_id: "reviewer-persisted-git-alias-conversation",
        tool_input: { command: "git pwn" },
      }),
    );
    const persistedOut = JSON.parse(persisted.stdout) as {
      permission?: string;
      agent_message?: string;
    };
    expect(persistedOut.permission).toBe("deny");
    expect(persistedOut.agent_message ?? "").toContain("dynamic command evaluation");

    const safeAlias = spawnSync(
      "git",
      ["config", "alias.st", "status --short"],
      { cwd: proj, encoding: "utf-8" },
    );
    expect(safeAlias.status).toBe(0);
    const externalAlias = spawnSync(
      "git",
      ["config", "alias.ext", "externalpwn"],
      { cwd: proj, encoding: "utf-8" },
    );
    expect(externalAlias.status).toBe(0);

    const externalAliasCommand = `git --exec-path=${externalGitDir} ext`;
    const externalAliasResult = runAdapter(
      proj,
      "guards",
      payload("preToolUseShell", proj, {
        conversation_id: "reviewer-persisted-external-git-alias-conversation",
        session_id: "reviewer-persisted-external-git-alias-conversation",
        tool_input: { command: externalAliasCommand },
      }),
    );
    const externalAliasOut = JSON.parse(externalAliasResult.stdout) as {
      permission?: string;
      agent_message?: string;
    };
    expect(externalAliasOut.permission).toBe("deny");
    expect(externalAliasOut.agent_message ?? "").toContain("dynamic command evaluation");

    const submoduleDir = join(proj, "scratch", "status-submodule");
    mkdirSync(submoduleDir, { recursive: true });
    expect(spawnSync("git", ["init"], { cwd: submoduleDir }).status).toBe(0);
    expect(
      spawnSync("git", ["config", "user.name", "AIDLC Test"], {
        cwd: submoduleDir,
      }).status,
    ).toBe(0);
    expect(
      spawnSync("git", ["config", "user.email", "aidlc@example.invalid"], {
        cwd: submoduleDir,
      }).status,
    ).toBe(0);
    expect(
      spawnSync("git", ["commit", "--allow-empty", "-m", "fixture"], {
        cwd: submoduleDir,
      }).status,
    ).toBe(0);
    expect(
      spawnSync("git", ["config", "core.fsmonitor", externalGitProgram], {
        cwd: submoduleDir,
      }).status,
    ).toBe(0);
    const submoduleHead = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: submoduleDir,
      encoding: "utf-8",
    }).stdout.trim();
    const submodulePath = "scratch/status-submodule";
    const unsafeAlternateIndex = join(proj, "scratch", "unsafe-alternate.index");
    const safeAlternateIndex = join(proj, "scratch", "safe-alternate.index");
    const unsafeIndexEnv = {
      ...process.env,
      GIT_INDEX_FILE: unsafeAlternateIndex,
    };
    const safeIndexEnv = {
      ...process.env,
      GIT_INDEX_FILE: safeAlternateIndex,
    };
    expect(
      spawnSync("git", ["read-tree", "--empty"], {
        cwd: proj,
        env: unsafeIndexEnv,
      }).status,
    ).toBe(0);
    expect(
      spawnSync(
        "git",
        ["update-index", "--add", "--cacheinfo", "160000", submoduleHead, submodulePath],
        { cwd: proj, env: unsafeIndexEnv },
      ).status,
    ).toBe(0);
    expect(
      spawnSync("git", ["read-tree", "--empty"], {
        cwd: proj,
        env: safeIndexEnv,
      }).status,
    ).toBe(0);
    const unsafeIndexValue = unsafeAlternateIndex.replaceAll("\\", "/");
    const safeIndexValue = safeAlternateIndex.replaceAll("\\", "/");
    for (const command of [
      `GIT_INDEX_FILE=${unsafeIndexValue} git status --ignore-submodules=none`,
      `env GIT_INDEX_FILE=${unsafeIndexValue} git status --ignore-submodules=none`,
    ]) {
      const unsafeIndexStatus = runAdapter(
        proj,
        "guards",
        payload("preToolUseShell", proj, {
          conversation_id: "reviewer-unsafe-alternate-index-conversation",
          session_id: "reviewer-unsafe-alternate-index-conversation",
          tool_input: { command },
        }),
      );
      const unsafeIndexOut = JSON.parse(unsafeIndexStatus.stdout) as {
        permission?: string;
        agent_message?: string;
      };
      expect(unsafeIndexOut.permission, command).toBe("deny");
      expect(unsafeIndexOut.agent_message ?? "", command).toContain(
        "dynamic command evaluation",
      );
    }

    for (const command of [
      `GIT_INDEX_FILE=${safeIndexValue} git status --ignore-submodules=none`,
      `env GIT_INDEX_FILE=${safeIndexValue} git status --ignore-submodules=none`,
    ]) {
      const safeIndexStatus = runAdapter(
        proj,
        "guards",
        payload("preToolUseShell", proj, {
          conversation_id: "reviewer-safe-alternate-index-conversation",
          session_id: "reviewer-safe-alternate-index-conversation",
          tool_input: { command },
        }),
      );
      expectAllowJson(safeIndexStatus, command);
    }

    const unsetIndexCommand =
      "env -u GIT_INDEX_FILE git status --ignore-submodules=none";
    const unsetIndexStatus = runAdapter(
      proj,
      "guards",
      payload("preToolUseShell", proj, {
        conversation_id: "reviewer-unset-alternate-index-conversation",
        session_id: "reviewer-unset-alternate-index-conversation",
        tool_input: { command: unsetIndexCommand },
      }),
      { env: { GIT_INDEX_FILE: unsafeIndexValue } },
    );
    expectAllowJson(unsetIndexStatus, unsetIndexCommand);

    const resetIndexCommand =
      `env -i GIT_INDEX_FILE=${safeIndexValue} git status --ignore-submodules=none`;
    const resetIndexStatus = runAdapter(
      proj,
      "guards",
      payload("preToolUseShell", proj, {
        conversation_id: "reviewer-reset-alternate-index-conversation",
        session_id: "reviewer-reset-alternate-index-conversation",
        tool_input: { command: resetIndexCommand },
      }),
    );
    const resetIndexOut = JSON.parse(resetIndexStatus.stdout) as {
      permission?: string;
      agent_message?: string;
    };
    expect(resetIndexOut.permission).toBe("deny");
    expect(resetIndexOut.agent_message ?? "").toContain(
      "dynamic command evaluation",
    );


    for (const command of [
      "git --no-pager branch --list",
      "git --no-pager tag --list",
      "git --no-pager diff --cached --no-ext-diff --no-textconv --ignore-submodules=all",
      "git --paginate --no-pager branch --list",
      `git -c diff.external=${externalGitProgram} --no-pager diff --cached --ext-diff --no-ext-diff --textconv --no-textconv --ignore-submodules=none --ignore-submodules=all scratch/ordinary`,
    ]) {
      const safeInspection = runAdapter(
        proj,
        "guards",
        payload("preToolUseShell", proj, {
          conversation_id: "reviewer-safe-git-inspection-conversation",
          session_id: "reviewer-safe-git-inspection-conversation",
          tool_input: { command },
        }),
      );
      expectAllowJson(safeInspection, command);
    }

    const safePersisted = runAdapter(
      proj,
      "guards",
      payload("preToolUseShell", proj, {
        conversation_id: "reviewer-safe-persisted-git-alias-conversation",
        session_id: "reviewer-safe-persisted-git-alias-conversation",
        tool_input: { command: "git st" },
      }),
    );
    expectAllowJson(safePersisted, "git st");

    const safePersistedWithExecPath = `git --exec-path=${externalGitDir} st`;
    const safePersistedExecPath = runAdapter(
      proj,
      "guards",
      payload("preToolUseShell", proj, {
        conversation_id: "reviewer-safe-persisted-git-exec-path-conversation",
        session_id: "reviewer-safe-persisted-git-exec-path-conversation",
        tool_input: { command: safePersistedWithExecPath },
      }),
    );
    expectAllowJson(safePersistedExecPath, safePersistedWithExecPath);

    const nestedRepo = join(proj, "scratch", "nested-repo");
    mkdirSync(nestedRepo, { recursive: true });
    expect(spawnSync("git", ["init"], { cwd: nestedRepo }).status).toBe(0);
    expect(
      spawnSync("git", ["config", "alias.pwn", "!echo harmless | sh"], {
        cwd: nestedRepo,
      }).status,
    ).toBe(0);
    expect(
      spawnSync("git", ["config", "alias.st", "status --short"], {
        cwd: nestedRepo,
      }).status,
    ).toBe(0);
    const nestedRelative = relative(proj, nestedRepo).replaceAll("\\", "/");
    for (const command of [
      `git -C ${nestedRelative} pwn`,
      `git --git-dir=${nestedRelative}/.git --work-tree=${nestedRelative} pwn`,
      `env -C ${nestedRelative} git pwn`,
      `env --chdir=${nestedRelative} git pwn`,
    ]) {
      const nestedAlias = runAdapter(
        proj,
        "guards",
        payload("preToolUseShell", proj, {
          conversation_id: "reviewer-nested-persisted-git-alias-conversation",
          session_id: "reviewer-nested-persisted-git-alias-conversation",
          tool_input: { command },
        }),
      );
      const nestedOut = JSON.parse(nestedAlias.stdout) as {
        permission?: string;
        agent_message?: string;
      };
      expect(nestedOut.permission, command).toBe("deny");
      expect(nestedOut.agent_message ?? "", command).toContain("dynamic command evaluation");
    }
    for (const command of [
      `git -C ${nestedRelative} st`,
      `env --chdir=${nestedRelative} git st`,
    ]) {
      const safeNestedAlias = runAdapter(
        proj,
        "guards",
        payload("preToolUseShell", proj, {
          conversation_id: "reviewer-safe-nested-persisted-git-alias-conversation",
          session_id: "reviewer-safe-nested-persisted-git-alias-conversation",
          tool_input: { command },
        }),
      );
      expectAllowJson(safeNestedAlias, command);
    }

    if (process.platform !== "win32") {
      const alternateHome = join(proj, "scratch", "alternate-home");
      mkdirSync(alternateHome, { recursive: true });
      writeFileSync(
        join(alternateHome, ".gitconfig"),
        "[alias]\n  homepwn = !echo harmless | sh\n  homest = status --short\n",
      );
      const xdgHome = join(proj, "scratch", "xdg-home");
      mkdirSync(join(xdgHome, "git"), { recursive: true });
      writeFileSync(
        join(xdgHome, "git", "config"),
        "[alias]\n  xdgpwn = !echo harmless | sh\n",
      );
      const safeHome = join(proj, "scratch", "safe-home");
      mkdirSync(safeHome, { recursive: true });
      writeFileSync(
        join(safeHome, ".gitconfig"),
        "[alias]\n  homest = status --short\n",
      );
      for (const command of [
        `HOME=${alternateHome} git homepwn`,
        `XDG_CONFIG_HOME=${xdgHome} git xdgpwn`,
        `env HOME=${alternateHome} git homepwn`,
        `env XDG_CONFIG_HOME=${xdgHome} git xdgpwn`,
        `env -S 'HOME=${alternateHome} git homepwn'`,
        `env --split-string='XDG_CONFIG_HOME=${xdgHome} git xdgpwn'`,
        `command env HOME=${alternateHome} git homepwn`,
        `nice -n 5 env HOME=${alternateHome} git homepwn`,
        `timeout 5 env HOME=${alternateHome} git homepwn`,
        `env -a git HOME=${alternateHome} git homepwn`,
        `env --argv0 git HOME=${alternateHome} git homepwn`,
        `env --argv0=git HOME=${alternateHome} git homepwn`,
        `command env -a git HOME=${alternateHome} git homepwn`,
        `exec -a ignored env HOME=${alternateHome} git homepwn`,
        `command exec -a ignored env HOME=${alternateHome} git homepwn`,
        `printf 'x:' | xargs -d : env HOME=${alternateHome} git homepwn`,
        `xargs --delimiter : env HOME=${alternateHome} git homepwn`,
        `xargs --delimiter=: env HOME=${alternateHome} git homepwn`,
        `xargs --eof env HOME=${alternateHome} git homepwn`,
        `xargs --eof=STOP env HOME=${alternateHome} git homepwn`,
        `xargs --replace env HOME=${alternateHome} git homepwn`,
        `xargs --replace=TOKEN env HOME=${alternateHome} git homepwn`,
        `xargs --max-lines env HOME=${alternateHome} git homepwn`,
        `xargs --max-lines=1 env HOME=${alternateHome} git homepwn`,
        `xargs -L 1 env HOME=${alternateHome} git homepwn`,
        `xargs --process-slot-var SLOT env HOME=${alternateHome} git homepwn`,
        `xargs -J REPL env HOME=${alternateHome} git homepwn`,
        `ENV.EXE HOME=${alternateHome} GIT.EXE homepwn`,
        `"C:/Program Files/Git/usr/bin/ENV.EXE" HOME=${alternateHome} "C:/Program Files/Git/cmd/GIT.EXE" homepwn`,
        `env -uHOME HOME=${alternateHome} git homepwn`,
        `env -C${proj} HOME=${alternateHome} git homepwn`,
        `env -agit HOME=${alternateHome} git homepwn`,
        `env -i0 HOME=${alternateHome} git homepwn`,
        `HOME=${safeHome} git homest; HOME=${alternateHome} git homepwn`,
      ]) {
        const alternateAlias = runAdapter(
          proj,
          "guards",
          payload("preToolUseShell", proj, {
            conversation_id: "reviewer-command-local-git-alias-conversation",
            session_id: "reviewer-command-local-git-alias-conversation",
            tool_input: { command },
          }),
        );
        const alternateOut = JSON.parse(alternateAlias.stdout) as {
          permission?: string;
          agent_message?: string;
        };
        expect(alternateOut.permission, command).toBe("deny");
        expect(alternateOut.agent_message ?? "", command).toContain(
          "dynamic command evaluation",
        );
      }

      const ambiguousWrapperCommand =
        `xargs --future-value SLOT env HOME=${alternateHome} git homepwn`;
      const ambiguousWrapper = runAdapter(
        proj,
        "guards",
        payload("preToolUseShell", proj, {
          conversation_id: "reviewer-ambiguous-wrapper-conversation",
          session_id: "reviewer-ambiguous-wrapper-conversation",
          tool_input: { command: ambiguousWrapperCommand },
        }),
      );
      const ambiguousWrapperOut = JSON.parse(ambiguousWrapper.stdout) as {
        permission?: string;
        agent_message?: string;
      };
      expect(ambiguousWrapperOut.permission).toBe("deny");
      expect(ambiguousWrapperOut.agent_message ?? "").toContain("attribution state");
      const safeAlternateCommand = `HOME=${alternateHome} git homest`;
      const safeAlternate = runAdapter(
        proj,
        "guards",
        payload("preToolUseShell", proj, {
          conversation_id: "reviewer-safe-command-local-git-alias-conversation",
          session_id: "reviewer-safe-command-local-git-alias-conversation",
          tool_input: { command: safeAlternateCommand },
        }),
      );
      expectAllowJson(safeAlternate, safeAlternateCommand);

      const safeEnvCommand = `env HOME=${alternateHome} git homest`;
      const safeEnv = runAdapter(
        proj,
        "guards",
        payload("preToolUseShell", proj, {
          conversation_id: "reviewer-safe-env-git-alias-conversation",
          session_id: "reviewer-safe-env-git-alias-conversation",
          tool_input: { command: safeEnvCommand },
        }),
      );
      expectAllowJson(safeEnv, safeEnvCommand);

      const safeSplitCommand = `env -S 'HOME=${safeHome} git homest'`;
      const safeSplit = runAdapter(
        proj,
        "guards",
        payload("preToolUseShell", proj, {
          conversation_id: "reviewer-safe-split-env-git-alias-conversation",
          session_id: "reviewer-safe-split-env-git-alias-conversation",
          tool_input: { command: safeSplitCommand },
        }),
      );
      expectAllowJson(safeSplit, safeSplitCommand);

      for (const { command, env } of [
        {
          command: "env -u HOME git status --short",
          env: { HOME: alternateHome, XDG_CONFIG_HOME: undefined },
        },
        {
          command: "env --unset=HOME git status --short",
          env: { HOME: alternateHome, XDG_CONFIG_HOME: undefined },
        },
        {
          command: "env -uHOME git status --short",
          env: { HOME: alternateHome, XDG_CONFIG_HOME: undefined },
        },
        {
          command: "env -u XDG_CONFIG_HOME git status --short",
          env: { HOME: undefined, XDG_CONFIG_HOME: xdgHome },
        },
        {
          command: "command env -u HOME git status --short",
          env: { HOME: alternateHome, XDG_CONFIG_HOME: undefined },
        },
      ]) {
        const clearedAlias = runAdapter(
          proj,
          "guards",
          payload("preToolUseShell", proj, {
            conversation_id: "reviewer-cleared-git-environment-conversation",
            session_id: "reviewer-cleared-git-environment-conversation",
            tool_input: { command },
          }),
          { env },
        );
        expectAllowJson(clearedAlias, command);
      }

      for (const command of [
        `env -u HOME HOME=${alternateHome} git homepwn`,
        `env -i HOME=${alternateHome} git homepwn`,
        `env -uHOME HOME=${alternateHome} git homepwn`,
        `env -i0 HOME=${alternateHome} git homepwn`,
      ]) {
        const restoredAlias = runAdapter(
          proj,
          "guards",
          payload("preToolUseShell", proj, {
            conversation_id: "reviewer-restored-git-environment-conversation",
            session_id: "reviewer-restored-git-environment-conversation",
            tool_input: { command },
          }),
        );
        const restoredOut = JSON.parse(restoredAlias.stdout) as {
          permission?: string;
          agent_message?: string;
        };
        expect(restoredOut.permission, command).toBe("deny");
        expect(restoredOut.agent_message ?? "", command).toContain(
          "dynamic command evaluation",
        );
      }

      for (const command of [
        `command env HOME=${alternateHome} git homest`,
        `nice env HOME=${alternateHome} git homest`,
        `timeout 5 env HOME=${alternateHome} git homest`,
      ]) {
        const safeWrappedAlias = runAdapter(
          proj,
          "guards",
          payload("preToolUseShell", proj, {
            conversation_id: "reviewer-safe-wrapped-git-environment-conversation",
            session_id: "reviewer-safe-wrapped-git-environment-conversation",
            tool_input: { command },
          }),
        );
        expectAllowJson(safeWrappedAlias, command);
      }

      const mainConversation = PAYLOADS.preToolUseTask.conversation_id;
      if (typeof mainConversation !== "string") {
        throw new Error("preToolUseTask fixture is missing conversation_id");
      }
      const safeClusterCommand = "env -i0 git status --short";
      const safeCluster = runAdapter(
        proj,
        "guards",
        payload("preToolUseShell", proj, {
          conversation_id: mainConversation,
          session_id: mainConversation,
          tool_input: { command: safeClusterCommand },
        }),
        { env: { HOME: alternateHome, XDG_CONFIG_HOME: undefined } },
      );
      expectAllowJson(safeCluster, safeClusterCommand);

      for (const command of [
        `env -a git HOME=${alternateHome} git homest`,
        `env --argv0 git HOME=${alternateHome} git homest`,
        `env --argv0=git HOME=${alternateHome} git homest`,
        `exec -a ignored env HOME=${alternateHome} git homest`,
        `command exec -a ignored env HOME=${alternateHome} git homest`,
        `xargs -d : env HOME=${alternateHome} git homest`,
        `xargs --delimiter : env HOME=${alternateHome} git homest`,
        `xargs --delimiter=: env HOME=${alternateHome} git homest`,
        `xargs --eof env HOME=${alternateHome} git homest`,
        `xargs --eof=STOP env HOME=${alternateHome} git homest`,
        `xargs --replace env HOME=${alternateHome} git homest`,
        `xargs --replace=TOKEN env HOME=${alternateHome} git homest`,
        `xargs --max-lines env HOME=${alternateHome} git homest`,
        `xargs --max-lines=1 env HOME=${alternateHome} git homest`,
        `xargs -L 1 env HOME=${alternateHome} git homest`,
        `xargs --process-slot-var SLOT env HOME=${alternateHome} git homest`,
        `xargs -J REPL env HOME=${alternateHome} git homest`,
        `xargs -rt --max-lines env HOME=${alternateHome} git homest`,
        `ENV.EXE HOME=${alternateHome} GIT.EXE homest`,
        `"C:/Program Files/Git/usr/bin/ENV.EXE" HOME=${alternateHome} "C:/Program Files/Git/cmd/GIT.EXE" homest`,
        `env -C/tmp HOME=${alternateHome} git homest`,
        `env -agit HOME=${alternateHome} git homest`,
        `env -i0 HOME=${alternateHome} git homest`,
      ]) {
        const safeArgv0Alias = runAdapter(
          proj,
          "guards",
          payload("preToolUseShell", proj, {
            conversation_id: mainConversation,
            session_id: mainConversation,
            tool_input: { command },
          }),
        );
        expectAllowJson(safeArgv0Alias, command);
      }
    } else {
      const envExe = "C:\\Program Files\\Git\\usr\\bin\\env.exe";
      const gitExe = "C:\\Program Files\\Git\\cmd\\git.exe";
      expect(existsSync(envExe)).toBe(true);
      expect(existsSync(gitExe)).toBe(true);
      const alternateHome = join(proj, "scratch", "windows-alternate-home");
      mkdirSync(alternateHome, { recursive: true });
      writeFileSync(
        join(alternateHome, ".gitconfig"),
        "[alias]\n  homepwn = !echo harmless | sh\n  homest = status --short\n",
      );
      const homeValue = alternateHome.replaceAll("\\", "/");
      for (const command of [
        `ENV.EXE HOME=${homeValue} GIT.EXE homepwn`,
        `"${envExe}" HOME=${homeValue} "${gitExe}" homepwn`,
      ]) {
        const dangerousExeWrapper = runAdapter(
          proj,
          "guards",
          payload("preToolUseShell", proj, {
            conversation_id: "reviewer-windows-exe-wrapper-conversation",
            session_id: "reviewer-windows-exe-wrapper-conversation",
            tool_input: { command },
          }),
        );
        const dangerousOut = JSON.parse(dangerousExeWrapper.stdout) as {
          permission?: string;
          agent_message?: string;
        };
        expect(dangerousOut.permission, command).toBe("deny");
        expect(dangerousOut.agent_message ?? "", command).toContain(
          "dynamic command evaluation",
        );
      }

      const mainConversation = PAYLOADS.preToolUseTask.conversation_id;
      if (typeof mainConversation !== "string") {
        throw new Error("preToolUseTask fixture is missing conversation_id");
      }
      for (const command of [
        `ENV.EXE HOME=${homeValue} GIT.EXE homest`,
        `"${envExe}" HOME=${homeValue} "${gitExe}" homest`,
      ]) {
        const safeExeWrapper = runAdapter(
          proj,
          "guards",
          payload("preToolUseShell", proj, {
            conversation_id: mainConversation,
            session_id: mainConversation,
            tool_input: { command },
          }),
        );
        expectAllowJson(safeExeWrapper, command);
      }
    }

    writeFileSync(
      join(proj, ".gitmodules"),
      `[submodule "status-fixture"]\n  path = ${submodulePath}\n  url = ./status-submodule\n`,
    );
    expect(
      spawnSync(
        "git",
        ["update-index", "--add", "--cacheinfo", "160000", submoduleHead, submodulePath],
        { cwd: proj },
      ).status,
    ).toBe(0);

    const recursiveStatusCommand = "git status --short --ignore-submodules=none";
    const recursiveStatus = runAdapter(
      proj,
      "guards",
      payload("preToolUseShell", proj, {
        conversation_id: "reviewer-submodule-status-conversation",
        session_id: "reviewer-submodule-status-conversation",
        tool_input: { command: recursiveStatusCommand },
      }),
    );
    const recursiveStatusOut = JSON.parse(recursiveStatus.stdout) as {
      permission?: string;
      agent_message?: string;
    };
    expect(recursiveStatusOut.permission).toBe("deny");
    expect(recursiveStatusOut.agent_message ?? "").toContain("dynamic command evaluation");

    const safeRestrictedStatus = "git status --short -- README.md";
    const safeRestrictedResult = runAdapter(
      proj,
      "guards",
      payload("preToolUseShell", proj, {
        conversation_id: "reviewer-safe-restricted-status-conversation",
        session_id: "reviewer-safe-restricted-status-conversation",
        tool_input: { command: safeRestrictedStatus },
      }),
    );
    expectAllowJson(safeRestrictedResult, safeRestrictedStatus);

    for (const command of [
      "git status --short README.md",
      "git status --short --untracked-files=no README.md",
      "git -C scratch status ordinary.txt",
    ]) {
      const safePositionalStatus = runAdapter(
        proj,
        "guards",
        payload("preToolUseShell", proj, {
          conversation_id: "reviewer-safe-positional-status-conversation",
          session_id: "reviewer-safe-positional-status-conversation",
          tool_input: { command },
        }),
      );
      expectAllowJson(safePositionalStatus, command);
    }

    const unsafeRestrictedStatus =
      `git status --short -- ${submodulePath}`;
    const unsafeRestrictedResult = runAdapter(
      proj,
      "guards",
      payload("preToolUseShell", proj, {
        conversation_id: "reviewer-unsafe-restricted-status-conversation",
        session_id: "reviewer-unsafe-restricted-status-conversation",
        tool_input: { command: unsafeRestrictedStatus },
      }),
    );
    const unsafeRestrictedOut = JSON.parse(unsafeRestrictedResult.stdout) as {
      permission?: string;
      agent_message?: string;
    };
    expect(unsafeRestrictedOut.permission).toBe("deny");
    expect(unsafeRestrictedOut.agent_message ?? "").toContain(
      "dynamic command evaluation",
    );

    for (const command of [
      `git status --short ${submodulePath}`,
      "git -C scratch status status-submodule",
    ]) {
      const unsafePositionalStatus = runAdapter(
        proj,
        "guards",
        payload("preToolUseShell", proj, {
          conversation_id: "reviewer-unsafe-positional-status-conversation",
          session_id: "reviewer-unsafe-positional-status-conversation",
          tool_input: { command },
        }),
      );
      const unsafePositionalOut = JSON.parse(unsafePositionalStatus.stdout) as {
        permission?: string;
        agent_message?: string;
      };
      expect(unsafePositionalOut.permission, command).toBe("deny");
      expect(unsafePositionalOut.agent_message ?? "", command).toContain(
        "dynamic command evaluation",
      );
    }

    writeFileSync(join(proj, "scratch", "ordinary.txt"), "safe\n");
    const nestedCwdStatus = "git -C scratch status -- status-submodule";
    const nestedCwdResult = runAdapter(
      proj,
      "guards",
      payload("preToolUseShell", proj, {
        conversation_id: "reviewer-nested-cwd-status-conversation",
        session_id: "reviewer-nested-cwd-status-conversation",
        tool_input: { command: nestedCwdStatus },
      }),
    );
    const nestedCwdOut = JSON.parse(nestedCwdResult.stdout) as {
      permission?: string;
      agent_message?: string;
    };
    expect(nestedCwdOut.permission).toBe("deny");
    expect(nestedCwdOut.agent_message ?? "").toContain("dynamic command evaluation");

    for (const command of [
      "git -C scratch status -- ordinary.txt",
      "git -C scratch status -- ':(top)README.md'",
    ]) {
      const safeNestedCwd = runAdapter(
        proj,
        "guards",
        payload("preToolUseShell", proj, {
          conversation_id: "reviewer-safe-nested-cwd-status-conversation",
          session_id: "reviewer-safe-nested-cwd-status-conversation",
          tool_input: { command },
        }),
      );
      expectAllowJson(safeNestedCwd, command);
    }

    const workingDirectoryStatus = "git status -- status-submodule";
    const workingDirectoryResult = runAdapter(
      proj,
      "guards",
      payload("preToolUseShell", proj, {
        conversation_id: "reviewer-working-directory-status-conversation",
        session_id: "reviewer-working-directory-status-conversation",
        tool_input: {
          command: workingDirectoryStatus,
          working_directory: join(proj, "scratch"),
        },
      }),
    );
    const workingDirectoryOut = JSON.parse(workingDirectoryResult.stdout) as {
      permission?: string;
      agent_message?: string;
    };
    expect(workingDirectoryOut.permission).toBe("deny");
    expect(workingDirectoryOut.agent_message ?? "").toContain(
      "dynamic command evaluation",
    );

    const safeWorkingDirectoryStatus = "git status -- ordinary.txt";
    const safeWorkingDirectoryResult = runAdapter(
      proj,
      "guards",
      payload("preToolUseShell", proj, {
        conversation_id: "reviewer-safe-working-directory-status-conversation",
        session_id: "reviewer-safe-working-directory-status-conversation",
        tool_input: {
          command: safeWorkingDirectoryStatus,
          working_directory: join(proj, "scratch"),
        },
      }),
    );
    expectAllowJson(safeWorkingDirectoryResult, safeWorkingDirectoryStatus);

    const conflictingStatusCommand =
      "git status --short --ignore-submodules=all --ignore-submodules=none";
    const conflictingStatus = runAdapter(
      proj,
      "guards",
      payload("preToolUseShell", proj, {
        conversation_id: "reviewer-conflicting-submodule-status-conversation",
        session_id: "reviewer-conflicting-submodule-status-conversation",
        tool_input: { command: conflictingStatusCommand },
      }),
    );
    const conflictingStatusOut = JSON.parse(conflictingStatus.stdout) as {
      permission?: string;
      agent_message?: string;
    };
    expect(conflictingStatusOut.permission).toBe("deny");
    expect(conflictingStatusOut.agent_message ?? "").toContain("dynamic command evaluation");

    const disguisedStatusCommand =
      "git status --short -- scratch --ignore-submodules=all";
    const disguisedStatus = runAdapter(
      proj,
      "guards",
      payload("preToolUseShell", proj, {
        conversation_id: "reviewer-disguised-submodule-status-conversation",
        session_id: "reviewer-disguised-submodule-status-conversation",
        tool_input: { command: disguisedStatusCommand },
      }),
    );
    const disguisedStatusOut = JSON.parse(disguisedStatus.stdout) as {
      permission?: string;
      agent_message?: string;
    };
    expect(disguisedStatusOut.permission).toBe("deny");
    expect(disguisedStatusOut.agent_message ?? "").toContain("dynamic command evaluation");

    const ignoredSubmoduleStatus =
      "git status --short --ignore-submodules=all";
    const safeIgnoredStatus = runAdapter(
      proj,
      "guards",
      payload("preToolUseShell", proj, {
        conversation_id: "reviewer-safe-submodule-status-conversation",
        session_id: "reviewer-safe-submodule-status-conversation",
        tool_input: { command: ignoredSubmoduleStatus },
      }),
    );
    expectAllowJson(safeIgnoredStatus, ignoredSubmoduleStatus);

    const safeConflictingStatus =
      "git status --short --ignore-submodules=none --ignore-submodules=all";
    const safeEffectiveStatus = runAdapter(
      proj,
      "guards",
      payload("preToolUseShell", proj, {
        conversation_id: "reviewer-safe-effective-submodule-status-conversation",
        session_id: "reviewer-safe-effective-submodule-status-conversation",
        tool_input: { command: safeConflictingStatus },
      }),
    );
    expectAllowJson(safeEffectiveStatus, safeConflictingStatus);

    rmSync(join(proj, ".gitmodules"), { force: true });
    const manifestlessStatus =
      "git status --short --ignore-submodules=none";
    const manifestlessResult = runAdapter(
      proj,
      "guards",
      payload("preToolUseShell", proj, {
        conversation_id: "reviewer-manifestless-gitlink-status-conversation",
        session_id: "reviewer-manifestless-gitlink-status-conversation",
        tool_input: { command: manifestlessStatus },
      }),
    );
    const manifestlessOut = JSON.parse(manifestlessResult.stdout) as {
      permission?: string;
      agent_message?: string;
    };
    expect(manifestlessOut.permission).toBe("deny");
    expect(manifestlessOut.agent_message ?? "").toContain("dynamic command evaluation");

    expect(
      spawnSync("git", ["update-index", "--force-remove", submodulePath], {
        cwd: proj,
      }).status,
    ).toBe(0);
    writeFileSync(
      join(proj, ".gitmodules"),
      `[submodule "stale-status-fixture"]\n  path = ${submodulePath}\n  url = ./status-submodule\n`,
    );
    const staleManifestStatus =
      "git status --short --ignore-submodules=none";
    const staleManifestResult = runAdapter(
      proj,
      "guards",
      payload("preToolUseShell", proj, {
        conversation_id: "reviewer-stale-submodule-manifest-conversation",
        session_id: "reviewer-stale-submodule-manifest-conversation",
        tool_input: { command: staleManifestStatus },
      }),
    );
    expectAllowJson(staleManifestResult, staleManifestStatus);
  }, 55_000);

  test("30: existing symlink or junction aliases cannot hide protected attribution paths", () => {
    const proj = installedProject();
    const { record } = activateReviewer(proj);
    const protectedAlias = join(proj, "protected-review-alias");
    symlinkSync(record, protectedAlias, process.platform === "win32" ? "junction" : "dir");
    const aliasedRemoval =
      `shred -u ${join(protectedAlias, ".aidlc-reviewer-dispatch.jso")}*`;
    const removal = runAdapter(
      proj,
      "guards",
      payload("preToolUseShell", proj, {
        conversation_id: "reviewer-path-alias-conversation",
        session_id: "reviewer-path-alias-conversation",
        tool_input: { command: aliasedRemoval },
      }),
    );
    const out = JSON.parse(removal.stdout) as {
      permission?: string;
      agent_message?: string;
    };
    expect(out.permission).toBe("deny");
    expect(out.agent_message ?? "").toContain("attribution state");

    const safeDir = join(proj, "scratch", "safe-target");
    mkdirSync(safeDir, { recursive: true });
    const safeAlias = join(proj, "safe-review-alias");
    symlinkSync(safeDir, safeAlias, process.platform === "win32" ? "junction" : "dir");
    const safe = runAdapter(
      proj,
      "guards",
      payload("preToolUseShell", proj, {
        conversation_id: "reviewer-safe-path-alias-conversation",
        session_id: "reviewer-safe-path-alias-conversation",
        tool_input: { command: `shred -u ${join(safeAlias, "ordinary")}*` },
      }),
    );
    expectAllowJson(safe);
  });

  test("31: Windows device, 8.3, trailing-alias, and Git-Bash paths are canonicalized", () => {
    if (process.platform !== "win32") return;
    const proj = installedProject();
    const { dispatch } = activateReviewer(proj);
    const short = spawnSync(
      process.env.ComSpec ?? "cmd.exe",
      ["/d", "/c", `for %I in ("${dirname(dispatch)}") do @echo %~sI`],
      { encoding: "utf-8" },
    );
    expect(short.status).toBe(0);
    const shortDir = short.stdout.trim();
    expect(shortDir.length).toBeGreaterThan(0);
    expect(shortDir.toLowerCase()).not.toBe(dirname(dispatch).toLowerCase());
    const shortFileResult = spawnSync(
      process.env.ComSpec ?? "cmd.exe",
      ["/d", "/c", `for %I in ("${dispatch}") do @echo %~sI`],
      { encoding: "utf-8" },
    );
    expect(shortFileResult.status).toBe(0);
    const shortFile = shortFileResult.stdout.trim();
    expect(shortFile.length).toBeGreaterThan(0);
    expect(basename(shortFile).toLowerCase()).not.toBe(basename(dispatch).toLowerCase());
    const nativeProject = win32.normalize(proj);
    const projectParent = dirname(nativeProject);
    const wildcardProject =
      `${basename(nativeProject).replace(/^[ .]+/, "").replace(/[ .]/g, "").slice(0, 6).toUpperCase()}~?`;

    const protectedTargets = [
      `${windowsGitBashPath(dispatch.slice(0, -1))}*`,
      `\\\\?\\${dispatch.slice(0, -1)}*`,
      join(dirname(dispatch), ".AIDLC-REVIEWER-DISPATCH.JSON. "),
      `${join(shortDir, basename(dispatch).slice(0, -1))}*`,
      `${shortFile.slice(0, -1)}*`,
      join(
        projectParent,
        wildcardProject,
        `${relative(proj, dispatch).slice(0, -1)}*`,
      ),
    ];
    for (const target of protectedTargets) {
      const removal = runAdapter(
        proj,
        "guards",
        payload("preToolUseShell", proj, {
          conversation_id: "reviewer-windows-alias-conversation",
          session_id: "reviewer-windows-alias-conversation",
          tool_input: { command: `del /q ${target}` },
        }),
      );
      const out = JSON.parse(removal.stdout) as {
        permission?: string;
        agent_message?: string;
      };
      expect(out.permission, target).toBe("deny");
      expect(out.agent_message ?? "", target).toContain("attribution state");
    }

    const safePath = join(proj, "scratch", "native-safe.txt");
    mkdirSync(dirname(safePath), { recursive: true });
    writeFileSync(safePath, "safe\n");
    const safeCommand = `del /q ${safePath}`;
    const safe = runAdapter(
      proj,
      "guards",
      payload("preToolUseShell", proj, {
        conversation_id: "reviewer-native-safe-path-conversation",
        session_id: "reviewer-native-safe-path-conversation",
        tool_input: { command: safeCommand },
      }),
    );
    expectAllowJson(safe, safeCommand);
    const executed = spawnSync(
      process.env.ComSpec ?? "cmd.exe",
      ["/d", "/c", safeCommand],
      { encoding: "utf-8" },
    );
    expect(executed.status, executed.stderr).toBe(0);
    expect(existsSync(safePath)).toBe(false);

    const safeDirectory = join(proj, "scratch", "quoted-safe-directory");
    mkdirSync(safeDirectory, { recursive: true });
    for (const command of [
      `dir ${safeDirectory}\\`,
      `dir "${safeDirectory}\\"`,
    ]) {
      const directoryRead = runAdapter(
        proj,
        "guards",
        payload("preToolUseShell", proj, {
          conversation_id: "reviewer-safe-trailing-directory-conversation",
          session_id: "reviewer-safe-trailing-directory-conversation",
          tool_input: { command },
        }),
      );
      expectAllowJson(directoryRead, command);
    }

    const safeShortGlob = join(proj, "ORDINA~1.*");
    const safeShortRemoval = runAdapter(
      proj,
      "guards",
      payload("preToolUseShell", proj, {
        conversation_id: "reviewer-safe-short-name-conversation",
        session_id: "reviewer-safe-short-name-conversation",
        tool_input: { command: `del /q ${safeShortGlob}` },
      }),
    );
    expectAllowJson(safeShortRemoval, safeShortGlob);

    const safeAncestorGlob = join(projectParent, "ORDINA~?", "ordinary.txt");
    const safeAncestorRemoval = runAdapter(
      proj,
      "guards",
      payload("preToolUseShell", proj, {
        conversation_id: "reviewer-safe-short-ancestor-conversation",
        session_id: "reviewer-safe-short-ancestor-conversation",
        tool_input: { command: `del /q ${safeAncestorGlob}` },
      }),
    );
    expectAllowJson(safeAncestorRemoval, safeAncestorGlob);
  }, 20_000);

  test("32: native and mixed UNC wildcard paths retain their protected root", () => {
    if (process.platform !== "win32") return;
    const localProject = installedProject();
    const project = windowsAdminUnc(localProject);
    expect(existsSync(project)).toBe(true);
    seedStateFile(project, "state-construction.md");
    const record = seededRecordDir(project);
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
    mkdirSync(ledgerDirFor(project), { recursive: true });
    writeFileSync(
      join(ledgerDirFor(project), "spawn-unc-reviewer.json"),
      JSON.stringify({
        agent: "aidlc-architecture-reviewer-agent",
        parent: "unc-parent",
        task: "unc-review",
      }),
    );
    for (const target of [
      `${dispatch.slice(0, -1)}*`,
      `${withMixedUncSeparators(dispatch.slice(0, -1))}*`,
    ]) {
      const removal = runAdapter(
        project,
        "guards",
        payload("preToolUseShell", project, {
          conversation_id: "reviewer-unc-path-conversation",
          session_id: "reviewer-unc-path-conversation",
          tool_input: { command: `del /q ${target}` },
        }),
        { adapterProjectDir: localProject, cwd: localProject },
      );
      const out = JSON.parse(removal.stdout) as {
        permission?: string;
        agent_message?: string;
      };
      expect(out.permission, target).toBe("deny");
      expect(out.agent_message ?? "", target).toContain("attribution state");
    }
  }, 20_000);

  test("33: POSIX and PowerShell home aliases resolve before protected-path comparison", () => {
    const proj = installedProject();
    const { dispatch } = activateReviewer(proj);
    const relative = dispatch.slice(proj.length + 1);
    const protectedTarget =
      process.platform === "win32"
        ? `~\\${relative.replaceAll("/", "\\").slice(0, -1)}*`
        : `~/${relative.slice(0, -1)}*`;
    const command =
      process.platform === "win32"
        ? `Remove-Item ${protectedTarget}`
        : `shred -u ${protectedTarget}`;
    const removal = runAdapter(
      proj,
      "guards",
      payload("preToolUseShell", proj, {
        conversation_id: "reviewer-home-alias-conversation",
        session_id: "reviewer-home-alias-conversation",
        tool_input: { command },
      }),
      {
        env: {
          HOME: proj,
          USERPROFILE: proj,
        },
      },
    );
    const out = JSON.parse(removal.stdout) as {
      permission?: string;
      agent_message?: string;
    };
    expect(out.permission).toBe("deny");
    expect(out.agent_message ?? "").toContain("attribution state");

    if (process.platform !== "win32") {
      for (const currentTargetCommand of [
        `shred -u ~+/${relative.slice(0, -1)}*`,
        "find ~+/aidlc/.aidlc-cursor-subagent* -depth -delete",
        `shred -u ~-/${relative.slice(0, -1)}*`,
        "find ~-/aidlc/.aidlc-cursor-subagent* -depth -delete",
      ]) {
        const currentTarget = runAdapter(
          proj,
          "guards",
          payload("preToolUseShell", proj, {
            conversation_id: "reviewer-current-directory-alias-conversation",
            session_id: "reviewer-current-directory-alias-conversation",
            tool_input: { command: currentTargetCommand },
          }),
          {
            env: {
              HOME: proj,
              OLDPWD: proj,
              USERPROFILE: proj,
            },
          },
        );
        const currentOut = JSON.parse(currentTarget.stdout) as {
          permission?: string;
          agent_message?: string;
        };
        expect(currentOut.permission, currentTargetCommand).toBe("deny");
        expect(currentOut.agent_message ?? "", currentTargetCommand).toContain(
          "attribution state",
        );
      }
    }

    const safeTarget =
      process.platform === "win32" ? "~\\scratch\\ordinary*" : "~/scratch/ordinary*";
    const safeCommand =
      process.platform === "win32" ? `Remove-Item ${safeTarget}` : `shred -u ${safeTarget}`;
    const safe = runAdapter(
      proj,
      "guards",
      payload("preToolUseShell", proj, {
        conversation_id: "reviewer-safe-home-alias-conversation",
        session_id: "reviewer-safe-home-alias-conversation",
        tool_input: { command: safeCommand },
      }),
      {
        env: {
          HOME: proj,
          USERPROFILE: proj,
        },
      },
    );
    expectAllowJson(safe, safeCommand);

    if (process.platform !== "win32") {
      const safeCurrentCommand = "shred -u ~+/scratch/ordinary*";
      const safeCurrent = runAdapter(
        proj,
        "guards",
        payload("preToolUseShell", proj, {
          conversation_id: "reviewer-safe-current-directory-alias-conversation",
          session_id: "reviewer-safe-current-directory-alias-conversation",
          tool_input: { command: safeCurrentCommand },
        }),
      );
      expectAllowJson(safeCurrent, safeCurrentCommand);

      const safeOldCommand = "shred -u ~-/scratch/ordinary*";
      const safeOld = runAdapter(
        proj,
        "guards",
        payload("preToolUseShell", proj, {
          conversation_id: "reviewer-safe-old-directory-alias-conversation",
          session_id: "reviewer-safe-old-directory-alias-conversation",
          tool_input: { command: safeOldCommand },
        }),
        { env: { OLDPWD: proj } },
      );
      expectAllowJson(safeOld, safeOldCommand);

      const username = process.env.USER ?? process.env.LOGNAME;
      const actualHome = process.env.HOME;
      expect(username).toBeTruthy();
      expect(actualHome).toBeTruthy();
      const namedAlias = join(
        actualHome ?? "",
        `aidlc-t276-named-${basename(proj)}`,
      );
      symlinkSync(proj, namedAlias, "dir");
      scratch.push(namedAlias);
      const namedProtected =
        `shred -u ~${username}/${basename(namedAlias)}/${relative.slice(0, -1)}*`;
      const namedRemoval = runAdapter(
        proj,
        "guards",
        payload("preToolUseShell", proj, {
          conversation_id: "reviewer-named-home-alias-conversation",
          session_id: "reviewer-named-home-alias-conversation",
          tool_input: { command: namedProtected },
        }),
      );
      const namedOut = JSON.parse(namedRemoval.stdout) as {
        permission?: string;
        agent_message?: string;
      };
      expect(namedOut.permission).toBe("deny");
      expect(namedOut.agent_message ?? "").toContain("attribution state");

      const namedSafe =
        `shred -u ~${username}/${basename(namedAlias)}/scratch/ordinary*`;
      const safeNamedRemoval = runAdapter(
        proj,
        "guards",
        payload("preToolUseShell", proj, {
          conversation_id: "reviewer-safe-named-home-alias-conversation",
          session_id: "reviewer-safe-named-home-alias-conversation",
          tool_input: { command: namedSafe },
        }),
      );
      expectAllowJson(safeNamedRemoval, namedSafe);
    }
  });

  test("34: shell-internal directory changes rebase later path operands", () => {
    const proj = installedProject();
    const { dispatch } = activateReviewer(proj);
    const aidlcDir = join(proj, "aidlc");
    const relativeDispatch = relative(aidlcDir, dispatch);
    const projectRelativeDispatch = relative(proj, dispatch);
    const commands =
      process.platform === "win32"
        ? [
            `cd /d aidlc && del /q ${relativeDispatch.slice(0, -1)}*`,
            "pushd aidlc && del /q .aidlc-cursor-subagent*",
            `Set-Location aidlc; Remove-Item ${relativeDispatch.slice(0, -1)}*`,
            `cd /d no-such-dir || del /q ${projectRelativeDispatch.slice(0, -1)}*`,
            `cd /d aidlc || echo unchanged\ndel /q ${relativeDispatch.slice(0, -1)}*`,
            `cd /d aidlc || cd /d scratch\ndel /q ${relativeDispatch.slice(0, -1)}*`,
            `cd /d aidlc | del /q ${projectRelativeDispatch.slice(0, -1)}*`,
            `(cd /d scratch) & del /q ${projectRelativeDispatch.slice(0, -1)}*`,
            `if (Test-Path aidlc) { Set-Location aidlc }; Remove-Item ${relativeDispatch.slice(0, -1)}*`,
          ]
        : [
            `cd aidlc; shred -u ${relativeDispatch.slice(0, -1)}*`,
            "pushd aidlc; find .aidlc-cursor-subagent* -depth -delete",
            `cd no-such-dir || shred -u ${projectRelativeDispatch.slice(0, -1)}*`,
            `cd aidlc || true; shred -u ${relativeDispatch.slice(0, -1)}*`,
            `cd aidlc || cd scratch; shred -u ${relativeDispatch.slice(0, -1)}*`,
            `cd aidlc | shred -u ${projectRelativeDispatch.slice(0, -1)}*`,
            `(cd scratch); shred -u ${projectRelativeDispatch.slice(0, -1)}*`,
            `if cd aidlc; then shred -u ${relativeDispatch.slice(0, -1)}*; fi`,
            `if true; then cd aidlc; fi; shred -u ${relativeDispatch.slice(0, -1)}*`,
            `case x in x) cd aidlc;; esac; shred -u ${relativeDispatch.slice(0, -1)}*`,
            `f(){ cd aidlc; }; f; shred -u ${relativeDispatch.slice(0, -1)}*`,
            `builtin cd aidlc; shred -u ${relativeDispatch.slice(0, -1)}*`,
            "builtin -- pushd aidlc; find .aidlc-cursor-subagent* -depth -delete",
          ];
    for (const command of commands) {
      const removal = runAdapter(
        proj,
        "guards",
        payload("preToolUseShell", proj, {
          conversation_id: "reviewer-shell-cwd-conversation",
          session_id: "reviewer-shell-cwd-conversation",
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

    const scratchDir = join(proj, "scratch");
    mkdirSync(scratchDir, { recursive: true });
    const safeCommand =
      process.platform === "win32"
        ? "cd /d scratch && del /q ordinary.txt"
        : "cd scratch; rm -f ordinary.txt";
    const safe = runAdapter(
      proj,
      "guards",
      payload("preToolUseShell", proj, {
        conversation_id: "reviewer-safe-shell-cwd-conversation",
        session_id: "reviewer-safe-shell-cwd-conversation",
        tool_input: { command: safeCommand },
      }),
    );
    expectAllowJson(safe, safeCommand);

    const safeFailedCommand =
      process.platform === "win32"
        ? "cd /d no-such-dir || del /q scratch\\ordinary.txt"
        : "cd no-such-dir || rm -f scratch/ordinary.txt";
    const safeFailed = runAdapter(
      proj,
      "guards",
      payload("preToolUseShell", proj, {
        conversation_id: "reviewer-safe-failed-shell-cwd-conversation",
        session_id: "reviewer-safe-failed-shell-cwd-conversation",
        tool_input: { command: safeFailedCommand },
      }),
    );
    expectAllowJson(safeFailed, safeFailedCommand);

    for (const command of process.platform === "win32"
      ? [
          "cd /d scratch || echo unchanged\ndel /q ordinary.txt",
          "cd /d no-such-dir || cd /d scratch\ndel /q ordinary.txt",
        ]
      : [
          "cd scratch || true; rm -f ordinary.txt",
          "cd no-such-dir || cd scratch; rm -f ordinary.txt",
        ]) {
      const safeConditional = runAdapter(
        proj,
        "guards",
        payload("preToolUseShell", proj, {
          conversation_id: "reviewer-safe-conditional-shell-cwd-conversation",
          session_id: "reviewer-safe-conditional-shell-cwd-conversation",
          tool_input: { command },
        }),
      );
      expectAllowJson(safeConditional, command);
    }

    const branchPrefix = Array.from({ length: 25 }, (_, index) =>
      process.platform === "win32"
        ? `cd /d missing-${index}`
        : `cd missing-${index}`
    ).join("; ");
    const branchedSafeCommand =
      process.platform === "win32"
        ? `${branchPrefix}; del /q scratch\\ordinary.txt`
        : `${branchPrefix}; rm -f scratch/ordinary.txt`;
    const branchedSafe = runAdapter(
      proj,
      "guards",
      payload("preToolUseShell", proj, {
        conversation_id: "reviewer-safe-branched-shell-cwd-conversation",
        session_id: "reviewer-safe-branched-shell-cwd-conversation",
        tool_input: { command: branchedSafeCommand },
      }),
    );
    expectAllowJson(branchedSafe, branchedSafeCommand);

    const successfulDirs = Array.from({ length: 25 }, (_, index) =>
      join(proj, "scratch", `existing-${index}`)
    );
    for (const dir of successfulDirs) mkdirSync(dir, { recursive: true });
    const successfulPrefix = successfulDirs
      .map((dir) =>
        process.platform === "win32"
          ? `cd /d ${dir}`
          : `cd ${dir}`
      )
      .join("; ");
    const successfulSafeCommand =
      process.platform === "win32"
        ? `${successfulPrefix}; del /q ${join(proj, "scratch", "ordinary.txt")}`
        : `${successfulPrefix}; rm -f ${join(proj, "scratch", "ordinary.txt")}`;
    const successfulSafe = runAdapter(
      proj,
      "guards",
      payload("preToolUseShell", proj, {
        conversation_id: "reviewer-safe-successful-cwd-chain-conversation",
        session_id: "reviewer-safe-successful-cwd-chain-conversation",
        tool_input: { command: successfulSafeCommand },
      }),
    );
    expectAllowJson(successfulSafe, successfulSafeCommand);

    const hubAliases = Array.from({ length: 25 }, (_, index) => `cwd-hub-${index}`);
    for (const alias of hubAliases) {
      symlinkSync(
        process.platform === "win32" ? proj : ".",
        join(proj, alias),
        process.platform === "win32" ? "junction" : "dir",
      );
    }
    const hubPrefix =
      process.platform === "win32"
        ? hubAliases.map((alias) => `if exist ${alias} cd /d ${alias}`).join("\n")
        : hubAliases.map((alias) => `if true; then cd ${alias}; fi`).join("; ");
    const hubSafeCommand =
      process.platform === "win32"
        ? `${hubPrefix}\ndel /q scratch\\ordinary.txt`
        : `${hubPrefix}; rm -f scratch/ordinary.txt`;
    const hubStartedAt = Date.now();
    const hubSafe = runAdapter(
      proj,
      "guards",
      payload("preToolUseShell", proj, {
        conversation_id: "reviewer-safe-symlink-cwd-hub-conversation",
        session_id: "reviewer-safe-symlink-cwd-hub-conversation",
        tool_input: { command: hubSafeCommand },
      }),
    );
    expectAllowJson(hubSafe, hubSafeCommand);
    expect(Date.now() - hubStartedAt).toBeLessThan(5_000);

    if (process.platform !== "win32") {
      const safeFunctionCommand = "f(){ cd aidlc; }; rm -f scratch/ordinary.txt";
      const safeFunction = runAdapter(
        proj,
        "guards",
        payload("preToolUseShell", proj, {
          conversation_id: "reviewer-safe-function-cwd-conversation",
          session_id: "reviewer-safe-function-cwd-conversation",
          tool_input: { command: safeFunctionCommand },
        }),
      );
      expectAllowJson(safeFunction, safeFunctionCommand);

      const safeBuiltinCommand = "builtin cd scratch; rm -f ordinary.txt";
      const safeBuiltin = runAdapter(
        proj,
        "guards",
        payload("preToolUseShell", proj, {
          conversation_id: "reviewer-safe-builtin-cwd-conversation",
          session_id: "reviewer-safe-builtin-cwd-conversation",
          tool_input: { command: safeBuiltinCommand },
        }),
      );
      expectAllowJson(safeBuiltin, safeBuiltinCommand);
    }
  }, 15_000);

  test("35: Git inspection follows reachable compound-command cwd state", () => {
    const proj = installedProject();
    activateReviewer(proj);
    const unsafe = join(proj, "scratch", "unsafe-git-cwd");
    mkdirSync(unsafe, { recursive: true });
    expect(spawnSync("git", ["init"], { cwd: unsafe }).status).toBe(0);
    const helper = join(
      proj,
      "scratch",
      process.platform === "win32" ? "fsmonitor-helper.cmd" : "fsmonitor-helper",
    );
    writeFileSync(
      helper,
      process.platform === "win32"
        ? "@echo off\r\nexit /b 0\r\n"
        : "#!/bin/sh\nexit 0\n",
    );
    if (process.platform !== "win32") chmodSync(helper, 0o755);
    expect(
      spawnSync("git", ["config", "core.fsmonitor", helper], {
        cwd: unsafe,
      }).status,
    ).toBe(0);

    const relativeUnsafe = relative(proj, unsafe);
    const denied =
      process.platform === "win32"
        ? [
            `cd /d ${JSON.stringify(relativeUnsafe)} && git status --short`,
            `Set-Location ${JSON.stringify(relativeUnsafe)}; git status --short`,
            `if (Test-Path ${JSON.stringify(relativeUnsafe)}) { Set-Location ${JSON.stringify(relativeUnsafe)} }; git status --short`,
          ]
        : [
            `cd ${JSON.stringify(relativeUnsafe)}; git status --short`,
            `cd ${JSON.stringify(relativeUnsafe)} && git status --short`,
            `builtin cd ${JSON.stringify(relativeUnsafe)}; git status --short`,
            `if true; then cd ${JSON.stringify(relativeUnsafe)}; fi; git status --short`,
          ];
    for (const command of denied) {
      const result = runAdapter(
        proj,
        "guards",
        payload("preToolUseShell", proj, {
          conversation_id: "reviewer-compound-git-cwd",
          session_id: "reviewer-compound-git-cwd",
          tool_input: { command },
        }),
      );
      const out = JSON.parse(result.stdout) as {
        permission?: string;
        agent_message?: string;
      };
      expect(out.permission, command).toBe("deny");
      expect(out.agent_message ?? "", command).toContain(
        "dynamic command evaluation",
      );
    }

    const allowed =
      process.platform === "win32"
        ? [
            "cd /d no-such-dir && git status --short",
            "cd /d no-such-dir || git status --short",
          ]
        : [
            "cd no-such-dir && git status --short",
            "cd no-such-dir || git status --short",
            `cd ${JSON.stringify(relativeUnsafe)} | git status --short`,
            `(cd ${JSON.stringify(relativeUnsafe)}); git status --short`,
          ];
    for (const command of allowed) {
      const result = runAdapter(
        proj,
        "guards",
        payload("preToolUseShell", proj, {
          conversation_id: "reviewer-safe-compound-git-cwd",
          session_id: "reviewer-safe-compound-git-cwd",
          tool_input: { command },
        }),
      );
      expectAllowJson(result, command);
    }
  });

  test("36: find traversal cannot erase delegated-agent attribution stores", () => {
    const proj = installedProject();
    seedStateFile(proj, "state-construction.md");
    clearLedger(proj);
    registerTaskParent(proj);
    const spawn = runAdapter(
      proj,
      "guards",
      payload("preToolUseTask", proj, {
        tool_input: {
          description: "Developer probe",
          prompt: "Implement the unit.",
          subagent_type: "aidlc-developer-agent",
        },
      }),
    );
    expectAllowJson(spawn);
    expect(ledgerFilesFor(proj)).toHaveLength(1);
    expect(witnessFilesFor(proj)).toHaveLength(1);

    for (const command of [
      "find aidlc -depth -delete",
      "find aidlc -exec rm -rf {} +",
      "find aidlc -execdir rm -rf {} +",
      "find aidlc -print0 | xargs -0 rm -rf",
      "Remove-Item aidlc -Recurse -Force",
      "Remove-Item -Path:aidlc -Recurse -Force",
      "Move-Item aidlc scratch",
      "rd /s /q aidlc",
      "rsync --delete scratch/ aidlc",
    ]) {
      const removal = runAdapter(
        proj,
        "guards",
        payload("preToolUseShell", proj, {
          conversation_id: "developer-find-child",
          session_id: "developer-find-child",
          tool_input: { command },
        }),
      );
      const out = JSON.parse(removal.stdout) as {
        permission?: string;
        agent_message?: string;
      };
      expect(out.permission, command).toBe("deny");
      expect(out.agent_message ?? "", command).toContain("attribution state");
      expect(ledgerFilesFor(proj), command).toHaveLength(1);
      expect(witnessFilesFor(proj), command).toHaveLength(1);
    }

    mkdirSync(join(proj, "scratch"), { recursive: true });
    for (const command of [
      "find scratch -depth -delete",
      "Remove-Item scratch -Recurse -Force",
      "Move-Item scratch ordinary",
      "rsync --delete scratch/ ordinary",
    ]) {
      const safe = runAdapter(
        proj,
        "guards",
        payload("preToolUseShell", proj, {
          conversation_id: "developer-find-child",
          session_id: "developer-find-child",
          tool_input: { command },
        }),
      );
      expectAllowJson(safe, command);
    }

    const nested = runAdapter(
      proj,
      "guards",
      payload("preToolUseTask", proj, {
        conversation_id: "developer-find-child",
        session_id: "developer-find-child",
        generation_id: "find-nested-generation",
        tool_use_id: "find-nested-tool-use",
        tool_input: {
          description: "Nested probe",
          prompt: "Delegate again.",
          subagent_type: "aidlc-quality-agent",
        },
      }),
    );
    const nestedOut = JSON.parse(nested.stdout) as {
      permission?: string;
      agent_message?: string;
    };
    expect(nestedOut.permission).toBe("deny");
    expect(nestedOut.agent_message ?? "").toContain(
      "nested delegation is not allowed",
    );
  });

  test("37: delegated executable lookup and data-driven mutators cannot erase attribution stores", () => {
    const proj = installedProject();
    seedStateFile(proj, "state-construction.md");
    clearLedger(proj);
    registerTaskParent(proj);
    const spawn = runAdapter(
      proj,
      "guards",
      payload("preToolUseTask", proj, {
        tool_input: {
          description: "Developer probe",
          prompt: "Implement the unit.",
          subagent_type: "aidlc-developer-agent",
        },
      }),
    );
    expectAllowJson(spawn);
    const [witness] = witnessFilesFor(proj);
    expect(ledgerFilesFor(proj)).toHaveLength(1);
    expect(witness).toBeDefined();

    const scriptDir = join(proj, "scratch");
    mkdirSync(scriptDir, { recursive: true });
    const script = join(
      scriptDir,
      process.platform === "win32" ? "wipe-attribution.cmd" : "wipe-attribution",
    );
    const destructiveBody =
      process.platform === "win32"
        ? `@echo off\r\nrmdir /s /q "${ledgerDirFor(proj)}"\r\ndel /q "${witness}"\r\n`
        : `#!/bin/sh\n/bin/rm -rf ${JSON.stringify(ledgerDirFor(proj))}\n/bin/rm -f ${JSON.stringify(witness)}\n`;
    writeFileSync(script, destructiveBody);
    if (process.platform !== "win32") chmodSync(script, 0o755);

    const command =
      process.platform === "win32"
        ? "scratch\\wipe-attribution.cmd"
        : "./scratch/wipe-attribution";
    const execution = runAdapter(
      proj,
      "guards",
      payload("preToolUseShell", proj, {
        conversation_id: "developer-project-executable-child",
        session_id: "developer-project-executable-child",
        tool_input: { command },
      }),
    );
    const executionOut = JSON.parse(execution.stdout) as {
      permission?: string;
      agent_message?: string;
    };
    if (executionOut.permission === "allow") {
      const result =
        process.platform === "win32"
          ? spawnSync(
              process.env.ComSpec ?? "cmd.exe",
              [
                "/d",
                "/s",
                "/c",
                `"${script}"`,
              ],
              { encoding: "utf-8" },
            )
          : spawnSync(script, [], { encoding: "utf-8" });
      expect(result.status, result.stderr).toBe(0);
    }
    expect(executionOut.permission).toBe("deny");
    expect(executionOut.agent_message ?? "").toContain(
      "general-purpose interpreters",
    );
    expect(ledgerFilesFor(proj)).toHaveLength(1);
    expect(witnessFilesFor(proj)).toHaveLength(1);

    const shadowedRg = join(
      scriptDir,
      process.platform === "win32" ? "rg.cmd" : "rg",
    );
    writeFileSync(shadowedRg, destructiveBody);
    if (process.platform !== "win32") chmodSync(shadowedRg, 0o755);
    const resolutionCommands = [
      `env PATH=${JSON.stringify(scriptDir)} rg`,
      `PATH=${JSON.stringify(scriptDir)} rg`,
      `PATH=${JSON.stringify(scriptDir)}; rg`,
      `env PaTh=${JSON.stringify(scriptDir)} rg`,
      "env PATHEXT=.CMD rg",
      "env -uPATH rg",
      "env --unset=PATH rg",
      "env -i rg",
      "env -i0 rg",
      "env --ignore-environment rg",
      "nice env -i rg",
    ];
    for (const [index, unsafeCommand] of resolutionCommands.entries()) {
      const denied = runAdapter(
        proj,
        "guards",
        payload("preToolUseShell", proj, {
          conversation_id: "developer-project-executable-child",
          session_id: "developer-project-executable-child",
          tool_input: { command: unsafeCommand },
        }),
      );
      const deniedOut = JSON.parse(denied.stdout) as {
        permission?: string;
        agent_message?: string;
      };
      if (deniedOut.permission === "allow" && index === 0) {
        const result =
          process.platform === "win32"
            ? spawnSync(
                process.env.ComSpec ?? "cmd.exe",
                ["/d", "/s", "/c", "rg"],
                {
                  cwd: proj,
                  encoding: "utf-8",
                  env: {
                    ...process.env,
                    PATH: scriptDir,
                    PATHEXT: ".CMD",
                  },
                },
              )
            : spawnSync("rg", [], {
                cwd: proj,
                encoding: "utf-8",
                env: { ...process.env, PATH: scriptDir },
              });
        expect(result.status, result.stderr).toBe(0);
      }
      expect(deniedOut.permission, unsafeCommand).toBe("deny");
      expect(ledgerFilesFor(proj), unsafeCommand).toHaveLength(1);
      expect(witnessFilesFor(proj), unsafeCommand).toHaveLength(1);
    }

    const safeEnvironment = runAdapter(
      proj,
      "guards",
      payload("preToolUseShell", proj, {
        conversation_id: "developer-project-executable-child",
        session_id: "developer-project-executable-child",
        tool_input: { command: "env HOME=scratch rg --version" },
      }),
    );
    expectAllowJson(safeEnvironment);

    const targets = join(scriptDir, "targets.txt");
    writeFileSync(targets, "../aidlc\n");
    const dataDrivenCommand = "xargs rm -rf < targets.txt";
    const dataDriven = runAdapter(
      proj,
      "guards",
      payload("preToolUseShell", proj, {
        conversation_id: "developer-project-executable-child",
        session_id: "developer-project-executable-child",
        cwd: scriptDir,
        tool_input: { command: dataDrivenCommand, cwd: scriptDir },
      }),
    );
    const dataDrivenOut = JSON.parse(dataDriven.stdout) as {
      permission?: string;
      agent_message?: string;
    };
    if (dataDrivenOut.permission === "allow" && process.platform !== "win32") {
      const result = spawnSync("sh", ["-c", dataDrivenCommand], {
        cwd: scriptDir,
        encoding: "utf-8",
      });
      expect(result.status, result.stderr).toBe(0);
    }
    expect(dataDrivenOut.permission).toBe("deny");
    expect(ledgerFilesFor(proj)).toHaveLength(1);
    expect(witnessFilesFor(proj)).toHaveLength(1);

    const safeDataDriven = runAdapter(
      proj,
      "guards",
      payload("preToolUseShell", proj, {
        conversation_id: "developer-project-executable-child",
        session_id: "developer-project-executable-child",
        cwd: scriptDir,
        tool_input: {
          command: "xargs printf < targets.txt",
          cwd: scriptDir,
        },
      }),
    );
    expectAllowJson(safeDataDriven);

    for (const unsafeCommand of [
      process.platform === "win32"
        ? "scratch\\echo.cmd harmless"
        : "./scratch/printf.sh harmless",
      "busybox rm -rf aidlc",
      "toybox rm -rf aidlc",
    ]) {
      const denied = runAdapter(
        proj,
        "guards",
        payload("preToolUseShell", proj, {
          conversation_id: "developer-project-executable-child",
          session_id: "developer-project-executable-child",
          tool_input: { command: unsafeCommand },
        }),
      );
      const deniedOut = JSON.parse(denied.stdout) as {
        permission?: string;
        agent_message?: string;
      };
      expect(deniedOut.permission, unsafeCommand).toBe("deny");
      expect(ledgerFilesFor(proj), unsafeCommand).toHaveLength(1);
      expect(witnessFilesFor(proj), unsafeCommand).toHaveLength(1);
    }

    for (const safeCommand of [
      "printf '%s\\n' harmless",
      "busybox printf '%s\\n' harmless",
      "toybox printf '%s\\n' harmless",
    ]) {
      const allowed = runAdapter(
        proj,
        "guards",
        payload("preToolUseShell", proj, {
          conversation_id: "developer-project-executable-child",
          session_id: "developer-project-executable-child",
          tool_input: { command: safeCommand },
        }),
      );
      expectAllowJson(allowed, safeCommand);
    }

    const nested = runAdapter(
      proj,
      "guards",
      payload("preToolUseTask", proj, {
        conversation_id: "developer-project-executable-child",
        session_id: "developer-project-executable-child",
        generation_id: "project-executable-nested-generation",
        tool_use_id: "project-executable-nested-tool-use",
        tool_input: {
          description: "Nested probe",
          prompt: "Delegate again.",
          subagent_type: "aidlc-quality-agent",
        },
      }),
    );
    const nestedOut = JSON.parse(nested.stdout) as {
      permission?: string;
      agent_message?: string;
    };
    expect(nestedOut.permission).toBe("deny");
    expect(nestedOut.agent_message ?? "").toContain(
      "nested delegation is not allowed",
    );
  });
});
