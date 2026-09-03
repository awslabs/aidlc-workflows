// t330: the release version-id grammar shared by the native lifecycle, the
// installers, and the release scripts. Stable ids are exactly x.y.z; preview
// ids are x.y.z-preview.YYYYMMDD.N; nothing else is a version anywhere, and a
// version is always a safe directory name. The shell and PowerShell installers
// carry their own literal of the grammar, so the same accept/reject table is
// run against those literals to keep them in step with the TypeScript
// constant. The final case installs a preview id through the real lifecycle and
// executes the launcher shim, which validates the active version marker with
// its own POSIX sh grammar.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BUILD_VERSION_ENV,
  compareVersions,
  parseVersion,
  PREVIEW_CHANNEL,
  PREVIEW_VERSION,
  previewVersion,
  releaseBuildVersion,
  requireReleaseChannel,
  requireVersion,
  STABLE_CHANNEL,
  STABLE_VERSION,
  utcBuildDate,
  VERSION_ID,
  VERSION_ID_PATTERN,
  versionChannel,
} from "../../core/tools/aidlc-channel.ts";
import { AIDLC_VERSION } from "../../core/tools/aidlc-version.ts";
import { writeReleaseFixture } from "../harness/release-fixture.ts";

const REPO_ROOT = join(fileURLToPath(new URL("../..", import.meta.url)));
const LIFECYCLE = join(REPO_ROOT, "core", "tools", "aidlc-lifecycle.ts");
const INSTALL_SH = readFileSync(join(REPO_ROOT, "scripts", "install.sh"), "utf-8");
const INSTALL_PS1 = readFileSync(join(REPO_ROOT, "scripts", "install.ps1"), "utf-8");
const RUNTIME_PATHS = readFileSync(join(REPO_ROOT, "core", "tools", "aidlc-runtime-paths.ts"), "utf-8");
const RELEASE_WORKFLOW = readFileSync(
  join(REPO_ROOT, ".github", "workflows", "release.yml"),
  "utf-8",
);
const [MAJOR, MINOR, PATCH] = AIDLC_VERSION.split(".").map(Number);
const PREVIEW_ID = `${AIDLC_VERSION}-${PREVIEW_CHANNEL}.20260903.1`;

const ACCEPTED = [
  "0.0.0",
  "2.7.2",
  "10.20.30",
  "2.7.2-preview.20260903.1",
  "2.7.2-preview.20260903.10",
  "0.0.0-preview.20260101.999",
];

// Every shape that would be a path escape, an ambiguous directory name, or a
// grammar the channel design does not admit (general semver prereleases).
const REJECTED = [
  "",
  " ",
  "2.7.2 ",
  " 2.7.2",
  "2.7.2\n",
  "..",
  "2.7.2/..",
  "../2.7.2",
  "2.7.2\\3",
  "2.7.2/3",
  "2..2",
  "2.7.",
  ".7.2",
  "2.7",
  "2.7.2.1",
  "02.7.2",
  "2.07.2",
  "v2.7.2",
  "2.7.2-rc.1",
  "2.7.2-alpha",
  "2.7.2-beta.20260903.1",
  "2.7.2-nightly.20260903.1",
  "2.7.2+build.1",
  "2.7.2-preview",
  "2.7.2-preview.",
  "2.7.2-preview.20260903",
  "2.7.2-preview.20260903.",
  "2.7.2-preview.20260903.0",
  "2.7.2-preview.20260903.01",
  "2.7.2-preview.2026090.1",
  "2.7.2-preview.202609031.1",
  "2.7.2-preview.20260903.1.2",
  "2.7.2-preview.20260903.1-preview.20260903.1",
  "2.7.2-Preview.20260903.1",
  "2.7.2-preview.2026090\u0663.1",
  "\u0662.7.2",
  "２.7.2",
  "2.7.2-preview.20260903.１",
];

function shellPattern(): string {
  const match = /^VERSION_PATTERN='([^']+)'$/m.exec(INSTALL_SH);
  if (!match) throw new Error("install.sh has no VERSION_PATTERN literal");
  return match[1];
}

function powershellPatterns(): string[] {
  const validate = /\[ValidatePattern\('([^']+)'\)\]/.exec(INSTALL_PS1)?.[1];
  const manifest = /\$manifest\.version -notmatch '([^']+)'/.exec(INSTALL_PS1)?.[1];
  if (!validate || !manifest) throw new Error("install.ps1 has no version literals");
  return [validate, manifest];
}

function grepMatches(pattern: string, value: string): boolean {
  const result = spawnSync("sh", ["-c", 'printf "%s\\n" "$1" | grep -Eq "$2"', "sh", value, pattern], {
    encoding: "utf-8",
  });
  return result.status === 0;
}

describe("t330 release version-id grammar", () => {
  test("the closed grammar accepts stable and preview ids and nothing else", () => {
    for (const value of ACCEPTED) {
      expect(VERSION_ID.test(value), value).toBe(true);
      expect(requireVersion(value)).toBe(value);
    }
    for (const value of REJECTED) {
      expect(VERSION_ID.test(value), JSON.stringify(value)).toBe(false);
      expect(() => requireVersion(value), JSON.stringify(value)).toThrow("invalid version");
    }
    expect(STABLE_VERSION.test("2.7.2")).toBe(true);
    expect(STABLE_VERSION.test("2.7.2-preview.20260903.1")).toBe(false);
    expect(PREVIEW_VERSION.test("2.7.2-preview.20260903.1")).toBe(true);
    expect(PREVIEW_VERSION.test("2.7.2")).toBe(false);
    // The unanchored source embeds into larger expressions without captures.
    expect(new RegExp(`^(${VERSION_ID_PATTERN})-(\\d+)-[a-f0-9-]+$`).exec(
      "2.7.2-preview.20260903.4-4242-0f0f",
    )?.slice(1)).toEqual(["2.7.2-preview.20260903.4", "4242"]);
  });

  test("parsing names the channel and the preview coordinates", () => {
    expect(parseVersion("2.7.2")).toEqual({
      base: "2.7.2",
      major: 2,
      minor: 7,
      patch: 2,
      channel: STABLE_CHANNEL,
    });
    expect(parseVersion("2.7.2-preview.20260903.12")).toEqual({
      base: "2.7.2",
      major: 2,
      minor: 7,
      patch: 2,
      channel: PREVIEW_CHANNEL,
      date: "20260903",
      build: 12,
    });
    expect(versionChannel("2.7.2")).toBe("stable");
    expect(versionChannel("2.7.2-preview.20260903.1")).toBe("preview");
    expect(previewVersion("2.7.2", "20260903", 3)).toBe("2.7.2-preview.20260903.3");
    expect(() => previewVersion("2.7.2-preview.20260903.1", "20260903", 1)).toThrow("stable x.y.z");
    expect(() => previewVersion("2.7.2", "2026-09-03", 1)).toThrow("YYYYMMDD");
    expect(() => previewVersion("2.7.2", "20260903", 0)).toThrow("positive integer");
    expect(utcBuildDate(new Date("2026-09-03T23:59:59Z"))).toBe("20260903");
    expect(utcBuildDate(new Date("2026-09-03T23:59:59-05:00"))).toBe("20260904");
  });

  test("ordering is numeric on the base, then stable above its previews, then build date and counter", () => {
    const ordered = [
      "2.7.1",
      "2.7.2-preview.20260902.9",
      "2.7.2-preview.20260903.1",
      "2.7.2-preview.20260903.2",
      "2.7.2-preview.20260903.10",
      "2.7.2",
      "2.7.10-preview.20260101.1",
      "2.7.10",
      "3.0.0-preview.20250101.1",
    ];
    for (let index = 1; index < ordered.length; index++) {
      expect(compareVersions(ordered[index - 1], ordered[index]), `${ordered[index - 1]} < ${ordered[index]}`)
        .toBe(-1);
      expect(compareVersions(ordered[index], ordered[index - 1])).toBe(1);
    }
    expect(compareVersions("2.7.2", "2.7.2")).toBe(0);
    expect([...ordered].reverse().sort(compareVersions)).toEqual(ordered);
    expect(() => compareVersions("2.7.2", "2.7.2-rc.1")).toThrow("invalid version");
  });

  test("release channels are exactly stable and preview", () => {
    expect(requireReleaseChannel("stable")).toBe("stable");
    expect(requireReleaseChannel("preview")).toBe("preview");
    for (const value of ["", "nightly", "Stable", "preview ", "beta"]) {
      expect(() => requireReleaseChannel(value)).toThrow("invalid release channel");
    }
  });

  test("a build version must be the source version or a preview built from it", () => {
    expect(releaseBuildVersion({})).toBe(AIDLC_VERSION);
    expect(releaseBuildVersion({ [BUILD_VERSION_ENV]: "" })).toBe(AIDLC_VERSION);
    expect(releaseBuildVersion({ [BUILD_VERSION_ENV]: ` ${AIDLC_VERSION} ` })).toBe(AIDLC_VERSION);
    expect(releaseBuildVersion({ [BUILD_VERSION_ENV]: PREVIEW_ID })).toBe(PREVIEW_ID);
    expect(() => releaseBuildVersion({ [BUILD_VERSION_ENV]: `${MAJOR}.${MINOR}.${PATCH + 1}` }))
      .toThrow(`${BUILD_VERSION_ENV} must be unset`);
    expect(() =>
      releaseBuildVersion({
        [BUILD_VERSION_ENV]: `${MAJOR}.${MINOR}.${PATCH + 1}-preview.20260903.1`,
      })
    ).toThrow(`is not built from source version ${AIDLC_VERSION}`);
    expect(() => releaseBuildVersion({ [BUILD_VERSION_ENV]: "2.7.2-rc.1" })).toThrow("invalid version");
  });

  test("the installer, launcher, and runtime-paths literals agree with the shared grammar", () => {
    const shell = shellPattern();
    expect(INSTALL_SH).toContain("core/tools/aidlc-channel.ts");
    expect(INSTALL_PS1).toContain("core/tools/aidlc-channel.ts");
    // aidlc-runtime-paths.ts ships inside the closed hook dependency set and
    // repeats the grammar instead of importing it.
    const runtimePaths = /^const FRAMEWORK_VERSION = \/(.+)\/;$/m.exec(RUNTIME_PATHS)?.[1];
    expect(runtimePaths).toBe(VERSION_ID.source);
    expect(RUNTIME_PATHS).toContain("aidlc-channel.ts");
    for (const value of ACCEPTED) {
      expect(grepMatches(shell, value), `install.sh ${value}`).toBe(true);
    }
    // grep -E reads one line; embedded newlines are covered by the TypeScript
    // grammar and cannot reach the shell literal through the installer's flags.
    for (const value of REJECTED.filter((candidate) => !candidate.includes("\n"))) {
      expect(grepMatches(shell, value), `install.sh ${JSON.stringify(value)}`).toBe(false);
    }
    for (const pattern of powershellPatterns()) {
      // The PowerShell literal is a .NET regex; for these constructs the
      // JavaScript engine agrees byte for byte.
      const regex = new RegExp(pattern);
      for (const value of ACCEPTED) expect(regex.test(value), `install.ps1 ${value}`).toBe(true);
      for (const value of REJECTED) {
        expect(regex.test(value), `install.ps1 ${JSON.stringify(value)}`).toBe(false);
      }
    }
    const lifecycle = /\\\\versions\\\\([^']+)\\\\aidlc\\\.exe\$'/.exec(RELEASE_WORKFLOW)?.[1];
    expect(lifecycle).toBeDefined();
    const pointer = new RegExp(`^${lifecycle}$`);
    expect(pointer.test("2.7.2")).toBe(true);
    expect(pointer.test("2.7.2-preview.20260903.1")).toBe(true);
    expect(pointer.test("2.7.2-rc.1")).toBe(false);
    expect(RELEASE_WORKFLOW).toContain(
      `sed -n 's/.*"version":[[:space:]]*"\\([0-9][0-9A-Za-z.-]*\\)".*/\\1/p'`,
    );
  });

  test("a preview id installs, activates, and runs through the launcher shim", () => {
    if (process.platform === "win32") return;
    const scratch = mkdtempSync(join(realpathSync(tmpdir()), "aidlc-t330-"));
    try {
      const release = join(scratch, "release");
      writeReleaseFixture({
        root: release,
        repoRoot: REPO_ROOT,
        version: PREVIEW_ID,
        distributions: ["claude"],
      });
      const machine = join(scratch, "machine");
      const project = join(scratch, "project");
      mkdirSync(project, { recursive: true });
      mkdirSync(join(project, ".git"));
      const env = {
        ...process.env,
        PATH: `${join(REPO_ROOT, "tests", "fixtures", "bin")}${delimiter}${process.env.PATH ?? ""}`,
        AIDLC_INSTALL_ROOT: machine,
        AIDLC_BIN_DIR: join(machine, "bin"),
      };
      const installed = spawnSync(process.execPath, [
        LIFECYCLE,
        "update",
        "--version",
        PREVIEW_ID,
        "--from",
        release,
        "--json",
      ], { cwd: project, env, encoding: "utf-8", timeout: 120_000 });
      expect(installed.status, installed.stdout + installed.stderr).toBe(0);
      expect(JSON.parse(installed.stdout).data.version).toBe(PREVIEW_ID);
      expect(existsSync(join(machine, "versions", PREVIEW_ID, "aidlc"))).toBe(true);
      expect(readFileSync(join(machine, "active-version"), "utf-8").trim()).toBe(PREVIEW_ID);
      const shim = readFileSync(join(machine, "bin", "aidlc"), "utf-8");
      expect(shim).toContain("# aidlc-native-launcher-v2");
      expect(shim).toContain(`*-${PREVIEW_CHANNEL}.*)`);
      const version = spawnSync("sh", [join(machine, "bin", "aidlc"), "version"], {
        env,
        encoding: "utf-8",
      });
      expect(version.status, version.stdout + version.stderr).toBe(0);
      expect(version.stdout.trim()).toBe(`aidlc ${PREVIEW_ID} (runtime ${PREVIEW_ID})`);
      const listed = spawnSync(process.execPath, [LIFECYCLE, "versions", "list", "--json"], {
        cwd: project,
        env,
        encoding: "utf-8",
      });
      expect(JSON.parse(listed.stdout).data.versions).toEqual([
        expect.objectContaining({
          version: PREVIEW_ID,
          channel: PREVIEW_CHANNEL,
          active: true,
          complete: true,
        }),
      ]);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 120_000);
});
