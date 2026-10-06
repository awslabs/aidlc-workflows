// The catch-all scope run: every shipped scope (core/scopes/aidlc-<name>.md) that
// has no t-scope-run-<name> file of its own is driven here, from the person's
// first request to done, with the same checks. A new scope is covered the day it
// ships; a file of its own can come later to balance run time.

import { describe, expect, test } from "bun:test";
import { declaredScope, expectedStages, scopeRunSuite, scopesWithOwnFile, shippedScopes } from "../harness/scope-run.ts";

const ownFile = scopesWithOwnFile();
for (const scope of shippedScopes().filter((s) => !ownFile.includes(s))) scopeRunSuite(scope);

describe("what the scope runs expect, read from the source", () => {
  test.each(shippedScopes())("%s: its switches and stages read from its scope file and the stage files", (scope) => {
    const declared = declaredScope(scope);
    expect(["Minimal", "Standard", "Comprehensive"]).toContain(declared.depth);
    expect(["off", "relaxed", "strict"]).toContain(declared.guardPolicy);
    const stages = expectedStages(scope, true);
    expect(stages.slice(0, 3)).toEqual(["workspace-scaffold", "workspace-detection", "state-init"]);
    expect(stages.length).toBeGreaterThan(3);
  });
});
