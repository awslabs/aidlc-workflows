# Kiro Windows output-encoding evidence

This directory retains the redacted native Windows evidence for the `2.6.75`
Kiro command-output fix. The full diagnostic captures contain temporary
workspace paths, session identifiers, and complete IDE DOM snapshots; the
checked-in NDJSON keeps the exact command output and model follow-up text while
replacing those machine-local fields with stable metadata.

## Environment

- Source baseline: `v2@6a70d02b6`
- Host: native Windows test host
- Kiro IDE: `1.0.242`
- Kiro CLI: `kiro-cli-chat 2.15.2`
- Commands: `/aidlc --status`, `/aidlc --doctor`
- Capture date: `2026-08-24`

The normalized files were extracted from these full private captures:

| Capture | SHA-256 |
|---|---|
| Current-baseline Kiro IDE NDJSON | `d209acd05b51b9253c667af88204ce0ab2de2449258aa9a731ff3b1fd47ba0cd` |
| Fixed Kiro IDE NDJSON | `d3d25891d751559400c7ec8248b3bcdc8309aa5fda87c08dd340a6e883adc69a` |
| Current-baseline Kiro CLI NDJSON | `ce4585dfd9cbf9982e739d35d640d6a8327e6b7f3e769039ded8b81489d6c953` |
| Fixed Kiro CLI NDJSON | `1a9aa87ac3dcaa7625e838ecb4dc182c4b32633106037fad83c8294fd60e7fe9` |

## What the captures prove

`kiro-ide-windows.ndjson` separates three surfaces:

1. The current-baseline deterministic tool output.
2. The shell-transport suffix appended after that output.
3. The model's separate follow-up prose.

On Kiro IDE 1.0.242 the recovered finding's Unicode corruption no longer
reproduced: `█`, `▒`, `░`, `─`, `✓`, `⇄`, and `—` were intact before this
change. The shell fragment ending in an ESC byte still reproduced after both
status and doctor. This distinction matters: host-version behavior had changed,
while the remaining transport defect and model paraphrase were independent.

The fixed capture uses `aidlc-terminal-command` plus
`aidlc-terminal-command-guard`. It retains the exact Unicode output, records no
PowerShell/ESC suffix, needs zero Allow clicks, and leaves any model summary in
the separate `model_followup` field.

`kiro-cli-windows.ndjson` retains current-baseline and fixed pairs. Every row
contains the native adapter `transport` separately from the actual ACP `model`
surface. On the current baseline, CLI transport already preserved UTF-8 and
carried no debris; the model added follow-up prose after the deterministic
block. The fixed rows preserve the same transport/refusal semantics. All four
ACP turns end with `stop_reason: "end_turn"`, zero tool calls, and zero
tool-call issues.

## Focused verification

- Local `t218-kiro-ide-hook-adapter`: 58 passed.
- Native Windows `t218-kiro-ide-hook-adapter`: 58 passed.
- Native Windows Kiro CLI ACP capture: status and doctor ended cleanly with no
  tool calls.
- Native Windows Kiro IDE capture: status and doctor matched, all representative
  glyphs survived, no shell debris was present, and Allow-click count was zero.
