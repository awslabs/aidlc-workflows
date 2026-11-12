// covers: subcommand:aidlc-utility:config-change, subcommand:aidlc-orchestrate:next,
// covers: audit:REVIEW_REQUESTED, audit:REVIEW_COMPLETED, audit:REVIEW_GRANULARITY_CHANGED
//
// Review granularity in a full scope run with no model
// (tests/harness/scope-run.ts): the real CLI, the real hooks, the production
// guard profile, and a person who flips the setting mid-run in their own
// words. mvp, driven from the first request into Construction:
//
//   - The person types `/aidlc config set review-granularity phase` right
//     after approving Intent Capture (a stage already reviewed per stage).
//   - Every later ideation/inception reviewed stage still gets its own
//     REVIEW_COMPLETED receipt, but the reviewer runs only at the anchors:
//     rough-mockups (its group-mate intent-capture already holds a fresh
//     receipt, so review_covers omits it — the mixed-history rule), then
//     refined-mockups covering requirements-analysis + user-stories, then
//     contract-design covering domain-design + units-generation.
//   - Deferred stages' directives carry no reviewer block, and their gates
//     approve without a receipt; the anchors' gates stand on every covered
//     receipt (the run reaching Construction proves both).
//   - audit/review-metrics.jsonl rows carry the effective granularity.

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTestProject } from "../harness/fixtures.ts";
import {
  type AgentStandIn,
  auditEvents,
  type Directive,
  field,
  runScope,
  SCOPE_RUN_TIMEOUT_MS,
  type ScopeRun,
} from "../harness/scope-run.ts";

const runs: ScopeRun[] = [];
afterAll(() => {
  for (const run of runs) cleanupTestProject(run.proj);
});

const REVIEWED_PROSE_STAGES = [
  "intent-capture",
  "rough-mockups",
  "requirements-analysis",
  "user-stories",
  "refined-mockups",
  "domain-design",
  "units-generation",
  "contract-design",
];

describe("review granularity phase, flipped mid-run in the person's words", () => {
  test("defers to the anchors, keeps per-stage receipts, and logs the metrics", () => {
    let flipped = false;
    let rogueRefusal = "";
    let construction: Directive | null = null;
    const run = runScope("mvp", {
      afterApproval: (stage: string, agent: AgentStandIn) => {
        if (flipped || stage !== "intent-capture") return undefined;
        flipped = true;
        const answer = agent.personTypes("/aidlc config set review-granularity phase");
        expect(answer.kind).toBe("print");
        if (agent.actOnPrint(answer)) return agent.personTypes("/aidlc");
        return undefined;
      },
      atGate: (stage, _unit, agent) => {
        if (stage !== "user-stories") return;
        // The misbehaving-agent scenario the field runs showed: the stage file
        // names a reviewer, so the agent dispatches one anyway. The ENGINE
        // refuses it, naming the anchor, so the grouping holds regardless of
        // the model.
        rogueRefusal = agent.host.bash(
          "bun .claude/tools/aidlc.ts engine log review --stage user-stories --reviewer aidlc-product-lead-agent --iteration 1",
        ).stderr;
      },
      until: (d) => {
        if (d.kind === "run-stage" && d.stage === "functional-design") construction = d;
        return construction !== null;
      },
    });
    runs.push(run);

    // The setter answered in plain words and audited the change.
    expect(run.host.trace.join("\n")).toContain("grouped per reviewer late in each phase");
    expect(auditEvents(run.proj).filter((e) => e.event === "REVIEW_GRANULARITY_CHANGED")).toHaveLength(1);

    // Reviewer blocks appear ONLY on intent-capture (pre-flip) and the anchors.
    const reviewed = run.agent.directives
      .filter((d) => d.kind === "run-stage" && typeof d.reviewer === "string"
        && REVIEWED_PROSE_STAGES.includes(String(d.stage)))
      .map((d) => [String(d.stage), (d.review_covers as Array<{ slug: string }> | undefined)?.map((c) => c.slug) ?? []] as const);
    const byStage = new Map(reviewed);
    expect([...byStage.keys()].sort()).toEqual(
      ["contract-design", "intent-capture", "refined-mockups", "rough-mockups"],
    );
    // Mixed history: intent-capture's fresh receipt keeps it out of the
    // rough-mockups anchor's covers.
    expect(byStage.get("rough-mockups")).toEqual([]);
    expect(byStage.get("refined-mockups")).toEqual(["requirements-analysis", "user-stories"]);
    expect(byStage.get("contract-design")).toEqual(["domain-design", "units-generation"]);
    // The deferred stages' directives carried no reviewer block, and named
    // their anchor for the gate's one plain-words sentence.
    const anchors: Record<string, string> = {
      "requirements-analysis": "refined-mockups",
      "user-stories": "refined-mockups",
      "domain-design": "contract-design",
      "units-generation": "contract-design",
    };
    for (const d of run.agent.directives) {
      if (d.kind !== "run-stage") continue;
      const anchor = anchors[String(d.stage)];
      if (anchor === undefined) continue;
      expect(d.reviewer, String(d.stage)).toBeUndefined();
      expect((d.review_deferred as { anchor?: string } | undefined)?.anchor, String(d.stage)).toBe(anchor);
    }

    // Every reviewed prose stage still holds its own terminal receipt.
    const completed = auditEvents(run.proj)
      .filter((e) => e.event === "REVIEW_COMPLETED")
      .map((e) => field(e.block, "Stage"));
    for (const slug of REVIEWED_PROSE_STAGES) {
      expect(completed, slug).toContain(slug);
    }

    // The measurement file marks the pre-flip review stage and later phase.
    const intents = join(run.proj, "aidlc", "spaces", "default", "intents");
    const metrics = readdirSync(intents)
      .flatMap((name) => {
        const audit = join(intents, name, "audit");
        return existsSync(audit)
          ? readdirSync(audit).filter((f) => /^review-metrics-.*\.jsonl$/.test(f)).map((f) => join(audit, f))
          : [];
      })[0];
    expect(metrics, intents).toBeDefined();
    const rows = readFileSync(metrics!, "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const byGranularity = (g: string) => rows.filter((r) => r.granularity === g).map((r) => r.stage);
    expect(byGranularity("stage")).toContain("intent-capture");
    for (const slug of REVIEWED_PROSE_STAGES.filter((s) => s !== "intent-capture")) {
      expect(byGranularity("phase"), slug).toContain(slug);
    }

    // The engine, not the prose, refused the rogue per-stage dispatch.
    expect(rogueRefusal).toContain("Refined Mockups");
    expect(rogueRefusal).toContain("--covered-by");

    // The run reached Construction: every deferred gate opened without a
    // receipt and both anchors' gates stood on their covered receipts.
    expect(construction).not.toBeNull();
  }, SCOPE_RUN_TIMEOUT_MS);
});
