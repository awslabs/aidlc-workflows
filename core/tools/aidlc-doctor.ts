#!/usr/bin/env bun
import { DEFAULT_SUBPROCESS_TIMEOUT_MS } from "./aidlc-runtime-budget.ts";
import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
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
import { isKiroPreset, kiroSessionDoctorFindings } from "./aidlc-kiro-session.ts";
import {
  describeWindowsUninstallFailure,
  scanWindowsUninstallJournals,
  windowsUninstallContinuationState,
} from "./aidlc-windows-uninstall.ts";
import {
  aidlcInvocation,
  discoverProjectHarnesses,
} from "./aidlc-runtime-paths.ts";
import { installRoot, windowsGitBashLauncherState } from "./aidlc-install-paths.ts";
import { versionChannel } from "./aidlc-channel.ts";
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
  HARNESS_PRODUCT_NAMES,
  isModelHarness,
  modelPolicyDoctorIssues,
  modelPolicyIsEmpty,
  sessionModelsDetail,
  sessionSetsAgentModels,
  type ModelHarness,
} from "./aidlc-model-policy.ts";
import {
  flagsDoctorCheck,
  frameworkFilesDoctorCheck,
  providerDoctorCheck,
  settingsDoctorChecks,
  vscodeRequestCapDoctorCheck,
  vscodeWorkspaceRequestCapDoctorCheck,
  workspaceSiblingDoctorCheck,
} from "./aidlc-config-diagnostics.ts";
import {
  modelPolicyForHarness,
  resolveAidlcSettings,
} from "./aidlc-settings.ts";
import { switchesOffLines } from "./aidlc-recorded-switches.ts";

function windowsRecoveryCheck(): DoctorCheck | null {
  if (process.platform !== "win32") return null;
  const recovery = scanWindowsUninstallJournals();
  const failed = recovery.pending.filter(({ journal }) =>
    windowsUninstallContinuationState(journal) === "failed"
  );
  const waiting = recovery.pending.length - failed.length + recovery.finished.length;
  if (waiting + failed.length + recovery.invalid.length === 0) {
    return { pass: true, label: "Windows uninstall recovery: no pending continuations" };
  }
  // The failure message can quote file paths; keep it escaped and on one line.
  const details = [
    ...failed.map(({ journal }) => journal.failure
      ? describeWindowsUninstallFailure(journal.failure)
      : "stopped without a result after repeated attempts"),
    ...recovery.invalid.map((path) => `invalid: ${JSON.stringify(path)}`),
  ];
  return {
    pass: false,
    label: `Windows uninstall recovery: ${waiting} pending, ${failed.length} failed, and ${recovery.invalid.length} invalid continuation(s)${
      details.length > 0 ? `; ${details.join("; ")}` : ""
    }`,
    // By full path: a failed PATH or final step can leave aidlc off PATH.
    fix: failed.length > 0
      ? `resolve the reported problem, then run \`& '${failed[0].journal.commandPath.replaceAll("'", "''")}' uninstall${failed[0].journal.purge ? " --purge" : ""}\` to retry (or reinstall if that command is gone); a cleanup that stopped before removing files is planned again from what is on disk`
      : recovery.invalid.length > 0
        ? "keep the listed journal, cleanup script, and fence for inspection; see Troubleshooting"
        : "finish active AI-DLC commands, then run `aidlc version` to resume cleanup",
  };
}

// An earlier release's launcher helper forwards @args, so Windows PowerShell
// 5.1 splits a value with spaces on its way to aidlc.exe. Any command but
// doctor and uninstall replaces it; this row says it is still there, and why
// it cannot be replaced when that is so.
async function windowsLauncherHelperCheck(): Promise<DoctorCheck | null> {
  if (process.platform !== "win32") return null;
  let helper: string;
  try {
    helper = readFileSync(join(installRoot(), "aidlc-shim.ps1"), "utf-8");
  } catch {
    return null;
  }
  if (!helper.includes("& $executable @args")) return null;
  const { previousWindowsShimHelperState } = await import("./aidlc-lifecycle.ts");
  const state = previousWindowsShimHelperState();
  if (!state) return null;
  const label =
    "Windows launcher: aidlc-shim.ps1 passes arguments the old way, so a value with spaces reaches aidlc as separate words";
  return state.kind === "install"
    ? { pass: false, label: `Windows launcher: not checked, because ${state.reason}`, fix: state.fix }
    : state.kind === "blocked"
    ? { pass: false, label: `${label}; AI-DLC cannot replace it because ${state.reason}`, fix: state.fix }
    : { pass: false, severity: "warn", label: `${label}; ${state.reason}`, fix: state.fix };
}

// Git Bash, where Claude Code runs its hooks on Windows, finds a bare `aidlc`
// only through the extensionless launcher beside aidlc.cmd. Without it every
// hook that calls `aidlc` fails there, while PowerShell and CMD still find the
// command, so the rest of doctor would read healthy.
function windowsGitBashLauncherCheck(): DoctorCheck | null {
  const state = windowsGitBashLauncherState();
  if (state === null) return null;
  if (state.ok) return { pass: true, label: "Windows launcher (Git Bash): a bare `aidlc` runs in Git Bash" };
  return {
    pass: false,
    label: state.foreign
      ? `Windows launcher (Git Bash): ${state.launcher} is not AI-DLC's launcher, so a bare \`aidlc\` in Git Bash does not run AI-DLC`
      : "Windows launcher (Git Bash): a bare `aidlc` does not run in Git Bash, so hooks that call it fail there",
    fix: state.fix,
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
    // An automatic refresh is opportunistic UI work. Its short fallback keeps
    // doctor responsive; a requested --check-updates is required network work.
    update = await refreshUpdateState(explicit ? DEFAULT_SUBPROCESS_TIMEOUT_MS : 750, {
      offline: flags.offline === "true" ? true : undefined,
      baseUrl: flags["release-base-url"],
      caBundle: flags["ca-bundle"],
    });
  }
  return update;
}

export function updateCheck(state: UpdateState): DoctorCheck {
  const invoke = aidlcInvocation();
  // A binary of the other channel: an update goes to the channel the machine
  // follows, which may be older, so the fix names both ways.
  const running = versionChannel(state.currentVersion);
  const otherChannel = state.state === "behind" && running !== state.channel;
  return {
    pass: state.state === "current",
    severity: state.state === "current" || state.state === "invalid-config"
      ? undefined
      : "warn",
    label: `Update: ${state.message}`,
    fix: otherChannel
      ? `run \`${invoke} update\` to go to the newest ${state.channel} release, or ` +
        `\`${invoke} config --channel ${running}\` to keep ${running} releases`
      : state.state === "behind"
      ? `run \`${invoke} update\``
      : state.state === "invalid-config"
      ? `run \`${invoke} config list --global\` and correct the invalid update setting`
      : state.state === "current"
      ? undefined
      : `run \`${invoke} update --check\``,
  };
}

function pluginCheck(projectDir: string, verbose: boolean): DoctorCheck {
  const { inventory, statuses } = collectPluginStatus(projectDir);
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
  if (inventory.capability !== "full-inventory") {
    // No host plugin list to compare against: report what this project has.
    // A warning here could never be cleared by anything the person does.
    const composed = statuses.map((status) =>
      [status.key, status.composedVersion].filter(Boolean).join(" ")
    );
    return {
      pass: true,
      label: composed.length === 0
        ? "Plugins: none in this project"
        : `Plugins: ${composed.join(", ")} in this project (no host plugin list to compare versions with)${detail}`,
    };
  }
  return {
    pass: true,
    label: statuses.length === 0
      ? "Plugins: no AIDLC plugins installed"
      : `Plugins: composed state is current${detail}`,
  };
}

function productName(distribution: string): string {
  return isModelHarness(distribution) ? HARNESS_PRODUCT_NAMES[distribution] : distribution;
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
  // Where the session sets every agent, say where the lever is instead. A
  // recorded policy is named as not applying only when no other installed
  // harness can apply it.
  const installed = harnesses
    .map((harness) => harness.distribution)
    .filter((distribution): distribution is ModelHarness => isModelHarness(distribution));
  const sessionSet = installed.filter((distribution) => sessionSetsAgentModels(distribution));
  if (sessionSet.length > 0) {
    const others = installed.filter((distribution) => !sessionSet.includes(distribution));
    const policyFor = (distribution: ModelHarness) =>
      modelPolicyForHarness(resolved.models, distribution);
    const named = (list: ModelHarness[]) => list.map(productName).join(", ");
    const configured = others.filter((distribution) => !modelPolicyIsEmpty(policyFor(distribution)));
    const unconfigured = others.filter((distribution) => !configured.includes(distribution));
    const parts = [
      ...(configured.length > 0 ? [`recorded policy is expressible on ${named(configured)}`] : []),
      ...(unconfigured.length > 0 ? [`no recorded policy for ${named(unconfigured)}`] : []),
      ...sessionSet.map((distribution) =>
        sessionModelsDetail(distribution, others.length === 0 ? policyFor(distribution) : null)
      ),
    ];
    return { pass: true, label: `Models: ${parts.join("; ")}` };
  }
  return {
    pass: true,
    label: "Models: recorded policy is expressible",
  };
}

// Kiro CLI runs each session on one model from the person's personal Kiro
// settings; these lines check that session against the recorded preset.
export async function kiroSessionDoctorChecks(projectDir: string): Promise<DoctorCheck[]> {
  const kiro = discoverProjectHarnesses(projectDir).find((harness) => harness.distribution === "kiro");
  if (!kiro) return [];
  const policy = modelPolicyForHarness(resolveAidlcSettings(projectDir).models, "kiro");
  const invoke = aidlcInvocation();
  let findings: Awaited<ReturnType<typeof kiroSessionDoctorFindings>>;
  try {
    findings = await kiroSessionDoctorFindings({
      projectDir,
      harnessDir: kiro.harnessDir,
      preset: isKiroPreset(policy?.preset) ? policy.preset : null,
      modelsCommand: `${invoke} config models`,
      configCommand: `${invoke} config`,
    });
  } catch (error) {
    return [{
      pass: true,
      label: `Session model: not checked (${error instanceof Error ? error.message : String(error)})`,
    }];
  }
  return findings.map((finding) =>
    finding.pass
      ? { pass: true, label: finding.label }
      : { pass: false, severity: "warn", label: finding.label, ...(finding.fix ? { fix: finding.fix } : {}) }
  );
}

function humanReport(
  report: DoctorReport,
  analysis: DoctorAnalysis,
  projectDir: string,
  verbose: boolean,
): string {
  const harness = discoverProjectHarnesses(projectDir)[0];
  const frameworkPattern =
    /^(?:Agent filename|Scope filename|Cycle detection|Orphan stage|Uncompiled stage|Enabled stage compile coverage|Scope validation|Schema validation|Graph references|Keyword overlap|Rule drift|Paired sensor coverage|Stage graph|Scope grid|Sensor |Required sections|Upstream coverage|Traceability|Linter|Type check)/i;
  const machinePattern =
    /^(?:Update:|Windows uninstall|Windows launcher|Runtime hook PATH|Harness CLI|Installed runtime|Command pointer|Rollback target|Project pin registry|Transaction staging|Transaction recovery|Settings global)/i;
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
  // Never quote the doctor command itself: VS Code's terminal tool deletes a
  // command's output up to the line that repeats it, so the agent got nothing (#1411).
  const fallbackFix =
    "add --verbose to see the details, correct the named condition, then run doctor again";
  const renderCheck = (check: DoctorCheck): string => {
    const verdict = status(check);
    // Labels can carry project-derived text (file names); never relay control
    // characters to the terminal.
    const label = check.label.replace(/\p{Cc}/gu, "?");
    let row = `  ${colorVerdict(verdict)} ${label}\n`;
    if (verdict !== "ok") {
      const fix = (check.fix ?? fallbackFix).replace(/\p{Cc}/gu, "?");
      row += `        ${fixLabel("fix:", out)} ${fix}\n`;
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
      ? ` (${harness.harnessDir}, ${productName(harness.distribution)})`
      : ""
  }`, out)}\n`;
  output += renderSection(project, findingRows);
  if (report.parked_attempts.length > 0) {
    output += `\n${heading("Parked attempts", out)}\n`;
    for (const attempt of report.parked_attempts) {
      output += `  ${okVerdict("ok   ", out)} ${attempt.slug} / ${attempt.stamp} (repo ${attempt.repo ?? "."}, age ${attempt.age_days ?? "unknown"} days, mode ${attempt.mode})\n`;
      output += `        restored checkout: ${attempt.restored_exists ? "present" : "absent"} - ${attempt.restored_path}\n`;
      if (attempt.restore_command !== undefined) {
        output += `        restore: ${attempt.restore_command}\n`;
      } else if (attempt.restore_command_error !== undefined) {
        output += `        restore display unavailable: ${attempt.restore_command_error}; use restore_operation from --json\n`;
      }
      if (attempt.purge_command !== undefined) {
        output += `        purge: ${attempt.purge_command}\n`;
      } else if (attempt.purge_command_error !== undefined) {
        output += `        purge display unavailable: ${attempt.purge_command_error}; use purge_operation from --json\n`;
      }
    }
  }
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
    output += `${dim("Add --verbose to see every check.", out)}\n`;
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
  const launcher = await windowsLauncherHelperCheck();
  if (launcher) checks.push(launcher);
  const gitBashLauncher = windowsGitBashLauncherCheck();
  if (gitBashLauncher) checks.push(gitBashLauncher);
  checks.push(updateCheck(update));
  checks.push(pluginCheck(projectDir, flags.verbose === "true"));
  checks.push(...settingsDoctorChecks(projectDir));
  checks.push(modelsPolicyCheck(projectDir, flags.verbose === "true"));
  checks.push(...await kiroSessionDoctorChecks(projectDir));
  checks.push(flagsDoctorCheck(projectDir, harnessDir(), switchesOffLines(projectDir, process.env, "command")));
  checks.push(providerDoctorCheck(projectDir, harnessDir()));
  checks.push(workspaceSiblingDoctorCheck(projectDir, harnessDir()));
  checks.push(frameworkFilesDoctorCheck(projectDir, harnessDir()));
  const requestCap = vscodeRequestCapDoctorCheck(projectDir, harnessDir());
  if (requestCap) checks.push(requestCap);
  const workspaceRequestCap = vscodeWorkspaceRequestCapDoctorCheck(projectDir, harnessDir());
  if (workspaceRequestCap) checks.push(workspaceRequestCap);
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
