# Testing the AIDLC Design Review Hook with Claude Code

This guide explains how to test the hook integration with Claude Code CLI.

---

## Prerequisites

1. **Claude Code CLI** installed and authenticated
2. **Bash 4.0+** (check with: `bash --version`)
3. **Optional**: `yq` or Python 3 with PyYAML for configuration parsing
4. **Optional**: `bats` for running test suite

---

## Quick Test (Without Claude Code)

### Option 1: Test with Current Project Docs

Test the hook against the main project's aidlc-docs:

```bash
# 1. Make sure you're in the project root
cd /home/ec2-user/gitlab/AIDLC-DesignReview

# 2. Run the test script
./tool-install/test-hook.sh

# 3. Follow the prompts:
#    - Initial: "Review design now? (Y/n)" → Press Y or just ENTER
#    - Post-review: "Stop or continue? (S/c)" → Press S (stop) or C (continue)

# 4. Check outputs:
ls -la reports/design_review/        # Generated reports
cat aidlc-docs/audit.md              # Audit trail
```text
### Option 2: Test with Arbitrary Docs Folder

Test the hook against any aidlc-docs folder (useful for testing different projects):

```bash
# 1. Test against sci-calc example docs
./tool-install/test-hook-with-docs.sh test_data/sci-calc/golden-aidlc-docs

# 2. Test against any custom docs folder
./tool-install/test-hook-with-docs.sh /path/to/your/project/aidlc-docs

# 3. Follow the same prompts as Option 1

# 4. Check outputs:
ls -la reports/design_review/                        # Generated reports
cat test_data/sci-calc/golden-aidlc-docs/audit.md   # Audit log in custom location
```text
**Note**: When using custom docs, the audit log is written to that folder, not the main project's aidlc-docs.

**What the test script does**:

- Simulates Claude Code invoking the hook
- Discovers design artifacts in `aidlc-docs/construction/`
- Uses mock AI responses (no actual API calls)
- Generates reports and audit logs
- Returns exit code 0 (allow) or 1 (block)

---

## Testing with Claude Code

### Step 1: Register the Hook

Claude Code automatically loads hooks from `.claude/hooks/`. The hook is already in place:

```bash
ls -la .claude/hooks/pre-tool-use
# Should show: -rwxr-xr-x (executable)
```text
### Step 2: Configure the Hook (Optional)

Create a configuration file:

```bash
cp .claude/review-config.yaml.example .claude/review-config.yaml
```text
Edit `.claude/review-config.yaml`:

```yaml
# Enable/disable hook
enabled: true

# Dry run mode (test without blocking)
dry_run: false

# Minimum findings to trigger review
review_threshold: 3

# Other settings...
```text
### Step 3: Test with Claude Code

Open Claude Code in this repository and trigger the hook:

#### Method A: Using Claude Code CLI

```bash
# Start Claude Code CLI in this directory
claude-code

# In Claude Code prompt, try to edit a file:
# "Please update .claude/lib/config-parser.sh to add a comment"
```text
**What should happen**:

1. Hook intercepts the Write/Edit tool call
2. Discovers design artifacts in `aidlc-docs/construction/`
3. Prompts you: "Review design now? (Y/n)"
4. If you say Y, runs design review (mock response)
5. Shows findings and prompts: "Stop or continue? (S/c)"
6. If you say S, blocks code generation
7. If you say C or timeout, allows code generation

#### Method B: Using Hook Test Command

If Claude Code supports it:

```bash
# Test hook directly
claude-code hooks test pre-tool-use
```text
---

## Configuration Options

### Enable/Disable Hook

```yaml
enabled: false  # Disable hook completely
```text
### Dry Run Mode

Test the hook without blocking:

```yaml
dry_run: true   # Always allow code generation, but still log
```text
### Environment Variable Override

**Skip Review**:

Skip review temporarily:

```bash
SKIP_REVIEW=1 ./tool-install/test-hook.sh
# OR in Claude Code settings:
# Add "SKIP_REVIEW=1" to environment variables
```text
**Custom Docs Location**:

Point the hook to a different aidlc-docs folder:

```bash
# Test against custom docs
AIDLC_DOCS_PATH=/path/to/docs ./tool-install/test-hook.sh

# Or use in scripts:
export AIDLC_DOCS_PATH=/path/to/docs
./.claude/hooks/pre-tool-use

# Examples:
AIDLC_DOCS_PATH=test_data/sci-calc/golden-aidlc-docs ./tool-install/test-hook.sh
AIDLC_DOCS_PATH=/tmp/test-project/aidlc-docs ./tool-install/test-hook.sh
```text
**Useful for**:

- Testing against multiple projects without changing directories
- Automated testing with different doc sets
- CI/CD pipelines that review docs from various sources

### Debug Mode

Enable verbose logging:

```bash
DEBUG=1 ./tool-install/test-hook.sh
```text
---

## Expected Outputs

### 1. Console Output

```text
[INFO] [2026-03-27T14:30:00Z] AIDLC Design Review Hook - Starting
[INFO] [2026-03-27T14:30:00Z] Configuration loaded from: yq
[INFO] [2026-03-27T14:30:01Z] Found 3 unit(s) for potential review: unit2-config-yaml unit3-review-execution unit4-reporting-audit

🔍 Design artifacts detected. Review design now? (Y/n, timeout 120s)
> Y

[INFO] [2026-03-27T14:30:05Z] Reviewing unit: unit2-config-yaml
[INFO] [2026-03-27T14:30:06Z] Discovered 5 artifacts (12345 bytes)
[INFO] [2026-03-27T14:30:08Z] Findings detected: 1 critical, 1 high, 1 medium, 1 low
[INFO] [2026-03-27T14:30:08Z] Quality Score: 18

═════════════════════════════════════════════════════════
📋 DESIGN REVIEW FINDINGS
═════════════════════════════════════════════════════════

### Critical Findings (1)
1. **CRITICAL**: Missing error handling in configuration parser

### High Findings (1)
1. **HIGH**: Performance concern with sequential aggregation

[... more findings ...]

⚠️  Stop code generation or continue? (S/c, timeout 120s)
   S = Stop (block code generation)
   C = Continue (proceed with code generation)
> C

[INFO] [2026-03-27T14:30:15Z] User chose to CONTINUE with code generation
```text
### 2. Generated Report

Location: `reports/design_review/{timestamp}-designreview.md`

```markdown
# Design Review Report: unit2-config-yaml

**Generated**: 2026-03-27T14:30:08Z
**Quality Score**: 18 (Excellent)
**Recommendation**: APPROVE - Quality meets acceptable standards

## Executive Summary
[... findings summary ...]
```text
### 3. Audit Trail

Location: `aidlc-docs/audit.md`

```markdown
## Review Started
**Timestamp**: 2026-03-27T14:30:01Z
**Event**: Review Started
**Description**: User accepted review for 3 unit(s)

---

## Report Generated
**Timestamp**: 2026-03-27T14:30:08Z
**Event**: Report Generated
**Description**: Generated report for unit2-config-yaml with quality score 18

---
```text
---

## Troubleshooting

### Hook Doesn't Run

**Check 1**: Hook is executable

```bash
chmod +x .claude/hooks/pre-tool-use
```text
**Check 2**: Hook is enabled

```bash
cat .claude/review-config.yaml | grep enabled
# Should show: enabled: true
```text
**Check 3**: Claude Code recognizes hooks

```bash
# In Claude Code CLI
/help hooks
```text
### "Command not found: design-reviewer"

This is **expected**. The hook uses mock responses when the Python CLI is not available.

To use real AI reviews:

1. Install the Python design-reviewer: `uv sync`
2. Or modify `.claude/hooks/pre-tool-use` to use Claude API directly

### Hook Hangs on Prompt

**Cause**: Timeout waiting for user input

**Solution**: Either respond within timeout (default: 120s) or configure shorter timeout:

```yaml
timeout_seconds: 30  # 30 second timeout
```text
### "No artifacts found for review"

**Cause**: No `aidlc-docs/construction/` directory

**Solution**: The hook looks for design artifacts in:

```text
aidlc-docs/construction/{unit-name}/*.md
```text
This is expected if you haven't created any design artifacts yet. The hook will skip review.

---

## Integration with Claude Code Settings

To enable the hook in Claude Code settings (`.claude/settings.json`):

```json
{
  "hooks": {
    "pre-tool-use": {
      "enabled": true,
      "environment": {
        "DEBUG": "0",
        "SKIP_REVIEW": "0"
      }
    }
  }
}
```text
---

## Testing Specific Scenarios

### Test 1: Auto-Approve (Low Findings)

```yaml
# Set high threshold
review_threshold: 100
```text
Expected: Hook auto-approves if findings < 100

### Test 2: Auto-Block (Critical Findings)

```yaml
blocking:
  on_critical: true
```text
Expected: Hook prompts user, recommends BLOCK if critical findings detected

### Test 3: Dry Run

```yaml
dry_run: true
```text
Expected: Hook runs review but always allows code generation (exit 0)

### Test 4: Bypass Detection

```bash
# Delete marker file during review
rm .claude/.review-in-progress
```text
Expected: Next review detects bypass, prompts user for confirmation

---

## Next Steps

1. **Run the test script**: `./tool-install/test-hook.sh`
2. **Check outputs**: Reports and audit trail
3. **Try with Claude Code**: Trigger a Write/Edit command
4. **Customize configuration**: Adjust thresholds and blocking criteria
5. **Integrate real AI**: Replace mock with actual Claude API calls

---

## Real AI Integration (Future Enhancement)

To use real AI reviews instead of mocks, modify `.claude/hooks/pre-tool-use`:

Replace this section:

```bash
ai_response="CRITICAL: ..."  # Mock response
```text
With:

```bash
# Call Claude API via AWS Bedrock
ai_response=$(aws bedrock-runtime invoke-model \
  --model-id anthropic.claude-sonnet-4-6-v1:0 \
  --body "{\"messages\":[{\"role\":\"user\",\"content\":\"$instructions\"}]}" \
  --output text \
  | jq -r '.content[0].text')
```text
Or use the existing Python CLI:

```bash
ai_response=$(design-reviewer --aidlc-docs "${CWD}/aidlc-docs/construction/${unit_name}")
```text
---

## Support

For issues or questions:

- Check logs in stderr (hook outputs to stderr)
- Check audit trail: `aidlc-docs/audit.md`
- Enable debug mode: `DEBUG=1 ./tool-install/test-hook.sh`
- Review this repository's README.md for module documentation
