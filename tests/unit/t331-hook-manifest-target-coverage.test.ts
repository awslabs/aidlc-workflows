// covers: hook:aidlc-continue-workflow, hook:aidlc-session-start, hook:aidlc-record-human-turn, hook:aidlc-plan-approval-guard, hook:aidlc-write-audit-log, hook:aidlc-review-freeze, hook:aidlc-deliver-stage-rules
//
// The Kiro row serves two surfaces from one shell, and nothing else checks that
// its hook wiring actually reaches both. Three ways it can fail silently:
//
//   1. A manifest names an adapter target that does not exist. `doctor` reports a
//      healthy project, `graph compile --check` passes, and the type checker never
//      sees the string because it travels from JSON through
//      `aidlc engine adapter <harness> <target>` as plain argv. For a PreToolUse
//      gate it fails OPEN - an adapter with no handler returns null and the
//      dispatcher exits 0.
//   2. A responsibility is registered on a trigger only one surface fires.
//      `docs/features/hooks.md` (Available triggers) gives Session Start as IDE
//      only and Agent Spawn as CLI only, so a lifecycle hook needs BOTH names or
//      it is dead on one surface.
//   3. A responsibility that must be able to refuse a tool call is registered on a
//      trigger that cannot block. The same table gives Prompt Submit, Pre Tool Use
//      and Pre Task Execution as the only blocking triggers; Post* and Stop cannot
//      block, so moving a guard there turns a refusal into a bystander.
//
// This encodes the contract instead of the current file list, so a missing
// manifest is a failure rather than an absence nothing looks for.
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const SUBJECTS = [
  { harness: "kiro", harnessDir: ".kiro", adapter: "hooks/aidlc-kiro-adapter.ts" },
] as const;

// docs/features/hooks.md - Available triggers. PascalCase spellings as the schema
// section gives them.
const KNOWN_TRIGGERS = new Set([
  "UserPromptSubmit",
  "Stop",
  "SessionStart",
  "AgentSpawn",
  "PreToolUse",
  "PostToolUse",
  "PostFileCreate",
  "PostFileSave",
  "PostFileDelete",
  "PreTaskExecution",
  "PostTaskExecution",
]);
const BLOCKING_TRIGGERS = new Set([
  "UserPromptSubmit",
  "PreToolUse",
  "PreTaskExecution",
]);
/** Triggers only one surface fires, per the same table. */
const SURFACE_ONLY: Record<string, "ide" | "cli"> = {
  SessionStart: "ide",
  AgentSpawn: "cli",
  PostFileCreate: "ide",
  PostFileSave: "ide",
  PostFileDelete: "ide",
  PreTaskExecution: "ide",
  PostTaskExecution: "ide",
};

// What the row must register, and on which triggers. Grounded in two places: the
// pre-merge agent-v1 registration this row carried (its `hooks` dict named the
// event for each target) and the manifests the IDE row shipped. `blocking: true`
// means the responsibility refuses tool calls, so a non-blocking trigger is wrong
// for it whatever else is true.
const REQUIRED: Array<{
  target: string;
  triggers: string[];
  blocking?: true;
  why: string;
}> = [
  {
    target: "session-start",
    triggers: ["SessionStart", "AgentSpawn"],
    why: "lifecycle start; SessionStart is IDE-only and AgentSpawn is CLI-only, so one shell needs both",
  },
  { target: "verb-intercept", triggers: ["UserPromptSubmit"], why: "reads the /aidlc verb off the prompt" },
  { target: "record-human-turn", triggers: ["UserPromptSubmit"], why: "records the human turn" },
  { target: "continue-workflow", triggers: ["Stop"], why: "advances after the agent finishes" },
  { target: "plan-approval-guard", triggers: ["PreToolUse"], blocking: true, why: "refuses writes before plan approval" },
  { target: "enforce-approval-gate", triggers: ["PreToolUse"], blocking: true, why: "refuses work past an unapproved gate" },
  { target: "terminal-command-guard", triggers: ["PreToolUse"], blocking: true, why: "refuses non-deterministic terminal commands" },
  {
    target: "review-freeze",
    triggers: ["PreToolUse"],
    blocking: true,
    why: "refuses edits while a review is frozen; PostToolUse audit cannot substitute because it cannot block",
  },
  {
    target: "state-transition-guard",
    triggers: ["PreToolUse"],
    blocking: true,
    why: "refuses a hand-run lifecycle verb; the engine owns state transitions",
  },
  {
    target: "reviewer-scope",
    triggers: ["PreToolUse"],
    blocking: true,
    why: "refuses a dispatched reviewer's work outside the artifact it was asked to review",
  },
  { target: "audit-and-sensors", triggers: ["PostToolUse"], why: "audits the write and runs sensors" },
  { target: "rebuild-stage-graph", triggers: ["PostToolUse"], why: "rebuilds the compiled graph after a shell step" },
  { target: "sync-workflow-state", triggers: ["PostToolUse"], why: "reconciles Current Stage from the audit tail" },
  {
    target: "log-subagent",
    triggers: ["PreToolUse", "PostToolUse"],
    why:
      "PostToolUse records the delegation; PreToolUse opens the delegation window, " +
      "which is the ONLY thing that gives a delegate's own tool calls an identity - " +
      "v3 payloads carry no acting-agent field, so without the opening edge the " +
      "persona-scoped guards see every delegated call as the main session's",
  },
];

// Tool-name matchers, per responsibility, that a guard must cover or it is blind
// to a tool that can do the thing it exists to refuse. Grounded in the adapter's
// own canonicalizers (canonicalWriteTool, canonicalTool, TERMINAL_TOOLS): a name
// they translate is a name the guard can act on, so a matcher that omits it drops
// the call silently.
const REQUIRED_MATCHER_TOOLS: Array<{ target: string; tools: string[]; why: string }> = [
  {
    target: "review-freeze",
    tools: ["fs_write", "create_file", "str_replace", "fs_append", "delete_file", "execute_bash"],
    why: "every tool that can mutate a frozen artifact",
  },
  {
    target: "reviewer-scope",
    tools: ["fs_write", "str_replace", "delete_file", "read_file", "execute_bash"],
    why: "reads count: reading outside the reviewed artifact is the violation",
  },
  {
    target: "log-subagent",
    tools: ["subagent_aidlc-architect-agent", "invoke_sub_agent", "orchestrate_subagent"],
    why: "all three shapes a delegation arrives under",
  },
];

type Registration = {
  target: string;
  trigger: string;
  manifest: string;
  matcher: string | null;
};

function registrations(distRoot: string, harness: string, harnessDir: string): Registration[] {
  const hooksDir = join(distRoot, harness, harnessDir, "hooks");
  const out: Registration[] = [];
  if (!existsSync(hooksDir)) return out;
  for (const name of readdirSync(hooksDir).filter((n) => n.endsWith(".json")).sort()) {
    const parsed = JSON.parse(readFileSync(join(hooksDir, name), "utf-8")) as {
      hooks?: Array<{
        trigger?: unknown;
        matcher?: unknown;
        action?: { command?: unknown };
      }>;
    };
    for (const hook of parsed.hooks ?? []) {
      const command = hook.action?.command;
      const trigger = hook.trigger;
      if (typeof command !== "string" || typeof trigger !== "string") continue;
      const match = command.match(
        new RegExp(`engine adapter ${harness}\\s+([a-z][a-z0-9-]*)`),
      );
      if (match) {
        out.push({
          target: match[1],
          trigger,
          manifest: name,
          matcher: typeof hook.matcher === "string" ? hook.matcher : null,
        });
      }
    }
  }
  return out;
}

function adapterTargets(source: string): Set<string> {
  const handled = new Set<string>();
  for (const m of source.matchAll(/target === "([a-z][a-z0-9-]*)"/g)) handled.add(m[1]);
  for (const m of source.matchAll(/^\s*case "([a-z][a-z0-9-]*)":/gm)) handled.add(m[1]);
  return handled;
}

describe("t331 kiro hook wiring contract", () => {
  for (const subject of SUBJECTS) {
    const adapterPath = join(REPO_ROOT, "harness", subject.harness, subject.adapter);
    const distRoot = join(REPO_ROOT, "dist");

    test(`${subject.harness}: every required responsibility is registered on every trigger it needs`, () => {
      const regs = registrations(distRoot, subject.harness, subject.harnessDir);
      expect(regs.length, "no manifest dispatches into the adapter").toBeGreaterThan(0);
      const missing: string[] = [];
      for (const want of REQUIRED) {
        for (const trigger of want.triggers) {
          const hit = regs.some((r) => r.target === want.target && r.trigger === trigger);
          if (!hit) missing.push(`${want.target} on ${trigger} (${want.why})`);
        }
      }
      expect(missing).toEqual([]);
    });

    test(`${subject.harness}: a responsibility that must refuse is on a blocking trigger`, () => {
      const regs = registrations(distRoot, subject.harness, subject.harnessDir);
      const wrong: string[] = [];
      for (const want of REQUIRED.filter((r) => r.blocking)) {
        for (const reg of regs.filter((r) => r.target === want.target)) {
          if (!BLOCKING_TRIGGERS.has(reg.trigger)) {
            wrong.push(`${reg.manifest}: ${reg.target} on ${reg.trigger} cannot block`);
          }
        }
      }
      expect(wrong).toEqual([]);
    });

    test(`${subject.harness}: a single-surface trigger is always paired`, () => {
      const regs = registrations(distRoot, subject.harness, subject.harnessDir);
      const bySurface = new Map<string, Set<string>>();
      for (const reg of regs) {
        const only = SURFACE_ONLY[reg.trigger];
        if (!only) continue;
        const seen = bySurface.get(reg.target) ?? new Set<string>();
        seen.add(only);
        bySurface.set(reg.target, seen);
      }
      // Only the lifecycle pair is required to cover both surfaces; the IDE-only
      // file and task triggers have no CLI counterpart to pair with, so they are
      // exempt by name rather than by silence.
      const IDE_ONLY_BY_DESIGN = new Set([
        "PostFileCreate",
        "PostFileSave",
        "PostFileDelete",
        "PreTaskExecution",
        "PostTaskExecution",
      ]);
      const lonely: string[] = [];
      for (const [target, surfaces] of bySurface) {
        const triggers = regs.filter((r) => r.target === target).map((r) => r.trigger);
        if (triggers.every((t) => IDE_ONLY_BY_DESIGN.has(t))) continue;
        if (surfaces.size < 2) {
          lonely.push(`${target} reaches only the ${[...surfaces][0]} surface (${triggers.join(", ")})`);
        }
      }
      expect(lonely).toEqual([]);
    });

    test(`${subject.harness}: a guard's matcher covers every tool it must be able to see`, () => {
      const regs = registrations(distRoot, subject.harness, subject.harnessDir);
      const blind: string[] = [];
      for (const want of REQUIRED_MATCHER_TOOLS) {
        const matching = regs.filter((r) => r.target === want.target);
        if (matching.length === 0) {
          blind.push(`${want.target} is not registered at all (${want.why})`);
          continue;
        }
        for (const tool of want.tools) {
          // A registration with no matcher matches every tool, per the schema.
          const seen = matching.some((r) =>
            r.matcher === null || new RegExp(r.matcher).test(tool)
          );
          if (!seen) blind.push(`${want.target} cannot see ${tool} (${want.why})`);
        }
      }
      expect(blind).toEqual([]);
    });

    test(`${subject.harness}: every manifest trigger is a documented trigger name`, () => {
      const regs = registrations(distRoot, subject.harness, subject.harnessDir);
      const unknown = regs
        .filter((r) => !KNOWN_TRIGGERS.has(r.trigger))
        .map((r) => `${r.manifest}: ${r.trigger}`)
        .sort();
      expect(unknown).toEqual([]);
    });

    test(`${subject.harness}: every manifest target exists in the adapter`, () => {
      expect(existsSync(adapterPath), adapterPath).toBe(true);
      const handled = adapterTargets(readFileSync(adapterPath, "utf-8"));
      expect(handled.size).toBeGreaterThan(0);
      const unimplemented = registrations(distRoot, subject.harness, subject.harnessDir)
        .filter((r) => !handled.has(r.target))
        .map((r) => `${r.manifest} -> ${r.target}`)
        .sort();
      expect(unimplemented).toEqual([]);
    });

    test(`${subject.harness}: the manifests reach the adapter's own harness name`, () => {
      const hooksDir = join(distRoot, subject.harness, subject.harnessDir, "hooks");
      expect(existsSync(hooksDir), hooksDir).toBe(true);
      const strangers: string[] = [];
      for (const name of readdirSync(hooksDir).filter((n) => n.endsWith(".json")).sort()) {
        const text = readFileSync(join(hooksDir, name), "utf-8");
        for (const m of text.matchAll(/engine adapter ([a-z][a-z0-9-]*)/g)) {
          if (m[1] !== subject.harness) strangers.push(`${name} -> ${m[1]}`);
        }
      }
      expect(strangers).toEqual([]);
    });
  }
});
