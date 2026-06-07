---
name: workflow-composition
description: |
  AI-DLC workflow composition. Composes the adaptive workflow conversationally with the human — selecting stages, assigning personas, and handling artifact sourcing. Read by the orchestrator after kickoff.
---

# Workflow Composition

Compose the adaptive workflow for this intent. This is a conversation, not a form. Paraphrase what you understand, identify what's needed, ask the minimum questions to proceed, then propose.

## How to compose

1. **Read `stages/stage-graph.md`** — understand what stages exist and their composition rules.
2. **Paraphrase the intent** — restate what you understand in your own words. Show the human you get it.
3. **Integration scan** — before composing, explicitly list ALL potential integrations and external dependencies you detect in the intent. Include borderline ones. Present them to the human and ask: "For any of these, do you have existing implementations or reference codebases I should study?" This determines whether reverse-engineering is needed. Look for: auth providers (SSO, OAuth, SAML), messaging APIs (WhatsApp, SMS, email), data APIs (ISBN, maps, weather), storage services (photo/file uploads), payment gateways, notification services, third-party SDKs, existing internal systems being connected to.
4. **Existing artifacts scan** — if the human mentions they already have artifacts (stories, requirements, wireframes, designs, code), explicitly list what you detected and for each ask: skip the stage entirely, validate/review what they have, or augment it? Ask how to source them (paste, file path, MCP). Do not silently decide to skip — always confirm with the human what they want done with existing work.
5. **Identify what's implied** — greenfield or brownfield? Simple or complex? What stages are obviously needed, what can be skipped?
5. **Ask only what you can't infer** — don't ask 10 questions. Ask the 1-2 that actually affect the workflow (beyond the integration scan).
6. **Propose the workflow** — present as a table with columns: #, Stage, Owner, Contributors, Reviewer. Add a brief rationale paragraph below the table. Use language like "Here's what I think we could do" and "What do you think?"
7. **Offer to adjust** — after presenting the proposal, offer context-specific options derived from the actual workflow you just proposed. Examples of what to surface (pick what's relevant, not all):
   - If contributors are included: "Run without reviews for a faster pass"
   - If a stage could reasonably be skipped: "Drop [stage] if you want to defer that"
   - If a reviewer is assigned: "Skip [reviewer] if this is exploratory"
   - If a stage is missing that might add value: "Add [stage] if you want [benefit]"
   
   These should be actionable suggestions based on the proposed workflow, not generic boilerplate.
8. **Handle artifacts the human already has** — if they mention existing docs, stories, or wireframes, ask how to source them (paste, file path, MCP) or offer to generate.

## Composition principles

- **Right-size aggressively** — a bug fix doesn't need requirements analysis. A full system does.
- **Include contributors by default** — unless the human explicitly says prototype, POC, spike, or bug fix. The human can always say "skip reviews."
- **Respect the human's preferred ordering** — if they say "wireframes first, then requirements", do that.
- **Artifacts already provided = stage skipped** — if the human provides requirements.md, skip requirements-analysis (or offer to validate/augment it).
- **Brownfield = check for existing context** — if org-ai-kb has context, use it. If not, propose reverse-engineering.
- **Watch for brownfield cues** — when the intent mentions integrations (SSO, OAuth, SAML, payment, messaging APIs, third-party services) or modifications to existing systems, ask whether there's an existing implementation or reference codebase to learn from. This is a cue for reverse-engineering even in greenfield — "we're building new, but we have an existing SSO integration elsewhere we should study." Keywords: "SSO", "OAuth", "SAML", "integrate with", "connect to", "use our existing", "modify the", "extend the", "add to the current", "WhatsApp", "payment", "third-party".
- **Do NOT surface path labels** (A, B, C, D) — those are internal reasoning. Just present the ordered list.

## Artifact sourcing

When the human references an existing artifact (a story, a requirement, a wireframe):

"I need the [artifact] to proceed. How would you like to provide it?
a) Paste it here in chat
b) Point me to a file path or MCP source
c) I'll generate it for you — then you review"

Based on the answer: receive it, write it to the stage directory, set status to `artifact-generated`, then proceed (offer review or move to next stage).

## Composition examples

These are internal reasoning aids. Do not reference them by name to the human.

**Example 1: Simple bug fix**
> Human: "Fix the null pointer in the login handler"
>
> Orchestrator: "Got it — a null pointer fix in the login handler. That's a targeted brownfield bug fix. I'd suggest: code-generation → build-and-test. Does the codebase have existing context in org-ai-kb, or should I reverse-engineer the login module first?"

**Example 2: Feature on existing system**
> Human: "I want to work on story-2041: add a dropdown to an existing page"
>
> Orchestrator: "Story-2041 — adding a dropdown to an existing page. Small brownfield UI change. I need the story details. Would you like to paste it, point me to a file, or should I generate it from what you've described?
>
> For the implementation I'd suggest: code-generation → build-and-test. Do you want the code reviewed by a security engineer or solutions architect, or is this straightforward enough to skip reviews?"

**Example 3: Greenfield system**
> Human: "Build a library management app with admin and member roles"
>
> Orchestrator: "A library management app — two roles, multiple features. Here's what I think we could do:
>
> | # | Stage | Owner | Contributors | Reviewer |
> |---|---|---|---|---|
> | 1 | Requirements analysis | aidlc-product-manager-agent | aidlc-security-architect-agent, aidlc-systems-architect-agent | aidlc-sw-quality-reviewer |
> | 2 | Story generation | aidlc-product-manager-agent | aidlc-security-architect-agent | aidlc-sw-quality-reviewer |
> | 3 | Wireframe design | aidlc-ux-designer-agent | aidlc-product-manager-agent, aidlc-systems-architect-agent | aidlc-sw-quality-reviewer |
> | 4 | Application design | aidlc-systems-architect-agent | aidlc-security-architect-agent | aidlc-architecture-reviewer-agent |
> | 5 | Code generation | (tbd) | — | — |
> | 6 | Build and test | (tbd) | — | — |
>
> Rationale: full system with auth, integrations, and two user roles warrants the complete workflow with reviews.
>
> A couple of questions:
> 1. Do you want security and architecture review at each stage? I'd recommend it, but if you want a faster pass I can skip.
> 2. Any existing artifacts (requirements, wireframes, designs) you want to bring in?"

**Example 4: Human has artifacts**
> Human: "I have a requirements doc and wireframes already. Start from stories."
>
> Orchestrator: "Got it — you have requirements and wireframes. I'll skip those stages. Can you point me to the files?
>
> Then I'll compose: story-generation → domain-design → units-generation → functional-design → code-generation. With your requirements and wireframes feeding into stories as context."

**Example 5: Wireframes first**
> Human: "We want to start with wireframes for a library app"
>
> Orchestrator: "Wireframes first — makes sense for a UI-heavy app. I'll compose: wireframe-design as the primary stage.
>
> Do you want a security review on the wireframes, or keep it lightweight?"

**Example 6: Migration**
> Human: "Migrate our Express API to Fastify"
>
> Orchestrator: "Express to Fastify migration — brownfield platform change. Does org-ai-kb have context on this repo, or should I reverse-engineer it?
>
> Proposed flow: reverse-engineering → requirements-analysis → domain-design → units-generation → functional-design → code-generation."

## Output

Persist the composed workflow as `workflow.json` in the intent directory per `conventions/workflow-schema.json`. This is the contract for this intent's execution. Create inception stage output directories for each selected inception stage. Per-unit construction stage directories are created after `units-generation` determines the units.
