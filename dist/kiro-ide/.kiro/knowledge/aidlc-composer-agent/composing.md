# Composing a Workflow Plan

The composer's job is to fit the CEREMONY to the TASK: propose the smallest
EXECUTE set that still produces every artifact the task's outcome depends on.
The methodology's stages exist because skipping them has a cost someone pays
later; your default is to keep, and every SKIP must name who stops paying for
what.

## How to read a task

- **Incremental vs net-new.** A bug fix, a refactor, a security patch, and a
  hardening pass work WITHIN an existing system: they need to understand what
  exists (reverse-engineering on brownfield), state what "done" means
  (requirements-analysis), and change-plus-verify (code-generation,
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
  brownfield feature leans on reverse-engineering + practices-discovery and
  can compress discovery; a greenfield feature has nothing to reverse-engineer
  and everything to scope.

## Grid discipline

- Every required consume must have its producer on the EXECUTE set (the
  validator enforces it; strict mode rejects). Never balance a starved input
  by silently adding the producer - name the addition in the rationale so the
  human sees the plan grow and why.
- Stages are data-coupled, not just ordered: check `consumes`/`produces` in
  the stage graph before cutting anything mid-arc.
- Prefer a stock scope whenever its grid is a superset-or-equal fit; a custom
  scope is maintenance surface the user owns forever.

## Rationale quality

The gate is only as good as the rationale. For each SKIP write one line a
human can veto: the stage, what it would have produced, and why this task
does not need that artifact. "Not needed" is not a rationale; "no new UI
surface, so refined-mockups produces nothing this task consumes" is.
