// covers: subcommand:aidlc-utility:intent-create, subcommand:aidlc-orchestrate:next
//
// One stage count from the plan offer to the first stage, with no model
// (tests/harness/scope-run.ts). The person asks for work on each of five
// scopes, in an empty project and in one with code: the creation print's
// "(N stages, N approval gates)", the line intent create prints
// ("State initialized: <scope> scope, N stages") and the first stage's
// "(stage 1 of N)" say the same N, the stages the plan runs after
// Initialization. Each run stops when the first stage starts.

import { afterAll, describe, expect, test } from "bun:test";
import { cleanupTestProject } from "../harness/fixtures.ts";
import { type Directive, runScope, SCOPE_RUN_TIMEOUT_MS, type ScopeRun } from "../harness/scope-run.ts";

const runs: ScopeRun[] = [];
afterAll(() => {
  for (const run of runs) cleanupTestProject(run.proj);
});

describe("the person reads one stage count from the plan offer to the first stage", () => {
  for (const scope of ["bugfix", "poc", "classic", "feature", "enterprise"]) {
    for (const shape of ["empty", "code"] as const) {
      test(`${scope}, ${shape === "code" ? "existing code" : "a new project"}`, () => {
        let first: Directive | null = null;
        const run = runScope(scope, {
          shape,
          until: (d) => {
            if (d.kind === "run-stage") first = d;
            return first !== null;
          },
        });
        runs.push(run);
        const said = run.agent.directives.map((d) => String(d.message ?? "")).join("\n");
        const offered = /\((\d+) stages?, (\d+) approval gates?/.exec(said);
        expect(offered, said).not.toBeNull();
        const n = offered![1];
        expect(run.host.trace.join("\n")).toContain(`State initialized: ${scope} scope, ${n} stages,`);
        expect(String((first as Directive | null)?.narration ?? "")).toContain(`(stage 1 of ${n})`);
      }, SCOPE_RUN_TIMEOUT_MS);
    }
  }
});
