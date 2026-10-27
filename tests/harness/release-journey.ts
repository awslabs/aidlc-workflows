// release-journey.ts - what a person does on day one with a tool, run live
// before each release (#1345): the Copilot lane in the Full Suite and the
// Kiro CLI pass on a signed-in machine (once on each Kiro tree) drive the same
// journey.
//
// The person's own small project (a greeter with a bug, committed), AI-DLC
// copied in from the copy runtime and set up with `config --from`, doctor,
// then three lines typed as the person: the documented first step, "1" at the
// plan question, "Approve" at Reverse Engineering's approval.
//
// Pass/fail reads only what AI-DLC recorded (the person's message records, the
// plan question's request record, the work record, the audit), doctor, and the
// person's files, which stay as they were until their pick of a plan starts the
// work (the golden journeys' own check), never the agent's prose. A message
// record for every line the person typed is the proof that the tool ran
// AI-DLC's hooks: the human-turn hook writes it.

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyChannelOmits, projectionFiles } from "../../core/tools/aidlc-distribution.ts";
import { auditBlockField, readAuditShardEvents } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { REPO_ROOT } from "./fixtures.ts";
import { auditRows, filesBeforePlanProblems, type GoldenRun, sourceListing } from "./golden-journey.ts";
import { expectPersonFirst } from "./person-turns.ts";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "./test-budget.ts";

export type ReleaseJourneyHarness = "copilot" | "kiro" | "kiro-ide";

/** The lines the person types, in order. */
export const RELEASE_JOURNEY_TURNS = [
  "/aidlc fix the greeter: it says hello instead of greeting the person by name",
  "1",
  "Approve",
] as const;
/** The words of the first line after `/aidlc`: what the plan question is for. */
export const RELEASE_JOURNEY_REQUEST = RELEASE_JOURNEY_TURNS[0].replace(/^\/aidlc /, "");
/** The stage the person approves. */
export const RELEASE_JOURNEY_STAGE = "reverse-engineering";

const TOOL_DIRS: Record<ReleaseJourneyHarness, string> = { copilot: ".aidlc", kiro: ".kiro", "kiro-ide": ".kiro" };
// Both Kiro trees run in Kiro CLI; the tree in brackets tells the two lines apart.
const TOOL_NAMES: Record<ReleaseJourneyHarness, string> = { copilot: "Copilot CLI", kiro: "Kiro CLI", "kiro-ide": "Kiro CLI" };

export interface ReleaseJourneyProject {
  harness: ReleaseJourneyHarness;
  /** Temporary root holding runtime/, the project and any scratch homes. */
  root: string;
  /** The copy runtime folder `config --from` reads (runtime/<harness>/ inside). */
  runtime: string;
  proj: string;
}

/** The project as the person's first line finds it: their files and the audit's length, as a golden journey keeps them. */
export type ReleaseJourneyStart = Pick<ReleaseJourneyProject, "proj"> & Pick<GoldenRun, "files" | "start">;

function git(proj: string, args: string[]): void {
  const result = spawnSync("git", ["-c", "user.name=Person", "-c", "user.email=person@example.com", ...args], {
    cwd: proj, encoding: "utf8",
    timeout: remainingOperationTimeoutMs(NATIVE_FIXTURE_SETUP_TIMEOUT_MS, { phase: "release journey git" }),
  });
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr}`);
}

/** Run one of the project's own AI-DLC commands the way the person does. */
export function aidlcCommand(
  project: ReleaseJourneyProject, args: string[], env: NodeJS.ProcessEnv = process.env,
): { status: number | null; out: string } {
  const result = spawnSync(process.execPath, [join(project.proj, TOOL_DIRS[project.harness], "tools", "aidlc.ts"), ...args], {
    cwd: project.proj, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    timeout: remainingOperationTimeoutMs(NATIVE_FIXTURE_SETUP_TIMEOUT_MS, { phase: `release journey ${args[0]}` }),
  });
  return { status: result.status, out: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

/** The person's own small project, committed: a greeter that prints `hello` where the README says `Hello, <name>!`. */
export function seedGreeter(proj: string): void {
  mkdirSync(join(proj, "src"), { recursive: true });
  mkdirSync(join(proj, "test"), { recursive: true });
  writeFileSync(join(proj, "README.md"), "# greeter\n\nA tiny command-line greeter: `node src/app.js Ada` should print `Hello, Ada!`.\n");
  writeFileSync(join(proj, "package.json"), `${JSON.stringify({
    name: "greeter", version: "0.1.0", private: true, scripts: { start: "node src/app.js", test: "node test/app.test.js" },
  }, null, 2)}\n`);
  writeFileSync(join(proj, "src", "app.js"), "const name = process.argv[2];\nconsole.log('hello');\n");
  writeFileSync(join(proj, "test", "app.test.js"),
    "const { execFileSync } = require('node:child_process');\n" +
    "const out = execFileSync('node', ['src/app.js', 'Ada']).toString().trim();\n" +
    "if (out !== 'Hello, Ada!') { console.error('expected Hello, Ada! got ' + out); process.exit(1); }\n" +
    "console.log('ok');\n");
  git(proj, ["init", "-q"]);
  git(proj, ["add", "README.md", "package.json", "src", "test"]);
  git(proj, ["commit", "-qm", "greeter with the bug"]);
}

/**
 * The person's project with AI-DLC installed through the copy channel: the
 * runtime is dist/<harness> without the files a copy leaves out, copied over
 * the project, then `config --from` and doctor, as the install guide says.
 * Its files and audit are read last, as the person's first line finds them.
 */
export function setupReleaseJourneyProject(
  harness: ReleaseJourneyHarness, env: NodeJS.ProcessEnv = process.env,
): ReleaseJourneyProject & ReleaseJourneyStart & { setup: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `release-journey-${harness}-`)));
  const runtime = join(root, "runtime");
  const shipped = join(REPO_ROOT, "dist", harness);
  cpSync(shipped, join(runtime, harness), { recursive: true });
  for (const path of copyChannelOmits(projectionFiles(shipped).descriptor)) {
    rmSync(join(runtime, harness, path), { force: true });
  }
  const proj = join(root, "proj");
  seedGreeter(proj);
  cpSync(join(runtime, harness), proj, { recursive: true });
  const project = { harness, root, runtime, proj };
  const config = aidlcCommand(project, ["config", "--from", runtime, "--harness", harness, "--yes"], env);
  if (config.status !== 0) throw new Error(`config --from failed (${config.status}):\n${config.out.slice(-3000)}`);
  const doctor = aidlcCommand(project, ["doctor"], env);
  if (doctor.status !== 0) throw new Error(`doctor failed after setup (${doctor.status}):\n${doctor.out.slice(-3000)}`);
  git(proj, ["add", "-A"]);
  git(proj, ["commit", "-qm", "AI-DLC install"]);
  return { ...project, files: sourceListing(proj), start: auditRows(proj).length, setup: `${config.out}\n${doctor.out}` };
}

interface DoctorCheck { pass: boolean; severity?: string; label: string; fix?: string }

/** Doctor's checks, read from its JSON report. */
export function doctorChecks(project: ReleaseJourneyProject, env: NodeJS.ProcessEnv = process.env): DoctorCheck[] {
  const doctor = aidlcCommand(project, ["doctor", "--json"], env);
  try {
    return (JSON.parse(doctor.out.slice(doctor.out.indexOf("{"))) as { data: { checks: DoctorCheck[] } }).data.checks;
  } catch {
    throw new Error(`doctor --json did not report (${doctor.status}):\n${doctor.out.slice(-3000)}`);
  }
}

/** The lines AI-DLC's human-turn hook recorded as the person's, oldest first. */
export function recordedPersonLines(proj: string): string[] {
  const dir = join(proj, "aidlc", ".aidlc-sessions", "messages");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.endsWith(".json"))
    .map((name) => JSON.parse(readFileSync(join(dir, name), "utf8")) as { at?: string; text?: string })
    .sort((a, b) => String(a.at).localeCompare(String(b.at)))
    .map((record) => String(record.text ?? ""));
}

interface RequestRecord { text?: string }

function requestRecords(proj: string): RequestRecord[] {
  const dir = join(proj, "aidlc", ".aidlc-sessions", "questions");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.endsWith(".json"))
    .map((name) => JSON.parse(readFileSync(join(dir, name), "utf8")) as RequestRecord);
}

function workRecords(proj: string): Array<{ scope?: string }> {
  const file = join(proj, "aidlc", "spaces", "default", "intents", "intents.json");
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) as Array<{ scope?: string }> : [];
}

function stageEvents(proj: string, event: string): number {
  let rows: ReturnType<typeof readAuditShardEvents> = [];
  try {
    rows = readAuditShardEvents(proj);
  } catch {
    return 0;
  }
  return rows.filter((row) => row.event === event && auditBlockField(row.block, "Stage") === RELEASE_JOURNEY_STAGE).length;
}

/** AI-DLC started work before the person answered the plan question (turn 1). */
function ranAhead(proj: string, turn: number): boolean {
  return turn === 1 && workRecords(proj).length > 0;
}

/** Check the journey after the person's turn `turn` (1-based), typed `line`, and add what is wrong to the report. */
export function checkReleaseJourneyTurn(report: ReleaseJourneyReport, project: ReleaseJourneyStart, turn: number, line: string): void {
  if (ranAhead(project.proj, turn)) report.ranAhead = true;
  report.problems.push(...releaseJourneyProblems(project, turn).map((problem) => `after "${line}": ${problem}`));
}

/** A journey where AI-DLC ran ahead of the person fails as a PersonTurnError, which is never retried. */
export function expectPersonFirstInJourney(report: ReleaseJourneyReport): void {
  expectPersonFirst(report.ranAhead !== true, report.problems.join("\n"));
}

/**
 * What is wrong after the person's turn `turn` (1-based), in plain words; empty
 * when the journey is where it should be. Every turn checks that each line
 * typed so far was recorded as the person's (the hooks ran), and that their
 * files are as they were until their pick started the work.
 */
export function releaseJourneyProblems(project: ReleaseJourneyStart, turn: number): string[] {
  const { proj } = project;
  const problems: string[] = [];
  const recorded = recordedPersonLines(proj);
  for (const line of RELEASE_JOURNEY_TURNS.slice(0, turn)) {
    if (!recorded.includes(line)) problems.push(`"${line}" has no message record: the tool did not run AI-DLC's hooks for it`);
  }
  problems.push(...filesBeforePlanProblems(proj, project));
  if (turn === 1) {
    if (!requestRecords(proj).some((record) => record.text === RELEASE_JOURNEY_REQUEST)) {
      problems.push("AI-DLC has no request for the person's words, so no plan question was asked for them");
    }
    if (ranAhead(proj, turn)) problems.push("work was started before the person answered the plan question");
  }
  if (turn >= 2) {
    if (!workRecords(proj).some((record) => record.scope === "bugfix")) problems.push("\"1\" did not start the bugfix plan the question offered");
    if (!stageEvents(proj, "STAGE_AWAITING_APPROVAL")) problems.push("Reverse Engineering did not reach its approval question");
  }
  if (turn >= 3 && stageEvents(proj, "GATE_APPROVED") !== 1) problems.push("\"Approve\" did not approve Reverse Engineering once");
  return problems;
}

/** What AI-DLC recorded, kept in a failed run's report: the project goes with its temporary folder. */
export function releaseJourneyEvidence(proj: string): Record<string, unknown> {
  let audit: string[] = [];
  try {
    audit = readAuditShardEvents(proj).map((row) => `${row.event} ${auditBlockField(row.block, "Stage") ?? ""}`.trim());
  } catch {
    // No audit yet.
  }
  return { recordedLines: recordedPersonLines(proj), requests: requestRecords(proj), work: workRecords(proj), audit };
}

/** Doctor after the journey: it must not report that the hooks never ran. */
export function hooksRanProblems(checks: DoctorCheck[]): string[] {
  return checks.filter((check) => !check.pass &&
    (check.label.startsWith("AIDLC hooks have not run in this project yet") || check.label.startsWith("Hook heartbeat data")))
    .map((check) => `doctor says "${check.label}"`);
}

export interface ReleaseJourneyReport {
  harness: ReleaseJourneyHarness;
  toolVersion: string;
  turns: Array<{ line: string; seconds: number }>;
  /** Tool-specific counts: hook runs by kind, tokens, credits. */
  extra: Record<string, unknown>;
  problems: string[];
  /** AI-DLC started work before the person answered the plan question. */
  ranAhead?: boolean;
}

/**
 * Keep the run's report beside its logs and print the one line a maintainer
 * pastes into the release record.
 */
export function writeReleaseJourneyReport(report: ReleaseJourneyReport): string {
  const minutes = (report.turns.reduce((sum, turn) => sum + turn.seconds, 0) / 60).toFixed(1);
  const commit = sourceCommit();
  const tree = report.harness === "copilot" ? "" : ` (${report.harness})`;
  const line = `${TOOL_NAMES[report.harness]} ${report.toolVersion}${tree} release journey${commit ? ` on ${commit}` : ""}: ` +
    `${report.problems.length ? "FAIL" : "PASS"} (${minutes} min of turns${
      Object.entries(report.extra).filter(([, value]) => typeof value === "number").map(([key, value]) => `, ${value} ${key}`).join("")})`;
  const dir = process.env.AIDLC_TEST_LOG_DIR;
  if (dir) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `release-journey-${report.harness}.json`), `${JSON.stringify({ ...report, line }, null, 2)}\n`);
  }
  console.log(line);
  return line;
}

/**
 * Run a journey and write its report, also when a step throws: the step that
 * stopped it becomes a problem first, so the pasted line never says PASS for
 * a journey that ended before its checks ran.
 */
export function runReleaseJourney(report: ReleaseJourneyReport, journey: () => void): void {
  try {
    journey();
  } catch (error) {
    report.problems.push(`the journey stopped: ${(error instanceof Error ? error.message : String(error)).split("\n")[0]}`);
    throw error;
  } finally {
    writeReleaseJourneyReport(report);
  }
}

// The commit the journey's AI-DLC tree was built from. A CI live leg runs in a
// snapshot of the checkout whose HEAD is not the tested commit (the run names
// that), so the line leaves it out there.
function sourceCommit(): string | undefined {
  if (process.env.GITHUB_ACTIONS === "true") return undefined;
  const result = spawnSync("git", ["rev-parse", "--short=12", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : undefined;
}
