// covers: subcommand:aidlc-unit:land
//
// Land commits main's engine metadata before it merges the Unit. When that
// commit failed, the refusal carried only git's stderr, but git commit says
// some refusals on stdout ("nothing to commit"), so the person got
// "Failed to checkpoint main engine metadata: ." with no reason. The refusal
// now carries what git said, wherever it said it.

import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import {
  UNIT,
  approveMerge,
  cleanupTempDirs,
  makeSeed,
  prepareCandidate,
  runMergeTool,
  tempDirs,
} from "../harness/team-unit-merge.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);
afterEach(cleanupTempDirs);

describe("t-team-unit-land-commit-refusal: land says why git refused its commit", () => {
  // The fake git is a #!/bin/sh script, which Windows cannot run.
  test.skipIf(process.platform === "win32")("a commit git refuses on stdout is explained in land's refusal", () => {
    const { seed, remote } = makeSeed();
    prepareCandidate(remote, "alpha", "alpha-team");
    approveMerge(seed, "alpha");
    // A git that refuses every commit the way git itself reports an empty one:
    // on stdout, with nothing on stderr.
    const realGit = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf-8" }).stdout.trim();
    const bin = mkdtempSync(join(tmpdir(), "aidlc-git-refuses-commit-"));
    tempDirs.push(bin);
    writeFileSync(
      join(bin, "git"),
      `#!/bin/sh\nfor arg in "$@"; do\n  if [ "$arg" = commit ]; then echo "nothing to commit, working tree clean"; exit 1; fi\ndone\nexec "${realGit}" "$@"\n`,
    );
    chmodSync(join(bin, "git"), 0o755);
    const landed = runMergeTool(UNIT, ["land", "alpha"], seed, false, {
      PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
    });
    expect(landed.status).not.toBe(0);
    expect(landed.out).toContain("nothing to commit, working tree clean");
  });
});
