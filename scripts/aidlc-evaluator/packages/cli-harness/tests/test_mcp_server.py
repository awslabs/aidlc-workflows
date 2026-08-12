"""Contract tests for the AI-DLC MCP stdio entrypoint."""

from __future__ import annotations

from pathlib import Path

import pytest
from cli_harness.mcp_gate import GateToolOutcome, GateToolResponse
from cli_harness.mcp_server import build_service, create_server
from mcp.server.fastmcp.exceptions import ToolError


class FakeService:
    def __init__(self) -> None:
        self.calls: list[tuple[str, str]] = []

    def review(self, interaction_type: str, artifact_path: str) -> GateToolResponse:
        self.calls.append((interaction_type, artifact_path))
        return GateToolResponse(
            outcome=GateToolOutcome.APPROVED,
            reason_code="completed",
            interaction_type=interaction_type,
            artifact_path=artifact_path,
            gate_id="approval:contract",
            presented_sha256="a" * 64,
            current_sha256="a" * 64,
            provider="plannotator",
        )


@pytest.mark.asyncio
async def test_server_exposes_one_closed_high_level_tool() -> None:
    service = FakeService()
    server = create_server(service)  # type: ignore[arg-type]
    tools = await server.list_tools()

    assert [tool.name for tool in tools] == ["review_aidlc_gate"]
    schema = tools[0].inputSchema
    assert set(schema["properties"]) == {"interaction_type", "artifact_path"}
    assert set(schema["required"]) == {"interaction_type", "artifact_path"}
    assert schema.get("additionalProperties") is False

    result = await server.call_tool(
        "review_aidlc_gate",
        {"interaction_type": "approval", "artifact_path": "aidlc-docs/plan.md"},
    )
    assert service.calls == [("approval", "aidlc-docs/plan.md")]
    assert result[1]["outcome"] == "approved"
    assert result[1]["blocking"] is False


@pytest.mark.asyncio
async def test_unknown_tool_argument_is_rejected_before_service() -> None:
    service = FakeService()
    server = create_server(service)  # type: ignore[arg-type]

    with pytest.raises(ToolError):
        await server.call_tool(
            "review_aidlc_gate",
            {
                "interaction_type": "approval",
                "artifact_path": "plan.md",
                "command": "unsafe",
            },
        )
    assert service.calls == []


def test_build_service_validates_trusted_launch_configuration(tmp_path: Path) -> None:
    service = build_service(["--workspace", str(tmp_path), "--timeout", "30"])
    assert service is not None

    with pytest.raises(ValueError, match="requires a valid SHA-256"):
        build_service(
            [
                "--workspace",
                str(tmp_path),
                "--verification",
                "checksum",
                "--sha256",
                "invalid",
            ]
        )


def test_build_service_rejects_missing_workspace(tmp_path: Path) -> None:
    with pytest.raises(FileNotFoundError):
        build_service(["--workspace", str(tmp_path / "missing")])
