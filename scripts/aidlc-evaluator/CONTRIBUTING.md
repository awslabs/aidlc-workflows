# Contributing to AI-DLC Evaluation Framework

Thank you for contributing to the AI-DLC workflows evaluation and reporting framework!

## Getting Started

### Prerequisites

- Python 3.13+
- [uv](https://github.com/astral-sh/uv) package manager
- Git

### Setup

```bash
# Clone the repository
git clone <repository-url>
cd aidlc-evaluation-framework

# Install dependencies
uv sync

# Run tests to verify setup
uv run pytest
```

## Development Workflow

### 1. Create a Branch

```bash
git checkout -b feature/your-feature-name
```

### 2. Make Changes

Work in the appropriate package:
- `aidlc-runner/` - Execution Framework (two-agent AIDLC workflow runner)
- `packages/qualitative/` - Semantic Evaluation (intent & design similarity scoring)
- `packages/quantitative/` - Code Evaluation (linting, security, organization)
- `packages/nonfunctional/` - NFR Evaluation (tokens, timing, consistency)
- `packages/reporting/` - Report generation
- `packages/shared/` - Common utilities

Or contribute to other work streams:
- `test_cases/` - Golden Test Cases (baseline inputs)
- `writing-inputs/` - Vision and tech-env document guides
- `.github/workflows/` - GitHub CI/CD Integration & Management

### 3. Run Tests

```bash
# Run all tests
uv run pytest

# Run specific package tests
uv run pytest tests/test_qualitative.py

# Run with coverage
uv run pytest --cov
```

### 4. Lint Your Code

```bash
# Check code style
uv run ruff check .

# Auto-fix issues
uv run ruff check --fix .

# Format code
uv run ruff format .
```

### 5. Commit Changes

Write clear, descriptive commit messages:

```bash
git add .
git commit -m "Add token tracking to nonfunctional package"
```

### 6. Submit a Pull Request

- Push your branch to the repository
- Open a PR with a clear description of changes
- Link to any related issues
- Wait for automated tests to pass
- Address review feedback

## Work Streams

The project is organized around six big rocks. Your changes will typically fall into one or more of these:

| Work Stream | Description | Package / Area |
|---|---|---|
| **Golden Test Case** | Curated baseline test inputs | `test_cases/` |
| **Execution Framework** | Two-agent AIDLC workflow runner (Owner: Jeff) | `aidlc-runner/` |
| **Semantic Evaluation** | Intent & design similarity scoring | `packages/qualitative/` |
| **Code Evaluation** | Linting, security, organization | `packages/quantitative/` |
| **NFR Evaluation** | Tokens, timing, consistency | `packages/nonfunctional/` |
| **GitHub CI/CD** | Pipeline integration & management | `.github/workflows/` |

## Code Standards

### Python Style

- Follow PEP 8 (enforced by Ruff)
- Use type hints
- Maximum line length: 100 characters
- Write docstrings for public functions and classes

### Testing

- Write tests for new functionality
- Maintain or improve code coverage
- Use descriptive test names: `test_<what>_<condition>_<expected>`

### Documentation

- Update README.md if adding new features
- Add docstrings to new modules and functions
- Update relevant docs in `docs/` directory

## Package Dependencies

When adding dependencies:

1. Add to the appropriate `pyproject.toml` in `packages/<package>/` or `aidlc-runner/`
2. Run `uv sync` to update lock file
3. Document why the dependency is needed in your PR

## Reporting Issues

When reporting bugs or requesting features:

- Use GitHub Issues
- Provide clear reproduction steps
- Include relevant logs or error messages
- Specify which package is affected

## Questions?

- Review [FAQ.md](./FAQ.md) for common questions
- Check [OPERATING_PRINCIPLES.md](./OPERATING_PRINCIPLES.md) for decision-making guidance
- Ask in PR comments or open a discussion

## Code of Conduct

- Be respectful and constructive
- Focus on the code, not the person
- Welcome diverse perspectives
- Help others learn and grow

Thank you for helping improve the AI-DLC evaluation framework!
