// Deterministic Windows account/ACL tests; no CLI download or model calls.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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
    const fixtureId = randomUUID();
    const powershell = join(process.env.SystemRoot ?? "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe");
    const args = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", fixture,
      "-SourceRoot", source, "-FixtureRoot", root, "-BunPath", process.execPath, "-Case", name];
    const failures: unknown[] = [];
    try {
      const result = spawnSync(
        powershell, [...args, "-FixtureId", fixtureId],
        { encoding: "utf8", timeout: 180_000, windowsHide: true },
      );
      expect(result.status, `${result.error ?? ""}\n${result.stdout}\n${result.stderr}`).toBe(0);
      const record = JSON.parse(readFileSync(join(root, "result.json"), "utf8").replace(/^\uFEFF/, ""));
      expect(record).toMatchObject({ case: name, ...expected });
      expect(existsSync(join(root, "trusted-teardown/identity.json"))).toBe(true);
    } catch (error) {
      failures.push(error);
    } finally {
      try {
        if (existsSync(join(root, "trusted-teardown/identity.json"))) {
          // Task Scheduler/CIM clients have exited before profile deletion.
          // Keep cleanup separate even when a boundary assertion failed.
          if (name === "seal") {
            try {
              const rejected = spawnSync(powershell, [...args, "-Mode", "cleanup", "-FixtureId", randomUUID()],
                { encoding: "utf8", timeout: 10_000, windowsHide: true });
              expect(rejected.status).toBe(1);
              expect(rejected.stderr).toContain("Fixture receipt binding mismatch.");
            } catch (error) {
              failures.push(error);
            }
          }
          const cleanup = spawnSync(powershell, [...args, "-Mode", "cleanup", "-FixtureId", fixtureId],
            { encoding: "utf8", timeout: 35_000, windowsHide: true });
          expect(cleanup.status, `Profile cleanup:\n${cleanup.error ?? ""}\n${cleanup.stdout}\n${cleanup.stderr}`).toBe(0);
          const receipt = JSON.parse(readFileSync(join(root, "trusted-teardown/cleanup.json"), "utf8").replace(/^\uFEFF/, ""));
          expect(receipt).toMatchObject({ fixtureId, removed: true });
          console.log(`Fixture profile cleanup: ${JSON.stringify({ case: name, ...receipt })}`);
        }
      } catch (error) {
        failures.push(error);
      }
      try {
        rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, failures.map(error => error instanceof Error ? error.stack : String(error)).join("\n"));
    }
  // Preserve the 180s body and 30s deletion bounds, plus cleanup client startup
  // and the 10s receipt-binding refusal check after the body process exits.
  }, 230_000);
});
