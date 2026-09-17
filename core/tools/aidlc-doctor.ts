#!/usr/bin/env bun
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  errorMessage,
  harnessDir,
  isoTimestamp,
  parseArgs,
  resolveProjectDir,
} from "./aidlc-lib.ts";
import {
  adaptLegacyResult,
  buildBundle,
  mergeFindings,
  runDoctorAnalysis,
  type DoctorAnalysis,
} from "./aidlc-doctor-bundle.ts";
import {
  collectDoctorReport,
  type DoctorCheck,
  type DoctorReport,
} from "./aidlc-utility.ts";
import {
  cachedUpdateState,
  refreshUpdateState,
  type UpdateState,
} from "./aidlc-update.ts";
import { collectPluginStatus } from "./aidlc-plugin.ts";
import { scanWindowsUninstallJournals } from "./aidlc-windows-uninstall.ts";
import {
  aidlcInvocation,
  discoverProjectHarnesses,
} from "./aidlc-runtime-paths.ts";
import {
  configureColor,
  dim,
  failVerdict,
  fixLabel,
  heading,
  okVerdict,
  success,
  warnVerdict,
} from "./aidlc-color.ts";
import {
  isModelHarness,
  modelPolicyDoctorIssues,
} from "./aidlc-model-policy.ts";
import {
  flagsDoctorCheck,
  providerDoctorCheck,
  settingsDoctorChecks,
  workspaceSiblingDoctorCheck,
} from "./aidlc-config-diagnostics.ts";
import {
  modelPolicyForHarness,
  resolveAidlcSettings,
} from "./aidlc-settings.ts";

function windowsRecoveryCheck(): DoctorCheck | null {
  if (process.platform !== "win32") return null;
  const recovery = scanWindowsUninstallJournals();
  const paths = [
    ...recovery.pending.map((item) => item.path),
    ...recovery.invalid,
  ];
  return {
    pass: paths.length === 0,
    label: paths.length === 0
      ? "Windows uninstall recovery: no pending continuations"
      : `Windows uninstall recovery: ${recovery.pending.length} pending and ${recovery.invalid.length} invalid continuation(s): ${paths.join(", ")}`,
    fix: paths.length === 0
      ? undefined
      : "finish active AI-DLC commands, then run `aidlc version` to resume cleanup",
  };
}

export async function doctorUpdateState(
  flags: Record<string, string>,
  interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY),
): Promise<UpdateState> {
  const explicit = flags["check-updates"] === "true";
  const mayRefresh = interactive &&
    flags.json !== "true" &&
    flags.quiet !== "true";
  let update = cachedUpdateState();
  if (
    explicit ||
    (mayRefresh &&
      (update.stale === true ||
        ["stale", "absent", "unavailable"].includes(update.state)))
  ) {
    update = await refreshUpdateState(explicit ? 15_000 : 750, {
      offline: flags.offline === "true" ? true : undefined,
      baseUrl: flags["release-base-url"],
      caBundle: flags["ca-bundle"],
    });
  }
  return update;
}

function updateCheck(state: UpdateState): DoctorCheck {
  const invoke = aidlcInvocation();
  return {
    pass: state.state === "current",
    severity: state.state === "current" || state.state === "invalid-config"
      ? undefined
      : "warn",
    label: `Update: ${state.message}`,
    fix: state.state === "behind"
      ? `run \`${invoke} update\``
      : state.state === "invalid-config"
      ? `run \`${invoke} config list --global\` and correct the invalid update setting`
      : state.state === "current"
      ? undefined
      : `run \`${invoke} update --check\``,
  };
}

function pluginCheck(projectDir: string, verbose: boolean): DoctorCheck {
  const { statuses } = collectPluginStatus(projectDir);
  const attention = statuses.filter((status) => status.action === "attention");
  const drift = statuses.filter((status) => status.action === "sync");
  const detail = verbose && statuses.length > 0
    ? ` - ${statuses.map((status) => `${status.key ?? "host"}:${status.state}`).join(", ")}`
    : "";
  if (attention.length > 0) {
    return {
      pass: false,
      severity: "warn",
      label: `Plugins: ${attention.length} need attention${detail}`,
      fix: attention.map((status) => status.message).join("; "),
    };
  }
  if (drift.length > 0) {
    return {
      pass: false,
      severity: "warn",
      label: `Plugins: ${drift.length} require sync${detail}`,
      fix: "run `aidlc config`",
    };
  }
  return {
    pass: true,
    label: statuses.length === 0
      ? "Plugins: no AIDLC plugins installed"
      : `Plugins: composed state is current${detail}`,
  };
}

export function modelsPolicyCheck(projectDir: string, verbose: boolean): DoctorCheck {
  const harnesses = discoverProjectHarnesses(projectDir);
  if (harnesses.length === 0) {
    return {
      pass: true,
      label: "Models: no installed project harness",
    };
  }
  const resolved = resolveAidlcSettings(projectDir);
  const issues: string[] = [];
  for (const harness of harnesses) {
    if (!isModelHarness(harness.distribution)) {
      issues.push(`unsupported harness policy surface: ${harness.distribution}`);
      continue;
    }
    try {
      issues.push(
        ...modelPolicyDoctorIssues(
          harness.root,
          harness.distribution,
          modelPolicyForHarness(resolved.models, harness.distribution),
        )
          .map((issue) => `${harness.distribution}: ${issue}`),
      );
    } catch (error) {
      issues.push(
        `${harness.distribution}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  const detail = verbose && issues.length > 0 ? ` - ${issues.join("; ")}` : "";
  if (issues.length > 0) {
    return {
      pass: false,
      severity: "warn",
      label: `Models: ${issues.length} policy issue(s)${detail}`,
      fix: issues.join("; "),
    };
  }
  return {
    pass: true,
    label: "Models: recorded policy is expressible",
  };
}

function humanReport(
  report: DoctorReport,
  analysis: DoctorAnalysis,
  projectDir: string,
  verbose: boolean,
): string {
  const harness = discoverProjectHarnesses(projectDir)[0];
  const productNames: Record<string, string> = {
    claude: "Claude Code",
    codex: "Codex CLI",
    copilot: "GitHub Copilot",
    cursor: "Cursor",
    kiro: "Kiro CLI",
    "kiro-ide": "Kiro IDE",
    opencode: "opencode",
  };
  const frameworkPattern =
    /^(?:Agent filename|Scope filename|Cycle detection|Orphan stage|Uncompiled stage|Enabled stage compile coverage|Scope validation|Schema validation|Graph references|Keyword overlap|Rule drift|Paired sensor coverage|Stage graph|Scope grid|Sensor |Required sections|Upstream coverage|Traceability|Linter|Type check)/i;
  const machinePattern =
    /^(?:Update:|Windows uninstall|Runtime hook PATH|Harness CLI|Installed runtime|Command pointer|Rollback target|Project pin registry|Transaction staging|Transaction recovery|Settings global)/i;
  const machine = report.checks.filter((check) => machinePattern.test(check.label));
  const framework = report.checks.filter((check) => frameworkPattern.test(check.label));
  const project = report.checks.filter((check) =>
    !machine.includes(check) && !framework.includes(check)
  );
  const status = (check: DoctorCheck): "ok" | "warn" | "fail" =>
    check.severity === "warn" ? "warn" : check.pass ? "ok" : "fail";
  const out = process.stdout;
  const colorVerdict = (verdict: "ok" | "warn" | "fail"): string => {
    const padded = verdict.padEnd(5);
    return verdict === "warn"
      ? warnVerdict(padded, out)
      : verdict === "fail"
      ? failVerdict(padded, out)
      : okVerdict(padded, out);
  };
  const invoke = aidlcInvocation();
  const fallbackFix =
    `run \`${invoke} doctor --verbose\`, correct the named condition, then rerun \`${invoke} doctor\``;
  const renderCheck = (check: DoctorCheck): string => {
    const verdict = status(check);
    let row = `  ${colorVerdict(verdict)} ${check.label}\n`;
    if (verdict !== "ok") {
      row += `        ${fixLabel("fix:", out)} ${check.fix ?? fallbackFix}\n`;
    }
    return row;
  };
  const findings = analysis.findings.filter((finding) => finding.severity !== "info");
  const findingRows = findings.map((finding) =>
    `  ${warnVerdict("warn ", out)} [${finding.id}] ${finding.summary}\n` +
    `        ${fixLabel("fix:", out)} ${finding.remedy ?? fallbackFix}\n`
  );
  const renderSection = (
    checks: readonly DoctorCheck[],
    extraAttentionRows: readonly string[] = [],
  ): string => {
    if (verbose) {
      return `${checks.map(renderCheck).join("")}${extraAttentionRows.join("")}`;
    }
    const passing = checks.filter((check) => status(check) === "ok");
    const attention = checks.filter((check) => status(check) !== "ok");
    let rows = attention.map(renderCheck).join("");
    rows += extraAttentionRows.join("");
    if (passing.length > 0) {
      const allClean = attention.length === 0 && extraAttentionRows.length === 0;
      rows += `  ${okVerdict("ok   ", out)} ${allClean ? "all " : ""}${passing.length} checks passed\n`;
    }
    return rows;
  };
  let output = `${heading("AI-DLC doctor", out)}\n\n`;
  output += `${heading("Machine", out)}\n`;
  output += renderSection(machine);
  output += `\n${heading(`Project${
    harness
      ? ` (${harness.harnessDir}, ${productNames[harness.distribution] ?? harness.distribution})`
      : ""
  }`, out)}\n`;
  output += renderSection(project, findingRows);
  output += `\n${heading("Framework integrity", out)}\n`;
  output += renderSection(framework);
  const visibleWarnings = report.warnings + findings.length;
  const problems = `${report.failed} problem${report.failed === 1 ? "" : "s"}`;
  const warnings = `${visibleWarnings} warning${visibleWarnings === 1 ? "" : "s"}`;
  output += `\n${
    report.failed > 0 ? failVerdict(problems, out) : problems
  }, ${visibleWarnings > 0 ? warnVerdict(warnings, out) : warnings}.\n`;
  if (visibleWarnings > 0) {
    output += "Warnings are advisory - if everything works, ignore them.\n";
  }
  if (report.failed === 0 && visibleWarnings === 0) {
    output += `${success("Your install is ready.", out)}\n`;
  }
  if (!verbose) {
    output += `${dim(
      `Run '${aidlcInvocation()} doctor --verbose' to see every check.`,
      out,
    )}\n`;
  }
  return output;
}

// A filesystem-safe UTC timestamp token (isoTimestamp has colons that some
// filesystems reject in names): 2026-07-14T15:26:31Z \u2192 20260714T152631Z.
function fsSafeTimestamp(): string {
  return isoTimestamp().replace(/[-:]/g, "").replace(/\.\d+/, "");
}

function canonicalFuturePath(path: string): string {
  let cursor = resolve(path);
  const suffix: string[] = [];
  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) break;
    suffix.unshift(basename(cursor));
    cursor = parent;
  }
  const base = existsSync(cursor) ? realpathSync(cursor) : cursor;
  return suffix.reduce((current, entry) => join(current, entry), base);
}

function withinRoot(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" ||
    (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

function resolveExportParent(
  projectDir: string,
  flags: Record<string, string>,
): string {
  if (flags.output === "true") {
    throw new Error("--output requires a directory path (e.g. --output ./aidlc-report)");
  }
  const projectRoot = canonicalFuturePath(projectDir);
  const output = canonicalFuturePath(
    flags.output
      ? flags.output
      : join(projectDir, "aidlc", "diagnostics"),
  );
  if (!withinRoot(output, projectRoot)) {
    throw new Error("--output must stay inside the selected project directory");
  }
  return output;
}

function emitDoctorUsage(flags: Record<string, string>, message: string): void {
  if (flags.json === "true") {
    process.stdout.write(`${JSON.stringify({
      schemaVersion: 1,
      ok: false,
      code: 2,
      status: "usage",
      message,
    })}\n`);
  } else {
    process.stdout.write(`${message}\n`);
  }
  process.exitCode = 2;
}

// --export: after the live report, write a redacted diagnostic report from
// the SAME analysis this run already computed (issue #575). No second read,
// no cached diagnosis. The export write never changes doctor's exit code.
// `--export` is a bare boolean flag; accept it whether the arg parser recorded
// it as "true" (bare) or a stray token followed it, so a trailing word can
// never silently disable the export.
function writeExport(
  outParent: string,
  report: DoctorReport,
  analysis: DoctorAnalysis,
): void {
  try {
    const tsToken = fsSafeTimestamp();
    mkdirSync(outParent, { recursive: true });
    // Merge the legacy environment/config checks (bun present, hooks wired,
    // settings intact) into the exported analysis so report.md/report.json
    // carry the SAME findings the live report shows \u2014 the bundle exists so
    // the maintainer does NOT need the user's project, so a failing env check
    // must reach it. The live render and the exit code are untouched; this
    // only enriches what buildBundle serializes. (Arden round-3 #1.)
    const analysisForExport = {
      ...analysis,
      findings: mergeFindings(report.checks.map(adaptLegacyResult), analysis.findings),
    };
    const exported = buildBundle(outParent, analysisForExport, tsToken);
    let out = "\nDiagnostic report created:\n";
    out += `  ${exported.archivePath ?? exported.bundleDir}\n\n`;
    out += "Findings:\n";
    const topFindings = exported.findings.filter((f) => f.severity !== "info").slice(0, 20);
    if (topFindings.length === 0) {
      out += "  (no errors or warnings)\n";
    } else {
      for (const f of topFindings) out += `  ${f.severity.toUpperCase()} ${f.id}\n`;
    }
    out += "\nNo source files or artifact bodies were included.\n";
    if (exported.manualShareNote) out += `\n${exported.manualShareNote}\n`;
    process.stdout.write(out);
  } catch (e) {
    // Export failure must not mask the live doctor result; report and go on.
    process.stdout.write(`\nDiagnostic report could not be created: ${errorMessage(e)}\n`);
  }
}

export async function main(argv: string[]): Promise<void> {
  configureColor(argv);
  const { flags } = parseArgs(argv);
  const projectDir = resolveProjectDir(flags["project-dir"]);
  const exporting = "export" in flags;
  if (flags.output !== undefined && !exporting) {
    emitDoctorUsage(flags, "--output requires --export");
    return;
  }
  if (
    exporting &&
    (flags.json === "true" || flags.quiet === "true")
  ) {
    emitDoctorUsage(flags, "--export cannot be combined with --json or --quiet");
    return;
  }
  let exportParent: string | undefined;
  if (exporting) {
    try {
      exportParent = resolveExportParent(projectDir, flags);
    } catch (error) {
      emitDoctorUsage(flags, errorMessage(error));
      return;
    }
  }
  const update = await doctorUpdateState(flags);
  const checks: DoctorCheck[] = [];
  const recovery = windowsRecoveryCheck();
  if (recovery) checks.push(recovery);
  checks.push(updateCheck(update));
  checks.push(pluginCheck(projectDir, flags.verbose === "true"));
  checks.push(...settingsDoctorChecks(projectDir));
  checks.push(modelsPolicyCheck(projectDir, flags.verbose === "true"));
  checks.push(flagsDoctorCheck(projectDir, harnessDir()));
  checks.push(providerDoctorCheck(projectDir, harnessDir()));
  checks.push(workspaceSiblingDoctorCheck(projectDir, harnessDir()));
  const report = await collectDoctorReport(projectDir, checks);
  // One fresh analysis, shared by the live report AND the --export writer
  // (issue #575): the structured condition->remedy findings and the
  // reconstructed timeline are computed ONCE here, so the live output and the
  // export can never diverge. The analysis performs no writes.
  const analysis = runDoctorAnalysis(projectDir);
  const code = update.state === "invalid-config"
    ? 2
    : report.failed > 0
    ? 1
    : 0;

  if (flags.json === "true") {
    process.stdout.write(`${JSON.stringify({
      schemaVersion: 1,
      ok: code === 0,
      code,
      status: report.failed > 0
        ? "failed"
        : report.warnings > 0
        ? "warning"
        : "ok",
      message: `${report.passed} passed, ${report.warnings} warnings, ${report.failed} failed`,
      data: report,
    })}\n`);
  } else if (flags.quiet === "true") {
    process.stdout.write(
      `${report.passed} passed, ${report.warnings} warnings, ${report.failed} failed\n`,
    );
  } else {
    process.stdout.write(
      humanReport(report, analysis, projectDir, flags.verbose === "true"),
    );
  }
  if (exportParent) writeExport(exportParent, report, analysis);
  process.exitCode = code;
}

if (import.meta.main) {
  void main(process.argv.slice(2));
}
