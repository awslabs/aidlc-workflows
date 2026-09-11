#!/usr/bin/env bun
import {
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import {
  releaseRuntimeAsset,
  verifyReleaseDirectory,
} from "../core/tools/aidlc-release.ts";

const RELEASE_DISTRIBUTIONS = [
  "claude",
  "codex",
  "copilot",
  "cursor",
  "kiro",
  "kiro-ide",
  "opencode",
] as const;

function releaseAssets(version: string): Map<string, {
  kind: "binary" | "runtime" | "installer";
  target?: string;
}> {
  return new Map([
    ["aidlc-darwin-arm64", { kind: "binary", target: "darwin-arm64" }],
    ["aidlc-darwin-x64", { kind: "binary", target: "darwin-x64" }],
    ["aidlc-linux-arm64", { kind: "binary", target: "linux-arm64" }],
    ["aidlc-linux-arm64-musl", { kind: "binary", target: "linux-arm64-musl" }],
    ["aidlc-linux-x64", { kind: "binary", target: "linux-x64" }],
    ["aidlc-linux-x64-musl", { kind: "binary", target: "linux-x64-musl" }],
    [releaseRuntimeAsset(version), { kind: "runtime" }],
    ["aidlc-windows-x64.exe", { kind: "binary", target: "windows-x64" }],
    ["install.ps1", { kind: "installer" }],
    ["install.sh", { kind: "installer" }],
  ]);
}

type JsonRecord = Record<string, unknown>;

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as JsonRecord;
}

function exactKeys(value: JsonRecord, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} has unexpected fields: ${actual.join(", ")}`);
  }
}

function option(args: string[], name: string): string | undefined {
  const matches = args
    .map((value, index) => value === name ? args[index + 1] : undefined)
    .filter((value): value is string => value !== undefined);
  if (matches.length > 1) throw new Error(`duplicate ${name}`);
  return matches[0];
}

function requiredOption(args: string[], name: string): string {
  const value = option(args, name);
  if (!value || value.startsWith("--")) throw new Error(`missing ${name}`);
  return value;
}

function sameStrings(actual: unknown, expected: readonly string[]): boolean {
  return Array.isArray(actual) &&
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index]);
}

function verifyCandidate(args: string[]): void {
  const directory = resolve(requiredOption(args, "--directory"));
  const tag = requiredOption(args, "--tag");
  const manifestPath = join(directory, "version.json");
  let document: unknown;
  try {
    document = JSON.parse(readFileSync(manifestPath, "utf-8"));
  } catch (error) {
    throw new Error(
      `invalid version.json: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const rawManifest = record(document, "version.json");
  exactKeys(
    rawManifest,
    [
      "schemaVersion",
      "version",
      "date",
      "sourceRef",
      "sourceDigest",
      "distributions",
      "assets",
    ],
    "version.json",
  );
  if (typeof rawManifest.version !== "string") {
    throw new Error("version.json version must be strict semver");
  }
  const expectedAssets = releaseAssets(rawManifest.version);
  if (rawManifest.sourceRef !== `refs/tags/v${rawManifest.version}`) {
    throw new Error("version.json sourceRef must match its version tag");
  }
  if (
    typeof rawManifest.sourceDigest !== "string" ||
    !/^[a-f0-9]{40}$/.test(rawManifest.sourceDigest)
  ) {
    throw new Error("version.json sourceDigest must be a lowercase 40-hex commit");
  }
  const expectedSourceDigest = option(args, "--source-digest");
  if (
    expectedSourceDigest !== undefined &&
    rawManifest.sourceDigest !== expectedSourceDigest
  ) {
    throw new Error(
      `version.json sourceDigest ${String(rawManifest.sourceDigest)} does not match ` +
        `authorized source ${expectedSourceDigest}`,
    );
  }
  if (!Array.isArray(rawManifest.distributions)) {
    throw new Error("version.json distributions must be an array");
  }
  for (const [index, value] of rawManifest.distributions.entries()) {
    exactKeys(
      record(value, `version.json distribution ${index}`),
      ["name", "productName"],
      `version.json distribution ${index}`,
    );
  }
  if (!Array.isArray(rawManifest.assets)) {
    throw new Error("version.json assets must be an array");
  }
  for (const [index, value] of rawManifest.assets.entries()) {
    const asset = record(value, `version.json asset ${index}`);
    const name = typeof asset.name === "string" ? asset.name : "";
    const expected = expectedAssets.get(name);
    exactKeys(
      asset,
      expected?.kind === "binary"
        ? ["name", "sha256", "bytes", "kind", "target", "verification"]
        : ["name", "sha256", "bytes", "kind"],
      `version.json asset ${index}`,
    );
    if (expected?.kind === "binary") {
      exactKeys(
        record(asset.verification, `${name} verification`),
        ["status", "mode", "hostTarget"],
        `${name} verification`,
      );
    }
  }

  const expectedAssetNames = [...expectedAssets.keys()].sort();
  const manifest = verifyReleaseDirectory(directory, expectedAssetNames);
  if (tag !== `v${manifest.version}`) {
    throw new Error(`release tag ${tag} does not match version.json ${manifest.version}`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(manifest.date)) {
    throw new Error("version.json has an invalid date");
  }
  const distributionNames = manifest.distributions
    .map((distribution) => distribution.name)
    .sort();
  if (!sameStrings(distributionNames, RELEASE_DISTRIBUTIONS)) {
    throw new Error("version.json has an invalid distribution inventory");
  }
  const assetNames = manifest.assets.map((asset) => asset.name);
  if (!sameStrings([...assetNames].sort(), expectedAssetNames)) {
    throw new Error("version.json has an invalid asset inventory");
  }
  for (const asset of manifest.assets) {
    const expected = expectedAssets.get(asset.name);
    if (
      !expected ||
      asset.kind !== expected.kind ||
      asset.target !== expected.target ||
      (asset.kind === "binary" && asset.verification === undefined)
    ) {
      throw new Error(`${asset.name}: invalid release matrix metadata`);
    }
  }

  const bundleName = "aidlc-release.intoto.jsonl";
  const expectedFiles = new Set([
    ...assetNames,
    "checksums.txt",
    "version.json",
    bundleName,
  ]);
  const entries = readdirSync(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !expectedFiles.has(entry.name)) {
      throw new Error(`release directory contains unexpected entry ${entry.name}`);
    }
  }
  if (entries.length !== expectedFiles.size) {
    const actual = new Set(entries.map((entry) => entry.name));
    const missing = [...expectedFiles].filter((name) => !actual.has(name));
    throw new Error(`release directory is missing ${missing.join(", ")}`);
  }
  const bundle = join(directory, bundleName);
  if (basename(bundle) !== bundleName || statSync(bundle).size > 1024 * 1024) {
    throw new Error(`${bundleName} exceeds the 1 MiB metadata limit`);
  }

  if (args.includes("--list-assets")) {
    process.stdout.write(`${assetNames.join("\n")}\n`);
  }
}

function main(): void {
  const [command, ...args] = process.argv.slice(2);
  if (command === "candidate") {
    verifyCandidate(args);
    return;
  }
  throw new Error(
    "usage: verify-release.ts candidate --directory <dir> --tag <vX.Y.Z> " +
      "[--source-digest <sha>] [--list-assets]",
  );
}

try {
  main();
} catch (error) {
  console.error(`verify-release: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
