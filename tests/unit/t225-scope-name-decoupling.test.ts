// covers: function:loadScopeMetadata, function:selectionAwareDefaultScope, function:stageEnabledBySelection

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadScopeMetadata,
  selectionAwareDefaultScope,
  stageEnabledBySelection,
} from "../../core/tools/aidlc-lib.ts";
import { withEnvAndFreshCaches } from "../harness/fixtures.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CORE_TOOLS = join(REPO_ROOT, "core", "tools");
const CORE_SCOPES = join(REPO_ROOT, "core", "scopes");
const DIST_CLAUDE = join(REPO_ROOT, "dist", "claude", ".claude");
const TEST_PRO_SCOPE = join(REPO_ROOT, "plugins", "test-pro", "scopes", "test-pro-validation.md");
const BUN = process.execPath;

const CORE_SCOPE_NAMES = [
  "enterprise",
  "mvp",
  "feature",
  "poc",
  "workshop",
  "infra",
  "bugfix",
  "security-patch",
  "refactor",
] as const;

const SKELETON_ON_CORE_SCOPES = [
  "enterprise",
  "feature",
  "infra",
  "mvp",
  "poc",
  "workshop",
];

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
  delete process.env.AIDLC_SCOPES_DIR;
  delete process.env.AIDLC_SCOPE_MAPPING;
  withEnvAndFreshCaches({}, () => undefined);
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeScope(dir: string, name: string, skeleton?: string): void {
  const skeletonLine = skeleton === undefined ? [] : [`skeleton: ${skeleton}`];
  writeFileSync(
    join(dir, `${name}.md`),
    [
      "---",
      `name: ${name}`,
      "depth: Minimal",
      "keywords: []",
      "description: Fixture scope",
      ...skeletonLine,
      "---",
      "",
      `# ${name}`,
      "",
    ].join("\n"),
    "utf-8",
  );
}

function stripComments(source: string): string {
  let out = "";
  let i = 0;
  let state: "code" | "line" | "block" | "string" | "template" = "code";
  let quote = "";
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1] ?? "";

    if (state === "line") {
      if (ch === "\n") {
        out += "\n";
        state = "code";
      }
      i++;
      continue;
    }
    if (state === "block") {
      if (ch === "*" && next === "/") {
        i += 2;
        state = "code";
      } else {
        if (ch === "\n") out += "\n";
        i++;
      }
      continue;
    }
    if (state === "string" || state === "template") {
      out += ch;
      if (ch === "\\") {
        out += next;
        i += 2;
        continue;
      }
      if (ch === quote) state = "code";
      i++;
      continue;
    }

    if (ch === "/" && next === "/") {
      state = "line";
      i += 2;
      continue;
    }
    if (ch === "/" && next === "*") {
      state = "block";
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      state = "string";
      quote = ch;
      out += ch;
      i++;
      continue;
    }
    if (ch === "`") {
      state = "template";
      quote = ch;
      out += ch;
      i++;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

// Innermost bracket-pair bodies (quoted strings may contain brackets without
// splitting a pair). A single linear scan with a bracket stack - the previous
// backreference-free regex form backtracked quadratically and blew past the
// 5s test timeout once aidlc-lib.ts grew large enough.
function arrayLiteralBodies(code: string): string[] {
  const bodies: string[] = [];
  const stack: Array<{ start: number; hadNested: boolean }> = [];
  let i = 0;
  while (i < code.length) {
    const ch = code[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      i++;
      while (i < code.length && code[i] !== ch) i += code[i] === "\\" ? 2 : 1;
      i++;
      continue;
    }
    if (ch === "[") {
      stack.push({ start: i + 1, hadNested: false });
    } else if (ch === "]") {
      const top = stack.pop();
      if (top) {
        if (!top.hadNested) bodies.push(code.slice(top.start, i));
        const parent = stack[stack.length - 1];
        if (parent) parent.hadNested = true;
      }
    }
    i++;
  }
  return bodies;
}

function literalScopeNames(body: string): string[] {
  const names = new Set<string>();
  const re = /(["'`])((?:\\.|(?!\1)[\s\S])*?)\1/g;
  for (const m of body.matchAll(re)) {
    const value = m[2];
    if ((CORE_SCOPE_NAMES as readonly string[]).includes(value)) names.add(value);
  }
  return [...names].sort();
}

function makePluginOnlyInstall(): string {
  const project = tempDir("aidlc-t225-plugin-only-");
  const harness = join(project, ".claude");
  cpSync(DIST_CLAUDE, harness, { recursive: true });
  cpSync(TEST_PRO_SCOPE, join(harness, "scopes", "test-pro-validation.md"));

  const harnessJson = join(harness, "tools", "data", "harness.json");
  const harnessData = JSON.parse(readFileSync(harnessJson, "utf-8")) as Record<string, unknown>;
  harnessData.plugins = ["test-pro"];
  writeFileSync(harnessJson, `${JSON.stringify(harnessData, null, 2)}\n`, "utf-8");

  const grid = {
    "test-pro-validation": {
      stages: {
        "requirements-analysis": "EXECUTE",
      },
    },
  };
  writeFileSync(
    join(harness, "tools", "data", "scope-grid.json"),
    `${JSON.stringify(grid, null, 2)}\n`,
    "utf-8",
  );
  mkdirSync(join(project, "aidlc"), { recursive: true });
  return project;
}

// Known pre-existing couplings, exempted by exact (file, name-set) signature.
// The workspace-detection greenfield advisory names the three incremental
// scopes in a stderr note (predates this probe; decoupling it means changing
// which scopes get the advisory, a behavior call outside this probe's job).
// A NEW literal, or this one growing a fourth name, still fails.
const KNOWN_COUPLINGS = new Set(["aidlc-utility.ts: [bugfix, refactor, security-patch]"]);

describe("t225 static scope-name coupling probe", () => {
  test("core tools do not carry 3+ core scope names in one Set/array literal", () => {
    const failures: string[] = [];
    for (const file of readdirSync(CORE_TOOLS).filter((name) => name.endsWith(".ts")).sort()) {
      const path = join(CORE_TOOLS, file);
      const stripped = stripComments(readFileSync(path, "utf-8"));
      for (const body of arrayLiteralBodies(stripped)) {
        const names = literalScopeNames(body);
        const signature = `${file}: [${names.join(", ")}]`;
        if (names.length >= 3 && !KNOWN_COUPLINGS.has(signature)) failures.push(signature);
      }
    }
    expect(failures).toEqual([]);
  });
});

describe("t225 skeleton scope metadata", () => {
  test("fixture scopes parse skeleton on/off, absent defaults off, and invalid names the file", () => {
    const dir = tempDir("aidlc-t225-scopes-");
    writeScope(dir, "skeleton-on", "on");
    writeScope(dir, "skeleton-off", "off");
    writeScope(dir, "skeleton-absent");

    withEnvAndFreshCaches({ AIDLC_SCOPES_DIR: dir }, () => {
      const metadata = loadScopeMetadata();
      expect(metadata["skeleton-on"].skeleton).toBe(true);
      expect(metadata["skeleton-off"].skeleton).toBe(false);
      expect(metadata["skeleton-absent"].skeleton).toBe(false);
    });

    const invalidDir = tempDir("aidlc-t225-invalid-scopes-");
    writeScope(invalidDir, "bad-skeleton", "maybe");
    expect(() =>
      withEnvAndFreshCaches({ AIDLC_SCOPES_DIR: invalidDir }, () => loadScopeMetadata()),
    ).toThrow(new RegExp(`${join(invalidDir, "bad-skeleton.md").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.*maybe`));
  });

  test("core skeleton defaults match the previous six-scope behavior", () => {
    withEnvAndFreshCaches({ AIDLC_SCOPES_DIR: CORE_SCOPES }, () => {
      const metadata = loadScopeMetadata();
      const skeletonOn = Object.values(metadata)
        .filter((scope) => scope.skeleton)
        .map((scope) => scope.name)
        .sort();
      expect(skeletonOn).toEqual(SKELETON_ON_CORE_SCOPES);
    });
  });
});

describe("t225 env-scope fallback under plugin-only selection", () => {
  test("stageEnabledBySelection keeps initialization enabled under plugin-only selection", () => {
    const project = makePluginOnlyInstall();
    const script = [
      `import { stageEnabledBySelection } from ${JSON.stringify(join(project, ".claude", "tools", "aidlc-lib.ts"))};`,
      "console.log(JSON.stringify({",
      "  init: stageEnabledBySelection({ plugin: 'aidlc', phase: 'initialization' }),",
      "  construction: stageEnabledBySelection({ plugin: 'aidlc', phase: 'construction' }),",
      "}));",
    ].join("\n");
    const result = spawnSync(BUN, ["-e", script], {
      cwd: project,
      encoding: "utf-8",
      env: { ...process.env, AIDLC_HARNESS_DIR: ".claude" },
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ init: true, construction: false });
    expect(stageEnabledBySelection({ plugin: "aidlc", phase: "initialization" })).toBe(true);
  });

  test("selectionAwareDefaultScope notes sole-plugin substitution only when it substitutes", () => {
    const dir = tempDir("aidlc-t225-scope-mapping-");
    const mappingPath = join(dir, "scope-mapping.json");
    writeFileSync(
      mappingPath,
      `${JSON.stringify(
        {
          "test-pro-validation": {
            depth: "Minimal",
            description: "Plugin fixture",
            keywords: [],
            plugin: "test-pro",
            stages: {},
          },
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );

    withEnvAndFreshCaches({ AIDLC_SCOPE_MAPPING: mappingPath }, () => {
      const fallback = selectionAwareDefaultScope("feature");
      expect(fallback.scope).toBe("test-pro-validation");
      expect(fallback.error).toBeUndefined();
      expect(fallback.note).toBe(
        'scope "feature" is not an enabled scope; using "test-pro-validation" (sole enabled plugin\'s first scope)',
      );
    });

    writeFileSync(
      mappingPath,
      `${JSON.stringify(
        {
          feature: {
            depth: "Minimal",
            description: "Core fixture",
            keywords: [],
            stages: {},
          },
          "test-pro-validation": {
            depth: "Minimal",
            description: "Plugin fixture",
            keywords: [],
            plugin: "test-pro",
            stages: {},
          },
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );

    withEnvAndFreshCaches({ AIDLC_SCOPE_MAPPING: mappingPath }, () => {
      const preferred = selectionAwareDefaultScope("feature");
      expect(preferred.scope).toBe("feature");
      expect(preferred.error).toBeUndefined();
      expect(preferred.note).toBeUndefined();
    });
  });

  test("AWS_AIDLC_DEFAULT_SCOPE naming disabled core falls back to the sole plugin scope", () => {
    const project = makePluginOnlyInstall();
    const tool = join(project, ".claude", "tools", "aidlc-orchestrate.ts");
    const result = spawnSync(
      BUN,
      [
        tool,
        "next",
        "--stage",
        "requirements-analysis",
        "--single",
        "--project-dir",
        project,
      ],
      {
        cwd: project,
        encoding: "utf-8",
        env: {
          ...process.env,
          AIDLC_HARNESS_DIR: ".claude",
          AWS_AIDLC_DEFAULT_SCOPE: "feature",
        },
      },
    );
    const out = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    expect(result.status).toBe(0);
    expect(out).not.toContain("Invalid AWS_AIDLC_DEFAULT_SCOPE");
    expect(out).toContain('"kind":"run-stage"');
    expect(out).toContain('"stage":"requirements-analysis"');
    expect(result.stderr).toContain(
      'AWS_AIDLC_DEFAULT_SCOPE="feature" is not an enabled scope; using test-pro-validation (sole enabled plugin\'s first scope)',
    );
  });
});
