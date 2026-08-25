// t313-plugin-doctor-checks: plugin-authored /aidlc --doctor extension checks.
//
// The fixture copies a complete Claude install, adds one installed plugin
// identity through a scope file, and swaps only that plugin's optional doctor
// script. This keeps exit-code assertions focused on the plugin runner instead
// of unrelated missing-install failures.

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  AIDLC_MEMORY_SRC,
  AIDLC_SRC,
  cleanupTestProject,
  createTestProject,
} from "../harness/fixtures.ts";

const PLUGIN = "doctor-probe";
const created: string[] = [];

afterEach(() => {
  while (created.length) cleanupTestProject(created.pop());
});

function freshProject(): string {
  const project = createTestProject();
  created.push(project);
  cpSync(AIDLC_SRC, join(project, ".claude"), { recursive: true });
  cpSync(AIDLC_MEMORY_SRC, join(project, "aidlc"), { recursive: true });
  writePluginScope(project, PLUGIN, `${PLUGIN}-scope`);
  return project;
}

function writePluginScope(
  project: string,
  plugin: string,
  scopeName: string,
): void {
  writeFileSync(
    join(project, ".claude", "scopes", `${scopeName}.md`),
    [
      "---",
      `name: ${scopeName}`,
      `plugin: ${plugin}`,
      "depth: Standard",
      "description: Doctor probe plugin scope",
      "keywords:",
      "  - doctor-probe-scope",
      "---",
      "",
    ].join("\n"),
  );
}

function scriptPath(project: string, plugin = PLUGIN): string {
  return join(project, ".claude", "tools", `${plugin}-doctor.ts`);
}

function writeDoctorScript(
  project: string,
  body: string,
  plugin = PLUGIN,
): void {
  writeFileSync(scriptPath(project, plugin), body, "utf-8");
}

function runDoctor(
  project: string,
  args: string[] = [],
  envOverrides: Record<string, string> = {},
) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CLAUDE_PROJECT_DIR: project,
    AIDLC_HARNESS_DIR: ".claude",
    ...envOverrides,
  };
  if (!("AIDLC_PLUGIN_DOCTOR_TIMEOUT_MS" in envOverrides)) {
    delete env.AIDLC_PLUGIN_DOCTOR_TIMEOUT_MS;
  }
  return spawnSync(
    process.execPath,
    [join(project, ".claude", "tools", "aidlc-utility.ts"), "doctor", ...args, "--project-dir", project],
    {
      cwd: project,
      encoding: "utf-8",
      env,
      timeout: 30_000,
    },
  );
}

function output(run: ReturnType<typeof runDoctor>): string {
  return `${run.stdout ?? ""}${run.stderr ?? ""}`;
}

function setPluginSelection(project: string, plugins: string[]): void {
  const path = join(project, ".claude", "tools", "data", "harness.json");
  const harness = JSON.parse(readFileSync(path, "utf-8"));
  harness.plugins = plugins;
  writeFileSync(path, `${JSON.stringify(harness, null, 2)}\n`, "utf-8");
}

function reportFile(project: string, name: "report.json" | "report.md"): string {
  const outDir = join(project, "out");
  const reportDir = readdirSync(outDir)
    .find((name) => name.startsWith("aidlc-diagnostic-report-") && !name.endsWith(".tar.gz"));
  expect(reportDir).toBeTruthy();
  return join(outDir, reportDir!, name);
}

function reportJson(project: string): Record<string, unknown> {
  return JSON.parse(readFileSync(reportFile(project, "report.json"), "utf-8"));
}

describe("t313 plugin doctor checks", () => {
  test("enabled plugin passing check renders a pass row and exits 0", () => {
    const project = freshProject();
    writeDoctorScript(
      project,
      'process.stdout.write(JSON.stringify({checks:[{pass:true,label:"tool is ready"}]}));\n',
    );

    const run = runDoctor(project);
    expect(run.status, output(run)).toBe(0);
    expect(output(run)).toContain(`✓  Plugin check (${PLUGIN}): tool is ready`);
  });

  test("failing error-severity check renders a failure and exits 1", () => {
    const project = freshProject();
    writeDoctorScript(
      project,
      'process.stdout.write(JSON.stringify({checks:[{pass:false,label:"tool is missing",fix:"install the tool",severity:"error"}]}));\n',
    );

    const run = runDoctor(project);
    expect(run.status).toBe(1);
    expect(output(run)).toContain(`✗  Plugin check (${PLUGIN}): tool is missing — install the tool`);
  });

  test("failing advisory check stays visible and exits 0", () => {
    const project = freshProject();
    writeDoctorScript(
      project,
      'process.stdout.write(JSON.stringify({checks:[{pass:false,label:"optional tool is missing",fix:"install it when needed",severity:"advisory"}]}));\n',
    );

    const run = runDoctor(project);
    expect(run.status, output(run)).toBe(0);
    expect(output(run)).toContain(
      `✓  Plugin check (${PLUGIN}): optional tool is missing (advisory) — install it when needed`,
    );
  });

  test("traversal and absolute plugin identities cannot execute scripts outside tools", () => {
    const project = freshProject();
    const canary = join(project, "out-of-bound-doctor-ran");
    writePluginScope(project, "../../payload", "traversal-plugin-scope");
    writeFileSync(
      join(project, "payload-doctor.ts"),
      [
        'import { writeFileSync } from "node:fs";',
        'writeFileSync(process.env.PLUGIN_DOCTOR_CANARY!, "ran");',
        'process.stdout.write(JSON.stringify({checks:[{pass:true,label:"ran"}]}));',
        "",
      ].join("\n"),
    );
    const absolutePlugin = join(project, "absolute-payload");
    writePluginScope(project, absolutePlugin, "absolute-plugin-scope");
    writeFileSync(
      `${absolutePlugin}-doctor.ts`,
      [
        'import { writeFileSync } from "node:fs";',
        'writeFileSync(process.env.PLUGIN_DOCTOR_CANARY!, "ran");',
        'process.stdout.write(JSON.stringify({checks:[{pass:true,label:"ran"}]}));',
        "",
      ].join("\n"),
    );

    const run = runDoctor(project, [], { PLUGIN_DOCTOR_CANARY: canary });
    const out = output(run);
    expect(run.status).toBe(1);
    expect(existsSync(canary)).toBe(false);
    expect(out).toContain('invalid plugin name "../../payload"');
    expect(out).toContain(`invalid plugin name "${absolutePlugin}"`);
  });

  test.skipIf(process.platform === "win32")(
    "a doctor script symlinked outside tools is refused",
    () => {
      const project = freshProject();
      const canary = join(project, "symlink-doctor-ran");
      const outside = join(project, "outside-doctor.ts");
      writeFileSync(
        outside,
        [
          'import { writeFileSync } from "node:fs";',
          'writeFileSync(process.env.PLUGIN_DOCTOR_CANARY!, "ran");',
          'process.stdout.write(JSON.stringify({checks:[{pass:true,label:"ran"}]}));',
          "",
        ].join("\n"),
      );
      symlinkSync(outside, scriptPath(project));

      const run = runDoctor(project, [], { PLUGIN_DOCTOR_CANARY: canary });
      expect(run.status).toBe(1);
      expect(existsSync(canary)).toBe(false);
      expect(output(run)).toContain(
        `Plugin check (${PLUGIN}): doctor script resolves outside the harness tools directory`,
      );
    },
  );

  test("malformed JSON becomes one loud finding with the required shape", () => {
    const project = freshProject();
    writeDoctorScript(project, 'process.stdout.write("not-json");\n');

    const run = runDoctor(project);
    const out = output(run);
    expect(run.status).toBe(1);
    expect(out.match(new RegExp(`✗  Plugin check \\(${PLUGIN}\\):`, "g"))?.length).toBe(1);
    expect(out).toContain(scriptPath(project));
    expect(out).toContain("required JSON shape");
  });

  test("timeout SIGKILLs a script that traps SIGTERM and returns promptly", () => {
    const project = freshProject();
    writeDoctorScript(
      project,
      'process.on("SIGTERM", () => {});\nawait Bun.sleep(60_000);\n',
    );

    const startedAt = Date.now();
    const run = runDoctor(project, [], { AIDLC_PLUGIN_DOCTOR_TIMEOUT_MS: "50" });
    const elapsedMs = Date.now() - startedAt;
    expect(run.status).toBe(1);
    expect(elapsedMs).toBeLessThan(5_000);
    expect(output(run)).toContain(
      `✗  Plugin check (${PLUGIN}): check script timed out after 50ms`,
    );
  });

  test("disabled plugin script is inert", () => {
    const project = freshProject();
    const canary = join(project, "plugin-doctor-ran");
    writeDoctorScript(
      project,
      [
        'import { writeFileSync } from "node:fs";',
        'writeFileSync(process.env.PLUGIN_DOCTOR_CANARY!, "ran");',
        'process.stdout.write(JSON.stringify({checks:[{pass:true,label:"ran"}]}));',
        "",
      ].join("\n"),
    );
    setPluginSelection(project, ["aidlc"]);

    const run = runDoctor(project, [], { PLUGIN_DOCTOR_CANARY: canary });
    expect(run.status, output(run)).toBe(0);
    expect(existsSync(canary)).toBe(false);
    expect(output(run)).not.toContain(`Plugin check (${PLUGIN}):`);
  });

  test("plugin without a doctor script emits no plugin rows", () => {
    const project = freshProject();

    const run = runDoctor(project);
    expect(run.status, output(run)).toBe(0);
    expect(output(run)).not.toContain(`Plugin check (${PLUGIN}):`);
  });

  test("--export includes a plugin check finding in report.json", () => {
    const project = freshProject();
    writeDoctorScript(
      project,
      'process.stdout.write(JSON.stringify({checks:[{pass:false,label:"exported plugin failure",fix:"repair plugin"}]}));\n',
    );

    const run = runDoctor(project, ["--export", "--output", join(project, "out")]);
    expect(run.status).toBe(1);
    const report = reportJson(project) as {
      findings?: Array<{ id?: string; summary?: string; severity?: string }>;
    };
    expect(report.findings?.some(
      (finding) =>
        finding.id === "plugin-doctor-probe-exported-plugin-failure" &&
        finding.summary === `Plugin check (${PLUGIN}): exported plugin failure` &&
        finding.severity === "error",
    )).toBe(true);
  });

  test("--export preserves advisory remedy and recovery-bypass safety", () => {
    const project = freshProject();
    const remedy =
      "Archive your workspace before setting AIDLC_DISABLE_REVIEWER_SCOPE_HOOK=1.";
    writeDoctorScript(
      project,
      `process.stdout.write(${JSON.stringify(JSON.stringify({
        checks: [{
          pass: false,
          label: "archive guard",
          fix: remedy,
          severity: "advisory",
        }],
      }))});\n`,
    );

    const run = runDoctor(project, ["--export", "--output", join(project, "out")]);
    expect(run.status, output(run)).toBe(0);
    const report = reportJson(project) as {
      findings?: Array<{
        id?: string;
        severity?: string;
        summary?: string;
        remedy?: string;
        safeToAutomate?: boolean;
      }>;
    };
    const finding = report.findings?.find(
      (row) => row.id === "plugin-doctor-probe-archive-guard",
    );
    expect(finding).toMatchObject({
      id: "plugin-doctor-probe-archive-guard",
      severity: "warning",
      summary: `Plugin check (${PLUGIN}): archive guard (advisory)`,
      remedy,
      safeToAutomate: false,
    });
  });

  test("--export redacts secrets before deriving plugin finding IDs", () => {
    const project = freshProject();
    const awsKey = "AKIAABCDEFGHIJKLMNOP";
    writeDoctorScript(
      project,
      `process.stdout.write(${JSON.stringify(JSON.stringify({
        checks: [{
          pass: false,
          label: `${awsKey} connector`,
          fix: "rotate the connector credential",
        }],
      }))});\n`,
    );

    const run = runDoctor(project, ["--export", "--output", join(project, "out")]);
    expect(run.status).toBe(1);
    const report = reportJson(project) as {
      findings?: Array<{ id?: string; summary?: string }>;
    };
    const finding = report.findings?.find(
      (row) => row.id === "plugin-doctor-probe-redacted-aws-key-connector",
    );
    expect(finding?.id?.toLowerCase()).not.toContain("akia");
    expect(finding?.summary).toContain("<redacted-aws-key> connector");
    expect(
      readFileSync(reportFile(project, "report.md"), "utf-8").toLowerCase(),
    ).not.toContain("akia");
  });

  test("--export marks a passing recovery-bypass remedy unsafe", () => {
    const project = freshProject();
    const remedy = "Set AIDLC_DISABLE_PLUGIN_GUARD=1 to bypass the guard.";
    writeDoctorScript(
      project,
      `process.stdout.write(${JSON.stringify(JSON.stringify({
        checks: [{
          pass: true,
          label: "guard is currently satisfied",
          fix: remedy,
        }],
      }))});\n`,
    );

    const run = runDoctor(project, ["--export", "--output", join(project, "out")]);
    expect(run.status, output(run)).toBe(0);
    const report = reportJson(project) as {
      findings?: Array<{
        id?: string;
        remedy?: string;
        safeToAutomate?: boolean;
      }>;
    };
    const finding = report.findings?.find(
      (row) => row.id === "plugin-doctor-probe-guard-is-currently-satisfied",
    );
    expect(finding).toMatchObject({
      remedy,
      safeToAutomate: false,
    });
  });

  test("--export assigns distinct stable IDs across plugins and duplicate labels", () => {
    const project = freshProject();
    const secondPlugin = "doctor-probe-two";
    writePluginScope(project, secondPlugin, `${secondPlugin}-scope`);
    writeDoctorScript(
      project,
      'process.stdout.write(JSON.stringify({checks:[{pass:false,label:"x"},{pass:false,label:"x"},{pass:false,label:"x-2"}]}));\n',
    );
    writeDoctorScript(
      project,
      'process.stdout.write(JSON.stringify({checks:[{pass:false,label:"x"}]}));\n',
      secondPlugin,
    );

    const run = runDoctor(project, ["--export", "--output", join(project, "out")]);
    expect(run.status).toBe(1);
    const report = reportJson(project) as {
      findings?: Array<{ id?: string; summary?: string }>;
    };
    const ids = report.findings
      ?.filter((finding) => finding.id?.startsWith("plugin-doctor-probe"))
      .map((finding) => finding.id);
    expect(ids).toEqual([
      "plugin-doctor-probe-x",
      "plugin-doctor-probe-x-2",
      "plugin-doctor-probe-x-2-2",
      "plugin-doctor-probe-two-x",
    ]);
    expect(new Set(ids).size).toBe(4);
  });

  test("control characters cannot forge additional doctor rows", () => {
    const project = freshProject();
    writeDoctorScript(
      project,
      `process.stdout.write(${JSON.stringify(JSON.stringify({
        checks: [{
          pass: false,
          label: "ready\nFORGED ROW\u001b[31m",
          fix: "repair\nFORGED FIX\u007f",
        }],
      }))});\n`,
    );

    const run = runDoctor(project);
    const pluginRows = output(run)
      .split(/\r?\n/)
      .filter((line) => line.includes(`Plugin check (${PLUGIN}):`));
    expect(run.status).toBe(1);
    expect(pluginRows).toHaveLength(1);
    expect(pluginRows[0]).not.toContain("\u001b");
    expect(pluginRows[0]).toContain("readyFORGED ROW[31m");
    expect(pluginRows[0]).toContain("repairFORGED FIX");
  });

  test("malformed entries are skipped and summarized once", () => {
    const project = freshProject();
    writeDoctorScript(
      project,
      'process.stdout.write(JSON.stringify({checks:[{pass:true,label:"valid"},{pass:true,label:"bad fix",fix:7},{pass:false,label:"bad severity",severity:"warning"},{pass:true,label:"bad passing severity",severity:"warning"}]}));\n',
    );

    const run = runDoctor(project);
    const out = output(run);
    expect(run.status).toBe(1);
    expect(out).toContain(`✓  Plugin check (${PLUGIN}): valid`);
    expect(out).not.toContain("bad fix");
    expect(out).not.toContain("bad severity");
    expect(out).not.toContain("bad passing severity");
    expect(out).toContain(`✗  Plugin check (${PLUGIN}): 3 malformed check entries skipped`);
  });

  test("check rows are capped and truncation fails loud", () => {
    const project = freshProject();
    writeDoctorScript(
      project,
      'process.stdout.write(JSON.stringify({checks:Array.from({length:52},(_,i)=>({pass:true,label:["row",i].join(" ")}))}));\n',
    );

    const run = runDoctor(project);
    const out = output(run);
    expect(run.status).toBe(1);
    expect(out).toContain(`✓  Plugin check (${PLUGIN}): row 49`);
    expect(out).not.toContain(`✓  Plugin check (${PLUGIN}): row 50`);
    expect(out).toContain(`✗  Plugin check (${PLUGIN}): 2 check result(s) truncated after 50 rows`);
  });
});
