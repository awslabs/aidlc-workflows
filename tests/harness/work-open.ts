// work-open.ts - work the person left waiting at a gate, carried across an
// AI-DLC update.
//
// scripts/ci-update-from-previous.ts sets up a project per tool with the last
// release. In each, the person starts a bugfix, answers the Requirements
// questions and stops for the day at the open Requirements gate. Then they run
// `aidlc update` and `aidlc config`, open a new chat, type `/aidlc --resume`
// and approve. openWork drives the first half on the tool's host
// (scope-hosts.ts) through the person's installed `aidlc`, and resumeWork the
// second; resumeWork says what the person lost on the way, if anything: the
// gate, an answer asked for again, their approval, the next stage or a file.
//
// The check runs this file once per project, side by side (see the end of the
// file), with the machine folder of the person's install, or `copy` for a
// project that runs its own copied tool: the person's work opens, the file
// writes <harness>.parked and waits for the check to write `updated`, then
// carries the work on and writes <harness>.json with what the person lost.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type HostName, hostFor, NativeScopeHost, OpencodeScopeHost } from "./scope-hosts.ts";
import { AgentStandIn, auditEvents, clip, type Directive, field, PersonScript, type ScopeHost } from "./scope-run.ts";

export const GATE = "requirements-analysis";
export const NEXT_STAGE = "code-generation";
const REQUEST = "fix the todo list: an empty title can be saved";

export interface OpenWork {
  harness: "claude" | HostName;
  host: ScopeHost;
  person: PersonScript;
  agent: AgentStandIn;
  /** What the agent had asked the person, and the stage bodies it had run, when the person stopped. */
  asked: number;
  worked: number;
  /** The top-level paths git did not track when the work began: the release's own setup. */
  setup: string[];
}

/** The person's day on the previous release: a bugfix up to its open Requirements gate, then a stop for the day. */
export function openWork(harness: "claude" | HostName, proj: string, base: NodeJS.ProcessEnv, launcher: string[] | null): OpenWork {
  const setup = untrackedRoots(proj);
  const host = hostFor(harness, proj, base);
  host.launcher = launcher;
  const person = new PersonScript(host);
  const agent = new AgentStandIn(host, person, {
    answers: { stopAt: (stage) => stage === GATE },
    pauseAtStop: true,
    until: (d) => d.kind === "run-stage" && d.stage === NEXT_STAGE,
  });
  const at = agent.drive(agent.begin(REQUEST, ["--scope", "bugfix"]));
  if (agent.parks.length !== 1 || at.stage !== GATE) {
    throw new Error(`the work did not stop at the open ${GATE} gate: the drive ended on ${clip(JSON.stringify(at), 300)}`);
  }
  return { harness, host, person, agent, asked: agent.asked.length, worked: agent.worked.length, setup };
}

/** The person's next chat, on the release they updated to: `/aidlc --resume` and Approve. Returns what they lost. */
export function resumeWork(work: OpenWork): string[] {
  const { agent, host, person } = work;
  let after: Directive;
  try {
    after = agent.resume();
  } catch (error) {
    return [`the person could not carry on their work: ${clip(error instanceof Error ? error.message : String(error), 1500)}`];
  } finally {
    if (host instanceof OpencodeScopeHost) host.dispose();
  }
  return resumeProblems({
    after,
    askedSince: agent.asked.slice(work.asked).map((a) => `${a.what} ${a.stage}`),
    workedSince: agent.worked.slice(work.worked).map((d) => String(d.stage)),
    approvals: auditEvents(host.proj).filter((e) => e.event === "GATE_APPROVED" && field(e.block, "Stage") === GATE)
      .map((e) => field(e.block, "Person Reply")),
    said: person.said,
    unbacked: person.ledger.unbacked(),
    refusals: host.refusals,
    hookFailures: host instanceof NativeScopeHost ? host.hookFailures : [],
    blockedHandoffs: agent.handoffs.filter((h) => h.blocked).map((h) => `${h.what} ${h.stage}: ${clip(h.reason, 300)}`),
    changed: personChanges(host.proj, work.setup),
  });
}

export interface ResumeFacts {
  /** Where the drive stopped after the person approved: the next stage's start. */
  after: Directive;
  /** What the agent asked the person after the update, as "<what> <stage>". */
  askedSince: string[];
  /** The stage bodies the agent ran after the update. */
  workedSince: string[];
  /** The Person Reply of each approval of the gate in the record. */
  approvals: (string | null)[];
  said: string[];
  unbacked: string[];
  refusals: string[];
  hookFailures: string[];
  blockedHandoffs: string[];
  changed: string[];
}

export function resumeProblems(facts: ResumeFacts): string[] {
  const problems: string[] = [];
  if (facts.workedSince.length > 0) {
    problems.push(`after the update the agent ran ${facts.workedSince.join(", ")} again instead of showing the open ${GATE} gate`);
  }
  const asked = facts.askedSince.filter((a) => a !== `approval ${GATE}`);
  if (asked.length > 0) problems.push(`after the update the person was asked again: ${asked.join("; ")}`);
  if (!facts.askedSince.includes(`approval ${GATE}`)) problems.push(`after the update the person was never shown the open ${GATE} gate`);
  if (facts.approvals.length !== 1) {
    problems.push(`the record holds ${facts.approvals.length} approvals of ${GATE}, not the person's one`);
  } else if (facts.approvals[0] === null || !facts.said.includes(facts.approvals[0])) {
    problems.push(`the approval of ${GATE} records ${JSON.stringify(facts.approvals[0])}, which the person never sent`);
  }
  for (const line of facts.unbacked) problems.push(line);
  if (facts.after.kind !== "run-stage" || facts.after.stage !== NEXT_STAGE) {
    problems.push(`after the approval the next step is ${clip(JSON.stringify(facts.after), 300)}, not ${NEXT_STAGE}`);
  }
  for (const r of facts.refusals) problems.push(`a guard refused a step the engine directed: ${r}`);
  for (const f of facts.hookFailures) problems.push(`a hook failed: ${f}`);
  for (const h of facts.blockedHandoffs) problems.push(`the turn could not end when the person was asked: ${h}`);
  for (const c of facts.changed) problems.push(`a file of the person's changed: ${c}`);
  return problems;
}

/**
 * The person's `aidlc`, as the argv the agent's commands and the drive's hooks
 * run. On Windows it is the active aidlc.exe itself: its launchers start
 * PowerShell for every command, and the check's own hook runs go through them.
 */
export function installedAidlc(machine: string, windows = process.platform === "win32"): string[] {
  return windows ? [readFileSync(join(machine, "active-executable"), "utf-8").trim()] : [join(machine, "bin", "aidlc")];
}

// ---------------------------------------------------------------------------
// The person's files
// ---------------------------------------------------------------------------

/** The text of a file with every part AI-DLC marks as its own taken out, as lines with something on them. */
export function outsideMarkedParts(text: string): string[] {
  const kept: string[] = [];
  let inside: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    const begin = /^(?:#|<!--) BEGIN AI-DLC:(\S+?)(?: -->)?$/.exec(line.trim());
    if (inside === null && begin) {
      inside = begin[1];
      continue;
    }
    if (inside !== null) {
      if (new RegExp(`^(?:#|<!--) END AI-DLC:${inside.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?: -->)?$`).test(line.trim())) inside = null;
      continue;
    }
    if (line.trim()) kept.push(line.trimEnd());
  }
  return kept;
}

function git(proj: string, ...args: string[]): string {
  const r = spawnSync("git", ["-c", "core.quotepath=off", ...args], { cwd: proj, encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
}

/** The top-level paths git does not track: what a release's setup and the work added. */
export function untrackedRoots(proj: string): string[] {
  const roots = git(proj, "status", "--porcelain", "--untracked-files=normal").split("\n")
    .filter((l) => l.startsWith("?? ")).map((l) => l.slice(3).split("/")[0]);
  return [...new Set(roots)].sort();
}

/**
 * What changed of the person's since their last commit: a file they committed
 * that changed outside AI-DLC's marked parts, or a new top-level path that is
 * neither `aidlc/` nor one the release's setup made.
 */
export function personChanges(proj: string, setup: string[]): string[] {
  const changes: string[] = [];
  for (const path of git(proj, "diff", "--name-only", "HEAD").split("\n").filter(Boolean)) {
    let now: string | null = null;
    try {
      now = readFileSync(join(proj, path), "utf-8");
    } catch {
      changes.push(`${path} is gone`);
      continue;
    }
    const before = git(proj, "show", `HEAD:${path}`);
    if (JSON.stringify(outsideMarkedParts(now)) !== JSON.stringify(outsideMarkedParts(before))) changes.push(`${path} changed outside AI-DLC's marked part`);
  }
  for (const root of untrackedRoots(proj)) {
    if (root !== "aidlc" && !setup.includes(root)) changes.push(`${root} appeared`);
  }
  return changes;
}

// ---------------------------------------------------------------------------
// One project's work, run by the check
// ---------------------------------------------------------------------------

/** What one project's run wrote for the check: where it got to, and what the person lost. */
export interface WorkResult {
  harness: string;
  stage: "open" | "resume";
  problems: string[];
}

/** The person's `aidlc` for a machine folder, or none on a copied project, whose agent runs `bun <dir>/tools/...`. */
export function launcherFor(machine: string): string[] | null {
  return machine === "copy" ? null : installedAidlc(machine);
}

function work(argv: string[]): number {
  const [harness, proj, machine, signals, until] = argv;
  const done = (stage: WorkResult["stage"], problems: string[]) => {
    writeFileSync(join(signals, `${harness}.json`), `${JSON.stringify({ harness, stage, problems } satisfies WorkResult)}\n`);
    return 0;
  };
  const deadline = Number(until);
  let open: OpenWork;
  try {
    open = openWork(harness as "claude" | HostName, proj, process.env, launcherFor(machine));
  } catch (error) {
    return done("open", [error instanceof Error ? error.message : String(error)]);
  }
  writeFileSync(join(signals, `${harness}.parked`), "");
  while (!existsSync(join(signals, "updated"))) {
    if (Date.now() >= deadline) return done("resume", ["the update never came, so the work was not carried on"]);
    Bun.sleepSync(250);
  }
  // The update moved the machine to the candidate's binary; a copy refreshed its own tool in place.
  open.host.launcher = launcherFor(machine);
  return done("resume", resumeWork(open));
}

if (import.meta.main) process.exit(work(process.argv.slice(2)));
