// covers: scope:classic
//
// A person move in a scope run, with no model (tests/harness/scope-run.ts):
// while a Unit is open the person installs a second tool, which writes AI-DLC's
// own .gitignore block and the root AGENTS.md. Those are AI-DLC's files, not a
// Unit's application source, so the stage completes with no refusal and
// nothing to say about them, under strict as under relaxed.

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTestProject } from "../harness/fixtures.ts";
import {
  AgentStandIn,
  auditEvents,
  createScopeProject,
  PersonScript,
  SCOPE_RUN_TIMEOUT_MS,
} from "../harness/scope-run.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const projects: string[] = [];
afterAll(() => {
  for (const proj of projects) cleanupTestProject(proj);
});

const SKIPPED = [
  "practices-discovery", "user-stories", "refined-mockups", "domain-design", "contract-design",
  "delivery-planning", "functional-design", "nfr-requirements", "nfr-design", "infrastructure-design",
];

describe("a second tool installed while a Unit is open", () => {
  for (const policy of ["strict", "relaxed"] as const) {
    test(`Guard Policy ${policy}: the install's own files are not the Unit's source, and the run reaches done`, () => {
      const { proj, host } = createScopeProject("empty");
      projects.push(proj);
      const person = new PersonScript(host);
      let installed = false;
      const gitignoreBefore = readFileSync(join(proj, ".gitignore"), "utf-8");
      const agent = new AgentStandIn(host, person, {
        units: ["core"],
        answers: {
          checkpoint: (unit, kind) => {
            if (unit === "core" && kind === "unit" && !installed) {
              installed = true;
              // The person adds Kiro CLI to the project before they answer.
              const res = spawnSync(process.execPath, [
                join(REPO_ROOT, "core", "tools", "aidlc-init.ts"),
                "config", "--project-dir", proj, "--from", join(REPO_ROOT, "dist-release", "kiro"),
                "--harness", "kiro", "--mcp", "none",
              ], { cwd: proj, env: host.env, encoding: "utf-8" });
              expect(res.status, res.stdout + res.stderr).toBe(0);
            }
            return "Approve";
          },
        },
      });
      const first = agent.begin("build the classic work", [
        "--scope", "classic", "--skip", SKIPPED.join(","),
        "--guard-policy", policy, "--review", "advisory", "--plan-approval", "on",
      ]);
      const final = agent.drive(first);
      expect(installed).toBe(true);
      // The install wrote its own files mid-Unit.
      expect(existsSync(join(proj, "AGENTS.md"))).toBe(true);
      expect(readFileSync(join(proj, ".gitignore"), "utf-8")).not.toBe(gitignoreBefore);
      expect(final.kind).toBe("done");
      expect(host.refusals).toEqual([]);
      const said = auditEvents(proj)
        .filter((e) => e.event === "CHANGE_ACCEPTED")
        .map((e) => e.block)
        .join("\n");
      expect(said).not.toContain("AGENTS.md");
      expect(said).not.toContain(".gitignore");
    }, SCOPE_RUN_TIMEOUT_MS);
  }
});
