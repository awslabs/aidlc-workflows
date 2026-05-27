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
Prompt manager singleton for loading and managing AI agent prompts.
"""

import re
from pathlib import Path
from typing import Dict, Optional

import yaml

from .exceptions import PromptFileNotFoundError, PromptParseError
from .file_validator import FileValidator
from .prompt_models import PromptData, PromptMetadata


class PromptManager:
    """
    Singleton prompt manager.

    Loads versioned prompts from markdown files with optional YAML frontmatter.
    """

    _instance: Optional["PromptManager"] = None
    _prompts: Dict[str, PromptData] = {}

    REQUIRED_AGENTS = ["critique", "alternatives", "gap"]

    @classmethod
    def initialize(cls, prompts_directory: str = "config/prompts") -> "PromptManager":
        """
        Initialize singleton prompt manager.

        Args:
            prompts_directory: Directory containing prompt files

        Returns:
            PromptManager singleton instance

        Raises:
            PromptFileNotFoundError: If required prompt file not found
            PromptParseError: If prompt parsing fails
            RuntimeError: If already initialized
        """
        if cls._instance is not None:
            raise RuntimeError(
                "PromptManager already initialized. Call get_instance() to access existing instance."
            )

        instance = cls()
        instance._prompts = instance._load_all_prompts(prompts_directory)
        cls._instance = instance

        return instance

    @classmethod
    def get_instance(cls) -> "PromptManager":
        """
        Get singleton prompt manager instance.

        Returns:
            PromptManager singleton instance

        Raises:
            RuntimeError: If not initialized
        """
        if cls._instance is None:
            raise RuntimeError(
                "PromptManager not initialized. Call PromptManager.initialize() first."
            )
        return cls._instance

    @classmethod
    def reset(cls) -> None:
        """Reset singleton for testing. NOT for production use."""
        cls._instance = None
        cls._prompts = {}

    def _load_all_prompts(self, prompts_directory: str) -> Dict[str, PromptData]:
        """
        Load all required prompts.

        Args:
            prompts_directory: Directory containing prompt files

        Returns:
            Dictionary mapping agent_name to PromptData

        Raises:
            PromptFileNotFoundError: If required prompt not found
            PromptParseError: If prompt parsing fails
        """
        prompts_dir = Path(prompts_directory).expanduser()
        prompts = {}

        for agent_name in self.REQUIRED_AGENTS:
            # Find latest version for this agent
            prompt_file = self._find_latest_prompt(prompts_dir, agent_name)

            if not prompt_file:
                raise PromptFileNotFoundError(
                    str(prompts_dir / f"{agent_name}-v*.md"), agent_name
                )

            # Load and parse prompt
            prompt_data = self._load_prompt(prompt_file, agent_name)
            prompts[agent_name] = prompt_data

        return prompts

    def _find_latest_prompt(self, prompts_dir: Path, agent_name: str) -> Optional[Path]:
        """
        Find latest version of prompt for agent.

        Args:
            prompts_dir: Prompts directory
            agent_name: Agent name

        Returns:
            Path to latest prompt file or None
        """
        pattern = f"{agent_name}-v*.md"
        files = list(prompts_dir.glob(pattern))

        if not files:
            return None

        # Extract version numbers and find highest
        versioned_files = []
        for f in files:
            match = re.search(r"-v(\d+)\.md$", f.name)
            if match:
                version = int(match.group(1))
                versioned_files.append((version, f))

        if not versioned_files:
            return None

        versioned_files.sort(reverse=True)
        return versioned_files[0][1]

    def _load_prompt(self, prompt_file: Path, agent_name: str) -> PromptData:
        """
        Load and parse prompt file.

        Args:
            prompt_file: Path to prompt file
            agent_name: Agent name

        Returns:
            PromptData

        Raises:
            PromptParseError: If parsing fails
        """
        try:
            # Validate and load file
            content = FileValidator.validate_file(prompt_file, "Prompt")

            # Extract version from filename
            match = re.search(r"-v(\d+)\.md$", prompt_file.name)
            version = int(match.group(1)) if match else 1

            # Extract YAML frontmatter (if present)
            frontmatter_pattern = r"^---\n(.*?)\n---\n"
            match = re.match(frontmatter_pattern, content, re.DOTALL)

            metadata = None
            system_prompt = content

            if match:
                frontmatter_text = match.group(1)
                try:
                    metadata_dict = yaml.safe_load(frontmatter_text)
                    metadata = (
                        PromptMetadata(**metadata_dict) if metadata_dict else None
                    )
                except yaml.YAMLError as e:
                    raise PromptParseError(
                        str(prompt_file), f"Invalid YAML frontmatter: {e}"
                    ) from e

                system_prompt = content[match.end() :]

            # Find dynamic markers
            markers = re.findall(r"<!-- INSERT: (\w+) -->", system_prompt)

            return PromptData(
                agent_name=agent_name,
                version=version,
                file_path=str(prompt_file),
                system_prompt=system_prompt,
                dynamic_markers=markers,
                metadata=metadata,
            )

        except Exception as e:
            if isinstance(e, (PromptParseError, FileNotFoundError)):
                raise
            raise PromptParseError(str(prompt_file), str(e)) from e

    def get_prompt(self, agent_name: str) -> PromptData:
        """
        Get prompt data for agent.

        Args:
            agent_name: Agent name

        Returns:
            PromptData

        Raises:
            KeyError: If prompt not found
        """
        if agent_name not in self._prompts:
            raise KeyError(f"Prompt not found for agent: {agent_name}")
        return self._prompts[agent_name]

    def build_agent_prompt(self, agent_name: str, context: Dict[str, str]) -> str:
        """
        Build agent prompt by replacing dynamic markers with context.

        Args:
            agent_name: Agent name
            context: Dictionary mapping marker names to replacement content

        Returns:
            Complete prompt with markers replaced
        """
        prompt_data = self.get_prompt(agent_name)
        prompt = prompt_data.system_prompt

        # Replace dynamic markers
        for marker in prompt_data.dynamic_markers:
            if marker in context:
                marker_pattern = f"<!-- INSERT: {marker} -->"
                replacement_content = context[marker]

                # SECURITY: Wrap design_document content with explicit delimiters
                # to reinforce that it's untrusted user input, not instructions
                if marker == "design_document":
                    replacement_content = (
                        "<!-- DESIGN DOCUMENT START -->\n"
                        + replacement_content
                        + "\n<!-- DESIGN DOCUMENT END -->"
                    )

                prompt = prompt.replace(marker_pattern, replacement_content)

        return prompt
