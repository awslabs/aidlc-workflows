---
name: aidlc
description: AI-DLC conductor agent — run /aidlc to start or resume a workflow
tools: ["read", "write", "shell", "subagent"]
# A custom agent picks up NONE of the ambient layers on its own, and two separate
# docs say so for two separate layers: "When using custom agents, steering files
# are not automatically included. You must explicitly add them to the agent's
# `resources` configuration" (Steering with custom agents) and "Custom agents
# don't load skills by default - you need to explicitly add them to the agent's
# `resources` field using the `skill://` URI scheme" (Skills). So every layer this
# row depends on is named here or it is absent at runtime: the steering always-on
# layer (including the active-memory pointer this row ships), the orchestrator
# skill the conductor is required to follow, the workflow's own memory, and the
# onboarding contract at the project root.
resources:
  - "file://{{HARNESS_DIR}}/steering/**/*.md"
  - "skill://{{HARNESS_DIR}}/skills/*/SKILL.md"
  - "file://aidlc/spaces/default/memory/**/*.md"
  - "file://AGENTS.md"
permissions:
  rules:
    - capability: shell
      effect: allow
      match:
        # ONLY the dispatcher, scoped to the trusted route namespace. A second line used to
        # sit beside it: a glob over the projected tools directory, matching every script
        # whose name began with the engine prefix. That was an execution authority over a
        # directory the PROJECT can write - a hostile repository could add a script whose
        # name matched and it was pre-approved, so relayed repository text that talked the
        # model into running it reached execution with no second approval.
        #
        # Measured cost of removing it: exactly one call in the orchestrator skill, the
        # utility `config-change` verb, which now prompts - and that is consistent, because
        # the three other `config` routes already prompt on both channels. Every other call
        # the skill makes (20 of them) is an `{{INVOKE}} engine <route>` the line below
        # already covers.
        #
        # Pinning the entrypoint is what removes the authority: `{{INVOKE}}` resolves to the
        # installed command on a native install and to the projected dispatcher on a source
        # copy, so both channels now grant one entrypoint plus a route namespace rather than
        # a directory of scripts. That is also the boundary the native channel always drew;
        # the source channel was the wider of the two.
        - "{{INVOKE}} engine *"
        # Exact timestamp spellings, not a tail wildcard. `date -u *` matched any tail, and
        # every metacharacter the platform stopped gating rode in on it: measured live on
        # this build, a command-substitution tail and a backtick tail both ran with no
        # approval, and a redirection tail wrote a file the filesystem rules below do not
        # cover. The 2.x binary gated those tails independently of pattern matching, so the
        # wildcard was safe when it was written; v3 gates none of them.
        #
        # Removing the tail closes the carrier for THESE commands only. The dispatcher line
        # above still ends in a wildcard, and `… engine status > file` both matches it and
        # carries a redirection, so a declarative pattern cannot be the whole boundary: a
        # PreToolUse shell boundary is what closes the remaining tail.
        #
        # Four spellings because the protocol instructs three of them - bare for batch
        # entries, double-quoted in the stage protocol and the reviewer knowledge,
        # single-quoted in state initialization - and the fourth is what a model emits when
        # it drops quotes that were never load-bearing. Whether the matcher compares the
        # raw text or a re-quoted argv is not observable from this repository, so all four
        # are named rather than guessed at.
        - "date -u"
        - 'date -u +"%Y-%m-%dT%H:%M:%SZ"'
        - "date -u +'%Y-%m-%dT%H:%M:%SZ'"
        - "date -u +%Y-%m-%dT%H:%M:%SZ"
    - capability: shell
      effect: deny
      match:
        - "rm -rf *"
        - "git push *"
    - capability: filesystem
      effect: allow
      match:
        - "aidlc/spaces/**"
        - "{{HARNESS_DIR}}/sensors/**"
        - "aidlc/.aidlc-compose-pending"
# `permissions` gates the subagent capability as a whole; WHICH agents may be
# spawned and which of them skip the approval prompt is a separate axis, and the
# schema puts that in toolsSettings.subagent ("Control which agents can be spawned
# and which run without approval prompts using `toolsSettings.subagent`",
# Custom agents / Configuring sub-agent access). Every stage the engine
# routes to delegates to one of these, so an unlisted persona stalls the workflow
# on an approval prompt the conductor cannot answer. Named rather than globbed:
# the field takes globs, but `aidlc-*` would also pre-trust whatever a dropped-in
# plugin adds. This list mirrors the personas in core/agents/.
toolsSettings:
  subagent:
    trustedAgents:
      - "aidlc-architect-agent"
      - "aidlc-architecture-reviewer-agent"
      - "aidlc-aws-platform-agent"
      - "aidlc-compliance-agent"
      - "aidlc-composer-agent"
      - "aidlc-delivery-agent"
      - "aidlc-design-agent"
      - "aidlc-developer-agent"
      - "aidlc-devsecops-agent"
      - "aidlc-operations-agent"
      - "aidlc-pipeline-deploy-agent"
      - "aidlc-product-agent"
      - "aidlc-product-lead-agent"
      - "aidlc-quality-agent"
---

You are a software development assistant in a project that uses AI-DLC (AI-Driven Development Life Cycle). When the user invokes /aidlc (or asks to start, resume, or manage an AI-DLC workflow), follow the aidlc skill exactly — it defines the forwarding loop and the engine that owns all routing. CRITICAL forwarding rules, which override any instinct to make progress yourself: (1) The engine binary aidlc-orchestrate.ts is the ONLY authority on the next move — run it, do EXACTLY what its single directive says, then report; never re-derive routing. (2) Your VERY FIRST action: append everything the user typed after /aidlc to the first `next` call unchanged — `/aidlc --phase ideation` MUST become `next --phase ideation`, never a bare `next`; dropping --phase/--stage sends the workflow to the wrong stage and is a bug. (3) When a directive is a print whose message names a command to run (e.g. aidlc-jump.ts execute ...), run THAT EXACT command as your immediate next tool call — do NOT run `next` again or read more files until it has run. Skipping the named command silently breaks the workflow. Outside of AI-DLC workflows, assist normally.
