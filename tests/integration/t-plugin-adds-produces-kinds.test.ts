// covers: file:scripts/plugin-hooks-template/compose.ts, file:core/tools/aidlc-plugin-validate.ts

import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { validatePluginRoot } from "../../dist/claude/.claude/tools/aidlc-plugin-validate.ts";
import {
  readPluginDropEntries,
  runPluginCompose,
} from "../../dist/claude/.claude/tools/aidlc-plugin-test.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLAUDE_INSTALL = join(REPO_ROOT, "dist", "claude");
const PLUGIN_BUILD = join(REPO_ROOT, "dist", "plugins", "test-pro", "claude");
const CONSTRUCTION_STAGES = join(".claude", "aidlc-common", "stages", "construction");
const RETRY_MARKER = join("aidlc", ".plugin-compose-retry-test-pro");

let scratch: string;
let pluginRoot: string;
let projectDir: string;

function compose(): { status: number | null; stderr: string; stdout: string } {
  return runPluginCompose({
    harness: "claude",
    harnessLeaf: ".claude",
    projectDir,
    pluginBuilt: pluginRoot,
    timeoutMs: remainingOperationTimeoutMs(NATIVE_FIXTURE_SETUP_TIMEOUT_MS, { phase: "plugin fixture" }),
  });
}

function stageDigest(): string {
  const hash = createHash("sha256");
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else {
        hash.update(entry.name);
        hash.update(readFileSync(path));
      }
    }
  };
  walk(join(projectDir, CONSTRUCTION_STAGES));
  return hash.digest("hex");
}

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "aidlc-adds-kinds-"));
  pluginRoot = join(scratch, "test-pro");
  cpSync(PLUGIN_BUILD, pluginRoot, { recursive: true });
  const contributions = join(pluginRoot, "contributions", "construction");
  mkdirSync(contributions, { recursive: true });
  writeFileSync(
    join(contributions, "kind-repro.md"),
    "---\ntarget: functional-design\nplugin: test-pro\nadds:\n  produces:\n    - test-pro-kind-repro-notes\n---\n\nNo fragment: the refused adds entry is the whole contribution.\n",
    "utf-8",
  );
  writeFileSync(
    join(contributions, "kind-clean.md"),
    "---\ntarget: nfr-design\nplugin: test-pro\nadds:\n  produces:\n    - test-pro-kind-repro-clean\n---\n\nNo fragment: the merged output is the assertion.\n",
    "utf-8",
  );
  projectDir = join(scratch, "project");
  cpSync(CLAUDE_INSTALL, projectDir, { recursive: true });
});

afterAll(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

describe("adds.produces on a kind-mapped per-Unit stage", () => {
  test("compose refuses the entry, writes nothing for it, and still composes the rest", () => {
    const stageFile = join(projectDir, CONSTRUCTION_STAGES, "functional-design.md");
    const before = readFileSync(stageFile, "utf-8");
    const first = compose();
    expect(first.status).toBe(0);
    expect(readFileSync(stageFile, "utf-8")).toBe(before);
    expect(readFileSync(join(projectDir, CONSTRUCTION_STAGES, "nfr-design.md"), "utf-8")).toContain(
      "test-pro-kind-repro-clean",
    );

    const drops = readPluginDropEntries(projectDir, "test-pro");
    const messages = drops.map((drop) => drop.message).join("\n");
    expect(messages).toContain('adds.produces "test-pro-kind-repro-notes"');
    expect(messages).toContain('stage "functional-design"');
    expect(messages).toContain('"packaging"');
    expect(messages).toContain('"functional-spec"');
    expect(messages).toContain("nfr-requirements and nfr-design");
    expect(existsSync(join(projectDir, RETRY_MARKER))).toBe(false);

    const graph = JSON.parse(
      readFileSync(join(projectDir, ".claude", "tools", "data", "stage-graph.json"), "utf-8"),
    ) as Array<{ slug?: string }>;
    expect(graph.some((node) => node.slug === "functional-design")).toBe(true);

    const digest = stageDigest();
    const second = compose();
    expect(second.status).toBe(0);
    expect(stageDigest()).toBe(digest);
    expect(existsSync(join(projectDir, RETRY_MARKER))).toBe(false);
  });

  test("validate refuses the same entry and names stage, output and unit kind", () => {
    const result = validatePluginRoot(pluginRoot);
    expect(result.valid).toBe(false);
    const finding = result.errors.find(
      (entry) => entry.rule === "contribution-adds" && entry.message.includes("test-pro-kind-repro-notes"),
    );
    expect(finding).toBeDefined();
    expect(finding?.message).toContain('stage "functional-design"');
    expect(finding?.message).toContain('"packaging"');
    expect(finding?.message).toContain('"functional-spec"');
    expect(finding?.fix).toContain("nfr-requirements");
    expect(result.errors.some((entry) => entry.file.endsWith("kind-clean.md"))).toBe(false);
  });
});
