# dist-probe — results

Evidence for the distribution decision (AIDLC-native CLI "A" vs. emit-a-real-host-plugin "B").
All probes run on real hosts on this box, 2026-06-29. Throwaway; see `README.md`.

## Headline

- **Gap 1 (can a plugin/host hook compose unattended — write the project tree + its own data?)**
  → **PASS on Claude and Codex.** A host hook fires, writes the project tree, writes
  its plugin-data dir, reads its plugin root, and (with PATH set) finds bun.
- **Gap 2 (can a Codex plugin ship agents?)** → **NO.** Confirmed gap.
- **Kiro (CLI + IDE):** no plugin concept at all; the `.kiro/` tree IS the delivery.
  Discovery + agents + hooks all work from a plain folder drop. AIDLC runs end-to-end.
- **New bug found:** `aidlc-kiro-adapter.ts` sub-spawns `bun` by bare name, so it
  fails `ENOENT` under any host hook whose environment lacks `~/.bun/bin`. See below.

## Per-host findings

### Claude (real plugin, store install)
- `/plugin marketplace add <dir>` (needs `.claude-plugin/marketplace.json` at the
  marketplace root) → `/plugin install <name>@<market>`.
- SessionStart hook fired **unattended** on a fresh session.
- Verdict line: `PROJECT=OK DATA=OK ROOT=OK BUN=OK`.
- `CLAUDE_PROJECT_DIR` is set; `CLAUDE_PLUGIN_ROOT` / `CLAUDE_PLUGIN_DATA` populated
  (data dir: `~/.claude/plugins/data/<plugin>-<market>/`).
- **Cleanest host:** true zero-touch compose-on-install, agents supported.

### Codex (real plugin, store install)
- `codex plugin marketplace add <dir>` → `codex plugin add <name>@<market>`
  (NB: `add`, not `install`; `@<market>` required). One-time `Auth on install` trust.
- SessionStart hook fires **lazily — on first interaction**, not at session spawn
  (asking it to "list plugins" triggered the compose + log). Automatic in practice
  since the user interacts anyway; minor timing window before first turn.
- Verdict line: `PROJECT=OK DATA=OK ROOT=OK BUN=OK` (project write via **PWD
  fallback** — `CLAUDE_PROJECT_DIR` is **unset** on Codex; a real composing hook
  must derive the target from PWD, not assume a project-dir env var).
- Plugin info panel lists **Skills / Hooks / Apps — no Agents category.** Our
  bundled `agents/aidlc-probe-agent.md` is ignored. **Agents gap confirmed.**

### Kiro CLI (no store)
- `kiro-cli` installed; subcommands include `agent`, `mcp`, `settings`, `chat` —
  **no `plugin`/`marketplace`.** Distribution is manual git pull + folder drop.
- **Agents are first-class:** `kiro-cli agent list` shows `Workspace: <proj>/.kiro/agents`
  and `Global: ~/.kiro/agents`. A hand-dropped `.kiro/agents/aidlc-probe-agent.json`
  was **discovered automatically** (showed as a Workspace agent) and passed
  `kiro-cli agent validate`. `agent set-default` wires the launch agent.
- So Kiro's only gap is the missing install primitive, NOT capability.

### Kiro IDE (no store)
- Open the composed folder as the workspace root (`/tmp/kiro-ide-test` — a copy of
  `dist/kiro-ide/` + `--init` scaffold; `--doctor` = 29 passed / 0 failed).
- Ships **7 `.kiro.hook` files** (native Kiro agent-hook format), all `enabled`:
  `aidlc-session-start` (`when: promptSubmit`), `aidlc-runtime-compile`
  (`postToolUse`/shell), audit-logger, log-subagent, session-end, stop, sync-statusline.
  The IDE **discovers and lists all of them** with no registration.
- Trigger model is **lazy (`promptSubmit`)**, like Codex — no eager on-open compose.
- **The workflow RAN end-to-end:** steering loaded, `aidlc` skill activated, engine
  emitted the `intent-capture` `run-stage` directive, product agent asked its
  questions, `memory.md` + `intent-capture-questions.md` created.
- **First run:** hooks errored (`bun` ENOENT — see below) but the workflow still ran.
  **After a full server restart** (so the env re-snapshots with `~/.bun/bin`):
  `aidlc-session-start` fires **clean**, `aidlc-docs/.aidlc-hooks-health/` populates
  (`session-start.last` / `session-end.last` / `stop.last`), and `audit.md` records
  `SESSION_STARTED`. **PASS.** (The 4 `bun-ENOENT` strings in the post-restart log
  dir are the *previous* error quoted back inside conversation-history JSON, not new
  failures — the live hook executions at 21:49–21:50 succeeded.)
- Nuance: the Kiro **server process** env can still lack `~/.bun/bin` (long-lived,
  snapshotted at launch) yet hooks succeed, because the hook *command* runs through
  a shell that sources `~/.zshenv`. That masks the adapter bug below — it is latent
  fragility, not a hard blocker, on this host.

## The bug: adapter sub-spawns bare `bun`

`/tmp/kiro-ide-test/.kiro/hooks/aidlc-kiro-adapter.ts:168`:
```ts
const r = Bun.spawnSync(["bun", join(HOOKS_DIR, hookFile)], { ... });
// error: Executable not found in $PATH: "bun"  (ENOENT)
```
- Kiro launches the adapter fine (Bun is running it), but the adapter re-spawns
  `bun` **by bare name** as a child; the child inherits the host hook's `$PATH`,
  which lacks `~/.bun/bin`, so it ENOENTs.
- **Two distinct causes, both real:**
  1. *Environment:* the Kiro **server process** snapshots `$PATH` at launch. It was
     started before bun was installed, so its env (and every hook child's env)
     lacks `~/.bun/bin` — even after `~/.zshenv`/`~/.bashrc` are fixed. Requires a
     **full server restart** (not a window reload) to re-snapshot. Confirmed:
     `/proc/<kiro-server-pid>/environ` PATH has no `.bun/bin`.
  2. *Code:* even with a good PATH, spawning bare `"bun"` is fragile. The adapter
     should resolve the binary — e.g. `process.execPath` (the bun already running
     the adapter) or `Bun.which("bun")` with a `~/.bun/bin/bun` fallback — instead
     of `["bun", ...]`. This is the live form of the Gap-1 stretch risk the probe
     flagged ("a real hook must invoke bun by absolute path or fix PATH").

## Trust findings (both confirmed on real hosts)

### Codex — one-time, content-hash-pinned
Approving the install-time trust prompt **persists** in `~/.codex/config.toml`:
```toml
[plugins."aidlc-dist-probe@aidlc-dist-probe-market"]
enabled = true
trust_level = "trusted"
[hooks.state."aidlc-dist-probe@aidlc-dist-probe-market:hooks/hooks.json:session_start:0:0"]
trusted_hash = "sha256:2cd11b…"
```
- **Not per-session** — won't re-prompt on future sessions. ✅
- **But pinned to the hook's content hash** — a plugin update that changes a hook
  file invalidates the hash and **re-triggers the trust prompt**. Security feature;
  and a real Approach-B note: hook-touching updates re-prompt on Codex.

### Claude — managed allowlist enforced AND unoverridable
With `/etc/claude-code/managed-settings.json` set to
`strictKnownMarketplaces: [{github: anthropics/claude-code}]`:
- **Blocks a non-listed source pre-fetch:** `marketplace add <local dir>` →
  *"Error: Marketplace source 'dir:…' is blocked by enterprise policy. Allowed
  sources: github:anthropics/claude-code"*. ✅
- **User scope cannot override:** even with the probe in the user
  `extraKnownMarketplaces` **and** `enabledPlugins:true`, the plugin shows
  **✘ failed to load** — managed scope wins. ✅
- **It is a TRUE allowlist, not additive:** the test allowlist (only anthropics)
  also disabled the box's *real* plugins (AIM agents, typescript-lsp) — they
  failed to load until the managed file was removed. Rollout implication: an org
  allowlist must list **every** source teams legitimately need, or it locks them out.

(Test teardown: managed file removed, user `settings.json` restored from backup.)

## Implications for the A-vs-B decision

- Gap 1 is **green enough**: host hooks genuinely compose. B is technically viable
  on the store hosts.
- The two "degraded" hosts have **opposite shapes**:
  - **Codex** = auto-install but **no agents** (capability gap — we can't fix it).
  - **Kiro** = full capability but **no store** (distribution gap — a thin `aidlc`
    command closes it; we must build that path anyway).
- **"Emit a real plugin" cannot apply to Kiro at all** — there is no host plugin to
  emit into; Kiro is always folder-drop + compose.
- B couples us to host runtime quirks (Codex's unset project-dir var; the
  hook-spawns-hook PATH fragility Kiro IDE exposed). These are manageable but real.
- Net: the evidence points at the **hybrid** — real plugins for Claude/Codex
  (B's cheap native path where a store exists), thin `aidlc` command for Kiro
  (folder-drop + compose, which B requires regardless).

## Probe campaign status — COMPLETE

Both gating unknowns + both trust questions resolved on real hosts:
- Gap 1 (hook composes unattended): ✅ Claude (eager), Codex (lazy), Kiro IDE (lazy)
- Gap 2 (Codex agents): ❌ no agent surface
- Codex trust: ✅ one-time, hash-pinned
- Claude managed allowlist: ✅ enforced + unoverridable (true allowlist)

## Follow-up (implementation, not probe)
- Fix `aidlc-kiro-adapter.ts` bun resolution (bare `"bun"` → `process.execPath` /
  `Bun.which` + `~/.bun/bin` fallback) so hooks don't depend on the host's hook
  PATH. Latent on this box (shell sources `~/.zshenv`), would bite a stricter host.
