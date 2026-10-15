// covers: file:tools/aidlc-kiro-review-copy.ts, function:previewFeatureOn, function:reviewCopyExcludes, function:renderReviewCopy, function:prepareReviewCopy, function:removeReviewCopy, function:scopedReviewCopyName, function:isScopedReviewCopy, function:normalizedPathComponents
//
// On Kiro (kiro-ide) a delegated reviewer's own `fs_read` deny with an
// `exclude` is enforced, and the agent file is read again at each dispatch
// (Kiro CLI 2.31.0, Kiro IDE 1.3.0). With the reviewer read-scope preview
// feature on, a Unit's review request writes a copy of the installed reviewer
// carrying that review's read scope, and the conductor dispatches the copy.
// These are the pure parts and the conditions; the request, the completion and
// the verdict run end to end in tests/integration/t-kiro-review-copy-flow.test.ts.

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PREVIEW_FEATURES_ENV,
  prepareReviewCopy,
  previewFeatureOn,
  REVIEWER_READ_SCOPE_FEATURE,
  removeReviewCopy,
  renderReviewCopy,
  reviewCopyExcludes,
} from "../../core/tools/aidlc-kiro-review-copy.ts";
import {
  _resetAgentsForTests,
  isScopedReviewCopy,
  loadAgents,
  normalizedPathComponents,
  scopedReviewCopyName,
} from "../../core/tools/aidlc-lib.ts";
import { REPO_ROOT } from "../harness/fixtures.ts";

const PREVIEW = "2.11.0-preview.20261015.1";
const STABLE = "2.11.0";
const ON = { [PREVIEW_FEATURES_ENV]: REVIEWER_READ_SCOPE_FEATURE };
const REVIEWER = "aidlc-architecture-reviewer-agent";
const SHIPPED_REVIEWER = join(REPO_ROOT, "dist", "kiro-ide", ".kiro", "agents", `${REVIEWER}.md`);
const REQUEST = `review:${"0123456789ab"}${"c".repeat(20)}`;
const COPY = "aidlc-review-0123456789ab";

describe("the preview switch", () => {
  test("a feature is on only in a preview build, and only when it is named", () => {
    expect(previewFeatureOn(REVIEWER_READ_SCOPE_FEATURE, ON, PREVIEW)).toBe(true);
    expect(previewFeatureOn(REVIEWER_READ_SCOPE_FEATURE, { [PREVIEW_FEATURES_ENV]: " other , reviewer-read-scope " }, PREVIEW))
      .toBe(true);
    expect(previewFeatureOn(REVIEWER_READ_SCOPE_FEATURE, ON, STABLE)).toBe(false);
    expect(previewFeatureOn(REVIEWER_READ_SCOPE_FEATURE, {}, PREVIEW)).toBe(false);
    expect(previewFeatureOn(REVIEWER_READ_SCOPE_FEATURE, { [PREVIEW_FEATURES_ENV]: "reviewer-read" }, PREVIEW)).toBe(false);
  });
});

describe("the copy's name", () => {
  test("comes from the request id, and only from one minted as review:<hex>", () => {
    expect(scopedReviewCopyName(REQUEST)).toBe(COPY);
    expect(scopedReviewCopyName("review:0123")).toBeNull();
    expect(scopedReviewCopyName("legacy-request")).toBeNull();
    expect(isScopedReviewCopy(COPY)).toBe(true);
    expect(isScopedReviewCopy(`.kiro/agents/${COPY}.md`)).toBe(true);
    expect(isScopedReviewCopy("aidlc-review-notes")).toBe(false);
    expect(isScopedReviewCopy(REVIEWER)).toBe(false);
  });
});

describe("the read scope", () => {
  test("excludes the Unit's folder and each exempt file in another Unit's folder, by its part from construction/", () => {
    expect(reviewCopyExcludes("alpha", [
      "aidlc/spaces/default/intents/261015-notes/inception/components.md",
      "aidlc/spaces/default/intents/261015-notes/construction/alpha/functional-design/functional-design-questions.md",
      "/work/notes/aidlc/spaces/default/intents/261015-notes/construction/beta/functional-design/api.md",
      "construction/alpha/../beta/functional-design/api.md",
    ])).toEqual([
      "aidlc/spaces/*/intents/*/construction/alpha/**",
      "aidlc/spaces/*/intents/*/construction/beta/functional-design/api.md",
    ]);
  });

  test("an absolute path is read from the project, and the Unit's own folder in any letter case", () => {
    const project = "/work/construction/notes";
    expect(reviewCopyExcludes("alpha", [
      `${project}/aidlc/spaces/default/intents/261015-notes/construction/beta/functional-design/api.md`,
    ], project)).toEqual([
      "aidlc/spaces/*/intents/*/construction/alpha/**",
      "aidlc/spaces/*/intents/*/construction/beta/functional-design/api.md",
    ]);
    expect(reviewCopyExcludes("U01", ["construction/u01/functional-design/api.md"]))
      .toEqual(["aidlc/spaces/*/intents/*/construction/U01/**"]);
  });

  test("a path that cannot be written as an exact pattern makes no copy", () => {
    expect(reviewCopyExcludes("alpha", ["construction/beta/*.md"])).toBeNull();
    expect(reviewCopyExcludes("alpha", ['construction/beta/a"b.md'])).toBeNull();
    expect(reviewCopyExcludes("al*", [])).toBeNull();
    expect(reviewCopyExcludes("", [])).toBeNull();
    expect(reviewCopyExcludes("..", [])).toBeNull();
  });

  test("the hook and the copy read .. the same way", () => {
    expect(normalizedPathComponents("construction/U03/../U01/./design.md")).toEqual(["construction", "U01", "design.md"]);
    expect(normalizedPathComponents("../construction/U01")).toEqual(["..", "construction", "U01"]);
  });
});

describe("the copy's text", () => {
  test("the shipped reviewer, renamed, with the deny rule last in its permissions", () => {
    const shipped = readFileSync(SHIPPED_REVIEWER, "utf-8");
    const copy = renderReviewCopy(shipped, COPY, reviewCopyExcludes("alpha", [
      "construction/beta/functional-design/api.md",
    ])!);
    expect(copy).not.toBeNull();
    const front = copy!.split("\n---\n")[0];
    expect(front).toContain(`\nname: ${COPY}\n`);
    expect(front).toContain('\ndisplay_name: "Architecture Reviewer (this review)"\n');
    expect(front.endsWith([
      "    - capability: fs_read",
      "      effect: deny",
      "      match:",
      '        - "aidlc/spaces/*/intents/*/construction/**"',
      "      exclude:",
      '        - "aidlc/spaces/*/intents/*/construction/alpha/**"',
      '        - "aidlc/spaces/*/intents/*/construction/beta/functional-design/api.md"',
    ].join("\n"))).toBe(true);
    // Everything else is the installed file as it was.
    const added = copy!.split("\n").filter((line) => !shipped.split("\n").includes(line));
    expect(added.filter((line) => !/fs_read|effect: deny|match:|exclude:|construction|^name:|^display_name:/.test(line)))
      .toEqual([]);
    expect(copy!.slice(copy!.indexOf("\n---\n"))).toBe(shipped.slice(shipped.indexOf("\n---\n")));
  });

  test("keeps CRLF line ends and a quoted display name", () => {
    const text = ["---", "name: r", 'display_name: "Reviewer"', "permissions:", "  rules:", "    - capability: shell",
      "      effect: allow", "---", "", "Body"].join("\r\n");
    const copy = renderReviewCopy(text, COPY, ["aidlc/spaces/*/intents/*/construction/alpha/**"])!;
    expect(copy).toContain('\r\ndisplay_name: "Reviewer (this review)"\r\n');
    expect(copy).toContain('      effect: allow\r\n    - capability: fs_read\r\n');
    expect(copy.endsWith("---\r\n\r\nBody")).toBe(true);
  });

  test("a display name that is not plain words is left as it is", () => {
    const text = (display: string) => ["---", "name: r", `display_name: ${display}`, "permissions:", "  rules:",
      "    - capability: shell", "      effect: allow", "---", ""].join("\n");
    expect(renderReviewCopy(text("[Arch] Reviewer"), COPY, [])).toContain("\ndisplay_name: [Arch] Reviewer\n");
    expect(renderReviewCopy(text("Reviewer: architecture"), COPY, [])).toContain("\ndisplay_name: Reviewer: architecture\n");
  });

  test("a file without permissions.rules in the shipped shape makes no copy", () => {
    expect(renderReviewCopy("---\nname: r\n---\nBody", COPY, [])).toBeNull();
    expect(renderReviewCopy("---\nname: r\npermissions:\n  rules: []\n---\n", COPY, [])).toBeNull();
    expect(renderReviewCopy("no frontmatter", COPY, [])).toBeNull();
  });
});

describe("writing and removing the copy", () => {
  const saved = { ...process.env };
  let dir = "";
  afterEach(() => {
    for (const key of ["AIDLC_AGENTS_DIR", "AIDLC_HARNESS_NAME"]) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    _resetAgentsForTests();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function project(): string {
    dir = mkdtempSync(join(tmpdir(), "t-kiro-review-copy-"));
    const agents = join(dir, ".kiro", "agents");
    mkdirSync(agents, { recursive: true });
    writeFileSync(join(agents, `${REVIEWER}.md`), readFileSync(SHIPPED_REVIEWER, "utf-8"));
    process.env.AIDLC_AGENTS_DIR = agents;
    process.env.AIDLC_HARNESS_NAME = "kiro-ide";
    return dir;
  }

  const review = { requestId: REQUEST, reviewer: REVIEWER, unit: "alpha", exempt: [] };

  test("a preview build with the feature on writes it beside the reviewer; the roster does not load it", () => {
    const p = project();
    expect(prepareReviewCopy(p, review, { env: ON, version: PREVIEW })).toBe(COPY);
    const copy = join(p, ".kiro", "agents", `${COPY}.md`);
    expect(readFileSync(copy, "utf-8")).toContain('        - "aidlc/spaces/*/intents/*/construction/alpha/**"');
    expect(readFileSync(join(p, ".kiro", "agents", `${REVIEWER}.md`), "utf-8")).toBe(readFileSync(SHIPPED_REVIEWER, "utf-8"));
    _resetAgentsForTests();
    expect(loadAgents().map((agent) => agent.slug)).toEqual([REVIEWER]);
    removeReviewCopy(p, REQUEST);
    expect(existsSync(copy)).toBe(false);
  });

  test("anything else dispatches the reviewer itself and writes nothing", () => {
    const p = project();
    const none = (label: string, value: string | null) => {
      expect(value, label).toBeNull();
      expect(existsSync(join(p, ".kiro", "agents", `${COPY}.md`)), label).toBe(false);
    };
    none("stable build", prepareReviewCopy(p, review, { env: ON, version: STABLE }));
    none("feature not named", prepareReviewCopy(p, review, { env: {}, version: PREVIEW }));
    none("not a Unit's review", prepareReviewCopy(p, { ...review, unit: undefined }, { env: ON, version: PREVIEW }));
    none("reviewer-scope check switched off", prepareReviewCopy(p, review, {
      env: { ...ON, AIDLC_DISABLE_REVIEWER_SCOPE_HOOK: "1" }, version: PREVIEW,
    }));
    none("an exempt glob", prepareReviewCopy(p, { ...review, exempt: ["construction/beta/*"] }, { env: ON, version: PREVIEW }));
    none("no such reviewer", prepareReviewCopy(p, { ...review, reviewer: "aidlc-missing-agent" }, { env: ON, version: PREVIEW }));
    process.env.AIDLC_HARNESS_NAME = "kiro";
    none("another harness", prepareReviewCopy(p, review, { env: ON, version: PREVIEW }));
  });
});
