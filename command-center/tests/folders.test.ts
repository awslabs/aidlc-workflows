import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { FolderError, listFolder, pickFolder, type SpawnFn, type PickResult } from "../../core/command-center/server/folders";
import { startServer } from "../../core/command-center/server/index";

const enoent = () => Object.assign(new Error("Executable not found"), { code: "ENOENT" });
/** A fake spawn: answers per executable name; records every argv it was given. */
function fake(answers: Record<string, { code: number; stdout?: string; stderr?: string } | "ENOENT">) {
  const calls: string[][] = [];
  const spawn: SpawnFn = async (argv) => {
    calls.push(argv);
    const a = answers[argv[0]!];
    if (!a || a === "ENOENT") throw enoent();
    return { code: a.code, stdout: a.stdout ?? "", stderr: a.stderr ?? "" };
  };
  return { spawn, calls };
}

let dir: string; let real: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "cc-folders-"));
  real = await realpath(dir);
  await mkdir(join(dir, "beta/aidlc"), { recursive: true });
  await mkdir(join(dir, "alpha"));
  await mkdir(join(dir, ".hidden-dir"));
  await writeFile(join(dir, "notes.txt"), "file contents must never be returned");
  await symlink(join(dir, "notes.txt"), join(dir, "link-to-file"));
  await symlink(join(dir, "alpha"), join(dir, "link-to-dir"));
});

// ---- pickFolder ----
test("macOS: osascript with a fixed argv returns the chosen folder without its trailing slash", async () => {
  const f = fake({ osascript: { code: 0, stdout: `${dir}/\n` } });
  expect(await pickFolder({ spawn: f.spawn, platform: "darwin" })).toEqual({ path: dir });
  expect(f.calls).toEqual([["osascript", "-e", 'POSIX path of (choose folder with prompt "Choose a folder for the AI-DLC Command Center")']]);
});
test("macOS: User canceled is cancelled; another failure is unavailable", async () => {
  expect(await pickFolder({ spawn: fake({ osascript: { code: 1, stderr: "execution error: User canceled. (-128)" } }).spawn, platform: "darwin" })).toEqual({ cancelled: true });
  const r = await pickFolder({ spawn: fake({ osascript: { code: 1, stderr: "execution error: not allowed (-1743)" } }).spawn, platform: "darwin" });
  expect("unavailable" in r).toBe(true);
});
test("Windows: PowerShell FolderBrowserDialog in STA; empty output is cancelled", async () => {
  const f = fake({ "powershell.exe": { code: 0, stdout: `${dir}\r\n` } });
  expect(await pickFolder({ spawn: f.spawn, platform: "win32" })).toEqual({ path: dir });
  expect(f.calls[0]!.slice(0, 3)).toEqual(["powershell.exe", "-NoProfile", "-STA"]);
  expect(f.calls[0]!.join(" ")).toContain("System.Windows.Forms.FolderBrowserDialog");
  expect(await pickFolder({ spawn: fake({ "powershell.exe": { code: 0, stdout: "\r\n" } }).spawn, platform: "win32" })).toEqual({ cancelled: true });
});
test("Linux: zenity first, kdialog when zenity is missing, unavailable when neither exists", async () => {
  expect(await pickFolder({ spawn: fake({ zenity: { code: 0, stdout: `${dir}\n` } }).spawn, platform: "linux" })).toEqual({ path: dir });
  expect(await pickFolder({ spawn: fake({ zenity: { code: 1 } }).spawn, platform: "linux" })).toEqual({ cancelled: true });
  const k = fake({ zenity: "ENOENT", kdialog: { code: 0, stdout: `${dir}\n` } });
  expect(await pickFolder({ spawn: k.spawn, platform: "linux" })).toEqual({ path: dir });
  expect(k.calls[1]).toEqual(["kdialog", "--getexistingdirectory", homedir()]);
  const none = await pickFolder({ spawn: fake({}).spawn, platform: "linux" });
  expect("unavailable" in none && none.unavailable).toContain("zenity");
});
test("a chosen path that is not an existing directory is unavailable", async () => {
  const file = await pickFolder({ spawn: fake({ osascript: { code: 0, stdout: `${join(dir, "notes.txt")}\n` } }).spawn, platform: "darwin" });
  expect("unavailable" in file).toBe(true);
  const gone = await pickFolder({ spawn: fake({ osascript: { code: 0, stdout: `${join(dir, "nope")}/\n` } }).spawn, platform: "darwin" });
  expect("unavailable" in gone).toBe(true);
});
test("the filesystem root keeps its slash; an unsupported platform is unavailable", async () => {
  expect(await pickFolder({ spawn: fake({ osascript: { code: 0, stdout: "/\n" } }).spawn, platform: "darwin" })).toEqual({ path: "/" });
  expect("unavailable" in await pickFolder({ spawn: fake({}).spawn, platform: "aix" })).toBe(true);
});

test("a chooser left open past the timeout is killed and reported unavailable", async () => {
  let killed = false; let armed = 0;
  const hanging: SpawnFn = (_argv, signal) => new Promise((_, reject) => {
    signal?.addEventListener("abort", () => { killed = true; reject(Object.assign(new Error("killed"), { code: "ABORT_ERR" })); });
  });
  // An injected timer that fires at once and records the requested delay.
  const timer = (fn: () => void, ms: number) => { armed = ms; queueMicrotask(fn); return () => {}; };
  const r = await pickFolder({ spawn: hanging, platform: "darwin", timer });
  expect(killed).toBe(true); expect(armed).toBe(10 * 60_000);
  expect("unavailable" in r && r.unavailable).toContain("timed out");
});
test("the timer is cancelled once the chooser answers", async () => {
  let cancelled = false;
  const timer = () => () => { cancelled = true; };
  expect(await pickFolder({ spawn: fake({ osascript: { code: 0, stdout: `${dir}\n` } }).spawn, platform: "darwin", timer })).toEqual({ path: dir });
  expect(cancelled).toBe(true);
});

// ---- listFolder ----
test("listFolder lists directories only, sorted, with isAidlc; never files, dotdirs or symlinks to files", async () => {
  const r = await listFolder(dir);
  expect(r.path).toBe(real);
  expect(r.entries.map((e) => e.name)).toEqual(["alpha", "beta", "link-to-dir"]);
  expect(r.entries.find((e) => e.name === "beta")).toEqual({ name: "beta", path: join(real, "beta"), isAidlc: true });
  expect(r.entries.find((e) => e.name === "alpha")!.isAidlc).toBe(false);
  expect(JSON.stringify(r)).not.toContain("file contents");
  expect(r.parent).toBe(join(real, ".."));
  expect(r.truncated).toBe(false);
});
test("listFolder defaults to the home folder; the root has no parent", async () => {
  expect((await listFolder()).path).toBe(await realpath(homedir()));
  expect((await listFolder("/")).parent).toBeNull();
});
test("listFolder rejects relative paths, missing paths and files", async () => {
  await expect(listFolder("relative/x")).rejects.toBeInstanceOf(FolderError);
  await expect(listFolder(join(dir, "nope"))).rejects.toMatchObject({ status: 404, message: "not a folder" });
  await expect(listFolder(join(dir, "notes.txt"))).rejects.toMatchObject({ status: 404, message: "not a folder" });
});
test("listFolder caps the listing at 500 entries and says so", async () => {
  const big = await mkdtemp(join(tmpdir(), "cc-big-"));
  await Promise.all(Array.from({ length: 503 }, (_, i) => mkdir(join(big, `d${String(i).padStart(3, "0")}`))));
  const r = await listFolder(big);
  expect(r.entries.length).toBe(500); expect(r.truncated).toBe(true);
  expect(r.entries[0]!.name).toBe("d000");
});

// ---- routes ----
type S = Awaited<ReturnType<typeof startServer>>;
let s: S; let s2: S; let release: (r: PickResult) => void = () => {};
let picks = 0;
beforeAll(async () => {
  const ui = await mkdtemp(join(tmpdir(), "cc-ui-")); await writeFile(join(ui, "index.html"), "<!doctype html>");
  s = await startServer({ port: 0, config: { version: 1, roots: [], pins: [], hidden: [], repos: [], theme: "auto" }, configPath: join(await mkdtemp(join(tmpdir(), "cc-")), "c.json"), uiDir: ui,
    pick: () => { picks++; return new Promise<PickResult>((r) => { release = r; }); } });
});
afterAll(() => { s.stop(); s2?.stop(); });
const api = (p: string, init: RequestInit = {}, token: string | null = s.token) =>
  fetch(`http://127.0.0.1:${s.port}${p}`, { ...init, headers: { ...(token ? { "x-cc-token": token } : {}), ...(init.headers as Record<string, string> | undefined) } });

test("folder routes require the token and refuse a foreign Host", async () => {
  expect((await api(`/api/folders/list?path=${encodeURIComponent(dir)}`, {}, null)).status).toBe(401);
  expect((await api("/api/folders/pick", { method: "POST" }, "wrong")).status).toBe(401);
  expect((await api(`/api/folders/list?path=${encodeURIComponent(dir)}`, { headers: { host: "evil.example" } })).status).toBe(421);
  expect((await api("/api/folders/pick", { method: "POST", headers: { host: "evil.example" } })).status).toBe(421);
  expect(picks).toBe(0);
});
test("GET /api/folders/list returns names only; bad paths are 400/404", async () => {
  const r = await api(`/api/folders/list?path=${encodeURIComponent(dir)}`);
  expect(r.status).toBe(200); expect(r.headers.get("cache-control")).toBe("no-store");
  expect((await r.json()).entries.map((e: { name: string }) => e.name)).toEqual(["alpha", "beta", "link-to-dir"]);
  expect((await api("/api/folders/list?path=relative")).status).toBe(400);
  expect((await api(`/api/folders/list?path=${encodeURIComponent(join(dir, "nope"))}`)).status).toBe(404);
  expect((await api("/api/folders/list", { method: "POST" })).status).toBe(405);
});
test("POST /api/folders/pick: one chooser at a time; GET is 405", async () => {
  expect((await api("/api/folders/pick")).status).toBe(405);
  const first = api("/api/folders/pick", { method: "POST" });
  await Bun.sleep(50);
  const second = await (await api("/api/folders/pick", { method: "POST" })).json();
  expect(second).toEqual({ unavailable: "a folder chooser is already open" });
  release({ path: dir });
  expect(await (await first).json()).toEqual({ path: dir });
  expect(picks).toBe(1);
  // Free again once the first one answered.
  const third = api("/api/folders/pick", { method: "POST" }); await Bun.sleep(50); release({ cancelled: true });
  expect(await (await third).json()).toEqual({ cancelled: true });
});
test("the pick lock is released when the chooser times out", async () => {
  const ui = await mkdtemp(join(tmpdir(), "cc-ui-")); await writeFile(join(ui, "index.html"), "<!doctype html>");
  let n = 0;
  const hanging: SpawnFn = (_a, signal) => new Promise((_, reject) => { signal?.addEventListener("abort", () => reject(new Error("killed"))); });
  s2 = await startServer({ port: 0, config: { version: 1, roots: [], pins: [], hidden: [], repos: [], theme: "auto" }, configPath: join(await mkdtemp(join(tmpdir(), "cc-")), "c.json"), uiDir: ui,
    pick: () => { n++; return pickFolder({ spawn: hanging, platform: "darwin", timer: (fn) => { const t = setTimeout(fn, 30); return () => clearTimeout(t); } }); } });
  const call = () => fetch(`http://127.0.0.1:${s2.port}/api/folders/pick`, { method: "POST", headers: { "x-cc-token": s2.token } }).then((r) => r.json());
  expect((await call()).unavailable).toContain("timed out");
  expect((await call()).unavailable).toContain("timed out");
  expect(n).toBe(2);
});
