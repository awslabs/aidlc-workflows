// t332-devin-adapter: pipe Devin hook payloads through the SHIPPED adapter and
// assert the on-the-wire contracts.
//
// covers: hook:aidlc-record-human-turn, hook:aidlc-log-subagent
//
// The fixture corpus (tests/fixtures/devin-hook-payloads/payloads.json) is shaped
// against Devin CLI 3000.6.7, probed live in a trusted scratch workspace. Devin's
// stdin/stdout envelope IS Claude Code's, so unlike the Codex adapter this one
// reshapes nothing -- it translates TOOL NAMES and otherwise passes through. The
// contracts under test are therefore:
//
//   - TOOL_MAP: every Devin lowercase snake_case name reaches the core hook as the
//     PascalCase name that hook compares INTERNALLY. Three core hooks
//     (review-freeze, reviewer-scope, state-transition-guard) test `tool_name`
//     themselves rather than relying on the matcher, so a missed mapping leaves
//     them loaded, matching, and silently no-op.
//   - The picker deny: ask_user_question is refused while the selected workflow is
//     Running, using DEVIN's block dialect ({"decision":"block"} on stdout at exit
//     0) and NOT Copilot's permissionDecision. It FAILS OPEN on every uncertain
//     case, because a project that carries the shell but never ran AI-DLC must keep
//     its native picker.
//   - Fail-open on malformed stdin and on an unknown subcommand: a packaging slip
//     must never block a user's turn.
//
// Unlike the peer adapters this one has no run() export (it is a top-level script
// that ends in process.exit), so every case spawns the real emitted file. That is
// the shipped path, not a re-implementation of it.

import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

setDefaultTimeout(30_000);

const REPO_ROOT = join(import.meta.dir, "..", "..");
const DIST = join(REPO_ROOT, "dist", "devin");
const PAYLOADS = JSON.parse(
  readFileSync(
    join(import.meta.dir, "..", "fixtures", "devin-hook-payloads", "payloads.json"),
    "utf-8",
  ),
) as Record<string, Record<string, unknown>>;

/** Seed a throwaway project from the emitted tree. */
function seedProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "aidlc-t332-"));
  cpSync(join(DIST, ".devin"), join(dir, ".devin"), { recursive: true });
  cpSync(join(DIST, "aidlc"), join(dir, "aidlc"), { recursive: true });
  cpSync(join(DIST, "AGENTS.md"), join(dir, "AGENTS.md"));
  return dir;
}

/** Give the project a workflow whose state carries the given Status. */
function seedWorkflow(dir: string, status: string): void {
  const record = join(dir, "aidlc", "spaces", "default", "intents", "t332-probe");
  mkdirSync(record, { recursive: true });
  writeFileSync(
    join(record, "aidlc-state.md"),
    [
      "# AI-DLC Workflow State",
      "",
      "- **Intent**: t332-probe",
      "- **State Version**: 8",
      `- **Status**: ${status}`,
      "- **Current Stage**: intent-capture",
      "",
    ].join("\n"),
    "utf-8",
  );
  writeFileSync(
    join(dir, "aidlc", "spaces", "default", "intents", "active-intent"),
    "t332-probe\n",
    "utf-8",
  );
}

interface Fired {
  status: number | null;
  stdout: string;
  stderr: string;
}

function fire(dir: string, subcommand: string, payload: unknown): Fired {
  const adapter = join(dir, ".devin", "hooks", "aidlc-devin-adapter.ts");
  const r = spawnSync(process.execPath, [adapter, subcommand], {
    input: typeof payload === "string" ? payload : JSON.stringify(payload),
    cwd: dir,
    encoding: "utf-8",
    env: { ...process.env, DEVIN_PROJECT_DIR: dir, AIDLC_PROJECT_DIR: dir },
  });
  return {
    status: r.status,
    stdout: String(r.stdout ?? ""),
    stderr: String(r.stderr ?? ""),
  };
}

describe("t332 devin adapter — on-the-wire contracts", () => {
  test("1: the fixture corpus covers every wired event", () => {
    const wiring = JSON.parse(
      readFileSync(join(DIST, ".devin", "hooks.v1.json"), "utf-8"),
    ) as Record<string, unknown>;
    // Every event the emitted config registers should have at least one payload
    // in the corpus, or the corpus is not exercising the shipped wiring.
    const covered = new Set(
      Object.values(PAYLOADS)
        .filter((p): p is Record<string, unknown> => typeof p === "object" && p !== null)
        .map((p) => p.hook_event_name)
        .filter((n): n is string => typeof n === "string"),
    );
    for (const event of Object.keys(wiring)) {
      expect(covered.has(event), `corpus covers wired event ${event}`).toBe(true);
    }

    // ...and every TOOL NAME the matchers select. Event coverage alone is too weak:
    // it passed while `read_subagent` sat in the log-subagent matcher with no payload
    // in the corpus, so nothing ever exercised that arm -- and because
    // aidlc-log-subagent.ts appends SUBAGENT_COMPLETED with no dedupe, the untested
    // arm was writing duplicate "unknown" events into an append-only ledger. A wired
    // tool with no payload is an arm no test can see.
    const coveredTools = new Set(
      Object.values(PAYLOADS)
        .filter((p): p is Record<string, unknown> => typeof p === "object" && p !== null)
        .map((p) => p.tool_name)
        .filter((n): n is string => typeof n === "string"),
    );
    for (const [event, groups] of Object.entries(wiring)) {
      for (const group of groups as Array<{ matcher?: string }>) {
        const matcher = group.matcher ?? "";
        if (matcher === "") continue; // matcher-free arms fire for every tool
        for (const tool of matcher.replace(/[\^$()]/g, "").split("|").filter(Boolean)) {
          expect(
            coveredTools.has(tool),
            `corpus has a payload for ${tool}, wired on ${event}`,
          ).toBe(true);
        }
      }
    }
  });

  test("2: TOOL_MAP translates every Devin name the core hooks compare internally", () => {
    const adapter = readFileSync(
      join(DIST, ".devin", "hooks", "aidlc-devin-adapter.ts"),
      "utf-8",
    );
    // The three internal comparisons the mapping exists to satisfy.
    for (const [devinName, claudeName] of [
      ["exec", "Bash"],
      ["edit", "Edit"],
      ["apply_patch", "Edit"],
      ["write", "Write"],
      ["notebook_edit", "NotebookEdit"],
      ["grep", "Grep"],
      ["glob", "Glob"],
      ["read", "Read"],
      ["run_subagent", "Task"],
      ["todo_write", "TaskUpdate"],
    ] as const) {
      expect(
        new RegExp(`${devinName}\\s*:\\s*"${claudeName}"`).test(adapter),
        `${devinName} -> ${claudeName}`,
      ).toBe(true);
    }
  });

  test("3: the picker is denied while the selected workflow is Running", () => {
    const dir = seedProject();
    try {
      seedWorkflow(dir, "Running");
      const r = fire(dir, "deliver-stage-rules", PAYLOADS.preToolUseAskUserQuestion);
      // Devin's own block dialect: decision on stdout, exit 0. NOT Copilot's
      // hookSpecificOutput.permissionDecision, which is undocumented here.
      expect(r.status).toBe(0);
      const parsed = JSON.parse(r.stdout) as { decision?: string; reason?: string };
      expect(parsed.decision).toBe("block");
      expect(parsed.reason).toContain("question-rendering.md");
      expect(r.stdout).not.toContain("permissionDecision");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("4: the picker FAILS OPEN when no workflow is running", () => {
    const dir = seedProject();
    try {
      // Status that is not Running, plus the no-state case below.
      seedWorkflow(dir, "Complete");
      const settled = fire(dir, "deliver-stage-rules", PAYLOADS.preToolUseAskUserQuestion);
      expect(settled.status).toBe(0);
      expect(settled.stdout).not.toContain('"decision":"block"');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("5: the picker FAILS OPEN when there is no workflow state at all", () => {
    const dir = seedProject();
    try {
      const r = fire(dir, "deliver-stage-rules", PAYLOADS.preToolUseAskUserQuestion);
      expect(r.status).toBe(0);
      expect(r.stdout).not.toContain('"decision":"block"');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("6: a non-picker tool on the same arm is never denied", () => {
    const dir = seedProject();
    try {
      seedWorkflow(dir, "Running");
      for (const key of ["preToolUseRead", "preToolUseGrep", "preToolUseExec"] as const) {
        const r = fire(dir, "deliver-stage-rules", PAYLOADS[key]);
        expect(r.stdout, `${key} not denied by the picker branch`).not.toContain(
          "question-rendering.md",
        );
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("7: malformed stdin fails open rather than blocking the turn", () => {
    const dir = seedProject();
    try {
      seedWorkflow(dir, "Running");
      for (const junk of ["", "not json", "{unterminated"]) {
        const r = fire(dir, "deliver-stage-rules", junk);
        expect(r.status, `junk stdin ${JSON.stringify(junk)} fails open`).toBe(0);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("8: an unknown subcommand fails open (packaging slip must not block)", () => {
    const dir = seedProject();
    try {
      const r = fire(dir, "no-such-subcommand", PAYLOADS.preToolUseExec);
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("9: subagent completion reaches the audit trail", () => {
    const dir = seedProject();
    try {
      seedWorkflow(dir, "Running");
      const r = fire(dir, "log-subagent", PAYLOADS.postToolUseRunSubagent);
      expect(r.status).toBe(0);
      // Devin has no SubagentStop, so this rides PostToolUse on the delegation
      // tools. The event must still land, attributed to the profile that ran.
      const auditDir = join(
        dir,
        "aidlc",
        "spaces",
        "default",
        "intents",
        "t332-probe",
        "audit",
      );
      const shards = readFileSync(
        join(auditDir, require("node:fs").readdirSync(auditDir)[0]),
        "utf-8",
      );
      expect(shards).toContain("SUBAGENT_COMPLETED");
      expect(shards).toContain("aidlc-developer-agent");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("11: a read_subagent poll does NOT log a second completion", () => {
    // aidlc-log-subagent.ts has no dedupe: it appends SUBAGENT_COMPLETED on every
    // invocation where Status is Running. read_subagent is a POLL on a backgrounded
    // delegate -- an agent may issue it repeatedly, and the payload has no agent_type
    // -- so letting it through logged one extra "unknown" completion per read. This
    // pins BOTH lines of defence: emit.ts matches only ^run_subagent$, and the
    // adapter re-checks the original Devin tool name before dispatching.
    const dir = seedProject();
    try {
      seedWorkflow(dir, "Running");
      const auditDir = join(
        dir, "aidlc", "spaces", "default", "intents", "t332-probe", "audit",
      );
      const countEvents = (): number => {
        const fs = require("node:fs") as typeof import("node:fs");
        if (!fs.existsSync(auditDir)) return 0;
        return fs
          .readdirSync(auditDir)
          .map((f: string) => readFileSync(join(auditDir, f), "utf-8"))
          .join("")
          .split("SUBAGENT_COMPLETED").length - 1;
      };

      // One real delegation, then two polls of the same delegate.
      expect(fire(dir, "log-subagent", PAYLOADS.postToolUseRunSubagent).status).toBe(0);
      const afterDelegation = countEvents();
      expect(afterDelegation).toBe(1);

      expect(fire(dir, "log-subagent", PAYLOADS.postToolUseReadSubagent).status).toBe(0);
      expect(fire(dir, "log-subagent", PAYLOADS.postToolUseReadSubagent).status).toBe(0);

      // Still exactly one, and no "unknown" attribution anywhere in the ledger.
      expect(countEvents()).toBe(1);
      const fs = require("node:fs") as typeof import("node:fs");
      const ledger = fs
        .readdirSync(auditDir)
        .map((f: string) => readFileSync(join(auditDir, f), "utf-8"))
        .join("");
      expect(ledger).not.toContain("**Agent Type**: unknown");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("10: the picker set is separate from the matchable tool list", () => {
    // ask_user_question is NOT a documented matchable Devin tool name, so it must
    // never appear in a hooks.v1.json matcher (emit.ts would reject the build) and
    // the deny must live on the matcher-free arm instead.
    const wiring = readFileSync(join(DIST, ".devin", "hooks.v1.json"), "utf-8");
    expect(wiring).not.toContain("ask_user_question");
    const adapter = readFileSync(
      join(DIST, ".devin", "hooks", "aidlc-devin-adapter.ts"),
      "utf-8",
    );
    expect(adapter).toContain("DEVIN_QUESTION_PICKERS");
    expect(adapter).toContain("ask_user_question");
    // Devin's dialect, not Copilot's. Matched loosely on the key/value pair so a
    // reformat does not fail the test, but the WRONG dialect still does.
    expect(adapter).toMatch(/decision:\s*"block"/);
    // Copilot's permissionDecision must not be EMITTED here. The word appears in a
    // comment explaining why it is not used, so strip comment lines before
    // asserting - checking the raw file would fail on its own rationale.
    const code = adapter
      .split(/\r?\n/)
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
    expect(code).not.toContain("permissionDecision");
  });
});
