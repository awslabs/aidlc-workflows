#!/usr/bin/env bun
import { existsSync, readFileSync } from "node:fs";

const args = process.argv.slice(2);
if (args[0] !== "attestation" || args[1] !== "verify" || !args[2]) {
  process.exit(2);
}
function valueAfter(flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

const bundle = valueAfter("--bundle");
const sourceRef = valueAfter("--source-ref");
const repository = valueAfter("--repo");
const signerWorkflow = valueAfter("--signer-workflow");
const expectedRepository =
  process.env.AIDLC_RELEASE_REPOSITORY?.trim() || "awslabs/aidlc-workflows";
const expectedWorkflow =
  process.env.AIDLC_RELEASE_WORKFLOW?.trim() ||
  `${expectedRepository}/.github/workflows/release.yml`;
if (
  !existsSync(args[2]) ||
  !bundle ||
  !existsSync(bundle) ||
  readFileSync(bundle, "utf-8").trim() !== "aidlc-test-release-provenance" ||
  repository !== expectedRepository ||
  signerWorkflow !== expectedWorkflow ||
  !sourceRef?.startsWith("refs/tags/v")
) {
  process.exit(1);
}
