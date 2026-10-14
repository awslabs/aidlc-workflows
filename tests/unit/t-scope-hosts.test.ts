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
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO_ROOT } from "../harness/fixtures.ts";
import {
  CodexScopeHost,
  codexPatch,
  codexWired,
  CopilotScopeHost,
  copilotWired,
} from "../harness/scope-hosts.ts";

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

/** Each moment the scope run plays, once. */
function playMoments(host: CodexCapture | CopilotCapture): Seen[] {
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
