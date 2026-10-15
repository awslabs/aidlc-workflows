# AI-DLC: one core, many harnesses

This directory contains a native implementation of the AI-DLC (AI-Driven
Development Life Cycle) methodology that ships to many harnesses (today Claude Code, Kiro CLI, Kiro
IDE, Codex CLI, Cursor, opencode, and GitHub Copilot, and any capable CLI
[you port it to](docs/harness-engineering/09-porting-to-a-new-harness.md))
from a single hand-authored source.

## What AI-DLC is

AI-DLC is a software factory for spec-driven design: the person drives it, and
it delivers their project, from the idea to the spec and plan, the code and the
deployment. The harness the person drives it from (Claude Code, Kiro CLI, Kiro
IDE, Codex, Cursor, opencode, Copilot) is the building the factory runs in. It
is the same factory in every building and on every platform (Linux, macOS,
Windows, native or WSL), so a normal run means any of them; judge a finding and
design a fix with all of them in mind.

Ideation transforms the person's intent into a more clearly defined idea;
Inception turns the idea into a spec and a plan; Construction builds the code
that implements the idea and the spec; Operation deploys it and verifies it;
Initialization is the setup before them
([Phases and Stages](docs/guide/04-phases-and-stages.md)).

Scopes are the production lines, stages are the stations on a line, and agents
are the workers at each station. Each station takes what the one before it
produced, and an approved output is the work order for what follows. It is not
a waterfall: the person can go back to any station, change what it produced and
iterate from there, as many times as they like.

The factory is configured, not coded, so a team can reshape it to how it works
([Harness Engineer Guide](docs/harness-engineering/00-overview.md)). A stage
defines what gets done
([Anatomy of a Stage](docs/harness-engineering/01-anatomy-of-a-stage.md)); the
agents define who does it, each with knowledge of its trade that a team
customises with its own
([Adding an Agent](docs/harness-engineering/03-adding-an-agent.md),
[Team Knowledge](docs/harness-engineering/07-team-knowledge.md)); the rules say
how the work is done, from the framework's defaults to the team's and the
project's own
([Rules and the Learning Loop](docs/harness-engineering/05-rules-and-the-loop.md));
sensors check a station's output the same way every time, advisory unless the
team makes one block at a gate
([Sensors](docs/harness-engineering/06-sensors.md)), and together rules and
sensors are how the factory learns: a correction made at a station becomes a
standing rule or a check for next time. A scope picks which stations a kind of
work goes through, and how deep ([Scopes](docs/harness-engineering/04-scopes.md)).
A plugin adds to the factory without changing what ships, never overriding it,
and the team picks which plugins are on in an install; with every plugin off
the install is bare core
([Authoring a Plugin](docs/harness-engineering/10-authoring-a-plugin.md),
[The Plugin Mechanism](docs/reference/18-plugin-mechanism.md)).

The conductor is AI-DLC's core orchestrator: the person's interface to the
engine and the coordinator of the work. (The name comes from an orchestra: a
conductor reads the score and cues the players.) The engine decides which
station is next and keeps the record of the work; the conductor never decides
the route. It asks the engine for the next step, carries that step out, and
reports the outcome through the engine's own command
([The Orchestration Engine and Skill System](docs/reference/17-skill-system.md),
[Orchestrator](docs/reference/03-orchestrator.md)). Its own work is
coordination: it puts the station's agents to work and owns how well the step
is done ([The Conductor's Craft](core/aidlc-common/conductor.md)). Today it
works most stations in the chat itself, wearing the lead agent's hat; the
direction is for every station to be worked by its own separate agent, in the
cloud when the person chooses, so what a station needs (its steps, its agent,
its knowledge, its checks) is authored in the stage and its agent, never in
the conductor's own prose. Toward the person it reads what they meant and
hands the engine exact answers, brings them only the decisions that are
theirs, and says in plain words where the work stands. Agents never call each
other; only the conductor hands out work.

Workers make the calls their station needs and bring the knowledge the person
may not have, like a good colleague; the person makes the judgement calls and
keeps the wheel, reading a dashboard that says in plain words what happened,
what to decide and how to undo it. Guards are there to keep the workers on
track, on the spec and plan the person last approved; they serve the person,
not the engine, and never stand between the person and what the person asks
for. The engine's own words for these (conductor, engine, directive, stage,
scope, agent, fence, Guard Policy) are defined once in the
[Glossary](docs/guide/glossary.md); the factory words here are the picture: a
line is a scope, a station is a stage, a worker is an agent, and the switchable
guards are the Glossary's fences, with Guard Policy the setting that says how
far they stand aside for one piece of work.

## The factory works with what the person brings

The factory and the project it delivers are the person's, and they bring their
own materials and tools to it: the building they drive from, the project as it
is, and the way they have set their tools up. The factory uses all of it as it
is, the way the person's own hands would. A worker who rewires the building or
swaps the owner's tools so their own station feels safer is not keeping on
track; they are taking the wheel. AI-DLC keeps its own record of the work
(state, audit trail, artifacts, the team's rules and knowledge) in the
project's `aidlc/` folder
([Spaces and Intents](docs/guide/03-spaces-and-intents.md)), its install in
the harness directory, and its own marked part in files it shares with the
person, such as `AGENTS.md` and `.gitignore`; everything else in the project is
the person's.

## The four tenets, in this order; the first wins any conflict

**The human drives the engine. Tools for determinism. LLM for knowledge. Human for judgement.**

User experience comes first: every design, change, review finding and question
in this repository is judged by what a person sees and does in a normal run.

- **The human drives the engine.** The person keeps the wheel: they drive the
  engine, and the engine runs the factory. The factory's dashboard shows them
  what they need to decide, in one line, in their tool's words and never in
  engine internals: what happened, where the work stands against what they
  approved, how to undo it, and any real risk or skipped step (a warning said
  once, never a gate). Their words are read for what they meant, so a phrasing
  no word-check knows never refuses or re-asks them. The engine asks once when
  only they can decide, never asks again what they already answered, never
  refuses their explicit request (approve, change, skip, jump, stop, switch a
  check), and never overrides their setup; it refuses only harm that cannot be
  undone and that they did not ask for.
- **Tools for determinism.** The agent should not have to carry the
  bookkeeping: which station is next, what the person approved (which version,
  and when), and what has already run. That part is mechanical, and a tool or
  hook does it the same way every time, so the agent's instructions stay short
  and about the work. A tool owns exact structure (a flag, a stage name, an
  option number, a record) and records that a message came through the person's
  own prompt, keeping their words whole (an observed interaction, not proof of
  identity); the tool itself never reads meaning or language.
- **LLM for knowledge.** The worker at each station brings knowledge the person
  may not have: coding, design, testing, the tools, the method, this project's
  code. It makes the calls that knowledge settles, such as how to build what
  the approved spec and plan say. When a choice is the person's (what the idea
  is, what the spec should say, a trade-off in the plan), it asks the way a
  good colleague would, assuming no technical knowledge: the options in plain
  words, what each means for them, and its recommendation, so anyone can decide
  and someone who knows more can weigh in. Reading the person's words for what
  they meant (an intent statement, the parameters a /aidlc request calls for,
  which open question a reply answers) is part of that knowledge, and the agent
  hands the tool exact, structured arguments.
- **Human for judgement.** The person decides what to build (the idea and the
  spec), whether it is right (each gate), what to trade off and when to stop;
  nothing tools or knowledge can settle is put to them. A tool never makes the
  call of what the person meant or wants; when meaning is really unclear, the
  agent asks once, in plain words.

An explicit request means the person's own words, never the agent's account
of them. Exact answers such as "Approve", an option number, or a slash command
are shortcuts the tools may read; anything else is the agent's to understand.
Gates exist to collect the person's judgement, so when the person decides
(approve, change, skip, jump, or switch a check off), the flow records that
decision through its own mechanism instead of refusing it. A tool that judges
the meaning of a person's words, or that second-guesses an explicit request,
is a defect, however safe it looks.

**What the person reads.** In a normal run, every line AI-DLC puts in front of
the person, printed by the engine or written by the agent, is about their work:
what happened, where it stands against what they approved, what they can
decide, and the way back, in plain words and in their tool's own terms. How the
engine got there (its steps and fields, hooks, receipts, protocol labels,
internal tags) stays off the screen unless they ask, or run a check or report
on purpose (doctor, status, the audit record), where they get the whole
picture. A line has to change what the person does or judges: a change in
AI-DLC itself (an update, a stage it now does differently) reaches them only
when it changes what their work needs, and otherwise stays in the record that
status, doctor and the audit show on purpose.
A command or path they need in order to act (an undo, a file to edit)
is their work and is said; the agent's account of their code (files read, tests
run, what it found) is their work too. A frame the host tool draws itself
(Claude Code's "Stop hook error") is the host's; the words inside it are
AI-DLC's. Plain words change how a thing is said, never what is said: a real
risk, a skipped step, and a refusal with its next step are still said, once and
in one line, and a wrong line is a defect whatever its words. The fix for
engine words the agent says belongs in the tools (cut the words reaching the
agent, move the branch into the tool), never in a "do not say X" sentence. This
rule never drops a risk line, a skipped-step note, an undo, a guard's next step
or doctor and status detail, and never charges a host frame to AI-DLC.

**Guards.** A guard is a deterministic check over recorded facts, aimed at an
agent's action, never at a person's message. Its refusal names the exact next
step. The person's plain request lifts it, and the lift is recorded with their
words. When a guard or tool loses its own coordination bookkeeping (a claim on a
command, a busy lock, a project-identity hash that no longer matches), it fails
toward the person's last recorded instruction with a one-line note, never into a
re-ask, a refusal, or a loop with no way out. Evidence that selects or binds a
human decision (an approval record, the plan fingerprint, the marker naming the
approved target) is different: it never falls back to a guess. Its owning
mechanism decides whether the approval still holds (for Plan Approval, the
contract in
[Plan-Approval Guard Hook](docs/reference/06-hooks-and-tools.md#plan-approval-guard-hook)),
and the flow never loops on it and never asks the person to approve again what
that mechanism says still holds.

**What guards are for.** Guards keep the workers on track, on the spec and plan
the person last approved, when a worker runs ahead, skips a step or misreads.
They serve the person, not the engine, and never stand between the person and
what the person asks for; a worker that deliberately works around them is a
matter for the building's own doors (the host tool's permission prompts), the
plan question and the person watching, not for another guard. The factory
answers for its own machines: it never leaks a secret, runs a command nobody
ordered, writes outside the project, or changes the install or the person's
settings unasked.

**One owner per rule.** Every invariant (approval, transition, presence, the
plan fingerprint) has one owner and one shared check. Enforcing that check at
several boundaries (a hook for fast feedback, a command-line floor where hooks
cannot run) is fine; a second, independently written version of the same rule
is a defect, however safe it looks.

**Prior judgement.** A setting the team explicitly locked (for example a strict
Guard Policy held in memory) and an unattended run are human judgement already
made, and they outrank one person's chat request. The flow says in one line that
it is locked, where, and that changing that file changes it; it never loops or
refuses silently. Defaults are not locks: the person can change a scope, a
ceremony, a per-intent setting, or the conversation language whenever they ask.

## Project Structure

- `core/`: **The hand-authored, harness-neutral source of truth.** Tools, stages (`aidlc-common/`), agents, memory (the rule/method layer), scopes, sensors, knowledge, hooks, and the 4 skills (3 read-only session skills and `aidlc-knowledge`, the team-document index). Prose names the harness directory with the `{{HARNESS_DIR}}` token; the packager substitutes `.claude`/`.kiro`/`.codex`/`.aidlc`/`.cursor` per tree.
- `harness/<name>/`: **The thin per-harness authored surface.** Each holds `manifest.ts` (how to project `core/` into that harness's dist) plus the orchestrator skill and harness-specific files; `harness/codex/`, `harness/opencode/`, and `harness/copilot/` add an `emit.ts` (per-shell emissions). `claude/`, `kiro/`, `kiro-ide/`, `codex/`, `cursor/`, `opencode/`, `copilot/`.
- `plugins/<name>/`: **Optional, owned AIDLC plugins** (the plugin mechanism; design in the single chapter `docs/reference/18-plugin-mechanism.md`, authoring guide `docs/harness-engineering/10-authoring-a-plugin.md`). Each holds `.aidlc-plugin/plugin.json` (the declarative manifest) + core-shaped subtrees (`stages/`, `contributions/`, `sensors/`, `tools/`, ...) + `tests/`. `bun scripts/package.ts` emits a real host plugin per harness at `dist/plugins/<name>/{claude,codex,copilot,cursor,kiro,kiro-ide,opencode}/`; a compose hook merges the plugin into an install (new stages + the additive contribution seam). Plugins add, the install selects: `tools/data/harness.json` `plugins` filters the enabled graph/scope/runner surfaces while keeping installed files re-enableable. `plugins/test-pro/` is the reference fixture. Guarded by `tests/integration/t188-plugin-compose.serial.test.ts` (mechanism) + `plugins/test-pro/tests/` (content, wired into the integration tier).
- `scripts/package.ts`: **The build entry.** `bun scripts/package.ts` materializes every local `dist/<harness>/` and `dist-release/<harness>/`; `bun scripts/package.ts --check` builds twice in independent temp roots and byte-compares the results as the determinism guard. `manifest-types.ts` is the shared manifest contract.
- `dist/` and `dist-release/`: **GENERATED, ignored local outputs.** They are never committed or hand-edited. CI, tests, binary builds, and release packaging regenerate them before use. Native users install release assets; copy-channel users take `runtime/<harness>/` from the versioned `aidlc-copy-runtime-X.Y.Z.tar.gz` release asset.
- `tests/`: All-TypeScript test suite (`t*.test.ts`, run via bun), four levels (smoke/unit/integration/e2e). Run `bash tests/run-tests.sh --help` for levels and profiles.
- `docs/guide/`: User Guide: getting started, workflows, scopes, agents, customization, troubleshooting
- `docs/harness-engineering/`: Harness Engineer Guide: reshaping AIDLC through configuration (stages, agents, scopes, rules, sensors, knowledge) without code, plus porting AIDLC to a new harness
- `docs/reference/`: Developer Reference: architecture, orchestrator, stage protocol, hooks, testing, contributing

## How It Works

The hand-authored source lives in `core/` (harness-neutral) + `harness/<name>/`
(per-CLI surfaces); `bun scripts/package.ts` regenerates the `dist/<harness>/`
trees. The core uses the same building blocks in every harness:

- **Stages** (`aidlc-common/`): the stage protocol (`protocols/`) and 33 stage files across 5 phases (`stages/<phase>/`: initialization, ideation, inception, construction, operation); the orchestrator skill is per harness (`harness/<name>/skills/aidlc/SKILL.md`)
- **Skills** (`skills/`): the 3 read-only session skills and `aidlc-knowledge`
- **Agents** (`agents/`): 14 `aidlc-<role>-agent.md` files: 11 domain-expert personas (product, design, delivery, architect, aws-platform, compliance, devsecops, developer, quality, pipeline-deploy, operations), 2 review-only agents (product-lead, architecture-reviewer), and the adaptive-workflows composer (aidlc-composer-agent)
- **Method/rules** (`memory/`): Layered config in the space memory layer: `org.md` (framework defaults), `team.md` (affirmed practices), `project.md` (project overrides), and `phases/<phase>.md` for ideation/inception/construction/operation
- **Sensors** (`sensors/`): Deterministic verification manifests (advisory): `aidlc-claim-sources.md`, `aidlc-required-sections.md`, `aidlc-upstream-coverage.md`, `aidlc-traceability.md`, `aidlc-linter.md`, `aidlc-type-check.md`
- **Knowledge** (`knowledge/`): Methodology reference. Per-agent under `aidlc-<agent>-agent/`; cross-agent material in `aidlc-shared/`
- **Tools** (`tools/`): TypeScript CLI tools, all prefixed `aidlc-*.ts` and run via bun
- **Hooks** (`hooks/`): 17 framework hooks, all prefixed `aidlc-*.ts`, covering audit emission, sensor dispatch, stage-graph rebuild, session lifecycle, state validation, subagent tracking, statusline rendering, human-turn recording, exact stage-rule delivery, forwarding-loop enforcement, reviewer read-scope enforcement, review-receipt write-freeze enforcement, code-generation plan-approval enforcement, runtime-record protection and helper lifecycle enforcement, and token-usage folding (the Claude-only usage-ledger producer)

## Working on This Project

- **Edit `core/` (or `harness/<name>/`), never `dist*`.** After editing, run `bun scripts/package.ts` to materialize local projections and `bun scripts/package.ts --check` to confirm the generator emits byte-identical results from two clean builds.
- **Markdown block structure has one interpreter:** `markdownBlocks` in `core/tools/aidlc-lib.ts`, backed by the built-in `Bun.markdown` renderer, supplies block visibility, containers, link reference definitions, and claim-splitting structure; `visibleMarkdownLines` projects it. Do not add a Markdown dependency, another block scanner, or a definition grammar. The security-sensitive `Bun.markdown.render` review-authority check is a deliberately separate code path.
- The orchestrator skill (`harness/<name>/skills/aidlc/SKILL.md`) is per-harness; the engine and methodology live in `core/`.
- User-facing onboarding uses two skeletons: `core/templates/onboarding.md` is marker-free neutral guidance; `core/templates/onboarding-harness.md` carries each harness's `onboarding.fills.ts`. Edit the neutral template for shared project guidance and the harness skeleton/fills for native setup. Kiro, Kiro IDE, Codex, Cursor, and opencode share byte-identical root `AGENTS.md` content and ship native onboarding inside their harness directories; Claude concatenates both parts in `.claude/CLAUDE.md`, and Copilot in its exclusive root `AGENTS.md`.
- "harness" has three senses in this repo: `harness/` (top-level, the per-CLI distribution surfaces of this effort), `docs/harness-engineering/` (the Harness Engineer Guide), and `tests/harness/` (test-suite helper library), which are unrelated.
- See `docs/guide/` (User Guide), `docs/harness-engineering/` (Harness Engineer Guide), and `docs/reference/` (Developer Reference) for full documentation

## Comments

Agents read this code more than people do, and they can read the code itself. A comment earns its place when it says what the code cannot.

- **Keep:** why the code is this way, the path that was tried and rejected, a constraint that lives somewhere else, a platform quirk, who owns a rule, a test file's header saying what it checks, and a short label that maps a long block.
- **Cut:** a comment that restates the next lines; history git already keeps (where code was ported from, review rounds, "used to", "now", dates), unless the history is the reason; commented-out code; a TODO with no owner; an empty banner.
- **Point by name, never by line.** Name the function, test, section or file you mean; a line number goes wrong as soon as someone edits above it. `tests/unit/t-comment-pointer-lint.test.ts` fails on a pointer such as `aidlc-lib.ts:4144`, `lib:357-361` or `(:869)` in any comment under `core/`, `harness/`, `scripts/`, `plugins/` and `tests/`.
- **A wrong comment is worse than none.** When you change code, fix or cut the comment that describes it.
- **Leave machine-read comments as they are:** `covers:` headers and the claim tokens on their lines, `@ts-expect-error`, `biome-ignore`, and markers a tool reads, such as `/* @aidlc-shipped-entrypoints@ */`. Some tools read plain words too: the merge queue's macOS run picks the unit test files whose source names macOS or darwin (`scripts/ci-macos-unit-selection.ts`), so keep that word in a test that needs the macOS run.

## Test Suite

Run `bash tests/run-tests.sh --help` for levels and flags. See `docs/reference/09-testing.md` for full strategy.

## Utility Handler Checklist

See `docs/reference/11-contributing.md` section "Adding a Utility Handler" before implementing a new `/aidlc --*` command.

## Documentation Policy

IMPORTANT: When adding, removing, or renaming files, directories, commands, or flags, grep `docs/` and `README.md` for stale references and update them in the same commit.

## Release Metadata Policy

IMPORTANT: Feature, fix, documentation, refactor, and test PRs do NOT bump `core/tools/aidlc-version.ts`, change the README version badge, or add a release entry to `CHANGELOG.md`. Those coordinated updates belong to the release-preparation PR, which summarizes the user-visible changes merged since the previous release. Every PR must preserve existing changelog entries.

The release-preparation PR updates `core/tools/aidlc-version.ts` (the authored source; the per-harness `dist/<harness>/.../tools/aidlc-version.ts` copies are regenerated by `bun scripts/package.ts`), the README badge, and a matching `## [X.Y.Z] - YYYY-MM-DD` heading in `CHANGELOG.md` in the same commit. The pin in `tests/unit/t68-version-changelog-sync.test.ts` enforces that these three release surfaces agree and that changelog headings remain unique.

Each release entry follows the shape: `## [N.N.N] - YYYY-MM-DD` heading, a `Compatibility:` line, one-paragraph summary that includes any upgrade instruction, then a flat bullet list focused on what users actually invoke (commands, flags, errors they see, breaking changes for CI/scripts).

The `Compatibility:` line sits right under the heading and tells a team running many projects what the upgrade asks of each one, in one of three fixed values: `Compatibility: refresh only` (run `aidlc update`, then `aidlc config` in each project; nothing else), `Compatibility: refresh plus a step` (the same, plus one named step the entry says), or `Compatibility: breaking for scripts` (something a script or CI relies on changed; the entry's `Breaking for scripts:` bullets say what). `t68` checks every entry newer than 2.11.0: the line is there with one of the three values, and an entry with a bullet starting `Breaking for scripts:` says `breaking for scripts`. Entries up to and including 2.11.0 stay as they shipped.

That entry is the body of the stable GitHub Release: the release job writes it to a file and passes it with `--notes-file`, so what the entry says is what people read on the release page. GitHub's generated notes are not used, because their list names every contributing account by handle.

If concurrent release-preparation branches choose the same version, the later one must rebase and select the next intended release version before merging. CHANGELOG version link references were removed in v0.6.9 because a distributed file should not embed a repository host; `t68` guards that none reappear.
