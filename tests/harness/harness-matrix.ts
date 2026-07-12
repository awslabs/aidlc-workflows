import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { HarnessManifest } from "../../scripts/manifest-types.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const HARNESS_ROOT = join(REPO_ROOT, "harness");

type ReviewerScopeRegistration =
  | "claude-settings"
  | "codex-hooks"
  | "kiro-agent-json"
  | "opencode-plugin"
  | "unsupported";

type HarnessCapabilities = {
  harnessDir: string;
  onboarding: {
    mode: "manifest" | "emit";
    fills: string;
    dist: string;
  };
  rootFiles: readonly string[];
  skillsRoot: string;
  plugin: {
    kind: "store" | "kiro";
    manifestDir: string;
    wiringFile: string;
  };
  memoryInclude: "claude-import" | "codex-env" | "kiro-resources" | "opencode-instructions";
  kiroAgentJson: boolean;
  ideAgentTools: boolean;
  reviewerScopeRegistration: ReviewerScopeRegistration;
};

// These are test capabilities, not packager instructions. Keeping every field
// explicit makes harness-specific test selection reviewable and prevents a new
// manifest from inheriting an accidental default.
const HARNESS_CAPABILITIES = {
  claude: {
    harnessDir: ".claude",
    onboarding: {
      mode: "manifest",
      fills: "onboarding.fills.ts",
      dist: ".claude/CLAUDE.md",
    },
    rootFiles: [".gitignore", ".mcp.json"],
    skillsRoot: ".claude/skills",
    plugin: {
      kind: "store",
      manifestDir: ".claude-plugin",
      wiringFile: "hooks/hooks.json",
    },
    memoryInclude: "claude-import",
    kiroAgentJson: false,
    ideAgentTools: false,
    reviewerScopeRegistration: "claude-settings",
  },
  codex: {
    harnessDir: ".codex",
    onboarding: {
      mode: "emit",
      fills: "onboarding.fills.ts",
      dist: "AGENTS.md",
    },
    rootFiles: [".gitignore", "AGENTS.md"],
    skillsRoot: ".agents/skills",
    plugin: {
      kind: "store",
      manifestDir: ".codex-plugin",
      wiringFile: "hooks/hooks.json",
    },
    memoryInclude: "codex-env",
    kiroAgentJson: false,
    ideAgentTools: false,
    reviewerScopeRegistration: "codex-hooks",
  },
  "kiro-ide": {
    harnessDir: ".kiro",
    onboarding: {
      mode: "manifest",
      fills: "onboarding.fills.ts",
      dist: "AGENTS.md",
    },
    rootFiles: [".gitignore", "AGENTS.md"],
    skillsRoot: ".kiro/skills",
    plugin: {
      kind: "kiro",
      manifestDir: ".kiro-plugin",
      wiringFile: "hooks/aidlc-plugin-compose.kiro.hook",
    },
    memoryInclude: "kiro-resources",
    kiroAgentJson: true,
    ideAgentTools: true,
    reviewerScopeRegistration: "unsupported",
  },
  kiro: {
    harnessDir: ".kiro",
    onboarding: {
      mode: "manifest",
      fills: "onboarding.fills.ts",
      dist: "AGENTS.md",
    },
    rootFiles: [".gitignore", "AGENTS.md"],
    skillsRoot: ".kiro/skills",
    plugin: {
      kind: "kiro",
      manifestDir: ".kiro-plugin",
      wiringFile: "hooks/aidlc-plugin-compose.kiro.hook",
    },
    memoryInclude: "kiro-resources",
    kiroAgentJson: true,
    ideAgentTools: false,
    reviewerScopeRegistration: "kiro-agent-json",
  },
  opencode: {
    harnessDir: ".aidlc",
    onboarding: {
      mode: "manifest",
      fills: "onboarding.fills.ts",
      dist: "AGENTS.md",
    },
    rootFiles: [".gitignore", "AGENTS.md", "opencode.json"],
    skillsRoot: ".aidlc/skills",
    plugin: {
      kind: "store",
      manifestDir: ".opencode-plugin",
      wiringFile: "hooks/hooks.json",
    },
    memoryInclude: "opencode-instructions",
    kiroAgentJson: false,
    ideAgentTools: false,
    reviewerScopeRegistration: "opencode-plugin",
  },
} as const satisfies Record<string, HarnessCapabilities>;

export type ShippedHarnessName = keyof typeof HARNESS_CAPABILITIES;

export type ShippedHarness = {
  name: ShippedHarnessName;
  manifest: HarnessManifest;
  capabilities: HarnessCapabilities;
  authoredRoot: string;
  distRoot: string;
  engineRoot: string;
  skillsRoot: string;
  onboardingFills: string;
  onboardingDist: string;
};

function discoverManifestNames(): string[] {
  return readdirSync(HARNESS_ROOT)
    .filter((name) => existsSync(join(HARNESS_ROOT, name, "manifest.ts")))
    .sort();
}

function fail(name: string, message: string): never {
  throw new Error(`harness matrix [${name}]: ${message}`);
}

export function manifestGrantsIdeAgentTools(
  manifest: Pick<HarnessManifest, "frontmatterAdditions">,
): boolean {
  return (
    manifest.frontmatterAdditions?.some(
      ({ file, lines }) =>
        /^agents\/[^/]+\.md$/.test(file) &&
        lines.some((line) => line.split(":", 1)[0]?.trim() === "tools"),
    ) ?? false
  );
}

function validateManifest(
  name: ShippedHarnessName,
  manifest: HarnessManifest,
  capabilities: HarnessCapabilities,
): void {
  if (manifest.name !== name) fail(name, `manifest.name is "${manifest.name}"`);
  if (manifest.harnessDir !== capabilities.harnessDir) {
    fail(
      name,
      `metadata harnessDir "${capabilities.harnessDir}" != manifest "${manifest.harnessDir}"`,
    );
  }

  const usesEmittedSkills = manifest.skipRunnerGen === true;
  if (usesEmittedSkills !== (capabilities.skillsRoot !== `${manifest.harnessDir}/skills`)) {
    fail(name, "skillsRoot does not agree with manifest.skipRunnerGen");
  }

  const onboarding = manifest.onboarding ?? null;
  if (capabilities.onboarding.mode === "manifest") {
    if (!onboarding) fail(name, "metadata expects manifest onboarding");
    const dist = onboarding.projectRoot
      ? onboarding.dst
      : `${manifest.harnessDir}/${onboarding.dst}`;
    if (dist !== capabilities.onboarding.dist) {
      fail(name, `onboarding dist "${capabilities.onboarding.dist}" != manifest "${dist}"`);
    }
  } else if (onboarding || !manifest.emit) {
    fail(name, "emitted onboarding requires onboarding:null and an emit function");
  }

  for (const file of manifest.harnessFiles.filter((file) => file.projectRoot)) {
    if (!capabilities.rootFiles.includes(file.dst)) {
      fail(name, `project-root manifest file "${file.dst}" is absent from rootFiles metadata`);
    }
  }
  if (onboarding?.projectRoot && !capabilities.rootFiles.includes(onboarding.dst)) {
    fail(name, `project-root onboarding "${onboarding.dst}" is absent from rootFiles metadata`);
  }

  const hasKiroAgentJson = manifest.harnessFiles.some(
    (file) => file.dst === "agents/aidlc.json",
  );
  if (hasKiroAgentJson !== capabilities.kiroAgentJson) {
    fail(name, "kiroAgentJson does not agree with manifest harnessFiles");
  }
  if (
    (capabilities.memoryInclude === "kiro-resources") !== hasKiroAgentJson ||
    (capabilities.memoryInclude === "claude-import") !==
      manifest.harnessFiles.some((file) => file.dst === "rules/aidlc.md") ||
    (capabilities.memoryInclude === "codex-env") !==
      (capabilities.onboarding.mode === "emit") ||
    (capabilities.memoryInclude === "opencode-instructions") !==
      manifest.harnessFiles.some((file) => file.dst === "opencode.json")
  ) {
    fail(name, "memoryInclude does not agree with manifest-owned include surfaces");
  }
  if (manifestGrantsIdeAgentTools(manifest) !== capabilities.ideAgentTools) {
    fail(name, "ideAgentTools does not agree with manifest agent tools grants");
  }
  if (
    manifest.plugin &&
    (manifest.plugin.kind !== capabilities.plugin.kind ||
      manifest.plugin.manifestDir !== capabilities.plugin.manifestDir)
  ) {
    fail(name, "plugin metadata does not agree with the manifest plugin block");
  }
}

const discoveredNames = discoverManifestNames();
const metadataNames = Object.keys(HARNESS_CAPABILITIES).sort();
if (discoveredNames.join("\n") !== metadataNames.join("\n")) {
  throw new Error(
    "harness matrix metadata must exactly cover discovered manifests\n" +
      `discovered: ${discoveredNames.join(", ")}\n` +
      `metadata: ${metadataNames.join(", ")}\n` +
      "fix: add a HARNESS_CAPABILITIES entry for the new harness in " +
      "tests/harness/harness-matrix.ts (validateManifest cross-checks it " +
      "against the manifest, so every field must reflect the real distribution)",
  );
}

export const HARNESS_MATRIX: readonly ShippedHarness[] = discoveredNames.map((rawName) => {
  const name = rawName as ShippedHarnessName;
  const authoredRoot = join(HARNESS_ROOT, name);
  const manifest = (
    require(join(authoredRoot, "manifest.ts")) as { default: HarnessManifest }
  ).default;
  const capabilities: HarnessCapabilities = HARNESS_CAPABILITIES[name];
  validateManifest(name, manifest, capabilities);

  const distRoot = join(REPO_ROOT, "dist", name);
  const engineRoot = join(distRoot, manifest.harnessDir);
  const onboardingFills = join(authoredRoot, capabilities.onboarding.fills);
  const onboardingDist = join(distRoot, capabilities.onboarding.dist);
  const skillsRoot = join(distRoot, capabilities.skillsRoot);
  for (const [label, path] of [
    ["dist root", distRoot],
    ["engine root", engineRoot],
    ["onboarding fills", onboardingFills],
    ["onboarding dist", onboardingDist],
    ["skills root", skillsRoot],
  ]) {
    if (!existsSync(path)) fail(name, `${label} is missing: ${path}`);
  }

  return {
    name,
    manifest,
    capabilities,
    authoredRoot,
    distRoot,
    engineRoot,
    skillsRoot,
    onboardingFills,
    onboardingDist,
  };
});

export function harnessByName(name: ShippedHarnessName): ShippedHarness {
  const harness = HARNESS_MATRIX.find((candidate) => candidate.name === name);
  if (!harness) fail(name, "not discovered");
  return harness;
}
