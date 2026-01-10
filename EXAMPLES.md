# AI-DLC CLI Examples

This document provides practical examples of using the AI-DLC CLI tool in different scenarios.

## Installation Examples

### Global Installation
```bash
# Install globally
npm install -g aidlc

# Verify installation
aidlc --version
```

### Using with npx (No Installation)
```bash
# Use directly without installation
npx aidlc init

# Check status
npx aidlc status
```

## Initialization Examples

### Basic Initialization
```bash
# Initialize for both platforms (default)
cd my-project
aidlc init
```

### Platform-Specific Initialization
```bash
# Initialize only for Kiro CLI
aidlc init --platform kiro

# Initialize only for Amazon Q Developer
aidlc init --platform amazonq

# Initialize only for Claude Code
aidlc init --platform claude

# Initialize only for Cursor
aidlc init --platform cursor

# Initialize only for OpenAI Codex
aidlc init --platform codex

# Initialize only for Antigravity
aidlc init --platform antigravity

# Initialize for multiple specific platforms
aidlc init --platform kiro,claude,cursor

# Initialize for legacy combination (Kiro + Amazon Q)
aidlc init --platform both

# Initialize for all platforms explicitly
aidlc init --platform all
```

### Non-Interactive Initialization
```bash
# Skip interactive prompts
aidlc init --no-interactive

# Force overwrite existing files
aidlc init --force

# Combine options for all platforms
aidlc init --platform all --force --no-interactive

# Combine options for specific platforms
aidlc init --platform kiro,claude --force --no-interactive
```

## Status and Validation Examples

### Check Installation Status
```bash
# Basic status check
aidlc status

# Detailed status with verbose output
aidlc status --verbose
```

**Example Output:**
```
📊 AI-DLC Status Report
┌─────────────────────────────────────┐
│   📊 AI-DLC Status Report           │
└─────────────────────────────────────┘

📁 Project Directory:
   /Users/developer/my-web-app

🔧 Installation Status:
   Kiro CLI Rules: ✅ Installed
   Amazon Q Rules: ✅ Installed

🌍 Environment:
   Node.js: v18.17.0
   Platform: darwin
   Kiro CLI: ✅ Available
   Git Repository: ✅ Yes

📋 Project Status:
   AI-DLC Docs: ✅ Found
   State File: ✅ Found
   Audit Log: ✅ Found

✅ Validation:
   ✅ Installation is valid and ready to use
```

### Validate Configuration
```bash
# Basic validation
aidlc validate

# Validate and attempt to fix issues
aidlc validate --fix
```

## Setup Wizard Examples

### Interactive Setup
```bash
# Run the interactive setup wizard
aidlc setup
```

The setup wizard will:
1. Detect your environment
2. Provide recommendations
3. Configure AI-DLC for your project type
4. Set up .gitignore entries
5. Create usage documentation

## Project Type Examples

### Web Application Project
```bash
cd my-web-app
aidlc init
# Select "Web Application (Frontend/Backend)" in setup
```

### API/Microservice Project
```bash
cd my-api
aidlc init
# Select "API/Microservice" in setup
```

### Library/Package Project
```bash
cd my-library
aidlc init
# Select "Library/Package" in setup
```

## Workflow Examples

### Starting a New Feature
```bash
# 1. Initialize AI-DLC (if not done already)
aidlc init

# 2. Check status
aidlc status

# 3. In your AI assistant (Kiro CLI or Amazon Q Developer):
# "Using AI-DLC, I want to add user authentication to my web application"
```

### Working on Existing Codebase
```bash
# 1. Check current status
aidlc status --verbose

# 2. Validate configuration
aidlc validate

# 3. In your AI assistant:
# "Using AI-DLC, I need to optimize the database queries in the user service"
```

### Troubleshooting Issues
```bash
# 1. Validate and attempt automatic fixes
aidlc validate --fix

# 2. If issues persist, reinitialize
aidlc init --force

# 3. Check detailed status
aidlc status --verbose
```

## Integration Examples

### With Kiro CLI
```bash
# 1. Install Kiro CLI (if not installed)
npm install -g @kiro-dev/cli

# 2. Initialize AI-DLC for Kiro
aidlc init --platform kiro

# 3. Start Kiro CLI
kiro-cli

# 4. Check context in Kiro
/context show

# 5. Start development
# "Using AI-DLC, I want to build a REST API for user management"
```

### With Amazon Q Developer
```bash
# 1. Install Amazon Q Developer IDE extension
# (Follow Amazon Q installation guide)

# 2. Initialize AI-DLC for Amazon Q
aidlc init --platform amazonq

# 3. Open your IDE with Amazon Q
# 4. Check Rules button in Amazon Q Chat window
# 5. Start development
# "Using AI-DLC, I want to create a React component for user profiles"
```

## CI/CD Integration Examples

### GitHub Actions
```yaml
name: AI-DLC Validation

on: [push, pull_request]

jobs:
  validate-aidlc:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '18'
      - run: npm install -g aidlc
      - run: aidlc validate
```

### Pre-commit Hook
```bash
# .git/hooks/pre-commit
#!/bin/bash
aidlc validate || exit 1
```

## Advanced Examples

### Custom Configuration
```bash
# Initialize with specific settings
aidlc init --platform both --force

# Run setup for detailed configuration
aidlc setup

# Validate with automatic fixes
aidlc validate --fix
```

### Multiple Projects
```bash
# Project 1: Web Application
cd project1
aidlc init --platform kiro

# Project 2: API Service
cd ../project2
aidlc init --platform amazonq

# Project 3: Library
cd ../project3
aidlc init --platform both
```

### Version Management
```bash
# Check current version
aidlc version

# Get version as JSON
aidlc version --json

# Check for updates
npm list -g aidlc
npm update -g aidlc
```

## Common Workflows

### 1. New Project Setup
```bash
mkdir my-new-project
cd my-new-project
npm init -y
git init
aidlc init
aidlc setup
```

### 2. Existing Project Integration
```bash
cd existing-project
aidlc status
aidlc validate
aidlc init --force  # if needed
```

### 3. Team Onboarding
```bash
# New team member setup
git clone <project-repo>
cd <project>
npm install
aidlc status
aidlc validate --fix
```

### 4. Continuous Integration
```bash
# In CI pipeline
aidlc validate
# If validation fails, the build should fail
```

## Error Handling Examples

### Common Errors and Solutions

#### "No AI-DLC installation found"
```bash
# Solution: Initialize AI-DLC
aidlc init
```

#### "Missing rule files"
```bash
# Solution: Validate and fix
aidlc validate --fix

# Or reinitialize
aidlc init --force
```

#### "Kiro CLI not found"
```bash
# Solution 1: Install Kiro CLI
npm install -g @kiro-dev/cli

# Solution 2: Use Amazon Q instead
aidlc init --platform amazonq
```

#### "Rules not loading in IDE"
```bash
# Check file paths
aidlc status --verbose

# Validate installation
aidlc validate

# Restart IDE and try again
```

## Best Practices

### 1. Regular Validation
```bash
# Add to your development routine
aidlc status
aidlc validate
```

### 2. Version Control
```bash
# Add to .gitignore (done automatically by aidlc)
echo "aidlc-docs/" >> .gitignore
```

### 3. Team Consistency
```bash
# Ensure all team members use the same setup
aidlc init --platform both --no-interactive
```

### 4. Documentation
```bash
# Keep documentation updated
aidlc setup  # Updates README with AI-DLC usage
```

## Tips and Tricks

### 1. Quick Status Check
```bash
# Create an alias for quick status
alias aidlc-check="aidlc status && aidlc validate"
```

### 2. Project Templates
```bash
# Create a template script
#!/bin/bash
mkdir $1
cd $1
npm init -y
git init
aidlc init --platform both --no-interactive
echo "Project $1 created with AI-DLC!"
```

### 3. Batch Operations
```bash
# Validate multiple projects
for dir in project1 project2 project3; do
  cd $dir
  echo "Validating $dir..."
  aidlc validate
  cd ..
done
```

### 4. Environment-Specific Setup
```bash
# Development environment
aidlc init --platform kiro

# CI environment
aidlc init --platform amazonq --no-interactive
```