#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createTarGz, type ArchiveEntry } from "../core/tools/aidlc-archive.ts";
import { projectionFiles, walkFiles } from "../core/tools/aidlc-distribution.ts";
import { targetTriple } from "../core/tools/aidlc-install-paths.ts";
import { digest, type ReleaseAsset, type ReleaseManifest } from "../core/tools/aidlc-release.ts";
import { AIDLC_VERSION } from "../core/tools/aidlc-version.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RELEASE_SOURCE_REF = "refs/heads/main";

function valueAfter(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

function entriesFor(root: string): ArchiveEntry[] {
  return walkFiles(root).map((path) => ({
    path: path.replaceAll("\\", "/"),
    type: "file",
    mode: statSync(join(root, path)).mode & 0o777,
    data: readFileSync(join(root, path)),
  }));
}

function outputName(target: string, source: string): string {
  const normalized = target === "native" ? targetTriple() : target;
  return `aidlc-${normalized}${source.endsWith(".exe") ? ".exe" : ""}`;
}

function directoryNames(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((name) => statSync(join(root, name)).isDirectory())
    .sort();
}

function sameNames(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length &&
    actual.every((name, index) => name === expected[index]);
}

function sourceHarnesses(): string[] {
  return directoryNames(join(REPO_ROOT, "harness"))
    .filter((name) => existsSync(join(REPO_ROOT, "harness", name, "manifest.ts")));
}

function sourcePlugins(): string[] {
  return directoryNames(join(REPO_ROOT, "plugins"))
    .filter((name) =>
      existsSync(join(REPO_ROOT, "plugins", name, ".aidlc-plugin", "plugin.json"))
    );
}

function verifyGeneratedInventory(): {
  harnesses: string[];
  plugins: string[];
} {
  const harnesses = sourceHarnesses();
  const releaseHarnesses = directoryNames(join(REPO_ROOT, "dist-release"));
  if (!sameNames(releaseHarnesses, harnesses)) {
    throw new Error(
      `generated release harness inventory differs from source: expected ` +
        `${harnesses.join(", ") || "none"}, found ${releaseHarnesses.join(", ") || "none"}`,
    );
  }

  const plugins = sourcePlugins();
  const pluginsRoot = join(REPO_ROOT, "dist", "plugins");
  const generatedPlugins = directoryNames(pluginsRoot);
  if (!sameNames(generatedPlugins, plugins)) {
    throw new Error(
      `generated plugin inventory differs from source: expected ` +
        `${plugins.join(", ") || "none"}, found ${generatedPlugins.join(", ") || "none"}`,
    );
  }
  for (const plugin of plugins) {
    const pluginHarnesses = directoryNames(join(pluginsRoot, plugin));
    if (!sameNames(pluginHarnesses, harnesses)) {
      throw new Error(
        `generated plugin ${plugin} harness inventory differs from source: expected ` +
          `${harnesses.join(", ")}, found ${pluginHarnesses.join(", ") || "none"}`,
      );
    }
  }
  return { harnesses, plugins };
}

function releaseSourceDigest(): string {
  const configured = process.env.AIDLC_RELEASE_SOURCE_DIGEST?.trim();
  if (configured) {
    if (!/^[a-f0-9]{40}$/.test(configured)) {
      throw new Error("AIDLC_RELEASE_SOURCE_DIGEST must be a lowercase 40-hex commit");
    }
    return configured;
  }
  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: REPO_ROOT,
    encoding: "utf-8",
  });
  const digest = result.stdout.trim();
  if (result.status !== 0 || !/^[a-f0-9]{40}$/.test(digest)) {
    throw new Error("could not resolve the release source commit");
  }
  return digest;
}

type BinaryInput = {
  directoryName: string;
  target: string;
  source: string;
  bytes: number;
  sha256: string;
};

function binaryInputs(binaries: string): BinaryInput[] {
  const byTarget = new Map<string, BinaryInput>();
  for (const directoryName of readdirSync(binaries).sort()) {
    if (directoryName.startsWith("build-results")) continue;
    const directory = join(binaries, directoryName);
    if (!statSync(directory).isDirectory()) continue;
    const candidates = ["aidlc", "aidlc.exe"]
      .map((name) => join(directory, name))
      .filter(existsSync);
    if (candidates.length !== 1) {
      throw new Error(`${directory}: expected one aidlc binary`);
    }
    const source = candidates[0];
    const input: BinaryInput = {
      directoryName,
      target: directoryName === "native" ? targetTriple() : directoryName,
      source,
      bytes: statSync(source).size,
      sha256: digest(source),
    };
    const existing = byTarget.get(input.target);
    if (!existing) {
      byTarget.set(input.target, input);
      continue;
    }
    if (existing.bytes !== input.bytes || existing.sha256 !== input.sha256) {
      throw new Error(
        `duplicate binary target ${input.target} differs between ` +
          `${existing.directoryName}/ and ${input.directoryName}/`,
      );
    }
    if (existing.directoryName === "native" && input.directoryName !== "native") {
      byTarget.set(input.target, input);
    }
  }
  return [...byTarget.values()].sort((a, b) => a.target.localeCompare(b.target));
}

function buildVerification(
  binaries: string,
  target: string,
  bytes: number,
  required: boolean,
): ReleaseAsset["verification"] {
  const path = join(binaries, `build-results-${target}.json`);
  if (!existsSync(path)) {
    if (required) throw new Error(`missing build verification record for ${target}`);
    return undefined;
  }
  let document: {
    failures?: unknown;
    results?: Array<{
      name?: unknown;
      bytes?: unknown;
      verification?: {
        status?: unknown;
        mode?: unknown;
        hostTarget?: unknown;
      };
    }>;
  };
  try {
    document = JSON.parse(readFileSync(path, "utf-8")) as typeof document;
  } catch (error) {
    throw new Error(
      `${path}: invalid build verification JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (
    !Array.isArray(document.failures) ||
    document.failures.length > 0 ||
    !Array.isArray(document.results) ||
    document.results.length !== 1
  ) {
    throw new Error(`${path}: build verification record contains failures or ambiguous results`);
  }
  const result = document.results[0];
  const verification = result.verification;
  if (
    result.name !== target ||
    result.bytes !== bytes ||
    !verification ||
    (verification.status !== "VERIFIED" && verification.status !== "UNVERIFIED") ||
    (verification.mode !== "full-runtime" && verification.mode !== "inspection-only") ||
    typeof verification.hostTarget !== "string" ||
    !/^[a-z0-9][a-z0-9-]*$/.test(verification.hostTarget)
  ) {
    throw new Error(`${path}: build verification record does not match ${target}`);
  }
  return {
    status: verification.status,
    mode: verification.mode,
    hostTarget: verification.hostTarget,
  };
}

function build(argv: string[]): void {
  const output = valueAfter(argv, "--output") || join(REPO_ROOT, "build", "release");
  const binaries = valueAfter(argv, "--binaries") || join(REPO_ROOT, "build", "binaries");
  const requireReleaseMatrix = argv.includes("--require-release-matrix");
  const regenerate = spawnSync("bun", [join(REPO_ROOT, "scripts", "package.ts")], {
    cwd: REPO_ROOT,
    encoding: "utf-8",
  });
  if (regenerate.status !== 0) {
    throw new Error(`package regeneration failed\n${regenerate.stderr}`);
  }
  const check = spawnSync("bun", [join(REPO_ROOT, "scripts", "package.ts"), "--check"], {
    cwd: REPO_ROOT,
    encoding: "utf-8",
  });
  if (check.status !== 0) {
    throw new Error(`package determinism guard failed\n${check.stderr}`);
  }
  const generated = verifyGeneratedInventory();
  rmSync(output, { recursive: true, force: true });
  mkdirSync(output, { recursive: true });
  const assets: ReleaseAsset[] = [];
  const distributions: ReleaseManifest["distributions"] = [];

  const runtimeEntries: ArchiveEntry[] = [];
  for (const distribution of generated.harnesses) {
    const root = join(REPO_ROOT, "dist-release", distribution);
    const projection = projectionFiles(root);
    distributions.push({
      name: projection.stamp.distribution,
      productName: projection.descriptor.productName,
    });
    runtimeEntries.push(...entriesFor(root).map((entry) => ({
      ...entry,
      path: `runtime/${distribution}/${entry.path}`,
    })));
  }
  const pluginsRoot = join(REPO_ROOT, "dist", "plugins");
  if (existsSync(pluginsRoot)) {
    for (const plugin of generated.plugins) {
      const pluginRoot = join(pluginsRoot, plugin);
      if (!statSync(pluginRoot).isDirectory()) continue;
      for (const harness of readdirSync(pluginRoot).sort()) {
        const harnessRoot = join(pluginRoot, harness);
        if (!statSync(harnessRoot).isDirectory()) continue;
        runtimeEntries.push(...entriesFor(harnessRoot).map((entry) => ({
          ...entry,
          path: `plugins/${plugin}/${harness}/${entry.path}`,
        })));
      }
    }
  }
  const runtimeName = "aidlc-runtime.tar.gz";
  const runtimePath = join(output, runtimeName);
  writeFileSync(runtimePath, createTarGz(runtimeEntries));
  assets.push({
    name: runtimeName,
    sha256: digest(runtimePath),
    bytes: statSync(runtimePath).size,
    kind: "runtime",
  });

  for (const input of binaryInputs(binaries)) {
    const verification = buildVerification(
      binaries,
      input.directoryName,
      input.bytes,
      requireReleaseMatrix,
    );
    const name = outputName(input.target, input.source);
    const path = join(output, name);
    copyFileSync(input.source, path);
    chmodSync(path, 0o755);
    assets.push({
      name,
      sha256: input.sha256,
      bytes: input.bytes,
      kind: "binary",
      target: input.target,
      ...(verification ? { verification } : {}),
    });
  }
  if (requireReleaseMatrix) {
    const expected = [
      "darwin-arm64",
      "darwin-x64",
      "linux-arm64",
      "linux-arm64-musl",
      "linux-x64",
      "linux-x64-musl",
      "windows-x64",
    ];
    const actual = new Set(
      assets.filter((asset) => asset.kind === "binary").map((asset) => asset.target),
    );
    const missing = expected.filter((target) => !actual.has(target));
    if (missing.length > 0) {
      throw new Error(`release binary matrix is incomplete: ${missing.join(", ")}`);
    }
    if (
      assets.some((asset) => asset.kind === "binary" && asset.verification === undefined)
    ) {
      throw new Error("release binary matrix is missing verification labels");
    }
  }

  const installer = join(output, "install.sh");
  copyFileSync(join(REPO_ROOT, "scripts", "install.sh"), installer);
  chmodSync(installer, 0o755);
  assets.push({
    name: "install.sh",
    sha256: digest(installer),
    bytes: statSync(installer).size,
    kind: "installer",
  });

  const powershellInstaller = join(output, "install.ps1");
  copyFileSync(join(REPO_ROOT, "scripts", "install.ps1"), powershellInstaller);
  assets.push({
    name: "install.ps1",
    sha256: digest(powershellInstaller),
    bytes: statSync(powershellInstaller).size,
    kind: "installer",
  });

  assets.sort((a, b) => a.name.localeCompare(b.name));
  const changelog = readFileSync(join(REPO_ROOT, "CHANGELOG.md"), "utf-8");
  const releaseDate = new RegExp(
    `^## \\[${AIDLC_VERSION.replaceAll(".", "\\.")}\\] - (\\d{4}-\\d{2}-\\d{2})$`,
    "m",
  ).exec(changelog)?.[1];
  if (!releaseDate) throw new Error(`CHANGELOG.md has no dated ${AIDLC_VERSION} release heading`);
  const date = process.env.SOURCE_DATE_EPOCH
    ? new Date(Number(process.env.SOURCE_DATE_EPOCH) * 1000).toISOString().slice(0, 10)
    : releaseDate;
  const manifest: ReleaseManifest = {
    schemaVersion: 1,
    version: AIDLC_VERSION,
    date,
    sourceRef: RELEASE_SOURCE_REF,
    sourceDigest: releaseSourceDigest(),
    distributions,
    assets,
  };
  writeFileSync(join(output, "version.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(
    join(output, "checksums.txt"),
    `${
      [
        `${digest(join(output, "version.json"))}  version.json`,
        ...assets.map((asset) => `${asset.sha256}  ${asset.name}`),
      ].join("\n")
    }\n`,
  );
  console.log(`packaged ${assets.length} release assets in ${relative(REPO_ROOT, output)}`);
}

try {
  build(process.argv.slice(2));
} catch (error) {
  console.error(`package-release: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
