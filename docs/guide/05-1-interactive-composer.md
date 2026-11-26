# Interactive Composer

Generate the `/aidlc` command that starts a new piece of work. Pick a scope,
adjust its settings, choose which stages run, then copy the command into your
agent's chat. The command includes only the options you change; everything else
keeps the scope's defaults. This page only generates the command; it doesn't
touch your project.

<div id="aidlc-composer">
  <p><em>The composer needs JavaScript. Without it, see the
  <a href="../05-scopes-and-depth/#stage-by-scope-matrix">Stage-by-Scope Matrix</a>
  for each scope's stages and the
  <a href="../12-cli-commands/">CLI Commands</a> for every flag.</em></p>
</div>

## How this relates to `/aidlc compose`

This page generates a command from choices you make. The
[Adaptive Composer](05-scopes-and-depth.md#the-adaptive-composer)
(`/aidlc compose`) is an agent: it reads your task and your code, proposes the
smallest set of stages for it, and asks you to approve.

The scope, stage and flag data on this page is generated from the AI-DLC source
each time the documentation is published, so it matches the current release.

## Next Steps

- [Scopes and Depth](05-scopes-and-depth.md): what each scope is for
- [Phases and Stages](04-phases-and-stages.md): what each stage does
- [CLI Commands](12-cli-commands.md): every flag the command can carry
