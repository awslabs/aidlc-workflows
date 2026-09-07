// covers: subcommand:aidlc-attest:resolve
// covers: subcommand:aidlc-attest:anchor
// covers: subcommand:aidlc-attest:help
// covers: audit:SOURCE_COMMITTED
//
// t312 - aidlc-attest commit provenance CLI. Attribution is a pure function of
// repository content (committed REVIEW_COMPLETED receipts + committed
// reviewed-source evidence), so plain `git add -A && git commit` runs made by
// a human — no hooks, no trailers, no tool-mediated commit — must resolve.
// This suite drives real reviews through aidlc-log, then commits manually and
// pins: resolve's six path statuses and exit codes (0 resolved / 1 usage /
// 3 --fail-on match), evidence fallback order (committed then local, fail
// closed when neither binds), cross-shard timestamp ties failing closed, and
// anchor's SOURCE_COMMITTED enrichment (dedupe, SWARM_SOURCE_MERGED respect,
// bounded --reconcile sweeps). The last case fires the REAL session-start
// hook (the workflow's automatic anchoring path — commits happen between
// sessions, so the next session start is when the sweep runs) and pins its
// reconcile sweep, idempotence, the compact/probe gate, and the
// AIDLC_SKIP_SESSION_ANCHOR switch.

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import {
  readAllAuditShards,
  workspaceSourceListing,
  writeBaselineSourceSnapshot,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { AIDLC_SRC, FIXTURES_DIR } from "../harness/fixtures.ts";

const ATTEST = join(AIDLC_SRC, "tools", "aidlc-attest.ts");
const LOG = join(AIDLC_SRC, "tools", "aidlc-log.ts");
const SESSION_START_HOOK = join(AIDLC_SRC, "hooks", "aidlc-session-start.ts");
const REVIEWER = "aidlc-architecture-reviewer-agent";
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(dir: string, args: string[]): string {
  const result = spawnSync("git", ["-C", dir, ...args], { encoding: "utf-8" });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return (result.stdout ?? "").trim();
}

function commitAll(project: string, message: string): string {
  git(project, ["add", "-A"]);
  git(project, ["commit", "-qm", message]);
  return git(project, ["rev-parse", "HEAD"]);
}

function fixture(): { project: string; record: string } {
  const project = mkdtempSync(join(tmpdir(), "aidlc-t312-"));
  dirs.push(project);
  const record = join(project, "aidlc", "spaces", "default", "intents", "fixture-intent");
  mkdirSync(record, { recursive: true });
  writeFileSync(join(record, "aidlc-state.md"), "# State\n- **Scope**: feature\n", "utf-8");
  writeFileSync(join(project, "aidlc", "spaces", "default", "intents", "intents.json"), `${JSON.stringify([{ uuid: "80000000-0000-4000-8000-000000000001", slug: "fixture", dirName: "fixture-intent", status: "active", repos: [] }])}\n`);
  writeFileSync(join(project, "aidlc", "spaces", "default", "intents", ".active-intent"), "fixture-intent\n");
  git(project, ["init", "-q"]); git(project, ["config", "user.email", "t@test"]); git(project, ["config", "user.name", "t"]);
  writeFileSync(join(project, "app.ts"), "export const app = 1;\n");
  commitAll(project, "seed");
  return { project, record };
}

function runtimeFixture(): { project: string; record: string } {
  const { project, record } = fixture();
  let state = readFileSync(join(FIXTURES_DIR, "state-mid-ideation.md"), "utf-8");
  state = state
    .replace("- **Current Stage**: feasibility", "- **Current Stage**: code-generation\n- **Construction Iteration**: stage-major")
    .replace("- [ ] code-generation — EXECUTE", "- [?] code-generation — EXECUTE");
  writeFileSync(join(record, "aidlc-state.md"), state, "utf-8");
  const dag = join(record, "inception", "units-generation");
  mkdirSync(dag, { recursive: true });
  writeFileSync(join(dag, "unit-of-work-dependency.md"), "```yaml\nunits:\n  - name: alpha\n    depends_on: []\n  - name: beta\n    depends_on: []\n```\n");
  const listing = workspaceSourceListing(project);
  if (listing === null) throw new Error("runtime fixture source listing missing");
  const baseline = writeBaselineSourceSnapshot(project, "code-generation", listing);
  appendAuditEntry("WORKFLOW_STARTED", { Scope: "feature", "Source Baseline": baseline }, project);
  appendAuditEntry("STAGE_STARTED", {
    Stage: "code-generation",
    Agent: "aidlc-developer-agent",
    "Source Baseline": baseline,
  }, project);
  // Audit timestamps are second-precision; wait out the boundary second so
  // in-process fixture rows never tie with the child-process review receipts.
  const boundarySecond = Math.floor(Date.now() / 1000);
  while (Math.floor(Date.now() / 1000) === boundarySecond) {}
  return { project, record };
}

function writeManifest(record: string, unit: string, writes: Array<{ path: string; repo?: string }>): void {
  const dir = join(record, "construction", unit, "code-generation");
  mkdirSync(dir, { recursive: true });
  for (const name of ["code-generation-plan.md", "unit-test-instructions.md", "code-summary.md", "traceability.json"])
    if (!existsSync(join(dir, name))) writeFileSync(join(dir, name), name.endsWith(".json") ? "{}\n" : `# ${name}\n`);
  writeFileSync(join(dir, "source-manifest.json"), `${JSON.stringify({ stage: "code-generation", unit, version: 1, writes }, null, 2)}\n`);
}

function cli(tool: string, args: string[], project: string): { rc: number; stdout: string; stderr: string } {
  const env = { ...process.env, AIDLC_SKIP_ARTIFACT_GUARD: "1", AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "1", AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS: "1", AIDLC_SKIP_REVISION_BACKSTOP: "1" };
  const r = spawnSync(process.execPath, [tool, ...args, "--project-dir", project], { encoding: "utf-8", env });
  return { rc: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function review(project: string, record: string, unit: string, writes: Array<{ path: string; repo?: string }>): void {
  writeManifest(record, unit, writes);
  const prior = (readAllAuditShards(project).match(new RegExp(`\\*\\*Event\\*\\*: REVIEW_REQUESTED[\\s\\S]*?\\*\\*Unit\\*\\*: ${unit}`, "g")) ?? []).length;
  const args = ["review", "--stage", "code-generation", "--reviewer", REVIEWER, "--unit", unit, "--iteration", String(prior + 1)];
  const request = cli(LOG, args, project);
  if (request.rc !== 0) throw new Error(`review request failed: ${request.stdout}${request.stderr}`);
  const verdict = cli(LOG, [...args, "--verdict", "READY"], project);
  if (verdict.rc !== 0) throw new Error(`review verdict failed: ${verdict.stdout}${verdict.stderr}`);
}

function attest(args: string[], project: string): { rc: number; stdout: string; stderr: string } {
  return cli(ATTEST, args, project);
}

function pathStatus(report: { paths: Array<{ path: string; status: string; reason?: string; unit?: string; intent?: string }> }, path: string) {
  return report.paths.find((entry) => entry.path === path);
}

describe("t312 aidlc-attest resolve/anchor", () => {
  test("help prints usage; malformed invocations exit 1 with a JSON error envelope", () => {
    const project = mkdtempSync(join(tmpdir(), "aidlc-t312-"));
    dirs.push(project);

    const help = attest(["help"], project);
    expect(help.rc).toBe(0);
    expect(help.stdout).toContain("aidlc attest resolve");
    expect(help.stdout).toContain("aidlc attest anchor");
    expect(attest([], project).stdout).toContain("Usage:"); // bare invocation = usage, exit 0

    const unknown = attest(["bogus"], project);
    expect(unknown.rc).toBe(1);
    expect(unknown.stdout).toBe("");
    expect(JSON.parse(unknown.stderr).error).toBe("Unknown subcommand: bogus. Valid: resolve, anchor, help");

    const badFlag = attest(["resolve", "--nope"], project);
    expect(badFlag.rc).toBe(1);
    expect(JSON.parse(badFlag.stderr).error).toContain("unknown or valueless flag --nope");

    const twoPositionals = attest(["resolve", "abc", "def"], project);
    expect(twoPositionals.rc).toBe(1);
    expect(JSON.parse(twoPositionals.stderr).error).toContain("at most one <commit> positional");

    const anchorPositional = attest(["anchor", "abc"], project);
    expect(anchorPositional.rc).toBe(1);
    expect(JSON.parse(anchorPositional.stderr).error).toContain("anchor takes no positionals");

    const bothSelectors = attest(["resolve", "abc", "--diff", "a..b"], project);
    expect(bothSelectors.rc).toBe(1);
    expect(JSON.parse(bothSelectors.stderr).error).toContain("not both");

    const badFailOn = attest(["resolve", "--fail-on", "bogus"], project);
    expect(badFailOn.rc).toBe(1);
    expect(JSON.parse(badFailOn.stderr).error).toContain("--fail-on accepts a comma-separated subset of drifted,unattested,unverifiable,indeterminate");
  }, 30000);

  test("resolve classifies manual commits: verified, drifted, unattested, excluded, squash-stable re-land", () => {
    const { project, record } = runtimeFixture();
    review(project, record, "alpha", [{ path: "app.ts" }]);
    const c1 = git(project, ["rev-parse", "HEAD"]);

    // The seed commit predates the review, but app.ts content is unchanged, so
    // content-derived attribution verifies it — no hook ran at commit time.
    let result = attest(["resolve", c1], project);
    expect(result.rc).toBe(0);
    let report = JSON.parse(result.stdout);
    expect(report.contract).toBe(1);
    expect(report.repo).toBeNull();
    expect(report.mode).toBe("commit");
    expect(report.base).toBeNull(); // root commit resolves its full tree
    expect(report.head).toBe(c1);
    expect(pathStatus(report, "app.ts")).toMatchObject({ status: "verified", unit: "alpha", space: "default", intent: "fixture-intent" });
    expect(report.summary.verified).toBe(1);
    expect(report.summary.excluded).toBeGreaterThan(0); // record shell files in the same commit
    expect(report.summary.drifted).toBe(0);
    expect(report.summary.unattested).toBe(0);

    expect(report.units).toHaveLength(1);
    const unit = report.units[0];
    expect(unit).toMatchObject({
      unit: "alpha",
      space: "default",
      intent: "fixture-intent",
      stage: "code-generation",
      iteration: 1,
      evidenceSource: "committed",
      claimsSource: "manifest",
      bypasses: [],
      fullyLanded: true,
    });
    expect(unit.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(unit.evidence).toMatch(/^aidlc\/spaces\/default\/intents\/fixture-intent\/construction\/alpha\/code-generation\/reviewed-source-[0-9a-f]{12}\.tsv$/);

    // Manual drift commit: claimed path edited without re-review + a file no
    // unit claims + the (excluded) record/audit churn, all in one `git add -A`.
    writeFileSync(join(project, "app.ts"), "export const app = 2;\n");
    writeFileSync(join(project, "unclaimed.ts"), "export const u = 1;\n");
    const c2 = commitAll(project, "manual drift");

    result = attest(["resolve"], project); // default HEAD
    expect(result.rc).toBe(0);
    report = JSON.parse(result.stdout);
    expect(report.head).toBe(c2);
    expect(report.base).toBe(c1);
    expect(pathStatus(report, "app.ts")?.status).toBe("drifted");
    expect(pathStatus(report, "unclaimed.ts")?.status).toBe("unattested");
    expect(report.summary.excluded).toBeGreaterThan(0);
    expect(report.units[0].fullyLanded).toBe(false);

    const failing = attest(["resolve", c2, "--fail-on", "drifted,unattested"], project);
    expect(failing.rc).toBe(3);
    expect(JSON.parse(failing.stdout).failOn).toEqual(["drifted", "unattested"]);

    // Re-landing the reviewed content verifies again: attribution is content-
    // addressed, so squashes/rebases that preserve bytes cannot break it.
    writeFileSync(join(project, "app.ts"), "export const app = 1;\n");
    const c3 = commitAll(project, "re-land reviewed state");
    result = attest(["resolve", c3, "--fail-on", "drifted"], project);
    expect(result.rc).toBe(0);
    expect(pathStatus(JSON.parse(result.stdout), "app.ts")?.status).toBe("verified");

    // Diff mode: two-dot exact range and three-dot merge-base form.
    report = JSON.parse(attest(["resolve", "--diff", `${c1}..${c2}`], project).stdout);
    expect(report.mode).toBe("diff");
    expect(report.base).toBe(c1);
    expect(report.head).toBe(c2);
    expect(pathStatus(report, "app.ts")?.status).toBe("drifted");

    report = JSON.parse(attest(["resolve", "--diff", `${c2}...${c3}`], project).stdout);
    expect(report.base).toBe(c2); // merge-base of an ancestor pair is the ancestor
    expect(pathStatus(report, "app.ts")?.status).toBe("verified");
  }, 60000);

  test("resolve falls back from tampered committed evidence to the local copy, then fails closed", () => {
    const { project, record } = runtimeFixture();
    review(project, record, "alpha", [{ path: "app.ts" }]);
    const c1 = git(project, ["rev-parse", "HEAD"]);

    const evidenceDir = join(record, "construction", "alpha", "code-generation");
    const evidenceName = readdirSync(evidenceDir).find((name) => /^reviewed-source-[0-9a-f]{12}\.tsv$/.test(name));
    expect(evidenceName).toBeDefined();
    if (evidenceName === undefined) return;
    const committedPath = join(evidenceDir, evidenceName);
    const hash12 = /^reviewed-source-([0-9a-f]{12})\.tsv$/.exec(evidenceName)?.[1] as string;
    const localPath = join(record, ".aidlc-source-review", "code-generation", `unit-alpha-${hash12}.tsv`);

    // Tampered committed evidence no longer hashes to the receipt fingerprint;
    // the pre-dual-write local copy still binds, so resolution degrades, not fails.
    writeFileSync(committedPath, "tampered\n");
    let report = JSON.parse(attest(["resolve", c1], project).stdout);
    expect(pathStatus(report, "app.ts")?.status).toBe("verified");
    expect(report.units[0].evidenceSource).toBe("local");

    // No candidate binds: fail closed as unverifiable, naming the tamper.
    rmSync(localPath);
    const failing = attest(["resolve", c1, "--fail-on", "unverifiable"], project);
    expect(failing.rc).toBe(3);
    report = JSON.parse(failing.stdout);
    expect(pathStatus(report, "app.ts")?.status).toBe("unverifiable");
    expect(pathStatus(report, "app.ts")?.reason).toContain("does not hash to the receipt fingerprint");
    expect(report.units[0].claimsSource).toBe("manifest-unverified"); // coverage survives via the manifest

    // Evidence entirely absent (a record that predates committed evidence).
    rmSync(committedPath);
    report = JSON.parse(attest(["resolve", c1], project).stdout);
    expect(pathStatus(report, "app.ts")?.status).toBe("unverifiable");
    expect(pathStatus(report, "app.ts")?.reason).toContain("reviewed-source evidence not found");
  }, 60000);

  test("resolve fails closed as indeterminate on cross-shard same-timestamp READY receipts", () => {
    const { project, record } = fixture();
    writeManifest(record, "alpha", [{ path: "app.ts" }]);
    const auditDir = join(record, "audit");
    mkdirSync(auditDir, { recursive: true });
    const receipt = [
      "# AI-DLC Audit Log",
      "## Review Completed",
      "**Timestamp**: 2026-09-07T10:00:00Z",
      "**Event**: REVIEW_COMPLETED",
      "**Stage**: code-generation",
      "**Unit**: alpha",
      `**Reviewer**: ${REVIEWER}`,
      "**Verdict**: READY",
      `**Unit Source Fingerprint**: sha256:${"a".repeat(64)}`,
      "",
      "---",
      "",
    ].join("\n");
    writeFileSync(join(auditDir, "clone-a.md"), receipt);
    writeFileSync(join(auditDir, "clone-b.md"), receipt);

    const c1 = git(project, ["rev-parse", "HEAD"]);
    const failing = attest(["resolve", c1, "--fail-on", "indeterminate"], project);
    expect(failing.rc).toBe(3);
    const report = JSON.parse(failing.stdout);
    expect(pathStatus(report, "app.ts")?.status).toBe("indeterminate");
    expect(pathStatus(report, "app.ts")?.reason).toContain("same timestamp in different audit shards");
    expect(report.units[0].fullyLanded).toBeNull();
  }, 30000);

  test("anchor appends deduplicated SOURCE_COMMITTED enrichment and --reconcile sweeps first-parent history", () => {
    const { project, record } = runtimeFixture();
    review(project, record, "alpha", [{ path: "app.ts" }]);
    const c1 = git(project, ["rev-parse", "HEAD"]);
    writeFileSync(join(project, "unclaimed.ts"), "export const u = 1;\n");
    const c2 = commitAll(project, "unattributable churn"); // also lands the record/audit files
    writeFileSync(join(project, "app.ts"), "export const app = 3;\n");
    const c3 = commitAll(project, "claimed drift");

    // Session anchor of HEAD.
    const result = attest(["anchor"], project);
    expect(result.rc).toBe(0);
    let report = JSON.parse(result.stdout);
    expect(report).toMatchObject({ contract: 1, repo: null, observed: "session", scanned: 1 });
    expect(report.anchored).toEqual([{ commit: c3, space: "default", intent: "fixture-intent", units: ["alpha"], paths: 1 }]);
    expect(report.skipped).toEqual([]);
    expect(report.unattributed).toEqual([]);

    let audit = readAllAuditShards(project);
    expect(audit).toContain("**Event**: SOURCE_COMMITTED");
    expect(audit).toContain(`**Commit**: ${c3}`);
    expect(audit).toContain("**Repo**: -");
    expect(audit).toContain("**Units**: alpha");
    expect(audit).toContain("**Attributed Paths**: 1");
    expect(audit).toContain("**Observed**: session");

    // Re-anchoring the same commit is a dedupe, not a duplicate row.
    report = JSON.parse(attest(["anchor", "--commit", c3], project).stdout);
    expect(report.anchored).toEqual([]);
    expect(report.skipped).toEqual([{ commit: c3, space: "default", intent: "fixture-intent", reason: "already anchored" }]);
    expect((readAllAuditShards(project).match(/\*\*Event\*\*: SOURCE_COMMITTED/g) ?? []).length).toBe(1);

    // A commit landing no reviewed claim is reported, never anchored.
    report = JSON.parse(attest(["anchor", "--commit", c2], project).stdout);
    expect(report.anchored).toEqual([]);
    expect(report.unattributed).toEqual([c2]);

    // Reconcile sweep: c3 already anchored, c2 unattributable, c1 backfilled.
    report = JSON.parse(attest(["anchor", "--reconcile", "--max-commits", "10"], project).stdout);
    expect(report.observed).toBe("reconciled");
    expect(report.scanned).toBe(3);
    expect(report.skipped).toEqual([{ commit: c3, space: "default", intent: "fixture-intent", reason: "already anchored" }]);
    expect(report.unattributed).toEqual([c2]);
    expect(report.anchored).toEqual([{ commit: c1, space: "default", intent: "fixture-intent", units: ["alpha"], paths: 1 }]);
    audit = readAllAuditShards(project);
    expect((audit.match(/\*\*Event\*\*: SOURCE_COMMITTED/g) ?? []).length).toBe(2);
    expect(audit).toContain("**Observed**: reconciled");

    // A commit already bound by a swarm merge receipt is never double-recorded.
    writeFileSync(join(project, "app.ts"), "export const app = 4;\n");
    const c4 = commitAll(project, "swarm-merged equivalent");
    appendAuditEntry("SWARM_SOURCE_MERGED", { Bolt: "fixture-bolt", "Merge commit": c4, Repo: "-" }, project);
    report = JSON.parse(attest(["anchor", "--commit", c4], project).stdout);
    expect(report.anchored).toEqual([]);
    expect(report.skipped).toEqual([{ commit: c4, space: "default", intent: "fixture-intent", reason: "already bound by SWARM_SOURCE_MERGED" }]);

    const badBound = attest(["anchor", "--reconcile", "--max-commits", "0"], project);
    expect(badBound.rc).toBe(1);
    expect(JSON.parse(badBound.stderr).error).toContain("--max-commits must be a positive integer");
  }, 60000);

  test("session-start hook anchors automatically: reconcile sweep, idempotent re-fire, compact and skip-switch gates", () => {
    const { project, record } = runtimeFixture();
    review(project, record, "alpha", [{ path: "app.ts" }]);
    const c1 = git(project, ["rev-parse", "HEAD"]); // seed commit; app.ts bytes are the reviewed bytes
    writeFileSync(join(project, "unclaimed.ts"), "export const u = 1;\n");
    const c2 = commitAll(project, "unattributable churn"); // record shell + an unclaimed file
    writeFileSync(join(project, "app.ts"), "export const app = 2;\n");
    const c3 = commitAll(project, "claimed change, committed by a human");

    const fireHook = (json: string, extraEnv: Record<string, string> = {}) => {
      const r = Bun.spawnSync({
        cmd: [process.execPath, SESSION_START_HOOK],
        stdin: new TextEncoder().encode(json),
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, CLAUDE_PROJECT_DIR: project, ...extraEnv },
      });
      return { rc: r.exitCode, stdout: new TextDecoder().decode(r.stdout) };
    };
    const anchorRows = () =>
      readAllAuditShards(project).match(/\*\*Event\*\*: SOURCE_COMMITTED/g) ?? [];

    // A real session start sweeps recent first-parent history: c3 and c1 land
    // reviewed claims and get anchored, c2 does not. The hook's normal output
    // contract (exit 0, additionalContext JSON) is untouched by the sweep.
    expect(anchorRows().length).toBe(0);
    let fired = fireHook('{"source":"startup"}');
    expect(fired.rc).toBe(0);
    expect(typeof JSON.parse(fired.stdout.trim()).additionalContext).toBe("string");
    let audit = readAllAuditShards(project);
    expect(anchorRows().length).toBe(2);
    expect(audit).toContain(`**Commit**: ${c1}`);
    expect(audit).toContain(`**Commit**: ${c3}`);
    expect(audit).not.toContain(`**Commit**: ${c2}`);
    expect(audit).toContain("**Observed**: reconciled");

    // Re-firing (a resume) re-scans but dedupes — no duplicate anchor rows.
    fired = fireHook('{"source":"resume"}');
    expect(fired.rc).toBe(0);
    expect(anchorRows().length).toBe(2);

    // New manual commit, but compact resumes and the kill switch never sweep.
    writeFileSync(join(project, "app.ts"), "export const app = 3;\n");
    const c4 = commitAll(project, "post-sweep manual commit");
    fireHook('{"source":"compact"}');
    expect(anchorRows().length).toBe(2);
    fireHook('{"source":"startup"}', { AIDLC_SKIP_SESSION_ANCHOR: "1" });
    expect(anchorRows().length).toBe(2);

    // The next real session start picks c4 up — commits made between sessions
    // are anchored without any explicit `attest anchor` invocation.
    fireHook('{"source":"startup"}');
    audit = readAllAuditShards(project);
    expect(anchorRows().length).toBe(3);
    expect(audit).toContain(`**Commit**: ${c4}`);
  }, 60000);
});
