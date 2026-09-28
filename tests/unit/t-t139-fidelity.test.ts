import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_PROCESS_CLEANUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingCleanupTimeoutMs,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";
import { describe, expect, test, setDefaultTimeout } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  comparableTerminal,
  guardBypassCommands,
  hasAdvancedMilestone,
  monitorNativeAnswerGate,
  nativeRootProviderFailure,
  nativeToolCalls,
} from "../harness/t139-fidelity.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const ROOT_SESSION = "11111111-1111-4111-8111-111111111111";
const ERROR_EVENT = "22222222-2222-4222-8222-222222222222";
const END_EVENT = "33333333-3333-4333-8333-333333333333";
const PROVIDER_MESSAGE = "API Error: 503 Bedrock is unable to process your request. This is a server-side issue.";
const syntheticMessage = {
  role: "assistant", type: "message", model: "<synthetic>", stop_reason: "stop_sequence",
  content: [{ type: "text", text: PROVIDER_MESSAGE }],
};
function rootError(overrides: Record<string, unknown> = {}) {
  return {
    type: "assistant", sessionId: ROOT_SESSION, session_id: ROOT_SESSION,
    isSidechain: false, uuid: ERROR_EVENT, timestamp: "2026-09-11T21:31:56.599Z",
    isApiErrorMessage: true, error: "server_error", apiErrorStatus: 503,
    message: syntheticMessage, ...overrides,
  };
}
function turnEnd(overrides: Record<string, unknown> = {}) {
  return {
    type: "system", subtype: "turn_duration", sessionId: ROOT_SESSION,
    isSidechain: false, uuid: END_EVENT, parentUuid: ERROR_EVENT,
    timestamp: "2026-09-11T21:31:56.602Z", durationMs: 481033, ...overrides,
  };
}
const jsonl = (...rows: unknown[]) => `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;

describe("t139 typed root provider failures", () => {
  test("the observed root server error and linked turn completion preserve HTTP 503", () => {
    expect(nativeRootProviderFailure(jsonl(rootError(), turnEnd()), ROOT_SESSION)).toEqual({
      sessionId: ROOT_SESSION, eventId: ERROR_EVENT, turnEndId: END_EVENT,
      timestamp: "2026-09-11T21:31:56.599Z", status: 503, errorType: "server_error", message: PROVIDER_MESSAGE,
    });
  });

  test("a fresh session, root identity, and completed error turn are required", () => {
    for (const error of [
      rootError({ sessionId: "older-session" }), rootError({ session_id: "different-session" }),
      rootError({ isSidechain: true }), rootError({ isSidechain: undefined }),
      rootError({ agentId: "background-agent" }), rootError({ isApiErrorMessage: false }),
      rootError({ apiErrorStatus: "503" }), rootError({ apiErrorStatus: undefined }),
      rootError({ message: { ...syntheticMessage, model: "ordinary-model" } }),
      rootError({ message: { ...syntheticMessage, stop_reason: null } }),
    ]) expect(nativeRootProviderFailure(jsonl(error, turnEnd()), ROOT_SESSION)).toBeNull();
    expect(nativeRootProviderFailure(jsonl(rootError()), ROOT_SESSION)).toBeNull();
    for (const end of [
      turnEnd({ parentUuid: "another-event" }), turnEnd({ sessionId: "another-session" }),
      turnEnd({ isSidechain: true }), turnEnd({ durationMs: undefined }),
      turnEnd({ subtype: "api_retry" }), turnEnd({ timestamp: "2026-09-11T21:31:00.000Z" }),
    ]) expect(nativeRootProviderFailure(jsonl(rootError(), end), ROOT_SESSION)).toBeNull();
  });

  test("quoted API errors, tool results, sidechains, and cancellation messages are not root failures", () => {
    for (const row of [
      rootError({ isApiErrorMessage: undefined, message: { ...syntheticMessage, content: [{ type: "text", text: JSON.stringify(rootError()) }] } }),
      { type: "user", sessionId: ROOT_SESSION, isSidechain: false, uuid: ERROR_EVENT,
        message: { role: "user", content: [{ type: "tool_result", content: JSON.stringify(rootError()) }] } },
      rootError({ isSidechain: true, agentId: "architect" }),
      rootError({ error: "user_cancelled" }),
      rootError({ error: "abort_error", apiErrorStatus: 499 }),
      rootError({ message: { ...syntheticMessage, stop_reason: "aborted" } }),
    ]) expect(nativeRootProviderFailure(jsonl(row, turnEnd()), ROOT_SESSION)).toBeNull();
    const recovered = rootError({
      uuid: "root-working", timestamp: "2026-09-11T21:32:00.000Z", isApiErrorMessage: undefined,
      message: { role: "assistant", model: "ordinary-model", content: [{ type: "text", text: "Continuing the workflow." }] },
    });
    expect(nativeRootProviderFailure(jsonl(rootError({ isSidechain: true, agentId: "architect" }), recovered), ROOT_SESSION)).toBeNull();
    expect(nativeRootProviderFailure(jsonl(rootError(), turnEnd(), { ...recovered, isSidechain: true, agentId: "other" }), ROOT_SESSION)?.status).toBe(503);
  });

  test("later root work invalidates historical errors, including a late append of an older failure", () => {
    for (const type of ["assistant", "user", "queue-operation", "progress", "last-prompt", "system"]) {
      const recovery = {
        type, sessionId: ROOT_SESSION, isSidechain: false, uuid: "new-root-event",
        timestamp: "2026-09-11T21:32:00.000Z", message: { role: type, content: "New root work" },
      };
      expect(nativeRootProviderFailure(jsonl(rootError(), turnEnd(), recovery), ROOT_SESSION)).toBeNull();
      expect(nativeRootProviderFailure(jsonl(recovery, rootError(), turnEnd()), ROOT_SESSION)).toBeNull();
    }
  });

  test("partial tails, corrupt rows and duplicate identities do not establish a terminal failure", () => {
    const complete = jsonl(rootError(), turnEnd());
    for (const transcript of [
      complete.trimEnd(), `${complete}{"type":"assistant"`,
      `${complete}{corrupt}\n`, jsonl(rootError(), rootError(), turnEnd()),
      jsonl(rootError(), turnEnd(), turnEnd()),
    ]) expect(nativeRootProviderFailure(transcript, ROOT_SESSION)).toBeNull();
  });

  test("the Completed milestone suppresses only late provider failure, not guard inspection", () => {
    const transcript = jsonl(rootError(), turnEnd());
    expect(nativeRootProviderFailure(transcript, ROOT_SESSION, 4)?.status).toBe(503);
    for (const completed of [5, 6, 10]) {
      expect(nativeRootProviderFailure(transcript, ROOT_SESSION, completed)).toBeNull();
    }
    const bypass = "AIDLC_DISABLE_ENSEMBLE_EVIDENCE=1 bun .claude/tools/aidlc.ts engine orchestrate next";
    const withTool = jsonl({
      type: "assistant", sessionId: ROOT_SESSION, isSidechain: false, uuid: "tool",
      message: { content: [{ type: "tool_use", name: "Bash", input: { command: bypass } }] },
    }, rootError(), turnEnd());
    expect(nativeRootProviderFailure(withTool, ROOT_SESSION, 5)).toBeNull();
    expect(guardBypassCommands(nativeToolCalls(withTool))).toEqual([bypass]);
  });
});

function clientScratch(): string {
  let checkout = resolve(import.meta.dir, "../..");
  const marker = join(checkout, ".git");
  if (existsSync(marker) && statSync(marker).isFile()) {
    const gitDir = resolve(checkout, readFileSync(marker, "utf8").trim().replace(/^gitdir: /, ""));
    checkout = dirname(resolve(gitDir, readFileSync(join(gitDir, "commondir"), "utf8").trim()));
  }
  const root = join(checkout, "tmp", "combined-test-suite", "t139-provider-failfast");
  mkdirSync(root, { recursive: true });
  return mkdtempSync(join(root, "client-"));
}

function client(resist = false, exitAfter?: number): ChildProcess {
  return spawn(process.execPath, ["--eval", `
${resist ? 'process.on("SIGTERM", () => {});' : ""}
process.stdout.write("READY\\n");
setInterval(() => {}, 1000);
setTimeout(() => process.exit(${exitAfter === undefined ? 99 : 0}), ${exitAfter ?? NATIVE_FIXTURE_SETUP_TIMEOUT_MS});
`], { stdio: ["ignore", "pipe", "pipe"] });
}

async function clientReady(child: ChildProcess): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      new Promise<void>((resolve, reject) => {
        child.stdout!.once("data", (bytes) => {
          if (String(bytes).includes("READY")) resolve();
          else reject(new Error("unexpected controlled client startup output"));
        });
        child.once("error", reject);
        child.once("exit", () => reject(new Error("controlled client exited before readiness")));
      }),
      new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("controlled client readiness timed out")), remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS)); }),
    ]);
  } finally { clearTimeout(timeout); }
}

async function stopClient(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGKILL"); // Only a handle created by this unit fixture.
  try {
    await Promise.race([
      exited,
      new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("controlled client cleanup unconfirmed")), remainingCleanupTimeoutMs(NATIVE_PROCESS_CLEANUP_TIMEOUT_MS)); }),
    ]);
  } finally { clearTimeout(timeout); }
}

describe("t139 owned answer-gate monitor", () => {
  test("a confirmed root 503 promptly stops only the owned client and preserves the original error", async () => {
    const directory = clientScratch();
    const path = join(directory, "root.jsonl");
    writeFileSync(path, jsonl(rootError(), turnEnd()));
    const owned = client();
    const unrelated = client();
    const failure = new Error(PROVIDER_MESSAGE);
    let succeeded = false;
    try {
      await Promise.all([clientReady(owned), clientReady(unrelated)]);
      let caught: unknown;
      try {
        await monitorNativeAnswerGate(owned, () => {
          if (nativeRootProviderFailure(readFileSync(path, "utf8"), ROOT_SESSION, 3)) throw failure;
        }, { pollMs: 10, terminateGraceMs: 50, killWaitMs: NATIVE_PROCESS_CLEANUP_TIMEOUT_MS });
      } catch (error) { caught = error; }
      expect(caught).toBe(failure);
      expect(owned.exitCode !== null || owned.signalCode !== null).toBe(true);
      expect(unrelated.exitCode).toBeNull();
      expect(unrelated.signalCode).toBeNull();
      succeeded = true;
    } finally {
      await Promise.all([stopClient(owned), stopClient(unrelated)]);
      if (succeeded) rmSync(directory, { recursive: true, force: true });
      else console.error(`provider monitor evidence retained: ${directory}`);
    }
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("a goal reached before a late API error leaves the healthy client alive until its normal exit", async () => {
    const directory = clientScratch();
    const root = join(directory, "root.jsonl");
    const state = join(directory, "state.md");
    writeFileSync(state, "**Completed**: 3\n");
    writeFileSync(root, "");
    const owned = client(false, 300);
    let succeeded = false;
    try {
      await clientReady(owned);
      writeFileSync(state, "**Completed**: 5\n");
      writeFileSync(root, jsonl(rootError(), turnEnd())); // Provider error follows the milestone.
      let inspected = 0;
      expect(await monitorNativeAnswerGate(owned, () => {
        inspected++;
        const completed = Number(/Completed\*\*:[ \t]*(\d+)/.exec(readFileSync(state, "utf8"))![1]);
        const error = nativeRootProviderFailure(readFileSync(root, "utf8"), ROOT_SESSION, completed);
        if (error) throw new Error(error.message);
      }, { pollMs: 10, terminateGraceMs: 50, killWaitMs: NATIVE_PROCESS_CLEANUP_TIMEOUT_MS })).toBe(0);
      expect(inspected).toBeGreaterThan(0);
      expect(owned.signalCode).toBeNull();
      const finishedInspections = inspected;
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(inspected).toBe(finishedInspections);
      succeeded = true;
    } finally {
      await stopClient(owned);
      if (succeeded) rmSync(directory, { recursive: true, force: true });
      else console.error(`provider goal-boundary evidence retained: ${directory}`);
    }
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test.skipIf(process.platform === "win32")("an owned client ignoring TERM is force-stopped within the failure budget", async () => {
    const owned = client(true);
    const failure = new Error(PROVIDER_MESSAGE);
    try {
      await clientReady(owned);
      let caught: unknown;
      try {
        await monitorNativeAnswerGate(owned, () => { throw failure; },
          { pollMs: 10, terminateGraceMs: 50, killWaitMs: NATIVE_PROCESS_CLEANUP_TIMEOUT_MS });
      } catch (error) { caught = error; }
      expect(caught).toBe(failure);
      expect(owned.signalCode).toBe("SIGKILL");
    } finally { await stopClient(owned); }
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
});

const FLAG = "AIDLC_DISABLE_ENSEMBLE_EVIDENCE";
const command = (text: string) => [{ name: "Bash", input: { command: text } }];

describe("t139 native shell fidelity", () => {
  test("rejects the observed opt-outs and option-bearing env assignments", () => {
    const enabled = [
      `${FLAG}=1 bun .claude/tools/aidlc.ts engine orchestrate report --result revised 2>&1`,
      `env ${FLAG}="1" bun .claude/tools/aidlc.ts engine orchestrate report --result approved`,
      `env -u AIDLC_SKIP_REVISION_BACKSTOP ${FLAG}=1 bun .claude/tools/aidlc.ts engine orchestrate report`,
      `/usr/bin/env --unset=AIDLC_SKIP_REVISION_BACKSTOP '${FLAG}=1' bun run.ts`,
      `env -uAIDLC_SKIP_REVISION_BACKSTOP -- ${FLAG}='1' bun run.ts`,
      "export AIDLC_SKIP_REVISION_BACKSTOP=1; bun run.ts",
      "echo ready\nAIDLC_SKIP_ARTIFACT_GUARD='1' bun run.ts",
      `2>/dev/null ${FLAG}=1 bun run.ts`,
      `env -S '${FLAG}=1 bun run.ts'`,
      `bash -lc '${FLAG}=1 bun run.ts'`,
      `echo "$(${FLAG}=1 bun run.ts)"`,
    ];
    for (const text of enabled) expect(guardBypassCommands(command(text))).toEqual([text]);
  });

  test("preserves the exact backstop unset launcher and recognizes unset values as names", () => {
    const safe = [
      "env -u AIDLC_SKIP_REVISION_BACKSTOP claude --setting-sources project --dangerously-skip-permissions",
      `env --unset ${FLAG} bun run.ts`,
      `${FLAG}=1 env -u ${FLAG} bun run.ts`,
      `${FLAG}=1 env -i bun run.ts`,
      `${FLAG}=0 bun run.ts`,
      `env -C '${FLAG}=1' bun run.ts`,
    ];
    for (const text of safe) expect(guardBypassCommands(command(text))).toEqual([]);
  });

  test("quoted multiline words, comments and heredoc bodies are data", () => {
    const safe = [
      `cat <<'EOF'\n${FLAG}=1\nEOF`,
      `cat <<"EOF"\n${FLAG}=1\nEOF\n`,
      `cat <<\\EOF\n${FLAG}=1\nEOF\n`,
      `cat <<- 'EOF'\n\t${FLAG}=1\n\tEOF\n`,
      `cat <<EOF\n${FLAG}=1\nEOF\n`,
      `cat <<'FIRST' <<'SECOND'\n${FLAG}=1\nFIRST\n${FLAG}=1\nSECOND\n`,
      `cat <<'EOF'; echo '${FLAG}=1'\n${FLAG}=1\nEOF\n`,
      `printf '%s\\n' 'documentation;\n${FLAG}=1\nmore documentation'`,
      `echo "documentation\n${FLAG}=1"`,
      `grep -n "${FLAG}=1" stage-protocol-ensemble.md`,
      `# ${FLAG}=1\nprintf safe`,
      `cat <<'EOF'\n$(${FLAG}=1 bun run.ts)\nEOF\n`,
    ];
    for (const text of safe) expect(guardBypassCommands(command(text))).toEqual([]);
  });

  test("real commands after a heredoc and expansions in unquoted heredocs still count", () => {
    const enabled = [
      `cat <<'EOF'\n${FLAG}=1\nEOF\n${FLAG}=1 bun run.ts`,
      `cat <<EOF\n$(${FLAG}=1 bun run.ts)\nEOF\n`,
    ];
    for (const text of enabled) expect(guardBypassCommands(command(text))).toEqual([text]);
  });

  test("only assistant tool requests count, not documentation or tool results", () => {
    const rows = [
      { type: "assistant", message: { content: [{ type: "text", text: `${FLAG}=1` }] } },
      { type: "user", message: { content: [{ type: "tool_result", content: `${FLAG}=1` }] } },
      { type: "assistant", message: { content: [
        { type: "tool_use", name: "Read", input: { file_path: "stage-protocol-ensemble.md" } },
        { type: "tool_use", name: "Bash", input: { command: `grep -n "${FLAG}=1" stage-protocol-ensemble.md` } },
        { type: "tool_use", name: "Bash", input: { command: "env -u AIDLC_SKIP_REVISION_BACKSTOP claude --setting-sources project --dangerously-skip-permissions" } },
      ] } },
    ];
    const calls = nativeToolCalls(rows.map((row) => JSON.stringify(row)).join("\n"));
    expect(calls).toHaveLength(3);
    expect(guardBypassCommands(calls)).toEqual([]);
  });

  test("env options compose with shell utilities and nested env unsets", () => {
    const enabled = [
      `env -u AIDLC_SKIP_REVISION_BACKSTOP bash -c '${FLAG}=1 bun run.ts'`,
      `/usr/bin/env --unset=AIDLC_SKIP_REVISION_BACKSTOP sh -lc '${FLAG}=1 bun run.ts'`,
      `env -u AIDLC_SKIP_REVISION_BACKSTOP env -u OTHER bash -c '${FLAG}=1 bun run.ts'`,
    ];
    for (const text of enabled) expect(guardBypassCommands(command(text))).toEqual([text]);
    const safe = [
      `env -u AIDLC_SKIP_REVISION_BACKSTOP bash -c 'printf "%s\\n" "${FLAG}=1"'`,
      `env ${FLAG}=1 env -u ${FLAG} bash -c 'printf safe'`,
      `env -u AIDLC_SKIP_REVISION_BACKSTOP bash -c 'cat <<"EOF"\n${FLAG}=1\nEOF'`,
    ];
    for (const text of safe) expect(guardBypassCommands(command(text))).toEqual([]);
  });

  test("backticks execute outside single quotes but escaped and quoted backticks remain data", () => {
    const enabled = [
      `echo "\`${FLAG}=1 bun run.ts\`"`,
      `echo \`${FLAG}=1 bun run.ts\``,
      `cat <<EOF\n\`${FLAG}=1 bun run.ts\`\nEOF\n`,
    ];
    for (const text of enabled) expect(guardBypassCommands(command(text))).toEqual([text]);
    const safe = [
      `echo '\`${FLAG}=1 bun run.ts\`'`,
      `echo "\\\`${FLAG}=1 bun run.ts\\\`"`,
      `echo \\\`${FLAG}=1 bun run.ts\\\``,
      `cat <<'EOF'\n\`${FLAG}=1 bun run.ts\`\nEOF\n`,
    ];
    for (const text of safe) expect(guardBypassCommands(command(text))).toEqual([]);
  });

  test("substitution boundaries ignore quoted heredoc parentheses without hiding subsequent execution", () => {
    const safe = [
      `echo "$(cat <<'EOF'\n)\nEOF\n)"`,
      `echo "$(cat <<'ONE' <<'TWO'\n)\nONE\n(\nTWO\n)"`,
      `echo "$(cat <<-'EOF'\n\t) $(${FLAG}=1 bun run.ts)\n\tEOF\n)"`,
      `echo "$(printf '%s' "$(cat <<'EOF'\n)\nEOF\n)")"`,
    ];
    for (const text of safe) expect(guardBypassCommands(command(text))).toEqual([]);
    const enabled = `echo "$(cat <<'EOF'\n)\nEOF\n${FLAG}=1 bun run.ts\n)"`;
    expect(guardBypassCommands(command(enabled))).toEqual([enabled]);
  });
});

const completed = ["workspace-scaffold", "workspace-detection", "state-init", "reverse-engineering", "requirements-analysis"];
const intermediate = { completedCounter: 5, completedSlugs: completed, currentStage: "requirements-analysis", phase: "INCEPTION" };
const advanced = { ...intermediate, currentStage: "code-generation", phase: "CONSTRUCTION" };

describe("t139 comparable completion milestone", () => {
  test("does not sample approval's intermediate Completed write", async () => {
    let now = 0;
    let reads = 0;
    const sampled = await comparableTerminal(() => {
      reads++;
      return now < 25 ? intermediate : advanced;
    }, 1_000, { now: () => now, pause: async (ms) => { now += ms; } });
    expect(sampled).toEqual(advanced);
    expect(reads).toBe(2);
    expect(now).toBe(25);
    expect(hasAdvancedMilestone({ ...advanced, completedCounter: 4 })).toBe(false);
  });

  test("returns an already advanced state without waiting or normalizing its phase", async () => {
    const wrongPhase = { ...advanced, phase: "INCEPTION" };
    const sampled = await comparableTerminal(() => wrongPhase, 100, {
      now: () => 0,
      pause: async () => { throw new Error("unexpected wait"); },
    });
    expect(sampled).toBe(wrongPhase);
    expect(sampled.phase).toBe("INCEPTION"); // The unchanged live phase assertion must reject this.
  });

  test.each([75, 10_000])("wait is bounded by the original deadline, with no shorter observation cap (%i)", async (deadline) => {
    let now = 0;
    await expect(comparableTerminal(() => intermediate, deadline, {
      now: () => now,
      pause: async (ms) => { now += ms; },
    })).rejects.toThrow("existing deadline");
    expect(now).toBe(deadline);
    expect(intermediate.phase).toBe("INCEPTION");
  });
});

// Optional, read-only replay data. This changes neither runner defaults nor
// the live test's profile: every listed native transcript is classified as-is.
const replayManifest = process.env.AIDLC_T139_REPLAY_MANIFEST;
if (replayManifest) {
  const cases = JSON.parse(readFileSync(replayManifest, "utf8")) as Array<{
    label: string;
    files: string[];
    bashCalls: number;
    optOuts: string[];
    provider?: { sessionId: string; status: number | null; completedCounter?: number };
  }>;
  for (const replay of cases) {
    test(`saved native replay: ${replay.label}`, () => {
      expect(replay.files.length).toBeGreaterThan(0);
      const calls = replay.files.flatMap((path) => nativeToolCalls(readFileSync(path, "utf8")));
      expect(calls.filter((call) => call.name === "Bash")).toHaveLength(replay.bashCalls);
      expect(guardBypassCommands(calls)).toEqual(replay.optOuts);
      if (replay.provider) {
        const transcript = replay.files.map((path) => readFileSync(path, "utf8")).join("");
        expect(nativeRootProviderFailure(transcript, replay.provider.sessionId, replay.provider.completedCounter)?.status ?? null)
          .toBe(replay.provider.status);
      }
      console.log(`native replay ${replay.label}: ${replay.bashCalls} Bash calls; ${replay.optOuts.length} opt-outs`);
    });
  }
}
