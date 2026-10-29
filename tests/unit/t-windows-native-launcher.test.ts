// covers: file:core/tools/aidlc-native-launcher.ts function:nativeLauncherRoot function:startNativeLauncher file:core/tools/aidlc-lifecycle.ts file:scripts/install.ps1
//
// A native Windows install puts a copy of the aidlc binary in its bin folder
// as aidlc.exe, which PowerShell finds before aidlc.cmd and Git Bash finds
// once the extensionless launcher is gone. Windows starts aidlc.cmd only
// through cmd.exe, which reads & | < > ^ and %NAME% in the arguments whatever
// the caller quoted, so `aidlc use 'R&D'` reached AI-DLC as `R` and cmd.exe
// then ran `D`. The copy hands the arguments to the active release as given.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { windowsPosixShim, windowsShim } from "../../core/tools/aidlc-lifecycle.ts";
import { installRoot } from "../../core/tools/aidlc-install-paths.ts";
import { nativeLauncherRoot } from "../../core/tools/aidlc-native-launcher.ts";
import { AIDLC_VERSION } from "../../core/tools/aidlc-version.ts";
import { REPO_ROOT } from "../harness/fixtures.ts";
import { gitBashPath, gitBashSkipReason } from "../harness/git-bash.ts";
import { writeReleaseFixture } from "../harness/release-fixture.ts";
import {
  NATIVE_COMPILE_TIMEOUT_MS,
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";

const cmdFor = (helper: string) =>
  `@echo off\r\npowershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${
    helper.replaceAll("%", "%%")
  }" %*\r\nexit /b %ERRORLEVEL%\r\n`;

describe("the bin copy reads its install from the aidlc.cmd beside it", () => {
  test("the aidlc.cmd the install writes names its install root", () => {
    const saved = process.env.AIDLC_INSTALL_ROOT;
    process.env.AIDLC_INSTALL_ROOT = join(tmpdir(), "aidlc-native-launcher-root");
    try {
      expect(nativeLauncherRoot(windowsShim())).toBe(installRoot());
    } finally {
      if (saved === undefined) delete process.env.AIDLC_INSTALL_ROOT;
      else process.env.AIDLC_INSTALL_ROOT = saved;
    }
  });

  test("the install root aidlc.cmd was written with, a % in it read once", () => {
    expect(nativeLauncherRoot(cmdFor("C:\\Users\\a%b\\AppData\\Local\\aidlc\\aidlc-shim.ps1")))
      .toBe("C:\\Users\\a%b\\AppData\\Local\\aidlc");
  });

  test("any other file beside it leaves the binary itself", () => {
    expect(nativeLauncherRoot("@echo off\r\n")).toBeNull();
    expect(nativeLauncherRoot(cmdFor("C:\\aidlc\\other.ps1"))).toBeNull();
    expect(nativeLauncherRoot(`${cmdFor("C:\\aidlc\\aidlc-shim.ps1")}echo more\r\n`)).toBeNull();
  });
});

describe("a native Windows install hands aidlc's arguments on as typed", () => {
  const values = ["R&D", "a^b", "%PATH%", "a|sort", "a>made-by-cmd"];

  test.skipIf(process.platform !== "win32")(
    "from PowerShell and Git Bash, & ^ %NAME% | > reach AI-DLC as typed, and nothing else runs",
    () => {
      const root = mkdtempSync(join(tmpdir(), "aidlc-native-launcher-"));
      try {
        const built = join(root, "aidlc.exe");
        const compiled = spawnSync(process.execPath, [
          "build", join(REPO_ROOT, "dist-release", "claude", ".claude", "tools", "aidlc.ts"), "--compile",
          "--no-compile-autoload-dotenv", "--no-compile-autoload-bunfig", "--outfile", built,
        ], { cwd: REPO_ROOT, encoding: "utf-8", timeout: remainingOperationTimeoutMs(NATIVE_COMPILE_TIMEOUT_MS) });
        expect(compiled.status, `${compiled.stdout}\n${compiled.stderr}`).toBe(0);
        const release = join(root, "release");
        mkdirSync(release);
        writeReleaseFixture({ root: release, repoRoot: REPO_ROOT, version: AIDLC_VERSION, binaryFrom: built });
        const machine = join(root, "machine");
        const bin = join(machine, "bin");
        const work = join(root, "work");
        mkdirSync(work);
        // A missing gh: the fixture release has no real attestation to verify.
        const env: NodeJS.ProcessEnv = {
          ...process.env,
          AIDLC_INSTALL_ROOT: machine,
          AIDLC_BIN_DIR: bin,
          AIDLC_GH_BIN: join(root, "no-gh", "gh.exe"),
          NO_COLOR: "1",
        };
        const run = (file: string, args: string[]) => {
          const r = spawnSync(file, args, {
            cwd: work,
            encoding: "utf-8",
            env,
            timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
          });
          return { status: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
        };
        // The installer runs the release's own binary, which copies itself to bin.
        const installed = run("powershell.exe", [
          "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(release, "install.ps1"), "-From", release, "-NoModifyPath",
        ]);
        expect(installed.status, installed.out).toBe(0);
        expect(installed.out).toContain(`Command: ${join(bin, "aidlc.exe")}`);

        const typed = () => {
          // What the engine prints for PowerShell and Git Bash alike: single quotes.
          for (const value of values) {
            const quoted = `'${value}'`;
            const ps = run("powershell.exe", [
              "-NoProfile", "-NonInteractive", "-Command", `$env:Path = '${bin};' + $env:Path; aidlc use ${quoted}`,
            ]);
            expect(ps.out, `PowerShell ${value}`).toContain(`invalid version "${value}"`);
            expect(ps.out, `PowerShell ${value}`).not.toContain("is not recognized");
            if (gitBashSkipReason() === null) {
              const sh = run(gitBashPath(), ["-c", `PATH="$(cygpath -u '${bin}'):$PATH"; aidlc use ${quoted}`]);
              expect(sh.out, `Git Bash ${value}`).toContain(`invalid version "${value}"`);
              expect(sh.out, `Git Bash ${value}`).not.toContain("is not recognized");
            }
          }
          expect(readdirSync(work)).toEqual([]);
          // bin\aidlc.exe carries them; Git Bash finds it once the extensionless launcher is gone.
          expect(existsSync(join(bin, "aidlc.exe"))).toBe(true);
          expect(existsSync(join(bin, "aidlc"))).toBe(false);
        };
        typed();

        // What an update run by a release from before aidlc.exe leaves: aidlc.cmd,
        // its helper and the Git Bash launcher. The release it made active writes
        // aidlc.exe at its first command.
        rmSync(join(bin, "aidlc.exe"));
        rmSync(join(machine, "launcher-sha256"));
        writeFileSync(join(bin, "aidlc"), windowsPosixShim());
        const first = run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `& '${join(bin, "aidlc.cmd")}' version`]);
        expect(first.out).toContain(`aidlc ${AIDLC_VERSION}`);
        typed();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    NATIVE_COMPILE_TIMEOUT_MS + NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  );
});
