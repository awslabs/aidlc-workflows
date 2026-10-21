// covers: file:tools/aidlc-kiro-review-copy.ts, function:renderReviewCopy, function:prepareReviewCopy, function:scopedReviewCopyName, function:isScopedReviewCopy
//
// On Kiro (kiro-ide) a delegated reviewer's own `fs_read` deny with an
// `exclude` is enforced, and the agent file is read again at each dispatch
// (Kiro CLI 2.31.0, Kiro IDE 1.3.0). While the reviewer read-scope check
// holds, a Unit's review request writes a copy of the installed reviewer
// carrying that review's read scope, and the conductor dispatches the copy.
// These are the pure parts and the conditions; the request, the completion and
// the verdict run end to end in tests/integration/t-kiro-review-copy-flow.test.ts.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareReviewCopy, renderReviewCopy } from "../../core/tools/aidlc-kiro-review-copy.ts";
import {
  _resetAgentsForTests,
  isScopedReviewCopy,
  loadAgents,
  scopedReviewCopyName,
} from "../../core/tools/aidlc-lib.ts";
import { REPO_ROOT } from "../harness/fixtures.ts";

const STABLE = "2.11.0";
const REVIEWER = "aidlc-architecture-reviewer-agent";
const SHIPPED_REVIEWER = join(REPO_ROOT, "dist", "kiro-ide", ".kiro", "agents", `${REVIEWER}.md`);
const REQUEST = `review:${"0123456789ab"}${"c".repeat(20)}`;
const COPY = "aidlc-scoped-review-0123456789ab";
const RECORD = "aidlc/spaces/default/intents/261015-notes";

const saved = { ...process.env };
afterEach(() => {
  for (const key of ["AIDLC_AGENTS_DIR", "AIDLC_HARNESS_DIR", "AIDLC_HARNESS_NAME", "AIDLC_DISABLE_REVIEWER_SCOPE_HOOK"]) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  _resetAgentsForTests();
});

// A Kiro tree as config writes it: its identity, and a stamp when given.
function kiroTree(dir: string, distribution = "kiro-ide", extra: Record<string, unknown> = {}): void {
  mkdirSync(join(dir, ".kiro", "tools", "data"), { recursive: true });
  mkdirSync(join(dir, ".kiro", "agents"), { recursive: true });
  writeFileSync(
    join(dir, ".kiro", "tools", "data", "harness.json"),
    `${JSON.stringify({ schemaVersion: 1, harnessDir: ".kiro", distribution, ...extra })}\n`,
  );
}

function stampTree(dir: string, frameworkVersion: string): void {
  writeFileSync(
    join(dir, ".kiro", "tools", "data", "aidlc-stamp.json"),
    `${JSON.stringify({ schemaVersion: 1, harnessDir: ".kiro", distribution: "kiro-ide", frameworkVersion })}\n`,
  );
}

describe("the copy's name", () => {
  test("comes from the request id, and only from one minted as review:<hex>", () => {
    expect(scopedReviewCopyName(REQUEST)).toBe(COPY);
    expect(scopedReviewCopyName("review:0123")).toBeNull();
    expect(scopedReviewCopyName("legacy-request")).toBeNull();
    expect(isScopedReviewCopy(COPY)).toBe(true);
    expect(isScopedReviewCopy(`.kiro/agents/${COPY}.md`)).toBe(true);
    expect(isScopedReviewCopy("aidlc-scoped-review-notes")).toBe(false);
    expect(isScopedReviewCopy("aidlc-review-0123456789ab")).toBe(false);
    expect(isScopedReviewCopy(REVIEWER)).toBe(false);
  });

  test("the persona roster does not load a copy", () => {
    const dir = mkdtempSync(join(tmpdir(), "t-kiro-review-copy-"));
    try {
      const shipped = readFileSync(SHIPPED_REVIEWER, "utf-8");
      writeFileSync(join(dir, `${REVIEWER}.md`), shipped);
      writeFileSync(join(dir, `${COPY}.md`), renderReviewCopy(shipped, COPY, RECORD, "alpha")!);
      process.env.AIDLC_AGENTS_DIR = dir;
      _resetAgentsForTests();
      expect(loadAgents().map((agent) => agent.slug)).toEqual([REVIEWER]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the copy's text", () => {
  test("the shipped reviewer, renamed, with the deny rule last in its permissions", () => {
    const shipped = readFileSync(SHIPPED_REVIEWER, "utf-8");
    const copy = renderReviewCopy(shipped, COPY, RECORD, "alpha");
    expect(copy).not.toBeNull();
    const front = copy!.split("\n---\n")[0];
    expect(front).toContain(`\nname: ${COPY}\n`);
    expect(front).toContain('\ndisplay_name: "Architecture Reviewer (this review)"\n');
    expect(front.endsWith([
      "    - capability: fs_read",
      "      effect: deny",
      "      match:",
      '        - "aidlc/spaces/*/intents/*/construction/**"',
      '        - ".aidlc/worktrees/*/aidlc/spaces/*/intents/*/construction/**"',
      "      exclude:",
      // Only this intent's folder of the Unit: a Unit of the same name in another
      // intent, or in a batch's worktree, stays denied.
      `        - "${RECORD}/construction/alpha"`,
      `        - "${RECORD}/construction/alpha/**"`,
    ].join("\n"))).toBe(true);
    // Everything else is the installed file as it was.
    const added = copy!.split("\n").filter((line) => !shipped.split("\n").includes(line));
    expect(added.filter((line) => !/fs_read|effect: deny|match:|exclude:|construction|^name:|^display_name:/.test(line)))
      .toEqual([]);
    expect(copy!.slice(copy!.indexOf("\n---\n"))).toBe(shipped.slice(shipped.indexOf("\n---\n")));
  });

  test("keeps CRLF line ends and a quoted display name, and reads past a byte-order mark", () => {
    const text = ["\uFEFF---", "name: r", 'display_name: "Reviewer"', "permissions:", "  rules:", "    - capability: shell",
      "      effect: allow", "---", "", "Body"].join("\r\n");
    const copy = renderReviewCopy(text, COPY, RECORD, "alpha")!;
    expect(copy).toContain('\r\ndisplay_name: "Reviewer (this review)"\r\n');
    expect(copy).toContain("      effect: allow\r\n    - capability: fs_read\r\n");
    expect(copy.endsWith("---\r\n\r\nBody")).toBe(true);
  });

  test("a display name that is not plain words is left as it is", () => {
    const text = (display: string) => ["---", "name: r", `display_name: ${display}`, "permissions:", "  rules:",
      "    - capability: shell", "      effect: allow", "---", ""].join("\n");
    expect(renderReviewCopy(text("[Arch] Reviewer"), COPY, RECORD, "alpha")).toContain("\ndisplay_name: [Arch] Reviewer\n");
    expect(renderReviewCopy(text("Reviewer: architecture"), COPY, RECORD, "alpha")).toContain("\ndisplay_name: Reviewer: architecture\n");
  });

  test("no copy without permissions.rules in the shipped shape, or for a unit that is not a plain name", () => {
    const rules = ["---", "name: r", "permissions:", "  rules:", "    - capability: shell", "---", ""].join("\n");
    expect(renderReviewCopy(rules, COPY, RECORD, "alpha")).not.toBeNull();
    for (const unit of ["", "..", "a/b", "u*", 'a"b']) expect(renderReviewCopy(rules, COPY, RECORD, unit), unit).toBeNull();
    for (const record of ["aidlc/spaces/*/intents/x", "../aidlc/spaces/default/intents/x", "aidlc/spaces/default/intents"]) {
      expect(renderReviewCopy(rules, COPY, record, "alpha"), record).toBeNull();
    }
    expect(renderReviewCopy("---\nname: r\n---\nBody", COPY, RECORD, "alpha")).toBeNull();
    expect(renderReviewCopy("---\nname: r\npermissions:\n  rules: []\n---\n", COPY, RECORD, "alpha")).toBeNull();
    expect(renderReviewCopy("no frontmatter", COPY, RECORD, "alpha")).toBeNull();
    // A `rules:` list under another key is not the permissions list.
    expect(renderReviewCopy(["---", "name: r", "permissions:", "hooks:", "  rules:", "    - x", "---", ""].join("\n"), COPY, RECORD, "alpha"))
      .toBeNull();
  });
});

describe("when there is no copy", () => {
  test("anything but a Unit's review on Kiro's KAS tree with the check holding dispatches the reviewer itself", () => {
    const dir = mkdtempSync(join(tmpdir(), "t-kiro-review-copy-"));
    try {
      // A stable release, and a record the dropped preview switch left off: a copy is still due.
      kiroTree(dir, "kiro-ide", { previewFeatures: { "reviewer-read-scope": "off" } });
      stampTree(dir, STABLE);
      const review = { requestId: REQUEST, reviewer: REVIEWER, unit: "alpha" };
      process.env.AIDLC_HARNESS_NAME = "kiro-ide";
      expect(prepareReviewCopy(dir, { ...review, unit: undefined }), "not a Unit's review").toBeNull();
      // A request id that names no copy is a copy that was due and could not be written: said, not silent.
      expect(prepareReviewCopy(dir, { ...review, requestId: "legacy" }), "an id not minted here")
        .toEqual({ notice: expect.stringContaining("This review of alpha can read other Units' files") });
      process.env.AIDLC_DISABLE_REVIEWER_SCOPE_HOOK = "1";
      expect(prepareReviewCopy(dir, review), "reviewer-scope check switched off").toBeNull();
      delete process.env.AIDLC_DISABLE_REVIEWER_SCOPE_HOOK;
      process.env.AIDLC_HARNESS_NAME = "claude";
      expect(prepareReviewCopy(dir, review), "another harness").toBeNull();
      // The Kiro CLI v2 row's tree is not the KAS layout.
      kiroTree(dir, "kiro");
      process.env.AIDLC_HARNESS_NAME = "kiro";
      expect(prepareReviewCopy(dir, { ...review, requestId: "legacy" }), "kiro row").toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
