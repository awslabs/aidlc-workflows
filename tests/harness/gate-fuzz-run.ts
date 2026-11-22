#!/usr/bin/env bun
// gate-fuzz-run.ts - the long mode of the engine-level gate fuzz (gate-fuzz.ts), and the replay of one run.
//
//   bun tests/harness/gate-fuzz-run.ts --seeds 2000 --jobs 3 --out DIR
//       [--seed S] [--most 40] [--hosts claude,codex,...] [--policies strict,relaxed,off]
//       [--questions stage-gate,code-plan,...] [--walks bugfix,feature,...] [--walk-hosts claude,...] [--host-scopes bugfix,classic]
//       [--i8-every 4] [--shrink] [--unattended-every 10] [--update-from <older release's dist folder>]
//   bun tests/harness/gate-fuzz-run.ts --replay '<run id>' [--out DIR]
//   bun tests/harness/gate-fuzz-run.ts --report-only --out DIR      (the report of a run's results so far)
//
// Each seed picks a state (a question the engine knows, on a host, under a Guard Policy; or a point a walked scope
// waited on the person) and a run of steps; the run and its twin (the same steps, other words of the same shapes) are
// played and checked. Every I8-th seed is also played under the other two policies. Results land in DIR as
// results.jsonl (one line per seed), failures.jsonl and REPORT.md: the failures grouped by invariant and by the source
// they point at, with a count and one replayable run id each (shrunk when --shrink is given). Jobs are child
// processes, one seed at a time each.

import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  checkPolicies, checkSeed, cleanupRuns, cleanupStates, FIXTURES, fixtureState, HOST_IDS, type HostId, loadWalk, parseRunId,
  play, type Policy, POLICIES, rng, shrink, type State, stepsFor, walk, type Walk, walkId, type WalkSpec, type Failure,
} from "./gate-fuzz.ts";
import { SKIPPED, UNITS } from "./scope-hosts.ts";
import { REPO_ROOT } from "./fixtures.ts";

interface Args {
  seeds: number;
  seed: number;
  most: number;
  jobs: number;
  out: string;
  hosts: HostId[];
  policies: Exclude<Policy, "default">[];
  questions: string[];
  walks: string[];
  walkHosts: HostId[];
  /** The scopes the other tools' wiring walks (Claude Code walks every scope asked for). */
  hostScopes: string[];
  /** An older release's dist folder: two scopes are walked on it, and each wait answered on this tree. */
  updateFrom: string | null;
  i8Every: number;
  unattendedEvery: number;
  shrink: boolean;
  replay: string | null;
  worker: { index: number; of: number } | null;
  walksOnly: boolean;
}

function parse(argv: string[]): Args {
  const value = (name: string): string | undefined => {
    const at = argv.indexOf(name);
    return at >= 0 ? argv[at + 1] : undefined;
  };
  const list = (name: string, all: readonly string[]) => (value(name)?.split(",").filter(Boolean) ?? [...all]);
  const worker = value("--worker");
  return {
    seeds: Number(value("--seeds") ?? 100),
    seed: Number(value("--seed") ?? 20261022),
    most: Number(value("--most") ?? 40),
    jobs: Number(value("--jobs") ?? 1),
    out: value("--out") ?? join(REPO_ROOT, "tests", "logs", "gate-fuzz", new Date().toISOString().replace(/[:.]/g, "-")),
    hosts: list("--hosts", HOST_IDS) as HostId[],
    policies: list("--policies", POLICIES) as Exclude<Policy, "default">[],
    questions: list("--questions", Object.keys(FIXTURES)),
    walks: value("--walks")?.split(",").filter(Boolean) ?? [],
    walkHosts: list("--walk-hosts", ["claude"]) as HostId[],
    hostScopes: list("--host-scopes", ["bugfix", "classic"]),
    updateFrom: value("--update-from") ?? null,
    i8Every: Number(value("--i8-every") ?? 4),
    unattendedEvery: Number(value("--unattended-every") ?? 10),
    shrink: argv.includes("--shrink"),
    replay: value("--replay") ?? null,
    worker: worker ? { index: Number(worker.split("/")[0]), of: Number(worker.split("/")[1]) } : null,
    walksOnly: argv.includes("--walks-only"),
  };
}

/** The walks the run asks for, walked once and kept in DIR/walks. */
function walks(args: Args): Walk[] {
  const root = join(args.out, "walks");
  mkdirSync(root, { recursive: true });
  const specs: WalkSpec[] = [];
  for (const scope of args.walks) {
    for (const host of args.walkHosts.filter((h) => h === "claude" || args.hostScopes.includes(scope))) {
      for (const policy of host === "claude" ? args.policies : [args.policies[0]]) {
        // Two Units on the scopes that build them, and the skips the scope-host journey uses off Claude Code.
        const spec: WalkSpec = { scope, host, policy, units: ["mvp", "feature", "classic", "enterprise"].includes(scope) ? UNITS : ["core"] };
        if (host !== "claude" && scope === "classic") spec.skip = SKIPPED;
        specs.push(spec);
      }
    }
  }
  // One gate asked for changes three times, so Accept as-is is on offer at the fourth showing.
  if (args.walks.length > 0) specs.push({ scope: "bugfix", host: "claude", policy: args.policies[0], units: ["core"], revise: "requirements-analysis" });
  if (args.updateFrom) {
    for (const scope of ["bugfix", "feature"]) specs.push({ scope, host: "claude", policy: args.policies[0], units: scope === "feature" ? UNITS : ["core"], from: args.updateFrom });
  }
  return specs.flatMap((spec, i) => {
    const dir = join(root, walkId(spec));
    if (existsSync(join(dir, "walk.json"))) return [loadWalk(dir)];
    // A walk job walks its share; the seed jobs after it find every walk on disk.
    if (args.walksOnly && args.worker && i % args.worker.of !== args.worker.index) return [];
    const w = walk(spec, root);
    console.log(`walked ${w.id}: ${w.states.length} waits, ${w.gatesMet.length} gates, ${Math.round(w.ms / 1000)} s${w.stuck ? `, stuck: ${w.stuck.slice(0, 200)}` : ""}`);
    return [w];
  });
}

/** The state a seed plays: a fixture question on a host under a policy, or a walked wait. */
async function stateFor(args: Args, n: number, walked: Walk[]): Promise<{ state: State; seed: number }> {
  const seed = (args.seed + n * 7919) >>> 0;
  const r = rng(seed);
  const pickOf = <T>(list: readonly T[]) => list[Math.floor(r() * list.length)];
  const fromWalk = walked.length > 0 && r() < 0.5;
  if (fromWalk) {
    // A walk recorded before its copies kept the files a tool changes in its own tree is left out.
    const usable = walked.filter((w) => !(w.stuck ?? "").includes("the install tree changed"));
    const w = pickOf(usable.length > 0 ? usable : walked);
    const state = pickOf(w.states);
    if (state) return { state, seed };
  }
  const question = pickOf(args.questions);
  const host = pickOf(args.hosts);
  const policy = pickOf(args.policies);
  const unattended = args.unattendedEvery > 0 && n % args.unattendedEvery === args.unattendedEvery - 1;
  return { state: await fixtureState(question, host, policy, unattended), seed };
}

async function stateById(id: string, args: Args): Promise<State> {
  const fx = /^fx:([^:]+):([^:]+):([^:]+)(:unattended)?$/.exec(id);
  if (fx) return fixtureState(fx[1], fx[2] as HostId, fx[3] as Policy, fx[4] !== undefined);
  const [walkName, n] = id.split("#");
  const dir = join(args.out, "walks", walkName);
  if (!existsSync(join(dir, "walk.json"))) throw new Error(`no walk ${walkName} under ${args.out}/walks: walk it first (--walks)`);
  const state = loadWalk(dir).states.find((s) => s.id === id);
  if (!state) throw new Error(`walk ${walkName} has no state ${n}`);
  return state;
}

interface Result { n: number; id: string; state: string; steps: number; ms: number; failures: Failure[] }
const shrunk = new Set<string>();

async function seedResult(args: Args, n: number, walked: Walk[]): Promise<Result> {
  const { state, seed } = await stateFor(args, n, walked);
  const checked = checkSeed(state, seed, { most: args.most });
  const failures = [...checked.failures];
  if (args.i8Every > 0 && n % args.i8Every === 0 && state.policy !== "default" && state.id.startsWith("fx:")) {
    const steps = stepsFor(state, seed, args.most);
    const byPolicy: Record<string, ReturnType<typeof play>> = { [state.policy]: checked.run };
    for (const policy of POLICIES) if (policy !== state.policy) byPolicy[policy] = play(state, seed, steps, { policy });
    failures.push(...checkPolicies(byPolicy));
  }
  if (args.shrink) {
    for (const failure of failures) {
      if (failure.invariant === "I8" || failure.invariant === "RUN") continue;
      // One shrink per group in a job: the first run that shows a group is the one its replay names.
      const name = `${failure.invariant} ${failure.what.replace(/\\/g, "/").replace(/"[^"]*"/g, '"_"').replace(/\d+/g, "#")}`;
      if (shrunk.has(name)) continue;
      shrunk.add(name);
      const small = shrink(state, seed, failure, { most: args.most, budget: 12 });
      if (small) (failure as Failure & { replay?: string }).replay = small.id;
    }
  }
  cleanupRuns();
  return { n, id: checked.id, state: state.id, steps: checked.steps, ms: checked.ms, failures };
}

function report(args: Args): void {
  const results = readFileSync(join(args.out, "results.jsonl"), "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Result);
  const groups = new Map<string, { invariant: string; what: string; source: string; count: number; seeds: Set<string>; states: Set<string>; replay: string; detail: string }>();
  for (const result of results) {
    for (const f of result.failures as Array<Failure & { replay?: string }>) {
      const k = `${f.invariant}\u0000${f.source}\u0000${f.what}`;
      const g = groups.get(k) ?? { invariant: f.invariant, what: f.what, source: f.source, count: 0, seeds: new Set(), states: new Set(), replay: f.replay ?? result.id, detail: f.detail };
      g.count++;
      g.seeds.add(result.id);
      g.states.add(result.state.replace(/:(strict|relaxed|off|default)(:unattended)?$/, ""));
      groups.set(k, g);
    }
  }
  const failing = results.filter((r) => r.failures.length > 0).length;
  const perInvariant = new Map<string, Set<string>>();
  for (const r of results) for (const f of r.failures) perInvariant.set(f.invariant, (perInvariant.get(f.invariant) ?? new Set()).add(r.id));
  const lines = [
    `# Gate fuzz: ${results.length} seeds, ${failing} with a failure`,
    "",
    `Seed base ${args.seed}, up to ${args.most} steps, hosts ${args.hosts.join(", ")}, policies ${args.policies.join(", ")}${args.walks.length ? `, walks ${args.walks.join(", ")} on ${args.walkHosts.join(", ")}` : ""}.`,
    `Mean ${Math.round(results.reduce((t, r) => t + r.ms, 0) / Math.max(1, results.length) / 100) / 10} s a seed (run and twin).`,
    "",
    "## Seeds failing each invariant",
    "",
    ...["I1", "I2", "I3", "I4", "I5", "I6", "I7", "I8", "I9", "STOP", "RUN"].map((i) => `- ${i}: ${perInvariant.get(i)?.size ?? 0}`),
    "",
    "## Groups (invariant, where it points, what), most seeds first",
    "",
  ];
  // The code path each failure points at (the brief's grouping): its seeds, the invariants it fails, one replay.
  const paths = new Map<string, { seeds: Set<string>; invariants: Set<string>; replay: string }>();
  for (const g of groups.values()) {
    const p = paths.get(g.source || "(none named)") ?? { seeds: new Set(), invariants: new Set(), replay: g.replay };
    for (const seed of g.seeds) p.seeds.add(seed);
    p.invariants.add(g.invariant);
    paths.set(g.source || "(none named)", p);
  }
  lines.push("## By the code path the failure points at", "", "| code path | seeds | invariants | replay |", "|---|---|---|---|");
  for (const [path, p] of [...paths.entries()].sort((a, b) => b[1].seeds.size - a[1].seeds.size)) {
    lines.push(`| ${path} | ${p.seeds.size} | ${[...p.invariants].sort().join(" ")} | \`${p.replay}\` |`);
  }
  lines.push("", "## Groups in full", "");
  for (const g of [...groups.values()].sort((a, b) => b.seeds.size - a.seeds.size)) {
    lines.push(`### ${g.invariant}: ${g.what}`, "", `- Source: ${g.source || "(none named)"}`, `- Seeds: ${g.seeds.size} (${g.count} times); states: ${[...g.states].slice(0, 6).join(", ")}${g.states.size > 6 ? ", ..." : ""}`,
      `- Replay: \`bun tests/harness/gate-fuzz-run.ts --replay '${g.replay}'\``, `- One: ${g.detail.replace(/\n/g, " ").slice(0, 500)}`, "");
  }
  writeFileSync(join(args.out, "REPORT.md"), `${lines.join("\n")}\n`);
  console.log(`report: ${join(args.out, "REPORT.md")} (${results.length} seeds, ${failing} failing, ${groups.size} groups)`);
}

async function main(): Promise<void> {
  const args = parse(process.argv.slice(2));
  mkdirSync(args.out, { recursive: true });
  if (process.argv.includes("--report-only")) {
    // A report of the jobs' results so far, while they run.
    const merged = readdirSync(args.out).filter((f) => /^results-\d+\.jsonl$/.test(f)).map((f) => readFileSync(join(args.out, f), "utf-8")).join("");
    if (merged) writeFileSync(join(args.out, "results.jsonl"), merged);
    report(args);
    return;
  }
  if (args.replay) {
    const { state: id, seed, most, dropped } = parseRunId(args.replay);
    const state = await stateById(id, args);
    const checked = checkSeed(state, seed, { most, dropped });
    const show = { id: checked.id, steps: checked.run.steps.map((s) => ({ i: s.i, label: s.label, chat: s.chat, landed: s.landed, rows: s.rows.map((r) => r.event), refusal: s.refusal?.slice(0, 400) ?? null })), turns: checked.run.turns.map((t) => ({ step: t.step, channel: t.channel, shape: t.shape, text: t.text.slice(0, 200), reply: t.reply })), failures: checked.failures };
    writeFileSync(join(args.out, "replay.json"), JSON.stringify({ ...show, run: { ...checked.run, files: Object.keys(checked.run.files) } }, null, 2));
    console.log(JSON.stringify(show, null, 2));
    console.log(`kept: ${checked.run.proj}`);
    return;
  }
  const passed = process.argv.slice(2).filter((_, i, all) => all[i - 1] !== "--jobs" && all[i] !== "--jobs");
  const jobs = (extra: string[]) => Promise.all(Array.from({ length: args.jobs }, (_, index) => new Promise<void>((resolve) => {
    const child = spawn(process.execPath, [import.meta.path, ...passed, "--out", args.out, ...extra, "--worker", `${index}/${args.jobs}`], { stdio: "inherit" });
    child.on("exit", () => resolve());
  })));
  if (args.jobs > 1 && !args.worker && args.walks.length > 0) await jobs(["--walks-only"]);
  const walked = walks(args);
  if (args.walksOnly) return;
  if (args.worker) {
    for (let n = args.worker.index; n < args.seeds; n += args.worker.of) {
      const result = await seedResult(args, n, walked);
      appendFileSync(join(args.out, `results-${args.worker.index}.jsonl`), `${JSON.stringify(result)}\n`);
    }
    cleanupStates();
    return;
  }
  if (args.jobs > 1) {
    await jobs([]);
    const merged = readdirSync(args.out).filter((f) => /^results-\d+\.jsonl$/.test(f)).map((f) => readFileSync(join(args.out, f), "utf-8")).join("");
    writeFileSync(join(args.out, "results.jsonl"), merged);
  } else {
    writeFileSync(join(args.out, "results.jsonl"), "");
    for (let n = 0; n < args.seeds; n++) {
      const result = await seedResult(args, n, walked);
      appendFileSync(join(args.out, "results.jsonl"), `${JSON.stringify(result)}\n`);
      if (result.failures.length > 0) console.log(`${result.id}: ${result.failures.map((f) => `${f.invariant} ${f.what.slice(0, 100)}`).join(" | ")}`);
    }
    cleanupStates();
  }
  report(args);
}

await main();
