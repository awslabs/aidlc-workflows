"""Tests for ASCII sparkline and formatting utilities."""

from __future__ import annotations

from trend_reports.sparkline import (
    format_delta,
    format_number,
    format_pct,
    format_seconds_as_minutes,
    sparkline,
    trend_arrow,
)


class TestSparkline:
    def test_empty_list(self):
        assert sparkline([]) == ""

    def test_single_value(self):
        result = sparkline([5])
        assert len(result) == 1

    def test_all_identical(self):
        result = sparkline([3, 3, 3, 3])
        assert len(result) == 4
        assert len(set(result)) == 1

    def test_ascending(self):
        result = sparkline([1, 2, 3, 4, 5])
        assert len(result) == 5
        assert result[0] < result[-1]

    def test_two_values_min_max(self):
        result = sparkline([0, 100])
        assert len(result) == 2

    def test_negative_values(self):
        result = sparkline([-10, 0, 10])
        assert len(result) == 3


class TestTrendArrow:
    def test_empty_list(self):
        assert trend_arrow([]) == "→"

    def test_single_value(self):
        assert trend_arrow([5]) == "→"

    def test_strong_increase(self):
        assert trend_arrow([100, 110]) == "↑"

    def test_strong_decrease(self):
        assert trend_arrow([100, 90]) == "↓"

    def test_flat(self):
        assert trend_arrow([100, 100.5]) == "→"

    def test_zero_first_positive_last(self):
        assert trend_arrow([0, 10]) == "↑"

    def test_zero_both(self):
        assert trend_arrow([0, 0]) == "→"

    def test_mild_increase(self):
        assert trend_arrow([100, 103]) == "↗"

    def test_mild_decrease(self):
        assert trend_arrow([100, 97]) == "↘"


class TestFormatNumber:
    def test_integer_small(self):
        assert format_number(42) == "42"

    def test_integer_thousands(self):
        result = format_number(1500)
        assert "K" in result

    def test_integer_millions(self):
        result = format_number(9260000)
        assert "M" in result

    def test_float_small(self):
        assert format_number(0.891) == "0.891"

    def test_float_millions(self):
        result = format_number(9.26e6)
        assert "M" in result

    def test_zero_int(self):
        assert format_number(0) == "0"


class TestFormatSecondsAsMinutes:
    def test_zero(self):
        assert format_seconds_as_minutes(0) == "0.0m"

    def test_one_minute(self):
        assert format_seconds_as_minutes(60) == "1.0m"

    def test_fractional(self):
        result = format_seconds_as_minutes(90)
        assert result == "1.5m"


class TestFormatDelta:
    def test_positive_int(self):
        assert format_delta(5) == "+5"

    def test_negative_int(self):
        assert format_delta(-3) == "-3"

    def test_zero_int(self):
        assert format_delta(0) == "+0"

    def test_positive_float(self):
        assert format_delta(0.5) == "+0.5"

    def test_custom_precision(self):
        assert format_delta(0.028, precision=3) == "+0.028"


class TestFormatPct:
    def test_zero(self):
        assert format_pct(0.0) == "0.0%"

    def test_full(self):
        assert format_pct(1.0) == "100.0%"

    def test_partial(self):
        assert format_pct(0.5) == "50.0%"

    def test_over_one(self):
        result = format_pct(1.5)
        assert "150" in result
