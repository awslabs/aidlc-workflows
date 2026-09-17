// covers: subcommand:aidlc-utility:config-change, subcommand:aidlc-utility:status,
// subcommand:aidlc-utility:intent-create, subcommand:aidlc-utility:scope-change,
// subcommand:aidlc-utility:config-get, subcommand:aidlc-utility:config-list,
// subcommand:aidlc-orchestrate:next, audit:CEREMONY_SET, audit:GUARD_POLICY_SET,
// audit:DEPTH_CHANGED, audit:TEST_STRATEGY_CHANGED, audit:REVIEW_CLASS_CHANGED, tool:aidlc

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  auditBlockField,
  getField,
  readAuditShardEvents,
  setField,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createTestProject,
  seedAidlcMemory,
} from "../harness/fixtures.ts";

const UTILITY = join(AIDLC_SRC, "tools", "aidlc-utility.ts");
const ORCHESTRATE = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
const DISPATCHER = join(AIDLC_SRC, "tools", "aidlc.ts");
const tempDirs: string[] = [];
const CEREMONY_FIELDS = ["Sensors", "Learnings", "Summary Confirmation"];
const SETTING_EVENTS = [
  "DEPTH_CHANGED", "TEST_STRATEGY_CHANGED", "REVIEW_CLASS_CHANGED",
  "GUARD_POLICY_SET", "CEREMONY_SET",
];
/** Every fence kill switch held at "0" so the test host's environment cannot lower a fence. */
const FENCE_ENV_CLEAR = {
  AIDLC_DISABLE_PLAN_APPROVAL_GUARD: "0",
  AIDLC_DISABLE_REVIEW_FREEZE_HOOK: "0",
  AIDLC_DISABLE_REVIEWER_SCOPE_HOOK: "0",
  AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "0",
};

afterEach(() => {
  while (tempDirs.length > 0) cleanupTestProject(tempDirs.pop()!);
});

function run(tool: string, args: string[], proj: string, env: Record<string, string> = {}) {
  const result = Bun.spawnSync({
    cmd: [process.execPath, tool, ...args, "--project-dir", proj],
    cwd: proj,
    env: {
      ...process.env,
      AIDLC_DISABLE_SENSORS: "0",
      AIDLC_DISABLE_LEARNINGS: "0",
      AIDLC_DISABLE_SUMMARY_CONFIRMATION: "0",
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { status: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

function emptyProject(): string {
  const proj = createTestProject();
  tempDirs.push(proj);
  seedAidlcMemory(proj);
  return proj;
}

function project(scope = "classic", extra: string[] = []) {
  const proj = emptyProject();
  const created = run(UTILITY, ["intent-create", "--scope", scope, "--arguments", "ceremony fixture", "--label", "ceremony", ...extra], proj);
  expect(created.status, created.stderr).toBe(0);
  const intents = join(proj, "aidlc", "spaces", "default", "intents");
  const active = readFileSync(join(intents, "active-intent"), "utf-8").trim();
  const state = join(intents, active, "aidlc-state.md");
  expect(existsSync(state)).toBe(true);
  return { proj, state, intent: active };
}

function rows(proj: string) {
  return readAuditShardEvents(proj).filter((entry) => entry.event === "CEREMONY_SET");
}

function settingRows(proj: string) {
  return readAuditShardEvents(proj).filter((entry) => SETTING_EVENTS.includes(entry.event));
}

function directive(stdout: string): { kind: string; message: string } {
  return JSON.parse(stdout.trim().split("\n").pop() ?? "{}");
}

describe("t338 atomic per-intent settings", () => {
  test.each([
    { extra: [], learnings: "on (from scope classic)" },
    { extra: ["--learnings", "off"], learnings: "off (set by you)" },
  ])("creation records scope defaults and explicit intent choices with visible sources: $learnings", ({ extra, learnings }) => {
    const { proj, state } = project("classic", [...extra]);
    const content = readFileSync(state, "utf-8");
    expect(getField(content, "Sensors")).toBe("on (from scope classic)");
    expect(getField(content, "Learnings")).toBe(learnings);
    expect(getField(content, "Summary Confirmation")).toBe("off (from scope classic)");
    const status = run(UTILITY, ["status"], proj);
    expect(status.status, status.stderr).toBe(0);
    expect(status.stdout).toContain("Sensors: on (from scope classic)\n");
    expect(status.stdout).toContain(`Learnings: ${learnings}\n`);
    expect(status.stdout).toContain("Summary Confirmation: off (from scope classic)\n");
  });

  test("config-change records a changed setting once and leaves the repeat unchanged", () => {
    const { proj, state } = project();
    const changed = run(UTILITY, ["config-change", "--sensors", "off"], proj);
    expect(changed.status, changed.stderr).toBe(0);
    expect(getField(readFileSync(state, "utf-8"), "Sensors")).toBe("off (set by you)");
    const audit = rows(proj);
    expect(audit).toHaveLength(1);
    expect(auditBlockField(audit[0].block, "Key")).toBe("sensors");
    expect(auditBlockField(audit[0].block, "Old")).toBe("on");
    expect(auditBlockField(audit[0].block, "New")).toBe("off");
    expect(auditBlockField(audit[0].block, "Source")).toBe("you");
    expect(run(UTILITY, ["status"], proj).stdout).toContain("Sensors: off (set by you)\n");
    const before = readFileSync(state, "utf-8");
    const repeated = run(UTILITY, ["config-change", "--sensors", "off"], proj);
    expect(repeated.status, repeated.stderr).toBe(0);
    expect(readFileSync(state, "utf-8")).toBe(before);
    expect(rows(proj)).toHaveLength(1);
  });

  test("ceremony audit records the saved value rather than an environment-disabled effective value", () => {
    const { proj, state } = project();
    for (const [key, flag, field, env] of [
      ["sensors", "--sensors", "Sensors", "AIDLC_DISABLE_SENSORS"],
      ["learnings", "--learnings", "Learnings", "AIDLC_DISABLE_LEARNINGS"],
      ["summary_confirmation", "--summary-confirmation", "Summary Confirmation", "AIDLC_DISABLE_SUMMARY_CONFIRMATION"],
    ]) {
      const enabled = run(UTILITY, ["config-change", flag, "on"], proj);
      expect(enabled.status, enabled.stderr).toBe(0);
      expect(getField(readFileSync(state, "utf-8"), field)).toBe("on (set by you)");
      const before = rows(proj);
      const disabled = run(UTILITY, ["config-change", flag, "off"], proj, { [env]: "1" });
      expect(disabled.status, disabled.stderr).toBe(0);
      const audit = rows(proj).slice(before.length);
      expect(audit).toHaveLength(1);
      expect(auditBlockField(audit[0].block, "Key")).toBe(key);
      expect(auditBlockField(audit[0].block, "Old")).toBe("on");
      expect(auditBlockField(audit[0].block, "New")).toBe("off");
      expect(auditBlockField(audit[0].block, "Source")).toBe("you");
      expect(getField(readFileSync(state, "utf-8"), field)).toBe("off (set by you)");
    }
  });

  test("one config-change updates all seven settings in canonical audit order and repeats without a write", () => {
    const { proj, state } = project();
    const timestamp = "2000-01-01T00:00:00Z";
    writeFileSync(state, setField(readFileSync(state, "utf-8"), "Last Updated", timestamp));
    const args = [
      "config-change", "--summary-confirmation", "on", "--review", "advisory",
      "--sensors", "off", "--depth", "minimal", "--guard-policy", "strict",
      "--learnings", "off", "--test-strategy", "comprehensive",
    ];
    const changed = run(UTILITY, args, proj);
    expect(changed.status, changed.stderr).toBe(0);
    const content = readFileSync(state, "utf-8");
    for (const [field, value] of Object.entries({
      Depth: "Minimal",
      "Test Strategy": "Comprehensive",
      "Review Override": "advisory",
      "Guard Policy": "strict (set by you)",
      Sensors: "off (set by you)",
      Learnings: "off (set by you)",
      "Summary Confirmation": "on (set by you)",
    })) expect(getField(content, field)).toBe(value);
    expect(getField(content, "Last Updated")).not.toBe(timestamp);

    const audit = settingRows(proj);
    expect(audit.map((row) => row.event)).toEqual([
      "DEPTH_CHANGED", "TEST_STRATEGY_CHANGED", "REVIEW_CLASS_CHANGED",
      "GUARD_POLICY_SET", "CEREMONY_SET", "CEREMONY_SET", "CEREMONY_SET",
    ]);
    const fields = [
      { "Old Depth": "Standard", "New Depth": "Minimal" },
      { "Old Strategy": "Standard", "New Strategy": "Comprehensive" },
      { "Old Override": "none set", "New Override": "advisory" },
      { "Old Value": "relaxed", "New Value": "strict", Source: "you" },
      { Key: "sensors", Old: "on", New: "off", Source: "you" },
      { Key: "learnings", Old: "on", New: "off", Source: "you" },
      { Key: "summary_confirmation", Old: "off", New: "on", Source: "you" },
    ];
    for (const [index, expected] of fields.entries()) {
      for (const [field, value] of Object.entries(expected)) {
        expect(auditBlockField(audit[index].block, field)).toBe(value);
      }
    }
    const repeated = run(UTILITY, args, proj);
    expect(repeated.status, repeated.stderr).toBe(0);
    expect(readFileSync(state, "utf-8")).toBe(content);
    expect(settingRows(proj)).toEqual(audit);
  });

  test("adversarial review clears the stored override and is idempotent", () => {
    const { proj, state } = project("classic", ["--review", "none"]);
    const changed = run(UTILITY, ["config-change", "--review", "adversarial"], proj);
    expect(changed.status, changed.stderr).toBe(0);
    const content = readFileSync(state, "utf-8");
    expect(getField(content, "Review Override")).toBe("");
    const audit = settingRows(proj);
    expect(audit.map((row) => row.event)).toEqual(["REVIEW_CLASS_CHANGED"]);
    expect(auditBlockField(audit[0].block, "Old Override")).toBe("none");
    expect(auditBlockField(audit[0].block, "New Override")).toBe("cleared (stage defaults apply)");
    const repeated = run(UTILITY, ["config-change", "--review", "adversarial"], proj);
    expect(repeated.status, repeated.stderr).toBe(0);
    expect(readFileSync(state, "utf-8")).toBe(content);
    expect(settingRows(proj)).toEqual(audit);
  });

  test.each<string[]>([
    ["config-change"],
    ["scope-change", "--scope", "classic"],
    ["scope-change", "--scope", "feature"],
  ])("memory strict refuses the whole relaxed-and-sensor update through %s", (...command) => {
    const { proj, state } = project();
    const memory = join(proj, "aidlc", "spaces", "default", "memory", "project.md");
    expect(readFileSync(memory, "utf-8")).toContain("## Guard Policy\n");
    writeFileSync(memory, readFileSync(memory, "utf-8").replace("## Guard Policy\n", "## Guard Policy\n\nMode: strict\n"));
    const before = readFileSync(state, "utf-8");
    const refused = run(UTILITY, [...command, "--depth", "minimal", "--guard-policy", "relaxed", "--sensors", "on"], proj);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain(memory);
    expect(readFileSync(state, "utf-8")).toBe(before);
    expect(settingRows(proj)).toHaveLength(0);
    expect(readAuditShardEvents(proj).filter((row) => row.event === "SCOPE_CHANGED")).toHaveLength(0);
  });

  test("same-scope changes apply explicit settings without a scope-change row", () => {
    const { proj, state } = project();
    const args = ["scope-change", "--scope", "classic", "--guard-policy", "strict", "--sensors", "off"];
    const changed = run(UTILITY, args, proj);
    expect(changed.status, changed.stderr).toBe(0);
    const content = readFileSync(state, "utf-8");
    expect(getField(content, "Scope")).toBe("classic");
    expect(getField(content, "Guard Policy")).toBe("strict (set by you)");
    expect(getField(content, "Sensors")).toBe("off (set by you)");
    const audit = settingRows(proj);
    expect(audit.map((row) => row.event)).toEqual(["GUARD_POLICY_SET", "CEREMONY_SET"]);
    expect(auditBlockField(audit[0].block, "Source")).toBe("you");
    expect(auditBlockField(audit[1].block, "Source")).toBe("you");
    expect(readAuditShardEvents(proj).filter((row) => row.event === "SCOPE_CHANGED")).toHaveLength(0);
    const repeated = run(UTILITY, args, proj);
    expect(repeated.status, repeated.stderr).toBe(0);
    expect(readFileSync(state, "utf-8")).toBe(content);
    expect(settingRows(proj)).toEqual(audit);
  });

  test("a Guard Policy ledger fault prevents every setting and audit change", () => {
    const { proj, state } = project();
    const before = readFileSync(state, "utf-8");
    const refused = run(UTILITY, [
      "config-change", "--depth", "minimal", "--test-strategy", "comprehensive",
      "--review", "advisory", "--guard-policy", "strict", "--sensors", "on",
      "--learnings", "on", "--summary-confirmation", "on",
    ], proj, { AIDLC_TEST_CHANGE_CONTROL_LEDGER_FAULT: "t338" });
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("injected ledger fault: t338");
    expect(readFileSync(state, "utf-8")).toBe(before);
    expect(settingRows(proj)).toHaveLength(0);
  });

  test("concurrent different-key changes preserve both settings and audit each once", async () => {
    const { proj, state, intent } = project("classic");
    const children = ["sensors", "learnings"].map((key) => Bun.spawn({
      cmd: [process.execPath, UTILITY, "config-change", `--${key}`, "off", "--project-dir", proj, "--intent", intent, "--space", "default"],
      cwd: proj,
      env: {
        ...process.env,
        AIDLC_DISABLE_SENSORS: "0",
        AIDLC_DISABLE_LEARNINGS: "0",
        AIDLC_DISABLE_SUMMARY_CONFIRMATION: "0",
      },
      stdout: "ignore",
      stderr: "pipe",
    }));
    const results = await Promise.all(children.map(async (child) => {
      const [status, stderr] = await Promise.all([
        child.exited,
        new Response(child.stderr).text(),
      ]);
      return { status, stderr };
    }));
    for (const result of results) expect(result.status, result.stderr).toBe(0);
    const content = readFileSync(state, "utf-8");
    expect(getField(content, "Sensors")).toBe("off (set by you)");
    expect(getField(content, "Learnings")).toBe("off (set by you)");
    const audit = rows(proj);
    expect(audit).toHaveLength(2);
    expect(audit.map((row) => auditBlockField(row.block, "Key")).sort()).toEqual(["learnings", "sensors"]);
  }, 30000);

  test("invalid or missing values refuse every setting before state or audit changes", () => {
    const { proj, state } = project();
    const before = readFileSync(state, "utf-8");
    for (const args of [
      [], ["--sensors"], ["--sensors", "maybe"],
      ["--depth", "minimal", "--sensors", "on", "--summary-confirmation", "maybe"],
      ["--learnings", "on", "extra"],
    ]) {
      const refused = run(UTILITY, ["config-change", ...args], proj);
      expect(refused.status).toBe(1);
      expect(readFileSync(state, "utf-8")).toBe(before);
      expect(settingRows(proj)).toHaveLength(0);
    }
  });

  test("an unknown flag is refused by name without partially applying a valid setting", () => {
    const { proj, state } = project();
    const before = readFileSync(state, "utf-8");
    const refused = run(UTILITY, ["config-change", "--depth", "minimal", "--unknown-setting", "on"], proj);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("--unknown-setting");
    expect(readFileSync(state, "utf-8")).toBe(before);
    expect(settingRows(proj)).toHaveLength(0);
  });

  test("missing legacy rows resolve without backfill and can be explicitly set", () => {
    const { proj, state } = project();
    const legacy = readFileSync(state, "utf-8").replace(/^- \*\*(Sensors|Learnings|Summary Confirmation)\*\*:.*\n/gm, "");
    writeFileSync(state, legacy);
    const status = run(UTILITY, ["status"], proj);
    expect(status.status, status.stderr).toBe(0);
    expect(status.stdout).toContain("Sensors: on (from scope classic)\n");
    expect(status.stdout).toContain("Learnings: on (from scope classic)\n");
    expect(status.stdout).toContain("Summary Confirmation: off (from scope classic)\n");
    expect(readFileSync(state, "utf-8")).toBe(legacy);
    const changed = run(UTILITY, ["config-change", "--summary-confirmation", "on"], proj);
    expect(changed.status, changed.stderr).toBe(0);
    expect(getField(readFileSync(state, "utf-8"), "Summary Confirmation")).toBe("on (set by you)");
    expect(getField(readFileSync(state, "utf-8"), "Sensors")).toBeNull();
  });

  test("scope change follows scope-owned rows while retaining human overrides and absent legacy rows", () => {
    const { proj, state } = project();
    expect(run(UTILITY, ["config-change", "--sensors", "off"], proj).status).toBe(0);
    writeFileSync(state, readFileSync(state, "utf-8").replace(/^- \*\*Summary Confirmation\*\*:.*\n/gm, ""));
    const changed = run(UTILITY, ["scope-change", "--scope", "feature"], proj);
    expect(changed.status, changed.stderr).toBe(0);
    const content = readFileSync(state, "utf-8");
    expect(getField(content, "Sensors")).toBe("off (set by you)");
    expect(getField(content, "Learnings")).toBe("on (from scope feature)");
    expect(getField(content, "Summary Confirmation")).toBeNull();
    const scopeRows = rows(proj).filter((row) => auditBlockField(row.block, "Source") === "scope feature");
    expect(scopeRows).toHaveLength(1);
    expect(auditBlockField(scopeRows[0].block, "Key")).toBe("learnings");
    const explicit = run(UTILITY, ["scope-change", "--scope", "classic", "--summary-confirmation", "on"], proj);
    expect(explicit.status, explicit.stderr).toBe(0);
    expect(getField(readFileSync(state, "utf-8"), "Summary Confirmation")).toBe("on (set by you)");
  });

  test("scope-change summary reflects retained overrides and environment-disabled ceremonies", () => {
    const { proj, state } = project();
    const enabled = run(UTILITY, ["config-change", "--learnings", "on"], proj);
    expect(enabled.status, enabled.stderr).toBe(0);
    const express = run(UTILITY, ["scope-change", "--scope", "express"], proj, { AIDLC_DISABLE_SENSORS: "1" });
    expect(express.status, express.stderr).toBe(0);
    // express declares every ceremony off; the human's learnings choice is
    // retained, so the clause names reviewers, the env-disabled sensors, and
    // the scope-owned summary confirmation.
    const expressSummary = express.stdout.split("\n").find((line) => line.startsWith("Approval gates:"));
    expect(expressSummary?.split("; no ")[1]).toBe("reviewers, sensors, or summary confirmation");
    expect(getField(readFileSync(state, "utf-8"), "Learnings")).toBe("on (set by you)");
    expect(getField(readFileSync(state, "utf-8"), "Summary Confirmation")).toBe("off (from scope express)");

    // Returning to classic must retain the human provenance even when the value matches its default.
    const classic = run(UTILITY, ["scope-change", "--scope", "classic"], proj);
    expect(classic.status, classic.stderr).toBe(0);
    expect(getField(readFileSync(state, "utf-8"), "Learnings")).toBe("on (set by you)");
    const classicSummary = classic.stdout.split("\n").find((line) => line.startsWith("Approval gates:"));
    expect(classicSummary?.split("; no ")[1]).toBe("summary confirmation");
  });

  test("environment disable wins in status and config reads without replacing the saved choice", () => {
    const { proj, state } = project("feature", ["--sensors", "on"]);
    const env = { AIDLC_DISABLE_SENSORS: "1" };
    const before = readFileSync(state, "utf-8");
    expect(run(UTILITY, ["status"], proj, env).stdout).toContain("Sensors: off (from env AIDLC_DISABLE_SENSORS)\n");
    expect(run(UTILITY, ["config-get", "sensors"], proj, env).stdout).toBe("off (from env AIDLC_DISABLE_SENSORS)\n");
    const listed = run(UTILITY, ["config-list", "--json"], proj, env);
    expect(listed.status, listed.stderr).toBe(0);
    expect(JSON.parse(listed.stdout).sensors).toBe("off (from env AIDLC_DISABLE_SENSORS)");
    expect(readFileSync(state, "utf-8")).toBe(before);
  });

  test.each([
    { scopeArgs: [] },
    { scopeArgs: ["--scope", "classic"] },
  ])("slash modifiers produce one canonical config command that applies every setting with %j", ({ scopeArgs }) => {
    const { proj, state } = project();
    const before = readFileSync(state, "utf-8");
    const routed = run(ORCHESTRATE, [
      "next", ...scopeArgs, "--summary-confirmation", "on", "--review", "advisory",
      "--sensors", "off", "--depth", "minimal", "--guard-policy", "strict",
      "--learnings", "off", "--test-strategy", "comprehensive",
    ], proj);
    expect(routed.status, routed.stderr).toBe(0);
    expect(routed.stdout.trim().split("\n")).toHaveLength(1);
    const printed = directive(routed.stdout);
    expect(printed.kind).toBe("print");
    expect(printed.message.match(/`[^`]+`/g)).toHaveLength(1);
    const command = printed.message.match(/`[^`]*\b(engine config set [^`]+)`/);
    expect(command).not.toBeNull();
    const args = command![1].split(/\s+/);
    expect(args).toEqual([
      "engine", "config", "set", "depth", "minimal", "--test-strategy", "comprehensive",
      "--review", "advisory", "--guard-policy", "strict", "--sensors", "off",
      "--learnings", "off", "--summary-confirmation", "on",
    ]);
    expect(readFileSync(state, "utf-8")).toBe(before);
    expect(settingRows(proj)).toHaveLength(0);
    const changed = run(DISPATCHER, args, proj);
    expect(changed.status, changed.stderr).toBe(0);
    const listed = run(UTILITY, ["config-list", "--json"], proj, FENCE_ENV_CLEAR);
    expect(listed.status, listed.stderr).toBe(0);
    expect(JSON.parse(listed.stdout)).toEqual({
      depth: "Minimal", "test-strategy": "Comprehensive", review: "advisory",
      "guard-policy": "strict (set by you)", sensors: "off (set by you)",
      learnings: "off (set by you)", "summary-confirmation": "on (set by you)",
      "guard.plan-approval": "on (default)", "guard.review-freeze": "on (default)",
      "guard.state-transition": "on (default)", "guard.reviewer-scope": "on (default)",
      "guard.human-presence": "on (default)",
    });
    expect(settingRows(proj)).toHaveLength(7);
  });

  test("the retired --change-control slash flag produces the same canonical command under the new name", () => {
    const { proj, state } = project();
    const before = readFileSync(state, "utf-8");
    const routed = run(ORCHESTRATE, ["next", "--change-control", "off", "--sensors", "off"], proj);
    expect(routed.status, routed.stderr).toBe(0);
    const printed = directive(routed.stdout);
    expect(printed.kind).toBe("print");
    const command = printed.message.match(/`[^`]*\b(engine config set [^`]+)`/);
    expect(command).not.toBeNull();
    expect(command![1].split(/\s+/)).toEqual([
      "engine", "config", "set", "guard-policy", "off", "--sensors", "off",
    ]);
    expect(printed.message).not.toContain("change-control");
    expect(readFileSync(state, "utf-8")).toBe(before);
  });

  test("slash flags retain creation and scope-change values and refuse incompatible modes", () => {
    const { proj, state } = project();
    const scope = directive(run(ORCHESTRATE, [
      "next", "--scope", "feature", "--summary-confirmation", "off", "--guard-policy", "relaxed",
    ], proj).stdout);
    expect(scope.kind).toBe("print");
    const command = scope.message.match(/`[^`]*\b(engine scope change [^`]+)`/);
    expect(command).not.toBeNull();
    expect(command![1]).toContain("--guard-policy relaxed");
    const changed = run(DISPATCHER, command![1].split(/\s+/), proj);
    expect(changed.status, changed.stderr).toBe(0);
    const content = readFileSync(state, "utf-8");
    expect(getField(content, "Scope")).toBe("feature");
    expect(getField(content, "Guard Policy")).toBe("relaxed (set by you)");
    expect(getField(content, "Summary Confirmation")).toBe("off (set by you)");
    const fresh = emptyProject();
    writeFileSync(join(fresh, "aidlc", "spaces", "default", "intents", "intents.json"), "[]\n");
    const creation = directive(run(ORCHESTRATE, ["next", "--scope", "classic", "--sensors", "off"], fresh).stdout);
    expect(creation.kind).toBe("print");
    expect(creation.message).toContain("--sensors off");
    expect(directive(run(ORCHESTRATE, ["next", "compose", "--sensors", "off"], proj).stdout).kind).toBe("error");
    expect(directive(run(ORCHESTRATE, ["next", "--sensors", "invalid"], proj).stdout).kind).toBe("error");
  });


  test("dispatcher config set exposes the atomic setter to config get and list", () => {
    const { proj, state } = project();
    const changed = run(DISPATCHER, ["engine", "config", "set", "summary-confirmation", "on"], proj);
    expect(changed.status, changed.stderr).toBe(0);
    expect(getField(readFileSync(state, "utf-8"), CEREMONY_FIELDS[2])).toBe("on (set by you)");
    expect(run(DISPATCHER, ["engine", "config", "get", "summary-confirmation"], proj).stdout).toBe("on (set by you)\n");
    const listed = run(DISPATCHER, ["engine", "config", "list", "--json"], proj);
    expect(listed.status, listed.stderr).toBe(0);
    expect(JSON.parse(listed.stdout)["summary-confirmation"]).toBe("on (set by you)");
    expect(rows(proj)).toHaveLength(1);
  });
});
