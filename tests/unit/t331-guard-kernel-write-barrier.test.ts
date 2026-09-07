// covers: function:resolveProtectedStore
// covers: function:protectedStoreBarrier
//
// t331 - protected-store decisions rest on canonical path and executable
// provenance proofs. Each test pins one write-barrier property in-process.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  copyFileSync,
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import {
  protectedStoreBarrier,
  resolveProtectedStore,
  type BarrierInput,
  type BarrierVerdict,
  type ProtectedStore,
} from "../../core/tools/aidlc-guard-kernel.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const TOOLS_DIR = join(REPO_ROOT, "core", "tools");
const AUTHORED_TOOL = join(TOOLS_DIR, "aidlc-version.ts");
const TEST_ROOT = join(
  tmpdir(),
  `aidlc-t331-guard-kernel-write-barrier-${process.pid}`,
);
const transientToolPaths: string[] = [];

interface Fixture {
  root: string;
  projectDir: string;
  cwd: string;
  storeDir: string;
  store: ProtectedStore;
}

function fixture(name: string): Fixture {
  const root = join(TEST_ROOT, name);
  const projectDir = join(root, "project");
  const cwd = join(projectDir, "workspace");
  const storeDir = join(projectDir, "ProtectedStore");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(storeDir, { recursive: true });
  const store = resolveProtectedStore("protected-store", storeDir);
  if (store === null) throw new Error("fixture store must have canonical identity");
  return { root, projectDir, cwd, storeDir, store };
}

function barrier(
  current: Fixture,
  toolName: string,
  toolInput: Record<string, unknown> | undefined,
  overrides: Partial<BarrierInput> = {},
  stores: readonly ProtectedStore[] = [current.store],
): BarrierVerdict {
  return protectedStoreBarrier(
    {
      toolName,
      toolInput,
      cwd: current.cwd,
      projectDir: current.projectDir,
      ...overrides,
    },
    stores,
  );
}

function expectKind(
  verdict: BarrierVerdict,
  kind: BarrierVerdict["kind"],
): void {
  expect(verdict.kind).toBe(kind);
}

beforeEach(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true });
  mkdirSync(TEST_ROOT, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true });
  for (const path of transientToolPaths.splice(0)) {
    rmSync(path, { force: true });
  }
});

describe("guard kernel protected-store write barrier", () => {
  test("canonical-path resolution: every non-canonical spelling of a protected path decides identically to its canonical form", () => {
    const current = fixture("canonical-path");
    const target = join(current.storeDir, "MixedCaseRecord.json");
    const spellings = [
      target,
      relative(current.cwd, target),
      join(current.cwd, "unused", "..", relative(current.cwd, target)),
      target.replaceAll("/", "\\"),
    ];

    for (const spelling of spellings) {
      expectKind(
        barrier(current, "Write", { file_path: spelling }),
        "store-overlap",
      );
    }
  });

  test("link-indirection resolution: a path reaching a protected store through any link in its chain is decided at the resolved target", () => {
    const current = fixture("link-indirection");
    const existingTarget = join(current.storeDir, "existing.json");
    const outsideTarget = join(current.root, "outside.json");
    const ancestorLink = join(current.root, "ancestor-link");
    const leafLink = join(current.root, "leaf-link.json");
    writeFileSync(existingTarget, "{}\n");
    writeFileSync(outsideTarget, "{}\n");
    symlinkSync(dirname(current.storeDir), ancestorLink);
    symlinkSync(existingTarget, leafLink);

    expectKind(
      barrier(current, "Write", {
        file_path: join(
          ancestorLink,
          basename(current.storeDir),
          "through-ancestor.json",
        ),
      }),
      "store-overlap",
    );
    expectKind(
      barrier(current, "Write", { file_path: leafLink }),
      "store-overlap",
    );

    const lateLink = join(current.root, "late-link");
    symlinkSync(current.storeDir, lateLink);
    expectKind(
      barrier(current, "Write", {
        file_path: join(lateLink, "registered-first.json"),
      }),
      "store-overlap",
    );

    const outwardLink = join(current.storeDir, "outward-link.json");
    symlinkSync(outsideTarget, outwardLink);
    expectKind(
      barrier(current, "Write", { file_path: outwardLink }),
      "proven-disjoint",
    );
  });

  test("provenance-proof for executables: framework-tool identity is the resolved real file, never the name or lookup order", () => {
    const current = fixture("executable-provenance");
    const runtime = realpathSync(process.execPath);
    const canonical = `${runtime} ${AUTHORED_TOOL}`;
    expectKind(
      barrier(
        current,
        "Bash",
        { command: canonical },
        { cwd: REPO_ROOT, projectDir: REPO_ROOT },
      ),
      "proven-framework-tool",
    );

    const relativeRuntime = relative(REPO_ROOT, runtime);
    const fakeRuntime = join(current.root, "different-runtime");
    writeFileSync(fakeRuntime, "#!/bin/sh\n");
    const outsideCopy = join(current.root, "aidlc-version.ts");
    copyFileSync(AUTHORED_TOOL, outsideCopy);
    const linkedTool = join(
      TOOLS_DIR,
      `aidlc-t331-linked-tool-${process.pid}.ts`,
    );
    transientToolPaths.push(linkedTool);
    symlinkSync(outsideCopy, linkedTool);

    const commands = [
      `${basename(runtime)} ${AUTHORED_TOOL}`,
      `${relativeRuntime} ${AUTHORED_TOOL}`,
      `${fakeRuntime} ${AUTHORED_TOOL}`,
      `${runtime} ${outsideCopy}`,
      `${runtime} ${linkedTool}`,
    ];
    for (const command of commands) {
      expect(
        barrier(
          current,
          "Bash",
          { command },
          { cwd: REPO_ROOT, projectDir: REPO_ROOT },
        ).kind,
      ).not.toBe("proven-framework-tool");
    }
  });

  test("delegated-invocation denial: a permitted tool reached through a delegation layer is not provenance", () => {
    const current = fixture("delegated-invocation");
    const runtime = realpathSync(process.execPath);
    const preload = join(current.root, "preload.ts");
    writeFileSync(preload, "export {};\n");
    const canonical = `${runtime} ${AUTHORED_TOOL}`;
    const commands = [
      `env ${canonical}`,
      `xargs ${canonical}`,
      `timeout 1 ${canonical}`,
      `${runtime} --preload ${preload} ${AUTHORED_TOOL}`,
      `cat <(${canonical})`,
    ];

    for (const command of commands) {
      expectKind(
        barrier(
          current,
          "Bash",
          { command },
          { cwd: REPO_ROOT, projectDir: REPO_ROOT },
        ),
        "unprovable",
      );
    }
  });

  test("closed-designator allow: a shell command is proven disjoint only when its designatable path set is syntactically closed and fully resolved", () => {
    const current = fixture("closed-designator");
    const command = realpathSync("/bin/echo");
    const outside = join(current.root, "outside.txt");
    writeFileSync(outside, "outside\n");

    expectKind(
      barrier(current, "Bash", { command: `${command} ${outside}` }),
      "proven-disjoint",
    );
    expectKind(
      barrier(current, "Bash", {
        command: `${command} ${outside} "$AIDLC_DYNAMIC_PATH"`,
      }),
      "unprovable",
    );
    expectKind(
      barrier(current, "Bash", {
        command: `${command} ${outside} ${join(current.storeDir, "entry.json")}`,
      }),
      "store-overlap",
    );
    expectKind(
      barrier(
        current,
        "Bash",
        { command: `${command} *` },
        { cwd: current.projectDir },
      ),
      "store-overlap",
    );
    expectKind(
      barrier(
        current,
        "Bash",
        { command: `${command} --output` },
        { cwd: current.storeDir },
      ),
      "store-overlap",
    );
  });

  test("path-separator and control-character normalization: separator variants and embedded control characters cannot produce a distinct decision from the normalized form", () => {
    const current = fixture("path-normalization");
    const target = join(current.storeDir, "entry.json");
    const separatorVariant = relative(current.cwd, target).replaceAll(
      "/",
      "\\",
    );
    expectKind(
      barrier(current, "Write", { file_path: separatorVariant }),
      "store-overlap",
    );

    const controlPath = join(current.storeDir, "line\nbreak.json");
    writeFileSync(controlPath, "{}\n");
    expectKind(
      barrier(current, "Write", { file_path: controlPath }),
      "store-overlap",
    );
    expectKind(
      barrier(current, "Bash", {
        command: `${realpathSync("/bin/echo")} ${controlPath}`,
      }),
      "unprovable",
    );
  });

  test("nested-repository boundary: canonical resolution does not truncate at a repository boundary", () => {
    const current = fixture("nested-repository");
    const nestedRepo = join(current.projectDir, "nested-repo");
    const siblingRepo = join(current.projectDir, "sibling-repo");
    const nestedStoreDir = join(nestedRepo, "state", "protected");
    const siblingStoreDir = join(siblingRepo, "state", "protected");
    mkdirSync(join(nestedRepo, ".git"), { recursive: true });
    mkdirSync(join(siblingRepo, ".git"), { recursive: true });
    mkdirSync(nestedStoreDir, { recursive: true });
    mkdirSync(siblingStoreDir, { recursive: true });
    const nestedStore = resolveProtectedStore("nested-store", nestedStoreDir);
    const siblingStore = resolveProtectedStore("sibling-store", siblingStoreDir);
    if (nestedStore === null || siblingStore === null) {
      throw new Error("repository stores must have canonical identity");
    }

    expectKind(
      barrier(
        current,
        "Write",
        { file_path: join(nestedStoreDir, "entry.json") },
        {},
        [nestedStore],
      ),
      "store-overlap",
    );
    expectKind(
      barrier(
        current,
        "Write",
        { file_path: relative(current.cwd, join(siblingStoreDir, "entry.json")) },
        {},
        [siblingStore],
      ),
      "store-overlap",
    );
  });

  test("default-deny: unresolvable inputs are never an allow", () => {
    const current = fixture("default-deny");
    const unavailablePath = join(current.root, "unavailable-store");
    expect(resolveProtectedStore("unavailable", unavailablePath)).toBeNull();

    const throwingInput = new Proxy<Record<string, unknown>>(
      {},
      {
        ownKeys() {
          throw new Error("path fields unavailable");
        },
      },
    );
    const verdicts = [
      barrier(
        current,
        "Write",
        { file_path: join(current.root, "outside.txt") },
        {},
        [{ name: "unavailable", realPath: unavailablePath }],
      ),
      barrier(current, "Write", { file_path: "\0" }),
      barrier(current, "Write", { value: "outside.txt" }),
      barrier(current, "Write", throwingInput),
    ];

    for (const verdict of verdicts) {
      expectKind(verdict, "unprovable");
    }
  });
});
