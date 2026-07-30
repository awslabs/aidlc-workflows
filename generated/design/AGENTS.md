# Cursor IDE Harness for AI-DLC Workflows 2.0

## Project Overview

This is the design specification for a new Cursor IDE harness for the AI-DLC multi-harness framework. The harness enables AI-DLC's 14-agent, 32-stage methodology to run natively inside Cursor IDE, cursor-agent CLI, and cloud agents via a `dist/cursor/` distribution tree.

## Required Reading

Before implementing, read these files in order:

1. `architecture/system-architecture.md` — full component design (manifest.ts, emit.ts, adapter, SKILL.md, build pipeline)
2. `architecture/data-flows.md` — sequence diagrams for hook lifecycle, packager, and security gates
3. `security/implementation-guidance.md` — security checklist and implementation order
4. `requirements/functional-requirements.md` — 13 functional requirements with acceptance criteria

## Recommended Reading

- `architecture/architecture-decision-records/` — 6 ADRs explaining key technology choices
- `security/threat-analysis.md` — STRIDE threat model (10 threats, understand the security boundary)
- `project-management/user-stories.md` — sprint plan (3 sprints, 12 stories)
- `appendices/architecture-research/` — platform research on Cursor surfaces, packager integration, and testing patterns

## Code Style

- TypeScript strict mode, ES modules (`import`/`export`)
- bun runtime for all scripts, hooks, and tests
- Biome linter/formatter (run `biome check` before committing)
- Conventional commits: `feat(cursor):` for feature work
- Never hand-edit `dist/` — always regenerate via `bun scripts/package.ts cursor`

## Testing

```bash
bun scripts/package.ts cursor          # Generate dist/cursor/
bun scripts/package.ts --check         # Byte-parity drift guard
bun tests/run-tests.ts                 # Full test suite (smoke + unit + integration)
```

Key test files for this harness:
- `tests/unit/t145-cursor-packaging.test.ts` — packaging parity + doctor
- `tests/unit/t146-cursor-hook-adapter.test.ts` — adapter contract (subprocess shim)

## Key Constraints

- `harness/cursor/manifest.ts` is the only file needed for packager integration (auto-discovery)
- `.mdc` extension required for Cursor rules (`.md` files are silently ignored)
- Hook adapter must use `process.execPath` (not bare `"bun"`) for subprocess invocation
- `failClosed:true` required on `beforeShellExecution` and `preToolUse` hooks
- Session init uses `beforeSubmitPrompt` (not `sessionStart`) for cloud agent compatibility
- `loop_limit: 3` on the stop hook to prevent unbounded self-correction

## Implementation Order

1. `harness/cursor/manifest.ts` — declare HarnessManifest
2. `harness/cursor/emit.ts` — generate rules, hooks.json, cli.json, commands, plugin manifests
3. `harness/cursor/hooks/aidlc-cursor-adapter.ts` — hook contract bridge (security boundary)
4. `harness/cursor/skills/aidlc/SKILL.md` — orchestrator entry point
5. `harness/cursor/onboarding.fills.ts` — AGENTS.md template fills
6. Run packager, write tests, verify doctor passes
