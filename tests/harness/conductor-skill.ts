import { readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// The files each harness's /aidlc conductor skill is made of, SKILL.md first,
// all in one folder. Kiro loads at most 50,000 characters from one agent
// resource file, so the Kiro row's skill (`kiro-ide`) goes on in workflow.md.
// tests/harness/harness-matrix.ts checks every harness has an entry and that
// its manifest ships each file.
export const CONDUCTOR_SKILL_FILES = {
  claude: ["SKILL.md"],
  codex: ["SKILL.md"],
  copilot: ["SKILL.md"],
  cursor: ["SKILL.md"],
  "kiro-ide": ["SKILL.md", "workflow.md"],
  kiro: ["SKILL.md"],
  opencode: ["SKILL.md"],
} as const satisfies Record<string, readonly string[]>;

export type ConductorSkillHarness = keyof typeof CONDUCTOR_SKILL_FILES;

/** The file names of a harness's conductor skill, SKILL.md first; a name with no entry has SKILL.md alone. */
export function conductorSkillFileNames(name: string): readonly string[] {
  return Object.hasOwn(CONDUCTOR_SKILL_FILES, name) ? CONDUCTOR_SKILL_FILES[name as ConductorSkillHarness] : ["SKILL.md"];
}

/** The conductor skill's files in `skillDir`, in the order the agent reads them. */
export function conductorSkillPaths(name: ConductorSkillHarness, skillDir: string): string[] {
  return CONDUCTOR_SKILL_FILES[name].map((file) => join(skillDir, file));
}

/** The conductor skill's whole text: every file of it, in order; a missing one throws. */
export function conductorSkillText(name: ConductorSkillHarness, skillDir: string): string {
  return conductorSkillPaths(name, skillDir).map((path) => readFileSync(path, "utf-8")).join("\n");
}

/**
 * A file's text, except that a conductor `skills/aidlc/SKILL.md` in an authored
 * harness (`harness/<name>/`) or a built tree (`dist/<name>/`,
 * `dist-release/<name>/`) reads as the whole skill. A relative path is from the
 * repository root.
 */
export function readConductorSurface(path: string): string {
  const absolute = isAbsolute(path) ? path : join(REPO_ROOT, path);
  const [root, name] = relative(REPO_ROOT, absolute).split(sep);
  const isSkill =
    basename(absolute) === "SKILL.md" &&
    basename(dirname(absolute)) === "aidlc" &&
    ["harness", "dist", "dist-release"].includes(root) &&
    Object.hasOwn(CONDUCTOR_SKILL_FILES, name);
  if (!isSkill) return readFileSync(absolute, "utf-8");
  return conductorSkillText(name as ConductorSkillHarness, dirname(absolute));
}
