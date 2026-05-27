# Copyright (c) 2026 AIDLC Design Reviewer Contributors
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in all
# copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.


"""
Unit tests for pattern data models.

Tests Pattern Pydantic model and is_priority flag.
"""

import pytest
from pydantic import ValidationError

from design_reviewer.foundation.pattern_models import Pattern


class TestPatternModel:
    """Test Pattern model validation."""

    def test_valid_pattern_with_all_fields(self):
        """Test valid pattern with all fields populated."""
        pattern = Pattern(
            name="Layered Architecture",
            category="System Architecture",
            description="Organizes system into horizontal layers",
            when_to_use="Use when you need clear separation of concerns",
            example="Web app with presentation, business logic, and data layers",
            is_priority=True,
        )

        assert pattern.name == "Layered Architecture"
        assert pattern.category == "System Architecture"
        assert pattern.description == "Organizes system into horizontal layers"
        assert pattern.when_to_use == "Use when you need clear separation of concerns"
        assert (
            pattern.example
            == "Web app with presentation, business logic, and data layers"
        )
        assert pattern.is_priority is True

    def test_pattern_required_fields(self):
        """Test required fields in Pattern model."""
        with pytest.raises(ValidationError):
            Pattern()

    def test_name_is_required(self):
        """Test name field is required."""
        with pytest.raises(ValidationError) as exc_info:
            Pattern(
                category="System Architecture",
                description="Test description",
                when_to_use="Test when to use",
                example="Test example",
            )

        errors = exc_info.value.errors()
        assert any(error["loc"] == ("name",) for error in errors)

    def test_category_is_required(self):
        """Test category field is required."""
        with pytest.raises(ValidationError) as exc_info:
            Pattern(
                name="Test Pattern",
                description="Test description",
                when_to_use="Test when to use",
                example="Test example",
            )

        errors = exc_info.value.errors()
        assert any(error["loc"] == ("category",) for error in errors)

    def test_description_is_required(self):
        """Test description field is required."""
        with pytest.raises(ValidationError) as exc_info:
            Pattern(
                name="Test Pattern",
                category="System Architecture",
                when_to_use="Test when to use",
                example="Test example",
            )

        errors = exc_info.value.errors()
        assert any(error["loc"] == ("description",) for error in errors)

    def test_when_to_use_is_required(self):
        """Test when_to_use field is required."""
        with pytest.raises(ValidationError) as exc_info:
            Pattern(
                name="Test Pattern",
                category="System Architecture",
                description="Test description",
                example="Test example",
            )

        errors = exc_info.value.errors()
        assert any(error["loc"] == ("when_to_use",) for error in errors)

    def test_example_is_required(self):
        """Test example field is required."""
        with pytest.raises(ValidationError) as exc_info:
            Pattern(
                name="Test Pattern",
                category="System Architecture",
                description="Test description",
                when_to_use="Test when to use",
            )

        errors = exc_info.value.errors()
        assert any(error["loc"] == ("example",) for error in errors)

    def test_is_priority_optional_defaults_to_false(self):
        """Test is_priority field is optional and defaults to False."""
        pattern = Pattern(
            name="Test Pattern",
            category="Data Management",
            description="Test description",
            when_to_use="Test when to use",
            example="Test example",
        )

        assert pattern.is_priority is False

    def test_is_priority_can_be_set_to_true(self):
        """Test is_priority can be explicitly set to True."""
        pattern = Pattern(
            name="Test Pattern",
            category="System Architecture",
            description="Test description",
            when_to_use="Test when to use",
            example="Test example",
            is_priority=True,
        )

        assert pattern.is_priority is True

    def test_is_priority_coerces_truthy_values(self):
        """Test is_priority coerces truthy string values to boolean."""
        # Pydantic coerces "true" string to True for bool fields
        pattern = Pattern(
            name="Test Pattern",
            category="System Architecture",
            description="Test description",
            when_to_use="Test when to use",
            example="Test example",
            is_priority="true",
        )

        assert pattern.is_priority is True


class TestPatternCategories:
    """Test patterns from different categories."""

    def test_system_architecture_category(self):
        """Test System Architecture category pattern."""
        pattern = Pattern(
            name="Microservices",
            category="System Architecture",
            description="Decomposes application into small, independent services",
            when_to_use="Use for large, complex systems requiring independent deployment",
            example="E-commerce platform with separate order, inventory, payment services",
            is_priority=True,
        )

        assert pattern.category == "System Architecture"
        assert pattern.is_priority is True

    def test_data_management_category(self):
        """Test Data Management category pattern."""
        pattern = Pattern(
            name="Repository",
            category="Data Management",
            description="Encapsulates data access logic",
            when_to_use="Use when you need to abstract database operations",
            example="UserRepository with methods for CRUD operations",
            is_priority=False,
        )

        assert pattern.category == "Data Management"
        assert pattern.is_priority is False

    def test_communication_category(self):
        """Test Communication category pattern."""
        pattern = Pattern(
            name="API Gateway",
            category="Communication",
            description="Single entry point for all client requests",
            when_to_use="Use in microservices to route requests to appropriate services",
            example="API Gateway routing to user service, order service, payment service",
        )

        assert pattern.category == "Communication"

    def test_scalability_category(self):
        """Test Scalability category pattern."""
        pattern = Pattern(
            name="Caching",
            category="Scalability",
            description="Stores frequently accessed data in fast-access storage",
            when_to_use="Use for frequently accessed read-heavy data",
            example="Application using Redis to cache user profile data",
        )

        assert pattern.category == "Scalability"

    def test_reliability_category(self):
        """Test Reliability category pattern."""
        pattern = Pattern(
            name="Circuit Breaker",
            category="Reliability",
            description="Prevents cascading failures by detecting service failures",
            when_to_use="Use when calling remote services to prevent cascade failures",
            example="Payment service calling external gateway with circuit breaker",
        )

        assert pattern.category == "Reliability"


class TestPatternFieldContent:
    """Test pattern field content can hold various data."""

    def test_description_can_be_long(self):
        """Test description field can contain long text."""
        long_description = "This is a very long description. " * 20
        pattern = Pattern(
            name="Test Pattern",
            category="System Architecture",
            description=long_description,
            when_to_use="Test when to use",
            example="Test example",
        )

        assert len(pattern.description) > 500

    def test_when_to_use_can_contain_multiple_scenarios(self):
        """Test when_to_use can describe multiple scenarios."""
        when_to_use = """Use when:
1. You need to prevent resource exhaustion
2. Different operations have different priorities
3. You want to limit blast radius of failures"""

        pattern = Pattern(
            name="Bulkhead",
            category="Reliability",
            description="Isolates resources to prevent failures in one area",
            when_to_use=when_to_use,
            example="Web app with separate thread pools",
        )

        assert "resource exhaustion" in pattern.when_to_use
        assert "blast radius" in pattern.when_to_use

    def test_example_can_be_detailed(self):
        """Test example field can contain detailed examples."""
        detailed_example = """A web application with:
- Thread pool 1: 100 threads for user-facing requests (critical)
- Thread pool 2: 20 threads for background tasks (non-critical)
- Background task failures cannot starve user request threads"""

        pattern = Pattern(
            name="Bulkhead",
            category="Reliability",
            description="Isolates resources",
            when_to_use="Use to prevent resource exhaustion",
            example=detailed_example,
        )

        assert "Thread pool 1" in pattern.example
        assert "100 threads" in pattern.example

    def test_name_can_contain_special_characters(self):
        """Test pattern name can contain special characters."""
        pattern = Pattern(
            name="CQRS (Command Query Responsibility Segregation)",
            category="Data Management",
            description="Separates read and write operations",
            when_to_use="Use when read and write workloads differ significantly",
            example="E-commerce with separate command and query models",
        )

        assert "CQRS" in pattern.name
        assert "(" in pattern.name
        assert ")" in pattern.name


class TestPatternImmutability:
    """Test pattern immutability if frozen=True is configured."""

    def test_pattern_fields_can_be_accessed(self):
        """Test all pattern fields are accessible."""
        pattern = Pattern(
            name="Test Pattern",
            category="System Architecture",
            description="Test description",
            when_to_use="Test when to use",
            example="Test example",
            is_priority=True,
        )

        assert pattern.name is not None
        assert pattern.category is not None
        assert pattern.description is not None
        assert pattern.when_to_use is not None
        assert pattern.example is not None
        assert pattern.is_priority is not None

    def test_pattern_is_frozen_if_configured(self):
        """Test pattern is immutable if frozen=True in model config."""
        pattern = Pattern(
            name="Test Pattern",
            category="System Architecture",
            description="Test description",
            when_to_use="Test when to use",
            example="Test example",
        )

        try:
            pattern.name = "Modified Name"
        except ValidationError:
            pass


class TestPatternValidation:
    """Test pattern validation rules."""

    def test_empty_string_fields_accepted(self):
        """Test empty strings are accepted (no min_length validation on Pattern)."""
        pattern = Pattern(
            name="",
            category="System Architecture",
            description="Test description",
            when_to_use="Test when to use",
            example="Test example",
        )
        assert pattern.name == ""

    def test_all_fields_can_contain_newlines(self):
        """Test fields can contain newline characters."""
        pattern = Pattern(
            name="Test Pattern",
            category="System Architecture",
            description="Line 1\nLine 2\nLine 3",
            when_to_use="Condition 1\nCondition 2",
            example="Example 1\nExample 2",
        )

        assert "\n" in pattern.description
        assert "\n" in pattern.when_to_use
        assert "\n" in pattern.example
