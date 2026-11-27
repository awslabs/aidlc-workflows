# Working as a Team

AI-DLC is driven by people, and one person drives a session at a time. A team works together through the files AI-DLC writes into the project's `aidlc/` folder and through git: every approved output is a committed file the next person can read, change and approve.

## Who does what in each phase

Each stage has one person who decides (the **decision owner**, who answers its gate) and others who contribute (answer questions, review the draft). The roles below are suggestions; AI-DLC does not enforce them, and a small team can fill several roles with one person. The agents that do each stage's work are listed in [Phases and Stages](04-phases-and-stages.md).

| Phase | Decision owner | Contributors |
|-------|----------------|--------------|
| Ideation | Product owner (the idea, the scope, go or no-go) | Architect (feasibility, constraints), delivery lead (team and plan), designer (mockups), compliance |
| Inception | Product owner for requirements and stories; architect for domain design, units and contracts | Developers and QA (story and requirement review), designer (refined mockups), delivery lead (delivery plan), platform and security |
| Construction | Architect for design stages; developer for code generation | QA (build and test), security and compliance (NFR and infrastructure design), platform engineer (infrastructure) |
| Operation | Operations or platform lead (deployment, observability) | Developers (deployment support), QA (performance validation), security and compliance |

## When people step in

- **Every approval gate.** The driver asks the decision owner before approving; the gate is where judgement is collected.
- **Questions that are not the agent's to answer:** what to build, trade-offs, priorities. Hand the questions file to whoever owns the answer (see below).
- **Anything that changes an approved output.** Edit the file or jump back to the stage with `/aidlc --stage <name>`; later stages reopen.

## Async handoffs with git

1. The driver runs a stage until its questions file is written, then commits and pushes the intent record (`aidlc/spaces/<space>/intents/<YYMMDD>-<label>/`).
2. The next person pulls, opens the questions or draft file, edits it by hand, and commits. See [Editing Files Yourself](07-interaction-modes.md#editing-files-yourself).
3. Whoever drives next runs `/aidlc`. The first `/aidlc` in a fresh clone asks which intent to join; choose the teammate's, and AI-DLC continues from the recorded state.
4. Use a pull request when a decision owner should review a stage's output before the next stage starts. Approve the stage in the session after the review.

The per-user cursors (`active-space`, `active-intent`) are not committed, so teammates never move each other's place. Two people should not drive the same intent at the same moment; split parallel work by intent, or by unit as in [Multi-Team Construction and Workshop Mode](workshop-mode.md).

## Driving alone or together

A session has one driver. Others take part by answering questions, reviewing files and owning gates, in the chat beside the driver (a pairing or mob session where one person shares a screen) or asynchronously through git. For several teams building units in parallel, use [Multi-Team Construction and Workshop Mode](workshop-mode.md) and the [facilitator guide](facilitator-guide.md).

## What `mob-composition.md` is

It is a planning document written by the optional Team Formation stage (1.5, enterprise and feature scopes): who is available, the skill gaps, who joins which phase, and a RACI. It is for people to read and agree on. Nothing in the engine reads it to route work or assign people, so it will not change how a run behaves. Skip the stage for a solo developer or a small team.

## Where `org.md` and `team.md` live

They are committed files in the space's memory folder, `aidlc/spaces/<space>/memory/`, alongside `project.md`. They sit inside the project so that a pull request reviews every change to the team's rules. To share them across many projects, keep a template repository and bring changes into each project through a pull request; see [Standards for many projects](03-spaces-and-intents.md#standards-for-many-projects).

## Related reading

- [Spaces and Intents](03-spaces-and-intents.md)
- [Agents](06-agents.md)
- [Rules and the Learning Loop](09-rules-and-the-learning-loop.md)
