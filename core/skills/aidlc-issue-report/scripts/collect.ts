// Collect what AI-DLC and the AI tool left about a run, in two layers:
//   <out>/safe.json   shareable facts only: every field shaped (lib-shape.ts), then redacted
//   <out>/local/      raw snippets for the model to understand the run, the redaction map and
//                     labels, and the raw doctor export. finish.ts deletes this folder; nothing in
//                     it goes into the report, and the doctor export is not sent.
//
// Usage: collect.ts [--project <dir>] [--out <dir>] [--days 7]
//                   [--since <ISO>] [--until <ISO>] [--no-doctor]

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { platform } from "node:os";
import { join, relative, resolve } from "node:path";
import { extractArchive, walkFiles } from "./lib-archive.ts";
import {
  absenceSignals, hookHealthDirs, matchReplies, PROBLEM_EVENTS, readAudit, readHooksHealth, readSessionsFolder, readState, timeWindow,
  withoutReportTurns,
} from "./lib-audit.ts";
import {
  doctorEnv, environment, findProjectRoot, importAidlcTools, listIntents, nativeInstall, readTrees, secretRulesFile, toolsUsed, type Tree,
} from "./lib-project.ts";
import { HOST_TOOLS, Labels, Shaper, time, version } from "./lib-shape.ts";
import { claude, codex, copilotCli, editorStores, kiroV2, kiroV3, type Local, type Summary } from "./lib-transcripts.ts";
import { loadVocab } from "./lib-vocab.ts";
import { gateContext } from "./lib-check.ts";
import { flagValue } from "./lib-cli.ts";
import { safeHits } from "./lib-gate.ts";
import { buildDictionary, type Dictionary, redactValue, useSecretRules } from "./redact.ts";

const arg = (name: string) => flagValue(name);
const flag = (name: string) => process.argv.includes(`--${name}`);

function stamp(): string {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-");
}

const project = findProjectRoot(arg("project") ?? process.cwd());
if (!project) {
  console.log(JSON.stringify({ ok: false, reason: "no-aidlc-project", hint: "Run this from the project folder where AI-DLC was used." }));
  process.exit(2);
}
const projectRoot: string = project;
// The reports live in AI-DLC's own diagnostics folder (aidlc/diagnostics/, which AI-DLC's .gitignore block
// keeps out of git, beside doctor's exports), next to the run they describe.
// Whether AI-DLC's diagnostics folder was there before this run, so the empty one doctor leaves behind is removed
// only when this run made it.
const diagnostics = join(project, "aidlc", "diagnostics");
const hadDiagnostics = existsSync(diagnostics);
// Two runs in the same second get two folders.
function freshDefault(): string {
  const base = join(diagnostics, "issue-reports", stamp());
  let dir = base;
  for (let n = 2; existsSync(dir); n++) dir = `${base}-${n}`;
  return dir;
}
const out = resolve(arg("out") ?? freshDefault());
if (existsSync(out) && !statSync(out).isDirectory()) {
  console.log(JSON.stringify({ ok: false, reason: "out-not-a-folder", hint: "Leave out --out, or name a new or empty folder." }));
  process.exit(2);
}
// finish.ts deletes local/ at the end: a folder that already holds anything is not this run's to fill.
if (existsSync(out) && readdirSync(out).length > 0) {
  console.log(JSON.stringify({ ok: false, reason: "out-not-empty", hint: "Leave out --out, or name a new or empty folder." }));
  process.exit(2);
}
const localDir = join(out, "local");
mkdirSync(localDir, { recursive: true });
// The raw layer stays out of git wherever --out put it.
writeFileSync(join(localDir, ".gitignore"), "*\n");

// ---- what is there ----
const trees = readTrees(project);
// Secrets are AI-DLC's to define, and so are its finding ids: both come from the AI-DLC this project has
// installed.
const secretFrom = secretRulesFile(project);
const aidlcTools = await importAidlcTools(secretFrom);
const secretRules = aidlcTools.secretRules;
useSecretRules(secretRules);
const vocab = loadVocab(project, trees.map((t) => t.dir), aidlcTools.findingId, aidlcTools.holdsRecordedWrite);
const intents = listIntents(project);
const rows = readAudit(project, intents, aidlcTools);
const units = [...new Set(rows.map((r) => r.fields.Unit).filter(Boolean))] as string[];
const intentDirs = intents.map((it) => it.dir);
// Every space folder, including one that holds only documents and no intent yet.
const spacesRoot = join(project, "aidlc", "spaces");
const spaces = (existsSync(spacesRoot) ? readdirSync(spacesRoot) : []).filter((s) => s !== "default" && !s.startsWith("."));
// A native install outside the home folder (a custom XDG_DATA_HOME or LOCALAPPDATA) names its own path.
const native = nativeInstall();
const installPaths = [native?.dir, native?.exe].filter((v): v is string => !!v).map((value) => ({ value, label: "<aidlc-install>" }));

// ---- time window: the last AI-DLC activity back N days, unless given ----
const { since, until, lastActivity, notes: windowNotes } = timeWindow({
  since: arg("since"),
  until: arg("until"),
  days: arg("days"),
  rows,
  now: Date.now(),
  doctorRunEvents: aidlcTools.doctorRunEvents,
});
const inWin = (ts: string) => {
  const t = Date.parse(ts);
  return t >= since && t <= until;
};

// ---- AI-DLC records ----
const winRows = rows.filter((r) => inWin(r.ts));
const health = readHooksHealth(hookHealthDirs(project, intents), since, until);

// ---- the AI tool's own logs ----
const local: Local = { prompts: [], refusals: [], errors: [] };
// The tool each reader names, for one that failed (the readers' own labels).
const READER_TOOL: Record<string, string> = { claude: "claude-code", codex: "codex", kiroV3: "kiro (v3)", kiroV2: "kiro-cli (v2)", copilotCli: "copilot-cli" };
const transcripts = [claude, codex, kiroV3, kiroV2, copilotCli]
  .map((fn) => {
    try {
      return fn(project, since, until, local);
    } catch (e) {
      local.errors.push({ tool: fn.name, ts: new Date().toISOString(), text: String(e).slice(0, 600) });
      return { tool: READER_TOOL[fn.name] ?? "other", error: "reader failed" };
    }
  })
  .filter((s): s is Summary | { tool: string; error: string } => s !== null)
  // Readers walk files in folder order, so the timeline is put in time order before the newest 200 are kept.
  .map((s) => ({ ...s, timeline: [...("timeline" in s ? s.timeline : [])].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0)).slice(-200) }));

// AI-DLC's own names (a stage, a scope, an agent), the words safe.json keeps from the AI-DLC commands this run
// gave (`next`, `orchestrate`) and the AI tools' own tool names are not taken for the person's, so a project
// called `next` does not rewrite them; a word that only appears somewhere in AI-DLC's source (`checkout`,
// `Shell`) is, when it is also this project's or person's name.
const commandWords = transcripts
  .flatMap((t) => ("aidlcCommands" in t ? Object.keys(t.aidlcCommands) : []))
  .flatMap((c) => c.split(" "))
  .filter((w) => vocab.words.has(w));
const aidlcNames = new Set([
  ...[vocab.stages, vocab.phases, vocab.scopes, vocab.agents, vocab.sensors, vocab.hooks, vocab.guards, vocab.tools].flatMap((set) => [...set]),
  ...commandWords,
  ...HOST_TOOLS,
]);
const dict: Dictionary = buildDictionary(project, { intents: intentDirs, spaces, units, paths: installPaths, ordinary: aidlcNames });
dict.secretRulesFrom = secretRules ? secretFrom : null;
writeFileSync(join(localDir, "redaction-map.json"), JSON.stringify(dict, null, 2));
// AI-DLC's words, for the check (lib-gate.ts) after this run.
writeFileSync(join(localDir, "vocab.json"), JSON.stringify([...vocab.words].sort()));
writeFileSync(join(localDir, "phrases.json"), JSON.stringify([...vocab.phrases].sort()));
// A Unit's and an intent's label in safe.json is the dictionary's, so it is the same one the report uses.
// A Unit or an intent left out of the replacements as an ordinary word (`backend`) keeps the label the map gives it.
const known = new Map([...dict.entries, ...(dict.skipped ?? [])].filter((e) => e.kind === "unit" || e.kind === "intent").map((e) => [e.value, e.label]));
for (const it of intents) if (!known.has(it.dir)) known.set(it.dir, `<intent-${intents.indexOf(it) + 1}>`);
const shaper = new Shaper(vocab, new Labels(), known);

// Versions of the tools this run used. A version the tool wrote into its own log (`toolVersions`) is the
// one at the time of the run; the rest are measured now, and the ones not found at all are asked of the
// person (SKILL.md step 4) and recorded with set-version.ts.
const usedTools = toolsUsed(transcripts);
// Only the tools the run used are asked for their version: nothing else is started.
const env = environment(project, usedTools);
// A version is missing when none can be read from what the tool printed, not only when it printed nothing.
const loggedReadable = new Set(
  toolsUsed(transcripts.filter((t) => "toolVersions" in t && Object.keys(t.toolVersions).some((v) => version(v) !== null))),
);
const versionsMissing = usedTools.filter((k) => version(env.tools[k].version) === null && !loggedReadable.has(k));

const runRows = withoutReportTurns(winRows, local.prompts);
const counts: Record<string, number> = {};
for (const r of runRows) counts[r.event] = (counts[r.event] ?? 0) + 1;
const problems = runRows.filter((r) => PROBLEM_EVENTS.has(r.event));

// ---- did each typed reply reach AI-DLC? ----
const replies = matchReplies(local.prompts, runRows);

// ---- doctor --export: read here, kept in local/, not sent ----
// The export carries text people and agents wrote (a Unit's pause reason, check messages), which no
// redaction can tell from a name it does not know; its finding ids and severities go into safe.json.
function aidlcCommand(t: Tree | undefined): string[] | null {
  if (t && (t.channel === "copy" || (t.channel === "unknown" && existsSync(join(projectRoot, t.dir, "tools", "aidlc.ts"))))) {
    return [process.execPath, join(t.dir, "tools", "aidlc.ts")];
  }
  // On Windows the installed aidlc.exe comes first: a .cmd shim on PATH runs only through a shell.
  if (platform() === "win32" && native?.exe && existsSync(native.exe)) return [native.exe];
  const which = typeof Bun !== "undefined" ? (Bun.which(platform() === "win32" ? "aidlc.cmd" : "aidlc") ?? Bun.which("aidlc")) : null;
  if (which) return [which];
  if (native?.exe && existsSync(native.exe)) return [native.exe];
  if (t && existsSync(join(projectRoot, t.dir, "tools", "aidlc.ts"))) return [process.execPath, join(t.dir, "tools", "aidlc.ts")];
  return null;
}

type Doctor = { ran: boolean; exit: number | null; findings: { id: string; severity: string }[]; checksFailed: number; note: string };
const doctor: Doctor = { ran: false, exit: null, findings: [], checksFailed: 0, note: "" };
if (flag("no-doctor")) {
  doctor.note = "skipped (--no-doctor)";
} else {
  const cmd = aidlcCommand(trees[0]);
  if (!cmd) {
    doctor.note = "AI-DLC command not found";
  } else {
    // doctor refuses an --output outside the project, so it writes into a
    // folder of ours under aidlc/diagnostics/, which is moved into local/ right after.
    const ownFolder = `aidlc-issue-report-${process.pid}`;
    const inProject = join(diagnostics, ownFolder);
    mkdirSync(inProject, { recursive: true });
    const rawDir = join(localDir, "doctor-raw");
    // doctor is told which project to check, and both folders are written relative to it (it runs there): no path
    // of the person's reaches its command line, which a .cmd shim's shell would expand (`%NAME%` in a folder name).
    // A .cmd shim (Windows, no aidlc.exe found) runs only through a shell, each argument quoted.
    const shim = platform() === "win32" && /\.cmd$/i.test(cmd[0]);
    const args = [...cmd.slice(1), "doctor", "--export", "--project-dir", ".", "--output", `aidlc/diagnostics/${ownFolder}`];
    const r = spawnSync(shim ? `"${cmd[0]}"` : cmd[0], shim ? args.map((a) => `"${a}"`) : args, {
      shell: shim,
      cwd: project,
      env: doctorEnv(cmd, process.execPath, process.env),
      encoding: "utf8",
      timeout: 180_000,
    });
    rmSync(rawDir, { recursive: true, force: true });
    cpSync(inProject, rawDir, { recursive: true });
    rmSync(inProject, { recursive: true, force: true });
    if (!hadDiagnostics && readdirSync(diagnostics).length === 0) rmSync(diagnostics, { recursive: true, force: true });
    // A doctor that could not start or was stopped at the time limit did not run, whatever it left behind. Exit 2
    // with no export is said as such: doctor refused an option, or finished but could not read its update setting.
    doctor.ran = !r.error && r.status !== null;
    if (doctor.ran && r.status === 2 && readdirSync(rawDir).length === 0) {
      doctor.note = "doctor exited 2 and made no export (an option it refused, or an update setting it could not read)";
    }
    // A status beyond 0–255 is the system's (a Windows crash code such as 3221225477), not doctor's own.
    doctor.exit = r.status !== null && r.status >= 0 && r.status <= 255 ? r.status : null;
    if (r.status !== null && doctor.exit === null) doctor.note = "doctor ended with a system error code";
    if (!doctor.ran) {
      doctor.note =
        r.error && "code" in r.error && r.error.code === "ETIMEDOUT"
          ? "doctor did not finish within 3 minutes"
          : "doctor could not run";
    }
    writeFileSync(join(localDir, "doctor-stdout.txt"), `${r.stdout ?? ""}\n${r.stderr ?? ""}`);
    const found: { id: string; severity: string }[] = [];
    // An info row is not a finding, here as in report.json.
    for (const m of (r.stdout ?? "").matchAll(/^\s*(ERROR|WARNING|WARN)\s+([a-z][a-z0-9-]+)\s*$/gm)) found.push({ severity: m[1], id: m[2] });
    doctor.checksFailed = [...(r.stdout ?? "").matchAll(/^\s*(?:✗|FAIL|\[fail\]|×)\s+.{3,80}$/gim)].length;
    // The export's report.json lists the findings; it is read where doctor wrote it.
    const tgz = readdirSync(rawDir).find((f) => f.endsWith(".tar.gz"));
    let reportRoot: string | null = readdirSync(rawDir).some((f) => statSync(join(rawDir, f)).isDirectory()) ? rawDir : null;
    if (tgz) {
      try {
        const unpacked = join(rawDir, "unpacked");
        mkdirSync(unpacked, { recursive: true });
        extractArchive(join(rawDir, tgz), unpacked);
        reportRoot = unpacked;
      } catch {
        doctor.note ||= "the doctor export could not be unpacked";
      }
    }
    for (const f of reportRoot ? walkFiles(reportRoot) : []) {
      if (!f.endsWith("report.json")) continue;
      try {
        const j = JSON.parse(readFileSync(f, "utf8")) as { findings?: { id?: unknown; severity?: unknown }[] };
        for (const x of j.findings ?? []) {
          if (x?.id && String(x.severity ?? "").toLowerCase() !== "info") found.push({ id: String(x.id), severity: String(x.severity ?? "") });
        }
      } catch {
        // report.json shape not as expected
      }
    }
    const seen = new Set<string>();
    doctor.findings = found.filter((f) => {
      if (seen.has(f.id)) return false;
      seen.add(f.id);
      return true;
    });
    if (doctor.ran && !doctor.note) doctor.note = "the export stays in local/doctor-raw and is not sent";
  }
}

// ---- write ----
const safe = {
  schema: 2,
  generatedAt: new Date().toISOString(),
  window: { since: new Date(since).toISOString(), until: new Date(until).toISOString(), lastAidlcActivity: time(lastActivity), notes: windowNotes },
  environment: { ...shaper.environment(env), toolsUsed: usedTools, versionsMissing },
  trees: shaper.trees(trees),
  intents: intents.map((it) => shaper.state(readState(it, aidlcTools.stateField))).filter(Boolean),
  audit: {
    rowsTotal: rows.length,
    rowsInWindow: winRows.length,
    counts: shaper.keys(counts, (k) => shaper.event(k)),
    problems: problems.slice(-300).map((r) => shaper.problem(r)),
    absence: absenceSignals(runRows).map((a) => shaper.absence(a)),
  },
  hooks: shaper.hooks(health),
  sessionsFolder: readSessionsFolder(project),
  transcripts: transcripts.map((t) => shaper.transcript(t)),
  replies: { ...replies, notRecorded: replies.notRecorded.map((n) => ({ ...n, ts: time((n as { ts?: string }).ts) })) },
  otherStores: editorStores(project),
  doctor: { ...doctor, findings: doctor.findings.map((f) => shaper.doctorFinding(f)) },
  // Where the secret rules came from (the project's AI-DLC install), or null: the check then reads with its own rules only.
  secretRules: secretRules && secretFrom ? relative(project, secretFrom) : null,
  knownGaps: [
    "Some guard refusals write no audit row (upstream issue #2706); the tool's own log is then the only trace.",
    "When the audit lock is busy a blocked row can be dropped; only a line in the hook's drops file remains.",
    "Files written by shell commands get no audit row.",
    "Hooks that never ran leave nothing but missing heartbeat files.",
    "Kiro keeps hook names but not the refusal text.",
    "VS Code Copilot Chat and Cursor chat stores are not read by this version.",
    "Names that are not AI-DLC's own (a plugin's or the team's stage, agent, sensor, hook) are anonymous labels.",
  ],
};
const safeText = JSON.stringify(redactValue(safe, dict, { ids: true }), null, 2);
writeFileSync(join(out, "safe.json"), safeText);
writeFileSync(join(localDir, "labels.json"), JSON.stringify(shaper.labels, null, 2));
writeFileSync(join(localDir, "prompts.jsonl"), local.prompts.map((p) => JSON.stringify(p)).join("\n"));
writeFileSync(join(localDir, "refusals.jsonl"), local.refusals.map((p) => JSON.stringify(p)).join("\n"));
writeFileSync(join(localDir, "errors.jsonl"), local.errors.map((p) => JSON.stringify(p)).join("\n"));

// The check's own reading of safe.json: a hit is a field this collector shaped wrong, named for the model to
// replace with `<redacted>` before the check can pass.
const safeJsonHits = safeHits(gateContext(out, dict), JSON.parse(safeText));
console.log(
  JSON.stringify(
    {
      ok: safeJsonHits.length === 0,
      out,
      safe: join(out, "safe.json"),
      local: localDir,
      window: safe.window,
      found: {
        problemEvents: problems.length,
        absence: safe.audit.absence.length,
        hookDrops: health.drops.length,
        repliesNotRecorded: replies.notRecorded.length,
        toolsUsed: usedTools,
        versionsMissing,
        transcripts: transcripts.map((t) => `${t.tool}: ${"sessions" in t ? t.sessions : 0} session(s)`),
        doctorFindings: doctor.findings.length,
      },
      safeJsonHits: safeJsonHits.map((h) => ({ field: h.field, reason: h.reason })),
    },
    null,
    2,
  ),
);
