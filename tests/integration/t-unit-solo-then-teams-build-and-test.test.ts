// covers: function:switchSoloToTeams, function:unitsBuiltBeforeTeams
//
// Solo work a teammate joined reaches Build and Test once every Unit is done.
// A live run on Claude Code: the lead built her Units, a teammate took one and
// it merged, and every /aidlc then handed out Build and Test while its gate was
// refused ("Stage build-and-test is pending"), the per-Unit stages still open in
// the record: a dead end with every Unit done.

import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { cpSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../harness/fixtures.ts";
import { hostFor } from "../harness/scope-hosts.ts";
import { AgentStandIn, type Directive, PersonScript } from "../harness/scope-run.ts";
import {
  cleanupTeamBuild,
  cloneCode,
  cloneOf,
  codeHost,
  GIT_ENV,
  git,
  HOME_RECORD,
  homeState,
  makeHome,
  mergeOnHost,
  run,
  STATE,
  UNIT,
} from "../harness/team-build.ts";

setDefaultTimeout(20 * 60_000);
afterAll(cleanupTeamBuild);

const DEPENDENCIES = "# Unit dependencies\n\n```yaml\nunits:\n" +
  "  - name: orders-api\n    kind: service\n    repos: [api]\n    depends_on: []\n" +
  "  - name: web-ui\n    kind: service\n    repos: [web]\n    depends_on: []\n" +
  "  - name: report\n    kind: service\n    repos: [api]\n    depends_on: []\n```\n";

const isBoard = (d: Directive) => d.kind === "print" && String(d.narration ?? "").startsWith("Units of");

// The teammate's build of web-ui in their clone, its code written and pushed.
function teammateBuilds(bob: string): void {
  const intents = join(bob, "aidlc", "spaces", "default", "intents");
  const record = join(intents, readdirSync(intents).find((entry) => entry.endsWith("-web-ui"))!);
  mkdirSync(join(bob, "web", "src"), { recursive: true });
  writeFileSync(join(bob, "web", "src", "ui.tsx"), "export const ui = 1;\n");
  const stage = join(record, "construction", "web-ui", "code-generation");
  mkdirSync(stage, { recursive: true });
  writeFileSync(join(stage, "source-manifest.json"), `${JSON.stringify({
    stage: "code-generation", unit: "web-ui", version: 1, writes: [{ repo: "web", path: "src/ui.tsx" }],
  }, null, 2)}\n`);
  writeFileSync(join(stage, "code-summary.md"), "# Code summary\n\nweb-ui.\n");
  const pushed = run(UNIT, ["push"], bob);
  expect(pushed.status, pushed.out).toBe(0);
}

describe("solo work a teammate joined", () => {
  test("reaches Build and Test once every Unit is done, and its gate is put to the lead", () => {
    const hosts = { api: codeHost("api"), web: codeHost("web") };
    // Each stage approved as it ends, as work begun with checkpoints off runs.
    const state = homeState().replace(/^- \[ \] (nfr-requirements|nfr-design|infrastructure-design) (\S+) EXECUTE$/gm, "- [ ] $1 $2 SKIP")
      .replace("- **Construction Checkpoints**: enabled", "- **Construction Checkpoints**: disabled");
    const home = makeHome({ repos: hosts, dependencies: DEPENDENCIES, state });
    cpSync(join(REPO_ROOT, "dist", "claude"), home.dir, { recursive: true, force: false, errorOnExist: false });
    const host = hostFor("claude", home.dir, GIT_ENV);
    const person = new PersonScript(host);
    let stopAt: (d: Directive) => boolean = (d) => d.unit === "web-ui";
    const agent = new AgentStandIn(host, person, {
      units: ["orders-api", "web-ui", "report"],
      codeRepo: (unit) => [{ repo: unit === "web-ui" ? "web" : "api" }],
      until: (d: Directive) => stopAt(d),
    });
    host.sessionStart("startup");
    person.say("/aidlc");
    // The lead builds orders-api alone and approves it; web-ui is next.
    agent.drive(agent.next());
    git(home.dir, ["add", "-A"]);
    git(home.dir, ["commit", "-q", "-m", "solo work under way"]);
    git(home.dir, ["push", "-q", "origin", "main"]);

    // A teammate takes web-ui in their own clone.
    const bob = cloneOf(home.remote, "bob");
    cloneCode(hosts.web, bob, "web", "bob");
    const took = run(UNIT, ["take", "web-ui", "--home", HOME_RECORD], bob);
    expect(took.status, took.out).toBe(0);

    // The lead's next chat (a take is looked for once per chat start and Unit
    // boundary) switches to teams, and approves once per Unit from then on,
    // as work begun with checkpoints on does.
    stopAt = (d) => isBoard(d) || d.stage === "build-and-test";
    host.newSession();
    person.say("/aidlc");
    const switched = agent.next();
    const rhythm = run(STATE, ["set-unit-gate-rhythm", "unit-end"], home.dir);
    expect(rhythm.status, rhythm.out).toBe(0);
    const afterReport = agent.drive(switched);
    expect(isBoard(afterReport), JSON.stringify(afterReport).slice(0, 600)).toBe(true);

    // web-ui comes back and merges.
    teammateBuilds(bob);
    mergeOnHost(hosts.web, "web-ui", "squash");
    git(home.dir, ["fetch", "-q", "origin"]);

    // Every Unit is done: Build and Test is next, and its gate is the lead's.
    stopAt = (d) => d.stage !== undefined && d.stage !== "build-and-test" && d.kind === "run-stage";
    const step = agent.next();
    expect(step.stage, JSON.stringify(step).slice(0, 600)).toBe("build-and-test");
    const after = agent.drive(step);
    expect(after.stage === "build-and-test", JSON.stringify(after).slice(0, 600)).toBe(false);
    const recorded = readFileSync(join(home.dir, "aidlc", "spaces", "default", "intents", HOME_RECORD, "aidlc-state.md"), "utf-8");
    expect(recorded).toMatch(/^- \[x\] build-and-test /m);
  });
});
