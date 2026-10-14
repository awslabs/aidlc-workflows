// t-antigravity-adapter: pipe live-captured Antigravity hook payloads through
// the authored adapter against a seeded project and assert the Claude-shaped
// conversions on the wire.
//
// covers: hook:aidlc-record-human-turn, hook:aidlc-log-subagent
//
// The fixture corpus (tests/fixtures/antigravity-hook-payloads/payloads.json)
// is field-verbatim off agy cli-2026.10.13 on macOS (probe 2026-10-14):
// camelCase protojson keys, host step-type tool names (run_command,
// write_to_file, replace_file_content, view_file, invoke_subagent with a
// Subagents[] batch), no session id beside conversationId, no tool-use id, and
// a delegate's calls arriving under a DIFFERENT conversationId with no
// identity fields. The adapter's contracts under test:
//   - session-start: core additionalContext becomes an injected system
//     message; a delegate's session start injects nothing.
//   - turn (PreInvocation): HUMAN_TURN is minted once per USER_EXPLICIT step
//     of the transcript, never for a system message or a delegate.
//   - guards (PreToolUse): run_command maps to Bash for the core guards; a
//     core exit-2 block converts to {"decision":"deny","reason"} stdout JSON
//     (exit 0); allow paths emit {"decision":"allow"} (an empty answer is a
//     deny on this host).
//   - invoke_subagent records the dispatch, a delegate conversation is
//     classified from its transcript and attributed to it, so its reads are
//     scope-enforced; a delegate cannot dispatch again.
//   - audit-and-sensors: a write lands an audit row; a delegate's stop lands
//     SUBAGENT_COMPLETED and retires its record.
//   - stop: a core {"decision":"block","reason"} converts to
//     {"decision":"continue","reason"}; a stop with work still running is let
//     through; a delegate's stop never enters the forwarding loop.
//   - malformed stdin denies guards and stays silent on every other target.

import {
  NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { readAllAuditShards } from "../../dist/antigravity/.agents/tools/aidlc-lib.ts";
import {
  createTestProject,
  seedAuditFile,
  seededAuditShard,
  seededRecordDir,
  seedStateFile,
} from "../harness/fixtures.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const DIST = join(REPO_ROOT, "dist", "antigravity", ".agents");
const PAYLOADS = JSON.parse(
  readFileSync(join(import.meta.dir, "..", "fixtures", "antigravity-hook-payloads", "payloads.json"), "utf-8"),
) as Record<string, Record<string, unknown>>;
const MAIN = PAYLOADS.sessionStart.conversationId as string;
const SUB = PAYLOADS.subSessionStart.conversationId as string;

const scratch: string[] = [];

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);

afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A workspace-shell project with the shipped .agents engine installed. */
function installedProject(): string {
  const root = createTestProject();
  scratch.push(root);
  cpSync(DIST, join(root, ".agents"), { recursive: true });
  return root;
}

function ledgerDir(projectDir: string): string {
  return join(projectDir, "aidlc", ".aidlc-antigravity-subagents");
}

function spawnRecords(projectDir: string): string[] {
  const dir = ledgerDir(projectDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.startsWith("spawn-")).map((name) => join(dir, name));
}

function transcriptPath(projectDir: string, conversation: string): string {
  return join(projectDir, "transcripts", conversation, "transcript_full.jsonl");
}

/** Write a transcript the way the host does: one JSON step per line. */
function writeTranscript(
  projectDir: string,
  conversation: string,
  steps: Array<{ type: string; source: string; content?: string }>,
): void {
  const path = transcriptPath(projectDir, conversation);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    steps.map((step, index) => JSON.stringify({ step_index: index, status: "DONE", ...step })).join("\n") + "\n",
  );
}

const humanStep = (text: string) => ({
  type: "USER_INPUT",
  source: "USER_EXPLICIT",
  content: `<USER_REQUEST>\n${text}\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: 2026-10-14T14:05:00-03:00.\n</ADDITIONAL_METADATA>`,
});
const modelStep = (text: string) => ({ type: "PLANNER_RESPONSE", source: "MODEL", content: text });
const askStep = (question: string, options: string[]) => ({
  type: "PLANNER_RESPONSE",
  source: "MODEL",
  content: "",
  tool_calls: [{ name: "ask_question", args: { questions: [{ question, options, is_multi_select: false }] } }],
});
const answerStep = (answer: string) => ({
  type: "ASK_QUESTION",
  source: "MODEL",
  status: "DONE",
  content: `Created At: 2026-10-14T17:16:50Z\nCompleted At: 2026-10-14T17:17:26Z\nA1: ${answer}`,
});
const systemStep = (text: string) => ({ type: "SYSTEM_MESSAGE", source: "SYSTEM", content: text });

function payload(name: string, projectDir: string, extra: Record<string, unknown> = {}): string {
  const replace = (value: unknown): unknown => {
    if (typeof value === "string") {
      return value
        .replaceAll("{{PROJECT}}", projectDir)
        .replaceAll("{{TRANSCRIPT}}", transcriptPath(projectDir, MAIN))
        .replaceAll("{{SUB_TRANSCRIPT}}", transcriptPath(projectDir, SUB));
    }
    if (Array.isArray(value)) return value.map(replace);
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, replace(item)]),
      );
    }
    return value;
  };
  return JSON.stringify({ ...(replace(PAYLOADS[name]) as Record<string, unknown>), ...extra });
}

function runAdapter(
  projectDir: string,
  target: string,
  stdin: string,
  options: { cwd?: string; env?: Record<string, string | undefined> } = {},
): { stdout: string; stderr: string; code: number } {
  const env: Record<string, string | undefined> = {
    ...process.env,
    AIDLC_PROJECT_DIR: projectDir,
    AIDLC_HARNESS_DIR: ".agents",
    ...options.env,
  };
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete env[key];
  }
  const r = spawnSync(
    "bun",
    [join(projectDir, ".agents", "hooks", "aidlc-antigravity-adapter.ts"), target],
    {
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
      // The host runs a hook with cwd = .agents/; hooks.json steps up first.
      cwd: options.cwd ?? projectDir,
      input: stdin,
      encoding: "utf-8",
      env: env as NodeJS.ProcessEnv,
    },
  );
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", code: r.status ?? 0 };
}

function decision(r: { stdout: string }): { decision?: string; reason?: string } {
  return JSON.parse(r.stdout) as { decision?: string; reason?: string };
}

function expectAllow(r: { code: number; stdout: string }, label?: string): void {
  expect(r.code, label).toBe(0);
  expect(decision(r).decision, label).toBe("allow");
}

function turns(projectDir: string): number {
  return readAllAuditShards(projectDir).split("**Event**: HUMAN_TURN").length - 1;
}

/** Replace the core stop hook with a probe that always asks to continue. */
function installStopProbe(projectDir: string): string {
  const marker = join(projectDir, "stop-hook-ran");
  writeFileSync(
    join(projectDir, ".agents", "hooks", "aidlc-continue-workflow.ts"),
    `await Bun.write(${JSON.stringify(marker)}, "ran");\n` +
      'console.log(JSON.stringify({ decision: "block", reason: "Continue the foreground workflow." }));\n',
  );
  return marker;
}

describe("t-antigravity-adapter: live Antigravity payloads through the authored adapter", () => {
  test("1: session-start injects the core context as a system message", () => {
    const proj = installedProject();
    seedStateFile(proj, "state-construction.md");
    writeTranscript(proj, MAIN, [humanStep("/aidlc")]);
    const r = runAdapter(proj, "session-start", payload("sessionStart", proj));
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout) as {
      injectSteps?: Array<{ systemMessage?: { systemMessage?: string } }>;
    };
    const message = out.injectSteps?.[0]?.systemMessage?.systemMessage ?? "";
    expect(message).toContain("AIDLC WORKFLOW ACTIVE");
    expect(r.stdout).not.toContain("additionalContext");
    expect(readAllAuditShards(proj)).toContain("SESSION_STARTED");
  });

  test("2: session-start runs from the .agents/ cwd the host gives a hook", () => {
    const proj = installedProject();
    const r = runAdapter(proj, "session-start", payload("sessionStart", proj), {
      cwd: join(proj, ".agents"),
      env: { AIDLC_PROJECT_DIR: undefined },
    });
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout) as {
      injectSteps?: Array<{ systemMessage?: { systemMessage?: string } }>;
    };
    expect(out.injectSteps?.[0]?.systemMessage?.systemMessage ?? "").toContain("AIDLC Runtime Session:");
  });

  test("3: a person's message mints HUMAN_TURN once; a delegate's report never does", () => {
    const proj = installedProject();
    seedStateFile(proj, "state-construction.md");
    seedAuditFile(proj);
    writeTranscript(proj, MAIN, [humanStep("Approve")]);
    expect(runAdapter(proj, "turn", payload("preInvocationFirst", proj)).code).toBe(0);
    expect(turns(proj)).toBe(1);
    // The same step again (the next model call of the same turn): no new mint.
    expect(runAdapter(proj, "turn", payload("preInvocationFirst", proj, { invocationNum: 1 })).code).toBe(0);
    expect(turns(proj)).toBe(1);
    // The parent is woken by its delegate's report: a system message, not a turn.
    writeTranscript(proj, MAIN, [
      humanStep("Approve"),
      modelStep("Starting the review."),
      modelStep("Dispatched."),
      systemStep("[Message] from the reviewer: READY"),
    ]);
    expect(runAdapter(proj, "turn", payload("preInvocationWokenByDelegate", proj)).code).toBe(0);
    expect(turns(proj)).toBe(1);
    // The person's second message is the second turn.
    writeTranscript(proj, MAIN, [
      humanStep("Approve"),
      modelStep("Starting the review."),
      modelStep("Dispatched."),
      systemStep("[Message] from the reviewer: READY"),
      modelStep("Done."),
      humanStep("Carry on"),
    ]);
    expect(runAdapter(proj, "turn", payload("preInvocationFirst", proj, { initialNumSteps: 6 })).code).toBe(0);
    expect(turns(proj)).toBe(2);
    // An answer in the ask_question modal is a human turn too: the host
    // records it as a completed ASK_QUESTION step, not as a typed message.
    writeTranscript(proj, MAIN, [
      humanStep("Approve"),
      modelStep("Starting the review."),
      modelStep("Dispatched."),
      systemStep("[Message] from the reviewer: READY"),
      modelStep("Done."),
      humanStep("Carry on"),
      askStep("Approval — Functional Design complete. How would you like to proceed?", [
        "Approve — Continue to NFR Design",
        "Request Changes — Provide revision feedback",
      ]),
      answerStep("Approve — Continue to NFR Design"),
    ]);
    expect(runAdapter(proj, "turn", payload("preInvocationFirst", proj, { initialNumSteps: 8 })).code).toBe(0);
    expect(turns(proj)).toBe(3);
    expect(runAdapter(proj, "guards", payload("preToolUseRunCommand", proj)).code).toBe(0);
    expect(turns(proj)).toBe(3);
  });

  test("4: guards convert a state-guard block to deny JSON and allow ordinary work", () => {
    const proj = installedProject();
    seedStateFile(proj, "state-construction.md");
    writeTranscript(proj, MAIN, [humanStep("go")]);
    const blocked = runAdapter(
      proj,
      "guards",
      payload("preToolUseRunCommand", proj, {
        toolCall: {
          name: "run_command",
          args: { CommandLine: "bun .agents/tools/aidlc-state.ts approve", Cwd: proj },
        },
      }),
    );
    expect(blocked.code).toBe(0);
    expect(decision(blocked).decision).toBe("deny");
    expect(decision(blocked).reason ?? "").toContain("aidlc-orchestrate");
    expectAllow(runAdapter(proj, "guards", payload("preToolUseRunCommand", proj)), "run_command");
    expectAllow(runAdapter(proj, "guards", payload("preToolUseWriteToFile", proj)), "write_to_file");
    expectAllow(runAdapter(proj, "guards", payload("preToolUseReplaceFileContent", proj)), "replace_file_content");
  });

  test("5: a dispatch records the delegate; the delegate is attributed, scope-enforced, and cannot dispatch", () => {
    const proj = installedProject();
    seedStateFile(proj, "state-construction.md");
    const record = seededRecordDir(proj);
    mkdirSync(join(record, "construction", "unit-b"), { recursive: true });
    writeFileSync(join(record, "construction", "unit-b", "design.md"), "# b\n");
    mkdirSync(join(record, ".aidlc-engine"), { recursive: true });
    writeFileSync(
      join(record, ".aidlc-engine", "reviewer-dispatch.json"),
      JSON.stringify({
        reviewer: "aidlc-architecture-reviewer-agent",
        stage: "functional-design",
        unit: "unit-a",
        exempt: [],
      }),
    );
    writeTranscript(proj, MAIN, [humanStep("Approve")]);
    const prompt = (PAYLOADS.preToolUseInvokeSubagent.toolCall as {
      args: { Subagents: Array<{ Prompt: string }> };
    }).args.Subagents[0].Prompt;

    const spawn = runAdapter(proj, "guards", payload("preToolUseInvokeSubagent", proj));
    expectAllow(spawn, "dispatch");
    expect(spawnRecords(proj)).toHaveLength(1);

    // The delegate's own conversation: its transcript opens with the dispatch.
    writeTranscript(proj, SUB, [systemStep(`You are a subagent. Your task:\n${prompt}`)]);
    const start = runAdapter(proj, "session-start", payload("subSessionStart", proj));
    expect(start.code).toBe(0);
    expect(start.stdout.trim()).toBe("{}");
    // No human turn for a delegate.
    seedAuditFile(proj);
    expect(runAdapter(proj, "turn", payload("subPreInvocationFirst", proj)).code).toBe(0);
    expect(turns(proj)).toBe(0);
    // Its read outside the dispatched unit is refused with the unit named.
    const sibling = runAdapter(
      proj,
      "guards",
      payload("subPreToolUseViewFile", proj, {
        toolCall: { name: "view_file", args: { AbsolutePath: join(record, "construction", "unit-b", "design.md") } },
      }),
    );
    expect(sibling.code).toBe(0);
    expect(decision(sibling).decision).toBe("deny");
    expect(decision(sibling).reason ?? "").toContain("unit-a");
    // A delegate cannot delegate.
    const nested = runAdapter(proj, "guards", payload("subPreToolUseInvokeSubagent", proj));
    expect(decision(nested).decision).toBe("deny");
    expect(decision(nested).reason ?? "").toContain("nested delegation");
    expect(spawnRecords(proj)).toHaveLength(1);
    // The main chat is never conflated with its delegate.
    expectAllow(
      runAdapter(
        proj,
        "guards",
        payload("preToolUseRunCommand", proj, {
          toolCall: { name: "run_command", args: { CommandLine: "cat construction/unit-b/design.md", Cwd: record } },
        }),
      ),
      "main",
    );
    // The delegate's stop lands SUBAGENT_COMPLETED and retires its record.
    const done = runAdapter(proj, "stop", payload("subStop", proj));
    expect(done.code).toBe(0);
    expect(done.stdout.trim()).toBe("{}");
    expect(spawnRecords(proj)).toHaveLength(0);
    const shard = readFileSync(seededAuditShard(proj), "utf-8");
    expect(shard).toContain("SUBAGENT_COMPLETED");
    expect(shard).toContain("aidlc-architecture-reviewer-agent");
  });

  test("6: a write lands an audit row; a failed write does not", () => {
    const proj = installedProject();
    seedStateFile(proj, "state-construction.md");
    seedAuditFile(proj);
    writeTranscript(proj, MAIN, [humanStep("go")]);
    const artifact = join(seededRecordDir(proj), "construction", "functional-design", "design.md");
    mkdirSync(dirname(artifact), { recursive: true });
    writeFileSync(artifact, "# design\n");
    const w = runAdapter(
      proj,
      "audit-and-sensors",
      payload("postToolUseWriteToFile", proj, {
        toolCall: { name: "write_to_file", args: { TargetFile: artifact, CodeContent: "# design\n", Overwrite: true } },
      }),
    );
    expect(w.code).toBe(0);
    expect(readFileSync(seededAuditShard(proj), "utf-8")).toContain("ARTIFACT_");
    const before = readFileSync(seededAuditShard(proj), "utf-8");
    const failed = runAdapter(
      proj,
      "audit-and-sensors",
      payload("postToolUseWriteToFile", proj, {
        error: "permission denied",
        toolCall: { name: "write_to_file", args: { TargetFile: artifact, CodeContent: "# other\n", Overwrite: true } },
      }),
    );
    expect(failed.code).toBe(0);
    expect(readFileSync(seededAuditShard(proj), "utf-8")).toBe(before);
    expect(runAdapter(proj, "runtime-compile", payload("postToolUseRunCommand", proj)).code).toBe(0);
  });

  test("7: stop converts a core block to continue, lets a wait for a delegate through, and skips a delegate", () => {
    const proj = installedProject();
    seedStateFile(proj, "state-construction.md");
    writeTranscript(proj, MAIN, [humanStep("go")]);
    const marker = installStopProbe(proj);
    const blocked = runAdapter(proj, "stop", payload("stop", proj));
    expect(blocked.code).toBe(0);
    expect(decision(blocked).decision).toBe("continue");
    expect(decision(blocked).reason).toBe("Continue the foreground workflow.");
    expect(existsSync(marker)).toBe(true);

    rmSync(marker);
    const waiting = runAdapter(proj, "stop", payload("stopWhileDelegateRuns", proj));
    expect(waiting.stdout.trim()).toBe("{}");
    expect(existsSync(marker)).toBe(false);

    runAdapter(proj, "guards", payload("preToolUseInvokeSubagent", proj));
    writeTranscript(proj, SUB, [systemStep("You are a subagent. Your task: review")]);
    const delegate = runAdapter(proj, "stop", payload("subStop", proj));
    expect(delegate.stdout.trim()).toBe("{}");
    expect(existsSync(marker)).toBe(false);
  });

  test("8: malformed stdin denies guards and stays silent elsewhere", () => {
    const proj = installedProject();
    const guards = runAdapter(proj, "guards", "{not json");
    expect(guards.code).toBe(0);
    expect(decision(guards).decision).toBe("deny");
    for (const target of ["session-start", "turn", "audit-and-sensors", "runtime-compile", "stop"]) {
      const r = runAdapter(proj, target, "{not json");
      expect(r.code, target).toBe(0);
      expect(r.stdout.trim(), target).toBe("");
    }
  });

  test("9: the shipped hooks.json wires every target through the project root", () => {
    const hooks = JSON.parse(readFileSync(join(DIST, "hooks.json"), "utf-8")) as Record<
      string,
      Record<string, Array<{ command?: string; matcher?: string; hooks?: Array<{ command: string }> }>>
    >;
    const commands: string[] = [];
    for (const event of Object.values(hooks.aidlc)) {
      for (const entry of event) {
        if (entry.command) commands.push(entry.command);
        for (const hook of entry.hooks ?? []) commands.push(hook.command);
      }
    }
    expect(Object.keys(hooks.aidlc).sort()).toEqual(["PostToolUse", "PreInvocation", "PreToolUse", "SessionStart", "Stop"]);
    for (const command of commands) {
      expect(command).toMatch(/^cd \.\. && bun \.agents\/hooks\/aidlc-antigravity-adapter\.ts (session-start|turn|guards|audit-and-sensors|runtime-compile|stop)$/);
    }
    const release = readFileSync(join(REPO_ROOT, "dist-release", "antigravity", ".agents", "hooks.json"), "utf-8");
    expect(release).toContain("cd .. && aidlc engine adapter antigravity guards");
    expect(release).not.toContain("bun ");
  });
});
