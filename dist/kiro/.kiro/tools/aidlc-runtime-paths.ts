import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MODULE_TOOLS_DIR = dirname(fileURLToPath(import.meta.url));
const MODULE_HARNESS_ROOT = join(MODULE_TOOLS_DIR, "..");
const KNOWN_HARNESSES = [".claude", ".kiro", ".codex", ".cursor", ".aidlc"] as const;

export interface HarnessLocation {
  harnessDir?: string;
  distribution?: string;
  mutable?: boolean;
  projectDir?: string;
}

export function isCompiledExecutable(
  moduleUrl = import.meta.url,
  executable = process.execPath,
): boolean {
  const normalizedModuleUrl = moduleUrl.replace(/\\/g, "/");
  const executableName = basename(executable.replace(/\\/g, "/")).toLowerCase();
  return normalizedModuleUrl.includes("/$bunfs/") || !executableName.startsWith("bun");
}

export function compiledExecutable(): string | null {
  const explicit = process.env.AIDLC_COMPILED_EXECUTABLE?.trim();
  if (explicit) return explicit;
  return isCompiledExecutable() ? process.execPath : null;
}

function explicitRuntimeProjectDir(): string | null {
  const argv = process.argv.slice(1);
  const index = argv.indexOf("--project-dir");
  if (index >= 0 && argv[index + 1] && !argv[index + 1].startsWith("--")) {
    return isAbsolute(argv[index + 1])
      ? argv[index + 1]
      : resolve(process.cwd(), argv[index + 1]);
  }
  const explicit = process.env.AIDLC_PROJECT_DIR ?? process.env.CLAUDE_PROJECT_DIR;
  return explicit
    ? isAbsolute(explicit) ? explicit : resolve(process.cwd(), explicit)
    : null;
}

export function runtimeProjectDir(): string {
  return explicitRuntimeProjectDir() ?? process.cwd();
}

export function runtimeHarnessDir(projectDir = runtimeProjectDir()): string {
  const explicit = process.env.AIDLC_HARNESS_DIR?.trim();
  if (explicit) return explicit;

  if (basename(MODULE_TOOLS_DIR) === "tools") {
    const candidate = basename(MODULE_HARNESS_ROOT);
    if (/^\.[a-z0-9][a-z0-9._-]*$/i.test(candidate)) return candidate;
  }

  for (const candidate of KNOWN_HARNESSES) {
    if (isAidlcHarnessRoot(join(projectDir, candidate))) return candidate;
  }
  return ".claude";
}

function readHarnessName(root: string): string | null {
  try {
    const parsed = JSON.parse(
      readFileSync(join(root, "tools", "data", "harness.json"), "utf-8"),
    ) as { name?: unknown };
    return typeof parsed.name === "string" && parsed.name.trim()
      ? parsed.name.trim()
      : null;
  } catch {
    return null;
  }
}

export function runtimeHarnessName(
  projectDir = runtimeProjectDir(),
  harnessDir = runtimeHarnessDir(projectDir),
): string {
  const explicit = process.env.AIDLC_HARNESS_NAME?.trim();
  if (explicit) return explicit;

  const projectRoot =
    basename(projectDir) === harnessDir && existsSync(join(projectDir, "tools"))
      ? projectDir
      : join(projectDir, harnessDir);
  for (const root of [projectRoot, MODULE_HARNESS_ROOT]) {
    const name = readHarnessName(root);
    if (name) return name;
  }

  // Copilot and OpenCode intentionally share .aidlc. Their harness.json name
  // above is the authoritative discriminator; retain OpenCode only as the
  // metadata-unavailable compatibility fallback.
  if (harnessDir === ".aidlc") return "opencode";
  if (harnessDir === ".codex") return "codex";
  if (harnessDir === ".kiro") return "kiro";
  if (harnessDir === ".cursor") return "cursor";
  return "claude";
}

function distributionFor(harnessDir: string, projectDir = runtimeProjectDir()): string {
  return runtimeHarnessName(projectDir, harnessDir);
}

function explicitHarnessRoot(harnessDir: string, distribution: string): string | null {
  const direct = process.env.AIDLC_RUNTIME_HARNESS_ROOT?.trim();
  if (direct) return isAbsolute(direct) ? direct : resolve(process.cwd(), direct);

  const runtimeRoot = process.env.AIDLC_RUNTIME_ROOT?.trim();
  if (!runtimeRoot) return null;
  const root = isAbsolute(runtimeRoot) ? runtimeRoot : resolve(process.cwd(), runtimeRoot);
  const distributionRoot = join(root, distribution);
  return existsSync(join(distributionRoot, harnessDir))
    ? join(distributionRoot, harnessDir)
    : join(root, harnessDir);
}

function moduleHarnessRoot(harnessDir: string): string | null {
  return existsSync(join(MODULE_HARNESS_ROOT, "tools")) &&
    (
      basename(MODULE_HARNESS_ROOT) === harnessDir ||
      !isCompiledExecutable() ||
      basename(process.execPath).startsWith("bun")
    )
    ? MODULE_HARNESS_ROOT
    : null;
}

function isAidlcHarnessRoot(root: string): boolean {
  return existsSync(join(root, "tools", "data", "harness.json"));
}

export function packagedDistributionRoot(
  harnessDir = runtimeHarnessDir(),
  distribution = distributionFor(harnessDir),
): string {
  return join(dirname(process.execPath), "runtime", distribution);
}

export function resolveHarnessRoot(location: HarnessLocation = {}): string {
  const projectDir = location.projectDir ?? runtimeProjectDir();
  const harnessDir = location.harnessDir ?? runtimeHarnessDir(projectDir);
  const distribution = location.distribution ?? distributionFor(harnessDir, projectDir);
  const projectRoot =
    basename(projectDir) === harnessDir &&
    existsSync(join(projectDir, "tools"))
      ? projectDir
      : join(projectDir, harnessDir);

  // Mutation is project-owned. Explicit/module/packaged roots are read
  // fallbacks only and must never become a write target.
  if (location.mutable) {
    if (location.projectDir !== undefined || explicitRuntimeProjectDir()) {
      return projectRoot;
    }
    const moduleRoot = moduleHarnessRoot(harnessDir);
    return moduleRoot ?? projectRoot;
  }

  const explicit = explicitHarnessRoot(harnessDir, distribution);
  if (explicit) return explicit;

  const moduleRoot = moduleHarnessRoot(harnessDir);
  const packagedRoot = join(packagedDistributionRoot(harnessDir, distribution), harnessDir);

  if (moduleRoot) return moduleRoot;
  if (isAidlcHarnessRoot(projectRoot)) return projectRoot;
  if (existsSync(packagedRoot)) return packagedRoot;
  return packagedRoot;
}

export function resolveHarnessPath(
  segments: readonly string[],
  location: HarnessLocation = {},
): string {
  return join(resolveHarnessRoot(location), ...segments);
}

export function resolveSkillsPath(
  segments: readonly string[] = [],
  location: HarnessLocation = {},
): string {
  const projectDir = location.projectDir ?? runtimeProjectDir();
  const harnessDir = location.harnessDir ?? runtimeHarnessDir(projectDir);
  const harnessSkills = resolveHarnessPath(["skills", ...segments], {
    ...location,
    harnessDir,
  });
  const distribution = location.distribution ??
    runtimeHarnessName(projectDir, harnessDir);
  const distributionRoot = dirname(resolveHarnessRoot({
    ...location,
    harnessDir,
    distribution,
  }));
  if (distribution === "copilot") {
    return join(distributionRoot, ".github", "skills", ...segments);
  }
  if (distribution === "codex" && !existsSync(harnessSkills)) {
    return join(distributionRoot, ".agents", "skills", ...segments);
  }
  return harnessSkills;
}

export function resolveDistributionPath(
  segments: readonly string[],
  location: HarnessLocation = {},
): string {
  const projectDir = location.projectDir ?? runtimeProjectDir();
  if (
    location.mutable ||
    isAidlcHarnessRoot(join(projectDir, runtimeHarnessDir(projectDir)))
  ) {
    return join(projectDir, ...segments);
  }
  return join(
    packagedDistributionRoot(
      location.harnessDir ?? runtimeHarnessDir(projectDir),
      location.distribution,
    ),
    ...segments,
  );
}
