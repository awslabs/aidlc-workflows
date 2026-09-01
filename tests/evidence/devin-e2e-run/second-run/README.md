# Devin CLI Harness — E2E Run 2 Evidence

Second live end-to-end run of the Devin CLI harness, captured on 2026-08-31 by
executing the plan in
[`devin-e2e-test-plan.md`](devin-e2e-test-plan.md)
against the shipped `dist/devin` tree. Unlike run 1 (print mode), run 2 drove
`devin` **interactively** to exercise the human-in-the-loop surfaces print mode
cannot reach. The narrative summary is in
[`SUMMARY.md`](SUMMARY.md); this README records the environment and the
SHA-256 manifest of every captured artifact.

## Environment

- **Date**: 2026-08-31
- **Test project**: `~/devin-e2e-test-2` (fresh git project, separate from run 1)
- **Distribution**: `dist/devin/` copied into the test project
- **Run mode**: `devin` (interactive — NOT print mode)
- **Devin CLI**: 3000.6.7
- **Model**: glm-5-2
- **Scope**: express (9 stages, minimal depth)
- **Duration**: ~25 minutes (workflow), ~30 minutes total including setup
- **Gate handling**: user approved via native `ask_user_question` prompts
- **Plan approval**: user answered "Approve Plan" genuinely — but adapter bug
  prevented the response from being recorded (see SUMMARY.md § "Root Cause")

## Results

- **Phase 0 — Install & Doctor**: PASS (45/45 doctor checks)
- **Phase 1 — Cold Start & Initialization**: PASS (3 init stages,
  SessionStart + UserPromptSubmit hooks fired)
- **Phase 2 — Inception (requirements-analysis)**: PARTIAL PASS —
  `ask_user_question` rendered as a native prompt (run-1 gap CLOSED), but
  the PostToolUse `record-human-turn` hook skipped due to adapter bug;
  gate eventually approved via workaround
- **Phase 3 — Construction (code-generation)**: **BLOCKED** — adapter bug
  prevented the plan-approval response from being recorded; the
  `plan-approval-guard` hook blocked 12 attempts; the conductor entered a
  retry loop; run stopped at user's request
- **Phase 4 — Operation & Completion**: NOT REACHED
- **Phase 6 — Hook Coverage**: 14/17 verified (82%); 1 FAIL
  (`record-human-turn` on `ask_user_question`), 2 NOT TESTED
  (`deliver-stage-rules`, `log-subagent` — blocked before subagent dispatch)

## Key finding

**Harness adapter bug in `hasExplicitHumanSelection()`** — the
`record-human-turn` PostToolUse hook on `ask_user_question` fires but skips
because `hasExplicitHumanSelection()` in `aidlc-devin-adapter.ts` returns
false for Devin's object-format `tool_response` (`{success, output, error}`).
The function expects a JSON string, but Devin passes an object. This breaks
all `ask_user_question` answer recording, including the Plan Approval
challenge/response/receipt triple, causing the `plan-approval-guard` to block
indefinitely. This is a **new finding that run 1 (print mode) could not
expose** because `ask_user_question` never fired in print mode.

## Not exercised

- Subagent dispatch (workflow blocked before `run_subagent` could fire) —
  `deliver-stage-rules` and `log-subagent` hooks remain unverified (same as
  run 1)
- Operation stages (workflow blocked before operation phase)
- SessionEnd hook (session not exited cleanly — stopped mid-stage)

## SHA-256 manifest

Computed with `find . -type f ! -name README.md | sort | xargs sha256sum`
from this directory.

```text
e21bc77d9f3bf56cd7bc1a9c8bf0a3b1ee14c2f8239ee904a54069592e04a045  00-checkpoint-0ab.txt
9f3aa31f44ea5ba00f7d3db11c883b2709e494220d6aa631b150bc298a7f5c27  00-doctor-output.txt
5c4a6f393c30c9db8b21e98044a3689ae3ff83197a7049bc78815b1d9b079474  05-audit-trail-distribution.txt
05df5795746511e90f42587432d3c7aea8305e077b226f51dca1d702e0720e7c  05-session-cost.json
8820f85c50592d1dd4345f376527247ed8a22163bb0150140872ecdb0ad5c27c  06-hook-coverage.txt
2fbc8c687bcc571985aae766f5637dcda3f0f3d4e08a15c32285b86ea993aaea  SUMMARY.md
3f8c22f380360518a95cdbfef8f72922343f4928da9807717cad185c612b3897  aidlc-state.md
4701b142fe4030ec98c45eb7f5f46ec71447a416ac6c5967efc88a76790a408e  audit-shard.md
3f7759e222b195d46edea8ab58a6a29924df2fbc6e5573b2db75da4e092e40b4  construction-artifacts/code-generation/_contract.md
0566635459c10e56217baf5333feaf6ae665f1b4c307763ccf4a86e6ca651f39  construction-artifacts/code-generation/_debug.ts
0fefa53254c8d9664e189d8af19049bb8624a51c4aa4f21975089caad437a0dc  construction-artifacts/code-generation/_debug_parse.ts
1c377b6598f38c1a83db48e57c5ef693dfbb8db0d11bce49816078f2e3b4f162  construction-artifacts/code-generation/_plan-body.md
d35cbbca4ab878b8b64ea260a68da0d52375a0d2d965ea08eede444a23c5394f  construction-artifacts/code-generation/_plan-header.md
2ccb8f727dec0f06c25d0560ba0f5b6db7c54df8153c4f709245cf359e8547ad  construction-artifacts/code-generation/code-generation-plan.md
fde233dd64aec903c805e66f6ba97b1395e4c0a03a5614ff33f461ced1edd65f  construction-artifacts/code-generation/code-generation-questions.md
a9c770481f2660b3efa92538df41f75f66150bf55d571f150bf0ce6fe2f624a4  construction-artifacts/code-generation/memory.md
3f9802e94e9fb70957c263a6fa522e8e308e37aaad4142f79ade9775065c32df  construction-artifacts/code-generation/unit-test-instructions.md
6c1b512ca5af5356c177ded03493f9952c3937e33aae8f7f69d65ee62ff38066  devin-e2e-test-plan.md
33965d434f645af7ee00b59c1017205245dbf34e99a9afbb00ce526d52fb7b5c  inception-artifacts/requirements-analysis/memory.md
7b83fd8d3de52010ce24df1917f5b523e68312473e9448a2cb17ede591577855  inception-artifacts/requirements-analysis/requirements-analysis-questions.md
2dae41403137e657689427b8edd2aa0931918cb98a29c884fab6fef8696eaefd  inception-artifacts/requirements-analysis/requirements.md
cc035d54e5fc7bfa59d517348f7fc331d7119ae0c4372b8912cb5ad0f3d012a1  monitoring-log.txt
81b7420197f82955a618f24e4c53cfb4f1d2d9e39e387cf27c2b6e6a805f8f5f  poll-run2.sh
13896d4ee6cfc17498f3e052350eedb0132445a33e560b7aa584a5aba1c53401  runtime-graph.json
```
