# Revert Plan: Devin Agent Frontmatter Projection (PR #996, S04)

**Date:** 2026-09-12
**Status:** Draft
**Reverts:** the S04 "persona frontmatter projection" introduced by commit
`801507ad` ("fix(devin): project valid persona frontmatter, wire invocation
triggers, raise version floor, reduce onboarding") on the PR #996 line.

---

## Goal

Remove the Devin-specific stripping of agent frontmatter fields
(`display_name`, `examples`, `disallowedTools`, `maxTurns`) so the Devin dist
ships the same persona frontmatter as every other harness. `devin doctor
--json` will emit CFG005 warnings for those keys on `.devin/agents/*.md` — this
is **expected**, not a broken install: the fields exist for the other
harnesses and are ignored by Devin's native agent loader. The revert restores
the single authored contract (one frontmatter shape everywhere) and removes a
per-harness exception in the agent-metadata parser.

## Verified current state

| Location | What exists today |
|----------|-------------------|
| `core/tools/aidlc-devin-profile.ts` (115 lines) | Exports `stripDevinUnsupportedProfileFields(source, sourcePath)` and `isDevinUnsupportedField(key)`; `DEVIN_UNSUPPORTED_FIELDS` = `{display_name, examples, disallowedTools, maxTurns}` |
| `scripts/package.ts:81` | `import { stripDevinUnsupportedProfileFields } from "../core/tools/aidlc-devin-profile.ts";` |
| `scripts/package.ts:344-357` | Call site: `if (harness === "devin" && posixPath.includes("/agents/") && posixPath.endsWith("-agent.md")) s = stripDevinUnsupportedProfileFields(s, srcPath);` inside the `.md` projection block, after `projectTierFrontmatter` |
| `core/tools/aidlc-plugin-emit.ts:42` | Same import (`"./aidlc-devin-profile.ts"`) |
| `core/tools/aidlc-plugin-emit.ts:466-472` | Call site: `if (target.harnessLeaf === ".devin") projected = stripDevinUnsupportedProfileFields(projected, file);` inside the plugin-agent emission loop |
| `scripts/plugin-hooks-template/compose.ts:807-852` | **Not an import** — an inlined byte-for-byte duplicate: doc comment (807-811), `DEVIN_UNSUPPORTED_PROFILE_FIELDS` const (812-817), and `projectDevinNativeAgent` (819-852). compose.ts runs in installed projects and cannot import the helper, hence the inline copy |
| `scripts/plugin-hooks-template/compose.ts:1945-1946` | Call site: `HARNESS_LEAF === ".devin" ? projectDevinNativeAgent : undefined` tail of the agent-transform ternary in `copyTreeNoClobber` |
| `core/tools/aidlc-lib.ts:25697-25720` | `parseAgentFrontmatter`: comment block at 25708-25712 plus `if (!display_name && harnessDir() !== ".devin") missing.push("display_name")` (25713) and `display_name: display_name || slug` fallback (25719) |
| `tests/unit/t333-devin-profile.test.ts` (227 lines) | 12 unit tests of the helper (`covers: file:core/tools/aidlc-devin-profile.ts`) |
| `tests/unit/t331-devin-packaging.test.ts:330-356, 372-384` | Tests 11 and 13 assert the stripped shape of `dist/devin/.devin/agents/*.md`; S04 comment at 330-332 |
| `tests/unit/t331-devin-packaging.test.ts:358-370` | Test 12 asserts Claude keeps the fields — stays valid post-revert |

Notes on things that do **not** need changes (verified):

- `harnessDir()` stays — used elsewhere in `aidlc-lib.ts` (lines 234, 556,
  6093, 6098, 20367); only the `parseAgentFrontmatter` exception goes.
- `posixPath` in `scripts/package.ts` stays — still used by the
  cursor/opencode/copilot memory-path projection immediately below the Devin
  block (lines 362-368).
- `tests/integration/t188-plugin-compose.test.ts` has **no** Devin coverage —
  the `.devin` branch in compose.ts is untested there; removing it breaks
  nothing.
- `tests/unit/t315-plugin-build.test.ts` builds `dist/plugins/test-pro/devin`
  but asserts no frontmatter content — output changes (fields retained) without
  test edits.
- `tests/.coverage-registry.json` and `tests/unit/gen-coverage-registry.test.ts`
  contain **no** references to `t333-devin-profile` or `aidlc-devin-profile` —
  no registry edits expected, but run the `--check` gate to confirm.
- `tests/unit/t61.test.ts` test 4 (doctor rejects an agent missing
  `display_name`) keeps passing — the revert makes that rejection uniform
  across harnesses again.
- `plugins/test-pro/agents/test-pro-metrics-agent.md` carries
  `display_name`/`examples`/`disallowedTools` — post-revert these pass through
  to Devin plugin output unchanged; no fixture edit needed.
- Research docs (`pr-996-*.md` in this directory) are historical records —
  leave them unchanged.
- `docs/guide/06-agents.md` and `docs/reference/04-stage-protocol.md` mention
  `maxTurns`/`disallowedTools` projection only for Claude/opencode/Kiro —
  accurate post-revert; no edits.

## Implementation (ordered)

### 1. Delete the helper

```
rm core/tools/aidlc-devin-profile.ts
```

### 2. `scripts/package.ts`

- Delete the import at line 81.
- Delete the Devin block at lines 344-357 (the `// Devin: strip frontmatter
  fields…` comment and the `if (harness === "devin" && …)` statement). Keep the
  `const posixPath = …` line and its comment — the cursor/opencode/copilot
  block below still uses it.

### 3. `core/tools/aidlc-plugin-emit.ts`

- Delete the import at line 42.
- Delete lines 466-472 (the `// Devin: strip unsupported frontmatter fields…`
  comment and the `if (target.harnessLeaf === ".devin")` block).

### 4. `scripts/plugin-hooks-template/compose.ts`

- Delete the doc comment at 807-811, `DEVIN_UNSUPPORTED_PROFILE_FIELDS`
  (812-817), and `projectDevinNativeAgent` (819-852).
- In the transform ternary at 1939-1947, remove the `.devin` arm so the chain
  ends: `HARNESS_LEAF === ".kiro" ? projectKiroNativeAgent : undefined`.

### 5. `core/tools/aidlc-lib.ts` — `parseAgentFrontmatter`

- Delete the explanatory comment (25708-25712) and change line 25713 to
  `if (!display_name) missing.push("display_name");` — `display_name` is
  required on every harness again.
- Change line 25719 to `return { slug, display_name, examples };` — drop the
  `|| slug` fallback.
- No `harnessDir()`-based exception may remain in this function.

### 6. Tests

- Delete `tests/unit/t333-devin-profile.test.ts` entirely.
- `tests/unit/t331-devin-packaging.test.ts`:
  - **Test 11** (330-356): invert. Rename to reflect that Devin agents now
    *retain* the fields, and flip the assertions: `display_name:`, `examples:`,
    `disallowedTools:`, `maxTurns:` **are** present in the emitted frontmatter
    where the authored core agent declares them (Devin frontmatter is now
    identical to core's, modulo tier projection). Keep the `name:`/
    `description:` preservation and body-length assertions. Update the S04
    comment at 330-332 to describe the reverted contract.
  - **Test 13** (372-384): invert — assert `examples:` IS present in the Devin
    developer agent's frontmatter (projection no longer touches it). Rename
    accordingly.
  - **Test 12** (358-370): unchanged — Claude retaining the fields remains the
    parity reference.

### 7. Documentation

`docs/guide/harnesses/devin.md` — add a bullet under "What's different on
Devin" (or extend the "Doctor" section) stating:

> `devin doctor --json` emits CFG005 warnings for `display_name`, `examples`,
> `disallowedTools`, and `maxTurns` on `.devin/agents/*.md`. This is expected
> and does not indicate a broken install — those fields are authored once in
> `core/agents/` for the harnesses that consume them, and Devin's native agent
> loader simply ignores them.

## Regenerate and validate

```bash
bun scripts/package.ts            # regenerate all dist/ trees (dist is generated, never hand-edited)
bun scripts/package.ts --check    # determinism guard: two clean builds byte-identical
bun tests/gen-coverage-registry.ts --check   # confirm registry still in sync post-deletion
```

Then the unit suite (t331 and t332 read `dist/devin` directly, so the regen
must land first):

```bash
bash tests/run-tests.sh --unit
# or targeted first pass:
bun test tests/unit/t331-devin-packaging.test.ts tests/unit/t332-devin-adapter.test.ts \
         tests/unit/t61.test.ts tests/unit/t315-plugin-build.test.ts
```

Fix whatever breaks; then a final reference sweep — these should match only
historical research docs and (post-edit) nothing in `core/`, `scripts/`,
`tests/`, or `docs/guide`/`docs/reference` chapters:

```bash
rg 'stripDevinUnsupportedProfileFields|isDevinUnsupportedField|aidlc-devin-profile|projectDevinNativeAgent|DEVIN_UNSUPPORTED'
```

## Acceptance criteria

- `core/tools/aidlc-devin-profile.ts` and `tests/unit/t333-devin-profile.test.ts` deleted.
- No call sites, imports, or inlined copies of the stripper remain in
  `scripts/package.ts`, `core/tools/aidlc-plugin-emit.ts`, or
  `scripts/plugin-hooks-template/compose.ts`.
- `parseAgentFrontmatter` requires `display_name` unconditionally and returns
  it without a slug fallback; no `harnessDir()` exception in that function.
- `dist/devin/.devin/agents/*-agent.md` carry the same frontmatter fields as
  `dist/claude/.claude/agents/` (modulo tier projection).
- `docs/guide/harnesses/devin.md` documents the expected CFG005 warnings.
- `bun scripts/package.ts --check` passes; unit suite green.
