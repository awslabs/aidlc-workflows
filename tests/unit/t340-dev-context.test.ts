// covers: file:core/tools/aidlc-dev-context.ts
//
// t340 - the developer-facing context bundle. Runs against the REAL compiled graph
// and coverage registry, not fixtures: the bundle's value is being true about this
// tree, and a fixture would let it drift while staying green.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type Bundle,
  buildBundle,
  protocolModulesFor,
  renderHuman,
} from "../../core/tools/aidlc-dev-context.ts";
import { loadStageGraphAll } from "../../core/tools/aidlc-lib.ts";
import { REPO_ROOT } from "../harness/fixtures.ts";

function lines(bundle: Bundle, headingFragment: string): string[] {
  const section = bundle.sections.find((s) => s.heading.includes(headingFragment));
  return section?.lines ?? [];
}

/** Every repo-relative path the bundle emits, across ALL sections - not just the
 *  "Read these" block. Scoping this to one section is what let install-layout sensor
 *  paths ship as dead links in a source checkout. */
function emittedPaths(bundle: Bundle): string[] {
  const out: string[] = [];
  for (const section of bundle.sections) {
    for (const line of section.lines) {
      for (const token of line.split(/[\s]+/)) {
        const p = token.trim();
        // Repo-relative file paths only: skip workspace paths under aidlc/ (created
        // per project at runtime, absent in a bare checkout) and glob patterns.
        if (!/^(core|\.claude|tests|docs|scripts|harness)\//.test(p)) continue;
        if (p.includes("*")) continue;
        if (!out.includes(p)) out.push(p);
      }
    }
  }
  return out;
}

describe("t340 dev-context bundles", () => {
  test("a stage bundle resolves identity, protocol modules, and artifact flow", () => {
    const b = buildBundle("stage:requirements-analysis");
    expect(b.found).toBe(true);
    expect(b.kind).toBe("stage");

    const identity = lines(b, "Identity").join("\n");
    expect(identity).toContain("requirements-analysis");
    expect(identity).toContain("inception");

    // The reviewer module is the one this stage earns: it declares a reviewer and
    // a review class, and is neither construction nor an ensemble mode.
    const read = lines(b, "Read these").join("\n");
    expect(read).toContain("stage-protocol.md");
    expect(read).toContain("stage-protocol-reviewer.md");
    expect(read).not.toContain("stage-protocol-construction.md");

    const flow = lines(b, "Artifact flow").join("\n");
    expect(flow).toContain("produces    requirements");
    expect(flow).toContain("requires    stage approval-handoff");
  });

  test("every path a stage bundle emits exists on disk", () => {
    // A bundle of wrong paths is worse than none: it sends the reader somewhere
    // confidently. Several phases, so the phase segment is covered too.
    for (const slug of ["requirements-analysis", "code-generation", "intent-capture"]) {
      const b = buildBundle(`stage:${slug}`);
      expect(b.found, `${slug} should resolve`).toBe(true);
      const paths = emittedPaths(b);
      expect(paths.length, `${slug} should emit paths`).toBeGreaterThan(3);
      for (const p of paths) {
        expect(existsSync(join(REPO_ROOT, p)), `${slug}: ${p} should exist`).toBe(true);
      }
    }
  });

  test("this file accounts for every module the engine can push", () => {
    // The guard that matters: restating the engine's conditions below only proves the
    // mirror agrees with itself. When ceremony switches added a fourth push,
    // `learnings`, both sides omitted it. So enumerate the engine's pushes from source.
    const engine = readFileSync(
      join(REPO_ROOT, "core", "tools", "aidlc-orchestrate.ts"), "utf-8",
    );
    const pushed = [...engine.matchAll(/protocolModules\.push\("([a-z-]+)"\)/g)]
      .map((m) => m[1]);
    expect(pushed.length).toBeGreaterThan(3);
    // push() sites only: the engine's direct ["construction", "swarm"] assignment
    // belongs to invoke-swarm, a directive kind this bundle does not model.
    const tool = readFileSync(
      join(REPO_ROOT, "core", "tools", "aidlc-dev-context.ts"), "utf-8",
    );
    // Word match: a module may be handled via a policy field (`.learnings`) or named
    // in output rather than appearing as a literal `"name"`.
    const unhandled = [...new Set(pushed)]
      .filter((m) => !new RegExp(`\\b${m}\\b`).test(tool));
    expect(unhandled, "dev-context must account for every engine protocol module")
      .toEqual([]);
  });

  test("node-derived protocol modules match the engine's rule for every shipped stage", () => {
    const nodes = loadStageGraphAll();
    expect(nodes.length).toBeGreaterThan(20);
    for (const node of nodes) {
      const expected: string[] = [];
      if (node.reviewer && node.review_class) expected.push("reviewer");
      if (
        node.mode === "subagent" || node.mode === "pipeline" || node.mode === "mob" ||
        (node.support_agents?.length ?? 0) > 0
      ) {
        expected.push("ensemble");
      }
      if (node.phase === "construction") expected.push("construction");
      expect(protocolModulesFor(node), `modules for ${node.slug}`).toEqual(expected);
    }
  });

  test("hook, tool, and agent bundles resolve their real wiring", () => {
    const hook = buildBundle("hook:aidlc-run-sensors");
    expect(hook.found).toBe(true);
    expect(lines(hook, "Wired by").join("\n")).toContain("adapter");

    const tool = buildBundle("tool:aidlc-graph");
    expect(tool.found).toBe(true);
    // It is in the dispatcher's TOOLS map, so the wiring section must find it.
    expect(lines(tool, "Dispatcher wiring").join("\n")).toContain("aidlc-graph.ts");

    const agent = buildBundle("agent:aidlc-architect-agent");
    expect(agent.found).toBe(true);
    const stages = lines(agent, "Stages").join("\n");
    expect(stages).toContain("domain-design");
    expect(stages).toContain("supports");
  });

  test("a test bundle separates the authored header from what the registry enumerated", () => {
    // t243's `tool:`/`file:` covers classes are not enumerated units, so zero registry
    // units is correct there - the two views must be separate or the header looks absent.
    const b = buildBundle("test:t243-install-mechanism.test.ts");
    const declared = lines(b, "Declared in its covers");
    expect(declared.some((l) => l.startsWith("tool:aidlc-init"))).toBe(true);
    expect(b.found).toBe(true);
  });

  test("an unknown id is reported, not thrown, and suggests near matches", () => {
    const b = buildBundle("stage:requirements");
    expect(b.found).toBe(false);
    expect(b.notes.join("\n")).toContain("requirements-analysis");
  });

  test("a malformed or unknown target is a typed error", () => {
    expect(() => buildBundle("requirements-analysis")).toThrow(/<kind>:<id>/);
    expect(() => buildBundle("stage:")).toThrow(/names no id/);
    expect(() => buildBundle("banana:x")).toThrow(/Unknown target kind/);
  });

  test("the tool is registered on the compiled delegate path", () => {
    // The defect this pins: a TOOLS entry with no `case` in loadDelegate. Only the
    // COMPILED dispatcher resolves through that switch; running the dispatcher under
    // bun takes the spawn path instead, so a behavioural probe here passes either
    // way (measured: removing the case left a spawn-based probe green). Assert the
    // registry and the switch structurally, which is what actually catches it.
    const src = readFileSync(join(REPO_ROOT, "core", "tools", "aidlc.ts"), "utf-8");
    const toolsStart = src.indexOf("export const TOOLS = {");
    expect(toolsStart).toBeGreaterThan(0);
    const toolsBlock = src.slice(toolsStart, src.indexOf("} as const;", toolsStart));
    expect(toolsBlock).toContain('devContext: "aidlc-dev-context.ts"');

    // Registration must exist; its SHAPE must not be pinned. #1115 replaces the switch
    // with a typed Record, deleting every `case TOOLS.x` line, so accept either. Scoped
    // to this tool: whole-registry exhaustiveness is #1115's to close.
    const registered = src.includes("case TOOLS.devContext:") ||
      /["']aidlc-dev-context\.ts["']\s*:\s*\(\)\s*=>/.test(src);
    expect(registered, "dev-context must be reachable on the compiled delegate path")
      .toBe(true);
  });

  test("the human rendering is stable and names every section it carries", () => {
    const b = buildBundle("stage:requirements-analysis");
    const text = renderHuman(b);
    expect(text.startsWith("# stage:requirements-analysis")).toBe(true);
    for (const s of b.sections) expect(text).toContain(`## ${s.heading}`);
  });
});
