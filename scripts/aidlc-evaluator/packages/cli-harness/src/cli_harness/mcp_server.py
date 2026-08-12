"""MCP stdio entrypoint for automatic AI-DLC Plannotator gates."""

from __future__ import annotations

import argparse
import sys
from collections.abc import Sequence
from pathlib import Path
from typing import Any

from mcp.server.fastmcp import FastMCP

from cli_harness.mcp_gate import GateReviewConfig, GateReviewService

_MAX_DIAGNOSTIC_BYTES = 4096


def _diagnostic(message: str) -> None:
    encoded = message.encode("utf-8", errors="replace")[:_MAX_DIAGNOSTIC_BYTES]
    print(encoded.decode("utf-8", errors="ignore"), file=sys.stderr, flush=True)


def create_server(service: GateReviewService) -> FastMCP:
    """Create a one-tool MCP server around an injected gate service."""
    server = FastMCP(
        "AI-DLC Plannotator Gate",
        instructions=(
            "Review only explicit AI-DLC question or approval artifacts. "
            "Continue only for the legal success outcome of the requested interaction type."
        ),
        log_level="ERROR",
    )

    @server.tool(
        name="review_aidlc_gate",
        description=(
            "Open a digest-bound Plannotator gate for an explicit workspace-relative "
            "AI-DLC Markdown artifact."
        ),
        structured_output=True,
    )
    def review_aidlc_gate(interaction_type: str, artifact_path: str) -> dict[str, Any]:
        """Review questions or an approval artifact and return a typed safe outcome."""
        return service.review(interaction_type, artifact_path).to_dict()

    # MCP 1.23.3 generates a Pydantic argument model with extra="ignore".
    # Tighten that pinned SDK model so unknown tool fields fail at the transport boundary.
    registered = server._tool_manager.get_tool("review_aidlc_gate")
    if registered is None:  # pragma: no cover - registration invariant
        raise RuntimeError("review_aidlc_gate registration failed")
    registered.parameters["additionalProperties"] = False
    registered.fn_metadata.arg_model.model_config["extra"] = "forbid"
    registered.fn_metadata.arg_model.model_rebuild(force=True)
    return server


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Run the AI-DLC Plannotator MCP server")
    parser.add_argument(
        "--workspace",
        type=Path,
        required=True,
        help="Trusted workspace root containing AI-DLC artifacts",
    )
    parser.add_argument(
        "--verification",
        choices=("attestation", "checksum"),
        default="attestation",
        help="Plannotator verification policy",
    )
    parser.add_argument(
        "--sha256",
        dest="expected_sha256",
        help="Exact Plannotator SHA-256 required in checksum mode",
    )
    parser.add_argument(
        "--timeout",
        dest="timeout_seconds",
        type=int,
        default=1800,
        help="Whole Plannotator interaction timeout in seconds",
    )
    return parser


def build_service(argv: Sequence[str] | None = None) -> GateReviewService:
    """Parse trusted launch arguments and construct the review service."""
    args = _parser().parse_args(argv)
    config = GateReviewConfig(
        workspace=args.workspace,
        verification=args.verification,
        expected_sha256=args.expected_sha256,
        timeout_seconds=args.timeout_seconds,
    )
    return GateReviewService(config, diagnostic=_diagnostic)


def main(argv: Sequence[str] | None = None) -> int:
    """Run the stdio MCP server; stdout remains protocol-only."""
    try:
        service = build_service(argv)
    except (OSError, ValueError) as exc:
        _diagnostic(f"MCP configuration rejected: {type(exc).__name__}")
        return 2
    create_server(service).run(transport="stdio")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
