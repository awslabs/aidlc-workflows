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
Unit 3: Parsing

Transforms raw markdown content from Unit 2 into structured models for
AI agent consumption in Unit 4.
"""

from design_reviewer.parsing.app_design import ApplicationDesignParser
from design_reviewer.parsing.base import BaseParser
from design_reviewer.parsing.func_design import FunctionalDesignParser
from design_reviewer.parsing.models import (
    ApplicationDesignModel,
    DesignData,
    FunctionalDesignModel,
    TechnicalEnvironmentModel,
)
from design_reviewer.parsing.tech_env import TechnicalEnvironmentParser

__all__ = [
    "BaseParser",
    "ApplicationDesignParser",
    "FunctionalDesignParser",
    "TechnicalEnvironmentParser",
    "ApplicationDesignModel",
    "FunctionalDesignModel",
    "TechnicalEnvironmentModel",
    "DesignData",
]
