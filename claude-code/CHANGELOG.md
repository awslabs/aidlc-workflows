# Changelog

All notable user-visible changes to the AI-DLC Claude Code implementation are
documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.6.4] - 2026-06-10

First public release on GitHub, imported into the `aidlc-workflows` monorepo
under `claude-code/`. Earlier development (0.1.0 through 0.6.4) happened on
internal infrastructure; this entry consolidates that history. No upgrade
action required — to install, copy `dist/claude/.claude/` into your project's
`.claude/` per the README.

- Full AI-DLC workflow for Claude Code: 32 stages across 5 phases
  (initialization, ideation, inception, construction, operation), each behind
  a user approval gate.
- 11 domain-expert agents, 40 skills, 10 lifecycle hooks, and a TypeScript
  CLI toolchain (`aidlc-*.ts`) — all run via bun, no jq/sed/awk dependency.
- 9 workflow scopes (poc, mvp, feature, bugfix, refactor, security-patch,
  infra, enterprise, workshop) selecting which stages run and in what depth.
- Deterministic sensor system with four shipped sensors (linter, type-check,
  required-sections, upstream-coverage) fired from hooks.
- Construction-phase worktree isolation for parallel Bolts, with fork/merge
  audit continuity.
- Learning loop: gate-time capture of interpretations, deviations, tradeoffs,
  and open questions into team/project learnings files.

[0.6.4]: https://github.com/awslabs/aidlc-workflows/tree/v2/claude-code
