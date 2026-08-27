// covers: file:aidlc-common/stages/inception/reverse-engineering.md, file:knowledge/aidlc-developer-agent/re-artifacts.md, function:codekbSourceFingerprint, function:codekbStoreGeneration, subcommand:aidlc-utility:codekb-snapshot, subcommand:aidlc-utility:codekb-publish
//
// t304 - Focused Reverse Engineering rescans merge into the shared CodeKB
// without stale-source publication or concurrent lost updates.

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import {
  cleanupTestProject,
  createTestProject,
  DEFAULT_SPACE,
  REPO_ROOT,
  resetAidlcEnv,
} from "../harness/fixtures.ts";
import {
  codekbScopeFingerprint,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";

const BUN = process.execPath;
const UTILITY = join(
  REPO_ROOT,
  "dist",
  "claude",
  ".claude",
  "tools",
  "aidlc-utility.ts",
);
const ARTIFACT_NAMES = [
  "api-documentation.md",
  "architecture.md",
  "business-overview.md",
  "code-quality-assessment.md",
  "code-structure.md",
  "component-inventory.md",
  "dependencies.md",
  "reverse-engineering-timestamp.md",
  "technology-stack.md",
];

resetAidlcEnv();

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) cleanupTestProject(dir);
});

function freshProject(): string {
  const project = createTestProject();
  tempDirs.push(project);
  const result = spawnSync("git", ["init", "-q", project], { encoding: "utf-8" });
  expect(result.status).toBe(0);
  return project;
}

function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.AWS_AIDLC_DEFAULT_SCOPE;
  return env;
}

function storeDir(project: string): string {
  return join(
    project,
    "aidlc",
    "spaces",
    DEFAULT_SPACE,
    "codekb",
    basename(project),
  );
}

function timestampBody(
  intent: string,
  paths: string[],
  components: string[],
  fingerprint: string,
): string {
  return [
    "# Reverse Engineering Timestamp",
    "",
    "## Scope of Analysis",
    "",
    "```yaml",
    "scope_version: 1",
    `kind: ${paths.includes("./") ? "full" : "partial"}`,
    `intent: ${intent}`,
    `fingerprint: ${fingerprint}`,
    "analyzed:",
    "  paths:",
    ...paths.map((path) => `    - ${path}`),
    "  components:",
    ...components.map((component) => `    - ${component}`),
    "shallow:",
    "  paths:",
    "```",
    "",
  ].join("\n");
}

function writeCandidate(
  dir: string,
  marker: string,
  intent: string,
  paths: string[],
  components: string[],
  fingerprint: string,
): void {
  mkdirSync(dir, { recursive: true });
  for (const name of ARTIFACT_NAMES) {
    writeFileSync(
      join(dir, name),
      name === "reverse-engineering-timestamp.md"
        ? timestampBody(intent, paths, components, fingerprint)
        : `# ${name}\n\n${marker}\n`,
      "utf-8",
    );
  }
}

function runUtility(project: string, args: string[]) {
  return spawnSync(
    BUN,
    [UTILITY, ...args, "--project-dir", project],
    { encoding: "utf-8", env: childEnv() },
  );
}

function snapshot(project: string, paths: string[]): {
  store_generation: string;
  source_fingerprint: string;
  paths: string[];
} {
  const result = runUtility(project, [
    "codekb-snapshot",
    "--paths",
    paths.join(","),
    "--json",
  ]);
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
}

function publish(
  project: string,
  candidate: string,
  paths: string[],
  baseline: { store_generation: string; source_fingerprint: string },
) {
  return runUtility(project, [
    "codekb-publish",
    "--staged",
    candidate,
    "--paths",
    paths.join(","),
    "--expect-store",
    baseline.store_generation,
    "--expect-source",
    baseline.source_fingerprint,
    "--json",
  ]);
}

function currentFingerprint(project: string, paths: string[]): string {
  const fingerprint = codekbScopeFingerprint(project, paths);
  expect(fingerprint).not.toBeNull();
  return fingerprint as string;
}

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

describe("t304 cumulative CodeKB stage contract", () => {
  test("focused merges preserve prose and publish only through the CAS utility", () => {
    expect(STAGE).toContain(
      "a focused scan MERGES into the existing store so knowledge",
    );
    expect(STAGE).toContain("preserve prior sections outside it");
    expect(STAGE).toContain("codekb-snapshot");
    expect(STAGE).toContain("codekb-publish");
    expect(STAGE).toContain("No other step may write those nine shared files");
  });

  test("artifact guidance carries matching merge and transaction rules", () => {
    expect(ARTIFACTS).toContain(
      "merge `analyzed.paths` and `analyzed.components` as the union",
    );
    expect(ARTIFACTS).toContain(
      "demote the store's prior analyzed paths into `shallow.paths`",
    );
    expect(ARTIFACTS).toContain("Never write a cumulative merge directly");
    expect(ARTIFACTS).toContain("Publish only through `codekb-publish`");
  });
});

describe("t304 source and store generation interleavings", () => {
  test("a snapshot recovers an interrupted directory swap before reading generations", () => {
    const project = freshProject();
    const source = join(project, "src", "payments");
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, "index.ts"), "export const payments = 1;\n");
    const paths = ["src/payments/"];
    writeCandidate(
      storeDir(project),
      "ORIGINAL",
      "payments",
      paths,
      ["payments"],
      currentFingerprint(project, paths),
    );

    const transaction = join(
      project,
      "aidlc",
      "spaces",
      DEFAULT_SPACE,
      "intents",
      ".aidlc-codekb-transactions",
      basename(project),
      "crashed",
    );
    mkdirSync(transaction, { recursive: true });
    renameSync(storeDir(project), join(transaction, "backup"));
    writeCandidate(
      join(transaction, "next"),
      "UNPUBLISHED",
      "candidate",
      paths,
      ["payments"],
      currentFingerprint(project, paths),
    );

    const recovered = snapshot(project, paths);
    expect(recovered.store_generation).not.toBe("none");
    expect(existsSync(transaction)).toBe(false);
    expect(
      readFileSync(join(storeDir(project), "architecture.md"), "utf-8"),
    ).toContain("ORIGINAL");
  });

  test("source mutation after the snapshot refuses stale prose with a newly minted fingerprint", () => {
    const project = freshProject();
    const payments = join(project, "src", "payments");
    const catalog = join(project, "src", "catalog");
    mkdirSync(payments, { recursive: true });
    mkdirSync(catalog, { recursive: true });
    const paymentFile = join(payments, "gateway.ts");
    writeFileSync(paymentFile, "export const payment = 1;\n");
    writeFileSync(join(catalog, "index.ts"), "export const catalog = 1;\n");

    const paymentPaths = ["src/payments/"];
    writeCandidate(
      storeDir(project),
      "PAYMENTS OLD",
      "payments",
      paymentPaths,
      ["payments"],
      currentFingerprint(project, paymentPaths),
    );

    const sourcePaths = ["src/payments/", "src/catalog/"];
    const baseline = snapshot(project, sourcePaths);
    writeFileSync(paymentFile, "export const payment = 2;\n");

    const staleCandidate = join(project, "stale-candidate");
    writeCandidate(
      staleCandidate,
      "PAYMENTS OLD\nCATALOG NEW",
      "catalog",
      sourcePaths,
      ["payments", "catalog"],
      currentFingerprint(project, sourcePaths),
    );

    const refused = publish(project, staleCandidate, sourcePaths, baseline);
    expect(refused.status).not.toBe(0);
    expect(`${refused.stdout}\n${refused.stderr}`).toContain("CODEKB_SOURCE_CHANGED");
    expect(
      readFileSync(join(storeDir(project), "architecture.md"), "utf-8"),
    ).toContain("PAYMENTS OLD");
    const status = runUtility(project, ["codekb-scope-diff", "--json"]);
    expect(JSON.parse(status.stdout).verdict).toBe("STALE");

    const retryBaseline = snapshot(project, sourcePaths);
    const retryCandidate = join(project, "retry-candidate");
    writeCandidate(
      retryCandidate,
      "PAYMENTS NEW\nCATALOG NEW",
      "catalog-retry",
      sourcePaths,
      ["payments", "catalog"],
      currentFingerprint(project, sourcePaths),
    );
    const published = publish(project, retryCandidate, sourcePaths, retryBaseline);
    expect(published.status, published.stderr).toBe(0);
    const finalArchitecture = readFileSync(
      join(storeDir(project), "architecture.md"),
      "utf-8",
    );
    expect(finalArchitecture).toContain("PAYMENTS NEW");
    expect(finalArchitecture).toContain("CATALOG NEW");
    expect(JSON.parse(runUtility(project, ["codekb-scope-diff", "--json"]).stdout).verdict)
      .toBe("CURRENT");
  });

  test("two candidates from one generation cannot silently replace each other", () => {
    const project = freshProject();
    for (const area of ["payments", "catalog", "auth"]) {
      const dir = join(project, "src", area);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "index.ts"), `export const ${area} = 1;\n`);
    }

    const payments = ["src/payments/"];
    writeCandidate(
      storeDir(project),
      "BASE",
      "payments",
      payments,
      ["payments"],
      currentFingerprint(project, payments),
    );

    const sourcePaths = ["src/payments/", "src/catalog/", "src/auth/"];
    const baseline = snapshot(project, sourcePaths);
    const catalogPaths = ["src/payments/", "src/catalog/"];
    const authPaths = ["src/payments/", "src/auth/"];
    const catalogCandidate = join(project, "catalog-candidate");
    const authCandidate = join(project, "auth-candidate");
    writeCandidate(
      catalogCandidate,
      "BASE\nCATALOG",
      "catalog",
      catalogPaths,
      ["payments", "catalog"],
      currentFingerprint(project, catalogPaths),
    );
    writeCandidate(
      authCandidate,
      "BASE\nAUTH",
      "auth",
      authPaths,
      ["payments", "auth"],
      currentFingerprint(project, authPaths),
    );

    const commands = [catalogCandidate, authCandidate].map(
      (candidate, index) =>
        `( ${JSON.stringify(BUN)} ${JSON.stringify(UTILITY)} codekb-publish ` +
        `--staged ${JSON.stringify(candidate)} --paths ${JSON.stringify(sourcePaths.join(","))} ` +
        `--expect-store ${JSON.stringify(baseline.store_generation)} ` +
        `--expect-source ${JSON.stringify(baseline.source_fingerprint)} ` +
        `--json --project-dir ${JSON.stringify(project)} ` +
        `> ${JSON.stringify(join(project, `publish-${index}.out`))} ` +
        `2> ${JSON.stringify(join(project, `publish-${index}.err`))}; ` +
        `echo $? > ${JSON.stringify(join(project, `publish-${index}.code`))} ) &`,
    );
    const raced = spawnSync("bash", ["-c", `${commands.join("\n")}\nwait\n`], {
      encoding: "utf-8",
      env: childEnv(),
      timeout: 30_000,
    });
    expect(raced.status, raced.stderr).toBe(0);

    const codes = [0, 1].map((index) =>
      Number(readFileSync(join(project, `publish-${index}.code`), "utf-8").trim())
    );
    expect(codes.filter((code) => code === 0).length).toBe(1);
    expect(codes.filter((code) => code !== 0).length).toBe(1);
    const loser = codes[0] === 0 ? 1 : 0;
    const loserOutput =
      readFileSync(join(project, `publish-${loser}.out`), "utf-8") +
      readFileSync(join(project, `publish-${loser}.err`), "utf-8");
    expect(loserOutput).toContain("CODEKB_STORE_CHANGED");

    const retryBaseline = snapshot(project, sourcePaths);
    const mergedCandidate = join(project, "merged-candidate");
    writeCandidate(
      mergedCandidate,
      "BASE\nCATALOG\nAUTH",
      "merged",
      sourcePaths,
      ["payments", "catalog", "auth"],
      currentFingerprint(project, sourcePaths),
    );
    const retry = publish(project, mergedCandidate, sourcePaths, retryBaseline);
    expect(retry.status, retry.stderr).toBe(0);

    for (const name of ARTIFACT_NAMES.filter(
      (artifact) => artifact !== "reverse-engineering-timestamp.md",
    )) {
      const body = readFileSync(join(storeDir(project), name), "utf-8");
      expect(body.match(/CATALOG/g)?.length).toBe(1);
      expect(body.match(/AUTH/g)?.length).toBe(1);
    }
    expect(JSON.parse(runUtility(project, ["codekb-scope-diff", "--json"]).stdout).verdict)
      .toBe("CURRENT");
  }, 60000);
});
