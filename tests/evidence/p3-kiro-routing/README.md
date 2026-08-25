# P3 Kiro New-Work Routing Evidence

Native Windows evidence captured on a dedicated test host on 2026-08-24 from the
uncommitted `fix/kiro-new-work-routing` worktree.

## Environment

- Windows host: dedicated native Windows test host
- Kiro CLI: `kiro-cli-chat 2.15.2`
- Kiro IDE: `1.0.242`
- Runner: `bash tests/run-tests.sh --debug -P 8 --e2e --filter <focused-file>`

The CLI was authenticated only for the focused evidence run. The host's prior
empty CLI credential database was restored immediately afterward. No credential
values are present in this directory.

## Results

- `windows-kiro-routing-cli.log`: two passes, active and unselected routing.
- `windows-kiro-routing-cli.ndjson`: complete ACP event trace. Each turn has one orchestrator
  tool call followed by `stopReason: end_turn`; the unselected turn's output
  preview is the typed `new-work-routing` ask.
- `windows-kiro-routing-ide.log`: one pass for the native IDE unselected routing journey.
- `windows-kiro-routing-ide.ndjson`: verification receipt containing the exact engine
  directive, completed assistant tail, four ordered-list items ending in
  `Other`, `completed_turn: true`, and `intent_query_present: false`.

## SHA-256

```text
465b2cb860a748d4af7189a16409914f6a134d62b7824e75bd39d390450324f7  windows-kiro-routing-cli.log
034b783b3389ab002dc8f5714023d618363600bb4205e826a2314631ce89a600  windows-kiro-routing-cli.ndjson
f76c3e7ba1a8b4bb8ea9d313dca33d072baa6ea95826391115900da98c6b4ceb  windows-kiro-routing-ide.log
d776cbe91f870fcda0b558657e1fcafeccd8f32190793bfb9e7cd5ce18937252  windows-kiro-routing-ide.ndjson
```
