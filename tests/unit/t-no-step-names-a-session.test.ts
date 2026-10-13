// covers: stage:code-generation, hook:aidlc-session-start, function:resolvePlanApprovalSession
//
// No step the agent reads asks it for a session id. Every command that takes
// one finds the session it runs in (resolvePlanApprovalSession, replySession,
// checkpointSession, verificationCommandSession all fall back to
// resolveInvokingSessionId), yet the Code Generation step still wrote
// `--session "<Runtime Session from SessionStart context>"` into the two Plan
// Approval commands, and every session start told the agent to keep that value
// for such an argument. On Kiro that sent the agent looking for the id and, in
// one live run, asking to read the person's environment (#1890, #1898, #2148
// are the same shape in other commands).
//
// `--session` stays an override for automation and for the case where nothing
// resolves, so the third case pins that the flag is still accepted and still
// named by the refusal that needs it.

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { AIDLC_SRC, REPO_ROOT, cleanupTestProject, createTestProject } from "../harness/fixtures.ts";
import { NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";

setDefaultTimeout(NATIVE_STARTUP_TIMEOUT_MS);

const BUN = process.execPath;
const SESSION_START = join(AIDLC_SRC, "hooks", "aidlc-session-start.ts");
const SESSION = "01995000-7a11-7000-8000-0000000052a1";
const created: string[] = [];
afterEach(() => {
  for (const dir of created.splice(0)) cleanupTestProject(dir);
});

// Everything the agent reads: the stages and protocols, the orchestrator skills
// of every harness, the agent personas, the shipped knowledge, the method and
// the onboarding templates.
const SHIPPED = [
  join(REPO_ROOT, "core", "aidlc-common"),
  join(REPO_ROOT, "core", "skills"),
  join(REPO_ROOT, "core", "agents"),
  join(REPO_ROOT, "core", "knowledge"),
  join(REPO_ROOT, "core", "memory"),
  join(REPO_ROOT, "core", "templates"),
  ...readdirSync(join(REPO_ROOT, "harness"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(REPO_ROOT, "harness", entry.name, "skills")),
];

function prose(roots: readonly string[]): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (/\.(md|mdc|toml|json)$/.test(entry.name)) out.push(path);
      }
    } catch {
      // A tree this harness does not ship contributes nothing.
    }
  };
  for (const root of roots) {
    try {
      if (statSync(root).isDirectory()) walk(root);
    } catch {
      // A harness without its own skills dir ships none.
    }
  }
  return out;
}

const rel = (path: string): string => path.slice(REPO_ROOT.length + 1).split(sep).join("/");

describe("no step the agent reads asks it for a session id", () => {
  test("no shipped step, skill, persona, knowledge or template names --session", () => {
    const offenders: string[] = [];
    for (const path of prose(SHIPPED)) {
      for (const [index, line] of readFileSync(path, "utf-8").split("\n").entries()) {
        if (line.includes("--session")) offenders.push(`${rel(path)}:${index + 1}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("a session start hands the agent its session without asking it to carry the value", () => {
    const proj = createTestProject();
    created.push(proj);
    const fired = Bun.spawnSync({
      cmd: [BUN, SESSION_START],
      stdin: new TextEncoder().encode(
        JSON.stringify({ hook_event_name: "SessionStart", session_id: SESSION, source: "startup", cwd: proj }),
      ),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, CLAUDE_PROJECT_DIR: proj },
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    });
    const out = new TextDecoder().decode(fired.stdout);
    // The line itself stays: a refusal that cannot resolve the session points at it.
    expect(out).toContain(`AIDLC Runtime Session: ${SESSION}`);
    expect(out).not.toContain("--session");
  });

  test("the override stays: every command that took the flag still reads it", () => {
    // Each tool reads it its own way: two name the flag where they parse argv,
    // and the checkpoint tool takes it through its generic flag map.
    const readers: Array<[string, string]> = [
      ["aidlc-log.ts", '"--session"'],
      ["aidlc-testing-posture.ts", '"--session"'],
      ["aidlc-bolt.ts", "flags.session"],
    ];
    for (const [tool, shape] of readers) {
      const source = readFileSync(join(REPO_ROOT, "core", "tools", tool), "utf-8");
      expect({ tool, reads: source.includes(shape) }).toEqual({ tool, reads: true });
    }
    // And the refusal reached only when no session resolves still names it, so
    // automation and a cold chat keep their way through.
    expect(readFileSync(join(REPO_ROOT, "core", "tools", "aidlc-log.ts"), "utf-8"))
      .toContain("--session");
  });
});
