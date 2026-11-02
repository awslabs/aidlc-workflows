import { expect, test } from "bun:test";
import { mkdir, mkdtemp, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contain, rewriteRecordedPath } from "../../core/command-center/server/paths";
import { loadConfig, saveConfig } from "../../core/command-center/server/config";
import { discover } from "../../core/command-center/server/discovery";
import { makeWorkspace } from "./fixtures/make";

test("contain rejects traversal and symlink escape", async () => {
  const ws = await makeWorkspace();
  expect(await contain(ws, join(ws, "aidlc/spaces"))).not.toBeNull();
  expect(await contain(ws, join(ws, "../"))).toBeNull();
  await symlink("/etc", join(ws, "aidlc/evil"));
  expect(await contain(join(ws, "aidlc"), join(ws, "aidlc/evil/hosts"))).toBeNull();
});
test("rewriteRecordedPath maps a foreign absolute path into this project", () => {
  expect(rewriteRecordedPath("/Users/x/other/proj/aidlc/spaces/default/a.md", "/p")).toBe("/p/aidlc/spaces/default/a.md");
  expect(rewriteRecordedPath("relative/a.md", "/p")).toBeNull();
});
test("config round-trips and defaults", async () => {
  const p = join(await mkdtemp(join(tmpdir(), "cc-cfg-")), "dashboard.json");
  expect((await loadConfig(p)).roots).toEqual([]);
  await saveConfig({ version: 1, roots: ["/r"], pins: [], hidden: [], repos: [], theme: "auto" }, p);
  expect((await loadConfig(p)).roots).toEqual(["/r"]);
});
test("discover finds aidlc projects under roots, honours hidden, reports missing pins", async () => {
  const root = await mkdtemp(join(tmpdir(), "cc-root-"));
  for (const n of ["one", "two/nested", "node_modules/skip"]) await mkdir(join(root, n, "aidlc"), { recursive: true });
  const found = await discover({ version: 1, roots: [root], pins: ["/no/such/dir"], hidden: [join(root, "two/nested")], repos: [], theme: "auto" });
  expect(found.filter((f) => f.origin === "root").map((f) => f.path)).toEqual([join(root, "one")]);
  expect(found.find((f) => f.origin === "pin")!.exists).toBe(false);
});
