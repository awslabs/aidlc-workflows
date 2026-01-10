# Changelog

All notable changes to the AI-DLC CLI tool will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Support for Windsurf AI workflows with auto-execution mode 3
- Support for Antigravity advanced AI workflows  
- Support for GitHub Copilot VS Code prompts
- Support for Gemini CLI with Google AI integration
- Support for Qoder with always-on rule system
- Support for Roo command-based coding assistant
- Support for CodeBuddy collaborative coding environment
- Enhanced Claude Code integration with skills architecture
- Enhanced Cursor integration with command system
- Enhanced Codex integration with skills system
- Platform-specific configuration files and activation methods
- Comprehensive platform integration documentation
- Auto-execution modes for advanced AI platforms
- Always-on trigger system for continuous monitoring
- Skills-based architecture for AI assistants
- Command-based activation patterns
- Workflow-based execution with YAML frontmatter
- Multi-platform detection and validation
- Enhanced environment detection for all platforms
- Platform-specific setup instructions and usage guides

### Changed
- Expanded platform support from 6 to 12 AI coding assistants
- Updated file structure to match each platform's conventions
- Enhanced installation process to support all platforms
- Improved status reporting with detailed platform information
- Updated validation system to check all platform configurations
- Enhanced setup wizard with comprehensive platform selection
- Updated documentation with platform-specific integration guides

### Technical Improvements
- Refactored service layer to support 12 platforms
- Enhanced environment detection algorithms
- Improved file structure management
- Added platform-specific configuration generators
- Enhanced validation and repair mechanisms
- Updated test coverage for new platforms

## [1.0.0] - 2026-01-09

### Added
- Initial release of AI-DLC CLI tool
- `aidlc init` command for project initialization
- `aidlc setup` command for interactive configuration
- `aidlc status` command for installation and project status
- `aidlc validate` command for configuration validation
- `aidlc version` command for version information
- Support for Kiro CLI and Amazon Q Developer platforms
- Basic support for Claude Code, Cursor, Codex, and Antigravity
- Automatic rule file installation and management
- Environment detection and compatibility checking
- Project type-specific configuration
- Comprehensive error handling and user feedback
- Interactive and non-interactive modes
- Automatic .gitignore integration
- README documentation generation
- Local testing scripts
- CI/CD pipeline with GitHub Actions
- Comprehensive test suite with Jest
- TypeScript implementation with full type safety
- ESLint configuration for code quality
- Cross-platform support (macOS, Linux, Windows)

### Features
- **Multi-platform Support**: Works with multiple AI coding assistants
- **Adaptive Installation**: Automatically detects and configures for available platforms
- **Environment Detection**: Identifies development tools and provides recommendations
- **Project Type Awareness**: Adapts configuration based on project type
- **Validation System**: Comprehensive validation with automatic repair options
- **Interactive Setup**: Guided setup wizard for optimal configuration
- **Status Monitoring**: Detailed status reporting with verbose options
- **Error Recovery**: Automatic issue detection and repair capabilities

### Documentation
- Complete CLI documentation in README-CLI.md
- Updated main README with CLI integration
- Inline help for all commands
- Comprehensive usage examples
- Troubleshooting guide
- Contributing guidelines

### Technical Details
- Built with TypeScript for type safety
- Commander.js for CLI framework
- Inquirer.js for interactive prompts
- Chalk for colorized output
- Ora for loading spinners
- Boxen for formatted output
- fs-extra for enhanced file operations
- Jest for testing framework
- ESLint for code quality
- GitHub Actions for CI/CD

## Platform Support Evolution

### Version 1.0.0 (Initial)
- Kiro CLI (steering files)
- Amazon Q Developer (project rules)
- Basic support for 4 additional platforms

### Version 1.1.0 (Planned)
- **12 Full Platforms**: Complete integration for all supported AI assistants
- **Advanced Features**: Auto-execution, always-on triggers, skills systems
- **Enhanced Integration**: Platform-specific optimizations and features
- **Comprehensive Documentation**: Detailed integration guides and best practices

## Planned Features

### Version 1.2.0
- Plugin system for custom extensions
- Configuration templates for popular frameworks
- Integration with more AI development tools
- Advanced workflow analytics
- Team collaboration features
- Cloud synchronization options

### Version 1.3.0
- Multi-project workspace support
- Advanced rule customization
- Integration with CI/CD pipelines
- Performance monitoring and optimization
- Advanced debugging and troubleshooting tools