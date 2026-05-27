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
Pydantic models for Unit 3: Parsing output.

All models use content aggregation — raw markdown strings rather than
deeply structured field extraction.
"""

from __future__ import annotations

from pathlib import Path
from typing import Dict, List, Optional

from pydantic import BaseModel, ConfigDict


class ApplicationDesignModel(BaseModel):
    """
    Aggregated content of all application-design artifacts.

    raw_content is the concatenation of all APPLICATION_DESIGN files,
    separated by source headers, ready for Unit 4 AI agents.
    """

    model_config = ConfigDict(frozen=True)

    raw_content: str
    file_paths: List[Path]
    source_count: int


class FunctionalDesignModel(BaseModel):
    """
    Aggregated content of all functional-design artifacts across all units.

    raw_content includes unit-name headers so AI agents know which unit
    each design artifact belongs to.
    """

    model_config = ConfigDict(frozen=True)

    raw_content: str
    file_paths: List[Path]
    unit_names: List[str]
    source_count: int


class TechnicalEnvironmentModel(BaseModel):
    """
    Raw content of technical-environment.md, passed through unchanged.
    """

    model_config = ConfigDict(frozen=True)

    raw_content: str
    file_path: Optional[Path] = None


class DesignData(BaseModel):
    """
    Top-level aggregate model passed to Unit 4 AI agents.

    All parsed model fields are Optional — a review can proceed with any
    subset of artifact types. raw_content is always present (Unit 2 output).
    """

    model_config = ConfigDict(frozen=True)

    app_design: Optional[ApplicationDesignModel] = None
    functional_designs: Optional[FunctionalDesignModel] = None
    tech_env: Optional[TechnicalEnvironmentModel] = None
    raw_content: Dict[Path, str]
