// covers: file:aidlc-common/protocols/stage-protocol-reviewer.md, file:aidlc-common/protocols/stage-protocol.md, file:knowledge/aidlc-product-lead-agent/reviewing.md, file:knowledge/aidlc-architecture-reviewer-agent/reviewing.md

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../harness/fixtures.ts";
import { HARNESS_MATRIX } from "../harness/harness-matrix.ts";

const REVIEWERS = [
  "aidlc-product-lead-agent",
  "aidlc-architecture-reviewer-agent",
] as const;
const FINDINGS_HEADER =
  "| ID | Severity | Location | Finding | Required action | Status |";

function read(path: string): string {
  return readFileSync(path, "utf-8");
}

function reviewerExecutionSurface(
  harness: (typeof HARNESS_MATRIX)[number],
  reviewer: (typeof REVIEWERS)[number],
): string {
  if (harness.name === "codex") {
    return join(harness.engineRoot, "agents", `${reviewer}.toml`);
  }
  if (harness.name === "opencode") {
    return join(harness.distRoot, ".opencode", "agents", `${reviewer}.md`);
  }
  return join(harness.engineRoot, "agents", `${reviewer}.md`);
}

describe("t304 reviewer-backed human gates carry an actionable Review brief", () => {
  const protocolPaths = [
    join(
      REPO_ROOT,
      "core",
      "aidlc-common",
      "protocols",
      "stage-protocol-reviewer.md",
    ),
    ...HARNESS_MATRIX.map((harness) =>
      join(
        harness.engineRoot,
        "aidlc-common",
        "protocols",
        "stage-protocol-reviewer.md",
      )
    ),
  ];

  test("the contract is present in core and all seven dist projections", () => {
    expect(HARNESS_MATRIX).toHaveLength(7);
    for (const path of protocolPaths) {
      const body = read(path);
      for (const marker of [
        "Review brief (required at every reviewer-backed human gate)",
        "`**Stage:** [stage display name]`",
        "`**Review outcome:** [plain-language outcome]`",
        "never print the raw `READY` or `NOT-READY` token in user-facing prose",
        "`**Why now:**`",
        "workspace-relative artifact path plus section or element",
        "`**Approve** - continue with the open findings accepted.`",
        "`**Request Changes** - return to the listed artifacts",
      ]) {
        expect(body, `${path} missing ${marker}`).toContain(marker);
      }
    }
  });

  test("every terminal reviewer path points to the shared Review brief", () => {
    const body = read(protocolPaths[0]);
    for (const marker of [
      "On an incomplete attempt:",
      "On an `advisory` review, both verdicts are terminal here.",
      "Any human gate after that recovery verdict uses the required Review brief",
      "present the approval gate using the required Review brief above",
      "Proceed to the approval gate using the required Review brief above",
      "re-presented gate using the required Review brief",
    ]) {
      expect(body).toContain(marker);
    }
  });

  test("Part 3 orders the Review brief before the approval question", () => {
    const paths = [
      join(
        REPO_ROOT,
        "core",
        "aidlc-common",
        "protocols",
        "stage-protocol.md",
      ),
      ...HARNESS_MATRIX.map((harness) =>
        join(
          harness.engineRoot,
          "aidlc-common",
          "protocols",
          "stage-protocol.md",
        )
      ),
    ];
    for (const path of paths) {
      const body = read(path);
      expect(body).toContain(
        "present the Review brief required by\n`stage-protocol-reviewer.md` §12a before the artifact path and approval\nquestion",
      );
    }
  });
});

describe("t304 finding identity and disposition survive re-review", () => {
  test("prior findings are extracted before deletion and passed to the reviewer", () => {
    const body = read(
      join(
        REPO_ROOT,
        "core",
        "aidlc-common",
        "protocols",
        "stage-protocol-reviewer.md",
      ),
    );
    const extract = body.indexOf(
      "extract the complete prior `### Findings` table BEFORE deleting the section",
    );
    const deletion = body.indexOf(
      "DELETE the existing `## Review` section",
      extract,
    );
    expect(extract).toBeGreaterThan(-1);
    expect(deletion).toBeGreaterThan(extract);
    expect(body).toContain("`Prior findings (carry IDs forward):`");
    expect(body).toContain(
      "preserve those IDs and update their statuses rather than replacing or renumbering",
    );
  });

  for (const reviewer of REVIEWERS) {
    test(`${reviewer} authors stable IDs, exact locations, actions, and statuses`, () => {
      const knowledgePath = join(
        REPO_ROOT,
        "core",
        "knowledge",
        reviewer,
        "reviewing.md",
      );
      const body = read(knowledgePath);
      expect(body).toContain(FINDINGS_HEADER);
      expect(body).toContain("`R-01`, `R-02`, ...");
      expect(body).toContain(
        "`Location` MUST be a workspace-relative artifact path followed",
      );
      expect(body).toContain(
        "`Required action` MUST state the concrete work",
      );
      expect(body).toContain("`Prior findings (carry IDs forward)`");
      expect(body).toContain(
        "`Unresolved`, `Resolved`, `Rejected: <reason>`, or `Accepted risk`",
      );
      expect(body).toContain("next unused `R-NN` ID");
      expect(body).toContain("aidlc/spaces/<space>/intents/");
    });
  }

  test("all seven reviewer execution surfaces absorb the new findings contract", () => {
    expect(HARNESS_MATRIX).toHaveLength(7);
    for (const harness of HARNESS_MATRIX) {
      for (const reviewer of REVIEWERS) {
        const body = read(reviewerExecutionSurface(harness, reviewer));
        expect(body).toContain(FINDINGS_HEADER);
        expect(body).toContain("`Prior findings (carry IDs forward)`");
        expect(body).toContain("never renumber, reuse, or drop an ID");
        expect(body).toContain(
          "`Unresolved`, `Resolved`, `Rejected: <reason>`, or `Accepted risk`",
        );
      }
    }
  });
});
