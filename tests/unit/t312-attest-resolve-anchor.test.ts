// covers: subcommand:aidlc-attest:resolve
// covers: subcommand:aidlc-attest:anchor
// covers: subcommand:aidlc-attest:help
// covers: audit:SOURCE_COMMITTED
//
// t312 - aidlc-attest commit provenance CLI. Attribution is a pure function of
// COMMITTED content: receipts, manifests, and evidence are read out of a git
// tree (the queried commit's, or `--record-ref`'s), never out of the checkout,
// so the same (base, head) resolves identically in every clone and at every
// later date. Plain `git add -A && git commit` runs made by a human — no hooks,
// no trailers, no tool-mediated commit — must resolve.
//
// This suite drives real reviews through aidlc-log, then commits manually and
// pins: resolve's six path statuses and exit codes (0 resolved / 1 usage /
// 3 --fail-on or --require-trust match), the determinism property (a record
// written but not committed attributes nothing; tampering the working tree
// cannot move a verdict), the trust ladder (informational < reproducible <
// independent < signed, plus `--record-ref` as the trust root that separates a
// change from the receipts judging it), cross-shard timestamp ties failing
// closed, and anchor's SOURCE_COMMITTED enrichment (dedupe,
// SWARM_SOURCE_MERGED respect, bounded --reconcile sweeps). The last case fires
// the REAL session-start hook and pins that its sweep is OPT-IN
// (AIDLC_SESSION_ANCHOR=1) — off by default, so no session start silently
// writes to the audit trail.

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

/** Configure real commit signing (ssh format, git >= 2.34) and prove it works by
 *  signing a throwaway commit. Returns false where the host cannot sign, so the
 *  trust assertions can degrade their expected `%G?` codes instead of failing on
 *  a missing ssh-keygen. */
function signedCommitsWork(project: string): boolean {
  const keyDir = mkdtempSync(join(tmpdir(), "aidlc-t312-key-"));
  dirs.push(keyDir);
  const key = join(keyDir, "signer");
  const keygen = spawnSync(
    "ssh-keygen",
    ["-q", "-t", "ed25519", "-N", "", "-C", "signer@test", "-f", key],
    { encoding: "utf-8" },
  );
  if (keygen.status !== 0 || !existsSync(`${key}.pub`)) return false;
  const allowed = join(keyDir, "allowed-signers");
  writeFileSync(allowed, `signer@test namespaces="git" ${readFileSync(`${key}.pub`, "utf-8").trim()}\n`);
  git(project, ["config", "gpg.format", "ssh"]);
  git(project, ["config", "user.signingkey", `${key}.pub`]);
  git(project, ["config", "gpg.ssh.allowedSignersFile", allowed]);
  writeFileSync(join(project, "signing-probe.txt"), "probe\n");
  git(project, ["add", "-A"]);
  const probe = spawnSync(
    "git",
    ["-C", project, "commit", "-qS", "-m", "probe that this host can sign commits"],
    { encoding: "utf-8" },
  );
  if (probe.status !== 0) return false;
  return git(project, ["log", "-1", "--format=%G?"]) === "G";
}

function commit(project: string, message: string, signed: boolean): string {
  if (!signed) return commitAll(project, message);
  git(project, ["add", "-A"]);
  git(project, ["commit", "-qS", "-m", message]);
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
  const iteration = String(prior + 1);
  // The verdict path validates the reviewer appendix: bytes appended to the
  // review artifact after REVIEW_REQUESTED must be a terminal `## Review`
  // section matching verdict/reviewer/iteration. Strip any prior section
  // before the request (its bytes belong to the request-time snapshot), then
  // append the canonical appendix before submitting the verdict.
  const artifact = join(record, "construction", unit, "code-generation", "code-generation-plan.md");
  const current = readFileSync(artifact, "utf-8");
  const reviewStart = current.search(/^## Review[ \t]*$/m);
  if (reviewStart !== -1) writeFileSync(artifact, `${current.slice(0, reviewStart).replace(/\s+$/, "")}\n`, "utf-8");
  const args = ["review", "--stage", "code-generation", "--reviewer", REVIEWER, "--unit", unit, "--iteration", iteration];
  const request = cli(LOG, args, project);
  if (request.rc !== 0) throw new Error(`review request failed: ${request.stdout}${request.stderr}`);
  appendFileSync(
    artifact,
    `\n## Review\n\n**Verdict:** READY\n**Reviewer:** ${REVIEWER}\n**Iteration:** ${iteration}\n\n### Findings\n\nNo blocking findings.\n`,
    "utf-8",
  );
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

    const bothCommitForms = attest(["resolve", "abc", "--commit", "def"], project);
    expect(bothCommitForms.rc).toBe(1);
    expect(JSON.parse(bothCommitForms.stderr).error).toContain("pass either <commit> or --commit <rev>");

    // A flag the OTHER verb owns is a usage error, never silently ignored: a
    // pipeline writing `resolve --commit X` must not get a report about HEAD.
    const foreignOnResolve = attest(["resolve", "--reconcile"], project);
    expect(foreignOnResolve.rc).toBe(1);
    expect(JSON.parse(foreignOnResolve.stderr).error).toContain("resolve does not accept --reconcile");

    const foreignOnAnchor = attest(["anchor", "--diff", "a..b", "--fail-on", "drifted"], project);
    expect(foreignOnAnchor.rc).toBe(1);
    expect(JSON.parse(foreignOnAnchor.stderr).error).toContain("anchor does not accept --diff, --fail-on");

    const badFailOn = attest(["resolve", "--fail-on", "bogus"], project);
    expect(badFailOn.rc).toBe(1);
    expect(JSON.parse(badFailOn.stderr).error).toContain("--fail-on accepts a comma-separated subset of drifted,unattested,unverifiable,indeterminate");

    const badTrust = attest(["resolve", "--require-trust", "bogus"], project);
    expect(badTrust.rc).toBe(1);
    expect(JSON.parse(badTrust.stderr).error).toContain("--require-trust accepts one of informational,reproducible,independent,signed");

    // The trust flags belong to resolve alone: anchor writes to this checkout's
    // record, so a record source it did not read is meaningless there.
    const trustOnAnchor = attest(["anchor", "--record-ref", "main", "--require-trust", "signed"], project);
    expect(trustOnAnchor.rc).toBe(1);
    expect(JSON.parse(trustOnAnchor.stderr).error).toContain("anchor does not accept --record-ref, --require-trust");

    expect(help.stdout).toContain("--record-ref <ref>");
    expect(help.stdout).toContain("--require-trust <level>");
  }, 30000);

  test("resolve classifies manual commits: verified, drifted, unattested, excluded, squash-stable re-land", () => {
    const { project, record } = runtimeFixture();
    // The reviewed change and the record that approves it land in one manual
    // commit — the ordinary shape of an AI-DLC change.
    writeFileSync(join(project, "app.ts"), "export const app = 2;\n");
    review(project, record, "alpha", [{ path: "app.ts" }]);
    const c1 = commitAll(project, "reviewed change plus its record");

    // No hook ran at commit time: attribution comes from the receipt and the
    // evidence file that this commit's own tree carries.
    let result = attest(["resolve", c1], project);
    expect(result.rc).toBe(0);
    let report = JSON.parse(result.stdout);
    expect(report.contract).toBe(1);
    expect(report.repo).toBeNull();
    expect(report.mode).toBe("commit");
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

    // This commit carries its own receipts, so the report says so rather than
    // implying more than it can: reproducible, self-attested (see the
    // --record-ref case for how a verifier separates the two).
    expect(report.trust).toMatchObject({
      level: "reproducible",
      required: null,
      satisfied: true,
      recordSource: "commit",
      recordRef: c1,
      recordCommit: c1,
      recordPinned: false,
      selfAttested: true,
    });
    expect(report.trust.recordPathsChangedInRange.length).toBeGreaterThan(0);

    // Manual drift commit: claimed path edited without re-review + a file no
    // unit claims, in one `git add -A`. Nothing in the record changes, so the
    // receipts judging this commit predate it — that is `independent`.
    writeFileSync(join(project, "app.ts"), "export const app = 3;\n");
    writeFileSync(join(project, "unclaimed.ts"), "export const u = 1;\n");
    const c2 = commitAll(project, "manual drift");

    result = attest(["resolve"], project); // default HEAD
    expect(result.rc).toBe(0);
    report = JSON.parse(result.stdout);
    expect(report.head).toBe(c2);
    expect(report.base).toBe(c1);
    expect(pathStatus(report, "app.ts")?.status).toBe("drifted");
    expect(pathStatus(report, "unclaimed.ts")?.status).toBe("unattested");
    expect(report.units[0].fullyLanded).toBe(false);
    expect(report.trust).toMatchObject({
      level: "independent",
      selfAttested: false,
      recordPathsChangedInRange: [],
    });

    const failing = attest(["resolve", c2, "--fail-on", "drifted,unattested"], project);
    expect(failing.rc).toBe(3);
    expect(JSON.parse(failing.stdout).failOn).toEqual(["drifted", "unattested"]);

    // Re-landing the reviewed content verifies again: attribution is content-
    // addressed, so squashes/rebases that preserve bytes cannot break it.
    writeFileSync(join(project, "app.ts"), "export const app = 2;\n");
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

    // --commit <rev> is the flag form of the positional and selects the same
    // commit (it used to be parsed and then ignored, silently reporting HEAD).
    report = JSON.parse(attest(["resolve", "--commit", c2], project).stdout);
    expect(report.mode).toBe("commit");
    expect(report.head).toBe(c2);
    expect(pathStatus(report, "app.ts")?.status).toBe("drifted");

    // Byte-form conversion is announced rather than silently drifting paths.
    expect(report.warnings).toEqual([]);
    git(project, ["config", "core.autocrlf", "true"]);
    report = JSON.parse(attest(["resolve", c2], project).stdout);
    expect(report.warnings.join("\n")).toContain("core.autocrlf=true");
    expect(report.warnings.join("\n")).toContain("can report drifted");
  }, 60000);

  test("resolve is deterministic: the record comes from the queried tree, not the checkout", () => {
    const { project, record } = runtimeFixture();
    writeFileSync(join(project, "app.ts"), "export const app = 2;\n");
    review(project, record, "alpha", [{ path: "app.ts" }]);
    const c1 = commitAll(project, "reviewed change plus its record");
    expect(pathStatus(JSON.parse(attest(["resolve", c1], project).stdout), "app.ts")?.status)
      .toBe("verified");

    // Reviewing MORE units afterwards, without committing, cannot retroactively
    // change what c1 resolves to: the same (base, head) is stable as the record
    // evolves, which is what makes a stored report meaningful.
    writeFileSync(join(project, "lib.ts"), "export const lib = 1;\n");
    const beforeExtraReview = attest(["resolve", c1], project).stdout;
    review(project, record, "beta", [{ path: "lib.ts" }]);
    expect(attest(["resolve", c1], project).stdout).toBe(beforeExtraReview);

    // Nor can editing the checkout's committed evidence: the bytes that count
    // are the blob in c1's tree, so tampering the working copy is inert.
    const evidenceDir = join(record, "construction", "alpha", "code-generation");
    const evidenceName = readdirSync(evidenceDir).find((name) => /^reviewed-source-[0-9a-f]{12}\.tsv$/.test(name)) as string;
    writeFileSync(join(evidenceDir, evidenceName), "tampered\n");
    expect(attest(["resolve", c1], project).stdout).toBe(beforeExtraReview);

    // Committing the tamper DOES change the verdict, and only from that commit
    // on: c1 keeps verifying, while the commit carrying broken evidence cannot
    // bind content and fails closed.
    writeFileSync(join(project, "app.ts"), "export const app = 3;\n");
    const c2 = commitAll(project, "tamper with committed evidence");
    expect(pathStatus(JSON.parse(attest(["resolve", c1], project).stdout), "app.ts")?.status)
      .toBe("verified");
    const tampered = attest(["resolve", c2, "--fail-on", "unverifiable"], project);
    expect(tampered.rc).toBe(3);
    const report = JSON.parse(tampered.stdout);
    expect(pathStatus(report, "app.ts")?.status).toBe("unverifiable");
    expect(pathStatus(report, "app.ts")?.reason).toContain("does not hash to the receipt fingerprint");

    // A record that exists on disk but was never committed attributes nothing,
    // and says so instead of reporting a bare wall of `unattested`.
    const fresh = mkdtempSync(join(tmpdir(), "aidlc-t312-clone-"));
    dirs.push(fresh);
    expect(spawnSync("git", ["clone", "-q", project, fresh], { encoding: "utf-8" }).status).toBe(0);
    git(fresh, ["config", "user.email", "t@test"]);
    git(fresh, ["config", "user.name", "t"]);
    rmSync(join(fresh, "aidlc"), { recursive: true, force: true });
    commitAll(fresh, "drop the record from this repository");
    writeFileSync(join(fresh, "app.ts"), "export const app = 4;\n");
    const c3 = commitAll(fresh, "a source change in a repository that keeps no record");
    const recordless = JSON.parse(attest(["resolve", c3], fresh).stdout);
    expect(recordless.warnings.join("\n")).toContain("no intent record is committed under aidlc/spaces/");
    expect(recordless.trust.level).toBe("independent"); // reproducible + record untouched, but nothing signed
  }, 60000);

  test("--record-ref pins the trust root; --require-trust gates on it", () => {
    const { project, record } = runtimeFixture();
    writeFileSync(join(project, "app.ts"), "export const app = 2;\n");
    review(project, record, "alpha", [{ path: "app.ts" }]);
    const approved = commitAll(project, "reviewed change plus its record");
    // A ref only the verifier can move — the stand-in for a protected branch.
    git(project, ["branch", "records", approved]);

    // The adversarial shape from review: a change that edits source AND writes
    // its own approving receipt in the same commit. Judged against itself it
    // verifies, but the report refuses to call that better than `reproducible`.
    writeFileSync(join(project, "app.ts"), "export const app = 99;\n");
    review(project, record, "alpha", [{ path: "app.ts" }]);
    const selfApproved = commitAll(project, "change plus a receipt for itself");

    let report = JSON.parse(attest(["resolve", selfApproved], project).stdout);
    expect(pathStatus(report, "app.ts")?.status).toBe("verified");
    expect(report.trust.level).toBe("reproducible");
    expect(report.trust.selfAttested).toBe(true);
    expect(report.trust.recordPathsChangedInRange.some((path: string) => path.startsWith("aidlc/spaces/"))).toBe(true);

    // Demanding a basis the report cannot provide exits 3 — the same exit code
    // as a failing path, because the caller asked for a guarantee it did not get.
    const gated = attest(["resolve", selfApproved, "--require-trust", "independent"], project);
    expect(gated.rc).toBe(3);
    expect(JSON.parse(gated.stdout).trust).toMatchObject({
      level: "reproducible",
      required: "independent",
      satisfied: false,
    });
    // A bar it does clear passes.
    expect(attest(["resolve", selfApproved, "--require-trust", "reproducible"], project).rc).toBe(0);

    // Reading the record from the ref the change cannot write strips the
    // self-approval: only the earlier receipt counts, and the new bytes drift.
    const pinned = attest(["resolve", selfApproved, "--record-ref", "records", "--require-trust", "independent"], project);
    expect(pinned.rc).toBe(0);
    report = JSON.parse(pinned.stdout);
    expect(pathStatus(report, "app.ts")?.status).toBe("drifted");
    expect(report.trust).toMatchObject({
      level: "independent",
      required: "independent",
      satisfied: true,
      recordSource: "commit",
      recordRef: "records",
      recordCommit: approved,
      recordPinned: true,
      selfAttested: false,
    });

    // `signed` needs git to vouch for the commits that carried the receipt AND
    // the evidence. Unsigned fixture commits report `N`, so the bar is not met.
    const wantSigned = attest(["resolve", selfApproved, "--record-ref", "records", "--require-trust", "signed"], project);
    expect(wantSigned.rc).toBe(3);
    report = JSON.parse(wantSigned.stdout);
    expect(report.trust.level).toBe("independent");
    expect(report.trust.signatures).toEqual([
      {
        unit: "default/fixture-intent/alpha",
        role: "receipt",
        path: report.units[0].receipt,
        commit: approved,
        code: "N", // N = no signature
      },
      {
        unit: "default/fixture-intent/alpha",
        role: "evidence",
        path: report.units[0].evidence,
        commit: approved,
        code: "N",
      },
    ]);
    expect(report.units[0]).toMatchObject({ evidenceCommit: approved, evidenceSignature: "N" });
    expect(report.units[0].receipt).toMatch(
      /^aidlc\/spaces\/default\/intents\/fixture-intent\/audit\/.+\.md$/,
    );
    expect(report.units[0]).toMatchObject({ receiptCommit: approved, receiptSignature: "N" });

    const unresolvable = attest(["resolve", "--record-ref", "no/such/ref"], project);
    expect(unresolvable.rc).toBe(1);
    expect(JSON.parse(unresolvable.stderr).error).toContain("cannot resolve --record-ref");
  }, 60000);

  test("`signed` covers the receipt that selects the evidence, not only the evidence", () => {
    const { project, record } = runtimeFixture();
    const signs = signedCommitsWork(project);
    // %G? for a commit this host actually signed. Where signing is unavailable
    // the structural assertions below still hold; only the codes degrade.
    const good = signs ? "G" : "N";

    // Two legitimate signed reviews of the same unit. Evidence files are
    // content-addressed, so the record ends up holding BOTH — and only the newer
    // receipt is supposed to be able to select one.
    writeFileSync(join(project, "app.ts"), "export const app = 2;\n");
    review(project, record, "alpha", [{ path: "app.ts" }]);
    const firstApproved = commit(project, "reviewed app.ts = 2", signs);
    writeFileSync(join(project, "app.ts"), "export const app = 3;\n");
    review(project, record, "alpha", [{ path: "app.ts" }]);
    const secondApproved = commit(project, "reviewed app.ts = 3", signs);

    // Control: a signed record source, judged from outside the change, reaches
    // `signed` — receipt shard and evidence both arrived in signed commits.
    writeFileSync(join(project, "app.ts"), "export const app = 2;\n");
    const reverted = commit(project, "put app.ts back to the older reviewed state", signs);
    let report = JSON.parse(attest(["resolve", reverted, "--record-ref", secondApproved], project).stdout);
    expect(pathStatus(report, "app.ts")?.status).toBe("drifted"); // newest receipt approved 3, not 2
    expect(report.trust).toMatchObject({ level: signs ? "signed" : "independent" });
    expect(report.trust.signatures).toEqual([
      { unit: "default/fixture-intent/alpha", role: "receipt", path: report.units[0].receipt, commit: secondApproved, code: good },
      { unit: "default/fixture-intent/alpha", role: "evidence", path: report.units[0].evidence, commit: secondApproved, code: good },
    ]);
    const newestEvidenceName = (report.units[0].evidence as string).split("/").pop();

    // The attack: append an UNSIGNED forged receipt to the shard. It names the
    // same unit with a later timestamp, so it wins ownership, and its fingerprint
    // points at the FIRST review's evidence — a signed file it has no right to.
    // The reverted source then matches that older evidence exactly.
    const evidenceDir = join(record, "construction", "alpha", "code-generation");
    const evidenceNames = readdirSync(evidenceDir)
      .filter((name) => /^reviewed-source-[0-9a-f]{12}\.tsv$/.test(name))
      .sort();
    expect(evidenceNames.length).toBe(2); // both reviews' evidence survives
    const shard = join(record, "audit", readdirSync(join(record, "audit")).sort()[0]);
    const forged = (digest: string, timestamp: string) => [
      "## Review Completed",
      `**Timestamp**: ${timestamp}`,
      "**Event**: REVIEW_COMPLETED",
      "**Stage**: code-generation",
      "**Unit**: alpha",
      `**Reviewer**: ${REVIEWER}`,
      "**Verdict**: READY",
      `**Unit Source Fingerprint**: sha256:${digest}`,
      "",
      "---",
      "",
    ].join("\n");
    // The evidence to hijack is the superseded one: the first review approved
    // app.ts = 2, which is exactly the state the revert restored.
    const hijacked = evidenceNames.find((name) => name !== newestEvidenceName);
    expect(hijacked).toBeDefined();
    if (hijacked === undefined) return;
    const digest = createHash("sha256")
      .update(readFileSync(join(evidenceDir, hijacked)))
      .digest("hex");

    appendFileSync(shard, forged(digest, "2099-01-01T00:00:00Z"), "utf-8");
    const forgedCommit = commit(project, "append an unsigned receipt", false);

    // Judged against the forged record, the path verifies — content-addressed
    // integrity cannot tell an unauthorised approval from an authorised one.
    // What it MUST NOT do is call that basis `signed`: the receipt that chose
    // the evidence arrived unsigned, so the gate has to fail closed.
    const gated = attest([
      "resolve",
      reverted,
      "--record-ref",
      forgedCommit,
      "--require-trust",
      "signed",
      "--fail-on",
      "drifted,unattested,unverifiable,indeterminate",
    ], project);
    report = JSON.parse(gated.stdout);
    expect(pathStatus(report, "app.ts")?.status).toBe("verified");
    expect(report.trust.level).toBe("independent");
    expect(report.trust.satisfied).toBe(false);
    expect(gated.rc).toBe(3);
    // The forge is visible exactly where a reader would look: the receipt input
    // names the unsigned commit, while the evidence it hijacked stays signed.
    expect(report.trust.signatures).toEqual([
      { unit: "default/fixture-intent/alpha", role: "receipt", path: report.units[0].receipt, commit: forgedCommit, code: "N" },
      { unit: "default/fixture-intent/alpha", role: "evidence", path: report.units[0].evidence, commit: firstApproved, code: good },
    ]);
    expect(report.units[0]).toMatchObject({ receiptCommit: forgedCommit, receiptSignature: "N" });
  }, 90000);

  test("resolve excludes the harness shell of a repo that carries the workspace shell", () => {
    const { project, record } = runtimeFixture();
    // A real install ships its shell dir beside the record; nobody reviews it,
    // so it must classify `excluded` (framework surface), not `unattested`.
    mkdirSync(join(project, ".claude", "tools", "data"), { recursive: true });
    writeFileSync(join(project, ".claude", "tools", "data", "harness.json"), `${JSON.stringify({ name: "claude" })}\n`);
    writeFileSync(join(project, ".claude", "settings.json"), "{}\n");
    review(project, record, "alpha", [{ path: "app.ts" }]);
    const head = commitAll(project, "install the harness shell");

    const first = attest(["resolve", head, "--fail-on", "unattested"], project);
    const report = JSON.parse(first.stdout);
    expect(pathStatus(report, ".claude/settings.json")?.status).toBe("excluded");
    expect(pathStatus(report, ".claude/tools/data/harness.json")?.status).toBe("excluded");
    expect(report.summary.unattested).toBe(0);

    // Which dot-dirs are harness shells is read from the QUERIED TREE, so it is
    // a property of the commit and not of whoever happens to be resolving it.
    // Uninstalling the shell from this checkout cannot reclassify the same SHA
    // (it used to flip these paths to `unattested`).
    rmSync(join(project, ".claude"), { recursive: true, force: true });
    expect(attest(["resolve", head, "--fail-on", "unattested"], project).stdout).toBe(first.stdout);

    // And the commit that performs the uninstall stays excluded too: the base
    // side of the range still carries the manifest, so removing a harness does
    // not surface a wall of `unattested` framework paths.
    const removed = commitAll(project, "uninstall the harness shell");
    const after = JSON.parse(attest(["resolve", removed], project).stdout);
    expect(pathStatus(after, ".claude/settings.json")?.status).toBe("excluded");
    expect(after.summary.unattested).toBe(0);
  }, 60000);

  test("resolve and anchor refuse a shallow-clone boundary instead of diffing the root tree", () => {
    const { project, record } = runtimeFixture();
    review(project, record, "alpha", [{ path: "app.ts" }]);
    writeFileSync(join(project, "app.ts"), "export const app = 2;\n");
    commitAll(project, "second commit so a depth-1 clone truncates history");

    // `--depth 1` needs a URL: git ignores it for plain local-path clones.
    const shallow = mkdtempSync(join(tmpdir(), "aidlc-t312-shallow-"));
    dirs.push(shallow);
    const cloned = spawnSync("git", ["clone", "-q", "--depth", "1", `file://${project}`, shallow], { encoding: "utf-8" });
    expect(cloned.status).toBe(0);
    expect(existsSync(join(shallow, ".git", "shallow"))).toBe(true);
    const head = git(shallow, ["rev-parse", "HEAD"]);

    // The boundary commit reports no parents, but its commit object names one:
    // treating that as a root commit would classify the entire checkout.
    const refused = attest(["resolve", head], shallow);
    expect(refused.rc).toBe(1);
    expect(refused.stdout).toBe("");
    const error = JSON.parse(refused.stderr).error;
    expect(error).toContain("shallow-clone boundary");
    expect(error).toContain("fetch-depth: 0");

    expect(JSON.parse(attest(["anchor"], shallow).stderr).error).toContain("shallow-clone boundary");

    // The sweep keeps going: boundaries are reported, never attributed.
    const swept = attest(["anchor", "--reconcile", "--max-commits", "10"], shallow);
    expect(swept.rc).toBe(0);
    const report = JSON.parse(swept.stdout);
    expect(report.boundaries).toEqual([head]);
    expect(report.anchored).toEqual([]);
    expect(report.unattributed).toEqual([]);
    expect(readAllAuditShards(shallow)).not.toContain("**Event**: SOURCE_COMMITTED");

    // Deepening the clone restores normal resolution of the same commit.
    expect(spawnSync("git", ["-C", shallow, "fetch", "-q", "--deepen", "1"], { encoding: "utf-8" }).status).toBe(0);
    const deepened = attest(["resolve", head], shallow);
    expect(deepened.rc).toBe(0);
    expect(pathStatus(JSON.parse(deepened.stdout), "app.ts")?.status).toBe("drifted");
  }, 60000);

  test("resolve verifies only committed evidence: the gitignored local snapshot never verifies", () => {
    const { project, record } = runtimeFixture();
    writeFileSync(join(project, "app.ts"), "export const app = 2;\n");
    review(project, record, "alpha", [{ path: "app.ts" }]);
    const c1 = commitAll(project, "reviewed change plus its record");

    const evidenceDir = join(record, "construction", "alpha", "code-generation");
    const evidenceName = readdirSync(evidenceDir).find((name) => /^reviewed-source-[0-9a-f]{12}\.tsv$/.test(name));
    expect(evidenceName).toBeDefined();
    if (evidenceName === undefined) return;
    const committedPath = join(evidenceDir, evidenceName);
    const hash12 = /^reviewed-source-([0-9a-f]{12})\.tsv$/.exec(evidenceName)?.[1] as string;
    const localPath = join(record, ".aidlc-source-review", "code-generation", `unit-alpha-${hash12}.tsv`);

    // Review dual-writes: the record carries committed evidence, and the machine
    // keeps a byte-identical gitignored copy that resolution must never consult.
    expect(readFileSync(localPath)).toEqual(readFileSync(committedPath));
    let report = JSON.parse(attest(["resolve", c1], project).stdout);
    expect(pathStatus(report, "app.ts")?.status).toBe("verified");
    expect(report.units[0].evidenceSource).toBe("committed");

    // Committed evidence that does not hash to the fingerprint fails closed —
    // even though the intact local copy still does. Honouring gitignored bytes
    // would make the verdict machine-dependent: `verified` here, `unverifiable`
    // in every clone and every fresh checkout.
    writeFileSync(committedPath, "tampered\n");
    writeFileSync(join(project, "app.ts"), "export const app = 3;\n");
    const c2 = commitAll(project, "tamper with committed evidence");
    expect(readFileSync(localPath)).not.toEqual(readFileSync(committedPath));
    const failing = attest(["resolve", c2, "--fail-on", "unverifiable"], project);
    expect(failing.rc).toBe(3);
    report = JSON.parse(failing.stdout);
    expect(pathStatus(report, "app.ts")?.status).toBe("unverifiable");
    expect(pathStatus(report, "app.ts")?.reason).toContain("does not hash to the receipt fingerprint");
    expect(report.units[0].evidenceSource).toBeNull(); // nothing bound content
    expect(report.units[0].claimsSource).toBe("manifest-unverified"); // coverage survives via the manifest

    // No committed evidence at all (a record written before evidence was
    // committed) is honestly unverifiable, and the reason names the fix.
    rmSync(committedPath);
    writeFileSync(join(project, "app.ts"), "export const app = 4;\n");
    const c3 = commitAll(project, "drop committed evidence entirely");
    report = JSON.parse(attest(["resolve", c3], project).stdout);
    expect(pathStatus(report, "app.ts")?.status).toBe("unverifiable");
    expect(pathStatus(report, "app.ts")?.reason).toContain("reviewed-source evidence not found");
    expect(pathStatus(report, "app.ts")?.reason).toContain("re-review the unit");
    expect(report.units[0].evidenceSource).toBeNull();
    // The gitignored copy still hashes to the fingerprint and still changes
    // nothing: it was never a verification input.
    expect(existsSync(localPath)).toBe(true);
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

    writeFileSync(join(project, "app.ts"), "export const app = 2;\n");
    const c1 = commitAll(project, "two clones' shards land the same receipt second");
    const failing = attest(["resolve", c1, "--fail-on", "indeterminate"], project);
    expect(failing.rc).toBe(3);
    const report = JSON.parse(failing.stdout);
    expect(pathStatus(report, "app.ts")?.status).toBe("indeterminate");
    expect(pathStatus(report, "app.ts")?.reason).toContain("same timestamp in different audit shards");
    expect(report.units[0].fullyLanded).toBeNull();
  }, 30000);

  test("resolve fails closed when two records claim a path with the same-timestamp receipt", () => {
    const { project, record } = fixture();
    const intentsRoot = join(project, "aidlc", "spaces", "default", "intents");
    const second = join(intentsRoot, "rival-intent");
    mkdirSync(second, { recursive: true });
    writeFileSync(join(second, "aidlc-state.md"), "# State\n- **Scope**: feature\n", "utf-8");
    writeFileSync(join(intentsRoot, "intents.json"), `${JSON.stringify([
      { uuid: "80000000-0000-4000-8000-000000000001", slug: "fixture", dirName: "fixture-intent", status: "active", repos: [] },
      { uuid: "80000000-0000-4000-8000-000000000002", slug: "rival", dirName: "rival-intent", status: "active", repos: [] },
    ])}\n`);

    // Two intents, two units, one claimed path, identical receipt timestamps:
    // "newest claim wins" names no winner, so ordering by (space, intent, unit)
    // would hand the path to whichever record sorts first. Fail closed instead.
    const receipt = (unit: string) => [
      "# AI-DLC Audit Log",
      "## Review Completed",
      "**Timestamp**: 2026-09-07T10:00:00Z",
      "**Event**: REVIEW_COMPLETED",
      "**Stage**: code-generation",
      `**Unit**: ${unit}`,
      `**Reviewer**: ${REVIEWER}`,
      "**Verdict**: READY",
      `**Unit Source Fingerprint**: sha256:${"a".repeat(64)}`,
      "",
      "---",
      "",
    ].join("\n");
    for (const [dir, unit] of [[record, "alpha"], [second, "beta"]] as const) {
      writeManifest(dir, unit, [{ path: "app.ts" }]);
      mkdirSync(join(dir, "audit"), { recursive: true });
      writeFileSync(join(dir, "audit", "clone-a.md"), receipt(unit));
    }

    writeFileSync(join(project, "app.ts"), "export const app = 2;\n");
    const c1 = commitAll(project, "two records claim the same path at the same second");
    const failing = attest(["resolve", c1, "--fail-on", "indeterminate"], project);
    expect(failing.rc).toBe(3);
    const report = JSON.parse(failing.stdout);
    expect(pathStatus(report, "app.ts")?.status).toBe("indeterminate");
    expect(pathStatus(report, "app.ts")?.reason).toContain("different records");

    // An ambiguous path is not anchored either — reporting it is resolve's job.
    const anchored = JSON.parse(attest(["anchor", "--commit", c1], project).stdout);
    expect(anchored.anchored).toEqual([]);
    expect(anchored.unattributed).toEqual([c1]);
    expect(readAllAuditShards(project)).not.toContain("**Event**: SOURCE_COMMITTED");

    // Break the tie by one second and the newer record owns the path again.
    writeFileSync(
      join(second, "audit", "clone-a.md"),
      receipt("beta").replace("10:00:00Z", "10:00:01Z"),
    );
    writeFileSync(join(project, "app.ts"), "export const app = 3;\n");
    const c2 = commitAll(project, "one record's receipt is now newer");
    const resolved = JSON.parse(attest(["resolve", c2], project).stdout);
    expect(pathStatus(resolved, "app.ts")).toMatchObject({ unit: "beta", intent: "rival-intent" });
    expect(pathStatus(resolved, "app.ts")?.status).toBe("unverifiable"); // fabricated fingerprint binds nothing
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

  test("session-start anchoring is opt-in: silent by default, sweeps only under AIDLC_SESSION_ANCHOR=1", () => {
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

    // Starting a session writes NO anchor. Anchors are enrichment that `resolve`
    // never reads, so a session start must not silently append to the
    // append-only audit trail — the hook's normal output contract (exit 0,
    // additionalContext JSON) is all it produces.
    expect(anchorRows().length).toBe(0);
    let fired = fireHook('{"source":"startup"}');
    expect(fired.rc).toBe(0);
    expect(typeof JSON.parse(fired.stdout.trim()).additionalContext).toBe("string");
    expect(anchorRows().length).toBe(0);
    expect(fireHook('{"source":"resume"}').rc).toBe(0);
    expect(anchorRows().length).toBe(0);

    // Opting in sweeps recent first-parent history: c3 and c1 land reviewed
    // claims and get anchored, c2 does not.
    fired = fireHook('{"source":"startup"}', { AIDLC_SESSION_ANCHOR: "1" });
    expect(fired.rc).toBe(0);
    let audit = readAllAuditShards(project);
    expect(anchorRows().length).toBe(2);
    expect(audit).toContain(`**Commit**: ${c1}`);
    expect(audit).toContain(`**Commit**: ${c3}`);
    expect(audit).not.toContain(`**Commit**: ${c2}`);
    expect(audit).toContain("**Observed**: reconciled");

    // Re-firing (a resume) re-scans but dedupes — no duplicate anchor rows.
    fired = fireHook('{"source":"resume"}', { AIDLC_SESSION_ANCHOR: "1" });
    expect(fired.rc).toBe(0);
    expect(anchorRows().length).toBe(2);

    // Compact resumes never sweep even when opted in: PreCompact already owns
    // that transition, so the sweep would fire on a non-start.
    writeFileSync(join(project, "app.ts"), "export const app = 3;\n");
    const c4 = commitAll(project, "post-sweep manual commit");
    fireHook('{"source":"compact"}', { AIDLC_SESSION_ANCHOR: "1" });
    expect(anchorRows().length).toBe(2);

    // The next opted-in start picks c4 up; without the switch it stays put.
    fireHook('{"source":"startup"}');
    expect(anchorRows().length).toBe(2);
    fireHook('{"source":"startup"}', { AIDLC_SESSION_ANCHOR: "1" });
    audit = readAllAuditShards(project);
    expect(anchorRows().length).toBe(3);
    expect(audit).toContain(`**Commit**: ${c4}`);
  }, 60000);
});
