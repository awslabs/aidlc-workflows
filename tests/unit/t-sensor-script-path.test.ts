// covers: subcommand:aidlc-sensor:fire, tool:aidlc-sensor
//
// t-sensor-script-path (#2695): a sensor's script is the file of that name
// directly inside the engine's tools folder, whatever spelling the manifest's
// command uses and whichever platform's paths read it. A directory written in
// the command, with either separator, never moves the script elsewhere.
//
// The resolution is checked with each platform's path rules (path.posix and
// path.win32) so the Windows case runs on every host, and once through the
// real `sensor fire` on this host.

import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix, win32 } from "node:path";
import { sensorScriptPathIn } from "../../dist/claude/.claude/tools/aidlc-sensor.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

type PathRules = typeof posix;

const PLATFORMS: Array<[string, PathRules, string]> = [
  ["POSIX", posix, "/proj/.claude/tools"],
  ["Windows", win32, "C:\\proj\\.claude\\tools"],
];

describe("t-sensor-script-path (#2695) a sensor's script stays in the tools folder", () => {
  for (const [platform, path, tools] of PLATFORMS) {
    describe(platform, () => {
      test("the shipped spellings resolve to the script of that name in the tools folder", () => {
        for (const [command, name] of [
          ["bun .claude/tools/aidlc-sensor-traceability.ts", "aidlc-sensor-traceability.ts"],
          ["bun .kiro/tools/aidlc-sensor-no-tbd.ts --strict", "aidlc-sensor-no-tbd.ts"],
          ["bun .claude/tools/aidlc.ts engine sensor-linter", "aidlc-sensor-linter.ts"],
          ["aidlc engine sensor-type-check", "aidlc-sensor-type-check.ts"],
        ]) {
          expect(sensorScriptPathIn(command, tools, path), command).toBe(path.join(tools, name));
        }
      });

      test("a directory written in the command, with either separator, never leaves the tools folder", () => {
        for (const command of [
          "bun ../../../evil.ts",
          "bun ..\\..\\..\\evil.ts",
          "bun /opt/elsewhere/evil.ts",
          "bun C:\\elsewhere\\evil.ts",
          "bun ..\\..\\..\\Users\\me\\aidlc-sensor-x.ts",
          "bun .claude\\tools\\..\\..\\aidlc-sensor-x.ts",
        ]) {
          const resolved = sensorScriptPathIn(command, tools, path);
          expect(path.dirname(resolved), `${command} -> ${resolved}`).toBe(tools);
        }
        expect(sensorScriptPathIn("bun ..\\..\\..\\evil.ts", tools, path)).toBe(path.join(tools, "evil.ts"));
      });

      test("a script token that names no file is refused", () => {
        for (const command of ["bun ../.ts", "bun ..\\..\\.ts", "bun /", "echo no script here"]) {
          expect(() => sensorScriptPathIn(command, tools, path), command).toThrow();
        }
      });
    });
  }
});

describe("t-sensor-script-path (#2695) through `sensor fire` on this host", () => {
  const BUN = process.execPath;
  const SENSOR_TS = join(import.meta.dir, "..", "..", "dist", "claude", ".claude", "tools", "aidlc-sensor.ts");
  const dirs: string[] = [];
  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  function fireWith(command: string): { rc: number; out: string; scripts: string } {
    const root = mkdtempSync(join(tmpdir(), "t-sensor-script-path-"));
    dirs.push(root);
    const project = join(root, "project");
    const sensors = join(root, "sensors");
    const scripts = join(root, "tools");
    mkdirSync(join(project, "aidlc-docs"), { recursive: true });
    mkdirSync(sensors);
    mkdirSync(scripts);
    writeFileSync(
      join(sensors, "aidlc-path-probe.md"),
      [
        "---", "id: path-probe", "kind: deterministic", `command: ${command}`,
        "default_severity: advisory", "description: #2695 probe", "input_schema: {}", "output_schema: {}",
        "timeout_seconds: 30", "---", "# probe", "",
      ].join("\n"),
    );
    const output = join(project, "out.md");
    writeFileSync(output, "# out\n");
    const r = spawnSync(BUN, [SENSOR_TS, "fire", "path-probe", "--stage", "requirements-analysis", "--output-path", output], {
      encoding: "utf-8",
      env: { ...process.env, CLAUDE_PROJECT_DIR: project, AIDLC_SENSORS_DIR: sensors, AIDLC_SENSOR_SCRIPT_DIR: scripts },
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    });
    return { rc: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}`, scripts };
  }

  test("a backslash path in the command looks for the script of that name in the tools folder, as a slash path does", () => {
    for (const command of ["bun ../../../evil.ts", "bun ..\\..\\..\\evil.ts"]) {
      const { rc, out, scripts } = fireWith(command);
      expect(rc, out).not.toBe(0);
      expect(out, command).toContain(`per-sensor script missing on disk: ${join(scripts, "evil.ts")}`);
    }
  });
});
