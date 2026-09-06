# TB21 Codex Exec Native Windows Evidence

- Date: 2026-08-25
- Host: `<NATIVE_WINDOWS_HOST>`
- Platform: Microsoft Windows NT 10.0.26100.0
- Bun: 1.3.14
- Codex: `codex-cli 0.148.0`
- Live gate: `AIDLC_CODEX_EXEC_LIVE=1`
- AWS profile/region metadata: `default` / `us-east-2`

The five-file run produced one workspace-journey red at the teamB intent
postcondition at `2026-08-25T12:59:33Z`. After applying the bounded,
postcondition-aware retry to both direct intent births, that file was rerun
green alone at `2026-08-25T13:13:06Z`. Together the two runner-generated stamps
prove every intended workflow assertion while preserving the failure record.

```text
STAMP:    tests/evidence/tb21-codex-exec-native-windows/full-slice
TRACES:   <REPO_ROOT>/tests/evidence/tb21-codex-exec-native-windows/full-slice/t-exec-codex-*.log  (5 files; Codex exec has no SDK/TUI/Kiro ACP ndjson driver)
SUMMARY:  tests/evidence/tb21-codex-exec-native-windows/full-slice/summary.txt  +  failures.txt  (Result: FAIL; Failed files: 1)
RESULT:   e2e Codex exec live files . 4 pass/1 fail . reds: t-exec-codex-journey-workspace . live vars set: AIDLC_CODEX_EXEC_LIVE,AIDLC_CODEX_AWS_PROFILE,AIDLC_CODEX_AWS_REGION
```

```text
STAMP:    tests/evidence/tb21-codex-exec-native-windows/journey-rerun
TRACES:   <REPO_ROOT>/tests/evidence/tb21-codex-exec-native-windows/journey-rerun/t-exec-codex-*.log  (1 file; Codex exec has no SDK/TUI/Kiro ACP ndjson driver)
SUMMARY:  tests/evidence/tb21-codex-exec-native-windows/journey-rerun/summary.txt  +  failures.txt  (Result: PASS; Failed files: 0)
RESULT:   e2e journey green-alone rerun . 1 pass/0 fail . reds: none . live vars set: AIDLC_CODEX_EXEC_LIVE,AIDLC_CODEX_AWS_PROFILE,AIDLC_CODEX_AWS_REGION
```

The retained files replace machine-specific paths and session identifiers with
`<WORKSPACE>`, `<SCRATCH_WORKSPACE>`, `<WINDOWS_USER_HOME>`, and
`<SESSION_ID>`. They contain no AWS credentials.

The following authored sources were copied byte-for-byte to the native Windows
checkout before the passing journey rerun:

| Source | SHA-256 |
|---|---|
| `tests/harness/exec-drive.ts` | `1920319fdf844669b7ab3df2995291fcfa26ac4aae722f54d969a3b6bb080e9e` |
| `tests/e2e/t-exec-codex-journey-workspace.serial.test.ts` | `fdc10753dbe2cd0579443660fc2b7de40d5c17ce75564b2e83238aa50254b7c2` |

| File | SHA-256 |
|---|---|
| `full-slice/failures.txt` | `b461dc418c62eee88fa886f31839c5d80576744e15f97aca1594e5eee4f0fc87` |
| `full-slice/summary.txt` | `807a0a90710d41ad100528d9ac8f68388c074250862c2c9cd320cfda34a1dbce` |
| `full-slice/t-exec-codex-compose-front.serial.log` | `0509ee73c25f632341b33bde8274fe1328a237356c50418d8a13e7121f13074f` |
| `full-slice/t-exec-codex-compose-inflight.serial.log` | `07de1a93e90cc9b143af9b82b4d0c06aed41b0d219ed4e74e9f4b8b80d3234a9` |
| `full-slice/t-exec-codex-journey-workspace.serial.log` | `d02930fabb49874a429a9b8f8933f66ab019eb45e454b51baa969cba13b65f59` |
| `full-slice/t-exec-codex-memory-include.serial.log` | `f7d86e16fbb90aea5dad948ed23c2b894689d29bffae395b87ecbe693994156e` |
| `full-slice/t-exec-codex-status.serial.log` | `5202ca0d1f6805af02f32a21d068e602a07a053a4455023e9e7323f0a3ed956c` |
| `journey-rerun/failures.txt` | `01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b` |
| `journey-rerun/summary.txt` | `1b7c5f6ef176d01f9b9bcd9a8149d85a8c0eb3386e89367810c9cb864516e28f` |
| `journey-rerun/t-exec-codex-journey-workspace.serial.log` | `3d23e9659066657dbcaf64ae82b8c74b924b7991835947b37f3df55fd45b7445` |
