# Devin CLI Harness — E2E Run 1 Evidence

First live end-to-end run of the Devin CLI harness, captured on 2026-08-31 by
executing the plan in
[`devin-e2e-test-plan.md`](devin-e2e-test-plan.md)
against the shipped `dist/devin` tree. The narrative summary is in
[`SUMMARY.md`](SUMMARY.md); this README records the environment and the
SHA-256 manifest of every captured artifact.

## Environment

- **Date**: 2026-08-31
- **Test project**: `~/devin-e2e-test` (fresh git project)
- **Distribution**: `dist/devin/` copied into the test project
- **Run mode**: `devin -p` (print/non-interactive mode) with
  `--permission-mode dangerous --respect-workspace-trust false`
- **Devin CLI**: 3000.6.7
- **Model**: glm-5-2
- **Scope**: express (9 stages, minimal depth — requirements → code → test → deploy)
- **Duration**: ~40 minutes (workflow), ~50 minutes total including setup
- **Gate handling**: auto-approved via `report --result completed`
- **Plan approval**: manually recorded via challenge/response file creation
  (the plan-approval-guard hook blocked all automated bypass attempts in the
  first session; the approval was recorded manually between sessions)

## Results

- **Phase 0 — Install & Doctor**: PASS (45/45 doctor checks, 17 hooks wired)
- **Phase 1 — Cold Start & Initialization**: PASS (3 init stages, SessionStart
  + UserPromptSubmit hooks fired)
- **Phase 2 — Ideation**: N/A (skipped by express scope)
- **Phase 3 — Inception & Construction**: PASS (requirements-analysis,
  code-generation, build-and-test all completed with gate approval; 30/30
  generated tests passing)
- **Phase 4 — Operation & Completion**: PASS (deployment stages conditional
  — no deployable target; WORKFLOW_COMPLETED + SESSION_ENDED recorded)
- **Phase 5 — Post-Run Verification**: PASS (replay + outcomes pack written)
- **Phase 6 — Hook Coverage**: 15/17 verified (88%); `deliver-stage-rules`
  and `log-subagent` not exercised (require subagent dispatch, which the
  conductor ran inline in print mode). `plan-approval-guard` enforced 15
  blocked bypass attempts.

## Not exercised

- Subagent dispatch (conductor ran inline in print mode) — leaves
  `deliver-stage-rules` and `log-subagent` hooks unverified by this run.
- `ask_user_question` PostToolUse path for `record-human-turn` — most gates
  were auto-approved via `report --result completed`, so the
  `ask_user_question` arm is partial.

## SHA-256 manifest

Computed with `find . -type f | sort | xargs sha256sum` from this directory.

```text
536e80108f4106ecbd2f83b05214bfc4baf5fa25476e74e750caa39fbed756e7  00-checkpoint-0ab.txt
086dea7e5a0e7462c6710a650f8e2ac38861021d315fa157dae131f0d11df0fd  00-doctor-output.txt
b0e298ead3905b052f1ad9604e05745b520366590e25ff901290bf4955b8cab0  01-checkpoints-1to4.txt
6a7fb68fa6d70eeb180b913914bcf669669f6d04dc58635905aaf91d0d5072de  01-workflow-output.txt
b902fcf24993afc1858b090cde419608f57b59c72245b8daadb771f6b0d7fdd5  02-workflow-output.txt
4097b34bda1c95b8f590d33dce6c54f619bc31a3d76d99f4dcc3d7cccc7ee23e  05-audit-trail-distribution.txt
66f6ed3856b0fd7c58ebee141d445a48191b1e63ba0aa727594391cfed8eddec  05-outcomes-pack-output.txt
3352d31db3e539541bf5bea2f0a8338bf3a05070b3ee885582229a3d12d62aff  05-outcomes.md
ea6985cffad642bb058bc4fd9a2497fd1d32c1ef0a57619e9897e3c35a5ecd32  05-replay.txt
28ab4a5c2ca1f6cd9a97fb060cfd07180872d259726d063ad249ce28e60ac730  05-session-cost.json
16f35725ade1a09f8a7eded8bb13d5f5af5b3e24483c5d3c1a3189c0658d50aa  06-hook-coverage.txt
c807422ee451f9ecb65d89079e805f19e9539e4ad184ad58db12ed076c2cd190  SUMMARY.md
4a23f4b7285f911064fdbca0ccb528e9e402fef2af0973e8200ae33d9e4971ec  devin-e2e-test-plan.md
d6046b85be231e46a0989521143de01755a303a6f54270dc8bb2ff3477d9cb17  aidlc-state.md
5168931f72c86e129a03e79b70b3b249661954b2362114f6a2683fb91507572c  audit-shard.md
3b12b02ea42e6c71411cf4395d3243fe140556fd45aeee178f9fd7315877b308  construction-artifacts/build-and-test/build-and-test-summary.md
8d5189fa8f5e23b3aa60df721fbc1264629a356e69ca32158ed6d724eadbb8a7  construction-artifacts/build-and-test/build-instructions.md
d6d8c078c3e2455311dd3046a22cfc795fb5dd67b40885b343770e830da556e7  construction-artifacts/build-and-test/cross-unit-traceability.md
a9c770481f2660b3efa92538df41f75f66150bf55d571f150bf0ce6fe2f624a4  construction-artifacts/build-and-test/memory.md
ff1b586633c9de81b31fe9599b59a8d2d74336cf53a2ce1bd77e7b0d567658ca  construction-artifacts/build-and-test/test-results.md
e82f08276ac219f8cd7861e3d1df5fd0d691b050f961ebc55d2fb0db5a960179  construction-artifacts/code-generation/code-generation-plan.md
fa178a56af9362a664a961232b092e4ab182d1717627d8355f1703599d63663f  construction-artifacts/code-generation/code-generation-questions.md
8a74346640d04d8a0125514a4e60e854c93c1219c9cd26999ddad947c9c5c440  construction-artifacts/code-generation/code-summary.md
a9c770481f2660b3efa92538df41f75f66150bf55d571f150bf0ce6fe2f624a4  construction-artifacts/code-generation/memory.md
40b4aa2218d3df78edf6b890ea37f15526300bea37a3c6dd0aef3e41dd584435  construction-artifacts/code-generation/source-manifest.json
d309f142ec2e3138f368a1e29f0d7b4c2cf1872f6fd42048836509472f0e0c40  construction-artifacts/code-generation/traceability.json
63108ee8269a7f743124f56687a53a2c4638f5e4021920fd4bd27190fd99133c  construction-artifacts/code-generation/unit-test-instructions.md
266f22685e43048bdd7d31a34982b64b67b662aa0adc8a0cd6b5b1d1d836e582  continue-prompt.txt
a9c770481f2660b3efa92538df41f75f66150bf55d571f150bf0ce6fe2f624a4  inception-artifacts/requirements-analysis/memory.md
3f6a7909fdeedcf7a9a12c4b7750d678bb73e9eb4d2d467f89efdff3fc974600  inception-artifacts/requirements-analysis/requirements-analysis-questions.md
7235c61c6f1c5f7b065d4b992dd14205c7c43d8a66392a7f965bd6ecfaee1be5  inception-artifacts/requirements-analysis/requirements.md
48218924156e652f21993c6b7fda3787139044e7a937423382528cae2e871caf  runtime-graph.json
9a47ecccb9b7f1de4f28155773cf402633069935acee8bb2a8bf4331c7539dd7  workflow-prompt.txt
```
