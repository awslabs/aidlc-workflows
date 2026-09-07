# Code Analysis Guide

## Package & Build System Discovery

Scan the project root and common subdirectories for these markers:

| File | Build System | Language/Runtime |
|------|-------------|-----------------|
| `package.json` | npm/yarn/pnpm | JavaScript/TypeScript |
| `tsconfig.json` | TypeScript compiler | TypeScript |
| `requirements.txt` / `pyproject.toml` / `setup.py` | pip/poetry/setuptools | Python |
| `Cargo.toml` | Cargo | Rust |
| `go.mod` | Go modules | Go |
| `pom.xml` | Maven | Java/Kotlin |
| `build.gradle` / `build.gradle.kts` | Gradle | Java/Kotlin |
| `Gemfile` | Bundler | Ruby |
| `*.csproj` / `*.sln` | dotnet/MSBuild | C# |
| `Makefile` | Make | Any |
| `Dockerfile` / `docker-compose.yml` | Docker | Containerized |
| `serverless.yml` / `template.yaml` | Serverless/SAM | Cloud functions |
| `cdk.json` / `cdktf.json` | CDK/CDKTF | Infrastructure |

## Framework Detection Patterns

Identify frameworks by scanning imports and configuration:
- **React**: `import React`, `jsx`/`tsx` files, `react-dom`
- **Next.js**: `next.config.js`, `pages/` or `app/` directory structure
- **Express**: `require('express')`, `app.get/post/use` patterns
- **FastAPI**: `from fastapi import`, `@app.get` decorators
- **Django**: `settings.py` with `INSTALLED_APPS`, `urls.py`, `models.py`
- **Spring Boot**: `@SpringBootApplication`, `application.properties/yml`
- **Rails**: `config/routes.rb`, `app/controllers/`, `ActiveRecord`

## Source File Classification

Classify every source file into one of these categories:
- **Model/Entity**: Data structures, database models, DTOs, schemas
- **Controller/Handler**: Request routing, input parsing, response formatting
- **Service/UseCase**: Business logic, orchestration, domain operations
- **Repository/DAO**: Data access, queries, persistence abstraction
- **Utility/Helper**: Cross-cutting functions, formatters, validators
- **Configuration**: App config, environment setup, dependency injection
- **Middleware**: Request/response pipeline (auth, logging, error handling)
- **Test**: Unit tests, integration tests, fixtures, factories
- **Migration**: Database schema changes, data migrations
- **Static/Asset**: Templates, stylesheets, images, static content

## Dependency Graph Extraction

For each source file, extract:
1. **Direct imports** -- modules/packages this file depends on
2. **Exported symbols** -- functions/classes/constants this file provides
3. **External dependencies** -- third-party packages used
4. **Circular references** -- files that import each other (flag these)

Build a dependency adjacency list: `file -> [dependency1, dependency2, ...]`

## Code Quality Quick Assessment

Rate each of these on a 3-point scale (good/fair/poor):
- **Naming clarity**: Are variables, functions, and files self-documenting?
- **Function size**: Are functions under 30 lines with single responsibility?
- **Error handling**: Are errors caught, logged, and propagated appropriately?
- **Test presence**: Do critical paths have corresponding test files?
- **Duplication**: Are there copy-paste patterns that should be abstracted?
- **Dead code**: Are there unused imports, unreachable branches, commented-out blocks?

## API Endpoint Inventory

For each discovered endpoint, record:
- HTTP method and path (or GraphQL operation name)
- Request parameters (path, query, body, headers)
- Response shape and status codes
- Authentication/authorization requirements
- Rate limiting or throttling configuration
- Associated middleware chain

## Technical Debt Indicators

Flag these patterns during code scan:
- TODO/FIXME/HACK comments (count and categorize)
- Suppressed linter warnings (`// eslint-disable`, `# noqa`, `@SuppressWarnings`)
- Hard-coded credentials, URLs, or magic numbers
- Deeply nested conditionals (>3 levels)
- God classes/files (>500 lines with multiple responsibilities)
- Missing error handling on I/O operations
- Outdated dependencies (major version behind)
