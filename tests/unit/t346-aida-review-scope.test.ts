import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyCommands,
  emptyLedger,
  type Ledger,
  lineAnchor,
  type LoadedLedger,
  mergeLedgers,
  parseCommands,
  renderLedgerComment,
  validateLedger,
} from "../../.github/scripts/ai-pr-ledger.ts";
import {
  applyLedgerToReview,
  buildContext,
  buildScope,
  type ChangedFileManifest,
  findingInScope,
  parseStructuredReview,
  securityCitations,
  renderReview,
  type ReviewMetadata,
  type ReviewScope,
  type StructuredReview,
} from "../../.github/scripts/ai-pr-review.ts";
import { REPO_ROOT } from "../harness/fixtures.ts";

const BASE = "b".repeat(40);
const HEAD = "a".repeat(40);
const SINCE = "5".repeat(40);
const CONTEXT_ID = "c".repeat(64);
const AT = "2026-09-22T12:00:00Z";
const PATH = "core/example.ts";
const METADATA: ReviewMetadata = { title: "Add payment validation", body: "Please review." };
const MANIFEST: ChangedFileManifest = {
  base: BASE,
  head: HEAD,
  files: [
    { path: PATH, status: "M", added: [{ start: 42, end: 44 }], deleted: [{ start: 40, end: 41 }], fileLevelEvidence: false, snapshot: `head/${PATH}` },
    { path: "assets/logo.png", status: "M", added: [], deleted: [], fileLevelEvidence: true },
  ],
};
const REVIEW_WORKFLOW = readFileSync(join(REPO_ROOT, ".github", "workflows", "ai-pr-review.yml"), "utf8");
const prompt = (name: string): string => readFileSync(join(REPO_ROOT, ".github", "prompts", `ai-pr-review-${name}.md`), "utf8");
const CONTRIBUTING = readFileSync(join(REPO_ROOT, "CONTRIBUTING.md"), "utf8");

const CHANGE: StructuredReview["decision"] = { actor: "author", action: "change", rationale: "The finding must be corrected." };
const MERGE: StructuredReview["decision"] = { actor: "maintainer", action: "merge", rationale: "Ready for a maintainer merge decision." };

type Evidence = StructuredReview["findings"][number]["evidence"][number];

function review(
  findings: Array<{ priority: "P0" | "P1" | "P2" | "P3"; category: StructuredReview["findings"][number]["category"]; evidence: Evidence[] }>,
  scores: { readiness: number; risk: number },
  decision: StructuredReview["decision"],
): string {
  return JSON.stringify({
    base: BASE,
    head: HEAD,
    inspection: { status: "complete", changedFiles: [PATH] },
    validation: ["Read every changed file."],
    assessment: {
      readiness: { score: scores.readiness, rationale: "Concrete completeness assessment." },
      risk: { score: scores.risk, rationale: "Concrete blast-radius assessment." },
    },
    userExperience: { status: "no-user-visible-change", change: "Internal validation only.", before: null, after: null, example: null, assessment: "No indirect user-experience risk." },
    decision,
    findings: findings.map((item, index) => ({
      priority: item.priority,
      category: item.category,
      title: `Finding number ${index + 1}`,
      ledgerId: null,
      evidence: item.evidence,
      problem: "The changed line sums items before discounts are applied.",
      impact: "Customers are overcharged.",
      requiredCorrection: "Apply the discount before computing the total.",
    })),
    residualRisk: "None identified.",
  });
}

const diffLine = (line: number, side: "LEFT" | "RIGHT" = "RIGHT"): Evidence => ({ source: "DIFF", path: PATH, line, side });
const INCREMENTAL: ReviewScope = { mode: "incremental", since: SINCE, reason: `lines of the PR diff changed since the review at ${SINCE.slice(0, 8)}`, files: [{ path: PATH, added: [{ start: 43, end: 43 }], deleted: [], deletedFile: false }] };
const FULL: ReviewScope = { mode: "full", since: null, reason: "first review of this pull request", files: [] };

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" }).trim();
}

// A small repository: base → since (first reviewed head) → head, plus a
// divergent branch to simulate a force-push.
function repository(): { root: string; base: string; since: string; head: string; rewritten: string } {
  const root = mkdtempSync(join(tmpdir(), "aida-scope-repo-"));
  git(root, "init", "-q", "-b", "main");
  // Pin tree modes through the index on every OS. Windows chmod cannot set
  // executable bits, and fixture checkouts must ignore host filesystem modes.
  git(root, "config", "core.filemode", "false");
  mkdirSync(join(root, "core"), { recursive: true });
  mkdirSync(join(root, "docs"), { recursive: true });
  const write = (name: string, lines: string[]) => writeFileSync(join(root, name), `${lines.join("\n")}\n`);
  const numbered = (count: number, prefix: string) => Array.from({ length: count }, (_, index) => `${prefix} ${index + 1}`);
  write("core/example.ts", numbered(50, "line"));
  write("core/other.ts", numbered(10, "other"));
  write("core/renamed-src.ts", numbered(20, "renamed"));
  write("core/chain-a.ts", numbered(5, "chain"));
  write("core/hunky.ts", numbered(5, "hunky"));
  write("docs/readme.md", ["intro"]);
  git(root, "add", "-A");
  git(root, "update-index", "--chmod=-x", "core/hunky.ts");
  git(root, "commit", "-q", "-m", "base");
  const base = git(root, "rev-parse", "HEAD");

  // First head: touches example.ts lines 10-12 and other.ts line 3.
  const first = numbered(50, "line");
  first[9] = "line 10 changed at since";
  first[10] = "line 11 changed at since";
  first[11] = "line 12 changed at since";
  write("core/example.ts", first);
  const other = numbered(10, "other");
  other[2] = "other 3 changed at since";
  write("core/other.ts", other);
  // Reviewed at since: chain-a renamed to chain-b; hunky gets a content hunk.
  git(root, "mv", "core/chain-a.ts", "core/chain-b.ts");
  const hunky = numbered(5, "hunky");
  hunky[1] = "hunky 2 changed at since";
  write("core/hunky.ts", hunky);
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "since");
  const since = git(root, "rev-parse", "HEAD");

  // Second head: rewrites line 11 again (in the PR diff AND changed since), adds line 30,
  // reverts other.ts to base (no longer in the PR diff), and adds docs/new.md.
  const second = [...first];
  second[10] = "line 11 changed again at head";
  second[29] = "line 30 changed at head";
  write("core/example.ts", second);
  write("core/other.ts", numbered(10, "other"));
  write("docs/new.md", ["new file"]);
  // Follow-ups that must stay in scope: deleting a base line (45) untouched at since, a
  // deletion-only change, a rename with a change, deleting the already-renamed chain-b
  // (the PR diff knows it as chain-a), and a mode-only change on hunky.
  second.splice(44, 1);
  write("core/example.ts", second);
  rmSync(join(root, "docs", "readme.md"));
  git(root, "mv", "core/renamed-src.ts", "core/renamed-dst.ts");
  const renamed = numbered(20, "renamed");
  renamed[4] = "renamed 5 changed at head";
  write("core/renamed-dst.ts", renamed);
  git(root, "rm", "-q", "core/chain-b.ts");
  git(root, "add", "-A");
  git(root, "update-index", "--chmod=+x", "core/hunky.ts");
  git(root, "commit", "-q", "-m", "head");
  const head = git(root, "rev-parse", "HEAD");
  expect(git(root, "ls-tree", since, "core/hunky.ts")).toContain("100644 blob");
  expect(git(root, "ls-tree", head, "core/hunky.ts")).toContain("100755 blob");

  // A force-push: the same content on a branch that does not descend from `since`.
  git(root, "checkout", "-q", "-b", "rewritten", base);
  write("core/example.ts", second);
  write("docs/new.md", ["new file"]);
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "rewritten");
  const rewritten = git(root, "rev-parse", "HEAD");
  git(root, "checkout", "-q", "main");
  return { root, base, since, head, rewritten };
}

describe("t346 AIDA incremental review scope", () => {
  test("build-scope narrows to PR-diff lines changed since the last reviewed head, and falls back to full", () => {
    const repo = repository();
    const context = mkdtempSync(join(tmpdir(), "aida-scope-ctx-"));
    try {
      const manifest = buildContext(repo.base, repo.head, context, repo.root);
      expect(manifest.files.map(file => `${file.status[0]} ${file.path}`)).toEqual(["D core/chain-a.ts", "M core/example.ts", "M core/hunky.ts", "R core/renamed-dst.ts", "A docs/new.md", "D docs/readme.md"]);

      const scope = buildScope(repo.head, manifest, repo.since, false, repo.root);
      expect(scope.mode).toBe("incremental");
      expect(scope.since).toBe(repo.since);
      // Line 11 changed since AND is in the PR diff; line 30 is new; lines 10 and 12 were
      // reviewed at `since` and are out; other.ts left the PR diff; docs/new.md is new.
      expect(scope.files).toEqual([
        // chain-b was deleted at head; the PR diff knows the file as chain-a (deleted).
        { path: "core/chain-a.ts", added: [], deleted: [], deletedFile: true },
        // Line 11 was re-modified (its since-line was itself added after the base: no base line
        // to cite); base lines 30 (replaced at head) and 45 (deleted at head) map 1:1.
        { path: "core/example.ts", added: [{ start: 11, end: 11 }, { start: 30, end: 30 }], deleted: [{ start: 30, end: 30 }, { start: 45, end: 45 }], deletedFile: false },
        // Mode-only change since the review on a file whose PR diff has hunks: whole PR diff admitted.
        { path: "core/hunky.ts", added: [{ start: 2, end: 2 }], deleted: [], deletedFile: false },
        { path: "core/renamed-dst.ts", previousPath: "core/renamed-src.ts", added: [{ start: 5, end: 5 }], deleted: [{ start: 5, end: 5 }], deletedFile: false },
        { path: "docs/new.md", added: [{ start: 1, end: 1 }], deleted: [], deletedFile: false },
        { path: "docs/readme.md", added: [], deleted: [], deletedFile: true },
      ]);
      const left = (path: string, line: number) => findingInScope({ category: "contracts", evidence: [{ source: "DIFF", path, line, side: "LEFT" }] }, scope);
      // Deleted files admit every base line; a rename's base path is matched; only base lines
      // deleted since the review are in scope, not the deletions already reviewed at since.
      expect(left("docs/readme.md", 1)).toBe(true);
      expect(left("core/chain-a.ts", 3)).toBe(true);
      expect(left("core/renamed-src.ts", 5)).toBe(true);
      expect(left("core/example.ts", 45)).toBe(true);
      expect(left("core/example.ts", 10)).toBe(false);
      expect(left("core/example.ts", 11)).toBe(false);
      expect(left("docs/new.md", 1)).toBe(false);

      expect(buildScope(repo.head, manifest, null, false, repo.root)).toMatchObject({ mode: "full", reason: "first review of this pull request", files: [] });
      // /aida full widens the review but keeps the change set as evidence for dispositions.
      const requested = buildScope(repo.head, manifest, repo.since, true, repo.root);
      expect(requested).toMatchObject({ mode: "full", since: repo.since, reason: "requested by a maintainer with /aida full" });
      expect(requested.files).toEqual(scope.files);
      expect(buildScope(repo.head, manifest, null, true, repo.root)).toMatchObject({ mode: "full", reason: "first review of this pull request", files: [] });
      expect(buildScope(repo.head, manifest, repo.head, false, repo.root).reason).toBe("this head was already reviewed");
      expect(buildScope(repo.head, manifest, "d".repeat(40), false, repo.root).reason).toContain("is no longer available");
      // The rewritten branch has the same content but `since` is not its ancestor: full.
      const rewrittenManifest = buildContext(repo.base, repo.rewritten, mkdtempSync(join(tmpdir(), "aida-scope-ctx2-")), repo.root);
      const rewritten = buildScope(repo.rewritten, rewrittenManifest, repo.since, false, repo.root);
      expect(rewritten.mode).toBe("full");
      expect(rewritten.reason).toContain("history was rewritten since the review at");
    } finally {
      rmSync(repo.root, { recursive: true, force: true });
      rmSync(context, { recursive: true, force: true });
    }
  });

  test("scope membership: security is always in scope; other categories need a cited line inside the scope", () => {
    const finding = (category: StructuredReview["findings"][number]["category"], ...evidence: Evidence[]) => ({ category, evidence });
    expect(findingInScope(finding("correctness", diffLine(43)), INCREMENTAL)).toBe(true);
    expect(findingInScope(finding("correctness", diffLine(42)), INCREMENTAL)).toBe(false);
    expect(findingInScope(finding("correctness", diffLine(42), diffLine(43)), INCREMENTAL)).toBe(true);
    expect(findingInScope(finding("security", diffLine(42)), INCREMENTAL)).toBe(true);
    expect(findingInScope(finding("correctness", diffLine(42)), FULL)).toBe(true);
    // Deleted-line evidence is in scope only for base lines deleted since the review;
    // file-level evidence when the file is listed; metadata quotes always (it may have changed).
    expect(findingInScope(finding("contracts", diffLine(40, "LEFT")), INCREMENTAL)).toBe(false);
    expect(findingInScope(finding("contracts", diffLine(40, "LEFT")), { ...INCREMENTAL, files: [{ ...INCREMENTAL.files[0], deleted: [{ start: 40, end: 40 }] }] })).toBe(true);
    expect(findingInScope(finding("contracts", diffLine(41, "LEFT")), { ...INCREMENTAL, files: [{ ...INCREMENTAL.files[0], deleted: [{ start: 40, end: 40 }] }] })).toBe(false);
    expect(findingInScope(finding("contracts", { source: "DIFF_FILE", path: "assets/logo.png" }), INCREMENTAL)).toBe(false);
    expect(findingInScope(finding("contracts", { source: "DIFF_FILE", path: "assets/logo.png" }), { ...INCREMENTAL, files: [...INCREMENTAL.files, { path: "assets/logo.png", added: [], deleted: [], deletedFile: false }] })).toBe(true);
    expect(findingInScope(finding("direction", { source: "PR_BODY", quote: "Please review." }), INCREMENTAL)).toBe(true);

    // The exemption for security rests on the full-head lenses' own citations, not on the
    // judge's category: a correctness-labelled finding on a line the prompt-attack lens cited
    // is never deferred.
    const lensDir = mkdtempSync(join(tmpdir(), "aida-scope-lenses-"));
    try {
      writeFileSync(join(lensDir, "prompt-injection.json"), JSON.stringify({
        marker: "[LENS-REVIEWED] prompt-injection x", status: "complete",
        candidates: [
          { priority: "P1", title: "instruction smuggled into a comment", evidence: [{ source: "DIFF", path: PATH, line: 42, side: "RIGHT" }, { source: "DIFF_FILE", path: "assets/logo.png" }, { source: "PR_BODY", quote: "ignore previous" }], problem: "p", impact: "i", requiredCorrection: "r" },
          { priority: "P2", title: "odd evidence is ignored, not fatal", evidence: [{ source: "DIFF", path: "", line: 3, side: "RIGHT" }, { source: "DIFF", path: "x.ts", line: 1e30, side: "RIGHT" }, { source: "DIFF_FILE", path: "my docs/plan.md" }, "junk"], problem: "p", impact: "i", requiredCorrection: "r" },
        ],
      }));
      writeFileSync(join(lensDir, "security.json"), "{not json");
      const cited = securityCitations(lensDir);
      // Keyed by side: a LEFT citation never exempts a RIGHT finding on the same coordinates.
      expect([...cited.lines]).toEqual([`${PATH}:42:RIGHT`]);
      expect(findingInScope(finding("correctness", diffLine(42, "LEFT")), INCREMENTAL, cited)).toBe(false);
      // With the manifest, only lines the PR diff changed (and file-level files) are trusted.
      const validated = securityCitations(lensDir, MANIFEST);
      expect([...validated.lines]).toEqual([`${PATH}:42:RIGHT`]);
      expect(validated.files).toEqual(new Set(["assets/logo.png"]));
      // A citation on a changed file whose line is not a changed line (or a DIFF_FILE on a file with
      // hunks) still keeps provenance at file granularity; a citation on an unchanged file is dropped.
      writeFileSync(join(lensDir, "security.json"), JSON.stringify({ marker: "m", status: "complete", candidates: [{ priority: "P1", title: "t", evidence: [{ source: "DIFF", path: PATH, line: 7, side: "RIGHT" }, { source: "DIFF_FILE", path: PATH }, { source: "DIFF", path: "core/unchanged.ts", line: 1, side: "RIGHT" }], problem: "p", impact: "i", requiredCorrection: "r" }] }));
      expect([...securityCitations(lensDir, MANIFEST).lines]).toEqual([`${PATH}:42:RIGHT`]);
      expect(securityCitations(lensDir, MANIFEST).files).toEqual(new Set(["assets/logo.png", PATH]));
      expect(findingInScope(finding("correctness", { source: "DIFF_FILE", path: PATH }), INCREMENTAL, securityCitations(lensDir, MANIFEST))).toBe(true);
      // File-level provenance also exempts line evidence on that file (the judge may have corrected the line).
      expect(findingInScope(finding("correctness", diffLine(44)), INCREMENTAL, securityCitations(lensDir, MANIFEST))).toBe(true);
      writeFileSync(join(lensDir, "security.json"), "{not json");
      // File-level citations count exactly as cited; a DIFF citation with an unusable line keeps
      // provenance at file granularity (x.ts) rather than being lost.
      expect(cited.files).toEqual(new Set(["assets/logo.png", "x.ts", "my docs/plan.md"]));
      expect(findingInScope(finding("correctness", diffLine(42)), INCREMENTAL, cited)).toBe(true);
      expect(findingInScope(finding("correctness", diffLine(44)), INCREMENTAL, cited)).toBe(false);
      expect(findingInScope(finding("correctness", { source: "DIFF_FILE", path: "assets/logo.png" }), INCREMENTAL, cited)).toBe(true);
      expect(securityCitations(join(lensDir, "missing"))).toEqual({ lines: new Set(), files: new Set() });
    } finally {
      rmSync(lensDir, { recursive: true, force: true });
    }
  });

  test("the validator defers out-of-scope non-security findings, re-derives the decision, and renders both", () => {
    const raw = review(
      [
        { priority: "P1", category: "correctness", evidence: [diffLine(42)] },
        { priority: "P1", category: "security", evidence: [diffLine(42)] },
        { priority: "P2", category: "contracts", evidence: [diffLine(43)] },
      ],
      { readiness: 2, risk: 4 },
      CHANGE,
    );
    const parsed = parseStructuredReview(raw, BASE, HEAD, MANIFEST, METADATA, INCREMENTAL);
    expect(parsed.findings.map(item => `${item.priority}:${item.category}`)).toEqual(["P1:security", "P2:contracts"]);
    expect(parsed.deferred).toEqual([{ priority: "P1", category: "correctness", title: "Finding number 1", paths: [PATH] }]);
    expect(parsed.decision).toEqual(CHANGE);
    const body = renderReview(parsed, CONTEXT_ID).body;
    expect(body).toContain(`Scope: **incremental** — 1 file with lines changed since the review at \`${SINCE.slice(0, 8)}\`; the security lenses reviewed the full head.`);
    expect(body).toContain("## Deferred (outside the review scope)");
    expect(body).toContain(`**P1 · correctness: Finding number 1** — <code>${PATH}</code>`);
    expect(body).toContain("comment `/aida full` to have the next review cover the whole head");
    expect(body.indexOf("**P1: Finding number 2**")).toBeGreaterThan(-1);
    expect(body.indexOf("## Deferred (outside the review scope)")).toBeGreaterThan(body.indexOf("**P2: Finding number 3**"));

    // The only finding is deferred and the scores permit merge: the decision is re-derived.
    const sole = parseStructuredReview(review([{ priority: "P1", category: "correctness", evidence: [diffLine(42)] }], { readiness: 5, risk: 1 }, CHANGE), BASE, HEAD, MANIFEST, METADATA, INCREMENTAL);
    expect(sole.findings).toEqual([]);
    expect(sole.decision.action).toBe("merge");
    // One explanation, built from the judge's raw rationale: no stacked parser-override text.
    expect(sole.decision.rationale).toBe("Re-derived: 1 finding outside the incremental review scope was deferred and no blocking finding remains. Judge's note, superseded by finding severity: The finding must be corrected.");
    expect(renderReview(sole, CONTEXT_ID).event).toBe("COMMENT");
    // Scores never decide: with nothing left to report the action is the maintainer's merge decision
    // even at low readiness and high risk, and the scores stay visible to inform it.
    const low = parseStructuredReview(review([{ priority: "P1", category: "correctness", evidence: [diffLine(42)] }], { readiness: 2, risk: 4 }, CHANGE), BASE, HEAD, MANIFEST, METADATA, INCREMENTAL);
    expect(low.decision.action).toBe("merge");
    expect(low.deferred).toHaveLength(1);
    expect(renderReview(low, CONTEXT_ID).body).toContain("Readiness: **2/5**");
    // P2-only findings never block, deferred or not.
    const advisoryOnly = parseStructuredReview(review([{ priority: "P2", category: "correctness", evidence: [diffLine(42)] }, { priority: "P2", category: "contracts", evidence: [diffLine(43)] }], { readiness: 3, risk: 2 }, CHANGE), BASE, HEAD, MANIFEST, METADATA, INCREMENTAL);
    expect(advisoryOnly.decision.action).toBe("merge");
    expect(advisoryOnly.findings).toHaveLength(1);
    expect(advisoryOnly.deferred).toHaveLength(1);

    // Full mode defers nothing and says why the head was reviewed in full.
    const full = parseStructuredReview(review([{ priority: "P1", category: "correctness", evidence: [diffLine(42)] }], { readiness: 2, risk: 4 }, CHANGE), BASE, HEAD, MANIFEST, METADATA, FULL);
    expect(full.deferred).toEqual([]);
    expect(full.findings).toHaveLength(1);
    expect(renderReview(full, CONTEXT_ID).body).toContain("Scope: **full head** (first review of this pull request).");
    // No scope at all renders exactly as before.
    expect(renderReview(parseStructuredReview(review([], { readiness: 5, risk: 1 }, MERGE), BASE, HEAD, MANIFEST, METADATA), CONTEXT_ID).body).not.toContain("Scope:");
  });

  test("/aida full is recorded in the ledger, survives a concurrent review's merge, and is consumed by the review that honors it", () => {
    const ledger = emptyLedger(42);
    const actor = { login: "maint", at: AT, commentId: 7 };
    expect(parseCommands("/aida full")).toEqual([{ kind: "full", ids: [] }]);
    expect(() => applyCommands(ledger, parseCommands("/aida full F1"), actor)).toThrow("/aida full takes no arguments");
    const applied = applyCommands(ledger, parseCommands("/aida full"), actor);
    expect(applied.messages).toEqual(["The next review covers the full head, requested by @maint."]);
    expect(applied.ledger.nextReview).toEqual({ scope: "full", by: "maint", at: AT });
    expect(applied.ledger.events.at(-1)).toMatchObject({ kind: "full-requested", by: "maint", commentId: 7 });
    expect(validateLedger(JSON.parse(JSON.stringify(applied.ledger)))).toEqual(applied.ledger);
    expect(() => validateLedger({ ...applied.ledger, nextReview: { scope: "partial", by: "x", at: AT } })).toThrow("nextReview is invalid");
    expect(renderLedgerComment(applied.ledger)).toContain("Next review: **full head**, requested by @maint.");

    // A request made while a review ran is kept when that review publishes its snapshot.
    expect(mergeLedgers(emptyLedger(42), applied.ledger).nextReview).toEqual(applied.ledger.nextReview);

    const root = mkdtempSync(join(tmpdir(), "aida-scope-apply-"));
    try {
      mkdirSync(join(root, "head", "core"), { recursive: true });
      writeFileSync(join(root, "head", "core", "example.ts"), `${Array.from({ length: 50 }, (_, index) => `line ${index + 1}`).join("\n")}\n`);
      const loaded: LoadedLedger = { ledger: applied.ledger, commentId: 900, digest: null, migrated: false };
      const honored = parseStructuredReview(review([], { readiness: 5, risk: 1 }, MERGE), BASE, HEAD, MANIFEST, METADATA, { ...FULL, reason: "requested by a maintainer with /aida full" });
      expect(applyLedgerToReview(honored, loaded, root, root, AT).ledger.nextReview).toBeUndefined();
      const notYet = parseStructuredReview(review([], { readiness: 5, risk: 1 }, MERGE), BASE, HEAD, MANIFEST, METADATA, INCREMENTAL);
      expect(applyLedgerToReview(notYet, loaded, root, root, AT).ledger.nextReview).toEqual(applied.ledger.nextReview);
      const withFinding: Ledger = { ...applied.ledger, findings: [{ id: "F1", priority: "P2", category: "correctness", title: "x", anchors: [lineAnchor(PATH, "RIGHT", "line 1")], status: "open", firstSeen: { head: HEAD, at: AT }, lastSeen: { head: HEAD, at: AT } }], nextId: 2 };
      expect(validateLedger(withFinding).nextReview).toEqual(applied.ledger.nextReview);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the workflow derives the scope after the ledger, scopes three lenses, and validates with it", () => {
    const context = REVIEW_WORKFLOW.slice(REVIEW_WORKFLOW.indexOf("      - name: Build immutable review context"), REVIEW_WORKFLOW.indexOf("      - name: Start AIDA review label state"));
    expect(context.indexOf("ai-pr-ledger.ts fetch")).toBeLessThan(context.indexOf("ai-pr-review.ts build-scope"));
    expect(context.indexOf("build-context \\")).toBeLessThan(context.indexOf("ai-pr-review.ts build-scope"));
    expect(context).toContain("--ledger .ai-review-context/ledger.json \\\n            --output .ai-review-context/review-scope.json");
    for (const lens of ["aidlc", "user-experience", "direction"]) {
      expect(REVIEW_WORKFLOW).toContain(`.ai-review-controls/prompts/ai-pr-review-scope.md \\\n              .ai-review-controls/prompts/ai-pr-review-${lens}.md`);
    }
    for (const lens of ["security", "prompt-injection", "judge"]) {
      expect(REVIEW_WORKFLOW).not.toContain(`.ai-review-controls/prompts/ai-pr-review-scope.md \\\n              .ai-review-controls/prompts/ai-pr-review-${lens}.md`);
    }
    expect(REVIEW_WORKFLOW.split("--scope .ai-review-context/review-scope.json")).toHaveLength(3);
    expect(REVIEW_WORKFLOW.split("--lens-dir .ai-review-lenses")).toHaveLength(3);
    // The two security lenses emit structured JSON under the lens schema; the other three stay prose.
    expect(REVIEW_WORKFLOW).toContain('lens_schema="$(jq -c . .ai-review-controls/prompts/ai-pr-review-lens-schema.json)"');
    expect(REVIEW_WORKFLOW.split('"$lens_schema"')).toHaveLength(3);
    for (const lens of ["prompt-injection", "security"]) {
      expect(REVIEW_WORKFLOW).toContain(`".ai-review-lenses/${lens}.json"`);
      expect(REVIEW_WORKFLOW).toContain(`'.marker == $marker and .status == "complete"' .ai-review-lenses/${lens}.json >/dev/null`);
      expect(REVIEW_WORKFLOW).toContain(`::error::${lens} lens did not complete its inspection`);
      expect(REVIEW_WORKFLOW).toContain(`.ai-review-controls/prompts/ai-pr-review-lens-json.md \\\n              .ai-review-controls/prompts/ai-pr-review-${lens}.md`);
    }
    for (const lens of ["aidlc", "user-experience", "direction"]) {
      expect(REVIEW_WORKFLOW).toContain(`".ai-review-lenses/${lens}.md"`);
    }
    const lensSchema = JSON.parse(readFileSync(join(REPO_ROOT, ".github", "prompts", "ai-pr-review-lens-schema.json"), "utf8"));
    expect(lensSchema.required).toEqual(["marker", "status", "candidates"]);
    // Source-specific variants: a schema-valid citation always carries the fields its source needs.
    expect(lensSchema.$defs.evidence.anyOf.map((variant: { required: string[] }) => variant.required)).toEqual([
      ["source", "path", "line", "side"],
      ["source", "path"],
      ["source", "quote"],
    ]);
    expect(prompt("lens-json")).toContain('"marker": "[LENS-REVIEWED] <lens> <head sha>"');
    expect(prompt("judge")).toContain("`.ai-review-lenses/security.json` (structured candidates)");

    expect(prompt("scope")).toContain('`mode: "incremental"`');
    expect(prompt("scope")).toContain("report candidates only when their evidence cites a line inside the scope");
    expect(prompt("scope")).toContain("`deleted[]` lists the base lines (`LEFT` side");
    expect(CONTRIBUTING).toContain("a finding on a line or file they cited is never\ndeferred whatever category the judge assigns it");
    expect(prompt("security")).toContain("this lens always reviews the full head");
    expect(prompt("prompt-injection")).toContain("this lens always reviews the full head and the full PR metadata");
    expect(prompt("judge")).toContain("Honor `.ai-review-context/review-scope.json`");
    expect(prompt("judge")).toContain("The\n  `security` category always covers the full head.");
    expect(prompt("common")).toContain("within the review scope");
    expect(CONTRIBUTING).toContain("AIDA reviews **incrementally**");
    expect(CONTRIBUTING).toContain("`full` — make the next review cover the whole head");
  });
});
