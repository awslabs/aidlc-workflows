// own-file-moves.ts - the loop check of a whole scope run, with no model.
//
// A scope run (tests/harness/scope-run.ts) on Claude Code's own hook wiring is
// walked once, and the project is copied at every point the agent hands the
// turn to the person. From each copy the agent makes one move: it changes one
// file the open stage produced (its traceability record first, as an agent
// fixing a review finding does), then shows the step again with the call that
// showed it, or runs `next`. Every command the engine hands after that (a
// print's, a refusal's named step, a recovery question's remedy) is taken as
// the stand-in takes it. The move passes when the person is asked again or the
// work moves on; a refusal that comes back after its step (ScopeRunDeadlock),
// a refusal with no step, or 40 steps without either is a failure.
//
// The copies keep each file's modification time to the fraction of a
// millisecond: the engine binds the strict Reverse Engineering handoff to it.

import { afterAll, describe, expect, test } from "bun:test";
import {
  copyFileSync, existsSync, linkSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, symlinkSync,
  utimesSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { writeSessionPidEntry } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { cleanupTestProject } from "./fixtures.ts";
import {
  AgentStandIn, cleanupScopeProjects, clip, createScopeProject, declaredScope, type Directive, PersonScript, recoveryAsk,
  REMEDY_PREFERENCE, SCOPE_RUN_TIMEOUT_MS, ScopeHost, ScopeRunDeadlock, ScopeRunRefused, ScopeRunStuck, scopeScratchDir,
} from "./scope-run.ts";

export type Policy = "off" | "relaxed" | "strict";

export interface WalkSpec {
  scope: string;
  policy: Policy;
  units?: string[];
  /** Units built stage by stage: the person asks for it once Units Generation is approved. */
  stageMajor?: boolean;
}

/** Claude Code as its settings.json wires it: every Bash, Write and Task call goes through the guard-tool-call group. */
class ClaudeCodeHost extends ScopeHost {
  constructor(proj: string) {
    super(proj);
    this.fullHost = true;
  }
  protected override preTool(tool: string, input: Record<string, unknown>): void {
    const res = this.hook("guard-tool-call", { hook_event_name: "PreToolUse", tool_name: tool, tool_input: input });
    if (res.status !== 2) return;
    this.refusals.push(`${tool} ${clip(JSON.stringify(input), 200)}: ${clip(res.stderr, 600)}`);
    throw new ScopeRunRefused(`the guard refused ${tool} ${clip(JSON.stringify(input), 200)}`, res.stderr);
  }
}

/** One point where the agent handed the turn to the person, as the walk kept it. */
export interface HandOff {
  dir: string;
  what: string;
  stage: string;
  unit: string | null;
  session: string;
  /** The call that showed this step to the person, if one did. */
  reshow: string | null;
  /** What the open stage's last step said it produces. */
  produces: string[];
  reviews: Array<[string, { reviewer: string; iteration: number }]>;
  worked: Directive[];
}

/** What the stand-in keeps to itself; a copy carries it over to the next stand-in. */
type StandInInside = { unitInHand: string | null; reviews: Map<string, { reviewer: string; iteration: number }> };

/** The calls that show the person a step. */
const SHOWS = /\borchestrate(?:\.ts)? report\b.*--result (?:awaiting-approval|revised)\b|\blog decision\b|\bbolt checkpoint\b.*--action ask\b/;

/** A copy of a project; git objects are hard links, since they never change. */
function copyProject(src: string, dst: string, rel = ""): void {
  mkdirSync(dst, { recursive: true });
  for (const name of readdirSync(src)) {
    const here = rel ? `${rel}/${name}` : name;
    const from = join(src, name);
    const to = join(dst, name);
    const stat = lstatSync(from);
    if (stat.isSymbolicLink()) symlinkSync(readlinkSync(from), to);
    else if (stat.isDirectory()) copyProject(from, to, here);
    else if (here.startsWith(".git/objects/")) linkSync(from, to);
    else {
      copyFileSync(from, to);
      utimesSync(to, stat.atimeMs / 1000, stat.mtimeMs / 1000);
    }
  }
}

/** Drive the scope to done and keep a copy at every gate, and at the first of every other question per stage and Unit. */
export function walk(spec: WalkSpec): HandOff[] {
  const { proj } = createScopeProject("code");
  const host = new ClaudeCodeHost(proj);
  let shown: string | null = null;
  const bash = host.bash.bind(host);
  host.bash = (line: string) => {
    if (SHOWS.test(line)) shown = line;
    return bash(line);
  };
  const handOffs: HandOff[] = [];
  const kept = new Set<string>();
  class Walker extends AgentStandIn {
    override askPerson(what: string, stage: string, question: string, options: string[], words: string): string {
      const inside = this as unknown as StandInInside;
      const key = `${what} ${stage} ${inside.unitInHand ?? ""}`;
      if (what === "approval" || !kept.has(key)) {
        kept.add(key);
        const dir = join(scopeScratchDir("own-file-state-"), "proj");
        copyProject(proj, dir);
        const own = [...this.worked].reverse()
          .find((d) => d.stage === stage && (inside.unitInHand === null || d.unit === inside.unitInHand || d.unit === undefined));
        handOffs.push({
          dir, what, stage, unit: inside.unitInHand, session: this.host.session, reshow: shown,
          produces: (own?.produces as string[] | undefined) ?? [], reviews: [...inside.reviews.entries()],
          worked: this.worked.slice(-6),
        });
      }
      shown = null;
      return super.askPerson(what, stage, question, options, words);
    }
  }
  const agent = new Walker(host, new PersonScript(host), {
    units: spec.units,
    followRefusals: true,
    afterApproval: spec.stageMajor
      ? (stage, a) => {
        if (stage !== "units-generation") return undefined;
        a.person.say("build it stage by stage: every Unit through each stage before the next");
        const set = a.host.bash(`bun ${a.host.dir}/tools/aidlc-state.ts set-construction-iteration stage-major --message ${a.latestMessageId()}`);
        if (set.status !== 0) a.fail(`stage-major was refused: ${set.stderr || set.stdout}`);
        return undefined;
      }
      : undefined,
  });
  // The scope's own Guard Policy is the stock run: no flag for it.
  const policy = declaredScope(spec.scope).guardPolicy === spec.policy ? [] : ["--guard-policy", spec.policy];
  agent.drive(agent.begin(`build the ${spec.scope} work`, ["--scope", spec.scope, ...policy]));
  return handOffs;
}

class Reached extends Error {}

/** The file of the open stage the agent changes: its traceability record, else its first document, else its first file. */
function ownFile(at: HandOff, proj: string): string | null {
  const files = at.produces.filter((p) => existsSync(join(proj, p)) && !p.endsWith("-questions.md"));
  return files.find((p) => p.endsWith("traceability.json")) ?? files.find((p) => p.endsWith(".md")) ?? files[0] ?? null;
}

function changed(path: string, text: string): string {
  if (path.endsWith(".json")) return `${JSON.stringify({ ...(JSON.parse(text) as object), note: "fixed after the review" }, null, 2)}\n`;
  return `${text}\n\nA small fix after the review.\n`;
}

export type Route = "reshow" | "next";

export interface Outcome {
  ok: boolean;
  /** Null when the move does not apply here: the stage wrote no file, or no call showed the step. */
  file: string | null;
  /** How the move ended, in one line. */
  end: string;
  /** The last host calls, when it failed. */
  calls: string[];
  /** Every refusal met, with the step the stand-in took after it. */
  refusals: string[];
}

/** From one hand-off: the agent changes its own file, then takes the route; every step the engine names after it is taken. */
export function explore(at: HandOff, route: Route): Outcome {
  const root = scopeScratchDir("own-file-move-");
  const proj = join(root, "proj");
  copyProject(at.dir, proj);
  try {
    const file = ownFile(at, proj);
    if (!file || (route === "reshow" && !at.reshow)) return { ok: true, file: null, end: "n/a", calls: [], refusals: [] };
    const host = new ClaudeCodeHost(proj);
    host.session = at.session;
    writeSessionPidEntry(proj, process.pid, at.session);
    (host as unknown as { sessions: Set<string> }).sessions.add(at.session);
    const start = `${at.stage} ${at.unit ?? ""}`;
    let steps = 0;
    class Mover extends AgentStandIn {
      // Any question to the person ends the move: the work is back with them. A
      // recovery question whose remedy the agent takes is followed.
      override askPerson(what: string, stage: string, question: string, options: string[], words: string): string {
        if (what !== "guard recovery") throw new Reached(`asked ${what} at ${stage}`);
        return super.askPerson(what, stage, question, options, words);
      }
      // A recovery question whose only remedies are the person's (Request Changes with their words, lowering the
      // check) is back with them, as any question is; the base stand-in stops there as its own limit.
      override followRefusal(said: string): void {
        const ask = recoveryAsk(said);
        const now = ((ask?.remedies as { op: string; executableNow?: boolean }[] | undefined) ?? []).filter((r) => r.executableNow === true);
        if (ask && now.length > 0 && !now.some((r) => REMEDY_PREFERENCE.includes(r.op))) throw new Reached("the person is asked how to go on");
        super.followRefusal(said);
      }
      // A print that ends the turn hands it to the person; the base stand-in would run the command meant for after their reply.
      override actOnPrint(d: Directive): boolean {
        if (/\bend (?:your|the) turn\b/i.test(String(d.message ?? ""))) throw new Reached("a print handed the turn to the person");
        return super.actOnPrint(d);
      }
      override ask(d: Directive): void {
        if (d.ask_type === "guard-recovery") this.followRefusal(JSON.stringify(d));
        else super.ask(d);
      }
      // A gate shown again can carry completion_only beside human_completion_required (which one wins is open: the
      // drift audit's row 27). The engine's report takes only the person's choice there, so the gate is shown to
      // them; the base stand-in reports the approval itself and goes round, 12 false loops at classic stage by stage.
      override runStage(d: Directive): void {
        const policy = d.construction_policy as Record<string, unknown> | undefined;
        if (d.gate_only === true && policy?.completion_only === true && policy.human_completion_required === true) this.gate(d);
        else super.runStage(d);
      }
    }
    const agent = new Mover(host, new PersonScript(host), {
      followRefusals: true,
      until: (d) => {
        if (++steps > 40) throw new Reached("40 steps without the person or the next stage");
        if (d.kind === "done") return true;
        const key = `${String(d.stage ?? "")} ${typeof d.unit === "string" ? d.unit : ""}`;
        if (d.kind === "run-stage" && d.gate_only !== true && key !== start) throw new Reached(`moved on to ${key.trim()}`);
        return false;
      },
    });
    const inside = agent as unknown as StandInInside;
    for (const [k, v] of at.reviews) inside.reviews.set(k, v);
    agent.worked.push(...at.worked);
    const take = (call: () => void) => {
      try {
        call();
      } catch (error) {
        if (!(error instanceof ScopeRunRefused) || error instanceof ScopeRunDeadlock) throw error;
        agent.followRefusal(error.refusal);
      }
    };
    const failed = (end: string): Outcome => ({
      ok: false, file, end: clip(end, 600), calls: host.trace.slice(-6).map((call) => clip(call, 400)),
      refusals: agent.refusalsMet.map((r) => `${clip(r.said.split("\n")[0], 300)} [took: ${r.took}]`),
    });
    try {
      take(() => host.write(file, changed(file, readFileSync(join(proj, file), "utf-8"))));
      if (route === "reshow") {
        take(() => {
          const res = host.bash(at.reshow!.replace(/--session (\S+)/g, `--session ${host.session}`));
          const out = (() => {
            try {
              return JSON.parse(res.stdout.trim().split("\n").at(-1) ?? "") as Directive;
            } catch {
              return null;
            }
          })();
          if (res.status !== 0 || out?.kind === "error") agent.refused("the call that showed the step, again", `${res.stdout}${res.stderr}`);
          if (out?.kind === "ask" && out.ask_type === "guard-recovery") agent.followRefusal(res.stdout);
        });
      }
      agent.drive(agent.next());
      return { ok: true, file, end: "done", calls: [], refusals: [] };
    } catch (error) {
      if (error instanceof Reached) return error.message.startsWith("40 steps") ? failed(error.message) : { ok: true, file, end: error.message, calls: [], refusals: [] };
      if (!(error instanceof ScopeRunStuck)) throw error;
      return failed(error.message.split("\n")[0]);
    }
  } finally {
    cleanupTestProject(root);
  }
}

export interface Explored {
  at: HandOff;
  route: Route;
  outcome: Outcome;
}

/** Every hand-off of a walk: `next` from each, and the call that showed it again from each gate. */
export function exploreWalk(spec: WalkSpec): Explored[] {
  const explored: Explored[] = [];
  for (const at of walk(spec)) {
    for (const route of at.what === "approval" ? ["reshow", "next"] as const : ["next"] as const) {
      const outcome = explore(at, route);
      if (outcome.file !== null) explored.push({ at, route, outcome });
    }
    cleanupTestProject(dirname(at.dir));
  }
  return explored;
}

/** One line per failed move, naming the test and how to rerun it, where, what the agent did and what came back. */
export function moveProblems(testFile: string, spec: WalkSpec, explored: Explored[]): string[] {
  const stem = basename(testFile).replace(/\.test\.ts$/, "");
  const rerun = `bash tests/run-tests.sh --integration --no-llm --filter '^${stem}$'`;
  return explored.filter((e) => !e.outcome.ok).map(({ at, route, outcome }) =>
    `[${stem}; rerun: ${rerun}] ${spec.scope}, Guard Policy ${spec.policy}: at ${at.stage}${at.unit ? ` for ${at.unit}` : ""} ` +
    `(the person was asked: ${at.what}), the agent changed ${outcome.file} and ${route === "next" ? "ran next" : `ran ${at.reshow} again`}: ` +
    `${outcome.end}\n  last host calls:\n    ${outcome.calls.join("\n    ")}` +
    `${outcome.refusals.length ? `\n  refusals met:\n    ${outcome.refusals.join("\n    ")}` : ""}`);
}

/** The test file's suite: one test per Guard Policy, each a walk and every move from it. */
export function ownFileMoveSuite(testFile: string, spec: Omit<WalkSpec, "policy">, policies: Policy[]): void {
  describe(`the agent changes its own file at every hand-off of ${spec.scope}${spec.stageMajor ? " built stage by stage" : ""}`, () => {
    afterAll(cleanupScopeProjects);
    for (const policy of policies) {
      test(`Guard Policy ${policy}: the person is asked again or the work moves on, and no refusal comes back after its step`, () => {
        const walkSpec = { ...spec, policy };
        const explored = exploreWalk(walkSpec);
        // Not vacuous: gates were reached, and the Code Generation gate with its traceability record changed.
        expect(explored.some((e) => e.at.what === "approval")).toBe(true);
        expect(explored.some((e) => e.at.what === "approval" && e.at.stage === "code-generation" && e.outcome.file?.endsWith("traceability.json"))).toBe(true);
        expect(moveProblems(testFile, walkSpec, explored)).toEqual([]);
      }, SCOPE_RUN_TIMEOUT_MS);
    }
  });
}
