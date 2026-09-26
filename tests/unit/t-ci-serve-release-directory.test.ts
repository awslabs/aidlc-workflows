// covers: harness-instrument:ci-serve-release-directory
//
// Pins the loopback release server CI uses to run the documented Windows
// PowerShell 5.1 installer one-liner against a locally staged release
// (.github/scripts/serve-release-directory.ts): both GitHub URL shapes map to
// the flat asset directory, everything else is 404, and a bad root fails fast.

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";

setDefaultTimeout(NATIVE_STARTUP_TIMEOUT_MS);

const SCRIPT = join(import.meta.dir, "..", "..", ".github", "scripts", "serve-release-directory.ts");
const scratch: string[] = [];
const servers: ChildProcess[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.kill();
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function releaseDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "aidlc-serve-release-"));
  scratch.push(dir);
  writeFileSync(join(dir, "version.json"), '{"schemaVersion":1}\n');
  writeFileSync(join(dir, "install.ps1"), "Write-Output fixture\n");
  mkdirSync(join(dir, "nested"));
  writeFileSync(join(dir, "nested", "secret.txt"), "not served\n");
  writeFileSync(join(dir, ".hidden"), "not served\n");
  return dir;
}

async function start(dir: string): Promise<string> {
  const server = spawn(process.execPath, [SCRIPT, dir], { stdio: ["ignore", "pipe", "pipe"] });
  servers.push(server);
  return new Promise((resolve, reject) => {
    let out = "";
    let err = "";
    const timer = setTimeout(
      () => reject(new Error(`server did not announce its port: ${out}${err}`)),
      remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    );
    server.stderr!.on("data", (chunk: Buffer) => { err += chunk.toString(); });
    server.stdout!.on("data", (chunk: Buffer) => {
      out += chunk.toString();
      const line = out.indexOf("\n");
      if (line < 0) return;
      clearTimeout(timer);
      resolve((JSON.parse(out.slice(0, line)) as { baseUrl: string }).baseUrl);
    });
    server.once("exit", (code) => { clearTimeout(timer); reject(new Error(`server exited ${code}: ${err}`)); });
  });
}

describe("CI release directory server", () => {
  test("serves flat assets under both GitHub release URL shapes and nothing else", async () => {
    const dir = releaseDir();
    const base = await start(dir);
    expect(base).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    for (const path of ["/latest/download/version.json", "/download/v1.2.3/version.json", "/download/v1.2.3-preview.20260901.1/install.ps1"]) {
      const response = await fetch(`${base}${path}`);
      expect(response.status, path).toBe(200);
    }
    expect(await (await fetch(`${base}/latest/download/install.ps1`)).text()).toBe("Write-Output fixture\n");
    for (const path of [
      "/version.json", "/latest/version.json", "/latest/download/", "/latest/download/missing.txt",
      "/latest/download/nested/secret.txt", "/latest/download/..%2Fnested%2Fsecret.txt",
      "/latest/download/.hidden", "/download/nope/version.json", "/api/releases",
    ]) {
      expect((await fetch(`${base}${path}`)).status, path).toBe(404);
    }
    expect((await fetch(`${base}/latest/download/version.json`, { method: "POST" })).status).toBe(405);
  });

  test("refuses a missing root or a malformed port before listening", () => {
    const missing = spawnSync(process.execPath, [SCRIPT, join(tmpdir(), "aidlc-serve-release-does-not-exist")], {
      encoding: "utf8", timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    });
    expect(missing.status).toBe(2);
    expect(missing.stderr).toContain("release directory not found");
    const port = spawnSync(process.execPath, [SCRIPT, releaseDir(), "eighty"], {
      encoding: "utf8", timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    });
    expect(port.status).toBe(2);
    expect(port.stderr).toContain("usage:");
  });
});
