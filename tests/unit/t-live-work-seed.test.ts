// covers: file:tests/harness/live-work-seed.ts
//
// The t126 and t138 live legs start from seeded work. This runs each seed on its
// own, on a fresh project, the step the live legs run before their first turn:
// the work's description, as the stages read it for `[desc]`, is the person's
// request and never the engine's "[Project description]" placeholder, which no
// person's start makes.
//
// Mechanism: CLI - the project's own `intent-create` and `project-description`;
// no agent runs.
import { afterEach, describe, setDefaultTimeout, test } from "bun:test";
import { cleanupTestProject, setupIntegrationProject } from "../harness/fixtures.ts";
import { T126_SEED, T138_SEED, seedLiveWork } from "../harness/live-work-seed.ts";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS } from "../harness/test-budget.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const projects: string[] = [];
afterEach(() => {
  for (const proj of projects.splice(0)) cleanupTestProject(proj);
});

describe("live leg seeds carry the person's request", () => {
  for (const [leg, seed] of [["t126", T126_SEED], ["t138", T138_SEED]] as const) {
    test(`${leg}: the seeded work's description is the request the leg types`, () => {
      const proj = setupIntegrationProject({ noAidlcDocs: true });
      projects.push(proj);
      seedLiveWork(proj, seed, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
    });
  }
});
