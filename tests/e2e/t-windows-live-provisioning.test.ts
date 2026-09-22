// Deterministic Windows account/ACL tests; no CLI download or model calls.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, parse, resolve } from "node:path";
import { writeWindowsExecutable } from "../harness/windows-native-executable.ts";

const source = resolve(import.meta.dir, "../..");
const fixture = join(source, "tests/fixtures/windows-live-provisioning.ps1");
const runnerProbe = process.env.AIDLC_CODEX_RUNNER_PROBE;
const runnerProbeOnly = process.env.AIDLC_CODEX_RUNNER_PROBE_ONLY === "1";
if (runnerProbeOnly && !runnerProbe) throw new Error("Runner-only probing requires AIDLC_CODEX_RUNNER_PROBE.");

describe.skipIf(process.platform !== "win32")("Windows live provisioning boundary", () => {
  test.each([
    ["version", ["--version"]],
    ["initialized", ["sandbox", "two words", 'a"quote', "\\tail\\", "& () %PATH%"]],
  ] as const)("native Codex launcher preserves child output and arguments: %s", (_name, args) => {
    const root = mkdtempSync(join(tmpdir(), "aidlc-native launcher &-"));
    try {
      const native = writeWindowsExecutable(join(root, "native-fixture.exe"), `using System;
using System.Text;
public static class NativeOutputFixture {
  public static int Main(string[] args) {
    Console.Out.WriteLine("stdout-marker:" + Convert.ToBase64String(Encoding.UTF8.GetBytes(string.Join("\\0", args))));
    Console.Error.WriteLine("stderr-marker");
    return 7;
  }
}`);
      const initializer = join(root, "initialize.ps1");
      writeFileSync(initializer, "exit 0\n");
      // Compile the actual authored bridge with inert child commands. This
      // exercises its native process boundary without creating sandbox users.
      const script = readFileSync(join(source, ".github/scripts/prepare-live-runtime.ps1"), "utf8");
      const match = script.match(/\$launcher = @'\r?\n([\s\S]*?)\r?\n'@/);
      expect(match).not.toBeNull();
      let launcher = match![1];
      for (const [marker, value] of [
        ["__NATIVE__", native], ["__PACKAGE_ROOT__", root], ["__INITIALIZER__", initializer],
        ["__POWERSHELL__", join(process.env.SystemRoot!, "System32/WindowsPowerShell/v1.0/powershell.exe")],
      ]) launcher = launcher.replaceAll(marker, JSON.stringify(value));
      const executable = writeWindowsExecutable(join(root, "managed.exe"), launcher);
      const result = spawnSync(executable, args, {
        encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 15_000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(7);
      expect(result.stdout.trim()).toBe(`stdout-marker:${Buffer.from(args.join("\0")).toString("base64")}`);
      expect(result.stderr.trim()).toBe("stderr-marker");
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 30_000);

  for (const [name, expected] of [
    ["seal", { singleLinkTools: true, lowUserWriteDenied: true }],
    ["deny", { protectedReadDenied: true, reparseRejected: true }],
    ["failure-collect", { collectedAfterUserRemoval: true, summaryArtifacts: 1 }],
    ["poisoned-collect", { collectedAfterUserRemoval: true, linkedEvidenceRejected: true }],
    ["runner-bootstrap", {}],
  ] as const) {
    // CI supplies the hash-checked runner and executes all boundary cases.
    // Local diagnostics may explicitly select only the bootstrap case.
    test.skipIf(name === "runner-bootstrap" ? !runnerProbe : runnerProbeOnly)(
      `${name} uses real low-user execution and filesystem boundaries`, () => {
      // A second Windows account cannot resolve Node scripts through the
      // administrator's private AppData ancestors. Mirror production's C: root.
      const volume = parse(process.env.SystemRoot ?? "C:\\Windows").root;
      const root = mkdtempSync(join(volume, "aidlc-win-provision-"));
      const fixtureId = randomUUID();
      const powershell = join(process.env.SystemRoot ?? "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe");
      const args = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", fixture,
        "-SourceRoot", source, "-FixtureRoot", root, "-BunPath", process.execPath, "-Case", name];
      if (name === "runner-bootstrap") args.push("-RunnerPath", runnerProbe!);
      const failures: unknown[] = [];
      try {
        const result = spawnSync(
          powershell, [...args, "-FixtureId", fixtureId],
          { encoding: "utf8", timeout: 180_000, windowsHide: true },
        );
        expect(result.status, `${result.error ?? ""}\n${result.stdout}\n${result.stderr}`).toBe(0);
        const record = JSON.parse(readFileSync(join(root, "result.json"), "utf8").replace(/^\uFEFF/, ""));
        expect(record).toMatchObject({ case: name, ...expected });
        if (name === "runner-bootstrap") {
          // Preserve native exit/GUI evidence even when the handshake fails.
          // An early runner exit or a timeout must never be reported as a pass.
          console.log(`Native runner bootstrap: ${JSON.stringify(record.probe)}`);
          expect(record.probe, JSON.stringify(record.probe)).toMatchObject({
            pipeInConnected: true, pipeOutConnected: true, retired: true, timedOut: false,
            before: { naturalExitCode: "0xC0000142", pipeInConnected: false, pipeOutConnected: false, retired: true },
            refusedInputs: 5, idempotent: true,
          });
        }
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
            expect(receipt.fixtureId).toBe(fixtureId);
            if (receipt.removed !== true) {
              expect(process.env.GITHUB_ACTIONS).toBe("true");
              expect(process.env.RUNNER_ENVIRONMENT).toBe("github-hosted");
              expect(receipt).toMatchObject({
                removed: false, deferredToHostDisposal: true, reason: "profile-service-sharing-lock",
              });
            }
            if (receipt.runnerProfile && receipt.runnerProfile.removed !== true) {
              expect(process.env.GITHUB_ACTIONS).toBe("true");
              expect(process.env.RUNNER_ENVIRONMENT).toBe("github-hosted");
              expect(receipt.runnerProfile).toMatchObject({
                removed: false, deferredToHostDisposal: true, reason: "profile-service-sharing-lock",
              });
            }
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
  }
});
