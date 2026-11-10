// covers: function:verifyReleaseProvenance
//
// A release whose provenance does not verify says which repository and signer
// workflow it was checked against. When AIDLC_RELEASE_REPOSITORY is not set it
// also says where to get the release, then how to point the check at another
// repository; when it is set, it adds nothing. A fork's release checked against the default repository fails
// with only gh's own line ("verifying with issuer \"sigstore.dev\""), which
// names neither, so the person cannot tell an installation setting from a
// tampered release.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ReleaseManifest, verifyReleaseProvenance } from "../../core/tools/aidlc-release.ts";

const VERSION = "2.11.4-preview.20261105.101";
const GH_FAILURE = 'Error: verifying with issuer "sigstore.dev"';
const ENV_KEYS = ["AIDLC_GH_BIN", "AIDLC_RELEASE_REPOSITORY", "AIDLC_RELEASE_WORKFLOW"] as const;

const created: string[] = [];
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  while (created.length > 0) rmSync(created.pop() as string, { recursive: true, force: true });
});

// A release directory with a bundle, and a gh that supports every flag the
// check needs but refuses the attestation the way gh does for the wrong repo.
function refusingRelease(): { directory: string; manifest: ReleaseManifest } {
  const directory = mkdtempSync(join(tmpdir(), "aidlc-provenance-repo-"));
  created.push(directory);
  writeFileSync(join(directory, "aidlc-release.intoto.jsonl"), "fixture bundle\n");
  writeFileSync(join(directory, "checksums.txt"), "fixture checksums\n");
  const gh = join(directory, "gh");
  writeFileSync(
    gh,
    [
      "#!/bin/sh",
      'if [ "$1" = attestation ] && [ "$2" = verify ] && [ "$3" = --help ]; then',
      "  printf '%s\\n' '--signer-workflow --source-ref --source-digest'",
      "  exit 0",
      "fi",
      `printf '%s\\n' '${GH_FAILURE}' >&2`,
      "exit 1",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  process.env.AIDLC_GH_BIN = gh;
  delete process.env.AIDLC_RELEASE_WORKFLOW;
  return {
    directory,
    manifest: {
      schemaVersion: 1,
      version: VERSION,
      date: "2026-11-05",
      sourceRef: "refs/heads/main",
      distributions: [],
      assets: [],
    },
  };
}

function failure(directory: string, manifest: ReleaseManifest): string {
  try {
    verifyReleaseProvenance(directory, manifest);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("provenance verification passed");
}

// The fake gh is a POSIX shell script; the message itself is the same on Windows.
describe.skipIf(process.platform === "win32")("a provenance failure names what it checked against", () => {
  test("the default repository, its workflow, and the setting that changes it", () => {
    const { directory, manifest } = refusingRelease();
    delete process.env.AIDLC_RELEASE_REPOSITORY;
    const message = failure(directory, manifest);
    expect(message).toContain(GH_FAILURE);
    expect(message).toContain("awslabs/aidlc-workflows");
    expect(message).toContain("awslabs/aidlc-workflows/.github/workflows/preview-release.yml");
    expect(message).toContain("Get the release from awslabs/aidlc-workflows");
    expect(message).toContain("AIDLC_RELEASE_REPOSITORY=<owner>/<name>");
  });

  test("the repository AIDLC_RELEASE_REPOSITORY names", () => {
    const { directory, manifest } = refusingRelease();
    process.env.AIDLC_RELEASE_REPOSITORY = "alice/aidlc-workflows";
    const message = failure(directory, manifest);
    expect(message).toContain("alice/aidlc-workflows/.github/workflows/preview-release.yml");
    expect(message).not.toContain("awslabs/");
    expect(message).not.toContain("AIDLC_RELEASE_REPOSITORY");
  });
});
