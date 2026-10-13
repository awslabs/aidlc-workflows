// covers: function:currentTerminalRequest, function:takeTerminalRequest, subcommand:aidlc-utility:config-change, subcommand:aidlc-utility:intent-create
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import {
  AIDLC_SRC, cleanupTestProject, createOrchestrationTestProject, FIXTURES_DIR, seededRecordDir, seededStateFile,
} from "../harness/fixtures.ts";
import { env, exec, say, SESSION, SECOND_SESSION } from "../harness/aidlc-input-corpus.ts";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS } from "../harness/test-budget.ts";
import { currentTerminalRequest, takeTerminalRequest } from "../../dist/claude/.claude/tools/aidlc-terminal-request.ts";
import { saveMessage, type StoredMessage } from "../../dist/claude/.claude/tools/aidlc-message-store.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
const projects: string[] = [];
afterEach(() => { for (const proj of projects.splice(0)) cleanupTestProject(proj); });

function terminal(): string {
  const proj = createOrchestrationTestProject();
  projects.push(proj);
  writeFileSync(seededStateFile(proj), readFileSync(join(FIXTURES_DIR, "state-completed.md"), "utf-8"));
  return proj;
}
const selection = (proj: string, sessionId = SESSION) => ({
  space: "default", intent: basename(seededRecordDir(proj)), sessionId,
});
function prompt(proj: string, overrides: Partial<Omit<StoredMessage, "id">> = {}): StoredMessage {
  return saveMessage(proj, {
    session: SESSION, at: new Date(Date.now() - 1000).toISOString(), source: "prompt",
    text: "/aidlc --plan-approval off", words: null, picker: null,
    settings: [{ key: "plan-approval", value: "off" }],
    route: { scope: null, newIntent: false, skip: [], add: [], projectType: null },
    workflow: { space: "default", intent: selection(proj).intent, status: "Completed" },
    ...overrides,
  });
}
async function utility(proj: string, args: string[], unattended = false) {
  return exec([process.execPath, join(AIDLC_SRC, "tools", "aidlc-utility.ts"), ...args, "--project-dir", proj], {
    cwd: proj, env: env(proj, { env: unattended ? { AIDLC_UNATTENDED: "1" } : {} }),
  });
}
const output = (result: { stdout: string; stderr: string }) => `${result.stdout}${result.stderr}`;
function audit(proj: string): string {
  const dir = join(seededRecordDir(proj), "audit");
  return existsSync(dir)
    ? readdirSync(dir).filter((name) => name.endsWith(".md")).map((name) => readFileSync(join(dir, name), "utf-8")).join("")
    : "";
}

describe("terminal request authority is current, chat-bound and spent separately from routing", () => {
  test("handing out the line leaves one settings operation, without adding a human turn", () => {
    const proj = terminal();
    const message = prompt(proj);
    const request = currentTerminalRequest(proj, selection(proj), "line");
    expect(request?.id).toBe(message.id);
    expect(takeTerminalRequest(proj, request!, "line")).toBe(true);
    expect(takeTerminalRequest(proj, request!, "line")).toBe(false);
    expect(currentTerminalRequest(proj, selection(proj), "line")).toBeNull();
    expect(currentTerminalRequest(proj, selection(proj), "settings")?.id).toBe(message.id);
  });

  for (const [name, overrides] of [
    ["pre-completion", { workflow: undefined }],
    ["another chat", { session: SECOND_SESSION }],
    ["another intent", { workflow: { space: "default", intent: "other", status: "Completed" } }],
    ["expired", { at: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString() }],
    ["picker", { source: "picker" }],
  ] as const) {
    test(`${name} message does not authorize the selected terminal work`, () => {
      const proj = terminal();
      prompt(proj, overrides as Partial<Omit<StoredMessage, "id">>);
      expect(currentTerminalRequest(proj, selection(proj), "settings")).toBeNull();
    });
  }

  test("an unarchive that restores Completed keeps the same prompt's remaining explicit request", () => {
    const proj = terminal();
    const message = prompt(proj, { workflow: { space: "default", intent: selection(proj).intent, status: "Archived" } });
    expect(currentTerminalRequest(proj, selection(proj), "settings")?.id).toBe(message.id);
  });

  test("a newer message supersedes an earlier proof before it is spent", () => {
    const proj = terminal();
    prompt(proj);
    const request = currentTerminalRequest(proj, selection(proj), "settings")!;
    prompt(proj, { at: new Date().toISOString(), text: "leave those settings alone", words: "leave those settings alone" });
    expect(takeTerminalRequest(proj, request, "settings")).toBe(false);
  });

  test("the setter attributes current terminal words and refuses their replay after restoring the check", async () => {
    const proj = terminal();
    const message = prompt(proj);
    const changed = await utility(proj, ["config-change", "--plan-approval", "off"]);
    expect(changed.status, output(changed)).toBe(0);
    expect(readFileSync(seededStateFile(proj), "utf-8")).toContain("Plan Approval**: off (set by you)");
    expect(audit(proj)).toContain(`**Message Id**: ${message.id}`);
    expect(audit(proj)).not.toContain("**Event**: HUMAN_TURN");
    const restored = await utility(proj, ["config-change", "--plan-approval", "on"]);
    expect(restored.status, output(restored)).toBe(0);
    const replay = await utility(proj, ["config-change", "--plan-approval", "off"]);
    expect(replay.status, output(replay)).not.toBe(0);
  });

  test("a pre-completion message cannot lower a terminal setting", async () => {
    const proj = terminal();
    prompt(proj, { workflow: undefined });
    const result = await utility(proj, ["config-change", "--plan-approval", "off"]);
    expect(result.status, output(result)).not.toBe(0);
  });

  test("the unattended restriction still refuses a fresh terminal request", async () => {
    const proj = terminal();
    prompt(proj);
    const result = await utility(proj, ["config-change", "--plan-approval", "off"], true);
    expect(result.status, output(result)).not.toBe(0);
  });

  test("a team-held strict policy still refuses a fresh terminal request", async () => {
    const proj = terminal();
    const memory = join(proj, "aidlc", "spaces", "default", "memory");
    mkdirSync(memory, { recursive: true });
    writeFileSync(join(memory, "project.md"), "# Project\n\n## Guard Policy\n\nMode: strict\n");
    prompt(proj);
    const result = await utility(proj, ["config-change", "--plan-approval", "off"]);
    expect(result.status, output(result)).not.toBe(0);
    expect(output(result)).toContain("plan approval stays on for everyone");
  });

  test("a new intent can carry the person's lowered setting without a human turn in the completed record", async () => {
    const proj = terminal();
    prompt(proj, { text: "/aidlc --scope bugfix --plan-approval off fix a new bug", words: "fix a new bug" });
    const oldState = readFileSync(seededStateFile(proj), "utf-8");
    const before = audit(proj);
    const result = await utility(proj, ["intent-create", "--scope", "bugfix", "--label", "new bug", "--arguments", "fix a new bug", "--plan-approval", "off"]);
    expect(result.status, output(result)).toBe(0);
    expect(readFileSync(seededStateFile(proj), "utf-8")).toBe(oldState);
    expect(audit(proj)).toBe(before);
    const intents = join(proj, "aidlc", "spaces", "default", "intents");
    const active = readFileSync(join(intents, "active-intent"), "utf-8").trim();
    expect(active).not.toBe(selection(proj).intent);
    expect(readFileSync(join(intents, active, "aidlc-state.md"), "utf-8")).toContain("Plan Approval**: off (set by you)");
  });

  test("Codex payload through source adapter: completed A stays quiet through ordinary chat, then bare next starts B from the explicit line", async () => {
    const proj = terminal();
    const oldState = readFileSync(seededStateFile(proj), "utf-8");
    const before = audit(proj);
    const ordinary = await say(proj, "tell me about SQLite", "codex");
    expect(ordinary.status, output(ordinary)).toBe(0);
    expect(audit(proj)).toBe(before);
    expect(readFileSync(seededStateFile(proj), "utf-8")).toBe(oldState);
    const adapter = join(proj, ".codex", "hooks", "aidlc-codex-adapter.ts");
    const nativePrompt = (text: string, turn: string) => exec([process.execPath, adapter, "record-human-turn"], {
      cwd: proj, env: env(proj),
      input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: SESSION, turn_id: turn, cwd: proj, prompt: text }),
    });
    const asked = await nativePrompt("$aidlc --new-intent --scope bugfix fix the new parser", "terminal-new-work");
    expect(asked.status, output(asked)).toBe(0);
    const routed = await exec([process.execPath, join(proj, ".codex", "tools", "aidlc-orchestrate.ts"), "next", "--resume", "--project-dir", proj], {
      cwd: proj, env: env(proj),
    });
    expect(routed.status, output(routed)).toBe(0);
    const request = /--request ([0-9a-f]{8})/.exec(routed.stdout)?.[1];
    expect(request, output(routed)).toBeDefined();
    const created = await exec([process.execPath, join(proj, ".codex", "tools", "aidlc-utility.ts"),
      "intent-create", "--scope", "bugfix", "--request", request!, "--label", "new parser", "--project-dir", proj], {
      cwd: proj, env: env(proj),
    });
    expect(created.status, output(created)).toBe(0);
    const intents = join(proj, "aidlc", "spaces", "default", "intents");
    const active = readFileSync(join(intents, "active-intent"), "utf-8").trim();
    expect(active).not.toBe(selection(proj).intent);
    expect(readFileSync(join(intents, active, "aidlc-state.md"), "utf-8")).toContain("fix the new parser");
    const continued = await nativePrompt("keep the parser compatible with quoted arguments", "new-work-running");
    expect(continued.status, output(continued)).toBe(0);
    const newAudit = readdirSync(join(intents, active, "audit"))
      .map((name) => readFileSync(join(intents, active, "audit", name), "utf-8")).join("");
    expect(newAudit).toContain("**Event**: HUMAN_TURN");
    expect(audit(proj)).toBe(before);
    expect(readFileSync(seededStateFile(proj), "utf-8")).toBe(oldState);
  });
});
