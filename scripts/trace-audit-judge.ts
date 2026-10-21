// The trace audit's judgement pass: a model reads each group of legs the
// extractor wrote (trace-audit.ts) as the person lived them and notices
// friction. The model only reads: its call has the Read, Grep and Glob tools
// and nothing else, and its answer comes back as JSON this script writes down.
// The tool counts (how many legs an item was met in); the model judges.
//
//   bun scripts/trace-audit-judge.ts <out-dir> [--group test|leg|run] [--only <regex>] [--limit <n>]
//       [--known <file>] [--issues] [--model <name>] [--max-usd <per call>] [--budget-kb <per call>]
//       [--parallel <n>] [--synthesize] [--bare] [--dry-run]
//
// It runs the person's own `claude` (their configured model and login) in
// print mode, from <out-dir>. --dry-run writes each group's input to
// <out-dir>/judge/<group>.input.md and calls no model.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export interface IndexLeg {
  id: string;
  run: string;
  harness: string;
  os: string;
  test: string;
  attempt: number | null;
  status: string;
  root: string;
  dir: string;
  story: string;
  rows: number;
}

export interface JudgeGroup {
  key: string;
  legs: IndexLeg[];
}

export interface FrictionItem {
  title: string;
  person_met?: string;
  harness?: string;
  stage?: string;
  severity?: string;
  cost?: string;
  known?: string;
  evidence: { leg: string; where: string; quote?: string }[];
}

export const PROMPT_FILE = join(import.meta.dir, "trace-audit-judge.md");

export const FRICTION_SCHEMA = {
  type: "object",
  properties: {
    friction: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          person_met: { type: "string" },
          harness: { type: "string" },
          stage: { type: "string" },
          severity: { type: "string", enum: ["high", "medium", "low"] },
          cost: { type: "string" },
          known: { type: "string" },
          evidence: {
            type: "array",
            items: {
              type: "object",
              properties: { leg: { type: "string" }, where: { type: "string" }, quote: { type: "string" } },
              required: ["leg", "where"],
            },
          },
        },
        required: ["title", "person_met", "harness", "stage", "severity", "cost", "known", "evidence"],
      },
    },
  },
  required: ["friction"],
};

const CLUSTER_SCHEMA = {
  type: "object",
  properties: {
    clusters: {
      type: "array",
      items: {
        type: "object",
        properties: { title: { type: "string" }, members: { type: "array", items: { type: "string" } } },
        required: ["title", "members"],
      },
    },
  },
  required: ["clusters"],
};

const clip = (text: string, max: number) => (Buffer.byteLength(text) > max ? `${Buffer.from(text).subarray(0, max).toString("utf8").replace(/\uFFFD+$/, "")}` : text);
const fileKey = (key: string) => key.replace(/\s+/g, "__").replace(/[^A-Za-z0-9._-]/g, "_");

function readIndex(outDir: string): IndexLeg[] {
  const index = JSON.parse(readFileSync(join(outDir, "index.json"), "utf8")) as { legs: IndexLeg[] };
  return index.legs;
}

/** The legs to judge together: one test on one harness across runs, one leg, or one run. */
export function judgeGroups(outDir: string, by: "test" | "leg" | "run" = "test"): JudgeGroup[] {
  const groups = new Map<string, IndexLeg[]>();
  for (const leg of readIndex(outDir)) {
    const key = by === "leg" ? leg.id : by === "run" ? leg.run : `${leg.harness || "unknown"} ${leg.test}`;
    groups.set(key, [...(groups.get(key) ?? []), leg]);
  }
  return [...groups].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([key, legs]) => ({ key, legs }));
}

/** A story cut to `max` bytes: its head (header and rows) and its end, with where to read the rest. */
function cutStory(story: string, max: number, path: string): string {
  if (Buffer.byteLength(story) <= max) return story;
  const note = `\n(cut to fit; the whole leg is in ${path})\n`;
  const room = Math.max(0, max - Buffer.byteLength(note));
  const head = clip(story, Math.floor(room * 0.6));
  const tailBytes = Buffer.from(story);
  const tail = tailBytes.subarray(Math.max(0, tailBytes.length - (room - Buffer.byteLength(head)))).toString("utf8").replace(/^\uFFFD+/, "");
  return `${head}${note}${tail}`;
}

/** What one model call reads: the known list, then each leg's story, within `budgetBytes`. */
export function judgeInput(outDir: string, group: JudgeGroup, opts: { budgetBytes?: number; known?: string; issues?: string } = {}): string {
  const budget = opts.budgetBytes ?? 160_000;
  const head = [
    `# Group: ${group.key} (${group.legs.length} legs)`,
    "",
    "## Already known",
    clip(opts.known?.trim() || "(no known list given)", Math.floor(budget * 0.15)),
    ...(opts.issues ? ["", "Open issues and pull requests:", clip(opts.issues.trim(), Math.floor(budget * 0.1))] : []),
    "",
    "## The legs",
    "",
  ].join("\n");
  const room = budget - Buffer.byteLength(head);
  // A leg with rows, or one that did not pass, gets twice the room of a quiet passing leg.
  const weight = (l: IndexLeg) => (l.rows > 0 || (l.status && l.status !== "PASS") ? 2 : 1);
  const total = group.legs.reduce((n, l) => n + weight(l), 0);
  const parts = group.legs.map((l) => {
    const header = `LEG ${l.id} (story: ${l.story}; raw files: ${join(l.root, l.dir)})\n`;
    const share = Math.floor((room * weight(l)) / total) - Buffer.byteLength(header) - 2;
    const story = existsSync(join(outDir, l.story)) ? readFileSync(join(outDir, l.story), "utf8") : "(story missing)\n";
    return `${header}${cutStory(story, Math.max(200, share), l.story)}\n`;
  });
  return clip(`${head}${parts.join("")}`, budget);
}

/**
 * The folders one group's model call may read: each judged leg's own folder,
 * never the folder it was read from, which for a session folder is a config
 * or Codex home holding its sign-in (the prompt carries strangers' issue
 * titles and trace text).
 */
export function judgeReadDirs(group: JudgeGroup): string[] {
  return [...new Set(group.legs.map((l) => resolve(l.root, l.dir)).filter((d, i) => d !== resolve(group.legs[i].root)))];
}

/** The person's own `claude`, in print mode, able only to read. */
export function claudeArgs(opts: { promptFile: string; schema: string; addDirs: string[]; model?: string; maxUsd?: number; bare?: boolean }): string[] {
  return [
    "-p",
    "--output-format", "json",
    "--no-session-persistence",
    "--tools", "Read,Grep,Glob",
    "--append-system-prompt-file", opts.promptFile,
    "--json-schema", opts.schema,
    ...opts.addDirs.flatMap((d) => ["--add-dir", d]),
    ...(opts.model ? ["--model", opts.model] : []),
    ...(opts.maxUsd ? ["--max-budget-usd", String(opts.maxUsd)] : []),
    ...(opts.bare ? ["--bare"] : []),
  ];
}

/** How many distinct legs each item cites, out of the legs judged: counted here, never by the model. */
export function frictionCounts(items: Pick<FrictionItem, "title" | "evidence">[], of: number): { title: string; legs: number; of: number }[] {
  return items.map((i) => ({ title: i.title, legs: new Set((i.evidence ?? []).map((e) => e.leg)).size, of }));
}

interface CallResult {
  output: Record<string, unknown> | null;
  cost: number;
  model: string;
  error: string;
}

function runOnce(command: string[], input: string, cwd: string, timeoutMs: number): Promise<CallResult> {
  return new Promise((done) => {
    const child = spawn(command[0], command.slice(1), { cwd, stdio: ["pipe", "pipe", "pipe"], env: process.env });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      done({ output: null, cost: 0, model: "", error: e.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      try {
        const r = JSON.parse(stdout.trim().split("\n").filter(Boolean).pop() ?? "{}") as Record<string, unknown>;
        const output = (r.structured_output as Record<string, unknown> | undefined) ??
          (typeof r.result === "string" && r.result.trim().startsWith("{") ? (JSON.parse(r.result) as Record<string, unknown>) : null);
        const models = Object.keys((r.modelUsage ?? {}) as Record<string, unknown>);
        done({
          output, cost: typeof r.total_cost_usd === "number" ? r.total_cost_usd : 0, model: models.join(", "),
          error: output ? "" : `no structured answer (exit ${code}${r.subtype ? `, ${String(r.subtype)}` : ""}): ${stderr.trim().slice(0, 300)}`,
        });
      } catch {
        done({ output: null, cost: 0, model: "", error: `unreadable answer (exit ${code}): ${(stderr || stdout).trim().slice(0, 300)}` });
      }
    });
    child.stdin.end(input);
  });
}

export interface JudgeOptions {
  group?: "test" | "leg" | "run";
  only?: RegExp;
  limit?: number;
  known?: string;
  issues?: boolean;
  model?: string;
  maxUsd?: number;
  budgetKb?: number;
  parallel?: number;
  synthesize?: boolean;
  bare?: boolean;
  dryRun?: boolean;
  /** The model command to run instead of `claude ...` (a stand-in in tests). */
  command?: string[];
  timeoutMs?: number;
}

function openItems(): string {
  const lines: string[] = [];
  for (const kind of ["issue", "pr"] as const) {
    const r = spawnSync("gh", [kind, "list", "--state", "open", "--limit", "300", "--json", "number,title", "--jq", '.[] | "#\\(.number) \\(.title)"'], { encoding: "utf8" });
    if (r.status === 0) lines.push(...r.stdout.split("\n").filter(Boolean).map((l) => `${kind === "pr" ? "PR" : "issue"} ${l}`));
  }
  return lines.join("\n");
}

/** Judge every group under `outDir`; writes judge/<group>.json and JUDGE.md there, and nothing anywhere else. */
export async function runJudge(outDirIn: string, opts: JudgeOptions = {}): Promise<{ groups: number; cost: number; failed: number }> {
  const outDir = resolve(outDirIn);
  const judgeDir = join(outDir, "judge");
  mkdirSync(judgeDir, { recursive: true });
  let groups = judgeGroups(outDir, opts.group ?? "test").filter((g) => !opts.only || opts.only.test(g.key));
  if (opts.limit) groups = groups.slice(0, opts.limit);
  const known = opts.known && existsSync(opts.known) ? readFileSync(opts.known, "utf8") : "";
  const issues = opts.issues ? openItems() : "";
  const call = (schema: object, addDirs: string[]) => opts.command ?? ["claude", ...claudeArgs({
    promptFile: PROMPT_FILE, schema: JSON.stringify(schema), addDirs, model: opts.model, maxUsd: opts.maxUsd, bare: opts.bare,
  })];
  const results: { group: JudgeGroup; items: FrictionItem[]; cost: number; model: string; error: string }[] = [];
  const queue = [...groups];
  const worker = async () => {
    for (let g = queue.shift(); g; g = queue.shift()) {
      const input = judgeInput(outDir, g, { budgetBytes: (opts.budgetKb ?? 160) * 1024, known, issues });
      const file = join(judgeDir, fileKey(g.key));
      if (opts.dryRun) {
        writeFileSync(`${file}.input.md`, input);
        continue;
      }
      const r = await runOnce(call(FRICTION_SCHEMA, judgeReadDirs(g)), input, outDir, opts.timeoutMs ?? 20 * 60_000);
      const items = (Array.isArray(r.output?.friction) ? r.output.friction : []) as FrictionItem[];
      writeFileSync(`${file}.json`, `${JSON.stringify({ key: g.key, legs: g.legs.map((l) => l.id), model: r.model, cost: r.cost, error: r.error, friction: items }, null, 1)}\n`);
      results.push({ group: g, items, cost: r.cost, model: r.model, error: r.error });
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, opts.parallel ?? 1) }, worker));
  if (opts.dryRun) return { groups: groups.length, cost: 0, failed: 0 };

  results.sort((a, b) => (a.group.key < b.group.key ? -1 : 1));
  let clusters: { title: string; members: string[] }[] = [];
  let synthesisCost = 0;
  if (opts.synthesize && results.some((r) => r.items.length > 0)) {
    const listing = results.flatMap((r) => r.items.map((it, i) => `${r.group.key}#${i}: ${it.title} | ${it.harness ?? ""} ${it.stage ?? ""} | ${it.person_met ?? ""}`));
    const input = [
      "SYNTHESIS",
      "Below are friction items found in separate groups of legs. Put items that are the same problem into one cluster",
      "(same thing the person met, same cause), even across harnesses or tests. Give each cluster a plain title and its",
      "members by their ids exactly as written (group#index). An item that matches no other is a cluster of one.",
      "",
      ...listing,
    ].join("\n");
    const r = await runOnce(call(CLUSTER_SCHEMA, []), input, outDir, opts.timeoutMs ?? 20 * 60_000);
    clusters = (Array.isArray(r.output?.clusters) ? r.output.clusters : []) as typeof clusters;
    synthesisCost = r.cost;
    writeFileSync(join(judgeDir, "synthesis.json"), `${JSON.stringify({ model: r.model, cost: r.cost, error: r.error, clusters }, null, 1)}\n`);
  }
  writeFileSync(join(outDir, "JUDGE.md"), judgeReport(results, clusters, synthesisCost));
  return {
    groups: results.length, cost: results.reduce((n, r) => n + r.cost, synthesisCost), failed: results.filter((r) => r.error).length,
  };
}

const SEVERITY = ["high", "medium", "low"];

function judgeReport(
  results: { group: JudgeGroup; items: FrictionItem[]; cost: number; model: string; error: string }[],
  clusters: { title: string; members: string[] }[],
  synthesisCost: number,
): string {
  const out: string[] = ["# Trace audit: friction found by the judgement pass", ""];
  const cost = results.reduce((n, r) => n + r.cost, synthesisCost);
  const models = [...new Set(results.map((r) => r.model).filter(Boolean))];
  out.push(`${results.length} groups judged, ${results.reduce((n, r) => n + r.group.legs.length, 0)} legs, ${results.reduce((n, r) => n + r.items.length, 0)} friction items; model ${models.join(", ") || "unknown"}; cost ${cost.toFixed(2)} USD.`);
  const failed = results.filter((r) => r.error);
  if (failed.length) out.push(`Not judged (the model gave no answer): ${failed.map((r) => `${r.group.key} (${r.error.slice(0, 120)})`).join("; ")}`);
  out.push("");
  if (clusters.length) {
    const byId = new Map<string, { it: FrictionItem; r: (typeof results)[number] }>(
      results.flatMap((r) => r.items.map((it, i): [string, { it: FrictionItem; r: (typeof results)[number] }] => [`${r.group.key}#${i}`, { it, r }])),
    );
    out.push("## Across groups (the model grouped; the tool counted legs)", "");
    for (const c of clusters) {
      const members = c.members.map((m) => byId.get(m)).filter((m) => m !== undefined);
      const legs = new Set(members.flatMap((m) => m.it.evidence.map((e) => e.leg)));
      const judged = new Set(members.flatMap((m) => m.r.group.legs.map((l) => l.id)));
      const worst = SEVERITY.find((s) => members.some((m) => m.it.severity === s)) ?? "?";
      out.push(`- [${worst}] ${c.title}: met in ${legs.size} of ${judged.size} legs judged in ${new Set(members.map((m) => m.r.group.key)).size} groups (${c.members.join(", ")})`);
    }
    out.push("");
  }
  for (const sev of [...SEVERITY, "?"]) {
    const rows = results.flatMap((r) => r.items.filter((it) => (SEVERITY.includes(it.severity ?? "") ? it.severity : "?") === sev).map((it) => ({ it, r })));
    if (!rows.length) continue;
    out.push(`## ${sev === "?" ? "Unrated" : `${sev[0].toUpperCase()}${sev.slice(1)}`}`, "");
    for (const { it, r } of rows) {
      const [count] = frictionCounts([it], r.group.legs.length);
      out.push(`### ${it.title}`);
      out.push(`${r.group.key}; ${it.harness ?? ""} ${it.stage ?? ""}; met in ${count.legs} of ${count.of} legs; known: ${it.known ?? "?"}`);
      if (it.person_met) out.push(`What the person met: ${it.person_met}`);
      if (it.cost) out.push(`Cost to the person: ${it.cost}`);
      for (const e of it.evidence ?? []) out.push(`- ${e.leg}: ${e.where}${e.quote ? ` "${e.quote}"` : ""}`);
      out.push("");
    }
  }
  return `${out.join("\n")}\n`;
}

function parse(argv: string[]): { dir: string; opts: JudgeOptions } | null {
  const opts: JudgeOptions = {};
  let dir = "";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i] ?? "";
    if (a === "--group") opts.group = next() as JudgeOptions["group"];
    else if (a === "--only") opts.only = new RegExp(next());
    else if (a === "--limit") opts.limit = Number(next());
    else if (a === "--known") opts.known = next();
    else if (a === "--issues") opts.issues = true;
    else if (a === "--model") opts.model = next();
    else if (a === "--max-usd") opts.maxUsd = Number(next());
    else if (a === "--budget-kb") opts.budgetKb = Number(next());
    else if (a === "--parallel") opts.parallel = Number(next());
    else if (a === "--synthesize") opts.synthesize = true;
    else if (a === "--bare") opts.bare = true;
    else if (a === "--dry-run") opts.dryRun = true;
    else if (!a.startsWith("--") && !dir) dir = a;
    else return null;
  }
  return dir ? { dir, opts } : null;
}

export async function main(argv: string[]): Promise<number> {
  const parsed = parse(argv);
  if (!parsed || !existsSync(join(parsed.dir, "index.json"))) {
    console.log("usage: bun scripts/trace-audit-judge.ts <out-dir written by trace-audit.ts extract> [--group test|leg|run] [--only <regex>] [--limit <n>] [--known <file>] [--issues] [--model <name>] [--max-usd <n>] [--budget-kb <n>] [--parallel <n>] [--synthesize] [--bare] [--dry-run]");
    return parsed ? 2 : argv.includes("--help") ? 0 : 2;
  }
  const r = await runJudge(parsed.dir, parsed.opts);
  console.log(parsed.opts.dryRun
    ? `trace-audit judge: wrote ${r.groups} group inputs under ${join(parsed.dir, "judge")}; no model called`
    : `trace-audit judge: ${r.groups} groups, ${r.failed} without an answer, ${r.cost.toFixed(2)} USD; report in ${join(parsed.dir, "JUDGE.md")}`);
  return r.failed > 0 && r.failed === r.groups ? 1 : 0;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
