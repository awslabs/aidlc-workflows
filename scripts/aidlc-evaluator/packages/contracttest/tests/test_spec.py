"""Tests for OpenAPI-based contract spec loading."""

from pathlib import Path
from contracttest.spec import load_spec


def test_load_openapi_spec(tmp_path):
    spec_file = tmp_path / "openapi.yaml"
    spec_file.write_text("""
openapi: "3.1.0"
info:
  title: Test API
  version: "1.0.0"

x-app:
  module: "myapp.app:app"
  framework: "fastapi"
  startup_timeout: 10
  port: 8080

paths:
  /health:
    get:
      operationId: health_check
      x-test-cases:
        - name: "health"
          expected_status: 200
          expected_body:
            status: "ok"

  /api/data:
    post:
      operationId: create_data
      x-test-cases:
        - name: "create item"
          body: {"key": "value"}
          expected_status: 201
          expected_body:
            id: 1
        - name: "missing body - 422"
          body: {}
          expected_status: 422
""")
    spec = load_spec(spec_file)
    assert spec.app.module == "myapp.app:app"
    assert spec.app.framework == "fastapi"
    assert spec.app.startup_timeout == 10
    assert spec.app.port == 8080
    assert spec.title == "Test API"
    assert spec.version == "1.0.0"
    assert len(spec.test_cases) == 3

    c0 = spec.test_cases[0]
    assert c0.name == "health"
    assert c0.method == "GET"
    assert c0.path == "/health"
    assert c0.expected_status == 200
    assert c0.expected_body == {"status": "ok"}
    assert c0.body is None
    assert c0.operation_id == "health_check"

    c1 = spec.test_cases[1]
    assert c1.method == "POST"
    assert c1.body == {"key": "value"}
    assert c1.operation_id == "create_data"

    c2 = spec.test_cases[2]
    assert c2.expected_status == 422


def test_load_spec_defaults(tmp_path):
    """Minimal spec with no x-app — should use defaults."""
    spec_file = tmp_path / "openapi.yaml"
    spec_file.write_text("""
openapi: "3.1.0"
info:
  title: Minimal
  version: "0.0.1"

x-app:
  module: "app:app"

paths:
  /ping:
    get:
      x-test-cases:
        - name: "ping"
          expected_status: 200
""")
    spec = load_spec(spec_file)
    assert spec.app.framework == "fastapi"
    assert spec.app.startup_timeout == 15
    assert spec.app.port == 0
    assert len(spec.test_cases) == 1
    assert spec.test_cases[0].method == "GET"
    assert spec.test_cases[0].body is None
    assert spec.test_cases[0].expected_body is None


def test_load_spec_multiple_methods(tmp_path):
    """Path with both GET and POST operations."""
    spec_file = tmp_path / "openapi.yaml"
    spec_file.write_text("""
openapi: "3.1.0"
info:
  title: Multi
  version: "0.1.0"
x-app:
  module: "app:app"
paths:
  /items:
    get:
      operationId: list_items
      x-test-cases:
        - name: "list all"
          expected_status: 200
    post:
      operationId: create_item
      x-test-cases:
        - name: "create"
          body: {"name": "x"}
          expected_status: 201
""")
    spec = load_spec(spec_file)
    assert len(spec.test_cases) == 2
    methods = {tc.method for tc in spec.test_cases}
    assert methods == {"GET", "POST"}


def test_load_spec_no_test_cases(tmp_path):
    """Operations without x-test-cases are silently skipped."""
    spec_file = tmp_path / "openapi.yaml"
    spec_file.write_text("""
openapi: "3.1.0"
info:
  title: Empty
  version: "0.1.0"
x-app:
  module: "app:app"
paths:
  /hidden:
    get:
      operationId: hidden
      summary: "No test cases here"
""")
    spec = load_spec(spec_file)
    assert len(spec.test_cases) == 0


def test_load_real_openapi_spec():
    """Validate that the actual sci-calc OpenAPI spec loads correctly."""
    spec_path = Path(__file__).resolve().parents[3] / "test_cases" / "sci-calc" / "openapi.yaml"
    if not spec_path.exists():
        return
    spec = load_spec(spec_path)
    assert spec.title == "Scientific Calculator API"
    assert spec.version == "0.1.0"
    assert spec.app.module == "sci_calc.app:app"
    assert len(spec.test_cases) >= 60
    ops = {tc.operation_id for tc in spec.test_cases if tc.operation_id}
    assert "health" in ops
    assert "arithmetic_add" in ops
    assert "powers_sqrt" in ops
    assert "trig_sin" in ops
    assert "log_ln" in ops
    assert "stats_mean" in ops
    assert "constants_pi" in ops
    assert "convert_temperature" in ops
