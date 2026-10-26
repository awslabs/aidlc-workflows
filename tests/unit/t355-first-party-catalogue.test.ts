// covers: file:core/tools/aidlc-plugin-emit.ts, function:writeFirstPartyCatalogues
//
// AI-DLC's own plugins share one aidlc-plugins catalogue per host format at the
// root of the tree that holds them, so a person adds that folder once and
// installs any of them; a second plugin of ours never brings a second catalogue
// with the same name. A plugin anyone else builds keeps its own catalogue.

import { afterAll, beforeAll, describe, expect, test, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";
import {
  buildPluginProjection,
  readPluginTargets,
  writeFirstPartyCatalogues,
} from "../../dist/claude/.claude/tools/aidlc-plugin-emit.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const REPO_ROOT = resolve(import.meta.dir, "../..");
const TOOLS = join(REPO_ROOT, "dist", "claude", ".claude", "tools");
const TARGETS = readPluginTargets(join(TOOLS, "data", "plugin-targets.json"));
const TEMPLATES = join(TOOLS, "data", "plugin-hooks-template");
const scratch = mkdtempSync(join(tmpdir(), "aidlc-t355-"));

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

// A throwaway second plugin of ours, from the create scaffold.
function samplePlugin(): string {
  const root = join(scratch, "src", "sample-pack");
  const created = spawnSync(process.execPath, [join(TOOLS, "aidlc-plugin-create.ts"), "sample-pack", root], {
    encoding: "utf-8",
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  expect(created.status, created.stderr).toBe(0);
  return root;
}

function walk(root: string): string[] {
  const out: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) visit(path);
      else out.push(path);
    }
  };
  visit(root);
  return out;
}

type Catalogue = {
  name: string;
  owner: { name: string };
  plugins: Array<{ name: string; source: string; version: string; description: string }>;
};

describe("t355 our own plugins share one catalogue per host format", () => {
  const tree = join(scratch, "plugins");
  const sources: Record<string, string> = { "test-pro": join(REPO_ROOT, "plugins", "test-pro") };
  let written: string[] = [];
  beforeAll(() => {
    sources["sample-pack"] = samplePlugin();
    for (const [plugin, pluginRoot] of Object.entries(sources)) {
      for (const target of Object.values(TARGETS)) {
        buildPluginProjection({
          pluginRoot,
          target,
          outDir: join(tree, plugin, target.harnessName),
          outputBoundary: tree,
          templateHooksDir: TEMPLATES,
          firstParty: true,
        });
      }
    }
    written = writeFirstPartyCatalogues(tree, Object.values(TARGETS));
  });

  test("each host that reads a catalogue gets one aidlc-plugins listing every plugin of ours", () => {
    const withCatalogue = Object.values(TARGETS).filter((target) => target.hostCatalogue);
    expect(withCatalogue.map((target) => target.harnessName).sort()).toEqual(["claude", "codex", "copilot", "cursor"]);
    expect(written.sort()).toEqual(withCatalogue.map((target) => `${target.marketplaceDir}/marketplace.json`).sort());
    for (const target of withCatalogue) {
      const catalogue = JSON.parse(
        readFileSync(join(tree, target.marketplaceDir, "marketplace.json"), "utf-8"),
      ) as Catalogue;
      expect(catalogue.name, target.harnessName).toBe("aidlc-plugins");
      expect(catalogue.owner, target.harnessName).toEqual({ name: "AWS AIDLC" });
      expect(catalogue.plugins.map((entry) => [entry.name, entry.source]), target.harnessName).toEqual([
        ["aidlc-sample-pack", `./sample-pack/${target.harnessName}`],
        ["aidlc-test-pro", `./test-pro/${target.harnessName}`],
      ]);
      for (const entry of catalogue.plugins) {
        const manifest = JSON.parse(
          readFileSync(join(tree, entry.source, target.manifestDir, "plugin.json"), "utf-8"),
        ) as { name: string; version: string };
        expect(manifest.name, `${target.harnessName}: ${entry.source}`).toBe(entry.name);
        expect(entry.version).toBe(manifest.version);
      }
    }
    // Kiro has no store and opencode installs an npm module: no catalogue file.
    for (const dir of [".kiro-plugin", ".opencode-plugin"]) {
      expect(existsSync(join(tree, dir)), dir).toBe(false);
    }
  });

  test("no projection of ours carries a catalogue of its own", () => {
    const own = walk(tree)
      .filter((path) => path.endsWith("marketplace.json"))
      .map((path) => path.slice(tree.length + 1).replaceAll("\\", "/"))
      .filter((rel) => !written.includes(rel));
    expect(own).toEqual([]);
  });

  test("a build of only some hosts rewrites only their catalogues", () => {
    const codex = join(tree, ".agents", "plugins", "marketplace.json");
    writeFileSync(codex, "kept\n");
    expect(writeFirstPartyCatalogues(tree, [TARGETS.claude])).toEqual([".claude-plugin/marketplace.json"]);
    expect(readFileSync(codex, "utf-8")).toBe("kept\n");
  });

  test("a plugin someone else builds keeps its own catalogue", () => {
    const outDir = join(scratch, "third-party", "claude");
    mkdirSync(join(scratch, "third-party"), { recursive: true });
    buildPluginProjection({
      pluginRoot: sources["sample-pack"],
      target: TARGETS.claude,
      outDir,
      templateHooksDir: TEMPLATES,
    });
    const catalogue = JSON.parse(
      readFileSync(join(outDir, ".claude-plugin", "marketplace.json"), "utf-8"),
    ) as Catalogue;
    expect(catalogue.name).toBe("sample-pack");
    expect(catalogue.plugins.map((entry) => [entry.name, entry.source])).toEqual([["sample-pack", "."]]);
  });
});
