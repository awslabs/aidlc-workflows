// covers: tool:aidlc, route:top-dashboard, function:routeLifetime, function:renderCommandHelp
//
// `aidlc dashboard` is a public, long-lived route that forbids outbound
// network and writes only machine-scope settings; the dispatcher validates
// its flags before the launcher runs.
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  listRoutes,
  PUBLIC_COMMANDS,
  renderCommandHelp,
  renderHumanHelp,
  routeLifetime,
} from "../../core/tools/aidlc.ts";

const DISPATCHER = join(import.meta.dir, "../../core/tools/aidlc.ts");
const scratch = mkdtempSync(join(tmpdir(), "aidlc-dash-route-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function dispatch(args: string[]): { code: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [DISPATCHER, ...args], {
    cwd: scratch,
    env: { ...process.env, AIDLC_DASHBOARD_CONFIG: join(scratch, "dash.json") },
    timeout: 30_000,
  });
  return { code: r.status, stdout: String(r.stdout), stderr: String(r.stderr) };
}

describe("dashboard route", () => {
  const route = listRoutes().find((r) => r.id === "top-dashboard");

  test("is public, forbids outbound network, writes machine scope, and is long-lived", () => {
    expect(route).toBeDefined();
    expect(route?.verbs).toEqual(["dashboard"]);
    expect(route?.tool).toBe("aidlc-dashboard.ts");
    expect(route?.visibility).toBe("public");
    expect(route?.networkPolicy).toBe("forbidden");
    expect(route?.mutationScope).toBe("machine");
    if (route) expect(routeLifetime(route)).toBe("long-lived");
  });

  test("every other route stays bounded", () => {
    const longLived = listRoutes().filter((r) => routeLifetime(r) === "long-lived").map((r) => r.id);
    expect(longLived).toEqual(["top-dashboard"]);
  });

  test("is a public command with its own help", () => {
    expect(PUBLIC_COMMANDS).toContain("dashboard");
    expect(renderHumanHelp()).toContain("dashboard");
    expect(renderCommandHelp("dashboard")).toContain("dashboard [--port <n>]");
    expect(renderCommandHelp("dashboard")).toContain("--root <dir>     Add a folder to scan");
  });
});

describe("dashboard through the dispatcher", () => {
  test("an out-of-range port is refused before the launcher runs", () => {
    const r = dispatch(["dashboard", "--port", "99999"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--port must be an integer 0-65535");
  });

  test("--root and --pin may repeat", () => {
    const r = dispatch(["dashboard", "--root", "/a", "--root", "/b", "--pin", "/c", "--pin", "/d", "--port", "99999"]);
    expect(r.stderr).not.toContain("may be specified only once");
    expect(r.stderr).toContain("--port must be an integer 0-65535");
  });

  test("other value flags may not repeat", () => {
    const r = dispatch(["dashboard", "--config", "/x", "--config", "/y"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--config may be specified only once");
  });

  test("an unknown option is refused", () => {
    const r = dispatch(["dashboard", "--bind", "0.0.0.0"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("unknown dashboard option --bind");
  });

  test("dashboard --help prints the usage", () => {
    const r = dispatch(["dashboard", "--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("dashboard [--port <n>]");
  });
});

describe("stopping the dispatcher stops the server", () => {
  test("SIGTERM to the dispatcher closes the port and exits 0", async () => {
    const proc = Bun.spawn([process.execPath, DISPATCHER, "dashboard", "--json", "--no-open"], {
      cwd: scratch,
      env: { ...process.env, AIDLC_DASHBOARD_CONFIG: join(scratch, "dash-sigterm.json") },
      stdout: "pipe",
      stderr: "pipe",
    });
    const reader = proc.stdout.getReader();
    let buf = "";
    while (!buf.includes("\n")) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += new TextDecoder().decode(value);
    }
    reader.releaseLock();
    const { url } = JSON.parse(buf.split("\n")[0] as string) as { url: string };
    expect((await fetch(url)).status).toBe(200);
    proc.kill("SIGTERM");
    expect(await proc.exited).toBe(0);
    // The server child must be gone too, not orphaned behind the dispatcher.
    let refused = false;
    for (let i = 0; i < 20 && !refused; i++) {
      try {
        await fetch(url);
        await Bun.sleep(100);
      } catch {
        refused = true;
      }
    }
    expect(refused).toBe(true);
  }, 30_000);
});
