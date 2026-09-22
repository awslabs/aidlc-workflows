import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyCommand,
  emptyLedger,
  headContainsAnchor,
  LEDGER_MARKER,
  type Ledger,
  ledgerDigest,
  lineAnchor,
  type LoadedLedger,
  parseCommand,
  parseLedgerComment,
  reconcileLedger,
  renderLedgerComment,
  runCommand,
  validateLedger,
} from "../../.github/scripts/ai-pr-ledger.ts";
import {
  applyLedgerToReview,
  type ChangedFileManifest,
  parseStructuredReview,
  renderReview,
  type ReviewMetadata,
  type StructuredReview,
  validateStructuredReview,
} from "../../.github/scripts/ai-pr-review.ts";
import { REPO_ROOT } from "../harness/fixtures.ts";

const BASE = "b".repeat(40);
const HEAD = "a".repeat(40);
const CONTEXT_ID = "c".repeat(64);
const AT = "2026-09-22T12:00:00Z";
const REVIEW_WORKFLOW = readFileSync(
  join(REPO_ROOT, ".github", "workflows", "ai-pr-review.yml"),
  "utf8",
);
const LEDGER_WORKFLOW = readFileSync(
  join(REPO_ROOT, ".github", "workflows", "ai-pr-ledger.yml"),
  "utf8",
);
const COMMON_PROMPT = readFileSync(
  join(REPO_ROOT, ".github", "prompts", "ai-pr-review-common.md"),
  "utf8",
);
const JUDGE_PROMPT = readFileSync(
  join(REPO_ROOT, ".github", "prompts", "ai-pr-review-judge.md"),
  "utf8",
);
const CONTRIBUTING = readFileSync(join(REPO_ROOT, "CONTRIBUTING.md"), "utf8");
const METADATA: ReviewMetadata = { title: "Add payment validation", body: "Please review." };
const LINE_42 = "  const total = computeTotal(items);";
const MANIFEST: ChangedFileManifest = {
  base: BASE,
  head: HEAD,
  files: [
    {
      path: "core/example.ts",
      status: "M",
      added: [{ start: 42, end: 44 }],
      deleted: [],
      fileLevelEvidence: false,
      snapshot: "head/core/example.ts",
    },
  ],
};

function seen(): { head: string; at: string } {
  return { head: HEAD, at: AT };
}

function ledgerWith(...findings: Ledger["findings"]): Ledger {
  const ledger = emptyLedger(42);
  ledger.findings = findings;
  ledger.nextId = findings.reduce((max, entry) => Math.max(max, Number(entry.id.slice(1))), 0) + 1;
  return ledger;
}

function entry(
  id: string,
  priority: "P0" | "P1" | "P2" | "P3",
  status: Ledger["findings"][number]["status"],
  anchorText: string,
  reason = "not a defect",
): Ledger["findings"][number] {
  const finding: Ledger["findings"][number] = {
    id,
    priority,
    category: "correctness",
    title: `Finding ${id}`,
    anchors: [lineAnchor("core/example.ts", anchorText)],
    status,
    firstSeen: seen(),
    lastSeen: seen(),
  };
  if (status === "accepted" || status === "rejected") {
    finding.decision = { by: "maintainer", at: AT, reason };
  }
  return finding;
}

function review(
  priority: "P0" | "P1" | "P2" | "P3" | undefined,
  scores: { readiness: number; risk: number },
  decision: StructuredReview["decision"],
): StructuredReview {
  return {
    base: BASE,
    head: HEAD,
    inspection: { status: "complete", changedFiles: ["core/example.ts"] },
    validation: ["Read every changed file."],
    assessment: {
      readiness: { score: scores.readiness, rationale: "Concrete completeness assessment." },
      risk: { score: scores.risk, rationale: "Concrete blast-radius assessment." },
    },
    userExperience: {
      status: "no-user-visible-change",
      change: "Internal validation only.",
      before: null,
      after: null,
      example: null,
      assessment: "No indirect user-experience risk.",
    },
    decision,
    findings: priority
      ? [
          {
            priority,
            category: "correctness",
            title: "Total ignores the discount",
            evidence: [{ source: "DIFF", path: "core/example.ts", line: 42, side: "RIGHT" }],
            problem: "The changed line sums items before discounts are applied.",
            impact: "Customers are overcharged.",
            requiredCorrection: "Apply the discount before computing the total.",
          },
        ]
      : [],
    residualRisk: "None identified.",
  };
}

const CHANGE: StructuredReview["decision"] = {
  actor: "author",
  action: "change",
  rationale: "The blocking finding must be corrected.",
};
const MERGE: StructuredReview["decision"] = {
  actor: "maintainer",
  action: "merge",
  rationale: "Ready for a maintainer merge decision.",
};

function contextDir(): string {
  const root = mkdtempSync(join(tmpdir(), "aida-ledger-ctx-"));
  mkdirSync(join(root, "head", "core"), { recursive: true });
  const lines = Array.from({ length: 50 }, (_, index) => `line ${index + 1}`);
  lines[41] = LINE_42;
  writeFileSync(join(root, "head", "core", "example.ts"), `${lines.join("\n")}\n`);
  return root;
}

function fakeGh(
  root: string,
  ledgerBody: string | null,
  permission: string,
  commentBody: string,
  commentUserType = "User",
): { path: string; log: string } {
  const log = join(root, "calls.jsonl");
  const path = join(root, "gh");
  writeFileSync(
    path,
    `#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
const input = await Bun.stdin.text();
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, input }) + "\\n");
const endpoint = args.find(value => value.startsWith("repos/"));
if (endpoint === "repos/acme/repo/issues/comments/777" && !args.includes("--method")) {
  process.stdout.write(JSON.stringify({
    id: 777,
    body: ${JSON.stringify(commentBody)},
    user: { login: "maint", type: ${JSON.stringify(commentUserType)} },
  }));
} else if (endpoint === "repos/acme/repo/collaborators/maint/permission") {
  process.stdout.write(JSON.stringify({ permission: ${JSON.stringify(permission)} }));
} else if (endpoint === "repos/acme/repo/issues/42/comments" && args.includes("--paginate")) {
  process.stdout.write(JSON.stringify(${
    ledgerBody === null
      ? "[[]]"
      : `[[{ id: 900, body: ${JSON.stringify(ledgerBody)}, user: { login: "github-actions[bot]", type: "Bot" } }]]`
  }));
} else if (args.includes("POST") && endpoint === "repos/acme/repo/issues/42/comments") {
  process.stdout.write(JSON.stringify({ id: 901 }));
} else {
  process.stdout.write("{}");
}
`,
  );
  chmodSync(path, 0o755);
  return { path, log };
}

function calls(log: string): Array<{ args: string[]; input: string }> {
  return readFileSync(log, "utf8")
    .trim()
    .split("\n")
    .filter(line => line.length > 0)
    .map(line => JSON.parse(line));
}

describe("t345 AIDA findings ledger", () => {
  test("commands parse strictly from the first line only", () => {
    expect(parseCommand("/aida reject F2 not a defect")).toEqual({
      kind: "reject",
      id: "F2",
      reason: "not a defect",
    });
    expect(parseCommand("/aida accept F10 we own this risk\nmore text")).toEqual({
      kind: "accept",
      id: "F10",
      reason: "we own this risk",
    });
    expect(parseCommand("/aida reopen F3\r\n")).toEqual({ kind: "reopen", id: "F3" });
    expect(parseCommand("/aida status")).toEqual({ kind: "status" });
    expect(parseCommand("/aida full")).toEqual({ kind: "full" });
    expect(parseCommand("please\n/aida reject F1 hidden on line two")).toBeNull();
    expect(parseCommand("```\n/aida reject F1\n```")).toBeNull();
    expect(parseCommand("/aida rejectF1 squashed")).toBeNull();
    expect(parseCommand("/aida delete F1")).toBeNull();
    expect(parseCommand("/aida reject F0 bad id")?.id).toBeUndefined();
    expect(parseCommand("Thanks! /aida accept F1 inline mention")).toBeNull();
  });

  test("blocking findings can be accepted but never rejected; reasons are required", () => {
    const ledger = ledgerWith(entry("F1", "P1", "open", LINE_42), entry("F2", "P2", "open", "x"));
    const actor = { login: "leandro", at: AT, commentId: 5 };
    expect(() => applyCommand(ledger, { kind: "reject", id: "F1", reason: "nah" }, actor)).toThrow(
      "can be accepted (risk owned by you), not rejected",
    );
    expect(() => applyCommand(ledger, { kind: "reject", id: "F2" }, actor)).toThrow(
      "requires a reason",
    );
    expect(() => applyCommand(ledger, { kind: "accept", id: "F9", reason: "x" }, actor)).toThrow(
      "Unknown finding F9",
    );
    expect(() => applyCommand(ledger, { kind: "accept", reason: "x" }, actor)).toThrow(
      "requires a finding id",
    );

    const accepted = applyCommand(ledger, { kind: "accept", id: "F1", reason: "risk owned" }, actor);
    expect(accepted.ledger.findings[0].status).toBe("accepted");
    expect(accepted.ledger.findings[0].decision).toEqual({
      by: "leandro",
      at: AT,
      reason: "risk owned",
      commentId: 5,
    });
    expect(accepted.ledger.events.at(-1)).toMatchObject({ kind: "accepted", id: "F1", by: "leandro" });
    expect(ledger.findings[0].status).toBe("open");

    const rejected = applyCommand(ledger, { kind: "reject", id: "F2", reason: "by design" }, actor);
    expect(rejected.ledger.findings[1].status).toBe("rejected");

    const reopened = applyCommand(rejected.ledger, { kind: "reopen", id: "F2" }, actor);
    expect(reopened.ledger.findings[1].status).toBe("open");
    expect(reopened.ledger.findings[1].decision).toBeUndefined();
    expect(() => applyCommand(reopened.ledger, { kind: "reopen", id: "F2" }, actor)).toThrow(
      "already open",
    );

    const full = applyCommand(ledger, { kind: "full" }, actor);
    expect(full.ledger.mode).toBe("full");
    expect(full.ledger.events.at(-1)?.kind).toBe("full-requested");
    expect(applyCommand(ledger, { kind: "status" }, actor).ledger).toEqual(ledger);
  });

  test("the ledger comment round-trips and a hand edit is detected by its digest", () => {
    const ledger = ledgerWith(entry("F1", "P2", "rejected", LINE_42, "documented behavior"));
    ledger.events.push({ at: AT, kind: "rejected", by: "maintainer", id: "F1" });
    const body = renderLedgerComment(ledger);
    expect(body.startsWith(`${LEDGER_MARKER} digest=${ledgerDigest(ledger)} -->`)).toBe(true);
    expect(body).toContain("| F1 | P2 | ⚪ rejected | Finding F1 |");
    expect(body).toContain("*documented behavior*");
    expect(body).toContain("P0 and P1 findings can be accepted");
    const parsed = parseLedgerComment(body);
    expect(parsed?.tampered).toBe(false);
    expect(parsed?.ledger).toEqual(ledger);

    const edited = body.replace('"status": "rejected"', '"status": "accepted"');
    const tampered = parseLedgerComment(edited);
    expect(tampered?.tampered).toBe(true);
    expect(tampered?.ledger.findings[0].status).toBe("accepted");
    expect(renderLedgerComment(ledger, true)).toContain("edited outside AIDA");
    expect(parseLedgerComment("just a comment")).toBeNull();
    expect(() => parseLedgerComment(`${LEDGER_MARKER} -->\nno json`)).toThrow("no JSON block");
  });

  test("ledger validation rejects inconsistent state", () => {
    const good = ledgerWith(entry("F1", "P2", "open", "x"));
    expect(validateLedger(JSON.parse(JSON.stringify(good)))).toEqual(good);
    expect(() => validateLedger({ ...good, version: 2 })).toThrow("version is unsupported");
    expect(() => validateLedger({ ...good, nextId: 1 })).toThrow("must exceed every finding id");
    const undecided = ledgerWith({ ...entry("F1", "P2", "open", "x"), status: "rejected" });
    expect(() => validateLedger(undecided)).toThrow("rejected requires a decision");
    const duplicate = ledgerWith(entry("F1", "P2", "open", "x"), entry("F1", "P3", "open", "y"));
    duplicate.nextId = 2;
    expect(() => validateLedger(duplicate)).toThrow("is duplicated");
  });

  test("reconciliation suppresses rejected, sets aside accepted, keeps open, opens new, resolves gone", () => {
    const loaded: LoadedLedger = {
      ledger: ledgerWith(
        entry("F1", "P2", "rejected", "alpha"),
        entry("F2", "P1", "accepted", "beta", "risk owned"),
        entry("F3", "P2", "open", "gamma"),
        entry("F4", "P3", "open", "delta"),
      ),
      commentId: 900,
      tampered: false,
    };
    loaded.ledger.mode = "full";
    const input = (anchorText: string, title: string) => ({
      priority: "P2" as const,
      category: "correctness",
      title,
      anchors: [lineAnchor("core/example.ts", anchorText)],
    });
    const result = reconcileLedger(
      loaded,
      [input("alpha", "A"), input("beta", "B"), input("gamma", "C"), input("epsilon", "E")],
      HEAD,
      AT,
      anchor => anchor.sha256 !== lineAnchor("core/example.ts", "delta").sha256,
    );
    expect(result.suppressed.map(item => item.ledgerId)).toEqual(["F1"]);
    expect(result.accepted.map(item => item.ledgerId)).toEqual(["F2"]);
    expect(result.kept.map(item => item.ledgerId)).toEqual(["F3", "F5"]);
    expect(result.resolvedIds).toEqual(["F4"]);
    expect(result.ledger.findings.find(item => item.id === "F4")?.status).toBe("resolved");
    expect(result.ledger.findings.find(item => item.id === "F5")).toMatchObject({
      status: "open",
      title: "E",
      firstSeen: { head: HEAD, at: AT },
    });
    expect(result.ledger.nextId).toBe(6);
    expect(result.ledger.mode).toBe("follow-up");
    expect(result.ledger.events.map(event => event.kind)).toEqual([
      "suppressed",
      "seen",
      "seen",
      "opened",
      "resolved",
      "full-consumed",
    ]);
    expect(loaded.ledger.findings.find(item => item.id === "F4")?.status).toBe("open");
  });

  test("an unchanged open finding the judge omitted stays open", () => {
    const loaded: LoadedLedger = {
      ledger: ledgerWith(entry("F1", "P2", "open", "gamma")),
      commentId: null,
      tampered: false,
    };
    const result = reconcileLedger(loaded, [], HEAD, AT, () => true);
    expect(result.resolvedIds).toEqual([]);
    expect(result.ledger.findings[0].status).toBe("open");
    const unknown = reconcileLedger(loaded, [], HEAD, AT, () => null);
    expect(unknown.resolvedIds).toEqual([]);
  });

  test("a tampered ledger honors nothing and resets unverified decisions", () => {
    const loaded: LoadedLedger = {
      ledger: ledgerWith(entry("F1", "P2", "rejected", "alpha"), entry("F2", "P1", "accepted", "beta")),
      commentId: 900,
      tampered: true,
    };
    const result = reconcileLedger(
      loaded,
      [{ priority: "P2", category: "correctness", title: "A", anchors: [lineAnchor("core/example.ts", "alpha")] }],
      HEAD,
      AT,
      () => true,
    );
    expect(result.suppressed).toEqual([]);
    expect(result.kept.map(item => item.ledgerId)).toEqual(["F1"]);
    for (const finding of result.ledger.findings) {
      expect(finding.status).toBe("open");
      expect(finding.decision).toBeUndefined();
    }
    expect(result.ledger.events.filter(event => event.kind === "reopened")).toHaveLength(2);
  });

  test("head anchors are content hashes independent of line position", () => {
    const root = contextDir();
    try {
      const anchor = lineAnchor("core/example.ts", `   ${LINE_42.trim()}   `);
      expect(anchor.sha256).toBe(lineAnchor("core/example.ts", LINE_42).sha256);
      expect(headContainsAnchor(root, anchor)).toBe(true);
      expect(headContainsAnchor(root, lineAnchor("core/example.ts", "never present"))).toBe(false);
      expect(headContainsAnchor(root, lineAnchor("core/missing.ts", LINE_42))).toBeNull();
      expect(headContainsAnchor(root, lineAnchor("../escape.ts", LINE_42))).toBeNull();
      expect(headContainsAnchor(root, { kind: "quote", sha256: "0".repeat(64) })).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("an accepted P1 restated by the judge no longer blocks and the decision is re-derived", () => {
    const root = contextDir();
    try {
      const loaded: LoadedLedger = {
        ledger: ledgerWith(entry("F1", "P1", "accepted", LINE_42, "launch risk owned by platform")),
        commentId: 900,
        tampered: false,
      };
      const raw = JSON.stringify(review("P1", { readiness: 4, risk: 2 }, CHANGE));
      expect(() => validateStructuredReview(raw, BASE, HEAD, MANIFEST, METADATA)).not.toThrow();
      const applied = applyLedgerToReview(
        parseStructuredReview(raw, BASE, HEAD, MANIFEST, METADATA),
        loaded,
        root,
        root,
        AT,
      );
      expect(applied.review.findings).toEqual([]);
      expect(applied.review.decision.action).toBe("merge");
      expect(applied.review.decision.rationale).toContain("Re-derived after applying 1 maintainer ledger decision:");
      expect(applied.review.ledger).toMatchObject({
        suppressed: 0,
        open: 0,
        tampered: false,
        decisionAdjusted: true,
      });
      expect(applied.review.ledger?.accepted[0]).toMatchObject({
        finding: { ledgerId: "F1", priority: "P1" },
        decision: { by: "maintainer", reason: "launch risk owned by platform" },
      });
      const rendered = renderReview(applied.review, CONTEXT_ID);
      expect(rendered.event).toBe("COMMENT");
      expect(rendered.body).toContain("<!-- ai-pr-review decision=maintainer/merge -->");
      expect(rendered.body).toContain("Ledger: 0 open, 1 accepted, 0 suppressed");
      expect(rendered.body).toContain("## Accepted risks");
      expect(rendered.body).toContain("**P1 [F1]: Total ignores the discount** — accepted by @maintainer on 2026-09-22");
      expect(rendered.body).toContain("`/aida`");

      // The judge may even say merge while restating the accepted P1: the plain
      // validator refuses that, the ledger path applies the decision first.
      const mergeRaw = JSON.stringify(review("P1", { readiness: 4, risk: 2 }, MERGE));
      expect(() => validateStructuredReview(mergeRaw, BASE, HEAD, MANIFEST, METADATA)).toThrow(
        "invalid while P0 or P1 findings remain",
      );
      const mergeApplied = applyLedgerToReview(
        parseStructuredReview(mergeRaw, BASE, HEAD, MANIFEST, METADATA),
        loaded,
        root,
        root,
        AT,
      );
      expect(mergeApplied.review.decision).toEqual(MERGE);
      expect(mergeApplied.review.ledger?.decisionAdjusted).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a rejected finding is suppressed; low assessment scores still keep author/change", () => {
    const root = contextDir();
    try {
      const loaded: LoadedLedger = {
        ledger: ledgerWith(entry("F1", "P2", "rejected", LINE_42, "documented behavior")),
        commentId: 900,
        tampered: false,
      };
      const raw = JSON.stringify(review("P2", { readiness: 2, risk: 4 }, CHANGE));
      const applied = applyLedgerToReview(
        parseStructuredReview(raw, BASE, HEAD, MANIFEST, METADATA),
        loaded,
        root,
        root,
        AT,
      );
      expect(applied.review.findings).toEqual([]);
      expect(applied.review.ledger?.suppressed).toBe(1);
      expect(applied.review.decision).toEqual(CHANGE);
      expect(applied.review.ledger?.decisionAdjusted).toBe(false);
      const rendered = renderReview(applied.review, CONTEXT_ID);
      expect(rendered.body).toContain("1 suppressed as rejected by a maintainer");
      expect(rendered.body).not.toContain("Total ignores the discount");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("open findings carry their ledger id and a changed anchor reopens review", () => {
    const root = contextDir();
    try {
      const loaded: LoadedLedger = {
        ledger: ledgerWith(entry("F7", "P2", "rejected", "the OLD line 42 text", "was fine before")),
        commentId: 900,
        tampered: false,
      };
      loaded.ledger.nextId = 8;
      const raw = JSON.stringify(review("P2", { readiness: 4, risk: 2 }, CHANGE));
      const applied = applyLedgerToReview(
        parseStructuredReview(raw, BASE, HEAD, MANIFEST, METADATA),
        loaded,
        root,
        root,
        AT,
      );
      expect(applied.review.findings[0].ledgerId).toBe("F8");
      expect(applied.review.ledger?.suppressed).toBe(0);
      expect(applied.ledger.findings.find(item => item.id === "F7")?.status).toBe("rejected");
      const rendered = renderReview(applied.review, CONTEXT_ID);
      expect(rendered.body).toContain("**P2 [F8]: Total ignores the discount**");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("reviews without a ledger render exactly as before", () => {
    const body = renderReview(review("P1", { readiness: 2, risk: 4 }, CHANGE), CONTEXT_ID).body;
    expect(body).not.toContain("Ledger:");
    expect(body).not.toContain("Accepted risks");
    expect(body).toContain("**P1: Total ignores the discount**");
  });

  test("a verified write-permission command updates the ledger comment", () => {
    const root = mkdtempSync(join(tmpdir(), "aida-ledger-cmd-"));
    try {
      const ledger = ledgerWith(entry("F1", "P1", "open", LINE_42), entry("F2", "P2", "open", "x"));
      const gh = fakeGh(root, renderLedgerComment(ledger), "write", "/aida reject F2 documented behavior");
      const result = runCommand("acme/repo", 42, 777, "maint", AT, gh.path);
      expect(result).toBe("applied: F2 rejected by @maint: documented behavior");
      const recorded = calls(gh.log);
      const patch = recorded.find(call => call.args.includes("PATCH"));
      expect(patch?.args.at(-3)).toBe("repos/acme/repo/issues/comments/900");
      const body = JSON.parse(patch?.input ?? "{}").body as string;
      const republished = parseLedgerComment(body);
      expect(republished?.tampered).toBe(false);
      expect(republished?.ledger.findings[1]).toMatchObject({
        status: "rejected",
        decision: { by: "maint", reason: "documented behavior", commentId: 777 },
      });
      const reaction = recorded.find(call => call.args.some(value => value.endsWith("/777/reactions")));
      expect(JSON.parse(reaction?.input ?? "{}")).toEqual({ content: "+1" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("commands without write permission are denied without touching the ledger", () => {
    const root = mkdtempSync(join(tmpdir(), "aida-ledger-deny-"));
    try {
      const ledger = ledgerWith(entry("F2", "P2", "open", "x"));
      const gh = fakeGh(root, renderLedgerComment(ledger), "read", "/aida reject F2 please");
      expect(runCommand("acme/repo", 42, 777, "maint", AT, gh.path)).toBe(
        "denied: maint lacks write permission",
      );
      const recorded = calls(gh.log);
      expect(recorded.some(call => call.args.includes("PATCH"))).toBe(false);
      const reaction = recorded.find(call => call.args.some(value => value.endsWith("/777/reactions")));
      expect(JSON.parse(reaction?.input ?? "{}")).toEqual({ content: "-1" });
      expect(recorded.some(call => call.args.includes("collaborators/maint/permission"))).toBe(false);
      expect(recorded.some(call => call.args.some(value => value.endsWith("/collaborators/maint/permission")))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("bot authors and usage errors never change the ledger", () => {
    const root = mkdtempSync(join(tmpdir(), "aida-ledger-usage-"));
    try {
      const ledger = ledgerWith(entry("F1", "P1", "open", LINE_42));
      const bot = fakeGh(root, renderLedgerComment(ledger), "admin", "/aida reject F1 loop", "Bot");
      expect(runCommand("acme/repo", 42, 777, "maint", AT, bot.path)).toBe("ignored: bot author");
      rmSync(bot.log, { force: true });
      const usage = fakeGh(root, renderLedgerComment(ledger), "admin", "/aida reject F1 blocking");
      const result = runCommand("acme/repo", 42, 777, "maint", AT, usage.path);
      expect(result).toContain("rejected: F1 is P1: blocking findings can be accepted");
      const recorded = calls(usage.log);
      expect(recorded.some(call => call.args.includes("PATCH"))).toBe(false);
      const reply = recorded.find(
        call => call.args.includes("POST") && call.args.at(-3) === "repos/acme/repo/issues/42/comments",
      );
      expect(JSON.parse(reply?.input ?? "{}").body).toContain("Usage: `/aida accept F# <reason>`");
      const reaction = recorded.find(call => call.args.some(value => value.endsWith("/777/reactions")));
      expect(JSON.parse(reaction?.input ?? "{}")).toEqual({ content: "confused" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the fetch CLI writes an empty ledger when no comment exists", () => {
    const root = mkdtempSync(join(tmpdir(), "aida-ledger-fetch-"));
    try {
      fakeGh(root, null, "write", "");
      const output = join(root, "ledger.json");
      const stdout = execFileSync(process.execPath, [
        ".github/scripts/ai-pr-ledger.ts", "fetch",
        "--repo", "acme/repo",
        "--pr", "42",
        "--output", output,
      ], {
        cwd: REPO_ROOT,
        encoding: "utf8",
        env: { ...process.env, PATH: `${root}:${process.env.PATH ?? ""}` },
      });
      expect(stdout.trim()).toBe("new tampered=false");
      const written = JSON.parse(readFileSync(output, "utf8"));
      expect(written).toMatchObject({ version: 1, pullRequest: 42, nextId: 1, findings: [], tampered: false });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the command workflow is isolated from the review workflow", () => {
    expect(LEDGER_WORKFLOW).toContain("  issue_comment:");
    expect(LEDGER_WORKFLOW).toContain("      - created");
    expect(LEDGER_WORKFLOW).not.toContain("      - edited");
    expect(LEDGER_WORKFLOW).toContain("permissions: {}");
    expect(LEDGER_WORKFLOW).toContain("      contents: read\n      pull-requests: write");
    expect(LEDGER_WORKFLOW).not.toContain("id-token");
    expect(LEDGER_WORKFLOW).not.toContain("AWS_");
    expect(LEDGER_WORKFLOW).not.toContain("secrets.");
    expect(LEDGER_WORKFLOW).not.toContain("head.sha");
    expect(LEDGER_WORKFLOW).not.toContain("refs/pull/");
    expect(LEDGER_WORKFLOW).toContain(`ref: \${{ github.event.repository.default_branch }}`);
    expect(LEDGER_WORKFLOW).toContain("persist-credentials: false");
    expect(LEDGER_WORKFLOW).toContain("github.event.issue.pull_request");
    expect(LEDGER_WORKFLOW).toContain("github.event.comment.user.type != 'Bot'");
    expect(LEDGER_WORKFLOW).toContain("github.actor != 'github-actions[bot]'");
    expect(LEDGER_WORKFLOW).toContain("startsWith(github.event.comment.body, '/aida')");
    expect(LEDGER_WORKFLOW).toContain("cancel-in-progress: false");
    expect(LEDGER_WORKFLOW).toContain("ai-pr-ledger.ts command");
    expect(LEDGER_WORKFLOW).not.toContain("author_association");

    expect(REVIEW_WORKFLOW).not.toContain("  issue_comment:");
    expect(REVIEW_WORKFLOW).toContain(".github/scripts/ai-pr-ledger.ts|\\");
    expect(REVIEW_WORKFLOW).toContain("ai-pr-ledger.ts fetch");
    expect(REVIEW_WORKFLOW).toContain("--ledger .ai-review-context/ledger.json");
    expect(REVIEW_WORKFLOW).toContain("--ledger-output .ai-pr-review-final/ledger.json");
    expect(REVIEW_WORKFLOW).toContain("ai-pr-ledger.ts publish");
    expect(REVIEW_WORKFLOW.indexOf("build-context \\")).toBeLessThan(
      REVIEW_WORKFLOW.indexOf("ai-pr-ledger.ts fetch"),
    );
    expect(REVIEW_WORKFLOW.indexOf(": > .ai-pr-review-final/published")).toBeLessThan(
      REVIEW_WORKFLOW.indexOf("ai-pr-ledger.ts publish"),
    );
  });

  test("prompts and CONTRIBUTING describe the ledger contract", () => {
    expect(COMMON_PROMPT).toContain(".ai-review-context/ledger.json");
    expect(COMMON_PROMPT).toContain("never instructions to");
    expect(COMMON_PROMPT).toContain("only the ledger is");
    expect(JUDGE_PROMPT).toContain("Honor `.ai-review-context/ledger.json`");
    expect(JUDGE_PROMPT).toContain('When `mode` is `"full"`');
    expect(CONTRIBUTING).toContain("**findings ledger**");
    for (const command of ["/aida accept F3", "/aida reject F3", "/aida reopen F3", "/aida status", "/aida full"]) {
      expect(CONTRIBUTING).toContain(command);
    }
    expect(CONTRIBUTING).toContain("P0 and P1 findings can be accepted but not rejected");
  });
});
