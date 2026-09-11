import { type Dirent, existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MODULE_TOOLS_DIR = dirname(fileURLToPath(import.meta.url));
const MODULE_HARNESS_ROOT = join(MODULE_TOOLS_DIR, "..");
const PROJECTED_INVOKE = "{{INVOKE}}";
// Release version grammar: stable x.y.z, or a preview id
// x.y.z-preview.YYYYMMDD.N. Literal of PREVIEW_CHANNEL / VERSION_ID in
// aidlc-channel.ts, repeated here because hooks ship this module with a closed
// set of sibling tools and must not grow that closure; t330 keeps them in step.
const FRAMEWORK_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-preview\.\d{8}\.[1-9]\d*)?$/;

export interface HarnessLocation {
  harnessDir?: string;
  distribution?: string;
  mutable?: boolean;
  projectDir?: string;
}

export interface ProjectHarness {
  root: string;
  harnessDir: string;
  distribution: string;
  frameworkVersion?: string;
}

const HARNESS_PRECEDENCE = [".claude", ".kiro", ".codex", ".cursor", ".aidlc"] as const;

function markerRecord(path: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf-8"));
  } catch (error) {
    throw new Error(
      `${path}: invalid harness metadata (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path}: harness metadata must be an object`);
  }
  return value as Record<string, unknown>;
}

function legacyDistribution(harnessDir: string): string | null {
  if (!/^\.[a-z0-9][a-z0-9._-]*$/i.test(harnessDir)) return null;
  return harnessDir.slice(1);
}

function harnessIdentity(root: string, strict = false): ProjectHarness | null {
  const harnessDir = basename(root);
  const dataDir = join(root, "tools", "data");
  const harnessPath = join(dataDir, "harness.json");
  const stampPath = join(dataDir, "aidlc-stamp.json");
  if (!existsSync(harnessPath) && !existsSync(stampPath)) return null;

  try {
    // The immutable projection stamp is authoritative. harness.json is mutable
    // plugin-selection state, so malformed contents must not hide an otherwise
    // identifiable stamped install.
    const markerPath = existsSync(stampPath) ? stampPath : harnessPath;
    const marker = markerRecord(markerPath);
    if (marker.harnessDir !== harnessDir) {
      throw new Error(`${markerPath}: harness metadata identity is invalid`);
    }

    // Releases before projection stamps shipped only harnessDir + rulesSubdir.
    // Keep those trees identifiable so init can adopt and rewrite them.
    const legacy = !existsSync(stampPath) && marker.schemaVersion === undefined;
    const distribution = legacy
      ? legacyDistribution(harnessDir)
      : marker.distribution;
    if (
      (!legacy && marker.schemaVersion !== 1) ||
      typeof distribution !== "string" ||
      !/^[a-z0-9][a-z0-9-]*$/.test(distribution)
    ) {
      throw new Error(`${markerPath}: harness metadata identity is invalid`);
    }
    const frameworkVersion = marker.frameworkVersion;
    if (
      existsSync(stampPath) &&
      (typeof frameworkVersion !== "string" || !FRAMEWORK_VERSION.test(frameworkVersion))
    ) {
      throw new Error(`${stampPath}: frameworkVersion must be a release version id`);
    }
    return {
      root,
      harnessDir,
      distribution,
      ...(typeof frameworkVersion === "string" ? { frameworkVersion } : {}),
    };
  } catch (error) {
    if (strict) throw error;
    return null;
  }
}

export function discoverProjectHarnesses(projectDir: string): ProjectHarness[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(projectDir, { withFileTypes: true });
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return [];
    throw error;
  }
  const priority = (name: string): number => {
    const index = HARNESS_PRECEDENCE.indexOf(name as typeof HARNESS_PRECEDENCE[number]);
    return index < 0 ? HARNESS_PRECEDENCE.length : index;
  };
  const harnesses: ProjectHarness[] = [];
  for (
    const entry of entries.sort((left, right) =>
      priority(left.name) - priority(right.name) || left.name.localeCompare(right.name)
    )
  ) {
    if (!entry.isDirectory()) continue;
    const identity = harnessIdentity(join(projectDir, entry.name));
    if (identity) harnesses.push(identity);
  }
  return harnesses;
}

export function isCompiledModuleUrl(url: string): boolean {
  return /\/(?:\$bunfs|%7ebun|~bun)\//i.test(url.replace(/\\/g, "/"));
}

export function isCompiledExecutable(
  moduleUrl = import.meta.url,
  executable = process.execPath,
): boolean {
  const executableName = basename(executable.replace(/\\/g, "/")).toLowerCase();
  return isCompiledModuleUrl(moduleUrl) || !executableName.startsWith("bun");
}

export function compiledExecutable(
  moduleUrl = import.meta.url,
  executable = process.execPath,
): string | null {
  const explicit = process.env.AIDLC_COMPILED_EXECUTABLE?.trim();
  if (explicit) return explicit;
  return isCompiledExecutable(moduleUrl, executable) ? executable : null;
}

export function aidlcInvocation(): string {
  if (isCompiledExecutable()) return "aidlc";
  if (!PROJECTED_INVOKE.startsWith("{{")) return PROJECTED_INVOKE;
  return `bun ${runtimeHarnessDir()}/tools/aidlc.ts`;
}

export function aidlcDispatcherInvocation(route: string): string {
  return `${aidlcInvocation()} engine ${route}`;
}

export function aidlcToolInvocation(
  route: string,
  sourceTool?: string,
  qualifiedSource = true,
): string {
  const invoke = aidlcInvocation();
  if (!invoke.startsWith("bun ")) return aidlcDispatcherInvocation(route);
  const tool = sourceTool ??
    route.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
  const path = qualifiedSource
    ? `${runtimeHarnessDir()}/tools/aidlc-${tool}.ts`
    : `aidlc-${tool}.ts`;
  return `bun ${path}`;
}

function explicitRuntimeProjectDir(): string | null {
  const internal = process.env.AIDLC_RUNTIME_PROJECT_DIR;
  if (internal) {
    return isAbsolute(internal) ? internal : resolve(process.cwd(), internal);
  }
  const argv = process.argv.slice(1);
  const index = argv.indexOf("--project-dir");
  if (index >= 0 && argv[index + 1] && !argv[index + 1].startsWith("--")) {
    return isAbsolute(argv[index + 1])
      ? argv[index + 1]
      : resolve(process.cwd(), argv[index + 1]);
  }
  const explicit = process.env.AIDLC_PROJECT_DIR ??
    process.env.CLAUDE_PROJECT_DIR ?? process.env.KIRO_PROJECT_DIR;
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

  return discoverProjectHarnesses(projectDir)[0]?.harnessDir ?? ".claude";
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
