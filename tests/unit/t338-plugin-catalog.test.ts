// covers: file:core/tools/aidlc-plugin-catalog.ts, file:core/tools/aidlc-plugin-emit.ts,
// file:core/tools/aidlc-plugin-validate.ts, file:scripts/package.ts

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CATALOG_FILE,
  CatalogError,
  PROJECTION_MARKER,
  archiveUrl,
  assembleCatalog,
  catalogUrl,
  executableFiles,
  normalizeMarketplaceSource,
  marketplaceAllowed,
  parseCatalog,
  projectionDigest,
  readCatalog,
  readProjectionMarker,
  type PluginCatalog,
} from "../../dist/claude/.claude/tools/aidlc-plugin-catalog.ts";
import {
  AGENT_PLUGINS_SCHEMA,
  AIDLC_EXTENSION_NAMESPACE,
  buildPluginProjection,
  readPluginTargets,
} from "../../dist/claude/.claude/tools/aidlc-plugin-emit.ts";
import { validatePluginRoot } from "../../dist/claude/.claude/tools/aidlc-plugin-validate.ts";
import { hostHandoffCommands } from "../../dist/claude/.claude/tools/aidlc-plugin-market.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PLUGINS_ROOT = join(REPO_ROOT, "dist", "plugins");
const SOURCE_PLUGIN = join(REPO_ROOT, "plugins", "test-pro");
const TOOLS_ROOT = join(REPO_ROOT, "dist", "claude", ".claude", "tools");
const catalogText = readFileSync(join(PLUGINS_ROOT, CATALOG_FILE), "utf-8");
const emittedCatalog = readCatalog(join(PLUGINS_ROOT, CATALOG_FILE));
const emittedPlugin = emittedCatalog.plugins.find((plugin) => plugin.name === "test-pro")!;
const scratch = mkdtempSync(join(tmpdir(), "aidlc-t338-"));

function copyMarketplace(label: string): string {
  const root = join(scratch, label);
  cpSync(PLUGINS_ROOT, root, { recursive: true });
  return root;
}

function catalogWithPlugin(plugin: unknown): unknown {
  return { ...emittedCatalog, plugins: [plugin] };
}

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("t338 plugin marketplace catalog", () => {
  test("the packaged catalog and projection expose the authored plugin version", () => {
    const manifest = JSON.parse(
      readFileSync(join(SOURCE_PLUGIN, ".aidlc-plugin", "plugin.json"), "utf-8"),
    ) as { version: string; description: string };
    const catalog = parseCatalog(catalogText, "packaged catalog");
    expect(catalog.plugins).toContainEqual(expect.objectContaining({
      name: "test-pro",
      version: manifest.version,
      description: manifest.description,
      tag: `test-pro--v${manifest.version}`,
    }));
    expect(readProjectionMarker(join(PLUGINS_ROOT, "test-pro", "claude")).version).toBe(
      manifest.version,
    );
  });

  test.each([
    ["unsupported schema", { ...emittedCatalog, schemaVersion: 2 }, "schemaVersion"],
    ["unknown harness", catalogWithPlugin({
      ...emittedPlugin,
      harnesses: { mystery: emittedPlugin.harnesses.claude },
    }), "unknown harness"],
    ["parent traversal", catalogWithPlugin({
      ...emittedPlugin,
      harnesses: { claude: { ...emittedPlugin.harnesses.claude, path: "test-pro/../claude" } },
    }), "relative path"],
    ["invalid digest", catalogWithPlugin({
      ...emittedPlugin,
      harnesses: { claude: { ...emittedPlugin.harnesses.claude, sha256: "not-a-digest" } },
    }), "sha256"],
    ["duplicate plugin", { ...emittedCatalog, plugins: [emittedPlugin, emittedPlugin] }, "more than once"],
    ["reserved plugin name", catalogWithPlugin({ ...emittedPlugin, name: "aidlc" }), "reserved"],
  ])("rejects %s", (_label, invalidCatalog, reason) => {
    expect(() => parseCatalog(JSON.stringify(invalidCatalog), "invalid catalog")).toThrow(
      reason as string,
    );
  });

  test("projection integrity covers file bytes and names deterministically", () => {
    const root = join(scratch, "digest");
    cpSync(join(PLUGINS_ROOT, "test-pro", "claude"), root, { recursive: true });
    const digest = projectionDigest(root);
    expect(projectionDigest(root)).toBe(digest);
    const hookPath = join(root, "hooks", "compose.ts");
    const original = readFileSync(hookPath);
    const changed = Buffer.from(original);
    changed[0] ^= 1;
    writeFileSync(hookPath, changed);
    expect(projectionDigest(root)).not.toBe(digest);
    writeFileSync(hookPath, original);
    expect(projectionDigest(root)).toBe(digest);
    renameSync(hookPath, join(root, "hooks", "renamed-compose.ts"));
    expect(projectionDigest(root)).not.toBe(digest);
  });

  test("projection integrity frames every file so boundaries cannot be forged", () => {
    // Unframed `path NUL bytes` concatenation makes these two trees hash the
    // same byte stream (`a\0xb\0y`): a substituted archive could drop `b` and
    // splice its bytes into `a` undetected.
    const merged = join(scratch, "framing-merged");
    const split = join(scratch, "framing-split");
    mkdirSync(merged);
    mkdirSync(split);
    writeFileSync(join(merged, "a"), Buffer.from("xb\0y", "latin1"));
    writeFileSync(join(split, "a"), "x");
    writeFileSync(join(split, "b"), "y");
    expect(projectionDigest(merged)).not.toBe(projectionDigest(split));
  });

  test("host handoff names the catalog's published marketplace, not the local alias, and needs a repository source", () => {
    const catalog: PluginCatalog = { ...emittedCatalog, name: "acme-aidlc-plugins" };
    const github = normalizeMarketplaceSource("acme/aidlc-plugins");
    expect(hostHandoffCommands("claude", "install", "test-pro", github, catalog)).toEqual([
      "/plugin marketplace add acme/aidlc-plugins",
      "/plugin install aidlc-test-pro@acme-aidlc-plugins",
    ]);
    expect(hostHandoffCommands("codex", "update", "test-pro", github, catalog)).toEqual([
      "codex plugin marketplace add https://github.com/acme/aidlc-plugins",
      "codex plugin add aidlc-test-pro@acme-aidlc-plugins",
    ]);
    const direct = normalizeMarketplaceSource("https://market.example/x/aidlc-marketplace.json");
    expect(() => hostHandoffCommands("claude", "install", "test-pro", direct, catalog))
      .toThrow(/registered by direct catalog URL/);
  });

  test("every emitted projection carries an Agent Plugins v1 root manifest mirroring the marker", () => {
    // Spec §5.2 closed schema, §5.3 required fields, §5.4 author object keys,
    // §5.5 name constraints, §8.1 extension data under a reverse-domain key.
    const allowedTop = ["$schema", "name", "version", "description", "author", "homepage", "repository", "license", "keywords", "extensions"];
    for (const harness of ["claude", "codex", "copilot", "cursor", "kiro", "kiro-ide", "opencode"]) {
      const root = join(PLUGINS_ROOT, "test-pro", harness);
      const manifest = JSON.parse(readFileSync(join(root, "plugin.json"), "utf-8")) as Record<string, unknown>;
      expect(Object.keys(manifest).every((key) => allowedTop.includes(key))).toBe(true);
      expect(manifest.$schema).toBe(AGENT_PLUGINS_SCHEMA);
      expect(manifest.name).toBe("aidlc-test-pro");
      expect(manifest.name).toMatch(/^(?!.*(--|\.\.))[a-z0-9](?:[a-z0-9.-]{0,62}[a-z0-9])?$/);
      const author = manifest.author as Record<string, unknown>;
      expect(Object.keys(author).every((key) => ["name", "email", "url"].includes(key))).toBe(true);
      expect(typeof author.name).toBe("string");
      const marker = readProjectionMarker(root);
      expect(manifest.version).toBe(marker.version);
      expect(manifest.description).toBe(marker.description);
      const extensions = manifest.extensions as Record<string, Record<string, unknown>>;
      expect(Object.keys(extensions)).toEqual([AIDLC_EXTENSION_NAMESPACE]);
      expect(extensions[AIDLC_EXTENSION_NAMESPACE]).toEqual({
        plugin: marker.plugin,
        harness,
        producer: marker.producer,
      });
    }
  });

  test("a plugin whose host name would violate Agent Plugins naming is refused before emission", () => {
    const pluginRoot = join(scratch, "bad-name", "double--dash");
    mkdirSync(join(pluginRoot, ".aidlc-plugin"), { recursive: true });
    writeFileSync(join(pluginRoot, ".aidlc-plugin", "plugin.json"), JSON.stringify({
      name: "double--dash",
      version: "0.1.0",
      aidlc: { contributes: { stages: "stages/" } },
    }));
    mkdirSync(join(pluginRoot, "stages"));
    const { errors } = validatePluginRoot(pluginRoot);
    expect(errors.some((finding) => /not a valid Agent Plugins name/.test(finding.message))).toBe(true);
    const outDir = join(scratch, "bad-name-out");
    expect(() =>
      buildPluginProjection({
        pluginRoot,
        target: readPluginTargets(join(TOOLS_ROOT, "data", "plugin-targets.json")).claude,
        outDir,
        outputBoundary: scratch,
        templateHooksDir: join(TOOLS_ROOT, "data", "plugin-hooks-template"),
      })
    ).toThrow(/not a valid Agent Plugins name/);
    expect(existsSync(outDir)).toBe(false);
  });

  test("execution disclosure includes compose hooks, IDE hook registrations, and tool scripts", () => {
    const claude = executableFiles(join(PLUGINS_ROOT, "test-pro", "claude"));
    expect(claude.hooks).toContain("hooks/compose.ts");
    expect(claude.tools).toContain("tools/test-pro-doctor.ts");
    expect(claude.tools).toContain("tools/aidlc-sensor-coverage-threshold.ts");
    expect(claude.tools).toContain("tools/aidlc-sensor-requirement-coverage.ts");
    const ide = executableFiles(join(PLUGINS_ROOT, "test-pro", "kiro-ide"));
    expect(ide.hooks).toContain("hooks/compose.ts");
    expect(ide.hooks).toContain(".kiro/hooks/aidlc-test-pro-compose.json");
  });

  test.each([
    "owner/repo",
    "https://github.com/owner/repo.git",
    "git@github.com:owner/repo.git",
  ])("normalizes GitHub source %s to the same catalog endpoint", (source) => {
    const normalized = normalizeMarketplaceSource(source);
    expect(normalized.url).toBe("https://github.com/owner/repo");
    expect(normalized.defaultName).toBe("repo");
    expect(catalogUrl(normalized)).toBe(
      "https://api.github.com/repos/owner/repo/contents/aidlc-marketplace.json",
    );
  });

  test("direct catalog URLs retain their endpoint and require an explicit registration name", () => {
    const url = "https://market.example/x/aidlc-marketplace.json";
    const source = normalizeMarketplaceSource(url);
    expect(catalogUrl(source)).toBe(url);
    expect(source.defaultName).toBeNull();
  });

  test.each([
    "http://example.com/aidlc-marketplace.json",
    "https://user:secret@market.example/aidlc-marketplace.json",
    "https://github.com/owner",
    "https://market.example/plugin.tar.gz",
  ])("rejects unsafe or incomplete marketplace source %s", (source) => {
    expect(() => normalizeMarketplaceSource(source)).toThrow(CatalogError);
  });

  test("archive resolution uses the plugin tag and refuses foreign archive hosts", () => {
    const github = normalizeMarketplaceSource("owner/repo");
    expect(archiveUrl(github, emittedPlugin)).toBe(
      `https://api.github.com/repos/owner/repo/tarball/${emittedPlugin.tag}`,
    );
    expect(() => archiveUrl(github, {
      ...emittedPlugin,
      archive: "https://foreign.example/plugin.tar.gz",
    })).toThrow("not the marketplace host");
    const direct = normalizeMarketplaceSource("https://market.example/aidlc-marketplace.json");
    expect(archiveUrl(direct, {
      ...emittedPlugin,
      archive: "https://market.example/plugin.tar.gz",
    })).toBe("https://market.example/plugin.tar.gz");
    expect(() => archiveUrl(direct, {
      ...emittedPlugin,
      archive: "https://foreign.example/plugin.tar.gz",
    })).toThrow("not the marketplace host");
  });

  test("machine allowlists distinguish exact sources and slash-terminated prefixes", () => {
    const source = "https://github.com/owner/repo";
    expect(marketplaceAllowed(source, [])).toBe(true);
    expect(marketplaceAllowed(source, ["owner/repo"])).toBe(true);
    expect(marketplaceAllowed(`${source}-other`, [source])).toBe(false);
    expect(marketplaceAllowed(source, ["https://github.com/owner/"])).toBe(true);
    expect(marketplaceAllowed("https://github.com/owner-other/repo", ["https://github.com/owner/"])).toBe(false);
  });

  test("assembly hashes each emitted harness and rejects version disagreement", () => {
    const root = copyMarketplace("assembly");
    const catalog = assembleCatalog(root);
    for (const plugin of catalog.plugins) {
      for (const projection of Object.values(plugin.harnesses)) {
        expect(projection.sha256).toBe(projectionDigest(join(root, projection.path)));
      }
    }
    const markerPath = join(root, "test-pro", "kiro", PROJECTION_MARKER);
    const marker = readProjectionMarker(dirname(markerPath));
    writeFileSync(markerPath, JSON.stringify({ ...marker, version: "9.9.9" }));
    expect(() => assembleCatalog(root)).toThrow("projections disagree on version");
  });

  test("the catalog CLI writes the neutral catalog and consumable host aggregates", () => {
    const root = copyMarketplace("cli");
    rmSync(join(root, CATALOG_FILE));
    rmSync(join(root, ".claude-plugin"), { recursive: true });
    rmSync(join(root, ".codex-plugin"), { recursive: true });
    const result = spawnSync(process.execPath, [
      join(REPO_ROOT, "core", "tools", "aidlc-plugin-catalog.ts"),
      root,
      "--name", "private-plugins",
      "--owner", "Example Company",
      "--json",
    ], { cwd: REPO_ROOT, encoding: "utf-8" });
    expect(result.status, result.stderr).toBe(0);
    const output = JSON.parse(result.stdout) as {
      ok: boolean;
      code: number;
      data: { catalog: PluginCatalog };
    };
    expect(output.ok).toBe(true);
    expect(output.code).toBe(0);
    const catalog = readCatalog(join(root, CATALOG_FILE));
    expect(catalog).toEqual(output.data.catalog);
    expect(catalog.name).toBe("private-plugins");
    expect(catalog.owner.name).toBe("Example Company");
    for (const harness of ["claude", "codex"] as const) {
      const aggregate = JSON.parse(
        readFileSync(join(root, `.${harness}-plugin`, "marketplace.json"), "utf-8"),
      ) as { plugins: Array<{ name: string; source: string }> };
      const entry = aggregate.plugins.find((plugin) => plugin.name === "aidlc-test-pro")!;
      const hostManifest = JSON.parse(readFileSync(
        join(root, entry.source, `.${harness}-plugin`, "plugin.json"), "utf-8",
      )) as { name: string };
      expect(hostManifest.name).toBe(entry.name);
    }
  });

  test("an authored graduation tombstone reaches catalog consumers through a built projection", () => {
    const pluginRoot = join(scratch, "graduated-source", "test-pro");
    cpSync(SOURCE_PLUGIN, pluginRoot, { recursive: true });
    const manifestPath = join(pluginRoot, ".aidlc-plugin", "plugin.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as {
      aidlc: Record<string, unknown>;
    };
    const supersededBy = { core: "9.0.0", note: "Included in core testing stages" };
    manifest.aidlc.supersededBy = supersededBy;
    manifest.aidlc.futureExtension = { enabled: true };
    writeFileSync(manifestPath, JSON.stringify(manifest));
    expect(validatePluginRoot(pluginRoot).errors).toEqual([]);
    const marketplaceRoot = join(scratch, "graduated-market");
    buildPluginProjection({
      pluginRoot,
      target: readPluginTargets(join(TOOLS_ROOT, "data", "plugin-targets.json")).claude,
      outDir: join(marketplaceRoot, "test-pro", "claude"),
      outputBoundary: scratch,
      templateHooksDir: join(TOOLS_ROOT, "data", "plugin-hooks-template"),
    });
    expect(assembleCatalog(marketplaceRoot).plugins[0].supersededBy).toEqual(supersededBy);
  });

  test.each([
    null,
    [[]],
    "9.0.0",
    {},
    { core: "9.0" },
    { core: "09.0.0" },
    { core: "9.0.0", note: "   " },
    { core: "9.0.0", note: 42 },
    { core: "9.0.0", extra: true },
  ])("invalid graduation metadata %j is reported as an authored manifest finding", (supersededBy) => {
    const root = join(mkdtempSync(join(scratch, "invalid-tombstone-")), "fixture-plugin");
    mkdirSync(join(root, ".aidlc-plugin"), { recursive: true });
    writeFileSync(join(root, ".aidlc-plugin", "plugin.json"), JSON.stringify({
      name: "fixture-plugin",
      version: "1.0.0",
      aidlc: { contributes: {}, supersededBy },
    }));
    const result = validatePluginRoot(root);
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(expect.objectContaining({
      file: ".aidlc-plugin/plugin.json",
      rule: "manifest-shape",
      message: expect.stringContaining("supersededBy"),
    }));
  });

  test("the emitter rejects invalid graduation metadata before creating output", () => {
    const pluginRoot = join(scratch, "invalid-emission", "fixture-plugin");
    mkdirSync(join(pluginRoot, ".aidlc-plugin"), { recursive: true });
    writeFileSync(join(pluginRoot, ".aidlc-plugin", "plugin.json"), JSON.stringify({
      name: "fixture-plugin",
      version: "1.0.0",
      aidlc: { contributes: {}, supersededBy: { core: "later" } },
    }));
    const outDir = join(scratch, "invalid-emission-output");
    expect(() => buildPluginProjection({
      pluginRoot,
      target: readPluginTargets(join(TOOLS_ROOT, "data", "plugin-targets.json")).claude,
      outDir,
      outputBoundary: scratch,
      templateHooksDir: join(TOOLS_ROOT, "data", "plugin-hooks-template"),
    })).toThrow(CatalogError);
    expect(existsSync(outDir)).toBe(false);
  });
});
