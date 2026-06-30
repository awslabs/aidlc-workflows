# Distribution decision — recommendation (evidence-backed)

Companion to `RESULTS.md` (the probe evidence). Decides how AIDLC bundles reach
users: **A** = AIDLC-native bundle + our own install CLI + our own trust layer;
**B** = emit a real host plugin, host composes on a SessionStart hook, host store
distributes, host managed-settings provides trust.

## Recommendation: the HYBRID

**Emit real host plugins for Claude and Codex; ship a thin `aidlc` folder-drop +
compose path for Kiro.** Not pure A, not pure B — because the probes showed the
hosts are genuinely different shapes and one mechanism can't fit all three well.

## Why — what the probes settled

The gating unknown behind B is **resolved green**: a host hook *can* compose
unattended (write the project tree + its own data) — confirmed on Claude, Codex,
and Kiro IDE. So B is viable, and pure-A's "build our own everything" is no longer
justified by "hooks can't do it."

But B is **not uniform**, and the asymmetry is the whole decision:

| Host | Store / install | Compose hook | Agents | Trust |
|---|---|---|---|---|
| **Claude** | ✅ store, auto | ✅ eager (session spawn) | ✅ | ✅ managed allowlist, unoverridable |
| **Codex** | ✅ store, auto (1-time trust) | ✅ lazy (first turn) | ❌ **none** | ✅ one-time, hash-pinned |
| **Kiro CLI/IDE** | ❌ **no store** | IDE: ✅ lazy hook · CLI: manual | ✅ full | n/a (folder-drop) |

The two "degraded" hosts fail in **opposite** ways:
- **Codex** — frictionless install, but **no agent surface** (capability gap we
  cannot fix from our side).
- **Kiro** — full capability incl. agents, but **no plugin concept at all**
  (distribution gap; only a folder drop + compose works).

So **"emit a real plugin" literally cannot apply to Kiro** (nothing to emit into),
and applies only *partially* to Codex (plugin yes, but agents lost). Pure B fails
Kiro outright and half-fails Codex. Pure A pays to rebuild install + trust +
marketplace that Claude/Codex already ship for free, and would still need the
folder-drop path for Kiro anyway.

The hybrid takes each host's native strength:
- **Claude/Codex:** emit the real plugin → reuse their store, their install, their
  managed-trust (proven enforced + unoverridable). We run nothing.
- **Kiro:** the thin `aidlc` command does folder-drop + compose — which we must
  build regardless, because Kiro has no other path.

## What the hybrid costs (accepted, eyes open)

1. **Codex loses agents.** Either accept persona-less Codex runs, or supplement
   agents on Codex some other way (out of scope here). This is intrinsic to Codex,
   not our choice.
2. **Two emit targets + one CLI** to maintain — but the composer is shared; the
   per-host surface is thin (a `plugin.json` projection each + a Kiro wrapper).
3. **Host runtime coupling** — Codex's unset `CLAUDE_PROJECT_DIR` (use PWD), the
   hook-spawns-`bun` PATH fragility (fix: resolve bun path). Both small, both known.
4. **Org allowlist is all-or-listed** — a strict allowlist must enumerate every
   legitimate source or it locks teams out (observed: it disabled real plugins).

## Implementation notes carried from the probes

- **Marketplace file** must be at `.claude-plugin/marketplace.json` (Claude) /
  the Codex equivalent; `source` is relative to the marketplace root.
- **Codex install** is `codex plugin add <name>@<market>` (not `install`).
- **Compose hook** must not assume a project-dir env var (Codex unsets it) and
  must resolve `bun` by absolute path, not bare name (`aidlc-kiro-adapter.ts` bug).
- **Trust** needs no AIDLC-built layer for Claude/Codex — managed settings /
  config trust already do it; just document the org setup.

## Decision rubric outcome (from the Slack analysis)

- "Run no distribution infra" → B/hybrid ✅ (Claude/Codex run on host machinery)
- "Mixed-fleet list-once" → hybrid ✅ (one source → per-host emit)
- "Native UX users know" → hybrid ✅ where stores exist
- "Harness parity" → hybrid is the *best achievable*: Codex's no-agents and Kiro's
  no-store are host facts, not fixable by choosing A
- "Avoid load-bearing unknowns" → resolved: the hook-composes unknown passed

**Verdict:** the hybrid dominates pure A (cheaper, native UX, less to maintain)
and pure B (which can't serve Kiro and half-serves Codex). Proceed hybrid.
