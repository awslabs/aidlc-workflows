import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, stat, symlink, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contain, rewriteRecordedPath } from "../../core/command-center/server/paths";
import { loadConfig, saveConfig, validateConfig } from "../../core/command-center/server/config";
import { discover } from "../../core/command-center/server/discovery";
import { isRepoUrl, repoCredentials, repoHost } from "../../core/command-center/server/repos";
import { LocalFolderSource } from "../../core/command-center/server/source";
import { makeWorkspace } from "./fixtures/make";

const tmp = (p: string) => mkdtemp(join(tmpdir(), p));

test("concurrent saveConfig calls land in call order and leave no temp files", async () => {
  const dir = await tmp("cc-save-"); const p = join(dir, "dashboard.json");
  const mk = (r: string) => ({ version: 1 as const, roots: [r], pins: [], hidden: [], repos: [], theme: "auto" as const });
  await Promise.all([saveConfig(mk("/first"), p), saveConfig(mk("/second"), p)]);
  expect((await loadConfig(p)).roots).toEqual(["/second"]);
  expect(await readdir(dir)).toEqual(["dashboard.json"]);
});
test("corrupt config is preserved as .corrupt-* and defaults returned", async () => {
  const dir = await tmp("cc-corrupt-"); const p = join(dir, "dashboard.json");
  await writeFile(p, "{not json");
  expect((await loadConfig(p)).roots).toEqual([]);
  const bad = (await readdir(dir)).filter((f) => f.startsWith("dashboard.json.corrupt-"));
  expect(bad.length).toBe(1);
  expect(await readFile(join(dir, bad[0]!), "utf8")).toBe("{not json");
});
test("an unreadable config (EISDIR) is not quarantined and is never saved over", async () => {
  const dir = await tmp("cc-eisdir-"); const p = join(dir, "dashboard.json");
  await mkdir(p);
  expect((await loadConfig(p)).roots).toEqual([]);
  expect(await readdir(dir)).toEqual(["dashboard.json"]);
  await expect(saveConfig({ version: 1, roots: ["/x"], pins: [], hidden: [], repos: [], theme: "auto" }, p)).rejects.toThrow(/could not be read/);
  expect((await stat(p)).isDirectory()).toBe(true);
});
test.skipIf(process.getuid?.() === 0)("an unreadable config (EACCES) keeps its bytes; saving resumes after a clean load", async () => {
  const dir = await tmp("cc-eacces-"); const p = join(dir, "dashboard.json");
  await writeFile(p, JSON.stringify({ roots: ["/kept"] })); await chmod(p, 0o000);
  try {
    expect((await loadConfig(p)).roots).toEqual([]);
    expect(await readdir(dir)).toEqual(["dashboard.json"]);
    await expect(saveConfig({ version: 1, roots: [], pins: [], hidden: [], repos: [], theme: "auto" }, p)).rejects.toThrow();
  } finally { await chmod(p, 0o644); }
  expect(JSON.parse(await readFile(p, "utf8")).roots).toEqual(["/kept"]);
  expect((await loadConfig(p)).roots).toEqual(["/kept"]);
  await saveConfig({ version: 1, roots: ["/new"], pins: [], hidden: [], repos: [], theme: "auto" }, p);
  expect((await loadConfig(p)).roots).toEqual(["/new"]);
});
test("validateConfig sanitises fields", () => {
  const c = validateConfig({ roots: "abc", theme: "neon", pins: [1, "/p"] });
  expect(c.roots).toEqual([]); expect(c.theme).toBe("auto"); expect(c.pins).toEqual(["/p"]); expect(c.hidden).toEqual([]);
});
test("rewriteRecordedPath rejects traversal out of aidlc/", () => {
  expect(rewriteRecordedPath("/x/aidlc/../../etc/passwd", "/p")).toBeNull();
});
test("contain rejects sibling with shared prefix", async () => {
  const base = await tmp("cc-sib-"); await mkdir(join(base, "ws")); await mkdir(join(base, "ws-evil"));
  expect(await contain(join(base, "ws"), join(base, "ws-evil"))).toBeNull();
});
test("LocalFolderSource refuses ../ and symlinked-file escapes", async () => {
  const ws = await makeWorkspace(); const src = new LocalFolderSource(ws);
  const outside = join(await tmp("cc-out-"), "secret.txt"); await writeFile(outside, "secret");
  await symlink(outside, join(ws, "aidlc/leak.txt"));
  await expect(src.read("../x")).rejects.toThrow();
  await expect(src.list("..")).rejects.toThrow();
  await expect(src.read("aidlc/leak.txt")).rejects.toThrow();
});
test("discover does not descend into symlinked directories", async () => {
  const root = await tmp("cc-sym-"); const real = await tmp("cc-real-");
  await mkdir(join(real, "aidlc")); await symlink(real, join(root, "link"));
  expect((await discover({ version: 1, roots: [root], pins: [], hidden: [], repos: [], theme: "auto" })).length).toBe(0);
});
test("watch calls back when a file under aidlc/ is written", async () => {
  const ws = await makeWorkspace(); const src = new LocalFolderSource(ws);
  const seen: string[] = []; const w = src.watch((r) => seen.push(r));
  await Bun.sleep(100); await writeFile(join(ws, "aidlc/touched.txt"), "x");
  for (const end = Date.now() + 5000; !seen.length && Date.now() < end;) await Bun.sleep(50);
  w.close(); expect(seen.length).toBeGreaterThan(0);
});
test("validateConfig keeps only well-formed repo URLs, deduped and capped at 200; old configs without repos load", () => {
  const c = validateConfig({ repos: ["https://github.com/example/app", "git@gitlab.com:example/app.git", "ssh://git@host.example/x.git",
    "https://github.com/example/app", "http://insecure.example/x", "ftp://x", "https://has space", "git@nocolon", 7, "file:///etc"] });
  expect(c.repos).toEqual(["https://github.com/example/app", "git@gitlab.com:example/app.git", "ssh://git@host.example/x.git"]);
  expect(validateConfig({ repos: Array.from({ length: 250 }, (_, i) => `https://git.example/r${i}`) }).repos.length).toBe(200);
  expect(validateConfig({ roots: ["/r"] }).repos).toEqual([]);
});
test("repoHost labels the common git hosts and falls back to Git", () => {
  expect(repoHost("https://github.com/example/app")).toBe("GitHub");
  expect(repoHost("git@gitlab.com:example/app.git")).toBe("GitLab");
  expect(repoHost("https://bitbucket.org/example/app")).toBe("Bitbucket");
  expect(repoHost("https://dev.azure.com/example/p/_git/app")).toBe("Azure DevOps");
  expect(repoHost("git@ssh.dev.azure.com:v3/example/p/app")).toBe("Azure DevOps");
  expect(repoHost("https://example.visualstudio.com/p/_git/app")).toBe("Azure DevOps");
  expect(repoHost("ssh://git@git.example/x.git")).toBe("Git");
  expect(isRepoUrl("https://github.com/example/app")).toBe(true); expect(isRepoUrl("github.com/example")).toBe(false);
});
test("repo URLs carrying credentials are refused; plain git@ and ssh://git@ are kept", () => {
  for (const bad of ["https://x@github.com/example/app", "https://x:y@github.com/example/app", "https://:tok@git.example/r",
    "https://ghp_abc123@github.com/example/app.git", "ssh://git:secret@host.example/x.git", "ssh://user:pw@host.example:22/x"])
    expect(isRepoUrl(bad)).toBe(false);
  for (const ok of ["git@github.com:example/app.git", "ssh://git@host.example/x.git", "ssh://host.example/x.git", "https://github.com/example/app", "https://git.example/a@b"])
    expect(isRepoUrl(ok)).toBe(true);
  expect(repoCredentials("https://x:y@github.com/e/a")).toBe(true); expect(repoCredentials("git@github.com:e/a")).toBe(false);
  expect(validateConfig({ repos: ["https://x:y@github.com/e/a", "ssh://git:pw@h.example/x", "ssh://git@h.example/x"] }).repos).toEqual(["ssh://git@h.example/x"]);
});
