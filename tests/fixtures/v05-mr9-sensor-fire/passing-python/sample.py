# passing-python fixture sample — clean under both ruff and mypy.
#
# Exercised by:
#   - linter sensor: `ruff check --output-format=json sample.py` emits an
#     empty array, pass=true.
#   - type-check sensor: `mypy --output=json sample.py` emits no error
#     diagnostics, pass=true.
#
# Fully type-annotated and lint-clean so neither tool reports a finding.


def greet(name: str) -> str:
    return f"hello {name}"
