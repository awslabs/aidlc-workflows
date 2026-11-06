// covers: subcommand:aidlc-graph:producers, subcommand:aidlc-graph:consumers, subcommand:aidlc-graph:cycles,
//         subcommand:aidlc-graph:scope, subcommand:aidlc-graph:validate-scope, subcommand:aidlc-graph:export,
//         subcommand:aidlc-graph:resolve
//
// The read-only `aidlc-graph` subcommands, driven as the shipped CLI and
// checked against the compiled data they read. `producers` and `consumers`
// agree with every stage's `produces` / `consumes` in stage-graph.json, for
// every artifact the graph knows; `cycles` is quiet on the full graph and on
// every stock scope's sub-DAG; `scope` lists exactly the stages scope-grid.json
// marks EXECUTE, in graph order; `validate-scope` passes every stock scope and
// refuses an unknown one with the valid names; `export` prints the designer
// bundle byte for byte as the committed fixture and `--check` says where it
// drifted; `resolve` stays behind its rollout flag and, lifted, prints the
// EXECUTE/SKIP plan of every stage. The library behind these has its own
// tests (t66); this file is the CLI surface, so the coverage registry credits
// the subcommands themselves.

import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const BUN = process.execPath;
const REPO_ROOT = join(import.meta.dir, "..", "..");
const TOOLS = join(REPO_ROOT, "dist", "claude", ".claude", "tools");
const GRAPH = join(TOOLS, "aidlc-graph.ts");
const EXPORT_FIXTURE = join(REPO_ROOT, "tests", "fixtures", "designer-export", "export.json");

type Stage = {
  slug: string;
  phase: string;
  produces?: string[];
  optional_produces?: string[];
  consumes?: Array<{ artifact: string }>;
};

const STAGES = JSON.parse(readFileSync(join(TOOLS, "data", "stage-graph.json"), "utf-8")) as Stage[];
const GRID = JSON.parse(readFileSync(join(TOOLS, "data", "scope-grid.json"), "utf-8")) as Record<
  string,
  { stages: Record<string, "EXECUTE" | "SKIP"> }
>;
const SCOPES = Object.keys(GRID).sort();

// `env` overrides the process environment; an `undefined` value removes the
// variable, so a flag set in the outer shell never lifts a gate under test.
function run(args: string[], env: Record<string, string | undefined> = {}) {
  const merged: Record<string, string> = {};
  for (const [key, value] of Object.entries({ ...process.env, ...env })) {
    if (value !== undefined) merged[key] = value;
  }
  const res = spawnSync(BUN, [GRAPH, ...args], {
    encoding: "utf-8",
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    env: merged,
  });
  return { status: res.status ?? -1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

function lines(out: string): string[] {
  return out.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
}

function slugs(args: string[]): string[] {
  const r = run(args);
  expect(r.status, `aidlc-graph ${args.join(" ")}\n${r.stderr}`).toBe(0);
  return lines(r.stdout);
}

describe("aidlc-graph read subcommands against the compiled graph", () => {
  test("the compiled graph is the one these tests read", () => {
    expect(STAGES.length).toBeGreaterThan(0);
    expect(SCOPES.length).toBeGreaterThan(0);
    expect(slugs(["artifacts"]).length).toBeGreaterThan(0);
  });

  test("producers and consumers of every artifact match stage-graph.json, in graph order", () => {
    for (const artifact of slugs(["artifacts"])) {
      const producers = STAGES.filter(
        (s) => (s.produces ?? []).includes(artifact) || (s.optional_produces ?? []).includes(artifact),
      ).map((s) => s.slug);
      const consumers = STAGES.filter((s) => (s.consumes ?? []).some((c) => c.artifact === artifact)).map(
        (s) => s.slug,
      );
      expect(slugs(["producers", artifact])).toEqual(producers);
      expect(slugs(["consumers", artifact])).toEqual(consumers);
    }
  });

  test("producers and consumers refuse a call with no artifact", () => {
    for (const sub of ["producers", "consumers"]) {
      const r = run([sub]);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain("Missing required argument: <artifact>");
    }
  });

  test("cycles is quiet on the full graph and on every stock scope", () => {
    const full = run(["cycles"]);
    expect(full.status, full.stdout + full.stderr).toBe(0);
    expect(full.stdout.trim()).toBe("");
    for (const scope of SCOPES) {
      const r = run(["cycles", "--scope", scope]);
      expect(r.status, `${scope}: ${r.stdout}${r.stderr}`).toBe(0);
      expect(r.stdout.trim()).toBe("");
    }
  });

  test("scope lists the stages scope-grid.json marks EXECUTE, in graph order", () => {
    const order = STAGES.map((s) => s.slug);
    for (const scope of SCOPES) {
      const expected = order.filter((slug) => GRID[scope].stages[slug] === "EXECUTE");
      expect(slugs(["scope", scope]), scope).toEqual(expected);
    }
  });

  test("scope and validate-scope refuse an unknown scope and name the valid ones", () => {
    for (const sub of ["scope", "validate-scope"]) {
      const r = run([sub, "no-such-scope"]);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain('Unknown scope: "no-such-scope"');
      for (const scope of SCOPES) expect(r.stderr).toContain(scope);
    }
  });

  test("validate-scope passes every stock scope and prints no error", () => {
    for (const scope of SCOPES) {
      const r = run(["validate-scope", scope]);
      expect(r.status, `${scope}: ${r.stderr}`).toBe(0);
      expect(r.stderr).not.toContain("[error]");
    }
  });

  test("export prints the committed designer bundle byte for byte, and --check passes on it", () => {
    const r = run(["export"]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toBe(readFileSync(EXPORT_FIXTURE, "utf-8"));
    const check = run(["export", "--check"]);
    expect(check.status, check.stderr).toBe(0);
  });

  test("export --check names the fixture it drifted from, and a missing fixture", () => {
    const dir = mkdtempSync(join(tmpdir(), "aidlc-graph-export-"));
    try {
      const drifted = join(dir, "export.json");
      writeFileSync(drifted, `${readFileSync(EXPORT_FIXTURE, "utf-8")}\n{"drift":true}\n`);
      const r = run(["export", "--check"], { AIDLC_EXPORT_FIXTURE: drifted });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(`bundle drift vs ${drifted}`);
      expect(r.stderr).toContain("Regenerate with:");

      const missing = join(dir, "absent.json");
      const m = run(["export", "--check"], { AIDLC_EXPORT_FIXTURE: missing });
      expect(m.status).toBe(1);
      expect(m.stderr).toContain(`fixture not found at ${missing}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("resolve stays behind its rollout flag", () => {
    const r = run(["resolve", "mvp", "--stdout"], { AIDLC_GRAPH_RESOLVE: undefined });
    expect(r.status).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("AIDLC_GRAPH_RESOLVE=1");
  });

  test("resolve --stdout, lifted, prints every stage with the scope's EXECUTE/SKIP action", () => {
    for (const scope of SCOPES) {
      const r = run(["resolve", scope, "--stdout"], { AIDLC_GRAPH_RESOLVE: "1" });
      expect(r.status, `${scope}: ${r.stderr}`).toBe(0);
      const plan = JSON.parse(r.stdout) as Array<{ slug: string; phase: string; action: string }>;
      expect(plan.map((p) => p.slug)).toEqual(STAGES.map((s) => s.slug));
      for (const entry of plan) {
        const stage = STAGES.find((s) => s.slug === entry.slug);
        expect(entry.phase).toBe(stage?.phase ?? "");
        expect(entry.action).toBe(GRID[scope].stages[entry.slug] === "EXECUTE" ? "EXECUTE" : "SKIP");
      }
    }
  });
});
