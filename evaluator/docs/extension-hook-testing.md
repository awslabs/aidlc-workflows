# Extension Hook Testing

## Overview

The extension hook testing framework validates the AIDLC workflow's progressive loading of rules extensions with opt-in questions. This feature allows testing how different extension configurations impact the quality and characteristics of generated outputs.

## Background

The AIDLC workflows repository includes an extension hook feature (branch: `feat/extension_hook_question_split`) that introduces opt-in questions for rules extensions. For example:

- **Security Baseline**: `security-baseline.opt-in.md` - Security best practices extension
- **Performance**: Performance optimization guidelines
- **Observability**: Monitoring and logging patterns

Each extension can be optionally loaded based on user responses to opt-in questions, allowing tailored AIDLC guidance.

## Extension Test Script

The `run_extension_test.py` script automates testing of different extension configurations by:

1. Running the AIDLC evaluation multiple times with different opt-in configurations
2. Comparing results across configurations
3. Generating reports showing the impact of extension choices

### Default Configurations

Two default configurations are provided:

1. **all-extensions**: All extension opt-ins answered "YES"
   - Tests maximum AIDLC guidance with all extensions loaded
   - Expected to produce more comprehensive outputs

2. **no-extensions**: All extension opt-ins answered "NO"
   - Tests baseline AIDLC guidance without extensions
   - Provides a minimal baseline for comparison

## Usage

### Basic Usage

Run a standard comparison (all yes vs all no):

```bash
# Using master run.py (recommended)
python run.py ext-test --scenario sci-calc

# Direct invocation
python scripts/run_extension_test.py --scenario sci-calc
```

### List Available Configurations

```bash
python run.py ext-test --list-configs
```

Output:

```text
Available extension test configurations:

  all-extensions        All Extensions Enabled
                        All extension opt-ins answered YES

  no-extensions         No Extensions
                        All extension opt-ins answered NO (baseline only)
```

### Specify Custom Configurations

```bash
python run.py ext-test --scenario sci-calc \
    --configs all-extensions,no-extensions
```

### Override Rules Branch

By default, the script uses the `feat/extension_hook_question_split` branch. To use a different branch:

```bash
python run.py ext-test --scenario sci-calc \
    --rules-ref main
```

### Full Configuration

```bash
python run.py ext-test --scenario sci-calc \
    --configs all-extensions,no-extensions \
    --rules-ref feat/extension_hook_question_split \
    --profile my-aws-profile \
    --region us-east-1 \
    --executor-model global.anthropic.claude-opus-4-6-v1 \
    --scorer-model global.anthropic.claude-opus-4-6-v1
```

## Output Structure

The extension test creates a structured output directory:

```text
runs/<scenario>/extension-test/
├── 20260309T151234-ext-all-extensions/     # Run with all extensions
│   ├── aidlc-docs/                         # Generated docs
│   ├── workspace/                          # Generated code
│   ├── run-meta.yaml                       # Run metadata
│   ├── extension-test-config.yaml          # Extension config used
│   ├── test-results.yaml                   # Post-run test results
│   ├── quality-report.yaml                 # Code quality metrics
│   ├── contract-test-results.yaml          # API contract test results
│   ├── qualitative-comparison.yaml         # Semantic evaluation
│   └── extension-test.log                  # Run log
├── 20260309T153456-ext-no-extensions/      # Run without extensions
│   └── ... (same structure)
└── extension-comparison/
    ├── extension-test-summary.yaml         # Comparison summary
    └── extension-test-report.md            # Human-readable report
```

## Extension Test Report

The generated report includes:

### Test Configuration Summary

Shows each configuration that was tested:

- Configuration name and description
- Pass/fail status
- Duration
- Output directory path

### Detailed Comparison Instructions

Provides commands to run detailed cross-run comparisons:

```bash
python run.py compare --runs-dir runs/<scenario>/extension-test \
    --scenario <scenario>
```

### Analysis Guidance

Suggests areas to examine:

- Qualitative scores comparison
- Differences in generated artifacts
- Impact on code quality metrics
- Test pass rates
- Token usage differences

## Interpreting Results

### Expected Differences

When comparing "all extensions" vs "no extensions", you may observe:

1. **Code Quality**
   - All extensions: More comprehensive error handling, security measures
   - No extensions: Simpler, baseline implementation

2. **Test Coverage**
   - All extensions: Potentially more test cases
   - No extensions: Basic test coverage

3. **Documentation**
   - All extensions: More detailed docs with security/performance notes
   - No extensions: Essential documentation only

4. **Token Usage**
   - All extensions: Higher token consumption (more context loaded)
   - No extensions: Lower token usage

5. **Qualitative Scores**
   - Compare alignment with golden baseline
   - Extensions may improve specific dimensions

## Integration with CI/CD

The extension test can be integrated into continuous integration:

```yaml
# Example GitLab CI job
extension-test:
  script:
    - python run.py ext-test --scenario sci-calc
  artifacts:
    paths:
      - runs/sci-calc/extension-test/
    expire_in: 1 week
```

## Implementation Notes

### Current Status

The extension opt-in mechanism is still under active development. The test script includes placeholders for controlling opt-in answers. Once the mechanism is finalized, the script will be updated to support:

- Environment variables (e.g., `AIDLC_EXTENSION_OPT_IN=yes|no`)
- Config file fields (e.g., `aidlc.extension_opt_in_default`)
- CLI flags (e.g., `--extension-opt-in yes|no|prompt`)
- Answer files (e.g., `--extension-answers answers.yaml`)

### Extension Metadata

Each test run includes an `extension-test-config.yaml` file documenting:

- Which configuration was used
- The opt-in settings applied
- The rules reference (branch/tag/commit)
- Timestamp of the run

## Future Enhancements

Planned improvements to extension testing:

1. **Custom Configuration Files**
   - Define arbitrary extension combinations
   - YAML-based configuration format

2. **Extension-Specific Comparisons**
   - Test individual extensions in isolation
   - Measure incremental impact of each extension

3. **Automated Regression Detection**
   - Flag when extension changes degrade quality
   - Track extension impact over time

4. **Matrix Testing**
   - Test all combinations of N extensions
   - Generate comprehensive comparison matrices

## References

- [Extension Hook Feature Branch](https://github.com/awslabs/aidlc-workflows/tree/feat/extension_hook_question_split)
- [Security Baseline Opt-in Example](https://github.com/awslabs/aidlc-workflows/blob/feat/extension_hook_question_split/aidlc-rules/aws-aidlc-rule-details/extensions/security/baseline/security-baseline.opt-in.md)
- [AIDLC Workflows Repository](https://github.com/awslabs/aidlc-workflows)

## Support

For questions or issues with extension testing:

1. Check the extension test logs in the run output directory
2. Review the extension-test-config.yaml for configuration details
3. Compare against the extension-test-report.md for high-level analysis
4. File issues at the aidlc-regression repository
