import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { appendAuditEntry } from "./aidlc-audit.ts";
import {
  artifactsRegistry,
  findCycles,
  loadGraph,
  loadRules,
  validateScope,
} from "./aidlc-graph.ts";
import {
  auditFilePath,
  emitError,
  errorMessage,
  escapeRegex,
  findAllEvents,
  findStageBySlug,
  getField,
  isoTimestamp,
  isPackageJson,
  loadAgents,
  loadScopeMapping,
  loadStageGraph,
  MERGE_SUCCEEDED_TAG_REGEX,
  nextInScopeStage,
  PHASES,
  parseArgs,
  parseCheckboxes,
  parseRefsList,
  parseStageFrontmatter,
  readStateFile,
  resolveProjectDir,
  SLUG_TAG_REGEX,
  type StageEntry,
  setCheckbox,
  setField,
  stagesInScope,
  stateFilePath,
  validateBoltSlug,
  validScopes,
  worktreePath,
  writeStateFile,
  harnessDir,
  rulesSubdir,
} from "./aidlc-lib.ts";
import { validateStageFrontmatter } from "./aidlc-stage-schema.ts";
import { AIDLC_VERSION } from "./aidlc-version.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TOOLS_DIR = dirname(fileURLToPath(import.meta.url));

const VALID_DEPTHS: Record<string, string> = {
  minimal: "Minimal",
  standard: "Standard",
  comprehensive: "Comprehensive",
};

const VALID_TEST_STRATEGIES: Record<string, string> = {
  minimal: "Minimal",
  standard: "Standard",
  comprehensive: "Comprehensive",
};

function die(msg: string): never {
  // Parse --project-dir from argv so ERROR_LOGGED lands in the correct workflow
  // even on errors raised BEFORE main() completes flag parsing. Fall back to
  // default resolution (env var / cwd) if absent.
  const args = process.argv.slice(2);
  const pdIdx = args.indexOf("--project-dir");
  const explicitPd = pdIdx !== -1 && pdIdx + 1 < args.length ? args[pdIdx + 1] : undefined;
  const pd = resolveProjectDir(explicitPd);
  const command = `aidlc-utility ${args.join(" ")}`.trim();
  emitError(pd, "aidlc-utility", command, msg);
}

// Thin wrapper around the canonical appendAuditEntry. All events must be in
// aidlc-audit.ts VALID_EVENT_TYPES. Throws on invalid event or audit failure —
// caller is expected to let that propagate (init failures should stop init).
function appendAuditEvent(
  projectDir: string,
  event: string,
  fields: Record<string, string>
): void {
  appendAuditEntry(event, fields, projectDir);
}

// ---------------------------------------------------------------------------
// help
// ---------------------------------------------------------------------------
//
// HELP_TEXT is no longer a static constant — the scopes block renders
// from loadScopeMapping() so stage counts stay fresh by construction.
// Previously hardcoded counts drifted as scopes evolved; sourcing from
// the live mapping makes that impossible.

const HELP_TEXT_HEAD = `AI-DLC — AI-Driven Development Life Cycle

Usage: /aidlc [command]

Scopes (set depth, test strategy, and stage count):
`;

const HELP_TEXT_TAIL = `
Utilities:
  --status          Show current workflow progress (read-only)
  --init            Run the Initialization phase (scaffold dirs, detect workspace, init state). Defaults to --scope poc.
  --force           Reinitialize even if aidlc-state.md already exists (pairs with --init)
  --doctor          Run health check on hooks, settings, and directory structure
  --stage <id>      Jump to a specific stage (by slug or number, e.g., code-generation or 3.5)
  --phase <name>    Jump to the first in-scope stage of a phase (e.g., construction or 3)
  --scope <scope>   Set or change scope (standalone or with --stage/--phase)
  --depth <level>   Override depth (minimal, standard, comprehensive)
  --test-strategy <level>  Override test strategy (minimal, standard, comprehensive)
  --version         Show the framework version
  --help            Show this help message

Other:
  --test-run        Auto-approve all gates (for automated testing only)
  <description>     Describe what to build — scope is auto-detected
  (no arguments)    Resume existing workflow, or start fresh if none exists

Examples:
  /aidlc feature                                Start a feature workflow
  /aidlc Fix the login timeout bug              Auto-detected as bugfix scope
  /aidlc                                        Resume or begin
  /aidlc --stage code-generation                Jump to code-generation stage
  /aidlc --phase construction --scope bugfix    Jump to construction with bugfix scope
  /aidlc --scope bugfix --depth comprehensive  Bugfix with comprehensive depth
  /aidlc --depth minimal                       Change depth of active workflow
  /aidlc --depth standard --test-strategy minimal  Full artifacts, minimal tests`;

/** Exported for t67 unit tests. */
export function renderHelpText(): string {
  const mapping = loadScopeMapping();
  const scopeLines = [...validScopes()].map((name) => {
    const def = mapping[name];
    const execute = Object.values(def.stages).filter((v) => v === "EXECUTE")
      .length;
    const total = Object.keys(def.stages).length;
    const depth = def.depth.toLowerCase();
    const ts = def.testStrategy
      ? `, ${def.testStrategy.toLowerCase()} test strategy`
      : "";
    const desc = def.description ? ` — ${def.description}` : "";
    const defaultMarker = name === "feature" ? " (default)" : "";
    const countStr =
      execute === total ? `All ${total} stages` : `${execute} of ${total} stages`;
    return `  ${name.padEnd(18)}${countStr}, ${depth} depth${ts}${defaultMarker}${desc}`;
  });
  // Blank line before HELP_TEXT_TAIL so the `Utilities:` header is visually
  // separated from the scope list.
  return `${HELP_TEXT_HEAD + scopeLines.join("\n")}\n${HELP_TEXT_TAIL}`;
}

function handleHelp(): void {
  process.stdout.write(`${renderHelpText()}\n`);
}

// ---------------------------------------------------------------------------
// version
// ---------------------------------------------------------------------------

function handleVersion(): void {
  process.stdout.write(`aidlc ${AIDLC_VERSION}\n`);
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

function handleStatus(projectDir: string): void {
  const sp = stateFilePath(projectDir);
  if (!existsSync(sp)) {
    process.stdout.write(
      `No active AI-DLC workflow found.

To get started:
  /aidlc --init       Scaffold the aidlc-docs/ directory tree
  /aidlc <scope>      Start a workflow (e.g., /aidlc feature)
  /aidlc --help       Show all commands and scopes
`
    );
    return;
  }

  const content = readFileSync(sp, "utf-8");
  const graph = loadStageGraph();

  // Extract key fields
  const project = getField(content, "Project") || "Unknown";
  const scope = getField(content, "Scope") || "Unknown";
  const phase = getField(content, "Lifecycle Phase") || "Unknown";
  const currentStage = getField(content, "Current Stage") || "Unknown";
  const status = getField(content, "Status") || "Unknown";
  const activeAgent = getField(content, "Active Agent") || "None";
  const lastCompleted = getField(content, "Last Completed Stage") || "None";
  const nextStage = getField(content, "Next Stage") || "None";

  // Find current stage number
  const currentEntry = graph.find((s) => s.slug === currentStage);
  const stageDisplay = currentEntry
    ? `${currentEntry.name} (${currentEntry.number})`
    : currentStage;

  // Gate awareness — when the current stage's checkbox is [?] or [R], the
  // user (not the LLM) is the blocker. Surface this explicitly in Status so
  // `/aidlc --status` answers "what's blocking this workflow?" correctly.
  const checkboxesAll = parseCheckboxes(content);
  const currentCheckbox = checkboxesAll.find((c) => c.slug === currentStage);
  let statusLine = status;
  if (currentCheckbox?.state === "awaiting-approval") {
    const displayName = currentEntry?.name ?? currentStage;
    statusLine = `Awaiting your approval on ${displayName}`;
  } else if (currentCheckbox?.state === "revising") {
    const displayName = currentEntry?.name ?? currentStage;
    const revisionCount = getField(content, "Revision Count");
    // If the Revision Count field is missing, omit the count rather than
    // render a literal "?" — state files authored before the field existed
    // would otherwise render "revision ? of 3".
    statusLine = revisionCount
      ? `Revising ${displayName} (revision ${revisionCount} of 3)`
      : `Revising ${displayName}`;
  } else if (currentCheckbox?.state === "completed" && status === "Running") {
    // Post-approve window: the stage was approved (→ [x]) but the orchestrator
    // hasn't called `advance` yet, so Current Stage still points here. Tell
    // the user honestly rather than showing "Running" on a completed stage.
    const displayName = currentEntry?.name ?? currentStage;
    statusLine = `${displayName} approved — ready to advance`;
  }

  // Checkbox counts — filter to in-scope stages when scope is known
  const checkboxes = parseCheckboxes(content);
  const inScopeInfo = stagesInScope(scope);
  const inScopeSlugs = new Set(
    inScopeInfo.filter((s) => s.action === "EXECUTE").map((s) => s.slug)
  );
  const scopedCheckboxes =
    scope !== "Unknown" && inScopeSlugs.size > 0
      ? checkboxes.filter((c) => inScopeSlugs.has(c.slug))
      : checkboxes;
  const total = scopedCheckboxes.length;
  const completed = scopedCheckboxes.filter((c) => c.state === "completed").length;
  const skipped = scopedCheckboxes.filter((c) => c.state === "skipped").length;
  const pct = total > 0 ? Math.round((completed / total) * 100) : 0;

  // Build phase progress bars
  const phaseLabels: Record<string, string> = {
    initialization: "INITIALIZATION",
    ideation: "IDEATION",
    inception: "INCEPTION",
    construction: "CONSTRUCTION",
    operation: "OPERATION",
  };

  let phaseProgress = "";
  for (const p of PHASES) {
    const phaseStages = graph.filter((s) => s.phase === p);
    const phaseSlugs = new Set(phaseStages.map((s) => s.slug));
    const phaseCheckboxes = scopedCheckboxes.filter((c) => phaseSlugs.has(c.slug));
    if (phaseCheckboxes.length === 0) continue;

    const bar = phaseCheckboxes
      .map((c) => {
        switch (c.state) {
          case "completed":
            return "\u2588";
          case "in-progress":
            return "\u2592";
          case "awaiting-approval":
            return "?";
          case "revising":
            return "R";
          case "skipped":
            return "S";
          default:
            return "\u2591";
        }
      })
      .join("");

    const done = phaseCheckboxes.filter(
      (c) => c.state === "completed"
    ).length;
    phaseProgress += `  ${(phaseLabels[p] || p).padEnd(16)} ${bar} ${done}/${phaseCheckboxes.length}\n`;
  }

  const output = `AI-DLC Workflow Status
==============================
Project:        ${project}
Scope:          ${scope}
Phase:          ${phase}
Current Stage:  ${stageDisplay}
Status:         ${statusLine}
Active Agent:   ${activeAgent}
Completion:     ${completed}/${total} stages (${pct}%)${skipped > 0 ? ` — ${skipped} skipped` : ""}

Phase Progress:
${phaseProgress}
Last Completed: ${lastCompleted}
Next Stage:     ${nextStage}
`;
  process.stdout.write(output);
}

// ---------------------------------------------------------------------------
// doctor
// ---------------------------------------------------------------------------

// Threshold (days) beyond which doctor flags practices as stale and prompts
// re-affirmation.
export const PRACTICES_STALENESS_DAYS = 90;

// MERGE_DISPATCH INVOKED-orphan window for advisory reconciliation. Window
// covers a generous LLM Task call budget (Haiku 30s + retry + parse).
export const MERGE_DISPATCH_TIMEOUT_SEC = 60;

function handleDoctor(projectDir: string): void {
  const results: Array<{ pass: boolean; label: string; fix?: string }> = [];
  const isWindows = process.platform === "win32";

  // 1. bun installed — check PATH (Bun.which handles Windows .exe suffix automatically)
  const bunHome = process.env.HOME ? join(process.env.HOME, ".bun", "bin", "bun") : "";
  const bunFound = Bun.which("bun") !== null || (bunHome !== "" && existsSync(bunHome));
  results.push({
    pass: bunFound,
    label: "bun installed (required for CLI tools and hooks)",
    fix: isWindows
      ? "install via `npm install -g bun` or `powershell -c \"irm bun.sh/install.ps1 | iex\"`"
      : "install via `curl -fsSL https://bun.sh/install | bash`",
  });

  // 2. Hook presence — every framework hook is TypeScript, run via bun (no
  // executable bit needed). The core hook bodies ship in EVERY harness tree; the
  // Kiro and Codex trees additionally carry an authored stdin adapter that wires
  // them up.
  const harness = harnessDir();
  if (harness === ".claude") {
    // Claude Code: the EXPECTED roster is the set of aidlc-*.ts hooks that
    // settings.json actually wires (its `hooks` event blocks + the `statusLine`
    // command) — that is the CONTRACT Claude Code will try to run. Each
    // expected hook's PRESENCE is then probed against the project's own
    // .claude/hooks/ directory. A hook wired in settings.json but missing on
    // disk is a real runtime breakage, and this surfaces it as a loud ✗.
    //
    // Why settings.json, not readdirSync of the hooks dir: doctor's normal
    // invocation derives projectDir from the tool's OWN location
    // (resolveProjectDir step 3), so the hooks dir IS the dir a roster would be
    // enumerated from — probing an enumerated-from-itself roster is tautological
    // (every hook trivially "present", a deleted hook silently absent from the
    // roster). Sourcing the expectation from settings.json instead means the
    // roster and the probe target genuinely diverge, so a missing hook is caught
    // in the real single-install path. It is also self-maintaining: wire a new
    // hook in settings.json and doctor checks it automatically (no hardcoded
    // list to drift — the old list named only 7 of the 10 shipped hooks).
    const settingsForHooks = join(projectDir, harness, "settings.json");
    let expectedHooks: string[] = [];
    let settingsReadable = true;
    try {
      const raw = readFileSync(settingsForHooks, "utf-8");
      // jq-free: collect every distinct aidlc-*.ts basename referenced anywhere
      // in settings.json (hook command paths like
      // "bun $CLAUDE_PROJECT_DIR/.claude/hooks/aidlc-audit-logger.ts" and the
      // statusLine command). Basename, not path, so the probe is dir-relative.
      const refs = new Set<string>();
      for (const m of raw.matchAll(/aidlc-[A-Za-z0-9_-]+\.ts/g)) {
        refs.add(m[0]);
      }
      expectedHooks = [...refs].sort();
    } catch {
      settingsReadable = false;
    }
    if (!settingsReadable) {
      // settings.json missing/unreadable: fail LOUD (the wiring-config check
      // below also flags its absence, but the hook contract genuinely cannot be
      // verified, so say so rather than silently checking nothing).
      results.push({
        pass: false,
        label: "Hook contract: settings.json unreadable — cannot verify wired hooks",
        fix: "restore .claude/settings.json (copy from `dist/claude/.claude/settings.json`)",
      });
    } else if (expectedHooks.length === 0) {
      // settings.json parsed but wires no aidlc hooks — also loud (a stripped
      // settings.json that lost its hooks block is a real misconfiguration).
      results.push({
        pass: false,
        label: "Hook contract: settings.json wires no aidlc-*.ts hooks",
        fix: "restore the hooks block in .claude/settings.json (copy from `dist/claude/.claude/settings.json`)",
      });
    } else {
      for (const h of expectedHooks) {
        const hookPath = join(projectDir, harness, "hooks", h);
        results.push({
          pass: existsSync(hookPath),
          label: `${h} present`,
          fix: "verify file exists in .claude/hooks/",
        });
      }
    }
  } else {
    // Kiro / Codex: the wiring config is not settings.json (it is
    // agents/aidlc.json / hooks.json — checked below). The core hook bodies
    // ship in every tree plus an authored adapter, so probe the explicit roster.
    const tsHooks = [
      "aidlc-audit-logger",
      "aidlc-sync-statusline",
      "aidlc-validate-state",
      "aidlc-log-subagent",
      "aidlc-session-start",
      "aidlc-session-end",
      "aidlc-statusline",
    ];
    if (harness === ".kiro") tsHooks.push("aidlc-kiro-adapter");
    if (harness === ".codex") tsHooks.push("aidlc-codex-adapter");
    for (const h of tsHooks) {
      const hookPath = join(projectDir, harness, "hooks", `${h}.ts`);
      results.push({
        pass: existsSync(hookPath),
        label: `${h}.ts present`,
        fix: `verify file exists in ${harness}/hooks/`,
      });
    }
  }

  // 4. Harness wiring config present. Claude Code: settings.json (hooks +
  // permissions live there). Kiro CLI: the aidlc agent config (hooks +
  // permissions live there) plus settings/cli.json (activation). Codex CLI:
  // config.toml + hooks.json (the hook wiring) + rules/default.rules (permissions).
  if (harness === ".kiro") {
    const agentPath = join(projectDir, harness, "agents", "aidlc.json");
    results.push({
      pass: existsSync(agentPath),
      label: "agents/aidlc.json present (hook + permission wiring)",
      fix: "copy from `dist/kiro/.kiro/agents/aidlc.json`",
    });
    const cliSettingsPath = join(projectDir, harness, "settings", "cli.json");
    results.push({
      pass: existsSync(cliSettingsPath),
      label: "settings/cli.json present (workspace default-agent activation)",
      fix: "copy from `dist/kiro/.kiro/settings/cli.json` (or use `kiro-cli chat --agent aidlc`)",
    });
  } else if (harness === ".codex") {
    for (const [file, what, from] of [
      ["config.toml", "model/provider/sandbox config", "dist/codex/.codex/config.toml"],
      ["hooks.json", "hook wiring", "dist/codex/.codex/hooks.json"],
      ["rules/default.rules", "permission prefix rules", "dist/codex/.codex/rules/default.rules"],
    ] as const) {
      results.push({
        pass: existsSync(join(projectDir, harness, file)),
        label: `${file} present (${what})`,
        fix: `copy from \`${from}\``,
      });
    }
    // Minimum Codex version pin (G10): SubagentStart/Stop agent_type carries
    // the real role name only from 0.139.0 (hyphenated agent TOMLs resolve
    // without registration from the same release). Older versions degrade
    // SUBAGENT_COMPLETED attribution and the agent transposition contract.
    const MIN_CODEX = [0, 139, 0] as const;
    const codexVer = Bun.spawnSync(["codex", "--version"], { stdout: "pipe", stderr: "ignore" });
    const verText = (codexVer.stdout?.toString() ?? "").trim();
    const verMatch = verText.match(/(\d+)\.(\d+)\.(\d+)/);
    if (!verMatch) {
      results.push({
        pass: false,
        label: "codex CLI on PATH",
        fix: "install Codex CLI >= 0.139.0 (https://developers.openai.com/codex)",
      });
    } else {
      const v = [Number(verMatch[1]), Number(verMatch[2]), Number(verMatch[3])];
      const ok =
        v[0] > MIN_CODEX[0] ||
        (v[0] === MIN_CODEX[0] &&
          (v[1] > MIN_CODEX[1] || (v[1] === MIN_CODEX[1] && v[2] >= MIN_CODEX[2])));
      results.push({
        pass: ok,
        label: `codex CLI version ${verMatch[0]} >= 0.139.0 (subagent attribution + agent TOML resolution)`,
        fix: "upgrade Codex CLI to 0.139.0 or later",
      });
    }
    // Hook trust pre-seed reminder (advisory pass-with-label): untrusted
    // project hooks never fire (the bypass flag does not run them either).
    results.push({
      pass: true,
      label:
        "hook trust: ensure [hooks.state] entries are pre-seeded in $CODEX_HOME/config.toml (`bun scripts/package.ts codex trust --project <dir>`) or run one TUI trust pass",
    });
  } else {
    const settingsPath = join(projectDir, harness, "settings.json");
    results.push({
      pass: existsSync(settingsPath),
      label: "settings.json present",
      fix: "copy from `dist/claude/.claude/settings.json`",
    });
  }

  // 4b. Dual-harness coexistence (D-11): another harness tree installed AND a
  // workflow active is supported-but-untested — warn (advisory pass with a
  // visible label), never block.
  const otherTrees = [".claude", ".kiro", ".codex"].filter(
    (h) => h !== harness && existsSync(join(projectDir, h, "tools", "aidlc-lib.ts")),
  );
  if (
    otherTrees.length > 0 &&
    existsSync(join(projectDir, harness, "tools", "aidlc-lib.ts")) &&
    existsSync(join(projectDir, "aidlc-docs", "aidlc-state.md"))
  ) {
    results.push({
      pass: true,
      label: `Multi-harness install detected (${harness} + ${otherTrees.join(" + ")}) with an active workflow — supported but untested; keep all trees at the same framework version`,
    });
  }

  // 4a. AWS_AIDLC_DEFAULT_SCOPE env var — project-default scope from settings.json env.
  // Only observable inside a Claude Code session (where settings.json env is exposed
  // to Bash invocations). When doctor is invoked directly via bun, the env is unset
  // and we report "unset — no project default" as a pass.
  const envScope = (process.env.AWS_AIDLC_DEFAULT_SCOPE || "").trim();
  if (envScope === "") {
    results.push({
      pass: true,
      label: "AWS_AIDLC_DEFAULT_SCOPE (unset — no project default)",
    });
  } else if (validScopes().has(envScope)) {
    results.push({
      pass: true,
      label: `AWS_AIDLC_DEFAULT_SCOPE=${envScope} (valid)`,
    });
  } else {
    results.push({
      pass: false,
      label: `AWS_AIDLC_DEFAULT_SCOPE=${envScope} (invalid)`,
      fix: `valid values: ${[...validScopes()].join(", ")}`,
    });
  }

  // 5. aidlc-docs/ exists
  const aidlcDocsDir = join(projectDir, "aidlc-docs");
  results.push({
    pass: existsSync(aidlcDocsDir),
    label: "aidlc-docs/ directory exists",
    fix: "run `/aidlc --init` to scaffold",
  });

  // 6. Hook heartbeats
  // Three states:
  //   (a) .aidlc-hooks-health/ missing entirely → fresh install, hooks haven't
  //       had a chance to fire yet. Pass with advisory label — not drift.
  //   (b) Directory exists but no .last files → hooks registered but have
  //       never fired. Genuine drift; fail.
  //   (c) Directory has .last files → hooks are working; pass with timestamps.
  const healthDir = join(projectDir, "aidlc-docs", ".aidlc-hooks-health");
  const heartbeatEntries: string[] = [];
  const heartbeatDirExists = existsSync(healthDir);
  if (heartbeatDirExists) {
    try {
      const files = readdirSync(healthDir).filter((f) => f.endsWith(".last"));
      for (const f of files) {
        try {
          const ts = readFileSync(join(healthDir, f), "utf-8").trim();
          const name = f.replace(".last", "");
          heartbeatEntries.push(`${name} ${ts}`);
        } catch {
          // skip unreadable
        }
      }
    } catch {
      // skip unreadable dir
    }
  }
  if (heartbeatEntries.length > 0) {
    // (c) hooks working
    results.push({
      pass: true,
      label: `Hooks last fired: ${heartbeatEntries.join(", ")}`,
    });
  } else if (!heartbeatDirExists) {
    // (a) fresh install — nothing to verify yet
    results.push({
      pass: true,
      label: "Hook heartbeats: not yet fired (first workflow stage will populate)",
    });
  } else {
    // (b) registered but never fired — genuine drift
    results.push({
      pass: false,
      label: "Hook heartbeat data",
      fix: "health dir exists but no hooks have fired — verify hooks are registered in settings.json",
    });
  }

  // State / audit drift check — if latest audit event implies the state file
  // should be in a certain shape (e.g., Status=Completed after WORKFLOW_COMPLETED),
  // verify the state actually matches. Covers the rare case where audit-first
  // succeeded but the state write failed (disk full, permission lost mid-run).
  const stateMdPath = join(projectDir, "aidlc-docs", "aidlc-state.md");
  const auditMdPath = join(projectDir, "aidlc-docs", "audit.md");
  if (existsSync(stateMdPath) && existsSync(auditMdPath)) {
    try {
      const auditContent = readFileSync(auditMdPath, "utf-8");
      const stateContent = readFileSync(stateMdPath, "utf-8");
      // Find last WORKFLOW_COMPLETED event
      const wcIdx = auditContent.lastIndexOf("**Event**: WORKFLOW_COMPLETED");
      if (wcIdx !== -1) {
        const status = stateContent.match(/^- \*\*Status\*\*:\s*(\S+)/m);
        if (status && status[1] !== "Completed") {
          results.push({
            pass: false,
            label: `State/audit drift: audit has WORKFLOW_COMPLETED but state Status=${status[1]}`,
            fix: "manually set Status=Completed in aidlc-state.md or restart the workflow",
          });
        } else {
          results.push({
            pass: true,
            label: "State matches last audit event (no drift)",
          });
        }
      }
    } catch {
      // Drift-check failure is non-fatal for doctor report
    }
  }

  // State version check — current template adds Worktree Path, Bolt
  // Refs, and Practices Affirmed Timestamp fields. Older v6 state
  // files lack them, so setFieldStrict writes would throw at runtime.
  // Fail loud here with archive-and-reinit guidance per the framework's
  // pre-1.0 no-migration policy.
  if (existsSync(stateMdPath)) {
    try {
      const stateContent = readFileSync(stateMdPath, "utf-8");
      const versionMatch = stateContent.match(/^- \*\*State Version\*\*:\s*(\S+)/m);
      if (versionMatch === null) {
        results.push({
          pass: false,
          label: "state version readable",
          fix: "State Version field missing or unparseable in aidlc-state.md. Archive your workspace ('mv aidlc-docs aidlc-docs.v6-archive') and re-run /aidlc --init.",
        });
      } else if (versionMatch[1] !== "7") {
        results.push({
          pass: false,
          label: "state version current",
          fix: `v${versionMatch[1]} state detected. The framework does not ship user-visible migration support pre-1.0. Archive your workspace ('mv aidlc-docs aidlc-docs.v${versionMatch[1]}-archive') and re-run /aidlc --init to scaffold a current-template workspace. The current template adds Worktree Path, Bolt Refs, and Practices Affirmed Timestamp fields used by Construction worktrees and practices-discovery.`,
        });
      } else {
        results.push({
          pass: true,
          label: "State Version: 7",
        });
      }
    } catch {
      // State-version check failure is non-fatal for doctor report
    }
  }

  // ===========================================================================
  // Reconciliation checks
  //
  // Doctor's role: read-only reconciliation against on-disk state, audit, and
  // git for the worktree / state-fork / audit-fork / practices surfaces. Each
  // check anchors on a specific drift class:
  //
  //   Check 1 — orphan worktrees       (cleanup-orphan, BOLT_FAILED rows)
  //   Check 2 — stale branches         (git branch -l 'bolt-*')
  //   Check 3 — orphan state files     (STATE_FORKED slug-tag)
  //   Check 4 — orphan audit drift     (AUDIT_FORKED, PRACTICES_OVERRIDE)
  //   Check 5 — practices staleness    (Practices Affirmed Timestamp)
  //   Check 6 — MERGE_DISPATCH advisory (LLM-dispatch reconciliation)
  //
  // Two surfaces deferred to a future release:
  //   - orphan `Merge-Held: true` reconciliation (graph traversal, not a
  //     check; needs workshop-resume false-positive guard)
  //   - workshop `git ls-remote origin "bolt-*"` stale-claim detection
  //     (remote-aware doctor, composes with future designer offline-mode)
  // ===========================================================================

  const auditMd = existsSync(auditMdPath) ? readFileSync(auditMdPath, "utf-8") : "";
  const stateMd = existsSync(stateMdPath) ? readFileSync(stateMdPath, "utf-8") : "";
  const boltRefs = stateMd
    ? parseRefsList(getField(stateMd, "Bolt Refs") ?? "")
    : [];

  // Helper: extract the Bolt slug from an audit block. Returns null if absent.
  const blockBoltSlug = (block: string): string | null => {
    const m = block.match(/^\*\*Bolt slug\*\*:\s*(\S+)/m);
    return m ? m[1] : null;
  };

  // Helper: extract a named field value from an audit block.
  const blockField = (block: string, field: string): string | null => {
    const re = new RegExp(`^\\*\\*${escapeRegex(field)}\\*\\*:\\s*(.+)$`, "m");
    const m = block.match(re);
    return m ? m[1].trim() : null;
  };

  // Helper: was a slug terminated (worktree merged or discarded) in audit?
  const slugTerminated = (slug: string): boolean => {
    if (
      findAllEvents(auditMd, "WORKTREE_MERGED", slug).length > 0 ||
      findAllEvents(auditMd, "WORKTREE_DISCARDED", slug).length > 0
    ) {
      return true;
    }
    return false;
  };

  // ---------------------------------------------------------------------------
  // Check 1 — Orphan worktrees
  //
  // Walk `.aidlc/worktrees/bolt-*/` directories on disk; cross-reference each
  // against:
  //   (a) main state's Bolt Refs (active fork → ✓)
  //   (b) audit WORKTREE_DISCARDED / WORKTREE_MERGED (terminated → orphan dir)
  //   (c) ERROR_LOGGED rows with [merge-succeeded:<sha>] tag (cleanup-orphan
  //       after a successful merge)
  //
  // Reports `0 worktrees observed` with pass=true when the directory is empty
  // or absent — the issue 75 line 215 "fail-clean on no-worktrees" guarantee.
  // ---------------------------------------------------------------------------
  try {
    const worktreesDir = join(projectDir, ".aidlc", "worktrees");
    let observed = 0;
    let activeForks = 0;
    let preservedByAbort = 0;
    const orphanActive: string[] = []; // dir present but no audit/Bolt Refs trail
    const cleanupOrphans: string[] = []; // dir present, merge succeeded, cleanup failed

    // Helper: did this slug get aborted via `aidlc-bolt abort` (BOLT_FAILED
    // with `Reason: aborted` from multi-failure halt-and-ask)?
    // Default-path abort preserves the worktree, so the slug remains in
    // Bolt Refs but it's not "in flight" — it's awaiting /aidlc --resume.
    // Doctor output distinguishes "3 active forks (in flight)" from "3
    // preserved-by-abort (awaiting resume)".
    const isAbortedSlug = (slug: string): boolean => {
      return findAllEvents(auditMd, "BOLT_FAILED", slug).some((b) => {
        const reason = blockField(b.block, "Reason") ?? "";
        return reason === "aborted";
      });
    };

    if (existsSync(worktreesDir)) {
      for (const entry of readdirSync(worktreesDir)) {
        if (!entry.startsWith("bolt-")) continue;
        const slug = entry.slice("bolt-".length);
        if (validateBoltSlug(slug) !== null) continue;
        observed++;

        // Active fork — slug is in main state's Bolt Refs. Expected; not orphan.
        // Sub-classify into "preserved-by-abort" (BOLT_FAILED Reason: aborted
        // exists for the slug — the user aborted multi-failure AUQ at index k
        // and these dirs are awaiting /aidlc --resume) vs "in flight".
        if (boltRefs.includes(slug)) {
          if (isAbortedSlug(slug)) {
            preservedByAbort++;
          } else {
            activeForks++;
          }
          continue;
        }

        // Cleanup-orphan: a WORKTREE_MERGED landed (or ERROR_LOGGED carries
        // [merge-succeeded:<sha>] on a post-merge cleanup failure) but the
        // directory persists. The worktree primitive guarantees the tag.
        const errBlocks = findAllEvents(auditMd, "ERROR_LOGGED");
        const matchesMergeSucceeded = errBlocks.some((b) => {
          const tag = b.block.match(MERGE_SUCCEEDED_TAG_REGEX);
          if (!tag) return false;
          const slugTag = b.block.match(SLUG_TAG_REGEX);
          return slugTag !== null && slugTag[1] === slug;
        });
        if (matchesMergeSucceeded || findAllEvents(auditMd, "WORKTREE_MERGED", slug).length > 0) {
          cleanupOrphans.push(slug);
          continue;
        }
        if (findAllEvents(auditMd, "WORKTREE_DISCARDED", slug).length > 0) {
          // Terminated explicitly via discard but directory persists — discard
          // failed mid-cleanup. Surface so the operator can `rm -rf` manually.
          cleanupOrphans.push(slug);
          continue;
        }
        orphanActive.push(slug);
      }
    }

    const pass = orphanActive.length === 0 && cleanupOrphans.length === 0;
    let label: string;
    let fix: string | undefined;
    if (observed === 0) {
      label = "Orphan worktrees: 0 observed";
    } else if (pass) {
      const segments: string[] = [];
      if (activeForks > 0) segments.push(`${activeForks} active fork${activeForks === 1 ? "" : "s"}`);
      if (preservedByAbort > 0) segments.push(`${preservedByAbort} preserved-by-abort (awaiting resume)`);
      label = `Orphan worktrees: 0 (${segments.join(", ")})`;
    } else {
      const parts: string[] = [];
      if (orphanActive.length > 0) {
        parts.push(`${orphanActive.length} unmatched (no audit trail): ${orphanActive.join(", ")}`);
      }
      if (cleanupOrphans.length > 0) {
        parts.push(
          `${cleanupOrphans.length} cleanup-orphan${cleanupOrphans.length === 1 ? "" : "s"} (merge/discard landed, dir persists): ${cleanupOrphans.join(", ")}`,
        );
      }
      label = `Orphan worktrees: ${orphanActive.length + cleanupOrphans.length} drift`;
      fix = `${parts.join("; ")}. Inspect and remove via 'aidlc-worktree discard --slug <slug>' or 'rm -rf .aidlc/worktrees/bolt-<slug>'.`;
    }
    results.push({ pass, label, fix });
  } catch (e) {
    results.push({
      pass: false,
      label: "Orphan worktrees: check failed",
      fix: errorMessage(e),
    });
  }

  // ---------------------------------------------------------------------------
  // Check 2 — Stale branches
  //
  // Walk `git branch --list 'bolt-*'`; flag any `bolt-<slug>` branch whose
  // worktree directory is gone but no terminal WORKTREE_DISCARDED or
  // WORKTREE_MERGED audit row landed for that slug.
  //
  // Skips branches that aren't valid Bolt slugs — e.g. user-created
  // `bolt-experiment` outside the framework. Skips silently when not a git
  // repo (smoke / fresh fixtures) so doctor remains usable in non-git contexts.
  // ---------------------------------------------------------------------------
  try {
    const proc = Bun.spawnSync({
      cmd: ["git", "-C", projectDir, "branch", "--list", "bolt-*"],
      stdout: "pipe",
      stderr: "pipe",
    });
    if (proc.exitCode !== 0) {
      // Not a git repo or git failure — skip silently with informational pass.
      results.push({ pass: true, label: "Stale branches: 0 observed (not a git repo)" });
    } else {
      const stdout = new TextDecoder().decode(proc.stdout);
      const branchSlugs: string[] = [];
      for (const line of stdout.split("\n")) {
        const trimmed = line.replace(/^\*?\s+/, "").trim();
        if (!trimmed.startsWith("bolt-")) continue;
        const slug = trimmed.slice("bolt-".length);
        if (validateBoltSlug(slug) !== null) continue;
        branchSlugs.push(slug);
      }

      const stale: string[] = [];
      for (const slug of branchSlugs) {
        const wtDir = worktreePath(projectDir, slug);
        if (existsSync(wtDir)) continue; // worktree intact — branch is live
        // Worktree gone — needs a terminal audit row to be legitimate.
        if (slugTerminated(slug)) continue;
        stale.push(slug);
      }

      if (stale.length === 0) {
        results.push({
          pass: true,
          label: `Stale branches: 0 (${branchSlugs.length} bolt-* observed)`,
        });
      } else {
        results.push({
          pass: false,
          label: `Stale branches: ${stale.length} drift`,
          fix: `branches ${stale.join(", ")} have no worktree directory and no WORKTREE_MERGED/_DISCARDED audit row. Delete via 'git branch -D bolt-<slug>' if abandoned.`,
        });
      }
    }
  } catch (e) {
    results.push({
      pass: false,
      label: "Stale branches: check failed",
      fix: errorMessage(e),
    });
  }

  // ---------------------------------------------------------------------------
  // Check 3 — Orphan state files (paired with STATE_FORKED slug-tag)
  //
  // Walk `.aidlc/worktrees/*/aidlc-docs/aidlc-state.md`; each found state file
  // must map to a slug in main's Bolt Refs (active fork) OR pair with a
  // WORKTREE_DISCARDED audit row (pre-discard). Anything else is post-fork
  // drift — STATE_FORKED emitted, slug added to Bolt Refs, but state-write or
  // STATE_MERGED never landed.
  // ---------------------------------------------------------------------------
  try {
    const worktreesDir = join(projectDir, ".aidlc", "worktrees");
    const orphan: string[] = [];
    let observed = 0;

    if (existsSync(worktreesDir)) {
      for (const entry of readdirSync(worktreesDir)) {
        if (!entry.startsWith("bolt-")) continue;
        const slug = entry.slice("bolt-".length);
        if (validateBoltSlug(slug) !== null) continue;
        const wtStatePath = join(worktreesDir, entry, "aidlc-docs", "aidlc-state.md");
        if (!existsSync(wtStatePath)) continue;
        observed++;
        if (boltRefs.includes(slug)) continue;
        if (findAllEvents(auditMd, "WORKTREE_DISCARDED", slug).length > 0) continue;
        orphan.push(slug);
      }
    }

    if (orphan.length === 0) {
      results.push({
        pass: true,
        label: observed === 0
          ? "Orphan state files: 0 observed"
          : `Orphan state files: 0 (${observed} active)`,
      });
    } else {
      results.push({
        pass: false,
        label: `Orphan state files: ${orphan.length} drift`,
        fix: `state files for ${orphan.join(", ")} exist but slug not in Bolt Refs and no WORKTREE_DISCARDED row. Recover via 'aidlc-worktree discard --slug <slug>' (idempotent).`,
      });
    }
  } catch (e) {
    results.push({
      pass: false,
      label: "Orphan state files: check failed",
      fix: errorMessage(e),
    });
  }

  // ---------------------------------------------------------------------------
  // Check 4 — Orphan audit drift (3 sub-cases)
  //
  // Sub-case (a): AUDIT_FORKED-without-disk-state — main has AUDIT_FORKED but
  //   <wtPath>/aidlc-docs/audit.md is absent on disk.
  // Sub-case (b): orphan-delta — main has AUDIT_FORKED but no matching
  //   AUDIT_MERGED for an unterminated, non-active slug.
  // Sub-case (c): PRACTICES_OVERRIDE Reason filter — write-failure-* rows
  //   without a following PRACTICES_AFFIRMED are flagged as orphan; rows
  //   carrying Reason: bolt-plan-marker-conflict are expected behaviour and
  //   ignored. audit-format.md:138 anchors the discriminator routing.
  //
  // Sub-case (c) shares the orphan-audit umbrella because both classes ride
  // the same audit-walker pass; per plan-v3 §51, this is one Check, not two.
  // ---------------------------------------------------------------------------
  try {
    const forkedDriftDisk: string[] = []; // (a)
    const forkedDriftMerge: string[] = []; // (b)
    const overrideDrift: string[] = []; // (c)

    const forks = findAllEvents(auditMd, "AUDIT_FORKED");
    for (const fork of forks) {
      const slug = blockBoltSlug(fork.block);
      if (!slug) continue;
      // Terminal short-circuits run BEFORE the disk check. A successfully
      // merged-and-cleaned Bolt has AUDIT_MERGED + WORKTREE_MERGED in main
      // audit and the worktree directory removed by `aidlc-worktree merge`'s
      // cleanup — without the short-circuit, sub-case (a) would flag every
      // healthy historical AUDIT_FORKED as drift forever. Same logic for
      // active forks (still in flight) and explicit discards.
      if (findAllEvents(auditMd, "AUDIT_MERGED", slug).length > 0) continue;
      if (boltRefs.includes(slug)) continue;
      if (findAllEvents(auditMd, "WORKTREE_DISCARDED", slug).length > 0) continue;
      // Sub-case (a): no terminal pairing — is the worktree audit on disk?
      // If yes, we're mid-fork (orphan-delta — sub-case b). If no, the fork
      // emitted but disk copy never landed.
      const wtAudit = join(worktreePath(projectDir, slug), "aidlc-docs", "audit.md");
      if (!existsSync(wtAudit)) {
        forkedDriftDisk.push(slug);
        continue;
      }
      // Sub-case (b): disk audit landed but no AUDIT_MERGED — orphan-delta.
      forkedDriftMerge.push(slug);
    }

    // Sub-case (c): PRACTICES_OVERRIDE Reason filter.
    let unknownReasonCount = 0;
    const overrides = findAllEvents(auditMd, "PRACTICES_OVERRIDE");
    for (const o of overrides) {
      const reason = blockField(o.block, "Reason") ?? "";
      // bolt-plan-marker-conflict is expected behaviour (orchestrator override
      // per team practices) — skip per audit-format.md routing.
      if (reason.startsWith("bolt-plan-marker-conflict")) continue;
      // write-failure-* rows are practices-promote failures. Orphan if no
      // following PRACTICES_AFFIRMED row; matched-pair otherwise. Compare
      // timestamps via Date.parse — ISO 8601 strings only sort lexicographically
      // when in identical format, but `2026-05-19T11:00:00.123Z` sorts before
      // `2026-05-19T11:00:00Z` (`.` 0x2E < `Z` 0x5A) and `Z` vs `+00:00` shapes
      // also break naive string compare. Date.parse normalises both to ms.
      if (reason.startsWith("write-failure")) {
        const overrideMs = Date.parse(o.timestamp);
        const affirmAfter = findAllEvents(auditMd, "PRACTICES_AFFIRMED").some(
          (a) => {
            const am = Date.parse(a.timestamp);
            return Number.isFinite(am) && am > overrideMs;
          },
        );
        if (!affirmAfter) {
          overrideDrift.push(`${reason}@${o.timestamp}`);
        }
        continue;
      }
      // Reason value matched neither prefix — track for follow-up. Future
      // PRACTICES_OVERRIDE Reason variants may need their own routing rule;
      // doctor surfaces the count for later reconciliation.
      unknownReasonCount++;
    }

    const total = forkedDriftDisk.length + forkedDriftMerge.length + overrideDrift.length;
    if (total === 0) {
      const reconciled = forks.length + overrides.length - unknownReasonCount;
      let label: string;
      if (reconciled === 0) {
        label = "Orphan audit: 0 observed";
      } else {
        label = `Orphan audit: 0 (${reconciled} reconciled)`;
      }
      if (unknownReasonCount > 0) {
        label += `; ${unknownReasonCount} PRACTICES_OVERRIDE row(s) with unknown Reason — track for follow-up`;
      }
      results.push({ pass: true, label });
    } else {
      const parts: string[] = [];
      if (forkedDriftDisk.length > 0) parts.push(`${forkedDriftDisk.length} AUDIT_FORKED-without-disk: ${forkedDriftDisk.join(", ")}`);
      if (forkedDriftMerge.length > 0) parts.push(`${forkedDriftMerge.length} orphan-delta (no AUDIT_MERGED): ${forkedDriftMerge.join(", ")}`);
      if (overrideDrift.length > 0) parts.push(`${overrideDrift.length} PRACTICES_OVERRIDE write-failure(s) without follow-up PRACTICES_AFFIRMED`);
      if (unknownReasonCount > 0) parts.push(`${unknownReasonCount} PRACTICES_OVERRIDE row(s) with unknown Reason`);
      results.push({
        pass: false,
        label: `Orphan audit: ${total} drift`,
        fix: parts.join("; "),
      });
    }
  } catch (e) {
    results.push({
      pass: false,
      label: "Orphan audit: check failed",
      fix: errorMessage(e),
    });
  }

  // ---------------------------------------------------------------------------
  // Check 5 — Practices staleness
  //
  // Read `Practices Affirmed Timestamp` from main state. Compare to now.
  // Empty / missing → informational pass (never affirmed). Within 90 days → ✓.
  // Older → advisory pass=true (does NOT fail exit code; mirrors heartbeat
  // and state/audit drift advisory pattern at aidlc-utility.ts:421-466).
  // Invalid ISO timestamp → fail readable.
  // ---------------------------------------------------------------------------
  try {
    if (!stateMd) {
      results.push({ pass: true, label: "Practices staleness: state file absent (informational)" });
    } else {
      const value = (getField(stateMd, "Practices Affirmed Timestamp") ?? "").trim();
      if (value === "" || value.startsWith("[")) {
        // Empty placeholder OR `[ISO 8601 timestamp on affirmation]` template
        // string that hasn't been replaced by practices-promote yet.
        results.push({ pass: true, label: "Practices staleness: never affirmed (informational)" });
      } else {
        const affirmed = Date.parse(value);
        if (Number.isNaN(affirmed)) {
          results.push({
            pass: false,
            label: "Practices staleness: timestamp unreadable",
            fix: `Practices Affirmed Timestamp value "${value}" is not a valid ISO 8601 datetime. Re-run practices-discovery (stage 2.2) to re-affirm.`,
          });
        } else {
          const ageDays = Math.floor((Date.now() - affirmed) / (1000 * 60 * 60 * 24));
          if (ageDays < 0) {
            // Future-dated timestamp — clock skew or hand-edit. Advisory pass
            // so doctor doesn't fail loud, but surfaces the anomaly.
            results.push({
              pass: true,
              label: `Practices staleness: affirmed in the future (clock skew or hand-edited timestamp ${Math.abs(ageDays)} day${Math.abs(ageDays) === 1 ? "" : "s"} ahead)`,
            });
          } else if (ageDays <= PRACTICES_STALENESS_DAYS) {
            results.push({
              pass: true,
              label: `Practices staleness: affirmed ${ageDays} day${ageDays === 1 ? "" : "s"} ago`,
            });
          } else {
            results.push({
              pass: true,
              label: `Practices staleness: affirmed ${ageDays} days ago (advisory — > ${PRACTICES_STALENESS_DAYS} days; consider re-running practices-discovery)`,
            });
          }
        }
      }
    }
  } catch {
    // Practices-staleness check failure is non-fatal for doctor report
  }

  // ---------------------------------------------------------------------------
  // Check 6 — MERGE_DISPATCH advisory
  //
  // Walk MERGE_DISPATCH_INVOKED rows; an INVOKED row should pair with either
  // _RETURNED or _FALLBACK for the same slug within MERGE_DISPATCH_TIMEOUT_SEC.
  // Orphan INVOKED rows are reported as advisory (pass=true) — observation-
  // time drift on an in-memory LLM dispatch is not a fail-loud condition. A
  // future observer layer may take over this reconciliation.
  //
  // No correlation tag — slug + timestamp window is sufficient for doctor
  // reconciliation (the LLM call has no disk artifact to anchor against).
  // ---------------------------------------------------------------------------
  try {
    const invokedRows = findAllEvents(auditMd, "MERGE_DISPATCH_INVOKED");
    let orphans = 0;
    const now = Date.now();
    // Pair-match per slug: each terminal row (RETURNED or FALLBACK) consumed
    // by at most one preceding INVOKED. Without consumption tracking, two
    // consecutive INVOKED + 1 RETURNED for the same slug would report 0
    // orphans because `.some(r >= invokedTs)` is satisfied by ANY later
    // terminal, not the next-unmatched one.
    const invokedBySlug = new Map<string, number[]>(); // slug → INVOKED timestamps (ms)
    for (const inv of invokedRows) {
      const slug = blockBoltSlug(inv.block);
      if (!slug) continue;
      const invokedMs = Date.parse(inv.timestamp);
      if (Number.isNaN(invokedMs)) continue;
      const list = invokedBySlug.get(slug) ?? [];
      list.push(invokedMs);
      invokedBySlug.set(slug, list);
    }
    for (const [slug, invokedList] of invokedBySlug) {
      invokedList.sort((a, b) => a - b);
      // Build a chronological list of terminal events (RETURNED + FALLBACK)
      // for this slug, then consume each in pair order with the earliest
      // not-yet-paired INVOKED that precedes it.
      const terminals: number[] = [];
      for (const r of findAllEvents(auditMd, "MERGE_DISPATCH_RETURNED", slug)) {
        const ms = Date.parse(r.timestamp);
        if (Number.isFinite(ms)) terminals.push(ms);
      }
      for (const f of findAllEvents(auditMd, "MERGE_DISPATCH_FALLBACK", slug)) {
        const ms = Date.parse(f.timestamp);
        if (Number.isFinite(ms)) terminals.push(ms);
      }
      terminals.sort((a, b) => a - b);
      const consumed = new Array<boolean>(terminals.length).fill(false);
      for (const invokedMs of invokedList) {
        // Active session within the timeout window — still in flight, skip.
        if (now - invokedMs < MERGE_DISPATCH_TIMEOUT_SEC * 1000) continue;
        // Find the first not-yet-consumed terminal at or after invokedMs.
        let matched = false;
        for (let i = 0; i < terminals.length; i++) {
          if (consumed[i]) continue;
          if (terminals[i] < invokedMs) continue;
          consumed[i] = true;
          matched = true;
          break;
        }
        if (!matched) orphans++;
      }
    }
    results.push({
      pass: true,
      label: orphans === 0
        ? `MERGE_DISPATCH: 0 orphan INVOKED (${invokedRows.length} bracketed)`
        : `MERGE_DISPATCH: ${orphans} orphan INVOKED (advisory — LLM dispatch unmatched after ${MERGE_DISPATCH_TIMEOUT_SEC}s)`,
    });
  } catch {
    // MERGE_DISPATCH check failure is non-fatal for doctor report
  }

  // --- Graph-level checks (library-direct, no subprocess) ---

  // Cycle detection — findCycles returns [] on a healthy DAG
  try {
    const cycles = findCycles(loadGraph());
    results.push({
      pass: cycles.length === 0,
      label: cycles.length === 0
        ? "Cycle detection: 0 cycles"
        : `Cycle detection: ${cycles.length} cycle(s) found`,
      fix: cycles.length > 0
        ? `cycles: ${cycles.map((c) => c.join(" → ")).join("; ")}`
        : undefined,
    });
  } catch (e) {
    results.push({
      pass: false,
      label: "Cycle detection: graph load failed",
      fix: errorMessage(e),
    });
  }

  // Orphan stage files (graph→disk direction only). Every slug in
  // stage-graph.json must have a matching <phase>/<slug>.md on disk.
  // Disk→graph direction not checked — stages are migrated atomically so
  // rogue-file drift isn't a realistic failure mode.
  try {
    const stagesDir = join(TOOLS_DIR, "..", "aidlc-common", "stages");
    const graphSlugs = new Set(loadStageGraph().map((s) => s.slug));
    const diskSlugs = new Set<string>();
    for (const phase of PHASES) {
      const dir = join(stagesDir, phase);
      if (!existsSync(dir)) continue;
      for (const f of readdirSync(dir)) {
        if (f.endsWith(".md")) diskSlugs.add(f.replace(/\.md$/, ""));
      }
    }
    const missingFiles = [...graphSlugs].filter((s) => !diskSlugs.has(s));
    results.push({
      pass: missingFiles.length === 0,
      label: missingFiles.length === 0
        ? `Orphan stage files: ${graphSlugs.size} graph entries all have files`
        : `Orphan stage files: ${missingFiles.length} graph entries have no file on disk`,
      fix: missingFiles.length > 0 ? `missing files: ${missingFiles.join(", ")}` : undefined,
    });
  } catch (e) {
    results.push({
      pass: false,
      label: "Orphan stage files: check failed",
      fix: errorMessage(e),
    });
  }

  // Scope validation — run validateScope over all 9 scopes, tally errors
  // and advisories. Repo-level setup check, not workflow-state.
  try {
    const scopes = [...validScopes()];
    let totalErrors = 0;
    let totalAdvisories = 0;
    const failingScopes: { scope: string; errors: string[] }[] = [];
    for (const scope of scopes) {
      const r = validateScope(scope);
      totalAdvisories += r.advisories.length;
      if (r.errors.length > 0) {
        totalErrors += r.errors.length;
        failingScopes.push({ scope, errors: r.errors });
      }
    }
    results.push({
      pass: totalErrors === 0,
      label: totalErrors === 0
        ? `Scope validation: ${scopes.length} scopes valid (${totalAdvisories} advisories)`
        : `Scope validation: ${failingScopes.length} of ${scopes.length} scopes have errors`,
      fix: totalErrors > 0
        ? failingScopes.map((f) => `${f.scope}: ${f.errors.join("; ")}`).join(" | ")
        : undefined,
    });
  } catch (e) {
    results.push({
      pass: false,
      label: "Scope validation: check failed",
      fix: errorMessage(e),
    });
  }

  // Schema validation — parse + validate every stage's YAML frontmatter.
  // Uses the same library functions every other caller does; drift impossible.
  // Tracks attempted vs valid separately so the label can't silently say
  // "N/N valid" when files are missing (that's the orphan-files check's job).
  try {
    const stagesDir = join(TOOLS_DIR, "..", "aidlc-common", "stages");
    const graph = loadStageGraph();
    const agentSlugs = loadAgents().map((a) => a.slug);
    const schemaFails: { slug: string; errors: string[] }[] = [];
    let attempted = 0;
    for (const stage of graph) {
      const filePath = join(stagesDir, stage.phase, `${stage.slug}.md`);
      if (!existsSync(filePath)) continue; // orphan-files check handles this
      attempted++;
      const raw = readFileSync(filePath, "utf-8");
      try {
        const parsed = parseStageFrontmatter(raw);
        // Initialization stages lead with the orchestrator (SKILL.md itself),
        // not a .claude/agents/ file — skip agent cross-reference there.
        // Matches t65's convention. This phase-based skip agrees with the
        // compile guard's RESERVED_AGENT_SLUG exemption on the shipped graph
        // (the 3 orchestrator-led stages ARE the 3 initialization stages);
        // the compile guard is slug-precise, this is phase-coarse — both
        // correct for their purpose.
        const ctx = stage.phase === "initialization" ? undefined : { agents: agentSlugs };
        const vr = validateStageFrontmatter(parsed, ctx);
        if (!vr.valid) schemaFails.push({ slug: stage.slug, errors: vr.errors });
      } catch (parseErr) {
        schemaFails.push({ slug: stage.slug, errors: [errorMessage(parseErr)] });
      }
    }
    const valid = attempted - schemaFails.length;
    results.push({
      pass: schemaFails.length === 0,
      label: schemaFails.length === 0
        ? `Schema validation: ${valid}/${attempted} stages validated`
        : `Schema validation: ${schemaFails.length} of ${attempted} stage(s) failed`,
      fix: schemaFails.length > 0
        ? schemaFails.map((f) => `${f.slug}: ${f.errors[0]}`).join("; ")
        : undefined,
    });
  } catch (e) {
    results.push({
      pass: false,
      label: "Schema validation: check failed",
      fix: errorMessage(e),
    });
  }

  // Graph references — every consumes[].artifact and requires_stage[] slug
  // must resolve to something real. Catches typos that pure schema-lint
  // and scope-walk both miss.
  try {
    const graph = loadStageGraph();
    const allSlugs = new Set(graph.map((s) => s.slug));
    const allArtifacts = artifactsRegistry();
    const refFails: string[] = [];
    for (const stage of graph) {
      for (const c of stage.consumes ?? []) {
        if (!allArtifacts.has(c.artifact)) {
          refFails.push(`${stage.slug}: consumes unknown artifact "${c.artifact}"`);
        }
      }
      for (const r of stage.requires_stage ?? []) {
        if (!allSlugs.has(r)) {
          refFails.push(`${stage.slug}: requires_stage unknown slug "${r}"`);
        }
      }
    }
    results.push({
      pass: refFails.length === 0,
      label: refFails.length === 0
        ? `Graph references: ${allArtifacts.size} artifacts + edges resolved`
        : `Graph references: ${refFails.length} broken reference(s)`,
      fix: refFails.length > 0 ? refFails.join("; ") : undefined,
    });
  } catch (e) {
    results.push({
      pass: false,
      label: "Graph references: check failed",
      fix: errorMessage(e),
    });
  }

  // Keyword overlap — no keyword should be claimed by >1 scope. A conflict
  // means /aidlc "<freeform>" has ambiguous scope routing, which silently
  // burns artifacts. findScopeByKeyword (exported from this file) resolves
  // the other direction; this check inverts it to scan for collisions.
  try {
    const keywordToScopes = new Map<string, string[]>();
    const mapping = loadScopeMapping();
    for (const [scope, def] of Object.entries(mapping)) {
      for (const kw of def.keywords ?? []) {
        const list = keywordToScopes.get(kw) ?? [];
        list.push(scope);
        keywordToScopes.set(kw, list);
      }
    }
    const conflicts = [...keywordToScopes.entries()].filter(
      ([, scopes]) => scopes.length > 1
    );
    results.push({
      pass: conflicts.length === 0,
      label: conflicts.length === 0
        ? "Keyword overlap: no conflicts"
        : `Keyword overlap: ${conflicts.length} conflict(s)`,
      fix: conflicts.length > 0
        ? conflicts
            .map(([kw, scopes]) => `"${kw}" claimed by ${scopes.join(", ")}`)
            .join("; ")
        : undefined,
    });
  } catch (e) {
    results.push({
      pass: false,
      label: "Keyword overlap: check failed",
      fix: errorMessage(e),
    });
  }

  // Rule drift (advisory, always pass:true) — surface team/project
  // (and team/project-learnings) rule files whose `##` headings overlap a
  // POPULATED heading in aidlc-org.md, quoting the org sentence inline so
  // the orchestrator-LLM can review for contradiction at observation time.
  //
  // Three-concerns seam (T2): doctor is a deterministic tool — it detects
  // same-heading structural overlap (byte-reproducible), NOT semantic
  // contradiction. The contradiction VERDICT is the orchestrator-LLM's at
  // observation time, non-blocking. The row never fails the health check.
  //
  // Read seam: heading bodies come from loadRules().headings (surfaced from
  // the same `raw` loadRules reads under rulesDir(), honouring
  // AIDLC_RULES_DIR), never a second read from the relative .path.
  try {
    const rules = loadRules();
    const org = rules.find(
      (r) => r.scope === "org" && r.path.endsWith("aidlc-org.md")
    );
    if (!org) {
      results.push({
        pass: true,
        label: "Rule drift: org rules absent (informational)",
      });
    } else {
      // Populated org headings only — multi-line-comment-only headings
      // (e.g. ## Corrections) read as empty and are excluded.
      const orgPopulated = new Map<string, string>();
      for (const [h, text] of org.headings) {
        if (text.trim() !== "") orgPopulated.set(h, text);
      }
      const drifts: Array<{ file: string; heading: string; orgSentence: string }> = [];
      for (const rule of rules) {
        if (rule.scope !== "team" && rule.scope !== "project") continue;
        for (const [h, text] of rule.headings) {
          if (text.trim() === "") continue;
          const orgText = orgPopulated.get(h);
          if (orgText === undefined) continue;
          // First sentence of the org body under that heading, quoted
          // verbatim. Split on the first sentence terminator; fall back to
          // the whole first non-empty line when none is present.
          const firstLine = orgText.split("\n")[0] ?? orgText;
          const sentenceMatch = firstLine.match(/^.*?[.!?](?=\s|$)/);
          const orgSentence = (sentenceMatch ? sentenceMatch[0] : firstLine).trim();
          drifts.push({ file: rule.path, heading: h, orgSentence });
        }
      }
      if (drifts.length === 0) {
        results.push({
          pass: true,
          label: "Rule drift: no team/project rule overlaps org policy",
        });
      } else {
        const detail = drifts
          .map((d) => `${d.file} ## ${d.heading} ⇄ org "${d.orgSentence}"`)
          .join("; ");
        results.push({
          pass: true,
          label: `Rule drift: ${drifts.length} team/project rule(s) overlap org policy (review for contradiction): ${detail}`,
        });
      }
    }
  } catch (e) {
    results.push({
      pass: false,
      label: "Rule drift: check failed",
      fix: errorMessage(e),
    });
  }

  // Paired sensor coverage (advisory, always pass:true) — for each rule
  // carrying frontmatter.pairing, confirm the named sensor exists in some
  // stage's resolved sensor set. File-existence check only (structural):
  // it confirms the binding resolves, NOT that the sensor semantically
  // fits the rule. feedforward-only rules never need a sensor.
  //
  // Read seams: pairing via loadRules().frontmatter (it is NOT on the
  // graph node); sensor ids via loadGraph() -> sensors_applicable[].id.
  // Manifest ids are bare ("required-sections"); a rule's pairing value is
  // aidlc-prefixed — strip "aidlc-" before matching (milestone-7b-frozen join).
  //
  // Emits GUARDRAIL_LOADED once per doctor run — but ONLY when audit.md already
  // exists (cold-safe, see auditExists below); appendAuditEntry self-creates
  // the audit file/dir, so an unconditional emit on a pristine project would
  // scaffold aidlc-docs/ + audit.md as a side effect, making --doctor NOT
  // read-only. The README onboarding runs --doctor before --init, so doctor
  // must create nothing on a fresh checkout. On an initialized project the
  // emit fires exactly as before (BARE appendAuditEvent — the only throw is a
  // real write failure, which the rest of the codebase lets propagate).
  const pairedRules = loadRules();
  // sensors_applicable is REQUIRED on a compiled graph node, but a
  // hand-rolled or pre-milestone-9 graph JSON can omit it; `?? []` keeps this
  // advisory row from crashing doctor on a malformed/legacy graph (the
  // same defensive posture the cycle/orphan/scope checks take above).
  const sensorIds = new Set(
    loadGraph().flatMap((n) => (n.sensors_applicable ?? []).map((s) => s.id))
  );
  let pairM = 0;
  let pairX = 0;
  let pairP = 0;
  // unpaired holds the U set (sensor id named but absent anywhere);
  // unpaired.length is U, so no separate counter is needed.
  const unpaired: Array<{ file: string; sensor: string }> = [];
  for (const rule of pairedRules) {
    const pairing = rule.frontmatter.pairing;
    if (pairing === undefined) continue;
    pairM++;
    if (pairing === "feedforward-only") {
      pairX++;
      continue;
    }
    const bareId = pairing.replace(/^aidlc-/, "");
    if (sensorIds.has(bareId)) {
      pairP++;
    } else {
      unpaired.push({ file: rule.path, sensor: pairing });
    }
  }
  const needing = pairM - pairX;
  let coverageLabel: string;
  if (needing === 0) {
    coverageLabel = `Paired sensor coverage: no sensor-bound rules (${pairX} feedforward-only)`;
  } else {
    coverageLabel = `Paired sensor coverage: ${pairP}/${needing} guardrails paired (${pairX} feedforward-only)`;
  }
  if (unpaired.length > 0) {
    const unpairedDetail = unpaired
      .map((u) => `unpaired: ${u.file} → ${u.sensor} (no stage binds it)`)
      .join("; ");
    coverageLabel = `${coverageLabel}; ${unpairedDetail}`;
  }
  results.push({ pass: true, label: coverageLabel });

  // Cold-safe gate: only emit audit when audit.md already exists. On a pristine
  // project (no aidlc-docs/audit.md) doctor prints its health report and
  // creates NOTHING — it stays a pure read-only diagnostic. On an initialized
  // project both GUARDRAIL_LOADED and HEALTH_CHECKED emit as before.
  const auditExists = existsSync(auditFilePath(projectDir));

  if (auditExists) {
    appendAuditEvent(projectDir, "GUARDRAIL_LOADED", {
      Scope: "all",
      Path: `${harnessDir()}/${rulesSubdir()}/`,
      "Rule count": String(pairedRules.length),
    });
  }

  // Print report
  let output = "AI-DLC Health Check\n";
  output += `${"\u2500".repeat(37)}\n`;
  let passed = 0;
  let failed = 0;
  for (const r of results) {
    if (r.pass) {
      output += `\u2713  ${r.label}\n`;
      passed++;
    } else {
      output += `\u2717  ${r.label}`;
      if (r.fix) output += ` — ${r.fix}`;
      output += "\n";
      failed++;
    }
  }
  output += `${"\u2500".repeat(37)}\n`;
  output += `${passed} passed, ${failed} failed\n`;

  process.stdout.write(output);

  // Audit only if audit.md already existed when doctor started (cold-safe —
  // see auditExists above). A pristine project gets the stdout report and no
  // file side effects; an initialized project records HEALTH_CHECKED as before.
  if (auditExists) {
    appendAuditEvent(projectDir, "HEALTH_CHECKED", {
      Request: `/aidlc --doctor`,
      Details: `${passed} passed, ${failed} failed`,
    });
  }

  // Exit non-zero on any check failure so CI and scripts get a clear
  // signal. Doctor's stdout carries the diagnostic regardless of exit
  // code — the orchestrator's tool-failure handler was updated in this
  // same change to print stdout (not stderr) for doctor.
  process.exit(failed > 0 ? 1 : 0);
}

// ---------------------------------------------------------------------------
// init (scaffold 0.2) — bootstrap state/audit files + scaffold aidlc-docs/
// ---------------------------------------------------------------------------

// Agent knowledge metadata (display name + example files) is now derived
// from `.claude/agents/*.md` frontmatter via loadAgents() in lib.ts.

// ---------------------------------------------------------------------------
// Deterministic workspace scanner
// ---------------------------------------------------------------------------

interface ScanResult {
  projectType: string;   // "Greenfield" | "Brownfield"
  languages: string;     // e.g. "TypeScript, JavaScript"
  frameworks: string;    // e.g. "React, Vite"
  buildSystem: string;   // e.g. "npm (package.json)"
}

const LANG_BY_EXT: Record<string, string> = {
  ".ts": "TypeScript",
  ".tsx": "TypeScript",
  ".js": "JavaScript",
  ".jsx": "JavaScript",
  ".mjs": "JavaScript",
  ".cjs": "JavaScript",
  ".py": "Python",
  ".java": "Java",
  ".kt": "Kotlin",
  ".go": "Go",
  ".rs": "Rust",
  ".rb": "Ruby",
  ".cs": "C#",
  ".cpp": "C++",
  ".c": "C",
  ".h": "C",
  ".hpp": "C++",
  ".swift": "Swift",
  ".php": "PHP",
};

const SCAN_SOURCE_DIRS = ["src", "app", "lib", "pages", "components", "tests"];
const SCAN_EXCLUDE = new Set([
  ".claude",
  ".kiro",
  ".codex",
  "aidlc-docs",
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  "target",
  "vendor",
]);

function countFilesByLang(
  dir: string,
  counts: Record<string, number>,
  maxDepth: number
): void {
  if (maxDepth < 0) return;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SCAN_EXCLUDE.has(entry)) continue;
    const full = join(dir, entry);
    let st: import("node:fs").Stats;
    try {
      st = lstatSync(full);
    } catch {
      continue;
    }
    // Don't follow symlinks — cycle protection.
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      countFilesByLang(full, counts, maxDepth - 1);
    } else if (st.isFile()) {
      const dot = entry.lastIndexOf(".");
      if (dot > 0) {
        const ext = entry.slice(dot).toLowerCase();
        const lang = LANG_BY_EXT[ext];
        if (lang) counts[lang] = (counts[lang] || 0) + 1;
      }
    }
  }
}

function detectFrameworks(topEntries: Set<string>, projectDir: string): string[] {
  const fws: string[] = [];
  const has = (name: string) => topEntries.has(name);

  if (["next.config.js", "next.config.ts", "next.config.mjs", "next.config.cjs"].some(has))
    fws.push("Next.js");
  if (["vite.config.js", "vite.config.ts", "vite.config.mjs"].some(has))
    fws.push("Vite");
  if (has("angular.json")) fws.push("Angular");
  if (["nuxt.config.js", "nuxt.config.ts"].some(has)) fws.push("Nuxt");
  if (has("remix.config.js")) fws.push("Remix");
  if (has("gatsby-config.js")) fws.push("Gatsby");
  if (["astro.config.mjs", "astro.config.js", "astro.config.ts"].some(has))
    fws.push("Astro");
  if (has("svelte.config.js")) fws.push("Svelte");
  if (has("nest-cli.json")) fws.push("NestJS");

  // React surfaces via package.json dependencies/peerDependencies
  if (has("package.json")) {
    try {
      const raw: unknown = JSON.parse(
        readFileSync(join(projectDir, "package.json"), "utf-8")
      );
      if (isPackageJson(raw)) {
        const deps = {
          ...(raw.dependencies ?? {}),
          ...(raw.peerDependencies ?? {}),
        };
        if (deps.react && !fws.includes("React")) fws.push("React");
      }
    } catch {
      // ignore parse errors
    }
  }

  if (has("manage.py")) fws.push("Django");

  if (has("Gemfile")) {
    try {
      const gemfile = readFileSync(join(projectDir, "Gemfile"), "utf-8");
      if (/^[^#]*\brails\b/m.test(gemfile)) fws.push("Rails");
    } catch {
      // ignore
    }
  }

  if (has("pom.xml")) {
    try {
      const pom = readFileSync(join(projectDir, "pom.xml"), "utf-8");
      if (/spring-boot/.test(pom)) fws.push("Spring Boot");
    } catch {
      // ignore
    }
  }

  return fws;
}

function detectBuildSystem(topEntries: Set<string>, projectDir: string): string {
  if (topEntries.has("package.json")) {
    if (topEntries.has("pnpm-lock.yaml")) return "pnpm (package.json)";
    if (topEntries.has("yarn.lock")) return "yarn (package.json)";
    if (topEntries.has("bun.lockb") || topEntries.has("bun.lock"))
      return "bun (package.json)";
    return "npm (package.json)";
  }
  if (topEntries.has("pyproject.toml")) {
    try {
      const pp = readFileSync(join(projectDir, "pyproject.toml"), "utf-8");
      if (/\[tool\.poetry\]/.test(pp)) return "poetry (pyproject.toml)";
      if (/\[tool\.uv\]/.test(pp)) return "uv (pyproject.toml)";
      if (/\[tool\.hatch\]/.test(pp)) return "hatch (pyproject.toml)";
    } catch {
      // ignore
    }
    return "python (pyproject.toml)";
  }
  if (topEntries.has("requirements.txt")) return "pip (requirements.txt)";
  if (topEntries.has("setup.py")) return "setuptools (setup.py)";
  if (topEntries.has("Cargo.toml")) return "cargo (Cargo.toml)";
  if (topEntries.has("go.mod")) return "go modules (go.mod)";
  if (topEntries.has("pom.xml")) return "maven (pom.xml)";
  if (topEntries.has("build.gradle") || topEntries.has("build.gradle.kts"))
    return "gradle (build.gradle)";
  if (topEntries.has("composer.json")) return "composer (composer.json)";
  if (topEntries.has("Gemfile")) return "bundler (Gemfile)";
  return "Unknown";
}

function hasNonDevDeps(projectDir: string): boolean {
  try {
    const raw: unknown = JSON.parse(
      readFileSync(join(projectDir, "package.json"), "utf-8")
    );
    if (!isPackageJson(raw)) return false;
    const deps = raw.dependencies ?? {};
    // peerDependencies declare what a consumer must provide, not what this
    // project needs at runtime — exclude from the brownfield signal.
    return Object.keys(deps).length > 0;
  } catch {
    return false;
  }
}

export function detectWorkspace(projectDir: string): ScanResult {
  let topEntries: string[] = [];
  try {
    topEntries = readdirSync(projectDir);
  } catch {
    // projectDir doesn't exist yet (caller should scaffold first)
  }
  const topSet = new Set(topEntries.filter((e) => !SCAN_EXCLUDE.has(e)));

  // Count source files by language across top-level files + known source dirs
  const langCounts: Record<string, number> = {};

  // Top-level files only (no recursion at this depth)
  for (const entry of topSet) {
    const full = join(projectDir, entry);
    let st: import("node:fs").Stats;
    try {
      st = lstatSync(full);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) continue;
    if (st.isFile()) {
      const dot = entry.lastIndexOf(".");
      if (dot > 0) {
        const ext = entry.slice(dot).toLowerCase();
        const lang = LANG_BY_EXT[ext];
        if (lang) langCounts[lang] = (langCounts[lang] || 0) + 1;
      }
    }
  }

  // Recurse into known source dirs if present (capped depth)
  for (const dirName of SCAN_SOURCE_DIRS) {
    if (topSet.has(dirName)) {
      countFilesByLang(join(projectDir, dirName), langCounts, 6);
    }
  }

  // Language list: primary = highest count; secondary = >= 20% of primary count
  const sortedLangs = Object.entries(langCounts).sort((a, b) => b[1] - a[1]);
  let languages: string;
  if (sortedLangs.length === 0) {
    languages = "Unknown";
  } else {
    const primary = sortedLangs[0][0];
    const primaryCount = sortedLangs[0][1];
    const threshold = Math.max(1, Math.floor(primaryCount * 0.2));
    const extras = sortedLangs
      .slice(1)
      .filter(([, c]) => c >= threshold)
      .map(([l]) => l);
    languages = [primary, ...extras].join(", ");
  }

  const frameworks = detectFrameworks(topSet, projectDir);
  const frameworksStr = frameworks.length > 0 ? frameworks.join(", ") : "Unknown";
  const buildSystem = detectBuildSystem(topSet, projectDir);

  // Classification (mirrors workspace-detection.md:66-78)
  const hasSourceFiles = Object.keys(langCounts).length > 0;
  const hasFrameworkConfig = frameworks.length > 0;
  const hasNonDev = topSet.has("package.json") && hasNonDevDeps(projectDir);
  const hasOtherManifest = [
    "requirements.txt",
    "pyproject.toml",
    "setup.py",
    "Cargo.toml",
    "go.mod",
    "pom.xml",
    "build.gradle",
    "build.gradle.kts",
    "composer.json",
    "Gemfile",
  ].some((m) => topSet.has(m));
  const hasAppSourceDir = SCAN_SOURCE_DIRS.some((d) => topSet.has(d));

  const brownfield =
    hasSourceFiles ||
    hasFrameworkConfig ||
    hasNonDev ||
    hasOtherManifest ||
    hasAppSourceDir;

  return {
    projectType: brownfield ? "Brownfield" : "Greenfield",
    languages,
    frameworks: frameworksStr,
    buildSystem,
  };
}

// ---------------------------------------------------------------------------
// init (0.1-0.3) — deterministic: scaffold + scan + state-init in one call
// ---------------------------------------------------------------------------

function findOrphanArtifacts(docsDir: string): string[] {
  const orphans: string[] = [];
  const nonInitPhases = ["ideation", "inception", "construction", "operation", "verification"];
  for (const phase of nonInitPhases) {
    const phaseDir = join(docsDir, phase);
    if (!existsSync(phaseDir)) continue;
    walkForArtifacts(phaseDir, phase, orphans);
  }
  return orphans;
}

const ORPHAN_WALK_IGNORE = new Set([".DS_Store", ".gitkeep", "Thumbs.db"]);

function walkForArtifacts(dir: string, relBase: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (ORPHAN_WALK_IGNORE.has(entry)) continue;
    const full = join(dir, entry);
    let st: import("node:fs").Stats;
    try {
      st = lstatSync(full);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) continue;
    const rel = `${relBase}/${entry}`;
    if (st.isFile()) {
      out.push(rel);
    } else if (st.isDirectory()) {
      walkForArtifacts(full, rel, out);
    }
  }
}

function handleInit(projectDir: string, flags: Record<string, string>): void {
  // Default to poc when --scope is omitted. Matches the orchestrator's
  // ultimate fallback in SKILL.md and makes direct tool invocations
  // (`bun aidlc-utility.ts init`) work without extra flags.
  const scope = flags.scope || "poc";
  if (!validScopes().has(scope)) {
    die(
      `Unknown scope: "${scope}". Valid scopes: ${[...validScopes()].join(", ")}.`
    );
  }

  const depthOverride = flags.depth;
  if (depthOverride && !VALID_DEPTHS[depthOverride.toLowerCase()]) {
    die(`Unknown depth: "${depthOverride}". Valid depths: minimal, standard, comprehensive.`);
  }

  const testStrategyOverride = flags["test-strategy"];
  if (testStrategyOverride && !VALID_TEST_STRATEGIES[testStrategyOverride.toLowerCase()]) {
    die(`Unknown test strategy: "${testStrategyOverride}". Valid: minimal, standard, comprehensive.`);
  }

  const force = flags.force === "true";
  const docsDir = join(projectDir, "aidlc-docs");
  const sp = stateFilePath(projectDir);

  // Guard: refuse quiet re-init on existing state
  if (existsSync(sp) && !force) {
    die(
      `aidlc-state.md already exists at ${sp}. Use --force to reinitialize.`
    );
  }

  // Force path: warn on orphan artifacts, remove only the state file
  if (existsSync(sp) && force) {
    const orphans = existsSync(docsDir) ? findOrphanArtifacts(docsDir) : [];
    if (orphans.length > 0) {
      process.stderr.write(
        `Warning: non-init artifacts found in aidlc-docs/ (will not be removed):\n`
      );
      for (const o of orphans) process.stderr.write(`  - ${o}\n`);
    }
    rmSync(sp);
  }

  const ts = isoTimestamp();

  // ---- Scaffold (stage 0.1) ----

  mkdirSync(docsDir, { recursive: true });

  // audit.md: header-only bootstrap on fresh init. WORKFLOW_STARTED is the
  // birth event for the workflow; SESSION_STARTED is owned by the
  // SessionStart hook and fires independently per Claude Code session. Prior
  // versions emitted a bootstrap SESSION_STARTED here that double-counted
  // every fresh init.
  const auditPath = auditFilePath(projectDir);
  if (!existsSync(auditPath)) {
    writeFileSync(auditPath, `# AI-DLC Audit Log\n`, "utf-8");
  }

  // WORKFLOW_STARTED — mandatory first event of any new workflow. Captures the
  // birth timestamp so "when did this feature begin?" is answerable from the
  // audit alone. Fires on both fresh init and --force re-init (the latter
  // starts a new workflow logically, even if audit.md carries prior history).
  appendAuditEvent(projectDir, "WORKFLOW_STARTED", {
    Scope: scope,
    Request: `/aidlc ${flags.arguments || (force ? "--init --force" : "--init")}`,
  });

  // PHASE_STARTED for the Init phase — Init always runs. Other phases emit
  // PHASE_STARTED at their boundary (via aidlc-state.ts advance) or
  // PHASE_SKIPPED right now if the scope excludes them.
  const initStageCount = stagesInScope(scope).filter(
    (s) => s.phase === "initialization" && s.action === "EXECUTE"
  ).length;
  appendAuditEvent(projectDir, "PHASE_STARTED", {
    Phase: "initialization",
    "Stage count": String(initStageCount),
    Scope: scope,
  });

  // PHASE_SKIPPED — one per phase the scope excludes entirely (no EXECUTE
  // stages in that phase). Captures the scope decision at workflow birth so
  // you don't have to derive it later by diffing the stage list.
  for (const phase of PHASES) {
    if (phase === "initialization") continue;
    const inPhase = stagesInScope(scope).filter((s) => s.phase === phase);
    const anyExecute = inPhase.some((s) => s.action === "EXECUTE");
    if (!anyExecute && inPhase.length > 0) {
      appendAuditEvent(projectDir, "PHASE_SKIPPED", {
        Phase: phase,
        Scope: scope,
        Reason: `scope ${scope} excludes ${phase}`,
      });
    }
  }

  appendAuditEvent(projectDir, "STAGE_STARTED", {
    Stage: "workspace-scaffold",
    Agent: "orchestrator",
  });

  // Copy scaffold seed directories (stage artifact dirs)
  const scaffoldSrc = join(TOOLS_DIR, "data", "scaffold");
  if (existsSync(scaffoldSrc)) {
    const phases = readdirSync(scaffoldSrc);
    for (const phase of phases) {
      const phaseSrc = join(scaffoldSrc, phase);
      const phaseDst = join(docsDir, phase);
      mkdirSync(phaseDst, { recursive: true });
      try {
        const stages = readdirSync(phaseSrc);
        for (const stage of stages) {
          const dst = join(phaseDst, stage);
          if (!existsSync(dst)) {
            mkdirSync(dst, { recursive: true });
          }
        }
      } catch {
        // skip non-dir entries
      }
    }
  }

  // Knowledge directories with READMEs
  const knowledgeDir = join(docsDir, "knowledge");
  mkdirSync(knowledgeDir, { recursive: true });

  const topReadmePath = join(knowledgeDir, "README.md");
  if (!existsSync(topReadmePath)) {
    const templatePath = join(
      TOOLS_DIR,
      "..",
      "knowledge",
      "aidlc-shared",
      "knowledge-readme-template.md"
    );
    let topReadme: string;
    if (existsSync(templatePath)) {
      topReadme = readFileSync(templatePath, "utf-8");
    } else {
      topReadme =
        "# Team Knowledge\n\nAdd markdown files here to extend AI-DLC agent behavior for your project.\n";
    }
    writeFileSync(topReadmePath, topReadme, "utf-8");
  }

  const sharedDir = join(knowledgeDir, "aidlc-shared");
  mkdirSync(sharedDir, { recursive: true });
  const sharedReadme = join(sharedDir, "README.md");
  if (!existsSync(sharedReadme)) {
    writeFileSync(
      sharedReadme,
      "# Shared Knowledge\n\nAdd files here that ALL agents should load — company standards, project context, domain glossary.\n",
      "utf-8"
    );
  }

  for (const agent of loadAgents()) {
    const dir = join(knowledgeDir, agent.slug);
    mkdirSync(dir, { recursive: true });
    const readme = join(dir, "README.md");
    if (!existsSync(readme)) {
      const examplesStr = agent.examples.map((e) => `- ${e}`).join("\n");
      writeFileSync(
        readme,
        `# ${agent.display_name} Knowledge

Add markdown files here to customize ${agent.slug} behavior for your project.

Examples of what to include:
${examplesStr}

Files here are loaded at step 5 of the knowledge loading order, after built-in methodology.
`,
        "utf-8"
      );
    }
  }

  appendAuditEvent(projectDir, "WORKSPACE_SCAFFOLDED", {
    Request: `/aidlc ${flags.arguments || "--init"}`,
    Details: "Directory tree and knowledge READMEs created",
  });
  appendAuditEvent(projectDir, "STAGE_COMPLETED", {
    Stage: "workspace-scaffold",
    Details: "Directory tree and knowledge READMEs created",
  });

  // ---- Workspace detection (stage 0.2) ----

  appendAuditEvent(projectDir, "STAGE_STARTED", {
    Stage: "workspace-detection",
    Agent: "orchestrator",
  });

  const scan = detectWorkspace(projectDir);

  appendAuditEvent(projectDir, "WORKSPACE_SCANNED", {
    "Project Type": scan.projectType,
    Languages: scan.languages,
    Frameworks: scan.frameworks,
    "Build System": scan.buildSystem,
    Details: "Deterministic rule-based scan",
  });
  appendAuditEvent(projectDir, "STAGE_COMPLETED", {
    Stage: "workspace-detection",
    Details: `Classified ${scan.projectType}; languages=${scan.languages}; frameworks=${scan.frameworks}`,
  });

  // ---- State init (stage 0.3) ----

  appendAuditEvent(projectDir, "STAGE_STARTED", {
    Stage: "state-init",
    Agent: "orchestrator",
  });

  const graph = loadStageGraph();
  const scopeMapping = loadScopeMapping();
  const scopeDef = scopeMapping[scope];
  if (!scopeDef) die(`Unknown scope: ${scope}`);
  const effectiveDepth = depthOverride
    ? VALID_DEPTHS[depthOverride.toLowerCase()]
    : scopeDef.depth;
  const effectiveTestStrategy = testStrategyOverride
    ? VALID_TEST_STRATEGIES[testStrategyOverride.toLowerCase()]
    : (scopeDef.testStrategy ?? effectiveDepth);

  // Compute stages to execute/skip
  const executeStages: string[] = [];
  const skipStages: string[] = [];
  for (const stage of graph) {
    const action = scopeDef.stages[stage.slug] || "SKIP";
    if (action === "EXECUTE") {
      executeStages.push(stage.number);
    } else {
      skipStages.push(`${stage.number} (${stage.slug})`);
    }
  }

  // For greenfield, reverse-engineering becomes SKIP
  const adjustedMapping = { ...scopeDef.stages };
  if (scan.projectType.toLowerCase() === "greenfield") {
    if (adjustedMapping["reverse-engineering"] === "EXECUTE") {
      adjustedMapping["reverse-engineering"] = "SKIP";
      const reStage = graph.find((s) => s.slug === "reverse-engineering");
      if (reStage) {
        const idx = executeStages.indexOf(reStage.number);
        if (idx >= 0) executeStages.splice(idx, 1);
        skipStages.push(`${reStage.number} (reverse-engineering — greenfield)`);
      }
    }
  }

  // Build stage progress checkboxes
  let stageProgress = "";
  const phaseMap: Record<string, typeof graph> = {};
  for (const stage of graph) {
    if (!phaseMap[stage.phase]) phaseMap[stage.phase] = [];
    phaseMap[stage.phase].push(stage);
  }

  const phaseHeaders: Record<string, string> = {
    initialization: "INITIALIZATION PHASE",
    ideation: "IDEATION PHASE",
    inception: "INCEPTION PHASE",
    construction: "CONSTRUCTION PHASE",
    operation: "OPERATION PHASE",
  };

  for (const phase of PHASES) {
    const stages = phaseMap[phase] || [];
    stageProgress += `\n### ${phaseHeaders[phase]}\n`;
    if (phase === "construction") {
      stageProgress += "Per unit: [TBD]\n";
    }
    for (const stage of stages) {
      const action =
        adjustedMapping[stage.slug] || scopeDef.stages[stage.slug] || "SKIP";
      const isInit = phase === "initialization";
      const marker = isInit ? "[x]" : "[ ]";
      const suffix = action === "EXECUTE" ? "EXECUTE" : `SKIP`;
      stageProgress += `- ${marker} ${stage.slug} — ${suffix}\n`;
    }
  }

  const firstPostInit = determineFirstPostInitStage(adjustedMapping, graph);
  stageProgress = stageProgress.replace(
    `- [ ] ${firstPostInit}`,
    `- [-] ${firstPostInit}`
  );

  const totalInScope = executeStages.length;
  const completedInit = graph.filter((s) => s.phase === "initialization").length;

  const firstPostInitEntry = graph.find((s) => s.slug === firstPostInit);
  const firstPostInitPhase = firstPostInitEntry
    ? firstPostInitEntry.phase.toUpperCase()
    : "IDEATION";
  const firstPostInitAgent = firstPostInitEntry
    ? firstPostInitEntry.lead_agent
    : "aidlc-product-agent";

  const nextAfterFirst = nextInScopeStage(firstPostInit, scope);
  const nextStageName = nextAfterFirst ? nextAfterFirst.slug : "none";

  const projectDesc = flags.arguments || "[Project description]";

  // Phase Progress — per-phase status. Initialization is always Active at init
  // time. Other phases are Skipped if the adjusted scope mapping has zero
  // EXECUTE stages for that phase, otherwise Pending. Pending phases flip to
  // Active on their phase-boundary advance and to Verified at phase completion.
  const phaseStatus = (phase: string): string => {
    if (phase === "initialization") return "Active";
    const stagesInPhase = graph.filter((s) => s.phase === phase);
    const hasExecute = stagesInPhase.some(
      (s) => (adjustedMapping[s.slug] || scopeDef.stages[s.slug] || "SKIP") === "EXECUTE"
    );
    return hasExecute ? "Pending" : "Skipped";
  };
  const phaseProgressLines = [
    `- **Initialization**: ${phaseStatus("initialization")}`,
    `- **Ideation**: ${phaseStatus("ideation")}`,
    `- **Inception**: ${phaseStatus("inception")}`,
    `- **Construction**: ${phaseStatus("construction")}`,
    `- **Operation**: ${phaseStatus("operation")}`,
  ].join("\n");

  const stateContent = `# AI-DLC State Tracking

## Project Information
- **Project**: ${projectDesc}
- **Project Type**: ${scan.projectType}
- **Scope**: ${scope}
- **Start Date**: ${ts}
- **State Version**: 7
- **Active Agent**: ${firstPostInitAgent}
- **Worktree Path**:
- **Bolt Refs**:
- **Practices Affirmed Timestamp**:

## Scope Configuration
- **Stages to Execute**: ${executeStages.join(", ")}
- **Stages to Skip**: ${skipStages.length > 0 ? skipStages.join(", ") : "none"}
- **Depth**: ${effectiveDepth}
- **Test Strategy**: ${effectiveTestStrategy}

## Workspace State
- **Project Root**: ${projectDir}
- **Languages**: ${scan.languages}
- **Frameworks**: ${scan.frameworks}
- **Build System**: ${scan.buildSystem}

## Execution Plan Summary
- **Total Stages**: ${totalInScope}
- **Completed**: ${completedInit}
- **In Progress**: ${firstPostInit}

## Runtime State
- **Revision Count**: 0
${flags["test-run"] === "true" ? "- **Test Run Mode**: true\n" : ""}

## Phase Progress
<!-- Status values: Pending, Active, Verified, Skipped -->

${phaseProgressLines}

## Stage Progress
<!-- Checkbox states: [ ] not started, [-] in progress, [?] awaiting approval (gate open), [R] revising (user rejected gate), [x] completed, [S] skipped via --stage/--phase jump -->
${stageProgress}
## Current Status
- **Lifecycle Phase**: ${firstPostInitPhase}
- **Current Stage**: ${firstPostInit}
- **Next Stage**: ${nextStageName}
- **Status**: Running
- **Last Updated**: ${ts}

## Session Resume Point
- **Last Completed Stage**: state-init
- **Next Action**: Execute ${firstPostInit}
- **Pending Artifacts**: none
`;

  writeStateFile(projectDir, stateContent);

  appendAuditEvent(projectDir, "WORKSPACE_INITIALISED", {
    Request: "/aidlc --init",
    "Project Type": scan.projectType,
    Scope: scope,
    Languages: scan.languages,
    Frameworks: scan.frameworks,
    "Build System": scan.buildSystem,
    Details: `${totalInScope} stages in scope, routing to ${firstPostInit}`,
  });
  appendAuditEvent(projectDir, "STAGE_COMPLETED", {
    Stage: "state-init",
    Details: `State initialized: ${scope} scope, ${totalInScope} stages, routing to ${firstPostInit}`,
  });

  // Phase hand-off: initialization → first post-init phase. The state file
  // advertises Current Stage = first post-init, so the audit must reflect
  // the same transition (PHASE_COMPLETED + PHASE_VERIFIED + PHASE_STARTED +
  // STAGE_STARTED) to keep the two streams coherent. Without these, the first
  // subsequent `advance` call would appear to jump from workspace-scaffold
  // directly into a fresh phase.
  if (firstPostInitEntry && firstPostInitEntry.phase !== "initialization") {
    appendAuditEvent(projectDir, "PHASE_COMPLETED", {
      "From phase": "initialization",
      "To phase": firstPostInitEntry.phase,
      "Stages completed": String(completedInit),
    });
    appendAuditEvent(projectDir, "PHASE_VERIFIED", {
      "Phase boundary": `initialization → ${firstPostInitEntry.phase}`,
    });
    appendAuditEvent(projectDir, "PHASE_STARTED", {
      Phase: firstPostInitEntry.phase,
      Scope: scope,
    });
    appendAuditEvent(projectDir, "STAGE_STARTED", {
      Stage: firstPostInit,
      Agent: firstPostInitAgent,
    });
  }

  // Combined stdout summary (scaffold + state-init blocks)
  process.stdout.write(
    `Workspace scaffolded:
  aidlc-docs/knowledge/           (team knowledge — 11 agent dirs + aidlc-shared)
  aidlc-docs/initialization/      (3 stage artifact dirs)
  aidlc-docs/ideation/            (7 stage artifact dirs)
  aidlc-docs/inception/           (7 stage artifact dirs)
  aidlc-docs/construction/        (2 stage artifact dirs)
  aidlc-docs/operation/           (7 stage artifact dirs)
  aidlc-docs/verification/
State initialized: ${scope} scope, ${totalInScope} stages, ${effectiveDepth} depth
Project type: ${scan.projectType}
Languages: ${scan.languages}
Frameworks: ${scan.frameworks}
Build System: ${scan.buildSystem}
First post-init stage: ${firstPostInit} (${firstPostInitPhase})
`
  );
}

// ---------------------------------------------------------------------------
// state-init — deprecated, merged into init
// ---------------------------------------------------------------------------

function handleStateInit(_projectDir: string, _flags: Record<string, string>): void {
  die(
    "state-init is merged into init. Run 'bun aidlc-utility.ts init --scope <scope>' instead."
  );
}


// Caller is responsible for applying any scope- or project-type-specific
// downgrades (e.g., reverse-engineering SKIP for greenfield) to the mapping
// before calling this helper. Walks post-init stages and returns the slug of
// the first EXECUTE entry.
function determineFirstPostInitStage(
  adjustedMapping: Record<string, string>,
  graph: StageEntry[]
): string {
  for (const stage of graph) {
    if (stage.phase === "initialization") continue;
    const action = adjustedMapping[stage.slug] || "SKIP";
    if (action === "EXECUTE") {
      return stage.slug;
    }
  }
  return "intent-capture"; // fallback
}

// ---------------------------------------------------------------------------
// scope-change — atomically change scope on an existing workflow
// ---------------------------------------------------------------------------

function handleScopeChange(projectDir: string, flags: Record<string, string>): void {
  const newScope = flags.scope;
  if (!newScope) die("--scope is required for scope-change");

  const depthOverride = flags.depth;
  if (depthOverride && !VALID_DEPTHS[depthOverride.toLowerCase()]) {
    die(`Unknown depth: "${depthOverride}". Valid depths: minimal, standard, comprehensive.`);
  }

  const testStrategyOverride = flags["test-strategy"];
  if (testStrategyOverride && !VALID_TEST_STRATEGIES[testStrategyOverride.toLowerCase()]) {
    die(`Unknown test strategy: "${testStrategyOverride}". Valid: minimal, standard, comprehensive.`);
  }

  const sp = stateFilePath(projectDir);
  if (!existsSync(sp)) die("No state file found. Run /aidlc --init first.");

  const scopeMapping = loadScopeMapping();
  const newScopeDef = scopeMapping[newScope];
  if (!newScopeDef) die(`Unknown scope: ${newScope}. Valid scopes: ${Object.keys(scopeMapping).join(", ")}`);

  let content = readStateFile(projectDir);
  const oldScope = getField(content, "Scope");
  if (!oldScope) die("Cannot read current Scope from state file.");

  if (oldScope === newScope) {
    process.stdout.write(`Scope is already ${newScope}\n`);
    return;
  }

  const graph = loadStageGraph();
  const projectType = getField(content, "Project Type") || "Greenfield";

  // Compute adjusted mapping (greenfield reverse-engineering adjustment)
  const adjustedMapping = { ...newScopeDef.stages };
  if (projectType.toLowerCase() === "greenfield") {
    if (adjustedMapping["reverse-engineering"] === "EXECUTE") {
      adjustedMapping["reverse-engineering"] = "SKIP";
    }
  }

  // Compute new execute/skip lists
  const executeStages: string[] = [];
  const skipStages: string[] = [];
  for (const stage of graph) {
    const action = adjustedMapping[stage.slug] || "SKIP";
    if (action === "EXECUTE") {
      executeStages.push(stage.number);
    } else {
      let reason = stage.slug;
      if (stage.slug === "reverse-engineering" && projectType.toLowerCase() === "greenfield" &&
          newScopeDef.stages["reverse-engineering"] === "EXECUTE") {
        reason += " — greenfield";
      }
      skipStages.push(`${stage.number} (${reason})`);
    }
  }

  // Parse existing checkboxes to preserve states
  const existingCheckboxes = parseCheckboxes(content);
  const existingMap = new Map(existingCheckboxes.map(c => [c.slug, c]));

  // Rebuild Stage Progress section
  const phaseMap: Record<string, typeof graph> = {};
  for (const stage of graph) {
    if (!phaseMap[stage.phase]) phaseMap[stage.phase] = [];
    phaseMap[stage.phase].push(stage);
  }

  const phaseHeaders: Record<string, string> = {
    initialization: "INITIALIZATION PHASE",
    ideation: "IDEATION PHASE",
    inception: "INCEPTION PHASE",
    construction: "CONSTRUCTION PHASE",
    operation: "OPERATION PHASE",
  };

  let newStageProgress = "";
  for (const phase of PHASES) {
    const stages = phaseMap[phase] || [];
    newStageProgress += `\n### ${phaseHeaders[phase]}\n`;
    if (phase === "construction") {
      // Preserve existing "Per unit:" line
      const perUnitMatch = content.match(/^Per unit:.*$/m);
      if (perUnitMatch) {
        newStageProgress += `${perUnitMatch[0]}\n`;
      }
    }
    for (const stage of stages) {
      const action = adjustedMapping[stage.slug] || "SKIP";
      const existing = existingMap.get(stage.slug);
      // Preserve existing checkbox state, default to [ ] if not found
      const marker = existing
        ? `[${existing.state === "completed" ? "x" : existing.state === "in-progress" ? "-" : existing.state === "skipped" ? "S" : " "}]`
        : "[ ]";
      const suffix = action === "EXECUTE" ? "EXECUTE" : "SKIP";
      newStageProgress += `- ${marker} ${stage.slug} \u2014 ${suffix}\n`;
    }
  }

  // Replace Stage Progress section in content
  const stageProgressRegex = /## Stage Progress\n<!-- [^\n]* -->\n([\s\S]*?)(?=\n## (?!Stage Progress))/;
  const stageProgressHeader = "## Stage Progress\n<!-- Checkbox states: [ ] not started, [-] in progress, [x] completed, [S] skipped via --stage/--phase jump -->\n";
  content = content.replace(stageProgressRegex, stageProgressHeader + newStageProgress);

  // Update fields
  content = setField(content, "Scope", newScope);
  content = setField(content, "Stages to Execute", executeStages.join(", "));
  content = setField(content, "Stages to Skip", skipStages.length > 0 ? skipStages.join(", ") : "none");
  const effectiveDepth = depthOverride
    ? VALID_DEPTHS[depthOverride.toLowerCase()]
    : newScopeDef.depth;
  content = setField(content, "Depth", effectiveDepth);
  const effectiveTestStrategy = testStrategyOverride
    ? VALID_TEST_STRATEGIES[testStrategyOverride.toLowerCase()]
    : (newScopeDef.testStrategy ?? effectiveDepth);
  content = setField(content, "Test Strategy", effectiveTestStrategy);
  content = setField(content, "Total Stages", String(executeStages.length));

  // Recount completed based on actual [x] count of in-scope EXECUTE stages
  const updatedCheckboxes = parseCheckboxes(content);
  const executeSlugs = new Set(
    graph.filter(s => (adjustedMapping[s.slug] || "SKIP") === "EXECUTE").map(s => s.slug)
  );
  const completedCount = updatedCheckboxes.filter(
    c => c.state === "completed" && executeSlugs.has(c.slug)
  ).length;
  content = setField(content, "Completed", String(completedCount));

  // Update Last Updated timestamp
  content = setField(content, "Last Updated", isoTimestamp());

  writeStateFile(projectDir, content);

  // Append SCOPE_CHANGED audit event
  const oldScopeDef = scopeMapping[oldScope];
  const oldExecuteCount = oldScopeDef
    ? graph.filter(s => (oldScopeDef.stages[s.slug] || "SKIP") === "EXECUTE").length
    : 0;
  const stageDelta = executeStages.length - oldExecuteCount;
  const deltaStr = stageDelta >= 0 ? `+${stageDelta}` : String(stageDelta);

  appendAuditEvent(projectDir, "SCOPE_CHANGED", {
    "Old Scope": oldScope,
    "New Scope": newScope,
    "Stage Count Delta": deltaStr,
    "Stages in Scope": String(executeStages.length),
    Depth: effectiveDepth,
  });

  process.stdout.write(
    `Scope changed: ${oldScope} → ${newScope}
Stages in scope: ${executeStages.length} (${deltaStr})
Depth: ${effectiveDepth}
Completed: ${completedCount}/${executeStages.length}
`
  );
}

// ---------------------------------------------------------------------------
// config-change — update depth and/or test-strategy without changing scope
// ---------------------------------------------------------------------------

function handleConfigChange(projectDir: string, flags: Record<string, string>): void {
  const rawDepth = flags.depth;
  const rawStrategy = flags["test-strategy"];

  if (!rawDepth && !rawStrategy) {
    die("config-change requires --depth and/or --test-strategy");
  }

  let newDepth: string | undefined;
  if (rawDepth) {
    newDepth = VALID_DEPTHS[rawDepth.toLowerCase()];
    if (!newDepth) die(`Unknown depth: "${rawDepth}". Valid depths: minimal, standard, comprehensive.`);
  }

  let newStrategy: string | undefined;
  if (rawStrategy) {
    newStrategy = VALID_TEST_STRATEGIES[rawStrategy.toLowerCase()];
    if (!newStrategy) die(`Unknown test strategy: "${rawStrategy}". Valid: minimal, standard, comprehensive.`);
  }

  const sp = stateFilePath(projectDir);
  if (!existsSync(sp)) die("No state file found. Run /aidlc --init first.");

  let content = readStateFile(projectDir);
  const oldDepth = getField(content, "Depth");
  const oldStrategy = getField(content, "Test Strategy");

  // Inline existence checks (instead of caching to a boolean) so TS narrows
  // newDepth / newStrategy at each use site — avoids non-null assertions.
  if (newDepth !== undefined && newDepth !== oldDepth) {
    content = setField(content, "Depth", newDepth);
  }
  if (newStrategy !== undefined && newStrategy !== oldStrategy) {
    content = setField(content, "Test Strategy", newStrategy);
  }
  const depthChanging = newDepth !== undefined && newDepth !== oldDepth;
  const strategyChanging =
    newStrategy !== undefined && newStrategy !== oldStrategy;
  if (depthChanging || strategyChanging) {
    content = setField(content, "Last Updated", isoTimestamp());
    writeStateFile(projectDir, content);
  }

  if (newDepth !== undefined && newDepth !== oldDepth) {
    appendAuditEvent(projectDir, "DEPTH_CHANGED", {
      "Old Depth": oldDepth || "unknown",
      "New Depth": newDepth,
    });
  }
  if (newStrategy !== undefined && newStrategy !== oldStrategy) {
    appendAuditEvent(projectDir, "TEST_STRATEGY_CHANGED", {
      "Old Strategy": oldStrategy || "unknown",
      "New Strategy": newStrategy,
    });
  }

  if (newDepth !== undefined) {
    process.stdout.write(
      depthChanging
        ? `Depth changed: ${oldDepth} → ${newDepth}\n`
        : `Depth is already ${newDepth}\n`
    );
  }
  if (newStrategy !== undefined) {
    process.stdout.write(
      strategyChanging
        ? `Test strategy changed: ${oldStrategy} → ${newStrategy}\n`
        : `Test strategy is already ${newStrategy}\n`
    );
  }
}

// ---------------------------------------------------------------------------
// set-status — atomically update statusline fields at stage start
// ---------------------------------------------------------------------------

function handleSetStatus(projectDir: string, flags: Record<string, string>): void {
  const sp = stateFilePath(projectDir);
  if (!existsSync(sp)) die("No state file found. Run /aidlc --init first.");

  const stage = flags.stage;
  if (!stage) die("--stage is required for set-status");

  const entry = findStageBySlug(stage);
  if (!entry) die(`Unknown stage: ${stage}`);

  const phase = (flags.phase || entry.phase).toUpperCase();
  const agent = flags.agent || entry.lead_agent;

  let content = readStateFile(projectDir);
  content = setField(content, "Lifecycle Phase", phase);
  content = setField(content, "Current Stage", stage);
  content = setField(content, "Active Agent", agent);
  content = setField(content, "In Progress", stage);
  content = setField(content, "Status", "Running");
  content = setField(content, "Last Updated", isoTimestamp());
  content = setCheckbox(content, stage, "in-progress");
  writeStateFile(projectDir, content);

  process.stdout.write(`${JSON.stringify({ updated: true, phase, stage, agent })}\n`);
}

// ---------------------------------------------------------------------------
// enable-test-run — persist Test Run Mode flag in existing state file
// ---------------------------------------------------------------------------

function handleEnableTestRun(projectDir: string): void {
  const sp = stateFilePath(projectDir);
  if (!existsSync(sp)) die("No state file found. Run /aidlc --init first.");

  let content = readStateFile(projectDir);

  // Already present — no-op
  if (/\*\*Test Run Mode\*\*/.test(content)) {
    process.stdout.write("Test Run Mode already set in state file.\n");
    return;
  }

  // Insert after Revision Count line in Runtime State section
  content = content.replace(
    /^(- \*\*Revision Count\*\*:.*)$/m,
    "$1\n- **Test Run Mode**: true"
  );

  writeStateFile(projectDir, content);

  appendAuditEvent(projectDir, "TEST_RUN_MODE_ENABLED", {
    Details: "Test Run Mode persisted to state file on resume",
  });

  process.stdout.write("Test Run Mode enabled in state file.\n");
}

// ---------------------------------------------------------------------------
// Scope inference from freeform text
//
// The keyword sets live in each scope's `.claude/scopes/aidlc-<name>.md`
// frontmatter `keywords` field; this
// helper resolves the scope using word-boundary matching (so "debug"
// does not match "bug"),
// alphabetical iteration over scopes (so first-match-wins is
// deterministic), and a ">5 word" heuristic that falls back to `feature`
// when the input looks like a project description that happens to
// contain a keyword.
//
// Exported for t67 unit tests; not a stable public API.

export interface InferResult {
  scope: string;
  source: "keyword" | "freeform";
  matches: Array<{ scope: string; keyword: string }>;
}

export function inferScopeFromText(input: string): InferResult {
  const text = input.toLowerCase();
  const trimmed = input.trim();
  const wordCount = trimmed.length === 0 ? 0 : trimmed.split(/\s+/).length;
  const mapping = loadScopeMapping();
  const allMatches: Array<{ scope: string; keyword: string }> = [];

  // Iterate in alphabetical order for determinism (not JSON insertion
  // order). validScopes() already returns a sorted set. Multi-word
  // keywords like "proof of concept" allow any whitespace run between
  // tokens, so "proof  of  concept" (double-spaced) still matches.
  for (const scope of [...validScopes()]) {
    const keywords = mapping[scope]?.keywords ?? [];
    for (const kw of keywords) {
      const tokens = kw.toLowerCase().trim().split(/\s+/).map(escapeRegex);
      const re = new RegExp(`\\b${tokens.join("\\s+")}\\b`, "i");
      if (re.test(text)) {
        allMatches.push({ scope, keyword: kw });
        break; // One keyword per scope is enough to mark it matched.
      }
    }
  }

  // Disambiguation: keyword + >5 words → likely a project description
  // containing the keyword incidentally. Default to feature. Also:
  // no matches at all → feature as well.
  if (allMatches.length === 0 || wordCount > 5) {
    return { scope: "feature", source: "freeform", matches: allMatches };
  }

  // First alphabetical match wins (deterministic across calls).
  return {
    scope: allMatches[0].scope,
    source: "keyword",
    matches: allMatches,
  };
}

/** Doctor uses this for keyword-overlap detection. */
export function findScopeByKeyword(kw: string): string[] {
  const mapping = loadScopeMapping();
  const hits: string[] = [];
  for (const scope of [...validScopes()]) {
    if (
      (mapping[scope]?.keywords ?? []).some(
        (k) => k.toLowerCase() === kw.toLowerCase()
      )
    ) {
      hits.push(scope);
    }
  }
  return hits;
}

// ---------------------------------------------------------------------------
// scope-table — compiled summary of the scope grid for SKILL.md
//
// Emits a Markdown table delimited by BEGIN/END HTML comments. SKILL.md
// has a matching region that is regenerated via this tool. --check mode
// byte-compares the current SKILL.md region against the rendered output
// and exits 1 on drift. Mirrors aidlc-graph.ts compile / compile --check.
//
// AIDLC_SKILL_MD_PATH env-seam lets t67 sandbox --check against a
// fixture SKILL.md (so drift tests never mutate the real file).

const SCOPE_TABLE_BEGIN =
  "<!-- BEGIN: compiled scope grid via `bun aidlc-utility.ts scope-table` — do NOT hand-edit -->";
const SCOPE_TABLE_END =
  "<!-- END: compiled scope grid -->";

/** Exported for t67 unit tests. */
export function renderScopeTable(): string {
  const mapping = loadScopeMapping();
  const scopes = [...validScopes()]; // alphabetical
  const lines = [
    "| Scope          | Depth         | TestStrategy | EXECUTE / Total |",
    "|----------------|---------------|--------------|-----------------|",
  ];
  for (const name of scopes) {
    const def = mapping[name];
    const stages = def.stages;
    const total = Object.keys(stages).length;
    const execute = Object.values(stages).filter((v) => v === "EXECUTE").length;
    const depth = def.depth;
    const ts = def.testStrategy ?? "(default)";
    lines.push(
      `| ${name.padEnd(14)} | ${depth.padEnd(13)} | ${ts.padEnd(12)} | ${`${execute} / ${total}`.padEnd(15)} |`
    );
  }
  return lines.join("\n");
}

/** Canonical byte-shape: BEGIN\n\n<table>\n\nEND. */
export function canonicalScopeTableRegion(table: string): string {
  return `${SCOPE_TABLE_BEGIN}\n\n${table}\n\n${SCOPE_TABLE_END}`;
}

function skillMdPath(): string {
  return (
    process.env.AIDLC_SKILL_MD_PATH ??
    join(TOOLS_DIR, "..", "skills", "aidlc", "SKILL.md")
  );
}

function handleScopeTable(
  _projectDir: string,
  _flags: Record<string, string>,
  rawArgs: string[]
): void {
  const check = rawArgs.includes("--check");
  const expectedRegion = canonicalScopeTableRegion(renderScopeTable());

  if (!check) {
    process.stdout.write(`${expectedRegion}\n`);
    return;
  }

  const skillPath = skillMdPath();
  let skillRaw: string;
  try {
    skillRaw = readFileSync(skillPath, "utf-8");
  } catch (err) {
    console.error(
      `SKILL.md not readable at ${skillPath}: ${errorMessage(err)}`
    );
    process.exit(1);
  }

  // Normalize line endings before comparison so Windows CRLF files
  // (core.autocrlf=true) don't false-positive as drifted.
  skillRaw = skillRaw.replace(/\r\n/g, "\n");

  const beginIdx = skillRaw.indexOf(SCOPE_TABLE_BEGIN);
  const lastBeginIdx = skillRaw.lastIndexOf(SCOPE_TABLE_BEGIN);
  const endIdx = skillRaw.indexOf(SCOPE_TABLE_END);
  const lastEndIdx = skillRaw.lastIndexOf(SCOPE_TABLE_END);
  if (beginIdx === -1 || endIdx === -1) {
    console.error(
      `SKILL.md at ${skillPath} is missing scope-table markers. Expected:\n  ${SCOPE_TABLE_BEGIN}\n  ${SCOPE_TABLE_END}`
    );
    process.exit(1);
  }
  if (beginIdx !== lastBeginIdx || endIdx !== lastEndIdx) {
    console.error(
      `SKILL.md at ${skillPath} has duplicate scope-table markers. Expected exactly one BEGIN and one END.`
    );
    process.exit(1);
  }
  if (endIdx < beginIdx) {
    console.error(
      `SKILL.md at ${skillPath} has scope-table markers out of order (END before BEGIN).`
    );
    process.exit(1);
  }

  const currentRegion = skillRaw.substring(
    beginIdx,
    endIdx + SCOPE_TABLE_END.length
  );

  if (currentRegion === expectedRegion) {
    return; // exit 0 silent
  }

  console.error(
    `SKILL.md scope-table region is out of date. Run \`bun ${harnessDir()}/tools/aidlc-utility.ts scope-table\` and paste the output between the BEGIN/END markers.`
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// detect-scope — record a scope-detection event
//
// Two modes:
//   1. Explicit: `--scope <scope> --input <text> [--source ...]`.
//      Recorded unchanged.
//   2. Inference: `--from-text --input <text>`.
//      Resolves the scope via inferScopeFromText and emits SCOPE_DETECTED
//      with Source=keyword (match) or Source=freeform (default fallback).
//
// Passing both `--scope` and `--from-text` is an error — they are
// mutually exclusive modes. Missing both is also an error.

const VALID_SCOPE_SOURCES: ReadonlySet<string> = new Set([
  "freeform",
  "keyword",
  "env",
  "cli",
]);

function handleDetectScope(
  projectDir: string,
  flags: Record<string, string>
): void {
  const fromText = flags["from-text"] !== undefined;
  const explicitScope = flags.scope;

  if (fromText && explicitScope) {
    die(
      "Cannot combine --from-text and --scope. Use one or the other."
    );
  }
  if (!fromText && !explicitScope) {
    die(
      "Missing --scope <scope> (or pass --from-text to infer from --input)."
    );
  }

  // --input requirement differs by mode:
  //   --scope mode: --input is required (audit event needs original text).
  //   --from-text mode: --input may be empty string — inferScopeFromText
  //     returns `feature` as the documented default. Missing --input
  //     entirely is still an error; an empty string is fine.
  const input = flags.input;
  if (input === undefined) {
    die("Missing --input <original-text>");
  }
  if (!fromText && input === "") {
    die("--input cannot be empty under --scope mode.");
  }

  let scope: string;
  let source: string;
  let matchedKeywords: string[] = [];

  if (fromText) {
    const result = inferScopeFromText(input);
    scope = result.scope;
    source = result.source;
    matchedKeywords = result.matches.map((m) => m.keyword);
  } else {
    scope = explicitScope;
    source = flags.source || "freeform";
    if (!VALID_SCOPE_SOURCES.has(source)) {
      die(
        `Unknown source: "${source}". Valid: ${[...VALID_SCOPE_SOURCES].join(", ")}.`
      );
    }
  }

  if (!validScopes().has(scope)) {
    die(
      `Unknown scope: "${scope}". Valid scopes: ${[...validScopes()].join(", ")}.`
    );
  }

  const auditFields: Record<string, string> = {
    "Detected scope": scope,
    "Input text": input,
    Source: source,
  };
  if (matchedKeywords.length > 0) {
    auditFields["Matched keywords"] = matchedKeywords.join(", ");
  }
  appendAuditEvent(projectDir, "SCOPE_DETECTED", auditFields);

  process.stdout.write(
    `${JSON.stringify({
      emitted: "SCOPE_DETECTED",
      scope,
      source,
      matches: matchedKeywords,
    })}\n`
  );
}

// ---------------------------------------------------------------------------
// resolve-env-scope — validate AWS_AIDLC_DEFAULT_SCOPE and emit its value
//
// The orchestrator's step 0 in SKILL.md calls this to resolve the env default
// deterministically. Behavior:
//   - Env unset or empty: exit 0, no output. The orchestrator takes the
//     non-env path (CLI flag, keyword detection, or hard-coded fallback).
//   - Env set to a valid scope: exit 0, print `scope=<value>` to stdout.
//     The orchestrator synthesizes `--scope <value>` into $ARGUMENTS.
//   - Env set to an invalid value: exit 1, print the canonical error message
//     to stderr. The orchestrator stops without mutating state.
//
// Centralising validation here (instead of leaving it to LLM prose) guarantees
// the error message shape and guarantees invalid env never reaches scope-change
// / state-init.
// ---------------------------------------------------------------------------

function handleResolveEnvScope(): void {
  const envScope = (process.env.AWS_AIDLC_DEFAULT_SCOPE || "").trim();
  if (envScope === "") {
    return; // unset — no output, exit 0
  }
  if (!validScopes().has(envScope)) {
    die(
      `Invalid AWS_AIDLC_DEFAULT_SCOPE "${envScope}". Valid scopes: ${[...validScopes()].join(", ")}.`
    );
  }
  process.stdout.write(`scope=${envScope}\n`);
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

function main(): void {
  const rawArgs = process.argv.slice(2);
  const { positional, flags } = parseArgs(rawArgs);
  const subcommand = positional[0];
  const projectDir = resolveProjectDir(flags["project-dir"]);

  switch (subcommand) {
    case "help":
      handleHelp();
      break;
    case "version":
      handleVersion();
      break;
    case "status":
      handleStatus(projectDir);
      break;
    case "doctor":
      handleDoctor(projectDir);
      break;
    case "init":
      handleInit(projectDir, flags);
      break;
    case "state-init":
      handleStateInit(projectDir, flags);
      break;
    case "scope-change":
      handleScopeChange(projectDir, flags);
      break;
    case "config-change":
      handleConfigChange(projectDir, flags);
      break;
    case "set-status":
      handleSetStatus(projectDir, flags);
      break;
    case "enable-test-run":
      handleEnableTestRun(projectDir);
      break;
    case "detect-scope":
      handleDetectScope(projectDir, flags);
      break;
    case "resolve-env-scope":
      handleResolveEnvScope();
      break;
    case "scope-table":
      handleScopeTable(projectDir, flags, rawArgs);
      break;
    default:
      die(
        `Usage: aidlc-utility <help|version|status|doctor|init|scope-change|config-change|set-status|enable-test-run|detect-scope|resolve-env-scope|scope-table> [--project-dir <path>] [--scope <scope>] [--force]`
      );
  }
}

if (import.meta.main) main();
