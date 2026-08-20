// covers: file:aidlc-common/stages/inception/reverse-engineering.md, file:knowledge/aidlc-developer-agent/re-artifacts.md
//
// t304 - Focused Reverse Engineering rescans merge into the shared CodeKB.
// These prose pins keep the stage contract and developer artifact guidance in
// sync without changing the deterministic codekb-scope-diff machinery.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../harness/fixtures.ts";

const STAGE = readFileSync(
  join(
    REPO_ROOT,
    "core",
    "aidlc-common",
    "stages",
    "inception",
    "reverse-engineering.md",
  ),
  "utf-8",
);
const ARTIFACTS = readFileSync(
  join(
    REPO_ROOT,
    "core",
    "knowledge",
    "aidlc-developer-agent",
    "re-artifacts.md",
  ),
  "utf-8",
);

describe("t304 cumulative CodeKB merge contract", () => {
  test("the stage mandates focused merge and preserves prior prose", () => {
    expect(STAGE).toContain(
      "a focused scan MERGES into the existing store so knowledge",
    );
    expect(STAGE).toContain(
      "read the existing 9 artifacts and the store's Scope of Analysis",
    );
    expect(STAGE).toContain("preserve prior sections outside it");
  });

  test("CURRENT focused merges retain the verified union", () => {
    expect(STAGE).toContain(
      "set `analyzed.paths` and `analyzed.components` to the union of",
    );
    expect(STAGE).toContain(
      "A CURRENT `kind: full` store stays `kind: full` and",
    );
    expect(STAGE).toContain(
      "keeps `./` in `analyzed.paths`; otherwise use `kind: partial`",
    );
  });

  test("STALE and UNVERIFIED focused merges demote prior deep paths", () => {
    expect(STAGE).toContain(
      "set `analyzed.paths` and `analyzed.components` from",
    );
    expect(STAGE).toContain(
      "demote the store's prior",
    );
    expect(STAGE).toContain(
      "`analyzed.paths` into `shallow.paths`",
    );
  });

  test("full rescans remain wholesale replacements", () => {
    expect(STAGE).toContain(
      "**Full rescan:** wholesale replace all 9 artifacts",
    );
    expect(STAGE).toContain(
      "build the scope block",
    );
    expect(STAGE).toContain(
      "only from this run, unchanged from the existing full-rescan behavior",
    );
  });

  test("artifact guidance carries matching merge and parser rules", () => {
    expect(ARTIFACTS).toContain(
      "A full rescan wholesale replaces all 9 artifacts",
    );
    expect(ARTIFACTS).toContain(
      "merge `analyzed.paths` and `analyzed.components` as the union",
    );
    expect(ARTIFACTS).toContain(
      "demote the store's prior analyzed paths into `shallow.paths`",
    );
    expect(ARTIFACTS).toContain(
      "`kind: partial` MUST NOT include `./` in `analyzed.paths`",
    );
  });
});
