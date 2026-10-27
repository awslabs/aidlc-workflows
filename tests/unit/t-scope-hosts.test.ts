// covers: file:tests/harness/scope-hosts.ts
//
// The scope-run hosts for other tools fire what each tree's own wiring file
// registers, fed the payloads that tool sends. These cases read the shipped
// wiring files and compare each payload a host builds with the payloads
// recorded from the tool itself (tests/fixtures/<tool>-hook-payloads), so a
// host here cannot drift from the tool it plays.
//
// Mechanism: function - the shipped wiring and recorded payloads, no hook runs.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO_ROOT } from "../harness/fixtures.ts";
import { AgentStandIn, PersonScript, type RunResult, ScopeHost, ScopeRunRefused } from "../harness/scope-run.ts";
import {
  CodexScopeHost,
  codexPatch,
  codexWired,
  CopilotScopeHost,
  copilotWired,
  cursorRefusal,
  CursorScopeHost,
  cursorStopVerdict,
  OpencodeScopeHost,
  type KiroIdeCard,
  KiroCliScopeHost,
  kiroCliMatches,
  kiroCliWired,
  KiroIdeScopeHost,
  kiroIdeWired,
} from "../harness/scope-hosts.ts";
import kiroManifest from "../../harness/kiro/manifest.ts";

const json = (path: string) => JSON.parse(readFileSync(join(REPO_ROOT, path), "utf-8"));
const codexWiring = json("dist/codex/.codex/hooks.json");
const copilotWiring = json("dist/copilot/.github/hooks/aidlc.json");
const recorded = (tool: string) => json(`tests/fixtures/${tool}-hook-payloads/payloads.json`) as Record<string, Record<string, unknown>>;
const keys = (payload: Record<string, unknown>) => Object.keys(payload).sort();
const codexAdapter = (target: string) => `bun .codex/tools/aidlc.ts engine adapter codex ${target}`;
const copilotAdapter = (target: string) => `bun .aidlc/hooks/aidlc-copilot-adapter.ts ${target}`;

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});
function scratch(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "t-scope-hosts-")));
  dirs.push(dir);
  return dir;
}

type Seen = { event: string; payload: Record<string, unknown> };

// Hosts that record every payload they would send and run no hook.
class CodexCapture extends CodexScopeHost {
  readonly seen: Seen[] = [];
  override wired(): string[] {
    return [];
  }
  protected override payload(event: string, fields: Record<string, unknown>): Record<string, unknown> {
    const payload = super.payload(event, fields);
    this.seen.push({ event, payload });
    return payload;
  }
}

class CopilotCapture extends CopilotScopeHost {
  readonly seen: Seen[] = [];
  override wired(): string[] {
    return [];
  }
  protected override payload(event: string, fields: Record<string, unknown>): Record<string, unknown> {
    const payload = super.payload(event, fields);
    this.seen.push({ event, payload });
    return payload;
  }
}

class KiroCliCapture extends KiroCliScopeHost {
  readonly seen: Seen[] = [];
  override wired(): string[] {
    return [];
  }
  protected override payload(event: string, fields: Record<string, unknown>): Record<string, unknown> {
    const payload = super.payload(event, fields);
    this.seen.push({ event, payload });
    return payload;
  }
}

class KiroIdeCapture extends KiroIdeScopeHost {
  readonly seen: Seen[] = [];
  override wired(): string[] {
    return [];
  }
  protected override payload(event: string, fields: Record<string, unknown>): Record<string, unknown> {
    const payload = super.payload(event, fields);
    this.seen.push({ event, payload });
    return payload;
  }
}

class CursorCapture extends CursorScopeHost {
  readonly seen: Seen[] = [];
  override wired(): string[] {
    return [];
  }
  protected override payload(event: string, fields: Record<string, unknown>): Record<string, unknown> {
    const payload = super.payload(event, fields);
    this.seen.push({ event, payload });
    return payload;
  }
}

/** Each moment the scope run plays, once. */
function playMoments(host: CodexCapture | CopilotCapture | KiroCliCapture | KiroIdeCapture | CursorCapture): Seen[] {
  host.sessionStart("startup");
  host.typed("Guide me");
  if (host.picker) host.picked("Which option fits?", ["A", "B"], "A");
  host.bash("bun --version");
  host.write("notes.md", "first\n");
  host.write("notes.md", "second\n");
  host.task("aidlc-developer-agent", "Run requirements-analysis", () => {});
  host.stop();
  return host.seen;
}

const find = (seen: Seen[], event: string, tool?: string) =>
  seen.find((s) => s.event === event && (tool === undefined || s.payload.tool_name === tool))?.payload ?? {};

describe("Codex CLI: .codex/hooks.json and Codex's own payloads", () => {
  test("each moment fires the commands the shipped wiring registers for it, matchers read as Codex reads them", () => {
    expect(codexWired(codexWiring, "SessionStart", null)).toEqual([codexAdapter("session-start")]);
    expect(codexWired(codexWiring, "UserPromptSubmit", null)).toEqual([codexAdapter("record-human-turn")]);
    expect(codexWired(codexWiring, "PreToolUse", "Bash")).toEqual([codexAdapter("guard-tool-call")]);
    expect(codexWired(codexWiring, "PreToolUse", "spawn_agent")).toEqual([codexAdapter("guard-tool-call"), codexAdapter("deliver-stage-rules")]);
    expect(codexWired(codexWiring, "PostToolUse", "Bash")).toEqual([codexAdapter("rebuild-stage-graph")]);
    expect(codexWired(codexWiring, "PostToolUse", "apply_patch")).toEqual([codexAdapter("audit-and-sensors")]);
    expect(codexWired(codexWiring, "PostToolUse", "request_user_input")).toEqual([codexAdapter("record-human-turn")]);
    expect(codexWired(codexWiring, "PostToolUse", "spawn_agent")).toEqual([]);
    expect(codexWired(codexWiring, "SubagentStop", null)).toEqual([codexAdapter("log-subagent")]);
    expect(codexWired(codexWiring, "Stop", null)).toEqual([codexAdapter("continue-workflow")]);
  });

  test("every payload carries the fields Codex's recorded payload for that event carries", () => {
    const seen = playMoments(new CodexCapture(scratch()));
    const codex = recorded("codex");
    expect(keys(find(seen, "SessionStart"))).toEqual(keys(codex.sessionStart));
    expect(keys(find(seen, "Stop"))).toEqual(keys(codex.stop));
    expect(keys(find(seen, "PostToolUse", "Bash"))).toEqual(keys(codex.postToolUse_bash));
    expect(keys(find(seen, "PostToolUse", "apply_patch"))).toEqual(keys(codex.postToolUse_applyPatch_plain));
    expect(keys(find(seen, "SubagentStop"))).toEqual(keys(codex.subagentStop));
    expect(typeof find(seen, "PostToolUse", "Bash").tool_response).toBe(typeof codex.postToolUse_bash.tool_response);
  });

  test("a helper's own inputs carry its thread id; the chat's do not", () => {
    const host = new CodexCapture(scratch());
    host.typed("Approve");
    host.task("aidlc-architecture-reviewer-agent", "Review it", () => host.write("review.md", "READY\n"));
    const prompts = host.seen.filter((s) => s.event === "UserPromptSubmit");
    expect(prompts[0].payload.agent_id).toBeUndefined();
    expect(prompts[1].payload).toMatchObject({ prompt: "Review it", agent_type: "aidlc-architecture-reviewer-agent" });
    const helperWrite = find(host.seen, "PostToolUse", "apply_patch");
    expect(helperWrite.agent_id).toBe(prompts[1].payload.agent_id);
    expect(find(host.seen, "SubagentStop").agent_id).toBe(prompts[1].payload.agent_id);
  });

  test("a file write is an apply_patch envelope: Add for a new file, Update for one that exists", () => {
    expect(codexPatch("src/a.ts", "one\ntwo\n", null)).toBe("*** Begin Patch\n*** Add File: src/a.ts\n+one\n+two\n*** End Patch\n");
    expect(codexPatch("src/a.ts", "three\n", "one\n")).toBe("*** Begin Patch\n*** Update File: src/a.ts\n@@\n-one\n+three\n*** End Patch\n");
  });
});

describe("Copilot CLI: .github/hooks/aidlc.json and Copilot's own payloads", () => {
  test("each event fires the adapter target the shipped wiring registers, in the shell of the platform", () => {
    const targets = {
      SessionStart: "session-start", UserPromptSubmit: "record-human-turn", PreToolUse: "guard-tool-call",
      PostToolUse: "post-tool", SubagentStart: "subagent-start", SubagentStop: "log-subagent", Stop: "continue-workflow",
    };
    for (const [event, target] of Object.entries(targets)) {
      expect(copilotWired(copilotWiring, event, "linux")).toEqual([copilotAdapter(target)]);
      expect(copilotWired(copilotWiring, event, "win32")).toEqual([copilotWiring.hooks[event][0].powershell]);
    }
  });

  test("every payload carries the fields Copilot CLI's recorded payload for that event carries", () => {
    const seen = playMoments(new CopilotCapture(scratch()));
    const copilot = recorded("copilot");
    // initial_prompt comes only with a CLI started on a prompt (-p).
    expect(keys(find(seen, "SessionStart"))).toEqual(keys(copilot.sessionStart).filter((key) => key !== "initial_prompt"));
    expect(keys(find(seen, "Stop"))).toEqual(keys(copilot.stop));
    expect(keys(find(seen, "PreToolUse", "Bash"))).toEqual(keys(copilot.preToolUse_bash));
    expect(keys(find(seen, "PostToolUse", "Bash"))).toEqual(keys(copilot.postToolUse_bash));
    expect(keys(find(seen, "PreToolUse", "Write").tool_input as Record<string, unknown>)).toEqual(keys(copilot.preToolUse_write.tool_input as Record<string, unknown>));
    expect(keys(find(seen, "PreToolUse", "Edit").tool_input as Record<string, unknown>)).toEqual(keys(copilot.preToolUse_edit.tool_input as Record<string, unknown>));
    expect(keys(find(seen, "SubagentStart"))).toEqual(keys(copilot.subagentStart));
    expect(keys(find(seen, "SubagentStop"))).toEqual(keys(copilot.subagentStop));
    // The typed line as Copilot CLI 1.0.95 sends it: the chat's id, the prompt, a timestamp and the folder.
    expect(keys(find(seen, "UserPromptSubmit"))).toEqual(["cwd", "prompt", "sessionId", "timestamp"]);
  });

  test("questions are typed replies, and a slash skill reaches the hook as Copilot's skill-context block", () => {
    const host = new CopilotCapture(scratch());
    expect(host.picker).toBe(false);
    host.typed("/aidlc --resume");
    const prompt = String(find(host.seen, "UserPromptSubmit").prompt);
    expect(prompt.startsWith('The user explicitly invoked the "/aidlc" skill.')).toBe(true);
    expect(prompt).toContain('<skill-context name="aidlc">');
    expect(prompt).not.toContain("$ARGUMENTS");
  });
});

describe("Kiro CLI: the agent JSON's hooks and Kiro CLI 2.29's own payloads", () => {
  const agent = (name: string) => json(`dist/kiro/.kiro/agents/${name}.json`);
  const kiro = (target: string) => `bun .kiro/tools/aidlc.ts engine adapter kiro ${target}${kiroManifest.hookCommandSuffix}`;
  const cli = json("tests/fixtures/kiro-hook-payloads/cli-2.29.0.json") as Record<string, Record<string, unknown>>;

  test("a matcher is a glob over the tool's name and its alias, as the CLI reads it", () => {
    expect(kiroCliMatches("execute_bash", "shell")).toBe(true);
    expect(kiroCliMatches("fs_write", "write")).toBe(true);
    expect(kiroCliMatches("fs_read", "read")).toBe(true);
    expect(kiroCliMatches("subagent", "subagent")).toBe(true);
    expect(kiroCliMatches("subagent", "summary")).toBe(false);
    expect(kiroCliMatches("*", "summary")).toBe(true);
  });

  test("each event fires the conductor's registrations in file order, and a helper its own agent's, named", () => {
    const aidlc = agent("aidlc");
    expect(kiroCliWired(aidlc, "preToolUse", "shell")).toEqual(
      ["state-transition-guard", "guard-tool-call", "review-freeze", "plan-approval-guard"].map(kiro));
    expect(kiroCliWired(aidlc, "preToolUse", "write")).toEqual(["review-freeze", "plan-approval-guard"].map(kiro));
    expect(kiroCliWired(aidlc, "preToolUse", "subagent")).toEqual(["deliver-stage-rules", "plan-approval-guard"].map(kiro));
    expect(kiroCliWired(aidlc, "postToolUse", "shell")).toEqual([kiro("rebuild-stage-graph")]);
    expect(kiroCliWired(aidlc, "postToolUse", "write")).toEqual([kiro("audit-and-sensors")]);
    expect(kiroCliWired(aidlc, "postToolUse", "subagent")).toEqual([kiro("log-subagent")]);
    expect(kiroCliWired(aidlc, "userPromptSubmit", null)).toEqual([kiro("verb-intercept")]);
    expect(kiroCliWired(aidlc, "stop", null)).toEqual([kiro("continue-workflow")]);
    expect(kiroCliWired(aidlc, "preToolUse", "summary")).toEqual([]);
    expect(kiroCliWired(agent("aidlc-developer-agent"), "preToolUse", "shell")).toContain(kiro("state-transition-guard aidlc-developer-agent"));
  });

  test("every payload carries the fields the CLI's recorded payload for that event carries, a helper's under its own session", () => {
    const host = new KiroCliCapture(scratch());
    const seen = playMoments(host);
    expect(keys(find(seen, "agentSpawn"))).toEqual(keys(cli.agentSpawn));
    expect(keys(find(seen, "userPromptSubmit"))).toEqual(keys(cli.userPromptSubmit));
    expect(keys(find(seen, "preToolUse", "shell"))).toEqual(keys(cli.preToolUse_shell));
    expect(keys(find(seen, "postToolUse", "shell"))).toEqual(keys(cli.postToolUse_shell));
    expect(keys(find(seen, "preToolUse", "subagent"))).toEqual(keys(cli.preToolUse_subagent));
    expect(keys(find(seen, "preToolUse", "subagent").tool_input as Record<string, unknown>))
      .toEqual(keys(cli.preToolUse_subagent.tool_input as Record<string, unknown>));
    expect(keys(find(seen, "postToolUse", "subagent"))).toEqual(keys(cli.postToolUse_subagent));
    expect(keys(find(seen, "preToolUse", "write").tool_input as Record<string, unknown>))
      .toEqual(keys(cli.helper_preToolUse_write.tool_input as Record<string, unknown>));
    expect(keys(find(seen, "stop"))).toEqual(keys(cli.stop));
    // The helper's own events: its own session, its brief as the prompt, its report.
    const spawns = seen.filter((s) => s.event === "agentSpawn");
    expect(spawns).toHaveLength(2);
    expect(spawns[1].payload.session_id).not.toBe(spawns[0].payload.session_id);
    expect(keys(find(seen, "preToolUse", "summary"))).toEqual(keys(cli.helper_preToolUse_summary));
    expect(host.picker).toBe(false);
  });
});

describe("Kiro IDE: the hook cards and Kiro IDE 1.2.37's own payloads", () => {
  const dir = join(REPO_ROOT, "dist", "kiro-ide", ".kiro", "hooks");
  const cards: KiroIdeCard[] = readdirSync(dir).filter((file) => file.endsWith(".json"))
    .map((file) => ({ file, ...(JSON.parse(readFileSync(join(dir, file), "utf-8")) as { hooks: KiroIdeCard["hooks"] }) }));
  const ide = (target: string) => `bun .kiro/tools/aidlc.ts engine adapter kiro-ide ${target}`;

  test("each trigger fires the cards that register it, a matcher read as an unanchored regex on the tool name", () => {
    expect(kiroIdeWired(cards, "SessionStart", null)).toEqual([ide("session-start")]);
    expect(kiroIdeWired(cards, "UserPromptSubmit", null)).toEqual([ide("person-message")]);
    expect(kiroIdeWired(cards, "PreToolUse", "execute_bash")).toEqual([ide("guard-tool-call")]);
    expect(kiroIdeWired(cards, "PreToolUse", "fs_write")).toEqual([ide("guard-tool-call")]);
    expect(kiroIdeWired(cards, "PreToolUse", "fs_read")).toEqual([]);
    expect(kiroIdeWired(cards, "PostToolUse", "execute_bash")).toEqual([]);
    expect(kiroIdeWired(cards, "PostToolUse", "subagent_response")).toEqual([]);
    expect(kiroIdeWired(cards, "PostToolUse", "subagent_aidlc-developer-agent")).toEqual([ide("log-subagent")]);
    expect(kiroIdeWired(cards, "Stop", null)).toEqual([ide("continue-workflow")]);
  });

  test("payloads carry the fields the payload doc records for 1.x, the chat's session on a helper's calls too", () => {
    const host = new KiroIdeCapture(scratch());
    const seen = playMoments(host);
    // docs/reference/kiro-ide-hook-payload.md: the 1.x PostToolUse capture, the 1.2.37 UserPromptSubmit row, the shell input row.
    expect(keys(find(seen, "PostToolUse", process.platform === "win32" ? "execute_pwsh" : "execute_bash")))
      .toEqual(["cwd", "hook_event_name", "session_id", "tool_input", "tool_name", "tool_response"]);
    expect(keys(find(seen, "UserPromptSubmit"))).toEqual(["cwd", "hook_event_name", "prompt", "session_id"]);
    expect(keys(find(seen, "PreToolUse", process.platform === "win32" ? "execute_pwsh" : "execute_bash").tool_input as Record<string, unknown>))
      .toEqual(["command", "cwd", "run_in_background", "timeout"]);
    expect(keys(find(seen, "PreToolUse", "fs_write").tool_input as Record<string, unknown>)).toEqual(["path", "text"]);
    expect(typeof find(seen, "PostToolUse", "fs_write").tool_response).toBe("string");
    expect(keys(find(seen, "Stop"))).toEqual(["cwd", "hook_event_name", "session_id"]);
    expect(new Set(seen.map((s) => s.payload.session_id)).size).toBe(1);
    expect(host.picker).toBe(false);
  });
});

describe("the stand-in takes the step a person-turn hook set", () => {
  // A host whose commands answer `done`, recording what the agent ran.
  class Recording extends ScopeHost {
    readonly ran: string[] = [];
    override bash(line: string): RunResult {
      this.ran.push(line);
      return { status: 0, stdout: '{"kind":"done"}', stderr: "" };
    }
  }

  test("a step the hook already ran is acted on; an exact first call is run as written; other words set nothing", () => {
    const host = new Recording(scratch());
    const agent = new AgentStandIn(host, new PersonScript(host));
    const ran = agent.fromTurn('Say this first.\n\nThe first `next` for this message has already run.\n\n--- DIRECTIVE ---\n{"kind":"print","message":"x"}\n--- END DIRECTIVE ---\n');
    expect(ran).toEqual({ kind: "print", message: "x" });
    expect(host.ran).toEqual([]);
    const first = agent.fromTurn("Your first tool call is exactly the call below, every argument kept; do not run a bare `next`.\n\nbun .kiro/tools/aidlc.ts engine orchestrate next --scope classic build it\n");
    expect(first).toEqual({ kind: "done" });
    expect(host.ran).toEqual(["bun .kiro/tools/aidlc.ts engine orchestrate next --scope classic build it"]);
    expect(agent.fromTurn("AI-DLC kept your words.")).toBeNull();
  });
});

describe("Cursor: .cursor/hooks.json and cursor-agent's own payloads", () => {
  const wiring = json("dist/cursor/.cursor/hooks.json") as { hooks: Record<string, { command: string }[]> };
  const cursor = recorded("cursor");
  const adapter = (target: string) => `bun .cursor/hooks/aidlc-cursor-adapter.ts ${target}`;

  test("each event fires the adapter targets the shipped wiring registers, with no matchers", () => {
    const host = new CursorScopeHost(scratch());
    // The shipped file, read the way the host reads it.
    mkdirSync(join(host.proj, ".cursor"), { recursive: true });
    writeFileSync(join(host.proj, ".cursor", "hooks.json"), JSON.stringify(wiring));
    expect(host.wired("sessionStart")).toEqual([adapter("session-start")]);
    expect(host.wired("beforeSubmitPrompt")).toEqual([adapter("mint")]);
    expect(host.wired("preToolUse")).toEqual([adapter("guards")]);
    expect(host.wired("postToolUse")).toEqual([adapter("audit-and-sensors"), adapter("runtime-compile")]);
    expect(host.wired("stop")).toEqual([adapter("stop")]);
  });

  test("every payload carries the fields cursor-agent's recorded payload for that event carries; a helper's calls its own conversation", () => {
    const seen = playMoments(new CursorCapture(scratch()));
    expect(keys(find(seen, "sessionStart"))).toEqual(keys(cursor.sessionStart));
    expect(keys(find(seen, "beforeSubmitPrompt"))).toEqual(keys(cursor.beforeSubmitPrompt));
    expect(keys(find(seen, "preToolUse", "Shell"))).toEqual(keys(cursor.preToolUseShell));
    expect(keys(find(seen, "postToolUse", "Shell"))).toEqual(keys(cursor.postToolUseShell));
    expect(keys(find(seen, "preToolUse", "Write"))).toEqual(keys(cursor.preToolUseWrite));
    expect(keys(find(seen, "postToolUse", "Write"))).toEqual(keys(cursor.postToolUseWrite));
    expect(keys(find(seen, "preToolUse", "Task"))).toEqual(keys(cursor.preToolUseTask));
    expect(keys(find(seen, "postToolUse", "Task"))).toEqual(keys(cursor.postToolUseTask));
    expect(keys(find(seen, "stop"))).toEqual(keys(cursor.stop));
    const task = find(seen, "preToolUse", "Task");
    expect(task.generation_id).not.toBe(task.conversation_id);
  });

  test("an answer is read as Cursor reads it: a deny refuses with its message, anything but an allow refuses, a follow-up keeps the turn going", () => {
    expect(cursorRefusal('{"permission":"allow"}\n')).toBeNull();
    expect(cursorRefusal('{"permission":"deny","agent_message":"Approve the plan first."}\n')).toBe("Approve the plan first.");
    expect(cursorRefusal("")).toContain("failClosed");
    expect(cursorStopVerdict('{"followup_message":"AI-DLC is carrying on."}')).toEqual({ blocked: true, reason: "AI-DLC is carrying on." });
    expect(cursorStopVerdict("")).toEqual({ blocked: false, reason: "" });
  });
});

describe("opencode: one plugin instance in a process the host waits on", () => {
  // A plugin that answers the way AI-DLC's does (a throw refuses, a turn end may
  // nudge, a task's brief may be rewritten) and keeps what it saw.
  const STUB = `export default async ({ client }) => {
  const seen = [];
  return {
    "chat.message": async (input, output) => { seen.push(input.sessionID + ": " + output.parts[0].text); },
    "tool.execute.before": async (input, output) => {
      if (String(output.args.command ?? "").includes("refuse-me")) throw new Error("refused by the plugin");
      if (input.tool === "task") output.args = { ...output.args, prompt: "the rewritten brief" };
    },
    "tool.execute.after": async () => {},
    event: async ({ event }) => {
      if (event.type === "session.idle") await client.session.prompt({ path: { id: event.properties.sessionID }, body: { parts: [{ type: "text", text: seen.join(" | ") }] } });
    },
  };
};
`;

  test("its state lasts between calls, a throw is a refusal, a rewritten brief reaches the helper, and a nudge keeps the turn going", () => {
    const proj = scratch();
    mkdirSync(join(proj, ".opencode", "plugin"), { recursive: true });
    writeFileSync(join(proj, ".opencode", "plugin", "aidlc-opencode-adapter.ts"), STUB);
    const host = new OpencodeScopeHost(proj);
    try {
      host.typed("first words");
      host.task("aidlc-developer-agent", "the brief as asked", () => {});
      expect(() => host.bash("bun --version refuse-me")).toThrow(ScopeRunRefused);
      const verdict = host.stop();
      expect(verdict.blocked).toBe(true);
      const [main, helper] = verdict.reason.split(" | ");
      expect(main).toBe(`${host.session}: first words`);
      expect(helper.startsWith(`${host.session}_child`)).toBe(true);
      expect(helper.endsWith(": the rewritten brief")).toBe(true);
      expect(host.refusals).toHaveLength(1);
    } finally {
      host.dispose();
    }
  });

  test("a command whose chat the plugin does not name stops, unless the plugin came from a release before it named one", () => {
    const proj = scratch();
    mkdirSync(join(proj, ".opencode", "plugin"), { recursive: true });
    writeFileSync(join(proj, ".opencode", "plugin", "aidlc-opencode-adapter.ts"), STUB);
    const host = new OpencodeScopeHost(proj);
    try {
      expect(() => host.bash("bun --version")).toThrow("the opencode plugin named no chat for bun --version");
      host.release = "2.11.0";
      expect(host.bash("bun --version").status).toBe(0);
      host.release = "2.11.1-preview.20261015.1";
      expect(host.bash("bun --version").status).toBe(0);
      host.release = "2.11.1-preview.20261016.1";
      expect(() => host.bash("bun --version")).toThrow("the opencode plugin named no chat");
      host.release = "2.11.1";
      expect(() => host.bash("bun --version")).toThrow("the opencode plugin named no chat");
    } finally {
      host.dispose();
    }
  });
});
