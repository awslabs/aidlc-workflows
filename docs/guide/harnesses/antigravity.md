# AI-DLC on Antigravity

Antigravity (Google's AI development environment — IDE and CLI) natively discovers workspace customizations under `.agent/`:

- **Skills** (`.agent/skills/<name>/SKILL.md`): Invoked via `/aidlc`, `/aidlc-status`, `/aidlc-jump`, `/aidlc-scope`, and the generated stage/scope runners.
- **Agents** (`.agent/agents/aidlc-*-agent.md`): The 14 core personas are dispatched directly via Antigravity's native `invoke_subagent` tool.
- **Rules** (`.agent/rules/*.md`): `.agent/rules/aidlc.md` (`trigger: always_on`) points to the standing method layers (`aidlc/active-memory/{org,team,project}.md`), and four `.agent/rules/phase-*.md` (`trigger: model_decision`) files point to phase rules.
- **Hooks** (`.agent/hooks.json` + `.agent/hooks/aidlc-antigravity-adapter.ts`): Wires `SessionStart`, `PreInvocation`, `PreToolUse`, `PostToolUse`, and `Stop` to the shared core hooks.
- **Structured questions**: Rendered via Antigravity's native `ask_question` modal tool.

## Install and configure

```bash
aidlc config --harness antigravity
```

Then open the project in Antigravity (or run `agy`) and invoke `/aidlc --doctor` or `/aidlc "<your goal>"`.
