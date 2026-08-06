#!/usr/bin/env bun
// scripts/install.ts — Interactive harness installer for AI-DLC.
//
// Copies the pre-built dist/<harness>/ tree into a target project directory,
// prompting for harness selection when not supplied via CLI flags.
//
// Usage:
//   bun scripts/install.ts                           # interactive mode (cwd)
//   bun scripts/install.ts --harness kiro            # skip picker, install to cwd
//   bun scripts/install.ts --target ~/my-project     # install to a specific dir
//   bun scripts/install.ts --harness claude --target ./app --force
//   bun scripts/install.ts --doctor                  # run post-install validation
//   bun scripts/install.ts --help

import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { AIDLC_VERSION } from "../core/tools/aidlc-version.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const SCRIPT_DIR = import.meta.dirname ?? join(fileURLToPath(import.meta.url), "..");
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
const DIST_ROOT = join(REPO_ROOT, "dist");

// ANSI — minimal, matching core/hooks/aidlc-statusline.ts conventions.
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";

const NO_COLOR = !!process.env.NO_COLOR;
const c = (code: string, text: string): string => (NO_COLOR ? text : `${code}${text}${RESET}`);

// Harness display names for the interactive picker.
const HARNESS_LABELS: Record<string, string> = {
  claude: "Claude Code",
  kiro: "Kiro CLI",
  "kiro-ide": "Kiro IDE",
  codex: "Codex CLI",
  opencode: "opencode",
};

// How to invoke the workflow per harness (shown in "what's next" guidance).
const HARNESS_INVOKE: Record<string, string> = {
  claude: "/aidlc",
  kiro: "/aidlc",
  "kiro-ide": "/aidlc",
  codex: "$aidlc",
  opencode: "/aidlc",
};

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/** Expand leading ~ to the user's home directory (shell doesn't do this for us). */
function expandTilde(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return join(homedir(), p.slice(2));
  return p;
}

/**
 * Validate and sanitize a target path. Guards against:
 * - Null bytes (filesystem injection)
 * - Excessively long paths (DoS / buffer issues)
 * - Non-printable / control characters
 */
function validateTargetPath(raw: string): string {
  // Reject null bytes — filesystem APIs may truncate at \0
  if (raw.includes("\0")) {
    console.error("Error: target path contains null bytes.");
    process.exit(1);
  }
  // Reject control characters (except normal whitespace in paths on Windows)
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional — validating user input for path safety
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(raw)) {
    console.error("Error: target path contains invalid control characters.");
    process.exit(1);
  }
  // Reject excessively long paths (common OS limit is ~4096)
  if (raw.length > 4096) {
    console.error("Error: target path is too long (max 4096 characters).");
    process.exit(1);
  }
  return raw;
}

/**
 * Validate a harness name. Only alphanumeric + hyphens allowed.
 * This runs BEFORE the harnesses.includes() check to prevent any path
 * construction with unsanitized values.
 */
function validateHarnessName(name: string): string {
  if (!/^[a-z][a-z0-9-]*$/.test(name)) {
    console.error(`Error: invalid harness name "${name}". Only lowercase letters, numbers, and hyphens allowed.`);
    process.exit(1);
  }
  if (name.length > 64) {
    console.error("Error: harness name too long.");
    process.exit(1);
  }
  return name;
}

/**
 * Detect the installed AI-DLC version in a target directory for a SPECIFIC
 * harness by reading its .aidlc-install.json metadata file, falling back to
 * parsing aidlc-version.ts for legacy installs.
 */
function detectInstalledVersion(target: string, harness: string): string | null {
  const dir = harnessProjectDir(harness);
  if (!dir) return null;
  const harnessPath = join(target, dir);
  if (!existsSync(harnessPath)) return null;

  // 1. Try metadata file (definitive)
  const meta = readInstallMeta(join(harnessPath, ".aidlc-install.json"));
  if (meta && meta.harness === harness) return meta.version;
  // Metadata says a different harness owns this dir (e.g. kiro-ide owns .kiro/)
  if (meta && meta.harness !== harness) return null;

  // 2. Fallback: parse aidlc-version.ts
  return readVersionFromFile(join(harnessPath, "tools", "aidlc-version.ts"));
}

/** Install metadata shape written to <harnessDir>/.aidlc-install.json */
interface InstallMeta {
  harness: string;
  version: string;
  installedAt: string;
}

/** Read and parse the install metadata file. Returns null if missing/unreadable. */
function readInstallMeta(metaPath: string): InstallMeta | null {
  if (!existsSync(metaPath)) return null;
  try {
    const raw = JSON.parse(readFileSync(metaPath, "utf-8"));
    if (typeof raw.harness === "string" && typeof raw.version === "string") {
      return raw as InstallMeta;
    }
  } catch { /* malformed — treat as absent */ }
  return null;
}

/** Write the install metadata file after a successful install. */
function writeInstallMeta(target: string, harness: string): void {
  const dir = harnessProjectDir(harness);
  if (!dir) return;
  const metaPath = join(target, dir, ".aidlc-install.json");
  const meta: InstallMeta = {
    harness,
    version: AIDLC_VERSION,
    installedAt: new Date().toISOString(),
  };
  try {
    writeFileSync(metaPath, JSON.stringify(meta, null, 2) + "\n");
  } catch { /* non-fatal — install succeeded, metadata is convenience */ }
}

/** Read AIDLC_VERSION from an aidlc-version.ts file. */
function readVersionFromFile(filePath: string): string | null {
  if (!existsSync(filePath)) return null;
  try {
    const content = readFileSync(filePath, "utf-8");
    const match = content.match(/AIDLC_VERSION\s*=\s*"([^"]+)"/);
    if (match) return match[1];
  } catch { /* unreadable */ }
  return null;
}

/** Map harness name → the directory it uses in the project. */
function harnessProjectDir(harness: string): string | null {
  const map: Record<string, string> = {
    claude: ".claude",
    kiro: ".kiro",
    "kiro-ide": ".kiro",
    codex: ".codex",
    opencode: ".aidlc",
  };
  return map[harness] ?? null;
}

/**
 * For .kiro/ directory, determine if it's a kiro CLI or kiro-ide install
 * using heuristics (presence of .kiro.hook files = kiro-ide).
 */
function detectKiroVariant(target: string): "kiro" | "kiro-ide" {
  const hooksDir = join(target, ".kiro", "hooks");
  if (!existsSync(hooksDir)) return "kiro";
  try {
    const files = readdirSync(hooksDir);
    // kiro-ide ships .kiro.hook legacy files; kiro CLI does not
    if (files.some((f) => f.endsWith(".kiro.hook"))) return "kiro-ide";
  } catch { /* unreadable */ }
  return "kiro";
}

/** Scan a target directory for ALL existing AI-DLC harness installations. */
function detectAllInstallations(target: string): Array<{ harness: string; version: string }> {
  // Each unique harness dir to scan (deduplicated — .kiro/ scanned once)
  const scanDirs: Array<{ dir: string; defaultHarness: string }> = [
    { dir: ".claude", defaultHarness: "claude" },
    { dir: ".kiro", defaultHarness: "kiro" },
    { dir: ".codex", defaultHarness: "codex" },
    { dir: ".aidlc", defaultHarness: "opencode" },
  ];
  const results: Array<{ harness: string; version: string }> = [];

  for (const { dir, defaultHarness } of scanDirs) {
    const harnessPath = join(target, dir);
    if (!existsSync(harnessPath)) continue;

    // 1. Try metadata (definitive harness identity)
    const meta = readInstallMeta(join(harnessPath, ".aidlc-install.json"));
    if (meta) {
      results.push({ harness: meta.harness, version: meta.version });
      continue;
    }

    // 2. Fallback: version from file + heuristic for kiro/kiro-ide
    const version = readVersionFromFile(join(harnessPath, "tools", "aidlc-version.ts"));
    if (!version) continue;

    let harness = defaultHarness;
    if (dir === ".kiro") {
      harness = detectKiroVariant(target);
    }
    results.push({ harness, version });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Harness discovery (from committed dist/, not from harness/ manifests — the
// installer works on the pre-built output so it doesn't need bun imports of
// manifest.ts or core/).
// ---------------------------------------------------------------------------
function discoverHarnesses(): string[] {
  if (!existsSync(DIST_ROOT)) return [];
  return readdirSync(DIST_ROOT)
    .filter((name) => {
      if (name === "plugins" || name.startsWith(".")) return false;
      const p = join(DIST_ROOT, name);
      return statSync(p).isDirectory();
    })
    .sort();
}

/** List the entries that dist/<harness>/ will copy (for preview and conflict detection). */
function harnessEntries(harness: string): string[] {
  const srcDir = join(DIST_ROOT, harness);
  if (!existsSync(srcDir)) return [];
  return readdirSync(srcDir).filter((e) => !e.startsWith(".DS_Store"));
}

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------
interface CliArgs {
  harness: string | null;
  target: string;
  force: boolean;
  all: boolean;
  doctor: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    harness: null,
    target: process.cwd(),
    force: false,
    all: false,
    doctor: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--harness":
        args.harness = argv[++i] ?? null;
        if (args.harness) args.harness = validateHarnessName(args.harness);
        break;
      case "--target":
      case "-t":
        args.target = argv[++i] ?? process.cwd();
        break;
      case "--force":
      case "-f":
        args.force = true;
        break;
      case "--all":
        args.all = true;
        break;
      case "--doctor":
      case "-d":
        args.doctor = true;
        break;
      case "--help":
        args.help = true;
        break;
      default:
        console.error(`Unknown argument: ${arg}`);
        process.exit(1);
    }
  }

  // Validate: --all and --harness are mutually exclusive
  if (args.all && args.harness) {
    console.error("Error: --all and --harness cannot be used together.");
    process.exit(1);
  }

  args.target = resolve(expandTilde(validateTargetPath(args.target)));
  return args;
}

// ---------------------------------------------------------------------------
// Interactive prompts — numbered-option style matching the orchestrator's
// question-rendering annex (bold header, numbered options, "Reply with a number
// or just tell me").
// ---------------------------------------------------------------------------
function createReadline() {
  return createInterface({ input: process.stdin, output: process.stdout });
}

async function promptChoice(question: string, choices: string[], labels?: Record<string, string>): Promise<string> {
  const rl = createReadline();

  process.stdout.write(`\n${c(BOLD, question)}\n\n`);
  for (let i = 0; i < choices.length; i++) {
    const label = labels?.[choices[i]] ?? choices[i];
    const num = c(CYAN, `${i + 1}.`);
    const name = c(BOLD, choices[i]);
    const desc = label !== choices[i] ? c(DIM, ` \u2014 ${label}`) : "";
    process.stdout.write(`  ${num} ${name}${desc}\n`);
  }
  process.stdout.write("\n");

  return new Promise((resolvePrompt) => {
    const ask = () => {
      rl.question(`${c(DIM, "  Reply with a number or name:")} `, (answer) => {
        const trimmed = answer.trim();
        // Accept by number
        const num = Number.parseInt(trimmed, 10);
        if (num >= 1 && num <= choices.length) {
          rl.close();
          resolvePrompt(choices[num - 1]);
          return;
        }
        // Accept by name (case-insensitive)
        const match = choices.find((ch) => ch.toLowerCase() === trimmed.toLowerCase());
        if (match) {
          rl.close();
          resolvePrompt(match);
          return;
        }
        process.stdout.write(`  ${c(YELLOW, "\u2717")} Invalid choice. Enter 1\u2013${choices.length} or a harness name.\n`);
        ask();
      });
    };
    ask();
  });
}

async function promptConfirm(question: string, defaultYes = true): Promise<boolean> {
  const rl = createReadline();
  const hint = defaultYes ? c(DIM, "[Y/n]") : c(DIM, "[y/N]");
  return new Promise((resolvePrompt) => {
    rl.question(`  ${question} ${hint} `, (answer) => {
      rl.close();
      const trimmed = answer.trim().toLowerCase();
      if (trimmed === "") {
        resolvePrompt(defaultYes);
      } else {
        resolvePrompt(trimmed === "y" || trimmed === "yes");
      }
    });
  });
}

async function promptInput(question: string, defaultValue: string): Promise<string> {
  const rl = createReadline();
  const hint = c(DIM, `(${defaultValue})`);
  return new Promise((resolvePrompt) => {
    rl.question(`  ${question} ${hint} `, (answer) => {
      rl.close();
      const trimmed = answer.trim();
      resolvePrompt(trimmed || defaultValue);
    });
  });
}

// ---------------------------------------------------------------------------
// File operations
// ---------------------------------------------------------------------------

/**
 * Recursively copy files from src to dst, but NEVER overwrite existing files.
 * New files are added; existing files are preserved. This is the safe merge
 * strategy for the aidlc/ workspace shell — user-generated state (intents,
 * audit, codekb) and user-edited memory (team.md, project.md) must survive
 * a --force reinstall.
 */
function copyMergeNoClobber(src: string, dst: string): void {
  mkdirSync(dst, { recursive: true });
  for (const entry of readdirSync(src)) {
    if (entry === ".DS_Store") continue;
    const srcPath = join(src, entry);
    const dstPath = join(dst, entry);
    const stat = statSync(srcPath);
    if (stat.isDirectory()) {
      copyMergeNoClobber(srcPath, dstPath);
    } else {
      if (!existsSync(dstPath)) {
        cpSync(srcPath, dstPath);
      }
    }
  }
}

function copyDistTree(harness: string, target: string, force: boolean): { copied: string[]; skipped: string[] } {
  const srcDir = join(DIST_ROOT, harness);
  if (!existsSync(srcDir)) {
    console.error(`Error: dist/${harness}/ does not exist. Run 'bun scripts/package.ts' first.`);
    process.exit(1);
  }

  const entries = readdirSync(srcDir).filter((e) => !e.startsWith(".DS_Store"));
  const copied: string[] = [];
  const skipped: string[] = [];

  for (const entry of entries) {
    const src = join(srcDir, entry);
    const dst = join(target, entry);

    // The aidlc/ workspace shell contains user project data (state, intents,
    // audit, user-edited memory). ALWAYS merge without clobbering — even with
    // --force — so user data is never destroyed. New framework files from
    // newer versions still get added.
    if (entry === "aidlc") {
      if (existsSync(dst)) {
        copyMergeNoClobber(src, dst);
        copied.push(`${entry} (merged, user data preserved)`);
      } else {
        cpSync(src, dst, { recursive: true });
        copied.push(entry);
      }
      continue;
    }

    // The .gitignore shipped with the harness contains AI-DLC-specific patterns.
    // If the user already has a .gitignore, back it up before replacing.
    if (entry === ".gitignore") {
      if (existsSync(dst)) {
        const backupPath = join(target, ".gitignore.bak");
        cpSync(dst, backupPath, { force: true });
        cpSync(src, dst, { force: true });
        copied.push(`${entry} ${c(DIM, "(old saved as .gitignore.bak)")}`);
      } else {
        cpSync(src, dst);
        copied.push(entry);
      }
      continue;
    }

    if (existsSync(dst) && !force) {
      skipped.push(entry);
      continue;
    }

    const stat = statSync(src);
    if (stat.isDirectory()) {
      cpSync(src, dst, { recursive: true, force: true });
    } else {
      mkdirSync(join(target), { recursive: true });
      cpSync(src, dst, { force: true });
    }
    copied.push(entry);
  }

  return { copied, skipped };
}

// ---------------------------------------------------------------------------
// Post-install doctor
// ---------------------------------------------------------------------------
function runDoctor(target: string): boolean {
  const possiblePaths = [
    join(target, ".claude", "tools", "aidlc-utility.ts"),
    join(target, ".kiro", "tools", "aidlc-utility.ts"),
    join(target, ".codex", "tools", "aidlc-utility.ts"),
    join(target, ".aidlc", "tools", "aidlc-utility.ts"),
  ];

  const utilityPath = possiblePaths.find(existsSync);
  if (!utilityPath) {
    process.stdout.write(`  ${c(YELLOW, "\u2717")} Could not locate aidlc-utility.ts for --doctor check.\n`);
    process.stdout.write(`    Run '/aidlc --doctor' manually inside your harness session.\n`);
    return false;
  }

  process.stdout.write(`\n  Running post-install doctor...\n\n`);
  const result = spawnSync("bun", [utilityPath, "doctor"], {
    cwd: target,
    stdio: "inherit",
    env: { ...process.env, AIDLC_PROJECT_DIR: target },
  });

  return result.status === 0;
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------
function printHelp(): void {
  const harnesses = discoverHarnesses();
  process.stdout.write(`
${c(BOLD, "AI-DLC Installer")} ${c(DIM, `v${AIDLC_VERSION}`)}
${"─".repeat(37)}

Usage:
  bun scripts/install.ts [options]

Options:
  --harness <name>   Harness to install (${harnesses.join(", ")})
  --target <dir>     Target project directory (default: current directory)
  --force            Overwrite existing files without prompting
  --all              Update all existing harness installations in the target
  --doctor           Run post-install validation (aidlc --doctor)
  --help             Show this help message

Examples:
  bun scripts/install.ts                                # interactive mode
  bun scripts/install.ts --harness kiro                 # install kiro to cwd
  bun scripts/install.ts --harness claude --target ./app --force
  bun scripts/install.ts --target ./app --all --force   # update all harnesses
  bun scripts/install.ts --harness codex --doctor
\n`);
}

// ---------------------------------------------------------------------------
// Install one harness into a target directory. Returns copied/skipped counts.
// ---------------------------------------------------------------------------
async function installHarness(
  harness: string,
  target: string,
  force: boolean,
  interactive: boolean,
): Promise<{ copied: string[]; skipped: string[] }> {
  // --- Kiro/kiro-ide migration: detect if .kiro/ belongs to the other variant ---
  const dir = harnessProjectDir(harness);
  if (dir === ".kiro" && existsSync(join(target, ".kiro"))) {
    const meta = readInstallMeta(join(target, ".kiro", ".aidlc-install.json"));
    const existingVariant = meta?.harness ?? detectKiroVariant(target);
    if (existingVariant !== harness) {
      process.stdout.write(`  ${c(CYAN, "\u2191")} Migrating: ${existingVariant} \u2192 ${harness} (replacing .kiro/)\n`);
      rmSync(join(target, ".kiro"), { recursive: true, force: true });
    }
  }

  // --- Version info (always shown) ---
  const installedVersion = detectInstalledVersion(target, harness);
  if (installedVersion) {
    if (installedVersion === AIDLC_VERSION) {
      process.stdout.write(`  ${c(GREEN, "\u2713")} ${harness}: already at v${AIDLC_VERSION}\n`);
    } else {
      process.stdout.write(`  ${c(CYAN, "\u2191")} ${harness}: v${installedVersion} \u2192 v${AIDLC_VERSION}\n`);
    }
  }

  // --- Unified file plan: show what will happen to each entry ---
  const entries = harnessEntries(harness);
  let effectiveForce = force;
  const hasConflicts = entries.some((e) => e !== "aidlc" && e !== ".gitignore" && existsSync(join(target, e)));

  if (interactive && !effectiveForce && hasConflicts) {
    process.stdout.write("\n");
    for (const e of entries) {
      const dst = join(target, e);
      if (e === "aidlc") {
        const tag = existsSync(dst) ? c(DIM, "merge") : c(DIM, "new");
        process.stdout.write(`  ${c(GREEN, "\u2022")} ${e}  ${tag}\n`);
      } else if (e === ".gitignore" && existsSync(dst)) {
        process.stdout.write(`  ${c(GREEN, "\u2022")} ${e}  ${c(DIM, "backup + replace")}\n`);
      } else if (existsSync(dst)) {
        process.stdout.write(`  ${c(YELLOW, "\u2022")} ${e}  ${c(YELLOW, "overwrite")}\n`);
      } else {
        process.stdout.write(`  ${c(GREEN, "\u2022")} ${e}  ${c(DIM, "new")}\n`);
      }
    }
    const overwrite = await promptConfirm("\n  Overwrite existing files?", false);
    if (overwrite) effectiveForce = true;
  }

  // --- Copy ---
  return copyDistTree(harness, target, effectiveForce || force);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  const cliArgs = parseArgs(process.argv.slice(2));

  if (cliArgs.help) {
    printHelp();
    process.exit(0);
  }

  const harnesses = discoverHarnesses();
  if (harnesses.length === 0) {
    console.error("Error: No harnesses found in dist/. Run 'bun scripts/package.ts' to build first.");
    process.exit(1);
  }

  const interactive = !cliArgs.harness && !cliArgs.all;

  // --- Banner (interactive only) ---
  if (interactive) {
    process.stdout.write(`\n${c(BOLD, `AI-DLC Installer`)} ${c(DIM, `v${AIDLC_VERSION}`)}\n`);
    process.stdout.write(`${"─".repeat(37)}\n`);
    process.stdout.write(`${c(DIM, "Set up the AI-DLC workflow engine in your project.")}\n`);
  }

  // --- Target directory (ask early so we can scan for existing installs) ---
  let target = cliArgs.target;
  let force = cliArgs.force;
  if (interactive) {
    process.stdout.write(`\n${c(DIM, "  Press Enter to use the current directory.")}\n`);
    const raw = await promptInput("  Target project directory?", target);
    target = resolve(expandTilde(validateTargetPath(raw)));
  }
  if (!existsSync(target)) {
    mkdirSync(target, { recursive: true });
    process.stdout.write(`  ${c(GREEN, "\u2713")} Created ${target}\n`);
  }

  // --- Detect existing installations ---
  const existing = detectAllInstallations(target);
  const outdated = existing.filter((e) => e.version !== AIDLC_VERSION);

  // Decide what to install based on existing state + user choice
  let harnessesToInstall: string[] = [];

  if (interactive && existing.length > 0) {
    // Show existing installations (compact)
    const existingSummary = existing.map((inst) => {
      const status = inst.version === AIDLC_VERSION ? c(GREEN, "current") : c(YELLOW, `v${inst.version}`);
      return `${inst.harness} (${status})`;
    }).join(", ");
    process.stdout.write(`\n  ${c(BOLD, "Existing:")} ${existingSummary}\n`);

    if (outdated.length > 0) {
      // Build options
      const updateLabel = outdated.length === 1
        ? `Update ${outdated[0].harness} to v${AIDLC_VERSION}`
        : `Update all (${outdated.map((e) => e.harness).join(", ")}) to v${AIDLC_VERSION}`;
      const options = [
        updateLabel,
        "Install a different harness",
        `Both \u2014 update existing + install new`,
      ];
      const choice = await promptChoice("What would you like to do?", options);

      if (choice === options[0]) {
        harnessesToInstall = outdated.map((e) => e.harness);
        force = true;
      } else if (choice === options[1]) {
        const available = harnesses.filter((h) => !existing.some((e) => e.harness === h));
        if (available.length === 0) {
          process.stdout.write(`\n  ${c(YELLOW, "!")} All available harnesses are already installed.\n\n`);
          process.exit(0);
        }
        const picked = await promptChoice("Which harness?", available, HARNESS_LABELS);
        harnessesToInstall = [picked];
      } else {
        const available = harnesses.filter((h) => !existing.some((e) => e.harness === h));
        if (available.length === 0) {
          harnessesToInstall = outdated.map((e) => e.harness);
        } else {
          const picked = await promptChoice("Which new harness?", available, HARNESS_LABELS);
          harnessesToInstall = [...outdated.map((e) => e.harness), picked];
        }
        force = true;
      }
    } else {
      // All current — offer to install a new one
      const available = harnesses.filter((h) => !existing.some((e) => e.harness === h));
      if (available.length === 0) {
        process.stdout.write(`  ${c(GREEN, "\u2713")} All harnesses installed and current. Nothing to do.\n\n`);
        process.exit(0);
      }
      const picked = await promptChoice("Install a new harness?", available, HARNESS_LABELS);
      harnessesToInstall = [picked];
    }
  } else if (interactive) {
    // No existing installations — normal harness picker
    process.stdout.write(`${c(DIM, "  Choose the harness that matches your coding tool:")}\n`);
    const picked = await promptChoice("Which harness do you want to install?", harnesses, HARNESS_LABELS);
    harnessesToInstall = [picked];
  } else if (cliArgs.all) {
    // --all: update every existing installation in the target
    const existing = detectAllInstallations(target);
    if (existing.length === 0) {
      console.error("Error: --all specified but no existing AI-DLC installation found in target.");
      process.exit(1);
    }
    const outdatedAll = existing.filter((e) => e.version !== AIDLC_VERSION);
    if (outdatedAll.length === 0) {
      process.stdout.write(`${c(GREEN, "\u2713")} All ${existing.length} harness(es) already at v${AIDLC_VERSION}. Nothing to update.\n\n`);
      process.exit(0);
    }
    harnessesToInstall = outdatedAll.map((e) => e.harness);
    force = true;
  } else {
    // Non-interactive: use --harness flag
    const harness = cliArgs.harness!;
    if (!harnesses.includes(harness)) {
      console.error(`Error: Unknown harness "${harness}". Available: ${harnesses.join(", ")}`);
      process.exit(1);
    }
    harnessesToInstall = [harness];
  }

  // --- Install header ---
  const harnessLabel = harnessesToInstall.map((h) => `${h}`).join(", ");
  process.stdout.write(`\n${c(DIM, `Installing ${harnessLabel} \u2192 ${target}`)}\n`);

  // --- Install each harness ---
  let totalCopied = 0;
  let totalSkipped = 0;
  let gitignoreBackedUp = false;

  for (const h of harnessesToInstall) {
    if (harnessesToInstall.length > 1) {
      process.stdout.write(`  ${c(BOLD, `[${h}]`)}\n`);
    }
    const { copied, skipped } = await installHarness(h, target, force, interactive);
    if (copied.some((c) => c.includes(".gitignore.bak"))) gitignoreBackedUp = true;
    for (const entry of copied) {
      process.stdout.write(`  ${c(GREEN, "\u2713")} ${entry}\n`);
    }
    for (const entry of skipped) {
      process.stdout.write(`  ${c(YELLOW, "\u2717")} ${entry} ${c(DIM, "(exists, use --force)")}\n`);
    }
    totalCopied += copied.length;
    totalSkipped += skipped.length;

    // Write install metadata after successful copy
    if (copied.length > 0) {
      writeInstallMeta(target, h);
    }

    if (harnessesToInstall.length > 1 && h !== harnessesToInstall[harnessesToInstall.length - 1]) {
      process.stdout.write("\n");
    }
  }

  // --- Result ---
  process.stdout.write(`\n${"─".repeat(37)}\n`);
  if (totalCopied > 0 && totalSkipped === 0) {
    process.stdout.write(`${c(GREEN, "\u2713")} Installation complete \u2014 ${totalCopied} item(s) copied.\n`);
  } else if (totalCopied > 0) {
    process.stdout.write(`${c(GREEN, "\u2713")} ${totalCopied} copied, ${c(YELLOW, `${totalSkipped} skipped`)}\n`);
  } else {
    process.stdout.write(`${c(YELLOW, "\u2717")} All files already exist. Re-run with --force to overwrite.\n`);
  }

  // --- Post-install notes ---
  if (gitignoreBackedUp) {
    process.stdout.write(`\n${c(YELLOW, "Note:")} Your original .gitignore was saved as .gitignore.bak.\n`);
    process.stdout.write(`  ${c(DIM, "Merge your custom entries back into the new .gitignore.")}\n`);
  }
  if (harnessesToInstall.includes("codex")) {
    process.stdout.write(`\n${c(YELLOW, "Note:")} Codex requires hook trust pre-seeding.\n`);
    process.stdout.write(`  bun scripts/package.ts codex trust --project ${target}\n`);
    process.stdout.write(`  ${c(DIM, "See docs/guide/harnesses/codex-cli.md")}\n`);
  }

  // --- What's next ---
  if (totalCopied > 0) {
    const lastHarness = harnessesToInstall[harnessesToInstall.length - 1];
    const invoke = HARNESS_INVOKE[lastHarness] ?? "/aidlc";
    process.stdout.write(`\n${c(BOLD, "What\u2019s next:")}\n`);
    if (target !== process.cwd()) {
      process.stdout.write(`  cd ${target}\n`);
    }
    process.stdout.write(`  Open your project in ${HARNESS_LABELS[lastHarness] ?? lastHarness}, then run:\n`);
    process.stdout.write(`  ${c(CYAN, `${invoke} --doctor`)}     ${c(DIM, "verify the install")}\n`);
    process.stdout.write(`  ${c(CYAN, `${invoke} <description>`)} ${c(DIM, "start a workflow")}\n`);
  }

  // --- Doctor ---
  if (cliArgs.doctor) {
    runDoctor(target);
  }

  process.stdout.write("\n");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
