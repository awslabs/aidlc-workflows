// covers: tool:aidlc-dashboard, function:parseArgs, function:applyLaunch, function:main
//
// The `aidlc dashboard` launcher: argument parsing, auto-pinning the current
// AI-DLC project, and the start/print/exit contract around the in-process
// Command Center server.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../../core/command-center/server/config.ts";
import { applyLaunch, main, parseArgs } from "../../core/tools/aidlc-dashboard.ts";

const dirs: string[] = [];
const temp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "aidlc-dash-"));
  dirs.push(d);
  return d;
};
// A fresh clone: committed spaces and records, but no per-user cursors.
const workspace = (): string => {
  const d = temp();
  mkdirSync(join(d, "aidlc", "spaces", "default", "intents"), { recursive: true });
  return d;
};
const cfg = (): Config => ({ version: 1, roots: [], pins: [], hidden: [], repos: [], theme: "auto" });

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  process.exitCode = 0;
});

describe("parseArgs", () => {
  test("defaults: ephemeral port, opens the browser, human output", () => {
    const a = parseArgs([]);
    expect(a.port).toBe(0);
    expect(a.open).toBe(true);
    expect(a.json).toBe(false);
    expect(a.roots).toEqual([]);
  });

  test("skips the dispatcher verb, parses flags, repeats --root and --pin", () => {
    const a = parseArgs(["dashboard", "--port", "4381", "--no-open", "--json", "--root", "/a", "--root", "/b", "--pin", "/c"]);
    expect(a).toMatchObject({ port: 4381, open: false, json: true, roots: ["/a", "/b"], pins: ["/c"] });
  });

  test("rejects a bad port, a missing value and an unknown flag", () => {
    expect(() => parseArgs(["--port", "70000"])).toThrow("--port must be an integer 0-65535");
    expect(() => parseArgs(["--port", "-1"])).toThrow("--port needs a value");
    expect(() => parseArgs(["--port"])).toThrow("--port needs a value");
    expect(() => parseArgs(["--bogus"])).toThrow("unknown argument --bogus");
  });

  test("ignores global dispatcher flags and honours --project-dir", () => {
    const a = parseArgs(["--no-color", "--quiet", "--project-dir", "/p"]);
    expect(a.projectDir).toBe("/p");
  });
});

describe("applyLaunch", () => {
  test("auto-pins the current AI-DLC project", async () => {
    const here = workspace();
    const c = cfg();
    expect(await applyLaunch(c, parseArgs([]), here)).toBe(true);
    expect(c.pins).toEqual([here]);
  });

  test("auto-pins a fresh clone that has no active-space cursor", async () => {
    const here = workspace();
    expect(existsSync(join(here, "aidlc", "active-space"))).toBe(false);
    const c = cfg();
    expect(await applyLaunch(c, parseArgs([]), here)).toBe(true);
    expect(c.pins).toEqual([here]);
  });

  test("a stray aidlc file or a cursor without spaces is not a project", async () => {
    const file = temp();
    writeFileSync(join(file, "aidlc"), "");
    const cursorOnly = temp();
    mkdirSync(join(cursorOnly, "aidlc"));
    writeFileSync(join(cursorOnly, "aidlc", "active-space"), "default\n");
    const c = cfg();
    expect(await applyLaunch(c, parseArgs([]), file)).toBe(false);
    expect(await applyLaunch(c, parseArgs([]), cursorOnly)).toBe(false);
  });

  test("leaves a plain folder alone", async () => {
    const c = cfg();
    expect(await applyLaunch(c, parseArgs([]), temp())).toBe(false);
    expect(c.pins).toEqual([]);
  });

  test("does not pin a project a saved root already covers", async () => {
    const here = workspace();
    const c = cfg();
    c.roots.push(join(here, ".."));
    expect(await applyLaunch(c, parseArgs([]), here)).toBe(false);
  });

  test("adds --root and --pin once", async () => {
    const c = cfg();
    const a = parseArgs(["--root", "/r", "--pin", "/p"]);
    expect(await applyLaunch(c, a, temp())).toBe(true);
    expect(await applyLaunch(c, a, temp())).toBe(false);
    expect(c).toMatchObject({ roots: ["/r"], pins: ["/p"] });
  });
});

describe("main", () => {
  const capture = () => {
    const o = { out: "", err: "" };
    return { o, out: (s: string) => { o.out += s; }, err: (s: string) => { o.err += s; } };
  };
  type Started = { port?: number; uiDir?: string; configPath?: string };
  const fakeStart = (seen: Started[]) =>
    (async (o: Started) => {
      seen.push(o);
      return { url: "http://127.0.0.1:5/?t=x", port: 5, token: "x", hub: null, stop() {} };
    }) as never;

  test("a bad argument prints the usage line and exits 2", async () => {
    const c = capture();
    await main(["--bogus"], { out: c.out, err: c.err });
    expect(c.o.err).toContain("aidlc dashboard: unknown argument --bogus");
    expect(c.o.err).toContain("Usage: aidlc dashboard");
    expect(process.exitCode).toBe(2);
  });

  test("--help prints usage and exits 0 without starting a server", async () => {
    const c = capture();
    const seen: Started[] = [];
    await main(["--help"], { out: c.out, err: c.err, start: fakeStart(seen) });
    expect(c.o.out).toContain("Usage: aidlc dashboard");
    expect(seen).toEqual([]);
    expect(process.exitCode).toBe(0);
  });

  test("a missing UI bundle is a named error, exit 1", async () => {
    const c = capture();
    await main(["--no-open", "--config", join(temp(), "d.json")], { out: c.out, err: c.err, uiDir: () => null });
    expect(c.o.err).toContain("the Command Center UI bundle is missing from this install");
    expect(process.exitCode).toBe(1);
  });

  test("--json prints {url, port} and hands port, uiDir and config path to the server", async () => {
    const c = capture();
    const seen: Started[] = [];
    const config = join(temp(), "d.json");
    await main(["--json", "--no-open", "--config", config], {
      out: c.out, err: c.err, uiDir: () => "/ui", start: fakeStart(seen), cwd: temp, keepAlive: false,
    });
    expect(JSON.parse(c.o.out.trim())).toEqual({ url: "http://127.0.0.1:5/?t=x", port: 5 });
    expect(seen[0]).toMatchObject({ port: 0, uiDir: "/ui", configPath: config });
  });

  test("human output names the URL and how to stop; the browser opens unless --no-open", async () => {
    const c = capture();
    const opened: string[] = [];
    await main(["--config", join(temp(), "d.json")], {
      out: c.out, err: c.err, uiDir: () => "/ui", start: fakeStart([]), cwd: temp, keepAlive: false,
      open: (u) => { opened.push(u); },
    });
    expect(c.o.out).toBe("AI-DLC Command Center → http://127.0.0.1:5/?t=x\nPress Ctrl-C to stop.\n");
    expect(opened).toEqual(["http://127.0.0.1:5/?t=x"]);
  });

  test("auto-pinning saves the settings file", async () => {
    const c = capture();
    const here = workspace();
    const config = join(temp(), "d.json");
    await main(["--no-open", "--config", config], {
      out: c.out, err: c.err, uiDir: () => "/ui", start: fakeStart([]), cwd: () => here, keepAlive: false,
    });
    expect(JSON.parse(await Bun.file(config).text()).pins).toEqual([here]);
  });

  test("a server start failure exits 1 with the reason", async () => {
    const c = capture();
    const start = (async () => { throw new Error("port 4381 is in use"); }) as never;
    await main(["--no-open", "--config", join(temp(), "d.json")], { out: c.out, err: c.err, uiDir: () => "/ui", start, cwd: temp });
    expect(c.o.err).toContain("Could not start the Command Center: port 4381 is in use");
    expect(process.exitCode).toBe(1);
  });
});
