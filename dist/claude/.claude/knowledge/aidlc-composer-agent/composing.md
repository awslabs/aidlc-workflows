# Composing a Workflow Plan

The composer's job is to fit the CEREMONY to the TASK: propose the minimum
viable workflow - the least sufficient EXECUTE set that still produces every
artifact the task's outcome depends on. Both directions of error are real:
skipping a load-bearing stage has a cost someone pays later, and including
overlapping ceremony "just in case" collapses a composed grid back toward the
stock `feature` scope and defeats the point of composing. Every EXECUTE and
every SKIP must be justified against the entropy profile; neither default
caution nor default economy is acceptable.

## How to read a task

- **Score before you select.** Estimate the five entropy components (intent
  ambiguity, structural uncertainty, verification entropy, risk, unresolved
  assumptions) from the task and the structural evidence BEFORE looking at
  any stock scope. The component bands - not keyword vibes - drive which
  stages carry positive expected value.
- **Incremental vs net-new.** A bug fix, a refactor, a security patch, and a
  hardening pass work WITHIN an existing system: they need to understand what
  exists (reverse-engineering on brownfield, or CodeKB evidence where indexed),
  state what "done" means, and change-plus-verify (code-generation,
  build-and-test). They do not need market-research, user-stories, or
  application-design - those discover and shape a product that already exists.
- **Net-new surface.** A new feature, product, or service needs the discovery
  arc: intent-capture, scope-definition, then the inception design stages in
  proportion to how much NEW structure it introduces.
- **Operational outcome.** Deployment, observability, incident-response, and
  performance stages belong on the plan when the task's DONE lives in an
  environment, not in the repo. A plan that builds but never ships closes no
  operational task.
- **Brownfield vs greenfield changes the WHOLE grid**, not one stage: a
  brownfield feature leans on existing structure and can compress discovery;
  a greenfield feature has nothing to reverse-engineer and everything to
  scope.

## Grid discipline

- Every required consume must have its producer on the EXECUTE set (the
  validator enforces it; in-flight strict mode rejects). Never balance a
  starved input by silently adding the producer - name the addition in the
  rationale so the human sees the plan grow and why.
- Stages are data-coupled, not just ordered: check `consumes`/`produces` in
  the stage graph before cutting anything mid-arc.
- Fold overlapping stages: when two stages both reduce the same component,
  one is a justified stage and the other is a fold candidate. Keep the spine
  (core, verification, and the single load-bearing discovery/design stage for
  a high component); fold framing/discovery stages whose output another
  EXECUTE stage already delivers, and name the un-SKIP trigger.
- Prefer a stock scope when it matches within a couple of stage flips; a
  custom scope is maintenance surface the user owns forever. When no stock
  scope fits, synthesize - do not force a bad match.

## Rationale quality

The gate is only as good as the rationale. For each SKIP write one line a
human can veto: the stage, what it would have produced, and why this task
does not need that artifact (below-threshold component, or the
task/artifact/EXECUTE stage that already covers it). For each EXECUTE name
the component it reduces and that no other EXECUTE stage already delivers
that reduction. "Not needed" is not a rationale; "no new UI surface, so
refined-mockups produces nothing this task consumes" is.
