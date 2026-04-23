# IDE Test Harness — Architecture Design

## Problem

The AIDLC evaluation framework runs via a two-agent Strands swarm on Bedrock. To evaluate
IDE-based AI coding assistants, we need to drive the same AIDLC process through each IDE's
AI chat interface and capture the outputs in a format compatible with the existing evaluation
pipeline (stages 2–6).

## Input/Output Contract

### Inputs (provided to each IDE adapter)

- `vision.md` — the application vision document
- `tech-env.md` — technical environment specification
- AIDLC rules — the full AIDLC workflow rules (from `aidlc-workflows` repo)
- Initial prompt template — instructions for the IDE AI to follow the AIDLC process

### Outputs (captured from each IDE adapter)

- `aidlc-docs/` — generated AIDLC documentation (same structure as Strands runs)
  - `inception/requirements/`, `inception/plans/`, `inception/application-design/`
  - `construction/plans/`, `construction/build-and-test/`
  - `aidlc-state.md`, `audit.md`
- `workspace/` — generated application source code and tests
- `run-meta.yaml` — run metadata (adapter-generated, matches collector schema)
- `test-results.yaml` — post-run test results (adapter runs tests after IDE completes)

### Output Normalization

IDE outputs will not match the Strands run folder layout exactly. Each adapter must
normalize its output to match the expected structure:

```text
<run-folder>/
  run-meta.yaml          # adapter generates this
  run-metrics.yaml       # adapter generates (tokens if available, timing always)
  test-results.yaml      # adapter runs tests post-generation
  aidlc-docs/            # extracted/copied from IDE workspace
  workspace/             # extracted/copied from IDE workspace
```

This allows `run_evaluation.py --evaluate-only <run-folder>/aidlc-docs` to score the output.

## Adapter Interface

```python
from abc import ABC, abstractmethod
from dataclasses import dataclass
from pathlib import Path

@dataclass
class AdapterConfig:
    """Configuration for an IDE adapter run."""
    vision_path: Path           # path to vision.md
    tech_env_path: Path | None  # path to tech-env.md (optional)
    rules_path: Path            # path to cloned aidlc-workflows rules
    output_dir: Path            # where to write normalized output
    prompt_template: str        # initial prompt to send to IDE AI
    timeout_seconds: int = 7200 # max time to wait for IDE completion

@dataclass
class AdapterResult:
    """Result from an IDE adapter run."""
    success: bool
    output_dir: Path
    aidlc_docs_dir: Path | None
    workspace_dir: Path | None
    error: str | None = None
    elapsed_seconds: float = 0.0
    token_estimate: int | None = None  # if IDE reports token usage

class IDEAdapter(ABC):
    """Abstract base for IDE-specific automation adapters."""

    @property
    @abstractmethod
    def name(self) -> str:
        """Human-readable IDE name."""
        ...

    @abstractmethod
    def check_prerequisites(self) -> tuple[bool, str]:
        """Verify IDE is installed, configured, and accessible.

        Returns (ok, message).
        """
        ...

    @abstractmethod
    def run(self, config: AdapterConfig) -> AdapterResult:
        """Execute the AIDLC process through the IDE and capture outputs.

        Steps:
        1. Set up a clean workspace directory
        2. Copy/symlink vision.md, tech-env.md, and rules into the workspace
        3. Launch IDE (or connect to running instance)
        4. Send the initial prompt to the IDE's AI chat
        5. Monitor for completion (all AIDLC phases done)
        6. Extract aidlc-docs/ and workspace/ from IDE output
        7. Generate run-meta.yaml with timing and adapter info
        """
        ...
```

## Run Orchestration

```text
run_ide_evaluation.py
  ├── parse args (--ide <name>, --vision, --golden, etc.)
  ├── load adapter by name
  ├── adapter.check_prerequisites()
  ├── adapter.run(config) → AdapterResult
  ├── post_run_tests(result.workspace_dir)  → test-results.yaml
  └── run_evaluation.py --evaluate-only <result.aidlc_docs_dir> --golden <golden>
```

The orchestrator script:

1. Instantiates the adapter for the target IDE
2. Runs the adapter to generate outputs
3. Runs post-generation tests (install deps + pytest/npm test)
4. Invokes the existing evaluation pipeline in evaluate-only mode

## Adapter Implementation Strategy

### Category A: CLI-scriptable IDEs

IDEs with CLI or API support for sending prompts and receiving responses.

- **Cursor** — Has CLI (`cursor` command). May support `--chat` or similar.
- **Kiro** — AWS IDE, likely has Bedrock integration. Check for CLI.

Approach: Subprocess invocation, parse stdout/stderr, monitor workspace for output files.

### Category B: VS Code extension IDEs

IDEs that run as VS Code extensions with no independent CLI.

- **Cline** — VS Code extension. Must automate VS Code.
- **GitHub CoPilot** — VS Code extension. Chat panel automation needed.

Approach: Use `@vscode/test-electron` or Playwright-based VS Code automation.

### Category C: VS Code fork IDEs

Standalone IDE forks of VS Code with built-in AI.

- **Windsurf** — Codeium's fork. Electron app, VS Code internals.
- **Antigravity** — AI coding assistant.

Approach: Electron automation via Playwright or native extension API.

### Common Post-Run Steps (all adapters)

1. Scan workspace for `aidlc-docs/` directory structure
2. Identify generated source code under `workspace/` or project root
3. Normalize file layout to match expected schema
4. Detect project type (Python/Node/Rust/Go)
5. Install dependencies and run tests
6. Generate `run-meta.yaml` and `run-metrics.yaml`

## Package Structure

```text
packages/ide-harness/
  pyproject.toml
  src/ide_harness/
    __init__.py
    adapter.py          # Abstract adapter interface + AdapterConfig/Result
    orchestrator.py     # Run orchestration (invoke adapter + evaluation)
    normalizer.py       # Output normalization utilities
    post_run.py         # Reuse/adapt execution package's post-run test logic
    prompt_template.py  # Standard AIDLC prompt template for IDE AI
    adapters/
      __init__.py
      kiro.py
      cursor.py
      cline.py
      copilot.py
      windsurf.py
      antigravity.py
  tests/
    test_normalizer.py
    test_orchestrator.py
```

## Prompt Template

The prompt sent to each IDE AI must instruct it to follow the AIDLC process:

```text
You are tasked with building an application following the AIDLC (AI Development
Life Cycle) process. The AIDLC rules are provided in the `aidlc-rules/` directory.

Please read the vision document at `vision.md` and follow the complete AIDLC process:

1. INCEPTION PHASE:
   - Read the AIDLC rules for the inception phase
   - Create requirements, plans, and application design documents
   - Output these to `aidlc-docs/inception/`

2. CONSTRUCTION PHASE:
   - Read the AIDLC rules for the construction phase
   - Create build plans and test instructions
   - Generate the application source code and tests
   - Output documents to `aidlc-docs/construction/`
   - Output code to the project root (which becomes `workspace/`)

3. Generate `aidlc-docs/aidlc-state.md` tracking your progress through each phase.

Follow every AIDLC rule precisely. Do not skip phases or documents.
```

## Open Questions

1. **Completion detection**: How to detect when the IDE AI has finished all AIDLC phases?
   - File-based: watch for `aidlc-state.md` indicating construction complete
   - Time-based: timeout after N minutes
   - Prompt-based: ask the IDE AI to signal completion

2. **Multi-turn interaction**: The AIDLC process involves human simulator handoffs.
   For IDEs, should we:
   - Send a single comprehensive prompt and let the IDE handle everything?
   - Script multi-turn interaction (approve each phase transition)?
   - Use a semi-automated approach (human monitors, scripts capture)?

3. **Token tracking**: Most IDEs don't expose token usage. Options:
   - Estimate from output size
   - Capture Bedrock CloudWatch metrics (if IDE uses Bedrock)
   - Accept "N/A" for token metrics on IDE runs
