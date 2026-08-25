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
06c92f9aff519cb74c4c3a34349dc8b9ba8dcfd2e3e78face38b733e5efa2b44  windows-kiro-routing-cli.log
32783d2859d8c17f0bf8a4635d68f72505f6c0ea34b904e805f4295d5a550c3e  windows-kiro-routing-cli.ndjson
b4f3f68dda120e2764ddaa8873dfaae99e33e4352e0d5e81fc2ae0c1641fcb95  windows-kiro-routing-ide.log
d776cbe91f870fcda0b558657e1fcafeccd8f32190793bfb9e7cd5ce18937252  windows-kiro-routing-ide.ndjson
```
