// A lead's plan whose Units start at Code Generation (the per-Unit design
// stages skipped, as a live run's plan did), refunds built to its end and
// pushed by one teammate, and a second teammate who takes a Unit, plainly or
// early on refunds' pushed branch, then drives its Code Generation with the
// suite's agent stand-in. What the second teammate hears at the code plan
// question and the gate is what these cases read.

import { expect } from "bun:test";
import { cpSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixtureIntentId8, REPO_ROOT, seededStateFile } from "./fixtures.ts";
import { hostFor } from "./scope-hosts.ts";
import { AgentStandIn, type Directive, PersonScript } from "./scope-run.ts";
import {
  cloneCode,
  cloneOf,
  codeHost,
  commitOnHost,
  git,
  GIT_ENV,
  homeState,
  makeHome,
  makePlanHomeWithRemote,
  planFrom,
  run,
  squashOnHost,
  STATE,
  takeIn,
  UNIT,
} from "./team-build.ts";

const D = String.fromCharCode(0x2014);
const BOTH_UNITS = "# Unit dependencies\n\n```yaml\nunits:\n  - name: refunds\n    kind: service\n    depends_on: []\n" +
  "  - name: reporting\n    kind: service\n    depends_on: [refunds]\n```\n";

/** The lead's state as Construction starts, each Unit's own stages starting at Code Generation. */
export function codeGenerationFirst(extraRuntime: string[] = []): string {
  return homeState(extraRuntime)
    .replace(`- [-] functional-design ${D} EXECUTE`, `- [S] functional-design ${D} SKIP`)
    .replace(`- [ ] nfr-requirements ${D} EXECUTE`, `- [S] nfr-requirements ${D} SKIP`)
    .replace(`- [ ] nfr-design ${D} EXECUTE`, `- [S] nfr-design ${D} SKIP`)
    .replace(`- [ ] infrastructure-design ${D} EXECUTE`, `- [S] infrastructure-design ${D} SKIP`)
    .replace(`- [ ] code-generation ${D} EXECUTE`, `- [-] code-generation ${D} EXECUTE`)
    .replace("- **Current Stage**: functional-design", "- **Current Stage**: code-generation");
}

export function recordOf(dir: string, space: string, unit: string): string {
  const intents = join(dir, "aidlc", "spaces", space, "intents");
  return join(intents, readdirSync(intents).find((name) => name.endsWith(`-${unit}`))!);
}

export interface EarlyStart {
  /** The second teammate's workspace. */
  dana: string;
  /** Where the Unit's code goes: the workspace itself, or its billing repository. */
  code: string;
  unit: string;
  record: string;
  home: { dir: string; remote: string };
  /** The take's --plan and --from. */
  from: string[];
}

/**
 * The plan shared (Guard Policy off in the lead's plan, so refunds built to
 * its end pushes its record complete), and dana's take: refunds itself
 * (`early: false`) or reporting early on refunds' pushed branch. `repos` puts
 * the code in a billing repository of its own. `uncommitted` leaves a change
 * of dana's own uncommitted at the take (an edit and a new file), which keeps
 * the take from switching. `policy` is dana's own Guard Policy for the build.
 */
export function teammateTakes(options: {
  early: boolean;
  repos?: boolean;
  uncommitted?: boolean;
  rhythm?: "per-stage" | "unit-end";
  policy?: "off" | "relaxed" | "strict";
  /** The lead's Units start at Functional Design (the default) instead of Code Generation. */
  functionalDesignFirst?: boolean;
  /** The plan's Units, refunds and reporting (on refunds) by default. */
  dependencies?: string;
}): EarlyStart {
  const rhythm = options.rhythm ?? "per-stage";
  let home: { dir: string; remote: string };
  let hosts: Record<string, string> = {};
  let from: string[];
  if (options.repos) {
    hosts = { "checkout-api": codeHost("checkout-api"), billing: codeHost("billing") };
    const planHome = makePlanHomeWithRemote({ repos: hosts, dependencies: options.dependencies, state: codeGenerationFirst(rhythm === "unit-end" ? ["- **Unit Gate Rhythm**: unit-end"] : []) });
    home = planHome;
    from = planFrom(planHome);
  } else {
    home = makeHome({ repos: {}, dependencies: options.dependencies ?? BOTH_UNITS, state: options.functionalDesignFirst ? homeState() : codeGenerationFirst() });
    expect(run(STATE, ["set-unit-ownership", "team"], home.dir).status).toBe(0);
    if (rhythm === "unit-end") expect(run(STATE, ["set-unit-gate-rhythm", "unit-end"], home.dir).status).toBe(0);
    const path = seededStateFile(home.dir);
    const state = readFileSync(path, "utf-8");
    if (!state.includes("- **Home Location**:")) {
      writeFileSync(path, state.replace("## Runtime State\n", `## Runtime State\n- **Home Location**: ${home.remote}\n`));
    }
    // A doc refunds changes, and a file of the person's own.
    writeFileSync(join(home.dir, "README.md"), "# checkout\n");
    writeFileSync(join(home.dir, "PERSONAL.md"), "my notes\n");
    git(home.dir, ["add", "-A"]);
    git(home.dir, ["commit", "-q", "-m", "teams"]);
    git(home.dir, ["push", "-q", "origin", "main"]);
    expect(run(UNIT, ["share", "--plan"], home.dir).status).toBe(0);
    from = ["--plan", fixtureIntentId8(home.dir, undefined, "default"), "--from", home.remote];
  }
  const where = (dir: string): string => (options.repos ? join(dir, "billing") : dir);
  const cloneRepos = (dir: string, who: string): void => {
    for (const [name, host] of Object.entries(hosts)) cloneCode(host, dir, name, who);
  };
  if (options.early) {
    // alice builds refunds to its end and pushes it: two files of its own and a change to README.md.
    const alice = cloneOf(home.remote, "alice");
    cloneRepos(alice, "alice");
    const took = takeIn("payments", ["refunds", ...from], alice);
    expect(took.status, took.out).toBe(0);
    const rec = recordOf(alice, "payments", "refunds");
    const code = where(alice);
    mkdirSync(join(code, "src"), { recursive: true });
    writeFileSync(join(code, "src", "refunds.ts"), "export const built = \"refunds\";\n");
    writeFileSync(join(code, "src", "refunds-extra.ts"), "export const extra = 1;\n");
    writeFileSync(join(code, "README.md"), "# checkout\n\nrefunds added.\n");
    const stage = join(rec, "construction", "refunds", "code-generation");
    mkdirSync(stage, { recursive: true });
    const repo = options.repos ? { repo: "billing" } : {};
    writeFileSync(join(stage, "source-manifest.json"), `${JSON.stringify({ stage: "code-generation", unit: "refunds", version: 1,
      writes: ["src/refunds.ts", "src/refunds-extra.ts", "README.md"].map((path) => ({ ...repo, path })) })}\n`);
    writeFileSync(join(stage, "code-summary.md"), "# Code summary\n\nrefunds.\n");
    const st = join(rec, "aidlc-state.md");
    let built = readFileSync(st, "utf-8");
    for (const slug of ["functional-design", "nfr-requirements", "nfr-design", "infrastructure-design", "code-generation"]) {
      built = built.replace(new RegExp(`^- \\[[-? ]\\] ${slug} `, "m"), `- [x] ${slug} `);
    }
    writeFileSync(st, built);
    const pushed = run(UNIT, ["push"], alice);
    expect(pushed.status, pushed.out).toBe(0);
    if (options.repos) git(home.dir, ["fetch", "-q", "origin"]);
  }
  const dana = cloneOf(home.remote, "dana");
  cloneRepos(dana, "dana");
  const code = where(dana);
  if (options.repos) {
    writeFileSync(join(code, "PERSONAL.md"), "my notes\n");
    git(code, ["add", "-A"]);
    git(code, ["commit", "-q", "-m", "mine"]);
  }
  if (options.uncommitted) {
    writeFileSync(join(code, "PERSONAL.md"), "my notes, edited\n");
    writeFileSync(join(code, "SCRATCH.md"), "mine, not committed\n");
  }
  const unit = options.early ? "reporting" : "refunds";
  const took = takeIn("data", [unit, ...from, ...(options.early ? ["--early"] : [])], dana);
  expect(took.status, took.out).toBe(0);
  // The install laid after the take, as a clone with nothing of the person's uncommitted takes it.
  cpSync(join(REPO_ROOT, "dist", "claude"), dana, { recursive: true, force: false, errorOnExist: false });
  if (options.policy !== undefined && options.policy !== "off") {
    const set = run(join(dana, ".claude", "tools", "aidlc.ts"), ["config", "set", "guard-policy", options.policy], dana);
    expect(set.status, set.out).toBe(0);
  }
  return { dana, code, unit, record: recordOf(dana, "data", unit), home, from };
}

const twoUnits = (repos: string): string => "# Unit dependencies\n\n```yaml\nunits:\n" +
  `  - name: refunds\n    kind: service\n${repos}    depends_on: []\n  - name: checkout-ui\n    kind: ui\n${repos}    depends_on: []\n` + "```\n";

/**
 * dana builds refunds and pushes it; a reviewer commits a change to its
 * src/refunds.ts on the host and squashes it into main, so main holds a
 * version of that file her clone never had. In the same clone, still on
 * refunds' branch as its push left her, she takes checkout-ui, whose Code
 * Generation starts there (at Functional Design with `functionalDesignFirst`).
 * `repos` builds both in a billing repository of their own; `beforeTake` runs
 * in the code's checkout just before the second take.
 */
export function nextUnitAfterReviewedSquash(options: {
  policy?: "strict";
  repos?: boolean;
  functionalDesignFirst?: boolean;
  beforeTake?: (code: string) => void;
} = {}): EarlyStart {
  const first = teammateTakes({
    early: false, repos: options.repos, functionalDesignFirst: options.functionalDesignFirst,
    dependencies: twoUnits(options.repos ? "    repos: [billing]\n" : ""),
  });
  const built = driveCodeGeneration(first);
  expect(built.end?.ask_type, built.refusal ?? "").toBe("unit-push");
  const pushed = run(UNIT, ["push"], first.dana);
  expect(pushed.status, pushed.out).toBe(0);
  const host = git(first.code, ["remote", "get-url", "origin"]);
  commitOnHost(host, "refunds", { "src/refunds.ts": "export const refunds = (): number => 43;\n" }, "review: refunds");
  squashOnHost(host, "refunds", "refunds (#1)");
  options.beforeTake?.(first.code);
  const took = takeIn("data", ["checkout-ui", ...first.from], first.dana);
  expect(took.status, took.out).toBe(0);
  // The Guard Policy is the work's own (resolveGuardPolicy reads its state): set on checkout-ui's.
  if (options.policy !== undefined) {
    const set = run(join(first.dana, ".claude", "tools", "aidlc.ts"), ["config", "set", "guard-policy", options.policy], first.dana);
    expect(set.status, set.out).toBe(0);
  }
  return { ...first, unit: "checkout-ui", record: recordOf(first.dana, "data", "checkout-ui") };
}

export interface CodeGenerationRun {
  /** The lines the person was told by the commands the agent ran (change notices). */
  notices: string[];
  /** Each code plan question's summary lines. */
  plans: string[][];
  /** The step the drive ended at (the push question when Code Generation completed). */
  end: Directive | null;
  /** The refusal the agent met instead, word for word. */
  refusal: string | null;
}

/** The person types /aidlc; the stand-in builds the Unit, `onCode` writing beside its code. */
export function driveCodeGeneration(build: EarlyStart, onCode: () => void = () => {}): CodeGenerationRun {
  const host = hostFor("claude", build.dana, GIT_ENV);
  const person = new PersonScript(host);
  const agent = new AgentStandIn(host, person, {
    units: ["refunds", "reporting"],
    ...(build.code === build.dana ? {} : { codeRepo: () => [{ repo: "billing" }] }),
    onCode: () => {
      onCode();
      return [];
    },
    until: (d) => d.kind === "done" || (d.kind === "ask" && /push|publish|share/.test(String(d.ask_type ?? ""))) ||
      (d.kind === "run-stage" && d.stage === "build-and-test"),
  });
  host.sessionStart("startup");
  person.say("/aidlc");
  let end: Directive | null = null;
  let refusal: string | null = null;
  try {
    end = agent.drive(agent.next());
  } catch (error) {
    const last = agent.directives.at(-1);
    refusal = typeof last?.message === "string" ? last.message : String((error as { refusal?: string }).refusal ?? (error as Error).message);
  }
  const plans = agent.directives.filter((d) => d.ask_type === "plan-approval")
    .flatMap((d) => ((d.plan_approval as { targets?: Array<{ summary?: string[] }> } | undefined)?.targets ?? []).map((t) => t.summary ?? []));
  return { notices: [...agent.notices], plans, end, refusal };
}

/** The gate's line naming what changed outside any Unit, or null. */
export function outsideTheUnits(run: CodeGenerationRun): string | null {
  return run.notices.find((line) => line.includes("outside any unit's work") || line.includes("outside the units")) ?? null;
}
