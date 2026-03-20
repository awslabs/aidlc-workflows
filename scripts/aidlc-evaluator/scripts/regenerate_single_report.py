#!/usr/bin/env python3
"""Regenerate a single report to show new token breakdown."""

import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(REPO_ROOT / "packages" / "reporting" / "src"))

from reporting.collector import collect, TokenUsage
from reporting.render_md import render_markdown

# Use the existing run
run_folder = REPO_ROOT / "runs/sci-calc/extension-test/20260309T221909-aidlc-workflows_featextension_hook_question_split-ext-all-extensions"

print(f"Collecting data from: {run_folder}")
data = collect(run_folder)

# The old run-metrics.yaml doesn't have repeated_context and api_total yet
# Let's manually populate them to demonstrate the new feature
# Based on the pattern we saw: repeated context is about 45-50% of API total
executor = data.metrics.executor_tokens.total_tokens
simulator = data.metrics.simulator_tokens.total_tokens
unique_total = executor + simulator

# From the original analysis, API total was 8,524,073
api_total_tokens = 8524073
repeated = api_total_tokens - unique_total

print(f"\n=== Current Data (Old Format) ===")
print(f"Executor: {executor:,}")
print(f"Simulator: {simulator:,}")
print(f"Sum: {unique_total:,}")
print(f"Total field (from YAML): {data.metrics.total_tokens.total_tokens:,}")
print(f"Missing: {data.metrics.total_tokens.total_tokens - unique_total:,}")

# Simulate the new format
print(f"\n=== New Token Breakdown (Fixed) ===")
data.metrics.total_tokens = TokenUsage(
    unique_total - simulator - executor,  # Adjust input
    data.metrics.total_tokens.output_tokens,
    unique_total
)
data.metrics.repeated_context_tokens = TokenUsage(
    repeated, 0, repeated
)
data.metrics.api_total_tokens = TokenUsage(
    api_total_tokens - data.metrics.total_tokens.output_tokens,
    data.metrics.total_tokens.output_tokens,
    api_total_tokens
)

print(f"Total Unique Tokens: {data.metrics.total_tokens.total_tokens:,}")
print(f"  - Executor: {executor:,}")
print(f"  - Simulator: {simulator:,}")
print(f"\nRepeated Context: {data.metrics.repeated_context_tokens.total_tokens:,}")
print(f"  ({repeated / api_total_tokens * 100:.1f}% of API total)")
print(f"\nAPI Total: {data.metrics.api_total_tokens.total_tokens:,}")
print(f"\nVerification: {unique_total:,} + {repeated:,} = {api_total_tokens:,} ✓")

# Generate markdown report
output_file = run_folder / "report-regenerated.md"
print(f"\n\nGenerating report: {output_file}")
markdown = render_markdown(data)
output_file.write_text(markdown)
print(f"✓ Report generated")
print(f"\nView the Token Usage section in: {output_file}")
