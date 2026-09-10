import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Server } from "bun";
import { createTarGz } from "../../core/tools/aidlc-archive.ts";
import { assembleCatalog, CATALOG_FILE, projectionFiles, PROJECTION_MARKER, writeCatalogFiles } from "../../core/tools/aidlc-plugin-catalog.ts";
import type { PluginCatalog, SupersededBy } from "../../core/tools/aidlc-plugin-catalog.ts";
import { copyHarnessInstall } from "../harness/plugin-kit.ts";

const REPO = resolve(import.meta.dir, "../..");
const temporary: string[] = [];
const servers: Server<undefined>[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(harness: "kiro" | "claude" = "kiro") {
  const root = mkdtempSync(join(tmpdir(), "aidlc-market-test-"));
  temporary.push(root);
  const project = join(root, "project");
  const market = join(root, "market");
  const machine = join(root, "machine");
  mkdirSync(machine);
  copyHarnessInstall(harness, project);
  for (const name of ["kiro", "claude"] as const) {
    cpSync(join(REPO, "dist", "plugins", "test-pro", name), join(market, "test-pro", name), { recursive: true });
  }
  let catalog: PluginCatalog;
  const archives = new Map<string, Buffer>();
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === `/${CATALOG_FILE}`) return Response.json(catalog);
      const archive = archives.get(path);
      if (archive) return new Response(new Uint8Array(archive), { headers: { "content-type": "application/gzip" } });
      return new Response("not found", { status: 404 });
    },
  });
  servers.push(server);
  const origin = `http://127.0.0.1:${server.port}`;
  const url = `${origin}/${CATALOG_FILE}`;
  function publish(version = "0.1.0", supersededBy?: SupersededBy) {
    for (const harness of ["kiro", "claude"] as const) {
      const projection = join(market, "test-pro", harness);
      const markerPath = join(projection, PROJECTION_MARKER);
      const marker = JSON.parse(readFileSync(markerPath, "utf-8"));
      marker.version = version;
      if (supersededBy) marker.supersededBy = supersededBy;
      else delete marker.supersededBy;
      writeFileSync(markerPath, JSON.stringify(marker));
      const manifestPath = join(projection, `.${harness}-plugin`, "plugin.json");
      const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
      manifest.version = version;
      writeFileSync(manifestPath, JSON.stringify(manifest));
    }
    catalog = assembleCatalog(market, { name: "local", owner: "Test", archiveBase: `${origin}/` });
    writeCatalogFiles(market, catalog);
    archives.set(`/test-pro--v${version}.tar.gz`, createTarGz(projectionFiles(market).map((file) => ({
      path: `market/${file}`, type: "file", mode: statSync(join(market, file)).mode & 0o777, data: readFileSync(join(market, file)),
    }))));
  }
  publish();
  async function run(args: string[], env: NodeJS.ProcessEnv = {}, direct = false) {
    const child = Bun.spawn([process.execPath, join(REPO, "core", "tools", direct ? "aidlc-plugin-market.ts" : "aidlc.ts"), ...(direct ? [] : ["plugin"]), ...args], {
      cwd: project, stdin: "ignore", stdout: "pipe", stderr: "pipe",
      env: {
        ...process.env, AIDLC_INSTALL_ROOT: machine, AIDLC_BIN_DIR: join(machine, "bin"), AIDLC_ROUTE_NETWORK_POLICY: "explicit-only", AIDLC_OFFLINE: "0",
        AIDLC_HARNESS_DIR: "", AIDLC_HARNESS_NAME: "", CLAUDE_PLUGIN_ROOT: "", PLUGIN_ROOT: "", AIDLC_PLUGIN_ROOT: "",
        AIDLC_CLAUDE_PLUGIN_REGISTRY: join(root, "missing-registry"), AIDLC_CLAUDE_SETTINGS: join(root, "missing-claude-settings"),
        NO_PROXY: "127.0.0.1,localhost", ...env,
      },
    });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { code, stdout, stderr };
  }
  return { root, project, machine, market, url, origin, run, publish, catalog: () => catalog };
}

async function register(f: { url: string; run(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> }) {
  const result = await f.run(["marketplaces", "add", f.url, "--name", "local", "--project"]);
  expect(result, result.stdout + result.stderr).toMatchObject({ code: 0 });
}

describe("t330 plugin marketplace", () => {
  test("registration, discovery, removal, and empty registration remediation", async () => {
    const f = fixture();
    const empty = await f.run(["search", "--json"]);
    expect(empty.code).toBe(1);
    expect(JSON.parse(empty.stdout).remediation).toBe("aidlc plugin marketplaces add <owner/repo|url>");
    await register(f);
    expect(JSON.parse(readFileSync(join(f.project, "aidlc.settings.json"), "utf-8")).plugins.marketplaces.local.url).toBe(f.url);
    expect((await f.run(["marketplaces", "list"])).stdout).toContain(`local`);
    const found = await f.run(["search", "TEST-PRO", "--json"]);
    expect(found.code).toBe(0);
    expect(JSON.parse(found.stdout).data.plugins).toEqual([expect.objectContaining({ plugin: "test-pro", version: "0.1.0", marketplace: "local" })]);
    expect(JSON.parse((await f.run(["search", "nomatch", "--json"])).stdout).data.plugins).toEqual([]);
    expect((await f.run(["marketplaces", "remove", "local", "--project"])).code).toBe(0);
    expect((await f.run(["search"])).code).toBe(1);
    expect((await f.run(["marketplaces", "remove", "local"])).code).toBe(1);
  });

  test("managed install composes stages and records provenance; updates replace the projection", async () => {
    const f = fixture();
    chmodSync(join(f.market, "test-pro", "kiro", "hooks", "compose.ts"), 0o755);
    f.publish();
    await register(f);
    const result = await f.run(["install", "test-pro", "--harness", "kiro", "--yes", "--json"]);
    expect(result, result.stdout + result.stderr).toMatchObject({ code: 0 });
    expect(JSON.parse(result.stdout).data).toMatchObject({ plugin: "test-pro", harness: "kiro", composed: true });
    const projection = join(f.project, ".kiro", "plugins", "test-pro");
    expect(existsSync(join(projection, ".kiro-plugin", "plugin.json"))).toBe(true);
    expect(statSync(join(projection, "hooks", "compose.ts")).mode & 0o777).toBe(0o755);
    const recordPath = join(f.project, ".kiro", "tools", "data", "plugin-install-test-pro.json");
    expect(JSON.parse(readFileSync(recordPath, "utf-8"))).toMatchObject({
      schemaVersion: 1, plugin: "test-pro", version: "0.1.0", harness: "kiro", marketplace: { name: "local", url: f.url },
      tag: "test-pro--v0.1.0", sha256: f.catalog().plugins[0].harnesses.kiro?.sha256,
    });
    const stages = JSON.parse(readFileSync(join(f.project, ".kiro", "tools", "data", "stage-graph.json"), "utf-8"));
    expect(stages.some((stage: { slug: string }) => stage.slug.startsWith("test-pro-"))).toBe(true);
    expect(JSON.parse((await f.run(["list", "--json"])).stdout).data.statuses).toEqual([expect.objectContaining({ key: "test-pro", state: "current" })]);
    expect((await f.run(["install", "test-pro", "--yes"])).stdout).toContain("already installed");
    writeFileSync(join(projection, "obsolete.txt"), "remove on replacement");
    f.publish("0.2.0");
    const checked = await f.run(["list", "--check", "--json"]);
    expect(checked.code).toBe(0);
    expect(JSON.parse(checked.stdout).data.statuses[0]).toMatchObject({
      message: "update available: aidlc plugin update test-pro", published: { version: "0.2.0", marketplace: "local" },
    });
    const updated = await f.run(["update", "test-pro", "--yes"]);
    expect(updated, updated.stdout + updated.stderr).toMatchObject({ code: 0 });
    expect(JSON.parse(readFileSync(recordPath, "utf-8")).version).toBe("0.2.0");
    expect(existsSync(join(projection, "obsolete.txt"))).toBe(false);
    expect((await f.run(["list", "--check"])).stdout).toContain("current");
    expect((await f.run(["update", "test-pro", "--yes"])).stdout).toContain("already current");
  }, 30_000);

  test("unconfirmed and digest-mismatched installs leave the project untouched", async () => {
    const f = fixture();
    await register(f);
    const refused = await f.run(["install", "test-pro", "--harness", "kiro"]);
    expect(refused.code).toBe(2);
    expect(refused.stdout).toContain("refusing to install without confirmation");
    expect(refused.stdout).toContain("hooks/compose.ts");
    expect(existsSync(join(f.project, ".kiro", "plugins", "test-pro"))).toBe(false);
    f.catalog().plugins[0].harnesses.kiro!.sha256 = "0".repeat(64);
    const tampered = await f.run(["install", "test-pro", "--yes"]);
    expect(tampered.code).toBe(4);
    expect(tampered.stdout).toContain("nothing was installed");
    expect(existsSync(join(f.project, ".kiro", "plugins", "test-pro"))).toBe(false);
    expect(existsSync(join(f.project, ".kiro", "tools", "data", "plugin-install-test-pro.json"))).toBe(false);
  });

  test("offline and forbidden routes refuse network; explicit offline registration remains local", async () => {
    const f = fixture();
    await register(f);
    for (const args of [["list", "--check"], ["install", "test-pro", "--yes"], ["search"]]) {
      const forbidden = await f.run(args, { AIDLC_ROUTE_NETWORK_POLICY: "forbidden" }, true);
      expect(forbidden.code).toBe(3);
      expect(forbidden.stdout).toContain("not under `aidlc engine`");
      expect((await f.run([...args, "--offline"])).code).toBe(3);
      expect((await f.run(args, { AIDLC_OFFLINE: "1" })).code).toBe(3);
    }
    const registration = await f.run(["marketplaces", "add", "https://unreachable.invalid/aidlc-marketplace.json", "--name", "offline", "--offline"]);
    expect(registration.code).toBe(0);
    const failed = await f.run(["marketplaces", "add", `${f.origin}/missing/aidlc-marketplace.json`, "--name", "bad"]);
    expect(failed.code).toBe(3);
    expect(JSON.parse(readFileSync(join(f.project, "aidlc.settings.json"), "utf-8")).plugins.marketplaces.bad).toBeUndefined();
    writeFileSync(join(f.machine, "aidlc.settings.json"), JSON.stringify({ schemaVersion: 1, offline: true }));
    expect((await f.run(["search"], { AIDLC_OFFLINE: "" })).code).toBe(3);
  });

  test("partial catalog failures warn, source collisions refuse, and updates prefer recorded marketplace", async () => {
    const f = fixture();
    await register(f);
    const conflict = await f.run(["marketplaces", "add", `${f.origin}/missing/aidlc-marketplace.json`, "--name", "local"]);
    expect(conflict.code).toBe(1);
    expect(conflict.stdout).toContain("already registered with a different URL");
    expect((await f.run(["marketplaces", "add", `${f.origin}/missing/aidlc-marketplace.json`, "--name", "missing", "--offline"])).code).toBe(0);
    const partial = await f.run(["search"]);
    expect(partial.code).toBe(0);
    expect(partial.stdout).toContain("test-pro");
    expect(partial.stderr).toContain("warning: marketplace missing:");
    expect((await f.run(["marketplaces", "remove", "missing"])).code).toBe(0);
    expect((await f.run(["marketplaces", "add", f.url, "--name", "other"])).code).toBe(0);
    const ambiguous = await f.run(["install", "test-pro", "--yes"]);
    expect(ambiguous.code).toBe(1);
    expect(ambiguous.stdout).toContain("--marketplace");
    expect((await f.run(["install", "test-pro", "--marketplace", "local", "--yes"])).code).toBe(0);
    f.publish("0.2.0");
    expect((await f.run(["update", "test-pro", "--yes"])).code).toBe(0);
  }, 30_000);

  test("composition failure keeps verified install and tells the user to sync", async () => {
    const f = fixture();
    writeFileSync(join(f.market, "test-pro", "kiro", "hooks", "compose.ts"), "throw new Error('compose fixture failure');\n");
    f.publish();
    await register(f);
    const result = await f.run(["install", "test-pro", "--yes", "--json"]);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout).remediation).toBe("aidlc engine plugin sync");
    expect(existsSync(join(f.project, ".kiro", "plugins", "test-pro", PROJECTION_MARKER))).toBe(true);
    expect(JSON.parse((await f.run(["list", "--json"])).stdout).data.statuses[0]).toMatchObject({ state: "not-composed", action: "sync" });
  });

  test("catalog and installed tombstones report graduation offline and online", async () => {
    const f = fixture();
    await register(f);
    expect((await f.run(["install", "test-pro", "--yes"])).code).toBe(0);
    f.catalog().plugins[0].supersededBy = { core: "9.0.0" };
    expect((await f.run(["list", "--check"])).stdout).toContain("superseded by core v9.0.0 - remove the plugin after upgrading");
    f.publish("0.2.0", { core: "9.0.0", note: "now maintained in core" });
    expect((await f.run(["update", "test-pro", "--yes"])).code).toBe(0);
    const offline = await f.run(["list"], { AIDLC_OFFLINE: "1" });
    expect(offline.code).toBe(0);
    expect(offline.stdout).toContain("needs attention: superseded by core v9.0.0");
  }, 30_000);

  test("Claude verifies the projection then hands off without managed installation", async () => {
    const f = fixture("claude");
    await register(f);
    const result = await f.run(["install", "test-pro", "--harness", "claude", "--yes"]);
    expect(result.code).toBe(5);
    expect(result.stdout).toContain("checksum verified");
    expect(result.stdout).toContain(`/plugin marketplace add ${f.url}`);
    expect(result.stdout).toContain("/plugin install aidlc-test-pro@local");
    expect(existsSync(join(f.project, ".claude", "plugins"))).toBe(false);
  });

  test("marketplace layers merge by name and the machine allowlist gates both registration and use", async () => {
    const f = fixture();
    await register(f);
    expect((await f.run(["marketplaces", "add", f.url, "--name", "machine", "--global"])).code).toBe(0);
    expect((await f.run(["marketplaces", "add", f.url, "--name", "private", "--local"])).code).toBe(0);
    const listing = JSON.parse((await f.run(["marketplaces", "list", "--json"])).stdout).data.marketplaces;
    expect(listing).toEqual([
      expect.objectContaining({ name: "local", layer: "project" }), expect.objectContaining({ name: "machine", layer: "machine" }), expect.objectContaining({ name: "private", layer: "local" }),
    ]);
    writeFileSync(join(f.machine, "aidlc.settings.json"), JSON.stringify({ schemaVersion: 1, plugins: { schemaVersion: 1, allowedMarketplaces: ["https://github.com/approved/"] } }));
    expect((await f.run(["marketplaces", "list"])).stdout).toContain("blocked by machine allowlist");
    const blocked = await f.run(["install", "test-pro", "--marketplace", "local", "--yes"]);
    expect(blocked.code).toBe(1);
    expect(blocked.stdout).toContain(join(f.machine, "aidlc.settings.json"));
    expect((await f.run(["marketplaces", "add", f.url, "--name", "blocked", "--offline"])).code).toBe(1);
    writeFileSync(join(f.project, "aidlc.settings.json"), JSON.stringify({ schemaVersion: 1, plugins: { schemaVersion: 1, allowedMarketplaces: [] } }));
    expect((await f.run(["marketplaces", "list"])).stdout).toContain("machine-only");
  });
});
