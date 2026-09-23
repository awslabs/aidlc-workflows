import { expect } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import {
  auditBlockField, getField, type IntentRegistryEntry, listIntents,
  readAuditShardEvents, readIntentRegistry,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { codexExecDiagnostic, type CodexExecution } from "./codex-test-lifecycle.ts";
import { turnEvidence } from "./codex-turn-evidence.ts";

const UUIDV7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Codex can omit aggregated_output even when the CLI wrote its summary.
 * Require completed execution AND the caller's disk assertions on every path. */
export function expectCliSuccess<T>(
  result: CodexExecution & { stdout: string }, route: RegExp, verifyState: () => T,
): T {
  const diagnostic = codexExecDiagnostic(result);
  expect(result.rc, diagnostic).toBe(0);
  expect(result.signal ?? null, diagnostic).toBeNull();
  expect(result.error, diagnostic).toBeUndefined();
  turnEvidence(result.stdout);
  const commands = new Map<string, {
    completed: boolean; status: unknown; exitCode: unknown; turn: number;
  }>();
  let turn = 0;
  for (const line of result.stdout.split("\n").filter(line => line.trim())) {
    const event = JSON.parse(line);
    if (event.type === "turn.started") turn++;
    const item = event.item;
    if (item?.type !== "command_execution" || typeof item.command !== "string" ||
      !item.command.includes(".codex/tools/aidlc.ts") || !route.test(item.command)) continue;
    expect(typeof item.id, diagnostic).toBe("string");
    expect(item.id.length, diagnostic).toBeGreaterThan(0);
    if (event.type === "item.completed") {
      // A later successful event must not hide an earlier failed invocation.
      expect(item.status, diagnostic).toBe("completed");
      expect(item.exit_code, diagnostic).toBe(0);
    }
    commands.set(item.id, {
      completed: event.type === "item.completed", status: item.status,
      exitCode: item.exit_code, turn,
    });
  }
  expect(commands.size, diagnostic).toBeGreaterThan(0);
  for (const command of commands.values()) {
    expect(command.completed, diagnostic).toBe(true);
    expect(command.status, diagnostic).toBe("completed");
    expect(command.exitCode, diagnostic).toBe(0);
  }
  expect([...commands.values()].some(command => command.turn === turn), diagnostic).toBe(true);
  return verifyState();
}

export function expectSpaceInclude(root: string, space: string): void {
  expect(readFileSync(join(root, "aidlc", "active-space"), "utf-8").trim()).toBe(space);
  const config = parseToml(readFileSync(join(root, ".codex", "config.toml"), "utf-8")) as {
    shell_environment_policy?: { set?: { AIDLC_RULES_DIR?: string } };
  };
  expect(config.shell_environment_policy?.set?.AIDLC_RULES_DIR).toBe(`aidlc/spaces/${space}/memory`);
}

/** Session hooks may append audit rows; count creation events, not shard bytes. */
export function workflowStartedCount(recordDir: string): number {
  let count = 0;
  for (const file of readdirSync(join(recordDir, "audit"))) {
    if (!file.endsWith(".md")) continue;
    const body = readFileSync(join(recordDir, "audit", file), "utf-8");
    count += (body.match(/^\*\*Event\*\*:\s*WORKFLOW_STARTED\s*$/gm) ?? []).length;
  }
  return count;
}

/** Bind completed bootstrap to the newly registered, active workspace intent.
 * A header-only state/registry can exist before include repointing and state-init. */
export function expectCreatedIntent(
  root: string,
  before: IntentRegistryEntry[],
  expected: { space: string; project: string; scope: string; stopAfterCreate: boolean },
): { dir: string; state: string } {
  const { space, project, scope, stopAfterCreate } = expected;
  expectSpaceInclude(root, space);
  const registry = readIntentRegistry(root, space);
  expect(new Set(registry.map(entry => entry.uuid)).size).toBe(registry.length);
  for (const entry of registry) expect(entry.uuid).toMatch(UUIDV7_RE);
  const priorIds = new Set(before.map(entry => entry.uuid));
  expect(registry.filter(entry => priorIds.has(entry.uuid))).toEqual(before);
  const added = registry.filter(entry => !priorIds.has(entry.uuid));
  expect(added).toHaveLength(1);
  expect(registry).toHaveLength(before.length + 1);
  const created = added[0];
  expect(created.scope).toBe(scope);
  expect(created.status).toBe("in-flight");
  expect(created.repos).toEqual(["repo-a", "repo-b"]);
  const active = listIntents(root, space).filter(intent => intent.active);
  expect(active).toHaveLength(1);
  expect(active[0].uuid).toBe(created.uuid);
  expect(typeof active[0].dirName).toBe("string");
  expect(readFileSync(join(root, "aidlc", "spaces", space, "intents", "active-intent"), "utf-8").trim())
    .toBe(active[0].dirName!);
  const dir = join(root, "aidlc", "spaces", space, "intents", active[0].dirName!);
  const state = readFileSync(join(dir, "aidlc-state.md"), "utf-8");
  expect(getField(state, "Project")).toBe(project);
  expect(getField(state, "Scope")).toBe(scope);
  expect(getField(state, "Initialization")).toBe("Verified");
  for (const stage of ["workspace-scaffold", "workspace-detection", "state-init"]) {
    expect(state).toContain(`- [x] ${stage} — EXECUTE`);
  }
  // The skill-driven first beat may legitimately advance after bootstrap.
  // Direct "run then stop" beats must retain the exact initial handoff.
  if (stopAfterCreate) {
    expect(getField(state, "Current Stage")).toBe("intent-capture");
    expect(getField(state, "Status")).toBe("Running");
    expect(getField(state, "Last Completed Stage")).toBe("state-init");
    expect(state).toContain("- [-] intent-capture — EXECUTE");
  }
  expect(workflowStartedCount(dir)).toBe(1);
  const unreadable: string[] = [];
  const audit = readAuditShardEvents(root, active[0].dirName!, space, unreadable);
  expect(unreadable).toEqual([]);
  expect(audit.some(row => row.event === "WORKSPACE_INITIALISED" &&
    auditBlockField(row.block, "Scope") === scope)).toBe(true);
  expect(audit.some(row => row.event === "STAGE_COMPLETED" &&
    auditBlockField(row.block, "Stage") === "state-init")).toBe(true);
  return { dir, state };
}
