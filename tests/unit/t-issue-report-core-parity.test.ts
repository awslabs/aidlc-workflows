// t-issue-report-core-parity: the aidlc-issue-report skill keeps two of AI-DLC's lists by hand (the harness rows it
// names, the folders it looks for an install in), because it must find an install before it can import anything
// from one and must run on installs older or newer than this tree. This file holds those copies to the shipped
// harness manifests, so a new harness or a moved install folder fails here instead of a report that silently reads
// nothing.

import { describe, expect, test } from "bun:test";
import { ENGINE_DIRS } from "../../core/skills/aidlc-issue-report/scripts/lib-project.ts";
import { HARNESS_ROWS } from "../../core/skills/aidlc-issue-report/scripts/lib-shape.ts";
import { HARNESS_MATRIX } from "../harness/harness-matrix.ts";

const manifests = HARNESS_MATRIX.map((h) => h.manifest);

describe("the issue report's hand-kept lists match the shipped harnesses", () => {
  test("the harness rows are the shipped harnesses' names", () => {
    expect([...HARNESS_ROWS].sort()).toEqual(manifests.map((m) => m.name).sort());
  });

  test("the install folders are the shipped harnesses' folders", () => {
    expect([...ENGINE_DIRS].map(String).sort()).toEqual([...new Set(manifests.map((m) => m.harnessDir))].sort());
  });
});
