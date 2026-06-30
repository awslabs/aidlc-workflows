# dist-probe — throwaway spikes for the distribution decision

Tests the two gating unknowns behind "emit a real host plugin" (Approach B) vs.
"AIDLC-native CLI" (Approach A), plus the cheap trust confirms. **Disposable** —
this dir is not part of the design set or the build; delete it when done.

- **Gap 1 (load-bearing):** can a plugin's `SessionStart` hook fire unattended
  and write (b) the project tree, (c) its own plugin-data dir, (d) read its
  plugin root to compose from? If not, B's no-touch install collapses to "install
  + run one compose command."
- **Gap 2 (Codex):** can a Codex plugin ship agents? (Research says no — confirm.)
- **Cheap confirms:** Codex first-run hook trust is one-time; Claude managed
  allowlist actually blocks a non-listed marketplace and a dev can't override it.

## Run order

### 0. Quick local (no host, ~1 min) — do this first
```bash
bash spikes/dist-probe/quick-local.sh
```
Proves the probe logic + all writes work in isolation. If a check FAILs here,
it's the script, not the host.

### 1. Claude (~15 min) — the decisive test
```bash
# in a Claude Code session, from a scratch project dir:
/plugin marketplace add /ABSOLUTE/PATH/TO/spikes/dist-probe
/plugin install aidlc-dist-probe@aidlc-dist-probe-market
# start a NEW session in the scratch project, then check:
cat /tmp/aidlc-dist-probe.log
cat .aidlc-probe/report.log     # project-tree write
```
PASS = the hook fired unattended and PROJECT + DATA + ROOT all read OK.
PARTIAL = note which write failed → that's the fallback design.

### 2. Codex (~15 min)
```bash
# in Codex CLI, from a scratch project:
codex plugin marketplace add /ABSOLUTE/PATH/TO/spikes/dist-probe
codex plugin add aidlc-dist-probe@aidlc-dist-probe-market   # NB: 'add', not 'install'; needs @<marketplace>
# approve the hook trust prompt when it appears (note: one-time? or per-session?)
# start a session, then:
cat /tmp/aidlc-dist-probe.log
# Gap 2: check whether `aidlc-probe-agent` is listed/usable (codex plugin list). If absent, agents gap confirmed.
```

### 3. Kiro (~5 min) — measures the manual cost (no store, no hook)
```bash
bash spikes/dist-probe/kiro-manual/install.sh /tmp/kiro-scratch
```
Counts the manual steps a Kiro team performs until a thin `aidlc plugin` command
wraps them.

### 4. Trust confirms (~30 min, optional)
- **Claude managed allowlist:** put `strictKnownMarketplaces` in managed settings
  pointing at a *different* repo, then try `/plugin marketplace add` on this one —
  confirm it's blocked and a user-scope setting can't re-enable it.
- **Codex hook trust:** restart the session after approving once — confirm the
  trust prompt does NOT reappear (one-time per plugin, not per session).

## Reading results

Every probe writes the same report to up to three places (so you can read it
regardless of which writes the host allowed):
- `/tmp/aidlc-dist-probe.log` (always, if /tmp is writable)
- `<project>/.aidlc-probe/report.log` (if project-tree write succeeded)
- `<plugin-data>/report.log` (if plugin-data write succeeded)

The verdict line summarizes: `PROJECT=OK/FAIL DATA=… ROOT=… BUN=…`.

## Files
```
quick-local.sh                       # 0. no-host sanity check
claude-plugin/                       # 1. real Claude plugin (.claude-plugin/plugin.json + SessionStart hook)
codex-plugin/                        # 2. real Codex plugin (.codex-plugin/plugin.json + hook + an agent to test the gap)
kiro-manual/install.sh               # 3. simulates the no-store git-pull-and-compose path
.claude-plugin/marketplace.json      # marketplace listing (MUST be at .claude-plugin/ — Claude looks there)
probe.sh                             # shared probe body (copied into each plugin root)
```
