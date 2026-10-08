// covers: function:effectiveSupportAgents, function:effectiveSupportAgentsForProject, function:pipelineLinks, function:resolveCeremony
//
// The collaborators switch (scope-owned `collaborators` ceremony) is the single
// knob that runs a stage with its support agents or lead-only. These cases pin
// the ONE owner the directive builder, the approval-gate evidence check, and
// practices-promote all route through — `effectiveSupportAgents` — plus the
// resolver precedence behind it and the pipeline-link degradation it drives.
// The scope-wide behaviour at the gate (enterprise on, every other scope off)
// is exercised end-to-end in t236; here we isolate the mechanism so a
// regression in resolution or list-collapsing is caught deterministically,
// without spawning the engine.

import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  CEREMONY_ENV,
  effectiveSupportAgents,
  effectiveSupportAgentsForProject,
  findStageBySlug,
  pipelineLinks,
  resolveCeremony,
} from "../../core/tools/aidlc-lib.ts";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createTestProject,
  seededStateFile,
  withEnvAndFreshCaches,
} from "../harness/fixtures.ts";

// Mirror t337's resolution env: derive the scope mapping from the authored
// core/scopes (so the `collaborators` frontmatter is read) over the shipped
// grid/graph, with the mapping seam unset and the kill switch cleared.
const POLICY_ENV = {
  AIDLC_HARNESS_DIR: ".claude",
  AIDLC_SCOPE_MAPPING: undefined,
  AIDLC_SCOPE_GRID: join(AIDLC_SRC, "tools", "data", "scope-grid.json"),
  AIDLC_STAGE_GRAPH: join(AIDLC_SRC, "tools", "data", "stage-graph.json"),
  AIDLC_SCOPES_DIR: join(import.meta.dir, "..", "..", "core", "scopes"),
  AIDLC_DISABLE_COLLABORATORS: "0",
};

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length) cleanupTestProject(tempDirs.pop());
});

const FAKE = { support_agents: ["aidlc-x-agent", "aidlc-y-agent"] };

describe("t-collaborators resolver precedence (env > intent > scope > on)", () => {
  test("enterprise ships collaborators on; every other stock scope ships them off", () => {
    withEnvAndFreshCaches(POLICY_ENV, () => {
      const ent = resolveCeremony("collaborators", "enterprise", null);
      expect(ent.value).toBe("on");
      expect(ent.source).toBe("scope enterprise");
      for (const scope of ["feature", "mvp", "bugfix", "poc", "classic", "express", "infra", "refactor", "security-patch", "workshop"]) {
        const r = resolveCeremony("collaborators", scope, null);
        expect(r.value, scope).toBe("off");
        expect(r.source, scope).toBe(`scope ${scope}`);
      }
    });
  });

  test("a per-run intent line overrides the scope default", () => {
    withEnvAndFreshCaches(POLICY_ENV, () => {
      const on = resolveCeremony("collaborators", "feature", "- **Collaborators**: on (set by you)\n");
      expect(on.value).toBe("on");
      expect(on.source).toBe("you");
      const off = resolveCeremony("collaborators", "enterprise", "- **Collaborators**: off (set by you)\n");
      expect(off.value).toBe("off");
      expect(off.source).toBe("you");
    });
  });

  test("the env kill switch forces off even over an on intent, and clears cleanly", () => {
    withEnvAndFreshCaches({ ...POLICY_ENV, [CEREMONY_ENV.collaborators]: "1" }, () => {
      const r = resolveCeremony("collaborators", "enterprise", "- **Collaborators**: on (set by you)\n");
      expect(r.value).toBe("off");
      expect(r.source).toBe(`env ${CEREMONY_ENV.collaborators}`);
    });
    withEnvAndFreshCaches(POLICY_ENV, () => {
      expect(resolveCeremony("collaborators", "enterprise", null).value).toBe("on");
    });
  });

  test("an unknown scope with no intent falls back to on", () => {
    withEnvAndFreshCaches(POLICY_ENV, () => {
      const r = resolveCeremony("collaborators", "no-such-scope", null);
      expect(r.value).toBe("on");
      expect(r.source).toBe("default");
    });
  });
});

describe("t-collaborators effectiveSupportAgents (the single owner)", () => {
  test("on returns the declared list, off returns empty, and an empty roster stays empty", () => {
    withEnvAndFreshCaches(POLICY_ENV, () => {
      expect(effectiveSupportAgents(FAKE, "enterprise", null)).toEqual(FAKE.support_agents);
      expect(effectiveSupportAgents(FAKE, "feature", null)).toEqual([]);
      // A per-run intent flips it back on under an off scope.
      expect(effectiveSupportAgents(FAKE, "feature", "- **Collaborators**: on (set by you)\n")).toEqual(FAKE.support_agents);
      // A stage that declares no collaborators never gains any.
      expect(effectiveSupportAgents({ support_agents: [] }, "enterprise", null)).toEqual([]);
    });
  });
});

describe("t-collaborators pipeline links collapse to the lead alone", () => {
  test("an empty effective list leaves the lead as the sole, final link", () => {
    const stage = { lead_agent: "aidlc-developer-agent", support_agents: ["aidlc-architect-agent"] };
    expect(pipelineLinks(stage)).toEqual(["aidlc-developer-agent", "aidlc-architect-agent"]);
    expect(pipelineLinks(stage, ["aidlc-architect-agent"])).toEqual(["aidlc-developer-agent", "aidlc-architect-agent"]);
    expect(pipelineLinks(stage, [])).toEqual(["aidlc-developer-agent"]);
  });
});

describe("t-collaborators effectiveSupportAgentsForProject reads the active workflow", () => {
  test("reverse-engineering runs lead-only on an off scope and keeps the architect on an on scope", () => {
    withEnvAndFreshCaches(POLICY_ENV, () => {
      const re = findStageBySlug("reverse-engineering");
      expect(re, "reverse-engineering must exist").toBeTruthy();

      const offProj = createTestProject();
      tempDirs.push(offProj);
      writeFileSync(seededStateFile(offProj), stateWithScope("feature"));
      expect(effectiveSupportAgentsForProject(offProj, re!)).toEqual([]);

      const onProj = createTestProject();
      tempDirs.push(onProj);
      writeFileSync(seededStateFile(onProj), stateWithScope("enterprise"));
      expect(effectiveSupportAgentsForProject(onProj, re!)).toEqual(re!.support_agents);

      // A per-run intent on an off scope restores the roster.
      const intentProj = createTestProject();
      tempDirs.push(intentProj);
      writeFileSync(
        seededStateFile(intentProj),
        stateWithScope("feature") + "- **Collaborators**: on (set by you)\n",
      );
      expect(effectiveSupportAgentsForProject(intentProj, re!)).toEqual(re!.support_agents);
    });
  });
});

function stateWithScope(scope: string): string {
  return `# AI-DLC State Tracking

## Project Information
- **Project**: collaborators switch test
- **Project Type**: Brownfield
- **Scope**: ${scope}
- **State Version**: 8

## Current Status
- **Current Stage**: reverse-engineering
- **Status**: In Progress
`;
}
