# Changelog

All notable changes to this project will be documented in this file.
## [0.1.7] - 2026-04-02


### Bug Fixes

- add required environmental github token (#137)
- Add security extension disclaimer (#134)
- refactor error handling and PR creation in release workflow (#140)
- address PR #140 review feedback for release workflow (#141)
- remove retention-days limit from CodeBuild workflow artifacts (#149)
- skip PR comment steps for fork PRs with read-only GITHUB_TOKEN (#154)
- correct GitHub API path for deleting label-reminder comment (#157)
- remove report-bundle CodeBuild secondary artifact and add --local-run-dir support (#162)
- use PR head branch for rules-ref instead of merge ref (#168)
- write aidlc-rules/VERSION in release PR to trigger CodeBuild (#169)


### Documentation

- add developer's guide for running CodeBuild locally (#94)
- add working-with-aidlc interaction guide and writing-inputs documents (#121)
- comprehensive documentation review and remediation (#113)


### Features

- add code owners (#112)
- changelog-first release flow with build artifacts on draft releases (#125)
- add AIDLC Evaluation & Reporting Framework (#115)
- update pull request linting conditions (#131)
- add cross-release trend reporting package (#136)
- align CodeBuild workflow with current evaluator CLI and add trend report pipeline  (#147)
- gate CodeBuild on 'codebuild' label + aidlc-rules paths (#150)
- auto-label PRs touching aidlc-rules/ with codebuild label (#158)


### Miscellaneous

- bump pyjwt in /scripts/aidlc-evaluator (#129)
- bump pillow in /scripts/aidlc-evaluator (#130)
- bump requests in /scripts/aidlc-evaluator (#146)
- bump cryptography in /scripts/aidlc-evaluator (#148)
- bump pygments in /scripts/aidlc-evaluator (#151)
- bump aiohttp in /scripts/aidlc-evaluator (#163)
## [0.1.6] - 2026-03-05


### Bug Fixes

- codebuild cache and download fix (#93)
- correct copy-paste error in error-handling.md (#96)


### Features

- add CodeBuild workflow (#92)


### Miscellaneous

- add templates for github issues (#97)
## [0.1.4] - 2026-02-24


### Bug Fixes

- correct GitHub Copilot instructions and Kiro CLI rule-details path resolution (#82, #84) (#87)
## [0.1.3] - 2026-02-11


### Bug Fixes

- require actual system time for audit timestamps (#56)


### Documentation

- clarify ZIP download location and consolidate notes (#70)
## [0.1.2] - 2026-02-08


### Bug Fixes

- typo in core-workflow.md
- rename rule and move to bottom of Critical Rules section


### Documentation

- update README to direct users to GitHub Releases (#61)
- add Windows CMD setup instructions and ZIP note (#68)


### Features

- add test automation friendly code generation rules
- add frontend design coverage in Construction phase
## [0.1.1] - 2026-01-22


### Features

- adding AIDLC skill to work with IDEs such as Claude, OpenCode and others
- addin
- add leo file


### Miscellaneous

- removing wrong files
- removing wrong files
## [0.1.0] - 2026-01-22


### Features

- add Kiro CLI support and multi-platform architecture

