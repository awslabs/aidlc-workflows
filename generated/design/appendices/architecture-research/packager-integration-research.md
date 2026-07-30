# Packager Integration & Manifest Domain Research

## Research Domain

This domain covers how the AI-DLC packager (`bun scripts/package.ts`) discovers and processes
harness manifests, the exact `EmitContext` type signature passed to emit functions, how existing
emitters transform `core/memory/` content into harness-native formats, the `coreDirs`/`harnessFiles`
mapping patterns, `{{HARNESS_DIR}}` token substitution mechanics, and the onboarding template + fills
pattern. The immediate application is implementing `harness/cursor/manifest.ts` and `harness/cursor/emit.ts`.

---

## ProServe Skills Reference Design

**Matched file**: `.apex/proserve-skills-designs/ai-dlc/to-harness-pipeline.md`

**Summary**: Describes composing AI-DLC (design intake) with a long-running app harness into a
customer-deployable delivery pipeline. The design covers BUILD_PLAN compilation, delta reporting,
harness customization seams, and customer discovery templates.

**Why the match applies**: The file documents the pattern of a thin per-harness authored surface
(a `manifest.ts` declaring what to project) being consumed by a central build pipeline. The
customization seam pattern (declarative config + escape-hatch hook module) directly maps to the
`coreDirs`/`emit` split in the packager.

**Gaps vs. project requirements**: The ProServe design targets a customer delivery pipeline (Python,
Bedrock AgentCore). It does not address the Cursor harness specifics—`RULE.md` generation, Cursor
hook JSON format, or `cli.json` permissions. The build pipeline mechanics described in the ProServe
design are superseded by the actual `scripts/package.ts` source code inspected below.

---

## Reference Architectures

No external AWS reference architectures apply. This domain is entirely internal to the
`aidlc-workflows` repository. All findings come from direct source inspection.

**Source authority**: `scripts/package.ts`, `scripts/manifest-types.ts`, `scripts/onboarding.ts`,
`harness/codex/emit.ts`, `harness/opencode/emit.ts`, and all four existing `harness/*/manifest.ts`
files. These are the canonical reference for the Cursor harness implementation.

---

## Managed Services

Not applicable. This is a local developer tooling domain (TypeScript, Bun runtime). No AWS managed
services are involved.

---

## Service Lifecycle Status

Not applicable.

---

## Service Limits/Quotas

Not applicable.

---

## Service & Feature Parity

Not applicable. No cloud partition deployment.

---

## Detailed Research

### 1. EmitContext Type Signature

Source: `scripts/manifest-types.ts` (direct inspection)

```typescript
export type EmitContext = {
  /** Absolute path to the repo root. */
  repoRoot: string;
  /** Absolute path to core/ (the harness-neutral source). */
  coreRoot: string;
  /** Absolute path to harness/<name>/ (this harness's authored surfaces). */
  harnessRoot: string;
  /** Absolute path to the dist tree root for this harness (e.g. <repo>/dist/codex). */
  distRoot: string;
  /** The harness directory name (".claude" | ".kiro" | ".codex"). */
  harnessDir: string;
  /** Substitute {{HARNESS_DIR}} → this harness's dir in a prose string. */
  substituteToken: (s: string) => string;
  /**
   * The pack-time tier cap the packager resolved (AIDLC_TIER_CAP env var
   * over the core/memory tier_cap: layers).
   */
  tierCap: "judgment" | "balanced" | "templated" | null;
};
```

**Key implications for Cursor emitter**:
- `ctx.coreRoot` → absolute path to `core/`; use `join(ctx.coreRoot, "memory")` to reach `core/memory/`
- `ctx.harnessRoot` → absolute path to `harness/cursor/`; use for authored files
- `ctx.distRoot` → the `dist/cursor/` tree root (NOT `dist/cursor/.cursor/`); construct `CURSOR_ROOT = join(ctx.distRoot, ctx.harnessDir)`
- `ctx.substituteToken(s)` → replaces `{{HARNESS_DIR}}` with `.cursor`; use for any prose copied from core
- `ctx.tierCap` → pass through to `projectTier()` calls; never re-resolve
- `ctx.harnessDir` → always `.cursor` for this harness

### 2. Packager Pipeline: Five Stages

Source: `scripts/package.ts` `buildTree()` function (direct inspection)

The packager runs exactly five steps per harness, in order:

| Step | What happens | Relevant to Cursor |
|------|-------------|-------------------|
| 1. Copy `coreDirs` | `core/<src>` → `<harnessDir>/<dst>`, with `{{HARNESS_DIR}}` substitution, `rulesRename`, tier-projection on agent `.md` files, and `frontmatterAdditions` | Cursor uses `rulesRename: null`; standard core projection applies |
| 2. Copy `harnessFiles` | `harness/<name>/<src>` → dist tree; `projectRoot: true` lands beside `<harnessDir>` | Cursor ships the hook adapter, SKILL.md, and optionally commands here |
| 2b. Render onboarding | `core/templates/onboarding.md` + `fills` → AGENTS.md or CLAUDE.md, then `{{HARNESS_DIR}}` transform | Cursor: `onboarding: { dst: "AGENTS.md", projectRoot: true, fills }` |
| 2c. Emit memory | `core/memory/` → `dist/<name>/aidlc/spaces/default/memory/` (workspace root, beside `<harnessDir>`) | Identical for all harnesses; no Cursor-specific action |
| 2d. Emit active-space | `aidlc/active-space` → `"default\n"` | Identical for all harnesses |
| 2e. Emit memory seed | `core/memory/` → `<harnessDir>/tools/data/memory-seed/` (engine-only-install fallback) | Identical for all harnesses |
| 3. Compile stage graph | Runs `tools/aidlc-graph.ts compile` against assembled tree; writes `tools/data/stage-graph.json` + `scope-grid.json` | No Cursor-specific action |
| 3b. Write harness.json | `tools/data/harness.json` with `{harnessDir, rulesSubdir}` | Derived from manifest; `rulesSubdir` = `"rules"` when `rulesRename: null` |
| 4. Runner gen | `aidlc-runner-gen.ts write` + `scopes` (skipped if `skipRunnerGen: true`) | Cursor sets `skipRunnerGen: false`; runners go to `.cursor/skills/` |
| 5. Emit | Calls `manifest.emit(ctx)` if defined | Cursor emitter generates `rules/*/RULE.md`, `hooks.json`, `commands/*.md`, `cli.json` |

### 3. {{HARNESS_DIR}} Token Substitution

Source: `scripts/package.ts` `substituteToken()` and `transform()` (direct inspection)

```typescript
const HARNESS_TOKEN = /\{\{HARNESS_DIR\}\}/g;

function substituteToken(s: string, harnessDir: string): string {
  return s.replace(HARNESS_TOKEN, harnessDir);
}
```

**Rules**:
- Applied to ALL `.md` files during both `coreDirs` and `harnessFiles` copy steps
- `.json` and `.ts` files are copied **verbatim** (no transform)
- The ONE sanctioned transform for `.md` prose — no other variable substitution exists
- `rulesRename` (`applyRulesRename`) runs after token substitution, replacing
  `<harnessDir>/rules/` with `<harnessDir>/<rulesRename>/` — Cursor uses `rulesRename: null` so
  this is a no-op
- Within an emit function, access the same transform via `ctx.substituteToken(s)`

**For Cursor**: any `.md` in `core/` or `harness/cursor/` that contains `{{HARNESS_DIR}}` will
have it replaced with `.cursor`. The RULE.md files the emitter generates are NOT subject to this
packager pass (they are created fresh by `emit()`), so the emitter must call `ctx.substituteToken()`
itself if the content originates from core prose.

### 4. coreDirs Mapping Patterns

Source: all five `harness/*/manifest.ts` files (direct inspection)

**Standard core dirs** (used by Claude, Kiro, Kiro IDE, opencode, and therefore Cursor):

```typescript
coreDirs: [
  { src: "tools",               dst: "tools" },
  { src: "aidlc-common",        dst: "aidlc-common" },
  { src: "knowledge",           dst: "knowledge" },
  { src: "sensors",             dst: "sensors" },
  { src: "scopes",              dst: "scopes" },
  { src: "agents",              dst: "agents" },
  { src: "hooks",               dst: "hooks" },
  { src: "skills/aidlc-session-cost",   dst: "skills/aidlc-session-cost" },
  { src: "skills/aidlc-replay",         dst: "skills/aidlc-replay" },
  { src: "skills/aidlc-outcomes-pack",  dst: "skills/aidlc-outcomes-pack" },
]
```

**Notable patterns**:
- `src` is relative to `core/`; `dst` is relative to `<harnessDir>/`
- `memory/` is NOT in `coreDirs` — it is emitted to the workspace root via `emitMemory()` and
  `emitMemorySeed()`, hardcoded in `buildTree()`, identical for every harness
- `rules/` is in `coreDirs` for Codex only (renamed to `aidlc-rules`); Claude, Kiro, opencode, and
  the proposed Cursor do NOT project `core/rules/` via `coreDirs`
- The three session skills (`aidlc-session-cost`, `aidlc-replay`, `aidlc-outcomes-pack`) are core
  projections for all harnesses except Codex (Codex emits them to `.agents/skills/` instead)
- Codex adds `{ src: "rules", dst: "aidlc-rules" }` and omits the three session skills
- `skills/aidlc/` (the orchestrator) is NOT a core projection — it is a `harnessFile` on every harness

**For Cursor**: same core dir set as Claude/Kiro/opencode, with `rulesRename: null`.

### 5. harnessFiles Mapping Patterns

Source: all `harness/*/manifest.ts` files (direct inspection)

**FileMap type**:
```typescript
export type FileMap = {
  src: string;     // relative to harness/<name>/
  dst: string;     // relative to <harnessDir>/ (or project root if projectRoot: true)
  projectRoot?: boolean;  // land beside <harnessDir> in the dist root
};
```

**Common patterns**:
- The orchestrator skill always ships as a `harnessFile`: `{ src: "skills/aidlc/SKILL.md", dst: "skills/aidlc/SKILL.md" }`
- `projectRoot: true` lands files at `dist/<harness>/<dst>` — used for AGENTS.md (Kiro, opencode),
  `.gitignore` (all non-Claude harnesses), `.mcp.json` (Claude only)
- `.md` harnessFiles undergo `{{HARNESS_DIR}}` substitution + `rulesRename` transform
- `.ts` and `.json` harnessFiles are copied verbatim (unless they are Kiro agent JSONs, which get
  tier-projected)
- The hook adapter is always a harnessFile: `{ src: "hooks/aidlc-<name>-adapter.ts", dst: "hooks/aidlc-<name>-adapter.ts" }`

**For Cursor** (derived from F-016 and technical-environment.md):
```typescript
harnessFiles: [
  { src: "skills/aidlc/SKILL.md",              dst: "skills/aidlc/SKILL.md" },
  { src: "skills/aidlc/question-rendering.md", dst: "skills/aidlc/question-rendering.md" },
  { src: "hooks/aidlc-cursor-adapter.ts",      dst: "hooks/aidlc-cursor-adapter.ts" },
  { src: "dot-gitignore",                      dst: ".gitignore", projectRoot: true },
]
// emit() generates: rules/*/RULE.md, hooks.json, commands/*.md, cli.json
```

### 6. Existing Emitters: How They Read core/memory/ and Transform It

#### 6a. Codex emitter (`harness/codex/emit.ts`)

Source: direct inspection

Codex does **not** read `core/memory/` directly in `emit()`. The packager's `emitMemory()` and
`emitMemorySeed()` already write `core/memory/` to the dist tree before `emit()` is called. The
codex emitter:

1. Reads from `ctx.coreRoot` for agents: `readFileSync(join(agentsDir, f))` where `agentsDir = join(coreRoot, "agents")`
2. Reads its own authored files from `ctx.harnessRoot`: `readFileSync(join(harnessRoot, "skills", "aidlc", f))`
3. Reads from the assembled dist tree for the runner-gen module: `require(join(CODEX_ROOT, "tools", "aidlc-runner-gen.ts"))`
4. Rewrites prose via `rewriteProse(s)` = `ctx.substituteToken(s)` + aidlc-rules rename
5. All emissions use a deferred `content: () => string` lazy-eval pattern in an `emissions` array,
   then clean-sweeps and writes all at once

**Transform pattern used by Codex**:
```typescript
const rewriteProse = (s: string): string =>
  substituteToken(s).replaceAll(`${harnessDir}/rules/`, `${harnessDir}/aidlc-rules/`);
```

For Cursor (no `rulesRename`), the equivalent is simply:
```typescript
const rewriteProse = (s: string): string => ctx.substituteToken(s);
```

#### 6b. opencode emitter (`harness/opencode/emit.ts`)

Source: direct inspection

opencode's `emit()` reads `core/agents/` to generate native subagent `.md` files:
1. `readFileSync(join(agentsDir, f))` for each `*.md` in `core/agents/`
2. Calls `emitSubagentMd()` to parse frontmatter, project tier, transform body
3. Uses `ctx.substituteToken()` on body prose
4. Post-processes with `projectActiveMemoryReferences()` to fix memory paths

opencode also reads from the assembled dist tree:
```typescript
// Reads from dist/opencode/.aidlc/tools/ and .aidlc/hooks/
readdirSync(join(distRoot, ".aidlc", dir), { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
```
This is for the `embedShippedEntrypoints` function that injects the list of shipped `.ts` files into
the adapter plugin.

**For Cursor**: the emitter reads `core/memory/` directly to generate RULE.md content:
```typescript
const memoryDir = join(ctx.coreRoot, "memory");
// Files: org.md, team.md, project.md, phases/ideation.md,
//        phases/inception.md, phases/construction.md, phases/operation.md
```

This is the key difference from Codex/opencode — Cursor must read `core/memory/` itself because
the RULE.md format requires structural transformation (adding YAML frontmatter, splitting content
by activation type) that cannot be done as a simple copy.

### 7. core/memory/ Structure

Source: `ls core/memory/` (direct inspection)

```
core/memory/
├── org.md           # Organization practices (always-apply)
├── team.md          # Team practices (always-apply)
├── project.md       # Project overrides (always-apply)
├── phases/
│   ├── ideation.md       # Ideation phase (agent-decided)
│   ├── inception.md      # Inception phase (agent-decided)
│   ├── construction.md   # Construction phase (agent-decided)
│   └── operation.md      # Operation phase (agent-decided)
└── templates/       # (build artifacts, not rule content)
```

**Mapping to Cursor rules** (from F-005 and F-016):
- `org.md` + `team.md` + `project.md` → `aidlc-method/RULE.md` with `alwaysApply: true`
- `phases/ideation.md` → `aidlc-phase-ideation/RULE.md` with `alwaysApply: false` + `description`
- `phases/inception.md` → `aidlc-phase-inception/RULE.md` similarly
- `phases/construction.md` → `aidlc-phase-construction/RULE.md` similarly
- `phases/operation.md` → `aidlc-phase-operation/RULE.md` similarly

**RULE.md frontmatter** (from cursor-platform-research.md):
```yaml
---
description: "Short description for agent-decided activation"
globs: "src/**/*.ts"
alwaysApply: false
---
```

For always-apply (method layer): `alwaysApply: true`, no `description`, no `globs`.
For agent-decided (phase layer): `alwaysApply: false`, `description` set (AI reads it to decide relevance).

### 8. Onboarding Template + Fills Pattern

Source: `scripts/onboarding.ts`, `harness/kiro/onboarding.fills.ts`, `harness/opencode/onboarding.fills.ts`

**Type contract**:
```typescript
export type OnboardingFills = {
  invoke: string;                  // e.g. "/aidlc"
  slots: Record<string, string>;   // name → markdown body
};
```

**Rendering pipeline** (for non-Codex harnesses):
1. `renderOnboarding(skeleton, fills)` in `scripts/onboarding.ts`
   - Replaces `{{SLOT:<name>}}` with `fills.slots[name]` (or empty if absent)
   - Replaces `{{INVOKE}}` with `fills.invoke`
   - Strips trailing whitespace, collapses 3+ blank lines, ensures single trailing newline
   - Returns markdown with `{{HARNESS_DIR}}` STILL PRESENT
2. Packager calls `transform()` on the rendered string → substitutes `{{HARNESS_DIR}}` → `.cursor`
3. Written to `projectRoot: true` destination → `dist/cursor/AGENTS.md`

**OnboardingSpec in manifest**:
```typescript
export type OnboardingSpec = {
  dst: string;             // "AGENTS.md"
  projectRoot?: boolean;   // true for cursor (beside .cursor/)
  fills: OnboardingFills;
};
```

**Declared slots** (from existing fills files — these must all be handled):
- `title_block` — project heading + framework intro
- `prereq_bullets` — prerequisite bullet list
- `prereq_bullets_tail` — optional trailing prereq bullets
- `agents_note` — harness-specific agent delegation note
- `structure_extra` — extra structure section (usually empty)
- `guide_pointer` — link to harness-specific guide
- `sections_before_resumption` — "What's different on this harness" section
- `sections_after_resumption` — post-resumption sections (usually empty)
- `gitignore_extra` — extra gitignore notes (usually empty)

**For Cursor**: create `harness/cursor/onboarding.fills.ts` implementing `OnboardingFills` with
`invoke: "/aidlc"` and all required slot bodies filled. Import in `manifest.ts`:
```typescript
import onboardingFills from "./onboarding.fills.ts";
// ...
onboarding: { dst: "AGENTS.md", projectRoot: true, fills: onboardingFills },
```

### 9. Harness Discovery Mechanism

Source: `scripts/package.ts` `discoverHarnessNames()` (direct inspection)

```typescript
function discoverHarnessNames(): string[] {
  if (!existsSync(HARNESS_ROOT)) return [];
  return readdirSync(HARNESS_ROOT)
    .filter((n) => existsSync(join(HARNESS_ROOT, n, "manifest.ts")))
    .sort();
}
```

**Implication**: creating `harness/cursor/manifest.ts` is the ONLY step needed to integrate with
the packager. Zero edits to `package.ts` required (F-009 confirmed).

### 10. Byte-Parity Drift Guard

Source: `scripts/package.ts` `checkHarness()` and `diffTrees()` (direct inspection)

The `--check` mode:
1. Builds the harness tree into a temp directory
2. Byte-compares every file against the committed `dist/<name>/` tree
3. Reports `MISSING`, `DIFFERS`, or `ORPHAN` problems
4. Exits 1 if any problems found

**Implications for Cursor emitter**:
- The emitter must be deterministic — same inputs must produce byte-identical outputs on every run
- File ordering must be stable (sort arrays before iterating)
- No timestamps, random IDs, or environment-dependent content in generated files
- The `clean-sweep` pattern (Codex/opencode `rmSync(SHELL, {recursive: true, force: true})`) ensures
  removed files don't linger; this must be replicated for `.cursor/rules/` in the Cursor emitter

### 11. Plugin Projection

Source: `scripts/manifest-types.ts`, `scripts/package.ts` `pluginTargetFor()` (direct inspection)

From F-003 and technical-environment.md, the Cursor manifest should declare:
```typescript
plugin: { manifestDir: ".cursor-plugin", kind: "store" }
```

The packager derives plugin targets from the manifest's `plugin` field. If omitted, it defaults to
`{ manifestDir: "<harnessDir>-plugin", kind: "store" }`, which for `.cursor` would be `.cursor-plugin`.
Declaring it explicitly is cleaner and matches Claude/Codex patterns.

### 12. tierFlavor for Cursor

Source: F-004, `scripts/manifest-types.ts`, `scripts/package.ts`

The `tierFlavor` field must be one of `"claude" | "codex" | "kiro" | "opencode"`. Cursor uses
Claude model identifiers (e.g., `claude-sonnet-4-5`), so `tierFlavor: "claude"` is correct. No
new tier flavor is needed unless Cursor's model naming diverges from raw Anthropic identifiers.

The tier system informs orchestrator instructions about model class but cannot enforce it (Cursor's
model selection is user-governed via the UI picker).

### 13. skipRunnerGen for Cursor

Source: `scripts/package.ts` step 4, `harness/codex/manifest.ts` (direct inspection)

Cursor sets `skipRunnerGen: false` (default). Unlike Codex (which emits skills to `.agents/skills/`
via `emit()`), Cursor ships skills at `.cursor/skills/` — the standard location that `aidlc-runner-gen.ts`
targets. Runner-gen writes the stage runners, init runner, compose runner, and scope runners into
`.cursor/skills/aidlc-*/SKILL.md` automatically.

### 14. Emit Function Clean-Sweep Pattern

Source: `harness/codex/emit.ts` and `harness/opencode/emit.ts` (direct inspection)

Both existing emitters:
1. Accumulate all emissions as `Array<{path: string; content: () => string}>` (lazy evaluation)
2. Call `rmSync(TARGET, { recursive: true, force: true })` to clean the target directory
3. Iterate emissions, `mkdirSync(dirname(path), { recursive: true })` then `writeFileSync`

The clean-sweep ensures that if the Cursor emitter removes a RULE.md (e.g., because a phase was
renamed), the old file doesn't linger as an ORPHAN in the drift check.

**For Cursor emitter**, the clean-sweep target is `join(CURSOR_ROOT, "rules")` — only the
emitter-owned `rules/` subtree, not the entire `.cursor/` directory (which also contains packager-
owned content like `tools/`, `agents/`, `hooks/`, `skills/`).

---

## Options Summary (Neutral)

### Option A: Emitter generates all Cursor-specific surfaces (hooks.json, rules/, commands/, cli.json)
Pro: Clean separation — packager owns declarative projections, emitter owns structural divergence.
Con: More code in emit.ts.
Addresses: F-005 (rulesRename: null + emitter handles rules), F-002 (emit.ts required)

### Option B: Hybrid — some surfaces as harnessFiles, rest in emit()
Pro: Simpler emit.ts if hooks.json/cli.json are authored static files.
Con: Static hooks.json is harder to maintain; emitter-generated is easier to update from code.
Addresses: F-002 (partially), but deviates from the "emit owns code, manifest owns data" principle.

### Option C: No emit() — purely declarative manifest
Pro: Simplest manifest.
Con: Cannot generate RULE.md with per-file frontmatter from core/memory/ content. Not viable.
Does not satisfy: F-005, F-012 (RULE.md required).

---

## Decision Points for Design Agent

| # | Decision | Current state | Implications |
|---|----------|---------------|--------------|
| 1 | How many RULE.md files for the always-apply method layer? | F-005 says single `aidlc-method/RULE.md` combining org.md + team.md + project.md | Size limit is 500 lines; if combined content exceeds this, split into two always-apply rules |
| 2 | What frontmatter description text for phase rules? | Not specified in input docs | Description is what Cursor's AI reads to decide whether to load the rule; should name the phase |
| 3 | What goes in `cli.json` default deny list? | General "dangerous ops" intent; no specific commands enumerated | See CQ-ARCH-001 |
| 4 | Should `hooks.json` be authored (static harnessFile) or generated (in emit)? | emit pattern established by Codex | Generated is better (avoids drift between hook wiring list and actual hooks) |
| 5 | Commands: authored static `.md` or generated from core utility handlers? | F-016 shows `commands/*.md` as emitter output | Emitter reads CLI utility handlers and generates corresponding `.md` |

---

## External Dependencies

| Dependency | Version | Purpose | Source |
|------------|---------|---------|--------|
| bun | runtime | All scripts, hooks, tools | `package.json` / `scripts/package.ts` |
| TypeScript | strict mode | All authored surfaces | `tsconfig.json` |
| Biome | linter | All `.ts` files | `biome.json` |
| smol-toml | npm | TOML serialization (Codex only; Cursor does not need it) | `harness/codex/emit.ts` |
| node:fs | stdlib | File I/O in emit() | `harness/codex/emit.ts`, `harness/opencode/emit.ts` |
| node:path | stdlib | Path manipulation | All emit files |
| node:crypto | stdlib | Trust hash (Codex only; Cursor does not need it) | `harness/codex/emit.ts` |

Cursor emitter needs only `node:fs`, `node:path`, and imports from
`../../scripts/manifest-types.ts` and `../../core/tools/aidlc-tiers.ts`.

---

## Requirements Traceability

| Finding | Addresses |
|---------|-----------|
| EmitContext type signature documented | Architecture component: manifest-and-packager, emitter |
| Packager 5-step pipeline documented | FR (packager generates dist/cursor/) |
| coreDirs pattern for Cursor derived | FR (complete dist/cursor/ layout) |
| harnessFiles pattern for Cursor derived | FR (complete dist/cursor/ layout) |
| {{HARNESS_DIR}} substitution mechanics | Constraint: only token transform allowed |
| Onboarding fills pattern | FR (AGENTS.md at project root) |
| Drift guard implications for emitter | NFR (byte-parity reproducibility) |
| memory/ → RULE.md mapping | F-005, F-012 (Cursor rules format) |
| Discovery via manifest.ts | F-009 (zero edits to package.ts) |
| rulesRename: null | F-005 (emitter handles rules transpose) |
| skipRunnerGen: false | F-016 (skills at .cursor/skills/) |
| plugin: { manifestDir: ".cursor-plugin", kind: "store" } | F-016 (plugin projection) |
| tierFlavor: "claude" | F-004 (Cursor uses Anthropic model identifiers) |
