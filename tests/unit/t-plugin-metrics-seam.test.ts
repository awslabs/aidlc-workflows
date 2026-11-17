// covers: file:core/tools/aidlc-plugin-metrics.ts, file:core/tools/aidlc-hook-input.ts, function:buildTagString, function:validatePluginRoot
// The plugin metrics seam: the tag filter and its caps, the stamp-driven
// `plugin.<name>.version` tag, the reference test-pro script on Claude- and
// Kiro-shaped hook input, and the validator's cap check.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPluginScaffold } from "../../dist/claude/.claude/tools/aidlc-plugin-create.ts";
import {
  filterPluginMetricTags,
  MAX_PLUGIN_METRIC_TAGS,
  parsePluginMetricsOutput,
} from "../../core/tools/aidlc-plugin-metrics.ts";
import { validatePluginRoot } from "../../dist/claude/.claude/tools/aidlc-plugin-validate.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TEST_PRO = join(REPO_ROOT, "plugins", "test-pro");

describe("filterPluginMetricTags", () => {
  test("keeps the first 10 in the script's order and notes the rest", () => {
    const tags: Record<string, string> = {};
    for (let i = 0; i < 14; i++) tags[`k${i}`] = `v${i}`;
    const { tags: kept, notes } = filterPluginMetricTags(tags);
    expect(kept.map(([key]) => key)).toEqual(Array.from({ length: MAX_PLUGIN_METRIC_TAGS }, (_, i) => `k${i}`));
    expect(notes).toHaveLength(4);
  });

  test("drops bad keys, shortens long values, masks through the callback", () => {
    const { tags, notes } = filterPluginMetricTags(
      { "Bad Key": "x", ok: "y".repeat(100), secret: "hide" },
      (value) => value.replace("hide", "***"),
    );
    expect(tags).toEqual([["ok", "y".repeat(64)], ["secret", "***"]]);
    expect(notes).toHaveLength(2);
  });
});

describe("parsePluginMetricsOutput", () => {
  test("accepts the contract and refuses other shapes", () => {
    expect(parsePluginMetricsOutput('{"additionalTags":{"a":"b"}}')).toEqual({ ok: true, output: { additionalTags: { a: "b" } } });
    expect(parsePluginMetricsOutput("nope").ok).toBe(false);
    expect(parsePluginMetricsOutput("{}").ok).toBe(false);
    expect(parsePluginMetricsOutput('{"additionalTags":{"a":1}}').ok).toBe(false);
  });
});

function runScript(hookInput: string, harness: string): Record<string, string> {
  const run = spawnSync(process.execPath, [join(TEST_PRO, "tools", "test-pro-metrics.ts")], {
    input: JSON.stringify({ plugin: "test-pro", event: "STAGE_STARTED", fields: {}, harness, harnessDir: harness, projectDir: "/p", hookInput }),
    encoding: "utf-8",
  });
  expect(run.status, run.stderr).toBe(0);
  return (JSON.parse(run.stdout) as { additionalTags: Record<string, string> }).additionalTags;
}

describe("test-pro reference metrics script", () => {
  test("reads a Claude Code payload", () => {
    const tags = runScript(JSON.stringify({ session_id: "abc", hook_event_name: "PostToolUse", cwd: "/w/my-repo", permission_mode: "default" }), ".claude");
    expect(tags).toMatchObject({ harness_kind: "claude", hook_event: "PostToolUse", repo: "my-repo", permission_mode: "default" });
    expect(tags.session).toMatch(/^[0-9a-f]{12}$/);
  });

  test("reads Kiro payloads in either spelling", () => {
    expect(runScript(JSON.stringify({ session_id: "s", hook_event_name: "PreToolUse", cwd: "/w/r" }), ".kiro")).toMatchObject({ harness_kind: "kiro", hook_event: "PreToolUse", repo: "r" });
    expect(runScript(JSON.stringify({ sessionId: "s", hookEventName: "preToolUse" }), ".kiro")).toMatchObject({ hook_event: "preToolUse" });
  });

  test("an empty or unreadable hook input yields only the harness tag", () => {
    expect(runScript("", ".claude")).toEqual({ harness_kind: "claude" });
    expect(runScript("{not json", ".kiro")).toEqual({ harness_kind: "kiro" });
  });
});

describe("validator", () => {
  function copyPlugin(mutate: (root: string) => void): string {
    const root = mkdtempSync(join(tmpdir(), "aidlc-metrics-validate-"));
    cpSync(TEST_PRO, root, { recursive: true, filter: (src) => !src.includes(`${join("test-pro", "tests")}`) });
    mutate(root);
    return root;
  }
  const rules = (root: string) => {
    const result = validatePluginRoot(root);
    return [...result.errors, ...result.warnings].filter((f) => f.rule === "plugin-metrics-script" || f.rule === "manifest-advertise-metrics");
  };

  test("test-pro passes untouched", () => {
    const root = copyPlugin(() => {});
    try { expect(rules(root)).toEqual([]); } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("a script returning more than the cap warns", () => {
    const root = copyPlugin((r) => {
      const tags = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`k${i}`, "v"]));
      writeFileSync(join(r, "tools", "test-pro-metrics.ts"), `await Bun.stdin.text(); console.log(JSON.stringify({additionalTags:${JSON.stringify(tags)}}));\n`);
    });
    try { expect(rules(root).some((f) => f.message.includes("only the first 10"))).toBe(true); } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("a non-boolean flag is an error; a script without the flag warns", () => {
    const bad = copyPlugin((r) => {
      const p = join(r, ".aidlc-plugin", "plugin.json");
      const m = JSON.parse(require("node:fs").readFileSync(p, "utf-8"));
      m.aidlc.advertiseMetrics = "yes";
      writeFileSync(p, JSON.stringify(m));
    });
    const off = copyPlugin((r) => {
      const p = join(r, ".aidlc-plugin", "plugin.json");
      const m = JSON.parse(require("node:fs").readFileSync(p, "utf-8"));
      delete m.aidlc.advertiseMetrics;
      writeFileSync(p, JSON.stringify(m));
    });
    try {
      expect(rules(bad).some((f) => f.rule === "manifest-advertise-metrics")).toBe(true);
      expect(rules(off).some((f) => f.message.includes("never run"))).toBe(true);
    } finally {
      rmSync(bad, { recursive: true, force: true });
      rmSync(off, { recursive: true, force: true });
    }
  });
});

describe("the contract as other repositories consume it", () => {
  test("the contract file has no imports, so a repository can copy it alone", () => {
    const text = readFileSync(join(REPO_ROOT, "core", "tools", "aidlc-plugin-metrics-contract.ts"), "utf-8");
    expect(text).not.toMatch(/^\s*import\s/m);
  });

  test("create --with-metrics scaffolds a plugin that validates clean", () => {
    const dir = mkdtempSync(join(tmpdir(), "aidlc-metrics-scaffold-"));
    try {
      const target = join(dir, "acme-demo");
      const created = createPluginScaffold("acme-demo", target, { withMetrics: true });
      expect(created.errors).toEqual([]);
      expect(created.files).toContain("types/aidlc-plugin-metrics-contract.ts");
      expect(created.files).toContain("tools/acme-demo-metrics.ts");
      const result = validatePluginRoot(target);
      // compose-hook-absent is the normal note for a fresh scaffold.
      expect([...result.errors, ...result.warnings].filter((f) => f.rule !== "compose-hook-absent")).toEqual([]);
      const plain = createPluginScaffold("acme-plain", join(dir, "acme-plain"));
      expect(plain.files.some((f) => f.includes("metrics"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
