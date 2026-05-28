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


"""Tests for Unit 3 Pydantic models."""

from pathlib import Path

import pytest

from design_reviewer.parsing.models import (
    ApplicationDesignModel,
    DesignData,
    FunctionalDesignModel,
    TechnicalEnvironmentModel,
)


class TestApplicationDesignModel:
    def test_construction(self):
        m = ApplicationDesignModel(
            raw_content="# Components\n...",
            file_paths=[Path("/a/components.md")],
            source_count=1,
        )
        assert m.raw_content == "# Components\n..."
        assert m.source_count == 1

    def test_frozen_rejects_assignment(self):
        m = ApplicationDesignModel(raw_content="x", file_paths=[], source_count=0)
        with pytest.raises(Exception):
            m.raw_content = "y"

    def test_empty_raw_content_allowed(self):
        m = ApplicationDesignModel(raw_content="", file_paths=[], source_count=0)
        assert m.raw_content == ""


class TestFunctionalDesignModel:
    def test_construction(self):
        m = FunctionalDesignModel(
            raw_content="# Unit: u1\n...",
            file_paths=[Path("/a/b.md")],
            unit_names=["unit1"],
            source_count=1,
        )
        assert m.unit_names == ["unit1"]
        assert m.source_count == 1

    def test_frozen_rejects_assignment(self):
        m = FunctionalDesignModel(
            raw_content="", file_paths=[], unit_names=[], source_count=0
        )
        with pytest.raises(Exception):
            m.unit_names = ["new"]


class TestTechnicalEnvironmentModel:
    def test_construction_with_path(self):
        m = TechnicalEnvironmentModel(
            raw_content="# Tech Stack\n...",
            file_path=Path("/docs/technical-environment.md"),
        )
        assert m.file_path is not None

    def test_file_path_optional(self):
        m = TechnicalEnvironmentModel(raw_content="")
        assert m.file_path is None

    def test_frozen_rejects_assignment(self):
        m = TechnicalEnvironmentModel(raw_content="x")
        with pytest.raises(Exception):
            m.raw_content = "y"


class TestDesignData:
    def test_all_parsed_fields_optional(self):
        d = DesignData(raw_content={Path("/a"): "content"})
        assert d.app_design is None
        assert d.functional_designs is None
        assert d.tech_env is None

    def test_raw_content_required(self):
        with pytest.raises(Exception):
            DesignData()  # raw_content missing

    def test_with_all_fields(self):
        app = ApplicationDesignModel(raw_content="app", file_paths=[], source_count=0)
        func = FunctionalDesignModel(
            raw_content="func", file_paths=[], unit_names=[], source_count=0
        )
        tech = TechnicalEnvironmentModel(raw_content="tech")
        d = DesignData(
            app_design=app,
            functional_designs=func,
            tech_env=tech,
            raw_content={},
        )
        assert d.app_design is app
        assert d.functional_designs is func
        assert d.tech_env is tech

    def test_frozen_rejects_assignment(self):
        d = DesignData(raw_content={})
        with pytest.raises(Exception):
            d.app_design = None
