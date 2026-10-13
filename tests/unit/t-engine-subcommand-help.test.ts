// `--help` on an engine subcommand prints its usage (#2449). A live Copilot run
// asked 19 times, mostly right after a compaction, and each time the flag
// parser read `--help` as a flag waiting for a value: "--help expects a value,
// got end of arguments.", exit 1, and an ERROR_LOGGED row in the audit. Help is
// read before any flag, prints to stdout, exits 0 and records nothing.
// covers: function:asksForHelp
import { afterAll, describe, expect, test, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { readAllAuditShards } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { cleanupTestProject, createTestProject, seedStateFile } from "../harness/fixtures.ts";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const BUN = process.execPath;
const TOOLS = join(import.meta.dir, "..", "..", "dist", "claude", ".claude", "tools");

const projects: string[] = [];
afterAll(() => {
  for (const p of projects) cleanupTestProject(p);
});

function project(): string {
  const p = createTestProject();
  projects.push(p);
  seedStateFile(p, "state-mid-ideation.md");
  return p;
}

function run(p: string, tool: string, args: string[]): { status: number; stdout: string; out: string } {
  const r = spawnSync(BUN, [join(TOOLS, tool), ...args, "--project-dir", p], {
    cwd: p,
    encoding: "utf-8",
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

const errorRows = (p: string) => readAllAuditShards(p).split("**Event**: ERROR_LOGGED").length - 1;

describe("log", () => {
  for (const verb of ["decision", "answer", "answers", "link", "review"]) {
    for (const help of [["--help"], ["-h"], ["--stage", "feasibility", "--help"]]) {
      test(`log ${verb} ${help.join(" ")} prints its usage, exits 0 and records nothing`, () => {
        const p = project();
        const before = errorRows(p);
        for (const [tool, args] of [["aidlc-log.ts", [verb, ...help]], ["aidlc.ts", ["engine", "log", verb, ...help]]] as const) {
          const r = run(p, tool, [...args]);
          expect(r.status, r.out).toBe(0);
          expect(r.stdout).toContain(`engine log ${verb} --stage <slug>`);
          expect(r.out).not.toContain("expects a value");
        }
        expect(errorRows(p)).toBe(before);
      });
    }
  }

  test("decision and answer name their required flags and the checkpoints each accepts", () => {
    const p = project();
    const decision = run(p, "aidlc-log.ts", ["decision", "--help"]).stdout;
    expect(decision).toContain("Required: --stage, --decision.");
    expect(decision).toContain("--checkpoint: summary-confirmation, plan-approval, verification-command, construction-policy.");
    expect(decision).toContain("the learnings one included, takes none");
    expect(decision).not.toContain("guard-recovery");
    const answer = run(p, "aidlc-log.ts", ["answer", "--help"]).stdout;
    expect(answer).toContain("Required: --stage, and --details or --details-file.");
    expect(answer).toContain("guard-recovery");
    expect(answer).toContain("--details-file");
  });

  test("an unknown checkpoint names only the ones that subcommand accepts", () => {
    const p = project();
    const decision = run(p, "aidlc-log.ts", ["decision", "--stage", "feasibility", "--decision", "Pick", "--checkpoint", "guard-recovery"]);
    expect(decision.status).toBe(1);
    expect(decision.out).toContain("Accepted: summary-confirmation, plan-approval, verification-command, construction-policy");
    expect(decision.out).not.toContain("construction-policy, guard-recovery");
  });

  test("the tool with no subcommand, or asking for help first, lists every subcommand", () => {
    const p = project();
    for (const args of [[], ["--help"], ["help"]]) {
      const r = run(p, "aidlc-log.ts", args);
      expect(r.status, r.out).toBe(0);
      for (const verb of ["decision", "answer", "answers", "link", "review"]) {
        expect(r.stdout).toContain(`engine log ${verb} `);
      }
    }
  });

  test("a value that only looks like help is still the value", () => {
    const p = project();
    const r = run(p, "aidlc-log.ts", ["decision", "--stage", "feasibility", "--decision", "-h", "--options", "help,-h"]);
    expect(r.status, r.out).toBe(0);
    expect(r.stdout).toContain('"emitted":"DECISION_RECORDED"');
  });
});

// Each routed verb, with a required flag (or the positional id) it takes, so
// `--help` after a flag that waits for a value is help too.
function describeVerbHelp(noun: string, tool: string, verbs: Record<string, string[]>): void {
  for (const [verb, required] of Object.entries(verbs)) {
    const helps = [["--help"], ["-h"], ...(required.length > 0 ? [[...required, "--help"]] : [])];
    for (const help of helps) {
      test(`${noun} ${verb} ${help.join(" ")} prints its usage, exits 0 and records nothing`, () => {
        const p = project();
        const before = errorRows(p);
        for (const [file, args] of [[tool, [verb, ...help]], ["aidlc.ts", ["engine", noun, verb, ...help]]] as const) {
          const r = run(p, file, [...args]);
          expect(r.status, r.out).toBe(0);
          expect(r.stdout).toContain(`engine ${noun} ${verb}`);
          expect(r.out).not.toContain("expects a value");
        }
        expect(errorRows(p)).toBe(before);
      });
    }
  }
}

describe("bolt", () => {
  describeVerbHelp("bolt", "aidlc-bolt.ts", {
    start: ["--name", "b1"],
    complete: ["--name", "b1"],
    fail: ["--name", "b1"],
    abort: ["--slug", "b1"],
    "set-autonomy": ["--mode", "gated"],
    checkpoint: ["--unit", "u1"],
    "swarm-checkpoint": ["--batch", "1"],
    "dispatch-event": ["--slug", "b1"],
    "hold-merge": ["--slug", "b1"],
    "release-merge": ["--slug", "b1"],
  });

  test("the usage names the values the subcommands check", () => {
    const p = project();
    expect(run(p, "aidlc-bolt.ts", ["set-autonomy", "--help"]).stdout).toContain("--mode autonomous|gated");
    const checkpoint = run(p, "aidlc-bolt.ts", ["checkpoint", "--help"]).stdout;
    expect(checkpoint).toContain("--action status|ask|verify|approve|reject");
    expect(checkpoint).toContain("--kind: unit, skeleton");
    expect(run(p, "aidlc-bolt.ts", ["swarm-checkpoint", "--help"]).stdout).toContain("--action status|ask|approve|reject");
    expect(run(p, "aidlc-bolt.ts", ["dispatch-event", "--help"]).stdout).toContain("--strategy squash|merge|rebase");
  });

  test("a value that only looks like help is still the value", () => {
    const p = project();
    const r = run(p, "aidlc-bolt.ts", ["fail", "--name", "b1", "--error", "-h"]);
    expect(r.status, r.out).toBe(0);
    expect(r.stdout).toContain('"emitted":"BOLT_FAILED"');
    expect(r.stdout).toContain('"error":"-h"');
  });
});

describe("worktree", () => {
  describeVerbHelp("worktree", "aidlc-worktree.ts", {
    create: ["--slug", "b1"],
    merge: ["--slug", "b1"],
    discard: ["--slug", "b1"],
    restore: ["--slug", "b1"],
    purge: ["--slug", "b1"],
    list: [],
    verify: ["--slug", "b1"],
    info: ["--slug", "b1"],
  });

  test("a recovery verb's usage lists the flags it accepts", () => {
    const p = project();
    const restore = run(p, "aidlc-worktree.ts", ["restore", "--help"]).stdout;
    expect(restore).toContain("--parked <stamp>, --raw, --repo <name>, --intent <intent>, --space <space>");
    expect(run(p, "aidlc-worktree.ts", ["purge", "--help"]).stdout).toContain("--older-than <days>");
  });

  // No worktree verb that takes a value runs cheaply; a refusal that names the
  // value shows it was read as one.
  test("a value that only looks like help is still the value", () => {
    const p = project();
    const r = run(p, "aidlc-worktree.ts", ["verify", "--event", "-h", "--slug", "b1"]);
    expect(r.status).toBe(1);
    expect(r.out).toContain('Invalid --event: \\"-h\\"');
  });
});

describe("sensor", () => {
  describeVerbHelp("sensor", "aidlc-sensor.ts", {
    list: [],
    describe: ["aidlc-linter"],
    fire: ["aidlc-linter", "--stage", "feasibility"],
  });

  test("a value that only looks like help is still the value", () => {
    const p = project();
    const r = run(p, "aidlc-sensor.ts", ["fire", "aidlc-linter", "--stage", "feasibility", "--output-path", "x.md", "--unit", "-h"]);
    expect(r.status).toBe(1);
    expect(r.out).toContain('fire --unit expects a Unit name, got "-h"');
  });
});

describe("engine <noun> --help", () => {
  // The dispatcher owns each noun's verbs; it lists them and names the way to
  // a verb's flags, where it used to say "unknown verb '--help'" with exit 2.
  for (const [noun, verbs] of [
    ["log", ["decision", "answer", "answers", "review", "link"]],
    ["bolt", ["start", "complete"]],
    ["worktree", ["create", "restore"]],
    ["sensor", ["list", "describe", "fire"]],
    ["state", ["unit"]],
  ] as const) {
    for (const help of ["--help", "-h", "help"]) {
      test(`engine ${noun} ${help} lists its verbs and exits 0`, () => {
        const p = project();
        const r = run(p, "aidlc.ts", ["engine", noun, help]);
        expect(r.status, r.out).toBe(0);
        expect(r.stdout).toContain(`engine ${noun} <verb> [flags]`);
        for (const verb of verbs) expect(r.stdout).toContain(verb);
        expect(r.stdout).toContain(`engine ${noun} <verb> --help`);
      });
    }
  }

  test("an unknown verb is still an error", () => {
    const p = project();
    const r = run(p, "aidlc.ts", ["engine", "log", "bogus"]);
    expect(r.status).toBe(2);
    expect(r.out).toContain("unknown verb 'bogus'");
  });
});
