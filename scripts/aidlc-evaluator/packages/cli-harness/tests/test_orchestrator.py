"""Tests that incomplete CLI runs are never qualitatively evaluated."""

from pathlib import Path

from cli_harness.adapter import AdapterConfig, AdapterResult, CLIAdapter
from cli_harness.normalizer import normalize_output
from cli_harness.orchestrator import run_cli_evaluation


class IncompleteAdapter(CLIAdapter):
    @property
    def name(self) -> str:
        return "incomplete"

    def check_prerequisites(self, config: AdapterConfig | None = None):
        return True, "ready"

    def run(self, config: AdapterConfig) -> AdapterResult:
        workspace = config.output_dir / "workspace"
        docs = config.output_dir / "aidlc-docs"
        workspace.mkdir(parents=True)
        docs.mkdir()
        (docs / "aidlc-state.md").write_text("- [ ] Build and Test\n", encoding="utf-8")
        normalize_output(workspace, config.output_dir, self.name, status="incomplete")
        return AdapterResult(
            success=False,
            output_dir=config.output_dir,
            aidlc_docs_dir=docs,
            workspace_dir=workspace,
            error="approval gate pending",
            extra={"run_status": "incomplete"},
        )


def test_incomplete_run_skips_qualitative_evaluation(tmp_path: Path, monkeypatch) -> None:
    vision = tmp_path / "vision.md"
    vision.write_text("# Vision\n", encoding="utf-8")
    rules = tmp_path / "rules.md"
    rules.write_text("# Rules\n", encoding="utf-8")
    golden = tmp_path / "golden"
    golden.mkdir()

    def forbidden(*_args, **_kwargs):
        raise AssertionError("qualitative evaluation must not run")

    monkeypatch.setattr("cli_harness.orchestrator.subprocess.run", forbidden)
    result, exit_code = run_cli_evaluation(
        adapter=IncompleteAdapter(),
        vision_path=vision,
        output_dir=tmp_path / "run",
        golden_docs=golden,
        rules_path=rules,
    )
    assert not result.success
    assert exit_code == 2
