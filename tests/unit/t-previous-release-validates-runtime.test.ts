// covers: function:writtenRootIntegration, function:readRootIntegrations, file:core/tools/aidlc-distribution.ts, file:scripts/package.ts
//
// `aidlc update`, `aidlc use` and a rollback-then-forward from 2.10.0 run the
// 2.10.0 binary, which checks every runtime tree of the release it installs
// or switches to with its own projection validator. A release cannot change
// that check, so each runtime tree this build ships must pass it. The
// validator here is 2.10.0's own source, copied byte for byte from the v2.10.0
// tag into tests/fixtures/distribution-2.10.0 (the blob ids below prove it).

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { projectionFiles, readRootIntegrations } from "../../core/tools/aidlc-distribution.ts";
import { projectionFiles as projectionFiles2100 } from "../fixtures/distribution-2.10.0/aidlc-distribution.ts";
import { REPO_ROOT } from "../harness/fixtures.ts";

const PREVIOUS = join(REPO_ROOT, "tests", "fixtures", "distribution-2.10.0");
// `git rev-parse v2.10.0:core/tools/<file>` for each copied file.
const TAG_BLOBS: Record<string, string> = {
  "aidlc-distribution.ts": "5e03fdc462c968405b2b962860776e83d8e669e4",
  "aidlc-channel.ts": "fe384188bcb2cc2ddb212485d4ab9b92da0fffab",
  "aidlc-version.ts": "ce1412a7e78db170230f1f2a966a2f2c8cc39e95",
};
const RELEASE_ROOT = join(REPO_ROOT, "dist-release");
const RUNTIME_TREES = readdirSync(RELEASE_ROOT)
  .filter((name) => statSync(join(RELEASE_ROOT, name)).isDirectory())
  .sort();

function gitBlobId(path: string): string {
  const bytes = readFileSync(path);
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

describe("a 2.10.0 install accepts every runtime tree this release ships", () => {
  test("the copied validator is 2.10.0's own, byte for byte", () => {
    for (const [file, blob] of Object.entries(TAG_BLOBS)) {
      expect(gitBlobId(join(PREVIOUS, file)), file).toBe(blob);
    }
  });

  test("2.10.0's validator accepts each runtime tree", () => {
    expect(RUNTIME_TREES).toContain("copilot");
    for (const name of RUNTIME_TREES) {
      expect(() => projectionFiles2100(join(RELEASE_ROOT, name)), name).not.toThrow();
    }
  });

  test("this release reads back the policy each tree declares", () => {
    const written = JSON.parse(readFileSync(
      join(RELEASE_ROOT, "copilot", ".aidlc", "tools", "data", "aidlc-projection.json"),
      "utf-8",
    )) as { rootIntegrations: Array<Record<string, unknown>> };
    expect(written.rootIntegrations.find((item) => item.path === ".vscode/settings.json")).toMatchObject({
      policy: "whole-file",
      extendedPolicy: "jsonc-settings",
    });
    const read = projectionFiles(join(RELEASE_ROOT, "copilot")).descriptor.rootIntegrations;
    expect(read.find((item) => item.path === ".vscode/settings.json")).toEqual({
      path: ".vscode/settings.json",
      policy: "jsonc-settings",
      optional: true,
    });
  });

  test("a retained preview that wrote the new policy directly still reads", () => {
    const direct = [{ path: ".vscode/settings.json", policy: "jsonc-settings", optional: true }];
    expect(readRootIntegrations(direct)).toEqual(direct);
  });
});
