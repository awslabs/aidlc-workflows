// Deterministic Windows account/ACL tests; no CLI download or model calls.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, parse, resolve } from "node:path";

const source = resolve(import.meta.dir, "../..");
const fixture = join(source, "tests/fixtures/windows-live-provisioning.ps1");

describe.skipIf(process.platform !== "win32")("Windows live provisioning boundary", () => {
  test.each([
    ["seal", { singleLinkTools: true, lowUserWriteDenied: true }],
    ["deny", { protectedReadDenied: true, reparseRejected: true }],
    ["failure-collect", { collectedAfterUserRemoval: true, summaryArtifacts: 1 }],
    ["poisoned-collect", { collectedAfterUserRemoval: true, linkedEvidenceRejected: true }],
  ] as const)("%s uses real low-user execution and filesystem boundaries", (name, expected) => {
    // A second Windows account cannot resolve Node scripts through the
    // administrator's private AppData ancestors. Mirror production's C: root.
    const volume = parse(process.env.SystemRoot ?? "C:\\Windows").root;
    const root = mkdtempSync(join(volume, "aidlc-win-provision-"));
    try {
      const result = spawnSync(
        join(process.env.SystemRoot ?? "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe"),
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", fixture,
          "-SourceRoot", source, "-FixtureRoot", root, "-BunPath", process.execPath, "-Case", name],
        { encoding: "utf8", timeout: 180_000, windowsHide: true },
      );
      expect(result.status, `${result.error ?? ""}\n${result.stdout}\n${result.stderr}`).toBe(0);
      const record = JSON.parse(readFileSync(join(root, "result.json"), "utf8").replace(/^\uFEFF/, ""));
      expect(record).toMatchObject({ case: name, ...expected });
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 190_000);
});
