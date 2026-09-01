#!/usr/bin/env bun
import {
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { verifyReleaseDirectory } from "../core/tools/aidlc-release.ts";

const RELEASE_DISTRIBUTIONS = [
  "claude",
  "codex",
  "copilot",
  "cursor",
  "kiro",
  "kiro-ide",
  "opencode",
] as const;

const RELEASE_ASSETS = new Map<string, {
  kind: "binary" | "runtime" | "installer";
  target?: string;
}>([
  ["aidlc-darwin-arm64", { kind: "binary", target: "darwin-arm64" }],
  ["aidlc-darwin-x64", { kind: "binary", target: "darwin-x64" }],
  ["aidlc-linux-arm64", { kind: "binary", target: "linux-arm64" }],
  ["aidlc-linux-arm64-musl", { kind: "binary", target: "linux-arm64-musl" }],
  ["aidlc-linux-x64", { kind: "binary", target: "linux-x64" }],
  ["aidlc-linux-x64-musl", { kind: "binary", target: "linux-x64-musl" }],
  ["aidlc-runtime.tar.gz", { kind: "runtime" }],
  ["aidlc-windows-x64.exe", { kind: "binary", target: "windows-x64" }],
  ["install.ps1", { kind: "installer" }],
  ["install.sh", { kind: "installer" }],
]);

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

function ruleTypes(ruleset: JsonRecord): string[] {
  const rules = ruleset.rules;
  if (!Array.isArray(rules)) return [];
  return rules
    .map((rule) => record(rule, "ruleset rule").type)
    .filter((type): type is string => typeof type === "string")
    .sort();
}

function exactReleaseTagScope(ruleset: JsonRecord): boolean {
  const conditions = ruleset.conditions;
  if (!conditions || typeof conditions !== "object" || Array.isArray(conditions)) return false;
  const refName = (conditions as JsonRecord).ref_name;
  if (!refName || typeof refName !== "object" || Array.isArray(refName)) return false;
  const refs = refName as JsonRecord;
  return sameStrings(refs.include, ["refs/tags/v*"]) && sameStrings(refs.exclude, []);
}

function releaseTagScopeMayApply(ruleset: JsonRecord): boolean {
  const conditions = ruleset.conditions;
  if (!conditions || typeof conditions !== "object" || Array.isArray(conditions)) return true;
  const refName = (conditions as JsonRecord).ref_name;
  if (!refName || typeof refName !== "object" || Array.isArray(refName)) return true;
  const refs = refName as JsonRecord;
  if (!Array.isArray(refs.include) || !Array.isArray(refs.exclude)) return true;
  const include = refs.include.filter((value): value is string => typeof value === "string");
  const exclude = refs.exclude.filter((value): value is string => typeof value === "string");
  const excludesAll = exclude.some((pattern) =>
    pattern === "~ALL" ||
    pattern === "refs/tags/*" ||
    pattern === "refs/tags/**" ||
    pattern === "refs/tags/v*"
  );
  if (excludesAll) return false;
  return include.some((pattern) => {
    if (
      pattern === "~ALL" ||
      pattern === "refs/tags/*" ||
      pattern === "refs/tags/**"
    ) {
      return true;
    }
    const wildcard = pattern.search(/[*?[]/);
    const prefix = wildcard === -1 ? pattern : pattern.slice(0, wildcard);
    return prefix.startsWith("refs/tags/v") ||
      "refs/tags/v".startsWith(prefix);
  });
}

function readRulesets(directory: string): JsonRecord[] {
  const root = resolve(directory);
  const files = readdirSync(root)
    .filter((name) => name.endsWith(".json"))
    .sort();
  if (files.length === 0) throw new Error("repository policy failure: no rulesets returned");
  return files.map((name) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(join(root, name), "utf-8"));
    } catch (error) {
      throw new Error(
        `authorization identity failure: unreadable ruleset response ${name}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    return record(parsed, `ruleset response ${name}`);
  });
}

function verifyControls(args: string[]): void {
  const rulesets = readRulesets(requiredOption(args, "--rulesets"));
  const creationActorId = requiredOption(args, "--creation-actor-id");
  const creationActorType = requiredOption(args, "--creation-actor-type");
  if (creationActorType !== "Integration") {
    throw new Error(`unsupported release creation actor type: ${creationActorType}`);
  }

  const relevant = rulesets.filter((ruleset) => {
    const types = ruleTypes(ruleset);
    return ruleset.enforcement === "active" &&
      ruleset.target === "tag" &&
      releaseTagScopeMayApply(ruleset) &&
      types.some((type) =>
        type === "creation" || type === "update" || type === "deletion"
      );
  });
  const hiddenActors = relevant.find((ruleset) =>
    !Object.hasOwn(ruleset, "bypass_actors") ||
    !Array.isArray(ruleset.bypass_actors)
  );
  if (hiddenActors) {
    throw new Error(
      `authorization identity failure: ruleset ${
        String(hiddenActors.name ?? hiddenActors.id ?? "<unknown>")
      } omitted or hid bypass_actors`,
    );
  }

  const creation = rulesets.filter((ruleset) => {
    if (
      ruleset.enforcement !== "active" ||
      ruleset.target !== "tag" ||
      !exactReleaseTagScope(ruleset) ||
      !sameStrings(ruleTypes(ruleset), ["creation"])
    ) {
      return false;
    }
    if (!Array.isArray(ruleset.bypass_actors)) return false;
    const actors = ruleset.bypass_actors;
    if (actors.length !== 1) return false;
    const actor = record(actors[0], "creation bypass actor");
    return String(actor.actor_id) === creationActorId &&
      actor.actor_type === creationActorType &&
      actor.bypass_mode === "always";
  });

  const immutability = rulesets.filter((ruleset) =>
    ruleset.enforcement === "active" &&
    ruleset.target === "tag" &&
    exactReleaseTagScope(ruleset) &&
    sameStrings(ruleTypes(ruleset), ["deletion", "update"]) &&
    Array.isArray(ruleset.bypass_actors) &&
    ruleset.bypass_actors.length === 0
  );

  if (creation.length !== 1) {
    throw new Error(
      `repository policy failure: expected exactly one active v* creation ruleset ` +
        `with the protected release App always-bypass, found ${creation.length}`,
    );
  }
  if (immutability.length !== 1) {
    throw new Error(
      `repository policy failure: expected exactly one active no-bypass v* ` +
        `update+deletion ruleset, found ${immutability.length}`,
    );
  }
  if (relevant.length !== 2) {
    throw new Error(
      `repository policy failure: expected exactly the two documented active ` +
        `rulesets applicable to v* creation/update/deletion, found ${relevant.length}`,
    );
  }
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
  if (rawManifest.sourceRef !== "refs/heads/main") {
    throw new Error("version.json sourceRef must be refs/heads/main");
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
    const expected = RELEASE_ASSETS.get(name);
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

  const expectedAssetNames = [...RELEASE_ASSETS.keys()].sort();
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
    const expected = RELEASE_ASSETS.get(asset.name);
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
  if (command === "controls") {
    verifyControls(args);
    return;
  }
  if (command === "candidate") {
    verifyCandidate(args);
    return;
  }
  throw new Error(
    "usage: verify-release.ts controls --rulesets <dir> --creation-actor-id <id> " +
      "--creation-actor-type <Integration> | candidate --directory <dir> --tag <vX.Y.Z> " +
      "[--source-digest <sha>] [--list-assets]",
  );
}

try {
  main();
} catch (error) {
  console.error(`verify-release: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
