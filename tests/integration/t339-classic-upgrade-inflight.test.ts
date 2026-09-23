// covers: scope:classic, scope:workshop, subcommand:aidlc-utility:intent-create,
// subcommand:aidlc-utility:status, subcommand:aidlc-utility:config-change,
// subcommand:aidlc-utility:scope-change, subcommand:aidlc-orchestrate:next,
// subcommand:aidlc-state:lookup
// covers: function:engineDir, function:engineDirFor, function:sensorsReadDir,
// function:completionCarriesVerifiedReview, function:readSummaryAuthorization,
// function:clearSummaryAuthorization

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import {
  clearSummaryAuthorization,
  completionCarriesVerifiedReview,
  engineDir,
  engineDirFor,
  getField,
  isReviewRecordRelativePath,
  loadStageGraph,
  parseCheckboxes,
  readAuditShardEvents,
  readBaselineSourceSnapshot,
  readSummaryAuthorization,
  reviewRecordDigest,
  reviewRequestBindingFromBlock,
  sensorsDir,
  sensorsReadDir,
  serializeReviewRecord,
  setCheckbox,
  setField,
  stateFilePath,
  summaryAuthorizationRecordPath,
  writeBaselineSourceSnapshot,
  writeSummaryAuthorization,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createOrchestrationTestProject,
  runOrchestrateNext,
} from "../harness/fixtures.ts";

const TOOLS = join(AIDLC_SRC, "tools");
const UTILITY = join(TOOLS, "aidlc-utility.ts");
const ORCHESTRATE = join(TOOLS, "aidlc-orchestrate.ts");
const STATE = join(TOOLS, "aidlc-state.ts");
const OPERATION_STAGES = [
  "deployment-pipeline",
  "environment-provisioning",
  "deployment-execution",
  "observability-setup",
  "incident-response",
  "performance-validation",
  "feedback-optimization",
];
const env = {
  ...process.env,
  AWS_AIDLC_DEFAULT_SCOPE: "",
  AIDLC_DISABLE_SENSORS: "0",
  AIDLC_DISABLE_LEARNINGS: "0",
  AIDLC_DISABLE_SUMMARY_CONFIRMATION: "0",
};
const projects: string[] = [];

afterEach(() => {
  while (projects.length > 0) cleanupTestProject(projects.pop()!);
});

function run(tool: string, project: string, args: string[]) {
  const result = spawnSync(process.execPath, [tool, ...args, "--project-dir", project], {
    cwd: project,
    env,
    encoding: "utf-8",
  });
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  return result.stdout;
}

function next(project: string): Record<string, unknown> {
  const result = runOrchestrateNext(ORCHESTRATE, project, [], { cwd: project, env });
  expect(result.status, result.out).toBe(0);
  expect(result.directive?.kind, result.out).toBe("run-stage");
  return result.directive!;
}

function legacyClassic() {
  const project = createOrchestrationTestProject();
  projects.push(project);
  // Workshop preserves the old classic membership, including all seven
  // Operation EXECUTEs. Only the state shape is downgraded, never dist data.
  run(UTILITY, project, ["intent-create", "--scope", "workshop", "--arguments", "in-flight classic upgrade", "--label", "classic-upgrade"]);
  const path = stateFilePath(project);
  let content = readFileSync(path, "utf-8");
  content = setField(content, "Scope", "classic");
  content = setField(content, "Change Control", "relaxed (from scope classic)");
  content = setField(content, "Review Override", "");
  content = setField(content, "Test Strategy", "Standard");
  content = content.replace(/^- \*\*(Sensors|Learnings|Summary Confirmation)\*\*:.*\n/gm, "");
  // Seed completed history through the end of Construction with the same state
  // helpers as existing deterministic routing fixtures. CI Pipeline is already
  // complete so the next-stage lookup after Build and Test reaches Operation.
  const planned = new Map(parseCheckboxes(content).map((entry) => [entry.slug, entry]));
  for (const stage of loadStageGraph()) {
    if (stage.phase !== "operation" && planned.get(stage.slug)?.suffix === "EXECUTE") {
      content = setCheckbox(content, stage.slug, "completed");
    }
  }
  for (const [field, value] of [
    ["Current Stage", "build-and-test"],
    ["Last Completed Stage", "build-and-test"],
    ["Next Stage", "deployment-pipeline"],
    ["Lifecycle Phase", "CONSTRUCTION"],
    ["Status", "Running"],
  ]) content = setField(content, field, value);
  writeFileSync(path, content);
  return { project, path, content };
}

describe("t339 upgrading an in-flight classic intent", () => {
  for (const unit of [null, "api"]) {
    test(`legacy ${unit ?? "stage"} review audit paths still verify without moving their records`, () => {
      const { project, path } = legacyClassic();
      const record = dirname(path);
      const stage = "requirements-analysis";
      const fingerprint = `sha256:${"a".repeat(64)}`;
      const requestId = `review:${"b".repeat(32)}`;
      const scopePath = unit === null ? "stage" : `units/${unit}`;
      const legacyPath = `.aidlc-reviews/${stage}/${scopePath}/0123456789abcdef/1.json`;
      const currentPath = `.aidlc-engine/reviews/${stage}/${scopePath}/0123456789abcdef/1.json`;
      const bytes = serializeReviewRecord({
        version: 1, stage, unit, workflow: null, attempt: "0123456789abcdef",
        iteration: 1, reviewer: "aidlc-product-lead-agent", verdict: "READY",
        request_id: requestId, request_challenge: null,
        artifact_fingerprint: fingerprint, source_fingerprint: null,
        unit_source_fingerprint: null, findings: [], body: "**Verdict:** READY\n",
        recorded_at: "2026-09-14T00:00:00Z",
      });
      mkdirSync(dirname(join(record, legacyPath)), { recursive: true });
      writeFileSync(join(record, legacyPath), bytes);
      const fields = {
        Stage: stage, Reviewer: "aidlc-product-lead-agent", Iteration: "1",
        ...(unit === null ? {} : { Unit: unit }),
        "Artifact Fingerprint": fingerprint, "Request Id": requestId,
      };
      appendAuditEntry("REVIEW_REQUESTED", fields, project);
      appendAuditEntry("REVIEW_COMPLETED", {
        ...fields, Verdict: "READY", "Request Fingerprint": fingerprint,
        "Review Record": legacyPath, "Review Record Digest": reviewRecordDigest(bytes),
      }, project);
      const events = readAuditShardEvents(project);
      const request = reviewRequestBindingFromBlock(events.find((event) => event.event === "REVIEW_REQUESTED")!.block)!;
      const completion = events.find((event) => event.event === "REVIEW_COMPLETED")!.block;
      expect(request).not.toBeNull();
      expect(isReviewRecordRelativePath(legacyPath)).toBe(true);
      expect(isReviewRecordRelativePath(currentPath)).toBe(true);
      expect(isReviewRecordRelativePath(legacyPath.replace(stage, ".."))).toBe(false);
      expect(completionCarriesVerifiedReview(project, request, completion)).toBe(true);
      expect(existsSync(join(record, currentPath))).toBe(false);
      mkdirSync(dirname(join(record, currentPath)), { recursive: true });
      writeFileSync(join(record, currentPath), "another record");
      expect(completionCarriesVerifiedReview(project, request, completion)).toBe(true);
      writeFileSync(join(record, legacyPath), `${bytes}\n`);
      expect(completionCarriesVerifiedReview(project, request, completion)).toBe(false);
    });
  }

  test("legacy sensor findings are readable only until the new directory exists", () => {
    const { project, path } = legacyClassic();
    const record = dirname(path);
    const legacy = join(record, ".aidlc-sensors");
    const current = join(record, ".aidlc-engine", "sensors");
    mkdirSync(legacy);
    writeFileSync(join(legacy, "finding.md"), "old finding\n");
    expect(engineDir(project)).toBe(engineDirFor(record));
    expect(sensorsDir(project)).toBe(current);
    expect(sensorsReadDir(project)).toBe(legacy);
    expect(readFileSync(join(sensorsReadDir(project), "finding.md"), "utf-8")).toBe("old finding\n");
    expect(existsSync(current)).toBe(false);
    mkdirSync(sensorsDir(project), { recursive: true });
    expect(sensorsReadDir(project)).toBe(current);
    expect(existsSync(join(sensorsReadDir(project), "finding.md"))).toBe(false);
    expect(readFileSync(join(legacy, "finding.md"), "utf-8")).toBe("old finding\n");
    rmSync(engineDir(project), { recursive: true });
    writeFileSync(engineDir(project), "not a directory");
    expect(sensorsReadDir(project)).toBe(current);
  });

  test("legacy source-review baselines still verify until the stage's new snapshot directory exists", () => {
    const { project, path } = legacyClassic();
    const record = dirname(path);
    const stage = "requirements-analysis";
    // Canonical listing entries: `<repo>\0<path>` keys and `<mode> <blob-sha>` values.
    const key = `app\0src/app.ts`;
    const listing = new Map([[key, `100644 ${"a".repeat(40)}`]]);
    // Recorded before the move: write with the current writer, then relocate the
    // whole tree to where a pre-upgrade intent left it.
    const fingerprint = writeBaselineSourceSnapshot(project, stage, listing);
    const current = join(record, ".aidlc-engine", "source-review");
    const legacy = join(record, ".aidlc-source-review");
    renameSync(current, legacy);
    expect(existsSync(current)).toBe(false);
    const fromLegacy = readBaselineSourceSnapshot(project, stage, fingerprint);
    expect(fromLegacy).not.toBeNull();
    expect(fromLegacy?.get(key)).toBe(`100644 ${"a".repeat(40)}`);
    // The fallback is per stage: another stage's new snapshot directory does not
    // hide this stage's legacy baseline ...
    mkdirSync(join(current, "user-stories"), { recursive: true });
    expect(readBaselineSourceSnapshot(project, stage, fingerprint)).not.toBeNull();
    // ... but once this stage has a new directory, only that one is read.
    mkdirSync(join(current, stage), { recursive: true });
    expect(readBaselineSourceSnapshot(project, stage, fingerprint)).toBeNull();
    expect(existsSync(join(legacy, stage))).toBe(true);
  });

  test("summary reads fall back by directory, while new writes and clears never mutate legacy authorization", () => {
    const { project, path } = legacyClassic();
    const record = dirname(path);
    const stage = "requirements-analysis";
    const legacy = join(record, ".aidlc-summary-authorization", stage, "stage.json");
    const current = summaryAuthorizationRecordPath(record, stage, null);
    const authorization = {
      version: 1 as const, id: "1".repeat(64), stage, unit: null, workflow: null,
      attempt: "unstarted", questions_file: "inception/requirements-analysis/questions.md",
      questions_sha256: "a".repeat(64), choice: "Looks correct",
      recorded_at: "2026-09-14T00:00:00Z",
    };
    const legacyBytes = JSON.stringify(authorization);
    mkdirSync(dirname(legacy), { recursive: true });
    writeFileSync(legacy, legacyBytes);
    expect(readSummaryAuthorization(project, stage, null)).toEqual(authorization);
    expect(existsSync(current)).toBe(false);
    writeSummaryAuthorization(project, { ...authorization, id: "2".repeat(64) });
    expect(readSummaryAuthorization(project, stage, null)?.id).toBe("2".repeat(64));
    rmSync(current);
    expect(readSummaryAuthorization(project, stage, null)).toBeNull();
    writeFileSync(current, "malformed");
    expect(readSummaryAuthorization(project, stage, null)).toBeNull();
    rmSync(join(engineDir(project), "summary-authorization"), { recursive: true });
    expect(readSummaryAuthorization(project, stage, null)?.id).toBe(authorization.id);
    clearSummaryAuthorization(project, stage, null);
    expect(readSummaryAuthorization(project, stage, null)).toBeNull();
    expect(readFileSync(legacy, "utf-8")).toBe(legacyBytes);
  });

  test("routing, lookup, and status retain recorded Operation membership", () => {
    const { project, path, content } = legacyClassic();
    const recorded = parseCheckboxes(content).filter((entry) => OPERATION_STAGES.includes(entry.slug));
    expect(recorded.map((entry) => entry.slug)).toEqual(OPERATION_STAGES);
    expect(recorded.every((entry) => entry.suffix === "EXECUTE")).toBe(true);

    const directive = next(project);
    expect(directive.stage).toBe("deployment-pipeline");
    expect(run(STATE, project, ["lookup", "next-stage", "build-and-test", "classic"]).trim()).toBe("deployment-pipeline");
    const status = run(UTILITY, project, ["status"]);
    expect(status).toMatch(/^\s*OPERATION\s+\S+\s+0\/7$/m);
    expect(status).toContain("Next Stage:     deployment-pipeline\n");
    expect(readFileSync(path, "utf-8")).toBe(content);
  });

  test("missing ceremony rows enable sensors and learnings and a config update enables summary confirmation", () => {
    const { project, path } = legacyClassic();
    const status = run(UTILITY, project, ["status"]);
    for (const field of ["Sensors", "Learnings", "Summary Confirmation"]) {
      expect(status).toContain(`${field}: ${field === "Summary Confirmation" ? "off" : "on"} (from scope classic)\n`);
      expect(getField(readFileSync(path, "utf-8"), field)).toBeNull();
    }
    const defaults = next(project);
    expect(defaults.ceremony).toEqual({ sensors: "on", learnings: "on", summary_confirmation: "off" });
    expect(defaults.sensors_applicable).toEqual(["required-sections", "upstream-coverage"]);
    expect(defaults.protocol_modules).toContain("learnings");

    run(UTILITY, project, ["config-change", "--sensors", "on", "--learnings", "on", "--summary-confirmation", "on"]);
    for (const field of ["Sensors", "Learnings", "Summary Confirmation"]) {
      expect(getField(readFileSync(path, "utf-8"), field)).toBe("on (set by you)");
    }
    const restored = next(project);
    expect(restored.stage).toBe("deployment-pipeline");
    expect(restored.ceremony).toEqual({ sensors: "on", learnings: "on", summary_confirmation: "on" });
    expect(restored.sensors_applicable).toEqual(["required-sections", "upstream-coverage"]);
    expect(restored.protocol_modules).toContain("learnings");
  }, 15_000); // Setup and four real CLI handshakes exceeded the macOS 5s default.

  test("classic caps an adversarial override to advisory, while a none override still silences the reviewer", () => {
    const { project, path } = legacyClassic();
    run(UTILITY, project, ["config-change", "--review", "adversarial"]);
    // "adversarial" is no per-run ceiling, so the field stays empty (stage defaults).
    expect(getField(readFileSync(path, "utf-8"), "Review Override")).toBe("");
    // Revisit a reviewer-bearing stage without asking an isolated runner, which
    // deliberately ignores the active intent's saved overrides.
    let content = setCheckbox(readFileSync(path, "utf-8"), "requirements-analysis", "in-progress");
    for (const [field, value] of [
      ["Current Stage", "requirements-analysis"],
      ["Lifecycle Phase", "INCEPTION"],
      ["Last Completed Stage", "practices-discovery"],
      ["Next Stage", "user-stories"],
    ]) content = setField(content, field, value);
    writeFileSync(path, content);
    // Low wins: the scope's advisory cap lowers the adversarial override.
    const capped = next(project);
    expect(capped.stage).toBe("requirements-analysis");
    expect(capped.reviewer).toBe("aidlc-product-lead-agent");
    expect(capped.review_class).toBe("advisory");
    expect(capped.reviewer_max_iterations).toBe(1);

    // An explicit none override sits below the cap and removes the reviewer block.
    run(UTILITY, project, ["config-change", "--review", "none"]);
    const silenced = next(project);
    expect(silenced.stage).toBe("requirements-analysis");
    expect(silenced.reviewer).toBeUndefined();
    expect(silenced.review_class).toBeUndefined();

    // The saved override survives a scope change to workshop (same advisory cap).
    run(UTILITY, project, ["scope-change", "--scope", "workshop"]);
    const workshop = next(project);
    expect(workshop.stage).toBe("requirements-analysis");
    expect(workshop.reviewer).toBeUndefined();
    expect(getField(readFileSync(path, "utf-8"), "Review Override")).toBe("none");
    // Keep the complete override history together. Hosted Windows exhausted
    // the former 10s cap at the final next handshake; ordinary runs stay fast.
  }, process.platform === "win32" ? 30_000 : 10_000);
});
