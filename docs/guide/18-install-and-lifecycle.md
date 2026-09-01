# Install and Lifecycle

The native release channel installs an `aidlc` command and one
or more harness runtimes. `aidlc config` then creates or refreshes a project from
that local runtime. The installed command and config path do not require Bun or
Node.js. The authenticated bootstrap requires GitHub CLI (`gh`) so the installer
script is verified before execution.

This chapter describes the native install lifecycle available in this release.
The planned `aidlc setup` experience, npm package, and package-manager formulas
are not available yet. Manual-copy users take the versioned runtime from
`aidlc-runtime.tar.gz`; framework developers may separately generate the
Bun-invoking `dist/` projection from source.

## Install

Release assets cover:

- macOS x64 and arm64
- Linux x64 and arm64, with glibc and musl builds
- Windows x64

Install as the target user. The Unix installer refuses root; the Windows
installer refuses an elevated Administrator session. Native installs are
per-user and do not need `sudo`.

Alpine Linux's musl asset follows Bun's own runtime contract: Bun's musl build,
like Node.js, requires the system `libgcc` and `libstdc++` packages. Fully
static Bun musl compile targets remain an upstream-tracked feature rather than
an available target today. Install the prerequisites before running the
installer or binary:

```sh
apk add libgcc libstdc++
```

This prerequisite applies to both x64 and arm64 Alpine systems. Installing the
system packages may require administrator rights, but the AI-DLC install itself
still runs as the target user. The installer detects the corresponding loader
failure and prints the command above; it never runs `apk` or installs system
packages. The upstream Bun tracking includes `oven-sh/bun#15829` and
`oven-sh/bun#29681`.

The installer includes `claude`, `kiro`, `kiro-ide`, `codex`, and `opencode`
together:

```bash
tmp="$(mktemp -d)"
tag="$(gh release view --repo awslabs/aidlc-workflows --json tagName --jq .tagName)"
source_digest="$(gh api "repos/awslabs/aidlc-workflows/commits/$tag" --jq .sha)"
gh release download "$tag" --repo awslabs/aidlc-workflows --dir "$tmp" \
  --pattern install.sh --pattern aidlc-release.intoto.jsonl
gh attestation verify "$tmp/install.sh" \
  --bundle "$tmp/aidlc-release.intoto.jsonl" \
  --repo awslabs/aidlc-workflows \
  --signer-workflow awslabs/aidlc-workflows/.github/workflows/release.yml \
  --source-ref refs/heads/main \
  --source-digest "$source_digest"
sh "$tmp/install.sh"
rm -rf "$tmp"
```

### macOS and Linux

```bash
tmp="$(mktemp -d)"
tag="$(gh release view --repo awslabs/aidlc-workflows --json tagName --jq .tagName)"
source_digest="$(gh api "repos/awslabs/aidlc-workflows/commits/$tag" --jq .sha)"
gh release download "$tag" --repo awslabs/aidlc-workflows --dir "$tmp" \
  --pattern install.sh --pattern aidlc-release.intoto.jsonl
gh attestation verify "$tmp/install.sh" \
  --bundle "$tmp/aidlc-release.intoto.jsonl" \
  --repo awslabs/aidlc-workflows \
  --signer-workflow awslabs/aidlc-workflows/.github/workflows/release.yml \
  --source-ref refs/heads/main \
  --source-digest "$source_digest"
sh "$tmp/install.sh"
rm -rf "$tmp"
export PATH="$HOME/.local/bin:$PATH"
```

An online run needs `gh` plus `curl` or `wget`; every run needs `sha256sum` or `shasum`.
It installs
versions under `${XDG_DATA_HOME:-$HOME/.local/share}/aidlc/versions/` and
links `$HOME/.local/bin/aidlc` to the active version by default.

The installer does not edit a shell startup file unless
`--profile <absolute-path-under-$HOME>` is explicit. That option writes or
updates one `BEGIN AI-DLC:PATH` block transactionally and preserves the rest
of the file. The profile cannot be inside the AI-DLC install or command roots;
existing markers must be unique, exact full lines, and ordered begin-before-end.
Malformed marker layouts are refused without changing the profile.

### Windows PowerShell

```powershell
$download = Join-Path $env:TEMP "aidlc-install-$PID"
New-Item -ItemType Directory -Force $download | Out-Null
$tag = gh release view --repo awslabs/aidlc-workflows --json tagName --jq .tagName
$sourceDigest = gh api "repos/awslabs/aidlc-workflows/commits/$tag" --jq .sha
gh release download $tag --repo awslabs/aidlc-workflows --dir $download `
  --pattern install.ps1 --pattern aidlc-release.intoto.jsonl
gh attestation verify (Join-Path $download install.ps1) `
  --bundle (Join-Path $download aidlc-release.intoto.jsonl) `
  --repo awslabs/aidlc-workflows `
  --signer-workflow awslabs/aidlc-workflows/.github/workflows/release.yml `
  --source-ref refs/heads/main `
  --source-digest $sourceDigest
& (Join-Path $download install.ps1)
Remove-Item -Recurse -Force $download
```

Windows installs versions under `%LOCALAPPDATA%\aidlc\versions\` and keeps a
stable `%LOCALAPPDATA%\aidlc\bin\aidlc.cmd` shim. The installer adds that bin
directory to the current PowerShell process and prints the command needed in
new sessions; it does not edit a PowerShell profile.

PowerShell installer parameters use their native names, such as `-Version`, `-From`, `-Offline`,
`-ReleaseBaseUrl`, `-CaBundle`, `-Yes`, `-Quiet`, `-Json`, and `-NoColor`.

### Automation

Installation asks no harness question. Human and non-interactive runs install
the same binary plus all harness runtimes.

### Installer Options

| Unix | PowerShell | Meaning |
|------|------------|---------|
| `--version <x.y.z>` | `-Version <x.y.z>` | Install one strict semantic version instead of latest |
| `--from <dir>` | `-From <dir>` | Read a flat release set locally and imply offline mode |
| `--offline` | `-Offline` | Forbid network access; requires `--from` / `-From` |
| `--release-base-url <url>` | `-ReleaseBaseUrl <url>` | Use a compatible release mirror |
| `--ca-bundle <absolute-path>` | `-CaBundle <absolute-path>` | Use a custom CA bundle |
| `--profile <absolute-path>` | Not available | Transactionally add the Unix PATH block |
| `--yes` | `-Yes` | Automation mode; it does not bypass integrity checks |
| `--quiet` | `-Quiet` | Suppress progress and emit one result line |
| `--json` | `-Json` | Suppress progress and emit one schema-versioned JSON result |
| `--no-color` | `-NoColor` | Disable color output |
| `--help` | Not exposed | Print Unix installer usage |

`AIDLC_RELEASE_BASE_URL` and `AIDLC_CA_BUNDLE` provide installer defaults;
explicit options win. `AIDLC_RELEASE_REPOSITORY` selects the GitHub repository
trusted by provenance verification and defaults to `awslabs/aidlc-workflows`.
`AIDLC_RELEASE_WORKFLOW` selects the trusted signer workflow and defaults to
`<AIDLC_RELEASE_REPOSITORY>/.github/workflows/release.yml`. Set these explicitly
for a fork or mirror, together with its release base URL; changing the download
URL alone does not change the provenance trust root. `AIDLC_GH_BIN` selects an
explicit GitHub CLI executable for both installers.

Fork release rehearsals also need a protected `release` environment restricted
to exactly the `main` branch, a
protected-environment GitHub App identity with Actions read and Administration
write plus Contents write, and two tag rulesets over exactly `refs/tags/v*`
with no exclusions. The environment names exactly the `aidlc-admins` team as
reviewer. The creation-only ruleset names exactly that protected release App
integration in `always` bypass mode; the update-plus-deletion ruleset has no
bypass actors. Immutable releases must also be enabled and enforced by the
repository owner.

`AIDLC_INSTALL_ROOT` and `AIDLC_BIN_DIR` override the machine and command
locations. Those paths must be absolute on Unix. The PowerShell installer also
honors `AIDLC_OFFLINE=1`; the Unix installer requires the explicit `--offline`
or `--from` spelling.

### Release Authentication

The installer:

1. Verifies the installer script against the release's Sigstore bundle before execution.
2. Downloads or reads `version.json`, `checksums.txt`, and
   `aidlc-release.intoto.jsonl`.
3. Verifies the `checksums.txt` attestation against the repository,
   signer workflow, and `refs/heads/main` before trusting any checksum.
4. Verifies the `version.json` SHA-256, then re-verifies the attestation against
   the authenticated `sourceDigest` shared by `main` and the release tag.
5. Verifies the selected binary and harness archives by SHA-256 and declared
   byte length.
6. Lets the verified binary validate and transactionally install the release.

Metadata is limited to 1 MiB and individual release assets to 1 GiB. Asset
names cannot contain paths. Archive extraction rejects links, special files,
path traversal, absolute paths, duplicate entries, and oversized expansion.

The release workflow assembles the candidate once. Staging and Unix/Windows
lifecycle jobs verify `checksums.txt` and test those bytes without signing
permissions. They add a job-local verifier fixture solely because the real
attestation is created after the protected release gate; that fixture is never
uploaded. After the gate, `publish` re-verifies the
candidate, attests it, exports `aidlc-release.intoto.jsonl`, validates the
complete inventory, and uploads one immutable workflow artifact. The protected
`promote` job authenticates `checksums.txt` online and through that bundle
before reading it, verifies every manifest asset through both provenance paths,
records the complete digest set, and runs the real installer journey from a
separate copy. It then rechecks the untouched publication directory and creates
the GitHub Release as a private draft after minting a fresh App token and
revalidating the environment, immutable-release setting, and complete ruleset
set. It verifies the draft's complete inventory and
redownloaded bytes, and probes that release ETags change for asset creation,
metadata changes, and deletion. It also proves a stale `If-Match` request is
rejected before conditionally retargeting that exact verified staging draft to
the unused guarded `v*` tag and publishing it. The protected release App is the
creation ruleset's sole bypass; the workflow's normal token and ordinary
repository writers have read-only or non-bypass authority. A concurrent draft
change therefore returns `412`, and a writer cannot publish the staging draft
as the official release. Failed staging releases remain available to the
release owner for inspection; no automatic cleanup deletes a staging release
or ref that may have acquired independent evidence. The bundle is intentionally outside `version.json` and
`checksums.txt`: those files cover the installable artifacts, while the bundle
is its own Sigstore trust channel.
TLS, SHA-256, and that provenance are the permanent trust model. OS
code-signing and notarization are not part of it. See
[Supply-Chain Security](../reference/19-supply-chain-security.md).

The installer refuses an existing mixed-ownership command. It also yields to
an existing Homebrew or Nix command instead of replacing it. This project does
not yet ship those package-manager channels; use the owning manager or choose
an explicit empty `AIDLC_BIN_DIR`.

## Configure or Refresh a Project

Run config before opening the harness:

```bash
cd your-project
aidlc config --dry-run --json
aidlc config
aidlc doctor
```

`aidlc config` is local-only and transactional. It creates the selected harness
tree, the `aidlc/` workspace shell, root integrations, a projection stamp, and
an ownership baseline. It does not create a workflow intent.

After a successful scaffold or refresh, config runs a cheap installed-result
sweep. It checks only the non-interactive hook PATH, host trust files, and
recorded provider actions; it does not spawn the harness CLI or contact a
provider. The transaction still exits 0. Non-TTY human output names every
outstanding item and the exact `aidlc config runtime`, `aidlc config trust`, or
`aidlc config providers --check` follow-up. JSON includes
`data.outstandingActions`. Quiet output stays one line when clean and appends
one outstanding-actions line when follow-up is required.

On a human TTY, a bare first run starts with detection rather than questions:
installed harness CLIs on `PATH`, project state, local AWS credentials and
regions, and the non-interactive hook runtime. With one detected harness, the
wizard names it and offers three choices: recommended defaults, six-step
customization, or exit with nothing written. Multiple detected harnesses get a
numbered harness picker first; no detected harness gets the complete picker
without a default.

Recommended defaults state the bundle on the option line. Customization walks
Harness, Model provider, Model effort preset, Plugins, MCP servers, and settings
layer. Every numbered prompt has a bracketed default, invalid input re-asks in
place, and each answer is echoed. A check-your-answers table accepts Enter to
apply or a step number to edit. No files are written before that final gate.
After apply, gerund receipts name the project files and settings layer,
genuinely blocking actions follow, then the wizard prints the exact harness
launch and first workflow command.

An existing-project rerun keeps the seven-row map for Harnesses, Models,
Runtime, Flags, Project, Providers, and Trust. Rows are lowercase `[ok]` or
`[needs]`; one default-yes gate walks only Runtime, Providers, and Trust
findings. Runtime leads with the immediate action and points to
`aidlc config runtime --show` for diagnostics. The closing ledger is a compact
label-to-command list. Section-named commands, non-TTY runs, `--dry-run`,
`--json`, and `--quiet` keep their deterministic output and never render the
interactive wizard.

### Config Options

| Option | Meaning |
|--------|---------|
| `--project-dir <path>` | Target this project instead of the current directory |
| `--harness <name>` | Select an installed harness runtime |
| `--from <dir-or-tgz>` | Use a local projection directory or projection archive instead of an installed runtime |
| `--mcp defaults\|none` | Add or omit Claude's optional shipped MCP entries |
| `--dry-run` | Calculate the complete plan without creating the target directory or changing bytes |
| `--plan-token <token>` | Apply only the exact plan approved from a JSON dry run |
| `--force` | Replace locally modified framework-owned files and managed blocks where that policy permits |
| `--yes` | Confirm an otherwise unrecognized target directory or a section mutation; it does not imply MCP consent or choose a section answer |
| `--json` | Emit one result object with counts, actions, and `data.planToken` |
| `--quiet` | Emit one summary or remediation line |
| `--no-color` | Disable color output |

### Model Policy

`aidlc config models` records project model policy under the selected harness's
`tools/data/harness.json` and applies it through the normal config plan,
confirmation, refresh guard, and transaction. It never contacts a model
provider.

The public groups are:

| Group | Agents | Shipped tier |
|-------|--------|--------------|
| Deciding | 9 design, implementation, product, security, and quality agents | judgment |
| Reviewing | product lead and architecture reviewer | balanced |
| Writing up | delivery, pipeline and deploy, and operations | templated |

Policy resolves per agent in this order:

1. Per-agent exception
2. Group dial, set directly or through a preset
3. Shipped tier default
4. Session inherit

Pins bind in both directions. A pinned agent stays pinned if the session later
moves to a larger model. The framework never raises an agent above the session
on its own. Judgment and Writing up inherit by default; only the measured
balanced reviewer baseline ships a step-down. Use `aidlc config models` to
record a per-install Writing up downgrade.

```bash
aidlc config models --show
aidlc config models --reviewing-effort xhigh --project --yes
aidlc config models --agent architect --effort xhigh --model provider/raw-id --project --yes
aidlc config models --check
aidlc config models --reset --project --yes
```

`--show --json` prints every agent's effective model, effort, and provenance.
`--check` is the CI inverse and exits non-zero when the recorded policy is not
fully reflected in the harness surfaces.

Model and flag policy resolves leaf-by-leaf through this hierarchy:

1. Shipped defaults in the tier and preset tables
2. Machine `${AIDLC_INSTALL_ROOT:-~/.local/share/aidlc}/aidlc.settings.json`
3. Project `aidlc.settings.json`
4. Personal `aidlc.settings.local.json`
5. Environment variables

The project file is committed team policy. The local file is personal and is
added to `.gitignore` when the config command creates it. Mutations require
exactly one of `--project`, `--local`, or `--global`; the interactive wizard
asks for the layer and recommends project policy inside a repository. Outside
a recognized project only the machine layer is valid, so `--global` is
inferred. `--show` labels each effective value with its winning source.

All three files use one strict schema. Unknown keys fail closed, and
update/release keys such as `offline` and `release-base-url` are machine-only.
Editors can reference the generated
`<harness>/tools/data/aidlc-settings.schema.json`; no defaults settings file is
written.

Three immutable effort-only presets ship:

- `thorough`: reviewing effort xhigh
- `balanced`: reviewing effort medium, explicitly matching the shipped default
- `minimal`: reviewing effort medium, writing-up effort low

Presets never set model IDs or deciding effort. Deciding work continues to
inherit the session ceiling.

Derive a project profile from a preset or an existing profile:

```bash
aidlc config models --from thorough --reviewing-effort medium \
  --save-as my-profile --project --yes
```

Presets and profiles contain group efforts only. Raw model IDs are allowed only
on per-agent exceptions. `--yes` confirms a mutation but never chooses a
policy. Without decisive flags, a TTY opens the model policy wizard; a non-TTY
run fails with usage guidance.

Harnesses receive only settings they can read. Codex clamps `max` effort down
to `xhigh`. opencode clamps `xhigh` down to `high`. Kiro CLI cannot express
group effort dials, but a per-agent model exception can carry effort through
`chat.modelDefaults`. Kiro IDE, Cursor, and GitHub Copilot cannot portably pin
agent models or effort, so the command records the policy and reports the
unsupported fields instead of writing inert keys.

Model policy is agent-scoped. Stage files never carry model or effort keys;
scopes continue to own stage criticality.

### In-session alias

`/aidlc --config [section]` is the conversational alias for these same config
sections. The conductor reads the current JSON state before asking, gathers
only the changes you want, and lands each accepted section through one exact
`aidlc config <section> <explicit value flags> --yes` command. Leaving a
section unchanged runs no command. After landing or declining, the alias stops;
it never advances or resumes workflow work.

### Runtime Diagnostics

`aidlc config runtime` checks the environment that project hooks actually use.
On macOS and Linux it derives a non-interactive baseline from `getconf PATH`
and the macOS system path files. On Windows it reads the User and Machine PATH
without loading a shell profile. It then resolves the command required by the
installed hook bytes (`bun` for copy projections or `aidlc` for native
projections) and checks the selected harness CLI.

```bash
aidlc config runtime --show
aidlc config runtime --check
aidlc config runtime --record-paths --yes
aidlc config runtime --reset --yes
```

`--record-paths` records the resolved answers in `harness.json`. It does not
rewrite hook commands. Host permission rules and Codex hook trust bind the bare
`bun` or `aidlc` command prefix, so replacing it with an absolute path would
invalidate the existing trust contract. When a command is interactive-only or
absent, the section gives a platform-specific PATH instruction instead.

The harness CLI check requires `claude`, `kiro-cli`, `codex >= 0.145.0`, or
`opencode` for their matching harnesses. Copilot CLI and the Cursor `agent` CLI
are advisory because those installs may be driven only by VS Code or the IDE.
Kiro IDE has no required separate CLI.

### Provider Diagnostics

`aidlc config providers` records provider answers for this project install.
Amazon Bedrock is the default answer, but the shipped fallback bytes remain
valid when this section has never run.

```bash
aidlc config providers --provider amazon-bedrock \
  --region us-east-1 --profile default --yes
aidlc config providers --show --json
aidlc config providers --check
aidlc config providers --mark-done bedrock-model-access --yes
aidlc config providers --reset --yes
```

Credential detection is offline only. It inspects AWS environment variables,
`~/.aws/config`, `~/.aws/credentials`, role and container credential variables,
and the AWS SSO cache. It never calls STS, Bedrock, a model endpoint, or any
other network service.

Recorded Bedrock answers apply through the normal staged config transaction:

| Harness | Recorded answer application |
|---------|-----------------------------|
| Claude Code | Writes `AWS_REGION` and optional `AWS_PROFILE` in `.claude/settings.json`; also keeps the AWS MCP URL and `AWS_REGION` metadata in `.mcp.json` on the same region |
| Codex CLI | Writes profile and region in `[model_providers.amazon-bedrock.aws]` without changing model or effort keys |
| Kiro CLI | Writes the AWS MCP URL and metadata in `.kiro/settings/mcp.json` |
| Kiro IDE | Records and instructs only; the chat model must be selected manually in the IDE |
| opencode | Offers to write `provider.amazon-bedrock.options.region/profile` to `opencode.json`; `--opencode-default yes|no` records the answer |
| GitHub Copilot | Records acknowledgement of the manual BYOK environment setup |
| Cursor | Records acknowledgement of the manual provider and model-picker setup |

Bedrock model access and IAM permission verification cannot be automated
offline. The record therefore carries named pending actions. `--show` lists
them, `--check` stays non-zero while they are pending, and
`--mark-done <id>` records completion. Kiro IDE also carries the
`kiro-ide-chat-model` action. A non-Bedrock opt-out is supported with
`--provider other --acknowledge`; it records the choice without silently
editing provider bytes.

### Trust Diagnostics

`aidlc config trust` reads and verifies host-native trust. It never regenerates
trust seeds, permission rules, or IDE settings.

```bash
aidlc config trust --show
aidlc config trust --check
aidlc config trust --acknowledge --yes
aidlc config trust --reset --yes
```

For Codex, the check requires the complete project-specific trust seed entry
set in `$CODEX_HOME/config.toml`. The two supported remedies are one TUI
`Trust all and continue` pass or replacing `<PROJECT_DIR>` and merging the
complete seed. Until then zero Codex hooks fire.
`--dangerously-bypass-hook-trust` does not fire untrusted hooks, and appending
a second seed set produces invalid TOML.

For Kiro IDE, the check verifies that `.vscode/settings.json` includes
`aidlc engine *` in `kiroAgent.trustedCommands`; it does not create a new trust
surface. `--show` lists the selected harness's trust and allowlist files.

The trust check also verifies the project siblings that copy installs often
miss: `aidlc/` for every harness, `.agents/` for Codex, and the `.aidlc/`
engine for opencode and Copilot.

Doctor also classifies the installed instruction file against the config
ownership baseline. An intact managed block reports `block present, user
content preserved`; a missing block or file says to run `aidlc config`; a
hand-modified managed block or framework-owned whole file reports a conflict.
The row follows the invoking harness when more than one harness tree is
present.

### Project Flags

`aidlc config flags` records project answers for default scope, swarm mode,
hook debug, sensor timeout, and explicit guard bypasses:

```bash
aidlc config flags --default-scope <installed-scope> \
  --swarm on --hook-debug off --sensor-timeout-ms 90000 --project --yes
aidlc config flags --bypass AIDLC_SKIP_ARTIFACT_GUARD --local --yes
aidlc config flags --show
aidlc config flags --check
aidlc config flags --reset --project --yes
```

Real environment variables always win. Existing tools and hooks first read the
environment and then resolve local, project, and machine settings when the
variable is absent. This keeps CI and one-shot shell exports scriptable.

Default scope names are read from the installed scope files. The section does
not branch on a built-in scope name, so scope renames and plugin scopes remain
data. On Claude Code, config also rewrites the staged
`AWS_AIDLC_DEFAULT_SCOPE` value in `.claude/settings.json`; otherwise the
shipped session environment would shadow the lower-precedence record.

The recordable bypass set is limited to the documented recovery switches:

- `AIDLC_SKIP_ARTIFACT_GUARD`
- `AIDLC_SKIP_HUMAN_PRESENCE_GUARD`
- `AIDLC_SKIP_REVISION_BACKSTOP`
- `AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD`
- `AIDLC_DISABLE_ENSEMBLE_EVIDENCE`
- `AIDLC_DISABLE_PLAN_APPROVAL_GUARD`
- `AIDLC_DISABLE_REVIEWER_SCOPE_HOOK`
- `AIDLC_DISABLE_REVIEW_FREEZE_HOOK`
- `AIDLC_DISABLE_USAGE_TRACKING`

The wizard never offers bypasses. They require an explicit `--bypass <name>`;
`--show` surfaces every enabled bypass and its guard-weakening consequence.

### Project Choices

`aidlc config project` records the installed plugin selection, MCP consent,
and the shell-completion answer:

```bash
aidlc config project --plugins aidlc,test-pro --mcp none \
  --completions zsh --yes
aidlc config project --show --json
aidlc config project --check
aidlc config project --reset --yes
```

Plugin names are discovered from the installed graph, scopes, and plugin
sidecars. They are not hardcoded. The selection continues to use the existing
top-level `plugins` array in `harness.json`, so graph and runner regeneration
use the same selection seam as plugin composition. Project mutations run
through the refresh safety guard and refuse while a workflow is active.

MCP consent remains `defaults` or `none`. A non-interactive project mutation
with no earlier consent records `none`; `--yes` only confirms the mutation and
never adds MCP entries.

On Claude Code, `.mcp.json` is the consent-managed surface: `--check` verifies
both `defaults` and `none`, and later plain config refreshes reapply the answer.
Kiro CLI always ships `.kiro/settings/mcp.json`; `defaults` is satisfied by
that file and its five shipped servers, while `none` is an instruct-only
preference and does not remove a framework-owned file. The current Codex,
opencode, Copilot, Kiro IDE, and Cursor distributions ship no MCP surface, so
their recorded answer is informational and does not make `--check`
permanently red. `--show` names the actual MCP file whenever one exists.

Completions are instruction-only and write no machine files. Native installs
print commands such as:

```bash
eval "$(aidlc system completions bash)"
```

Copy-channel installs print the matching Bun invocation, for example:

```bash
eval "$(bun .claude/tools/aidlc.ts system completions bash)"
```

Fish uses `... completions fish | source`; PowerShell uses
`... completions powershell | Out-String | Invoke-Expression`.

An existing project stamp fixes the harness for a refresh. A fresh interactive
project prompts for a harness; a non-interactive run requires `--harness`.
If `.aidlc-version` exists, config
requires a source at that exact version with the matching project harness.

Config recognizes directories containing `.git`, `package.json`, `Cargo.toml`,
`go.mod`, or `pyproject.toml`. Outside those shapes, interactive mode asks for
confirmation and non-interactive mode requires `--project-dir`.

Claude's optional MCP integration defaults to `none` without a TTY. A human
TTY is prompted when no prior choice exists. `--yes` and `--json` do not grant
MCP consent. Reliable automation supplies `--project-dir`, `--harness`, and
`--mcp defaults|none` explicitly; JSON controls output but does not disable
TTY prompts by itself.

For exact scripted approval:

```bash
token=$(
  aidlc config --project-dir "$PWD" --harness claude --mcp none \
    --dry-run --json | jq -r .data.planToken
)
aidlc config --project-dir "$PWD" --harness claude --mcp none \
  --plan-token "$token" --json
```

Use identical source and behavior options for both calls. Source bytes,
options, or project state changing after the preview changes the token and
the apply fails closed.

### Refresh Safety

A refresh changes project engine and graph files, so config refuses while any
workflow in any space is not complete. Parked workflows still count as
active. Complete every workflow named in the error, then rerun config.

The check runs once while planning and again under the workspace audit lock
immediately before commit. `--force`, `--yes`, and `--plan-token` do not bypass
it. `aidlc update` and `aidlc use` remain safe during a workflow because
they only change machine state.

Refresh preserves:

- all workspace records, audit shards, knowledge, and other project files
  absent from the shipped projection
- existing `aidlc/active-space` and space memory files, which are
  project-owned seeds
- every non-identity sibling key in mutable `tools/data/harness.json`,
  including plugin selection and future policy records
- plugin-composed files and recorded stage contributions, then regenerates
  graph, runner, scope, and compiled table surfaces
- upstream-authored orchestrator prose while rebuilding its compiled stage and
  scope regions from the preserved project composition

Locally modified framework-owned files conflict against the prior baseline.
`--force` replaces those files with the refreshed candidate, including local
edits to hand-authored orchestrator prose. It does not claim unrelated
project content.

### Root Integrations and Ownership

| Surface | Harnesses | Policy |
|---------|-----------|--------|
| `.gitignore` | All | Own one marked AI-DLC block; preserve every byte outside it |
| `.mcp.json` / `mcpServers` | Claude | Add or remove only consented, baseline-owned entries; preserve user keys and overrides |
| `AGENTS.md` | Kiro CLI, Kiro IDE, Codex, OpenCode | Own one marked onboarding block; preserve project instructions |
| `.vscode/settings.json` / `kiroAgent.trustedCommands` | Kiro IDE native channel | Reconcile only the shipped string entries; preserve other settings and values |
| `opencode.json` | OpenCode | Whole-file ownership; an unknown existing file is a conflict |

Known unmarked files and JSON entries from historical shipped projections are
adopted only when their exact recorded SHA-256 signature matches. Modified
lookalikes remain ambiguous and are refused.

`--force` can replace a modified, baseline-owned managed block or managed
harness file. It cannot adopt ambiguous unmarked content, overwrite a
user-owned JSON value, or replace an unowned or locally modified whole-file
integration such as `opencode.json`. Malformed JSON, malformed or duplicate
markers, non-regular-file targets, and retired owned content whose integrity
cannot be proved are hard conflicts.

Every planned path receives one action:

| Action | Meaning |
|--------|---------|
| `create` | Add an absent framework path |
| `update` | Refresh framework-owned bytes |
| `merge` | Reconcile a managed block, JSON map, or JSON array |
| `preserve` | Keep current or project-owned bytes |
| `remove` | Remove content previously owned by the baseline and retired upstream |
| `conflict` | Refuse because ownership or integrity cannot be proved |

Successful config prints the host-specific next step:

| Harness | Next step |
|---------|-----------|
| Claude Code | Open Claude Code and run `/aidlc --doctor` |
| Kiro CLI | Run `kiro-cli chat`, then `/aidlc --doctor` |
| Kiro IDE | Open the project in Kiro IDE, then run `/aidlc --doctor` |
| Codex CLI | Run `codex`, then `$aidlc --doctor` |
| OpenCode | Run `opencode`, then `/aidlc --doctor` |

## Update and Version Selection

| Command | Public options and behavior |
|---------|-----------------------------|
| `aidlc update` | Install latest with the complete all-harness runtime, then atomically activate. Accepts `--version <x.y.z>`, `--from <release-dir>`, `--release-base-url <url>`, `--ca-bundle <path>`, `--offline`, and `--dry-run`. |
| `aidlc update --check` | Refresh update metadata without installing. Returns 5 when behind, 0 when current, 3 when unavailable/offline, and 1 when checks are disabled. |
| `aidlc use <x.y.z>` | Install the exact version when it is not retained, then make it machine-active without changing project files. |
| `aidlc config --pin <x.y.z>` | Install and validate the exact version when needed, then atomically write `.aidlc-version`, record its machine-local resolved target, and register the project pin without changing the machine-active pointer. |
| `aidlc config --unpin` | Remove `.aidlc-version`, its machine-local resolved target, and its registry entry. |

Human lifecycle output states each completed fact. Update reports the
old-to-new version check, verified download, atomic switch, retained prior
version, any pruned unprotected releases, and the project-refresh courtesy.
A no-op says `You're on the latest version of aidlc (<version>).`; `--dry-run`
says `Would update aidlc from <old> to <new>.`. `aidlc use` distinguishes
`Now using` from `Already using`, and uninstall states exactly which machine
state was removed or kept. JSON and quiet messages retain their stable machine
contracts.

Update downloads and fully validates a candidate before changing the active
pointer. Failed updates automatically restore the prior consistent
installation. A successful update retains the prior active version and every
registered project pin, then prunes older unprotected versions automatically.
There is no public rollback or retained-version management command.

## Project Pins and CI

```bash
aidlc config --pin 2.5.45
git add .aidlc-version
```

`aidlc config --pin <version>` installs and validates the version if needed,
writes `.aidlc-version`, records the absolute binary target under the
gitignored `aidlc/.aidlc-sessions/` runtime directory, and registers the real
project path in machine-local `pins.json`.

Commit only `.aidlc-version`. The stable `aidlc` launcher starts the
integrity-checked active binary, whose dispatcher validates the complete pinned
binary and runtime before selecting it. A missing, malformed, tampered, or
unavailable target fails closed with `aidlc config --pin <version>` remediation, and
`aidlc doctor` reports the same condition. Machine lifecycle commands use the
active binary; `doctor`, `config`, and `use` are never trapped behind a broken
pin.

A fresh clone or CI runner installs the committed version before config:

```bash
version=$(cat .aidlc-version)
tag="v$version"
source_digest="$(gh api "repos/awslabs/aidlc-workflows/commits/$tag" --jq .sha)"
tmp="$(mktemp -d)"
gh release download "$tag" --repo awslabs/aidlc-workflows --dir "$tmp" \
  --pattern install.sh --pattern aidlc-release.intoto.jsonl
gh attestation verify "$tmp/install.sh" \
  --bundle "$tmp/aidlc-release.intoto.jsonl" \
  --repo awslabs/aidlc-workflows \
  --signer-workflow awslabs/aidlc-workflows/.github/workflows/release.yml \
  --source-ref refs/heads/main \
  --source-digest "$source_digest"
sh "$tmp/install.sh" --version "$version" --quiet --yes
rm -rf "$tmp"
aidlc config --pin "$version" --project-dir "$PWD" --quiet
aidlc config --project-dir "$PWD" --harness claude --mcp none --quiet
aidlc doctor --project-dir "$PWD" --quiet
```

## Harness Selection

Harness selection belongs to `aidlc config --harness <name>`. Machine-level
harness management is not a public command.

## Offline Packages

The release asset set is the offline package. It includes
`aidlc-release.intoto.jsonl` alongside the binaries, runtime, installers,
`version.json`, and `checksums.txt`. Download one complete release on a
connected machine and transfer that directory unchanged. Local installation
fails closed if the bundle is missing or does not authenticate
`checksums.txt`:

```bash
gh release download v2.5.45 --repo awslabs/aidlc-workflows --dir ./aidlc-offline
```

Install on the disconnected machine:

```bash
bash ./aidlc-offline/install.sh \
  --from ./aidlc-offline --offline
```

```powershell
& .\aidlc-offline\install.ps1 `
  -From .\aidlc-offline -Offline
```

For native commands, `--offline`, `AIDLC_OFFLINE=1`, or global `offline=true`
prevents release sockets. A network operation without `--from` then fails
before mutation. Config, doctor, version, and uninstall are local regardless.

## Mirrors, Proxies, CAs, and Update Settings

Release settings resolve in explicit option, environment, machine-config,
default order:

| Setting | Environment | Machine config |
|---------|-------------|----------------|
| Offline | `AIDLC_OFFLINE=1` (`0` explicitly enables network) | `aidlc system config global set offline on` |
| Mirror | `AIDLC_RELEASE_BASE_URL` | `aidlc system config global set release-base-url <url>` |
| CA bundle | `AIDLC_CA_BUNDLE` | `aidlc system config global set ca-bundle <absolute-path>` |

Manage the four machine keys:

```bash
aidlc system config global list
aidlc system config global get update-check
aidlc system config global set update-check off
aidlc system config global set offline on
aidlc system config global set release-base-url https://mirror.example/releases
aidlc system config global set ca-bundle /absolute/path/corporate-ca.pem
aidlc system config global clear ca-bundle
```

The keys are `update-check`, `offline`, `release-base-url`, and `ca-bundle`.
Boolean values accept `true|false`, `on|off`, `1|0`, or `yes|no`.
`aidlc config <get|set|clear|list> ... --global` is equivalent.

Mirror base URLs must use HTTPS, except loopback HTTP for local testing, and
cannot contain credentials, a query, or a fragment. The native lifecycle
client follows at most five redirects; redirected URLs may contain a query but
still cannot contain credentials or a fragment. Its errors redact URL
credentials, queries, and fragments.

The native release client honors `HTTPS_PROXY` / `https_proxy` and
`NO_PROXY` / `no_proxy`; proxy URLs must use HTTP or HTTPS. It does not read
`HTTP_PROXY`. The bootstrap scripts delegate proxy behavior to `curl`,
`wget`, or `Invoke-WebRequest`. On Windows, a custom CA bundle requires
`curl.exe`.

Bare help and management listings never refresh the network. They may display
a valid cached update notice. Interactive human `aidlc doctor` may refresh
stale or absent metadata within 750 ms. Non-TTY, `--json`, and `--quiet`
doctor runs are cache-only unless `--check-updates` is explicit.
`doctor --check-updates` and `update --check` use a 15-second metadata
budget. The cache expires after 24 hours; a failed or regressing refresh does
not replace a valid cache. `update-check=off` disables even explicit refreshes
but does not prevent an explicit `aidlc update`.

## Plugins

`aidlc doctor` reports installed-versus-composed plugin state. Plugin changes
are project configuration and converge through `aidlc config`; there is no
separate public plugin command.

## Output, Automation, and Exit Codes

The public commands support human, `--quiet`, and `--json` output where
declared by the route registry. `--json` emits a schema-versioned result
with `ok`, `code`, `status`, `message`, and command-specific `data` when
available. `--quiet` emits one success line or remediation line. Download
progress appears only in human mode.

The native diagnostic form is
`aidlc doctor [--project-dir <path>] [--verbose] [--json|--quiet]
[--check-updates] [--release-base-url <url>] [--ca-bundle <path>]
[--offline]`. `--export` writes a redacted diagnostic bundle, with
`--output <directory>` overriding its default project location; export output
is additional to the selected live-report mode. Human output groups Machine,
Project, and Framework integrity checks. Every section keeps warning/failure
rows visible and collapses healthy rows by default; `--verbose` expands every
check. Warnings are advisory and exit 0; any failed check exits 1.

`--no-color` and `NO_COLOR` disable ANSI output. `--project-dir <path>` selects
project context without changing the shell directory. Destructive operations
such as `uninstall` prompt on a TTY and require `--yes` without one. `--yes` never bypasses
ownership, integrity, active-workflow, or release-authentication refusals.

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | Operational failure |
| 2 | Usage or invalid machine configuration |
| 3 | Required network result or retained runtime unavailable |
| 4 | Integrity or ownership refusal |
| 5 | Check completed and action is required, such as an available update |

## Help and Completions

`aidlc --help` prints exactly the six public commands. Each public command also
has side-effect-free command help: `aidlc <command> --help` (or `-h`) for
`config`, `doctor`, `version`, `update`, `use`, and `uninstall`. Config-level
help names all six policy sections; `aidlc config <section> --help` keeps the
section-specific help. `aidlc help --all` reveals the hidden `engine` and
`system` namespaces and points to
`aidlc engine --help` / `aidlc system --help` for their full inventories.
The installer places Bash, Zsh, Fish, and PowerShell files under the per-user AI-DLC data root's
`completions/` directory, generated from the public route registry; there is
no public completion-generation verb.

## Transactions and Recovery

Project and machine mutations stage on the destination filesystem, validate
the candidate, and commit through atomic renames. Concurrent changes detected
against planned state abort instead of overwriting new bytes. Abandoned
owner-private staging is swept only after lock and ownership checks.

If rollback of an interrupted commit cannot be completed safely, evidence is
retained in a named `.aidlc-recovery-*` quarantine under the machine install
root or project root. `aidlc doctor` reports it. Recover any needed files,
ensure no AI-DLC mutation is running, then remove only the listed directory
manually. Automatic staging cleanup never deletes quarantines.

Windows uninstall uses a recoverable continuation because a running executable
cannot remove its own command shim. A later command resumes a valid pending
continuation before doing other work.

## Copy Channel

The supported manual-copy payload is the versioned `aidlc-runtime.tar.gz`
release asset. Download one exact release, extract it, and copy the complete
`runtime/<harness>/` root so the harness tree, `aidlc/` workspace shell, and
project-root files stay together:

```bash
tag=vX.Y.Z
tmp="$(mktemp -d)"
release_repo="${AIDLC_RELEASE_REPOSITORY:-awslabs/aidlc-workflows}"
release_workflow="${AIDLC_RELEASE_WORKFLOW:-$release_repo/.github/workflows/release.yml}"
source_digest="$(gh api "repos/$release_repo/commits/$tag" --jq .sha)"
gh release download "$tag" --repo "$release_repo" --dir "$tmp" \
  --pattern aidlc-runtime.tar.gz \
  --pattern checksums.txt \
  --pattern aidlc-release.intoto.jsonl
gh attestation verify "$tmp/checksums.txt" \
  --bundle "$tmp/aidlc-release.intoto.jsonl" \
  --repo "$release_repo" \
  --signer-workflow "$release_workflow" \
  --source-ref refs/heads/main \
  --source-digest "$source_digest"
(cd "$tmp" && grep '  aidlc-runtime.tar.gz$' checksums.txt | sha256sum -c -)
tar -xzf "$tmp/aidlc-runtime.tar.gz" -C "$tmp"
RUNTIME_ROOT="$tmp/runtime"
cp -R "$RUNTIME_ROOT/claude/." your-project/
```

The archive is assembled from freshly regenerated native projections and uses
the matching `aidlc` command. Prefer `aidlc config`, which applies the same
runtime transactionally and records ownership for later refreshes.

Framework developers may instead clone the source, install dependencies, and
materialize ignored local outputs:

```bash
bun install --frozen-lockfile
bun scripts/package.ts
```

That creates the Bun-invoking `dist/<harness>/`, native `dist-release/<harness>/`,
and plugin projections locally. Neither generated root is committed. Direct
`bun .../tools/*.ts` calls remain source/development and debugging mechanisms,
not a second native lifecycle interface.

## Uninstall

```bash
aidlc uninstall
aidlc uninstall --purge --yes
```

Uninstall removes the installer-owned command and all retained versions but
never changes project trees. Without `--purge`, it preserves machine config,
update cache, pin registrations, and the default harness. `--purge` removes
those machine records too.

Uninstall requires confirmation and refuses a root-owned, package-manager-owned,
or mixed-ownership command. On Windows it schedules verified cleanup after the
running command exits and resumes an interrupted continuation on the next
command.
