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
import { ROUTES } from "../../core/tools/aidlc.ts";
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
    for (const help of [["--help"], ["-h"], ["help"]]) {
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

  test("review and link offer no selector their handlers refuse", () => {
    const p = project();
    for (const [verb, required] of [["review", "--reviewer"], ["link", "--link"]] as const) {
      const usage = run(p, "aidlc-log.ts", [verb, "--help"]).stdout;
      expect(usage).not.toMatch(/--intent <|--space <|--intent,|--space\./);
      expect(usage).toContain("Runs in the active workspace");
      const refused = run(p, "aidlc-log.ts", [verb, "--stage", "feasibility", required, "x", "--intent", "x"]);
      expect(refused.out).toContain("does not accept --intent/--space selectors");
    }
  });

  // --person-asked is read only when the review is requested, never with --verdict.
  test("review names --person-asked on the request line, not the verdict line", () => {
    const p = project();
    const [request, , verdict] = run(p, "aidlc-log.ts", ["review", "--help"]).stdout.split("\n");
    expect(request).toContain("--iteration <n> [--unit <unit>] [--person-asked]");
    expect(verdict).toContain("--verdict ");
    expect(verdict).not.toContain("--person-asked");
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

  // Windows PowerShell 5.1 splits `Run "todo --help" first` at the inner quotes,
  // so the person's words arrive as `--details "Run todo" --help first`. That
  // `--help` is theirs: it is refused with the way to pass the words whole, never
  // read as help, which would exit 0 and drop the answer (t31 s9).
  for (const [verb, textFlag] of [["decision", "--decision"], ["answer", "--details"]] as const) {
    for (const fragments of [["--help"], ["--help first"], ["--help first and check", "it again"]]) {
      test(`log ${verb} ${textFlag} "Run todo" ${fragments.join(" ")} is the person's words, not help`, () => {
        const p = project();
        const r = run(p, "aidlc-log.ts", [verb, "--stage", "feasibility", textFlag, "Run todo", ...fragments]);
        expect(r.status, r.out).toBe(1);
        expect(r.stdout).not.toContain(`engine log ${verb} --stage <slug>`);
        expect(r.out).toContain("is not an option of log");
      });
    }
  }
});

// Each routed verb asked for help first, the one place no flag can be waiting
// for its argument as a value.
function describeVerbHelp(noun: string, tool: string, verbs: readonly string[]): void {
  for (const verb of verbs) {
    for (const help of [["--help"], ["-h"], ["help"]]) {
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
  describeVerbHelp("bolt", "aidlc-bolt.ts", ["start", "complete", "fail", "abort", "set-autonomy", "checkpoint", "swarm-checkpoint", "dispatch-event", "hold-merge", "release-merge"]);

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

  test("a --help after a value is not help: nothing is recorded with the words cut short", () => {
    const p = project();
    const r = run(p, "aidlc-bolt.ts", ["fail", "--name", "b1", "--error", "Run todo", "--help"]);
    expect(r.status, r.out).not.toBe(0);
    expect(r.stdout).not.toContain("engine bolt fail --name");
    expect(r.stdout).not.toContain('"emitted":"BOLT_FAILED"');
  });
});

describe("worktree", () => {
  describeVerbHelp("worktree", "aidlc-worktree.ts", ["create", "merge", "discard", "restore", "purge", "list", "verify", "info"]);

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
  describeVerbHelp("sensor", "aidlc-sensor.ts", ["list", "describe", "fire"]);

  test("a value that only looks like help is still the value", () => {
    const p = project();
    const r = run(p, "aidlc-sensor.ts", ["fire", "aidlc-linter", "--stage", "feasibility", "--output-path", "x.md", "--unit", "-h"]);
    expect(r.status).toBe(1);
    expect(r.out).toContain('fire --unit expects a Unit name, got "-h"');
  });
});

describe("engine <noun> --help", () => {
  // The dispatcher owns each noun's verbs; it lists them, where it used to say
  // "unknown verb '--help'" with exit 2. It names `<verb> --help` only for a
  // noun whose tool answers it, so it never prints a command that fails.
  for (const [noun, verbs, verbHelp] of [
    ["log", ["decision", "answer", "answers", "review", "link"], true],
    ["bolt", ["start", "complete"], true],
    ["worktree", ["create", "restore"], true],
    ["sensor", ["list", "describe", "fire"], true],
    ["state", ["unit"], false],
  ] as const) {
    for (const help of ["--help", "-h"]) {
      test(`engine ${noun} ${help} lists its verbs and exits 0`, () => {
        const p = project();
        const r = run(p, "aidlc.ts", ["engine", noun, help]);
        expect(r.status, r.out).toBe(0);
        expect(r.stdout).toContain(`engine ${noun} <verb> [flags]`);
        for (const verb of verbs) expect(r.stdout).toContain(verb);
        expect(r.stdout.includes(`engine ${noun} <verb> --help`)).toBe(verbHelp);
      });
    }
  }

  // Every route that says its tool answers `<verb> --help` does, for every
  // verb it routes: the claim the noun help prints is checked, not assumed.
  test("every verb of a route marked verbHelp answers --help", () => {
    const p = project();
    const marked = ROUTES.filter((route) => route.verbHelp === true);
    expect(marked.map((route) => route.group).sort()).toEqual(["bolt", "log", "sensor", "worktree"]);
    const before = errorRows(p);
    for (const route of marked) {
      for (const verb of route.verbs) {
        const r = run(p, "aidlc.ts", ["engine", route.group, verb, "--help"]);
        expect(r.status, `${route.group} ${verb}: ${r.out}`).toBe(0);
        expect(r.stdout).toContain(`engine ${route.group} ${verb}`);
      }
    }
    expect(errorRows(p)).toBe(before);
  });

  test("an unknown verb, or the bare word help, is still an error", () => {
    const p = project();
    for (const verb of ["bogus", "help"]) {
      const r = run(p, "aidlc.ts", ["engine", "log", verb]);
      expect(r.status).toBe(2);
      expect(r.out).toContain(`unknown verb '${verb}'`);
    }
  });
});
